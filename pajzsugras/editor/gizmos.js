// PAJZSUGRÁS map editor, the helper meshes: everything that is not the level itself. One group in gfx.scene.
//
//   const g = new Gizmos(gfx);
//   g.syncDoc(doc)            trigger boxes (kill / checkpoint / finish, the void too), checkpoint numbers, light bulbs, pad arcs, the start figure
//   g.setSelection(item|null) outline + faint fill of the selected item (a selected light also shows its range ring)
//   g.setMulti(items, key)    the bounds of the other items of a group selection, one set of lines (rebuilt only when key changes)
//   g.setHandles(segs|null, hover)   the resize arrows of a single selected item: segs = [{ base, tip, len, axis, dir }] (at most 6), hover = the index to highlight
//   g.setGhost(item|null)     the placement preview;   g.setPadPreview(points|null)  the arc of a pad whose target is still to be clicked
//   g.setGrid(step, centre|null)   a grid plane under the ghost (centre = [x, y, z]; null hides it)
//   g.update(camPos)          keeps the number sprites a readable size;   g.setVisible(bool)   g.dispose()
// The level is rebuilt after an edit (100 ms later); these follow the document at once, so a drag never waits for a rebuild.
import * as THREE from 'three';
import { labelTexture } from '../render/textures.js';
import { itemAabb } from './model.js';
import { padArc } from './pick.js';
import { FLAG } from '../sim/const.js';

const DEG = Math.PI / 180;
const COL = { lava: 0xff6a1a, laser: 0xff2a2a, void: 0xb060ff, cp: 0xff9a30, finish: 0xffd24a, pad: 0x40e0ff, ghost: 0x2ee6d4, sel: 0xffd24a, start: 0x2ee6d4 };
const AXIS_COL = [0xff5a4a, 0x6ee07a, 0x5aa0ff];   // the resize arrows: x red, y green, z blue (hovered: COL.sel)
const START_ID = '__edstart';

// ---------------------------------------------------------------- unit shapes: a fill and the sharp edges, cached per kind
const shapeCache = new Map();
function unitShape(key) {
  let s = shapeCache.get(key);
  if (s) return s;
  let g;
  if (key === 'box') g = new THREE.BoxGeometry(1, 1, 1);
  else {
    const pos = [], idx = [];
    if (key === 'ramp') {   // rises toward +z, like the builder's b.ramp
      pos.push(-.5, -.5, -.5, .5, -.5, -.5, -.5, -.5, .5, .5, -.5, .5, -.5, .5, .5, .5, .5, .5);
      idx.push(0, 1, 3, 0, 3, 2, 2, 3, 5, 2, 5, 4, 0, 1, 5, 0, 5, 4, 0, 2, 4, 1, 5, 3);
    } else {   // prismN: unit circumradius, unit height; vertices at pi/N + i 2pi/N like sim/brush.js
      const n = Number(key.slice(5));
      for (let k = 0; k < 2; k++) for (let i = 0; i < n; i++) { const a = Math.PI / n + (i * 2 * Math.PI) / n; pos.push(Math.cos(a), k ? 0.5 : -0.5, Math.sin(a)); }
      pos.push(0, -0.5, 0, 0, 0.5, 0);
      const cb = 2 * n, ct = 2 * n + 1;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        idx.push(i, j, n + j, i, n + j, n + i, cb, j, i, ct, n + i, n + j);
      }
    }
    g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
  }
  s = { fill: g, edges: new THREE.EdgesGeometry(g, 20) };
  shapeCache.set(key, s);
  return s;
}

