// The authoritative simulation. It runs on one machine only (solo, or the host of a room); the others get
// snapshots and events (see world.js). Fixed step of TICK seconds. Everything is plain objects in 2D (x, z).

import {
  TICK, START_GOLD, PASSIVE_GOLD, POTION, LANE, XP_RANGE, ASSIST_WINDOW, RECALL_TIME, respawnTime, xpToNext, MAX_LEVEL,
  MINIONS, WAVE, minionGrowth, TOWERS, TOWER_RAMP, TOWER_MINION_DMG, BACKDOOR, NEXUS, BOSS, ITEMS, MAX_CDR,
  HEROES, UNLOCK, val, K, MTYPES, PHYS, MAGIC, TRUE, F,
} from './data.js';
import { sdf, keepInside, nextWaypoint, inPit, brushAt, RELICS, PIT, fountainPos, laneDir } from './map.js';
import { SKILLS, PASSIVES } from './skills.js';

export { K, MTYPES, PHYS, MAGIC, TRUE, F };

const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const ITEM_BY_ID = Object.fromEntries(ITEMS.map((it, i) => [it.id, i]));

export class Sim {
  // cfg: { slots: [{ team, hero (index), name, bot, diff }], mode }
  constructor(cfg) {
    this.cfg = cfg;
    this.time = 0; this.tick = 0; this.nextId = 1;
    this.units = []; this.byId = new Map();
    this.proj = []; this.zones = []; this.timers = []; this.events = [];
    this.heroes = []; this.towers = [[], []]; this.nexus = [null, null]; this.boss = null;
    this.relics = RELICS.map((r) => ({ ...r, cd: 0 }));
    this.kills = [0, 0]; this.firstBlood = false; this.winner = -1;
    this.waveN = 0; this.nextWave = WAVE.first; this.bossT = BOSS.first;
    this.ai = null;   // set by the caller: (sim, hero, dt) => void

    for (let team = 0; team < 2; team++) {
      const s = team === 0 ? -1 : 1;
      LANE.towers.forEach((tx, tier) => {
        const def = TOWERS[tier];
        const t = this.add(this.unit(K.TOWER, team, s * tx, 0, def.r));
        Object.assign(t, { tier, sub: tier, hp: def.hp, maxHp: def.hp, ad: def.ad, range: def.range, period: def.period, armor: def.armor, mr: def.mr, gold: def.gold, stack: 0, lastT: null, force: null, forceT: 0 });
        this.towers[team].push(t);
      });
      const n = this.add(this.unit(K.NEXUS, team, s * LANE.nexusX, 0, NEXUS.r));
      Object.assign(n, { hp: NEXUS.hp, maxHp: NEXUS.hp, armor: NEXUS.armor, mr: NEXUS.mr });
      this.nexus[team] = n;
    }
    cfg.slots.forEach((sl, i) => this.heroes.push(this.makeHero(sl, i)));
  }

  // ---------- entities ----------
  unit(kind, team, x, z, r) {
    return {
      id: this.nextId++, kind, team, sub: 0, x, z, px: x, pz: z, rot: team === 0 ? Math.PI / 2 : -Math.PI / 2, r,
      hp: 1, maxHp: 1, alive: true, armor: 0, mr: 0, ad: 0, ap: 0, as: 1, range: 1, ms: 0, pen: 0,
      buffs: [], shields: [], target: null, atkCd: 0, wind: null, flags: 0, vis: 3, revealT: 0,
      dmgBy: new Map(), lastDmgT: -99, lastHeroHit: null, moving: false,
    };
  }
  add(u) { this.units.push(u); this.byId.set(u.id, u); return u; }
  get(id) { const u = this.byId.get(id); return u && u.alive ? u : null; }

  makeHero(sl, slot) {
    const def = HEROES[sl.hero], sp = fountainPos(sl.team);
    const h = this.add(this.unit(K.HERO, sl.team, sp.x + laneDir(sl.team) * 2.6, sp.z + (slot % 2 ? 1.6 : -1.6), def.stats.r));
    Object.assign(h, {
      sub: sl.hero, def, slot, name: sl.name, bot: !!sl.bot, diff: sl.diff ?? 1,
      level: 1, xp: 0, gold: START_GOLD, goldFrac: 0, items: [null, null, null, null, null, null], potions: 0,
      cds: [0, 0, 0, 0, 0, 0], cmd: null, pending: null, casting: null, dash: null, special: null, recall: 0,
      respawnT: 0, k: 0, d: 0, a: 0, cs: 0, dmgDealt: 0, streak: 0, multiN: 0, multiT: 0,
      p: { a: 0, b: 0, t: 0 }, regen: 0, cdr: 0, ls: 0, thorns: 0, aiState: {},
    });
    this.calcStats(h, true);
    h.hp = h.maxHp;
    return h;
  }

  calcStats(h, init) {
    const s = h.def.stats, L = h.level - 1, old = h.maxHp;
    const st = { hp: s.hp + s.hpG * L, ad: s.ad + s.adG * L, ap: 0, armor: s.armor + s.armorG * L, mr: s.mr + s.mrG * L, as: s.asG * L, ms: s.ms, regen: s.regen + s.regenG * L, cdr: 0, ls: 0, pen: 0, thorns: 0, apMul: 0 };
    let itemHp = 0;
    for (const id of h.items) {
      if (id === null) continue;
      const it = ITEMS[id];
      for (const k in it.st) { st[k] = (st[k] || 0) + it.st[k]; if (k === 'hp') itemHp += it.st[k]; }
    }
    h.maxHp = st.hp; h.ad = st.ad; h.ap = st.ap * (1 + st.apMul); h.armor = st.armor; h.mr = st.mr;
    h.as = s.as * (1 + st.as); h.ms = st.ms; h.regen = st.regen; h.cdr = Math.min(MAX_CDR, st.cdr);
    h.ls = st.ls; h.pen = st.pen; h.thorns = st.thorns; h.range = s.range; h.bonusHp = itemHp;
    if (!init && h.alive) h.hp = Math.min(h.maxHp, h.hp + Math.max(0, h.maxHp - old));
    h.hp = Math.min(h.hp, h.maxHp);
  }
  // numbers for data.val()
  st(h) { return { lvl: h.level || 1, ad: h.ad, ap: h.ap, maxHp: h.maxHp }; }
  sv(h, n) { return val(n, this.st(h)); }

  // ---------- events ----------
  ev(k, d) { d.k = k; this.events.push(d); }
  fx(kind, d) { d.f = kind; this.ev('fx', d); }
  drainEvents() { const e = this.events; this.events = []; return e; }

  later(t, fn) { this.timers.push({ t, fn }); }

  // ---------- buffs ----------
  // k: stun root slow silence air taunt haste dr stealth burn markA markS boss spin momentum pot reveal untarget
  addBuff(u, k, t, v = 0, src = null, extra) {
    if (!u.alive) return null;
    if ((k === 'stun' || k === 'root' || k === 'air' || k === 'taunt' || k === 'silence') && u.kind >= K.TOWER && u.kind !== K.BOSS) return null;
    if (k === 'stun' || k === 'air' || k === 'taunt') { this.interrupt(u); }
    let b = u.buffs.find((x) => x.k === k && x.src === (src ? src.id : 0) && !x.stack);
    if (b) { b.t = Math.max(b.t, t); b.v = Math.max(b.v, v); if (extra) Object.assign(b, extra); return b; }
    b = { k, t, max: t, v, src: src ? src.id : 0, ...(extra || {}) };
    u.buffs.push(b);
    if (k === 'stun' || k === 'air') this.ev('cc', { i: u.id, c: k === 'air' ? 1 : 0, t });
    return b;
  }
  hasBuff(u, k) { for (const b of u.buffs) if (b.k === k) return b; return null; }
  removeBuff(u, k) { u.buffs = u.buffs.filter((b) => b.k !== k); }
  interrupt(u) {
    if (u.kind !== K.HERO) { u.wind = null; return; }
    if (u.recall > 0) { u.recall = 0; this.ev('rc', { i: u.id, s: 0 }); }
    if (u.casting) u.casting = null;
    u.wind = null;
    if (u.special && u.special.fragile) { u.special.end?.(true); u.special = null; }
  }
  cc(u) {
    const c = { stun: false, root: false, silence: false, air: false, taunt: null, slow: 0, haste: 0, dr: 0, stealth: false, asB: 0 };
    for (const b of u.buffs) {
      switch (b.k) {
        case 'stun': c.stun = true; break;
        case 'air': c.air = true; break;
        case 'root': c.root = true; break;
        case 'silence': c.silence = true; break;
        case 'taunt': c.taunt = b.src; break;
        case 'slow': c.slow = Math.max(c.slow, b.v); break;
        case 'haste': c.haste += b.v; break;
        case 'dr': c.dr = Math.max(c.dr, b.v); break;
        case 'stealth': c.stealth = true; break;
        case 'momentum': if (b.n > 0) c.asB += 0.6; break;
        default: break;
      }
    }
    return c;
  }
  shieldOf(u) { let s = 0; for (const x of u.shields) s += x.v; return s; }
  addShield(u, v, t, src, tag) {
    if (!u.alive) return;
    u.shields.push({ v, t, src: src ? src.id : 0, tag });
    this.fx('shield', { i: u.id, tg: tag ? 1 : 0 });
  }
  heal(u, a, src) {
    if (!u.alive || a <= 0) return 0;
    const h0 = u.hp;
    u.hp = Math.min(u.maxHp, u.hp + a);
    return u.hp - h0;
  }
  burn(u, src, dps, dur) {
    if (!u.alive || u.team === src.team) return;
    const b = this.addBuff(u, 'burn', dur, dps, src);
    if (b) { b.dps = dps; b.acc = b.acc || 0; }
  }

