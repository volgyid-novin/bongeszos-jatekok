import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Low-poly models built from primitives with baked vertex colours. 1 unit = 1 tile.
// Units face +Z and stand on y = 0. Buildings are centred on their footprint.

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
const _p = new THREE.Vector3(), _s = new THREE.Vector3(), _c = new THREE.Color();

class Kit {
  constructor() { this.geos = []; }
  put(geo, col, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    _q.setFromEuler(_e.set(rx, ry, rz));
    g.applyMatrix4(_m.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz)));
    if (g.attributes.uv) g.deleteAttribute('uv');
    const n = g.attributes.position.count, arr = new Float32Array(n * 3);
    _c.set(col);
    for (let i = 0; i < n; i++) { arr[i * 3] = _c.r; arr[i * 3 + 1] = _c.g; arr[i * 3 + 2] = _c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    this.geos.push(g);
    return this;
  }
  box(w, h, d, col, x, y, z, rx, ry, rz) { return this.put(new THREE.BoxGeometry(w, h, d), col, x, y, z, rx, ry, rz); }
  cyl(rt, rb, h, seg, col, x, y, z, rx, ry, rz) { return this.put(new THREE.CylinderGeometry(rt, rb, h, seg), col, x, y, z, rx, ry, rz); }
  cone(r, h, seg, col, x, y, z, rx, ry, rz) { return this.put(new THREE.ConeGeometry(r, h, seg), col, x, y, z, rx, ry, rz); }
  ball(r, col, x, y, z, sx = 1, sy = 1, sz = 1, detail = 1) { return this.put(new THREE.IcosahedronGeometry(r, detail), col, x, y, z, 0, 0, 0, sx, sy, sz); }
  rock(r, col, x, y, z, sx = 1, sy = 1, sz = 1, ry = 0) { return this.put(new THREE.DodecahedronGeometry(r, 0), col, x, y, z, 0, ry, 0, sx, sy, sz); }
  // triangular prism roof along X: width w (z), length l (x), height h
  gable(l, w, h, col, x, y, z, ry = 0) {
    const g = new THREE.CylinderGeometry(1, 1, l, 3, 1);
    g.rotateZ(Math.PI / 2);
    g.rotateX(-Math.PI / 2);
    g.scale(1, h / 1.5, w / 1.732);
    g.translate(0, h / 3, 0);
    this.put(g, col, x, y, z, 0, ry, 0);
    // battens on both slopes and a ridge beam, so the roof doesn't read as one flat slab
    const a = Math.atan2(h, w / 2), dark = dim(col, 0.68), sn = Math.sin(ry), cs = Math.cos(ry);
    for (const s of [-1, 1]) for (const t of [0.22, 0.5, 0.78]) {
      const b = new THREE.BoxGeometry(l + 0.02, 0.045, 0.06);
      b.rotateX(s * a);
      const oz = s * (w / 2) * (1 - t), oy = h * t + 0.025;
      this.put(b, dark, x + oz * sn, y + oy, z + oz * cs, 0, ry, 0);
    }
    return this.put(new THREE.BoxGeometry(l + 0.1, 0.09, 0.11), dark, x, y + h, z, 0, ry, 0);
  }
  // 4-sided pyramid roof
  pyramid(w, h, col, x, y, z) { return this.put(new THREE.ConeGeometry(w * 0.7071, h, 4), col, x, y + h / 2, z, 0, Math.PI / 4, 0); }
  geo() {
    const g = mergeGeometries(this.geos);
    for (const x of this.geos) x.dispose();
    g.computeBoundingSphere();
    return g;
  }
}

export const C = {
  stone: 0xa39e92, stoneD: 0x77726a, stoneL: 0xc8c2b4, plaster: 0xeadfc4, wood: 0x7d5434, woodD: 0x4f3521, woodL: 0xa47a4c,
  thatch: 0xd2ad55, steel: 0xc2cad3, steelD: 0x707882, gold: 0xf5c63a, goldD: 0xc28f1e, skin: 0xf0c29d, beard: 0xe8e4dc,
  orc: 0x63953a, orcD: 0x4b7429, troll: 0x4f978a, hide: 0xb88f5c, hideD: 0x8a6840, bone: 0xeee4ca, leather: 0x8a5a36,
  green: 0x3f7a35, cloth: 0x7b5a3a, dark: 0x2b2522, glowO: 0xffa648, glowG: 0x8dff70, glowB: 0xa8ecff, pig: 0xf2a6a2,
  fur: 0x8f877a, furD: 0x605850, white: 0xf4f1ea, purple: 0x7558b8, crop: 0x8cbd3f, cropD: 0x6a9a2f, red: 0xa83224,
  window: 0xffd884, horse: 0xd9d3c7, horseD: 0x8f7a63,
};
const dim = (hex, k) => { _c.set(hex).multiplyScalar(k); return _c.getHex(); };

// ---------- characters ----------
function humanoid(k, o) {
  const s = o.s || 1, b = o.bulk || 1;
  const legH = 0.26 * s, torH = 0.28 * s, top = legH + torH;
  k.box(0.1 * s * b, legH, 0.12 * s, o.legs, -0.07 * s * b, legH / 2, 0);
  k.box(0.1 * s * b, legH, 0.12 * s, o.legs, 0.07 * s * b, legH / 2, 0);
  k.box(0.3 * s * b, torH, 0.2 * s * b, o.body, 0, legH + torH / 2, 0);
  if (o.belt) k.box(0.31 * s * b, 0.05 * s, 0.21 * s * b, o.belt, 0, legH + 0.03 * s, 0);
  k.box(0.08 * s, 0.25 * s, 0.09 * s, o.arms || o.body, -0.2 * s * b, top - 0.12 * s, 0.02);
  k.box(0.08 * s, 0.25 * s, 0.09 * s, o.arms || o.body, 0.2 * s * b, top - 0.12 * s, 0.02);
  const hy = top + 0.11 * s;
  k.ball(0.12 * s, o.skin, 0, hy, 0, 1, 1, 1, 1);
  return { top, hy, s, hr: [0.2 * s * b, top - 0.25 * s, 0.06], hl: [-0.2 * s * b, top - 0.25 * s, 0.06] };
}
function orcHead(k, h, skin) {
  k.box(0.07, 0.04, 0.05, C.bone, -0.05, h.hy - 0.06, 0.1, 0, 0, 0.4);
  k.box(0.07, 0.04, 0.05, C.bone, 0.05, h.hy - 0.06, 0.1, 0, 0, -0.4);
  k.box(0.16, 0.04, 0.05, dim(skin, 0.75), 0, h.hy + 0.04, 0.09);
}

