// A small offline DSP kit for tools/gen-sounds.mjs: the PAJZSUGRÁS sounds are computed here from formulas and a seeded PRNG, with no input
// audio of any kind and no Math.random. Everything is rendered at IR = 4 x SR so that saturation and sawtooth edges do not alias, then
// low-passed with a long windowed-sinc filter and decimated to SR (24 kHz), dithered to 16 bit and written as a mono WAV.
//
//   rng(seed) -> () => [0,1)                          mulberry32
//   len(sec) zeros(n) curve(n, pts, mode) ad(n, attack, tau, at)        buffers and envelopes (IR domain, seconds)
//   osc(shape, freq, n, ref) noise(n, rand) biquad(x, type, f, q)       sources and filters (freq: number | per-sample array)
//   ring(dst, modes, at, gain, opts)                                    modal bank: the ring of one strike (sum of decaying sinusoids)
//   softClip reverb add mul scale reverse tile slice peak rms mean      mixing and shaping
//   toOutput(x, opts) -> SR domain      toPCM16(x, rand)      wavBytes(pcm)      readWav(buffer)
export const SR = 24000;
export const OVER = 4;
export const IR = SR * OVER;
const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------------------------------- random, buffers, envelopes
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const len = (sec) => Math.max(1, Math.round(sec * IR));
export const zeros = (n) => new Float64Array(n);

// a per-sample curve through [seconds, value] points; 'lin', 'exp' (geometric: for frequencies, values > 0) or 'cos' (eased)
export function curve(n, pts, mode = 'lin') {
  const y = new Float64Array(n);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const t = i / IR;
    while (k < pts.length - 2 && t >= pts[k + 1][0]) k++;
    const [t0, v0] = pts[k], [t1, v1] = pts[Math.min(k + 1, pts.length - 1)];
    let u = t1 > t0 ? (t - t0) / (t1 - t0) : 1;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    if (mode === 'cos') u = 0.5 - 0.5 * Math.cos(Math.PI * u);
    y[i] = mode === 'exp' ? v0 * Math.pow(v1 / v0, u) : v0 + (v1 - v0) * u;
  }
  return y;
}

// attack / decay envelope: silent before `at`, a raised-cosine rise over `attack` seconds, then exp(-t / tau)
export function ad(n, attack, tau, at = 0) {
  const y = new Float64Array(n), a = Math.max(attack, 1 / IR);
  for (let i = Math.max(0, Math.round(at * IR)); i < n; i++) {
    const t = i / IR - at;
    y[i] = t < a ? 0.5 - 0.5 * Math.cos(Math.PI * t / a) : Math.exp(-(t - a) / tau);
  }
  return y;
}

// ---------------------------------------------------------------------------------------------------- sources
const freqAt = (freq) => (typeof freq === 'number' ? () => freq : (i) => freq[i]);

// phase in cycles, zero at sample `ref` (so a sweep can be made to arrive at phase 0 exactly where the next sound starts)
export function phaseCurve(freq, n, ref = 0) {
  const f = freqAt(freq), ph = new Float64Array(n);
  let acc = 0, atRef = 0;
  for (let i = 0; i < n; i++) {
    if (i === ref) atRef = acc;
    ph[i] = acc;
    acc += f(i) / IR;
  }
  if (ref >= n) atRef = acc;
  for (let i = 0; i < n; i++) ph[i] -= atRef;
  return ph;
}

// polyBLEP residual: removes most of the aliasing of a hard edge
const blep = (t, dt) => {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
};

// shape: 'sine' | 'saw' | 'square' | 'tri'; the phase is zero at sample `ref`, plus `offset` cycles
export function osc(shape, freq, n, ref = 0, offset = 0) {
  const f = freqAt(freq), ph = phaseCurve(freq, n, ref), y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const q = ph[i] + offset, p = q - Math.floor(q), dt = Math.min(0.49, Math.abs(f(i)) / IR);
    if (shape === 'sine') y[i] = Math.sin(TAU * p);
    else if (shape === 'saw') y[i] = 2 * p - 1 - blep(p, dt);
    else if (shape === 'square') y[i] = (p < 0.5 ? 1 : -1) + blep(p, dt) - blep((p + 0.5) % 1, dt);
    else if (shape === 'tri') y[i] = 4 * Math.abs(p - 0.5) - 1;
    else throw new Error('unknown shape ' + shape);
  }
  return y;
}

export function noise(n, rand) {
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) y[i] = rand() * 2 - 1;
  return y;
}

