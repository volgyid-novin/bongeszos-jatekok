// The pass: one lane from the blue base (-x) to the red base (+x), the boss pit to the north (-z),
// and a chasm along the south edge. Gameplay is flat 2D (x, z); groundHeight() only shapes the scenery.
// The walkable area is a signed distance field (negative inside), shared by the simulation and the view.

import { LANE } from './data.js';

export const WORLD = { minX: -76, maxX: 76, minZ: -40, maxZ: 40 };
export const PIT = { x: 0, z: -17.5, r: 7.6 };
const GATE = { x: 0, z: -9.6, hx: 3.3, hz: 3.8 };
const BASE_X = 55, BASE_R = 11, LANE_END = 55;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// lane half-width: wider at mid (the fight spot) and around the inner towers; mirror-symmetric in x
export function laneHW(x) {
  return 6.2 + 1.7 * Math.exp(-((x / 9) ** 2)) + 0.9 * Math.exp(-(((Math.abs(x) - 30) / 6) ** 2))
    + 0.3 * Math.cos(x * 0.61) + 0.2 * Math.cos(x * 1.73);
}

function sdBox(x, z, cx, cz, hx, hz) {
  const qx = Math.abs(x - cx) - hx, qz = Math.abs(z - cz) - hz;
  const ox = Math.max(qx, 0), oz = Math.max(qz, 0);
  return Math.hypot(ox, oz) + Math.min(Math.max(qx, qz), 0);
}
const dLane = (x, z) => Math.max(Math.abs(z) - laneHW(x), Math.abs(x) - LANE_END);
const dBase = (x, z) => Math.min(Math.hypot(x + BASE_X, z), Math.hypot(x - BASE_X, z)) - BASE_R;
const dPit = (x, z) => Math.hypot(x - PIT.x, z - PIT.z) - PIT.r;
const dGate = (x, z) => sdBox(x, z, GATE.x, GATE.z, GATE.hx, GATE.hz);

export function sdf(x, z) {
  return Math.min(dLane(x, z), dBase(x, z), dPit(x, z), dGate(x, z));
}
export const walkable = (x, z, r = 0) => sdf(x, z) < -r;
export const inPit = (x, z) => dPit(x, z) < 0.3 || (dGate(x, z) < 0 && z < -9.6);

// push a circle of radius r back inside the walkable area
export function keepInside(p, r) {
  for (let i = 0; i < 3; i++) {
    const d = sdf(p.x, p.z) + r;
    if (d <= 0) return p;
    const e = 0.05;
    let gx = sdf(p.x + e, p.z) - sdf(p.x - e, p.z), gz = sdf(p.x, p.z + e) - sdf(p.x, p.z - e);
    const gl = Math.hypot(gx, gz) || 1;
    gx /= gl; gz /= gl;
    p.x -= gx * (d + 0.01); p.z -= gz * (d + 0.01);
  }
  return p;
}

// is the straight line between two points walkable for a circle of radius r?
export function clearLine(ax, az, bx, bz, r = 0.4) {
  const len = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(len / 0.5));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    if (sdf(ax + (bx - ax) * t, az + (bz - az) * t) > -r * 0.6) return false;
  }
  return true;
}

// A tiny visibility graph for the few places a straight line does not work:
// through the gate of the pit, and the corners where the lane meets a base.
const NODES = [
  { x: 0, z: -5.6 }, { x: 0, z: -9.6 }, { x: 0, z: -13.2 },
  { x: -46, z: 0 }, { x: 46, z: 0 },
];
const NODE_LINKS = NODES.map((a, i) => NODES.map((b, j) => i !== j && clearLine(a.x, a.z, b.x, b.z, 0.6)));

