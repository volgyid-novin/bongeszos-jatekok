import * as THREE from 'three';
import { encode } from 'uqr';
import { View, BLADE_COLORS } from './view.js';
import { Sound } from './audio.js';
import { pairRoom, Duel } from './net.js';
import { Fighter, Referee, Bot, moveFighter, qFromDir, clamp, FWD, HP, ROUNDS_TO_WIN, SPAWN } from './fight.js';

// The PC side: menus, phone pairing (QR), the duel room, and the match loop.
// Each machine moves its own fighter (saber from the phone, or the mouse without one) and streams it to the
// other; the host also runs the referee and the round flow, and sends every clash / hit / round event,
// which both machines apply the same way (applyEvent).

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { return localStorage.getItem('fenykard.' + k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('fenykard.' + k, v); } catch { /* private mode */ } },
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cleanName = (n) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 16) || 'Játékos';
const validCol = (c) => (Object.hasOwn(BLADE_COLORS, c) ? c : 'blue');
const otherCol = (c) => (c === 'red' ? 'blue' : 'red');

const STEP = 1 / 60;
const INTRO = 2.6, IGNITE_AT = 1.9, KO_T = 2.8, END_T = 2.2;
const SEND_GAP = 15;          // ms between fighter state packets
const IDQ = new THREE.Quaternion();
const _q = new THREE.Quaternion(), _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();

let view, snd;
let game = null;
let paused = false;
const keys = {};
const mouse = { x: 0, y: -0.2 };
let myCol = validCol(store.get('col', 'blue'));
let nameInput, codeInput;
const myName = () => { const n = cleanName(nameInput.value); store.set('name', n); return n; };

// ============================================================
//  Phone pairing
// ============================================================
// The pair id lives in sessionStorage: a reload keeps the same QR code (the phone just reconnects),
// a second tab gets its own.
const pairId = (() => {
  let id = null;
  try { id = sessionStorage.getItem('fenykard.pair'); } catch { /* blocked */ }
  if (!/^[a-z0-9]{10}$/.test(id || '')) {
    const abc = 'abcdefghijkmnpqrstuvwxyz23456789', rnd = crypto.getRandomValues(new Uint8Array(10));
    id = Array.from(rnd, (b) => abc[b % abc.length]).join('');
    try { sessionStorage.setItem('fenykard.pair', id); } catch { /* blocked */ }
  }
  return id;
})();
const PAIR = { room: null, phone: null, armed: false, everArmed: false, lastO: 0, q: new THREE.Quaternion(), qrOpen: false };
const padUrl = () => `${location.origin}${location.pathname}?kard=${pairId}`;
const phoneLive = () => PAIR.armed && performance.now() - PAIR.lastO < 1200;

function initPair() {
  let room;
  try { room = pairRoom(pairId); } catch (err) { console.error(err); renderPair(); return; }
  PAIR.room = room;
  room.onJoin = (pid) => { if (!PAIR.phone) PAIR.phone = pid; renderPair(); pushPad(true); };
  room.onLeave = (pid) => {
    if (pid !== PAIR.phone) return;
    PAIR.phone = [...room.peers][0] || null;
    PAIR.armed = false;
    renderPair();
  };
  room.on('hi', (d, pid) => {
    const fresh = PAIR.phone !== pid;
    PAIR.phone = pid;
    if (d?.armed) PAIR.armed = true;
    renderPair();
    if (fresh) PAIR.qrOpen = false;
    pushPad(true);
  });
  room.on('o', (d, pid) => {
    if (!Array.isArray(d) || d.length !== 4) return;
    PAIR.phone = pid;
    PAIR.q.set(+d[0] || 0, +d[1] || 0, +d[2] || 0, +d[3] || 0);
    if (PAIR.q.lengthSq() < 1e-6) PAIR.q.identity(); else PAIR.q.normalize();
    PAIR.lastO = performance.now();
    if (!PAIR.armed || !PAIR.everArmed) {
      PAIR.armed = PAIR.everArmed = true;
      renderPair();
      sendHello();
    }
  });
  room.on('pb', (d, pid) => {
    PAIR.phone = pid;
    const k = d?.k;
    if (k === 'arm') { PAIR.armed = true; snd.play('ignite', 0.7); renderPair(); }
    else if (k === 'cal') toast('Telefon igazítva');
    else if (k === 'rdy' && MP.room && !$('room').hidden) toggleReady();
  });
}
function renderQR() {
  const url = padUrl(), qr = encode(url, { ecc: 'M', border: 2 }), n = qr.size;
  let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.data[y][x]) d += `M${x} ${y}h1v1h-1z`;
  $('qr').innerHTML = `<svg viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img" aria-label="QR-kód a telefonhoz"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#05060b"/></svg>`;
  $('pairLink').textContent = url;
}
function renderPair() {
  let t, c;
  if (!PAIR.room) { t = 'A telefonhoz HTTPS kell'; c = 'bad'; }
  else if (!PAIR.phone) { t = 'Nincs telefon'; c = ''; }
  else if (!PAIR.armed) { t = 'Telefon csatlakozva · nyomd meg rajta: KARD BE'; c = 'warn'; }
  else if (!phoneLive()) { t = 'A telefon nem küld mozgásadatot'; c = 'bad'; }
  else { t = 'A kard él'; c = 'ok'; }
  const el = $('pairState');
  if (el.textContent !== t) el.textContent = t;
  el.className = 'pill ' + c;
  $('pairBox').classList.toggle('live', phoneLive() && !PAIR.qrOpen);
  const tg = $('qrToggle');
  tg.hidden = !phoneLive();
  tg.textContent = PAIR.qrOpen ? 'QR ELREJTÉSE' : 'QR-KÓD';
}

