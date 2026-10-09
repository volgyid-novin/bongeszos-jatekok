import { HEROES, TEAMS, DIFFS, TICK, SNAP_EVERY, SLOT_KEYS, UNLOCK, K, F, LANE, P2_LEVEL, ITEMS } from './data.js';
import { Sim } from './sim.js';
import { botThink } from './ai.js';
import { World } from './world.js';
import { View } from './view.js';
import { FX } from './fx.js';
import { HUD } from './hud.js';
import { Sound } from './audio.js';
import { Room, selfId } from './net.js';
import { icon } from './icons.js';
import { sdf } from './map.js';

// Menus, the room, input and the main loop. One machine simulates (solo, or the host of a room); every
// machine draws from a World fed with snapshots. Bots fill the empty seats.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const store = {
  get(k, d) { try { return localStorage.getItem('hago.' + k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('hago.' + k, v); } catch { /* private mode */ } },
};
const cleanName = (n) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 16) || 'Játékos';
const randomCode = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[b % 24]).join('');
const inviteUrl = (code) => `${location.origin}${location.pathname}#${code}`;
const KEY_SLOT = { KeyQ: 0, KeyW: 1, KeyE: 2, KeyD: 3, KeyF: 4, KeyR: 5 };

let view, fx, hud, snd;
let game = null;           // the running match (or the menu demo)
// one clock for everything; the debug helper can push it forward (hago.advance)
let clockOff = 0;
const nowS = () => performance.now() / 1000 + clockOff;
const prefs = {
  hero: clamp(+store.get('hero', 0) || 0, 0, HEROES.length - 1),
  mode: store.get('mode', '2v2') === '1v1' ? '1v1' : '2v2',
  diff: clamp(+store.get('diff', 1) || 0, 0, 2),
  quick: store.get('quick', '0') === '1',
  muted: store.get('muted', '0') === '1',
};
let nameInput;
const myName = () => { const n = cleanName(nameInput.value); store.set('name', n); return n; };

// ============================================================
//  Matches
// ============================================================
function slotsFor(mode, seats, diff) {
  // seats: [{ name, hero, human } | null] x4 (blue, blue, red, red); 1v1 uses seats 0 and 2
  const order = mode === '1v1' ? [0, 2] : [0, 1, 2, 3];
  const used = [new Set(), new Set()];
  for (const i of order) { const s = seats[i]; if (s) used[i < 2 ? 0 : 1].add(s.hero); }
  return order.map((i) => {
    const team = i < 2 ? 0 : 1, s = seats[i];
    if (s) return { team, hero: s.hero, name: s.name, bot: false, diff };
    const free = HEROES.map((_, h) => h).filter((h) => !used[team].has(h));
    const hero = free[Math.floor(Math.random() * free.length)] ?? 0;
    used[team].add(hero);
    return { team, hero, name: `${HEROES[hero].name.charAt(0)}${HEROES[hero].name.slice(1).toLowerCase()} (gép)`, bot: true, diff };
  });
}

// role: 'demo' | 'solo' | 'host' | 'client'
function startMatch(role, cfg, mySlot) {
  endMatch();
  const host = role !== 'client';
  const sim = host ? new Sim(cfg) : null;
  if (sim) sim.ai = botThink;
  const world = new World(cfg, host ? World.hostDelay() : 0.12);
  const g = { role, cfg, sim, world, mySlot, acc: 0, out: [], over: false, endT: 0, clock: 0, myId: 0, myTeam: mySlot >= 0 ? cfg.slots[mySlot].team : 0, lastSend: 0 };
  if (sim) g.myId = mySlot >= 0 ? sim.heroes[mySlot].id : 0;
  game = g;
  fx.myTeam = g.myTeam;
  fx.setPlayer(g.myId, g.myTeam);
  fx.quiet = role === 'demo';
  if (role !== 'demo') {
    hud.start(world, view, g.myId, g.myTeam);
    $('hud').hidden = false;
    document.body.classList.add('playing');
  } else {
    $('hud').hidden = true;
    document.body.classList.remove('playing');
  }
  // start the camera at my fountain
  const fxp = g.myTeam === 0 ? -52 : 52;
  view.cam.x = view.cam.tx = fxp; view.cam.z = view.cam.tz = 0; view.cam.dist = 29;
  if (host) pump(g, true);
  return g;
}
function endMatch() {
  if (!game) return;
  // clear visuals of the old match
  for (const v of view.vis.values()) view.dispose(v);
  view.vis.clear();
  for (const c of view.corpses) view.dispose(c);
  view.corpses = [];
  fx.clear();
  game = null;
}
// host: advance the simulation and feed the world (and the network)
function pump(g, first) {
  const now = nowS();
  if (first) { g.simWall = now; }
  let steps = 0;
  while (g.simWall <= now && steps < 8) {
    g.sim.step();
    const ev = g.sim.drainEvents();
    const snap = g.sim.snapshot();
    g.world.ingest(snap, ev, g.simWall);
    if (g.role === 'host') {
      for (const e of ev) g.out.push(e);
      if (g.sim.tick % SNAP_EVERY === 0 && MP.room) { MP.room.send('s', { s: snap, v: g.out }); g.out = []; }
    }
    g.simWall += TICK;
    steps++;
  }
  if (g.simWall < now - 0.5) g.simWall = now;   // fell far behind (tab was asleep)
}

