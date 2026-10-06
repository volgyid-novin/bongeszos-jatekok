// Synthesised sound effects (no audio files). Every sound is a few oscillators and filtered noise.
export class Sound {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.last = {};
  }
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); return; }
    try {
      const ctx = (this.ctx = new (window.AudioContext || window.webkitAudioContext)());
      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.55;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -16; comp.ratio.value = 4;
      this.master.connect(comp).connect(ctx.destination);
      const len = ctx.sampleRate, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.noiseBuf = buf;
    } catch { this.ctx = null; }
  }
  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 0.55;
  }
  osc(type, f0, f1, t0, dur, vol, out) {
    const c = this.ctx, o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(out || this.master);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }
  noise(filter, f0, f1, q, t0, dur, vol, out) {
    const c = this.ctx, s = c.createBufferSource(), fl = c.createBiquadFilter(), g = c.createGain();
    s.buffer = this.noiseBuf;
    s.playbackRate.value = 0.8 + Math.random() * 0.4;
    fl.type = filter; fl.Q.value = q;
    fl.frequency.setValueAtTime(f0, t0);
    if (f1 !== f0) fl.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    s.connect(fl).connect(g).connect(out || this.master);
    s.start(t0, Math.random() * 0.5); s.stop(t0 + dur + 0.02);
  }
  // k: 0..1 loudness (distance falloff); throttled per sound so big fights don't turn into noise
  play(kind, k = 1) {
    if (!this.ctx || this.muted || k <= 0.02) return;
    const now = this.ctx.currentTime;
    const gap = { sword: 0.06, arrow: 0.05, axe: 0.06, chop: 0.08, hammer: 0.08, die: 0.08, hit: 0.05, coin: 0.12, boom: 0.08 }[kind] || 0.03;
    if (this.last[kind] && now - this.last[kind] < gap) return;
    this.last[kind] = now;
    const t = now + 0.005, r = () => 0.9 + Math.random() * 0.2;
    switch (kind) {
      case 'sword':
        this.noise('bandpass', 3200 * r(), 2400, 3, t, 0.09, 0.35 * k);
        this.osc('triangle', 1650 * r(), 1500, t, 0.18, 0.08 * k);
        this.osc('square', 2470 * r(), 2300, t, 0.07, 0.03 * k);
        break;
      case 'axe':
        this.noise('lowpass', 900, 300, 1, t, 0.12, 0.45 * k);
        this.osc('triangle', 320 * r(), 180, t, 0.1, 0.12 * k);
        break;
      case 'arrow':
        this.noise('highpass', 2500, 1200, 1, t, 0.08, 0.22 * k);
        this.osc('triangle', 240 * r(), 140, t, 0.08, 0.1 * k);
        break;
      case 'throw':
        this.noise('bandpass', 700, 1800, 2, t, 0.16, 0.25 * k);
        break;
      case 'fire':
        this.noise('lowpass', 500, 2200, 1, t, 0.35, 0.3 * k);
        this.osc('sawtooth', 90, 160, t, 0.3, 0.05 * k);
        break;
      case 'zap':
        for (let i = 0; i < 4; i++) this.osc('sawtooth', 300 + Math.random() * 1400, 200 + Math.random() * 600, t + i * 0.04, 0.06, 0.07 * k);
        this.noise('highpass', 3000, 5000, 1, t, 0.2, 0.25 * k);
        break;
      case 'bolt':
        this.osc('sawtooth', 120, 60, t, 0.18, 0.12 * k);
        this.noise('lowpass', 1200, 400, 1, t, 0.15, 0.3 * k);
        break;
      case 'launch':
        this.noise('lowpass', 300, 900, 1, t, 0.3, 0.4 * k);
        this.osc('triangle', 110, 70, t, 0.25, 0.12 * k);
        break;
      case 'boom':
        this.noise('lowpass', 900, 120, 0.7, t, 0.6, 0.8 * k);
        this.osc('sine', 75, 38, t, 0.5, 0.35 * k);
        break;
      case 'hit':
        this.noise('bandpass', 600, 400, 1.5, t, 0.06, 0.25 * k);
        break;
      case 'chop':
        this.noise('bandpass', 900 * r(), 600, 4, t, 0.07, 0.45 * k);
        this.osc('sine', 210 * r(), 150, t, 0.08, 0.15 * k);
        break;
      case 'hammer':
        this.osc('triangle', 980 * r(), 900, t, 0.12, 0.1 * k);
        this.noise('highpass', 2000, 2000, 1, t, 0.03, 0.2 * k);
        break;
      case 'coin':
        this.osc('sine', 1320, 1320, t, 0.08, 0.06 * k);
        this.osc('sine', 1980, 1980, t + 0.06, 0.14, 0.05 * k);
        break;
      case 'die':
        this.noise('lowpass', 500, 150, 1, t, 0.3, 0.45 * k);
        this.osc('sine', 140 * r(), 60, t, 0.25, 0.15 * k);
        break;
      case 'collapse':
        this.noise('lowpass', 700, 80, 0.7, t, 1.3, 0.9 * k);
        this.osc('sine', 55, 30, t, 1.0, 0.35 * k);
        break;
      case 'ack_human':
        this.osc('triangle', 520, 520, t, 0.07, 0.12);
        this.osc('triangle', 780, 780, t + 0.06, 0.09, 0.1);
        break;
      case 'ack_orc':
        this.osc('sawtooth', 110, 85, t, 0.16, 0.08);
        this.noise('lowpass', 400, 200, 2, t, 0.14, 0.18);
        break;
      case 'select':
        this.osc('sine', 880, 990, t, 0.05, 0.05);
        break;
      case 'click':
        this.osc('triangle', 660, 600, t, 0.04, 0.06);
        break;
      case 'error':
        this.osc('square', 150, 140, t, 0.16, 0.05);
        this.osc('square', 110, 105, t + 0.08, 0.16, 0.05);
        break;
      case 'ready':
        this.osc('triangle', 660, 660, t, 0.1, 0.1);
        this.osc('triangle', 990, 990, t + 0.09, 0.16, 0.09);
        break;
      case 'built':
        [523, 659, 784, 1046].forEach((f, i) => this.osc('triangle', f, f, t + i * 0.08, 0.22, 0.1));
        break;
      case 'alert':
        for (const d of [0, 0.32]) {
          this.osc('sawtooth', 196, 190, t + d, 0.28, 0.1);
          this.osc('sawtooth', 294, 288, t + d, 0.28, 0.07);
        }
        break;
      case 'win':
        [392, 523, 659, 784, 1046].forEach((f, i) => this.osc('triangle', f, f, t + i * 0.14, i === 4 ? 0.8 : 0.22, 0.14));
        break;
      case 'lose':
        [392, 349, 311, 262].forEach((f, i) => this.osc('sawtooth', f, f * 0.98, t + i * 0.22, i === 3 ? 0.9 : 0.3, 0.07));
        break;
    }
  }
}
