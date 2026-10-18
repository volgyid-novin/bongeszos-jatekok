// Game audio. The sounds are PAJZSUGRÁS' own: computed by tools/gen-sounds.mjs into assets/sounds/, bundled by Vite and decoded when the context is
// created. A WebAudio synth (oscillators and filtered noise) stays underneath as the fallback for any sound that has not loaded (yet), and the UI click
// is always live synth.
//
//   const audio = new GameAudio();
//   audio.unlock()                      create / resume the AudioContext (call it from a click or key press)
//   audio.setVolume(0..1)  audio.mute(bool)
//   audio.jump(combo) doubleJump() dodge() wallDodge() land(speed) blast(charge, hit) checkpoint() finish() respawn() pad() click()
//   audio.setCharge(on, charge)         the shield: the charge rise hands over to the looping "charged" hum at full charge; both fade out on release
//   audio.update(dt, { grounded, speed, paused })    footsteps by speed
//   audio.setLocalUT(bool)              on by itself on a local dev build (main.js, local-ut.js), never elsewhere: the owner's own UT2004 sounds (git-ignored ./local-sounds/, see
//                                       ut-local-sounds.js) replace the shield charge / blast, jump, double jump, dodge, wall dodge, footsteps and landing
// Every method is a no-op until the context exists, so callers never need to check.
import { SOUNDS } from './assets/sounds/index.js';
import { localUTAvailable } from './local-ut.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const rnd = (a, b) => a + Math.random() * (b - a);

// a dev build (npm run dev): Vite replaces import.meta.env.DEV with false in the production build, so the local-sounds code below is dropped there
const DEV = import.meta.env?.DEV === true;

// The bundled sounds are all peak-normalised (-1.5 dBFS); this sets their level in the game. (The gains at the call sites below were tuned for the
// owner's UT2004 samples and stay as they are for those.)
const OWN_GAIN = { jump: 0.8, djump: 0.8, dodge: 0.8, step: 1.2, land: 0.7, charge: 0.4, charged: 0.4, fire: 0.9, checkpoint: 0.8, finish: 0.8, respawn: 0.8, pad: 0.8 };
const OWN = new WeakSet();   // the decoded buffers that are ours

