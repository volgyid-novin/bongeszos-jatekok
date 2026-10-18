// The app with exactly ONE built-in map (maps/uj-palya.js, the editor export: no author time, 7 checkpoints and a finish), and the add-map tool's
// edges. The earlier suites use a two-map fake registry (alpha / beta); here the real registry (maps/index.js) is what the screens and the room get:
// the JÁTÉK list and the results screen (UI), a room (race.js: default map, the 3 s finish floor and the 180 s cut of a map without author time), the
// leaderboard screen (tabs, selection) with stale data from SIM_VER 2 around, the editor's single theme, stale texts of the menu, and tools/add-map.mjs
// (ids that must not break maps/index.js, a name that must not become code, hostile files, an update in the middle of the list, a registry that loads).
// Cases named BUG: assert the wanted behaviour and FAIL until the bug is fixed (the report names the code). main.js itself needs WebGL and cannot be
// imported in node: its map choice at start-up (lastMap, `MAPS.has(settings.lastMap) ? ... : MAPS.list[0]`), nextMap and the "no finish" toast are
// checked here through their parts (store, UI, race.js, leaderboard.js), not through the controller.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test, assert, setGlobal, sleep, onCleanup } from './harness.mjs';
import { guardWebSocket, memStorage, makeRelays, forge, El as FakeEl, installClock, installDom } from './support.mjs';
import * as TM from './trystero-mock.mjs';
import { openEditor } from './editor-tests.mjs';
import { MAPS, DIFF_LABEL } from '../maps/index.js';
import ujPalya from '../maps/uj-palya.js';
import { THEME_IDS } from '../editor/themes.js';
import { SIM_VER, TICK } from '../sim/const.js';
import { routeFloor } from '../sim/world.js';
import { addMap, register } from '../tools/add-map.mjs';

guardWebSocket();   // (ui.js -> leaderboard.js -> nostr.js grabs globalThis.WebSocket when it is imported)
const { UI } = await import('../ui.js');
const { initRace } = await import('../race.js');
const N = await import('../nostr.js');

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ID = 'uj-palya';
const hashOf = (id) => (MAPS.has(id) ? MAPS.get(id).build().mapHash : null);
const HASH = hashOf(ID);
const MAP0 = MAPS.get(ID).build();
const CPS = MAP0.checkpoints.length;                // (7: the finish only counts after all of them)
const FLOOR = Math.ceil(routeFloor(MAP0) * TICK);   // the least ticks a run of this map can take (the board's floor, a map without an author time)

