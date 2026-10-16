// net.js + race.js: room codes, sticky host, lobby / start / cp / fin / end, countdown, race end rules, points, host hand-over,
// 8-player cap, messages from the wrong peer. A virtual clock (setTimeout / setInterval / performance.now) makes a 5 minute race take
// milliseconds; trystero is a mock room (trystero-mock.mjs) that the test drives like a remote peer: its id is always 'mmmm'.
import { test, assert } from './harness.mjs';
import * as TM from './trystero-mock.mjs';
import { installClock, installDom, fakeMaps, DIFF_LABEL } from './support.mjs';
import { RaceRoom, isCode, cleanCode, randomCode, selfId } from '../net.js';

const { initRace } = await import('../race.js');

function makeApp(mapId) {
  const maps = fakeMaps(), L = new Map(), calls = [], figs = new Map(), centers = [], stands = [], toasts = [];
  const hashOf = (id) => (maps.has(id) ? 'hash-' + id : null);
  const app = {
    maps, DIFF_LABEL, settings: { name: 'Teszt' }, local: { name: 'Teszt' }, mapId, get mapHash() { return hashOf(app.mapId); },
    mode: 'solo', state: 'menu', pauseFreezes: true, allow: { restart: true, respawn: true },
    world: { ps: { pos: [1, 2, 3], yaw: 0.5, pitch: 0.1 }, cpIndex: 0, playerFlags: () => 1 },
    calls, figs, centers, stands, toasts, mapHashOf: hashOf,
    loadMap: async (id) => { calls.push(['loadMap', id]); app.mapId = id; },
    restartRun: (o) => calls.push(['restartRun', o]), startRun: () => calls.push(['startRun']), setFrozen: (b) => calls.push(['setFrozen', b]),
    setMode: (m) => { app.mode = m; }, play: () => { calls.push(['play']); app.state = 'playing'; }, setSetting: (k, v) => { app.settings[k] = v; },
    showScreen: (id) => { app.ui.current = id; app.emit('screen', { id }); },
    on: (t, cb) => { if (!L.has(t)) L.set(t, new Set()); L.get(t).add(cb); return () => L.get(t).delete(cb); },
    emit: (t, p = {}) => { for (const cb of [...(L.get(t) || [])]) cb(p); },
    figures: { upsert: (id, o) => figs.set(id, o), remove: (id) => figs.delete(id), has: (id) => figs.has(id) },
    hud: { center: (m, o) => centers.push([m, o && o.kind]), standings: (l) => stands.push(l) },
    ui: { current: 'menu', toast: (m) => toasts.push(m) }, audio: { unlock() {} }, input: { lock: () => Promise.resolve(true) },
  };
  return app;
}

// one race scenario: a fresh app + race module state + virtual clock; `peer(id)` plays a remote player
async function scenario(fn, { mapId = 'alpha', ui = 'menu' } = {}) {
  TM.reset();
  const clock = installClock();
  const dom = installDom();
  const app = makeApp(mapId);
  app.ui.current = ui;
  initRace(app);
  const room = () => TM.rooms[TM.rooms.length - 1];
  const out = (type, from = 0) => TM.sent.slice(from).filter((m) => m.type === type);
  const peer = (id) => ({
    id,
    join: () => room().onPeerJoin(id),
    hello: (name = id, mh = 'hash-' + app.mapId, host = '') => room().actions.hello.onMessage({ name, mh, host }, { peerId: id }),
    say: (type, data) => room().actions[type].onMessage(data, { peerId: id }),
    leave: () => room().onPeerLeave(id),
  });
  const joined = (id, name) => { const p = peer(id); p.join(); p.hello(name || id); return p; };
  const toGo = async (R) => { R.start(); await clock.settle(); await clock.advance(3500); assert.equal(R.phase, 'race', 'GO'); };   // host: start + countdown
  const finish = (ticks, mapId2 = app.mapId) => app.emit('finish', { mapId: mapId2, ticks, time: ticks / 120, splits: [] });
  try { await fn({ app, R: app.race, clock, dom, room, out, mark: () => TM.sent.length, peer, joined, toGo, finish }); } finally { try { app.emit('exit'); } catch { /* already left */ } }
}
// a guest that has synced with host 'aaaa' (players: aaaa, mmmm and the extra ids)
function guestOf(h, extra = []) {
  const a = h.peer('aaaa'); a.join(); a.hello('Alpha', undefined, 'aaaa');
  const players = [['aaaa', 'Alpha', 0, 'hash-alpha'], ['mmmm', 'Teszt', 1, 'hash-alpha'], ...extra.map((id, i) => [id, id, 2 + i, 'hash-alpha'])];
  a.say('lobby', { host: 'aaaa', mapId: 'alpha', mapHash: 'hash-alpha', phase: 'lobby', raceNo: 0, players, totals: {} });
  return a;
}
const startMsg = (no = 1, mapId = 'alpha') => ({ raceNo: no, mapId, mapHash: 'hash-' + mapId, delayMs: 3500 });
// the lobby message of a host named `host` whose roster is `ids` (in that order, one slot each)
const lobbyOf = (host, ids, o = {}) => ({ host, mapId: 'alpha', mapHash: 'hash-alpha', phase: 'lobby', raceNo: 0, players: ids.map((id, i) => [id, id, i, 'hash-alpha']), totals: {}, ...o });

