import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { comicMat } from './toon.js';
import { TEAMS } from './data.js';

// Characters and buildings built from primitives with baked vertex colours (chunky comic proportions).
// A character is a rig of pivots: root > body > { torso, head, armL > handL, armR > handR, legL, legR, cape }.
// Everything faces +Z and stands on y = 0. view.js animates the pivots.

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
const _p = new THREE.Vector3(), _s = new THREE.Vector3(), _c = new THREE.Color();

export class Kit {
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
  ball(r, col, x, y, z, sx = 1, sy = 1, sz = 1, det = 2) { return this.put(new THREE.IcosahedronGeometry(r, det), col, x, y, z, 0, 0, 0, sx, sy, sz); }
  sph(r, col, x, y, z, sx = 1, sy = 1, sz = 1, ws = 14, hs = 10) { return this.put(new THREE.SphereGeometry(r, ws, hs), col, x, y, z, 0, 0, 0, sx, sy, sz); }
  rock(r, col, x, y, z, sx = 1, sy = 1, sz = 1, ry = 0) { return this.put(new THREE.DodecahedronGeometry(r, 0), col, x, y, z, 0, ry, 0, sx, sy, sz); }
  tor(r, t, arc, col, x, y, z, rx, ry, rz) { return this.put(new THREE.TorusGeometry(r, t, 6, 16, arc), col, x, y, z, rx, ry, rz); }
  // a limb from (0,0,0) going down -y, length l, tapering
  limb(r0, r1, l, col, x = 0, z = 0) { return this.cyl(r1, r0, l, 10, col, x, -l / 2, z); }
  geo() {
    if (!this.geos.length) return null;
    const g = mergeGeometries(this.geos);
    for (const x of this.geos) x.dispose();
    this.geos = [];
    g.computeBoundingSphere();
    return g;
  }
}

const hex = (c) => new THREE.Color(c).getHex();
function dim(c, k) { _c.set(c); return _c.multiplyScalar(k).getHex(); }

// ---------- rig helpers ----------
function pivot(parent, x, y, z) { const g = new THREE.Group(); g.position.set(x, y, z); parent.add(g); return g; }
function meshOn(parent, kit, mat) {
  const g = kit.geo();
  if (!g) return null;
  const m = new THREE.Mesh(g, mat);
  m.castShadow = true; m.receiveShadow = true;
  parent.add(m);
  return m;
}

// a humanoid rig with the given proportions; the builder fills each part's kit
function humanoid(spec, mat, build) {
  const root = new THREE.Group();
  const body = pivot(root, 0, 0, 0);
  const torso = pivot(body, 0, spec.hip, 0);
  const head = pivot(torso, 0, spec.neck, 0);
  const armL = pivot(torso, spec.sh, spec.shY, 0);
  const armR = pivot(torso, -spec.sh, spec.shY, 0);
  const handL = pivot(armL, 0, -spec.arm, 0);
  const handR = pivot(armR, 0, -spec.arm, 0);
  const legL = pivot(body, spec.hipW, spec.hip, 0);
  const legR = pivot(body, -spec.hipW, spec.hip, 0);
  const cape = pivot(torso, 0, spec.shY + 0.05, -spec.back);
  const parts = { root, body, torso, head, armL, armR, handL, handR, legL, legR, cape };
  const kits = {};
  for (const k of ['torso', 'head', 'armL', 'armR', 'handL', 'handR', 'legL', 'legR', 'cape', 'extra']) kits[k] = new Kit();
  build(kits, spec);
  for (const k of ['torso', 'head', 'armL', 'armR', 'handL', 'handR', 'legL', 'legR', 'cape']) meshOn(parts[k], kits[k], mat);
  return { parts, spec, kits };
}

// ============================================================
//  Heroes
// ============================================================
// team: 0/1. Returns { root, parts, mat, height, kind }
export function buildHero(id, team) {
  const mat = comicMat({ vc: true, paint: 0.35, hatch: 0.55, rim: 0.55 });
  const tc = TEAMS[team].hex, tcd = dim(tc, 0.62);
  let rig;
  if (id === 'granit') rig = granitRig(mat, tc, tcd);
  else if (id === 'parazs') rig = parazsRig(mat, tc, tcd);
  else if (id === 'solyom') rig = solyomRig(mat, tc, tcd);
  else rig = arnyRig(mat, tc, tcd);
  rig.mat = mat;
  rig.root.userData.rig = rig;
  return rig;
}