// ================================================================ the screens with one map
test('one map: the JÁTÉK list shows exactly one card (no difficulty chip, no medals, 0/1 done) that starts the map; the results screen has a disabled "next map" button', () => {
  installDom();
  const calls = [];
  const app = { maps: MAPS, mapHashOf: hashOf, store: { getPB: () => null, listCustom: () => [] }, startSolo: (id) => calls.push(['solo', id]), showScreen: (id) => calls.push(['screen', id]), nextMap: () => calls.push(['next']), retry() {} };
  const play = new FakeEl();
  UI.prototype.buildPlay.call({ app, els: { play }, fillCustomList() {} });
  const html = play.innerHTML;
  const cards = play.querySelectorAll('.card');
  assert.equal(cards.length, 1, 'one card');
  assert.equal(cards[0].dataset.map, ID);
  assert.match(html, /Új pálya/);
  assert.match(html, /Teljesítve: 0\/1/);
  assert.ok(!/class="chip"/.test(html), 'a map without a difficulty has no chip');
  assert.ok(!/class="targets"|class="coin m-/.test(html), 'no medal targets without an author time');
  assert.match(html, /Saját rekord<\/span><span class="v">–/, 'no record yet');
  cards[0].onclick();
  assert.deepEqual(calls, [['solo', ID]]);
  // results: the last (only) map has no next map
  const results = new FakeEl();
  const ctx = { els: { results }, app, show() {} };
  const run = { mapId: ID, name: 'T', mapName: 'Új pálya', ticks: 1500, splits: [], labels: [], prev: null, isPB: true, medal: null, medals: null, hasNext: false, custom: false };
  UI.prototype.showResults.call(ctx, run);
  assert.match(results.innerHTML, /data-act="next"\s+disabled/, 'no next map: the button is disabled');
  assert.ok(!/res-medal/.test(results.innerHTML), 'no medal block without a proof route');
  UI.prototype.showResults.call(ctx, { ...run, hasNext: true });
  assert.ok(!/data-act="next"\s+disabled/.test(results.innerHTML) && /data-act="next"/.test(results.innerHTML), 'control: with a next map it is enabled');
});

test('BUG: the main menu says "8 pálya a kiképzéstől a mesterig" and "sim 1" - there is one built-in map and the simulation is version 3', () => {
  const menu = new FakeEl();
  UI.prototype.buildMenu.call({ els: { menu }, app: { showScreen() {} } });
  const bad = [];
  if (/8 pálya|kiképzéstől a mesterig/.test(menu.innerHTML)) bad.push('the Játék button still advertises the eight deleted maps (ui.js:155)');
  if (!menu.innerHTML.includes('sim ' + SIM_VER)) bad.push('the version line is hard-coded "sim 1" (ui.js:165), SIM_VER is ' + SIM_VER);
  assert.ok(!bad.length, bad.join('; '));
});

test('editor: the map panel has no theme selector any more (one theme preset is left): no selector, no "Téma" row, and the summary and the checks are still there', async () => {
  const { ed } = await openEditor();
  assert.deepEqual(THEME_IDS, ['kikepzes']);
  assert.equal(ed.panel.themeSel, undefined, 'no theme selector');
  const text = ed.panel.props.textContent;
  assert.ok(!/Téma/.test(text), 'no Téma row: ' + text);
  assert.match(text, /Pálya/);
  assert.match(text, /elem · \d+ ellenőrzőpont/);
  assert.equal(ed.model.doc.theme, 'kikepzes');
});

// ================================================================ a room with one map
function raceApp(over = {}) {
  const L = new Map(), calls = [], toasts = [], centers = [];
  const app = {
    maps: MAPS, DIFF_LABEL, settings: { name: 'Teszt', lastMap: 'kikepzes' }, local: { name: 'Teszt' }, mapId: 'kikepzes', get mapHash() { return hashOf(app.mapId); },
    mode: 'solo', state: 'menu', pauseFreezes: true, allow: { restart: true, respawn: true }, mapHashOf: hashOf,
    world: { ps: { pos: [1, 2, 3], yaw: 0.5, pitch: 0.1 }, cpIndex: 0, playerFlags: () => 1 },
    calls, toasts, centers,
    loadMap: async (id) => { calls.push(['loadMap', id]); app.mapId = id; },
    restartRun: (o) => calls.push(['restartRun', o]), startRun: () => calls.push(['startRun']), setFrozen: (b) => calls.push(['setFrozen', b]),
    setMode: (m) => { app.mode = m; }, play: () => { calls.push(['play']); app.state = 'playing'; }, setSetting: (k, v) => { app.settings[k] = v; },
    showScreen: (id) => { app.ui.current = id; app.emit('screen', { id }); },
    on: (t, cb) => { if (!L.has(t)) L.set(t, new Set()); L.get(t).add(cb); return () => L.get(t).delete(cb); },
    emit: (t, p = {}) => { for (const cb of [...(L.get(t) || [])]) cb(p); },
    figures: { upsert() {}, remove() {}, has: () => false },
    hud: { center: (m, o) => centers.push([m, o && o.kind]), standings() {} },
    ui: { current: 'room', toast: (m) => toasts.push(m) }, audio: { unlock() {} }, input: { lock: () => Promise.resolve(true) },
    ...over,
  };
  return app;
}

test('one map, a room: a host whose loaded / last map is a deleted old id (kikepzes) gets the one real map; a finish under 3 s is refused, 3 s counts; nobody finishing ends the race at 180 s as a DNF', async () => {
  for (const finisher of [true, false]) {
    TM.reset();
    const clock = installClock();
    const dom = installDom();
    const app = raceApp();
    initRace(app);
    const room = () => TM.rooms.at(-1), out = (type) => TM.sent.filter((m) => m.type === type);
    try {
      app.race.enter('ABCD', true);
      assert.ok(app.race.synced, 'host');
      const z = { say: (type, data) => room().actions[type].onMessage(data, { peerId: 'zzzz' }) };
      room().onPeerJoin('zzzz'); room().actions.hello.onMessage({ name: 'Zed', mh: HASH, host: '' }, { peerId: 'zzzz' });
      assert.ok(out('lobby').length > 0 && out('lobby').every((l) => l.data.mapId === ID && l.data.mapHash === HASH), 'the lobby offers the one real map: ' + JSON.stringify(out('lobby').map((l) => l.data.mapId)));
      const mapsHtml = dom.els.get('scr-room').innerHTML;
      assert.equal((mapsHtml.match(/class="mp-map"/g) || []).length, 1, 'the map list of the room has one entry');
      app.race.start(); await clock.settle();
      assert.deepEqual(out('start').map((s) => [s.data.mapId, s.data.mapHash]), [[ID, HASH]]);
      assert.ok(app.calls.some((c) => c[0] === 'loadMap' && c[1] === ID), 'the game loads the real map');
      await clock.advance(3500);
      assert.equal(app.race.phase, 'race');
      if (finisher) {
        z.say('fin', { no: 1, ticks: 360, splits: [] });
        assert.ok(!app.race.race.fin.has('zzzz'), 'a finish without the checkpoints reported is refused');
        z.say('cp', { no: 1, n: CPS, ticks: 300 });
        z.say('fin', { no: 1, ticks: 359, splits: [] });
        assert.ok(!app.race.race.fin.has('zzzz'), 'under 3 s (the floor of a map without an author time)');
        z.say('fin', { no: 1, ticks: 360, splits: [] });
        assert.equal(app.race.race.fin.get('zzzz'), 360, 'exactly 3 s counts (every checkpoint reported)');
        await clock.advance(60500);   // 60 s after the first finisher the race is cut
        assert.equal(app.race.phase, 'results');
        assert.deepEqual(out('end')[0].data.results, [['zzzz', 360, CPS, 1, 10], ['mmmm', -1, 0, 0, 0]]);
      } else {
        await clock.advance(179500);
        assert.equal(app.race.phase, 'race', 'still inside the cap at 179.5 s');
        await clock.advance(1000);
        assert.equal(app.race.phase, 'results', 'cut at 180 s');
        assert.deepEqual(out('end')[0].data.results, [['mmmm', -1, 0, 0, 0], ['zzzz', -1, 0, 0, 0]]);
      }
    } finally { try { app.emit('exit'); } catch { /* already left */ } }
  }
});

// ================================================================ the leaderboard and the stored data with one map
let lbN = 0;
const INFO = { id: ID, hash: HASH, authorTime: 0, cpCount: CPS };
// a leaderboard.js instance on the real registry; the (mock) relays answer with `events`; mapId: the map the game has loaded (a deleted one by default)
async function leaderboardOn(events, mapId = 'kikepzes') {
  const relays = makeRelays({ a: { mode: 'ok', events: events.slice() }, b: { mode: 'ok', events: events.slice() } });
  N.__setTransport({ WS: relays.WS, relays: relays.urls, now: () => Date.now() });
  N.clearCache();
  setGlobal('localStorage', memStorage()); setGlobal('sessionStorage', memStorage());
  const lb = new FakeEl(), L = new Map(), rejections = [];
  const onRej = (e) => rejections.push(e);
  process.on('unhandledRejection', onRej);
  onCleanup(() => process.off('unhandledRejection', onRej));
  const app = {
    maps: MAPS, DIFF_LABEL, settings: { name: 'Teszt' }, store: { getPB: () => null }, mapId, mode: 'solo', state: 'menu', world: null, mapHashOf: hashOf,
    ui: { els: { lb }, toast() {} }, figures: { upsert() {}, remove() {}, has: () => false }, gfx: {}, showScreen() {},
    on: (t, cb) => { if (!L.has(t)) L.set(t, []); L.get(t).push(cb); }, emit: (t, p = {}) => (L.get(t) || []).forEach((cb) => cb(p)),
  };
  const LB = await import('../leaderboard.js?onemap=' + (++lbN));
  LB.initLeaderboard(app);
  app.emit('screen', { id: 'lb' });
  return { lb, app, rejections };
}

test('one map, the leaderboard screen: one tab, the real map is selected although the loaded map id is gone; results of SIM_VER 2 (old version, old hash) and implausible ones are not listed; old records and a stale lastMap are harmless', async () => {
  const wrongVer = await forge(INFO, { ticks: 500, name: 'Régi', ver: SIM_VER - 1 });                    // a SIM_VER 2 result under the current key
  const oldHash = await forge(INFO, { ticks: 400, name: 'RégiHash', hash: 'f00dfeedc0de01' });            // a result of the old physics (its map hash differed)
  const tooFast = await forge(INFO, { ticks: FLOOR - 1, name: 'Gyors' });                                 // under the floor of a map without an author time (its route floor)
  const { lb, rejections } = await leaderboardOn([wrongVer.ev, oldHash.ev, tooFast.ev]);
  for (let i = 0; i < 80 && !/még nincs rekord/.test(lb.querySelector('.lb-status').textContent); i++) await sleep(25);
  assert.equal(lb.querySelectorAll('.lb-tab').length, 1, 'one tab');
  assert.match(lb.querySelector('.lb-head').innerHTML, /Új pálya/, 'the real map is shown');
  assert.ok(!/class="chip"|lb-targets/.test(lb.querySelector('.lb-head').innerHTML), 'no difficulty chip, no medal targets');
  assert.match(lb.querySelector('.lb-status').textContent, /még nincs rekord/, 'every stale or implausible entry was dropped: ' + lb.querySelector('.lb-status').textContent);
  assert.equal(lb.querySelector('.lb-body').innerHTML, '');
  assert.deepEqual(rejections, []);
  // a personal best stored under the old physics (a SIM_VER 2 hash), a deleted map's record and a lastMap that no longer exists
  const K = (k) => 'pajzsugras:' + k;
  setGlobal('localStorage', memStorage({
    [K('pb:' + ID)]: JSON.stringify({ hash: 'sim2-hash-of-the-map', ticks: 5000, splits: [], ghost: 'AAAA', date: 1 }),
    [K('pb:kikepzes')]: JSON.stringify({ hash: 'abc', ticks: 4000, splits: [1, 2, 3], ghost: null, date: 1 }),
    [K('settings')]: JSON.stringify({ name: 'Teszt', lastMap: 'kikepzes' }),
  }));
  const { store } = await import('../store.js?onemap=' + lbN);
  assert.equal(store.getPB(ID, HASH), null, 'the record of the old physics no longer counts');
  assert.equal(store.getPB(ID, null).ticks, 5000, '(it is still stored: only a hash can disown it)');
  assert.equal(store.loadSettings().lastMap, 'kikepzes', 'a stale lastMap loads as it is, without a crash ...');
  const first = MAPS.has('kikepzes') ? 'kikepzes' : MAPS.list[0].meta.id;   // ... and main.js starts with MAPS.has(settings.lastMap) ? it : MAPS.list[0].meta.id
  assert.equal(first, ID);
  store.setPB(ID, HASH, { ticks: 4500, splits: [], ghost: null });
  assert.equal(store.getPB(ID, HASH).ticks, 4500, 'a new record replaces the stale one');
});

test('BUG: the leaderboard screen of a map without medals (no author time - every editor export) must show its rows; render() throws at the first row and the screen stays on "Ranglista betöltése…"', async () => {
  const good = await forge(INFO, { ticks: FLOOR + 48, name: 'Jó' });
  const { lb, rejections } = await leaderboardOn([good.ev]);
  for (let i = 0; i < 80 && !/Jó/.test(lb.querySelector('.lb-body').innerHTML); i++) await sleep(25);
  assert.match(lb.querySelector('.lb-body').innerHTML, /Jó/, 'the row of the one result (status: ' + lb.querySelector('.lb-status').textContent + '); ' + String(rejections[0] && rejections[0].message) + ' - leaderboard.js coin() (:137) calls medalFor(time, null)');
});

// ================================================================ tools/add-map.mjs
const REPO_INDEX = readFileSync(join(ROOT, 'maps', 'index.js'), 'utf8');
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'pj-onemap-'));
  mkdirSync(join(root, 'maps'));
  writeFileSync(join(root, 'maps', 'index.js'), REPO_INDEX);
  copyFileSync(join(ROOT, 'maps', 'uj-palya.js'), join(root, 'maps', 'uj-palya.js'));
  return {
    root, file: (id) => join(root, 'maps', id + '.js'), index: () => readFileSync(join(root, 'maps', 'index.js'), 'utf8'),
    snapshot: () => readdirSync(join(root, 'maps')).sort().join() + '|' + readFileSync(join(root, 'maps', 'index.js'), 'utf8'),
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}
const docText = (over = {}) => JSON.stringify({ ...ujPalya, ...over });
// does the registry text still parse as a module? (an early error such as a duplicate import name or a reserved word shows up)
function syntaxOk(sb, text = sb.index()) {
  const f = join(sb.root, 'maps', 'check.mjs');
  writeFileSync(f, text);
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  rmSync(f, { force: true });
  return r.status === 0 ? '' : (r.stderr.split('\n').find((l) => /Error/.test(l)) || 'syntax error');
}

