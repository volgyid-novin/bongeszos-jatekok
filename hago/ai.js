// The bots. A bot hero only issues the same commands a player can (sim.command), it just decides them itself:
// shop, lane behind its minions, last-hit, poke, fight when the numbers look good, dodge skillshots and
// telegraphs, retreat and recall when low, take the boss when the other team is dead or far away.

import { HEROES, DIFFS, K, ITEMS, POTION, TICK, UNLOCK, LANE } from './data.js';
import { fountainPos, laneDir, inPit, PIT, RELICS } from './map.js';

const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const rnd = (a, b) => a + Math.random() * (b - a);
const ITEM_ID = Object.fromEntries(ITEMS.map((it, i) => [it.id, i]));
const DANGER = new Set(['ringTele', 'meteorTele', 'rainTele', 'leapTele', 'bossTele', 'burnGround', 'flameWall', 'quake']);

export function botThink(sim, h, dt) {
  const D = DIFFS[h.diff] || DIFFS[1];
  const S = h.aiState;
  if (!S.init) {
    Object.assign(S, { init: true, t: rnd(0, 0.3), mode: 'lane', modeT: 0, laneZ: (h.slot % 2 ? 1 : -1) * rnd(1, 2.5), dodge: new Map(), castT: 0, moveT: 0, lastMv: null, shopT: 0 });
  }
  shop(sim, h, D, S);
  if (!h.alive) return;
  S.t -= dt; S.castT -= dt; S.moveT -= dt; S.modeT -= dt;
  // dodging is checked every tick (it decides once per projectile whether this bot even tries)
  if (dodge(sim, h, D, S)) return;
  if (S.t > 0) return;
  S.t = D.react * rnd(0.7, 1.3);
  think(sim, h, D, S);
}

// ---------- shopping ----------
function shop(sim, h, D, S) {
  if (!sim.inShop(h)) return;
  S.shopT -= TICK;
  if (S.shopT > 0) return;
  S.shopT = 0.5;
  for (const id of h.def.build) {
    const idx = ITEM_ID[id];
    if (h.items.includes(idx)) continue;
    if (h.gold >= ITEMS[idx].cost && h.items.includes(null)) sim.command(h, { k: 'buy', i: id });
    return buyPots(sim, h);
  }
  // full build: swap the cheapest basic item for an advanced one we don't have
  buyPots(sim, h);
}
function buyPots(sim, h) {
  const want = sim.time < 600 ? 2 : 1;
  if (h.potions < want && h.gold >= POTION.cost + 300) sim.command(h, { k: 'buy', i: 'pot' });
}

// ---------- dodging ----------
function dodge(sim, h, D, S) {
  if (h.casting || h.dash || h.special || h.recall > 0) return false;
  const c = h.ccNow;
  if (c && (c.root || c.stun || c.air)) return false;
  // skillshots flying at us
  for (const p of sim.proj) {
    if (p.homing || p.team === h.team || p.dead) continue;
    let dec = S.dodge.get(p.id);
    if (dec === undefined) { dec = Math.random() < D.dodge; S.dodge.set(p.id, dec); if (S.dodge.size > 60) S.dodge.clear(); }
    if (!dec) continue;
    const rx = h.x - p.x, rz = h.z - p.z, along = rx * p.dx + rz * p.dz;
    if (along < -0.5 || along > p.range - p.traveled + 1) continue;
    const across = -rx * p.dz + rz * p.dx, need = p.width / 2 + h.r + 0.35;
    if (Math.abs(across) > need) continue;
    const tArrive = along / p.speed;
    if (tArrive > 0.9) continue;
    const side = across >= 0 ? 1 : -1;
    const dx = -p.dz * side, dz = p.dx * side;
    goTo(sim, h, S, h.x + dx * 2.5, h.z + dz * 2.5, true);
    return true;
  }
  // ground telegraphs and burning zones
  for (const z of sim.zones) {
    if (z.team === h.team || !DANGER.has(z.kind)) continue;
    if (!sim.inZone(z, h)) continue;
    let dec = S.dodge.get(z.id);
    if (dec === undefined) { dec = Math.random() < D.dodge + 0.25; S.dodge.set(z.id, dec); }
    if (!dec) continue;
    let dx, dz;
    if (z.hl) { const s = (h.x - z.x) * -z.uz + (h.z - z.z) * z.ux >= 0 ? 1 : -1; dx = -z.uz * s; dz = z.ux * s; }
    else { dx = h.x - z.x; dz = h.z - z.z; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l; if (l < 0.2) { dx = 0; dz = 1; } }
    const out = (z.r || z.hw) + h.r + 0.8;
    goTo(sim, h, S, z.x + dx * out + (z.hl ? (h.x - z.x) : 0) * 0, z.z + dz * out, true);
    return true;
  }
  return false;
}

