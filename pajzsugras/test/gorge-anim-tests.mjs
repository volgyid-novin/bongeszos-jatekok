// render/gorge-anim.js (AnimBrain): which Gorge clip a runner plays, from position / yaw / flags only. Pure logic: no three.js, no model needed.
// Real flags: stand -> run -> jump -> double jump -> land, dodge vs wall dodge, the finish cheer. Recorded ghosts (infer: true): the air state
// from the vertical motion, checked on a synthetic arc / ramp and against the real sim on a proof route.
import { test, assert } from './harness.mjs';
import { AnimBrain, CLIP_LEN } from '../render/gorge-anim.js';
import { FLAG, G, RUN, TICK } from '../sim/const.js';
import { fwdOf, rightOf } from '../sim/math.js';
import { course, jumpRoute } from './synth.mjs';
import { World } from '../sim/world.js';
import { RouteRunner } from '../sim/bot.js';
import { ghostAt } from '../sim/ghost.js';

const DT = 1 / 60;
const GROUND = FLAG.GROUND;

// a driven figure: pos is integrated from a velocity [vx, vy, vz] (m/s) that the caller changes between runs
function rig(yaw = 0, start = [0, 0, 0]) {
  const brain = new AnimBrain();
  const st = { pos: start.slice(), yaw, flags: GROUND, v: [0, 0, 0], t: 0 };
  const out = { last: null, clips: [] };
  // advance `sec` of time; fn(t) may change st.v / st.flags each frame
  const run = (sec, fn) => {
    const n = Math.round(sec / DT);
    for (let i = 0; i < n; i++) {
      if (fn) fn(i * DT, st);
      st.pos = [st.pos[0] + st.v[0] * DT, st.pos[1] + st.v[1] * DT, st.pos[2] + st.v[2] * DT];
      st.t += DT;
      out.last = brain.update(DT, { pos: st.pos, yaw: st.yaw, flags: st.flags });
      if (!out.clips.length || out.clips[out.clips.length - 1] !== out.last.clip) out.clips.push(out.last.clip);
    }
    return out.last;
  };
  return { brain, st, out, run };
}
const along = (yaw, f, r, speed) => { const a = fwdOf(yaw), b = rightOf(yaw); return [(a[0] * f + b[0] * r) * speed, 0, (a[2] * f + b[2] * r) * speed]; };

test('gorge anim: standing is Idle_Rifle (looped), a nearly still figure stays idle', () => {
  const r = rig();
  let o = r.run(1);
  assert.equal(o.clip, 'Idle_Rifle');
  assert.equal(o.loop, true);
  r.st.v = [0.3, 0, 0];
  o = r.run(1);
  assert.equal(o.clip, 'Idle_Rifle', 'creeping under the 0.6 m/s limit is still standing');
});

test('gorge anim: running picks RunF / RunB / RunL / RunR from the velocity relative to the facing, at any yaw, and the clip follows the speed', () => {
  for (const yaw of [0, 1.1, -2.4, 3.0]) {
    for (const [dir, f, rt] of [['F', 1, 0], ['B', -1, 0], ['L', 0, -1], ['R', 0, 1]]) {
      const r = rig(yaw);
      r.st.v = along(yaw, f, rt, RUN);
      const o = r.run(0.6);
      assert.equal(o.clip, 'Run' + dir, `yaw ${yaw}, moving ${dir}`);
      assert.equal(o.loop, true);
      assert.ok(Math.abs(o.timeScale - 1) < 0.08, `timeScale ${o.timeScale} at run speed`);
    }
  }
  const r = rig();
  r.st.v = along(0, 1, 0, RUN / 2);
  assert.ok(Math.abs(r.run(0.6).timeScale - 0.5) < 0.05, 'half speed -> half the stride rate');
  r.st.v = along(0, 1, 0, 30);
  assert.equal(r.run(0.6).timeScale, 1.6, 'the stride rate is capped');
  r.st.v = along(0, 1, 0, 0.9);
  assert.equal(r.run(0.6).timeScale, 0.35, 'and has a floor');
});

