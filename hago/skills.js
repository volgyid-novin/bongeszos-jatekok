// What every skill and passive actually does. Each skill: (sim, hero, aim {x, z, t}, emp {dmg, area}) => void.
// emp is Parázs's "Túlhevülés" (1 / 1 for everyone else). The numbers come from data.js (sim.sv reads them).

import { HEROES, K, PHYS, MAGIC } from './data.js';

const def = (id) => HEROES.find((h) => h.id === id);
const G = def('granit'), P = def('parazs'), S = def('solyom'), A = def('arny');
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const dirTo = (h, aim) => {
  let dx = aim.x - h.x, dz = aim.z - h.z;
  const l = Math.hypot(dx, dz);
  if (l < 0.01) return { x: Math.sin(h.rot), z: Math.cos(h.rot) };
  dx /= l; dz /= l;
  return { x: dx, z: dz };
};
const isHeroLike = (u) => u.kind === K.HERO || u.kind === K.CLONE;
const r2 = (v) => +v.toFixed(2);

// ============================================================
//  GRANIT, a Kőlovag
// ============================================================
const granit = [
  // Q Pajzsroham: dash, stops at the first hero and stuns it; minions get shoved aside
  (sim, h, aim) => {
    const sk = G.skills[0], d = dirTo(h, aim), dmg = sim.sv(h, sk.n.d);
    sim.dash(h, h.x + d.x * sk.range, h.z + d.z * sk.range, 18, {
      anim: 1,
      onStep: (u, ds) => {
        for (const e of sim.enemiesIn(h.team, u.x, u.z, u.r + 0.45)) {
          if (ds.hitSet.has(e.id)) continue;
          ds.hitSet.add(e.id);
          if (isHeroLike(e) || e.kind === K.BOSS) {
            sim.damage(h, e, dmg, PHYS);
            if (e.kind !== K.BOSS) sim.addBuff(e, 'stun', sk.stun, 0, h);
            sim.fx('bash', { x: r2(e.x), z: r2(e.z) });
            if (e.alive && e.kind !== K.BOSS) { h.target = e.id; h.cmd = { type: 'attack', t: e.id }; }
            return true;
          }
          sim.damage(h, e, dmg * 0.5, PHYS);
          if (!e.alive) continue;
          const side = (e.x - u.x) * -d.z + (e.z - u.z) * d.x >= 0 ? 1 : -1;
          sim.dash(e, e.x - d.z * side * 1.7 + d.x * 0.5, e.z + d.x * side * 1.7 + d.z * 0.5, 11, { face: false });
        }
        return false;
      },
    });
  },
  // W Földhasítás: a piercing ground wave that knocks up
  (sim, h, aim) => {
    const sk = G.skills[1], d = dirTo(h, aim), dmg = sim.sv(h, sk.n.d);
    sim.projectile({
      kind: 'fissure', src: h, x: h.x + d.x * 0.6, z: h.z + d.z * 0.6, dx: d.x, dz: d.z, speed: sk.speed, range: sk.range, width: sk.width,
      onHit: (u) => { sim.damage(h, u, dmg, PHYS); sim.addBuff(u, 'air', 0.5, 0, h); return false; },
    });
  },
  // E Kőpajzs: shield on himself and the nearest ally
  (sim, h) => {
    const sk = G.skills[2], sh = sim.sv(h, sk.n.sh);
    sim.addShield(h, sh, 3, h);
    let best = null, bd = sk.radius;
    for (const a of sim.heroes) if (a !== h && a.alive && a.team === h.team && dist(a, h) <= bd) { bd = dist(a, h); best = a; }
    if (best) sim.addShield(best, sh, 3, h);
  },
  // D Dübörgés: taunt around, damage reduction
  (sim, h) => {
    const sk = G.skills[3];
    for (const e of sim.enemiesIn(h.team, h.x, h.z, sk.radius)) {
      if (e.kind === K.BOSS) continue;
      sim.addBuff(e, 'taunt', sk.taunt, 0, h);
    }
    sim.addBuff(h, 'dr', 3, 0.3, h);
    sim.fx('roar', { i: h.id, r: sk.radius });
  },
  // F Forgószél: spin for 2 s while moving
  (sim, h) => {
    const sk = G.skills[4];
    if (h.special) h.special.end?.(true);
    const sp = {
      kind: 'spin', noAttack: true, msMul: 1.1, fragile: true, t: 2, acc: 0.3,
      update(dt) {
        this.t -= dt; this.acc += dt;
        while (this.acc >= 0.333) {
          this.acc -= 0.333;
          const dmg = sim.sv(h, sk.n.d);
          for (const e of sim.enemiesIn(h.team, h.x, h.z, sk.radius)) sim.damage(h, e, dmg, PHYS);
        }
        if (this.t <= 0 && h.special === this) h.special = null;
      },
      end() { if (h.special === sp) h.special = null; },
    };
    h.special = sp;
  },
  // R Hegyomlás: leap, land with a knock-up, leave a quaking zone
  (sim, h, aim) => {
    const sk = G.skills[5], to = sim.landing(h, aim.x, aim.z), T = 0.85, fx = h.x, fz = h.z;
    if (h.special) h.special.end?.(true);
    sim.telegraph(h, to.x, to.z, sk.radius, T, 'leapTele');
    sim.ev('leap', { i: h.id, fx: r2(fx), fz: r2(fz), x: r2(to.x), z: r2(to.z), d: T });
    const sp = {
      kind: 'leap', block: true, untarget: true, ghost: true, t: T,
      update(dt) {
        this.t -= dt;
        const k = Math.min(1, 1 - this.t / T);
        h.x = fx + (to.x - fx) * k; h.z = fz + (to.z - fz) * k;
        if (this.t > 0) return;
        h.special = null;
        const dmg = sim.sv(h, sk.n.d);
        sim.fx('slam', { x: r2(to.x), z: r2(to.z), r: sk.radius });
        for (const e of sim.enemiesIn(h.team, to.x, to.z, sk.radius)) {
          sim.damage(h, e, dmg, PHYS);
          if (e.kind !== K.BOSS) sim.addBuff(e, 'air', 1.0, 0, h);
        }
        sim.zone({
          kind: 'quake', src: h, x: to.x, z: to.z, r: sk.radius, dur: 2.5, every: 0.25,
          onTick: (z) => { for (const e of sim.enemiesIn(h.team, z.x, z.z, z.r)) sim.addBuff(e, 'slow', 0.4, 0.4, h); },
        });
      },
    };
    h.special = sp;
  },
];

