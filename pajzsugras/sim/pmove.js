// The player: state + one fixed tick of movement (steps 2-8 of the tick order; World does movers before and
// triggers/clock after). Quake 3 slide/step move on exact swept-box traces, UT dodge / double jump / shield gun,
// UT air control (steering, never speed gain).
//
// Fixed rules, no timing windows: the double jump always fires on a Space press in the air (once per airtime) and always sets
// vy = DJ_V; a successful wall dodge gives the double jump back (djUsed / djBuf cleared: jump -> double jump -> wall dodge -> Space
// jumps again). Only a press while vy is already above DJ_V is ignored (it would cut a shield / pad / lift launch short), and it does not
// spend the double jump. A wall dodge (once per airtime, also after a ground dodge / diagonal jump) needs a near-vertical wall within
// WALL_RANGE of the hull (its full height) behind the dodge direction or beside it; it always sets vy = DODGE_Y, and every dodge SETS
// the speed along its direction to DODGE_XY (UT PerformDodge; the sideways part is kept).
//
// Tick order inside stepPlayer:
//   dodge (ground, a jump-first conversion in the air, or a wall dodge) -> jump (a fresh press only) / double jump /
//   buffered double jump / shield combo -> shield charge & release
//   -> ground move (friction, UT acceleration) or air move (UT air control: the wish direction steers, speed above RUN is kept)
//   -> half gravity, step/slide move, half gravity -> ground categorisation (landing resets)
//
// No bunnyhop, no strafe gain: only a fresh Space press jumps, and every deliberate ground takeoff (jump, dodge, shield
// launch) first clamps the ground speed to RUN. The diagonal jump: a jump and a dodge within DODGE_JUMP_TICKS of each other
// (either order, or the same tick) give the 13.2 m/s dodge on the dodge's arc, and the double jump fires by itself at the apex.
// (Next to a wall a quick dodge after the jump is a wall dodge instead. A wall dodge is not part of the diagonal jump and buffers
// nothing: it clears the buffer and gives the double jump back, so a Space press on the wall-dodge tick or after it is an ordinary,
// immediate double jump.)
//
// Velocity while grounded on a mover is RELATIVE to the mover (World carries the position); leaving the ground adds
// the mover's velocity, landing subtracts it, so a lift jump inherits the lift's speed.
import {
  DT, G, RUN, ACCEL, FRICTION, STOP, AIR_CONTROL, DODGE_JUMP_TICKS, JUMP_V, DJ_V, DODGE_XY, DODGE_Y, WALL_RANGE, WALL_NY, DODGE_CD,
  STEP, STEP_SLACK, MIN_WALK_NY, GROUND_D, NOSNAP, VMAX, OVERCLIP, CHARGE_T, SH_MIN_HOLD, SH_IMIN, SH_IMAX, SH_RANGE, SH_LIFT, SH_HALVE_VY, SH_LOCK,
  COMBO_TICKS, HULL_HX, HULL_HY, PAD_CD, DODGE, FLAG, ticks,
} from './const.js';
import { clamp, fwdOf, rightOf, aimOf } from './math.js';

const HALF = [HULL_HX, HULL_HY, HULL_HX];
const NOSNAP_T = ticks(NOSNAP), LOCK_T = ticks(SH_LOCK), DODGE_CD_T = ticks(DODGE_CD), PAD_CD_T = ticks(PAD_CD);
const MAX_PITCH = (89 * Math.PI) / 180;
const ZERO = [0, 0, 0];

export function makeCmd() {
  return { fwd: 0, side: 0, yaw: 0, pitch: 0, jump: false, fire: false, dodge: 0, respawn: false, restart: false };
}

