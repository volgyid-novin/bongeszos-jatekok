// Persistent storage: localStorage under the `pajzsugras:` prefix, every access in try/catch (private mode, quota,
// blocked storage). When storage is unavailable the values live in memory for the session, so the game keeps working.
//
//   store.get(key, def)  store.set(key, value)  store.remove(key)      JSON values
//   store.getRaw(key)    store.setRaw(key, string)                      plain strings (e.g. keys, tokens)
//   store.loadSettings() / store.saveSettings(s)                       the settings object (validated, see DEFAULTS)
//   store.getPB(mapId, mapHash) -> { ticks, splits[], ghost (base64) | null, date } | null   (null when the map changed)
//   store.setPB(mapId, mapHash, { ticks, splits, ghost })
//   store.clearPB(mapId)
//
// The map editor's maps (editor/model.js documents), under the same prefix:
//   ed:index        [{ id, name, updated, n (items)[, cps, fin, hash] }]  the list (at most CUSTOM_LIMIT maps); an entry whose map is gone is dropped
//                   on read and on the next save; cps / fin / hash (checkpoints, has a finish, map hash of that saved version) are there when the
//                   saver knew them, so that the JÁTÉK list need not build every map
//   ed:map:<id>     the document as JSON (at most CUSTOM_MAX_BYTES); ed:last = the id edited last (a plain string)
//   ed:pb:<id>      the personal best of that map, kept apart from the built-in maps' `pb:<mapId>` keys (and never published)
//   store.listCustom() -> index entries, newest first       store.hasCustom(id)     store.getCustom(id) -> the parsed JSON | null (clean it with
//   store.saveCustom(doc, { info, last }) -> bool (false: refused or the write failed; the session still has it in memory)   sanitizeDoc before use)
//        info = { cps, fin, hash } of this very document (optional) · last: false = not the map edited last (an import, a rename)
//   store.removeCustom(id) -> bool (also its personal best and ed:last)      store.lastCustom() / setLastCustom(id)      store.freshCustomId()
//   store.getCustomPB(id, hash) / setCustomPB(id, hash, run) / clearCustomPB(id)      same shape as getPB / setPB / clearPB
import { stripText } from './text.js';

const PREFIX = 'pajzsugras:';
const mem = new Map();

// (the memory map only holds values whose write to localStorage failed, so it wins over whatever localStorage still has)
function rawGet(key) {
  if (mem.has(key)) return mem.get(key);
  try { return localStorage.getItem(PREFIX + key); } catch { return null; }
}
function rawSet(key, value) {
  try { localStorage.setItem(PREFIX + key, value); mem.delete(key); return true; } catch { mem.set(key, value); return false; }
}
function rawRemove(key) {
  mem.delete(key);
  try { localStorage.removeItem(PREFIX + key); } catch { /* nothing to do */ }
}

export const CUSTOM_LIMIT = 40;            // saved maps of the editor
export const CUSTOM_MAX_BYTES = 1000000;   // one serialised map (2000 items are about 200 kB)
const CUSTOM_ID = /^[a-z0-9_-]{1,24}$/;    // (the same as editor/model.js cleanId, which lower-cases)
const IDX = 'ed:index', LAST = 'ed:last', MAP = 'ed:map:', CPB = 'ed:pb:';

export const QUALITIES = ['alacsony', 'kozepes', 'magas'];
export const QUALITY_LABEL = { alacsony: 'Alacsony', kozepes: 'Közepes', magas: 'Magas' };
export const VIEWS = ['belso', 'kulso'];   // the camera: from the player's eyes, or behind the player (UT2004's behindview)
export const VIEW_LABEL = { belso: 'Belső', kulso: 'Külső' };

export const DEFAULTS = {
  name: 'Játékos',     // shown in rooms and on the leaderboard, max 16 characters
  sens: 1,             // mouse sensitivity multiplier (0.1 .. 3)
  fov: 100,            // horizontal field of view, degrees (80 .. 120)
  doubleTap: true,     // double-tap a direction = dodge
  keys: false,         // Defrag style key overlay
  ghost: true,         // show the personal-best ghost
  quality: 'kozepes',
  view: 'belso',       // 'belso' (first person) | 'kulso' (third person, behind the player); the V key toggles it while playing
  volume: 0.7,         // master volume 0..1
  lastMap: 'uj-palya',
};

// the cps / fin / hash an index entry may carry (what the map list shows without building the map)
const validInfo = (e) => Number.isInteger(e.cps) && e.cps >= 0 && e.cps <= 9999 && typeof e.fin === 'boolean' && typeof e.hash === 'string' && e.hash.length > 0 && e.hash.length <= 64;

const num = (v, lo, hi, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

export function cleanName(v) {
  const s = stripText(String(v ?? '')).trim().slice(0, 16);
  return s || DEFAULTS.name;
}

export function sanitizeSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const d = DEFAULTS;
  return {
    name: cleanName(r.name),
    sens: num(r.sens, 0.1, 3, d.sens),
    fov: Math.round(num(r.fov, 80, 120, d.fov)),
    doubleTap: typeof r.doubleTap === 'boolean' ? r.doubleTap : d.doubleTap,
    keys: typeof r.keys === 'boolean' ? r.keys : d.keys,
    ghost: typeof r.ghost === 'boolean' ? r.ghost : d.ghost,
    quality: QUALITIES.includes(r.quality) ? r.quality : d.quality,
    view: VIEWS.includes(r.view) ? r.view : d.view,
    volume: num(r.volume, 0, 1, d.volume),
    lastMap: typeof r.lastMap === 'string' ? r.lastMap.slice(0, 40) : d.lastMap,
  };
}

