// The combo-gate checker. A gate (b.gate in sim/builder.js: start, goal box, solve steps, deny families, spread, margin) is proved
// in two parts:
//   1. SOLVE: the intended combo (the bot's R.* steps) reaches the goal from the start, nominally and with the sloppy jitter
//      (Kiképzés / Könnyű / Közepes: every seed, Nehéz: 80 %, Mester: 40 %).
//   2. DENY: ~1100-2200 runs of single techniques (jump, double jump, dodge, dodge + double jump, diagonal jump, wall dodge (+ double jump),
//      shield jump, wall boost (+ double jump)) from the start area must neither land in the goal nor ever come within `margin` of its box;
//      then the closest runs are refined (their heading, offset, timings, charge, pitch nudged one at a time) and must stay out too.
// Reached = at the end of a tick, grounded, feet inside the goal box, before any death. A deny run is one launch: it ends on landing,
// death, 6 s in the air, or when it is hopeless (more than 6 m below the goal and falling). One World per gate (restart + teleport).
// A deny search must also be SOUND: only runs in which the technique really happened count (every run is classified by the events it
// produced: jump, dodge, walldodge, dj, blast that hit), and a denied family that happened in fewer than 25 % of its runs fails the gate
// (a run-up that dies in a laser curtain, a lane that ends before the gun is charged, a blast that misses the floor prove nothing).
// The two families that need a wall (wallDodge, wallBoost) are held to the TAKEOFF only: no wall in reach is a legitimate "denied by
// the geometry", but a run that never took off is a broken search. Their technique counts are printed all the same.
//
//   checkGate(map, gate, { sloppy, nSloppy = 5, deny = true, refine = true, verbose = false })
//     -> { name, combo, ok, solve (nominal reached), solveError, sloppy: 'k/n', denyRuns, denyMs, closest: { label, d, pos } | null (the closest
//          EXECUTED denied run), byFamily: { family: { runs (placed), exec (technique happened), took (took off), unplaced, errors, best: { label, d, pos },
//          fail: { label, text } | null (the first run that crossed / came too close) } }, refined (runs of the refinement), fail: string | null (the
//          first reason), warn: string | null, ms }
//        verbose = do not stop at the first failing deny run (every family's best run and first failure are collected)
//   checkMapGates(map, { filter, ...same }) -> { results, fails: [report line], lines: [report lines], warns }   (filter = part of a gate name)
//   gateLine(result) -> 'kapu "name" (combo): megoldás ok, sloppy 5/5, tiltás 1498 futás 2.1 s [jump 28/28, dj 190/214, ...], legközelebb: diag R +56° 2.1 m'
//   runGateSelfTests() -> [{ name, ok, detail }]   (the checker must fail a crossable gap and pass a combo-only one)
//   Debugging a gate: play(world, gate, pos, yawDeg, steps, { deny, seed, jitter }) runs one route from a point (returns reached / closest /
//   land / ev (the set of events: jump dodge walldodge dj blast) ...), runsOf(family, gate, { start, gc, gh }) yields the grid of deny runs
//   (gc = goal centre, gh = heading to it), buildRun(family, params, gate, ctx) makes one of them from its params.
//   The labels read: family, variant, lane / run-up heading in degrees relative to the goal heading, lateral offset (m) or 'áll' (standing).
import { World } from '../sim/world.js';
import { Bot, R } from '../sim/bot.js';
import { defineMap, GATE_FAMILIES } from '../sim/builder.js';
import { TICK, HULL_HX, HULL_H } from '../sim/const.js';
import { DEG } from '../sim/math.js';

const NEED = { kikepzes: 1, konnyu: 1, kozepes: 1, nehez: 0.8, mester: 0.4 };   // share of the sloppy seeds that must reach the goal
const HEADINGS = [-56, -35, -20, -10, 0, 10, 20, 35, 56];
const SHIELD_HEADINGS = [...HEADINGS, -66, -46, 46, 66];   // the running shield jump is the strongest single technique: a few more lanes
const SIDE_LANES = [46, 56, 66];                    // diagonal jump lanes: degrees off the goal heading
const AIR_MAX = 6 * TICK, RUN_MAX = 9 * TICK, SOLVE_MAX = 40 * TICK;
const MIN_EXEC = 0.25;                              // a denied family must really happen in at least this share of its runs
const LEAD = 2.5, EARLY = LEAD + 6;                 // launch / release this many ticks before the lip: the last moment, and "a few ticks early"
const GAPS = [-10, -5, 5, 10];                      // shield jump: ticks between the jump and the release (sim COMBO_TICKS = 10)
const WALL_FAMILIES = ['wallDodge', 'wallBoost'];
const KILL_EARLY = 2;                               // m: launch this far before a kill volume (besides the last moment)
const REFINE_NEAR = 4.5, REFINE_SEEDS = 8, REFINE_ROUNDS = 3, REFINE_MAX = 500;   // refine the closest runs when they are within margin + 4.5 m