// ---------- the menu background: four bots playing ----------
function startDemo() {
  const slots = [0, 1, 2, 3].map((i) => ({ team: i < 2 ? 0 : 1, hero: [prefs.hero, (prefs.hero + 1) % 4, (prefs.hero + 2) % 4, (prefs.hero + 3) % 4][i], name: '', bot: true, diff: 1 }));
  const g = startMatch('demo', { mode: '2v2', slots }, -1);
  // fast-forward to the first fights
  for (let i = 0; i < 30 * 40; i++) { g.sim.step(); g.sim.drainEvents(); }
  g.simWall = nowS();
  g.world.ingest(g.sim.snapshot(), [], g.simWall);
  g.camHero = 0;
  g.camT = 0;
}

function startSolo() {
  snd.init();
  const name = myName();
  const seats = [null, null, null, null];
  seats[0] = { name, hero: prefs.hero, human: true };
  const cfg = { mode: prefs.mode, slots: slotsFor(prefs.mode, seats, prefs.diff) };
  hideScreens();
  startMatch('solo', cfg, 0);
  hud.announce('KÜZDELEM A HÁGÓÉRT', 'Rombold le az ellenfél kristályát!', 'neutral', 3);
}

// ============================================================
//  Input
// ============================================================
const input = { mx: 0, my: 0, rmb: false, rmbT: 0, aim: -1, amove: false, edge: true, locked: true, space: false, tab: false };
function myHeroEnt() { return game && game.myId ? game.world.get(game.myId) : null; }
function sendCmd(c) {
  if (!game || game.role === 'demo' || game.over) return;
  if (game.sim) game.sim.command(game.sim.byId.get(game.myId), c);
  else if (MP.room) MP.room.send('c', c, MP.room.hostId);
}
function playing() { return game && game.role !== 'demo' && !game.over && !paused; }
function pickEnemy(mx, my) {
  return view.pick(mx, my, (e) => e.team !== game.myTeam && e.alive && (e.kind !== K.TOWER || e.extra !== 1) && (e.kind !== K.NEXUS || e.extra !== 1));
}
function onRightDown() {
  const h = myHeroEnt();
  if (!h) return;
  if (input.aim >= 0) { input.aim = -1; return; }   // right click cancels aiming
  input.amove = false;
  const t = pickEnemy(input.mx, input.my);
  if (t) { sendCmd({ k: 'at', t: t.id }); fx.clickMarker(t.x, t.z, true); return; }
  const p = view.groundAt(input.mx, input.my);
  if (!p) return;
  sendCmd({ k: 'mv', x: +p.x.toFixed(2), z: +p.z.toFixed(2) });
  fx.clickMarker(p.x, p.z, false);
}
function castSlot(s) {
  const info = game.world.heroes.get(game.myId), h = myHeroEnt();
  if (!info || !h) return;
  const sk = info.def.skills[s];
  const p = view.groundAt(input.mx, input.my) || { x: h.x, z: h.z };
  let t = 0;
  if (sk.kind === 'unit') {
    const ok = (e) => e.alive && e.id !== game.myId && e.kind !== K.TOWER && e.kind !== K.NEXUS
      && (sk.targets === 'any' || (sk.targets === 'ally' ? e.team === game.myTeam : e.team !== game.myTeam))
      && (sk.targets !== 'hero' || e.kind === K.HERO || e.kind === K.CLONE);
    let u = view.pick(input.mx, input.my, ok);
    if (!u) {
      // nearest fitting unit to the cursor on the ground
      let bd = 2.5;
      for (const v of view.vis.values()) {
        const e = v.e;
        if (!e || !v.seen || !v.root.visible || !ok(e)) continue;
        const d = Math.hypot(e.x - p.x, e.z - p.z);
        if (d < bd) { bd = d; u = e; }
      }
    }
    if (!u) { hud.toast('Nincs célpont a kurzor alatt', true); snd.play('error', 0.5); return; }
    t = u.id;
  }
  sendCmd({ k: 'cs', s, x: +p.x.toFixed(2), z: +p.z.toFixed(2), t });
}
function bindInput() {
  const cv = $('view');
  addEventListener('mousemove', (e) => { input.mx = e.clientX; input.my = e.clientY; });
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
  $('overlay').addEventListener('contextmenu', (e) => e.preventDefault());
  cv.addEventListener('mousedown', (e) => {
    if (!playing()) return;
    snd.init();
    if (e.button === 2) { input.rmb = true; input.rmbT = 0.18; onRightDown(); }
    else if (e.button === 0) {
      if (input.aim >= 0) { const s = input.aim; input.aim = -1; castSlot(s); return; }
      if (input.amove) {
        input.amove = false;
        const t = pickEnemy(input.mx, input.my);
        if (t) { sendCmd({ k: 'at', t: t.id }); fx.clickMarker(t.x, t.z, true); return; }
        const p = view.groundAt(input.mx, input.my);
        if (p) { sendCmd({ k: 'am', x: +p.x.toFixed(2), z: +p.z.toFixed(2) }); fx.clickMarker(p.x, p.z, true); }
        return;
      }
      // left click on an enemy attacks it too (friendlier for newcomers)
      const t = pickEnemy(input.mx, input.my);
      if (t) { sendCmd({ k: 'at', t: t.id }); fx.clickMarker(t.x, t.z, true); }
    } else if (e.button === 1) { e.preventDefault(); input.drag = { x: e.clientX, y: e.clientY }; }
  });
  addEventListener('mouseup', (e) => { if (e.button === 2) input.rmb = false; if (e.button === 1) input.drag = null; });
  addEventListener('mousemove', (e) => {
    if (input.drag && game) {
      const k = view.cam.dist / 900;
      view.cam.tx -= (e.clientX - input.drag.x) * k * 1.6; view.cam.tz -= (e.clientY - input.drag.y) * k * 2.2;
      input.drag = { x: e.clientX, y: e.clientY };
      input.locked = false;
    }
  });
  cv.addEventListener('wheel', (e) => { if (!game || game.role === 'demo') return; e.preventDefault(); view.cam.dist = clamp(view.cam.dist + Math.sign(e.deltaY) * 2, 18, 36); }, { passive: false });
  addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    if (e.code === 'Escape') {
      if (input.aim >= 0) { input.aim = -1; return; }
      if (hud.shopOpen) { hud.closeShop(); return; }
      if (game && game.role !== 'demo' && !game.over) { if (paused) resume(); else openPause(); }
      return;
    }
    if (!playing()) return;
    if (e.code === 'Tab') { e.preventDefault(); hud.scoreboard(true); return; }
    if (e.repeat) return;
    const s = KEY_SLOT[e.code];
    if (s !== undefined) {
      const info = game.world.heroes.get(game.myId);
      if (!info) return;
      const sk = info.def.skills[s];
      if (info.level < UNLOCK[s]) { hud.toast(`${sk.name}: ${UNLOCK[s]}. szinten nyílik meg`, true); snd.play('error', 0.5); return; }
      if (info.cds[s] > 0.05) { hud.toast(`${sk.name}: még ${info.cds[s].toFixed(1)} mp`, true); snd.play('error', 0.4); return; }
      if (sk.kind === 'self' || prefs.quick) { castSlot(s); return; }
      input.aim = s;
      hud.aiming = s;
      return;
    }
    switch (e.code) {
      case 'KeyA': input.amove = true; break;
      case 'KeyS': sendCmd({ k: 'st' }); input.amove = false; break;
      case 'KeyB': sendCmd({ k: 'rc' }); break;
      case 'KeyP': hud.toggleShop(); break;
      case 'Digit1': sendCmd({ k: 'pot' }); break;
      case 'Space': e.preventDefault(); input.space = true; break;
      case 'KeyY': input.locked = !input.locked; hud.toast(input.locked ? 'Kamera: a hősödet követi' : 'Kamera: szabad (képernyő széle, középső gomb)'); break;
      default: break;
    }
  });
  addEventListener('keyup', (e) => {
    if (e.code === 'Tab') { hud.scoreboard(false); return; }
    if (e.code === 'Space') input.space = false;
    const s = KEY_SLOT[e.code];
    if (s !== undefined && input.aim === s && playing()) { input.aim = -1; castSlot(s); }
  });
  addEventListener('blur', () => { input.rmb = false; input.aim = -1; hud.scoreboard(false); input.space = false; });
}
function updateInput(dt) {
  if (!playing()) { fx.showIndicator(null); return; }
  hud.aiming = input.aim;
  // holding the right button keeps walking toward the cursor
  if (input.rmb) {
    input.rmbT -= dt;
    if (input.rmbT <= 0) {
      input.rmbT = 0.16;
      const p = view.groundAt(input.mx, input.my);
      if (p && !pickEnemy(input.mx, input.my)) sendCmd({ k: 'mv', x: +p.x.toFixed(2), z: +p.z.toFixed(2) });
    }
  }
  const h = myHeroEnt(), info = game.world.heroes.get(game.myId);
  if (h && info && h.alive) {
    const p = view.groundAt(input.mx, input.my);
    if (input.aim >= 0 && p) fx.showIndicator(info.def.skills[input.aim], h, p);
    else if (input.amove) fx.showIndicator({ kind: 'range', range: info.def.stats.range + 0.5 }, h, p || h);
    else fx.showIndicator(null);
  } else fx.showIndicator(null);
  // camera: follow the hero, or pan at the screen edge
  const c = view.cam;
  if (h && (input.locked || input.space)) { c.tx = h.x; c.tz = h.z + 1.5; }
  else if (!input.locked && document.hasFocus()) {
    const m = 14, sp = 26 * dt * (c.dist / 27);
    if (input.mx < m) c.tx -= sp; if (input.mx > innerWidth - m) c.tx += sp;
    if (input.my < m) c.tz -= sp; if (input.my > innerHeight - m) c.tz += sp;
  }
  c.tx = clamp(c.tx, -64, 64); c.tz = clamp(c.tz, -20, 8);
}

