// The five sections that were added after the user's own part of the built-in map "Új pálya" (maps/uj-palya.js): independent checks of the
// extension (the combo gates themselves are proved by test/uj-palya-gates.mjs through run.mjs; this file does not reuse them, it asks other questions):
//   - the user's 35 blocks and the start are exactly what they were (test/uj-palya-user-part.json), the new ids are 47..67, the editor's importer
//     changes nothing in the document and the document builds;
//   - the checkpoint flow in a real World: spawns stand on a floor, the order is enforced (a later checkpoint does not count first, the finish
//     only counts after all seven), R and a fall respawn at the last checkpoint;
//   - the three shield sections (S2 a standing shield jump across, S4 straight up beside a wall, S5 the corner corridor) are not knife-edge: a human who is a bit off (0.5 m aside,
//     +-5 degrees, a 0.9 charge, late keys) still gets through at least some of the time; and their "no single technique" deny search also holds with
//     lanes (+-2 m) from other starting points (margin 0.6 m on S4, the gates' own; a wider 0.8 m on S5);
//   - BUG cases (they assert the wanted behaviour and FAIL until the map is fixed);
//   - the user's own 11 m climb (platform 2 -> the strip at y 12) is possible: shield jump + double jump + a SECOND blast at the wall + wall dodge (the double jump after it is gone since SIM_VER 5);
//   - the editor copy in the git-ignored local-maps/ (only when the folder is there).
// Geometry is read from the document by item id (G3 55, W4 57, G4 58, G5 66, cp 47 48 49 51 54 56 59, finish 67), so lifting a platform by a few
// centimetres does not break these cases.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, assert } from './harness.mjs';
import { MAPS } from '../maps/index.js';
import ujPalya from '../maps/uj-palya.js';
import { World } from '../sim/world.js';
import { makeCmd, hullSolid } from '../sim/pmove.js';
import { R } from '../sim/bot.js';
import { fwdOf } from '../sim/math.js';
import { HULL_HX } from '../sim/const.js';
import { importDoc, serialise, validate } from '../editor/model.js';
import { toDef } from '../editor/convert.js';
import { play, checkGate } from './gates.mjs';

const DEG = Math.PI / 180;
const dir = (name) => fileURLToPath(new URL(name, import.meta.url));
const USER_PART = JSON.parse(readFileSync(dir('./uj-palya-user-part.json'), 'utf8'));
const item = (id) => ujPalya.items.find((i) => i.id === id);
const topOf = (it) => it.c[1] + it.size[1] / 2;
const landingGoal = (id) => { const it = item(id), t = topOf(it); return { min: [it.c[0] - it.size[0] / 2, t - 0.1, it.c[2] - it.size[2] / 2], max: [it.c[0] + it.size[0] / 2, t + 2.5, it.c[2] + it.size[2] / 2] }; };
const idle = () => makeCmd();
const settle = (w, n = 3) => { for (let i = 0; i < n; i++) w.step(idle()); };
const buildMap = () => MAPS.get('uj-palya').build();
const JIT = { press: 3, aim: 2 };   // the gates' own "sloppy human"

// ---------------------------------------------------------------- the document
test('uj-palya extension: the user\'s 35 blocks and the start are exactly what they were; the new items are ids 47..67 (7 checkpoints, 1 finish, 13 blocks), nextId 68', () => {
  assert.equal(USER_PART.items.length, 35);
  assert.equal(JSON.stringify(ujPalya.items.slice(0, 35)), JSON.stringify(USER_PART.items), 'the user\'s items differ (key order counts)');
  assert.equal(JSON.stringify(ujPalya.start), JSON.stringify(USER_PART.start));
  const added = ujPalya.items.slice(35);
  assert.deepEqual(added.map((i) => i.id), Array.from({ length: 21 }, (_, k) => 47 + k));
  assert.equal(new Set(ujPalya.items.map((i) => i.id)).size, ujPalya.items.length, 'ids are unique');
  assert.equal(added.filter((i) => i.t === 'cp').length, 7);
  assert.equal(added.filter((i) => i.t === 'finish').length, 1);
  assert.equal(added.filter((i) => i.t === 'block').length, 13);
  assert.equal(ujPalya.nextId, 68, 'the next id the editor hands out must not collide');
  assert.ok(ujPalya.nextId > Math.max(...ujPalya.items.map((i) => i.id)));
  assert.equal(ujPalya.id, 'mvbb58w0es'); assert.equal(ujPalya.name, 'Új pálya');
});

