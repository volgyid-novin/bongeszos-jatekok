// PAJZSUGRÁS test runner:  npm run test:pj [-- --map=id] [--probes] [--sloppy=N] [-v]
// Flags: --map=id (one map only), --probes (only the probe table), --sloppy=N (sloppy runs per map, default 5), -v (details),
//        --trace (with --map: print every route step with tick and position, handy when a proof route fails).
//   (a) collision / movement unit checks   (b) technique probes   (c) per-map proof: build, spawns, nominal route, author time,
//   skips, sloppy runs, determinism   (d) summary table   (e) app level: nostr, leaderboard, race + net, input, store (app-tests.mjs).
// Exit code 1 on any failure.  --app runs only (e); --only=text runs only the (e) cases whose name contains the text.
import { MAPS } from '../maps/index.js';
import { World, medalTimes } from '../sim/world.js';
import { RouteRunner } from '../sim/bot.js';
import { makeCmd, hullSolid } from '../sim/pmove.js';
import { TICK, HULL_HX, HULL_HY } from '../sim/const.js';
import { mulberry32 } from '../sim/math.js';
import { runTraceTests } from './trace.js';
import { runProbes, printProbes } from './probes.js';
import { runAppTests } from './app-tests.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n, d) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const only = val('map', null), probesOnly = flag('--probes'), verbose = flag('-v') || flag('--verbose'), trace = flag('--trace');
const appOnly = flag('--app');
const SLOPPY_N = Number(val('sloppy', 5));
const SLOPPY = { press: 3, aim: 2, eff: 0.75 };

let failures = 0;
const fail = (msg) => { failures++; console.log('  FAIL ' + msg); };

// ---------- (a) + (b) ----------
if (!only && !appOnly) {
  if (!probesOnly) {
    console.log('== (a) ütközés és mozgás ==');
    for (const t of runTraceTests()) {
      console.log(`${t.ok ? '  ok   ' : '  FAIL '}${t.name}${verbose || !t.ok ? '  -- ' + t.detail : ''}`);
      if (!t.ok) failures++;
    }
  }
  console.log('\n== (b) technika próbák ==');
  const rows = runProbes();
  printProbes(rows);
  failures += rows.filter((r) => !r.ok).length;
}

// ---------- (c) + (d) ----------
const summary = [];
if (!probesOnly && !appOnly) {
  console.log('\n== (c) pályák ==');
  const maps = only ? MAPS.list.filter((m) => m.meta.id === only) : MAPS.list;
  if (only && !maps.length) { fail(`nincs ilyen pálya: ${only} (${MAPS.ids.join(', ')})`); }
  for (const def of maps) summary.push(checkMap(def));
}

function groundBelow(w, p) {
  const tr = w.cw.traceBox([p[0], p[1] + HULL_HY, p[2]], [p[0], p[1] + HULL_HY - 1.0, p[2]], [HULL_HX, HULL_HY, HULL_HX]);
  return tr.fraction < 1 ? tr.normal[1] >= 0.7 : false;
}

