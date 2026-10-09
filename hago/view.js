import * as THREE from 'three';
import { U, comicMat, makePaintTex, makeRockTex, makeGroundTex, makeTerrainGeo, ComicPost, TERRAIN, silMat } from './toon.js';
import {
  buildHero, buildMinion, buildTower, buildNexus, buildBoss, buildFountain, Kit,
  pineKit, oakKit, rockKit, pillarKit, fenceKit, bannerKit, wallKit, towerKeepKit, bushKit, brazierKit,
} from './models.js';
import { groundHeight, sdf, laneHW, BRUSHES, RELICS, PIT, brushAt } from './map.js';
import { HEROES, TEAMS, LANE, K, F, MTYPES } from './data.js';

// The 3D scene: terrain and scenery, the units and their animation, the camera, picking, portraits.
// Effects (projectiles, explosions, telegraphs) live in fx.js and draw into this.fxScene.

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerpAngle = (a, b, k) => { let d = b - a; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return a + d * k; };
const ease = (t) => (t < 0 ? 0 : t > 1 ? 1 : t * t * (3 - 2 * t));
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// which animation each skill plays
const CAST_ANIM = {
  granit: ['charge', 'slam', 'shield', 'shout', 'spin', 'slam'],
  parazs: ['throwL', 'raise', 'quick', 'raise', 'push', 'raise'],
  solyom: ['bow', 'bowUp', 'roll', 'kneel', 'point', 'bowLong'],
  arny: ['throw', 'cloak', 'quick', 'spinFast', 'cloak', 'dance'],
};
export const PITCH = 0.98;          // camera pitch (rad from horizontal)

export class View {
  constructor(canvas) {
    const r = (this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' }));
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    r.setPixelRatio(this.dpr);
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.shadowMap.autoUpdate = false;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.NoToneMapping;
    this.post = new ComicPost(r);
    this.scene = new THREE.Scene();
    this.fxScene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x9fc4e8);
    this.scene.fog = new THREE.Fog(0xb9d2e6, 60, 125);
    this.camera = new THREE.PerspectiveCamera(37, 1, 1, 260);
    this.cam = { x: -52, z: 0, dist: 29, tx: -52, tz: 0, shake: 0 };

    U.paint.value = makePaintTex();
    U.rock.value = makeRockTex();
    const hemi = new THREE.HemisphereLight(0xe2efff, 0x7a6248, 1.55);
    this.scene.add(hemi);
    const sun = (this.sun = new THREE.DirectionalLight(0xfff0d8, U.sunI.value));
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -30; sc.right = 30; sc.top = 30; sc.bottom = -30; sc.near = 1; sc.far = 110;
    sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.04;
    this.scene.add(sun, sun.target);
    this.sunDir = new THREE.Vector3(-0.42, 1, 0.55).normalize();

    this.vis = new Map();          // entity id -> visual
    this.corpses = [];
    this.relicVis = [];
    this.buildWorld();
    this.raycaster = new THREE.Raycaster();
    this.time = 0;
  }