test('uj-palya extension: the editor\'s importer (object and text) changes no item, toDef builds it, every block is a brush of its item, the editor finds no error or warning (spawns are not in a wall)', () => {
  for (const [how, input] of [['object', JSON.parse(JSON.stringify(ujPalya))], ['text', serialise(ujPalya)]]) {
    const r = importDoc(input);
    assert.ok(r.doc, `${how}: ${r.error}`);
    assert.equal(JSON.stringify(r.doc.items), JSON.stringify(ujPalya.items), `${how}: the importer rounded / clamped / reordered something`);
    assert.equal(r.doc.nextId, 68);
    assert.deepEqual(r.doc.start, ujPalya.start);
  }
  const { def, brushItem } = toDef(importDoc(ujPalya).doc);
  const map = def.build();
  const solid = ujPalya.items.filter((i) => i.t === 'block');
  assert.equal(map.brushes.length, solid.length, 'one brush per block');
  assert.deepEqual(brushItem.filter((x) => x).sort((a, b) => a - b), solid.map((i) => i.id).sort((a, b) => a - b));
  assert.equal(map.checkpoints.length, 7);
  assert.ok(map.finish);
  const v = validate(importDoc(ujPalya).doc, new World(map));
  assert.deepEqual(v, { errors: [], warnings: [] });
});

// ---------------------------------------------------------------- checkpoint flow in a real World
test('uj-palya extension: every checkpoint respawn point stands on a floor (grounded within a few ticks, hull not in solid, feet inside its own box) and faces the way on', () => {
  const map = buildMap();
  const cps = map.checkpoints;
  assert.equal(cps.length, 7);
  for (const [i, c] of cps.entries()) {
    const w = new World(map);
    w.teleport(c.spawn, c.yaw * DEG);
    settle(w, 4);
    const p = w.ps.pos;
    assert.ok(w.ps.grounded, `${c.label}: not grounded at ${p}`);
    assert.ok(!hullSolid(w.cw, p), `${c.label}: inside solid`);
    assert.ok(Math.abs(p[1] - c.spawn[1]) < 0.05, `${c.label}: the spawn floats / sinks (${c.spawn[1]} -> ${p[1]})`);
    assert.ok(p[0] >= c.min[0] && p[0] <= c.max[0] && p[2] >= c.min[2] && p[2] <= c.max[2], `${c.label}: the spawn is outside its own box`);
    // the way on: from the second checkpoint on, the respawn view looks (within 60 degrees) toward the next checkpoint / the finish
    if (i >= 1) {
      const to = i < 6 ? cps[i + 1].spawn : [(map.finish.min[0] + map.finish.max[0]) / 2, 0, (map.finish.min[2] + map.finish.max[2]) / 2];
      const dx = to[0] - c.spawn[0], dz = to[2] - c.spawn[2], f = fwdOf(c.yaw * DEG);
      const cos = (f[0] * dx + f[2] * dz) / Math.hypot(dx, dz);
      assert.ok(cos > Math.cos(60 * DEG), `${c.label}: faces away from the way on (yaw ${c.yaw}, cos ${cos.toFixed(2)})`);
    }
  }
});