test('net: room codes avoid I and O, the host is sticky (a lower id joining does not take it), an unknown peer\'s message joins it, sending to nobody is a no-op, leave clears', () => {
  TM.reset();
  assert.ok(isCode('ABCD') && !isCode('ABCI') && !isCode('ABCO') && !isCode('abcd') && !isCode('ABC') && !isCode('ABCDE'));
  assert.equal(cleanCode(' a-b o i c d e '), 'ABCD');
  for (let i = 0; i < 200; i++) assert.ok(isCode(randomCode()), 'random code');
  const room = new RaceRoom('ABCD');
  assert.equal(TM.rooms[0].cfg.appId, 'pajzsugras-v1');
  assert.equal(room.isHost, true, 'alone: host');
  room.send('hello', { name: 'x' });
  assert.equal(TM.sent.length, 0, 'nobody to send to');
  const joins = []; room.onJoin = (id) => joins.push(id);
  const got = []; room.on('hello', (d, id) => got.push([d.name, id]));
  TM.rooms[0].actions.hello.onMessage({ name: 'Zed' }, { peerId: 'zzzz' });      // no onPeerJoin first: the message itself introduces the peer
  TM.rooms[0].actions.hello.onMessage({ name: 'Zed' }, { peerId: 'zzzz' });
  assert.deepEqual([joins, got.length], [['zzzz'], 2]);
  assert.equal(room.hostId, 'mmmm'); assert.equal(room.isHost, true, 'the first member keeps it');
  TM.rooms[0].onPeerJoin('aaaa');
  assert.deepEqual([room.hostId, room.isHost], ['mmmm', true], 'a lower id joining does not take it over');
  room.send('lobby', { a: 1 }, 'aaaa');
  assert.deepEqual(TM.sent[0], { type: 'lobby', data: { a: 1 }, target: 'aaaa' });
  room.follow('zzzz');
  assert.deepEqual([room.hostId, room.isHost], ['zzzz', false], 'a joiner follows the announced host');
  TM.rooms[0].onPeerLeave('zzzz');
  assert.equal(room.elect(['zzzz', 'mmmm', 'qqqq']), 'mmmm', 'the host left: the lowest connected id of the pool (zzzz is gone, aaaa is not in the pool)');
  assert.equal(room.elect(['zzzz']), 'aaaa', 'nobody of the pool is here: the lowest of everybody');
  room.leave();
  assert.ok(TM.rooms[0].left && room.peers.size === 0);
  assert.equal(selfId, 'mmmm');
});

test('race (host): warm-up -> 3.5 s countdown -> GO -> finish -> results 10 / 8 points -> warm-up after 8 s; totals add up over two races', async () => {
  await scenario(async ({ app, R, clock, dom, out, mark, joined, toGo, finish }) => {
    R.enter('ABCD', true);
    assert.ok(R.synced && app.mode === 'room' && R.phase === 'lobby');
    const z = joined('zzzz', 'Zed');
    assert.deepEqual(R.roster.map((p) => [p.id, p.name, p.slot]), [['mmmm', 'Teszt', 0], ['zzzz', 'Zed', 1]]);
    assert.ok(out('lobby').some((m) => m.target === 'zzzz'), 'the newcomer is told the room state');
    let m0 = mark(); app.calls.length = 0; app.centers.length = 0;
    R.start(); await clock.settle();
    assert.deepEqual(out('start', m0)[0].data, { raceNo: 1, mapId: 'alpha', mapHash: 'hash-alpha', delayMs: 3500 });
    assert.equal(R.phase, 'count'); assert.equal(app.allow.restart, false, 'Enter must not restart during a race');
    assert.deepEqual(app.calls.find((c) => c[0] === 'restartRun')[1], { frozen: true, autoStart: false });
    await clock.advance(3400); assert.equal(R.phase, 'count', 'not before 3.5 s');
    assert.ok(!app.calls.some((c) => c[0] === 'startRun'));
    await clock.advance(100); assert.equal(R.phase, 'race');
    assert.ok(app.calls.some((c) => c[0] === 'startRun') && app.calls.some((c) => c[0] === 'setFrozen' && c[1] === false), 'unfrozen, clock started');
    assert.deepEqual(app.centers.map((c) => c[0]), ['KÉSZÜLJ!', '3', '2', '1', 'INDULJ!']);
    m0 = mark();
    app.emit('cp', { index: 0, count: 2, ticks: 500 });
    assert.deepEqual(out('cp', m0)[0].data, { no: 1, n: 1, ticks: 500 });
    z.say('cp', { no: 1, n: 2, ticks: 900 });
    assert.deepEqual(app.stands.at(-1).map((r) => r.name), ['Zed', 'Teszt'], 'live standings: more checkpoints first');
    finish(9000);
    assert.deepEqual(out('fin', m0)[0].data.ticks, 9000);
    assert.equal(R.phase, 'race', 'Zed is still running');
    z.say('fin', { no: 1, ticks: 9500, splits: [] });
    assert.equal(R.phase, 'results', 'everyone finished');
    const end = out('end', m0)[0].data;
    assert.deepEqual(end.results, [['mmmm', 9000, 2, 1, 10], ['zzzz', 9500, 2, 2, 8]]);
    assert.deepEqual(end.totals, { mmmm: 10, zzzz: 8 });
    assert.deepEqual(app.stands.at(-1), null, 'standings cleared');
    const board = dom.els.get('race-hud').querySelector('.mp-board');
    assert.ok(!board.hidden && board.innerHTML.includes('Futam vége') && board.innerHTML.includes('+10') && board.innerHTML.includes('+8'), 'results overlay');
    await clock.advance(7900); assert.equal(R.phase, 'results', 'results stay up ~8 s');
    await clock.advance(400); assert.equal(R.phase, 'lobby');
    assert.equal(out('lobby').at(-1).data.phase, 'lobby'); assert.equal(app.allow.restart, true);
    // race 2: Zed wins; the points accumulate
    await toGo(R); assert.equal(R.race.no, 2);
    z.say('cp', { no: 2, n: 2, ticks: 7900 }); z.say('fin', { no: 2, ticks: 8000, splits: [] }); finish(8500);
    assert.deepEqual(out('end').at(-1).data.totals, { mmmm: 18, zzzz: 18 });
  });
});

