// PAJZSUGRÁS map editor: the maps that tools/ut2004_map.py wrote into the git-ignored local-maps/ folder (a third party's UT2004 map, ported for this
// machine only) are imported into the saved maps by themselves. Only when the page is served from this machine: the folder does not exist on the
// public site, and the dev server hands it to localhost only (tools/local-guard.mjs). Every failure is silent (no folder, no index, a 404, the dev
// server's HTML fallback, a bad file): it must never get in the way of the menu.
//
//   loadLocalMaps(store) -> Promise<[doc]>   fetches local-maps/index.json ({ v: 1, maps: [file names] }), imports what is new through
//                                            library.js importMapText (all its checks and limits apply), returns the documents imported by this call
//   isLocalHost(hostname) -> bool            localhost, 127.0.0.1, [::1], *.localhost
//
// What was imported is remembered under `pajzsugras:localmaps` = { [file]: hash of the file's text }. A file is imported when it is new or its text
// changed (then as a new copy with a fresh id; the old one stays). A map deleted in the game is not brought back while its file is the same.
import { importMapText } from './library.js';
import { CUSTOM_LIMIT } from '../store.js';

const DIR = '/pajzsugras/local-maps/';
const KEY = 'localmaps';
const FILE = /^[a-z0-9-]{1,24}\.json$/;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|.+\.localhost)$/i;
const MAX_TEXT = 4e6;   // (the same limit as the Importálás button)

export const isLocalHost = (hostname) => typeof hostname === 'string' && LOCAL_HOST.test(hostname);

// FNV-1a over the UTF-16 units + the length: enough to tell whether a file changed
function hashText(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return text.length + ':' + h.toString(36);
}

async function fetchText(url) {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return null;
    const text = await r.text();
    return typeof text === 'string' && text.length <= MAX_TEXT ? text : null;
  } catch { return null; }
}

export async function loadLocalMaps(store) {
  const imported = [];
  if (typeof location === 'undefined' || !isLocalHost(location.hostname)) return imported;
  let files = [];
  try {
    const index = JSON.parse(await fetchText(DIR + 'index.json'));
    if (index && index.v === 1 && Array.isArray(index.maps)) files = index.maps.filter((f) => typeof f === 'string' && FILE.test(f) && f !== 'index.json').slice(0, CUSTOM_LIMIT);   // (the index itself is a valid v1 doc: never import it)
  } catch { return imported; }
  const saved = store.get(KEY, null);
  const known = saved && typeof saved === 'object' && !Array.isArray(saved) ? { ...saved } : {};
  for (const file of files) {
    if (store.listCustom().length >= CUSTOM_LIMIT) break;
    const text = await fetchText(DIR + file);
    if (text === null) continue;
    const hash = hashText(text);
    if (known[file] === hash) continue;
    try {
      const r = importMapText(store, text);
      if (r.error || !r.saved) continue;   // not stored (storage full): not recorded either, so the next start tries again
      known[file] = hash;
      store.set(KEY, known);
      imported.push(r.doc);
    } catch { /* a hostile or broken file: skipped */ }
  }
  return imported;
}
