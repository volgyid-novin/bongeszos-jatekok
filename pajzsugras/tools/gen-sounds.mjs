// PAJZSUGRÁS' own sounds, computed from formulas: no recorded or extracted audio is read, nothing here is derived from anybody's samples.
//   node pajzsugras/tools/gen-sounds.mjs [outDir]        (npm run gen:pj-sounds)
// writes pajzsugras/assets/sounds/*.wav (24 kHz, mono, 16 bit) and a generated index.js with one literal `new URL('./x.wav', import.meta.url)` per
// file, which Vite turns into hashed files in dist/. Deterministic: every random number comes from a seeded PRNG (tools/sfx/dsp.mjs), so a second
// run gives byte-identical files (test/sounds-tests.mjs checks that). Layers are mixed in dB, every sound peaks at -1.5 dBFS, then audio.js sets
// the level in the game.
//
// The recipes (all sounds are one-shots unless noted):
//   jump x2     sine thump 95 -> 55 Hz, soft-clipped + a band-passed air burst 1.8 -> 0.9 kHz + an armour rattle (modal, 1.2 - 4.5 kHz)
//   djump       a jump + a rising whoosh 0.6 -> 2.4 kHz
//   dodge x2    thruster whump (low-passed noise, 3 ms attack) + an 80 Hz thud + a swish sweeping 3 -> 1 kHz
//   step x4     2 ms high-passed click + a 70 - 90 Hz thump + a plate ring (600 - 1800 Hz) + a servo tick 30 ms later
//   land        55 Hz thump + a grainy crunch + jittered rattles
//   charge      detuned saws 110 -> 440 Hz, a low-pass opening 0.6 -> 6 kHz, tremolo 6 -> 18 Hz; CHARGE_T long; it ends in the loop's state
//   charged     the loop: 110 / 440 / 660 Hz on whole cycles + crackle; its first sample follows the last sample of `charge`
//   fire x2     saturated sub 120 -> 40 Hz + a low-passed noise "pfoom" + a 15 ms crack + an inharmonic ring + a reverb (RT 0.5 s, -14 dB)
//   checkpoint  two FM bells (880 / 1320 Hz);   finish  a rising 4-note arpeggio, a chord and shimmer;
//   respawn     a reversed swell into a zap;    pad     a boing-thrust 160 -> 480 Hz + a whoosh
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CHARGE_T } from '../sim/const.js';
import { IR, SR, rng, len, zeros, curve, ad, osc, noise, biquad, ring, softClip, reverb, add, mul, scale, tile, peak, mean, toOutput, toPCM16, wavBytes, phaseCurve } from './sfx/dsp.mjs';

export const PEAK_DB = -1.5;   // every file's peak
const TAU = Math.PI * 2;
const db = (d) => Math.pow(10, d / 20);
// RMS over the stretch of a layer that holds 95 % of its energy (from its first audible sample): layers are balanced by this, not by their peaks,
// so a 55 Hz thump (loud on paper, faint on a laptop) does not push every other layer 25 dB down
function activeRms(x) {
  let e = 0, first = 0;
  const lim = peak(x) * 1e-4;
  for (let i = 0; i < x.length; i++) e += x[i] * x[i];
  while (first < x.length && Math.abs(x[first]) <= lim) first++;
  let acc = 0, k = first;
  for (; k < x.length; k++) { acc += x[k] * x[k]; if (acc >= 0.95 * e) break; }
  return Math.sqrt(acc / (k - first + 1)) || 1;
}
const lv = (x, d) => scale(x, db(d) / activeRms(x));   // a layer at d dB (active RMS)
const mix = (n, ...layers) => { const y = zeros(n); for (const [x, d, at] of layers) add(y, lv(x, d), 1, at || 0); return y; };
const smooth = (u) => { const c = u < 0 ? 0 : u > 1 ? 1 : u; return c * c * (3 - 2 * c); };