const inBox = (p, b) => p[0] >= b.min[0] && p[0] <= b.max[0] && p[1] >= b.min[1] && p[1] <= b.max[1] && p[2] >= b.min[2] && p[2] <= b.max[2];
function distBox(p, b) {
  const dx = Math.max(b.min[0] - p[0], 0, p[0] - b.max[0]), dy = Math.max(b.min[1] - p[1], 0, p[1] - b.max[1]), dz = Math.max(b.min[2] - p[2], 0, p[2] - b.max[2]);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
const f1 = (v) => v.toFixed(1);
const sg = (v) => (Number(v) >= 0 ? '+' : '') + v;
const at3 = (p) => `(${p.map(f1).join(', ')})`;

// the techniques that happened in a run, from the events of the sim
function tagsOf(events) {
  const t = new Set();
  for (const e of events) {
    if (e.type === 'jump' || e.type === 'dodge' || e.type === 'walldodge' || e.type === 'dj') t.add(e.type);
    else if (e.type === 'blast' && e.hit) t.add('blast');
  }
  return t;
}

// the player's hull touches a kill volume (as World.triggers tests it)
function inKill(w) {
  const p = w.ps.pos;
  return w.map.kills.some((b) => !(p[0] - HULL_HX > b.max[0] || p[0] + HULL_HX < b.min[0] || p[1] > b.max[1] || p[1] + HULL_H < b.min[1] || p[2] - HULL_HX > b.max[2] || p[2] + HULL_HX < b.min[2]));
}

// One run from `pos` / `yaw` (degrees) with the bot's `steps`. deny: end on the first landing; else (the solve) keep going until the steps end.
// o.charged: start with a full shield charge. -> { reached, died, hopeless, error, closest, closestPos, land (a landing outside the goal), landPos (the landing point), takeoff, reach (the farthest horizontal distance from the takeoff), ticks, ev, skipped }
export function play(w, g, pos, yaw, steps, o = {}) {
  w.restart({ silent: true });
  w.teleport(pos, yaw * DEG);
  const ps = w.ps, goal = g.goal;
  if (!ps.grounded) return { skipped: 'not on the ground' };
  if (o.deny && inKill(w)) return { skipped: 'in a kill volume' };
  if (o.charged) ps.charge = 1;   // as if the gun had been held for 1.2 s at the start (saves the 144 idle ticks of every wall boost run)
  w.takeEvents();
  const bot = new Bot(w, steps, { seed: o.seed ?? 1, jitter: o.jitter });
  const res = { reached: false, died: false, hopeless: false, error: null, closest: Infinity, closestPos: null, land: null, landPos: null, takeoff: null, reach: 0, ticks: 0, ev: null, skipped: null };
  const max = o.deny ? RUN_MAX + AIR_MAX : SOLVE_MAX, hopeless = goal.min[1] - 6;
  let air = 0, last = ps.pos.slice();
  for (let n = 0; n < max; n++) {
    const cmd = bot.next();
    if (bot.done) { res.error = bot.error; break; }
    w.step(cmd);
    res.ticks++;
    if (w.deaths > 0) { res.died = true; break; }
    const p = ps.pos;
    if (!ps.grounded) {
      if (air === 0) res.takeoff = last;
      air++;
      res.reach = Math.max(res.reach, Math.hypot(p[0] - res.takeoff[0], p[2] - res.takeoff[2]));
      const d = distBox(p, goal);
      if (d < res.closest) { res.closest = d; res.closestPos = p.slice(); }
      if (p[1] < hopeless && ps.vel[1] < 0) { res.hopeless = true; break; }
      if (air > AIR_MAX) break;
    } else {
      if (air > 0) {   // the landing tick counts as an approach
        const d = distBox(p, goal);
        if (d < res.closest) { res.closest = d; res.closestPos = p.slice(); }
        res.landPos = p.slice();
        if (!inBox(p, goal)) res.land = p.slice();
        air = 0;
        if (o.deny) { if (inBox(p, goal)) res.reached = true; break; }
      }
      if (inBox(p, goal)) { res.reached = true; break; }
      last = p.slice();
    }
  }
  res.ev = tagsOf(w.takeEvents());
  return res;
}

// ---------------------------------------------------------------- the deny search: families -> runs
// A run is described by plain params `p` (heading h and lateral offset off from the start line, or stand; then the family's own: dj time,
// charge, pitch, ...) so that the checker can nudge the closest ones (refinement). buildRun(fam, p, g, ctx) makes the run:
//   { fam, p, label, pos, yaw, steps, main (the events that make it the technique), then (events that must follow unless the run was cut
//     short by a death or by being hopeless: the double jump), base (what the soundness rule asks of the family: default = main) }
const n1 = (v) => (typeof v === 'string' ? v : Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10));
const STAND = { stand: true };