function granitRig(mat, tc, tcd) {
  const steel = 0x93a7bd, steelD = 0x5f7088, steelL = 0xc4d2e0, gold = 0xe8b84a, leather = 0x6b4a32, stone = 0x8c8a86, stoneD = 0x5d5b58;
  const spec = { hip: 1.0, hipW: 0.2, neck: 0.78, sh: 0.46, shY: 0.68, arm: 0.74, back: 0.26, leg: 1.0 };
  const rig = humanoid(spec, mat, (k) => {
    // legs: greaves and big boots
    for (const [kk, s] of [[k.legL, 1], [k.legR, -1]]) {
      kk.cyl(0.15, 0.17, 0.5, 10, steelD, 0, -0.25, 0);
      kk.box(0.2, 0.16, 0.12, steelL, 0, -0.5, 0.12);
      kk.cyl(0.13, 0.15, 0.42, 10, steel, 0, -0.72, 0);
      kk.box(0.3, 0.2, 0.44, 0x3a3f4a, 0, -0.92, 0.07);
    }
    // torso: breastplate, tabard, belt, pauldrons
    k.torso.box(0.82, 0.62, 0.52, steel, 0, 0.36, 0);
    k.torso.box(0.7, 0.2, 0.46, steelD, 0, 0.02, 0);
    k.torso.box(0.36, 0.7, 0.06, tc, 0, -0.05, 0.27);
    k.torso.box(0.4, 0.08, 0.07, gold, 0, 0.3, 0.29);
    k.torso.box(0.86, 0.1, 0.56, leather, 0, -0.06, 0);
    k.torso.box(0.14, 0.12, 0.08, gold, 0, -0.06, 0.29);
    k.torso.sph(0.27, steelL, 0.5, 0.66, 0, 1.15, 0.8, 1.1);
    k.torso.sph(0.27, steelL, -0.5, 0.66, 0, 1.15, 0.8, 1.1);
    k.torso.box(0.32, 0.05, 0.3, gold, 0.52, 0.5, 0);
    k.torso.box(0.32, 0.05, 0.3, gold, -0.52, 0.5, 0);
    k.torso.cyl(0.16, 0.2, 0.14, 10, steelD, 0, 0.72, 0);
    // helmet with a team crest
    k.head.cyl(0.24, 0.26, 0.42, 12, steel, 0, 0.21, 0);
    k.head.sph(0.245, steel, 0, 0.42, 0, 1, 0.7, 1);
    k.head.box(0.36, 0.05, 0.05, 0x111418, 0, 0.26, 0.24);
    k.head.box(0.05, 0.2, 0.05, 0x111418, 0, 0.17, 0.25);
    k.head.box(0.07, 0.22, 0.5, tc, 0, 0.6, -0.02);
    k.head.box(0.06, 0.08, 0.3, gold, 0, 0.47, 0.18);
    // arms
    for (const kk of [k.armL, k.armR]) { kk.limb(0.12, 0.11, 0.4, steelD); kk.cyl(0.12, 0.14, 0.36, 10, steel, 0, -0.55, 0); }
    // shield on the left forearm, facing out
    k.handL.cyl(0.6, 0.6, 0.09, 20, steel, 0.12, 0.25, 0.08, 0, 0, Math.PI / 2);
    k.handL.cyl(0.5, 0.5, 0.1, 20, tc, 0.13, 0.25, 0.08, 0, 0, Math.PI / 2);
    k.handL.sph(0.14, gold, 0.2, 0.25, 0.08);
    k.handL.tor(0.6, 0.035, Math.PI * 2, gold, 0.17, 0.25, 0.08, 0, Math.PI / 2, 0);
    // stone hammer in the right hand, pointing forward
    k.handR.sph(0.12, steelD, 0, 0, 0);
    k.handR.cyl(0.05, 0.05, 1.3, 8, leather, 0, -0.05, 0.45, Math.PI / 2, 0, 0);
    k.handR.box(0.42, 0.42, 0.62, stone, 0, -0.05, 1.12);
    k.handR.box(0.47, 0.47, 0.08, gold, 0, -0.05, 0.95);
    k.handR.box(0.47, 0.47, 0.08, gold, 0, -0.05, 1.29);
    k.handR.box(0.3, 0.3, 0.1, stoneD, 0, -0.05, 1.46);
    // cape
    k.cape.box(0.74, 1.15, 0.05, tc, 0, -0.55, 0);
    k.cape.box(0.74, 0.12, 0.06, tcd, 0, -1.1, 0);
  });
  rig.parts.root.scale.setScalar(1.08);
  return Object.assign(rig, { root: rig.parts.root, height: 2.3, style: 'hammer' });
}