// random modes of a strike, log-spread over [lo, hi] Hz
const modes = (rand, count, lo, hi, t60lo, t60hi) => Array.from({ length: count }, () => {
  const f = lo * Math.pow(hi / lo, rand()), a = 0.4 + 0.6 * rand(), t60 = t60lo + (t60hi - t60lo) * rand();
  return { f, a, t60 };
});
// a short noise tick shaped by a sine window, high-passed
const click = (n, rand, sec, hp) => {
  const m = Math.round(sec * IR), x = zeros(n), nz = noise(m, rand);
  for (let i = 0; i < m; i++) x[i] = nz[i] * Math.sin(Math.PI * i / m);
  return biquad(x, 'highpass', hp, 0.7);
};
// sample-and-hold amplitude jitter, smoothed: the grit of a crunch
const grain = (n, rand, rateHz) => {
  const y = zeros(n), blk = Math.round(IR / rateHz);
  let v = 0.5, tgt = 0.5;
  for (let i = 0; i < n; i++) { if (i % blk === 0) tgt = 0.3 + 0.7 * rand(); v += (tgt - v) * 0.2; y[i] = v; }
  return y;
};
const fmBell = (n, { fc, ratio, index, tau, at, atk = 0.002 }) => {
  const y = zeros(n), i0 = Math.round(at * IR);
  for (let i = i0; i < n; i++) {
    const t = (i - i0) / IR, a = t < atk ? 0.5 - 0.5 * Math.cos(Math.PI * t / atk) : Math.exp(-(t - atk) / tau);
    y[i] = a * Math.sin(TAU * fc * t + index * Math.exp(-t / (tau * 0.7)) * Math.sin(TAU * fc * ratio * t));
  }
  return y;
};

// ------------------------------------------------------------------------------------------------ jump, double jump
function jumpLayers(rand, n, v) {
  const thump = softClip(mul(osc('sine', curve(n, [[0, v.f0], [0.06, v.f1]], 'exp'), n), ad(n, 0.002, v.tau)), 2.4);
  const air = mul(biquad(noise(n, rand), 'bandpass', curve(n, [[0, v.air0], [0.14, v.air1]], 'exp'), 1.2), ad(n, 0.006, 0.055));
  const rat = zeros(n);
  v.rattle.forEach((at, k) => ring(rat, modes(rand, 6, 1200, 4500, 0.025, 0.07), at, 0.6 / (1 + k * 0.8)));
  return [[thump, -5], [air, 0], [rat, -4]];
}
function jump(v) {
  const rand = rng(v.seed), n = len(0.35);
  const [thump, air, rat] = jumpLayers(rand, n, v);
  return mix(n, thump, air, rat);
}
function djump() {
  const rand = rng(0xd1a0), n = len(0.4);
  const [thump, air, rat] = jumpLayers(rand, n, { f0: 112, f1: 62, tau: 0.07, air0: 2100, air1: 1000, rattle: [0, 0.013, 0.035] });
  const whoosh = mul(biquad(noise(n, rand), 'bandpass', curve(n, [[0.02, 600], [0.3, 2400]], 'exp'), 2.2), ad(n, 0.17, 0.045, 0.02));
  const shine = mul(osc('sine', curve(n, [[0.02, 700], [0.3, 2900]], 'exp'), n), ad(n, 0.17, 0.045, 0.02));
  return mix(n, thump, air, rat, [whoosh, 0], [shine, -14]);
}