  // ---------- damage ----------
  isEnemy(a, b) { return a.team !== b.team; }
  targetable(u) { return u.alive && !this.hasBuff(u, 'untarget') && !(u.special && u.special.untarget); }
  visibleTo(u, team) { return u.team === team || (u.vis & (1 << team)) !== 0; }

  damage(src, tgt, amt, type, o = {}) {
    if (!tgt.alive || amt <= 0) return 0;
    if (!o.force && !this.targetable(tgt)) return 0;
    if (tgt.invuln) return 0;
    if (tgt.kind === K.CLONE) { this.killClone(tgt); return 0; }
    let a = amt;
    if (src) {
      if (src.kind === K.HERO && this.hasBuff(src, 'boss')) a *= 1.2;
      if (src.kind === K.MINION && src.emp) a *= 1.5;
      // minions are the siege engines: they hit structures hard, and harder still later on, so a match always ends
      if (src.kind === K.MINION && (tgt.kind === K.TOWER || tgt.kind === K.NEXUS)) a *= 1.8 * (1 + Math.max(0, this.time - 720) / 240);
      if (src.kind === K.HERO) {
        const m = this.hasBuff(tgt, 'markS');
        if (m) { const owner = this.byId.get(m.src); if (owner && owner.team === src.team) a *= 1.12; }
      }
    }
    if (type !== TRUE) {
      let res = type === PHYS ? tgt.armor : tgt.mr;
      if (type === PHYS && src && src.pen) res -= src.pen;
      a *= res >= 0 ? 100 / (100 + res) : 2 - 100 / (100 - res);
    }
    let dr = 0;
    for (const b of tgt.buffs) if (b.k === 'dr') dr = Math.max(dr, b.v);
    a *= 1 - dr;
    if ((tgt.kind === K.TOWER || tgt.kind === K.NEXUS) && !this.enemyMinionNear(tgt)) a *= 1 - BACKDOOR;
    if (tgt.kind === K.MINION && tgt.emp) a *= 0.7;
    // shields soak first
    let left = a;
    while (left > 0 && tgt.shields.length) {
      const s = tgt.shields[0], take = Math.min(s.v, left);
      s.v -= take; left -= take;
      if (s.v <= 0.01) tgt.shields.shift();
    }
    tgt.hp -= left;
    tgt.lastDmgT = this.time;
    const t = this.time;
    if (src && src.kind === K.HERO) {
      tgt.dmgBy.set(src.id, t);
      if (tgt.kind === K.HERO) src.dmgDealt += a;
    }
    if (src && (src.kind === K.HERO || src.kind === K.BOSS || src.kind === K.TOWER) || tgt.kind === K.HERO || tgt.kind === K.BOSS) {
      this.ev('hit', { i: tgt.id, a: Math.round(a), ty: type, s: src ? src.id : 0, c: o.crit ? 1 : 0 });
    }
    if (tgt.kind === K.HERO) {
      if (tgt.recall > 0) this.interrupt(tgt);
      PASSIVES[tgt.def.id]?.onDamaged?.(this, tgt, a, src);
      if (src && src.kind === K.HERO) {
        tgt.lastHeroHit = { id: src.id, t };
        for (const tw of this.towers[tgt.team]) {
          if (tw.alive && dist(tw, src) <= tw.range + src.r && dist(tw, tgt) <= tw.range + 3) { tw.force = src.id; tw.forceT = 2.5; }
        }
      }
    }
    if (tgt.kind === K.BOSS && src && src.kind === K.HERO) this.bossAggro(tgt, src);
    if (tgt.hp <= 0) this.kill(tgt, src);
    return a;
  }
  enemyMinionNear(s) {
    for (const u of this.units) if (u.kind === K.MINION && u.alive && u.team !== s.team && dist(u, s) < 10) return true;
    return false;
  }

  basicHit(u, tgt, ctx) {
    if (!tgt.alive) return;
    if (u.kind === K.HERO) PASSIVES[u.def.id]?.onBasicHit?.(this, u, tgt, ctx);
    const raw = u.ad * ctx.mult + ctx.bonus;
    const dealt = this.damage(u, tgt, raw, PHYS, { basic: true, crit: ctx.crit });
    if (u.kind === K.HERO) {
      if (u.ls > 0) this.heal(u, dealt * u.ls);
      if (u.items.includes(ITEM_BY_ID.viharij)) {
        u.p.vh = (u.p.vh || 0) + 1;
        if (u.p.vh >= 3) { u.p.vh = 0; this.chainLightning(u, tgt); }
      }
    }
    if (tgt.kind === K.HERO && tgt.thorns > 0 && tgt.alive) this.damage(tgt, u, raw * tgt.thorns, MAGIC);
  }
  chainLightning(u, first) {
    const pts = [first], dmg = 60 + 0.25 * u.ad;
    let cur = first;
    for (let i = 0; i < 2; i++) {
      let best = null, bd = 4;
      for (const e of this.units) {
        if (!e.alive || e.team === u.team || pts.includes(e) || e.kind === K.TOWER || e.kind === K.NEXUS || !this.visibleTo(e, u.team)) continue;
        const d = dist(e, cur);
        if (d < bd) { bd = d; best = e; }
      }
      if (!best) break;
      pts.push(best); cur = best;
    }
    this.fx('chain', { p: pts.map((p) => p.id) });
    for (const p of pts) this.damage(u, p, dmg, MAGIC);
  }