  // ============================================================
  //  The static world
  // ============================================================
  buildWorld() {
    const tmat = comicMat({ map: makeGroundTex(), terrain: true, paint: 0.45, hatch: 0.6 });
    for (let x = TERRAIN.minX; x < TERRAIN.maxX - 0.01; x += 16) {
      for (let z = TERRAIN.minZ; z < TERRAIN.maxZ - 0.01; z += 16) {
        const x1 = Math.min(TERRAIN.maxX, x + 16), z1 = Math.min(TERRAIN.maxZ, z + 16);
        // full detail where the game is played, coarser far away
        const near = Math.abs((x + x1) / 2) < 70 && (z + z1) / 2 > -34 && (z + z1) / 2 < 20;
        const t = new THREE.Mesh(makeTerrainGeo(x, x1, z, z1, near ? 2 : 1), tmat);
        t.receiveShadow = true; t.castShadow = true;
        this.scene.add(t);
      }
    }

    // scenery goes into 16 x 16 m chunks for the same reason
    const R = rng(1234), chunks = new Map();
    let curZ = 0;
    const at = (x, z = curZ) => { const key = Math.floor((x - TERRAIN.minX) / 16) * 100 + Math.floor((z - TERRAIN.minZ) / 16); let c = chunks.get(key); if (!c) { c = new Kit(); chunks.set(key, c); } return c; };
    const H = groundHeight;
    // trees on the cliff tops (never in front of the pit, so the camera can see in)
    for (let i = 0; i < 2600; i++) {
      const x = TERRAIN.minX + R() * (TERRAIN.maxX - TERRAIN.minX), z = TERRAIN.minZ + R() * (TERRAIN.maxZ - TERRAIN.minZ);
      const d = sdf(x, z);
      if (d < 3.2) continue;
      const y = H(x, z);
      if (y < 2.6) continue;
      if (Math.abs(x) < 14 && z > -27) continue;
      const slope = Math.abs(H(x + 0.8, z) - y) + Math.abs(H(x, z + 0.8) - y);
      if (slope > 0.9 || R() < 0.55) continue;
      const s = 0.9 + R() * 0.7;
      if (R() < 0.6) pineKit(at(x, z), x, y - 0.1, z, s * 1.15, R() * 6);
      else oakKit(at(x, z), x, y - 0.1, z, s, R() * 6);
    }
    // rocks along the lane edges and in front of the pit
    for (let i = 0; i < 900; i++) {
      const x = -66 + R() * 132, z = -30 + R() * 40;
      const d = sdf(x, z);
      if (d < 0.6 || d > 3.5) continue;
      if (z > 0 && R() < 0.6) continue;
      if (R() < 0.6) continue;
      rockKit(at(x, z), x, H(x, z) - 0.15, z, 0.5 + R() * 0.8, R() * 6);
    }
    // a wooden railing along the chasm
    for (let x = -45; x < 45; x += 2.6) {
      if (Math.abs(x - 11.5) < 2 || Math.abs(x + 11.5) < 2) continue;
      const x1 = x + 2.6, z0 = laneHW(x) + 0.8, z1 = laneHW(x1) + 0.8;
      if (sdf(x, z0) < 0.2 || sdf(x1, z1) < 0.2) continue;
      fenceKit(at(x, z0), x, z0, x1, z1, H(x, z0), H(x1, z1));
    }
    // ruined pillars along the north edge
    for (let x = -44; x <= 44; x += 11) {
      if (Math.abs(x) < 9) continue;
      const z = -(laneHW(x) + 1.1);
      pillarKit(at(x, z), x + R() * 2, H(x, z), z, 1, R() < 0.6, R() * 6);
    }
    // the pit: a ring of pillars, open toward the lane
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      const x = PIT.x + Math.sin(a) * 8.6, z = PIT.z + Math.cos(a) * 8.6;
      if (Math.cos(a) > 0.82) continue;
      pillarKit(at(x, z), x, H(x, z), z, 1.1, i % 3 === 1, a);
    }
    pillarKit(at(-3.9, -7.6), -3.9, 0, -7.6, 1.15, true, 0.3);
    pillarKit(at(3.9, -7.6), 3.9, 0, -7.6, 1.15, true, 1.1);
    // fortress walls behind the bases (north side and the far end)
    for (const s of [-1, 1]) {
      const cx = s * 55;
      const pts = [];
      for (let a = -175; a <= -20; a += 22) {
        const rad = (a * Math.PI) / 180, ax = s * Math.cos(rad) * -1, az = Math.sin(rad);
        pts.push([cx + ax * 13.2, az * 13.2]);
      }
      for (let i = 0; i < pts.length - 1; i++) wallKit(at(pts[i][0], pts[i][1]), pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], H(pts[i][0], pts[i][1]) - 0.3, 3);
      for (const p of [pts[0], pts[Math.floor(pts.length / 2)], pts[pts.length - 1]]) towerKeepKit(at(p[0], p[1]), p[0], H(p[0], p[1]) - 0.3, p[1], 1, TEAMS[s < 0 ? 0 : 1].hex);
      for (const bz of [-5.5, 5.5]) bannerKit(at(cx - s * 5, bz * 0.6 - 3), cx - s * 5, 0, bz * 0.6 - 3, TEAMS[s < 0 ? 0 : 1].hex, s < 0 ? 0 : Math.PI);
    }
    // braziers by the towers and the pit gate
    this.braziers = [];
    for (const s of [-1, 1]) for (const tx of LANE.towers) { const x = s * tx + s * 1.6, z = -2.6; brazierKit(at(x, z), x, 0, z); this.braziers.push([x, 1.45, z]); }
    for (const x of [-4.6, 4.6]) { brazierKit(at(x, -6.3), x, 0, -6.3); this.braziers.push([x, 1.45, -6.3]); }
    // distant mountains to the north
    for (let i = 0; i < 26; i++) {
      const x = -95 + i * 7.6 + R() * 4, z = -56 - R() * 10;
      at(x, z).cone(9 + R() * 8, 16 + R() * 14, 6, [0x8f9fb4, 0x7d8ea6, 0xa2b0c2][i % 3], x, H(x, -50) + 2, z, 0, R() * 3, 0);
    }
    const smat = comicMat({ vc: true, paint: 0.6, hatch: 0.55 });
    for (const kit of chunks.values()) {
      const g = kit.geo();
      if (!g) continue;
      const m = new THREE.Mesh(g, smat);
      m.castShadow = true; m.receiveShadow = true;
      this.scene.add(m);
    }

    // bushes: their own mesh so they can sway
    const bk = new Kit();
    BRUSHES.forEach((b, i) => bushKit(bk, b.x, b.z, b.rx, b.rz, i * 7 + 3));
    this.bushes = new THREE.Mesh(bk.geo(), comicMat({ vc: true, paint: 0.5, hatch: 0.4, rim: 0.15 }));
    this.bushes.castShadow = true; this.bushes.receiveShadow = true;
    this.scene.add(this.bushes);

    // fountains
    for (let t = 0; t < 2; t++) {
      const f = buildFountain(t);
      f.root.position.set(t === 0 ? -LANE.fountainX : LANE.fountainX, 0, 0);
      this.scene.add(f.root);
      (this.fountains ||= []).push(f);
    }
    // health relics: a floating green cross
    for (const rl of RELICS) {
      const g = new THREE.Group();
      const kk = new Kit();
      kk.box(0.24, 0.7, 0.24, 0x6fe08a, 0, 0, 0);
      kk.box(0.7, 0.24, 0.24, 0x6fe08a, 0, 0.08, 0);
      const m = new THREE.Mesh(kk.geo(), comicMat({ vc: true, rim: 0.8, emissive: 0x1f6a30, paint: 0.1 }));
      m.castShadow = true;
      g.add(m);
      g.position.set(rl.x, 1, rl.z);
      this.scene.add(g);
      this.relicVis.push({ g, on: true });
    }
  }

  // ============================================================
  //  Units
  // ============================================================
  makeVis(e, myTeam, myId) {
    let v;
    switch (e.kind) {
      case K.HERO: case K.CLONE: {
        const id = HEROES[e.sub].id;
        const rig = buildHero(id, e.team);
        v = { rig, root: rig.root, hero: id, style: rig.style, h: rig.height };
        // see-through silhouette in the team colour (mine green)
        const col = e.id === myId ? 0x7cff5a : e.team === myTeam ? 0x4a9cff : 0xff4a3a;
        const sil = silMat(col), meshes = [];
        rig.root.traverse((o) => { if (o.isMesh) meshes.push(o); });
        for (const o of meshes) { const sm = new THREE.Mesh(o.geometry, sil); sm.layers.set(1); o.add(sm); }
        break;
      }
      case K.MINION: {
        const rig = buildMinion(MTYPES[e.sub], e.team);
        v = { rig, root: rig.root, style: rig.style, h: rig.height, minion: true };
        break;
      }
      case K.TOWER: { const t = buildTower(e.team, e.sub); v = { tower: t, root: t.root, h: t.height }; break; }
      case K.NEXUS: { const n = buildNexus(e.team); v = { nexus: n, root: n.root, h: n.height }; break; }
      case K.BOSS: { const rig = buildBoss(); v = { rig, root: rig.root, style: 'boss', h: rig.height }; break; }
      default: return null;
    }
    Object.assign(v, { id: e.id, kind: e.kind, team: e.team, phase: Math.random() * 6, lastX: e.x, lastZ: e.z, speed: 0, atk: null, cast: null, atkN: 0, deadT: 0, flash: 0, air: null, leap: null, pop: 0, shown: true, alpha: 1 });
    v.root.position.set(e.x, groundHeight(e.x, e.z), e.z);
    v.root.rotation.y = e.rot;
    v.cur = {};
    this.scene.add(v.root);
    return v;
  }
  // sync with the world; myTeam decides what is hidden (brushes, stealth)
  syncUnits(world, dt, myTeam, myId = 0) {
    this.time += dt;
    const now = this.time;
    for (const e of world.ents.values()) {
      let v = this.vis.get(e.id);
      if (!v) { v = this.makeVis(e, myTeam, myId); if (!v) continue; this.vis.set(e.id, v); }
      v.e = e;
      const seen = e.team === myTeam || e.team === 2 || (e.vis & (1 << myTeam)) !== 0;
      v.seen = seen;
      if (v.tower || v.nexus) { this.animStructure(v, e, dt, now); continue; }
      // position
      const gy = groundHeight(e.x, e.z);
      const sp = Math.hypot(e.x - v.lastX, e.z - v.lastZ) / Math.max(dt, 1e-3);
      v.speed += (Math.min(sp, 12) - v.speed) * (1 - Math.exp(-10 * dt));
      v.lastX = e.x; v.lastZ = e.z;
      v.root.position.set(e.x, gy, e.z);
      v.root.rotation.y = lerpAngle(v.root.rotation.y, e.rot, 1 - Math.exp(-18 * dt));
      // visibility: hidden enemies vanish, our own stealthed hero is a ghost
      const ghost = (e.flags & F.STEALTH) && seen;
      const target = !seen ? 0 : ghost || (e.kind === K.CLONE && e.team === myTeam) ? 0.42 : 1;
      v.alpha += (target - v.alpha) * (1 - Math.exp(-12 * dt));
      const show = v.alpha > 0.03 && (e.alive || e.kind === K.HERO);
      v.root.visible = show;
      if (v.rig && v.rig.mat) this.setAlpha(v, v.alpha);
      if (e.kind === K.HERO && !e.alive) { v.deadT += dt; } else v.deadT = 0;
      if (v.minion) this.animMinion(v, e, dt, now);
      else if (e.kind === K.BOSS) this.animBoss(v, e, dt, now);
      else this.animHero(v, e, dt, now);
      // hit flash
      if (v.flash > 0) {
        v.flash = Math.max(0, v.flash - dt * 6);
        if (v.rig && v.rig.mat) v.rig.mat.userData.u.uFlash.value = v.flash * 0.75;
      }
      if (v.pop > 0) { v.pop = Math.max(0, v.pop - dt * 5); v.root.scale.setScalar(1 + v.pop * 0.12); }
    }
    // gone from the world: minions and the boss die in place
    for (const [id, v] of this.vis) {
      if (world.ents.has(id)) continue;
      this.vis.delete(id);
      if ((v.minion || v.kind === K.BOSS) && v.root.visible) { v.dieT = 0; this.corpses.push(v); }
      else this.dispose(v);
    }
    for (const c of this.corpses) {
      c.dieT += dt;
      const P = c.rig.parts;
      const k = ease(c.dieT / 0.45);
      P.body.rotation.x = -1.45 * k;
      P.body.position.y = -Math.max(0, c.dieT - 1.0) * 0.8;
      if (c.rig.wheels) for (const w of c.rig.wheels) w.rotation.z += dt * 4;
    }
    this.corpses = this.corpses.filter((c) => { if (c.dieT > 2.2) { this.dispose(c); return false; } return true; });
    // relics bob, the bushes sway
    for (const r of this.relicVis) { r.g.rotation.y += dt * 1.5; r.g.position.y = 1 + Math.sin(now * 2.5) * 0.15; r.g.visible = r.on; }
    for (const f of this.fountains) { f.crystal.rotation.y += dt * 0.8; f.crystal.position.y = 2.3 + Math.sin(now * 1.7) * 0.15; }
  }
  setAlpha(v, a) {
    const m = v.rig.mat;
    const tr = a < 0.98;
    if (m.transparent !== tr) { m.transparent = tr; m.depthWrite = !tr; m.needsUpdate = true; }
    m.opacity = a;
  }
  dispose(v) {
    this.scene.remove(v.root);
    // hero rigs own their geometry; minions share theirs
    if (v.kind === K.HERO || v.kind === K.CLONE) v.root.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
  }

  // ---------- poses ----------
  applyPose(v, p, dt, snap = 22) {
    const P = v.rig.parts, k = 1 - Math.exp(-snap * dt), c = v.cur;
    const set = (key, obj, prop, val) => { if (!obj) return; const cv = c[key] ?? 0; const nv = cv + (val - cv) * k; c[key] = nv; obj[prop] = nv; };
    set('by', P.body.position, 'y', p.by || 0);
    set('brx', P.body.rotation, 'x', p.brx || 0);
    set('brz', P.body.rotation, 'z', p.brz || 0);
    P.body.rotation.y = p.bry || 0;
    set('trx', P.torso.rotation, 'x', p.trx || 0);
    set('try', P.torso.rotation, 'y', p.try || 0);
    set('hrx', P.head && P.head.rotation, 'x', p.hrx || 0);
    set('hrz', P.head && P.head.rotation, 'z', p.hrz || 0);
    set('alx', P.armL.rotation, 'x', p.alx || 0);
    set('alz', P.armL.rotation, 'z', p.alz || 0);
    set('aly', P.armL.rotation, 'y', p.aly || 0);
    set('arx', P.armR.rotation, 'x', p.arx || 0);
    set('arz', P.armR.rotation, 'z', p.arz || 0);
    set('ary', P.armR.rotation, 'y', p.ary || 0);
    set('llx', P.legL.rotation, 'x', p.llx || 0);
    set('lrx', P.legR.rotation, 'x', p.lrx || 0);
    if (P.cape) set('cx', P.cape.rotation, 'x', p.cx || 0);
  }
  animHero(v, e, dt, now) {
    const p = {}, st = v.style, moving = v.speed > 0.6 && e.alive;
    // dead
    if (!e.alive) {
      const k = ease(v.deadT / 0.5);
      p.brx = -1.45 * k; p.by = -Math.max(0, v.deadT - 2.5) * 0.4; p.alx = -0.6; p.arx = -0.6; p.alz = 0.5; p.arz = -0.5;
      v.root.visible = v.deadT < 4.5 && v.alpha > 0.03;
      this.applyPose(v, p, dt, 14);
      return;
    }
    // base: run or idle
    if (moving) {
      v.phase += dt * (3.2 + v.speed * 1.6);
      const s = Math.sin(v.phase), a = Math.min(1, v.speed / 3);
      p.llx = s * 0.75 * a; p.lrx = -s * 0.75 * a;
      p.alx = -s * 0.55 * a; p.arx = s * 0.55 * a;
      p.by = Math.abs(Math.cos(v.phase)) * 0.08 * a;
      p.brx = 0.12 * a; p.cx = 0.35 + Math.sin(v.phase * 2) * 0.12;
    } else {
      p.by = Math.sin(now * 2.1 + v.phase) * 0.015;
      p.cx = 0.08 + Math.sin(now * 1.3 + v.phase) * 0.04;
      p.alz = 0.08; p.arz = -0.08;
    }
    // how each hero holds the weapon
    if (st === 'hammer') { p.arx = (p.arx || 0) * 0.4 - 0.3; p.alx = -0.55; p.alz = 0.3; }
    else if (st === 'staff') { p.arx = (p.arx || 0) * 0.3 - 0.12; }
    else if (st === 'bow') { p.alx = -0.65 + (p.alx || 0) * 0.3; p.alz = 0.2; }
    else if (st === 'daggers') { if (!moving) { p.alx = -0.55; p.arx = -0.55; p.alz = 0.35; p.arz = -0.35; p.brx = 0.12; p.llx = -0.15; p.lrx = 0.2; } }

    // basic attack
    if (v.atk) {
      const t = now - v.atk.t0, w = v.atk.w, ph = t / w;
      if (t > w + 0.35) v.atk = null;
      else this.attackPose(p, st, ph, t - w, v.atkN);
    }
    // skill cast
    if (v.cast) {
      const t = now - v.cast.t0;
      if (t > v.cast.w + 0.45) v.cast = null;
      else this.castPose(p, v.cast.a, t, v.cast.w, now);
    }
    const f = e.flags;
    if (f & F.SPIN) { p.bry = now * 18; p.alz = 1.35; p.arz = -1.35; p.arx = -0.3; p.alx = -0.3; }
    if (f & F.DANCE) { const s = Math.sin(now * 32); p.alx = -1.2 - s * 0.9; p.arx = -1.2 + s * 0.9; p.brx = 0.35; p.try = s * 0.5; }
    if (f & F.RECALL) { p.alx = -2.7; p.arx = -2.7; p.alz = 0.3; p.arz = -0.3; p.hrx = -0.3; }
    if (f & F.DASH && st === 'hammer') { p.alx = -1.5; p.alz = 0.1; p.brx = 0.4; }
    if (f & (F.STUN)) { p.hrz = Math.sin(now * 6) * 0.25; p.alx = 0.1; p.arx = 0.1; p.brx = -0.1; }
    if (f & F.TAUNT) { p.brx = 0.2; }
    if (f & F.ROOT) { p.llx = 0; p.lrx = 0; }
    // air time: knock-ups and Granit's leap
    let lift = 0;
    if (v.air) { const k = (now - v.air.t0) / v.air.d; if (k >= 1) v.air = null; else { lift = Math.sin(k * Math.PI) * v.air.h; p.brx = (p.brx || 0) - 0.5; p.alz = 1; p.arz = -1; } }
    if (v.leap) {
      const k = (now - v.leap.t0) / v.leap.d;
      if (k >= 1) v.leap = null;
      else { lift = Math.sin(k * Math.PI) * 4.5; p.alx = -2.9; p.arx = -2.9; p.brx = k > 0.75 ? 0.4 : -0.2; }
    }
    p.by = (p.by || 0) + lift;
    if (v.rig.falcon) v.rig.falcon.visible = !(v.falconAway > now);
    this.applyPose(v, p, dt);
  }
  attackPose(p, st, ph, after, n) {
    const wind = ease(ph), strike = after >= 0 ? Math.max(0, 1 - after / 0.3) : 0;
    switch (st) {
      case 'hammer':
        if (after < 0) { p.arx = -0.3 - 2.4 * wind; p.try = -0.35 * wind; p.arz = -0.2; }
        else { p.arx = 0.55 * strike - 0.3 * (1 - strike); p.try = 0.3 * strike; p.brx = 0.18 * strike; }
        break;
      case 'staff':
        if (after < 0) { p.arx = -0.2 - 1.1 * wind; p.alx = -0.9 * wind; }
        else { p.arx = -1.5 * strike; p.alx = -1.2 * strike; p.brx = 0.1 * strike; }
        break;
      case 'bow':
        if (after < 0) { p.alx = -1.57; p.alz = 0; p.arx = -1.45; p.arz = 0.35 * wind; p.ary = -0.6 * wind; p.try = -0.25; }
        else { p.alx = -1.57 * strike - 0.6 * (1 - strike); p.arx = -1.2 * strike; p.arz = 0.9 * strike; p.try = -0.25 * strike; }
        break;
      case 'daggers': {
        const L = n % 2 === 0;
        const a = after < 0 ? 0.5 * wind : -1.9 * strike;
        if (L) { p.alx = a - 0.4; p.alz = 0.5 - (after >= 0 ? 0.6 * strike : 0); } else { p.arx = a - 0.4; p.arz = -0.5 + (after >= 0 ? 0.6 * strike : 0); }
        p.try = (L ? 0.45 : -0.45) * (after >= 0 ? strike : wind * -0.5);
        p.brx = 0.2;
        break;
      }
      case 'melee':
        if (after < 0) p.arx = -0.2 - 2.0 * wind; else p.arx = 0.35 * strike;
        break;
      case 'caster':
        if (after < 0) p.arx = -1.3 * wind; else p.arx = -1.6 * strike;
        break;
      case 'boss':
        if (after < 0) { p.arx = -2.6 * wind; p.try = -0.3 * wind; }
        else { p.arx = 0.3 * strike; p.brx = 0.2 * strike; p.try = 0.2 * strike; }
        break;
      default: break;
    }
  }
  castPose(p, a, t, w, now) {
    const wind = w > 0 ? ease(t / w) : 1, after = t - w, rel = after >= 0 ? Math.max(0, 1 - after / 0.4) : 0;
    switch (a) {
      case 'throw': case 'throwL': {
        const arm = a === 'throwL' ? 'l' : 'r';
        const v = after < 0 ? -2.6 * wind : -1.3 * rel - 0.2;
        if (arm === 'l') { p.alx = v; p.alz = 0.2; } else { p.arx = v; p.arz = -0.2; }
        p.try = (arm === 'l' ? 0.3 : -0.3) * (after < 0 ? wind : -rel);
        break;
      }
      case 'raise':
        if (after < 0) { p.alx = -2.9 * wind; p.arx = -2.9 * wind; p.brx = -0.12 * wind; p.hrx = -0.3 * wind; }
        else { p.alx = -1.5 * rel; p.arx = -1.5 * rel; p.brx = 0.15 * rel; }
        break;
      case 'slam':
        if (after < 0) { p.alx = -3.0 * wind; p.arx = -3.0 * wind; p.brx = -0.2 * wind; }
        else { p.alx = 0.3 * rel - 0.4; p.arx = 0.3 * rel - 0.4; p.brx = 0.4 * rel; p.by = -0.15 * rel; }
        break;
      case 'shield': p.alx = -1.55; p.alz = 0.05; p.brx = 0.15; break;
      case 'charge': p.alx = -1.5; p.alz = 0.1; p.brx = 0.4; p.arx = 0.4; break;
      case 'shout': p.alz = 1.3 * (1 - Math.max(0, after) / 0.5); p.arz = -1.3 * (1 - Math.max(0, after) / 0.5); p.brx = -0.18; p.hrx = -0.35; break;
      case 'spin': break;
      case 'spinFast': p.bry = ease(t / 0.35) * Math.PI * 4; p.alz = 1.3; p.arz = -1.3; break;
      case 'push': p.alx = -1.5; p.arx = -1.5; p.brx = 0.12; break;
      case 'quick': p.arx = -1.4 * Math.max(0, 1 - t / 0.3); break;
      case 'bow': case 'bowLong': case 'bowUp': {
        const up = a === 'bowUp' ? -0.7 : 0;
        p.alx = -1.57 + up; p.alz = 0; p.arx = -1.45 + up; p.try = -0.25;
        if (after < 0) { p.arz = 0.45 * wind; p.ary = -0.7 * wind; } else { p.arz = 0.9 * rel; }
        if (a === 'bowLong' && after < 0) { p.brx = -0.1; p.llx = -0.3; p.lrx = 0.35; }
        break;
      }
      case 'roll': p.brx = ease(t / 0.28) * Math.PI * 2; p.by = Math.sin(Math.min(1, t / 0.28) * Math.PI) * 0.4; p.alx = -1; p.arx = -1; break;
      case 'kneel': p.by = -0.25 * (1 - Math.max(0, after) / 0.4); p.llx = -1.2; p.lrx = 0.4; p.arx = -0.9; break;
      case 'point': p.arx = -1.7; p.ary = 0.1; p.try = -0.2; break;
      case 'cloak': p.by = -0.15 * Math.max(0, 1 - t / 0.5); p.alx = -1; p.arx = -1; p.alz = -0.4; p.arz = 0.4; break;
      case 'dance': break;
      case 'bossSlam':
        if (after < 0) { p.alx = -3.0 * wind; p.arx = -3.0 * wind; p.brx = -0.25 * wind; }
        else { p.alx = 0.4; p.arx = 0.4; p.brx = 0.45 * rel; }
        break;
      default: break;
    }
  }
  animMinion(v, e, dt, now) {
    const p = {}, moving = v.speed > 0.5;
    if (moving) {
      v.phase += dt * (4 + v.speed * 2);
      const s = Math.sin(v.phase);
      p.llx = s * 0.8; p.lrx = -s * 0.8; p.alx = -s * 0.5; p.arx = s * 0.4; p.by = Math.abs(Math.cos(v.phase)) * 0.06;
    } else p.by = Math.sin(now * 2.4 + v.phase) * 0.012;
    if (v.atk) {
      const t = now - v.atk.t0, w = v.atk.w;
      if (t > w + 0.35) v.atk = null; else this.attackPose(p, v.style, t / w, t - w, 0);
    }
    if (v.rig.siege) {
      for (const wh of v.rig.wheels) wh.rotation.x += v.speed * dt / 0.3;
      p.llx = p.lrx = p.alx = p.arx = 0;
      if (v.atk) { const t = now - v.atk.t0 - v.atk.w; if (t > 0) p.brx = -0.18 * Math.max(0, 1 - t / 0.3); }
    }
    if (e.flags & F.AIR && !v.air) v.air = { t0: now, d: 0.5, h: 1.0 };
    if (v.air) { const k = (now - v.air.t0) / v.air.d; if (k >= 1) v.air = null; else { p.by = (p.by || 0) + Math.sin(k * Math.PI) * v.air.h; p.brx = -0.6; } }
    this.applyPose(v, p, dt, 18);
  }
  animBoss(v, e, dt, now) {
    const p = {}, moving = v.speed > 0.4;
    if (moving) {
      v.phase += dt * (2.2 + v.speed);
      const s = Math.sin(v.phase);
      p.llx = s * 0.5; p.lrx = -s * 0.5; p.alx = -s * 0.35; p.arx = s * 0.35; p.by = Math.abs(Math.cos(v.phase)) * 0.12;
    } else { p.by = Math.sin(now * 1.4) * 0.04; p.alz = 0.2; p.arz = -0.2; p.hrx = Math.sin(now * 0.7) * 0.08; }
    if (v.atk) { const t = now - v.atk.t0, w = v.atk.w; if (t > w + 0.4) v.atk = null; else this.attackPose(p, 'boss', t / w, t - w, 0); }
    if (v.cast) { const t = now - v.cast.t0; if (t > v.cast.w + 0.5) v.cast = null; else this.castPose(p, 'bossSlam', t, v.cast.w, now); }
    this.applyPose(v, p, dt, 14);
  }
  animStructure(v, e, dt, now) {
    const s = v.tower || v.nexus;
    if (e.alive) {
      s.crystal.rotation.y += dt * (v.nexus ? 0.6 : 1.2);
      s.crystal.position.y = (v.nexus ? 3.9 : 6.2) + Math.sin(now * 1.6 + e.id) * 0.18;
      if (v.nexus) s.ring.rotation.z += dt * 0.5;
      if (v.flash > 0) { v.flash = Math.max(0, v.flash - dt * 6); }
      v.root.visible = true;
    } else if (!v.ruined) {
      v.ruined = true;
      s.crystal.visible = false;
      if (v.nexus) s.ring.visible = false;
      // knock it down to a stump
      v.root.children[0].scale.set(1, 0.32, 1);
      v.root.children[0].rotation.z = 0.06;
    }
  }

  // ---------- reactions to events (called by fx.js) ----------
  onAttack(id, w) { const v = this.vis.get(id); if (v && !v.tower) { v.atk = { t0: this.time, w: Math.max(0.08, w) }; v.atkN++; } }
  onCast(id, slot, w) {
    const v = this.vis.get(id);
    if (!v || v.tower || v.nexus) return;
    if (v.kind === K.BOSS) { v.cast = { t0: this.time, w, a: 'bossSlam' }; return; }
    if (!v.hero) return;
    const a = CAST_ANIM[v.hero][slot];
    v.cast = { t0: this.time, w: Math.max(w, a === 'roll' ? 0.28 : 0.12), a };
    if (v.hero === 'solyom' && slot === 4) v.falconAway = this.time + 1.6;
  }
  onAir(id, d) { const v = this.vis.get(id); if (v) v.air = { t0: this.time, d, h: d > 0.8 ? 1.8 : 1.2 }; }
  onLeap(id, d) { const v = this.vis.get(id); if (v) v.leap = { t0: this.time, d }; }
  onHit(id) { const v = this.vis.get(id); if (v) { v.flash = 1; if (v.minion) v.pop = 1; } }
  setRelic(i, on) { if (this.relicVis[i]) this.relicVis[i].on = on; }

  // where to draw a unit's bar (world point above its head)
  headPos(v) {
    const e = v.e;
    let y = groundHeight(e.x, e.z) + (v.h || 2) + 0.35;
    if (v.rig && v.rig.parts) y += v.rig.parts.body.position.y;
    return y;
  }

  // ============================================================
  //  Camera, picking, render
  // ============================================================
  resize(w, h) {
    this.w = w; this.h = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.post.setSize(w, h, this.dpr);
  }
  updateCamera(dt) {
    const c = this.cam;
    c.x += (c.tx - c.x) * (1 - Math.exp(-9 * dt));
    c.z += (c.tz - c.z) * (1 - Math.exp(-9 * dt));
    let sx = 0, sz = 0;
    if (c.shake > 0) { c.shake = Math.max(0, c.shake - dt * 2.5); sx = (Math.random() - 0.5) * c.shake; sz = (Math.random() - 0.5) * c.shake; }
    const cp = Math.cos(PITCH), spch = Math.sin(PITCH);
    this.camera.position.set(c.x + sx, c.dist * spch, c.z + c.dist * cp + sz);
    this.camera.lookAt(c.x + sx, 0, c.z + sz);
    // the sun's shadow box follows the camera
    const tx = c.x, tz = c.z - 3;
    this.sun.position.set(tx + this.sunDir.x * 50, this.sunDir.y * 50, tz + this.sunDir.z * 50);
    this.sun.target.position.set(tx, 0, tz);
  }
  shake(a) { this.cam.shake = Math.min(1.2, this.cam.shake + a); }
  // screen (css px) -> ground point
  groundAt(mx, my) {
    const ndc = new THREE.Vector2((mx / this.w) * 2 - 1, -(my / this.h) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const r = this.raycaster.ray;
    if (Math.abs(r.direction.y) < 1e-4) return null;
    const t = -r.origin.y / r.direction.y;
    return { x: r.origin.x + r.direction.x * t, z: r.origin.z + r.direction.z * t };
  }
  project(x, y, z, out) {
    const v = (this._pv ||= new THREE.Vector3()).set(x, y, z).project(this.camera);
    out.x = (v.x * 0.5 + 0.5) * this.w; out.y = (-v.y * 0.5 + 0.5) * this.h; out.z = v.z;
    return out;
  }
  // the unit under the mouse: closest on screen to its body's middle line
  pick(mx, my, filter) {
    let best = null, bd = Infinity;
    const a = { x: 0, y: 0 }, b = { x: 0, y: 0 };
    for (const v of this.vis.values()) {
      if (!v.e || !v.root.visible || !v.seen || (!v.e.alive)) continue;
      if (filter && !filter(v.e)) continue;
      const e = v.e, gy = groundHeight(e.x, e.z);
      this.project(e.x, gy, e.z, a);
      this.project(e.x, gy + (v.h || 2) * 0.8, e.z, b);
      // distance from the mouse to the segment feet..head
      const sx = b.x - a.x, sy = b.y - a.y, l2 = sx * sx + sy * sy || 1;
      const t = clamp(((mx - a.x) * sx + (my - a.y) * sy) / l2, 0, 1);
      const d = Math.hypot(mx - (a.x + sx * t), my - (a.y + sy * t));
      const rad = (v.tower || v.nexus ? 46 : v.kind === K.BOSS ? 40 : v.minion ? 18 : 24) * (this.h / 900) * (27 / this.cam.dist);
      if (d < rad && d < bd) { bd = d; best = e; }
    }
    return best;
  }
  render() {
    U.time.value = this.time;
    this.post.render(this.scene, this.fxScene, this.camera);
  }

  // ============================================================
  //  Portraits for the menus and the HUD (rendered once, in a small offscreen renderer)
  // ============================================================
  static portraits() {
    const out = {};
    const S = 220, cv = document.createElement('canvas');
    cv.width = cv.height = S;
    let r;
    try { r = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: true, preserveDrawingBuffer: true }); } catch { return out; }
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.setPixelRatio(1);
    r.setSize(S, S, false);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xe2efff, 0x7a6248, 1.8));
    const sun = new THREE.DirectionalLight(0xfff0d8, 2.6);
    sun.position.set(-1.2, 2, 2.4);
    scene.add(sun);
    const cam = new THREE.PerspectiveCamera(26, 1, 0.1, 50);
    const old = U.sunI.value;
    for (let t = 0; t < 2; t++) {
      HEROES.forEach((hd) => {
        const rig = buildHero(hd.id, t);
        const P = rig.parts;
        if (hd.id === 'granit') { P.armR.rotation.x = -0.4; P.armL.rotation.x = -0.6; P.armL.rotation.z = 0.3; }
        if (hd.id === 'solyom') { P.armL.rotation.x = -0.7; }
        if (hd.id === 'arny') { P.armL.rotation.x = -0.9; P.armR.rotation.x = -0.9; P.armL.rotation.z = 0.4; P.armR.rotation.z = -0.4; }
        rig.root.rotation.y = 0.45;
        scene.add(rig.root);
        rig.root.updateMatrixWorld(true);
        const headY = rig.parts.head.getWorldPosition(new THREE.Vector3()).y;
        cam.position.set(0.55, headY + 0.25, 2.6);
        cam.lookAt(0, headY - 0.05, 0);
        r.setClearColor(0x000000, 0);
        r.render(scene, cam);
        out[hd.id + t] = cv.toDataURL('image/png');
        scene.remove(rig.root);
      });
    }
    U.sunI.value = old;
    r.dispose();
    r.forceContextLoss?.();
    return out;
  }
}
