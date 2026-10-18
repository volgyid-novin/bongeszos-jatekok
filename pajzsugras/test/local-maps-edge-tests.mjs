// editor/local-maps.js, the awkward cases (the second pass after local-maps-tests.mjs; registered by app-tests.mjs).
// A hostile or huge index, an entry that is the index itself, a map the browser could not keep, a fetch that never answers, files over the
// size limit, and the screen refresh main.js asks the UI for. fetch / location / localStorage are mocks (a new store module = a new page load).
import { test, assert, setGlobal, sleep } from './harness.mjs';
import { memStorage, guardWebSocket, installDom } from './support.mjs';
import { newDoc } from '../editor/model.js';
import { loadLocalMaps } from '../editor/local-maps.js';
import { CUSTOM_LIMIT } from '../store.js';

guardWebSocket();   // (ui.js -> leaderboard.js -> nostr.js grabs globalThis.WebSocket when it is imported)
const { UI } = await import('../ui.js');

let storeN = 0;
const freshStore = async (ls) => { setGlobal('localStorage', ls); return (await import('../store.js?lme=' + (++storeN))).store; };
const K = 'pajzsugras:localmaps';
const U = (name) => '/pajzsugras/local-maps/' + name;
const INDEX = U('index.json');
const index = (...maps) => JSON.stringify({ v: 1, maps });
const mapText = (id, name, w = 8) => JSON.stringify({ ...newDoc({ id, name }), nextId: 3, items: [
  { id: 1, t: 'block', c: [0, -0.5, -25], size: [w, 1, 60], yaw: 0, mat: 'floor' },
  { id: 2, t: 'finish', c: [0, 2.5, -45], size: [6, 5, 3] }] });

