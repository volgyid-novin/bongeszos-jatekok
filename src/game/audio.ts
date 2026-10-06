// All sound effects are synthesized with WebAudio — no asset files needed.

class Sfx {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private noise: AudioBuffer | null = null

  unlock() {
    if (!this.ctx) {
      this.ctx = new AudioContext()
      this.master = this.ctx.createGain()
      this.master.gain.value = 0.45
      this.master.connect(this.ctx.destination)
      const len = this.ctx.sampleRate
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate)
      const data = this.noise.getChannelData(0)
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
    }
    void this.ctx.resume()
  }

  private tone(type: OscillatorType, f0: number, f1: number, dur: number, vol: number, delay = 0) {
    const ctx = this.ctx
    if (!ctx || !this.master) return
    const t = ctx.currentTime + delay
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.type = type
    osc.frequency.setValueAtTime(f0, t)
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur)
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(vol, t + 0.005)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    osc.connect(g).connect(this.master)
    osc.start(t)
    osc.stop(t + dur + 0.02)
  }

  private burst(dur: number, vol: number, filter: BiquadFilterType, freq: number, delay = 0) {
    const ctx = this.ctx
    if (!ctx || !this.master || !this.noise) return
    const t = ctx.currentTime + delay
    const src = ctx.createBufferSource()
    src.buffer = this.noise
    const f = ctx.createBiquadFilter()
    f.type = filter
    f.frequency.value = freq
    const g = ctx.createGain()
    g.gain.setValueAtTime(vol, t)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    src.connect(f).connect(g).connect(this.master)
    src.start(t, Math.random() * 0.5)
    src.stop(t + dur + 0.02)
  }

  // vol lets remote sounds fade with distance
  shoot(slot: number, vol = 1) {
    switch (slot) {
      case 2: // shotgun
        this.burst(0.28, 0.7 * vol, 'lowpass', 1400)
        this.tone('square', 140, 40, 0.18, 0.3 * vol)
        break
      case 1: // rifle
        this.burst(0.07, 0.35 * vol, 'bandpass', 2200)
        this.tone('square', 300, 90, 0.05, 0.15 * vol)
        break
      case 4: // sniper
        this.burst(0.4, 0.8 * vol, 'bandpass', 900)
        this.tone('sawtooth', 600, 50, 0.3, 0.3 * vol)
        break
      case 3: // rocket
        this.burst(0.5, 0.4 * vol, 'lowpass', 700)
        this.tone('sawtooth', 160, 60, 0.4, 0.2 * vol)
        break
      default:
        this.burst(0.11, 0.5 * vol, 'bandpass', 1700)
        this.tone('square', 220, 55, 0.09, 0.25 * vol)
    }
  }
  hit(head = false) {
    if (head) {
      this.tone('square', 1400, 2100, 0.07, 0.2)
      this.tone('sine', 2600, 2600, 0.1, 0.12, 0.03)
    } else {
      this.tone('square', 900, 1300, 0.05, 0.16)
    }
  }
  explosion(vol = 1) {
    this.burst(0.7, 0.9 * vol, 'lowpass', 600)
    this.tone('sine', 110, 30, 0.6, 0.6 * vol)
  }
  hurt() {
    this.tone('sawtooth', 200, 80, 0.18, 0.3)
  }
  death() {
    this.tone('sawtooth', 300, 40, 0.8, 0.3)
    this.burst(0.5, 0.3, 'lowpass', 500)
  }
  kill() {
    ;[660, 880, 1320].forEach((f, i) => this.tone('square', f, f, 0.09, 0.16, i * 0.07))
  }
  pickup() {
    this.tone('square', 880, 1760, 0.12, 0.14)
  }
  weaponPickup() {
    this.tone('square', 440, 440, 0.06, 0.15)
    this.tone('square', 660, 660, 0.06, 0.15, 0.06)
    this.tone('square', 990, 990, 0.12, 0.15, 0.12)
  }
  jumpPad() {
    this.tone('sine', 200, 900, 0.35, 0.3)
  }
  land(strength: number) {
    this.burst(0.08, Math.min(0.4, strength * 0.03), 'lowpass', 500)
  }
  switchWeapon() {
    this.tone('square', 1100, 800, 0.04, 0.08)
  }
  empty() {
    this.tone('square', 2000, 1800, 0.02, 0.06)
  }
  reload() {
    this.tone('square', 1200, 900, 0.03, 0.08)
    this.tone('square', 900, 1300, 0.03, 0.08, 0.18)
  }
  spawn() {
    this.tone('sine', 400, 1200, 0.3, 0.15)
  }
  flagTaken(ours: boolean) {
    const f = ours ? [660, 440] : [440, 660]
    f.forEach((x, i) => this.tone('square', x, x, 0.14, 0.18, i * 0.12))
  }
  flagReturned() {
    ;[523, 784].forEach((x, i) => this.tone('triangle', x, x, 0.15, 0.2, i * 0.1))
  }
  flagCaptured(ours: boolean) {
    const notes = ours ? [523, 659, 784, 1047, 1319] : [784, 622, 523, 392]
    notes.forEach((x, i) => this.tone('square', x, x, 0.16, 0.17, i * 0.1))
  }
  zoom() {
    this.tone('sine', 300, 500, 0.08, 0.08)
  }
  beep(high = false) {
    this.tone('square', high ? 880 : 440, high ? 880 : 440, high ? 0.3 : 0.12, 0.15)
  }
  win() {
    ;[523, 659, 784, 1047].forEach((f, i) => this.tone('square', f, f, 0.2, 0.15, i * 0.12))
  }
  lose() {
    ;[392, 330, 262, 196].forEach((f, i) => this.tone('triangle', f, f, 0.25, 0.2, i * 0.15))
  }
}

export const sfx = new Sfx()
