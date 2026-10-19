// The proof bot. A route is a list of steps (the R.* constructors below); a closed-loop controller turns them into
// one cmd per tick, reading the world state, so routes survive small geometry changes. The proof route of a map
// must reach the finish through every checkpoint; its tick count is the author time.
//
// Units: seconds, metres, DEGREES (yaw 0 faces -Z, +90 faces -X; use R.heading(dx, dz) to get the yaw that looks along
// a direction). `to` = [x, z] (or [x, y, z]) is the air-steering target. UT air control is strong (14 m/s², never more than
// max(speed, RUN)), so the bot steers like a human tapping W: it predicts where the flight would land (down to the floor under
// `to`, or to y when given), looks along (`to` minus that point) and holds forward until the prediction is within 0.25 m. It
// never brakes (a landing beyond the target is left alone, so is a flight that already moves away from it, e.g. after a wall
// dodge); a far target, a gap, simply gets W all the way. Hold the steering back with `steer` (below). Every step has a timeout
// (s) that fails the route.
//
// Ground / zero-time steps
//   R.run(x, z, { tol = 0.5, stop = false, timeout = 12 })    run (hold forward, look at the point); stop: brake until still
//   R.face(yawDeg, pitchDeg = 0)                                 set the view
//   R.aim([x, y, z])                                             view at a point
//   R.charge(on = true, { to })                                  hold / release the shield button; to: wait until charge >= to
//   R.wait(s)    R.until((world, ps) => bool, { timeout })       idle
//   R.waitMover(id, { near: [ox, oy, oz], tol = 0.25, within })  idle (e.g. on a lift) until the mover's OFFSET is near that; within (s):
//                                                                only if it arrived there at most that long ago (a fresh dwell)
// Launch steps (leave the ground, steer in the air, complete when landed). Common options:
//   to, dj: 'apex' | seconds | false, air: [actions], delay (ticks, default 0), timeout, edge: true (launch when the
//   ground runs out), approach: yawDeg (run up along that world heading instead of toward `to`, e.g. down a lane),
//   steer: seconds | 'act' (the air steering = W + looking at `to` starts that long after takeoff / after the first air
//   action; until then no keys at all. Default: steering from the first airborne tick)
//   R.jump({ ... })                                              a jump
//   R.dodge(dir, { ... })    R.dodgeJump(dir, { ... })           dir 'F' | 'B' | 'L' | 'R' relative to the heading toward `to`;
//                                                                dodgeJump = dodge + double jump at the apex
//   R.diagJump(side, { to, gap = 0, ... })                       the diagonal jump: a side dodge ('L' | 'R'; 'F' = forward dodge) and
//        Space together; the double jump comes by itself at the apex (sim side). The bot holds W and, on the dodge tick, tries
//        every dodge direction on that side in 1 degree steps and takes the one whose resulting velocity (the real ps.vel + the
//        dodge) points best at `to`; the aim jitter applies to it. gap: ticks between the two presses, > 0 = jump first,
//        < 0 = dodge first (sloppy runs add +-press ticks); beyond +-8 ticks there is no diagonal jump any more.
//        Sloppy runs also steer 0..0.2 s late (they keep the run-up view and hold W, like a human who has not reacted yet).
//   R.air(actions, { ... })                                      a jump with air actions
//   R.shieldJump({ yaw, pitch = -89, aimAt, push, charge = 1, gap = 0, run, ... })
//        stands (or runs toward `run`), aims, charges to `charge` (0 = tap), then jump + release. `charge` is how full the gun is (hold / CHARGE_T, a
//        full gun takes 1.25 s of holding: charge it standing first, R.charge(true, { to: 1 }), when the run-up is short; 0.16 and less all push like a tap).
//        aim: yaw/pitch degrees, or
//        aimAt [x, y, z], or push [x, z] (aim behind the player so the blast pushes toward that point; pitch default -45).
//        gap: ticks between the two presses: 0 = same tick, > 0 jump first then release, < 0 release first then jump.
//        edge: true also works here (run with the gun charged, fire when the ground runs out); approach: yawDeg = run heading
//   R.glide({ to, timeout = 15 })                                steer in the air toward `to` until landed (after a jump pad)
// Air actions (list entries of `air`, executed one after the other; `at` = seconds after takeoff | 'apex' | 'wall' | 'hit' | { y })
//   R.doubleJump(at = 'apex')
//   R.wallDodge(dir, { at = 'wall' })   dir 'F' | 'B' | 'L' | 'R' (relative to the heading toward `to`) | [x, z] (dodge toward that
//                                       point) | number (world yaw in degrees)   [alias: after = seconds]
//   R.wallBoost({ yaw, pitch, aimAt, at = 'hit', charge = 1 })   release the (already held / now charging) shield at the wall
// Any air action also takes `from` (seconds into the flight): a reactive trigger ('apex' | 'wall' | 'hit' | { y }) is not taken earlier.
// Launch steps also take, with `edge` (used by the gate checker): `wallStop: true` (launch when a wall stops the run-up too), `killStop: true`
// (launch when a kill volume is about to touch the hull: the last moment to take off before a laser curtain; a number: launch when it is
// that many metres ahead, an early launch that can clear a low curtain), `lead` (ticks before the
// lip to launch, default 2.5) and `lip: 'center'` (the lip is where the centre column leaves the ground, not the whole hull: the shield
// ray at pitch -89 still sees the floor), `plan: true` (the launch tick comes from playing the run-up ahead on a copy of the player: a lane that
// ends in a wall or a ramp is launched from at the right tick). R.shieldJump also takes `snap: true` (the view stays along the run heading until
// the release tick, then flicks to the aim) and `runUp: 'fixed'` (the charge starts charge x CHARGE_T + 3 ticks before the planned release tick,
// and the release does not wait for the full charge, so a short lane cannot make the run walk off the lip without ever releasing).
// An air action takes `rel` (seconds after the previous action) as its trigger. Any launch step takes `direct: true`: the air steering is plain
// "W, looking at `to`" (no landing prediction, so it also brakes / overshoots like a hasty human).
import { DT, TICK, G, FRICTION, EYE, SH_RANGE, DODGE, DODGE_XY, CHARGE_T, HULL_HX, HULL_HY, HULL_H } from './const.js';
import { DEG, angDiff, yawTo, fwdOf, rightOf, aimOf, mulberry32 } from './math.js';
import { makeCmd, findWall, dodgeVec, PlayerState, stepPlayer } from './pmove.js';
import { cycleInfo } from './world.js';

