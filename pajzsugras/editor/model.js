// PAJZSUGRÁS map editor, the document model. Pure (no DOM, no three, no Date): node-testable (test/editor-tests.mjs).
//
//   doc = { v: 1, id, name, theme (id of the theme preset, editor/themes.js: its sky / fog / palette; any other id reads as the default), start: { pos [x,y,z] feet, yaw (deg) },
//           items: [...], nextId, cam: { pos, yaw, pitch (deg) }, created, updated }
//   items (all have id and t):
//     block, ramp   { c: centre, size, yaw: 0|90|180|270, mat }      a ramp rises toward local +z (the builder's b.ramp)
//     prism         { c, r (circumradius), h, sides 3..16, yaw, mat }  pillars
//     kill          { c, size, kind: lava | laser | void }            trigger boxes, always axis aligned
//     cp            { c, size, yaw (deg, the respawn heading) }        the order of the cp items in items[] is the checkpoint order
//     finish        { c, size }                                        at most one
//     pad           { pos, target, apex }                              apex = absolute height of the arc, always above both ends
//     light         { pos, color (0xRRGGBB), intensity, range }
//     deco          { kind, pos, size, yaw }                           never collides
//   Numbers are rounded to 0.01, coordinates clamped to +-1500 m, sizes to 0.1 .. 400 m, at most 2000 items and at most LIM.cells cells of
//   the sim's collision grid (docCells: what the solid items touch; a file or an edit over it is refused). sanitizeDoc() cleans
//   anything (NaN, strings, unknown types, a second finish ...) and never throws.
//
//   const m = new DocModel(newDoc());   m.add(item) m.update(id, patch, { mergeKey }) m.remove(id) m.duplicate(id, offset) m.rotate(id)
//   m.reorderCp(id, dir) m.setStart(pos, yaw) m.setTheme(id) m.setName(name) m.undo() m.redo()   (m.rev counts every change)
//   'start' (the start point) and 'meta' ({ name, theme }) are pseudo ids of update(). Every op is one History entry; a drag or typing
//   in one field passes a mergeKey and collapses into one entry (typing: within 600 ms).
//   validate(doc, world?) -> { errors[], warnings[] } Hungarian texts (given the built world it also finds a start / checkpoint spawn inside a
//   solid).   serialise(doc) / importDoc(text) for export / import.
import { CELL } from '../sim/trace.js';
import { hullSolid } from '../sim/pmove.js';
import { stripText } from '../text.js';
import { THEMES } from './themes.js';

export const DOC_V = 1;
// cells: the collision grid (8 m cells) stores every brush in each cell its bounds touch, so a few huge blocks need hundreds of millions of
// cells (2000 blocks of 400 m: 265 M, 16 s, GBs). A map of a few hundred blocks needs < 2000, 20 floors of 400 x 400 plus 40 big walls about 120k.
export const LIM = { coord: 1500, sizeMin: 0.1, sizeMax: 400, items: 2000, nameLen: 40, history: 200, cells: 1000000 };
export const CELLS_MSG = 'A pálya túl nagy: túl sok vagy túl nagy tömb (ütközési rács). Kicsinyíts, vagy törölj néhány elemet.';
export const DEFAULT_THEME = 'kikepzes';

