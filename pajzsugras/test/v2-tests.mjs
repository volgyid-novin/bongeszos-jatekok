// Physics v2 edge cases (columbo): the diagonal jump off movers and pads, the takeoff clamp on a mover, the jump-first conversion after a
// blast, a buffered double jump that a wall boost postpones and a wall dodge drops, djBuf cleared by respawn / restart, air control and VMAX bounds,
// World reuse (the gate checker restarts one World for ~1100 runs) is a full reset, the real input path (input.js -> cmd -> World) of the
// diagonal jump in all three orders, the fixed double jump (Space 0 - 400 ms after a wall dodge is always an immediate double jump with vy = DJ_V,
// a wall dodge gives it back, a press while rising faster than DJ_V is ignored), the wall dodge's reach and fixed height, the 60 Hz frame path of
// Space (a release and a new press inside one frame are two presses), and a check of the texts. What test/trace.js and test/probes.js already check
// (same-tick / jump-first / dodge-first / window / cooldown / air-control random input / held Space) is not repeated here.
// Each case returns { name, ok, detail } (the shape of test/trace.js); runV2Tests() runs them all.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { World } from '../sim/world.js';
import { Bot, R } from '../sim/bot.js';
import { makeCmd } from '../sim/pmove.js';
import { Input } from '../input.js';
import { MAPS } from '../maps/index.js';
import { course } from './synth.mjs';
import { mulberry32 } from '../sim/math.js';
import { TICK, G, DJ_V, DODGE, DODGE_XY, DODGE_Y, RUN, VMAX, HULL_HX } from '../sim/const.js';
import { testArena } from './probes.js';

const mk = (fn, start = [0, 0, 0], yaw = 0) => {
  const w = new World(testArena((b) => { fn && fn(b); }).build());
  w.teleport(start, yaw);
  return w;
};
const cmdOf = (o) => Object.assign(makeCmd(), o);
const f = (v, d = 2) => v.toFixed(d);
const evs = (w) => w.takeEvents();
const run = (w, c, n) => { for (let i = 0; i < n; i++) w.step(c); };
const upto = (w, c, pred, max = 1500) => { for (let i = 0; i < max; i++) { w.step(c); if (pred()) return i + 1; } return -1; };
const types = (events) => events.map((e) => e.type + (e.late ? '(late)' : '') + (e.auto ? '(auto)' : '')).filter((t) => t !== 'clockStart').join(' ');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ====================================================================== physics

// a big platform (top y = 2) that glides along +x at v m/s; the player stands in its middle
const glider = (v) => (b) => b.mover('m', { path: [[600, 0, 0]], speed: v, wait: 0 }, () => { b.box([-30, 1.5, -30], [30, 2, 30], { mat: 'floor' }); });
// the three orders of the diagonal jump (right dodge + Space), driven by hand
function diagOrder(w, order) {
  const c = makeCmd();
  const press = (o) => { Object.assign(c, o); w.step(c); c.dodge = 0; c.jump = false; };
  if (order === 'same') press({ dodge: DODGE.R, jump: true });
  else if (order === 'jump first') { press({ jump: true }); run(w, c, 2); press({ dodge: DODGE.R }); }
  else { press({ dodge: DODGE.R }); run(w, c, 2); press({ jump: true }); }
}

test('diagonal jump off a moving platform: the dodge is 13.2 m/s RELATIVE to the platform in all three orders (jump first must not lose the platform velocity)', () => {
  const rel = {};
  for (const order of ['same', 'jump first', 'dodge first']) {
    const w = mk(glider(5), [0, 2, 0]);
    w.startClock(); run(w, makeCmd(), 30);
    if (w.ps.groundMover !== 0) return { ok: false, detail: 'setup: the player is not standing on the mover' };
    diagOrder(w, order);
    rel[order] = w.ps.vel[0] - w.movers[0].vel[0];
  }
  const ok = Object.values(rel).every((v) => Math.abs(v - 13.2) < 0.3);
  return { ok, detail: `platform-relative speed after the dodge: same tick ${f(rel.same)}, jump first ${f(rel['jump first'])}, dodge first ${f(rel['dodge first'])} (expected 13.2 each; the platform glides at 5 m/s)` };
});

test('diagonal jump off a rising lift: jump first keeps the lift\'s vertical speed (same peak above the lift as the same-tick dodge)', () => {
  const peak = (order) => {
    const w = mk((b) => b.mover('lift', { path: [[0, 40, 0]], speed: 4, wait: 0 }, () => { b.box([-3, 3, -3], [3, 3.5, 3], { mat: 'floor' }); }), [0, 3.5, 0]);
    w.startClock(); run(w, makeCmd(), 30);
    const m = w.movers[0], rel0 = w.ps.pos[1] - m.offset[1];
    diagOrder(w, order);
    let hi = -Infinity;
    for (let i = 0; i < 400 && !(i > 10 && w.ps.grounded); i++) { w.step(makeCmd()); hi = Math.max(hi, w.ps.pos[1] - m.offset[1] - rel0); }
    return hi;
  };
  const a = peak('same'), b = peak('jump first'), d = peak('dodge first');
  return { ok: Math.abs(a - b) < 0.2 && Math.abs(a - d) < 0.2, detail: `peak above the lift: same tick ${f(a)}, jump first ${f(b)}, dodge first ${f(d)} (the same arc whichever key came first; the conversion works on absolute velocities and drops the lift's 4 m/s)` };
});

test('jump-first conversion right after a jump pad must not replace the pad\'s flight (jump, pad fires, dodge 3 ticks later)', () => {
  const flight = (dodgeAt) => {
    const w = mk((b) => b.pad([0, 0, -1.2], { target: [0, 0, -60], apex: 10 }));
    const c = cmdOf({ fwd: 1, jump: true });
    w.step(c); c.jump = false;
    let hi = 0, pad = false;
    for (let i = 1; i < 400 && !(i > 20 && w.ps.grounded); i++) {
      c.dodge = i === dodgeAt ? DODGE.R : 0;
      w.step(c);
      hi = Math.max(hi, w.ps.pos[1]);
      if (evs(w).some((e) => e.type === 'pad')) pad = true;
    }
    return { hi, z: w.ps.pos[2], pad };
  };
  const base = flight(-1), conv = flight(4);
  return { ok: base.pad && base.hi > 9.5 && conv.hi > 9.5, detail: `pad flight peak ${f(base.hi)} m, landing z ${f(base.z)}; with a dodge 3 ticks after the pad: peak ${f(conv.hi)} m, landing z ${f(conv.z)} (the conversion must not fire on a pad flight: padLaunch leaves lastJumpT / dodgeT alive)` };
});

