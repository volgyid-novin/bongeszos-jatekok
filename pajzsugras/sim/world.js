// The map runtime: movers, triggers, run clock, checkpoints, respawn, events. Pure (no three, DOM, Date, Math.random).
//
// ============================ RUNTIME API (for the renderer / UI / net code) ============================
//
//   import { createWorld, medalTimes, medalFor } from './sim/world.js';
//   import { makeCmd } from './sim/pmove.js';
//   import { TICK, DT, EYE, DODGE, FLAG } from './sim/const.js';   // 120 Hz, dodge enum, player flag bits
//   import MAPS from './maps/index.js';              // MAPS.list = [{ meta, build }] in ladder order, MAPS.get(id), MAPS.ids
//   const world = createWorld(MAPS.get('kikepzes'));  // builds the map (memoised) and makes a World; world.map is shared & read-only
//   (the proof bot for the debug hook: import { RouteRunner } from './sim/bot.js'; new RouteRunner(world, world.map.route).advance(n))
//
// STATIC MAP DATA  world.map  (everything the renderer needs; never read the map files)
//   .meta { id, name, diff, order, blurb, authorTime }     .theme (normalised, every field present, see builder.js)
//   .mapHash        hex string, changes when the geometry/triggers/physics version change (not for cosmetics)
//   .materials      { name: { base, color, trim, emissive } }
//   .brushes[]      every solid brush (static AND mover) { id, mat, mover (mover id | null), min, max,
//                     faces: [{ n: [x,y,z], d, verts: [[x,y,z]...] counter-clockwise seen from outside, top: n.y >= 0.7 }],
//                     verts, kind }  -> triangulate each face as a fan; faces with top === true get the material's "top" variant
//   .movers[]       { id, index, brushes: [brush ids], decoBrushes: [indices into .decoBrushes], deco: [indices into .deco],
//                     path, speed, wait, mode, phase }   (their brush faces are at the AUTHORED position: draw the group translated by
//                     world.moverOffset(id, alpha); mover deco / decoBrushes move with it too)
//   .decoBrushes[]  non-colliding brushes, same shape as .brushes ({ mat, mover, faces, ... })
//   .deco[]         { kind, pos, size?, yaw (deg), color?, to?, mover (id | null), ...extra }   see builder.js for the kinds
//   .checkpoints[]  { i, min, max, spawn: [x,y,z], yaw (deg), label }       .finish { min, max }
//   .kills[]        { min, max, kind: 'void' | 'lava' | 'laser', auto? }     .pads[] { pos, target, apex, min, max }
//   .start { pos, yaw (deg) }       .signs[] { pos, yaw (deg), title, keys, text }     .glyphs[] { pos, kind, yaw (deg) }
//   .markers[] { pos, text }        .lights[] { pos, color, intensity, range }         .bounds { min, max }
//   world.medals    { author, gold, silver, bronze } in seconds (medalTimes(meta.authorTime)); medalFor(seconds, medals)
//   Angles in map data are DEGREES, yaw 0 faces -Z (three.js camera.rotation.y; sim yaw/pitch are RADIANS and use the
//   same convention: camera.rotation.set(pitch, yaw, 0, 'YXZ')).
//
// STEPPING   world.step(cmd)   advances exactly one tick (1/120 s). cmd = makeCmd():
//   { fwd: -1|0|1, side: -1|0|1 (+1 = right), yaw, pitch (radians), jump (HELD), fire (HELD), dodge: DODGE.NONE|F|B|L|R
//     (one tick when the double tap / shift+dir happens), respawn, restart (edges, true for one step), autoHop (setting) }
//   The input layer must latch presses shorter than one tick (jump / fire / dodge) so the sim sees them for >= 1 tick.
//   The run clock starts on the first step with any input (fwd/side/jump/fire/dodge) unless restart({autoStart:false});
//   then call world.startClock() yourself (race GO). world.setFrozen(true) makes step() a no-op except looking around.
//   world.restart({ frozen, autoStart })  back to the start, clock reset ('ready'); also what cmd.restart does.
//   world.respawn(cause) back to the last checkpoint (clock keeps running); world.teleport(pos, yaw) debug.
//
// PLAYER  world.ps (PlayerState): pos, prevPos (feet, interpolate between them with alpha = accumulator / DT), vel,
//   yaw, prevYaw, pitch, prevPitch, grounded, charge (0..1), charging, shieldLock, djUsed, wallUsed, dodging, speed
//   (horizontal, getter), flags (getter: FLAG bits GROUND | CHARGE | BLAST | DODGING | DJ_USED).
//   world.playerFlags() = ps.flags | FLAG.FINISHED when finished.  Eye = pos + [0, EYE, 0].
//   world.lerp(alpha, out?) -> { pos, yaw, pitch } interpolated; world.moverOffset(id, alpha = 1) -> [x, y, z] (mover
//   translation relative to its authored position; also world.movers[i].offset / prevOffset / vel).
//   After a 'respawn' / 'restart' event copy ps.yaw / ps.pitch into the camera look state (prev* are reset: no smear) and treat
//   the shield as released (no 'shieldCharge off' event comes).
//
// RUN  world.clock (ticks since the clock started; seconds = clock / TICK), world.clockState 'ready' | 'running' |
//   'finished', world.cpIndex (checkpoints reached, 0..cpCount), world.cpCount, world.splits[] (clock ticks at each reached
//   checkpoint), world.finished, world.finishTicks, world.deaths, world.frozen, world.spawn { pos, yaw (rad) } (current respawn).
//   world.stateHash() deterministic digest of the run state (tests, net sanity).
//
// EVENTS  world.takeEvents() returns and clears the queue (array of { type, tick, ...data }); world.events is the live array.
//   jump { combo }  dj  dodge { dir }  walldodge { dir, normal }  land { speed, pos }  shieldCharge { on }
//   blast { pos, normal | null, dir, charge, hit }   cp { index, count, time, label }   finish { time, splits }
//   respawn { cause: 'kill' | 'manual' | 'stuck', kind? }   restart {}   pad { index }   moverStart { id }   clockStart {}
//
// GHOST  world.ghost (GhostRecorder, 20 Hz from the clock start); world.ghostData() = { every, n, data } of the run so far;
//   encodeGhost / decodeGhost / ghostAt / toB64 / fromB64 in ghost.js.
// =========================================================================================================
import { TICK, HULL_HX, HULL_H, FLAG, MEDAL_GOLD, MEDAL_SILVER, MEDAL_BRONZE } from './const.js';
import { CollisionWorld } from './trace.js';
import { PlayerState, stepPlayer, padLaunch, ptrace, hullSolid, categorize } from './pmove.js';
import { GhostRecorder } from './ghost.js';
import { hashFloats, angDiff, DEG, clamp } from './math.js';

