// Synthesised WebAudio: no sample files. Everything is oscillators and filtered noise.
//
//   const audio = new GameAudio();
//   audio.unlock()                      create / resume the AudioContext (call it from a click or key press)
//   audio.setVolume(0..1)  audio.mute(bool)
//   audio.jump(combo) doubleJump() dodge() wallDodge() land(speed) blast(charge, hit) checkpoint() finish() respawn() pad() click()
//   audio.setCharge(on, charge)         the shield hum, pitch rises with the charge
//   audio.setAmbient(kind)              theme.ambient: facility | forge | wind | cave | neon | lava | storm | space | null
//   audio.update(dt, { grounded, speed, paused })    footsteps by speed, ambient events
// Every method is a no-op until the context exists, so callers never need to check.
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const rnd = (a, b) => a + Math.random() * (b - a);

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.volume = 0.7;
    this.muted = false;
    this.stride = 0;           // metres walked since the last footstep
    this.foot = 0;
    this.hum = null;
    this.ambient = null;
    this.ambientKind = null;
    this.pendingAmbient = null;
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
      if (this.pendingAmbient) { const k = this.pendingAmbient; this.pendingAmbient = null; this.setAmbient(k); }
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
    this.foot ^= 1;
    this.noise({ type: 'lowpass', f0: this.foot ? 900 : 700, f1: 260, q: 0.8, dur: 0.07, gain: 0.16 * k, buf: 'white' });
    this.tone({ type: 'sine', f0: this.foot ? 95 : 82, f1: 50, dur: 0.07, gain: 0.2 * k });
  }
  jump(combo) {
    this.tone({ type: 'sine', f0: 170, f1: 340, dur: 0.14, gain: 0.16 });
    this.noise({ type: 'bandpass', f0: 500, f1: 1400, q: 0.9, dur: 0.12, gain: 0.07 });
    if (combo) this.tone({ type: 'triangle', f0: 340, f1: 760, dur: 0.18, gain: 0.1 });
  }
  doubleJump() {
    this.tone({ type: 'triangle', f0: 300, f1: 760, dur: 0.2, gain: 0.17 });
    this.tone({ type: 'sine', f0: 600, f1: 1500, dur: 0.16, gain: 0.07, delay: 0.02 });
    this.noise({ type: 'bandpass', f0: 900, f1: 2800, q: 1.4, dur: 0.18, gain: 0.1 });
  }
  dodge() {
    this.noise({ type: 'bandpass', f0: 350, f1: 2000, q: 0.8, dur: 0.24, gain: 0.34, attack: 0.03 });
    this.tone({ type: 'sine', f0: 140, f1: 90, dur: 0.12, gain: 0.12 });
  }
  wallDodge() {
    this.noise({ type: 'bandpass', f0: 500, f1: 2400, q: 0.9, dur: 0.22, gain: 0.3, attack: 0.02 });
    this.tone({ type: 'square', f0: 880, f1: 520, dur: 0.05, gain: 0.07, filter: { type: 'lowpass', f: 2400 } });
    this.tone({ type: 'sine', f0: 120, f1: 60, dur: 0.14, gain: 0.22 });
  }
  land(speed) {
    const k = clamp((speed - 2) / 14, 0.08, 1);
    this.tone({ type: 'sine', f0: 130, f1: 42, dur: 0.17, gain: 0.5 * k });
    this.noise({ type: 'lowpass', f0: 700, f1: 120, q: 0.7, dur: 0.14, gain: 0.3 * k });
  }
  blast(charge, hit) {
    const c = clamp(charge, 0, 1);
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
    this.tone({ type: 'sine', f0: 659.3, dur: 0.5, gain: 0.2, wet: 0.5 });
    this.tone({ type: 'triangle', f0: 659.3 * 2, dur: 0.3, gain: 0.05, wet: 0.5 });
    this.tone({ type: 'sine', f0: 987.8, dur: 0.6, gain: 0.2, delay: 0.09, wet: 0.6 });
    this.tone({ type: 'triangle', f0: 987.8 * 2, dur: 0.35, gain: 0.04, delay: 0.09, wet: 0.5 });
  }
  finish() {
    const notes = [523.3, 659.3, 784, 1046.5];
    notes.forEach((f, i) => {
      this.tone({ type: 'triangle', f0: f, dur: 0.5, gain: 0.2, delay: i * 0.11, wet: 0.5 });
      this.tone({ type: 'square', f0: f, dur: 0.3, gain: 0.05, delay: i * 0.11, filter: { type: 'lowpass', f: 2200 } });
    });
    [523.3, 659.3, 784, 1046.5].forEach((f) => this.tone({ type: 'triangle', f0: f, dur: 1.4, gain: 0.1, delay: 0.5, attack: 0.05, wet: 0.7 }));
    this.noise({ type: 'highpass', f0: 5000, dur: 0.6, gain: 0.05, delay: 0.5, attack: 0.1, wet: 0.5 });
  }
  respawn() {
    this.tone({ type: 'sine', f0: 700, f1: 90, dur: 0.26, gain: 0.2 });
    this.noise({ type: 'bandpass', f0: 2600, f1: 300, q: 1, dur: 0.26, gain: 0.16 });
  }
  pad() {
    const o = this.tone({ type: 'sine', f0: 190, f1: 760, dur: 0.3, gain: 0.3 });
    if (o) {
      const c = this.ctx, lfo = c.createOscillator(), lg = c.createGain();
      lfo.frequency.value = 22; lg.gain.value = 40;
      lfo.connect(lg); lg.connect(o.frequency); lfo.start(); lfo.stop(c.currentTime + 0.35);
    }
    this.noise({ type: 'bandpass', f0: 700, f1: 2400, q: 1.2, dur: 0.2, gain: 0.1 });
  }
  click() { this.tone({ type: 'square', f0: 1200, f1: 800, dur: 0.03, gain: 0.04, filter: { type: 'lowpass', f: 3000 } }); }

  // ---- shield hum: pitch rises with the charge ----
  setCharge(on, charge = 0) {
    if (!this.ctx || !this.master) return;
    const c = this.ctx, t = c.currentTime;
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
    } else if (this.hum) {
      const h = this.hum;
      this.hum = null;
      h.g.gain.setTargetAtTime(0.0001, t, 0.03);
      const stop = t + 0.25;
      for (const o of [h.o1, h.o2, h.o3, h.lfo]) { try { o.stop(stop); } catch { /* already stopped */ } }
    }
  }

  // ---- per frame ----
  update(dt, st) {
    if (!this.ctx) return;
    if (st && !st.paused && st.grounded && st.speed > 1.5) {
      this.stride += st.speed * dt;
      const len = 2.1 + st.speed * 0.04;
      if (this.stride >= len) { this.stride -= len; this.step(st.speed); }
    } else this.stride = Math.min(this.stride, 1);
    if (this.ambient && this.ambient.tick) this.ambient.tick(dt);
  }

  // ---- ambient loops ----
  setAmbient(kind) {
    if (kind === this.ambientKind && this.ambient) return;
    if (!this.ctx) { this.pendingAmbient = kind; return; }
    this.ambientKind = kind;
    const old = this.ambient;
    this.ambient = null;
    if (old) old.stop();
    if (!kind) return;
    const build = AMBIENT[kind] || AMBIENT.facility;
    this.ambient = build(this);
  }

  // a looping noise source through a filter into a gain; returns the nodes so the caller can modulate them
  loopNoise(out, { buf = 'white', type = 'lowpass', f = 400, q = 0.7, gain = 0.1 }) {
    const c = this.ctx;
    const s = c.createBufferSource(), fl = c.createBiquadFilter(), g = c.createGain();
    s.buffer = buf === 'brown' ? this.brown : this.white;
    s.loop = true;
    fl.type = type; fl.frequency.value = f; fl.Q.value = q; g.gain.value = gain;
    s.connect(fl); fl.connect(g); g.connect(out);
    s.start(0, Math.random() * 1.5);
    return { s, f: fl, g };
  }
  loopTone(out, { type = 'sine', f = 100, gain = 0.05, detune = 0 }) {
    const c = this.ctx;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.value = f; o.detune.value = detune; g.gain.value = gain;
    o.connect(g); g.connect(out);
    o.start();
    return { o, g };
  }
  // slow LFO on an AudioParam
  lfo(param, rate, depth) {
    const c = this.ctx;
    const o = c.createOscillator(), g = c.createGain();
    o.frequency.value = rate; g.gain.value = depth;
    o.connect(g); g.connect(param); o.start();
    if (this.sink) this.sink.push(o);   // stopped together with the ambient bed that created it
    return o;
  }
}

