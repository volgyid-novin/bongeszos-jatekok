import {
  MAP, TICK, UNITS, BUILDINGS, UPGRADES, RACES, MINE, START_RES, START_WORKERS, CARRY, MINE_TIME, CHOP_TIME,
  TREE_WOOD, QUEUE_MAX, FOOD_MAX,
} from './data.js';

// Deterministic lockstep simulation. Both peers run exactly this code on the same commands,
// so it must give bit-identical results everywhere: only + - * / and Math.sqrt / floor / min / max
// (no sin, cos, atan2, hypot, pow, exp, Math.random), iteration always in entity id order.

const N = MAP;
export const FREE = 0, TREE = 1, SOLID = 2, ROCK = 3;
const SQ2 = 1.4142135623730951;
const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DZ = [0, 0, 1, -1, 1, -1, 1, -1];
const COST = [1, 1, 1, 1, SQ2, SQ2, SQ2, SQ2];
// fallback push directions when two units sit exactly on top of each other
const PUSH = [[1, 0], [0.7071, 0.7071], [0, 1], [-0.7071, 0.7071], [-1, 0], [-0.7071, -0.7071], [0, -1], [0.7071, -0.7071]];
const BUILD_RATE = [0, 1, 1.6, 2.1, 2.5, 2.8, 3];

export function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash2(ix, iz, s) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(s, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function vnoise(x, z, s) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz, s), b = hash2(ix + 1, iz, s), c = hash2(ix, iz + 1, s), d = hash2(ix + 1, iz + 1, s);
  const top = a + (b - a) * ux, bot = c + (d - c) * ux;
  return top + (bot - top) * uz;
}
export function fbm(x, z, s, oct = 3) {
  let sum = 0, amp = 0.5, f = 1, norm = 0;
  for (let o = 0; o < oct; o++) { sum += amp * vnoise(x * f, z * f, s + o * 31); norm += amp; f *= 2.03; amp *= 0.5; }
  return sum / norm;
}

export const tileIdx = (x, z) => z * N + x;
const clampN = (v, a, b) => (v < a ? a : v > b ? b : v);
export function distRect(x, z, x0, z0, x1, z1) {
  const dx = x < x0 ? x0 - x : x > x1 ? x - x1 : 0;
  const dz = z < z0 ? z0 - z : z > z1 ? z - z1 : 0;
  return Math.sqrt(dx * dx + dz * dz);
}
// Edge-to-edge distance from a unit to any entity
export function edgeDist(u, t) {
  if (t.cls === 'u') {
    const dx = t.x - u.x, dz = t.z - u.z;
    return Math.sqrt(dx * dx + dz * dz) - u.r - t.r;
  }
  return distRect(u.x, u.z, t.tx, t.tz, t.tx + t.size, t.tz + t.size) - u.r;
}
const isMilitary = (d) => !d.worker;

// Grid offsets for group move slots, nearest to the centre first
const OFFS = [];
for (let dz = -7; dz <= 7; dz++) for (let dx = -7; dx <= 7; dx++) OFFS.push([dx, dz]);
OFFS.sort((a, b) => (a[0] * a[0] + a[1] * a[1]) - (b[0] * b[0] + b[1] * b[1]) || a[1] - b[1] || a[0] - b[0]);

// ============================================================
//  A* on the tile grid (8 directions, no corner cutting)
// ============================================================
class Pather {
  constructor(sim) {
    this.sim = sim;
    const n = N * N;
    this.g = new Float64Array(n);
    this.from = new Int32Array(n);
    this.seen = new Uint32Array(n);
    this.closed = new Uint32Array(n);
    this.gen = 0;
    this.hi = new Int32Array(n * 8);
    this.hf = new Float64Array(n * 8);
    this.hn = 0;
  }
  push(i, f) {
    const hi = this.hi, hf = this.hf;
    let k = this.hn++;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (hf[p] <= f) break;
      hi[k] = hi[p]; hf[k] = hf[p]; k = p;
    }
    hi[k] = i; hf[k] = f;
  }
  pop() {
    const hi = this.hi, hf = this.hf, top = hi[0], n = --this.hn;
    if (n > 0) {
      const li = hi[n], lf = hf[n];
      let k = 0;
      for (;;) {
        let c = 2 * k + 1;
        if (c >= n) break;
        if (c + 1 < n && hf[c + 1] < hf[c]) c++;
        if (hf[c] >= lf) break;
        hi[k] = hi[c]; hf[k] = hf[c]; k = c;
      }
      hi[k] = li; hf[k] = lf;
    }
    return top;
  }
  // Tiles from the start tile to the first tile whose centre is within `range` of the rect.
  // If the goal can't be reached, the path ends at the closest explored tile.
  find(sx, sz, x0, z0, x1, z1, range) {
    const B = this.sim.block, g = this.g, from = this.from, seen = this.seen, closed = this.closed;
    let s = tileIdx(clampN(Math.floor(sx), 0, N - 1), clampN(Math.floor(sz), 0, N - 1));
    if (B[s]) s = this.sim.nearestFree(s, 8);
    if (s < 0) return null;
    const gen = ++this.gen;
    this.hn = 0;
    const rr = range > 0.75 ? range : 0.75;
    const H = (i) => {
      const cx = (i % N) + 0.5, cz = ((i / N) | 0) + 0.5;
      const dx = cx < x0 ? x0 - cx : cx > x1 ? cx - x1 : 0;
      const dz = cz < z0 ? z0 - cz : cz > z1 ? cz - z1 : 0;
      const h = dx > dz ? dx + (SQ2 - 1) * dz : dz + (SQ2 - 1) * dx;
      return h > rr ? h - rr : 0;
    };
    g[s] = 0; seen[s] = gen; from[s] = -1;
    this.push(s, H(s));
    let best = s, bestH = H(s), goal = -1, exp = 0;
    while (this.hn > 0) {
      const c = this.pop();
      if (closed[c] === gen) continue;
      closed[c] = gen;
      const cx = c % N, cz = (c / N) | 0;
      if (distRect(cx + 0.5, cz + 0.5, x0, z0, x1, z1) <= rr) { goal = c; break; }
      const h = H(c);
      if (h < bestH) { bestH = h; best = c; }
      if (++exp > 7000) break;
      for (let k = 0; k < 8; k++) {
        const nx = cx + DX[k], nz = cz + DZ[k];
        if (nx < 0 || nz < 0 || nx >= N || nz >= N) continue;
        const ni = nz * N + nx;
        if (B[ni] || closed[ni] === gen) continue;
        if (k >= 4 && (B[cz * N + nx] || B[nz * N + cx])) continue;
        const ng = g[c] + COST[k];
        if (seen[ni] !== gen || ng < g[ni]) {
          seen[ni] = gen; g[ni] = ng; from[ni] = c;
          this.push(ni, ng + H(ni) * 1.001);
        }
      }
    }
    const end = goal >= 0 ? goal : best;
    const tiles = [];
    for (let i = end; i !== -1; i = from[i]) tiles.push(i);
    tiles.reverse();
    return { tiles, reached: goal >= 0 };
  }
}