  // ---------- deaths ----------
  kill(u, src) {
    if (!u.alive) return;
    u.alive = false; u.hp = 0;
    u.buffs = []; u.shields = []; u.wind = null; u.target = null;
    const killer = src && src.kind === K.HERO ? src : src && src.kind === K.CLONE ? this.byId.get(src.owner) : null;
    switch (u.kind) {
      case K.MINION: {
        const def = MINIONS[u.mtype];
        let g = 0;
        if (killer && killer.team !== u.team) { g = def.gold; killer.gold += g; killer.cs++; }
        this.shareXp(u, def.xp, u.team);
        this.ev('die', { i: u.id, by: killer ? killer.id : 0, g });
        break;
      }
      case K.HERO: this.heroDeath(u, src); break;
      case K.CLONE: break;
      case K.TOWER: case K.NEXUS: this.structureDeath(u, killer); break;
      case K.BOSS: this.bossDeath(u, killer); break;
      default: break;
    }
  }
  shareXp(dead, xp, deadTeam) {
    const near = this.heroes.filter((h) => h.alive && h.team !== deadTeam && dist(h, dead) <= XP_RANGE);
    for (const h of near) this.giveXp(h, xp / near.length);
  }
  giveXp(h, xp) {
    if (h.level >= MAX_LEVEL) return;
    h.xp += xp;
    while (h.level < MAX_LEVEL && h.xp >= xpToNext(h.level)) {
      h.xp -= xpToNext(h.level);
      h.level++;
      this.calcStats(h);
      h.hp = Math.min(h.maxHp, h.hp + h.def.stats.hpG);
      this.ev('lvl', { i: h.id, l: h.level });
    }
    if (h.level >= MAX_LEVEL) h.xp = 0;
  }
  heroDeath(v, src) {
    const t = this.time;
    v.d++;
    v.respawnT = respawnTime(v.level);
    v.cmd = null; v.pending = null; v.casting = null; v.dash = null; v.recall = 0;
    if (v.special) { v.special.end?.(true); v.special = null; }
    // credit: the last hero that hit within the window
    let killer = src && src.kind === K.HERO && src.team !== v.team ? src : src && src.kind === K.CLONE ? this.byId.get(src.owner) : null;
    if (!killer) {
      let best = -1;
      for (const [id, tt] of v.dmgBy) { const h = this.byId.get(id); if (h && h.team !== v.team && t - tt < ASSIST_WINDOW && tt > best) { best = tt; killer = h; } }
    }
    const assists = [];
    for (const [id, tt] of v.dmgBy) {
      const h = this.byId.get(id);
      if (h && h !== killer && h.kind === K.HERO && h.team !== v.team && t - tt < ASSIST_WINDOW) assists.push(h);
    }
    let bounty = 0, fb = false, multi = 0, shutdown = v.streak >= 3;
    if (killer) {
      bounty = 250 + Math.min(250, Math.max(0, v.streak - 1) * 60);
      if (!this.firstBlood) { this.firstBlood = true; bounty += 100; fb = true; }
      killer.gold += bounty; killer.k++; killer.streak++;
      killer.multiN = t - killer.multiT < 10 ? killer.multiN + 1 : 1;
      killer.multiT = t;
      multi = killer.multiN;
      this.kills[killer.team]++;
      const xp = 100 + 30 * v.level + Math.max(0, v.level - killer.level) * 25;
      const share = [killer, ...assists].filter((h) => h.alive);
      for (const h of share) this.giveXp(h, xp / Math.max(1, share.length) * (h === killer ? 1.2 : 1));
      for (const h of assists) { h.a++; h.gold += Math.round(125 / assists.length); }
    } else this.kills[1 - v.team]++;
    v.streak = 0;
    const recent = new Map(v.dmgBy);
    v.dmgBy.clear();
    const ace = this.heroes.filter((h) => h.team === v.team).every((h) => !h.alive);
    this.ev('kill', { v: v.id, by: killer ? killer.id : src ? src.id : 0, as: assists.map((h) => h.id), fb: fb ? 1 : 0, m: multi, sd: shutdown ? 1 : 0, ace: ace ? 1 : 0, sp: killer ? killer.streak : 0, g: bounty });
    for (const h of this.heroes) if (h.alive && h.team !== v.team) PASSIVES[h.def.id]?.onHeroDeath?.(this, h, v, recent);
  }
  structureDeath(s, killer) {
    const team = 1 - s.team;
    if (s.kind === K.TOWER) {
      for (const h of this.heroes) if (h.team === team) h.gold += s.gold;
      if (killer) killer.gold += 50;
      this.ev('ann', { a: 'tower', tm: s.team, i: s.id, by: killer ? killer.id : 0 });
    } else {
      this.winner = team;
      this.ev('ann', { a: 'nexus', tm: s.team, i: s.id });
      this.ev('end', { w: team });
    }
  }
  bossDeath(b, killer) {
    this.bossT = BOSS.respawn;
    const team = killer ? killer.team : -1;
    if (team >= 0) {
      for (const h of this.heroes) {
        if (h.team !== team) continue;
        h.gold += BOSS.gold;
        if (h.alive) { this.giveXp(h, BOSS.xp); this.addBuff(h, 'boss', BOSS.buffDur, 0.2); }
      }
    }
    this.ev('ann', { a: 'boss', tm: team, by: killer ? killer.id : 0 });
  }
  killClone(c) {
    if (!c.alive) return;
    c.alive = false;
    this.fx('puff', { x: c.x, z: c.z });
  }

  // ---------- commands (local input, network and bots all come through here) ----------
  command(h, c) {
    if (!h || h.kind !== K.HERO || this.winner >= 0) return;
    switch (c.k) {
      case 'mv': {
        if (!h.alive) return;
        this.cancelRecall(h);
        if (h.wind) { h.wind = null; h.atkCd = 0; }
        h.cmd = { type: 'move', x: +c.x || 0, z: +c.z || 0 };
        h.pending = null; h.target = null;
        break;
      }
      case 'at': {
        if (!h.alive) return;
        const t = this.get(c.t);
        if (!t || t.team === h.team || !this.visibleTo(t, h.team) || t.kind === K.CLONE && t.team === h.team) return;
        this.cancelRecall(h);
        h.cmd = { type: 'attack', t: t.id };
        h.pending = null;
        break;
      }
      case 'am': {
        if (!h.alive) return;
        this.cancelRecall(h);
        h.cmd = { type: 'amove', x: +c.x || 0, z: +c.z || 0 };
        h.pending = null; h.target = null;
        break;
      }
      case 'st': {
        h.cmd = null; h.pending = null; h.target = null;
        if (h.wind) { h.wind = null; h.atkCd = 0; }
        break;
      }
      case 'cs': this.tryCast(h, c.s | 0, { x: +c.x || 0, z: +c.z || 0, t: c.t | 0 }); break;
      case 'rc': {
        if (!h.alive || h.recall > 0 || h.dash || h.special || h.casting) return;
        const c2 = this.cc(h);
        if (c2.stun || c2.air) return;
        h.cmd = null; h.pending = null; h.target = null; h.wind = null;
        h.recall = this.hasBuff(h, 'boss') ? RECALL_TIME * 0.6 : RECALL_TIME;
        this.ev('rc', { i: h.id, s: 1, t: h.recall });
        break;
      }
      case 'buy': this.buy(h, c.i); break;
      case 'sell': this.sell(h, c.s | 0); break;
      case 'pot': this.drinkPotion(h); break;
      default: break;
    }
  }
  cancelRecall(h) { if (h.recall > 0) { h.recall = 0; this.ev('rc', { i: h.id, s: 0 }); } }
  inShop(h) { const f = fountainPos(h.team); return !h.alive || dist(h, f) <= LANE.baseR; }
  buy(h, id) {
    if (id === 'pot') {
      if (!this.inShop(h) || h.gold < POTION.cost || h.potions >= POTION.max) return this.fail(h, 'shop');
      h.gold -= POTION.cost; h.potions++;
      this.ev('buy', { i: h.id, it: -1 });
      return;
    }
    const idx = ITEM_BY_ID[id];
    if (idx === undefined) return;
    const it = ITEMS[idx], slot = h.items.indexOf(null);
    if (!this.inShop(h) || h.gold < it.cost || slot < 0 || (it.adv && h.items.includes(idx))) return this.fail(h, 'shop');
    h.gold -= it.cost;
    h.items[slot] = idx;
    this.calcStats(h);
    this.ev('buy', { i: h.id, it: idx });
  }
  sell(h, slot) {
    const idx = h.items[slot];
    if (idx === null || idx === undefined || !this.inShop(h)) return;
    h.items[slot] = null;
    h.gold += Math.floor(ITEMS[idx].cost * 0.6);
    this.calcStats(h);
    this.ev('buy', { i: h.id, it: -2 });
  }
  drinkPotion(h) {
    if (!h.alive || h.potions <= 0 || this.hasBuff(h, 'pot')) return this.fail(h, 'pot');
    h.potions--;
    this.addBuff(h, 'pot', POTION.dur, POTION.heal / POTION.dur);
    this.ev('pot', { i: h.id });
  }
  fail(h, why) { this.ev('no', { i: h.id, w: why }); }

