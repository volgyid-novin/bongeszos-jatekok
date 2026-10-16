// Procedural canvas textures. Every map material (base kind x palette colours x top/side variant) gets an albedo canvas, an
// optional emissive canvas (glowing trims) and a normal map made from a height canvas. One tile = 2 m of world.
//
//   const surf = new Surfaces(quality, maxAnisotropy);
//   surf.material(matDef, top)  MeshStandardMaterial for a map material { base, color, trim, emissive }; top = walkable variant
//   surf.deco(kind)             neutral materials for decoration meshes tinted by vertex colour: 'metal' | 'concrete' | 'rock' | 'crate'
//   surf.glow                   unlit vertex-colour material (HDR colours bloom); surf.halo additive vertex-colour material
//   surf.dispose()
// And canvas art helpers: glyphTexture, signTexture, labelTexture, checkerTexture, softTexture, screenTexture, ensureFonts.
import * as THREE from 'three';
import { mulberry32 } from '../sim/math.js';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ---------------------------------------------------------------- colour helpers
export const rgbOf = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
const css = (c, a = 1) => `rgba(${clamp(c[0], 0, 255) | 0},${clamp(c[1], 0, 255) | 0},${clamp(c[2], 0, 255) | 0},${a})`;
const gray = (v) => { const g = clamp(v * 255, 0, 255) | 0; return `rgb(${g},${g},${g})`; };
const mul = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
const mixc = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const hs = (a, b, s) => { let h = Math.imul(a * 374761393 + b * 668265263 + s * 2147483647 + 1013904223, 1274126177); h ^= h >>> 13; h = Math.imul(h, 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

function canvas2d(S, readback = false) {
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  return c.getContext('2d', readback ? { willReadFrequently: true } : undefined);
}

// ---------------------------------------------------------------- periodic noise fields (shared, computed once per size)
const FIELDS = new Map();
function noiseField(S, cx, cy, oct, seed) {
  const out = new Float32Array(S * S);
  let amp = 1, tot = 0, ccx = cx, ccy = cy;
  for (let o = 0; o < oct; o++) {
    const rng = mulberry32(seed + o * 101);
    const lat = new Float32Array(ccx * ccy);
    for (let i = 0; i < lat.length; i++) lat[i] = rng();
    const sx = ccx / S, sy = ccy / S;
    for (let y = 0; y < S; y++) {
      const fy = y * sy, iy = fy | 0, ty = fy - iy, wy = ty * ty * (3 - 2 * ty);
      const r0 = (iy % ccy) * ccx, r1 = ((iy + 1) % ccy) * ccx;
      for (let x = 0; x < S; x++) {
        const fx = x * sx, ix = fx | 0, tx = fx - ix, wx = tx * tx * (3 - 2 * tx);
        const x0 = ix % ccx, x1 = (ix + 1) % ccx;
        const a = lat[r0 + x0], b = lat[r0 + x1], c = lat[r1 + x0], d = lat[r1 + x1];
        out[y * S + x] += amp * (a + (b - a) * wx + (c - a) * wy + (a - b - c + d) * wx * wy);
      }
    }
    tot += amp; amp *= 0.5; ccx *= 2; ccy *= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] /= tot;
  return out;
}
function field(S, name) {
  const key = S + name;
  let f = FIELDS.get(key);
  if (f) return f;
  switch (name) {
    case 'fine': f = noiseField(S, 48, 48, 3, 11); break;
    case 'mid': f = noiseField(S, 6, 6, 4, 23); break;
    case 'vstreak': f = noiseField(S, 48, 3, 2, 37); break;
    case 'hstreak': f = noiseField(S, 3, 140, 2, 41); break;
    default: throw new Error('field ' + name);
  }
  FIELDS.set(key, f);
  return f;
}

// ---------------------------------------------------------------- drawing surface: albedo + height (+ emissive)
class Surf {
  constructor(S, emissive) {
    this.S = S; this.k = S / 256;
    this.a = canvas2d(S, true); this.h = canvas2d(S, true); this.e = emissive ? canvas2d(S, true) : null;
  }
  fill(ac, hv, ec) { this.rect(0, 0, this.S, this.S, ac, hv, ec); }
  rect(x, y, w, h, ac, hv, ec) {
    if (ac) { this.a.fillStyle = css(ac); this.a.fillRect(x, y, w, h); }
    if (hv != null) { this.h.fillStyle = gray(hv); this.h.fillRect(x, y, w, h); }
    if (ec && this.e) { this.e.fillStyle = css(ec); this.e.fillRect(x, y, w, h); }
  }
  circ(x, y, r, ac, hv, ec) {
    const dr = (ctx, st) => { ctx.fillStyle = st; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill(); };
    if (ac) dr(this.a, css(ac));
    if (hv != null) dr(this.h, gray(hv));
    if (ec && this.e) dr(this.e, css(ec));
  }
  poly(pts, ac, hv, ec) {
    const dr = (ctx, st) => { ctx.fillStyle = st; ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath(); ctx.fill(); };
    if (ac) dr(this.a, css(ac));
    if (hv != null) dr(this.h, gray(hv));
    if (ec && this.e) dr(this.e, css(ec));
  }
  line(x0, y0, x1, y1, lw, ac, hv, ec) {
    const dr = (ctx, st) => { ctx.strokeStyle = st; ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); };
    if (ac) dr(this.a, css(ac));
    if (hv != null) dr(this.h, gray(hv));
    if (ec && this.e) dr(this.e, css(ec));
  }
  // multiply the albedo with grain, blotches, dirt and streaks (one pixel pass)
  weather(o = {}) {
    const S = this.S, id = this.a.getImageData(0, 0, S, S), d = id.data;
    const F = field(S, 'fine'), M = field(S, 'mid'), V = field(S, 'vstreak'), H = field(S, 'hstreak');
    const ox = (o.ox ?? 0) | 0, oy = (o.oy ?? 0) | 0, m = S - 1;
    const grain = o.grain ?? 0.06, blotch = o.blotch ?? 0.08, dirt = o.dirt ?? 0, sv = o.streakV ?? 0, sh = o.streakH ?? 0;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = (y * S + x) * 4, j = ((y + oy) & m) * S + ((x + ox) & m);
        let k = 1 + (F[j] - 0.5) * grain * 3 + (M[j] - 0.5) * blotch * 3 + (V[j] - 0.5) * sv * 3 + (H[j] - 0.5) * sh * 3;
        if (dirt) { const dd = smooth(0.45, 0.85, M[(j + 977) & (S * S - 1)]); k *= 1 - dirt * dd; }
        d[i] *= k; d[i + 1] *= k * (dirt ? 0.985 : 1); d[i + 2] *= k * (dirt ? 0.95 : 1);
      }
    }
    this.a.putImageData(id, 0, 0);
  }
  // normal map from the height canvas (wraps around, so tiles stay seamless)
  normalMap(strength) {
    const S = this.S, hd = this.h.getImageData(0, 0, S, S).data;
    const out = canvas2d(S), id = out.createImageData(S, S), d = id.data, m = S - 1;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const l = hd[(y * S + ((x - 1) & m)) * 4], r = hd[(y * S + ((x + 1) & m)) * 4];
        const u = hd[((((y - 1) & m)) * S + x) * 4], dn = hd[(((y + 1) & m) * S + x) * 4];
        let nx = -(r - l) / 255 * strength, ny = (dn - u) / 255 * strength, nz = 1;
        const il = 1 / Math.hypot(nx, ny, nz);
        nx *= il; ny *= il; nz *= il;
        const i = (y * S + x) * 4;
        d[i] = (nx * 0.5 + 0.5) * 255; d[i + 1] = (ny * 0.5 + 0.5) * 255; d[i + 2] = (nz * 0.5 + 0.5) * 255; d[i + 3] = 255;
      }
    }
    out.putImageData(id, 0, 0);
    return out.canvas;
  }
}

