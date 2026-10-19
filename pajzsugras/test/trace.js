// Unit checks of the collision + movement core: rest, sliding, steps, slopes, creases, tunnelling, penetration recovery,
// mover carry. Each check returns { name, ok, detail }.
import { World } from '../sim/world.js';
import { defineMap } from '../sim/builder.js';
import { GhostRecorder, encodeGhost, decodeGhost, ghostAt, toB64, fromB64 } from '../sim/ghost.js';
import { makeCmd } from '../sim/pmove.js';
import { CollisionWorld } from '../sim/trace.js';
import { makeBrush } from '../sim/brush.js';
import { mulberry32 } from '../sim/math.js';
import { TICK, G, HULL_HX, HULL_HY, DODGE, JUMP_V, DJ_V, DODGE_XY, DODGE_Y, DODGE_CD, RUN, SH_IMIN, SH_IMAX, SH_LOCK } from '../sim/const.js';
import { testArena } from './probes.js';

const mk = (fn, start = [0, 0, 0], yaw = 0) => {
  const def = testArena((b) => { fn && fn(b); });
  const w = new World(def.build());
  w.teleport(start, yaw);
  return w;
};
const run = (w, cmd, ticks, each) => { for (let i = 0; i < ticks; i++) { w.step(cmd); if (each) each(i); } };
const cmdOf = (o) => Object.assign(makeCmd(), o);
const f = (v, d = 3) => v.toFixed(d);

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('rest on the floor for 10 000 ticks', () => {
  const w = mk();
  const c = makeCmd();
  let lo = Infinity, hi = -Infinity;
  run(w, c, 10000, () => { lo = Math.min(lo, w.ps.pos[1]); hi = Math.max(hi, w.ps.pos[1]); });
  return { ok: w.ps.grounded && hi - lo < 1e-4 && Math.abs(w.ps.vel[1]) < 1e-6, detail: `y ${f(lo, 5)}..${f(hi, 5)}` };
});

test('sliding along a wall keeps the tangent speed', () => {
  // wall at x = 6 (face toward -x); run diagonally into it: heading 45° between -z and +x
  const w = mk((b) => b.box([6, 0, -300], [8, 10, 300], { mat: 'wall' }), [0, 0, 0], -Math.PI / 4);
  run(w, cmdOf({ fwd: 1, yaw: -Math.PI / 4 }), 360);
  const vz = w.ps.vel[2], vx = w.ps.vel[0];
  const tangent = Math.abs(vz), expected = 8.8 * Math.SQRT1_2;   // the wall-parallel part of a 45° run
  return { ok: tangent > expected * 0.95 && tangent < 8.81 && Math.abs(vx) < 0.05 && w.ps.pos[0] < 5.6 + 0.01, detail: `v=(${f(vx)}, ${f(vz)}) x=${f(w.ps.pos[0])}` };
});

const stepWalk = (h) => {
  const w = mk((b) => b.box([-5, 0, -30], [5, h, -10], { mat: 'floor' }), [0, 0, 0], 0);
  run(w, cmdOf({ fwd: 1, yaw: 0 }), 360);   // run -z into the step for 3 s
  return w;
};
test('step of 0.35 m is walked up', () => {
  const w = stepWalk(0.35);
  return { ok: w.ps.pos[2] < -12 && Math.abs(w.ps.pos[1] - 0.351) < 0.01 && w.ps.grounded, detail: `z=${f(w.ps.pos[2])} y=${f(w.ps.pos[1])}` };
});
test('step of 0.40 m blocks', () => {
  const w = stepWalk(0.40);
  return { ok: w.ps.pos[2] > -9.61 && w.ps.pos[1] < 0.01 && w.ps.grounded, detail: `z=${f(w.ps.pos[2])} y=${f(w.ps.pos[1])}` };
});

const slope = (deg) => {
  const rise = 6, run_ = rise / Math.tan((deg * Math.PI) / 180);
  // ramp rising toward -z: local +z rises, so yaw 180 turns it to rise toward -z; low edge at z = -10
  return (b) => b.ramp([0, rise / 2, -10 - run_ / 2], [10, rise, run_], { mat: 'floor', yaw: 180 });
};
test('45° ramp is walkable', () => {
  const w = mk(slope(45), [0, 0, 0], 0);
  let maxY = 0, groundedUp = false;
  run(w, cmdOf({ fwd: 1, yaw: 0 }), 600, () => { maxY = Math.max(maxY, w.ps.pos[1]); if (w.ps.grounded && w.ps.pos[1] > 3) groundedUp = true; });
  return { ok: maxY > 5.5 && groundedUp, detail: `reached y=${f(maxY)} (top at 6), stood on it: ${groundedUp}` };
});
test('50° ramp slides (cannot be climbed, nothing stands on it)', () => {
  const w = mk(slope(50), [0, 0, 0], 0);
  let maxY = 0;
  let onSlope = false;
  run(w, cmdOf({ fwd: 1, yaw: 0 }), 600, () => { maxY = Math.max(maxY, w.ps.pos[1]); if (w.ps.grounded && w.ps.pos[1] > 0.5) onSlope = true; });
  // and one placed on the slope slides down
  const w2 = mk(slope(50), [0, 0, 0], 0);
  const y0 = 3.05;
  w2.teleport([0, y0, -12.5], 0);   // the surface is at 2.98 there
  run(w2, makeCmd(), 240);
  return { ok: maxY < 3 && !onSlope && w2.ps.pos[1] < 0.5, detail: `walking up: max y ${f(maxY)}; placed on the slope at y ${y0}: after 2 s y=${f(w2.ps.pos[1])}, z=${f(w2.ps.pos[2])}` };
});

test('corner crease: no sticking, walks out at once', () => {
  // inside corner of two walls (x = 4 and z = -8), run diagonally into it, then back out
  const w = mk((b) => { b.box([4, 0, -40], [6, 10, 40], { mat: 'wall' }); b.box([-40, 0, -10], [40, 10, -8], { mat: 'wall' }); }, [0, 0, 0], -Math.PI / 4);
  run(w, cmdOf({ fwd: 1, yaw: -Math.PI / 4 }), 360);
  const inCorner = w.ps.pos[0] > 3.5 && w.ps.pos[2] < -7.5;
  let ok = inCorner && w.ps.vel.every(Number.isFinite);
  const p0 = w.ps.pos.slice();
  run(w, cmdOf({ fwd: 1, yaw: Math.PI * 0.75 }), 30);   // turn around, run back out
  const out = Math.hypot(w.ps.pos[0] - p0[0], w.ps.pos[2] - p0[2]);
  ok = ok && out > 0.9;
  return { ok, detail: `corner at (${f(p0[0])}, ${f(p0[2])}), 0.25 s later moved ${f(out)} m out` };
});

