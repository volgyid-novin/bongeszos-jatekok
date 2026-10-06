import * as THREE from 'three';
import { FxBatch, shown } from './fxbatch.js';

// ============================================================
//  Energy beam between the two engines. One instanced draw per pod; every strand is a
//  camera-facing ribbon built in the vertex shader along a path between the two emitters:
//   glow   wide soft sheath with energy pulses running from engine to engine
//   core   thin white-hot line
//   arc    jagged side arcs that re-roll every few hundredths of a second
//   fork   short branches that split off an arc and fade
//   whip   loose arcs spitting from a broken emitter (after a crash) or an unstable one
//  plus a flare on each emitter tip. The light it throws is a separate pool (createBeamLights).
// ============================================================

const SEG = 40;
// kind, seed, u0, u1   (forks and whips pick their own span per epoch)
const STRANDS = [
  [0, 0.1, 0, 1], [1, 0.2, 0, 1],
  [2, 1, 0, 1], [2, 2, 0, 1], [2, 3, 0, 1],
  [3, 4, 0, 1], [3, 5, 0, 1],
  [4, 6, 0, 0], [4, 7, 1, 0], [4, 8, 0, 0], [4, 9, 1, 0],
];

const NOISE = /* glsl */`
float h11( float n ) { return fract( sin( n * 12.9898 + 4.1414 ) * 43758.5453 ); }
float jag( float x ) { float i = floor( x ); return mix( h11( i ), h11( i + 1.0 ), fract( x ) ) * 2.0 - 1.0; }
float smo( float x ) { float i = floor( x ), f = fract( x ); f = f * f * ( 3.0 - 2.0 * f ); return mix( h11( i ), h11( i + 1.0 ), f ) * 2.0 - 1.0; }
`;

