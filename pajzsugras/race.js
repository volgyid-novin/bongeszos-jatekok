// Multiplayer race (SZOBA): rooms over WebRTC (net.js), up to 8 humans, no bots. See the `app` contract at the top of main.js.
//
// Everyone runs the room's map on their own sim: free warm-up runs while the lobby waits, then the host starts a race: countdown (frozen at the start), GO, every peer times itself in sim ticks and reports checkpoints (`cp`) and
// the finish (`fin`). The host ends the race (all finished / 60 s after the first finisher / cap max(180 s, 3 x author time)),
// hands out the points 10-8-6-5-4-3-2-1 (`end`), the results stay up for ~8 s, then everyone is back at the start (warm-up).
// Others are shown as translucent figures (an opaque Gorge when the local model exists: solid) from 20 Hz `st` packets, rendered 120 ms behind with linear interpolation.
// The host is sticky (net.js): the creator keeps it, joiners never take it over; they wait as spectators while a race is on and are
// admitted to the roster at the next lobby. When the host leaves, the lowest connected id of the race's entrants (of the roster in the
// lobby) continues from its own copy of the room / race record. A room that formed twice (two joiners that each timed out alone) has
// two hosts until they meet: then the stronger one stays (outranks) and the other one, and its followers, follow it.
import './mp.css';
import { RaceRoom, selfId, MAX_PLAYERS, isCode, cleanCode, randomCode } from './net.js';
import { TICK } from './sim/const.js';
import { fmtTime } from './hud.js';
import { cleanName } from './store.js';
import { minTicks } from './nostr.js';

const POINTS = [10, 8, 6, 5, 4, 3, 2, 1];
const COLORS = [0xff8a2a, 0x2ee6d4, 0xffd24a, 0xff5c8a, 0x7a8bff, 0x5af0a0, 0xc07bff, 0xff5c4a];
const DIFF_COLOR = { kikepzes: '#4cc9f0', konnyu: '#5af0a0', kozepes: '#ffd24a', nehez: '#ff8a2a', mester: '#ff4fa3', nincs: '#2ee6d4' };
const COUNT_MS = 3500;            // from the `start` message to GO
const RESULT_MS = 8000;
const AFTER_FIRST_MS = 60000;     // the race ends this long after the first finisher
const SEND_MS = 50;               // 20 Hz state packets
const INTERP_MS = 120;
const BEAT_MS = 2000;             // the host repeats the lobby state now and then (a lost packet heals itself)
const JOIN_WAIT_MS = 7000;        // a joiner that hears nobody becomes the host of an empty room (WebRTC over the relays can take seconds)
const HELLO_MS = 250;             // a `hello` makes the host re-send the lobby at most this often (the first one of a peer always does)

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
const css = (c) => '#' + c.toString(16).padStart(6, '0');
const colorOf = (slot) => COLORS[(slot | 0) & 7];
const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi);
const wrapPi = (a) => { a %= Math.PI * 2; return a > Math.PI ? a - Math.PI * 2 : a < -Math.PI ? a + Math.PI * 2 : a; };
const inviteUrl = (c) => `${location.origin}${location.pathname}#${c}`;

