// Geometry merging: everything static is accumulated per (material, 36 m cell) and turned into a few big meshes.
// Cells keep frustum culling and shadow culling useful on long maps.
//
//   const m = new Merger(36);                       // Infinity = one chunk (movers)
//   m.poly(material, verts, normal, colors)         a convex polygon (fan), planar world UVs (1 tile = 2 m), flat normal
//   m.geo(material, geometry, matrix, opts)         any three geometry, transformed; opts { color, planar, uvMul, colorFn }
//   m.build(parent, { cast, receive })              creates the meshes
// Colours are LINEAR rgb arrays (see lin()); the HDR glow colours may exceed 1. A material with userData.rgba gets 4
// colour components (vertex alpha).
import * as THREE from 'three';

const _c = new THREE.Color();
// sRGB hex -> linear rgb (k scales it, > 1 = HDR for the bloom)
export function lin(hex, k = 1) { _c.setHex(hex); return [_c.r * k, _c.g * k, _c.b * k]; }

const _v = new THREE.Vector3(), _n = new THREE.Vector3(), _nm = new THREE.Matrix3(), _t = new THREE.Vector3();

function planar(px, py, pz, nx, ny, nz, out) {
  const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
  if (ay >= ax && ay >= az) { out.push(px * 0.5, pz * 0.5); }
  else if (ax >= az) { out.push(pz * 0.5, py * 0.5); }
  else { out.push(px * 0.5, py * 0.5); }
}

export class Merger {
  // cell: metres (or [cx, cy, cz], Infinity = one chunk). near: { min, max } box around the playable area: whatever lies
  // outside it (distant scenery) goes into one far chunk per material, so it costs one draw call instead of many.
  constructor(cell = 36, near = null) {
    this.cell = Array.isArray(cell) ? cell : [cell, cell, cell];
    this.near = near;
    this.buckets = new Map(); this.meshes = [];
  }

  acc(material, x, y, z) {
    let b = this.buckets.get(material);
    if (!b) { b = new Map(); this.buckets.set(material, b); }
    const c = this.cell, n = this.near;
    let key;
    if (c[0] === Infinity) key = 0;
    else if (n && (x < n.min[0] || x > n.max[0] || y < n.min[1] || y > n.max[1] || z < n.min[2] || z > n.max[2])) key = 'far';
    else key = `${Math.floor(x / c[0])},${Math.floor(y / c[1])},${Math.floor(z / c[2])}`;
    let a = b.get(key);
    if (!a) { a = { pos: [], nor: [], uv: [], col: [], idx: [], n: 0 }; b.set(key, a); }
    return a;
  }

  // verts: [[x,y,z]...] counter-clockwise from outside; colors: one [r,g,b(,a)] or one per vertex
  poly(material, verts, n, colors) {
    let cx = 0, cy = 0, cz = 0;
    for (const v of verts) { cx += v[0]; cy += v[1]; cz += v[2]; }
    const k = verts.length;
    const a = this.acc(material, cx / k, cy / k, cz / k), base = a.n, rgba = material.userData.rgba;
    const per = Array.isArray(colors[0]);
    for (let i = 0; i < k; i++) {
      const v = verts[i], c = per ? colors[i] : colors;
      a.pos.push(v[0], v[1], v[2]); a.nor.push(n[0], n[1], n[2]);
      planar(v[0], v[1], v[2], n[0], n[1], n[2], a.uv);
      a.col.push(c[0], c[1], c[2]); if (rgba) a.col.push(c[3] ?? 1);
    }
    for (let i = 1; i < k - 1; i++) a.idx.push(base, base + i, base + i + 1);
    a.n += k;
  }

  geo(material, g, m, { color = [1, 1, 1], planar: pl = false, uvMul = null, colorFn = null } = {}) {
    const P = g.attributes.position, N = g.attributes.normal, U = g.attributes.uv;
    const cnt = P.count;
    _t.setFromMatrixPosition(m);
    const a = this.acc(material, _t.x, _t.y, _t.z), base = a.n, rgba = material.userData.rgba;
    _nm.getNormalMatrix(m);
    for (let i = 0; i < cnt; i++) {
      _v.fromBufferAttribute(P, i).applyMatrix4(m);
      _n.fromBufferAttribute(N, i).applyMatrix3(_nm).normalize();
      a.pos.push(_v.x, _v.y, _v.z); a.nor.push(_n.x, _n.y, _n.z);
      if (pl) planar(_v.x, _v.y, _v.z, _n.x, _n.y, _n.z, a.uv);
      else if (U) a.uv.push(U.getX(i) * (uvMul ? uvMul[0] : 1), U.getY(i) * (uvMul ? uvMul[1] : 1));
      else a.uv.push(0, 0);
      const c = colorFn ? colorFn(_v, _n) : color;
      a.col.push(c[0], c[1], c[2]); if (rgba) a.col.push(c[3] ?? 1);
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) a.idx.push(base + g.index.getX(i));
    else for (let i = 0; i < cnt; i++) a.idx.push(base + i);
    a.n += cnt;
  }

  build(parent, { cast = true, receive = true } = {}) {
    for (const [mat, cells] of this.buckets) {
      for (const a of cells.values()) {
        if (!a.n) continue;
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(a.pos, 3));
        g.setAttribute('normal', new THREE.Float32BufferAttribute(a.nor, 3));
        g.setAttribute('uv', new THREE.Float32BufferAttribute(a.uv, 2));
        g.setAttribute('color', new THREE.Float32BufferAttribute(a.col, mat.userData.rgba ? 4 : 3));
        g.setIndex(a.n > 65535 ? new THREE.Uint32BufferAttribute(a.idx, 1) : new THREE.Uint16BufferAttribute(a.idx, 1));
        g.computeBoundingSphere();
        const mesh = new THREE.Mesh(g, mat);
        mesh.castShadow = cast && !mat.transparent && !mat.userData.noShadow;
        mesh.receiveShadow = receive && !mat.userData.noShadow;
        if (mat.transparent) mesh.renderOrder = 2;
        parent.add(mesh);
        this.meshes.push(mesh);
      }
    }
    this.buckets.clear();
    return this.meshes;
  }
}