// returns the next point to walk toward (the target itself when the line is clear)
export function nextWaypoint(fx, fz, tx, tz, r = 0.5) {
  if (clearLine(fx, fz, tx, tz, r)) return { x: tx, z: tz };
  const n = NODES.length, S = n, T = n + 1;
  const pos = (i) => (i === S ? { x: fx, z: fz } : i === T ? { x: tx, z: tz } : NODES[i]);
  const link = (i, j) => {
    if (i < n && j < n) return NODE_LINKS[i][j];
    const a = pos(i), b = pos(j);
    return clearLine(a.x, a.z, b.x, b.z, r);
  };
  // Dijkstra over n + 2 points
  const dist = new Array(n + 2).fill(Infinity), prev = new Array(n + 2).fill(-1), done = new Array(n + 2).fill(false);
  dist[S] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < n + 2; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
    if (u < 0 || u === T) break;
    done[u] = true;
    const pu = pos(u);
    for (let v = 0; v < n + 2; v++) {
      if (done[v] || v === u || !link(u, v)) continue;
      const pv = pos(v), d = dist[u] + Math.hypot(pv.x - pu.x, pv.z - pu.z);
      if (d < dist[v]) { dist[v] = d; prev[v] = u; }
    }
  }
  if (dist[T] === Infinity) {
    // no route found (target outside the map): head for the nearest node
    let best = NODES[0], bd = Infinity;
    for (const p of NODES) { const d = Math.hypot(p.x - fx, p.z - fz); if (d < bd && clearLine(fx, fz, p.x, p.z, r)) { bd = d; best = p; } }
    return bd < 0.8 ? { x: tx, z: tz } : best;
  }
  let v = T;
  while (prev[v] !== S && prev[v] >= 0) v = prev[v];
  return pos(v);
}

// ---------- brushes (hide whoever stands inside) and health relics ----------
export const BRUSHES = [
  { x: -7.6, z: -5.0, rx: 2.4, rz: 1.5 }, { x: 7.6, z: -5.0, rx: 2.4, rz: 1.5 },
  { x: -23.5, z: 4.7, rx: 2.6, rz: 1.4 }, { x: 23.5, z: 4.7, rx: 2.6, rz: 1.4 },
];
export function brushAt(x, z) {
  for (let i = 0; i < BRUSHES.length; i++) {
    const b = BRUSHES[i], dx = (x - b.x) / b.rx, dz = (z - b.z) / b.rz;
    if (dx * dx + dz * dz < 1) return i;
  }
  return -1;
}
export const RELICS = [{ x: -11.5, z: 4.4 }, { x: 11.5, z: 4.4 }];

// spots: fountains, structures (blue first, red is the mirror)
export const fountainPos = (team) => ({ x: team === 0 ? -LANE.fountainX : LANE.fountainX, z: 0 });
export const laneDir = (team) => (team === 0 ? 1 : -1);

// ---------- scenery height (gameplay ignores it; walkable ground is ~0) ----------
function hash2(ix, iz) {
  let h = Math.imul(ix, 374761393) + Math.imul(iz, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
export function vnoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz), b = hash2(ix + 1, iz), c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}
export function fbm(x, z, oct = 4) {
  let s = 0, a = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { s += a * vnoise(x * f, z * f); f *= 2.03; a *= 0.5; }
  return s;
}

// south of the lane (z > 0) the ground drops into the chasm, everywhere else it climbs into cliffs.
// Between the lane and the pit the ridge stays low, so the camera (looking north) can see into the pit.
export function groundHeight(x, z) {
  const d = sdf(x, z);
  const bump = (fbm(x * 0.35, z * 0.35, 3) - 0.5) * 0.12;
  if (d < 0) return bump * smooth(-1.5, 0, -d) * 0.5;
  const n = fbm(x * 0.18 + 7, z * 0.18 - 3, 4);
  const southChasm = z > 0 && dBase(x, z) > 1.5;
  if (southChasm) {
    // a short rocky lip, then the drop
    const lip = 0.35 * Math.exp(-(((d - 0.8) / 0.6) ** 2));
    return lip - 16 * smooth(1.2, 7, d) * (0.85 + 0.3 * n);
  }
  // how high the cliff gets here: low ridge in front of the pit, tall walls behind it and around the bases
  const front = Math.exp(-((x / 12) ** 2)) * smooth(-16, -12, z);
  const top = (5.6 + 3.4 * n + 2.2 * smooth(-20, -28, z)) * (1 - front) + (1.4 + 0.6 * n) * front;
  const rise = smooth(0.2, 2.6 + 1.5 * n, d);
  const terrace = Math.round(rise * 3) / 3;           // stepped, painted-looking cliffs
  return (rise * 0.55 + terrace * 0.45) * top + bump;
}