export function buildRun(fam, p, g, ctx) {
  const { start, gc, gh } = ctx;
  const to = gc, gx = [gc[0], gc[2]];
  const t = p.stand
    ? { h: gh, off: 0, base: { to, timeout: 8 }, tag: 'áll' }
    : { h: gh + p.h, off: p.off, base: { to, approach: gh + p.h, edge: true, plan: true, wallStop: true, killStop: p.kill ?? true, timeout: 8, lead: p.lead ?? LEAD }, tag: `${sg(n1(p.h))}°${p.off ? ' ' + sg(n1(p.off)) + 'm' : ''}` };
  const r = t.h * DEG;
  const pos = [start.pos[0] + t.off * Math.cos(r), start.pos[1], start.pos[2] - t.off * Math.sin(r)];
  if (p.direct) t.base.direct = true;   // air steering: W looking at the goal, no landing prediction
  const mk = (label, steps, main, then, base) => ({ fam, p: { ...p, fam }, label: `${label}${p.direct ? ' direct' : ''}${p.kill ? ' kill' + p.kill + 'm' : ''} ${t.tag}`, pos, yaw: t.h, steps, main, then, base: base || main });
  const djName = (dj) => (dj === undefined ? '' : ` dj${n1(dj)}`);
  switch (fam) {
    case 'jump': return mk('jump', [R.jump({ ...t.base })], ['jump']);
    case 'dj': return mk(`dj ${n1(p.at)}${p.steer ? ' steer' + n1(p.steer) : ''}${p.lead !== undefined ? ' lead' + n1(p.lead) : ''}`, [R.jump({ ...t.base, dj: p.at, steer: p.steer })], ['jump'], ['dj']);
    case 'dodge': return mk(`dodge ${p.d}`, [R.dodge(p.d, { ...t.base })], ['dodge']);
    case 'dodgeJump': return mk(`dodgeJump ${n1(p.at)}`, [R.dodgeJump('F', { ...t.base, dj: p.at })], ['dodge'], ['dj']);
    case 'diag': return mk(`diag ${p.side}${p.gap === 0 ? '' : p.gap === -12 ? ' late' : ' gap' + p.gap}`, [R.diagJump(p.side, { ...t.base, gap: p.gap })], ['dodge'], ['dj']);
    case 'wallDodge': {
      const air = [R.wallDodge(p.d, { at: p.at })];
      if (p.djRel !== undefined) air.push(R.doubleJump(undefined, { rel: p.djRel })); else if (p.dj !== undefined) air.push(R.doubleJump(p.dj));
      const dj = p.djRel !== undefined ? ` +dj +${n1(p.djRel)}s` : p.dj !== undefined ? ` +dj ${n1(p.dj)}` : '';
      return mk(`wallDodge ${p.d} ${n1(p.at)}${dj}`, [R.jump({ ...t.base, air })], ['jump', 'walldodge'], dj ? ['dj'] : undefined, ['jump']);
    }
    case 'shield': {
      // a running shield jump: the charge starts a fixed run-up distance before the release point, the release (with the jump) comes `lead` ticks
      // before the lip of the centre column (so the ray still sees the floor); aim away from the goal ('away') or along the run heading ('run')
      const st = { ...t.base, charge: p.charge, pitch: p.pitch, steer: p.steer, lip: p.lip ?? 'center', runUp: 'fixed', snap: true };
      if (p.aim === 'run') st.yaw = t.h + 180; else st.push = gx;
      if (p.dj !== undefined) st.dj = p.dj;
      if (p.gap) st.gap = p.gap;   // ticks between the jump and the release (> 0: jump first, < 0: release first): they stack within COMBO_TICKS
      return mk(`shield c${n1(p.charge)} p${n1(p.pitch)}${djName(p.dj)}${p.gap ? ' gap' + p.gap : ''}${p.steer ? ' steer' + n1(p.steer) : ''}${p.aim === 'run' ? ' run' : ''}${p.lip === 'hull' ? ' hull' : ''}${p.lead !== undefined && p.lead !== LEAD ? ' lead' + n1(p.lead) : ''}`, [R.shieldJump(st)], ['blast'], p.dj !== undefined ? ['dj'] : undefined);
    }
    case 'wallBoost': {
      // full charge held, jump, release at a wall (aimed back / left / right, pitch -20 / -50) from..s into the flight; or released on the takeoff
      // tick itself (a shield jump aimed at the wall); optionally followed by a double jump
      const name = p.aim === 180 ? 'back' : p.aim === 90 ? 'left' : p.aim === -90 ? 'right' : `aim${n1(p.aim)}`;
      if (p.takeoff) return mk(`wallBoost ${name} p${n1(p.pitch)} takeoff`, [R.shieldJump({ ...t.base, charge: 1, yaw: gh + p.aim, pitch: p.pitch, lip: 'center', runUp: 'fixed', snap: true })], ['blast'], undefined, ['jump']);
      const st = { ...t.base };
      if (p.dj !== undefined) st.dj = p.dj;
      return { ...mk(`wallBoost ${name} p${n1(p.pitch)} ${n1(p.from)}${djName(p.dj)}`, [R.charge(true), R.jump({ ...st, air: [R.wallBoost({ yaw: gh + p.aim, pitch: p.pitch, at: 'hit', from: p.from })] })], ['jump', 'blast'], p.dj !== undefined ? ['dj'] : undefined, ['jump']), charged: true };
    }
    default: throw new Error('unknown gate family ' + fam);
  }
}