test('race (host): a player who leaves mid-race cannot stall it - it closes once the rest are done, the leaver gets no row', async () => {
  await scenario(async ({ app, R, clock, out, joined, toGo, finish }) => {
    R.enter('ABCD', true);
    const z = joined('zzzz'), q = joined('qqqq');
    await toGo(R);
    q.say('cp', { no: 1, n: 1, ticks: 400 });
    finish(9000); z.say('cp', { no: 1, n: 2, ticks: 9400 }); z.say('fin', { no: 1, ticks: 9500, splits: [] });
    assert.equal(R.phase, 'race', 'qqqq is still running');
    q.say('st', [100, 50, 200, 157, 0, 1, 1]); await clock.advance(100);
    assert.ok(app.figs.has('p:qqqq'), 'its figure is on screen');
    q.leave();
    await clock.advance(300);
    assert.equal(R.phase, 'results', 'the next slow tick closes the race');
    assert.deepEqual(out('end')[0].data.results, [['mmmm', 9000, 2, 1, 10], ['zzzz', 9500, 2, 2, 8]]);
    assert.ok(!app.figs.has('p:qqqq'), 'its figure is gone');
  });
});

test('race (host): 60 s after the first finisher the race is cut; ties share the place (10, 10, 6); DNFs order by checkpoints and score 0', async () => {
  await scenario(async ({ app, R, clock, dom, out, joined, toGo, finish }) => {
    R.enter('ABCD', true);
    const q = joined('qqqq'), r = joined('rrrr'), s = joined('ssss'), z = joined('zzzz');
    await toGo(R);
    await clock.advance(30000);
    finish(9000);                                         // the first finisher: the 60 s run from here
    z.say('cp', { no: 1, n: 2, ticks: 8900 }); s.say('cp', { no: 1, n: 2, ticks: 9400 });
    z.say('fin', { no: 1, ticks: 9000, splits: [] });     // the same time as mine
    s.say('fin', { no: 1, ticks: 9500, splits: [] });
    r.say('cp', { no: 1, n: 2, ticks: 800 }); q.say('cp', { no: 1, n: 1, ticks: 400 });
    await clock.advance(59700);
    assert.equal(R.phase, 'race', '59.7 s after the first finisher: still on');
    await clock.advance(600);
    assert.equal(R.phase, 'results', '60 s: over');
    const end = out('end')[0].data;
    assert.deepEqual(end.results, [['mmmm', 9000, 2, 1, 10], ['zzzz', 9000, 2, 1, 10], ['ssss', 9500, 2, 3, 6], ['rrrr', -1, 2, 0, 0], ['qqqq', -1, 1, 0, 0]]);
    assert.deepEqual(end.totals, { mmmm: 10, zzzz: 10, ssss: 6 });
    const html = dom.els.get('race-hud').querySelector('.mp-board').innerHTML;
    assert.equal(html.split('nem ért célba').length - 1, 2, 'both DNFs say so');
    assert.ok(R.totals.qqqq === undefined && R.totals.rrrr === undefined, 'no points for DNF');
  });
});

test('race (host): nobody finishes -> cut at max(180 s, 3 x author time): 180 s on a 40 s map, 300 s on a 100 s map; all DNF, no points', async () => {
  for (const [mapId, cap] of [['alpha', 180], ['beta', 300]]) {
    await scenario(async ({ R, clock, out, joined, toGo }) => {
      R.enter('ABCD', true);
      joined('zzzz');
      await toGo(R);
      await clock.advance(cap * 1000 - 500);
      assert.equal(R.phase, 'race', `${mapId}: ${cap - 0.5} s after GO is still inside the cap`);
      await clock.advance(1000);
      assert.equal(R.phase, 'results', `${mapId}: cut at ${cap} s`);
      const end = out('end')[0].data;
      assert.deepEqual(end.results, [['mmmm', -1, 0, 0, 0], ['zzzz', -1, 0, 0, 0]]);
      assert.deepEqual(end.totals, {});
    }, { mapId });
  }
});