test('takeoff clamp on a mover works on the RELATIVE speed: a 12 m/s platform is not clamped to RUN; a dodge landing at 13 m/s relative is clamped to RUN relative (platform speed added on top)', () => {
  const w = mk(glider(12), [0, 2, 0]);
  w.startClock(); run(w, makeCmd(), 30);
  w.step(cmdOf({ jump: true }));
  const standing = w.ps.vel[0];   // 12 m/s of the platform, nothing relative
  // a 6 m/s platform: dodge along it, land on it, press Space on the first grounded tick
  const v = mk(glider(6), [0, 2, 0]);
  v.startClock(); run(v, makeCmd(), 30);
  v.step(cmdOf({ dodge: DODGE.R }));
  const landedAfter = upto(v, makeCmd(), () => v.ps.grounded);
  const relLand = v.ps.vel[0];
  v.step(cmdOf({ jump: true }));
  const relOut = v.ps.vel[0] - v.movers[0].vel[0], absOut = v.ps.vel[0];
  return { ok: Math.abs(standing - 12) < 0.1 && relLand > RUN + 2 && relOut <= RUN + 0.05 && relOut > RUN - 0.6 && absOut > 6 + RUN - 0.6, detail: `standing jump on the 12 m/s platform: ${f(standing)} m/s (not clamped); dodge landing after ${landedAfter} ticks at ${f(relLand)} m/s relative, the jump left at ${f(relOut)} relative / ${f(absOut)} absolute (RUN ${RUN})` };
});

test('a dodge on the landing tick of a diagonal jump: refused (cooldown), Space there is a normal jump that leaves at <= RUN and buffers nothing', () => {
  const setup = () => {
    const w = mk();
    const c = cmdOf({ fwd: 1 });
    run(w, c, 120);
    c.dodge = DODGE.L; c.jump = true; w.step(c); c.dodge = 0; c.jump = false;   // the diagonal jump
    return { w, c };
  };
  const probe = setup();
  const L = upto(probe.w, probe.c, () => probe.w.ps.grounded);   // the landing is detected in the L-th tick after the jump's tick
  // offset 0: the press goes into the landing tick itself (still airborne at its start); offset 1: the first tick on the ground
  const press = (offset, dodge, jump) => {
    const { w, c } = setup();
    run(w, c, L - 1 + offset);
    evs(w);
    c.dodge = dodge ? DODGE.R : 0; c.jump = jump; w.step(c); c.dodge = 0; c.jump = false;
    return { w, ev: evs(w) };
  };
  const inAir = press(0, true, true), first = press(1, true, true), onlyDodge = press(1, true, false);
  const dodgeEv = (r) => r.ev.some((e) => e.type === 'dodge' || e.type === 'walldodge');
  const ok = L > 0 && !dodgeEv(inAir) && !dodgeEv(first) && !dodgeEv(onlyDodge) && onlyDodge.w.ps.grounded
    && first.ev.some((e) => e.type === 'jump') && first.w.ps.speed <= RUN + 0.01 && !first.w.ps.djBuf && !inAir.ev.some((e) => e.type === 'dj');
  return { ok, detail: `landing tick ${L}; dodge + Space in the landing tick: ${types(inAir.ev) || 'nothing'}; on the first grounded tick: ${types(first.ev)}, speed ${f(first.w.ps.speed)}, djBuf ${first.w.ps.djBuf}; dodge only: ${types(onlyDodge.ev) || 'nothing'}, still grounded ${onlyDodge.w.ps.grounded}` };
});

test('jump-first conversion is refused after a blast since the jump (a hit shield blast 2 ticks after the jump, a same-tick shield jump): no dodge, nothing buffered', () => {
  const after = (gapRelease) => {   // gapRelease: ticks between the jump press and the release (0 = the same tick, a real shield jump)
    const w = mk();
    const c = cmdOf({ pitch: -1.5, fire: true });
    run(w, c, 30);   // charging on the ground
    c.jump = true; if (gapRelease === 0) c.fire = false;
    w.step(c); c.jump = false;
    for (let i = 1; i < gapRelease; i++) w.step(c);
    if (gapRelease > 0) { c.fire = false; w.step(c); }
    const blast = evs(w).find((e) => e.type === 'blast');
    run(w, c, 2);
    evs(w);
    c.dodge = DODGE.R; w.step(c); c.dodge = 0;
    const ev = evs(w);
    return { ok: !!blast && blast.hit && !ev.some((e) => e.type === 'dodge') && !w.ps.djBuf && w.ps.speed < 1, ev: types(ev), hit: blast && blast.hit, speed: w.ps.speed };
  };
  const a = after(2), b = after(0);
  return { ok: a.ok && b.ok, detail: `jump, release 2 ticks later, dodge: [${a.ok ? 'refused' : 'FAILED: ' + a.ev + ' speed ' + f(a.speed)}] (blast hit ${a.hit}); jump + release same tick, dodge: [${b.ok ? 'refused' : 'FAILED: ' + b.ev + ' speed ' + f(b.speed)}] (blast hit ${b.hit})` };
});