// ---------------------------------------------------------------- generators: g = Surf, p = { base, trim, glow, gk, seed }, top = walkable variant
function rivet(g, x, y, c) {
  const k = g.k;
  g.circ(x, y, 3.6 * k, mul(c, 0.55), 0.3);
  g.circ(x, y, 2.8 * k, mul(c, 1.15), 1);
  g.circ(x - 0.8 * k, y - 0.8 * k, 1.1 * k, mul(c, 1.6), 1);
}

function genPanel(g, p, top) {
  const { S, k } = g, B = p.base, T = p.trim, G = mul(p.glow, p.gk);
  g.fill(mul(B, 0.3), 0.08, [0, 0, 0]);
  const n = 2, ps = S / n, sm = 3 * k;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = i * ps, y = j * ps, c = mul(B, 0.95 + hs(i, j, p.seed) * 0.1);
      const x0 = x + sm, y0 = y + sm, w = ps - 2 * sm;
      g.rect(x0, y0, w, w, c, 0.65);
      g.rect(x0, y0, w, 2 * k, mul(c, 1.3), 0.78);
      g.rect(x0, y0, 2 * k, w, mul(c, 1.2), 0.74);
      g.rect(x0, y0 + w - 2 * k, w, 2 * k, mul(c, 0.68), 0.5);
      g.rect(x0 + w - 2 * k, y0, 2 * k, w, mul(c, 0.76), 0.5);
      if (top) {
        // walkable tile: a trim outline and a grip pattern
        const ins = 11 * k, lw = 2.8 * k, tc = mixc(c, T, 0.85);
        g.rect(x + ins, y + ins, ps - 2 * ins, lw, tc, 0.55, G);
        g.rect(x + ins, y + ps - ins - lw, ps - 2 * ins, lw, tc, 0.55, G);
        g.rect(x + ins, y + ins, lw, ps - 2 * ins, tc, 0.55, G);
        g.rect(x + ps - ins - lw, y + ins, lw, ps - 2 * ins, tc, 0.55, G);
        const a = ins + 12 * k, st = 13 * k;
        for (let yy = y + a; yy < y + ps - a + 1; yy += st) for (let xx = x + a; xx < x + ps - a + 1; xx += st) g.circ(xx, yy, 1.9 * k, mul(c, 0.82), 0.95);
      } else {
        const q = (i + j * 2 + p.seed) % 4, ci = 14 * k;
        if (q === 0 || q === 3) for (const [rx, ry] of [[ci, ci], [ps - ci, ci], [ci, ps - ci], [ps - ci, ps - ci]]) rivet(g, x + rx, y + ry, c);
        if (q === 1) {   // vents
          for (let s = 0; s < 6; s++) g.rect(x + ps * 0.22, y + ps * 0.26 + s * ps * 0.085, ps * 0.56, ps * 0.04, mul(B, 0.18), 0.05, [0, 0, 0]);
        }
        if (q === 2 || q === 3) {   // inset panel with a trim line
          const ii = ps * 0.2;
          g.rect(x + ii, y + ii, ps - 2 * ii, ps - 2 * ii, mul(c, 0.88), 0.45);
          g.rect(x + ii, y + ii, ps - 2 * ii, 2.2 * k, mixc(c, T, 0.8), 0.6, G);
          g.rect(x + ii + 2 * k, y + ii + 3 * k, ps - 2 * ii - 4 * k, 1.6 * k, mul(c, 1.25), 0.7);
        }
      }
    }
  }
  g.weather({ grain: 0.05, blotch: 0.07, dirt: top ? 0.08 : 0.14, streakV: top ? 0 : 0.1, ox: p.seed * 53, oy: p.seed * 31 });
}