const granitP = {
  // Kőbőr: a stone shield grows back after 6 s without damage
  tick(sim, h, dt) {
    h.p.t += dt;
    if (h.p.sk && !h.shields.some((s) => s.tag === 'stone')) h.p.sk = false;
    if (!h.p.sk && h.p.t >= 6) {
      h.p.sk = true;
      sim.addShield(h, sim.sv(h, G.passives[0].n.sh), 9999, h, 'stone');
    }
  },
  onDamaged(sim, h) { h.p.t = 0; },
  // Földrengető: every 3rd hit quakes (from level 4)
  onBasicHit(sim, h, tgt) {
    if (h.level < 4) return;
    h.p.a = (h.p.a || 0) + 1;
    if (h.p.a < 3) return;
    h.p.a = 0;
    let b = sim.sv(h, G.passives[1].n.d) + tgt.maxHp * 0.04;
    if (tgt.kind !== K.HERO) b = Math.min(b, 200);
    sim.later(0, () => {
      if (!tgt.alive) return;
      sim.damage(h, tgt, b, PHYS);
      sim.addBuff(tgt, 'slow', 1, 0.3, h);
    });
    sim.fx('quakeHit', { x: r2(tgt.x), z: r2(tgt.z) });
  },
  ready(sim, h) { return h.level >= 4 && h.p.a === 2; },
};

