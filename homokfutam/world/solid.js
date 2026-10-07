// The solid world at pod height (docs/visual-next-steps.md F2): what the pods collide with. A signed distance over the
// ground plane (metres: + outside the rock, - inside) and its outward normal, from two kinds of source (and, apart
// from them, the ride surfaces: rock the pods ride up instead, the canyon walls' low ends):
//  - walls (the canyon's, the arena's bays): a face offset from the track's centre line per metre of arc length and
//    side, solid from the face out to a back face, with end caps where a wall starts or stops;
//  - patches: every rock within reach of the track, a small grid of its own: its triangles clipped to the band of
//    heights a hovering pod occupies (BAND), rasterised, the areas they enclose filled, then a distance transform.
// Built at boot from the placement data and the base rock models, never from what a preset draws, so the physics is
// the same on every preset and every machine.

export const BAND = [0.6, 3.2];   // metres above the ground: the heights a hovering pod's hull occupies
export const MAT = { none: 0, canyon: 1, arena: 2, rock: 3, ramp: 4 };      // (ramp: a canyon wall's low end, laid back)
const REACH = 6;                  // metres of distance kept round each patch's rock; beyond it a patch reads REACH
const HASH = 32;                  // patch lookup cells (m)
const NONE = 1e4;                 // "no wall" face offset (finite, so it interpolates)
const CAP = 24;                   // metres past a wall's end over which its end cap still counts

