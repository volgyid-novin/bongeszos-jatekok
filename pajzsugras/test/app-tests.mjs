// App-level suites (everything that is not the sim): nostr.js, leaderboard.js, race.js + net.js, input.js, store.js.
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