test('race (guest): the host leaves mid-race -> I become host, still close the race and broadcast the results', async () => {
  await scenario(async ({ app, R, clock, out, mark, peer, finish }) => {
    R.enter('ABCD', false);
    const a = guestOf({ peer }, ['zzzz']);
    const z = peer('zzzz'); z.join(); z.hello('Zed');
    assert.ok(R.synced && R.room.isHost === false);
    a.say('start', startMsg()); await clock.settle(); await clock.advance(3500);
    assert.equal(R.phase, 'race');
    a.leave();
    assert.equal(R.room.isHost, true, 'the lowest remaining id is me');
    assert.ok(app.toasts.some((t) => t.includes('házigazda')), 'told so');
    assert.equal(R.phase, 'race', 'the race goes on');
    const m0 = mark();
    finish(9000);
    assert.equal(R.phase, 'race', 'Zed is still running');
    z.say('cp', { no: 1, n: 2, ticks: 9000 }); z.say('fin', { no: 1, ticks: 9100, splits: [] });
    assert.equal(R.phase, 'results', 'the new host closes the race');
    assert.deepEqual(out('end', m0)[0].data.results, [['mmmm', 9000, 2, 1, 10], ['zzzz', 9100, 2, 2, 8]], 'the departed host has no row');
    await clock.advance(8400);
    assert.equal(R.phase, 'lobby', 'and brings everybody back to the warm-up');
    assert.deepEqual(out('lobby', m0).at(-1).data.players.map((p) => p[0]), ['mmmm', 'zzzz'], 'roster without the old host');
  });
});

test('race (guest): only the host sets the lobby, starts or ends a race; outsiders\' cp / fin are ignored, the first fin counts, junk never throws', async () => {
  await scenario(async ({ app, R, clock, peer }) => {
    R.enter('ABCD', false);
    const a = guestOf({ peer }, ['bbbb']);
    const b = peer('bbbb'); b.join(); b.hello('Bela');
    assert.deepEqual(R.roster.map((p) => p.id), ['aaaa', 'mmmm', 'bbbb']);
    for (const claim of ['bbbb', 'aaaa']) {   // a weaker pretender, and one that names the real host as the sender
      b.say('lobby', { host: claim, mapId: 'beta', mapHash: 'hash-beta', phase: 'lobby', raceNo: 0, players: [['bbbb', 'Evil', 0, '']], totals: { bbbb: 999 } });
      assert.deepEqual([R.roster.map((p) => p.id), R.room.hostId], [['aaaa', 'mmmm', 'bbbb'], 'aaaa'], 'a lobby from a non-host is ignored (claiming ' + claim + ')');
    }
    b.say('lobby', { mapId: 'beta', mapHash: 'hash-beta', phase: 'lobby', raceNo: 0, players: [['bbbb', 'Evil', 0, '']], totals: { bbbb: 999 } });
    assert.deepEqual(R.roster.map((p) => p.id), ['aaaa', 'mmmm', 'bbbb'], 'a lobby without a host field is ignored');
    assert.ok(R.totals.bbbb === undefined && !app.calls.some((c) => c[0] === 'loadMap' && c[1] === 'beta'));
    b.say('start', startMsg()); assert.equal(R.phase, 'lobby', 'a start from a non-host is ignored');
    a.say('start', startMsg()); await clock.settle(); await clock.advance(3500);
    assert.equal(R.phase, 'race');
    b.say('end', { no: 1, results: [['bbbb', 1, 2, 1, 10]], totals: { bbbb: 10 } });
    assert.ok(R.phase === 'race' && R.totals.bbbb === undefined, 'an end from a non-host is ignored');
    const c = peer('cccc'); c.join(); c.hello();           // arrived after the start: not an entrant
    c.say('fin', { no: 1, ticks: 100 }); c.say('cp', { no: 1, n: 2, ticks: 100 });
    assert.ok(!R.race.fin.has('cccc') && !R.race.cp.has('cccc'), 'a stranger\'s cp / fin');
    b.say('cp', { no: 1, n: 2, ticks: 8900 });
    for (const bad of [{ no: 7, ticks: 100 }, { no: 1, ticks: -5 }, { no: 1, ticks: NaN }, { no: 1, ticks: 'x' }, { no: 1, ticks: 0 }]) b.say('fin', bad);
    assert.equal(R.race.fin.size, 0, 'wrong race number / absurd ticks');
    b.say('fin', { no: 1, ticks: 9000, splits: [] }); b.say('fin', { no: 1, ticks: 100, splits: [] });
    assert.equal(R.race.fin.get('bbbb'), 9000, 'the first fin counts');
    // junk through every handler, from the host and from a peer
    const junk = [null, undefined, 'x', 42, true, [], {}, { no: NaN }, [NaN, NaN, NaN, NaN, NaN, NaN, NaN], { players: 'x', mapId: 'alpha' }, { results: 7, no: 1 }, { raceNo: 1e12, mapId: 'alpha' }];
    for (const type of ['hello', 'lobby', 'st', 'start', 'cp', 'fin', 'end']) for (const who of [a, b]) for (const j of junk) who.say(type, j);
    assert.equal(R.phase, 'race', 'still racing');
    assert.deepEqual(R.roster.map((p) => p.id), ['aaaa', 'mmmm', 'bbbb']);
    a.say('end', { no: 1, results: [['aaaa', 7000, 2, 1, 10], ['mmmm', -1, 1, 0, 0]], totals: { aaaa: 10 } });
    assert.equal(R.phase, 'results', 'the real end from the host still works');
  });
});