// the grid of a family: yields built runs. A consumer that sends the result of play() back (it.next(res)) lets the wall families drop
// variants that cannot happen (no wall in reach on the first flight).
export function* runsOf(fam, g, ctx) {
  const spread = g.spread;
  const starts = (heads = HEADINGS) => { const a = []; for (const h of heads) for (const off of [-spread, 0, spread]) a.push({ h, off }); return a; };
  const B = (p) => buildRun(fam, p, g, ctx);
  const happened = (res, tag) => !res || res.skipped || (res.ev && res.ev.has(tag));   // no result sent back (or a skipped start): assume yes
  const all9 = starts();
  const early = ctx.nearKill ? KILL_EARLY : undefined;   // a kill volume (a laser curtain) near the lane: also launches 2 m before it (that can clear a low one)

  switch (fam) {
    case 'jump':
      for (const s of [...all9, STAND]) yield B(s);
      if (early) for (const s of all9) yield B({ ...s, kill: early });
      break;
    case 'dj':
      for (const s of [...all9, STAND]) {
        for (const at of [0.15, 'apex', 0.6, 0.9, 1.25]) for (const steer of (at === 'apex' || at === 0.6 ? [0, 0.4] : [0])) yield B({ ...s, at, steer });
      }
      for (const s of all9.filter((x) => x.off === 0)) for (const at of ['apex', 1.25]) yield B({ ...s, at, steer: 0, lead: EARLY });   // jump a few ticks before the lip
      if (early) for (const s of all9) for (const at of ['apex', 0.6]) yield B({ ...s, at, steer: 0, kill: early });
      break;
    case 'dodge':
      for (const s of all9) for (const d of ['F', 'L', 'R']) yield B({ ...s, d });
      if (early) for (const s of all9) yield B({ ...s, d: 'F', kill: early });
      break;
    case 'dodgeJump':
      for (const s of all9) for (const at of ['apex', 0.45]) yield B({ ...s, at });
      if (early) for (const s of all9) yield B({ ...s, at: 'apex', kill: early });
      break;
    case 'diag':
      for (const side of ['L', 'R']) for (const lane of SIDE_LANES) for (const off of [-spread, 0, spread]) for (const gap of [0, -12]) yield B({ h: side === 'L' ? -lane : lane, off, side, gap });
      break;
    case 'wallDodge':
      // jump + wall dodge (F, L, R) at the wall / 0.3 s / 0.6 s; a double jump after it counts as one technique for the user, so it must be denied
      // too: at the apex, 0.3 s after the wall dodge, late (0.9 s into the flight). The variants only happen where the wall trigger fired.
      for (const s of all9) for (const d of ['F', 'L', 'R']) {
        const first = yield B({ ...s, d, at: 'wall' });
        if (!happened(first, 'walldodge')) continue;
        yield B({ ...s, d, at: 0.3 });
        yield B({ ...s, d, at: 0.6 });
        yield B({ ...s, d, at: 'wall', dj: 'apex' });
        yield B({ ...s, d, at: 'wall', djRel: 0.3 });
        yield B({ ...s, d, at: 'wall', dj: 0.9 });
        yield B({ ...s, d, at: 0.3, dj: 'apex' });
      }
      break;
    case 'shield': {
      // stage A: every lane (13 headings x 3 offsets) with a few combinations; stage B: the three straight lanes and the three lanes that came
      // closest get the dense charge x pitch x double jump x aim grid (a running shield jump is a matter of distance control: the charge decides
      // whether it lands on the ledge or flies over it); standing: the full product
      const A = [   // [charge, pitch, dj, steer, aim, lead, lip, direct]
        [1, -89, 'apex', 0, 'away', LEAD, 'center'], [1, -65, 'apex', 0.4, 'run', LEAD, 'center'], [1, -45, undefined, 0, 'away', LEAD, 'center'], [0.5, -45, 1.25, 0.4, 'run', LEAD, 'center'],
        [1, -25, 0.9, 0, 'away', LEAD, 'hull'], [1, -65, 1.25, 0.4, 'run', LEAD, 'hull', true], [1, -45, 0.9, 0, 'run', EARLY, 'hull'], [1, -65, 1.25, 0.4, 'run', LEAD, 'center', true],
      ];
      const best = new Map();   // lane -> the closest approach of its stage A runs
      for (const s of starts(SHIELD_HEADINGS)) {
        for (const [charge, pitch, dj, steer, aim, lead, lip, direct] of A) {
          const res = yield B({ ...s, charge, pitch, dj, steer, aim, lead, lip, direct });
          const k = s.h + ':' + s.off;
          if (res && res.closest < (best.get(k) ?? Infinity)) best.set(k, res.closest);
        }
      }
      if (early) for (const s of starts(SHIELD_HEADINGS)) yield B({ ...s, charge: 1, pitch: -65, dj: 'apex', steer: 0.4, aim: 'run', lead: LEAD, lip: 'center', kill: early });
      const lanes = new Set(all9.filter((x) => x.h === 0).map((x) => x.h + ':' + x.off));
      for (const [k] of [...best].sort((a, b) => a[1] - b[1]).slice(0, 3)) lanes.add(k);
      for (const k of lanes) {
        const [h, off] = k.split(':').map(Number);
        for (const aim of h === 0 ? ['run', 'away'] : ['run']) for (const pitch of [-65, -45]) for (const dj of [undefined, 'apex', 0.9, 1.25]) for (const charge of [0.2, 0.35, 0.5, 0.7, 1]) {
          yield B({ h, off, charge, pitch, dj, steer: 0, aim, lead: LEAD, lip: 'center' });
        }
      }
      for (const charge of [0, 0.5, 1]) for (const pitch of [-89, -65, -45, -25]) for (const dj of [undefined, 'apex', 0.9, 1.25]) for (const steer of [0, 0.4]) {
        yield B({ ...STAND, charge, pitch, dj, steer, aim: 'away', lead: LEAD, lip: 'center' });
      }
      // the jump and the release a few ticks apart (up to COMBO_TICKS either way): the two stack, a release 10 ticks BEFORE the jump is the highest single
      // shield jump (it can lift a ledge that a gap of 0 cannot reach). Standing, and on the lanes that came closest (a release-first run is released earlier)
      for (const gap of GAPS) {
        for (const charge of [0.5, 1]) for (const pitch of [-89, -65]) for (const dj of [undefined, 'apex', 0.9]) for (const steer of [0, 0.4]) {
          yield B({ ...STAND, charge, pitch, dj, steer, aim: 'away', lead: LEAD, lip: 'center', gap });
        }
        for (const k of lanes) {
          const [h, off] = k.split(':').map(Number);
          for (const pitch of [-65, -45]) for (const dj of [undefined, 'apex']) yield B({ h, off, charge: 1, pitch, dj, steer: 0, aim: 'run', lead: gap < 0 ? LEAD - gap : LEAD, lip: 'center', gap });
        }
      }
      break;
    }
    case 'wallBoost':
      // the first variant (0.15 s) finds out whether a wall is in reach; only then the later release and the double jumps follow
      for (const s of all9) for (const aim of [180, 90, -90]) for (const pitch of [-20, -50]) {
        const first = yield B({ ...s, aim, pitch, from: 0.15 });
        if (happened(first, 'blast')) {
          yield B({ ...s, aim, pitch, from: 0.45 });
          yield B({ ...s, aim, pitch, from: 0.15, dj: 'apex' });
          yield B({ ...s, aim, pitch, from: 0.15, dj: 0.9 });
        }
        if (s.off === 0) yield B({ ...s, aim, pitch, takeoff: true });
      }
      break;
    default: throw new Error('unknown gate family ' + fam);
  }
}