  // ---------- skills ----------
  tryCast(h, slot, aim) {
    if (!h.alive || slot < 0 || slot > 5) return;
    const sk = h.def.skills[slot];
    if (h.level < UNLOCK[slot]) return this.fail(h, 'lvl');
    if (h.cds[slot] > 0.05) return this.fail(h, 'cd');
    const c = this.cc(h);
    if (c.stun || c.air || c.silence || h.dash || (h.special && h.special.block) || c.taunt) return this.fail(h, 'cc');
    if (h.casting) return;
    if (sk.kind === 'unit') {
      const t = this.get(aim.t);
      if (!t || !this.unitTargetOk(h, t, sk.targets)) return this.fail(h, 'target');
      if (dist(h, t) > sk.range + t.r) {
        h.pending = { slot, aim: { ...aim } };
        h.cmd = null;
        this.cancelRecall(h);
        return;
      }
    }
    this.startCast(h, slot, aim);
  }
  unitTargetOk(h, t, targets) {
    if (!t.alive || t.kind === K.TOWER || t.kind === K.NEXUS || !this.visibleTo(t, h.team) || t === h) return false;
    if (t.team !== h.team && !this.targetable(t)) return false;
    if (targets === 'enemy') return t.team !== h.team;
    if (targets === 'hero') return t.team !== h.team && (t.kind === K.HERO || t.kind === K.CLONE);
    if (targets === 'ally') return t.team === h.team;
    return true;
  }
  startCast(h, slot, aim) {
    const sk = h.def.skills[slot];
    this.cancelRecall(h);
    h.pending = null;
    if (h.wind) { h.wind = null; h.atkCd = Math.min(h.atkCd, 0.1); }
    // clamp ground targets to the skill's range
    if (sk.kind === 'circle' || sk.kind === 'blink' || sk.kind === 'wall' || sk.kind === 'dash') {
      const dx = aim.x - h.x, dz = aim.z - h.z, d = Math.hypot(dx, dz);
      if (d > sk.range) { aim.x = h.x + dx / d * sk.range; aim.z = h.z + dz / d * sk.range; }
      if (d < 0.01) { aim.x = h.x + Math.sin(h.rot) * 0.5; aim.z = h.z + Math.cos(h.rot) * 0.5; }
    }
    if (sk.kind !== 'self') this.face(h, aim.x, aim.z);
    h.cds[slot] = sk.cd * (1 - h.cdr);
    h.revealT = Math.max(h.revealT, 1);
    this.ev('cast', { s: h.id, sl: slot, x: +aim.x.toFixed(2), z: +aim.z.toFixed(2), t: aim.t || 0, w: sk.cast });
    if (sk.cast > 0) h.casting = { slot, aim, t: sk.cast };
    else this.execCast(h, slot, aim);
  }
  execCast(h, slot, aim) {
    const pas = PASSIVES[h.def.id];
    const emp = pas?.onCast ? pas.onCast(this, h, slot) : null;
    SKILLS[h.def.id][slot](this, h, aim, emp || { dmg: 1, area: 1 });
    pas?.afterCast?.(this, h, slot);
  }
  face(u, x, z) { if (Math.abs(x - u.x) + Math.abs(z - u.z) > 0.01) u.rot = Math.atan2(x - u.x, z - u.z); }

  // ---------- helpers for skills ----------
  enemiesIn(team, x, z, r, o = {}) {
    const out = [];
    for (const u of this.units) {
      if (!u.alive || u.team === team || (!o.structures && (u.kind === K.TOWER || u.kind === K.NEXUS))) continue;
      if (!o.untargetable && !this.targetable(u)) continue;
      if (o.heroes && u.kind !== K.HERO && u.kind !== K.CLONE) continue;
      if (Math.hypot(u.x - x, u.z - z) <= r + u.r) out.push(u);
    }
    return out;
  }
  alliesIn(team, x, z, r, heroesOnly = true) {
    return this.units.filter((u) => u.alive && u.team === team && (!heroesOnly || u.kind === K.HERO) && Math.hypot(u.x - x, u.z - z) <= r + u.r);
  }
  // a point at most `range` away toward (x, z) that a unit of radius r can stand on
  landing(u, x, z, r = u.r) {
    const p = { x, z };
    if (sdf(p.x, p.z) < -r) return p;
    // walk back along the line to the last walkable point
    const dx = x - u.x, dz = z - u.z, d = Math.hypot(dx, dz);
    for (let s = d; s > 0; s -= 0.25) {
      const qx = u.x + dx / d * s, qz = u.z + dz / d * s;
      if (sdf(qx, qz) < -r) return { x: qx, z: qz };
    }
    return keepInside({ x: u.x, z: u.z }, r);
  }
  // forced movement: a dash (own) or a knockback (enemy). opts: { speed, onStep(u) -> true to stop, onEnd(u), anim }
  dash(u, x, z, speed, opts = {}) {
    const p = this.landing(u, x, z);
    u.dash = { x: p.x, z: p.z, speed, onStep: opts.onStep, onEnd: opts.onEnd, hitSet: new Set() };
    if (u.kind === K.HERO) { u.casting = null; u.wind = null; if (u.recall > 0) this.cancelRecall(u); }
    if (opts.face !== false) this.face(u, p.x, p.z);
    this.ev('dash', { i: u.id, x: +p.x.toFixed(2), z: +p.z.toFixed(2), sp: speed, a: opts.anim || 0 });
  }
  blink(u, x, z) {
    const p = this.landing(u, x, z);
    const fx = u.x, fz = u.z;
    u.x = u.px = p.x; u.z = u.pz = p.z;
    this.ev('blink', { i: u.id, fx: +fx.toFixed(2), fz: +fz.toFixed(2), x: +p.x.toFixed(2), z: +p.z.toFixed(2) });
  }
  // projectiles. o: { kind, src, x, z, dx, dz, speed, range, width, pierce, homing (unit), onHit(u, p) -> true stops, onEnd(p), heroesOnly, y }
  projectile(o) {
    const p = { id: this.nextId++, team: o.src.team, traveled: 0, hit: new Set(), ...o };
    if (p.homing) {
      this.ev('pr', { id: p.id, p: p.kind, s: o.src.id, x: +p.x.toFixed(2), z: +p.z.toFixed(2), t: p.homing.id, sp: p.speed, c: o.crit ? 1 : 0 });
    } else {
      const l = Math.hypot(p.dx, p.dz) || 1;
      p.dx /= l; p.dz /= l;
      this.ev('pr', { id: p.id, p: p.kind, s: o.src.id, x: +p.x.toFixed(2), z: +p.z.toFixed(2), dx: +p.dx.toFixed(3), dz: +p.dz.toFixed(3), sp: p.speed, r: p.range, w: p.width });
    }
    this.proj.push(p);
    return p;
  }
  // zones on the ground. o: { kind, src, x, z, r | (ux, uz, hl, hw), dur, every, onTick(z), onEnd(z), hidden, vis }
  zone(o) {
    const z = { id: this.nextId++, team: o.src ? o.src.team : 2, t: o.dur, acc: 0, ...o };
    this.zones.push(z);
    this.ev('zone', { id: z.id, z: z.kind, x: +z.x.toFixed(2), z2: +z.z.toFixed(2), r: z.r || 0, ux: z.ux || 0, uz: z.uz || 0, hl: z.hl || 0, hw: z.hw || 0, d: z.dur, tm: z.team, s: o.src ? o.src.id : 0, hd: z.hidden ? 1 : 0 });
    return z;
  }
  endZone(z, trig = 0) {
    if (z.dead) return;
    z.dead = true;
    z.onEnd?.(z);
    this.ev('zx', { id: z.id, tr: trig });
  }
  inZone(z, u) {
    if (z.ux !== undefined && z.hl) {
      const dx = u.x - z.x, dz = u.z - z.z, along = dx * z.ux + dz * z.uz, across = -dx * z.uz + dz * z.ux;
      return Math.abs(along) <= z.hl + u.r * 0.5 && Math.abs(across) <= z.hw + u.r * 0.5;
    }
    return Math.hypot(u.x - z.x, u.z - z.z) <= z.r + u.r * 0.5;
  }
  telegraph(src, x, z, r, delay, kind = 'tele') {
    return this.zone({ kind, src, x, z, r, dur: delay });
  }

  // ---------- the tick ----------
  step() {
    if (this.winner >= 0) { this.time += TICK; this.tick++; this.updateTimers(TICK); return; }
    const dt = TICK;
    this.time += dt; this.tick++;
    for (const u of this.units) { u.px = u.x; u.pz = u.z; }
    this.spawns(dt);
    for (const h of this.heroes) {
      if (this.time > 60) { h.goldFrac += PASSIVE_GOLD * dt; if (h.goldFrac >= 1) { const g = Math.floor(h.goldFrac); h.gold += g; h.goldFrac -= g; } }
      this.updateHero(h, dt);
    }
    for (const u of this.units) {
      if (!u.alive) continue;
      if (u.kind === K.MINION) this.updateMinion(u, dt);
      else if (u.kind === K.TOWER) this.updateTower(u, dt);
      else if (u.kind === K.BOSS) this.updateBoss(u, dt);
      else if (u.kind === K.CLONE) this.updateClone(u, dt);
    }
    this.updateProjectiles(dt);
    this.updateZones(dt);
    this.updateTimers(dt);
    this.separate();
    this.updateRelics(dt);
    for (const u of this.units) { u.vx = (u.x - u.px) / dt; u.vz = (u.z - u.pz) / dt; }
    if (this.tick % 3 === 0) this.updateVisibility();
    this.updateFlags();
    // drop dead minions and clones
    if (this.tick % 15 === 0) {
      this.units = this.units.filter((u) => {
        if (u.alive || u.kind === K.HERO || u.kind === K.TOWER || u.kind === K.NEXUS || u.kind === K.BOSS) return true;
        this.byId.delete(u.id);
        return false;
      });
    }
  }

  updateTimers(dt) {
    if (!this.timers.length) return;
    const due = [];
    for (const t of this.timers) { t.t -= dt; if (t.t <= 0) due.push(t); }
    if (!due.length) return;
    this.timers = this.timers.filter((t) => t.t > 0);
    for (const t of due) t.fn();
  }

