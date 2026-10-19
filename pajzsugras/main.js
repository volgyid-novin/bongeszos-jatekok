// PAJZSUGRÁS: boot, the fixed-step loop, the solo run flow and the `app` object other modules (race.js, leaderboard.js) use.
//
// ======================================== THE `app` CONTRACT (for race.js / leaderboard.js) ========================================
//   initRace(app) and initLeaderboard(app) are called once after the first map is loaded and the main menu is up.
//
//   app.maps            the map registry { list: [{ meta, build() }] in ladder order, ids, get(id), has(id) }; app.DIFF_LABEL
//   app.settings        live settings object { name, sens, fov, doubleTap, keys, ghost, quality, view, volume, lastMap };
//                       change with app.setSetting(key, value) (applies + saves). settings.name is the player name (max 16);
//                       settings.view 'belso' | 'kulso' is the camera (first / third person; the V key toggles it while playing)
//   app.store           store.js (get / set / getRaw / setRaw / getPB / setPB ...), keys live under `pajzsugras:`
//   app.local           { name, color, id }  the local player (color = hex number, id = 'local')
//   app.world           the current sim World (null before the first map); app.mapId, app.mapHash
//   app.mode            'solo' | 'room'. app.setMode('room') turns the solo run flow off: no results screen, no personal best,
//                       no leaderboard submit, the PB ghost is hidden. The 'finish' event still fires. Back to 'solo' on leaving.
//   app.pauseFreezes    true (default): the pause menu stops the sim. A room sets it to false (a race keeps running)
//   app.allow           { restart: true, respawn: true }  set to false to ignore the Enter / R keys (races)
//   app.state           'loading' | 'menu' | 'playing' | 'paused' | 'results' | 'editor'
//
//   app.openEditor(doc?) -> Promise<bool>  enter the map editor (state 'editor'; F2 does it too): doc = an editor document (editor/model.js) or the
//                                          id of a saved one, omitted = the map of this session / the last edited one / a new one. Solo only: a room
//                                          refuses. app.exitEditor() = back to the menu (the map is saved). F2 from the menu shows the map list
//                                          (screen 'edhome'); the saved maps are in store.js (ed:index, ed:map:<id>, ed:last, ed:pb:<id>).
//   app.startCustom(id) -> Promise<bool>   play a saved editor map solo with the full rules (state 'playing'). Its personal best is a local one under
//                                          ed:pb:<id>: no medals, no leaderboard submit, no "next map". false: it cannot be played (no finish ...).
//   app.editor                             the Editor (editor/editor.js). editor.testing = a test run from the editor is on (state 'playing' on a
//                                          custom map: no personal best, no results screen, no leaderboard; Esc / F2 / losing the mouse capture go
//                                          back to the editor instead of the pause menu). world.map.meta.custom marks the editor's maps.
//
//   app.loadMap(id) -> Promise<World>   builds the sim world + the visuals, shows the loading screen meanwhile (then restores
//                                       the screen that was up). Resolves at once when `id` is already loaded.
//   app.mapHashOf(id) -> string         the map hash (builds the map data, no rendering)
//   app.restartRun({ frozen, autoStart })  back to the start, clock 'ready' (autoStart:false = it starts only with app.startRun())
//   app.startRun()                      starts the clock now (race GO)
//   app.setFrozen(bool)                 frozen: the player cannot move but can look around (countdown)
//   app.play()                          enter 'playing': hides the screens, captures the mouse, shows the HUD. When the capture is
//                                       refused (no click) solo opens the pause menu, a room keeps playing (race.js: "click" bar)
//   app.pause() / app.resume() / app.exitToMenu()   (exitToMenu emits 'exit' so a room can be left)
//   app.showScreen(id | null)           'menu' 'play' 'room' 'lb' 'settings' 'controls' 'pause'; null hides all screens
//
//   app.on(type, cb) -> off()           events (cb gets one payload object):
//     'cp'      { index, count, ticks, time (s), label, splits[] }        a checkpoint was reached (all modes)
//     'finish'  { mapId, mapHash, ticks, time (s), splits[] (ticks), ghost (base64 | null, solo only), name, mode }   the local
//               player finished (all modes; in 'room' mode this is the race finish)
//     'respawn' { cause, kind }   'restart' {}   'start' {} (the clock started)   'map' { id }   'exit' {}
//     'tick'    { world, dt }     once per rendered frame after the sim was stepped (send network state from here)
//     'tab'     { down }          the Tab key (scoreboard)
//     'screen'  { id }            a screen is being shown (fill #scr-room / #scr-lb on 'room' / 'lb')
//     'state'   { state }
//     'setting' { key, value }  a setting was changed with app.setSetting (not for live typing)
//   app.emit(type, payload)
//
//   app.figures.upsert(id, { name, color, pos [x,y,z] feet, yaw, pitch (radians), flags (sim FLAG bits), ghost, trail, label })
//   app.figures.remove(id) / clear()        Gorge (local model, see render/gorge.js) or robot figures with a name tag and a trail; ghost: true = translucent;
//                                           solid: true = (with ghost) an opaque Gorge; infer: true = flags are not real (recorded ghosts); app.figures.info() = what each plays
//   app.hud.center(msg, { ms, kind })       big message in the middle (kind: info | good | bad | gold | big)
//   app.hud.standings([{ id, name, color, cp, cpCount, time, finished, me }])   live standings list (null / [] hides it)
//   app.hud.split(label, ticks, deltaTicks) app.hud.fade(ms)
//   app.audio, app.gfx, app.input, app.ui   the subsystems
//   DOM: #scr-room and #scr-lb (screens, use the .panel / .btn / .h1 / .sub classes), #race-hud (empty overlay over the game)
//
// Debug hook: window.__pj (see the bottom of this file).
// =====================================================================================================================================
import MAPS, { DIFF_LABEL } from './maps/index.js';
import { createWorld, medalFor } from './sim/world.js';
import { makeCmd } from './sim/pmove.js';
import { TICK, DT, DODGE } from './sim/const.js';
import { RouteRunner } from './sim/bot.js';
import { encodeGhost, decodeGhost, ghostAt, toB64, fromB64 } from './sim/ghost.js';
import { fwdOf, rightOf } from './sim/math.js';
import { Gfx } from './render/renderer.js';
import { Input } from './input.js';
import { GameAudio } from './audio.js';
import { localUTAvailable } from './local-ut.js';
import { Hud, fmtTime } from './hud.js';
import { UI } from './ui.js';
import { store, cleanName, VIEW_LABEL } from './store.js';
import { initRace } from './race.js';
import { initLeaderboard, submitPB } from './leaderboard.js';
import { Editor } from './editor/editor.js';
import * as lib from './editor/library.js';
import { loadLocalMaps } from './editor/local-maps.js';

