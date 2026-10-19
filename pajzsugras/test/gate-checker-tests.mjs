// Robustness of the combo-gate checker (test/gates.mjs) and of b.gate (columbo). The maps rely on the checker, so it is tested as
// infrastructure: a crossable gap must FAIL for each family, a near miss inside the margin must FAIL (also a fly-through that overshoots the
// ledge), {cp} starts and group transforms resolve, an unreachable solve fails with a useful message, and a deny search in which no run
// ever left the ground must not count as a pass. (gates.mjs's own self-tests cover the 9 m dj gap and the 20 m wall-side pass.)
// Each case returns { name, ok, detail }; runGateCheckerTests() runs them all.
import { defineMap } from '../sim/builder.js';
import { R } from '../sim/bot.js';
import { checkGate } from './gates.mjs';

const EDGE = -20.3;   // the far edge of the start platform (z); the start is at the origin, the goal ledge lies `gap` beyond the edge
let seq = 0;
const meta = (id) => ({ id: `${id}-${++seq}`, name: 'Kapu', diff: 'kikepzes', order: 1, blurb: '', authorTime: 1 });

// start platform x -30..0.9, z EDGE..30 (top y 0), void below, goal ledge `ledge` m deep beginning `gap` m beyond the edge
function arena(gap, ledge = 20, plat = [-30, 0.9, 30]) {
  return defineMap(meta('gate'), (b) => {
    b.start([0, 0, 0], 0);
    b.box([plat[0], -1, EDGE], [plat[1], 0, plat[2]], { mat: 'floor' });
    b.box([-14, -1, EDGE - gap - ledge], [0.9, 0, EDGE - gap], { mat: 'floor' });
    b.checkpoint([-1, 0, -1], [1, 2, 1], { spawn: [0, 0, 0] });
    b.finish([-10, 0, EDGE - gap - 12], [0, 2, EDGE - gap - 10]);
    b.route([R.wait(0.1)]);
  }).build();
}
const gate = (gap, ledge, deny, solve, margin = 0.6) => ({
  name: 'proba', combo: '', start: { pos: [0, 0, 0], yaw: 0 }, goal: { min: [-14, -0.1, EDGE - gap - ledge], max: [0.9, 2.5, EDGE - gap] }, solve, deny, spread: 1, margin,
});
const to = (gap) => [-6, 0, EDGE - gap - 3];
const jumpSolve = (gap) => [R.run(0, -19, { tol: 0.5 }), R.jump({ to: to(gap), edge: true })];
const dodgeJumpSolve = (gap) => [R.run(0, -19, { tol: 0.5 }), R.dodgeJump('F', { to: to(gap), edge: true })];
const shieldSolve = (gap) => [R.charge(true, { to: 1 }), R.shieldJump({ push: [0, -250], pitch: -50, charge: 1, run: [0, -250], to: to(gap), edge: true, dj: 'apex' })];
const SLOPPY = { press: 3, aim: 2 };
const f2 = (v) => (v === null || v === undefined ? '-' : v.toFixed(2));

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---- every family must be able to fail a gate it can cross
for (const [fam, gap, solve] of [['jump', 5, jumpSolve(5)], ['dodgeJump', 12, dodgeJumpSolve(12)], ['shield', 24, shieldSolve(24)]]) {
  test(`gate checker: a ${gap} m gap that a single ${fam} crosses must FAIL with deny [${fam}] (the solve itself passes 5/5)`, () => {
    const r = checkGate(arena(gap), gate(gap, 20, [fam], solve), { sloppy: SLOPPY, nSloppy: 5 });
    return { ok: !r.ok && r.solve && r.sloppy === '5/5' && new RegExp(`^tiltás megbukott: ${fam}`).test(r.fail || ''), detail: `ok=${r.ok}, solve ${r.solve} ${r.sloppy}, ${r.fail}` };
  });
}