function parazsRig(mat, tc, tcd) {
  const robe = 0xc23a2a, robeD = 0x7e2018, gold = 0xf2c14e, skin = 0xf3c7a0, hair = 0xff6a1a, hairL = 0xffb030, wood = 0x4a2e22;
  const spec = { hip: 0.95, hipW: 0.13, neck: 0.66, sh: 0.3, shY: 0.58, arm: 0.66, back: 0.17, leg: 0.95 };
  const rig = humanoid(spec, mat, (k) => {
    for (const kk of [k.legL, k.legR]) { kk.cyl(0.08, 0.09, 0.8, 8, 0x3b2626, 0, -0.42, 0); kk.box(0.15, 0.12, 0.3, 0x2b1a16, 0, -0.88, 0.06); }
    // robe: bodice and a flared skirt
    k.torso.cyl(0.24, 0.3, 0.62, 12, robe, 0, 0.3, 0);
    k.torso.cyl(0.32, 0.56, 0.8, 14, robe, 0, -0.38, 0);
    k.torso.cyl(0.565, 0.57, 0.08, 14, gold, 0, -0.78, 0);
    k.torso.box(0.1, 1.3, 0.04, gold, 0, -0.05, 0.31, 0.18, 0, 0);
    k.torso.cyl(0.33, 0.33, 0.08, 12, robeD, 0, 0.02, 0);
    k.torso.box(0.62, 0.12, 0.34, tc, 0, 0.58, 0);
    k.torso.cone(0.22, 0.16, 10, gold, 0, 0.66, 0, Math.PI);
    // head: face and a mane of flame-hair
    k.head.sph(0.2, skin, 0, 0.22, 0.02, 1, 1.08, 1);
    k.head.box(0.05, 0.04, 0.02, 0x2a1408, -0.07, 0.25, 0.19);
    k.head.box(0.05, 0.04, 0.02, 0x2a1408, 0.07, 0.25, 0.19);
    k.head.sph(0.215, hair, 0, 0.3, -0.03, 1.05, 0.9, 1.05);
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      k.head.cone(0.08, 0.42, 6, i % 2 ? hair : hairL, Math.sin(a) * 0.12, 0.5, Math.cos(a) * 0.1 - 0.06, -0.5 + Math.cos(a) * 0.4, 0, -Math.sin(a) * 0.6);
    }
    k.head.cone(0.1, 0.55, 6, hairL, 0, 0.58, -0.08, -0.3, 0, 0);
    for (const kk of [k.armL, k.armR]) { kk.cyl(0.1, 0.07, 0.5, 8, robe, 0, -0.25, 0); kk.cyl(0.13, 0.09, 0.14, 8, gold, 0, -0.48, 0); }
    k.handL.sph(0.07, skin, 0, 0.02, 0);
    // staff with a burning crystal
    k.handR.sph(0.07, skin, 0, 0.02, 0);
    k.handR.cyl(0.035, 0.04, 1.9, 8, wood, 0, 0.35, 0.05);
    k.handR.tor(0.12, 0.025, Math.PI * 2, gold, 0, 1.3, 0.05, 0, 0, 0);
    k.handR.ball(0.12, 0xffa21f, 0, 1.33, 0.05, 1, 1.4, 1, 0);
    k.cape.box(0.5, 0.8, 0.04, tc, 0, -0.4, 0);
  });
  rig.parts.root.scale.setScalar(1.02);
  return Object.assign(rig, { root: rig.parts.root, height: 2.1, style: 'staff' });
}

function solyomRig(mat, tc, tcd) {
  const green = 0x4f7d33, greenD = 0x355a22, leather = 0x7a5232, leatherD = 0x4c3220, skin = 0xe9b88e, wood = 0x8a5a2b, feather = 0xf5f0e6;
  const spec = { hip: 0.98, hipW: 0.14, neck: 0.68, sh: 0.32, shY: 0.6, arm: 0.68, back: 0.2, leg: 0.98 };
  const rig = humanoid(spec, mat, (k) => {
    for (const kk of [k.legL, k.legR]) { kk.cyl(0.1, 0.11, 0.55, 8, leatherD, 0, -0.27, 0); kk.cyl(0.11, 0.09, 0.42, 8, leather, 0, -0.72, 0); kk.box(0.16, 0.14, 0.32, 0x2f2116, 0, -0.92, 0.06); }
    k.torso.cyl(0.26, 0.24, 0.66, 10, green, 0, 0.3, 0);
    k.torso.box(0.46, 0.5, 0.34, leather, 0, 0.32, 0.02);
    k.torso.cyl(0.27, 0.27, 0.1, 10, leatherD, 0, 0.0, 0);
    k.torso.box(0.08, 0.08, 0.04, 0xd8b04a, 0, 0.0, 0.27);
    k.torso.box(0.48, 0.3, 0.4, green, 0, -0.12, 0.0);
    // quiver on the back
    k.torso.cyl(0.11, 0.1, 0.7, 8, leatherD, 0.12, 0.42, -0.25, 0.35, 0, -0.25);
    for (let i = 0; i < 4; i++) k.torso.cone(0.04, 0.12, 4, i % 2 ? feather : 0xc8402a, 0.22 + i * 0.03, 0.84, -0.38 + i * 0.02, 0.35, 0, -0.25);
    // the falcon perched on the right shoulder
    const fx = -0.36, fy = 0.82;
    k.extra.sph(0.11, 0x8a6a4a, fx, fy, -0.02, 1, 1.2, 1.3);
    k.extra.sph(0.07, 0xd8c8a8, fx, fy + 0.13, 0.06);
    k.extra.cone(0.03, 0.07, 4, 0xe2b030, fx, fy + 0.12, 0.14, Math.PI / 2, 0, 0);
    k.extra.box(0.04, 0.18, 0.22, 0x5a4230, fx - 0.09, fy, -0.04, 0.3, 0, 0);
    k.extra.box(0.04, 0.18, 0.22, 0x5a4230, fx + 0.09, fy, -0.04, 0.3, 0, 0);
    // head: hood with a feather
    k.head.sph(0.19, skin, 0, 0.2, 0.02);
    k.head.box(0.05, 0.03, 0.02, 0x1a1208, -0.07, 0.23, 0.19);
    k.head.box(0.05, 0.03, 0.02, 0x1a1208, 0.07, 0.23, 0.19);
    k.head.sph(0.23, green, 0, 0.26, -0.05, 1.05, 1.05, 1.1);
    k.head.cone(0.2, 0.36, 8, greenD, 0, 0.32, -0.26, -1.1, 0, 0);
    k.head.box(0.03, 0.34, 0.08, tc, 0.18, 0.42, -0.08, 0, 0, -0.5);
    for (const kk of [k.armL, k.armR]) { kk.cyl(0.09, 0.08, 0.45, 8, green, 0, -0.22, 0); kk.cyl(0.09, 0.075, 0.22, 8, leather, 0, -0.52, 0); }
    k.handR.sph(0.07, skin, 0, 0.02, 0);
    k.handL.sph(0.07, skin, 0, 0.02, 0);
    // longbow in the left hand; built for the aiming pose (arm forward: hand -y is forward, hand +z is up)
    k.handL.tor(0.72, 0.035, Math.PI * 0.85, wood, 0, 0.67, 0, 0, Math.PI / 2, -Math.PI * 0.925);
    k.handL.cyl(0.008, 0.008, 1.39, 4, 0xf0e8d0, 0, 0.5, 0, Math.PI / 2, 0, 0);
    k.handL.cyl(0.05, 0.05, 0.2, 6, leatherD, 0, -0.05, 0, Math.PI / 2, 0, 0);
    k.cape.box(0.56, 1.05, 0.04, tc, 0, -0.52, 0);
    k.cape.box(0.56, 0.1, 0.05, tcd, 0, -1.02, 0);
  });
  // the falcon is its own mesh so it can fly off (Sólyomroham)
  const fg = rig.kits.extra.geo();
  rig.falcon = new THREE.Mesh(fg, mat);
  rig.falcon.castShadow = true;
  rig.parts.torso.add(rig.falcon);
  return Object.assign(rig, { root: rig.parts.root, height: 2.1, style: 'bow' });
}

