// A small hard-surface kit for hand-built gear and armour (render/gauntlet.js, later the character): shape helpers that return plain
// BufferGeometry, and a Kit that bakes the pieces into ONE geometry per material, with analytic vertex AO and a lighter wear tint on the
// bevels. Everything is deterministic (a seeded RNG, no Math.random) and needs no files, no canvas and no WebGL, so node builds it too.
//
//   rng(seed) -> () => [0,1)                         (the sim's mulberry32)
//   m4({ p: [x,y,z], r: [rx,ry,rz], s: number | [sx,sy,sz] }) -> Matrix4        (all optional)
//   shapes (every edge is bevelled, nothing has a sharp silhouette):
//   rbox(w, h, d, r, seg)                  rounded box (corner radius r)                          wear: 'box'
//   cbox(w, h, d, b)                       chamfered block, 28 triangles                          wear: 'plate' (its z is the thin axis)
//   plate(pts, { thick, bevel, segs, holes, curve })   a bevelled extruded plate: pts = [[x,y],...] CCW, centred on z = 0   wear: 'plate'
//   hexPlate(r, thick, bevel)              the same for a regular hexagon (corner radius r)
//   lathe(profile, segs, { crease })       a solid of revolution about Y; profile = [[r, y],...] walked with the outside on the RIGHT (so an
//                                          outline that runs clockwise in an r-right, y-up drawing); hard steps stay crisp, soft curves smooth
//   loop(kind)                             cross-sections: rrect(w, h, r, seg) = a rounded rectangle, circle(r, n)
//   loft(rings, { cap })                   a skin through rings of 3D points (all the same length), smooth, optionally closed at both ends
//   sweep(loop, curve, steps, scaleFn, { cap })   a loop swept along a THREE.Curve (parallel-transport frames) with a scale per t
//   tube(points, radius, { tubular, radial })     a cable along a Catmull-Rom path
//   bolt(r, h)                             a small cap screw (axis +Y)
//   const kit = new Kit(seed);   kit.add(key, geometry, matrix, { wear: 'box' | 'plate' | false })   kit.vent(key, matrix, w, h, n)
//   (wear: 'box' | 'plate' | 'lathe' picks how a vertex's normal says it is on a bevel)
//   kit.occlude([x,y,z], r, k)   an occluder sphere for the AO       kit.build({ aoStrength, wear, uvTile }) -> Map(key -> BufferGeometry)
//   kit.tris(key?)               triangle count        kit.mesh(key, material) -> Mesh
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../sim/math.js';

export { mulberry32 as rng };
const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// ---------------------------------------------------------------------------------------------------- transforms
const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
export function m4({ p = [0, 0, 0], r = [0, 0, 0], s = 1 } = {}) {
  _e.set(r[0], r[1], r[2], 'XYZ'); _q.setFromEuler(_e);
  _p.set(p[0], p[1], p[2]);
  if (typeof s === 'number') _s.set(s, s, s); else _s.set(s[0], s[1], s[2]);
  return new THREE.Matrix4().compose(_p, _q, _s);
}

// ---------------------------------------------------------------------------------------------------- shapes
export function rbox(w, h, d, r, seg = 2) {
  const rad = Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4);
  return new RoundedBoxGeometry(w, h, d, seg, rad);
}

// pts CCW; holes = [[[x,y],...], ...] (CW is fixed by three). The nominal outline is kept: the caps are inset by the bevel.
export function plate(pts, { thick = 0.006, bevel = 0.0025, segs = 2, holes = [], curve = 8, crease = 0.62 } = {}) {
  const shape = new THREE.Shape(pts.map((p) => new THREE.Vector2(p[0], p[1])));
  for (const h of holes) shape.holes.push(new THREE.Path(h.map((p) => new THREE.Vector2(p[0], p[1]))));
  const g = new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelOffset: -bevel, bevelSegments: segs, curveSegments: curve });
  g.translate(0, 0, -thick / 2);
  return toCreasedNormals(g, crease);
}
// a chamfered block (w x h x d, chamfer b): the cheap bevelled box, 28 triangles, for bolts' neighbours, clamps, lights, slats
export function cbox(w, h, d, b = 0.002) {
  const x = w / 2, y = h / 2;
  return plate([[-x, -y], [x, -y], [x, y], [-x, y]], { thick: Math.max(1e-4, d - 2 * b), bevel: b, segs: 1, curve: 1 });
}
export function hexPlate(r, thick, bevel, rot = 0) {
  const pts = [];
  for (let i = 0; i < 6; i++) { const a = rot + i * TAU / 6; pts.push([Math.cos(a) * r, Math.sin(a) * r]); }
  return plate(pts, { thick, bevel, segs: 2 });
}

