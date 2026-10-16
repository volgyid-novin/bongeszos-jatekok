// The proof bot. A route is a list of steps (the R.* constructors below); a closed-loop controller turns them into
// one cmd per tick, reading the world state, so routes survive small geometry changes. The proof route of a map
// must reach the finish through every checkpoint; its tick count is the author time.
//
// Units: seconds, metres, DEGREES (yaw 0 faces -Z, +90 faces -X; use R.heading(dx, dz) to get the yaw that looks along
// a direction). `to` = [x, z] (or [x, y, z]) is the air-steering target: during a step's airtime the bot looks at it
// and holds forward, so the sim's air steering aims the jump at it. Every step has a timeout (s) that fails the route.
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
//   ground runs out, jump/dodge only)
//   R.jump({ ... })                                              a jump
//   R.dodge(dir, { ... })    R.dodgeJump(dir, { ... })           dir 'F' | 'B' | 'L' | 'R' relative to the heading toward `to`;
//                                                                dodgeJump = dodge + double jump at the apex
//   R.air(actions, { ... })                                      a jump with air actions
//   R.shieldJump({ yaw, pitch = -89, aimAt, push, charge = 1, gap = 0, run, ... })
//        stands (or runs toward `run`), aims, charges to `charge` (0 = tap), then jump + release. aim: yaw/pitch degrees, or
//        aimAt [x, y, z], or push [x, z] (aim behind the player so the blast pushes toward that point; pitch default -45).
//        gap: ticks between the two presses: 0 = same tick, > 0 jump first then release, < 0 release first then jump
//   R.strafe({ hops = 4, to, eff = 1, tol = 1.5 })               strafe-jump chain (auto-hop + optimal air strafing); eff < 1 = sloppier
//   R.glide({ to, timeout = 15 })                                steer in the air toward `to` until landed (after a jump pad)
// Air actions (list entries of `air`, executed one after the other; `at` = seconds after takeoff | 'apex' | 'wall' | 'hit' | { y })
//   R.doubleJump(at = 'apex')
//   R.wallDodge(dir, { at = 'wall' })   dir 'F' | 'B' | 'L' | 'R' (relative to the heading toward `to`) | [x, z] (dodge toward that
//                                       point) | number (world yaw in degrees)   [alias: after = seconds]
//   R.wallBoost({ yaw, pitch, aimAt, at = 'hit', charge = 1 })   release the (already held / now charging) shield at the wall
import { DT, TICK, RUN, AIR_K, FRICTION, EYE, SH_RANGE, DODGE } from './const.js';
import { DEG, clamp, angDiff, yawTo, fwdOf, rightOf, aimOf, mulberry32 } from './math.js';
import { makeCmd, findWall, dodgeVec } from './pmove.js';
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
  air: (actions, o = {}) => S('air', { actions, ...o }),
  shieldJump: (o = {}) => S('shieldJump', o),
  strafe: (o = {}) => S('strafe', o),
  glide: (o = {}) => S('glide', o),
  doubleJump: (at = 'apex') => ({ act: 'dj', at }),
  wallDodge: (dir, o = {}) => ({ act: 'wallDodge', dir, ...o }),
  wallBoost: (o = {}) => ({ act: 'blast', ...o }),
  // yaw in degrees that looks along the horizontal direction (dx, dz)
  heading: (dx, dz) => yawTo(dx, dz) / DEG,
};

const DKEY = { F: DODGE.F, B: DODGE.B, L: DODGE.L, R: DODGE.R };
const TIMEOUT = { run: 12, jump: 8, dodge: 8, air: 8, shieldJump: 10, strafe: 15, waitMover: 40, until: 20, glide: 15, charge: 5 };
// distance a runner coasts to a stop (friction FRICTION above STOP, then linear)
const stopDist = (v) => (v > 2.5 ? (v - 2.5) / FRICTION + 0.156 : (v * v) / 40);
const AIR_A = AIR_K * RUN * DT;

// 8-way keys that move toward the world direction (dx, dz) given the view yaw (radians)
function keysFor(cmd, dx, dz, yaw) {
  const a = angDiff(yawTo(dx, dz), yaw);   // > 0: target to the left
  const k = Math.round(a / (Math.PI / 4));
  const T = { 0: [1, 0], 1: [1, -1], 2: [0, -1], 3: [-1, -1], 4: [-1, 0], '-1': [1, 1], '-2': [0, 1], '-3': [-1, 1], '-4': [-1, 0] };
  const [f, s] = T[k];
  cmd.fwd = f; cmd.side = s;
}

