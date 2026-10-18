// Technique probes: every movement technique is run by the proof bot on a flat probe arena and its height / distance /
// speed is measured and compared with the numbers of the design brief. Map designers read the reaches (gap sizes) off this table.
// testArena() is also the base of most synthetic test maps (test/synth.mjs builds the course and the routes of the animation / camera tests).
import { defineMap } from '../sim/builder.js';
import { World } from '../sim/world.js';
import { RouteRunner, R } from '../sim/bot.js';
import { makeCmd } from '../sim/pmove.js';
import { yawTo, angDiff, clamp } from '../sim/math.js';
import { RUN, DT } from '../sim/const.js';

// a map made of one big floor (top at y = 0) and whatever fn adds; trivial start / checkpoint / finish / route
export function testArena(fn, id = 'probe') {
  return defineMap({ id, name: 'Próba', diff: 'kikepzes', order: 1, blurb: '', authorTime: 1 }, (b) => {
    b.start([0, 0, 0], 0);
    b.box([-300, -1, -300], [300, 0, 300], { mat: 'floor' });
    fn && fn(b);
    b.checkpoint([200, 0, 200], [201, 2, 201]);
    b.finish([210, 0, 210], [211, 2, 211]);
    b.route([R.wait(0.1)]);
  });
}

// the wall at z = -10 (its face toward +z), 40 m tall, for the wall probes; the side wall: its face at x = 0.9 (toward -x)
const flatMap = testArena();
const wallMap = testArena((b) => { b.box([-40, 0, -12], [40, 40, -10], { mat: 'wall' }); });
const sideMap = testArena((b) => { b.box([0.9, 0, -200], [3, 40, 40], { mat: 'wall' }); });
const front10Map = testArena((b) => { b.box([-60, 0, -40], [60, 40, -10.5], { mat: 'wall' }); });   // a wall face 10.5 m ahead of the start
const front24Map = testArena((b) => { b.box([-60, 0, -60], [60, 40, -24], { mat: 'wall' }); });     // ... and 24 m ahead
const ARENAS = { flat: flatMap, wall: wallMap, side: sideMap, front10: front10Map, front24: front24Map };

const FAR = [0, 0, 250];   // air-steering target far behind the start (the probes run toward -z, wall probes jump away to +z)
const AHEAD = [0, 0, -250];
const L56 = [-207.3, -139.8], R56 = [207.3, -139.8];   // 250 m away, 56° to the left / right of "ahead": where a diagonal jump from a run along -z aims

// ticks of each measure: 'dist' horizontal distance takeoff -> final landing, 'height' max feet height above the takeoff,
// 'speed' horizontal speed when the route ends, 'lat' the sideways (x) part of the distance
// A probe is { id, label, steps | drive, expect, arena?: 'flat' | 'wall' | 'side', start?, yaw?, setup?(world) }. `drive` is a factory of
// a raw per-tick input source (world, tick) => cmd | null (null ends it), for inputs no route step can express.
const diag = (side, to, o = {}) => [R.run(0, -20), R.diagJump(side, { to, approach: 0, ...o })];

// the old strafe-jump input (optimal air strafing, auto-hop = Space pressed again on every landing) as a raw driver: with
// UT air control and the takeoff clamp it must gain nothing
function strafeDriver() {
  const AIR_A = 0.3 * RUN * DT;   // the old Q3 air acceleration, the optimal angle it assumed
  let hops = 0, wasAir = false, side = 1, prevJump = false;
  return (w) => {
    const ps = w.ps, c = makeCmd();
    if (ps.grounded && wasAir) { hops++; wasAir = false; } else if (!ps.grounded) wasAir = true;
    if (hops >= 6) return null;
    c.jump = ps.grounded ? !prevJump : false;   // a fresh press on every landing
    prevJump = c.jump;
    const sp = ps.speed;
    if (sp < 1) { c.yaw = yawTo(0, -1); c.fwd = 1; return c; }
    const Hv = yawTo(ps.vel[0], ps.vel[2]), err = angDiff(yawTo(0, -1), Hv);
    if (Math.abs(err) > 0.5 * Math.PI / 180) side = err > 0 ? 1 : -1;
    const W = Hv + side * Math.acos(clamp((RUN - AIR_A) / sp, 0, 1));
    c.fwd = 1;
    if (side > 0) { c.side = -1; c.yaw = W - Math.PI / 4; } else { c.side = 1; c.yaw = W + Math.PI / 4; }
    return c;
  };
}