test('a buffered double jump survives a wall boost before the apex (postponed to the new apex, fired exactly once); a wall dodge drops the buffer and gives the double jump back (no automatic one, the next Space is an immediate double jump)', () => {
  const wall = (b) => b.box([-40, 0, -12], [40, 40, -10], { mat: 'wall' });
  const go = (script) => {
    const w = mk(wall, [0, 0, -9.5], 0);
    const c = cmdOf({ pitch: -0.7 });   // looking down at the wall: a wall boost pushes up and away
    if (script.charge) c.fire = true;
    if (script.charge) run(w, c, 100);
    const log = [];
    for (let k = 0; k < 500; k++) {
      c.dodge = 0; c.jump = false;
      if (k === 0) { c.dodge = DODGE.L; c.jump = true; }
      if (script.wallDodgeAt === k) c.dodge = DODGE.B;
      if (script.spaceAt === k) c.jump = true;
      if (script.releaseAt === k) c.fire = false;
      w.step(c);
      for (const e of w.takeEvents()) log.push({ k, type: e.type, auto: !!e.auto, hit: e.hit });
      if (k > 10 && w.ps.grounded) break;
    }
    const dj = log.filter((e) => e.type === 'dj');
    return { dj, log, w };
  };
  const base = go({}), wd = go({ wallDodgeAt: 6 }), wdSpace = go({ wallDodgeAt: 6, spaceAt: 30 }), wb = go({ charge: true, releaseAt: 6 });
  const one = (r) => r.dj.length === 1 && r.dj[0].auto;
  const later = (r) => r.dj.length === 1 && r.dj[0].k > base.dj[0].k + 3;
  const wdOk = wd.log.some((e) => e.type === 'walldodge') && !wd.dj.length && !wd.w.ps.djBuf
    && wdSpace.dj.length === 1 && !wdSpace.dj[0].auto && wdSpace.dj[0].k === 30;   // the buffer is gone; Space 24 ticks after the wall dodge jumps at once
  const wbOk = one(wb) && later(wb) && wb.log.some((e) => e.type === 'blast' && e.hit);
  return { ok: one(base) && wdOk && wbOk && !base.w.ps.djBuf, detail: `undisturbed: auto dj at tick ${base.dj.map((e) => e.k)}; with a wall dodge at tick 6: dj ticks [${wd.dj.map((e) => e.k + (e.auto ? ' auto' : ''))}], with Space at 30: [${wdSpace.dj.map((e) => e.k + (e.auto ? ' auto' : ''))}]; with a hit wall boost at tick 6: [${wb.dj.map((e) => e.k + (e.auto ? ' auto' : ''))}]` };
});

// jump at a wall, wall dodge away from it, Space `delays` ticks after the wall-dodge tick (a number or a list; null: no Space). diag: the jump
// is a diagonal jump (dodge L + Space on the ground: a double jump waits in the buffer) and the wall dodge comes 6 ticks later, as in the case
// above. preDj: Space `preDj` ticks after the jump (before the wall dodge): the double jump is spent when the wall dodge comes
const WALL = (b) => b.box([-40, 0, -12], [40, 40, -10], { mat: 'wall' });
function wallHop({ delay = null, diag = false, wallDodge = true, preDj = null } = {}) {
  const w = mk(WALL, [0, 0, -9.5], 0);
  const c = makeCmd();
  const K1 = diag ? 6 : 10, log = [], presses = delay === null ? [] : [].concat(delay);
  let land = null, buffered = false;
  for (let k = 0; k < 700; k++) {
    c.dodge = 0; c.jump = false;
    if (k === 0) { c.jump = true; if (diag) c.dodge = DODGE.L; }
    if (preDj !== null && k === preDj) c.jump = true;
    if (wallDodge && k === K1) c.dodge = DODGE.B;
    if (presses.some((d) => k === K1 + d)) c.jump = true;
    w.step(c);
    for (const e of w.takeEvents()) if (e.type !== 'clockStart') log.push({ k, type: e.type, auto: !!e.auto, vy: w.ps.vel[1] });
    if (!diag && k >= K1 && w.ps.djBuf && !w.ps.grounded) buffered = true;   // (a plain jump + wall dodge never has a double jump waiting)
    if (k > K1 && w.ps.grounded) { land = w.ps.pos.slice(); break; }
  }
  return { log, dj: log.filter((e) => e.type === 'dj'), wd: log.filter((e) => e.type === 'walldodge'), buffered, dist: land ? Math.hypot(land[0], land[2] + 9.5) : null, K1, w };
}
const VY_AFTER_DJ = DJ_V - G / TICK;   // vy at the end of the press tick: DJ_V minus one tick of gravity

test('wall dodge: Space on the wall-dodge tick or 1 - 48 ticks (0 - 400 ms) after it, rising or falling, is ALWAYS exactly one immediate double jump on the press tick with vy = DJ_V (no buffer, no automatic one), and the later the press, the longer the flight', () => {
  const bad = [];
  let prev = -1, n = 0;
  for (let d = 0; d <= 48; d++) {
    const r = wallHop({ delay: d });
    n++;
    if (r.wd.length !== 1 || r.wd[0].k !== r.K1) bad.push(`+${d}: wall dodges ${JSON.stringify(r.wd)}`);
    if (r.dj.length !== 1) bad.push(`+${d}: ${r.dj.length} double jumps`);
    else if (r.dj[0].auto || r.dj[0].k !== r.K1 + d || Math.abs(r.dj[0].vy - VY_AFTER_DJ) > 1e-6) bad.push(`+${d}: the double jump is ${r.dj[0].auto ? 'automatic' : 'immediate'} at tick ${r.dj[0].k} (wanted ${r.K1 + d}), vy ${f(r.dj[0].vy, 3)} (wanted ${f(VY_AFTER_DJ, 3)})`);
    if (r.buffered) bad.push(`+${d}: djBuf was set`);
    if (r.dist === null) bad.push(`+${d}: never landed`);
    else { if (r.dist < prev - 1e-9) bad.push(`+${d}: lands at ${f(r.dist)} m, less than the earlier press (${f(prev)} m)`); prev = r.dist; }
  }
  return { ok: !bad.length, detail: bad.length ? bad.slice(0, 5).join('; ') : `${n} press delays from 0 to 48 ticks: one immediate double jump each, vy ${f(VY_AFTER_DJ, 3)} after the press tick` };
});

test('wall dodge restores the double jump: jump -> double jump -> wall dodge -> Space is a second double jump (at once, later, falling), and still only one more; a dodge without a wall restores nothing', () => {
  const bad = [];
  for (const d of [0, 1, 10, 30, 48]) {
    const r = wallHop({ preDj: 4, delay: d });
    if (r.dj.length !== 2 || r.dj[0].k !== 4 || r.dj[1].k !== r.K1 + d || r.dj.some((e) => e.auto)) bad.push(`+${d}: ${JSON.stringify(r.dj)}`);
    if (r.dj.length === 2 && Math.abs(r.dj[1].vy - VY_AFTER_DJ) > 1e-6) bad.push(`+${d}: second dj vy ${f(r.dj[1].vy, 3)}`);
    const three = wallHop({ preDj: 4, delay: [d, d + 2] });   // a third press in the same airtime: nothing
    if (three.dj.length !== 2) bad.push(`+${d}, +${d + 2}: ${three.dj.length} double jumps`);
  }
  // no wall behind the dodge: the dodge in the air does nothing and the spent double jump stays spent
  const w = mk();
  const c = makeCmd();
  w.step(cmdOf({ jump: true })); run(w, c, 10);
  w.step(cmdOf({ jump: true })); evs(w);
  run(w, c, 3); w.step(cmdOf({ dodge: DODGE.B }));
  const refused = !evs(w).some((e) => e.type === 'walldodge' || e.type === 'dodge') && w.ps.djUsed;
  w.step(cmdOf({ jump: false })); w.step(cmdOf({ jump: true }));
  if (!refused || evs(w).some((e) => e.type === 'dj')) bad.push('without a wall: refused ' + refused);
  return { ok: !bad.length, detail: bad.length ? bad.join('; ') : 'a second double jump after every wall dodge, never a third; nothing without a wall' };
});

