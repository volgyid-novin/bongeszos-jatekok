// The map editor, the hostile and the awkward cases (the second pass after editor-tests.mjs; registered by app-tests.mjs).
// Untrusted files (prototype keys, deep nesting, huge numbers, a map the runtime would choke on), the sim on awkward geometry (start inside a
// wall, pads that go nowhere), the saved-map store when its index and documents disagree, the controller on its less travelled paths
// (leaving while a test starts, losing the window mid drag, the camera pose after restarts), the map list's HTML with hostile names, and
// race.js never offering an editor map to a room. A test whose name starts with "BUG:" pins a defect the first pass found: it fails until
// the product is fixed (the text of each says what is expected). The last block ("fix:" cases) pins the review fixes: the mouse capture that
// goes on into a test, the unsaved map that is kept, the collision grid budget, the index info of the map list, validate with the built world.
import { test, assert, setGlobal } from './harness.mjs';
import { memStorage, guardWebSocket, installClock, installDom, fakeMaps, DIFF_LABEL } from './support.mjs';
import * as TM from './trystero-mock.mjs';
import { openEditor } from './editor-tests.mjs';
import * as lib from '../editor/library.js';
import { CUSTOM_LIMIT } from '../store.js';
import { createWorld } from '../sim/world.js';
import { makeCmd } from '../sim/pmove.js';
import { mulberry32 } from '../sim/math.js';
import { newDoc, newItem, sanitizeDoc, serialise, importDoc, validate, DocModel, PALETTE, MATS, LIM, CELLS_MSG, docCells } from '../editor/model.js';
import { toDef } from '../editor/convert.js';

guardWebSocket();   // (ui.js -> leaderboard.js -> nostr.js grabs globalThis.WebSocket when it is imported)
const { UI } = await import('../ui.js');
const { initRace } = await import('../race.js');

const clean = (v) => JSON.parse(JSON.stringify(v));
const stripNext = (doc) => { const d = clean(doc); delete d.nextId; delete d.cam; return d; };
const build = (doc) => createWorld(toDef(doc).def);
const docOf = (items, extra = {}) => sanitizeDoc({ v: 1, id: 'edge', name: 'Edge', items, ...extra });
const cmdOf = (o = {}) => ({ ...makeCmd(), ...o });
const run = (w, cmd, n) => { const ev = []; for (let i = 0; i < n; i++) { w.step(cmd); for (const e of w.takeEvents()) ev.push(e); } return ev; };
const finite = (w) => [...w.ps.pos, ...w.ps.vel].every(Number.isFinite);
const count = (ev) => { const o = {}; for (const e of ev) o[e.type] = (o[e.type] || 0) + 1; return o; };
// the number of cells the sim's collision grid (8 m cells, see sim/trace.js) stores for a map: its memory and build time are proportional to it
const gridCells = (brushes) => brushes.reduce((n, b) => n + [0, 1, 2].reduce((m, a) => m * (Math.floor(b.max[a] / 8) - Math.floor(b.min[a] / 8) + 1), 1), 0);
let storeN = 0;
const freshStore = async (ls = memStorage()) => { setGlobal('localStorage', ls); return { ls, store: (await import('../store.js?edge=' + (++storeN))).store }; };
const K = (k) => 'pajzsugras:' + k;
// raw items of a short, finishable map: floor, one checkpoint, the finish (run with fwd = 1 for 900 ticks)
const FINISHABLE = [
  { t: 'block', c: [0, -0.5, -25], size: [8, 1, 60] }, { t: 'cp', c: [0, 2, -12], size: [6, 4, 2] }, { t: 'finish', c: [0, 2.5, -45], size: [6, 5, 3] },
];

// ================================================================ untrusted files
test('BUG: sanitize keeps block / ramp / pillar yaw at 0 / 90 / 180 / 270 for ANY number (1e18, 3e16, 1e308 ...), and sanitize stays idempotent', () => {
  for (const yaw of [3e16, 1e18, 1e308, -1e308]) {
    const d = docOf([{ t: 'block', yaw }, { t: 'ramp', yaw }, { t: 'prism', yaw }]);
    for (const it of d.items) assert.ok([0, 90, 180, 270].includes(it.yaw), `${it.t} yaw ${yaw} became ${it.yaw}: the document says 0 / 90 / 180 / 270 (a free angle gives a turned collision brush that the editor draws and picks as an unturned one)`);
    assert.deepEqual(sanitizeDoc(clean(d)), d, `sanitize(sanitize(x)) != sanitize(x) for yaw ${yaw}: the map that import built is not the map that is loaded the next time`);
  }
});