test('uj-palya extension: touching cp1..cp7 in order advances cpIndex 1..7 and moves the respawn; a later checkpoint first (or skipping one) does not count; the finish counts only after all seven', () => {
  const map = buildMap();
  const cps = map.checkpoints, fin = map.finish;
  const finPos = [(fin.min[0] + fin.max[0]) / 2, fin.min[1], (fin.min[2] + fin.max[2]) / 2];
  const at = (w, p) => { w.teleport(p, 0); settle(w); };
  // skipping: cp5 on a fresh run, then cp1, then cp3 (cp2 missing), then the finish
  const s = new World(map);
  s.restart({ silent: true });
  at(s, cps[4].spawn); assert.equal(s.cpIndex, 0, 'cp5 first must not count');
  at(s, cps[0].spawn); assert.equal(s.cpIndex, 1);
  at(s, cps[2].spawn); assert.equal(s.cpIndex, 1, 'cp3 without cp2 must not count');
  at(s, finPos); assert.equal(s.finished, false, 'the finish without the checkpoints must not count');
  at(s, cps[1].spawn); assert.equal(s.cpIndex, 2);
  // in order, with the respawn following and the finish held back until the last one
  const w = new World(map);
  w.restart({ silent: true });
  for (const [i, c] of cps.entries()) {
    at(w, finPos); assert.equal(w.finished, false, `the finish counted with only ${i} checkpoints`);
    at(w, c.spawn);
    assert.equal(w.cpIndex, i + 1, `after ${c.label}`);
    assert.deepEqual(w.spawn.pos, c.spawn, 'the respawn moved to the checkpoint just reached');
    assert.equal(w.splits.length, i + 1);
  }
  assert.equal(w.finished, false);
  at(w, finPos);
  assert.equal(w.finished, true, 'the finish after all seven');
  assert.ok(w.finishTicks !== null);
});

test('uj-palya extension: R (manual respawn) at each checkpoint puts the player back on that checkpoint\'s spawn, grounded; a fall into the void respawns there too (before cp1: at the start)', () => {
  const map = buildMap();
  const w = new World(map);
  w.restart({ silent: true });
  const R_ = () => { const c = idle(); c.respawn = true; w.step(c); w.step(idle()); w.step(idle()); };
  const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 0.05;
  // a fall before any checkpoint: the start (the deaths count)
  w.teleport([-60, -300, 0], 0); w.step(idle());
  assert.equal(w.deaths, 1);
  settle(w, 2);
  assert.ok(near(w.ps.pos, map.start.pos), `void before cp1 -> ${w.ps.pos}`);
  for (const [i, c] of map.checkpoints.entries()) {
    w.teleport(c.spawn, 0); settle(w);
    assert.equal(w.cpIndex, i + 1);
    w.teleport([c.spawn[0] + 1.5, c.spawn[1] + 6, c.spawn[2] + 1.5], 0);   // somewhere in the air above
    R_();
    assert.ok(near(w.ps.pos, c.spawn) && w.ps.grounded, `R at ${c.label} -> ${w.ps.pos}`);
  }
  const c3 = map.checkpoints[2];
  const w2 = new World(map);
  w2.restart({ silent: true });
  for (let i = 0; i < 3; i++) { w2.teleport(map.checkpoints[i].spawn, 0); settle(w2); }
  w2.teleport([c3.spawn[0], -300, c3.spawn[2]], 0); w2.step(idle());
  assert.equal(w2.deaths, 1);
  settle(w2, 2);
  assert.ok(near(w2.ps.pos, c3.spawn), `a fall after cp3 -> ${w2.ps.pos}`);
});

// ---------------------------------------------------------------- the hard sections with a human who is a bit off
// S4: cp6 (the platform G3) -> G4, 9 m up: stand against the wall W4 facing the ledge, floor blast straight down + double jump, wall dodge away from the wall (a second double jump no longer exists: once per airtime).
const G3 = item(55), W4 = item(57), G4 = item(58), G5 = item(66);
const w4Face = W4.c[2] + W4.size[2] / 2;
const standZ = w4Face + HULL_HX + 0.15;   // 0.15 m off the wall: where the bot stands
const s4Steps = ({ x = G3.c[0], z = standZ, yaw = 180, pitch = -89, charge = 1, gap = 0, steer = 5, dj = true } = {}) => [
  R.run(x, z, { tol: 0.1, stop: true }),
  R.shieldJump({ charge, yaw, pitch, gap, to: [G4.c[0], topOf(G4), G4.c[2] - 2], steer, air: dj ? [R.doubleJump('apex'), R.wallDodge(180, { at: 'apex' })] : [] }),
];
// S5: cp7 (G4) -> G5: a running shield jump (the gun charged standing first, released at the lip) down the corridor, wall dodge sideways at the wall F, the (still unused) double jump through the opening.
const s5Steps = ({ x = G4.c[0], pitch = -50, charge = 1, lead, gap = 0 } = {}) => [
  R.run(x, G4.c[2] - G4.size[2] / 2 + 0.5, { tol: 0.3 }),
  R.charge(true, { to: 1 }),   // (a full gun takes 1.25 s: charged standing, then run)
  R.shieldJump({ push: [x, 250], run: [x, 250], pitch, charge, gap, lead, to: [G4.c[0], topOf(G5), G5.c[2] + 2], edge: true, air: [R.wallDodge(-90, { at: 'wall' }), R.doubleJump('apex')] }),
];