function genGrate(g, p, top) {
  const { S, k } = g, B = p.base, G = mul(p.glow, 0.5 * (p.gk + 0.2));
  if (top) {
    g.fill([8, 10, 14], 0, G);   // the holes: dark, with a little light from below
    const st = 16 * k, bw = 5.2 * k;
    for (let x = 0; x < S; x += st) {
      g.rect(x, 0, bw, S, mul(B, 0.85), 0.95, [0, 0, 0]);
      g.rect(x, 0, 1.4 * k, S, mul(B, 1.3), 1, [0, 0, 0]);
    }
    for (let y = 0; y < S; y += st) {
      g.rect(0, y, S, bw, mul(B, 0.8), 0.9, [0, 0, 0]);
      g.rect(0, y, S, 1.4 * k, mul(B, 1.25), 0.95, [0, 0, 0]);
    }
    for (const q of [0, S / 2]) {
      g.rect(q, 0, 8 * k, S, mul(B, 0.6), 1, [0, 0, 0]);
      g.rect(0, q, S, 8 * k, mul(B, 0.6), 1, [0, 0, 0]);
    }
    g.weather({ grain: 0.04, blotch: 0.06, dirt: 0.1, ox: p.seed * 17 });
  } else {
    g.fill(mul(B, 0.4), 0.1, [0, 0, 0]);
    const ps = S / 2, sm = 3 * k;
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
      const x = i * ps + sm, y = j * ps + sm, w = ps - 2 * sm;
      g.rect(x, y, w, w, mul(B, 0.62), 0.6);
      for (let s = 0; s < 9; s++) g.rect(x + 8 * k + s * 12.6 * k, y + 12 * k, 5 * k, w - 24 * k, [6, 8, 11], 0.05, G);
      g.rect(x, y, w, 2 * k, mul(B, 1.0), 0.8);
    }
    g.weather({ grain: 0.05, blotch: 0.06, dirt: 0.12, streakV: 0.1, ox: p.seed * 17 });
  }
}

function genConcrete(g, p, top) {
  const { S, k } = g, B = p.base;
  g.fill(mul(B, top ? 0.95 : 0.9), 0.5);
  const H = S / 2;
  for (const q of [0, H]) {
    g.rect(q, 0, 2 * k, S, mul(B, 0.55), 0.15);
    g.rect(0, q, S, 2 * k, mul(B, 0.55), 0.15);
    g.rect(q + 2 * k, 0, 1.2 * k, S, mul(B, 1.15), 0.6);
    g.rect(0, q + 2 * k, S, 1.2 * k, mul(B, 1.15), 0.6);
  }
  if (!top) {
    for (const [x, y] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) { g.circ(x * S, y * S, 4.2 * k, mul(B, 0.4), 0.1); g.circ(x * S, y * S, 2.2 * k, mul(B, 0.25), 0); }
  } else {
    const rng = mulberry32(p.seed + 5);
    for (let c = 0; c < 3; c++) {   // hairline cracks
      let x = rng() * S, y = rng() * S, a = rng() * TAU;
      for (let s = 0; s < 14; s++) { const nx = x + Math.cos(a) * 9 * k, ny = y + Math.sin(a) * 9 * k; g.line(x, y, nx, ny, 1.2 * k, mul(B, 0.42), 0.1); x = nx; y = ny; a += (rng() - 0.5) * 1.1; }
    }
    for (let s = 0; s < 70; s++) g.circ(rng() * S, rng() * S, (0.8 + rng() * 1.6) * k, mul(B, 0.7 + rng() * 0.5), 0.7);
  }
  g.weather({ grain: 0.1, blotch: 0.16, dirt: 0.16, streakV: top ? 0.02 : 0.14, ox: p.seed * 41, oy: p.seed * 7 });
}

function genMetal(g, p, top) {
  const { S, k } = g, B = p.base, T = p.trim, G = mul(p.glow, p.gk);
  g.fill(mul(B, 0.95), 0.5);
  if (top) {
    // diamond tread plate
    const n = 16, c = S / n;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const cx = (i + 0.5) * c, cy = (j + 0.5) * c, dir = (i + j) % 2 ? 1 : -1;
      for (const ctx of [g.a, g.h]) {
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(dir * Math.PI / 4);
        ctx.fillStyle = ctx === g.a ? css(mul(B, 1.22)) : gray(1);
        ctx.beginPath(); ctx.ellipse(0, 0, c * 0.42, c * 0.12, 0, 0, TAU); ctx.fill();
        ctx.restore();
      }
    }
    for (const q of [0, S / 2]) { g.rect(q, 0, 2.5 * k, S, mul(B, 0.45), 0.1); g.rect(0, q, S, 2.5 * k, mul(B, 0.45), 0.1); }
    g.rect(0, 0, S, 2.5 * k, mixc(B, T, 0.7), 0.3, G);
    g.weather({ grain: 0.06, blotch: 0.08, dirt: 0.14, ox: p.seed * 13 });
  } else {
    for (let b = 0; b < 4; b++) {
      const y = b * S / 4;
      g.rect(0, y, S, S / 4, mul(B, 0.92 + hs(b, 1, p.seed) * 0.16), 0.6);
      g.rect(0, y, S, 3 * k, mul(B, 0.4), 0.1);
      g.rect(0, y + 3 * k, S, 1.4 * k, mul(B, 1.3), 0.8);
      for (let i = 0; i < 8; i++) rivet(g, (i + 0.5) * S / 8, y + 10 * k, B);
    }
    g.rect(0, S / 2 + 6 * k, S, 3 * k, mixc(B, T, 0.8), 0.7, G);
    g.rect(S / 2, 0, 2 * k, S, mul(B, 0.45), 0.2);
    g.weather({ grain: 0.05, blotch: 0.06, dirt: 0.1, streakH: 0.35, ox: p.seed * 13 });
  }
}