// the neighbours of a run's params: one numeric field nudged at a time (heading, lateral offset, times, charge, pitch ...)
const DJS = [undefined, 'apex', 0.5, 0.7, 0.9, 1.1, 1.25, 1.4];
function neighbours(p, spread) {
  const out = [];
  const add = (k, deltas, lo, hi) => {
    if (typeof p[k] !== 'number') return;
    for (const d of deltas) { const v = Math.round(Math.min(hi, Math.max(lo, p[k] + d)) * 100) / 100; if (v !== p[k]) out.push({ ...p, [k]: v }); }
  };
  if (!p.stand) { add('h', [-6, -3, 3, 6], -80, 80); add('off', [-0.5, -0.25, 0.25, 0.5], -2 * spread, 2 * spread); add('lead', [-1.5, 1, 2.5, 5], 0.5, 14); }
  const swap = (k, values) => { for (const v of values) if (v !== p[k]) out.push({ ...p, [k]: v }); };
  if (p.fam === 'shield' || (p.fam === 'wallBoost' && !p.takeoff) || (p.fam === 'wallDodge' && p.djRel === undefined)) swap('dj', DJS);
  if (p.fam === 'dj') swap('at', DJS.slice(1));
  if (p.fam === 'dodgeJump') swap('at', ['apex', 0.3, 0.45, 0.6, 0.8]);
  if (p.fam === 'shield') { swap('aim', ['away', 'run']); if (!p.stand) { swap('lead', [LEAD, EARLY]); swap('lip', ['center', 'hull']); } }
  out.push({ ...p, direct: !p.direct });
  add('at', [-0.1, -0.05, 0.05, 0.1], 0.05, 3);
  add('dj', [-0.1, -0.05, 0.05, 0.1], 0.1, 3);
  add('djRel', [-0.1, 0.1], 0, 2);
  add('steer', [-0.2, -0.1, 0.1, 0.2], 0, 2);
  add('charge', [-0.3, -0.15, 0.15, 0.3], 0, 1);
  add('pitch', [-10, -5, 5, 10], -89, -5);
  add('from', [-0.1, 0.1], 0, 2);
  add('gap', [-6, -3, 3, 6], -12, p.fam === 'shield' ? 12 : 8);
  return out;
}

// brush under a feet position, and the start island: the static brushes you can walk to from the start brush (touching in plan view,
// tops within a step of each other), to tell "landed back on the start area" from "landed somewhere else"
function brushUnder(w, p) {
  return w.cw.traceBox([p[0], p[1] + 0.3, p[2]], [p[0], p[1] - 0.4, p[2]], [0.4, 0.05, 0.4]).brush;   // the hull's width, thin: it may stand on an edge, against a wall
}
function startIsland(map, start) {
  const bs = map.brushes.filter((b) => b.mover === null);
  const touch = (a, b) => a.min[0] <= b.max[0] + 0.1 && b.min[0] <= a.max[0] + 0.1 && a.min[2] <= b.max[2] + 0.1 && b.min[2] <= a.max[2] + 0.1 && Math.abs(a.max[1] - b.max[1]) <= 0.35;
  const seed = start && bs.find((b) => b === start);
  const island = new Set(seed ? [seed] : []);
  const queue = [...island];
  while (queue.length) {
    const a = queue.pop();
    for (const b of bs) if (!island.has(b) && touch(a, b)) { island.add(b); queue.push(b); }
  }
  return island;
}