const UNIT_MODELS = {
  peasant(k, t) {
    const h = humanoid(k, { legs: C.cloth, body: C.leather, belt: t, skin: C.skin });
    k.cyl(0.2, 0.2, 0.03, 10, C.thatch, 0, h.hy + 0.08, 0);
    k.cone(0.12, 0.1, 10, C.thatch, 0, h.hy + 0.14, 0);
    // pick
    k.box(0.03, 0.42, 0.03, C.woodL, h.hr[0] + 0.02, h.hr[1] + 0.1, 0.12, 0.5, 0, 0);
    k.box(0.22, 0.04, 0.04, C.steelD, h.hr[0] + 0.02, h.hr[1] + 0.28, 0.24, 0.5, 0, 0);
  },
  footman(k, t) {
    const h = humanoid(k, { legs: C.steelD, body: t, arms: C.steel, belt: C.leather, skin: C.skin, bulk: 1.05 });
    k.ball(0.135, C.steel, 0, h.hy + 0.02, 0, 1, 0.9, 1, 1);
    k.box(0.2, 0.04, 0.03, C.dark, 0, h.hy, 0.11);
    k.box(0.04, 0.06, 0.14, t, 0, h.hy + 0.14, -0.02);
    // shield
    k.box(0.05, 0.3, 0.24, t, h.hl[0] - 0.05, h.hl[1] + 0.1, 0.08);
    k.box(0.06, 0.08, 0.08, C.gold, h.hl[0] - 0.08, h.hl[1] + 0.12, 0.08);
    // sword
    k.box(0.04, 0.04, 0.4, C.steel, h.hr[0] + 0.02, h.hr[1] + 0.05, 0.26);
    k.box(0.14, 0.03, 0.04, C.gold, h.hr[0] + 0.02, h.hr[1] + 0.05, 0.07);
  },
  archer(k, t) {
    const h = humanoid(k, { legs: C.leather, body: C.green, arms: C.green, belt: t, skin: C.skin, s: 0.97 });
    k.cone(0.15, 0.24, 8, C.green, 0, h.hy + 0.1, -0.01);
    k.box(0.28, 0.32, 0.04, t, 0, h.top - 0.1, -0.13);
    k.cyl(0.05, 0.05, 0.3, 6, C.leather, 0.1, h.top, -0.14, 0.4, 0, 0);
    // bow
    k.put(new THREE.TorusGeometry(0.24, 0.018, 4, 10, Math.PI), C.woodD, h.hl[0] - 0.03, h.hl[1] + 0.12, 0.16, 0, Math.PI / 2, Math.PI / 2);
    k.box(0.005, 0.48, 0.005, C.white, h.hl[0] - 0.03, h.hl[1] + 0.12, 0.16);
  },
  knight(k, t) {
    // horse
    k.box(0.34, 0.32, 0.8, C.horse, 0, 0.5, 0);
    k.box(0.38, 0.22, 0.84, t, 0, 0.42, 0);
    for (const [x, z] of [[-0.11, 0.28], [0.11, 0.28], [-0.11, -0.28], [0.11, -0.28]]) k.box(0.09, 0.36, 0.09, C.horseD, x, 0.18, z);
    k.box(0.16, 0.36, 0.18, C.horse, 0, 0.72, 0.4, -0.5, 0, 0);
    k.box(0.14, 0.14, 0.3, C.horse, 0, 0.86, 0.58);
    k.box(0.06, 0.12, 0.08, C.steel, 0, 0.92, 0.52);
    k.box(0.06, 0.3, 0.06, C.horseD, 0, 0.5, -0.43, 0.6, 0, 0);
    // rider
    k.box(0.28, 0.3, 0.22, C.steel, 0, 0.82, -0.05);
    k.box(0.3, 0.12, 0.23, t, 0, 0.74, -0.05);
    k.ball(0.12, C.steel, 0, 1.08, -0.05, 1, 1.05, 1, 1);
    k.box(0.04, 0.18, 0.12, t, 0, 1.24, -0.06);
    k.box(0.22, 0.04, 0.03, C.dark, 0, 1.08, 0.06);
    k.box(0.07, 0.07, 0.2, C.steel, 0.17, 0.82, 0.05);
    // lance and shield
    k.cyl(0.02, 0.045, 1.1, 6, C.woodL, 0.2, 0.88, 0.45, Math.PI / 2 - 0.12, 0, 0);
    k.cone(0.05, 0.16, 6, C.steel, 0.2, 0.95, 1.05, Math.PI / 2 - 0.12, 0, 0);
    k.box(0.05, 0.26, 0.2, t, -0.19, 0.84, 0);
  },
  mage(k, t) {
    k.cyl(0.13, 0.24, 0.5, 8, t, 0, 0.25, 0);
    k.box(0.27, 0.22, 0.19, t, 0, 0.58, 0);
    k.box(0.08, 0.24, 0.09, dim(t, 0.8), -0.19, 0.55, 0.03);
    k.box(0.08, 0.24, 0.09, dim(t, 0.8), 0.19, 0.55, 0.03);
    k.box(0.32, 0.05, 0.2, C.gold, 0, 0.47, 0);
    k.ball(0.11, C.skin, 0, 0.8, 0);
    k.cone(0.07, 0.2, 6, C.beard, 0, 0.67, 0.08, Math.PI, 0, 0);
    k.cyl(0.18, 0.18, 0.03, 10, C.purple, 0, 0.87, 0);
    k.cone(0.12, 0.38, 8, C.purple, 0, 1.06, -0.02, -0.15, 0, 0);
    k.cyl(0.02, 0.025, 1.0, 5, C.woodD, 0.24, 0.5, 0.08);
    k.ball(0.07, C.glowO, 0.24, 1.04, 0.08, 1, 1, 1, 1);
  },
  ballista(k, t) {
    k.box(0.5, 0.12, 1.0, C.wood, 0, 0.32, 0);
    for (const [x, z] of [[-0.3, 0.32], [0.3, 0.32], [-0.3, -0.32], [0.3, -0.32]]) k.cyl(0.17, 0.17, 0.07, 10, C.woodD, x, 0.17, z, 0, 0, Math.PI / 2);
    k.box(0.12, 0.3, 0.12, C.woodD, 0, 0.5, 0.25);
    k.box(1.0, 0.08, 0.1, C.woodL, 0, 0.62, 0.3, 0, 0.35, 0);
    k.box(1.0, 0.08, 0.1, C.woodL, 0, 0.62, 0.3, 0, -0.35, 0);
    k.box(0.9, 0.08, 0.1, C.woodL, 0, 0.62, 0.25);
    k.box(0.12, 0.06, 1.1, C.wood, 0, 0.56, 0.05);
    k.box(0.04, 0.04, 0.9, C.woodL, 0, 0.63, 0.1);
    k.cone(0.05, 0.14, 4, C.steel, 0, 0.63, 0.6, Math.PI / 2, 0, 0);
    k.cyl(0.015, 0.015, 0.6, 4, C.woodD, -0.22, 0.65, -0.4);
    k.box(0.02, 0.16, 0.24, t, -0.22, 0.86, -0.3);
  },
  peon(k, t) {
    const h = humanoid(k, { legs: C.hideD, body: C.orc, arms: C.orc, belt: t, skin: C.orc, bulk: 1.05 });
    orcHead(k, h, C.orc);
    k.box(0.32, 0.12, 0.22, C.hide, 0, h.top - 0.22, 0);
    k.box(0.03, 0.42, 0.03, C.woodL, h.hr[0] + 0.02, h.hr[1] + 0.1, 0.12, 0.5, 0, 0);
    k.box(0.22, 0.05, 0.04, C.steelD, h.hr[0] + 0.02, h.hr[1] + 0.28, 0.24, 0.5, 0, 0);
  },
  grunt(k, t) {
    const h = humanoid(k, { legs: C.hideD, body: C.orc, arms: C.orc, belt: C.leather, skin: C.orc, bulk: 1.3, s: 1.05 });
    orcHead(k, h, C.orc);
    k.box(0.36, 0.12, 0.25, C.leather, 0, h.top - 0.06, 0);
    for (const sx of [-1, 1]) {
      k.box(0.16, 0.08, 0.2, t, sx * 0.26, h.top + 0.02, 0);
      k.cone(0.04, 0.12, 4, C.bone, sx * 0.3, h.top + 0.1, 0);
    }
    k.box(0.04, 0.6, 0.04, C.woodD, h.hr[0] + 0.04, h.hr[1] + 0.12, 0.12, 0.6, 0, 0);
    k.box(0.04, 0.2, 0.18, C.steel, h.hr[0] + 0.04, h.hr[1] + 0.3, 0.34, 0.6, 0, 0);
  },
  axethrower(k, t) {
    const h = humanoid(k, { legs: C.hideD, body: C.troll, arms: C.troll, belt: t, skin: C.troll, s: 1.05, bulk: 0.9 });
    k.box(0.05, 0.12, 0.22, 0xe0562a, 0, h.hy + 0.1, -0.02);
    k.cone(0.03, 0.14, 4, C.troll, -0.12, h.hy + 0.05, 0, 0, 0, 1.2);
    k.cone(0.03, 0.14, 4, C.troll, 0.12, h.hy + 0.05, 0, 0, 0, -1.2);
    k.box(0.03, 0.04, 0.06, C.bone, -0.04, h.hy - 0.06, 0.1);
    k.box(0.03, 0.04, 0.06, C.bone, 0.04, h.hy - 0.06, 0.1);
    k.box(0.3, 0.1, 0.22, t, 0, h.top - 0.25, 0);
    for (const sx of [-1, 1]) {
      k.box(0.03, 0.2, 0.03, C.woodD, sx * (h.hr[0] + 0.02), h.hr[1] + 0.05, 0.08);
      k.box(0.03, 0.08, 0.12, C.steel, sx * (h.hr[0] + 0.02), h.hr[1] + 0.13, 0.12);
    }
  },
  wolfrider(k, t) {
    // wolf
    k.box(0.32, 0.3, 0.78, C.fur, 0, 0.45, -0.02);
    k.box(0.36, 0.2, 0.3, C.furD, 0, 0.6, 0.2);
    for (const [x, z] of [[-0.1, 0.26], [0.1, 0.26], [-0.1, -0.28], [0.1, -0.28]]) k.box(0.08, 0.32, 0.09, C.furD, x, 0.16, z);
    k.box(0.22, 0.2, 0.24, C.fur, 0, 0.62, 0.48);
    k.box(0.14, 0.1, 0.18, C.furD, 0, 0.56, 0.66);
    k.cone(0.05, 0.12, 4, C.furD, -0.07, 0.78, 0.44);
    k.cone(0.05, 0.12, 4, C.furD, 0.07, 0.78, 0.44);
    k.box(0.07, 0.07, 0.36, C.fur, 0, 0.55, -0.52, 0.5, 0, 0);
    k.box(0.36, 0.06, 0.34, t, 0, 0.62, -0.08);
    // rider
    k.box(0.32, 0.3, 0.22, C.orc, 0, 0.82, -0.1);
    k.box(0.34, 0.1, 0.24, C.leather, 0, 0.72, -0.1);
    k.ball(0.12, C.orc, 0, 1.06, -0.08);
    k.box(0.07, 0.04, 0.05, C.bone, -0.05, 1.0, 0.03, 0, 0, 0.4);
    k.box(0.07, 0.04, 0.05, C.bone, 0.05, 1.0, 0.03, 0, 0, -0.4);
    k.box(0.16, 0.08, 0.2, t, -0.22, 0.95, -0.1);
    k.box(0.16, 0.08, 0.2, t, 0.22, 0.95, -0.1);
    k.box(0.04, 0.5, 0.04, C.woodD, 0.24, 0.9, 0.1, 0.7, 0, 0);
    k.box(0.04, 0.18, 0.16, C.steel, 0.24, 1.06, 0.28, 0.7, 0, 0);
  },
  shaman(k, t) {
    k.cyl(0.14, 0.24, 0.48, 7, t, 0, 0.24, 0);
    k.box(0.3, 0.24, 0.22, dim(t, 0.85), 0, 0.56, -0.02, 0.25, 0, 0);
    k.box(0.08, 0.24, 0.09, C.orc, -0.2, 0.52, 0.04);
    k.box(0.08, 0.24, 0.09, C.orc, 0.2, 0.52, 0.04);
    k.ball(0.11, C.orc, 0, 0.76, 0.06);
    k.box(0.17, 0.15, 0.06, C.bone, 0, 0.76, 0.15);
    k.box(0.04, 0.03, 0.02, C.dark, -0.04, 0.78, 0.18);
    k.box(0.04, 0.03, 0.02, C.dark, 0.04, 0.78, 0.18);
    for (const a of [-0.5, 0, 0.5]) k.box(0.03, 0.2, 0.02, a ? 0xd8452c : 0xffffff, a * 0.2, 0.92, -0.04, 0, 0, a);
    k.cyl(0.02, 0.025, 1.0, 5, C.woodD, 0.25, 0.5, 0.1);
    k.ball(0.06, C.bone, 0.25, 1.02, 0.1);
    k.ball(0.06, C.glowG, 0.25, 1.12, 0.1, 1, 1, 1, 1);
  },
  catapult(k, t) {
    k.box(0.56, 0.12, 1.0, C.woodD, 0, 0.3, 0);
    for (const [x, z] of [[-0.32, 0.32], [0.32, 0.32], [-0.32, -0.32], [0.32, -0.32]]) k.cyl(0.18, 0.18, 0.08, 9, C.dark, x, 0.18, z, 0, 0, Math.PI / 2);
    k.box(0.08, 0.36, 0.08, C.wood, -0.2, 0.52, 0.1);
    k.box(0.08, 0.36, 0.08, C.wood, 0.2, 0.52, 0.1);
    k.box(0.5, 0.07, 0.07, C.wood, 0, 0.7, 0.1);
    k.box(0.07, 0.07, 0.95, C.woodL, 0, 0.62, -0.08, -0.35, 0, 0);
    k.box(0.2, 0.08, 0.2, C.woodD, 0, 0.78, -0.52);
    k.ball(0.1, C.stoneD, 0, 0.88, -0.52);
    k.ball(0.08, C.bone, 0, 0.46, 0.52);
    for (const x of [-0.24, 0.24]) k.cone(0.04, 0.16, 4, C.bone, x, 0.36, 0.56, Math.PI / 2, 0, 0);
    k.cyl(0.015, 0.015, 0.6, 4, C.woodD, 0.24, 0.66, -0.35);
    k.box(0.02, 0.18, 0.24, t, 0.24, 0.88, -0.24);
  },
};