// ============================================================
//  PARÁZS, a Lángszövő
// ============================================================
const burnP = (sim, h, e, mul = 1) => { if (e.alive && e.kind !== K.TOWER && e.kind !== K.NEXUS) sim.burn(e, h, sim.sv(h, P.passives[0].n.d), 3 * mul); };
function fireBurst(sim, h, x, z, r, dmg, main = null) {
  sim.fx('boom', { x: r2(x), z: r2(z), r: r2(r), c: 0 });
  for (const e of sim.enemiesIn(h.team, x, z, r)) {
    sim.damage(h, e, e === main || !main ? dmg : dmg * 0.5, MAGIC);
    burnP(sim, h, e);
  }
}
const parazs = [
  // Q Tűzgolyó
  (sim, h, aim, emp) => {
    const sk = P.skills[0], d = dirTo(h, aim), dmg = sim.sv(h, sk.n.d) * emp.dmg;
    sim.projectile({
      kind: emp.area > 1 ? 'fireballX' : 'fireball', src: h, x: h.x + d.x * 0.7, z: h.z + d.z * 0.7, dx: d.x, dz: d.z,
      speed: sk.speed, range: sk.range, width: sk.width * emp.area,
      onHit: (u) => {
        sim.damage(h, u, dmg, MAGIC);
        burnP(sim, h, u);
        const r = 2.2 * emp.area;
        sim.fx('boom', { x: r2(u.x), z: r2(u.z), r: r2(r), c: 0 });
        for (const e of sim.enemiesIn(h.team, u.x, u.z, r)) if (e !== u) { sim.damage(h, e, dmg * 0.5, MAGIC); burnP(sim, h, e); }
        return true;
      },
      onEnd: (p) => sim.fx('fizzle', { x: r2(p.x), z: r2(p.z) }),
    });
  },
  // W Lángfal: a burning wall across the cast direction; allies passing through speed up
  (sim, h, aim, emp) => {
    const sk = P.skills[1], d = dirTo(h, aim), dmg = sim.sv(h, sk.n.d) * emp.dmg;
    sim.zone({
      kind: 'flameWall', src: h, x: aim.x, z: aim.z, ux: -d.z, uz: d.x, hl: sk.length / 2 * emp.area, hw: 0.5, dur: 3.5, every: 0.25,
      onTick(z) {
        z.n = (z.n || 0) + 1;
        for (const u of sim.units) {
          if (!u.alive || u.kind === K.TOWER || u.kind === K.NEXUS || !sim.inZone(z, u)) continue;
          if (u.team === h.team) { if (u.kind === K.HERO) sim.addBuff(u, 'haste', 1.5, 0.25, h); continue; }
          if (!sim.targetable(u)) continue;
          sim.addBuff(u, 'slow', 0.6, 0.35, h);
          if (z.n % 2 === 0) { sim.damage(h, u, dmg, MAGIC); burnP(sim, h, u); }
        }
      },
    });
  },
  // E Lángugrás: blink, exploding at both ends
  (sim, h, aim, emp) => {
    const sk = P.skills[2], dmg = sim.sv(h, sk.n.d) * emp.dmg, r = 2.0 * emp.area;
    const fx = h.x, fz = h.z;
    sim.blink(h, aim.x, aim.z);
    fireBurst(sim, h, fx, fz, r, dmg);
    fireBurst(sim, h, h.x, h.z, r, dmg);
  },
  // D Izzó kör: delayed eruption that stuns
  (sim, h, aim, emp) => {
    const sk = P.skills[3], r = sk.radius * emp.area, x = aim.x, z = aim.z;
    sim.telegraph(h, x, z, r, 0.8, 'ringTele');
    sim.later(0.8, () => {
      if (sim.winner >= 0) return;
      const dmg = sim.sv(h, sk.n.d) * emp.dmg;
      sim.fx('erupt', { x: r2(x), z: r2(z), r: r2(r) });
      for (const e of sim.enemiesIn(h.team, x, z, r)) {
        sim.damage(h, e, dmg, MAGIC);
        burnP(sim, h, e);
        if (e.kind !== K.BOSS) sim.addBuff(e, 'stun', sk.stun, 0, h);
      }
    });
  },
  // F Lángnyelv: cone of fire, double burn
  (sim, h, aim, emp) => {
    const sk = P.skills[4], d = dirTo(h, aim), range = sk.range * emp.area, cosA = Math.cos(sk.angle / 2 * Math.PI / 180);
    const dmg = sim.sv(h, sk.n.d) * emp.dmg;
    sim.fx('breath', { x: r2(h.x), z: r2(h.z), dx: r2(d.x), dz: r2(d.z), r: r2(range), a: sk.angle });
    for (const e of sim.enemiesIn(h.team, h.x, h.z, range)) {
      const ex = e.x - h.x, ez = e.z - h.z, l = Math.hypot(ex, ez) || 1;
      if ((ex * d.x + ez * d.z) / l < cosA && l > e.r + 0.8) continue;
      sim.damage(h, e, dmg, MAGIC);
      burnP(sim, h, e, 2);
    }
  },
  // R Meteor
  (sim, h, aim, emp) => {
    const sk = P.skills[5], r = sk.radius * emp.area, x = aim.x, z = aim.z, T = 1.3;
    sim.telegraph(h, x, z, r, T, 'meteorTele');
    sim.fx('meteor', { x: r2(x), z: r2(z), d: T, s: emp.area > 1 ? 1 : 0 });
    sim.later(T, () => {
      if (sim.winner >= 0) return;
      const dmg = sim.sv(h, sk.n.d) * emp.dmg, g = sim.sv(h, sk.n.g) * emp.dmg;
      sim.fx('impact', { x: r2(x), z: r2(z), r: r2(r) });
      for (const e of sim.enemiesIn(h.team, x, z, r)) {
        sim.damage(h, e, dmg, MAGIC);
        burnP(sim, h, e);
        if (e.kind !== K.BOSS) sim.addBuff(e, 'air', 0.75, 0, h);
      }
      sim.zone({
        kind: 'burnGround', src: h, x, z, r, dur: 3, every: 0.5,
        onTick: (zn) => { for (const e of sim.enemiesIn(h.team, zn.x, zn.z, zn.r)) sim.damage(h, e, g, MAGIC); },
      });
    });
  },
];
const parazsP = {
  // Túlhevülés: every 4th skill is empowered (from level 4). p.a counts casts, p.b = 1 when the next one is hot
  onCast(sim, h) {
    if (h.level < 4) return null;
    if (h.p.b === 1) {
      h.p.b = 0; h.p.a = 0;
      sim.fx('overheat', { i: h.id });
      return { dmg: 1.35, area: 1.25 };
    }
    h.p.a = (h.p.a || 0) + 1;
    if (h.p.a >= 3) { h.p.b = 1; h.p.a = 3; }
    return null;
  },
  ready(sim, h) { return h.level >= 4 && h.p.b === 1; },
};