test('edge: a hostile file (__proto__ / constructor keys, 100000 nested arrays, a 2-million element array, 1e999) never throws, never pollutes Object.prototype, and comes out clean', () => {
  const evil = '{"v":1,"id":"__proto__","name":"constructor","theme":"__proto__","__proto__":{"polluted":1},"constructor":{"prototype":{"polluted2":1}},'
    + '"start":{"pos":[1e999,-1e999,1],"yaw":1e999,"__proto__":{"polluted3":1}},"cam":{"pos":"x","yaw":{},"pitch":[]},'
    + '"items":[{"t":"block","c":[1,2,3],"__proto__":{"polluted4":1},"constructor":{"prototype":{"polluted5":1}},"size":[1e999,1e-999,"7"],"mat":"__proto__"},'
    + '{"t":"__proto__"},{"t":"constructor"},{"t":"deco","kind":"constructor","size":null},{"t":"pad","pos":[0,0,0],"target":[0,0,0],"apex":1e999},{"t":"light","pos":[0,5,0],"range":1e99,"intensity":1e99,"color":-5}]}';
  const r = importDoc(evil);
  assert.ok(r.doc, r.error);
  for (const k of ['polluted', 'polluted2', 'polluted3', 'polluted4', 'polluted5']) assert.equal({}[k], undefined, 'Object.prototype.' + k);
  assert.deepEqual(Object.keys(r.doc).sort(), ['cam', 'created', 'id', 'items', 'name', 'nextId', 'start', 'theme', 'updated', 'v']);
  assert.ok(r.doc.items.every((it) => !Object.hasOwn(it, '__proto__') && !Object.hasOwn(it, 'constructor')));
  assert.equal(r.doc.items.length, 4, 'the block, the deco, the pad and the light survive; the types __proto__ / constructor are unknown');
  const light = r.doc.items.find((i) => i.t === 'light');
  assert.ok(light.range <= 100 && light.intensity <= 10 && light.color >= 0 && light.color <= 0xffffff, 'absurd light values are clamped: ' + JSON.stringify(light));
  assert.deepEqual(r.doc.items[0].mat, 'floor'); assert.ok(r.doc.items[0].size.every((v) => v >= LIM.sizeMin && v <= LIM.sizeMax));
  assert.equal(r.doc.theme, 'kikepzes', 'an unknown theme id (here __proto__) reads as the default theme ...');
  assert.doesNotThrow(() => toDef(r.doc), '... and the map builds');
  // too deep: a clean error, not a stack overflow
  const t0 = performance.now();
  assert.match(importDoc('['.repeat(100000) + ']'.repeat(100000)).error, /./);
  assert.match(importDoc('{"v":1,"items":' + '['.repeat(100000) + ']'.repeat(100000) + '}').error || 'ok', /./);
  // a 3.8 MB array of numbers: cut to the item limit, quickly
  const big = importDoc('{"v":1,"items":[' + '0,'.repeat(1.9e6) + '0]}');
  assert.ok(big.doc && big.doc.items.length === 0, 'numbers are no items');
  assert.ok(performance.now() - t0 < 3000, 'took ' + (performance.now() - t0) + ' ms');
  assert.match(importDoc('x'.repeat(4e6 + 1)).error, /túl nagy/);
});

test('BUG: a file that is small but needs a huge collision grid is refused (or its sizes are limited) at import: 2000 blocks of 400 m cubes = 265 million grid cells, 16 s and 3.6 GB in createWorld', async () => {
  const { store } = await freshStore();
  const hostile = { v: 1, id: 'cubes', name: 'Kockák', items: Array.from({ length: 2000 }, (_, i) => ({ id: i + 1, t: 'block', c: [0, 0, 0], size: [400, 400, 400] })) };
  const text = JSON.stringify(hostile);
  assert.ok(text.length < 4e6, 'the file itself is only ' + text.length + ' bytes');
  const r = lib.importMapText(store, text);
  if (!r.error) {
    const cells = gridCells(toDef(r.doc).def.build().brushes);   // (never createWorld on it here: that is the problem)
    assert.ok(cells <= 2e6, `import accepted a map whose collision grid has ${cells} cells (the 8 built-in maps: <= 1900; createWorld costs ~60 bytes and ~0.06 us per cell: ${(cells * 6e-8).toFixed(1)} s)`);
  }
  // a big but sane map stays welcome: 20 floors of 400 x 400 and 40 walls 400 x 100 x 5
  const sane = { v: 1, id: 'sane', items: [
    ...Array.from({ length: 20 }, (_, i) => ({ t: 'block', c: [(i % 5) * 400 - 800, 0, Math.floor(i / 5) * 400 - 600], size: [400, 1, 400] })),
    ...Array.from({ length: 40 }, (_, i) => ({ t: 'block', c: [(i % 10) * 100 - 450, 50, Math.floor(i / 10) * 100 - 150], size: [100, 100, 5] })),
  ] };
  const ok = lib.importMapText(store, JSON.stringify(sane));
  assert.ok(ok.doc && ok.saved, ok.error);
  const w0 = performance.now(); createWorld(toDef(ok.doc).def); assert.ok(performance.now() - w0 < 2000, 'a sane big map builds quickly');
});

