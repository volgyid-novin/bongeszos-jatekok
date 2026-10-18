// Global leaderboard (RANGLISTA): the screen, submitPB for the results screen, top1 for the map cards. The transport (Nostr
// relays, keys, signatures, cache) lives in nostr.js; see the `app` contract at the top of main.js.
//   submitPB(mapId, run)  run = { mapId, mapHash, ticks, time, splits[], ghost (base64 | null), name }; true = published to at least
//                         one relay, false = could not be, undefined = said nothing (publishing switched off for tests:
//                         localStorage 'pajzsugras:no-publish' = '1')
//   top1(mapId)           -> { name, time (seconds) } | null     (cached, never throws)
import './mp.css';
import { medalTimes, medalFor, hasMedals, routeFloor } from './sim/world.js';
import { TICK } from './sim/const.js';
import { ghostAt } from './sim/ghost.js';
import { fmtTime, fmtDelta } from './hud.js';
import * as nostr from './nostr.js';

const DIFF_COLOR = { kikepzes: '#4cc9f0', konnyu: '#5af0a0', kozepes: '#ffd24a', nehez: '#ff8a2a', mester: '#ff4fa3', nincs: '#2ee6d4' };
const WR_COLOR = 0xffd24a;
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

let A = null;             // the app
let sel = null;           // the map shown
let board = null;         // the last result of nostr.getBoards
let busy = 0;             // token of the latest load (an older answer is dropped)
let wr = null;            // the world-record ghost being raced { mapId, g, name }

// ---------------------------------------------------------------- map infos for nostr.js
// floor: the geometric plausibility floor in seconds of a map without a proof route (sim/world.js routeFloor; nostr.js minTicks takes
// max(3 s, floor)); a map with an author time is judged by that instead
function infoOf(id) {
  const e = A && A.maps.get(id);
  if (!e) return null;
  const hash = A.mapHashOf(id);
  if (!hash) return null;
  const map = e.build();
  return { id, hash, authorTime: e.meta.authorTime, cpCount: map.checkpoints.length, floor: e.meta.authorTime > 0 ? 0 : routeFloor(map) };
}
// The maps the board knows: those with a finish (a map without one has nothing to record: it plays as a free run). Only when no map has
// one (an export of the editor that has no goal yet) all of them are listed, so that the screen is not empty.
const hasGoal = (e) => { try { return !!e.build().finish; } catch { return false; } };
function listed() {
  const all = A.maps.list, goal = all.filter(hasGoal);
  return goal.length ? goal : all;
}
const allInfos = () => (A ? listed().map((e) => infoOf(e.meta.id)).filter(Boolean) : []);
const boardIn = (res, id) => (res && res.ok && res.boards && res.boards[id]) || null;   // a getBoards result -> one map's board (missing: null)
const noPublish = () => { try { return localStorage.getItem('pajzsugras:no-publish') === '1'; } catch { return false; } };

// ---------------------------------------------------------------- public api
export async function submitPB(mapId, run) {
  try {
    if (!A || noPublish()) return undefined;
    const info = infoOf(mapId);
    if (!info || !run || (run.mapHash && run.mapHash !== info.hash)) return false;
    const r = await nostr.publishPB({ id: mapId, hash: info.hash }, run);
    if (r.ok) nostr.clearCache();
    return r.ok;
  } catch { return false; }
}

export async function top1(mapId) {
  try {
    const maps = allInfos();
    if (!maps.length) return null;
    const r = await nostr.getBoards(maps);
    const b = boardIn(r, mapId), e = b && b.top[0];
    return e ? { name: e.name, time: e.time } : null;
  } catch { return null; }
}

// ---------------------------------------------------------------- the world-record ghost in a solo run
function clearWr() {
  wr = null;
  if (A && A.figures && A.gfx && A.figures.has('__wr')) A.figures.remove('__wr');
}
function updateWr() {
  const w = A.world;
  if (!wr || A.mode !== 'solo' || A.mapId !== wr.mapId || !w || A.state !== 'playing') { if (A.figures.has('__wr')) A.figures.remove('__wr'); return; }
  if (w.clockState === 'ready') { if (A.figures.has('__wr')) A.figures.remove('__wr'); return; }
  const g = ghostAt(wr.g, w.clockState === 'finished' ? w.finishTicks : w.clock);
  A.figures.upsert('__wr', { name: '#1 ' + wr.name, color: WR_COLOR, pos: [g[0], g[1], g[2]], yaw: g[3], pitch: g[4], flags: 1, ghost: true, infer: true, trail: false });
}