// ============================================================
//  Main loop
// ============================================================
let last = 0, paused = false;
let lastReal = 0;
function frame() {
  requestAnimationFrame(frame);
  const real = performance.now() / 1000;
  if (!lastReal) lastReal = real;
  // debug: a frozen game keeps its clock still while real time passes
  if (window.hago && window.hago.frozen) { clockOff -= real - lastReal; lastReal = real; view.render(); return; }
  lastReal = real;
  tick(nowS());
}
function tick(now) {
  const dt = Math.max(0, Math.min(0.05, last ? now - last : 0.016));
  last = now;
  if (!game) { view.updateCamera(dt); view.render(); return; }
  const g = game;
  if (g.sim && !(paused && g.role === 'solo')) pump(g, false);
  else if (g.sim && paused) g.simWall = now;
  // a client learns its hero's id from the first snapshot
  if (!g.myId && g.mySlot >= 0 && g.world.heroList[g.mySlot]) {
    g.myId = g.world.heroList[g.mySlot].id;
    fx.setPlayer(g.myId, g.myTeam);
    hud.start(g.world, view, g.myId, g.myTeam);
  }
  const evs = g.world.frame(now);
  for (const e of evs) {
    fx.handle(e);
    if (g.role !== 'demo') hud.handle(e, snd);
    if (e.k === 'end' && !g.over) gameOver(e.w);
  }
  view.syncUnits(g.world, paused && g.role === 'solo' ? 0 : dt, g.role === 'demo' ? 0 : g.myTeam, g.myId);
  fx.update(paused && g.role === 'solo' ? 0 : dt, g.world);
  if (g.role === 'demo') demoCamera(g, dt);
  else updateInput(dt);
  if (g.over && g.endT > 0) {
    g.endT -= dt;
    const n = g.world.get(g.sim ? g.sim.nexus[1 - g.winner].id : -1) || [...g.world.ents.values()].find((e) => e.kind === K.NEXUS && !e.alive);
    if (n) { view.cam.tx = n.x; view.cam.tz = n.z + 2; }
    if (g.endT <= 0) showResult();
  }
  view.updateCamera(dt);
  view.render();
  if (g.role !== 'demo') hud.frame(dt);
}
function demoCamera(g, dt) {
  g.camT -= dt;
  const heroes = g.world.heroList.filter(Boolean);
  if (g.camT <= 0 || !heroes.length) {
    g.camT = 9;
    // follow whoever is closest to a fight
    let best = 0, bs = -1;
    heroes.forEach((h, i) => {
      const e = g.world.get(h.id);
      if (!e || !e.alive) return;
      let s = 0;
      for (const o of heroes) { const f = g.world.get(o.id); if (f && f.alive && o.team !== h.team) s += Math.max(0, 14 - Math.hypot(f.x - e.x, f.z - e.z)); }
      if (s > bs) { bs = s; best = i; }
    });
    g.camHero = best;
  }
  const h = heroes[g.camHero], e = h && g.world.get(h.id);
  if (e) { view.cam.tx = e.x + 5; view.cam.tz = e.z + 1; }
  view.cam.dist = 25;
}
function gameOver(winner) {
  const g = game;
  g.over = true; g.winner = winner; g.endT = 3.2;
  input.aim = -1; input.rmb = false;
  hud.closeShop();
  const won = winner === g.myTeam;
  snd.play(won ? 'victory' : 'defeat', 1);
  hud.announce(won ? 'GYŐZELEM!' : 'VERESÉG', won ? 'Az ellenfél kristálya darabokra hullott' : 'A kristályotok elesett', won ? 'good' : 'bad', 3.2);
}