function tries(map, startCp, steps, goalId, jitter, seeds = [1, 2, 3]) {
  const w = new World(map), c = map.checkpoints[startCp], g = { goal: landingGoal(goalId) };
  let ok = 0;
  for (const seed of seeds) if (play(w, g, c.spawn, c.yaw, steps, { jitter, seed }).reached) ok++;
  return ok;
}

// S2: cp4 (P1) -> G2, 11 m across and 4 m up: a standing full shield jump back and down (the push toward G2) + the double jump at the apex (the shield section since SIM_VER 5).
const P1 = item(50), G2 = item(53);
const s2Steps = ({ pitch = -70, charge = 1, gap = 0 } = {}) => [R.shieldJump({ push: [-250, P1.c[2]], pitch, charge, gap, to: [G2.c[0], topOf(G2), P1.c[2]], dj: 'apex' })];
test('S2 (a standing shield jump + double jump, 11 m across and 4 m up) is not knife-edge: stand anywhere along P1 (0.5 m from its ends), pitch -55 / -80, a 0.9 charge, jump and release 3 ticks apart either way, keys 9 ticks late - each variant lands on G2 in at least one of three tries, and most do', () => {
  const map = buildMap();
  const w = new World(map), c = map.checkpoints[3], g = { goal: landingGoal(53) };
  const variants = {
    'bot spot': [{}, null], 'x -74.5': [{}, -74.5], 'x -80.5': [{}, -80.5], 'x -79': [{}, -79], 'pitch -55': [{ pitch: -55 }, null], 'pitch -80': [{ pitch: -80 }, null],
    'charge 0.9': [{ charge: 0.9 }, null], 'gap +3': [{ gap: 3 }, null], 'gap -3': [{ gap: -3 }, null], 'keys 9 ticks late': [{}, null, { press: 9, aim: 5 }],
  };
  const res = {};
  let sum = 0;
  for (const [name, [o, x, jit]] of Object.entries(variants)) {
    const pos = x === null ? c.spawn : [x, c.spawn[1], c.spawn[2]];
    res[name] = [1, 2, 3].filter((seed) => play(w, g, pos, c.yaw, s2Steps(o), { jitter: jit || JIT, seed }).reached).length;
    sum += res[name];
  }
  const bad = Object.entries(res).filter(([, k]) => k === 0).map(([n]) => n);
  assert.deepEqual(bad, [], `no success at all: ${bad.join(', ')} (${JSON.stringify(res)})`);
  assert.ok(sum >= 0.6 * 3 * Object.keys(variants).length, `only ${sum} of ${3 * Object.keys(variants).length}: ${JSON.stringify(res)}`);
});

