// nostr.js: keys, event id + signature, verification, the plausibility filter, ranking / dedupe, publishing, robustness, cache.
// Mock relays only (support.mjs makeRelays); a guard WebSocket makes any test that forgets to inject one fail instead of dialling out.
import * as secp from '@noble/secp256k1';
import { test, assert, setGlobal } from './harness.mjs';
import { guardWebSocket, memStorage, brokenStorage, makeRelays, forge, sha256Hex, eventIdOf, bytesToHex, hexToBytes } from './support.mjs';
import { course } from './synth.mjs';
import { World } from '../sim/world.js';
import { RouteRunner } from '../sim/bot.js';
import { encodeGhost, toB64 } from '../sim/ghost.js';
import { mulberry32 } from '../sim/math.js';
import { SIM_VER, TICK } from '../sim/const.js';

guardWebSocket();   // (nostr.js reads globalThis.WebSocket at import time)

const N = await import('../nostr.js');
let freshN = 0;
const fresh = () => import('../nostr.js?fresh=' + (++freshN));   // a new module instance: empty key / cache / transport

const INFO = { id: 'alpha', hash: 'hash-alpha', authorTime: 100, cpCount: 3 };    // fastest credible time: minTicks = ceil(0.5 x 100 s x 120) = 6000 ticks
const INFO2 = { id: 'beta', hash: 'hash-beta', authorTime: 60, cpCount: 2 };
const MIN = N.minTicks(INFO.authorTime);
const okRelay = (events = []) => ({ mode: 'ok', events });
const useRelays = (spec, mod = N, extra = {}) => {
  const r = makeRelays(spec);
  mod.__setTransport({ WS: r.WS, relays: r.urls, now: () => Date.now(), ...extra });
  mod.clearCache();
  return r;
};

test('nostr keys: made once and stored, a corrupt stored key is replaced, blocked storage still gives a working key', async () => {
  const ls = memStorage(); setGlobal('localStorage', ls);
  const k1 = (await fresh()).getKeys();
  assert.match(k1.pk, /^[0-9a-f]{64}$/);
  const stored = ls.getItem('pajzsugras:nostr-sk');
  assert.match(stored, /^[0-9a-f]{64}$/);
  assert.equal(bytesToHex(secp.schnorr.getPublicKey(hexToBytes(stored))), k1.pk, 'the stored secret belongs to the public key');
  assert.equal((await fresh()).getKeys().pk, k1.pk, 'next page load: the same key');
  for (const bad of ['not hex', '0'.repeat(64), 'f'.repeat(64)]) {   // not hex / zero / above the curve order
    ls.setItem('pajzsugras:nostr-sk', bad);
    const k = (await fresh()).getKeys();
    assert.match(k.pk, /^[0-9a-f]{64}$/, `key made despite stored "${bad.slice(0, 8)}"`);
    assert.notEqual(ls.getItem('pajzsugras:nostr-sk'), bad, 'the bad key was replaced');
  }
  setGlobal('localStorage', brokenStorage());
  const n = await fresh();
  assert.match(n.getKeys().pk, /^[0-9a-f]{64}$/, 'storage blocked: a session key');
  assert.equal(n.getKeys().pk, n.getKeys().pk, '... that stays the same during the session');
});