test('race (host): the 9th player is told the room is full and stays out of the roster', async () => {
  await scenario(async ({ R, out, mark, joined }) => {
    R.enter('ABCD', true);
    for (let i = 1; i <= 7; i++) joined('p' + i);
    assert.equal(R.roster.length, 8);
    const m0 = mark();
    joined('q9');
    assert.equal(R.roster.length, 8, 'capped at 8');
    assert.ok(!R.roster.some((p) => p.id === 'q9'));
    assert.ok(out('lobby', m0).some((m) => m.target === 'q9' && m.data.full === true), 'q9 is told the room is full');
  });
});

test('race (host): a 9th player with the LOWEST id must not take the host role from a full room (it is not even on the roster)', async () => {
  await scenario(async ({ R, out, mark, joined }) => {
    R.enter('ABCD', true);
    for (let i = 1; i <= 7; i++) joined('p' + i);
    joined('aaaa');                                       // lower than 'mmmm': the old lowest-id rule would have handed it the host role
    assert.ok(!R.roster.some((p) => p.id === 'aaaa') && R.roster.some((p) => p.id === 'mmmm'), 'roster stays the 8 admitted players');
    const m0 = mark();
    R.start();
    assert.equal(out('start', m0).length, 1, 'the host is still me: the refused lower id took nothing, so I can start the race');
  });
});

test('race (host): the host is sticky - a lower id joining the lobby or mid-race takes nothing; the race ends with results and points, the next lobby admits the spectator', async () => {
  await scenario(async ({ R, clock, out, mark, joined, toGo, finish }) => {
    R.enter('ABCD', true);
    const z = joined('zzzz', 'Zed'), b = joined('bbbb', 'Bela');
    assert.deepEqual([R.room.hostId, R.room.isHost], ['mmmm', true], 'the creator keeps the host role in the lobby');
    assert.ok(R.roster.some((p) => p.id === 'bbbb'), 'the lower id is admitted to the roster');
    b.leave();
    await toGo(R);
    const m0 = mark();
    joined('aaaa', 'Alpha');
    assert.ok(R.room.isHost && R.phase === 'race', 'a lower id joining mid-race changes nothing');
    assert.ok(!R.roster.some((p) => p.id === 'aaaa'), 'it waits as a spectator');
    assert.ok(out('lobby', m0).every((m) => m.data.phase === 'race'), 'nobody is told the race is over');
    finish(9000); z.say('cp', { no: 1, n: 2, ticks: 9400 }); z.say('fin', { no: 1, ticks: 9500, splits: [] });
    assert.equal(R.phase, 'results');
    assert.deepEqual(out('end', m0)[0].data.results, [['mmmm', 9000, 2, 1, 10], ['zzzz', 9500, 2, 2, 8]], 'results and points as if nobody had joined');
    await clock.advance(8400);
    assert.equal(R.phase, 'lobby');
    assert.deepEqual(R.roster.map((p) => p.id), ['mmmm', 'zzzz', 'aaaa'], 'the next lobby admits the spectator');
    assert.equal(R.room.hostId, 'mmmm');
  });
});

test('race (guest): the host leaves mid-race with a lower-id spectator around -> the lowest ENTRANT takes over, the spectator cannot abort the race', async () => {
  await scenario(async ({ R, clock, out, mark, peer, finish }) => {
    R.enter('ABCD', false);
    const a = guestOf({ peer }, ['zzzz']);
    const z = peer('zzzz'); z.join(); z.hello('Zed');
    a.say('start', startMsg()); await clock.settle(); await clock.advance(3500);
    assert.equal(R.phase, 'race');
    const s = peer('bbbb'); s.join(); s.hello('Spectator');   // arrives mid-race, lower than me
    a.leave();
    assert.deepEqual([R.room.hostId, R.room.isHost], ['mmmm', true], 'me (the lowest entrant), not the spectator');
    assert.equal(R.phase, 'race', 'the race goes on');
    const m0 = mark();
    finish(9000); z.say('cp', { no: 1, n: 2, ticks: 9000 }); z.say('fin', { no: 1, ticks: 9100, splits: [] });
    assert.equal(R.phase, 'results');
    assert.deepEqual(out('end', m0)[0].data.results, [['mmmm', 9000, 2, 1, 10], ['zzzz', 9100, 2, 2, 8]]);
    assert.ok(!out('lobby', m0).some((m) => m.data.phase === 'lobby'), 'the race is not aborted by a lobby broadcast');
  });
});

test('race (joiner): times out alone and hosts an empty room, then the real host\'s lobby arrives -> it follows that host, is listed in its roster and stops broadcasting', async () => {
  await scenario(async ({ R, clock, out, mark, peer }) => {
    R.enter('ABCD', false);
    await clock.advance(6900); assert.ok(!R.synced, 'a slow WebRTC setup gets its 7 s');
    await clock.advance(200);
    assert.ok(R.synced && R.room.isHost, 'nobody answered: the host of an empty room');
    const a = peer('aaaa');
    a.say('lobby', lobbyOf('aaaa', ['aaaa', 'bbbb']));   // the link came up late: its lobby is the first thing we hear
    assert.deepEqual([R.room.hostId, R.room.isHost, R.roster.map((p) => p.id)], ['aaaa', false, ['aaaa', 'bbbb']], 'the fuller room wins: I follow it and take its roster');
    assert.equal(out('hello').at(-1).data.host, 'aaaa', 'and say so');
    a.hello('Alpha', 'hash-alpha', 'aaaa');
    a.say('lobby', lobbyOf('aaaa', ['aaaa', 'bbbb', 'mmmm']));   // its next beat admits me
    assert.deepEqual(R.roster.map((p) => p.id), ['aaaa', 'bbbb', 'mmmm'], 'listed in its roster');
    const m0 = mark(); await clock.advance(5000);
    assert.equal(out('lobby', m0).length, 0, 'no lobby broadcasts of my own any more');
    a.say('start', startMsg()); await clock.settle(); await clock.advance(3500);
    assert.equal(R.phase, 'race', 'its race runs here');
  });
});