// ============================================================
//  Screens
// ============================================================
function hideScreens() { for (const id of ['menu', 'room', 'pause', 'result']) $(id).hidden = true; paused = false; }
function showScreen(id) { hideScreens(); if (id) $(id).hidden = false; }
function showMenu() {
  showScreen('menu');
  $('hud').hidden = true;
  document.body.classList.remove('playing');
  renderHeroPick('heroPick');
  if (!game || game.role !== 'demo') startDemo();
}
function openPause() {
  paused = true;
  $('pause').hidden = false;
  $('pauseNote').textContent = game.role === 'solo' ? 'A meccs áll.' : 'Többjátékos módban a meccs közben is megy tovább.';
  $('ggBtn').hidden = game.role !== 'solo';
  syncSoundBtn();
}
function resume() { paused = false; $('pause').hidden = true; }
function showResult() {
  const g = game;
  const won = g.winner === g.myTeam;
  $('resHead').textContent = won ? 'Győzelem' : 'Vereség';
  $('resHead').className = 'res-head ' + (won ? 'win' : 'lose');
  const mins = Math.floor(g.world.time / 60), secs = Math.floor(g.world.time % 60);
  $('resSub').textContent = `${mins}:${String(secs).padStart(2, '0')} · ${g.world.kills[g.myTeam]} – ${g.world.kills[1 - g.myTeam]} ölés`;
  $('resTable').innerHTML = hud.scoreTable();
  $('againTxt').textContent = g.role === 'solo' ? 'ÚJ MECCS' : 'VISSZA A SZOBÁBA';
  $('result').hidden = false;
  document.body.classList.remove('playing');
  $('hud').hidden = true;
}
function syncSoundBtn() { $('soundBtn').textContent = prefs.muted ? 'HANG: KI' : 'HANG: BE'; }

