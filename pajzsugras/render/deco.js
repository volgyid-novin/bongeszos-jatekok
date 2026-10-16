// Decoration (b.deco): never collides. Every kind is built from primitives and merged with the level (render/merge.js);
// a few things animate (fans spin, screens scroll) and report back through ctx.anim.
//
//   addDeco(ctx, d)   ctx = { m: Merger, surf: Surfaces, palette, parent: Object3D, anim: [fn(dt, t)], screens: Map }
// Kinds: pipe beam cable crate pillar fan rock crystal screen arch ring beacon. d = { kind, pos, size?, yaw (deg), color?, to? }.
import * as THREE from 'three';
import { lin } from './merge.js';
import { screenTexture } from './textures.js';

const DEG = Math.PI / 180;
const geoCache = new Map();
function cached(key, make) { let g = geoCache.get(key); if (!g) { g = make(); geoCache.set(key, g); } return g; }
const BOX = () => cached('box', () => new THREE.BoxGeometry(1, 1, 1));
const CYL = (seg) => cached('cyl' + seg, () => new THREE.CylinderGeometry(0.5, 0.5, 1, seg, 1));
const CYL_OPEN = (seg) => cached('cylo' + seg, () => new THREE.CylinderGeometry(0.5, 0.5, 1, seg, 1, true));
export const disposeDecoCache = () => { for (const g of geoCache.values()) g.dispose(); geoCache.clear(); };

const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
function compose(px, py, pz, rx, ry, rz, sx, sy, sz, out = new THREE.Matrix4()) {
  _e.set(rx, ry, rz, 'YXZ'); _q.setFromEuler(_e);
  return out.compose(_p.set(px, py, pz), _q, _s.set(sx, sy, sz));
}
// a part in the deco's local frame
function part(B, lx, ly, lz, sx, sy, sz, rx = 0, ry = 0, rz = 0) {
  return B.clone().multiply(compose(lx, ly, lz, rx, ry, rz, sx, sy, sz));
}
const hash3 = (x, y, z) => { let h = Math.imul((x * 73856093) ^ (y * 19349663) ^ (z * 83492791), 0x45d9f3b); h ^= h >>> 15; return ((h >>> 0) % 10007) / 10007; };

// ---- rock variants: displaced icosahedra (flat shaded) ----
let rockVariants = null;
function rocks() {
  if (rockVariants) return rockVariants;
  rockVariants = [];
  for (let v = 0; v < 6; v++) {
    const g = new THREE.IcosahedronGeometry(0.5, 1);
    const P = g.attributes.position;
    for (let i = 0; i < P.count; i++) {
      const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
      const k = 1 + 0.42 * (hash3(Math.round(x * 100) + v * 31, Math.round(y * 100), Math.round(z * 100)) - 0.5);
      P.setXYZ(i, x * k, y * k * (y < 0 ? 0.6 : 1), z * k);
    }
    g.computeVertexNormals();
    rockVariants.push(g);
  }
  return rockVariants;
}

// one hexagonal shard standing on the local origin (B), h tall, r the base radius
function crystalShard(ctx, mat, B, h, r, tint) {
  const body = cached('cs-body', () => new THREE.CylinderGeometry(0.75, 1, 1, 6, 1));
  const tip = cached('cs-tip', () => new THREE.ConeGeometry(0.75, 1, 6, 1));
  ctx.m.geo(mat, body, part(B, 0, h * 0.35, 0, r, h * 0.7, r), { color: tint, planar: true });
  ctx.m.geo(mat, tip, part(B, 0, h * 0.7 + h * 0.15, 0, r * 0.75 / 0.75, h * 0.3, r * 0.75), { color: tint, planar: true });
}