const $ = (id) => document.getElementById(id);
const DEG = Math.PI / 180;
const MAX_STEPS = 24;            // sim ticks per frame at most (0.2 s); a longer backlog is dropped
const RESULTS_DELAY = 1.6;       // s between the finish and the results screen
const PB_GHOST_COLOR = 0x2d9cff;

// ---------------------------------------------------------------- state
const dbg = { manual: false, cmd: {}, noSave: false, errors: [], log: [] };
let gfx = null, audio = null, input = null, hud = null, ui = null, settings = null, editor = null;
let world = null, mapId = null, mapHash = null;
let state = 'loading', mode = 'solo';
let acc = 0, appTime = 0, menuT = 0, resultsTimer = 0, lastResults = null, runPending = null;
let pb = null, pbGhost = null;
let lastCmd = makeCmd();
let fps = 60, fpsN = 0, fpsT = 0, loadBusy = null;
const hashCache = new Map();
const listeners = new Map();

const app = {
  maps: MAPS, DIFF_LABEL, store, settings: null, local: { name: 'Játékos', color: 0xff8a2a, id: 'local' },
  pauseFreezes: true, allow: { restart: true, respawn: true },
  get world() { return world; }, get mapId() { return mapId; }, get mapHash() { return mapHash; },
  get mode() { return mode; }, get state() { return state; },
  get gfx() { return gfx; }, get audio() { return audio; }, get input() { return input; }, get ui() { return ui; }, get hud() { return hud; },
  get figures() { return gfx.figures; }, get editor() { return editor; },
};

app.on = (type, cb) => {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(cb);
  return () => listeners.get(type).delete(cb);
};
app.emit = (type, payload = {}) => {
  const set = listeners.get(type);
  if (!set) return;
  for (const cb of [...set]) { try { cb(payload); } catch (e) { console.error('[pajzsugras] listener error', type, e); } }
};

function setState(s) { if (state !== s) { state = s; app.emit('state', { state: s }); } }

// ---------------------------------------------------------------- map loading
app.mapHashOf = (id) => {
  if (hashCache.has(id)) return hashCache.get(id);
  const e = MAPS.get(id);
  if (!e) return null;
  let h = null;
  try { h = e.build().mapHash; } catch (err) { console.error('[pajzsugras] map build failed', id, err); }
  hashCache.set(id, h);
  return h;
};

app.loadMap = (id) => {
  if (!MAPS.has(id)) return Promise.reject(new Error('Ismeretlen pálya: ' + id));
  if (loadBusy) return loadBusy.then(() => app.loadMap(id));
  if (id === mapId && world) return Promise.resolve(world);
  return loadWorld(id, () => createWorld(MAPS.get(id)));
};

// builds the sim world (makeWorld) and the visuals for it; also used by the debug hook for maps that are not in the registry
function loadWorld(id, makeWorld) {
  const prevScreen = ui.current;
  ui.show('loading');
  ui.loading(0, 'Pálya építése…');
  loadBusy = (async () => {
    await new Promise((r) => setTimeout(r, 30));   // let the loading screen paint
    const w = makeWorld();
    ui.loading(0.04, 'Pálya építése…');
    await gfx.loadMap(w.map, (p, text) => ui.loading(p, text ? text + '…' : undefined));
    world = w; mapId = id; mapHash = w.map.mapHash; hashCache.set(id, mapHash);
    acc = 0; resultsTimer = 0; runPending = null;
    loadPB();
    hud.setRun(runInfo());
    input.setLook(world.ps.yaw, world.ps.pitch);
    input.clearLatches();
    afterRestartVisuals();
    app.emit('map', { id });
    if (state === 'loading') setState('menu');
    ui.show(prevScreen === 'loading' ? 'menu' : prevScreen);
    return world;
  })().finally(() => { loadBusy = null; });
  return loadBusy;
}

// what the HUD needs for the current map; a map without a proof route (an editor map, an export of it) has no medals (world.medals is null)
const runInfo = () => ({ medals: world.medals, pb, cpCount: world.cpCount });

// the personal best of the current map: an editor map keeps its own (ed:pb:<id>), never a key of the built-in maps (editor/library.js)
function loadPB() {
  pb = lib.readPB(store, mapId, mapHash, !!(world && world.map.meta.custom));
  pbGhost = null;
  if (pb && pb.ghost) { pbGhost = decodeGhost(fromB64(pb.ghost)); if (!pbGhost) console.warn('[pajzsugras] bad PB ghost'); }
  gfx.figures.remove('__pb');
}

// ---------------------------------------------------------------- run control
function afterRestartVisuals() {
  const ps = world.ps;
  input.setLook(ps.yaw, ps.pitch);
  gfx.fx.respawn();
  gfx.viewmodel.onRespawn();
  hud.reset();
  audio.setCharge(false);
  gfx.figures.remove('__pb');
}