// ---------- buildings ----------
function crenels(k, w, d, y, col, step = 0.32) {
  for (let x = -w / 2 + 0.08; x <= w / 2 - 0.08; x += step) { k.box(0.14, 0.14, 0.14, col, x, y, -d / 2 + 0.07); k.box(0.14, 0.14, 0.14, col, x, y, d / 2 - 0.07); }
  for (let z = -d / 2 + 0.4; z <= d / 2 - 0.4; z += step) { k.box(0.14, 0.14, 0.14, col, -w / 2 + 0.07, y, z); k.box(0.14, 0.14, 0.14, col, w / 2 - 0.07, y, z); }
}
function flag(k, t, x, y, z, h = 0.9) {
  k.cyl(0.025, 0.025, h, 5, C.woodD, x, y + h / 2, z);
  k.box(0.02, 0.24, 0.36, t, x, y + h - 0.14, z + 0.18);
}
function spikes(k, r, n, y, col, h = 0.35, seg = 4) {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    k.cone(0.07, h, seg, col, Math.cos(a) * r, y, Math.sin(a) * r, Math.sin(a) * 0.35, 0, -Math.cos(a) * 0.35);
  }
}
function palisade(k, w, d, col, gap) {
  const post = (x, z) => k.cone(0.09, 0.7, 5, col, x, 0.35, z);
  for (let x = -w / 2; x <= w / 2 + 1e-6; x += 0.22) { if (!gap || Math.abs(x) > gap) post(x, d / 2); post(x, -d / 2); }
  for (let z = -d / 2 + 0.22; z < d / 2 - 1e-6; z += 0.22) { post(-w / 2, z); post(w / 2, z); }
}