export class Bot {
  // opts.jitter { press: ticks, aim: degrees, eff: 0..1 } and opts.seed make a "sloppy human" run (deterministic per seed)
  constructor(world, steps, opts = {}) {
    this.w = world; this.steps = steps; this.i = 0; this.st = null;
    this.rng = mulberry32(opts.seed ?? 1);
    this.jit = { press: 0, aim: 0, eff: 1, ...opts.jitter };
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
    cmd.autoHop = true;
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
    if (s.type === 'jump' || s.type === 'air' || s.type === 'dodge' || s.type === 'shieldJump') this.beginAir(s, st);
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
      case 'shieldJump': return this.sShield(s, st, cmd);
      case 'strafe': return this.sStrafe(s, st, cmd);
      case 'glide': {   // wait in the air (after a pad, a mover...) steering toward `to` until landed
        if (!ps.grounded) st.air = true;
        else if (st.air) return true;
        this.steerAir(s, cmd);
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

  steerAir(s, cmd) {
    const ps = this.w.ps;
    if (s.to) this.yaw = yawTo(s.to[0] - ps.pos[0], s.to[s.to.length - 1] - ps.pos[2]);
    cmd.fwd = 1;
  }

  // jump / dodge / air: wait for ground, launch, run the air actions, complete when landed
  sLaunch(s, st, cmd, kind) {
    const w = this.w, ps = w.ps;
    if (!st.launched) {
      if (s.to) this.yaw = yawTo(s.to[0] - ps.pos[0], s.to[s.to.length - 1] - ps.pos[2]);
      cmd.fwd = 1;
      const ready = ps.grounded && (kind !== 'dodge' || ps.dodgeCd === 0);
      if (!ready) return false;
      if (st.delay-- > 0) return false;
      if (s.edge && !this.edgeAhead(st.edgeJ ??= 2.5 + this.jdelay(this.jit.press))) return false;
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
  yawOverride(cmd, yaw) { cmd.over = { ...(cmd.over || {}), yaw }; }

  // true when the next tick or two would walk off the ground
  edgeAhead(ticks = 2.5) {
    const ps = this.w.ps, sp = ps.speed;
    if (sp < 0.5) return false;
    const k = ticks * DT;
    const p = [ps.pos[0] + ps.vel[0] * k, ps.pos[1], ps.pos[2] + ps.vel[2] * k];
    const tr = this.w.cw.traceBox([p[0], p[1] + 0.88, p[2]], [p[0], p[1] + 0.88 - 0.1, p[2]], [0.4, 0.88, 0.4]);
    return tr.fraction === 1;
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
    this.steerAir(s, cmd);
    if (st.air) { st.airT++; this.doActions(s, st, cmd); }
    return false;
  }

  // the current air action, if its trigger fires now
  doActions(s, st, cmd) {
    const w = this.w, ps = w.ps;
    const a = st.acts[st.act];
    if (!a) return;
    const T = st.airT;
    const trig = (aim) => {
      let at = a.at ?? a.after;
      if (at === undefined) at = a.act === 'dj' ? 'apex' : a.act === 'wallDodge' ? 'wall' : 'hit';
      if (typeof at === 'number') return T >= Math.max(0, Math.round(at * TICK) + a.j);
      const ready = () => (a.jc = (a.jc || 0) + 1) > a.j;   // reactive triggers wait `j` extra ticks once true
      if (at === 'apex') return ps.vel[1] <= 0 && ready();
      if (at === 'wall') return a.dirVec && findWall(ps, w.cw, a.dirVec) && ready();
      if (at === 'hit') {
        const d = aimOf(aim[0], aim[1]), e = [ps.pos[0], ps.pos[1] + EYE, ps.pos[2]];
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
      this.yaw = st.ay; this.pitch = st.ap;
      this.fire = true;
      if (s.run) keysFor(cmd, s.run[0] - ps.pos[0], s.run[s.run.length - 1] - ps.pos[2], this.yaw);
      // a tap (charge 0) still needs one tick of charging before the gun can be released
      if (!ps.charging || ps.charge < (s.charge ?? 1) - 1e-9) return false;
      if (st.delay-- > 0) return false;
      // the fire phase: relative tick numbers of the jump press and of the release
      const gap = s.gap ?? 0;
      st.jumpAt = gap > 0 ? 0 : -gap; st.relAt = gap > 0 ? gap : 0;
      st.launched = true; st.f = 0; st.jumped = false; st.released = false;
    }
    if (!st.jumped || !st.released) {
      if (s.run) keysFor(cmd, s.run[0] - ps.pos[0], s.run[s.run.length - 1] - ps.pos[2], this.yaw);
      if (!st.jumped && st.f >= st.jumpAt) { cmd.jump = true; st.jumped = true; }
      if (!st.released && st.f >= st.relAt) { this.fire = false; st.released = true; }
      st.f++; st.since = 0;
      return false;
    }
    this.pitch = 0;
    return this.airPhase(s, st, cmd, false);
  }

  // strafe-jump chain: hold jump (auto-hop), hold forward + a strafe key, look so the wish direction sits at the optimal
  // angle to the velocity: cos(phi) = (RUN - a) / |v|
  sStrafe(s, st, cmd) {
    const ps = this.w.ps;
    if (st.hops === undefined) {
      st.hops = 0; st.wasAir = !ps.grounded; st.side = s.side ?? 1;
      st.h0 = s.to ? 0 : this.yaw;
      st.eff = Math.min(s.eff ?? 1, this.jit.eff);
    }
    if (ps.grounded && st.wasAir) { st.hops++; st.wasAir = false; } else if (!ps.grounded) st.wasAir = true;
    const to = s.to;
    if (st.hops >= (s.hops ?? 4)) return true;
    if (to && Math.hypot(to[0] - ps.pos[0], to[to.length - 1] - ps.pos[2]) < (s.tol ?? 1.5)) return true;
    const vx = ps.vel[0], vz = ps.vel[2], sp = Math.hypot(vx, vz);
    const Ht = to ? yawTo(to[0] - ps.pos[0], to[to.length - 1] - ps.pos[2]) : st.h0;
    cmd.jump = true;
    if (sp < 1) { this.yaw = Ht; cmd.fwd = 1; return false; }
    const Hv = yawTo(vx, vz);
    const err = angDiff(Ht, Hv);
    if (Math.abs(err) > 0.5 * DEG) st.side = err > 0 ? 1 : -1;   // 1 = bend left
    const phi = Math.acos(clamp((RUN - AIR_A) / sp, 0, 1)) + (1 - st.eff) * 64 * DEG;
    const W = Hv + st.side * phi;   // wish heading
    cmd.fwd = 1;
    if (st.side > 0) { cmd.side = -1; this.yaw = W - Math.PI / 4; }   // W + A: wish = yaw + 45°
    else { cmd.side = 1; this.yaw = W + Math.PI / 4; }                // W + D: wish = yaw - 45°
    return false;
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
