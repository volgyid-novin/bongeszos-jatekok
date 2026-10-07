import * as THREE from 'three';
import { buildBVH, traceClosest, traceAny } from './bvh.js';
import { GI_VERSION } from './gi.js';

// ============================================================
//  Light bake for ?gfx=gi:1 (docs/visual-next-steps.md D4). Dev tool: loaded only by
//  __homok.bakeGI() or ?bakegi (which downloads the result as gi.bin for assets/world/).
//
//  The sun and the world never move, so the light that reaches each point through the sky and
//  off the sunlit rock and sand can be ray traced once. Volumes (boxes upright along the track)
//  cover the canyon and the arch; from the centre of every cell, RAYS rays go out over the sphere
//  through a BVH of the static world around them:
//   - a ray that escapes upwards sees the sky (the hemisphere light + the environment's dome),
//   - one that escapes downwards sees open sunlit sand,
//   - one that hits a surface sees that surface: its albedo x (the sun, if a second ray towards
//     the sun gets out, x cos) + the indirect light on it. Two passes: the first takes a rough sky
//     term for that, the second the first pass's own result at the hit point (a second bounce,
//     which is what makes red rock glow in its own shade).
//  The radiance is projected onto L1 spherical harmonics, which give the irradiance E(n) = a + b.n
//  for any normal. The game lights a surface by its usual ambient x E(n) / E_open(n), where
//  E_open is the same computation over open flat sand: exactly 1 in the open, less down in the
//  slot, warmer facing sunlit rock (gfx/gi.js).
//
//  Storage: per cell and colour channel, a (as log2 of a / a_open) and b / 2a (|b| <= 2a), 8 bits
//  each: three RGBA8 texels per cell, side by side in one 3D atlas (gfx/gi.js reads it).
// ============================================================
const RAYS = 128;
const SAND = [0.55, 0.40, 0.25];          // linear albedo of the open sand and the track (gfx/ground.js, roughly)
const STONE = [0.5, 0.42, 0.33];          // textured structures with a white material colour

// directions over the sphere (Fibonacci), turned per cell
const FIB = (() => {
  const d = new Float32Array(RAYS * 3), g = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < RAYS; i++) {
    const y = 1 - (2 * i + 1) / RAYS, r = Math.sqrt(1 - y * y), a = g * i;
    d[i * 3] = Math.cos(a) * r; d[i * 3 + 1] = y; d[i * 3 + 2] = Math.sin(a) * r;
  }
  return d;
})();

function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// what the light bake leaves out: as the world shadow bake (gfx/atmosphere.js), and anything under a mover
function excluded(o) {
  for (let p = o; p; p = p.parent) if (p.userData.dynamic || p.userData.noBake || p.userData.scatter) return true;
  if (o.isPoints || o.isSprite || o.isLine || o.isSkinnedMesh) return true;
  const m = Array.isArray(o.material) ? o.material[0] : o.material;
  return !m || m.transparent || m.isShaderMaterial || m.isMeshBasicMaterial || m.isMeshBasicNodeMaterial;
}