test('double jump while rising faster than DJ_V (right after a shield launch or a pad): the press is ignored and does not spend it; once vy is below DJ_V a press sets vy = DJ_V', () => {
  const w = mk();
  w.teleport([0, 40, 0], 0);
  w.ps.vel[1] = 12;
  evs(w);
  w.step(cmdOf({ jump: true }));
  const ignored = !evs(w).some((e) => e.type === 'dj') && !w.ps.djUsed && w.ps.vel[1] > 11;
  w.step(makeCmd());
  upto(w, makeCmd(), () => w.ps.vel[1] < 6, 300);
  w.step(cmdOf({ jump: true }));
  const dj = evs(w).find((e) => e.type === 'dj');
  return { ok: ignored && dj && !dj.auto && Math.abs(w.ps.vel[1] - VY_AFTER_DJ) < 1e-6, detail: `press at vy 12: ignored ${ignored}; press at vy < 6: dj ${dj ? 'yes' : 'no'}, vy ${f(w.ps.vel[1], 3)}` };
});

test('wall dodge on top of a diagonal jump: allowed (a wall dodge after a ground dodge), drops the buffered double jump and gives it back; the next Space - at once, later or falling - is one immediate double jump', () => {
  const base = wallHop({ diag: true, wallDodge: false }), tried = wallHop({ diag: true });
  const sp = [0, 1, 5, 12, 30].map((d) => ({ d, r: wallHop({ diag: true, delay: d }) }));
  const bad = [];
  if (!(base.dj.length === 1 && base.dj[0].auto)) bad.push('undisturbed diagonal jump: ' + JSON.stringify(base.dj));
  if (tried.wd.length !== 1 || tried.dj.length !== 0) bad.push('wall dodge on the diagonal jump, no Space (no automatic dj, the buffer is gone): ' + JSON.stringify(tried.log));
  for (const { d, r } of sp) {
    if (r.wd.length !== 1 || r.dj.length !== 1 || r.dj[0].auto || r.dj[0].k !== r.K1 + d) bad.push(`wall dodge + Space at +${d}: ${JSON.stringify(r.log)}`);
    if (r.w.ps.djBuf) bad.push(`+${d}: djBuf left over`);
  }
  // diagonal jump -> a second Space (the double jump now) -> wall dodge -> Space: the restored one
  const twice = wallHop({ diag: true, preDj: 3, delay: 2 });
  if (twice.dj.length !== 2 || twice.dj[1].auto) bad.push('diagonal jump, immediate dj, wall dodge, Space: ' + JSON.stringify(twice.dj));
  return { ok: !bad.length, detail: bad.length ? bad.join('; ') : `undisturbed auto dj at ${base.dj[0].k}; a wall dodge at 6 drops it (no dj without Space); Space at +0 / +1 / +5 / +12 / +30: one immediate dj each` };
});

// the player floats at y = 5 (feet) facing -z with vy `vy`; the wall brush is made by wallFn(gap) with its face `gap` m from the hull; dodge `dir`
function wallProbe(wallFn, gap, dir, vy = 5) {
  const w = mk((b) => wallFn(b, HULL_HX + gap), [0, 5, 0], 0);
  w.ps.vel[1] = vy;
  evs(w);
  w.step(cmdOf({ dodge: dir }));
  const wd = evs(w).find((e) => e.type === 'walldodge');
  return { wd: !!wd, vy: w.ps.vel[1], speed: w.ps.speed };
}
const WALL_SHAPES = {
  'behind a forward dodge': [(b, d) => b.box([-5, 0, d], [5, 30, d + 1], { mat: 'wall' }), DODGE.F],
  'behind a back dodge': [(b, d) => b.box([-5, 0, -d - 1], [5, 30, -d], { mat: 'wall' }), DODGE.B],
  'beside a forward dodge (left)': [(b, d) => b.box([-d - 1, 0, -5], [-d, 30, 5], { mat: 'wall' }), DODGE.F],
  'beside a forward dodge (right)': [(b, d) => b.box([d, 0, -5], [d + 1, 30, 5], { mat: 'wall' }), DODGE.F],
};

test('wall dodge reach: a wall 0.6 m from the hull works behind the dodge and on both sides, one 0.7 m away does not; the wall may touch only part of the hull height', () => {
  const bad = [];
  for (const [name, [fn, dir]] of Object.entries(WALL_SHAPES)) {
    if (!wallProbe(fn, 0.6, dir).wd) bad.push(`${name}: a wall at 0.6 m was not found`);
    if (!wallProbe(fn, 0.62, dir).wd) bad.push(`${name}: a wall at 0.62 m was not found`);
    if (wallProbe(fn, 0.7, dir).wd) bad.push(`${name}: a wall at 0.7 m counted`);
  }
  // a wall that covers only the head end of the hull (its bottom 1.2 m above the feet) still counts: the whole hull is swept
  const high = wallProbe((b, d) => b.box([-5, 6.2, d], [5, 30, d + 1], { mat: 'wall' }), 0.4, DODGE.F);
  const above = wallProbe((b, d) => b.box([-5, 7.0, d], [5, 30, d + 1], { mat: 'wall' }), 0.4, DODGE.F);   // starts above the head (feet 5 + 1.76)
  if (!high.wd) bad.push('a wall touching only the upper hull was not found');
  if (above.wd) bad.push('a wall above the head counted');
  // a wall ahead of the dodge (the dodge would run into it) does not count: only behind and beside
  const ahead = wallProbe((b, d) => b.box([-5, 0, -d - 1], [5, 30, -d], { mat: 'wall' }), 0.4, DODGE.F);
  if (ahead.wd) bad.push('a wall straight ahead of the dodge counted');
  // a floor slab at the feet is not a wall
  const floor = wallProbe((b, d) => b.box([-5, 4.0, -5], [5, 4.0 + 1, 5], { mat: 'floor' }), 0.4, DODGE.F);
  if (floor.wd) bad.push('the floor under the feet counted as a wall');
  return { ok: !bad.length, detail: bad.length ? bad.join('; ') : 'reach 0.6 / 0.62 m yes, 0.7 m no, behind and both sides; part-height walls count; walls ahead and floors do not' };
});

