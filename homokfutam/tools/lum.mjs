// node lum.mjs <tag> "query" [--size 1600x900]
// For each fixed view: a screenshot, and the HDR luminance of the scene pass (before AO / tone mapping):
// geometric mean (EV, log2), centre-weighted geometric mean, median, 5th / 95th percentile, share of sky.
// Also adds canyon-exit views (inside looking out, outside looking in) to views.json on first use.
import fs from 'node:fs';
import path from 'node:path';
import { launch, open, freeze, shot, OUT, VIEWS_FILE } from './lib.mjs';

const argv = process.argv.slice(2);
const tag = argv.shift();
let w = 1600, h = 900;
const qs = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--size') [w, h] = argv[++i].split('x').map(Number);
  else qs.push(argv[i]);
}
const views = JSON.parse(fs.readFileSync(VIEWS_FILE, 'utf8'));
const browser = await launch({ w, h, dpr: 1 });
const page = await open(browser, qs[0]);

if (!views.exitIn) {
  const v = await page.evaluate(() => {
    const H = window.__homok;
    H.start(1, 1, false);
    const trail = [];
    let was = false, exit = null;
    for (let t = 0; t < 120; t += 0.25) {
      H.sim(0.25);
      const r = H.racer(0);
      trail.push({ x: r.x, y: r.y, z: r.z, yaw: r.yaw, c: r.loc.canyon });
      if (r.loc.canyon > 0.9) was = true;
      if (was && r.loc.canyon < 0.05) { exit = trail.length - 1; break; }
    }
    if (exit == null) return null;
    // the last sample deep in the canyon, and a point ~120 m further back
    let k = exit; while (k > 0 && trail[k].c < 0.97) k--;
    const e = trail[k];
    let b = k; while (b > 0 && Math.hypot(trail[b].x - e.x, trail[b].z - e.z) < 110) b--;
    const s = trail[b], o = trail[Math.min(trail.length - 1, exit + 2)];
    // entering: outside, before the canyon; find the first sample with canyon > 0.05, go 120 m back
    let f = 0; while (f < trail.length && trail[f].c < 0.05) f++;
    let g = f; while (g > 0 && Math.hypot(trail[g].x - trail[f].x, trail[g].z - trail[f].z) < 90) g--;
    const p = trail[g], q = trail[Math.min(trail.length - 1, f + 8)];
    return {
      exitIn: { eye: [s.x, s.y + 3.5, s.z], look: [o.x, o.y + 4, o.z], fov: 65, abs: true },
      exitOut: { eye: [o.x, o.y + 3.5, o.z], look: [o.x + Math.sin(o.yaw) * 80, o.y + 3, o.z + Math.cos(o.yaw) * 80], fov: 65, abs: true },
      enterOut: { eye: [p.x, p.y + 3.5, p.z], look: [q.x, q.y + 6, q.z], fov: 65, abs: true },
    };
  });
  if (v) { Object.assign(views, v); fs.writeFileSync(VIEWS_FILE, JSON.stringify(views, null, 1)); }
  else console.log('no canyon exit found');
}

await page.evaluate(() => { const H = window.__homok; H.start(1, 1, false); H.sim(12); });
await page.keyboard.press('Escape');
await freeze(page);

const rows = [];
for (const [name, cam] of Object.entries(views)) {
  await page.evaluate((c) => window.__homok.view(c), cam);
  const f = path.join(OUT, `${tag}_${name}.png`);
  await shot(page, f);
  const m = await page.evaluate(async () => {
    const H = window.__homok, r = H.renderer, p = H.post;
    const rt = p?.scenePass?.renderTarget;
    if (!rt) return null;
    const W = rt.width, Ht = rt.height;
    const buf = await r.readRenderTargetPixelsAsync(rt, 0, 0, W, Ht, 0);
    const half = (u) => { const s = u >> 15, e = (u >> 10) & 31, m = u & 1023; const v = e === 0 ? m * 2 ** -24 : e === 31 ? (m ? NaN : Infinity) : (1 + m / 1024) * 2 ** (e - 15); return s ? -v : v; };
    const get = buf instanceof Uint16Array ? (i) => half(buf[i]) : (i) => buf[i];
    const L = [];
    let sl = 0, sw = 0, swl = 0, n = 0;
    for (let y = 0; y < Ht; y += 2) for (let x = 0; x < W; x += 2) {
      const i = (y * W + x) * 4;
      const l = 0.2126 * get(i) + 0.7152 * get(i + 1) + 0.0722 * get(i + 2);
      if (!(l >= 0) || !isFinite(l)) continue;
      const lg = Math.log2(Math.max(l, 1e-4));
      L.push(l); sl += lg; n++;
      // centre weight: a gaussian over the middle (sigma = 0.25 of the width)
      const dx = (x / W - 0.5) / 0.25, dy = (y / Ht - 0.5) / 0.25, wgt = Math.exp(-0.5 * (dx * dx + dy * dy));
      sw += wgt; swl += wgt * lg;
    }
    L.sort((a, b) => a - b);
    const q = (k) => L[Math.floor(k * (L.length - 1))];
    return { W, H: Ht, ev: +(sl / n).toFixed(2), evC: +(swl / sw).toFixed(2), med: +q(0.5).toFixed(3), p5: +q(0.05).toFixed(3), p95: +q(0.95).toFixed(3), p99: +q(0.99).toFixed(2), type: buf.constructor.name };
  });
  rows.push({ name, ...m });
  console.log(name.padEnd(12), JSON.stringify(m));
}
fs.writeFileSync(path.join(OUT, `${tag}_lum.json`), JSON.stringify(rows, null, 1));
const errs = page.logs.filter((l) => /error|PAGEERROR/i.test(l));
if (errs.length) console.log('ERR', errs.slice(0, 4).join(' / '));
await browser.close();