export const MATS = ['floor', 'wall', 'walldodge', 'trim', 'metal', 'glass', 'hazard', 'rock', 'crystal', 'grate'];
export const MAT_LABEL = { floor: 'Padló', wall: 'Fal', walldodge: 'Kiugrófal', trim: 'Díszcsík', metal: 'Fém', glass: 'Üveg', hazard: 'Veszélyjel', rock: 'Szikla', crystal: 'Kristály', grate: 'Rács' };
export const KILL_KINDS = ['lava', 'laser', 'void'];
export const KILL_LABEL = { lava: 'Láva', laser: 'Lézer', void: 'Semmi' };
export const DECO_KINDS = ['crate', 'pillar', 'rock', 'crystal', 'beacon', 'arch'];
export const DECO_LABEL = { crate: 'Láda', pillar: 'Oszlop', rock: 'Szikla', crystal: 'Kristály', beacon: 'Jelzőfény', arch: 'Boltív' };
export const DECO_SIZE = { crate: [1.3, 1.3, 1.3], pillar: [1, 4, 1], rock: [2, 1.5, 2], crystal: [0.9, 2.4, 0.9], beacon: [0.6, 3, 0.6], arch: [8, 6, 0.8] };
export const TYPE_LABEL = { block: 'Tömb', ramp: 'Rámpa', prism: 'Oszlop', kill: 'Halálzóna', cp: 'Ellenőrzőpont', finish: 'Cél', pad: 'Ugrópárna', light: 'Fény', deco: 'Dísz', start: 'Rajt' };

// The palette. The first ten are on the keys 1 2 3 .. 9 0. `sink`: the volume hangs below the clicked surface (a lava pool whose
// surface is where you click); everything else stands on it. size / r / h / sides / kind / mat are the defaults of a new item.
export const PALETTE = [
  { id: 'floor', key: '1', label: 'Padló', t: 'block', mat: 'floor', size: [6, 1, 6] },
  { id: 'wall', key: '2', label: 'Fal', t: 'block', mat: 'wall', size: [1, 4, 6] },
  { id: 'walldodge', key: '3', label: 'Kiugrófal', t: 'block', mat: 'walldodge', size: [1, 4, 6] },
  { id: 'ramp', key: '4', label: 'Rámpa', t: 'ramp', mat: 'floor', size: [4, 2, 6] },
  { id: 'pillar', key: '5', label: 'Oszlop', t: 'prism', mat: 'wall', r: 0.6, h: 4, sides: 8 },
  { id: 'lava', key: '6', label: 'Láva', t: 'kill', kind: 'lava', size: [8, 2, 8], sink: true },
  { id: 'laser', key: '7', label: 'Lézer', t: 'kill', kind: 'laser', size: [8, 3, 0.4] },
  { id: 'pad', key: '8', label: 'Ugrópárna', t: 'pad' },
  { id: 'cp', key: '9', label: 'Ellenőrzőpont', t: 'cp', size: [6, 4, 2] },
  { id: 'finish', key: '0', label: 'Cél', t: 'finish', size: [6, 5, 3] },
  { id: 'void', key: '', label: 'Semmi', t: 'kill', kind: 'void', size: [8, 2, 8], sink: true },
  { id: 'start', key: 'K', label: 'Rajt', t: 'start' },
  { id: 'light', key: '', label: 'Fény', t: 'light', color: 0xffd9a0, intensity: 1.2, range: 12 },
  // the deco kinds (a crate is plain 'deco'); the panel shows them as a group of their own
  { id: 'deco', key: '', label: 'Láda', t: 'deco', kind: 'crate' },
  ...DECO_KINDS.filter((k) => k !== 'crate').map((k) => ({ id: 'deco-' + k, key: '', label: DECO_LABEL[k], t: 'deco', kind: k })),
];
export const paletteOf = (id) => PALETTE.find((p) => p.id === id) || null;
// the palette entry an existing item belongs to (for the remembered sizes)
export function paletteIdOf(item) {
  if (!item) return null;
  if (item.t === 'block') return item.mat === 'wall' ? 'wall' : item.mat === 'walldodge' ? 'walldodge' : 'floor';
  if (item.t === 'prism') return 'pillar';
  if (item.t === 'kill') return item.kind;
  if (item.t === 'deco') return item.kind === 'crate' ? 'deco' : 'deco-' + item.kind;
  return PALETTE.some((p) => p.id === item.t) ? item.t : null;
}

