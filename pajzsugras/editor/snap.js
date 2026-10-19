// PAJZSUGRÁS map editor, sticking. Pure maths (no three, no DOM): node-testable. pick.js puts a new item on the world grid; this pass then
// corrects it against the item under the cursor (the target) and the items around it, so that edges and centres line up even when those are
// off the grid. The reach grows with the size of the thing being placed: placeReach (a new item) is 0.35 of its extent along that axis, at
// least the grid step and at most 2 m; moveReach (a drag, a resize arrow) is the weaker 0.2 of the extent, between half a grid step and 1 m.
// Without a candidate in reach the item snaps to a grid that starts at the target's own min corner (a drag: at the item's own min corner
// where the drag began).
//
//   aabbCache(doc, rev) -> [{ id, t, b }]                            the bounds of every item that has some (no pad / light / start), memoised per doc and rev
//   near(cache, box, sd, exclude) -> entries                         those whose bounds touch `box` inflated by sd (a number or one per axis; exclude: an id, a list or a Set of ids)
//   snapAxis(raw, h, edges, anchor, grid, centre, sd, floor) -> number   the centre along one axis (see below)
//   placeReach(grid, extent)  moveReach(grid, extent) -> metres      the reach of a placement / of a drag or a resize arrow along an axis
//   stickPlacement(ghost, hit, target, { cache, grid, lifted }) -> [x, y, z]   the ghost's new centre (the placed one when there is no target)
//   stickMove(item, rawC, startC, { cache, grid, exclude }) -> [x, y, z]   a dragged item's new centre: x and z only
import { itemAabb } from './model.js';
import { snap, dominant } from './pick.js';
import { HULL_HX } from '../sim/const.js';

const EPS = 1e-9;
const POINTS = new Set(['pad', 'light', 'start']);

let memo = null;
export function aabbCache(doc, rev) {
  if (rev !== undefined && memo && memo.doc === doc && memo.items === doc.items && memo.n === doc.items.length && memo.rev === rev) return memo.list;
  const list = doc.items.filter((it) => !POINTS.has(it.t)).map((it) => ({ id: it.id, t: it.t, b: itemAabb(it) }));
  memo = { doc, items: doc.items, n: doc.items.length, rev, list };
  return list;
}

export const placeReach = (grid, extent) => Math.max(grid, Math.min(2, 0.35 * extent));
export const moveReach = (grid, extent) => Math.max(grid / 2, Math.min(1, 0.2 * extent));

export function near(cache, box, sd, exclude = null) {
  const ex = exclude instanceof Set ? exclude : new Set(exclude == null ? [] : Array.isArray(exclude) ? exclude : [exclude]), s = Array.isArray(sd) ? sd : [sd, sd, sd];
  return cache.filter(({ id, b }) => !ex.has(id) && [0, 1, 2].every((a) => b.min[a] <= box.max[a] + s[a] && b.max[a] >= box.min[a] - s[a]));
}

// The centre along one axis for an item that reaches h[0] below and h[1] above its centre (a number: both). `raw` is where the cursor puts
// the centre; `edges` the extents on this axis of the target ({ lo, hi, tgt: true, c: its centre }) and of the neighbours ({ lo, hi }).
// Candidate centres, in this order of rank: the target aligned inside (its min / max edge met by ours), the neighbours flush outside (our edge
// on their edge, beside them) and aligned; with `centre` (round things: a pillar, a pad ...) also the target's centre. The nearest within
// sd (default half a grid step) wins. None: the grid that starts at `anchor` (the min corner, or with `centre` the centre itself).
// floor (the height of something set against a wall; a number, else null): no candidate puts our foot below that level (the foot of the target:
// the thing never sinks into what the target stands on), and a candidate that puts our foot on a level (the top of a neighbour, the foot of
// the target) also takes a cursor that is lower, down to the point where the foot would be sd below that level.
export function snapAxis(raw, h, edges, anchor, grid, centre = false, sd = grid / 2, floor = null) {
  const [hl, hh] = Array.isArray(h) ? h : [h, h];
  let best = null, bd = Infinity, bk = 9;
  const cand = (c, rank, foot = false) => {
    if (floor !== null && c - hl < floor - EPS) return;
    const d = Math.abs(raw - c);
    if (d > sd + EPS && !(floor !== null && foot && raw < c && c - raw <= hl + sd + EPS)) return;
    if (d < bd - EPS || (d <= bd + EPS && rank < bk)) { best = c; bd = d; bk = rank; }
  };
  for (const e of edges) {
    if (e.tgt) { cand(e.lo + hl, 0, true); cand(e.hi - hh, 0); if (centre && e.c !== undefined) cand(e.c, 0); }
    else { cand(e.hi + hl, 1, true); cand(e.lo - hh, 1); cand(e.lo + hl, 2, true); cand(e.hi - hh, 2); }
  }
  if (best !== null) return best;
  return centre ? anchor + snap(raw - anchor, grid) : anchor + snap(raw - hl - anchor, grid) + hl;
}