export function createSolid(TR, groundAt) {
  const n = Math.ceil(TR.L), ds = TR.L / n;
  const side = () => ({ face: new Float32Array(n).fill(NONE), back: new Float32Array(n).fill(NONE), mat: new Uint8Array(n), fc: null, bc: null, ed: null });
  const walls = { [-1]: side(), [1]: side() };
  const patches = [], hash = new Map();
  const key = (kx, kz) => (kx + 4096) * 8192 + (kz + 4096);
  const stats = { patches: 0, cells: 0, tris: 0, ms: 0 };

  // ---- walls -------------------------------------------------------------------------------------------------------
  // face(s): offset of the solid face from the centre line at arc length s (m), back(s): where the solid ends again
  function setWall(sd, s, face, back, mat) {
    const k = ((Math.round(s / ds) % n) + n) % n, W = walls[sd];
    if (face < W.face[k]) { W.face[k] = face; W.back[k] = back; W.mat[k] = mat; }
  }
  // once all walls are in: clamp the face past each end to the end's value, and the signed distance along the track
  // to the nearest end (+ inside a wall's run, - outside it), both circular
  function finishWalls() {
    for (const sd of [-1, 1]) {
      const W = walls[sd], st = new Uint8Array(n);
      for (let k = 0; k < n; k++) st[k] = W.face[k] < NONE ? 1 : 0;
      const ed = new Float32Array(n), fc = new Float32Array(n).fill(NONE), bc = new Float32Array(n).fill(NONE);
      // samples to the nearest sample of the other state, and to the nearest wall sample; two laps round the loop
      // each way, so the first lap seeds the wrap
      const dist = new Float32Array(n).fill(1e9), nearIn = new Int32Array(n).fill(-1), gapIn = new Float32Array(n).fill(1e9);
      for (const dir of [1, -1]) {
        let d = 1e9, last = -1;
        for (let it = 0; it < 2 * n; it++) {
          const k = dir > 0 ? it % n : n - 1 - (it % n), pk = (k - dir + n) % n;
          d = st[k] !== st[pk] ? 1 : d + 1;
          if (st[k]) last = k;
          if (it < n) continue;
          if (d < dist[k]) dist[k] = d;
          if (!st[k] && last >= 0) {
            const gap = dir > 0 ? (k - last + n) % n : (last - k + n) % n;
            if (gap < gapIn[k]) { gapIn[k] = gap; nearIn[k] = last; }
          }
        }
      }
      for (let k = 0; k < n; k++) {
        if (st[k]) { ed[k] = (Math.min(dist[k], 1e6) - 0.5) * ds; fc[k] = W.face[k]; bc[k] = W.back[k]; }
        else {
          ed[k] = -(Math.min(dist[k], 1e6) - 0.5) * ds;
          if (nearIn[k] >= 0 && gapIn[k] * ds < CAP) { const j = nearIn[k]; fc[k] = W.face[j]; bc[k] = W.back[j]; W.mat[k] = W.mat[j]; }
        }
      }
      W.fc = fc; W.bc = bc; W.ed = ed;
    }
  }

  // the track frame at a point: arc length s, lateral d (+ = right), tangent; from a hint sample (the pod's)
  const F = { s: 0, d: 0, tx: 0, tz: 1, i: 0 };
  function frame(x, z, hint) {
    const idx = TR.idx;
    let best = hint | 0, bd = 1e18;
    for (let k = best - 6; k <= best + 6; k++) {
      const i = idx(k), d = (TR.px[i] - x) ** 2 + (TR.pz[i] - z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    let i0 = best, i1 = idx(best + 1);
    let ax = TR.px[i0], az = TR.pz[i0], bx = TR.px[i1] - ax, bz = TR.pz[i1] - az;
    let t = ((x - ax) * bx + (z - az) * bz) / (bx * bx + bz * bz);
    if (t < 0) {
      i1 = i0; i0 = idx(best - 1);
      ax = TR.px[i0]; az = TR.pz[i0]; bx = TR.px[i1] - ax; bz = TR.pz[i1] - az;
      t = ((x - ax) * bx + (z - az) * bz) / (bx * bx + bz * bz);
    }
    t = Math.min(1, Math.max(0, t));
    const segL = Math.hypot(bx, bz), tx = bx / segL, tz = bz / segL;
    F.s = ((TR.s[i0] + t * segL) % TR.L + TR.L) % TR.L;
    F.d = (x - (ax + bx * t)) * -tz + (z - (az + bz * t)) * tx;
    F.tx = tx; F.tz = tz; F.i = best; F.far = bd > 200 * 200;    // (far: the hint was not near the point)
    return F;
  }
  const lerpArr = (a, k0, k1, t) => a[k0] + (a[k1] - a[k0]) * t;

  // walls at a point: the signed distance, its gradient (into out), the material
  function wallAt(x, z, hint, out) {
    const f = frame(x, z, hint);
    const sd = f.d >= 0 ? 1 : -1, W = walls[sd], ad = Math.abs(f.d);
    if (!W.fc || f.far) return NONE;
    const u = f.s / ds, k0 = Math.floor(u) % n, k1 = (k0 + 1) % n, t = u - Math.floor(u);
    const face = lerpArr(W.fc, k0, k1, t);
    if (face >= NONE * 0.5) return NONE;
    const back = lerpArr(W.bc, k0, k1, t), ed = lerpArr(W.ed, k0, k1, t);
    // the solid: |d| between face and back, inside the run: the intersection of three half-planes
    const a = face - ad, b = ad - back, c = -ed;
    let v = a, gs = (W.fc[k1] - W.fc[k0]) / ds, gd = -sd;              // d/ds and d/dd of the winner (in the track frame)
    if (b > v) { v = b; gs = -(W.bc[k1] - W.bc[k0]) / ds; gd = sd; }
    if (c > v) { v = c; gs = -(W.ed[k1] - W.ed[k0]) / ds; gd = 0; }
    // track frame -> world: s along (tx, tz), d along (-tz, tx)
    let gx = gs * f.tx + gd * -f.tz, gz = gs * f.tz + gd * f.tx;
    const gl = Math.hypot(gx, gz) || 1;
    out.nx = gx / gl; out.nz = gz / gl; out.mat = W.mat[t < 0.5 ? k0 : k1];
    return v;
  }

  // ---- patches -----------------------------------------------------------------------------------------------------
  // one rock: its triangles (world space after matrix) within the band above the ground, rasterised and filled
  const _p = new Float32Array(18), _q = new Float32Array(18);
  function addMesh(geo, matrix, mat = MAT.rock) {
    const P = geo.attributes.position, nv = P.count, m = matrix.elements;
    const wp = new Float32Array(nv * 3);
    let ymin = Infinity, ymax = -Infinity, cx = 0, cz = 0;
    for (let v = 0; v < nv; v++) {
      const x = P.getX(v), y = P.getY(v), z = P.getZ(v);
      const X = m[0] * x + m[4] * y + m[8] * z + m[12], Y = m[1] * x + m[5] * y + m[9] * z + m[13], Z = m[2] * x + m[6] * y + m[10] * z + m[14];
      wp[v * 3] = X; wp[v * 3 + 1] = Y; wp[v * 3 + 2] = Z;
      if (Y < ymin) ymin = Y; if (Y > ymax) ymax = Y;
      cx += X; cz += Z;
    }
    cx /= nv; cz /= nv;
    const g0 = groundAt(cx, cz);
    if (ymin > g0 + BAND[1] + 20 || ymax < g0 + BAND[0] - 20) return null;
    const index = geo.index ? geo.index.array : null, nt = index ? index.length / 3 : nv / 3;
    // the triangles that may cross the band (the ground can differ from g0 by up to ~20 m under a big rock)
    const near = [];
    let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
    for (let t = 0; t < nt; t++) {
      const a = index ? index[t * 3] : t * 3, b = index ? index[t * 3 + 1] : t * 3 + 1, c = index ? index[t * 3 + 2] : t * 3 + 2;
      const ya = wp[a * 3 + 1], yb = wp[b * 3 + 1], yc = wp[c * 3 + 1];
      if (Math.min(ya, yb, yc) > g0 + BAND[1] + 20 || Math.max(ya, yb, yc) < g0 + BAND[0] - 20) continue;
      near.push(a, b, c);
      for (const v of [a, b, c]) {
        const X = wp[v * 3], Z = wp[v * 3 + 2];
        if (X < bx0) bx0 = X; if (X > bx1) bx1 = X; if (Z < bz0) bz0 = Z; if (Z > bz1) bz1 = Z;
      }
    }
    if (!near.length) return null;
    // the ground under them, on a 4 m lattice
    const G = 4, gw = Math.ceil((bx1 - bx0) / G) + 2, gh = Math.ceil((bz1 - bz0) / G) + 2, gy = new Float32Array(gw * gh);
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) gy[j * gw + i] = groundAt(bx0 + i * G, bz0 + j * G);
    const groundL = (x, z) => {
      const u = Math.min(gw - 1.001, Math.max(0, (x - bx0) / G)), w = Math.min(gh - 1.001, Math.max(0, (z - bz0) / G));
      const i = Math.floor(u), j = Math.floor(w), fu = u - i, fw = w - j, o = j * gw + i;
      return (gy[o] * (1 - fu) + gy[o + 1] * fu) * (1 - fw) + (gy[o + gw] * (1 - fu) + gy[o + gw + 1] * fu) * fw;
    };
    // clip each triangle to the band (Sutherland-Hodgman against y >= lo and y <= hi), keep the XZ polygons
    const polys = [];
    let px0 = Infinity, px1 = -Infinity, pz0 = Infinity, pz1 = -Infinity;
    const clip = (src, cnt, dst, yk, keepAbove) => {
      let o = 0;
      for (let i = 0; i < cnt; i++) {
        const j = (i + 1) % cnt, ay = src[i * 3 + 1], by = src[j * 3 + 1];
        const ain = keepAbove ? ay >= yk : ay <= yk, bin = keepAbove ? by >= yk : by <= yk;
        if (ain) { dst[o * 3] = src[i * 3]; dst[o * 3 + 1] = ay; dst[o * 3 + 2] = src[i * 3 + 2]; o++; }
        if (ain !== bin) {
          const t = (yk - ay) / (by - ay);
          dst[o * 3] = src[i * 3] + (src[j * 3] - src[i * 3]) * t; dst[o * 3 + 1] = yk; dst[o * 3 + 2] = src[i * 3 + 2] + (src[j * 3 + 2] - src[i * 3 + 2]) * t; o++;
        }
      }
      return o;
    };
    for (let t = 0; t < near.length; t += 3) {
      for (let k = 0; k < 3; k++) { const v = near[t + k]; _p[k * 3] = wp[v * 3]; _p[k * 3 + 1] = wp[v * 3 + 1]; _p[k * 3 + 2] = wp[v * 3 + 2]; }
      const g = groundL((_p[0] + _p[3] + _p[6]) / 3, (_p[2] + _p[5] + _p[8]) / 3);
      let c = clip(_p, 3, _q, g + BAND[0], true);
      if (c < 2) continue;
      c = clip(_q, c, _p, g + BAND[1], false);
      if (c < 2) continue;
      const poly = new Float32Array(c * 2);
      for (let k = 0; k < c; k++) {
        const X = _p[k * 3], Z = _p[k * 3 + 2];
        poly[k * 2] = X; poly[k * 2 + 1] = Z;
        if (X < px0) px0 = X; if (X > px1) px1 = X; if (Z < pz0) pz0 = Z; if (Z > pz1) pz1 = Z;
      }
      polys.push(poly);
    }
    stats.tris += near.length / 3;
    if (!polys.length) return null;
    // the patch: the footprint plus REACH all round
    const ext = Math.max(px1 - px0, pz1 - pz0), cell = ext < 14 ? 0.25 : 0.5;
    const x0 = px0 - REACH - cell, z0 = pz0 - REACH - cell;
    const w = Math.ceil((px1 - px0 + 2 * REACH) / cell) + 3, h = Math.ceil((pz1 - pz0 + 2 * REACH) / cell) + 3;
    const solid = new Uint8Array(w * h);
    for (const poly of polys) fillConvex(poly, solid, w, h, x0, z0, cell);
    fillEnclosed(solid, w, h);
    const sdf = distanceField(solid, w, h, cell);
    const p = { x0, z0, w, h, cell, sdf, mat, x1: x0 + w * cell, z1: z0 + h * cell };
    patches.push(p);
    for (let kz = Math.floor(z0 / HASH); kz <= Math.floor(p.z1 / HASH); kz++) for (let kx = Math.floor(x0 / HASH); kx <= Math.floor(p.x1 / HASH); kx++) {
      const kk = key(kx, kz);
      let list = hash.get(kk); if (!list) hash.set(kk, (list = [])); list.push(p);
    }
    stats.patches++; stats.cells += w * h;
    return p;
  }

  function patchAt(p, x, z, out) {
    const u = (x - p.x0) / p.cell - 0.5, w = (z - p.z0) / p.cell - 0.5;
    if (u < 0 || w < 0 || u >= p.w - 1 || w >= p.h - 1) return NONE;
    const i = Math.floor(u), j = Math.floor(w), fu = u - i, fw = w - j, o = j * p.w + i, S = p.sdf;
    const a = S[o], b = S[o + 1], c = S[o + p.w], d = S[o + p.w + 1];
    const v = (a * (1 - fu) + b * fu) * (1 - fw) + (c * (1 - fu) + d * fu) * fw;
    if (v >= REACH - 0.01) return NONE;
    let gx = ((b - a) * (1 - fw) + (d - c) * fw), gz = ((c - a) * (1 - fu) + (d - b) * fu);
    const gl = Math.hypot(gx, gz);
    if (gl < 1e-6) { gx = 0; gz = 0; } else { gx /= gl; gz /= gl; }
    out.nx = gx; out.nz = gz; out.mat = p.mat;
    return v;
  }

  // the solid at a point: out.d (signed distance, m), out.nx/nz (outward normal), out.mat; hint: a track sample near it
  const _o = { nx: 0, nz: 0, mat: 0 };
  function query(x, z, hint, out) {
    let best = wallAt(x, z, hint, out);
    if (best >= NONE) { out.nx = 0; out.nz = 0; out.mat = 0; }
    const list = hash.get(key(Math.floor(x / HASH), Math.floor(z / HASH)));
    if (list) for (const p of list) {
      const v = patchAt(p, x, z, _o);
      if (v < best) { best = v; out.nx = _o.nx; out.nz = _o.nz; out.mat = _o.mat; }
    }
    out.d = best;
    return best;
  }

  // ---- ride surfaces ------------------------------------------------------------------------------------------------
  // Rock the pods ride on instead of passing through (the canyon walls: their low ends laid back into ramps, the rim
  // behind the face): per metre of arc length and side, a cross-section of lateral offsets o and world heights y,
  // outwards from the foot. rideAt(): its height at a point (-Infinity where there is none; hard: only where it is
  // also what the pods collide with, the walls' ends, instead of a wall in the field); quickly nothing away from the
  // track samples that have one near.
  const rides = { [-1]: new Map(), [1]: new Map() }, nearRide = new Uint8Array(TR.N), nearHard = new Uint8Array(TR.N);
  function addRide(sd, s, o, y, hard = false) {
    const k = ((Math.round(s / ds) % n) + n) % n;
    rides[sd].set(k, { o, y, hard });
    // (the track samples within ~40 m of it)
    let lo = 0, hi = TR.N;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (TR.s[m] <= k * ds) lo = m; else hi = m; }
    for (let q = -10; q <= 10; q++) { nearRide[TR.idx(lo + q)] = 1; if (hard) nearHard[TR.idx(lo + q)] = 1; }
  }
  const crossAt = (c, ad, hard) => {
    if (!c || ad < c.o[0] || (hard && !c.hard)) return -Infinity;
    let h = -Infinity;
    for (let i = 0; i < c.o.length - 1; i++) {
      const a = c.o[i], b = c.o[i + 1];
      if (ad < Math.min(a, b) || ad > Math.max(a, b)) continue;
      const t = b === a ? 1 : (ad - a) / (b - a);
      h = Math.max(h, c.y[i] + (c.y[i + 1] - c.y[i]) * t);
    }
    return h;
  };
  function rideAt(x, z, hint, hard = false) {
    if (!(hard ? nearHard : nearRide)[(hint | 0) % TR.N]) return -Infinity;
    const f = frame(x, z, hint);
    if (f.far) return -Infinity;
    const R = rides[f.d >= 0 ? 1 : -1], ad = Math.abs(f.d);
    const u = f.s / ds, k0 = Math.floor(u) % n, t = u - Math.floor(u);
    const a = crossAt(R.get(k0), ad, hard), b = crossAt(R.get((k0 + 1) % n), ad, hard);
    if (a === -Infinity) return b;
    if (b === -Infinity) return a;
    return a + (b - a) * t;
  }
  // the ride surface's slope at a point (out.x, out.z: rise per metre along world x and z); false where there is none
  function rideSlope(x, z, hint, out) {
    const e = 0.5, px = rideAt(x + e, z, hint), mx = rideAt(x - e, z, hint), pz = rideAt(x, z + e, hint), mz = rideAt(x, z - e, hint);
    if (px === -Infinity || mx === -Infinity || pz === -Infinity || mz === -Infinity) return false;
    out.x = (px - mx) / (2 * e); out.z = (pz - mz) / (2 * e);
    return true;
  }

  // is any rock's patch within R of the point (a patch reads only up to REACH, so a far query cannot rule it out)
  function near(x, z, R) {
    for (let kz = Math.floor((z - R) / HASH); kz <= Math.floor((z + R) / HASH); kz++) for (let kx = Math.floor((x - R) / HASH); kx <= Math.floor((x + R) / HASH); kx++) {
      const list = hash.get(key(kx, kz));
      if (list) for (const p of list) if (x + R > p.x0 && x - R < p.x1 && z + R > p.z0 && z - R < p.z1) return true;
    }
    return false;
  }

  const nearHardAt = (hint) => !!nearHard[(hint | 0) % TR.N];
  return { setWall, finishWalls, addMesh, addRide, rideAt, rideSlope, nearHardAt, query, near, frame, walls, patches, rides, stats, ds, n, REACH, NONE };
}

