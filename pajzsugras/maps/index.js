// The map registry. Every built-in map is a map document exported from the in-game editor (maps/<id>.js: `export default { "v": 1, ... }`,
// plain JSON), turned into a map by editor/convert.js builtinDef when the registry loads (it cleans the document with sanitizeDoc first, so a
// hand-edited file gets the importer's limits, and throws for one that is no map file). The list may be empty. Add one with
//
//     npm run add-map -- <export.json> [id]
//
// (tools/add-map.mjs writes maps/<id>.js and registers it between the markers below; the same command with the same id updates it).
// The position in SOURCES is the order of the maps (1, 2, ...). Static imports (the bundler needs them); meta is read eagerly, build()
// runs when a map is loaded.
import { builtinDef } from '../editor/convert.js';
// <add-map imports>
import map_uj_palya from './uj-palya.js';
// </add-map imports>

const SOURCES = [
  // <add-map entries>
  ['uj-palya', map_uj_palya],
  // </add-map entries>
];

const list = SOURCES.map(([id, doc], i) => builtinDef(doc, id, i + 1));
const byId = new Map(list.map((m) => [m.meta.id, m]));

export const MAPS = {
  list,                                   // [{ meta, build() }] in order
  ids: list.map((m) => m.meta.id),
  get: (id) => byId.get(id) || null,
  has: (id) => byId.has(id),
};
export default MAPS;

// difficulty labels for the UI ('nincs': an exported map has no difficulty, no chip)
export const DIFF_LABEL = { kikepzes: 'Kiképzés', konnyu: 'Könnyű', kozepes: 'Közepes', nehez: 'Nehéz', mester: 'Mester', nincs: '' };
