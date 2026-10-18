// PAJZSUGRÁS test runner:  npm run test:pj [-- --map=id] [--probes] [-v]
// Flags: --map=id (one map only), --probes (only the probe table), -v (details),
//        --gate=text (ONLY the combo gates (b.gate) whose name contains the text, on every map or on --map; with -v every deny family's
//        closest run), --nodeny (skip the deny search of the gates: solve + sloppy only), --strict-gates (a gate that one single technique
//        crosses fails the run; without it that is a warning), --sloppy=N (sloppy runs per gate, default 5).
//   (a) collision / movement unit checks + the gate checker's self-tests (+ v2-tests.mjs: physics edge cases, input path, texts;
//       gate-checker-tests.mjs: checker robustness)   (b) technique probes   (c) the built-in maps (exports of the editor, maps/*.js,
//       no proof route: build, geometry, spawns, kill volumes, fuzz, determinism; combo gates only if a map declares some or has an EXTRA entry)   (d) summary table
//   (e) app level: nostr, leaderboard, race + net, input, store, the map editor, add-map, the Gorge animation brain and figures (app-tests.mjs).
// Exit code 1 on any failure.  --app runs only (e); --only=text runs only the (e) cases whose name contains the text.
import { MAPS } from '../maps/index.js';
import { World } from '../sim/world.js';
import { makeCmd, hullSolid } from '../sim/pmove.js';
import { HULL_HX, HULL_HY } from '../sim/const.js';
import { mulberry32 } from '../sim/math.js';
import { runTraceTests } from './trace.js';
import { runProbes, printProbes } from './probes.js';
import { runAppTests } from './app-tests.mjs';
import { checkMapGates, runGateSelfTests } from './gates.mjs';
import { runV2Tests } from './v2-tests.mjs';
import { runGateCheckerTests } from './gate-checker-tests.mjs';
import { ujGates, ujRoute, staleReason, ROUTE_NAME } from './uj-palya-gates.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n, d) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const only = val('map', null), probesOnly = flag('--probes'), verbose = flag('-v') || flag('--verbose');
const appOnly = flag('--app');
const gateText = val('gate', null), gateOnly = gateText !== null, noDeny = flag('--nodeny'), strictGates = flag('--strict-gates');
let gateMatches = 0;   // gates run by --gate=text
const SLOPPY_N = Number(val('sloppy', 5));
const SLOPPY = { press: 3, aim: 2 };
// A map from the editor declares no gates, so the combo gates (and a route through them) of a built-in map are kept in a test module of their own:
// { id: { stale(map) -> text | null (a map that is not the proved one FAILS the run: nothing is skipped), gates(map) -> [gate],
//          route(map) -> { ok, time, reason, cps } | null, routeName } }
const EXTRA = { 'uj-palya': { stale: staleReason, gates: ujGates, route: ujRoute, routeName: ROUTE_NAME } };

let failures = 0;
const fail = (msg) => { failures++; console.log('  FAIL ' + msg); };

