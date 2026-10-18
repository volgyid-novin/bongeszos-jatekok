// tools/add-map.mjs (npm run add-map): an export of the editor becomes a built-in map. Everything runs in a temporary copy of the maps folder's
// index.js; the real maps/ is only read (the repo's own registry is checked for the markers the script needs).
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test, assert } from './harness.mjs';
import { addMap, register, slug, validId, ident, isLocalMapPath } from '../tools/add-map.mjs';
import { serialise, sanitizeDoc } from '../editor/model.js';
import { builtinDef } from '../editor/convert.js';
import { MAPS } from '../maps/index.js';
import ujPalya from '../maps/uj-palya.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(ROOT, 'tools', 'add-map.mjs');
const REPO_INDEX = readFileSync(join(ROOT, 'maps', 'index.js'), 'utf8');

// a temporary "pajzsugras" folder: maps/index.js is a copy of the real registry
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'pj-addmap-'));
  mkdirSync(join(root, 'maps'));
  writeFileSync(join(root, 'maps', 'index.js'), REPO_INDEX);
  return { root, file: (id) => join(root, 'maps', id + '.js'), index: () => readFileSync(join(root, 'maps', 'index.js'), 'utf8'), done: () => rmSync(root, { recursive: true, force: true }) };
}
const docText = (over = {}) => JSON.stringify({ ...ujPalya, ...over });
const load = (file) => import(pathToFileURL(file).href + '?t=' + Math.random()).then((m) => m.default);

test('add-map: names and ids - "Új pálya" -> uj-palya, accents and symbols go, reserved and sajat- ids are refused', () => {
  assert.equal(slug('Új pálya'), 'uj-palya');
  assert.equal(slug('  Tűzhányó #2!  '), 'tuzhanyo-2');
  assert.equal(slug('ŐŰ ő ű'), 'ou-o-u');
  assert.equal(slug('???'), '');
  for (const ok of ['uj-palya', 'a', '2-palya', 'x'.repeat(31)]) assert.ok(validId(ok), ok);
  for (const bad of ['', 'Uj', 'uj palya', '-x', 'index', 'themes', 'sajat-x', '../x', 'a/b', 'x'.repeat(32), null, 7]) assert.ok(!validId(bad), String(bad));
});

test('add-map: register() puts the import and the entry between the markers, once, keeps the order, and refuses an index without markers', () => {
  const a = register(REPO_INDEX, 'masodik-palya');
  assert.ok(a.added && a.order === MAPS.ids.length + 1);
  assert.match(a.text, /import map_masodik_palya from '\.\/masodik-palya\.js';\n\/\/ <\/add-map imports>/);
  assert.match(a.text, /  \['masodik-palya', map_masodik_palya\],\n  \/\/ <\/add-map entries>/);
  const again = register(a.text, 'masodik-palya');
  assert.ok(!again.added && again.text === a.text && again.order === a.order, 'a second registration changes nothing');
  assert.equal(register(a.text, 'uj-palya').order, 1, 'an existing map keeps its position');
  const crlf = register(REPO_INDEX.replace(/\n/g, '\r\n'), 'x1');
  assert.ok(crlf.text.split('\n').every((l, i, arr) => i === arr.length - 1 || l.endsWith('\r')), 'CRLF stays CRLF');
  assert.throws(() => register('export default {};\n', 'x'), /jelölők/);
  assert.throws(() => register(REPO_INDEX.replace('// <add-map entries>', ''), 'x'), /jelölők/);
});

