import * as THREE from 'three';
import { WIND_DIR } from './ground.js';
import { pickQuality } from './quality.js';
import { GPU, TSL } from './backend.js';

// ============================================================
//  One wind (?gfx=gust:1, docs/visual-next-steps.md E2): gust fronts a few hundred metres wide roll
//  across the map downwind, with lulls between. The same field moves the grass, the scrub, the cloth,
//  the sand on the road and off the crests, the tumbleweeds and the wind's sound, so the wind reads as
//  one force: you see a front come across the dunes, then it reaches you.
//
//  gust(x, z, t) is 0 in a lull and up to 1 in a gust's core. It is written three times with the same
//  constants: here (the particles, tumbleweeds, sound), GUST_GLSL (the WebGL materials) and hfGust in
//  gfx/tsl/wind.js (the node materials).
//
//  Each front k is a pulse of u = t / P - along / (V P) + phase (+ a slow bend across the wind, so the
//  fronts are not ruler-straight): it rises over the first quarter of its width and dies away over the
//  rest (a sharp leading edge, a slow tail), every P seconds at a given point. Its strength along the
//  front is a 1D value noise (segments of a few hundred metres, the lulls between them), re-seeded for
//  every pass (cycle = floor(u)), so no two gusts at a point are alike.
// ============================================================
export const GUST_ON = !!pickQuality().gust;
export { WIND_DIR };

export const GUST = {
  V: 14,             // m/s: how fast a front travels downwind
  SEG: 380,          // m: the length scale of a front's strong and weak segments
  BEND: 700,         // m: the length scale of a front's curve
  // per front: period (s), width (the share of the period it lasts at a point), strength, phase
  FRONTS: [[11.0, 0.42, 1.0, 0.0], [15.3, 0.34, 0.85, 0.37], [7.4, 0.3, 0.5, 0.71]],
};

// Hoskins' hash without sine, as GLSL and TSL write it
const fract = (x) => x - Math.floor(x);
function h11(p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
function n11(x) { const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f); return h11(i) + (h11(i + 1) - h11(i)) * u; }
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export function gust(x, z, t) {
  return GUST_ON ? gustField(x, z, t) : 0;
}
// the field itself, also with the graphics off: the gusts push the pods (main.js, physics), and the physics must not
// depend on the graphics preset
export function gustField(x, z, t) {
  const a = x * WIND_DIR.x + z * WIND_DIR.y, c = z * WIND_DIR.x - x * WIND_DIR.y;
  let g = 0;
  GUST.FRONTS.forEach(([P, w, amp, ph], k) => {
    const u = t / P - a / (GUST.V * P) + ph + (n11(c / GUST.BEND + k * 7.1) - 0.5) * 0.6;
    const cyc = Math.floor(u), x2 = (u - cyc) / w;
    const pulse = x2 < 1 ? sstep(0, 0.25, x2) * (1 - sstep(0.25, 1, x2)) : 0;
    const s = sstep(0.28, 0.72, n11(c / GUST.SEG + cyc * 3.71 + k * 17.3)) * (0.55 + 0.45 * h11(cyc * 1.37 + k * 9.1));
    g += amp * s * pulse;
  });
  return Math.min(g, 1);
}

// GLSL: float hfGust( vec2 xz, float t ). Self-contained (no uniforms), so it can go into vertex and
// fragment shaders alike.
const f1 = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v));
export const GUST_GLSL = /* glsl */`
float hfGh11( float p ) { p = fract( p * 0.1031 ); p *= p + 33.33; p *= p + p; return fract( p ); }
float hfGn11( float x ) { float i = floor( x ), f = x - i; return mix( hfGh11( i ), hfGh11( i + 1.0 ), f * f * ( 3.0 - 2.0 * f ) ); }
float hfGust( vec2 p, float t ) {
  const vec2 W = vec2( ${WIND_DIR.x}, ${WIND_DIR.y} );
  float a = dot( p, W ), c = p.y * W.x - p.x * W.y, g = 0.0;
  ${GUST.FRONTS.map(([P, w, amp, ph], k) => `{
    float u = t / ${f1(P)} - a / ${f1(GUST.V * P)} + ${f1(ph)} + ( hfGn11( c / ${f1(GUST.BEND)} + ${f1(k * 7.1)} ) - 0.5 ) * 0.6;
    float cyc = floor( u ), x = ( u - cyc ) / ${f1(w)};
    float pulse = x < 1.0 ? smoothstep( 0.0, 0.25, x ) * ( 1.0 - smoothstep( 0.25, 1.0, x ) ) : 0.0;
    float s = smoothstep( 0.28, 0.72, hfGn11( c / ${f1(GUST.SEG)} + cyc * 3.71 + ${f1(k * 17.3)} ) ) * ( 0.55 + 0.45 * hfGh11( cyc * 1.37 + ${f1(k * 9.1)} ) );
    g += ${f1(amp)} * s * pulse;
  }`).join('\n  ')}
  return min( g, 1.0 );
}
`;