const S = (type, o) => ({ type, ...o });
export const R = {
  run: (x, z, o = {}) => S('run', { x, z, ...o }),
  face: (yaw, pitch = 0) => S('face', { yaw, pitch }),
  aim: (at) => S('aim', { at }),
  charge: (on = true, o = {}) => S('charge', { on, ...o }),
  wait: (s) => S('wait', { s }),
  until: (pred, o = {}) => S('until', { pred, ...o }),
  waitMover: (id, o = {}) => S('waitMover', { id, ...o }),
  jump: (o = {}) => S('jump', o),
  dodge: (dir, o = {}) => S('dodge', { dir, ...o }),
  dodgeJump: (dir, o = {}) => S('dodge', { dir, dj: 'apex', ...o }),
  diagJump: (side, o = {}) => S('diag', { side, ...o }),
  air: (actions, o = {}) => S('air', { actions, ...o }),
  shieldJump: (o = {}) => S('shieldJump', o),
  glide: (o = {}) => S('glide', o),
  doubleJump: (at = 'apex', o = {}) => ({ act: 'dj', at, ...o }),
  wallDodge: (dir, o = {}) => ({ act: 'wallDodge', dir, ...o }),
  wallBoost: (o = {}) => ({ act: 'blast', ...o }),
  // yaw in degrees that looks along the horizontal direction (dx, dz)
  heading: (dx, dz) => yawTo(dx, dz) / DEG,
};

const DKEY = { F: DODGE.F, B: DODGE.B, L: DODGE.L, R: DODGE.R };
const TIMEOUT = { run: 12, jump: 8, dodge: 8, diag: 8, air: 8, shieldJump: 10, waitMover: 40, until: 20, glide: 15, charge: 5 };
// distance a runner coasts to a stop (friction FRICTION above STOP, then linear)
const stopDist = (v) => (v > 2.5 ? (v - 2.5) / FRICTION + 0.156 : (v * v) / 40);

// 8-way keys that move toward the world direction (dx, dz) given the view yaw (radians)
function keysFor(cmd, dx, dz, yaw) {
  const a = angDiff(yawTo(dx, dz), yaw);   // > 0: target to the left
  const k = Math.round(a / (Math.PI / 4));
  const T = { 0: [1, 0], 1: [1, -1], 2: [0, -1], 3: [-1, -1], 4: [-1, 0], '-1': [1, 1], '-2': [0, 1], '-3': [-1, 1], '-4': [-1, 0] };
  const [f, s] = T[k];
  cmd.fwd = f; cmd.side = s;
}

