import * as THREE from 'three';
import { ATMO } from './atmosphere.js';

// ============================================================
//  Particles: CPU-simulated, drawn as instanced camera-facing quads.
//  kinds:
//   'lit'      soft puffs (dust, smoke) lit like little spheres by the sun and the sky,
//              faded where they meet the ground, darkened in the baked world shadow
//   'add'      additive glowing puffs (fire, flashes), HDR so they bloom
//   'spark'    additive streaks stretched along their velocity
//   'confetti' small opaque-ish paper bits that tumble
//   'fire'     flipbook fireball: lit smoke plus flame emission, premultiplied blending
//  'lit' pools with flip: 'smoke' and every 'fire' pool play the simulated flipbooks from
//  models/fx/build_flipbooks.py once they have loaded (until then the procedural puffs stand in).
// ============================================================

// --- flipbooks: 8x8 cells; smoke = 2 variants x 32 frames, fire = 1 x 64 frames ---
// RGB = sqrt(light from the right / left / above (smoke) or flame emission (fire)), A = coverage
const FLIP = { smoke: { value: null }, fire: { value: null }, on: { value: 0 } };
const FLIP_URL = { smoke: new URL('../assets/fx/smoke.webp', import.meta.url).href, fire: new URL('../assets/fx/fire.webp', import.meta.url).href };
export function loadFlipbooks() {
  // ImageBitmap without premultiplication: the colour channels are data, kept even where A is small
  const load = (url) => new THREE.ImageBitmapLoader().setOptions({ premultiplyAlpha: 'none', colorSpaceConversion: 'none', imageOrientation: 'none' }).loadAsync(url)
    .then((bmp) => {
      const t = new THREE.Texture(bmp);
      t.flipY = false;
      t.colorSpace = THREE.NoColorSpace;
      t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.needsUpdate = true;
      return t;
    });
  return Promise.all([load(FLIP_URL.smoke), load(FLIP_URL.fire)]).then(([sm, fi]) => {
    FLIP.smoke.value = sm; FLIP.fire.value = fi; FLIP.on.value = 1;
  });
}

let ATLAS = null;
function puffAtlas() {
  if (ATLAS) return ATLAS;
  const S = 256, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d');
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < 4; k++) {
    const ox = (k % 2) * 128, oy = (k >> 1) * 128;
    // a cluster of soft blobs makes a cauliflower-ish puff
    for (let b = 0; b < 26; b++) {
      const a = rnd() * Math.PI * 2, d = Math.pow(rnd(), 0.7) * 30;
      const x = ox + 64 + Math.cos(a) * d, y = oy + 64 + Math.sin(a) * d * 0.9, r = 14 + rnd() * 22;
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, `rgba(255,255,255,${0.16 + rnd() * 0.14})`);
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd; g.fillRect(ox, oy, 128, 128);
    }
    // keep the edge of each cell clear
    g.save(); g.globalCompositeOperation = 'destination-in';
    const m = g.createRadialGradient(ox + 64, oy + 64, 30, ox + 64, oy + 64, 63);
    m.addColorStop(0, 'rgba(0,0,0,1)'); m.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = m; g.fillRect(ox, oy, 128, 128);
    g.restore();
  }
  ATLAS = new THREE.CanvasTexture(c);
  ATLAS.colorSpace = THREE.NoColorSpace;
  return ATLAS;
}