// ============================================================
//  Pods disturb the world (?gfx=wake:1, E7). The pods nearest the camera (WAKE_N) go into two uniform arrays
//  every frame: hfWakeP = (position, strength 0..1.5 from the speed), hfWakeV = (unit heading x, z, speed m/s, 0).
//  hfWake(p) is stateless: behind a pod, in a corridor that widens with the distance, things are blasted back
//  by the jets and dragged along, and ring down like a damped spring (a point `along` metres behind was passed
//  along / speed seconds ago); in front of it a small bow wave pushes them out. Returns (push x, push z, the
//  corridor's core 0..~1.5: where the hanging dust and the sand streams are cleared).
// ============================================================
export const WAKE_ON = !!pickQuality().wake;
export const WAKE_N = 8;
const wakeP = Array.from({ length: WAKE_N }, () => new THREE.Vector4(0, -1e4, 0, 0));
const wakeV = Array.from({ length: WAKE_N }, () => new THREE.Vector4(0, 1, 0, 0));
export const WAKE = GPU
  ? { hfWakeP: TSL.uniformArray(wakeP, 'vec4'), hfWakeV: TSL.uniformArray(wakeV, 'vec4') }
  : { hfWakeP: { value: wakeP }, hfWakeV: { value: wakeV } };
// racers: { x, y, z, vx, vz, fwd, gone }; cam: the camera position
const _order = [];
export function updateWake(racers, cam) {
  _order.length = 0;
  for (const r of racers) if (!r.gone) _order.push(r);
  _order.sort((a, b) => Math.hypot(a.x - cam.x, a.z - cam.z) - Math.hypot(b.x - cam.x, b.z - cam.z));
  for (let k = 0; k < WAKE_N; k++) {
    const r = _order[k];
    if (!r) { wakeP[k].set(0, -1e4, 0, 0); continue; }
    const sp = Math.hypot(r.vx, r.vz);
    wakeP[k].set(r.x, r.y, r.z, Math.min(1.5, sp / 80));
    if (sp > 0.5) wakeV[k].set(r.vx / sp, r.vz / sp, sp, 0);
  }
}
// JS twin for the CPU things (tumbleweeds): the push only, at x, z
export function wakeAt(x, z, y = 0) {
  let px = 0, pz = 0;
  for (let k = 0; k < WAKE_N; k++) {
    const p = wakeP[k], v = wakeV[k];
    if (p.w <= 0) continue;
    const rx = x - p.x, rz = z - p.z, along = -(rx * v.x + rz * v.y);
    const lx = rx + v.x * along, lz = rz + v.y * along, lat = Math.hypot(lx, lz), h = Math.abs(y - p.y);
    const w = 3.5 + Math.max(along, 0) * 0.3, t = Math.max(along, 0) / Math.max(v.z, 5);
    const ring = along >= 0 ? Math.exp(-t * 2.2) * Math.cos(t * 8) : 0;
    const core = Math.exp(-lat * lat / (w * w)) * Math.exp(-h * h / 30);
    px += (-v.x * 0.8 + (lat > 1e-3 ? lx / lat : 0) * 0.5) * ring * core * p.w;
    pz += (-v.y * 0.8 + (lat > 1e-3 ? lz / lat : 0) * 0.5) * ring * core * p.w;
    const bow = along < 0 ? Math.exp(-(rx * rx + rz * rz) / 60) * 0.6 * p.w : 0, rl = Math.hypot(rx, rz) || 1;
    px += rx / rl * bow; pz += rz / rl * bow;
  }
  return { x: px, z: pz };
}
// GLSL: vec3 hfWake( vec3 wp, int n ) over the n nearest pods (8 for the grass, fewer in the costly passes)
export const WAKE_GLSL = /* glsl */`
uniform vec4 hfWakeP[ ${WAKE_N} ], hfWakeV[ ${WAKE_N} ];
vec3 hfWake( vec3 wp, int n ) {
  vec2 push = vec2( 0.0 );
  float clear = 0.0;
  for ( int k = 0; k < ${WAKE_N}; k ++ ) {
    if ( k >= n ) break;
    vec4 p = hfWakeP[ k ], v = hfWakeV[ k ];
    if ( p.w <= 0.0 ) continue;
    vec2 rel = wp.xz - p.xz;
    float along = - dot( rel, v.xy );
    vec2 latV = rel + v.xy * along;
    float lat = length( latV ), h = abs( wp.y - p.y );
    float w = 3.5 + max( along, 0.0 ) * 0.3, t = max( along, 0.0 ) / max( v.z, 5.0 );
    float ring = along >= 0.0 ? exp( - t * 2.2 ) * cos( t * 8.0 ) : 0.0;
    float core = exp( - lat * lat / ( w * w ) ) * exp( - h * h / 30.0 );
    push += ( - v.xy * 0.8 + ( lat > 1e-3 ? latV / lat : vec2( 0.0 ) ) * 0.5 ) * ring * core * p.w;
    float bow = along < 0.0 ? exp( - dot( rel, rel ) / 60.0 ) * 0.6 * p.w : 0.0;
    push += rel / max( length( rel ), 1e-3 ) * bow;
    clear += core * ( along >= 0.0 ? exp( - t * 1.5 ) : 0.0 ) * p.w;
  }
  return vec3( push, clear );
}
`;
// (debug, __homok.wake: put pod k at p = [x, y, z, strength] with v = [heading x, heading z, speed])
export function setWake(k, p, v) { wakeP[k].set(...p); wakeV[k].set(v[0], v[1], v[2], 0); }