// ---------------------------------------------------------------- number / string cleaning
export const r2 = (v) => Math.round(v * 100) / 100;
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v, d, lo = -Infinity, hi = Infinity) => Math.min(hi, Math.max(lo, fin(v) ? v : d));   // (the default is clamped too)
const vec3 = (v, d, lo, hi) => [0, 1, 2].map((i) => r2(num(Array.isArray(v) ? v[i] : undefined, d[i], lo, hi)));
const coord3 = (v, d = [0, 0, 0]) => vec3(v, d, -LIM.coord, LIM.coord);
const size3 = (v, d = [1, 1, 1]) => vec3(v, d, LIM.sizeMin, LIM.sizeMax);
const oneOf = (v, list, d) => (list.includes(v) ? v : d);
export const wrap360 = (deg) => ((deg % 360) + 360) % 360;
const yaw90 = (v) => wrap360(Math.round(num(v, 0, -3600, 3600) / 90) * 90);   // (clamped first: any number still gives 0 / 90 / 180 / 270)
const yawFree = (v) => r2(wrap360(num(v, 0)));
const cleanText = (v, max, d) => { const s = stripText(String(typeof v === 'string' ? v : '')).trim().slice(0, max); return s || d; };

// ---------------------------------------------------------------- items
// a clean copy of an item (without the id), or null for an unknown type; never throws
function cleanItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw.t;
  switch (t) {
    case 'block': case 'ramp':
      return { t, c: coord3(raw.c), size: size3(raw.size, t === 'ramp' ? [4, 2, 6] : [6, 1, 6]), yaw: yaw90(raw.yaw), mat: oneOf(raw.mat, MATS, 'floor') };
    case 'prism':
      return { t, c: coord3(raw.c), r: r2(num(raw.r, 0.6, LIM.sizeMin, LIM.sizeMax / 2)), h: r2(num(raw.h, 4, LIM.sizeMin, LIM.sizeMax)),
        sides: Math.round(num(raw.sides, 8, 3, 16)), yaw: yaw90(raw.yaw), mat: oneOf(raw.mat, MATS, 'wall') };
    case 'kill':
      return { t, c: coord3(raw.c), size: size3(raw.size, [8, 2, 8]), kind: oneOf(raw.kind, KILL_KINDS, 'lava') };
    case 'cp':
      return { t, c: coord3(raw.c), size: size3(raw.size, [6, 4, 2]), yaw: yawFree(raw.yaw) };
    case 'finish':
      return { t, c: coord3(raw.c), size: size3(raw.size, [6, 5, 3]) };
    case 'pad': {
      const pos = coord3(raw.pos), target = coord3(raw.target, [pos[0], pos[1], pos[2] - 8]);
      const lo = Math.max(pos[1], target[1]) + 0.5;   // the builder wants the apex above both ends
      return { t, pos, target, apex: r2(Math.min(LIM.coord + 50, Math.max(lo, num(raw.apex, lo + 2)))) };
    }
    case 'light':
      return { t, pos: coord3(raw.pos), color: Math.round(num(raw.color, 0xffd9a0, 0, 0xffffff)), intensity: r2(num(raw.intensity, 1.2, 0.1, 10)), range: r2(num(raw.range, 12, 1, 100)) };
    case 'deco': {
      const kind = oneOf(raw.kind, DECO_KINDS, 'crate');
      return { t, kind, pos: coord3(raw.pos), size: size3(raw.size, DECO_SIZE[kind]), yaw: yawFree(raw.yaw) };
    }
    default: return null;
  }
}
const cleanStart = (raw) => ({ pos: coord3(raw && raw.pos), yaw: yawFree(raw && raw.yaw) });
const cleanCam = (raw) => ({ pos: coord3(raw && raw.pos, [0, 6, 14]), yaw: r2(num(raw && raw.yaw, 0, -3600, 3600)), pitch: r2(num(raw && raw.pitch, -20, -89, 89)) });
const cleanId = (v) => (typeof v === 'string' && /^[a-z0-9_-]{1,24}$/i.test(v) ? v.toLowerCase() : null);
const cleanTheme = (v) => (typeof v === 'string' && Object.hasOwn(THEMES, v) ? v : DEFAULT_THEME);   // (a document from the days of the eight themes reads as the one left)