// ============================================================
//  SÓLYOM, a Vadász
// ============================================================
const solyom = [
  // Q Átütő nyíl: pierces everyone, less damage per target
  (sim, h, aim) => {
    const sk = S.skills[0], d = dirTo(h, aim), dmg = sim.sv(h, sk.n.d);
    let n = 0;
    sim.projectile({
      kind: 'parrow', src: h, x: h.x + d.x * 0.6, z: h.z + d.z * 0.6, dx: d.x, dz: d.z, speed: sk.speed, range: sk.range, width: sk.width,
      onHit: (u) => { sim.damage(h, u, dmg * Math.max(0.55, 1 - 0.15 * n), PHYS); n++; return false; },
    });
  },
  // W Nyílzápor
  (sim, h, aim) => {
    const sk = S.skills[1], x = aim.x, z = aim.z;
    sim.telegraph(h, x, z, sk.radius, 0.5, 'rainTele');
    sim.fx('arrowRain', { x: r2(x), z: r2(z), r: sk.radius, d: 0.5 });
    sim.later(0.5, () => {
      const dmg = sim.sv(h, sk.n.d);
      for (const e of sim.enemiesIn(h.team, x, z, sk.radius)) {
        sim.damage(h, e, dmg, PHYS);
        sim.addBuff(e, 'slow', 1.5, 0.4, h);
      }
    });
  },
  // E Vetődés: roll, next attack is instant and stronger
  (sim, h, aim) => {
    const sk = S.skills[2], d = dirTo(h, aim);
    sim.dash(h, h.x + d.x * sk.range, h.z + d.z * sk.range, 16, {
      anim: 2,
      onEnd: () => { h.atkCd = 0; h.p.roll = sim.time + 3.5; },
    });
  },
  // D Medvecsapda: hidden trap, roots the first hero
  (sim, h, aim) => {
    const sk = S.skills[3], x = aim.x, z = aim.z;
    h.p.traps = (h.p.traps || []).filter((tz) => !tz.dead);
    while (h.p.traps.length >= 3) sim.endZone(h.p.traps.shift(), 0);
    const tz = sim.zone({
      kind: 'trap', src: h, x, z, r: sk.radius, dur: 40, hidden: true, arm: 0.8,
      update(zn, dt) {
        if (zn.arm > 0) { zn.arm -= dt; return; }
        for (const u of sim.units) {
          if (!u.alive || u.team === h.team || !isHeroLike(u) || !sim.targetable(u) || Math.hypot(u.x - zn.x, u.z - zn.z) > zn.r + u.r * 0.5) continue;
          sim.damage(h, u, sim.sv(h, sk.n.d), PHYS);
          if (u.alive) { sim.addBuff(u, 'root', 1.6, 0, h); sim.addBuff(u, 'reveal', 3, 0, h); }
          sim.endZone(zn, 1);
          return;
        }
      },
    });
    h.p.traps.push(tz);
  },
  // F Sólyomroham: the falcon marks a target
  (sim, h, aim) => {
    const sk = S.skills[4], t = sim.get(aim.t);
    if (!t) return;
    sim.projectile({
      kind: 'falcon', src: h, x: h.x, z: h.z, homing: t, speed: 18,
      onHit: (u) => {
        sim.damage(h, u, sim.sv(h, sk.n.d), PHYS);
        sim.addBuff(u, 'markS', 4, 0, h);
        return true;
      },
    });
  },
  // R Viharnyíl: across the map, stronger the farther it flies
  (sim, h, aim) => {
    const sk = S.skills[5], d = dirTo(h, aim), dmg = sim.sv(h, sk.n.d);
    sim.projectile({
      kind: 'storm', src: h, x: h.x + d.x * 0.6, z: h.z + d.z * 0.6, dx: d.x, dz: d.z, speed: sk.speed, range: sk.range, width: sk.width,
      onHit: (u, p) => {
        if (isHeroLike(u)) {
          const f = Math.min(1, p.traveled / 25);
          sim.damage(h, u, dmg * (1 + 0.5 * f), PHYS);
          sim.addBuff(u, 'stun', 1 + f, 0, h);
          sim.fx('stormHit', { x: r2(u.x), z: r2(u.z) });
          return true;
        }
        sim.damage(h, u, dmg * 0.5, PHYS);
        return false;
      },
    });
  },
];
const solyomP = {
  // Feszített húr: every 4th attack crits and pierces; Vetődés empowers the next one
  onAttack(sim, h, tgt, ctx) {
    h.p.a = (h.p.a || 0) + 1;
    if (h.p.a >= 4) { h.p.a = 0; ctx.crit = true; ctx.mult = 1.75; ctx.pierce = true; }
    if (h.p.roll && sim.time < h.p.roll) { ctx.bonus += sim.sv(h, S.skills[2].n.d); ctx.roll = true; h.p.roll = 0; }
  },
  onBasicHit(sim, h, tgt, ctx) {
    if (!ctx.pierce) return;
    const dx = tgt.x - h.x, dz = tgt.z - h.z, l = Math.hypot(dx, dz) || 1;
    let best = null, bd = 4.5;
    for (const e of sim.enemiesIn(h.team, tgt.x, tgt.z, 4.5)) {
      if (e === tgt) continue;
      const ex = e.x - tgt.x, ez = e.z - tgt.z, el = Math.hypot(ex, ez) || 1;
      if ((ex * dx + ez * dz) / (el * l) < 0.6) continue;
      if (el < bd) { bd = el; best = e; }
    }
    if (!best) return;
    const b = best;
    sim.fx('pierce', { x: r2(tgt.x), z: r2(tgt.z), x2: r2(b.x), z2: r2(b.z) });
    sim.later(0, () => { if (b.alive) sim.damage(h, b, h.ad * 1.75 * 0.5, PHYS); });
  },
  // Lendület (level 4): after a skill, faster attacks and a short haste
  afterCast(sim, h) {
    if (h.level < 4) return;
    sim.addBuff(h, 'momentum', 4, 0, h, { n: 2 });
    sim.addBuff(h, 'haste', 1.5, 0.2, h);
  },
  ready(sim, h) { return h.p.a === 3; },
};

