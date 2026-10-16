// Small vec3 helpers on plain arrays, a seeded PRNG and a string hash. Nothing here touches the DOM, Date or Math.random.
export const DEG = Math.PI / 180;
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;

export const vec = (x = 0, y = 0, z = 0) => [x, y, z];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const norm = (a) => { const l = len(a); return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; };

// Yaw convention (same as three.js camera.rotation.y with order 'YXZ'): yaw 0 looks down -Z, yaw +90° looks down -X,
// pitch > 0 looks up. Right-hand vector at yaw 0 is +X.
export const fwdOf = (yaw) => [-Math.sin(yaw), 0, -Math.cos(yaw)];
export const rightOf = (yaw) => [Math.cos(yaw), 0, -Math.sin(yaw)];
export const aimOf = (yaw, pitch) => { const c = Math.cos(pitch); return [-Math.sin(yaw) * c, Math.sin(pitch), -Math.cos(yaw) * c]; };
// the yaw (radians) that looks along the horizontal direction (dx, dz)
export const yawTo = (dx, dz) => Math.atan2(-dx, -dz);
// shortest signed angle difference a - b, in (-π, π]
export const angDiff = (a, b) => { let d = (a - b) % (2 * Math.PI); if (d > Math.PI) d -= 2 * Math.PI; else if (d <= -Math.PI) d += 2 * Math.PI; return d; };

// exact sin/cos for multiples of 90° so that rotated boxes stay exactly axis aligned
export function sincosDeg(deg) {
  const m = ((deg % 360) + 360) % 360;
  if (m === 0) return [0, 1];
  if (m === 90) return [1, 0];
  if (m === 180) return [0, -1];
  if (m === 270) return [-1, 0];
  const r = deg * DEG;
  return [Math.sin(r), Math.cos(r)];
}
// rotate about +Y by yaw degrees (three.js rotation.y): local -> world
export function rotY(p, deg) {
  const [s, c] = sincosDeg(deg);
  return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c];
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// cyrb53: 53-bit string hash; hex string of 14 digits
export function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

// hash of a float stream (bit exact), for determinism checks
const f64 = new Float64Array(1), u32 = new Uint32Array(f64.buffer);
export function hashFloats(list) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (const v of list) {
    f64[0] = v;
    for (let k = 0; k < 2; k++) {
      h1 = Math.imul(h1 ^ u32[k], 2654435761);
      h2 = Math.imul(h2 ^ u32[k], 1597334677);
    }
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}