function arnyRig(mat, tc, tcd) {
  const cloth = 0x3a2d55, clothD = 0x241a36, mask = 0x8c7cb8, skin = 0xd9a88a, blade = 0xd0d8ea, eye = 0xd8b8ff;
  const spec = { hip: 0.94, hipW: 0.13, neck: 0.64, sh: 0.29, shY: 0.57, arm: 0.64, back: 0.16, leg: 0.94 };
  const rig = humanoid(spec, mat, (k) => {
    for (const kk of [k.legL, k.legR]) { kk.cyl(0.085, 0.1, 0.52, 8, clothD, 0, -0.26, 0); kk.cyl(0.095, 0.075, 0.42, 8, cloth, 0, -0.7, 0); kk.box(0.13, 0.1, 0.28, 0x15101e, 0, -0.9, 0.05); }
    k.torso.cyl(0.24, 0.2, 0.64, 10, cloth, 0, 0.3, 0);
    k.torso.cyl(0.21, 0.22, 0.12, 10, tc, 0, 0.0, 0);
    k.torso.box(0.06, 0.62, 0.3, clothD, 0.08, 0.3, 0.08, 0, 0, 0.5);
    k.torso.box(0.06, 0.62, 0.3, clothD, -0.08, 0.3, 0.08, 0, 0, -0.5);
    k.torso.cyl(0.2, 0.26, 0.24, 10, tc, 0, 0.62, 0);
    // hood and mask, glowing eyes
    k.head.sph(0.18, skin, 0, 0.2, 0.02);
    k.head.sph(0.205, clothD, 0, 0.26, -0.03, 1.05, 1.15, 1.15);
    k.head.cone(0.14, 0.3, 6, clothD, 0, 0.42, -0.14, -0.9, 0, 0);
    k.head.box(0.3, 0.12, 0.08, mask, 0, 0.13, 0.17);
    k.head.box(0.06, 0.025, 0.02, eye, -0.07, 0.24, 0.2);
    k.head.box(0.06, 0.025, 0.02, eye, 0.07, 0.24, 0.2);
    for (const kk of [k.armL, k.armR]) { kk.cyl(0.08, 0.07, 0.42, 8, cloth, 0, -0.21, 0); kk.cyl(0.08, 0.065, 0.22, 8, clothD, 0, -0.5, 0); }
    // curved daggers pointing forward
    for (const kk of [k.handL, k.handR]) {
      kk.sph(0.065, skin, 0, 0.02, 0);
      kk.box(0.05, 0.05, 0.16, 0x2a1a10, 0, 0, 0.06);
      kk.box(0.03, 0.09, 0.5, blade, 0, 0.02, 0.38, 0.15, 0, 0);
      kk.box(0.03, 0.06, 0.18, blade, 0, 0.1, 0.66, 0.6, 0, 0);
      kk.box(0.12, 0.03, 0.04, 0xb89a50, 0, 0, 0.14);
    }
    // the long scarf
    k.cape.box(0.12, 0.7, 0.03, tc, 0.1, -0.3, 0, 0, 0, 0.12);
    k.cape.box(0.12, 0.56, 0.03, tcd, -0.06, -0.25, -0.02, 0, 0, -0.1);
  });
  return Object.assign(rig, { root: rig.parts.root, height: 2.0, style: 'daggers' });
}