test('wall dodge: vy is always DODGE_Y (the tick leaves it at DODGE_Y minus one tick of gravity) and the speed along the dodge is 13.2 m/s, whether the jump was rising fast, hovering or falling fast', () => {
  const bad = [];
  const [fn, dir] = WALL_SHAPES['behind a forward dodge'];
  for (const vy of [12, 6.8, 2, 0, -3, -9, -20]) {
    const r = wallProbe(fn, 0.3, dir, vy);
    if (!r.wd) bad.push(`vy ${vy}: no wall dodge`);
    else if (Math.abs(r.vy - (DODGE_Y - G / TICK)) > 1e-6 || Math.abs(r.speed - DODGE_XY) > 1e-6) bad.push(`vy ${vy}: vy after ${f(r.vy, 3)}, speed ${f(r.speed, 3)}`);
  }
  // a fast run sideways: the speed along the dodge direction is SET to 13.2 (the sideways part stays)
  const w = mk((b) => WALL_SHAPES['behind a forward dodge'][0](b, HULL_HX + 0.3), [0, 5, 0], 0);
  w.ps.vel[0] = 6; w.ps.vel[2] = -20; w.ps.vel[1] = 3;
  w.step(cmdOf({ dodge: DODGE.F }));
  const along = -w.ps.vel[2];
  if (Math.abs(along - DODGE_XY) > 1e-6 || Math.abs(w.ps.vel[0] - 6) > 0.5) bad.push(`fast along the dodge: ${f(along, 3)} along, ${f(w.ps.vel[0], 3)} sideways`);
  return { ok: !bad.length, detail: bad.length ? bad.join('; ') : `vy ${f(DODGE_Y - G / TICK, 3)} and 13.2 m/s for vy from +12 to -20; 20 m/s along the dodge is set back to 13.2` };
});

// a diagonal jump (djBuf set, in the air), then a reset: nothing of the old airtime may leak into the new life
for (const how of ['restart', 'respawn']) {
  test(`djBuf / dodge timers are cleared by ${how === 'restart' ? 'world.restart' : 'a kill respawn'}: a plain hop afterwards never gets an automatic double jump`, () => {
    const w = mk();
    const c = makeCmd();
    run(w, c, 30);
    w.step(cmdOf({ dodge: DODGE.L, jump: true }));
    run(w, c, 4);
    const armed = w.ps.djBuf && !w.ps.grounded;
    if (how === 'restart') w.restart({ silent: true }); else w.respawn('kill');
    const clean = !w.ps.djBuf && w.ps.dodgeT === -999 && w.ps.lastJumpT === -999 && !w.ps.dodging && w.ps.grounded;
    evs(w);
    w.step(cmdOf({ jump: true }));   // a plain hop
    let dj = false, hi = 0;
    for (let i = 0; i < 300 && !(i > 5 && w.ps.grounded); i++) { w.step(c); hi = Math.max(hi, w.ps.pos[1]); if (evs(w).some((e) => e.type === 'dj')) dj = true; }
    return { ok: armed && clean && !dj && hi < 1.4, detail: `armed before the reset ${armed}, state clean after ${clean}, double jump during the next hop ${dj}, hop peak ${f(hi)} m (a plain hop is 1.22)` };
  });
}

test('speed bounds: after a real blast launch (> RUN) random input in the air never raises the speed above max(previous, RUN); VMAX clamps a 135 m/s start and a far pad', () => {
  const rng = mulberry32(0xb1a57);
  const w = mk();
  const bot = new Bot(w, [R.run(0, -20), R.shieldJump({ push: [0, -250], pitch: -50, charge: 1, run: [0, -250], to: [0, 0, -250] })]);
  let air = 0;
  for (let i = 0; i < 2000 && air === 0; i++) { w.step(bot.next()); if (!w.ps.grounded) air = i; }
  const launch = w.ps.speed;
  const c = makeCmd();
  c.yaw = w.ps.yaw;
  let worst = 0, hold = 0, n = 0;
  for (let i = 0; i < 200 && !w.ps.grounded; i++, n++) {
    if (hold-- <= 0) { hold = 3 + Math.floor(rng() * 20); c.fwd = Math.floor(rng() * 3) - 1; c.side = Math.floor(rng() * 3) - 1; c.jump = rng() < 0.2; c.dodge = rng() < 0.1 ? 1 + Math.floor(rng() * 4) : 0; c.fire = rng() < 0.2; } else { c.dodge = 0; }
    c.yaw += (rng() - 0.5) * 0.4; c.pitch = (rng() - 0.5) * 1.5;
    const before = w.ps.speed;
    w.step(c);
    worst = Math.max(worst, w.ps.speed - Math.max(before, RUN));
  }
  const big = mk();
  big.ps.vel = [100, 50, -80]; big.ps.grounded = false;
  big.step(makeCmd());
  const sp = Math.hypot(...big.ps.vel);
  const far = mk((b) => b.pad([0, 0, -1.2], { target: [0, 0, -2500], apex: 10 }));
  run(far, cmdOf({ fwd: 1 }), 20);
  const sp2 = Math.hypot(...far.ps.vel);
  return { ok: launch > RUN + 3 && n > 40 && worst < 1e-9 && sp <= VMAX + 1e-6 && sp2 <= VMAX + 1e-6, detail: `launch speed ${f(launch)} m/s, ${n} random-input air ticks, worst excess over max(previous, RUN) ${worst.toExponential(1)}; 135 m/s start -> ${f(sp)}; pad at 2500 m -> ${f(sp2)} (VMAX ${VMAX})` };
});