export class Bot {
  // opts.jitter { press: ticks, aim: degrees } and opts.seed make a "sloppy human" run (deterministic per seed)
  constructor(world, steps, opts = {}) {
    this.w = world; this.steps = steps; this.i = 0; this.st = null;
    this.rng = mulberry32(opts.seed ?? 1);
    this.jit = { press: 0, aim: 0, ...opts.jitter };
    this.yaw = world.ps.yaw; this.pitch = 0; this.fire = false;
    this.done = false; this.error = null;
    this.deaths0 = world.deaths;
  }
  // int in [-n, n] / [0, n]
  jsym(n) { return n > 0 ? Math.round((this.rng() * 2 - 1) * n) : 0; }
  jdelay(n) { return n > 0 ? Math.floor(this.rng() * (n + 1)) : 0; }
  fail(msg) { this.error = `step ${this.i} (${describe(this.steps[this.i])}): ${msg}`; this.done = true; }

  // the cmd for the next tick
  next() {
    const w = this.w, cmd = makeCmd();
    if (w.deaths > this.deaths0) { this.fail('died (kill volume or crushed)'); }
    cmd.over = null;
    for (let guard = 0; guard < 64 && !this.done; guard++) {
      if (this.i >= this.steps.length) { this.done = true; break; }
      const s = this.steps[this.i];
      if (!this.st) { this.st = { t: 0, limit: Math.ceil((s.timeout ?? TIMEOUT[s.type] ?? ((s.s || 0) + 2)) * TICK) }; this.begin(s, this.st); }
      if (this.st.t > this.st.limit) { this.fail(`timeout after ${(this.st.t / TICK).toFixed(1)} s at (${w.ps.pos.map((v) => v.toFixed(2))})`); break; }
      if (this.run(s, this.st, cmd)) { this.i++; this.st = null; continue; }
      this.st.t++;
      break;
    }
    const o = cmd.over;
    cmd.yaw = o && o.yaw !== undefined ? o.yaw : this.yaw;
    cmd.pitch = o && o.pitch !== undefined ? o.pitch : this.pitch;
    if (o && o.fire !== undefined) cmd.fire = o.fire; else cmd.fire = this.fire;
    delete cmd.over;
    return cmd;
  }

  begin(s, st) {
    const aj = this.jit.aim;
    st.jy = (aj ? (this.rng() * 2 - 1) * aj : 0) * DEG;   // aim noise (radians), constant per step
    st.jp = (aj ? (this.rng() * 2 - 1) * aj : 0) * DEG;
    st.delay = (s.delay || 0) + this.jdelay(this.jit.press);
    if (s.type === 'jump' || s.type === 'air' || s.type === 'dodge' || s.type === 'diag' || s.type === 'shieldJump') this.beginAir(s, st);
    if (s.type === 'diag') {
      st.gapJ = this.jsym(this.jit.press);                                           // the human's timing error between the two presses
      st.lag = this.jit.press > 0 ? Math.floor(this.rng() * (0.2 * TICK + 1)) : 0;   // ticks until a sloppy human turns toward the goal
    }
  }
  beginAir(s, st) {
    st.launched = false; st.air = false; st.airT = 0; st.since = 0; st.act = 0;
    st.acts = [];
    for (const a of s.actions || []) st.acts.push({ ...a });
    for (const a of s.air || []) st.acts.push({ ...a });
    if (s.dj !== undefined && s.dj !== false) st.acts.push({ act: 'dj', at: s.dj });   // the shorthand comes last
    for (const a of st.acts) {   // per-action jitter, drawn once
      const reactive = typeof a.at === 'string' || (a.at && typeof a.at === 'object');
      a.j = reactive || (a.at === undefined) ? this.jdelay(this.jit.press) : this.jsym(this.jit.press);
    }
  }

  run(s, st, cmd) {
    const w = this.w, ps = w.ps;
    switch (s.type) {
      case 'run': return this.sRun(s, st, cmd);
      case 'face': this.yaw = s.yaw * DEG + st.jy; this.pitch = s.pitch * DEG + st.jp; return true;
      case 'aim': { const a = this.aimYP(s.at); this.yaw = a[0]; this.pitch = a[1]; return true; }
      case 'charge':
        if (!s.on) { this.fire = false; return true; }
        this.fire = true;
        return s.to === undefined || ps.charge >= s.to - 1e-9;
      case 'wait': return st.t >= Math.round(s.s * TICK);
      case 'until': return !!s.pred(w, ps);
      case 'waitMover': {
        const m = w.movers.find((x) => x.id === s.id);
        if (!m) { this.fail(`no mover ${s.id}`); return true; }
        const d = Math.hypot(m.offset[0] - s.near[0], m.offset[1] - s.near[1], m.offset[2] - s.near[2]);
        if (d > (s.tol ?? 0.25)) return false;
        if (s.within === undefined) return true;
        const c = cycleInfo(m.cycle, w.mt);   // within: it must have arrived only this many seconds ago
        return !c.moving && c.into <= s.within * TICK;
      }
      case 'jump': case 'air': return this.sLaunch(s, st, cmd, 'jump');
      case 'dodge': return this.sLaunch(s, st, cmd, 'dodge');
      case 'diag': return this.sDiag(s, st, cmd);
      case 'shieldJump': return this.sShield(s, st, cmd);
      case 'glide': {   // wait in the air (after a pad, a mover...) steering toward `to` until landed
        if (!ps.grounded) st.air = true;
        else if (st.air) return true;
        this.steerAir(s, st, cmd);
        return false;
      }
      default: this.fail('unknown step type'); return true;
    }
  }

