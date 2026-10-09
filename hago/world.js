// The picture of the match that the screen draws, rebuilt from snapshots (sim.snapshot()).
// The host feeds it every tick straight from its own simulation; the other players get the same snapshots
// over the network. Positions are interpolated a little behind the newest snapshot, and the events of a
// snapshot (hits, casts, projectiles...) are released when the interpolation reaches that moment.

import { TICK, HEROES, K } from './data.js';

const lerpAngle = (a, b, k) => { let d = b - a; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return a + d * k; };

export class World {
  // cfg: { slots: [{ team, hero, name, bot, diff }] }
  constructor(cfg, delay) {
    this.cfg = cfg;
    this.delay = delay;           // seconds behind the newest snapshot
    this.snaps = [];
    this.queue = [];              // [{ t, e }]
    this.off = null;              // sim time - local time
    this.ents = new Map();        // id -> render entity
    this.heroes = new Map();      // id -> hero info (newest)
    this.heroList = [];
    this.time = 0;                // sim time being drawn
    this.latest = 0;
    this.kills = [0, 0];
    this.bossT = 0;
    this.winner = -1;
  }
  ingest(snap, events, now) {
    const off = snap.t - now;
    if (this.off === null || off > this.off) this.off = off;
    else this.off += (off - this.off) * 0.01;
    const m = new Map();
    for (const a of snap.e) m.set(a[0], a);
    this.snaps.push({ t: snap.t, m });
    if (this.snaps.length > 20) this.snaps.shift();
    if (events && events.length) for (const e of events) this.queue.push({ t: snap.t, e });
    this.latest = snap.t;
    this.kills = snap.kc; this.bossT = snap.bt; this.winner = snap.w;
    // hero details: the newest, not delayed (cooldowns, gold)
    snap.h.forEach((a, i) => {
      let h = this.heroes.get(a[0]);
      if (!h) {
        const sl = this.cfg.slots[i];
        h = { id: a[0], slot: i, team: sl.team, hero: sl.hero, def: HEROES[sl.hero], name: sl.name, bot: !!sl.bot };
        this.heroes.set(a[0], h);
        this.heroList[i] = h;
      }
      Object.assign(h, {
        level: a[1], xp: a[2], need: a[3], gold: a[4], k: a[5], d: a[6], a: a[7], cs: a[8], items: a[9], potions: a[10],
        cds: a[11].map((c) => c / 10), respawn: a[12] / 10, recall: a[13] / 10, pa: a[14], pb: a[15], dmg: a[16],
        ad: a[17], ap: a[18], armor: a[19], mr: a[20], as: a[21], ms: a[22], cdr: a[23], casting: a[24],
      });
    });
  }
  // advance the drawn time to `now`; returns the events that became due
  frame(now) {
    if (this.off === null || !this.snaps.length) return [];
    const newest = this.snaps[this.snaps.length - 1];
    // the clock relation drifted (a paused match, a sleeping tab): re-anchor on the newest snapshot
    if (now + this.off - this.delay > newest.t + 0.3) this.off = newest.t - now + this.delay * 0.5;
    let t = now + this.off - this.delay;
    if (t > newest.t + 0.1) t = newest.t + 0.1;
    if (t < this.time) t = this.time;            // never go back
    this.time = t;
    // pick the pair around t
    let a = this.snaps[0], b = newest;
    for (let i = this.snaps.length - 1; i >= 0; i--) {
      if (this.snaps[i].t <= t) { a = this.snaps[i]; b = this.snaps[i + 1] || this.snaps[i]; break; }
    }
    const span = b.t - a.t, k = span > 1e-6 ? Math.min(1, Math.max(0, (t - a.t) / span)) : 1;
    const seen = new Set();
    for (const [id, nb] of b.m) {
      const na = a.m.get(id) || nb;
      let e = this.ents.get(id);
      if (!e) { e = { id, born: t }; this.ents.set(id, e); }
      seen.add(id);
      // jumps (blink, recall, respawn) snap instead of sliding across the map
      const jump = Math.hypot(nb[4] - na[4], nb[5] - na[5]) / 100 > 6;
      const kk = jump ? 1 : k;
      e.kind = nb[1]; e.team = nb[2]; e.sub = nb[3];
      e.x = (na[4] + (nb[4] - na[4]) * kk) / 100;
      e.z = (na[5] + (nb[5] - na[5]) * kk) / 100;
      e.rot = lerpAngle(na[6] / 100, nb[6] / 100, kk);
      const src = k < 0.5 ? na : nb;
      e.hp = na[7] + (nb[7] - na[7]) * k; e.maxHp = nb[8];
      e.flags = src[9]; e.shield = src[10]; e.vis = src[11]; e.alive = !!src[12]; e.moving = !!src[13]; e.extra = src[14];
      if (e.kind === K.HERO) e.info = this.heroes.get(id);
      if (e.kind === K.CLONE) e.info = this.heroes.get(e.extra);
    }
    for (const id of this.ents.keys()) if (!seen.has(id)) this.ents.delete(id);
    // due events
    const out = [];
    while (this.queue.length && this.queue[0].t <= t + 1e-6) out.push(this.queue.shift().e);
    // drop old snapshots
    while (this.snaps.length > 3 && this.snaps[1].t < t - 0.5) this.snaps.shift();
    return out;
  }
  get(id) { return this.ents.get(id) || null; }
  static hostDelay() { return TICK * 1.05; }
}