// how far an item reaches from its centre c (lo down, hi up, per axis; nothing for a point) and whether x and z snap its centre (round things)
function reach(it) {
  const c = it.c || it.pos;
  if (POINTS.has(it.t)) return { c, lo: [0, 0, 0], hi: [0, 0, 0], round: true };
  const b = itemAabb(it);
  return { c, lo: c.map((v, a) => v - b.min[a]), hi: c.map((v, a) => b.max[a] - v), round: it.t === 'prism' };
}
const around = (c, lo, hi) => ({ min: c.map((v, a) => v - lo[a]), max: c.map((v, a) => v + hi[a]) });

// The ghost (an item with its position from placement()) stuck to `target` (the solid item under the cursor, or null) and the items around:
// along every axis but the one of the surface normal (flush stays flush) the cursor's point is the raw centre, the target's min corner the
// anchor, and the reach along an axis is placeReach of the ghost's extent there. On a side face the height also rests on what is below (see
// snapAxis `floor`: the foot of the target; not while the ghost is lifted on purpose: ctx.lifted). On a slope the height of a box also meets the top /
// bottom level of the target (the foot of the item where the slope ends); a point (pad, light, start) is put on the slope plane.
export function stickPlacement(ghost, hit, target, ctx) {
  const { c, lo, hi, round } = reach(ghost), out = c.slice();
  if (!target) return out;
  const grid = ctx.grid, p = hit.point, n = hit.normal || [0, 1, 0], ax = dominant(n), point = POINTS.has(ghost.t);
  if (point && ax !== 1) return out;   // (a pad on a wall: the grid only)
  const T = itemAabb(target), tc = target.c || target.pos, raw = c.map((v, a) => (a === ax ? v : p[a]));
  const sds = lo.map((l, a) => placeReach(grid, l + hi[a]));
  const nb = near(ctx.cache, around(raw, lo, hi), sds, target.id);
  for (let a = 0; a < 3; a++) {
    if (a === ax) continue;
    const edges = [{ lo: T.min[a], hi: T.max[a], tgt: true, c: tc[a] }, ...nb.map((e) => ({ lo: e.b.min[a], hi: e.b.max[a] }))];
    out[a] = snapAxis(raw[a], [lo[a], hi[a]], edges, T.min[a], grid, round && a !== 1, sds[a], a === 1 && !ctx.lifted ? T.min[1] : null);
  }
  if (ax === 1 && Math.abs(n[1]) < 0.99) {
    const dy = c[1] - p[1];   // (the placed centre above the surface point: +h, -h for a sunk volume)
    if (point) {   // (on the slope exactly, where the spot ended up after the sticking along it; the start point also clear of it: the uphill side of the player's hull would be inside)
      out[1] = p[1] - (n[0] * (out[0] - p[0]) + n[2] * (out[2] - p[2])) / n[1] + dy;
      if (ghost.t === 'start') out[1] += (HULL_HX * (Math.abs(n[0]) + Math.abs(n[2]))) / n[1] + 0.01;
      return out;
    }
    let bd = Infinity;
    for (const lvl of [T.max[1], T.min[1]]) { const d = Math.abs(p[1] - lvl); if (d <= grid + EPS && d < bd) { bd = d; out[1] = lvl + dy; } }
  }
  return out;
}

// A dragged item's new centre: rawC is where the pointer would put it, startC its centre when the drag began (the grid starts at its own min
// corner there, so it moves in exact grid steps and keeps its offset); the items around (not `exclude`, the selection) pull its edges, within
// moveReach of its extent along that axis.
export function stickMove(item, rawC, startC, ctx) {
  const { lo, hi, round } = reach(item), grid = ctx.grid, out = rawC.slice();
  const sds = lo.map((l, a) => moveReach(grid, l + hi[a]));
  const nb = near(ctx.cache, around(rawC, lo, hi), sds, ctx.exclude);
  for (const a of [0, 2]) {
    const edges = nb.map((e) => ({ lo: e.b.min[a], hi: e.b.max[a] }));
    out[a] = snapAxis(rawC[a], [lo[a], hi[a]], edges, round ? startC[a] : startC[a] - lo[a], grid, round, sds[a]);
  }
  return out;
}