test('200 random 50 m/s sweeps into a 0.1 m wall never tunnel', () => {
  const rng = mulberry32(777);
  let bad = 0;
  for (let n = 0; n < 200; n++) {
    const w = mk((b) => b.box([-100, 0, -0.05], [100, 40, 0.05], { mat: 'wall' }), [0, 0, 0], 0);
    const ang = (rng() - 0.5) * Math.PI * 0.8;   // up to 72° off the normal
    const px = (rng() - 0.5) * 20, py = 1 + rng() * 20;
    w.ps.pos = [px, py, 9]; w.ps.prevPos = w.ps.pos.slice(); w.ps.lastGood = w.ps.pos.slice();
    w.ps.vel = [50 * Math.sin(ang), (rng() - 0.5) * 10, -50 * Math.cos(ang)];
    w.ps.grounded = false;
    for (let i = 0; i < 60; i++) {
      w.step(makeCmd());
      if (w.deaths) break;
      if (w.ps.pos[2] < 0.44) { bad++; break; }   // the hull centre can never be nearer than 0.4 + 0.05 to the wall axis
    }
  }
  return { ok: bad === 0, detail: `${bad} of 200 got through` };
});

test('traceBox: 5000 random sweeps across a thin brush always stop in front', () => {
  const rng = mulberry32(4242);
  const cw = new CollisionWorld([makeBrush({ kind: 'block', c: [0, 0, 0], size: [20, 20, 0.1], yaw: 0 })]);
  let bad = 0;
  for (let i = 0; i < 5000; i++) {
    const a = [(rng() - 0.5) * 8, (rng() - 0.5) * 8, 2 + rng() * 3];
    const b = [a[0] + (rng() - 0.5) * 6, a[1] + (rng() - 0.5) * 6, -2 - rng() * 3];
    const tr = cw.traceBox(a, b, [HULL_HX, HULL_HY, HULL_HX]);
    if (!(tr.fraction < 1) || tr.endpos[2] < 0.05) bad++;
  }
  return { ok: bad === 0, detail: `${bad} of 5000 passed or ended behind` };
});

test('start-solid recovery (0.02 and 0.06 m inside a block)', () => {
  let ok = true, detail = '';
  for (const pen of [0.02, 0.06]) {
    const w = mk((b) => b.box([4, 0, -4], [8, 3, 4], { mat: 'wall' }), [0, 0, 0], 0);
    w.teleport([4 - HULL_HX + pen, 0, 0], 0);   // the hull overlaps the face by `pen`
    w.ps.grounded = false;
    run(w, makeCmd(), 4);
    const solid = w.cw.testSolid([w.ps.pos[0], w.ps.pos[1] + HULL_HY, w.ps.pos[2]], [HULL_HX, HULL_HY, HULL_HX]);
    ok = ok && !solid && w.deaths === 0;
    detail += `pen ${pen}: x=${f(w.ps.pos[0])} solid=${solid}  `;
  }
  return { ok, detail };
});

test('mover cycle: carry without drift', () => {
  const def = testArena((b) => {
    b.mover('lift', { path: [[0, 4, 0], [6, 4, 0]], speed: 2, wait: 0.5 }, () => { b.box([-2, 1.5, -2], [2, 2, 2], { mat: 'floor' }); });
  });
  const w = new World(def.build());
  w.teleport([0, 2, 0], 0);
  // the lift sits at the start offset, floor top at y = 0 -> standing on it; hold still, the clock starts on first input
  const c = cmdOf({ fwd: 0, jump: false });
  w.startClock();
  const m = w.movers[0];
  const rel0 = [w.ps.pos[0] - m.offset[0], w.ps.pos[1] - m.offset[1], w.ps.pos[2] - m.offset[2]];
  const cyc = m.cycle.total;
  run(w, c, cyc * 6);   // six full cycles
  const rel = [w.ps.pos[0] - m.offset[0], w.ps.pos[1] - m.offset[1], w.ps.pos[2] - m.offset[2]];
  const drift = Math.hypot(rel[0] - rel0[0], rel[1] - rel0[1], rel[2] - rel0[2]);
  const back = Math.hypot(...m.offset);
  return { ok: drift < 1e-3 && back < 1e-9 && w.ps.grounded, detail: `drift ${drift.toExponential(2)} m after 6 cycles (${(cyc / TICK).toFixed(1)} s each), offset error ${back.toExponential(1)}` };
});

test('mover push: a platform carries a player sideways into a wall without clipping', () => {
  const def = testArena((b) => {
    b.box([6, 0, -4], [8, 6, 4], { mat: 'wall' });
    b.mover('m', { path: [[8, 0, 0]], speed: 3, wait: 0 }, () => { b.box([-2, 1.5, -2], [2, 2, 2], { mat: 'floor' }); });
  });
  const w = new World(def.build());
  w.teleport([0, 2, 0], 0);
  w.startClock();
  let solid = false;
  run(w, makeCmd(), 600, () => { if (w.cw.testSolid([w.ps.pos[0], w.ps.pos[1] + HULL_HY, w.ps.pos[2]], [HULL_HX, HULL_HY, HULL_HX])) solid = true; });
  return { ok: !solid && w.ps.pos[0] <= 6 - HULL_HX + 0.01, detail: `x=${f(w.ps.pos[0])} (wall face at 6), inside solid: ${solid}` };
});

// ---------- rules of the movement and of the run ----------
const upto = (w, cmd, pred, max = 1200) => { for (let i = 0; i < max; i++) { w.step(cmd); if (pred()) return i + 1; } return -1; };

test('dodge: 13.2 m/s, then a 0.35 s cooldown after landing', () => {
  const w = mk();
  const c = cmdOf({ dodge: DODGE.F });
  w.step(c);
  const v = Math.hypot(w.ps.vel[0], w.ps.vel[2]);
  c.dodge = 0;
  const n = upto(w, c, () => w.ps.grounded);
  c.dodge = DODGE.F; w.step(c);   // right after landing: refused
  const blocked = w.ps.grounded;
  c.dodge = 0;
  for (let i = 0; i < Math.round(DODGE_CD * TICK); i++) w.step(c);
  c.dodge = DODGE.F; w.step(c);
  const again = !w.ps.grounded;
  return { ok: Math.abs(v - DODGE_XY) < 0.1 && n > 0 && blocked && again, detail: `speed ${f(v, 2)}, landed after ${n} ticks, refused right after landing: ${blocked}, allowed after the cooldown: ${again}` };
});