// The static triangles that touch region (a Box3), with an albedo each. Canyon walls (userData.canyonWall)
// are double sided: their triangles are turned to face the track (towards) so back-face hits mean "inside rock".
function collect(scene, region, towards) {
  const tris = [], alb = [];
  const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], m4 = new THREE.Matrix4(), im = new THREE.Matrix4();
  const tb = new THREE.Box3(), c = new THREE.Color();
  const add = (o, mw) => {
    const g = o.geometry, pos = g.attributes.position, col = g.attributes.color, ix = g.index;
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    const base = o.userData.terrain || o.userData.track ? SAND : null;
    const mc = mat.color || new THREE.Color(1, 1, 1);
    const n = ix ? ix.count / 3 : pos.count / 3;
    for (let t = 0; t < n; t++) {
      const a = ix ? ix.getX(t * 3) : t * 3, b = ix ? ix.getX(t * 3 + 1) : t * 3 + 1, d = ix ? ix.getX(t * 3 + 2) : t * 3 + 2;
      v[0].fromBufferAttribute(pos, a).applyMatrix4(mw); v[1].fromBufferAttribute(pos, b).applyMatrix4(mw); v[2].fromBufferAttribute(pos, d).applyMatrix4(mw);
      tb.makeEmpty().expandByPoint(v[0]).expandByPoint(v[1]).expandByPoint(v[2]);
      if (!tb.intersectsBox(region)) continue;
      let [p0, p1, p2] = v;
      if (o.userData.canyonWall && towards) {
        // steep faces towards the nearest centre-line point, flat ones (the plateau) up
        const ex = p1.x - p0.x, ey = p1.y - p0.y, ez = p1.z - p0.z, fx = p2.x - p0.x, fy = p2.y - p0.y, fz = p2.z - p0.z;
        const nx = ey * fz - ez * fy, ny = ez * fx - ex * fz, nz = ex * fy - ey * fx;
        if (Math.abs(ny) > 0.7 * Math.hypot(nx, ny, nz)) { if (ny < 0) [p1, p2] = [p2, p1]; }
        else { const [tx, tz] = towards(p0.x, p0.z); if (nx * (tx - p0.x) + nz * (tz - p0.z) < 0) [p1, p2] = [p2, p1]; }
      }
      tris.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
      if (base) alb.push(...base);
      else if (col) {
        let r = 0, gg = 0, bb = 0;
        for (const k of [a, b, d]) { r += col.getX(k); gg += col.getY(k); bb += col.getZ(k); }
        alb.push(r / 3 * mc.r, gg / 3 * mc.g, bb / 3 * mc.b);
      } else if (mat.map || (mc.r > 0.99 && mc.g > 0.99 && mc.b > 0.99)) alb.push(STONE[0] * mc.r, STONE[1] * mc.g, STONE[2] * mc.b);
      else { c.copy(mc); alb.push(c.r, c.g, c.b); }
    }
  };
  scene.updateMatrixWorld(true);
  scene.traverse((o) => {
    if (!o.isMesh || excluded(o)) return;
    // a LOD contributes its finest level only; LodInstances levels: only the visible (forced) one
    if (o.parent?.isLOD && o.parent.levels[0]?.object !== o) return;
    let vis = true;
    for (let p = o; p; p = p.parent) if (!p.visible && !(p.parent?.isLOD)) vis = false;
    if (!vis) return;
    if (o.isInstancedMesh) {
      for (let k = 0; k < o.count; k++) { o.getMatrixAt(k, im); m4.multiplyMatrices(o.matrixWorld, im); add(o, m4); }
    } else add(o, o.matrixWorld);
  });
  return { tris: new Float32Array(tris), alb: new Float32Array(alb) };
}

// the sky model of the bake: the hemisphere light's sky half and the environment (the sky dome) above the
// horizon. Radiance in the units of three's lights (irradiance = pi x mean radiance).
function skyModel(P, envI) {
  const lin = (c) => [c.r, c.g, c.b];
  const hz = lin(P.skyHorizon), mid = lin(P.skyMid), zen = lin(P.zenith), fog = lin(P.fog), hs = lin(P.hemiSky);
  const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  return (dy, out) => {
    const h = Math.max(dy, 0);
    const k1 = sm(0, 0.2, h), k2 = Math.pow(sm(0.06, 0.7, h), 0.85), kf = 1 - sm(0, 0.12, h);
    for (let ch = 0; ch < 3; ch++) {
      let dome = hz[ch] + (mid[ch] - hz[ch]) * k1;
      dome += (zen[ch] - dome) * k2;
      dome += (fog[ch] - dome) * kf * 0.6;
      out[ch] = hs[ch] * P.hemiI / Math.PI + envI * dome;
    }
    return out;
  };
}