  aimYP(p) {
    const ps = this.w.ps, e = [ps.pos[0], ps.pos[1] + EYE, ps.pos[2]];
    const dx = p[0] - e[0], dy = p[1] - e[1], dz = p[2] - e[2];
    return [yawTo(dx, dz), Math.atan2(dy, Math.hypot(dx, dz))];
  }

  sRun(s, st, cmd) {
    const ps = this.w.ps, dx = s.x - ps.pos[0], dz = s.z - ps.pos[2], dist = Math.hypot(dx, dz);
    const tol = s.tol ?? (s.stop ? 0.3 : 0.5);
    if (s.stop ? dist < tol && ps.speed < 0.3 : dist < tol) return true;
    this.yaw = yawTo(dx, dz);
    cmd.fwd = s.stop && dist <= stopDist(ps.speed) + 0.02 ? 0 : 1;
    return false;
  }

  // world direction of a dodge: 'F'|'B'|'L'|'R' relative to the heading toward `to`, [x, z] point, or a yaw in degrees
  dodgeDirOf(d, to) {
    const ps = this.w.ps;
    if (Array.isArray(d)) { const dx = d[0] - ps.pos[0], dz = d[1] - ps.pos[2], l = Math.hypot(dx, dz) || 1; return [dx / l, 0, dz / l]; }
    if (typeof d === 'number') return fwdOf(d * DEG);
    const base = to ? yawTo(to[0] - ps.pos[0], to[to.length - 1] - ps.pos[2]) : this.yaw;
    return dodgeVec(DKEY[d], fwdOf(base), rightOf(base));
  }

  // air steering. s.steer holds it back (no keys at all); a sloppy diagonal jump keeps its old view for st.lag ticks (W held, the
  // view not yet turned) like a human who has not reacted yet; otherwise the landing point is aimed at `to` (aimLanding)
  steerAir(s, st, cmd) {
    if (s.steer !== undefined && st.steerT0 === undefined) {
      if (s.steer === 'act' ? st.act > 0 || !st.acts.length : st.airT >= Math.round(s.steer * TICK)) st.steerT0 = st.airT;
    } else if (st.steerT0 === undefined) st.steerT0 = 0;
    if (st.steerT0 === undefined) return;   // still gliding without keys
    if (st.airT < st.steerT0 + (st.lag || 0)) { cmd.fwd = 1; return; }
    if (s.to && s.direct) { const ps = this.w.ps; this.yaw = yawTo(s.to[0] - ps.pos[0], s.to[s.to.length - 1] - ps.pos[2]); cmd.fwd = 1; return; }   // W, looking at the target
    if (s.to) this.aimLanding(s, st, cmd); else cmd.fwd = 1;
  }

  // UT air control is strong (14 m/s²), so "W toward the target all the way" overshoots a short jump. Like a human tapping W: predict
  // where the ballistic flight would land (feet down to the floor under `to`, no more input) and wish toward `to` minus that point,
  // but never brake: a landing beyond the target (along the line to it) is not corrected, only a sideways error is, and a flight that
  // already moves away from the target is left alone. Inside 0.25 m: no keys. A far target (a gap) simply gets W all the way. `to` = [x, z] or [x, y, z] (y = the landing floor).
  aimLanding(s, st, cmd) {
    const w = this.w, ps = w.ps, to = s.to, tx = to[0], tz = to[to.length - 1];
    if (to.length === 3) st.fy = to[1];
    else {   // the first floor under the target below the highest point of this flight (a double jump still to come counts)
      const top = ps.pos[1] + (ps.vel[1] > 0 ? (ps.vel[1] * ps.vel[1]) / (2 * G) : 0) + (ps.djUsed ? 0.3 : 2.0);
      const tr = w.cw.traceRay([tx, top, tz], [tx, top - 120, tz]);
      if (tr.fraction < 1 && !tr.startsolid && tr.mover < 0) st.fy = tr.endpos[1];
      else if (st.fy === undefined) st.fy = ps.pos[1];
    }
    const vy = ps.vel[1], h = ps.pos[1] - st.fy, disc = vy * vy + 2 * G * h;
    const t = disc > 0 ? (vy + Math.sqrt(disc)) / G : Math.max(vy, 0) / G;
    let ex = tx - (ps.pos[0] + ps.vel[0] * t), ez = tz - (ps.pos[2] + ps.vel[2] * t);
    const dx = tx - ps.pos[0], dz = tz - ps.pos[2], dl = Math.hypot(dx, dz);
    if (ps.speed > 2 && ps.vel[0] * dx + ps.vel[2] * dz < 0) return;   // already moving away from it (after a wall dodge...): never brake against the flight
    if (dl > 0.3) {   // drop the part of the error that points back along the line to the target (an overshoot)
      const ux = dx / dl, uz = dz / dl, along = ex * ux + ez * uz;
      if (along < 0) { ex -= along * ux; ez -= along * uz; }
    }
    if (ex * ex + ez * ez < 0.0625) return;
    this.yaw = yawTo(ex, ez);
    cmd.fwd = 1;
  }

