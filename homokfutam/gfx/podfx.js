import * as THREE from 'three';
import { ATMO } from './atmosphere.js';
import { FxBatch } from './fxbatch.js';

// ============================================================
//  Pod effects: exhaust plumes (raymarched volume with shock diamonds on boost, or a cheap cone
//  without post-processing), glowing nozzle throats, heat distortion behind the engines, hover
//  glow + contact shadow on the ground, boost shockwave rings, rock debris.
// ============================================================

// --- volumetric plume: a box around the jet, back faces only; the fragment shader marches the
// view ray through it and adds up flame emission (temperature ramp + turbulence + Mach disks) ---
const VOL_V = /* glsl */`
varying vec3 vPos, vCam;
void main() {
  vPos = position;
  vCam = ( inverse( modelMatrix ) * vec4( cameraPosition, 1.0 ) ).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`;
const VOL_F = /* glsl */`
uniform float uThr, uBoost, uOver, uTime, uSeed, uIgn, uSput;
uniform vec3 uHot, uMid, uCool, uCore, uScale;
varying vec3 vPos, vCam;
float h31( vec3 p ) { p = fract( p * 0.3183099 + 0.1 ); p *= 17.0; return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) ); }
float vn3( vec3 x ) {
  vec3 i = floor( x ), f = fract( x ); f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( mix( h31( i ), h31( i + vec3( 1, 0, 0 ) ), f.x ), mix( h31( i + vec3( 0, 1, 0 ) ), h31( i + vec3( 1, 1, 0 ) ), f.x ), f.y ),
              mix( mix( h31( i + vec3( 0, 0, 1 ) ), h31( i + vec3( 1, 0, 1 ) ), f.x ), mix( h31( i + vec3( 0, 1, 1 ) ), h31( i + vec3( 1, 1, 1 ) ), f.x ), f.y ), f.z );
}
void main() {
  vec3 ro = vCam, rd = normalize( vPos - vCam );
  // where the view ray enters and leaves the box [-1,1] x [-1,1] x [-1,0]
  vec3 inv = 1.0 / ( rd + vec3( 1e-6 ) );
  vec3 t0 = ( vec3( - 1.0, - 1.0, - 1.0 ) - ro ) * inv, t1 = ( vec3( 1.0, 1.0, 0.0 ) - ro ) * inv;
  vec3 tmin = min( t0, t1 ), tmax = max( t0, t1 );
  float tStart = max( max( max( tmin.x, tmin.y ), tmin.z ), 0.0 );
  float tEnd = min( min( tmax.x, tmax.y ), tmax.z );
  float span = max( tEnd - tStart, 0.0 );
  float dt = span / float( STEPS );
  float wlen = length( rd * uScale ) * dt;              // world metres per step
  float jit = h31( vec3( gl_FragCoord.xy, uTime * 60.0 ) );
  vec3 acc = vec3( 0.0 );
  float I = ( 0.25 + uThr * 0.9 + uBoost * 0.8 + uIgn * 2.5 ) * ( 1.0 - uSput * 0.85 );
  for ( int i = 0; i < STEPS; i ++ ) {
    vec3 p = ro + rd * ( tStart + ( float( i ) + jit ) * dt );
    float z = clamp( - p.z, 0.0, 1.0 );                // 0 at the nozzle, 1 at the tip
    float R = mix( 0.62, 1.0, sqrt( z ) );               // the jet widens downstream
    float r = length( p.xy ) / R;
    if ( r > 1.0 ) continue;
    // turbulence, carried downstream
    vec3 q = vec3( p.xy * 2.2, z * 5.0 - uTime * 9.0 ) + uSeed;
    float n = vn3( q ) * 0.65 + vn3( q * 2.3 + 7.1 ) * 0.35;
    float core = exp( - r * r * ( 3.5 + z * 2.0 ) );
    float body = core * pow( 1.0 - z, 1.4 ) * ( 0.55 + 0.9 * n * smoothstep( 0.0, 0.35, z ) + 0.45 * ( 1.0 - smoothstep( 0.0, 0.3, z ) ) );
    // temperature: hottest in the core near the nozzle
    float T = clamp( ( 1.0 - z * 1.25 ) * ( 0.4 + 0.6 * core ) + uBoost * 0.25, 0.0, 1.0 );
    vec3 c = mix( uCool, uMid, smoothstep( 0.05, 0.45, T ) );
    c = mix( c, uHot, smoothstep( 0.55, 0.9, T ) );
    // boost: a blue-white Mach core with standing shock diamonds
    float mach = uBoost * exp( - r * r * 22.0 ) * smoothstep( 0.75, 0.05, z )
               * ( 0.35 + 1.6 * pow( max( 0.5 + 0.5 * cos( z * 30.0 ), 0.0 ), 8.0 ) );
    acc += ( c * body * I + uCore * mach * 2.2 ) * wlen;
  }
  if ( uOver > 0.5 ) acc *= 0.35 + 0.65 * step( 0.5, fract( uTime * 9.0 + uSeed ) );
  // looking down the jet integrates metres of flame: compress so it stays a hot core, not a white-out
  acc *= 0.75;
  acc /= 1.0 + dot( acc, vec3( 0.33 ) ) * 0.45;
  gl_FragColor = vec4( acc, 1.0 );
}`;
function volumeGeometry() {
  const g = new THREE.BoxGeometry(2, 2, 1);
  g.translate(0, 0, -0.5);           // spans z 0..-1
  return g;
}
const VOL_GEO = volumeGeometry();