app.restartRun = (opts = {}) => {
  if (!world) return;
  world.restart({ frozen: !!opts.frozen, autoStart: opts.autoStart !== false });
  world.takeEvents();   // the 'restart' event of this call is handled right here
  resultsTimer = 0; runPending = null;
  acc = 0;
  onRestart();
};
app.startRun = () => { if (world) world.startClock(); };
app.setFrozen = (b) => { if (world) world.setFrozen(b); };
app.setMode = (m) => {
  mode = m === 'room' ? 'room' : 'solo';
  if (mode === 'room') { gfx.figures.remove('__pb'); app.pauseFreezes = false; app.allow = { restart: false, respawn: true }; }
  else { app.pauseFreezes = true; app.allow = { restart: true, respawn: true }; }
};

function onRestart() {
  if (editor && editor.testing) editor.applyTestStart();   // a camera test restarts at the camera spot
  afterRestartVisuals();
  if (editor && editor.testing && editor.testPitch !== null) input.setLook(world.ps.yaw, editor.testPitch);
  hud.setRun(runInfo());
  app.emit('restart', {});
}

function onRespawn(e) {
  const ps = world.ps;
  input.setLook(ps.yaw, ps.pitch);
  gfx.fx.respawn(); gfx.viewmodel.onRespawn();
  audio.setCharge(false); audio.respawn();
  if (e.cause !== 'manual') hud.fade(420, 0.8);
  else hud.fade(220, 0.5);
  if (e.cause === 'kill') hud.center(e.kind === 'lava' ? 'LÁVA!' : e.kind === 'laser' ? 'LÉZER!' : 'LEESTÉL', { kind: 'bad', ms: 900 });
  app.emit('respawn', { cause: e.cause, kind: e.kind });
}

function onCheckpoint(e) {
  const prev = pb && mode === 'solo' && pb.splits[e.index] != null ? e.time - pb.splits[e.index] : null;
  hud.split(e.label, e.time, prev);
  hud.center(`${e.index + 1}/${e.count}`, { kind: 'gold', ms: 900 });
  audio.checkpoint();
  app.emit('cp', { index: e.index, count: e.count, ticks: e.time, time: e.time / TICK, label: e.label, splits: world.splits.slice() });
}

function onFinish(e) {
  audio.finish();
  const run = { mapId, mapHash, ticks: e.time, time: e.time / TICK, splits: e.splits, ghost: null, name: settings.name, mode };
  const custom = !!world.map.meta.custom;
  if (editor && editor.testing) {   // a test run from the editor: no personal best, no results screen, no leaderboard
    hud.center('CÉLBAN! ' + fmtTime(run.time), { kind: 'gold', ms: 2600 });
  } else if (mode === 'solo') {
    const prev = pb;
    const isPB = !prev || run.ticks < prev.ticks;
    const medal = world.medals ? medalFor(run.time, world.medals) : null;
    if (!dbg.noSave) {
      try { run.ghost = toB64(encodeGhost(world.ghostData())); } catch (err) { console.warn('[pajzsugras] ghost encode failed', err); }
      if (isPB) {
        const rec = lib.recordPB(store, mapId, mapHash, run, custom);   // an editor map: a local personal best only, never published
        if (custom && !rec.saved) ui.toast('A rekordot nem sikerült elmenteni (megtelt a tárhely).');
        loadPB();
        hud.setRun(runInfo());
        if (rec.publish) {
          Promise.resolve().then(() => submitPB(mapId, run))
            .then((ok) => ui.setResultNote(ok === true ? 'Az új rekord elküldve a ranglistára.' : ok === false ? 'A ranglista most nem érhető el, a rekord helyben mentve.' : ''))
            .catch(() => ui.setResultNote('A ranglista most nem érhető el, a rekord helyben mentve.'));
        }
      }
    }
    runPending = { run, prev, isPB, medal };
    resultsTimer = RESULTS_DELAY;
    hud.center(isPB ? 'ÚJ REKORD!' : 'CÉLBAN!', { kind: 'gold', ms: 2600 });
  }
  app.emit('finish', run);
}

function showResults() {
  if (!runPending || !world) return;
  const { run, prev, isPB, medal } = runPending;
  const entries = MAPS.list, i = entries.findIndex((m) => m.meta.id === mapId), custom = !!world.map.meta.custom;
  lastResults = {
    mapId, name: settings.name, mapName: world.map.meta.name, ticks: run.ticks, splits: run.splits, labels: world.map.checkpoints.map((c) => c.label),
    prev, isPB, medal, medals: world.medals, hasNext: i >= 0 && i < entries.length - 1, custom,   // (no medals without a proof route; an editor map: no next map)
  };
  setState('results');
  input.enabled = false; input.unlock(); audio.setCharge(false);
  document.body.classList.remove('playing');
  hud.show(false);
  ui.showResults(lastResults);
}

// ---------------------------------------------------------------- state transitions
app.play = () => {
  if (!world) return;
  setState('playing');
  ui.show(null);
  hud.show(true);
  input.clearLatches();
  input.enabled = true;
  document.body.classList.add('playing');
  audio.unlock();
  // (a room keeps playing: a race can start without a click, and a pause menu would cover the countdown and the results;
  //  race.js shows a "click to capture" bar instead, and a click on the game captures the mouse)
  if (!input.locked && !input.soft) { input.lock().then((ok) => { if (!ok && state === 'playing' && mode !== 'room') pauseGame('Kattints a FOLYTATÁS gombra az egér befogásához.'); }); }
};

// losing the mouse capture, Esc or a hidden tab: the pause menu, except in a test run from the editor, which goes back to the editor
function pauseOrBack() {
  if (editor && editor.testing) editor.backFromTest();
  else pauseGame();
}