// status line, ready button and HP on the phone's screen
let padKey = '', padT = 0;
function padStatus() {
  const s = { t: '', rdy: null, hp: null, col: BLADE_COLORS[myCol].css };
  const g = game;
  if (g && g.mode !== 'demo') {
    const me = g.fs[g.me], op = g.fs[1 - g.me];
    s.hp = [me.hp, op.hp];
    const sc = ` · ${g.score[g.me]}–${g.score[1 - g.me]}`;
    if (g.phase === 'over') s.t = (g.score[g.me] > g.score[1 - g.me] ? 'Győzelem!' : 'Vereség') + sc;
    else if (g.phase === 'ko') s.t = 'Kör vége' + sc;
    else if (g.phase === 'intro') s.t = `${g.round}. kör` + sc;
    else s.t = (g.hold ? 'Szünet, várakozás…' : 'Harc!') + sc;
  } else if (MP.room && !$('room').hidden) {
    s.t = MP.peer ? `Szoba ${MP.room.code} · ellenfél: ${MP.peer.name}` : `Szoba ${MP.room.code} · várakozás az ellenfélre`;
    s.rdy = MP.myReady;
  } else s.t = 'Menü · válassz a gépen';
  return s;
}
function pushPad(force) {
  if (!PAIR.room || !PAIR.phone) return;
  const s = padStatus(), key = JSON.stringify(s), now = performance.now();
  if (!force && key === padKey && now - padT < 1500) return;
  padKey = key;
  padT = now;
  PAIR.room.send('ps', s, PAIR.phone);
}
const buzz = (pattern) => { if (PAIR.phone && phoneLive()) PAIR.room.send('bz', pattern, PAIR.phone); };

// ============================================================
//  Match
// ============================================================
function makeMatch(mode, me, names, cols) {
  const fs = [new Fighter(0), new Fighter(1)];
  const g = {
    mode, me, auth: mode !== 'mp' || me === 0, fs, names, cols,
    score: [0, 0], round: 0, phase: 'intro', pt: INTRO, hold: false, koW: -1, koLoser: -1,
    bots: [null, null], ref: null, acc: 0, sendT: 0, endT: -1,
    remote: { pos: new THREE.Vector3(), q: new THREE.Quaternion(), has: false },
    stats: [{ hits: 0, dmg: 0, heads: 0 }, { hits: 0, dmg: 0, heads: 0 }], clashes: 0,
  };
  if (g.auth) g.ref = new Referee(fs, emit);
  fs[0].face(fs[1]);
  fs[1].face(fs[0]);
  view.setColors(cols.map((c) => BLADE_COLORS[c].hex));
  view.resetTrails();
  return g;
}
function startDemo() {
  game = makeMatch('demo', 0, ['', ''], [myCol, otherCol(myCol)]);
  game.phase = 'fight';
  game.bots[1] = new Bot(game.fs[1], game.fs[0], { aggr: 0.8, block: 0.7 });
}
function startSolo() {
  snd.init();
  paused = false;
  game = makeMatch('solo', 0, [myName(), 'Gyakorló robot'], [myCol, otherCol(myCol)]);
  game.bots[1] = new Bot(game.fs[1], game.fs[0], { aggr: 1, block: 0.6 });
  startRound(1);
  showScreen(null);
}
function startRound(n) { emit({ k: 'rd', n, sc: [...game.score] }); }

// host / solo: apply locally and tell the other machine
function emit(ev) {
  applyEvent(ev);
  if (game && game.mode === 'mp') MP.room?.send('ev', ev);
}
const vec = (a) => (Array.isArray(a) && a.length === 3 ? new THREE.Vector3(+a[0] || 0, +a[1] || 0, +a[2] || 0) : null);
const owns = (g, i) => i === g.me || (g.mode !== 'mp' && g.auth);

