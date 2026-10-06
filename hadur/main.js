import { MAP, TICK, UNITS, BUILDINGS, UPGRADES, RACES, TEAM_CSS, GRID_KEYS, QUEUE_MAX, FOOD_MAX } from './data.js';
import { Sim, TREE, FREE, ROCK } from './sim.js';
import { AI } from './ai.js';
import { View } from './view.js';
import { Sound } from './audio.js';
import { Duel, selfId } from './net.js';

const $ = (id) => document.getElementById(id);
const N = MAP;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const q64 = (v) => Math.round(v * 64) / 64;
const HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => HTML_ESC[c]);
const cleanName = (v) => String(v ?? '').trim().slice(0, 16) || 'Játékos';
const store = {
  get(k, d) { try { const v = localStorage.getItem('hadur:' + k); return v == null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('hadur:' + k, String(v)); } catch { /* storage blocked */ } },
};
const fmtClock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

const view = new View($('view'));
const snd = new Sound();
snd.setMuted(store.get('muted', '0') === '1');
const overlay = $('overlay'), octx = overlay.getContext('2d');
const iconCache = {};
function iconsFor(slot) {
  if (!iconCache[slot]) iconCache[slot] = view.icons([...Object.keys(UNITS), ...Object.keys(BUILDINGS), 'mine'], [0x3d7bff, 0xe2412e][slot] ?? 0x888888);
  return iconCache[slot];
}

// ============================================================
//  Lockstep game
// ============================================================
// Both peers run the same simulation. Commands issued during tick T are executed at T + delay
// on both machines; a tick only runs once both players' command packets for it are in.
class Game {
  constructor(o) {
    this.mode = o.mode;         // 'solo' | 'mp' | 'demo'
    this.me = o.me;
    this.seed = o.seed;
    this.names = o.names;
    this.races = o.races;
    this.level = o.level ?? 1;
    const mul = [1, 1];
    if (o.mode === 'solo' && this.level === 2) mul[1 - o.me] = 1.2;
    this.sim = new Sim({ seed: o.seed, races: o.races, mul });
    this.delay = o.mode === 'mp' ? 3 : 1;
    this.turns = new Map();
    for (let t = 0; t < this.delay; t++) this.turns.set(t, [[], []]);
    this.pending = [];
    this.ais = [];
    if (o.mode === 'solo') this.ais.push(new AI(this.sim, 1 - o.me, this.level));
    if (o.mode === 'demo') this.ais.push(new AI(this.sim, 0, 1), new AI(this.sim, 1, 1));
    this.acc = 0;
    this.waitT = 0;
    this.paused = false;
    this.hashes = new Map();
    this.desync = false;
    this.endT = -1;
  }
  put(t, slot, cmds) {
    if (t < this.sim.tick) return;
    let e = this.turns.get(t);
    if (!e) this.turns.set(t, (e = [null, null]));
    e[slot] = cmds;
  }
  ready() {
    const e = this.turns.get(this.sim.tick);
    return !!(e && e[0] && e[1]);
  }
  step() {
    const sim = this.sim, T = sim.tick, at = T + this.delay;
    if (this.mode !== 'demo') {
      const mine = this.pending;
      this.pending = [];
      this.put(at, this.me, mine);
      if (this.mode === 'mp' && MP.room) MP.room.send('turn', { m: this.seed, t: at, c: mine });
    }
    for (const ai of this.ais) this.put(at, ai.slot, ai.think());
    const e = this.turns.get(T);
    this.turns.delete(T);
    sim.step(e[0], e[1]);
    if (this.mode === 'mp' && sim.tick % 50 === 0) {
      const h = sim.hash();
      this.checkHash(sim.tick, h, true);
      MP.room?.send('hash', { m: this.seed, t: sim.tick, h });
    }
  }
  checkHash(t, h, mine) {
    let e = this.hashes.get(t);
    if (!e) this.hashes.set(t, (e = {}));
    e[mine ? 'a' : 'b'] = h;
    if (e.a != null && e.b != null) {
      if (e.a !== e.b && !this.desync) { this.desync = true; $('desync').hidden = false; console.warn('desync at tick', t); }
      this.hashes.delete(t);
    }
  }
}
let game = null;

function pump(dt) {
  const g = game;
  if (!g || g.paused) return 0;
  if (g.sim.winner >= 0) { g.acc = TICK; return 0; }
  g.acc = Math.min(g.acc + dt, 2);
  let n = 0;
  while (g.acc >= TICK && n < 25) {
    if (!g.ready()) break;
    g.step();
    for (const ev of g.sim.events) onEvent(ev);
    g.sim.events.length = 0;
    g.acc -= TICK;
    n++;
    if (g.sim.winner >= 0) break;
  }
  if (g.acc >= TICK && !g.ready() && g.sim.winner < 0) { g.waitT += dt; g.acc = TICK; } else g.waitT = 0;
  if (n) view.computeVis(false);
  return n;
}

// ============================================================
//  UI state
// ============================================================
const ui = {
  sel: [], groups: {}, mode: null, buildType: null, menu: 'main',
  mouse: { x: innerWidth / 2, y: innerHeight / 2, in: false }, drag: null, pan: null,
  keys: new Set(), shift: false, ctrl: false, hover: null, lastClick: { t: 0, id: 0 }, lastGroup: { n: -1, t: 0 },
  alert: null, ping: null, ppu: 30, infoT: 0, cardSig: [], infoSig: '', tipSlot: -1, card: [],
};
const inGame = () => game && game.mode !== 'demo' && !$('hud').hidden;
const me = () => game.me;
const sim = () => game.sim;
const myRace = () => game.races[game.me];
const visualPos = (e) => { const v = view.views.get(e.id); return v && e.cls === 'u' ? v.root.position : e; };
const isWorker = (e) => e.cls === 'u' && UNITS[e.type].worker;

function selEnts() {
  const s = sim(), out = [];
  for (const id of ui.sel) {
    const e = s.get(id);
    if (!e) continue;
    if (e.owner !== game.me && !view.canSee(e)) continue;
    out.push(e);
  }
  return out;
}
function ownSel() {
  const es = selEnts();
  return { units: es.filter((e) => e.cls === 'u' && e.owner === game.me), blds: es.filter((e) => e.cls === 'b' && e.owner === game.me), all: es };
}
function setSel(ids) {
  ui.sel = ids;
  ui.menu = 'main';
  if (ui.mode && ui.mode !== 'place') ui.mode = null;
  if (ui.mode === 'place' && !ownSel().units.some(isWorker)) cancelMode();
  ui.cardSig = [];
  ui.infoSig = '';
}
function issue(cmd) { if (game && game.mode !== 'demo' && game.sim.winner < 0) game.pending.push(cmd); }
function ack() { snd.play(myRace() === 'orc' ? 'ack_orc' : 'ack_human'); }

// ---------- messages ----------
function say(text, cls = '') {
  const box = $('msgs');
  const d = document.createElement('div');
  d.textContent = text;
  d.className = cls;
  box.appendChild(d);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(() => { d.style.opacity = '0'; setTimeout(() => d.remove(), 450); }, 3200);
}
function fail(text) { say(text, 'bad'); snd.play('error'); }

// ============================================================
//  Picking
// ============================================================
function pick(sx, sy) {
  if (!game) return null;
  const g = view.ray(sx, sy);
  let best = null, bd = 1e9;
  for (const e of sim().ents) {
    if (e.dead || (e.cls === 'u' && e.hidden) || !view.canSee(e)) continue;
    if (e.cls === 'u') {
      const p0 = visualPos(e);
      const p = view.project(p0.x, 0.45, p0.z);
      const d = Math.hypot(p.x - sx, p.y - sy), rad = Math.max(13, e.r * ui.ppu * 1.35);
      if (d < rad && d < bd) { bd = d; best = e; }
    } else {
      const p = view.project(e.x, e.size * 0.35, e.z);
      const d = Math.hypot(p.x - sx, p.y - sy);
      let hit = g && g.x >= e.tx - 0.1 && g.x <= e.tx + e.size + 0.1 && g.z >= e.tz - 0.1 && g.z <= e.tz + e.size + 0.1;
      if (!hit && d < e.size * ui.ppu * 0.5) hit = true;
      if (hit && d + 30 < bd) { bd = d + 30; best = e; }
    }
  }
  return best;
}
function treeAt(g) {
  if (!g) return -1;
  // the trunk sits in the tile centre, but the crown is drawn higher; check the tile and the one "behind" it
  for (const [ox, oz] of [[0, 0], [0, -0.6], [0, -1.1]]) {
    const tx = Math.floor(g.x + ox), tz = Math.floor(g.z + oz);
    if (tx < 0 || tz < 0 || tx >= N || tz >= N) continue;
    const i = tz * N + tx;
    if (sim().block[i] === TREE && view.isExplored(tx, tz)) return i;
  }
  return -1;
}
function onScreen(e) {
  const p0 = visualPos(e);
  const p = view.project(p0.x, 0.3, p0.z);
  return p.front && p.x >= 0 && p.y >= 0 && p.x <= view.w && p.y <= view.h - barH();
}
const barH = () => $('bar').getBoundingClientRect().height || 176;