// -> { name, combo, ok, solve: bool, solveError, sloppy: 'k/n', denyRuns, denyMs, closest: { label, d, pos } | null, byFamily, refined, fail: string | null,
//      warn: string | null, ms }
export function checkGate(map, g, o = {}) {
  const t0 = performance.now();
  const n = o.nSloppy ?? 5, doDeny = o.deny !== false;
  const w = new World(map);
  const out = { name: g.name, combo: g.combo, ok: true, solve: false, solveError: null, sloppy: '-', denyRuns: 0, denyMs: 0, closest: null, byFamily: {}, refined: 0, fail: null, warn: null, ms: 0 };
  const fail = (msg) => { if (out.ok) out.fail = msg; out.ok = false; };

  // 1. the solve
  const nominal = play(w, g, g.start.pos, g.start.yaw, g.solve);
  out.solve = nominal.reached;
  if (!nominal.reached) {
    out.solveError = nominal.skipped || nominal.error || (nominal.died ? `died near ${at3(nominal.closestPos || nominal.takeoff || g.start.pos)}` : `ended ${nominal.closest < Infinity ? f1(nominal.closest) + ' m from the goal ' + at3(nominal.closestPos) : 'without leaving the ground'}`);
    fail(`a megoldás nem éri el a célt: ${out.solveError}`);
  } else if (n > 0) {
    let pass = 0;
    const why = [];
    for (let s = 1; s <= n; s++) {
      const r = play(w, g, g.start.pos, g.start.yaw, g.solve, { jitter: o.sloppy, seed: s });
      if (r.reached) pass++; else why.push(`#${s}: ${r.error || (r.died ? 'died' : f1(r.closest) + ' m short')}`);
    }
    out.sloppy = `${pass}/${n}`;
    const need = Math.ceil((NEED[map.meta.diff] ?? 1) * n - 1e-9);
    if (pass < need) fail(`sloppy ${pass}/${n} (kell ${need}): ${why.join('; ')}`);
  }

  // 2. the deny search
  if (doDeny) {
    const gc = [(g.goal.min[0] + g.goal.max[0]) / 2, (g.goal.min[1] + g.goal.max[1]) / 2, (g.goal.min[2] + g.goal.max[2]) / 2];
    const gh = Math.atan2(-(gc[0] - g.start.pos[0]), -(gc[2] - g.start.pos[2])) / DEG;
    // a kill volume (not the automatic void plane) at the height of the start within 30 m: the run-ups may be cut short by it
    const nearKill = map.kills.some((k) => !k.auto && k.max[1] >= g.start.pos[1] - 0.5 && k.min[1] <= g.start.pos[1] + 3 && Math.hypot(Math.max(k.min[0] - g.start.pos[0], 0, g.start.pos[0] - k.max[0]), Math.max(k.min[2] - g.start.pos[2], 0, g.start.pos[2] - k.max[2])) < 30);
    const ctx = { start: g.start, gc, gh, nearKill };
    const fams = g.deny === 'all' ? GATE_FAMILIES : g.deny;
    const island = startIsland(map, brushUnder(w, g.start.pos));
    const td = performance.now();
    let warned = 0, crossed = false;
    const pool = [];   // the executed runs: { fam, p, d, reach, label } (the refinement's seeds)

    // one run: play it, classify it, count it, check it against the goal. -> the play() result (sent back to the generator)
    const runOne = (r, fb, refining) => {
      let res;
      try { res = play(w, g, r.pos, r.yaw, r.steps, { deny: true, charged: r.charged }); } catch (e) {
        fb.errors++;
        fail(`kivétel a tiltó futásban: ${r.label}: ${e && e.message ? e.message : e}`);
        crossed = true;
        return { skipped: 'exception' };
      }
      if (res.skipped) { if (!refining) fb.unplaced++; return res; }
      if (!refining) { out.denyRuns++; fb.runs++; } else out.refined++;
      const has = (tags) => tags.every((t) => res.ev.has(t));
      const took = has(r.base), cut = res.died || res.hopeless;
      const exec = has(r.main) && (!r.then || cut || has(r.then));
      if (!refining) { if (took) fb.took++; if (exec) fb.exec++; }
      const cp = res.closestPos;
      if (exec && res.closest < Infinity) {
        pool.push({ fam: r.fam, p: r.p, d: res.closest, reach: res.reach, label: r.label });
        if (res.closest < (fb.best ? fb.best.d : Infinity)) fb.best = { label: r.label, d: res.closest, pos: cp };
        if (res.closest < (out.closest ? out.closest.d : Infinity)) out.closest = { label: r.label, d: res.closest, pos: cp };
      }
      if (res.reached || res.closest < g.margin) {
        const text = `${r.label} ${res.reached ? `a célban landol ${at3(res.landPos)}` : `${res.closest.toFixed(2)} m-re megközelíti a célt (< ${g.margin} m) ${cp ? at3(cp) : ''}`}${refining ? ' [finomítás]' : ''}`;
        if (!fb.fail) fb.fail = { label: r.label, text };
        fail(`tiltás megbukott: ${text}`);
        crossed = true;
      }
      if (res.land && !res.reached && res.takeoff && Math.hypot(res.land[0] - res.takeoff[0], res.land[2] - res.takeoff[2]) > 3 && !island.has(brushUnder(w, res.land)) && warned++ === 0) {
        out.warn = `túlélhető leszállás a célon kívül: ${r.label} ${at3(res.land)}`;
      }
      return res;
    };

    for (const fam of fams) {
      const fb = (out.byFamily[fam] = { runs: 0, exec: 0, took: 0, unplaced: 0, errors: 0, best: null, fail: null, ms: 0 }), tf = performance.now();
      const it = runsOf(fam, g, ctx);
      let nx = it.next(), broke = false;
      while (!nx.done) {
        const res = runOne(nx.value, fb, false);
        if (crossed && !o.verbose) { broke = true; break; }
        crossed = false;
        nx = it.next(res);
      }
      // soundness: the technique must really have happened (wall families: at least the takeoff)
      if (!broke && !fb.errors) {
        const real = WALL_FAMILIES.includes(fam) ? fb.took : fb.exec;
        if (real === 0 || real < MIN_EXEC * fb.runs) {
          fail(`tiltás érvénytelen: a "${fam}" család ${real === 0 ? 'egyszer sem' : `csak a futások ${Math.round((100 * real) / fb.runs)} %-án`} hajtotta végre a technikát (${real}/${fb.runs}${WALL_FAMILIES.includes(fam) ? ' felszállás' : ''}${fb.unplaced ? `, ${fb.unplaced} nem indítható` : ''}, kell legalább ${Math.round(MIN_EXEC * 100)} %)`);
        }
      }
      fb.ms = performance.now() - tf;
      if (!out.ok && !o.verbose) break;
    }

    // refinement: nudge the closest runs (one numeric param at a time, a few rounds): a near miss of the grid is often a hit one step away
    if (o.refine !== false && (out.ok || o.verbose) && pool.length) {
      const key = (fam, p) => fam + JSON.stringify(p);
      const seen = new Set(pool.map((x) => key(x.fam, x.p)));
      const spread = g.spread;
      const pick = (cands, n) => {   // the closest runs (ties: the longer flight), at most one per lane and family, at most 3 per family
        const lanes = new Set(), perFam = {}, out = [];
        for (const x of cands.slice().sort((a, b) => Math.round(a.d * 20) - Math.round(b.d * 20) || b.reach - a.reach)) {
          const k = x.fam + (x.p.stand ? 'stand' : x.p.h + ':' + x.p.off);
          if (x.d >= g.margin + REFINE_NEAR || lanes.has(k) || (perFam[x.fam] ?? 0) >= 3) continue;
          lanes.add(k); perFam[x.fam] = (perFam[x.fam] ?? 0) + 1; out.push(x);
          if (out.length >= n) break;
        }
        return out;
      };
      let seeds = pick(pool, REFINE_SEEDS), spent = 0;
      for (let round = 0; round < REFINE_ROUNDS && seeds.length && spent < REFINE_MAX; round++) {
        const found = [];
        const prevBest = seeds[0].d;
        for (const sd of seeds) {
          const fb = out.byFamily[sd.fam];
          for (const q of neighbours(sd.p, spread)) {
            const k = key(sd.fam, q);
            if (seen.has(k)) continue;
            seen.add(k);
            spent++;
            const before = pool.length;
            runOne(buildRun(sd.fam, q, g, ctx), fb, true);
            if (pool.length > before) found.push(pool[pool.length - 1]);
            if (crossed && !o.verbose) break;
          }
          if (crossed && !o.verbose) break;
        }
        if (crossed && !o.verbose) break;
        found.sort((a, b) => a.d - b.d);
        if (!found.length || found[0].d >= prevBest - 0.02) break;   // no progress
        seeds = pick(found, REFINE_SEEDS - 2);
      }
    }
    if (warned > 1) out.warn += ` (+${warned - 1} további)`;
    out.denyMs = performance.now() - td;
  }
  out.ms = performance.now() - t0;
  return out;
}

