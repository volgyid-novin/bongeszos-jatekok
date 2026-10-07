// ============================================================
//  A bounding volume hierarchy over triangles, for the light bake (gfx/gibake.js, docs D4): binned
//  SAH build, closest-hit and any-hit traversal with an explicit stack. The layout follows
//  lisyarus/webgpu-raytracer (MIT): a node is its box plus one word that is either the first child
//  (inner node, children adjacent) or the first triangle (leaf), and a triangle count (0 = inner).
// ============================================================
const BINS = 16, LEAF = 4;

// tris: Float32Array, 9 floats per triangle (world space)
export function buildBVH(tris) {
  const n = tris.length / 9;
  const cx = new Float32Array(n), cy = new Float32Array(n), cz = new Float32Array(n);
  const bmin = new Float32Array(n * 3), bmax = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const o = i * 9;
    for (let a = 0; a < 3; a++) {
      const v0 = tris[o + a], v1 = tris[o + 3 + a], v2 = tris[o + 6 + a];
      bmin[i * 3 + a] = Math.min(v0, v1, v2); bmax[i * 3 + a] = Math.max(v0, v1, v2);
    }
    cx[i] = (bmin[i * 3] + bmax[i * 3]) * 0.5; cy[i] = (bmin[i * 3 + 1] + bmax[i * 3 + 1]) * 0.5; cz[i] = (bmin[i * 3 + 2] + bmax[i * 3 + 2]) * 0.5;
  }
  const cen = [cx, cy, cz];
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  // at most 2n - 1 nodes
  const box = new Float32Array((2 * n) * 6), first = new Uint32Array(2 * n), count = new Uint32Array(2 * n);
  let used = 1;
  const bounds = (node, s, e) => {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let k = s; k < e; k++) {
      const t = idx[k] * 3;
      if (bmin[t] < x0) x0 = bmin[t]; if (bmin[t + 1] < y0) y0 = bmin[t + 1]; if (bmin[t + 2] < z0) z0 = bmin[t + 2];
      if (bmax[t] > x1) x1 = bmax[t]; if (bmax[t + 1] > y1) y1 = bmax[t + 1]; if (bmax[t + 2] > z1) z1 = bmax[t + 2];
    }
    box.set([x0, y0, z0, x1, y1, z1], node * 6);
  };
  const area = (x, y, z) => x * y + y * z + z * x;
  const bc = new Uint32Array(BINS), bb = new Float32Array(BINS * 6), lA = new Float32Array(BINS), rA = new Float32Array(BINS), lN = new Uint32Array(BINS);
  const stack = [[0, 0, n]];
  while (stack.length) {
    const [node, s, e] = stack.pop();
    bounds(node, s, e);
    const cnt = e - s;
    if (cnt <= LEAF) { first[node] = s; count[node] = cnt; continue; }
    // centroid bounds
    let best = Infinity, bestAxis = -1, bestSplit = 0, cmin = 0, cmax = 0;
    for (let a = 0; a < 3; a++) {
      const c = cen[a];
      let lo = Infinity, hi = -Infinity;
      for (let k = s; k < e; k++) { const v = c[idx[k]]; if (v < lo) lo = v; if (v > hi) hi = v; }
      if (hi - lo < 1e-6) continue;
      bc.fill(0);
      for (let b = 0; b < BINS; b++) bb.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], b * 6);
      const k0 = BINS / (hi - lo);
      for (let k = s; k < e; k++) {
        const t = idx[k];
        const b = Math.min(BINS - 1, ((c[t] - lo) * k0) | 0);
        bc[b]++;
        const o = b * 6, t3 = t * 3;
        if (bmin[t3] < bb[o]) bb[o] = bmin[t3]; if (bmin[t3 + 1] < bb[o + 1]) bb[o + 1] = bmin[t3 + 1]; if (bmin[t3 + 2] < bb[o + 2]) bb[o + 2] = bmin[t3 + 2];
        if (bmax[t3] > bb[o + 3]) bb[o + 3] = bmax[t3]; if (bmax[t3 + 1] > bb[o + 4]) bb[o + 4] = bmax[t3 + 1]; if (bmax[t3 + 2] > bb[o + 5]) bb[o + 5] = bmax[t3 + 2];
      }
      // sweep from the left and from the right
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity, nl = 0;
      for (let b = 0; b < BINS - 1; b++) {
        const o = b * 6;
        if (bc[b]) { x0 = Math.min(x0, bb[o]); y0 = Math.min(y0, bb[o + 1]); z0 = Math.min(z0, bb[o + 2]); x1 = Math.max(x1, bb[o + 3]); y1 = Math.max(y1, bb[o + 4]); z1 = Math.max(z1, bb[o + 5]); }
        nl += bc[b]; lN[b] = nl; lA[b] = nl ? area(x1 - x0, y1 - y0, z1 - z0) : 0;
      }
      x0 = Infinity; y0 = Infinity; z0 = Infinity; x1 = -Infinity; y1 = -Infinity; z1 = -Infinity;
      for (let b = BINS - 1; b > 0; b--) {
        const o = b * 6;
        if (bc[b]) { x0 = Math.min(x0, bb[o]); y0 = Math.min(y0, bb[o + 1]); z0 = Math.min(z0, bb[o + 2]); x1 = Math.max(x1, bb[o + 3]); y1 = Math.max(y1, bb[o + 4]); z1 = Math.max(z1, bb[o + 5]); }
        rA[b - 1] = cnt - lN[b - 1] ? area(x1 - x0, y1 - y0, z1 - z0) : 0;
      }
      for (let b = 0; b < BINS - 1; b++) {
        const cost = lA[b] * lN[b] + rA[b] * (cnt - lN[b]);
        if (lN[b] > 0 && lN[b] < cnt && cost < best) { best = cost; bestAxis = a; bestSplit = b; cmin = lo; cmax = hi; }
      }
    }
    let mid;
    if (bestAxis < 0) mid = (s + e) >> 1;          // all centroids coincide: split in half
    else {
      const c = cen[bestAxis], k0 = BINS / (cmax - cmin);
      let i = s, j = e - 1;
      while (i <= j) {
        if (Math.min(BINS - 1, ((c[idx[i]] - cmin) * k0) | 0) <= bestSplit) i++;
        else { const t = idx[i]; idx[i] = idx[j]; idx[j] = t; j--; }
      }
      mid = i;
      if (mid === s || mid === e) mid = (s + e) >> 1;
    }
    const l = used; used += 2;
    first[node] = l; count[node] = 0;
    stack.push([l, s, mid], [l + 1, mid, e]);
  }
  // triangles in leaf order, with their precomputed edges for the intersection
  const T = new Float32Array(n * 9);
  for (let k = 0; k < n; k++) {
    const o = idx[k] * 9, d = k * 9;
    T[d] = tris[o]; T[d + 1] = tris[o + 1]; T[d + 2] = tris[o + 2];
    T[d + 3] = tris[o + 3] - tris[o]; T[d + 4] = tris[o + 4] - tris[o + 1]; T[d + 5] = tris[o + 5] - tris[o + 2];
    T[d + 6] = tris[o + 6] - tris[o]; T[d + 7] = tris[o + 7] - tris[o + 1]; T[d + 8] = tris[o + 8] - tris[o + 2];
  }
  return { box: box.slice(0, used * 6), first: first.slice(0, used), count: count.slice(0, used), tris: T, order: idx, nodes: used };
}