test('nostr event: NIP-01 id (checked independently), valid BIP-340 signature, cleaned name; tampered / re-keyed / garbage copies do not verify', async () => {
  setGlobal('localStorage', memStorage());
  const n = await fresh();
  n.__setTransport({ now: () => 1700000123456 });
  const ev = await n.buildEvent(INFO, { ticks: 12600, splits: [4000, 8000, 12000], name: '  <b>Ev\u0007il</b> ' + 'x'.repeat(30) });
  assert.equal(ev.kind, 30078);
  assert.equal(ev.created_at, 1700000123);
  assert.deepEqual(ev.tags, [['d', 'pajzsugras-v1:alpha:hash-alpha'], ['t', 'pajzsugras']]);
  const c = JSON.parse(ev.content);
  assert.deepEqual([c.ticks, c.time, c.ver, c.splits], [12600, 105, SIM_VER, [4000, 8000, 12000]]);
  assert.ok(c.name.length <= 16 && !/[<>\u0000-\u001f]/.test(c.name) && c.name.startsWith('bEvil'), 'name cleaned and cut: ' + c.name);
  assert.ok(!('ghost' in c), 'no ghost, no ghost key');
  assert.equal(ev.id, sha256Hex(JSON.stringify([0, ev.pubkey, 1700000123, 30078, ev.tags, ev.content])), 'id = sha256 of the NIP-01 serialisation');
  assert.ok(await secp.schnorr.verifyAsync(hexToBytes(ev.sig), hexToBytes(ev.id), hexToBytes(ev.pubkey)), 'the signature is a plain BIP-340 one');
  assert.equal(await n.verifyEvent(ev), true);
  assert.equal(JSON.parse((await n.buildEvent(INFO, { ticks: 12600, splits: [1, 2, 3], name: ' <> ' })).content).name, 'Játékos', 'an empty name falls back');

  const other = (await forge(INFO, { name: 'Other' })).ev;
  const attacker = secp.utils.randomSecretKey(), attackerPk = bytesToHex(secp.schnorr.getPublicKey(attacker));
  const rekeyed = { ...ev, pubkey: attackerPk }; rekeyed.id = eventIdOf(rekeyed);   // a consistent id, but the signature is still the original author's
  const bad = {
    'content changed': { ...ev, content: ev.content.replace('12600', '9600') },
    'foreign signature': { ...ev, sig: other.sig },
    're-keyed to another pubkey': rekeyed,
    'garbage signature': { ...ev, sig: 'zz' },
    'empty object': {},
  };
  for (const [what, e] of Object.entries(bad)) assert.equal(await n.verifyEvent(e), false, what + ' must not verify');
});

test('nostr plausibility filter: wrong version / too fast / bad splits (equal ones are fine) / empty name / other map hash / forged signature dropped, boundary kept, name cleaned', async () => {
  const victim = await forge(INFO, { ticks: 13000, name: 'Victim' });
  const events = [
    (await forge(INFO, { ticks: MIN, name: 'Edge' })).ev,                                              // exactly minTicks: credible
    (await forge(INFO, { ticks: 12600, name: 'Good' })).ev,
    (await forge(INFO, { ticks: 12700, name: '<b>' + 'X'.repeat(40) + '\u0007' })).ev,                  // kept, name cleaned and cut to 16
    victim.ev,
    (await forge(INFO, { ticks: MIN - 1, name: 'TooFast' })).ev,
    (await forge(INFO, { ticks: 12600, ver: SIM_VER + 1, name: 'Version' })).ev,
    (await forge(INFO, { ticks: 12600, splits: [4000, 8000], name: 'FewSplits' })).ev,                  // wrong count
    (await forge(INFO, { ticks: 12600, splits: [4000, 4000, 9000], name: 'EqualSplits' })).ev,         // equal consecutive splits are fine: two checkpoints can be reached in one tick
    (await forge(INFO, { ticks: 12600, splits: [4000, 3999, 9000], name: 'DecreasingSplits' })).ev,    // going back in time is not
    (await forge(INFO, { ticks: 12600, splits: [4000, 8000, 12601], name: 'BeyondTicks' })).ev,       // a split after the finish
    (await forge(INFO, { ticks: 12600, name: '   ' })).ev,
    (await forge(INFO, { ticks: 12600, hash: 'older-build', name: 'OtherHash' })).ev,                  // a different map version
    (await forge(INFO, { ticks: MIN, name: 'Shadow', pubkey: victim.pk })).ev,                         // claims the victim's key, signed with its own: fast, forged
  ];
  useRelays({ a: okRelay(events), b: okRelay([]) });
  const res = await N.queryBoards([INFO, INFO2], { timeout: 400 });
  assert.equal(res.ok, true);
  assert.deepEqual(res.boards.alpha.top.map((e) => e.name), ['Edge', 'Good', 'EqualSplits', 'b' + 'X'.repeat(15), 'Victim'],
    'accepted, in order (the forged faster event under the victim\'s key must not take the victim\'s place)');
  assert.deepEqual(res.boards.alpha.top.map((e) => e.ticks), [MIN, 12600, 12600, 12700, 13000]);
  assert.equal(res.boards.beta.top.length, 0, 'nothing for the other map');
  assert.equal(res.boards.alpha.total, 5);
});