test('double jump: second press in the air, not a third; a new airtime restores it', () => {
  const w = mk();
  const c = makeCmd();
  c.jump = true; w.step(c); c.jump = false;
  upto(w, c, () => w.ps.vel[1] < 1);
  c.jump = true; w.step(c); c.jump = false; const vy1 = w.ps.vel[1];
  upto(w, c, () => w.ps.vel[1] < 1);
  c.jump = true; w.step(c); c.jump = false; const vy2 = w.ps.vel[1];
  upto(w, c, () => w.ps.grounded);
  c.jump = true; w.step(c); c.jump = false;   // a new airtime: a ground jump again
  const vy3 = w.ps.vel[1];
  return { ok: vy1 > DJ_V - 0.4 && vy2 < 1 && vy3 > JUMP_V - 0.3, detail: `vy after the double jump ${f(vy1, 2)}, after a third press ${f(vy2, 2)}, next ground jump ${f(vy3, 2)}` };
});

test('wall dodge: needs a wall within 0.64 m (WALL_RANGE), once per airtime', () => {
  const noWall = mk();
  const c = makeCmd();
  c.jump = true; noWall.step(c); c.jump = false; for (let i = 0; i < 10; i++) noWall.step(c);
  c.dodge = DODGE.F; noWall.step(c); c.dodge = 0;
  const none = noWall.ps.dodging;
  const w = mk((b) => b.box([-20, 0, -12], [20, 20, -10], { mat: 'wall' }), [0, 0, -9.5], Math.PI);
  c.yaw = Math.PI;   // looking away from the wall
  c.jump = true; w.step(c); c.jump = false; for (let i = 0; i < 10; i++) w.step(c);
  c.dodge = DODGE.F; w.step(c); const first = w.ps.dodging && w.ps.wallUsed; const v1 = w.ps.speed; c.dodge = 0;
  for (let i = 0; i < 10; i++) w.step(c);
  const vBefore = w.ps.speed;
  c.dodge = DODGE.B; w.step(c); c.dodge = 0;   // a second one: refused (no speed jump)
  return { ok: !none && first && Math.abs(v1 - DODGE_XY) < 0.5 && Math.abs(w.ps.speed - vBefore) < 0.5, detail: `without a wall: dodged=${none}; with a wall: dodged=${first}, speed ${f(v1, 2)}` };
});

// a wall dodge sets vy = DODGE_Y and nothing right after it may lift it back through the jump / shield combo windows (COMBO_TICKS)
const wallDodgeWorld = () => {
  const w = mk((b) => b.box([-40, 0, -12], [40, 40, -10], { mat: 'wall' }), [0, 0, -9.55], 0);   // pressed against the wall, facing it
  const c = makeCmd();
  run(w, c, 30);
  return { w, c };
};
test('wall dodge: a shield release within COMBO_TICKS of the jump adds the blast to the fixed wall dodge height, it does not lift it back to JUMP_V first', () => {
  const { w, c } = wallDodgeWorld();
  c.fire = true; run(w, c, 20); c.pitch = -1.4;   // a charge (a tap: under SH_MIN_HOLD), aimed at the floor under the feet
  c.jump = true; w.step(c); c.jump = false; run(w, c, 2);
  c.dodge = DODGE.B; w.step(c); c.dodge = 0;   // away from the wall behind: a wall dodge
  const walled = w.ps.wallUsed, vy0 = w.ps.vel[1];
  c.fire = false; w.step(c);   // released 4 ticks after the jump
  const gain = w.ps.vel[1] - vy0, push = SH_IMIN * Math.sin(1.4);   // (a hold under SH_MIN_HOLD: the tap push, along the aim 1.4 rad down)
  return { ok: walled && Math.abs(vy0 - DODGE_Y) < 0.2 && Math.abs(gain - push) < 0.3 && w.ps.vel[1] < DODGE_Y + push + 0.3, detail: `wall dodge vy ${f(vy0, 3)}, after the release ${f(w.ps.vel[1], 3)} (the blast alone adds ${f(gain, 2)}, expected ${f(push, 2)}; the old lift to JUMP_V first would end at ${f(JUMP_V + gain, 2)})` };
});
test('wall dodge: a Space within COMBO_TICKS of a shield launch from the floor is the plain double jump (DJ_V), not the launch + JUMP_V combo', () => {
  const { w, c } = wallDodgeWorld();
  c.fire = true; run(w, c, 20); c.pitch = -1.4;
  c.fire = false; w.step(c);   // a shield launch from the floor
  const launched = w.ps.blastGround;
  c.dodge = DODGE.B; w.step(c); c.dodge = 0;
  c.jump = true; w.step(c); c.jump = false;
  return { ok: launched && w.ps.wallUsed && Math.abs(w.ps.vel[1] - DJ_V) < 0.3, detail: `vy after the Space ${f(w.ps.vel[1], 3)} (DJ_V ${DJ_V})` };
});

test('shield: a blast into thin air does nothing; one at the floor launches', () => {
  const w = mk();
  const c = makeCmd(); c.fire = true;
  for (let i = 0; i < 30; i++) w.step(c);
  c.fire = false; w.step(c);   // aimed level: nothing within 2.24 m (flat floor, no walls)
  const none = w.ps.vel[1];
  c.fire = false; run(w, c, 80);   // (a blast into thin air spends the shot too: the gun is dead for 0.6 s)
  c.fire = true; c.pitch = -1.5; for (let i = 0; i < 40; i++) w.step(c);
  c.fire = false; w.step(c);
  return { ok: Math.abs(none) < 0.01 && w.ps.vel[1] > 3, detail: `level blast vy ${f(none, 3)}, downward blast vy ${f(w.ps.vel[1], 2)}` };
});

