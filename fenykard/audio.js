// Synthesised sound (no audio files): each saber has a continuous hum that rises in pitch and grows a
// whoosh with swing speed; clashes, hits and ignition are short oscillator + filtered noise shots.
export class Sound {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.hums = [];
    this.last = {};
  }
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); return; }
    try {
      const ctx = (this.ctx = new (window.AudioContext || window.webkitAudioContext)());
      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.6;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14; comp.ratio.value = 4;
      this.master.connect(comp).connect(ctx.destination);
      const len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.noiseBuf = buf;
      this.hums = [this.makeHum(1), this.makeHum(0.55)];
    } catch { this.ctx = null; }
  }
  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 0.6;
  }
  makeHum(vol) {
    const c = this.ctx, out = c.createGain();
    out.gain.value = 0;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 420; lp.Q.value = 1.2;
    const o1 = c.createOscillator(), o2 = c.createOscillator();
    o1.type = 'sawtooth'; o2.type = 'sawtooth';
    o1.frequency.value = 92; o2.frequency.value = 93.7;
    o1.connect(lp); o2.connect(lp);
    lp.connect(out);
    const n = c.createBufferSource(), bp = c.createBiquadFilter(), ng = c.createGain();
    n.buffer = this.noiseBuf; n.loop = true;
    bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 0.9;
    ng.gain.value = 0;
    n.connect(bp).connect(ng).connect(this.master);
    const bus = c.createGain();
    bus.gain.value = vol;
    out.connect(bus).connect(this.master);
    o1.start(); o2.start(); n.start();
    return { out, lp, o1, o2, ng, bp, vol };
  }
  // i: 0 = my saber, 1 = the opponent's. on: 0..1 blade extension, speed: tip speed m/s, near: 0..1 distance falloff
  setHum(i, on, speed, near = 1) {
    const h = this.hums[i];
    if (!h) return;
    const t = this.ctx.currentTime, s = Math.min(speed / 12, 1);
    h.out.gain.setTargetAtTime(on * (0.1 + s * 0.2) * near, t, 0.03);
    h.o1.frequency.setTargetAtTime(92 * (1 + s * 0.35), t, 0.03);
    h.o2.frequency.setTargetAtTime(93.7 * (1 + s * 0.37), t, 0.03);
    h.lp.frequency.setTargetAtTime(420 + s * 900, t, 0.03);
    h.ng.gain.setTargetAtTime(on * s * s * 0.16 * h.vol * near, t, 0.04);
    h.bp.frequency.setTargetAtTime(700 + s * 1100, t, 0.04);
  }
  osc(type, f0, f1, t0, dur, vol) {
    const c = this.ctx, o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(this.master);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }
  noise(filter, f0, f1, q, t0, dur, vol, attack = 0.005) {
    const c = this.ctx, s = c.createBufferSource(), fl = c.createBiquadFilter(), g = c.createGain();
    s.buffer = this.noiseBuf;
    fl.type = filter; fl.Q.value = q;
    fl.frequency.setValueAtTime(f0, t0);
    if (f1 !== f0) fl.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    s.connect(fl).connect(g).connect(this.master);
    s.start(t0, Math.random()); s.stop(t0 + dur + 0.02);
  }
  play(kind, k = 1) {
    if (!this.ctx || this.muted || k <= 0.02) return;
    const now = this.ctx.currentTime;
    const gap = { clash: 0.07, hit: 0.08, click: 0.04 }[kind] || 0.05;
    if (this.last[kind] && now - this.last[kind] < gap) return;
    this.last[kind] = now;
    const t = now + 0.005, r = () => 0.92 + Math.random() * 0.16;
    switch (kind) {
      case 'ignite':
        this.osc('sawtooth', 40, 110, t, 0.45, 0.22 * k);
        this.noise('bandpass', 300, 2400, 1.5, t, 0.35, 0.3 * k, 0.04);
        this.osc('sine', 600, 1400, t, 0.18, 0.05 * k);
        break;
      case 'retract':
        this.osc('sawtooth', 110, 35, t, 0.4, 0.18 * k);
        this.noise('bandpass', 2000, 250, 1.5, t, 0.32, 0.22 * k);
        break;
      case 'clash':
        this.noise('highpass', 2600 * r(), 1500, 0.8, t, 0.22, 0.55 * k);
        this.osc('square', 1900 * r(), 700, t, 0.12, 0.12 * k);
        this.osc('sawtooth', 160, 60, t, 0.28, 0.3 * k);
        this.noise('bandpass', 5200, 3000, 4, t + 0.02, 0.4, 0.12 * k, 0.02);
        break;
      case 'hit':
        this.noise('bandpass', 1500 * r(), 320, 1.4, t, 0.45, 0.55 * k);
        this.osc('sawtooth', 220, 70, t, 0.35, 0.22 * k);
        this.noise('highpass', 4000, 2500, 0.7, t, 0.12, 0.25 * k);
        break;
      case 'hurt':
        this.osc('sine', 120, 45, t, 0.4, 0.5 * k);
        this.noise('lowpass', 900, 200, 0.8, t, 0.4, 0.4 * k);
        break;
      case 'round':
        this.osc('triangle', 520, 520, t, 0.14, 0.12 * k);
        this.osc('triangle', 780, 780, t + 0.12, 0.22, 0.12 * k);
        break;
      case 'go':
        this.osc('sawtooth', 220, 440, t, 0.3, 0.12 * k);
        this.osc('triangle', 880, 880, t, 0.35, 0.1 * k);
        break;
      case 'ko':
        this.osc('sine', 90, 30, t, 1.1, 0.6 * k);
        this.noise('lowpass', 1400, 120, 0.7, t, 1.0, 0.45 * k, 0.01);
        break;
      case 'click':
        this.osc('triangle', 900, 700, t, 0.05, 0.08 * k);
        break;
    }
  }
}
