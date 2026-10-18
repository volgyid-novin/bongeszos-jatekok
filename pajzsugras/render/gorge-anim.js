// Which Gorge animation a runner should play: pure logic, no three.js. The figures feed it every frame and cross-fade to the clip it
// asks for. The sim has no animation state, so everything is derived from what a figure gets anyway: its feet position, yaw and flags.
//
//   const brain = new AnimBrain();
//   const o = brain.update(dt, { pos: [x, y, z], yaw, flags, infer: false });
//   o = { clip, loop, fade, timeScale, seq, speed, dir, air }
//     clip       the UT2004 sequence name ('Idle_Rifle', 'RunF', 'JumpL_Mid', 'DoubleJumpB', 'DodgeR', 'WallDodgeF', 'gesture_cheer' ...)
//     loop       true: repeat it; false: play once and hold the last pose
//     fade       seconds to cross-fade from the previous clip
//     timeScale  playback speed (runs follow the ground speed)
//     seq        counts up every time a clip is (re)triggered: the same name with a new seq restarts it (two dodges in a row)
//   speed = horizontal ground speed m/s, dir = 'F' | 'B' | 'L' | 'R' (velocity relative to the facing), air = off the ground
// Real flags (the local sim, race peers): GROUND decides the air state, the DODGING / WALL and DJ_USED edges start the dodge / wall dodge /
// double jump clips (the dodge direction = how the velocity changed, relative to the yaw of the edge), FINISHED while standing starts the
// cheer. Recorded ghosts only have positions (flags are a constant, 10 or 20 Hz samples): pass infer: true and the air state is derived from
// the vertical motion alone (a free fall is a vertical acceleration of -G, sustained; a step-up or a stair is not).
// A non-finite position sample is ignored (its time goes to the next one), so one bad packet cannot poison the state.
import { FLAG, G, RUN } from '../sim/const.js';
import { fwdOf, rightOf, angDiff } from '../sim/math.js';

const TELEPORT = 8;            // m in one update: a respawn / restart, forget the history
const V_TAU = 0.06;            // s, smoothing of the velocity estimate
const IDLE_BELOW = 0.6;        // m/s: standing still under this, with +-0.1 hysteresis
const SLOW_AIR = 1.0;          // m/s: slower than this the jump has no direction (Jump_* instead of JumpF_*)
const AIR_DEBOUNCE = 0.05;     // s off the ground (real flags) before the air animations start: a bump is not a jump
const WALK_OFF_VY = 1;         // m/s: leaving the ground slower than this upwards is a walk-off (no take-off clip)
const LAND_MIN_AIR = 0.2;      // s in the air before the landing pose is shown
const LAND_HOLD = 0.12;        // s the landing pose is held
const PEND = 0.05;             // s between a dodge / double jump flag and its clip: the velocity has to show the new direction first
const PEND_MAX = 0.12;         // s: a dodge whose push never shows in the velocity (already faster than a dodge along it) is classified by then
const DODGE_DV = 3;            // m/s of velocity change that counts as 'the dodge push is visible'
const SECTOR_HYST = 10 * Math.PI / 180;
const MIN_SCALE = 0.35, MAX_SCALE = 1.6;   // run clip speed limits
export const CLIP_LEN = { takeoff: 0.25, dj: 0.45, dodge: 0.4, wallDodge: 0.367, cheer: 2.4 };   // seconds, the extracted clips

// infer mode: a free fall has a vertical second difference of -G over 0.1 s windows (10 Hz recordings); ramps and stairs do not
const INFER_H = 0.1;           // s, window (= the coarsest ghost sample spacing)
const INFER_LO = -1.35 * G, INFER_HI = -0.65 * G;   // acceleration band that counts as a fall (a free fall sits at -G)
const INFER_ENTER_T = 0.09;    // s in the band, in a row, before the air state starts: a 10 / 20 Hz step-up of up to 35 cm has a fall-like second difference for under 0.09 s
const INFER_CALM = -0.35 * G;  // above this the motion is no longer a fall
const INFER_CALM_T = 0.25;     // s of calm that ends the air state even when the vertical speed is still large (landing on a slope)
const INFER_BACKDATE = 0.25;   // s: the fall had already been going on about this long when it was noticed (the window + INFER_ENTER_T): straight to the Mid pose

