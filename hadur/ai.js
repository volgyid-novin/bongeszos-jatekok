import { UNITS, BUILDINGS, RACES, UPGRADES, MAP } from './data.js';

// Computer opponent for solo games. It reads the simulation directly and returns
// the same commands a human would send. level: 0 easy, 1 normal, 2 hard.
const LEVELS = [
  { period: 20, workers: 10, firstWave: 4200, wave: 8, grow: 3, extraBarracks: false, upgrades: false, tower: false },
  { period: 10, workers: 16, firstWave: 2700, wave: 10, grow: 4, extraBarracks: true, upgrades: true, tower: false },
  { period: 6, workers: 20, firstWave: 2300, wave: 12, grow: 5, extraBarracks: true, upgrades: true, tower: true },
];

export class AI {
  constructor(sim, slot, level) {
    this.sim = sim;
    this.slot = slot;
    this.L = LEVELS[Math.max(0, Math.min(2, level))];
    this.race = RACES[sim.players[slot].race];
    this.waves = 0;
    this.attacking = false;
    this.lastBuild = -999;
  }

  think() {
    const s = this.sim, L = this.L;
    if (s.tick % L.period !== 3 || s.winner >= 0) return [];
    const me = this.slot, pl = s.players[me], race = this.race;
    const cmds = [];
    const workers = [], army = [], blds = [];
    for (const e of s.ents) {
      if (e.dead || e.owner !== me) continue;
      if (e.cls === 'u') (UNITS[e.type].worker ? workers : army).push(e);
      else if (e.cls === 'b') blds.push(e);
    }
    const count = (type, doneOnly) => blds.filter((b) => b.type === type && (!doneOnly || b.done)).length;
    const hq = blds.find((b) => b.type === race.hq && b.done) || blds.find((b) => b.type === race.hq) || blds[0];
    if (!hq) return cmds;
    let gold = pl.gold, wood = pl.wood;
    const afford = (c) => gold >= c.g && wood >= c.w;
    const spend = (c) => { gold -= c.g; wood -= c.w; };

    // --- economy: put idle workers to work, keep ~1/3 on lumber
    let onGold = 0, onWood = 0;
    for (const w of workers) {
      if (w.ord.t === 'gather') { if (w.ord.res === 'g') onGold++; else onWood++; }
    }
    const busy = new Set();
    for (const w of workers) {
      if (w.ord.t !== 'idle') continue;
      if (onWood * 2 < onGold || onGold >= 10) {
        const t = s.nearestTree(hq.x, hq.z, 16);
        if (t >= 0) { cmds.push(['gt', [w.id], t]); onWood++; busy.add(w.id); continue; }
      }
      const m = s.nearestMine(hq.x, hq.z, 26);
      if (m) { cmds.push(['gm', [w.id], m.id]); onGold++; busy.add(w.id); }
    }
    // keep roughly one lumberjack for every two miners, and shift workers when one resource piles up
    const tooMuchWood = wood > gold + 500 && onWood > 2;
    if (!tooMuchWood && onWood * 2 + 1 < onGold && workers.length > 8) {
      const w = workers.find((u) => u.ord.t === 'gather' && u.ord.res === 'g' && !u.carry && !u.hidden && !busy.has(u.id));
      const t = s.nearestTree(hq.x, hq.z, 16);
      if (w && t >= 0) { cmds.push(['gt', [w.id], t]); busy.add(w.id); }
    } else if (tooMuchWood) {
      const w = workers.find((u) => u.ord.t === 'gather' && u.ord.res === 'w' && !u.carry && !busy.has(u.id));
      const m = s.nearestMine(hq.x, hq.z, 26);
      if (w && m) { cmds.push(['gm', [w.id], m.id]); busy.add(w.id); }
    }

    // --- workers
    const qWorkers = hq.queue.filter((q) => q.u).length;
    const wd = UNITS[race.worker];
    if (hq.done && workers.length + qWorkers < L.workers && hq.queue.length < 2 && afford(wd.cost) && pl.food + wd.food <= pl.cap) {
      cmds.push(['t', hq.id, race.worker]); spend(wd.cost);
    }

    // --- buildings
    const building = blds.some((b) => !b.done) || workers.some((w) => w.ord.t === 'build');
    const prod = blds.filter((b) => BUILDINGS[b.type].trains && b.type !== race.hq).length;
    const [hqT, farm, barracks, smith, tower, caster] = race.buildings;
    const want = [];
    const pendingFarms = blds.filter((b) => b.type === farm && !b.done).length + workers.filter((w) => w.ord.t === 'build' && w.ord.type === farm).length;
    if (pl.cap < 100 && pl.cap - pl.food < 3 + prod * 2 && pendingFarms === 0) want.push(farm);
    if (workers.length >= 7 && count(barracks) === 0) want.push(barracks);
    if (count(barracks, true) && count(smith) === 0 && (army.length >= 3 || s.tick > 2400)) want.push(smith);
    if (L.tower && count(barracks, true) && count(tower) === 0 && s.tick > 1800) want.push(tower);
    if (count(smith, true) && count(caster) === 0 && s.tick > 3000) want.push(caster);
    if (L.extraBarracks && count(barracks, true) === 1 && count(barracks) === 1 && s.tick > 3600 && workers.length >= 12) want.push(barracks);
    if (!building || (want[0] === farm && pendingFarms === 0)) {
      for (const type of want) {
        const d = BUILDINGS[type];
        if (!afford(d.cost) || !s.reqMet(me, d)) break;
        const spot = this.findSpot(type, hq);
        const w = this.pickWorker(workers, busy, spot ? spot[0] : hq.x, spot ? spot[1] : hq.z);
        if (!spot || !w) break;
        cmds.push(['b', w.id, type, spot[0], spot[1]]);
        busy.add(w.id);
        spend(d.cost);
        break;
      }
    }

    // --- army production
    for (const b of blds) {
      if (!b.done || b.type === race.hq) continue;
      const bd = BUILDINGS[b.type];
      if (L.upgrades && bd.research && b.queue.length === 0 && army.length >= 6) {
        for (const key of ['w', 'a']) {
          const lvl = pl.up[key];
          if (lvl >= 2 || pl.upq[key]) continue;
          if (afford({ g: UPGRADES[key].cost[lvl].g + 200, w: UPGRADES[key].cost[lvl].w + 100 })) { cmds.push(['u', b.id, key]); spend(UPGRADES[key].cost[lvl]); }
          break;
        }
      }
      if (!bd.trains || b.queue.length >= 2) continue;
      const pick = this.pickUnit(bd, army);
      if (!pick) continue;
      const d = UNITS[pick];
      if (afford(d.cost) && pl.food + d.food <= pl.cap && s.reqMet(me, d)) { cmds.push(['t', b.id, pick]); spend(d.cost); pl.food += 0; }
    }

    // --- army control
    let armyFood = 0;
    for (const u of army) armyFood += UNITS[u.type].food;
    const threat = this.threat(blds);
    const ids = army.map((u) => u.id);
    if (threat && ids.length) {
      const idle = army.filter((u) => u.ord.t !== 'attack').map((u) => u.id);
      if (idle.length) cmds.push(['am', idle, threat.x, threat.z]);
      this.attacking = false;
    } else if (!this.attacking && s.tick >= L.firstWave && armyFood >= L.wave + this.waves * L.grow) {
      const tgt = this.enemyTarget();
      if (tgt) { cmds.push(['am', ids, tgt.x, tgt.z]); this.attacking = true; this.waves++; }
    } else if (this.attacking) {
      if (armyFood < 4) this.attacking = false;
      else if (s.tick % 50 < L.period) {
        const tgt = this.enemyTarget();
        const idle = army.filter((u) => u.ord.t === 'idle').map((u) => u.id);
        if (tgt && idle.length) cmds.push(['am', idle, tgt.x, tgt.z]);
      }
    } else {
      // gather the army in front of the base
      const rx = hq.x + (MAP / 2 - hq.x) * 0.18, rz = hq.z + (MAP / 2 - hq.z) * 0.18;
      const stray = army.filter((u) => u.ord.t === 'idle' && (u.x - rx) * (u.x - rx) + (u.z - rz) * (u.z - rz) > 36).map((u) => u.id);
      if (stray.length) cmds.push(['m', stray, rx, rz]);
    }
    return cmds;
  }

