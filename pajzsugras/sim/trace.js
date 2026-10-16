// Swept box (and ray) traces against convex brushes: Quake's CM_ClipBoxToBrush on the plane sets from brush.js, so a
// box sweep is exact (no tunnelling at any speed), with DIST_EPS pull-back from surfaces. Static brushes live in a 3D
// grid (8 m cells, swept AABB walk, stamp dedupe); movers are always tested, in their local frame (start/end minus the
// mover's current offset, which World keeps up to date in mover.offset).
import { DIST_EPS } from './const.js';

const CELL = 8;
let STAMP = 0;   // global, so that several CollisionWorlds can share brush objects
const key = (cx, cy, cz) => ((cx + 512) * 1024 + (cy + 512)) * 1024 + (cz + 512);

export class CollisionWorld {
  // brushes: static brushes (from makeBrush); movers: [{ brushes: [brush], offset: [x, y, z] }]
  constructor(brushes, movers = []) {
    this.brushes = brushes;
    this.movers = movers;
    this.grid = new Map();
    for (const b of brushes) {
      const x0 = Math.floor(b.min[0] / CELL), x1 = Math.floor(b.max[0] / CELL);
      const y0 = Math.floor(b.min[1] / CELL), y1 = Math.floor(b.max[1] / CELL);
      const z0 = Math.floor(b.min[2] / CELL), z1 = Math.floor(b.max[2] / CELL);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
        const k = key(x, y, z);
        let cell = this.grid.get(k);
        if (!cell) this.grid.set(k, (cell = []));
        cell.push(b);
      }
    }
  }

  // half: [hx, hy, hz] half extents of the box centred on start/end (null/zeros = ray).
  // skipMover: index of a mover to ignore (the one carrying/pushing the caller), -1 none.
  // -> { fraction, endpos, normal, startsolid, allsolid, brush, mover }  (mover = -1 for static geometry)
  traceBox(start, end, half, skipMover = -1) {
    const hx = half ? half[0] : 0, hy = half ? half[1] : 0, hz = half ? half[2] : 0;
    const tr = { fraction: 1, endpos: null, normal: [0, 0, 0], startsolid: false, allsolid: false, brush: null, mover: -1 };
    const sx = start[0], sy = start[1], sz = start[2], ex = end[0], ey = end[1], ez = end[2];
    const lx = Math.min(sx, ex) - hx - 0.01, ly = Math.min(sy, ey) - hy - 0.01, lz = Math.min(sz, ez) - hz - 0.01;
    const ux = Math.max(sx, ex) + hx + 0.01, uy = Math.max(sy, ey) + hy + 0.01, uz = Math.max(sz, ez) + hz + 0.01;
    const stamp = ++STAMP;
    const x0 = Math.floor(lx / CELL), x1 = Math.floor(ux / CELL);
    const y0 = Math.floor(ly / CELL), y1 = Math.floor(uy / CELL);
    const z0 = Math.floor(lz / CELL), z1 = Math.floor(uz / CELL);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
      const cell = this.grid.get(key(x, y, z));
      if (!cell) continue;
      for (let i = 0; i < cell.length; i++) {
        const b = cell[i];
        if (b.stamp === stamp) continue;
        b.stamp = stamp;
        if (b.min[0] > ux || b.max[0] < lx || b.min[1] > uy || b.max[1] < ly || b.min[2] > uz || b.max[2] < lz) continue;
        clipBrush(b, 0, 0, 0, sx, sy, sz, ex, ey, ez, hx, hy, hz, tr, -1);
        if (tr.allsolid) { tr.fraction = 0; tr.endpos = [sx, sy, sz]; return tr; }
      }
    }
    for (let m = 0; m < this.movers.length; m++) {
      if (m === skipMover) continue;
      const mv = this.movers[m], o = mv.offset;
      for (const b of mv.brushes) {
        if (b.min[0] + o[0] > ux || b.max[0] + o[0] < lx || b.min[1] + o[1] > uy || b.max[1] + o[1] < ly || b.min[2] + o[2] > uz || b.max[2] + o[2] < lz) continue;
        clipBrush(b, o[0], o[1], o[2], sx, sy, sz, ex, ey, ez, hx, hy, hz, tr, m);
        if (tr.allsolid) { tr.fraction = 0; tr.endpos = [sx, sy, sz]; return tr; }
      }
    }
    const f = tr.fraction;
    tr.endpos = [sx + (ex - sx) * f, sy + (ey - sy) * f, sz + (ez - sz) * f];
    return tr;
  }

  traceRay(start, end, skipMover = -1) { return this.traceBox(start, end, null, skipMover); }

  // is the box centred at pos overlapping anything?
  testSolid(pos, half, skipMover = -1) { return this.traceBox(pos, pos, half, skipMover).startsolid; }
}

function clipBrush(b, ox, oy, oz, sx, sy, sz, ex, ey, ez, hx, hy, hz, tr, mover) {
  sx -= ox; sy -= oy; sz -= oz; ex -= ox; ey -= oy; ez -= oz;
  const clip = b.clip, n = b.nclip;
  let enter = -1, leave = 1, getout = false, startout = false, plane = -1;
  for (let i = 0; i < n; i++) {
    const j = i * 4, nx = clip[j], ny = clip[j + 1], nz = clip[j + 2];
    const dist = clip[j + 3] + (nx < 0 ? -nx : nx) * hx + (ny < 0 ? -ny : ny) * hy + (nz < 0 ? -nz : nz) * hz;
    const d1 = nx * sx + ny * sy + nz * sz - dist;
    const d2 = nx * ex + ny * ey + nz * ez - dist;
    if (d2 > 0) getout = true;
    if (d1 > 0) startout = true;
    if (d1 > 0 && (d2 >= DIST_EPS || d2 >= d1)) return;   // completely in front of this plane
    if (d1 <= 0 && d2 <= 0) continue;                      // completely behind it
    if (d1 > d2) {                                         // entering
      const f = (d1 - DIST_EPS) / (d1 - d2);
      if (f > enter) { enter = f; plane = i; }
    } else {                                               // leaving
      const f = (d1 + DIST_EPS) / (d1 - d2);
      if (f < leave) leave = f;
    }
  }
  if (!startout) {
    tr.startsolid = true;
    if (!getout) tr.allsolid = true;
    return;
  }
  if (enter < leave && enter > -1 && enter < tr.fraction) {
    tr.fraction = enter < 0 ? 0 : enter;
    const j = plane * 4;
    tr.normal = [clip[j], clip[j + 1], clip[j + 2]];
    tr.brush = b;
    tr.mover = mover;
  }
}
