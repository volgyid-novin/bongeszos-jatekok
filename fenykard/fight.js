import * as THREE from 'three';

// Duel rules and geometry, shared by the referee, the bot and the renderer.
// Body frame: the fighter stands at pos, faces local -Z (towards the opponent), +Y is up, +X is the right hand side.
// A saber orientation q is in that body frame and points its blade along local -Z (FWD): q = identity means
// "blade straight at the opponent, level". That is exactly how the phone is held at calibration.

export const FWD = new THREE.Vector3(0, 0, -1);
export const UP = new THREE.Vector3(0, 1, 0);
export const BLADE = 1.05;        // blade length (m)
export const HILT = 0.27;
export const BLADE_R = 0.03;
export const ARENA_R = 4.1;       // fighters stay inside this radius
export const SPAWN = 1.15;        // spawn distance from the centre (so 2.3 m apart, out of reach)
export const HP = 100;
export const ROUNDS_TO_WIN = 2;
export const HIT_SPEED = 2.6;     // the blade tip has to move at least this fast (m/s) to cut
const CLASH_D = 0.075;            // blades closer than this clash
const PIVOT = new THREE.Vector3(0.16, 1.2, -0.3);  // hand anchor in front of the right side of the chest
const REACH = 0.24;                                // the hand moves this far towards where the blade points
export const SHOULDERS = [new THREE.Vector3(0.2, 1.42, 0), new THREE.Vector3(-0.2, 1.42, 0)];

// hit zones (body frame, vertical capsules, so only pos matters): a..b axis, r radius
export const ZONES = [
  { id: 'head', a: new THREE.Vector3(0, 1.66, 0), b: new THREE.Vector3(0, 1.66, 0), r: 0.14, dmg: 30 },
  { id: 'torso', a: new THREE.Vector3(0, 0.98, 0), b: new THREE.Vector3(0, 1.44, 0), r: 0.21, dmg: 20 },
  { id: 'legs', a: new THREE.Vector3(0, 0.12, 0), b: new THREE.Vector3(0, 0.9, 0), r: 0.17, dmg: 12 },
];

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _q = new THREE.Quaternion();

export function qFromDir(dir, out = new THREE.Quaternion()) {
  return out.setFromUnitVectors(FWD, _w.copy(dir).normalize());
}

export class Fighter {
  constructor(slot) {
    this.slot = slot;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();     // knockback
    this.yaw = 0;
    this.q = new THREE.Quaternion();    // saber orientation, body frame
    this.bq = new THREE.Quaternion();   // visual clash bounce on top of q (body frame)
    this.on = 0;                        // blade extension 0..1
    this.hp = HP;
    this.ok = true;                     // its controller is live (phone connected, or mouse)
    this.swing = 0;                     // blade tip speed, m/s (smoothed)
    this.bodyQ = new THREE.Quaternion();
    this.hand = new THREE.Vector3();
    this.dir = new THREE.Vector3();
    this.base = new THREE.Vector3();
    this.tip = new THREE.Vector3();
    this.lastTip = null;
    this.spawn();
  }
  spawn() {
    this.pos.set(0, 0, this.slot ? -SPAWN : SPAWN);
    this.vel.set(0, 0, 0);
    this.yaw = this.slot ? Math.PI : 0;
    this.bq.identity();
    this.lastTip = null;
  }
  face(other) { this.yaw = Math.atan2(-(other.pos.x - this.pos.x), -(other.pos.z - this.pos.z)); }
  // world hand, blade direction, blade base and tip. bounce: include the visual clash bounce
  rig(bounce = false) {
    this.bodyQ.setFromAxisAngle(UP, this.yaw);
    _q.copy(this.q);
    if (bounce) _q.premultiply(this.bq);
    _v.copy(FWD).applyQuaternion(_q);
    this.hand.copy(_v).multiplyScalar(REACH).add(PIVOT).applyQuaternion(this.bodyQ).add(this.pos);
    this.dir.copy(_v).applyQuaternion(this.bodyQ);
    this.base.copy(this.hand).addScaledVector(this.dir, HILT * 0.5);
    this.tip.copy(this.base).addScaledVector(this.dir, BLADE * Math.max(this.on, 0.001));
    return _q;
  }
  // after rig(): smoothed tip speed, for the fighter this machine controls
  measure(dt) {
    if (this.lastTip) {
      const sp = this.tip.distanceTo(this.lastTip) / Math.max(dt, 1e-3);
      this.swing += (sp - this.swing) * Math.min(1, dt * 20);
    }
    this.lastTip = (this.lastTip || new THREE.Vector3()).copy(this.tip);
  }
  // body frame direction -> world
  toWorld(v) { return v.applyQuaternion(this.bodyQ); }
}