  spawns(dt) {
    if (this.time >= this.nextWave) {
      this.waveN++;
      this.nextWave += WAVE.every;
      const comp = [...WAVE.comp];
      if (this.waveN % WAVE.siegeEvery === 0) comp.splice(3, 0, 'siege');
      const g = minionGrowth(this.time);
      for (let team = 0; team < 2; team++) {
        comp.forEach((mt, i) => this.later(i * 0.55, () => this.spawnMinion(team, mt, i, comp.length, g)));
      }
    }
    if (!this.boss || !this.boss.alive) {
      this.bossT -= dt;
      if (this.bossT <= 0) this.spawnBoss();
    }
  }
  spawnMinion(team, mtype, i, n, g) {
    if (this.winner >= 0) return;
    const def = MINIONS[mtype], s = team === 0 ? -1 : 1;
    const m = this.add(this.unit(K.MINION, team, s * (LANE.nexusX - 3.5), 0, def.r));
    const lz = ((i % 3) - 1) * 1.2 + (mtype === 'caster' ? 0.4 : 0);
    Object.assign(m, {
      mtype, sub: MTYPES.indexOf(mtype), hp: def.hp * g.hp, maxHp: def.hp * g.hp, ad: def.ad * g.ad, armor: def.armor, mr: def.mr,
      range: def.range, ms: def.ms, period: def.period, laneZ: lz, retarget: 0, emp: false,
    });
    m.z = lz;
  }
  spawnBoss() {
    const b = this.boss && !this.boss.alive ? this.boss : null;
    const mins = this.time / 60;
    const hp = BOSS.hp + BOSS.hpPerMin * mins;
    if (b) { this.byId.delete(b.id); this.units = this.units.filter((u) => u !== b); }
    const nb = this.add(this.unit(K.BOSS, 2, PIT.x, PIT.z - 1.5, BOSS.r));
    Object.assign(nb, { hp, maxHp: hp, ad: BOSS.ad + BOSS.adPerMin * mins, armor: BOSS.armor, mr: BOSS.mr, range: BOSS.range, ms: BOSS.ms, period: BOSS.period, rot: 0, home: { x: PIT.x, z: PIT.z - 1.5 }, aggro: null, slamT: BOSS.slamEvery, slam: null, resetting: false });
    this.boss = nb;
    this.ev('ann', { a: 'bossUp' });
  }

  // ---------- heroes ----------
  updateHero(h, dt) {
    if (!h.alive) {
      h.respawnT -= dt;
      if (h.respawnT <= 0 && this.winner < 0) this.respawn(h);
      return;
    }
    for (let i = 0; i < 6; i++) if (h.cds[i] > 0) h.cds[i] = Math.max(0, h.cds[i] - dt);
    h.revealT = Math.max(0, h.revealT - dt);
    this.tickBuffs(h, dt);
    if (!h.alive) return;
    // regeneration, fountain, potions
    h.hp = Math.min(h.maxHp, h.hp + h.regen * dt);
    const f = fountainPos(h.team);
    if (dist(h, f) < 7) h.hp = Math.min(h.maxHp, h.hp + h.maxHp * 0.12 * dt);
    const ef = fountainPos(1 - h.team);
    if (dist(h, ef) < 9) {
      h.p.fz = (h.p.fz || 0) - dt;
      if (h.p.fz <= 0) { h.p.fz = 0.5; this.fx('zap', { x: ef.x, z: ef.z, i: h.id }); this.damage(null, h, 200, TRUE, { force: true }); if (!h.alive) return; }
    }
    PASSIVES[h.def.id]?.tick?.(this, h, dt);
    if (h.bot && this.ai) this.ai(this, h, dt);

    const c = this.cc(h);
    h.ccNow = c;
    if (h.dash) { this.stepDash(h, dt); return; }
    if (h.special) {
      h.special.update(dt);
      if (h.special && h.special.block) return;
    }
    if (c.stun || c.air) { h.moving = false; return; }
    if (h.recall > 0) {
      h.recall -= dt;
      if (h.recall <= 0) {
        h.recall = 0;
        const sp = fountainPos(h.team);
        h.x = h.px = sp.x + laneDir(h.team) * 2.6; h.z = h.pz = sp.z + (h.slot % 2 ? 1.6 : -1.6);
        this.ev('rc', { i: h.id, s: 2 });
      }
      h.moving = false;
      return;
    }
    if (h.casting) {
      if (c.silence) { h.casting = null; }
      else {
        h.casting.t -= dt;
        this.face(h, h.casting.aim.x, h.casting.aim.z);
        if (h.casting.t <= 0) { const cs = h.casting; h.casting = null; this.execCast(h, cs.slot, cs.aim); }
        h.moving = false;
        return;
      }
    }
    h.atkCd -= dt;
    // a unit-targeted cast waiting until the target is in range
    if (h.pending) {
      const t = this.get(h.pending.aim.t), sk = h.def.skills[h.pending.slot];
      if (!t || !this.unitTargetOk(h, t, sk.targets) || c.silence) h.pending = null;
      else if (dist(h, t) <= sk.range + t.r) { const pd = h.pending; h.pending = null; this.startCast(h, pd.slot, { x: t.x, z: t.z, t: t.id }); return; }
      else { this.moveUnit(h, t.x, t.z, dt, c, 0); return; }
    }
    const noAtk = h.special && h.special.noAttack;
    // taunt overrides orders
    let tgt = null;
    if (c.taunt) {
      const tt = this.get(c.taunt);
      if (tt) tgt = tt;
    } else if (h.cmd && h.cmd.type === 'attack') {
      tgt = this.get(h.cmd.t);
      if (!tgt || !this.visibleTo(tgt, h.team) || !this.targetable(tgt)) { h.cmd = null; tgt = null; }
    } else if (h.cmd && h.cmd.type === 'amove') {
      tgt = this.acquire(h, h.range + 3.5, true);
      if (!tgt && Math.hypot(h.cmd.x - h.x, h.cmd.z - h.z) < 0.3) h.cmd = null;
    } else if (!h.cmd && !h.wind) {
      // idle: keep hitting the last target or anything in range
      const last = h.target ? this.get(h.target) : null;
      tgt = last && this.inRange(h, last) && this.visibleTo(last, h.team) && this.targetable(last) ? last : this.acquire(h, h.range, false);
    }
    if (h.wind) { this.stepWindup(h, dt); h.moving = false; return; }
    if (tgt && !noAtk) {
      h.target = tgt.id;
      if (this.inRange(h, tgt)) {
        h.moving = false;
        this.face(h, tgt.x, tgt.z);
        if (h.atkCd <= 0) this.startAttack(h, tgt, c);
        return;
      }
      if (!c.root) this.moveUnit(h, tgt.x, tgt.z, dt, c, 0);
      return;
    }
    if (h.cmd && (h.cmd.type === 'move' || h.cmd.type === 'amove')) {
      if (c.root) { h.moving = false; return; }
      const done = this.moveUnit(h, h.cmd.x, h.cmd.z, dt, c, 0);
      if (done && h.cmd.type === 'move') h.cmd = null;
      return;
    }
    h.moving = false;
  }
  respawn(h) {
    const sp = fountainPos(h.team);
    h.alive = true; h.hp = h.maxHp; h.x = h.px = sp.x + laneDir(h.team) * 2.6; h.z = h.pz = sp.z + (h.slot % 2 ? 1.6 : -1.6);
    h.buffs = []; h.shields = []; h.cmd = null; h.target = null; h.wind = null; h.atkCd = 0;
    h.rot = h.team === 0 ? Math.PI / 2 : -Math.PI / 2;
    h.p.t = 0;
    this.ev('spawn', { i: h.id });
  }
  inRange(u, t) { return dist(u, t) - t.r <= u.range + 0.05; }
  // nearest attackable enemy within r (center-to-edge); prefer non-heroes when `minionsFirst`
  acquire(u, r, heroesToo) {
    let best = null, bs = Infinity;
    for (const e of this.units) {
      if (!e.alive || e.team === u.team || !this.visibleTo(e, u.team) || !this.targetable(e) || e.invuln) continue;
      // idle heroes never start a fight with the boss on their own
      if (e.kind === K.BOSS && u.kind === K.HERO && !heroesToo) continue;
      const d = dist(u, e) - e.r;
      if (d > r) continue;
      const s = d + (e.kind === K.HERO || e.kind === K.CLONE ? (heroesToo ? -1 : 1.5) : 0);
      if (s < bs) { bs = s; best = e; }
    }
    return best;
  }
  startAttack(u, tgt, c) {
    const def = u.kind === K.HERO ? u.def.attack : MINIONS[u.mtype] || { windup: 0.3 };
    const as = u.kind === K.HERO ? Math.min(2.5, u.as * (1 + (c ? c.asB : 0))) : 1 / u.period;
    const baseAs = u.kind === K.HERO ? u.def.stats.as : as;
    const w = Math.max(0.07, def.windup * Math.min(1, baseAs / as));
    u.wind = { t: w, tgt: tgt.id };
    u.atkCd = 1 / as;
    u.revealT = Math.max(u.revealT, 0.6);
    this.ev('atk', { s: u.id, t: tgt.id, w: +w.toFixed(2) });
    if (u.kind === K.HERO) {
      const m = this.hasBuff(u, 'momentum');
      if (m && m.n > 0) { m.n--; if (m.n <= 0) m.t = 0; }
    }
  }
  stepWindup(u, dt) {
    u.wind.t -= dt;
    const tgt = this.get(u.wind.tgt);
    if (!tgt) { u.wind = null; u.atkCd = 0; return; }
    this.face(u, tgt.x, tgt.z);
    if (u.wind.t > 0) return;
    u.wind = null;
    this.fireAttack(u, tgt);
  }
  fireAttack(u, tgt) {
    const ctx = { crit: false, mult: 1, bonus: 0, pierce: false };
    if (u.kind === K.HERO) PASSIVES[u.def.id]?.onAttack?.(this, u, tgt, ctx);
    let proj = null, speed = 0;
    if (u.kind === K.HERO && u.def.attack.proj) { proj = u.def.attack.proj; speed = u.def.attack.pspeed; }
    else if (u.kind === K.MINION && MINIONS[u.mtype].proj) { proj = MINIONS[u.mtype].proj; speed = MINIONS[u.mtype].pspeed; }
    if (proj) {
      const sx = u.x + Math.sin(u.rot) * u.r, sz = u.z + Math.cos(u.rot) * u.r;
      this.projectile({ kind: proj, src: u, x: sx, z: sz, homing: tgt, speed, crit: ctx.crit, onHit: (t) => { this.unitHit(u, t, ctx); return true; } });
    } else this.unitHit(u, tgt, ctx);
  }
  unitHit(u, tgt, ctx) {
    if (u.kind === K.MINION) {
      if (!tgt.alive) return;
      let a = u.ad;
      this.damage(u, tgt, a, PHYS);
      if (tgt.kind === K.MINION) this.ev('mh', { i: tgt.id });
      return;
    }
    this.basicHit(u, tgt, ctx);
  }