// ============================================================
//  Commands from the mouse
// ============================================================
function rightClick(sx, sy) {
  const s = sim(), own = ownSel();
  const g = view.ray(sx, sy);
  if (!g) return;
  const t = pick(sx, sy);
  if (own.units.length) {
    const units = own.units, ids = units.map((u) => u.id);
    const workers = units.filter(isWorker), others = units.filter((u) => !isWorker(u));
    const wids = workers.map((u) => u.id), oids = others.map((u) => u.id);
    const tree = t ? -1 : treeAt(g);
    if (t && t.owner >= 0 && t.owner !== game.me) {
      issue(['a', ids, t.id]); view.marker(t.x, t.z, true);
    } else if (t && t.cls === 'm') {
      if (wids.length) issue(['gm', wids, t.id]);
      if (oids.length) issue(['m', oids, q64(t.x), q64(t.z + 2.5)]);
      view.marker(t.x, t.z, false);
    } else if (t && t.cls === 'b' && t.owner === game.me && !t.done && wids.length) {
      issue(['hb', wids, t.id]);
      if (oids.length) issue(['m', oids, q64(g.x), q64(g.z)]);
      view.marker(t.x, t.z, false);
    } else if (t && t.cls === 'b' && t.owner === game.me && BUILDINGS[t.type].drop && t.done && workers.some((w) => w.carry)) {
      const carriers = workers.filter((w) => w.carry).map((w) => w.id);
      issue(['rt', carriers]);
      const rest = units.filter((u) => !carriers.includes(u.id)).map((u) => u.id);
      if (rest.length) issue(['m', rest, q64(g.x), q64(g.z)]);
      view.marker(t.x, t.z, false);
    } else if (tree >= 0 && wids.length) {
      issue(['gt', wids, tree]);
      if (oids.length) issue(['m', oids, q64(g.x), q64(g.z)]);
      view.marker((tree % N) + 0.5, Math.floor(tree / N) + 0.5, false);
    } else {
      issue(['m', ids, q64(clamp(g.x, 0.5, N - 0.5)), q64(clamp(g.z, 0.5, N - 0.5))]);
      view.marker(g.x, g.z, false);
    }
    ack();
    return;
  }
  const prod = own.blds.filter((b) => b.done && BUILDINGS[b.type].trains);
  if (prod.length) setRally(prod, g, t);
}
function setRally(blds, g, t) {
  const tree = t ? -1 : treeAt(g);
  const x = t ? t.x : g.x, z = t ? t.z : g.z;
  issue(['rp', blds.map((b) => b.id), q64(clamp(x, 0.5, N - 0.5)), q64(clamp(z, 0.5, N - 0.5)), t ? t.id : 0, tree >= 0 ? tree : null]);
  view.marker(x, z, false);
  snd.play('click');
}
function modeClick(sx, sy) {
  const own = ownSel(), g = view.ray(sx, sy);
  if (!g) return;
  const t = pick(sx, sy);
  const ids = own.units.map((u) => u.id);
  if (ui.mode === 'attack' && ids.length) {
    if (t && t.owner >= 0 && t.owner !== game.me) { issue(['a', ids, t.id]); view.marker(t.x, t.z, true); }
    else { issue(['am', ids, q64(g.x), q64(g.z)]); view.marker(g.x, g.z, true); }
    ack();
  } else if (ui.mode === 'move' && ids.length) {
    issue(['m', ids, q64(t ? t.x : g.x), q64(t ? t.z : g.z)]); view.marker(g.x, g.z, false); ack();
  } else if (ui.mode === 'gather') {
    const wids = own.units.filter(isWorker).map((u) => u.id);
    const tree = treeAt(g);
    if (t && t.cls === 'm') { issue(['gm', wids, t.id]); view.marker(t.x, t.z, false); ack(); }
    else if (tree >= 0) { issue(['gt', wids, tree]); view.marker((tree % N) + 0.5, Math.floor(tree / N) + 0.5, false); ack(); }
    else { fail('Aranybányára vagy fára kattints.'); return; }
  } else if (ui.mode === 'rally') {
    setRally(own.blds, g, t);
  } else if (ui.mode === 'place') {
    placeBuilding(g);
    return;
  }
  if (!ui.shift) ui.mode = null;
}
function cancelMode() {
  ui.mode = null;
  ui.buildType = null;
  view.setGhost(null);
}

// ---------- building placement ----------
function ghostAt(g, type) {
  const d = BUILDINGS[type];
  return [Math.round(g.x - d.size / 2), Math.round(g.z - d.size / 2)];
}
function placeCheck(type, tx, tz) {
  const d = BUILDINGS[type], s = sim(), ok = [];
  let all = true;
  for (let z = tz; z < tz + d.size; z++) for (let x = tx; x < tx + d.size; x++) {
    const good = x >= 1 && z >= 1 && x < N - 1 && z < N - 1 && s.block[z * N + x] === FREE && view.isExplored(x, z);
    ok.push(good);
    if (!good) all = false;
  }
  let why = all ? '' : 'Ide nem lehet építeni.';
  if (all && !s.canPlace(game.me, type, tx, tz)) {
    all = false;
    why = d.hq ? 'A főépület nem lehet ilyen közel egy aranybányához.' : 'Valami útban van.';
    ok.fill(false);
  }
  return { ok, all, why };
}
function placeBuilding(g) {
  const type = ui.buildType, d = BUILDINGS[type], pl = sim().players[game.me];
  const [tx, tz] = ghostAt(g, type);
  const chk = placeCheck(type, tx, tz);
  if (!chk.all) { fail(chk.why); return; }
  if (!sim().reqMet(game.me, d)) { fail(`Ehhez előbb kell: ${BUILDINGS[d.req].name}.`); return; }
  if (pl.gold < d.cost.g) { fail('Nincs elég arany.'); return; }
  if (pl.wood < d.cost.w) { fail('Nincs elég fa.'); return; }
  const workers = ownSel().units.filter(isWorker);
  if (!workers.length) { cancelMode(); return; }
  const cx = tx + d.size / 2, cz = tz + d.size / 2;
  workers.sort((a, b) => (a.x - cx) ** 2 + (a.z - cz) ** 2 - ((b.x - cx) ** 2 + (b.z - cz) ** 2));
  issue(['b', workers[0].id, type, tx, tz]);
  view.marker(cx, cz, false);
  ack();
  if (!ui.shift) { cancelMode(); ui.menu = 'main'; }
}

// ---------- selection ----------
function clickSelect(sx, sy) {
  const t = pick(sx, sy);
  const now = performance.now();
  const dbl = t && ui.lastClick.id === t.id && now - ui.lastClick.t < 380;
  ui.lastClick = { t: now, id: t ? t.id : 0 };
  if (!t) { if (!ui.shift) setSel([]); return; }
  if (t.owner === game.me) {
    if (dbl || ui.ctrl) {
      const same = sim().ents.filter((e) => !e.dead && e.owner === game.me && e.type === t.type && e.cls === t.cls && (e.cls !== 'b' || e.done === t.done) && !(e.cls === 'u' && e.hidden) && onScreen(e));
      setSel(same.map((e) => e.id));
    } else if (ui.shift && t.cls === 'u' && ownSel().units.length === ui.sel.length) {
      setSel(ui.sel.includes(t.id) ? ui.sel.filter((id) => id !== t.id) : [...ui.sel, t.id]);
    } else setSel([t.id]);
  } else setSel([t.id]);
  snd.play('select');
}
function boxSelect(r) {
  const x0 = Math.min(r.x0, r.x1), x1 = Math.max(r.x0, r.x1), y0 = Math.min(r.y0, r.y1), y1 = Math.max(r.y0, r.y1);
  const hits = [];
  for (const e of sim().ents) {
    if (e.dead || e.cls !== 'u' || e.owner !== game.me || e.hidden) continue;
    const p0 = visualPos(e), p = view.project(p0.x, 0.4, p0.z);
    if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) hits.push(e);
  }
  if (!hits.length) return;
  // prefer the army over workers when both are in the box
  const army = hits.filter((e) => !isWorker(e));
  const pickd = (army.length && army.length < hits.length && !ui.shift ? army : hits).map((e) => e.id);
  setSel(ui.shift ? [...new Set([...ownSel().units.map((u) => u.id), ...pickd])] : pickd);
  snd.play('select');
}