function applyEvent(ev) {
  const g = game;
  if (!g || !ev || typeof ev.k !== 'string') return;
  const fx = g.mode === 'demo' ? 0.5 : 1;
  switch (ev.k) {
    case 'rd': {
      g.round = ev.n | 0;
      if (Array.isArray(ev.sc)) g.score = [ev.sc[0] | 0, ev.sc[1] | 0];
      g.phase = 'intro';
      g.pt = INTRO;
      g.koW = g.koLoser = -1;
      g.fs.forEach((f, i) => {
        f.hp = HP;
        f.on = 0;
        f.swing = 0;
        f.bq.identity();
        if (owns(g, i)) f.spawn();
      });
      g.fs[0].face(g.fs[1]);
      g.fs[1].face(g.fs[0]);
      g.ref?.reset();
      view.resetTrails();
      banner(`${g.round}. kör`, 'round', 1.6);
      snd.play('round');
      break;
    }
    case 'go':
      g.phase = 'fight';
      g.pt = 0;
      if (g.mode !== 'demo') { banner('Harc!', 'go', 0.9); snd.play('go'); }
      break;
    case 'cl': {
      const p = vec(ev.p), n = vec(ev.n);
      if (!p || !n) return;
      g.clashes++;
      const s = clamp((+ev.s || 4) / 8, 0.5, 1.3);
      const col = new THREE.Color(BLADE_COLORS[g.cols[0]].hex).lerp(new THREE.Color(BLADE_COLORS[g.cols[1]].hex), 0.5);
      view.spark(p, Math.round(26 * s), col, 3.2 * s, 0.6);
      view.flash(p, col.clone().lerp(new THREE.Color(0xffffff), 0.5), 7 * s);
      if (g.mode !== 'demo') view.shake(0.18 * s);
      snd.play('clash', s * fx);
      bounce(g.fs[0], n, 0.32);
      bounce(g.fs[1], n.clone().negate(), 0.32);
      if (g.mode !== 'demo' || phoneLive()) buzz(35);
      break;
    }
    case 'hit': {
      const a = ev.a | 0, v = ev.v | 0, p = vec(ev.p), n = vec(ev.n);
      if (a > 1 || v > 1 || !p) return;
      if (Array.isArray(ev.hp)) g.fs.forEach((f, i) => { f.hp = clamp(ev.hp[i] | 0, 0, HP); });
      const st = g.stats[a];
      st.hits++;
      st.dmg += ev.d | 0;
      if (ev.z === 'head') st.heads++;
      view.spark(p, 34, new THREE.Color(0xff7a2a), 2.6, 1);
      view.flash(p, new THREE.Color(0xff6a20), 5);
      view.fighters[v].hitFlash();
      snd.play('hit', fx);
      if (owns(g, v) && n) g.fs[v].vel.addScaledVector(n, 2.2);
      if (g.mode === 'demo') { g.fs[v].hp = HP; break; }
      if (v === g.me) {
        view.shake(0.45);
        hurtFlash();
        snd.play('hurt');
        buzz([90, 40, 90]);
      } else if (a === g.me) {
        buzz(30);
        popText(`−${ev.d | 0}`, ev.z === 'head');
      }
      break;
    }
    case 'ko': {
      const w = ev.w | 0;
      if (w > 1) return;
      g.phase = 'ko';
      g.pt = KO_T;
      g.koW = w;
      g.koLoser = 1 - w;
      if (Array.isArray(ev.sc)) g.score = [ev.sc[0] | 0, ev.sc[1] | 0];
      banner(w === g.me ? 'Kör megnyerve' : 'Kör elvesztve', w === g.me ? 'win' : 'lose', 2.2);
      snd.play('ko');
      buzz(w === g.me ? [40, 60, 40] : [300]);
      break;
    }
    case 'over': {
      const w = ev.w | 0;
      g.phase = 'over';
      g.koLoser = 1 - w;
      g.endT = END_T;
      banner(w === g.me ? 'Győzelem' : 'Vereség', w === g.me ? 'win' : 'lose', END_T);
      break;
    }
  }
}
// visual clash bounce: tilt the shown blade away from the other one (n: world direction away from it)
function bounce(f, n, ang) {
  f.rig(false);
  const dl = _v1.copy(FWD).applyQuaternion(f.q);
  const al = _v2.copy(n).applyQuaternion(_q.copy(f.bodyQ).invert());
  const axis = _v3.crossVectors(dl, al);
  if (axis.lengthSq() < 1e-6) return;
  f.bq.setFromAxisAngle(axis.normalize(), ang);
}