  // move a unit toward (x, z); returns true when it got there
  moveUnit(u, x, z, dt, c, stop) {
    let ms = u.ms;
    if (c) ms *= (1 + c.haste) * (1 - c.slow);
    if (u.kind === K.HERO && u.special && u.special.msMul) ms *= u.special.msMul;
    const wp = u.kind === K.HERO || u.kind === K.BOSS || u.kind === K.CLONE ? nextWaypoint(u.x, u.z, x, z, u.r) : { x, z };
    const dx = wp.x - u.x, dz = wp.z - u.z, d = Math.hypot(dx, dz);
    const final = wp.x === x && wp.z === z;
    if (final && d <= stop + 0.02) { u.moving = false; return true; }
    const step = Math.min(ms * dt, final ? d - stop : d);
    u.x += dx / d * step; u.z += dz / d * step;
    u.rot = Math.atan2(dx, dz);
    keepInside(u, u.r);
    u.moving = true;
    return final && d - step <= stop + 0.02;
  }
  stepDash(u, dt) {
    const d = u.dash, dx = d.x - u.x, dz = d.z - u.z, l = Math.hypot(dx, dz), s = d.speed * dt;
    if (l <= s) { u.x = d.x; u.z = d.z; }
    else { u.x += dx / l * s; u.z += dz / l * s; }
    u.moving = true;
    let stop = l <= s;
    if (d.onStep && d.onStep(u, d)) stop = true;
    if (stop) { u.dash = null; keepInside(u, u.r); d.onEnd?.(u); u.moving = false; }
  }

  tickBuffs(u, dt) {
    if (u.buffs.length) {
      for (const b of u.buffs) {
        b.t -= dt;
        if (b.k === 'burn') {
          b.acc += dt;
          if (b.acc >= 0.5) { b.acc -= 0.5; const src = this.byId.get(b.src); this.damage(src || null, u, b.dps * 0.5, MAGIC, { force: true }); if (!u.alive) return; }
        } else if (b.k === 'pot') {
          this.heal(u, b.v * dt);
        } else if (b.tick) {
          b.acc = (b.acc || 0) + dt;
          while (b.acc >= b.every && b.t > -0.001) { b.acc -= b.every; b.tick(b); if (!u.alive) return; }
        }
      }
      if (u.buffs.some((b) => b.t <= 0)) {
        const gone = u.buffs.filter((b) => b.t <= 0);
        u.buffs = u.buffs.filter((b) => b.t > 0);
        for (const b of gone) b.onEnd?.(b);
      }
    }
    if (u.shields.length) {
      for (const s of u.shields) s.t -= dt;
      u.shields = u.shields.filter((s) => s.t > 0 && s.v > 0.01);
    }
  }

  // ---------- minions ----------
  updateMinion(m, dt) {
    this.tickBuffs(m, dt);
    if (!m.alive) return;
    const c = this.cc(m);
    if (m.dash) { this.stepDash(m, dt); return; }
    if (c.stun || c.air) { m.moving = false; return; }
    m.atkCd -= dt;
    m.retarget -= dt;
    // near a hero with the boss buff?
    m.emp = false;
    for (const h of this.heroes) if (h.alive && h.team === m.team && dist(h, m) < 8 && this.hasBuff(h, 'boss')) { m.emp = true; break; }
    let tgt = c.taunt ? this.get(c.taunt) : m.target ? this.get(m.target) : null;
    if (tgt && (!this.visibleTo(tgt, m.team) || !this.targetable(tgt) || dist(m, tgt) > 9 || inPit(tgt.x, tgt.z))) { tgt = null; m.target = null; }
    if (!c.taunt && (m.retarget <= 0 || !tgt)) {
      m.retarget = 0.4;
      const nt = this.minionTarget(m);
      if (nt && (!tgt || nt.kind === K.HERO && tgt.kind !== K.HERO || !this.inRange(m, tgt))) tgt = nt;
      m.target = tgt ? tgt.id : null;
    }
    if (m.wind) { this.stepWindup(m, dt); m.moving = false; return; }
    if (tgt) {
      if (this.inRange(m, tgt)) {
        m.moving = false;
        this.face(m, tgt.x, tgt.z);
        if (m.atkCd <= 0) this.startAttack(m, tgt, null);
        return;
      }
      if (!c.root) this.moveUnit(m, tgt.x, tgt.z, dt, c, 0);
      return;
    }
    if (c.root) { m.moving = false; return; }
    const dir = laneDir(m.team);
    const tx = m.x + dir * 4, hw = 5.2;
    this.moveUnit(m, tx, clamp(m.laneZ, -hw, hw), dt, c, 0);
  }
  minionTarget(m) {
    // call for help: an enemy hero that just hit an allied hero nearby
    for (const h of this.heroes) {
      if (!h.alive || h.team !== m.team || !h.lastHeroHit || this.time - h.lastHeroHit.t > 1.5 || dist(h, m) > 6) continue;
      const e = this.get(h.lastHeroHit.id);
      if (e && dist(e, m) < 8 && this.visibleTo(e, m.team) && this.targetable(e)) return e;
    }
    let best = null, bs = Infinity;
    for (const e of this.units) {
      if (!e.alive || e.team === m.team || e.team === 2 || e.invuln || !this.visibleTo(e, m.team) || !this.targetable(e)) continue;
      const d = dist(m, e) - e.r;
      if (d > 7) continue;
      if (inPit(e.x, e.z)) continue;
      const s = d + (e.kind === K.HERO || e.kind === K.CLONE ? 3 : 0);
      if (s < bs) { bs = s; best = e; }
    }
    return best;
  }