function pauseGame(hint) {
  if (state !== 'playing') return;
  setState('paused');
  input.enabled = false; input.releaseAll(); input.unlock();
  audio.setCharge(false);
  document.body.classList.remove('playing');
  ui.showPause({ mapName: world.map.meta.name, time: world.clockState === 'ready' ? null : world.runTime(), hint, canRestart: mode === 'solo' });
}
app.pause = pauseGame;

app.resume = async () => {
  if (state !== 'paused') return;
  const ok = await input.lock();
  if (state !== 'paused') return;
  if (ok) app.play();
  else ui.toast('Kattints még egyszer a folytatáshoz.');
};

app.exitToMenu = () => {
  input.enabled = false; input.unlock(); input.releaseAll();
  audio.setCharge(false);
  document.body.classList.remove('playing');
  hud.show(false);
  runPending = null; resultsTimer = 0;
  setState('menu');
  app.emit('exit', {});
  if (mode !== 'solo') app.setMode('solo');
  ui.show('menu');
};

// ---------------------------------------------------------------- the map editor (editor/editor.js)
function stopPlaying() {
  input.enabled = false; input.unlock(); input.releaseAll();
  audio.setCharge(false);
  document.body.classList.remove('playing');
  hud.show(false);
  runPending = null; resultsTimer = 0;
}

app.openEditor = async (doc = null) => {
  if (mode === 'room') { ui.toast('Szobában nem nyitható meg a szerkesztő.'); return false; }
  if (!editor || loadBusy || state === 'loading' || state === 'editor') return false;
  stopPlaying();
  setState('editor');
  ui.show('loading');
  ui.loading(0, 'Szerkesztő betöltése…');
  try {
    const entered = await editor.enter(doc, (p, text) => ui.loading(p, text ? text + '…' : undefined));
    if (!entered || state !== 'editor') return false;   // left while loading (e.g. a room invite): leave the screen that is up now
  } catch (e) {
    console.error('[pajzsugras] editor failed', e);
    editor.leave();
    setState('menu');
    ui.show('menu');
    ui.toast('A szerkesztő nem indult el.');
    return false;
  }
  ui.show(null);
  return true;
};

app.exitEditor = () => {
  if (state !== 'editor') return;
  editor.leave();
  setState('menu');
  ui.show('menu');
};

// what the editor needs from the app: the sim world and the visuals (a quick level rebuild), and the test run
const editorHost = {
  // w becomes the app's world (mapId 'sajat-...', no PB); the first call (warm) also makes every material
  async useWorld(w, { warm = false, onProgress } = {}) {
    const prev = world;
    world = w; mapId = w.map.meta.id; mapHash = w.map.mapHash;
    try { await gfx.rebuildLevel(w.map, { warm, onProgress }); } catch (e) { world = prev; mapId = prev ? prev.map.meta.id : null; mapHash = prev ? prev.map.mapHash : null; throw e; }
    pb = null; pbGhost = null;
    gfx.figures.remove('__pb');
    acc = 0; resultsTimer = 0; runPending = null;
    hud.setRun(runInfo());
  },
  beginTest({ pose }) {
    world.restart({ silent: true });
    world.takeEvents();
    editor.applyTestStart();
    resultsTimer = 0; runPending = null; acc = 0;
    hud.setRun(runInfo());
    afterRestartVisuals();
    if (pose) input.setLook(world.ps.yaw, pose.pitch);
    input.releaseAll(); input.clearLatches();
    setState('playing');
    ui.show(null);
    hud.show(true);
    input.enabled = true;
    document.body.classList.add('playing');
    audio.unlock();
    if (!input.locked && !input.soft) input.lock();   // (inside the key press that started the test; refused: a click captures the mouse)
  },
  endTest() {
    setState('editor');
    input.enabled = false; input.releaseAll(); input.unlock();
    audio.setCharge(false);
    document.body.classList.remove('playing');
    hud.show(false);
    resultsTimer = 0; runPending = null; acc = 0;
    world.restart({ silent: true });   // (the checkpoints show as untaken again)
    world.takeEvents();
  },
};

app.showScreen = (id) => {
  if (id === null || id === undefined) { ui.show(null); return; }
  if (editor && (state === 'editor' || editor.testing)) {   // (an invite link or any other screen while the editor or a test from it runs: out of the editor first)
    if (editor.testing) editor.backFromTest();
    editor.leave();
    setState('menu');
  }
  if (id === 'pause') { if (state === 'playing') pauseGame(); else ui.showPause({ mapName: world ? world.map.meta.name : '', canRestart: mode === 'solo' }); return; }
  if (id === 'settings' && state === 'paused') { ui.show('settings'); return; }
  if (state === 'playing' || state === 'paused' || state === 'results') {
    if (id === 'menu' || id === 'play' || id === 'room' || id === 'lb' || id === 'controls' || id === 'edhome') {
      input.enabled = false; input.unlock(); input.releaseAll(); audio.setCharge(false);
      document.body.classList.remove('playing'); hud.show(false);
      setState('menu');
    }
  }
  ui.show(id);
};

// solo: pick a map and run it
app.startSolo = async (id) => {
  if (!MAPS.has(id)) return;
  app.setMode('solo');
  input.lock();   // inside the click that started this, before the (slow) map load
  try {
    await app.loadMap(id);
  } catch (e) {
    console.error('[pajzsugras] load failed', e);
    ui.toast('A pálya betöltése nem sikerült.');
    ui.show('play');
    return;
  }
  settings.lastMap = id; store.saveSettings(settings);
  app.restartRun();
  app.play();
  if (!world.map.finish) ui.toast('Ennek a pályának még nincs célja: szabadon ugrálhatsz rajta.');   // (an export of the editor that has no finish yet)
};