export async function bakeGI({ scene, TR, rangeWhere, arch, palette: P, sunDir, envI, onProgress }) {
  const t0 = performance.now();
  const L = [sunDir.x, sunDir.y, sunDir.z];
  const sunE = [P.sun.r * P.sunI, P.sun.g * P.sunI, P.sun.b * P.sunI];
  const sky = skyModel(P, envI);
  // the sky's irradiance on flat ground, and the open sand's radiance
  const tmp = [0, 0, 0], skyUp = [0, 0, 0];
  { const N = 4096; for (let i = 0; i < N; i++) { const y = (i + 0.5) / N; sky(y, tmp); for (let c = 0; c < 3; c++) skyUp[c] += tmp[c] * y * 2 * Math.PI / N; } }
  const sandL = SAND.map((a, c) => a / Math.PI * (sunE[c] * L[1] + skyUp[c]));

  // --- volumes ---------------------------------------------------------------------------------------
  const boxes = [];
  const cr = rangeWhere(TR.canyon, 0.01);
  if (cr) {
    // the canyon in equal, straight-ish pieces of ~400 m along the track (with the arch: <= 4 volumes, gfx/gi.js)
    const idx = []; for (let k = cr[0] - 4; k <= cr[1] + 4; k++) idx.push(TR.idx(k));
    let total = 0;
    const arc = [0];
    for (let k = 1; k < idx.length; k++) arc.push(total += Math.hypot(TR.px[idx[k]] - TR.px[idx[k - 1]], TR.pz[idx[k]] - TR.pz[idx[k - 1]]));
    const nSeg = Math.min(3, Math.max(1, Math.round(total / 400)));
    const seg = [];
    for (let q = 0; q < nSeg; q++) {
      const from = arc.findIndex((v) => v >= total * q / nSeg), to = q === nSeg - 1 ? idx.length - 1 : arc.findIndex((v) => v >= total * (q + 1) / nSeg);
      seg.push(idx.slice(Math.max(0, from - 1), to + 1));
    }
    for (const s of seg) {
      const a = s[0], b = s[s.length - 1];
      const ax = TR.px[b] - TR.px[a], az = TR.pz[b] - TR.pz[a], len = Math.hypot(ax, az);
      const ux = ax / len, uz = az / len;
      let lo = Infinity, hi = -Infinity, y0 = Infinity, y1 = -Infinity, hw = 0;
      for (const i of s) {
        const lat = (TR.px[i] - TR.px[a]) * -uz + (TR.pz[i] - TR.pz[a]) * ux;
        lo = Math.min(lo, lat); hi = Math.max(hi, lat);
        y0 = Math.min(y0, TR.py[i]); y1 = Math.max(y1, TR.py[i] + TR.wallH[i] * TR.canyon[i]);
        hw = Math.max(hw, TR.hw[i]);
      }
      const across = (hi - lo) + 2 * (hw + 22), cx = (lo + hi) / 2;
      boxes.push({
        name: 'canyon', ux, uz,
        // origin: the corner at (along 0, up 0, across 0)
        o: [TR.px[a] - ux * 12 + -uz * (cx - across / 2), y0 - 6, TR.pz[a] - uz * 12 + ux * (cx - across / 2)],
        size: [len + 24, y1 - y0 + 16, across], cell: [6, 4, 3.5],
      });
    }
  }
  if (arch) {
    const ux = Math.sin(arch.yaw), uz = Math.cos(arch.yaw), size = [150, 70, 160];
    boxes.push({ name: 'arch', ux, uz, o: [arch.x - ux * size[0] / 2 + -uz * -size[2] / 2, arch.y - 8, arch.z - uz * size[0] / 2 + ux * -size[2] / 2], size, cell: [3.5, 3.5, 3.5] });
  }
  for (const b of boxes) b.n = b.size.map((s, k) => Math.max(2, Math.ceil(s / b.cell[k])));
  // world point of cell (i along, j up, k across)
  const cellPos = (b, i, j, k, out) => {
    const s = (i + 0.5) * b.size[0] / b.n[0], u = (j + 0.5) * b.size[1] / b.n[1], c = (k + 0.5) * b.size[2] / b.n[2];
    out[0] = b.o[0] + b.ux * s + -b.uz * c; out[1] = b.o[1] + u; out[2] = b.o[2] + b.uz * s + b.ux * c;
    return out;
  };

  // --- geometry: everything within reach of the volumes (and of the sun rays out of them) -------------
  const region = new THREE.Box3();
  const p = [0, 0, 0];
  for (const b of boxes) for (const i of [0, b.n[0] - 1]) for (const j of [0, b.n[1] - 1]) for (const k of [0, b.n[2] - 1]) { cellPos(b, i, j, k, p); region.expandByPoint(new THREE.Vector3(...p)); }
  region.expandByScalar(220);
  region.max.y += 120;
  // the nearest centre-line point, for orienting the canyon walls
  const towards = (x, z) => { let best = 0, bd = Infinity; for (let i = 0; i < TR.N; i += 2) { const d = (TR.px[i] - x) ** 2 + (TR.pz[i] - z) ** 2; if (d < bd) { bd = d; best = i; } } return [TR.px[best], TR.pz[best]]; };
  const geo = collect(scene, region, towards);
  const nTri = geo.tris.length / 9;
  const bvh = buildBVH(geo.tris);
  // per triangle (leaf order): unit normal and albedo
  const nrm = new Float32Array(nTri * 3), alb = new Float32Array(nTri * 3);
  for (let k = 0; k < nTri; k++) {
    const t = k * 9, T = bvh.tris, src = bvh.order[k];
    let nx = T[t + 4] * T[t + 8] - T[t + 5] * T[t + 7], ny = T[t + 5] * T[t + 6] - T[t + 3] * T[t + 8], nz = T[t + 3] * T[t + 7] - T[t + 4] * T[t + 6];
    const l = Math.hypot(nx, ny, nz) || 1;
    nrm[k * 3] = nx / l; nrm[k * 3 + 1] = ny / l; nrm[k * 3 + 2] = nz / l;
    alb[k * 3] = geo.alb[src * 3]; alb[k * 3 + 1] = geo.alb[src * 3 + 1]; alb[k * 3 + 2] = geo.alb[src * 3 + 2];
  }
  const tBuild = performance.now() - t0;
  console.log(`HOMOKFUTAM: GI bake: ${nTri} triangles, BVH ${bvh.nodes} nodes in ${Math.round(tBuild)} ms`);

  // radiance along one ray from (ox, oy, oz); returns 1 if it hit a back face (the cell is inside rock).
  // ambAt(x, y, z, nx, ny, nz, out): the indirect irradiance on the surface hit
  const hit = [0], E = [0, 0, 0];
  let ambAt = null;
  const rad = (ox, oy, oz, dx, dy, dz, out) => {
    const d = traceClosest(bvh, ox, oy, oz, dx, dy, dz, 900, hit);
    if (d === Infinity) {
      if (dy > 0) sky(dy, out);
      else { out[0] = sandL[0]; out[1] = sandL[1]; out[2] = sandL[2]; }
      return 0;
    }
    const k = hit[0], n3 = k * 3;
    let nx = nrm[n3], ny = nrm[n3 + 1], nz = nrm[n3 + 2];
    const back = nx * dx + ny * dy + nz * dz > 0 ? 1 : 0;
    if (back) { nx = -nx; ny = -ny; nz = -nz; }
    const hx = ox + dx * d + nx * 0.05, hy = oy + dy * d + ny * 0.05, hz = oz + dz * d + nz * 0.05;
    const cos = nx * L[0] + ny * L[1] + nz * L[2];
    const lit = cos > 0 && !traceAny(bvh, hx, hy, hz, L[0], L[1], L[2], 1200) ? cos : 0;
    ambAt(hx, hy, hz, nx, ny, nz, E);
    for (let c = 0; c < 3; c++) out[c] = alb[n3 + c] / Math.PI * (sunE[c] * lit + E[c]);
    return back;
  };

  // the open reference: flat sand under the sky
  const ref = { a: [0, 0, 0], b: [[0, 0, 0], [0, 0, 0], [0, 0, 0]] };
  {
    const N = 8192;
    for (let i = 0; i < N; i++) {
      const y = 1 - (2 * i + 1) / N, r = Math.sqrt(1 - y * y), a = i * Math.PI * (3 - Math.sqrt(5));
      const L3 = y > 0 ? sky(y, [0, 0, 0]) : sandL;
      for (let c = 0; c < 3; c++) { ref.a[c] += L3[c] / N; ref.b[c][0] += L3[c] * Math.cos(a) * r / N; ref.b[c][1] += L3[c] * y / N; ref.b[c][2] += L3[c] * Math.sin(a) * r / N; }
    }
    for (let c = 0; c < 3; c++) { ref.a[c] *= Math.PI; for (let k = 0; k < 3; k++) ref.b[c][k] *= 2 * Math.PI; }
  }

  // pass 1: the sky on the hit surface by its tilt, less in enclosed places
  const roughAmb = (x, y, z, nx, ny, nz, out) => { const k = Math.max(0.15, 0.5 + 0.5 * ny) * 0.7; out[0] = skyUp[0] * k; out[1] = skyUp[1] * k; out[2] = skyUp[2] * k; };
  // pass 2: the first pass's irradiance at the hit (nearest cell, a cell out along the normal), or the rough term outside
  const volAmb = (prev) => (x, y, z, nx, ny, nz, out) => {
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi], px = x + nx * 2 - b.o[0], py = y + ny * 2 - b.o[1], pz = z + nz * 2 - b.o[2];
      const i = Math.floor((px * b.ux + pz * b.uz) * b.n[0] / b.size[0]), j = Math.floor(py * b.n[1] / b.size[1]), k = Math.floor((px * -b.uz + pz * b.ux) * b.n[2] / b.size[2]);
      if (i < 0 || j < 0 || k < 0 || i >= b.n[0] || j >= b.n[1] || k >= b.n[2]) continue;
      const c = (i * b.n[1] + j) * b.n[2] + k, A = prev[bi].A, B = prev[bi].B;
      for (let ch = 0; ch < 3; ch++) out[ch] = Math.max(0, A[c * 3 + ch] + B[c * 9 + ch * 3] * nx + B[c * 9 + ch * 3 + 1] * ny + B[c * 9 + ch * 3 + 2] * nz);
      return;
    }
    roughAmb(x, y, z, nx, ny, nz, out);
  };

  // --- trace every cell ----------------------------------------------------------------------------
  const q = new THREE.Quaternion(), m3 = new THREE.Matrix3(), m4 = new THREE.Matrix4();
  const L3 = [0, 0, 0];
  let rays = 0;
  const runPass = async (pass) => {
  const R = rng(7);
  const results = [];
  for (const b of boxes) {
    const [nA, nU, nC] = b.n, cells = nA * nU * nC;
    const A = new Float32Array(cells * 3), B = new Float32Array(cells * 9), valid = new Uint8Array(cells);
    for (let i = 0; i < nA; i++) {
      for (let j = 0; j < nU; j++) for (let k = 0; k < nC; k++) {
        cellPos(b, i, j, k, p);
        // a random turn of the direction set per cell (no banding between cells)
        q.set(R() - 0.5, R() - 0.5, R() - 0.5, R() - 0.5).normalize();
        m3.setFromMatrix4(m4.makeRotationFromQuaternion(q));
        const e = m3.elements;
        let a0 = 0, a1 = 0, a2 = 0, bx0 = 0, by0 = 0, bz0 = 0, bx1 = 0, by1 = 0, bz1 = 0, bx2 = 0, by2 = 0, bz2 = 0, backs = 0, hits = 0;
        for (let r = 0; r < RAYS; r++) {
          const fx = FIB[r * 3], fy = FIB[r * 3 + 1], fz = FIB[r * 3 + 2];
          let dx = e[0] * fx + e[3] * fy + e[6] * fz, dy = e[1] * fx + e[4] * fy + e[7] * fz, dz = e[2] * fx + e[5] * fy + e[8] * fz;
          if (Math.abs(dx) < 1e-7) dx = 1e-7; if (Math.abs(dy) < 1e-7) dy = 1e-7; if (Math.abs(dz) < 1e-7) dz = 1e-7;
          backs += rad(p[0], p[1], p[2], dx, dy, dz, L3);
          a0 += L3[0]; a1 += L3[1]; a2 += L3[2];
          bx0 += L3[0] * dx; by0 += L3[0] * dy; bz0 += L3[0] * dz;
          bx1 += L3[1] * dx; by1 += L3[1] * dy; bz1 += L3[1] * dz;
          bx2 += L3[2] * dx; by2 += L3[2] * dy; bz2 += L3[2] * dz;
        }
        rays += RAYS;
        const c = (i * nU + j) * nC + k, s = Math.PI / RAYS, t = 2 * Math.PI / RAYS;
        A[c * 3] = a0 * s; A[c * 3 + 1] = a1 * s; A[c * 3 + 2] = a2 * s;
        B.set([bx0 * t, by0 * t, bz0 * t, bx1 * t, by1 * t, bz1 * t, bx2 * t, by2 * t, bz2 * t], c * 9);
        valid[c] = backs < RAYS * 0.25 ? 1 : 0;
      }
      if ((i & 7) === 7) { onProgress?.(pass, b.name, i / nA); await new Promise((r) => setTimeout(r, 0)); }
    }
    // cells inside rock take the mean of their valid neighbours (a few passes, growing outwards)
    for (let pass = 0; pass < 6; pass++) {
      const nv = valid.slice();
      for (let i = 0; i < nA; i++) for (let j = 0; j < nU; j++) for (let k = 0; k < nC; k++) {
        const c = (i * nU + j) * nC + k;
        if (valid[c]) continue;
        let w = 0;
        const sa = [0, 0, 0], sb = new Float32Array(9);
        for (const [di, dj, dk] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
          const ii = i + di, jj = j + dj, kk = k + dk;
          if (ii < 0 || jj < 0 || kk < 0 || ii >= nA || jj >= nU || kk >= nC) continue;
          const n = (ii * nU + jj) * nC + kk;
          if (!valid[n]) continue;
          w++;
          for (let ch = 0; ch < 3; ch++) sa[ch] += A[n * 3 + ch];
          for (let m = 0; m < 9; m++) sb[m] += B[n * 9 + m];
        }
        if (!w) continue;
        for (let ch = 0; ch < 3; ch++) A[c * 3 + ch] = sa[ch] / w;
        for (let m = 0; m < 9; m++) B[c * 9 + m] = sb[m] / w;
        nv[c] = 1;
      }
      valid.set(nv);
    }
    results.push({ A, B });
  }
  return results;
  };
  ambAt = roughAmb;
  const first = await runPass(1);
  ambAt = volAmb(first);
  const results = await runPass(2);

  // --- encode into the atlas: x = across (+ channel x maxAcross), y = up, z = along (boxes stacked) -----
  const maxC = Math.max(...boxes.map((b) => b.n[2])), maxU = Math.max(...boxes.map((b) => b.n[1]));
  const W = maxC * 3, H = maxU, D = boxes.reduce((s, b) => s + b.n[0], 0);
  const data = new Uint8Array(W * H * D * 4);
  let z0 = 0;
  boxes.forEach((b, bi) => {
    const [nA, nU, nC] = b.n, { A, B } = results[bi];
    b.z0 = z0;
    for (let i = 0; i < nA; i++) for (let j = 0; j < nU; j++) for (let k = 0; k < nC; k++) {
      const c = (i * nU + j) * nC + k;
      for (let ch = 0; ch < 3; ch++) {
        const a = Math.max(A[c * 3 + ch], 1e-6);
        const la = Math.log2(a / ref.a[ch]);
        const o = (((z0 + i) * H + j) * W + ch * maxC + k) * 4;
        data[o] = Math.round(Math.min(1, Math.max(0, (la + 8) / 10)) * 255);
        for (let m = 0; m < 3; m++) data[o + 1 + m] = Math.round(Math.min(1, Math.max(0, B[c * 9 + ch * 3 + m] / (2 * a) * 0.5 + 0.5)) * 255);
      }
    }
    z0 += nA;
  });
  const header = {
    version: GI_VERSION, sun: L, rays: RAYS, atlas: [W, H, D], maxC,
    ref, boxes: boxes.map((b) => ({ name: b.name, o: b.o, ux: b.ux, uz: b.uz, size: b.size, n: b.n, z0: b.z0 })),
  };
  const json = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(8 + json.length + data.length);
  const dv = new DataView(out.buffer);
  out.set([0x48, 0x46, 0x47, 0x49]);                  // 'HFGI'
  dv.setUint32(4, json.length, true);
  out.set(json, 8);
  out.set(data, 8 + json.length);
  const ms = performance.now() - t0;
  console.log(`HOMOKFUTAM: GI bake: ${boxes.length} volumes, ${boxes.reduce((s, b) => s + b.n[0] * b.n[1] * b.n[2], 0)} cells, ${(rays / 1e6).toFixed(1)}M rays in ${(ms / 1000).toFixed(1)} s, ${(out.length / 1e6).toFixed(2)} MB`);
  return { buffer: out.buffer, header, ms, triangles: nTri };
}
