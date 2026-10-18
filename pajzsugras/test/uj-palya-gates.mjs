// The five sections after the user's own part of "Új pálya" (maps/uj-palya.js: the user's 35 blocks end at the platform E, the checkpoint
// 3; everything after it was added with the combos below). A map from the editor declares no gates (the export has no gate item), so the
// runner takes them from here (run.mjs EXTRA): five combo gates built from the BUILT map, each starting at the checkpoint of its section,
// and the route through all five from the checkpoint 3 to the finish.
//
//   S1 diagonal jump                        E -> P1             15 m gap       deny jump dj dodge
//   S2 jump + double jump + wall dodge + dj P1 -> G2            wall W2        deny jump dj dodge dodgeJump diag wallDodge
//   S3 running shield jump + double jump   G2 -> G3            24 m gap       deny jump dj dodge dodgeJump diag
//   S4 shield jump up + dj + wall dodge + dj G3 -> G4          9.25 m up     deny all
//   S5 running shield jump + wall dodge + dj G4 -> G5          corner corridor deny all
//
// The platform G2 is only 8 m long, so S3 holds the gun from the first step on (the charge takes 1.2 s, a run along G2 about 0.9 s).
// S1-S3 teach: the shield jump (the strongest single technique) is left out of their deny lists and may skip them. The proof stands on this
// exact map: the hash covers the geometry AND the physics version (SIM_VER), so a re-export or a physics change makes the run FAIL (staleReason, counted
// like any failure, also under --gate=S) until the gates are proved again and PROVED_HASH is set to the new hash. The gates and the route still run then,
// so the report shows whether they hold on the new map.
import { R, RouteRunner } from '../sim/bot.js';
import { World } from '../sim/world.js';
import { DEG } from '../sim/math.js';

export const MAP_ID = 'uj-palya';
export const PROVED_HASH = '115ee6f8364bd4';   // the hash of the map these gates were proved on (SIM_VER 3)

const goal = (x0, x1, z0, z1, top) => ({ min: [x0, top - 0.1, z0], max: [x1, top + 2.5, z1] });   // the whole top of a landing platform

// the checkpoint i of the built map is the start of a section (cp3 = index 2 is the platform E)
const fromCp = (map, i) => ({ pos: map.checkpoints[i].spawn.slice(), yaw: map.checkpoints[i].yaw });

const SECTIONS = [
  {
    name: 'S1 átlós ugrás', combo: 'átlós ugrás', cp: 2, deny: ['jump', 'dj', 'dodge'],
    goal: goal(-81, -73, -27, -19, 11),
    solve: [R.run(-50, -18.6, { tol: 0.2 }), R.diagJump('L', { to: [-77, 11, -23], approach: 45, edge: true })],
  },
  {
    name: 'S2 ugrás, dupla ugrás, falról ugrás', combo: 'ugrás + dupla ugrás + kiugrás a falról + dupla ugrás', cp: 3, deny: ['jump', 'dj', 'dodge', 'dodgeJump', 'diag', 'wallDodge'],
    goal: goal(-100, -92, -27, -19, 15),
    solve: [R.run(-73.5, -26.4, { tol: 0.2 }), R.jump({ to: [-96, 15, -26.4], approach: 90, edge: true, air: [R.doubleJump('apex'), R.wallDodge('F', { at: 'apex' }), R.doubleJump('apex')] })],
  },
  {
    name: 'S3 futó pajzsugrás', combo: 'futó pajzsugrás + dupla ugrás', cp: 4, deny: ['jump', 'dj', 'dodge', 'dodgeJump', 'diag'],
    goal: goal(-132, -124, -27, -19, 17),
    solve: [R.charge(true), R.run(-92.5, -23), R.shieldJump({ push: [-250, -23], run: [-250, -23], pitch: -50, charge: 1, to: [-129, 17, -23], edge: true, dj: 'apex' })],
  },
  {
    name: 'S4 pajzsugrás fel', combo: 'pajzsugrás egyenesen fel + dupla ugrás + kiugrás a falról + dupla ugrás', cp: 5, deny: 'all',
    goal: goal(-132, -124, -20.5, -7.5, 26.25),
    solve: [R.run(-128, -26.45, { tol: 0.1, stop: true }), R.shieldJump({ charge: 1, yaw: 180, pitch: -89, to: [-128, 26.25, -16], steer: 5, air: [R.doubleJump('apex'), R.wallDodge(180, { at: 'apex' }), R.doubleJump('apex')] })],
  },
  {
    name: 'S5 sarokfolyosó', combo: 'futó pajzsugrás + kiugrás a falról oldalra + dupla ugrás', cp: 6, deny: 'all',
    goal: goal(-116, -108, 10.5, 14.5, 26.25),
    solve: [R.run(-128, -20, { tol: 0.3 }), R.shieldJump({ push: [-128, 250], run: [-128, 250], pitch: -50, charge: 1, to: [-128, 26.25, 14.5], edge: true, air: [R.doubleJump('apex'), R.wallDodge(-90, { at: 'wall' }), R.doubleJump('apex')] })],
  },
];

// the five gates of the built map (as b.gate stores them), without the hash check
export function buildGates(map) {
  return SECTIONS.map((s) => ({ name: s.name, combo: s.combo, start: fromCp(map, s.cp), goal: s.goal, solve: s.solve, deny: s.deny, spread: 1.0, margin: 0.6 }));
}

export const isProved = (map) => map.mapHash === PROVED_HASH;

// null for the proved map, else the failure text (Hungarian): nothing is skipped silently
export function staleReason(map) {
  if (isProved(map)) return null;
  return `Az Új pálya vagy a fizika megváltozott (a pálya hash-e ${map.mapHash}, bizonyított: ${PROVED_HASH}; a hash a SIM_VER-t is tartalmazza): bizonyítsd újra az S kapukat (npm run test:pj -- --gate=S), és frissítsd a PROVED_HASH-t (test/uj-palya-gates.mjs).`;
}

// the gates the runner adds to the map `map` (EXTRA in run.mjs); [] when the map has lost a checkpoint (staleReason says so)
export function ujGates(map) {
  try { return buildGates(map); } catch { return []; }
}

// The route from the checkpoint 3 to the finish: the five solves one after the other (each starts wherever the last one landed).
// -> { ok, time (s), reason, cps } | null (the map has lost a checkpoint)
export const ROUTE_NAME = 'S1-S5 útvonal';
export function ujRoute(map, o = {}) {
  let gates;
  try { gates = buildGates(map); } catch { return null; }
  const st = gates[0].start;
  const w = new World(map);
  w.restart({ silent: true });
  w.teleport(st.pos, st.yaw * DEG);
  w.cpIndex = SECTIONS[0].cp;   // the checkpoints before it count, as after a respawn there
  w.startClock();
  const r = new RouteRunner(w, gates.flatMap((g) => g.solve), { seed: o.seed ?? 1, jitter: o.jitter, maxSeconds: 120 }).run();
  return { ok: r.ok, time: r.time, reason: r.reason, cps: r.cps };
}