test('race (two self-made hosts): exactly one yields, whichever message arrives first; they agree on the host afterwards and the winner\'s race runs on both sides', async () => {
  for (const order of ['lobby first', 'hello first']) {
    // aaaa (lower id, same state) outranks me: I yield, follow it, and its race runs here
    await scenario(async ({ R, clock, out, mark, peer }) => {
      R.enter('ABCD', true);
      const a = peer('aaaa');
      if (order === 'lobby first') a.say('lobby', lobbyOf('aaaa', ['aaaa']));
      else { a.join(); a.hello('Alpha', 'hash-alpha', 'aaaa'); a.say('lobby', lobbyOf('aaaa', ['aaaa', 'mmmm'])); }   // (it has admitted me, I have admitted it)
      assert.deepEqual([R.room.hostId, R.room.isHost], ['aaaa', false], order + ': I yield');
      assert.equal(out('hello').at(-1).data.host, 'aaaa', 'and tell my followers');
      a.hello('Alpha', 'hash-alpha', 'aaaa'); a.say('lobby', lobbyOf('aaaa', ['aaaa', 'mmmm']));
      const m0 = mark(); await clock.advance(5000);
      assert.equal(out('lobby', m0).length, 0, 'I stopped broadcasting');
      a.say('start', startMsg()); await clock.settle(); await clock.advance(3500);
      assert.deepEqual([R.phase, R.race.entrants.map((p) => p.id)], ['race', ['aaaa', 'mmmm']], 'the winner\'s race runs here');
    });
    // zzzz (higher id) does not outrank me: I stay host, it is admitted once it follows me, and my race runs for both
    await scenario(async ({ R, out, peer, toGo, finish }) => {
      R.enter('ABCD', true);
      const z = peer('zzzz');
      if (order === 'lobby first') z.say('lobby', lobbyOf('zzzz', ['zzzz']));
      else { z.join(); z.hello('Zed', 'hash-alpha', 'zzzz'); z.say('lobby', lobbyOf('zzzz', ['zzzz', 'mmmm'])); }
      assert.deepEqual([R.room.hostId, R.room.isHost, R.roster.some((p) => p.id === 'zzzz')], ['mmmm', true, order === 'hello first'], order + ': I stay the host');
      z.hello('Zed', 'hash-alpha', 'mmmm');   // it yielded on its side: it follows me now
      assert.deepEqual(R.roster.map((p) => p.id), ['mmmm', 'zzzz'], 'admitted');
      assert.ok(out('lobby').at(-1).data.players.some((p) => p[0] === 'zzzz'), 'and told so');
      await toGo(R);
      z.say('cp', { no: 1, n: 2, ticks: 8900 }); z.say('fin', { no: 1, ticks: 9500, splits: [] });
      assert.equal(R.race.fin.get('zzzz'), 9500, 'my race counts its result');
      finish(9000);
      assert.equal(R.phase, 'results');
      assert.deepEqual(out('end')[0].data.results.map((r) => r[0]), ['mmmm', 'zzzz']);
    });
  }
});

test('race (two self-made hosts): a host that is mid-race wins whatever the ids and its race is not aborted; then the higher race number; the loser drops its race', async () => {
  await scenario(async ({ R, clock, out, mark, joined, peer, toGo, finish }) => {
    R.enter('ABCD', true);
    const z = joined('zzzz', 'Zed');
    await toGo(R);
    const m0 = mark(), a = peer('aaaa');
    a.say('lobby', lobbyOf('aaaa', ['aaaa', 'bbbb', 'cccc']));   // lower id, fuller roster, but only in the lobby
    a.hello('Alpha', 'hash-alpha', 'aaaa');
    assert.ok(R.room.isHost && R.phase === 'race' && !R.roster.some((p) => p.id === 'aaaa'), 'the racing host keeps the room');
    assert.ok(out('lobby', m0).every((m) => m.data.phase === 'race'), 'nobody is told the race is over');
    finish(9000); z.say('cp', { no: 1, n: 2, ticks: 9400 }); z.say('fin', { no: 1, ticks: 9500, splits: [] });
    assert.deepEqual(out('end', m0)[0].data.results.map((r) => r[0]), ['mmmm', 'zzzz'], 'the race ran to its end');
    await clock.advance(8400);
    assert.deepEqual(R.roster.map((p) => p.id), ['mmmm', 'zzzz', 'aaaa'], 'and the next lobby admits the other host');
  });
  await scenario(async ({ R, peer }) => {    // I am only in the lobby: the host that is mid-race wins although its id is higher
    R.enter('ABCD', true);
    peer('zzzz').say('lobby', lobbyOf('zzzz', ['zzzz', 'qqqq'], { phase: 'race', raceNo: 1 }));
    assert.deepEqual([R.room.hostId, R.room.isHost, R.phase], ['zzzz', false, 'lobby'], 'I yield and wait as a spectator');
  });
  await scenario(async ({ R, peer, joined, toGo }) => {   // both mid-race: the higher race number wins, my race is dropped
    R.enter('ABCD', true);
    joined('qqqq'); await toGo(R);
    assert.equal(R.race.no, 1);
    peer('zzzz').say('lobby', lobbyOf('zzzz', ['zzzz', 'qqqq'], { phase: 'race', raceNo: 2 }));
    assert.deepEqual([R.room.hostId, R.phase, R.race], ['zzzz', 'lobby', null], 'race 2 beats race 1');
  });
});