export class PlayerState {
  constructor() { this.reset([0, 0, 0], 0); }
  // place at a spawn: everything back to rest
  reset(pos, yaw = 0) {
    this.pos = pos.slice(); this.prevPos = pos.slice(); this.vel = [0, 0, 0];
    this.yaw = yaw; this.pitch = 0; this.prevYaw = yaw; this.prevPitch = 0;
    this.grounded = false; this.gnormal = [0, 1, 0]; this.groundMover = -1; this.groundVel = [0, 0, 0];
    this.charge = 0; this.charging = false; this.shieldLock = 0;
    this.djUsed = false; this.wallUsed = false; this.dodging = false; this.dodgeCd = 0; this.noSnap = 0; this.padCd = 0;
    this.prevJump = false; this.lastJumpT = -999; this.jumpY = 0; this.jumpGV = [0, 0, 0];   // tick, feet height, ground velocity of the last ground jump
    this.djBuf = false; this.dodgeT = -999;   // a double jump waiting for the apex; tick of the last ground dodge or jump-first conversion (a wall dodge clears it)
    this.blastGround = false; this.blastT = -999; this.blastVy = 0; this.blastFlash = -999;
    this.t = 0; this.lastGood = pos.slice(); this.stuck = false; this.fallV = 0;
  }
  get flags() {
    return (this.grounded ? FLAG.GROUND : 0) | (this.charging ? FLAG.CHARGE : 0) | (this.t - this.blastFlash < 4 ? FLAG.BLAST : 0)
      | (this.dodging ? FLAG.DODGING : 0) | (this.djUsed ? FLAG.DJ_USED : 0);
  }
  get speed() { return Math.hypot(this.vel[0], this.vel[2]); }
}

// hull box trace between two FEET positions
export function ptrace(cw, a, b, skip = -1) {
  const tr = cw.traceBox([a[0], a[1] + HULL_HY, a[2]], [b[0], b[1] + HULL_HY, b[2]], HALF, skip);
  tr.endpos[1] -= HULL_HY;
  return tr;
}
export const hullSolid = (cw, pos, skip = -1) => cw.testSolid([pos[0], pos[1] + HULL_HY, pos[2]], HALF, skip);

function clipVel(v, n, over = OVERCLIP) {
  let b = v[0] * n[0] + v[1] * n[1] + v[2] * n[2];
  b = b < 0 ? b * over : b / over;
  return [v[0] - n[0] * b, v[1] - n[1] * b, v[2] - n[2] * b];
}
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function norm3(a) { const l = Math.hypot(a[0], a[1], a[2]); return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; }

// Q3 PM_SlideMove: up to 4 bumps, <= 5 clip planes, creases (cross of two planes), stop dead on a third. Returns "bumped".
export function slideMove(ps, cw) {
  const v = ps.vel;
  if (v[0] === 0 && v[1] === 0 && v[2] === 0) return false;
  const planes = [norm3(v)];
  if (ps.grounded) planes.push(ps.gnormal);   // never turn against the ground
  let left = DT, bumped = false;
  for (let bump = 0; bump < 4; bump++) {
    const end = [ps.pos[0] + v[0] * left, ps.pos[1] + v[1] * left, ps.pos[2] + v[2] * left];
    const tr = ptrace(cw, ps.pos, end);
    if (tr.allsolid) { v[1] = 0; return true; }
    if (tr.fraction > 0) ps.pos = tr.endpos;
    if (tr.fraction === 1) break;
    bumped = true;
    left -= left * tr.fraction;
    if (planes.length >= 5) { v[0] = v[1] = v[2] = 0; return true; }
    const n = tr.normal;
    let same = false;
    for (const p of planes) if (dot3(n, p) > 0.99) { v[0] += n[0]; v[1] += n[1]; v[2] += n[2]; same = true; break; }
    if (same) continue;
    planes.push(n);
    for (let i = 0; i < planes.length; i++) {
      if (dot3(v, planes[i]) >= 0.1) continue;
      let cv = clipVel(v, planes[i]);
      for (let j = 0; j < planes.length; j++) {
        if (j === i || dot3(cv, planes[j]) >= 0.1) continue;
        cv = clipVel(cv, planes[j]);
        if (dot3(cv, planes[i]) >= 0) continue;
        const dir = norm3(cross3(planes[i], planes[j]));   // slide along the crease
        const d = dot3(dir, v);
        cv = [dir[0] * d, dir[1] * d, dir[2] * d];
        for (let k = 0; k < planes.length; k++) {
          if (k === i || k === j || dot3(cv, planes[k]) >= 0.1) continue;
          v[0] = v[1] = v[2] = 0;   // third plane: stop dead
          return true;
        }
      }
      v[0] = cv[0]; v[1] = cv[1]; v[2] = cv[2];
      break;
    }
  }
  return bumped;
}