// ---------- (a) + (b) ----------
if (!only && !appOnly && !gateOnly) {
  if (!probesOnly) {
    console.log('== (a) ütközés és mozgás ==');
    for (const t of [...runTraceTests(), ...runGateSelfTests(), ...runV2Tests(), ...runGateCheckerTests()]) {
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
  for (const def of maps) summary.push(gateOnly ? checkGatesOnly(def) : checkMap(def));
  if (gateOnly && !gateMatches) fail(`nincs ilyen kapu: "${gateText}"`);
}

function groundBelow(w, p) {
  const tr = w.cw.traceBox([p[0], p[1] + HULL_HY, p[2]], [p[0], p[1] + HULL_HY - 1.0, p[2]], [HULL_HX, HULL_HY, HULL_HX]);
  return tr.fraction < 1 ? tr.normal[1] >= 0.7 : false;
}

// a seeded random-input script (what the fuzz and the determinism check play)
function randomScript(seed, n) {
  const rng = mulberry32(seed), out = [];
  let hold = 0, cur = null;
  for (let t = 0; t < n; t++) {
    if (hold-- <= 0) {
      hold = 10 + Math.floor(rng() * 50);
      cur = { fwd: rng() < 0.7 ? 1 : rng() < 0.5 ? 0 : -1, side: Math.floor(rng() * 3) - 1, jump: rng() < 0.4, fire: rng() < 0.25, pitch: (rng() - 0.6) * 1.8, dodge: 0 };
    }
    out.push({ ...cur, dodge: hold === 0 && rng() < 0.15 ? 1 + Math.floor(rng() * 4) : 0, dyaw: (rng() - 0.5) * 0.12 });
  }
  return out;
}

// A map from the editor has no proof route and no author time: build, valid geometry, spawns (a spawn off the ground is only a warning:
// the player may start in the air on purpose), kill volumes, random-input fuzz and determinism. No route, medal or skip checks.
function checkMap(def) {
  const id = def.meta.id, row = { id, diff: def.meta.diff, ok: true, notes: [] };
  const bad = (msg) => { row.ok = false; fail(`${id}: ${msg}`); };
  const warn = (msg) => { row.notes.push(msg); console.log(`  figyelmeztetés ${id}: ${msg}`); };
  const log = (msg) => { if (verbose) console.log(`  ${id}: ${msg}`); };
  let map;
  const t0 = performance.now();
  try { map = def.build(); } catch (e) { bad('build: ' + e.message); return row; }
  row.brushes = map.brushes.length; row.hash = map.mapHash;
  if (map.meta.authorTime) bad('a built-in map has no proof route: authorTime must be 0');
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
    else if (!w0.ps.grounded || !groundBelow(w0, w0.ps.pos)) warn(`${name} spawn is not on the ground (${p.map((v) => v.toFixed(2))})`);
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
  // combo gates (b.gate): only a map that declares some (an export has none; uj-palya takes its five from EXTRA, with a route through them): the intended combo reaches the goal, no single technique does
  const gateLines = [];
  const stale = map.gates.length ? null : EXTRA[id]?.stale(map);
  if (stale) bad(stale);
  const gates = map.gates.length ? map.gates : (EXTRA[id]?.gates(map) ?? []);
  if (gates.length) {
    const gr = checkMapGates({ ...map, gates }, { sloppy: SLOPPY, nSloppy: SLOPPY_N, deny: !noDeny, verbose, filter: gateText, strict: strictGates });
    row.gates = gateSummary(gr);
    gateLines.push(...gr.lines.map((l) => '  ' + l), ...gr.warns.map((l) => '  figyelmeztetés ' + l));
    for (const f of gr.fails) bad(f);
    const rt = checkRoute(id, map);
    if (rt) { gateLines.push('  ' + rt.line); if (!rt.ok) bad(rt.line); }
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
        const script = randomScript(0xf0 + seed * 7 + id.length, 1500);
        for (let t = 0; t < script.length; t++) {
          const s = script[t];
          c.fwd = s.fwd; c.side = s.side; c.jump = s.jump; c.fire = s.fire; c.pitch = s.pitch; c.dodge = s.dodge; c.yaw += s.dyaw;
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
  // determinism: the same random script from the start twice (two worlds, and a world reused through restart) gives the same state hash
  {
    const script = randomScript(0xde7e, 2400);
    const play = (w) => {
      w.restart({ silent: true });
      const c = makeCmd();
      for (const s of script) { c.fwd = s.fwd; c.side = s.side; c.jump = s.jump; c.fire = s.fire; c.pitch = s.pitch; c.dodge = s.dodge; c.yaw += s.dyaw; w.step(c); }
      return w.stateHash();
    };
    const w1 = new World(map), w2 = new World(map);
    const h1 = play(w1), h2 = play(w2), h3 = play(w1);
    if (h1 !== h2) bad('not deterministic: two worlds differ on the same input');
    if (h1 !== h3) bad('not deterministic: a restarted world differs from a fresh one');
    log(`determinism: ${h1}`);
  }
  row.ms = performance.now() - t0;
  console.log(`  ${row.ok ? 'ok  ' : 'FAIL'} ${id.padEnd(13)} ${row.ok ? '' : '(see above)'}`);
  for (const l of gateLines) console.log(l);
  return row;
}

// the route through the gates of a map (EXTRA): { ok, line } | null (the map has none)
function checkRoute(id, map) {
  const ex = EXTRA[id];
  const r = ex && ex.route ? ex.route(map) : null;
  if (!r) return null;
  return { ok: r.ok, line: r.ok ? `útvonal "${ex.routeName}": célba ér, ${r.time.toFixed(1)} s` : `útvonal "${ex.routeName}" nem ér célba: ${r.reason || 'ismeretlen ok'} (${r.cps} ellenőrzőpont)` };
}

// { ok, total, closest } of one map's gates (closest = the smallest 3D distance any denied run came to a goal box)
function gateSummary(gr) {
  const done = gr.results.filter((r) => r.closest);
  return { ok: gr.results.filter((r) => r.ok).length, total: gr.results.length, closest: done.length ? Math.min(...done.map((r) => r.closest.d)) : null };
}

// --gate=text: build the map and run only the matching gates
function checkGatesOnly(def) {
  const row = { id: def.meta.id, diff: def.meta.diff, ok: true };
  let map;
  try { map = def.build(); } catch (e) { fail(`${row.id}: build: ${e.message}`); row.ok = false; return row; }
  const stale = map.gates.length ? null : EXTRA[row.id]?.stale(map);
  if (stale) { gateMatches++; row.ok = false; failures++; console.log(`  FAIL ${row.id}: ${stale}`); }   // (the text stands for the gates: no second "nincs ilyen kapu")
  const gates = map.gates.length ? map.gates : (EXTRA[row.id]?.gates(map) ?? []);
  if (!gates.length) return row;
  const gr = checkMapGates({ ...map, gates }, { sloppy: SLOPPY, nSloppy: SLOPPY_N, deny: !noDeny, verbose, filter: gateText, strict: strictGates });
  gateMatches += gr.results.length;
  if (EXTRA[row.id] && EXTRA[row.id].routeName.toLowerCase().includes(gateText.toLowerCase())) {   // (the route runs when its name matches too)
    const rt = checkRoute(row.id, map);
    if (rt) { gateMatches++; gr.lines.push(rt.line); if (!rt.ok) gr.fails.push(rt.line); }
  }
  for (const l of gr.lines) console.log(`  ${row.id}: ${l}`);
  for (const l of gr.warns) console.log(`  figyelmeztetés ${row.id}: ${l}`);
  for (const f of gr.fails) { row.ok = false; failures++; console.log(`  FAIL ${row.id}: ${f}`); }
  return row;
}

// ---------- (d) summary ----------
if (summary.length && !gateOnly) {
  console.log('\n== (d) összegzés ==');
  console.log('pálya          brush  kapuk       figyelmeztetés  hash');
  for (const r of summary) {
    console.log(`${(r.ok ? '' : '!') + r.id}`.padEnd(14) + ` ${String(r.brushes ?? '-').padStart(5)}  ${(r.gates ? `${r.gates.ok}/${r.gates.total}${r.gates.closest === null ? '' : ' ' + r.gates.closest.toFixed(1) + 'm'}` : '-').padEnd(10)}  ${String((r.notes || []).length).padStart(14)}  ${r.hash || ''}`);
  }
}

// ---------- (e) app level: nostr, leaderboard, race + net, input, store ----------
if (((!only && !probesOnly) || appOnly) && !gateOnly) {
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