test('gorge anim: the direction does not flicker around the sector border (hysteresis) but does switch when the motion really turns', () => {
  const r = rig();
  const seen = new Set();
  r.run(0.4, (t, st) => { st.v = along(0, 1, 0, RUN); });
  r.run(1.5, (t, st) => {   // wobble +-6 degrees around 45 degrees (the F / R border)
    const a = (45 + 6 * Math.sin(t * 20)) * Math.PI / 180;
    st.v = along(0, Math.cos(a), Math.sin(a), RUN);
    seen.add(r.out.last.clip);
  });
  assert.equal(seen.size, 1, 'one clip only: ' + [...seen].join(', '));
  r.run(0.6, (t, st) => { st.v = along(0, 0, 1, RUN); });
  assert.equal(r.out.last.clip, 'RunR');
});

test('gorge anim: leaving the ground = Takeoff then the held Mid (played once, not looped); a slow jump has no direction; landing shows the Land pose briefly, then runs on', () => {
  const r = rig();
  r.st.v = along(0, 1, 0, RUN);
  r.run(0.5);
  r.run(0.15, (t, st) => { st.flags = 0; st.v[1] = 6; });   // off the ground
  assert.equal(r.out.last.clip, 'JumpF_Takeoff');
  assert.equal(r.out.last.loop, false);
  r.run(0.3, (t, st) => { st.v[1] = 0; });
  assert.equal(r.out.last.clip, 'JumpF_Mid');
  assert.equal(r.out.last.loop, false, 'the falling pose is held, not cycled');
  r.st.v[1] = 0;
  r.run(0.02, (t, st) => { st.flags = GROUND; });
  assert.equal(r.out.last.clip, 'JumpF_Land', 'touchdown');
  assert.equal(r.out.last.loop, false);
  r.run(0.3);
  assert.equal(r.out.last.clip, 'RunF', 'the pose is only held briefly');
  // standing jump
  const s = rig();
  s.run(0.5);
  s.run(0.5, (t, st) => { st.flags = 0; });
  assert.equal(s.out.last.clip, 'Jump_Mid');
  s.run(0.02, (t, st) => { st.flags = GROUND; });
  assert.equal(s.out.last.clip, 'Jump_Land');
  // sideways in the air
  const l = rig(0.7);
  l.st.v = along(0.7, 0, -1, RUN);
  l.run(0.4);
  l.run(0.5, (t, st) => { st.flags = 0; });
  assert.equal(l.out.last.clip, 'JumpL_Mid');
});

test('gorge anim: a bump (GROUND lost for a few ticks) is not a jump, and a hop under 0.2 s shows no Land pose', () => {
  const r = rig();
  r.st.v = along(0, 1, 0, RUN);
  r.run(0.5);
  r.run(0.03, (t, st) => { st.flags = 0; });
  r.run(0.3, (t, st) => { st.flags = GROUND; });
  assert.ok(r.out.clips.every((c) => c === 'Idle_Rifle' || c === 'RunF'), 'clips: ' + r.out.clips.join(' > '));
  r.run(0.12, (t, st) => { st.flags = 0; });   // a short hop: air animation yes, landing pose no
  r.run(0.3, (t, st) => { st.flags = GROUND; });
  assert.ok(!r.out.clips.some((c) => c.endsWith('_Land')), 'clips: ' + r.out.clips.join(' > '));
});

test('gorge anim: the DJ_USED edge in the air plays DoubleJump{dir} once, then back to the Mid loop; a standing double jump has no direction', () => {
  const r = rig();
  r.st.v = along(0, 1, 0, RUN);
  r.run(0.4);
  r.run(0.5, (t, st) => { st.flags = 0; });
  r.run(0.3, (t, st) => { st.flags = FLAG.DJ_USED; });
  assert.ok(r.out.clips.includes('DoubleJumpF'), 'clips: ' + r.out.clips.join(' > '));
  assert.equal(r.out.last.clip, 'DoubleJumpF');
  assert.equal(r.out.last.loop, false);
  r.run(0.5, (t, st) => { st.flags = FLAG.DJ_USED; });   // flag stays set until landing, the clip does not repeat
  assert.equal(r.out.last.clip, 'JumpF_Mid');
  assert.equal(r.out.clips.filter((c) => c === 'DoubleJumpF').length, 1);
  const s = rig();
  s.run(0.3);
  s.run(0.4, (t, st) => { st.flags = 0; });
  s.run(0.2, (t, st) => { st.flags = FLAG.DJ_USED; });
  assert.ok(s.out.clips.includes('DoubleJump'), 'clips: ' + s.out.clips.join(' > '));
  // landing during the clip drops it
  s.run(0.05, (t, st) => { st.flags = GROUND | FLAG.DJ_USED; });
  assert.ok(!s.out.last.clip.startsWith('DoubleJump'));
});

