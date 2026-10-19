// PAJZSUGRÁS' own sounds (tools/gen-sounds.mjs -> assets/sounds/*.wav + index.js) and how audio.js uses them: the manifest, the WAV format, the size
// budget, levels, the seamless charged loop, a byte-identical re-render, and that no local-* file is ever requested unless the owner opts in (and then
// only in a dev build). The WebAudio context and fetch are mocks; nothing is played.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, assert, setGlobal, sleep } from './harness.mjs';
import { SOUNDS } from '../assets/sounds/index.js';
import { KEYS, NAMES, renderWav } from '../tools/gen-sounds.mjs';
import { readWav } from '../tools/sfx/dsp.mjs';
import { GameAudio } from '../audio.js';
import { loadUTSounds } from '../ut-local-sounds.js';
import { CHARGE_T } from '../sim/const.js';

const DIR = fileURLToPath(new URL('../assets/sounds/', import.meta.url));
const wavs = () => readdirSync(DIR).filter((f) => f.endsWith('.wav')).sort();
const load = (stem) => readWav(readFileSync(DIR + stem + '.wav'));
const fsPath = (url) => fileURLToPath(url);

test('sounds: the manifest lists every key, each variant is a literal new URL(...) that exists as a file, and nothing else is in the folder', () => {
  const keys = ['jump', 'djump', 'dodge', 'step', 'land', 'charge', 'charged', 'fire', 'checkpoint', 'finish', 'respawn', 'pad'];
  assert.deepEqual(Object.keys(SOUNDS), keys);
  assert.deepEqual(Object.keys(KEYS), keys, 'the generator and the manifest agree');
  const counts = Object.fromEntries(keys.map((k) => [k, SOUNDS[k].length]));
  assert.deepEqual(counts, { jump: 2, djump: 1, dodge: 2, step: 4, land: 1, charge: 1, charged: 1, fire: 2, checkpoint: 1, finish: 1, respawn: 1, pad: 1 });
  const files = new Set();
  for (const k of keys) for (const url of SOUNDS[k]) { assert.match(url, /^file:/, k); files.add(fsPath(url).replace(/^.*[\\/]/, '')); statSync(fsPath(url)); }
  assert.deepEqual([...files].sort(), wavs(), 'every wav in the folder is in the manifest and vice versa');
  assert.deepEqual([...files].sort(), NAMES.map((n) => n + '.wav').sort());
  const src = readFileSync(DIR + 'index.js', 'utf8');
  assert.equal((src.match(/new URL\('\.\/[a-z0-9]+\.wav', import\.meta\.url\)\.href/g) || []).length, files.size, 'one literal new URL(...) per file, so that Vite bundles each');
});

test('sounds: every file is a 24 kHz mono 16-bit PCM WAV with a consistent header', () => {
  for (const f of wavs()) {
    const buf = readFileSync(DIR + f), w = readWav(buf);
    assert.deepEqual([w.format, w.channels, w.sr, w.bits], [1, 1, 24000, 16], f);
    assert.equal(buf.readUInt32LE(4), buf.length - 8, f + ': RIFF size');
    assert.equal(buf.readUInt32LE(40), w.samples.length * 2, f + ': data size');
    assert.equal(buf.length, 44 + w.samples.length * 2, f + ': no trailing bytes');
    assert.ok(w.samples.length / 24000 >= 0.15 && w.samples.length / 24000 <= 1.25, `${f}: ${(w.samples.length / 24000).toFixed(2)} s`);
  }
});

test('sounds: the whole set is at most 480 KB', () => {
  const total = wavs().reduce((a, f) => a + statSync(DIR + f).size, 0);
  assert.ok(total <= 480 * 1000, `${total} bytes`);
});