const DIRS = ['F', 'R', 'B', 'L'];
const CENTRE = [0, Math.PI / 2, Math.PI, -Math.PI / 2];

export class AnimBrain {
  constructor() { this.reset(); }

  reset() {
    this.have = false;
    this.px = this.py = this.pz = 0;
    this.vx = this.vz = 0;               // smoothed horizontal velocity
    this.rvx = this.rvz = 0;             // raw velocity of the last update
    this.dirI = 0;
    this.moving = false;
    this.air = false; this.airT = 0; this.offT = 0;
    this.landT = 0; this.landPre = 'Jump';
    this.pf = 0;                         // previous flags
    this.gap = 0;                        // time of the ignored (non-finite) samples, added to the next good one
    this.pending = [];                   // dodge / wall dodge / double jump edges waiting for their direction (one each: they can come in one frame)
    this.over = null;                    // the running one-shot override { clip, t, fade }
    this.queued = [];                    // one-shots that came while another one was playing: they follow it, in order
    this.cheered = false; this.triggered = false;
    this.time = 0;
    this.hist = [];                      // infer mode: [t, y] samples
    this.fall = false; this.candFrom = -1; this.calmT = 0;
    this.seq = 0;
    this.last = { clip: 'Idle_Rifle', loop: true, fade: 0, timeScale: 1, seq: 0, speed: 0, dir: 'F', air: false };
  }

