// Other runners: the Gorge (an optional local model, see gorge.js; animated by gorge-anim.js) or, when the model is not there, stylised
// robot figures; each with a name tag and a ribbon trail. Ghosts (the personal-best / #1 ghost) are drawn translucent. Positions are FEET
// positions in world space, yaw / pitch in radians.
//
//   const figs = new Figures(scene);
//   figs.upsert(id, { name, color, pos, yaw, pitch, flags, ghost = false, solid = false, infer = false, trail = true, label = true, hidden = false })
//   figs.remove(id)  figs.snap(id)  figs.clear()  figs.update(dt, camera)  figs.dispose()  figs.info()  figs.warm(renderer, camera)
// flags are the sim's FLAG bits (GROUND, CHARGE, BLAST, DODGING, DJ_USED, FINISHED, WALL = a wall dodge was used this airtime). ghost: translucent robot / ghost-tinted Gorge;
// solid (with ghost: no collision, but a body): the Gorge is drawn opaque with a faint rim in the player's colour (the robot stays a ghost;
// the opaque Gorge is hidden while the camera is inside its body);
// infer: the flags are not real (recorded ghosts): the Gorge's air state is derived from the vertical motion.
// hidden: not drawn (it still animates); the player's own figure in the third-person view uses it while the camera is pulled in close to the head.
// info() = what each figure plays now (model 'gorge' | 'robot', clip, weight, weapon = the UT2004 shield gun is in its hand, ...), also in __pj.state().figures.
// The Gorge holds the UT2004 shield gun (shieldgun.js, the player's local extract) when that model is there on a local dev build (local-ut.js): every Gorge figure, ghosts included
// (a ghost's gun is translucent too); the robot already has its own gun and gets none.
import * as THREE from 'three';
import { labelTexture } from './textures.js';
import { Merger, lin } from './merge.js';
import { FLAG } from '../sim/const.js';
import { AnimBrain } from './gorge-anim.js';
import { gorgeTemplate, loadGorge, GorgeRig } from './gorge.js';
import { utMod } from './ut-gun.js';

const TRAIL_N = 36;
const BODY_R = 0.75, BODY_H = 2.1, BODY_BELOW = 0.3;   // m: a solid figure is hidden while the camera is this close to its axis and between its knees and above its head
const BOX = new THREE.BoxGeometry(1, 1, 1);
const CYL = new THREE.CylinderGeometry(0.5, 0.5, 1, 10);
const SPH = new THREE.SphereGeometry(0.5, 16, 12);

// the vertex-coloured body material, shared by every non-ghost figure
const SHARED = {
  mat: null,
  body() { return this.mat || (this.mat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, metalness: 0.45, roughness: 0.45 })); },
};

class Figure {
  constructor(id, scene) {
    this.id = id;
    this.scene = scene;
    this.root = new THREE.Group();
    this.root.name = 'figure:' + id;
    scene.add(this.root);
    this.opts = { name: '', color: 0xffffff, ghost: false, trail: true, label: true };
    this.pos = new THREE.Vector3(); this.prev = new THREE.Vector3(); this.have = false;
    this.speed = 0; this.vy = 0; this.phase = 0; this.flags = 0; this.pitch = 0;
    this.trailPts = [];
    this.built = null;
    this.brain = new AnimBrain(); this.rig = null; this.gun = null; this.aura = null; this.parts = null; this.ghostMat = null; this.tmp = [0, 0, 0];
  }