test('sounds: peaks stay at or below -1 dBFS, no DC, and no click at the start or the end of a one-shot', () => {
  const lim = 32768 * Math.pow(10, -1 / 20);
  for (const f of wavs()) {
    const s = load(f.replace('.wav', '')).samples;
    let peak = 0, sum = 0;
    for (const v of s) { peak = Math.max(peak, Math.abs(v)); sum += v; }
    assert.ok(peak <= lim, `${f}: peak ${(20 * Math.log10(peak / 32768)).toFixed(2)} dBFS`);
    assert.ok(peak >= 32768 * Math.pow(10, -3 / 20), `${f}: loud enough (peak ${(20 * Math.log10(peak / 32768)).toFixed(2)} dBFS)`);
    assert.ok(Math.abs(sum / s.length) <= 33, `${f}: DC ${(sum / s.length).toFixed(1)} LSB`);
    if (f !== 'charged.wav') assert.ok(Math.abs(s[0]) <= 40, `${f}: starts at ${s[0]}`);
    if (f !== 'charged.wav' && f !== 'charge.wav') assert.ok(Math.abs(s[s.length - 1]) <= 40, `${f}: ends at ${s[s.length - 1]}`);
  }
});

test('sounds: the charged loop closes without a step, and the charge rise runs into its first sample', () => {
  const loop = load('charged').samples, rise = load('charge').samples;
  assert.equal(loop.length, 24000, 'one second: 18 tremolo cycles, 110 / 440 / 660 Hz on whole cycles');
  assert.equal(rise.length, Math.round(CHARGE_T * 24000), 'CHARGE_T long');
  // the second difference (the change of the slope) across the seam must be no bigger than inside the loop; a loop cut a few samples short, or a
  // rise that ends out of phase, has a step of the signal's own size there (about 15 times the average)
  const n = loop.length;
  let mean = 0;
  for (let i = 1; i < n - 1; i++) mean += Math.abs(loop[i + 1] - 2 * loop[i] + loop[i - 1]);
  mean /= n - 2;
  const d2 = (a, b, c) => Math.abs(a - 2 * b + c);
  const r = rise.length;
  const seam = [d2(loop[0], loop[n - 1], loop[n - 2]), d2(loop[1], loop[0], loop[n - 1])];
  const join = [d2(loop[0], rise[r - 1], rise[r - 2]), d2(loop[1], loop[0], rise[r - 1])];
  assert.ok(Math.max(...seam) <= 4 * mean, `loop seam: slope change ${seam} vs ${mean.toFixed(0)} inside the loop`);
  assert.ok(Math.max(...join) <= 4 * mean, `rise -> loop: slope change ${join} vs ${mean.toFixed(0)} inside the loop`);
});

test('sounds: re-rendering in-process gives the committed files byte for byte (a one-shot, the loop and the rise that shares its gain)', () => {
  for (const name of ['jump1', 'step3', 'charge', 'charged']) {
    assert.ok(renderWav(name).equals(readFileSync(DIR + name + '.wav')), name + ' differs from assets/sounds/' + name + '.wav: run npm run gen:pj-sounds and commit');
  }
});

// ---------------------------------------------------------------------------------------------------- audio.js with a mock context
function mockAudio() {
  const requests = [], sources = [];
  class Param { constructor(v = 0) { this.value = v; } setTargetAtTime() {} setValueAtTime() {} linearRampToValueAtTime() {} exponentialRampToValueAtTime() {} }
  const node = () => ({ gain: new Param(1), connect() {}, disconnect() {} });
  class FakeContext {
    constructor() { this.state = 'running'; this.currentTime = 10; this.sampleRate = 48000; this.destination = node(); }
    createGain() { return node(); }
    createDynamicsCompressor() { return { threshold: new Param(), knee: new Param(), ratio: new Param(), attack: new Param(), release: new Param(), connect() {} }; }
    createDelay() { return { delayTime: new Param(), connect() {} }; }
    createBiquadFilter() { return { frequency: new Param(), Q: new Param(), type: '', connect() {} }; }
    createBuffer(ch, len, sr) { const d = new Float32Array(len); return { length: len, sampleRate: sr, duration: len / sr, getChannelData: () => d }; }
    createBufferSource() {
      const s = { buffer: null, loop: false, loopStart: 0, loopEnd: 0, playbackRate: new Param(1), started: null, stopped: null, connect() {}, start(when, offset) { s.started = [when, offset]; }, stop(t) { s.stopped = t; } };
      sources.push(s);
      return s;
    }
    resume() { return Promise.resolve(); }
    decodeAudioData(ab) { const w = readWav(Buffer.from(ab)); return Promise.resolve({ duration: w.samples.length / w.sr, length: w.samples.length, sampleRate: w.sr }); }
  }
  setGlobal('window', { AudioContext: FakeContext });
  setGlobal('location', { hostname: 'localhost' });
  setGlobal('fetch', async (url) => {
    const u = String(url);
    requests.push(u);
    if (u.startsWith('file:')) return new Response(readFileSync(fsPath(u)), { status: 200, headers: { 'content-type': 'audio/wav' } });
    return new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } });   // (what a dev server answers for a path it does not have)
  });
  return { requests, sources };
}
const loaded = async (audio, n) => { for (let i = 0; i < 100 && Object.values(audio.own).flat().length < n; i++) await sleep(10); };
const TOTAL = Object.values(SOUNDS).flat().length;