// conservative fill of a convex polygon (XZ pairs) into the grid: every cell it touches
function fillConvex(poly, solid, w, h, x0, z0, cell) {
  const m = poly.length / 2;
  let zmin = Infinity, zmax = -Infinity;
  for (let k = 0; k < m; k++) { const z = poly[k * 2 + 1]; if (z < zmin) zmin = z; if (z > zmax) zmax = z; }
  const j0 = Math.max(0, Math.floor((zmin - z0) / cell)), j1 = Math.min(h - 1, Math.floor((zmax - z0) / cell));
  for (let j = j0; j <= j1; j++) {
    // the polygon's x extent within the row's strip [za, zb]
    const za = Math.max(zmin, z0 + j * cell), zb = Math.min(zmax, z0 + (j + 1) * cell);
    let xa = Infinity, xb = -Infinity;
    for (let k = 0; k < m; k++) {
      const ax = poly[k * 2], az = poly[k * 2 + 1], q = (k + 1) % m, bx = poly[q * 2], bz = poly[q * 2 + 1];
      if (az >= za && az <= zb) { if (ax < xa) xa = ax; if (ax > xb) xb = ax; }
      for (const zz of [za, zb]) {
        if ((az - zz) * (bz - zz) < 0) { const x = ax + (bx - ax) * (zz - az) / (bz - az); if (x < xa) xa = x; if (x > xb) xb = x; }
      }
    }
    if (xa > xb) continue;
    const i0 = Math.max(0, Math.floor((xa - x0) / cell)), i1 = Math.min(w - 1, Math.floor((xb - x0) / cell));
    for (let i = i0; i <= i1; i++) solid[j * w + i] = 1;
  }
}

