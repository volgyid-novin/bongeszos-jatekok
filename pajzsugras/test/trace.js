// Unit checks of the collision + movement core: rest, sliding, steps, slopes, creases, tunnelling, penetration recovery,
// mover carry. Each check returns { name, ok, detail }.
import { World } from '../sim/world.js';
import { defineMap } from '../sim/builder.js';
import { GhostRecorder, encodeGhost, decodeGhost, ghostAt, toB64, fromB64 } from '../sim/ghost.js';
import { makeCmd } from '../sim/pmove.js';
import { CollisionWorld } from '../sim/trace.js';
import { makeBrush } from '../sim/brush.js';
import { mulberry32 } from '../sim/math.js';
import { TICK, HULL_HX, HULL_HY, DODGE, JUMP_V, DJ_V, DODGE_XY, DODGE_CD } from '../sim/const.js';
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
  return { ok: maxY < 2 && !onSlope && w2.ps.pos[1] < 0.5, detail: `walking up: max y ${f(maxY)}; placed on the slope at y ${y0}: after 2 s y=${f(w2.ps.pos[1])}, z=${f(w2.ps.pos[2])}` };
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

test('wall dodge: needs a wall within 0.5 m, once per airtime', () => {
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

test('shield: a blast into thin air does nothing; one at the floor launches', () => {
  const w = mk();
  const c = makeCmd(); c.fire = true;
  for (let i = 0; i < 30; i++) w.step(c);
  c.fire = false; w.step(c);   // aimed level: nothing within 2.4 m (flat floor, no walls)
  const none = w.ps.vel[1];
  c.fire = true; c.pitch = -1.5; for (let i = 0; i < 40; i++) w.step(c);
  c.fire = false; w.step(c);
  return { ok: Math.abs(none) < 0.01 && w.ps.vel[1] > 3, detail: `level blast vy ${f(none, 3)}, downward blast vy ${f(w.ps.vel[1], 2)}` };
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

test('auto-hop: a held jump hops on every landing, without it only the first', () => {
  const hops = (autoHop) => {
    const w = mk();
    const c = cmdOf({ jump: true, autoHop });
    let n = 0, was = true;
    for (let i = 0; i < 600; i++) { w.step(c); if (was && !w.ps.grounded) n++; was = w.ps.grounded; }
    return n;
  };
  const a = hops(true), b = hops(false);
  return { ok: a >= 5 && b === 1, detail: `auto-hop ${a} hops in 5 s, without ${b}` };
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