// hero cards (menu and room)
function renderHeroPick(where) {
  const el = $(where);
  el.innerHTML = HEROES.map((h, i) => `<button class="hcard${i === prefs.hero ? ' on' : ''}" data-h="${i}" style="--hc:${h.css}">
    <img src="${hud.portrait(i, 0)}" alt=""><b>${h.name}</b><span>${h.role}</span><i>${'★'.repeat(h.diff)}${'☆'.repeat(3 - h.diff)}</i></button>`).join('');
  for (const b of el.querySelectorAll('.hcard')) b.onclick = () => { prefs.hero = +b.dataset.h; store.set('hero', prefs.hero); snd.init(); snd.play('click', 0.6); renderHeroPick(where); if (MP.room) pickMine({ hero: prefs.hero }); };
  renderHeroInfo(where === 'heroPick' ? 'heroInfo' : 'roomHeroInfo');
}
function renderHeroInfo(where) {
  const h = HEROES[prefs.hero];
  const sk = h.skills.map((s, i) => `<li data-tip="s${i}">${icon(s.icon, h.css)}<span><b>${SLOT_KEYS[i]}</b> ${esc(s.name)}${UNLOCK[i] > 1 ? `<em>${UNLOCK[i]}. szint</em>` : ''}</span></li>`).join('');
  const ps = h.passives.map((p, i) => `<li data-tip="p${i}">${icon(p.icon, h.css)}<span><b>P</b> ${esc(p.name)}${i ? `<em>${P2_LEVEL}. szint</em>` : ''}</span></li>`).join('');
  $(where).innerHTML = `<div class="hi-head" style="--hc:${h.css}"><b>${h.name}</b> <span>${h.title} · ${h.role}</span></div><p>${esc(h.blurb)}</p><ul class="hi-sk">${ps}${sk}</ul>`;
  for (const li of $(where).querySelectorAll('li')) {
    const k = li.dataset.tip, i = +k.slice(1);
    li.onmouseenter = (ev) => hud.showTip(ev, () => {
      const st = { lvl: 1, ad: h.stats.ad, ap: 0, maxHp: h.stats.hp };
      const f = (d, n) => d.replace(/\{(\w+)\}/g, (m, kk) => (n && n[kk] !== undefined ? String(Math.round(n[kk][0] ?? n[kk])) + (Array.isArray(n[kk]) && (n[kk][2] || n[kk][3] || n[kk][4]) ? '+' : '') : m));
      if (k[0] === 's') { const s = h.skills[i]; return `<h4>${esc(s.name)} <em>(${SLOT_KEYS[i]})</em></h4><div class="meta">töltés ${s.cd} mp</div><p>${f(s.desc, s.n)}</p>`; }
      const p = h.passives[i]; void st;
      return `<h4>${esc(p.name)} <em>(passzív)</em></h4><p>${f(p.desc, p.n)}</p>`;
    });
    li.onmouseleave = () => hud.hideTip();
  }
}
function bindSeg(id, get, set) {
  const el = $(id);
  const sync = () => { for (const b of el.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.v === String(get()))); };
  for (const b of el.querySelectorAll('button')) b.onclick = () => { set(b.dataset.v); sync(); snd.init(); snd.play('click', 0.5); };
  sync();
  return sync;
}