function checkMap(def) {
  const id = def.meta.id, row = { id, diff: def.meta.diff, ok: true, notes: [] };
  const bad = (msg) => { row.ok = false; fail(`${id}: ${msg}`); };
  const log = (msg) => { if (verbose) console.log(`  ${id}: ${msg}`); };
  let map;
  const t0 = performance.now();
  try { map = def.build(); } catch (e) { bad('build: ' + e.message); return row; }
  row.brushes = map.brushes.length; row.hash = map.mapHash;
  // valid geometry
  for (const b of map.brushes) {
    if (!(b.nclip >= 4) || !(b.volume > 0) || !b.min.concat(b.max).every(Number.isFinite)) { bad(`brush #${b.id} is not a valid convex brush`); break; }
  }
  // spawns
  const w0 = new World(map);
  const spawns = [['start', map.start.pos], ...map.checkpoints.map((c) => [c.label, c.spawn])];
  for (const [name, p] of spawns) {
    w0.teleport(p, 0);
    const solid = w0.cw.testSolid([w0.ps.pos[0], w0.ps.pos[1] + HULL_HY, w0.ps.pos[2]], [HULL_HX, HULL_HY, HULL_HX]);
    if (solid) bad(`${name} spawn is inside solid`);
    else if (!w0.ps.grounded || !groundBelow(w0, w0.ps.pos)) bad(`${name} spawn is not on the ground (${p.map((v) => v.toFixed(2))})`);
  }
  // walkable surfaces and spawns must not sit inside a kill volume (a slab that is too big would kill players standing on a platform)
  {
    const hit = (p, k) => !(p[0] - HULL_HX > k.max[0] || p[0] + HULL_HX < k.min[0] || p[1] > k.max[1] || p[1] + 1.76 < k.min[1] || p[2] - HULL_HX > k.max[2] || p[2] + HULL_HX < k.min[2]);
    let flagged = 0;
    const check = (p, what) => { for (const k of map.kills) if (hit(p, k) && flagged++ < 3) bad(`${what} at (${p.map((v) => v.toFixed(1))}) is inside a ${k.kind} volume`); };
    for (const [name, p] of spawns) check(p, name + ' spawn');
    for (const br of map.brushes) {
      const offs = br.mover === null ? [[0, 0, 0]] : map.movers.find((m) => m.id === br.mover).path;
      for (const f of br.faces) {
        if (!f.top) continue;
        const c = f.verts.reduce((a, v) => [a[0] + v[0] / f.verts.length, a[1] + v[1] / f.verts.length, a[2] + v[2] / f.verts.length], [0, 0, 0]);
        for (const o of offs) check([c[0] + o[0], c[1] + o[1] + 0.01, c[2] + o[2]], `walkable surface of brush #${br.id}`);
      }
    }
  }
  // nominal route
  const steps = map.route;
  const nominal = (opts) => {
    const w = new World(map);
    const rr = new RouteRunner(w, steps, opts);
    if (trace && !opts) {
      let last = -1;
      while (rr.tick() || rr.bot.i !== last) {
        if (rr.bot.i !== last) { last = rr.bot.i; const st = steps[Math.min(last, steps.length - 1)]; console.log(`    tick ${String(w.t).padStart(6)}  step ${String(last).padStart(3)} ${st.type.padEnd(10)} pos (${w.ps.pos.map((v) => v.toFixed(1)).join(', ')})  v ${w.ps.speed.toFixed(1)}  cp ${w.cpIndex}`); }
        if (rr.done) break;
      }
    }
    return { w, rr, res: trace && !opts ? rr.result() : rr.run() };
  };
  const { w, res } = nominal();
  const ticks = res.ticks;
  row.cps = `${res.cps}/${w.cpCount}`;
  if (!res.ok) { bad(`nominal route failed: ${res.reason} (checkpoints ${res.cps}/${w.cpCount})`); row.author = NaN; }
  else {
    row.author = ticks / TICK;
    log(`nominal route ${ticks} ticks (${row.author.toFixed(2)} s), ${res.cps}/${w.cpCount} checkpoints, ${w.splits.join(', ')}`);
    if (Math.abs(ticks - Math.round(map.meta.authorTime * TICK)) > 1) bad(`authorTime ${map.meta.authorTime} is out of date: the route takes ${ticks} ticks, set authorTime: ${(ticks / TICK).toFixed(3)}`);
    if (res.deaths) bad('the nominal route dies');
    // order of checkpoints: splits strictly increasing
    for (let i = 1; i < w.splits.length; i++) if (w.splits[i] < w.splits[i - 1]) bad('checkpoint splits out of order');
  }
  row.medals = medalTimes(map.meta.authorTime);
  // skips
  row.skips = [];
  for (const sk of map.skips) {
    const w2 = new World(map);
    const r2 = new RouteRunner(w2, sk.steps).run();
    if (!r2.ok) bad(`skip "${sk.name}" failed: ${r2.reason}`);
    else row.skips.push(`${sk.name} ${(r2.ticks / TICK).toFixed(1)}s`);
    log(`skip ${sk.name}: ${r2.ok ? r2.ticks + ' ticks' : r2.reason}`);
  }
  // determinism: same hash twice, and again driven in random sized chunks
  if (res.ok) {
    const again = nominal().res;
    if (again.hash !== res.hash || again.ticks !== res.ticks) bad('route is not deterministic (two runs differ)');
    const w3 = new World(map), rr3 = new RouteRunner(w3, steps), rng = mulberry32(99);
    while (!rr3.done) rr3.advance(1 + Math.floor(rng() * 400));
    if (rr3.result().hash !== res.hash) bad('route differs when stepped in random chunks');
  }
  // fuzz: random inputs from every spawn point; the state must stay finite and the hull must never end a tick inside geometry
  {
    const rng = mulberry32(0xf022 + id.length);
    let nan = 0, solid = 0, ticksRun = 0;
    for (const [name, p] of spawns) {
      for (let seed = 0; seed < 2; seed++) {
        const w = new World(map);
        w.teleport(p, rng() * 6.28);
        w.startClock();
        const c = makeCmd();
        c.yaw = w.ps.yaw;
        let hold = 0;
        for (let t = 0; t < 1500; t++) {
          if (hold-- <= 0) {
            hold = 10 + Math.floor(rng() * 50);
            c.fwd = rng() < 0.7 ? 1 : rng() < 0.5 ? 0 : -1; c.side = Math.floor(rng() * 3) - 1;
            c.jump = rng() < 0.4; c.fire = rng() < 0.25; c.autoHop = rng() < 0.3;
            c.pitch = (rng() - 0.6) * 1.8; c.dodge = rng() < 0.15 ? 1 + Math.floor(rng() * 4) : 0;
          } else c.dodge = 0;
          c.yaw += (rng() - 0.5) * 0.12;
          w.step(c);
          ticksRun++;
          const q = w.ps;
          if (!q.pos.concat(q.vel).every(Number.isFinite)) { nan++; break; }
          if (hullSolid(w.cw, q.pos)) { solid++; if (verbose) console.log(`  ${id}: inside geometry from ${name} at tick ${t}: (${q.pos.map((v) => v.toFixed(2))})`); break; }
        }
      }
    }
    if (nan) bad(`fuzz: ${nan} runs produced NaN / Infinity`);
    if (solid) bad(`fuzz: ${solid} runs ended a tick inside geometry`);
    log(`fuzz: ${ticksRun} random-input ticks, ${nan} NaN, ${solid} penetrations`);
  }
  // sloppy runs
  const need = row.diff === 'mester' ? 0 : row.diff === 'nehez' ? Math.ceil(SLOPPY_N * 0.6) : SLOPPY_N;
  let pass = 0;
  if (res.ok && SLOPPY_N > 0) {
    for (let s = 1; s <= SLOPPY_N; s++) {
      const rs = new RouteRunner(new World(map), steps, { jitter: SLOPPY, seed: s }).run();
      if (rs.ok) pass++; else log(`sloppy #${s} failed: ${rs.reason}`);
    }
    if (pass < need) bad(`sloppy runs ${pass}/${SLOPPY_N} (need ${need})`);
  }
  row.sloppy = SLOPPY_N > 0 ? `${pass}/${SLOPPY_N}` : '-';
  row.ms = performance.now() - t0;
  console.log(`  ${row.ok ? 'ok  ' : 'FAIL'} ${id.padEnd(13)} ${row.ok ? '' : '(see above)'}`);
  return row;
}