// how an item is drawn: unit shape + transform
function shapeFor(item) {
  switch (item.t) {
    case 'block': return { key: 'box', pos: item.c, scale: item.size, yaw: item.yaw };
    case 'ramp': return { key: 'ramp', pos: item.c, scale: item.size, yaw: item.yaw };
    case 'prism': return { key: 'prism' + item.sides, pos: item.c, scale: [item.r, item.h, item.r], yaw: item.yaw };
    case 'kill': case 'cp': case 'finish': return { key: 'box', pos: item.c, scale: item.size, yaw: 0 };
    case 'deco': return { key: 'box', pos: item.pos, scale: item.size, yaw: item.yaw };
    default: {   // pad, light, start: their bounds
      const b = itemAabb(item);
      return { key: 'box', pos: [0, 1, 2].map((a) => (b.min[a] + b.max[a]) / 2), scale: [0, 1, 2].map((a) => b.max[a] - b.min[a]), yaw: 0 };
    }
  }
}

// a translucent fill + an always-visible outline of one item
class ShapeView {
  constructor(color, fillOpacity, order) {
    this.group = new THREE.Group();
    this.group.visible = false;
    this.key = '';
    const u = unitShape('box');
    this.fill = new THREE.Mesh(u.fill, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: fillOpacity, depthWrite: false, fog: false, side: THREE.DoubleSide }));
    this.edges = new THREE.LineSegments(u.edges, new THREE.LineBasicMaterial({ color, fog: false, depthTest: false, transparent: true }));
    this.fill.renderOrder = order; this.edges.renderOrder = order + 1;
    this.group.add(this.fill, this.edges);
  }
  set(item) {
    if (!item) { this.group.visible = false; return; }
    const s = shapeFor(item);
    if (s.key !== this.key) { const u = unitShape(s.key); this.fill.geometry = u.fill; this.edges.geometry = u.edges; this.key = s.key; }
    this.group.position.set(s.pos[0], s.pos[1], s.pos[2]);
    this.group.rotation.set(0, (s.yaw || 0) * DEG, 0);
    this.group.scale.set(s.scale[0], s.scale[1], s.scale[2]);
    this.group.visible = true;
  }
  setColor(c) { this.fill.material.color.setHex(c); this.edges.material.color.setHex(c); }
  dispose() { this.fill.material.dispose(); this.edges.material.dispose(); }
}