const BEAM_V = /* glsl */`
uniform vec3 uA, uB;
uniform float uTime, uRate, uArc, uWobble, uThick, uWhip, uPx, uArcs;
attribute vec4 aInfo;
varying float vSide, vU, vK, vA;
${NOISE}
// lightning-like offset: polyline noise, four octaves, re-rolled every epoch
vec2 bolt( float u, float s ) {
  vec2 j = vec2( 0.0 ); float a = 1.0, f = 3.0;
  for ( int k = 0; k < 4; k ++ ) { j += a * vec2( jag( u * f + s ), jag( u * f + s + 57.0 ) ); a *= 0.52; f *= 2.13; }
  return j;
}
vec3 frameN1, frameN2;
float L;
vec3 mainPath( float u, float seed, float epoch, bool jagged ) {
  vec3 p = mix( uA, uB, u );
  float env = pow( max( sin( 3.14159 * clamp( u, 0.0, 1.0 ) ), 0.0 ), 0.75 );
  vec2 w = vec2( smo( u * 1.6 + uTime * 3.1 ), smo( u * 1.9 - uTime * 2.6 + 5.3 ) ) * uWobble;
  if ( jagged ) w += bolt( u, epoch * 17.0 + seed * 31.7 ) * uArc * L * 0.085;
  return p + ( frameN1 * w.x + frameN2 * w.y ) * env;
}
vec3 strand( float t, vec4 info, float epoch, out float fade ) {
  float kind = info.x, seed = info.y;
  fade = 1.0;
  if ( kind < 2.5 ) return mainPath( mix( info.z, info.w, t ), seed, epoch, kind > 1.5 );
  if ( kind < 3.5 ) {
    // fork: leaves its parent arc somewhere along the beam and drifts off sideways
    float pe = floor( uTime * uRate + h11( seed - 3.0 ) * 7.0 );
    float u0 = 0.12 + 0.62 * h11( epoch * 1.7 + seed ), len = 0.12 + 0.22 * h11( epoch * 2.3 + seed );
    float u = u0 + len * t;
    vec3 p = mainPath( u, seed - 3.0, pe, true );
    float ang = h11( epoch * 3.9 + seed ) * 6.2832;
    vec2 off = vec2( cos( ang ), sin( ang ) ) * t * len * L * 0.7 + bolt( t, epoch * 5.0 + seed ) * t * 0.12;
    fade = 1.0 - t;
    return p + frameN1 * off.x + frameN2 * off.y;
  }
  // whip: rooted on an emitter, flails outwards
  vec3 root = info.z < 0.5 ? uA : uB;
  vec3 out1 = ( info.z < 0.5 ? - 1.0 : 1.0 ) * cross( frameN1, frameN2 );
  float ang = h11( epoch * 4.1 + seed ) * 6.2832;
  vec3 dir = normalize( out1 * 0.5 + frameN1 * cos( ang ) + frameN2 * sin( ang ) * 0.8 + vec3( 0.0, 0.35, 0.0 ) );
  float len = ( 0.35 + 0.7 * h11( epoch * 2.9 + seed ) ) * ( 0.4 + 0.6 * uWhip );
  vec2 j = bolt( t, epoch * 9.0 + seed ) * 0.16 * t;
  fade = 1.0 - t * t;
  return root + dir * len * t + frameN1 * j.x + frameN2 * j.y;
}
void main() {
  vec3 ax = uB - uA;
  L = length( ax );
  ax = L > 1e-3 ? ax / L : vec3( 1.0, 0.0, 0.0 );
  L = max( L, 1e-3 );
  frameN1 = normalize( cross( ax, vec3( 0.0, 0.0, 1.0 ) ) );
  frameN2 = cross( ax, frameN1 );
  float kind = aInfo.x, seed = aInfo.y;
  float epoch = floor( uTime * uRate * ( kind > 3.5 ? 1.6 : 1.0 ) + h11( seed ) * 7.0 );
  float t = position.x, side = position.y;
  float fade;
  vec3 p = strand( t, aInfo, epoch, fade );
  float f2;
  vec3 q = strand( t + ( t > 0.99 ? - 0.02 : 0.02 ), aInfo, epoch, f2 );
  vec4 mv = modelViewMatrix * vec4( p, 1.0 );
  vec3 tv = ( modelViewMatrix * vec4( q, 1.0 ) ).xyz - mv.xyz;
  tv = length( tv ) > 1e-6 ? normalize( tv ) : vec3( 0.0, 1.0, 0.0 );
  vec3 sv = cross( tv, normalize( mv.xyz ) );
  sv = length( sv ) > 1e-4 ? normalize( sv ) : vec3( 1.0, 0.0, 0.0 );
  float w = kind < 0.5 ? 0.42 * uThick : kind < 1.5 ? 0.05 * uThick : kind < 2.5 ? 0.04 : 0.03;
  // keep thin strands at least ~1.3 px wide and dim them instead, so they do not shimmer
  float minW = 1.3 * uPx * - mv.z;
  float a = fade;
  if ( w < minW ) { a *= w / minW; w = minW; }
  // which arcs show this epoch
  if ( kind > 1.5 && kind < 3.5 ) a *= step( h11( epoch * 7.3 + seed * 3.1 ), uArcs );
  if ( kind > 3.5 ) a *= step( 0.35, h11( epoch * 5.7 + seed ) ) * uWhip;
  mv.xyz += sv * side * w;
  vSide = side; vU = kind > 2.5 ? t : mix( aInfo.z, aInfo.w, t ); vK = kind; vA = a;
  gl_Position = projectionMatrix * mv;
}`;