// ============================================================
//  Command card
// ============================================================
const SVG = {
  move: '<path d="M4 12h14M13 6l6 6-6 6"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  hold: '<path d="M12 3l7 3v6c0 4.2-3 7.2-7 9-4-1.8-7-4.8-7-9V6z"/>',
  attack: '<path d="M14.5 3.5H20.5V9.5L9.5 20.5 3.5 14.5z"/><path d="M6 12l6 6M3 21l2.5-2.5"/>',
  gather: '<path d="M5 20L15 10"/><path d="M7.5 6.5c4-3.5 10-2.5 13 2-3.5-1.4-7-1.2-10 .8"/>',
  ret: '<path d="M4 11.5l8-7 8 7V20h-5.5v-5.5h-5V20H4z"/>',
  build: '<path d="M13 10.5L4.5 19a1.6 1.6 0 0 0 2.3 2.3l8.5-8.5"/><path d="M11 6.5l4-3 6 6-3 4z"/>',
  back: '<path d="M20 12H6M11 6l-6 6 6 6"/>',
  cancel: '<path d="M6 6l12 12M18 6L6 18"/>',
  rally: '<path d="M6 21V4"/><path d="M6 4.5h11l-2.8 3.8L17 12H6"/>',
  w: '<path d="M4 4l11 11M20 4L9 15"/><path d="M13 17l4 4M11 17l-4 4M15 15l2 2M9 15l-2 2"/>',
  a: '<path d="M12 3l7 3v6c0 4.2-3 7.2-7 9-4-1.8-7-4.8-7-9V6z"/><path d="M12 8v8M8 12h8"/>',
};
const svg = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${SVG[k]}</svg>`;

// 12 slots; each slot: { icon, img, name, desc, cost, food, req, disabled, on, lvl, alias, act }
function buildCard() {
  const card = new Array(12).fill(null);
  if (!game || game.mode === 'demo') return card;
  const s = sim(), pl = s.players[game.me], race = RACES[myRace()];
  const own = ownSel(), icons = iconsFor(game.me);
  if (own.units.length) {
    const workers = own.units.filter(isWorker);
    if (ui.menu === 'build' && workers.length) {
      race.buildings.forEach((type, k) => {
        const d = BUILDINGS[type];
        card[k] = {
          img: icons[type], name: d.name, desc: d.desc, cost: d.cost, req: s.reqMet(game.me, d) ? null : d.req, on: ui.mode === 'place' && ui.buildType === type,
          act: () => { if (!s.reqMet(game.me, d)) { fail(`Ehhez előbb kell: ${BUILDINGS[d.req].name}.`); return; } ui.mode = 'place'; ui.buildType = type; },
        };
      });
      card[11] = { icon: 'back', name: 'Vissza', desc: 'Vissza a parancsokhoz.', alias: ['Escape'], act: () => { ui.menu = 'main'; cancelMode(); } };
      return card;
    }
    card[0] = { icon: 'move', name: 'Mozgás', desc: 'Kattints oda, ahová menjenek. Útközben nem támadnak. (Jobb klikk is jó.)', alias: ['M'], on: ui.mode === 'move', act: () => { ui.mode = 'move'; } };
    card[1] = { icon: 'hold', name: 'Tartsd a helyed', desc: 'Nem mozdulnak el, de amit elérnek, azt megtámadják.', alias: ['H'], act: () => { issue(['h', own.units.map((u) => u.id)]); ack(); } };
    card[4] = { icon: 'attack', name: 'Támadás', desc: 'Kattints egy ellenségre, vagy a földre: oda menet mindenkit megtámadnak, akit útba ejtenek.', on: ui.mode === 'attack', act: () => { ui.mode = 'attack'; } };
    card[5] = { icon: 'stop', name: 'Állj', desc: 'Abbahagyják, amit csinálnak.', act: () => { issue(['s', own.units.map((u) => u.id)]); ack(); } };
    if (workers.length) {
      card[8] = { icon: 'gather', name: 'Gyűjtés', desc: 'Kattints egy aranybányára vagy egy fára. (Jobb klikk is jó.)', alias: ['G'], on: ui.mode === 'gather', act: () => { ui.mode = 'gather'; } };
      if (workers.some((w) => w.carry)) card[9] = { icon: 'ret', name: 'Leadás', desc: 'A rakományt a legközelebbi főépülethez viszik.', act: () => { issue(['rt', workers.filter((w) => w.carry).map((w) => w.id)]); ack(); } };
      card[10] = { icon: 'build', name: 'Építés', desc: 'Épület választása, aztán a helye.', alias: ['B'], act: () => { ui.menu = 'build'; } };
    }
    return card;
  }
  if (own.blds.length) {
    const b = own.blds[0], d = BUILDINGS[b.type];
    if (!b.done) {
      card[11] = { icon: 'cancel', name: 'Építés megszakítása', desc: 'Az épület eltűnik, a költség 75%-át visszakapod.', act: () => { issue(['x', b.id]); snd.play('click'); } };
      return card;
    }
    const pickB = () => own.blds.filter((x) => x.done).sort((a, c) => a.queue.length - c.queue.length)[0];
    for (const type of d.trains || []) {
      const u = UNITS[type];
      card[u.slot] = {
        img: icons[type], name: u.name, desc: u.desc, cost: u.cost, food: u.food, req: s.reqMet(game.me, u) ? null : u.req,
        act: () => {
          const n = ui.shift ? 5 : 1;
          for (let k = 0; k < n; k++) issue(['t', pickB().id, type]);
          snd.play('click');
        },
      };
    }
    (d.research || []).forEach((key, k) => {
      const up = UPGRADES[key], lvl = pl.up[key], busy = pl.upq[key];
      const done = lvl >= 2;
      card[4 + k] = {
        icon: key, name: `${up.name[myRace()]} ${done ? 'II' : lvl === 0 ? 'I' : 'II'}`, desc: done ? 'Mindkét szint kész.' : busy ? 'Most fejlesztik.' : up.desc,
        cost: done || busy ? null : up.cost[lvl], lvl: `${lvl}/2`, disabled: done || busy,
        act: () => { issue(['u', b.id, key]); snd.play('click'); },
      };
    });
    if (d.trains) card[8] = { icon: 'rally', name: 'Gyülekezőpont', desc: 'Ide mennek az új egységek. Munkásoknál: bányára vagy fára téve egyből dolgozni kezdenek. (Jobb klikk is jó.)', on: ui.mode === 'rally', act: () => { ui.mode = 'rally'; } };
    if (b.queue.length) card[11] = { icon: 'cancel', name: 'Visszavonás', desc: 'A sor utolsó elemét törli, a költséget visszakapod.', act: () => { issue(['x', b.id]); snd.play('click'); } };
  }
  return card;
}
const cmdEls = [];
function initCard() {
  const box = $('cmds');
  for (let i = 0; i < 12; i++) {
    const b = document.createElement('button');
    b.className = 'cmd empty';
    b.dataset.i = i;
    b.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      runSlot(i);
    });
    b.addEventListener('pointerenter', () => { ui.tipSlot = i; showTip(); });
    b.addEventListener('pointerleave', () => { if (ui.tipSlot === i) { ui.tipSlot = -1; showTip(); } });
    box.appendChild(b);
    cmdEls.push(b);
  }
}
function runSlot(i) {
  const c = ui.card[i];
  if (!c || c.disabled) return;
  if (c.req) { fail(`Ehhez előbb kell: ${BUILDINGS[c.req].name}.`); return; }
  c.act();
  // rebuild right away so a quick second key press (C then W) hits the new card
  renderCard();
}
function renderCard() {
  ui.card = buildCard();
  for (let i = 0; i < 12; i++) {
    const c = ui.card[i], el = cmdEls[i];
    const sig = c ? [c.name, c.img ? 1 : c.icon, !!c.disabled, !!c.on, !!c.req, c.lvl || ''].join('|') : '';
    if (ui.cardSig[i] === sig) continue;
    ui.cardSig[i] = sig;
    if (!c) { el.className = 'cmd empty'; el.innerHTML = ''; el.disabled = true; continue; }
    el.className = 'cmd' + (c.on ? ' on' : '');
    el.disabled = !!c.disabled || !!c.req;
    el.innerHTML = (c.img ? `<img src="${c.img}" alt="">` : svg(c.icon)) + `<span class="hk">${GRID_KEYS[i]}</span>` + (c.lvl ? `<span class="lvl">${c.lvl}</span>` : '');
    el.setAttribute('aria-label', c.name);
    // keep requirement buttons hoverable for the tooltip
    if (c.req) { el.disabled = false; el.style.filter = 'grayscale(.9) brightness(.55)'; } else el.style.filter = '';
  }
  showTip();
}
function showTip() {
  const tip = $('tip'), c = ui.tipSlot >= 0 ? ui.card[ui.tipSlot] : null;
  if (!c) { tip.hidden = true; return; }
  const pl = sim().players[game.me];
  let cost = '';
  if (c.cost) {
    const g = `<span class="${pl.gold < c.cost.g ? 'no' : ''}">${c.cost.g} arany</span>`;
    const w = c.cost.w ? `<span class="${pl.wood < c.cost.w ? 'no' : ''}">${c.cost.w} fa</span>` : '';
    const f = c.food ? `<span class="${pl.food + c.food > pl.cap ? 'no' : ''}">${c.food} élelem</span>` : '';
    cost = `<div class="cost">${g}${w}${f}</div>`;
  }
  const req = c.req ? `<p class="req">Ehhez előbb kell: ${BUILDINGS[c.req].name}</p>` : '';
  const html = `<h4><span>${esc(c.name)}</span><kbd>${GRID_KEYS[ui.tipSlot]}</kbd></h4>${cost}<p>${esc(c.desc || '')}</p>${req}`;
  if (tip.innerHTML !== html) tip.innerHTML = html;
  tip.hidden = false;
}

// ============================================================
//  Selection panel
// ============================================================
const ORDER_TXT = (e) => {
  const o = e.ord;
  if (e.hidden) return 'Bányászik';
  switch (o.t) {
    case 'gather': return o.s === 'back' ? 'Viszi a rakományt' : o.res === 'g' ? 'Aranyat bányászik' : o.s === 'work' ? 'Fát vág' : 'Fáért megy';
    case 'build': return 'Építeni megy';
    case 'help': return 'Épít';
    case 'attack': return 'Támad';
    case 'amove': return 'Támadó menet';
    case 'move': return 'Mozog';
    case 'hold': return 'Tartja a helyét';
    default: return 'Pihen';
  }
};
const hpColor = (k) => (k > 0.6 ? '#8fd66a' : k > 0.3 ? '#e7c14a' : '#e5533c');
function ownerTxt(e) {
  if (e.owner < 0) return 'Semleges';
  const race = RACES[game.races[e.owner]].name;
  return e.owner === game.me ? `Te · ${race}` : `${esc(game.names[e.owner])} · ${race}`;
}
function renderInfo() {
  const box = $('info'), es = selEnts();
  const icons = iconsFor(game.me), eicons = iconsFor(1 - game.me);
  const iconOf = (e) => (e.owner === game.me ? icons : e.owner < 0 ? icons : eicons)[e.type];
  let html;
  if (!es.length) {
    html = `<div class="hint">Jelölj ki egységeket bal klikkel vagy egérhúzással, aztán <kbd>jobb klikk</kbd>: mozgás, támadás, gyűjtés. A munkásokkal az <kbd>Építés</kbd> gombbal építhetsz.</div>`;
  } else if (es.length === 1) {
    const e = es[0], s = sim();
    if (e.cls === 'm') {
      html = `<div class="portrait"><img src="${icons.mine}" alt=""></div><div class="idet"><div class="iname">Aranybánya</div><div class="iowner">Semleges</div>
        <div class="stats"><span>Arany: <b>${e.gold}</b></span>${e.inside ? `<span>Bent dolgozik: <b>${e.inside}</b></span>` : ''}</div></div>`;
    } else {
      const d = e.cls === 'u' ? UNITS[e.type] : BUILDINGS[e.type];
      const hpk = e.hp / d.hp;
      let extra = '';
      if (e.cls === 'u') {
        const pl = s.players[e.owner], mil = !d.worker;
        const dmg = d.dmg + (mil ? pl.up.w * 2 : 0), arm = d.armor + (mil ? pl.up.a : 0);
        extra = `<div class="stats"><span>Sebzés <b>${dmg}</b></span><span>Páncél <b>${arm}</b></span><span>Hatótáv <b>${d.range < 1 ? 'közel' : d.range}</b></span>${d.splash ? '<span><b>területre</b></span>' : ''}${d.chain ? '<span><b>láncvillám</b></span>' : ''}</div>`;
        if (e.owner === game.me) extra += `<div class="stats"><span>${ORDER_TXT(e)}</span>${e.carry ? `<span>Visz: <b>${e.carry} ${e.cres === 'g' ? 'arany' : 'fa'}</b></span>` : ''}</div>`;
      } else if (!e.done) {
        extra = `<div class="stats"><span>Épül: <b>${Math.floor(e.prog * 100)}%</b></span>${e.owner === game.me && !e.bt && !s.ents.some((u) => u.cls === 'u' && u.ord.t === 'help' && u.ord.id === e.id) ? '<span style="color:#e5533c">Nem dolgozik rajta senki</span>' : ''}</div><div class="prog"><div style="width:${e.prog * 100}%"></div></div>`;
      } else if (e.owner === game.me && e.queue.length) {
        const it = e.queue[0];
        const tt = it.u ? UNITS[it.u].time : UPGRADES[it.up].time[it.lvl];
        const p = Math.min(1, (e.qt * TICK) / tt);
        const qi = (q, first) => `<div class="qitem${first ? ' first' : ''}">${q.u ? `<img src="${icons[q.u]}" alt="">` : svg(q.up)}${first ? `<div class="qp" style="width:${p * 100}%"></div>` : ''}</div>`;
        extra = `<div class="queue">${e.queue.map((q, k) => qi(q, k === 0)).join('')}${'<div class="qitem" style="opacity:.25"></div>'.repeat(QUEUE_MAX - e.queue.length)}</div>`;
      } else {
        const st = [];
        if (d.food) st.push(`<span>Élelem: <b>+${d.food}</b></span>`);
        if (d.drop) st.push('<span>Ide hordják az aranyat és a fát</span>');
        if (d.attack) st.push(`<span>Sebzés <b>${d.attack.dmg}</b></span><span>Hatótáv <b>${d.attack.range}</b></span>`);
        st.push(`<span>Páncél <b>${d.armor}</b></span>`);
        if (d.research && e.owner === game.me) {
          const pl = s.players[game.me];
          for (const k of d.research) st.push(`<span>${UPGRADES[k].name[myRace()]}: <b>${pl.up[k]}/2</b></span>`);
        }
        extra = `<div class="stats">${st.join('')}</div>`;
      }
      html = `<div class="portrait"><img src="${iconOf(e)}" alt=""></div><div class="idet"><div class="iname">${d.name}</div><div class="iowner">${ownerTxt(e)}</div>
        <div class="hpbar"><div style="width:${clamp(hpk, 0, 1) * 100}%;background:${hpColor(hpk)}"></div></div><div class="hptxt num">${Math.ceil(e.hp)} / ${d.hp} életerő</div>${extra}</div>`;
    }
  } else {
    html = '<div class="multi">' + es.slice(0, 36).map((e) => {
      const d = UNITS[e.type] || BUILDINGS[e.type], k = clamp(e.hp / d.hp, 0, 1);
      return `<div class="mcell" data-id="${e.id}" title="${d.name}"><img src="${iconOf(e)}" alt=""><div class="mh"><div style="width:${k * 100}%;background:${hpColor(k)}"></div></div></div>`;
    }).join('') + '</div>';
  }
  if (html !== ui.infoSig) { ui.infoSig = html; box.innerHTML = html; }
}
$('info').addEventListener('pointerdown', (e) => {
  const c = e.target.closest('.mcell');
  if (!c || !game) return;
  const id = Number(c.dataset.id);
  if (e.shiftKey) setSel(ui.sel.filter((x) => x !== id)); else setSel([id]);
  snd.play('select');
});

// ============================================================
//  HUD, minimap, overlay
// ============================================================
let hudCache = {};
function setText(id, v) { if (hudCache[id] !== v) { hudCache[id] = v; $(id).textContent = v; } }
function updateHUD() {
  const s = sim(), pl = s.players[game.me];
  setText('rGold', String(pl.gold));
  setText('rWood', String(pl.wood));
  setText('rFood', `${pl.food}/${pl.cap}`);
  $('rFoodBox').classList.toggle('warn', pl.food >= pl.cap && pl.cap < FOOD_MAX);
  setText('clock', fmtClock(s.tick * TICK));
  $('wait').hidden = !(game.mode === 'mp' && game.waitT > 1.2);
}

const mm = { cv: $('minimap'), base: document.createElement('canvas'), fog: document.createElement('canvas'), dirty: true, t: 0 };
mm.g = mm.cv.getContext('2d');
mm.base.width = mm.base.height = N;
mm.fog.width = mm.fog.height = N;
mm.bg = mm.base.getContext('2d');
mm.fg = mm.fog.getContext('2d');
mm.fogImg = mm.fg.createImageData(N, N);
function minimapBase() {
  const s = sim(), img = mm.bg.createImageData(N, N);
  for (let i = 0; i < N * N; i++) {
    const b = s.block[i];
    let r = 74, g = 108, bl = 44;
    if (b === TREE) { r = 30; g = 62; bl = 26; } else if (b === ROCK) { r = 120; g = 116; bl = 106; }
    const n = ((i * 2654435761) >>> 24) / 255 * 10 - 5;
    img.data[i * 4] = r + n; img.data[i * 4 + 1] = g + n; img.data[i * 4 + 2] = bl + n; img.data[i * 4 + 3] = 255;
  }
  mm.bg.putImageData(img, 0, 0);
}
function minimapTree(i) {
  mm.bg.fillStyle = 'rgb(74,108,44)';
  mm.bg.fillRect(i % N, Math.floor(i / N), 1, 1);
}
function drawMinimap() {
  const g = mm.g, s = sim(), K = mm.cv.width / N;
  g.imageSmoothingEnabled = false;
  g.drawImage(mm.base, 0, 0, mm.cv.width, mm.cv.height);
  const d = mm.fogImg.data, cur = view.fogCur;
  for (let i = 0; i < N * N; i++) d[i * 4 + 3] = (1 - Math.min(1, cur[i])) * 235;
  mm.fg.putImageData(mm.fogImg, 0, 0);
  g.imageSmoothingEnabled = true;
  g.drawImage(mm.fog, 0, 0, mm.cv.width, mm.cv.height);
  const selSet = new Set(ui.sel);
  for (const e of s.ents) {
    if (e.dead) continue;
    if (e.cls === 'm') { if (view.isExplored(e.tx + 1, e.tz + 1)) { g.fillStyle = '#f2c94c'; g.fillRect(e.tx * K, e.tz * K, 3 * K, 3 * K); } continue; }
    if (!view.canSee(e) || (e.cls === 'u' && e.hidden)) continue;
    g.fillStyle = selSet.has(e.id) ? '#ffffff' : TEAM_CSS[e.owner];
    if (e.cls === 'b') g.fillRect(e.tx * K, e.tz * K, e.size * K, e.size * K);
    else g.fillRect(e.x * K - 2, e.z * K - 2, 4, 4);
  }
  // camera frame
  const f = view.frustum(barH());
  g.strokeStyle = 'rgba(255,255,255,.85)';
  g.lineWidth = 1.5;
  g.beginPath();
  f.forEach((p, k) => (k ? g.lineTo(p.x * K, p.z * K) : g.moveTo(p.x * K, p.z * K)));
  g.closePath();
  g.stroke();
  if (ui.ping) {
    const t = (performance.now() - ui.ping.t) / 1000;
    if (t > 3) ui.ping = null;
    else {
      g.strokeStyle = `rgba(255,70,50,${1 - t / 3})`;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(ui.ping.x * K, ui.ping.z * K, 4 + ((t * 18) % 18), 0, Math.PI * 2);
      g.stroke();
    }
  }
}
function minimapPoint(e) {
  const r = mm.cv.getBoundingClientRect();
  return { x: clamp(((e.clientX - r.left) / r.width) * N, 0, N), z: clamp(((e.clientY - r.top) / r.height) * N, 0, N) };
}
mm.cv.addEventListener('pointerdown', (e) => {
  if (!inGame()) return;
  e.preventDefault();
  const p = minimapPoint(e);
  if (e.button === 0) {
    if (ui.mode && ui.mode !== 'place') {
      const own = ownSel(), ids = own.units.map((u) => u.id);
      if (ui.mode === 'attack' && ids.length) { issue(['am', ids, q64(p.x), q64(p.z)]); ack(); }
      else if (ui.mode === 'move' && ids.length) { issue(['m', ids, q64(p.x), q64(p.z)]); ack(); }
      else if (ui.mode === 'rally') setRally(own.blds, p, null);
      if (!ui.shift) ui.mode = null;
      return;
    }
    centerOn(p.x, p.z);
    mm.dragging = true;
    mm.cv.setPointerCapture(e.pointerId);
  } else if (e.button === 2) {
    const own = ownSel();
    if (own.units.length) { issue(['m', own.units.map((u) => u.id), q64(p.x), q64(p.z)]); view.marker(p.x, p.z, false); ack(); }
    else if (own.blds.some((b) => b.done && BUILDINGS[b.type].trains)) setRally(own.blds.filter((b) => b.done && BUILDINGS[b.type].trains), p, null);
  }
});
mm.cv.addEventListener('pointermove', (e) => { if (mm.dragging) { const p = minimapPoint(e); centerOn(p.x, p.z); } });
mm.cv.addEventListener('pointerup', () => { mm.dragging = false; });
mm.cv.addEventListener('contextmenu', (e) => e.preventDefault());

// screen point -> camera so that the ground point lands mid-screen above the command bar
function centerOn(x, z) {
  view.cam.x = x;
  view.cam.z = z + view.cam.dist * 0.08;
}

function drawOverlay() {
  const dpr = Math.min(devicePixelRatio, 2);
  if (overlay.width !== Math.round(innerWidth * dpr) || overlay.height !== Math.round(innerHeight * dpr)) {
    overlay.width = Math.round(innerWidth * dpr); overlay.height = Math.round(innerHeight * dpr);
  }
  const g = octx;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, innerWidth, innerHeight);
  if (!inGame()) return;
  const s = sim(), sel = new Set(ui.sel);
  const bar = (x, y, w, k, col) => {
    g.fillStyle = 'rgba(0,0,0,.65)';
    g.fillRect(x - w / 2 - 1, y - 1, w + 2, 6);
    g.fillStyle = col;
    g.fillRect(x - w / 2, y, w * clamp(k, 0, 1), 4);
  };
  for (const e of s.ents) {
    if (e.dead || e.cls === 'm') continue;
    const d = e.cls === 'u' ? UNITS[e.type] : BUILDINGS[e.type];
    const show = sel.has(e.id) || ui.hover === e || e.hp < d.hp || (e.cls === 'b' && !e.done);
    if (!show || (e.cls === 'u' && e.hidden) || !view.canSee(e)) continue;
    const v = view.views.get(e.id);
    if (!v || !v.root.visible) continue;
    if (e.cls === 'u') {
      const p = view.project(v.root.position.x, d.r >= 0.5 ? 1.35 : 1.05, v.root.position.z);
      if (!p.front) continue;
      bar(p.x, p.y - 6, clamp(e.r * ui.ppu * 1.8, 22, 56), e.hp / d.hp, hpColor(e.hp / d.hp));
    } else {
      const p = view.project(e.x, e.size * 0.95 + 0.6, e.z);
      if (!p.front) continue;
      const w = clamp(e.size * ui.ppu * 0.7, 40, 140);
      bar(p.x, p.y, w, e.hp / d.hp, hpColor(e.hp / d.hp));
      if (!e.done) bar(p.x, p.y + 8, w, e.prog, '#d6a847');
    }
  }
  if (ui.drag && ui.drag.active) {
    const r = ui.drag;
    g.strokeStyle = '#8fd66a';
    g.lineWidth = 1.5;
    g.fillStyle = 'rgba(143,214,106,.08)';
    g.fillRect(Math.min(r.x0, r.x1), Math.min(r.y0, r.y1), Math.abs(r.x1 - r.x0), Math.abs(r.y1 - r.y0));
    g.strokeRect(Math.min(r.x0, r.x1), Math.min(r.y0, r.y1), Math.abs(r.x1 - r.x0), Math.abs(r.y1 - r.y0));
  }
}

// ============================================================
//  Simulation events -> sound, messages
// ============================================================
function vol(x, z) {
  const dx = x - view.cam.x, dz = z - (view.cam.z - view.cam.dist * 0.15);
  const d = Math.sqrt(dx * dx + dz * dz);
  return clamp(1.15 - d / 24, 0, 1) * clamp(40 / view.cam.dist, 0.5, 1);
}
const ATK_SND = { melee: 'sword', arrow: 'arrow', axe: 'throw', spear: 'throw', fire: 'fire', zap: 'zap', bolt: 'bolt', rock: 'launch' };
function onEvent(ev) {
  view.event(ev);
  if (game.mode === 'demo') return;
  const s = game.sim, mine = ev.p === game.me;
  switch (ev.e) {
    case 'msg': if (mine) fail(ev.text); break;
    case 'alert':
      if (!mine) break;
      ui.alert = { x: ev.x, z: ev.z };
      ui.ping = { x: ev.x, z: ev.z, t: performance.now() };
      say('Támadás ér! (Szóköz: odaugrás)', 'alert');
      snd.play('alert');
      break;
    case 'built': if (mine) { const b = s.byId.get(ev.id); say(`Elkészült: ${b ? BUILDINGS[b.type].name : 'épület'}`, 'good'); snd.play('built'); } break;
    case 'research': if (mine) { say(`Kifejlesztve: ${UPGRADES[ev.key].name[myRace()]} ${ev.lvl === 1 ? 'I' : 'II'}`, 'good'); snd.play('built'); } break;
    case 'trained': if (mine) snd.play('ready', 0.7); break;
    case 'place': if (mine) snd.play('hammer'); break;
    case 'atk': {
      const a = s.byId.get(ev.id);
      if (!a || (!view.canSee(a) && a.owner !== game.me)) break;
      let k = ATK_SND[ev.k] || 'sword';
      if (k === 'sword' && game.races[a.owner] === 'orc') k = 'axe';
      snd.play(k, vol(a.x, a.z) * 0.8);
      break;
    }
    case 'impact': if ((ev.k === 'fire' || ev.k === 'rock') && view.isVis(ev.x, ev.z)) snd.play('boom', vol(ev.x, ev.z) * (ev.k === 'rock' ? 1 : 0.7)); break;
    case 'die':
      if (ev.silent || (!view.isVis(ev.x, ev.z) && ev.owner !== game.me)) break;
      if (ev.cls === 'u') snd.play('die', vol(ev.x, ev.z));
      else if (ev.cls === 'b') snd.play('collapse', vol(ev.x, ev.z));
      if (ev.cls === 'b' && ev.owner === game.me) say(`Elveszett: ${BUILDINGS[ev.type].name}`, 'bad');
      break;
    case 'chop': { const u = s.byId.get(ev.id); if (u && view.isVis(u.x, u.z)) snd.play('chop', vol(u.x, u.z) * 0.5); break; }
    case 'hammer': { const u = s.byId.get(ev.id); if (u && view.isVis(u.x, u.z)) snd.play('hammer', vol(u.x, u.z) * 0.5); break; }
    case 'drop': if (mine && ev.res === 'g') { const u = s.byId.get(ev.id); if (u) snd.play('coin', vol(u.x, u.z) * 0.5); } break;
    case 'tree': minimapTree(ev.i); break;
    case 'end': onGameEnd(ev.w); break;
  }
}
function onGameEnd(w, why) {
  const g = game;
  if (!g || g.mode === 'demo' || g.endT >= 0) return;
  g.endT = performance.now();
  g.winnerSlot = w;
  view.reveal = true;
  view.computeVis(false);
  const win = w === g.me;
  setTimeout(() => {
    if (game !== g) return;
    snd.play(win ? 'win' : w === 2 ? 'click' : 'lose');
    showResult(w, why);
  }, why ? 300 : 2600);
}

// ============================================================
//  Input
// ============================================================
const cv = $('view');
cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('pointerdown', (e) => {
  snd.init();
  if (!inGame()) return;
  ui.mouse.x = e.clientX; ui.mouse.y = e.clientY;
  if (e.button === 0) {
    if (ui.mode) { modeClick(e.clientX, e.clientY); return; }
    ui.drag = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY, active: false };
    cv.setPointerCapture(e.pointerId);
  } else if (e.button === 2) {
    if (ui.mode) { cancelMode(); return; }
    rightClick(e.clientX, e.clientY);
  } else if (e.button === 1) {
    e.preventDefault();
    ui.pan = { x: e.clientX, y: e.clientY };
    cv.setPointerCapture(e.pointerId);
  }
});
window.addEventListener('pointermove', (e) => {
  ui.mouse.x = e.clientX; ui.mouse.y = e.clientY; ui.mouse.in = true;
  if (ui.drag) {
    ui.drag.x1 = e.clientX; ui.drag.y1 = e.clientY;
    if (Math.abs(ui.drag.x1 - ui.drag.x0) + Math.abs(ui.drag.y1 - ui.drag.y0) > 6) ui.drag.active = true;
  }
  if (ui.pan) {
    const k = view.cam.dist / 900;
    view.cam.x -= (e.clientX - ui.pan.x) * k * 1.6;
    view.cam.z -= (e.clientY - ui.pan.y) * k * 2.1;
    ui.pan.x = e.clientX; ui.pan.y = e.clientY;
  }
});
window.addEventListener('pointerup', (e) => {
  if (e.button === 1) ui.pan = null;
  if (e.button !== 0 || !ui.drag) return;
  const d = ui.drag;
  ui.drag = null;
  if (!inGame()) return;
  if (d.active) boxSelect(d); else clickSelect(d.x0, d.y0);
});
document.addEventListener('pointerleave', () => { ui.mouse.in = false; });
document.addEventListener('mouseout', (e) => { if (!e.relatedTarget) ui.mouse.in = false; });
cv.addEventListener('wheel', (e) => {
  e.preventDefault();
  const c = view.cam;
  c.dist = clamp(c.dist * Math.pow(1.1, Math.sign(e.deltaY) * Math.min(3, Math.abs(e.deltaY) / 60)), 14, 50);
}, { passive: false });

window.addEventListener('keydown', (e) => {
  ui.shift = e.shiftKey; ui.ctrl = e.ctrlKey || e.metaKey;
  if (e.target instanceof HTMLInputElement) return;
  if (!game || game.mode === 'demo') return;
  const k = e.key;
  if (k === 'F10' || (k === 'Escape' && !ui.mode && ui.menu !== 'build')) {
    e.preventDefault();
    if (!$('pause').hidden) resumeGame(); else if (inGame()) openPause();
    return;
  }
  if (!inGame()) return;
  if (k.startsWith('Arrow')) { ui.keys.add(k); e.preventDefault(); return; }
  if (k === 'Escape') {
    if (ui.mode) { cancelMode(); return; }
    const slot = ui.card.findIndex((c) => c && c.alias && c.alias.includes('Escape'));
    if (slot >= 0) runSlot(slot);
    return;
  }
  if (k === ' ') {
    e.preventDefault();
    if (ui.alert) centerOn(ui.alert.x, ui.alert.z);
    return;
  }
  if (/^[0-9]$/.test(k)) {
    e.preventDefault();
    const n = Number(k);
    if (ui.ctrl) { ui.groups[n] = ownSel().all.filter((x) => x.owner === game.me).map((x) => x.id); say(`${n}. csapat elmentve`); return; }
    const ids = (ui.groups[n] || []).filter((id) => sim().get(id));
    if (!ids.length) return;
    const now = performance.now();
    if (ui.lastGroup.n === n && now - ui.lastGroup.t < 400) {
      let x = 0, z = 0;
      for (const id of ids) { const u = sim().get(id); x += u.x; z += u.z; }
      centerOn(x / ids.length, z / ids.length);
    }
    ui.lastGroup = { n, t: now };
    setSel(ids);
    snd.play('select');
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const key = k.length === 1 ? k.toUpperCase() : k;
  let slot = GRID_KEYS.indexOf(key);
  if (slot < 0 || !ui.card[slot]) slot = ui.card.findIndex((c) => c && c.alias && c.alias.includes(key));
  if (slot >= 0 && ui.card[slot]) { e.preventDefault(); runSlot(slot); }
});
window.addEventListener('keyup', (e) => {
  ui.shift = e.shiftKey; ui.ctrl = e.ctrlKey || e.metaKey;
  ui.keys.delete(e.key);
});
window.addEventListener('blur', () => { ui.keys.clear(); ui.shift = ui.ctrl = false; ui.drag = null; ui.pan = null; });
window.addEventListener('resize', () => view.resize());

function updateCamera(dt) {
  const c = view.cam, sp = c.dist * 1.15 * dt;
  let dx = 0, dz = 0;
  if (ui.keys.has('ArrowLeft')) dx -= 1;
  if (ui.keys.has('ArrowRight')) dx += 1;
  if (ui.keys.has('ArrowUp')) dz -= 1;
  if (ui.keys.has('ArrowDown')) dz += 1;
  if (ui.mouse.in && document.hasFocus() && !ui.drag && !ui.pan && !mm.dragging) {
    const m = 5;
    if (ui.mouse.x <= m) dx -= 1;
    if (ui.mouse.x >= innerWidth - m) dx += 1;
    if (ui.mouse.y <= m) dz -= 1;
    if (ui.mouse.y >= innerHeight - m) dz += 1;
  }
  c.x += dx * sp;
  c.z += dz * sp;
}

// ============================================================
//  Menus, room, results
// ============================================================
const MP = { room: null, myReady: false, peer: null, inGame: false, joinT: 0, note: '', noteT: 0, early: [] };
const nameInput = $('nameInput'), codeInput = $('codeInput');
nameInput.value = store.get('name', '');
let myRaceSel = store.get('race', 'human') === 'orc' ? 'orc' : 'human';
let diffSel = clamp(Number(store.get('diff', '1')) | 0, 0, 2);
function myName() {
  const n = cleanName(nameInput.value);
  store.set('name', n);
  return n;
}
function showScreen(id) {
  for (const s of ['menu', 'room', 'pause', 'result']) $(s).hidden = s !== id;
}
function syncSeg(segId, v) { $(segId).querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === String(v)))); }
function bindSeg(segId, onPick) {
  $(segId).querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { if (b.disabled) return; snd.init(); snd.play('click'); onPick(b.dataset.v); }));
}
function menuNote(text, warn) {
  const el = $('inviteNote');
  el.textContent = text;
  el.hidden = !text;
  el.style.color = warn ? 'var(--bad)' : '';
}
function readInvite() {
  const code = location.hash.replace('#', '').toUpperCase();
  if (MP.room || !/^[A-Z]{4}$/.test(code)) return;
  codeInput.value = code;
  $('joinBtn').classList.add('hot');
  menuNote('Meghívtak egy szobába: írd be a neved, és nyomj a BELÉPÉS gombra.');
}
// The menu background is a computer-vs-computer battle, started a few minutes in so there is something to watch.
function startDemo() {
  const races = Math.random() < 0.5 ? ['human', 'orc'] : ['orc', 'human'];
  startGame({ mode: 'demo', seed: Math.floor(Math.random() * 2 ** 31), races, names: ['', ''], me: 0, pre: 2600 + Math.floor(Math.random() * 1200) });
}
function showMenu() {
  if (!game || game.mode !== 'demo') startDemo();
  $('hud').hidden = true;
  showScreen('menu');
  syncSeg('raceSeg', myRaceSel);
  syncSeg('diffSeg', diffSel);
}
function startGame(o) {
  game = new Game(o);
  const demo = o.mode === 'demo';
  for (let k = 0; k < (o.pre || 0) && game.sim.winner < 0; k++) { game.step(); game.sim.events.length = 0; }
  view.setWorld(game.sim, demo ? -1 : o.me);
  if (demo) { view.reveal = true; view.computeVis(true); }
  Object.assign(ui, { sel: [], groups: {}, mode: null, buildType: null, menu: 'main', drag: null, alert: null, ping: null, cardSig: [], infoSig: '', tipSlot: -1 });
  view.setGhost(null);
  hudCache = {};
  minimapBase();
  $('desync').hidden = true;
  $('msgs').innerHTML = '';
  if (demo) {
    view.cam.dist = 30;
    Object.assign(demoCam, { t: Math.random() * 100, next: 0, snap: true, endT: 0 });
    return;
  }
  const hq = game.sim.ents.find((e) => e.cls === 'b' && e.owner === o.me);
  view.cam.dist = 30;
  centerOn(hq.x + (o.me === 0 ? 3 : -3), hq.z + (o.me === 0 ? 3 : -3));
  $('hud').hidden = false;
  showScreen(null);
  const sw = (slot) => `<span class="sw" style="background:${TEAM_CSS[slot]}"></span>`;
  $('versus').innerHTML = `${sw(o.me)}<span>${esc(o.names[o.me])} · ${RACES[o.races[o.me]].name}</span><span class="vs">ellen</span>${sw(1 - o.me)}<span>${esc(o.names[1 - o.me])} · ${RACES[o.races[1 - o.me]].name}</span>`;
  iconsFor(o.me); iconsFor(1 - o.me);
  snd.init();
  renderCard();
  say(o.mode === 'mp' ? 'Kezdődik a csata!' : 'Kezdődik a csata! A munkásaid már bányásznak.', 'good');
}
const demoCam = { t: 0, next: 0, x: N / 2, z: N / 2, snap: true, endT: 0 };
function updateDemoCam(dt) {
  const s = game.sim;
  if (s.winner >= 0 && (demoCam.endT += dt) > 6) { startDemo(); return; }
  // every few seconds look at a fight, or at someone's base when nobody is fighting
  if ((demoCam.next -= dt) <= 0) {
    demoCam.next = 10;
    const fights = s.ents.filter((e) => e.cls === 'u' && !e.dead && !e.hidden && e.ord.t === 'attack');
    const pool = fights.length ? fights : s.ents.filter((e) => e.cls === 'b' && !e.dead);
    const f = pool[Math.floor(Math.random() * pool.length)];
    if (f) { demoCam.x = f.x; demoCam.z = f.z; }
  }
  demoCam.t += dt;
  // the menu panel covers the left of the screen, so keep the action right of centre
  const gx = demoCam.x - 7 + Math.sin(demoCam.t * 0.13) * 3, gz = demoCam.z + 2.5 + Math.cos(demoCam.t * 0.11) * 2;
  const k = demoCam.snap ? 1 : 1 - Math.exp(-dt * 0.5);
  demoCam.snap = false;
  view.cam.x += (gx - view.cam.x) * k;
  view.cam.z += (gz - view.cam.z) * k;
}
function startSolo() {
  snd.init();
  store.set('race', myRaceSel);
  store.set('diff', diffSel);
  const ai = Math.random() < 0.5 ? 'human' : 'orc';
  const meSlot = Math.random() < 0.5 ? 0 : 1;
  const races = meSlot === 0 ? [myRaceSel, ai] : [ai, myRaceSel];
  const names = ['', ''];
  names[meSlot] = myName();
  names[1 - meSlot] = ['Könnyű gép', 'Gép', 'Nehéz gép'][diffSel];
  startGame({ mode: 'solo', seed: Math.floor(Math.random() * 2 ** 31), races, names, me: meSlot, level: diffSel });
}
function openPause() {
  if (!game || game.mode === 'demo') return;
  if (game.mode === 'solo') game.paused = true;
  $('pauseHead').textContent = game.mode === 'solo' ? 'Szünet' : 'Menü';
  $('pauseNote').textContent = game.mode === 'mp' ? 'A csata közben tovább folyik.' : '';
  $('soundBtn').textContent = snd.muted ? 'HANG: KI' : 'HANG: BE';
  $('ggBtn').hidden = game.sim.winner >= 0;
  showScreen('pause');
}
function resumeGame() {
  if (!game) return;
  game.paused = false;
  showScreen(null);
}
function showResult(w, why) {
  const g = game, s = g.sim, meS = g.me, op = 1 - meS;
  const win = w === meS;
  const head = $('resHead');
  head.textContent = w === 2 ? 'Döntetlen' : win ? 'Győzelem' : 'Vereség';
  head.className = 'res-head ' + (w === 2 ? '' : win ? 'win' : 'lose');
  $('resSub').textContent = why || (win ? `Az ellenfél minden épülete elpusztult. Játékidő: ${fmtClock(s.tick * TICK)}.` : w === 2 ? 'Mindkét fél elvesztette az összes épületét.' : `Elpusztult az összes épületed. Játékidő: ${fmtClock(s.tick * TICK)}.`);
  const a = s.players[meS].st, b = s.players[op].st;
  const rows = [
    ['Kiképzett egységek', a.trained, b.trained], ['Megölt ellenség', a.kills, b.kills], ['Elvesztett egységek', a.lost, b.lost],
    ['Felépített épületek', a.built, b.built], ['Lerombolt épületek', a.razed, b.razed], ['Bányászott arany', a.gold, b.gold], ['Kivágott fa', a.wood, b.wood],
  ];
  $('resTable').innerHTML = `<tr><th></th><th style="color:${TEAM_CSS[meS]}">${esc(g.names[meS])}</th><th style="color:${TEAM_CSS[op]}">${esc(g.names[op])}</th></tr>` +
    rows.map(([l, x, y]) => `<tr><td>${l}</td><td>${x}</td><td>${y}</td></tr>`).join('');
  $('againTxt').textContent = g.mode === 'mp' ? 'VISSZA A SZOBÁBA' : 'ÚJ CSATA';
  $('resMenuBtn').textContent = g.mode === 'mp' ? 'KILÉPÉS A SZOBÁBÓL' : 'FŐMENÜ';
  $('hud').hidden = true;
  $('tip').hidden = true;
  showScreen('result');
}

// ---------- multiplayer room ----------
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const randomCode = () => Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
const inviteUrl = (code) => `${location.origin}${location.pathname}#${code}`;
const validRace = (r) => (r === 'orc' ? 'orc' : 'human');
function enterRoom(code) {
  snd.init();
  let room;
  try { room = new Duel(code); } catch (err) {
    menuNote('Nem sikerült csatlakozni. A többjátékos módhoz HTTPS vagy localhost kell.', true);
    console.error(err);
    return;
  }
  Object.assign(MP, { room, myReady: false, peer: null, inGame: false, joinT: 15, note: '', noteT: 0, early: [] });
  const hello = () => room.send('hello', { name: myName(), race: myRaceSel, r: MP.myReady });
  room.onPeer = (on) => {
    if (on) {
      MP.peer = { name: '…', race: 'human', ready: false, inGame: false };
      hello();
      renderRoom();
      return;
    }
    const who = MP.peer && MP.peer.name !== '…' ? MP.peer.name : 'Az ellenfél';
    MP.peer = null;
    if (MP.inGame && game && game.mode === 'mp' && game.endT < 0) {
      game.sim.winner = game.me;
      onGameEnd(game.me, `${who} kilépett, a csatát te nyerted.`);
    } else roomNote(`${who} kilépett.`);
    renderRoom();
  };
  room.on('hello', (d) => {
    if (!MP.peer) MP.peer = { name: '…', race: 'human', ready: false, inGame: false };
    const fresh = MP.peer.name === '…';
    MP.peer.name = cleanName(d?.name);
    MP.peer.race = validRace(d?.race);
    MP.peer.ready = !!d?.r;
    if (fresh) roomNote(`${MP.peer.name} belépett.`); else renderRoom();
    maybeStart();
  });
  room.on('ready', (d) => {
    if (!MP.peer) return;
    MP.peer.ready = !!d?.r;
    MP.peer.race = validRace(d?.race);
    MP.peer.inGame = false;
    renderRoom();
    maybeStart();
  });
  room.on('start', (d) => {
    if (room.isHost || MP.inGame || !d || !Array.isArray(d.races) || !Array.isArray(d.names)) return;
    beginMP({ seed: d.seed | 0, races: d.races.map(validRace), names: d.names.map(cleanName) }, 1);
  });
  room.on('turn', (d) => {
    if (!d || typeof d.t !== 'number' || !Array.isArray(d.c)) return;
    if (game && game.mode === 'mp' && game.seed === d.m) game.put(d.t, 1 - game.me, d.c);
    else if (!MP.inGame || !game || game.mode !== 'mp') MP.early.push(d);
  });
  room.on('hash', (d) => { if (game && game.mode === 'mp' && d && game.seed === d.m) game.checkHash(d.t, d.h, false); });
  room.on('back', () => {
    if (MP.peer) { MP.peer.ready = false; MP.peer.inGame = false; }
    renderRoom();
  });
  history.replaceState(null, '', '#' + code);
  menuNote('');
  showRoom();
}
function roomNote(text) { MP.note = text; MP.noteT = 5; renderRoom(); }
function showRoom() {
  if (!game || game.mode !== 'demo') startDemo();
  $('hud').hidden = true;
  showScreen('room');
  renderRoom();
}
function renderRoom() {
  const room = MP.room;
  if (!room) return;
  $('roomCode').textContent = room.code;
  $('inviteLink').textContent = inviteUrl(room.code);
  const rows = [{ name: myName(), race: myRaceSel, ready: MP.myReady, me: true, host: room.isHost }];
  if (MP.peer) rows.push({ ...MP.peer, me: false, host: !room.isHost });
  const slotOf = (r) => (r.host ? 0 : 1);
  $('playerList').innerHTML = rows.map((p) => {
    const tags = (p.me ? '<em>te</em>' : '') + (p.host && MP.peer ? '<em>házigazda</em>' : '');
    const st = p.inGame ? '<b>MÉG AZ EREDMÉNYT NÉZI</b>' : p.ready ? '<b class="ok">KÉSZ</b>' : '<b>NEM KÉSZ</b>';
    return `<li><span><span class="sw" style="background:${TEAM_CSS[slotOf(p)]}"></span>${esc(p.name)} · ${RACES[p.race].name}${tags}</span>${st}</li>`;
  }).join('');
  syncSeg('roomRaceSeg', myRaceSel);
  $('readyTxt').textContent = MP.myReady ? 'MÉGSEM' : 'KÉSZ VAGYOK';
  $('readyBtn').classList.toggle('on', MP.myReady);
  let status;
  if (!MP.peer) status = MP.joinT > 0 ? 'Kapcsolódás a szobához…' : 'Még senki nincs itt. Küldd el a linket vagy a kódot a barátodnak.';
  else if (MP.peer.inGame) status = 'Az ellenfél még az előző csata eredményét nézi.';
  else if (!MP.myReady || !MP.peer.ready) status = 'Ha mindketten KÉSZ-t nyomtok, indul a csata.';
  else status = 'Indul…';
  $('roomStatus').textContent = MP.note || status;
}
function maybeStart() {
  const room = MP.room;
  if (!room || !room.isHost || MP.inGame || !MP.myReady || !MP.peer || !MP.peer.ready || MP.peer.inGame) return;
  const cfg = { seed: Math.floor(Math.random() * 2 ** 31), races: [myRaceSel, MP.peer.race], names: [myName(), MP.peer.name] };
  room.send('start', cfg);
  beginMP(cfg, 0);
}
function beginMP(cfg, slot) {
  MP.inGame = true;
  MP.myReady = false;
  if (MP.peer) { MP.peer.ready = false; MP.peer.inGame = true; }
  startGame({ mode: 'mp', seed: cfg.seed, races: cfg.races, names: cfg.names, me: slot });
  for (const d of MP.early) if (d.m === cfg.seed) game.put(d.t, 1 - slot, d.c);
  MP.early = [];
}
function backToRoom() {
  MP.inGame = false;
  MP.room?.send('back', {});
  game = null;
  showRoom();
}
function leaveRoom() {
  MP.room?.leave();
  Object.assign(MP, { room: null, inGame: false, myReady: false, peer: null, early: [] });
  history.replaceState(null, '', location.pathname + location.search);
  game = null;
  showMenu();
}

