// Technique probes: every movement technique is run by the proof bot on a flat probe arena and its height / distance /
// speed is measured and compared with the numbers of the design brief. Map designers read gap margins off this table
// (Könnyű <= 60 % of the reach, Közepes 75 %, Nehéz 85-90 %, Mester 92-95 %).
import { defineMap } from '../sim/builder.js';
import { World } from '../sim/world.js';
import { RouteRunner, R } from '../sim/bot.js';

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

// the wall at z = -10 (its face toward +z), 40 m tall, for the wall probes
const flatMap = testArena();
const wallMap = testArena((b) => { b.box([-40, 0, -12], [40, 40, -10], { mat: 'wall' }); });

const FAR = [0, 0, 250];   // air-steering target far behind the start (the probes run toward -z, wall probes jump away to +z)
const AHEAD = [0, 0, -250];

// ticks of each measure: 'dist' horizontal distance takeoff -> final landing, 'height' max feet height above the takeoff,
// 'speed' horizontal speed when the route ends
export const PROBES = [
  { id: 'jump', label: 'futó ugrás', steps: [R.run(0, -20), R.jump({ to: AHEAD })], expect: { height: [1.15, 1.3], dist: [5.9, 6.7] } },
  { id: 'jump-dj', label: 'ugrás + dupla ugrás', steps: [R.run(0, -20), R.jump({ to: AHEAD, dj: 'apex' })], expect: { height: [2.5, 2.75], dist: [10.4, 11.8] } },
  { id: 'dodge', label: 'kiugrás (dodge)', steps: [R.run(0, -20), R.dodge('F', { to: AHEAD })], expect: { dist: [5.4, 6.3] } },
  { id: 'dodge-dj', label: 'dodge + dupla ugrás', steps: [R.run(0, -20), R.dodgeJump('F', { to: AHEAD })], expect: { dist: [13.0, 14.6], height: [1.7, 2.0] } },
  { id: 'dodge-side', label: 'oldalsó dodge (balra)', steps: [R.run(0, -20), R.dodge('L', { to: AHEAD })], expect: { dist: [5.0, 8.0] } },
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
    wall: true, start: [0, 0, -9.5], yaw: 0,
    steps: [R.jump({ to: FAR, air: [R.wallDodge('F', { at: 0.2 })] })], expect: { dist: [7.4, 9.6] },
  },
  {
    id: 'wallboost', label: 'pajzs falról (wall boost, teljes)',
    wall: true, start: [0, 0, -9.5], yaw: 180,
    steps: [R.charge(true, { to: 1 }), R.air([R.wallBoost({ aimAt: [0, 1.6, -10.5], at: 'hit' })], { to: FAR })], expect: { dist: [5.5, 10] },
  },
  {
    id: 'shield-strafe', label: 'pajzs-strafe ugrás (futás közben, előre lökve)',
    steps: [R.run(0, -20), R.shieldJump({ push: [0, -250], pitch: -50, charge: 1, run: [0, -250], to: AHEAD })], expect: { dist: [17, 26], speed: [13, 20] },
  },
  { id: 'strafe-3', label: 'strafe ugrás, 3 lépés', steps: [R.run(0, -20), R.strafe({ hops: 3, to: AHEAD })], expect: { speed: [11.2, 13.6] } },
  { id: 'strafe-6', label: 'strafe ugrás, 6 lépés (tökéletes bot)', steps: [R.run(0, -20), R.strafe({ hops: 6, to: AHEAD })], expect: { speed: [15.5, 17.5] } },
  { id: 'strafe-6-sloppy', label: 'strafe ugrás, 6 lépés (0.75 hatékonyság)', steps: [R.run(0, -20), R.strafe({ hops: 6, to: AHEAD, eff: 0.75 })], expect: { speed: [13.5, 15.6] } },
  {
    id: 'bhop', label: 'bunnyhop: 14 m/s-ról 4 egyenes ugrás',
    setup: (w) => { w.ps.vel = [0, 0, -14]; },
    steps: [R.jump({ to: AHEAD }), R.jump({ to: AHEAD }), R.jump({ to: AHEAD }), R.jump({ to: AHEAD })], expect: { speed: [13.7, 14.6] },
  },
];

export function runProbe(p, opts = {}) {
  const w = new World((p.wall ? wallMap : flatMap).build());
  w.restart({});
  if (p.start) w.teleport(p.start, (p.yaw || 0) * (Math.PI / 180));
  w.ps.yaw = (p.yaw || 0) * (Math.PI / 180);
  if (p.setup) p.setup(w);
  const runner = new RouteRunner(w, p.steps, { jitter: opts.jitter, seed: opts.seed, maxSeconds: 30 });
  const ps = w.ps;
  let take = null, land = null, maxY = -Infinity, airborne = false;
  let lastGround = ps.pos.slice();
  const t0 = performance.now();
  // the route "completes" when its last step is done; the world never finishes in the arena
  while (!runner.bot.done && runner.n < 3000) {
    runner.tick();
    if (ps.grounded) {
      if (airborne) { land = ps.pos.slice(); airborne = false; }
      lastGround = ps.pos.slice();
    } else {
      if (!airborne) { airborne = true; if (!take) { take = lastGround; maxY = take[1]; } }
      if (ps.pos[1] > maxY) maxY = ps.pos[1];
    }
  }
  const err = runner.bot.error;
  const v = {};
  if (take) v.height = maxY - take[1];
  if (take && land) v.dist = Math.hypot(land[0] - take[0], land[2] - take[2]);
  v.speed = ps.speed;
  return { ...v, error: err, ms: performance.now() - t0 };
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
  log('probe                 magasság  távolság  sebesség   várt                      ');
  for (const r of rows) {
    const e = Object.entries(r.expect).map(([k, [lo, hi]]) => `${k} ${lo}..${hi}`).join(', ');
    log(`${(r.ok ? 'ok   ' : 'FAIL ') + r.id.padEnd(17)} ${f(r.values.height)}    ${f(r.values.dist)}    ${f(r.values.speed)}   ${e}`);
    if (!r.ok) for (const m of r.fails) log(`        -> ${m}`);
  }
}