const VERT = /* glsl */`
attribute vec3 iPos;
attribute vec4 iData;      // size, rotation, alpha, atlas cell
attribute vec4 iCol;       // rgb, ground height
attribute vec3 iVel;
uniform float uStretch;
uniform vec3 hfSunDir;
uniform sampler2DShadow hfShadowMap;
uniform mat4 hfShadowMatrix;
uniform float hfShadowOn;
varying vec2 vUv, vCorner;
varying vec4 vCol;
varying float vAlpha, vFragY, vSun;
#ifdef FLIP
uniform float uFrames, uVariants, uSpan;
varying vec2 vUv1;
varying float vBlend;
varying vec3 vLight;
vec2 flipUv( float idx, vec2 lc ) {
  float col = mod( idx, 8.0 ), row = floor( idx / 8.0 );
  return vec2( col + lc.x, row + 1.0 - lc.y ) / 8.0;
}
#endif
#include <fog_pars_vertex>
void main() {
  vec2 c = position.xy;
  vCorner = c * 2.0;
  float cell = floor( iData.w );
  vUv = ( c + 0.5 ) * 0.5 + vec2( mod( cell, 2.0 ), floor( cell / 2.0 ) ) * 0.5;
#ifdef FLIP
  // the frame follows the particle's age; neighbouring frames cross-fade
  float f = fract( iData.w ) * uSpan * ( uFrames - 1.0 );
  float f0 = floor( f );
  vBlend = f - f0;
  float base = mod( cell, uVariants ) * uFrames;
  vec2 lc = mix( vec2( 0.004 ), vec2( 0.996 ), c + 0.5 );
  vUv = flipUv( base + f0, lc );
  vUv1 = flipUv( base + min( f0 + 1.0, uFrames - 1.0 ), lc );
  // the sun in the particle's own (rotated) frame: x = towards the right of the image, y = up
  vec3 sv = normalize( ( viewMatrix * vec4( hfSunDir, 0.0 ) ).xyz );
  float rs = sin( iData.y ), rc = cos( iData.y );
  vLight = vec3( dot( sv.xy, vec2( rc, rs ) ), dot( sv.xy, vec2( - rs, rc ) ), sv.z );
#endif
  vec4 mvPosition = modelViewMatrix * vec4( iPos, 1.0 );
#ifdef SPARK
  vec4 m1 = modelViewMatrix * vec4( iPos - iVel * uStretch, 1.0 );
  vec2 d = mvPosition.xy - m1.xy;
  float len = max( length( d ), iData.x );
  vec2 dir = len > 1e-4 ? d / len : vec2( 0.0, 1.0 );
  vec2 side = vec2( - dir.y, dir.x );
  mvPosition.xy += side * c.x * iData.x + dir * ( c.y - 0.5 ) * len;
#else
  float s = sin( iData.y ), co = cos( iData.y );
  vec2 r = vec2( c.x * co - c.y * s, c.x * s + c.y * co );
  mvPosition.xy += r * iData.x;
#endif
  vFragY = iPos.y + c.y * iData.x;
  vCol = iCol;
  vAlpha = iData.z;
  // sun visibility at the particle centre from the baked world shadow
  vec3 sc = ( hfShadowMatrix * vec4( iPos + hfSunDir * 2.0, 1.0 ) ).xyz;
  float inside = step( 0.0, sc.x ) * step( sc.x, 1.0 ) * step( 0.0, sc.y ) * step( sc.y, 1.0 );
  vSun = mix( 1.0, texture( hfShadowMap, vec3( sc.xy, sc.z - 0.001 ) ), inside * hfShadowOn );
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const FRAG = /* glsl */`
uniform sampler2D uMap;
uniform vec3 uAmbient, uSunCol;
varying vec2 vUv, vCorner;
varying vec4 vCol;
varying float vAlpha, vFragY, vSun;
#ifdef FLIP
uniform sampler2D uFlip;
uniform float uFlipOn, uEmit;
uniform vec3 uFlame0, uFlame1;
varying vec2 vUv1;
varying float vBlend;
varying vec3 vLight;
#endif
#include <common>
#include <fog_pars_fragment>
void main() {
#if defined( FLIP )
  vec4 tx = mix( texture2D( uFlip, vUv ), texture2D( uFlip, vUv1 ), vBlend );
  vec3 L = tx.rgb * tx.rgb;
  float a = tx.a * smoothstep( 0.0, 1.2, vFragY - vCol.a );
  #ifdef FIRE
  float top = 0.5 * ( L.r + L.g );
  float E = L.b;
  #else
  float top = L.b;
  float E = 0.0;
  #endif
  // "6-way" lighting cut down to right / left / top; the bottom borrows from the sides,
  // a sun behind the camera lights everything, a sun behind the puff shines through its thin edges
  vec3 l = vLight;
  float lit = L.r * max( l.x, 0.0 ) + L.g * max( - l.x, 0.0 ) + top * max( l.y, 0.0 ) + 0.5 * min( L.r, L.g ) * max( - l.y, 0.0 )
            + ( L.r + L.g + top ) * 0.33 * max( l.z, 0.0 ) + ( 1.0 - tx.a ) * 0.8 * max( - l.z, 0.0 );
  vec3 col = vCol.rgb * ( uAmbient * ( 0.55 + 0.45 * ( L.r + L.g + top ) * 0.33 ) + uSunCol * lit * vSun * 1.25 );
  #ifdef FIRE
  // flame: deep red where it is thin, through orange to a yellow-white core
  vec3 flame = mix( uFlame0, uFlame1, smoothstep( 0.2, 0.85, E ) ) * ( 1.2 * E * E + 3.0 * E * E * E ) * 1.6 * uEmit;
  gl_FragColor = vec4( col * a * vAlpha + flame * vAlpha, a * vAlpha );
  #else
  gl_FragColor = vec4( col, a * vAlpha );
  #endif
  if ( uFlipOn < 0.5 ) {
    // flipbooks still loading: a plain soft puff
    float pa = smoothstep( 1.0, 0.15, length( vCorner ) ) * 0.6 * vAlpha;
    gl_FragColor = vec4( vCol.rgb * uAmbient * 1.4, pa );
    #ifdef FIRE
    gl_FragColor.rgb = ( vCol.rgb * uAmbient + uFlame1 * 2.0 ) * pa;
    #endif
  }
#elif defined( SPARK )
  float a = ( 1.0 - abs( vCorner.x ) ) * smoothstep( -1.0, -0.2, vCorner.y );
  gl_FragColor = vec4( vCol.rgb * a * vAlpha, 1.0 );
#elif defined( ADD )
  float a = texture2D( uMap, vUv ).a;
  a *= 1.0 - smoothstep( 0.4, 1.0, length( vCorner ) );
  gl_FragColor = vec4( vCol.rgb * a * vAlpha, 1.0 );
#elif defined( CONFETTI )
  if ( max( abs( vCorner.x ), abs( vCorner.y ) ) > 0.9 ) discard;
  gl_FragColor = vec4( vCol.rgb * ( uAmbient + uSunCol * 0.6 ), vAlpha );
#else
  float a = texture2D( uMap, vUv ).a;
  // soft against the ground
  a *= smoothstep( 0.0, 1.2, vFragY - vCol.a );
  // light the puff like a sphere: view-space normal from the quad corner
  vec2 q = vCorner;
  vec3 n = normalize( vec3( q, sqrt( max( 1.0 - dot( q, q ), 0.05 ) ) ) );
  vec3 sunV = normalize( ( viewMatrix * vec4( hfSunDir, 0.0 ) ).xyz );
  float lam = clamp( dot( n, sunV ) * 0.5 + 0.55, 0.0, 1.0 );
  vec3 lit = uAmbient + uSunCol * lam * vSun;
  gl_FragColor = vec4( vCol.rgb * lit, a * vAlpha );
#endif
  #include <fog_fragment>
}`;

export class Particles {
  constructor(scene, opts) {
    const o = this.o = Object.assign({
      capacity: 500, kind: 'lit', size: [2, 6], alpha: 0.5, drag: 1, grav: 0, color: '#ffffff', spin: 1, fadeIn: 0.12, stretch: 0.04,
    }, opts);
    const n = this.n = Math.max(8, Math.round(o.capacity));
    this.pos = new Float32Array(n * 3); this.vel = new Float32Array(n * 3);
    this.life = new Float32Array(n); this.max = new Float32Array(n);
    this.s0 = new Float32Array(n); this.s1 = new Float32Array(n);
    this.rot = new Float32Array(n); this.rv = new Float32Array(n);
    this.a0 = new Float32Array(n); this.col = new Float32Array(n * 3);
    this.gy = new Float32Array(n); this.cell = new Float32Array(n);
    this.dragA = new Float32Array(n); this.gravA = new Float32Array(n);
    this.head = 0; this.alive = 0;
    const g = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    g.index = quad.index; g.attributes.position = quad.attributes.position;
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aData = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aVel = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iPos', this.aPos); g.setAttribute('iData', this.aData); g.setAttribute('iCol', this.aCol); g.setAttribute('iVel', this.aVel);
    g.instanceCount = 0;
    const defines = {};
    if (o.kind === 'spark') defines.SPARK = '';
    if (o.kind === 'add' || o.kind === 'spark') { defines.ADD = ''; defines.HF_ADDITIVE = ''; }
    if (o.kind === 'confetti') defines.CONFETTI = '';
    const fire = o.kind === 'fire';
    if (fire || o.flip) defines.FLIP = '';
    if (fire) defines.FIRE = '';
    const additive = o.kind === 'add' || o.kind === 'spark';
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, defines,
      uniforms: Object.assign({
        uMap: { value: puffAtlas() }, uStretch: { value: o.stretch },
        uAmbient: { value: new THREE.Color(o.ambient || '#8f8172') }, uSunCol: { value: new THREE.Color(o.sun || '#ffd9b0') },
        uFlip: fire ? FLIP.fire : FLIP.smoke, uFlipOn: FLIP.on, uFrames: { value: fire ? 64 : 32 }, uVariants: { value: fire ? 1 : 2 },
        uSpan: { value: o.span ?? 1 }, uEmit: { value: o.emit ?? 1 },
        uFlame0: { value: new THREE.Color(o.flame0 || '#ff3c0a') }, uFlame1: { value: new THREE.Color(o.flame1 || '#ffc46a') },
      }, THREE.UniformsUtils.clone(THREE.UniformsLib.fog), ATMO),
      transparent: true, depthWrite: false, fog: true, premultipliedAlpha: fire,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = o.renderOrder ?? (additive ? 3 : 2);
    this.mesh.userData.dynamic = true;
    this.geo = g;
    this._c = new THREE.Color();
    scene.add(this.mesh);
  }
  // emit(x, y, z, vx, vy, vz, life, opts?)   opts: size0, size1, color, alpha, ground, rot, spin, drag, grav, cell
  emit(x, y, z, vx, vy, vz, life, p) {
    const i = this.head; this.head = (this.head + 1) % this.n;
    const o = this.o;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.life[i] = this.max[i] = life;
    this.s0[i] = p?.size0 ?? o.size[0] * (0.8 + Math.random() * 0.4);
    this.s1[i] = p?.size1 ?? o.size[1] * (0.8 + Math.random() * 0.4);
    this.rot[i] = p?.rot ?? Math.random() * 6.283;
    this.rv[i] = p?.spin ?? (Math.random() - 0.5) * o.spin;
    this.a0[i] = p?.alpha ?? o.alpha;
    const c = p?.color ? this._c.set(p.color) : this._c.set(o.color);
    const k = p?.bright ?? 1;
    this.col[i * 3] = c.r * k; this.col[i * 3 + 1] = c.g * k; this.col[i * 3 + 2] = c.b * k;
    this.gy[i] = p?.ground ?? -1e4;
    this.cell[i] = p?.cell ?? Math.floor(Math.random() * 4);
    this.dragA[i] = p?.drag ?? o.drag;
    this.gravA[i] = p?.grav ?? o.grav;
  }
  update(dt) {
    const { pos, vel, life, max, n } = this, o = this.o;
    const P = this.aPos.array, D = this.aData.array, C = this.aCol.array, V = this.aVel.array;
    let w = 0;
    for (let i = 0; i < n; i++) {
      if (life[i] <= 0) continue;
      life[i] -= dt;
      if (life[i] <= 0) continue;
      const k = Math.exp(-this.dragA[i] * dt);
      vel[i * 3] *= k; vel[i * 3 + 1] = vel[i * 3 + 1] * k - this.gravA[i] * dt; vel[i * 3 + 2] *= k;
      pos[i * 3] += vel[i * 3] * dt; pos[i * 3 + 1] += vel[i * 3 + 1] * dt; pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
      if (o.kind === 'confetti' && pos[i * 3 + 1] < this.gy[i] + 0.05) { pos[i * 3 + 1] = this.gy[i] + 0.05; vel[i * 3] = vel[i * 3 + 1] = vel[i * 3 + 2] = 0; }
      this.rot[i] += this.rv[i] * dt;
      const t = 1 - life[i] / max[i];                      // 0 -> 1 over the lifetime
      const fade = Math.min(1, t / o.fadeIn) * (1 - t) * (1 - t * 0.3);
      P[w * 3] = pos[i * 3]; P[w * 3 + 1] = pos[i * 3 + 1]; P[w * 3 + 2] = pos[i * 3 + 2];
      let size = this.s0[i] + (this.s1[i] - this.s0[i]) * Math.sqrt(t);
      if (o.kind === 'confetti') size *= 0.55 + 0.45 * Math.abs(Math.sin(this.rot[i] * 2.3));
      D[w * 4] = size; D[w * 4 + 1] = this.rot[i]; D[w * 4 + 2] = this.a0[i] * (o.kind === 'confetti' ? Math.min(1, life[i]) : fade); D[w * 4 + 3] = this.cell[i] + Math.min(t, 0.999);
      C[w * 4] = this.col[i * 3]; C[w * 4 + 1] = this.col[i * 3 + 1]; C[w * 4 + 2] = this.col[i * 3 + 2]; C[w * 4 + 3] = this.gy[i];
      V[w * 3] = vel[i * 3]; V[w * 3 + 1] = vel[i * 3 + 1]; V[w * 3 + 2] = vel[i * 3 + 2];
      w++;
    }
    this.alive = w;
    this.geo.instanceCount = w;
    if (w) {
      for (const a of [this.aPos, this.aData, this.aCol, this.aVel]) { a.clearUpdateRanges(); a.addUpdateRange(0, w * a.itemSize); a.needsUpdate = true; }
    }
  }
}