test('race (joiner): the join timer re-arms when the elected peer is someone else - a silent peer gets one more round, then I host', async () => {
  await scenario(async ({ R, clock, out, mark, peer }) => {
    R.enter('ABCD', false);
    const a = peer('aaaa'); a.join(); a.hello('Alpha', 'hash-alpha', '');   // another joiner, lower id: it is the one to host
    const m0 = mark();
    await clock.advance(7100);
    assert.ok(!R.synced, 'aaaa is elected, not me');
    assert.equal(out('hello', m0).length, 1, 'I ask again');
    await clock.advance(7000);
    assert.ok(R.synced && R.room.isHost, 'aaaa never answered: I stopped waiting for it and host');
  });
});

test('race (joiner): a peer that already follows a host (one I am not linked to yet) keeps me from hosting; that host\'s lobby then syncs me', async () => {
  await scenario(async ({ R, clock, peer }) => {
    R.enter('ABCD', false);
    const b = peer('bbbb'); b.join(); b.hello('Bela', 'hash-alpha', 'zzzz');   // bbbb follows zzzz; the link to zzzz is still coming up
    await clock.advance(7100);
    assert.ok(!R.synced, 'waits for zzzz\'s lobby instead of electing itself (not even bbbb: it already follows someone)');
    const z = peer('zzzz'); z.say('lobby', lobbyOf('zzzz', ['zzzz', 'bbbb']));
    assert.deepEqual([R.synced, R.room.hostId, R.roster.map((p) => p.id)], [true, 'zzzz', ['zzzz', 'bbbb']]);
    await clock.advance(20000);
    assert.equal(R.room.hostId, 'zzzz', 'and the timer does not touch it later');
  });
});

test('race (host): a fin counts only after GO, with every checkpoint reported and not under half the author time; cp counts are clamped', async () => {
  await scenario(async ({ R, clock, joined }) => {
    R.enter('ABCD', true);
    const z = joined('zzzz', 'Zed'), q = joined('qqqq', 'Quirin');
    R.start(); await clock.settle();
    assert.equal(R.phase, 'count');
    z.say('cp', { no: 1, n: 2, ticks: 900 }); z.say('fin', { no: 1, ticks: 9500, splits: [] });
    assert.ok(!R.race.fin.has('zzzz') && !R.race.firstFinAt, 'a fin during the countdown is ignored and does not start the 60 s timer');
    await clock.advance(3500); assert.equal(R.phase, 'race');
    z.say('fin', { no: 1, ticks: 2399, splits: [] });   // alpha: author 40 s -> the floor is 2400 ticks
    assert.ok(!R.race.fin.has('zzzz'), 'faster than half the author time');
    q.say('fin', { no: 1, ticks: 9000, splits: [] });
    assert.ok(!R.race.fin.has('qqqq'), 'no checkpoint was reported');
    q.say('cp', { no: 1, n: 99999, ticks: 100 });
    assert.equal(R.race.cp.get('qqqq').n, 2, 'clamped to the map\'s checkpoint count');
    z.say('fin', { no: 1, ticks: 2400, splits: [] });
    assert.equal(R.race.fin.get('zzzz'), 2400, 'exactly the floor counts');
  });
});

test('race (host): a peer that spams hello cannot make the host flood the lobby broadcasts, and its last name still arrives', async () => {
  await scenario(async ({ R, clock, out, mark, joined }) => {
    R.enter('ABCD', true);
    const z = joined('zzzz', 'Zed');
    const m0 = mark();
    for (let i = 0; i < 200; i++) z.hello('Zed' + (i % 3));
    await clock.advance(1000);
    const lobbies = out('lobby', m0).length;
    assert.ok(lobbies >= 1 && lobbies <= 4, '200 hellos in a second -> ' + lobbies + ' lobby broadcasts');
    assert.equal(R.roster.find((p) => p.id === 'zzzz').name, 'Zed1');
  });
});

test('race: when the mouse is not captured a slim "click" bar shows over the live game (no pause) and goes away once it is', async () => {
  await scenario(async ({ app, R, dom, joined, toGo }) => {
    R.enter('ABCD', true); joined('zzzz'); await toGo(R);
    const bar = dom.els.get('race-hud').querySelector('.mp-lock');
    assert.ok(bar && dom.els.get('race-hud').innerHTML.includes('Kattints a játékba az egér befogásához'), 'the bar exists');
    app.input.locked = false; app.emit('tick');
    assert.equal(bar.hidden, false, 'shown while the mouse is free');
    app.input.locked = true; app.emit('tick');
    assert.equal(bar.hidden, true, 'gone once captured');
    app.input.locked = false; app.state = 'paused'; app.emit('tick');
    assert.equal(bar.hidden, true, 'not on top of the pause menu');
  });
});