  // the heading to run along while waiting to launch: `approach` (world yaw, degrees), else toward `to`, else as it is
  runYaw(s) {
    const ps = this.w.ps;
    if (s.approach !== undefined) return s.approach * DEG;
    if (s.to) return yawTo(s.to[0] - ps.pos[0], s.to[s.to.length - 1] - ps.pos[2]);
    return this.yaw;
  }

  // run toward the launch point (grounded, dodge ready, delay over, edge ahead if asked): true on the tick to launch
  readyToLaunch(s, st, cmd, dodge) {
    const ps = this.w.ps;
    this.yaw = this.runYaw(s);
    cmd.fwd = 1;
    if (!ps.grounded || (dodge && ps.dodgeCd !== 0)) return false;
    if (st.delay-- > 0) return false;
    return this.edgeReady(s, st, cmd);
  }

  // edge: true waits until the ground runs out; wallStop: true (the gate checker's takeoffs) also launches when a wall stops the run
  edgeReady(s, st, cmd) {
    if (!s.edge) return true;
    st.runT = (st.runT || 0) + 1;
    if (s.plan) return st.runT - 1 >= (st.relT ??= this.runUpTicks(s, cmd));   // the launch tick comes from playing the run-up ahead
    const lead = (st.edgeJ ??= (s.lead ?? 2.5) + this.jdelay(this.jit.press));
    if (this.edgeAhead(lead, s.lip === 'center' ? 0.05 : HULL_HX)) return true;
    if (s.killStop && this.killAhead(lead, undefined, s.killStop)) return true;
    return !!s.wallStop && st.runT > 24 && this.w.ps.speed < 1.5;
  }

  // jump / dodge / air: wait for ground, launch, run the air actions, complete when landed
  sLaunch(s, st, cmd, kind) {
    if (!st.launched) {
      if (!this.readyToLaunch(s, st, cmd, kind === 'dodge')) return false;
      if (kind === 'dodge') {
        const D = this.dodgeDirOf(s.dir, s.to);
        this.yawOverride(cmd, yawTo(D[0], D[2]));
        cmd.fwd = 0; cmd.dodge = DODGE.F;
      } else cmd.jump = true;
      st.launched = true; st.since = 0;
      return false;
    }
    return this.airPhase(s, st, cmd);
  }

  // the diagonal jump: side dodge + Space within a few ticks of each other (gap > 0: jump first, < 0: dodge first)
  sDiag(s, st, cmd) {
    const ps = this.w.ps;
    if (!st.launched) {
      if (!this.readyToLaunch(s, st, cmd, true)) return false;
      const g = (s.gap ?? 0) + st.gapJ;
      st.jumpAt = g > 0 ? 0 : -g; st.dodgeAt = g > 0 ? g : 0;
      st.launched = true; st.f = 0; st.since = 0;
    }
    if (st.f <= Math.max(st.jumpAt, st.dodgeAt)) {
      if (!ps.grounded) { st.air = true; st.airT++; }
      cmd.fwd = 1;
      if (st.f === st.jumpAt) cmd.jump = true;
      if (st.f === st.dodgeAt) this.diagDodge(s, st, cmd);
      st.f++; st.since = 0;
      return false;
    }
    return this.airPhase(s, st, cmd);
  }