// ---------- the main decision ----------
function think(sim, h, D, S) {
  const team = h.team, dir = laneDir(team);
  const hpP = h.hp / h.maxHp;
  const enemies = sim.heroes.filter((e) => e.team !== team && e.alive && sim.visibleTo(e, team) && sim.targetable(e));
  // clones look like heroes; hard bots see through them half the time
  for (const u of sim.units) if (u.kind === K.CLONE && u.alive && u.team !== team && sim.visibleTo(u, team) && !(h.diff === 2 && (u.id + h.id) % 2 === 0)) enemies.push(u);
  const near = enemies.filter((e) => dist(e, h) < 11);
  const allies = sim.heroes.filter((a) => a.team === team && a.alive);
  const fount = fountainPos(team);
  const atBase = dist(h, fount) < 8;

  // potions
  if (h.potions > 0 && hpP < 0.55 && !sim.hasBuff(h, 'pot') && !atBase) sim.command(h, { k: 'pot' });

  // healing up at the fountain
  if (atBase && hpP < 0.92 && near.length === 0) { stay(sim, h, S); return; }

  // ---------- retreat ----------
  const threat = power(sim, near, h, true), mine = power(sim, allies.filter((a) => dist(a, h) < 11), h, false);
  const lowHp = hpP < D.retreat || (hpP < D.retreat + 0.15 && threat > mine * 1.2);
  if (S.mode === 'retreat' && hpP > 0.75) S.mode = 'lane';
  if (lowHp || S.mode === 'retreat') {
    S.mode = 'retreat';
    const closest = near.reduce((b, e) => (!b || dist(e, h) < dist(b, h) ? e : b), null);
    if (!closest || dist(closest, h) > 9) {
      if (sim.time - h.lastDmgT > 1.2 && !atBase) { if (h.recall <= 0) { sim.command(h, { k: 'st' }); sim.command(h, { k: 'rc' }); } return; }
    }
    if (closest && dist(closest, h) < 6) useEscape(sim, h, D, S, closest, fount);
    if (h.recall > 0 && (!closest || dist(closest, h) > 7)) return;
    goTo(sim, h, S, fount.x, fount.z, false);
    return;
  }
  if (h.recall > 0) { if (near.length === 0) return; }

  // ---------- fight ----------
  const target = pickTarget(sim, h, near);
  const underEnemyTower = enemyTowerCovering(sim, h, h);
  if (target) {
    const tTower = enemyTowerCovering(sim, h, target);
    const others = near.filter((e) => e !== target && e.kind === K.HERO && dist(e, target) < 8).length;
    const allyNear = allies.some((a) => a !== h && dist(a, h) < 9);
    const killable = target.hp < estBurst(sim, h) * 0.9 && (others === 0 || allyNear) && hpP > 0.35;
    let want = mine * D.aggr >= threat * 1.05 || killable;
    // melee divers wait for a good moment when they would end up alone against two
    if (h.def.melee && others > 0 && !allyNear && hpP < 0.7 && !killable) want = false;
    if (tTower && !(killable && hpP > 0.5 && h.diff === 2)) want = false;
    if (S.mode === 'fight' && S.modeT > 0) want = want || threat < mine * 1.4;
    if (want) {
      if (S.mode !== 'fight') S.modeT = 1.2;
      S.mode = 'fight';
      fight(sim, h, D, S, target, near, killable);
      return;
    }
    // not worth it: keep a safe distance but still poke
    if (dist(target, h) < 5.5 && !h.def.melee) { kiteFrom(sim, h, S, target); }
    if (tryPoke(sim, h, D, S, target, underEnemyTower)) return;
  }
  if (S.mode === 'fight') S.mode = 'lane';

  // ---------- go home to spend a pile of gold ----------
  const next = h.def.build.map((id) => ITEM_ID[id]).find((i) => !h.items.includes(i));
  if (next !== undefined && h.items.includes(null) && h.gold >= ITEMS[next].cost + 150 && near.length === 0 && !atBase && sim.time - h.lastDmgT > 2) {
    if (h.recall <= 0) { sim.command(h, { k: 'st' }); sim.command(h, { k: 'rc' }); }
    return;
  }

  // ---------- boss ----------
  if (bossTime(sim, h, allies, enemies, hpP)) { doBoss(sim, h, D, S); return; }

  // ---------- relic ----------
  if (hpP < 0.6 && near.length === 0) {
    for (const r of sim.relics) {
      if (r.cd > 0 || Math.hypot(r.x - h.x, r.z - h.z) > 16) continue;
      goTo(sim, h, S, r.x, r.z, false);
      return;
    }
  }

  // the other team is dead or nowhere near: push the next structure even without minions
  const enemyHeroes = sim.heroes.filter((e) => e.team !== team);
  const deadE = enemyHeroes.filter((e) => !e.alive);
  const shortest = deadE.length ? Math.min(...deadE.map((e) => e.respawnT)) : 0;
  if (deadE.length === enemyHeroes.length && shortest > 8 && hpP > 0.45) { push(sim, h, S); return; }

  lane(sim, h, D, S, dir, near, underEnemyTower);
}