// the bytes of a file, or null (a failed request, a 404, an HTML fallback page); a data: URL (Vite inlines small files) works the same way
const fetchBytes = (url) => fetch(url).then((r) => (r.ok && !/html|json|text/.test(r.headers.get('content-type') || '') ? r.arrayBuffer() : null)).catch(() => null);

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.volume = 0.7;
    this.muted = false;
    this.stride = 0;           // metres walked since the last footstep
    this.foot = 0;
    this.hum = null;
    this.own = {};             // our bundled sounds by name (AudioBuffer[])
    this.local = {};           // the owner's UT2004 sounds by name (empty unless opted in)
    this.lastSample = {};
    this.wantLocal = false;
    this.localAsked = false;
    this.localGen = 0;
    this.chargeSrc = null;     // the playing charge sounds: [{ s, g }, ...] (the rise and the loop)
  }

  // ---- sample banks ----
  // our bundled sounds (assets/sounds/index.js): { name: [url, ...] }; whatever fails to load keeps the synth
  loadOwn() {
    for (const [name, urls] of Object.entries(SOUNDS)) {
      for (const url of urls) {
        fetchBytes(url)
          .then((buf) => (buf ? this.ctx.decodeAudioData(buf) : null))
          .then((ab) => { if (ab) { OWN.add(ab); (this.own[name] ||= []).push(ab); } })
          .catch(() => { /* this sound stays synthesised */ });
      }
    }
  }
  // the owner's UT2004 sounds: only when switched on, in a dev build, served from this machine; no request at all otherwise
  setLocalUT(on) {
    this.wantLocal = !!on;
    if (!this.wantLocal) { this.local = {}; this.localAsked = false; this.localGen++; return; }
    this.loadLocal();
  }
  loadLocal() {
    if (!DEV || !this.wantLocal || !this.ctx || this.localAsked || !localUTAvailable()) return;
    this.localAsked = true;
    const gen = ++this.localGen;
    import('./ut-local-sounds.js')
      .then((m) => m.loadUTSounds(this.ctx, (name, ab) => { if (gen === this.localGen) (this.local[name] ||= []).push(ab); }))
      .catch(() => { /* no local sounds */ });
  }
  hasLocal(name) { return !!(this.local[name] && this.local[name].length); }
  // a random sample of a kind (the owner's if opted in and present, else ours; never the same one twice in a row), or null
  sample(name) {
    const list = this.hasLocal(name) ? this.local[name] : this.own[name];
    if (!list || !list.length) return null;
    let i = Math.floor(Math.random() * list.length);
    if (list.length > 1 && i === this.lastSample[name]) i = (i + 1) % list.length;
    this.lastSample[name] = i;
    return list[i];
  }
  // loop: the whole buffer repeats; when: audio-clock time to start at; offset: seconds into the buffer
  playSample(buf, gain, rate = 1, { loop = false, when = 0, offset = 0 } = {}) {
    const c = this.ctx, s = c.createBufferSource(), g = c.createGain();
    s.buffer = buf; s.playbackRate.value = rate; g.gain.value = gain;
    if (loop) { s.loop = true; s.loopStart = 0; s.loopEnd = buf.duration; }
    s.connect(g); g.connect(this.master);
    s.start(when, offset);
    return { s, g };
  }
  // plays a sample of a kind; false: there is none, the caller falls back to the synth
  play(name, gain, rate = 1) {
    const buf = this.sample(name);
    if (!buf) return false;
    if (this.ready) this.playSample(buf, OWN.has(buf) ? gain * (OWN_GAIN[name] ?? 1) : gain, rate);
    return true;
  }

  // ---- context ----
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try { this.ctx = new AC({ latencyHint: 'interactive' }); } catch { return; }
      const c = this.ctx;
      this.master = c.createGain();
      this.master.gain.value = this.muted ? 0 : this.volume;
      const comp = c.createDynamicsCompressor();
      comp.threshold.value = -14; comp.knee.value = 12; comp.ratio.value = 5; comp.attack.value = 0.004; comp.release.value = 0.18;
      this.master.connect(comp); comp.connect(c.destination);
      // a small reverb bus (feedback delay) for chimes, drips and the fanfare
      this.verb = c.createGain(); this.verb.gain.value = 0.35;
      const d1 = c.createDelay(1), d2 = c.createDelay(1), fb = c.createGain(), lp = c.createBiquadFilter();
      d1.delayTime.value = 0.113; d2.delayTime.value = 0.173; fb.gain.value = 0.42; lp.type = 'lowpass'; lp.frequency.value = 2600;
      this.verb.connect(d1); d1.connect(d2); d2.connect(lp); lp.connect(fb); fb.connect(d1); lp.connect(this.master);
      // noise buffers
      const len = c.sampleRate * 2;
      this.white = c.createBuffer(1, len, c.sampleRate);
      const w = this.white.getChannelData(0);
      for (let i = 0; i < len; i++) w[i] = Math.random() * 2 - 1;
      this.brown = c.createBuffer(1, len, c.sampleRate);
      const b = this.brown.getChannelData(0);
      let last = 0;
      for (let i = 0; i < len; i++) { last = (last + 0.02 * w[i]) / 1.02; b[i] = last * 3.5; }
      this.loadOwn();
      this.loadLocal();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }
  setVolume(v) {
    this.volume = clamp(v, 0, 1);
    if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.03);
  }
  mute(b) {
    this.muted = !!b;
    if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.02);
  }
  get ready() { return !!this.ctx && this.ctx.state === 'running' && !this.muted; }

  // ---- building blocks ----
  // oscillator with a frequency sweep and an attack / decay envelope
  tone({ type = 'sine', f0, f1 = f0, dur = 0.2, gain = 0.3, attack = 0.005, filter = null, wet = 0, delay = 0, detune = 0 }) {
    if (!this.ready) return null;
    const c = this.ctx, t = c.currentTime + delay;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    if (detune) o.detune.value = detune;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node = o;
    if (filter) { const f = c.createBiquadFilter(); f.type = filter.type || 'lowpass'; f.frequency.value = filter.f; f.Q.value = filter.q || 0.7; node.connect(f); node = f; }
    node.connect(g); g.connect(this.master);
    if (wet) { const s = c.createGain(); s.gain.value = wet; g.connect(s); s.connect(this.verb); }
    o.start(t); o.stop(t + dur + 0.05);
    return o;
  }
  // filtered noise burst with a filter sweep
  noise({ type = 'bandpass', f0 = 1000, f1 = f0, q = 1, dur = 0.2, gain = 0.3, attack = 0.005, buf = 'white', delay = 0, wet = 0 }) {
    if (!this.ready) return;
    const c = this.ctx, t = c.currentTime + delay;
    const s = c.createBufferSource();
    s.buffer = buf === 'brown' ? this.brown : this.white;
    s.loop = true;
    const f = c.createBiquadFilter(), g = c.createGain();
    f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(this.master);
    if (wet) { const w = c.createGain(); w.gain.value = wet; g.connect(w); w.connect(this.verb); }
    s.start(t, Math.random() * 1.5); s.stop(t + dur + 0.05);
  }

  // ---- one-shots ----
  step(speed) {
    if (!this.ready) return;
    const k = clamp(speed / 9, 0.3, 1.2);
    if (this.play('step', 0.22 * k, 0.96 + Math.random() * 0.08)) return;
    this.foot ^= 1;
    this.noise({ type: 'lowpass', f0: this.foot ? 900 : 700, f1: 260, q: 0.8, dur: 0.07, gain: 0.16 * k, buf: 'white' });
    this.tone({ type: 'sine', f0: this.foot ? 95 : 82, f1: 50, dur: 0.07, gain: 0.2 * k });
  }
  jump(combo) {
    if (this.play('jump', 0.55)) return;
    this.tone({ type: 'sine', f0: 170, f1: 340, dur: 0.14, gain: 0.16 });
    this.noise({ type: 'bandpass', f0: 500, f1: 1400, q: 0.9, dur: 0.12, gain: 0.07 });
    if (combo) this.tone({ type: 'triangle', f0: 340, f1: 760, dur: 0.18, gain: 0.1 });
  }
  doubleJump() {
    if (this.hasLocal('jump')) { this.play('jump', 0.55, 1.06); return; }   // (the owner's UT2004 set has one jump sound: pitched up)
    if (this.play('djump', 0.6)) return;
    this.tone({ type: 'triangle', f0: 300, f1: 760, dur: 0.2, gain: 0.17 });
    this.tone({ type: 'sine', f0: 600, f1: 1500, dur: 0.16, gain: 0.07, delay: 0.02 });
    this.noise({ type: 'bandpass', f0: 900, f1: 2800, q: 1.4, dur: 0.18, gain: 0.1 });
  }
  dodge() {
    if (this.play('dodge', 0.6)) return;
    this.noise({ type: 'bandpass', f0: 350, f1: 2000, q: 0.8, dur: 0.24, gain: 0.34, attack: 0.03 });
    this.tone({ type: 'sine', f0: 140, f1: 90, dur: 0.12, gain: 0.12 });
  }
  wallDodge() {
    if (this.play('dodge', 0.6, 1.05)) return;
    this.noise({ type: 'bandpass', f0: 500, f1: 2400, q: 0.9, dur: 0.22, gain: 0.3, attack: 0.02 });
    this.tone({ type: 'square', f0: 880, f1: 520, dur: 0.05, gain: 0.07, filter: { type: 'lowpass', f: 2400 } });
    this.tone({ type: 'sine', f0: 120, f1: 60, dur: 0.14, gain: 0.22 });
  }
  land(speed) {
    const k = clamp((speed - 2) / 14, 0.08, 1);
    if (this.hasLocal('step')) { this.play('step', 0.3 + 0.45 * k, 0.9); return; }   // UT2004 lands on the footstep sound, just louder
    if (this.play('land', 0.35 + 0.65 * k, 1.05 - 0.12 * k)) return;                 // (a harder landing is a little deeper)
    this.tone({ type: 'sine', f0: 130, f1: 42, dur: 0.17, gain: 0.5 * k });
    this.noise({ type: 'lowpass', f0: 700, f1: 120, q: 0.7, dur: 0.14, gain: 0.3 * k });
  }
  blast(charge, hit) {
    const c = clamp(charge, 0, 1);
    if (this.play('fire', hit ? 0.55 + 0.45 * c : 0.35 + 0.2 * c)) return;
    if (hit) {
      this.tone({ type: 'sine', f0: 150, f1: 36, dur: 0.3, gain: 0.45 + 0.4 * c });
      this.noise({ type: 'lowpass', f0: 2200, f1: 160, q: 0.8, dur: 0.22, gain: 0.3 + 0.3 * c });
      this.tone({ type: 'sawtooth', f0: 1300, f1: 220, dur: 0.1, gain: 0.08 + 0.08 * c, filter: { type: 'lowpass', f: 3000 } });
    } else {
      this.noise({ type: 'bandpass', f0: 1800, f1: 300, q: 1, dur: 0.14, gain: 0.14 + 0.1 * c });
      this.tone({ type: 'sine', f0: 200, f1: 70, dur: 0.14, gain: 0.14 });
    }
  }
  checkpoint() {
    if (this.play('checkpoint', 0.6)) return;
    this.tone({ type: 'sine', f0: 659.3, dur: 0.5, gain: 0.2, wet: 0.5 });
    this.tone({ type: 'triangle', f0: 659.3 * 2, dur: 0.3, gain: 0.05, wet: 0.5 });
    this.tone({ type: 'sine', f0: 987.8, dur: 0.6, gain: 0.2, delay: 0.09, wet: 0.6 });
    this.tone({ type: 'triangle', f0: 987.8 * 2, dur: 0.35, gain: 0.04, delay: 0.09, wet: 0.5 });
  }
  finish() {
    if (this.play('finish', 0.6)) return;
    const notes = [523.3, 659.3, 784, 1046.5];
    notes.forEach((f, i) => {
      this.tone({ type: 'triangle', f0: f, dur: 0.5, gain: 0.2, delay: i * 0.11, wet: 0.5 });
      this.tone({ type: 'square', f0: f, dur: 0.3, gain: 0.05, delay: i * 0.11, filter: { type: 'lowpass', f: 2200 } });
    });
    [523.3, 659.3, 784, 1046.5].forEach((f) => this.tone({ type: 'triangle', f0: f, dur: 1.4, gain: 0.1, delay: 0.5, attack: 0.05, wet: 0.7 }));
    this.noise({ type: 'highpass', f0: 5000, dur: 0.6, gain: 0.05, delay: 0.5, attack: 0.1, wet: 0.5 });
  }
  respawn() {
    if (this.play('respawn', 0.6)) return;
    this.tone({ type: 'sine', f0: 700, f1: 90, dur: 0.26, gain: 0.2 });
    this.noise({ type: 'bandpass', f0: 2600, f1: 300, q: 1, dur: 0.26, gain: 0.16 });
  }
  pad() {
    if (this.play('pad', 0.6)) return;
    const o = this.tone({ type: 'sine', f0: 190, f1: 760, dur: 0.3, gain: 0.3 });
    if (o) {
      const c = this.ctx, lfo = c.createOscillator(), lg = c.createGain();
      lfo.frequency.value = 22; lg.gain.value = 40;
      lfo.connect(lg); lg.connect(o.frequency); lfo.start(); lfo.stop(c.currentTime + 0.35);
    }
    this.noise({ type: 'bandpass', f0: 700, f1: 2400, q: 1.2, dur: 0.2, gain: 0.1 });
  }
  click() { this.tone({ type: 'square', f0: 1200, f1: 800, dur: 0.03, gain: 0.04, filter: { type: 'lowpass', f: 3000 } }); }

  // ---- the shield: a rise while charging, a hum when full ----
  // The owner's UT2004 charge sample (opt-in) plays once per charge. Ours is two files: "charge" (CHARGE_T long, it ends in the state the loop begins in)
  // and "charged" (a seamless loop), scheduled back to back on the audio clock, so the rise hands over to the hum without a gap or a click; where the
  // charge already is (re-entering mid-charge) picks the point in the rise. Without either, the synth hum follows the charge level.
  setCharge(on, charge = 0) {
    if (!this.ctx || !this.master) return;
    const c = this.ctx, t = c.currentTime;
    const local = this.hasLocal('charge'), ours = !!(this.own.charge && this.own.charge.length && this.own.charged && this.own.charged.length);
    if (local || ours) {
      if (this.hum) this.stopHum(t);
      if (on && this.ready) {
        if (this.chargeSrc) return;
        if (local) this.chargeSrc = [this.playSample(this.sample('charge'), 0.6)];
        else this.startCharge(charge);
      } else this.stopCharge(t);
      return;
    }
    if (this.chargeSrc) this.stopCharge(t);
    if (on && this.ready) {
      if (!this.hum) {
        const g = c.createGain(), lp = c.createBiquadFilter(), o1 = c.createOscillator(), o2 = c.createOscillator(), o3 = c.createOscillator();
        const lfo = c.createOscillator(), lg = c.createGain();
        o1.type = 'sawtooth'; o2.type = 'square'; o3.type = 'sine';
        lp.type = 'lowpass'; lp.Q.value = 4;
        lfo.frequency.value = 9; lg.gain.value = 0.03;
        g.gain.value = 0.0001;
        o1.connect(lp); o2.connect(lp); lp.connect(g); o3.connect(g); g.connect(this.master);
        lfo.connect(lg); lg.connect(g.gain);
        o1.start(); o2.start(); o3.start(); lfo.start();
        this.hum = { g, lp, o1, o2, o3, lfo, lg };
      }
      const h = this.hum, f = 90 + 300 * charge;
      h.o1.frequency.setTargetAtTime(f, t, 0.04);
      h.o2.frequency.setTargetAtTime(f * 1.5, t, 0.04);
      h.o3.frequency.setTargetAtTime(500 + 1900 * charge, t, 0.04);
      h.lp.frequency.setTargetAtTime(500 + 2600 * charge, t, 0.05);
      h.lfo.frequency.setTargetAtTime(7 + 12 * charge, t, 0.05);
      h.g.gain.setTargetAtTime(0.05 + 0.1 * charge, t, 0.03);
    } else if (this.hum) this.stopHum(t);
  }
  startCharge(charge) {
    const rise = this.sample('charge'), hum = this.sample('charged'), gain = 0.6 * OWN_GAIN.charge;
    const at = clamp(charge, 0, 1) * rise.duration, t0 = this.ctx.currentTime + 0.01;   // (a start time on the clock, so the two files meet to the sample)
    const parts = [];
    let loopAt = t0;
    if (at < rise.duration - 0.01) { parts.push(this.playSample(rise, gain, 1, { when: t0, offset: at })); loopAt += rise.duration - at; }
    parts.push(this.playSample(hum, gain, 1, { loop: true, when: loopAt }));
    this.chargeSrc = parts;
  }
  stopCharge(t) {
    const parts = this.chargeSrc;
    if (!parts) return;
    this.chargeSrc = null;
    for (const { s, g } of parts) {
      g.gain.setTargetAtTime(0.0001, t, 0.03);
      try { s.stop(t + 0.2); } catch { /* already ended */ }
    }
  }
  stopHum(t) {
    const h = this.hum;
    if (!h) return;
    this.hum = null;
    h.g.gain.setTargetAtTime(0.0001, t, 0.03);
    const stop = t + 0.25;
    for (const o of [h.o1, h.o2, h.o3, h.lfo]) { try { o.stop(stop); } catch { /* already stopped */ } }
  }

  // ---- per frame ----
  update(dt, st) {
    if (!this.ctx) return;
    if (st && !st.paused && st.grounded && st.speed > 1.5) {
      this.stride += st.speed * dt;
      const len = 2.1 + st.speed * 0.04;
      if (this.stride >= len) { this.stride -= len; this.step(st.speed); }
    } else this.stride = Math.min(this.stride, 1);
  }
}