// ---- the UT2004 shield gun rules (SIM_VER 4): push by the hold time, the ray from the body centre, the lift on the ground, the halving above 7.6 m/s
const DOWN = -89 * Math.PI / 180;
test('shield (UT2004): the push is 7.8 m/s for any hold up to 0.2 s and grows to 12 m/s at 1.25 s: standing straight down it lifts the feet 1.60 m (tap) .. 3.79 m (full)', () => {
  const rise = (hold) => {
    const w = mk(), c = cmdOf({ fire: true, pitch: DOWN });
    run(w, c, hold); c.fire = false;
    let top = 0; run(w, c, 300, () => { top = Math.max(top, w.ps.pos[1]); });
    return top;
  };
  const [tap, edge, mid, full] = [1, 24, 75, 150].map(rise), g = (m) => (m * m) / (2 * G);   // (75 ticks = 0.625 s: m = 7.8 + 4.2 · 0.425 / 1.05)
  return { ok: Math.abs(tap - 1.60) < 0.02 && Math.abs(edge - tap) < 0.005 && Math.abs(mid - g(7.8 + (4.2 * 0.425) / 1.05) * Math.sin(DOWN) ** 2) < 0.03 && Math.abs(full - 3.79) < 0.02, detail: `tap ${f(tap, 3)}, 0.2 s ${f(edge, 3)}, 0.625 s ${f(mid, 3)}, full ${f(full, 3)}` };
});
test('shield (UT2004): the ray is 2.24 m long and starts at the body centre: aimed straight down it hits the floor from the jump apex (feet 1.22 m up) but not from a double jump apex (feet 2.6 m up)', () => {
  const blastAt = (doubleJump) => {
    const w = mk(), c = cmdOf({ fire: true, pitch: DOWN });
    run(w, c, 20);
    c.jump = true; w.step(c); c.jump = false;
    upto(w, c, () => w.ps.vel[1] <= 0);
    if (doubleJump) { c.jump = true; w.step(c); c.jump = false; upto(w, c, () => w.ps.vel[1] <= 0); }
    w.takeEvents();
    c.fire = false; w.step(c);
    return w.takeEvents().find((e) => e.type === 'blast').hit;
  };
  const low = blastAt(false), high = blastAt(true);
  return { ok: low === true && high === false, detail: `from the jump apex hit=${low}, from the double jump apex hit=${high}` };
});
test('shield (UT2004): on the ground a level shot at a wall lifts (vy >= 0.4 of the push) and leaves the ground; in the air the same shot gives no lift', () => {
  const wall = (b) => b.box([-20, 0, -4], [20, 20, -2.1], { mat: 'wall' });   // the wall face 2.1 m ahead
  const shot = (airborne) => {
    const w = mk(wall), c = cmdOf({ fire: true });
    run(w, c, 10);
    if (airborne) { c.jump = true; run(w, c, 1); c.jump = false; run(w, c, 30); c.fire = true; run(w, c, 10); }   // (a jump long enough ago to be out of the combo window)
    const vy0 = w.ps.vel[1];
    c.fire = false; w.step(c);
    return { dvy: w.ps.vel[1] - vy0, vz: w.ps.vel[2], air: !w.ps.grounded };
  };
  const ground = shot(false), air = shot(true);
  return { ok: ground.air && Math.abs(ground.dvy - 0.4 * SH_IMIN) < 0.25 && Math.abs(ground.vz - SH_IMIN) < 0.1 && Math.abs(air.dvy) < 0.2, detail: `ground: dvy ${f(ground.dvy, 3)} vz ${f(ground.vz, 3)}; air: dvy ${f(air.dvy, 3)}` };
});
test('shield (UT2004): a push upward is halved when vy is already above 7.6 m/s (a lift, a pad), whole below it', () => {
  const wall = (b) => b.box([-20, 0, -4], [20, 40, -1.5], { mat: 'wall' });
  const gain = (vy) => {   // in the air 6 m up, vy set, a tap at the wall aimed 30 degrees down
    const w = mk(wall, [0, 6, 0]), c = cmdOf({ pitch: -Math.PI / 6 });
    w.step(c);
    w.ps.vel[1] = vy;
    c.fire = true; run(w, c, 1);
    const vy0 = w.ps.vel[1];
    c.fire = false; w.step(c);
    return { dvy: w.ps.vel[1] - vy0, vy0 };
  };
  const fast = gain(8.5), slow = gain(5), push = SH_IMIN * Math.sin(Math.PI / 6);
  return { ok: fast.vy0 > 7.6 && slow.vy0 < 7.6 && Math.abs(slow.dvy - push) < 0.25 && Math.abs(fast.dvy - push / 2) < 0.25, detail: `vy ${f(fast.vy0, 2)}: +${f(fast.dvy, 3)} (half of ${f(push, 2)}); vy ${f(slow.vy0, 2)}: +${f(slow.dvy, 3)}` };
});
test('shield (UT2004): the refire time is 0.6 s (UT FireRate): a button held through it starts charging only when it is over; a press and release inside it fire nothing', () => {
  const lock = Math.round(SH_LOCK * TICK);
  const afterBlast = () => {
    const w = mk(), c = cmdOf({ fire: true, pitch: DOWN });
    run(w, c, 20); c.fire = false; w.step(c);
    w.takeEvents();
    return { w, c };
  };
  const a = afterBlast();
  a.c.fire = true;
  const n = upto(a.w, a.c, () => a.w.ps.charging, 300);
  const b = afterBlast();
  b.c.fire = true; run(b.w, b.c, 30); b.c.fire = false; b.w.step(b.c);
  const inside = b.w.takeEvents().filter((e) => e.type === 'blast').length;
  return { ok: Math.abs(n - lock) <= 1 && inside === 0 && b.w.ps.charge === 0 && lock === 72, detail: `a held button starts charging ${n} ticks after the blast (lock ${lock}); a tap inside the lock fired ${inside} blasts` };
});
test('shield (UT2004): jump then release and release then jump (within COMBO_TICKS) give the same vy as both on one tick: 6.8 + 12 m/s straight down', () => {
  const vyAfter = (jumpAt, relAt) => {
    const w = mk(), c = cmdOf({ fire: true, pitch: DOWN });
    run(w, c, 300);
    for (let t = 0; t <= Math.max(jumpAt, relAt); t++) { c.fire = t < relAt; c.jump = t === jumpAt; w.step(c); }
    return w.ps.vel[1];
  };
  const same = vyAfter(0, 0), jumpFirst = vyAfter(0, 6), releaseFirst = vyAfter(6, 0);
  return { ok: Math.abs(jumpFirst - same) < 1e-9 && Math.abs(releaseFirst - same) < 1e-9 && same > JUMP_V + SH_IMAX * Math.sin(-DOWN) - 0.3, detail: `same tick ${f(same, 4)}, jump first ${f(jumpFirst, 4)}, release first ${f(releaseFirst, 4)}` };
});

