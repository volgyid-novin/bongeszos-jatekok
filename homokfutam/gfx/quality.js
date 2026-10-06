// Graphics presets. Picked once at startup (URL ?q=, saved choice, or a guess from the device);
// changing it reloads the page because terrain detail, crowd size etc. are built at load time.
const KEY = 'homokfutam:gfx';

export const PRESETS = {
  low: {
    name: 'low', pixelRatio: 1, minPixelRatio: 0.6, post: false, msaa: 0, ao: false, bloom: false, godrays: false,
    heat: false, smaa: false, shadow: 1024, shadowBox: 90, staticShadow: 2048, terrain: 0, particles: 0.5, crowd: 0.35,
    dressing: 0.5, cloudShadows: true, flare: false, blur: false, dof: false, rivals: false, groundQ: 0,
  },
  medium: {
    name: 'medium', pixelRatio: 1.25, minPixelRatio: 0.7, post: true, msaa: 0, ao: false, bloom: true, godrays: false,
    heat: false, smaa: true, shadow: 2048, shadowBox: 110, staticShadow: 4096, terrain: 1, particles: 0.75, crowd: 0.6,
    dressing: 0.8, cloudShadows: true, flare: true, blur: true, dof: false, rivals: true, groundQ: 1,
  },
  high: {
    name: 'high', pixelRatio: 1.75, minPixelRatio: 0.8, post: true, msaa: 4, ao: true, bloom: true, godrays: true,
    heat: true, smaa: false, shadow: 2048, shadowBox: 130, staticShadow: 4096, terrain: 2, particles: 1, crowd: 1,
    dressing: 1, cloudShadows: true, flare: true, blur: true, dof: true, rivals: true, groundQ: 2,
  },
  ultra: {
    name: 'ultra', pixelRatio: 2, minPixelRatio: 1, post: true, msaa: 4, ao: true, bloom: true, godrays: true,
    heat: true, smaa: false, shadow: 4096, shadowBox: 150, staticShadow: 8192, terrain: 3, particles: 1.25, crowd: 1,
    dressing: 1, cloudShadows: true, flare: true, blur: true, dof: true, rivals: true, groundQ: 2,
  },
};
export const ORDER = ['low', 'medium', 'high', 'ultra'];

function guess() {
  const coarse = window.matchMedia?.('(pointer: coarse)').matches;
  const mem = navigator.deviceMemory || 8, cores = navigator.hardwareConcurrency || 8;
  if (coarse) return mem >= 6 && cores >= 8 ? 'medium' : 'low';
  return mem >= 8 && cores >= 8 ? 'high' : 'medium';
}

export function pickQuality() {
  let name = new URLSearchParams(location.search).get('q');
  if (!PRESETS[name]) { try { name = localStorage.getItem(KEY); } catch { name = null; } }
  if (!PRESETS[name]) name = guess();
  const q = { ...PRESETS[name], auto: !PRESETS[new URLSearchParams(location.search).get('q')] };
  // per-setting overrides for testing, e.g. ?gfx=ao:0,heat:0,shadow:1024
  for (const kv of (new URLSearchParams(location.search).get('gfx') || '').split(',')) {
    const [k, v] = kv.split(':');
    if (k in q && v !== undefined) q[k] = typeof q[k] === 'boolean' ? v === '1' || v === 'true' : +v;
  }
  return q;
}

export function saveQuality(name) {
  try { localStorage.setItem(KEY, name); } catch { /* storage blocked */ }
}

// Dynamic resolution: drops the pixel ratio when frames run long, raises it back when there is headroom.
export function createDynRes(renderer, Q, onChange) {
  const max = Math.min(window.devicePixelRatio || 1, Q.pixelRatio);
  const min = Math.min(max, Q.minPixelRatio);
  let ratio = max, avg = 16.7, cool = 2;
  renderer.setPixelRatio(ratio);
  return {
    get ratio() { return ratio; },
    tick(ms) {
      if (navigator.webdriver) return;       // automated screenshots: keep the resolution fixed
      avg += (Math.min(ms, 100) - avg) * 0.05;
      if ((cool -= ms / 1000) > 0) return;
      let next = ratio;
      if (avg > 21 && ratio > min) next = Math.max(min, ratio - 0.1);
      else if (avg < 14.5 && ratio < max) next = Math.min(max, ratio + 0.05);
      if (next !== ratio) { ratio = next; cool = 1.5; renderer.setPixelRatio(ratio); onChange?.(ratio); }
    },
  };
}