test('nostr query: a relay that answers first with a forged copy carrying a real event\'s id must not hide the real record', async () => {
  const victim = await forge(INFO, { ticks: 12600, name: 'Victim' });
  // same id, pubkey and signature as the victim's event, other content: its id no longer matches, so it cannot verify
  const forged = { ...victim.ev, content: JSON.stringify({ ...JSON.parse(victim.ev.content), ticks: MIN, name: 'Forged' }) };
  useRelays({ bad: okRelay([forged]), good: okRelay([victim.ev]) });
  const top = (await N.queryBoards([INFO], { timeout: 400 })).boards.alpha.top;
  assert.deepEqual(top.map((e) => e.name), ['Victim'], 'the real record must be listed (nostr.js queryRelay keeps the FIRST event per claimed id, before any verification)');
});

test('nostr query: one REQ per relay with one filter per map, each with its own limit (a busy map cannot push the records of another out)', async () => {
  const r = useRelays({ a: okRelay([(await forge(INFO, { name: 'A1' })).ev, (await forge(INFO2, { name: 'B1' })).ev]) });
  const res = await N.queryBoards([INFO, INFO2], { timeout: 400 });
  assert.equal(r.st.reqs, 1, 'one REQ');
  assert.deepEqual(r.st.filters.map((f) => [f['#d'], f.limit]), [[['pajzsugras-v1:alpha:hash-alpha'], 300], [['pajzsugras-v1:beta:hash-beta'], 300]]);
  assert.deepEqual([res.boards.alpha.top.map((e) => e.name), res.boards.beta.top.map((e) => e.name)], [['A1'], ['B1']]);
});

test('nostr ranking: sorted, one entry per key (the lowest across relays), tie -> earlier first, top 50 plus my own rank, ghost only on rank 1', async () => {
  setGlobal('localStorage', memStorage());
  const r1 = okRelay(), r2 = okRelay();
  for (let i = 0; i < 55; i++) {
    const { ev } = await forge(INFO, { ticks: 9700 + i * 10, name: 'P' + i, created: 1700000000 + i, ghost: i === 0 ? 'QUJD' : undefined });
    (i % 2 ? r1 : r2).events.push(ev);
    if (i % 5 === 0) (i % 2 ? r2 : r1).events.push(ev);   // some are on both relays
  }
  const dup = await forge(INFO, { ticks: 9650, name: 'Dup', ghost: 'WFla' });
  r1.events.push(dup.ev);
  r2.events.push((await forge(INFO, { sk: dup.sk, ticks: 99999, name: 'DupSlow', created: 1800000000 })).ev);   // the same key, a slower record, on another relay
  r1.events.push((await forge(INFO, { ticks: 9710, name: 'Tie', created: 1699999999 })).ev);                      // same ticks as P1, but older
  r1.events.push(await N.buildEvent(INFO, { ticks: 20000, splits: [5000, 10000, 15000], name: 'Me' }));          // my own, slower than all 57 others
  useRelays({ r1, r2 });
  const b = (await N.queryBoards([INFO], { timeout: 400 })).boards.alpha;
  assert.equal(b.top.length, 50);
  assert.deepEqual(b.top.map((e) => e.ticks), b.top.map((e) => e.ticks).slice().sort((x, y) => x - y), 'sorted by ticks');
  assert.equal(new Set(b.top.map((e) => e.pk)).size, 50, 'one entry per key');
  assert.deepEqual([b.top[0].name, b.top[0].ticks], ['Dup', 9650], 'the lowest of a key\'s records counts, whichever relay it came from');
  assert.ok(!b.top.some((e) => e.name === 'DupSlow'));
  assert.ok(b.top.findIndex((e) => e.name === 'Tie') < b.top.findIndex((e) => e.name === 'P1'), 'equal ticks: the older record first');
  assert.equal(b.top[0].ghost, 'WFla');
  assert.ok(b.top.slice(1).every((e) => e.ghost === null), 'only rank 1 carries its ghost (P0 had one, rank 2)');
  assert.ok(b.me && b.me.mine && b.me.name === 'Me' && b.me.ticks === 20000 && b.me.rank === 58, 'my rank outside the top 50: ' + JSON.stringify(b.me && { rank: b.me.rank }));
  assert.equal(b.total, 58);
});

