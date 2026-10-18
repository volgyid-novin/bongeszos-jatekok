// The fixed double jump / wall dodge rules (SIM_VER 3) on the player's REAL map (maps/uj-palya.js, the editor export) through the real input path
// (input.js -> cmd -> World) at 60 and 144 Hz, plus the properties that must hold whatever the player does: one wall dodge per airtime, at most
// two double jumps per airtime, no height without limit; and a double jump pressed while a shield jump / a pad is still rising faster than DJ_V.
// What v2-tests.mjs / third-person-edge-tests.mjs already check on the synthetic wall (Space 0 - 400 ms after a wall dodge, restored double jump,
// reach, vy 4.2) is not repeated: this file is about the real geometry (the wall at x = -1.5, z -16.5 .. -10.5, y 0 .. 4; the 12 m wall of the second platform; the
// 2 m corridor with a wall on each side), the frame loop of main.js and the limits.
// The real map: start platform x -1 .. 5, z -3.5 .. 2.5 (top y = 1); a 7 m gap; the wall to the left of the line x = -0.6 at z -10.5 .. -16.5;
// the second platform x -1 .. 5, z -29.5 .. -23.5 with a wall behind it (z -29.5 .. -28.5, up to y = 17); the strip at y 12 (x -13 .. 5, z -26 .. -20) whose
// end is the mouth of a corridor 2 m wide (walls at z -22 .. -21 and -25 .. -24).
import { test, assert } from './harness.mjs';
import { createWorld, World } from '../sim/world.js';
import { MAPS } from '../maps/index.js';
import { Input } from '../input.js';
import { makeCmd } from '../sim/pmove.js';
import { TICK, G, DJ_V, SH_IMAX } from '../sim/const.js';
import { mulberry32 } from '../sim/math.js';
import { testArena } from './probes.js';

const TICK_MS = 1000 / TICK;
const VY_AFTER_DJ = DJ_V - G / TICK;   // vy at the end of the tick of a double jump
const real = () => createWorld(MAPS.get('uj-palya'));
const k = (t, code, down) => ({ t, code, down });

// events [{ t (ms), code, down }] reach the Input between display frames exactly as in the browser (a frame at hz adds 1000/hz ms, the events up
// to its end are delivered first, then the sim ticks the accumulator holds run: main.js frameBody); the player stands at `start` facing -z
function loop(events, { hz, ms, start }) {
  const w = real();
  w.teleport(start, 0);
  const inp = new Input({}, { sens: 1, doubleTap: true });
  inp.enabled = true; inp.locked = true; inp.setLook(0, 0);
  const sorted = events.slice().sort((a, b) => a.t - b.t);
  const frameMs = 1000 / hz, log = [];
  let ei = 0, acc = 0, tick = 0;
  for (let f = 0; (f + 1) * frameMs <= ms; f++) {
    const end = (f + 1) * frameMs;
    while (ei < sorted.length && sorted[ei].t < end) {
      const e = sorted[ei++];
      (e.down ? inp.onKeyDown : inp.onKeyUp).call(inp, { code: e.code, repeat: false, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, timeStamp: e.t, preventDefault() {} });
    }
    acc += frameMs;
    while (acc >= TICK_MS) {
      acc -= TICK_MS;
      w.step(inp.fillCmd(makeCmd()));
      for (const e of w.takeEvents()) if (e.type !== 'clockStart') log.push({ tick, type: e.type, auto: !!e.auto, late: !!e.late, normal: e.normal, vy: w.ps.vel[1], pos: w.ps.pos.slice() });
      tick++;
    }
  }
  const of = (t) => log.filter((e) => e.type === t);
  return { log, w, of, text: log.map((e) => `${e.type}${e.auto ? '(auto)' : ''}${e.late ? '(late)' : ''}@${e.tick}`).join(' ') };
}

// ---------------------------------------------------------------- the user's sequences on the real wall, 60 and 144 Hz
// Run-up from the start platform along the wall (x = -0.6, the wall face is 0.5 m to the left), jump at the edge (~340 ms), then the double-tap D (a wall
// dodge to the right, away from the wall) once the hull is level with the wall (z -10.5 and beyond) at ~1200 ms
const RUN = [k(0, 'KeyW', true), k(340, 'Space', true), k(420, 'Space', false)];
const TAP_D = (t) => [k(t - 80, 'KeyD', true), k(t - 40, 'KeyD', false), k(t, 'KeyD', true), k(t + 60, 'KeyD', false)];
const START1 = [-0.6, 1, -1.0];