export function medalTimes(a) {
  const c = (k) => Math.ceil(a * k * 10 - 1e-9) / 10;
  return { author: a, gold: c(MEDAL_GOLD), silver: c(MEDAL_SILVER), bronze: c(MEDAL_BRONZE) };
}
// 'author' | 'gold' | 'silver' | 'bronze' | null for a time in seconds
export function medalFor(t, m) { return t <= m.author ? 'author' : t <= m.gold ? 'gold' : t <= m.silver ? 'silver' : t <= m.bronze ? 'bronze' : null; }

// ---- movers: closed-form position from the integer tick ----
// cycle: legs of (wait at the start point, move to the next), pingpong = p0..pn..p1 back to p0, loop = p0..pn back to p0
export function buildCycle(m) {
  const pts = m.path, n = pts.length;
  const q = pts.slice();
  if (m.mode === 'pingpong') for (let i = n - 2; i >= 1; i--) q.push(pts[i]);
  const segs = [];
  let t = 0;
  for (let k = 0; k < q.length; k++) {
    const a = q[k], b = q[(k + 1) % q.length];
    const wt = Math.round(m.wait * TICK);
    if (wt > 0) { segs.push({ t0: t, t1: t + wt, a, b: a, move: false }); t += wt; }
    const mt = Math.max(1, Math.round((Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / m.speed) * TICK));
    segs.push({ t0: t, t1: t + mt, a, b, move: true });
    t += mt;
  }
  return { segs, total: t, phase: Math.round(m.phase * TICK) };
}
export function cyclePos(c, tick, out = [0, 0, 0]) {
  const u = (((tick + c.phase) % c.total) + c.total) % c.total;
  let lo = 0, hi = c.segs.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (c.segs[mid].t0 <= u) lo = mid; else hi = mid - 1; }
  const s = c.segs[lo], f = s.move ? (u - s.t0) / (s.t1 - s.t0) : 0;
  out[0] = s.a[0] + (s.b[0] - s.a[0]) * f; out[1] = s.a[1] + (s.b[1] - s.a[1]) * f; out[2] = s.a[2] + (s.b[2] - s.a[2]) * f;
  return { pos: out, seg: lo, moving: s.move };
}