// ============================================================
//  Multiplayer room
// ============================================================
const MP = { room: null, lobby: null, myReady: false, inGame: false, note: '' };
function newLobby() {
  return { mode: prefs.mode, diff: prefs.diff, seats: [null, null, null, null] };
}
function seatOf(pid) { return MP.lobby ? MP.lobby.seats.findIndex((s) => s && s.pid === pid) : -1; }
function enterRoom(code) {
  snd.init();
  let room;
  try { room = new Room(code); } catch (err) {
    console.error(err);
    menuNote('Nem sikerült csatlakozni. A többjátékos módhoz HTTPS vagy localhost kell.');
    return;
  }
  MP.room = room; MP.myReady = false; MP.inGame = false; MP.note = ''; MP.joinT = 12;
  MP.lobby = newLobby();
  MP.lobby.seats[0] = { pid: selfId, name: myName(), hero: prefs.hero, ready: false };
  room.onJoin = (pid) => {
    room.send('hello', { name: myName(), hero: prefs.hero }, pid);
    if (room.isHost) pushLobby();
    renderRoom();
  };
  room.onLeave = (pid) => {
    const i = seatOf(pid);
    const who = i >= 0 ? MP.lobby.seats[i].name : 'Valaki';
    if (MP.inGame && game && game.role === 'host') {
      // their hero keeps playing as a bot
      const slot = seatToSlot(i);
      const h = slot >= 0 ? game.sim.heroes[slot] : null;
      if (h) { h.bot = true; h.diff = 1; h.aiState = {}; h.name = who + ' (gép)'; }
      hud.toast(`${esc(who)} kilépett, a hősét a gép viszi tovább`);
    } else if (MP.inGame && game && game.role === 'client' && pid === MP.hostAtStart) {
      hud.toast('A házigazda kilépett, a meccs véget ért', true);
      setTimeout(() => { endMatch(); MP.inGame = false; showRoom(); }, 1500);
    }
    if (i >= 0 && !MP.inGame) MP.lobby.seats[i] = null;
    if (room.isHost) { if (i >= 0) MP.lobby.seats[i] = MP.inGame ? MP.lobby.seats[i] : null; pushLobby(); }
    roomNote(`${who} kilépett.`);
  };
  room.on('hello', (d, pid) => {
    if (!room.isHost) return;
    if (seatOf(pid) >= 0 || MP.inGame) return;
    const order = MP.lobby.mode === '1v1' ? [0, 2] : [0, 2, 1, 3];
    const free = order.find((i) => !MP.lobby.seats[i]);
    if (free === undefined) return;
    MP.lobby.seats[free] = { pid, name: cleanName(d?.name), hero: clamp(d?.hero | 0, 0, 3), ready: false };
    roomNote(`${cleanName(d?.name)} belépett.`);
    pushLobby();
  });
  room.on('lobby', (d, pid) => {
    if (room.isHost || pid !== room.hostId || !d || !Array.isArray(d.seats)) return;
    MP.lobby = { mode: d.mode === '1v1' ? '1v1' : '2v2', diff: clamp(d.diff | 0, 0, 2), seats: d.seats.slice(0, 4).map((s) => (s ? { pid: String(s.pid), name: cleanName(s.name), hero: clamp(s.hero | 0, 0, 3), ready: !!s.ready } : null)) };
    const me = seatOf(selfId);
    MP.myReady = me >= 0 && MP.lobby.seats[me].ready;
    if (me >= 0 && MP.lobby.seats[me].hero !== prefs.hero) pickMine({ hero: prefs.hero });
    renderRoom();
  });
  room.on('pick', (d, pid) => {
    if (!room.isHost || !d) return;
    applyPick(pid, d);
    pushLobby();
  });
  room.on('start', (d, pid) => {
    if (room.isHost || pid !== room.hostId || !d || !d.cfg) return;
    const seats = d.seats || [];
    const mySeat = seats.indexOf(selfId);
    const slot = seatToSlotFor(d.cfg.mode, mySeat);
    if (slot < 0) return;
    MP.hostAtStart = pid;
    beginMP('client', d.cfg, slot);
  });
  room.on('c', (d, pid) => {
    if (!room.isHost || !game || game.role !== 'host' || !d) return;
    const slot = seatToSlot(seatOf(pid));
    if (slot < 0) return;
    const h = game.sim.heroes[slot];
    if (h && !h.bot) game.sim.command(h, d);
  });
  room.on('s', (d, pid) => {
    if (room.isHost || !game || game.role !== 'client' || pid !== MP.hostAtStart || !d || !d.s) return;
    game.world.ingest(d.s, d.v || [], nowS());
  });
  room.on('back', (d, pid) => {
    const i = seatOf(pid);
    if (i >= 0 && MP.lobby.seats[i]) MP.lobby.seats[i].inGame = false;
    renderRoom();
  });
  history.replaceState(null, '', location.pathname + location.search + '#' + code);
  menuNote('');
  showRoom();
}
function applyPick(pid, d) {
  const L = MP.lobby;
  let i = seatOf(pid);
  if (i < 0) return;
  if (d.seat !== undefined) {
    const s = d.seat | 0;
    const allowed = L.mode === '1v1' ? [0, 2] : [0, 1, 2, 3];
    if (allowed.includes(s) && !L.seats[s]) { L.seats[s] = L.seats[i]; L.seats[i] = null; i = s; L.seats[i].ready = false; }
  }
  if (d.hero !== undefined) { L.seats[i].hero = clamp(d.hero | 0, 0, 3); }
  if (d.ready !== undefined) L.seats[i].ready = !!d.ready;
  if (d.name !== undefined) L.seats[i].name = cleanName(d.name);
}
function pickMine(d) {
  if (!MP.room) return;
  if (MP.room.isHost) { applyPick(selfId, d); pushLobby(); }
  else MP.room.send('pick', d, MP.room.hostId);
}
function pushLobby() {
  if (!MP.room || !MP.room.isHost) return;
  // make sure the host sits somewhere
  if (seatOf(selfId) < 0) { const f = [0, 2, 1, 3].find((i) => !MP.lobby.seats[i]); if (f !== undefined) MP.lobby.seats[f] = { pid: selfId, name: myName(), hero: prefs.hero, ready: MP.myReady }; }
  MP.room.send('lobby', MP.lobby);
  const me = seatOf(selfId);
  MP.myReady = me >= 0 && MP.lobby.seats[me].ready;
  renderRoom();
  maybeStart();
}
const seatToSlotFor = (mode, seat) => (mode === '1v1' ? (seat === 0 ? 0 : seat === 2 ? 1 : -1) : seat);
const seatToSlot = (seat) => seatToSlotFor(MP.lobby.mode, seat);
function maybeStart() {
  const L = MP.lobby;
  if (!MP.room || !MP.room.isHost || MP.inGame) return;
  const humans = L.seats.filter(Boolean);
  if (!humans.length || !humans.every((s) => s.ready && !s.inGame)) return;
  const seats = L.seats.map((s) => (s ? { name: s.name, hero: s.hero, human: true } : null));
  const cfg = { mode: L.mode, slots: slotsFor(L.mode, seats, L.diff) };
  const pids = L.seats.map((s) => (s ? s.pid : null));
  MP.room.send('start', { cfg, seats: pids });
  beginMP('host', cfg, seatToSlot(seatOf(selfId)));
}
function beginMP(role, cfg, slot) {
  MP.inGame = true;
  for (const s of MP.lobby.seats) if (s) { s.ready = false; s.inGame = true; }
  MP.myReady = false;
  hideScreens();
  startMatch(role, cfg, slot);
  hud.announce('KÜZDELEM A HÁGÓÉRT', 'Rombold le az ellenfél kristályát!', 'neutral', 3);
}
function backToRoom() {
  MP.inGame = false;
  MP.room?.send('back', {});
  const me = seatOf(selfId);
  if (me >= 0) MP.lobby.seats[me].inGame = false;
  endMatch();
  showRoom();
  if (MP.room?.isHost) pushLobby();
}
function leaveRoom() {
  MP.room?.leave();
  MP.room = null; MP.lobby = null; MP.inGame = false;
  history.replaceState(null, '', location.pathname + location.search);
  endMatch();
  showMenu();
}
function roomNote(t) { MP.note = t; MP.noteT = 5; renderRoom(); }
function showRoom() {
  showScreen('room');
  $('hud').hidden = true;
  document.body.classList.remove('playing');
  if (!game || game.role !== 'demo') startDemo();
  renderHeroPick('roomHeroPick');
  renderRoom();
}
function renderRoom() {
  if (!MP.room || $('room').hidden) return;
  const L = MP.lobby, host = MP.room.isHost;
  $('roomCode').textContent = MP.room.code;
  $('inviteLink').textContent = inviteUrl(MP.room.code);
  const seatHtml = (i) => {
    const s = L.seats[i], off = L.mode === '1v1' && (i === 1 || i === 3);
    if (off) return `<div class="seat off"><span>—</span></div>`;
    if (!s) return `<button class="seat empty" data-seat="${i}"><span class="bot">GÉP · ${DIFFS[L.diff].name}</span><em>kattints, hogy ide ülj</em></button>`;
    const me = s.pid === selfId;
    return `<div class="seat${me ? ' me' : ''}"><img src="${hud.portrait(s.hero, i < 2 ? 0 : 1)}" alt=""><span><b>${esc(s.name)}</b><em>${HEROES[s.hero].name}${s.pid === MP.room.hostId ? ' · házigazda' : ''}${me ? ' · te' : ''}</em></span><i class="${s.ready ? 'ok' : ''}">${s.inGame ? 'EREDMÉNY' : s.ready ? 'KÉSZ' : 'NEM KÉSZ'}</i></div>`;
  };
  $('seats').innerHTML = `<div class="side" style="--tc:${TEAMS[0].css}"><h3>KÉK</h3>${seatHtml(0)}${seatHtml(1)}</div><div class="side" style="--tc:${TEAMS[1].css}"><h3>PIROS</h3>${seatHtml(2)}${seatHtml(3)}</div>`;
  for (const b of $('seats').querySelectorAll('.seat.empty')) b.onclick = () => { snd.play('click', 0.5); pickMine({ seat: +b.dataset.seat }); };
  $('roomMode').classList.toggle('dis', !host);
  $('roomDiff').classList.toggle('dis', !host);
  syncRoomSegs?.();
  $('readyTxt').textContent = MP.myReady ? 'MÉGSEM' : 'KÉSZ VAGYOK';
  $('readyBtn').classList.toggle('on', MP.myReady);
  let status;
  if (!MP.room.peers.size) status = MP.joinT > 0 ? 'Kapcsolódás a szobához…' : 'Még senki nincs itt. Küldd el a linket vagy a kódot. Egyedül is indíthatsz: az üres helyeken gép játszik.';
  else status = 'Ha minden játékos KÉSZ, indul a meccs. Az üres helyeken gép játszik.';
  $('roomStatus').textContent = MP.note || status;
}
let syncRoomSegs = null;
function menuNote(t) { const el = $('inviteNote'); el.textContent = t; el.hidden = !t; }
function readInvite() {
  const code = location.hash.replace('#', '').toUpperCase();
  if (MP.room || !/^[A-Z]{4}$/.test(code)) return;
  $('codeInput').value = code;
  menuNote(`Meghívást kaptál a ${code} szobába. Válassz hőst, aztán nyomd meg: BELÉPÉS.`);
  $('joinBtn').classList.add('hot');
}