  // ---------- towers ----------
  updateTower(t, dt) {
    // a tower can only be hurt once the one in front of it is gone; the nexus after the last tower
    const list = this.towers[t.team];
    t.invuln = t.tier > 0 && list[t.tier - 1].alive;
    t.atkCd -= dt;
    t.forceT -= dt;
    if (t.wind) { this.stepTowerShot(t, dt); return; }
    let tgt = null;
    if (t.forceT > 0) {
      const f = this.get(t.force);
      if (f && dist(t, f) - f.r <= t.range && this.visibleTo(f, t.team) && this.targetable(f)) tgt = f;
    }
    if (!tgt && t.lastT) {
      const l = this.get(t.lastT);
      if (l && dist(t, l) - l.r <= t.range && this.visibleTo(l, t.team) && this.targetable(l)) tgt = l;
    }
    if (!tgt) {
      let best = null, bs = Infinity;
      for (const e of this.units) {
        if (!e.alive || e.team === t.team || e.team === 2 || e.kind === K.TOWER || e.kind === K.NEXUS || !this.visibleTo(e, t.team) || !this.targetable(e)) continue;
        const d = dist(t, e) - e.r;
        if (d > t.range) continue;
        const s = d + (e.kind === K.HERO ? 50 : 0);
        if (s < bs) { bs = s; best = e; }
      }
      tgt = best;
    }
    if (!tgt) { t.lastT = null; t.stack = 0; return; }
    if (tgt.id !== t.lastT) { t.stack = 0; t.lastT = tgt.id; }
    if (t.atkCd <= 0) {
      t.atkCd = t.period;
      t.wind = { t: 0.15, tgt: tgt.id };
      this.ev('atk', { s: t.id, t: tgt.id, w: 0.15 });
    }
  }
  stepTowerShot(t, dt) {
    t.wind.t -= dt;
    if (t.wind.t > 0) return;
    const tgt = this.get(t.wind.tgt);
    t.wind = null;
    if (!tgt) return;
    const hero = tgt.kind === K.HERO;
    const mult = hero ? 1 + Math.min(3, t.stack) * TOWER_RAMP : 1;
    if (hero) t.stack++;
    this.projectile({
      kind: 'tshot', src: t, x: t.x, z: t.z, homing: tgt, speed: 15, y: 5,
      onHit: (u) => {
        if (u.kind === K.MINION) this.damage(t, u, u.maxHp * TOWER_MINION_DMG[u.mtype], TRUE);
        else this.damage(t, u, t.ad * mult, PHYS);
        return true;
      },
    });
  }

  // ---------- the boss ----------
  bossAggro(b, src) {
    if (b.resetting) return;
    if (!b.aggro || !this.get(b.aggro)) b.aggro = src.id;
  }
  updateBoss(b, dt) {
    this.tickBuffs(b, dt);
    if (!b.alive) return;
    const c = this.cc(b);
    b.atkCd -= dt;
    if (b.slam) {
      b.slam.t -= dt;
      b.moving = false;
      if (b.slam.t <= 0) {
        const s = b.slam;
        b.slam = null;
        this.fx('bossSlam', { x: s.x, z: s.z, r: BOSS.slamR });
        for (const e of this.enemiesIn(2, s.x, s.z, BOSS.slamR)) {
          if (e.kind === K.MINION) continue;
          this.damage(b, e, BOSS.slamDmg + b.ad * 0.5, PHYS);
          this.addBuff(e, 'air', 0.6, 0, b);
        }
      }
      return;
    }
    if (c.stun || c.air) return;
    const home = b.home;
    let tgt = b.aggro ? this.get(b.aggro) : null;
    if (tgt && (dist(tgt, home) > BOSS.leash + 2 || !inPit(tgt.x, tgt.z) && dist(tgt, home) > 9)) {
      // look for another hero inside the pit that hurt it
      tgt = null;
      for (const [id, tt] of b.dmgBy) {
        const h = this.get(id);
        if (h && this.time - tt < 5 && dist(h, home) < BOSS.leash && inPit(h.x, h.z)) { tgt = h; break; }
      }
      b.aggro = tgt ? tgt.id : null;
    }
    if (!tgt || b.resetting) {
      b.aggro = null;
      const d = dist(b, home);
      if (d > 0.5) {
        b.resetting = true;
        this.moveUnit(b, home.x, home.z, dt, { haste: 0.6, slow: 0 }, 0);
        b.hp = Math.min(b.maxHp, b.hp + b.maxHp * 0.15 * dt);
      } else {
        b.resetting = false; b.moving = false;
        b.hp = Math.min(b.maxHp, b.hp + b.maxHp * 0.15 * dt);
        b.rot = 0;
        if (b.hp >= b.maxHp) b.dmgBy.clear();
      }
      return;
    }
    if (dist(b, home) > BOSS.leash) { b.resetting = true; return; }
    b.slamT -= dt;
    if (b.slamT <= 0 && dist(b, tgt) < BOSS.slamR) {
      b.slamT = BOSS.slamEvery;
      b.slam = { t: BOSS.slamWindup, x: b.x + Math.sin(b.rot) * 1.2, z: b.z + Math.cos(b.rot) * 1.2 };
      this.face(b, tgt.x, tgt.z);
      b.slam.x = b.x + (tgt.x - b.x) * 0.5; b.slam.z = b.z + (tgt.z - b.z) * 0.5;
      this.telegraph(b, b.slam.x, b.slam.z, BOSS.slamR, BOSS.slamWindup, 'bossTele');
      this.ev('cast', { s: b.id, sl: 9, x: +b.slam.x.toFixed(2), z: +b.slam.z.toFixed(2), t: 0, w: BOSS.slamWindup });
      return;
    }
    if (b.wind) { this.stepWindup(b, dt); return; }
    if (this.inRange(b, tgt)) {
      b.moving = false;
      this.face(b, tgt.x, tgt.z);
      if (b.atkCd <= 0) {
        b.atkCd = b.period;
        b.wind = { t: 0.45, tgt: tgt.id };
        this.ev('atk', { s: b.id, t: tgt.id, w: 0.45 });
      }
    } else this.moveUnit(b, tgt.x, tgt.z, dt, c, 0);
  }

  // ---------- Árny's decoy ----------
  updateClone(cl, dt) {
    cl.life -= dt;
    const owner = this.byId.get(cl.owner);
    if (cl.life <= 0 || !owner || !owner.alive) { this.killClone(cl); return; }
    cl.hp = owner.hp; cl.maxHp = owner.maxHp; cl.level = owner.level;
    if (cl.goal) {
      if (this.moveUnit(cl, cl.goal.x, cl.goal.z, dt, { haste: 0.1, slow: 0 }, 0)) cl.goal = null;
      return;
    }
    // then it pretends to fight: walks to the nearest enemy hero and swings at it (no damage)
    let best = null, bd = 8;
    for (const h of this.heroes) if (h.alive && h.team !== cl.team && dist(h, cl) < bd) { bd = dist(h, cl); best = h; }
    cl.atkCd -= dt;
    if (best) {
      if (dist(cl, best) - best.r <= 1.8) {
        cl.moving = false;
        this.face(cl, best.x, best.z);
        if (cl.atkCd <= 0) { cl.atkCd = 1.4; this.ev('atk', { s: cl.id, t: best.id, w: 0.25 }); }
      } else this.moveUnit(cl, best.x, best.z, dt, { haste: 0.1, slow: 0 }, 0);
    } else cl.moving = false;
  }

  // ---------- projectiles, zones, relics ----------
  updateProjectiles(dt) {
    for (const p of this.proj) {
      if (p.dead) continue;
      if (p.homing) {
        const t = p.homing;
        const dx = t.x - p.x, dz = t.z - p.z, d = Math.hypot(dx, dz), s = p.speed * dt;
        if (!t.alive && t.kind !== K.CLONE) { p.dead = true; this.ev('px', { id: p.id, x: +p.x.toFixed(2), z: +p.z.toFixed(2), h: 0 }); continue; }
        if (d <= s + t.r * 0.5) {
          p.dead = true;
          if (t.alive) p.onHit(t, p);
          this.ev('px', { id: p.id, x: +t.x.toFixed(2), z: +t.z.toFixed(2), h: 1 });
        } else { p.x += dx / d * s; p.z += dz / d * s; }
        continue;
      }
      const total = p.speed * dt, n = Math.max(1, Math.ceil(total / 0.35));
      for (let i = 0; i < n && !p.dead; i++) {
        const s = Math.min(total / n, p.range - p.traveled);
        p.x += p.dx * s; p.z += p.dz * s; p.traveled += s;
        for (const u of this.units) {
          if (!u.alive || u.team === p.team || p.hit.has(u.id) || u.kind === K.TOWER || u.kind === K.NEXUS || !this.targetable(u)) continue;
          if (p.heroesOnly && u.kind !== K.HERO && u.kind !== K.CLONE) continue;
          if (Math.hypot(u.x - p.x, u.z - p.z) > u.r + p.width / 2) continue;
          p.hit.add(u.id);
          if (p.onHit(u, p)) {
            p.dead = true;
            this.ev('px', { id: p.id, x: +p.x.toFixed(2), z: +p.z.toFixed(2), h: 1 });
            break;
          }
        }
        if (!p.dead && p.traveled >= p.range - 1e-3) {
          p.dead = true;
          p.onEnd?.(p);
          this.ev('px', { id: p.id, x: +p.x.toFixed(2), z: +p.z.toFixed(2), h: 0 });
        }
      }
    }
    if (this.proj.some((p) => p.dead)) this.proj = this.proj.filter((p) => !p.dead);
  }
  updateZones(dt) {
    for (const z of this.zones) {
      if (z.dead) continue;
      z.t -= dt;
      if (z.update) z.update(z, dt);
      if (z.every) {
        z.acc += dt;
        while (z.acc >= z.every && !z.dead) { z.acc -= z.every; z.onTick?.(z); }
      }
      if (z.t <= 0 && !z.dead) this.endZone(z);
    }
    if (this.zones.some((z) => z.dead)) this.zones = this.zones.filter((z) => !z.dead);
  }
  updateRelics(dt) {
    for (const r of this.relics) {
      if (r.cd > 0) { r.cd -= dt; if (r.cd <= 0) this.ev('relic', { x: r.x, z: r.z, on: 1 }); continue; }
      for (const h of this.heroes) {
        if (!h.alive || Math.hypot(h.x - r.x, h.z - r.z) > 1.3 || h.hp >= h.maxHp) continue;
        this.heal(h, 80 + h.maxHp * 0.15);
        r.cd = 40;
        this.ev('relic', { x: r.x, z: r.z, on: 0, i: h.id });
        break;
      }
    }
  }