async function raceGhost(entry) {
  const g = await nostr.unpackGhost(entry.ghost);
  if (!g || !g.n) { A.ui.toast('A szellem nem tölthető be.'); return; }
  const id = sel;
  if (A.startSolo) await A.startSolo(id);
  else {   // (main.js offers startSolo; this is the same flow for an app object without it)
    A.setMode('solo');
    A.input.lock();
    await A.loadMap(id);
    A.restartRun();
    A.play();
  }
  wr = { mapId: id, g, name: entry.name };
  A.ui.toast('A világelső szelleme veled fut (arany).', 2600);
}

// ---------------------------------------------------------------- the screen
const $q = (s) => A.ui.els.lb.querySelector(s);   // (ui.els.lb is #scr-lb)

function build() {
  const el = A.ui.els.lb;
  const tabs = listed().map((e) => {
    const m = e.meta;
    return `<button class="lb-tab" data-map="${esc(m.id)}" style="--dc:${DIFF_COLOR[m.diff] || '#fff'}"><b>${String(m.order).padStart(2, '0')}</b><span>${esc(m.name)}</span></button>`;
  }).join('');
  el.innerHTML = `
    <div class="top"><button class="btn ghost" data-act="back">‹ Vissza</button><h2 class="h1">Ranglista</h2><p class="sub">A világ legjobb idői pályánként.</p></div>
    <div class="scroll lb-scroll">
      <div class="lb-tabs">${tabs}</div>
      <div class="panel lb-panel">
        <div class="lb-head"></div>
        <div class="lb-body"></div>
        <div class="lb-status"></div>
        <div class="lb-foot">
          <p class="lb-note">A nevek és az idők nyilvánosak (Nostr).</p>
          <div class="row lb-actions">
            <button class="btn" data-act="send" hidden>Rekord küldése</button>
            <button class="btn" data-act="refresh">Frissítés</button>
            <button class="btn primary" data-act="ghost" hidden>Versenyezz a világelső szellemével</button>
          </div>
        </div>
      </div>
    </div>`;
  $q('[data-act=back]').onclick = () => A.showScreen('menu');
  $q('[data-act=refresh]').onclick = () => load(true);
  $q('[data-act=send]').onclick = sendLocal;
  $q('[data-act=ghost]').onclick = () => { const b = boardIn(board, sel), e = b && b.top[0]; if (e && e.ghost) raceGhost(e); };
  for (const t of el.querySelectorAll('.lb-tab')) t.onclick = () => { sel = t.dataset.map; render(); };
}

function localPB() {
  const info = infoOf(sel);
  return info ? A.store.getPB(sel, info.hash) : null;
}

async function sendLocal() {
  const pb = localPB(), info = infoOf(sel), btn = $q('[data-act=send]');
  if (!pb || !info) return;
  btn.disabled = true;
  const ok = await submitPB(sel, { mapId: sel, mapHash: info.hash, ticks: pb.ticks, time: pb.ticks / TICK, splits: pb.splits, ghost: pb.ghost, name: A.settings.name });
  btn.disabled = false;
  A.ui.toast(ok === true ? 'A rekord elküldve a ranglistára.' : ok === false ? 'A ranglista most nem érhető el.' : 'A küldés ki van kapcsolva.');
  if (ok) load(true);
}

function coin(time, medals) {
  if (!medals) return '';   // (no proof route, no medals)
  const m = medalFor(time, medals);
  return m ? `<span class="coin m-${m}" title="${m}"></span>` : '<span class="coin none"></span>';
}

