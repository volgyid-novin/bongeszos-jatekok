// PAJZSUGRÁS map editor: document -> map definition. Pure (node-testable): the same builder the built-in maps use.
//
//   const { def, brushItem } = toDef(doc)    def = defineMap(...) for createWorld(def) (already built: errors are thrown here, also for a doc whose
//                                            collision grid would be over LIM.cells);
//                                            brushItem[brush id] = the id of the doc item that made the brush
//   meta = { id: 'sajat-' + doc.id, name, diff: 'kozepes', order: 99, authorTime: 0, blurb: '', custom: true, theme }, where
//   theme is a copy of the theme preset (sky, fog, palette ...) `doc.theme` (editor/themes.js). meta.custom lets the builder accept a map
//   without finish / checkpoints / brushes (sim/builder.js). The ten material presets of the editor are registered on every map.
//
//   const def = builtinDef(doc, id, order)   the same map as a BUILT-IN map (maps/index.js: the exports of the editor, npm run add-map; the document is
//                                            cleaned with sanitizeDoc first, an invalid one throws): meta = { id,
//                                            name: doc.name, diff: 'nincs', order, authorTime: 0, blurb: '', exported: true, theme }. Lazy: def.build()
//                                            runs when the map is loaded. No authorTime: no medals (sim/world.js hasMedals).
import { defineMap } from '../sim/builder.js';
import { DEFAULT_THEME, LIM, CELLS_MSG, docCells, sanitizeDoc } from './model.js';
import { THEMES } from './themes.js';

// the extra materials (floor, wall, walldodge and trim come with the builder), tinted from the theme palette
function addMaterials(b, pal) {
  b.mat('metal', { base: 'metal', color: pal.wall, trim: pal.trim });
  b.mat('glass', { base: 'glass', color: pal.glow, trim: pal.glow });
  b.mat('hazard', { base: 'hazard', color: 0xffc400, trim: 0x202830 });
  b.mat('rock', { base: 'rock', color: pal.wall, trim: pal.trim });
  b.mat('crystal', { base: 'crystal', color: pal.glow, trim: pal.glow, emissive: pal.glow });
  b.mat('grate', { base: 'grate', color: pal.floor, trim: pal.trim });
}

// the map id of a document and back (null: not an editor map)
export const customMapId = (docId) => 'sajat-' + docId;
export const docIdOf = (mapId) => (typeof mapId === 'string' && mapId.startsWith('sajat-') ? mapId.slice(6) : null);

export function themeOf(id) {
  return JSON.parse(JSON.stringify(Object.hasOwn(THEMES, id) ? THEMES[id] : THEMES[DEFAULT_THEME]));
}

// the definition of a document with the given meta; brushItem is filled when the map is built
function makeDef(doc, meta) {
  if (docCells(doc) > LIM.cells) throw new Error(CELLS_MSG);   // (createWorld would allocate a collision grid of hundreds of millions of cells)
  const brushItem = [];
  const def = defineMap(meta, (b) => {
    addMaterials(b, b.meta.theme.palette);
    b.start(doc.start.pos, doc.start.yaw);
    for (const it of doc.items) {
      switch (it.t) {
        case 'block': brushItem[b.block(it.c, it.size, { mat: it.mat, yaw: it.yaw })] = it.id; break;
        case 'ramp': brushItem[b.ramp(it.c, it.size, { mat: it.mat, yaw: it.yaw })] = it.id; break;
        case 'prism': brushItem[b.prism(it.c, it.r, it.h, { sides: it.sides, mat: it.mat, yaw: it.yaw })] = it.id; break;
        case 'kill': b.kill(corner(it, -1), corner(it, 1), it.kind); break;
        case 'cp': b.checkpoint(corner(it, -1), corner(it, 1), { yaw: it.yaw }); break;
        case 'finish': b.finish(corner(it, -1), corner(it, 1)); break;
        case 'pad': b.pad(it.pos, { target: it.target, apex: it.apex }); break;
        case 'light': b.light(it.pos, it.color, it.intensity, it.range); break;
        case 'deco': b.deco(it.kind, { pos: it.pos, size: it.size, yaw: it.yaw }); break;
        default: break;
      }
    }
  });
  return { def, brushItem };
}

export function toDef(doc) {
  const meta = { id: customMapId(doc.id), name: doc.name, diff: 'kozepes', order: 99, authorTime: 0, blurb: '', custom: true, theme: themeOf(doc.theme) };
  const r = makeDef(doc, meta);
  r.def.build();
  return r;
}

export function builtinDef(doc, id, order) {
  const clean = sanitizeDoc(doc);   // (a hand-edited maps/<id>.js gets the importer's limits too: sizes, counts, one finish, a clean name)
  if (!clean) throw new Error(`A(z) „${id}” beépített pálya nem érvényes pályafájl (v1).`);
  const meta = { id, name: clean.name, diff: 'nincs', order, authorTime: 0, blurb: '', exported: true, theme: themeOf(clean.theme) };
  return makeDef(clean, meta).def;
}

const corner = (it, s) => [it.c[0] + (s * it.size[0]) / 2, it.c[1] + (s * it.size[1]) / 2, it.c[2] + (s * it.size[2]) / 2];