test('audio: our sounds load from the bundle, and with the local UT files off (not a dev build on this machine) not one local-* file is requested', async () => {
  for (const wantLocal of [false, true]) {   // (true: the node tests are not a dev build, so the switch alone must not reach local-sounds)
    const { requests } = mockAudio();
    const audio = new GameAudio();
    audio.setLocalUT(wantLocal);
    audio.unlock();
    await loaded(audio, TOTAL);
    audio.setLocalUT(wantLocal);
    await sleep(20);
    assert.equal(Object.values(audio.own).flat().length, TOTAL, 'all bundled sounds decoded');
    assert.deepEqual(Object.keys(audio.own).sort(), Object.keys(SOUNDS).sort());
    assert.equal(requests.length, TOTAL, 'one request per bundled file');
    assert.deepEqual(requests.filter((u) => /local-/i.test(u)), [], `localUT=${wantLocal}: no local-* request`);
    assert.deepEqual(audio.local, {});
  }
  // the control: the loader itself does go to ./local-sounds/ (so the check above is not vacuous), and a dev server's HTML fallback adds nothing
  const { requests } = mockAudio();
  const got = [];
  await loadUTSounds(new (window.AudioContext)(), (name) => got.push(name));
  assert.deepEqual(requests.filter((u) => /local-sounds/.test(u)).slice(0, 1), ['./local-sounds/sounds.json']);
  assert.deepEqual(got, []);
});

test('audio: the charge rise and the charged loop are scheduled back to back on the audio clock; release fades both; a mid-charge start skips ahead', async () => {
  const { sources } = mockAudio();
  const audio = new GameAudio();
  audio.unlock();
  await loaded(audio, TOTAL);
  audio.setCharge(true, 0);
  assert.equal(sources.length, 2);
  const [rise, loop] = sources, dur = rise.buffer.duration;
  assert.ok(Math.abs(dur - CHARGE_T) < 1e-9 && !rise.loop);
  assert.ok(Math.abs(rise.started[0] - 10.01) < 1e-9 && rise.started[1] === 0, 'the rise starts 10 ms ahead on the clock');
  assert.ok(loop.loop && loop.loopStart === 0 && Math.abs(loop.loopEnd - loop.buffer.duration) < 1e-12 && Math.abs(loop.buffer.duration - 1) < 1e-9);
  assert.ok(Math.abs(loop.started[0] - (10.01 + dur)) < 1e-9, 'the loop starts exactly where the rise ends: ' + loop.started[0]);
  audio.setCharge(true, 0.5);
  assert.equal(sources.length, 2, 'holding the button starts nothing new');
  audio.setCharge(false);
  assert.ok(rise.stopped > 10 && loop.stopped > 10, 'both are stopped (after the fade)');
  audio.setCharge(true, 0.5);
  const mid = sources.slice(2);
  assert.equal(mid.length, 2);
  assert.ok(Math.abs(mid[0].started[1] - 0.5 * CHARGE_T) < 1e-9, 'half charged: the rise starts in the middle');
  assert.ok(Math.abs(mid[1].started[0] - (10.01 + 0.5 * CHARGE_T)) < 1e-9, 'and the loop follows after the other half');
  audio.setCharge(false);
  audio.setCharge(true, 1);
  const full = sources.slice(4);
  assert.equal(full.length, 1, 'a full charge goes straight to the loop');
  assert.ok(full[0].loop);
});