const _md = new THREE.Vector3(), _mq = new THREE.Quaternion();
function mouseQ() {
  const yaw = -mouse.x * 1.25, pitch = clamp(0.35 - mouse.y * 1.25, -1.0, 1.5);
  _md.set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
  return qFromDir(_md, _mq);
}
// my saber: the phone if one was ever used this session, else the mouse
function steerMine(f, dt) {
  if (PAIR.everArmed) {
    f.ok = phoneLive();
    if (f.ok) f.q.slerp(PAIR.q, 1 - Math.exp(-dt * 45));
  } else {
    f.ok = true;
    f.q.slerp(mouseQ(), 1 - Math.exp(-dt * 28));
  }
}
function moveMine(f, foe, dt, live) {
  let want = 2 * SPAWN, strafe = 0;
  if (live && game.mode !== 'demo') {
    const fw = keys.KeyW || keys.ArrowUp, bk = keys.KeyS || keys.ArrowDown;
    want = fw && !bk ? 1.2 : bk && !fw ? 2.7 : 1.55;
    strafe = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0);
  } else if (live) want = 1.75;
  moveFighter(f, foe, dt, want, strafe);
}

function step(dt) {
  const g = game;
  if (g.mode === 'demo') {
    // the menu backdrop: a bot spars with whoever holds the paired phone, or with another bot
    const human = phoneLive();
    if (human && g.bots[0]) { g.bots[0] = null; g.bots[1].aggr = 0.45; }
    if (!human && !g.bots[0]) { g.bots[0] = new Bot(g.fs[0], g.fs[1], { aggr: 0.8, block: 0.7 }); g.bots[1].aggr = 0.8; }
  }
  g.hold = g.mode !== 'demo' && g.phase === 'fight' && (!g.fs[0].ok || !g.fs[1].ok);
  const live = g.phase === 'fight' && !g.hold;
  if (!g.hold) g.pt -= dt;
  if (g.auth && g.mode !== 'demo') {
    if (g.phase === 'intro' && g.pt <= 0) emit({ k: 'go' });
    else if (g.phase === 'ko' && g.pt <= 0) {
      if (g.score[g.koW] >= ROUNDS_TO_WIN) emit({ k: 'over', w: g.koW });
      else startRound(g.round + 1);
    }
  }
  // blades: ignite during the intro, the loser's goes out at a KO
  g.fs.forEach((f, i) => {
    let want = 1;
    if (g.phase === 'intro') want = g.pt <= IGNITE_AT - i * 0.22 ? 1 : 0;
    else if ((g.phase === 'ko' || g.phase === 'over') && i === g.koLoser && g.pt < KO_T - 0.5) want = 0;
    if (want && f.on === 0) snd.play('ignite', i === g.me ? 1 : 0.6);
    if (!want && f.on === 1) snd.play('retract', i === g.me ? 1 : 0.6);
    f.on = want ? Math.min(1, f.on + dt / 0.28) : Math.max(0, f.on - dt / 0.35);
  });
  g.fs.forEach((f, i) => {
    const foe = g.fs[1 - i];
    if (g.bots[i]) { g.bots[i].update(dt, live); f.ok = true; }
    else if (i === g.me) {
      steerMine(f, dt);
      if (g.hold) f.face(foe); else moveMine(f, foe, dt, live);
    } else {
      const r = g.remote;
      if (r.has) {
        f.pos.lerp(r.pos, 1 - Math.exp(-dt * 18));
        f.q.slerp(r.q, 1 - Math.exp(-dt * 30));
      }
      f.face(foe);
    }
    if (g.bots[i] || i === g.me) { f.rig(false); f.measure(dt); }
  });
  if (g.ref) {
    g.ref.step(dt, live);
    if (g.mode !== 'demo' && g.phase === 'fight') {
      const l = g.fs.findIndex((f) => f.hp <= 0);
      if (l >= 0) {
        const sc = [...g.score];
        sc[1 - l]++;
        emit({ k: 'ko', w: 1 - l, sc });
      }
    }
  }
}
function sendState(now) {
  const g = game;
  if (g.mode !== 'mp' || !MP.room || now - g.sendT < SEND_GAP) return;
  g.sendT = now;
  const f = g.fs[g.me], r = (v, k) => Math.round(v * k) / k;
  MP.room.send('s', [r(f.pos.x, 1e3), r(f.pos.z, 1e3), r(f.q.x, 1e4), r(f.q.y, 1e4), r(f.q.z, 1e4), r(f.q.w, 1e4), r(f.swing, 10), f.ok ? 1 : 0]);
}