// --- nozzle throat: a disc in the exit plane, hot ring plus a core that turns blue-white on boost ---
// every throat of every pod in one draw (gfx/fxbatch.js); vFx = brightness, boost, seed
const THROAT_F = /* glsl */`
uniform float uTime;
uniform vec3 uRing, uCore;
varying vec2 vUv;
varying vec3 vFx;
void main() {
  float k = vFx.x, boost = vFx.y, seed = vFx.z;
  vec2 c = ( vUv - 0.5 ) * 2.0;
  float r = length( c );
  if ( r > 1.0 ) discard;
  float ring = exp( - pow( ( r - 0.78 ) / 0.13, 2.0 ) );
  float flick = 0.85 + 0.15 * sin( uTime * 63.0 + seed + atan( c.y, c.x ) * 3.0 );
  float core = exp( - r * r * 5.0 );
  vec3 col = uRing * ring * 1.6 * flick + mix( uRing * 1.2, uCore * 2.2, boost ) * core + uRing * 0.35;
  gl_FragColor = vec4( col * k, 1.0 );
}`;
const THROAT_GEO = new THREE.CircleGeometry(1, 28).rotateY(Math.PI);   // faces -z (backwards)

// --- exhaust plume: an open cone along -z, additive, brightest where you look through its core ---
const PLUME_V = /* glsl */`
varying vec2 vUv; varying vec3 vN, vV;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4( position, 1.0 );
  vN = normalize( normalMatrix * normal );
  vV = normalize( - mv.xyz );
  gl_Position = projectionMatrix * mv;
}`;
const PLUME_F = /* glsl */`
uniform float uThr, uBoost, uOver, uTime, uSeed;
uniform vec3 uHot, uMid, uCool;
uniform sampler2D hfCloudTex;
varying vec2 vUv; varying vec3 vN, vV;
void main() {
  float along = 1.0 - vUv.y;                         // 0 at the nozzle, 1 at the tip
  float facing = abs( dot( normalize( vN ), normalize( vV ) ) );
  float core = pow( facing, 1.8 );
  float n = texture2D( hfCloudTex, vec2( vUv.x * 2.0 + uSeed, along * 0.7 - uTime * 2.6 ) ).r;
  float n2 = texture2D( hfCloudTex, vec2( vUv.x * 3.0 - uSeed, along * 1.3 - uTime * 4.1 ) ).r;
  float flick = 0.65 + 0.7 * n * n2;
  float body = core * pow( clamp( 1.0 - along, 0.0, 1.0 ), 1.6 ) * flick;
  // shock diamonds when boosting
  float dia = uBoost * pow( max( 0.5 + 0.5 * cos( along * 34.0 - uTime * 6.0 ), 0.0 ), 6.0 ) * smoothstep( 0.75, 0.05, along ) * core;
  vec3 col = mix( uCool, uMid, smoothstep( 0.85, 0.3, along ) );
  col = mix( col, uHot, smoothstep( 0.35, 0.0, along ) * core );
  float I = ( 0.35 + uThr * 1.1 + uBoost * 1.6 ) * ( uOver > 0.5 ? 0.4 + 0.6 * step( 0.5, fract( uTime * 9.0 + uSeed ) ) : 1.0 );
  gl_FragColor = vec4( col * ( body * I * 2.4 + dia * 5.0 ), 1.0 );
}`;
function plumeGeometry() {
  const g = new THREE.CylinderGeometry(0.05, 1, 1, 18, 10, true);
  g.translate(0, -0.5, 0);           // spans y 0..-1
  g.rotateX(Math.PI / 2);            // -> spans z 0..-1
  return g;
}
const PLUME_GEO = plumeGeometry();