// free cells that cannot be reached from the patch's border are inside the rock
function fillEnclosed(solid, w, h) {
  const seen = new Uint8Array(w * h), stack = new Int32Array(w * h);
  let sp = 0;
  const push = (o) => { if (!solid[o] && !seen[o]) { seen[o] = 1; stack[sp++] = o; } };
  for (let i = 0; i < w; i++) { push(i); push((h - 1) * w + i); }
  for (let j = 0; j < h; j++) { push(j * w); push(j * w + w - 1); }
  while (sp > 0) {
    const o = stack[--sp], i = o % w, j = (o - i) / w;
    if (i > 0) push(o - 1); if (i < w - 1) push(o + 1); if (j > 0) push(o - w); if (j < h - 1) push(o + w);
  }
  for (let o = 0; o < w * h; o++) if (!solid[o] && !seen[o]) solid[o] = 1;
}

// signed distance (m) from a solid mask: Felzenszwalb-Huttenlocher squared distance transform, both ways
function distanceField(solid, w, h, cell) {
  const INF = 1e20, N = w * h;
  const out = new Float32Array(N), ins = new Float32Array(N);
  for (let o = 0; o < N; o++) { out[o] = solid[o] ? 0 : INF; ins[o] = solid[o] ? INF : 0; }
  edt2(out, w, h); edt2(ins, w, h);
  const sdf = new Float32Array(N);
  for (let o = 0; o < N; o++) sdf[o] = solid[o] ? -(Math.sqrt(ins[o]) - 0.5) * cell : (Math.sqrt(out[o]) - 0.5) * cell;
  return sdf;
}
function edt2(g, w, h) {
  const n = Math.max(w, h), f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let i = 0; i < w; i++) {
    for (let j = 0; j < h; j++) f[j] = g[j * w + i];
    edt1(f, h, d, v, z);
    for (let j = 0; j < h; j++) g[j * w + i] = d[j];
  }
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) f[i] = g[j * w + i];
    edt1(f, w, d, v, z);
    for (let i = 0; i < w; i++) g[j * w + i] = d[i];
  }
}
function edt1(f, n, d, v, z) {
  let k = 0;
  v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; }
}