// slide; if that bumped, also try up STEP -> slide -> down, and keep the stepped result if it got further and ends on
// a walkable floor
export function stepSlideMove(ps, cw) {
  const start = ps.pos.slice(), v0 = ps.vel.slice();
  if (!slideMove(ps, cw)) return;
  const aPos = ps.pos.slice(), aVel = ps.vel.slice();
  const down = ptrace(cw, start, [start[0], start[1] - STEP, start[2]]);
  if (aVel[1] > 0 && (down.fraction === 1 || down.normal[1] < MIN_WALK_NY)) return;   // rising, nothing to step on
  const up = ptrace(cw, start, [start[0], start[1] + STEP + STEP_SLACK, start[2]]);
  if (up.allsolid) return;
  const h = up.endpos[1] - start[1];
  if (h < 0.01) return;
  ps.pos = up.endpos; ps.vel = v0;
  slideMove(ps, cw);
  const d = ptrace(cw, ps.pos, [ps.pos[0], ps.pos[1] - h - 0.05, ps.pos[2]]);
  const dxA = Math.hypot(aPos[0] - start[0], aPos[2] - start[2]);
  const dxB = Math.hypot(ps.pos[0] - start[0], ps.pos[2] - start[2]);
  if (!d.allsolid && d.fraction < 1 && d.normal[1] >= MIN_WALK_NY && dxB > dxA + 0.0005) {
    ps.pos = d.endpos;
    ps.vel = clipVel(ps.vel, d.normal);
  } else { ps.pos = aPos; ps.vel = aVel; }
}

// Q3 CorrectAllSolid: nudge out of geometry, else go back to the last good position, else flag stuck (World respawns)
function unstick(ps, cw) {
  if (!hullSolid(cw, ps.pos)) return;
  for (const r of [0.01, 0.02, 0.04, 0.08, 0.16, 0.3]) {
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) {
      if (!i && !j && !k) continue;
      const p = [ps.pos[0] + i * r, ps.pos[1] + j * r, ps.pos[2] + k * r];
      if (!hullSolid(cw, p)) { ps.pos = p; return; }
    }
  }
  ps.pos = ps.lastGood.slice();
  if (hullSolid(cw, ps.pos)) ps.stuck = true;
}

// leave the ground (jump, dodge, shield): the mover's velocity joins ours
function launch(ps) {
  if (!ps.grounded) return;
  ps.vel[0] += ps.groundVel[0]; ps.vel[1] += ps.groundVel[1]; ps.vel[2] += ps.groundVel[2];
  ps.grounded = false; ps.groundMover = -1; ps.groundVel = [0, 0, 0];
}

export const dodgeVec = (d, f, r) => (d === DODGE.F ? f : d === DODGE.B ? [-f[0], 0, -f[2]] : d === DODGE.L ? [-r[0], 0, -r[2]] : r);

// a near-vertical wall within WALL_RANGE of the hull (swept over its full height) behind the dodge direction or beside it, whatever way it
// faces: its normal or null
export function findWall(ps, cw, dir) {
  const perp = [-dir[2], 0, dir[0]];
  for (const d of [[-dir[0], 0, -dir[2]], perp, [-perp[0], 0, -perp[2]]]) {
    const tr = ptrace(cw, ps.pos, [ps.pos[0] + d[0] * WALL_RANGE, ps.pos[1], ps.pos[2] + d[2] * WALL_RANGE]);
    if (tr.fraction < 1 && !tr.startsolid && Math.abs(tr.normal[1]) < WALL_NY) return tr.normal;
  }
  return null;
}