// a new item of a palette entry (no id yet); `over` replaces fields (c / pos / yaw / size ...)
export function newItem(entry, over = {}) {
  const e = typeof entry === 'string' ? paletteOf(entry) : entry;
  if (!e || e.t === 'start') return null;
  const base = { t: e.t };
  if (e.size) base.size = e.size.slice();
  for (const k of ['mat', 'kind', 'r', 'h', 'sides', 'color', 'intensity', 'range']) if (e[k] !== undefined) base[k] = e[k];
  if (e.t === 'deco') base.size = DECO_SIZE[over.kind || e.kind].slice();
  return cleanItem({ ...base, ...over });
}

export function newDoc({ id = null, name = 'Új pálya', theme = DEFAULT_THEME, created = 0 } = {}) {
  return sanitizeDoc({
    v: DOC_V, id: id || 'uj', name, theme, created, updated: created,
    start: { pos: [0, 0, 0], yaw: 0 },
    items: [{ id: 1, t: 'block', c: [0, -0.5, 0], size: [12, 1, 12], mat: 'floor' }],
    cam: { pos: [0, 6, 14], yaw: 0, pitch: -20 },
  });
}

// raw -> a clean doc, or null when raw is not a v1 document. Never throws.
export function sanitizeDoc(raw) {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.v !== DOC_V) return null;
    const src = Array.isArray(raw.items) ? raw.items.slice(0, LIM.items) : [];
    const items = [], used = new Set();
    let hasFinish = false, maxId = 0;
    for (const r of src) {
      const it = cleanItem(r);
      if (!it) continue;
      if (it.t === 'finish') { if (hasFinish) continue; hasFinish = true; }
      const id = r.id;
      if (Number.isInteger(id) && id >= 1 && id <= 1e9 && !used.has(id)) { it.id = id; used.add(id); maxId = Math.max(maxId, id); } else it.id = 0;
      items.push(it);
    }
    let nextId = Math.max(maxId + 1, Number.isInteger(raw.nextId) && raw.nextId >= 1 && raw.nextId <= 1e9 ? raw.nextId : 1);
    for (const it of items) if (!it.id) it.id = nextId++;
    return {
      v: DOC_V, id: cleanId(raw.id) || 'uj', name: cleanText(raw.name, LIM.nameLen, 'Névtelen pálya'), theme: cleanTheme(raw.theme),
      start: cleanStart(raw.start), items: items.map(orderKeys), nextId, cam: cleanCam(raw.cam),
      created: Math.round(num(raw.created, 0, 0, 1e15)), updated: Math.round(num(raw.updated, 0, 0, 1e15)),
    };
  } catch { return null; }
}
// id first (a stable JSON for the round trip)
const orderKeys = (it) => { const { id, ...rest } = it; return { id, ...rest }; };

export const serialise = (doc) => JSON.stringify(doc, (k, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v));

// text (or an already parsed object) -> { doc } | { error } (Hungarian)
export function importDoc(input) {
  let raw = input;
  if (typeof input === 'string') {
    if (input.length > 4e6) return { error: 'A fájl túl nagy.' };
    try { raw = JSON.parse(input); } catch { return { error: 'Ez nem érvényes pályafájl (nem JSON).' }; }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'Ez nem pályafájl.' };
  if (raw.v !== DOC_V) return { error: 'A pályafájl formátuma ismeretlen (v' + (typeof raw.v === 'number' ? String(raw.v).slice(0, 8) : '?') + '): ehhez a játékhoz túl új vagy rossz fájl.' };
  const doc = sanitizeDoc(raw);
  if (!doc) return { error: 'A pályafájl hibás.' };
  if (docCells(doc) > LIM.cells) return { error: CELLS_MSG };
  return { doc };
}