// where a mover is in its cycle at a tick: { seg, into } = ticks since its current wait/move segment began
export function cycleInfo(c, tick) {
  const u = (((tick + c.phase) % c.total) + c.total) % c.total;
  let lo = 0, hi = c.segs.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (c.segs[mid].t0 <= u) lo = mid; else hi = mid - 1; }
  return { seg: lo, into: u - c.segs[lo].t0, moving: c.segs[lo].move };
}

const HX = HULL_HX;
const hasInput = (c) => c.fwd !== 0 || c.side !== 0 || c.jump || c.fire || c.dodge !== 0;

export function createWorld(def) { return new World(def.build()); }

export class World {
  constructor(map) {
    this.map = map;
    this.movers = map.movers.map((def) => ({
      id: def.id, index: def.index, def, brushes: def.brushes.map((i) => map.brushes[i]),
      offset: [0, 0, 0], prevOffset: [0, 0, 0], vel: [0, 0, 0], cycle: buildCycle(def), seg: -1,
    }));
    this.cw = new CollisionWorld(map.brushes.filter((b) => b.mover === null), this.movers);
    this.ps = new PlayerState();
    this.ghost = new GhostRecorder();
    this.medals = medalTimes(map.meta.authorTime);
    this.cpCount = map.checkpoints.length;
    this.events = [];
    this.emit = (type, data) => this.events.push({ type, tick: this.t, ...data });
    this.frozen = false; this.autoStart = true;
    this.prevRespawn = false; this.prevRestart = false;
    this.restart({ silent: true });
  }

  // ---- control ----
  restart({ frozen = false, autoStart = true, silent = false } = {}) {
    this.t = 0; this.mt = 0; this.clock = 0; this.clockState = 'ready';
    this.cpIndex = 0; this.splits = []; this.finished = false; this.finishTicks = null; this.deaths = 0;
    this.frozen = frozen; this.autoStart = autoStart;
    this.ghost.reset();
    const s = this.map.start;
    this.spawn = { pos: s.pos.slice(), yaw: s.yaw * DEG };
    for (const m of this.movers) { m.offset = [0, 0, 0]; m.prevOffset = [0, 0, 0]; m.vel = [0, 0, 0]; m.seg = -1; cyclePos(m.cycle, 0, m.offset); }
    this.spawnPlayer(this.spawn.pos, this.spawn.yaw);
    if (!silent) this.emit('restart', {});
  }
  setFrozen(b) { this.frozen = !!b; }
  startClock() {
    if (this.clockState !== 'ready') return;
    this.clockState = 'running';
    this.ghost.sample(0, this.ps, true);
    this.emit('clockStart', {});
  }
  respawn(cause = 'manual', kind) {
    if (cause !== 'manual') this.deaths++;
    this.spawnPlayer(this.spawn.pos, this.spawn.yaw);
    this.emit('respawn', { cause, kind });
  }
  teleport(pos, yaw = this.ps.yaw) { this.spawnPlayer(pos, yaw); }

  spawnPlayer(pos, yaw) {
    const ps = this.ps;
    ps.reset(pos, yaw);
    const tr = ptrace(this.cw, [pos[0], pos[1] + 0.02, pos[2]], [pos[0], pos[1] - 1.5, pos[2]]);
    if (tr.fraction < 1 && !tr.startsolid) { ps.pos = tr.endpos; ps.prevPos = tr.endpos.slice(); ps.lastGood = tr.endpos.slice(); }
    categorize(ps, this.cw, () => {});
  }

  // ---- one tick ----
  step(cmd) {
    const ps = this.ps;
    const restartEdge = cmd.restart && !this.prevRestart, respawnEdge = cmd.respawn && !this.prevRespawn;
    this.prevRestart = !!cmd.restart; this.prevRespawn = !!cmd.respawn;
    if (restartEdge) { this.restart({ frozen: this.frozen, autoStart: this.autoStart }); return; }
    if (this.frozen) {
      ps.prevYaw = ps.yaw; ps.prevPitch = ps.pitch; ps.yaw = cmd.yaw; ps.pitch = clamp(cmd.pitch, -1.553, 1.553);
      ps.prevPos = ps.pos.slice();
      return;
    }
    if (respawnEdge) this.respawn('manual');
    this.t++;
    if (this.clockState === 'ready' && this.autoStart && hasInput(cmd)) this.startClock();
    if (this.clockState !== 'ready') { this.mt++; this.moveMovers(); }
    if (this.clockState === 'running') this.clock++;
    stepPlayer(ps, cmd, this.cw, this.emit);
    if (ps.stuck) { this.respawn('stuck'); return; }
    this.triggers();
    if (this.clockState === 'running' && this.clock % this.ghost.every === 0) this.ghost.sample(this.clock, ps);
  }