  // look and dodge so that the velocity after the dodge points best at `to`
  diagDodge(s, st, cmd) {
    const ps = this.w.ps, to = s.to;
    const T = to ? yawTo(to[0] - ps.pos[0], to[to.length - 1] - ps.pos[2]) : this.yaw;
    if (s.side === 'F') { this.yaw = T + st.jy; cmd.dodge = DODGE.F; return; }
    const vx = ps.vel[0], vz = ps.vel[2], sgn = s.side === 'L' ? 1 : -1;
    const base = Math.hypot(vx, vz) > 0.5 ? yawTo(vx, vz) : this.yaw;
    let best = Infinity, bestY = this.yaw;
    for (let k = 1; k < 180; k++) {
      const dy = base + sgn * k * DEG, D = fwdOf(dy);
      const along = vx * D[0] + vz * D[2], a = Math.max(DODGE_XY, along);
      const err = Math.abs(angDiff(yawTo(vx + D[0] * (a - along), vz + D[2] * (a - along)), T));
      if (err < best) { best = err; bestY = dy - sgn * 90 * DEG; }   // the view whose left (right) is that direction
    }
    this.yaw = bestY + st.jy;
    cmd.dodge = s.side === 'L' ? DODGE.L : DODGE.R;
  }

  yawOverride(cmd, yaw) { cmd.over = { ...(cmd.over || {}), yaw }; }

  // true when the next tick or two would walk off the ground. half = half width of the probe box: the hull (0.4) is the last moment any
  // part of the player still has ground, the centre column (0.05) the last moment the eye is still above the floor
  edgeAhead(ticks = 2.5, half = HULL_HX, ps = this.w.ps) {
    const sp = ps.speed;
    if (sp < 0.5) return false;
    const k = ticks * DT;
    const p = [ps.pos[0] + ps.vel[0] * k, ps.pos[1], ps.pos[2] + ps.vel[2] * k];
    const tr = this.w.cw.traceBox([p[0], p[1] + 0.88, p[2]], [p[0], p[1] + 0.88 - 0.1, p[2]], [half, 0.88, half]);
    return tr.fraction === 1;
  }

  // metres along (dx, dz) from the feet to the first kill volume the hull would touch (Infinity: none)
  killDist(dx, dz, ps = this.w.ps) {
    const p = ps.pos;
    let best = Infinity;
    for (const k of this.w.map.kills) {
      if (p[1] + HULL_H < k.min[1] || p[1] > k.max[1]) continue;
      let t0 = 0, t1 = Infinity;
      for (const [d, o, lo, hi] of [[dx, p[0], k.min[0] - HULL_HX, k.max[0] + HULL_HX], [dz, p[2], k.min[2] - HULL_HX, k.max[2] + HULL_HX]]) {
        if (Math.abs(d) < 1e-9) { if (o < lo || o > hi) t1 = -1; continue; }
        const a = (lo - o) / d, b = (hi - o) / d;
        t0 = Math.max(t0, Math.min(a, b)); t1 = Math.min(t1, Math.max(a, b));
      }
      if (t1 >= t0 && t1 >= 0 && t0 < best) best = t0;
    }
    return best;
  }

  // a kill volume would touch the hull within the next `ticks` ticks at the current velocity (metres: within that many metres instead)
  killAhead(ticks, ps = this.w.ps, metres) {
    const sp = ps.speed;
    if (sp < 0.5) return false;
    return this.killDist(ps.vel[0] / sp, ps.vel[2] / sp, ps) <= (typeof metres === 'number' ? metres : Math.max(sp * ticks * DT, 0.2));
  }

  // the tick (counted from now) at which a run with this cmd's keys launches, found by playing the run-up ahead on a copy of the player (the real
  // physics: slopes, steps, walls bumped at the lane's end, the takeoff clamp; movers do not move in it): `lead` ticks before the hull has no ground
  // left (lip: 'center': before the centre column has none), or when a kill volume is about to touch the hull, or when a wall has stopped the run
  runUpTicks(s, cmd) {
    const lead = s.lead ?? 2.5, half = s.lip === 'center' ? 0.05 : HULL_HX;
    const ps = this.w.ps, memo = (this.w.runUpMemo ??= new Map());   // the same start, keys and launch rule always give the same answer
    const key = [ps.pos, ps.vel, this.yaw, cmd.fwd, cmd.side, lead, half, !!s.killStop, !!s.wallStop].join('|');
    let n = memo.get(key);
    if (n === undefined) memo.set(key, n = this.runUpAhead(s, cmd, lead, half));
    return n;
  }