// the executed / placed counts per family: 'jump 28/28, dj 190/214 (3 nem indítható), wallDodge 40/243 (felszállt 243)'
function famCounts(r) {
  return Object.entries(r.byFamily).map(([fam, fb]) => `${fam} ${fb.exec}/${fb.runs}${fb.unplaced ? ` (${fb.unplaced} nem indítható)` : ''}${WALL_FAMILIES.includes(fam) && fb.took !== fb.exec ? ` (felszállt ${fb.took})` : ''}`).join(', ');
}

// the report lines of one gate result
export function gateLine(r) {
  const head = `kapu "${r.name}"${r.combo ? ` (${r.combo})` : ''}`;
  if (!r.ok) return `${head}: ${r.fail}`;
  const deny = r.denyRuns ? `tiltás ${r.denyRuns}${r.refined ? ` + ${r.refined} finomító` : ''} futás ${(r.denyMs / 1000).toFixed(1)} s [${famCounts(r)}], legközelebb: ${r.closest ? `${r.closest.label} ${f1(r.closest.d)} m` : 'egy futás sem emelkedett el'}` : 'tiltás kihagyva';
  return `${head}: megoldás ok, sloppy ${r.sloppy}, ${deny}`;
}

// all gates of a map (filter: a substring of the gate name) -> { results, fails, lines, warns }
export function checkMapGates(map, o = {}) {
  const res = { results: [], fails: [], lines: [], warns: [] };
  for (const g of map.gates || []) {
    if (o.filter && !g.name.toLowerCase().includes(o.filter.toLowerCase())) continue;
    const r = checkGate(map, g, o);
    res.results.push(r);
    res.lines.push(gateLine(r));
    // a gate that a single technique crosses is a known weak gate (the user chose to keep the maps for now): a warning,
    // unless strict; a gate whose own combo fails, or whose deny search is not sound, always fails
    if (!r.ok && !o.strict && r.solve && /^tiltás megbukott/.test(r.fail || '')) res.warns.push(`kapu "${r.name}" gyenge, egy trükkel is átjárható (--strict-gates: hiba): ${r.fail}`);
    else if (!r.ok) res.fails.push(gateLine(r));
    if (r.warn) res.warns.push(`kapu "${r.name}": ${r.warn}`);
    if (o.verbose && r.denyRuns) {
      for (const [fam, fb] of Object.entries(r.byFamily)) {
        res.lines.push(`    ${fam.padEnd(10)} ${String(fb.exec).padStart(4)}/${String(fb.runs).padEnd(4)} futás  ${fb.best ? `legközelebb ${f1(fb.best.d)} m  ${fb.best.label}` : '-'}${fb.fail ? `   BUKIK: ${fb.fail.text}` : ''}`);
      }
    }
  }
  return res;
}

// ---------------------------------------------------------------- self-tests of the checker
// two arenas: platform A (top y = 0) with the start at the origin, a goal ledge beyond a gap, void below
function gapMap(gap, extra, id, platform = true, edge = -20.3) {
  return defineMap({ id, name: 'Kapu', diff: 'kikepzes', order: 1, blurb: '', authorTime: 1 }, (b) => {
    b.start([0, 0, 0], 0);
    if (platform) b.box([-30, -1, edge], [0.9, 0, 30], { mat: 'floor' });   // the start platform, its far edge at z = edge
    b.box([-14, -1, edge - gap - 20], [0.9, 0, edge - gap], { mat: 'floor' });   // the goal ledge
    extra && extra(b, gap);
    b.checkpoint([-1, 0, -1], [1, 2, 1], { spawn: [0, 0, 0] });
    b.finish([-10, 0, edge - gap - 12], [0, 2, edge - gap - 10]);
    b.route([R.wait(0.1)]);
  }).build();
}

