// node nanscan.mjs ["query"] [view] : WebGL only. Runs the post chain pass by pass on a fixed view and counts NaN /
// Inf in the composer's buffers after each: a single NaN pixel spreads through the bloom into a black frame.
import fs from 'node:fs';
import { launch, open, freeze, VIEWS_FILE } from './lib.mjs';
const views = JSON.parse(fs.readFileSync(VIEWS_FILE, 'utf8'));
const viewName = process.argv[3] || 'dunes';
const browser = await launch({ w: 960, h: 540, webgpu: false });
const page = await open(browser, process.argv[2] || 'q=high&renderer=webgl');
await page.evaluate(() => { const H = window.__homok; H.start(1, 1, false); H.sim(12); });
await page.keyboard.press('Escape');
await freeze(page);
const r = await page.evaluate((c) => {
  const H = window.__homok, T = H.THREE, R = H.renderer, comp = H.post.composer;
  H.view(c);
  const half = (u) => { const s = u >> 15, e = (u >> 10) & 31, m = u & 1023; const v = e === 0 ? m * 2 ** -24 : e === 31 ? (m ? NaN : Infinity) : (1 + m / 1024) * 2 ** (e - 15); return s ? -v : v; };
  const res = {};
  // after each prefix of the chain: render passes 0..k only, read what pass k wrote
  const passes = comp.passes, saved = passes.map((p) => p.enabled);
  for (let k = 0; k < passes.length; k++) {
    passes.forEach((p, i) => { p.enabled = i <= k && saved[i]; });
    if (!saved[k]) continue;
    // keep the last pass off screen so its output stays in the buffers
    const rts = passes[k].renderToScreen; passes[k].renderToScreen = false;
    comp.render(0.016);
    passes[k].renderToScreen = rts;
    for (const [nm, rt] of [['in', comp.inputBuffer], ['out', comp.outputBuffer]]) {
      const w = rt.width, h = rt.height, b = new Uint16Array(w * h * 4);
      try { R.readRenderTargetPixels(rt, 0, 0, w, h, b); } catch (e) { res[k + nm] = 'read failed ' + e.message; continue; }
      let nan = 0, inf = 0, mx = 0;
      for (let i = 0; i < b.length; i++) { const v = half(b[i]); if (v !== v) nan++; else if (!isFinite(v)) inf++; else if (v > mx) mx = v; }
      res[k + ' ' + passes[k].name + ' ' + nm] = { nan, inf, mx: +mx.toFixed(2) };
    }
  }
  passes.forEach((p, i) => { p.enabled = saved[i]; });
  return res;
}, views[viewName]);
for (const [k, v] of Object.entries(r)) console.log(k, JSON.stringify(v));
await browser.close();