// solo: play a saved map of the editor (JÁTÉK > Saját pályák): the full rules, a local personal best, nothing else
async function loadCustomMap(run) {
  if (loadBusy) await loadBusy;
  try {
    await loadWorld(run.def.meta.id, () => createWorld(run.def));
  } catch (e) {
    console.error('[pajzsugras] load failed', e);
    ui.toast('A pálya betöltése nem sikerült.');
    ui.show('play');
    return false;
  }
  return true;
}
app.startCustom = async (id) => {
  const run = lib.prepareRun(store, id);
  if (run.error) { ui.toast(run.error); return false; }
  app.setMode('solo');
  input.lock();   // inside the click that started this, before the (slow) map load
  if (!(await loadCustomMap(run))) return false;
  app.restartRun();
  app.play();
  return true;
};

// restart the run (pause menu, results screen, Enter on results)
app.retry = () => {
  if (!world) return;
  app.restartRun();
  if (state === 'playing') return;
  setState('paused');   // (this runs inside a click, so the mouse can be captured again)
  app.resume().then(() => {
    if (state === 'paused') ui.showPause({ mapName: world.map.meta.name, canRestart: mode === 'solo', hint: 'Kattints a FOLYTATÁS gombra a kezdéshez.' });
  });
};

app.nextMap = () => {
  const list = MAPS.list, i = list.findIndex((m) => m.meta.id === mapId);
  if (i >= 0 && i < list.length - 1) app.startSolo(list[i + 1].meta.id);
  else ui.toast('Ez volt az utolsó pálya.');
};

// ---------------------------------------------------------------- settings
app.setSetting = (key, value, live = false) => {
  if (!(key in settings)) return;
  settings[key] = key === 'name' && !live ? cleanName(value) : value;
  store.saveSettings({ ...settings, name: cleanName(settings.name) });
  switch (key) {
    case 'volume': audio.setVolume(value); break;
    case 'fov': gfx.setFov(value); break;
    case 'keys': hud.setKeys(!!value); break;
    case 'name': app.local.name = cleanName(settings.name); break;
    case 'ghost': if (!value) gfx.figures.remove('__pb'); break;
    case 'quality': ui.toast('Grafika frissítése…'); gfx.setQuality(value).then(() => ui.toast('Kész.', 900)).catch((e) => console.error(e)); break;
    default: break;
  }
  if (!live) app.emit('setting', { key, value: settings[key] });
};

// V while playing: first person <-> third person (behind the player, like UT2004's behindview); a setting, so it is remembered
function toggleView() {
  if (state !== 'playing') return;
  app.setSetting('view', settings.view === 'kulso' ? 'belso' : 'kulso');
  ui.toast('Nézet: ' + VIEW_LABEL[settings.view].toLowerCase(), 900);
}

// ---------------------------------------------------------------- the sim step
function dodgeEnum(dir) {
  const ps = world.ps, f = fwdOf(ps.yaw), r = rightOf(ps.yaw);
  const df = dir[0] * f[0] + dir[2] * f[2], dr = dir[0] * r[0] + dir[2] * r[2];
  if (Math.abs(dr) > Math.abs(df)) return dr > 0 ? DODGE.R : DODGE.L;
  return df >= 0 ? DODGE.F : DODGE.B;
}

// one tick: cmd from the keyboard (live) or from the debug override (manual), then world.step
function stepOnce(neutral) {
  const cmd = makeCmd();
  if (dbg.manual) {
    const o = dbg.cmd;
    cmd.yaw = input.yaw; cmd.pitch = input.pitch;
    for (const k of Object.keys(o)) cmd[k] = o[k];
    if (o.dodge) o.dodge = 0;
    if (o.respawn) o.respawn = false;
    if (o.restart) o.restart = false;
  } else if (neutral) { cmd.yaw = input.yaw; cmd.pitch = input.pitch; }
  else input.fillCmd(cmd);
  if (!app.allow.restart) cmd.restart = false;
  if (!app.allow.respawn) cmd.respawn = false;
  lastCmd = cmd;
  world.step(cmd);
}

function handleEvents(events, quiet) {
  const ps = world.ps;
  for (const e of events) {
    switch (e.type) {
      case 'jump': if (!quiet) { audio.jump(e.combo); gfx.viewmodel.onJump(); } break;
      case 'dj': if (!quiet) { audio.doubleJump(); gfx.fx.pop([ps.pos[0], ps.pos[1] + 0.05, ps.pos[2]], 0x7fd8ff, 2, 0.45); gfx.viewmodel.onJump(); } break;
      case 'dodge': if (!quiet) { const d = dodgeEnum(e.dir); audio.dodge(); gfx.fx.dodge(d); gfx.viewmodel.onDodge(d); } break;
      case 'walldodge': if (!quiet) { const d = dodgeEnum(e.dir); audio.wallDodge(); gfx.fx.dodge(d); gfx.viewmodel.onDodge(d); } break;
      case 'land': if (!quiet) { audio.land(e.speed); gfx.fx.land(e.speed, e.pos); gfx.viewmodel.onLand(e.speed); } break;
      case 'blast': if (!quiet) { audio.blast(e.charge, e.hit); gfx.fx.blast(e); gfx.viewmodel.onBlast(e.charge); } break;
      case 'pad': if (!quiet) { audio.pad(); if (gfx.level) gfx.level.flashPad(e.index); } break;
      case 'cp': onCheckpoint(e); break;
      case 'finish': onFinish(e); break;
      case 'respawn': if (!quiet) onRespawn(e); else { input.setLook(ps.yaw, ps.pitch); app.emit('respawn', { cause: e.cause, kind: e.kind }); } break;
      case 'restart': onRestart(); break;
      case 'clockStart': app.emit('start', {}); break;
      default: break;
    }
  }
}
const processEvents = (quiet) => handleEvents(world.takeEvents(), quiet);