// a rounded rectangle outline, CCW, starting at +x
export function rrect(w, h, r, seg = 4) {
  const out = [], rr = Math.min(r, w / 2, h / 2);
  const corners = [[w / 2 - rr, h / 2 - rr, 0], [-w / 2 + rr, h / 2 - rr, 1], [-w / 2 + rr, -h / 2 + rr, 2], [w / 2 - rr, -h / 2 + rr, 3]];
  for (const [cx, cy, q] of corners) for (let i = 0; i <= seg; i++) { const a = (q + i / seg) * Math.PI / 2; out.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]); }
  return out;
}
export function circle(r, n = 16) {
  const out = [];
  for (let i = 0; i < n; i++) out.push([Math.cos(i / n * TAU) * r, Math.sin(i / n * TAU) * r]);
  return out;
}

// a solid of revolution. Each profile segment has its own ring of vertices, so a step in the profile stays crisp; where two segments turn by
// less than `crease` degrees the normals are blended, so curves are smooth.
export function lathe(profile, segs = 32, { crease = 40, from = 0, sweep: arc = TAU, caps = false } = {}) {
  const n = profile.length, pos = [], nor = [], uv = [], idx = [];
  const sn = [];   // the 2D normal of each segment (r, y)
  let total = 0;
  const lens = [0];
  for (let i = 0; i < n - 1; i++) {
    const dr = profile[i + 1][0] - profile[i][0], dy = profile[i + 1][1] - profile[i][1], l = Math.hypot(dr, dy) || 1;
    sn.push([dy / l, -dr / l]);
    total += l; lens.push(total);
  }
  const cosC = Math.cos(crease * Math.PI / 180);
  const blend = (a, b) => {
    if (!a || !b) return a || b;
    if (a[0] * b[0] + a[1] * b[1] < cosC) return null;
    const x = a[0] + b[0], y = a[1] + b[1], l = Math.hypot(x, y) || 1;
    return [x / l, y / l];
  };
  for (let i = 0; i < n - 1; i++) {
    const a = profile[i], b = profile[i + 1];
    const na = blend(sn[i], sn[i - 1]) || sn[i], nb = blend(sn[i], sn[i + 1]) || sn[i];
    const base = pos.length / 3;
    for (let k = 0; k <= segs; k++) {
      const t = from + k / segs * arc, c = Math.cos(t), s = Math.sin(t);
      pos.push(a[0] * c, a[1], a[0] * s, b[0] * c, b[1], b[0] * s);
      nor.push(na[0] * c, na[1], na[0] * s, nb[0] * c, nb[1], nb[0] * s);
      uv.push(k / segs, lens[i] / (total || 1), k / segs, lens[i + 1] / (total || 1));
    }
    for (let k = 0; k < segs; k++) {
      const p0 = base + k * 2, p1 = p0 + 1, p2 = p0 + 2, p3 = p0 + 3;   // a_k, b_k, a_k+1, b_k+1
      // (both triangles face along (dy, -dr) of the profile segment: the outside, for a profile walked with the outside on its right)
      if (a[0] > 1e-9) idx.push(p0, p1, p2);
      if (b[0] > 1e-9) idx.push(p2, p1, p3);
    }
  }
  // caps: a part-turn (arc < a full circle) of a closed convex profile gets a flat face at each end
  if (caps && arc < TAU - 1e-6) {
    for (const [t, dir] of [[from, -1], [from + arc, 1]]) {
      const c = Math.cos(t), s = Math.sin(t), nx = -s * dir, nz = c * dir, base = pos.length / 3;
      for (const p of profile) { pos.push(p[0] * c, p[1], p[0] * s); nor.push(nx, 0, nz); uv.push(0.5, 0.5); }
      for (let i = 1; i < n - 1; i++) idx.push(base, base + (dir > 0 ? i : i + 1), base + (dir > 0 ? i + 1 : i));
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

// rings of 3D points (all the same length, each ring CCW seen from the end the skin runs towards) -> a smooth skin; cap: close both ends with a fan
export function loft(rings, { cap = true } = {}) {
  const n = rings[0].length, pos = [], idx = [];
  for (const ring of rings) for (const p of ring) pos.push(p[0], p[1], p[2]);
  for (let j = 0; j < rings.length - 1; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * n + i, b = j * n + (i + 1) % n, c = (j + 1) * n + i, d = (j + 1) * n + (i + 1) % n;
      idx.push(a, b, c, b, d, c);
    }
  }
  let g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  if (cap) {
    const caps = [];
    for (const [ring, flip] of [[rings[0], true], [rings[rings.length - 1], false]]) {
      const c = [0, 0, 0];
      for (const p of ring) { c[0] += p[0] / n; c[1] += p[1] / n; c[2] += p[2] / n; }
      const cp = [], ci = [];
      cp.push(...c);
      for (const p of ring) cp.push(p[0], p[1], p[2]);
      for (let i = 0; i < n; i++) { const a = 1 + i, b = 1 + (i + 1) % n; ci.push(0, flip ? b : a, flip ? a : b); }
      const cg = new THREE.BufferGeometry();
      cg.setAttribute('position', new THREE.Float32BufferAttribute(cp, 3));
      cg.setIndex(ci);
      cg.computeVertexNormals();
      caps.push(cg);
    }
    g = concat([g, ...caps]);
  }
  return g;
}

// a loop (2D, CCW) swept along a curve: the loop's x / y follow the frame's normal / binormal; scaleFn(t) -> [sx, sy]
export function sweep(loopPts, curve, steps, scaleFn = () => [1, 1], { cap = true } = {}) {
  const frames = curve.computeFrenetFrames(steps, false), rings = [];
  for (let j = 0; j <= steps; j++) {
    const t = j / steps, c = curve.getPointAt(t), N = frames.normals[j], B = frames.binormals[j], [sx, sy] = scaleFn(t);
    rings.push(loopPts.map((p) => [c.x + (N.x * p[0] * sx + B.x * p[1] * sy), c.y + (N.y * p[0] * sx + B.y * p[1] * sy), c.z + (N.z * p[0] * sx + B.z * p[1] * sy)]));
  }
  return loft(rings, { cap });
}

export function tube(points, radius, { tubular = 24, radial = 8 } = {}) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(p[0], p[1], p[2])), false, 'catmullrom', 0.5);
  return new THREE.TubeGeometry(curve, tubular, radius, radial, false);
}