// --- heat distortion layer: rendered into a small target that the post chain samples ---
const HEAT_F = /* glsl */`
uniform float uK, uTime, uRing;
uniform sampler2D hfCloudTex;
varying vec2 vUv;
void main() {
  vec2 c = vUv - 0.5;
  float r = length( c ) * 2.0;
  float a = uRing > 0.5 ? smoothstep( 0.12, 0.0, abs( r - 0.82 ) ) : smoothstep( 1.0, 0.2, r );
  vec2 n = vec2( texture2D( hfCloudTex, vUv * 1.7 + vec2( 0.0, - uTime * 1.8 ) ).r, texture2D( hfCloudTex, vUv * 1.7 + vec2( 0.5, - uTime * 2.3 ) ).r );
  vec2 off = uRing > 0.5 ? normalize( c + 1e-4 ) * 0.5 : ( n - 0.5 );
  gl_FragColor = vec4( off * 0.5 + 0.5, 0.0, a * uK );
}`;
export class HeatLayer {
  constructor() {
    this.scene = new THREE.Scene();
    this.rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: false });
    this.items = [];
  }
  quad(ring = false) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(0.0,0.0,0.0,1.0); mv.xy += position.xy * vec2(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz)); gl_Position = projectionMatrix * mv; }',
      fragmentShader: HEAT_F, transparent: true, depthTest: false, depthWrite: false,
      uniforms: { uK: { value: 0 }, uTime: ATMO.hfTime, uRing: { value: ring ? 1 : 0 }, hfCloudTex: ATMO.hfCloudTex },
      blending: THREE.NormalBlending,
    }));
    m.frustumCulled = false;
    this.scene.add(m);
    return m;
  }
  setSize(w, h) { this.rt.setSize(Math.max(4, w >> 1), Math.max(4, h >> 1)); }
  render(renderer, camera) {
    const prev = renderer.getRenderTarget(), cc = renderer.getClearColor(new THREE.Color()), ca = renderer.getClearAlpha();
    renderer.setRenderTarget(this.rt);
    renderer.setClearColor(0x808000, 0);
    renderer.clear(true, false, false);
    renderer.render(this.scene, camera);
    renderer.setRenderTarget(prev);
    renderer.setClearColor(cc, ca);
  }
}

// --- ground decals under each pod (batched like the throats; vFx.x = strength, vFx.y = seed) ---
const GLOW_F = /* glsl */`
uniform float uTime;
uniform vec3 uCol;
varying vec2 vUv;
varying vec3 vFx;
void main() {
  vec2 c = ( vUv - 0.5 ) * vec2( 1.0, 1.4 );
  float r = length( c ) * 2.0;
  float pool = exp( - r * r * 3.0 );
  float rings = pow( max( 0.5 + 0.5 * sin( r * 26.0 - uTime * 14.0 + vFx.y ), 0.0 ), 6.0 ) * smoothstep( 1.0, 0.3, r ) * 0.35;
  gl_FragColor = vec4( uCol * ( pool + rings ) * vFx.x, 1.0 );
}`;
const SHADOW_F = /* glsl */`
varying vec2 vUv;
varying vec3 vFx;
void main() {
  vec2 c = ( vUv - 0.5 ) * 2.0;
  float a = smoothstep( 1.0, 0.1, length( c * vec2( 1.0, 0.75 ) ) );
  gl_FragColor = vec4( 0.0, 0.0, 0.0, a * a * vFx.x );
}`;
// shared by the batched throats and decals: aFx = the per-instance values
const BATCH_V = 'attribute vec3 aFx; varying vec2 vUv; varying vec3 vFx; void main(){ vUv = uv; vFx = aFx; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }';
const GLOW_GEO = new THREE.PlaneGeometry(9, 13).rotateX(-Math.PI / 2);
const SHADOW_GEO = new THREE.PlaneGeometry(7, 12).rotateX(-Math.PI / 2);
const PODS_MAX = 12;           // racers per batch: 6, with room to spare