// Every deliberate ground takeoff (jump, dodge, shield launch) leaves at no more than RUN: speed carried over a landing
// (a dodge, a blast, a pad) is bled by friction, so a chain of hops can never build speed. Walking off an edge is not clamped.
function takeoffClamp(ps) {
  if (!ps.grounded) return;
  const v = ps.vel, h = Math.hypot(v[0], v[2]);
  if (h <= RUN) return;
  const k = RUN / h;
  v[0] *= k; v[1] *= k; v[2] *= k;
}

// the dodge velocity (UT PerformDodge: 1.5 · GroundSpeed · Dir + (V · Cross) · Cross): the speed along dir is SET to DODGE_XY (faster or
// slower than before), the sideways part is kept, vertical speed vy
function doDodge(ps, dir, vy) {
  const v = ps.vel;
  const along = v[0] * dir[0] + v[2] * dir[2];
  v[0] += dir[0] * (DODGE_XY - along); v[2] += dir[2] * (DODGE_XY - along);
  v[1] = vy;
  launch(ps);
  ps.dodging = true; ps.dodgeT = ps.t;
}

// The UT2004 shield gun on a surface: a ray of SH_RANGE from the body centre along the view; a hit pushes the player back along the aim,
// SH_IMIN .. SH_IMAX over a hold of SH_MIN_HOLD .. CHARGE_T. Order as in UT (TakeDamage, then AddVelocity): the ground lift, the halving check on the
// current velocity, the add. A jump a few ticks ago counts as the moment of the release (the windows stack in either order): the lift applies and
// vy is topped up to a full jump, which is what the release-first order gives too.
function blast(ps, cw, emit) {
  const c = ps.charge;
  ps.charge = 0; ps.charging = false; ps.shieldLock = LOCK_T; ps.blastFlash = ps.t;
  const aim = aimOf(ps.yaw, ps.pitch);
  const o = [ps.pos[0], ps.pos[1] + HULL_HY, ps.pos[2]], end = [o[0] + aim[0] * SH_RANGE, o[1] + aim[1] * SH_RANGE, o[2] + aim[2] * SH_RANGE];
  const tr = cw.traceRay(o, end);
  if (tr.fraction >= 1) {
    emit('blast', { pos: end, normal: null, dir: aim, charge: c, hit: false });
    return;
  }
  const m = SH_IMIN + (SH_IMAX - SH_IMIN) * ((clamp(c * CHARGE_T, SH_MIN_HOLD, CHARGE_T) - SH_MIN_HOLD) / (CHARGE_T - SH_MIN_HOLD));
  const J = [-aim[0] * m, -aim[1] * m, -aim[2] * m];
  const v = ps.vel;
  const stacked = ps.t - ps.lastJumpT <= COMBO_TICKS;
  if (ps.grounded || stacked) J[1] = Math.max(J[1], SH_LIFT * m);
  if (stacked) v[1] = Math.max(v[1], JUMP_V);
  const fromGround = ps.grounded;   // (the lift makes every push from the ground an upward one: it always leaves the ground)
  if (fromGround) { takeoffClamp(ps); launch(ps); ps.noSnap = NOSNAP_T; }
  if (v[1] > SH_HALVE_VY && J[1] > 0) J[1] *= 0.5;
  v[0] += J[0]; v[1] += J[1]; v[2] += J[2];
  if (fromGround) { ps.blastGround = true; ps.blastT = ps.t; ps.blastVy = v[1]; } else ps.blastGround = false;
  emit('blast', { pos: tr.endpos.slice(), normal: tr.normal.slice(), dir: aim, charge: c, hit: true });
}