test('gorge anim: a DODGING edge is Dodge{dir}, with the WALL flag (a wall dodge) it is WallDodge{dir}; the direction comes from the velocity after the push', () => {
  const dodge = (yaw, f, rt, airborne) => {
    const r = rig(yaw);
    r.st.v = along(yaw, 0, 0, 0);
    if (airborne) { r.run(0.3); r.run(0.4, (t, st) => { st.flags = 0; }); } else r.run(0.5);
    const base = airborne ? FLAG.WALL : GROUND;
    r.run(0.4, (t, st) => { st.flags = base | FLAG.DODGING; st.v = along(yaw, f, rt, 13.2); if (!airborne) st.v[1] = 4.2; });
    return r;
  };
  for (const [d, f, rt] of [['F', 1, 0], ['B', -1, 0], ['L', 0, -1], ['R', 0, 1]]) {
    const g = dodge(0.5, f, rt, false);
    assert.ok(g.out.clips.includes('Dodge' + d), `ground dodge ${d}: ${g.out.clips.join(' > ')}`);
    assert.ok(!g.out.clips.some((c) => c.startsWith('WallDodge')), 'a ground dodge clears GROUND in the same tick but is no wall dodge');
    const w = dodge(0.5, f, rt, true);
    assert.ok(w.out.clips.includes('WallDodge' + d), `wall dodge ${d}: ${w.out.clips.join(' > ')}`);
  }
  // the dodge clip ends and the Mid loop takes over while still in the air
  const g = dodge(0, 0, 1, false);
  g.run(0.5, (t, st) => { st.flags = FLAG.DODGING; st.v[1] = 0; });
  assert.equal(g.out.last.clip, 'JumpR_Mid');
  // two dodges one after the other: the same clip name restarts (a new seq)
  const r = rig();
  r.run(0.3);
  let seqs = [];
  for (let k = 0; k < 2; k++) {
    r.run(0.1, (t, st) => { st.flags = GROUND | FLAG.DODGING; st.v = along(0, 0, 1, 13.2); });
    seqs.push(r.out.last.seq);
    r.run(0.6, (t, st) => { st.flags = GROUND; st.v = [0, 0, 0]; });
  }
  assert.ok(seqs[1] > seqs[0], 'a second dodge restarts the clip: seq ' + seqs.join(', '));
});

test('gorge anim: a wall dodge after a ground dodge (DODGING is already set, only WALL is new) still plays WallDodge; a late dodge in the air without the wall is Dodge', () => {
  const r = rig();
  r.st.v = along(0, 1, 0, RUN);
  r.run(0.4);
  r.run(0.15, (t, st) => { st.flags = GROUND | FLAG.DODGING; st.v = along(0, 0, 1, 13.2); st.v[1] = 4.2; });   // ground dodge to the right
  r.run(0.5, (t, st) => { st.flags = FLAG.DODGING; st.v[1] = 0; });
  assert.ok(r.out.clips.includes('DodgeR'), r.out.clips.join(' > '));
  assert.ok(!r.out.clips.some((c) => c.startsWith('WallDodge')), 'no wall dodge yet: ' + r.out.clips.join(' > '));
  r.run(0.2, (t, st) => { st.flags = FLAG.DODGING | FLAG.WALL; st.v = along(0, 0, -1, 13.2); });             // the wall dodge back to the left
  assert.ok(r.out.clips.includes('WallDodgeL'), r.out.clips.join(' > '));
  // the jump-first conversion: a dodge in the air with no wall is a ground-style dodge
  const c = rig();
  c.run(0.3);
  c.run(0.1, (t, st) => { st.flags = 0; st.v = [0, 3, 0]; });
  c.run(0.4, (t, st) => { st.flags = FLAG.DODGING; st.v = along(0, 1, 0, 13.2); st.v[1] = 3; });
  assert.ok(c.out.clips.includes('DodgeF') && !c.out.clips.some((x) => x.startsWith('WallDodge')), c.out.clips.join(' > '));
});