const SEED_A = 11;
test('World reuse (restart + teleport, as the gate checker does for ~1100 runs) is a full reset: a random-input script replays bit-identical on a dirty World', () => {
  const map = course();   // (walls, a tunnel, a checkpoint: the geometry the random script bumps into)
  const script = (seed, n) => {
    const rng = mulberry32(seed), out = [];
    let hold = 0, cur = null;
    for (let i = 0; i < n; i++) {
      if (hold-- <= 0) {
        hold = 3 + Math.floor(rng() * 25);
        cur = { fwd: rng() < 0.7 ? 1 : Math.floor(rng() * 3) - 1, side: Math.floor(rng() * 3) - 1, jump: rng() < 0.5, fire: rng() < 0.3, pitch: (rng() - 0.6) * 1.8, dyaw: (rng() - 0.5) * 0.1, dodge: 0 };
      }
      out.push({ ...cur, dodge: rng() < 0.12 ? 1 + Math.floor(rng() * 4) : 0 });
    }
    return out;
  };
  const play = (w, sc, p, yaw) => {
    w.restart({ silent: true }); w.teleport(p, yaw);
    const c = makeCmd(); c.yaw = yaw;
    const ev = [];
    for (const s of sc) {
      c.fwd = s.fwd; c.side = s.side; c.jump = s.jump; c.fire = s.fire; c.pitch = s.pitch; c.yaw += s.dyaw; c.dodge = s.dodge;
      w.step(c);
      for (const e of w.takeEvents()) ev.push(e.type + (e.auto ? 'a' : '') + (e.late ? 'l' : ''));
    }
    const q = w.ps;
    return { h: w.stateHash(), ev: ev.join(','), hidden: [q.djBuf, q.dodgeT, q.lastJumpT, q.jumpY, q.prevJump, q.wallUsed, q.djUsed, q.dodgeCd].join('/') };
  };
  const p = map.checkpoints[0].spawn, yaw = map.checkpoints[0].yaw * Math.PI / 180;
  const A = script(SEED_A, 2500), B = script(12, 1800);
  const fresh = play(new World(map), A, p, yaw);
  const dirty = new World(map);
  play(dirty, B, p, yaw);
  const again = play(dirty, A, p, yaw);
  const twin = play(new World(map), A, p, yaw);
  const diag = fresh.ev.includes('dodge') && /dja/.test(fresh.ev);
  return { ok: fresh.h === again.h && fresh.ev === again.ev && fresh.hidden === again.hidden && fresh.h === twin.h && diag, detail: `fresh ${fresh.h}, replayed on a dirty world ${again.h}, twin ${twin.h}; events equal ${fresh.ev === again.ev}; hidden state equal ${fresh.hidden === again.hidden} (${fresh.hidden}); script contains an automatic double jump: ${diag}` };
});

// ====================================================================== the real input path (input.js -> cmd -> World)
const TICK_MS = 1000 / TICK;
// events: [{ t (ms), code, down, repeat?, shift? }] are delivered to the Input before the tick that contains them, then fillCmd -> World.step
// frameMs: the events of a whole display frame reach the Input together, before the first tick of that frame (a 60 Hz game loop = 2 ticks per
// frame); without it every event is delivered before the tick it falls in
function playInput(events, { ticks = 1000, start = [0, 0, 0], yaw = 0, arena = null, frameMs = 0 } = {}) {
  const w = mk(arena, start, yaw);
  const inp = new Input({}, { sens: 1, doubleTap: true });
  inp.enabled = true; inp.setLook(yaw, 0);
  const sorted = events.slice().sort((a, b) => a.t - b.t);
  let ei = 0, take = null, land = null, hi = 0, peak = 0, hops = 0;
  const ev = [];
  for (let k = 0; k < ticks; k++) {
    const t1 = frameMs ? (Math.floor((k * TICK_MS) / frameMs + 1e-9) + 1) * frameMs : (k + 1) * TICK_MS;
    while (ei < sorted.length && sorted[ei].t < t1) {
      const e = sorted[ei++];
      (e.down ? inp.onKeyDown : inp.onKeyUp).call(inp, { code: e.code, repeat: !!e.repeat, shiftKey: !!e.shift, ctrlKey: false, metaKey: false, altKey: false, timeStamp: e.t, preventDefault() {} });
    }
    const before = w.ps.grounded, p0 = w.ps.pos.slice();
    w.step(inp.fillCmd(makeCmd()));
    for (const e of w.takeEvents()) { if (e.type !== 'clockStart') ev.push({ k, type: e.type, auto: !!e.auto, late: !!e.late }); if (e.type === 'jump') hops++; }
    if (before && !w.ps.grounded && !take) take = p0;
    if (take && !land && !before && w.ps.grounded) land = w.ps.pos.slice();
    if (!w.ps.grounded) { hi = Math.max(hi, w.ps.pos[1]); peak = Math.max(peak, w.ps.speed); }
  }
  return { ev, dist: take && land ? Math.hypot(land[0] - take[0], land[2] - take[2]) : null, hi, peak, hops, w };
}
const key = (t, code, down, o = {}) => ({ t, code, down, ...o });
const tapD = (t0, t1) => [key(t0, 'KeyD', true), key(t0 + 40, 'KeyD', false), key(t1, 'KeyD', true), key(t1 + 60, 'KeyD', false)];   // two taps: the second one at t1 (dodge)

test('input path: W held, double-tap D and Space in the three real orders (dodge first, Space first, second tap and Space in the same tick) = one diagonal jump of ~16 m each', () => {
  const T2 = 1500;
  const cases = [['dodge first (+25 ms)', 25], ['Space first (-25 ms)', -25], ['same tick (+2 ms)', 2]];
  const rows = cases.map(([name, dt]) => {
    const r = playInput([key(0, 'KeyW', true), ...tapD(1400, T2), key(T2 + dt, 'Space', true), key(T2 + dt + 100, 'Space', false)]);
    const dodge = r.ev.filter((e) => e.type === 'dodge'), dj = r.ev.filter((e) => e.type === 'dj');
    return { name, r, good: dodge.length === 1 && dj.length === 1 && dj[0].auto && r.dist > 15.2 && r.hi > 1.8 && r.hi < 1.95 && r.hops <= 1 };
  });
  const spread = Math.max(...rows.map((x) => x.r.dist)) - Math.min(...rows.map((x) => x.r.dist));
  return { ok: rows.every((x) => x.good) && spread < 1.0, detail: rows.map((x) => `${x.name}: ${x.r.ev.map((e) => e.type + (e.late ? '(late)' : '') + (e.auto ? '(auto)' : '')).join(' ')} -> ${x.r.dist && f(x.r.dist)} m, peak ${f(x.r.hi)}`).join(' | ') };
});

