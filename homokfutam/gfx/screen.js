import * as THREE from 'three';

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
