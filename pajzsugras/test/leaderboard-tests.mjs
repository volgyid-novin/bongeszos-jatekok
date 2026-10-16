// leaderboard.js: submitPB (incl. the `pajzsugras:no-publish` switch), top1 (must never throw), the RANGLISTA screen.
// Fake DOM + mock relays; nostr.js is shared with the nostr suite, so every case starts from useRelays() (new relays, empty cache).
import { test, assert, setGlobal, sleep } from './harness.mjs';
import { guardWebSocket, memStorage, brokenStorage, makeRelays, forge, El, fakeMaps, DIFF_LABEL } from './support.mjs';

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
async function setupLb(box = { pb: null }) {
  const maps = fakeMaps(), lb = new El(), toasts = [], L = new Map();
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
