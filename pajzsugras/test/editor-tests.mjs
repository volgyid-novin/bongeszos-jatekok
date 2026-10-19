// The map editor's pure parts (editor/model.js, convert.js, pick.js) and the sim / builder relaxations it needs (meta.custom, no finish).
// Registered by app-tests.mjs. The last three cases run the real controller (editor.js + panel.js + gizmos.js) on a stub DOM, a real three.js
// scene without WebGL and a fake app / host: tools, clicks, keys, drags, the panel, the test flow. What needs a GPU (the level rebuild in
// the renderer, the look) is checked by hand through __pj.editor (see the header of main.js). The store / library cases (saved maps, import /
// export, personal-best isolation) run on an in-memory localStorage; the controller ones also cover autosave, F2 and the failed-write toast.
import * as THREE from 'three';
import { test, assert, setGlobal } from './harness.mjs';
import { memStorage, brokenStorage } from './support.mjs';
import * as lib from '../editor/library.js';
import { CUSTOM_LIMIT, CUSTOM_MAX_BYTES } from '../store.js';
import { readdirSync } from 'node:fs';
import { MAPS } from '../maps/index.js';
import { createWorld, hasMedals } from '../sim/world.js';
import { makeCmd } from '../sim/pmove.js';
import { defineMap } from '../sim/builder.js';
import { mulberry32 } from '../sim/math.js';
import { TICK, HULL_HX } from '../sim/const.js';
import {
  newDoc, newItem, sanitizeDoc, serialise, importDoc, validate, DocModel, History, PALETTE, LIM, MATS, itemAabb, worldSize, isSolid, paletteIdOf, DECO_KINDS, DEFAULT_THEME,
} from '../editor/model.js';
import { toDef, builtinDef, themeOf } from '../editor/convert.js';
import { THEMES, THEME_IDS, THEME_NAMES } from '../editor/themes.js';
import { rayFromCamera, pickRay, surfaceHit, rayPlaneY, snap, snapMin, placement, padArc, findTestSpawn } from '../editor/pick.js';

