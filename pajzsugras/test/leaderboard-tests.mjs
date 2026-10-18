// leaderboard.js: submitPB (incl. the `pajzsugras:no-publish` switch), top1 (must never throw), the RANGLISTA screen.
// Fake DOM + mock relays; nostr.js is shared with the nostr suite, so every case starts from useRelays() (new relays, empty cache).
import { test, assert, setGlobal, sleep } from './harness.mjs';
import { guardWebSocket, memStorage, brokenStorage, makeRelays, forge, El, fakeMaps, DIFF_LABEL } from './support.mjs';
import { routeFloor } from '../sim/world.js';
import { TICK } from '../sim/const.js';

guardWebSocket();
const N = await import('../nostr.js');                 // the same instance leaderboard.js imports
let lbN = 0;
const okRelay = (events = []) => ({ mode: 'ok', events });
const down = () => ({ mode: 'down', events: [] });
const useRelays = (spec) => {
  const r = makeRelays(spec);
  N.__setTransport({ WS: r.WS, relays: r.urls, now: () => Date.now() });
  N.clearCache();
  return r;
};
const ALPHA = { id: 'alpha', hash: 'hash-alpha', authorTime: 40, cpCount: 2 };   // = fakeMaps() alpha; fastest credible time ceil(0.5 x 40 x 120) = 2400 ticks

// a fresh leaderboard.js instance + the `app` object it needs (see the contract at the top of main.js)
async function setupLb(box = { pb: null }, maps = fakeMaps()) {
  const lb = new El(), toasts = [], L = new Map();
  const app = {
    maps, DIFF_LABEL, settings: { name: 'Teszt' }, store: { getPB: () => box.pb }, mapId: 'alpha', mode: 'solo', state: 'playing', world: null,
    mapHashOf: (id) => (maps.has(id) ? 'hash-' + id : null),
    ui: { els: { lb }, toast: (m) => toasts.push(m) },
    figures: { upsert() {}, remove() {}, has: () => false }, gfx: {},
    on: (t, cb) => { if (!L.has(t)) L.set(t, []); L.get(t).push(cb); },
    emit: (t, p = {}) => (L.get(t) || []).forEach((cb) => cb(p)),
    showScreen() {},
  };
  const LB = await import('../leaderboard.js?fresh=' + (++lbN));
  LB.initLeaderboard(app);
  return { LB, app, lb, toasts, maps };
}
const runOf = (o = {}) => ({ mapId: 'alpha', mapHash: 'hash-alpha', ticks: 5000, time: 5000 / 120, splits: [2000, 4000], ghost: null, name: 'Teszt', ...o });

test('leaderboard submitPB: undefined when publishing is off, false for an unknown map / stale hash / no relay, true when sent (and the cache is dropped)', async () => {
  const { LB } = await setupLb();
  const r = useRelays({ a: okRelay(), b: okRelay() });
  setGlobal('localStorage', memStorage({ 'pajzsugras:no-publish': '1' }));
  assert.equal(await LB.submitPB('alpha', runOf()), undefined, 'switched off for tests');
  assert.equal(r.st.connects, 0, '... and nothing touched the network');
  setGlobal('localStorage', memStorage());
  assert.equal(await LB.submitPB('nope', runOf()), false, 'unknown map');
  assert.equal(await LB.submitPB('alpha', runOf({ mapHash: 'old-build' })), false, 'the run is from another map version');
  assert.equal(await LB.submitPB('alpha', null), false, 'no run');
  assert.equal(r.st.connects, 0, 'none of those went out');
  assert.equal(await LB.top1('alpha'), null, 'empty board (and now cached)');
  assert.equal(await LB.submitPB('alpha', runOf()), true);
  assert.equal(r.st.posts, 2, 'sent to both relays');
  assert.deepEqual(await LB.top1('alpha'), { name: 'Teszt', time: 5000 / 120 }, 'the publish dropped the cached empty board');
  setGlobal('localStorage', brokenStorage());      // private mode: the switch cannot be read -> publishing is on
  assert.equal(await LB.submitPB('alpha', runOf({ ticks: 4900, splits: [1900, 3900] })), true);
  useRelays({ a: down(), b: { mode: 'reject', events: [] } });
  assert.equal(await LB.submitPB('alpha', runOf()), false, 'no relay took it');
});