function genRust(g, p, top) {
  const { S, k } = g, B = p.base, S2 = S / 2;
  const rust = [150, 72, 32];
  g.fill(mul(B, 0.9), 0.5);
  for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
    const x = i * S2, y = j * S2, c = mul(B, 0.9 + hs(i, j, p.seed) * 0.2);
    g.rect(x + 2 * k, y + 2 * k, S2 - 4 * k, S2 - 4 * k, c, 0.6);
    g.rect(x, y, S2, 2.5 * k, mul(B, 0.35), 0.1);
    g.rect(x, y, 2.5 * k, S2, mul(B, 0.35), 0.1);
    for (const [rx, ry] of [[12, 12], [S2 - 12, 12], [12, S2 - 12], [S2 - 12, S2 - 12]]) rivet(g, x + rx * k, y + ry * k, c);
  }
  // rust: blotches eating the metal, pitting
  const id = g.a.getImageData(0, 0, S, S), d = id.data;
  const M = field(S, 'mid'), F = field(S, 'fine'), V = field(S, 'vstreak'), m = S - 1, hid = g.h.getImageData(0, 0, S, S), hd = hid.data;
  const amount = top ? 1.1 : 0.9, ox = p.seed * 29, oy = p.seed * 47;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4, j = ((y + oy) & m) * S + ((x + ox) & m);
      const n = M[j] * 0.7 + V[j] * 0.3, r = smooth(0.42, 0.62, n * amount) * (0.6 + F[j] * 0.8);
      const tone = 0.55 + F[j] * 0.8;
      d[i] = d[i] * (1 - r) + rust[0] * tone * r;
      d[i + 1] = d[i + 1] * (1 - r) + rust[1] * tone * r;
      d[i + 2] = d[i + 2] * (1 - r) + rust[2] * tone * r;
      const pit = smooth(0.7, 0.9, F[j]) * r;
      const sh = 1 - pit * 0.55;
      d[i] *= sh; d[i + 1] *= sh; d[i + 2] *= sh;
      hd[i] = hd[i + 1] = hd[i + 2] = clamp(hd[i] * (1 - 0.35 * r) - pit * 90 + (F[j] - 0.5) * 30 * r, 0, 255);
    }
  }
  g.a.putImageData(id, 0, 0); g.h.putImageData(hid, 0, 0);
  g.weather({ grain: 0.05, blotch: 0.05, dirt: 0.1, streakV: 0.1, ox: p.seed * 9 });
}

function genRock(g, p, top) {
  const S = g.S, B = p.base, F = field(S, 'fine'), M = field(S, 'mid'), m = S - 1;
  const ad = g.a.getImageData(0, 0, S, S), hd = g.h.getImageData(0, 0, S, S), a = ad.data, h = hd.data;
  const sand = [205, 190, 160], ox = p.seed * 19, oy = p.seed * 7;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4, j = ((y + oy) & m) * S + ((x + ox) & m), j2 = ((y + 211) & m) * S + ((x + 97) & m);
      const n = M[j], r = 1 - Math.abs(2 * F[j2] - 1), f = F[j];
      const strata = 0.5 + 0.5 * Math.sin((y / S) * TAU * 5 + n * 7);
      let lum = 0.58 + 0.62 * n + 0.3 * (f - 0.5) + (top ? 0.06 : 0.2 * (strata - 0.5));
      const crack = smooth(0.94, 0.99, r);
      lum *= 1 - crack * 0.45;
      let c = B;
      if (top) c = mixc(B, mul(sand, 0.55), 0.35);
      a[i] = c[0] * lum; a[i + 1] = c[1] * lum; a[i + 2] = c[2] * lum; a[i + 3] = 255;
      const hv = n * 0.5 + (1 - crack) * 0.3 + f * 0.2;
      h[i] = h[i + 1] = h[i + 2] = hv * 255; h[i + 3] = 255;
    }
  }
  g.a.putImageData(ad, 0, 0); g.h.putImageData(hd, 0, 0);
}

function genCrystal(g, p) {
  const S = g.S, N = 7, cell = S / N, rng = mulberry32(p.seed * 7 + 3), B = p.base, GL = p.glow;
  const pts = [], shade = [];
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { pts.push([(i + 0.15 + rng() * 0.7) * cell, (j + 0.15 + rng() * 0.7) * cell]); shade.push(0.55 + rng() * 0.8); }
  const ad = g.a.getImageData(0, 0, S, S), hd = g.h.getImageData(0, 0, S, S), ed = g.e.getImageData(0, 0, S, S);
  const a = ad.data, h = hd.data, e = ed.data;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const ci = Math.floor(x / cell), cj = Math.floor(y / cell);
      let d1 = 1e9, d2 = 1e9, w1 = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = (ci + di + N) % N, jj = (cj + dj + N) % N, pp = pts[jj * N + ii];
        const px = pp[0] + (ci + di - ii) * cell, py = pp[1] + (cj + dj - jj) * cell;
        const d = Math.hypot(x - px, y - py);
        if (d < d1) { d2 = d1; d1 = d; w1 = jj * N + ii; } else if (d < d2) d2 = d;
      }
      const edge = smooth(0, cell * 0.09, d2 - d1), s = shade[w1], inner = 1 - d1 / (cell * 0.8);
      const i = (y * S + x) * 4, lum = s * (0.75 + 0.35 * inner);
      const glint = 1 - edge;
      a[i] = clamp(B[0] * lum + glint * 130, 0, 255); a[i + 1] = clamp(B[1] * lum + glint * 130, 0, 255); a[i + 2] = clamp(B[2] * lum + glint * 130, 0, 255); a[i + 3] = 255;
      const ev = 0.25 + s * 0.45 + glint * 0.5;
      e[i] = clamp(GL[0] * ev, 0, 255); e[i + 1] = clamp(GL[1] * ev, 0, 255); e[i + 2] = clamp(GL[2] * ev, 0, 255); e[i + 3] = 255;
      h[i] = h[i + 1] = h[i + 2] = (edge * 0.6 + s * 0.3 + inner * 0.2) * 255; h[i + 3] = 255;
    }
  }
  g.a.putImageData(ad, 0, 0); g.h.putImageData(hd, 0, 0); g.e.putImageData(ed, 0, 0);
}

function genNeon(g, p, top) {
  const { S, k } = g, C = p.base, G = p.glowRaw;
  g.fill(mul(C, 0.35), 0.5, mul(G, 0.7));
  const ps = S / 2;
  for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
    const v = 0.9 + hs(i, j, p.seed) * 0.15;
    g.rect(i * ps + 3 * k, j * ps + 3 * k, ps - 6 * k, ps - 6 * k, mul(C, 0.55), 0.6, mul(G, v));
    g.rect(i * ps + 3 * k, j * ps + ps / 2 - 1.5 * k, ps - 6 * k, 3 * k, mul(mixc(C, [255, 255, 255], 0.5), 0.9), 0.8, mul(mixc(G, [255, 255, 255], 0.35), 1));
  }
  g.weather({ grain: 0.04, blotch: 0.05, ox: p.seed * 5 });
}