// ============================================================
//  Minions
// ============================================================
const minionCache = new Map();
export function buildMinion(type, team) {
  const key = type + team;
  let parts = minionCache.get(key);
  if (!parts) { parts = minionGeos(type, team); minionCache.set(key, parts); }
  const root = new THREE.Group(), body = pivot(root, 0, 0, 0);
  const add = (geo, parent) => { if (!geo) return null; const m = new THREE.Mesh(geo, parts.mat); m.castShadow = true; parent.add(m); return m; };
  const torso = pivot(body, 0, parts.hip, 0);
  add(parts.torso, torso);
  const legL = pivot(body, 0.11, parts.hip, 0), legR = pivot(body, -0.11, parts.hip, 0);
  add(parts.leg, legL); add(parts.leg, legR);
  const armR = pivot(torso, -0.22, parts.sh, 0), armL = pivot(torso, 0.22, parts.sh, 0);
  add(parts.armR, armR); add(parts.armL, armL);
  const wheels = [];
  if (parts.wheel) for (const [x, z] of [[0.5, 0.35], [-0.5, 0.35], [0.5, -0.4], [-0.5, -0.4]]) { const w = pivot(body, x, 0.3, z); add(parts.wheel, w); wheels.push(w); }
  return { root, parts: { root, body, torso, legL, legR, armL, armR }, wheels, height: parts.height, style: type, siege: type === 'siege' };
}
const minionMats = [null, null];
function minionGeos(type, team) {
  if (!minionMats[team]) minionMats[team] = comicMat({ vc: true, paint: 0.35, hatch: 0.45, rim: 0.4 });
  const mat = minionMats[team];
  const tc = TEAMS[team].hex, tcd = dim(tc, 0.6);
  const mail = 0x9aa3ad, skin = team === 0 ? 0xe9bf98 : 0xd9a07a, steel = 0xc5ced8;
  const t = new Kit(), leg = new Kit(), aR = new Kit(), aL = new Kit(), wh = new Kit();
  let hip = 0.55, sh = 0.42, height = 1.35;
  if (type === 'melee') {
    leg.cyl(0.08, 0.07, 0.5, 8, 0x4a4f58, 0, -0.27, 0); leg.box(0.13, 0.1, 0.2, 0x2a2a30, 0, -0.52, 0.04);
    t.cyl(0.22, 0.2, 0.5, 10, mail, 0, 0.22, 0);
    t.box(0.34, 0.46, 0.1, tc, 0, 0.18, 0.18);
    t.sph(0.17, skin, 0, 0.66, 0.02);
    t.cyl(0.19, 0.2, 0.16, 10, steel, 0, 0.74, 0);
    t.sph(0.19, steel, 0, 0.8, 0, 1, 0.6, 1);
    t.box(0.04, 0.16, 0.3, tc, 0, 0.94, -0.02);
    aR.cyl(0.06, 0.055, 0.34, 6, mail, 0, -0.17, 0);
    aR.box(0.05, 0.05, 0.62, steel, 0, -0.34, 0.3); aR.box(0.16, 0.04, 0.05, 0xb08a40, 0, -0.34, 0.02);
    aL.cyl(0.06, 0.055, 0.34, 6, mail, 0, -0.17, 0);
    aL.cyl(0.24, 0.24, 0.05, 14, tc, 0.06, -0.3, 0.06, 0, 0, Math.PI / 2);
    aL.cyl(0.08, 0.08, 0.06, 8, steel, 0.09, -0.3, 0.06, 0, 0, Math.PI / 2);
  } else if (type === 'caster') {
    hip = 0.5; height = 1.3;
    leg.cyl(0.06, 0.06, 0.45, 6, 0x3a3040, 0, -0.24, 0);
    t.cyl(0.18, 0.36, 0.72, 12, tc, 0, 0.05, 0);
    t.cyl(0.365, 0.37, 0.06, 12, 0xf0d070, 0, -0.29, 0);
    t.sph(0.15, skin, 0, 0.56, 0.03);
    t.cone(0.22, 0.4, 10, tcd, 0, 0.74, -0.03);
    aR.cyl(0.055, 0.05, 0.32, 6, tc, 0, -0.16, 0);
    aR.cyl(0.025, 0.025, 1.0, 6, 0x5a3a22, 0, -0.1, 0.06);
    aR.ball(0.09, 0x9ff0ff, 0, 0.42, 0.06, 1, 1, 1, 0);
    aL.cyl(0.055, 0.05, 0.32, 6, tc, 0, -0.16, 0);
  } else {
    // siege: a little cannon cart
    hip = 0.5; height = 1.2;
    t.box(1.0, 0.36, 1.1, 0x7a5232, 0, -0.08, 0);
    t.box(1.04, 0.08, 1.14, tc, 0, 0.12, 0);
    t.cyl(0.18, 0.22, 1.0, 12, 0x3a3d44, 0, 0.32, 0.25, Math.PI / 2 - 0.25, 0, 0);
    t.tor(0.2, 0.04, Math.PI * 2, 0xb08a40, 0, 0.42, 0.65, -0.25, 0, 0);
    t.box(0.06, 0.8, 0.06, 0x5a3a22, 0.4, 0.5, -0.45);
    t.box(0.36, 0.26, 0.03, tc, 0.58, 0.75, -0.45);
    wh.cyl(0.3, 0.3, 0.1, 12, 0x5a3a22, 0, 0, 0, 0, 0, Math.PI / 2);
    wh.cyl(0.1, 0.1, 0.12, 8, 0x3a3d44, 0, 0, 0, 0, 0, Math.PI / 2);
  }
  return { mat, torso: t.geo(), leg: leg.geo(), armR: aR.geo(), armL: aL.geo(), wheel: wh.geo(), hip, sh, height };
}