test('add-map: round trip - an editor export becomes maps/<id>.js (plain JSON, the same document), is registered, loads as a built-in map; the same id updates it in place', async () => {
  const sb = sandbox();
  try {
    const r1 = addMap({ text: docText({ name: 'Második pálya' }), id: 'masodik', root: sb.root });
    assert.deepEqual([r1.id, r1.created, r1.order, r1.name, r1.items], ['masodik', true, MAPS.ids.length + 1, 'Második pálya', ujPalya.items.length]);
    assert.ok(existsSync(sb.file('masodik')));
    const text = readFileSync(sb.file('masodik'), 'utf8');
    assert.match(text, /^\/\/ Built-in map masodik, exported from the in-game editor\./);
    assert.ok(!text.split('\n')[0].includes('Második'), 'no text of the document in the comment');
    assert.match(text, /\nexport default \{\n {2}"v": 1,/);
    const doc = await load(sb.file('masodik'));
    assert.deepEqual(doc, sanitizeDoc(JSON.parse(docText({ name: 'Második pálya' }))), 'the module holds the cleaned document');
    assert.equal(serialise(doc), serialise(sanitizeDoc(JSON.parse(docText({ name: 'Második pálya' })))));
    const idx = sb.index();
    assert.match(idx, /import map_masodik from '\.\/masodik\.js';/); assert.match(idx, /\['masodik', map_masodik\],/);
    // it builds as a built-in map in the order the registry gave
    const def = builtinDef(doc, 'masodik', r1.order);
    const map = def.build();
    assert.deepEqual([def.meta.exported, def.meta.custom, def.meta.authorTime, def.meta.order, def.meta.diff], [true, undefined, 0, r1.order, 'nincs']);
    const count = (pred) => ujPalya.items.filter(pred).length;
    assert.ok(map.brushes.length === count((i) => i.t === 'block' || i.t === 'ramp' || i.t === 'prism') && map.checkpoints.length === count((i) => i.t === 'cp') && (map.finish !== null) === (count((i) => i.t === 'finish') > 0), 'a solid item makes a brush, a cp a checkpoint, the finish the finish');
    // updating: a changed document under the same id replaces the file, the index and the order stay
    const idxBefore = sb.index();
    const changed = JSON.parse(docText({ name: 'Második pálya' }));
    changed.items = changed.items.slice(0, 5);
    const r2 = addMap({ text: JSON.stringify(changed), id: 'masodik', root: sb.root });
    assert.deepEqual([r2.created, r2.order, r2.items], [false, r1.order, 5]);
    assert.equal(sb.index(), idxBefore, 'the registry is untouched by an update');
    assert.equal((await load(sb.file('masodik'))).items.length, 5);
    // another map goes to the end
    const r3 = addMap({ text: docText({ name: 'Harmadik' }), root: sb.root });
    assert.deepEqual([r3.id, r3.order], ['harmadik', r1.order + 1], 'the id comes from the name');
    assert.ok(sb.index().indexOf("['masodik', map_masodik]") < sb.index().indexOf("['harmadik', map_harmadik]"));
    assert.deepEqual(readdirSync(join(sb.root, 'maps')).sort(), ['harmadik.js', 'index.js', 'masodik.js'], 'no temporary files left');
  } finally { sb.done(); }
});

test('add-map: the generated file of the repo\'s own map is exactly what the script writes for its document (re-exporting from the editor is a clean diff)', () => {
  const sb = sandbox();
  try {
    addMap({ text: JSON.stringify(ujPalya), id: 'uj-palya', root: sb.root });
    assert.equal(readFileSync(sb.file('uj-palya'), 'utf8').replace(/\r\n/g, '\n'), readFileSync(join(ROOT, 'maps', 'uj-palya.js'), 'utf8').replace(/\r\n/g, '\n'));
    assert.equal(sb.index(), REPO_INDEX, 'uj-palya is already registered: the index does not change');
  } finally { sb.done(); }
});

test('add-map: a bad file or id changes nothing - not JSON, a wrong version, a bad id, a document that cannot be built - with Hungarian messages', () => {
  const sb = sandbox();
  try {
    const before = () => readdirSync(join(sb.root, 'maps')).sort().join() + '|' + sb.index();
    const snapshot = before();
    const fails = (opts, re) => { assert.throws(() => addMap({ root: sb.root, ...opts }), re, JSON.stringify(opts).slice(0, 60)); assert.equal(before(), snapshot, 'nothing written'); };
    fails({ text: 'ez nem json', id: 'x' }, /nem érvényes pályafájl/);
    fails({ text: '[1,2]', id: 'x' }, /nem pályafájl/);
    fails({ text: docText({ v: 2 }), id: 'x' }, /formátuma ismeretlen/);
    for (const id of ['Nagy', 'index', 'sajat-egy', '../kint', 'szóköz van']) fails({ text: docText(), id }, /Rossz azonosító/);
    fails({ text: docText({ name: '???' }) }, /Rossz azonosító/);   // a name that gives no id
    // too many cells for the collision grid: refused by the importer
    fails({ text: docText({ items: [{ id: 1, t: 'block', c: [0, 0, 0], size: [400, 400, 400], yaw: 0, mat: 'floor' }, ...Array.from({ length: 20 }, (_, i) => ({ id: i + 2, t: 'block', c: [i, 0, 0], size: [400, 400, 400], yaw: 0, mat: 'floor' }))] }), id: 'nagy' }, /túl nagy/);
  } finally { sb.done(); }
});

test('add-map: the command line - npm script "add-map", --help, a missing file and a bad id exit non-zero with a message and write nothing', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, '..', 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['add-map'], 'node pajzsugras/tools/add-map.mjs');
  const help = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0); assert.match(help.stdout, /npm run add-map/);
  const none = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(none.status, 1);
  const missing = spawnSync(process.execPath, [SCRIPT, join(tmpdir(), 'nincs-ilyen-fajl.json')], { encoding: 'utf8' });
  assert.equal(missing.status, 1); assert.match(missing.stderr, /Nem olvasható/);
  const bad = spawnSync(process.execPath, [SCRIPT, join(ROOT, 'maps', 'uj-palya.js'), 'x'], { encoding: 'utf8' });   // (a .js module is no JSON)
  assert.equal(bad.status, 1); assert.match(bad.stderr, /Hiba: .*nem érvényes pályafájl/);
  assert.equal(readFileSync(join(ROOT, 'maps', 'index.js'), 'utf8'), REPO_INDEX, 'the real registry was not touched');
  assert.ok(!existsSync(join(ROOT, 'maps', 'x.js')));
});