export function runGateSelfTests() {
  const rows = [];
  const add = (name, fn) => { try { rows.push({ name, ...fn() }); } catch (e) { rows.push({ name, ok: false, detail: 'threw: ' + (e.stack || e.message) }); } };

  add('gate checker: a 9 m gap with deny [dj] must FAIL (a double jump crosses it) - and the solve and the sloppy runs pass', () => {
    const map = gapMap(9, null, 'gate-9');
    const goal = [[-14, -0.1, -29.3 - 20], [0.9, 2.5, -29.3]];
    const solve = [R.run(0, -19, { tol: 0.5 }), R.jump({ to: [-6, 0, -35], dj: 'apex', edge: true })];
    const g = { name: '9 m', combo: '', start: { pos: [0, 0, 0], yaw: 0 }, goal: { min: goal[0], max: goal[1] }, solve, deny: ['dj'], spread: 1, margin: 0.6 };
    const r = checkGate(map, g, { sloppy: { press: 3, aim: 2 } });
    return { ok: !r.ok && r.solve && r.sloppy === '5/5' && /dj/.test(r.fail || ''), detail: `ok=${r.ok}, solve ${r.solve}, sloppy ${r.sloppy}, ${r.fail}` };
  });

  // a gap no single technique crosses (50 m, the running shield jump + double jump reaches ~37), solved with a jump pad that sits behind the start: the
  // checker must not fail it for any reason of its own (soundness rule, refinement) - all 8 families run, and every one of them executes
  add('gate checker: a 50 m gap beyond every single technique (solved with a jump pad) with deny all must PASS, and every family must really have executed', () => {
    const gap = 50, edge = -20.3;
    const map = defineMap({ id: 'gate-pad', name: 'Kapu', diff: 'kikepzes', order: 1, blurb: '', authorTime: 1 }, (b) => {
      b.start([0, 0, 0], 0);
      b.box([-30, -1, edge], [0.9, 0, 30], { mat: 'floor' });
      b.box([-14, -1, edge - gap - 20], [0.9, 0, edge - gap], { mat: 'floor' });
      b.pad([-25, 0, 12], { target: [-6, 0, edge - gap - 8], apex: 16 });
      b.checkpoint([-1, 0, -1], [1, 2, 1], { spawn: [0, 0, 0] });
      b.finish([-10, 0, edge - gap - 12], [0, 2, edge - gap - 10]);
      b.route([R.wait(0.1)]);
    }).build();
    const goal = [[-14, -0.1, edge - gap - 20], [0.9, 2.5, edge - gap]];
    const solve = [R.run(-25, 12, { tol: 2 }), R.wait(5)];   // tol 2: the run step ends before the pad fires (keys held in the flight would brake it)
    const g = { name: '50 m', combo: 'ugrópárna', start: { pos: [0, 0, 0], yaw: 0 }, goal: { min: goal[0], max: goal[1] }, solve, deny: 'all', spread: 1, margin: 0.6 };
    const r = checkGate(map, g, { nSloppy: 0 });
    const fams = Object.entries(r.byFamily).map(([k, fb]) => `${k} ${fb.exec}/${fb.runs}`).join(', ');
    const sound = GATE_FAMILIES.every((k) => r.byFamily[k] && r.byFamily[k].runs > 0 && r.byFamily[k].took >= 0.25 * r.byFamily[k].runs) && ['jump', 'dj', 'dodge', 'dodgeJump', 'diag', 'shield'].every((k) => r.byFamily[k].exec >= 0.25 * r.byFamily[k].runs);
    return { ok: r.ok && r.solve && r.denyRuns > 900 && sound, detail: `ok=${r.ok}, solve ${r.solve}, ${r.denyRuns} deny runs in ${(r.denyMs / 1000).toFixed(1)} s [${fams}], closest ${r.closest ? r.closest.label + ' ' + f1(r.closest.d) + ' m' : '-'}${r.fail ? ', ' + r.fail : ''}` };
  });

  // a laser curtain across the run-up: the old search died in it before any takeoff (a vacuous pass); now every run takes off at the curtain
  add('gate checker: a kill curtain across the run-up (every run dies at it) is a sound search: the families launch at the curtain and are counted as executed', () => {
    const map = gapMap(9, (b) => { b.kill([-30, -1.5, -19.2], [0.9, 8, -18.4], 'laser'); }, 'gate-curtain');
    const goal = [[-14, -0.1, -29.3 - 20], [0.9, 2.5, -29.3]];
    const g = { name: 'curtain', combo: '', start: { pos: [0, 0, 0], yaw: 0 }, goal: { min: goal[0], max: goal[1] }, solve: [R.wait(0.1)], deny: ['jump', 'dj', 'dodge', 'shield'], spread: 1, margin: 0.6 };
    const r = checkGate(map, g, { nSloppy: 0, verbose: true });
    const fb = r.byFamily, ratio = (k) => (fb[k] && fb[k].runs ? fb[k].exec / fb[k].runs : 0);
    return { ok: !/tiltás érvénytelen/.test(r.fail || '') && ratio('jump') > 0.9 && ratio('dj') > 0.9 && ratio('dodge') > 0.9 && ratio('shield') > 0.5 && r.denyRuns > 300, detail: `jump ${fb.jump.exec}/${fb.jump.runs}, dj ${fb.dj.exec}/${fb.dj.runs}, dodge ${fb.dodge.exec}/${fb.dodge.runs}, shield ${fb.shield.exec}/${fb.shield.runs}; ${r.fail}` };
  });

  // an exception inside a deny run is reported for the gate (not thrown): the margin getter arms a goal whose max throws
  add('gate checker: an exception inside a deny run is reported as a failure of that gate ("kivétel"), it does not crash the checker', () => {
    const map = gapMap(9, null, 'gate-throw');
    let armed = false;
    const goal = { min: [-14, -0.1, -29.3 - 20], get max() { if (armed) throw new Error('boom'); return [0.9, 2.5, -29.3]; } };
    const solve = [R.run(0, -19, { tol: 0.5 }), R.jump({ to: [-6, 0, -35], dj: 'apex', edge: true })];
    const g = { name: 'throw', combo: '', start: { pos: [0, 0, 0], yaw: 0 }, goal, solve, deny: ['jump'], spread: 1, get margin() { armed = true; return 0.6; } };
    const r = checkGate(map, g, { nSloppy: 0 });
    return { ok: !r.ok && /kivétel a tiltó futásban/.test(r.fail || '') && /boom/.test(r.fail || ''), detail: r.fail };
  });
  return rows;
}