const BEAM_F = /* glsl */`
uniform vec3 uCol, uHot;
uniform float uI, uOn, uTime, uPulse, uReach, uFlicker;
varying float vSide, vU, vK, vA;
void main() {
  float x = abs( vSide );
  float a; vec3 c;
  if ( vK < 0.5 ) { a = exp( - x * x * 4.5 ) * 0.55; c = uCol; }
  else if ( vK < 1.5 ) { a = pow( max( 1.0 - x, 0.0 ), 2.2 ); c = mix( uCol, uHot, 0.8 ) * 3.0; }
  else { a = pow( max( 1.0 - x, 0.0 ), 1.6 ); c = mix( uCol, uHot, 0.55 ) * ( vK > 3.5 ? 3.2 : 2.4 ); }
  // energy pulses travelling from the left emitter to the right one
  if ( vK < 1.5 ) {
    float p = pow( 0.5 + 0.5 * sin( ( vU * 2.2 - uTime * uPulse ) * 6.2832 ), 12.0 );
    c *= 1.0 + p * ( vK < 0.5 ? 1.6 : 1.1 );
  }
  float on = vK > 3.5 ? 1.0 : uOn;
  // re-ignition: only the part up to the travelling head is lit, the head itself flares
  if ( vK < 3.5 ) {
    float head = 1.0 - smoothstep( 0.0, 0.08, abs( vU - uReach ) );
    on *= step( vU, uReach + 0.02 ) * ( 1.0 + head * 4.0 * step( uReach, 0.99 ) );
  }
  gl_FragColor = vec4( c * a * vA * on * uI * uFlicker, 1.0 );
}`;

// emitter flares of every pod in one draw (gfx/fxbatch.js): aFx = size, brightness, rotation
const FLARE_V = /* glsl */`
attribute vec3 aFx, aCol, aHot;
varying vec2 vC;
varying vec3 vFx, vCol, vHot;
void main() {
  vC = position.xy * 2.0;
  vFx = aFx; vCol = aCol; vHot = aHot;
  vec4 mv = modelViewMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 );
  mv.xyz += normalize( - mv.xyz ) * 0.6;        // pull towards the camera so the engine does not clip it
  mv.xy += position.xy * aFx.x;
  gl_Position = projectionMatrix * mv;
}`;
const FLARE_F = /* glsl */`
varying vec2 vC;
varying vec3 vFx, vCol, vHot;
void main() {
  float r = length( vC );
  float ang = atan( vC.y, vC.x ), rot = vFx.z;
  float core = exp( - r * 14.0 ) * 3.0 + exp( - r * r * 9.0 ) * 0.5;
  float rays = ( pow( abs( cos( ang * 2.0 + rot ) ), 40.0 ) + 0.6 * pow( abs( cos( ang * 3.0 - rot * 1.7 + 0.7 ) ), 60.0 ) ) * exp( - r * 3.2 );
  vec3 c = mix( vCol, vHot, clamp( core * 0.4, 0.0, 1.0 ) ) * ( core + rays * 0.9 );
  gl_FragColor = vec4( c * vFx.y * smoothstep( 1.0, 0.6, r ), 1.0 );
}`;

let GEO = null;
function strandGeometry() {
  if (GEO) return GEO;
  const g = new THREE.InstancedBufferGeometry();
  const pos = new Float32Array((SEG + 1) * 2 * 3), idx = [];
  for (let i = 0; i <= SEG; i++) {
    for (let s = 0; s < 2; s++) { pos[(i * 2 + s) * 3] = i / SEG; pos[(i * 2 + s) * 3 + 1] = s ? 1 : -1; }
    if (i < SEG) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.setAttribute('aInfo', new THREE.InstancedBufferAttribute(new Float32Array(STRANDS.flat()), 4));
  g.instanceCount = STRANDS.length;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  GEO = g;
  return g;
}
const FLARE_GEO = new THREE.PlaneGeometry(1, 1);

// the batch that draws the emitter flares of every beam (two per pod)
export function createBeamFlares(scene, maxBeams = 12) {
  return new FxBatch(scene, FLARE_GEO, new THREE.ShaderMaterial({
    vertexShader: FLARE_V, fragmentShader: FLARE_F, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }), maxBeams * 2, { aFx: 3, aCol: 3, aHot: 3 }, 5);
}

const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));

