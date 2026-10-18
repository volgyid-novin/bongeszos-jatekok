// The third-person camera (UT2004's "behindview"): pure math over the sim's CollisionWorld, no three.js, so node tests it directly.
//
//   const cam = new ChaseCam();
//   const c = cam.update(dt, world.cw, head, yaw, pitch);     head = [x, y, z] (the eye), yaw / pitch in radians (the sim's convention)
//   c = { pos: [x, y, z], dist, limit, want, hit, hidden }
//     want    the distance the camera would like to have (about DIST: 3.5 m behind the head along the look direction, RISE above that line)
//     limit   how far the way back is free (a box of BOX swept from the head, MARGIN kept in front of what it hits)
//     dist    where the camera really is (head -> pos): never beyond limit. It is pulled in at once (a camera that eased in would show the
//             inside of the wall for a few frames), and eases back out at OUT_RATE once the wall lets go (no popping)
//     hit     a wall is holding the camera in      hidden  the camera is so close to the head that the player's own figure should not be drawn
//                                                          (hysteresis: hidden below HIDE_IN, shown again past HIDE_OUT)
//   cam.reset() forgets the smoothing (a map change, switching the view on); a jump of the head by more than TELEPORT m does it by itself.
// A non-finite input leaves the camera where it was (the first time: at the head). cw is anything with traceBox(start, end, half).
import { aimOf } from '../sim/math.js';

export const CHASE = {
  DIST: 3.5,        // m behind the head
  RISE: 0.35,       // m above the line behind the head: the figure sits a little below the middle of the picture
  BOX: 0.15,        // half extent of the camera's box (the near plane and a bit): the camera keeps this far from every surface
  MARGIN: 0.1,      // m kept in front of the hit point, on top of the box
  OUT_RATE: 6,      // 1/s: time constant 1/6 s for the camera to ease back out
  HIDE_IN: 0.8,     // m from the head: the figure disappears
  HIDE_OUT: 1.0,    // m from the head: and shows again
  TELEPORT: 6,      // m the head jumps between two updates: respawn / restart, no sliding
};

const finite3 = (v) => Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);

export class ChaseCam {
  constructor() {
    this.half = [CHASE.BOX, CHASE.BOX, CHASE.BOX];
    this.end = [0, 0, 0];
    this.last = [0, 0, 0];
    this.out = { pos: [0, 0, 0], dist: 0, limit: 0, want: CHASE.DIST, hit: false, hidden: false };
    this.reset();
  }

  reset() { this.have = false; this.dist = 0; this.out.hidden = false; this.out.hit = false; }

  update(dt, cw, head, yaw, pitch) {
    const o = this.out;
    if (!finite3(head) || !Number.isFinite(yaw) || !Number.isFinite(pitch)) {
      if (!this.have && finite3(head)) { o.pos[0] = head[0]; o.pos[1] = head[1]; o.pos[2] = head[2]; o.dist = o.limit = 0; }
      return o;
    }
    const a = aimOf(yaw, pitch);
    const ox = -a[0] * CHASE.DIST, oy = -a[1] * CHASE.DIST + CHASE.RISE, oz = -a[2] * CHASE.DIST;
    const want = Math.hypot(ox, oy, oz);   // (never near 0: it is at least DIST - RISE)
    const e = this.end;
    e[0] = head[0] + ox; e[1] = head[1] + oy; e[2] = head[2] + oz;
    const tr = cw.traceBox(head, e, this.half);
    let limit = tr.startsolid ? 0 : tr.fraction * want - (tr.fraction < 1 ? CHASE.MARGIN : 0);   // (the head itself in a wall: no camera, no figure)
    if (!(limit > 0)) limit = 0;
    if (limit > want) limit = want;
    const jump = this.have && Math.hypot(head[0] - this.last[0], head[1] - this.last[1], head[2] - this.last[2]) > CHASE.TELEPORT;
    if (!this.have || jump) this.dist = limit;
    else if (limit <= this.dist) this.dist = limit;
    else {
      const k = 1 - Math.exp(-CHASE.OUT_RATE * (dt > 0 ? Math.min(dt, 1) : 0));   // (a NaN or negative dt eases nothing)
      this.dist += (limit - this.dist) * k;
      if (limit - this.dist < 1e-3) this.dist = limit;
    }
    this.have = true;
    this.last[0] = head[0]; this.last[1] = head[1]; this.last[2] = head[2];
    const f = this.dist / want;
    o.pos[0] = head[0] + ox * f; o.pos[1] = head[1] + oy * f; o.pos[2] = head[2] + oz * f;
    o.dist = this.dist; o.limit = limit; o.want = want; o.hit = limit < want - 1e-6;
    o.hidden = o.hidden ? this.dist < CHASE.HIDE_OUT : this.dist < CHASE.HIDE_IN;
    return o;
  }
}