// ================================================================ the model under a random walk
test('edge: random edit sessions (all ops, hostile patches, undo / redo wandering): the document stays clean, ids unique, <= 1 finish, it always builds, and undo walks back through every entry exactly', () => {
  let clock = 0;
  for (const seed of [21, 22]) {
    const rng = mulberry32(seed), R = (a, b) => a + rng() * (b - a), pick = (a) => a[Math.floor(rng() * a.length)];
    const m = new DocModel(newDoc({ id: 'fz' }), { now: () => clock });
    const ents = PALETTE.filter((p) => p.t !== 'start');
    const expect = [];   // the document before each undo entry
    for (let step = 0; step < 180; step++) {
      clock += pick([5, 50, 700, 5000]);
      const ids = m.doc.items.map((i) => i.id), snap = stripNext(m.doc), top0 = m.history.undoStack.at(-1);
      switch (Math.floor(rng() * 12)) {
        case 0: case 1: case 2: { const c = [R(-300, 300), R(-20, 40), R(-300, 300)]; m.add(newItem(pick(ents), { c, pos: c, target: [R(-90, 90), R(-5, 20), R(-90, 90)], yaw: pick([0, 90, 180, 270, 33]) })); break; }
        case 3: if (ids.length) m.update(pick(ids), { c: [R(-50, 50), R(-9, 9), R(-50, 50)], pos: [R(-50, 50), R(0, 9), R(-50, 50)], size: [R(-1, 30), R(-1, 30), R(-1, 30)], yaw: R(-400, 400), apex: R(-5, 50), sides: R(-2, 30), r: R(-1, 5), h: R(-1, 9), kind: pick(['lava', 'laser', 'void', 'crate', 'arch', 'x']), mat: pick(MATS) }, { mergeKey: pick([null, 'k1', 'k2']), mergeMs: pick([600, Infinity]) }); break;
        case 4: if (ids.length) m.remove(pick(ids)); break;
        case 5: if (ids.length) m.duplicate(pick(ids), [R(-3, 3), 0, R(-3, 3)]); break;
        case 6: if (ids.length) m.rotate(pick(ids)); break;
        case 7: { const cps = m.cpItems(); if (cps.length) m.reorderCp(pick(cps).id, pick([-1, 1])); break; }
        case 8: m.setStart([R(-30, 30), R(-3, 5), R(-30, 30)], R(-720, 720)); break;
        case 9: m.setTheme(pick(['kikepzes', 'ontode', 'lavatemplom', 'x y', '../..', 'orbitalis'])); break;   // (only kikepzes is a theme: always "no change")
        case 10: m.setName(pick(['A', '<b>', 'x'.repeat(60), ' ', 'Név'])); break;
        default: { rng() < 0.5 ? m.undo() : m.redo(); expect.length = 0; break; }   // (a wander: the bookkeeping below restarts from here)
      }
      if (m.history.undoStack.at(-1) !== top0 && m.history.undoStack.length > expect.length) expect.push(snap);
      const d = m.doc, ids2 = d.items.map((i) => i.id);
      assert.deepEqual(stripNext(sanitizeDoc(clean(d))), stripNext(d), `seed ${seed} step ${step}: an op produced an unclean document`);
      assert.equal(new Set(ids2).size, ids2.length, 'unique ids'); assert.ok(d.items.every((i) => i.id < d.nextId)); assert.ok(d.items.filter((i) => i.t === 'finish').length <= 1);
      toDef(d);
    }
    const final = stripNext(m.doc), depth = m.history.undoStack.length;
    assert.equal(importDoc(serialise(m.doc)).doc.items.length, m.doc.items.length, 'export -> import');
    let undone = 0; while (m.undo()) undone++;
    assert.equal(undone, depth);
    while (m.redo());
    assert.deepEqual(stripNext(m.doc), final, `seed ${seed}: redo everything ends where we were`);
  }
});

// ================================================================ the sim on awkward maps
test('edge (sim): a start inside a wall, a start in lava, a finish inside a laser: the sim stays finite, never throws, the finish does not count under the kill', () => {
  const noFloor = (extra) => [{ t: 'block', c: [0, -0.5, 0], size: [10, 1, 10] }, ...extra];
  // start inside a solid: "stuck" respawns, no NaN
  const w1 = build(docOf([{ t: 'block', c: [0, 1, 0], size: [10, 6, 10] }], { start: { pos: [0, 1, 0], yaw: 0 } }));
  const ev1 = run(w1, cmdOf({ fwd: 1 }), 600);
  assert.ok(finite(w1) && ev1.some((e) => e.type === 'respawn' && e.cause === 'stuck'), JSON.stringify(count(ev1)));
  // start in lava: killed again and again, still finite (validate warns about it)
  const d2 = docOf(noFloor([{ t: 'kill', c: [0, 1, 0], size: [10, 4, 10], kind: 'lava' }]), { start: { pos: [0, 0, 0], yaw: 0 } });
  assert.ok(validate(d2).warnings.includes('A rajtpont halálzónában van.'));
  const ev2 = run(build(d2), cmdOf({ fwd: 1 }), 600);
  assert.ok(ev2.every((e) => e.type !== 'respawn' || e.cause === 'kill') && ev2.some((e) => e.type === 'respawn'));
  // a finish that is entirely inside a laser: the kill is checked first
  const w3 = build(docOf([...FINISHABLE.slice(0, 2), { t: 'finish', c: [0, 2.5, -45], size: [6, 5, 3] }, { t: 'kill', c: [0, 2.5, -45], size: [6, 5, 3], kind: 'laser' }]));
  const ev3 = run(w3, cmdOf({ fwd: 1 }), 900);
  assert.ok(finite(w3) && !ev3.some((e) => e.type === 'finish') && ev3.some((e) => e.type === 'respawn' && e.cause === 'kill'), JSON.stringify(count(ev3)));
});