export function bolt(r, h) {
  return lathe([[r, 0], [r, h * 0.62], [r * 0.8, h], [0, h]], 5, { crease: 20 });
}

// concatenate indexed / non-indexed geometries that all have position + normal into one non-indexed geometry
export function concat(list) {
  let count = 0;
  const parts = list.map((g) => (g.index ? g.toNonIndexed() : g));
  for (const g of parts) count += g.attributes.position.count;
  const pos = new Float32Array(count * 3), nor = new Float32Array(count * 3), uv = new Float32Array(count * 2);
  let o = 0;
  for (const g of parts) {
    pos.set(g.attributes.position.array, o * 3);
    if (g.attributes.normal) nor.set(g.attributes.normal.array, o * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array, o * 2);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return out;
}

// ---------------------------------------------------------------------------------------------------- the kit
const _v = new THREE.Vector3(), _n = new THREE.Vector3(), _nm = new THREE.Matrix3();

// how much of a bevel a local normal is: 0 on a flat face, up to 1 in the middle of a rounded edge
const WEAR = {
  box: (nx, ny, nz) => smoothstep(0.07, 0.5, 1 - Math.max(Math.abs(nx), Math.abs(ny), Math.abs(nz))),
  plate: (nx, ny, nz) => { const a = Math.abs(nz); return smoothstep(0.1, 0.4, a) * (1 - smoothstep(0.8, 0.97, a)); },
  lathe: (nx, ny, nz) => smoothstep(0.3, 0.9, 2 * Math.min(Math.abs(ny), Math.hypot(nx, nz))),   // the chamfers of a turned part (about Y)
};

export class Kit {
  constructor(seed = 1) {
    this.rand = mulberry32(seed);
    this.buckets = new Map();   // key -> { pos[], nor[], wear[] }
    this.occ = [];              // AO occluder spheres
  }
  bucket(key) {
    let b = this.buckets.get(key);
    if (!b) this.buckets.set(key, b = { pos: [], nor: [], wear: [] });
    return b;
  }
  // bake `geo` (kept untouched) through `m` into the bucket `key`
  add(key, geo, m = new THREE.Matrix4(), { wear = false } = {}) {
    const g = geo.index ? geo.toNonIndexed() : geo, b = this.bucket(key);
    const pos = g.attributes.position, nor = g.attributes.normal, flip = m.determinant() < 0, wf = wear ? WEAR[wear] : null;
    _nm.getNormalMatrix(m);
    const at = (i) => {
      _v.fromBufferAttribute(pos, i).applyMatrix4(m);
      _n.fromBufferAttribute(nor, i);
      const w = wf ? wf(_n.x, _n.y, _n.z) : 0;
      _n.applyMatrix3(_nm).normalize();
      b.pos.push(_v.x, _v.y, _v.z); b.nor.push(_n.x, _n.y, _n.z); b.wear.push(w);
    };
    for (let i = 0; i < pos.count; i += 3) { at(i); if (flip) { at(i + 2); at(i + 1); } else { at(i + 1); at(i + 2); } }
    return this;
  }
  // a block of parallel slats in a recess: n slats across a w x h opening (the opening faces +z), for vents and radiators
  vent(key, m, w, h, n, { depth = 0.004, gap = 0.5 } = {}) {
    const pitch = h / n, t = pitch * (1 - gap);
    for (let i = 0; i < n; i++) {
      const y = -h / 2 + pitch * (i + 0.5);
      this.add(key, cbox(w, t, depth, Math.min(t, depth) * 0.3), new THREE.Matrix4().multiplyMatrices(m, m4({ p: [0, y, 0] })), { wear: 'plate' });
    }
    return this;
  }
  occlude(c, r, k = 1) { this.occ.push({ c, r, k }); return this; }

  tris(key) {
    let n = 0;
    for (const [k, b] of this.buckets) if (!key || k === key) n += b.pos.length / 9;
    return n;
  }

  // -> Map(key -> BufferGeometry with position, normal, uv (box-projected, `uvTile` metres per texture tile), color (AO x wear))
  build({ aoStrength = 0.7, wear = 0.5, uvTile = 0.08, hemi = 0.22 } = {}) {
    const out = new Map();
    for (const [key, b] of this.buckets) {
      const n = b.wear.length, pos = new Float32Array(b.pos), nor = new Float32Array(b.nor), uv = new Float32Array(n * 2), col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2], nx = nor[i * 3], ny = nor[i * 3 + 1], nz = nor[i * 3 + 2];
        // ambient occlusion from the proxy spheres (the analytic form: the solid angle of a sphere, cosine weighted), and a little from below
        let occ = 0;
        for (const o of this.occ) {
          const dx = o.c[0] - x, dy = o.c[1] - y, dz = o.c[2] - z, d2 = dx * dx + dy * dy + dz * dz, d = Math.sqrt(d2) || 1e-6;
          const cosT = (nx * dx + ny * dy + nz * dz) / d;
          if (cosT > 0) occ += o.k * Math.min(1, o.r * o.r / d2) * cosT;
        }
        const ao = 1 - clamp(occ * aoStrength, 0, 0.85);
        const under = 1 - hemi * clamp(-ny * 0.5 + 0.5, 0, 1) * (ny < 0 ? 1 : 0.35);
        const k = ao * under * (1 + wear * b.wear[i]);
        col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = k;
        // box projection along the dominant normal axis
        const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
        if (ax >= ay && ax >= az) { uv[i * 2] = z / uvTile; uv[i * 2 + 1] = y / uvTile; }
        else if (ay >= az) { uv[i * 2] = x / uvTile; uv[i * 2 + 1] = z / uvTile; }
        else { uv[i * 2] = x / uvTile; uv[i * 2 + 1] = y / uvTile; }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.computeBoundingSphere(); g.computeBoundingBox();
      out.set(key, g);
    }
    return out;
  }
  mesh(key, material, opts) {
    const geos = this.built || (this.built = this.build(opts));
    const g = geos.get(key);
    return g ? new THREE.Mesh(g, material) : null;
  }
}

// a hash of a geometry's positions (for determinism checks)
export function geometryHash(geos) {
  let h = 2166136261;
  for (const g of geos) {
    const a = g.attributes.position.array;
    for (let i = 0; i < a.length; i++) h = Math.imul(h ^ Math.round(a[i] * 1e5), 16777619);
    h = Math.imul(h ^ a.length, 16777619);
  }
  return h >>> 0;
}