const BOX_EDGES = [[0, 1], [1, 3], [3, 2], [2, 0], [4, 5], [5, 7], [7, 6], [6, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
const BOX_TRIS = [[0, 1, 3], [0, 3, 2], [4, 6, 7], [4, 7, 5], [0, 4, 5], [0, 5, 1], [2, 3, 7], [2, 7, 6], [0, 2, 6], [0, 6, 4], [1, 5, 7], [1, 7, 3]];
const hexRgb = (h) => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];

export class Gizmos {
  constructor(gfx) {
    this.gfx = gfx;
    this.group = new THREE.Group();
    this.group.name = 'editor-gizmos';
    gfx.scene.add(this.group);
    this.dyn = new THREE.Group();   // rebuilt by syncDoc
    this.group.add(this.dyn);
    this.sel = new ShapeView(COL.sel, 0.1, 30);
    this.ghost = new ShapeView(COL.ghost, 0.26, 28);
    this.group.add(this.sel.group, this.ghost.group);
    // the other items of a group selection: their bounds
    this.multi = null; this.multiKey = null;
    this.multiMat = new THREE.LineBasicMaterial({ color: COL.sel, fog: false, depthTest: false, transparent: true, opacity: 0.75 });
    // the resize arrows (a shaft and a head along +y, turned and scaled per use), drawn over everything
    const shaft = new THREE.CylinderGeometry(0.035, 0.035, 0.7, 6).translate(0, 0.35, 0), head = new THREE.ConeGeometry(0.11, 0.3, 10).translate(0, 0.85, 0);
    this.arrowGeo = [shaft, head];
    this.handles = Array.from({ length: 6 }, () => {
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false, depthTest: false, depthWrite: false, transparent: true }), g = new THREE.Group();
      for (const geo of this.arrowGeo) { const m = new THREE.Mesh(geo, mat); m.renderOrder = 32; m.frustumCulled = false; g.add(m); }
      g.visible = false;
      this.group.add(g);
      return { group: g, mat };
    });
    // the range ring of a selected light
    this.ring = new THREE.LineLoop(circleGeo(64), new THREE.LineBasicMaterial({ color: 0xffe0a0, fog: false, depthTest: false, transparent: true, opacity: 0.8 }));
    this.ring.visible = false; this.ring.renderOrder = 31;
    this.group.add(this.ring);
    // the pad that is being placed
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(25 * 3), 3));
    this.padLine = new THREE.Line(pg, new THREE.LineBasicMaterial({ color: COL.pad, fog: false, depthTest: false }));
    this.padLine.visible = false; this.padLine.frustumCulled = false; this.padLine.renderOrder = 29;
    this.group.add(this.padLine);
    // the start's heading arrow
    const ag = new THREE.BufferGeometry();
    ag.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6 * 3), 3));
    this.arrow = new THREE.LineSegments(ag, new THREE.LineBasicMaterial({ color: COL.start, fog: false, depthTest: false }));
    this.arrow.frustumCulled = false; this.arrow.renderOrder = 29;
    this.group.add(this.arrow);
    // the grid
    this.gridStep = 0; this.grid = null;
    this.labels = new Map();   // number text -> { texture, aspect, mat }
    this.sprites = [];
    this.start = null;
    this.visible = true;
  }

  setVisible(b) {
    this.visible = b;
    this.group.visible = b;
    if (!b) this.gfx.figures.remove(START_ID);
    else if (this.start) this.upsertStart();
  }

  // ---------------------------------------------------------------- the document part
  syncDoc(doc) {
    this.clearDyn();
    const faces = { pos: [], col: [] }, lines = { pos: [], col: [] };
    const bulbs = [];
    let cpN = 0;
    for (const it of doc.items) {
      if (it.t === 'kill' || it.t === 'cp' || it.t === 'finish') {
        const hex = it.t === 'kill' ? COL[it.kind] : COL[it.t], c = hexRgb(hex);
        const corners = [];
        for (let i = 0; i < 8; i++) corners.push([it.c[0] + (i & 1 ? 0.5 : -0.5) * it.size[0], it.c[1] + (i & 2 ? 0.5 : -0.5) * it.size[1], it.c[2] + (i & 4 ? 0.5 : -0.5) * it.size[2]]);
        for (const t of BOX_TRIS) for (const v of t) { faces.pos.push(...corners[v]); faces.col.push(...c); }
        for (const e of BOX_EDGES) for (const v of e) { lines.pos.push(...corners[v]); lines.col.push(...c); }
        if (it.t === 'cp') this.addNumber(String(++cpN), [it.c[0], it.c[1] + it.size[1] / 2 + 0.7, it.c[2]]);
      } else if (it.t === 'pad') {
        const c = hexRgb(COL.pad), arc = padArc(it, 24);
        for (let i = 0; i < arc.length - 1; i++) { lines.pos.push(...arc[i], ...arc[i + 1]); lines.col.push(...c, ...c); }
        const t = it.target, r = 0.7;   // the target: a cross in a circle
        for (let i = 0; i < 16; i++) {
          const a0 = (i / 16) * Math.PI * 2, a1 = ((i + 1) / 16) * Math.PI * 2;
          lines.pos.push(t[0] + Math.cos(a0) * r, t[1] + 0.05, t[2] + Math.sin(a0) * r, t[0] + Math.cos(a1) * r, t[1] + 0.05, t[2] + Math.sin(a1) * r);
          lines.col.push(...c, ...c);
        }
        lines.pos.push(t[0] - r, t[1] + 0.05, t[2], t[0] + r, t[1] + 0.05, t[2], t[0], t[1] + 0.05, t[2] - r, t[0], t[1] + 0.05, t[2] + r);
        lines.col.push(...c, ...c, ...c, ...c);
      } else if (it.t === 'light') bulbs.push(it);
    }
    if (faces.pos.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(faces.pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(faces.col, 3));
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.17, depthWrite: false, fog: false, side: THREE.DoubleSide }));
      m.frustumCulled = false; m.renderOrder = 20;
      this.dyn.add(m);
    }
    if (lines.pos.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(lines.pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(lines.col, 3));
      const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, fog: false, transparent: true, opacity: 0.85 }));
      l.frustumCulled = false; l.renderOrder = 21;
      this.dyn.add(l);
    }
    for (const it of bulbs) {
      const m = new THREE.Mesh(BULB, new THREE.MeshBasicMaterial({ color: it.color, fog: false }));
      m.position.set(it.pos[0], it.pos[1], it.pos[2]);
      m.renderOrder = 22;
      this.dyn.add(m);
    }
    this.start = doc.start;
    if (this.visible) this.upsertStart();
  }

  clearDyn() {
    for (const o of this.dyn.children) {
      if (o.geometry && !o.isSprite && o.geometry !== BULB) o.geometry.dispose();   // (a sprite's geometry is three's shared one)
      if (o.material && !o.userData.shared) o.material.dispose();
    }
    this.dyn.clear();
    this.sprites.length = 0;
  }

  addNumber(text, pos) {
    let lab = this.labels.get(text);
    if (!lab) {
      const l = labelTexture(text, { color: 0xffffff, size: 44, bg: 'rgba(80,40,0,0.7)' });
      lab = { texture: l.texture, aspect: l.aspect, mat: new THREE.SpriteMaterial({ map: l.texture, transparent: true, depthTest: false, depthWrite: false, fog: false }) };
      this.labels.set(text, lab);
    }
    const sp = new THREE.Sprite(lab.mat);
    sp.position.set(pos[0], pos[1], pos[2]);
    sp.renderOrder = 23;
    sp.userData.shared = true; sp.userData.aspect = lab.aspect;
    this.dyn.add(sp);
    this.sprites.push(sp);
  }

  upsertStart() {
    const s = this.start;
    this.gfx.figures.upsert(START_ID, { name: 'RAJT', color: COL.start, pos: s.pos, yaw: s.yaw * DEG, pitch: 0, flags: FLAG.GROUND, ghost: true, trail: false });
    // the arrow on the floor in front of the feet
    const y = s.pos[1] + 0.06, a = s.yaw * DEG, f = [-Math.sin(a), -Math.cos(a)], r = [Math.cos(a), -Math.sin(a)];
    const x0 = s.pos[0] + f[0] * 0.7, z0 = s.pos[2] + f[1] * 0.7, x1 = s.pos[0] + f[0] * 2.2, z1 = s.pos[2] + f[1] * 2.2;
    const P = this.arrow.geometry.attributes.position;
    const seg = [[x0, z0, x1, z1], [x1, z1, x1 - f[0] * 0.5 + r[0] * 0.35, z1 - f[1] * 0.5 + r[1] * 0.35], [x1, z1, x1 - f[0] * 0.5 - r[0] * 0.35, z1 - f[1] * 0.5 - r[1] * 0.35]];
    seg.forEach((q, i) => { P.setXYZ(i * 2, q[0], y, q[1]); P.setXYZ(i * 2 + 1, q[2], y, q[3]); });
    P.needsUpdate = true;
  }

  // ---------------------------------------------------------------- the per-frame part
  setSelection(item) {
    this.sel.set(item);
    if (item && item.t === 'light') {
      this.ring.visible = true;
      this.ring.position.set(item.pos[0], item.pos[1], item.pos[2]);
      this.ring.scale.set(item.range, 1, item.range);
    } else this.ring.visible = false;
  }
  setGhost(item) { this.ghost.set(item); }

  // the bounds of the non-primary items of a group selection (rebuilt only when `key` differs from the last call)
  setMulti(items, key) {
    if (key === this.multiKey) return;
    this.multiKey = key;
    if (this.multi) { this.group.remove(this.multi); this.multi.geometry.dispose(); this.multi = null; }
    if (!items.length) return;
    const pos = [];
    for (const it of items) {
      const b = itemAabb(it), cs = [];
      for (let i = 0; i < 8; i++) cs.push([i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]]);
      for (const e of BOX_EDGES) for (const v of e) pos.push(...cs[v]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    this.multi = new THREE.LineSegments(g, this.multiMat);
    this.multi.frustumCulled = false; this.multi.renderOrder = 30;
    this.group.add(this.multi);
  }

  // the resize arrows: segs[i] = { base, tip, len, axis, dir } (null: hidden); hover = the index drawn in the highlight colour
  setHandles(segs, hover = -1) {
    const up = _UP;
    this.handles.forEach((h, i) => {
      const s = segs && segs[i];
      h.group.visible = !!s;
      if (!s) return;
      h.group.position.set(s.base[0], s.base[1], s.base[2]);
      _DIR.set(0, 0, 0).setComponent(s.axis, s.dir);
      h.group.quaternion.setFromUnitVectors(up, _DIR);
      h.group.scale.setScalar(s.len);
      h.mat.color.setHex(i === hover ? COL.sel : AXIS_COL[s.axis]);
    });
  }

  setPadPreview(points) {
    if (!points) { this.padLine.visible = false; return; }
    const P = this.padLine.geometry.attributes.position;
    for (let i = 0; i < 25; i++) { const p = points[Math.min(i, points.length - 1)]; P.setXYZ(i, p[0], p[1], p[2]); }
    P.needsUpdate = true;
    this.padLine.visible = true;
  }

  setGrid(step, centre) {
    if (!centre) { if (this.grid) this.grid.visible = false; return; }
    if (step !== this.gridStep) {
      if (this.grid) { this.group.remove(this.grid); this.grid.geometry.dispose(); this.grid.material.dispose(); }
      const cells = step >= 0.5 ? 40 : 50, half = (cells * step) / 2, pos = [];
      for (let i = 0; i <= cells; i++) { const v = -half + i * step; pos.push(v, 0, -half, v, 0, half, -half, 0, v, half, 0, v); }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      this.grid = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.16, depthWrite: false, fog: false }));
      this.grid.frustumCulled = false; this.grid.renderOrder = 19;
      this.group.add(this.grid);
      this.gridStep = step;
    }
    this.grid.position.set(centre[0], centre[1] + 0.02, centre[2]);
    this.grid.visible = true;
  }

  update(camPos) {
    for (const sp of this.sprites) {
      const d = Math.hypot(sp.position.x - camPos[0], sp.position.y - camPos[1], sp.position.z - camPos[2]);
      const k = Math.max(0.5, Math.min(4, d * 0.04));
      sp.scale.set(0.5 * k * sp.userData.aspect, 0.5 * k, 1);
    }
  }

  dispose() {
    this.gfx.figures.remove(START_ID);
    this.clearDyn();
    for (const v of [this.sel, this.ghost]) v.dispose();
    if (this.multi) this.multi.geometry.dispose();
    this.multiMat.dispose();
    for (const g of this.arrowGeo) g.dispose();
    for (const h of this.handles) h.mat.dispose();
    for (const l of this.labels.values()) { l.texture.dispose(); l.mat.dispose(); }
    this.labels.clear();
    if (this.grid) { this.grid.geometry.dispose(); this.grid.material.dispose(); }
    this.ring.geometry.dispose(); this.ring.material.dispose();
    this.padLine.geometry.dispose(); this.padLine.material.dispose();
    this.arrow.geometry.dispose(); this.arrow.material.dispose();
    this.gfx.scene.remove(this.group);
  }
}

const BULB = new THREE.SphereGeometry(0.25, 12, 8);
const _UP = new THREE.Vector3(0, 1, 0), _DIR = new THREE.Vector3();
function circleGeo(n) {
  const p = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; p.push(Math.cos(a), 0, Math.sin(a)); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  return g;
}