test('edge (sim): pads that go nowhere or everywhere (target = pad, 1500 m away, a flat arc), pillars of 3 / 16 sides at 0.1 and 200 m, a 0.1 m ramp 400 m high, a map spanning +-1500 m: all build and run finite', () => {
  const floor = { t: 'block', c: [0, -0.5, -5], size: [20, 1, 20] };
  const rows = [
    ['pad onto itself', [floor, { t: 'pad', pos: [0, 0, -5], target: [0, 0, -5], apex: 5 }]],
    ['pad 1500 m away', [floor, { t: 'pad', pos: [0, 0, -5], target: [1500, 1500, 1500], apex: 1550 }]],
    ['pad with a flat arc', [floor, { t: 'pad', pos: [0, 0, -5], target: [0, 0.1, -5], apex: 0.6 }]],
    ['tiny and huge pillars', [floor, { t: 'prism', c: [0, 0, 0], r: 0.1, h: 0.1, sides: 3 }, { t: 'prism', c: [0, 0, 600], r: 200, h: 400, sides: 16, yaw: 90 }, { t: 'prism', c: [-30, 0, 0], r: 0.1, h: 400, sides: 16 }]],
    ['a 0.1 ramp 400 high', [floor, { t: 'ramp', c: [0, 0, 20], size: [0.1, 400, 0.1], yaw: 270 }, { t: 'block', c: [0, 0, 30], size: [400, 0.1, 400] }]],
    ['the corners of the world', [{ t: 'block', c: [-1500, -0.5, -1500], size: [400, 1, 400] }, { t: 'block', c: [1500, -0.5, 1500], size: [400, 1, 400] }, { t: 'finish', c: [1500, 2, 1500], size: [6, 5, 3] }]],
  ];
  for (const [name, items] of rows) {
    const t0 = performance.now();
    const w = build(docOf(items, { start: { pos: [0, 0, -5], yaw: 0 } }));
    w.teleport([0, 0, -5], 0);
    const ev = run(w, cmdOf({ fwd: 1 }), 600);
    assert.ok(finite(w), name + ': ' + JSON.stringify(w.ps.pos));
    assert.ok(performance.now() - t0 < 1500, `${name}: ${performance.now() - t0} ms`);
    assert.ok(ev.length < 200, name + ': an event storm ' + JSON.stringify(count(ev)));
  }
});

// ================================================================ saved maps
test('BUG: a saved-maps index entry whose document is gone still counts against the 40 map limit, but the list hides it: at 39 visible maps a new one can never be saved', async () => {
  const { ls, store } = await freshStore();
  for (let i = 0; i < CUSTOM_LIMIT; i++) assert.equal(store.saveCustom({ ...newDoc({ id: 'm' + i }), updated: i + 1 }), true);
  ls._m.delete(K('ed:map:m7'));   // the browser dropped a document (cleared site data, a write that half failed in an earlier session)
  assert.equal(store.listCustom().length, CUSTOM_LIMIT - 1, 'the menu shows 39 maps, so it offers "Új pálya"');
  const fresh = lib.newMapDoc(store, 99);
  assert.equal(store.saveCustom(fresh), true, 'saving map 40 must work: only 39 maps exist (saveCustom counts the dead index entry, so the autosave of the new map fails with "Nincs mentve" for ever)');
  assert.ok(store.hasCustom(fresh.id));
});

test('edge (store): editor maps with ids that look like prototype keys or like a built-in map (__proto__, constructor, kikepzes): saved, played, record kept apart, deleted - the built-in record never moves', async () => {
  const { ls, store } = await freshStore();
  const HASH = 'h-built-in';
  assert.equal(store.setPB('kikepzes', HASH, { ticks: 6000, splits: [100], ghost: 'G' }), true);
  const builtIn = () => [...ls._m.entries()].filter(([k]) => k.startsWith(K('pb:'))).sort();
  const before = builtIn();
  for (const id of ['__proto__', 'constructor', 'kikepzes']) {
    const r = lib.importMapText(store, JSON.stringify({ v: 1, id, name: id, items: FINISHABLE }), 5);
    assert.ok(r.doc && r.saved === true && r.renamed === false && r.doc.id === id, id + ': ' + r.error);
    const prep = lib.prepareRun(store, id);
    assert.equal(prep.def.meta.id, 'sajat-' + id); assert.equal(lib.docIdOf(prep.def.meta.id), id);
    const w = createWorld(prep.def), fin = run(w, cmdOf({ fwd: 1 }), 900).find((e) => e.type === 'finish');
    assert.ok(fin, id + ' finishes');
    assert.deepEqual(lib.recordPB(store, prep.def.meta.id, w.map.mapHash, { ticks: fin.time, splits: fin.splits, ghost: null }, true), { saved: true, publish: false });
    assert.ok(ls._m.has(K('ed:pb:' + id)) && lib.readPB(store, prep.def.meta.id, w.map.mapHash, true).ticks === fin.time);
    assert.deepEqual(builtIn(), before, id + ': no built-in record changed');
    assert.equal(lib.readPB(store, 'kikepzes', HASH, false).ticks, 6000);
    assert.equal(lib.deleteMap(store, id), true);
    assert.ok(!ls._m.has(K('ed:map:' + id)) && !ls._m.has(K('ed:pb:' + id)), id + ': every key of the map is gone');
    assert.deepEqual(store.listCustom(), []);
    assert.deepEqual(builtIn(), before);
  }
});