test('add-map: a file inside a local-maps folder (a map ported from somebody else\'s UT2004 map) is refused by the command line: it must stay local, a built-in map is committed', () => {
  assert.equal(isLocalMapPath(join(ROOT, 'local-maps', 'x.json')), true);
  assert.equal(isLocalMapPath(join('a', 'Local-Maps', 'b', 'x.json')), true, 'any case, any depth');
  assert.equal(isLocalMapPath(join(ROOT, 'maps', 'uj-palya.js')), false);
  assert.equal(isLocalMapPath(join(ROOT, 'maps', 'local-maps-x.json')), false, 'a folder of exactly that name only');
  const dir = mkdtempSync(join(tmpdir(), 'pj-localmaps-'));
  try {
    mkdirSync(join(dir, 'local-maps'));
    const file = join(dir, 'local-maps', 'x.json');
    writeFileSync(file, '{}');   // (not a map: were the place not the reason, the message would be another one, and nothing would be written either way)
    const r = spawnSync(process.execPath, [SCRIPT, file], { encoding: 'utf8' });
    assert.equal(r.status, 1); assert.match(r.stderr, /csak helyben maradhat/);
    assert.equal(readFileSync(join(ROOT, 'maps', 'index.js'), 'utf8'), REPO_INDEX, 'the real registry was not touched');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- ids, names and the registry that must always parse
const parses = (text) => spawnSync(process.execPath, ['--input-type=module', '--check'], { input: text, encoding: 'utf8' }).status === 0;
const chars = (...codes) => codes.map((c) => String.fromCharCode(c)).join('');

test('add-map: ids - one group of letters / digits per dash only (no a--b, abc-, -a), no Windows device names; the import name map_<id> is valid and different for every id', () => {
  for (const ok of ['a-b2', 'a1', 'a-1', 'x'.repeat(31), 'default', 'class', 'void', 'list', 'by-id', 'builtin-def', 'aux1', 'comx']) assert.ok(validId(ok), ok);
  for (const bad of ['a--b', 'abc-', '-abc', 'a_b', 'a b', 'A', 'con', 'prn', 'aux', 'nul', 'com1', 'com9', 'lpt1', 'sajat-x', 'index', 'themes', 'ő']) assert.ok(!validId(bad), bad);
  assert.equal(slug('x'.repeat(29) + ' y'), 'x'.repeat(29), 'a name cut inside a dash group does not end in a dash');
  assert.equal(ident('uj-palya'), 'map_uj_palya');
  const ids = ['a1', 'a-1', 'a', 'a-b', 'ab', 'a-b-c', 'void', 'default', 'class', 'new', 'true', 'let', 'eval', 'list', 'by-id', 'byid', 'builtin-def', 'builtindef', '1', '2-palya', 'x'.repeat(31)];
  assert.equal(new Set(ids.map(ident)).size, ids.length, 'one name per id');
  let all = REPO_INDEX;
  for (const id of ids) {
    const r = register(REPO_INDEX, id);
    assert.ok(parses(r.text), `${id}: maps/index.js still parses`);
    all = register(all, id).text;
  }
  assert.ok(parses(all), 'all of them in one registry');
});

test('add-map: an id whose import name is taken, a bad id or a registry that does not parse is refused before anything is written', () => {
  const sb = sandbox();
  try {
    const snap = () => readdirSync(join(sb.root, 'maps')).sort().join() + '|' + sb.index();
    const fails = (opts, re) => { const before = snap(); assert.throws(() => addMap({ root: sb.root, text: docText(), ...opts }), re, JSON.stringify(opts)); assert.equal(snap(), before, 'nothing written'); };
    for (const id of ['a--b', 'abc-', 'nul', 'con']) fails({ id }, /Rossz azonosító/);
    assert.throws(() => register(REPO_INDEX, 'a--b'), /Rossz azonosító/, 'register() checks the id itself');
    // a hand-written name of index.js that is the import name of the new id
    writeFileSync(join(sb.root, 'maps', 'index.js'), REPO_INDEX.replace('// </add-map imports>', 'const map_foo = 1;\n// </add-map imports>'));
    fails({ id: 'foo' }, /már szerepel/);
    // a registry that does not parse: the generated text is checked, no map file, no index change
    writeFileSync(join(sb.root, 'maps', 'index.js'), REPO_INDEX + '\nconst = ;\n');
    fails({ id: 'bar' }, /generált kód hibás/);
    assert.ok(!existsSync(sb.file('bar')));
  } finally { sb.done(); }
});

test('add-map: no text of the document is in a comment or in code - the first line is fixed text, a name with line separators / bidi controls is cleaned at import, the module holds the document as data', async () => {
  const sb = sandbox();
  try {
    const evil = chars(0x2028, 0x2029, 0x85, 0x7f, 0x9f, 0x202a, 0x202e, 0x2066, 0x2069);
    const r = addMap({ text: docText({ name: 'Név' + evil + 'x<b>\n' }), id: 'tiszta', root: sb.root });
    assert.equal(r.name, 'Névxb', 'the importer cleaned the name');
    const text = readFileSync(r.file, 'utf8');
    assert.equal(text.split('\n')[0], '// Built-in map tiszta, exported from the in-game editor. Replace it with: npm run add-map -- <new export.json> tiszta');
    assert.ok(![...text].some((ch) => [0x2028, 0x2029, 0x85].includes(ch.codePointAt(0))), 'no line terminator but newline in the module');
    assert.equal((await load(r.file)).name, 'Névxb');
    // the same for the editor model: a rename keeps no such character either
    const { DocModel, newDoc } = await import('../editor/model.js');
    const m = new DocModel(newDoc());
    m.setName('Egy' + evil + 'Kettő');
    assert.equal(m.doc.name, 'EgyKettő');
  } finally { sb.done(); }
});

test('registry: builtinDef cleans a hand-edited document with the importer\'s limits (sizes, name) and refuses one that is no map file; an empty registry loads', async () => {
  const hand = { ...ujPalya, name: 'Kéz<b>' + chars(0x2028) + 'i', items: [{ id: 1, t: 'block', c: [0, -0.5, 0], size: [1e9, -5, 'x'], yaw: 45, mat: 'nincs-ilyen' }, { id: 2, t: 'virus' }] };
  const def = builtinDef(hand, 'kez', 1);
  assert.equal(def.meta.name, 'Kézbi', 'name cleaned');
  const map = def.build();
  assert.equal(map.brushes.length, 1, 'the unknown item type is gone');
  const b = map.brushes[0];
  const ext = [0, 1, 2].map((k) => b.max[k] - b.min[k]);
  assert.ok(Math.max(...ext) > 399 && Math.max(...ext) <= 400.01 && Math.min(...ext) >= 0.09, 'sizes clamped to 0.1 .. 400 m: ' + ext.join(', '));
  assert.throws(() => builtinDef({ v: 2 }, 'rossz', 1), /„rossz” beépített pálya nem érvényes/);
  assert.throws(() => builtinDef(null, 'rossz', 1), /nem érvényes/);
  // an empty registry (no add-map yet): the module loads, nothing in it
  const sb = sandbox();
  try {
    const empty = REPO_INDEX.replace("import map_uj_palya from './uj-palya.js';\n", '').replace("  ['uj-palya', map_uj_palya],\n", '');
    assert.ok(!empty.includes('uj-palya'), 'the test registry is empty');
    const file = join(sb.root, 'maps', 'registry.mjs');
    writeFileSync(file, empty.replace("'../editor/convert.js'", `'${pathToFileURL(join(ROOT, 'editor', 'convert.js')).href}'`));
    const { MAPS: M } = await import(pathToFileURL(file).href + '?t=' + Math.random());
    assert.deepEqual([M.list.length, M.ids.length, M.get('uj-palya'), M.has('uj-palya')], [0, 0, null, false]);
  } finally { sb.done(); }
});
