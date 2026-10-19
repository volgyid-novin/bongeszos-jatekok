// App-level suites (everything that is not the sim): nostr.js, leaderboard.js, race.js + net.js, input.js, store.js, the map editor's
// pure parts (editor-tests.mjs: model, convert, pick; the builder / world relaxations for custom maps; editor-edge-tests.mjs: hostile files, awkward maps,
// the store / controller / race.js corner cases; editor-multi-tests.mjs: batch undo, sticking, multi-select, group operations, resize arrows; gorge-anim-tests.mjs, gorge-figures-tests.mjs, gorge-edge-tests.mjs: the Gorge animation brain, figures and their edge cases;
// gorge-skin-tests.mjs: the repainted-skin PNG override; third-person-tests.mjs: the V key / Nézet setting, the chase camera and the own figure; third-person-edge-tests.mjs: the same with the sim in the loop (respawns, animation vs sim events, the routes' camera), the skin override's edges, the 144 Hz input path; local-guard-tests.mjs: the dev server keeps the local UT2004 extracts on this machine; local-maps-tests.mjs: a ported UT2004 map in local-maps/ imports itself, on a local dev host only; shieldgun-tests.mjs: the UT2004 shield gun, first person and in the Gorge's hand; sounds-tests.mjs: our own generated sounds (assets/sounds/) and audio.js; gauntlet-tests.mjs: our own shield gauntlet, built from code).
// real-map-tests.mjs: the fixed double jump / wall dodge rules on the player's real map through the real input path at 60 / 144 Hz, and their limits; one-map-tests.mjs: the app
// with exactly one built-in map (UI, room, leaderboard, stale data, theme list) and the add-map tool's edges.
// Run from test/run.mjs as section (e), or alone:  node pajzsugras/test/app-tests.mjs [filter]   (or: npm run test:pj -- --app [--only=text])
// No network: WebSocket is replaced by mock relays, trystero by a mock room (see loader-hooks.mjs); never publishes anywhere.
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { runAll } from './harness.mjs';

register('./loader-hooks.mjs', import.meta.url);   // must come before the product modules (race.js, leaderboard.js) are imported

export async function runAppTests({ only = null } = {}) {
  await import('./input-store-tests.mjs');
  await import('./nostr-tests.mjs');
  await import('./leaderboard-tests.mjs');
  await import('./race-tests.mjs');
  await import('./editor-tests.mjs');
  await import('./editor-edge-tests.mjs');
  await import('./editor-multi-tests.mjs');
  await import('./add-map-tests.mjs');
  await import('./real-map-tests.mjs');
  await import('./one-map-tests.mjs');
  await import('./uj-palya-extension-tests.mjs');
  await import('./gorge-anim-tests.mjs');
  await import('./gorge-figures-tests.mjs');
  await import('./gorge-edge-tests.mjs');
  await import('./gorge-skin-tests.mjs');
  await import('./third-person-tests.mjs');
  await import('./third-person-edge-tests.mjs');
  await import('./local-guard-tests.mjs');
  await import('./local-maps-tests.mjs');
  await import('./local-maps-edge-tests.mjs');
  await import('./shieldgun-tests.mjs');
  await import('./sounds-tests.mjs');
  await import('./gauntlet-tests.mjs');
  await import('./deploy-model-tests.mjs');
  return runAll({ only });
}

// direct run
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rows = await runAppTests({ only: process.argv[2] || null });
  for (const r of rows) console.log(`${r.ok ? '  ok   ' : '  FAIL '}${r.name}${r.ok ? '' : '\n        ' + r.detail}`);
  const bad = rows.filter((r) => !r.ok).length;
  console.log(bad ? `\n${bad} hiba` : '\nminden rendben');
  process.exit(bad ? 1 : 0);
}