export function addDeco(ctx, d) {
  const { m, surf, palette } = ctx;
  const yaw = (d.yaw || 0) * DEG, [px, py, pz] = d.pos;
  const B = compose(px, py, pz, 0, yaw, 0, 1, 1, 1);
  const sz = d.size || [];
  const glowHex = d.color ?? palette.glow;
  switch (d.kind) {
    case 'pipe': {
      const L = sz[0] ?? 4, r = Math.min(sz[1] ?? 0.4, sz[2] ?? 0.4);
      const mat = surf.deco('metal'), tint = lin(d.color ?? 0x8c979e);
      m.geo(mat, CYL(12), part(B, 0, 0, 0, r, L, r, 0, 0, Math.PI / 2), { color: tint, planar: false, uvMul: [Math.max(1, r * 4), L / 2] });
      const n = Math.max(2, Math.round(L / 2.5) + 1);
      for (let i = 0; i < n; i++) {
        const x = -L / 2 + (L * i) / (n - 1);
        m.geo(mat, CYL(12), part(B, x, 0, 0, r * 1.3, 0.16, r * 1.3, 0, 0, Math.PI / 2), { color: lin(d.color ?? 0x6b767d), uvMul: [1, 0.2] });
      }
      break;
    }
    case 'beam': {
      const L = sz[0] ?? 6, h = sz[1] ?? 0.4, w = sz[2] ?? 0.4;
      if (Math.min(h, w) < 0.2) {   // a thin line = a light strip
        m.geo(surf.glow, BOX(), part(B, 0, 0, 0, L, h, w), { color: lin(glowHex, 2.4) });
      } else {   // an I-beam
        const mat = surf.deco('metal'), tint = lin(d.color ?? 0xb4bec5);
        m.geo(mat, BOX(), part(B, 0, h * 0.41, 0, L, h * 0.18, w), { color: tint, planar: true });
        m.geo(mat, BOX(), part(B, 0, -h * 0.41, 0, L, h * 0.18, w), { color: tint, planar: true });
        m.geo(mat, BOX(), part(B, 0, 0, 0, L, h * 0.64, w * 0.24), { color: lin(d.color ?? 0xa4aeb5), planar: true });
      }
      break;
    }
    case 'cable': {
      if (!d.to) break;
      const a = new THREE.Vector3(px, py, pz), b = new THREE.Vector3(d.to[0], d.to[1], d.to[2]);
      const len = a.distanceTo(b), sag = Math.min(3, len * 0.08);
      const pts = [];
      for (let i = 0; i <= 8; i++) { const t = i / 8, p = a.clone().lerp(b, t); p.y -= Math.sin(t * Math.PI) * sag; pts.push(p); }
      const tube = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 16, d.radius ?? 0.07, 5, false);
      m.geo(surf.deco('metal'), tube, new THREE.Matrix4().setPosition(px, py, pz), { color: lin(d.color ?? 0x23282c), planar: true });
      tube.dispose();
      break;
    }
    case 'crate': {
      const s = [sz[0] ?? 1.3, sz[1] ?? 1.3, sz[2] ?? 1.3];
      m.geo(surf.deco('crate'), BOX(), part(B, 0, 0, 0, s[0], s[1], s[2]), { color: lin(d.color ?? palette.wall) });
      break;
    }
    case 'pillar': {
      const w = Math.min(sz[0] ?? 1, sz[2] ?? 1), h = sz[1] ?? 4;
      const mat = surf.deco('concrete'), tint = lin(d.color ?? palette.wall);
      const seg = w > 3 ? 14 : 10;
      m.geo(mat, CYL(seg), part(B, 0, 0, 0, w, h, w), { color: tint, uvMul: [Math.max(1, Math.PI * w / 2), h / 2] });
      const collar = lin(d.color ?? palette.wall, 0.85);
      m.geo(mat, CYL(seg), part(B, 0, -h / 2 + 0.15, 0, w * 1.22, 0.3, w * 1.22), { color: collar, uvMul: [2, 0.3] });
      m.geo(mat, CYL(seg), part(B, 0, h / 2 - 0.15, 0, w * 1.18, 0.3, w * 1.18), { color: collar, uvMul: [2, 0.3] });
      for (let y = -h / 2 + 12; y < h / 2 - 6; y += 12) m.geo(mat, CYL(seg), part(B, 0, y, 0, w * 1.1, 0.5, w * 1.1), { color: collar, uvMul: [2, 0.4] });
      break;
    }
    case 'fan': {
      const dia = sz[0] ?? 3, depth = sz[2] ?? 0.6, rad = dia / 2;
      const mat = surf.deco('metal'), tint = lin(d.color ?? 0x78838a);
      const torus = cached(`fan-t${dia}`, () => new THREE.TorusGeometry(rad, depth * 0.3, 8, 24));
      m.geo(mat, torus, part(B, 0, 0, 0, 1, 1, 1), { color: tint, planar: true });
      m.geo(mat, CYL(10), part(B, 0, 0, 0, rad * 0.22, depth, rad * 0.22, Math.PI / 2, 0, 0), { color: lin(0x586168), planar: true });
      for (const a of [0, Math.PI / 2]) m.geo(mat, BOX(), part(B, 0, 0, -depth * 0.35, dia * 0.98, depth * 0.07, depth * 0.07, 0, 0, a), { color: lin(0x586168), planar: true });
      // the spinning blades
      const blades = new THREE.Group(), inner = new THREE.Group();
      blades.add(inner);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const piece = new THREE.Mesh(BOX(), surf.deco('metal'));
        piece.scale.set(rad * 0.78, rad * 0.22, depth * 0.1);
        piece.position.set(Math.cos(a) * rad * 0.52, Math.sin(a) * rad * 0.52, 0);
        piece.rotation.set(0.5, 0, a);
        piece.castShadow = true;
        inner.add(piece);
      }
      blades.position.set(px, py, pz);
      blades.rotation.y = yaw;
      ctx.parent.add(blades);
      const speed = 3 + hash3(Math.round(px), Math.round(py), Math.round(pz)) * 2;
      ctx.anim.push((dt) => { inner.rotation.z += dt * speed; });
      ctx.disposables.push(blades);
      break;
    }
    case 'rock': {
      const s = [sz[0] ?? 2, sz[1] ?? 1.5, sz[2] ?? 2];
      const v = Math.floor(hash3(Math.round(px * 10), Math.round(py * 10), Math.round(pz * 10)) * 6) % 6;
      m.geo(surf.deco('rock'), rocks()[v], part(B, 0, 0, 0, s[0], s[1], s[2], 0, hash3(Math.round(px), 1, Math.round(pz)) * 6.28, 0), { color: lin(d.color ?? palette.wall, 0.9), planar: true });
      break;
    }
    case 'crystal': {
      const h = sz[1] ?? 2.4, w = Math.min(sz[0] ?? 0.9, sz[2] ?? 0.9);
      const c = d.color ?? palette.glow;
      const mat = surf.material({ base: 'crystal', color: c, trim: c, emissive: c }, false);
      const Bb = part(B, 0, -h / 2, 0, 1, 1, 1), tint = [1, 1, 1];
      crystalShard(ctx, mat, Bb, h, w / 2, tint);
      const rnd = hash3(Math.round(px * 7), Math.round(py * 7), Math.round(pz * 7));
      for (let i = 0; i < 3; i++) {
        const a = rnd * 6 + i * 2.1, k = 0.5 + hash3(i, Math.round(px), Math.round(pz)) * 0.25;
        const Bi = part(Bb, Math.cos(a) * w * 0.35, 0, Math.sin(a) * w * 0.35, 1, 1, 1, Math.sin(a) * 0.35, 0, -Math.cos(a) * 0.35);
        crystalShard(ctx, mat, Bi, h * k, w * 0.3, tint);
      }
      break;
    }
    case 'screen': {
      const w = sz[0] ?? 4, h = sz[1] ?? 2.2, t = sz[2] ?? 0.2;
      m.geo(surf.deco('metal'), BOX(), part(B, 0, 0, 0, w, h, t), { color: lin(0x252c31), planar: true });
      const key = String(glowHex);
      let tex = ctx.screens.get(key);
      if (!tex) { tex = screenTexture(glowHex); ctx.screens.set(key, tex); }
      const face = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.93, h * 0.86), new THREE.MeshBasicMaterial({ map: tex, color: new THREE.Color(1.7, 1.7, 1.7) }));
      face.position.set(px, py, pz); face.rotation.y = yaw;
      face.translateZ(t / 2 + 0.01);
      ctx.parent.add(face);
      ctx.disposables.push(face);
      break;
    }
    case 'arch': {
      const w = sz[0] ?? 8, h = sz[1] ?? 6, dp = sz[2] ?? 0.8;
      const t = Math.min(1.3, Math.max(0.35, w * 0.07));
      const mat = surf.deco('metal'), tint = lin(d.color ? 0xc4ccd2 : palette.wall);
      for (const s of [-1, 1]) m.geo(mat, BOX(), part(B, s * (w / 2 - t / 2), 0, 0, t, h, dp), { color: tint, planar: true });
      m.geo(mat, BOX(), part(B, 0, h / 2 - t * 0.55, 0, w, t * 1.1, dp), { color: tint, planar: true });
      const gl = lin(d.color ?? palette.accent, 2.2), tt = Math.max(0.05, t * 0.12);
      for (const s of [-1, 1]) m.geo(surf.glow, BOX(), part(B, s * (w / 2 - t - tt / 2), -t * 0.55 / 2, dp / 2 + 0.01, tt, h - t * 1.1, tt), { color: gl });
      m.geo(surf.glow, BOX(), part(B, 0, h / 2 - t * 1.1 - tt / 2, dp / 2 + 0.01, w - 2 * t, tt, tt), { color: gl });
      break;
    }
    case 'ring': {
      const dia = sz[0] ?? 6, th = sz[2] ?? 0.4, tube = Math.max(0.05, th / 2);
      const torus = cached(`ring${dia}|${tube}`, () => new THREE.TorusGeometry(Math.max(0.1, dia / 2 - tube), tube, 8, 40));
      m.geo(surf.glow, torus, part(B, 0, 0, 0, 1, 1, 1), { color: lin(glowHex, 2.4) });
      const halo = cached(`ringh${dia}|${tube}`, () => new THREE.TorusGeometry(Math.max(0.1, dia / 2 - tube), tube * 2.6, 6, 40));
      m.geo(surf.halo, halo, part(B, 0, 0, 0, 1, 1, 1), { color: [...lin(glowHex, 1.2), 0.1] });
      break;
    }
    case 'beacon': {
      const w = Math.min(sz[0] ?? 0.6, sz[2] ?? 0.6), h = sz[1] ?? 3;
      m.geo(surf.glow, CYL(8), part(B, 0, 0, 0, w * 0.5, h, w * 0.5), { color: lin(glowHex, 3) });
      m.geo(surf.halo, CYL_OPEN(12), part(B, 0, 0, 0, w * 2.4, h, w * 2.4), { color: [...lin(glowHex, 1), 0.16] });
      m.geo(surf.halo, CYL_OPEN(12), part(B, 0, 0, 0, w * 4.2, h, w * 4.2), { color: [...lin(glowHex, 1), 0.07] });
      m.geo(surf.deco('metal'), CYL(8), part(B, 0, -h / 2 - 0.1, 0, w * 1.5, 0.3, w * 1.5), { color: lin(0x3a4248), planar: true });
      break;
    }
    default: break;
  }
}