export const PROBES = [
  { id: 'jump', label: 'futó ugrás', steps: [R.run(0, -20), R.jump({ to: AHEAD })], expect: { height: [1.16, 1.28], dist: [5.92, 6.54] } },
  { id: 'jump-dj', label: 'ugrás + dupla ugrás', steps: [R.run(0, -20), R.jump({ to: AHEAD, dj: 'apex' })], expect: { height: [2.49, 2.75], dist: [10.6, 11.7] } },
  { id: 'dodge', label: 'kiugrás (dodge)', steps: [R.run(0, -20), R.dodge('F', { to: AHEAD })], expect: { dist: [5.43, 6.0] } },
  { id: 'dodge-dj', label: 'dodge + dupla ugrás (kézzel, csúcson)', steps: [R.run(0, -20), R.dodgeJump('F', { to: AHEAD })], expect: { dist: [13.2, 14.6], height: [1.78, 1.96] } },
  { id: 'dodge-dj-buf', label: 'dodge + SPACE egyszerre (automata dupla ugrás)', steps: [R.run(0, -20), R.diagJump('F', { to: AHEAD })], expect: { dist: [13.2, 14.6], height: [1.78, 1.96] } },
  { id: 'dodge-side', label: 'oldalsó dodge (balra), ugrás nélkül', steps: [R.run(0, -20), R.dodge('L', { to: AHEAD })], expect: { dist: [6.5, 7.2] } },
  { id: 'diag', label: 'átlós ugrás (oldal-dodge + SPACE egyszerre)', steps: diag('L', L56), expect: { height: [1.78, 1.96], dist: [15.8, 17.5], speed: [15.1, 16.6] } },
  { id: 'diag-jfirst', label: 'átlós ugrás: SPACE 3 tickkel előbb', steps: diag('L', L56, { gap: 3 }), expect: { dist: [15.3, 16.9] } },
  { id: 'diag-dfirst', label: 'átlós ugrás: SPACE 3 tickkel később', steps: diag('L', L56, { gap: -3 }), expect: { dist: [15.8, 17.5] } },
  { id: 'diag-late', label: 'átlós ugrás: SPACE 12 tickkel később (ablakon kívül)', steps: diag('L', L56, { gap: -12 }), expect: { dist: [13.7, 15.1] } },
  { id: 'aircontrol', label: 'légi irányítás: álló ugrás + W', steps: [R.jump({ to: AHEAD })], expect: { dist: [3.4, 3.75] } },
  {
    id: 'nobhop', label: 'nincs bunnyhop: 14 m/s-ról 4 egyenes ugrás',
    setup: (w) => { w.ps.vel = [0, 0, -14]; },
    steps: [R.jump({ to: AHEAD }), R.jump({ to: AHEAD }), R.jump({ to: AHEAD }), R.jump({ to: AHEAD })], expect: { speed: [0, 8.81] },
  },
  { id: 'diag-chain', label: 'átlós ugrás, majd ugrás a földetéréskor', steps: [...diag('L', L56), R.jump({ to: AHEAD })], expect: { speed: [0, 8.81] } },
  { id: 'strafe-dead', label: 'strafe ugrás: a régi tökéletes bemenet, 6 ugrás', drive: strafeDriver, expect: { speed: [0, 8.81] } },
  { id: 'shield-tap', label: 'pajzsugrás, koppintás', steps: [R.shieldJump({ charge: 0, to: AHEAD })], expect: { height: [2.15, 2.45] } },
  { id: 'shield-half', label: 'pajzsugrás, fél töltés', steps: [R.shieldJump({ charge: 0.5, to: AHEAD })], expect: { height: [3.9, 4.4] } },
  { id: 'shield-full', label: 'pajzsugrás, teljes töltés', steps: [R.shieldJump({ charge: 1, to: AHEAD })], expect: { height: [6.4, 6.8] } },
  { id: 'shield-full-dj', label: 'teljes pajzsugrás + dupla ugrás', steps: [R.shieldJump({ charge: 1, to: AHEAD, dj: 'apex' })], expect: { height: [7.8, 8.25] } },
  { id: 'shield-gap+4', label: 'pajzsugrás: ugrás előbb (+4 tick)', steps: [R.shieldJump({ charge: 1, gap: 4, to: AHEAD })], expect: { height: [6.4, 7.3] } },
  { id: 'shield-gap-4', label: 'pajzsugrás: lövés előbb (-4 tick)', steps: [R.shieldJump({ charge: 1, gap: -4, to: AHEAD })], expect: { height: [6.4, 7.3] } },
  { id: 'shield-gap+9', label: 'pajzsugrás: ugrás előbb (+9 tick)', steps: [R.shieldJump({ charge: 1, gap: 9, to: AHEAD })], expect: { height: [6.4, 7.3] } },
  { id: 'shield-gap-9', label: 'pajzsugrás: lövés előbb (-9 tick)', steps: [R.shieldJump({ charge: 1, gap: -9, to: AHEAD })], expect: { height: [6.4, 7.3] } },
  {
    id: 'walldodge', label: 'falról kiugrás (ugrás + wall dodge)',
    arena: 'wall', start: [0, 0, -9.5], yaw: 0,
    steps: [R.jump({ to: FAR, air: [R.wallDodge('F', { at: 0.2 })] })], expect: { dist: [7.9, 8.75] },
  },
  {
    id: 'walldodge-side', label: 'falról kiugrás oldalra: a fal a jobb oldalon (0,5 m), kiugrás balra',
    arena: 'side', start: [0, 0, 0], yaw: 0,
    steps: [R.jump({ to: AHEAD, air: [R.wallDodge('L', { at: 0.15 })] })], expect: { lat: [6.5, 7.4], height: [1.2, 1.35] },
  },
  {
    id: 'walldodge-dj', label: 'falról kiugrás + dupla ugrás (SPACE a kiugrás után 0,15 mp-pel)',
    arena: 'wall', start: [0, 0, -9.5], yaw: 0,
    steps: [R.jump({ to: FAR, air: [R.wallDodge('F', { at: 0.2 }), R.doubleJump(0.35)] })], expect: { dist: [13.9, 15.1], height: [2.65, 2.95] },
  },
  {
    id: 'dj-walldodge-dj', label: 'ugrás, dupla ugrás, falról kiugrás, és a visszakapott dupla ugrás',
    arena: 'wall', start: [0, 0, -9.5], yaw: 0,
    steps: [R.jump({ to: FAR, steer: 'act', air: [R.doubleJump(0.05), R.wallDodge('F', { at: 0.25 }), R.doubleJump(0.4)] })], expect: { dist: [14.4, 15.7], height: [3.05, 3.4] },
  },
  {
    id: 'wallboost', label: 'pajzs falról (wall boost, teljes)',
    arena: 'wall', start: [0, 0, -9.5], yaw: 180,
    steps: [R.charge(true, { to: 1 }), R.air([R.wallBoost({ aimAt: [0, 1.6, -10.5], at: 'hit' })], { to: FAR })], expect: { dist: [6.7, 7.4] },
  },
  {
    id: 'shield-run', label: 'futó pajzsugrás (futás közben, előre lökve)',
    steps: [R.run(0, -20), R.shieldJump({ push: [0, -250], pitch: -50, charge: 1, run: [0, -250], to: AHEAD })], expect: { dist: [20.0, 22.1], speed: [13.9, 15.3] },
  },
  {
    id: 'shield-run-dj', label: 'futó pajzsugrás + dupla ugrás',
    steps: [R.run(0, -20), R.shieldJump({ push: [0, -250], pitch: -50, charge: 1, run: [0, -250], to: AHEAD, dj: 'apex' })], expect: { dist: [26.7, 29.5] },
  },
  {
    id: 'diag-wallboost', label: 'átlós ugrás + pajzs a falon (0,9 m-re a repüléstől)',
    arena: 'side', start: [-16.43, 0, -8.82], yaw: -56,   // a 20 m lane at -56° (toward the wall) that ends beside the wall, flying along it
    steps: [R.charge(true, { to: 1 }), R.run(0.15, -20, { tol: 0.2 }), R.diagJump('L', { to: AHEAD, approach: -56, air: [R.wallBoost({ yaw: -90, pitch: -40, at: 0.62 })] })], expect: { height: [2.55, 2.85], dist: [22.6, 25.0] },
  },
  {
    id: 'diag-wd', label: 'átlós ugrás + falról kiugrás előre a fal mentén (a csúcs után; a kiugrás 13,2 m/s-ra állítja a sebességet)',
    arena: 'side', start: [-16.43, 0, -8.82], yaw: -56,
    steps: [R.run(0.4, -20, { tol: 0.2 }), R.diagJump('L', { to: AHEAD, approach: -56, air: [R.wallDodge('F', { at: 0.7 })] })], expect: { height: [2.1, 2.4], dist: [19.8, 21.1] },
  },
  {
    id: 'dodgejump-wd-side', label: 'kiugró ugrás a falnak (10,5 m) + falról kiugrás oldalra (jobbra)',
    arena: 'front10', steps: [R.diagJump('F', { to: [0, 0, -9.9], air: [R.wallDodge(-90, { at: 'wall' })] })], expect: { height: [2.05, 2.3], lat: [8.7, 9.65] },
  },
  {
    id: 'shield-run-dj-wd-side', label: 'futó pajzsugrás + dupla ugrás a falnak (24 m) + falról kiugrás oldalra',
    arena: 'front24', start: [0, 0, 20], yaw: 0, steps: [R.run(0, 0, { tol: 0.5 }), R.shieldJump({ push: [0, -250], pitch: -50, charge: 1, run: [0, -250], to: [0, 0, -23.5], air: [R.doubleJump('apex'), R.wallDodge(-90, { at: 'wall' })] })], expect: { height: [6.0, 6.7], lat: [13.0, 14.4] },
  },
  {
    id: 'shield-wd-dj', label: 'pajzsugrás függőlegesen a falnál + wall dodge a csúcson + dupla ugrás',
    arena: 'wall', start: [0, 0, -9.5], yaw: 0,
    steps: [R.shieldJump({ pitch: -89, charge: 1, to: FAR, steer: 'act', air: [R.wallDodge('F', { at: 'apex' }), R.doubleJump('apex')] })], expect: { dist: [19.6, 21.6], height: [8.0, 8.85], speed: [12.5, 13.9] },
  },
];

