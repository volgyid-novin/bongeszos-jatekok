// Synthesised sound effects for HÁGÓ (no audio files): oscillators, filtered noise, simple FM and
// brass-like stabs. Comic-book style: short, exaggerated, readable. Every call goes through its own
// bus (gain = k, optional stereo panner) -> master -> compressor -> speakers.

// minimum seconds between two plays of the same sound (default 0.04) so big fights don't become noise
const GAP = {
  hover: 0.05, click: 0.03, buy: 0.1, error: 0.15,
  melee: 0.05, blunt: 0.06, dagger: 0.04, arrow: 0.05, arrowHit: 0.05, bolt: 0.05, boltHit: 0.05,
  minionHit: 0.07, cannon: 0.12, minionDie: 0.06, gold: 0.05, crit: 0.06, stun: 0.1,
  spin: 1.2, quake: 0.3, slam: 0.3, leap: 0.3, flameWall: 0.3, breath: 0.3, meteorFall: 0.4, meteorImpact: 0.3,
  arrowRain: 0.3, stormCharge: 0.3, moonDance: 0.8, blades: 0.2, recall: 0.5,
  towerShot: 0.12, towerHit: 0.1, towerDown: 0.8, nexusDown: 2, heroDie: 0.15, kill: 0.25, allyDie: 0.3,
  levelUp: 0.3, heal: 0.15, potion: 0.2, bossRoar: 0.6, bossSlam: 0.3, bossDie: 1, announce: 0.4,
  victory: 3, defeat: 3, fountainZap: 0.08,
};
// musical stingers get only a tiny random detune, effects get +-5%
const MUSIC = new Set(['buy', 'kill', 'allyDie', 'levelUp', 'announce', 'victory', 'defeat', 'reset', 'heal', 'relic', 'respawn']);
const R = () => 0.9 + Math.random() * 0.2;
const rnd = (a, b) => a + Math.random() * (b - a);