// opts.volume: raymarched plumes (else the cone); opts.steps: march steps; opts.hdr: brightness;
// opts.emit: particle emitters { fire, smoke, blast, spark } (x, y, z, vx, vy, vz, life, params);
// opts.event(kind, r, k): sounds and camera kicks for 'ignite', 'flameout' and 'backfire'
export function createPodFx(scene, heat, opts = {}) {
  const pods = new Map();
  const up = new THREE.Vector3(0, 1, 0), nrm = new THREE.Vector3(), q = new THREE.Quaternion(), qy = new THREE.Quaternion();
  const world = new THREE.Vector3(), back = new THREE.Vector3(), camL = new THREE.Vector3(), inv = new THREE.Matrix4();
  const E = opts.emit || {}, event = opts.event || (() => {});
  const volume = !!opts.volume;

  // fx live on the pod mesh (so replays and mesh swaps reuse them); the heat quads live in another
  // scene, so pods that were not updated this frame get them hidden. The throats and the ground
  // decals of all pods are drawn by three batches, filled as each pod is updated.
  const batch = (geo, frag, uniforms, cap, renderOrder, extra = {}) => new FxBatch(scene, geo, new THREE.ShaderMaterial({
    vertexShader: BATCH_V, fragmentShader: frag, transparent: true, depthWrite: false, uniforms, ...extra,
  }), cap, { aFx: 3 }, renderOrder);
  const THROATS = batch(THROAT_GEO, THROAT_F, { uTime: ATMO.hfTime, uRing: { value: new THREE.Color('#ff8a3a') }, uCore: { value: new THREE.Color('#a8c8ff') } },
    PODS_MAX * 2, 4, { blending: THREE.AdditiveBlending });
  const GLOWS = batch(GLOW_GEO, GLOW_F, { uTime: ATMO.hfTime, uCol: { value: new THREE.Color('#d46bff') } }, PODS_MAX, 1,
    { blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -4 });
  const SHADOWS = batch(SHADOW_GEO, SHADOW_F, {}, PODS_MAX, 1, { polygonOffset: true, polygonOffsetFactor: -3 });
  const decal = new THREE.Matrix4(), dpos = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
  const fxv = [0, 0, 0], vals = (a, b = 0, c = 0) => { fxv[0] = a; fxv[1] = b; fxv[2] = c; return fxv; };

  const all = new Set();
  let frame = 0;
  function attach(r) {
    const root = r.mesh, ud = root.userData;
    if (ud.fx) return ud.fx;
    const common = {
      uThr: { value: 0 }, uBoost: { value: 0 }, uOver: { value: 0 }, uTime: ATMO.hfTime, uSeed: { value: Math.random() * 10 },
      uHot: { value: new THREE.Color('#fff4dc') }, uMid: { value: new THREE.Color('#ffa04a') }, uCool: { value: new THREE.Color('#ff3c12') },
    };
    const mat = volume
      ? new THREE.ShaderMaterial({
        vertexShader: VOL_V, fragmentShader: VOL_F, defines: { STEPS: opts.steps || 14 }, transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending, side: THREE.FrontSide,
        uniforms: Object.assign(common, { uIgn: { value: 0 }, uSput: { value: 0 }, uCore: { value: new THREE.Color('#b9d4ff') }, uScale: { value: new THREE.Vector3(1, 1, 1) } }),
      })
      : new THREE.ShaderMaterial({
        vertexShader: PLUME_V, fragmentShader: PLUME_F, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, forceSinglePass: true,
        uniforms: Object.assign(common, { hfCloudTex: ATMO.hfCloudTex }),
      });
    const plumes = ud.engines.map((e) => {
      const p = new THREE.Mesh(volume ? VOL_GEO : PLUME_GEO, mat);
      p.position.copy(e.userData.flame.position);
      p.frustumCulled = false;
      p.renderOrder = 4;
      e.add(p);
      return p;
    });
    // glowing nozzle throats, just inside the exit (anchors for the THROATS batch)
    const throats = ud.engines.map((e) => {
      const m = new THREE.Object3D();
      m.position.copy(e.userData.flame.position).add(new THREE.Vector3(0, 0, 0.1));
      m.scale.setScalar(0.5);
      m.userData.seed = Math.random() * 6;
      e.add(m);
      return m;
    });
    const heats = heat ? ud.engines.map(() => heat.quad(false)) : [];
    const fx = {
      mat, plumes, throats, heats, boost: 0, len: 0, ring: null, ringT: 0, frame: 0, glowSeed: Math.random() * 6,
      ign: 0, sput: 0, wasBoost: false, bfT: 0.3, flash: [0, 0], hot: 0,
    };
    ud.fx = fx;
    pods.set(r, fx);
    all.add(fx);
    return fx;
  }

  function detach(r) {
    const fx = pods.get(r);
    if (!fx) return;
    for (const p of fx.plumes) p.removeFromParent();
    for (const p of fx.throats) p.removeFromParent();
    for (const h of fx.heats) h.removeFromParent();
    fx.ring?.removeFromParent();
    delete r.mesh.userData.fx;
    pods.delete(r);
    all.delete(fx);
  }
  // after every pod's update: upload the batches; heat quads of pods not updated this frame go dark
  function endFrame() {
    for (const fx of all) {
      if (fx.frame === frame) continue;
      for (const h of fx.heats) h.material.uniforms.uK.value = 0;
      if (fx.ring) fx.ring.visible = false;
    }
    THROATS.flush(); GLOWS.flush(); SHADOWS.flush();
    frame++;
  }

  // world position of nozzle k of pod r
  function nozzle(r, k, out) {
    const e = r.mesh.userData.engines[k];
    return out.copy(e.userData.flame.position).applyMatrix4(e.matrixWorld);
  }

  // one-shot exhaust events; near = close enough to the camera to be worth particles
  function ignite(r, fx, near) {
    fx.ign = 1;
    event('ignite', r, 1);
    if (!near || !E.fire) return;
    const sx = Math.sin(r.yaw), sz = Math.cos(r.yaw), rx = sz, rz = -sx;
    for (let k = 0; k < fx.plumes.length; k++) {
      nozzle(r, k, world);
      // a ring of fire blown out of the nozzle plane, plus a hot burst down the jet
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
        E.fire(world.x + rx * c * 0.5, world.y + s * 0.5, world.z + rz * c * 0.5,
          r.vx * 0.75 + rx * c * 9 - sx * 5, s * 9, r.vz * 0.75 + rz * c * 9 - sz * 5, 0.2 + Math.random() * 0.1, { bright: 2.2, size0: 0.45, size1: 1.1 });
      }
      for (let i = 0; i < 5; i++) {
        E.fire(world.x, world.y, world.z, r.vx * 0.5 - sx * (14 + i * 4), (Math.random() - 0.5) * 3, r.vz * 0.5 - sz * (14 + i * 4),
          0.2 + Math.random() * 0.12, { bright: 2.2, color: '#bcd6ff', size0: 0.6, size1: 1.6 });
      }
    }
  }
  function flameout(r, fx, near) {
    fx.sput = 1;
    event('flameout', r, 1);
    if (!near || !E.smoke) return;
    const sx = Math.sin(r.yaw), sz = Math.cos(r.yaw);
    for (let k = 0; k < fx.plumes.length; k++) {
      nozzle(r, k, world);
      for (let i = 0; i < 3; i++) {
        E.smoke(world.x - sx * i * 0.6, world.y + 0.1, world.z - sz * i * 0.6,
          r.vx * 0.55 - sx * 4 + (Math.random() - 0.5) * 2, 1.5 + Math.random() * 2, r.vz * 0.55 - sz * 4 + (Math.random() - 0.5) * 2,
          0.9 + Math.random() * 0.5, { size0: 0.9, size1: 3.4, alpha: 0.32, color: '#6a6159' });
      }
    }
  }
  function backfire(r, fx, k, near) {
    fx.flash[k] = 1;
    fx.ign = Math.max(fx.ign, 0.6);
    event('backfire', r, 1);
    if (!near) return;
    const sx = Math.sin(r.yaw), sz = Math.cos(r.yaw), rx = sz, rz = -sx;
    nozzle(r, k, world);
    if (E.blast) {
      E.blast(world.x - sx * 1.2, world.y, world.z - sz * 1.2, r.vx * 0.6 - sx * 7, 1.5, r.vz * 0.6 - sz * 7, 0.8 + Math.random() * 0.3,
        { size0: 1.2, size1: 3.6, rot: Math.random() * 6.3 });
    }
    // a smoke ring pushed out of the nozzle
    if (E.smoke) {
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
        E.smoke(world.x + rx * c * 0.6, world.y + s * 0.6, world.z + rz * c * 0.6,
          r.vx * 0.6 + rx * c * 4.5 - sx * 5, s * 4.5 + 0.8, r.vz * 0.6 + rz * c * 4.5 - sz * 5,
          0.9 + Math.random() * 0.4, { size0: 0.7, size1: 2.4, alpha: 0.4, color: '#4d4540' });
      }
    }
    if (E.spark) {
      for (let i = 0; i < 10; i++) {
        E.spark(world.x, world.y, world.z, r.vx * 0.6 - sx * 12 + (Math.random() - 0.5) * 12, Math.random() * 7, r.vz * 0.6 - sz * 12 + (Math.random() - 0.5) * 12,
          0.2 + Math.random() * 0.3, { bright: 6 });
      }
    }
  }

  // per frame, per pod
  function update(r, dt, groundQuery, camPos) {
    const fx = attach(r);
    fx.frame = frame;
    // racerFx has posed the pod for this frame: bring its world matrices up to date before the
    // batches copy them (a frame late, the throats would trail the pod by metres at full speed)
    r.mesh.updateMatrixWorld(true);
    const vis = r.mesh.visible && !r.gone;
    const over = r.overheat > 0;
    const thr = over ? 0.15 : r.throttle;
    const camD = camPos ? Math.hypot(r.x - camPos.x, r.y - camPos.y, r.z - camPos.z) : 0;
    const near = camD < 160;
    fx.boost += ((r.boosting ? 1 : 0) - fx.boost) * (1 - Math.exp(-6 * dt));
    // boost on: ignition pop; boost off (not by overheating): the burner sputters out
    if (r.boosting && !fx.wasBoost) ignite(r, fx, near);
    else if (!r.boosting && fx.wasBoost && !over) flameout(r, fx, near);
    fx.wasBoost = r.boosting;
    if (over) {
      if ((fx.bfT -= dt) <= 0) { fx.bfT = 0.3 + Math.random() * 0.8; backfire(r, fx, Math.random() < 0.5 ? 0 : 1, near); }
    } else fx.bfT = 0.15;
    fx.ign = Math.max(0, fx.ign - dt * 3.5);
    fx.sput = Math.max(0, fx.sput - dt * 2.5);
    for (let k = 0; k < 2; k++) fx.flash[k] = Math.max(0, fx.flash[k] - dt * 5);
    fx.hot += ((over ? 1 : Math.max(0, (r.heat - 35) / 65)) - fx.hot) * (1 - Math.exp(-2 * dt));

    const u = fx.mat.uniforms;
    u.uThr.value = thr; u.uBoost.value = fx.boost; u.uOver.value = over ? 1 : 0;
    const sput = fx.sput > 0 ? fx.sput * (Math.random() < 0.5 ? 1 : 0.3) : 0;
    let len, wid;
    if (volume) {
      u.uIgn.value = fx.ign; u.uSput.value = sput;
      len = 2.2 + thr * 4 + fx.boost * 7 + fx.ign * 3;
      wid = 0.72 + fx.boost * 0.1 + fx.ign * 0.25;
    } else {
      len = 1.6 + thr * 3.2 + fx.boost * 5.5;
      wid = 0.42 + thr * 0.1 + fx.boost * 0.12;
    }
    fx.len += (len - fx.len) * (1 - Math.exp(-10 * dt));
    let inside = false;
    for (const p of fx.plumes) {
      p.scale.set(wid, wid, fx.len * (0.94 + Math.random() * 0.12));
      p.visible = vis && camD < 320;
      if (volume && camPos && p.visible) {
        // from inside the box only its back faces are in front of the camera
        p.updateMatrixWorld();
        camL.copy(camPos).applyMatrix4(inv.copy(p.matrixWorld).invert());
        if (Math.abs(camL.x) < 1.05 && Math.abs(camL.y) < 1.05 && camL.z < 0.05 && camL.z > -1.05) inside = true;
      }
    }
    if (volume) { fx.mat.side = inside ? THREE.BackSide : THREE.FrontSide; u.uScale.value.set(wid, wid, fx.len); }
    fx.throats.forEach((m, k) => {
      const bright = (0.55 + thr * 0.6 + fx.boost * 0.9 + fx.ign * 1.5 + fx.flash[k] * 3) * (over ? 0.5 + 0.5 * Math.random() : 1) * (1 - sput * 0.7) * (opts.hdr ?? 1);
      if (vis && camD < 320) THROATS.push(m.matrixWorld, vals(bright, fx.boost, m.userData.seed));
    });
    // ground decals
    const gy = groundQuery(r.x, r.z);
    const h = r.y - gy;
    const sx = Math.sin(r.yaw), sz = Math.cos(r.yaw);
    const ga = groundQuery(r.x + sx * 4, r.z + sz * 4), gb = groundQuery(r.x - sx * 4, r.z - sz * 4);
    const gl = groundQuery(r.x + sz * 3, r.z - sx * 3), gr = groundQuery(r.x - sz * 3, r.z + sx * 3);
    // ground normal from the slopes along the pod (f) and across it (s = (sz, 0, -sx))
    const dx = (ga - gb) / 8, dl = (gl - gr) / 6;
    nrm.set(-(dx * sx + dl * sz), 1, -(dx * sz - dl * sx)).normalize();
    q.setFromUnitVectors(up, nrm);
    qy.setFromAxisAngle(up, r.yaw);
    const nearG = Math.max(0, 1 - Math.max(0, h - 1.2) / 5);
    if (vis) {
      decal.compose(dpos.set(r.x, gy + 0.12, r.z), q.multiply(qy), one);
      GLOWS.push(decal, vals(nearG * (0.12 + thr * 0.25 + fx.boost * 0.25) * (over ? 0.3 : 1), fx.glowSeed));
      SHADOWS.push(decal, vals(nearG * 0.42));
    }
    // heat haze behind each engine
    fx.heats.forEach((hq, k) => {
      const e = r.mesh.userData.engines[k];
      e.getWorldPosition(world);
      back.set(-sx, 0, -sz).multiplyScalar(2.2 + fx.len * 0.35);
      hq.position.copy(world).add(back);
      const s = 2.2 + fx.len * 0.45;
      hq.scale.set(s, s, 1);
      hq.material.uniforms.uK.value = vis ? (0.35 + thr * 0.4 + fx.boost * 0.5 + fx.ign * 0.6) * Math.max(0, 1 - camD / 140) : 0;
      hq.updateMatrixWorld();
    });
    // boost shockwave ring
    if (fx.ring) {
      fx.ringT += dt;
      const t = fx.ringT / 0.55;
      fx.ring.material.uniforms.uK.value = Math.max(0, 1 - t) * 0.9;
      const s = 3 + t * 22;
      fx.ring.scale.set(s, s, 1);
      fx.ring.position.set(r.x - sx * 6, r.y, r.z - sz * 6);
      fx.ring.updateMatrixWorld();
      if (t >= 1) { fx.ring.visible = false; }
    }
  }

  function shockwave(r) {
    const fx = attach(r);
    if (!heat) return;
    if (!fx.ring) fx.ring = heat.quad(true);
    fx.ring.visible = true;
    fx.ringT = 0;
  }

  return { attach, detach, update, shockwave, endFrame };
}