function push(sim, h, S) {
  const s = sim.towers[1 - h.team].find((t) => t.alive) || sim.nexus[1 - h.team];
  if (!s || !s.alive) return;
  attack(sim, h, S, s);
}

function power(sim, list, me, enemy) {
  let p = 0;
  for (const u of list) {
    const lvl = u.level || me.level;
    let v = (u.hp / u.maxHp) * (1 + 0.14 * (lvl - 1));
    if (u.kind === K.HERO && u.level >= UNLOCK[5] && u.cds[5] <= 0) v += 0.35;
    if (u.ccNow && (u.ccNow.stun || u.ccNow.air || u.ccNow.root)) v *= 0.6;
    p += v;
  }
  // towers count
  if (enemy) { if (enemyTowerCovering(sim, me, me)) p += 1.2; }
  else { for (const t of sim.towers[me.team]) if (t.alive && dist(t, me) < t.range + 1) { p += 1.0; break; } }
  return p;
}
function estBurst(sim, h) {
  let d = h.ad * 2;
  h.def.skills.forEach((sk, i) => {
    if (h.level < UNLOCK[i] || h.cds[i] > 0.5 || !sk.n.d) return;
    d += sim.sv(h, sk.n.d) * (i === 5 ? 1.2 : 0.8);
  });
  return d * 0.8;
}
function pickTarget(sim, h, near) {
  let best = null, bs = Infinity;
  for (const e of near) {
    const s = e.hp + dist(e, h) * 30;
    if (s < bs) { bs = s; best = e; }
  }
  return best;
}
function enemyTowerCovering(sim, h, p) {
  for (const t of sim.towers[1 - h.team]) if (t.alive && dist(t, p) < t.range + 0.8) return t;
  return null;
}