test('edge (menus): hostile map names (tampered storage and an imported file) never break out of the HTML of the map list, in both modes', async () => {
  const { store } = await freshStore();
  const NAME = '<img src=x onerror=alert(1)>"\'&<script>alert(2)</script>';
  store.saveCustom({ ...newDoc({ id: 'evil' }), name: NAME, updated: 5 });   // (what an old version / a hand edited localStorage may hold: nothing cleaned the name)
  const r = lib.importMapText(store, JSON.stringify({ v: 1, id: 'file', name: NAME, items: FINISHABLE }), 9);
  assert.ok(r.doc && !/[<>]/.test(r.doc.name), 'a file\'s name is cleaned on import: ' + r.doc.name);
  for (const mode of ['play', 'edit']) {
    const box = { html: '', set innerHTML(v) { this.html = v; }, get innerHTML() { return this.html; }, querySelector: () => null, querySelectorAll: () => [] };
    UI.prototype.fillCustomList.call({ app: { store, editor: null } }, box, mode);
    assert.ok(box.html.includes('&lt;img') && box.html.includes('&quot;'), mode + ': escaped: ' + box.html.slice(0, 200));
    assert.ok(!/<(?!\/?(?:div|span|button|p)\b)/.test(box.html), mode + ': no tag besides the template\'s own: ' + (box.html.match(/<(?!\/?(?:div|span|button|p)\b)[^>]*>/) || [])[0]);
    for (const m of box.html.matchAll(/data-id="([^"]*)"/g)) assert.match(m[1], /^[a-z0-9_-]+$/);
    assert.equal((box.html.match(/class="crow/g) || []).length, 2);
  }
});

// ================================================================ the controller
test('BUG: leaving the editor while a test is still starting must not start the test afterwards (startTest awaits the rebuild, then never looks at the editor again)', async () => {
  const { ed, ctx, D } = await openEditor();
  D.setCam([0, 12, 12], 0, -45);
  const started = ed.startTest({ from: 'start' });   // suspends at `await this.flush()`
  ed.app.exitEditor();                                // Kilépés (or anything else that leaves the editor) meanwhile
  const ok = await started;
  assert.equal(ctx.tests.length, 0, 'beginTest was called after the editor was left: the game shows the HUD and the sim runs behind the menu');
  assert.deepEqual([ok, ed.testing, ctx.state], [false, false, 'menu']);
});

test('BUG: losing the window during a drag drops the drag (a missed mouseup would freeze the rebuild and the autosave until the next click)', async () => {
  const { ed, D, winListeners } = await openEditor();
  D.setCam([0, 12, 12], 0, -45);
  await D.exec('tool', 'wall'); D.aim(0, 0); await D.click();
  await D.exec('tool', 'select');
  const picked = D.aim(0, 0).pick;
  assert.ok(picked && picked.id != null);
  ed.primaryDown();
  assert.ok(ed.drag, 'a drag is on');
  assert.ok(winListeners.blur && winListeners.blur.length, 'the editor listens to the window blur');
  for (const f of winListeners.blur) f({});   // alt-tab: the mouse button is released over another window, no mouseup ever comes
  assert.equal(ed.drag, null, 'the blur must end the drag like it ends flying and looking');
});

test('edge (controller): the pad flow (Esc cancels the pending target and keeps the tool, a target under 1 m is refused) and the camera pose after restarts / deaths / back from a camera test', async () => {
  const { ed, D, host, ctx } = await openEditor();
  D.setCam([0, 12, 12], 0, -45);
  await D.exec('tool', 'pad'); D.aim(-0.3, -0.3); await D.click();
  assert.ok(ed.padPending);
  await D.key('Escape'); assert.equal(ed.padPending, null); assert.equal(ed.tool, 'pad', 'Esc cancels the pending target first'); assert.equal(ed.panel.msg.textContent, 'Ugrópárna megszakítva');
  D.aim(-0.3, -0.3); await D.click(); D.aim(-0.3, -0.298);
  const n = ed.model.doc.items.length;
  assert.equal((await D.click()).id, null); assert.ok(ed.padPending, 'still waiting for a real target'); assert.match(ed.panel.msg.textContent, /túl közel/);
  assert.equal(ed.model.doc.items.length, n);
  await D.key('Escape'); await D.key('Escape'); assert.equal(ed.tool, 'select');
  // the camera test: restart (Enter) and death (R / lava) go back to the camera spot, leaving puts the camera back exactly
  D.setCam([3, 5, 2], 40, -10);
  const cam0 = D.state().cam;
  assert.ok((await D.test({ from: 'cam' })).ok);
  const w = host.world, spot = ctx.tests.at(-1).pose.pos;
  for (let i = 0; i < 3; i++) { w.restart({ silent: true }); ed.applyTestStart(); assert.ok(Math.abs(w.ps.pos[0] - 3) < 1e-9 && Math.abs(w.ps.pos[2] - 2) < 1e-9, 'restart ' + i + ' at ' + w.ps.pos); }
  w.respawn('kill'); assert.ok(Math.abs(w.ps.pos[0] - spot[0]) < 1e-9 && Math.abs(w.ps.pos[2] - spot[2]) < 1e-9, 'a death returns to the camera spot');
  assert.equal(w.cpIndex, w.cpCount);
  D.back();
  assert.deepEqual(D.state().cam, cam0); assert.equal(ctx.state, 'editor'); assert.ok(!ed.testing && ed.active);
  assert.equal(ed.testFrom, null);
});

// ================================================================ race.js: a room never starts on an editor map
function raceApp(mapId, settings) {
  const maps = fakeMaps(), L = new Map(), calls = [];
  const hashOf = (id) => (maps.has(id) ? 'hash-' + id : null);
  const app = {
    maps, DIFF_LABEL, settings: { name: 'Teszt', ...settings }, local: { name: 'Teszt' }, mapId, mapHash: 'hash-of-the-editor-map',
    mode: 'solo', state: 'menu', pauseFreezes: true, allow: { restart: true, respawn: true }, calls,
    world: { ps: { pos: [1, 2, 3], yaw: 0.5, pitch: 0.1 }, cpIndex: 0, playerFlags: () => 1 }, mapHashOf: hashOf,
    loadMap: async (id) => { calls.push(['loadMap', id]); app.mapId = id; app.mapHash = hashOf(id); },
    restartRun: (o) => calls.push(['restartRun', o]), startRun() {}, setFrozen() {}, setMode: (m) => { app.mode = m; }, play: () => { app.state = 'playing'; }, setSetting() {},
    showScreen: (id) => { app.ui.current = id; app.emit('screen', { id }); },
    on: (t, cb) => { if (!L.has(t)) L.set(t, new Set()); L.get(t).add(cb); return () => L.get(t).delete(cb); },
    emit: (t, p = {}) => { for (const cb of [...(L.get(t) || [])]) cb(p); },
    figures: { upsert() {}, remove() {}, has: () => false }, hud: { center() {}, standings() {} }, ui: { current: 'menu', toast() {} }, audio: { unlock() {} }, input: { lock: () => Promise.resolve(true) },
  };
  return app;
}
async function raceScenario(mapId, settings, fn) {
  TM.reset();
  const clock = installClock();
  installDom();
  const app = raceApp(mapId, settings);
  initRace(app);
  const sent = (type) => TM.sent.filter((m) => m.type === type);
  try { await fn({ app, R: app.race, clock, room: () => TM.rooms.at(-1), sent }); } finally { try { app.emit('exit'); } catch { /* left */ } }
}

test('edge (race): a room created while an editor map is the loaded one starts on the last built-in map (lobby, hello, start): never a sajat-* id', async () => {
  await raceScenario('sajat-abc', { lastMap: 'beta' }, async ({ app, R, clock, room, sent }) => {
    R.enter('ABCD', true);
    assert.equal(R.synced, true);
    room().onPeerJoin('zzzz'); room().actions.hello.onMessage({ name: 'Zed', mh: 'hash-beta', host: '' }, { peerId: 'zzzz' });
    assert.ok(sent('lobby').length > 0);
    for (const l of sent('lobby')) assert.deepEqual([l.data.mapId, l.data.mapHash], ['beta', 'hash-beta'], 'the lobby offers a map everybody has, with its real hash (not the editor map\'s)');
    assert.ok(sent('hello').every((h) => h.data.mh === 'hash-beta' || h.data.mh === ''), JSON.stringify(sent('hello').map((h) => h.data.mh)));
    R.start(); await clock.settle();
    assert.deepEqual(sent('start').map((s) => [s.data.mapId, s.data.mapHash]), [['beta', 'hash-beta']]);
    assert.ok(app.calls.some((c) => c[0] === 'loadMap' && c[1] === 'beta'), 'the game loads the room map, not the editor one');
    assert.ok(!JSON.stringify(TM.sent).includes('sajat'), 'nothing of the editor map left this machine');
  });
});

test('edge (race): a joiner that becomes the host of an empty room, and a lastMap that is junk (or an editor id): the first built-in map, never an unknown id', async () => {
  for (const [lastMap, expected] of [['sajat-zzz', 'alpha'], [undefined, 'alpha'], ['beta', 'beta']]) {
    await raceScenario('sajat-abc', { lastMap }, async ({ R, clock, room, sent }) => {
      R.enter('ABCD', false);
      await clock.advance(7100);   // JOIN_WAIT_MS: nobody answered
      assert.equal(R.synced, true, 'took the empty room');
      room().onPeerJoin('zzzz');
      const lobbies = sent('lobby');
      assert.ok(lobbies.length > 0 && lobbies.every((l) => l.data.mapId === expected && l.data.mapHash === 'hash-' + expected), `lastMap ${lastMap}: ${JSON.stringify(lobbies.map((l) => l.data.mapId))}`);
    });
  }
});

// ================================================================ the fix round (review findings)
test('fix: T / F2 / Enter with the right button held: the capture goes on into the test (no unlock, so no late pointerlockchange(false) ends it); without a capture the old path', async () => {
  const { ed, ctx, app } = await openEditor();
  app.input.locked = false;
  ed.startLook(); assert.equal(ctx.locks, 1);
  app.input.locked = true;   // (the browser granted the lock)
  assert.equal(await ed.startTest({ from: 'start' }), true);
  assert.deepEqual([ed.looking, ctx.locks, ctx.tests.length, document.body.classList.contains('ed-look')], [false, 1, 1, false], 'the lock is kept for the test');
  ed.backFromTest();
  // the lock was refused (drag look): looking ends the usual way
  app.input.locked = false;
  ed.startLook(); assert.equal(ctx.locks, 2);
  assert.equal(await ed.startTest({ from: 'start' }), true);
  assert.deepEqual([ed.looking, ctx.locks], [false, 1], 'unlocked as before (the test locks again itself)');
});

test('fix: a map whose save failed is kept in memory when the editor opens again, the top bar says "Nincs mentve!" until a save works', async () => {
  const { ed, D, store, app } = await openEditor();
  for (let i = 0; i < CUSTOM_LIMIT; i++) store.saveCustom({ ...newDoc({ id: 'f' + i }), updated: i + 1 });
  D.setCam([0, 12, 12], 0, -45);
  await D.exec('tool', 'wall'); D.aim(0, 0); await D.click();
  const m0 = ed.model, bar = () => ed.panel.saveState.textContent;
  assert.equal(ed.save(), false, 'the list is full: refused');
  assert.deepEqual([bar(), ed.unsaved, D.state().dirty], ['Nincs mentve!', true, true]);
  await D.exec('add', 'floor', { c: [20, -0.5, 0] });
  assert.equal(bar(), 'Nincs mentve!', 'a further edit does not turn it into "Mentés…"');
  app.exitEditor(); assert.ok(!store.hasCustom(m0.doc.id));
  await app.openEditor(null);
  assert.equal(ed.model, m0, 'the unsaved map is not replaced by the last saved one'); assert.equal(bar(), 'Nincs mentve!');
  store.removeCustom('f0');
  assert.equal(ed.save(), true);
  assert.deepEqual([bar(), ed.unsaved, D.state().dirty, store.hasCustom(m0.doc.id)], ['Mentve', false, false, true]);
});

test('fix: the collision grid budget: the model refuses the add / the growing edit with a message, toDef never builds an over-budget doc, a sane big map stays', () => {
  const m = new DocModel(newDoc({ id: 'big' })), said = [];
  m.onRefuse = (t) => said.push(t);
  const cube = (c) => newItem('floor', { c, size: [400, 400, 400] });
  let n = 0; while (m.add(cube([0, 0, 0])) != null) n++;
  assert.ok(n >= 5 && n <= 7, 'a few huge cubes fit: ' + n);
  assert.deepEqual(said, [CELLS_MSG]); assert.ok(docCells(m.doc) <= LIM.cells);
  assert.equal(m.update(1, { size: [400, 400, 400] }), false, 'growing the start floor over the budget is refused too'); assert.equal(said.length, 2);
  assert.equal(m.update(1, { size: [10, 1, 10] }), true, 'shrinking is always fine');
  assert.ok(m.add(newItem('floor', { c: [5, -0.5, 5] })) != null, 'small items still fit after a refusal');
  const over = { ...clean(m.doc), items: Array.from({ length: 9 }, (_, i) => ({ id: i + 1, t: 'block', c: [0, 0, 0], size: [400, 400, 400] })) };
  assert.throws(() => toDef(sanitizeDoc(over)), (e) => e.message === CELLS_MSG, 'no build, no createWorld');
  assert.equal(importDoc(JSON.stringify(over)).error, CELLS_MSG);
});

test('fix: dead index entries are pruned by the next save; a deep "v" is a clean error, not a RangeError', async () => {
  const { ls, store } = await freshStore();
  for (let i = 0; i < CUSTOM_LIMIT; i++) store.saveCustom({ ...newDoc({ id: 'm' + i }), updated: i + 1 });
  ls._m.delete(K('ed:map:m3')); ls._m.delete(K('ed:map:m4'));
  assert.equal(store.saveCustom({ ...newDoc({ id: 'fresh' }), updated: 99 }), true);
  assert.deepEqual(JSON.parse(ls._m.get(K('ed:index'))).map((e) => e.id).filter((id) => id === 'm3' || id === 'm4'), [], 'pruned');
  assert.equal(store.listCustom().length, CUSTOM_LIMIT - 1);
  let v = []; for (let i = 0; i < 1e5; i++) v = [v];
  assert.match(importDoc({ v }).error, /ismeretlen \(v\?\)/);
});

test('fix: the map list reads cps / finish / hash from the index entry (no build), the editor save and the import write them, a rename keeps them, import and rename never move ed:last', async () => {
  const { ed, D, store } = await openEditor();
  D.setCam([0, 12, 12], 0, -45);
  await D.exec('add', 'cp', { c: [0, 2, -10] }); await D.exec('add', 'finish', { c: [0, 2.5, -30] });
  assert.equal(ed.save(), true);
  const id = ed.model.doc.id, e0 = store.listCustom().find((e) => e.id === id), w = D.state().world;
  assert.deepEqual([e0.cps, e0.fin, e0.hash], [1, true, w.hash], "the editor save carries the built world's numbers");
  // a hand made entry proves that the list does not build: the numbers are the entry's, not the document's
  store.saveCustom(ed.model.doc, { info: { cps: 7, fin: false, hash: 'from-the-index' }, last: false });
  const d = lib.describeMap(store, store.listCustom().find((e) => e.id === id));
  assert.deepEqual([d.ok, d.cps, d.fin, d.hash], [true, 7, false, 'from-the-index']);
  assert.equal(lib.renameMap(store, id, 'Átnevezve'), true);
  const e1 = store.listCustom().find((e) => e.id === id);
  assert.deepEqual([e1.name, e1.cps, e1.hash], ['Átnevezve', 7, 'from-the-index'], 'the rename keeps the info');
  // an entry without info is built (as before)
  store.saveCustom({ ...ed.model.doc, updated: 5 }, { last: false });
  assert.deepEqual([lib.describeMap(store, store.listCustom().find((e) => e.id === id)).cps], [1]);
  // ed:last: the editor's own save sets it; an import and a rename do not
  store.setLastCustom(id);
  const r = lib.importMapText(store, JSON.stringify({ v: 1, id: 'other', name: 'Más', items: FINISHABLE }), 50);
  assert.ok(r.doc && r.saved); assert.equal(store.lastCustom(), id, 'import leaves ed:last');
  const e2 = store.listCustom().find((e) => e.id === 'other');
  assert.deepEqual([e2.cps, e2.fin, typeof e2.hash], [1, true, 'string'], 'an import writes the info too');
  assert.equal(lib.renameMap(store, 'other', 'Új név'), true); assert.equal(store.lastCustom(), id, 'rename leaves ed:last');
  store.removeCustom(id);
  const r2 = lib.importMapText(store, JSON.stringify({ v: 1, id: 'third', name: 'Harmadik', items: FINISHABLE }), 60);
  assert.ok(r2.saved); assert.equal(store.lastCustom(), null, 'with no last map an import does not become it');
});

test('fix: the Esc that ends an unlocked test is not also an Esc of the editor (the tool stays); an Esc in the editor still resets the tool', async () => {
  const { ed, D, ctx, press, docListeners } = await openEditor();
  D.setCam([0, 12, 12], 0, -45);
  await D.exec('tool', 'wall');
  assert.ok((await D.test({ from: 'start' })).ok);
  assert.equal(ctx.state, 'playing');
  // what the browser does: the same keydown event goes through the capture listener, the game's own listener (input.js: Esc ends the test) and the editor's
  const ev = { code: 'Escape', target: document.body, repeat: false, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, preventDefault() {} };
  const [capture, onKey] = docListeners.keydown;
  capture(ev); ed.backFromTest(); onKey(ev);
  assert.deepEqual([ed.testing, ed.tool], [false, 'wall'], 'the tool was not reset by the Esc that ended the test');
  press('Escape');
  assert.equal(ed.tool, 'select', "a later Esc is the editor's");
});

test('fix: validate with the built world finds a start or a checkpoint spawn inside a solid, and a checkpoint spawn in a kill box; without a world nothing changes', () => {
  const doc = docOf([
    { t: 'block', c: [0, -0.5, 0], size: [20, 1, 20] }, { t: 'block', c: [8, 2, 0], size: [3, 4, 3] },
    { t: 'cp', c: [8, 2, 0], size: [2, 4, 2] },            // spawn (8, 0, 0): inside the pillar block
    { t: 'cp', c: [-5, 2, 0], size: [2, 4, 2] }, { t: 'kill', c: [-5, 1, 0], size: [4, 2, 4], kind: 'lava' },   // spawn (-5, 0, 0) in lava
    { t: 'cp', c: [0, 2, 5], size: [2, 4, 2] },            // fine: stands on the floor
    { t: 'finish', c: [0, 2.5, -9], size: [3, 5, 3] },
  ], { start: { pos: [8, 0, 0], yaw: 0 } });   // the start is inside the block too
  const w = build(doc);
  const v = validate(doc, w).warnings;
  assert.ok(v.includes('A rajtpont szilárd elemben (falban) van: a játékos beragad.'), v.join(' | '));
  assert.ok(v.some((t) => t.startsWith('1. ellenőrzőpont') && /szilárd elemben/.test(t)), v.join(' | '));
  assert.ok(v.some((t) => t.startsWith('2. ellenőrzőpont') && /halálzónában/.test(t)), v.join(' | '));
  assert.ok(!v.some((t) => t.startsWith('3. ellenőrzőpont')), 'the third checkpoint is fine');
  assert.ok(!validate(doc).warnings.some((t) => /szilárd/.test(t)), 'no world: the solid checks are skipped');
  assert.ok(validate(doc).warnings.some((t) => /halálzónában/.test(t)), 'the kill check needs no world');
  // a clean map stays clean, also with a checkpoint whose spawn is just above a ramp
  const ok = docOf([{ t: 'block', c: [0, -0.5, 0], size: [20, 1, 20] }, { t: 'ramp', c: [0, 1, -6], size: [4, 2, 6] }, { t: 'cp', c: [0, 3, -6], size: [2, 3, 2] }, { t: 'finish', c: [0, 2.5, -15], size: [3, 5, 3] }], { start: { pos: [0, 0, 5], yaw: 0 } });
  assert.deepEqual(validate(ok, build(ok)).warnings.filter((t) => /szilárd|halálzón/.test(t)), []);
});