// --- trail map: grooves (R) and boost scorch (G) the pods leave on the track, in track space ---
// u = lateral position across 2.6 half-widths, v = arc length / track length. Stamps add,
// a full-screen pass subtracts a little every frame so the marks fade over ~half a minute.
export function createTrailMap(renderer, trackLength, W = 128, H = 2048) {
  const rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, depthBuffer: false });
  rt.texture.wrapT = THREE.RepeatWrapping;
  const scene = new THREE.Scene(), cam = new THREE.OrthographicCamera(0, 1, 1, 0, -1, 1);
  const MAX = 64;
  const quad = new THREE.PlaneGeometry(1, 1).translate(0.5, 0.5, 0);
  const stamps = new THREE.InstancedMesh(quad, new THREE.MeshBasicMaterial({ color: '#ffffff', blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true }), MAX);
  stamps.frustumCulled = false;
  stamps.count = 0;
  const fade = new THREE.Mesh(quad, new THREE.MeshBasicMaterial({ color: new THREE.Color(0, 0, 0), depthTest: false, depthWrite: false, transparent: true,
    blending: THREE.CustomBlending, blendEquation: THREE.ReverseSubtractEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor }));
  fade.frustumCulled = false;
  fade.renderOrder = -1;
  scene.add(fade, stamps);
  const m = new THREE.Matrix4(), col = new THREE.Color();
  let n = 0, cleared = false;
  const add = (u0, v0, du, dv, groove, scorch) => {
    if (n >= MAX) return;
    m.makeScale(du, dv, 1).setPosition(u0 - du / 2, v0, 0);
    stamps.setMatrixAt(n, m);
    stamps.setColorAt(n, col.setRGB(groove, scorch, 0));
    n++;
  };
  return {
    texture: rt.texture,
    // r: a racer with loc (s, d, hw), y, prevTrailS; dt: frame time
    stamp(r, groundY) {
      const s = r.loc.s, prev = r.trailS ?? s;
      r.trailS = s;
      const ds = s - prev;
      if (Math.abs(ds) > 25 || ds <= 0 || r.y - groundY > 3 || Math.abs(r.loc.d) > r.loc.hw * 1.2) return;
      const span = r.loc.hw * 2.6, u = r.loc.d / span + 0.5, v = prev / trackLength, dv = Math.max(ds, 1.2) / trackLength;
      const k = clamp01(Math.abs(r.fwd) / 120);
      const scorch = r.boosting ? 0.5 : r.overheat > 0 ? 0.35 : 0;
      for (const o of [-1.75, 1.75]) add(u + o / span, v, 1.1 / span, dv, 0.3 * k, scorch);
      add(u, v, 3.4 / span, dv, 0.1 * k, scorch * 0.3);
    },
    render(dt) {
      fade.material.color.setScalar(0.012 * dt);
      stamps.count = n;
      if (n) { stamps.instanceMatrix.needsUpdate = true; if (stamps.instanceColor) stamps.instanceColor.needsUpdate = true; }
      const prev = renderer.getRenderTarget(), auto = renderer.autoClear;
      renderer.autoClear = false;
      renderer.setRenderTarget(rt);
      if (!cleared) {
        const cc = renderer.getClearColor(new THREE.Color()), ca = renderer.getClearAlpha();
        renderer.setClearColor(0x000000, 0); renderer.clear(true, false, false); renderer.setClearColor(cc, ca);
        cleared = true;
      }
      renderer.render(scene, cam);
      renderer.setRenderTarget(prev);
      renderer.autoClear = auto;
      n = 0;
    },
    clear() { cleared = false; },
  };
}
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// --- tumbling debris for hard hits and crashes ---
// geometries: variants (Blender: models/fx/build_debris.py); setGeometries() swaps them in once
// the GLB has loaded. Pieces keep their variant; colors are per piece (pass color in emit).
// opts.trail(x, y, z, k): called each frame for pieces emitted with trail > 0 (smoking shards)
export function createDebris(scene, geometries, material, n = 80, opts = {}) {
  let meshes = [];
  const P = new Float32Array(n * 3), V = new Float32Array(n * 3), R = new Float32Array(n * 3), W = new Float32Array(n * 3);
  const L = new Float32Array(n), S = new Float32Array(n), K = new Uint8Array(n), C = new Float32Array(n * 3), T = new Float32Array(n);
  let head = 0;
  const m = new THREE.Matrix4(), e = new THREE.Euler(), qq = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), col = new THREE.Color();
  function build(geos) {
    for (const im of meshes) { scene.remove(im); im.dispose(); }
    meshes = geos.map((g) => {
      const im = new THREE.InstancedMesh(g, material, n);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.setColorAt(0, col.set('#ffffff'));
      im.frustumCulled = false;
      im.castShadow = true;
      im.userData.dynamic = true;
      im.count = 0;
      im.visible = false;
      scene.add(im);
      return im;
    });
  }
  build(geometries);
  return {
    setGeometries(geos) { build(geos); for (let i = 0; i < n; i++) K[i] = Math.min(K[i], meshes.length - 1); },
    get variants() { return meshes.length; },
    // variant: index or -1 for random; color: THREE.Color-able or null (white); trail: seconds of smoke
    emit(x, y, z, vx, vy, vz, size, variant = -1, color = null, trail = 0) {
      const i = head; head = (head + 1) % n;
      P.set([x, y, z], i * 3); V.set([vx, vy, vz], i * 3);
      R.set([Math.random() * 6, Math.random() * 6, Math.random() * 6], i * 3);
      W.set([(Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14], i * 3);
      L[i] = 2.5 + Math.random() * 1.5; S[i] = size;
      K[i] = variant < 0 ? Math.floor(Math.random() * meshes.length) : Math.min(variant, meshes.length - 1);
      col.set(color ?? '#ffffff');
      C[i * 3] = col.r; C[i * 3 + 1] = col.g; C[i * 3 + 2] = col.b;
      T[i] = trail;
    },
    update(dt, groundQuery) {
      for (const im of meshes) im.count = 0;
      for (let i = 0; i < n; i++) {
        if (L[i] <= 0) continue;
        L[i] -= dt;
        V[i * 3 + 1] -= 22 * dt;
        for (let k = 0; k < 3; k++) { P[i * 3 + k] += V[i * 3 + k] * dt; R[i * 3 + k] += W[i * 3 + k] * dt; }
        const g = groundQuery(P[i * 3], P[i * 3 + 2]) + S[i] * 0.3;
        if (P[i * 3 + 1] < g) {
          P[i * 3 + 1] = g; V[i * 3 + 1] = Math.abs(V[i * 3 + 1]) * 0.35; V[i * 3] *= 0.6; V[i * 3 + 2] *= 0.6;
          for (let k = 0; k < 3; k++) W[i * 3 + k] *= 0.6;
        }
        if (T[i] > 0) { T[i] -= dt; opts.trail?.(P[i * 3], P[i * 3 + 1], P[i * 3 + 2], Math.min(1, T[i])); }
        const im = meshes[K[i]];
        const sc = S[i] * Math.min(1, L[i] * 2);
        m.compose(p.set(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]), qq.setFromEuler(e.set(R[i * 3], R[i * 3 + 1], R[i * 3 + 2])), s.set(sc, sc, sc));
        im.setMatrixAt(im.count, m);
        im.setColorAt(im.count, col.setRGB(C[i * 3], C[i * 3 + 1], C[i * 3 + 2]));
        im.count++;
      }
      for (const im of meshes) {
        im.visible = im.count > 0;          // an empty InstancedMesh still costs a draw (and a shadow draw)
        if (im.count) { im.instanceMatrix.needsUpdate = true; im.instanceColor.needsUpdate = true; }
      }
    },
  };
}
