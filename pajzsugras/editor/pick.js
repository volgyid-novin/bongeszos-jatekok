// PAJZSUGRÁS map editor, picking and placement. Pure math against the editor document (no three, no DOM): node-testable.
//
//   rayFromCamera(cam { pos, yaw, pitch (radians) }, ndc [x, y], vfovDeg, aspect) -> { o, d }
//   pickRay(doc, o, d, { skip, tMax }) -> { id, t, point, item } | null    the nearest item (incl. 'start') the ray enters; the smaller one wins a tie
//   surfaceHit(world, o, d, maxDist) -> { point, normal, t } | null        the sim's own trace (exact on ramps); falls back to the y = 0 plane
//   rayPlaneY(o, d, y) -> point | null
//   snap(v, g)  snapMin(c, size, g)                                         the grid (0.5 m / 0.1 m); snapMin puts the MIN corner on the grid
//   placement(entry, hit, { grid, yaw, camYaw, size }) -> the position fields of a new item ({ c } | { pos } ...)
//   padArc(pad, n) -> n + 1 points of the throw     findTestSpawn(world, feet) -> feet | null   (a start that is inside a wall / kill box is lifted)
import { itemAabb, worldSize, r2, paletteOf } from './model.js';
import { hullSolid } from '../sim/pmove.js';
import { HULL_HX, HULL_H, G } from '../sim/const.js';

const DEG = Math.PI / 180;

// ---------------------------------------------------------------- camera rays
export function rayFromCamera(cam, ndc, vfovDeg, aspect) {
  const tv = Math.tan((vfovDeg * DEG) / 2), th = tv * aspect;
  let x = ndc[0] * th, y = ndc[1] * tv, z = -1;
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  const y1 = y * cp - z * sp, z1 = y * sp + z * cp;       // pitch about x
  const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
  const x2 = x * cy + z1 * sy, z2 = -x * sy + z1 * cy;   // yaw about y (three's rotation order YXZ)
  const l = Math.hypot(x2, y1, z2);
  return { o: cam.pos.slice(), d: [x2 / l, y1 / l, z2 / l] };
}

export function rayPlaneY(o, d, y) {
  if (Math.abs(d[1]) < 1e-9) return null;
  const t = (y - o[1]) / d[1];
  return t > 0 ? [o[0] + d[0] * t, y, o[2] + d[2] * t] : null;
}

// ---------------------------------------------------------------- ray vs item
// slab test against an axis aligned box: entry distance (0 when the origin is inside) or null
function rayBox(o, d, b) {
  let t0 = 0, t1 = Infinity;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-12) { if (o[a] < b.min[a] || o[a] > b.max[a]) return null; continue; }
    let u = (b.min[a] - o[a]) / d[a], v = (b.max[a] - o[a]) / d[a];
    if (u > v) { const w = u; u = v; v = w; }
    if (u > t0) t0 = u;
    if (v < t1) t1 = v;
    if (t0 > t1) return null;
  }
  return t0;
}

// clip a ray against convex planes [nx, ny, nz, d] (outside: n.p > d)
function rayPlanes(o, d, planes) {
  let t0 = 0, t1 = Infinity;
  for (const [nx, ny, nz, pd] of planes) {
    const den = nx * d[0] + ny * d[1] + nz * d[2], dist = nx * o[0] + ny * o[1] + nz * o[2] - pd;
    if (Math.abs(den) < 1e-12) { if (dist > 0) return null; continue; }
    const t = -dist / den;
    if (den < 0) { if (t > t0) t0 = t; } else if (t < t1) t1 = t;
    if (t0 > t1) return null;
  }
  return t0;
}

// the same ray in an item's local frame (centre c, yaw degrees): rotY(p - c, -yaw)
function toLocal(o, d, c, yaw) {
  const a = -yaw * DEG, s = Math.sin(a), co = Math.cos(a);
  const rot = (x, z) => [x * co + z * s, -x * s + z * co];
  const [ox, oz] = rot(o[0] - c[0], o[2] - c[2]), [dx, dz] = rot(d[0], d[2]);
  return { o: [ox, o[1] - c[1], oz], d: [dx, d[1], dz] };
}

function rayItem(o, d, it) {
  if (it.t === 'ramp') {
    const [sx, sy, sz] = it.size.map((v) => v / 2), l = toLocal(o, d, it.c, it.yaw);
    const n = Math.hypot(sz, sy);   // the slope: through the centre, rising toward +z
    return rayPlanes(l.o, l.d, [[1, 0, 0, sx], [-1, 0, 0, sx], [0, -1, 0, sy], [0, 0, 1, sz], [0, sz / n, -sy / n, 0]]);
  }
  if (it.t === 'prism') {
    const l = toLocal(o, d, it.c, it.yaw), planes = [[0, 1, 0, it.h / 2], [0, -1, 0, it.h / 2]];
    const ap = it.r * Math.cos(Math.PI / it.sides);
    for (let i = 0; i < it.sides; i++) { const m = ((i + 1) * 2 * Math.PI) / it.sides; planes.push([Math.cos(m), 0, Math.sin(m), ap]); }
    return rayPlanes(l.o, l.d, planes);
  }
  return rayBox(o, d, itemAabb(it));
}

const volume = (b) => (b.max[0] - b.min[0]) * (b.max[1] - b.min[1]) * (b.max[2] - b.min[2]);