// ------------------------------------------------------------------------------------------------ dodge, steps, landing
function dodge(v) {
  const rand = rng(v.seed), n = len(0.4);
  const whump = mul(biquad(noise(n, rand), 'lowpass', curve(n, [[0, 2500], [0.25, 700]], 'exp'), 0.9), ad(n, 0.003, 0.11));
  const thud = softClip(mul(osc('sine', curve(n, [[0, v.thud * 1.15], [0.05, v.thud * 0.8]], 'exp'), n), ad(n, 0.002, 0.07)), 1.8);
  const swish = mul(biquad(noise(n, rand), 'bandpass', curve(n, [[0.02, v.s0], [0.3, v.s1]], 'exp'), 1.4), ad(n, 0.025, 0.09, 0.02));
  return mix(n, [whump, -2], [thud, 0], [swish, -3]);
}
function step(v) {
  const rand = rng(v.seed), n = len(0.16);
  const tick = click(n, rand, 0.002, 2200);
  const thump = softClip(mul(osc('sine', curve(n, [[0, v.f * 1.3], [0.03, v.f]], 'exp'), n), ad(n, 0.001, 0.035)), 4);
  const body = mul(biquad(noise(n, rand), 'lowpass', 420, 0.8), ad(n, 0.001, 0.022));   // (what a small speaker can play of the thud)
  const plate = zeros(n);
  ring(plate, v.plate.map(([f, t60], k) => ({ f, a: 1 / (1 + k * 0.6), t60 })), 0.001, 1);
  const servo = zeros(n);
  ring(servo, [{ f: v.tickF, a: 1, t60: 0.014 }, { f: v.tickF * 1.52, a: 0.5, t60: 0.01 }], v.tickAt, 1);
  return mix(n, [thump, -4], [body, -2], [tick, 0], [plate, -4], [servo, -6]);
}
function land() {
  const rand = rng(0x1a4d), n = len(0.35);
  const thump = softClip(mul(osc('sine', curve(n, [[0, 80], [0.1, 55]], 'exp'), n), ad(n, 0.002, 0.11)), 2.2);
  const body = mul(biquad(noise(n, rand), 'lowpass', 500, 0.8), ad(n, 0.002, 0.04));
  const crunch = mul(mul(biquad(noise(n, rand), 'bandpass', 1500, 0.7), ad(n, 0.003, 0.06)), grain(n, rand, 1300));
  const rat = zeros(n);
  [0.018, 0.052, 0.088, 0.137, 0.2].forEach((at, k) => ring(rat, modes(rand, 5, 1200, 4200, 0.03, 0.09), at + 0.01 * rand(), Math.pow(0.7, k)));
  return mix(n, [thump, -3], [body, -2], [crunch, 0], [rat, -5]);
}

// ------------------------------------------------------------------------------------------------ the shield: charge rise + charged loop
// The voice as a function of u (0 -> 1 progress of the charge) and s = seconds from the hand-over (index `ref`). Held (u = 1) it is the loop;
// the charge renders it for u < 1 and then a little past s = 0. All partials run on phases that are zero at s = 0, the tremolo too, so the
// last sample of the rise and the first sample of the loop are the same waveform.
function chargeVoice(n, ref, progress) {
  const u = new Float64Array(n);
  for (let i = 0; i < n; i++) u[i] = progress(i);
  const fm = u.map((x) => 110 * Math.pow(4, x));                          // 110 -> 440 Hz
  const det = u.map((x) => 14 * Math.pow(1 - x, 1.5));                    // detune of the saws, cents: none once held
  const up = fm.map((f, i) => f * Math.pow(2, det[i] / 1200)), dn = fm.map((f, i) => f * Math.pow(2, -det[i] / 1200));
  const saws = [up, fm, dn].map((f) => osc('saw', f, n, ref, 0.5));   // (half a cycle on: the saw's edge is not at the hand-over / the loop seam)
  const tone = osc('sine', fm, n, ref);
  const sub = mul(osc('sine', fm.map((f) => f / 4), n, ref), u.map((x) => smooth((x - 0.45) / 0.55)));       // 110 Hz arrives with the end
  const fifth = mul(osc('tri', fm.map((f) => f * 1.5), n, ref), u.map((x) => smooth((x - 0.6) / 0.4)));      // 660 Hz too
  const body = new Float64Array(n);
  for (let i = 0; i < n; i++) body[i] = (saws[0][i] + saws[1][i] + saws[2][i]) * 0.2 + tone[i] * 0.3 + sub[i] * 0.55 + fifth[i] * 0.22;
  const cut = u.map((x, i) => 600 * Math.pow(10, x) * (1 + 0.18 * smooth((x - 0.7) / 0.3) * Math.sin(TAU * 3 * (i - ref) / IR)));   // 0.6 -> 6 kHz, a 3 Hz wobble at the end
  const lp = biquad(body, 'lowpass', cut, 1.3);
  const trem = phaseCurve(u.map((x) => 6 + 12 * x), n, ref);                // 6 -> 18 Hz
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = lp[i] * (1 - 0.32 * (0.5 - 0.5 * Math.cos(TAU * trem[i]))) * (0.6 + 0.4 * Math.pow(u[i], 1.3));
  return { out, u };
}
const crackleHit = (rand) => [{ f: 2500 + 4500 * rand(), a: 0.15 + 0.35 * rand(), t60: 0.004 + 0.006 * rand() }];