export function runProbe(p, opts = {}) {
  const w = new World((ARENAS[p.arena || 'flat']).build());
  w.restart({});
  if (p.start) w.teleport(p.start, (p.yaw || 0) * (Math.PI / 180));
  w.ps.yaw = (p.yaw || 0) * (Math.PI / 180);
  if (p.setup) p.setup(w);
  const runner = p.steps ? new RouteRunner(w, p.steps, { jitter: opts.jitter, seed: opts.seed, maxSeconds: 30 }) : null;
  const drive = p.drive ? p.drive() : null;
  const ps = w.ps;
  let take = null, land = null, maxY = -Infinity, airborne = false;
  let lastGround = ps.pos.slice();
  const t0 = performance.now();
  let n = 0;
  // the route "completes" when its last step is done; the world never finishes in the arena
  for (; n < 3000; n++) {
    if (runner) { if (runner.bot.done) break; runner.tick(); }
    else { const c = drive(w, n); if (!c) break; w.step(c); }
    if (ps.grounded) {
      if (airborne) { land = ps.pos.slice(); airborne = false; }
      lastGround = ps.pos.slice();
    } else {
      if (!airborne) { airborne = true; if (!take) { take = lastGround; maxY = take[1]; } }
      if (ps.pos[1] > maxY) maxY = ps.pos[1];
    }
  }
  const err = runner ? runner.bot.error : null;
  const v = {};
  if (take) v.height = maxY - take[1];
  if (take && land) { v.dist = Math.hypot(land[0] - take[0], land[2] - take[2]); v.lat = Math.abs(land[0] - take[0]); }
  v.speed = ps.speed;
  return { ...v, error: err, ms: performance.now() - t0, ticks: n };
}

