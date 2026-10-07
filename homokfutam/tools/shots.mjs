// node shots.mjs <name> [--dpr 1] [--size 1600x900] [--views a,b] "query A" "query B" ...
// Captures every view for every variant, then tiles each view's variants side by side:
//   out/<name>_<view>.png. Cameras are fixed world-space views (views.json, made on first use from
//   pod-relative views on a fresh race), so all variants see the same scene.
import fs from 'node:fs';
import path from 'node:path';
import { launch, open, freeze, shot, tile, OUT, VIEWS_FILE } from './lib.mjs';

const argv = process.argv.slice(2);
const name = argv.shift();
let dpr = 1, w = 1600, h = 900, only = null, cols = 0, snippet = null;
const qs = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--dpr') dpr = +argv[++i];
  else if (argv[i] === '--size') [w, h] = argv[++i].split('x').map(Number);
  else if (argv[i] === '--views') only = argv[++i].split(',');
  else if (argv[i] === '--cols') cols = +argv[++i];
  else if (argv[i] === '--js') snippet = argv[++i];
  else qs.push(argv[i]);
}

// pod-relative definitions: spot (sim seconds from the start), eye / look (x left, y up, z forward), fov
const DEFS = {
  dunes: { t: 10, eye: [0, 7, -16], look: [0, 3, 60], fov: 62 },
  dunesFar: { t: 10, eye: [0, 18, -10], look: [0, 0, 600], fov: 55 },
  toSun: { t: 10, sun: 1, h: 5, fov: 70 },
  awaySun: { t: 10, sun: -1, h: 5, fov: 70 },
  canyon: { t: 20, eye: [0, 5, -14], look: [0, 4, 60], fov: 62 },
  arena: { t: 40, eye: [0, 6, -15], look: [0, 3, 60], fov: 62 },
  grid: { t: 0, eye: [6, 4, -10], look: [0, 1, 12], fov: 55 },
  close: { t: 10, eye: [2.5, 1.6, -7], look: [0, 0.2, 6], fov: 55 },
  groundTrack: { t: 10, eye: [1, 1.3, 6], look: [0, 0, 22], fov: 50 },
  groundSide: { t: 10, eye: [-14, 1.5, 0], look: [-24, 0, 14], fov: 50 },
  groundArena: { t: 40, eye: [1, 1.3, 6], look: [0, 0, 22], fov: 50 },
};

async function makeViews(page, have = {}) {
  const views = { ...have };
  await page.evaluate(() => window.__homok.start(1, 1, false));
  let simmed = 0;
  for (const [k, d] of Object.entries(DEFS).filter(([k]) => !have[k]).sort((a, b) => a[1].t - b[1].t)) {
    if (d.t > simmed) { await page.evaluate((s) => window.__homok.sim(s), d.t - simmed); simmed = d.t; }
    views[k] = await page.evaluate((d) => {
      const H = window.__homok, r = H.racer(0), cam = H.camera;
      if (d.sun) {
        const s = H.ATMO.hfSunDir.value, a = Math.atan2(s.z, s.x) + (d.sun < 0 ? Math.PI : 0);
        const eye = [r.x, r.y + d.h, r.z];
        return { eye, look: [eye[0] + Math.cos(a) * 100, eye[1] + 9, eye[2] + Math.sin(a) * 100], fov: d.fov, abs: true };
      }
      H.view({ eye: d.eye, look: d.look, fov: d.fov });
      const dir = new H.THREE.Vector3(); cam.getWorldDirection(dir);
      return { eye: cam.position.toArray(), look: cam.position.clone().addScaledVector(dir, 100).toArray(), fov: d.fov, abs: true };
    }, d);
  }
  return views;
}

const files = {};
for (let k = 0; k < qs.length; k++) {
  const browser = await launch({ w, h, dpr, webgpu: !/renderer=webgl/.test(qs[k]) });
  try {
    const page = await open(browser, qs[k]);
    let views = fs.existsSync(VIEWS_FILE) ? JSON.parse(fs.readFileSync(VIEWS_FILE, 'utf8')) : null;
    if (!views || Object.keys(DEFS).some((k) => !views[k])) { views = await makeViews(page, views || {}); fs.writeFileSync(VIEWS_FILE, JSON.stringify(views, null, 1)); }
    await page.evaluate(() => { const H = window.__homok; H.start(1, 1, false); H.sim(12); });
    await page.keyboard.press('Escape');     // pause: nothing moves between captures
    await freeze(page);
    if (snippet) await page.evaluate(snippet);
    for (const [v, cam] of Object.entries(views)) {
      if (only && !only.includes(v)) continue;
      await page.evaluate((c) => window.__homok.view(c), cam);
      const f = path.join(OUT, `${name}_${v}_${k}.png`);
      await shot(page, f);
      (files[v] ||= []).push(f);
    }
    const errs = page.logs.filter((l) => /error|PAGEERROR/i.test(l));
    console.log(qs[k], errs.length ? 'ERR ' + errs.slice(0, 4).join(' / ') : 'ok', page.logs.filter((l) => /baked|compiled/.test(l)).join(' | '));
  } catch (e) { console.log('FAILED', qs[k], e.message); }
  await browser.close();
}
for (const [v, list] of Object.entries(files)) {
  const out = path.join(OUT, `${name}_${v}.png`);
  tile(list, out, cols || Math.min(list.length, 2), list.length > 2 ? 0.5 : 0.75);
  console.log(out);
}