function genGlass(g, p) {
  const { S, k } = g, C = p.base;
  g.a.clearRect(0, 0, S, S);
  g.a.fillStyle = css(mixc(C, [120, 200, 255], 0.5), 0.2); g.a.fillRect(0, 0, S, S);
  const fr = 5 * k;
  g.a.fillStyle = css(mixc(C, [220, 240, 255], 0.6), 0.85);
  g.a.fillRect(0, 0, S, fr); g.a.fillRect(0, S - fr, S, fr); g.a.fillRect(0, 0, fr, S); g.a.fillRect(S - fr, 0, fr, S);
  g.a.fillRect(S / 2 - fr / 2, 0, fr, S); g.a.fillRect(0, S / 2 - fr / 2, S, fr);
  g.a.strokeStyle = 'rgba(255,255,255,0.22)'; g.a.lineWidth = 7 * k;
  for (const o of [0.16, 0.34]) { g.a.beginPath(); g.a.moveTo(S * o, S * 0.06); g.a.lineTo(S * (o - 0.1), S * 0.45); g.a.stroke(); g.a.beginPath(); g.a.moveTo(S * (o + 0.5), S * 0.06); g.a.lineTo(S * (o + 0.4), S * 0.45); g.a.stroke(); }
  g.h.fillStyle = gray(0.5); g.h.fillRect(0, 0, S, S);
  g.h.fillStyle = gray(0.8); g.h.fillRect(0, 0, S, fr); g.h.fillRect(0, S - fr, S, fr); g.h.fillRect(0, 0, fr, S); g.h.fillRect(S - fr, 0, fr, S);
}

function genHazard(g, p, top) {
  const { S, k } = g, Y = p.base, D = p.trim;
  g.fill(D, 0.2);
  const P = S / 4;
  for (let q = 0; q <= S * 2; q += P) g.poly([[q, 0], [q + P / 2, 0], [q + P / 2 - S, S], [q - S, S]], Y, 0.55);
  g.rect(0, 0, S, 5 * k, mul(D, 0.8), 0.9);
  g.rect(0, S - 5 * k, S, 5 * k, mul(D, 0.8), 0.9);
  const rng = mulberry32(p.seed + 99);
  for (let i = 0; i < (top ? 60 : 30); i++) {
    const x = rng() * S, y = rng() * S, r = (1 + rng() * 3) * k;
    g.circ(x, y, r, rng() < 0.6 ? mul(D, 1.3) : mul(Y, 0.6), 0.3);
  }
  g.weather({ grain: 0.08, blotch: 0.08, dirt: top ? 0.22 : 0.14, streakV: 0.06, ox: p.seed * 3 });
}

function genStripe(g, p, top) {
  const { S, k } = g, B = p.base, G = p.glowRaw, T = p.trim;
  const dark = mul(B, top ? 0.8 : 0.55);
  g.fill(mul(dark, 0.4), 0.1, [0, 0, 0]);
  const ps = S / 2;
  for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
    const x = i * ps + 3 * k, y = j * ps + 3 * k, w = ps - 6 * k;
    g.rect(x, y, w, w, mul(dark, 0.95 + hs(i, j, p.seed) * 0.1), 0.6);
    g.rect(x, y, w, 2 * k, mul(dark, 1.4), 0.8);
  }
  // the bright vertical bars: the visual promise "wall dodge here"
  for (const bx of [S / 8, S / 8 + S / 2]) {
    const w = S / 8;
    g.rect(bx - w / 2 - 3 * k, 0, w + 6 * k, S, mul(dark, 0.35), 0.35, [0, 0, 0]);
    g.rect(bx - w / 2, 0, w, S, mixc(T, [255, 255, 255], 0.15), 0.7, mul(G, top ? 0.25 : 1));
    g.rect(bx - w / 2, 0, 3 * k, S, mul(T, 0.7), 0.8, mul(G, top ? 0.2 : 0.7));
    for (let c = 0; c < 4; c++) {   // chevrons pointing up
      const cy = c * S / 4 + S / 8;
      g.poly([[bx - w / 2, cy + 10 * k], [bx, cy - 6 * k], [bx + w / 2, cy + 10 * k], [bx + w / 2, cy + 16 * k], [bx, cy], [bx - w / 2, cy + 16 * k]], mul(dark, 0.4), 0.9, [0, 0, 0]);
    }
  }
  g.weather({ grain: 0.05, blotch: 0.06, dirt: 0.1, streakV: 0.08, ox: p.seed * 11 });
}

function genCrate(g, p) {
  const { S, k } = g, B = p.base;
  g.fill(mul(B, 0.75), 0.4);
  const fw = 20 * k;
  g.rect(0, 0, S, S, mul(B, 0.85), 0.5);
  g.rect(fw, fw, S - 2 * fw, S - 2 * fw, mul(B, 1.05), 0.45);
  g.line(fw, fw, S - fw, S - fw, 12 * k, mul(B, 0.7), 0.8);
  g.line(S - fw, fw, fw, S - fw, 12 * k, mul(B, 0.7), 0.8);
  g.line(fw, fw, S - fw, S - fw, 3 * k, mul(B, 1.3), 0.95);
  g.line(S - fw, fw, fw, S - fw, 3 * k, mul(B, 1.3), 0.95);
  for (const [x, y] of [[fw / 2, fw / 2], [S - fw / 2, fw / 2], [fw / 2, S - fw / 2], [S - fw / 2, S - fw / 2]]) rivet(g, x, y, B);
  g.rect(S / 2 - 30 * k, S / 2 - 12 * k, 60 * k, 24 * k, mul(B, 0.6), 0.7);
  g.rect(S / 2 - 26 * k, S / 2 - 8 * k, 52 * k, 4 * k, mul(B, 1.4), 0.8);
  g.rect(S / 2 - 26 * k, S / 2 + 2 * k, 36 * k, 4 * k, mul(B, 1.4), 0.8);
  g.weather({ grain: 0.08, blotch: 0.1, dirt: 0.18, streakV: 0.12, ox: p.seed * 3 });
}

