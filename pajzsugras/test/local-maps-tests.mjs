// editor/local-maps.js: the maps that tools/ut2004_map.py wrote into the git-ignored local-maps/ folder are imported into the saved maps by
// themselves, only on a local dev host. fetch / location / localStorage are mocks (an in-memory storage; a new store module = a new page load).
import { test, assert, setGlobal } from './harness.mjs';
import { memStorage } from './support.mjs';
import { newDoc } from '../editor/model.js';
import * as lib from '../editor/library.js';
import { loadLocalMaps, isLocalHost } from '../editor/local-maps.js';
import { CUSTOM_LIMIT } from '../store.js';

let storeN = 0;
const freshStore = async (ls) => { setGlobal('localStorage', ls); return (await import('../store.js?lm=' + (++storeN))).store; };
const K = 'pajzsugras:localmaps';
const U = (name) => '/pajzsugras/local-maps/' + name;
const INDEX = U('index.json');
const index = (...maps) => JSON.stringify({ v: 1, maps });
// a playable map as the converter writes it (a floor and a finish); `w` changes the text
const mapText = (id, name, w = 8) => JSON.stringify({ ...newDoc({ id, name }), nextId: 3, items: [
  { id: 1, t: 'block', c: [0, -0.5, -25], size: [w, 1, 60], yaw: 0, mat: 'floor' },
  { id: 2, t: 'finish', c: [0, 2.5, -45], size: [6, 5, 3] }] });