const near = (a, b, eps = 1e-6, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} !~ ${b}`);
const nearV = (a, b, eps = 1e-6, msg = '') => a.forEach((v, i) => near(v, b[i], eps, `${msg}[${i}]`));
const model = (over = {}) => new DocModel(newDoc({ id: 'test', ...over }), { now: clock.now });
const clock = { t: 0, now: () => clock.t };
// a model whose document has no items (newDoc comes with a start floor)
const emptyModel = () => { const m = model(); m.doc.items = []; return m; };
const build = (doc) => { const { def, brushItem } = toDef(doc); return { def, brushItem, world: createWorld(def) }; };
const run = (w, cmd, n) => { const ev = []; for (let i = 0; i < n; i++) { w.step(cmd); for (const e of w.takeEvents()) ev.push(e); } return ev; };
const stripNext = (doc) => { const d = JSON.parse(JSON.stringify(doc)); delete d.nextId; return d; };

// ---------------------------------------------------------------- the built-in maps are exports of the editor
// A fixed document: its mapHash is pinned (it changes with the builder, the brush maths and SIM_VER on purpose: update it with them). The real
// built-in map is the player's export (maps/uj-palya.js) and changes whenever it is re-exported, so its hash is not pinned.
const BUILTIN_HASH = '0123456789abcd';   // a stand-in hash for the personal-best key tests below
const PINNED_HASH = '1579a965b02cc0';
const PINNED_DOC = { v: 1, id: 'pin', name: 'Pin', theme: 'kikepzes', start: { pos: [0, 1, 0], yaw: 0 },
  items: [{ id: 1, t: 'block', c: [0, 0.5, 0], size: [6, 1, 6], yaw: 0, mat: 'floor' }, { id: 2, t: 'block', c: [0, 2, -6], size: [6, 1, 3], yaw: 90, mat: 'wall' }] };
test('editor: a built-in map made from a document (builtinDef) keeps its mapHash: the geometry is hashed, the meta is not', () => {
  const doc = sanitizeDoc(PINNED_DOC);
  const hash = (id, order) => builtinDef(doc, id, order).build().mapHash;
  assert.equal(hash('pin', 1), hash('other-id', 7), 'id and order are not part of the hash');
  assert.equal(toDef(doc).def.build().mapHash, hash('pin', 1), 'a built-in export hashes like the same document opened as a custom map');
  assert.equal(hash('pin', 1), PINNED_HASH, 'update PINNED_HASH after an intended change of the builder / physics version');
});

test('editor: the registry (maps/index.js) holds the exports of the editor as normal built-in maps: not custom, no author time, no medals, in order', () => {
  assert.ok(MAPS.ids.length >= 1 && MAPS.ids[0] === 'uj-palya', 'the first (and, for now, only) built-in map is the editor export Új pálya: ' + MAPS.ids);
  const files = readdirSync(new URL('../maps/', import.meta.url)).filter((f) => f.endsWith('.js') && f !== 'index.js').map((f) => f.slice(0, -3)).sort();
  assert.deepEqual(MAPS.ids.slice().sort(), files, 'every maps/*.js is registered and every registered map has its file');
  MAPS.list.forEach((e, i) => {
    const m = e.meta;
    assert.equal(m.order, i + 1); assert.equal(m.exported, true); assert.ok(!m.custom, 'a built-in map is not "custom"');
    assert.equal(m.authorTime, 0); assert.equal(m.diff, 'nincs'); assert.ok(typeof m.name === 'string' && m.name);
    const map = e.build();
    assert.ok(map.brushes.length > 0 && /^[0-9a-f]+$/.test(map.mapHash));
    assert.equal(createWorld(e).medals, null, 'no author time: no medals');
    assert.ok(!hasMedals(m));
  });
  const uj = MAPS.get('uj-palya');
  assert.equal(uj.meta.name, 'Új pálya');
  assert.deepEqual(uj.meta.theme.palette, THEMES.kikepzes.palette, 'the theme preset named in the document');
  assert.equal(MAPS.has('kikepzes') || MAPS.has('orbitalis') || MAPS.has('sajat-mine'), false, 'the old built-in maps are gone');
});

test('editor: one theme preset is left (KIKÉPZÉS), a full theme the builder accepts; an unknown id, also one of the removed themes, falls back to it', () => {
  assert.deepEqual(THEME_IDS, ['kikepzes']);
  for (const id of THEME_IDS) {
    assert.ok(THEME_NAMES[id], id + ' has a name');
    const doc = sanitizeDoc({ ...PINNED_DOC, theme: id });
    const { def } = toDef(doc);
    for (const k of ['sky', 'fog', 'hemi', 'sun', 'palette', 'bloom', 'ambient']) assert.ok(def.meta.theme[k] !== undefined, `${id}: ${k}`);
    assert.deepEqual(def.build().theme.palette, THEMES[id].palette);
  }
  for (const bad of ['nope', 'ontode', 'orbitalis', '__proto__', 'constructor', 'toString', '']) {
    assert.deepEqual(themeOf(bad), themeOf(DEFAULT_THEME), JSON.stringify(bad));
    assert.equal(sanitizeDoc({ ...PINNED_DOC, theme: bad }).theme, 'kikepzes', 'a saved map of a removed theme still loads: ' + JSON.stringify(bad));
  }
});

test('editor: the builder relaxations are for meta.custom and meta.exported only (a hand-written map still needs finish / checkpoint / brush / route)', () => {
  const meta = { id: 'x', name: 'X', diff: 'kozepes', order: 99, authorTime: 0, blurb: '' };
  const half = (flags) => defineMap({ ...meta, ...flags }, (b) => { b.start([0, 0, 0], 0); b.block([0, -0.5, 0], [10, 1, 10], {}); });
  assert.throws(() => half({}).build(), /no b\.finish/);
  assert.doesNotThrow(() => half({ custom: true }).build());
  assert.doesNotThrow(() => half({ exported: true, diff: 'nincs' }).build());
  assert.throws(() => defineMap({ ...meta, custom: true }, () => {}).build(), /no b\.start/, 'a start is always needed');
  assert.throws(() => defineMap({ ...meta, exported: true }, () => {}).build(), /no b\.start/, 'a start is always needed');
});

// ---------------------------------------------------------------- doc -> def -> world
test('editor: a new document builds; the spawn is doc.start; the map is a custom one with the theme of the preset', () => {
  const m = model();
  m.setStart([2, 0, 3], 90);
  const { world, def } = build(m.doc);
  assert.equal(def.meta.custom, true);
  assert.equal(def.meta.id, 'sajat-test');
  assert.deepEqual(world.map.start.pos, [2, 0, 3]);
  assert.equal(world.map.start.yaw, 90);
  nearV(world.spawn.pos, [2, 0, 3]);
  near(world.spawn.yaw, Math.PI / 2);
  assert.ok(world.ps.grounded || world.ps.pos[1] <= 0.05, 'the player stands on the start floor');
  assert.deepEqual(def.meta.theme, themeOf('kikepzes'));
  assert.notEqual(def.meta.theme, THEMES.kikepzes, 'a copy, not the preset itself');
  assert.equal(def.meta.theme.palette.glow, THEMES.kikepzes.palette.glow);
});

test('editor: every palette type works: counts, brush -> item mapping, all ten materials registered, a ramp at yaw 90 rises toward +x', () => {
  const m = emptyModel();
  const ids = {};
  const at = (id, over) => { ids[id] = m.add(newItem(id, over)); };
  at('floor', { c: [0, -0.5, 0] }); at('wall', { c: [8, 2, 0] }); at('walldodge', { c: [-8, 2, 0] });
  at('ramp', { c: [0, 1, 30], yaw: 90 }); at('pillar', { c: [20, 2, 0] });
  at('lava', { c: [0, -2, 40] }); at('laser', { c: [0, 2, -20] }); at('void', { c: [0, -2, -40] });
  at('pad', { pos: [10, 0, 10], target: [20, 0, 10], apex: 5 }); at('cp', { c: [0, 2, -10] }); at('finish', { c: [0, 2.5, -60] });
  at('light', { pos: [0, 5, 0] }); at('deco', { pos: [4, 1, 4] });
  for (const k of DECO_KINDS.filter((x) => x !== 'crate')) at('deco-' + k, { pos: [4 + DECO_KINDS.indexOf(k), 1, 4] });
  for (const p of PALETTE) if (p.t !== 'start') assert.ok(ids[p.id] != null, 'added ' + p.id);
  const { world, brushItem } = build(m.doc);
  const mp = world.map;
  assert.equal(mp.brushes.length, 5);
  assert.deepEqual(brushItem, [ids.floor, ids.wall, ids.walldodge, ids.ramp, ids.pillar]);
  assert.equal(mp.kills.filter((k) => !k.auto).length, 3);
  assert.deepEqual(mp.kills.filter((k) => !k.auto).map((k) => k.kind), ['lava', 'laser', 'void']);
  assert.equal(mp.checkpoints.length, 1); assert.ok(mp.finish);
  assert.equal(mp.pads.length, 1); assert.equal(mp.lights.length, 1); assert.equal(mp.deco.length, 6, 'a crate, a pillar, a rock, a crystal, a beacon, an arch');
  assert.deepEqual(mp.deco.map((d) => d.kind), DECO_KINDS, 'every deco kind of the palette builds as itself');
  assert.deepEqual(m.doc.items.filter((i) => i.t === 'deco').map(paletteIdOf), ['deco', 'deco-pillar', 'deco-rock', 'deco-crystal', 'deco-beacon', 'deco-arch']);
  assert.deepEqual(mp.brushes.map((b) => b.mat), ['floor', 'wall', 'walldodge', 'floor', 'wall']);
  for (const mat of MATS) assert.ok(mp.materials[mat], 'material ' + mat);
  // the ramp: 4 x 2 x 6, turned 90 degrees: x spans 6, z spans 4; the high edge is on the +x side
  const rb = mp.brushes[3];
  nearV(rb.min, [-3, 0, 28], 1e-9); nearV(rb.max, [3, 2, 32], 1e-9);
  const y = (x) => world.cw.traceRay([x, 10, 30], [x, -10, 30]).endpos[1];
  near(y(2.5), 1.833, 0.01); near(y(-2.5), 0.167, 0.01); assert.ok(y(2.5) > y(-2.5) + 1.5, 'rises toward +x');
  // trigger boxes are centre +- size / 2
  const lava = mp.kills.find((k) => k.kind === 'lava');
  assert.deepEqual(lava.min, [-4, -3, 36]); assert.deepEqual(lava.max, [4, -1, 44]);
});

test('editor: the checkpoint order is the order of the cp items; reorderCp swaps them (spawn, yaw and label follow); the spawn is the bottom centre', () => {
  const m = emptyModel();
  m.add(newItem('floor', { c: [0, -0.5, 0], size: [30, 1, 80] }));
  const a = m.add(newItem('cp', { c: [0, 2, -10], size: [6, 4, 2], yaw: 90 }));
  const b = m.add(newItem('cp', { c: [4, 2, -30], size: [6, 4, 2], yaw: 180 }));
  let { world } = build(m.doc);
  assert.deepEqual(world.map.checkpoints.map((c) => c.spawn), [[0, 0, -10], [4, 0, -30]]);
  assert.deepEqual(world.map.checkpoints.map((c) => c.yaw), [90, 180]);
  assert.deepEqual(world.map.checkpoints.map((c) => c.label), ['CP 1', 'CP 2']);
  assert.equal(m.reorderCp(a, 1), true);
  assert.equal(m.reorderCp(a, 1), false, 'already the last');
  assert.equal(m.reorderCp(b, -1), false, 'already the first');
  ({ world } = build(m.doc));
  assert.deepEqual(world.map.checkpoints.map((c) => c.spawn), [[4, 0, -30], [0, 0, -10]]);
  assert.deepEqual(world.map.checkpoints.map((c) => c.yaw), [180, 90]);
  assert.equal(m.undo().label, 'Ellenőrzőpont sorrend');
  ({ world } = build(m.doc));
  assert.deepEqual(world.map.checkpoints.map((c) => c.yaw), [90, 180], 'undo restores the order');
});

test('editor: a play-through with real ticks over floor + 2 checkpoints + finish ends in a finish with 2 splits; the finish needs the checkpoints first', () => {
  const m = emptyModel();
  m.add(newItem('floor', { c: [0, -0.5, -25], size: [8, 1, 60] }));
  m.add(newItem('cp', { c: [0, 2, -12], size: [6, 4, 2] }));
  m.add(newItem('cp', { c: [0, 2, -28], size: [6, 4, 2] }));
  m.add(newItem('finish', { c: [0, 2.5, -45], size: [6, 5, 3] }));
  const { world } = build(m.doc);
  const cmd = makeCmd(); cmd.fwd = 1;   // yaw 0: straight down -z
  const ev = run(world, cmd, 900);
  const kinds = ev.filter((e) => e.type === 'cp' || e.type === 'finish');
  assert.deepEqual(kinds.map((e) => e.type), ['cp', 'cp', 'finish']);
  assert.deepEqual(kinds.filter((e) => e.type === 'cp').map((e) => e.index), [0, 1]);
  const fin = kinds[2];
  assert.equal(fin.splits.length, 2);
  assert.ok(fin.splits[0] < fin.splits[1] && fin.splits[1] < fin.time);
  assert.ok(world.finished && world.clockState === 'finished');
  assert.ok(fin.time / TICK > 4 && fin.time / TICK < 7, 'about 45 m at 8.8 m/s: ' + fin.time / TICK);
  // the finish before the checkpoints does not count
  const w2 = build(m.doc).world;
  w2.teleport([0, 0, -40], 0);
  w2.startClock();
  run(w2, cmd, 60);
  assert.equal(w2.finished, false, 'the finish is gated by the checkpoints');
});

test('editor: the camera test (practice) contract: with every checkpoint taken the finish counts at once, and R / death return to the camera spot', () => {
  const m = emptyModel();
  m.add(newItem('floor', { c: [0, -0.5, -25], size: [8, 1, 60] }));
  m.add(newItem('cp', { c: [0, 2, -12], size: [6, 4, 2] }));
  m.add(newItem('finish', { c: [0, 2.5, -45], size: [6, 5, 3] }));
  m.add(newItem('lava', { c: [0, -2, -70], size: [30, 2, 8] }));   // beyond the end of the floor
  const { world } = build(m.doc);
  // (the same steps as Editor.applyTestStart)
  const pose = { pos: [0, 0, -30], yaw: 0 };
  world.restart({ silent: true }); world.takeEvents();
  world.teleport(pose.pos, pose.yaw); world.spawn = { pos: pose.pos.slice(), yaw: pose.yaw }; world.cpIndex = world.cpCount;
  const cmd = makeCmd(); cmd.fwd = 1;
  const ev = run(world, cmd, 300);
  assert.ok(ev.some((e) => e.type === 'finish'), 'finished without the checkpoint');
  // dying returns to the camera spot (not the start point)
  const w2 = build(m.doc).world;
  w2.restart({ silent: true });
  w2.teleport(pose.pos, pose.yaw); w2.spawn = { pos: pose.pos.slice(), yaw: pose.yaw }; w2.cpIndex = w2.cpCount;
  w2.teleport([0, -2, -70], 0);
  const ev2 = run(w2, makeCmd(), 3);
  assert.ok(ev2.some((e) => e.type === 'respawn' && e.cause === 'kill'), 'the lava killed');
  near(w2.ps.pos[2], -30, 0.01); near(w2.ps.pos[0], 0, 0.01);
});

test('editor: a custom map without finish / checkpoints / brushes builds and runs (bounds: the start +- 8 m; no finish event can fire)', () => {
  const m = emptyModel();
  m.setStart([5, 3, -2], 0);
  const { world } = build(m.doc);
  assert.equal(world.map.finish, null);
  assert.equal(world.map.brushes.length, 0);
  assert.equal(world.map.checkpoints.length, 0);
  assert.deepEqual(world.map.bounds, { min: [-3, -5, -10], max: [13, 11, 6] });
  const ev = run(world, Object.assign(makeCmd(), { fwd: 1 }), 600);   // falls into the automatic void, respawns, never throws
  assert.ok(ev.some((e) => e.type === 'respawn'));
  assert.equal(world.finished, false);
  // and with only a start floor, no finish: walking about is fine
  const w2 = build(model().doc).world;
  assert.equal(w2.map.finish, null);
  assert.doesNotThrow(() => run(w2, Object.assign(makeCmd(), { fwd: 1 }), 200));
});

// ---------------------------------------------------------------- the document: clean, round trip, ops
test('editor: serialise -> importDoc is a lossless round trip (also through sanitize twice); v:2, junk and non-objects are rejected', () => {
  const m = model({ name: 'Próba pálya' });
  m.add(newItem('wall', { c: [3.14159, 2, -7.777] })); m.add(newItem('cp', { c: [0, 2, -10], yaw: 123.456 }));
  m.add(newItem('pad', { pos: [1, 0, 1], target: [9, 2, 1], apex: 9 })); m.add(newItem('light', { pos: [0, 4, 0], color: 0x123456 })); m.add(newItem('deco', { pos: [3, 1, 3], kind: 'arch' }));
  m.setStart([1, 0, 2], 33);
  const text = serialise(m.doc);
  const r = importDoc(text);
  assert.ok(r.doc, r.error);
  assert.deepEqual(r.doc, JSON.parse(text), 'numbers are rounded to 0.01 in the file already');
  assert.deepEqual(r.doc, m.doc, 'the model keeps its numbers rounded too: nothing is lost');
  assert.deepEqual(sanitizeDoc(r.doc), r.doc, 'sanitize is idempotent');
  assert.equal(r.doc.items.find((i) => i.mat === 'wall').c[0], 3.14);
  assert.equal(importDoc({ ...JSON.parse(text), v: 2 }).doc, undefined);
  assert.match(importDoc({ ...JSON.parse(text), v: 2 }).error, /ismeretlen/);
  for (const junk of ['', '{', 'null', '[]', '42', '"x"', '{"v":1', 'undefined']) assert.ok(importDoc(junk).error, 'junk: ' + junk);
  assert.ok(importDoc(null).error); assert.ok(importDoc([1]).error);
  assert.equal(sanitizeDoc({ v: 1 }).items.length, 0, 'a bare v:1 is a valid empty map');
  assert.equal(sanitizeDoc({ v: 2 }), null);
});

test('editor: sanitize cleans NaN / strings / huge sizes / unknown types / 5000 items and never throws; what comes out always builds', () => {
  const rng = mulberry32(7);
  const pool = [NaN, Infinity, -Infinity, 'x', '5', null, undefined, {}, [], [1], [1, 2], ['a', 'b', 'c'], [NaN, 1, 2], 1e99, -1e99, 1e-9, true, false, 0, -3, 7, 400.5];
  const pick = () => pool[Math.floor(rng() * pool.length)];
  const types = ['block', 'ramp', 'prism', 'kill', 'cp', 'finish', 'pad', 'light', 'deco', 'nope', 7, null];
  const keys = ['id', 'c', 'pos', 'target', 'size', 'yaw', 'mat', 'kind', 'r', 'h', 'sides', 'apex', 'color', 'intensity', 'range'];
  for (let n = 0; n < 150; n++) {
    const raw = { v: 1, id: pick(), name: pick(), theme: pick(), start: pick() === 7 ? { pos: pick(), yaw: pick() } : { pos: [pick(), pick(), pick()], yaw: pick() }, cam: { pos: pick(), yaw: pick(), pitch: pick() }, nextId: pick(), items: [] };
    for (let i = 0; i < 1 + Math.floor(rng() * 12); i++) {
      const it = { t: types[Math.floor(rng() * types.length)] };
      for (const k of keys) if (rng() < 0.6) it[k] = rng() < 0.4 ? [pick(), pick(), pick()] : pick();
      raw.items.push(it);
    }
    let doc;
    assert.doesNotThrow(() => { doc = sanitizeDoc(raw); }, 'sanitize #' + n);
    assert.ok(doc, 'v:1 stays a document');
    const ids = new Set();
    for (const it of doc.items) {
      assert.ok(Number.isInteger(it.id) && it.id >= 1 && !ids.has(it.id) && it.id < doc.nextId, 'unique ids');
      ids.add(it.id);
      for (const k of ['c', 'pos', 'target']) if (it[k]) it[k].forEach((v) => assert.ok(Number.isFinite(v) && Math.abs(v) <= LIM.coord));
      if (it.size) it.size.forEach((v) => assert.ok(v >= LIM.sizeMin && v <= LIM.sizeMax));
    }
    assert.ok(doc.items.filter((i) => i.t === 'finish').length <= 1);
    assert.doesNotThrow(() => build(doc), 'a sanitized doc always builds (#' + n + ')');
  }
  const many = sanitizeDoc({ v: 1, items: Array.from({ length: 5000 }, (_, i) => ({ id: i + 1, t: 'block', c: [i, 0, 0], size: [1, 1, 1] })) });
  assert.equal(many.items.length, LIM.items);
  const dup = sanitizeDoc({ v: 1, items: [{ id: 4, t: 'block' }, { id: 4, t: 'block' }, { id: 'a', t: 'ramp' }, { t: 'finish' }, { t: 'finish', c: [9, 9, 9] }] });
  assert.equal(dup.items.length, 4, 'a second finish is dropped');
  assert.deepEqual(dup.items.map((i) => i.id).sort(), [1, 2, 3, 4].map((x) => (x === 1 ? 4 : x === 2 ? 5 : x === 3 ? 6 : 7)).sort(), 'duplicate / missing ids get fresh ones');
  const big = sanitizeDoc({ v: 1, items: [{ t: 'block', c: [1e9, -1e9, NaN], size: [1e9, -5, 'x'], yaw: 100, mat: 'lava' }] }).items[0];
  assert.deepEqual(big.c, [1500, -1500, 0]); assert.deepEqual(big.size, [400, 0.1, 6]);   // (a non-number takes the default of that axis) assert.equal(big.yaw, 90); assert.equal(big.mat, 'floor');
});

test('editor: ops: add / update / remove / duplicate / rotate / start / theme / name; a second finish moves the first; the item limit holds', () => {
  const m = emptyModel();
  const f1 = m.add(newItem('finish', { c: [0, 2, -10] }));
  const f2 = m.add(newItem('finish', { c: [5, 2, -20], size: [4, 4, 4] }));
  assert.equal(f1, f2, 'the finish is moved, not duplicated');
  assert.equal(m.doc.items.length, 1);
  assert.deepEqual(m.find(f1).c, [5, 2, -20]);
  assert.equal(m.duplicate(f1), null, 'a finish cannot be copied');
  const b = m.add(newItem('wall', { c: [0, 2, 0], size: [1, 4, 6] }));
  assert.equal(m.rotate(b), true); assert.equal(m.find(b).yaw, 90);
  assert.deepEqual(worldSize(m.find(b)), [6, 4, 1]);
  m.rotate(b); m.rotate(b); m.rotate(b); assert.equal(m.find(b).yaw, 0);
  const k = m.add(newItem('lava', { c: [0, 0, 0], size: [8, 2, 4] })); m.rotate(k); assert.deepEqual(m.find(k).size, [4, 2, 8]);
  const cp = m.add(newItem('cp', { c: [0, 2, 0], yaw: 0 })); m.rotate(cp); assert.equal(m.find(cp).yaw, 90); assert.deepEqual(m.find(cp).size, [2, 4, 6]);
  const d = m.duplicate(b, [2, 0, 0]);
  assert.deepEqual(m.find(d).c, [2, 2, 0]); assert.notEqual(d, b); assert.equal(m.indexOf(d), m.indexOf(b) + 1, 'the copy follows the original');
  assert.equal(m.update(b, { size: [1, 4, 6] }), false, 'no change, no entry');
  assert.equal(m.update(9999, { c: [0, 0, 0] }), false);
  assert.equal(m.update(b, { t: 'ramp', id: 77, size: [3, 3, 3] }), true);
  assert.equal(m.find(b).t, 'block', 'type and id are not patchable'); assert.equal(m.find(b).id, b);
  assert.equal(m.remove(d), true); assert.equal(m.remove(d), false);
  m.setStart([1, 2, 3], 450); assert.deepEqual(m.doc.start, { pos: [1, 2, 3], yaw: 90 });
  assert.equal(m.setTheme('lavatemplom'), false); assert.equal(m.doc.theme, 'kikepzes', 'the id of a removed theme is no change');
  assert.doesNotThrow(() => build(m.doc), 'a theme from another map');
  assert.equal(m.setTheme('../../etc'), false); assert.equal(m.doc.theme, 'kikepzes', 'an invalid theme id falls back');
  m.setName('  <b>Hosszú név</b> ' + 'x'.repeat(80)); assert.ok(m.doc.name.length <= LIM.nameLen && !/[<>]/.test(m.doc.name));
  m.setName('   '); assert.equal(m.doc.name, 'Névtelen pálya');
  const full = emptyModel();
  full.doc.items = Array.from({ length: LIM.items }, (_, i) => ({ id: i + 1, t: 'block', c: [0, 0, 0], size: [1, 1, 1], yaw: 0, mat: 'floor' }));
  full.doc.nextId = LIM.items + 1;
  assert.equal(full.add(newItem('floor')), null, 'the 2000 item limit');
  assert.equal(full.add(newItem('finish')) !== null, false);
});

test('editor: History: undo everything / redo everything, a new op after an undo drops the redo, drags and typing merge, the cap is 200', () => {
  clock.t = 0;
  const m = model();
  const states = [stripNext(m.doc)];
  const step = (fn) => { fn(); clock.t += 5000; states.push(stripNext(m.doc)); };
  let a, b, c;
  step(() => { a = m.add(newItem('wall', { c: [3, 2, 0] })); });
  step(() => { b = m.add(newItem('cp', { c: [0, 2, -9] })); });
  step(() => { c = m.add(newItem('cp', { c: [0, 2, -19] })); });
  step(() => m.update(a, { size: [2, 5, 7] }));
  step(() => m.rotate(a));
  step(() => m.reorderCp(b, 1));
  step(() => m.remove(b));
  step(() => m.setStart([4, 0, 4], 10));
  step(() => m.duplicate(a, [1, 0, 1]));
  step(() => m.update(c, { yaw: 45 }));
  step(() => m.setName('Másik'));
  step(() => m.add(newItem('pad', { pos: [1, 0, 0], target: [9, 0, 0] })));
  for (let i = states.length - 1; i > 0; i--) { assert.ok(m.undo(), 'undo ' + i); assert.deepEqual(stripNext(m.doc), states[i - 1], 'after undo ' + i); }
  assert.equal(m.undo(), null, 'nothing left');
  for (let i = 1; i < states.length; i++) { assert.ok(m.redo(), 'redo ' + i); assert.deepEqual(stripNext(m.doc), states[i], 'after redo ' + i); }
  assert.equal(m.redo(), null);
  // a new op after an undo clears the redo
  m.undo(); m.undo();
  assert.ok(m.history.canRedo);
  m.add(newItem('light', { pos: [0, 3, 0] }));
  assert.equal(m.history.canRedo, false); assert.equal(m.redo(), null);
  // the undone remove brings the checkpoint back at its old place
  const m2 = emptyModel();
  const k1 = m2.add(newItem('cp', { c: [0, 2, -9] })), k2 = m2.add(newItem('cp', { c: [0, 2, -19] })), k3 = m2.add(newItem('cp', { c: [0, 2, -29] }));
  m2.remove(k2); m2.undo();
  assert.deepEqual(m2.doc.items.map((i) => i.id), [k1, k2, k3]);
  assert.deepEqual(m2.undo().ids, [k3]);
});

test('editor: History: a drag (one mergeKey, no time limit) is ONE entry; typing in one field merges within 600 ms only; the cap is 200 entries', () => {
  clock.t = 0;
  const m = model();
  const id = m.add(newItem('wall', { c: [0, 2, 0] }));
  const before = m.history.undoStack.length;
  for (let i = 1; i <= 40; i++) { clock.t += 200; m.update(id, { c: [i, 2, 0] }, { mergeKey: 'drag1', mergeMs: Infinity }); }
  assert.equal(m.history.undoStack.length, before + 1, 'the whole drag is one entry');
  assert.deepEqual(m.find(id).c, [40, 2, 0]);
  m.undo(); assert.deepEqual(m.find(id).c, [0, 2, 0], 'one undo puts it back where the drag started');
  m.redo(); assert.deepEqual(m.find(id).c, [40, 2, 0]);
  const n0 = m.history.undoStack.length;
  clock.t = 100000;
  m.update(id, { size: [2, 4, 6] }, { mergeKey: 'f:size' });
  clock.t += 300; m.update(id, { size: [3, 4, 6] }, { mergeKey: 'f:size' });
  clock.t += 500; m.update(id, { size: [4, 4, 6] }, { mergeKey: 'f:size' });   // 500 ms after the last: the window slides
  assert.equal(m.history.undoStack.length, n0 + 1, 'typing within 600 ms of the previous keystroke merges');
  clock.t += 700; m.update(id, { size: [5, 4, 6] }, { mergeKey: 'f:size' });
  assert.equal(m.history.undoStack.length, n0 + 2, 'a pause longer than 600 ms starts a new entry');
  m.update(id, { size: [6, 4, 6] }, { mergeKey: 'f:other' });
  assert.equal(m.history.undoStack.length, n0 + 3, 'another field never merges');
  m.undo(); m.undo(); assert.deepEqual(m.find(id).size, [4, 4, 6]);
  // the cap
  const h = new History(200);
  for (let i = 0; i < 260; i++) h.push({ label: 'x' + i, ch: [{ k: 'set', id: i, before: 0, after: 1 }] }, { now: i * 10000 });
  assert.equal(h.undoStack.length, 200);
  assert.equal(h.undoStack[0].label, 'x60', 'the oldest ones are gone');
  const m3 = emptyModel();
  for (let i = 0; i < 250; i++) { clock.t += 10000; m3.add(newItem('floor', { c: [i, 0, 0] })); }
  let undone = 0; while (m3.undo()) undone++;
  assert.equal(undone, 200); assert.equal(m3.doc.items.length, 50);
});

test('editor: validate: Hungarian warnings for no finish, no floor under the start, the start inside a kill zone, a nearly full document', () => {
  const m = model();
  assert.deepEqual(validate(m.doc).warnings, ['Hiányzik a cél: tegyél le egy célt, különben a pálya nem teljesíthető.']);
  m.add(newItem('finish', { c: [0, 2.5, -20] }));
  assert.deepEqual(validate(m.doc), { errors: [], warnings: [] });
  m.setStart([40, 0, 40], 0);
  assert.deepEqual(validate(m.doc).warnings, ['A rajtpont alatt nincs padló.']);
  m.setStart([0, 0, 0], 0);
  m.add(newItem('lava', { c: [0, 0, 0], size: [4, 4, 4] }));
  assert.deepEqual(validate(m.doc).warnings, ['A rajtpont halálzónában van.']);
  const full = emptyModel();
  full.doc.items = Array.from({ length: LIM.items - 100 }, (_, i) => ({ id: i + 1, t: 'block', c: [0, -0.5, 0], size: [12, 1, 12], yaw: 0, mat: 'floor' }));
  assert.ok(validate(full.doc).warnings.some((w) => /Közel a 2000/.test(w)));
  // the finish count is an error only for hand-made documents (the model never makes two)
  const two = emptyModel(); two.doc.items = [{ id: 1, t: 'finish', c: [0, 0, 0], size: [1, 1, 1] }, { id: 2, t: 'finish', c: [0, 0, 0], size: [1, 1, 1] }];
  assert.deepEqual(validate(two.doc).errors, ['Csak egy cél lehet.']);
});

test('editor: pad: the apex is forced above both ends (the builder would throw otherwise); the arc starts at the pad, peaks at the apex and lands on the target', () => {
  const m = emptyModel();
  const id = m.add({ t: 'pad', pos: [0, 0, 0], target: [10, 5, 0], apex: 1 });
  const pad = m.find(id);
  assert.ok(pad.apex >= 5.5, 'apex ' + pad.apex);
  assert.doesNotThrow(() => build(m.doc));
  assert.equal(m.update(id, { target: [20, 12, 0] }), true);
  assert.ok(m.find(id).apex >= 12.5, 'moving the target raises the apex');
  const p2 = m.find(id);
  const arc = padArc(p2, 40);
  nearV(arc[0], p2.pos); nearV(arc[40], p2.target, 1e-6);
  near(Math.max(...arc.map((p) => p[1])), p2.apex, 0.05, 'peak');
  assert.ok(arc.every((p) => p[0] >= -1e-9 && p[0] <= 20 + 1e-9));
  // the same arc as the sim flies: step a player off the pad and compare the landing
  const w = build(m.doc).world;
  assert.equal(w.map.pads.length, 1);
  assert.equal(w.map.pads[0].apex, p2.apex);
});

// ---------------------------------------------------------------- picking, snapping, placement
test('editor: rayFromCamera: the centre ray follows yaw / pitch; the corners of the screen follow the field of view', () => {
  let r = rayFromCamera({ pos: [1, 2, 3], yaw: 0, pitch: 0 }, [0, 0], 90, 1);
  nearV(r.o, [1, 2, 3]); nearV(r.d, [0, 0, -1]);
  r = rayFromCamera({ pos: [0, 0, 0], yaw: Math.PI / 2, pitch: 0 }, [0, 0], 90, 1);
  nearV(r.d, [-1, 0, 0], 1e-9);                       // yaw +90 looks down -x
  r = rayFromCamera({ pos: [0, 0, 0], yaw: 0, pitch: -Math.PI / 4 }, [0, 0], 90, 1);
  nearV(r.d, [0, -Math.SQRT1_2, -Math.SQRT1_2], 1e-9);   // pitch < 0 looks down
  r = rayFromCamera({ pos: [0, 0, 0], yaw: 0, pitch: 0 }, [1, 0], 90, 1);   // the right edge of a 90 degree view
  nearV(r.d, [Math.SQRT1_2, 0, -Math.SQRT1_2], 1e-9);
  r = rayFromCamera({ pos: [0, 0, 0], yaw: 0, pitch: 0 }, [0, 1], 90, 16 / 9);
  nearV(r.d, [0, Math.SQRT1_2, -Math.SQRT1_2], 1e-9);
  r = rayFromCamera({ pos: [0, 0, 0], yaw: 0, pitch: 0 }, [1, 0], 90, 2);
  near(r.d[0] / -r.d[2], 2, 1e-9, 'x grows with the aspect');
});

test('editor: pickRay: yawed blocks use their turned extent, ramps are exact (not the bounding box), prisms their sides, triggers and the start are pickable; ties go to the smaller item', () => {
  const m = model();
  const down = [0, -1, 0], from = (x, y, z) => [x, y, z];
  // a floor 12 x 12 (id 1) under the start
  let h = pickRay(m.doc, from(0, 6, 3), down);
  assert.equal(h.id, 1); near(h.t, 6); nearV(h.point, [0, 0, 3]);
  // a block 2 x 2 x 8 turned 90: x spans 8, z spans 2
  const turned = m.add(newItem('wall', { c: [20, 1, 0], size: [2, 2, 8], yaw: 90 }));
  assert.equal(pickRay(m.doc, from(22, 6, 0), down).id, turned, 'inside the turned extent');
  assert.equal(pickRay(m.doc, from(20, 6, 3), down), null, 'z = 3 is outside (only 2 wide in z)');
  assert.deepEqual(worldSize(m.find(turned)), [8, 2, 2]);
  // a ramp 4 x 2 x 6 rising toward +z at z = 27 .. 33
  const ramp = m.add(newItem('ramp', { c: [0, 1, 30], size: [4, 2, 6] }));
  const along = [0, 0, 1];
  near(pickRay(m.doc, from(0, 1.8, 20), along).t, 12.4, 1e-6, 'the slope, not the bounding box (t = 7)');
  assert.equal(pickRay(m.doc, from(0, 1.8, 20), along).id, ramp);
  near(pickRay(m.doc, from(0, 1.8, 40), [0, 0, -1]).t, 7, 1e-6, 'the high back face');
  assert.equal(pickRay(m.doc, from(0, 2.2, 20), along), null, 'above the slope top');
  const turnedRamp = m.add(newItem('ramp', { c: [0, 1, -30], size: [4, 2, 6], yaw: 90 }));   // rises toward +x
  assert.equal(pickRay(m.doc, from(-10, 1.8, -30), [1, 0, 0]).id, turnedRamp);
  near(pickRay(m.doc, from(-10, 1.8, -30), [1, 0, 0]).t, 10 + 2.4, 1e-6, 'x = 2.4: (x + 3) / 6 * 2 = 1.8');
  // a pillar: 8 sides, r = 1: the face toward +x is the apothem away
  const pil = m.add(newItem('pillar', { c: [0, 2, -60], r: 1, h: 4, sides: 8 }));
  near(pickRay(m.doc, from(10, 2, -60), [-1, 0, 0]).t, 10 - Math.cos(Math.PI / 8), 1e-9);
  assert.equal(pickRay(m.doc, from(10, 2, -60), [-1, 0, 0]).id, pil);
  assert.equal(pickRay(m.doc, from(0.6, 6, -60.6), down).id, pil, 'on the diagonal, inside the octagon (apothem 0.924)');
  assert.equal(pickRay(m.doc, from(0.7, 6, -60.7), down), null, 'on the diagonal, outside it (0.99 from the centre along the face normal)');
  // triggers, pads, lights and the start
  const lava = m.add(newItem('lava', { c: [-30, 1, 0], size: [8, 2, 8] }));
  assert.equal(pickRay(m.doc, from(-30, 6, 0), down).id, lava);
  const pad = m.add(newItem('pad', { pos: [-10, 0, 0], target: [-10, 0, -10], apex: 5 }));
  assert.equal(pickRay(m.doc, from(-10, 6, 0), down).id, pad, 'the pad (0.6 high) is in front of the floor');
  const light = m.add(newItem('light', { pos: [-5, 3, 0] }));
  assert.equal(pickRay(m.doc, from(-5, 6, 0), down).id, light);
  assert.equal(pickRay(m.doc, from(0, 6, 0), down).id, 'start', 'the start figure');
  assert.equal(pickRay(m.doc, from(0, 6, 0), down, { skip: 'start' }).id, 1, 'skipped while it is being dragged');
  // a tie (both tops at y = 0, same entry distance): the smaller one wins
  const small = m.add(newItem('floor', { c: [5, -0.5, 5], size: [2, 1, 2] }));
  assert.equal(pickRay(m.doc, from(5, 6, 5), down).id, small);
  // the origin inside an item picks it at once (distance 0)
  assert.equal(pickRay(m.doc, from(5, -0.5, 5), [1, 0, 0]).t, 0);
  assert.equal(pickRay(m.doc, from(0, 6, 3), [0, 1, 0]), null, 'looking away');
  assert.equal(pickRay(m.doc, from(0, 6, 3), down, { tMax: 3 }), null, 'tMax');
});

test('editor: snap / snapMin / placement: boxes stand flush on the aimed surface with their MIN corner on the grid; lava hangs below; yawed sizes swap', () => {
  assert.equal(snap(0.74, 0.5), 0.5); assert.equal(snap(0.76, 0.5), 1); assert.equal(snap(-0.26, 0.5), -0.5); near(snap(0.34, 0.1), 0.3);
  assert.equal(snapMin(3.3, 3, 0.5), 3.5); assert.equal(snapMin(0, 4, 0.5), 0);
  const floorHit = { point: [3.3, 0, -2.1], normal: [0, 1, 0] };
  assert.deepEqual(placement('floor', floorHit, { grid: 0.5 }).c, [3.5, 0.5, -2]);
  assert.deepEqual(placement('floor', { point: [3.3, 1.37, -2.1], normal: [0, 1, 0] }, { grid: 0.5 }).c, [3.5, 1.87, -2], 'the surface height is exact (a ramp), not snapped');
  assert.deepEqual(placement('wall', { point: [5, 2, 0], normal: [1, 0, 0] }, { grid: 0.5 }).c, [5.5, 2, 0], 'flush against a wall');
  assert.deepEqual(placement('wall', { point: [-5, 2, 0], normal: [-1, 0, 0] }, { grid: 0.5 }).c, [-5.5, 2, 0]);
  assert.deepEqual(placement('floor', { point: [0, 3, 0], normal: [0, -1, 0] }, { grid: 0.5 }).c, [0, 2.5, 0], 'under a ceiling');
  assert.deepEqual(placement('lava', floorHit, { grid: 0.5 }).c, [3.5, -1, -2], 'a lava pool: its surface is where you aimed');
  assert.deepEqual(placement('void', floorHit, { grid: 0.5 }).c, [3.5, -1, -2]);
  assert.deepEqual(placement('laser', floorHit, { grid: 0.5 }).c, [3.5, 1.5, -2.3], 'a laser curtain (8 x 3 x 0.4) stands on it');
  const yawed = placement('wall', floorHit, { grid: 0.5, size: [6, 4, 1], yaw: 90 }).c;
  assert.deepEqual(yawed, [3.5, 2, -2], 'size 6 x 4 x 1 (the turned wall): min corner on the grid');
  assert.deepEqual(placement('pillar', floorHit, { grid: 0.5 }).c, [3.5, 2, -2], 'a pillar: centre on the grid, standing on the floor');
  assert.deepEqual(placement('pad', floorHit, { grid: 0.5 }).pos, [3.5, 0, -2]);
  assert.deepEqual(placement('deco', floorHit, { grid: 0.5, size: [2, 1.5, 2] }).pos, [3.5, 0.75, -2], 'a deco: pos = centre, standing on the floor');
  assert.deepEqual(placement('light', floorHit, { grid: 0.5 }).pos, [3.5, 2, -2]);
  const st = placement('start', floorHit, { grid: 0.5, camYaw: Math.PI / 2 });
  assert.deepEqual(st.pos, [3.5, 0, -2]); assert.equal(st.yaw, 90);
  assert.equal(placement('cp', floorHit, { grid: 0.1, camYaw: -Math.PI / 2 }).yaw, 270);
  assert.deepEqual(placement('floor', floorHit, { grid: 0.1 }).c, [3.3, 0.5, -2.1].map((v, i) => (i === 1 ? v : snapMin(v, 6, 0.1))).map((v) => Math.round(v * 100) / 100));
  // placing then adding builds
  const m = emptyModel();
  m.add(newItem('wall', { ...placement('wall', { point: [5, 2, 0], normal: [1, 0, 0] }, { grid: 0.5 }) }));
  assert.doesNotThrow(() => build(m.doc));
});

test('editor: surfaceHit uses the sim trace (exact on a ramp) and falls back to the y = 0 plane; findTestSpawn lifts out of walls and kill boxes, or gives up', () => {
  const m = emptyModel();
  m.add(newItem('ramp', { c: [0, 1, 0], size: [4, 2, 6] }));
  const w = build(m.doc).world;
  const d = rayFromCamera({ pos: [0, 10, 0.0], yaw: 0, pitch: -Math.PI / 2 }, [0, 0], 90, 1).d;
  const hit = surfaceHit(w, [0, 10, 0], d);
  near(hit.point[1], 1, 0.01, 'the middle of the slope'); assert.ok(hit.normal[1] > 0.9 && hit.normal[2] < -0.2, 'a sloped normal: ' + hit.normal);
  const far = surfaceHit(w, [30, 10, 30], d);
  nearV(far.point, [30, 0, 30], 1e-9); assert.deepEqual(far.normal, [0, 1, 0]);
  assert.equal(surfaceHit(w, [30, 10, 30], [0, 1, 0]), null, 'the sky');
  assert.equal(surfaceHit(null, [0, 3, 0], [0, -1, 0]).t, 3, 'no world: the plane');
  assert.equal(rayPlaneY([0, 5, 0], [0, 1, 0], 0), null);
  nearV(rayPlaneY([0, 5, 0], [1, -1, 0], 0), [5, 0, 0]);
  // test spawns
  const s = emptyModel();
  s.add(newItem('floor', { c: [0, -1.5, 0], size: [12, 3, 12] }));            // top at 0, 3 thick
  s.add(newItem('lava', { c: [30, 1, 0], size: [10, 2, 10] }));                // y 0 .. 2
  s.add(newItem('lava', { c: [60, 3, 0], size: [10, 6, 10] }));                // y 0 .. 6
  const sw = build(s.doc).world;
  nearV(findTestSpawn(sw, [0, 0.5, 0]), [0, 0.52, 0], 1e-9);
  near(findTestSpawn(sw, [0, 0, 0])[1], 0.02, 1e-9, 'standing on the floor is fine');
  near(findTestSpawn(sw, [0, -2, 0])[1], 0.02, 1e-9, 'lifted 2 m out of the floor');
  assert.equal(findTestSpawn(sw, [0, -2.5, 0]), null, 'too deep: "Innen nem lehet indulni"');
  near(findTestSpawn(sw, [30, 0.5, 0])[1], 2.02, 1e-9, 'lifted out of a lava box');
  assert.equal(findTestSpawn(sw, [60, 0.5, 0]), null, 'the lava box is too tall');
  near(findTestSpawn(sw, [0, 9, 0])[1], 9.02, 1e-9, 'in the air: stays (the player falls)');
  assert.ok(HULL_HX > 0);
});

test('editor: the document helpers: itemAabb for every type, isSolid, the 1-0 palette keys, 300 items convert + build in well under 250 ms', () => {
  const m = emptyModel();
  const ids = [['block', 'floor'], ['ramp', 'ramp'], ['prism', 'pillar'], ['kill', 'lava'], ['cp', 'cp'], ['finish', 'finish']];
  for (const [, p] of ids) m.add(newItem(p, { c: [10, 5, 10] }));
  for (const it of m.doc.items) {
    const b = itemAabb(it);
    assert.ok(b.min.every((v, a) => v < b.max[a]), it.t + ' has a volume');
    assert.equal(isSolid(it), ['block', 'ramp', 'prism'].includes(it.t));
  }
  nearV(itemAabb({ t: 'pad', pos: [1, 2, 3] }).min, [0.1, 1.9, 2.1]);
  assert.deepEqual(PALETTE.slice(0, 10).map((p) => p.key), ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']);
  assert.equal(new Set(PALETTE.map((p) => p.id)).size, PALETTE.length);
  for (const p of PALETTE) if (p.t !== 'start') assert.ok(newItem(p, {}), 'newItem ' + p.id);
  assert.equal(newItem('start'), null);
  // 300 items
  const big = emptyModel();
  for (let i = 0; i < 300; i++) big.add(newItem(['floor', 'wall', 'ramp', 'pillar', 'cp', 'lava'][i % 6], { c: [(i % 20) * 8, i % 5, Math.floor(i / 20) * 8] }));
  const t0 = performance.now();
  const r = build(big.doc);
  const ms = performance.now() - t0;
  assert.ok(ms < 250, `convert + build of 300 items took ${ms.toFixed(1)} ms`);
  assert.equal(r.world.map.brushes.length, 200);
});

// ---------------------------------------------------------------- the controller on a stub DOM
class TextNode { constructor(t) { this.nodeType = 3; this.textContent = t; } }
export class El {
  constructor(tag) {
    this.nodeType = 1; this.tagName = String(tag).toUpperCase(); this.children = []; this.listeners = {}; this.style = {}; this.hidden = false;
    this.value = ''; this.className = ''; this.dataset = {}; this.disabled = false; this._text = '';
    const set = new Set();
    this.classList = { add: (...c) => c.forEach((x) => set.add(x)), remove: (...c) => c.forEach((x) => set.delete(x)), contains: (c) => set.has(c), toggle: (c, on) => { if (on === undefined) on = !set.has(c); if (on) set.add(c); else set.delete(c); } };
  }
  setAttribute(k, v) { if (k === 'hidden') this.hidden = true; if (k === 'value') this.value = v; }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  append(...k) { for (const c of k) this.children.push(c); }
  replaceChildren(...k) { this.children = []; this.append(...k); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  blur() {}
  click() { El.clicks = (El.clicks || 0) + 1; this.clicked = true; }
  remove() { this.removed = true; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 1280, height: 720 }; }
  getContext() { return new Proxy({ canvas: this }, { get: (t, k) => (k in t ? t[k] : k === 'measureText' ? () => ({ width: 10 }) : () => ({ addColorStop() {} })), set: (t, k, v) => { t[k] = v; return true; } }); }
  find(pred, out = []) { if (pred(this)) out.push(this); for (const c of this.children) if (c.find) c.find(pred, out); return out; }
}
export const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
let storeN = 0;

// a fresh Editor on fake surroundings: a stub DOM, a real three.js scene (no GL), a fake app and host; real events go through the listeners
// it registered. -> { ed, D (the debug API), app, host, ctx, press, fire, canvas, figures }
export async function openEditor({ storage = memStorage() } = {}) {
  setGlobal('localStorage', storage);
  const store = (await import('../store.js?ed=' + (++storeN))).store;   // (a fresh module: an empty in-memory fallback)
  const els = new Map(), docListeners = {};
  setGlobal('document', {
    createElement: (t) => new El(t), createTextNode: (t) => new TextNode(t), getElementById: (id) => { if (!els.has(id)) els.set(id, new El('div')); return els.get(id); },
    addEventListener: (t, f) => { (docListeners[t] ||= []).push(f); }, body: new El('body'), activeElement: null, pointerLockElement: null, hidden: false,
  });
  const winListeners = {};   // (editor-edge-tests.mjs fires the window events: blur ...)
  setGlobal('window', { addEventListener: (t, f) => { (winListeners[t] ||= []).push(f); }, innerWidth: 1280, innerHeight: 720 });
  const { Editor } = await import('../editor/editor.js');
  const canvas = new El('canvas'), figures = new Map();
  const gfx = { canvas, scene: new THREE.Scene(), camera: { fov: 70, aspect: 16 / 9 }, aspect: 16 / 9, figures: { upsert: (id, o) => figures.set(id, o), remove: (id) => figures.delete(id) } };
  const ctx = { state: 'menu', tests: [], toasts: [], locks: 0, screen: 'menu', mapId: 'kikepzes', opened: [] };
  const app = {
    get state() { return ctx.state; }, get mapId() { return ctx.mapId; }, mode: 'solo', settings: { sens: 1 }, gfx, maps: MAPS, store,
    ui: { current: 'menu', toast: (m) => ctx.toasts.push(m) }, showScreen: (id) => { ctx.screen = id; app.ui.current = id; },
    input: { lock() { ctx.locks++; return Promise.resolve(true); }, unlock() { ctx.locks--; } },
    openEditor: async (doc) => { ctx.opened.push(doc); ctx.state = 'editor'; await ed.enter(doc); return true; },
    exitEditor: () => { ed.leave(); ctx.state = 'menu'; app.ui.current = 'menu'; },
  };
  const host = {
    calls: 0,
    async useWorld(w) { host.world = w; host.calls++; },
    beginTest({ from, pose }) { ctx.state = 'playing'; ctx.tests.push({ from, pose }); },
    endTest() { ctx.state = 'editor'; },
  };
  const ed = new Editor(app, host);
  const fire = (target, type, e = {}) => {
    const ev = { type, target, preventDefault() { ev.prevented = true; }, repeat: false, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, button: 0, clientX: 640, clientY: 360, movementX: 0, movementY: 0, deltaY: 0, ...e };
    for (const f of (target === canvas ? canvas.listeners[type] : docListeners[type]) || []) f(ev);
    if (target === canvas && type !== 'wheel' && type !== 'mousedown') for (const f of docListeners[type] || []) f(ev);
    return ev;
  };
  const press = (code, o = {}) => { const e = fire(document, 'keydown', { code, target: document.body, ...o }); fire(document, 'keyup', { code, target: document.body, ...o }); return e; };
  ctx.state = 'editor';
  await ed.enter(null);
  return { ed, D: ed.debug, app, host, ctx, press, fire, canvas, figures, store, docListeners, winListeners };
}

test('editor controller: every tool places its item (aim + click), the pad takes two clicks, the start tool moves the start; the level is rebuilt after each', async () => {
  const { ed, D, host, figures } = await openEditor();
  assert.ok(ed.ready && ed.active && host.world.map.meta.custom);
  assert.deepEqual([D.state().items, D.state().tool], [1, 'select']);
  D.setCam([0, 12, 12], 0, -45);
  let a = D.aim(0, 0);
  assert.deepEqual(a.hit.point, [0, 0, 0]);
  assert.ok(a.pick.id === 'start' || a.pick.id === 1, 'the centre ray meets the start figure standing on the floor');
  const calls0 = host.calls;
  await D.exec('tool', 'wall');
  a = D.aim(0.1, -0.1);
  assert.equal(a.ghost.t, 'block'); assert.equal(a.ghost.mat, 'wall');
  const c = await D.click();
  assert.equal(c.id, 2); assert.equal(c.sel, 2);
  assert.ok(host.calls > calls0, 'the world was rebuilt');
  assert.equal(host.world.map.brushes.length, 2);
  for (const tool of ['floor', 'walldodge', 'ramp', 'pillar', 'lava', 'laser', 'void', 'light', 'cp', 'finish', 'deco', 'deco-pillar', 'deco-rock', 'deco-crystal', 'deco-beacon', 'deco-arch']) {
    await D.exec('tool', tool);
    D.aim(0.2, -0.2);
    const r = await D.click();
    assert.ok(r.id != null && r.id !== 'start', 'placed ' + tool);
  }
  await D.exec('tool', 'pad');
  D.aim(-0.3, -0.3);
  assert.equal((await D.click()).id, null); assert.ok(D.state().padPending, 'the first click only marks the pad');
  assert.equal(ed.panel.msg.textContent, 'Most kattints a párna céljára.');
  D.aim(0.3, -0.1);
  assert.equal(D.state().ghost.t, 'pad', 'the pad ghost with its arc while the target is pending');
  assert.ok((await D.click()).id > 0); assert.equal(D.state().padPending, null);
  assert.equal(ed.panel.msg.textContent, 'Ugrópárna kész.', 'the prompt is replaced once the pad is done');
  await D.exec('tool', 'start'); D.aim(0, -0.5);
  assert.equal((await D.click()).id, 'start');
  const s = D.state();
  assert.deepEqual([s.world.brushes, s.cps, s.finish, s.world.pads, s.world.lights, s.world.deco], [6, 1, true, 1, 1, 6]);
  assert.deepEqual(ed.model.doc.items.filter((i) => i.t === 'deco').map((i) => i.kind), DECO_KINDS, 'the six deco tools made the six kinds');
  assert.equal(s.world.kills, 4, '3 kill boxes + the automatic void');
  assert.ok(figures.has('__edstart'), 'the start figure follows the document');
  assert.ok(ed.gizmos.dyn.children.length >= 4, 'trigger boxes, arcs, bulbs, numbers');
  assert.equal(D.state().lastError, null);
  // a second finish moves the first
  await D.exec('tool', 'finish'); D.aim(-0.4, -0.3);
  const fin = ed.model.finish.id;
  assert.equal((await D.click()).id, fin); assert.equal(ed.model.doc.items.filter((i) => i.t === 'finish').length, 1);
});

test('editor controller: keys and the mouse: palette keys, undo, look, fly (no Ctrl fly), wheel, typing guard, room guard, arrows, drag = one undo step', async () => {
  const { ed, D, press, fire, canvas, ctx } = await openEditor();
  D.setCam([0, 12, 12], 0, -45);
  press('Digit1'); assert.equal(ed.tool, 'floor');
  press('Digit0'); assert.equal(ed.tool, 'finish');
  press('KeyV'); assert.equal(ed.tool, 'select');
  press('Digit1');
  fire(canvas, 'mousemove', { target: canvas, clientX: 640, clientY: 500 });
  const n0 = ed.model.doc.items.length;
  fire(canvas, 'mousedown', { target: canvas, clientX: 640, clientY: 500, button: 0 }); fire(document, 'mouseup', { target: canvas, button: 0 });
  assert.equal(ed.model.doc.items.length, n0 + 1, 'a real left click places');
  press('KeyZ', { ctrlKey: true }); assert.equal(ed.model.doc.items.length, n0, 'Ctrl+Z');
  press('KeyY', { ctrlKey: true }); assert.equal(ed.model.doc.items.length, n0 + 1, 'Ctrl+Y');
  press('KeyZ', { ctrlKey: true }); press('KeyZ', { ctrlKey: true, shiftKey: true }); assert.equal(ed.model.doc.items.length, n0 + 1, 'Ctrl+Shift+Z redoes too');
  press('Escape'); assert.equal(ed.tool, 'select', 'Esc: the select tool'); press('Escape'); assert.equal(ed.sel, null, 'Esc again: no selection');
  // look and fly
  const yaw0 = ed.cam.yaw;
  fire(canvas, 'mousedown', { target: canvas, button: 2 }); assert.ok(ed.looking && ctx.locks === 1, 'right button: look + pointer lock');
  fire(canvas, 'mousemove', { target: canvas, movementX: 100, movementY: 0 }); assert.ok(ed.cam.yaw < yaw0 - 0.05, 'mouse right turns right');
  fire(document, 'mouseup', { target: canvas, button: 2 }); assert.ok(!ed.looking && ctx.locks === 0);
  fire(document, 'keydown', { code: 'KeyW', target: document.body });
  const p0 = ed.cam.pos.slice(); ed.update(0.5);
  assert.ok(ed.cam.pos.some((v, i) => Math.abs(v - p0[i]) > 1), 'held W flies');
  fire(document, 'keyup', { code: 'KeyW', target: document.body });
  fire(document, 'keydown', { code: 'KeyW', ctrlKey: true, target: document.body });
  const p1 = ed.cam.pos.slice(); ed.update(0.5);
  assert.deepEqual(ed.cam.pos, p1, 'Ctrl held: no flying (Ctrl+W closes the tab, so Ctrl is never a fly key)');
  fire(document, 'keyup', { code: 'KeyW', target: document.body });
  const sp = ed.flySpeed; fire(canvas, 'wheel', { target: canvas, deltaY: -100 }); assert.ok(ed.flySpeed > sp, 'the wheel speeds the flight up');
  press('Digit2', { target: new El('input') }); assert.equal(ed.tool, 'select', 'keys are ignored while typing in a field');
  // F2 and the room
  ctx.state = 'editor';
  press('F2'); await tick(); assert.ok(ed.testing && ctx.state === 'playing', 'F2: test from the camera');
  press('F2'); assert.ok(!ed.testing && ctx.state === 'editor', 'F2 in the test: back');
  ed.app.mode = 'room'; press('F2'); await tick(); assert.ok(!ed.testing, 'F2 is ignored in a room'); ed.app.mode = 'solo';
  press('Enter'); await tick(); assert.ok(ed.testing && ctx.tests.at(-1).from === 'start', 'Enter: test from the start point'); ed.backFromTest();
  ed.app.exitEditor(); assert.ok(!ed.ready);
  press('F2'); assert.equal(ctx.screen, 'edhome', 'F2 in the menu: the map list'); assert.ok(!ed.ready);
  press('F2'); await tick(20); assert.ok(ctx.state === 'editor' && ed.ready, 'F2 on the map list opens the editor');
  // arrows move in the camera frame, Shift + arrows resize (the min corner stays), R turns, Ctrl+D copies, Del deletes
  D.setCam([0, 12, 12], 0, -45);
  await D.exec('tool', 'floor'); D.aim(0.5, -0.3);
  const id = (await D.click()).id;
  await D.exec('tool', 'select');
  const c0 = ed.model.find(id).c.slice(), s0 = ed.model.find(id).size.slice();
  await D.key('ArrowRight'); assert.deepEqual(ed.model.find(id).c, [c0[0] + 0.5, c0[1], c0[2]], 'right = +x for a camera looking down -z');
  await D.key('ArrowUp'); assert.equal(ed.model.find(id).c[2], c0[2] - 0.5, 'up = away = -z');
  await D.key('PageUp'); assert.equal(ed.model.find(id).c[1], c0[1] + 0.5);
  await D.key('ArrowRight', { shiftKey: true });
  assert.deepEqual(ed.model.find(id).size, [s0[0] + 0.5, s0[1], s0[2]], 'Shift+right grows the +x face');
  assert.equal(ed.model.find(id).c[0], c0[0] + 0.5 + 0.25, 'the min corner stays where it was');
  await D.key('ArrowLeft', { shiftKey: true }); assert.deepEqual(ed.model.find(id).size, s0);
  await D.key('KeyR'); assert.equal(ed.model.find(id).yaw, 90);
  const before = ed.model.doc.items.length;
  await D.key('KeyD', { ctrlKey: true }); assert.equal(ed.model.doc.items.length, before + 1, 'duplicated'); assert.notEqual(ed.sel, id, 'the copy is selected');
  await D.key('Delete'); assert.equal(ed.model.doc.items.length, before);
  await D.key('KeyG'); assert.equal(D.state().grid, 0.1); await D.key('KeyG');
  // a drag is one undo step
  await D.exec('select', null);
  const entries = ed.model.history.undoStack.length, picked = D.aim(0.5, -0.3).pick;
  assert.ok(picked && picked.id != null, 'something to drag');
  const dr = await D.drag([0.5, -0.3], [0.1, -0.5]);
  assert.ok(dr.id != null);
  assert.ok(ed.model.history.undoStack.length - entries <= 1, 'the whole drag is one entry');
});

test('editor controller: the properties panel edits the selection; the camera test spawns at the camera and the pose survives; a failing rebuild never wedges the editor', async () => {
  const { ed, D, host, ctx } = await openEditor();
  D.setCam([0, 12, 12], 0, -45);
  await D.exec('tool', 'wall'); D.aim(0, 0);
  const id = (await D.click()).id;
  const inputs = ed.panel.props.find((e) => e.tagName === 'INPUT');
  assert.ok(inputs.length >= 6, 'position, size and more are numeric fields');
  inputs[0].valueAsNumber = 7; inputs[1].valueAsNumber = 2; inputs[2].valueAsNumber = 3;
  for (const f of inputs[0].listeners.input) f();
  await ed.flush();
  assert.deepEqual(ed.model.find(id).c, [7, 2, 3]);
  assert.equal(host.world.map.brushes[1].min[0], 6.5, 'the world follows');
  await D.exec('select', null);
  assert.ok(ed.panel.props.textContent.includes('Pálya'), 'no selection: the map panel');
  // a test from the start point, then from the camera
  const t1 = await D.test({ from: 'start' });
  assert.ok(t1.ok && ctx.state === 'playing' && ed.testing && ctx.tests[0].pose === null);
  assert.ok(ed.testHint(false).includes('Próba a rajttól') && !ed.testHint(true).includes('kattints'));
  assert.ok(D.back().ok && ctx.state === 'editor' && !ed.testing);
  D.setCam([40, 5, 40], 30, -10);
  const t2 = await D.test({ from: 'cam' });
  assert.ok(t2.ok);
  near(ctx.tests[1].pose.yaw, (30 * Math.PI) / 180); near(ctx.tests[1].pose.pos[1], 5 - 1.6 + 0.02, 1e-9);
  assert.match(ed.testHint(false), /^Gyakorló próba a kamerától/);
  const w = host.world;
  w.restart({ silent: true }); ed.applyTestStart();
  near(w.ps.pos[0], 40, 1e-6); assert.equal(w.cpIndex, w.cpCount);
  D.back();
  assert.deepEqual(D.state().cam, { pos: [40, 5, 40], yawDeg: 30, pitchDeg: -10 }, 'back at the exact camera pose');
  // a camera inside the wall: no test
  D.setCam([7, 0.5 + 1.6, 3], 0, 0);   // feet at 0.5: even lifted 2 m they stay inside the 4 m wall
  const t3 = await D.test({ from: 'cam' });
  assert.equal(t3.ok, false); assert.ok(ed.panel.msg.textContent.startsWith('Innen nem lehet indulni'));
  assert.ok(!ed.testing && ctx.state === 'editor');
  // a failing rebuild keeps the editor alive and the next edit tries again
  const good = host.useWorld, logError = console.error;
  host.useWorld = async () => { throw new Error('boom'); };
  console.error = () => {};   // (the editor logs the failure on purpose)
  try { await D.exec('add', 'floor', { c: [50, -0.5, 50] }); } finally { console.error = logError; }
  assert.equal(D.state().lastError, 'boom'); assert.equal(D.state().building, false);
  host.useWorld = good;
  await D.exec('add', 'floor', { c: [60, -0.5, 50] });
  assert.equal(D.state().lastError, null); assert.equal(D.state().rev, D.state().builtRev);
  // undo everything, redo everything, a theme (a removed one: no change) and a name
  assert.equal((await D.exec('setTheme', 'lavatemplom')).ok, false); await D.exec('setName', 'Teszt pálya');
  const u = ed.model.history.undoStack.length;
  for (let i = 0; i < u; i++) await D.exec('undo');
  assert.equal(ed.model.doc.items.length, 1);
  for (let i = 0; i < u; i++) await D.exec('redo');
  assert.equal(ed.model.doc.theme, 'kikepzes'); assert.equal(host.world.map.meta.name, 'Teszt pálya');
  assert.deepEqual(host.world.map.theme.palette, themeOf('kikepzes').palette);
  // leaving keeps the document for the next F2
  ed.app.exitEditor(); await ed.app.openEditor(null);
  assert.equal(ed.model.doc.name, 'Teszt pálya'); assert.ok(ed.ready);
});

// ================================================================ saved maps: store.js + editor/library.js on an in-memory localStorage
const freshStore = async (ls = memStorage()) => { setGlobal('localStorage', ls); return { ls, store: (await import('../store.js?ed=' + (++storeN))).store }; };
const K = (k) => 'pajzsugras:' + k;
const docOf = (id, name, updated, extra = {}) => ({ ...newDoc({ id, name }), updated, ...extra });
const finishDoc = (id, name = 'Végig') => {
  const m = emptyModel(); m.doc.id = id; m.doc.name = name;
  m.add(newItem('floor', { c: [0, -0.5, -25], size: [8, 1, 60] })); m.add(newItem('cp', { c: [0, 2, -12], size: [6, 4, 2] })); m.add(newItem('finish', { c: [0, 2.5, -45], size: [6, 5, 3] }));
  m.doc.updated = 1000;
  return m.doc;
};

test('store (editor maps): save / list / get / remove keep ed:index consistent; newest first; ed:last; bad ids, vanished and corrupt data', async () => {
  const { ls, store } = await freshStore();
  assert.deepEqual(store.listCustom(), []); assert.equal(store.lastCustom(), null);
  const a = docOf('aa', 'Első', 100), b = docOf('bb', 'Második', 300), c = docOf('cc', 'Harmadik', 200);
  for (const d of [a, b, c]) assert.equal(store.saveCustom(d), true);
  assert.deepEqual(store.listCustom().map((e) => e.id), ['bb', 'cc', 'aa'], 'newest first');
  assert.deepEqual(store.listCustom()[0], { id: 'bb', name: 'Második', updated: 300, n: b.items.length }, 'the entry is { id, name, updated, n }');
  assert.deepEqual(JSON.parse(ls.getItem(K('ed:index'))).map((e) => e.id).sort(), ['aa', 'bb', 'cc']);
  assert.deepEqual(store.getCustom('bb'), b, 'the document comes back as saved');
  assert.ok(ls._m.has(K('ed:map:bb')) && ls._m.has(K('ed:map:aa')));
  assert.equal(store.lastCustom(), 'cc', 'ed:last = the map saved last');
  // saving again replaces the entry (same id): still 3, the new name / time / item count
  const a2 = { ...a, name: 'Első (új)', updated: 500, items: [...a.items, { ...a.items[0], id: 99 }] };
  assert.equal(store.saveCustom(a2), true);
  assert.deepEqual(store.listCustom().map((e) => [e.id, e.name, e.n]), [['aa', 'Első (új)', a2.items.length], ['bb', 'Második', b.items.length], ['cc', 'Harmadik', c.items.length]]);
  store.setLastCustom('bb'); assert.equal(store.lastCustom(), 'bb'); store.setLastCustom('nope'); assert.equal(store.lastCustom(), 'bb', 'an unknown id is ignored');
  // remove: the document, the entry, ed:last and the personal best go; a second remove says false
  store.setCustomPB('bb', 'h', { ticks: 100, splits: [], ghost: null });
  assert.equal(store.removeCustom('bb'), true);
  assert.deepEqual(store.listCustom().map((e) => e.id), ['aa', 'cc']);
  assert.ok(!ls._m.has(K('ed:map:bb')) && !ls._m.has(K('ed:pb:bb')));
  assert.equal(store.lastCustom(), null, 'ed:last pointed at the deleted map');
  assert.equal(store.removeCustom('bb'), false); assert.equal(store.hasCustom('bb'), false); assert.equal(store.getCustom('bb'), null);
  // bad ids never reach the storage
  for (const bad of ['../x', 'A B', 'x'.repeat(25), '', 7, null, undefined]) { assert.equal(store.saveCustom({ ...a, id: bad }), false, 'save ' + bad); assert.equal(store.getCustom(bad), null); assert.equal(store.removeCustom(bad), false); }
  assert.equal(store.saveCustom(null), false); assert.equal(store.saveCustom('x'), false);
  assert.deepEqual([...ls._m.keys()].filter((k) => k.startsWith(K('ed:map:'))).sort(), [K('ed:map:aa'), K('ed:map:cc')]);
  // a document that vanished (the browser cleared it, a half-failed write) is dropped from the list; the list heals itself
  ls._m.delete(K('ed:map:aa'));
  assert.deepEqual(store.listCustom().map((e) => e.id), ['cc']); assert.equal(store.hasCustom('aa'), false);
  // corrupt data: a broken index, entries of the wrong shape, a broken document
  ls._m.set(K('ed:index'), '{bad'); assert.deepEqual(store.listCustom(), []);
  ls._m.set(K('ed:index'), JSON.stringify([{ id: 'cc', name: 7, updated: 'x', n: -3 }, { id: 'cc' }, { id: '../zz' }, null, 5, { name: 'no id' }]));
  assert.deepEqual(store.listCustom(), [{ id: 'cc', name: 'Névtelen pálya', updated: 0, n: 0 }], 'one valid entry, defaults for the junk fields, duplicates and bad ids dropped');
  ls._m.set(K('ed:map:cc'), '{bad'); assert.equal(store.getCustom('cc'), null);
  ls._m.set(K('ed:map:cc'), '[1]'); assert.equal(store.getCustom('cc'), null, 'an array is no document');
  ls._m.set(K('ed:index'), '"text"'); assert.deepEqual(store.listCustom(), []);
});

test('store (editor maps): at most CUSTOM_LIMIT maps and CUSTOM_MAX_BYTES each; fresh ids are unique and valid', async () => {
  const { ls, store } = await freshStore();
  for (let i = 0; i < CUSTOM_LIMIT; i++) assert.equal(store.saveCustom(docOf('m' + i, 'M' + i, i)), true);
  assert.equal(store.listCustom().length, CUSTOM_LIMIT);
  assert.equal(store.saveCustom(docOf('extra', 'Túl sok', 1)), false, 'the list is full');
  assert.ok(!ls._m.has(K('ed:map:extra')), 'nothing was written');
  assert.equal(store.saveCustom(docOf('m3', 'Átírt', 9)), true, 'a map that is already there can still be saved');
  assert.equal(store.listCustom().length, CUSTOM_LIMIT); assert.equal(store.getCustom('m3').name, 'Átírt');
  const { ls: ls2, store: s2 } = await freshStore();
  const huge = { ...docOf('big', 'Nagy', 1), blob: 'x'.repeat(CUSTOM_MAX_BYTES) };
  assert.equal(s2.saveCustom(huge), false, 'over 1 MB'); assert.ok(![...ls2._m.keys()].some((k) => k.includes('big')), 'and nothing written');
  const ids = new Set();
  for (let i = 0; i < 30; i++) { const id = s2.freshCustomId(); assert.match(id, /^[a-z0-9]{1,24}$/); assert.ok(!ids.has(id), 'unique'); ids.add(id); s2.saveCustom(docOf(id, 'x', i)); }
});

test('store (editor maps): blocked storage -> saveCustom false but the session keeps the map; a quota error on the document only; nothing throws', async () => {
  const { store } = await freshStore(brokenStorage());
  const d = docOf('mem', 'Csak memória', 5);
  assert.equal(store.saveCustom(d), false, 'not persisted: the caller shows the "export it" toast');
  assert.equal(store.hasCustom('mem'), true); assert.deepEqual(store.getCustom('mem'), d); assert.deepEqual(store.listCustom().map((e) => e.id), ['mem']); assert.equal(store.lastCustom(), 'mem');
  assert.equal(store.setCustomPB('mem', 'h', { ticks: 5, splits: [], ghost: null }), false);
  assert.equal(store.getCustomPB('mem', 'h').ticks, 5, 'the personal best too lives in memory');
  assert.equal(store.removeCustom('mem'), true); assert.deepEqual(store.listCustom(), []); assert.equal(store.getCustomPB('mem', 'h'), null);
  setGlobal('localStorage', undefined);
  const none = (await import('../store.js?ed=' + (++storeN))).store;
  assert.equal(none.saveCustom(d), false); assert.equal(none.hasCustom('mem'), true);
  // quota: the document does not fit, the index does
  const ls = memStorage(), put = ls.setItem;
  ls.setItem = (k, v) => { if (k.includes('ed:map:')) throw new DOMException('quota', 'QuotaExceededError'); put(k, v); };
  const { store: s2 } = await freshStore(ls);
  assert.equal(s2.saveCustom(d), false);
  assert.deepEqual(s2.getCustom('mem'), d, 'readable for this session');
  const { store: reloaded } = await freshStore(ls);   // (a new page load: only what reached the localStorage)
  assert.deepEqual(reloaded.listCustom(), [], 'the entry of a document that never got written is dropped');
});

test('editor maps: a custom personal best lives under ed:pb:<id> only: never a pb: key, checked against the map hash, deleted with the map; the built-in records are untouched', async () => {
  const { ls, store } = await freshStore();
  store.setPB('uj-palya', BUILTIN_HASH, { ticks: 6000, splits: [100, 200], ghost: 'GHOST' });
  const builtIn = () => [...ls._m.entries()].filter(([k]) => k.startsWith(K('pb:'))).sort();
  const before = builtIn();
  assert.equal(before.length, 1);
  // a saved map with a finish, played with real ticks (what main.js does around onFinish)
  const doc = finishDoc('mine');
  assert.equal(store.saveCustom(doc), true);
  const prep = lib.prepareRun(store, 'mine');
  assert.ok(prep.def && !prep.error);
  const world = createWorld(prep.def);
  const cmd = makeCmd(); cmd.fwd = 1;
  const fin = run(world, cmd, 900).find((e) => e.type === 'finish');
  assert.ok(fin, 'finished');
  assert.equal(world.map.meta.id, 'sajat-mine'); assert.equal(lib.docIdOf(world.map.meta.id), 'mine'); assert.equal(lib.docIdOf('uj-palya'), null);
  const custom = !!world.map.meta.custom, hash = world.map.mapHash;
  assert.equal(custom, true);
  assert.equal(lib.readPB(store, 'sajat-mine', hash, custom), null, 'no record yet');
  const rec = lib.recordPB(store, 'sajat-mine', hash, { ticks: fin.time, splits: fin.splits, ghost: 'AAAA' }, custom);
  assert.deepEqual(rec, { saved: true, publish: false }, 'saved, and the leaderboard never hears of it');
  assert.deepEqual([...ls._m.keys()].filter((k) => k.includes(':pb:')).sort(), [K('ed:pb:mine'), K('pb:uj-palya')], 'the only new key is ed:pb:mine');
  assert.deepEqual(builtIn(), before, 'the built-in records did not change by one byte');
  assert.equal(store.getPB('sajat-mine', null), null); assert.equal(store.getPB('mine', null), null);
  const pb = lib.readPB(store, 'sajat-mine', hash, custom);
  assert.ok(pb && pb.ticks === fin.time && pb.splits.length === 1 && pb.ghost === 'AAAA');
  assert.equal(lib.readPB(store, 'sajat-mine', 'another-hash', custom), null, 'a changed map drops the record');
  assert.equal(lib.readPB(store, 'uj-palya', BUILTIN_HASH, false).ticks, 6000, 'a built-in map reads its own pb:');
  assert.equal(lib.readPB(store, 'uj-palya', BUILTIN_HASH, true), null, 'the custom flag never falls back to a built-in key');
  // the JÁTÉK list shows that record, until the map is edited
  const entry = () => store.listCustom().find((e) => e.id === 'mine');
  let d = lib.describeMap(store, entry());
  assert.deepEqual([d.ok, d.fin, d.cps, d.hash, d.pb && d.pb.ticks], [true, true, 1, hash, fin.time]);
  const m = new DocModel(lib.loadDoc(store, 'mine'));
  m.add(newItem('wall', { c: [5, 2, -5] })); m.doc.updated = 2000;
  assert.equal(store.saveCustom(m.doc), true);
  d = lib.describeMap(store, entry());
  assert.notEqual(d.hash, hash); assert.equal(d.pb, null, 'the map changed: the old time does not count');
  // a built-in run is recorded as before and may be published; a "custom" map without a doc id writes nothing
  assert.deepEqual(lib.recordPB(store, 'beepitett', 'h1', { ticks: 7000, splits: [], ghost: null }, false), { saved: true, publish: true });
  assert.equal(store.getPB('beepitett', 'h1').ticks, 7000);
  const keys = ls._m.size;
  assert.deepEqual(lib.recordPB(store, 'not-ours', 'h', { ticks: 1, splits: [], ghost: null }, true), { saved: false, publish: false });
  assert.equal(ls._m.size, keys, 'nothing was written');
  // deleting the map takes its record along; the built-in ones stay
  assert.equal(lib.deleteMap(store, 'mine'), true);
  assert.ok(![...ls._m.keys()].some((k) => k.includes('mine')), 'no key of that map is left');
  assert.equal(store.getPB('uj-palya', BUILTIN_HASH).ticks, 6000);
});

test('editor maps: prepareRun / describeMap: no finish -> "Hiányzik a cél" and no play; a broken document is reported; rename keeps the time stamp and ed:last', async () => {
  const { ls, store } = await freshStore();
  store.saveCustom(docOf('nofin', 'Cél nélkül', 10));
  const r = lib.prepareRun(store, 'nofin');
  assert.match(r.error, /^Hiányzik a cél/); assert.equal(r.def, undefined);
  const info = lib.describeMap(store, store.listCustom()[0]);
  assert.deepEqual([info.ok, info.fin, info.cps, info.pb], [true, false, 0, null]);
  assert.match(lib.prepareRun(store, 'missing').error, /nem található/);
  ls._m.set(K('ed:map:nofin'), JSON.stringify({ v: 9 }));
  assert.match(lib.prepareRun(store, 'nofin').error, /nem található|hibás/, 'a document of a newer format cannot be played');
  const bad = lib.describeMap(store, { id: 'nofin', name: 'x', updated: 11, n: 0 });
  assert.equal(bad.ok, false); assert.match(bad.error, /hibás/);
  // rename: the name is cleaned, `updated` and ed:last stay
  store.saveCustom(finishDoc('ren', 'Régi')); store.saveCustom(finishDoc('later', 'Később'));
  assert.equal(store.lastCustom(), 'later');
  assert.equal(lib.renameMap(store, 'ren', '  <b>Új név</b>  '), true);
  const nm = store.getCustom('ren').name;
  assert.ok(!/[<>]/.test(nm) && nm.includes('Új név'), nm);
  assert.equal(store.getCustom('ren').updated, 1000, 'updated is kept (no geometry changed, the record stays valid)');
  assert.equal(store.lastCustom(), 'later', 'renaming another map does not make it the last one');
  assert.equal(lib.renameMap(store, 'ren', '   '), true); assert.equal(store.getCustom('ren').name, 'Névtelen pálya');
  assert.equal(lib.renameMap(store, 'nope', 'x'), false);
  assert.equal(lib.loadDoc(store, 'ren').items.length, finishDoc('ren').items.length, 'the items survive a rename');
  // new documents: a free id and a numbered name
  const n1 = lib.newMapDoc(store, 4242);
  assert.equal(n1.name, 'Új pálya'); assert.equal(n1.created, 4242); assert.ok(!store.hasCustom(n1.id));
  store.saveCustom(n1);
  assert.equal(lib.newMapDoc(store, 1).name, 'Új pálya 2');
});

test('editor maps: export -> import is a round trip; invalid files get Hungarian errors and change nothing; a taken id gets a fresh one; the list is limited', async () => {
  const { store } = await freshStore();
  const src = finishDoc('orig', 'Árvíztűrő tükörfúrógép');
  const f = lib.exportFile(src);
  assert.equal(f.name, 'pajzsugras-arvizturo-tukorfurogep.json', 'accents and spaces out of the file name');
  assert.deepEqual(JSON.parse(f.text), src, 'the file is the document');
  assert.equal(lib.exportName({ name: '???', id: 'abc' }), 'pajzsugras-abc.json', 'a name without letters falls back to the id');
  assert.ok(lib.exportName({ name: 'x'.repeat(80), id: 'a' }).length <= 'pajzsugras-.json'.length + 30);
  const r1 = lib.importMapText(store, f.text, 777);
  assert.ok(r1.doc && r1.saved === true && r1.renamed === false, r1.error);
  assert.deepEqual({ ...r1.doc, updated: 0, created: 0 }, { ...src, updated: 0, created: 0 }, 'the same map');
  assert.equal(r1.doc.updated, 777, 'imported now'); assert.equal(r1.doc.created, 777, 'a file without a creation time gets one');
  assert.deepEqual(store.getCustom('orig'), r1.doc);
  const r2 = lib.importMapText(store, f.text, 888);   // the same file again: a copy, the first one is not overwritten
  assert.equal(r2.renamed, true); assert.notEqual(r2.doc.id, 'orig'); assert.ok(store.hasCustom('orig') && store.hasCustom(r2.doc.id));
  assert.equal(store.getCustom('orig').updated, 777, 'the original stayed as it was'); assert.equal(store.listCustom().length, 2);
  assert.ok(lib.importMapText(store, '﻿' + f.text).doc, 'a byte order mark (Windows editors) is fine');
  assert.ok(lib.importMapText(store, JSON.parse(f.text)).doc, 'an already parsed object too');
  const n = store.listCustom().length;
  const errors = {
    '': /nem JSON/, '{': /nem JSON/, 'abc': /nem JSON/, '[]': /nem pályafájl/, 'null': /nem pályafájl/, '42': /nem pályafájl/, '"x"': /nem pályafájl/,
    '{}': /ismeretlen/, '{"v":2}': /ismeretlen/, '{"v":"1"}': /ismeretlen/, [JSON.stringify({ ...src, v: 0 })]: /ismeretlen/,
  };
  for (const [text, re] of Object.entries(errors)) { const r = lib.importMapText(store, text); assert.match(r.error || '', re, 'error for: ' + text.slice(0, 20)); assert.equal(r.doc, undefined); }
  assert.match(lib.importMapText(store, 'x'.repeat(4e6 + 1)).error, /túl nagy/);
  assert.equal(store.listCustom().length, n, 'the failed imports left no map behind');
  // a v:1 file full of junk is not an error: the junk is cleaned out, the rest is kept
  const junk = lib.importMapText(store, JSON.stringify({ v: 1, id: 'junk', name: 7, items: [{ t: 'nope' }, { t: 'block', c: [1e9, 'x', null], size: [-1, 1e9, 'a'] }, 3, null] }));
  assert.ok(junk.doc && junk.doc.items.length === 1 && junk.doc.name === 'Névtelen pálya');
  assert.ok(junk.doc.items[0].c[0] === LIM.coord && junk.doc.items[0].size[1] === LIM.sizeMax);
  // the list limit
  for (let i = store.listCustom().length; i < CUSTOM_LIMIT; i++) store.saveCustom(docOf('f' + i, 'f', i));
  assert.match(lib.importMapText(store, f.text).error, new RegExp('Legfeljebb ' + CUSTOM_LIMIT));
  assert.equal(store.listCustom().length, CUSTOM_LIMIT);
});

test('editor maps: a map saved in the days of the eight themes (theme "ontode") imports as a file, loads from the store as it was written, and plays as KIKÉPZÉS', async () => {
  const { store } = await freshStore();
  const old = { ...finishDoc('old', 'Régi pálya'), theme: 'ontode' };
  // as a file: both importers read the removed theme as the one that is left, and what is stored is the clean document
  assert.equal(importDoc(JSON.stringify(old)).doc.theme, 'kikepzes');
  const r = lib.importMapText(store, JSON.stringify(old), 5);
  assert.ok(r.doc, r.error);
  assert.equal(r.doc.theme, 'kikepzes');
  assert.equal(store.getCustom('old').theme, 'kikepzes');
  // as a document that an older version of the game wrote into this browser's storage: the stored text keeps the old theme, loading cleans it
  assert.equal(store.saveCustom({ ...old, id: 'oldraw', updated: 9 }), true);
  assert.equal(store.getCustom('oldraw').theme, 'ontode', 'the stored text is the old one');
  assert.equal(lib.loadDoc(store, 'oldraw').theme, 'kikepzes');
  const d = lib.describeMap(store, store.listCustom().find((e) => e.id === 'oldraw'));
  assert.ok(d.ok && d.fin, 'the list can still build and describe it: ' + d.error);
  for (const id of ['old', 'oldraw']) {
    const prep = lib.prepareRun(store, id);
    assert.ok(prep.def, id + ': ' + prep.error);
    assert.deepEqual(prep.def.meta.theme, themeOf('kikepzes'), id + ': the theme preset of the map');
    assert.deepEqual(prep.def.build().theme.palette, THEMES.kikepzes.palette, id + ': what the builder paints with');
    const w = createWorld(prep.def), c = makeCmd();
    c.fwd = 1;
    run(w, c, 90);
    assert.ok(w.ps.pos.concat(w.ps.vel).every(Number.isFinite), id + ': it plays');
    assert.ok(w.ps.pos[2] < -1, id + ': the player ran forward on it (-z)');
  }
});

test('editor maps: downloadText makes a Blob and a temporary <a download> and cleans up', async () => {
  const link = { style: {}, clicks: 0, click() { this.clicks++; }, remove() { this.removed = true; } }, appended = [];
  setGlobal('document', { createElement: (t) => { assert.equal(t, 'a'); return link; }, body: { append: (x) => appended.push(x) } });
  const real = URL.createObjectURL; let blob = null;
  URL.createObjectURL = (b) => { blob = b; return 'blob:test/1'; };
  try { assert.equal(lib.downloadText('p.json', '{"v":1}'), true); } finally { URL.createObjectURL = real; }
  assert.deepEqual([link.download, link.href, link.clicks, link.removed, appended.length, link.style.display], ['p.json', 'blob:test/1', 1, true, 1, 'none']);
  assert.equal(blob.type, 'application/json'); assert.equal(await blob.text(), '{"v":1}');
});

// ---------------------------------------------------------------- the controller: saving, F2, the failed write, help
test('editor controller: autosave 1.5 s after the LAST edit, before a test, on leaving and when the tab is hidden; a never-edited map is not saved; Ctrl+S; a name change is saved', async () => {
  const { ed, D, store, press, docListeners } = await openEditor();
  assert.deepEqual(store.listCustom(), [], 'opening the editor saves nothing');
  assert.equal(D.state().dirty, false); assert.equal(D.state().stored, false);
  ed.app.exitEditor(); assert.deepEqual(store.listCustom(), [], 'leaving without an edit leaves no empty map behind');
  await ed.app.openEditor(null);
  assert.ok(ed.model.rev === 0, 'the untouched new map is taken up again');
  D.setCam([0, 12, 12], 0, -45);
  await D.exec('tool', 'wall'); D.aim(0, 0); await D.click();
  const s = D.state();
  assert.ok(s.dirty && s.saveDueMs > 1300 && s.saveDueMs <= 1500, 'due in 1.5 s: ' + s.saveDueMs);
  assert.equal(ed.panel.saveState.textContent, 'Mentés…'); assert.deepEqual(store.listCustom(), [], 'not yet');
  await tick(80);
  const due1 = ed.saveAt;
  await D.exec('add', 'floor', { c: [20, -0.5, 0] });
  assert.ok(ed.saveAt > due1 + 40, 'a further edit pushes the save back (the timer restarts)');
  ed.update(0.016); assert.deepEqual(store.listCustom(), [], 'update() before the time does not save');
  ed.saveAt = performance.now() - 1; ed.update(0.016);
  assert.equal(store.listCustom().length, 1, 'saved by the timer');
  const id = ed.model.doc.id, saved = store.getCustom(id);
  assert.equal(saved.items.length, ed.model.doc.items.length); assert.ok(saved.updated > 0);
  assert.deepEqual(saved.cam, ed.model.doc.cam, 'with the camera pose');
  assert.equal(D.state().dirty, false); assert.equal(D.state().saveDueMs, null); assert.equal(ed.panel.saveState.textContent, 'Mentve');
  assert.equal(store.lastCustom(), id);
  // a rename is an edit like any other: saved (a theme change is no edit any more: the one theme is kept)
  await D.exec('setTheme', 'lavatemplom'); await D.exec('setName', 'Lávás');
  ed.saveAt = performance.now() - 1; ed.update(0.016);
  assert.equal(store.getCustom(id).theme, 'kikepzes'); assert.equal(store.getCustom(id).name, 'Lávás'); assert.equal(store.listCustom()[0].name, 'Lávás');
  // Ctrl+S saves at once, with a message (also while typing in a field: no browser dialog)
  await D.exec('add', 'cp', { c: [0, 2, -10] });
  assert.ok(D.state().dirty);
  const e1 = press('KeyS', { ctrlKey: true }); assert.ok(e1.prevented, 'the browser save dialog is suppressed');
  assert.equal(ed.panel.msg.textContent, 'Mentve: Lávás'); assert.equal(store.getCustom(id).items.length, ed.model.doc.items.length); assert.equal(D.state().dirty, false);
  await D.exec('add', 'cp', { c: [0, 2, -20] });
  const e2 = press('KeyS', { ctrlKey: true, target: new El('input') }); assert.ok(e2.prevented); assert.equal(D.state().dirty, false, 'saved while typing too');
  // before a test
  await D.exec('add', 'light', { pos: [0, 5, 0] });
  assert.ok((await D.test({ from: 'start' })).ok);
  assert.equal(store.getCustom(id).items.length, ed.model.doc.items.length, 'the test run starts from a saved state'); D.back();
  // when the tab is hidden
  await D.exec('add', 'deco', { pos: [3, 1, 3] });
  document.hidden = true;
  for (const f of docListeners.visibilitychange) f({});
  document.hidden = false;
  assert.equal(store.getCustom(id).items.length, ed.model.doc.items.length, 'a hidden tab saves');
  // on leaving
  await D.exec('add', 'lava', { c: [30, -1, 0] });
  ed.app.exitEditor();
  assert.equal(store.getCustom(id).items.length, ed.model.doc.items.length, 'leaving saves');
  assert.equal(store.listCustom().length, 1);
  // a drag does not save in the middle of the move
  await ed.app.openEditor(null);
  await D.exec('add', 'floor', { c: [40, -0.5, 0] }); ed.saveAt = performance.now() - 1; ed.drag = { id: 1 };
  const items = store.getCustom(id).items.length; ed.update(0.016);
  assert.equal(store.getCustom(id).items.length, items, 'not while a drag is on'); ed.drag = null; ed.update(0.016);
  assert.equal(store.getCustom(id).items.length, ed.model.doc.items.length);
});

test('editor controller: a failed write shows the toast that suggests the export (autosaves: once per 20 s), the map stays usable and the export still works', async () => {
  const { ed, D, ctx, store } = await openEditor({ storage: brokenStorage() });
  D.setCam([0, 12, 12], 0, -45);
  await D.exec('tool', 'wall'); D.aim(0, 0); await D.click();
  ed.saveAt = performance.now() - 1; ed.update(0.016);
  assert.equal(ctx.toasts.length, 1); assert.match(ctx.toasts[0], /Exportálás/); assert.match(ed.panel.msg.textContent, /^Nincs mentve/);
  assert.equal(ed.panel.saveState.textContent, 'Nincs mentve!'); assert.equal(ed.panel.msg.className, 'ed-msg bad');
  await D.exec('add', 'floor', { c: [20, -0.5, 0] });
  ed.saveAt = performance.now() - 1; ed.update(0.016);
  assert.equal(ctx.toasts.length, 1, 'the next autosave does not toast again');
  assert.equal(ed.save(), false); assert.equal(ctx.toasts.length, 2, 'but an explicit save always tells');
  assert.equal(store.hasCustom(ed.model.doc.id), true, 'the map is in memory for this session');
  assert.equal(D.save().ok, false);
  // the export does not need the storage
  const clicks0 = El.clicks || 0;
  assert.equal(ed.exportMap(), true);
  assert.equal(El.clicks, clicks0 + 1); assert.match(ed.panel.msg.textContent, /^Exportálva: pajzsugras-.*\.json/);
  assert.equal(importDoc(D.exportText()).doc.items.length, ed.model.doc.items.length, 'the exported text imports back');
});

test('editor controller: F2 from the menu = the map list, on the list = the last map, on a built-in map = last or new, on a custom map = that map; open by id keeps the history; deleted maps are not taken back', async () => {
  const { ed, D, press, ctx, store, app } = await openEditor();
  const mine = finishDoc('mine', 'Enyém'), other = finishDoc('other', 'Másik'); other.updated = 2000;
  store.saveCustom(mine); store.saveCustom(other);   // (the last saved: 'other')
  ed.app.exitEditor();
  // the menu
  ctx.mapId = 'kikepzes'; ctx.state = 'menu'; app.ui.current = 'menu';
  press('F2'); assert.equal(ctx.screen, 'edhome'); assert.ok(!ed.ready);
  press('F2'); await tick(20); assert.ok(ed.ready); assert.equal(ed.model.doc.id, 'other', 'the last edited map (not the untouched new one)');
  ed.app.exitEditor();
  // a built-in map being played: the last edited map
  ctx.state = 'playing'; ctx.mapId = 'ontode'; ctx.opened.length = 0;
  press('F2'); await tick(20);
  assert.deepEqual(ctx.opened, [undefined]); assert.equal(ed.model.doc.id, 'other'); ed.app.exitEditor();
  // a custom map being played: that map
  ctx.state = 'paused'; ctx.mapId = 'sajat-mine'; ctx.opened.length = 0;
  press('F2'); await tick(20);
  assert.deepEqual(ctx.opened, ['mine']); assert.equal(ed.model.doc.id, 'mine'); assert.equal(store.lastCustom(), 'mine', 'opening makes it the last one');
  ed.app.exitEditor();
  // ... but one that was deleted meanwhile: the usual (last or new)
  ctx.state = 'playing'; ctx.mapId = 'sajat-gone'; ctx.opened.length = 0;
  press('F2'); await tick(20);
  assert.deepEqual(ctx.opened, [undefined]); assert.equal(ed.model.doc.id, 'mine'); ed.app.exitEditor();
  // open by id: the model of this session (and its undo history) is kept; a document object replaces it
  await app.openEditor('mine'); const m0 = ed.model;
  D.setCam([0, 12, 12], 0, -45);
  await D.exec('tool', 'wall'); D.aim(0, 0); await D.click();
  assert.ok(ed.model.history.canUndo);
  ed.app.exitEditor(); await app.openEditor('mine');
  assert.equal(ed.model, m0, 'same model: the undo history survived leaving'); assert.ok(ed.model.history.canUndo);
  ed.app.exitEditor(); await app.openEditor('other'); assert.equal(ed.model.doc.id, 'other'); assert.notEqual(ed.model, m0);
  ed.app.exitEditor(); await app.openEditor(finishDoc('mine', 'Enyém')); assert.notEqual(ed.model, m0, 'a document object is loaded as given');
  ed.app.exitEditor();
  // unknown ids and broken documents: a toast and a usable editor
  ctx.toasts.length = 0;
  await app.openEditor('nincs-ilyen'); assert.ok(ed.ready && ctx.toasts.some((t) => /nem található/.test(t))); ed.app.exitEditor();
  await app.openEditor({ v: 7 }); assert.ok(ed.ready && ctx.toasts.some((t) => /hibás/.test(t))); ed.app.exitEditor();
  // deleted in the menus: even without forget() the deleted map is not taken back by F2; forget() drops the copy kept in memory
  await app.openEditor('mine'); D.setCam([0, 12, 12], 0, -45); await D.exec('tool', 'wall'); D.aim(0, 0); await D.click(); ed.app.exitEditor();
  lib.deleteMap(store, 'mine');
  await app.openEditor(null);
  assert.notEqual(ed.model.doc.id, 'mine', 'the deleted map is not resurrected'); assert.ok(!store.hasCustom('mine'));
  ed.app.exitEditor();
  await app.openEditor('other'); ed.app.exitEditor();
  ed.forget('other'); assert.equal(ed.model, null, 'forget() drops the kept copy');
  await app.openEditor(null); assert.equal(ed.model.doc.id, 'other', 'and the next F2 reads it from the store (the last one)');
});

test('editor controller: help (H; Esc closes it first), the validation messages stay under every selection, the deco palette group, the Mentés / Exportálás buttons', async () => {
  const { ed, D, press } = await openEditor();
  D.setCam([0, 12, 12], 0, -45);
  const txt = () => ed.panel.props.textContent;
  assert.ok(txt().includes('Hiányzik a cél: tegyél le egy célt, különben a pálya nem teljesíthető.'), 'the map panel shows the warning');
  await D.exec('tool', 'wall'); D.aim(0, 0); await D.click();
  assert.ok(ed.sel != null && txt().includes('Tömb'), 'an item is selected');
  assert.ok(txt().includes('Hiányzik a cél'), 'the warning stays under the properties of a selected item too');
  assert.ok(txt().includes('A rajtpont szilárd elemben'), 'the wall landed on the start point: found with the built world, as soon as the rebuild is done');
  await D.exec('setStart', [3.5, 0, 3.5], 0);
  await D.exec('tool', 'finish'); D.aim(0.3, -0.3); await D.click();
  assert.ok(!txt().includes('Hiányzik a cél') && txt().includes('Nincs figyelmeztetés'), 'a finish clears it');
  await D.exec('setStart', [90, 0, 90], 0);
  assert.ok(txt().includes('A rajtpont alatt nincs padló.'));
  // help
  assert.equal(ed.panel.help.hidden, true);
  press('KeyH'); assert.equal(ed.panel.help.hidden, false);
  const help = ed.panel.help.textContent;
  for (const word of ['Ctrl + S', 'Exportálás', 'Backspace', 'Ctrl + Shift + Z', 'boltív', 'jelzőfény', 'F2', 'Tab', 'Enter', 'Görgő', 'Shift + nyilak', 'Ctrl + D']) assert.ok(help.includes(word), 'the help lists ' + word);
  const sel0 = ed.sel; press('Escape'); assert.equal(ed.panel.help.hidden, true, 'Esc closes the help first'); assert.equal(ed.sel, sel0, 'and keeps the selection');
  press('KeyH'); press('KeyH'); assert.equal(ed.panel.help.hidden, true);
  // the deco group: six palette buttons
  assert.deepEqual(['deco', 'deco-pillar', 'deco-rock', 'deco-crystal', 'deco-beacon', 'deco-arch'].map((id) => ed.panel.palBtns.has(id)), [true, true, true, true, true, true]);
  assert.ok(ed.panel.pal.textContent.includes('Díszek') && ed.panel.pal.textContent.includes('Jelzőfény') && ed.panel.pal.textContent.includes('Boltív'));
  ed.setTool('deco-arch'); assert.equal(ed.tool, 'deco-arch'); assert.match(ed.hintText(), /^Dísz: Boltív: kattints/);
  // the top bar
  assert.ok(ed.panel.top.textContent.includes('Mentés') && ed.panel.top.textContent.includes('Exportálás') && ed.panel.top.textContent.includes('Kilépés'));
});