// ============================================================
//  Boot
// ============================================================
function bindUI() {
  nameInput = $('nameInput');
  nameInput.value = store.get('name', '');
  nameInput.addEventListener('change', () => { myName(); if (MP.room) pickMine({ name: myName() }); });
  $('soloBtn').onclick = startSolo;
  bindSeg('modeSeg', () => prefs.mode, (v) => { prefs.mode = v; store.set('mode', v); });
  bindSeg('diffSeg', () => prefs.diff, (v) => { prefs.diff = +v; store.set('diff', v); });
  const s1 = bindSeg('roomMode', () => (MP.lobby ? MP.lobby.mode : prefs.mode), (v) => {
    if (!MP.room?.isHost) return;
    MP.lobby.mode = v;
    if (v === '1v1') for (const i of [1, 3]) { const s = MP.lobby.seats[i]; if (s) { const f = [0, 2].find((j) => !MP.lobby.seats[j]); MP.lobby.seats[i] = null; if (f !== undefined) MP.lobby.seats[f] = s; } }
    pushLobby();
  });
  const s2 = bindSeg('roomDiff', () => (MP.lobby ? MP.lobby.diff : prefs.diff), (v) => { if (!MP.room?.isHost) return; MP.lobby.diff = +v; pushLobby(); });
  syncRoomSegs = () => { s1(); s2(); };
  $('quickBox').checked = prefs.quick;
  $('quickBox').onchange = () => { prefs.quick = $('quickBox').checked; store.set('quick', prefs.quick ? '1' : '0'); };
  $('createBtn').onclick = () => enterRoom(randomCode());
  const codeInput = $('codeInput');
  $('joinBtn').onclick = () => {
    const code = codeInput.value.trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(code)) { codeInput.classList.add('err'); codeInput.focus(); menuNote('A szobakód 4 betű.'); return; }
    enterRoom(code);
  };
  codeInput.addEventListener('input', () => { codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4); codeInput.classList.remove('err'); });
  codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('joinBtn').click(); });
  $('readyBtn').onclick = () => { snd.play('click', 0.6); pickMine({ ready: !MP.myReady }); if (!MP.room.isHost) { MP.myReady = !MP.myReady; renderRoom(); } };
  $('leaveBtn').onclick = leaveRoom;
  $('copyBtn').onclick = () => {
    const url = inviteUrl(MP.room ? MP.room.code : '');
    const done = () => { $('copyBtn').textContent = 'MÁSOLVA'; setTimeout(() => ($('copyBtn').textContent = 'LINK MÁSOLÁSA'), 1500); };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(done, () => {});
  };
  $('resumeBtn').onclick = resume;
  $('soundBtn').onclick = () => { prefs.muted = !prefs.muted; store.set('muted', prefs.muted ? '1' : '0'); snd.setMuted(prefs.muted); syncSoundBtn(); };
  $('ggBtn').onclick = () => { if (game && game.sim && game.role === 'solo') { paused = false; $('pause').hidden = true; game.sim.winner = 1 - game.myTeam; game.sim.ev('end', { w: 1 - game.myTeam }); } };
  $('quitBtn').onclick = () => { paused = false; if (MP.room) leaveRoom(); else { endMatch(); showMenu(); } };
  $('againBtn').onclick = () => { if (game && game.role === 'solo') { $('result').hidden = true; startSolo(); } else backToRoom(); };
  $('resMenuBtn').onclick = () => { if (MP.room) leaveRoom(); else { endMatch(); showMenu(); } };
  $('shopBtn').onclick = () => hud.toggleShop();
  hud.onCmd = (c) => sendCmd(c);
  hud.onMap = (x, z, b) => {
    if (!playing()) return;
    if (b === 2) { sendCmd({ k: 'mv', x: +x.toFixed(2), z: +z.toFixed(2) }); fx.clickMarker(x, z, false); }
    else { input.locked = false; view.cam.tx = x; view.cam.tz = z; }
  };
  hud.onSkillClick = (s) => {
    if (!playing()) return;
    const info = game.world.heroes.get(game.myId);
    if (info && info.def.skills[s].kind === 'self') castSlot(s); else { input.aim = s; }
  };
}