  runUpAhead(s, cmd, lead, half) {
    const sc = new PlayerState();
    for (const k of Object.keys(this.w.ps)) { const v = this.w.ps[k]; sc[k] = Array.isArray(v) ? v.slice() : v; }
    const probe = { ...makeCmd(), fwd: cmd.fwd, side: cmd.side, yaw: this.yaw, pitch: 0 };
    for (let n = 0; n < 9 * TICK; n++) {
      if (!sc.grounded) return Math.max(0, Math.round(n - 1 - lead));   // n-th step took off (the hull lip)
      if (half < HULL_HX && this.edgeAhead(0, half, sc)) return Math.max(0, Math.round(n - lead));   // the centre column is over the edge
      if ((s.killStop && this.killAhead(lead, sc, s.killStop)) || (s.wallStop && n > 24 && sc.speed < 1.5)) return n;
      stepPlayer(sc, probe, this.w.cw, () => {});
    }
    return 9 * TICK;
  }

  airPhase(s, st, cmd, retry = true) {
    const w = this.w, ps = w.ps;
    st.since++;
    if (!st.air) {
      if (!ps.grounded) st.air = true;
      else if (st.since > 4) {   // the launch did not take
        if (!retry) { this.fail('the shield jump did not leave the ground'); return true; }
        st.launched = false; st.delay = 0; return false;
      }
    } else if (ps.grounded) return true;   // landed
    this.steerAir(s, st, cmd);
    if (st.air) { st.airT++; this.doActions(s, st, cmd); }
    return false;
  }

  // the current air action, if its trigger fires now
  doActions(s, st, cmd) {
    const n = st.act;
    this.doAction(s, st, cmd);
    if (st.act !== n) st.actT = st.airT;   // for `rel`: when the previous action happened
  }

  doAction(s, st, cmd) {
    const w = this.w, ps = w.ps;
    const a = st.acts[st.act];
    if (!a) return;
    const T = st.airT;
    const trig = (aim) => {
      let at = a.at ?? a.after;
      if (a.rel !== undefined) return T >= (st.actT ?? 0) + Math.round(a.rel * TICK) + a.j;   // `rel` (s): this long after the previous action
      if (at === undefined) at = a.act === 'dj' ? 'apex' : a.act === 'wallDodge' ? 'wall' : 'hit';
      if (a.from !== undefined && T < Math.round(a.from * TICK)) return false;   // `from` (s): not before this time into the flight
      if (typeof at === 'number') return T >= Math.max(0, Math.round(at * TICK) + a.j);
      const ready = () => (a.jc = (a.jc || 0) + 1) > a.j;   // reactive triggers wait `j` extra ticks once true
      if (at === 'apex') return ps.vel[1] <= 0 && ready();
      if (at === 'wall') return a.dirVec && findWall(ps, w.cw, a.dirVec) && ready();
      if (at === 'hit') {
        const d = aimOf(aim[0], aim[1]), e = [ps.pos[0], ps.pos[1] + HULL_HY, ps.pos[2]];   // (the shield ray starts at the body centre)
        return w.cw.traceRay(e, [e[0] + d[0] * SH_RANGE, e[1] + d[1] * SH_RANGE, e[2] + d[2] * SH_RANGE]).fraction < 1 && ready();
      }
      if (typeof at === 'object') return ps.vel[1] < 0 && ps.pos[1] <= at.y && ready();
      return false;
    };
    if (a.act === 'dj') {
      if (trig()) { cmd.jump = true; st.act++; }
    } else if (a.act === 'wallDodge') {
      a.dirVec = this.dodgeDirOf(a.dir, s.to);
      if (trig()) {
        this.yawOverride(cmd, yawTo(a.dirVec[0], a.dirVec[2]));
        cmd.fwd = 0; cmd.dodge = DODGE.F; st.act++;
      }
    } else if (a.act === 'blast') {
      this.fire = true;   // charging from now on (or already)
      const aim = a.aimAt ? this.aimYP(a.aimAt) : [(a.yaw ?? 0) * DEG + st.jy, (a.pitch ?? -45) * DEG + st.jp];
      if (ps.charge >= (a.charge ?? 1) - 1e-9 && trig(aim)) {
        cmd.over = { ...(cmd.over || {}), yaw: aim[0], pitch: aim[1], fire: false };
        cmd.fwd = 0; cmd.side = 0;
        this.fire = false; st.act++;
      }
    }
  }

  // the keys of a running shield jump: toward the point `run`, or along the world heading `approach` (degrees), relative to the aim
  runKeys(s, cmd) {
    const ps = this.w.ps;
    if (s.approach !== undefined) { const d = fwdOf(s.approach * DEG); keysFor(cmd, d[0], d[2], this.yaw); }
    else if (s.run) keysFor(cmd, s.run[0] - ps.pos[0], s.run[s.run.length - 1] - ps.pos[2], this.yaw);
  }