// Walk: keep wantDist from the foe, strafe (-1 left .. 1 right) circles around them.
export function moveFighter(f, foe, dt, wantDist, strafe) {
  let dx = f.pos.x - foe.pos.x, dz = f.pos.z - foe.pos.z;
  const d = Math.hypot(dx, dz) || 1e-3;
  dx /= d; dz /= d;
  const radial = clamp((wantDist - d) * 3, -1, 1) * 2.0;
  const rx = Math.cos(f.yaw), rz = -Math.sin(f.yaw);   // body +X in world
  f.pos.x += (dx * radial + rx * strafe * 1.5 + f.vel.x) * dt;
  f.pos.z += (dz * radial + rz * strafe * 1.5 + f.vel.z) * dt;
  f.vel.multiplyScalar(Math.exp(-dt * 7));
  const r = Math.hypot(f.pos.x, f.pos.z);
  if (r > ARENA_R) { f.pos.x *= ARENA_R / r; f.pos.z *= ARENA_R / r; }
  // never closer than 0.9 m
  const ex = f.pos.x - foe.pos.x, ez = f.pos.z - foe.pos.z, e = Math.hypot(ex, ez) || 1e-3;
  if (e < 0.9) { f.pos.x = foe.pos.x + (ex / e) * 0.9; f.pos.z = foe.pos.z + (ez / e) * 0.9; }
  f.face(foe);
}

// closest points of segments p1q1 and p2q2 (Ericson, Real-Time Collision Detection 5.1.9); returns squared distance
const d1 = new THREE.Vector3(), d2 = new THREE.Vector3(), rr = new THREE.Vector3();
export function segSeg(p1, q1, p2, q2, c1, c2) {
  d1.subVectors(q1, p1); d2.subVectors(q2, p2); rr.subVectors(p1, p2);
  const a = d1.dot(d1), e = d2.dot(d2), f = d2.dot(rr);
  let s, t;
  if (a <= 1e-9 && e <= 1e-9) { s = 0; t = 0; }
  else if (a <= 1e-9) { s = 0; t = clamp01(f / e); }
  else {
    const c = d1.dot(rr);
    if (e <= 1e-9) { t = 0; s = clamp01(-c / a); }
    else {
      const b = d1.dot(d2), den = a * e - b * b;
      s = den !== 0 ? clamp01((b * f - c * e) / den) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp01(-c / a); }
      else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
    }
  }
  c1.copy(p1).addScaledVector(d1, s);
  c2.copy(p2).addScaledVector(d2, t);
  return c1.distanceToSquared(c2);
}

// ---------- referee: runs on one machine only (the host), decides clashes and hits ----------
// Each step sweeps both blades from where they were on the previous step (sub-sampled), so a fast swing
// can't pass through a blade or a body between two frames. Blade contact is checked first: a deflected
// blade can't cut for a moment, that is what makes blocking work.
const SUB = 4;
const pa = new THREE.Vector3(), pb = new THREE.Vector3(), qa = new THREE.Vector3(), qb = new THREE.Vector3();
const c1 = new THREE.Vector3(), c2 = new THREE.Vector3(), za = new THREE.Vector3(), zb = new THREE.Vector3();
const r3 = (v) => [Math.round(v.x * 1000) / 1000, Math.round(v.y * 1000) / 1000, Math.round(v.z * 1000) / 1000];

