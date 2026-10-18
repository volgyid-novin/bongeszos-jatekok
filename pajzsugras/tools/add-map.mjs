// Adds (or updates) a built-in map from a map file exported by the in-game editor.
//
//     npm run add-map -- <export.json> [id]
//
// Writes pajzsugras/maps/<id>.js (`export default { ...the map document... }`, plain JSON: the document is only data in the file, no text of
// it is in a comment or in code) and registers it in pajzsugras/maps/index.js between the <add-map ...> markers (a new map goes to the end of
// the list; with an existing id only the file is replaced and the position stays). id: lowercase letters and digits in groups divided by
// single dashes ("a-b2", not "a--b" or "abc-"); without it it comes from the name of the map ("Új pálya" -> uj-palya). The import name in
// index.js is map_<id with underscores> (ident()): a valid name for every id, never a reserved word or a name of index.js, one per id.
// The file is read with the same importer as the editor (editor/model.js importDoc), the map is built once and both generated texts are
// syntax-checked before anything is written, so a broken file or an id that would break the registry changes nothing. Epic data is not
// involved: a map is only boxes.
//
// addMap({ text, id, root }) is the same as a function (root: the pajzsugras folder, default: this one), used by the tests.
// A file inside a folder called local-maps (pajzsugras/local-maps/: maps ported from somebody else's UT2004 map by tools/ut2004_map.py, git-ignored, local only)
// is refused by the command line (isLocalMapPath): a built-in map is committed and deployed.
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve, dirname } from 'node:path';
import { importDoc, serialise, validate } from '../editor/model.js';
import { builtinDef } from '../editor/convert.js';
import { THEMES } from '../editor/themes.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..');
const RESERVED = new Set(['index', 'themes']);
const DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;   // (Windows device names: maps/nul.js is no file there)

// "Új pálya" -> "uj-palya"
export function slug(name) {
  return String(name).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/ő/g, 'o').replace(/ű/g, 'u').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '');
}
export const validId = (id) => typeof id === 'string' && id.length <= 31 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)
  && !id.startsWith('sajat-') && !RESERVED.has(id) && !DEVICE.test(id);
const badId = (id) => new Error(`Rossz azonosító: "${id}". Kisbetű és szám lehet benne, a csoportokat egy-egy kötőjel választja el (legfeljebb 31 jel), „sajat-” nem lehet az eleje.`);
// the import name of an id in maps/index.js: injective (an id has no underscore, so the dashes come back) and always a valid name
export const ident = (id) => 'map_' + id.replace(/-/g, '_');

// the document as readable JSON: one line per top-level key, one per item (a small diff when a map is re-exported)
function format(doc) {
  const out = JSON.parse(serialise(doc));
  const lines = Object.entries(out).map(([k, v]) => {
    if (k === 'items') return `  "items": [\n${v.map((it) => '    ' + JSON.stringify(it)).join(',\n')}\n  ]`;
    return `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`;
  });
  // (U+2028 / U+2029 are legal in a JS string since ES2019, but as escapes no tool or reader takes them for a line end)
  return `{\n${lines.join(',\n')}\n}`.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

// (no text of the document in the comment: a comment ends at any line terminator, and a map name is somebody else's text)
const moduleText = (id, doc) => `// Built-in map ${id}, exported from the in-game editor. Replace it with: npm run add-map -- <new export.json> ${id}\n`
  + `export default ${format(doc)};\n`;

// '' when the text parses as an ES module (node --check, from stdin: the early errors such as a name declared twice too), else the error line
function syntaxError(text) {
  const r = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: text, encoding: 'utf8' });
  if (r.status === 0) return '';
  return (String(r.stderr).split('\n').find((l) => /Error/.test(l)) || (r.error && r.error.message) || 'szintaktikai hiba').trim();
}

function atomicWrite(file, text) {
  const tmp = file + '.tmp';
  try { writeFileSync(tmp, text, 'utf8'); renameSync(tmp, file); } catch (e) { try { unlinkSync(tmp); } catch { /* nothing to remove */ } throw e; }
}