// ---------------------------------------------------------------- geometry shared by pick.js / validate
const half = (a) => [a[0] / 2, a[1] / 2, a[2] / 2];
// the size of an item along the WORLD axes (a block turned by 90 / 270 swaps x and z; a free yaw takes the rotated extent)
export function worldSize(item) {
  const yaw = item.yaw || 0;
  if (item.t === 'block' || item.t === 'ramp') return yaw === 90 || yaw === 270 ? [item.size[2], item.size[1], item.size[0]] : item.size.slice();
  if (item.t === 'prism') { const b = itemAabb(item); return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]]; }
  if (item.t === 'deco') { const a = yaw * Math.PI / 180, c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a)); return [c * item.size[0] + s * item.size[2], item.size[1], s * item.size[0] + c * item.size[2]]; }
  if (item.size) return item.size.slice();
  return [1, 1, 1];
}
// axis aligned bounds { min, max } of any item (or of 'start': { pos, yaw })
export function itemAabb(item) {
  switch (item.t) {
    case 'block': case 'ramp': case 'kill': case 'cp': case 'finish': case 'deco': {
      const c = item.c || item.pos, h = half(worldSize(item));
      return { min: [c[0] - h[0], c[1] - h[1], c[2] - h[2]], max: [c[0] + h[0], c[1] + h[1], c[2] + h[2]] };
    }
    case 'prism': {
      const a0 = (item.yaw || 0) * Math.PI / 180, min = [Infinity, 0, Infinity], max = [-Infinity, 0, -Infinity];
      for (let i = 0; i < item.sides; i++) {
        const a = Math.PI / item.sides + (i * 2 * Math.PI) / item.sides;
        const x = Math.cos(a) * item.r, z = Math.sin(a) * item.r;
        const wx = x * Math.cos(a0) + z * Math.sin(a0), wz = -x * Math.sin(a0) + z * Math.cos(a0);
        min[0] = Math.min(min[0], wx); max[0] = Math.max(max[0], wx); min[2] = Math.min(min[2], wz); max[2] = Math.max(max[2], wz);
      }
      const c = item.c;
      return { min: [c[0] + min[0], c[1] - item.h / 2, c[2] + min[2]], max: [c[0] + max[0], c[1] + item.h / 2, c[2] + max[2]] };
    }
    case 'pad': { const p = item.pos; return { min: [p[0] - 0.9, p[1] - 0.1, p[2] - 0.9], max: [p[0] + 0.9, p[1] + 0.6, p[2] + 0.9] }; }
    case 'light': { const p = item.pos; return { min: [p[0] - 0.3, p[1] - 0.3, p[2] - 0.3], max: [p[0] + 0.3, p[1] + 0.3, p[2] + 0.3] }; }
    case 'start': { const p = item.pos; return { min: [p[0] - 0.4, p[1], p[2] - 0.4], max: [p[0] + 0.4, p[1] + 1.76, p[2] + 0.4] }; }
    default: return { min: [0, 0, 0], max: [0, 0, 0] };
  }
}
const SOLID = new Set(['block', 'ramp', 'prism']);
export const isSolid = (item) => SOLID.has(item.t);
// the cells of the sim's collision grid that a solid item's bounds touch (sim/trace.js stores the brush in each of them)
export function solidCells(item) {
  if (!SOLID.has(item.t)) return 0;
  const b = itemAabb(item);
  let n = 1;
  for (let a = 0; a < 3; a++) n *= Math.floor(b.max[a] / CELL) - Math.floor(b.min[a] / CELL) + 1;
  return n;
}
export const docCells = (doc) => doc.items.reduce((n, it) => n + solidCells(it), 0);