test('gorge anim: the dodge direction is the velocity CHANGE at the yaw of the edge (a fast run does not hide a sideways dodge; turning on does not rotate it)', () => {
  // running forward at 14 m/s (the raw velocity after a left dodge is only 43 degrees off forward), dodging left
  const r = rig();
  r.st.v = along(0, 1, 0, 14);
  r.run(0.5);
  r.run(0.4, (t, st) => { st.flags = GROUND | FLAG.DODGING; st.v = [14 * fwdOf(0)[0] - 13.2, 4.2, 14 * fwdOf(0)[2]]; });
  assert.ok(r.out.clips.includes('DodgeL'), 'fast run + left dodge: ' + r.out.clips.join(' > '));
  // a dodge to the right while the player is already turning left quickly: the clip follows the yaw of the edge
  const y = rig(0);
  y.run(0.4);
  y.run(0.4, (t, st) => { st.flags = GROUND | FLAG.DODGING; st.v = along(0, 0, 1, 13.2); st.yaw = -t * 5; });
  assert.ok(y.out.clips.includes('DodgeR'), 'turning during the dodge: ' + y.out.clips.join(' > '));
  // the flags lead the position by up to one packet (race peers): the push shows 40 ms after the edge, the direction is still right
  const lag = rig();
  lag.run(0.4);
  lag.run(0.04, (t, st) => { st.flags = GROUND | FLAG.DODGING; });
  lag.run(0.4, (t, st) => { st.flags = GROUND | FLAG.DODGING; st.v = along(0, 0, -1, 13.2); });
  assert.ok(lag.out.clips.includes('DodgeL'), 'late push: ' + lag.out.clips.join(' > '));
});

test('gorge anim: a non-finite position or yaw sample is ignored, the state survives (speed, clip, direction) and a bad frame time is harmless', () => {
  const b = new AnimBrain();
  let o, z = 0;
  for (let i = 0; i < 40; i++) { z -= RUN * DT; o = b.update(DT, { pos: [0, 0, z], yaw: 0, flags: GROUND }); }
  assert.equal(o.clip, 'RunF');
  for (const bad of [[NaN, 0, z], [0, Infinity, z], [0, 0, -Infinity], [undefined, 0, z]]) {
    const same = b.update(DT, { pos: bad, yaw: 0, flags: GROUND });
    assert.equal(same.clip, 'RunF');
    assert.ok(Number.isFinite(same.speed));
  }
  b.update(DT, { pos: [0, 0, z], yaw: NaN, flags: NaN });
  for (let i = 0; i < 30; i++) { z -= RUN * DT; o = b.update(DT, { pos: [0, 0, z], yaw: 0, flags: GROUND }); }
  assert.ok(Math.abs(o.speed - RUN) < 0.3, 'speed after the bad samples: ' + o.speed);
  assert.equal(o.clip, 'RunF');
});

test('sim flags: FLAG.WALL (64) is on world.playerFlags() from a wall dodge until landing, never on ps.flags, and the brain turns it into WallDodge on a proof route', () => {
  let walls = 0, wallTicks = 0, wallClips = 0;
  for (const id of ['course']) {
    const map = course();
    const w = new World(map), rr = new RouteRunner(w, map.route);
    let live = false;
    const brain = new AnimBrain();
    const clips = [];
    let t = 0;
    while (rr.tick()) {
      for (const e of w.takeEvents()) {
        if (e.type === 'walldodge') { live = true; walls++; }
        if (e.type === 'land' || e.type === 'respawn' || e.type === 'restart' || e.type === 'pad') live = false;
      }
      assert.equal(w.ps.flags & FLAG.WALL, 0, 'ps.flags (and so stateHash) never carries the render-only bit');
      assert.equal((w.playerFlags() & FLAG.WALL) !== 0, w.ps.wallUsed, 'the bit is exactly wallUsed');
      if (w.ps.wallUsed) wallTicks++;
      if (live) assert.ok(w.playerFlags() & FLAG.WALL, 'set from the wall dodge on');
      if (++t % 2 === 0) {   // (60 Hz frames over the 120 Hz sim)
        const o = brain.update(1 / 60, { pos: w.ps.pos, yaw: w.ps.yaw, flags: w.playerFlags() });
        if (!clips.length || clips[clips.length - 1] !== o.clip) clips.push(o.clip);
      }
    }
    wallClips += clips.filter((c) => c.startsWith('WallDodge')).length;
  }
  assert.ok(walls >= 1 && wallTicks > 10, `the proof route wall-dodges (${walls} times, ${wallTicks} ticks)`);
  assert.ok(wallClips >= 1, 'and the brain played a WallDodge clip for it');
});