// ---------------------------------------------------------------- frame
function frameBody(dt, { step = true, alpha } = {}) {
  appTime += dt;
  const editing = state === 'editor' && editor && editor.ready;   // the sim is not stepped there: the editor draws the same world from its own camera
  if (editing) editor.update(dt);
  const live = state === 'playing' || (state === 'paused' && !app.pauseFreezes);
  let a = alpha ?? 1;
  if (world && step && !dbg.manual) {
    if (live) {
      acc += dt;
      let n = 0;
      const neutral = state !== 'playing';
      while (acc >= DT && n < MAX_STEPS) { stepOnce(neutral); acc -= DT; n++; }
      if (n >= MAX_STEPS) acc = 0;
      a = acc / DT;
    } else acc = 0;
  }
  if (world && live) processEvents(false);
  if (alpha === undefined && (!live || dbg.manual)) a = 1;

  const ps = world ? world.ps : null;
  const playing = state === 'playing' || state === 'paused' || state === 'results';
  if (world) {
    if (resultsTimer > 0 && state === 'playing') { resultsTimer -= dt; if (resultsTimer <= 0) showResults(); }
    // the personal-best ghost
    const showGhost = playing && mode === 'solo' && settings.ghost && pbGhost && world.clockState !== 'ready';
    if (showGhost) {
      const g = ghostAt(pbGhost, world.clock + (world.clockState === 'running' ? a : 0));
      gfx.figures.upsert('__pb', { name: 'PB', color: PB_GHOST_COLOR, pos: [g[0], g[1], g[2]], yaw: g[3], pitch: g[4], flags: 1, ghost: true, infer: true, trail: false });
    } else if (gfx.figures.has('__pb')) gfx.figures.remove('__pb');
  }

  const look = world && ps ? { yaw: input.yaw, pitch: input.pitch } : { yaw: 0, pitch: 0 };
  const vmState = ps ? { charge: ps.charge, charging: ps.charging && state === 'playing', speed: ps.speed, grounded: ps.grounded, vy: ps.vel[1], look: input.takeLookDelta(), hidden: state === 'results' } : {};
  menuT += dt;
  gfx.frame({ dt, t: appTime, world, alpha: a, look, mode: editing ? 'editor' : playing ? 'play' : 'menu', cam: editing ? editor.camState() : undefined, menuT, speed: ps ? ps.speed : 0, vm: vmState, view: settings.view, me: app.local });

  if (world && ps) {
    const running = world.clockState === 'running';
    const timeS = world.clockState === 'ready' ? 0 : world.clockState === 'finished' ? world.finishTicks / TICK : (world.clock + (running ? a : 0)) / TICK;
    if (state === 'playing') hud.hint(editor && editor.testing ? editor.testHint(input.locked) : world.clockState === 'ready' && mode === 'solo' ? 'WASD mozgás · SPACE ugrás · bal gomb pajzs · R ellenőrzőpont · V nézet · ESC szünet' : '');
    if (playing) hud.update({ time: timeS, state: world.clockState, cp: world.cpIndex, speed: ps.speed, charge: ps.charge, charging: ps.charging, keys: input.keyState() });
    hud.tick(dt);
    audio.setCharge(state === 'playing' && ps.charging, ps.charge);
    audio.update(dt, { grounded: ps.grounded, speed: ps.speed, paused: state !== 'playing' && !(state === 'paused' && !app.pauseFreezes) });
    if (live) app.emit('tick', { world, dt });
  }
  // fps
  fpsN++; fpsT += dt;
  if (fpsT >= 0.5) { fps = fpsN / fpsT; fpsN = 0; fpsT = 0; }
}

let lastNow = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.max(0, Math.min(0.1, (now - lastNow) / 1000));
  lastNow = now;
  if (!gfx) return;
  try { frameBody(dt); } catch (e) { reportError(e); }
}

function reportError(e) {
  console.error('[pajzsugras]', e);
  dbg.errors.push(String(e && e.stack ? e.stack : e).slice(0, 600));
  if (dbg.errors.length > 40) dbg.errors.shift();
}