  separate() {
    const us = this.units;
    for (let i = 0; i < us.length; i++) {
      const a = us[i];
      if (!a.alive || a.kind === K.TOWER || a.kind === K.NEXUS || a.dash || (a.special && a.special.ghost)) continue;
      for (let j = i + 1; j < us.length; j++) {
        const b = us[j];
        if (!b.alive || b.dash || (b.special && b.special.ghost)) continue;
        const dx = b.x - a.x, dz = b.z - a.z, rr = a.r + b.r, d2 = dx * dx + dz * dz;
        if (d2 >= rr * rr) continue;
        const d = Math.sqrt(d2) || 0.01, o = (rr - d) * 0.5;
        const nx = d2 > 1e-6 ? dx / d : 1, nz = d2 > 1e-6 ? dz / d : 0;
        if (b.kind === K.TOWER || b.kind === K.NEXUS) { a.x -= nx * o * 2; a.z -= nz * o * 2; continue; }
        // heroes shove minions more than the other way round; allies don't block heroes much
        let wa = 0.5, wb = 0.5;
        if (a.kind === K.HERO && b.kind !== K.HERO) { wa = 0.15; wb = 0.85; }
        else if (b.kind === K.HERO && a.kind !== K.HERO) { wa = 0.85; wb = 0.15; }
        if (a.kind === K.BOSS) { wa = 0.05; wb = 0.95; } else if (b.kind === K.BOSS) { wa = 0.95; wb = 0.05; }
        const soft = a.kind === K.HERO && b.kind === K.HERO ? 0.5 : 0.8;
        a.x -= nx * o * 2 * wa * soft; a.z -= nz * o * 2 * wa * soft;
        b.x += nx * o * 2 * wb * soft; b.z += nz * o * 2 * wb * soft;
      }
    }
    for (const u of us) if (u.alive && u.kind !== K.TOWER && u.kind !== K.NEXUS && !u.dash) keepInside(u, u.r);
  }

  // brushes and stealth: who can see whom. vis bit 1<<team: visible to that team
  updateVisibility() {
    const mobile = this.units.filter((u) => u.alive && (u.kind === K.HERO || u.kind === K.MINION || u.kind === K.CLONE));
    for (const u of this.units) {
      if (!u.alive) continue;
      if (u.kind === K.TOWER || u.kind === K.NEXUS || u.kind === K.BOSS) { u.vis = 3; continue; }
      const brush = brushAt(u.x, u.z);
      u.brush = brush;
      const stealth = u.buffs.some((b) => b.k === 'stealth');
      const marked = u.buffs.some((b) => b.k === 'markS' || b.k === 'reveal');
      let vis = 1 << u.team;
      const enemy = 1 - u.team;
      if (u.team === 2) vis = 3;
      else if (marked || u.revealT > 0 || (!stealth && brush < 0)) vis |= 1 << enemy;
      else {
        // hidden: unless an enemy stands right next to it (or in the same brush)
        for (const e of mobile) {
          if (e.team !== enemy) continue;
          const d = dist(e, u);
          if (stealth ? d < 1.4 : (d < 2.6 || (brush >= 0 && brushAt(e.x, e.z) === brush))) { vis |= 1 << enemy; break; }
        }
        if (!stealth && !(vis & (1 << enemy))) {
          for (const t of this.towers[enemy]) if (t.alive && dist(t, u) < 4) { vis |= 1 << enemy; break; }
        }
      }
      u.vis = vis;
    }
  }

  updateFlags() {
    for (const u of this.units) {
      if (!u.alive) { u.flags = 0; continue; }
      let f = 0;
      for (const b of u.buffs) {
        switch (b.k) {
          case 'stun': f |= F.STUN; break;
          case 'root': f |= F.ROOT; break;
          case 'slow': f |= F.SLOW; break;
          case 'silence': f |= F.SILENCE; break;
          case 'air': f |= F.AIR; break;
          case 'stealth': f |= F.STEALTH; break;
          case 'untarget': f |= F.UNTARGET; break;
          case 'burn': f |= F.BURN; break;
          case 'markA': f |= F.MARK_A; break;
          case 'markS': f |= F.MARK_S; break;
          case 'boss': f |= F.BOSS; break;
          case 'taunt': f |= F.TAUNT; break;
          case 'haste': f |= F.HASTE; break;
          case 'dr': f |= F.DR; break;
          case 'spin': f |= F.SPIN; break;
          case 'pot': f |= F.POT; break;
          default: break;
        }
      }
      // the bubble is for real shields; Granit's passive stone skin only shows in his health bar
      if (u.shields.some((x) => !x.tag)) f |= F.SHIELD;
      if (u.kind === K.HERO) {
        if (u.recall > 0) f |= F.RECALL;
        if (u.dash) f |= F.DASH;
        if (u.casting) f |= F.CAST;
        if (u.special) {
          if (u.special.kind === 'leap') f |= F.LEAP;
          else if (u.special.kind === 'dance') f |= F.DANCE;
          else if (u.special.kind === 'spin') f |= F.SPIN;
          if (u.special.untarget) f |= F.UNTARGET;
        }
        if (PASSIVES[u.def.id]?.ready?.(this, u)) f |= F.READY;
      } else if (u.dash) f |= F.DASH;
      if (u.kind === K.MINION && u.emp) f |= F.EMP;
      u.flags = f;
    }
  }

  // ---------- network snapshot ----------
  snapshot() {
    const e = [];
    for (const u of this.units) {
      if (!u.alive && u.kind !== K.HERO && u.kind !== K.TOWER && u.kind !== K.NEXUS) continue;
      e.push([u.id, u.kind, u.team, u.sub, Math.round(u.x * 100), Math.round(u.z * 100), Math.round(u.rot * 100),
        Math.ceil(u.hp), Math.round(u.maxHp), u.flags, Math.round(this.shieldOf(u)), u.vis, u.alive ? 1 : 0, u.moving ? 1 : 0,
        u.kind === K.CLONE ? u.owner : u.kind === K.TOWER ? (u.invuln ? 1 : 0) : u.kind === K.NEXUS ? (this.towers[u.team][2].alive ? 1 : 0) : 0]);
    }
    const h = this.heroes.map((x) => [
      x.id, x.level, Math.floor(x.xp), x.level >= MAX_LEVEL ? 0 : xpToNext(x.level), Math.floor(x.gold), x.k, x.d, x.a, x.cs,
      x.items.map((i) => (i === null ? -1 : i)), x.potions, x.cds.map((c) => Math.round(c * 10)),
      Math.round(Math.max(0, x.respawnT) * 10), Math.round(x.recall * 10), x.p.a | 0, x.p.b | 0, Math.round(x.dmgDealt),
      Math.round(x.ad), Math.round(x.ap), Math.round(x.armor), Math.round(x.mr), +(x.as * (1 + (x.ccNow ? x.ccNow.asB : 0))).toFixed(2), +x.ms.toFixed(2), Math.round(x.cdr * 100),
      x.casting ? x.casting.slot + 1 : 0,
    ]);
    return { t: +this.time.toFixed(3), e, h, kc: this.kills, bt: this.boss && this.boss.alive ? -1 : Math.max(0, Math.ceil(this.bossT)), w: this.winner };
  }
}