test('gorge anim: FINISHED while standing cheers once (gesture_cheer, one-shot) and is not repeated while the flag stays; moving cancels it', () => {
  const r = rig();
  r.run(0.5);
  r.run(0.3, (t, st) => { st.flags = GROUND | FLAG.FINISHED; });
  assert.equal(r.out.last.clip, 'gesture_cheer');
  assert.equal(r.out.last.loop, false);
  r.run(CLIP_LEN.cheer + 0.5, (t, st) => { st.flags = GROUND | FLAG.FINISHED; });
  assert.equal(r.out.last.clip, 'Idle_Rifle');
  assert.equal(r.out.clips.filter((c) => c === 'gesture_cheer').length, 1);
  r.run(0.3, (t, st) => { st.flags = GROUND; });
  r.run(0.3, (t, st) => { st.flags = GROUND | FLAG.FINISHED; });
  assert.equal(r.out.clips.filter((c) => c === 'gesture_cheer').length, 2, 'a new finish cheers again');
  // finishing at speed: no cheer while moving
  const m = rig();
  m.st.v = along(0, 1, 0, RUN);
  m.run(0.5);
  m.run(0.4, (t, st) => { st.flags = GROUND | FLAG.FINISHED; });
  assert.ok(!m.out.clips.includes('gesture_cheer'));
  // moving away cancels a running cheer
  const c = rig();
  c.run(0.3, (t, st) => { st.flags = GROUND | FLAG.FINISHED; });
  assert.equal(c.out.last.clip, 'gesture_cheer');
  c.run(0.4, (t, st) => { st.flags = GROUND | FLAG.FINISHED; st.v = along(0, 1, 0, RUN); });
  assert.equal(c.out.last.clip, 'RunF');
});

test('gorge anim: a respawn / restart (a jump of the position) resets the state; absurd dt values and a missing yaw do not break it', () => {
  const r = rig();
  r.st.v = along(0, 1, 0, RUN);
  r.run(0.5, null);
  r.run(0.3, (t, st) => { st.flags = 0; st.v[1] = 3; });
  assert.ok(r.out.last.air);
  r.st.pos = [100, 5, -80]; r.st.v = [0, 0, 0]; r.st.flags = GROUND;
  const o = r.run(0.2);
  assert.equal(o.clip, 'Idle_Rifle');
  assert.equal(o.air, false);
  const b = new AnimBrain();
  for (const dt of [0, -1, 1e9, NaN]) { const x = b.update(dt, { pos: [0, 0, 0] }); assert.ok(typeof x.clip === 'string' && Number.isFinite(x.timeScale), 'dt ' + dt); }
});

// ---- infer mode (recorded ghosts: positions only) ----
// a ghost track the way the game plays it back: positions every `every` seconds, linearly interpolated per render frame
function ghostRun(sampleAt, every, seconds) {
  const samples = [];
  for (let t = 0; t <= seconds + every; t += every) samples.push(sampleAt(t));
  const at = (t) => { const f = t / every, i = Math.min(samples.length - 2, Math.floor(f)), k = f - i; return samples[i].map((v, c) => v + (samples[i + 1][c] - v) * k); };
  const brain = new AnimBrain();
  const rows = [];
  for (let t = 0; t < seconds; t += DT) { const p = at(t); rows.push({ t, o: brain.update(DT, { pos: p, yaw: 0, flags: GROUND, infer: true }) }); }
  return rows;
}

