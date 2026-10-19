// PAJZSUGRÁS map editor, the resize handles: an arrow on each face of the one selected item. Pure maths (no three, no DOM): node-testable.
//
//   handlesFor(item) -> [{ axis, dir, kind, face }]            kind 'size' (a box face), 'h' (a pillar's top / bottom), 'r' (a pillar's side: the radius)
//   handleSeg(h, cam, vfovDeg) -> { base, tip, len }           the arrow in the world, a constant size on the screen (cam = { pos, yaw, pitch (radians) })
//   hitHandle(list, cam, ndc, vfovDeg, aspect, wPx, hPx)       the handle whose arrow is nearest to the pointer (within 12 px), else null
//   axisParam(ray, P, axis) -> s | null                        where the pointer's ray comes closest to the line P + axis * s (null: looking along the line)
//   extentOf(item, axis)  resizePatch(item, axis, dir, extent) -> the patch that gives the item that length along the world axis, the face on
//                                                              the `dir` side moving (a pillar's radius: both sides), or null when it cannot be resized
import { itemAabb, LIM, r2 } from './model.js';
import { worldToNdc } from './pick.js';

const DEG = Math.PI / 180;
const HIT_PX = 12, MIN_PX = 6;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function handlesFor(it) {
  if (!it) return [];
  switch (it.t) {
    case 'block': case 'ramp': case 'deco': if ((it.yaw || 0) % 90 !== 0) return []; break;   // (a free-yaw deco has no world-axis faces)
    case 'kill': case 'cp': case 'finish': case 'prism': break;
    default: return [];
  }
  const b = itemAabb(it), c = [0, 1, 2].map((a) => (b.min[a] + b.max[a]) / 2), out = [];
  for (let axis = 0; axis < 3; axis++) {
    for (const dir of [-1, 1]) {
      const face = c.slice();
      face[axis] = dir > 0 ? b.max[axis] : b.min[axis];
      out.push({ axis, dir, kind: it.t !== 'prism' ? 'size' : axis === 1 ? 'h' : 'r', face });
    }
  }
  return out;
}

export function handleSeg(h, cam, vfovDeg) {
  const dist = Math.hypot(h.face[0] - cam.pos[0], h.face[1] - cam.pos[1], h.face[2] - cam.pos[2]);
  const len = dist * Math.tan((vfovDeg * DEG) / 2) * 0.14;
  const base = h.face.slice(), tip = h.face.slice();
  base[h.axis] += h.dir * 0.15 * len;
  tip[h.axis] = base[h.axis] + h.dir * len;
  return { base, tip, len };
}

const distToSeg = (p, a, b) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2, 0, 1) : 0;
  return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t));
};

export function hitHandle(list, cam, ndc, vfovDeg, aspect, wPx, hPx) {
  const px = (n) => [((n[0] + 1) / 2) * wPx, ((1 - n[1]) / 2) * hPx], m = px(ndc);
  let best = null, bd = Infinity;
  for (const h of list) {
    const s = handleSeg(h, cam, vfovDeg), a = worldToNdc(cam, s.base, vfovDeg, aspect), b = worldToNdc(cam, s.tip, vfovDeg, aspect);
    if (!a || !b) continue;   // (behind the camera)
    const A = px(a), B = px(b);
    if (Math.hypot(B[0] - A[0], B[1] - A[1]) < MIN_PX) continue;   // (seen end on: too small to grab)
    const d = distToSeg(m, A, B);
    if (d <= HIT_PX && d < bd) { bd = d; best = h; }
  }
  return best;
}

// the closest point of the ray (o, d unit) and the line P + axis * s (axis unit): s
export function axisParam(ray, P, axis) {
  const d = ray.d, b = d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2];
  if (Math.abs(b) > 0.995) return null;
  const w = [ray.o[0] - P[0], ray.o[1] - P[1], ray.o[2] - P[2]];
  const dw = d[0] * w[0] + d[1] * w[1] + d[2] * w[2], aw = axis[0] * w[0] + axis[1] * w[1] + axis[2] * w[2];
  return (aw - b * dw) / (1 - b * b);
}

// which of the item's own size entries lies along the world axis (a block turned by 90 / 270 swaps x and z)
const localAxis = (it, axis) => (axis === 1 ? 1 : (it.t === 'block' || it.t === 'ramp' || it.t === 'deco') && Math.round((it.yaw || 0) / 90) % 2 === 1 ? 2 - axis : axis);

// the item's length along a world axis (a pillar: its height, or the width of its bounds)
export function extentOf(it, axis) {
  if (it.t === 'prism') { if (axis === 1) return it.h; const b = itemAabb(it); return b.max[axis] - b.min[axis]; }
  return it.size ? it.size[localAxis(it, axis)] : 0;
}

export function resizePatch(it, axis, dir, extent) {
  if (it.t === 'prism') {
    if (axis === 1) {
      const h = clamp(r2(extent), LIM.sizeMin, LIM.sizeMax), c = it.c.slice();
      c[1] = r2(c[1] + (dir * (h - it.h)) / 2);
      return { h, c };
    }
    const cur = extentOf(it, axis);
    return { r: clamp(r2((it.r * extent) / cur), LIM.sizeMin, LIM.sizeMax / 2) };   // (the radius scales about the centre)
  }
  if (!it.size) return null;
  const la = localAxis(it, axis), nv = clamp(r2(extent), LIM.sizeMin, LIM.sizeMax), size = it.size.slice();
  size[la] = nv;
  const k = it.c ? 'c' : 'pos', c = it[k].slice();
  c[axis] = r2(c[axis] + (dir * (nv - it.size[la])) / 2);
  return { size, [k]: c };
}