test('BUG: add-map with an id that makes maps/index.js invalid (a--b, abc-, list, by-id, builtin-def, default, class) must refuse it; two ids with the same import name (a1, a-1) must not both be added', () => {
  const sb = sandbox();
  try {
    const bad = [];
    for (const id of ['a--b', 'abc-', 'list', 'by-id', 'builtin-def', 'default', 'class']) {
      const before = sb.snapshot();
      let refused = false;
      try { addMap({ text: docText(), id, root: sb.root }); } catch { refused = true; }
      const err = refused ? '' : syntaxOk(sb);
      if (!refused && err) bad.push(`${id}: written, index.js is now invalid (${err})`);
      if (refused && sb.snapshot() !== before) bad.push(`${id}: refused but changed the folder`);
      if (!refused) { rmSync(sb.file(id), { force: true }); writeFileSync(join(sb.root, 'maps', 'index.js'), REPO_INDEX); }
    }
    addMap({ text: docText(), id: 'a1', root: sb.root });
    let second = true;
    try { addMap({ text: docText(), id: 'a-1', root: sb.root }); } catch { second = false; }
    if (second && syntaxOk(sb)) bad.push(`a1 + a-1: both written, the import name "a1" is declared twice (${syntaxOk(sb)})`);
    assert.ok(!bad.length, bad.join('; ') + ' - tools/add-map.mjs ident() / validId() (:28-29), register() (:60-61)');
  } finally { sb.done(); }
});