function charge() {
  const ref = len(CHARGE_T), n = ref + len(0.05), rand = rng(0xc4a1);
  const { out, u } = chargeVoice(n, ref, (i) => Math.min(1, i / ref));
  // crackle fades in over the last third (the loop has it all the time)
  const cr = zeros(n);
  for (let t = 0.8 * CHARGE_T; t < CHARGE_T; t += 0.04 / (0.2 + (t / CHARGE_T - 0.8) * 5)) ring(cr, crackleHit(rand), t + 0.01 * rand(), 0.35);
  for (let i = 0; i < n; i++) out[i] += cr[i] * (0.6 + 0.4 * Math.pow(u[i], 1.3));
  return toOutput(out, { hp: false, fadeIn: 0.003, fadeOut: 0 }).subarray(0, Math.round(CHARGE_T * SR));
}
function charged() {
  const P = len(1), rand = rng(0xc4a3);
  const { out } = chargeVoice(3 * P, P, () => 1);
  const cr = zeros(P);
  for (let k = 0; k < 30; k++) ring(cr, crackleHit(rand), rand(), 0.35, { wrap: true });   // (wraps around the period: the loop stays periodic)
  add(out, tile(cr, 3));
  const y = toOutput(out, { hp: false, fadeIn: 0, fadeOut: 0 }).slice(SR, 2 * SR);          // the middle period: filters and the decimator have run in
  const m = mean(y);
  for (let i = 0; i < y.length; i++) y[i] -= m;
  return y;
}

// ------------------------------------------------------------------------------------------------ the shield blast
function fire(v) {
  const rand = rng(v.seed), n = len(0.7);
  const sub = softClip(mul(osc('sine', curve(n, [[0, v.sub0], [0.28, 40]], 'exp'), n), ad(n, 0.002, 0.14)), 3.2);
  const pfoom = mul(biquad(noise(n, rand), 'lowpass', curve(n, [[0, 1600], [0.35, 750]], 'exp'), 0.8), ad(n, 0.004, 0.1));
  const crack = mul(biquad(noise(n, rand), 'highpass', 1500, 0.7), ad(n, 0.0004, 0.0035));
  const rg = zeros(n);
  [1, 1.47, 2.09, 2.76, 3.52, 4.43, 5.4].forEach((r, k) => ring(rg, [{ f: v.ring * r, a: 1 / (1 + k * 0.5), t60: 0.28 - 0.025 * k }], 0.002, 1));
  const dry = mix(n, [sub, 0], [pfoom, -1], [crack, -2], [rg, -9]);
  return reverb(dry, { rt60: 0.5, wetDb: -14 });
}