// ---- the margin: a flight that misses by less than `margin` fails although it never lands in the goal. The gap is bisected (the physics
// constants will be tuned after playtests): lo = a gap the double-jump family cannot cross but comes within the margin of, hi = the
// smallest gap it stays 0.6 m away from
test('gate checker: the margin is the closest approach, not the landing: just below the pass boundary the dj family is reported as an approach < 0.6 m (no landing), just above it the gate passes, with margin 1.0 the same gap fails', () => {
  const at = (gap, margin) => checkGate(arena(gap), gate(gap, 20, ['dj'], shieldSolve(gap), margin), { nSloppy: 0 });
  let lo = 9, hi = 17;
  if (at(lo, 0.6).ok || !at(hi, 0.6).ok) return { ok: false, detail: `setup: the dj family must cross a ${lo} m gap and stay clear of a ${hi} m gap` };
  for (let i = 0; i < 6; i++) { const mid = (lo + hi) / 2; if (at(mid, 0.6).ok) hi = mid; else lo = mid; }
  const below = at(lo, 0.6), above = at(hi, 0.6), strict = at(hi, 1.0);
  const ok = !below.ok && below.solve && /megközelíti/.test(below.fail || '') && !/a célban landol/.test(below.fail || '') && below.closest.d > 0 && below.closest.d < 0.6
    && above.ok && above.closest.d >= 0.6 && above.closest.d < 0.9 && !strict.ok && /megközelíti/.test(strict.fail || '');
  return { ok, detail: `boundary between ${lo.toFixed(2)} m (closest ${below.closest && f2(below.closest.d)} m: ${below.fail}) and ${hi.toFixed(2)} m (closest ${f2(above.closest.d)} m, passes); margin 1.0 at ${hi.toFixed(2)} m: ok=${strict.ok}` };
});
test('gate checker: a fly-through must FAIL: a single jump that crosses the goal box in the air and overshoots a 1.5 m ledge (never lands in it) is inside the margin', () => {
  const gap = 4, ledge = 1.5;
  const solve = [R.run(0, -19.3, { tol: 0.2 }), R.jump({ to: [-6, 0, EDGE - gap - 0.75] })];   // a short hop that lands on the ledge
  const r = checkGate(arena(gap, ledge), gate(gap, ledge, ['jump'], solve), { nSloppy: 0 });
  return { ok: r.solve && !r.ok && /megközelíti/.test(r.fail || '') && r.closest && r.closest.d < 0.05, detail: `solve ${r.solve}, ok=${r.ok}, closest ${r.closest && f2(r.closest.d)} m; ${r.fail}` };
});

// ---- b.gate: { cp } starts, group transforms, validation, not part of the map hash
const GOAL = [[2, 0, -20], [4, 2, -18]];
const cpMap = (withGates, startCp) => defineMap(meta('cp'), (b) => {
  b.start([0, 0, 0], 0);
  b.box([-30, -1, -30], [30, 0, 30], { mat: 'floor' });
  b.checkpoint([-1, 0, -1], [1, 2, 1], { spawn: [0, 0, 0] });
  b.group({ at: [10, 0, 5], yaw: 90 }, () => {
    b.checkpoint([2, 0, -8], [4, 2, -6], { spawn: [3, 0, -7], yaw: 30 });   // checkpoint 1
    if (withGates) {
      b.gate('by cp', { start: { cp: startCp ?? 1 }, goal: GOAL, solve: [R.wait(0.1)] });
      b.gate('by pos', { start: { pos: [3, 0, -7], yaw: 30 }, goal: GOAL, solve: [R.wait(0.1)] });
    }
    b.checkpoint(...GOAL);   // checkpoint 2: the same local box as the goal, to read its transformed twin
  });
  b.finish([20, 0, 20], [22, 2, 22]);
  b.route([R.wait(0.1)]);
}).build();