// ============================================================
//  HUD
// ============================================================
let bannerT = 0, toastT = 0;
function banner(text, cls, dur) {
  const el = $('banner');
  el.textContent = text;
  el.className = 'show ' + (cls || '');
  bannerT = dur;
}
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  toastT = 1.6;
}
function hurtFlash() {
  const el = $('vignette');
  el.classList.remove('hurt');
  void el.offsetWidth;
  el.classList.add('hurt');
}
function popText(text, big) {
  const el = document.createElement('div');
  el.className = 'pop' + (big ? ' big' : '');
  el.textContent = text;
  $('pops').append(el);
  setTimeout(() => el.remove(), 900);
}
function renderHUD() {
  const g = game, me = g.me, op = 1 - me;
  const set = (id, v) => { const el = $(id); if (el.textContent !== v) el.textContent = v; };
  set('nameMe', g.names[me]);
  set('nameOp', g.names[op]);
  $('hpMe').style.width = g.fs[me].hp + '%';
  $('hpOp').style.width = g.fs[op].hp + '%';
  set('hpMeTxt', String(g.fs[me].hp));
  set('hpOpTxt', String(g.fs[op].hp));
  const pips = (n) => Array.from({ length: ROUNDS_TO_WIN }, (_, i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('');
  const pm = pips(g.score[me]), po = pips(g.score[op]);
  if ($('pipsMe').innerHTML !== pm) $('pipsMe').innerHTML = pm;
  if ($('pipsOp').innerHTML !== po) $('pipsOp').innerHTML = po;
  set('roundTxt', g.round ? `${g.round}. KÖR` : '');
  const hud = $('hud');
  hud.style.setProperty('--me', BLADE_COLORS[g.cols[me]].css);
  hud.style.setProperty('--op', BLADE_COLORS[g.cols[op]].css);
  let hold = '';
  if (g.hold) hold = !g.fs[me].ok ? 'A telefonod lecsatlakozott. Nyisd meg rajta újra a kontroller lapot.' : `${g.names[op]} telefonja lecsatlakozott, várakozás…`;
  set('holdMsg', hold);
  $('holdMsg').hidden = !hold;
  set('ctrlHint', PAIR.everArmed ? 'W S A D: mozgás · telefon: tartsd nyomva az IGAZÍTÁS gombot, ha elcsúszott · Esc: menü' : 'Nincs telefon: az egér mozgatja a kardot · W S A D: mozgás · Esc: menü');
}

// ============================================================
//  Screens
// ============================================================
const SCREENS = ['menu', 'room', 'pause', 'result'];
function showScreen(name) {
  for (const s of SCREENS) $(s).hidden = s !== name;
  const inGame = !name && game && game.mode !== 'demo';
  $('hud').hidden = !(inGame || name === 'pause');
  if (name === 'menu') $('menuPair').append($('pairBox'));
  if (name === 'room') $('roomPair').append($('pairBox'));
  document.body.classList.toggle('playing', !!inGame);
  pushPad(true);
}
const screenOpen = () => SCREENS.some((s) => !$(s).hidden && s !== 'pause');
function showMenu() {
  if (!game || game.mode !== 'demo') startDemo();
  paused = false;
  showScreen('menu');
}
function syncColors() {
  for (const seg of document.querySelectorAll('.col-seg')) {
    for (const b of seg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.v === myCol));
  }
  document.documentElement.style.setProperty('--blade', BLADE_COLORS[myCol].css);
  if (game && game.mode === 'demo') {
    game.cols = [myCol, otherCol(myCol)];
    view.setColors(game.cols.map((c) => BLADE_COLORS[c].hex));
  }
}
function buildColorSegs() {
  for (const seg of document.querySelectorAll('.col-seg')) {
    seg.innerHTML = Object.entries(BLADE_COLORS).map(([k, c]) =>
      `<button data-v="${k}" aria-pressed="false" style="--c:${c.css}"><i></i>${c.name}</button>`).join('');
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      myCol = validCol(b.dataset.v);
      store.set('col', myCol);
      snd.init();
      snd.play('click');
      syncColors();
      if (MP.room) sendHello();
      renderRoom();
      pushPad(true);
    });
  }
}

function openPause() {
  if (!game || game.mode === 'demo' || !$('result').hidden) return;
  if (game.mode === 'solo') paused = true;
  $('pauseNote').textContent = game.mode === 'mp' ? 'Többjátékos módban a meccs közben is megy tovább.' : '';
  $('ggBtn').hidden = game.phase === 'over';
  showScreen('pause');
}
function resumeGame() {
  paused = false;
  showScreen(null);
}
function showResult(why) {
  const g = game;
  if (!g) return;
  const me = g.me, op = 1 - me, win = g.score[me] > g.score[op] || (why && g.score[me] === g.score[op]);
  $('resHead').textContent = win ? 'Győzelem' : 'Vereség';
  $('resHead').className = 'res-head ' + (win ? 'win' : 'lose');
  $('resSub').textContent = why || `${g.score[me]}–${g.score[op]} ${g.names[op]} ellen.`;
  const a = g.stats[me], b = g.stats[op];
  const rows = [['Megnyert kör', g.score[me], g.score[op]], ['Találat', a.hits, b.hits], ['Fejtalálat', a.heads, b.heads], ['Sebzés', a.dmg, b.dmg]];
  $('resTable').innerHTML = `<tr><th></th><th style="color:${BLADE_COLORS[g.cols[me]].css}">${esc(g.names[me])}</th><th style="color:${BLADE_COLORS[g.cols[op]].css}">${esc(g.names[op])}</th></tr>` +
    rows.map(([l, x, y]) => `<tr><td>${l}</td><td>${x}</td><td>${y}</td></tr>`).join('') +
    `<tr><td>Kardcsapás egymásnak</td><td colspan="2">${g.clashes}</td></tr>`;
  $('againTxt').textContent = g.mode === 'mp' ? 'VISSZA A SZOBÁBA' : 'ÚJ MECCS';
  $('resMenuBtn').textContent = g.mode === 'mp' ? 'KILÉPÉS A SZOBÁBÓL' : 'FŐMENÜ';
  g.phase = 'over';
  g.endT = -1;
  showScreen('result');
}