test('nostr publish: counts the relays that said OK and waits at most the timeout; a ghost over 16 kB is dropped but the record is still sent', async () => {
  setGlobal('localStorage', memStorage());
  useRelays({ a: okRelay(), b: okRelay(), c: { mode: 'down', events: [] }, d: { mode: 'mute', events: [] }, e: { mode: 'reject', events: [] } });
  const ev = await N.buildEvent(INFO, { ticks: 12600, splits: [4000, 8000, 12000], name: 'Pub' });
  const t0 = performance.now();
  const res = await N.publishEvent(ev, { timeout: 300 });
  assert.deepEqual(res, { accepted: 2, total: 5 });
  assert.ok(performance.now() - t0 < 1500, 'a mute relay holds the publish up for the timeout, not longer');
  // noise does not deflate: 3000 frames of random positions are far over 16 kB of base64
  const rng = mulberry32(7), n = 6000, data = [];
  for (let i = 0; i < n; i++) data.push(rng() * 300, rng() * 300, rng() * 300, (rng() - 0.5) * 6, rng() - 0.5);
  const big = toB64(encodeGhost({ every: 6, n, data }));
  useRelays({ a: okRelay(), b: okRelay(), c: { mode: 'down', events: [] }, e: { mode: 'reject', events: [] } });
  const pub = await N.publishPB(INFO, { ticks: 12600, splits: [4000, 8000, 12000], name: 'Big', ghost: big });
  assert.equal(pub.ok, true); assert.equal(pub.accepted, 2);
  assert.ok(!('ghost' in JSON.parse(pub.event.content)), 'the oversize ghost was left out');
  useRelays({ a: { mode: 'down', events: [] }, b: { mode: 'reject', events: [] } });
  const none = await N.publishPB(INFO, { ticks: 12600, splits: [4000, 8000, 12000], name: 'Nobody' });
  assert.equal(none.ok, false);
  assert.equal(none.accepted, 0);
});

test('nostr query: junk frames, mute and dead relays do not break it; all dead / no WebSocket / no crypto answer offline or crypto, never throw', async () => {
  const real = (await forge(INFO, { name: 'Real' })).ev;
  useRelays({ junk: { mode: 'garbage', events: [real] }, mute: { mode: 'mute', events: [] }, dead: { mode: 'down', events: [] }, ok: okRelay([]) });
  const res = await N.queryBoards([INFO, INFO2], { timeout: 300 });
  assert.equal(res.ok, true);
  assert.equal(res.relays, 2, 'two relays reached EOSE');
  assert.deepEqual(res.boards.alpha.top.map((e) => e.name), ['Real']);
  useRelays({ a: { mode: 'down', events: [] }, b: { mode: 'down', events: [] } });
  const off = await N.queryBoards([INFO], { timeout: 300 });
  assert.deepEqual([off.ok, off.error], [false, 'offline']);
  N.__setTransport({ WS: undefined });
  assert.equal((await N.queryBoards([INFO], { timeout: 300 })).error, 'offline', 'no WebSocket');
  N.__setTransport({ WS: class { constructor() { throw new Error('blocked by CSP'); } }, relays: ['wss://x'] });
  assert.equal((await N.queryBoards([INFO], { timeout: 300 })).error, 'offline', 'WebSocket constructor throws');
  setGlobal('crypto', {});   // an insecure (http) page has no crypto.subtle
  assert.equal(N.hasCrypto(), false);
  assert.equal((await N.queryBoards([INFO], { timeout: 300 })).error, 'crypto');
  const pub = await N.publishPB(INFO, { ticks: 12600, splits: [1, 2, 3], name: 'x' });
  assert.deepEqual([pub.ok, pub.error], [false, 'crypto']);
});