// ============================================================
//  Structures, boss, fountain
// ============================================================
const stoneMat = () => comicMat({ vc: true, paint: 0.7, hatch: 0.6, rim: 0.2 });
export function buildTower(team, tier) {
  const mat = stoneMat(), tc = TEAMS[team].hex, tcd = dim(tc, 0.6);
  const k = new Kit(), stone = 0xb3a48c, stoneD = 0x857861, wood = 0x6b4a30;
  k.cyl(1.35, 1.6, 0.6, 8, stoneD, 0, 0.3, 0);
  k.cyl(1.05, 1.3, 3.6, 8, stone, 0, 2.4, 0);
  for (let i = 0; i < 3; i++) k.cyl(1.32 - i * 0.09, 1.34 - i * 0.09, 0.08, 8, stoneD, 0, 1.2 + i * 1.1, 0);
  k.cyl(1.35, 1.12, 0.4, 8, stoneD, 0, 4.4, 0);
  for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2 + Math.PI / 8; k.box(0.42, 0.42, 0.3, stone, Math.sin(a) * 1.2, 4.8, Math.cos(a) * 1.2, 0, a, 0); }
  // door and a team banner
  k.box(0.6, 0.95, 0.12, wood, 0, 0.95, 1.22, -0.12, 0, 0);
  k.box(0.7, 1.4, 0.05, tc, 0, 3.2, 1.22, -0.1, 0, 0);
  k.box(0.7, 0.14, 0.06, tcd, 0, 2.52, 1.24, -0.1, 0, 0);
  k.cone(0.2, 0.3, 4, tc, 0, 2.38, 1.25, Math.PI, 0, 0);
  // the crystal mount
  k.cyl(0.5, 0.7, 0.4, 8, stoneD, 0, 5.0, 0);
  const g = k.geo();
  const root = new THREE.Group();
  const m = new THREE.Mesh(g, mat); m.castShadow = true; m.receiveShadow = true; root.add(m);
  const crystal = crystalMesh(tc, 0.55, 1.3);
  crystal.position.y = 6.2;
  root.add(crystal);
  root.scale.setScalar(1 + tier * 0.06);
  return { root, crystal, mat, height: 7 };
}
function crystalMesh(col, r, h) {
  const k = new Kit();
  k.put(new THREE.OctahedronGeometry(r, 0), col, 0, 0, 0, 0, 0, 0, 1, h / r / 2 * 1.6, 1);
  const m = new THREE.Mesh(k.geo(), comicMat({ vc: true, paint: 0.1, hatch: 0.2, rim: 0.9, emissive: dim(col, 0.45) }));
  m.castShadow = true;
  return m;
}
export function buildNexus(team) {
  const mat = stoneMat(), tc = TEAMS[team].hex;
  const k = new Kit(), stone = 0xbfae92, stoneD = 0x857861, gold = 0xe0b44a;
  k.cyl(3.0, 3.3, 0.5, 10, stoneD, 0, 0.25, 0);
  k.cyl(2.4, 2.8, 0.6, 10, stone, 0, 0.8, 0);
  k.cyl(1.7, 2.1, 0.6, 10, stoneD, 0, 1.4, 0);
  for (let i = 0; i < 6; i++) {
    const a = i / 6 * Math.PI * 2;
    k.box(0.4, 2.6, 0.4, stone, Math.sin(a) * 2.6, 1.6, Math.cos(a) * 2.6, 0, a, 0);
    k.cone(0.32, 0.6, 4, gold, Math.sin(a) * 2.6, 3.2, Math.cos(a) * 2.6, 0, a + Math.PI / 4, 0);
  }
  const root = new THREE.Group();
  const m = new THREE.Mesh(k.geo(), mat); m.castShadow = true; m.receiveShadow = true; root.add(m);
  const crystal = crystalMesh(tc, 1.0, 3.2);
  crystal.position.y = 3.9;
  root.add(crystal);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.8, 0.09, 6, 32), comicMat({ color: gold, paint: 0.2, rim: 0.4 }));
  ring.rotation.x = Math.PI / 2; ring.position.y = 3.9;
  root.add(ring);
  return { root, crystal, ring, mat, height: 6 };
}
export function buildBoss() {
  const mat = comicMat({ vc: true, paint: 0.7, hatch: 0.6, rim: 0.45 });
  const rock = 0x77706a, rockD = 0x544e4a, moss = 0x4f8a30, crys = 0x5ff0e0, eye = 0xfff07a;
  const spec = { hip: 1.2, hipW: 0.45, neck: 1.35, sh: 1.0, shY: 1.15, arm: 1.3, back: 0.6, leg: 1.2 };
  const rig = humanoid(spec, mat, (k) => {
    for (const kk of [k.legL, k.legR]) { kk.rock(0.42, rockD, 0, -0.4, 0, 1, 1.2, 1); kk.rock(0.46, rock, 0, -1.0, 0.1, 1.1, 0.7, 1.3); }
    k.torso.rock(1.0, rock, 0, 0.7, 0, 1.25, 1.05, 0.95);
    k.torso.rock(0.6, rockD, 0, 0.05, 0.05, 1.2, 0.8, 1);
    k.torso.sph(0.5, moss, 0.4, 1.4, -0.2, 1.4, 0.4, 1.1);
    k.torso.sph(0.4, moss, -0.6, 1.1, 0.3, 1, 0.4, 1);
    for (let i = 0; i < 5; i++) k.torso.cone(0.16, 0.8 + (i % 2) * 0.3, 5, crys, -0.6 + i * 0.3, 1.5, -0.65, -0.5, 0, (i - 2) * 0.25);
    k.torso.ball(0.22, crys, 0, 0.8, 0.88, 1, 1, 0.5, 0);
    k.head.rock(0.4, rock, 0, 0.25, 0.1, 1.1, 0.9, 1);
    k.head.box(0.12, 0.06, 0.04, eye, -0.15, 0.3, 0.46);
    k.head.box(0.12, 0.06, 0.04, eye, 0.15, 0.3, 0.46);
    k.head.sph(0.2, moss, 0, 0.55, 0, 1.6, 0.4, 1.2);
    for (const kk of [k.armL, k.armR]) { kk.rock(0.34, rockD, 0, -0.35, 0, 1, 1.3, 1); kk.rock(0.32, rock, 0, -0.95, 0, 1, 1.2, 1); }
    k.handL.rock(0.55, rock, 0, -0.1, 0.1, 1.1, 1, 1.1);
    k.handR.rock(0.55, rock, 0, -0.1, 0.1, 1.1, 1, 1.1);
  });
  return Object.assign(rig, { root: rig.parts.root, height: 3.6, style: 'boss', mat });
}
export function buildFountain(team) {
  const mat = stoneMat(), tc = TEAMS[team].hex;
  const k = new Kit(), stone = 0xc8b89a, stoneD = 0x8a7c64;
  k.cyl(4.2, 4.4, 0.3, 24, stoneD, 0, 0.15, 0);
  k.cyl(3.6, 3.7, 0.12, 24, tc, 0, 0.33, 0);
  k.cyl(3.4, 3.5, 0.18, 24, stone, 0, 0.36, 0);
  for (let i = 0; i < 4; i++) { const a = i / 4 * Math.PI * 2 + Math.PI / 4; k.box(0.45, 1.2, 0.45, stone, Math.sin(a) * 3.1, 0.9, Math.cos(a) * 3.1, 0, a, 0); k.box(0.65, 0.18, 0.65, stoneD, Math.sin(a) * 3.1, 1.58, Math.cos(a) * 3.1, 0, a, 0); }
  const root = new THREE.Group();
  const m = new THREE.Mesh(k.geo(), mat); m.receiveShadow = true; m.castShadow = true; root.add(m);
  const crystal = crystalMesh(tc, 0.6, 2.0);
  crystal.position.y = 2.3;
  root.add(crystal);
  return { root, crystal };
}

