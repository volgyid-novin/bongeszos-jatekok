// Shared harness for HOMOKFUTAM measurements (headless Chrome via puppeteer-core). See README.md.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

// this folder, the captures and logs (out/, not in git), the fixed cameras, the game's assets
export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const OUT = path.join(HERE, 'out');
fs.mkdirSync(OUT, { recursive: true });
export const VIEWS_FILE = path.join(HERE, 'views.json');
export const ASSETS = path.join(HERE, '..', 'assets');

export const BASE = process.env.HF_BASE || 'http://127.0.0.1:5199/homokfutam/';
const CHROME = process.env.HF_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

export async function launch({ w = 1920, h = 1080, dpr = 1, webgpu = true } = {}) {
  const args = [...(process.env.HF_ARGS ? process.env.HF_ARGS.split(" ") : []), '--mute-audio', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-vsync', '--disable-frame-rate-limit',
    `--window-size=${w},${h}`];
  if (webgpu) args.push('--enable-unsafe-webgpu');
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args, defaultViewport: { width: w, height: h, deviceScaleFactor: dpr }, protocolTimeout: 600000 });
  return browser;
}

export async function open(browser, query, { tries = 4, timeout = 120000 } = {}) {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    try { window.speechSynthesis.speak = () => {}; } catch {}
    const AC = window.AudioContext;
    if (AC) {
      window.AudioContext = class extends AC { constructor(...a) { super(...a); this.suspend(); } resume() { return Promise.resolve(); } };
      window.webkitAudioContext = window.AudioContext;
    }
  });
  const logs = [];
  page.on('console', (m) => { const t = m.text(); if (process.env.LOGALL || /HOMOKFUTAM|error|Error|warn|GL_/i.test(t)) logs.push(t); });
  page.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message));
  for (let k = 0; k < tries; k++) {
    try {
      await page.goto(BASE + '?' + query, { waitUntil: 'domcontentloaded', timeout });
      await page.waitForFunction(() => document.getElementById('loading')?.hidden === true && window.__homok, { timeout, polling: 250 });
      page.logs = logs;
      return page;
    } catch (e) {
      console.error('load retry', k, e.message);
    }
  }
  throw new Error('page failed to load: ' + logs.join('\n'));
}

export const SPOTS = [['grid', 0], ['dunes', 10], ['canyon', 10], ['arena', 20]];

// perf at the four spots of a race started fresh
export async function benchSpots(page, frames = 150, spots = SPOTS) {
  const out = {};
  await page.evaluate(() => window.__homok.start(1, 1, false));
  for (const [name, t] of spots) {
    if (t) await page.evaluate((t) => window.__homok.sim(t), t);
    await page.evaluate(() => new Promise((r) => setTimeout(r, 300)));
    out[name] = await page.evaluate((f) => window.__homok.perf(f), frames);
  }
  return out;
}

// freeze shader time, grain, pause: for comparable captures
export async function freeze(page, t = 100) {
  await page.evaluate((t) => {
    for (const e of document.body.children) if (e.id !== 'view') e.style.visibility = 'hidden';
    const H = window.__homok;
    const u = H.ATMO.hfTime;
    Object.defineProperty(u, 'value', { get: () => t, set: () => {}, configurable: true });
    const g = H.post?.grade?.uniforms?.get('uGrain');
    if (g) g.value = 0;
    // no speed blur or aberration (they ease out over many frames after the pause)
    for (const k of ['uBlur', 'uAberr']) { const u = H.post?.speed?.uniforms?.get(k); if (u) Object.defineProperty(u, 'value', { get: () => 0, set: () => {}, configurable: true }); }
  }, t);
}

export async function shot(page, file) {
  // a WebGPU canvas is readable only after a presented frame: step a few rAFs
  await page.evaluate(() => new Promise((r) => { let n = 0; const f = () => (++n > 16 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }));
  await page.screenshot({ path: file, type: 'png' });
  return file;
}

// tile PNG files into a grid
export function tile(files, out, cols = 2, scale = 1) {
  const imgs = files.map((f) => PNG.sync.read(fs.readFileSync(f)));
  const w = Math.floor(imgs[0].width * scale), h = Math.floor(imgs[0].height * scale);
  const rows = Math.ceil(imgs.length / cols);
  const o = new PNG({ width: w * cols, height: h * rows });
  imgs.forEach((im, k) => {
    const cx = (k % cols) * w, cy = Math.floor(k / cols) * h;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const sx = Math.min(im.width - 1, Math.floor(x / scale)), sy = Math.min(im.height - 1, Math.floor(y / scale));
      const si = (sy * im.width + sx) * 4, di = ((cy + y) * o.width + cx + x) * 4;
      o.data[di] = im.data[si]; o.data[di + 1] = im.data[si + 1]; o.data[di + 2] = im.data[si + 2]; o.data[di + 3] = 255;
    }
  });
  fs.writeFileSync(out, PNG.sync.write(o));
  return out;
}

// crop a region of a PNG (x, y, w, h in pixels), optional nearest upscale
export function crop(file, out, x, y, w, h, up = 1) {
  const im = PNG.sync.read(fs.readFileSync(file));
  const o = new PNG({ width: w * up, height: h * up });
  for (let j = 0; j < h * up; j++) for (let i = 0; i < w * up; i++) {
    const si = ((y + Math.floor(j / up)) * im.width + x + Math.floor(i / up)) * 4, di = (j * o.width + i) * 4;
    o.data[di] = im.data[si]; o.data[di + 1] = im.data[si + 1]; o.data[di + 2] = im.data[si + 2]; o.data[di + 3] = 255;
  }
  fs.writeFileSync(out, PNG.sync.write(o));
  return out;
}

export const fmt = (r) => Object.entries(r).map(([k, v]) => `${k}: ${v.fps} fps, js ${v.jsMs} ms, ${v.calls} draws, ${(v.tris / 1e6).toFixed(2)}M tris`).join('\n');