  update(dt, { pos, yaw = 0, flags = 0, infer = false }) {
    dt = dt > 0 ? Math.min(Math.max(dt, 1e-3), 0.25) : 1e-3;   // (also catches NaN)
    // a bad sample (a NaN / Infinity position out of a corrupt packet, a division upstream) is ignored; its time is added to the next good one
    if (!Number.isFinite(pos[0] + pos[1] + pos[2])) { this.gap = Math.min(0.25, this.gap + dt); return this.last; }
    dt = Math.min(0.25, dt + this.gap); this.gap = 0;
    if (!Number.isFinite(yaw)) yaw = 0;
    flags |= 0;
    this.time += dt;
    // velocity: raw from the position difference, smoothed for the clip choice
    if (this.have && Math.hypot(pos[0] - this.px, pos[1] - this.py, pos[2] - this.pz) > TELEPORT) {
      const t = this.time;
      this.reset();
      this.time = t;
    }
    const pvx = this.vx, pvz = this.vz;      // the smoothed velocity of the frame before: what a dodge pushes off from
    if (this.have) {
      this.rvx = (pos[0] - this.px) / dt; this.rvz = (pos[2] - this.pz) / dt; this.rvy = (pos[1] - this.py) / dt;
      const k = 1 - Math.exp(-dt / V_TAU);
      this.vx += (this.rvx - this.vx) * k; this.vz += (this.rvz - this.vz) * k;
    }
    this.px = pos[0]; this.py = pos[1]; this.pz = pos[2]; this.have = true;
    const speed = Math.hypot(this.vx, this.vz);
    if (speed > 0.3) this.dirI = pickDir(this.vx, this.vz, yaw, this.dirI);   // (no direction while nearly standing: keep the last one)
    const dirName = DIRS[this.dirI];
    if (this.moving ? speed < IDLE_BELOW - 0.1 : speed > IDLE_BELOW + 0.1) this.moving = !this.moving;

    // ground contact
    let grounded;
    if (infer) grounded = !this.inferAir(dt, pos[1]);
    else grounded = (flags & FLAG.GROUND) !== 0;
    if (!grounded) this.offT += dt; else this.offT = 0;
    const wantAir = !grounded && (infer || this.offT >= AIR_DEBOUNCE);
    if (wantAir && !this.air) {
      this.air = true;
      this.airT = infer ? INFER_BACKDATE : this.offT;
      this.walkOff = !infer && !(this.rvy >= WALK_OFF_VY);   // walked off an edge: straight to the falling pose, no take-off
      this.landT = 0;
    } else if (this.air && grounded) {
      if (this.airT >= LAND_MIN_AIR) { this.landT = LAND_HOLD; this.landPre = speed < SLOW_AIR ? 'Jump' : 'Jump' + dirName; }
      this.air = false; this.over = this.over && this.over.kind === 'cheer' ? this.over : null; this.pending = []; this.queued = [];
    }
    if (this.air) this.airT += dt;
    if (this.landT > 0) this.landT -= dt;

    // flag edges (real flags only): dodge, wall dodge, double jump, the finish cheer
    if (!infer) {
      const dodgeEdge = (flags & FLAG.DODGING) && !(this.pf & FLAG.DODGING);
      const wallEdge = (flags & FLAG.WALL) && !(this.pf & FLAG.WALL);   // (a wall dodge after a ground dodge has no DODGING edge: DODGING is still set)
      const djEdge = (flags & FLAG.DJ_USED) && !(this.pf & FLAG.DJ_USED);
      // a dodge is read at the yaw of the edge, from how the velocity CHANGED (the push is exactly along the dodge direction, whatever the
      // run it started from); a race peer's flags lead its interpolated position by up to a packet (50 ms), so the change is awaited
      // (a double jump pressed with or right after a wall dodge, the UT2004 combo, is a second edge: both are kept)
      if (dodgeEdge || wallEdge) this.pending.push({ kind: flags & FLAG.WALL ? 'wallDodge' : 'dodge', t: 0, yaw, vx0: pvx, vz0: pvz, dx: 0, dz: 0 });
      if (djEdge) this.pending.push({ kind: 'dj', t: 0, yaw, vx0: pvx, vz0: pvz, dx: 0, dz: 0 });
      if (!(flags & FLAG.FINISHED)) this.cheered = false;
      else if (!this.cheered && grounded && !this.moving && !this.over) { this.cheered = true; this.trigger('gesture_cheer', CLIP_LEN.cheer, 0.2, 'cheer'); }
      this.pf = flags;
    }
    let waiting = false;   // an older dodge edge that is still waiting for its direction: a double jump after it waits too, so the clips keep their order
    for (const p of this.pending.slice()) {
      p.t += dt;
      const dx = this.rvx - p.vx0, dz = this.rvz - p.vz0;
      if (Math.hypot(dx, dz) > Math.hypot(p.dx, p.dz)) { p.dx = dx; p.dz = dz; }   // (the largest change seen: the whole push, not a half-interpolated frame)
      const pushed = Math.hypot(p.dx, p.dz) > DODGE_DV;
      if (p.t >= PEND && (p.kind === 'dj' || pushed || p.t >= PEND_MAX) && !(p.kind === 'dj' && waiting)) {
        this.pending.splice(this.pending.indexOf(p), 1);
        const byChange = p.kind !== 'dj' && pushed;
        const ux = byChange ? p.dx : this.rvx, uz = byChange ? p.dz : this.rvz;
        const slow = Math.hypot(ux, uz) < SLOW_AIR;
        const d = DIRS[pickDir(ux, uz, p.kind === 'dj' ? yaw : p.yaw, 0)];
        if (p.kind === 'dj') this.trigger('DoubleJump' + (slow ? '' : d), CLIP_LEN.dj, 0.06, 'dj');
        else if (p.kind === 'dodge') this.trigger('Dodge' + (slow ? 'F' : d), CLIP_LEN.dodge, 0.06, 'dodge');
        else this.trigger('WallDodge' + (slow ? 'F' : d), CLIP_LEN.wallDodge, 0.06, 'wallDodge');
      } else if (p.kind !== 'dj') waiting = true;
    }
    if (this.over) {
      this.over.t -= dt;
      if (this.over.t <= 0 || (this.over.kind === 'cheer' && (this.moving || this.air))) this.over = null;
    }
    if (!this.over && this.queued.length) { this.over = this.queued.shift(); this.triggered = true; }   // the next one-shot starts when the one before it ends

    // the clip
    let clip, loop = true, fade = 0.15, timeScale = 1;
    if (this.over) { clip = this.over.clip; loop = false; fade = this.over.fade; }
    else if (this.air) {
      const pre = speed < SLOW_AIR ? 'Jump' : 'Jump' + dirName;
      if (this.airT < CLIP_LEN.takeoff && !this.walkOff) { clip = pre + '_Takeoff'; loop = false; fade = 0.08; }
      else { clip = pre + '_Mid'; loop = false; }   // the falling pose plays once and is held (UT2004), not cycled
    } else if (this.landT > 0) { clip = this.landPre + '_Land'; loop = false; fade = 0.05; }
    else if (this.moving) { clip = 'Run' + dirName; timeScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, speed / RUN)); }
    else { clip = 'Idle_Rifle'; fade = 0.2; }
    const prev = this.last;
    if (clip !== prev.clip || this.triggered) this.seq++;
    this.triggered = false;
    this.last = { clip, loop, fade, timeScale, seq: this.seq, speed, dir: dirName, air: this.air };
    return this.last;
  }

  // a one-shot clip: it plays at once (and replaces the one that is playing), except a double jump that comes while a dodge / wall dodge is
  // still playing (the UT2004 combo): that one follows it
  trigger(clip, len, fade, kind) {
    const one = { clip, kind, t: len, fade };
    if (kind === 'dj' && this.over && (this.over.kind === 'dodge' || this.over.kind === 'wallDodge')) { this.queued.push(one); return; }
    this.over = one;
    this.triggered = true;
  }

  // infer mode: is this a free fall? true = off the ground
  inferAir(dt, y) {
    const h = this.hist;
    h.push(this.time, y);
    while (h.length > 4 && h[2] < this.time - 0.5) h.splice(0, 2);
    const at = (tt) => {   // y at time tt, linearly interpolated (the oldest sample when tt is before the history)
      if (tt <= h[0]) return h[1];
      for (let i = h.length - 2; i >= 0; i -= 2) if (h[i] <= tt) { const n = i + 2 < h.length ? i + 2 : i; const f = n === i ? 0 : (tt - h[i]) / (h[n] - h[i]); return h[i + 1] + (h[n + 1] - h[i + 1]) * f; }
      return h[1];
    };
    if (this.time - h[0] < 2 * INFER_H - 1e-6) return this.fall;   // not enough history yet
    const y0 = at(this.time), y1 = at(this.time - INFER_H), y2 = at(this.time - 2 * INFER_H);
    const a = (y0 - 2 * y1 + y2) / (INFER_H * INFER_H), v = (y0 - y1) / INFER_H;
    if (!this.fall) {
      // (timed from the first frame in the band to this one, so the frame rate does not stretch a short band)
      if (a < INFER_HI && a > INFER_LO) { if (this.candFrom < 0) this.candFrom = this.time; } else this.candFrom = -1;
      if (this.candFrom >= 0 && this.time - this.candFrom >= INFER_ENTER_T) { this.fall = true; this.calmT = 0; }
    } else if (a >= INFER_CALM) {
      this.calmT += dt;
      if (Math.abs(v) < 2 || this.calmT >= INFER_CALM_T) { this.fall = false; this.candFrom = -1; }
    } else this.calmT = 0;
    return this.fall;
  }
}

// 0 F, 1 R, 2 B, 3 L: the velocity direction relative to the facing, with hysteresis around the current sector (cur < 0 = none)
function pickDir(vx, vz, yaw, cur) {
  const f = fwdOf(yaw), r = rightOf(yaw);
  const ang = Math.atan2(vx * r[0] + vz * r[2], vx * f[0] + vz * f[2]);   // 0 = forward, +90 deg = right
  if (cur >= 0 && Math.abs(angDiff(ang, CENTRE[cur])) <= Math.PI / 4 + SECTOR_HYST && (vx || vz)) return cur;
  let best = 0, bd = 9;
  for (let i = 0; i < 4; i++) { const d = Math.abs(angDiff(ang, CENTRE[i])); if (d < bd) { bd = d; best = i; } }
  return best;
}