// ---------------------------------------------------------------- history
export class History {
  constructor(cap = LIM.history) { this.cap = cap; this.undoStack = []; this.redoStack = []; }
  // entry = { label, ch: [change] }; a `set` entry with the same mergeKey within mergeMs of the last one is folded into it
  push(entry, { mergeKey = null, mergeMs = 600, now = 0 } = {}) {
    this.redoStack.length = 0;
    const last = this.undoStack[this.undoStack.length - 1];
    if (mergeKey && last && last.key === mergeKey && now - last.t <= mergeMs && last.ch.length === 1 && entry.ch.length === 1
      && last.ch[0].k === 'set' && entry.ch[0].k === 'set' && last.ch[0].id === entry.ch[0].id) {
      last.ch[0].after = entry.ch[0].after;
      last.t = now;
      return;
    }
    this.undoStack.push({ ...entry, key: mergeKey, t: now });
    if (this.undoStack.length > this.cap) this.undoStack.shift();
  }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  clear() { this.undoStack.length = 0; this.redoStack.length = 0; }
}

const clone = (o) => JSON.parse(JSON.stringify(o));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export class DocModel {
  constructor(doc, { now = () => performance.now() } = {}) {
    this.doc = doc;
    this.history = new History();
    this.now = now;
    this.rev = 0;
    this.onRefuse = null;   // (message): an add / update was refused because the map would need too big a collision grid
  }
  get items() { return this.doc.items; }
  indexOf(id) { return this.doc.items.findIndex((i) => i.id === id); }
  find(id) { return id === 'start' ? { t: 'start', id: 'start', ...this.doc.start } : this.doc.items.find((i) => i.id === id) || null; }
  get finish() { return this.doc.items.find((i) => i.t === 'finish') || null; }
  cpItems() { return this.doc.items.filter((i) => i.t === 'cp'); }

  record(label, ch, opts) { this.history.push({ label, ch }, { ...opts, now: this.now() }); this.rev++; }

  refuseCells(ret) { if (this.onRefuse) this.onRefuse(CELLS_MSG); return ret; }

  // an item (without id); returns its id, or null when the doc is full / the type is unknown. A second finish moves the first.
  add(item, { index = -1, label = 'Elem hozzáadása', ...opts } = {}) {
    const it = cleanItem(item);
    if (!it) return null;
    if (it.t === 'finish' && this.finish) { const f = this.finish; this.update(f.id, { c: it.c, size: it.size }, { label: 'Cél áthelyezése', ...opts }); return f.id; }
    if (this.doc.items.length >= LIM.items) return null;
    if (solidCells(it) && docCells(this.doc) + solidCells(it) > LIM.cells) return this.refuseCells(null);
    const out = orderKeys({ ...it, id: this.doc.nextId++ });
    const at = index >= 0 && index <= this.doc.items.length ? index : this.doc.items.length;
    this.doc.items.splice(at, 0, out);
    this.record(label, [{ k: 'add', item: clone(out), index: at }], opts);
    return out.id;
  }

  // merge a patch into an item (full vectors, not single components); id may be 'start' or 'meta'. Returns true when something changed.
  update(id, patch, { label = 'Módosítás', ...opts } = {}) {
    let before, after;
    if (id === 'start') { before = this.doc.start; after = cleanStart({ ...before, ...patch }); }
    else if (id === 'meta') {
      before = { name: this.doc.name, theme: this.doc.theme };
      after = { name: cleanText(patch.name ?? before.name, LIM.nameLen, 'Névtelen pálya'), theme: cleanTheme(patch.theme ?? before.theme) };
    } else {
      const i = this.indexOf(id);
      if (i < 0) return false;
      before = this.doc.items[i];
      const c = cleanItem({ ...before, ...patch, t: before.t });
      if (!c) return false;
      after = orderKeys({ ...c, id: before.id });
    }
    if (same(before, after)) return false;
    const grow = id === 'start' || id === 'meta' ? 0 : solidCells(after) - solidCells(before);
    if (grow > 0 && docCells(this.doc) + grow > LIM.cells) return this.refuseCells(false);
    before = clone(before); after = clone(after);
    this.apply({ k: 'set', id, after });
    this.record(label, [{ k: 'set', id, before, after }], opts);
    return true;
  }

  remove(id, { label = 'Elem törlése', ...opts } = {}) {
    const i = this.indexOf(id);
    if (i < 0) return false;
    const [it] = this.doc.items.splice(i, 1);
    this.record(label, [{ k: 'del', item: clone(it), index: i }], opts);
    return true;
  }

  // a copy shifted by `offset` (a finish cannot be copied); returns the new id
  duplicate(id, offset = [1, 0, 1], opts = {}) {
    const it = this.doc.items.find((x) => x.id === id);
    if (!it || it.t === 'finish') return null;
    const copy = clone(it);
    delete copy.id;
    for (const k of ['c', 'pos', 'target']) if (copy[k]) copy[k] = copy[k].map((v, a) => v + offset[a]);
    if (copy.apex !== undefined) copy.apex += offset[1];
    return this.add(copy, { label: 'Másolás', index: this.indexOf(id) + 1, ...opts });
  }

  // 90 degrees about the centre: blocks / ramps / pillars turn; kill / finish / cp boxes swap x and z (a cp also turns its heading);
  // the start point and deco turn; pads and lights do not rotate
  rotate(id, opts = {}) {
    if (id === 'start') return this.update('start', { yaw: wrap360(this.doc.start.yaw + 90) }, { label: 'Forgatás', ...opts });
    const it = this.doc.items.find((x) => x.id === id);
    if (!it) return false;
    const label = 'Forgatás';
    switch (it.t) {
      case 'block': case 'ramp': case 'prism': return this.update(id, { yaw: wrap360(it.yaw + 90) }, { label, ...opts });
      case 'kill': case 'finish': return this.update(id, { size: [it.size[2], it.size[1], it.size[0]] }, { label, ...opts });
      case 'cp': return this.update(id, { size: [it.size[2], it.size[1], it.size[0]], yaw: wrap360(it.yaw + 90) }, { label, ...opts });
      case 'deco': return this.update(id, { yaw: wrap360(it.yaw + 90) }, { label, ...opts });
      default: return false;
    }
  }

  // move a checkpoint one place earlier (dir -1) or later (+1) in the checkpoint order
  reorderCp(id, dir, opts = {}) {
    const cps = this.doc.items.map((it, i) => (it.t === 'cp' ? i : -1)).filter((i) => i >= 0);
    const p = cps.findIndex((i) => this.doc.items[i].id === id), q = p + (dir < 0 ? -1 : 1);
    if (p < 0 || q < 0 || q >= cps.length) return false;
    this.swap(cps[p], cps[q]);
    this.record('Ellenőrzőpont sorrend', [{ k: 'swap', i: cps[p], j: cps[q] }], opts);
    return true;
  }
  swap(i, j) { const a = this.doc.items; [a[i], a[j]] = [a[j], a[i]]; }

  setStart(pos, yaw, opts = {}) { return this.update('start', { pos, yaw }, { label: 'Rajtpont', ...opts }); }
  setTheme(theme, opts = {}) { return this.update('meta', { theme }, { label: 'Téma', ...opts }); }
  setName(name, opts = {}) { return this.update('meta', { name }, { label: 'Név', mergeKey: 'name', ...opts }); }

  // one change applied forward (`after`) ...
  apply(c) {
    const d = this.doc;
    if (c.k === 'set') {
      if (c.id === 'start') d.start = clone(c.after);
      else if (c.id === 'meta') { d.name = c.after.name; d.theme = c.after.theme; }
      else { const i = this.indexOf(c.id); if (i >= 0) d.items[i] = clone(c.after); }
    }
  }
  // ... and undone
  invert(c) {
    const d = this.doc;
    switch (c.k) {
      case 'set': this.apply({ k: 'set', id: c.id, after: c.before }); break;
      case 'add': { const i = this.indexOf(c.item.id); if (i >= 0) d.items.splice(i, 1); break; }
      case 'del': d.items.splice(Math.min(c.index, d.items.length), 0, clone(c.item)); break;
      case 'swap': this.swap(c.i, c.j); break;
      default: break;
    }
  }
  redoChange(c) {
    const d = this.doc;
    switch (c.k) {
      case 'set': this.apply(c); break;
      case 'add': d.items.splice(Math.min(c.index, d.items.length), 0, clone(c.item)); break;
      case 'del': { const i = this.indexOf(c.item.id); if (i >= 0) d.items.splice(i, 1); break; }
      case 'swap': this.swap(c.i, c.j); break;
      default: break;
    }
  }
  touched(e) { return e.ch.map((c) => (c.item ? c.item.id : c.id)).filter((x) => x !== undefined && x !== 'meta'); }

  // -> { label, ids } of what was undone / redone, or null when there is nothing to do
  undo() {
    const e = this.history.undoStack.pop();
    if (!e) return null;
    for (let i = e.ch.length - 1; i >= 0; i--) this.invert(e.ch[i]);
    this.history.redoStack.push(e);
    this.rev++;
    return { label: e.label, ids: this.touched(e) };
  }
  redo() {
    const e = this.history.redoStack.pop();
    if (!e) return null;
    for (const c of e.ch) this.redoChange(c);
    this.history.undoStack.push(e);
    this.rev++;
    return { label: e.label, ids: this.touched(e) };
  }
}