// ---------- buttons ----------
bindSeg('raceSeg', (v) => { myRaceSel = validRace(v); store.set('race', myRaceSel); syncSeg('raceSeg', myRaceSel); });
bindSeg('diffSeg', (v) => { diffSel = clamp(Number(v) | 0, 0, 2); store.set('diff', diffSel); syncSeg('diffSeg', diffSel); });
bindSeg('roomRaceSeg', (v) => {
  myRaceSel = validRace(v);
  store.set('race', myRaceSel);
  MP.room?.send('ready', { r: MP.myReady, race: myRaceSel });
  syncSeg('raceSeg', myRaceSel);
  renderRoom();
});
$('soloBtn').addEventListener('click', startSolo);
$('createBtn').addEventListener('click', () => enterRoom(randomCode()));
$('joinBtn').addEventListener('click', () => {
  const code = codeInput.value.trim().toUpperCase();
  if (!/^[A-Z]{4}$/.test(code)) { codeInput.classList.add('err'); codeInput.focus(); menuNote('A szobakód 4 betű.', true); return; }
  enterRoom(code);
});
codeInput.addEventListener('input', () => {
  codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  codeInput.classList.remove('err');
});
codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('joinBtn').click(); });
nameInput.addEventListener('change', () => {
  myName();
  if (MP.room) MP.room.send('hello', { name: myName(), race: myRaceSel, r: MP.myReady });
});
$('readyBtn').addEventListener('click', () => {
  if (!MP.room) return;
  snd.init();
  snd.play('click');
  MP.myReady = !MP.myReady;
  MP.room.send('ready', { r: MP.myReady, race: myRaceSel });
  renderRoom();
  maybeStart();
});
$('leaveBtn').addEventListener('click', leaveRoom);
$('copyBtn').addEventListener('click', () => {
  const url = inviteUrl(MP.room ? MP.room.code : '');
  const done = () => { $('copyBtn').textContent = 'MÁSOLVA'; setTimeout(() => ($('copyBtn').textContent = 'LINK MÁSOLÁSA'), 1500); };
  const fallback = () => {
    const sel = getSelection(), range = document.createRange();
    range.selectNodeContents($('inviteLink')); sel.removeAllRanges(); sel.addRange(range);
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(done, fallback); else fallback();
});
$('menuBtn').addEventListener('click', openPause);
$('resumeBtn').addEventListener('click', resumeGame);
$('soundBtn').addEventListener('click', () => {
  snd.setMuted(!snd.muted);
  store.set('muted', snd.muted ? '1' : '0');
  $('soundBtn').textContent = snd.muted ? 'HANG: KI' : 'HANG: BE';
});
$('ggBtn').addEventListener('click', () => {
  if (!game || game.sim.winner >= 0) return;
  if (game.mode === 'solo') { game.paused = false; game.sim.finish(1 - game.me); for (const ev of game.sim.events) onEvent(ev); game.sim.events.length = 0; }
  else issue(['gg']);
  showScreen(null);
});
$('quitBtn').addEventListener('click', () => {
  if (game && game.mode === 'mp') leaveRoom();
  else { game = null; showMenu(); }
});
$('againBtn').addEventListener('click', () => {
  if (MP.room) backToRoom();
  else if (game) {
    const g = game;
    const races = g.races.slice();
    races[g.me] = myRaceSel;
    startGame({ mode: 'solo', seed: Math.floor(Math.random() * 2 ** 31), races, names: g.names, me: g.me, level: g.level });
  }
});
$('resMenuBtn').addEventListener('click', () => { if (MP.room) leaveRoom(); else { game = null; showMenu(); } });
window.addEventListener('beforeunload', () => MP.room?.leave());

// ============================================================
//  Main loop
// ============================================================
let lastT = performance.now(), lastFrame = performance.now(), slowT = 0;
function frame(now) {
  requestAnimationFrame(frame);
  runFrame(now);
}
function runFrame(now) {
  const dt = Math.min(0.1, Math.max(0, (now - lastT) / 1000));
  lastT = now;
  lastFrame = performance.now();
  if (game) {
    pump(dt);
    const alpha = clamp(game.acc / TICK, 0, 1);
    if (game.mode === 'demo') updateDemoCam(dt); else if (inGame()) updateCamera(dt);
    view.sync(alpha, dt, game.sim);
    view.updateFog(dt);
    if (inGame()) {
      const p0 = view.project(view.cam.x, 0, view.cam.z), p1 = view.project(view.cam.x + 1, 0, view.cam.z);
      ui.ppu = Math.abs(p1.x - p0.x) || 30;
      ui.sel = ui.sel.filter((id) => sim().get(id));
      ui.hover = ui.drag && ui.drag.active ? null : pick(ui.mouse.x, ui.mouse.y);
      const es = selEnts();
      view.drawRings(es.map((e) => ({ e, kind: e.owner === game.me ? 'own' : e.owner < 0 ? 'neu' : 'foe' })), ui.hover);
      const rb = ownSel().blds.find((b) => b.done && b.rally);
      view.showRally(rb ? rb.rally : null);
      if (ui.mode === 'place' && ui.buildType) {
        const g = view.ray(ui.mouse.x, ui.mouse.y);
        if (g) {
          const [tx, tz] = ghostAt(g, ui.buildType);
          view.setGhost(ui.buildType, [0x3d7bff, 0xe2412e][game.me], tx, tz, placeCheck(ui.buildType, tx, tz).ok);
        }
      } else view.setGhost(null);
      cv.style.cursor = ui.mode && ui.mode !== 'place' ? 'crosshair' : ui.hover ? 'pointer' : 'default';
      updateHUD();
      slowT -= dt;
      if (slowT <= 0) {
        slowT = 0.15;
        renderCard();
        renderInfo();
        drawMinimap();
      }
      if (MP.joinT > 0) MP.joinT -= dt;
    } else {
      view.drawRings([], null);
      view.showRally(null);
      view.setGhost(null);
      if (MP.room && !$('room').hidden) {
        if (MP.joinT > 0 && (MP.joinT -= dt) <= 0) renderRoom();
        if (MP.noteT > 0 && (MP.noteT -= dt) <= 0) { MP.note = ''; renderRoom(); }
      }
    }
  }
  view.render(dt);
  drawOverlay();
}
// keeps a multiplayer match ticking while the tab is in the background (requestAnimationFrame stops there)
setInterval(() => {
  const now = performance.now();
  if (!game || game.mode !== 'mp' || now - lastFrame < 250) return;
  const dt = Math.min(1, (now - Math.max(lastFrame, lastT)) / 1000);
  lastT = now;
  lastFrame = now - 200;
  pump(dt);
}, 200);

// local testing hook (only on localhost)
if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
  window.__hadur = {
    get game() { return game; }, view, ui, issue, startSolo, pick, setSel,
    fast(sec) { for (let k = 0; k < sec * 10; k++) pump(TICK); return { tick: game.sim.tick, players: game.sim.players.map((p) => ({ g: p.gold, w: p.wood, f: p.food + '/' + p.cap })) }; },
    // run n frames by hand (the preview pane may be hidden, which stops requestAnimationFrame)
    frames(n = 1, dt = 1 / 30) { for (let k = 0; k < n; k++) runFrame(lastT + dt * 1000); return game ? game.sim.tick : -1; },
  };
}

function boot() {
  initCard();
  const icH = iconsFor(0), icO = iconsFor(1);
  for (const id of ['raceImgH', 'raceImgH2']) $(id).src = icH.footman;
  for (const id of ['raceImgO', 'raceImgO2']) $(id).src = icO.grunt;
  if (matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches) $('touchNote').hidden = false;
  showMenu();
  readInvite();
  window.addEventListener('hashchange', readInvite);
  requestAnimationFrame((t) => { lastT = t; frame(t); $('loading').hidden = true; });
}
boot();