function render() {
  if (!A || !A.ui.els.lb || !A.ui.els.lb.querySelector('.lb-panel')) return;
  const e = A.maps.get(sel);
  if (!e) {   // nothing to show (no built-in map yet)
    const st = $q('.lb-status');
    $q('.lb-head').innerHTML = ''; $q('.lb-body').innerHTML = '';
    st.textContent = 'Még nincs pálya a ranglistán.'; st.hidden = false;
    return;
  }
  const m = e.meta, medals = hasMedals(m) ? medalTimes(m.authorTime) : null, dc = DIFF_COLOR[m.diff] || '#fff', label = A.DIFF_LABEL[m.diff] ?? m.diff;
  for (const t of A.ui.els.lb.querySelectorAll('.lb-tab')) t.classList.toggle('on', t.dataset.map === sel);
  const tag = (k, l) => `<span>${l} <span class="coin m-${k}"></span>${fmtTime(medals[k], 1)}</span>`;
  $q('.lb-head').innerHTML = `
    <div><h3 style="--dc:${dc}">${esc(m.name)}</h3>${label ? `<span class="chip" style="--dc:${dc}">${esc(label)}</span>` : ''}</div>
    ${medals ? `<div class="targets lb-targets">${tag('author', 'Szerző')}${tag('gold', 'Arany')}${tag('silver', 'Ezüst')}${tag('bronze', 'Bronz')}</div>` : ''}`;

  const pb = localPB();
  const b = boardIn(board, sel);
  const body = $q('.lb-body'), status = $q('.lb-status');
  let html = '', note = '';
  if (!board) note = 'Ranglista betöltése…';
  else if (!board.ok) note = board.error === 'crypto' ? 'A ranglistához biztonságos kapcsolat (https) kell.' : 'A ranglista most nem érhető el (nincs kapcsolat a relékhez). Próbáld újra később.';
  else if (!b || !b.top.length) note = 'Ezen a pályán még nincs rekord. Legyél te az első!';
  if (b && b.top.length) {
    const best = b.top[0].ticks;
    const row = (r, rank) => `<tr class="${r.mine ? 'me' : ''}${rank <= 3 ? ' p' + rank : ''}"><td class="rk">${rank}</td><td class="nm">${esc(r.name)}${r.mine ? ' <small>(te)</small>' : ''}</td><td class="tm num">${fmtTime(r.time)}</td><td class="df num">${rank === 1 ? '' : fmtDelta((r.ticks - best) / TICK)}</td>${medals ? `<td class="md">${coin(r.time, medals)}</td>` : ''}</tr>`;
    html = `<table class="lb-table"><thead><tr><th>#</th><th>Játékos</th><th>Idő</th><th>Különbség</th>${medals ? '<th>Érem</th>' : ''}</tr></thead><tbody>${
      b.top.map((r) => row(r, r.rank)).join('')}${
      b.me && b.me.rank > b.top.length ? `<tr class="gap"><td colspan="${medals ? 5 : 4}">⋯</td></tr>${row(b.me, b.me.rank)}` : ''}</tbody></table>`;
  }
  if (pb && !(b && b.me && b.me.ticks <= pb.ticks)) {
    html += `<p class="lb-local">Saját rekord ezen a gépen: <b class="num">${fmtTime(pb.ticks / TICK)}</b>${board && board.ok ? ' (még nincs fent a ranglistán)' : ''}</p>`;
  }
  body.innerHTML = html;
  status.textContent = note;
  status.hidden = !note;
  status.classList.toggle('busy', !board);
  const meta = board && board.ok ? `${board.relays}/${nostr.RELAYS.length} relé · ${b ? b.total : 0} rekord · frissítve ${new Date(board.at).toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit' })}` : '';
  $q('.lb-note').textContent = 'A nevek és az idők nyilvánosak (Nostr).' + (meta ? ' · ' + meta : '');
  const top = b && b.top[0];
  $q('[data-act=ghost]').hidden = !(top && top.ghost);
  $q('[data-act=send]').hidden = !(pb && nostr.hasCrypto() && !noPublish() && board && board.ok && !(b && b.me && b.me.ticks <= pb.ticks));
}

async function load(force) {
  const token = ++busy;
  if (force) { board = null; render(); }
  const infos = allInfos();
  if (!infos.length) return;
  const r = await nostr.getBoards(infos, { force });
  if (token !== busy) return;
  board = r;
  render();
}

function onScreen() {
  if (!A.ui.els.lb.querySelector('.lb-panel')) build();
  const ids = listed().map((e) => e.meta.id);
  if (!sel || !ids.includes(sel)) sel = ids.includes(A.mapId) ? A.mapId : ids[0];
  render();
  if (!board || !board.ok) load(false);
  else if (Date.now() - board.at > 5 * 60 * 1000) load(false);
}

export function initLeaderboard(app) {
  A = app;
  A.on('screen', ({ id }) => {
    if (id === 'lb') onScreen();
    if (id === 'menu' || id === 'play' || id === 'room' || id === 'lb') clearWr();
  });
  A.on('map', ({ id }) => { if (wr && id !== wr.mapId) clearWr(); });
  A.on('tick', () => { if (wr) updateWr(); });
  A.on('exit', clearWr);
}