// ---- ambient builders: return { stop(), tick(dt) } ----
function bed(a, build) {
  const c = a.ctx, out = c.createGain(), srcs = [], events = [];
  out.gain.value = 0.0001;
  out.connect(a.master);
  out.gain.setTargetAtTime(0.55, c.currentTime, 0.8);
  const track = (n) => { if (n) srcs.push(n); return n; };
  a.sink = srcs;
  build({ out, track, event: (every, fn) => events.push({ t: rnd(1, every[1]), every, fn }) });
  a.sink = null;
  return {
    tick(dt) {
      if (!a.ready) return;
      for (const e of events) { e.t -= dt; if (e.t <= 0) { e.t = rnd(e.every[0], e.every[1]); e.fn(); } }
    },
    stop() {
      out.gain.setTargetAtTime(0.0001, c.currentTime, 0.3);
      setTimeout(() => {
        for (const s of srcs) { try { (s.s || s.o || s).stop(); } catch { /* ignore */ } }
        out.disconnect();
      }, 1500);
    },
  };
}

const AMBIENT = {
  facility: (a) => bed(a, ({ out, track, event }) => {
    track(a.loopNoise(out, { buf: 'brown', type: 'lowpass', f: 220, gain: 0.5 }));
    track(a.loopTone(out, { f: 60, gain: 0.035 }));
    track(a.loopTone(out, { f: 120.4, gain: 0.014 }));
    track(a.loopNoise(out, { type: 'bandpass', f: 2600, q: 3, gain: 0.006 }));
    event([6, 14], () => a.tone({ type: 'sine', f0: 90, f1: 55, dur: 0.5, gain: 0.07, wet: 0.5 }));
  }),
  forge: (a) => bed(a, ({ out, track, event }) => {
    track(a.loopNoise(out, { buf: 'brown', type: 'lowpass', f: 140, gain: 0.9 }));
    track(a.loopNoise(out, { type: 'highpass', f: 3500, gain: 0.004 }));
    event([0.3, 1.1], () => a.noise({ type: 'highpass', f0: 3500, dur: 0.05, gain: 0.05 }));
    event([8, 16], () => {
      [520, 780, 1390].forEach((f, i) => a.tone({ type: 'sine', f0: f, dur: 0.9 - i * 0.2, gain: 0.05 / (i + 1), wet: 0.6 }));
    });
  }),
  wind: (a) => bed(a, ({ out, track }) => {
    const n = track(a.loopNoise(out, { type: 'bandpass', f: 600, q: 0.6, gain: 0.17 }));
    a.lfo(n.f.frequency, 0.11, 220); a.lfo(n.g.gain, 0.17, 0.07);
    const n2 = track(a.loopNoise(out, { type: 'bandpass', f: 1400, q: 1.2, gain: 0.05 }));
    a.lfo(n2.g.gain, 0.23, 0.03);
  }),
  cave: (a) => bed(a, ({ out, track, event }) => {
    track(a.loopTone(out, { f: 55, gain: 0.05 }));
    track(a.loopTone(out, { f: 82.4, gain: 0.025 }));
    track(a.loopNoise(out, { buf: 'brown', type: 'lowpass', f: 160, gain: 0.35 }));
    event([1.8, 5.5], () => a.tone({ type: 'sine', f0: rnd(900, 1500), f1: rnd(500, 800), dur: 0.09, gain: 0.07, wet: 0.7 }));
  }),
  neon: (a) => bed(a, ({ out, track, event }) => {
    const sawL = track(a.loopTone(out, { type: 'sawtooth', f: 55, gain: 0.02 }));
    void sawL;
    [220, 261.6, 329.6].forEach((f, i) => { const t = track(a.loopTone(out, { type: 'triangle', f, gain: 0.012, detune: i * 4 })); a.lfo(t.g.gain, 0.07 + i * 0.03, 0.008); });
    track(a.loopNoise(out, { type: 'highpass', f: 5200, gain: 0.006 }));
    event([1.5, 5], () => a.noise({ type: 'highpass', f0: 4000, dur: 0.06, gain: 0.05 }));
  }),
  lava: (a) => bed(a, ({ out, track, event }) => {
    track(a.loopNoise(out, { buf: 'brown', type: 'lowpass', f: 90, gain: 1.1 }));
    const b = track(a.loopNoise(out, { type: 'bandpass', f: 220, q: 1.5, gain: 0.05 }));
    a.lfo(b.g.gain, 0.6, 0.04);
    event([0.4, 1.6], () => a.tone({ type: 'sine', f0: rnd(110, 190), f1: 55, dur: 0.1, gain: 0.07 }));
    event([0.2, 0.8], () => a.noise({ type: 'highpass', f0: 3000, dur: 0.04, gain: 0.04 }));
  }),
  storm: (a) => bed(a, ({ out, track, event }) => {
    const n = track(a.loopNoise(out, { type: 'bandpass', f: 500, q: 0.5, gain: 0.2 }));
    a.lfo(n.f.frequency, 0.09, 200); a.lfo(n.g.gain, 0.14, 0.08);
    track(a.loopNoise(out, { type: 'highpass', f: 3200, gain: 0.05 }));
    event([10, 24], () => a.noise({ type: 'lowpass', f0: 260, f1: 50, q: 0.7, dur: 2.6, gain: 0.5, attack: 0.15, buf: 'brown', wet: 0.4 }));
  }),
  space: (a) => bed(a, ({ out, track }) => {
    track(a.loopTone(out, { f: 40, gain: 0.07 }));
    track(a.loopTone(out, { f: 40.4, gain: 0.07 }));
    const p = track(a.loopTone(out, { type: 'sine', f: 330, gain: 0.012 }));
    a.lfo(p.g.gain, 0.05, 0.008);
    const p2 = track(a.loopTone(out, { type: 'sine', f: 495.5, gain: 0.008 }));
    a.lfo(p2.g.gain, 0.04, 0.006);
    track(a.loopNoise(out, { type: 'bandpass', f: 2000, q: 2, gain: 0.003 }));
  }),
};