// opts.hdr: brightness multiplier (lower without post-processing, where nothing tone maps it)
export function createBeam(opts = {}) {
  const hdr = opts.hdr ?? 1;
  const col = new THREE.Color(opts.color ?? '#ff3ad2'), hot = new THREE.Color(opts.hot ?? '#ffe6fb');
  const U = {
    uA: { value: new THREE.Vector3() }, uB: { value: new THREE.Vector3() },
    uTime: { value: 0 }, uRate: { value: 14 }, uArc: { value: 1 }, uWobble: { value: 0.05 }, uThick: { value: 1 },
    uWhip: { value: 0 }, uPx: { value: 0.001 }, uArcs: { value: 0.6 },
    uCol: { value: col.clone() }, uHot: { value: hot.clone() }, uI: { value: hdr }, uOn: { value: 1 },
    uPulse: { value: 1.6 }, uReach: { value: 1 }, uFlicker: { value: 1 },
  };
  const mesh = new THREE.Mesh(strandGeometry(), new THREE.ShaderMaterial({
    vertexShader: BEAM_V, fragmentShader: BEAM_F, uniforms: U,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, forceSinglePass: true,
  }));
  mesh.frustumCulled = false;
  mesh.renderOrder = 5;
  // the strand geometry is shared by every pod, so the arc count is set right before each draw
  let count = STRANDS.length;
  mesh.onBeforeRender = () => { mesh.geometry.instanceCount = count; };
  // emitter flares: anchors for the flare batch (opts.flares), drawn by pushFlares()
  const flares = [0, 1].map(() => {
    const m = new THREE.Object3D();
    m.userData.fx = new THREE.Vector3(1, 0, Math.random() * 6);     // size, brightness, rotation
    return m;
  });
  const group = new THREE.Group();
  group.add(mesh, ...flares);

  // anchors: emitter tips in engine space, so the ends follow the engines as they bob and roll
  let engines = null;
  const anchor = [new THREE.Vector3(), new THREE.Vector3()];
  const S = { level: 1, strain: 0, unstable: 0, snapT: 0, reach: 1, flash: [0, 0], whip: 0, on: 1, k: 1, sparks: 0 };

  return {
    group, S,
    // tips: body-space emitter positions at rest; the engines' current transforms carry them
    bind(engs, tips) {
      engines = engs;
      engs.forEach((e, k) => { e.updateMatrix(); anchor[k].copy(tips[k]).applyMatrix4(e.matrix.clone().invert()); });
    },
    // world position of an emitter tip
    end(k, out) { return out.copy(k ? U.uB.value : U.uA.value).applyMatrix4(group.matrixWorld); },
    snap() {
      if (S.snapT > 0) return;
      S.snapT = 0.9 + Math.random() * 0.4;
      S.flash[0] = S.flash[1] = 1.6;
      S.whip = 1;
    },
    hit(k) { S.strain = Math.max(S.strain, Math.min(1, k)); },
    // r: racer state; t: time; camD: camera distance; pxScale: world metres per pixel at 1 m
    update(r, dt, t, camD, pxScale) {
      for (let k = 0; k < 2; k++) {
        engines[k].updateMatrix();
        (k ? U.uB.value : U.uA.value).copy(anchor[k]).applyMatrix4(engines[k].matrix);
      }
      const over = r.overheat > 0;
      S.level = damp(S.level, r.boosting ? 1.7 : over ? 0.7 : 0.85 + 0.25 * r.throttle, 6, dt);
      S.unstable = damp(S.unstable, over ? 1 : r.heat > 80 ? (r.heat - 80) / 40 : 0, 4, dt);
      S.strain = Math.max(0, S.strain - dt * 1.6);
      // snapped: dark, emitters spitting; then the beam shoots back across from the left emitter
      if (S.snapT > 0) {
        S.snapT -= dt;
        S.on = 0;
        if (S.snapT <= 0) { S.reach = 0; S.on = 1; }
      }
      if (S.reach < 1) {
        S.reach = Math.min(1, S.reach + dt / 0.14);
        if (S.reach >= 1) { S.flash[1] = 1.4; }
      }
      S.whip = Math.max(S.snapT > 0 ? 0.6 + 0.4 * Math.random() : 0, S.whip - dt * 2, S.unstable * 0.5 * (Math.random() < 0.3 ? 1 : 0));
      for (let k = 0; k < 2; k++) S.flash[k] = Math.max(0, S.flash[k] - dt * 4);
      // overheating: the beam stutters
      const flick = S.unstable > 0.05 ? 1 - S.unstable * 0.75 * (Math.random() < 0.35 ? 1 : 0) : 1;
      S.k = S.on * flick * S.level;
      S.sparks = (S.snapT > 0 ? 40 : 0) + S.unstable * 25 + S.strain * 30 + (r.boosting ? 4 : 0);

      U.uTime.value = t;
      U.uI.value = hdr * S.level * (0.9 + 0.1 * Math.sin(t * 53));
      U.uOn.value = S.on;
      U.uReach.value = S.reach;
      U.uFlicker.value = flick;
      U.uThick.value = 0.8 + 0.6 * S.level;
      U.uArc.value = 0.75 + S.strain * 1.6 + S.unstable * 1.4 + (r.boosting ? 0.35 : 0);
      U.uArcs.value = Math.min(1, 0.62 + S.strain * 0.6 + S.unstable * 0.5 + (r.boosting ? 0.3 : 0));
      U.uWobble.value = 0.05 + S.strain * 0.25 + S.unstable * 0.08;
      U.uRate.value = 12 + (r.boosting ? 8 : 0) + S.unstable * 10;
      U.uPulse.value = 1.4 + 2.4 * S.level;
      U.uWhip.value = S.whip;
      U.uPx.value = pxScale;
      U.uCol.value.copy(col).lerp(_c.set('#ff6a2a'), S.unstable * 0.7);
      U.uHot.value.copy(hot).lerp(_c.set('#ffd2a0'), S.unstable * 0.6);
      // far away only the glow and core are worth drawing
      count = camD > 160 ? 2 : STRANDS.length;
      for (let k = 0; k < 2; k++) {
        const f = flares[k];
        f.position.copy(k ? U.uB.value : U.uA.value);
        const v = f.userData.fx;
        v.y = hdr * (S.on * flick * (0.55 + 0.35 * S.level) + S.flash[k] + (S.snapT > 0 ? 0.5 * Math.random() : 0));
        v.x = 0.9 + 0.5 * S.level + S.flash[k] * 1.5;
        v.z += dt * (2 + 6 * S.unstable);
      }
      group.visible = camD < 600;
    },
    // once the pod's world matrices are final for this frame
    pushFlares() {
      if (!opts.flares) return;
      for (const f of flares) if (shown(f)) opts.flares.push(f.matrixWorld, f.userData.fx, U.uCol.value, U.uHot.value);
    },
  };
}
const _c = new THREE.Color();

// A few real lights for the nearest beams: magenta light on the engines, the cockpit and the sand.
export function createBeamLights(scene, n) {
  const lights = [];
  for (let i = 0; i < n; i++) {
    const l = new THREE.PointLight('#ff3ad2', 0, 14, 2);
    l.castShadow = false;
    scene.add(l);
    lights.push(l);
  }
  const mid = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3();
  // beams: [{ beam, camD }] sorted by the caller (nearest first)
  return {
    update(list) {
      for (let i = 0; i < n; i++) {
        const l = lights[i], it = list[i];
        if (!it || it.camD > 90) { l.intensity = 0; continue; }
        const S = it.beam.S;
        it.beam.end(0, a); it.beam.end(1, b);
        mid.addVectors(a, b).multiplyScalar(0.5);
        l.position.copy(mid);
        l.color.copy(it.beam.group.children[0].material.uniforms.uCol.value);
        l.intensity = 4.5 * S.k * (0.85 + 0.3 * Math.random()) * (1 - it.camD / 90) + (S.flash[0] + S.flash[1]) * 6;
      }
    },
  };
}