// ---- the UT2004 shield gun, end to end through the real World (columbo): the heights the rules give, the reach, the charge scale, the lift's edge, the lock across a respawn
test('shield (UT2004), end to end: jump + a full release straight down on one tick tops out 9.30 m up; the double jump at the apex adds 1.40 m (10.70 m)', () => {
  const flight = (dj) => {
    const w = mk(), c = cmdOf({ fire: true, pitch: DOWN });
    run(w, c, 300);                                           // a full gun, standing
    c.fire = false; c.jump = true; w.step(c); c.jump = false;   // release + jump on one tick
    let top = w.ps.pos[1], pressed = false, djs = 0;
    for (let i = 0; i < 600 && !w.ps.grounded; i++) {
      c.jump = dj && !pressed && w.ps.vel[1] <= 0; pressed ||= c.jump;
      w.step(c);
      top = Math.max(top, w.ps.pos[1]);
      djs += w.takeEvents().filter((e) => e.type === 'dj').length;
    }
    return { top, djs };
  };
  const plain = flight(false), withDj = flight(true);
  return { ok: Math.abs(plain.top - 9.30) < 0.03 && plain.djs === 0 && Math.abs(withDj.top - 10.70) < 0.03 && withDj.djs === 1, detail: `jump + full ${f(plain.top, 3)} m, with the double jump at the apex ${f(withDj.top, 3)} m (${withDj.djs} dj event)` };
});
test('shield (UT2004): after a full launch from standing, a Space past the combo window while vy is still above DJ_V is ignored and not spent; the double jump at the apex then adds 1.40 m on top of 3.79 m', () => {
  const w = mk(), c = cmdOf({ fire: true, pitch: DOWN });
  run(w, c, 300); c.fire = false; w.step(c);   // the launch
  run(w, c, 14);                               // 15 ticks after the release: out of COMBO_TICKS, vy about 9.6
  w.takeEvents();
  const vyBefore = w.ps.vel[1];
  c.jump = true; w.step(c); c.jump = false;
  const ignored = !w.takeEvents().some((e) => e.type === 'dj' || e.type === 'jump') && !w.ps.djUsed && w.ps.vel[1] < vyBefore && w.ps.vel[1] > DJ_V;
  let top = w.ps.pos[1], pressed = false, djs = 0;
  for (let i = 0; i < 600 && !w.ps.grounded; i++) {
    c.jump = !pressed && w.ps.vel[1] <= 0; pressed ||= c.jump;
    w.step(c);
    top = Math.max(top, w.ps.pos[1]);
    djs += w.takeEvents().filter((e) => e.type === 'dj').length;
  }
  return { ok: vyBefore > DJ_V + 1 && ignored && djs === 1 && Math.abs(top - (3.79 + 1.40)) < 0.04, detail: `vy ${f(vyBefore, 2)} at the Space (DJ_V ${DJ_V}): ignored and not spent ${ignored}; ${djs} double jump at the apex, top ${f(top, 3)} m (expected 5.19)` };
});
test('shield (UT2004): the reach is 2.24 m from the body centre: aimed down, from feet 1.32 m up a tap hits the floor, from feet 1.40 m up it misses and pushes nothing, and the miss spends the shot (a held button charges only after 0.6 s)', () => {
  const shot = (feetY) => {
    const w = mk(), c = cmdOf({ fire: true, pitch: DOWN });
    w.ps.pos = [0, feetY, 0]; w.ps.prevPos = w.ps.pos.slice(); w.ps.lastGood = w.ps.pos.slice(); w.ps.grounded = false;   // floating (a teleport would snap to the floor)
    w.step(c);
    const vy0 = w.ps.vel[1];
    c.fire = false; w.step(c);
    const blast = w.takeEvents().find((e) => e.type === 'blast');
    const dvy = w.ps.vel[1] - vy0;
    c.fire = true;   // hold the button on through the lock
    const n = upto(w, c, () => w.ps.charging, 300);
    return { hit: blast && blast.hit, dvy, n };
  };
  const hit = shot(1.32), miss = shot(1.40), lock = Math.round(SH_LOCK * TICK);
  return { ok: hit.hit === true && hit.dvy > 7 && miss.hit === false && miss.dvy < 0 && Math.abs(miss.n - lock) <= 2 && Math.abs(hit.n - lock) <= 2, detail: `feet 1.32: hit ${hit.hit}, dvy ${f(hit.dvy, 2)}; feet 1.40: hit ${miss.hit}, dvy ${f(miss.dvy, 2)}; a held button charges ${miss.n} ticks after the miss (${hit.n} after the hit), lock ${lock}` };
});
test('shield (UT2004): ps.charge is hold / 1.25 s: 0.5 at 75 ticks, below 1 at 149, 1 (within rounding) at 150, never above 1; a 5 s hold pushes exactly like 1.25 s and the blast event reports at most 1', () => {
  const hold = (ticks) => {
    const w = mk(), c = cmdOf({ fire: true, pitch: DOWN });
    const at = {}; let max = 0;
    for (let i = 1; i <= ticks; i++) { w.step(c); at[i] = w.ps.charge; max = Math.max(max, w.ps.charge); }
    c.fire = false; w.step(c);
    return { at, max, vy: w.ps.vel[1], ev: w.takeEvents().find((e) => e.type === 'blast') };
  };
  const a = hold(150), b = hold(600);
  const ok = a.at[75] > 0.5 - 1e-9 && a.at[75] < 0.5 + 1e-9 && a.at[149] < 1 - 1e-3 && a.at[149] > 0.99 && 1 - a.at[150] < 1e-9 && b.max <= 1 && Math.abs(a.vy - b.vy) < 1e-9 && a.ev.charge <= 1 && b.ev.charge <= 1 && b.ev.hit;
  return { ok, detail: `charge at 75 / 149 / 150 ticks: ${f(a.at[75], 6)} / ${f(a.at[149], 6)} / ${a.at[150]}; max over 600 ticks ${b.max}; vy after the blast ${f(a.vy, 4)} (1.25 s) vs ${f(b.vy, 4)} (5 s)` };
});
test('shield (UT2004): the ground lift replaces a downward push: standing and aimed straight up at a low ceiling the player is thrown UP 0.4 of the push, in the air the same shot pushes down the whole 7.8 m/s', () => {
  const up = Math.PI / 2;   // (the sim clamps the pitch to 89 degrees)
  const tapAt = (w) => {
    const c = cmdOf({ fire: true, pitch: up });
    w.step(c);
    const vy0 = w.ps.vel[1];
    c.fire = false; w.step(c);
    return { dvy: w.ps.vel[1] - vy0, air: !w.ps.grounded, hit: w.takeEvents().some((e) => e.type === 'blast' && e.hit) };
  };
  const ground = tapAt(mk((b) => b.box([-20, 2.2, -20], [20, 6, 20], { mat: 'wall' })));
  const air = tapAt(mk((b) => b.box([-20, 8.2, -20], [20, 12, 20], { mat: 'wall' }), [0, 6, 0]));
  return { ok: ground.hit && ground.air && ground.dvy > 0.4 * SH_IMIN - 0.3 && ground.dvy < 0.4 * SH_IMIN + 0.1 && air.hit && air.dvy < -SH_IMIN + 0.1 && air.dvy > -SH_IMIN - 0.4, detail: `standing: dvy ${f(ground.dvy, 3)} (airborne ${ground.air}); in the air: dvy ${f(air.dvy, 3)}` };
});
test('shield (UT2004): a respawn or a restart inside the 0.6 s lock gives a fresh gun: a held button charges on the very next tick', () => {
  const w = mk(), c = cmdOf({ fire: true, pitch: DOWN });
  run(w, c, 20); c.fire = false; w.step(c);   // a blast: the lock runs
  const locked = w.ps.shieldLock > 0;
  c.fire = true; run(w, c, 10);
  const stillLocked = !w.ps.charging;
  w.respawn('manual'); w.step(c);
  const afterRespawn = w.ps.charging && w.ps.charge > 0;
  c.fire = false; w.step(c); w.takeEvents();   // (the button released: the gun just fired again, a new lock)
  c.fire = true; run(w, c, 5);
  w.restart({ silent: true }); w.step(c);
  const afterRestart = w.ps.charging && w.ps.charge > 0;
  return { ok: locked && stillLocked && afterRespawn && afterRestart, detail: `locked ${locked}, 10 ticks later still not charging ${stillLocked}; one tick after respawn charging ${afterRespawn}, after restart ${afterRestart}` };
});

