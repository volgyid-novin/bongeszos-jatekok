// How long the player spends in the canyon (loc.canyon > 0.5) and under the arch, at race speed.
import { launch, open } from './lib.mjs';
const browser = await launch({ w: 800, h: 450, webgpu: false });
const page = await open(browser, 'q=low&renderer=webgl');
const r = await page.evaluate(() => {
  const H = window.__homok;
  H.start(1, 1, false);
  const a = H.rocks.arch, dt = 0.1, out = [];
  let inC = null, prev = null, dist = 0, vmax = 0, archT = 0;
  for (let t = 0; t < 150; t += dt) {
    H.sim(dt);
    const p = H.racer(0);
    if (prev) dist += Math.hypot(p.x - prev.x, p.z - prev.z);
    prev = { x: p.x, z: p.z };
    const v = Math.abs(p.fwd);
    if (p.loc.canyon > 0.5) { if (!inC) inC = { t, d: dist, v: [] }; inC.v.push(v); }
    else if (inC) { out.push({ t0: +inC.t.toFixed(1), secs: +(t - inC.t).toFixed(1), metres: Math.round(dist - inC.d), kmh: Math.round(inC.v.reduce((s, x) => s + x, 0) / inC.v.length * 3.6) }); inC = null; }
    if (a && Math.hypot(p.x - a.x, p.z - a.z) < 30) archT += dt;
    vmax = Math.max(vmax, v);
  }
  return { canyon: out, archSecs: +archT.toFixed(1), vmaxKmh: Math.round(vmax * 3.6), lapM: Math.round(dist) };
});
console.log(JSON.stringify(r));
await browser.close();