export class Sound {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.vol = 0.55;
    this.last = {};
    this.live = {};
    this.bus = null;
    this.p = 1;
  }
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); return; }
    try {
      const ctx = (this.ctx = new (window.AudioContext || window.webkitAudioContext)());
      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : this.vol;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -16; comp.knee.value = 8; comp.ratio.value = 4;
      comp.attack.value = 0.003; comp.release.value = 0.2;
      this.master.connect(comp).connect(ctx.destination);
      const len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.noiseBuf = buf;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    } catch { this.ctx = null; }
  }
  setMuted(m) { this.muted = !!m; this.apply(); }
  setVolume(v) { this.vol = Math.min(1, Math.max(0, +v || 0)); this.apply(); }
  apply() {
    try { if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : this.vol, this.ctx.currentTime, 0.02); } catch {}
  }
  // Optional: fade out the latest instance of a long sound (e.g. an interrupted recall or spin).
  stop(kind) {
    const b = this.live[kind];
    delete this.live[kind];
    try { if (b && this.ctx) b.gain.setTargetAtTime(0, this.ctx.currentTime, 0.04); } catch {}
  }

  // ---- building blocks (frequencies are scaled by this.p, the per-call random detune) ----
  // gain envelope: 0.0001 -> vol in atk, optionally held (~70%) until sus*dur, then exponential decay to dur
  env(t0, dur, vol, atk, sus, out) {
    const g = this.ctx.createGain(), a = Math.min(atk, dur * 0.8), v = Math.max(0.0002, vol);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(v, t0 + a);
    if (sus > 0) g.gain.exponentialRampToValueAtTime(v * 0.7, t0 + Math.max(a + 0.005, dur * sus));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    g.connect(out || this.bus);
    return g;
  }
  osc(type, f0, f1, t0, dur, vol, atk = 0.006, out = null, sus = 0) {
    const o = this.ctx.createOscillator(), p = this.p;
    o.type = type;
    o.frequency.setValueAtTime(f0 * p, t0);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1 * p), t0 + dur);
    o.connect(this.env(t0, dur, vol, atk, sus, out));
    o.start(t0); o.stop(t0 + dur + 0.02);
    return o;
  }
  noise(filter, f0, f1, q, t0, dur, vol, atk = 0.005, out = null, sus = 0) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf; s.loop = true;
    s.playbackRate.value = 0.8 + Math.random() * 0.4;
    s.connect(this.filt(filter, f0 * this.p, f1 * this.p, q, t0, dur, this.env(t0, dur, vol, atk, sus, out)));
    s.start(t0, Math.random() * 1.5); s.stop(t0 + dur + 0.02);
  }
  filt(type, f0, f1, q, t0, dur, out = null) {
    const f = this.ctx.createBiquadFilter();
    f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(f0, t0);
    if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    f.connect(out || this.bus);
    return f;
  }
  // FM: a modulator at f*ratio swings the carrier by index*f*ratio Hz; the brightness fades over the sound
  fm(type, f0, f1, ratio, index, t0, dur, vol, atk = 0.006, out = null, sus = 0) {
    const c = this.ctx, m = c.createOscillator(), mg = c.createGain(), p = this.p;
    m.frequency.setValueAtTime(f0 * p * ratio, t0);
    if (f1 !== f0) m.frequency.exponentialRampToValueAtTime(Math.max(1, f1 * p * ratio), t0 + dur);
    mg.gain.setValueAtTime(f0 * p * ratio * index, t0);
    mg.gain.linearRampToValueAtTime(f1 * p * ratio * index * 0.3, t0 + dur);
    const o = this.osc(type, f0, f1, t0, dur, vol, atk, out, sus);
    m.connect(mg).connect(o.frequency);
    m.start(t0); m.stop(t0 + dur + 0.02);
    return o;
  }
  chord(type, fs, t0, dur, vol, atk = 0.006, out = null, sus = 0) {
    for (const f of fs) this.osc(type, f, f, t0, dur, vol, atk, out, sus);
  }
  // brass-like stab: detuned saw pairs through a lowpass moving c0 -> c1; bend slides the pitch
  brass(fs, t0, dur, vol, sus = 0.5, c0 = 3000, c1 = 900, bend = 1) {
    const lp = this.filt('lowpass', c0, c1, 1.2, t0, dur), os = [];
    for (const f of fs) {
      os.push(this.osc('sawtooth', f, f * bend, t0, dur, vol, 0.012, lp, sus));
      os.push(this.osc('sawtooth', f * 1.006, f * 1.006 * bend, t0, dur, vol * 0.6, 0.02, lp, sus));
    }
    return os;
  }
  lfo(param, rate, depth, t0, dur) {
    const c = this.ctx, o = c.createOscillator(), g = c.createGain();
    o.frequency.value = rate; g.gain.value = depth;
    o.connect(g).connect(param);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }
  // n short noise ticks scattered over span seconds (debris, fire crackle, rain patter)
  bits(n, t0, span, lo, hi, vol, filter = 'bandpass', q = 3, dur = 0.05) {
    for (let i = 0; i < n; i++) {
      const f = rnd(lo, hi);
      this.noise(filter, f, f * 0.8, q, t0 + Math.random() * span, dur * rnd(0.6, 1.4), vol * rnd(0.6, 1));
    }
  }

  // k: 0..1 loudness (caller does distance falloff); pan: -1..1 stereo position
  play(kind, k = 1, pan = 0) {
    if (!this.ctx || this.muted || !(k > 0.02)) return;
    try {
      const c = this.ctx, now = c.currentTime, prev = this.last[kind];
      if (prev !== undefined && now - prev < (GAP[kind] || 0.04)) return;
      const bus = c.createGain();
      bus.gain.value = Math.min(1, k);
      if (pan && c.createStereoPanner) {
        const sp = c.createStereoPanner();
        sp.pan.value = Math.max(-1, Math.min(1, pan));
        bus.connect(sp).connect(this.master);
      } else bus.connect(this.master);
      this.bus = bus;
      this.p = 1 + (Math.random() - 0.5) * (MUSIC.has(kind) ? 0.02 : 0.1);
      if (!this.fx(kind, now + 0.005)) { bus.disconnect(); return; }
      this.last[kind] = now;
      this.live[kind] = bus;
    } catch { /* a sound must never break the game */ }
  }

  fx(kind, t) {
    switch (kind) {
      // ---- UI ----
      case 'click':
        this.osc('triangle', 1500, 950, t, 0.035, 0.09);
        this.osc('square', 3000, 2600, t, 0.012, 0.015);
        break;
      case 'hover':
        this.osc('sine', 2300, 2100, t, 0.025, 0.025);
        break;
      case 'buy':
        this.noise('bandpass', 1800, 1500, 3, t, 0.035, 0.3);
        this.osc('sine', 1568, 1568, t + 0.02, 0.09, 0.07);
        this.noise('highpass', 5500, 4000, 1, t + 0.07, 0.13, 0.16);
        this.chord('sine', [2093, 2637], t + 0.12, 0.5, 0.05, 0.004);
        this.osc('triangle', 4186, 4186, t + 0.12, 0.3, 0.015);
        break;
      case 'error': {
        const lp = this.filt('lowpass', 1100, 700, 1, t, 0.3);
        for (const d of [0, 0.11]) {
          this.osc('square', 150, 140, t + d, 0.09, 0.07, 0.004, lp, 0.6);
          this.osc('sawtooth', 157, 146, t + d, 0.09, 0.05, 0.004, lp, 0.6);
        }
        break;
      }
      // ---- basic attacks ----
      case 'melee':
        this.noise('bandpass', 1300 * R(), 3600, 1.5, t, 0.11, 0.32, 0.03);
        this.noise('bandpass', 3200, 2400, 3, t + 0.06, 0.06, 0.25);
        this.osc('triangle', 2600 * R(), 2450, t + 0.06, 0.14, 0.06);
        this.osc('square', 3900 * R(), 3800, t + 0.06, 0.04, 0.015);
        break;
      case 'blunt':
        this.osc('sine', 150 * R(), 48, t, 0.22, 0.45);
        this.noise('lowpass', 1300, 200, 1, t, 0.18, 0.5);
        this.noise('bandpass', 900 * R(), 600, 2.5, t + 0.01, 0.08, 0.35);
        this.osc('triangle', 230, 110, t, 0.1, 0.14);
        break;
      case 'dagger':
        this.noise('bandpass', 2600 * R(), 5200, 2, t, 0.07, 0.28, 0.02);
        this.osc('triangle', 3300 * R(), 3000, t + 0.04, 0.05, 0.03);
        break;
      case 'arrow':
        this.osc('triangle', 330 * R(), 270, t, 0.14, 0.14);
        this.osc('sawtooth', 660 * R(), 540, t, 0.06, 0.025);
        this.noise('bandpass', 3200, 1400, 1.2, t + 0.01, 0.16, 0.18, 0.02);
        break;
      case 'arrowHit':
        this.osc('sine', 430 * R(), 170, t, 0.07, 0.28);
        this.noise('bandpass', 750 * R(), 600, 3, t, 0.05, 0.32);
        this.osc('triangle', 950, 620, t, 0.035, 0.05);
        break;
      case 'bolt':
        this.noise('bandpass', 1800 * R(), 4800, 1, t, 0.18, 0.22, 0.02);
        this.fm('sine', 500 * R(), 1300, 2.7, 2, t, 0.16, 0.06);
        this.bits(4, t, 0.15, 3500, 7000, 0.1, 'highpass', 1, 0.02);
        break;
      case 'boltHit':
        this.noise('lowpass', 3200, 400, 1, t, 0.16, 0.38);
        this.osc('sine', 420 * R(), 120, t, 0.1, 0.16);
        this.noise('highpass', 6000, 4000, 1, t + 0.02, 0.12, 0.12, 0.01);
        break;
      case 'minionHit':
        this.noise('bandpass', 950 * R(), 650, 2, t, 0.04, 0.2);
        break;
      case 'cannon':
        this.osc('sine', 125 * R(), 40, t, 0.3, 0.42);
        this.noise('lowpass', 2200, 180, 0.8, t, 0.32, 0.55);
        this.noise('highpass', 2500, 2000, 1, t, 0.035, 0.25);
        break;
      // ---- GRANIT ----
      case 'charge':
        this.noise('bandpass', 450, 1800, 1.2, t, 0.22, 0.35, 0.16);
        this.fm('triangle', 620 * R(), 600, 1.41, 3.5, t + 0.2, 0.5, 0.09);
        this.chord('triangle', [1214, 2376], t + 0.2, 0.3, 0.025);
        this.noise('highpass', 3200, 2400, 1, t + 0.2, 0.08, 0.38);
        this.osc('sine', 170, 60, t + 0.2, 0.16, 0.35);
        break;
      case 'quake':
        this.noise('lowpass', 450, 140, 1, t, 0.6, 0.6, 0.03);
        this.osc('sine', 62, 34, t, 0.55, 0.38, 0.02);
        this.bits(9, t, 0.5, 500, 1600, 0.28, 'bandpass', 2.5, 0.06);
        break;
      case 'shield':
        [880, 1175, 1480, 1975].forEach((f, i) => this.osc('sine', f, f * 1.3, t + i * 0.05, 0.4, 0.045, 0.02));
        this.noise('bandpass', 3000, 7500, 4, t, 0.38, 0.08, 0.12);
        this.osc('triangle', 300, 240, t, 0.05, 0.1);
        break;
      case 'taunt': {
        const lp = this.filt('lowpass', 950, 380, 2, t, 0.55);
        this.fm('sawtooth', 96, 70, 0.32, 0.8, t, 0.55, 0.16, 0.05, lp, 0.5);
        this.osc('sawtooth', 99, 72, t, 0.55, 0.11, 0.05, lp, 0.5);
        this.osc('square', 48, 36, t, 0.5, 0.08, 0.05, lp, 0.5);
        this.noise('bandpass', 420, 260, 2, t, 0.5, 0.18, 0.05);
        break;
      }
      case 'spin': {
        const lp = this.filt('lowpass', 420, 420, 2, t, 2);
        this.osc('sawtooth', 62, 74, t, 2, 0.07, 0.2, lp, 0.85);
        for (let i = 0; i < 8; i++) this.noise('bandpass', 600 * R(), 1700 * R(), 1.4, t + i * 0.25, 0.24, i < 6 ? 0.32 : 0.32 - (i - 5) * 0.08, 0.12);
        break;
      }
      case 'leap':
        this.osc('sine', 120, 55, t, 0.1, 0.25);
        this.noise('bandpass', 300, 2600, 1.2, t, 0.6, 0.42, 0.18);
        this.osc('sine', 140, 460, t, 0.5, 0.07, 0.12);
        break;
      case 'slam':
        this.osc('sine', 95 * R(), 28, t, 0.9, 0.6);
        this.osc('triangle', 190, 60, t, 0.3, 0.28);
        this.noise('lowpass', 1600, 90, 0.8, t, 0.8, 0.75);
        this.noise('highpass', 2600, 1800, 1, t, 0.05, 0.3);
        this.bits(8, t + 0.04, 0.45, 500, 2200, 0.2);
        break;
      case 'stoneSkin':
        this.noise('bandpass', 1500, 1300, 4, t, 0.03, 0.18);
        this.osc('triangle', 260, 230, t, 0.06, 0.1);
        this.osc('sine', 1320, 1320, t + 0.03, 0.35, 0.05);
        this.osc('sine', 1980, 1980, t + 0.05, 0.28, 0.025);
        break;
      // ---- PARÁZS ----
      case 'fireball': {
        const lp = this.filt('lowpass', 700, 700, 1, t, 0.3);
        this.noise('bandpass', 400, 1700, 1, t, 0.35, 0.38, 0.06);
        this.osc('sawtooth', 110 * R(), 210, t, 0.3, 0.07, 0.04, lp);
        this.bits(6, t, 0.3, 3500, 7000, 0.15, 'highpass', 1, 0.02);
        break;
      }
      case 'explode':
        this.noise('lowpass', 2600, 150, 0.8, t, 0.6, 0.7);
        this.osc('sine', 115 * R(), 40, t, 0.5, 0.42);
        this.noise('bandpass', 900, 300, 1, t + 0.03, 0.5, 0.25, 0.03);
        this.bits(6, t + 0.05, 0.35, 3000, 6500, 0.1, 'highpass', 1, 0.025);
        break;
      case 'flameWall': {
        const lp = this.filt('lowpass', 420, 420, 1.5, t, 0.8);
        this.noise('lowpass', 600, 2400, 0.8, t, 0.8, 0.5, 0.08, null, 0.6);
        this.noise('bandpass', 320, 260, 1, t, 0.8, 0.35, 0.06, null, 0.6);
        this.osc('sawtooth', 60, 92, t, 0.75, 0.1, 0.08, lp, 0.5);
        this.bits(9, t + 0.05, 0.65, 3000, 7000, 0.13, 'highpass', 1, 0.025);
        break;
      }
      case 'blink':
        this.fm('sine', 800 * R(), 3000, 1.5, 1.5, t, 0.12, 0.1);
        this.osc('sine', 3520, 3300, t + 0.05, 0.15, 0.035);
        this.noise('bandpass', 4200, 6000, 2, t, 0.08, 0.15);
        this.osc('sine', 700, 260, t, 0.05, 0.12);
        break;
      case 'stunRing':
        this.fm('sine', 300 * R(), 1500, 2.01, 2, t, 0.56, 0.06, 0.48);
        this.noise('bandpass', 900, 5200, 3, t, 0.56, 0.14, 0.48);
        this.noise('highpass', 2200, 800, 0.8, t + 0.55, 0.16, 0.5);
        this.osc('square', 1300, 200, t + 0.55, 0.08, 0.06);
        this.osc('sine', 160, 50, t + 0.55, 0.25, 0.35);
        break;
      case 'breath': {
        const lp = this.filt('lowpass', 520, 520, 1.5, t, 0.6);
        this.noise('bandpass', 500, 1200, 0.8, t, 0.6, 0.5, 0.05, null, 0.6);
        this.noise('lowpass', 2200, 1600, 0.7, t, 0.6, 0.22, 0.05, null, 0.6);
        this.osc('sawtooth', 82, 64, t, 0.6, 0.11, 0.05, lp, 0.6);
        this.bits(5, t + 0.05, 0.5, 3000, 6500, 0.12, 'highpass', 1, 0.025);
        break;
      }
      case 'meteorFall':
        this.lfo(this.osc('sine', 2300, 520, t, 1.2, 0.09, 0.9).frequency, 7, 25, t, 1.2);
        this.noise('bandpass', 3200, 800, 6, t, 1.2, 0.18, 0.9);
        this.noise('lowpass', 200, 650, 1, t, 1.2, 0.25, 1.0);
        break;
      case 'meteorImpact':
        this.osc('sine', 85, 25, t, 1.4, 0.62);
        this.noise('lowpass', 3200, 60, 0.7, t, 1.5, 0.8);
        this.noise('highpass', 2200, 1500, 1, t, 0.06, 0.4);
        this.osc('triangle', 170, 50, t, 0.4, 0.3);
        this.noise('lowpass', 320, 80, 1, t + 0.1, 1.4, 0.4, 0.1);
        this.bits(7, t + 0.05, 0.7, 400, 2000, 0.2);
        break;
      case 'overheat': {
        const lp = this.filt('lowpass', 600, 600, 1, t, 0.3);
        this.noise('bandpass', 300, 2100, 1, t, 0.3, 0.42, 0.07);
        this.osc('sawtooth', 90, 190, t, 0.26, 0.08, 0.05, lp);
        this.bits(3, t + 0.08, 0.2, 3500, 6500, 0.12, 'highpass', 1, 0.02);
        break;
      }
      // ---- SÓLYOM ----
      case 'pierce': {
        const lp = this.filt('lowpass', 2200, 900, 1, t, 0.15);
        this.osc('triangle', 285 * R(), 215, t, 0.22, 0.18);
        this.osc('sawtooth', 570, 430, t, 0.12, 0.06, 0.004, lp);
        this.noise('highpass', 3000, 2500, 1, t, 0.03, 0.4);
        this.noise('bandpass', 3600, 1100, 1.1, t + 0.01, 0.26, 0.26, 0.02);
        this.osc('sine', 125, 70, t, 0.08, 0.2);
        break;
      }
      case 'arrowRain':
        for (let i = 0; i < 8; i++) this.osc('sine', rnd(2400, 3300), rnd(1300, 1700), t + i * 0.045, 0.26, 0.025, 0.05);
        this.bits(12, t + 0.36, 0.42, 1100, 2800, 0.2, 'bandpass', 3, 0.03);
        break;
      case 'roll':
        this.noise('bandpass', 600, 1500, 1, t, 0.12, 0.3, 0.05);
        this.noise('bandpass', 950, 450, 1, t + 0.1, 0.14, 0.26, 0.05);
        this.osc('sine', 150, 80, t + 0.2, 0.08, 0.16);
        break;
      case 'trapSet':
        for (const [d, f] of [[0, 2600], [0.09, 2100]]) {
          this.noise('bandpass', f, f, 5, t + d, 0.025, 0.32);
          this.osc('square', f * 0.7, f * 0.6, t + d, 0.02, 0.03);
        }
        this.osc('triangle', 600, 900, t + 0.04, 0.06, 0.04);
        break;
      case 'trapSnap':
        this.noise('highpass', 2200, 1600, 1, t, 0.04, 0.6);
        this.osc('square', 950, 300, t, 0.05, 0.08);
        this.fm('triangle', 1100 * R(), 1050, 1.41, 3, t + 0.01, 0.4, 0.08);
        this.osc('sine', 190, 70, t, 0.1, 0.25);
        break;
      case 'falcon':
        this.fm('sine', 1800, 2900, 0.5, 0.6, t, 0.07, 0.07, 0.01);
        this.lfo(this.fm('sine', 3000 * R(), 1800, 0.5, 0.7, t + 0.06, 0.36, 0.09, 0.02, null, 0.4).frequency, 22, 60, t + 0.06, 0.36);
        this.noise('bandpass', 3200, 2200, 3, t + 0.04, 0.32, 0.05, 0.03);
        break;
      case 'stormCharge':
        this.fm('sine', 400, 1600, 3.01, 2, t, 0.6, 0.05, 0.5);
        this.lfo(this.osc('sawtooth', 110, 420, t, 0.6, 0.04, 0.45).frequency, 30, 25, t, 0.6);
        this.bits(7, t, 0.55, 4000, 8000, 0.13, 'highpass', 1, 0.015);
        break;
      case 'stormArrow':
        for (let i = 0; i < 4; i++) this.osc('sawtooth', rnd(400, 1800), rnd(200, 700), t + i * 0.03, 0.06, 0.06);
        this.noise('highpass', 3000, 6000, 1, t, 0.2, 0.22);
        this.noise('bandpass', 2600, 600, 1, t + 0.02, 0.45, 0.38, 0.03);
        this.osc('triangle', 270, 200, t, 0.15, 0.12);
        break;
      case 'stormHit':
        this.noise('highpass', 1600, 1200, 0.8, t, 0.06, 0.6);
        this.noise('lowpass', 2200, 90, 0.7, t + 0.02, 0.8, 0.55);
        this.osc('sine', 72, 34, t, 0.6, 0.35);
        for (let i = 0; i < 3; i++) this.osc('sawtooth', rnd(500, 2000), rnd(150, 500), t + i * 0.035, 0.05, 0.05);
        break;
      case 'crit':
        this.noise('highpass', 2600, 1500, 1, t, 0.08, 0.45);
        this.osc('square', 1700, 1200, t, 0.05, 0.05);
        this.fm('sine', 1900 * R(), 1850, 1.41, 2, t, 0.22, 0.06);
        this.osc('sine', 210, 70, t, 0.12, 0.32);
        break;
      // ---- ÁRNY ----
      case 'throwDagger':
        for (let i = 0; i < 4; i++) this.noise('bandpass', 1900 + i * 350, 2600 + i * 300, 2, t + i * 0.045, 0.05, 0.2, 0.02);
        break;
      case 'smoke':
        this.noise('lowpass', 1300, 280, 1, t, 0.16, 0.5);
        this.osc('sine', 190, 75, t, 0.1, 0.2);
        this.noise('highpass', 4200, 2600, 0.8, t + 0.03, 0.57, 0.15, 0.08);
        break;
      case 'shadowStep': // swells then cuts off = a reversed whoosh
        this.noise('bandpass', 400, 1700, 1.5, t, 0.3, 0.36, 0.26);
        this.osc('sine', 80, 170, t, 0.3, 0.14, 0.25);
        this.osc('sine', 230, 85, t + 0.28, 0.09, 0.16);
        break;
      case 'blades':
        for (let i = 0; i < 5; i++) {
          const d = t + i * 0.075;
          this.noise('bandpass', rnd(2400, 3800), 1900, 2, d, 0.06, 0.22, 0.015);
          this.osc('triangle', rnd(2900, 3600), 2800, d + 0.03, 0.04, 0.03);
        }
        break;
      case 'clone':
        this.fm('sine', 700, 1000, 1.5, 1.5, t, 0.45, 0.055, 0.1);
        this.osc('sine', 990, 1480, t, 0.45, 0.035, 0.15);
        this.osc('sine', 1004, 1460, t, 0.45, 0.03, 0.15);
        this.noise('bandpass', 5000, 3000, 6, t, 0.4, 0.06, 0.1);
        break;
      case 'moonDance':
        for (let i = 0; i < 5; i++) {
          const d = t + i * 0.25, big = i === 4;
          this.noise('bandpass', 1400 * R(), 4600, 1.5, d, big ? 0.16 : 0.12, big ? 0.4 : 0.3, 0.04);
          this.osc('triangle', 2700 + i * 160, 2550 + i * 160, d + 0.08, 0.12, 0.05);
          if (big) { this.osc('sine', 180, 60, d + 0.08, 0.2, 0.32); this.fm('sine', 1320, 1320, 2, 1, d + 0.08, 0.5, 0.05); }
        }
        break;
      case 'mark':
        this.fm('sine', 660, 640, 1.5, 1, t, 0.3, 0.06);
        this.osc('sine', 330, 320, t, 0.25, 0.05);
        this.noise('bandpass', 900, 700, 2, t, 0.04, 0.12);
        break;
      case 'reset':
        this.osc('sine', 1568, 1568, t, 0.15, 0.08);
        this.osc('sine', 2349, 2349, t + 0.08, 0.28, 0.08);
        this.osc('triangle', 3136, 3136, t + 0.08, 0.18, 0.02);
        break;
      // ---- world / game ----
      case 'towerShot': {
        const lp = this.filt('lowpass', 1800, 400, 1.5, t, 0.35);
        this.osc('sawtooth', 220, 80, t, 0.35, 0.15, 0.01, lp);
        this.fm('sine', 520 * R(), 200, 2, 3, t, 0.3, 0.1);
        this.noise('bandpass', 1500, 500, 1, t, 0.3, 0.3, 0.02);
        this.osc('sine', 95, 45, t, 0.25, 0.3);
        break;
      }
      case 'towerHit':
        this.noise('lowpass', 3000, 300, 1, t, 0.3, 0.45);
        this.osc('sine', 210, 60, t, 0.25, 0.3);
        this.fm('sine', 900 * R(), 300, 1.5, 2, t, 0.2, 0.07);
        this.noise('highpass', 5000, 3500, 1, t + 0.02, 0.2, 0.1, 0.01);
        break;
      case 'towerDown':
        this.noise('highpass', 2000, 1500, 1, t, 0.08, 0.3);
        this.noise('lowpass', 650, 60, 0.8, t, 1.6, 0.75, 0.05);
        this.osc('sine', 58, 28, t, 1.4, 0.42, 0.03);
        this.osc('sine', 72, 34, t + 0.6, 0.5, 0.3);
        this.noise('lowpass', 900, 100, 1, t + 0.6, 0.5, 0.4);
        this.bits(12, t + 0.05, 1.35, 400, 2000, 0.2, 'bandpass', 3, 0.07);
        break;
      case 'nexusDown':
        this.osc('sine', 72, 22, t, 2.0, 0.62);
        this.noise('lowpass', 3000, 50, 0.7, t, 2.5, 0.75);
        this.osc('triangle', 200, 50, t, 0.6, 0.28);
        this.noise('highpass', 4000, 3000, 1, t, 0.6, 0.28);
        for (let i = 0; i < 14; i++) this.osc('sine', rnd(2000, 6000), rnd(1800, 5500), t + Math.random() * 0.7, rnd(0.2, 0.5), 0.03);
        this.fm('sine', 1200, 1150, 2.76, 1, t + 0.05, 2.4, 0.04, 0.02, null, 0.3);
        this.bits(8, t + 0.1, 1.6, 400, 1800, 0.18);
        break;
      case 'minionDie':
        this.osc('sine', 230 * R(), 80, t, 0.1, 0.18);
        this.noise('lowpass', 900, 200, 1, t, 0.1, 0.25);
        break;
      case 'heroDie': {
        const lp = this.filt('lowpass', 2000, 400, 1, t, 0.9);
        this.noise('bandpass', 1800, 400, 1, t, 0.25, 0.5);
        this.osc('sine', 155, 45, t, 0.35, 0.45);
        this.osc('sawtooth', 520, 90, t, 0.9, 0.08, 0.02, lp, 0.4);
        this.osc('triangle', 780, 135, t, 0.9, 0.04, 0.02, null, 0.4);
        break;
      }
      case 'kill':
        this.brass([392, 494, 587], t, 0.1, 0.05, 0);
        this.brass([523, 659, 784], t + 0.1, 0.5, 0.05, 0.5, 3500, 900);
        this.osc('sine', 2093, 2093, t + 0.1, 0.35, 0.03);
        break;
      case 'allyDie':
        this.brass([392, 466], t, 0.16, 0.05, 0, 1800, 800);
        this.brass([370, 440], t + 0.16, 0.5, 0.05, 0.5, 1600, 500, 0.9);
        break;
      case 'levelUp':
        [523, 659, 784, 1046, 1318].forEach((f, i) => {
          this.osc('triangle', f, f, t + i * 0.08, i === 4 ? 0.6 : 0.3, 0.07);
          this.osc('sine', f * 2, f * 2, t + i * 0.08, 0.25, 0.02);
        });
        this.noise('highpass', 7000, 6000, 1, t + 0.25, 0.45, 0.05, 0.05);
        break;
      case 'gold':
        this.fm('sine', 2400 * R(), 2400, 1.41, 0.6, t, 0.18, 0.05);
        this.osc('sine', 3200, 3200, t + 0.03, 0.1, 0.025);
        break;
      case 'recall':
        this.lfo(this.osc('sine', 330, 990, t, 4, 0.05, 0.3, null, 0.9).frequency, 5, 8, t, 4);
        this.osc('sine', 495, 1485, t, 4, 0.03, 2.5, null, 0.9);
        this.noise('bandpass', 1500, 6000, 4, t, 4, 0.1, 3.4);
        for (let i = 0; i < 16; i++) {
          const f = rnd(1500, 3000) * (1 + i / 16);
          this.osc('sine', f, f, t + i * 0.24 + Math.random() * 0.1, 0.25, 0.012 + 0.025 * i / 16);
        }
        break;
      case 'recallDone':
        this.noise('bandpass', 3000, 400, 1, t, 0.4, 0.4, 0.02);
        this.fm('sine', 2000, 400, 1.5, 2, t, 0.3, 0.07);
        this.osc('sine', 150, 60, t + 0.05, 0.2, 0.25);
        break;
      case 'heal':
        [880, 1108, 1318].forEach((f, i) => this.osc('sine', f, f * 1.02, t + i * 0.06, 0.32, 0.04, 0.03));
        this.noise('highpass', 6000, 5000, 1, t, 0.3, 0.04, 0.06);
        break;
      case 'potion':
        this.osc('sine', 180, 430, t, 0.08, 0.25);
        this.osc('sine', 200, 470, t + 0.11, 0.08, 0.22);
        this.noise('lowpass', 450, 300, 1, t, 0.2, 0.1);
        for (let i = 0; i < 4; i++) { const f = rnd(600, 1100); this.osc('sine', f, f * 1.6, t + 0.22 + i * 0.05, 0.04, 0.06); }
        break;
      case 'relic':
        [1046, 1318, 1568, 2093].forEach((f, i) => this.osc('triangle', f, f, t + i * 0.045, 0.25, 0.05));
        this.fm('sine', 2637, 2637, 2, 0.8, t + 0.18, 0.4, 0.03);
        this.noise('highpass', 7000, 6000, 1, t + 0.05, 0.3, 0.05, 0.04);
        break;
      case 'respawn':
        this.chord('sine', [523, 784, 1046], t, 0.8, 0.035, 0.15, null, 0.6);
        this.osc('sine', 400, 1200, t, 0.6, 0.04, 0.3);
        this.noise('bandpass', 2000, 6000, 3, t, 0.7, 0.06, 0.3);
        break;
      case 'bossRoar': {
        const lp = this.filt('lowpass', 950, 320, 2, t, 1.2);
        this.fm('sawtooth', 115, 62, 0.27, 1.2, t, 1.2, 0.17, 0.15, lp, 0.6);
        this.osc('sawtooth', 58, 43, t, 1.2, 0.12, 0.15, lp, 0.6);
        this.noise('bandpass', 520, 250, 1.5, t, 1.2, 0.35, 0.15, null, 0.6);
        this.osc('sine', 46, 30, t, 1.1, 0.3, 0.2, null, 0.5);
        break;
      }
      case 'bossSlam':
        this.osc('sine', 72, 22, t, 0.9, 0.66);
        this.osc('triangle', 145, 40, t, 0.4, 0.38);
        this.noise('lowpass', 1800, 60, 0.8, t, 0.8, 0.8);
        this.noise('highpass', 2200, 1600, 1, t, 0.05, 0.35);
        this.bits(5, t + 0.03, 0.4, 400, 1600, 0.2);
        break;
      case 'bossDie': {
        const lp = this.filt('lowpass', 1000, 200, 2, t, 1.4);
        this.fm('sawtooth', 125, 35, 0.27, 1.2, t, 1.4, 0.16, 0.08, lp, 0.4);
        this.noise('lowpass', 700, 60, 0.8, t, 1.8, 0.7, 0.2, null, 0.5);
        this.osc('sine', 62, 25, t + 0.1, 1.6, 0.4, 0.3);
        this.bits(12, t + 0.3, 1.3, 400, 2000, 0.2, 'bandpass', 3, 0.07);
        break;
      }
      case 'announce':
        this.brass([196, 247, 294], t, 0.08, 0.045, 0);
        this.brass([262, 330, 392, 523], t + 0.09, 0.6, 0.045, 0.35);
        this.noise('highpass', 6000, 4500, 1, t + 0.09, 0.6, 0.12);
        this.osc('sine', 98, 88, t + 0.09, 0.4, 0.3);
        break;
      case 'victory': {
        const seq = [[[392], 0, 0.13], [[392], 0.15, 0.13], [[392], 0.3, 0.13], [[523, 392], 0.45, 0.38],
          [[659, 523], 0.85, 0.19], [[784, 659], 1.05, 0.19], [[523, 659, 784, 1046], 1.25, 1.25]];
        for (const [fs, d, dur] of seq) this.brass(fs, t + d, dur, 0.04, dur > 0.3 ? 0.6 : 0.3, 3200, 1100);
        this.osc('sine', 131, 120, t + 0.45, 0.3, 0.25);
        this.osc('sine', 131, 120, t + 1.25, 0.6, 0.35);
        this.noise('highpass', 5500, 4000, 1, t + 1.25, 1.1, 0.14);
        break;
      }
      case 'defeat': // sad trombone: "wah" filter opens on each note, the last one droops and wobbles
        for (const [f, d, dur] of [[294, 0, 0.45], [277, 0.5, 0.45], [262, 1.0, 0.45], [247, 1.5, 1.0]]) {
          const last = d > 1.4, os = this.brass([f, f / 2], t + d, dur, 0.045, 0.7, 450, 1500, last ? 0.94 : 1);
          if (last) for (const o of os) this.lfo(o.frequency, 5.5, 6, t + d + 0.2, dur - 0.2);
        }
        break;
      case 'stun':
        this.lfo(this.osc('sine', 2093, 2093, t, 0.18, 0.05).frequency, 14, 70, t, 0.18);
        this.lfo(this.osc('sine', 2637, 2637, t + 0.1, 0.25, 0.04).frequency, 14, 90, t + 0.1, 0.25);
        this.osc('triangle', 420, 260, t, 0.1, 0.06);
        break;
      case 'fountainZap':
        this.lfo(this.fm('sawtooth', 1500 * R(), 700, 0.5, 2, t, 0.25, 0.04).frequency, 45, 300, t, 0.25);
        this.noise('highpass', 5000, 3500, 1, t, 0.25, 0.14);
        this.bits(4, t, 0.22, 3000, 7000, 0.15, 'highpass', 1, 0.015);
        this.osc('square', 120, 110, t, 0.25, 0.03, 0.01, null, 0.6);
        break;
      default:
        return false;
    }
    return true;
  }
}
