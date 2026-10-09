import { HEROES, ITEMS, TEAMS, SLOT_KEYS, UNLOCK, P2_LEVEL, K, F, val, POTION, LANE, BOSS, STAT_NAMES } from './data.js';
import { sdf, PIT, WORLD } from './map.js';
import { groundHeight } from './map.js';
import { icon } from './icons.js';

// The HUD: DOM panels (ability bar, hero frames, shop, scoreboard, killfeed, announcements) and a 2D canvas
// over the 3D view for the things that follow units (health bars, damage numbers, comic sound words).

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const fmtT = (s) => { s = Math.max(0, Math.floor(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const WORD_FONT = '"Bangers", "Impact", system-ui, sans-serif';

export class HUD {
  constructor() {
    this.cv = $('overlay');
    this.g = this.cv.getContext('2d');
    this.nums = [];
    this.words = [];
    this.feed = [];
    this.anns = [];
    this.cache = {};
    this.portraits = {};
    this.onCmd = null;          // (cmd) => void
    this.onMap = null;          // (x, z, button) => void
    this.shopOpen = false;
    this.tip = $('tip');
    this._p = { x: 0, y: 0, z: 0 };
  }
  setPortraits(p) { this.portraits = p; }
  portrait(heroIdx, team) { return this.portraits[HEROES[heroIdx].id + team] || ''; }

  // a new match
  start(world, view, me, myTeam) {
    const fresh = this.world !== world;
    this.world = world; this.view = view; this.me = me; this.myTeam = myTeam;
    this.cache = {};
    this.built = false;
    if (!fresh) return;     // same match, my hero just became known (network client)
    this.nums = []; this.words = []; this.feed = []; this.anns = []; this.annT = 0;
    $('killfeed').innerHTML = '';
    $('announce').innerHTML = '';
    $('announce').className = '';
    this.closeShop();
    // the first few matches start with a short how-to
    let seen = 0;
    try { seen = +(localStorage.getItem('hago.tips') || 0); localStorage.setItem('hago.tips', String(seen + 1)); } catch { /* private mode */ }
    $('tips').hidden = seen >= 3;
    $('tipsClose').onclick = () => { $('tips').hidden = true; };
    clearTimeout(this.tipsT);
    this.tipsT = setTimeout(() => { $('tips').hidden = true; }, 45000);
  }
  myInfo() { return this.world.heroes.get(this.me); }

  // build the parts that depend on my hero once the first snapshot is in
  build() {
    const h = this.myInfo();
    if (!h) return false;
    const def = h.def;
    this.def = def;
    $('myPort').src = this.portrait(h.hero, h.team);
    $('bar').style.setProperty('--hc', def.css);
    // passives and skills
    def.passives.forEach((p, i) => {
      const el = $('pas' + i);
      el.innerHTML = icon(p.icon, def.css) + (i === 1 ? `<span class="lock">${P2_LEVEL}</span>` : '') + '<span class="stk"></span>';
      el.onmouseenter = (ev) => this.showTip(ev, () => this.passiveTip(i));
      el.onmouseleave = () => this.hideTip();
    });
    document.querySelectorAll('#skills .sk').forEach((el) => {
      const s = +el.dataset.s, sk = def.skills[s];
      el.querySelector('.ic').innerHTML = icon(sk.icon, def.css);
      el.querySelector('.key').textContent = SLOT_KEYS[s];
      el.querySelector('.lock').textContent = UNLOCK[s];
      el.onmouseenter = (ev) => this.showTip(ev, () => this.skillTip(s));
      el.onmouseleave = () => this.hideTip();
      el.onmousedown = (ev) => { ev.preventDefault(); ev.stopPropagation(); this.onSkillClick?.(s); };
    });
    document.querySelectorAll('#inv .it').forEach((el) => {
      const i = +el.dataset.i;
      el.onmouseenter = (ev) => this.showTip(ev, () => { const id = this.myInfo()?.items[i]; return id >= 0 ? this.itemTip(ITEMS[id], true) : ''; });
      el.onmouseleave = () => this.hideTip();
      el.oncontextmenu = (ev) => { ev.preventDefault(); if (this.shopOpen) this.onCmd?.({ k: 'sell', s: i }); };
    });
    $('potSlot').onmouseenter = (ev) => this.showTip(ev, () => `<h4>Gyógyital <em>(1)</em></h4><p>${POTION.dur} mp alatt ${POTION.heal} életerőt tölt vissza. Legfeljebb ${POTION.max} lehet nálad. Ár: ${POTION.cost}</p>`);
    $('potSlot').onmouseleave = () => this.hideTip();
    $('potSlot').onclick = () => this.onCmd?.({ k: 'pot' });
    // hero frames: allies first, then enemies
    const list = [...this.world.heroList].sort((a, b) => (a.team === this.myTeam ? 0 : 1) - (b.team === this.myTeam ? 0 : 1));
    $('frames').innerHTML = list.map((x) => `<div class="fr ${x.team === this.myTeam ? 'ally' : 'enemy'}${x.id === this.me ? ' me' : ''}" data-id="${x.id}" style="--tc:${TEAMS[x.team].css}">
      <div class="fp"><img src="${this.portrait(x.hero, x.team)}" alt=""><b class="lv">1</b><span class="rs"></span></div>
      <div class="fi"><span class="fn">${esc(x.name)}</span><div class="fh"><i></i></div></div><span class="ult" title="Végső képesség">R</span></div>`).join('');
    this.frameEls = new Map();
    for (const el of document.querySelectorAll('#frames .fr')) this.frameEls.set(+el.dataset.id, el);
    this.buildShop();
    this.buildMinimap();
    this.built = true;
    return true;
  }

  // ============================================================
  //  Per frame
  // ============================================================
  frame(dt) {
    if (!this.built && !this.build()) return;
    this.drawOverlay(dt);
    this.updateBar();
    this.updateFrames();
    this.updateTop();
    this.drawMinimap();
    this.updateFeed(dt);
    if (this.shopOpen) this.updateShop();
    if (this.tipFn && this.tip.classList.contains('on')) { const html = this.tipFn(); if (html !== this.tipHtml) { this.tipHtml = html; this.tip.innerHTML = html; } }
  }
  set(key, el, prop, v) {
    if (this.cache[key] === v) return;
    this.cache[key] = v;
    if (prop === 'text') el.textContent = v;
    else if (prop === 'html') el.innerHTML = v;
    else if (prop === 'w') el.style.width = v;
    else if (prop[0] === '-') el.style.setProperty(prop, v);
    else if (prop === 'class') el.className = v;
  }
  updateBar() {
    const h = this.myInfo(), e = this.world.get(this.me);
    if (!h || !e) return;
    const def = h.def;
    this.set('lvl', $('myLvl'), 'text', String(h.level));
    this.set('xp', $('xpFill'), 'w', h.need ? `${clamp(h.xp / h.need, 0, 1) * 100}%` : '100%');
    const hp = Math.max(0, Math.round(e.hp)), mx = Math.round(e.maxHp), sh = Math.round(e.shield || 0);
    const tot = Math.max(mx, hp + sh);
    this.set('hpf', $('hpFill'), 'w', `${(hp / tot) * 100}%`);
    this.set('shf', $('shFill'), 'w', `${(sh / tot) * 100}%`);
    this.set('hpt', $('hpTxt'), 'text', sh ? `${hp} / ${mx}  (+${sh})` : `${hp} / ${mx}`);
    this.set('gold', $('gold'), 'text', String(h.gold));
    // the shop button nags when we are home and can afford the next recommended item
    const fx = h.team === 0 ? -LANE.fountainX : LANE.fountainX;
    const home = !e.alive || Math.hypot(e.x - fx, e.z) <= LANE.baseR;
    const next = def.build.map((id) => ITEMS.findIndex((it) => it.id === id)).find((i) => !h.items.includes(i));
    this.set('pulse', $('shopBtn'), 'class', home && next !== undefined && h.items.includes(-1) && h.gold >= ITEMS[next].cost && !this.shopOpen ? 'pulse' : '');
    this.set('dead', $('deathOverlay'), 'class', e.alive ? '' : 'on');
    if (!e.alive) this.set('rs', $('respawnT'), 'text', String(Math.ceil(h.respawn)));
    $('bar').classList.toggle('dead', !e.alive);
    document.body.classList.toggle('dead', !e.alive);
    // skills
    const els = this.skillEls ||= [...document.querySelectorAll('#skills .sk')];
    els.forEach((el) => {
      const s = +el.dataset.s, sk = def.skills[s];
      const locked = h.level < UNLOCK[s], cd = h.cds[s], max = sk.cd * (1 - (h.cdr || 0) / 100);
      const silenced = (e.flags & (F.SILENCE | F.STUN | F.AIR)) !== 0;
      const st = locked ? 'sk locked' : cd > 0.05 ? 'sk cool' : silenced ? 'sk cool' : 'sk ready';
      this.set('sk' + s, el, 'class', st + (this.aiming === s ? ' aim' : '') + (s === 5 ? ' ult' : ''));
      this.set('skp' + s, el, '--p', locked ? '100%' : `${clamp(cd / max, 0, 1) * 100}%`);
      this.set('skt' + s, el.querySelector('.cdt'), 'text', !locked && cd > 0.05 ? (cd < 1 ? cd.toFixed(1) : String(Math.ceil(cd))) : '');
    });
    // passives: locked second one, stacks
    const p2 = $('pas1');
    this.set('p2', p2, 'class', h.level >= P2_LEVEL ? 'pas' : 'pas locked');
    const stk = (e.flags & F.READY) ? '!' : def.id === 'parazs' && h.level >= P2_LEVEL ? String(h.pa) : def.id === 'solyom' ? String(h.pa) : def.id === 'granit' && h.level >= P2_LEVEL ? String(h.pa) : '';
    this.set('stk', p2.querySelector('.stk') || $('pas0').querySelector('.stk'), 'text', stk);
    $('pas1').classList.toggle('hot', (e.flags & F.READY) !== 0);
    // items
    const its = this.itemEls ||= [...document.querySelectorAll('#inv .it')];
    its.forEach((el, i) => {
      const id = h.items[i];
      this.set('it' + i, el, 'html', id >= 0 ? icon(ITEMS[id].icon, ITEMS[id].adv ? '#c9902a' : '#6a7a92', { square: true }) : '');
    });
    this.set('pot', $('potSlot'), 'html', icon('potion', h.potions ? '#c8342a' : '#4a4a52', { square: true }) + `<b>${h.potions}</b>`);
    // stats
    this.set('stats', $('stats'), 'html', `<span>VE <b>${h.ad}</b></span><span>VA <b>${h.ap}</b></span><span>PÁNCÉL <b>${h.armor}</b></span><span>MÁGIAV. <b>${h.mr}</b></span><span>TÁMADÁS <b>${h.as}</b>/mp</span><span>FUTÁS <b>${h.ms}</b></span>`);
  }
  updateFrames() {
    for (const [id, el] of this.frameEls) {
      const h = this.world.heroes.get(id), e = this.world.get(id);
      if (!h || !e) continue;
      el.querySelector('.lv').textContent = h.level;
      el.querySelector('.fh i').style.width = `${clamp(e.hp / e.maxHp, 0, 1) * 100}%`;
      el.classList.toggle('dead', !e.alive);
      el.querySelector('.rs').textContent = e.alive ? '' : Math.ceil(h.respawn);
      el.querySelector('.ult').classList.toggle('on', h.level >= UNLOCK[5] && h.cds[5] <= 0);
    }
  }
  updateTop() {
    const w = this.world, t = w.time;
    this.set('k0', $('kills0'), 'text', String(w.kills[0]));
    this.set('k1', $('kills1'), 'text', String(w.kills[1]));
    this.set('clock', $('clock'), 'text', fmtT(t));
    const b = w.bossT < 0 ? 'Az Őr a szurdokban vár' : `Az Őr ${fmtT(w.bossT)} múlva`;
    this.set('boss', $('bossInfo'), 'text', b);
    this.set('bossc', $('bossInfo'), 'class', w.bossT < 0 ? 'up' : '');
  }

  // ============================================================
  //  The overlay canvas: bars, numbers, words
  // ============================================================
  resize(w, h, dpr) {
    this.cv.width = Math.floor(w * dpr); this.cv.height = Math.floor(h * dpr);
    this.cv.style.width = w + 'px'; this.cv.style.height = h + 'px';
    this.dpr = dpr; this.w = w; this.h = h;
  }
  drawOverlay(dt) {
    const g = this.g, v = this.view, p = this._p;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.w, this.h);
    const sc = clamp(27 / v.cam.dist, 0.75, 1.3);
    // health bars
    for (const vis of v.vis.values()) {
      const e = vis.e;
      if (!e || !e.alive || !vis.root.visible || vis.alpha < 0.3) continue;
      v.project(e.x, v.headPos(vis), e.z, p);
      if (p.z > 1 || p.x < -100 || p.x > this.w + 100 || p.y < -60 || p.y > this.h + 60) continue;
      if (e.kind === K.HERO || e.kind === K.CLONE) this.heroBar(g, e, p.x, p.y, sc);
      else if (e.kind === K.MINION) this.bar(g, p.x, p.y, 44 * sc, 5, e, this.teamCol(e.team, false));
      else if (e.kind === K.TOWER || e.kind === K.NEXUS) { if (e.hp < e.maxHp || e.kind === K.TOWER) this.bar(g, p.x, p.y - 4, 110 * sc, 9, e, this.teamCol(e.team, false), e.extra === 1); }
      else if (e.kind === K.BOSS) { this.bar(g, p.x, p.y, 140 * sc, 11, e, '#ffcf3a'); this.label(g, BOSS.name, p.x, p.y - 12, 13, '#ffe9a8'); }
    }
    // recall / cast bar for me
    const me = this.world.get(this.me), mi = this.myInfo();
    if (me && mi && me.alive && (me.flags & F.RECALL) && mi.recall > 0) {
      const vis = v.vis.get(this.me);
      if (vis) {
        v.project(me.x, groundHeight(me.x, me.z), me.z, p);
        const full = this.recallFull || 4, k = 1 - mi.recall / full;
        g.fillStyle = 'rgba(10,8,6,.8)'; g.fillRect(p.x - 60, p.y + 26, 120, 10);
        g.fillStyle = '#7ad0ff'; g.fillRect(p.x - 58, p.y + 28, 116 * clamp(k, 0, 1), 6);
        this.label(g, 'VISSZATÉRÉS', p.x, p.y + 52, 12, '#cfe8ff');
      }
    }
    // floating numbers
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
    for (const n of this.nums) {
      n.t += dt;
      v.project(n.x, n.y, n.z, p);
      const k = n.t / n.life, y = p.y - n.t * 46 - (n.t < 0.12 ? (0.12 - n.t) * -120 : 0);
      const s = n.size * (n.t < 0.1 ? 1 + (0.1 - n.t) * 5 : 1);
      g.globalAlpha = k > 0.7 ? (1 - k) / 0.3 : 1;
      g.font = `${Math.round(s)}px ${WORD_FONT}`;
      g.lineWidth = Math.max(3, s * 0.16); g.strokeStyle = '#140c08';
      g.strokeText(n.text, p.x + n.dx, y); g.fillStyle = n.col; g.fillText(n.text, p.x + n.dx, y);
    }
    g.globalAlpha = 1;
    this.nums = this.nums.filter((n) => n.t < n.life);
    // comic words with a jagged burst behind
    for (const w of this.words) {
      w.t += dt;
      v.project(w.x, w.y, w.z, p);
      const k = w.t / w.life, pop = w.t < 0.12 ? 0.6 + (w.t / 0.12) * 0.55 : w.t < 0.22 ? 1.15 - (w.t - 0.12) * 1.5 : 1;
      const s = 34 * w.size * pop * sc;
      g.save();
      g.globalAlpha = k > 0.75 ? (1 - k) / 0.25 : 1;
      g.translate(p.x, p.y - w.t * 14);
      g.rotate(w.rot);
      this.burstShape(g, s * 1.9, s * 1.05, w.seed);
      g.fillStyle = '#fff6d0'; g.fill(); g.lineWidth = 3; g.strokeStyle = '#140c08'; g.stroke();
      g.font = `${Math.round(s)}px ${WORD_FONT}`;
      g.lineWidth = s * 0.2; g.strokeStyle = '#140c08';
      g.strokeText(w.text, 0, 2); g.fillStyle = w.col; g.fillText(w.text, 0, 2);
      g.restore();
    }
    this.words = this.words.filter((w) => w.t < w.life);
  }
  burstShape(g, rx, ry, seed) {
    g.beginPath();
    const n = 14;
    for (let i = 0; i < n * 2; i++) {
      const a = (i / (n * 2)) * Math.PI * 2;
      const r = i % 2 ? 0.72 + ((Math.sin(seed + i * 7.3) + 1) * 0.06) : 1 + ((Math.sin(seed * 3 + i) + 1) * 0.08);
      const x = Math.cos(a) * rx * r, y = Math.sin(a) * ry * r;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.closePath();
  }
  teamCol(team, me) {
    if (me) return '#9cff5a';
    if (team === this.myTeam) return '#4a9cff';
    return team === 2 ? '#ffcf3a' : '#ff4a3a';
  }
  bar(g, x, y, w, h, e, col, shieldMark) {
    const k = clamp(e.hp / e.maxHp, 0, 1);
    g.fillStyle = 'rgba(12,8,6,.85)';
    g.fillRect(x - w / 2 - 2, y - h / 2 - 2, w + 4, h + 4);
    g.fillStyle = col;
    g.fillRect(x - w / 2, y - h / 2, w * k, h);
    if (shieldMark) { g.strokeStyle = '#ffe9a8'; g.lineWidth = 1.5; g.strokeRect(x - w / 2 - 2, y - h / 2 - 2, w + 4, h + 4); }
  }
  heroBar(g, e, x, y, sc) {
    const info = e.info;
    const me = e.id === this.me;
    const w = 96 * sc, h = 11, k = clamp(e.hp / e.maxHp, 0, 1);
    const sh = e.shield || 0, tot = Math.max(e.maxHp, e.hp + sh);
    const x0 = x - w / 2 + 10;
    g.fillStyle = 'rgba(12,8,6,.88)';
    g.fillRect(x0 - 2 - 20, y - h / 2 - 2, w + 24, h + 4);
    g.fillStyle = this.teamCol(e.team, me);
    g.fillRect(x0, y - h / 2, w * (e.hp / tot), h);
    if (sh > 0) { g.fillStyle = '#f2f6ff'; g.fillRect(x0 + w * (e.hp / tot), y - h / 2, w * (sh / tot), h); }
    // a tick every 100 hp
    g.fillStyle = 'rgba(12,8,6,.55)';
    const step = w * 100 / tot;
    if (step > 3) for (let t = step; t < w * k; t += step) g.fillRect(x0 + t, y - h / 2, 1, h * 0.6);
    // level box
    g.fillStyle = '#2a201a'; g.fillRect(x0 - 20, y - h / 2 - 1, 18, h + 2);
    g.font = `13px ${WORD_FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#ffe9a8'; g.fillText(String(info ? info.level : 1), x0 - 11, y + 1);
    if (info) this.label(g, info.name, x, y - 15, 13, me ? '#d8ffb8' : '#fff');
    // stun / root / silence tags
    const f = e.flags;
    const tag = f & F.STUN ? 'KÁBULT' : f & F.AIR ? 'LEVEGŐBEN' : f & F.ROOT ? 'GYÖKEREZETT' : f & F.TAUNT ? 'PROVOKÁLVA' : f & F.SILENCE ? 'NÉMA' : '';
    if (tag) this.label(g, tag, x, y + 15, 11, '#ffd34a');
  }
  label(g, text, x, y, size, col) {
    g.font = `600 ${size}px "Barlow Condensed", system-ui, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 3; g.strokeStyle = 'rgba(12,8,6,.9)'; g.lineJoin = 'round';
    g.strokeText(text, x, y); g.fillStyle = col; g.fillText(text, x, y);
  }
  // damage numbers: what I deal and what I take
  damage(e, u, me, myTeam) {
    const mine = e.s === me, onMe = e.i === me;
    if (!mine && !onMe) return;
    const y = (this.view.vis.get(u.id) ? this.view.headPos(this.view.vis.get(u.id)) : 2) - 0.2;
    const col = onMe ? '#ff5a4a' : e.ty === 1 ? '#a88cff' : e.ty === 2 ? '#ffffff' : '#ffb347';
    this.nums.push({ text: (onMe ? '-' : '') + e.a + (e.c ? '!' : ''), x: u.x, y, z: u.z, t: 0, life: 0.9, col, size: e.c ? 30 : onMe ? 20 : 22, dx: (Math.random() - 0.5) * 24 });
  }
  gold(a, x, y, z) { this.nums.push({ text: `+${a}`, x, y, z, t: 0, life: 1.1, col: '#ffd34a', size: 20, dx: 0 }); }
  word(text, x, y, z, col, size = 1) {
    if (this.words.length > 8) this.words.shift();
    this.words.push({ text, x, y, z, col: '#' + col.toString(16).padStart(6, '0'), size, t: 0, life: 0.95, rot: (Math.random() - 0.5) * 0.35, seed: Math.random() * 100 });
  }

  // ============================================================
  //  Events: kills, announcements, failed commands
  // ============================================================
  handle(e, snd) {
    const W = this.world;
    switch (e.k) {
      case 'kill': {
        const v = W.heroes.get(e.v), by = W.heroes.get(e.by);
        this.killFeed(by, v, e);
        const meDied = e.v === this.me, iKilled = e.by === this.me, mine = v && v.team === this.myTeam;
        if (e.fb) this.announce('ELSŐ VÉR!', by ? `${by.name} ontotta az első vért` : '', mine ? 'bad' : 'good');
        else if (e.ace) this.announce('ÁSZ!', mine ? 'Az egész csapatotok elesett' : 'Az ellenfél minden hőse elesett', mine ? 'bad' : 'good');
        else if (e.m >= 3) this.announce('TRIPLA GYILKOSSÁG!', by ? by.name : '', mine ? 'bad' : 'good');
        else if (e.m === 2) this.announce('DUPLA GYILKOSSÁG!', by ? by.name : '', mine ? 'bad' : 'good');
        else if (e.sd) this.announce('LEÁLLÍTVA!', by ? `${by.name} megállította ${v.name} sorozatát` : '', mine ? 'bad' : 'good');
        else if (e.sp === 3 && by) this.announce('TOMBOL!', `${by.name} 3 hőst ölt halál nélkül`, by.team === this.myTeam ? 'good' : 'bad');
        else if (e.sp === 5 && by) this.announce('MEGÁLLÍTHATATLAN!', by.name, by.team === this.myTeam ? 'good' : 'bad');
        else if (meDied) this.announce('ELESTÉL', by ? `${by.name} győzött le` : '', 'bad', 1.6);
        else if (iKilled) this.announce('LEGYŐZTED!', v ? v.name : '', 'good', 1.6);
        if (iKilled) snd.play('kill', 1); else if (mine) snd.play('allyDie', 0.8); else if (by && by.team === this.myTeam) snd.play('kill', 0.6);
        if (meDied) snd.play('heroDie', 1);
        break;
      }
      case 'ann': {
        if (e.a === 'tower') { const ours = e.tm === this.myTeam; this.announce(ours ? 'ELESETT EGY TORNYOTOK' : 'TORONY LEDŐLT!', ours ? '' : 'Előre, a következőig!', ours ? 'bad' : 'good'); snd.play('towerDown', 0.9); }
        else if (e.a === 'boss') { const ours = e.tm === this.myTeam; this.announce('AZ ŐR ELESETT!', e.tm < 0 ? '' : ours ? 'Tiétek az Őr áldása: +20% sebzés, erősebb minionok' : 'Az ellenfél kapta az Őr áldását', ours ? 'good' : 'bad'); snd.play('bossDie', 1); }
        else if (e.a === 'bossUp') { this.announce('MEGJELENT AZ ŐR', 'A hágó őre a szurdokban vár', 'neutral', 2.2); snd.play('bossRoar', 0.7); }
        else if (e.a === 'nexus') snd.play('nexusDown', 1);
        break;
      }
      case 'lvl': {
        if (e.i !== this.me) break;
        const i = UNLOCK.indexOf(e.l);
        if (i >= 0 && this.def) this.toast(`Új képesség: <b>${SLOT_KEYS[i]} · ${this.def.skills[i].name}</b>`);
        if (e.l === P2_LEVEL && this.def) this.toast(`Új passzív: <b>${this.def.passives[1].name}</b>`);
        break;
      }
      case 'no': {
        if (e.i !== this.me) break;
        const t = { cd: 'Még töltődik', lvl: 'Ezt a képességet még nem tudod', cc: 'Most nem tudsz varázsolni', target: 'Nincs megfelelő célpont', shop: 'Itt nem vásárolhatsz, vagy nincs elég aranyad', pot: 'Nincs gyógyitalod (vagy már iszol)' }[e.w];
        if (t) { this.toast(t, true); snd.play('error', 0.6); }
        break;
      }
      case 'buy': if (e.i === this.me) snd.play(e.it === -2 ? 'gold' : 'buy', 0.8); break;
      case 'rc': if (e.i === this.me && e.s === 1) this.recallFull = e.t; break;
      default: break;
    }
  }
  killFeed(by, v, e) {
    const el = document.createElement('div');
    el.className = 'kf' + (v && v.team === this.myTeam ? ' bad' : ' good');
    const p = (x) => (x ? `<img src="${this.portrait(x.hero, x.team)}" alt=""><span>${esc(x.name)}</span>` : '<span class="env">A pálya</span>');
    el.innerHTML = `${p(by)}<i>${e.as && e.as.length ? '+' + e.as.length : ''}⚔</i>${p(v)}`;
    $('killfeed').prepend(el);
    this.feed.push({ el, t: 0 });
    while ($('killfeed').children.length > 5) $('killfeed').lastChild.remove();
  }
  updateFeed(dt) {
    for (const f of this.feed) { f.t += dt; if (f.t > 7 && !f.gone) { f.gone = true; f.el.classList.add('out'); setTimeout(() => f.el.remove(), 400); } }
    this.feed = this.feed.filter((f) => !f.gone);
    if (this.annT > 0) { this.annT -= dt; if (this.annT <= 0) { $('announce').classList.remove('on'); this.nextAnn(); } }
  }
  announce(title, sub, kind, dur = 2.6) {
    this.anns.push({ title, sub, kind, dur });
    if (!(this.annT > 0)) this.nextAnn();
  }
  nextAnn() {
    const a = this.anns.shift();
    if (!a) return;
    const el = $('announce');
    el.className = 'on ' + a.kind;
    el.innerHTML = `<div class="ap"><b>${esc(a.title)}</b>${a.sub ? `<span>${esc(a.sub)}</span>` : ''}</div>`;
    this.annT = a.dur;
    this.snd?.play('announce', 0.5);
  }
  toast(html, bad) {
    const el = $('toast');
    el.innerHTML = html;
    el.className = 'on' + (bad ? ' bad' : '');
    clearTimeout(this.toastT);
    this.toastT = setTimeout(() => (el.className = ''), 1800);
  }

  // ============================================================
  //  Tooltips
  // ============================================================
  showTip(ev, fn) {
    this.tipFn = fn;
    this.tipHtml = fn();
    if (!this.tipHtml) return;
    this.tip.innerHTML = this.tipHtml;
    this.tip.classList.add('on');
    const r = ev.currentTarget.getBoundingClientRect();
    const tw = this.tip.offsetWidth, th = this.tip.offsetHeight;
    this.tip.style.left = clamp(r.left + r.width / 2 - tw / 2, 8, innerWidth - tw - 8) + 'px';
    this.tip.style.top = Math.max(8, r.top - th - 10) + 'px';
  }
  hideTip() { this.tipFn = null; this.tip.classList.remove('on'); }
  st() {
    const h = this.myInfo(), e = this.world.get(this.me);
    return { lvl: h ? h.level : 1, ad: h ? h.ad : 0, ap: h ? h.ap : 0, maxHp: e ? e.maxHp : 0 };
  }
  fill(desc, n) {
    const st = this.st();
    return desc.replace(/\{(\w+)\}/g, (m, k) => (n && n[k] !== undefined ? String(Math.round(val(n[k], st))) : m));
  }
  skillTip(s) {
    const h = this.myInfo();
    if (!h) return '';
    const sk = h.def.skills[s], cd = sk.cd * (1 - (h.cdr || 0) / 100);
    const kind = { line: 'Célzott lövés', circle: 'Terület', cone: 'Kúp', dash: 'Roham', blink: 'Ugrás', unit: 'Egy célpont', self: 'Azonnali', wall: 'Fal' }[sk.kind];
    const lock = h.level < UNLOCK[s] ? `<p class="lk">${UNLOCK[s]}. szinten nyílik meg</p>` : '';
    return `<h4>${esc(sk.name)} <em>(${SLOT_KEYS[s]})</em></h4><div class="meta">${kind} · ${sk.range ? `táv ${sk.range} m · ` : ''}töltés ${cd.toFixed(1)} mp</div><p>${this.fill(sk.desc, sk.n)}</p>${lock}`;
  }
  passiveTip(i) {
    const h = this.myInfo();
    if (!h) return '';
    const p = h.def.passives[i];
    const lock = i === 1 && h.level < P2_LEVEL ? `<p class="lk">${P2_LEVEL}. szinten nyílik meg</p>` : '';
    return `<h4>${esc(p.name)} <em>(passzív)</em></h4><p>${this.fill(p.desc, p.n)}</p>${lock}`;
  }
  itemTip(it, owned) {
    const stats = Object.entries(it.st).filter(([k]) => STAT_NAMES[k]).map(([k, v]) => {
      const pct = ['as', 'cdr', 'ls', 'thorns', 'apMul'].includes(k);
      return `+${pct ? Math.round(v * 100) + '%' : v} ${STAT_NAMES[k]}`;
    }).join(' · ');
    return `<h4>${esc(it.name)}</h4><div class="meta">${stats}</div>${it.tip ? `<p>${esc(it.tip)}</p>` : ''}<div class="meta">${owned ? `Eladás (jobb klikk a boltban): ${Math.floor(it.cost * 0.6)}` : `Ár: ${it.cost}`}</div>`;
  }

  // ============================================================
  //  Shop
  // ============================================================
  buildShop() {
    const card = (it, i) => `<button class="item" data-i="${i}">${icon(it.icon, it.adv ? '#c9902a' : '#6a7a92', { square: true })}<span class="nm">${esc(it.name)}</span><span class="pr">${it.cost}</span></button>`;
    const basic = ITEMS.map((it, i) => (it.adv ? '' : card(it, i))).join('');
    const adv = ITEMS.map((it, i) => (it.adv ? card(it, i) : '')).join('');
    $('shopBasic').innerHTML = basic;
    $('shopAdv').innerHTML = adv;
    for (const el of document.querySelectorAll('#shop .grid .item')) {
      const it = ITEMS[+el.dataset.i];
      el.onclick = () => this.onCmd?.({ k: 'buy', i: it.id });
      el.onmouseenter = (ev) => this.showTip(ev, () => this.itemTip(it, false));
      el.onmouseleave = () => this.hideTip();
    }
    $('shopPot').innerHTML = `${icon('potion', '#c8342a', { square: true })}<span class="nm">Gyógyital</span><span class="pr">${POTION.cost}</span>`;
    $('shopPot').onclick = () => this.onCmd?.({ k: 'buy', i: 'pot' });
    $('shopPot').onmouseenter = (ev) => this.showTip(ev, () => `<h4>Gyógyital</h4><p>${POTION.dur} mp alatt ${POTION.heal} életerőt tölt vissza. Legfeljebb ${POTION.max} lehet nálad. Inni: <b>1</b></p><div class="meta">Ár: ${POTION.cost}</div>`);
    $('shopPot').onmouseleave = () => this.hideTip();
    $('shopClose').onclick = () => this.closeShop();
  }
  toggleShop() { if (this.shopOpen) this.closeShop(); else this.openShop(); }
  openShop() { this.shopOpen = true; $('shop').hidden = false; this.updateShop(); }
  closeShop() { this.shopOpen = false; $('shop').hidden = true; this.hideTip(); }
  updateShop() {
    const h = this.myInfo(), e = this.world.get(this.me);
    if (!h || !e) return;
    const f = h.team === 0 ? -LANE.fountainX : LANE.fountainX;
    const here = !e.alive || Math.hypot(e.x - f, e.z) <= LANE.baseR;
    this.set('shopWhere', $('shopWhere'), 'text', here ? 'Vásárolhatsz.' : 'Csak a bázisodon (vagy halottan) vásárolhatsz. Nyomj B-t a visszatéréshez.');
    this.set('shopGold', $('shopGold'), 'text', String(h.gold));
    const full = !h.items.includes(-1);
    const next = h.def.build.find((id) => !h.items.includes(ITEMS.findIndex((it) => it.id === id)));
    for (const el of document.querySelectorAll('#shop .grid .item')) {
      const i = +el.dataset.i, it = ITEMS[i];
      const ok = here && h.gold >= it.cost && !full && !(it.adv && h.items.includes(i));
      el.classList.toggle('no', !ok);
      el.classList.toggle('rec', it.id === next);
    }
    $('shopPot').classList.toggle('no', !(here && h.gold >= POTION.cost && h.potions < POTION.max));
  }

  // ============================================================
  //  Minimap
  // ============================================================
  buildMinimap() {
    const c = $('minimap'), W = 300, H = 128;
    c.width = W * 2; c.height = H * 2;
    this.mm = { c, g: c.getContext('2d'), W, H, x0: -68, x1: 68, z0: -28, z1: 14 };
    // background from the walkable shape
    const bg = document.createElement('canvas');
    bg.width = W * 2; bg.height = H * 2;
    const g = bg.getContext('2d'), img = g.createImageData(bg.width, bg.height);
    const m = this.mm;
    for (let j = 0; j < bg.height; j++) for (let i = 0; i < bg.width; i++) {
      const x = m.x0 + (i / bg.width) * (m.x1 - m.x0), z = m.z0 + (j / bg.height) * (m.z1 - m.z0);
      const d = sdf(x, z), k = (j * bg.width + i) * 4;
      let r, gg, b;
      if (d < 0) { r = 196; gg = 168; b = 120; } else if (d < 0.6) { r = 40; gg = 30; b = 22; } else if (z > 0) { r = 52; gg = 70; b = 96; } else { r = 74; gg = 104; b = 56; }
      img.data[k] = r; img.data[k + 1] = gg; img.data[k + 2] = b; img.data[k + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    this.mm.bg = bg;
    const toWorld = (ev) => {
      const r = c.getBoundingClientRect();
      return { x: m.x0 + ((ev.clientX - r.left) / r.width) * (m.x1 - m.x0), z: m.z0 + ((ev.clientY - r.top) / r.height) * (m.z1 - m.z0) };
    };
    c.onmousedown = (ev) => { ev.preventDefault(); ev.stopPropagation(); const p = toWorld(ev); this.onMap?.(p.x, p.z, ev.button); this.mmDrag = ev.button === 0; };
    c.onmousemove = (ev) => { if (this.mmDrag && ev.buttons & 1) { const p = toWorld(ev); this.onMap?.(p.x, p.z, 0); } };
    c.oncontextmenu = (ev) => ev.preventDefault();
    addEventListener('mouseup', () => (this.mmDrag = false));
  }
  drawMinimap() {
    const m = this.mm;
    if (!m) return;
    const g = m.g, sx = (x) => ((x - m.x0) / (m.x1 - m.x0)) * m.c.width, sz = (z) => ((z - m.z0) / (m.z1 - m.z0)) * m.c.height;
    g.drawImage(m.bg, 0, 0);
    const W = this.world;
    for (const e of W.ents.values()) {
      const seen = e.team === this.myTeam || e.team === 2 || (e.vis & (1 << this.myTeam));
      if (!seen) continue;
      const x = sx(e.x), y = sz(e.z);
      if (e.kind === K.TOWER || e.kind === K.NEXUS) {
        const s = e.kind === K.NEXUS ? 14 : 10;
        g.fillStyle = e.alive ? (e.team === this.myTeam ? '#4a9cff' : '#ff4a3a') : '#555';
        g.strokeStyle = '#140c08'; g.lineWidth = 3;
        g.beginPath(); g.rect(x - s / 2, y - s / 2, s, s); g.fill(); g.stroke();
      } else if (e.kind === K.MINION && e.alive) {
        g.fillStyle = e.team === this.myTeam ? '#8ac4ff' : '#ff8a7a';
        g.fillRect(x - 3, y - 3, 6, 6);
      } else if (e.kind === K.BOSS && e.alive) {
        g.fillStyle = '#ffcf3a'; g.strokeStyle = '#140c08'; g.lineWidth = 3;
        g.beginPath(); g.arc(x, y, 9, 0, Math.PI * 2); g.fill(); g.stroke();
      }
    }
    for (const e of W.ents.values()) {
      if ((e.kind !== K.HERO && e.kind !== K.CLONE) || !e.alive) continue;
      const seen = e.team === this.myTeam || (e.vis & (1 << this.myTeam));
      if (!seen) continue;
      const x = sx(e.x), y = sz(e.z);
      g.fillStyle = e.team === this.myTeam ? '#2a7cff' : '#e8302a';
      g.strokeStyle = e.id === this.me ? '#fff' : '#140c08'; g.lineWidth = e.id === this.me ? 4 : 3;
      g.beginPath(); g.arc(x, y, 11, 0, Math.PI * 2); g.fill(); g.stroke();
      const info = e.info;
      if (info) { g.fillStyle = '#fff'; g.font = `bold 13px ${WORD_FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(info.def.name[0], x, y + 1); }
    }
    // what the camera sees
    const v = this.view, c = [[0, 0], [v.w, 0], [v.w, v.h], [0, v.h]].map(([a, b]) => v.groundAt(a, b));
    if (c.every(Boolean)) {
      g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = 2.5;
      g.beginPath(); c.forEach((p, i) => (i ? g.lineTo(sx(p.x), sz(p.z)) : g.moveTo(sx(p.x), sz(p.z)))); g.closePath(); g.stroke();
    }
  }

  // ============================================================
  //  Scoreboard (Tab) and the result table
  // ============================================================
  scoreboard(on) {
    const el = $('scoreboard');
    el.hidden = !on;
    if (!on) return;
    el.innerHTML = this.scoreTable();
  }
  scoreTable() {
    const W = this.world;
    const rows = (team) => W.heroList.filter((h) => h.team === team).map((h) => `<tr class="${h.id === this.me ? 'me' : ''}">
      <td class="who"><img src="${this.portrait(h.hero, h.team)}" alt=""><span>${esc(h.name)}<em>${h.def.name} · ${h.level}. szint${h.bot ? ' · gép' : ''}</em></span></td>
      <td>${h.k} / ${h.d} / ${h.a}</td><td>${h.cs}</td><td>${h.gold}</td><td>${Math.round(h.dmg)}</td>
      <td class="its">${h.items.map((i) => (i >= 0 ? icon(ITEMS[i].icon, ITEMS[i].adv ? '#c9902a' : '#6a7a92', { square: true }) : '<span class="e"></span>')).join('')}</td></tr>`).join('');
    const head = (team) => `<tr class="th" style="--tc:${TEAMS[team].css}"><th>${TEAMS[team].name} CSAPAT · ${W.kills[team]} ölés</th><th>Ö / H / S</th><th>Minion</th><th>Arany</th><th>Sebzés</th><th>Tárgyak</th></tr>`;
    return `<table>${head(this.myTeam)}${rows(this.myTeam)}${head(1 - this.myTeam)}${rows(1 - this.myTeam)}</table>`;
  }
}