test('BUG: add-map with a map name that holds U+2028 / U+2029 must not turn the name into code: the generated // comment ends at a line separator', async () => {
  const bad = [];
  for (const name of ['x globalThis.__pjInjected=1;//', 'x y']) {
    const sb = sandbox();
    try {
      const r = addMap({ text: docText({ name }), id: 'inj', root: sb.root });
      const f = r.file;
      delete globalThis.__pjInjected;
      let loaded = true;
      try { await import(pathToFileURL(f).href + '?t=' + Math.random()); } catch (e) { loaded = false; bad.push(`${JSON.stringify(name)}: the module no longer loads (${String(e.message).slice(0, 50)})`); }
      if (globalThis.__pjInjected) bad.push(`${JSON.stringify(name)}: the text after U+2028 ran as code`);
      if (loaded && readFileSync(f, 'utf8').split('\n')[0].includes(' ')) bad.push(`${JSON.stringify(name)}: a raw line separator is in the comment`);
    } finally { delete globalThis.__pjInjected; sb.done(); }
  }
  assert.ok(!bad.length, bad.join('; ') + ' - the editor name cleaner (editor/model.js) keeps U+2028 / U+2029, tools/add-map.mjs moduleText() (:41) writes the name into a // comment');
});

test('add-map: hostile and huge files change nothing or come out clean (a hostile prototype key, 100000 nested arrays, 300000 items, a BOM); an update in the middle of three maps keeps the order and the registry byte for byte; the registry still loads in order and the last map has no next', async () => {
  const sb = sandbox();
  try {
    const snapshot = sb.snapshot();
    const refused = (text, re) => { assert.throws(() => addMap({ text, id: 'feher', root: sb.root }), re); assert.equal(sb.snapshot(), snapshot, 'nothing written'); };
    refused('['.repeat(100000) + ']'.repeat(100000), /nem pályafájl|nem érvényes/);
    refused(docText({ items: Array.from({ length: 300000 }, (_, i) => ({ id: i + 1, t: 'block', c: [i, 0, 0], size: [1, 1, 1], yaw: 0, mat: 'floor' })) }), /túl nagy/);
    refused('﻿' + docText(), /nem érvényes/);
    // a prototype key in the file is not copied anywhere
    addMap({ text: '{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":2}},' + docText().slice(1), id: 'proto-teszt', root: sb.root });
    assert.equal(({}).polluted, undefined, 'Object.prototype untouched');
    assert.ok(!/__proto__|polluted/.test(readFileSync(sb.file('proto-teszt'), 'utf8')), 'not in the written module');
    rmSync(sb.file('proto-teszt'), { force: true }); writeFileSync(join(sb.root, 'maps', 'index.js'), REPO_INDEX);
    // three maps; update the middle one
    addMap({ text: docText({ name: 'Második' }), id: 'ketto', root: sb.root });
    addMap({ text: docText({ name: 'Harmadik' }), id: 'harom', root: sb.root });
    const idx = sb.index();
    const changed = JSON.parse(docText({ name: 'Második v2' })); changed.items = changed.items.slice(0, 7);
    const r = addMap({ text: JSON.stringify(changed), id: 'ketto', root: sb.root });
    assert.deepEqual([r.created, r.order, r.items], [false, 2, 7], 'the middle map keeps place 2');
    assert.equal(sb.index(), idx, 'the registry is byte for byte the same after an update');
    assert.equal(register(idx, 'harom').order, 3);
    // the registry loads: 3 maps in the order of the entries, the first two have a next map, the last has none
    const regFile = join(sb.root, 'maps', 'registry.mjs');
    writeFileSync(regFile, idx.replace("'../editor/convert.js'", `'${pathToFileURL(join(ROOT, 'editor', 'convert.js')).href}'`));
    const { MAPS: M } = await import(pathToFileURL(regFile).href + '?t=' + Math.random());
    assert.deepEqual(M.ids, ['uj-palya', 'ketto', 'harom']);
    assert.deepEqual(M.list.map((e) => e.meta.order), [1, 2, 3]);
    assert.deepEqual(M.list.map((e) => e.meta.name), ['Új pálya', 'Második v2', 'Harmadik']);
    assert.deepEqual(M.list.map((e, i) => i >= 0 && i < M.list.length - 1), [true, true, false], 'hasNext (main.js nextMap / showResults)');
    assert.equal(M.get('ketto').build().brushes.length, 7);
  } finally { sb.done(); }
});

// ================================================================ no built-in map at all (maps/index.js with an empty list)
test('empty registry: the JÁTÉK screen says there is no built-in map yet (no "Teljesítve 0/0") and still offers the player\'s own maps', () => {
  installDom();
  const app = { maps: { list: [], ids: [], get: () => null, has: () => false }, mapHashOf: () => null, store: { getPB: () => null, listCustom: () => [] }, startSolo() {}, showScreen() {} };
  const play = new FakeEl();
  UI.prototype.buildPlay.call({ app, els: { play }, fillCustomList() {} });
  assert.match(play.innerHTML, /Még nincs beépített pálya/);
  assert.ok(!/Teljesítve|class="card"/.test(play.innerHTML), 'no cards, no counter');
  assert.match(play.innerHTML, /Saját pályák/, 'the player\'s own maps stay');
});