export class Referee {
  constructor(fs, emit) {
    this.fs = fs;
    this.emit = emit;
    this.prev = fs.map(() => ({ base: new THREE.Vector3(), tip: new THREE.Vector3() }));
    this.has = false;
    this.clashCD = 0;
    this.contact = false;   // blades were touching at the end of the last step
    this.t = fs.map(() => ({ deflect: 0, cd: 0, inv: 0 }));
  }
  reset() { this.has = false; this.clashCD = 0; this.contact = false; for (const t of this.t) { t.deflect = 0; t.cd = 0; t.inv = 0; } }
  step(dt, live) {
    const fs = this.fs;
    this.clashCD -= dt;
    for (const t of this.t) { t.deflect -= dt; t.cd -= dt; t.inv -= dt; }
    for (const f of fs) f.rig(false);
    if (live && this.has) this.sweep();
    fs.forEach((f, i) => { this.prev[i].base.copy(f.base); this.prev[i].tip.copy(f.tip); });
    this.has = true;
  }
  seg(i, u, p, q) {
    const f = this.fs[i], pv = this.prev[i];
    p.lerpVectors(pv.base, f.base, u);
    q.lerpVectors(pv.tip, f.tip, u);
  }
  sweep() {
    const [A, B] = this.fs;
    const both = A.on > 0.9 && B.on > 0.9;
    // blades resting against each other clash once; again only when one of them is moving fast (grinding, beating)
    const fresh = !this.contact || Math.max(A.swing, B.swing) > 3;
    this.contact = both && segSeg(A.base, A.tip, B.base, B.tip, c1, c2) < (CLASH_D * 1.5) ** 2;
    for (let k = 1; k <= SUB; k++) {
      const u = k / SUB;
      this.seg(0, u, pa, qa);
      this.seg(1, u, pb, qb);
      if (both && fresh && this.clashCD <= 0 && segSeg(pa, qa, pb, qb, c1, c2) < CLASH_D * CLASH_D) {
        this.clashCD = 0.16;
        this.t[0].deflect = this.t[1].deflect = 0.3;
        // n: from blade B to blade A at the contact, for the visual bounce
        const n = c1.clone().sub(c2);
        if (n.lengthSq() < 1e-8) n.copy(A.base).sub(B.base);
        n.normalize();
        this.emit({ k: 'cl', p: r3(c1.add(c2).multiplyScalar(0.5)), n: r3(n), s: Math.round(Math.max(A.swing, B.swing) * 10) / 10 });
        return;
      }
      for (let ai = 0; ai < 2; ai++) {
        const di = 1 - ai, att = this.fs[ai], def = this.fs[di], ta = this.t[ai], td = this.t[di];
        if (att.on < 0.9 || ta.deflect > 0 || ta.cd > 0 || td.inv > 0 || att.swing < HIT_SPEED || def.hp <= 0) continue;
        const s0 = ai === 0 ? pa : pb, s1 = ai === 0 ? qa : qb;
        for (const z of ZONES) {
          za.copy(z.a).add(def.pos); zb.copy(z.b).add(def.pos);
          const rad = z.r + BLADE_R;
          if (segSeg(s0, s1, za, zb, c1, c2) >= rad * rad) continue;
          const dmg = Math.round(z.dmg * clamp(att.swing / 7, 0.8, 1.5));
          def.hp = Math.max(0, def.hp - dmg);
          ta.cd = 0.45;
          td.inv = 0.55;
          const push = new THREE.Vector3(def.pos.x - att.pos.x, 0, def.pos.z - att.pos.z).normalize();
          this.emit({ k: 'hit', a: ai, v: di, z: z.id, d: dmg, hp: [A.hp, B.hp], p: r3(c1), n: r3(push) });
          break;
        }
      }
    }
  }
}

// ---------- the practice bot ----------
// Drives a fighter's saber like a player would: guard, telegraphed swings, and (not always) pointing its blade
// at an incoming blade to block. The arcs are body-frame start/end directions that cross the opponent's body.
const ARCS = [
  [[0.75, 0.62, -0.25], [-0.55, -0.35, -0.76]],
  [[-0.75, 0.62, -0.25], [0.6, -0.3, -0.74]],
  [[0.08, 0.96, 0.25], [0.05, -0.25, -0.97]],
  [[0.95, 0.22, -0.2], [-0.82, 0.12, -0.56]],
  [[-0.9, 0.25, -0.3], [0.85, 0.05, -0.52]],
].map(([a, b]) => [new THREE.Vector3(...a).normalize(), new THREE.Vector3(...b).normalize()]);
const GUARD = new THREE.Vector3(-0.12, 0.82, -0.56).normalize();
const _inv = new THREE.Quaternion(), _t = new THREE.Vector3(), _d = new THREE.Vector3();