// ============================================================
//  Scenery pieces (merged into big batches by view.js)
// ============================================================
export function pineKit(k, x, y, z, s, r) {
  const g1 = 0x3d6b33, g2 = 0x4f8a3d, trunk = 0x6b4a30;
  k.cyl(0.14 * s, 0.2 * s, 1.0 * s, 6, trunk, x, y + 0.5 * s, z);
  for (let i = 0; i < 3; i++) k.cone((1.3 - i * 0.32) * s, (1.5 - i * 0.2) * s, 7, i % 2 ? g2 : g1, x, y + (1.3 + i * 0.85) * s, z, 0, r + i, 0);
}
export function oakKit(k, x, y, z, s, r) {
  const trunk = 0x6b4a30, cols = [0x5c9a3a, 0x6fae44, 0x4c8530];
  k.cyl(0.2 * s, 0.3 * s, 1.6 * s, 7, trunk, x, y + 0.8 * s, z);
  for (let i = 0; i < 4; i++) {
    const a = r + i * 1.7, d = i === 0 ? 0 : 0.6 * s;
    k.ball((0.95 - (i ? 0.25 : 0)) * s, cols[i % 3], x + Math.sin(a) * d, y + (2.1 + (i ? -0.2 : 0.25)) * s, z + Math.cos(a) * d, 1, 0.85, 1, 1);
  }
}
export function rockKit(k, x, y, z, s, r) {
  const c = [0xa39782, 0x8e8370, 0xb5a891][Math.floor(Math.abs(Math.sin(r * 7)) * 3)];
  k.rock(0.7 * s, c, x, y + 0.25 * s, z, 1.2, 0.8, 1, r);
  k.rock(0.45 * s, dim(c, 0.85), x + 0.55 * s, y + 0.1 * s, z + 0.2 * s, 1, 0.7, 1, r * 2);
}
export function pillarKit(k, x, y, z, s, broken, r) {
  const st = 0xd2c5a8, stD = 0xa3967c;
  k.box(0.9 * s, 0.3 * s, 0.9 * s, stD, x, y + 0.15 * s, z, 0, r, 0);
  const h = broken ? 1.4 + Math.abs(Math.sin(r * 5)) * 1.2 : 3.4;
  k.cyl(0.33 * s, 0.36 * s, h * s, 10, st, x, y + (0.3 + h / 2) * s, z);
  if (!broken) k.box(0.95 * s, 0.3 * s, 0.95 * s, stD, x, y + (0.3 + h + 0.15) * s, z, 0, r, 0);
}
export function fenceKit(k, x0, z0, x1, z1, y0, y1) {
  const wood = 0x8a5f3a, woodD = 0x5e3f26;
  const len = Math.hypot(x1 - x0, z1 - z0), a = Math.atan2(x1 - x0, z1 - z0);
  k.box(0.14, 1.1, 0.14, woodD, x0, y0 + 0.5, z0);
  k.box(0.08, 0.1, len, wood, (x0 + x1) / 2, (y0 + y1) / 2 + 0.85, (z0 + z1) / 2, 0, a, 0);
  k.box(0.08, 0.1, len, wood, (x0 + x1) / 2, (y0 + y1) / 2 + 0.45, (z0 + z1) / 2, 0, a, 0);
}
export function bannerKit(k, x, y, z, col, r) {
  k.cyl(0.06, 0.08, 4.2, 6, 0x5e3f26, x, y + 2.1, z);
  k.box(0.9, 1.7, 0.05, col, x + Math.sin(r + Math.PI / 2) * 0.48, y + 3.2, z + Math.cos(r + Math.PI / 2) * 0.48, 0, r + Math.PI / 2, 0);
  k.cone(0.12, 0.3, 6, 0xe0b44a, x, y + 4.35, z);
}
export function wallKit(k, x0, z0, x1, z1, y, h) {
  const st = 0xb9aa8e, stD = 0x8a7c64;
  const len = Math.hypot(x1 - x0, z1 - z0), a = Math.atan2(x1 - x0, z1 - z0), cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  k.box(1.2, h, len, st, cx, y + h / 2, cz, 0, a, 0);
  const n = Math.floor(len / 1.1);
  for (let i = 0; i < n; i += 2) {
    const t = (i + 0.5) / n - 0.5;
    k.box(1.3, 0.55, 0.6, stD, cx + Math.sin(a) * t * len, y + h + 0.27, cz + Math.cos(a) * t * len, 0, a, 0);
  }
}
export function towerKeepKit(k, x, y, z, s, col) {
  const st = 0xb9aa8e, stD = 0x8a7c64;
  k.cyl(1.6 * s, 1.9 * s, 7 * s, 8, st, x, y + 3.5 * s, z);
  k.cyl(2.0 * s, 1.7 * s, 0.6 * s, 8, stD, x, y + 7.2 * s, z);
  k.cone(2.0 * s, 2.6 * s, 8, col, x, y + 8.8 * s, z);
}
export function bushKit(k, x, z, rx, rz, seed) {
  const cols = [0x4f8f35, 0x5fa23f, 0x3f7a2c, 0x6cb247];
  const n = Math.round(rx * rz * 3.2) + 4;
  for (let i = 0; i < n; i++) {
    const a = Math.sin(seed + i * 12.9898) * 43758.5453, f = a - Math.floor(a);
    const b = Math.sin(seed * 3 + i * 78.233) * 12345.678, g = b - Math.floor(b);
    const ang = f * Math.PI * 2, rr = Math.sqrt(g);
    k.ball(0.5 + g * 0.35, cols[i % 4], x + Math.cos(ang) * rr * rx * 0.85, 0.35 + f * 0.35, z + Math.sin(ang) * rr * rz * 0.85, 1, 0.85, 1, 1);
  }
}
export function brazierKit(k, x, y, z) {
  k.cyl(0.1, 0.16, 1.1, 6, 0x3a3530, x, y + 0.55, z);
  k.cyl(0.45, 0.25, 0.3, 10, 0x6a5a48, x, y + 1.2, z);
}

export { hex, dim };