// slab test: entry distance, or Infinity
function hitBox(box, o, ox, oy, oz, ix, iy, iz, tmax) {
  let t0 = (box[o] - ox) * ix, t1 = (box[o + 3] - ox) * ix;
  let lo = t0 < t1 ? t0 : t1, hi = t0 < t1 ? t1 : t0;
  t0 = (box[o + 1] - oy) * iy; t1 = (box[o + 4] - oy) * iy;
  lo = Math.max(lo, t0 < t1 ? t0 : t1); hi = Math.min(hi, t0 < t1 ? t1 : t0);
  t0 = (box[o + 2] - oz) * iz; t1 = (box[o + 5] - oz) * iz;
  lo = Math.max(lo, t0 < t1 ? t0 : t1); hi = Math.min(hi, t0 < t1 ? t1 : t0);
  return hi >= Math.max(lo, 0) && lo < tmax ? lo : Infinity;
}

const STACK = new Uint32Array(128);
// closest hit: returns the hit distance (Infinity for none) and writes the triangle (leaf order) to out[0]
export function traceClosest(bvh, ox, oy, oz, dx, dy, dz, tmax, out) {
  const { box, first, count, tris } = bvh;
  const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
  let best = tmax, hitTri = -1, sp = 0, node = 0;
  if (hitBox(box, 0, ox, oy, oz, ix, iy, iz, best) === Infinity) { out[0] = -1; return Infinity; }
  for (;;) {
    const c = count[node];
    if (c > 0) {
      const f = first[node];
      for (let k = f; k < f + c; k++) {
        const t = k * 9;
        const e1x = tris[t + 3], e1y = tris[t + 4], e1z = tris[t + 5], e2x = tris[t + 6], e2y = tris[t + 7], e2z = tris[t + 8];
        const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (det > -1e-9 && det < 1e-9) continue;
        const inv = 1 / det;
        const sx = ox - tris[t], sy = oy - tris[t + 1], sz = oz - tris[t + 2];
        const u = (sx * px + sy * py + sz * pz) * inv;
        if (u < 0 || u > 1) continue;
        const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * inv;
        if (v < 0 || u + v > 1) continue;
        const d = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (d > 1e-4 && d < best) { best = d; hitTri = k; }
      }
    } else {
      const l = first[node], r = l + 1;
      const dl = hitBox(box, l * 6, ox, oy, oz, ix, iy, iz, best), dr = hitBox(box, r * 6, ox, oy, oz, ix, iy, iz, best);
      if (dl !== Infinity && dr !== Infinity) {
        if (dl <= dr) { STACK[sp++] = r; node = l; } else { STACK[sp++] = l; node = r; }
        continue;
      }
      if (dl !== Infinity) { node = l; continue; }
      if (dr !== Infinity) { node = r; continue; }
    }
    // pop the next node still worth visiting
    let next = -1;
    while (sp > 0) {
      const m = STACK[--sp];
      if (hitBox(box, m * 6, ox, oy, oz, ix, iy, iz, best) !== Infinity) { next = m; break; }
    }
    if (next < 0) break;
    node = next;
  }
  out[0] = hitTri;
  return hitTri < 0 ? Infinity : best;
}

// any hit within tmax (shadow rays)
export function traceAny(bvh, ox, oy, oz, dx, dy, dz, tmax) {
  const { box, first, count, tris } = bvh;
  const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
  let sp = 0;
  STACK[sp++] = 0;
  while (sp > 0) {
    const node = STACK[--sp];
    if (hitBox(box, node * 6, ox, oy, oz, ix, iy, iz, tmax) === Infinity) continue;
    const c = count[node];
    if (c === 0) { STACK[sp++] = first[node]; STACK[sp++] = first[node] + 1; continue; }
    const f = first[node];
    for (let k = f; k < f + c; k++) {
      const t = k * 9;
      const e1x = tris[t + 3], e1y = tris[t + 4], e1z = tris[t + 5], e2x = tris[t + 6], e2y = tris[t + 7], e2z = tris[t + 8];
      const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (det > -1e-9 && det < 1e-9) continue;
      const inv = 1 / det;
      const sx = ox - tris[t], sy = oy - tris[t + 1], sz = oz - tris[t + 2];
      const u = (sx * px + sy * py + sz * pz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
      const v = (dx * qx + dy * qy + dz * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      const d = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (d > 1e-4 && d < tmax) return true;
    }
  }
  return false;
}
