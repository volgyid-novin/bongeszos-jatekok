// node eyecheck.mjs "query" : metered EV / target / exposure on the dunes, in the canyon, after it
import { launch, open } from './lib.mjs';
const q = process.argv[2];
const browser = await launch({ w: 1600, h: 900, webgpu: !/renderer=webgl/.test(q) });
const page = await open(browser, q);
const wait = (ms) => page.evaluate((ms) => new Promise((r) => setTimeout(r, ms)), ms);
const rd = () => page.evaluate(() => { const e = window.__homok.eye, r = window.__homok.racer(0); return e ? { metered: +e.metered.toFixed(2), target: +e.target.toFixed(2), ev: +e.ev.toFixed(2), canyon: +r.loc.canyon.toFixed(2) } : null; });
await page.evaluate(() => window.__homok.start(1, 1, false));
for (const [name, t] of [['dunes', 10], ['dunes2', 4], ['canyonIn', 4.5], ['canyonMid', 4], ['out', 8]]) {
  await page.evaluate((t) => window.__homok.sim(t), t);
  await wait(2500);
  console.log(name.padEnd(10), JSON.stringify(await rd()));
}
const errs = page.logs.filter((l) => /error|PAGEERROR/i.test(l));
if (errs.length) console.log('ERR', errs.slice(0, 5).join('\n'));
await browser.close();