test('input path: a held Space (with key-repeat events) jumps once, Shift changes nothing (speed <= RUN, no dodge), W+Shift+Space same as W+Space', () => {
  const rep = [1500, 1800, 2100, 2400, 2700, 3000].map((t) => key(t, 'Space', true, { repeat: true }));
  const withShift = playInput([key(0, 'KeyW', true), key(1000, 'ShiftLeft', true, { shift: true }), key(1300, 'Space', true), ...rep, key(3500, 'Space', false)], { ticks: 700 });
  const plain = playInput([key(0, 'KeyW', true), key(1300, 'Space', true), ...rep, key(3500, 'Space', false)], { ticks: 700 });
  const bad = (r) => r.hops !== 1 || r.peak > RUN + 0.01 || r.ev.some((e) => e.type === 'dodge' || e.type === 'walldodge');
  return { ok: !bad(withShift) && !bad(plain) && Math.abs(withShift.dist - plain.dist) < 0.05 && withShift.dist > 6 && withShift.dist < 6.6, detail: `held Space + Shift: ${withShift.hops} jump(s), peak speed ${f(withShift.peak)}, hop ${f(withShift.dist)} m; without Shift: ${plain.hops} jump(s), ${f(plain.dist)} m` };
});

const FRAME_MS = 1000 / 60;
const frameOf = (t) => { let i = Math.max(0, Math.floor(t / FRAME_MS) - 1); while (t >= (i + 1) * FRAME_MS) i++; return i; };   // the 60 Hz frame whose events include time t

test('input path at 60 Hz: jump at a wall, double-tap S (a wall dodge) and Space 0 - 250 ms after the second tap is always an immediate double jump within one frame', () => {
  const bad = [];
  let n = 0, last = null;
  for (let delay = 0; delay <= 250; delay += 5) {
    const ts = 200.3 + delay;
    const r = playInput([key(0.5, 'Space', true), key(60, 'Space', false), key(100.3, 'KeyS', true), key(140, 'KeyS', false), key(200.3, 'KeyS', true), key(260, 'KeyS', false),
      key(ts, 'Space', true), key(ts + 80, 'Space', false)], { ticks: 300, start: [0, 0, -9.5], arena: WALL, frameMs: FRAME_MS });
    const wd = r.ev.filter((e) => e.type === 'walldodge'), dj = r.ev.filter((e) => e.type === 'dj'), fi = frameOf(ts);
    n++;
    if (wd.length !== 1) bad.push(`+${delay} ms: ${wd.length} wall dodges`);
    else if (dj.length !== 1 || dj[0].auto) bad.push(`+${delay} ms: double jumps ${JSON.stringify(dj)}`);
    else if (dj[0].k < 2 * fi || dj[0].k > 2 * fi + 1) bad.push(`+${delay} ms: the double jump is at tick ${dj[0].k}, the press arrived in frame ${fi} (ticks ${2 * fi}-${2 * fi + 1})`);
    last = r;
  }
  return { ok: !bad.length, detail: bad.length ? bad.slice(0, 4).join('; ') : `${n} delays from 0 to 250 ms: a wall dodge and one immediate double jump each (last run: ${last.ev.map((e) => e.type + e.k).join(' ')})` };
});

test('input path at 60 Hz: Space released and pressed again 1 - 40 ms later (inside one frame or in the next) is two presses: the second is a double jump in its own frame; a full re-tap inside one frame counts too; a held Space still jumps once', () => {
  const bad = [];
  let n = 0;
  for (let g = 1; g <= 40; g++) {
    const up = 301, down = up + g;
    const r = playInput([key(0.5, 'Space', true), key(up, 'Space', false), key(down, 'Space', true), key(down + 100, 'Space', false)], { ticks: 200, frameMs: FRAME_MS });
    const jumps = r.ev.filter((e) => e.type === 'jump'), dj = r.ev.filter((e) => e.type === 'dj'), fi = frameOf(down);
    n++;
    if (jumps.length !== 1) bad.push(`g=${g}: ${jumps.length} jumps`);
    if (dj.length !== 1 || dj[0].auto || dj[0].k < 2 * fi || dj[0].k > 2 * fi + 1) bad.push(`g=${g}: re-press in frame ${fi}: double jumps ${JSON.stringify(dj)}`);
  }
  // down, up, down, up all inside one frame (a quick re-tap while the first press is still held): the second press is not lost
  for (const g of [2, 6, 12]) {
    const r = playInput([key(0.5, 'Space', true), key(301, 'Space', false), key(301 + g, 'Space', true), key(302 + g, 'Space', false)], { ticks: 200, frameMs: FRAME_MS });
    const dj = r.ev.filter((e) => e.type === 'dj');
    if (dj.length !== 1 || dj[0].k < 36 || dj[0].k > 37) bad.push(`re-tap inside one frame (g=${g}): double jumps ${JSON.stringify(dj)}`);
  }
  // a Space held down the whole time (no release) is still one jump and no double jump
  const held = playInput([key(0.5, 'Space', true), key(900, 'Space', false)], { ticks: 200, frameMs: FRAME_MS });
  if (held.ev.filter((e) => e.type === 'jump').length !== 1 || held.ev.some((e) => e.type === 'dj')) bad.push('held Space: ' + held.ev.map((e) => e.type + e.k).join(' '));
  return { ok: !bad.length, detail: bad.length ? bad.slice(0, 4).join('; ') : `${n} gaps from 1 to 40 ms, 3 re-taps and a held Space behave` };
});

