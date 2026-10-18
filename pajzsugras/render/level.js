// The level renderer: builds everything from world.map (never from the map files).
//
//   const level = new Level(map, { quality, maxAniso, surf, sync });   surf: reuse the Surfaces (canvas textures) of another level
//                                                  (the editor's rebuilds; this level takes them over), sync: no yields to the UI
//   await level.build(onProgress(0..1, text))     merged meshes per material and 36 m cell, mover groups, checkpoints (glowing
//                                                  zones), finish gate, pads, lava / lasers, floor glyphs, hologram signs, markers,
//                                                  the 4-light pool
//   level.group                                    add to the scene
//   level.update(world, alpha, t, dt, camPos)      movers, animations, checkpoint states, light pool
//   level.flashPad(i)  level.dispose({ keepSurf })   keepSurf: the Surfaces now belong to the next level (editor rebuild)
//   (map.finish may be null on a custom map: no gate is built)
import * as THREE from 'three';
import { Merger, lin } from './merge.js';
import { addDeco, disposeDecoCache } from './deco.js';
import { Surfaces, signTexture, labelTexture, glyphTexture, checkerTexture, beamTexture, padTexture } from './textures.js';

const yieldUI = () => new Promise((r) => setTimeout(r, 0));
const noYield = () => Promise.resolve();
const DEG = Math.PI / 180;
const CP_NEXT = 0xffd060, CP_FUTURE = 0xff8a2a, CP_TAKEN = 0x30e8b0;
const POOL = 4;
const LIGHT_K = 0.4;   // candela per (intensity * range^2)