const runMap = (fn) => new World(defineMap({ id: 'rt', name: 'Rt', diff: 'kikepzes', order: 1, blurb: '', authorTime: 1 }, (b) => {
  b.start([0, 0, 0], 0);
  b.box([-10, -1, -60], [10, 0, 10], { mat: 'floor' });
  fn(b);
  b.route([{ type: 'wait', s: 0.1 }]);
}).build());

test('kill volume: instant respawn at the last checkpoint, speed zeroed, clock keeps running', () => {
  const w = runMap((b) => {
    b.checkpoint([-5, 0, -10], [5, 4, -14], { spawn: [0, 0, -12], yaw: 0 });
    b.box([-10, -1, -90], [10, 0, -70], { mat: 'floor' });
    b.finish([-5, 0, -80], [5, 4, -84]);
  });
  const c = cmdOf({ fwd: 1 });
  const hit = upto(w, c, () => w.cpIndex === 1, 400);
  upto(w, c, () => w.deaths === 1, 1200);   // runs on, off the edge at z = -60, into the void
  const respawned = w.deaths === 1 && Math.abs(w.ps.pos[2] + 12) < 0.01 && w.ps.speed < 0.01;
  const ev = w.takeEvents().filter((e) => e.type === 'respawn').length;
  return { ok: hit > 0 && respawned && ev === 1 && w.clockState === 'running', detail: `cp at tick ${hit}, deaths ${w.deaths}, pos z ${f(w.ps.pos[2], 2)}, respawn events ${ev}, clock ${w.clockState}` };
});

test('checkpoints count in order, the finish only after all of them; Enter restarts', () => {
  const w = runMap((b) => {
    b.finish([-5, 0, -6], [5, 4, -9]);                           // first on the way, but not yet allowed
    b.checkpoint([-5, 0, -20], [5, 4, -24], { spawn: [0, 0, -22], yaw: 0 });
  });
  const c = cmdOf({ fwd: 1 });
  upto(w, c, () => w.ps.pos[2] < -12, 400);
  const early = w.finished;
  upto(w, c, () => w.cpIndex === 1, 400);
  w.step(cmdOf({ restart: true }));
  const reset = w.cpIndex === 0 && w.clock === 0 && w.clockState === 'ready' && Math.abs(w.ps.pos[2]) < 0.01;
  return { ok: !early && reset, detail: `finished before the checkpoint: ${early}; after restart: cp ${w.cpIndex}, clock ${w.clock} (${w.clockState})` };
});

test('jump pad: lands on its target', () => {
  const w = runMap((b) => {
    b.box([-10, -1, -90], [10, 0, -70], { mat: 'floor' });
    b.pad([0, 0, -5], { target: [0, 0, -80], apex: 8 });
    b.checkpoint([-5, 0, -75], [5, 4, -85]);
    b.finish([-5, 0, -100], [5, 4, -104]);
  });
  w.teleport([0, 0, -2], 0);
  const c = cmdOf({ fwd: 1 });
  let launched = false;
  const n = upto(w, c, () => { if (!w.ps.grounded) launched = true; return launched && w.ps.grounded; }, 1200);
  const dx = Math.hypot(w.ps.pos[0], w.ps.pos[2] + 80);
  return { ok: n > 0 && dx < 1.5, detail: `landed ${f(dx, 2)} m from the target after ${n} ticks` };
});

test('lift jump: the platform velocity joins the jump', () => {
  const w = runMap((b) => {
    b.mover('lift', { path: [[0, 20, 0]], speed: 4, wait: 0 }, () => { b.box([-3, 3, -3], [3, 3.5, 3], { mat: 'floor' }); });
    b.checkpoint([200, 0, 200], [201, 2, 201]); b.finish([210, 0, 210], [211, 2, 211]);
  });
  w.teleport([0, 3.5, 0], 0);
  w.startClock();
  const c = makeCmd();
  for (let i = 0; i < 30; i++) w.step(c);
  const rising = w.ps.groundMover === 0 && w.movers[0].vel[1] > 3.9;
  c.jump = true; w.step(c); c.jump = false;
  const vy = w.ps.vel[1];
  return { ok: rising && vy > JUMP_V + 3.5, detail: `riding: ${rising}; vy after the jump ${f(vy, 2)} (jump ${JUMP_V} + lift 4)` };
});

const evs = (w) => w.takeEvents();
// step until the player is at the apex (vy <= 0), then one more tick: that is where a buffered double jump fires. Returns the tick count
const toApex = (w, c, max = 300) => { const n = upto(w, c, () => w.ps.vel[1] <= 0, max); w.step(c); return n + 1; };

test('no bunnyhop: a held Space jumps once; landing at 15.9 m/s and pressing again leaves at no more than RUN', () => {
  const w = mk();
  const held = cmdOf({ jump: true });
  let hops = 0, was = true;
  for (let i = 0; i < 600; i++) { w.step(held); if (was && !w.ps.grounded) hops++; was = w.ps.grounded; }
  // a real 15.9 m/s landing: run, dodge to the side + Space, land, press Space again on the landing tick
  const d = mk();
  const c = cmdOf({ fwd: 1 });
  run(d, c, 120);   // up to run speed
  c.dodge = DODGE.L; c.jump = true; d.step(c); c.dodge = 0; c.jump = false;
  upto(d, c, () => d.ps.grounded);
  const landed = d.ps.speed;
  c.jump = true; d.step(c);
  const left = d.ps.speed, vy = d.ps.vel[1];
  const grounded = d.ps.grounded;
  return { ok: hops === 1 && landed > 15 && !grounded && left <= RUN + 0.01 && Math.abs(vy - JUMP_V) < 0.2, detail: `held Space: ${hops} hop(s) in 5 s; landed at ${f(landed, 2)} m/s, the jump on landing left at ${f(left, 2)} m/s (RUN ${RUN}), vy ${f(vy, 2)}` };
});