const BUILDING_MODELS = {
  townhall(k, t) {
    k.box(3.5, 0.2, 3.5, C.stoneD, 0, 0.1, 0);
    k.box(3.2, 1.1, 3.0, C.stone, 0, 0.75, 0);
    k.box(2.9, 0.9, 2.7, C.plaster, 0, 1.75, 0);
    for (const x of [-1.4, -0.47, 0.47, 1.4]) k.box(0.1, 0.9, 2.74, C.woodD, x, 1.75, 0);
    k.box(2.94, 0.1, 2.74, C.woodD, 0, 2.2, 0);
    k.gable(3.2, 3.2, 1.3, t, 0, 2.2, 0, Math.PI / 2);
    k.box(0.7, 0.8, 0.12, C.woodD, 0, 0.6, 1.5);
    k.box(0.5, 0.2, 0.14, C.stoneD, 0, 1.05, 1.5);
    for (const x of [-1, 1]) { k.box(0.35, 0.3, 0.08, C.window, x, 0.85, 1.51); k.box(0.3, 0.3, 0.08, C.window, x, 1.8, 1.36); }
    k.cyl(0.55, 0.6, 2.8, 8, C.stoneL, 1.35, 1.4, -1.25);
    k.cone(0.72, 1.1, 8, t, 1.35, 3.35, -1.25);
    k.box(0.2, 0.25, 0.08, C.window, 1.35, 2.3, -0.7);
    k.box(0.3, 0.8, 0.3, C.stoneD, -1.0, 2.8, -0.6);
    flag(k, t, 1.35, 3.8, -1.25, 0.8);
    crenels(k, 3.2, 3.0, 1.37, C.stoneL, 0.45);
  },
  farm(k, t) {
    k.box(1.0, 0.55, 0.8, C.plaster, -0.35, 0.28, -0.4);
    k.gable(1.15, 1.0, 0.55, C.thatch, -0.35, 0.55, -0.4);
    k.box(0.22, 0.32, 0.06, C.woodD, -0.35, 0.16, 0.01);
    k.box(0.06, 0.05, 0.84, t, 0.18, 0.62, -0.4);
    for (let r = 0; r < 4; r++) k.box(0.22, 0.14, 0.9, r % 2 ? C.crop : C.cropD, 0.3 + (r % 2) * 0.24, 0.07, 0.35 - (r >> 1) * 0.04, 0, 0, 0);
    for (let x = -0.85; x <= 0.86; x += 0.34) k.box(0.05, 0.25, 0.05, C.woodL, x, 0.12, 0.88);
    k.box(1.75, 0.04, 0.03, C.woodL, 0, 0.18, 0.88);
    k.cyl(0.18, 0.2, 0.5, 8, C.woodL, 0.6, 0.25, -0.55);
    k.cone(0.24, 0.3, 8, t, 0.6, 0.65, -0.55);
  },
  barracks(k, t) {
    k.box(2.7, 0.14, 2.2, C.stoneD, 0, 0.07, -0.2);
    k.box(2.5, 1.0, 1.7, C.stone, 0, 0.6, -0.35);
    crenels(k, 2.5, 1.7, 1.17, C.stoneL, 0.36);
    k.box(1.0, 0.7, 1.0, C.stoneL, -0.7, 1.45, -0.5);
    k.pyramid(1.15, 0.7, t, -0.7, 1.8, -0.5);
    k.box(0.6, 0.7, 0.1, C.woodD, 0.4, 0.45, 0.51);
    for (const x of [-0.6, 1.0]) { k.box(0.04, 0.6, 0.3, t, x, 0.7, 0.52); k.box(0.05, 0.12, 0.08, C.gold, x, 0.92, 0.55); }
    // training yard
    k.cyl(0.24, 0.24, 0.05, 12, C.white, 0.9, 0.42, 1.0, Math.PI / 2, 0, 0);
    k.cyl(0.14, 0.14, 0.06, 12, C.red, 0.9, 0.42, 1.01, Math.PI / 2, 0, 0);
    k.box(0.05, 0.4, 0.05, C.woodD, 0.9, 0.2, 0.96);
    k.box(0.05, 0.5, 0.05, C.woodD, -0.8, 0.25, 1.0);
    k.box(0.4, 0.05, 0.05, C.woodD, -0.8, 0.45, 1.0);
    k.box(0.3, 0.4, 0.2, C.steelD, -0.8, 0.28, 1.0);
    flag(k, t, 1.15, 1.2, -1.1, 0.9);
  },
  blacksmith(k, t) {
    k.box(2.6, 0.12, 2.4, C.stoneD, 0, 0.06, 0);
    k.box(2.0, 0.85, 1.5, C.woodL, -0.2, 0.5, -0.35);
    for (const x of [-1.15, -0.2, 0.75]) k.box(0.1, 0.85, 1.54, C.woodD, x, 0.5, -0.35);
    k.gable(2.2, 1.8, 0.75, t, -0.2, 0.93, -0.35);
    k.box(0.5, 1.9, 0.5, C.stoneD, 0.85, 0.95, -0.85);
    k.box(0.6, 0.12, 0.6, C.stone, 0.85, 1.9, -0.85);
    k.box(0.5, 0.35, 0.5, C.glowO, 0.55, 0.3, 0.45);
    k.box(0.7, 0.2, 0.7, C.stoneD, 0.55, 0.55, 0.45);
    k.box(0.3, 0.16, 0.14, C.dark, -0.5, 0.36, 0.75);
    k.box(0.12, 0.2, 0.12, C.dark, -0.5, 0.2, 0.75);
    k.cyl(0.14, 0.14, 0.3, 8, C.woodD, -1.0, 0.27, 0.7);
    k.cyl(0.14, 0.14, 0.3, 8, C.woodD, -0.75, 0.27, 0.95);
    k.box(0.35, 0.4, 0.05, C.woodD, 0.15, 0.32, 1.05);
    k.box(0.04, 0.3, 0.1, C.steel, 0.05, 0.4, 1.09);
    k.box(0.04, 0.3, 0.1, C.steel, 0.25, 0.4, 1.09);
  },
  tower(k, t) {
    k.cyl(0.78, 0.85, 0.3, 10, C.stoneD, 0, 0.15, 0);
    k.cyl(0.6, 0.72, 2.4, 10, C.stone, 0, 1.5, 0);
    k.cyl(0.78, 0.66, 0.35, 10, C.stoneL, 0, 2.85, 0);
    for (let i = 0; i < 10; i++) { const a = (i / 10) * Math.PI * 2; k.box(0.2, 0.2, 0.2, C.stoneL, Math.cos(a) * 0.68, 3.1, Math.sin(a) * 0.68, 0, -a, 0); }
    k.cone(0.66, 1.0, 10, t, 0, 3.6, 0);
    for (const a of [0, 2.1, 4.2]) k.box(0.08, 0.36, 0.08, C.dark, Math.cos(a) * 0.66, 1.9, Math.sin(a) * 0.66, 0, -a, 0);
    k.box(0.36, 0.55, 0.1, C.woodD, 0, 0.45, 0.68);
    flag(k, t, 0, 4.0, 0, 0.6);
  },
  magetower(k, t) {
    k.cyl(1.2, 1.3, 0.3, 12, C.stoneD, 0, 0.15, 0);
    k.cyl(0.9, 1.05, 0.9, 12, C.stoneL, 0, 0.75, 0);
    k.cyl(0.5, 0.7, 2.4, 10, 0xd9d2e8, 0, 2.3, 0);
    k.cyl(0.62, 0.52, 0.18, 10, C.purple, 0, 1.4, 0);
    k.cyl(0.56, 0.48, 0.16, 10, C.purple, 0, 2.6, 0);
    k.cone(0.62, 1.4, 10, t, 0, 4.2, 0);
    k.ball(0.22, C.glowB, 0, 5.2, 0, 1, 1.3, 1, 1);
    for (const a of [0.4, 2.5, 4.6]) k.box(0.12, 0.3, 0.08, C.glowB, Math.cos(a) * 0.52, 2.0, Math.sin(a) * 0.52, 0, -a, 0);
    k.box(0.5, 0.7, 0.12, C.woodD, 0, 0.5, 1.0);
    for (const a of [1.2, 3.4, 5.5]) k.rock(0.18, C.purple, Math.cos(a) * 1.1, 0.3, Math.sin(a) * 1.1, 0.8, 1.6, 0.8);
  },
  greathall(k, t) {
    k.cyl(1.75, 1.85, 0.2, 10, C.hideD, 0, 0.1, 0);
    k.cyl(1.5, 1.6, 1.1, 10, C.woodD, 0, 0.75, 0);
    k.cone(1.95, 1.9, 10, C.hide, 0, 2.25, 0);
    k.cone(0.7, 0.8, 8, C.hideD, 0, 3.4, 0);
    spikes(k, 1.75, 10, 1.45, C.bone, 0.5);
    for (const sx of [-1, 1]) {
      k.box(0.12, 1.3, 0.12, C.woodD, sx * 0.55, 0.65, 1.6);
      k.cone(0.09, 0.7, 5, C.bone, sx * 0.45, 1.5, 1.65, 0, 0, sx * 0.8);
    }
    k.box(0.9, 0.9, 0.2, C.dark, 0, 0.45, 1.5);
    k.ball(0.16, C.bone, 0, 1.15, 1.66);
    k.box(0.9, 0.12, 0.12, C.woodD, 0, 1.3, 1.62);
    for (const [x, z] of [[-1.7, -1.7], [1.7, -1.7], [-1.7, 1.7], [1.7, 1.7]]) {
      k.cyl(0.08, 0.1, 1.8, 6, C.woodD, x, 0.9, z);
      k.box(0.03, 0.9, 0.5, t, x, 1.25, z + 0.25 * Math.sign(-z));
      k.ball(0.11, C.bone, x, 1.9, z);
    }
    for (const a of [0.8, 2.4, 3.9, 5.5]) k.box(0.06, 0.7, 0.4, t, Math.cos(a) * 1.58, 0.85, Math.sin(a) * 1.58, 0, -a, 0);
  },
  pigfarm(k, t) {
    k.ball(0.55, C.hideD, -0.35, 0.05, -0.35, 1, 0.9, 1, 1);
    k.cone(0.5, 0.6, 7, C.hide, -0.35, 0.65, -0.35);
    k.box(0.28, 0.3, 0.1, C.dark, -0.35, 0.15, 0.17);
    k.box(0.04, 0.2, 0.2, t, -0.35, 0.92, -0.35);
    for (let x = -0.85; x <= 0.86; x += 0.28) { k.box(0.06, 0.32, 0.06, C.woodD, x, 0.16, 0.85); }
    for (let z = -0.1; z <= 0.86; z += 0.28) { k.box(0.06, 0.32, 0.06, C.woodD, 0.85, 0.16, z); }
    k.box(1.7, 0.05, 0.04, C.wood, 0, 0.24, 0.85);
    k.box(0.04, 0.05, 1.0, C.wood, 0.85, 0.24, 0.38);
    for (const [x, z, r] of [[0.35, 0.4, 0.4], [-0.05, 0.6, -0.8]]) {
      k.box(0.24, 0.18, 0.36, C.pig, x, 0.15, z, 0, r, 0);
      k.box(0.12, 0.1, 0.06, dim(C.pig, 0.8), x + Math.sin(r) * 0.2, 0.17, z + Math.cos(r) * 0.2, 0, r, 0);
    }
    k.box(0.5, 0.06, 0.4, C.thatch, 0.5, 0.03, -0.5);
  },
  warcamp(k, t) {
    k.box(2.6, 0.14, 2.2, C.hideD, 0, 0.07, -0.2);
    for (let z = -1.0; z <= 0.41; z += 0.2) k.cyl(0.1, 0.1, 2.3, 6, z % 0.4 ? C.wood : C.woodD, 0, 0.5, z, 0, 0, Math.PI / 2);
    k.box(2.3, 0.9, 1.5, C.woodD, 0, 0.45, -0.3);
    k.gable(2.6, 1.9, 0.9, C.hide, 0, 0.9, -0.3);
    for (let x = -1.1; x <= 1.11; x += 0.37) k.cone(0.06, 0.4, 4, C.bone, x, 1.95, -0.3);
    k.box(0.6, 0.7, 0.1, C.dark, 0, 0.35, 0.47);
    for (const sx of [-1, 1]) { k.cone(0.08, 0.9, 5, C.bone, sx * 0.4, 0.75, 0.6, 0, 0, sx * 0.5); k.box(0.04, 0.6, 0.36, t, sx * 1.0, 0.6, 0.47); }
    k.box(0.05, 0.6, 0.05, C.woodD, -0.8, 0.3, 1.0);
    k.box(0.5, 0.05, 0.05, C.woodD, -0.8, 0.55, 1.0);
    k.ball(0.1, C.bone, -0.8, 0.68, 1.0);
    k.ball(0.1, C.bone, 0.85, 0.12, 0.95);
    flag(k, t, 1.15, 0, 1.0, 1.4);
  },
  forge(k, t) {
    k.box(2.6, 0.12, 2.4, C.hideD, 0, 0.06, 0);
    k.cyl(0.8, 0.95, 1.1, 8, C.stoneD, -0.4, 0.6, -0.4);
    k.box(0.8, 0.5, 0.2, C.glowO, -0.4, 0.45, 0.4);
    k.cyl(0.35, 0.45, 1.3, 7, C.stoneD, -0.4, 1.7, -0.5);
    k.ball(0.22, C.bone, -0.4, 2.4, -0.5);
    k.box(1.2, 0.08, 1.2, C.woodD, 0.75, 1.1, 0.3, 0.2, 0, 0);
    for (const [x, z] of [[0.25, -0.2], [1.25, -0.2], [0.25, 0.8], [1.25, 0.8]]) k.cyl(0.06, 0.07, 1.1, 5, C.woodD, x, 0.55, z);
    k.box(1.25, 0.05, 1.25, t, 0.75, 1.17, 0.3, 0.2, 0, 0);
    spikes(k, 0.85, 7, 1.2, C.bone, 0.35);
    k.box(0.5, 0.2, 0.25, C.dark, 0.7, 0.4, 0.3);
    k.box(0.18, 0.25, 0.18, C.dark, 0.7, 0.18, 0.3);
    k.box(0.08, 0.4, 0.6, C.steelD, 1.15, 0.3, -0.85, 0, 0, 0.3);
    k.cyl(0.15, 0.15, 0.35, 8, C.wood, -1.0, 0.22, 0.85);
  },
  watchtower(k, t) {
    for (const [x, z] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) k.cyl(0.08, 0.11, 2.2, 6, C.woodD, x, 1.1, z, x * 0.12, 0, -z * 0.12);
    k.box(1.2, 0.1, 0.05, C.wood, 0, 0.8, 0.5, 0, 0, 0.6);
    k.box(1.2, 0.1, 0.05, C.wood, 0, 0.8, -0.5, 0, 0, -0.6);
    k.box(1.4, 0.14, 1.4, C.wood, 0, 2.2, 0);
    for (let i = 0; i < 16; i++) {
      const s = i % 4, f = (i >> 2) / 4 - 0.375;
      const x = s === 0 ? f * 1.6 : s === 1 ? 0.65 : s === 2 ? -f * 1.6 : -0.65;
      const z = s === 0 ? 0.65 : s === 1 ? f * 1.6 : s === 2 ? -0.65 : -f * 1.6;
      k.cone(0.07, 0.55, 5, C.woodD, x, 2.55, z);
    }
    k.cone(0.95, 0.8, 4, C.hide, 0, 3.25, 0, 0, Math.PI / 4, 0);
    k.cyl(0.03, 0.03, 0.9, 4, C.woodD, 0.55, 3.4, 0.55);
    k.box(0.02, 0.26, 0.4, t, 0.55, 3.7, 0.75);
    k.ball(0.12, C.bone, 0, 2.15, 0.72);
  },
  spirit(k, t) {
    k.box(2.6, 0.12, 2.4, C.hideD, 0, 0.06, 0);
    k.cyl(0.9, 1.05, 0.8, 7, C.hideD, -0.4, 0.45, -0.3);
    k.cone(1.15, 1.4, 7, t, -0.4, 1.5, -0.3);
    for (let i = 0; i < 7; i++) { const a = (i / 7) * Math.PI * 2; k.cyl(0.03, 0.03, 0.9, 4, C.woodD, -0.4 + Math.cos(a) * 0.5, 2.0, -0.3 + Math.sin(a) * 0.5, Math.sin(a) * 0.5, 0, -Math.cos(a) * 0.5); }
    k.box(0.4, 0.5, 0.1, C.dark, -0.4, 0.25, 0.68);
    // totem
    const tx = 0.85, tz = 0.6;
    k.box(0.36, 0.5, 0.36, C.woodD, tx, 0.25, tz);
    k.box(0.4, 0.45, 0.4, C.wood, tx, 0.72, tz);
    k.box(0.36, 0.4, 0.36, C.woodD, tx, 1.15, tz);
    k.box(0.9, 0.08, 0.14, C.woodL, tx, 1.0, tz);
    for (const y of [0.3, 0.75, 1.18]) { k.box(0.08, 0.06, 0.04, C.glowG, tx - 0.08, y + 0.06, tz + 0.2); k.box(0.08, 0.06, 0.04, C.glowG, tx + 0.08, y + 0.06, tz + 0.2); }
    k.ball(0.18, C.bone, tx, 1.5, tz);
    k.ball(0.14, C.glowG, tx, 1.82, tz, 1, 1, 1, 1);
    for (const [x, z] of [[0.9, -0.8], [-1.1, 0.8], [0.2, 1.0]]) { k.box(0.04, 0.5, 0.04, C.woodD, x, 0.25, z); k.ball(0.08, C.bone, x, 0.55, z); }
    k.box(0.04, 0.4, 0.3, t, 0.9, 0.4, -0.65);
  },
};