  // the Gorge (with the shield gun in its hand when that model is loaded) when its template is loaded, else the robot; rebuilt when ghost / solid /
  // colour change or a template arrives
  build() {
    const o = this.opts, ghost = o.ghost, solid = !!o.solid, tpl = gorgeTemplate(), b = this.built;
    const gm = utMod(), hasGun = !!(tpl && gm && gm.shieldGunTemplates().third);
    if (b && b.ghost === ghost && b.color === o.color && b.solid === solid && b.gorge === !!tpl && b.gun === hasGun) return;
    this.dispose(false);
    const mats = [];
    const R = new THREE.Group();   // everything, so the figure can be posed / leaned
    this.root.add(R);
    if (tpl) {
      this.rig = new GorgeRig(tpl, { ghost, solid, color: o.color });
      R.add(this.rig.root);
      this.gun = gm ? gm.attachShieldGun(this.rig, { ghost, solid, color: o.color }) : null;
      this.brain.reset();
    } else this.buildRobot(R, mats);
    // shield aura while charging
    const auraMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(...lin(o.color, 1.6)), transparent: true, opacity: 0, depthWrite: false });
    this.aura = new THREE.Mesh(SPH, auraMat);
    this.aura.position.set(0, 0.95, 0); this.aura.scale.set(1.3, 1.9, 1.3);
    this.aura.visible = !ghost;
    R.add(this.aura);
    mats.push(auraMat);
    this.R = R;
    this.mats = mats;
    this.built = { ghost, color: o.color, solid, gorge: !!tpl, gun: hasGun };
    // trail
    if (!this.trailMesh) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL_N * 2 * 3), 3));
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(TRAIL_N * 2 * 4), 4));
      const idx = [];
      for (let i = 0; i < TRAIL_N - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      g.setIndex(idx);
      this.trailMesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
      this.trailMesh.frustumCulled = false;
      this.scene.add(this.trailMesh);
    }
    this.trailCol = lin(o.color, 1.8);
    this.buildTag();
  }

  // the stylised robot: a vertex-coloured body, a glow material per figure (a ghost is one translucent material); fills this.parts
  buildRobot(R, mats) {
    const o = this.opts, ghost = o.ghost;
    const col = new THREE.Color(...lin(o.color));
    // one vertex-coloured material for the whole body (shared), a glow material per figure; a ghost is one translucent material
    let bodyMat, glowMat;
    if (ghost) {
      bodyMat = glowMat = new THREE.MeshBasicMaterial({ color: col.clone().multiplyScalar(0.85), transparent: true, opacity: 0.45, depthWrite: false });
      mats.push(bodyMat);
    } else {
      bodyMat = SHARED.body();
      glowMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(...lin(o.color, 2.6)) });
      mats.push(glowMat);
    }
    const tone = { body: lin(0x4a545c), dark: lin(0x20262b), accent: lin(o.color), glow: [1, 1, 1] };
    const M4 = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler(), V = new THREE.Vector3(), S = new THREE.Vector3();
    // merge pieces [geo, kind, x, y, z, sx, sy, sz, rx, ry, rz] into the meshes of a group (one per material)
    const bake = (group, pieces) => {
      const m = new Merger(Infinity);
      for (const [geo, kind, x, y, z, sx, sy, sz, rx = 0, ry = 0, rz = 0] of pieces) {
        E.set(rx, ry, rz, 'YXZ'); Q.setFromEuler(E);
        M4.compose(V.set(x, y, z), Q, S.set(sx, sy, sz));
        m.geo(kind === 'glow' ? glowMat : bodyMat, geo, M4, { color: tone[kind] });
      }
      for (const mesh of m.build(group, { cast: !ghost, receive: false })) mesh.frustumCulled = false;
    };
    const parts = {};
    const grp = (parent, x, y, z) => { const g = new THREE.Group(); g.position.set(x, y, z); parent.add(g); return g; };
    parts.body = grp(R, 0, 0.86, 0);
    bake(parts.body, [
      [BOX, 'accent', 0, 0.3, 0, 0.5, 0.52, 0.3], [BOX, 'body', 0, 0.3, -0.155, 0.36, 0.34, 0.03], [BOX, 'glow', 0, 0.36, -0.175, 0.14, 0.06, 0.02],
      [BOX, 'dark', 0, 0.02, 0, 0.36, 0.14, 0.24], [BOX, 'accent', -0.33, 0.5, 0, 0.14, 0.14, 0.14], [BOX, 'accent', 0.33, 0.5, 0, 0.14, 0.14, 0.14],
    ]);
    parts.head = grp(parts.body, 0, 0.72, 0);
    bake(parts.head, [
      [BOX, 'body', 0, 0, 0, 0.27, 0.25, 0.27], [BOX, 'glow', 0, 0.01, -0.14, 0.21, 0.07, 0.02], [CYL, 'dark', 0.09, 0.2, 0.04, 0.02, 0.2, 0.02], [SPH, 'glow', 0.09, 0.3, 0.04, 0.05, 0.05, 0.05],
    ]);
    parts['arm-1'] = grp(parts.body, -0.33, 0.5, 0);
    bake(parts['arm-1'], [[BOX, 'body', 0, -0.25, 0, 0.1, 0.4, 0.11]]);
    parts.arm1 = grp(parts.body, 0.33, 0.5, 0);   // the right arm holds the shield gun
    bake(parts.arm1, [
      [BOX, 'body', 0, -0.25, 0, 0.1, 0.4, 0.11], [BOX, 'dark', 0, -0.45, -0.18, 0.08, 0.08, 0.26], [CYL, 'accent', 0, -0.45, -0.34, 0.2, 0.03, 0.2, Math.PI / 2], [SPH, 'glow', 0, -0.45, -0.3, 0.07, 0.07, 0.07],
    ]);
    for (const s of [-1, 1]) {   // legs, pivoting at the hips (thigh, shin and boot are one piece)
      parts['leg' + s] = grp(R, s * 0.13, 0.86, 0);
      bake(parts['leg' + s], [[BOX, 'body', 0, -0.22, 0, 0.15, 0.46, 0.17], [BOX, 'dark', 0, -0.64, 0, 0.13, 0.4, 0.15], [BOX, 'accent', 0, -0.84, -0.04, 0.16, 0.08, 0.26]]);
    }
    this.parts = parts;
    this.ghostMat = ghost ? bodyMat : null;
  }

  buildTag() {
    const o = this.opts;
    if (this.tag) {
      const old = this.tag.userData.bar;
      if (old) { this.root.remove(old); old.material.dispose(); }
      this.root.remove(this.tag); this.tag.material.map.dispose(); this.tag.material.dispose(); this.tag = null;
    }
    if (!o.label) return;
    const { texture, aspect } = labelTexture(o.name || '?', { color: 0xffffff, size: 44, bg: 'rgba(6,16,24,0.66)' });
    const sm = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, fog: false });
    this.tag = new THREE.Sprite(sm);
    this.tag.userData.aspect = aspect;
    this.tag.position.set(0, 2.3, 0);
    this.tag.renderOrder = 5;
    this.root.add(this.tag);
    this.tagName = o.name;
    // a colour bar under the name
    const bar = new THREE.Sprite(new THREE.SpriteMaterial({ color: new THREE.Color(...lin(o.color, 1.4)), transparent: true, depthWrite: false, fog: false }));
    bar.scale.set(1, 0.08, 1); bar.position.set(0, -0.54, 0); bar.userData.bar = true;
    this.tag.userData.bar = bar;
    this.root.add(bar);
  }

  set(o) {
    const old = this.opts;
    this.opts = { ...old, ...o };
    const p = o.pos;
    if (p) {
      if (!this.have) { this.pos.set(p[0], p[1], p[2]); this.prev.copy(this.pos); this.have = true; }
      else this.pos.set(p[0], p[1], p[2]);
    }
    if (o.yaw !== undefined) this.yaw = o.yaw;
    if (o.pitch !== undefined) this.pitch = o.pitch;
    if (o.flags !== undefined) this.flags = o.flags;
    const rebuild = !this.built || this.opts.ghost !== old.ghost || this.opts.color !== old.color || this.opts.solid !== old.solid;
    if (rebuild) this.build();
    else if (this.opts.name !== this.tagName || this.opts.label !== old.label) this.buildTag();
  }

  // the sim put the figure somewhere else (a respawn, a restart, a teleport): no velocity, no air state, no trail across the jump. Whatever the
  // distance: the animation brain only takes a jump of more than 8 m for one, so a respawn close to where the runner stood would otherwise be a run.
  snap() {
    this.brain.reset();
    this.prev.copy(this.pos);
    this.speed = 0; this.vy = 0;
    this.trailPts.length = 0;
  }

  // is the camera inside this figure's body? (the feet position + an upright column: the eye of a runner standing on the same spot is 1.6 m
  // above the feet, so a distance to the feet says nothing)
  cameraInside(camera) {
    const c = camera.position, p = this.pos;
    return Math.hypot(c.x - p.x, c.z - p.z) < BODY_R && c.y > p.y - BODY_BELOW && c.y < p.y + BODY_H;
  }

  // the robot's walk cycle, lean and arm / head pose
  poseRobot(dt, grounded, charging, dodging) {
    const P = this.parts;
    if (grounded) this.phase += dt * (3 + this.speed * 1.25);
    const amp = grounded ? Math.min(1, this.speed / 8) * 0.8 : 0;
    const sw = Math.sin(this.phase) * amp;
    const air = grounded ? 0 : 1;
    P['leg-1'].rotation.x = sw + air * 0.6; P['leg1'].rotation.x = -sw - air * 0.3;
    P['arm-1'].rotation.x = -sw * 0.8 + air * 0.3;
    P['arm1'].rotation.x = charging ? -1.15 : sw * 0.8;
    P.body.rotation.x = -Math.min(0.3, this.speed * 0.022) - (dodging ? 0.25 : 0);
    P.head.rotation.x = Math.max(-0.7, Math.min(0.7, (this.pitch || 0) * 0.7)) + (this.speed > 1 ? Math.min(0.3, this.speed * 0.022) : 0);
    P.body.position.y = 0.86 + Math.abs(Math.sin(this.phase)) * 0.035 * amp;
  }

  update(dt, camera) {
    if (!this.built) return;
    const d = this.pos.distanceTo(this.prev);
    if (d > 8) { this.trailPts.length = 0; this.prev.copy(this.pos); }
    const step = Math.max(dt, 1e-3);
    const hv = Math.hypot(this.pos.x - this.prev.x, this.pos.z - this.prev.z) / step;
    this.vy = (this.pos.y - this.prev.y) / step;
    this.speed += (Math.min(hv, 30) - this.speed) * Math.min(1, dt * 10);
    this.prev.copy(this.pos);
    this.root.position.copy(this.pos);
    this.root.rotation.y = this.yaw || 0;
    const charging = (this.flags & FLAG.CHARGE) !== 0;
    if (this.rig) {
      const p = this.tmp;
      p[0] = this.pos.x; p[1] = this.pos.y; p[2] = this.pos.z;
      this.rig.play(this.brain.update(dt, { pos: p, yaw: this.yaw || 0, flags: this.flags, infer: !!this.opts.infer }));
      this.rig.update(dt);
    } else this.poseRobot(dt, (this.flags & FLAG.GROUND) !== 0, charging, (this.flags & FLAG.DODGING) !== 0);
    const aura = this.aura.material;
    aura.opacity += ((charging ? 0.18 : 0) - aura.opacity) * Math.min(1, dt * 14);
    this.aura.visible = aura.opacity > 0.01;
    // ghosts fade out when the camera is inside them (a solid Gorge has no fade: it is hidden while the camera is in its body, as at the start
    // of a race, where every runner stands on the same spot)
    let alpha = 1;
    if (this.ghostMat || (this.rig && this.rig.translucent)) {
      alpha = Math.max(0, Math.min(1, (camera.position.distanceTo(this.pos) - 1.3) / 2.2));
      if (this.ghostMat) this.ghostMat.opacity = 0.45 * alpha; else this.rig.setOpacity(alpha);
      this.root.visible = alpha > 0.01;
    } else this.root.visible = !this.rig || !this.cameraInside(camera);
    if (this.opts.hidden) this.root.visible = false;
    // name tag: constant apparent size
    if (this.tag) {
      const dist = camera.position.distanceTo(this.pos);
      const s = Math.max(0.2, Math.min(2.4, dist * 0.03));
      this.tag.scale.set(s * this.tag.userData.aspect, s, 1);
      this.tag.position.y = 2.15 + s * 0.35;
      const bar = this.tag.userData.bar;
      bar.scale.set(s * this.tag.userData.aspect * 0.9, s * 0.1, 1);
      bar.position.set(0, this.tag.position.y - s * 0.52, 0);
      this.tag.material.opacity = alpha * (this.opts.ghost ? 0.85 : 1);
      bar.material.opacity = this.tag.material.opacity;
    }
    this.updateTrail(dt, camera, alpha);
  }

  updateTrail(dt, camera, alpha) {
    const m = this.trailMesh;
    if (!this.opts.trail || !this.have) { m.visible = false; return; }
    const pts = this.trailPts, p = this.pos;
    const last = pts[0];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y, p.z - last.z) > 0.25) { pts.unshift({ x: p.x, y: p.y + 0.9, z: p.z }); if (pts.length > TRAIL_N) pts.pop(); }
    else { last.x = p.x; last.y = p.y + 0.9; last.z = p.z; }
    if (pts.length < 2) { m.visible = false; return; }
    m.visible = true;
    const pos = m.geometry.attributes.position, col = m.geometry.attributes.color;
    const c = this.trailCol, cam = camera.position;
    for (let i = 0; i < TRAIL_N; i++) {
      const a = pts[Math.min(i, pts.length - 1)], b = pts[Math.min(i + 1, pts.length - 1)], pa = pts[Math.max(0, Math.min(i, pts.length - 1) - 0)];
      let tx = b.x - a.x, ty = b.y - a.y, tz = b.z - a.z;
      if (i >= pts.length - 1) { const q = pts[pts.length - 2]; tx = a.x - q.x; ty = a.y - q.y; tz = a.z - q.z; }
      const vx = cam.x - pa.x, vy = cam.y - pa.y, vz = cam.z - pa.z;
      let sx = ty * vz - tz * vy, sy = tz * vx - tx * vz, sz = tx * vy - ty * vx;
      const l = Math.hypot(sx, sy, sz) || 1, w = (0.1 * (1 - i / TRAIL_N)) / l;
      sx *= w; sy *= w; sz *= w;
      pos.setXYZ(i * 2, pa.x - sx, pa.y - sy, pa.z - sz); pos.setXYZ(i * 2 + 1, pa.x + sx, pa.y + sy, pa.z + sz);
      const f = (i < pts.length ? 1 - i / Math.max(2, pts.length - 1) : 0) * 0.6 * alpha;
      col.setXYZW(i * 2, c[0], c[1], c[2], f); col.setXYZW(i * 2 + 1, c[0], c[1], c[2], f);
    }
    pos.needsUpdate = true; col.needsUpdate = true;
  }

  // what this figure plays now (Figures.info)
  info() {
    const o = this.opts, b = this.brain.last;
    const base = { id: this.id, ghost: !!o.ghost, solid: !!o.solid, infer: !!o.infer, flags: this.flags, pos: [this.pos.x, this.pos.y, this.pos.z].map((v) => Math.round(v * 1000) / 1000) };
    if (!this.rig) return { ...base, model: 'robot' };
    return { ...base, ...this.rig.info(), weapon: !!this.gun, brain: { clip: b.clip, loop: b.loop, fade: b.fade, timeScale: Math.round(b.timeScale * 1000) / 1000, seq: b.seq, speed: Math.round(b.speed * 100) / 100, dir: b.dir, air: b.air } };
  }

  dispose(all = true) {
    if (this.rig) { this.rig.dispose(); this.rig = null; this.gun = null; }   // (its own materials and bone textures, the gun's too; the models' geometry and textures are shared)
    if (this.mats) for (const m of this.mats) m.dispose();   // (the shared body material is not in the list)
    this.mats = null;
    // (geometry marked shared, like the Gorge's, outlives every figure)
    if (this.R) { this.R.traverse((o) => { if (o.geometry && o.geometry !== SPH && !o.geometry.userData.shared) o.geometry.dispose(); }); this.root.remove(this.R); this.R = null; }
    this.aura = null; this.parts = null; this.ghostMat = null;
    if (all) {
      if (this.tag) { this.tag.material.map.dispose(); this.tag.material.dispose(); const b = this.tag.userData.bar; if (b) b.material.dispose(); }
      if (this.trailMesh) { this.scene.remove(this.trailMesh); this.trailMesh.geometry.dispose(); this.trailMesh.material.dispose(); }
      this.scene.remove(this.root);
    }
    this.built = null;
  }
}