// ============================================================
//  ÁRNY, az Orgyilkos
// ============================================================
const markA = (sim, h, e) => { if (e.alive && e.kind !== K.TOWER && e.kind !== K.NEXUS) sim.addBuff(e, 'markA', 5, 0, h); };
const arny = [
  // Q Pengedobás
  (sim, h, aim) => {
    const sk = A.skills[0], d = dirTo(h, aim), dmg = sim.sv(h, sk.n.d);
    sim.projectile({
      kind: 'dagger', src: h, x: h.x + d.x * 0.6, z: h.z + d.z * 0.6, dx: d.x, dz: d.z, speed: sk.speed, range: sk.range, width: sk.width,
      onHit: (u) => {
        sim.damage(h, u, dmg, PHYS);
        sim.addBuff(u, 'slow', 1.5, 0.3, h);
        markA(sim, h, u);
        return true;
      },
    });
  },
  // W Füstbomba: invisible and faster while inside the smoke
  (sim, h) => {
    const sk = A.skills[1];
    h.revealT = 0;
    sim.addBuff(h, 'stealth', 0.4, 0, h);
    sim.zone({
      kind: 'smoke', src: h, x: h.x, z: h.z, r: sk.radius, dur: 3.5,
      update(zn) {
        if (!h.alive || Math.hypot(h.x - zn.x, h.z - zn.z) > zn.r) return;
        sim.addBuff(h, 'stealth', 0.4, 0, h);
        sim.addBuff(h, 'haste', 0.4, 0.25, h);
      },
    });
  },
  // E Árnylépés: step behind any unit
  (sim, h, aim) => {
    const sk = A.skills[2], t = sim.get(aim.t);
    if (!t) return;
    let dx = t.x - h.x, dz = t.z - h.z;
    const l = Math.hypot(dx, dz) || 1;
    dx /= l; dz /= l;
    sim.blink(h, t.x + dx * (t.r + h.r + 0.25), t.z + dz * (t.r + h.r + 0.25));
    sim.face(h, t.x, t.z);
    if (t.team !== h.team) {
      sim.damage(h, t, sim.sv(h, sk.n.d), PHYS);
      markA(sim, h, t);
      if (t.alive && t.kind !== K.BOSS) { h.target = t.id; h.cmd = { type: 'attack', t: t.id }; }
    }
  },
  // D Pengevihar: spin, mark everyone, heal from heroes
  (sim, h) => {
    const sk = A.skills[3], dmg = sim.sv(h, sk.n.d);
    sim.fx('blades', { i: h.id, r: sk.radius });
    let heal = 0;
    for (const e of sim.enemiesIn(h.team, h.x, h.z, sk.radius)) {
      const a = sim.damage(h, e, dmg, PHYS);
      heal += a * (e.kind === K.HERO ? 0.25 : 0.1);
      markA(sim, h, e);
    }
    if (heal > 0) { sim.heal(h, heal); sim.fx('heal', { i: h.id }); }
  },
  // F Árnykép: a decoy runs on, she vanishes
  (sim, h, aim) => {
    const sk = A.skills[4], d = dirTo(h, aim);
    const c = sim.add(sim.unit(K.CLONE, h.team, h.x, h.z, h.r));
    Object.assign(c, {
      owner: h.id, sub: h.sub, hp: h.hp, maxHp: h.maxHp, level: h.level, ms: h.ms * 1.05, rot: Math.atan2(d.x, d.z),
      goal: sim.landing(h, h.x + d.x * sk.range, h.z + d.z * sk.range), life: 4, armor: 0, mr: 0, atkCd: 0.5,
    });
    h.revealT = 0;
    sim.addBuff(h, 'stealth', 1.5, 0, h);
    sim.addBuff(h, 'haste', 1.5, 0.4, h);
    sim.fx('clone', { i: h.id, c: c.id });
  },
  // R Holdtánc: five strikes around a hero, untargetable meanwhile
  (sim, h, aim) => {
    const sk = A.skills[5], t = sim.get(aim.t);
    if (!t) return;
    if (h.special) h.special.end?.(true);
    const base = Math.atan2(h.x - t.x, h.z - t.z);
    const sp = {
      kind: 'dance', block: true, untarget: true, ghost: true, n: 0, acc: 0.05,
      update(dt) {
        this.acc -= dt;
        if (this.acc > 0) return;
        this.acc = 0.25;
        if (!t.alive || !sim.targetable(t) && t.kind !== K.CLONE) { this.finish(); return; }
        const last = this.n === 4;
        const a = base + this.n * 2.51 + (last ? Math.PI - this.n * 2.51 : 0);
        const rr = t.r + h.r + 0.5;
        h.x = h.px = t.x + Math.sin(a) * rr; h.z = h.pz = t.z + Math.cos(a) * rr;
        sim.face(h, t.x, t.z);
        let dmg = sim.sv(h, sk.n.d);
        if (last) dmg += (t.maxHp - t.hp) * 0.15;
        sim.fx('moonStrike', { i: t.id, x: r2(h.x), z: r2(h.z), n: this.n });
        sim.damage(h, t, dmg, PHYS, { force: true });
        this.n++;
        if (last || !t.alive) this.finish();
      },
      finish() {
        if (h.special !== sp) return;
        h.special = null;
        if (t.alive) { h.target = t.id; h.cmd = { type: 'attack', t: t.id }; }
      },
      end() { if (h.special === sp) h.special = null; },
    };
    h.special = sp;
  },
];
const arnyP = {
  // Árnyjel: the next basic attack on a marked enemy detonates the mark
  onBasicHit(sim, h, tgt) {
    const m = tgt.buffs.find((b) => b.k === 'markA' && b.src === h.id);
    if (!m) return;
    m.t = 0;
    const d = sim.sv(h, A.passives[0].n.d);
    sim.fx('markPop', { i: tgt.id });
    sim.later(0, () => { if (tgt.alive) sim.damage(h, tgt, d, MAGIC); });
  },
  // Kivégzés (level 4): a hero takedown resets her skills
  onHeroDeath(sim, h, victim, recent) {
    if (h.level < 4) return;
    const t = recent.get(h.id);
    if (t === undefined || sim.time - t > 3) return;
    for (let i = 0; i < 5; i++) h.cds[i] = 0;
    sim.addBuff(h, 'haste', 2, 0.3, h);
    sim.fx('reset', { i: h.id });
  },
};

export const SKILLS = { granit, parazs, solyom, arny };
export const PASSIVES = { granit: granitP, parazs: parazsP, solyom: solyomP, arny: arnyP };