// ---------- movement helpers ----------
function goTo(sim, h, S, x, z, force) {
  if (h.wind && !force) return;
  const lm = S.lastMv;
  if (!force && lm && Math.hypot(lm.x - x, lm.z - z) < 0.6 && S.moveT > 0 && h.cmd && h.cmd.type === 'move') return;
  S.lastMv = { x, z }; S.moveT = 0.5;
  sim.command(h, { k: 'mv', x, z });
}
function stay(sim, h, S) { if (h.cmd) sim.command(h, { k: 'st' }); }
function attack(sim, h, S, t) {
  if (h.cmd && h.cmd.type === 'attack' && h.cmd.t === t.id) return;
  sim.command(h, { k: 'at', t: t.id });
}
function kiteFrom(sim, h, S, e) {
  if (h.wind) return;
  const dx = h.x - e.x, dz = h.z - e.z, l = Math.hypot(dx, dz) || 1;
  const f = fountainPos(h.team);
  const bx = (f.x - h.x), bz = (f.z - h.z), bl = Math.hypot(bx, bz) || 1;
  goTo(sim, h, S, h.x + (dx / l + bx / bl) * 1.6, h.z + (dz / l + bz / bl) * 1.6, false);
}

// ---------- casting ----------
function ready(h, i) { return h.level >= UNLOCK[i] && h.cds[i] <= 0 && !h.casting; }
function cast(sim, h, i, x, z, t) {
  sim.command(h, { k: 'cs', s: i, x, z, t: t ? t.id : 0 });
  h.aiState.castT = 0.35;
}
// where will `e` be when a skill that takes `delay` seconds lands?
function lead(sim, h, D, e, delay) {
  const vx = clamp(e.vx || 0, -8, 8), vz = clamp(e.vz || 0, -8, 8);
  const err = D.aim * rnd(-1, 1);
  const k = clamp(1 - D.aim * 0.5, 0.3, 1);
  return { x: e.x + vx * delay * k + err * 0.8, z: e.z + vz * delay * k + err * 0.8 };
}
function lineAim(sim, h, D, e, sk) {
  const d = dist(h, e);
  return lead(sim, h, D, e, (sk.cast || 0) + d / (sk.speed || 20));
}
function ccd(u) { const c = u.ccNow; return c && (c.stun || c.air || c.root); }

function tryPoke(sim, h, D, S, e, underTower) {
  if (S.castT > 0 || underTower) return false;
  const sks = h.def.skills;
  for (let i = 0; i < 5; i++) {
    const sk = sks[i];
    if (sk.ai.use !== 'poke' || !ready(h, i)) continue;
    if (dist(h, e) > sk.range * 0.92) continue;
    const p = lineAim(sim, h, D, e, sk);
    cast(sim, h, i, p.x, p.z);
    return true;
  }
  return false;
}

function useEscape(sim, h, D, S, foe, fount) {
  if (S.castT > 0) return;
  const sks = h.def.skills;
  const away = () => { const dx = fount.x - h.x, dz = fount.z - h.z, l = Math.hypot(dx, dz) || 1; return { x: h.x + dx / l * 6, z: h.z + dz / l * 6 }; };
  for (let i = 0; i < 5; i++) {
    if (!ready(h, i)) continue;
    const sk = sks[i];
    if (sk.ai.use === 'escape') {
      if (h.def.id === 'arny' && i === 2) continue;
      const p = away();
      cast(sim, h, i, p.x, p.z);
      return;
    }
    // Sólyom drops a trap at his own feet; Granit taunts whoever is on him; Parázs walls them off
    if (sk.ai.use === 'trap' && dist(foe, h) < 5) { cast(sim, h, i, h.x, h.z); return; }
    if (h.def.id === 'granit' && i === 3 && dist(foe, h) < 3.3) { cast(sim, h, i, h.x, h.z); return; }
    if (h.def.id === 'parazs' && i === 1) { cast(sim, h, i, (h.x + foe.x) / 2, (h.z + foe.z) / 2); return; }
  }
  // Árny can step to an ally minion that is further back
  if (h.def.id === 'arny' && ready(h, 2)) {
    let best = null;
    for (const u of sim.units) {
      if (!u.alive || u.team !== h.team || u.kind !== K.MINION || dist(u, h) > 6.2) continue;
      if (dist(u, fount) < dist(h, fount) - 2 && (!best || dist(u, fount) < dist(best, fount))) best = u;
    }
    if (best) cast(sim, h, 2, best.x, best.z, best);
  }
}