export const EXTRA_MODELS = {
  mine(k) {
    k.rock(1.3, 0x77706a, 0, 0.35, -0.2, 1.1, 0.75, 1.0, 0.3);
    k.rock(0.9, 0x8a8278, -0.8, 0.3, 0.3, 1, 0.8, 1, 1.1);
    k.rock(0.8, 0x6d665e, 0.9, 0.25, 0.4, 1, 0.75, 1, 2.0);
    k.rock(0.6, 0x8a8278, 0.5, 0.9, -0.5, 1, 1, 1, 0.7);
    for (const [x, y, z, r] of [[-0.6, 0.85, -0.1, 0.16], [0.7, 0.75, 0.0, 0.14], [0.2, 1.25, -0.3, 0.18], [-1.0, 0.45, 0.75, 0.12], [1.1, 0.4, 0.85, 0.12], [-0.2, 1.0, 0.35, 0.12]]) {
      k.ball(r, C.gold, x, y, z, 1, 1, 1, 0);
    }
    k.box(0.75, 0.75, 0.3, C.dark, 0, 0.38, 0.95);
    k.box(0.12, 0.85, 0.14, C.woodD, -0.42, 0.42, 1.05);
    k.box(0.12, 0.85, 0.14, C.woodD, 0.42, 0.42, 1.05);
    k.box(1.0, 0.14, 0.16, C.woodD, 0, 0.86, 1.05);
    k.box(0.4, 0.22, 0.3, C.wood, 0.95, 0.2, 1.3);
    k.ball(0.12, C.gold, 0.95, 0.35, 1.3, 1.2, 0.6, 1, 0);
  },
  sack(k) { k.ball(0.12, C.goldD, 0, 0.62, -0.17, 1, 1.1, 0.9); k.ball(0.06, C.gold, 0, 0.74, -0.12); },
  logs(k) { for (const y of [0.56, 0.66]) k.cyl(0.05, 0.05, 0.42, 6, C.woodL, 0, y, -0.16, 0, 0, Math.PI / 2); },
};

