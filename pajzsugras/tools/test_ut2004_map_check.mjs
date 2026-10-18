// Helper of test_ut2004_map.py (not a test runner of its own):  node test_ut2004_map_check.mjs <doc.json> <repo root> [probes JSON] [UT yaw degrees]
// Feeds a map document made by ut2004_map.py through the editor's own code and prints ONE JSON line with what came out:
//   unchanged  importDoc(text) gives the same document, and serialise() gives the same text (byte for byte)
//   builds     toDef(doc).def.build() and createWorld() work (the theme is the one left, KIKEPZES)
//   startFree  the hull stands free at the start's feet, solidBelow: there is solid right under the feet
//   fwd        fwdOf(start yaw): the horizontal direction the player looks along
//   probes     for each probe feet position [x, y, z]: is the player hull inside solid there
//   validate   the editor's own checks (errors / warnings)
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [docPath, root, probesJson = '[]'] = process.argv.slice(2);
const R = pathToFileURL(path.resolve(root) + path.sep).href;
const out = {};
try {
  const { importDoc, serialise, validate, docCells, LIM } = await import(R + 'editor/model.js');
  const { toDef } = await import(R + 'editor/convert.js');
  const { THEMES } = await import(R + 'editor/themes.js');
  const { createWorld } = await import(R + 'sim/world.js');
  const { hullSolid } = await import(R + 'sim/pmove.js');
  const { fwdOf, DEG } = await import(R + 'sim/math.js');

  const text = fs.readFileSync(docPath, 'utf8');
  const res = importDoc(text);
  if (!res.doc) throw new Error('importDoc: ' + res.error);
  const doc = res.doc;
  out.unchanged = JSON.stringify(doc) === JSON.stringify(JSON.parse(text)) && serialise(doc) === text.trim();
  out.cells = docCells(doc); out.cellLimit = LIM.cells;
  const { def } = toDef(doc);
  const map = def.build();
  const world = createWorld(def);
  out.builds = true;
  out.themeIsKikepzes = JSON.stringify(map.theme.palette) === JSON.stringify(THEMES.kikepzes.palette);
  out.hasFinish = !!map.finish;
  const [x, y, z] = doc.start.pos;
  out.startFree = !hullSolid(world.cw, [x, y + 0.02, z]);
  out.solidBelow = hullSolid(world.cw, [x, y - 0.05, z]);
  out.fwd = fwdOf(doc.start.yaw * DEG);
  out.probes = JSON.parse(probesJson).map((p) => hullSolid(world.cw, p));
  out.validate = validate(doc, world);
} catch (e) {
  out.error = String((e && e.stack) || e);
}
console.log(JSON.stringify(out));
