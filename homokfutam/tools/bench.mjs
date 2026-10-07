// node bench.mjs [--dpr 2] [--rounds 2] [--frames 150] "q=high&renderer=webgpu&gfx=sky:0" "q=high&renderer=webgpu&gfx=sky:1"
// Interleaves the variants (A, B, A, B), reports per-spot fps / js / draws / tris and the median per variant.
import { launch, open, benchSpots } from './lib.mjs';

const argv = process.argv.slice(2);
let dpr = 1, rounds = 2, frames = 150, w = 1920, h = 1080;
const qs = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--dpr') dpr = +argv[++i];
  else if (argv[i] === '--rounds') rounds = +argv[++i];
  else if (argv[i] === '--frames') frames = +argv[++i];
  else if (argv[i] === '--size') { [w, h] = argv[++i].split('x').map(Number); }
  else qs.push(argv[i]);
}
const res = qs.map(() => []);
for (let r = 0; r < rounds; r++) {
  for (let k = 0; k < qs.length; k++) {
    const browser = await launch({ w, h, dpr, webgpu: !/renderer=webgl/.test(qs[k]) });
    try {
      const page = await open(browser, qs[k]);
      const out = await benchSpots(page, frames);
      res[k].push(out);
      const errs = page.logs.filter((l) => /error|PAGEERROR/i.test(l));
      console.log(`[${r}] ${qs[k]}\n  ` + Object.entries(out).map(([s, v]) => `${s} ${v.fps}fps js${v.jsMs}${v.gpuMs != null ? ' gpu' + v.gpuMs : ''} ${v.calls}dc ${(v.tris / 1e6).toFixed(2)}Mt`).join(' | ') + (errs.length ? '\n  ERR ' + errs.slice(0, 3).join(' / ') : ''));
    } catch (e) { console.log('FAILED', qs[k], e.message); }
    await browser.close();
  }
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
console.log('\nmedian over rounds (fps / ms per frame / js ms / draws):');
for (let k = 0; k < qs.length; k++) {
  const spots = Object.keys(res[k][0] || {});
  console.log(qs[k]);
  console.log('  ' + spots.map((s) => {
    const fps = med(res[k].map((o) => o[s].fps));
    const g = med(res[k].map((o) => o[s].gpuMs ?? NaN));
    return `${s} ${fps} (${(1000 / fps).toFixed(2)}ms) js${med(res[k].map((o) => o[s].jsMs))}${isNaN(g) ? '' : ' gpu' + g} ${med(res[k].map((o) => o[s].calls))}dc`;
  }).join(' | '));
}