test('S4 (straight up, 9 m) is not knife-edge: stand 0.5 m aside, +-5 degrees, a pitch of -80, a 0.95 charge (released a hair early), standing 0.45 m further from the wall - each variant still gets onto the ledge in at least one of three sloppy tries, and most do', () => {
  const map = buildMap();
  const variants = {
    'bot spot': {}, 'x +0.5': { x: G3.c[0] + 0.5 }, 'x -0.5': { x: G3.c[0] - 0.5 }, 'yaw 175': { yaw: 175 }, 'yaw 185': { yaw: 185 },
    'pitch -80': { pitch: -80 }, 'charge 0.95': { charge: 0.95 }, 'z +0.45 (further from the wall)': { z: standZ + 0.45 },
  };
  const res = {};
  let sum = 0;
  for (const [name, o] of Object.entries(variants)) { res[name] = tries(map, 5, s4Steps(o), 58, JIT); sum += res[name]; }
  const bad = Object.entries(res).filter(([, k]) => k === 0).map(([n]) => n);
  assert.deepEqual(bad, [], `no success at all: ${bad.join(', ')} (${JSON.stringify(res)})`);
  assert.ok(sum >= 0.6 * 3 * Object.keys(variants).length, `only ${sum} of ${3 * Object.keys(variants).length}: ${JSON.stringify(res)}`);
});

test('S5 (corner corridor) is not knife-edge: another lane (+-0.5 m), pitch -45 / -60, released 8 ticks early, jump and release 3 ticks apart either way, keys 9 ticks late - each variant gets to G5 in at least one of three tries, and most do', () => {
  const map = buildMap();
  const variants = {
    'bot': [s5Steps(), JIT], 'lane +0.5': [s5Steps({ x: G4.c[0] + 0.5 }), JIT], 'lane -0.5': [s5Steps({ x: G4.c[0] - 0.5 }), JIT], 'pitch -45': [s5Steps({ pitch: -45 }), JIT],
    'pitch -60': [s5Steps({ pitch: -60 }), JIT], 'early release': [s5Steps({ lead: 8 }), JIT], 'gap +3': [s5Steps({ gap: 3 }), JIT], 'gap -3': [s5Steps({ gap: -3 }), JIT],
    'keys 9 ticks late': [s5Steps(), { press: 9, aim: 5 }],
  };
  const res = {};
  let sum = 0;
  for (const [name, [steps, jit]] of Object.entries(variants)) { res[name] = tries(map, 6, steps, 66, jit); sum += res[name]; }
  const bad = Object.entries(res).filter(([, k]) => k === 0).map(([n]) => n);
  assert.deepEqual(bad, [], `no success at all: ${bad.join(', ')} (${JSON.stringify(res)})`);
  assert.ok(sum >= 0.6 * 3 * Object.keys(variants).length, `only ${sum} of ${3 * Object.keys(variants).length}: ${JSON.stringify(res)}`);
});

// S5 keeps a wider margin (0.8 m) than the gates' own 0.6 m. S4 (SIM_VER 4, the UT2004 shield rules): the strongest single technique, a standing full shield jump,
// now rises 9.30 m (+ the double jump 10.70 m) against the 9.25 m of G4, so ONE technique lands on the ledge: S4 is expected to FAIL the deny-all search (crossable).
// That is a fact about the map and the new physics, pinned here; raising G4 (the user's map) would make it a combo again, and this case then has to flip back.
test('S4 / S5 "no single technique": the deny-all search (all eight families) with lanes (+-2 m) finds nothing on S5 (a wider 0.8 m margin); on S4 it now finds the single full shield jump - from the checkpoint and from other starting points on the platform', () => {
  const map = buildMap();
  const cps = map.checkpoints;
  const mk = (name, pos, yaw, goalId, solve, margin, crossable = false) => ({ name, combo: '', start: { pos, yaw }, goal: landingGoal(goalId), solve, deny: 'all', spread: 2, margin, crossable });
  const gates = [
    mk('S4 cp6', cps[5].spawn, cps[5].yaw, 58, s4Steps(), 0.6, true),
    mk('S4 by the wall', [G3.c[0] + 2, topOf(G3), standZ], 180, 58, s4Steps(), 0.6, true),
    mk('S5 cp7', cps[6].spawn, cps[6].yaw, 66, s5Steps(), 0.8),
    mk('S5 back of G4', [G4.c[0] - 1, topOf(G4), G4.c[2] - G4.size[2] / 2 + 0.4], 180, 66, s5Steps(), 0.8),
  ];
  const fails = [];
  for (const g of gates) {
    const r = checkGate(map, g, { nSloppy: 0, sloppy: JIT });
    if (g.crossable) { if (r.ok || !/shield/.test(r.fail || '')) fails.push(`${g.name}: expected the single shield jump to cross, got ok=${r.ok} ${r.fail}`); continue; }
    if (!r.ok) fails.push(`${g.name}: ${r.fail}`);
    assert.ok(r.denyRuns > 900, `${g.name}: only ${r.denyRuns} deny runs`);
  }
  assert.deepEqual(fails, []);
});