export function initRace(app) {
  const $ = (id) => document.getElementById(id);
  const root = $('scr-room'), hudEl = $('race-hud');

  // ---------------------------------------------------------------- state
  let room = null, code = '';
  let synced = false;                 // the room state (map, roster) is known: created it, or a lobby message arrived
  let mapId = null, mapHash = null;   // the room's map, as the host says
  let phase = 'lobby';                // local: lobby | count | race | results
  let hostPhase = 'lobby';            // what the host last said (a late joiner waits while a race is on)
  let raceNo = 0;
  let roster = [];                    // [{ id, name, slot, mh }] in slot order; the host decides it
  let totals = {};                    // id -> points over the session
  let race = null;                    // { no, mapId, cpCount, entrants[{id,name,slot}], cp Map(id -> {n, ticks}), fin Map(id -> ticks), goAt, firstFinAt, endedAt }
  let lastResults = null;             // { no, mapName, rows[{ id, name, slot, ticks (-1 = DNF), cp, place, pts }] }
  let tabDown = false, mapJob = 0, lastBeat = 0, helloPending = false;
  const info = new Map();             // peer id -> { name, mh } from `hello`
  const bufs = new Map();             // peer id -> [{ t, x, y, z, yaw, pitch, cp, fl }]
  const shown = new Set();            // ids that have a figure
  const waited = new Set();           // joinTimeout: peers / hosts that were given their round and stayed silent
  let timers = [], sendTimer = 0, slowTimer = 0, joinTimer = 0;

  const myName = () => cleanName(app.settings ? app.settings.name : app.local.name);
  const localHash = () => (mapId && app.maps.has(mapId) ? app.mapHashOf(mapId) : null);
  // a map without a finish (an export of the editor that has no goal yet) cannot be raced: it plays as a free run, a room does not offer it
  const noGoal = (e) => { try { return !e.build().finish; } catch { return false; } };
  const NO_GOAL = 'Ennek a pályának még nincs célja.';
  // the map a new room starts on: the loaded one, then the last played, then the first (a map of the editor is none of them: not in the
  // registry, the others could not load it); the first of these that has a finish, else (no map has one) the first of them
  const defaultMap = () => {
    const c = [app.mapId, app.settings && app.settings.lastMap, ...app.maps.ids].filter((id) => app.maps.has(id));
    return c.find((id) => !noGoal(app.maps.get(id))) || c[0];
  };
  const mismatch = () => !!(mapHash && localHash() && mapHash !== localHash());
  const isHost = () => !!room && synced && room.isHost;
  const connected = (id) => id === selfId || (room && room.peers.has(id));
  const cpCountOf = (id) => { const e = app.maps.get(id); try { return e ? e.build().checkpoints.length : 0; } catch { return 0; } };
  const mapMeta = (id) => { const e = app.maps.get(id); return e ? e.meta : null; };
  const inRace = () => !!(room && race && phase === 'race' && app.mode === 'room');
  const toast = (m, ms) => { try { app.ui.toast(m, ms); } catch { /* ui not ready */ } };

  function setAllow() {
    if (app.mode !== 'room') return;
    const racing = phase === 'count' || phase === 'race';
    app.pauseFreezes = false;
    app.allow.restart = !racing;     // Enter restarts the warm-up, but not a race
    app.allow.respawn = phase !== 'count';
  }

  // ---------------------------------------------------------------- joining and leaving
  function enterRoom(c, created) {
    if (room) return false;
    try { room = new RaceRoom(c); } catch (e) { console.error('[pajzsugras] room failed', e); room = null; formNote('A szobához nem sikerült csatlakozni (WebRTC nem elérhető?).', true); return false; }
    code = c; synced = !!created;
    roster = []; totals = {}; info.clear(); bufs.clear(); waited.clear(); race = null; lastResults = null; raceNo = 0; phase = 'lobby'; hostPhase = 'lobby'; helloPending = false;
    mapId = created ? defaultMap() : null; mapHash = created ? (mapId === app.mapId ? app.mapHash : app.mapHashOf(mapId)) : null;
    room.on('hello', onHello); room.on('lobby', onLobby); room.on('st', onSt); room.on('start', onStart);
    room.on('cp', onCp); room.on('fin', onFin); room.on('end', onEnd);
    room.onJoin = onJoin; room.onLeave = onLeave;
    try { history.replaceState(null, '', '#' + c); } catch { /* sandboxed */ }
    app.setMode('room'); setAllow();
    if (created) { hostRefresh(); app.restartRun(); } else joinTimer = setTimeout(joinTimeout, JOIN_WAIT_MS);
    sendTimer = setInterval(() => { sendState(); updateFigures(performance.now()); }, SEND_MS);
    slowTimer = setInterval(slowTick, 250);
    renderAll();
    return true;
  }

  // Still no lobby after JOIN_WAIT_MS. A peer that already follows a host says so in its hello: wait for that host (one more round).
  // Otherwise the lowest id of us and the peers that are still joining takes the empty room; when that is someone else, wait for it
  // one more round, then go on without it. Two hosts that end up in one room settle it in onLobby.
  function joinTimeout() {
    joinTimer = 0;
    if (!room || synced) return;
    const alone = !room.peers.size, hostOf = (id) => (info.get(id) ? info.get(id).host : '');
    const hint = [...room.peers].map(hostOf).find((h) => h && h !== selfId && !waited.has(h));
    const pick = hint || room.elect([selfId, ...room.peers].filter((id) => !waited.has(id) && !hostOf(id)));
    if (pick === selfId) { synced = true; if (!mapId) mapId = defaultMap(); mapHash = localHash(); sendHello(); hostRefresh(); toast(alone ? 'Üres szoba: te vagy a házigazda.' : 'Nincs házigazda: te vagy a házigazda.'); return; }
    waited.add(pick);
    sendHello();   // the others are there, the lobby just has not reached us
    joinTimer = setTimeout(joinTimeout, JOIN_WAIT_MS);
  }

  function leaveRoom(msg) {
    if (!room) return;
    clearInterval(sendTimer); clearInterval(slowTimer); clearTimeout(joinTimer); clearCountdown();
    const r = room; room = null;
    try { r.leave(); } catch { /* already gone */ }
    for (const id of shown) app.figures.remove('p:' + id);
    shown.clear(); bufs.clear(); info.clear();
    try { app.hud.standings(null); } catch { /* hud not ready */ }
    try { history.replaceState(null, '', location.pathname + location.search); } catch { /* sandboxed */ }
    if (app.mode === 'room') app.setMode('solo');
    roster = []; totals = {}; race = null; lastResults = null; phase = 'lobby'; hostPhase = 'lobby'; synced = false; tabDown = false; mapJob++;
    if (msg) toast(msg, 2600);
    renderAll();
  }

  // ---------------------------------------------------------------- messages
  const helloMsg = () => ({ name: myName(), mh: localHash() || '', host: room && synced ? room.hostId : '' });   // host: whom I follow ('' = not synced yet)
  const sendHello = () => { if (room) room.send('hello', helloMsg()); };

  function onJoin(pid) {
    room.send('hello', helloMsg(), pid);
    if (isHost()) { room.send('lobby', lobbyMsg(), pid); hostRefresh(); }   // the newcomer learns the room (and who the host is) at once
  }

  function onHello(m, pid) {
    if (!m || typeof m !== 'object') return;
    const first = !info.has(pid);
    const host = typeof m.host === 'string' ? m.host.slice(0, 64) : '';
    info.set(pid, { name: cleanName(m.name), mh: String(m.mh || '').slice(0, 32), host });
    // our host follows another one now (it yielded to a stronger host): so do we (a host that has just left is no longer a peer)
    if (synced && pid === room.hostId && host && host !== pid && host !== selfId && room.peers.has(host)) switchHost(host);
    if (!isHost()) { renderAll(); return; }
    if (first || performance.now() - lastBeat >= HELLO_MS) hostRefresh(); else helloPending = true;   // (slowTick catches up)
  }

  // the roster / entrants decide who follows a host that left: the same ids on every peer
  const successors = () => (race && phase !== 'lobby' ? race.entrants : roster).map((p) => p.id);

  function onLeave(pid) {
    const wasHost = pid === room.hostId;
    info.delete(pid); bufs.delete(pid);
    if (shown.delete(pid)) app.figures.remove('p:' + pid);
    if (wasHost) { room.elect(successors()); sendHello(); }
    if (isHost()) {
      if (wasHost) toast('A házigazda kilépett, mostantól te vagy a házigazda.', 3000);
      hostRefresh();
    } else renderAll();
    pushStandings();
  }

  function lobbyMsg() {
    return { host: room.hostId, mapId, mapHash, phase, raceNo, players: roster.map((p) => [p.id, p.name, p.slot, p.mh]), totals };
  }

  // host: make the roster match who is connected, then tell everyone. Newcomers are admitted between races only (they wait as
  // spectators while one is on) and never past 8; a peer that does not fit is told to leave.
  function hostRefresh() {
    if (!isHost()) return;
    const alive = new Set([selfId, ...room.peers]);
    roster = roster.filter((p) => alive.has(p.id));
    const add = (id) => {
      const used = new Set(roster.map((p) => p.slot));
      let slot = 0; while (used.has(slot)) slot++;
      roster.push({ id, name: '', slot, mh: '' });
    };
    if (!roster.some((p) => p.id === selfId)) add(selfId);
    for (const id of room.peers) {
      if (!info.has(id) || roster.some((p) => p.id === id)) continue;
      if (roster.length >= MAX_PLAYERS) room.send('lobby', { host: selfId, full: true }, id);
      else if (phase === 'lobby') add(id);
    }
    for (const p of roster) {
      const i = p.id === selfId ? helloMsg() : info.get(p.id);
      if (i) { p.name = i.name; p.mh = i.mh; }
    }
    roster.sort((a, b) => a.slot - b.slot);
    if (!mapId) { mapId = defaultMap(); }
    mapHash = app.mapHashOf(mapId);
    lastBeat = performance.now(); helloPending = false;
    room.send('lobby', lobbyMsg());
    renderAll();
  }

  // The room has another host now (ours yielded to a stronger one, or we do): follow it. A race of our own is dropped (that only
  // happens when both hosts were mid-race); the winner's lobby brings the roster, the map and the totals.
  function switchHost(id) {
    room.follow(id);
    race = null; raceNo = 0;
    if (phase !== 'lobby') toLobby();
    sendHello();
  }

  // Two hosts met: both sides run this over the same two states, so exactly one of them yields. A host that is mid-race (countdown,
  // race, results) wins, then the higher race number, then the fuller roster, then the lower id.
  const hostState = (id, ph, no, n) => ({ id, live: ph !== 'lobby' ? 1 : 0, no, n });
  function outranks(a, b) {
    const d = (a.live - b.live) || (a.no - b.no) || (a.n - b.n);
    return d ? d > 0 : a.id < b.id;
  }

  // Only the host speaks for the room: once synced, a lobby counts only from the host. A lobby always carries `host` = its sender
  // (a peer that claims to be someone else is ignored). The first lobby a peer hears is from the host that names itself. A lobby
  // from another self-named host is a second host: it counts only when it outranks ours (the one we follow, or ourselves).
  function onLobby(m, pid) {
    if (!m || typeof m !== 'object' || !room || m.host !== pid) return;
    if (m.full) { if (!synced || pid === room.hostId) leaveRoom('A szoba tele van (legfeljebb 8 játékos).'); return; }
    if (typeof m.mapId !== 'string' || !app.maps.has(m.mapId) || !Array.isArray(m.players)) return;
    const rs = [];
    for (const e of m.players) {
      if (!Array.isArray(e) || rs.length >= MAX_PLAYERS) continue;
      const id = String(e[0]).slice(0, 64);
      if (!rs.some((p) => p.id === id)) rs.push({ id, name: cleanName(e[1]), slot: (e[2] | 0) & 7, mh: String(e[3] || '').slice(0, 32) });
    }
    if (synced && pid !== room.hostId) {
      const theirs = hostState(pid, String(m.phase), num(m.raceNo, 0, 1e6) ? m.raceNo | 0 : 0, rs.length);
      if (!outranks(theirs, hostState(room.hostId, isHost() ? phase : hostPhase, raceNo, roster.length))) return;
      switchHost(pid);
    }
    const t = {};
    if (m.totals && typeof m.totals === 'object') for (const k of Object.keys(m.totals).slice(0, 64)) if (num(m.totals[k], 0, 99999)) t[k] = m.totals[k] | 0;
    const first = !synced;
    synced = true; clearTimeout(joinTimer);
    room.follow(pid);
    roster = rs; totals = t;
    hostPhase = String(m.phase);
    if (num(m.raceNo, 0, 1e6) && m.raceNo > raceNo && phase === 'lobby') raceNo = m.raceNo | 0;
    const newMap = m.mapId !== mapId;
    mapId = m.mapId; mapHash = String(m.mapHash || '');
    if (newMap || first) setRoomMap();
    if (hostPhase === 'lobby' && phase !== 'lobby' && m.raceNo >= raceNo) toLobby();
    renderAll();
  }

  // ---------------------------------------------------------------- the room's map
  function setRoomMap() {
    const job = ++mapJob, id = mapId;
    return (async () => {
      try { await app.loadMap(id); } catch (e) { console.error('[pajzsugras] room map failed', e); toast('A pálya betöltése nem sikerült.'); return; }
      if (job !== mapJob || !room) return;
      if (phase === 'lobby') app.restartRun();
      sendHello();
      renderAll();
    })();
  }

  function hostPickMap(id) {
    if (!isHost() || phase !== 'lobby' || !app.maps.has(id) || id === mapId) return;
    if (noGoal(app.maps.get(id))) { toast(NO_GOAL); return; }
    mapId = id; mapHash = app.mapHashOf(id);
    hostRefresh();
    setRoomMap();
  }

  // ---------------------------------------------------------------- state packets and the others' figures
  function sendState() {
    if (!room || !app.world || app.mode !== 'room') return;
    const w = app.world, ps = w.ps;
    room.send('st', [Math.round(ps.pos[0] * 100), Math.round(ps.pos[1] * 100), Math.round(ps.pos[2] * 100),
      Math.round(ps.yaw * 100), Math.round(ps.pitch * 100), w.cpIndex | 0, w.playerFlags() | 0]);
  }

  function onSt(a, pid) {
    if (!Array.isArray(a) || a.length < 7) return;
    for (let i = 0; i < 7; i++) if (typeof a[i] !== 'number' || !Number.isFinite(a[i])) return;
    let b = bufs.get(pid);
    if (!b) { b = []; bufs.set(pid, b); }
    b.push({ t: performance.now(), x: a[0] / 100, y: a[1] / 100, z: a[2] / 100, yaw: a[3] / 100, pitch: a[4] / 100, cp: a[5], fl: a[6] | 0 });
    if (b.length > 16) b.shift();
  }

  function sample(b, rt) {
    const n = b.length;
    if (rt <= b[0].t) return b[0];
    if (rt >= b[n - 1].t) return b[n - 1];
    let i = n - 2;
    while (i > 0 && b[i].t > rt) i--;
    const p = b[i], q = b[i + 1];
    let f = (rt - p.t) / Math.max(1, q.t - p.t);
    if (Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z) > 6) f = f < 0.5 ? 0 : 1;   // a respawn / restart: no streak through the map
    return { x: p.x + (q.x - p.x) * f, y: p.y + (q.y - p.y) * f, z: p.z + (q.z - p.z) * f, yaw: p.yaw + wrapPi(q.yaw - p.yaw) * f, pitch: p.pitch + (q.pitch - p.pitch) * f, cp: q.cp, fl: q.fl };
  }

  function updateFigures(now) {
    const live = new Set();
    if (room && app.mode === 'room' && app.state !== 'loading') {
      for (const p of roster) {
        if (p.id === selfId) continue;
        const b = bufs.get(p.id);
        if (!b || !b.length) continue;
        const s = sample(b, now - INTERP_MS);
        live.add(p.id);
        app.figures.upsert('p:' + p.id, { name: p.name, color: colorOf(p.slot), pos: [s.x, s.y, s.z], yaw: s.yaw, pitch: s.pitch, flags: s.fl, ghost: true, solid: true });
      }
    }
    for (const id of [...shown]) if (!live.has(id)) { app.figures.remove('p:' + id); shown.delete(id); }
    for (const id of live) shown.add(id);
  }

  // ---------------------------------------------------------------- the race
  function clearCountdown() { for (const t of timers) clearTimeout(t); timers = []; }

  async function onStart(m, pid) {
    if (!room || !m || typeof m !== 'object' || !synced || pid !== room.hostId && pid !== selfId) return;
    if (typeof m.mapId !== 'string' || !app.maps.has(m.mapId) || !num(m.raceNo, 1, 1e6)) return;
    if (race && race.no === m.raceNo) return;
    clearCountdown();
    const t0 = performance.now(), delay = num(m.delayMs, 1000, 10000) ? m.delayMs : COUNT_MS;
    mapId = m.mapId; mapHash = String(m.mapHash || mapHash || '');
    raceNo = m.raceNo | 0; phase = 'count'; hostPhase = 'count';
    race = { no: raceNo, mapId, cpCount: cpCountOf(mapId), entrants: roster.map((p) => ({ id: p.id, name: p.name, slot: p.slot })),
      cp: new Map(), fin: new Map(), goAt: null, firstFinAt: null, endedAt: null };
    const no = raceNo;
    app.setMode('room'); setAllow();
    renderAll();
    try { await app.loadMap(mapId); } catch { toast('A pálya betöltése nem sikerült.'); }
    if (!room || !race || race.no !== no) return;
    app.restartRun({ frozen: true, autoStart: false });
    if (app.state !== 'playing') app.play();
    pushStandings();
    const at = (ms, fn) => timers.push(setTimeout(fn, Math.max(0, t0 + ms - performance.now())));
    app.hud.center('KÉSZÜLJ!', { kind: 'info', ms: delay - 3000 });
    at(delay - 3000, () => app.hud.center('3', { kind: 'big', ms: 950 }));
    at(delay - 2000, () => app.hud.center('2', { kind: 'big', ms: 950 }));
    at(delay - 1000, () => app.hud.center('1', { kind: 'big', ms: 950 }));
    at(delay, goRace);
  }

  function goRace() {
    if (!room || !race || phase !== 'count') return;
    phase = 'race'; race.goAt = performance.now();
    app.setFrozen(false); app.startRun();
    app.hud.center('INDULJ!', { kind: 'good', ms: 900 });
    setAllow(); renderAll();
  }

  function onCp(m, pid) {
    if (!race || !m || m.no !== race.no || !race.entrants.some((p) => p.id === pid) || !num(m.n, 0, 1e6) || !num(m.ticks, 0, 1e8)) return;
    const n = Math.min(m.n | 0, race.cpCount), c = race.cp.get(pid);
    if (!c || n > c.n) race.cp.set(pid, { n, ticks: m.ticks | 0 });
    pushStandings();
  }

  // a finish counts once, after GO, when it is not faster than the map allows and the peer has reported every checkpoint
  function onFin(m, pid) {
    if (!race || phase !== 'race' || !m || m.no !== race.no || !race.entrants.some((p) => p.id === pid) || race.fin.has(pid)) return;
    const meta = mapMeta(race.mapId), c = race.cp.get(pid);
    if (!num(m.ticks, meta ? minTicks(meta.authorTime) : 1, 1e8) || (c ? c.n : 0) !== race.cpCount) return;
    race.fin.set(pid, m.ticks | 0);
    if (!race.firstFinAt) race.firstFinAt = performance.now();
    pushStandings();
    if (isHost()) slowTick();
  }

  app.on('cp', (e) => {
    if (!inRace()) return;
    const n = e.index + 1;
    race.cp.set(selfId, { n, ticks: e.ticks });
    room.send('cp', { no: race.no, n, ticks: e.ticks });
    pushStandings();
  });

  app.on('finish', (run) => {
    if (!inRace() || run.mapId !== race.mapId || race.fin.has(selfId)) return;
    const meta = mapMeta(race.mapId);   // the same floor the others apply to our fin
    if (meta && run.ticks < minTicks(meta.authorTime)) return;
    race.fin.set(selfId, run.ticks);
    if (!race.firstFinAt) race.firstFinAt = performance.now();
    room.send('fin', { no: race.no, ticks: run.ticks, splits: run.splits });
    const place = 1 + [...race.fin.values()].filter((t) => t < run.ticks).length;
    app.hud.center(`${place}. HELY · ${fmtTime(run.time)}`, { kind: 'gold', ms: 3200 });
    pushStandings();
    if (isHost()) slowTick();
  });

  // a name changed in BEÁLLÍTÁSOK reaches the room at once
  app.on('setting', (e) => { if (e.key === 'name' && room) sendHello(); });

  // live standings: finished by time, then by checkpoints reached (earlier = ahead)
  function standingRows() {
    if (!race) return [];
    const rows = race.entrants.filter((p) => connected(p.id) || race.fin.has(p.id)).map((p) => {
      const f = race.fin.get(p.id), c = race.cp.get(p.id);
      return { id: p.id, name: p.name, color: colorOf(p.slot), cp: f != null ? race.cpCount : c ? c.n : 0, cpCount: race.cpCount, time: f != null ? f / TICK : null, finished: f != null, me: p.id === selfId, t: c ? c.ticks : 0, slot: p.slot };
    });
    rows.sort((a, b) => (a.finished !== b.finished ? (a.finished ? -1 : 1) : a.finished ? a.time - b.time : b.cp - a.cp || a.t - b.t) || a.slot - b.slot);
    return rows;
  }
  function pushStandings() {
    if (!room || app.mode !== 'room') return;
    try { app.hud.standings(race && (phase === 'count' || phase === 'race') ? standingRows() : null); } catch { /* hud not ready */ }
    renderBoard();
  }

  // host: start a race
  function startRace() {
    if (!isHost() || phase !== 'lobby' || !mapId) return;
    raceNo += 1;
    const msg = { raceNo, mapId, mapHash: app.mapHashOf(mapId), delayMs: COUNT_MS };
    room.send('start', msg);
    onStart(msg, selfId);   // (sets the phase synchronously)
    hostRefresh();          // tells everyone
  }

  function raceShouldEnd(now) {
    const alive = race.entrants.filter((p) => connected(p.id));
    if (!alive.length || alive.every((p) => race.fin.has(p.id))) return true;
    if (race.firstFinAt && now - race.firstFinAt >= AFTER_FIRST_MS) return true;
    const meta = mapMeta(race.mapId), cap = Math.max(180, 3 * (meta && meta.authorTime > 0 ? meta.authorTime : 60)) * 1000;   // (180 s without a proof route)
    return race.goAt != null && now - race.goAt >= cap;
  }

  function endRace() {
    const E = race.entrants.filter((p) => connected(p.id) || race.fin.has(p.id));
    const fin = E.filter((p) => race.fin.has(p.id)).sort((a, b) => race.fin.get(a.id) - race.fin.get(b.id) || a.slot - b.slot);
    const dnf = E.filter((p) => !race.fin.has(p.id)).sort((a, b) => (race.cp.get(b.id)?.n || 0) - (race.cp.get(a.id)?.n || 0) || a.slot - b.slot);
    const results = [];
    for (const p of fin) {
      const ticks = race.fin.get(p.id), place = 1 + fin.filter((q) => race.fin.get(q.id) < ticks).length;
      results.push([p.id, ticks, race.cpCount, place, POINTS[place - 1] || 0]);
    }
    for (const p of dnf) results.push([p.id, -1, race.cp.get(p.id)?.n || 0, 0, 0]);
    const t = { ...totals };
    for (const r of results) if (r[4]) t[r[0]] = (t[r[0]] || 0) + r[4];
    const msg = { no: race.no, results, totals: t };
    room.send('end', msg);
    onEnd(msg, selfId);
  }

  function onEnd(m, pid) {
    if (!room || !race || !m || m.no !== race.no || race.endedAt != null || (pid !== room.hostId && pid !== selfId) || !Array.isArray(m.results)) return;
    const rows = [];
    for (const r of m.results.slice(0, MAX_PLAYERS)) {
      if (!Array.isArray(r)) continue;
      const id = String(r[0]), p = race.entrants.find((x) => x.id === id) || roster.find((x) => x.id === id);
      if (p) rows.push({ id, name: p.name, slot: p.slot, ticks: num(r[1], 1, 1e8) ? r[1] | 0 : -1, cp: r[2] | 0, place: r[3] | 0, pts: r[4] | 0 });
    }
    const t = {};
    if (m.totals && typeof m.totals === 'object') for (const k of Object.keys(m.totals).slice(0, 64)) if (num(m.totals[k], 0, 99999)) t[k] = m.totals[k] | 0;
    totals = t;
    clearCountdown();
    race.endedAt = performance.now();
    const meta = mapMeta(race.mapId);
    lastResults = { no: race.no, mapName: meta ? meta.name : '', rows };
    phase = 'results'; hostPhase = 'results';
    try { app.hud.standings(null); } catch { /* hud not ready */ }
    setAllow(); renderAll();
  }

  // back to the warm-up: everyone at the start of the map, clock idle
  function toLobby() {
    clearCountdown();
    phase = 'lobby'; hostPhase = 'lobby';
    try { app.hud.standings(null); } catch { /* hud not ready */ }
    setAllow();
    if (room && app.mode === 'room') app.restartRun();
    renderAll();
  }

  // every 250 ms on every peer; only the host acts
  function slowTick() {
    if (!room) return;
    if (app.mode !== 'room') { leaveRoom('Kiléptél a szobából.'); return; }
    pushStandings();
    if (!isHost()) return;
    const now = performance.now();
    if (phase === 'race' && race && raceShouldEnd(now)) endRace();
    else if (phase === 'results' && race && race.endedAt != null && now - race.endedAt >= RESULT_MS) { toLobby(); hostRefresh(); }
    else if ((helloPending && now - lastBeat >= HELLO_MS) || now - lastBeat >= BEAT_MS) hostRefresh();
  }

  // ---------------------------------------------------------------- the board (Tab, results, room screen)
  function cellOf(p) {
    if ((phase === 'count' || phase === 'race') && race) {
      const f = race.fin.get(p.id);
      if (f != null) return fmtTime(f / TICK);
      const c = race.cp.get(p.id);
      return `CP ${c ? c.n : 0}/${race.cpCount}`;
    }
    const r = lastResults && lastResults.rows.find((x) => x.id === p.id);
    if (!r) return '–';
    return r.ticks > 0 ? fmtTime(r.ticks / TICK) : 'nem ért célba';
  }

  function boardHtml() {
    const rows = roster.map((p) => ({ p, total: totals[p.id] | 0, last: lastResults && phase !== 'count' && phase !== 'race' ? lastResults.rows.find((x) => x.id === p.id) : null }));
    if (phase === 'results' && lastResults) rows.sort((a, b) => ((a.last && a.last.place) || 99) - ((b.last && b.last.place) || 99) || b.total - a.total);
    else rows.sort((a, b) => b.total - a.total || a.p.slot - b.p.slot);
    const head = '<tr><th></th><th>Játékos</th><th>Futam</th><th>Pont</th><th>Összesen</th></tr>';
    const body = rows.map(({ p, total, last }, i) => `<tr class="${p.id === selfId ? 'me' : ''}" style="--c:${css(colorOf(p.slot))}">`
      + `<td class="rk">${phase === 'results' && last && last.place ? last.place : i + 1}</td><td class="nm"><i></i>${esc(p.name)}</td>`
      + `<td class="tm num">${esc(cellOf(p))}</td><td class="pt">${last && last.pts ? '+' + last.pts : ''}</td><td class="tt num">${total}</td></tr>`).join('');
    return `<table class="mp-table"><thead>${head}</thead><tbody>${body}</tbody></table>`;
  }

  function boardTitle() {
    const meta = mapMeta(mapId);
    if (phase === 'results') return `Futam vége · ${esc(lastResults ? lastResults.mapName : '')}`;
    if (phase === 'count' || phase === 'race') return `${raceNo}. futam · ${esc(meta ? meta.name : '')}`;
    return `Állás · ${esc(meta ? meta.name : '')}`;
  }

  function renderBoard() {
    const bd = hudEl.querySelector('.mp-board');
    if (!bd) return;
    const show = !!room && app.mode === 'room' && (tabDown || phase === 'results');
    bd.hidden = !show;
    hudEl.classList.toggle('over', show && phase === 'results');   // (the results card goes above an open pause menu)
    if (!show) return;
    bd.classList.toggle('res', phase === 'results');
    const html = `<h3>${boardTitle()}</h3>${boardHtml()}${phase === 'results' ? '<p class="mp-hint">Mindjárt vissza a rajthoz…</p>' : ''}`;
    if (html !== bd._html) { bd._html = html; bd.innerHTML = html; }
  }

  function renderBadge() {
    const b = hudEl.querySelector('.mp-badge');
    if (!b) return;
    const show = !!room && app.mode === 'room';
    b.hidden = !show;
    if (!show) return;
    const st = phase === 'count' ? 'indul' : phase === 'race' ? 'futam' : phase === 'results' ? 'eredmény' : hostPhase !== 'lobby' ? 'futam folyik' : 'bemelegítés';
    b.innerHTML = `<b>${esc(code)}</b> · ${roster.length} játékos · ${st}${mismatch() ? ' · <span class="bad">eltérő pálya!</span>' : ''}<small>Tab: állás</small>`;
  }

  // the mouse is not captured while the game runs (a race that starts without a click: the browser refuses the capture): a slim
  // bar instead of a pause menu, so the countdown, standings and results stay visible; a click on the game captures the mouse
  function renderLockBar() {
    const b = hudEl.querySelector('.mp-lock');
    if (!b) return;
    const show = !!room && app.mode === 'room' && app.state === 'playing' && !!app.input && !app.input.locked;
    if (b.hidden === show) { b.hidden = !show; if (document.body) document.body.classList.toggle('mp-nolock', show); }
  }

  // ---------------------------------------------------------------- the SZOBA screen
  let formBuilt = false, joinedFor = '';
  const q = (s) => root.querySelector(s);

  function buildForm() {
    formBuilt = true; joinedFor = '';
    root.innerHTML = `
      <div class="top"><button class="btn ghost" data-act="back">‹ Vissza</button><h2 class="h1">Szoba</h2><p class="sub">Futam haverokkal ugyanazon a pályán, élő állással. Legfeljebb 8 játékos, botok nincsenek.</p></div>
      <div class="scroll"><div class="panel mp-form">
        <div class="mp-field"><label class="lbl" for="mp-name">Neved</label><input type="text" id="mp-name" maxlength="16" autocomplete="off" value="${esc(myName())}"></div>
        <div class="mp-cols">
          <div class="mp-col"><h3 class="h2">Új szoba</h3><p class="sub">Te leszel a házigazda: te választod a pályát, és te indítod a futamot. A meghívó linket átküldheted a haverjaidnak.</p><button class="btn primary" data-act="create">Új szoba</button></div>
          <div class="mp-col"><h3 class="h2">Csatlakozás</h3><p class="sub">Írd be a haver 4 betűs szobakódját.</p><div class="row"><input type="text" id="mp-code" maxlength="4" autocomplete="off" spellcheck="false" placeholder="ABCD"><button class="btn" data-act="join">Csatlakozás</button></div></div>
        </div>
        <p class="mp-note" id="mp-note" hidden></p>
      </div></div>`;
    q('[data-act=back]').onclick = () => app.showScreen('menu');
    q('[data-act=create]').onclick = () => { app.audio.unlock(); setName(); enterRoom(randomCode(), true); };
    const join = () => {
      const c = q('#mp-code').value.trim().toUpperCase();
      if (!isCode(c)) { q('#mp-code').classList.add('err'); formNote('A szobakód 4 betű (I és O nincs benne).', true); return; }
      setName(); enterRoom(c, false);
    };
    q('[data-act=join]').onclick = join;
    q('#mp-code').oninput = (e) => { e.target.value = cleanCode(e.target.value); e.target.classList.remove('err'); };
    q('#mp-code').onkeydown = (e) => { if (e.key === 'Enter') join(); };
    q('#mp-name').onchange = setName;
  }

  function setName() {
    const el = q('#mp-name');
    if (el) { app.setSetting('name', el.value); el.value = myName(); }
    sendHello();
    if (isHost()) hostRefresh();
  }

  function formNote(text, warn) {
    const n = root.querySelector('#mp-note');
    if (!n) { if (text) toast(text, 2800); return; }
    n.textContent = text || ''; n.hidden = !text; n.classList.toggle('bad', !!warn);
  }

  function buildJoined() {
    formBuilt = false; joinedFor = code;
    const maps = app.maps.list.map((e) => {
      const m = e.meta, ng = noGoal(e);
      return `<button class="mp-map" data-map="${esc(m.id)}"${ng ? ` title="${NO_GOAL}"` : ''} style="--dc:${DIFF_COLOR[m.diff] || '#fff'}"><b>${String(m.order).padStart(2, '0')}</b><span>${esc(m.name)}</span><small>${ng ? 'még nincs célja' : esc(app.DIFF_LABEL[m.diff] ?? m.diff)}</small></button>`;
    }).join('');
    root.innerHTML = `
      <div class="top"><button class="btn ghost" data-act="back">‹ Vissza</button><h2 class="h1">Szoba</h2><p class="sub" id="mp-sub"></p></div>
      <div class="scroll"><div class="mp-grid">
        <div class="panel mp-left">
          <div class="lbl">Szobakód</div>
          <div class="mp-code">${esc(code)}</div>
          <div class="mp-link"><input type="text" id="mp-link" readonly value="${esc(inviteUrl(code))}"><button class="btn" data-act="copy">Link másolása</button></div>
          <div class="mp-warn" id="mp-warn" hidden></div>
          <div class="lbl mp-lblrow"><span>Játékosok</span><span id="mp-count"></span></div>
          <div class="mp-players" id="mp-players"></div>
          <div class="mp-field"><label class="lbl" for="mp-name">Neved</label><input type="text" id="mp-name" maxlength="16" autocomplete="off" value="${esc(myName())}"></div>
        </div>
        <div class="panel mp-right">
          <div class="lbl mp-lblrow"><span>Pálya</span><span id="mp-maphint"></span></div>
          <div class="mp-maps" id="mp-maps">${maps}</div>
          <p class="mp-status" id="mp-status"></p>
          <div class="row mp-actions">
            <button class="btn primary" data-act="start">Indítás</button>
            <button class="btn" data-act="play">Pályára</button>
            <button class="btn ghost" data-act="leave">Kilépés</button>
          </div>
          <div class="lbl mp-lblrow"><span>Állás</span><span id="mp-boardhint"></span></div>
          <div id="mp-board"></div>
        </div>
      </div></div>`;
    q('[data-act=back]').onclick = () => app.showScreen('menu');
    q('[data-act=leave]').onclick = () => leaveRoom();
    q('[data-act=start]').onclick = () => startRace();
    q('[data-act=play]').onclick = () => enterGame();
    q('[data-act=copy]').onclick = copyLink;
    q('#mp-link').onclick = (e) => e.target.select();
    q('#mp-name').onchange = setName;
    for (const b of root.querySelectorAll('.mp-map')) b.onclick = () => hostPickMap(b.dataset.map);
  }

  function copyLink() {
    const btn = q('[data-act=copy]'), url = inviteUrl(code);
    const done = () => { btn.textContent = 'Másolva'; setTimeout(() => { btn.textContent = 'Link másolása'; }, 1500); };
    const fallback = () => { const el = q('#mp-link'); el.focus(); el.select(); try { document.execCommand('copy'); done(); } catch { /* select only */ } };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, fallback); else fallback();
  }

  // into the game (warm-up); inside the click, so the mouse can be captured
  async function enterGame() {
    if (!room) return;
    app.audio.unlock();
    app.input.lock();
    if (mapId && app.mapId !== mapId) { try { await app.loadMap(mapId); } catch { toast('A pálya betöltése nem sikerült.'); return; } }
    app.setMode('room'); setAllow();
    app.play();
  }

  function renderRoom() {
    if (!room) { if (!formBuilt) buildForm(); return; }
    if (joinedFor !== code || formBuilt) buildJoined();
    const host = isHost(), hid = room.hostId;
    const sub = q('#mp-sub');
    sub.textContent = synced ? `Szoba ${code} · ${roster.length}/${MAX_PLAYERS} játékos` : 'Csatlakozás a szobához…';
    q('#mp-count').textContent = `${roster.length}/${MAX_PLAYERS}`;
    const rows = roster.map((p) => {
      const bad = p.mh && mapHash && p.mh !== mapHash;
      return `<div class="mp-pl" style="--c:${css(colorOf(p.slot))}"><i></i><span class="n">${esc(p.name)}</span>`
        + `${p.id === hid ? '<em class="host">házigazda</em>' : ''}${p.id === selfId ? '<em class="you">te</em>' : ''}${bad ? '<em class="warn" title="Másik játékverzió: a pálya eltér">eltérő pálya</em>' : ''}`
        + `<span class="pt num">${totals[p.id] | 0} pont</span></div>`;
    }).join('');
    const pl = q('#mp-players');
    if (pl._html !== rows) { pl._html = rows; pl.innerHTML = rows || '<p class="sub">…</p>'; }
    const warn = q('#mp-warn');
    warn.hidden = !mismatch();
    if (mismatch()) warn.textContent = 'A pálya nálad más, mint a házigazdánál (másik játékverzió). Frissítsd az oldalt (Ctrl+F5), különben nem ugyanazt a pályát futjátok.';
    const canPick = host && phase === 'lobby';
    for (const b of root.querySelectorAll('.mp-map')) {
      b.classList.toggle('on', b.dataset.map === mapId);
      b.disabled = !canPick || noGoal(app.maps.get(b.dataset.map));   // (a map without a finish: listed, not pickable)
    }
    q('#mp-maphint').textContent = host ? (canPick ? 'te választasz' : '') : 'a házigazda választ';
    const lobby = phase === 'lobby';
    const waiting = hostPhase !== 'lobby' && lobby;
    q('#mp-status').textContent = !synced ? 'Csatlakozás a szobához…'
      : phase === 'count' ? 'Indul a futam…'
        : phase === 'race' ? 'Futam folyik. Tab: élő állás.'
          : phase === 'results' ? 'Futam vége, eredmények…'
            : waiting ? 'Futam folyik, a következőre vársz. Közben bemelegíthetsz.'
              : host ? 'Bemelegítés: szabadon futhattok a pályán. Ha mindenki kész, indítsd a futamot.' : 'Bemelegítés: szabadon futhatsz a pályán, a házigazda indítja a futamot.';
    const start = q('[data-act=start]');
    start.hidden = !host; start.disabled = !(host && lobby && !waiting && mapId);
    q('#mp-boardhint').textContent = lastResults ? `${lastResults.no}. futam` : 'összpontszám';
    const bh = (roster.length ? boardHtml() : '');
    const bd = q('#mp-board');
    if (bd._html !== bh) { bd._html = bh; bd.innerHTML = bh; }
  }

  function renderRoomScreen() {
    if (app.ui && app.ui.current !== 'room') return;
    if (!room) { if (!formBuilt || !q('.mp-form')) buildForm(); } else renderRoom();
  }

  function renderAll() {
    renderRoomScreen();
    renderBadge();
    renderBoard();
    renderLockBar();
  }

  // ---------------------------------------------------------------- wiring
  hudEl.innerHTML = '<div class="mp-badge" hidden></div><div class="mp-board" hidden></div><div class="mp-lock" hidden>Kattints a játékba az egér befogásához</div>';

  app.on('screen', ({ id }) => {
    if (id === 'room') { formBuilt = false; if (!room) joinedFor = ''; renderAll(); }
    if (id === 'pause' && room && app.mode === 'room' && phase === 'lobby') {
      const p = document.querySelector('#scr-pause .center-panel'), resume = p && p.querySelector('[data-act=resume]');
      if (resume && !p.querySelector('[data-act=room]')) {
        const b = document.createElement('button');
        b.className = 'btn'; b.dataset.act = 'room'; b.textContent = 'Szobamenü';
        b.onclick = () => app.showScreen('room');
        resume.after(b);
      }
    }
  });
  app.on('tick', () => { if (room) { updateFigures(performance.now()); renderLockBar(); } });
  app.on('state', () => renderLockBar());
  app.on('tab', ({ down }) => { tabDown = !!down; renderBoard(); });
  app.on('exit', () => leaveRoom());
  window.addEventListener('beforeunload', () => { if (room) room.leave(); });
  window.addEventListener('hashchange', () => {
    const c = cleanCode(location.hash.replace('#', ''));
    if (!isCode(c) || (room && room.code === c)) return;
    if (room) leaveRoom();
    app.showScreen('room');
    enterRoom(c, false);
  });

  // debug / test access: __pj.app.race.room (fake peers: room.join(id); room.handlers.hello({ name, mh }, id) ...)
  app.race = {
    get room() { return room; }, get phase() { return phase; }, get roster() { return roster; }, get totals() { return totals; }, get race() { return race; },
    get synced() { return synced; }, enter: enterRoom, leave: leaveRoom, start: startRace,
  };

  // an invite link opens the room straight away
  const c0 = cleanCode(location.hash.replace('#', ''));
  if (isCode(c0)) { app.showScreen('room'); enterRoom(c0, false); }
}