test('input path: a Space tapped and released inside one tick still jumps (at 120 and at 60 Hz), also right after another quick tap; taps apart from each other are not changed', () => {
  const bad = [];
  for (const frameMs of [0, FRAME_MS]) {
    const hz = frameMs ? 60 : 120;
    const tap = playInput([key(100.2, 'Space', true), key(100.5, 'Space', false)], { ticks: 160, frameMs });
    if (tap.ev.filter((e) => e.type === 'jump').length !== 1) bad.push(`single tap (${hz} Hz): ${tap.ev.map((e) => e.type + e.k)}`);
    // two quick taps in the next tick / frame (10 ms later at 120 Hz, 20 ms at 60 Hz): the first jumps, the second is a double jump
    const t2 = frameMs ? 120.2 : 110.2;
    const two = playInput([key(100.2, 'Space', true), key(100.5, 'Space', false), key(t2, 'Space', true), key(t2 + 0.3, 'Space', false)], { ticks: 160, frameMs });
    const j = two.ev.filter((e) => e.type === 'jump').length, d = two.ev.filter((e) => e.type === 'dj').length;
    if (j !== 1 || d !== 1) bad.push(`two quick taps (${hz} Hz): ${two.ev.map((e) => e.type + e.k)}`);
    // far apart: a jump, then a double jump 200 ms later
    const far = playInput([key(100.2, 'Space', true), key(160, 'Space', false), key(360, 'Space', true), key(420, 'Space', false)], { ticks: 200, frameMs });
    if (far.ev.filter((e) => e.type === 'jump').length !== 1 || far.ev.filter((e) => e.type === 'dj').length !== 1) bad.push(`jump + double jump (${hz} Hz): ${far.ev.map((e) => e.type + e.k)}`);
  }
  return { ok: !bad.length, detail: bad.length ? bad.join('; ') : 'single tap, two quick taps and a jump with a later double jump, at both rates' };
});

test('input: a Space or shield button released and pressed again before the next tick shows one tick of "off" in between (so the sim sees two presses); nothing else changes: holding, releasing, the gap after blur / clearLatches', () => {
  const mkI = () => { const i = new Input({}, { sens: 1, doubleTap: true }); i.enabled = true; i.locked = true; return i; };
  const ev = (code, o = {}) => ({ code, repeat: false, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, timeStamp: 1000, target: {}, preventDefault() {}, ...o });
  const seq = (i, n = 1) => Array.from({ length: n }, () => { const c = i.fillCmd(makeCmd()); return (c.jump ? 'J' : '-') + (c.fire ? 'F' : '-'); }).join(' ');
  const bad = [];
  const check = (name, got, want) => { if (got !== want) bad.push(`${name}: ${got} (wanted ${want})`); };
  let i = mkI();
  i.onKeyDown(ev('Space')); check('press', seq(i, 3), 'J- J- J-');
  i.onKeyUp(ev('Space')); check('release', seq(i, 3), '-- -- --');
  i = mkI();
  i.onKeyDown(ev('Space')); seq(i);
  i.onKeyUp(ev('Space')); i.onKeyDown(ev('Space')); check('release + press between two ticks', seq(i, 4), '-- J- J- J-');
  i = mkI();
  i.onKeyDown(ev('Space')); seq(i);
  i.onKeyUp(ev('Space')); i.onKeyDown(ev('Space')); i.onKeyUp(ev('Space')); check('release + a quick re-tap', seq(i, 3), '-- J- --');
  i = mkI();
  i.onKeyDown(ev('Space')); i.onKeyUp(ev('Space')); check('a tap inside one tick', seq(i, 3), 'J- -- --');
  i = mkI();
  i.onKeyDown(ev('Space')); i.onKeyUp(ev('Space')); seq(i); i.onKeyDown(ev('Space')); i.onKeyUp(ev('Space')); check('two taps, one per tick', seq(i, 3), '-- J- --');
  i = mkI();
  i.onKeyDown(ev('Space')); seq(i); i.onKeyUp(ev('Space')); i.onKeyDown(ev('Space', { repeat: true })); check('a key-repeat event is no press', seq(i, 2), '-- --');
  i = mkI();
  i.onKeyDown(ev('Space')); seq(i); i.onKeyUp(ev('Space')); i.releaseAll(); i.onKeyDown(ev('Space')); check('releaseAll forgets the gap', seq(i, 2), 'J- J-');
  i = mkI();
  i.onKeyDown(ev('Space')); seq(i); i.onKeyUp(ev('Space')); i.clearLatches(); i.onKeyDown(ev('Space')); check('clearLatches forgets the gap', seq(i, 2), 'J- J-');
  // the shield button the same way
  i = mkI();
  i.onMouseDown({ button: 0 }); check('shield press', seq(i, 2), '-F -F');
  i.onMouseUp({ button: 0 }); i.onMouseDown({ button: 0 }); check('shield release + press between two ticks', seq(i, 3), '-- -F -F');
  i.onMouseUp({ button: 0 }); check('shield release', seq(i, 2), '-- --');
  i = mkI();
  i.onMouseDown({ button: 0 }); i.onMouseUp({ button: 0 }); check('a click inside one tick', seq(i, 3), '-F -- --');
  i = mkI();
  i.onMouseDown({ button: 2 }); i.onMouseUp({ button: 2 }); check('other buttons do nothing', seq(i, 2), '-- --');
  return { ok: !bad.length, detail: bad.length ? bad.join('; ') : 'jump and shield button sequences as intended' };
});

// ====================================================================== maps: texts and gates
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const walk = (dir) => readdirSync(dir).flatMap((n) => { const p = dir + n; return statSync(p).isDirectory() ? (n === 'test' || n === 'node_modules' ? [] : walk(p + '/')) : [p]; });

test('no bunnyhop / strafe / Shift / autoHop left: map texts (blurbs, signs, markers) never teach them; the app code has no autoHop / Q3 air constants', () => {
  const bad = [];
  const re = /bunny|strafe|shift|sprint|auto-?hop|autohop/i;
  for (const def of MAPS.list) {
    const m = def.build();
    const texts = [m.meta.blurb, m.meta.name, ...m.signs.flatMap((s) => [s.title, s.keys, s.text]), ...m.markers.map((x) => x.text)];
    for (const t of texts) if (re.test(t || '')) bad.push(`${def.meta.id}: "${(t || '').slice(0, 60)}"`);
  }
  const files = walk(ROOT).filter((p) => /\.(js|mjs|html|css)$/.test(p));
  for (const p of files) {
    const src = readFileSync(p, 'utf8');
    const m = src.match(/autoHop|AIR_K\b|AIR_TURN\b/);
    if (m) bad.push(`${p.slice(ROOT.length)} still mentions ${m[0]}`);
  }
  return { ok: !bad.length, detail: bad.length ? bad.slice(0, 5).join('; ') : `${MAPS.list.length} maps' texts and ${files.length} source files are clean` };
});

export function runV2Tests() {
  return tests.map((t) => {
    try { return { name: t.name, ...t.fn() }; } catch (e) { return { name: t.name, ok: false, detail: 'threw: ' + (e.stack || e.message) }; }
  });
}