test('leaderboard top1: never throws - offline, unknown map, corrupt or hostile session cache, a WebSocket that throws', async () => {
  const { LB } = await setupLb();
  setGlobal('sessionStorage', memStorage());
  useRelays({ a: down(), b: down() });
  assert.equal(await LB.top1('alpha'), null, 'offline');
  useRelays({ a: okRelay(), b: okRelay() });
  assert.equal(await LB.top1('nope'), null, 'unknown map');
  assert.equal(await LB.top1('alpha'), null, 'empty board');
  const key = 'pajzsugras-v1:alpha:hash-alpha,pajzsugras-v1:beta:hash-beta';
  const now = Date.now();
  for (const raw of ['{oops, not json', JSON.stringify({ key, res: { ok: true, at: now } }), JSON.stringify({ key, res: { ok: true, at: now, boards: { alpha: { top: [null] } } } })]) {
    useRelays({ a: okRelay(), b: okRelay() });
    setGlobal('sessionStorage', memStorage({ 'pajzsugras:lb-cache': raw }));
    const v = await LB.top1('alpha');             // (a rejection would fail the case)
    assert.ok(v === null || typeof v === 'object', 'resolved for cache ' + raw.slice(0, 30));
  }
  useRelays({ a: okRelay(), b: okRelay() });
  setGlobal('sessionStorage', brokenStorage());
  assert.equal(await LB.top1('alpha'), null, 'sessionStorage throws');
  N.__setTransport({ WS: class { constructor() { throw new Error('blocked'); } }, relays: ['wss://x'] }); N.clearCache();
  assert.equal(await LB.top1('alpha'), null, 'WebSocket constructor throws');
  const idle = await import('../leaderboard.js?fresh=' + (++lbN));   // initLeaderboard() not called yet (the menu cards may ask first)
  assert.equal(await idle.top1('alpha'), null, 'before initLeaderboard');
  assert.equal(await idle.submitPB('alpha', runOf()), undefined);
});