test('real map, real input at 60 / 144 Hz: jump along the wall, double-tap D (wall dodge away from it), Space 0 or 400 ms later - one wall dodge off the +x face and exactly one immediate double jump (vy = DJ_V), never an automatic one', () => {
  const bad = [];
  for (const hz of [60, 144]) for (const delay of [0, 400]) {
    const WD = 1200;
    const r = loop([...RUN, ...TAP_D(WD), k(WD + delay, 'Space', true), k(WD + delay + 80, 'Space', false)], { hz, ms: 2400, start: START1 });
    const tag = `${hz} Hz +${delay} ms`;
    const wd = r.of('walldodge'), dj = r.of('dj');
    if (r.of('jump').length !== 1) bad.push(`${tag}: ${r.of('jump').length} jumps (${r.text})`);
    else if (wd.length !== 1 || !wd[0].normal || wd[0].normal[0] < 0.99) bad.push(`${tag}: wall dodges ${JSON.stringify(wd.map((e) => [e.tick, e.normal]))} (${r.text})`);
    else if (dj.length !== 1 || dj[0].auto) bad.push(`${tag}: double jumps ${JSON.stringify(dj.map((e) => [e.tick, e.auto]))} (${r.text})`);
    else {
      const gap = dj[0].tick - wd[0].tick, want = delay / TICK_MS;
      if (gap < 0 || Math.abs(gap - want) > 3) bad.push(`${tag}: the double jump comes ${gap} ticks after the wall dodge, wanted ~${want.toFixed(0)}`);
      if (Math.abs(dj[0].vy - VY_AFTER_DJ) > 1e-6) bad.push(`${tag}: vy after the double jump ${dj[0].vy.toFixed(4)}, wanted ${VY_AFTER_DJ.toFixed(4)}`);
    }
  }
  assert.ok(!bad.length, bad.slice(0, 3).join('; '));
});

test('real map, real input at 60 / 144 Hz: jump, double jump, wall dodge, Space - a SECOND double jump (at once or 250 ms later); a third Space, and a second double-tap at the wall, add nothing', () => {
  const bad = [];
  for (const [hz, delay] of [[60, 0], [144, 250]]) {
    const WD = 1250;
    const ev = [...RUN, k(520, 'Space', true), k(600, 'Space', false), ...TAP_D(WD), k(WD + delay, 'Space', true), k(WD + delay + 60, 'Space', false),
      k(WD + delay + 150, 'Space', true), k(WD + delay + 210, 'Space', false), ...TAP_D(WD + delay + 320)];
    const r = loop(ev, { hz, ms: 2800, start: START1 });
    const tag = `${hz} Hz +${delay} ms`, dj = r.of('dj'), wd = r.of('walldodge');
    if (dj.length !== 2 || dj.some((e) => e.auto)) bad.push(`${tag}: double jumps ${JSON.stringify(dj.map((e) => [e.tick, e.auto]))} (${r.text})`);
    else if (wd.length !== 1 || !(dj[0].tick < wd[0].tick && wd[0].tick <= dj[1].tick)) bad.push(`${tag}: order ${r.text}`);
    else if (Math.abs(dj[1].vy - VY_AFTER_DJ) > 1e-6) bad.push(`${tag}: the restored double jump leaves with vy ${dj[1].vy.toFixed(4)}`);
  }
  assert.ok(!bad.length, bad.slice(0, 3).join('; '));
});

// Standing against the 12 m wall of the second platform (it is in FRONT of the player, so every dodge direction finds it at the side or behind).
// Diagonal jump to the left (A A + Space) from x = 4, then a back dodge (S S) = a wall dodge away from the wall.
const T0 = 500;
const DIAG_LEFT = [k(T0, 'KeyA', true), k(T0 + 40, 'KeyA', false), k(T0 + 80, 'KeyA', true), k(T0 + 82, 'Space', true), k(T0 + 90, 'Space', false), k(T0 + 220, 'KeyA', false)];
const TAP_S = (t) => [k(t - 70, 'KeyS', true), k(t - 40, 'KeyS', false), k(t, 'KeyS', true), k(t + 60, 'KeyS', false)];