// ---------------------------------------------------------------- validation
// { errors, warnings } (Hungarian). A doc always builds (sanitize guarantees it): these are about whether the map is playable.
// world (the built sim world of this doc, optional): the same hull test the sim uses (hullSolid, 0.02 m above the spot like spawnPlayer and
// findTestSpawn) finds a start or a checkpoint spawn inside a solid, where the player would be stuck (respawn 'stuck' for ever).
export function validate(doc, world = null) {
  const errors = [], warnings = [];
  const finishes = doc.items.filter((i) => i.t === 'finish');
  if (!finishes.length) warnings.push('Hiányzik a cél: tegyél le egy célt, különben a pálya nem teljesíthető.');
  if (finishes.length > 1) errors.push('Csak egy cél lehet.');
  const s = { t: 'start', pos: doc.start.pos };
  const sb = itemAabb(s);
  const under = doc.items.some((it) => {
    if (!isSolid(it)) return false;
    const b = itemAabb(it);
    return b.max[0] > sb.min[0] && b.min[0] < sb.max[0] && b.max[2] > sb.min[2] && b.min[2] < sb.max[2] && b.max[1] <= doc.start.pos[1] + 0.5 && b.max[1] >= doc.start.pos[1] - 3;
  });
  if (!under) warnings.push('A rajtpont alatt nincs padló.');
  const kills = doc.items.filter((it) => it.t === 'kill').map(itemAabb);
  const inSolid = (p) => !!world && hullSolid(world.cw, [p[0], p[1] + 0.02, p[2]]);
  if (kills.some((k) => boxesOverlap(k, sb))) warnings.push('A rajtpont halálzónában van.');
  if (inSolid(doc.start.pos)) warnings.push('A rajtpont szilárd elemben (falban) van: a játékos beragad.');
  // a checkpoint respawns the player at the bottom centre of its box (sim/builder.js)
  doc.items.filter((it) => it.t === 'cp').forEach((cp, i) => {
    const sp = [cp.c[0], cp.c[1] - cp.size[1] / 2, cp.c[2]];
    if (kills.some((k) => boxesOverlap(k, itemAabb({ t: 'start', pos: sp })))) warnings.push(`${i + 1}. ellenőrzőpont: a visszaszületési pont halálzónában van, a játékos újra meg újra meghal.`);
    else if (inSolid(sp)) warnings.push(`${i + 1}. ellenőrzőpont: a visszaszületési pont szilárd elemben (falban) van: a játékos beragad.`);
  });
  if (doc.items.length > LIM.items - 200) warnings.push(`Közel a ${LIM.items} elemes határhoz (${doc.items.length}).`);
  return { errors, warnings };
}
export const boxesOverlap = (a, b) => !(a.min[0] > b.max[0] || a.max[0] < b.min[0] || a.min[1] > b.max[1] || a.max[1] < b.min[1] || a.min[2] > b.max[2] || a.max[2] < b.min[2]);
