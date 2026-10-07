// node clip.mjs name "query" [--view name | --eye x,y,z --look x,y,z --fov f] [--size 1280x720] [--frames 8] [--from t0]
//   [--every s] [--cols n] [--crop x,y,w,h] [--js snippet] [--real] [--sim s]
// Things that move (gusts, falls, wakes) do not show in a still: this steps the shader clock (ATMO.hfTime)
// through --frames times from --from, every --every seconds, and captures each from a fixed world-space
// camera, then tiles them into out/<name>_clip.png (optionally cropped). The race is paused, so only what
// runs on the shader clock moves. --real lets the game run instead (particles, pods) and captures every
// --every seconds of real time.
import path from 'node:path';
import fs from 'node:fs';
import { launch, open, shot, tile, crop, OUT, VIEWS_FILE } from './lib.mjs';

const argv = process.argv.slice(2);
const name = argv.shift();
let w = 1280, h = 720, frames = 8, from = 100, every = 0.5, cols = 4, view = null, eye = null, look = null, fov = 60, cropBox = null, snippet = null, real = false, sim = 12;
let query = null, groundEye = null, tuft = null, trackCam = null;     // --track s,d,h,ahead,lh: h m over the track at s (lateral d), looking ahead m down it     // --ground x,z,h,lx,lz,lh: eye h m over the ground at x,z looking at lh over lx,lz
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--size') [w, h] = argv[++i].split('x').map(Number);
  else if (a === '--frames') frames = +argv[++i];
  else if (a === '--from') from = +argv[++i];
  else if (a === '--every') every = +argv[++i];
  else if (a === '--cols') cols = +argv[++i];
  else if (a === '--view') view = argv[++i];
  else if (a === '--eye') eye = argv[++i].split(',').map(Number);
  else if (a === '--look') look = argv[++i].split(',').map(Number);
  else if (a === '--fov') fov = +argv[++i];
  else if (a === '--crop') cropBox = argv[++i].split(',').map(Number);
  else if (a === '--ground') groundEye = argv[++i].split(',').map(Number);
  else if (a === '--tuft') tuft = argv[++i].split(',').map(Number);
  else if (a === '--track') trackCam = argv[++i].split(',').map(Number);
  else if (a === '--js') snippet = argv[++i];
  else if (a === '--real') real = true;
  else if (a === '--sim') sim = +argv[++i];
  else query = a;
}
let cam = view ? JSON.parse(fs.readFileSync(VIEWS_FILE, 'utf8'))[view] : { eye, look, fov, abs: true };

const browser = await launch({ w, h, webgpu: !/renderer=webgl/.test(query) });
const files = [];
try {
  const page = await open(browser, query);
  await page.evaluate((s) => { const H = window.__homok; H.start(1, 1, false); if (s) H.sim(s); }, sim);
  if (!real) await page.keyboard.press('Escape');
  await page.evaluate((t0, real) => {
    for (const e of document.body.children) if (e.id !== 'view') e.style.visibility = 'hidden';
    const H = window.__homok;
    if (!real) {
      window.__clipT = t0;
      Object.defineProperty(H.ATMO.hfTime, 'value', { get: () => window.__clipT, set: () => {}, configurable: true });
    }
    const g = H.post?.grade?.uniforms?.get('uGrain');
    if (g) g.value = 0;
    for (const k of ['uBlur', 'uAberr']) { const u = H.post?.speed?.uniforms?.get(k); if (u) Object.defineProperty(u, 'value', { get: () => 0, set: () => {}, configurable: true }); }
  }, from, real);
  if (groundEye) {
    const [x, z, hh, lx, lz, lh] = groundEye;
    cam = await page.evaluate((x, z, hh, lx, lz, lh, fov) => {
      const H = window.__homok;
      return { eye: [x, H.ground(x, z) + hh, z], look: [lx, H.ground(lx, lz) + lh, lz], fov, abs: true };
    }, x, z, hh, lx, lz, lh, fov);
    console.log('camera', JSON.stringify(cam));
  }
  if (trackCam) {
    const [s, d = 0, hh = 3, ahead = 30, lh = 0.5] = trackCam;
    cam = await page.evaluate((s, d, hh, ahead, lh, fov) => {
      const H = window.__homok, p = H.trackPoint(s, d), q = H.trackPoint(s + ahead, d);
      return { eye: [p.x, H.ground(p.x, p.z) + 0.35 + hh, p.z], look: [q.x, H.ground(q.x, q.z) + 0.35 + lh, q.z], fov, abs: true };
    }, s, d, hh, ahead, lh, fov);
    console.log('track camera', JSON.stringify(cam));
  }
  if (tuft) {
    // the grass tuft nearest x,z, seen from d m across the wind, h m up
    const [x, z, d = 3, hh = 0.7] = tuft;
    cam = await page.evaluate((x, z, d, hh, fov) => {
      const H = window.__homok, m = new H.THREE.Matrix4(), p = new H.THREE.Vector3();
      let best = null, bd = 1e9;
      H.scene.traverse((o) => {
        if (o.name !== 'grass' || !o.isInstancedMesh) return;
        for (let i = 0; i < o.count; i++) { o.getMatrixAt(i, m); p.setFromMatrixPosition(m); const dd = Math.hypot(p.x - x, p.z - z); if (dd < bd) { bd = dd; best = p.clone(); } }
      });
      if (!best) return null;
      const W = [0.92, 0.39], l = Math.hypot(...W), px = -W[1] / l, pz = W[0] / l;
      const ex = best.x + px * d, ez = best.z + pz * d;
      return { eye: [ex, H.ground(ex, ez) + hh, ez], look: [best.x, best.y + 0.3, best.z], fov, abs: true };
    }, x, z, d, hh, fov);
    console.log('tuft camera', JSON.stringify(cam));
  }
  await page.evaluate((c) => window.__homok.view(c), cam);
  if (snippet) await page.evaluate(snippet);
  const t0 = Date.now();
  for (let k = 0; k < frames; k++) {
    if (real) { const wait = t0 + k * every * 1000 - Date.now(); if (wait > 0) await new Promise((r) => setTimeout(r, wait)); }
    else await page.evaluate((t) => { window.__clipT = t; }, from + k * every);
    const f = path.join(OUT, `${name}_f${k}.png`);
    await shot(page, f);
    files.push(cropBox ? crop(f, f.replace('.png', '_c.png'), ...cropBox.slice(0, 4), cropBox[4] || 1) : f);
    const g = await page.evaluate((c) => window.__homok.gust?.(c.eye[0], c.eye[2]), cam);
    console.log(`frame ${k}: t ${real ? ((Date.now() - t0) / 1000).toFixed(2) : (from + k * every).toFixed(2)}, gust at the camera ${g?.toFixed?.(2)}`);
  }
  const errs = page.logs.filter((l) => /error|PAGEERROR/i.test(l));
  if (errs.length) console.log('ERR', errs.slice(0, 4).join(' / '));
} catch (e) { console.log('FAILED', e.message); }
await browser.close();
if (files.length) console.log(tile(files, path.join(OUT, `${name}_clip.png`), cols, cropBox ? 1 : 0.5));