// ============================================================
//  Simulation
// ============================================================
export class Sim {
  // cfg: { seed, races: ['human' | 'orc', ...], mul?: [gatherMul0, gatherMul1] }
  constructor(cfg) {
    this.seed = cfg.seed | 0;
    this.tick = 0;
    this.ents = [];
    this.byId = new Map();
    this.nextId = 1;
    this.pid = 1;
    this.block = new Uint8Array(N * N);
    this.occ = new Int32Array(N * N);
    this.wood = new Uint8Array(N * N);
    this.projs = [];
    this.events = [];
    this.winner = -1;    // -1 running, 0/1 winner slot, 2 draw
    this.players = cfg.races.map((race, slot) => ({
      slot, race, gold: START_RES.gold, wood: START_RES.wood, food: 0, cap: 0,
      up: { w: 0, a: 0 }, upq: { w: 0, a: 0 }, mul: (cfg.mul && cfg.mul[slot]) || 1, alertT: -9999,
      st: { trained: 0, lost: 0, kills: 0, built: 0, razed: 0, bLost: 0, gold: 0, wood: 0 },
    }));
    this.pf = new Pather(this);
    this.cellHead = new Int32Array(48 * 48);
    this.cellNext = new Int32Array(4096);
    this.genMap();
    this.setup();
    this.economy();
  }