test('diagonal jump, same tick: dodge + Space = the dodge now, the double jump by itself at the apex', () => {
  const w = mk();
  w.step(cmdOf({ dodge: DODGE.L, jump: true }));
  const first = evs(w), v = w.ps.speed;
  const jumped = first.some((e) => e.type === 'jump');   // no separate jump event: the dodge arc replaces it
  const n = toApex(w, makeCmd());
  const ev = evs(w), dj = ev.find((e) => e.type === 'dj');
  const vy = w.ps.vel[1];
  let maxY = w.ps.pos[1];
  upto(w, makeCmd(), () => { maxY = Math.max(maxY, w.ps.pos[1]); return w.ps.grounded; });
  return { ok: !jumped && Math.abs(v - DODGE_XY) < 0.1 && n > 20 && dj && dj.auto === true && vy > DJ_V - 0.3 && maxY > 1.8 && maxY < 1.95, detail: `speed ${f(v, 2)}, auto double jump after ${n} ticks (auto: ${dj && dj.auto}), vy ${f(vy, 2)}, peak ${f(maxY, 2)} m` };
});

test('diagonal jump, jump first: a dodge within the window converts the jump into the dodge arc (same peak as the same-tick one)', () => {
  const peak = (gap) => {
    const w = mk();
    w.step(cmdOf({ jump: true }));
    const c = makeCmd();
    for (let i = 0; i < gap - 1; i++) w.step(c);
    w.step(cmdOf({ dodge: DODGE.R }));
    const ev = evs(w), late = ev.find((e) => e.type === 'dodge' && e.late);
    const v = w.ps.speed, vy = w.ps.vel[1];
    let maxY = w.ps.pos[1], auto = false;
    upto(w, makeCmd(), () => { maxY = Math.max(maxY, w.ps.pos[1]); if (w.takeEvents().some((e) => e.type === 'dj' && e.auto)) auto = true; return w.ps.grounded; });
    return { late: !!late, v, vy, maxY, auto };
  };
  const a = peak(3), b = peak(8);
  const ok = [a, b].every((r) => r.late && Math.abs(r.v - DODGE_XY) < 0.1 && r.auto && r.maxY > 1.8 && r.maxY < 1.95);
  return { ok, detail: `+3 ticks: late ${a.late}, speed ${f(a.v, 2)}, vy ${f(a.vy, 2)}, peak ${f(a.maxY, 2)}; +8 ticks: peak ${f(b.maxY, 2)}, auto dj ${b.auto}` };
});

test('diagonal jump, dodge first: Space within the window is buffered to the apex; at +12 ticks it is an immediate double jump', () => {
  const after = (gap) => {
    const w = mk();
    w.step(cmdOf({ dodge: DODGE.L }));
    const c = makeCmd();
    for (let i = 0; i < gap - 1; i++) w.step(c);
    evs(w);
    w.step(cmdOf({ jump: true }));
    const dj = evs(w).find((e) => e.type === 'dj');
    return { dj, vy: w.ps.vel[1], w };
  };
  const inWin = after(5), out = after(12);
  const bufferedNow = !inWin.dj && inWin.vy < 4.2;   // nothing happened yet, still rising on the dodge arc
  const apex = toApex(inWin.w, makeCmd());
  const dj2 = evs(inWin.w).find((e) => e.type === 'dj');
  const immediate = out.dj && !out.dj.auto && out.vy > DJ_V - 0.3;
  return { ok: bufferedNow && dj2 && dj2.auto === true && immediate, detail: `+5 ticks: immediate dj ${!!inWin.dj}, then auto dj ${dj2 && dj2.auto} after ${apex} more ticks; +12 ticks: dj ${out.dj && (out.dj.auto ? 'auto' : 'immediate')}, vy ${f(out.vy, 2)}` };
});

test('a jump at a wall followed at once by a dodge away from it is a wall dodge (vy = DODGE_Y whatever the jump had), not the jump-first conversion', () => {
  const w = mk((b) => b.box([-20, 0, -12], [20, 20, -10], { mat: 'wall' }), [0, 0, -9.5], Math.PI);
  const c = cmdOf({ yaw: Math.PI, jump: true });
  w.step(c); c.jump = false; w.step(c);
  evs(w);
  c.dodge = DODGE.F; w.step(c); c.dodge = 0;
  const ev = evs(w), wd = ev.find((e) => e.type === 'walldodge'), conv = ev.find((e) => e.type === 'dodge');
  return { ok: !!wd && !conv && Math.abs(w.ps.vel[1] - (DODGE_Y - G / TICK)) < 0.02 && !w.ps.djBuf, detail: `walldodge ${!!wd}, conversion ${!!conv}, vy ${f(w.ps.vel[1], 2)} (DODGE_Y ${DODGE_Y} minus one tick of gravity, not the jump's ~6.5)` };
});

test('no jump-first conversion while the dodge cooldown runs; a second Space press while a double jump is buffered fires it at once', () => {
  const w = mk();
  w.step(cmdOf({ dodge: DODGE.F }));
  upto(w, makeCmd(), () => w.ps.grounded);   // dodgeCd now runs (0.35 s)
  evs(w);
  w.step(cmdOf({ jump: true }));
  const c = makeCmd();
  w.step(c); w.step(c);
  const v0 = w.ps.speed;
  w.step(cmdOf({ dodge: DODGE.R }));
  const refused = !evs(w).some((e) => e.type === 'dodge' || e.type === 'walldodge') && Math.abs(w.ps.speed - v0) < 0.2;
  const b = mk();
  b.step(cmdOf({ dodge: DODGE.F, jump: true }));   // buffered
  b.step(makeCmd());
  b.step(cmdOf({ jump: true }));                   // a manual press: the double jump now
  const dj = evs(b).find((e) => e.type === 'dj');
  return { ok: refused && dj && !dj.auto && b.ps.vel[1] > DJ_V - 0.3 && b.ps.djUsed && !b.ps.djBuf, detail: `conversion refused during the cooldown: ${refused}; second press: dj ${dj && (dj.auto ? 'auto' : 'immediate')}, vy ${f(b.ps.vel[1], 2)}` };
});