// Pads and anything else that throws the player along a ballistic arc to a target (feet position) peaking at apex
export function padLaunch(ps, pad) {
  const y0 = ps.pos[1], g = G;
  const vy = Math.sqrt(2 * g * Math.max(0.01, pad.apex - y0));
  const t = vy / g + Math.sqrt(2 * Math.max(0.01, pad.apex - pad.target[1]) / g);
  launch(ps);
  ps.vel = [(pad.target[0] - ps.pos[0]) / t, vy, (pad.target[2] - ps.pos[2]) / t];
  ps.noSnap = NOSNAP_T; ps.padCd = PAD_CD_T;
  ps.djUsed = false; ps.wallUsed = false; ps.dodging = false; ps.blastGround = false; ps.djBuf = false;
  ps.lastJumpT = -999; ps.dodgeT = -999;   // a jump or dodge a moment ago must not turn the pad's flight into a dodge arc
}

function groundMove(ps, wx, wz, wl) {
  const v = ps.vel;
  let vx = v[0], vz = v[2];
  const speed = Math.hypot(vx, vz);
  if (wl === 0) {
    if (speed > 0) {
      const ns = Math.max(0, speed - Math.max(speed, STOP) * FRICTION * DT);
      const k = ns / speed;
      vx *= k; vz *= k;
    }
  } else {
    const k = Math.min(1, FRICTION * DT);   // UT: the velocity swings toward the wish direction, then accelerates
    vx -= (vx - wx * speed) * k; vz -= (vz - wz * speed) * k;
    vx += wx * ACCEL * DT; vz += wz * ACCEL * DT;
    const cap = RUN * Math.min(1, wl);
    const s2 = Math.hypot(vx, vz);
    if (s2 > cap) {   // above run speed on the ground: friction bleeds it down to run speed
      const ns = Math.max(cap, s2 - FRICTION * s2 * DT);
      vx *= ns / s2; vz *= ns / s2;
    }
  }
  const n = ps.gnormal;
  v[0] = vx; v[2] = vz; v[1] = n[1] > 0.01 ? -(n[0] * vx + n[2] * vz) / n[1] : 0;   // follow the slope
}

// UT air control: the wish direction adds AIR_CONTROL · ACCEL · DT, then the horizontal speed is capped at max(what it was,
// RUN): you can steer a dodge / blast / pad speed above RUN, never gain it, and below RUN you can reach RUN at most.
function airMove(ps, wx, wz, wl) {
  const v = ps.vel;
  if (wl > 0) {
    const old = Math.hypot(v[0], v[2]), a = AIR_CONTROL * ACCEL * DT;
    v[0] += wx * a; v[2] += wz * a;
    const lim = Math.max(old, RUN), now = Math.hypot(v[0], v[2]);
    if (now > lim) { const k = lim / now; v[0] *= k; v[2] *= k; }
  }
  v[1] -= G * DT * 0.5;
}

export function categorize(ps, cw, emit) {
  const was = ps.grounded;
  const tr = ptrace(cw, ps.pos, [ps.pos[0], ps.pos[1] - GROUND_D, ps.pos[2]]);
  let ok = ps.noSnap === 0 && tr.fraction < 1 && tr.normal[1] >= MIN_WALK_NY;
  let gv = ZERO;
  if (ok) {
    if (tr.mover >= 0) gv = cw.movers[tr.mover].vel || ZERO;
    // velocity relative to the new ground
    const v = ps.vel, og = ps.groundVel;
    const rel = was && tr.mover === ps.groundMover ? v
      : was ? [v[0] + og[0] - gv[0], v[1] + og[1] - gv[1], v[2] + og[2] - gv[2]]
        : [v[0] - gv[0], v[1] - gv[1], v[2] - gv[2]];
    if (dot3(rel, tr.normal) > 0.2) ok = false; else ps.vel = rel === v ? v : rel;
  }
  if (ok) {
    if (!was) {
      emit('land', { speed: Math.max(0, -ps.fallV), pos: ps.pos.slice() });
      ps.djUsed = false; ps.wallUsed = false; ps.blastGround = false; ps.djBuf = false;
      if (ps.dodging) { ps.dodging = false; ps.dodgeCd = DODGE_CD_T; }
    }
    ps.grounded = true; ps.gnormal = tr.normal; ps.groundMover = tr.mover; ps.groundVel = gv === ZERO ? [0, 0, 0] : gv.slice();
  } else {
    if (was) { ps.vel[0] += ps.groundVel[0]; ps.vel[1] += ps.groundVel[1]; ps.vel[2] += ps.groundVel[2]; }
    ps.grounded = false; ps.groundMover = -1; ps.groundVel = [0, 0, 0];
    ps.gnormal = [0, 1, 0];
  }
}