export class Bot {
  // aggr: attack rate multiplier, block: chance to try a block
  constructor(me, foe, { aggr = 1, block = 0.65 } = {}) {
    this.f = me; this.foe = foe;
    this.aggr = aggr; this.blockP = block;
    this.target = new THREE.Quaternion();
    this.mode = 'guard'; this.mt = 0;
    this.next = 1.6; this.time = Math.random() * 10;
    this.arc = ARCS[0];
    this.threat = false; this.react = 0;
    this.strafe = 0; this.strafeT = 1;
    this.dist = 1.7; this.distT = 0;
    this.f.q.copy(qFromDir(GUARD));
  }
  set(mode, t) { this.mode = mode; this.mt = t; }
  // live: the round is on (attacks allowed). Returns nothing, moves the fighter.
  update(dt, live) {
    const f = this.f, foe = this.foe;
    this.time += dt;
    this.mt -= dt;
    let speed = 6;
    // incoming swing? roll once per swing whether to block it
    const fast = live && foe.on > 0.9 && foe.swing > 3;
    if (fast && !this.threat) { this.threat = true; this.react = 0.13 + Math.random() * 0.12; this.willBlock = Math.random() < this.blockP; }
    if (!fast) this.threat = false;
    if (this.threat && this.willBlock && this.mode !== 'strike' && (this.react -= dt) <= 0 && this.blockTarget(_d)) {
      this.set('block', 0.35);
      qFromDir(_d, this.target);
      speed = 11;
    } else if (this.mode === 'block' && this.mt > 0) {
      speed = 9;
    } else if (this.mode === 'windup') {
      qFromDir(this.arc[0], this.target);
      speed = 7.5;
      if (this.mt <= 0 || f.q.angleTo(this.target) < 0.12) { this.set('strike', 0.32); qFromDir(this.arc[1], this.target); }
    } else if (this.mode === 'strike') {
      speed = 17;
      if (this.mt <= 0 || f.q.angleTo(this.target) < 0.1) this.set('recover', 0.35);
    } else {
      if (this.mode !== 'guard' && this.mt <= 0) this.set('guard', 0);
      _t.copy(GUARD);
      _t.x += Math.sin(this.time * 1.3) * 0.12;
      _t.y += Math.sin(this.time * 0.9) * 0.08;
      qFromDir(_t, this.target);
      speed = this.mode === 'recover' ? 6 : 4;
      const d = Math.hypot(f.pos.x - foe.pos.x, f.pos.z - foe.pos.z);
      if (live && this.mode === 'guard' && (this.next -= dt) <= 0 && d < 1.95) {
        this.arc = ARCS[Math.floor(Math.random() * ARCS.length)];
        this.set('windup', 0.5);
        this.next = (1.1 + Math.random() * 1.4) / this.aggr;
      }
    }
    f.q.rotateTowards(this.target, speed * dt);
    // footwork: step in to attack, drift back out a little otherwise, change strafing now and then
    if ((this.strafeT -= dt) <= 0) { this.strafeT = 1.2 + Math.random() * 2; this.strafe = (Math.floor(Math.random() * 3) - 1) * 0.55; }
    if ((this.distT -= dt) <= 0) { this.distT = 1 + Math.random() * 2; this.dist = 1.55 + Math.random() * 0.45; }
    const want = !live ? 2.3 : this.mode === 'windup' || this.mode === 'strike' ? 1.45 : this.dist;
    moveFighter(f, foe, dt, want, live ? this.strafe : 0);
  }
  // body-frame direction from the hand towards the point of the foe's blade nearest our chest
  blockTarget(out) {
    const f = this.f, foe = this.foe;
    foe.rig(false);
    f.rig(false);
    za.set(0, 1.2, 0).add(f.pos);
    segSeg(foe.base, foe.tip, za, za, c1, c2);
    if (c1.distanceTo(za) > 1.1) return false;
    _inv.copy(f.bodyQ).invert();
    out.copy(c1).sub(f.hand).applyQuaternion(_inv);
    if (out.z > 0.15) out.z = 0.15;    // never point backwards
    if (out.lengthSq() < 1e-4) return false;
    out.normalize();
    return true;
  }
}