test('real map, real input at 60 / 144 Hz: diagonal jump, then a wall dodge before the apex (drops the buffered double jump, the next Space is an immediate one) or after the automatic double jump (restores it: a second one)', () => {
  const bad = [];
  for (const [hz, name, wdAt, delay] of [[60, 'before the apex', 100, 120], [144, 'after the automatic double jump', 330, 0]]) {
    const ev = [...DIAG_LEFT, ...TAP_S(T0 + wdAt), k(T0 + wdAt + delay, 'Space', true), k(T0 + wdAt + delay + 50, 'Space', false), k(T0 + wdAt + delay + 200, 'Space', true), k(T0 + wdAt + delay + 250, 'Space', false)];
    const r = loop(ev, { hz, ms: 1800, start: [4.0, 1, -28.0] });
    const dj = r.of('dj'), wd = r.of('walldodge'), dodge = r.of('dodge');
    const tag = `${hz} Hz, wall dodge ${name}`;
    const manual = dj.filter((e) => !e.auto), auto = dj.filter((e) => e.auto);
    if (dodge.length !== 1 || wd.length !== 1) { bad.push(`${tag}: ${dodge.length} dodges, ${wd.length} wall dodges (${r.text})`); continue; }
    if (name === 'before the apex' && !(auto.length === 0 && manual.length === 1 && manual[0].tick > wd[0].tick)) bad.push(`${tag}: ${r.text}`);
    if (name !== 'before the apex' && !(auto.length === 1 && manual.length === 1 && auto[0].tick < wd[0].tick && manual[0].tick >= wd[0].tick)) bad.push(`${tag}: ${r.text}`);
    if (dj.length > 2) bad.push(`${tag}: ${dj.length} double jumps`);
  }
  assert.ok(!bad.length, bad.slice(0, 3).join('; '));
});

// ---------------------------------------------------------------- limits: one wall dodge per airtime, two double jumps, a bounded height
// per airtime: wall dodges, double jumps (manual + automatic), highest rise above the takeoff; an airtime ends on the ground or on a respawn
function stats(w, drive, n, init = {}) {
  const cmd = Object.assign(makeCmd(), init);
  const out = { max: { wd: 0, dj: 0, gain: 0 }, airtimes: 0, withWd: 0 };
  let wd = 0, dj = 0, takeY = w.ps.pos[1], air = false;
  for (let t = 0; t < n; t++) {
    drive(t, cmd, w);
    w.step(cmd);
    for (const e of w.takeEvents()) {
      if (e.type === 'respawn') { wd = 0; dj = 0; air = false; takeY = w.ps.pos[1]; }
      if (e.type === 'walldodge') wd++;
      if (e.type === 'dj') dj++;
    }
    if (w.ps.grounded) { if (air && wd) out.withWd++; if (air) out.airtimes++; air = false; wd = 0; dj = 0; takeY = w.ps.pos[1]; } else {
      air = true;
      out.max.wd = Math.max(out.max.wd, wd); out.max.dj = Math.max(out.max.dj, dj); out.max.gain = Math.max(out.max.gain, w.ps.pos[1] - takeY);
    }
  }
  return out;
}
const tallWall = () => new World(testArena((b) => { b.box([-10, 0, -6], [10, 80, -5], { mat: 'wall' }); }).build());
const chimney = () => new World(testArena((b) => { b.box([-3, 0, -30], [-0.7, 80, 30], { mat: 'wall' }); b.box([0.7, 0, -30], [3, 80, 30], { mat: 'wall' }); }).build());

test('limits: a player who tries everything against a tall wall, between two walls 1.4 m apart, against the real 12 m wall and in the real 2 m corridor - at most one wall dodge and two double jumps per airtime, and never more than ~4.5 m above the takeoff (no climbing a wall)', () => {
  const spots = [
    ['tall wall', tallWall, [0, 0, -4.5], 0, {}], ['chimney', chimney, [0, 0, 0], 0, {}], ['real 12 m wall', real, [2, 1, -28.0], 0, {}],
    ['real corridor', real, [-9, 12, -23], Math.PI / 2, { fwd: 1, yaw: Math.PI / 2 }],   // the strip at y 12 running into the 2 m corridor: walls on both sides
  ];
  const bad = [];
  let bestGain = 0, wdAirtimes = 0;
  for (const [name, mk, pos, yaw, init] of spots) {
    // (a) the best case: jump, and at every apex press Space and dodge in the next direction (a bot that climbs for ever if a wall dodge were free)
    const w = mk(); w.teleport(pos, yaw);
    let dir = 0;
    const greedy = stats(w, (t, c, wl) => {
      const apex = !wl.ps.grounded && wl.ps.vel[1] <= 0.3;
      c.jump = wl.ps.grounded ? t % 2 === 0 : apex && t % 2 === 0;
      c.dodge = apex ? 1 + (dir++ % 4) : 0;
    }, 3000, init);
    // (b) random spam of Space and all four dodges every few ticks
    const rng = mulberry32(0xc01 + name.length);
    const w2 = mk(); w2.teleport(pos, yaw);
    const spam = stats(w2, (t, c) => {
      if (t % 3 === 0) { c.fwd = Math.floor(rng() * 3) - 1; c.side = Math.floor(rng() * 3) - 1; c.yaw = rng() * 6.28; }
      c.jump = rng() < 0.5; c.dodge = rng() < 0.5 ? 1 + Math.floor(rng() * 4) : 0;
    }, 4000, init);
    for (const [kind, s] of [['greedy', greedy], ['spam', spam]]) {
      if (s.max.wd > 1) bad.push(`${name}/${kind}: ${s.max.wd} wall dodges in one airtime`);
      if (s.max.dj > 2) bad.push(`${name}/${kind}: ${s.max.dj} double jumps in one airtime`);
      if (s.max.gain > 4.6) bad.push(`${name}/${kind}: rose ${s.max.gain.toFixed(2)} m in one airtime`);
      bestGain = Math.max(bestGain, s.max.gain); wdAirtimes += s.withWd;
    }
  }
  assert.ok(!bad.length, bad.slice(0, 4).join('; '));
  assert.ok(bestGain > 3 && wdAirtimes >= 3, `the bots did use the limits: best rise ${bestGain.toFixed(2)} m, ${wdAirtimes} airtimes with a wall dodge`);
});

