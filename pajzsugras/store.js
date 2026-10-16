// Persistent storage: localStorage under the `pajzsugras:` prefix, every access in try/catch (private mode, quota,
// blocked storage). When storage is unavailable the values live in memory for the session, so the game keeps working.
//
//   store.get(key, def)  store.set(key, value)  store.remove(key)      JSON values
//   store.getRaw(key)    store.setRaw(key, string)                      plain strings (e.g. keys, tokens)
//   store.loadSettings() / store.saveSettings(s)                       the settings object (validated, see DEFAULTS)
//   store.getPB(mapId, mapHash) -> { ticks, splits[], ghost (base64) | null, date } | null   (null when the map changed)
//   store.setPB(mapId, mapHash, { ticks, splits, ghost })
//   store.clearPB(mapId)
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

export const QUALITIES = ['alacsony', 'kozepes', 'magas'];
export const QUALITY_LABEL = { alacsony: 'Alacsony', kozepes: 'Közepes', magas: 'Magas' };

export const DEFAULTS = {
  name: 'Játékos',     // shown in rooms and on the leaderboard, max 16 characters
  sens: 1,             // mouse sensitivity multiplier (0.1 .. 3)
  fov: 100,            // horizontal field of view, degrees (80 .. 120)
  doubleTap: true,     // double-tap a direction = dodge
  autoHop: true,       // holding jump bunny-hops
  keys: false,         // Defrag style key overlay
  ghost: true,         // show the personal-best ghost
  quality: 'kozepes',
  volume: 0.7,         // master volume 0..1
  lastMap: 'kikepzes',
};

const num = (v, lo, hi, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

export function cleanName(v) {
  const s = String(v ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);
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
    autoHop: typeof r.autoHop === 'boolean' ? r.autoHop : d.autoHop,
    keys: typeof r.keys === 'boolean' ? r.keys : d.keys,
    ghost: typeof r.ghost === 'boolean' ? r.ghost : d.ghost,
    quality: QUALITIES.includes(r.quality) ? r.quality : d.quality,
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

  getPB(mapId, mapHash) {
    const pb = this.get('pb:' + mapId, null);
    if (!pb || !Number.isFinite(pb.ticks) || !Array.isArray(pb.splits)) return null;
    if (mapHash && pb.hash !== mapHash) return null;   // the map changed: the old time no longer counts
    return { ticks: pb.ticks, splits: pb.splits, ghost: typeof pb.ghost === 'string' ? pb.ghost : null, date: pb.date || 0 };
  },
  setPB(mapId, mapHash, run) {
    return this.set('pb:' + mapId, { hash: mapHash, ticks: run.ticks, splits: run.splits, ghost: run.ghost || null, date: Date.now() });
  },
  clearPB(mapId) { rawRemove('pb:' + mapId); },
};

export default store;