test('race (guest): joins, syncs map + roster from the host, counts down, shows results incl. "nem ért célba", returns to the warm-up on the host\'s word', async () => {
  await scenario(async ({ app, R, clock, dom, out, mark, peer }) => {
    R.enter('WXYZ', false);
    assert.equal(R.synced, false);
    const root = dom.els.get('scr-room');
    assert.ok(root.innerHTML.includes('mp-code'), 'room view built');
    const a = peer('aaaa'); a.join(); a.hello('Alpha', 'hash-beta');
    assert.equal(R.synced, false, 'wait for the lobby, do not guess');
    const m0 = mark();
    a.say('lobby', { host: 'aaaa', mapId: 'beta', mapHash: 'hash-beta', phase: 'lobby', raceNo: 0, players: [['aaaa', 'Alpha', 0, 'hash-beta'], ['mmmm', 'Teszt', 1, '']], totals: {} });
    await clock.settle();
    assert.ok(R.synced && R.roster.length === 2);
    assert.ok(app.calls.some((c) => c[0] === 'loadMap' && c[1] === 'beta'), 'loads the room\'s map');
    assert.ok(out('hello', m0).some((m) => m.data.mh === 'hash-beta'), 'hello carries my map hash');
    assert.equal(root.querySelector('[data-act=start]').hidden, true, 'no start button for a guest');
    a.say('start', startMsg(1, 'beta')); await clock.settle();
    assert.equal(R.phase, 'count');
    await clock.advance(3500); assert.equal(R.phase, 'race');
    app.emit('cp', { index: 0, count: 3, ticks: 700 });
    assert.deepEqual(out('cp', m0)[0].data, { no: 1, n: 1, ticks: 700 });
    a.say('end', { no: 1, results: [['aaaa', 7000, 3, 1, 10], ['mmmm', -1, 1, 0, 0]], totals: { aaaa: 10 } });
    assert.equal(R.phase, 'results'); assert.equal(R.totals.aaaa, 10);
    const html = dom.els.get('race-hud').querySelector('.mp-board').innerHTML;
    assert.ok(html.includes('nem ért célba') && html.includes('+10'), 'results board');
    app.calls.length = 0;
    a.say('lobby', { host: 'aaaa', mapId: 'beta', mapHash: 'hash-beta', phase: 'lobby', raceNo: 1, players: [['aaaa', 'Alpha', 0, ''], ['mmmm', 'Teszt', 1, '']], totals: { aaaa: 10 } });
    assert.equal(R.phase, 'lobby');
    assert.ok(app.calls.some((c) => c[0] === 'restartRun'), 'back at the start');
  }, { ui: 'room' });
});

test('race: own state goes out at 20 Hz; a peer\'s packets become a translucent figure drawn 120 ms behind, with no streak across a respawn', async () => {
  await scenario(async ({ app, R, clock, out, mark, joined }) => {
    R.enter('ABCD', true);
    const z = joined('zzzz', 'Zed');
    const m0 = mark();
    await clock.advance(1000);
    const sts = out('st', m0);
    assert.ok(sts.length >= 19 && sts.length <= 21, '20 Hz: ' + sts.length + ' packets in one second');
    assert.deepEqual(sts[0].data, [100, 200, 300, 50, 10, 0, 1], 'x y z in cm, yaw / pitch x100, checkpoint, flags');
    z.say('st', [100, 50, 200, 157, 0, 0, 1]);                  // t0
    await clock.advance(50); z.say('st', [140, 50, 200, 157, 0, 1, 1]);   // t0 + 50 ms
    await clock.advance(80); app.emit('tick');                  // t0 + 130 ms: drawn at t0 + 10 ms = 20 % of the way
    const f = app.figs.get('p:zzzz');
    assert.ok(f && f.ghost === true && f.name === 'Zed' && f.color === 0x2ee6d4 && f.flags === 1, 'a translucent, named, coloured figure');
    assert.ok(Math.abs(f.pos[0] - 1.08) < 0.02 && Math.abs(f.yaw - 1.57) < 0.01, 'interpolated: x ' + f.pos[0]);
    z.say('st', [1000, 50, 200, 157, 0, 1, 1]);                 // a respawn 8.6 m away
    await clock.advance(60); app.emit('tick');                  // drawn at t0 + 70 ms: a quarter of the way to the new spot ...
    assert.ok(Math.abs(app.figs.get('p:zzzz').pos[0] - 1.4) < 0.02, '... but it stays at the old spot, no streak: ' + app.figs.get('p:zzzz').pos[0]);
    await clock.advance(40); app.emit('tick');                  // t0 + 110 ms: three quarters of the way
    assert.ok(Math.abs(app.figs.get('p:zzzz').pos[0] - 10) < 0.02, '... then jumps: ' + app.figs.get('p:zzzz').pos[0]);
    z.say('st', [NaN, 0, 0, 0, 0, 0, 0]); z.say('st', [1, 2, 3]); z.say('st', 'x');   // junk packets change nothing
    assert.ok(Math.abs(app.figs.get('p:zzzz').pos[0] - 10) < 0.02);
  });
});