const GENS = {
  panel: { gen: genPanel, rough: [0.66, 0.55], metal: [0.3, 0.4], em: true, emK: 0.9, ns: [1.6, 2.4] },
  grate: { gen: genGrate, rough: [0.5, 0.5], metal: [0.65, 0.7], em: true, emK: 1, ns: [2.2, 3] },
  concrete: { gen: genConcrete, rough: [0.95, 0.92], metal: [0, 0], em: false, ns: [2, 2.4] },
  metal: { gen: genMetal, rough: [0.42, 0.36], metal: [0.6, 0.7], em: true, emK: 0.9, ns: [2, 3.2] },
  rust: { gen: genRust, rough: [0.88, 0.9], metal: [0.25, 0.25], em: false, ns: [2.4, 3] },
  rock: { gen: genRock, rough: [0.96, 0.96], metal: [0, 0], em: false, ns: [3.4, 3.4] },
  crystal: { gen: genCrystal, rough: [0.2, 0.2], metal: [0.15, 0.15], em: true, emK: 0.8, ns: [2.5, 2.5] },
  neon: { gen: genNeon, rough: [0.5, 0.5], metal: [0, 0], em: true, emK: 1.9, ns: [1, 1] },
  glass: { gen: genGlass, rough: [0.1, 0.1], metal: [0, 0], em: false, ns: [0.6, 0.6], glass: true },
  hazard: { gen: genHazard, rough: [0.72, 0.74], metal: [0.12, 0.12], em: false, ns: [1.6, 1.8] },
  stripe: { gen: genStripe, rough: [0.55, 0.6], metal: [0.3, 0.3], em: true, emK: 1.3, ns: [1.8, 1.8] },
  crate: { gen: genCrate, rough: [0.8, 0.8], metal: [0.15, 0.15], em: false, ns: [2, 2] },
};

// ---------------------------------------------------------------- surfaces (materials per map)
export class Surfaces {
  constructor(quality, maxAniso = 4) {
    this.quality = quality;
    this.S = quality === 'alacsony' ? 256 : 512;
    this.aniso = quality === 'alacsony' ? 2 : quality === 'kozepes' ? Math.min(8, maxAniso) : Math.min(16, maxAniso);
    this.normals = quality !== 'alacsony';
    this.mats = new Map();
    this.textures = [];
    this.glow = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true });
    this.halo = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide });   // normal blending: additive glows vanish on the bright maps
    this.halo.userData.rgba = true;                 // 4 colour components: the vertex alpha fades the halos
    this.glow.userData.noShadow = true; this.halo.userData.noShadow = true;
    this.mats.set('~glow', this.glow); this.mats.set('~halo', this.halo);
  }

  tex(canvas, srgb) {
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = this.aniso;
    t.needsUpdate = true;
    this.textures.push(t);
    return t;
  }

  // def = { base, color, trim, emissive }; top = the walkable variant
  material(def, top) {
    const key = `${def.base}|${def.color}|${def.trim}|${def.emissive}|${top ? 1 : 0}`;
    let m = this.mats.get(key);
    if (m) return m;
    m = this.build(def.base, def.color, def.trim, def.emissive, !!top, hashKey(key));
    this.mats.set(key, m);
    return m;
  }

  // neutral decoration materials (the colour comes from vertex colours)
  deco(kind) {
    const spec = { metal: ['metal', 0xcfd6dc, 0xffb060, 0], concrete: ['concrete', 0xd8dcde, 0xffb060, 0], rock: ['rock', 0xb4aa9c, 0, 0], crate: ['crate', 0xc4c8cc, 0, 0] }[kind];
    const key = '~deco:' + kind;
    let m = this.mats.get(key);
    if (!m) { m = this.build(spec[0], spec[1], spec[2], spec[3], kind === 'rock' ? false : true, hashKey(key)); this.mats.set(key, m); }
    return m;
  }

  build(base, color, trim, emissive, top, seed) {
    const spec = GENS[base] || GENS.panel;
    const S = this.S, g = new Surf(S, spec.em);
    const B = rgbOf(color), T = rgbOf(trim || color), glowRaw = rgbOf(emissive || (base === 'neon' ? color : trim || color));
    const p = { base: B, trim: T, glow: glowRaw, glowRaw, gk: emissive ? 1 : 0.4, seed: seed % 997 };
    spec.gen(g, p, top);
    const v = top ? 0 : 1;
    // without an environment map (alacsony) metals would turn black: they get less metalness there
    const metal = this.quality === 'alacsony' ? spec.metal[v] * 0.3 : spec.metal[v];
    const o = { color: 0xffffff, vertexColors: true, roughness: spec.rough[v], metalness: metal, map: this.tex(g.a.canvas, true) };
    if (this.normals) { o.normalMap = this.tex(g.normalMap(spec.ns[v]), false); o.normalScale = new THREE.Vector2(1, 1); }
    if (g.e && spec.em) { o.emissiveMap = this.tex(g.e.canvas, true); o.emissive = 0xffffff; o.emissiveIntensity = spec.emK; }
    if (spec.glass) { o.transparent = true; o.opacity = 0.62; o.depthWrite = false; o.side = THREE.DoubleSide; o.envMapIntensity = 2; }
    return new THREE.MeshStandardMaterial(o);
  }

  dispose() {
    for (const t of this.textures) t.dispose();
    for (const m of this.mats.values()) m.dispose();
    this.textures.length = 0; this.mats.clear();
  }
}

function hashKey(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }

// ---------------------------------------------------------------- fonts
export async function ensureFonts() {
  if (!document.fonts || !document.fonts.load) return;
  const load = Promise.all([
    document.fonts.load('40px "Russo One"', 'ÁÉÍÓÖŐÚÜŰáéíóöőúüű'),
    document.fonts.load('600 28px "Exo 2"', 'ÁÉÍÓÖŐÚÜŰáéíóöőúüű'),
    document.fonts.load('400 28px "Exo 2"', 'ÁÉÍÓÖŐÚÜŰáéíóöőúüű'),
  ]).catch(() => {});
  await Promise.race([load, new Promise((r) => setTimeout(r, 2500))]);
}
export const FONT_HEAD = '"Russo One", "Arial Black", "Segoe UI", sans-serif';
export const FONT_BODY = '"Exo 2", "Segoe UI", system-ui, sans-serif';