const hash1 = (n) => { let h = Math.imul(n + 0x9e3779b9, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };

function vgradTexture() {
  const c = document.createElement('canvas');
  c.width = 4; c.height = 64;
  const x = c.getContext('2d'), g = x.createLinearGradient(0, 0, 0, 64);
  g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(255,255,255,1)');
  x.fillStyle = g; x.fillRect(0, 0, 4, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function checkerFloorTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const x = c.getContext('2d');
  x.fillStyle = '#f2f4f6'; x.fillRect(0, 0, 64, 64);
  x.fillStyle = '#12181e'; x.fillRect(0, 0, 32, 32); x.fillRect(32, 32, 32, 32);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = THREE.NearestFilter;
  return t;
}

// ---- lava: animated glowing surface (fog aware) ----
const LAVA_V = /* glsl */`
varying vec2 vW;
#include <fog_pars_vertex>
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const LAVA_F = /* glsl */`
uniform float uTime;
uniform vec3 uHot, uMid, uCrust;
varying vec2 vW;
#include <fog_pars_fragment>
float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * vn(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
void main() {
  vec2 p = vW * 0.16;
  vec2 q = vec2(fbm(p + vec2(0.0, uTime * 0.05)), fbm(p + vec2(5.2, 1.3) - uTime * 0.04));
  float n = fbm(p + 2.2 * q + uTime * 0.03);
  float veins = smoothstep(0.045, 0.0, abs(n - 0.5));
  vec3 col = mix(uCrust, uMid, smoothstep(0.34, 0.56, n));
  col = mix(col, uHot, smoothstep(0.6, 0.86, n) * 0.85);
  col += uHot * veins * 0.8;
  col *= 0.85 + 0.2 * sin(uTime * 1.3 + n * 7.0);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

export class Level {
  constructor(map, { quality = 'kozepes', maxAniso = 4, surf = null, sync = false } = {}) {
    this.map = map;
    this.quality = quality;
    this.yieldUI = sync ? noYield : yieldUI;
    this.group = new THREE.Group();
    this.group.name = 'level';
    this.surf = surf || new Surfaces(quality, maxAniso);
    this.anim = [];
    this.movers = new Map();
    this.screens = new Map();
    this.cps = [];
    this.pads = [];
    this.signs = [];
    this.glyphs = [];
    this.lasers = [];
    this.lavas = [];
    this.lights = [];
    this.slots = [];
    this.finishGate = null;
    this.lastCp = -2;
    this.textures = [];
  }

  async build(onProgress = () => {}) {
    const map = this.map, pal = map.theme.palette, surf = this.surf;
    // ---- 1. materials (the slow part: canvas textures) ----
    const need = new Map();
    for (const b of map.brushes.concat(map.decoBrushes)) for (const f of b.faces) need.set(b.mat + (f.top ? '|t' : '|s'), [b.mat, f.top]);
    let i = 0;
    for (const [, [name, top]] of need) {
      surf.material(map.materials[name], top);
      onProgress(0.05 + 0.45 * (++i / need.size), 'Textúrák');
      await this.yieldUI();
    }
    for (const k of ['metal', 'concrete', 'crate']) { surf.deco(k); await this.yieldUI(); }
    if (map.deco.some((d) => d.kind === 'rock')) surf.deco('rock');

    // ---- 2. geometry ----
    onProgress(0.55, 'Pálya');
    // ONE chunk per material: these maps are light on triangles (about 100k) and heavy on draw calls, so no spatial split
    const mStatic = new Merger(Infinity);
    const ctxFor = (m, parent) => ({ m, surf, palette: pal, parent, anim: this.anim, screens: this.screens, disposables: [] });
    const statics = ctxFor(mStatic, this.group);
    const moverCtx = new Map();
    for (const mv of map.movers) {
      const g = new THREE.Group();
      g.name = 'mover:' + mv.id;
      this.group.add(g);
      const m = new Merger(Infinity);
      this.movers.set(mv.id, { group: g, m });
      moverCtx.set(mv.id, ctxFor(m, g));
    }
    const ctxOf = (moverId) => (moverId == null ? statics : moverCtx.get(moverId) || statics);

    const addBrush = (b, idx, deco) => {
      const c = ctxOf(b.mover), tint = 0.93 + 0.14 * hash1(idx * 2 + (deco ? 1 : 0));
      const h = Math.max(0.001, b.max[1] - b.min[1]);
      for (const f of b.faces) {
        const mat = surf.material(map.materials[b.mat], f.top);
        let colors;
        const vert = Math.abs(f.n[1]) < 0.3;
        if (vert && h <= 12) colors = f.verts.map((v) => { const k = tint * (1 - 0.2 * (1 - Math.min(1, Math.max(0, (v[1] - b.min[1]) / h)))); return [k, k, k]; });
        else { const k = tint * (f.n[1] < -0.3 ? 0.62 : 1); colors = [k, k, k]; }
        c.m.poly(mat, f.verts, f.n, colors);
      }
    };
    map.brushes.forEach((b, k) => addBrush(b, k, false));
    map.decoBrushes.forEach((b, k) => addBrush(b, k, true));
    await this.yieldUI();
    onProgress(0.7, 'Díszletek');
    for (const d of map.deco) addDeco(ctxOf(d.mover), d);
    await this.yieldUI();

    // ---- 3. gameplay visuals ----
    onProgress(0.8, 'Jelzések');
    this.buildKills(statics);
    this.buildFinish(statics);
    this.buildCheckpoints();
    this.buildPads();
    this.buildGlyphs();
    this.buildSigns();
    this.buildMarkers();
    this.buildLights();

    mStatic.build(this.group);
    for (const { group, m } of this.movers.values()) m.build(group);
    onProgress(0.95, 'Fények');
    await this.yieldUI();
  }

  // ---------------------------------------------------------------- kill volumes
  buildKills(ctx) {
    const map = this.map, surf = this.surf;
    const beams = [];
    for (const k of map.kills) {
      if (k.kind === 'lava') {
        const w = k.max[0] - k.min[0], d = k.max[2] - k.min[2];
        const mat = new THREE.ShaderMaterial({
          uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
            uTime: { value: 0 }, uHot: { value: new THREE.Vector3(...lin(0xffc040, 1.7)) },
            uMid: { value: new THREE.Vector3(...lin(0xff4a0c, 1.1)) }, uCrust: { value: new THREE.Vector3(...lin(0x2a0a04, 1)) },
          }]),
          vertexShader: LAVA_V, fragmentShader: LAVA_F, fog: true,
        });
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.set((k.min[0] + k.max[0]) / 2, k.max[1] - 0.04, (k.min[2] + k.max[2]) / 2);
        mesh.receiveShadow = false;
        this.group.add(mesh);
        this.lavas.push(mat);
      } else if (k.kind === 'laser') {
        const dim = [k.max[0] - k.min[0], k.max[1] - k.min[1], k.max[2] - k.min[2]], mid = [0, 1, 2].map((a) => (k.min[a] + k.max[a]) / 2);
        const L = dim.indexOf(Math.max(...dim));
        const others = [0, 1, 2].filter((a) => a !== L).sort((a, b) => dim[b] - dim[a]);
        const [big, small] = others;
        const n = dim[big] < 0.9 ? 1 : Math.min(14, Math.max(2, Math.round(dim[big] / 0.7)));
        for (let j = 0; j < n; j++) {
          const c = mid.slice();
          if (n > 1) c[big] = k.min[big] + ((j + 0.5) / n) * dim[big];
          const p0 = c.slice(), p1 = c.slice();
          p0[L] = k.min[L]; p1[L] = k.max[L];
          beams.push({ p0, p1, L, a: big, b: small });
          for (const p of [p0, p1]) ctx.m.geo(surf.glow, new THREE.SphereGeometry(0.16, 10, 8), new THREE.Matrix4().setPosition(p[0], p[1], p[2]), { color: lin(0xff3020, 1.8) });
        }
      }
    }
    if (beams.length) {
      const pos = [], uv = [], idx = [];
      const W = 0.3;
      for (const bm of beams) {
        for (const ax of [bm.a, bm.b]) {
          const o = pos.length / 3, d = [0, 0, 0];
          d[ax] = W / 2;
          for (const p of [bm.p0, bm.p1]) pos.push(p[0] - d[0], p[1] - d[1], p[2] - d[2], p[0] + d[0], p[1] + d[1], p[2] + d[2]);
          uv.push(0, 0, 1, 0, 0, 1, 1, 1);
          idx.push(o, o + 1, o + 3, o, o + 3, o + 2);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      const tex = beamTexture();
      this.textures.push(tex);
      const mat = new THREE.MeshBasicMaterial({ map: tex, color: new THREE.Color(...lin(0xff3a28, 1.5)), transparent: true, depthWrite: false, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(g, mat);
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.lasers.push(mat);
    }
  }

  // ---------------------------------------------------------------- finish gate
  buildFinish(ctx) {
    const f = this.map.finish, surf = this.surf;
    if (!f) return;
    const w = f.max[0] - f.min[0], d = f.max[2] - f.min[2], h = f.max[1] - f.min[1];
    const alongX = w >= d, width = alongX ? w : d, depth = alongX ? d : w;
    const cx = (f.min[0] + f.max[0]) / 2, cz = (f.min[2] + f.max[2]) / 2;
    const y0 = f.min[1], H = Math.max(4.5, Math.min(h, 7));
    const root = new THREE.Group();
    root.position.set(cx, y0, cz);
    root.rotation.y = alongX ? 0 : Math.PI / 2;   // the gate's width runs along local x
    this.group.add(root);
    const tint = lin(0xe8edf0), glow = lin(0xffd060, 2.6);
    const mat = surf.deco('metal'), box = new THREE.BoxGeometry(1, 1, 1);
    // posts + crossbar in the merged metal bucket (world space)
    const rot = alongX ? 0 : Math.PI / 2;
    const M = new THREE.Matrix4().compose(new THREE.Vector3(cx, y0, cz), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rot, 0)), new THREE.Vector3(1, 1, 1));
    const loc = (x, y, z, sx, sy, sz) => M.clone().multiply(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion(), new THREE.Vector3(sx, sy, sz)));
    for (const s of [-1, 1]) {
      ctx.m.geo(mat, box, loc(s * (width / 2 - 0.3), H / 2, 0, 0.6, H, 0.6), { color: tint, planar: true });
      ctx.m.geo(surf.glow, box, loc(s * (width / 2 - 0.3), H / 2, 0.31, 0.12, H, 0.04), { color: glow });
      ctx.m.geo(surf.glow, box, loc(s * (width / 2 - 0.3), H / 2, -0.31, 0.12, H, 0.04), { color: glow });
      ctx.m.geo(surf.halo, new THREE.CylinderGeometry(0.5, 0.5, H * 1.25, 10, 1, true), loc(s * (width / 2 - 0.3), H * 0.62, 0, 1, 1, 1), { color: [...lin(0xffd060), 0.14] });
    }
    ctx.m.geo(mat, box, loc(0, H - 0.3, 0, width, 0.6, 0.7), { color: tint, planar: true });
    ctx.m.geo(surf.glow, box, loc(0, H - 0.62, 0.36, width - 1.2, 0.08, 0.04), { color: glow });
    ctx.m.geo(surf.glow, box, loc(0, H - 0.62, -0.36, width - 1.2, 0.08, 0.04), { color: glow });
    // the banner
    const tex = checkerTexture('CÉL');
    this.textures.push(tex);
    const banner = new THREE.Mesh(new THREE.PlaneGeometry(width - 1.4, Math.min(1.6, (width - 1.4) * 0.25)), new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, color: new THREE.Color(1.15, 1.15, 1.15) }));
    banner.position.set(0, H - 1.55, 0);
    root.add(banner);
    // the chequered floor strip
    const ft = checkerFloorTexture();
    ft.repeat.set(Math.max(2, Math.round(width / 1.2)), Math.max(1, Math.round(depth / 1.2)));
    this.textures.push(ft);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), new THREE.MeshBasicMaterial({ map: ft, transparent: true, opacity: 0.75, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
    floor.rotation.x = -Math.PI / 2; floor.position.set(0, 0.035, 0);
    root.add(floor);
    this.finishGate = { root, banner, floor };
    this.finishBeams = [];
    // corner light columns of the whole zone
    const vt = vgradTexture();
    this.textures.push(vt);
    const colMat = new THREE.MeshBasicMaterial({ map: vt, color: new THREE.Color(...lin(0xffd060, 1.2)), transparent: true, opacity: 0.4, depthWrite: false, side: THREE.DoubleSide });
    for (const sx of [f.min[0], f.max[0]]) for (const sz of [f.min[2], f.max[2]]) {
      const c = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, H, 8, 1, true), colMat);
      c.position.set(sx, y0 + H / 2, sz);
      this.group.add(c);
    }
    this.finishMat = colMat;
  }

  // ---------------------------------------------------------------- checkpoints
  buildCheckpoints() {
    const vt = vgradTexture();
    this.textures.push(vt);
    const T = (x, y, z) => new THREE.Matrix4().makeTranslation(x, y, z);
    for (const cp of this.map.checkpoints) {
      const root = new THREE.Group();
      this.group.add(root);
      const y0 = cp.spawn[1] + 0.03, h = Math.min(7, Math.max(3, cp.max[1] - cp.min[1]));
      const x0 = cp.min[0], x1 = cp.max[0], z0 = cp.min[2], z1 = cp.max[2];
      const col = new THREE.Color(...lin(CP_FUTURE));
      const beamMat = new THREE.MeshBasicMaterial({ map: vt, color: col.clone(), transparent: true, opacity: 0.4, depthWrite: false, side: THREE.DoubleSide });
      const lineMat = new THREE.MeshBasicMaterial({ color: col.clone().multiplyScalar(1.6), transparent: true, opacity: 0.8, depthWrite: false });
      const innerMat = new THREE.MeshBasicMaterial({ color: col.clone().multiplyScalar(0.5), transparent: true, opacity: 0.25, depthWrite: false });
      const m = new Merger(Infinity);
      const colG = new THREE.CylinderGeometry(0.13, 0.13, h, 8, 1, true);
      for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) m.geo(beamMat, colG, T(x, y0 + h / 2, z));
      const q = new THREE.Quaternion(), e = new THREE.Euler(), one = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
      const edge = (ax, az, bx, bz) => {
        const len = Math.hypot(bx - ax, bz - az);
        e.set(-Math.PI / 2, 0, -Math.atan2(bz - az, bx - ax), 'XYZ'); q.setFromEuler(e);
        m.geo(lineMat, new THREE.PlaneGeometry(len, 0.14), new THREE.Matrix4().compose(p.set((ax + bx) / 2, y0, (az + bz) / 2), q, one));
      };
      edge(x0, z0, x1, z0); edge(x1, z0, x1, z1); edge(x1, z1, x0, z1); edge(x0, z1, x0, z0);
      // the respawn ring where you reappear
      e.set(-Math.PI / 2, 0, 0, 'XYZ'); q.setFromEuler(e);
      m.geo(lineMat, new THREE.RingGeometry(0.75, 0.95, 40), new THREE.Matrix4().compose(p.set(cp.spawn[0], y0 + 0.01, cp.spawn[2]), q, one));
      m.geo(innerMat, new THREE.CircleGeometry(0.7, 32), new THREE.Matrix4().compose(p.set(cp.spawn[0], y0 + 0.005, cp.spawn[2]), q, one));
      m.build(root, { cast: false, receive: false });
      const lab = labelTexture(cp.label, { color: 0xffffff, size: 40 });
      this.textures.push(lab.texture);
      const sm = new THREE.SpriteMaterial({ map: lab.texture, transparent: true, depthWrite: false, color: 0xffffff });
      const sp = new THREE.Sprite(sm);
      sp.scale.set(0.5 * lab.aspect, 0.5, 1);
      sp.position.set(cp.spawn[0], y0 + 2.6, cp.spawn[2]);
      root.add(sp);
      this.cps.push({ root, beamMat, lineMat, innerMat, sprite: sm, state: 'future' });
    }
  }

  setCpStates(cpIndex, t) {
    this.cps.forEach((c, i) => {
      const st = i < cpIndex ? 'taken' : i === cpIndex ? 'next' : 'future';
      if (st !== c.state) {
        c.state = st;
        const hex = st === 'taken' ? CP_TAKEN : st === 'next' ? CP_NEXT : CP_FUTURE;
        const col = new THREE.Color(...lin(hex));
        c.beamMat.color.copy(col);
        c.lineMat.color.copy(col).multiplyScalar(1.6);
        c.innerMat.color.copy(col).multiplyScalar(0.5);
        c.sprite.opacity = st === 'taken' ? 0.45 : 1;
      }
      const pulse = c.state === 'next' ? 0.75 + 0.25 * Math.sin(t * 4) : 1;
      c.beamMat.opacity = (c.state === 'taken' ? 0.18 : c.state === 'next' ? 0.55 : 0.3) * pulse;
      c.lineMat.opacity = (c.state === 'taken' ? 0.35 : 0.85) * pulse;
    });
  }

  // ---------------------------------------------------------------- jump pads
  buildPads() {
    const pal = this.map.theme.palette, vt = vgradTexture();
    this.textures.push(vt);
    const padCol = pal.glow;
    const tex = padTexture(padCol);
    this.textures.push(tex);
    const baseMat = new THREE.MeshStandardMaterial({ color: 0x30383e, roughness: 0.5, metalness: 0.6 });
    this.map.pads.forEach((pad) => {
      const root = new THREE.Group();
      root.position.set(pad.pos[0], pad.pos[1], pad.pos[2]);
      const base = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.1, 0.16, 28), baseMat);
      base.position.y = 0.08; base.castShadow = true; base.receiveShadow = true;
      root.add(base);
      const discMat = new THREE.MeshBasicMaterial({ map: tex, color: new THREE.Color(...lin(0xffffff, 1.6)), transparent: true, depthWrite: false });
      const disc = new THREE.Mesh(new THREE.CircleGeometry(0.92, 36), discMat);
      disc.rotation.set(-Math.PI / 2, Math.atan2(-(pad.target[0] - pad.pos[0]), -(pad.target[2] - pad.pos[2])), 0, 'YXZ');   // the chevrons point at the target
      disc.position.y = 0.17;
      root.add(disc);
      const rings = [];
      for (let k = 0; k < 2; k++) {
        const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(...lin(padCol, 2)), transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide });
        const r = new THREE.Mesh(new THREE.RingGeometry(0.8, 0.95, 36), mat);
        r.rotation.x = -Math.PI / 2;
        root.add(r);
        rings.push({ mesh: r, mat, phase: k * 0.5 });
      }
      const coneMat = new THREE.MeshBasicMaterial({ map: vt, color: new THREE.Color(...lin(padCol, 1.2)), transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide });
      const cone = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.95, 2.6, 20, 1, true), coneMat);
      cone.position.y = 1.5;
      root.add(cone);
      this.group.add(root);
      this.pads.push({ rings, discMat, coneMat, flash: 0 });
    });
  }
  flashPad(i) { if (this.pads[i]) this.pads[i].flash = 1; }

  // ---------------------------------------------------------------- floor glyphs
  buildGlyphs() {
    const pal = this.map.theme.palette, mats = {};
    const color = { shield: pal.trim, walldodge: pal.accent, arrow: pal.glow, dj: pal.glow };
    const size = { shield: 2.3, walldodge: 2.3, arrow: 1.9, dj: 2.3 };
    const m = new Merger(Infinity), q = new THREE.Quaternion(), e = new THREE.Euler(), one = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
    const geos = {};
    for (const g of this.map.glyphs) {
      if (!mats[g.kind]) {
        const tex = glyphTexture(g.kind, color[g.kind] ?? pal.glow);
        this.textures.push(tex);
        mats[g.kind] = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, opacity: 0.9 });
        this.glyphs.push(mats[g.kind]);
        geos[g.kind] = new THREE.PlaneGeometry(size[g.kind] ?? 2.2, size[g.kind] ?? 2.2);
      }
      e.set(-Math.PI / 2, g.yaw * DEG, 0, 'YXZ'); q.setFromEuler(e);
      m.geo(mats[g.kind], geos[g.kind], new THREE.Matrix4().compose(p.set(g.pos[0], g.pos[1] + 0.01, g.pos[2]), q, one));
    }
    m.build(this.group, { cast: false, receive: false });
    for (const k of Object.values(geos)) k.dispose();
  }

  // ---------------------------------------------------------------- hologram signs + floating markers
  buildSigns() {
    const pal = this.map.theme.palette;
    for (const s of this.map.signs) {
      const { texture, aspect } = signTexture(s, pal, this.surf.aniso);
      this.textures.push(texture);
      const w = 3.3, h = w / aspect;
      const mat = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, opacity: 0.96 });
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
      m.position.set(s.pos[0], s.pos[1], s.pos[2]);
      m.rotation.y = s.yaw * DEG;
      m.renderOrder = 3;
      this.group.add(m);
      this.signs.push({ mesh: m, mat, y: s.pos[1], phase: hash1(Math.round(s.pos[0] * 10 + s.pos[2] * 7)) * 6 });
    }
  }
  buildMarkers() {
    for (const mk of this.map.markers) {
      const { texture, aspect } = labelTexture(mk.text, { color: 0xfff0d0, size: 40, bg: 'rgba(6,16,24,0.5)' });
      this.textures.push(texture);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
      sp.scale.set(0.42 * aspect, 0.42, 1);
      sp.position.set(mk.pos[0], mk.pos[1], mk.pos[2]);
      this.group.add(sp);
    }
  }

  // ---------------------------------------------------------------- light pool
  buildLights() {
    this.lightDefs = this.map.lights;
    for (let i = 0; i < POOL; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 10, 2);
      l.castShadow = false;
      this.group.add(l);
      this.slots.push({ light: l, idx: -1, k: 0, fade: false });
    }
  }

  // ---------------------------------------------------------------- per frame
  update(world, alpha, t, dt, camPos) {
    for (const [id, mv] of this.movers) { const o = world.moverOffset(id, alpha); mv.group.position.set(o[0], o[1], o[2]); }
    for (const fn of this.anim) fn(dt, t);
    this.setCpStates(world.cpIndex, t);
    const ready = world.cpIndex >= world.cpCount;
    if (this.finishMat) this.finishMat.opacity = ready ? 0.55 + 0.15 * Math.sin(t * 3.5) : 0.2;
    if (this.finishGate) this.finishGate.floor.material.opacity = ready ? 0.85 : 0.45;
    for (const m of this.lavas) m.uniforms.uTime.value = t;
    for (const m of this.lasers) m.opacity = 0.8 + 0.2 * Math.sin(t * 37) * Math.sin(t * 11);
    for (const p of this.pads) {
      p.flash = Math.max(0, p.flash - dt * 2.5);
      p.discMat.opacity = 0.8 + 0.2 * Math.sin(t * 4) + p.flash * 0.4;
      p.coneMat.opacity = 0.3 + 0.1 * Math.sin(t * 4) + p.flash * 0.5;
      for (const r of p.rings) {
        const u = (t * 0.9 + r.phase) % 1;
        r.mesh.position.y = 0.2 + u * 1.7;
        r.mesh.scale.setScalar(1 - u * 0.35);
        r.mat.opacity = (1 - u) * (0.55 + p.flash * 0.5);
      }
    }
    for (const g of this.glyphs) g.opacity = 0.72 + 0.28 * (0.5 + 0.5 * Math.sin(t * 3));
    for (const s of this.signs) {
      s.mesh.position.y = s.y + Math.sin(t * 1.3 + s.phase) * 0.04;
      s.mat.opacity = 0.92 + 0.06 * Math.sin(t * 17 + s.phase) * Math.sin(t * 2.3 + s.phase);
    }
    this.updateLights(dt, camPos);
  }

  updateLights(dt, cam) {
    const defs = this.lightDefs;
    if (!defs.length) return;
    // the POOL nearest lights (by distance to the camera, discounted by range)
    const order = defs.map((d, i) => [Math.hypot(d.pos[0] - cam.x, d.pos[1] - cam.y, d.pos[2] - cam.z) - d.range * 0.5, i]).sort((a, b) => a[0] - b[0]);
    const want = new Set(order.slice(0, POOL).map((o) => o[1]));
    for (const s of this.slots) {
      if (s.idx >= 0 && !want.has(s.idx)) s.fade = true;
      if (s.idx >= 0 && want.has(s.idx)) s.fade = false;
    }
    const have = new Set(this.slots.filter((s) => s.idx >= 0 && !s.fade).map((s) => s.idx));
    for (const i of want) {
      if (have.has(i)) continue;
      const free = this.slots.find((s) => s.idx < 0);
      if (free) { free.idx = i; free.k = 0; free.fade = false; const d = defs[i]; free.light.position.set(d.pos[0], d.pos[1], d.pos[2]); free.light.color.setHex(d.color); free.light.distance = d.range; }
    }
    for (const s of this.slots) {
      if (s.idx < 0) { s.light.intensity = 0; continue; }
      s.k = s.fade ? s.k - dt * 3 : Math.min(1, s.k + dt * 3);
      if (s.k <= 0) { s.idx = -1; s.light.intensity = 0; continue; }
      const d = defs[s.idx];
      s.light.intensity = d.intensity * d.range * d.range * LIGHT_K * s.k;
    }
  }

  dispose({ keepSurf = false } = {}) {
    const shared = keepSurf ? new Set(this.surf.mats.values()) : null;   // (the next level draws with these)
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of ms) { if (shared && shared.has(m)) continue; if (m.map) m.map.dispose(); m.dispose(); }
    });
    for (const t of this.textures) t.dispose();
    for (const t of this.screens.values()) t.dispose();
    if (!keepSurf) { this.surf.dispose(); disposeDecoCache(); }
    this.group.clear();
  }
}
