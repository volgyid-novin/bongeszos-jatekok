// PAJZSUGRÁS map editor: the saved maps as the menus see them (the list, import, export, rename, delete, "can it be played"). Pure apart from
// downloadText: every function takes the store (store.js) as its first argument, so node can test it with an in-memory localStorage.
//
//   loadDoc(store, id) -> a clean document | null                 newMapDoc(store, now) -> a new document ("Új pálya", "Új pálya 2" ...)
//   describeMap(store, indexEntry) -> { id, name, updated, n, ok, error, cps, fin, hash, pb }   what the JÁTÉK list shows; cps / fin / hash come
//                                                                  from the index entry (the editor's save and importMapText store them), else the map is built
//                                                                  once per saved version (cached); pb = the local personal best of that exact version
//   prepareRun(store, id) -> { doc, def } | { error }              a map ready to play (error: Hungarian text, e.g. no finish)
//   importMapText(store, text, now) -> { doc, renamed, saved } | { error }   validates (importDoc + a trial build); a taken id gets a new one;
//                                                                  an import is not "the map edited last" (ed:last stays)
//   mapInfo(map) -> { cps, fin, hash }                              what an index entry carries (store.saveCustom(doc, { info }))
//   exportFile(doc) -> { name, text }     downloadText(name, text)      the file the Exportálás button writes
//   renameMap(store, id, name) -> bool    deleteMap(store, id) -> bool (also its personal best)
//   readPB(store, mapId, hash, custom) / recordPB(store, mapId, hash, run, custom) -> { saved, publish }   the personal best of a map: a built-in map
//                                                                  uses pb:<id> and may be published, an editor map its own ed:pb:<id> and never
import { newDoc, sanitizeDoc, importDoc, serialise, CELLS_MSG } from './model.js';
import { toDef, docIdOf } from './convert.js';
import { CUSTOM_LIMIT, CUSTOM_MAX_BYTES } from '../store.js';

export { docIdOf };

export function loadDoc(store, id) {
  const raw = store.getCustom(id);
  return raw ? sanitizeDoc(raw) : null;
}

export function newMapDoc(store, now) {
  const names = new Set(store.listCustom().map((e) => e.name));
  let name = 'Új pálya';
  for (let i = 2; names.has(name); i++) name = 'Új pálya ' + i;
  return newDoc({ id: store.freshCustomId(), name, created: now });
}

// ---------------------------------------------------------------- the list
const infoCache = new Map();   // id -> { updated, n, info }: the build of a saved version is not free, the list is opened often
export const mapInfo = (map) => ({ cps: map.checkpoints.length, fin: !!map.finish, hash: map.mapHash });
function analyse(store, id) {
  const doc = loadDoc(store, id);
  if (!doc) return { ok: false, error: 'A pálya fájlja hibás.', cps: 0, fin: false, hash: null };
  try {
    return { ok: true, error: null, ...mapInfo(toDef(doc).def.build()) };
  } catch (e) { return { ok: false, error: e && e.message === CELLS_MSG ? CELLS_MSG : 'A pálya nem építhető fel.', cps: 0, fin: false, hash: null }; }
}
export function describeMap(store, entry) {
  let info;
  if (entry.hash) info = { ok: true, error: null, cps: entry.cps, fin: entry.fin, hash: entry.hash };   // (saved with its info: nothing to build)
  else {
    let c = infoCache.get(entry.id);
    if (!c || c.updated !== entry.updated || c.n !== entry.n) { c = { updated: entry.updated, n: entry.n, info: analyse(store, entry.id) }; infoCache.set(entry.id, c); }
    info = c.info;
  }
  return { ...entry, ...info, pb: info.hash ? store.getCustomPB(entry.id, info.hash) : null };
}

export function prepareRun(store, id) {
  const doc = loadDoc(store, id);
  if (!doc) return { error: 'A pálya nem található, vagy a fájlja hibás.' };
  let def;
  try { def = toDef(doc).def; } catch (e) { return { error: e && e.message === CELLS_MSG ? CELLS_MSG : 'A pálya nem építhető fel.', doc }; }
  if (!def.build().finish) return { error: 'Hiányzik a cél: a szerkesztőben tegyél le egy célt.', doc };
  return { doc, def };
}

// ---------------------------------------------------------------- import / export
export function importMapText(store, text, now = Date.now()) {
  const r = importDoc(typeof text === 'string' ? text.replace(/^﻿/, '') : text);
  if (r.error) return { error: r.error };
  const doc = r.doc;
  let info;
  try { info = mapInfo(toDef(doc).def.build()); } catch (e) { return { error: e && e.message === CELLS_MSG ? CELLS_MSG : 'A pálya nem építhető fel, a fájl hibás.' }; }
  if (serialise(doc).length > CUSTOM_MAX_BYTES) return { error: 'A pálya túl nagy (legfeljebb 1 MB).' };
  if (store.listCustom().length >= CUSTOM_LIMIT) return { error: `Legfeljebb ${CUSTOM_LIMIT} saját pálya fér el: törölj egyet az importálás előtt.` };
  const renamed = store.hasCustom(doc.id);   // never overwrite a map of ours: a copy with a new id
  if (renamed) doc.id = store.freshCustomId();
  doc.updated = now;
  if (!doc.created) doc.created = now;
  return { doc, renamed, saved: store.saveCustom(doc, { info, last: false }) };
}

const slug = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
export const exportName = (doc) => `pajzsugras-${slug(doc.name) || doc.id}.json`;
export const exportFile = (doc) => ({ name: exportName(doc), text: serialise(doc) });

// a download of `text` without a server: a Blob and a temporary <a download>
export function downloadText(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  const t = setTimeout(() => URL.revokeObjectURL(url), 4000);
  if (t && t.unref) t.unref();
  return true;
}

// ---------------------------------------------------------------- personal bests
// An editor map (custom) keeps its record under ed:pb:<doc id>: never a pb:<id> key of a built-in map, and publish is false, so nothing of it
// reaches the leaderboard. A built-in map behaves as ever.
export function readPB(store, mapId, mapHash, custom) {
  if (!custom) return store.getPB(mapId, mapHash);
  const id = docIdOf(mapId);
  return id ? store.getCustomPB(id, mapHash) : null;
}
export function recordPB(store, mapId, mapHash, run, custom) {
  if (!custom) return { saved: store.setPB(mapId, mapHash, run), publish: true };
  const id = docIdOf(mapId);
  return { saved: id ? store.setCustomPB(id, mapHash, run) : false, publish: false };
}

// ---------------------------------------------------------------- rename / delete
// (renaming keeps `updated`, the index info and ed:last: no geometry changed, so the personal best stays valid, the list order does not jump
// and F2 still opens the map that was edited last)
export function renameMap(store, id, name) {
  const raw = store.getCustom(id);
  const doc = raw && sanitizeDoc({ ...raw, name });
  if (!doc) return false;
  const prev = store.listCustom().find((e) => e.id === id);
  return store.saveCustom(doc, { info: prev && prev.hash ? prev : null, last: false });
}
export function deleteMap(store, id) {
  infoCache.delete(id);
  return store.removeCustom(id);
}