// ============================================================
//  Duel room (PC <-> PC)
// ============================================================
const MP = { room: null, peer: null, myReady: false, inGame: false, joinT: 0, note: '', noteT: 0, lastPh: null };
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const randomCode = () => Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
const inviteUrl = (code) => `${location.origin}${location.pathname}#${code}`;
function menuNote(text) {
  const el = $('inviteNote');
  el.textContent = text;
  el.hidden = !text;
}
function sendHello() {
  MP.lastPh = phoneLive();
  MP.room?.send('hello', { name: myName(), col: myCol, ph: MP.lastPh, r: MP.myReady });
}
function enterRoom(code) {
  snd.init();
  let room;
  try { room = new Duel(code); } catch (err) {
    console.error(err);
    menuNote('Nem sikerült csatlakozni. A többjátékos módhoz HTTPS vagy localhost kell.');
    return;
  }
  Object.assign(MP, { room, myReady: false, peer: null, inGame: false, joinT: 15, note: '', noteT: 0 });
  const fresh = () => ({ name: '…', col: 'red', ph: false, ready: false, inGame: false });
  room.onPeer = (on) => {
    if (on) {
      MP.peer = fresh();
      sendHello();
      renderRoom();
      return;
    }
    const who = MP.peer && MP.peer.name !== '…' ? MP.peer.name : 'Az ellenfél';
    MP.peer = null;
    if (MP.inGame && game && game.mode === 'mp' && game.phase !== 'over') {
      game.score[game.me] = Math.max(game.score[game.me], game.score[1 - game.me]);
      showResult(`${who} kilépett, a meccset te nyerted.`);
    } else roomNote(`${who} kilépett.`);
    renderRoom();
  };
  room.on('hello', (d) => {
    if (!MP.peer) MP.peer = fresh();
    const first = MP.peer.name === '…';
    MP.peer.name = cleanName(d?.name);
    MP.peer.col = validCol(d?.col);
    MP.peer.ph = !!d?.ph;
    MP.peer.ready = !!d?.r;
    if (first) roomNote(`${MP.peer.name} belépett.`); else renderRoom();
    maybeStart();
  });
  room.on('ready', (d) => {
    if (!MP.peer) return;
    MP.peer.ready = !!d?.r;
    MP.peer.inGame = false;
    renderRoom();
    maybeStart();
  });
  room.on('start', (d) => {
    if (room.isHost || MP.inGame || !d || !Array.isArray(d.names) || !Array.isArray(d.cols)) return;
    beginMP({ names: d.names.map(cleanName), cols: d.cols.map(validCol) }, 1);
  });
  room.on('s', (d) => {
    if (!game || game.mode !== 'mp' || !Array.isArray(d) || d.length < 8) return;
    const f = game.fs[1 - game.me], r = game.remote;
    r.pos.set(+d[0] || 0, 0, +d[1] || 0);
    r.q.set(+d[2] || 0, +d[3] || 0, +d[4] || 0, +d[5] || 0);
    if (r.q.lengthSq() < 1e-6) r.q.identity(); else r.q.normalize();
    if (!r.has) { r.has = true; f.pos.copy(r.pos); f.q.copy(r.q); }
    f.swing = clamp(+d[6] || 0, 0, 60);
    f.ok = !!d[7];
  });
  room.on('ev', (d) => { if (game && game.mode === 'mp' && !game.auth) applyEvent(d); });
  room.on('back', () => {
    if (MP.peer) { MP.peer.ready = false; MP.peer.inGame = false; }
    renderRoom();
  });
  history.replaceState(null, '', location.pathname + location.search + '#' + code);
  menuNote('');
  showRoom();
}
function roomNote(text) { MP.note = text; MP.noteT = 5; renderRoom(); }
function showRoom() {
  if (!game || game.mode !== 'demo') startDemo();
  showScreen('room');
  renderRoom();
}
function renderRoom() {
  const room = MP.room;
  if (!room) return;
  $('roomCode').textContent = room.code;
  $('inviteLink').textContent = inviteUrl(room.code);
  const rows = [{ name: myName(), col: myCol, ph: phoneLive(), ready: MP.myReady, me: true, host: room.isHost }];
  if (MP.peer) rows.push({ ...MP.peer, me: false, host: !room.isHost });
  $('playerList').innerHTML = rows.map((p) => {
    const tags = (p.me ? '<em>te</em>' : '') + (p.host && MP.peer ? '<em>házigazda</em>' : '');
    const ph = p.ph ? '<span class="ph ok">telefon</span>' : '<span class="ph">egér</span>';
    const st = p.inGame ? '<b>MÉG AZ EREDMÉNYT NÉZI</b>' : p.ready ? '<b class="ok">KÉSZ</b>' : '<b>NEM KÉSZ</b>';
    return `<li><span><span class="sw" style="background:${BLADE_COLORS[p.col].css}"></span>${esc(p.name)}${tags}</span><span class="pr">${ph}${st}</span></li>`;
  }).join('');
  $('readyTxt').textContent = MP.myReady ? 'MÉGSEM' : 'KÉSZ VAGYOK';
  $('readyBtn').classList.toggle('on', MP.myReady);
  let status;
  if (!MP.peer) status = MP.joinT > 0 ? 'Kapcsolódás a szobához…' : 'Még senki nincs itt. Küldd el a linket vagy a kódot a barátodnak.';
  else if (MP.peer.inGame) status = 'Az ellenfél még az előző meccs eredményét nézi.';
  else if (!MP.myReady || !MP.peer.ready) status = 'Ha mindketten KÉSZ-t nyomtok (a gépen vagy a telefonon), indul a párbaj.';
  else status = 'Indul…';
  $('roomStatus').textContent = MP.note || status;
  pushPad(false);
}
function toggleReady() {
  if (!MP.room) return;
  snd.init();
  snd.play('click');
  MP.myReady = !MP.myReady;
  MP.room.send('ready', { r: MP.myReady });
  renderRoom();
  pushPad(true);
  maybeStart();
}
function maybeStart() {
  const room = MP.room;
  if (!room || !room.isHost || MP.inGame || !MP.myReady || !MP.peer || !MP.peer.ready || MP.peer.inGame) return;
  const cfg = { names: [myName(), MP.peer.name], cols: [myCol, MP.peer.col] };
  room.send('start', cfg);
  beginMP(cfg, 0);
}
function beginMP(cfg, slot) {
  MP.inGame = true;
  MP.myReady = false;
  if (MP.peer) { MP.peer.ready = false; MP.peer.inGame = true; }
  paused = false;
  game = makeMatch('mp', slot, cfg.names, cfg.cols);
  showScreen(null);
  if (slot === 0) startRound(1);
}
function backToRoom() {
  MP.inGame = false;
  MP.room?.send('back', {});
  game = null;
  showRoom();
}
function leaveRoom() {
  MP.room?.leave();
  Object.assign(MP, { room: null, inGame: false, myReady: false, peer: null });
  history.replaceState(null, '', location.pathname + location.search);
  game = null;
  showMenu();
}
function readInvite() {
  const code = location.hash.replace('#', '').toUpperCase();
  if (MP.room || !/^[A-Z]{4}$/.test(code)) return;
  codeInput.value = code;
  menuNote(`Meghívást kaptál a ${code} szobába. Párosítsd a telefonodat, aztán nyomd meg: BELÉPÉS.`);
  $('joinBtn').classList.add('hot');
}