export const TREE_MODELS = {
  pine(k) {
    k.cyl(0.07, 0.1, 0.5, 5, C.woodD, 0, 0.25, 0);
    k.cone(0.5, 0.9, 7, 0xffffff, 0, 0.85, 0);
    k.cone(0.38, 0.75, 7, 0xffffff, 0, 1.3, 0);
    k.cone(0.24, 0.55, 7, 0xffffff, 0, 1.7, 0);
  },
  leaf(k) {
    k.cyl(0.07, 0.11, 0.7, 5, C.woodD, 0, 0.35, 0);
    k.ball(0.5, 0xffffff, 0, 1.05, 0, 1, 0.85, 1, 1);
    k.ball(0.32, 0xffffff, 0.22, 1.35, 0.1, 1, 1, 1, 0);
  },
  stump(k) { k.cyl(0.11, 0.13, 0.16, 6, C.wood, 0, 0.08, 0); },
  boulder(k) {
    k.rock(0.42, 0xffffff, 0, 0.22, 0, 1.1, 0.7, 1, 0.4);
    k.rock(0.25, 0xffffff, 0.3, 0.14, 0.25, 1, 0.8, 1, 1.3);
  },
};

const cache = new Map();
export function unitGeo(type, team) {
  const key = type + ':' + team;
  if (!cache.has(key)) {
    const k = new Kit();
    (UNIT_MODELS[type] || BUILDING_MODELS[type] || EXTRA_MODELS[type] || TREE_MODELS[type])(k, team);
    cache.set(key, k.geo());
  }
  return cache.get(key);
}

// wooden scaffolding shown around buildings under construction
export function scaffoldGeo(size) {
  const key = 'scaffold:' + size;
  if (cache.has(key)) return cache.get(key);
  const k = new Kit(), h = size * 0.7, e = size / 2 - 0.15;
  for (const [x, z] of [[-e, -e], [e, -e], [-e, e], [e, e], [0, -e], [0, e], [-e, 0], [e, 0]]) k.box(0.07, h, 0.07, C.woodL, x, h / 2, z);
  for (const y of [h * 0.35, h * 0.7, h]) {
    k.box(size - 0.3, 0.05, 0.05, C.woodL, 0, y, -e); k.box(size - 0.3, 0.05, 0.05, C.woodL, 0, y, e);
    k.box(0.05, 0.05, size - 0.3, C.woodL, -e, y, 0); k.box(0.05, 0.05, size - 0.3, C.woodL, e, y, 0);
  }
  k.box(size - 0.2, 0.06, size - 0.2, C.woodD, 0, 0.03, 0);
  const g = k.geo();
  cache.set(key, g);
  return g;
}

export const modelHeight = (type) => {
  const g = unitGeo(type, 0x888888);
  if (!g.boundingBox) g.computeBoundingBox();
  return g.boundingBox.max.y;
};