  sShield(s, st, cmd) {
    const w = this.w, ps = w.ps;
    if (!st.launched) {
      // phase 0: stand, aim, charge
      if (!ps.grounded) return false;
      if (st.ph === undefined) {
        st.ph = 0;
        let yaw, pitch;
        if (s.aimAt) [yaw, pitch] = this.aimYP(s.aimAt);
        else if (s.push) {
          yaw = yawTo(s.push[0] - ps.pos[0], s.push[s.push.length - 1] - ps.pos[2]) + Math.PI;
          pitch = (s.pitch ?? -45) * DEG;
        } else { yaw = s.yaw !== undefined ? s.yaw * DEG : this.yaw; pitch = (s.pitch ?? -89) * DEG; }
        st.ay = yaw + st.jy; st.ap = pitch + st.jp;
      }
      const snap = !!s.snap;   // the view stays along the run heading (W) until the release tick, then flicks to the aim
      this.yaw = snap ? this.runYaw(s) : st.ay; this.pitch = snap ? 0 : st.ap;
      this.runKeys(s, cmd);
      const fixed = s.edge && s.runUp === 'fixed';
      if (fixed) {
        // a fixed run-up: charging starts (charge x CHARGE_T) + 3 ticks (so a tap has charged at all) before the release tick, which comes at the
        // lip whatever the charge is by then
        st.relT ??= this.runUpTicks(s, cmd);
        if (!st.chg) st.chg = st.t >= st.relT - Math.round((s.charge ?? 1) * CHARGE_T * TICK) - 3 || (!!s.wallStop && st.t > 24 && ps.speed < 1.5);
        this.fire = st.chg;
      } else {
        // running to an edge with a partial charge: hold the gun only as long as that charge takes, so it is not full at the edge
        const part = s.edge && (s.charge ?? 1) < 1;
        if (part && !st.chg) st.chg = this.edgeAhead(Math.round(s.charge * CHARGE_T * TICK) + 3) || (!!s.wallStop && st.t > 24 && ps.speed < 1.5);
        this.fire = !part || st.chg;
      }
      // a tap (charge 0) still needs one tick of charging before the gun can be released
      if (!ps.charging || (!fixed && ps.charge < (s.charge ?? 1) - 1e-9)) return false;
      if (st.delay-- > 0) return false;
      if (fixed ? st.t < st.relT : !this.edgeReady(s, st, cmd)) return false;   // run with the gun charged until the ground ends
      this.yaw = st.ay; this.pitch = st.ap;
      // the fire phase: relative tick numbers of the jump press and of the release
      const gap = s.gap ?? 0;
      st.jumpAt = gap > 0 ? 0 : -gap; st.relAt = gap > 0 ? gap : 0;
      st.launched = true; st.f = 0; st.jumped = false; st.released = false;
    }
    if (!st.jumped || !st.released) {
      this.runKeys(s, cmd);
      if (!st.jumped && st.f >= st.jumpAt) { cmd.jump = true; st.jumped = true; }
      if (!st.released && st.f >= st.relAt) { this.fire = false; st.released = true; }
      st.f++; st.since = 0;
      return false;
    }
    this.pitch = 0;
    return this.airPhase(s, st, cmd, false);
  }
}

function describe(s) {
  if (!s) return 'end';
  const o = { ...s };
  delete o.type; delete o.pred; delete o.actions; delete o.air;
  return `${s.type} ${JSON.stringify(o)}`;
}

// drives a Bot against a world one tick at a time (the browser debug hook advances it with advance(n))
export class RouteRunner {
  constructor(world, steps, opts = {}) {
    this.w = world; this.bot = new Bot(world, steps, opts);
    this.maxTicks = Math.round((opts.maxSeconds ?? 600) * TICK);
    this.n = 0;
  }
  get done() { return this.bot.done || this.w.finished || this.n >= this.maxTicks; }
  tick() {
    if (this.done) return false;
    const cmd = this.bot.next();
    if (this.bot.done) return false;   // the route is over (finished, failed or out of steps): do not run an idle tick
    this.w.step(cmd);
    this.n++;
    return !this.done;
  }
  advance(n) { for (let i = 0; i < n && this.tick(); i++); return this.result(); }
  run() { while (this.tick()); return this.result(); }
  result() {
    const w = this.w, b = this.bot;
    let reason = b.error;
    if (!reason && !w.finished) reason = this.n >= this.maxTicks ? 'ran out of time' : b.i >= b.steps.length ? 'route ended before the finish' : null;
    if (!reason && w.deaths > b.deaths0) reason = 'died';
    return { ok: w.finished && !reason, finished: w.finished, ticks: w.finishTicks, time: w.finishTicks == null ? null : w.finishTicks / TICK, cps: w.cpIndex, step: b.i, deaths: w.deaths, reason, hash: w.stateHash() };
  }
}

export function runRoute(world, steps, opts) { return new RouteRunner(world, steps, opts).run(); }