  // ---------- map ----------
  mirrorTile(i) { return N * N - 1 - i; }
  genMap() {
    const B = this.block, W = this.wood, s = this.seed;
    const R = rng(s ^ 0x5bd1e995);
    const o1 = Math.floor(R() * 900), o2 = Math.floor(R() * 900);
    const set = (i, v) => { B[i] = v; W[i] = v === TREE ? TREE_WOOD : 0; const j = N * N - 1 - i; B[j] = v; W[j] = W[i]; };
    for (let i = 0; i < (N * N) / 2; i++) {
      const x = i % N, z = (i / N) | 0;
      const n = fbm((x + o1) * 0.085, (z + o2) * 0.085, s & 0xffff);
      const edge = Math.min(x, z, N - 1 - x, N - 1 - z);
      const border = edge < 3 ? 0.4 : edge < 9 ? (0.16 * (9 - edge)) / 6 : 0;
      const r = fbm((x - o2) * 0.21, (z + o1) * 0.21, (s >> 7) & 0xffff, 2);
      set(i, n + border > 0.6 ? TREE : r > 0.8 ? ROCK : FREE);
    }
    // lumber lines behind each base (slot-0 coordinates, mirrored)
    const forest = (x0, z0, x1, z1, dens) => {
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
        if (hash2(x, z, s + 7) < dens) set(tileIdx(x, z), TREE);
      }
    };
    forest(3, 2, 32, 7, 0.82);
    forest(2, 3, 6, 34, 0.82);
    const clear = (cx, cz, r) => {
      const r2 = r * r;
      for (let z = Math.floor(cz - r); z <= Math.ceil(cz + r); z++) for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        if (x < 0 || z < 0 || x >= N || z >= N) continue;
        const dx = x + 0.5 - cx, dz = z + 0.5 - cz;
        if (dx * dx + dz * dz <= r2) set(tileIdx(x, z), FREE);
      }
    };
    const P = this.layout();
    clear(16, 16, 9.5);
    for (const m of P.mines) clear(m.tx + 1.5, m.tz + 1.5, m.main ? 3.6 : 6.5);
    const carve = (pts, w) => {
      for (let k = 0; k + 1 < pts.length; k++) {
        const [ax, az] = pts[k], [bx, bz] = pts[k + 1];
        const dx = bx - ax, dz = bz - az, len = Math.sqrt(dx * dx + dz * dz);
        const nx = -dz / len, nz = dx / len;
        for (let t = 0; t <= len; t += 0.5) {
          const wob = (fbm((ax + t) * 0.07, (az - t) * 0.07, s + 99, 2) - 0.5) * 5;
          clear(ax + (dx * t) / len + nx * wob, az + (dz * t) / len + nz * wob, w);
        }
      }
    };
    carve([[16, 16], [24, 30], [31.5, 25.5]], 2.8);
    carve([[31.5, 25.5], [40, 38], [47.5, 47.5]], 3.2);
    carve([[16, 16], [22, 44], [14, 68], [12.5, 85.5]], 2.6);
    carve([[31.5, 25.5], [54, 22], [72, 13], [83.5, 10.5]], 2.6);
    carve([[24, 30], [38, 56], [47.5, 47.5]], 2.4);
    // the map border is always forest
    for (let i = 0; i < N * N; i++) {
      const x = i % N, z = (i / N) | 0;
      if (x === 0 || z === 0 || x === N - 1 || z === N - 1) { B[i] = TREE; W[i] = TREE_WOOD; }
    }
  }
  // Start positions and gold mines (tile top-left). Index 0/1 = slot 0/1 start.
  layout() {
    if (this._layout) return this._layout;
    const mir = (tx, tz, sz) => [N - tx - sz, N - tz - sz];
    const hq = [[14, 14], mir(14, 14, 4)];
    const base = [
      { tx: 8, tz: 17, gold: 9000, main: true },
      { tx: 30, tz: 24, gold: 7000 },
      { tx: 82, tz: 9, gold: 12000 },
    ];
    const mines = [];
    for (const m of base) {
      mines.push(m);
      const [x, z] = mir(m.tx, m.tz, 3);
      mines.push({ tx: x, tz: z, gold: m.gold, main: m.main });
    }
    this._layout = { hq, mines };
    return this._layout;
  }
  setup() {
    const P = this.layout();
    for (const m of P.mines) {
      const e = this.addEnt({ cls: 'm', type: 'mine', owner: -1, tx: m.tx, tz: m.tz, size: 3, x: m.tx + 1.5, z: m.tz + 1.5, gold: m.gold, inside: 0, hp: 1, r: 1.5 });
      this.stamp(e, true);
    }
    for (let p = 0; p < this.players.length; p++) {
      const race = RACES[this.players[p].race];
      const [tx, tz] = P.hq[p];
      const hq = this.makeBuilding(p, race.hq, tx, tz, true);
      const mine = this.nearestMine(hq.x, hq.z, 30);
      for (let k = 0; k < START_WORKERS; k++) {
        const t = this.spawnSpot(hq, mine ? mine.x : hq.x, mine ? mine.z : hq.z);
        const u = this.makeUnit(p, race.worker, (t % N) + 0.5, ((t / N) | 0) + 0.5);
        if (mine) u.ord = { t: 'gather', res: 'g', mine: mine.id, tree: -1, s: 'go' };
      }
    }
  }
  stamp(e, on) {
    for (let z = e.tz; z < e.tz + e.size; z++) for (let x = e.tx; x < e.tx + e.size; x++) {
      const i = tileIdx(x, z);
      this.block[i] = on ? SOLID : FREE;
      this.occ[i] = on ? e.id : 0;
    }
  }
  free(i) { return this.block[i] === FREE; }
  freeXZ(x, z) {
    if (x < 0 || z < 0 || x >= N || z >= N) return false;
    return this.block[Math.floor(z) * N + Math.floor(x)] === FREE;
  }
  nearestFree(i, maxR = 12) {
    if (this.block[i] === FREE) return i;
    const cx = i % N, cz = (i / N) | 0;
    for (let r = 1; r <= maxR; r++) {
      let best = -1, bd = 1e9;
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        if (dx !== -r && dx !== r && dz !== -r && dz !== r) continue;
        const x = cx + dx, z = cz + dz;
        if (x < 0 || z < 0 || x >= N || z >= N) continue;
        const j = z * N + x;
        if (this.block[j] !== FREE) continue;
        const d = dx * dx + dz * dz;
        if (d < bd) { bd = d; best = j; }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  // ---------- entities ----------
  addEnt(e) {
    e.id = this.nextId++;
    e.dead = false;
    this.ents.push(e);
    this.byId.set(e.id, e);
    return e;
  }
  get(id) {
    const e = this.byId.get(id);
    return e && !e.dead ? e : null;
  }
  makeUnit(owner, type, x, z) {
    const d = UNITS[type];
    return this.addEnt({
      cls: 'u', type, owner, x, z, px: x, pz: z, hp: d.hp, r: d.r, ord: { t: 'idle' }, path: null, pi: 0, gk: '',
      fails: 0, cd: 0, tgt: 0, atkT: -99, carry: 0, cres: '', hidden: false, inMine: 0, workT: 0, still: false,
      sx: x, sz: z, stuck: 0, hx: x, hz: z,
    });
  }
  makeBuilding(owner, type, tx, tz, done) {
    const d = BUILDINGS[type];
    const b = this.addEnt({
      cls: 'b', type, owner, tx, tz, size: d.size, x: tx + d.size / 2, z: tz + d.size / 2, px: tx + d.size / 2, pz: tz + d.size / 2,
      hp: done ? d.hp : Math.max(1, Math.round(d.hp * 0.1)), done, prog: done ? 1 : 0, queue: [], qt: 0, rally: null,
      cd: 0, tgt: 0, atkT: -99, bt: 0, r: d.size / 2,
    });
    this.stamp(b, true);
    this.evict(tx, tz, d.size);
    return b;
  }
  // push every unit out of a freshly placed footprint
  evict(tx, tz, size) {
    for (const u of this.ents) {
      if (u.cls !== 'u' || u.dead || u.hidden) continue;
      if (u.x + u.r <= tx || u.x - u.r >= tx + size || u.z + u.r <= tz || u.z - u.r >= tz + size) continue;
      const t = this.nearestFree(tileIdx(clampN(Math.floor(u.x), 0, N - 1), clampN(Math.floor(u.z), 0, N - 1)), 10);
      if (t >= 0) { u.x = (t % N) + 0.5; u.z = ((t / N) | 0) + 0.5; u.px = u.x; u.pz = u.z; u.path = null; u.gk = ''; }
    }
  }
  // free tile around a building, closest to (ax, az)
  spawnSpot(b, ax, az) {
    for (let ring = 1; ring <= 4; ring++) {
      let best = -1, bd = 1e9;
      for (let z = b.tz - ring; z < b.tz + b.size + ring; z++) for (let x = b.tx - ring; x < b.tx + b.size + ring; x++) {
        if (x > b.tx - ring && x < b.tx + b.size + ring - 1 && z > b.tz - ring && z < b.tz + b.size + ring - 1) continue;
        if (x < 0 || z < 0 || x >= N || z >= N) continue;
        const i = z * N + x;
        if (this.block[i] !== FREE) continue;
        const dx = x + 0.5 - ax, dz = z + 0.5 - az, d = dx * dx + dz * dz;
        if (d < bd) { bd = d; best = i; }
      }
      if (best >= 0) return best;
    }
    return this.nearestFree(tileIdx(Math.floor(b.x), Math.floor(b.z)), 20);
  }
  hasDone(owner, type) {
    for (const e of this.ents) if (e.cls === 'b' && e.owner === owner && e.type === type && e.done && !e.dead) return true;
    return false;
  }
  reqMet(owner, def) { return !def.req || this.hasDone(owner, def.req); }
  nearestMine(x, z, maxD) {
    let best = null, bd = maxD * maxD;
    for (const e of this.ents) {
      if (e.cls !== 'm' || e.dead || e.gold <= 0) continue;
      const dx = e.x - x, dz = e.z - z, d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }
  nearestDrop(u) {
    let best = null, bd = 1e18;
    for (const e of this.ents) {
      if (e.cls !== 'b' || e.dead || e.owner !== u.owner || !e.done || !BUILDINGS[e.type].drop) continue;
      const d = distRect(u.x, u.z, e.tx, e.tz, e.tx + e.size, e.tz + e.size);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }
  nearestTree(x, z, maxR) {
    const cx = clampN(Math.floor(x), 0, N - 1), cz = clampN(Math.floor(z), 0, N - 1);
    let best = -1, bd = 1e9;
    for (let dz = -maxR; dz <= maxR; dz++) for (let dx = -maxR; dx <= maxR; dx++) {
      const tx = cx + dx, tz = cz + dz;
      if (tx < 1 || tz < 1 || tx >= N - 1 || tz >= N - 1) continue;
      const i = tz * N + tx;
      if (this.block[i] !== TREE) continue;
      // must be reachable: at least one free neighbour
      if (this.block[i - 1] && this.block[i + 1] && this.block[i - N] && this.block[i + N]) continue;
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  canPlace(owner, type, tx, tz) {
    const d = BUILDINGS[type];
    if (!d) return false;
    if (tx < 1 || tz < 1 || tx + d.size > N - 1 || tz + d.size > N - 1) return false;
    for (let z = tz; z < tz + d.size; z++) for (let x = tx; x < tx + d.size; x++) if (this.block[z * N + x] !== FREE) return false;
    if (d.hq) {
      for (const e of this.ents) {
        if (e.cls !== 'm' || e.dead) continue;
        if (tx < e.tx + 3 + 3 && tx + d.size > e.tx - 3 && tz < e.tz + 3 + 3 && tz + d.size > e.tz - 3) return false;
      }
    }
    for (const e of this.ents) {
      if (e.cls !== 'u' || e.dead || e.hidden || e.owner === owner) continue;
      if (e.x + e.r > tx && e.x - e.r < tx + d.size && e.z + e.r > tz && e.z - e.r < tz + d.size) return false;
    }
    return true;
  }

  // ---------- commands ----------
  // cmd arrays (all numbers quantised by the sender):
  // ['m', ids, x, z]  ['am', ids, x, z]  ['a', ids, target]  ['gm', ids, mine]  ['gt', ids, tile]
  // ['rt', ids]  ['s', ids]  ['h', ids]  ['b', worker, type, tx, tz]  ['hb', ids, building]
  // ['t', building, unitType]  ['u', building, 'w'|'a']  ['x', building]  ['rp', ids, x, z, target, tile]  ['gg']
  apply(p, c) {
    if (!Array.isArray(c) || typeof c[0] !== 'string' || this.winner >= 0) return;
    const units = (ids) => {
      const out = [];
      if (!Array.isArray(ids)) return out;
      for (let k = 0; k < ids.length && k < 200; k++) {
        const e = this.get(ids[k] | 0);
        if (e && e.cls === 'u' && e.owner === p && out.indexOf(e) < 0) out.push(e);
      }
      return out;
    };
    const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);
    const own = (id) => { const e = this.get(id | 0); return e && e.cls === 'b' && e.owner === p ? e : null; };
    switch (c[0]) {
      case 'm': case 'am': {
        const us = units(c[1]);
        if (us.length) this.groupMove(us, clampN(num(c[2]), 0.5, N - 0.5), clampN(num(c[3]), 0.5, N - 0.5), c[0] === 'am');
        break;
      }
      case 'a': {
        const t = this.get(c[2] | 0);
        if (!t || t.cls === 'm') break;
        for (const u of units(c[1])) {
          this.release(u);
          if (t.owner === p) { this.moveTo(u, t.x, t.z); continue; }
          u.ord = { t: 'attack', id: t.id, auto: false, ax: null, az: null };
          u.gk = '';
        }
        break;
      }
      case 'gm': {
        const m = this.get(c[2] | 0);
        if (!m || m.cls !== 'm') break;
        for (const u of units(c[1])) {
          this.release(u);
          if (!UNITS[u.type].worker) { this.moveTo(u, m.x, m.z); continue; }
          u.ord = { t: 'gather', res: 'g', mine: m.id, tree: -1, s: u.carry && u.cres === 'g' ? 'back' : 'go' };
          u.gk = '';
        }
        break;
      }
      case 'gt': {
        const i = c[2] | 0;
        if (i < 0 || i >= N * N || this.block[i] !== TREE) break;
        for (const u of units(c[1])) {
          this.release(u);
          if (!UNITS[u.type].worker) { this.moveTo(u, (i % N) + 0.5, ((i / N) | 0) + 0.5); continue; }
          u.ord = { t: 'gather', res: 'w', mine: 0, tree: i, s: u.carry && u.cres === 'w' ? 'back' : 'go' };
          u.gk = '';
        }
        break;
      }
      case 'rt':
        for (const u of units(c[1])) {
          if (!u.carry) continue;
          this.release(u);
          u.ord = { t: 'gather', res: u.cres, mine: 0, tree: -1, s: 'back', once: true };
          u.gk = '';
        }
        break;
      case 's': for (const u of units(c[1])) { this.release(u); this.setIdle(u); } break;
      case 'h': for (const u of units(c[1])) { this.release(u); u.ord = { t: 'hold' }; u.path = null; } break;
      case 'b': {
        const [u] = units([c[1]]);
        const type = c[2], tx = c[3] | 0, tz = c[4] | 0;
        const d = BUILDINGS[type];
        if (!u || !d || !UNITS[u.type].worker || d.race !== this.players[p].race) break;
        if (!this.reqMet(p, d)) { this.msg(p, `Ehhez előbb kell: ${BUILDINGS[d.req].name}.`); break; }
        this.release(u);
        u.ord = { t: 'build', type, tx, tz };
        u.gk = '';
        break;
      }
      case 'hb': {
        const b = own(c[2]);
        if (!b || b.done) break;
        for (const u of units(c[1])) {
          this.release(u);
          if (!UNITS[u.type].worker) { this.moveTo(u, b.x, b.z); continue; }
          u.ord = { t: 'help', id: b.id };
          u.gk = '';
        }
        break;
      }
      case 't': this.train(p, own(c[1]), c[2]); break;
      case 'u': this.research(p, own(c[1]), c[2]); break;
      case 'x': this.cancel(p, own(c[1])); break;
      case 'rp': {
        if (!Array.isArray(c[1])) break;
        for (const id of c[1].slice(0, 50)) {
          const b = own(id);
          if (b) b.rally = { x: clampN(num(c[2]), 0.5, N - 0.5), z: clampN(num(c[3]), 0.5, N - 0.5), id: c[4] | 0, tree: c[5] == null ? -1 : c[5] | 0 };
        }
        break;
      }
      case 'gg': this.finish(1 - p); break;
    }
  }
  msg(p, text) { this.events.push({ e: 'msg', p, text }); }
  // a worker leaving a gold mine pops out without its load
  release(u) {
    if (u.inMine) {
      const m = this.get(u.inMine);
      if (m) m.inside--;
      this.popOut(u, m);
    }
    u.still = false;
  }
  popOut(u, m) {
    u.hidden = false;
    u.inMine = 0;
    if (!m) return;
    const drop = this.nearestDrop(u);
    const t = this.spawnSpot(m, drop ? drop.x : m.x, drop ? drop.z : m.z);
    if (t >= 0) { u.x = (t % N) + 0.5; u.z = ((t / N) | 0) + 0.5; u.px = u.x; u.pz = u.z; }
  }
  setIdle(u) {
    u.ord = { t: 'idle' };
    u.path = null;
    u.gk = '';
    u.hx = u.x; u.hz = u.z;
  }
  moveTo(u, x, z) {
    u.ord = { t: 'move', x, z };
    this.plan(u, x, z, x, z, 0, true);
    u.gk = 'mv';
  }
  groupMove(us, x, z, amove) {
    const slots = [];
    if (us.length === 1) slots.push([x, z]);
    else {
      let sp = 0;
      for (const u of us) sp = Math.max(sp, u.r * 2 + 0.2);
      for (const [ox, oz] of OFFS) {
        const sx = x + ox * sp, sz = z + oz * sp;
        if (sx < 0.6 || sz < 0.6 || sx > N - 0.6 || sz > N - 0.6 || !this.freeXZ(sx, sz)) continue;
        slots.push([sx, sz]);
        if (slots.length >= us.length) break;
      }
      while (slots.length < us.length) slots.push([x, z]);
    }
    const left = us.slice();
    for (const [sx, sz] of slots) {
      let bi = 0, bd = 1e18;
      for (let k = 0; k < left.length; k++) {
        const dx = left[k].x - sx, dz = left[k].z - sz, d = dx * dx + dz * dz;
        if (d < bd) { bd = d; bi = k; }
      }
      const u = left.splice(bi, 1)[0];
      this.release(u);
      if (amove) {
        u.ord = { t: 'amove', x: sx, z: sz };
        this.plan(u, sx, sz, sx, sz, 0, true);
        u.gk = 'am';
      } else this.moveTo(u, sx, sz);
      if (!left.length) break;
    }
  }
  train(p, b, type) {
    const d = UNITS[type], pl = this.players[p];
    if (!b || !b.done || !d) return;
    const bd = BUILDINGS[b.type];
    if (!bd.trains || bd.trains.indexOf(type) < 0) return;
    if (!this.reqMet(p, d)) { this.msg(p, `Ehhez előbb kell: ${BUILDINGS[d.req].name}.`); return; }
    if (b.queue.length >= QUEUE_MAX) { this.msg(p, 'A sor megtelt.'); return; }
    if (pl.gold < d.cost.g) { this.msg(p, 'Nincs elég arany.'); return; }
    if (pl.wood < d.cost.w) { this.msg(p, 'Nincs elég fa.'); return; }
    if (pl.food + d.food > pl.cap) { this.msg(p, pl.cap >= FOOD_MAX ? 'Elérted az élelem felső határát.' : RACES[pl.race].needFood); return; }
    pl.gold -= d.cost.g; pl.wood -= d.cost.w; pl.food += d.food;
    b.queue.push({ u: type });
  }
  research(p, b, key) {
    const up = UPGRADES[key], pl = this.players[p];
    if (!b || !b.done || !up) return;
    const bd = BUILDINGS[b.type];
    if (!bd.research || bd.research.indexOf(key) < 0) return;
    const lvl = pl.up[key];
    if (pl.upq[key] || lvl >= 2) return;
    if (b.queue.length >= QUEUE_MAX) { this.msg(p, 'A sor megtelt.'); return; }
    const cost = up.cost[lvl];
    if (pl.gold < cost.g) { this.msg(p, 'Nincs elég arany.'); return; }
    if (pl.wood < cost.w) { this.msg(p, 'Nincs elég fa.'); return; }
    pl.gold -= cost.g; pl.wood -= cost.w;
    pl.upq[key] = 1;
    b.queue.push({ up: key, lvl });
  }
  cancel(p, b) {
    if (!b) return;
    const pl = this.players[p];
    if (!b.done) {
      const c = BUILDINGS[b.type].cost;
      pl.gold += Math.floor(c.g * 0.75); pl.wood += Math.floor(c.w * 0.75);
      this.kill(b, -1, true);
      return;
    }
    const it = b.queue.pop();
    if (!it) return;
    if (it.u) { const d = UNITS[it.u]; pl.gold += d.cost.g; pl.wood += d.cost.w; }
    else { const c = UPGRADES[it.up].cost[it.lvl]; pl.gold += c.g; pl.wood += c.w; pl.upq[it.up] = 0; }
    if (!b.queue.length) b.qt = 0;
  }

  // ---------- main step ----------
  step(cmds0, cmds1) {
    if (cmds0) for (const c of cmds0) this.apply(0, c);
    if (cmds1) for (const c of cmds1) this.apply(1, c);
    for (const e of this.ents) { e.px = e.x; e.pz = e.z; }
    if (this.winner < 0) {
      const n = this.ents.length;
      for (let k = 0; k < n; k++) { const e = this.ents[k]; if (!e.dead && e.cls === 'u') this.updUnit(e); }
      this.separate();
      for (let k = 0; k < n; k++) { const e = this.ents[k]; if (!e.dead && e.cls === 'b') this.updBuilding(e); }
      this.updProjectiles();
      this.ents = this.ents.filter((e) => !e.dead);
      this.economy();
      if (this.tick % 10 === 0) this.checkEnd();
    }
    this.tick++;
  }
  economy() {
    for (const pl of this.players) { pl.food = 0; pl.cap = 0; }
    for (const e of this.ents) {
      const pl = this.players[e.owner];
      if (!pl) continue;
      if (e.cls === 'u') pl.food += UNITS[e.type].food;
      else if (e.cls === 'b') {
        if (e.done) pl.cap += BUILDINGS[e.type].food || 0;
        for (const it of e.queue) if (it.u) pl.food += UNITS[it.u].food;
      }
    }
    for (const pl of this.players) if (pl.cap > FOOD_MAX) pl.cap = FOOD_MAX;
  }
  checkEnd() {
    const has = [false, false];
    for (const e of this.ents) if (e.cls === 'b' && !e.dead) has[e.owner] = true;
    if (!has[0] && !has[1]) this.finish(2);
    else if (!has[0]) this.finish(1);
    else if (!has[1]) this.finish(0);
  }
  finish(w) {
    if (this.winner >= 0) return;
    this.winner = w;
    this.events.push({ e: 'end', w });
  }

  // ---------- movement ----------
  plan(u, x0, z0, x1, z1, range, exact) {
    u.goal = [x0, z0, x1, z1, range, exact ? 1 : 0];
    u.stuck = 0;
    u.sx = u.x; u.sz = u.z;
    const res = this.pf.find(u.x, u.z, x0, z0, x1, z1, range);
    if (!res) { u.path = null; return; }
    const pts = [];
    const tl = res.tiles;
    for (let k = 1; k < tl.length; k++) pts.push((tl[k] % N) + 0.5, ((tl[k] / N) | 0) + 0.5);
    if (res.reached) {
      // final point: the exact target for moves, else the closest point of the target rect
      let fx, fz;
      if (exact) { fx = x0; fz = z0; } else {
        const lx = pts.length ? pts[pts.length - 2] : u.x, lz = pts.length ? pts[pts.length - 1] : u.z;
        fx = clampN(lx, x0, x1); fz = clampN(lz, z0, z1);
      }
      if (exact && this.freeXZ(fx, fz)) {
        if (pts.length) { pts[pts.length - 2] = fx; pts[pts.length - 1] = fz; } else pts.push(fx, fz);
      } else if (!exact) pts.push(fx, fz);
      else if (!pts.length) pts.push(fx, fz);
    }
    // string pulling: skip waypoints that are in straight view
    const out = [];
    let ax = u.x, az = u.z, i = 0;
    const n = pts.length / 2;
    while (i < n) {
      let j = i;
      while (j + 1 < n && this.walkable(ax, az, pts[(j + 1) * 2], pts[(j + 1) * 2 + 1], u.r)) j++;
      out.push(pts[j * 2], pts[j * 2 + 1]);
      ax = pts[j * 2]; az = pts[j * 2 + 1];
      i = j + 1;
    }
    u.path = out.length ? out : null;
    u.pi = 0;
  }
  walkable(ax, az, bx, bz, r) {
    const dx = bx - ax, dz = bz - az, len = Math.sqrt(dx * dx + dz * dz);
    const steps = Math.ceil(len / 0.25);
    const rr = r * 0.9;
    for (let k = 1; k <= steps; k++) {
      const x = ax + (dx * k) / steps, z = az + (dz * k) / steps;
      if (!this.freeXZ(x - rr, z - rr) || !this.freeXZ(x + rr, z - rr) || !this.freeXZ(x - rr, z + rr) || !this.freeXZ(x + rr, z + rr)) return false;
    }
    return true;
  }
  lineFree(ax, az, bx, bz) {
    const dx = bx - ax, dz = bz - az, len = Math.sqrt(dx * dx + dz * dz);
    const steps = Math.ceil(len / 0.35);
    for (let k = 1; k < steps; k++) if (!this.freeXZ(ax + (dx * k) / steps, az + (dz * k) / steps)) return false;
    return true;
  }
  // one tick along the path; true when the path is finished
  follow(u, d) {
    if (!u.path) return true;
    let step = d.speed * TICK;
    while (step > 1e-6 && u.path) {
      const tx = u.path[u.pi * 2], tz = u.path[u.pi * 2 + 1];
      const dx = tx - u.x, dz = tz - u.z, dist = Math.sqrt(dx * dx + dz * dz);
      if (dist <= step) {
        u.x = tx; u.z = tz; step -= dist;
        u.pi++;
        if (u.pi * 2 >= u.path.length) u.path = null;
      } else {
        u.x += (dx / dist) * step; u.z += (dz / dist) * step;
        step = 0;
      }
    }
    // stuck check every second
    if (++u.stuck >= 10) {
      const mx = u.x - u.sx, mz = u.z - u.sz;
      u.stuck = 0; u.sx = u.x; u.sz = u.z;
      if (u.path && mx * mx + mz * mz < 0.09) {
        u.fails++;
        if (u.fails > 4) { u.path = null; return true; }
        const g = u.goal;
        this.plan(u, g[0], g[1], g[2], g[3], g[4], g[5] === 1);
      }
    }
    return !u.path;
  }
  // walk until within `range` of the rect. 1 = there, 0 = walking, -1 = can't get there
  approach(u, d, x0, z0, x1, z1, range, key) {
    const dist = distRect(u.x, u.z, x0, z0, x1, z1) - u.r;
    if (dist <= range) { u.path = null; return 1; }
    if (u.gk !== key) {
      u.gk = key; u.fails = 0;
      this.plan(u, x0, z0, x1, z1, range + u.r, false);
    } else if (!u.path) {
      if (dist <= range + 0.6) return 1;
      if (++u.fails > 3) return -1;
      this.plan(u, x0, z0, x1, z1, range + u.r, false);
    }
    if (!u.path) return dist <= range + 0.6 ? 1 : 0;
    this.follow(u, d);
    return 0;
  }
  stepToward(u, d, x, z) {
    const dx = x - u.x, dz = z - u.z, dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < 1e-6) return;
    const s = Math.min(dist, d.speed * TICK);
    u.x += (dx / dist) * s; u.z += (dz / dist) * s;
  }

  // ---------- units ----------
  updUnit(u) {
    const d = UNITS[u.type];
    if (u.cd > 0) u.cd--;
    u.still = false;
    const o = u.ord;
    switch (o.t) {
      case 'idle':
        if (!d.worker && (this.tick + u.id) % 4 === 0) {
          const t = this.findTarget(u, d.sight);
          if (t) u.ord = { t: 'attack', id: t.id, auto: true, ax: null, az: null };
        }
        break;
      case 'hold': {
        let t = this.get(u.tgt);
        if (!t || t.owner === u.owner || t.hidden || edgeDist(u, t) > d.range) {
          t = (this.tick + u.id) % 2 === 0 ? this.findTarget(u, d.range) : null;
          u.tgt = t ? t.id : 0;
        }
        u.still = true;
        if (t && u.cd <= 0) this.attack(u, d, t);
        break;
      }
      case 'move':
        if (this.follow(u, d)) this.setIdle(u);
        break;
      case 'amove':
        if ((this.tick + u.id) % 3 === 0) {
          const t = this.findTarget(u, d.sight);
          if (t) { u.ord = { t: 'attack', id: t.id, auto: true, ax: o.x, az: o.z }; u.gk = ''; break; }
        }
        if (this.follow(u, d)) this.setIdle(u);
        break;
      case 'attack': this.attackOrd(u, d, o); break;
      case 'gather': this.gatherOrd(u, d, o); break;
      case 'build': this.buildOrd(u, d, o); break;
      case 'help': this.helpOrd(u, d, o); break;
    }
  }
  findTarget(u, range) {
    let best = null, bs = 1e9;
    for (const e of this.ents) {
      if (e.dead || e.owner === u.owner || e.owner < 0 || e.hidden) continue;
      const dist = edgeDist(u, e);
      if (dist > range) continue;
      let s = dist;
      if (e.cls === 'b') s += BUILDINGS[e.type].attack ? 2 : 6;
      else if (UNITS[e.type].worker) s += 2.5;
      if (s < bs) { bs = s; best = e; }
    }
    return best;
  }
  attackOrd(u, d, o) {
    const t = this.get(o.id);
    const endAtk = () => {
      if (o.ax != null) { u.ord = { t: 'amove', x: o.ax, z: o.az }; this.plan(u, o.ax, o.az, o.ax, o.az, 0, true); u.gk = 'am'; }
      else this.setIdle(u);
    };
    if (!t || t.hidden || t.owner === u.owner) { endAtk(); return; }
    // auto-acquired targets: switch to something closer now and then, give up if they run away
    if (o.auto) {
      if ((this.tick + u.id) % 10 === 0) {
        const better = this.findTarget(u, d.range > 1 ? d.range : 1.5);
        if (better && better.id !== t.id && edgeDist(u, better) + 1 < edgeDist(u, t)) { o.id = better.id; u.gk = ''; return; }
      }
      const hx = o.ax != null ? u.x : u.hx, hz = o.ax != null ? u.z : u.hz;
      const lx = t.x - hx, lz = t.z - hz;
      if (o.ax == null && lx * lx + lz * lz > (d.sight + 4) * (d.sight + 4)) { endAtk(); return; }
    }
    const dist = edgeDist(u, t);
    u.tgt = t.id;
    if (dist <= d.range) {
      u.path = null; u.still = true;
      if (u.cd <= 0) this.attack(u, d, t);
      return;
    }
    if (t.cls === 'b') { if (this.approach(u, d, t.tx, t.tz, t.tx + t.size, t.tz + t.size, d.range, 'at' + t.id) < 0) endAtk(); return; }
    // moving target: straight chase when close and clear, else path (refreshed every second)
    if (dist < 4 && this.lineFree(u.x, u.z, t.x, t.z)) { u.path = null; u.gk = ''; this.stepToward(u, d, t.x, t.z); return; }
    if (u.gk !== 'au' + t.id || !u.path || (this.tick + u.id) % 10 === 0) {
      u.gk = 'au' + t.id;
      this.plan(u, t.x, t.z, t.x, t.z, d.range + u.r + t.r, false);
    }
    if (u.path) this.follow(u, d); else this.stepToward(u, d, t.x, t.z);
  }
  dmgOf(u, d) { return d.dmg + (isMilitary(d) ? this.players[u.owner].up.w * 2 : 0); }
  attack(u, d, t) {
    u.cd = Math.round(d.cd / TICK);
    u.atkT = this.tick;
    u.tgt = t.id;
    const dmg = this.dmgOf(u, d);
    this.events.push({ e: 'atk', id: u.id, k: d.atk, t: t.id });
    if (d.atk === 'melee') { this.damage(t, dmg, u.id, u.owner, 1); return; }
    if (d.atk === 'zap') { this.zap(u, t, dmg, d.chain || 0); return; }
    this.shoot(d.atk, u, t, dmg, d.splash || 0, d.bld || 1);
  }
  shoot(kind, src, t, dmg, splash, bld) {
    const homing = kind === 'arrow' || kind === 'axe' || kind === 'bolt' || kind === 'spear';
    const speed = kind === 'bolt' ? 15 : kind === 'rock' ? 7.5 : kind === 'fire' ? 9 : 12;
    const sx = src.x, sz = src.z;
    const dx = t.x - sx, dz = t.z - sz;
    this.projs.push({
      id: this.pid++, kind, owner: src.owner, src: src.id, tgt: t.id, x: sx, z: sz, px: sx, pz: sz, sx, sz,
      tx: t.x, tz: t.z, speed, dmg, splash, bld, homing, d0: Math.sqrt(dx * dx + dz * dz) + 0.01, fromB: src.cls === 'b',
    });
  }
  zap(u, t, dmg, jumps) {
    const pts = [u.x, u.z, t.x, t.z];
    const hit = [t.id];
    let cur = t, k = dmg;
    this.damage(t, k, u.id, u.owner, 1);
    for (let j = 0; j < jumps; j++) {
      let nb = null, bd = 2.5 * 2.5;
      for (const e of this.ents) {
        if (e.dead || e.cls !== 'u' || e.owner === u.owner || e.hidden || hit.indexOf(e.id) >= 0) continue;
        const dx = e.x - cur.x, dz = e.z - cur.z, dd = dx * dx + dz * dz;
        if (dd < bd) { bd = dd; nb = e; }
      }
      if (!nb) break;
      k = Math.round(k * 0.7);
      hit.push(nb.id);
      pts.push(nb.x, nb.z);
      this.damage(nb, k, u.id, u.owner, 1);
      cur = nb;
    }
    this.events.push({ e: 'zap', pts });
  }
  updProjectiles() {
    const keep = [];
    for (const p of this.projs) {
      p.px = p.x; p.pz = p.z;
      if (p.homing) {
        const t = this.get(p.tgt);
        if (t) { p.tx = t.x; p.tz = t.z; }
      }
      const dx = p.tx - p.x, dz = p.tz - p.z, dist = Math.sqrt(dx * dx + dz * dz), step = p.speed * TICK;
      if (dist > step) { p.x += (dx / dist) * step; p.z += (dz / dist) * step; keep.push(p); continue; }
      p.x = p.tx; p.z = p.tz;
      p.done = true;
      if (p.homing) {
        const t = this.get(p.tgt);
        if (t) this.damage(t, p.dmg, p.src, p.owner, p.bld);
      } else this.splash(p);
      this.events.push({ e: 'impact', k: p.kind, x: p.x, z: p.z });
    }
    this.projs = keep;
  }
  splash(p) {
    const R = p.splash;
    for (const e of this.ents) {
      if (e.dead || e.owner === p.owner || e.owner < 0 || e.hidden) continue;
      let dist;
      if (e.cls === 'u') { const dx = e.x - p.x, dz = e.z - p.z; dist = Math.sqrt(dx * dx + dz * dz) - e.r; }
      else dist = distRect(p.x, p.z, e.tx, e.tz, e.tx + e.size, e.tz + e.size);
      if (dist > R) continue;
      this.damage(e, dist <= R * 0.5 ? p.dmg : Math.round(p.dmg * 0.5), p.src, p.owner, p.bld);
    }
  }
  armorOf(t) {
    if (t.cls === 'b') return BUILDINGS[t.type].armor;
    const d = UNITS[t.type];
    return d.armor + (isMilitary(d) ? this.players[t.owner].up.a : 0);
  }
  damage(t, raw, srcId, srcOwner, bldMul) {
    if (t.dead || t.cls === 'm') return;
    const base = t.cls === 'b' ? raw * bldMul : raw;
    const dmg = Math.max(1, Math.round(base - this.armorOf(t)));
    t.hp -= dmg;
    this.events.push({ e: 'hit', id: t.id });
    const pl = this.players[t.owner];
    if (this.tick - pl.alertT > 150) { pl.alertT = this.tick; this.events.push({ e: 'alert', p: t.owner, x: t.x, z: t.z }); }
    if (t.hp <= 0) { this.kill(t, srcOwner, false); return; }
    // fight back, and call idle friends nearby
    const src = this.get(srcId);
    if (!src || src.owner === t.owner) return;
    if (t.cls === 'u' && t.ord.t === 'idle') t.ord = { t: 'attack', id: src.id, auto: true, ax: null, az: null };
    for (const e of this.ents) {
      if (e.dead || e.cls !== 'u' || e.owner !== t.owner || e.ord.t !== 'idle' || UNITS[e.type].worker) continue;
      const dx = e.x - t.x, dz = e.z - t.z;
      if (dx * dx + dz * dz < 49) e.ord = { t: 'attack', id: src.id, auto: true, ax: null, az: null };
    }
  }
  kill(t, killer, silent) {
    if (t.dead) return;
    t.dead = true;
    const pl = this.players[t.owner];
    if (t.cls === 'u') {
      if (t.inMine) { const m = this.get(t.inMine); if (m) m.inside--; }
      if (!silent) { pl.st.lost++; if (killer >= 0 && this.players[killer]) this.players[killer].st.kills++; }
    } else if (t.cls === 'b') {
      this.stamp(t, false);
      for (const it of t.queue) if (it.up) pl.upq[it.up] = 0;
      if (!silent) { pl.st.bLost++; if (killer >= 0 && this.players[killer]) this.players[killer].st.razed++; }
    } else if (t.cls === 'm') {
      this.stamp(t, false);
      for (const u of this.ents) if (!u.dead && u.inMine === t.id) { this.popOut(u, t); u.ord.s = 'go'; }
    }
    this.events.push({ e: 'die', id: t.id, cls: t.cls, type: t.type, owner: t.owner, x: t.x, z: t.z, silent });
  }

  // ---------- economy ----------
  gatherOrd(u, d, o) {
    if (o.s === 'go' && u.carry && u.cres !== o.res) o.s = 'back';
    if (o.s === 'back') {
      if (!u.carry) { o.s = 'go'; return; }
      const drop = this.nearestDrop(u);
      if (!drop) { this.setIdle(u); return; }
      const r = this.approach(u, d, drop.tx, drop.tz, drop.tx + drop.size, drop.tz + drop.size, 0.35, 'dr' + drop.id);
      if (r < 0) { this.setIdle(u); return; }
      if (r === 0) return;
      const pl = this.players[u.owner];
      const amt = Math.round(u.carry * pl.mul);
      if (u.cres === 'g') { pl.gold += amt; pl.st.gold += amt; } else { pl.wood += amt; pl.st.wood += amt; }
      this.events.push({ e: 'drop', id: u.id, res: u.cres, p: u.owner });
      u.carry = 0; u.cres = '';
      if (o.once) { this.setIdle(u); return; }
      o.s = 'go';
      return;
    }
    if (o.res === 'g') {
      let m = this.get(o.mine);
      if (o.s === 'work') {
        if (--u.workT > 0) return;
        u.inMine = 0;
        u.hidden = false;
        if (m) {
          m.inside--;
          const amt = Math.min(CARRY, m.gold);
          m.gold -= amt;
          u.carry = amt; u.cres = 'g';
          this.popOut(u, m);
          if (m.gold <= 0) this.kill(m, -1, false);
        }
        o.s = 'back';
        u.gk = '';
        return;
      }
      if (!m || m.gold <= 0) {
        m = this.nearestMine(u.x, u.z, 24);
        if (!m) { this.setIdle(u); return; }
        o.mine = m.id;
      }
      const r = this.approach(u, d, m.tx, m.tz, m.tx + 3, m.tz + 3, 0.35, 'gm' + m.id);
      if (r < 0) { this.setIdle(u); return; }
      if (r === 1) {
        u.inMine = m.id; u.hidden = true; m.inside++;
        u.workT = Math.round(MINE_TIME / TICK);
        o.s = 'work';
        u.path = null;
      }
      return;
    }
    // lumber
    if (this.block[o.tree] !== TREE) {
      const t = this.nearestTree(o.tree >= 0 ? (o.tree % N) + 0.5 : u.x, o.tree >= 0 ? ((o.tree / N) | 0) + 0.5 : u.z, 10);
      if (t < 0) { this.setIdle(u); return; }
      o.tree = t; o.s = 'go'; u.gk = '';
    }
    const tx = o.tree % N, tz = (o.tree / N) | 0;
    if (o.s === 'work') {
      u.still = true;
      u.tgt = -1 - o.tree;
      if (--u.workT > 0) { if (u.workT % 8 === 0) this.events.push({ e: 'chop', id: u.id }); return; }
      const left = this.wood[o.tree] - CARRY;
      if (left <= 0) {
        this.wood[o.tree] = 0; this.block[o.tree] = FREE;
        this.events.push({ e: 'tree', i: o.tree });
      } else this.wood[o.tree] = left;
      u.carry = CARRY; u.cres = 'w';
      u.tgt = 0;
      o.s = 'back';
      u.gk = '';
      return;
    }
    const r = this.approach(u, d, tx, tz, tx + 1, tz + 1, 0.3, 'gt' + o.tree);
    if (r < 0) {
      // try another tree once before giving up
      const t = this.nearestTree(u.x, u.z, 6);
      if (t < 0 || t === o.tree) { this.setIdle(u); return; }
      o.tree = t; u.gk = '';
      return;
    }
    if (r === 1) { o.s = 'work'; u.workT = Math.round(CHOP_TIME / TICK); }
  }
  buildOrd(u, d, o) {
    const bd = BUILDINGS[o.type];
    const r = this.approach(u, d, o.tx, o.tz, o.tx + bd.size, o.tz + bd.size, 0.45, 'bd' + o.tx + ',' + o.tz);
    if (r < 0) { this.msg(u.owner, 'Az építési helyet nem lehet megközelíteni.'); this.setIdle(u); return; }
    if (r === 0) return;
    const p = u.owner, pl = this.players[p];
    if (!this.reqMet(p, bd)) { this.msg(p, `Ehhez előbb kell: ${BUILDINGS[bd.req].name}.`); this.setIdle(u); return; }
    if (!this.canPlace(p, o.type, o.tx, o.tz)) { this.msg(p, 'Ide nem lehet építeni.'); this.setIdle(u); return; }
    if (pl.gold < bd.cost.g) { this.msg(p, 'Nincs elég arany.'); this.setIdle(u); return; }
    if (pl.wood < bd.cost.w) { this.msg(p, 'Nincs elég fa.'); this.setIdle(u); return; }
    pl.gold -= bd.cost.g; pl.wood -= bd.cost.w;
    const b = this.makeBuilding(p, o.type, o.tx, o.tz, false);
    this.events.push({ e: 'place', id: b.id, p });
    u.ord = { t: 'help', id: b.id };
    u.gk = '';
  }
  helpOrd(u, d, o) {
    const b = this.get(o.id);
    if (!b || b.done) { this.setIdle(u); return; }
    const r = this.approach(u, d, b.tx, b.tz, b.tx + b.size, b.tz + b.size, 0.45, 'hb' + b.id);
    if (r < 0) { this.setIdle(u); return; }
    if (r === 1) { u.still = true; u.tgt = b.id; b.bt++; if ((this.tick + u.id) % 7 === 0) this.events.push({ e: 'hammer', id: u.id }); }
  }

  // ---------- buildings ----------
  updBuilding(b) {
    const d = BUILDINGS[b.type];
    if (!b.done) {
      const n = Math.min(b.bt, BUILD_RATE.length - 1);
      b.bt = 0;
      if (!n) return;
      const dp = (TICK / d.time) * BUILD_RATE[n];
      const before = b.prog;
      b.prog = Math.min(1, b.prog + dp);
      b.hp = Math.min(d.hp, b.hp + d.hp * 0.9 * (b.prog - before));
      if (b.prog >= 1) {
        b.done = true;
        b.hp = Math.min(d.hp, Math.round(b.hp + 1));
        this.players[b.owner].st.built++;
        this.events.push({ e: 'built', id: b.id, p: b.owner });
      }
      return;
    }
    if (d.attack) {
      if (b.cd > 0) b.cd--;
      let t = this.get(b.tgt);
      const inR = (e) => distRect(e.x, e.z, b.tx, b.tz, b.tx + b.size, b.tz + b.size) - (e.cls === 'u' ? e.r : 0) <= d.attack.range;
      if (!t || t.hidden || !inR(t)) {
        t = null;
        if ((this.tick + b.id) % 3 === 0) {
          let bd = 1e9;
          for (const e of this.ents) {
            if (e.dead || e.cls !== 'u' || e.owner === b.owner || e.hidden) continue;
            const dist = distRect(e.x, e.z, b.tx, b.tz, b.tx + b.size, b.tz + b.size) - e.r;
            if (dist <= d.attack.range && dist < bd) { bd = dist; t = e; }
          }
        }
        b.tgt = t ? t.id : 0;
      }
      if (t && b.cd <= 0) {
        b.cd = Math.round(d.attack.cd / TICK);
        b.atkT = this.tick;
        this.events.push({ e: 'atk', id: b.id, k: d.attack.atk, t: t.id });
        this.shoot(d.attack.atk, b, t, d.attack.dmg, 0, 1);
      }
    }
    if (b.queue.length) {
      const it = b.queue[0];
      const time = it.u ? UNITS[it.u].time : UPGRADES[it.up].time[it.lvl];
      b.qt++;
      if (b.qt >= Math.round(time / TICK)) {
        b.queue.shift();
        b.qt = 0;
        const pl = this.players[b.owner];
        if (it.u) this.spawnFrom(b, it.u);
        else { pl.up[it.up] = it.lvl + 1; pl.upq[it.up] = 0; this.events.push({ e: 'research', p: b.owner, key: it.up, lvl: it.lvl + 1 }); }
      }
    }
  }
  spawnFrom(b, type) {
    const rp = b.rally;
    const ax = rp ? rp.x : N / 2, az = rp ? rp.z : N / 2;
    const t = this.spawnSpot(b, ax, az);
    if (t < 0) return;
    const u = this.makeUnit(b.owner, type, (t % N) + 0.5, ((t / N) | 0) + 0.5);
    this.players[b.owner].st.trained++;
    this.events.push({ e: 'trained', id: u.id, p: b.owner });
    if (!rp) return;
    const d = UNITS[type];
    const tgt = rp.id ? this.get(rp.id) : null;
    if (d.worker && tgt && tgt.cls === 'm') u.ord = { t: 'gather', res: 'g', mine: tgt.id, tree: -1, s: 'go' };
    else if (d.worker && rp.tree >= 0 && this.block[rp.tree] === TREE) u.ord = { t: 'gather', res: 'w', mine: 0, tree: rp.tree, s: 'go' };
    else if (d.worker && tgt && tgt.cls === 'b' && tgt.owner === b.owner && !tgt.done) u.ord = { t: 'help', id: tgt.id };
    else if (tgt && tgt.cls !== 'm' && tgt.owner !== b.owner && tgt.owner >= 0) u.ord = { t: 'attack', id: tgt.id, auto: false, ax: null, az: null };
    else this.moveTo(u, rp.x, rp.z);
  }

  // ---------- unit separation ----------
  separate() {
    const units = [];
    for (const e of this.ents) if (!e.dead && e.cls === 'u' && !e.hidden) units.push(e);
    const C = 48, head = this.cellHead;
    if (this.cellNext.length < units.length) this.cellNext = new Int32Array(units.length * 2);
    const next = this.cellNext;
    head.fill(-1);
    const cellOf = (u) => clampN(Math.floor(u.z / 2), 0, C - 1) * C + clampN(Math.floor(u.x / 2), 0, C - 1);
    for (let i = 0; i < units.length; i++) { const c = cellOf(units[i]); next[i] = head[c]; head[c] = i; }
    const weight = (u) => (u.ord.t === 'hold' ? 0.05 : u.still ? 0.25 : u.path ? 0.45 : 1);
    for (let i = 0; i < units.length; i++) {
      const a = units[i];
      const cx = clampN(Math.floor(a.x / 2), 0, C - 1), cz = clampN(Math.floor(a.z / 2), 0, C - 1);
      const ga = a.ord.t === 'gather';
      for (let z = cz - 1; z <= cz + 1; z++) {
        if (z < 0 || z >= C) continue;
        for (let x = cx - 1; x <= cx + 1; x++) {
          if (x < 0 || x >= C) continue;
          for (let j = head[z * C + x]; j >= 0; j = next[j]) {
            if (j <= i) continue;
            const b = units[j];
            if (ga && b.ord.t === 'gather') continue;   // workers walk through each other
            let dx = b.x - a.x, dz = b.z - a.z;
            const rr = a.r + b.r, d2 = dx * dx + dz * dz;
            if (d2 >= rr * rr) continue;
            let dist = Math.sqrt(d2);
            if (dist < 1e-4) { const pd = PUSH[(a.id * 7 + b.id) % 8]; dx = pd[0]; dz = pd[1]; dist = 1; }
            const wa = weight(a), wb = weight(b), ws = wa + wb;
            const ov = ((rr - (d2 < 1e-8 ? 0 : Math.sqrt(d2))) * 0.8) / ws;
            const nx = dx / dist, nz = dz / dist;
            a.x -= nx * ov * wa; a.z -= nz * ov * wa;
            b.x += nx * ov * wb; b.z += nz * ov * wb;
          }
        }
      }
    }
    for (const u of units) this.pushOut(u);
  }
  pushOut(u) {
    const r = u.r;
    u.x = clampN(u.x, r, N - r); u.z = clampN(u.z, r, N - r);
    for (let it = 0; it < 2; it++) {
      const x0 = Math.floor(u.x - r), x1 = Math.floor(u.x + r), z0 = Math.floor(u.z - r), z1 = Math.floor(u.z + r);
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
        if (x < 0 || z < 0 || x >= N || z >= N) continue;
        const i = z * N + x;
        if (this.block[i] === FREE) continue;
        const cx = clampN(u.x, x, x + 1), cz = clampN(u.z, z, z + 1);
        const dx = u.x - cx, dz = u.z - cz, d2 = dx * dx + dz * dz;
        if (d2 >= r * r) continue;
        if (d2 > 1e-10) {
          const dist = Math.sqrt(d2), k = (r - dist) / dist;
          u.x += dx * k; u.z += dz * k;
        } else {
          const t = this.nearestFree(tileIdx(clampN(Math.floor(u.x), 0, N - 1), clampN(Math.floor(u.z), 0, N - 1)), 12);
          if (t >= 0) { u.x = (t % N) + 0.5; u.z = ((t / N) | 0) + 0.5; }
          return;
        }
      }
    }
  }

  // state checksum for desync detection
  hash() {
    let h = this.tick | 0;
    const mix = (v) => { h = Math.imul(h ^ (v | 0), 0x01000193) + 0x9e37 | 0; };
    for (const e of this.ents) { mix(e.id); mix(e.x * 1024); mix(e.z * 1024); mix(e.hp * 16); }
    for (const p of this.players) { mix(p.gold); mix(p.wood); }
    mix(this.projs.length);
    return h >>> 0;
  }
}
