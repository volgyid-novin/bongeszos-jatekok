import * as THREE from 'three';
import { U } from './backend.js';

// Screen-space helpers shared by the two post chains (gfx/post.js, gfx/tsl/post.js).

// The horizon on screen for the mirage (D5): two points at infinity, level with the camera, either side of
// where it looks; out = (u0, v0, dv/du, radians per uv unit up the screen). vDown: texture v runs down (WebGPU).
const _h1 = new THREE.Vector3(), _h2 = new THREE.Vector3(), _hf = new THREE.Vector3();
export function horizonUv(camera, out, vDown) {
  camera.getWorldDirection(_hf); _hf.y = 0;
  if (_hf.lengthSq() < 1e-6) _hf.set(0, 0, -1);
  _hf.normalize();
  const rx = -_hf.z, rz = _hf.x;
  _h1.set(camera.position.x + (_hf.x + rx * 0.3) * 1e5, camera.position.y, camera.position.z + (_hf.z + rz * 0.3) * 1e5).project(camera);
  _h2.set(camera.position.x + (_hf.x - rx * 0.3) * 1e5, camera.position.y, camera.position.z + (_hf.z - rz * 0.3) * 1e5).project(camera);
  const u1 = _h1.x * 0.5 + 0.5, v1 = vDown ? 0.5 - _h1.y * 0.5 : _h1.y * 0.5 + 0.5;
  const u2 = _h2.x * 0.5 + 0.5, v2 = vDown ? 0.5 - _h2.y * 0.5 : _h2.y * 0.5 + 0.5;
  const k = Math.abs(u2 - u1) > 1e-6 ? (v2 - v1) / (u2 - u1) : 0;
  out.set(u1, v1, k, 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * (vDown ? -1 : 1));
  return out;
}

// contact shadows (?gfx=sss:1, D6; gfx/post.js ContactEffect, gfx/tsl/post.js): steps, march length (m),
// thickness (m), how far out (m), strength on the sun's share
export const CONTACT = { steps: 10, stepsGL: 16, len: 1.0, thick: 0.3, far: 70, strength: 0.85 };
// the sun's irradiance on flat open sand over the sky's (hemisphere + environment), for the contact shadows'
// estimate of the sun's share of a pixel's light
export function sunShare(sunI, hemiI, envI) { return sunI / (hemiI * 0.5 + envI * 1.9); }

// Lens touches (?gfx=lens:1, docs/visual-next-steps.md E8, on trial): a camera in the desert gets dirty. A smudge
// texture (soft blotches, wipe marks, specks) that shows only where the bloom's blurred bright areas are: the noon
// sun, the tunnel's exit and gaps. And in the sand streams (E1) a few grains hit the lens: short-lived specks and
// streaks. LENS.k: the dirt's strength; LENS.grit: 0..1, set every frame (main.js updateWind).
export const LENS = { k: U(2.5), grit: U(0) };
let DIRT = null;
export function lensDirt() {
  if (DIRT) return DIRT;
  const W = 1024, H = 576, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  let seed = 31;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  // soft blotches, denser towards the edges of the glass
  for (let k = 0; k < 70; k++) {
    const x = rnd() * W, y = rnd() * H, r = 18 + rnd() * rnd() * 150;
    const edge = Math.max(Math.abs(x / W - 0.5), Math.abs(y / H - 0.5)) * 2;
    const a = (0.05 + rnd() * 0.16) * (0.5 + edge);
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, `rgba(255,236,205,${a})`); grd.addColorStop(0.6, `rgba(255,236,205,${a * 0.45})`); grd.addColorStop(1, 'rgba(255,236,205,0)');
    g.fillStyle = grd; g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // wipe marks: faint arcs where the glass was cleaned with a sleeve
  g.lineCap = 'round';
  for (let k = 0; k < 9; k++) {
    const cx = rnd() * W, cy = H + rnd() * H * 0.6, r = 220 + rnd() * 420, a0 = -Math.PI * (0.55 + rnd() * 0.3);
    g.strokeStyle = `rgba(255,240,215,${0.04 + rnd() * 0.05})`; g.lineWidth = 6 + rnd() * 22;
    g.beginPath(); g.arc(cx, cy, r, a0, a0 + 0.3 + rnd() * 0.5); g.stroke();
  }
  // specks of grit stuck to the glass
  for (let k = 0; k < 900; k++) {
    const x = rnd() * W, y = rnd() * H, r = 0.6 + rnd() * rnd() * 3.2;
    g.fillStyle = `rgba(255,240,220,${0.15 + rnd() * 0.5})`;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  DIRT = new THREE.CanvasTexture(c);
  DIRT.colorSpace = THREE.NoColorSpace;
  return DIRT;
}
// grains hitting the lens (GLSL; the TSL version in gfx/tsl/post.js): a few cells of a grid over the screen hold a
// speck for a moment, streaking across with the wind
export const GRIT_GLSL = /* glsl */`
vec3 hfGrit( vec2 uv, float t, float k ) {
  if ( k < 0.001 ) return vec3( 0.0 );
  vec2 g = uv * vec2( 32.0, 18.0 ), id = floor( g ), f = fract( g );
  vec4 h = fract( sin( vec4( dot( id, vec2( 127.1, 311.7 ) ), dot( id, vec2( 269.5, 183.3 ) ), dot( id, vec2( 419.2, 371.9 ) ), dot( id, vec2( 61.7, 97.3 ) ) ) ) * 43758.5453 );
  float life = fract( t * ( 0.7 + h.x ) + h.y );
  float on = step( h.z, k * 0.22 ) * smoothstep( 0.0, 0.03, life ) * ( 1.0 - smoothstep( 0.12, 0.3, life ) );
  vec2 d = ( f - vec2( 0.15 + 0.5 * h.w + life * 2.2, 0.2 + 0.6 * fract( h.x * 7.3 ) ) ) * vec2( 1.0, 3.2 );
  return vec3( 1.0, 0.9, 0.74 ) * exp( - dot( d, d ) * 260.0 ) * on * 0.9;
}
`;