// ---------- fighting ----------
function fight(sim, h, D, S, e, near, killable) {
  const id = h.def.id, sks = h.def.skills, d = dist(h, e);
  if (S.castT <= 0) {
    const c = pickCombo(sim, h, D, e, near, d, killable);
    if (c) { cast(sim, h, c.i, c.x, c.z, c.t); if (!(id === 'granit' && c.i === 4)) return; }
  }
  // basic attacks, kiting for ranged heroes
  if (!h.def.melee && d < 2.6 && e.kind === K.HERO && e.def && e.def.melee && h.atkCd > 0.25 && !ccd(e)) { kiteFrom(sim, h, S, e); return; }
  attack(sim, h, S, e);
}

function pickCombo(sim, h, D, e, near, d, killable) {
  const id = h.def.id, sks = h.def.skills;
  const ultOk = Math.random() < D.ult;
  const hpP = h.hp / h.maxHp, eP = e.hp / e.maxHp;
  const say = (i, x, z, t) => ({ i, x, z, t });
  if (id === 'granit') {
    if (ready(h, 5) && ultOk && d < sks[5].range + 1 && (eP < 0.7 || near.length > 1)) { const p = lead(sim, h, D, e, 0.9); return say(5, p.x, p.z); }
    if (ready(h, 0) && d < sks[0].range + 0.3 && !ccd(e)) return say(0, e.x, e.z);
    if (ready(h, 1) && d < sks[1].range * 0.9) { const p = lineAim(sim, h, D, e, sks[1]); return say(1, p.x, p.z); }
    if (ready(h, 3) && d < 3.2) return say(3, h.x, h.z);
    if (ready(h, 2) && (hpP < 0.75 || sim.heroes.some((a) => a.team === h.team && a !== h && a.alive && dist(a, h) < 7 && a.hp / a.maxHp < 0.6))) return say(2, h.x, h.z);
    if (ready(h, 4) && d < 2.5) return say(4, h.x, h.z);
  } else if (id === 'parazs') {
    if (ready(h, 5) && ultOk && d < sks[5].range && (ccd(e) || eP < 0.45 || killable)) { const p = lead(sim, h, D, e, ccd(e) ? 0.2 : 1.3); return say(5, p.x, p.z); }
    if (ready(h, 3) && d < sks[3].range) { const p = lead(sim, h, D, e, ccd(e) ? 0.2 : 1.0); return say(3, p.x, p.z); }
    if (ready(h, 0) && d < sks[0].range * 0.95) { const p = lineAim(sim, h, D, e, sks[0]); return say(0, p.x, p.z); }
    if (ready(h, 4) && d < sks[4].range - 0.5) return say(4, e.x, e.z);
    if (ready(h, 1) && d < sks[1].range) { const p = lead(sim, h, D, e, 0.4); return say(1, p.x, p.z); }
    if (ready(h, 2) && killable && d > h.range && d < h.range + 4.5) return say(2, e.x, e.z);
  } else if (id === 'solyom') {
    if (ready(h, 5) && ultOk && d < 26 && (killable || ccd(e))) { const p = lineAim(sim, h, D, e, sks[5]); return say(5, p.x, p.z); }
    if (ready(h, 4) && d < sks[4].range) return say(4, e.x, e.z, e);
    if (ready(h, 3) && ccd(e) && d < sks[3].range) return say(3, e.x, e.z);
    if (ready(h, 0) && d < sks[0].range * 0.95) { const p = lineAim(sim, h, D, e, sks[0]); return say(0, p.x, p.z); }
    if (ready(h, 1) && d < sks[1].range) { const p = lead(sim, h, D, e, 0.7); return say(1, p.x, p.z); }
    if (ready(h, 2) && e.def && e.def.melee && d < 2.4) { const f = fountainPos(h.team); const dx = h.x - e.x + (f.x - h.x) * 0.05, dz = h.z - e.z; const l = Math.hypot(dx, dz) || 1; return say(2, h.x + dx / l * 4, h.z + dz / l * 4); }
  } else if (id === 'arny') {
    if (ready(h, 5) && ultOk && d < sks[5].range && (eP < 0.6 || killable) && e.kind === K.HERO) return say(5, e.x, e.z, e);
    if (ready(h, 2) && d < sks[2].range && d > 2.2) return say(2, e.x, e.z, e);
    if (ready(h, 0) && d < sks[0].range * 0.95) { const p = lineAim(sim, h, D, e, sks[0]); return say(0, p.x, p.z); }
    if (ready(h, 3) && d < 2.5) return say(3, h.x, h.z);
    if (ready(h, 1) && hpP < 0.45) return say(1, h.x, h.z);
    if (ready(h, 4) && hpP < 0.3) { const f = fountainPos(h.team); return say(4, e.x + (e.x - f.x), e.z); }
  }
  return null;
}

