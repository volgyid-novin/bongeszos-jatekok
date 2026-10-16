// Convex brushes. A shape descriptor ('block', 'ramp', 'prism', 'hull') becomes: its vertices, its face planes
// (inside: n·p <= d), the polygon of every face (counter-clockwise seen from outside, for rendering), the AABB, and
// the plane set used by the collision trace. That set is the face planes + the 6 AABB planes + one plane per
// (edge x axis) cross product, each pushed out to the brush's support: expanding every plane by the box support
// |nx|hx+|ny|hy+|nz|hz is then the exact Minkowski sum of brush and player box, so sweeps are exact (no tunnelling,
// no ghost corners).
import { MIN_WALK_NY } from './const.js';
import { cross, dot, sub, len, rotY } from './math.js';

const EPS = 1e-6;
const AXES = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

function blockVerts(c, size, yaw) {
  const out = [];
  for (let i = 0; i < 8; i++) {
    const p = [(i & 1 ? 0.5 : -0.5) * size[0], (i & 2 ? 0.5 : -0.5) * size[1], (i & 4 ? 0.5 : -0.5) * size[2]];
    out.push(place(p, c, yaw));
  }
  return out;
}
function rampVerts(c, size, yaw) {
  const [sx, sy, sz] = size.map((v) => v / 2);
  // low edge at local -z (height 0), high edge at local +z (full height): it rises toward +z
  return [[-sx, -sy, -sz], [sx, -sy, -sz], [-sx, -sy, sz], [sx, -sy, sz], [-sx, sy, sz], [sx, sy, sz]].map((p) => place(p, c, yaw));
}
function prismVerts(c, r, h, sides, yaw) {
  const out = [];
  for (let k = 0; k < 2; k++) {
    for (let i = 0; i < sides; i++) {
      const a = Math.PI / sides + (i * 2 * Math.PI) / sides;   // sides = 4 gives an axis aligned square
      out.push(place([Math.cos(a) * r, (k ? 0.5 : -0.5) * h, Math.sin(a) * r], c, yaw));
    }
  }
  return out;
}
const place = (p, c, yaw) => { const q = rotY(p, yaw || 0); return [q[0] + c[0], q[1] + c[1], q[2] + c[2]]; };

export function shapeVerts(s) {
  switch (s.kind) {
    case 'block': return blockVerts(s.c, s.size, s.yaw);
    case 'ramp': return rampVerts(s.c, s.size, s.yaw);
    case 'prism': return prismVerts(s.c, s.r, s.h, s.sides, s.yaw);
    case 'hull': return s.points.map((p) => p.slice());
    default: throw new Error('unknown brush shape ' + s.kind);
  }
}

const samePlane = (a, n, d) => dot(a.n, n) > 1 - 1e-9 && Math.abs(a.d - d) < 1e-6;

// face planes of the convex hull of a point set (O(n^4), fine for the <= 32 points a brush has)
function hullPlanes(pts) {
  const planes = [];
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) for (let k = j + 1; k < pts.length; k++) {
    let n = cross(sub(pts[j], pts[i]), sub(pts[k], pts[i]));
    const l = len(n);
    if (l < 1e-9) continue;
    n = [n[0] / l, n[1] / l, n[2] / l];
    let d = dot(n, pts[i]), pos = false, neg = false;
    for (const p of pts) {
      const s = dot(n, p) - d;
      if (s > EPS) pos = true; else if (s < -EPS) neg = true;
      if (pos && neg) break;
    }
    if (pos && neg) continue;
    if (!pos && !neg) throw new Error('flat brush (all points coplanar)');
    if (pos) { n = [-n[0], -n[1], -n[2]]; d = -d; }
    if (!planes.some((pl) => samePlane(pl, n, d))) planes.push({ n, d });
  }
  return planes;
}

function faceOf(pl, pts) {
  let vs = pts.filter((p) => Math.abs(dot(pl.n, p) - pl.d) < 1e-5);
  const uniq = [];
  for (const p of vs) if (!uniq.some((q) => Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) < 1e-6)) uniq.push(p);
  vs = uniq;
  if (vs.length < 3) return null;
  const c = [0, 0, 0];
  for (const p of vs) { c[0] += p[0] / vs.length; c[1] += p[1] / vs.length; c[2] += p[2] / vs.length; }
  // basis u, v in the plane with u x v = n: ascending angle = counter-clockwise seen from outside
  const n = pl.n;
  const ref = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let u = cross(ref, n); const ul = len(u); u = [u[0] / ul, u[1] / ul, u[2] / ul];
  const v = cross(n, u);
  vs.sort((a, b) => Math.atan2(dot(sub(a, c), v), dot(sub(a, c), u)) - Math.atan2(dot(sub(b, c), v), dot(sub(b, c), u)));
  return { n: n.slice(), d: pl.d, verts: vs, top: n[1] >= MIN_WALK_NY };
}

export function makeBrush(shape) {
  const pts = shapeVerts(shape);
  const planes = hullPlanes(pts);
  if (planes.length < 4) throw new Error('brush needs at least 4 planes');
  const faces = planes.map((pl) => faceOf(pl, pts)).filter(Boolean);
  // volume from the faces (divergence theorem) must be positive
  let vol = 0;
  for (const f of faces) {
    let a = 0;
    for (let i = 1; i < f.verts.length - 1; i++) a += len(cross(sub(f.verts[i], f.verts[0]), sub(f.verts[i + 1], f.verts[0]))) / 2;
    vol += (f.d * a) / 3;
  }
  if (!(vol > 1e-9) || !Number.isFinite(vol)) throw new Error('brush has no volume');
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) for (let a = 0; a < 3; a++) { if (p[a] < min[a]) min[a] = p[a]; if (p[a] > max[a]) max[a] = p[a]; }

  // collision planes
  const clip = planes.map((p) => ({ n: p.n, d: p.d }));
  const addClip = (n, d) => { if (!clip.some((a) => samePlane(a, n, d))) clip.push({ n, d }); };
  for (let a = 0; a < 3; a++) {
    addClip(AXES[a], max[a]);
    addClip(AXES[a].map((v) => -v), -min[a]);
  }
  const edges = new Map();
  for (const f of faces) {
    for (let i = 0; i < f.verts.length; i++) {
      const p = f.verts[i], q = f.verts[(i + 1) % f.verts.length];
      const key = [p, q].map((v) => v.map((x) => Math.round(x * 1e4)).join(',')).sort().join('|');
      if (!edges.has(key)) edges.set(key, [p, q]);
    }
  }
  for (const [p, q] of edges.values()) {
    const e = sub(q, p);
    for (const ax of AXES) {
      let n = cross(e, ax);
      const l = len(n);
      if (l < 1e-6 * len(e) || l < 1e-9) continue;
      n = [n[0] / l, n[1] / l, n[2] / l];
      for (const s of [1, -1]) {
        const nn = [n[0] * s, n[1] * s, n[2] * s];
        let d = -Infinity;
        for (const v of pts) d = Math.max(d, dot(nn, v));
        addClip(nn, d);
      }
    }
  }
  const flat = new Float64Array(clip.length * 4);
  clip.forEach((c, i) => { flat[i * 4] = c.n[0]; flat[i * 4 + 1] = c.n[1]; flat[i * 4 + 2] = c.n[2]; flat[i * 4 + 3] = c.d; });
  return { kind: shape.kind, planes, faces, verts: pts, min, max, clip: flat, nclip: clip.length, volume: vol, stamp: 0 };
}
