// Module hooks for the app-level tests (registered by app-tests.mjs before the product modules are imported):
//   `trystero`  -> test/trystero-mock.mjs   (no WebRTC, no relays, no network)
//   `*.css`     -> an empty module          (race.js / leaderboard.js import mp.css, node cannot)
const MOCK = new URL('./trystero-mock.mjs', import.meta.url).href;

export async function resolve(specifier, ctx, next) {
  if (specifier === 'trystero') return { url: MOCK, shortCircuit: true };
  return next(specifier, ctx);
}

export async function load(url, ctx, next) {
  if (url.split('?')[0].endsWith('.css')) return { format: 'module', source: 'export default {};', shortCircuit: true };
  return next(url, ctx);
}