test('b.gate: { cp } resolves to that checkpoint\'s spawn + yaw, a { pos } start and the goal box get the group transform (yaw 90 + offset), and the gate does not change the map hash', () => {
  const m = cpMap(true), plain = cpMap(false);
  const [byCp, byPos] = m.gates, cp1 = m.checkpoints[1], cp2 = m.checkpoints[2];
  const same = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-9);
  const ok = same(byCp.start.pos, cp1.spawn) && Math.abs(byCp.start.yaw - cp1.yaw) < 1e-9 && byCp.start.cp === 1
    && same(byPos.start.pos, cp1.spawn) && Math.abs(byPos.start.yaw - cp1.yaw) < 1e-9
    && same(byCp.goal.min, cp2.min) && same(byCp.goal.max, cp2.max) && same(byPos.goal.min, cp2.min) && same(byPos.goal.max, cp2.max)
    && Math.abs(cp1.yaw - 120) < 1e-9 && m.mapHash === plain.mapHash && plain.gates.length === 0;
  return { ok, detail: `cp start ${byCp.start.pos.map((v) => f2(v))} yaw ${byCp.start.yaw}, checkpoint spawn ${cp1.spawn.map((v) => f2(v))} yaw ${cp1.yaw}; pos start ${byPos.start.pos.map((v) => f2(v))} yaw ${byPos.start.yaw}; goal ${byCp.goal.min.map((v) => f2(v))}..${byCp.goal.max.map((v) => f2(v))} vs ${cp2.min.map((v) => f2(v))}..${cp2.max.map((v) => f2(v))}; hash equal ${m.mapHash === plain.mapHash}` };
});
test('b.gate: a { cp } start that does not exist (7, -1) makes the map build throw a message that names the gate and the checkpoint', () => {
  const msgs = [7, -1].map((cp) => { try { cpMap(true, cp); return 'no error'; } catch (e) { return e.message; } });
  return { ok: msgs.every((s) => /gate "by cp": checkpoint -?\d+ does not exist/.test(s)), detail: msgs.join(' | ') };
});

// ---- the solve must prove the goal is reachable, with a message that says what happened
test('gate checker: a solve that cannot reach the goal (40 m gap) or never leaves the ground fails with a message that says how far / that it stayed on the ground', () => {
  const far = checkGate(arena(40), gate(40, 20, ['jump'], jumpSolve(40)), { nSloppy: 5, sloppy: SLOPPY });
  const stand = checkGate(arena(9), gate(9, 20, ['jump'], [R.wait(1)]), { nSloppy: 0 });
  const ok = !far.ok && !far.solve && /a megoldás nem éri el a célt: ended [\d.]+ m from the goal/.test(far.fail || '')
    && !stand.ok && !stand.solve && /without leaving the ground/.test(stand.fail || '') && far.denyRuns > 0;
  return { ok, detail: `far: ${far.fail}; stand: ${stand.fail}` };
});

// ---- a deny search in which nothing ever took off proves nothing and must not pass
test('gate checker: a deny search in which no run ever left the ground must NOT report a pass (600 x 600 m start platform, deny dodge / diag / wallBoost: every run-up times out)', () => {
  const gap = 9, edge = -300;
  const map = defineMap(meta('huge'), (b) => {
    b.start([0, 0, 0], 0);
    b.box([-300, -1, edge], [300, 0, 300], { mat: 'floor' });
    b.box([-14, -1, edge - gap - 20], [0.9, 0, edge - gap], { mat: 'floor' });
    b.checkpoint([-1, 0, -1], [1, 2, 1], { spawn: [0, 0, 0] });
    b.finish([-10, 0, edge - gap - 12], [0, 2, edge - gap - 10]);
    b.route([R.wait(0.1)]);
  }).build();
  const g = {
    name: 'huge', combo: '', start: { pos: [0, 0, 0], yaw: 0 }, goal: { min: [-14, -0.1, edge - gap - 20], max: [0.9, 2.5, edge - gap] }, spread: 1, margin: 0.6,
    solve: [R.run(0, edge + 1, { tol: 0.5, timeout: 60 }), R.jump({ to: [-6, 0, edge - gap - 3], dj: 'apex', edge: true })], deny: ['dodge', 'diag', 'wallBoost'],
  };
  const r = checkGate(map, g, { nSloppy: 0 });
  const airborne = Object.values(r.byFamily).reduce((s, fb) => s + (fb.best ? 1 : 0), 0);
  return { ok: r.solve && airborne === 0 && !r.ok, detail: `solve ${r.solve}, ${r.denyRuns} deny runs, families with a run that got airborne: ${airborne}, closest ${r.closest ? f2(r.closest.d) : 'none (nobody took off)'}, ok=${r.ok}, warn=${r.warn}` };
});

export function runGateCheckerTests() {
  return tests.map((t) => {
    try { return { name: t.name, ...t.fn() }; } catch (e) { return { name: t.name, ok: false, detail: 'threw: ' + (e.stack || e.message) }; }
  });
}