test('nostr cache: 5 minutes in memory + sessionStorage, concurrent callers share one query, 30 s back-off after a failure, force bypasses', async () => {
  const ss = memStorage(); setGlobal('sessionStorage', ss);
  const maps = [INFO, INFO2];
  let clock = 1700000000000;
  const g = (await forge(INFO, { name: 'Cached' })).ev;
  const r = makeRelays({ a: okRelay([g]), b: okRelay([g]) });
  const setT = (m) => m.__setTransport({ WS: r.WS, relays: r.urls, now: () => clock });
  const n = await fresh(); setT(n);
  const [x, y] = await Promise.all([n.getBoards(maps), n.getBoards(maps)]);
  assert.ok(x.ok && y.ok); assert.equal(r.st.reqs, 2, 'two concurrent callers, one REQ per relay');
  const z = await n.getBoards(maps);
  assert.ok(z.cached === true && r.st.reqs === 2, 'second call: from memory');
  assert.ok(ss.getItem('pajzsugras:lb-cache'), 'stored in sessionStorage');
  const reload = await fresh(); setT(reload);
  assert.ok((await reload.getBoards(maps)).cached === true && r.st.reqs === 2, 'after a reload: from sessionStorage');
  assert.ok((await reload.getBoards([INFO])).cached !== true, 'another set of maps is another cache entry');
  const after = r.st.reqs;
  clock += 5 * 60 * 1000 + 1;
  assert.ok((await reload.getBoards(maps)).cached !== true && r.st.reqs > after, 'expired after 5 minutes');
  const before = r.st.reqs;
  await reload.getBoards(maps, { force: true });
  assert.ok(r.st.reqs > before, 'force goes to the relays');
  ss.setItem('pajzsugras:lb-cache', '{oops, not json');
  const corrupt = await fresh(); setT(corrupt);
  assert.equal((await corrupt.getBoards(maps)).ok, true, 'a corrupt session cache is ignored');
  // failure back-off
  setGlobal('sessionStorage', memStorage());
  const d = makeRelays({ a: { mode: 'down', events: [] }, b: { mode: 'down', events: [] } });
  const f = await fresh(); f.__setTransport({ WS: d.WS, relays: d.urls, now: () => clock });
  assert.equal((await f.getBoards(maps)).ok, false);
  const c1 = d.st.connects;
  assert.equal((await f.getBoards(maps)).ok, false);
  assert.equal(d.st.connects, c1, 'no hammering right after a failure');
  clock += 31000;
  await f.getBoards(maps);
  assert.ok(d.st.connects > c1, 'tries again after 30 s');
});

test('nostr + sim: the proof route of a synthetic course, published as a PB, passes the plausibility filter; the packed ghost unpacks', async () => {
  setGlobal('localStorage', memStorage()); setGlobal('sessionStorage', memStorage());
  const map = course();
  const info = { id: map.meta.id, hash: map.mapHash, authorTime: map.meta.authorTime, cpCount: map.checkpoints.length };
  const w = new World(map), res = new RouteRunner(w, map.route).run();
  assert.ok(res.ok, 'the route finishes');
  assert.ok(Math.abs(res.ticks - info.authorTime * TICK) < 1, 'the author time is the route\'s');
  useRelays({ a: okRelay(), b: okRelay() });
  const pub = await N.publishPB(info, { ticks: res.ticks, splits: w.splits.slice(), name: 'Bot', ghost: toB64(encodeGhost(w.ghostData())) });
  assert.ok(pub.ok, 'published');
  const top = (await N.queryBoards([info], { timeout: 300 })).boards[info.id].top;
  assert.equal(top.length, 1, `the record is listed (ticks ${res.ticks}, author ${(info.authorTime * TICK).toFixed(0)}, splits ${w.splits.join(',')})`);
  assert.ok(top[0].mine && top[0].ticks === res.ticks && top[0].splits.join() === w.splits.join());
  const g = await N.unpackGhost(top[0].ghost);
  assert.ok(g && g.n > 10 && g.every === 12, 'ghost unpacks');
  // a time under half the author time is not credible
  useRelays({ a: okRelay(), b: okRelay() });
  await N.publishPB({ ...info, id: 'fast' }, { ticks: Math.floor(res.ticks / 2) - 1, splits: w.splits.map((t) => Math.floor(t / 4)), name: 'Bot' });
  assert.equal((await N.queryBoards([{ ...info, id: 'fast', authorTime: info.authorTime }], { timeout: 300 })).boards.fast.top.length, 0, 'below half the author time: not credible');
});