test('gorge anim, infer: a recorded jump arc (10 and 20 Hz) becomes air after the first fall window and lands cleanly; a ground run, a ramp and stairs are no jump', () => {
  for (const every of [0.1, 0.05]) {
    const v0 = 7.6, tFlight = (2 * v0) / G, t0 = 1;
    const arc = (t) => [0, t < t0 || t > t0 + tFlight ? 0 : v0 * (t - t0) - 0.5 * G * (t - t0) ** 2, -t * RUN];
    const rows = ghostRun(arc, every, 3);
    const air = rows.filter((r) => r.o.air);
    assert.ok(air.length > 0, `${every * 1000} ms samples: the arc is detected`);
    const first = air[0].t - t0, last = air[air.length - 1].t - (t0 + tFlight);
    assert.ok(first > 0.1 && first < 0.4, `air starts ${first.toFixed(2)} s after take-off`);
    assert.ok(Math.abs(last) < 0.2, `air ends ${last.toFixed(2)} s from the touchdown`);
    assert.ok(rows.filter((r) => r.t < t0 - 0.05).every((r) => !r.o.air), 'no air before the jump');
    assert.ok(rows.filter((r) => r.t > t0 + tFlight + 0.3).every((r) => !r.o.air), 'no air after it');
    assert.ok(rows.some((r) => r.o.clip.endsWith('_Mid')) && rows.some((r) => r.o.clip === 'JumpF_Land'), 'Mid in flight, Land at the end');
  }
  const flat = ghostRun((t) => [0, 0, -t * RUN], 0.1, 3);
  assert.ok(flat.every((r) => !r.o.air && r.o.clip === 'RunF' || r.t < 0.3), 'running on the flat is never air');
  // up a 35 degree ramp, no fall; stairs, no fall
  const slope = Math.tan(35 * Math.PI / 180);
  assert.ok(ghostRun((t) => [0, t * RUN * slope, -t * RUN], 0.1, 3).every((r) => !r.o.air), 'a ramp is no jump');
  const stairs = (t) => [0, Math.floor(t * RUN / 0.35) * 0.18, -t * RUN];
  assert.ok(ghostRun(stairs, 0.1, 3).every((r) => !r.o.air), 'stairs are no jump');
  // the top of a ramp is a vertical deceleration that looks like a short fall: known, and it may only flash briefly
  const top = ghostRun((t) => { const d = t * RUN; return [0, Math.min(d, 12) * slope, -d]; }, 0.1, 3);
  assert.ok(top.filter((r) => r.o.air).length * DT < 0.5, 'a ramp top flashes the air pose for under half a second');
});

test('gorge anim, infer: on the real sim (a bot route of real jumps on a flat arena, 20 and 10 Hz recordings) the inferred air state matches the real ground flag for most of the run', () => {
  const { map, steps } = jumpRoute();
  const def = { meta: map.meta };
  const w = new World(map);
  const rr = new RouteRunner(w, steps);
  const truth = [];
  while (rr.tick()) if (w.clockState === 'running') truth.push([w.clock, w.ps.grounded]);
  const g20 = w.ghostData();
  const g10 = { every: g20.every * 2, n: 0, data: [] };
  for (let i = 0; i < g20.n; i += 2) { g10.n++; for (let c = 0; c < 5; c++) g10.data.push(g20.data[i * 5 + c]); }
  for (const [g, label] of [[g20, '20 Hz'], [g10, '10 Hz']]) {
    const brain = new AnimBrain();
    const end = truth[truth.length - 1][0];
    let agree = 0, total = 0, ti = 0, airTruth = 0, airSeen = 0;
    for (let f = 0; f * DT * TICK < end; f++) {
      const clock = f * DT * TICK, p = ghostAt(g, clock);
      const o = brain.update(DT, { pos: [p[0], p[1], p[2]], yaw: p[3], flags: GROUND, infer: true });
      while (ti < truth.length - 1 && truth[ti][0] < clock) ti++;
      const air = !truth[ti][1];
      total++; if (o.air === air) agree++;
      if (air) airTruth++;
      if (o.air) airSeen++;
    }
    assert.ok(airTruth > 50 && airSeen > 0, `${def.meta.id} ${label}: the route has air time (${airTruth} frames)`);
    assert.ok(agree / total > 0.8, `${def.meta.id} ${label}: inferred air agrees with the sim on ${(100 * agree / total).toFixed(1)}% of ${total} frames (want > 80%)`);
    assert.ok(airSeen > 0.6 * airTruth && airSeen < 1.15 * airTruth, `${label}: ${airSeen} air frames inferred for ${airTruth} real ones`);
  }
});

test('gorge anim: walking off an edge (no upward speed) goes straight to the held falling pose, no take-off clip', () => {
  const r = rig();
  r.st.v = along(0, 1, 0, RUN);
  r.run(0.5);
  r.run(0.4, (t, st) => { st.flags = 0; st.v[1] = -G * t; });   // off the edge, falling
  assert.ok(!r.out.clips.some((c) => c.endsWith('_Takeoff')), 'no take-off on a walk-off: ' + r.out.clips.join(' > '));
  assert.equal(r.out.last.clip, 'JumpF_Mid');
  assert.equal(r.out.last.loop, false);
});