export class Figures {
  constructor(scene) {
    this.scene = scene; this.map = new Map();
    this.gl = null; this.warmRigs = [];
    this.ready = loadGorge().then((tpl) => { if (tpl) { for (const f of this.map.values()) f.build(); } return tpl; });
  }

  // the UT2004 shield gun (ut-gun.js) was switched on or off, or finished loading: the Gorges are rebuilt with it in their hand / without it
  refreshGuns() { if (gorgeTemplate()) { for (const f of this.map.values()) f.build(); this.warm(); } }

  // Compile the Gorge's shader programs (skinned solid, ghost and depth-only) before the first figure shows, so it does not hitch a frame:
  // the materials of two hidden rigs are prepared against this scene's lights / environment with renderer.compileAsync, and the rigs are kept
  // (never in the scene) so the programs stay alive until the next warm-up (a new map: new lighting) replaces them.
  // Call it with the renderer and camera after a map is loaded; it does nothing without the model, and is repeated when the model arrives.
  async warm(renderer = this.gl && this.gl.renderer, camera = this.gl && this.gl.camera) {
    if (!renderer || !camera) return;
    this.gl = { renderer, camera };
    const tpl = gorgeTemplate();
    if (!tpl) return;
    const rigs = [new GorgeRig(tpl, { ghost: true, solid: true, color: 0xffffff }), new GorgeRig(tpl, { ghost: true, color: 0xffffff })];
    const gm = utMod();
    if (gm) {   // (the gun's programs too: lit, and translucent with its depth-only copy)
      gm.attachShieldGun(rigs[0], { ghost: true, solid: true, color: 0xffffff });
      gm.attachShieldGun(rigs[1], { ghost: true, color: 0xffffff });
    }
    const holder = new THREE.Scene();
    for (const r of rigs) holder.add(r.root);
    try { await renderer.compileAsync(holder, camera, this.scene); } catch { /* compiled on first use */ }
    for (const r of rigs) r.root.removeFromParent();
    if (!this.gl) { for (const r of rigs) r.dispose(); return; }   // (disposed while compiling)
    const old = this.warmRigs;
    this.warmRigs = rigs;
    for (const r of old) r.dispose();
  }
  upsert(id, o) {
    let f = this.map.get(id);
    if (!f) { f = new Figure(id, this.scene); this.map.set(id, f); }
    f.set(o);
    return f;
  }
  has(id) { return this.map.has(id); }
  snap(id) { const f = this.map.get(id); if (f) f.snap(); }
  remove(id) { const f = this.map.get(id); if (f) { f.dispose(); this.map.delete(id); } }
  clear() { for (const f of this.map.values()) f.dispose(); this.map.clear(); }
  update(dt, camera) { for (const f of this.map.values()) f.update(dt, camera); }
  dispose() { this.clear(); for (const r of this.warmRigs) r.dispose(); this.warmRigs = []; this.gl = null; }
  info() { return [...this.map.values()].map((f) => f.info()); }
}