// a dev server on localhost: files = { url: text | { status, body } | 'throw' | 'hang' | 'bodyfail' }; a url that is not there gets the SPA fallback like Vite
function server(files) {
  const calls = [];
  setGlobal('location', { hostname: 'localhost' });
  setGlobal('fetch', async (url) => {
    calls.push(String(url));
    const f = files[String(url)];
    if (f === 'throw') throw new TypeError('network down');
    if (f === 'hang') return new Promise(() => {});
    if (f === 'bodyfail') return { ok: true, status: 200, text: async () => { throw new TypeError('connection reset'); } };
    if (f === undefined) return new Response('<!doctype html><html><body>PAJZSUGRÁS</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    return typeof f === 'string' ? new Response(f, { status: 200 }) : new Response(f.body, { status: f.status });
  });
  return calls;
}

test('local maps edge: a hostile index (100000 entries, duplicates, junk, an encoded path) costs at most 40 requests and every file is imported once', async () => {
  const ls = memStorage(), store = await freshStore(ls);
  const names = ['a.json', 'a.json', 'b.json', '%2e%2e%2fsecret.json', '..%2fx.json', '%2E%2E/x.json', '..\\x.json', 'c:/x.json', 'a.json?x=1', 'a.json#h', ' a.json', 'a.json ', 'ａ.json', 'a\u0000.json', '__proto__.json', 'constructor.json', 'c.json'];
  const filler = Array.from({ length: 100000 }, (_, i) => (i % 3 === 0 ? 'f' + (i % 500) + '.json' : i % 3 === 1 ? i : { x: i }));
  const files = { [INDEX]: index(...names, ...filler), [U('a.json')]: mapText('a', 'A'), [U('b.json')]: mapText('b', 'B'), [U('c.json')]: mapText('c', 'C') };
  const calls = server(files);
  const t0 = performance.now();
  const got = await loadLocalMaps(store);
  assert.ok(performance.now() - t0 < 5000, 'took ' + (performance.now() - t0) + ' ms');
  assert.ok(calls.length <= 1 + CUSTOM_LIMIT, calls.length + ' requests for a 100000 entry index');
  assert.deepEqual(calls.filter((c) => /%|\.\.|\\|\?|#| |\u0000|:/.test(c.slice(U('').length))), [], 'no encoded or escaping name was fetched');
  assert.deepEqual(got.map((d) => d.id).sort(), ['a', 'b', 'c'], 'the duplicate a.json is one map; constructor.json is an HTML fallback, not a map');
  assert.equal(store.listCustom().length, 3);
  assert.deepEqual(Object.keys(JSON.parse(ls._m.get(K))).sort(), ['a.json', 'b.json', 'c.json']);
  assert.equal(({}).polluted, undefined);
});

test('BUG: local maps edge: an index that lists itself (index.json) makes no saved map (its text is an editor document too: v 1, so it imports as an empty "Névtelen pálya")', async () => {
  const ls = memStorage(), store = await freshStore(ls);
  server({ [INDEX]: index('index.json', 'ok.json'), [U('ok.json')]: mapText('ok', 'Jó') });
  const got = await loadLocalMaps(store);
  assert.deepEqual(got.map((d) => d.id), ['ok'], 'only the real map, got ' + JSON.stringify(got.map((d) => d.name)));
  assert.deepEqual(store.listCustom().map((e) => e.id), ['ok']);
  assert.deepEqual(Object.keys(JSON.parse(ls._m.get(K))), ['ok.json']);
});

test('BUG: local maps edge: a map the browser could not keep (the document write hits the quota) is not recorded as imported: after a reload it would be gone for good', async () => {
  // the storage refuses the big map document but still takes the small keys (the index, the record)
  const full = memStorage();
  const setItem = full.setItem;
  full.setItem = (k, v) => { if (k.startsWith('pajzsugras:ed:map:')) throw new DOMException('quota', 'QuotaExceededError'); setItem(k, v); };
  const store = await freshStore(full);
  server({ [INDEX]: index('a.json'), [U('a.json')]: mapText('a', 'A') });
  await loadLocalMaps(store);
  const record = full._m.has(K) ? Object.keys(JSON.parse(full._m.get(K))) : [];
  assert.deepEqual(record, [], 'a.json is remembered as imported although importMapText said saved: false (local-maps.js:56-60 never looks at r.saved); the next start skips it, the map is lost');
  // and a map that did get saved is still recorded
  const ok = memStorage(), store2 = await freshStore(ok);
  server({ [INDEX]: index('a.json'), [U('a.json')]: mapText('a', 'A') });
  await loadLocalMaps(store2);
  assert.deepEqual(Object.keys(JSON.parse(ok._m.get(K))), ['a.json']);
});

test('local maps edge: a record that cannot be written does not break the session (no second copy within the page) and nothing throws', async () => {
  const ls = memStorage();
  const setItem = ls.setItem;
  ls.setItem = (k, v) => { if (k === K) throw new DOMException('quota', 'QuotaExceededError'); setItem(k, v); };
  const store = await freshStore(ls);
  server({ [INDEX]: index('a.json'), [U('a.json')]: mapText('a', 'A') });
  assert.deepEqual((await loadLocalMaps(store)).map((d) => d.id), ['a']);
  assert.deepEqual(await loadLocalMaps(store), [], 'the record lives in memory for the rest of the page');
  assert.equal(store.listCustom().length, 1);
});

test('local maps edge: a fetch that never answers, a rejecting fetch, a body that dies half way or no fetch at all neither throw nor touch the storage', async () => {
  for (const [label, files] of [['index hangs', { [INDEX]: 'hang' }], ['index rejects', { [INDEX]: 'throw' }], ['index body fails', { [INDEX]: 'bodyfail' }]]) {
    const ls = memStorage(), store = await freshStore(ls);
    server(files);
    let settled = false;
    const p = loadLocalMaps(store).then((r) => { settled = true; return r; });
    await sleep(30);
    assert.equal(settled, label !== 'index hangs', label + ': a hanging fetch leaves the promise pending (main.js does not wait for it), the others end quietly');
    if (settled) assert.deepEqual(await p, [], label);
    assert.equal(ls._m.size, 0, label + ': nothing stored');
  }
  // the first file hangs / dies: nothing is imported, nothing thrown; with a body that dies, the next file is still imported
  const ls2 = memStorage(), store2 = await freshStore(ls2);
  server({ [INDEX]: index('dead.json', 'ok.json'), [U('dead.json')]: 'bodyfail', [U('ok.json')]: mapText('ok', 'Jó') });
  assert.deepEqual((await loadLocalMaps(store2)).map((d) => d.id), ['ok']);
  const ls3 = memStorage(), store3 = await freshStore(ls3);
  server({});
  setGlobal('fetch', undefined);
  assert.deepEqual(await loadLocalMaps(store3), [], 'no fetch function at all');
  setGlobal('fetch', () => { throw new TypeError('sync throw'); });
  assert.deepEqual(await loadLocalMaps(store3), [], 'a fetch that throws synchronously');
});

test('local maps edge: an index or a map over 4 MB is ignored without stopping the next file', async () => {
  const ls = memStorage(), store = await freshStore(ls);
  const big = JSON.stringify({ v: 1, maps: ['ok.json'], pad: 'x'.repeat(4e6) });
  server({ [INDEX]: big, [U('ok.json')]: mapText('ok', 'Jó') });
  assert.deepEqual(await loadLocalMaps(store), [], 'a 4 MB index is not read');
  const ls2 = memStorage(), store2 = await freshStore(ls2);
  const calls = server({ [INDEX]: index('huge.json', 'ok.json'), [U('huge.json')]: JSON.stringify({ ...JSON.parse(mapText('huge', 'Nagy')), pad: 'x'.repeat(4e6) }), [U('ok.json')]: mapText('ok', 'Jó') });
  assert.deepEqual((await loadLocalMaps(store2)).map((d) => d.id), ['ok']);
  assert.equal(calls.length, 3);
  assert.deepEqual(Object.keys(JSON.parse(ls2._m.get(K))), ['ok.json']);
});

test('local maps edge: ui.refreshCustomLists redraws the list that is on screen (Saját pályák or the editor home), flashes the new id, and does nothing elsewhere', () => {
  installDom();
  const calls = [];
  const ui = (current) => ({ current, fillCustomList: (box, mode, flash) => calls.push([box, mode, flash]) });
  UI.prototype.refreshCustomLists.call(ui('play'), 'newid');
  UI.prototype.refreshCustomLists.call(ui('edhome'), 'newid');
  assert.deepEqual(calls.map((c) => [c[1], c[2]]), [['play', 'newid'], ['edit', 'newid']]);
  assert.notEqual(calls[0][0], calls[1][0], 'two different lists');
  calls.length = 0;
  for (const cur of ['menu', 'loading', 'pause', 'results', 'settings', null, undefined]) UI.prototype.refreshCustomLists.call(ui(cur), 'x');
  assert.deepEqual(calls, [], 'a screen without the list: nothing is drawn');
  UI.prototype.refreshCustomLists.call(ui('play'));
  assert.equal(calls[0][2], null, 'no id = no flash');
});