// ------------------------------------------------------------------------------------------------ jingles
function checkpoint() {
  const n = len(0.6);
  const a = fmBell(n, { fc: 880, ratio: 3.5, index: 2.4, tau: 0.1, at: 0 }), b = fmBell(n, { fc: 1320, ratio: 3.5, index: 2.2, tau: 0.12, at: 0.085 });
  return reverb(mix(n, [a, 0], [b, -1]), { rt60: 0.45, wetDb: -11 });
}
function finish() {
  const n = len(1.2), rand = rng(0xf1a5), notes = [523.25, 659.25, 783.99, 1046.5];
  const arp = zeros(n);
  notes.forEach((f, k) => {
    add(arp, fmBell(n, { fc: f, ratio: 2, index: 1.5, tau: 0.16, at: 0 }), 1, k * 0.11);
    add(arp, fmBell(n, { fc: f * 2, ratio: 1, index: 0.8, tau: 0.08, at: 0 }), 0.25, k * 0.11);
  });
  const chord = zeros(n);
  for (const f of notes) for (const c of [-5, 0, 5]) add(chord, mul(osc('sine', f * Math.pow(2, c / 1200), n), ad(n, 0.05, 0.16, 0.5)), 1);
  const shimmer = mul(biquad(noise(n, rand), 'bandpass', 7500, 1.2), ad(n, 0.14, 0.18, 0.5));
  return reverb(mix(n, [arp, 0], [chord, -2], [shimmer, -16]), { rt60: 0.8, wetDb: -10 });
}
function respawn() {
  const rand = rng(0x2e5a), n = len(0.5), sw = len(0.3);
  const swellEnv = zeros(n);
  for (let i = 0; i < sw; i++) swellEnv[i] = Math.exp(-(0.3 - i / IR) / 0.085) * Math.min(1, (sw - i) / (0.002 * IR));
  const swell = mul(biquad(noise(n, rand), 'bandpass', curve(n, [[0, 250], [0.3, 3200]], 'exp'), 1.4), swellEnv);
  const rise = mul(osc('sine', curve(n, [[0, 80], [0.3, 800]], 'exp'), n), swellEnv);
  const zap = mul(biquad(osc('saw', curve(n, [[0.3, 2600], [0.39, 180]], 'exp'), n), 'lowpass', 4200, 0.9), ad(n, 0.001, 0.045, 0.3));
  const crack = mul(biquad(noise(n, rand), 'highpass', 2000, 0.7), ad(n, 0.0005, 0.004, 0.3));
  const sparkle = zeros(n);
  ring(sparkle, [{ f: 1650, a: 1, t60: 0.14 }, { f: 2480, a: 0.6, t60: 0.1 }, { f: 880, a: 0.5, t60: 0.18 }], 0.3, 1);
  const thump = mul(osc('sine', curve(n, [[0.3, 230], [0.38, 70]], 'exp'), n), ad(n, 0.002, 0.05, 0.3));
  return mix(n, [swell, -2], [rise, -10], [zap, 0], [crack, -6], [sparkle, -8], [thump, -5]);
}
function pad() {
  const rand = rng(0x9ad0), n = len(0.4);
  const f = curve(n, [[0, 160], [0.32, 480]], 'exp').map((b, i) => b * (1 + 0.07 * Math.exp(-i / IR / 0.12) * Math.sin(TAU * 22 * i / IR)));
  const boing = softClip(mul(add(osc('sine', f, n), osc('sine', f.map((x) => x * 2), n), 0.35), ad(n, 0.004, 0.1)), 1.6);
  const whoosh = mul(biquad(noise(n, rand), 'bandpass', curve(n, [[0.01, 500], [0.3, 3000]], 'exp'), 1.1), ad(n, 0.04, 0.09, 0.01));
  const thrust = mul(biquad(noise(n, rand), 'lowpass', 500, 0.9), ad(n, 0.003, 0.06));
  const thud = mul(osc('sine', 70, n), ad(n, 0.002, 0.05));
  return mix(n, [boing, 0], [whoosh, -3], [thrust, -5], [thud, -3]);
}