function resize() {
  const w = innerWidth, h = innerHeight;
  view.resize(w, h);
  hud.resize(w, h, Math.min(devicePixelRatio || 1, 2));
}

export async function boot() {
  try { await Promise.race([document.fonts.load('32px "Bangers"'), new Promise((r) => setTimeout(r, 1500))]); } catch { /* fonts are optional */ }
  snd = new Sound();
  snd.setMuted(prefs.muted);
  hud = new HUD();
  hud.snd = snd;
  hud.setPortraits(View.portraits());
  view = new View($('view'));
  fx = new FX(view, snd, hud);
  // the menu demo plays silently
  const play = fx.play.bind(fx);
  fx.play = (k, x, z, v) => { if (!fx.quiet) play(k, x, z, v); };
  bindUI();
  bindInput();
  resize();
  addEventListener('resize', resize);
  document.addEventListener('visibilitychange', () => { if (document.hidden && game && game.role === 'solo' && !paused && !game.over) openPause(); });
  // keep the host's simulation running while its tab is in the background
  try {
    const w = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 33);'], { type: 'text/javascript' })));
    w.onmessage = () => { if (document.hidden && game && game.role === 'host') pump(game, false); };
  } catch { /* no workers: the host just pauses in the background */ }
  setInterval(() => { if (MP.joinT > 0) { MP.joinT -= 1; if (MP.joinT <= 0) renderRoom(); } if (MP.noteT > 0) { MP.noteT -= 1; if (MP.noteT <= 0) { MP.note = ''; renderRoom(); } } }, 1000);
  // a handle for poking at the game from the browser console
  window.hago = {
    get game() { return game; }, view, fx, hud, snd, MP,
    advance(sec, fps = 30) { for (let i = 0; i < sec * fps; i++) { clockOff += 1 / fps; tick(nowS()); } },
    cmd: (c) => sendCmd(c),
    solo(hero, mode = '2v2') { prefs.hero = hero; prefs.mode = mode; startSolo(); },
    // a frozen test bench: my hero at the given level near mid, the enemies standing still in front
    lab(hero = 0, level = 6) {
      this.frozen = true; prefs.hero = hero; prefs.mode = '2v2'; startSolo(); this.advance(3.5);
      const s = game.sim, h = s.heroes[0];
      h.level = level; s.calcStats(h); h.hp = h.maxHp;
      for (const x of s.heroes) if (x !== h) { x.bot = false; x.cmd = null; x.x = x.team ? -2 + x.slot : -14; x.z = x.team ? -1 : 2; }
      h.x = -9; h.z = 0;
      this.advance(0.5);
      return s;
    },
  };
  readInvite();
  showMenu();
  $('loading').hidden = true;
  requestAnimationFrame(frame);
}
void sdf; void ITEMS; void LANE; void F;