// ---------- (d) summary ----------
if (summary.length) {
  console.log('\n== (d) összegzés ==');
  console.log('pálya          nehézség   szerző   arany  ezüst  bronz  brush  checkpoint  sloppy  skip                  hash');
  for (const r of summary) {
    const m = r.medals;
    const nums = m ? [r.author, m.gold, m.silver, m.bronze].map((v) => (Number.isFinite(v) ? v.toFixed(1).padStart(6) : '     -')).join(' ') : '';
    console.log(`${(r.ok ? '' : '!') + r.id}`.padEnd(14) + ` ${r.diff.padEnd(10)} ${nums}  ${String(r.brushes ?? '-').padStart(5)}  ${String(r.cps ?? '').padStart(10)}  ${String(r.sloppy ?? '-').padStart(6)}  ${(r.skips || []).join(', ').padEnd(20)}  ${r.hash || ''}`);
  }
}

// ---------- (e) app level: nostr, leaderboard, race + net, input, store ----------
if ((!only && !probesOnly) || appOnly) {
  console.log('\n== (e) ranglista (nostr), szoba (race, net), bemenet, tárolás ==');
  const rows = await runAppTests({ only: val('only', null) });
  for (const r of rows) {
    console.log(`${r.ok ? '  ok   ' : '  FAIL '}${r.name}${verbose ? `  (${r.ms.toFixed(0)} ms)` : ''}${r.ok ? '' : '\n        ' + r.detail}`);
    if (!r.ok) failures++;
  }
  if (!rows.length) fail('(e) nincs ilyen teszt: ' + val('only', ''));
}

console.log(failures ? `\n${failures} hiba` : '\nminden rendben');
process.exit(failures ? 1 : 0);