// a dev server: files = { url: text | { status, body } | 'throw' }; a url that is not there gets the SPA fallback (index.html, status 200) like Vite
function server(files, hostname = 'localhost') {
  const calls = [];
  setGlobal('location', { hostname });
  setGlobal('fetch', async (url, opts) => {
    calls.push([String(url), opts && opts.cache]);
    const f = files[String(url)];
    if (f === 'throw') throw new TypeError('network down');
    if (f === undefined) return new Response('<!doctype html><html><body>PAJZSUGRÁS</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    return typeof f === 'string' ? new Response(f, { status: 200 }) : new Response(f.body, { status: f.status });
  });
  return calls;
}

test('local maps: the index is fetched (no-store) only when the page is served from this machine', async () => {
  for (const host of ['localhost', 'LocalHost', '127.0.0.1', '[::1]', 'dev.localhost']) {
    const store = await freshStore(memStorage());
    const calls = server({ [INDEX]: index() }, host);
    assert.deepEqual(await loadLocalMaps(store), [], host);
    assert.deepEqual(calls, [[INDEX, 'no-store']], host + ': one request, never from the cache');
  }
  for (const host of ['izsi.github.io', 'localhost.evil.com', 'evil-localhost', 'abc.trycloudflare.com', '192.168.1.5', '127.0.0.1.nip.io', '']) {
    const store = await freshStore(memStorage());
    const calls = server({ [INDEX]: index('a.json'), [U('a.json')]: mapText('a', 'A') }, host);
    assert.deepEqual(await loadLocalMaps(store), [], host);
    assert.deepEqual(calls, [], host + ': nothing is fetched, nothing imported');
    assert.deepEqual(store.listCustom(), []);
  }
  setGlobal('location', undefined);
  assert.deepEqual(await loadLocalMaps(await freshStore(memStorage())), [], 'no location at all');
  assert.deepEqual(['localhost', '127.0.0.1', '[::1]', 'a.b.localhost'].map(isLocalHost), [true, true, true, true]);
  assert.deepEqual([undefined, null, 5, 'localhost.', 'xlocalhost'].map(isLocalHost), [false, false, false, false, false]);
});

test('local maps: a 404, the dev server\'s HTML fallback, bad JSON, a wrong shape, a network error and bad file names are ignored silently', async () => {
  const bad = {
    '404': { status: 404, body: 'Not found' }, '403': { status: 403, body: '403: local files of this machine only' }, 'HTML fallback': undefined, 'bad JSON': '{oops', 'empty': '',
    'wrong v': JSON.stringify({ v: 2, maps: ['a.json'] }), 'maps not a list': JSON.stringify({ v: 1, maps: 'a.json' }), 'an array': '[]', 'null': 'null', 'a number': '7', 'network error': 'throw',
  };
  for (const [label, body] of Object.entries(bad)) {
    const ls = memStorage(), store = await freshStore(ls);
    const calls = server({ [INDEX]: body, [U('a.json')]: mapText('a', 'A') });
    assert.deepEqual(await loadLocalMaps(store), [], label);
    assert.equal(calls.length, 1, label + ': only the index was asked for');
    assert.equal(ls._m.size, 0, label + ': nothing was stored');
  }
  // names the game does not accept are not even fetched
  const names = ['../secret.json', 'A.json', 'x.JSON', 'a_b.json', 'sub/x.json', 'x'.repeat(25) + '.json', '.json', 'x.json.txt', 'x.json\n', 'http://evil.example/x.json', 5, null, {}];
  const ls = memStorage(), store = await freshStore(ls);
  const calls = server({ [INDEX]: index(...names) });
  assert.deepEqual(await loadLocalMaps(store), []);
  assert.deepEqual(calls.map((c) => c[0]), [INDEX]);
  assert.equal(ls._m.size, 0);
  // a listed file that is missing (HTML), junk, not a map, or a 500 does not stop the good one after it
  const ls2 = memStorage(), store2 = await freshStore(ls2);
  server({ [INDEX]: index('gone.json', 'junk.json', 'list.json', 'broken.json', 'ok.json'), [U('junk.json')]: '{nope', [U('list.json')]: '[1,2]', [U('broken.json')]: { status: 500, body: 'x' }, [U('ok.json')]: mapText('okmap', 'Jó') });
  const got = await loadLocalMaps(store2);
  assert.deepEqual(got.map((d) => d.name), ['Jó']);
  assert.deepEqual(store2.listCustom().map((e) => e.id), ['okmap']);
  assert.deepEqual(Object.keys(JSON.parse(ls2._m.get(K))), ['ok.json'], 'only the imported file is remembered');
});

test('local maps: a new file is imported once, a second start does not duplicate it, a changed text imports again, a deleted map stays deleted', async () => {
  const ls = memStorage();
  const files = { [INDEX]: index('hopphopp.json'), [U('hopphopp.json')]: mapText('hopphopp', 'HoppHopp') };
  const start = async () => { const store = await freshStore(ls); server(files); return { store, docs: await loadLocalMaps(store) }; };   // (every start = a fresh page load)
  let { store, docs } = await start();
  assert.deepEqual(docs.map((d) => [d.id, d.name]), [['hopphopp', 'HoppHopp']]);
  assert.deepEqual(store.listCustom().map((e) => [e.id, e.name, e.fin]), [['hopphopp', 'HoppHopp', true]], 'a normal saved map with its index info');
  assert.equal(store.lastCustom(), null, 'an import is not "the map edited last"');
  assert.deepEqual(Object.keys(JSON.parse(ls._m.get(K))), ['hopphopp.json']);
  ({ store, docs } = await start());
  assert.deepEqual([docs, store.listCustom().length], [[], 1], 'the second start finds it already imported');
  // the file changed: a new copy with a fresh id, the old one stays
  files[U('hopphopp.json')] = mapText('hopphopp', 'HoppHopp', 9);
  ({ store, docs } = await start());
  assert.equal(docs.length, 1);
  assert.notEqual(docs[0].id, 'hopphopp');
  assert.match(docs[0].id, /^[a-z0-9]{1,24}$/);
  assert.deepEqual(store.listCustom().map((e) => e.name), ['HoppHopp', 'HoppHopp']);
  ({ store, docs } = await start());
  assert.deepEqual([docs, store.listCustom().length], [[], 2], 'and again nothing new');
  // the player deleted them: they do not come back while the file stays the same ...
  for (const e of store.listCustom()) lib.deleteMap(store, e.id);
  ({ store, docs } = await start());
  assert.deepEqual([docs, store.listCustom()], [[], []]);
  // ... but a changed file arrives again
  files[U('hopphopp.json')] = mapText('hopphopp', 'HoppHopp', 10);
  ({ store, docs } = await start());
  assert.deepEqual([docs.length, store.listCustom().length], [1, 1]);
  // a second file is imported next to it, the first one is left alone
  files[INDEX] = index('hopphopp.json', 'masik.json');
  files[U('masik.json')] = mapText('masik', 'Másik');
  ({ store, docs } = await start());
  assert.deepEqual(docs.map((d) => d.name), ['Másik']);
  assert.equal(store.listCustom().length, 2);
});

test('local maps: nothing is fetched or imported when the saved maps are full; the stored record of a broken storage cannot break it', async () => {
  const ls = memStorage(), store = await freshStore(ls);
  for (let i = 0; i < CUSTOM_LIMIT; i++) assert.equal(store.saveCustom({ ...newDoc({ id: 'm' + i, name: 'M' + i }), updated: i }), true);
  const calls = server({ [INDEX]: index('a.json'), [U('a.json')]: mapText('a', 'A') });
  assert.deepEqual(await loadLocalMaps(store), []);
  assert.deepEqual(calls.map((c) => c[0]), [INDEX], 'only the index; the file is not even fetched');
  assert.equal(store.listCustom().length, CUSTOM_LIMIT);
  // a record that is not an object is replaced, not trusted
  for (const junk of ['"text"', '[1]', '7', '{bad']) {
    const ls2 = memStorage({ [K]: junk }), s2 = await freshStore(ls2);
    server({ [INDEX]: index('a.json'), [U('a.json')]: mapText('a', 'A') });
    assert.deepEqual((await loadLocalMaps(s2)).map((d) => d.id), ['a'], junk);
    assert.deepEqual(Object.keys(JSON.parse(ls2._m.get(K))), ['a.json'], junk);
  }
});