// One tick. emit(type, data) receives the events.
export function stepPlayer(ps, cmd, cw, emit) {
  ps.t++;
  ps.prevPos[0] = ps.pos[0]; ps.prevPos[1] = ps.pos[1]; ps.prevPos[2] = ps.pos[2];
  ps.prevYaw = ps.yaw; ps.prevPitch = ps.pitch;
  ps.yaw = cmd.yaw; ps.pitch = clamp(cmd.pitch, -MAX_PITCH, MAX_PITCH);
  if (ps.dodgeCd > 0) ps.dodgeCd--;
  if (ps.noSnap > 0) ps.noSnap--;
  if (ps.shieldLock > 0) ps.shieldLock--;
  if (ps.padCd > 0) ps.padCd--;
  unstick(ps, cw);

  const fwdH = fwdOf(ps.yaw), rightH = rightOf(ps.yaw);
  let wx = fwdH[0] * cmd.fwd + rightH[0] * cmd.side, wz = fwdH[2] * cmd.fwd + rightH[2] * cmd.side;
  const wl = Math.hypot(wx, wz);
  if (wl > 0) { wx /= wl; wz /= wl; }

  const press = cmd.jump && !ps.prevJump;   // only a fresh press jumps: holding Space never re-jumps
  ps.prevJump = cmd.jump;

  // dodge: on the ground; in the air either the jump-first conversion (a jump a moment ago turns into a ground dodge on
  // the same arc, with the double jump buffered) or a wall dodge (no diagonal jump: dodged / dodgeT stay clear of it, so the
  // double jump after a wall dodge is always an immediate press)
  let dodged = false;
  if (cmd.dodge) {
    const dir = dodgeVec(cmd.dodge, fwdH, rightH);
    if (ps.grounded) {
      if (ps.dodgeCd === 0) { takeoffClamp(ps); doDodge(ps, dir, DODGE_Y); ps.noSnap = NOSNAP_T; emit('dodge', { dir }); dodged = true; }
    } else {
      const n = ps.wallUsed ? null : findWall(ps, cw, dir);   // a wall in reach: a wall dodge (once per airtime), never the conversion
      if (n) {   // it gives the double jump back and drops a waiting diagonal-jump buffer: the next Space is an immediate double jump
        // (and it closes the jump / shield combo windows: a shield release or a Space within COMBO_TICKS of the takeoff must not lift the fixed vy back up)
        doDodge(ps, dir, DODGE_Y); ps.dodgeT = -999; ps.wallUsed = true; ps.djUsed = false; ps.djBuf = false; ps.lastJumpT = -999; ps.blastGround = false;
        emit('walldodge', { dir, normal: n });
      }
      else if (ps.t - ps.lastJumpT <= DODGE_JUMP_TICKS && ps.blastFlash < ps.lastJumpT && !ps.dodging && !ps.wallUsed && !ps.djUsed && ps.dodgeCd === 0) {
        // the dodge arc as if it had started at the jump's takeoff: same arc whichever key came first, and relative to the ground we jumped
        // from (a moving platform, a lift) like the same-tick and dodge-first orders: take its velocity out, convert, put it back
        const gv = ps.jumpGV, rise = ps.pos[1] - ps.jumpY - gv[1] * (ps.t - ps.lastJumpT) * DT;
        ps.vel[0] -= gv[0]; ps.vel[2] -= gv[2];
        doDodge(ps, dir, Math.sqrt(Math.max(0, DODGE_Y * DODGE_Y - 2 * G * rise)) + gv[1]);
        ps.vel[0] += gv[0]; ps.vel[2] += gv[2];
        ps.djBuf = true; ps.lastJumpT = -999;
        emit('dodge', { dir, late: true }); dodged = true;
      }
    }
  }

  // jump / double jump
  if (press) {
    if (dodged) ps.djBuf = !ps.djUsed;   // jump and a ground dodge / conversion together (the diagonal jump): the double jump waits for the apex
    else if (ps.grounded) {
      takeoffClamp(ps);
      ps.jumpY = ps.pos[1]; ps.jumpGV = ps.groundVel.slice();
      ps.vel[1] = JUMP_V; launch(ps);
      ps.noSnap = NOSNAP_T; ps.lastJumpT = ps.t;
      emit('jump', { combo: false });
    } else if (ps.t - ps.dodgeT <= DODGE_JUMP_TICKS && !ps.djUsed && !ps.djBuf) {   // a ground dodge / conversion just happened: same buffer (never after a wall dodge)
      ps.djBuf = true;
    } else if (ps.blastGround && ps.t - ps.blastT <= COMBO_TICKS) {   // jump right after a shield launch from the floor
      ps.vel[1] = Math.max(ps.vel[1], ps.blastVy + JUMP_V);
      ps.blastGround = false;
      emit('jump', { combo: true });
    } else if (!ps.djUsed && ps.vel[1] < DJ_V) {   // always (vy is SET to DJ_V); rising faster than that the press is ignored and not spent
      ps.vel[1] = DJ_V; ps.djUsed = true; ps.djBuf = false;
      emit('dj', {});
    }
  }
  // the buffered double jump fires by itself at the apex (a wall dodge / blast before it only postpones it)
  if (ps.djBuf && !ps.grounded && ps.vel[1] <= 0) {
    ps.djBuf = false;
    if (!ps.djUsed) { ps.vel[1] = DJ_V; ps.djUsed = true; emit('dj', { auto: true }); }
  }

  // shield gun
  if (ps.shieldLock > 0) { ps.charging = false; ps.charge = 0; }   // (UT: the fire press is refused until NextFireTime = release + FireRate: the hold starts after the lock)
  else if (cmd.fire) {
    if (!ps.charging) { ps.charging = true; emit('shieldCharge', { on: true }); }
    ps.charge = Math.min(1, ps.charge + DT / CHARGE_T);
  } else if (ps.charging) {
    emit('shieldCharge', { on: false });
    blast(ps, cw, emit);
  }

  // move
  if (ps.grounded) {
    ps.fallV = 0;
    groundMove(ps, wx, wz, wl);
    stepSlideMove(ps, cw);
    if (ps.noSnap === 0) {   // stay glued to ramps and small drops
      const tr = ptrace(cw, ps.pos, [ps.pos[0], ps.pos[1] - STEP - 0.05, ps.pos[2]]);
      if (tr.fraction < 1 && tr.normal[1] >= MIN_WALK_NY) ps.pos = tr.endpos;
    }
  } else {
    airMove(ps, wx, wz, wl);
    ps.fallV = ps.vel[1];
    stepSlideMove(ps, cw);
    ps.vel[1] -= G * DT * 0.5;
  }
  const sp = Math.hypot(ps.vel[0], ps.vel[1], ps.vel[2]);
  if (sp > VMAX) { const k = VMAX / sp; ps.vel[0] *= k; ps.vel[1] *= k; ps.vel[2] *= k; }

  categorize(ps, cw, emit);
  if (!hullSolid(cw, ps.pos)) { ps.lastGood[0] = ps.pos[0]; ps.lastGood[1] = ps.pos[1]; ps.lastGood[2] = ps.pos[2]; }
}