test('leaderboard screen: loading / offline / empty notes, own row marked, hostile names escaped, send button only while the local PB is not on the board', async () => {
  setGlobal('localStorage', memStorage()); setGlobal('sessionStorage', memStorage());
  const box = { pb: null };
  const { LB, app, lb, toasts } = await setupLb(box);
  useRelays({ a: down(), b: down() });
  app.emit('screen', { id: 'lb' });
  assert.ok(lb.has('.lb-panel') && lb.has('.lb-tab'), 'screen built');
  assert.ok(lb.querySelector('.lb-status').textContent.includes('betöltése'), 'loading note first');
  await sleep(80);
  assert.ok(lb.querySelector('.lb-status').textContent.includes('nem érhető el'), 'offline note');
  // an empty board
  const r = useRelays({ a: okRelay(), b: okRelay() });
  lb.querySelector('[data-act=refresh]').onclick(); await sleep(80);
  assert.ok(lb.querySelector('.lb-status').textContent.includes('még nincs rekord'), 'empty note');
  assert.equal(lb.querySelector('[data-act=ghost]').hidden, true);
  // rows: a fast one, one with a hostile name, mine (slower than a PB I hold locally)
  setGlobal('localStorage', memStorage());
  const mine = await N.buildEvent(ALPHA, { ticks: 6000, splits: [2000, 4000], name: 'Én' });
  const hostile = (await forge(ALPHA, { ticks: 4500, name: '<i>"&\'', splits: [1500, 3000] })).ev;
  const fast = (await forge(ALPHA, { ticks: 4000, name: 'Gyors', splits: [1500, 3000] })).ev;
  r.spec.a.events.push(mine, hostile, fast);
  box.pb = { ticks: 5500, splits: [2000, 4000], ghost: null, date: 1 };
  lb.querySelector('[data-act=refresh]').onclick(); await sleep(150);
  const html = lb.querySelector('.lb-body').innerHTML;
  assert.deepEqual([...html.matchAll(/<td class="nm">([^<]*)/g)].map((m) => m[1].replace(/&#39;/g, "'").trim()).slice(0, 3), ['Gyors', 'i&quot;&amp;\'', 'Én'], 'rank order, names escaped');
  assert.ok(!html.includes('i"&'), 'no raw quote / ampersand from a name in the markup');
  assert.ok(/class="me[^"]*"><td class="rk">3<\/td><td class="nm">Én <small>\(te\)<\/small>/.test(html), 'my row is marked: ' + html.slice(0, 400));
  assert.ok(html.includes('lb-local'), 'local PB faster than the one on the board is announced');
  assert.equal(lb.querySelector('[data-act=send]').hidden, false, 'a faster local PB can be sent');
  lb.querySelector('[data-act=send]').onclick(); await sleep(200);
  assert.ok(toasts.some((t) => t.includes('elküldve')) && r.st.posts >= 2, 'sent: ' + JSON.stringify(toasts));
  assert.equal(lb.querySelector('[data-act=send]').hidden, true, 'once it is on the board the button goes away');
  assert.ok(lb.querySelector('.lb-body').innerHTML.includes('0:45.833'), 'the board now shows the sent 5500 ticks');
});

test('leaderboard screen (hardening): a fresh but malformed session cache must not wedge the screen on "loading"', async () => {
  setGlobal('localStorage', memStorage());
  const { app, lb } = await setupLb();
  useRelays({ a: okRelay(), b: okRelay() });
  const key = 'pajzsugras-v1:alpha:hash-alpha,pajzsugras-v1:beta:hash-beta';
  setGlobal('sessionStorage', memStorage({ 'pajzsugras:lb-cache': JSON.stringify({ key, res: { ok: true, at: Date.now() } }) }));   // no `boards`
  app.emit('screen', { id: 'lb' });
  await sleep(100);   // (an exception in render() surfaces as an unhandled rejection, which fails the case)
  assert.ok(!lb.querySelector('.lb-status').textContent.includes('betöltése'), 'still "loading": ' + lb.querySelector('.lb-status').textContent);
});

// ---------------------------------------------------------------- maps without medals / without a finish (the exports of the editor)
// a map: authorTime 0 = no proof route (no medals); finish: false = no goal yet; the finish box starts `far` metres from the start along +x
const mkMap = (id, { authorTime = 0, finish = true, far = 10, order = 1, cps = [] } = {}) => ({
  meta: { id, name: id.toUpperCase(), order, diff: 'konnyu', authorTime },
  build: () => ({
    mapHash: 'hash-' + id, start: { pos: [0, 0, 0], yaw: 0 }, pads: [], movers: [],
    checkpoints: cps.map((c, i) => ({ i, label: 'CP' + (i + 1), min: c.min, max: c.max })),
    finish: finish ? { min: [far, 0, 0], max: [far + 1, 2, 1] } : null,
  }),
});
const registry = (...list) => ({ list, ids: list.map((e) => e.meta.id), get: (id) => list.find((e) => e.meta.id === id) || null, has: (id) => list.some((e) => e.meta.id === id) });
const waitFor = async (re, el, sel) => { for (let i = 0; i < 80 && !re.test(el.querySelector(sel).innerHTML); i++) await sleep(25); };

test('leaderboard screen: a map without an author time (no medals) lists its rows - no medal column, no medal targets, no crash, the gap row fits the table', async () => {
  setGlobal('localStorage', memStorage()); setGlobal('sessionStorage', memStorage());
  const GAMMA = { id: 'gamma', hash: 'hash-gamma', authorTime: 0, cpCount: 0 };
  const events = [];
  for (let i = 0; i < 55; i++) events.push((await forge(GAMMA, { ticks: 600 + i * 10, name: 'P' + i })).ev);   // more than the 50 of the top list
  const mine = await N.buildEvent(GAMMA, { ticks: 5000, splits: [], name: 'Én' });
  useRelays({ a: okRelay([...events, mine]), b: okRelay([...events, mine]) });
  const { app, lb } = await setupLb({ pb: null }, registry(mkMap('gamma')));
  const rejections = [];
  const onRej = (e) => rejections.push(e);
  process.on('unhandledRejection', onRej);
  try {
    app.emit('screen', { id: 'lb' });
    await waitFor(/P0/, lb, '.lb-body');
    const html = lb.querySelector('.lb-body').innerHTML;
    assert.match(html, /P0/, 'the rows are there: ' + lb.querySelector('.lb-status').textContent);
    assert.ok(!html.includes('<th>Érem</th>') && !html.includes('class="md"') && !html.includes('coin'), 'no medal column, no coins');
    assert.equal((html.match(/<th>/g) || []).length, 4, 'four columns: #, Játékos, Idő, Különbség');
    assert.match(html, /<tr class="gap"><td colspan="4">/, 'my row below the top 50 comes after a gap row as wide as the table');
    assert.match(html, /class="me[^"]*"><td class="rk">56<\/td>/, 'and it is mine');
    assert.ok(!lb.querySelector('.lb-head').innerHTML.includes('lb-targets'), 'no medal targets');
    assert.deepEqual(rejections, [], 'render() did not throw');
  } finally { process.off('unhandledRejection', onRej); }
});

test('leaderboard screen: a map with an author time keeps its medal column and targets', async () => {
  setGlobal('localStorage', memStorage()); setGlobal('sessionStorage', memStorage());
  useRelays({ a: okRelay([(await forge(ALPHA, { ticks: 4000, name: 'Gyors', splits: [1500, 3000] })).ev]), b: okRelay() });
  const { app, lb } = await setupLb();
  app.emit('screen', { id: 'lb' });
  await waitFor(/Gyors/, lb, '.lb-body');
  const html = lb.querySelector('.lb-body').innerHTML;
  assert.ok(html.includes('<th>Érem</th>') && html.includes('class="md"'), 'medal column');
  assert.ok(lb.querySelector('.lb-head').innerHTML.includes('lb-targets'), 'medal targets');
});

test('leaderboard screen: maps without a finish are not on the board while another map has one; with none that has one all are listed (the screen is never empty); an empty registry is a note, not a crash', async () => {
  setGlobal('localStorage', memStorage()); setGlobal('sessionStorage', memStorage());
  useRelays({ a: okRelay(), b: okRelay() });
  const goalless = mkMap('delta', { finish: false, order: 2 });
  const mixed = await setupLb({ pb: null }, registry(mkMap('gamma'), goalless));
  mixed.app.emit('screen', { id: 'lb' });
  assert.deepEqual(mixed.lb.querySelectorAll('.lb-tab').map((t) => t.dataset.map), ['gamma'], 'only the map with a finish has a tab');
  const only = await setupLb({ pb: null }, registry(goalless));
  only.app.emit('screen', { id: 'lb' });
  assert.deepEqual(only.lb.querySelectorAll('.lb-tab').map((t) => t.dataset.map), ['delta'], 'no map has a finish: all are listed');
  const none = await setupLb({ pb: null }, registry());
  none.app.emit('screen', { id: 'lb' });
  await sleep(60);
  assert.match(none.lb.querySelector('.lb-status').textContent, /Még nincs pálya/);
  assert.equal(none.lb.querySelectorAll('.lb-tab').length, 0);
});

test('leaderboard: the board asks for the maps with a finish only, and the geometric floor of a map without an author time drops a record that is faster than the way allows', async () => {
  setGlobal('localStorage', memStorage()); setGlobal('sessionStorage', memStorage());
  const FAR = { id: 'far', hash: 'hash-far', authorTime: 0, cpCount: 0 };
  const fast = (await forge(FAR, { ticks: 8 * TICK, name: 'Rakéta' })).ev;      // 300 m in 8 s: 37 m/s along the straight line, nobody runs that
  const ok = (await forge(FAR, { ticks: 14 * TICK, name: 'Futó' })).ev;
  const r = useRelays({ a: okRelay([fast, ok]), b: okRelay([fast, ok]) });
  const { app, lb, LB } = await setupLb({ pb: null }, registry(mkMap('far', { far: 300 }), mkMap('delta', { finish: false, order: 2 })));
  app.emit('screen', { id: 'lb' });
  await waitFor(/Futó/, lb, '.lb-body');
  const html = lb.querySelector('.lb-body').innerHTML;
  assert.ok(html.includes('Futó') && !html.includes('Rakéta'), 'the 8 s record is under the floor (' + routeFloor(app.maps.get('far').build()).toFixed(2) + ' s), the 14 s one is on the board: ' + html.slice(0, 200));
  assert.deepEqual([...new Set((r.st.filters || []).map((x) => x['#d'][0]))], ['pajzsugras-v1:far:hash-far'], 'the goalless map is not asked for');
  assert.equal(await LB.top1('delta'), null, 'and a card of it shows no #1');
});

test('routeFloor: horizontal box-to-box way start -> checkpoints in order -> finish over 30 m/s (60 with pads or movers); 0 without a finish or with bad data, never throws', () => {
  const start = { pos: [0, 0, 0], yaw: 0 };
  const cp = { min: [100, 0, -1], max: [101, 2, 1] }, fin = { min: [100, 0, 200], max: [101, 2, 201] };
  const way = 99.6 + 198.2;   // start -> cp (grown by the hull's half width 0.4: x from 99.6) -> finish (z from 199.6, the cp reaches 1.4)
  const map = { start, checkpoints: [cp], finish: fin, pads: [], movers: [] };
  assert.ok(Math.abs(routeFloor(map) - way / 30) < 1e-9, 'floor ' + routeFloor(map));
  assert.ok(Math.abs(routeFloor({ ...map, pads: [{}] }) - way / 60) < 1e-9, 'a pad: the VMAX bound');
  assert.ok(Math.abs(routeFloor({ ...map, movers: [{}] }) - way / 60) < 1e-9, 'a mover: the VMAX bound');
  assert.ok(Math.abs(routeFloor({ ...map, checkpoints: [] }) - Math.hypot(99.6, 199.6) / 30) < 1e-9, 'no checkpoint: start -> finish (the straight line)');
  assert.equal(routeFloor({ ...map, finish: null }), 0, 'no finish');
  assert.equal(routeFloor({ ...map, start: null }), 0); assert.equal(routeFloor({ ...map, start: { pos: [NaN, 0, 0] } }), 0);
  assert.equal(routeFloor({ ...map, checkpoints: [{ min: null }] }), 0, 'a broken checkpoint: no floor, no throw');
  for (const junk of [null, undefined, 5, {}, []]) assert.equal(routeFloor(junk), 0);
  // a box the start already stands in costs nothing; the vertical is not counted
  assert.equal(routeFloor({ start, checkpoints: [], finish: { min: [-1, 50, -1], max: [1, 60, 1] }, pads: [], movers: [] }), 0);
  assert.equal(N.minTicks(0, routeFloor(map)), Math.ceil(way / 30 * TICK), 'the board floor of this map');
});
