// node rtspike.mjs [--radius 300,600] [--views canyonFwd,dunes,grid] [--size 960x540] [--ordered]
// The D9 spike: GPU ray tracing in a fragment pass (gfx/tsl/rt.js) against a BVH of the static world round fixed
// cameras; rays per second for primary (coherent), random (incoherent) and shadow (any hit) rays. WebGPU, ?gputime.
import fs from 'node:fs';
import { launch, open, freeze, VIEWS_FILE } from './lib.mjs';
const argv = process.argv.slice(2);
let radii = [300], only = ['canyonFwd', 'dunes', 'grid'], size = [960, 540], ordered = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--radius') radii = argv[++i].split(',').map(Number);
  else if (argv[i] === '--views') only = argv[++i].split(',');
  else if (argv[i] === '--size') size = argv[++i].split('x').map(Number);
  else if (argv[i] === '--ordered') ordered = true;
}
process.env.HF_ARGS = '--enable-dawn-features=allow_unsafe_apis';
const views = JSON.parse(fs.readFileSync(VIEWS_FILE, 'utf8'));
const browser = await launch({ w: 1280, h: 720 });
const page = await open(browser, 'q=high&renderer=webgpu&gputime');
await page.evaluate(() => { const H = window.__homok; H.start(1, 1, false); H.sim(12); });
await page.keyboard.press('Escape');
await freeze(page);
for (const v of only) {
  for (const radius of radii) {
    await page.evaluate((c) => window.__homok.view(c), views[v]);
    const r = await page.evaluate((o) => window.__homok.rtSpike(o), { radius, size, ordered });
    console.log(v.padEnd(10), `r=${radius}`, JSON.stringify(r));
  }
}
const errs = page.logs.filter((l) => /error|PAGEERROR/i.test(l));
if (errs.length) console.log('ERR', errs.slice(0, 5).join('\n'));
await browser.close();