// -> [{ id, label, values, expect, ok, fails[] }]
export function runProbes(opts = {}) {
  const rows = [];
  for (const p of PROBES) {
    const r = runProbe(p, opts);
    const fails = [];
    if (r.error) fails.push(r.error);
    for (const [k, [lo, hi]] of Object.entries(p.expect)) {
      if (!(r[k] >= lo && r[k] <= hi)) fails.push(`${k} ${r[k] === undefined ? 'n/a' : r[k].toFixed(2)} not in [${lo}, ${hi}]`);
    }
    rows.push({ id: p.id, label: p.label, values: r, expect: p.expect, ok: !fails.length, fails });
  }
  return rows;
}

export function printProbes(rows, log = console.log) {
  const f = (v) => (v === undefined ? '    -' : v.toFixed(2).padStart(6));
  log('probe                   magasság  távolság  sebesség  oldalt   várt                      ');
  for (const r of rows) {
    const e = Object.entries(r.expect).map(([k, [lo, hi]]) => `${k} ${lo}..${hi}`).join(', ');
    log(`${(r.ok ? 'ok   ' : 'FAIL ') + r.id.padEnd(22)} ${f(r.values.height)}    ${f(r.values.dist)}    ${f(r.values.speed)}  ${f(r.values.lat)}   ${e}`);
    if (!r.ok) for (const m of r.fails) log(`        -> ${m}`);
  }
}