test('nostr: a map without an author time (an export of the editor) has a fixed plausibility floor of 3 s: minTicks, the board filter', async () => {
  assert.equal(N.minTicks(0), 3 * TICK); assert.equal(N.minTicks(undefined), 3 * TICK); assert.equal(N.minTicks(NaN), 3 * TICK);
  assert.equal(N.minTicks(100), 6000, 'maps with an author time are unchanged');
  setGlobal('localStorage', memStorage()); setGlobal('sessionStorage', memStorage());
  const info = { id: 'exported', hash: 'hash-exported', authorTime: 0, cpCount: 0 };
  for (const [ticks, listed] of [[2 * TICK, false], [3 * TICK - 1, false], [3 * TICK, true], [40 * TICK, true]]) {
    useRelays({ a: okRelay(), b: okRelay() });
    await N.publishPB(info, { ticks, splits: [], name: 'Bot' });
    const top = (await N.queryBoards([info], { timeout: 300 })).boards[info.id].top;
    assert.equal(top.length, listed ? 1 : 0, `${ticks} ticks (${(ticks / TICK).toFixed(2)} s): ${listed ? 'credible' : 'under the floor'}`);
  }
});

test('nostr: the geometric floor of a map without an author time - minTicks(0, floor) is max(3 s, floor), an author time ignores it, junk is no floor; the board drops a record under it', async () => {
  assert.equal(N.minTicks(0, 10), 10 * TICK); assert.equal(N.minTicks(undefined, 10.5), Math.ceil(10.5 * TICK));
  assert.equal(N.minTicks(0, 1), 3 * TICK, 'a short way: the 3 s floor stays');
  for (const junk of [NaN, Infinity, -5, undefined, null, 'x']) assert.equal(N.minTicks(0, junk), 3 * TICK, String(junk));
  assert.equal(N.minTicks(100, 999), 6000, 'a proof route decides alone');
  setGlobal('localStorage', memStorage()); setGlobal('sessionStorage', memStorage());
  const info = { id: 'far', hash: 'hash-far', authorTime: 0, cpCount: 0, floor: 10 };   // a finish about 300 m away
  for (const [ticks, listed] of [[3 * TICK, false], [10 * TICK - 1, false], [10 * TICK, true], [40 * TICK, true]]) {
    useRelays({ a: okRelay(), b: okRelay() });
    await N.publishPB(info, { ticks, splits: [], name: 'Bot' });
    const top = (await N.queryBoards([info], { timeout: 300 })).boards[info.id].top;
    assert.equal(top.length, listed ? 1 : 0, `${ticks} ticks: ${listed ? 'credible' : 'under the geometric floor'}`);
  }
});

test('nostr: sanitizeName strips controls, DEL / C1, line separators and bidi overrides as well as markup', async () => {
  const bad = [0x1, 0x7f, 0x85, 0x9f, 0x2028, 0x2029, 0x202a, 0x202e, 0x2066, 0x2069].map((c) => String.fromCharCode(c)).join('');
  assert.equal(N.sanitizeName('A' + bad + 'B<i>C'), 'ABiC');
  assert.equal(N.sanitizeName(bad + '  '), '', 'nothing left: the entry is dropped');
  assert.equal(N.sanitizeName('Ünicode név ő'), 'Ünicode név ő', 'ordinary text is untouched');
});