// ------------------------------------------------------------------------------------------------ the table
// key -> file stems (a key with several files is played at random)
export const KEYS = {
  jump: ['jump1', 'jump2'], djump: ['djump'], dodge: ['dodge1', 'dodge2'], step: ['step1', 'step2', 'step3', 'step4'], land: ['land'],
  charge: ['charge'], charged: ['charged'], fire: ['fire1', 'fire2'], checkpoint: ['checkpoint'], finish: ['finish'], respawn: ['respawn'], pad: ['pad'],
};
// stem -> { render() -> the sound at 24 kHz, fadeOut (s) }
const RECIPES = {
  jump1: { render: () => jump({ seed: 0x7a01, f0: 95, f1: 55, tau: 0.075, air0: 1800, air1: 900, rattle: [0, 0.017, 0.039] }) },
  jump2: { render: () => jump({ seed: 0x7a02, f0: 102, f1: 58, tau: 0.07, air0: 1950, air1: 980, rattle: [0.004, 0.02, 0.043] }) },
  djump: { render: djump },
  dodge1: { render: () => dodge({ seed: 0xd001, thud: 80, s0: 3000, s1: 1000 }) },
  dodge2: { render: () => dodge({ seed: 0xd002, thud: 86, s0: 3300, s1: 1100 }) },
  step1: { render: () => step({ seed: 0x5701, f: 70, plate: [[640, 0.05], [1130, 0.04]], tickF: 1900, tickAt: 0.03 }) },
  step2: { render: () => step({ seed: 0x5702, f: 78, plate: [[790, 0.055], [1420, 0.04], [1750, 0.03]], tickF: 2250, tickAt: 0.032 }) },
  step3: { render: () => step({ seed: 0x5703, f: 84, plate: [[720, 0.05], [1280, 0.045]], tickF: 2050, tickAt: 0.028 }) },
  step4: { render: () => step({ seed: 0x5704, f: 90, plate: [[910, 0.05], [1560, 0.035]], tickF: 2400, tickAt: 0.031 }) },
  land: { render: land },
  charge: { render: charge },
  charged: { render: charged, loop: true },
  fire1: { render: () => fire({ seed: 0xf101, sub0: 120, ring: 300 }) },
  fire2: { render: () => fire({ seed: 0xf102, sub0: 132, ring: 335 }) },
  checkpoint: { render: checkpoint },
  finish: { render: finish },
  respawn: { render: respawn },
  pad: { render: pad },
};
export const NAMES = Object.keys(RECIPES);
// sounds that must share one gain (the rise has to end at the level where the loop begins)
const GROUPS = { charge: ['charge', 'charged'], charged: ['charge', 'charged'] };

// one sound before the level and dither: Float64Array at SR
export function renderRaw(name) {
  const r = RECIPES[name];
  if (!r) throw new Error('no such sound: ' + name);
  const x = r.render();
  return r.loop || name === 'charge' ? x : toOutput(x, { hp: true, fadeIn: 0.003, fadeOut: r.fadeOut ?? 0.01 });
}
// one sound as 16-bit PCM
export function renderPCM(name) {
  const group = GROUPS[name] || [name], raws = group.map(renderRaw);
  const top = Math.max(...raws.map(peak)), mine = raws[group.indexOf(name)];
  return toPCM16(scale(mine, db(PEAK_DB) / top), rng(0xd17e0000 + NAMES.indexOf(name)));
}
export const renderWav = (name) => wavBytes(renderPCM(name));

export function indexSource() {
  const rows = Object.entries(KEYS).map(([key, stems]) => `  ${key}: [${stems.map((s) => `\n    new URL('./${s}.wav', import.meta.url).href,`).join('')}\n  ],`);
  return `// GENERATED by tools/gen-sounds.mjs (npm run gen:pj-sounds): do not edit. PAJZSUGRÁS' own sounds, computed from formulas (no sampled audio).
// Every key lists its variants (audio.js plays one at random). Vite turns each new URL(...) into a hashed file in dist/ (or a data: URL below 4 kB).
export const SOUNDS = {
${rows.join('\n')}
};
`;
}

export function generate(outDir) {
  mkdirSync(outDir, { recursive: true });
  const rows = [];
  for (const name of NAMES) {
    const wav = renderWav(name);
    writeFileSync(join(outDir, name + '.wav'), wav);
    rows.push({ name, bytes: wav.length });
  }
  writeFileSync(join(outDir, 'index.js'), indexSource());
  return rows;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'sounds');
  const rows = generate(out);
  for (const r of rows) console.log(r.name.padEnd(11) + String(r.bytes).padStart(8) + ' B');
  console.log('total'.padEnd(11) + String(rows.reduce((a, r) => a + r.bytes, 0)).padStart(8) + ' B  ->  ' + out);
}