// ---------- the boss ----------
function bossTime(sim, h, allies, enemies, hpP) {
  const b = sim.boss;
  if (!b || !b.alive || hpP < 0.45) return false;
  if (b.aggro && sim.heroes.some((a) => a.team === h.team && a.alive && a.id === b.aggro)) return true;   // an ally is on it
  const enemyAlive = sim.heroes.filter((e) => e.team !== h.team && e.alive);
  const enemyNear = enemyAlive.some((e) => dist(e, PIT) < 26);
  const lvlSum = allies.reduce((s, a) => s + a.level, 0);
  if (enemyAlive.length === 0 && lvlSum >= 9) return true;
  if (!enemyNear && allies.length >= 2 && lvlSum >= 15 && allies.every((a) => a.hp / a.maxHp > 0.6)) return true;
  return false;
}
function doBoss(sim, h, D, S) {
  const b = sim.boss;
  if (!inPit(h.x, h.z) && dist(h, b) > 8) { goTo(sim, h, S, PIT.x, PIT.z + 3, false); return; }
  if (S.castT <= 0) {
    // damage skills on the boss
    const sks = h.def.skills;
    for (let i = 0; i < 5; i++) {
      const sk = sks[i];
      if (!ready(h, i) || !sk.n.d || sk.ai.use === 'escape' || sk.kind === 'dash' || sk.kind === 'blink') continue;
      if (sk.kind === 'unit' && sk.targets === 'hero') continue;
      if (dist(h, b) > (sk.range || sk.radius || 3) + b.r) continue;
      cast(sim, h, i, b.x, b.z, b);
      return;
    }
  }
  attack(sim, h, S, b);
}