// ---------------------------------------------------------------------------------------------------- filters
// RBJ biquad: 'lowpass' | 'highpass' | 'bandpass' (0 dB peak) | 'notch'. f may be an array (swept filter, coefficients every 8 samples).
export function biquad(x, type, f, q = 0.7071) {
  const n = x.length, y = new Float64Array(n), fa = typeof f === 'number' ? null : f;
  let b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0, z1 = 0, z2 = 0;
  const coef = (fc) => {
    const w = TAU * Math.min(Math.max(fc, 10), IR * 0.45) / IR, cw = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
    if (type === 'lowpass') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; }
    else if (type === 'highpass') { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; }
    else if (type === 'bandpass') { b0 = al; b1 = 0; b2 = -al; }
    else if (type === 'notch') { b0 = 1; b1 = -2 * cw; b2 = 1; }
    else throw new Error('unknown filter ' + type);
    a1 = -2 * cw / a0; a2 = (1 - al) / a0; b0 /= a0; b1 /= a0; b2 /= a0;
  };
  if (!fa) coef(f);
  for (let i = 0; i < n; i++) {
    if (fa && i % 8 === 0) coef(fa[i]);
    const v = x[i], o = b0 * v + z1;
    z1 = b1 * v - a1 * o + z2;
    z2 = b2 * v - a2 * o;
    y[i] = o;
  }
  return y;
}

// ---------------------------------------------------------------------------------------------------- mixing and shaping
export function add(dst, src, gain = 1, at = 0) {
  const o = Math.round(at * IR);
  for (let i = 0; i < src.length; i++) {
    const j = i + o;
    if (j >= 0 && j < dst.length) dst[j] += src[i] * gain;
  }
  return dst;
}
export function mul(a, b) {
  const n = Math.min(a.length, b.length), y = new Float64Array(n);
  for (let i = 0; i < n; i++) y[i] = a[i] * b[i];
  return y;
}
export function scale(x, g) {
  const y = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = x[i] * g;
  return y;
}
export const reverse = (x) => Float64Array.from(x).reverse();
export function tile(x, times) {
  const y = new Float64Array(x.length * times);
  for (let k = 0; k < times; k++) y.set(x, k * x.length);
  return y;
}
export const slice = (x, from, to) => x.slice(from, to);
export function peak(x) { let m = 0; for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i])); return m; }
export function rms(x) { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, x.length)); }
export function mean(x) { let s = 0; for (let i = 0; i < x.length; i++) s += x[i]; return s / Math.max(1, x.length); }

// tanh saturation, scaled so that an input of 1 stays 1
export function softClip(x, drive) {
  const y = new Float64Array(x.length), k = 1 / Math.tanh(drive);
  for (let i = 0; i < x.length; i++) y[i] = Math.tanh(drive * x[i]) * k;
  return y;
}

// modal bank: adds the ring of one strike at `at` seconds into dst. modes = [{ f (Hz), a (amplitude), t60 (s to -60 dB), ph (rad, default 0) }].
// wrap: the ring wraps around the end of dst (for a loop that must stay periodic).
export function ring(dst, modes, at, gain = 1, { wrap = false } = {}) {
  const n = dst.length, i0 = Math.round(at * IR);
  for (const m of modes) {
    const d = Math.exp(-6.907755 / m.t60 / IR), w = TAU * m.f / IR, ph = m.ph || 0;
    const cr = d * Math.cos(w), ci = d * Math.sin(w);
    let re = Math.cos(ph) * m.a * gain, im = Math.sin(ph) * m.a * gain;
    const floor = Math.abs(m.a * gain) * 1e-5, count = wrap ? n : n - i0;
    for (let k = 0; k < count; k++) {
      const j = wrap ? (i0 + k) % n : i0 + k;
      dst[j] += im;
      const r = re * cr - im * ci;
      im = re * ci + im * cr; re = r;
      if (re * re + im * im < floor * floor) break;
    }
  }
  return dst;
}

// Schroeder reverb: four damped parallel combs into two series all-passes. The wet signal's energy is `wetDb` relative to the dry signal's;
// the tail is cut at the length of x, so give x room for it.
export function reverb(x, { rt60 = 0.5, wetDb = -14, damp = 0.3, pre = 0.006 } = {}) {
  const n = x.length, wet = new Float64Array(n);
  const combs = [0.0297, 0.0371, 0.0411, 0.0437].map((s) => {
    const d = Math.round(s * IR);
    return { buf: new Float64Array(d), g: Math.pow(10, -3 * (d / IR) / rt60), lp: 0, idx: 0 };
  });
  const aps = [0.005, 0.0017].map((s) => ({ buf: new Float64Array(Math.round(s * IR)), idx: 0 }));
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const c of combs) {
      const o = c.buf[c.idx];
      c.lp = (1 - damp) * o + damp * c.lp;
      c.buf[c.idx] = x[i] + c.g * c.lp;
      if (++c.idx >= c.buf.length) c.idx = 0;
      s += o;
    }
    s *= 0.25;
    for (const a of aps) {
      const v = a.buf[a.idx], out = -0.5 * s + v;
      a.buf[a.idx] = s + 0.5 * v;
      if (++a.idx >= a.buf.length) a.idx = 0;
      s = out;
    }
    wet[i] = s;
  }
  let eDry = 0, eWet = 0;
  for (let i = 0; i < n; i++) { eDry += x[i] * x[i]; eWet += wet[i] * wet[i]; }
  const k = eWet > 0 ? Math.sqrt(eDry / eWet) * Math.pow(10, wetDb / 20) : 0, o = Math.round(pre * IR), y = Float64Array.from(x);
  for (let i = 0; i + o < n; i++) y[i + o] += wet[i] * k;
  return y;
}