// ---------------------------------------------------------------- S4: a single shield jump skips it (since SIM_VER 4)
// The shield and the jump stack when they come within COMBO_TICKS (10) of each other. With the UT2004 rules a full shield pushes at 12 m/s: a standing jump
// (release and Space together) rises 9.30 m, +1.40 m with the double jump (10.70 m); releasing 10 ticks before the Space rises higher still. G4 is 9.25 m above
// G3 (the airborne step-up of 0.37 m means feet >= 25.88 suffice), so ONE technique lands on the ledge. Under the old rules (a 9 m push, 8.66 m at best) this
// case asserted the opposite. It pins the new fact; raising G4 (the user's map) would flip it back.
test('S4 (UT shield rules): a single shield jump + double jump (release and jump up to 10 ticks apart, standing anywhere along G3) lands on the ledge G4 - known, G4 is 9.25 m up', () => {
  const map = buildMap();
  const w = new World(map);
  const g = { goal: landingGoal(58) };
  const c = map.checkpoints[5];
  const top = topOf(G4);
  const hits = [];
  let n = 0;
  for (const z of [standZ, -25, -23.5]) for (const gap of [-10, -9]) for (let steer = 0.2; steer <= 0.5001; steer += 0.05) {
    const steps = [R.run(G3.c[0], z, { tol: 0.05, stop: true }), R.shieldJump({ charge: 1, yaw: 180, pitch: -89, gap, to: [G4.c[0], top, G4.c[2] - 2], steer, dj: 'apex' })];
    const r = play(w, g, c.spawn, c.yaw, steps, { deny: true });
    n++;
    if (r.landPos && r.landPos[1] >= top - 0.1) hits.push(`stand z ${z.toFixed(2)}, release ${-gap} ticks before the jump, steer ${steer.toFixed(2)} s -> lands at ${r.landPos.map((v) => v.toFixed(2))}`);
  }
  assert.ok(n >= 40);
  assert.ok(hits.length >= 0.8 * n, `only ${hits.length} of ${n} single shield jumps land on G4 (top ${top})`);
});

// ---------------------------------------------------------------- the user's own climb (platform 2, top y 1 -> the strip, top y 12)
// raw keys: a human with the shield gun. 1st blast straight down from the floor, a double jump at the apex, a SECOND blast at the wall (charging again since the gun
// came back), a wall dodge away from the wall at the next apex, W onto the strip (a final double jump is only pressed if one is left: none is, since SIM_VER 5). Under the old shield the strip needed the second blast (the best
// without it was y 11.5, the strip needs 11.63); with the UT2004 rules (SIM_VER 4) one full shield jump + double jump released 10 ticks before the Space reaches it as well.
function climb({ gap = 0, pitch2, b, ch2 }) {
  const map = buildMap();
  const w = new World(map), ps = w.ps;
  w.teleport([2, 1, -28.0], 0);
  settle(w, 6);
  let fire = false, dj1 = null, wd = null, blast2 = null, jumped = false, air = false;
  const REL = 150;   // (a full gun: 1.25 s)
  let peak = 0;
  for (let t = 0; t < 1500; t++) {
    const cmd = makeCmd();
    cmd.yaw = 180 * DEG; cmd.pitch = -89 * DEG;
    if (t < REL) fire = true;
    if (t === REL) fire = false;
    cmd.fire = fire;
    if (t === REL + (gap < 0 ? -gap : 0) - (gap > 0 ? gap : 0)) { cmd.jump = true; jumped = true; }
    if (t > REL + 3) {
      cmd.yaw = 0; cmd.pitch = 0; cmd.fwd = 1;   // pressing into the wall
      if (t >= REL + ch2) fire = true;
      cmd.fire = fire;
      if (!ps.grounded) {
        air = true;
        if (dj1 === null && ps.vel[1] <= 0 && jumped && t > REL + 15) { cmd.jump = true; dj1 = t; }
        else if (dj1 !== null) {
          if (blast2 === null && t - dj1 === b) { cmd.yaw = 0; cmd.pitch = pitch2 * DEG; cmd.fire = false; fire = false; cmd.fwd = 0; blast2 = t; }
          if (blast2 !== null && wd === null && ps.vel[1] <= 0 && t > blast2 + 5) { cmd.yaw = 180 * DEG; cmd.pitch = 0; cmd.fwd = 0; cmd.dodge = 1; wd = t; }
          else if (wd !== null && t > wd + 5 && ps.vel[1] <= 0 && !cmd.jump && !w.ps.djUsed) cmd.jump = true;
          if (wd !== null && t > wd) { cmd.yaw = 180 * DEG; cmd.fwd = 1; }
        }
      }
    }
    w.step(cmd);
    peak = Math.max(peak, ps.pos[1]);
    if (w.deaths) return { died: true, peak };
    if (air && ps.grounded && t > REL + 10) return { land: ps.pos.slice(), peak };
  }
  return { peak };
}