// ---------------------------------------------------------------- the double jump while a shield jump / a pad is still rising faster than DJ_V
test('double jump after a real shield jump and after a pad: a press while vy > DJ_V is ignored and does not spend it; at the apex the press sets vy = DJ_V; once spent, no more', () => {
  const bad = [];
  const dj = (w) => w.takeEvents().filter((e) => e.type === 'dj');
  // (a) shield jump on the real start platform: full charge at the floor, release + Space on the same tick (vy ~ 15.7)
  {
    const w = real();
    w.teleport([1.5, 1, -0.5], 0);
    const c = makeCmd(); c.pitch = -1.4; c.fire = true;
    for (let i = 0; i < 150; i++) w.step(c);
    c.fire = false; c.jump = true; w.step(c); c.jump = false;
    const launch = w.ps.vel[1];
    if (!(launch > DJ_V + 4 && launch < 6.8 + SH_IMAX + 0.1)) bad.push(`shield jump: vy ${launch.toFixed(2)}`);
    w.takeEvents();
    for (let i = 0; i < 20; i++) w.step(c);                      // rising, past the combo window
    c.jump = true; w.step(c); c.jump = false;                    // a fresh Space press while rising fast
    const early = dj(w), spent = w.ps.djUsed, vyEarly = w.ps.vel[1];
    if (early.length || spent || vyEarly < DJ_V) bad.push(`shield jump: the press at vy ${vyEarly.toFixed(2)} ${early.length ? 'double-jumped' : 'was ignored'}, djUsed ${spent}`);
    let n = 0; while (w.ps.vel[1] > 0 && n++ < 400) w.step(c);   // up to the apex
    c.jump = true; w.step(c); c.jump = false;
    const apex = dj(w);
    if (apex.length !== 1 || apex[0].auto || Math.abs(w.ps.vel[1] - VY_AFTER_DJ) > 1e-6) bad.push(`shield jump: at the apex ${apex.length} double jumps, vy ${w.ps.vel[1].toFixed(3)}`);
    w.step(c); c.jump = true; w.step(c); c.jump = false;
    if (dj(w).length) bad.push('shield jump: a second double jump in the same airtime');
  }
  // (b) a jump pad (vy = sqrt(2 g 10) = 19.5)
  {
    const w = new World(testArena((b) => b.pad([0, 0, -1.2], { target: [0, 0, -60], apex: 10 })).build());
    const c = makeCmd(); c.fwd = 1;
    let n = 0; while (w.ps.grounded && n++ < 200) w.step(c);
    for (let i = 0; i < 6; i++) w.step(c);
    w.takeEvents();
    c.jump = true; w.step(c); c.jump = false;
    if (dj(w).length || w.ps.djUsed || w.ps.vel[1] < DJ_V) bad.push(`pad: the press at vy ${w.ps.vel[1].toFixed(2)} was not ignored (djUsed ${w.ps.djUsed})`);
    n = 0; while (w.ps.vel[1] > 0 && n++ < 400) w.step(c);
    c.jump = true; w.step(c); c.jump = false;
    const apex = dj(w);
    if (apex.length !== 1 || Math.abs(w.ps.vel[1] - VY_AFTER_DJ) > 1e-6) bad.push(`pad: at the apex ${apex.length} double jumps, vy ${w.ps.vel[1].toFixed(3)}`);
  }
  assert.ok(!bad.length, bad.join('; '));
});