// the nearest item the ray enters (the origin inside an item counts as distance 0); ties go to the smaller one (a pad on a floor)
export function pickRay(doc, o, d, { skip = null, tMax = 1000 } = {}) {
  let best = null, bestVol = null;
  const test = (it) => {
    const t = rayItem(o, d, it);
    if (t === null || t > tMax) return;
    if (!best || t < best.t - 1e-6) { best = { id: it.id, t, item: it }; bestVol = null; }
    else if (Math.abs(t - best.t) <= 1e-6) {
      if (bestVol === null) bestVol = volume(itemAabb(best.item));
      const v = volume(itemAabb(it));
      if (v < bestVol) { best = { id: it.id, t, item: it }; bestVol = v; }
    }
  };
  for (const it of doc.items) if (it.id !== skip) test(it);
  if (skip !== 'start') test({ t: 'start', id: 'start', pos: doc.start.pos, yaw: doc.start.yaw });
  if (!best) return null;
  best.point = [o[0] + d[0] * best.t, o[1] + d[1] * best.t, o[2] + d[2] * best.t];
  return best;
}

// where the ray meets the solid level: the sim's own ray trace (so ramps are exact), else the y = 0 plane
export function surfaceHit(world, o, d, maxDist = 250) {
  if (world && world.cw) {
    const e = [o[0] + d[0] * maxDist, o[1] + d[1] * maxDist, o[2] + d[2] * maxDist];
    const tr = world.cw.traceRay(o, e);
    if (tr.fraction < 1 && !tr.startsolid) return { point: tr.endpos, normal: tr.normal, t: tr.fraction * maxDist };
  }
  const p = rayPlaneY(o, d, 0);
  if (!p) return null;
  const t = Math.hypot(p[0] - o[0], p[1] - o[1], p[2] - o[2]);
  return t <= maxDist ? { point: p, normal: [0, 1, 0], t } : null;
}

// ---------------------------------------------------------------- grid + placement
export const snap = (v, g) => Math.round(v / g) * g;
// the centre that puts the MIN corner of a box of `size` on the grid (near c)
export const snapMin = (c, size, g) => snap(c - size / 2, g) + size / 2;

const dominant = (n) => { const a = n.map(Math.abs); return a[1] >= a[0] && a[1] >= a[2] ? 1 : a[0] >= a[2] ? 0 : 2; };

// The position fields of a new item of palette entry `entry` placed on `hit` ({ point, normal }): boxes stand flush on the surface
// they were aimed at (`sink` ones hang below an upward surface) with their MIN corner on the grid; round things snap their centre.
// size (world axes, after the yaw) overrides the palette default.
export function placement(entry, hit, { grid = 0.5, size = null, yaw = 0, camYaw = 0 } = {}) {
  const e = typeof entry === 'string' ? paletteOf(entry) : entry;
  const p = hit.point, n = hit.normal || [0, 1, 0];
  const ax = dominant(n), sg = n[ax] >= 0 ? 1 : -1;
  const sn = (v) => r2(snap(v, grid));
  switch (e.t) {
    case 'pad': return { pos: [sn(p[0]), r2(p[1]), sn(p[2])] };
    case 'light': return { pos: [sn(p[0]), r2(p[1] + 2), sn(p[2])] };
    case 'start': return { pos: [sn(p[0]), r2(p[1]), sn(p[2])], yaw: r2(((camYaw / DEG) % 360 + 360) % 360) };
    case 'prism': {
      const h = size ? size[1] : e.h;
      return { c: [sn(p[0]), r2(ax === 1 ? p[1] + (sg * h) / 2 : p[1]), sn(p[2])] };
    }
    default: {
      const ws = size || (e.size ? worldSize({ t: e.t, size: e.size, yaw }) : [1, 1, 1]), h = ws.map((v) => v / 2);
      const c = [0, 0, 0];
      for (let a = 0; a < 3; a++) {
        if (a === ax) c[a] = p[a] + (e.sink && ax === 1 && sg > 0 ? -h[a] : sg * h[a]);
        else c[a] = snapMin(p[a], ws[a], grid);
      }
      const out = e.t === 'deco' ? { pos: c.map(r2) } : { c: c.map(r2) };   // (deco: pos = the centre of its bounds)
      if (e.t === 'cp') out.yaw = r2(((camYaw / DEG) % 360 + 360) % 360);
      return out;
    }
  }
}

// the pad's throw, as the sim flies it (pmove.padLaunch): up to the apex, then down to the target; n + 1 points
export function padArc(pad, n = 24) {
  const y0 = pad.pos[1], vy = Math.sqrt(2 * G * Math.max(0.01, pad.apex - y0));
  const T = vy / G + Math.sqrt((2 * Math.max(0.01, pad.apex - pad.target[1])) / G);
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const s = (i / n) * T;
    pts.push([pad.pos[0] + ((pad.target[0] - pad.pos[0]) * s) / T, y0 + vy * s - 0.5 * G * s * s, pad.pos[2] + ((pad.target[2] - pad.pos[2]) * s) / T]);
  }
  return pts;
}

// Where a test from a camera at `feet` can start: the spot itself, else lifted in 0.25 m steps up to 2 m while the hull is inside a solid
// or a kill volume; null when there is no free spot ("Innen nem lehet indulni").
export function findTestSpawn(world, feet) {
  const hitKill = (p) => world.map.kills.some((k) => !(p[0] - HULL_HX > k.max[0] || p[0] + HULL_HX < k.min[0] || p[1] > k.max[1] || p[1] + HULL_H < k.min[1] || p[2] - HULL_HX > k.max[2] || p[2] + HULL_HX < k.min[2]));
  for (let k = 0; k <= 8; k++) {
    const p = [feet[0], feet[1] + 0.02 + k * 0.25, feet[2]];
    if (!hullSolid(world.cw, p) && !hitKill(p)) return p;
  }
  return null;
}