  pickUnit(bd, army) {
    const have = {};
    for (const u of army) have[u.type] = (have[u.type] || 0) + 1;
    const opts = bd.trains.filter((t) => this.sim.reqMet(this.slot, UNITS[t]));
    if (!opts.length) return null;
    const d0 = UNITS[opts[0]];
    if (d0.siege) return (have[opts[0]] || 0) * 8 <= army.length ? opts[0] : null;
    if (opts.length === 1) return (have[opts[0]] || 0) < 4 ? opts[0] : null;
    // barracks: melee / ranged / cavalry
    const [melee, ranged, cav] = opts;
    const total = army.length + 1;
    if (cav && (have[cav] || 0) < total * 0.25 && this.sim.tick % 3 === 0) return cav;
    return (have[ranged] || 0) < total * 0.35 ? ranged : melee;
  }

  pickWorker(workers, busy, x, z) {
    let best = null, bd = 1e9;
    for (const w of workers) {
      if (busy.has(w.id) || w.hidden || w.carry || w.ord.t === 'build' || w.ord.t === 'help') continue;
      const d = (w.x - x) * (w.x - x) + (w.z - z) * (w.z - z);
      if (d < bd) { bd = d; best = w; }
    }
    return best;
  }

  // free spot near the HQ, with a 1-tile gap around it and away from the mining line
  findSpot(type, hq) {
    const s = this.sim, d = BUILDINGS[type], sz = d.size;
    const cx = hq.x + (MAP / 2 - hq.x) * 0.06, cz = hq.z + (MAP / 2 - hq.z) * 0.06;
    const mines = s.ents.filter((e) => e.cls === 'm' && !e.dead && Math.abs(e.x - hq.x) + Math.abs(e.z - hq.z) < 16);
    let best = null, bd = 1e9;
    for (let tz = Math.floor(cz) - 14; tz <= Math.floor(cz) + 14; tz++) {
      for (let tx = Math.floor(cx) - 14; tx <= Math.floor(cx) + 14; tx++) {
        const mx = tx + sz / 2 - cx, mz = tz + sz / 2 - cz, dist = mx * mx + mz * mz;
        if (dist >= bd || dist < 9) continue;
        if (!s.canPlace(this.slot, type, tx, tz)) continue;
        let ok = true;
        for (let z = tz - 1; z <= tz + sz && ok; z++) for (let x = tx - 1; x <= tx + sz && ok; x++) {
          if (x < 0 || z < 0 || x >= MAP || z >= MAP) { ok = false; break; }
          if (s.block[z * MAP + x] === 2) ok = false;
        }
        for (const m of mines) {
          const x0 = Math.min(m.tx, hq.tx) - 1, x1 = Math.max(m.tx + 3, hq.tx + hq.size) + 1;
          const z0 = Math.min(m.tz, hq.tz) - 1, z1 = Math.max(m.tz + 3, hq.tz + hq.size) + 1;
          if (tx < x1 && tx + sz > x0 && tz < z1 && tz + sz > z0) ok = false;
        }
        if (ok) { bd = dist; best = [tx, tz]; }
      }
    }
    return best;
  }

  threat(blds) {
    const s = this.sim;
    for (const e of s.ents) {
      if (e.dead || e.cls !== 'u' || e.owner === this.slot || e.owner < 0 || e.hidden) continue;
      for (const b of blds) {
        const dx = e.x - b.x, dz = e.z - b.z;
        if (dx * dx + dz * dz < 13 * 13) return e;
      }
    }
    return null;
  }

  enemyTarget() {
    const s = this.sim;
    let best = null, bd = 1e9;
    const hq = s.ents.find((e) => e.cls === 'b' && e.owner === this.slot && !e.dead);
    const ox = hq ? hq.x : MAP / 2, oz = hq ? hq.z : MAP / 2;
    for (const e of s.ents) {
      if (e.dead || e.cls !== 'b' || e.owner === this.slot) continue;
      const d = (e.x - ox) * (e.x - ox) + (e.z - oz) * (e.z - oz);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }
}