// register id in the index text between the markers: -> { text, added, order } (order: the position of the map in the list, from 1)
export function register(indexText, id) {
  if (!validId(id)) throw badId(id);
  const nl = indexText.includes('\r\n') ? '\r\n' : '\n';
  const lines = indexText.split(/\r?\n/);
  const at = (s) => lines.findIndex((l) => l.trim() === s);
  const i0 = at('// <add-map imports>'), i1 = at('// </add-map imports>'), e0 = at('// <add-map entries>'), e1 = at('// </add-map entries>');
  if (i0 < 0 || i1 < i0 || e0 < 0 || e1 < e0) throw new Error('A maps/index.js-ből hiányoznak a <add-map imports> / <add-map entries> jelölők.');
  const entries = () => lines.slice(e0 + 1, e1).filter((l) => /^\s*\['/.test(l));
  const have = entries().findIndex((l) => l.includes(`'${id}'`));
  if (have >= 0) return { text: indexText, added: false, order: have + 1 };
  const name = ident(id), order = entries().length + 1;
  if (new RegExp(`\\b${name}\\b`).test(indexText)) throw new Error(`A(z) „${id}” azonosítóból készülő név (${name}) már szerepel a maps/index.js-ben.`);
  lines.splice(e1, 0, `  ['${id}', ${name}],`);   // (the later block first: the earlier line numbers stay valid)
  lines.splice(i1, 0, `import ${name} from './${id}.js';`);
  return { text: lines.join(nl), added: true, order };
}

// -> { id, file, created (a new map), order, notes[] }; throws an Error with a Hungarian message
export function addMap({ text, id = null, root = ROOT }) {
  const r = importDoc(text);
  if (r.error) throw new Error(r.error);
  const doc = r.doc;
  id = id || slug(doc.name);
  if (!validId(id)) throw badId(id);
  const index = join(root, 'maps', 'index.js'), file = join(root, 'maps', id + '.js');
  const indexText = readFileSync(index, 'utf8');
  const reg = register(indexText, id);   // (throws when the import name is taken)
  const order = reg.order;
  const def = builtinDef(doc, id, order);
  const map = def.build();   // throws when the map cannot be built: nothing is written yet
  const src = moduleText(id, doc), bad = syntaxError(src) || (reg.added ? syntaxError(reg.text) : '');
  if (bad) throw new Error(`A generált kód hibás (${bad}), semmi nem íródott ki.`);
  const notes = [];
  if (!Object.hasOwn(THEMES, doc.theme)) notes.push(`Ismeretlen téma („${doc.theme}”): a KIKÉPZÉS téma lesz.`);
  const v = validate(doc);
  notes.push(...v.errors, ...v.warnings);
  if (!map.finish) notes.push('Cél nélkül a pálya szabadon játszható, de nincs a ranglistán, és a szobában sem választható.');
  const created = !existsSync(file);
  atomicWrite(file, src);
  if (reg.added) {
    try { atomicWrite(index, reg.text); } catch (e) { if (created) { try { unlinkSync(file); } catch { /* nothing to remove */ } } throw e; }   // (no map file without its registry line)
  }
  return { id, file, created, order, name: doc.name, items: doc.items.length, notes };
}

// true: the path (also through a link) has a folder called local-maps in it
export function isLocalMapPath(p) {
  const inside = (q) => resolve(q).split(/[\\/]+/).some((seg) => seg.toLowerCase() === 'local-maps');
  let real = '';
  try { real = realpathSync(p); } catch { /* not there: the plain path is all there is */ }
  return inside(p) || (real !== '' && inside(real));
}

function main(argv) {
  const [src, id] = argv;
  if (!src || src === '-h' || src === '--help') {
    console.log('Használat: npm run add-map -- <export.json> [azonosító]\n  A szerkesztőből exportált pályafájlból beépített pályát csinál (pajzsugras/maps/<azonosító>.js), és felveszi a maps/index.js-be.\n  Azonosító nélkül a pálya nevéből készül („Új pálya” -> uj-palya). Ugyanazzal az azonosítóval újra futtatva frissíti a pályát.');
    return src ? 0 : 1;
  }
  if (isLocalMapPath(src)) { console.error('Hiba: a local-maps mappa fájlját nem lehet beépített pályává tenni: a más szerzőtől átalakított pálya csak helyben maradhat.'); return 1; }
  let text;
  try { text = readFileSync(resolve(src), 'utf8'); } catch (e) { console.error(`Nem olvasható a fájl: ${src} (${e.code || e.message})`); return 1; }
  try {
    const r = addMap({ text, id });
    for (const n of r.notes) console.log('  figyelem: ' + n);
    console.log(`${r.created ? 'Új beépített pálya' : 'Frissítve'}: „${r.name}” (${r.id}), ${r.items} elem, a ${r.order}. pálya -> ${r.file}`);
    console.log('Ellenőrzés: npm run test:pj');
    return 0;
  } catch (e) {
    console.error('Hiba: ' + e.message);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));