function ctxTexture(canvas, srgb = true, aniso = 4) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------- floor glyphs
const hexCss = (h, a = 1) => css(rgbOf(h), a);

export function glyphTexture(kind, color, aniso = 4) {
  const S = 256, ctx = canvas2d(S), c = S / 2;
  const main = hexCss(color), dark = 'rgba(8,14,20,0.72)';
  const stroke = (w, st, fn) => { ctx.lineWidth = w; ctx.strokeStyle = st; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; fn(); ctx.stroke(); };
  const both = (w, fn) => { stroke(w + 12, dark, fn); stroke(w, main, fn); };
  const chevron = (cx, cy, w, h) => () => { ctx.beginPath(); ctx.moveTo(cx - w, cy + h); ctx.lineTo(cx, cy - h); ctx.lineTo(cx + w, cy + h); };
  if (kind === 'arrow') {
    both(18, chevron(c, 150, 70, 38)); both(18, chevron(c, 88, 70, 38));
  } else if (kind === 'dj') {
    both(11, () => { ctx.beginPath(); ctx.arc(c, c, 108, 0, TAU); });
    both(16, chevron(c, 168, 54, 26)); both(16, chevron(c, 108, 54, 26)); both(16, chevron(c, 48, 54, 26));
  } else if (kind === 'shield') {
    both(11, () => { ctx.beginPath(); ctx.arc(c, c, 112, 0, TAU); });
    both(14, () => {   // a heater shield
      ctx.beginPath(); ctx.moveTo(c - 52, c - 62); ctx.lineTo(c + 52, c - 62); ctx.lineTo(c + 52, c + 8);
      ctx.quadraticCurveTo(c + 48, c + 52, c, c + 74); ctx.quadraticCurveTo(c - 48, c + 52, c - 52, c + 8); ctx.closePath();
    });
    both(12, () => { ctx.beginPath(); ctx.moveTo(c, c - 30); ctx.lineTo(c, c + 28); ctx.moveTo(c - 18, c + 10); ctx.lineTo(c, c + 30); ctx.lineTo(c + 18, c + 10); });
  } else {   // walldodge: a wall slab and a bouncing arrow
    both(11, () => { ctx.beginPath(); ctx.arc(c, c, 112, 0, TAU); });
    ctx.fillStyle = dark; ctx.fillRect(c - 78 - 8, c - 70 - 8, 28 + 16, 140 + 16);
    ctx.fillStyle = main; ctx.fillRect(c - 78, c - 70, 28, 140);
    both(15, () => { ctx.beginPath(); ctx.moveTo(c - 30, c + 56); ctx.quadraticCurveTo(c + 20, c + 20, c + 36, c - 36); });
    both(15, chevron(c + 36, c - 34, 26, 16));
  }
  return ctxTexture(ctx.canvas, true, aniso);
}

// ---------------------------------------------------------------- hologram sign
function wrapLines(ctx, text, maxW) {
  const words = String(text).split(/\s+/).filter(Boolean), lines = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines;
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

// returns { texture, aspect } (aspect = width / height)
export function signTexture(sign, palette, aniso = 4) {
  const W = 768, H = 480, ctx = canvas2d(W), cv = ctx.canvas;
  cv.width = W; cv.height = H;
  const glow = rgbOf(palette.glow), acc = rgbOf(palette.accent), trim = rgbOf(palette.trim);
  // panel
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, 'rgba(6,20,30,0.86)'); grad.addColorStop(1, 'rgba(4,12,20,0.8)');
  ctx.fillStyle = grad; roundRect(ctx, 6, 6, W - 12, H - 12, 22); ctx.fill();
  ctx.strokeStyle = css(glow, 0.9); ctx.lineWidth = 3; roundRect(ctx, 6, 6, W - 12, H - 12, 22); ctx.stroke();
  // corner brackets in the trim colour
  ctx.strokeStyle = css(trim, 1); ctx.lineWidth = 7; ctx.lineCap = 'round';
  for (const [x, y, sx, sy] of [[16, 16, 1, 1], [W - 16, 16, -1, 1], [16, H - 16, 1, -1], [W - 16, H - 16, -1, -1]]) {
    ctx.beginPath(); ctx.moveTo(x, y + sy * 44); ctx.lineTo(x, y); ctx.lineTo(x + sx * 44, y); ctx.stroke();
  }
  // title
  let y = 40;
  ctx.textBaseline = 'top'; ctx.textAlign = 'left';
  if (sign.title) {
    let fs = 58;
    ctx.font = `${fs}px ${FONT_HEAD}`;
    while (ctx.measureText(sign.title).width > W - 110 && fs > 28) { fs -= 2; ctx.font = `${fs}px ${FONT_HEAD}`; }
    ctx.shadowColor = css(trim, 0.9); ctx.shadowBlur = 16;
    ctx.fillStyle = css(mixc(trim, [255, 255, 255], 0.25));
    ctx.fillText(sign.title, 52, y);
    ctx.shadowBlur = 0;
    y += fs + 14;
    ctx.fillStyle = css(glow, 0.55); ctx.fillRect(52, y, W - 104, 3);
    y += 20;
  }
  // keys as key caps
  if (sign.keys) {
    const parts = String(sign.keys).split(/\s*·\s*/).filter(Boolean);
    let x = 52, row = 0;
    const kh = 50, gap = 14;
    ctx.textBaseline = 'middle';
    for (const part of parts) {
      let fs = 28;
      ctx.font = `700 ${fs}px ${FONT_BODY}`;
      while (ctx.measureText(part).width > W - 150 && fs > 18) { fs -= 1; ctx.font = `700 ${fs}px ${FONT_BODY}`; }
      const w = ctx.measureText(part).width + 36;
      if (x + w > W - 52 && x > 52) { x = 52; row++; }
      const ky = y + row * (kh + 10);
      ctx.fillStyle = 'rgba(8,30,40,0.9)'; roundRect(ctx, x, ky, w, kh, 10); ctx.fill();
      ctx.strokeStyle = css(glow, 0.95); ctx.lineWidth = 2.5; roundRect(ctx, x, ky, w, kh, 10); ctx.stroke();
      ctx.fillStyle = css(mixc(glow, [255, 255, 255], 0.6)); ctx.fillText(part, x + 18, ky + kh / 2 + 1);
      x += w + gap;
    }
    y += (row + 1) * (kh + 10) + 12;
  }
  // body
  if (sign.text) {
    ctx.textBaseline = 'top';
    let fs = 30, lines;
    const room = H - 40 - y;
    for (; fs >= 18; fs -= 1) {
      ctx.font = `400 ${fs}px ${FONT_BODY}`;
      lines = wrapLines(ctx, sign.text, W - 104);
      if (lines.length * fs * 1.28 <= room) break;
    }
    ctx.fillStyle = 'rgba(224,244,250,0.95)';
    lines.forEach((l, i) => ctx.fillText(l, 52, y + i * fs * 1.28));
  }
  // scanlines
  ctx.fillStyle = 'rgba(120,220,255,0.05)';
  for (let sy = 0; sy < H; sy += 4) ctx.fillRect(0, sy, W, 1.5);
  return { texture: ctxTexture(cv, true, aniso), aspect: W / H };
}