test('the user\'s own climb (platform 2 -> the strip at y 12, 11 m beside the wall z -28.5) is possible: shield jump + double jump + a second blast at the wall + wall dodge lands on the strip', () => {
  const rows = [{ pitch2: -30, b: 10, ch2: 30 }, { pitch2: -30, b: 20, ch2: 60 }, { pitch2: -45, b: 30, ch2: 30 }].map((o) => ({ o, r: climb(o) }));
  const onStrip = (r) => r.land && r.land[1] > 11.9 && r.land[0] >= -1 && r.land[0] <= 5 && r.land[2] >= -26 && r.land[2] <= -20;
  assert.ok(rows.every(({ r }) => !r.died), 'died');
  assert.ok(rows.filter(({ r }) => onStrip(r)).length >= 2, JSON.stringify(rows.map(({ o, r }) => ({ ...o, peak: +r.peak.toFixed(2), land: r.land && r.land.map((v) => +v.toFixed(2)) }))));
  assert.ok(Math.max(...rows.map(({ r }) => r.peak)) > 12.5, 'the climb should clear the 12 m strip with room to spare');
});

// ---------------------------------------------------------------- the editor copy (git-ignored folder: only where it exists)
test('the editor copy local-maps/uj-palya-folytatas.json equals the installed map except name and id, and the index still lists hopphopp.json as well', () => {
  const folder = dir('../local-maps/');
  if (!existsSync(folder + 'uj-palya-folytatas.json')) { console.log('  (local-maps/uj-palya-folytatas.json is not on this machine: the editor copy is not checked)'); return; }
  const copy = JSON.parse(readFileSync(folder + 'uj-palya-folytatas.json', 'utf8'));
  assert.notEqual(copy.name, ujPalya.name);
  assert.notEqual(copy.id, ujPalya.id, 'a copy with the built-in map\'s document id would collide in Saját pályák');
  assert.match(copy.id, /^[a-z0-9_-]{1,24}$/);
  for (const k of Object.keys(ujPalya)) if (k !== 'id' && k !== 'name') assert.deepEqual(copy[k], ujPalya[k], `field ${k} differs`);
  assert.deepEqual(Object.keys(copy).sort(), Object.keys(ujPalya).sort());
  assert.equal(importDoc(copy).doc.items.length, ujPalya.items.length);
  const index = JSON.parse(readFileSync(folder + 'index.json', 'utf8'));
  assert.equal(index.v, 1);
  assert.ok(index.maps.includes('uj-palya-folytatas.json'));
  if (existsSync(folder + 'hopphopp.json')) assert.ok(index.maps.includes('hopphopp.json'), 'hopphopp.json fell out of the index');
  assert.equal(new Set(index.maps).size, index.maps.length);
});
