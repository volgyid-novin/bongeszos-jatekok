// node trace.mjs <tag> "query" [--shots t1,t2,...]
// Adaptation trace through the canyon: a fresh race fast-forwarded to just before the canyon, then run in
// real time with the chase camera, logging (race time, canyon, metered EV, target, exposure EV) every 100 ms
// and taking chase-camera screenshots at the given race times. Writes out/<tag>_trace.json.
import fs from 'node:fs';
import path from 'node:path';
import { launch, open, OUT } from './lib.mjs';
const argv = process.argv.slice(2);
const tag = argv.shift(), q = argv.shift();
let shots = [], until = 34, from = 16;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--shots') shots = argv[++i].split(',').map(Number);
  else if (argv[i] === '--until') until = +argv[++i];
  else if (argv[i] === '--from') from = +argv[++i];
  else if (argv[i] === '--every') { const [a, b, st] = argv[++i].split(':').map(Number); for (let x = a; x <= b + 1e-6; x += st) shots.push(+x.toFixed(2)); }
}
const browser = await launch({ w: 1280, h: 720, webgpu: !/renderer=webgl/.test(q) });
const page = await open(browser, q);
await page.evaluate((f) => { const H = window.__homok; H.start(1, 1, false); H.sim(f); }, from);
await page.evaluate(() => {
  const H = window.__homok;
  window.__trace = [];
  const t0 = performance.now();
  const tick = () => {
    const e = H.eye, r = H.racer(0), i = H.info();
    window.__trace.push({ t: +i.raceT.toFixed(2), c: +r.loc.canyon.toFixed(2), m: e ? +e.metered.toFixed(2) : null, tg: e ? +e.target.toFixed(2) : null, ev: e ? +e.ev.toFixed(3) : null, kmh: Math.round(Math.abs(r.fwd) * 3.6) });
  };
  window.__traceId = setInterval(tick, 100);
});
const done = new Set();
for (;;) {
  const t = await page.evaluate(() => window.__homok.info().raceT);
  const due = shots.find((s) => !done.has(s) && t >= s);
  if (due != null) {
    done.add(due);
    await page.screenshot({ path: path.join(OUT, `${tag}_t${due}.png`) });
  }
  if (t >= until) break;
  await new Promise((r) => setTimeout(r, 30));
}
const trace = await page.evaluate(() => { clearInterval(window.__traceId); return window.__trace; });
fs.writeFileSync(path.join(OUT, `${tag}_trace.json`), JSON.stringify(trace));
// summary: entering, exit
const inC = trace.filter((p) => p.c > 0.5);
console.log('points', trace.length, 'canyon', inC.length ? `${inC[0].t}..${inC[inC.length - 1].t}` : 'none');
for (let k = 0; k < trace.length; k += 5) { const p = trace[k]; console.log(p.t, 'c', p.c, 'm', p.m, 'tg', p.tg, 'ev', p.ev, p.kmh + 'km/h'); }
const errs = page.logs.filter((l) => /error|PAGEERROR/i.test(l));
if (errs.length) console.log('ERR', errs.slice(0, 5).join('\n'));
await browser.close();