test('air control steers but never gains speed: 20 000 random-input ticks in the air never exceed max(speed before, RUN)', () => {
  const rng = mulberry32(31337);
  let worst = 0, steered = false;
  for (let k = 0; k < 8; k++) {
    const w = mk();
    w.teleport([0, 400, 0], rng() * 6.28);
    const v0 = rng() < 0.5 ? rng() * 8 : 9 + rng() * 12;   // below and above RUN
    const a0 = rng() * 6.28;
    w.ps.vel = [Math.cos(a0) * v0, 0, Math.sin(a0) * v0];
    const c = makeCmd();
    let hold = 0;
    for (let i = 0; i < 300; i++) {   // 2.5 s: falls ~100 m of the 400
      if (hold-- <= 0) { hold = 5 + Math.floor(rng() * 40); c.fwd = Math.floor(rng() * 3) - 1; c.side = Math.floor(rng() * 3) - 1; }
      c.yaw += (rng() - 0.5) * 0.3;
      const before = w.ps.speed;
      w.step(c);
      worst = Math.max(worst, w.ps.speed - Math.max(before, RUN));
      if (before < RUN - 1 && w.ps.speed > before + 1e-6) steered = true;
    }
  }
  return { ok: worst < 1e-9 && steered, detail: `largest excess over max(previous speed, RUN): ${worst.toExponential(1)} m/s; below RUN the wish direction does accelerate: ${steered}` };
});

test('events: clockStart, jump, land, cp, finish arrive in order', () => {
  const w = runMap((b) => {
    b.checkpoint([-5, 0, -10], [5, 4, -14], { spawn: [0, 0, -12], yaw: 0 });
    b.finish([-5, 0, -20], [5, 4, -24]);
  });
  const c = cmdOf({ fwd: 1 });
  c.jump = true; w.step(c); c.jump = false;
  upto(w, c, () => w.ps.grounded);
  upto(w, c, () => w.finished, 800);
  const types = w.takeEvents().map((e) => e.type);
  const order = ['clockStart', 'jump', 'land', 'cp', 'finish'];
  const idx = order.map((t) => types.indexOf(t));
  return { ok: idx.every((v, i) => v >= 0 && (i === 0 || v > idx[i - 1])), detail: types.join(' ') };
});

test('brush data: faces wound counter-clockwise from outside, every vertex inside every plane', () => {
  const shapes = [
    { kind: 'block', c: [1, 2, 3], size: [2, 3, 4], yaw: 30 }, { kind: 'ramp', c: [0, 0, 0], size: [4, 2, 6], yaw: 90 },
    { kind: 'prism', c: [0, 0, 0], r: 2, h: 3, sides: 8, yaw: 15 }, { kind: 'hull', points: [[0, 0, 0], [2, 0, 0], [0, 2, 0], [0, 0, 2], [1, 1, 1]] },
  ];
  let bad = '';
  for (const sh of shapes) {
    const b = makeBrush(sh);
    for (const fc of b.faces) {
      const [p, q, r] = fc.verts, u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], v = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const l = Math.hypot(...n);
      if ((n[0] * fc.n[0] + n[1] * fc.n[1] + n[2] * fc.n[2]) / l < 0.999) bad += `${sh.kind}: a face is wound the wrong way; `;
      for (const w of b.verts) if (w[0] * fc.n[0] + w[1] * fc.n[1] + w[2] * fc.n[2] > fc.d + 1e-6) bad += `${sh.kind}: a vertex is outside a face plane; `;
    }
    if (!(b.volume > 0)) bad += `${sh.kind}: no volume; `;
  }
  return { ok: !bad, detail: bad || '4 shapes (yawed block, ramp, prism, hull)' };
});

test('ghost: encode / decode round trip (with a teleport), interpolation, base64', () => {
  const rec = new GhostRecorder();
  const ps = { pos: [0, 0, 0], yaw: 0, pitch: 0 };
  for (let t = 0; t <= 1200; t++) {
    ps.pos = [Math.sin(t / 50) * 20, 1 + (t % 90) * 0.01, -t * 0.07]; ps.yaw = t * 0.01 - 3; ps.pitch = Math.sin(t / 30) * 0.4;
    if (t === 600) ps.pos = [-400, 90, 500];   // a respawn far away
    rec.sample(t, ps);
  }
  const bytes = encodeGhost(rec.get());
  const back = decodeGhost(fromB64(toB64(bytes)));
  const g = rec.get();
  let maxE = 0;
  for (let k = 0; k < g.n; k++) for (let c = 0; c < 3; c++) maxE = Math.max(maxE, Math.abs(g.data[k * 5 + c] - back.data[k * 5 + c]));
  const mid = ghostAt(back, 300);
  const half = decodeGhost(encodeGhost(g, 2));
  return { ok: back.n === g.n && maxE < 0.006 && Math.abs(mid[0] - Math.sin(300 / 50) * 20) < 0.05 && half.every === g.every * 2 && Math.abs(half.n * 2 - g.n) <= 2, detail: `${g.n} frames -> ${bytes.length} bytes, max position error ${(maxE * 100).toFixed(2)} cm, 10 Hz copy ${encodeGhost(g, 2).length} bytes` };
});

test('ghost: decodeGhost gives null (never throws, never allocates a huge array) for bad data: wrong magic, empty, a frame count the bytes cannot hold, every = 0, truncated', () => {
  const rec = new GhostRecorder();
  for (let t = 0; t <= 600; t++) rec.sample(t, { pos: [t * 0.05, 1, 0], yaw: 0, pitch: 0 });
  const good = encodeGhost(rec.get());
  const set32 = (b, n) => { const c = b.slice(); new DataView(c.buffer).setUint32(4, n, true); return c; };
  const bad = {
    'empty': new Uint8Array(0), 'short header': good.slice(0, 5), 'wrong magic': Uint8Array.of(0, 1, 6, 0, 1, 0, 0, 0, 0, 0),
    'a 4 billion frame header': set32(good, 0xffffffff), 'more frames than bytes': set32(good, rec.get().n + 1000),
    'every = 0': Uint8Array.from(good, (v, i) => (i === 2 ? 0 : v)), 'truncated': good.slice(0, good.length - 40),
  };
  const notNull = Object.entries(bad).filter(([, b]) => { try { return decodeGhost(b) !== null; } catch { return true; } }).map(([k]) => k);
  const g = decodeGhost(good);
  return { ok: !notNull.length && g && g.n === rec.get().n, detail: notNull.length ? 'not null: ' + notNull.join(', ') : '7 kinds of bad data -> null, the good one decodes' };
});

export function runTraceTests() {
  return tests.map((t) => {
    try { return { name: t.name, ...t.fn() }; } catch (e) { return { name: t.name, ok: false, detail: 'threw: ' + (e.stack || e.message) }; }
  });
}