  moveMovers() {
    const ps = this.ps;
    const moved = [];
    for (const m of this.movers) {
      const prev = m.offset;
      const r = cyclePos(m.cycle, this.mt, [0, 0, 0]);
      m.prevOffset = prev; m.offset = r.pos;
      const d = [r.pos[0] - prev[0], r.pos[1] - prev[1], r.pos[2] - prev[2]];
      m.vel = [d[0] * TICK, d[1] * TICK, d[2] * TICK];
      if (r.seg !== m.seg) { if (r.moving) this.emit('moverStart', { id: m.id }); m.seg = r.seg; }
      if (d[0] || d[1] || d[2]) moved.push([m, d]);
    }
    if (!moved.length) return;
    // riders go along (traced against everything but their own platform), then whoever is overlapped is pushed
    for (const [m, d] of moved) {
      if (ps.grounded && ps.groundMover === m.index) {
        const tr = ptrace(this.cw, ps.pos, [ps.pos[0] + d[0], ps.pos[1] + d[1], ps.pos[2] + d[2]], m.index);
        ps.pos = tr.endpos;
      }
    }
    if (hullSolid(this.cw, ps.pos)) {
      for (const [m, d] of moved) {
        const tr = ptrace(this.cw, ps.pos, [ps.pos[0] + d[0], ps.pos[1] + d[1], ps.pos[2] + d[2]], m.index);
        if (!hullSolid(this.cw, tr.endpos)) { ps.pos = tr.endpos; break; }
      }
    }
  }

  triggers() {
    const ps = this.ps, p = ps.pos;
    const x0 = p[0] - HX, x1 = p[0] + HX, y0 = p[1], y1 = p[1] + HULL_H, z0 = p[2] - HX, z1 = p[2] + HX;
    const hit = (b) => !(x0 > b.max[0] || x1 < b.min[0] || y0 > b.max[1] || y1 < b.min[1] || z0 > b.max[2] || z1 < b.min[2]);
    for (const k of this.map.kills) if (hit(k)) { this.respawn('kill', k.kind); return; }
    const cps = this.map.checkpoints;
    while (this.cpIndex < cps.length && hit(cps[this.cpIndex])) {
      const cp = cps[this.cpIndex++];
      this.splits.push(this.clock);
      this.spawn = { pos: cp.spawn.slice(), yaw: cp.yaw * DEG };
      this.emit('cp', { index: cp.i, count: cps.length, time: this.clock, label: cp.label });
    }
    const fin = this.map.finish;
    if (!this.finished && this.cpIndex === cps.length && hit(fin)) {
      this.finished = true; this.finishTicks = this.clock; this.clockState = 'finished';
      this.ghost.sample(this.clock, ps, true);
      this.emit('finish', { time: this.clock, splits: this.splits.slice() });
    }
    if (ps.padCd === 0) {
      for (let i = 0; i < this.map.pads.length; i++) {
        if (hit(this.map.pads[i])) { padLaunch(ps, this.map.pads[i]); this.emit('pad', { index: i }); break; }
      }
    }
  }

  // ---- reading ----
  takeEvents() { const e = this.events; this.events = []; return e; }
  playerFlags() { return this.ps.flags | (this.finished ? FLAG.FINISHED : 0); }
  get nextCp() { return this.map.checkpoints[this.cpIndex] || null; }
  runTime() { return this.clock / TICK; }
  ghostData() { return this.ghost.get(); }
  lerp(alpha, out = { pos: [0, 0, 0], yaw: 0, pitch: 0 }) {
    const ps = this.ps;
    for (let i = 0; i < 3; i++) out.pos[i] = ps.prevPos[i] + (ps.pos[i] - ps.prevPos[i]) * alpha;
    out.yaw = ps.prevYaw + angDiff(ps.yaw, ps.prevYaw) * alpha;
    out.pitch = ps.prevPitch + (ps.pitch - ps.prevPitch) * alpha;
    return out;
  }
  moverOffset(id, alpha = 1) {
    const m = this.movers.find((x) => x.id === id);
    if (!m) return [0, 0, 0];
    return [0, 1, 2].map((i) => m.prevOffset[i] + (m.offset[i] - m.prevOffset[i]) * alpha);
  }
  stateHash() {
    const ps = this.ps, a = [...ps.pos, ...ps.vel, ps.yaw, ps.pitch, ps.charge, ps.t, this.t, this.mt, this.clock, this.cpIndex, this.deaths, ps.flags];
    for (const m of this.movers) a.push(...m.offset);
    return hashFloats(a);
  }
}