// ============================================================
//  Input + main loop
// ============================================================
function bindUI() {
  $('soloBtn').addEventListener('click', startSolo);
  $('createBtn').addEventListener('click', () => enterRoom(randomCode()));
  $('joinBtn').addEventListener('click', () => {
    const code = codeInput.value.trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(code)) { codeInput.classList.add('err'); codeInput.focus(); menuNote('A szobakód 4 betű.'); return; }
    enterRoom(code);
  });
  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
    codeInput.classList.remove('err');
  });
  codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('joinBtn').click(); });
  nameInput.addEventListener('change', () => { myName(); if (MP.room) sendHello(); renderRoom(); });
  $('readyBtn').addEventListener('click', toggleReady);
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
  $('qrToggle').addEventListener('click', () => { PAIR.qrOpen = !PAIR.qrOpen; renderPair(); });
  $('resumeBtn').addEventListener('click', resumeGame);
  $('soundBtn').addEventListener('click', () => {
    snd.setMuted(!snd.muted);
    store.set('muted', snd.muted ? '1' : '0');
    $('soundBtn').textContent = snd.muted ? 'HANG: KI' : 'HANG: BE';
  });
  $('ggBtn').addEventListener('click', () => {
    if (!game || game.phase === 'over') return;
    if (game.mode === 'mp') {
      // tell the host by leaving: the other side wins by default
      leaveRoom();
      return;
    }
    game.score[1 - game.me] = ROUNDS_TO_WIN;
    paused = false;
    showResult('Feladtad a meccset.');
  });
  $('quitBtn').addEventListener('click', () => {
    if (game && game.mode === 'mp') leaveRoom();
    else { game = null; showMenu(); }
  });
  $('againBtn').addEventListener('click', () => {
    if (game && game.mode === 'mp') backToRoom();
    else startSolo();
  });
  $('resMenuBtn').addEventListener('click', () => { if (MP.room) leaveRoom(); else { game = null; showMenu(); } });

  const typing = (e) => e.target instanceof HTMLInputElement;
  addEventListener('keydown', (e) => {
    snd.init();
    if (e.code === 'Escape' || e.code === 'F10') {
      e.preventDefault();
      if (!$('pause').hidden) resumeGame(); else openPause();
      return;
    }
    if (typing(e)) return;
    keys[e.code] = true;
  });
  addEventListener('keyup', (e) => { keys[e.code] = false; });
  addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
  addEventListener('pointerdown', () => snd.init());
  addEventListener('mousemove', (e) => {
    mouse.x = (e.clientX / innerWidth) * 2 - 1;
    mouse.y = (e.clientY / innerHeight) * 2 - 1;
  });
  addEventListener('resize', () => view.resize());
  addEventListener('hashchange', readInvite);
  addEventListener('beforeunload', () => { MP.room?.leave(); PAIR.room?.leave(); });
}