// a text label (markers, checkpoint names, name tags): { texture, aspect }
export function labelTexture(text, { color = 0xffffff, bg = 'rgba(6,16,24,0.62)', size = 44, font = FONT_HEAD, pad = 18, outline = true } = {}) {
  const m = canvas2d(8);
  m.font = `${size}px ${font}`;
  const tw = Math.ceil(m.measureText(text).width);
  const W = tw + pad * 2, H = size + pad * 1.2;
  const cv = document.createElement('canvas');
  cv.width = Math.max(8, W); cv.height = Math.max(8, Math.ceil(H));
  const ctx = cv.getContext('2d');
  if (bg) { ctx.fillStyle = bg; roundRect(ctx, 1, 1, cv.width - 2, cv.height - 2, cv.height / 2.6); ctx.fill(); }
  ctx.font = `${size}px ${font}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  if (outline) { ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.lineJoin = 'round'; ctx.strokeText(text, cv.width / 2, cv.height / 2 + 2); }
  ctx.fillStyle = hexCss(color);
  ctx.fillText(text, cv.width / 2, cv.height / 2 + 2);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return { texture: t, aspect: cv.width / cv.height };
}

export function checkerTexture(text = 'CÉL') {
  const W = 512, H = 128, cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d'), s = H / 4;
  for (let j = 0; j < 4; j++) for (let i = 0; i < W / s; i++) { ctx.fillStyle = (i + j) % 2 ? '#10161c' : '#f4f6f8'; ctx.fillRect(i * s, j * s, s, s); }
  ctx.fillStyle = 'rgba(10,14,18,0.78)'; ctx.fillRect(W / 2 - 110, 20, 220, H - 40);
  ctx.font = `64px ${FONT_HEAD}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffd24a'; ctx.fillText(text, W / 2, H / 2 + 4);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace; t.wrapS = THREE.RepeatWrapping;
  return t;
}

// soft round dot / gradient used by particles and glows (white, alpha falloff)
export function softTexture() {
  const S = 64, ctx = canvas2d(S), g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.35, 'rgba(255,255,255,0.55)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
  return ctxTexture(ctx.canvas, true, 1);
}
// a vertical beam falloff (alpha = 1 at the middle of the width, 0 at the edges), used by lasers
export function beamTexture() {
  const W = 64, H = 4, ctx = canvas2d(W), g = ctx.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, 'rgba(255,255,255,1)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.canvas.height = H; ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  return ctxTexture(ctx.canvas, true, 1);
}
// a jump pad top: concentric rings and chevrons
export function padTexture(color) {
  const S = 256, ctx = canvas2d(S), c = S / 2, C = rgbOf(color);
  ctx.fillStyle = css(mul(C, 0.18)); ctx.beginPath(); ctx.arc(c, c, 124, 0, TAU); ctx.fill();
  ctx.strokeStyle = css(C); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.lineWidth = 10; ctx.beginPath(); ctx.arc(c, c, 112, 0, TAU); ctx.stroke();
  ctx.lineWidth = 5; ctx.beginPath(); ctx.arc(c, c, 86, 0, TAU); ctx.stroke();
  ctx.lineWidth = 16;
  for (const dy of [-46, 6, 58]) { ctx.beginPath(); ctx.moveTo(c - 46, c + dy + 26); ctx.lineTo(c, c + dy - 12); ctx.lineTo(c + 46, c + dy + 26); ctx.stroke(); }
  return ctxTexture(ctx.canvas, true, 4);
}
// an in-world display: grid, waveform, bars, blocks in one colour (the content of b.deco('screen'))
export function screenTexture(color) {
  const W = 512, H = 256, ctx = canvas2d(W), cv = ctx.canvas;
  cv.height = H;
  const C = rgbOf(color);
  ctx.fillStyle = css(mul(C, 0.07)); ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = css(C, 0.18); ctx.lineWidth = 1;
  for (let x = 0; x <= W; x += 32) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y <= H; y += 32) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  ctx.strokeStyle = css(C, 0.95); ctx.lineWidth = 4; ctx.beginPath();
  for (let x = 0; x <= W; x += 4) { const y = H * 0.38 + Math.sin(x * 0.045) * 30 + Math.sin(x * 0.13) * 12; if (x) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
  ctx.stroke();
  const rng = mulberry32(7);
  for (let i = 0; i < 16; i++) { const h = 18 + rng() * 70; ctx.fillStyle = css(C, 0.55 + rng() * 0.4); ctx.fillRect(24 + i * 30, H - 22 - h, 20, h); }
  ctx.fillStyle = css(C, 0.9); ctx.fillRect(24, 20, 140, 12); ctx.fillRect(24, 40, 90, 8);
  ctx.strokeStyle = css(C, 0.9); ctx.lineWidth = 6; ctx.strokeRect(3, 3, W - 6, H - 6);
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  for (let y = 0; y < H; y += 4) ctx.fillRect(0, y, W, 1.5);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4;
  return t;
}