export const store = {
  get(key, def = null) {
    const s = rawGet(key);
    if (s == null) return def;
    try { return JSON.parse(s); } catch { return def; }
  },
  set(key, value) { try { return rawSet(key, JSON.stringify(value)); } catch { return false; } },
  remove: rawRemove,
  getRaw: rawGet,
  setRaw: rawSet,

  loadSettings() { return sanitizeSettings(this.get('settings', null)); },
  saveSettings(s) { return this.set('settings', sanitizeSettings(s)); },

  getPB(mapId, mapHash) { return this.readPB('pb:' + mapId, mapHash); },
  setPB(mapId, mapHash, run) { return this.writePB('pb:' + mapId, mapHash, run); },
  clearPB(mapId) { rawRemove('pb:' + mapId); },
  readPB(key, mapHash) {
    const pb = this.get(key, null);
    if (!pb || !Number.isFinite(pb.ticks) || !Array.isArray(pb.splits)) return null;
    if (mapHash && pb.hash !== mapHash) return null;   // the map changed: the old time no longer counts
    return { ticks: pb.ticks, splits: pb.splits, ghost: typeof pb.ghost === 'string' ? pb.ghost : null, date: pb.date || 0 };
  },
  writePB(key, mapHash, run) {
    return this.set(key, { hash: mapHash, ticks: run.ticks, splits: run.splits, ghost: run.ghost || null, date: Date.now() });
  },

  // ---------------------------------------------------------------- the editor's maps
  readIndex() {
    const raw = this.get(IDX, []);
    const out = [], seen = new Set();
    for (const e of Array.isArray(raw) ? raw : []) {
      if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !CUSTOM_ID.test(e.id) || seen.has(e.id)) continue;
      seen.add(e.id);
      const entry = { id: e.id, name: typeof e.name === 'string' && e.name ? e.name.slice(0, 40) : 'Névtelen pálya', updated: Number.isFinite(e.updated) ? e.updated : 0, n: Number.isInteger(e.n) && e.n >= 0 ? e.n : 0 };
      if (validInfo(e)) { entry.cps = e.cps; entry.fin = e.fin; entry.hash = e.hash; }
      out.push(entry);
      if (out.length >= CUSTOM_LIMIT) break;
    }
    return out;
  },
  // the index without the entries whose document has vanished (cleared by the browser, a half-failed write): those must not count against the limit
  liveIndex() { return this.readIndex().filter((e) => rawGet(MAP + e.id) != null); },
  // the saved maps, newest first
  listCustom() {
    return this.liveIndex().sort((a, b) => b.updated - a.updated || (a.id < b.id ? -1 : 1));
  },
  hasCustom(id) { return typeof id === 'string' && CUSTOM_ID.test(id) && this.readIndex().some((e) => e.id === id) && rawGet(MAP + id) != null; },
  getCustom(id) {
    if (typeof id !== 'string' || !CUSTOM_ID.test(id)) return null;
    const s = rawGet(MAP + id);
    if (s == null) return null;
    try { const doc = JSON.parse(s); return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : null; } catch { return null; }
  },
  // doc = an editor document (v1, items[], id, name, updated). False when it was refused (bad id, over 1 MB, the list is full) or a write
  // failed (quota, blocked storage): then the map lives in memory until the page is closed, so the caller should say "export it".
  saveCustom(doc, { info = null, last = true } = {}) {
    if (!doc || typeof doc !== 'object' || typeof doc.id !== 'string' || !CUSTOM_ID.test(doc.id)) return false;
    let text;
    try { text = JSON.stringify(doc); } catch { return false; }
    if (typeof text !== 'string' || text.length > CUSTOM_MAX_BYTES) return false;
    const idx = this.liveIndex(), known = idx.some((e) => e.id === doc.id);   // (the write below also drops the dead entries)
    if (!known && idx.length >= CUSTOM_LIMIT) return false;
    const entry = { id: doc.id, name: String(doc.name ?? '').slice(0, 40) || 'Névtelen pálya', updated: Number.isFinite(doc.updated) ? doc.updated : 0, n: Array.isArray(doc.items) ? doc.items.length : 0 };
    if (info && validInfo(info)) { entry.cps = info.cps; entry.fin = info.fin; entry.hash = info.hash; }
    const okMap = rawSet(MAP + doc.id, text);
    const okIdx = this.set(IDX, known ? idx.map((e) => (e.id === doc.id ? entry : e)) : [...idx, entry]);
    const okLast = last ? rawSet(LAST, doc.id) : true;
    return okMap && okIdx && okLast;
  },
  removeCustom(id) {
    if (typeof id !== 'string' || !CUSTOM_ID.test(id)) return false;
    const idx = this.readIndex(), had = idx.some((e) => e.id === id) || rawGet(MAP + id) != null;
    rawRemove(MAP + id);
    if (idx.some((e) => e.id === id)) this.set(IDX, idx.filter((e) => e.id !== id));
    if (rawGet(LAST) === id) rawRemove(LAST);
    rawRemove(CPB + id);
    return had;
  },
  // the id edited last, while that map still exists
  lastCustom() { const id = rawGet(LAST); return typeof id === 'string' && this.hasCustom(id) ? id : null; },
  setLastCustom(id) { if (this.hasCustom(id)) rawSet(LAST, id); },
  // an id that is in none of the saved maps (time + two random characters, lower case, at most 24 characters)
  freshCustomId() {
    const used = new Set(this.readIndex().map((e) => e.id));
    for (;;) {
      const id = Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36).padStart(2, '0');
      if (!used.has(id)) return id;
    }
  },
  getCustomPB(id, hash) { return this.readPB(CPB + id, hash); },
  setCustomPB(id, hash, run) { return this.writePB(CPB + id, hash, run); },
  clearCustomPB(id) { rawRemove(CPB + id); },
};

export default store;