// ---------------------------------------------------------------- boot
async function boot() {
  settings = store.loadSettings();
  app.settings = settings;
  app.local.name = settings.name;
  const canvas = $('view');
  try {
    gfx = new Gfx(canvas, settings);
  } catch (e) {
    console.error(e);
    $('load-text').textContent = 'A böngésző nem tudja elindítani a WebGL-t, a játék így nem fut.';
    $('load-text').style.color = '#ff6a5a';
    return;
  }
  audio = new GameAudio();
  audio.setVolume(settings.volume);
  // Models are bundled on every host; optional local sounds remain development-only.
  audio.setLocalUT(localUTAvailable());
  gfx.setLocalUT(true);
  input = new Input(canvas, settings, {
    onLockChange: (locked) => {
      if (locked) { if (state === 'paused') app.play(); }
      else if (state === 'playing') pauseOrBack();
    },
    onEscape: () => { if (state === 'playing') pauseOrBack(); },
    onTab: (down) => app.emit('tab', { down }),
    onView: toggleView,
  });
  input.attach();
  hud = new Hud();
  hud.setKeys(settings.keys);
  ui = new UI(app);
  editor = new Editor(app, editorHost);
  ui.loading(0, 'Indítás…');
  const scaleUI = () => document.documentElement.style.setProperty('--ui', Math.max(0.85, Math.min(1.7, window.innerHeight / 900)).toFixed(3));
  scaleUI();
  window.addEventListener('resize', () => { gfx.resize(); scaleUI(); });
  window.addEventListener('error', (e) => reportError(e.error || e.message));
  window.addEventListener('unhandledrejection', (e) => reportError(e.reason));
  document.addEventListener('visibilitychange', () => { if (document.hidden && state === 'playing' && mode === 'solo') pauseOrBack(); });
  const origError = console.error;
  console.error = (...a) => { dbg.log.push(a.map((x) => (x && x.message) || String(x)).join(' ').slice(0, 300)); if (dbg.log.length > 40) dbg.log.shift(); origError.apply(console, a); };

  const first = MAPS.has(settings.lastMap) ? settings.lastMap : MAPS.list.length ? MAPS.list[0].meta.id : null;   // (null: maps/index.js has no map yet)
  if (first) {
    try {
      await app.loadMap(first);
    } catch (e) {
      console.error(e);
      $('load-text').textContent = 'A pálya betöltése nem sikerült: ' + (e && e.message ? e.message : e);
      $('load-text').style.color = '#ff6a5a';
      requestAnimationFrame(frame);
      return;
    }
  }
  setState('menu');
  ui.show('menu');
  if (!first) ui.toast('Még nincs beépített pálya: a Szerkesztőben építhetsz egyet.', 6000);
  MAPS.ids.forEach((id, i) => setTimeout(() => app.mapHashOf(id), 600 + i * 120));   // warm the map cards (the sim build is not free)
  for (const init of [initRace, initLeaderboard]) { try { init(app); } catch (e) { console.error('[pajzsugras] init failed', e); } }
  // a ported UT2004 map in local-maps/ (tools/ut2004_map.py) appears among the Saját pályák by itself; only on a local dev host, and it never holds the menu up
  loadLocalMaps(store).then((docs) => {
    if (!docs.length) return;
    ui.refreshCustomLists(docs[0].id);
    ui.toast('Helyi pálya betöltve: ' + docs.map((d) => d.name).join(', '), 4000);
  }).catch(() => {});
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- debug hook
// The browser test pane is often hidden and requestAnimationFrame does not run there, so everything below works without it.
//   __pj.loadMap(id)          load a map, hide the menus, show the HUD, switch to manual stepping; -> state()
//   __pj.advance(sec)         step the sim (with the cmd of setInput) and render ONE frame; -> state()
//   __pj.setInput(partial)    fields of the sim cmd: fwd, side (-1..1), jump, fire (held), dodge: 1 F, 2 B, 3 L, 4 R (one tick),
//                             respawn, restart (one tick); look: yawDeg / pitchDeg (degrees) or yaw / pitch (radians).
//                             setInput(null) clears everything
//   __pj.teleport([x,y,z], yawDeg)
//   __pj.state()              player, run, renderer and fps numbers, figures (what every other runner plays: model, clip, weight), view ('belso' |
//                             'kulso') and camera { view, pos, yawDeg, pitchDeg, dist, limit, want, hit, hidden, self } (third person: how far behind the
//                             head the camera is, how far the way back is free, a wall holds it in, the own figure '__me' is hidden / drawn)
//                             and viewmodel { ut, state, clip, time, charge, active, hidden } (ut: the owner's UT2004 shield gun (on a local dev build, by itself) replaced our gauntlet; figures[].weapon: it is in their hand)
//   __pj.view(v?)             'belso' | 'kulso' sets the camera (a setting, saved), no argument toggles it; -> state()
//   __pj.runRoute(mapId?, { seconds, save })   run the proof route (the debug bot) for `seconds` of sim time (default: to the
//                             end); the result is { ok, finished, time, cps, ticks, reason }; nothing is saved unless save: true
//   __pj.quality(level)       'alacsony' | 'kozepes' | 'magas'  (awaitable)
//   __pj.screen(id)           'menu' 'play' 'room' 'lb' 'settings' 'controls' 'pause' 'results' (the last finished run) | null
//   __pj.loadCustom(id)       a saved editor map, like loadMap (full rules, local PB under ed:pb:<id>; { error } when it has no finish ...)
//   __pj.shot()               data URL of the canvas after rendering a frame        __pj.live()  back to the real keyboard
//   __pj.editor               the map editor (editor/editor.js, makeDebug): await open(doc?) · doc() · await exec(op, ...) · setCam(pos, yawDeg, pitchDeg) ·
//                             aim(ndcX, ndcY) · await click({ shift }) · await drag(from, to, { shift }) · await boxSelect(a, b, { shift }) · handles() · await key(code, mods) · hold(code, sec) · await test({ from: 'cam' | 'start' })
//                             then __pj.advance / __pj.setInput as for any map · back() · await flush() · rebuildMs · state(). Saving: save() · list() ·
//                             exportText() · importText(text) · remove(id) · open(id). loadMap / loadDef / loadCustom / runRoute / screen leave the editor first.
function leaveEditor() {
  if (editor && (state === 'editor' || editor.testing)) { const was = state === 'editor'; editor.leave(); if (was) setState('menu'); }
}

function stateSnapshot() {
  if (!world) return { loaded: false, state, errors: dbg.errors.length };
  const ps = world.ps, r3 = (v) => Math.round(v * 1000) / 1000;
  return {
    editor: editor && (state === 'editor' || editor.testing) ? editor.snapshot() : undefined,
    map: mapId, mapHash, mode, state, screen: ui.current,
    pos: ps.pos.map(r3), vel: ps.vel.map(r3), speed: r3(ps.speed), yawDeg: r3((input.yaw * 180) / Math.PI), pitchDeg: r3((input.pitch * 180) / Math.PI),
    grounded: ps.grounded, charge: r3(ps.charge), charging: ps.charging, djUsed: ps.djUsed, flags: world.playerFlags(),
    clock: r3(world.clock / TICK), clockState: world.clockState, cp: world.cpIndex, cpCount: world.cpCount, deaths: world.deaths,
    finished: world.finished, finishTime: world.finished ? r3(world.finishTicks / TICK) : null,
    quality: gfx.q, fps: Math.round(fps), render: gfx.info(), errors: dbg.errors.length, manual: dbg.manual, ticks: world.t,
    view: settings.view, camera: gfx.cameraInfo(),
    figures: gfx.figures.info(),   // per figure: model 'gorge' | 'robot', the clip it plays, the animation brain's state (render/figures.js)
    viewmodel: gfx.viewmodel.info(),   // the first person gun: ut = the UT2004 shield gun is in use (local model), the sequence it plays (render/viewmodel.js)
  };
}

function installDebug() {
  const pj = {
    app,
    get editor() { return editor ? editor.debug : null; },
    async loadMap(id) {
      leaveEditor();
      dbg.manual = true; dbg.cmd = {};
      app.setMode('solo');
      await app.loadMap(id);
      app.restartRun();
      setState('playing');
      ui.show(null); hud.show(true);
      input.enabled = false;
      return stateSnapshot();
    },
    // a saved map of the editor, played like loadMap does (manual stepping): -> state(), or { error } when it cannot be played
    async loadCustom(id) {
      leaveEditor();
      const run = lib.prepareRun(store, id);
      if (run.error) return { error: run.error };
      dbg.manual = true; dbg.cmd = {};
      app.setMode('solo');
      if (!(await loadCustomMap(run))) return { error: 'load failed' };
      app.restartRun();
      setState('playing');
      ui.show(null); hud.show(true);
      input.enabled = false;
      return stateSnapshot();
    },
    // a map that is not in the registry: def = defineMap(...) (import /pajzsugras/sim/builder.js in the page)
    async loadDef(def) {
      leaveEditor();
      dbg.manual = true; dbg.cmd = {};
      app.setMode('solo');
      if (loadBusy) await loadBusy;
      await loadWorld(def.meta.id, () => createWorld(def));
      app.restartRun();
      setState('playing');
      ui.show(null); hud.show(true);
      input.enabled = false;
      return stateSnapshot();
    },
    advance(sec = 0.1) {
      if (!world) return stateSnapshot();
      dbg.manual = true;
      const n = Math.max(0, Math.round(sec * TICK));
      for (let i = 0; i < n; i++) stepOnce(false);
      processEvents(false);
      const dtv = Math.min(Math.max(sec, 0.016), 0.1);
      if (resultsTimer > 0 && sec > dtv) resultsTimer = Math.max(1e-6, resultsTimer - (sec - dtv));   // long advances count in full
      frameBody(dtv, { step: false, alpha: 1 });
      return stateSnapshot();
    },
    setInput(p) {
      dbg.manual = true;
      if (p === null || p === undefined) { dbg.cmd = {}; return; }
      const o = { ...p };
      if (o.yawDeg !== undefined) { o.yaw = o.yawDeg * DEG; delete o.yawDeg; }
      if (o.pitchDeg !== undefined) { o.pitch = o.pitchDeg * DEG; delete o.pitchDeg; }
      if (o.yaw !== undefined || o.pitch !== undefined) input.setLook(o.yaw ?? input.yaw, o.pitch ?? input.pitch);
      delete o.yaw; delete o.pitch;
      Object.assign(dbg.cmd, o);
    },
    teleport(pos, yawDeg = 0) {
      if (!world) return;
      world.teleport(pos, yawDeg * DEG);
      input.setLook(yawDeg * DEG, 0);
      world.takeEvents();
      gfx.fx.respawn();
      return stateSnapshot();
    },
    state: stateSnapshot,
    view(v) {
      app.setSetting('view', v === 'belso' || v === 'kulso' ? v : settings.view === 'kulso' ? 'belso' : 'kulso');
      if (world) frameBody(0.016, { step: false, alpha: 1 });   // (so that state().camera is the camera of the new view)
      return stateSnapshot();
    },
    async runRoute(id, opts = {}) {
      leaveEditor();
      dbg.manual = true; dbg.cmd = {}; dbg.noSave = !opts.save;
      app.setMode('solo');
      if (id && id !== mapId) await app.loadMap(id);
      const steps = world.map.route;
      if (!steps || !steps.length) return { ok: false, finished: false, reason: 'no proof route (an export of the editor has none)', mapId, state: stateSnapshot() };
      app.restartRun();
      setState('playing'); ui.show(null); hud.show(true); input.enabled = false;
      const runner = new RouteRunner(world, steps);
      const limit = Math.round((opts.seconds ?? 1e6) * TICK);
      let n = 0;
      while (!runner.done && n < limit) {
        const chunk = Math.min(120, limit - n);
        runner.advance(chunk); n += chunk;
        processEvents(true);
      }
      processEvents(true);
      const ps = world.ps;
      input.setLook(ps.yaw, ps.pitch);
      frameBody(0.016, { step: false, alpha: 1 });
      dbg.noSave = false;
      const res = runner.result();
      return { ok: res.ok, finished: res.finished, time: res.time, ticks: res.ticks, cps: res.cps, deaths: res.deaths, reason: res.reason, mapId, state: stateSnapshot() };
    },
    async quality(q) { await gfx.setQuality(q); settings.quality = q; return stateSnapshot(); },
    screen(id) {
      leaveEditor();
      if (id === 'results') { if (lastResults) { setState('results'); ui.showResults(lastResults); } return stateSnapshot(); }
      if ((id === null || id === undefined) && world) { setState('playing'); hud.show(true); }
      app.showScreen(id);
      return stateSnapshot();
    },
    shot() { frameBody(0.016, { step: false, alpha: 1 }); return gfx.screenshot(); },
    live() { dbg.manual = false; dbg.cmd = {}; },
    get errors() { return dbg.errors.slice(); },
    get log() { return dbg.log.slice(); },
  };
  window.__pj = pj;
}

// ?vitrin (dev machine only): the shield gauntlet on a turntable instead of the game (render/vitrin.js; not in the production build)
if (import.meta.env?.DEV && localUTAvailable() && new URLSearchParams(location.search).has('vitrin')) {
  import('./render/vitrin.js').then((m) => m.openVitrin()).catch((e) => console.error(e));
} else {
  installDebug();
  bootGame();
}
function bootGame() {
  boot().catch((e) => { console.error(e); const t = $('load-text'); if (t) { t.textContent = 'Hiba az indításkor: ' + (e && e.message ? e.message : e); t.style.color = '#ff6a5a'; } });
}