// ---------- laning ----------
function lane(sim, h, D, S, dir, near, underEnemyTower) {
  const team = h.team;
  // the front of our wave
  let front = null;
  for (const u of sim.units) {
    if (!u.alive || u.team !== team || u.kind !== K.MINION) continue;
    if (front === null || u.x * dir > front * dir) front = u.x;
  }
  let holdX;
  const myTowers = sim.towers[team].filter((t) => t.alive);
  const lastTower = myTowers.length ? myTowers.reduce((b, t) => (t.x * dir < b.x * dir ? b : t)) : sim.nexus[team];
  if (front === null) holdX = lastTower.x + dir * 2.5;
  else holdX = front - dir * (h.def.melee ? 1.2 : 3.2);
  // never drift deep into enemy tower range without minions there
  const eTower = sim.towers[1 - team].find((t) => t.alive) || sim.nexus[1 - team];
  const eRange = (eTower.range || 7.5) + 1.2;
  const minionsAtTower = sim.units.filter((u) => u.alive && u.team === team && u.kind === K.MINION && dist(u, eTower) < eRange - 0.8).length;
  const towerOnMe = eTower.kind === K.TOWER && eTower.lastT === h.id;
  if (minionsAtTower < 1 || towerOnMe) holdX = dir > 0 ? Math.min(holdX, eTower.x - eRange) : Math.max(holdX, eTower.x + eRange);

  // targets: last-hittable minions first, then anything near the front
  let lastHit = null, any = null, anyD = Infinity;
  const reach = h.range + (h.def.melee ? 2.5 : 1.5);
  for (const u of sim.units) {
    if (!u.alive || u.team === team || u.kind !== K.MINION || !sim.visibleTo(u, team)) continue;
    const d = dist(u, h) - u.r;
    if (d > reach + 3) continue;
    const dmg = h.ad * (100 / (100 + u.armor));
    if (u.hp <= dmg * (0.95 + (1 - D.lastHit) * 0.6) && d <= reach && Math.random() < D.lastHit + 0.15) { if (!lastHit || u.hp < lastHit.hp) lastHit = u; }
    if (d < anyD) { anyD = d; any = u; }
  }
  if (lastHit && !(underEnemyTower && (towerOnMe || minionsAtTower < 1))) { attack(sim, h, S, lastHit); return; }
  // farm with area skills when nobody is around
  if (S.castT <= 0 && near.length === 0 && any && Math.random() < 0.08) {
    const sks = h.def.skills;
    for (let i = 0; i < 5; i++) {
      const sk = sks[i];
      if (!ready(h, i) || (sk.ai.use !== 'aoe' && sk.ai.use !== 'poke')) continue;
      const cl = sim.units.filter((u) => u.alive && u.team !== team && u.kind === K.MINION && dist(u, any) < 2.6).length;
      if (cl < 3 || dist(h, any) > (sk.range || sk.radius) + 0.5) continue;
      cast(sim, h, i, any.x, any.z);
      return;
    }
  }
  // hit the tower when our minions tank it
  if (eTower.alive && !eTower.invuln && minionsAtTower >= 2 && !towerOnMe && near.length === 0 && dist(h, eTower) < eRange + h.range + 3) {
    if (eTower.kind === K.NEXUS || sim.towers[1 - team].every((t) => !t.alive) || eTower.kind === K.TOWER) { attack(sim, h, S, eTower); return; }
  }
  if (any && anyD <= h.range + 0.3 && !(underEnemyTower && minionsAtTower < 1)) {
    // don't shove the wave too hard on easy, keep hitting on hard
    if (Math.random() < 0.5 + 0.25 * h.diff) { attack(sim, h, S, any); return; }
  }
  // Sólyom: keep a trap in the brush near the front
  if (h.def.id === 'solyom' && ready(h, 3) && near.length === 0 && (h.p.traps || []).filter((z) => !z.dead).length < 2 && Math.random() < 0.05) {
    cast(sim, h, 3, holdX + dir * 3, rnd(-3, 3));
    return;
  }
  const tz = clamp(S.laneZ, -4, 4);
  if (Math.abs(h.x - holdX) > 1.2 || Math.abs(h.z - tz) > 2 || (h.cmd && h.cmd.type === 'attack')) {
    if (h.cmd && h.cmd.type === 'attack' && h.wind) return;
    goTo(sim, h, S, holdX + rnd(-0.6, 0.6), tz, false);
  }
}