let lastT = performance.now(), lastFrame = lastT, uiT = 0;
function frame(now) {
  requestAnimationFrame(frame);
  runFrame(now);
}
function runFrame(now) {
  const dt = Math.min(0.1, Math.max(0, (now - lastT) / 1000));
  lastT = now;
  lastFrame = performance.now();
  const g = game;
  if (g) {
    if (!(paused && g.mode === 'solo')) {
      g.acc += dt;
      let n = 0;
      while (g.acc >= STEP && n < 6) { step(STEP); g.acc -= STEP; n++; }
      if (n === 6) g.acc = 0;
    }
    if (game !== g) return;
    for (const f of g.fs) f.bq.slerp(IDQ, 1 - Math.exp(-dt * 6));
    if (g.endT > 0 && (g.endT -= dt) <= 0) showResult();
    sendState(now);
    const me = g.fs[g.me], op = g.fs[1 - g.me];
    snd.setHum(0, me.on, me.swing);
    snd.setHum(1, op.on, op.swing);
    const menu = screenOpen();
    const mode = g.mode === 'demo' ? (phoneLive() ? 'shoulder' : 'orbit') : !$('result').hidden ? 'orbit' : 'fp';
    view.update(dt, g.fs, mode, g.me, menu && innerWidth > 860 ? 0.17 : 0);
    if (g.mode !== 'demo') renderHUD();
  }
  view.render();
  if (bannerT > 0 && (bannerT -= dt) <= 0) $('banner').className = '';
  if (toastT > 0 && (toastT -= dt) <= 0) $('toast').classList.remove('show');
  uiT -= dt;
  if (uiT <= 0) {
    uiT = 0.25;
    renderPair();
    pushPad(false);
    if (MP.room) {
      if (MP.lastPh !== phoneLive()) { sendHello(); renderRoom(); }
      if (!$('room').hidden) {
        if (MP.joinT > 0 && (MP.joinT -= 0.25) <= 0) renderRoom();
        if (MP.noteT > 0 && (MP.noteT -= 0.25) <= 0) { MP.note = ''; renderRoom(); }
      }
    }
  }
}
// keeps a multiplayer match ticking while the tab is in the background (requestAnimationFrame stops there)
setInterval(() => {
  const now = performance.now();
  if (!game || game.mode !== 'mp' || now - lastFrame < 250) return;
  const dt = Math.min(1, (now - Math.max(lastFrame, lastT)) / 1000);
  lastT = now;
  lastFrame = now - 200;
  for (let t = 0; t < dt; t += STEP) step(STEP);
  sendState(now);
}, 200);

export function startPC() {
  $('pad').hidden = true;
  $('pc').hidden = false;
  nameInput = $('nameInput');
  codeInput = $('codeInput');
  nameInput.value = store.get('name', '');
  view = new View($('view'));
  snd = new Sound();
  snd.setMuted(store.get('muted', '0') === '1');
  $('soundBtn').textContent = snd.muted ? 'HANG: KI' : 'HANG: BE';
  buildColorSegs();
  syncColors();
  bindUI();
  renderQR();
  initPair();
  renderPair();
  if (matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches) $('touchNote').hidden = false;
  showMenu();
  readInvite();
  // testing hook (localhost, or a Cloudflare quick tunnel to it)
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.hostname.endsWith('.trycloudflare.com')) {
    window.__fk = {
      get game() { return game; }, PAIR, MP, view, startSolo, pairId, padUrl, mouse, keys,
      frames(n = 1, dt = 1 / 60) { for (let k = 0; k < n; k++) runFrame(lastT + dt * 1000); },
    };
  }
  requestAnimationFrame((t) => { lastT = t; frame(t); $('loading').hidden = true; });
}