// ---------------------------------------------------------------------------------------------------- the way out: IR -> SR -> 16 bit -> WAV
function besselI0(x) {
  let s = 1, t = 1;
  for (let k = 1; k < 40; k++) { t *= (x / (2 * k)) * (x / (2 * k)); s += t; }
  return s;
}
let firCache = null;
function decimationFilter() {
  if (firCache) return firCache;
  const taps = 321, mid = (taps - 1) / 2, fc = 10800 / IR, beta = 9, h = new Float64Array(taps), i0b = besselI0(beta);
  let sum = 0;
  for (let k = 0; k < taps; k++) {
    const m = k - mid, s = m === 0 ? 2 * fc : Math.sin(TAU * fc * m) / (Math.PI * m);
    const r = m / mid, w = besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0b;
    h[k] = s * w; sum += h[k];
  }
  for (let k = 0; k < taps; k++) h[k] /= sum;
  return (firCache = h);
}
export function decimate(x) {
  const h = decimationFilter(), mid = (h.length - 1) / 2, m = Math.floor(x.length / OVER), y = new Float64Array(m);
  for (let o = 0; o < m; o++) {
    const c = o * OVER;
    let s = 0;
    for (let k = 0; k < h.length; k++) {
      const j = c + k - mid;
      if (j >= 0 && j < x.length) s += h[k] * x[j];
    }
    y[o] = s;
  }
  return y;
}

// IR domain -> SR domain: 20 Hz high-pass (not for loops), raised-cosine fades (seconds), the anti-alias filter and decimation. With the
// high-pass on, the little DC that a short thump leaves behind it is taken out as c * (fade window), so the ends stay at zero.
export function toOutput(x, { hp = true, fadeIn = 0.003, fadeOut = 0.010 } = {}) {
  const y = hp ? biquad(x, 'highpass', 20, 0.7071) : Float64Array.from(x);
  const n = y.length, a = Math.round(fadeIn * IR), b = Math.round(fadeOut * IR), w = new Float64Array(n).fill(1);
  for (let i = 0; i < a && i < n; i++) w[i] *= 0.5 - 0.5 * Math.cos(Math.PI * i / a);
  for (let i = 0; i < b && i < n; i++) w[n - 1 - i] *= 0.5 - 0.5 * Math.cos(Math.PI * i / b);
  let sy = 0, sw = 0;
  for (let i = 0; i < n; i++) { y[i] *= w[i]; sy += y[i]; sw += w[i]; }
  if (hp) for (let i = 0; i < n; i++) y[i] -= sy / sw * w[i];
  return decimate(y);
}

// 16 bit with seeded TPDF dither (one LSB)
export function toPCM16(x, rand) {
  const out = new Int16Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const d = rand() - rand();
    out[i] = Math.max(-32767, Math.min(32767, Math.round(x[i] * 32767 + d)));
  }
  return out;
}

export function wavBytes(pcm, sr = SR) {
  const data = pcm.length * 2, b = Buffer.alloc(44 + data);
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(36 + data, 4); b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii'); b.writeUInt32LE(data, 40);
  for (let i = 0; i < pcm.length; i++) b.writeInt16LE(pcm[i], 44 + i * 2);
  return b;
}

// the other way: { sr, channels, bits, format, samples: Int16Array } (16-bit PCM only), or throws
export function readWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV');
  let p = 12, fmt = null, data = null;
  while (p + 8 <= buf.length) {
    const id = buf.toString('ascii', p, p + 4), size = buf.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(p + 8), channels: buf.readUInt16LE(p + 10), sr: buf.readUInt32LE(p + 12), bits: buf.readUInt16LE(p + 22) };
    else if (id === 'data') data = buf.subarray(p + 8, p + 8 + size);
    p += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('WAV without fmt / data');
  if (fmt.bits !== 16) throw new Error('not 16 bit');
  const samples = new Int16Array(data.length >> 1);
  for (let i = 0; i < samples.length; i++) samples[i] = data.readInt16LE(i * 2);
  return { ...fmt, samples };
}
