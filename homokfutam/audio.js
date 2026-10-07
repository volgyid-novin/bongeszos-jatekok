// HOMOKFUTAM audio: everything synthesized with the Web Audio API (no samples).
//
// update(dt, v) view shape:
// {
//   state: 'loading'|'menu'|'room'|'countdown'|'race'|'finished'|'results'|'paused',
//   live: boolean,          // engines audible (countdown/race/finished/results)
//   listener: { x, y, z, fx, fy, fz, ux, uy, uz },  // camera pos, forward, up (world, metres)
//   player: { x, y, z, vx, vy, vz, fwd, throttle, brake, boosting, overheat, heat, off, scrape,
//             slide, slip, edge, draft },   // slide 0..1, slip: slide angle (rad), edge: the strip before the sand 0..1,
//                                           // draft: slipstream 0..1
//   others: [ { id, x, y, z, vx, vy, vz, fwd, throttle, boosting } ],  // up to 5, id 0..5
//   env: { canyon, arena, arch },   // 0..1 how much the listener is in each space
//   crowd: 0..1,            // crowd excitement
//   intensity: 0..1,        // music intensity
//   slowmo: 0..1            // cinematic slow motion
// }

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const rnd = (a, b) => a + Math.random() * (b - a);
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

// music data: E Phrygian dominant, 132 BPM, 16th-note grid, 8 bars = 128 steps
const SC = [0, 1, 4, 5, 7, 8, 10, 12, 13, 16];       // scale degrees (semitones above root)
const PROG = [40, 41, 40, 38];                       // bass roots E2 F2 E2 D2
const LEAD = [                                       // 8 eighths per bar, semitones above E4, null = rest
  7, null, 5, 4, 5, null, 4, 1,
  0, null, 1, 4, 5, 4, 1, 0,
  7, 8, 7, 5, 4, null, 5, 4,
  1, 0, null, null, 4, 1, 0, null,
  12, null, 10, 8, 7, null, 8, 7,
  5, null, 4, 5, 8, 7, 5, 4,
  7, 5, 4, 1, 4, 5, 7, 8,
  7, null, 4, null, 0, null, null, null,
];
const DRUM = 'D.TtD.t.D.TtD.t.';                     // D doum, T tek, t ghost tek
const BASSPAT = [1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0];
const STEP = 60 / 132 / 4;

const LINES = { three: 'Három', two: 'Kettő', one: 'Egy', go: 'Rajt!', finalLap: 'Utolsó kör!', finish: 'Cél!', win: 'Győzelem!', newRecord: 'Új rekord!' };

export function createAudio() {
  const A = { muted: false, musicOn: true };
  let ctx = null, dead = false, N = null, noise = null, huVoice = null;
  let state = 'loading', started = false, nextT = 0, step = 0, si = 0.2, mixT = 0;
  let gust = 0, gustT = 0, gustGoal = 0, swell = 0, crowdRef = 0, cheerCd = 0, boostT = 0, prevBrake = 0, sputUntil = 0, sputT = 0, alarmT = 0;
  const voices = new Map(), passCd = new Map();
  let frame = 0;

  // ---------- node helpers ----------
  const osc = (type, f) => { const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.start(); return o; };
  const gain = (v) => { const g = ctx.createGain(); g.gain.value = v; return g; };
  const filt = (type, f, q) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };
  const nsrc = () => { const s = ctx.createBufferSource(); s.buffer = noise; s.loop = true; s.start(0, Math.random() * 1.5); return s; };
  const set = (p, v, t, tc = 0.08) => p.setTargetAtTime(v, t, tc);
  const lfo = (type, f, depth, target) => { const o = osc(type, f); o.connect(gain(depth)).connect(target); return o; };

  function makeIR() {
    const sr = ctx.sampleRate, n = Math.floor(sr * 2.2), b = ctx.createBuffer(2, n, sr);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c); let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr, a = 0.2 + 0.7 * Math.min(1, t / 1.3);   // gets darker as it decays
        lp = lp * a + (Math.random() * 2 - 1) * (1 - a);
        d[i] = lp * 2.2 * Math.exp(-t * 3.0) * Math.min(1, t * 60);
      }
      for (const [rt, g] of [[0.07, 0.7], [0.13, -0.55], [0.21, 0.45], [0.34, -0.35]]) {
        const i = Math.floor((rt + c * 0.011) * sr); d[i] += g; d[i + 1] += g * 0.5;
      }
    }
    return b;
  }

  // ---------- one-shot primitives ----------
  function env(g, t, a, v, d) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(v, 0.0002), t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(d, a + 0.01));
  }
  function out(g, o) {
    g.connect(o.dest || N.sfx);
    if (o.wet) { const w = gain(o.wet); g.connect(w); w.connect(N.rvIn); }
  }
  function ramp(p, f, t, d) {
    p.setValueAtTime(f[0], t);
    for (let i = 1; i < f.length; i++) p.exponentialRampToValueAtTime(f[i], t + d * i / (f.length - 1));
  }
  // oscillator one-shot: { type, f:[...], dur, vol, att, det, wet, dest, t }
  function blip(o) {
    const t = o.t ?? ctx.currentTime, os = ctx.createOscillator(), g = ctx.createGain();
    os.type = o.type || 'sine'; ramp(os.frequency, o.f, t, o.dur);
    if (o.det) os.detune.value = o.det;
    env(g, t, o.att || 0.008, o.vol, o.dur);
    os.connect(g); out(g, o); os.start(t); os.stop(t + o.dur + 0.05);
  }
  // filtered-noise one-shot: { type, f:[...], q, dur, vol, att, wet, dest, t }
  function burst(o) {
    const t = o.t ?? ctx.currentTime, s = nsrc(), f = filt(o.type || 'bandpass', o.f[0], o.q || 1), g = ctx.createGain();
    ramp(f.frequency, o.f, t, o.dur);
    env(g, t, o.att || 0.004, o.vol, o.dur);
    s.connect(f).connect(g); out(g, o); s.stop(t + o.dur + 0.05);
  }

  // ---------- init ----------
  function build() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('no audio');
    ctx = new AC();
    N = {};
    const nb = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), nd = nb.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    noise = nb;
    // master chain: master -> slowmo lowpass -> compressor -> out
    N.master = gain(A.muted ? 0 : 0.5);
    N.slowF = filt('lowpass', 20000, 0.5);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 12; comp.ratio.value = 4; comp.attack.value = 0.005; comp.release.value = 0.2;
    N.master.connect(N.slowF).connect(comp).connect(ctx.destination);
    for (const k of ['eng', 'sfx', 'amb', 'music', 'voice']) { N[k] = gain(k === 'music' ? 0 : 1); N[k].connect(N.master); }
    N.sfx.gain.value = 0.9; N.amb.gain.value = 0.8;
    // reverb (env-driven send from engines + sfx) and slap-back echo
    const rv = ctx.createConvolver(); rv.buffer = makeIR();
    N.rvIn = gain(1); N.rvSend = gain(0);
    N.rvIn.connect(rv).connect(gain(0.6)).connect(N.master);
    N.eng.connect(N.rvSend); N.sfx.connect(N.rvSend); N.rvSend.connect(N.rvIn);
    const dl = ctx.createDelay(0.5), fb = gain(0.25), slapIn = gain(1);
    dl.delayTime.value = 0.11; N.slapWet = gain(0);
    N.eng.connect(slapIn); N.sfx.connect(slapIn); slapIn.connect(dl); dl.connect(fb).connect(dl); dl.connect(N.slapWet).connect(N.master);
    N.music.connect(gain(0.15)).connect(N.rvIn);

    // player engine: 2 detuned saws + sub, turbine noise, fast tremolo, boost whine
    N.eF = filt('lowpass', 600, 2.5);
    const am = gain(0.75); N.eG = gain(0);
    N.o1 = osc('sawtooth', 60); N.o2 = osc('sawtooth', 60); N.o3 = osc('square', 30);
    N.o2.detune.value = 14;
    const sub = gain(0.35);
    N.o1.connect(N.eF); N.o2.connect(N.eF); N.o3.connect(sub).connect(N.eF);
    N.lfo = lfo('sine', 32, 0.28, am.gain);
    N.eF.connect(am).connect(N.eG).connect(N.eng);
    N.tF = filt('bandpass', 900, 3); N.tG = gain(0);
    nsrc().connect(N.tF).connect(N.tG).connect(N.eng);
    N.wO = osc('triangle', 900); N.wG = gain(0); N.wO.connect(N.wG).connect(N.eng);

    // other pods are created lazily (see voice())

    // ambience: wind, scrape grind, crowd
    N.windF = filt('bandpass', 700, 0.7); N.windG = gain(0);
    nsrc().connect(N.windF).connect(N.windG).connect(N.amb);
    const sg = gain(0.5); N.scG = gain(0);
    nsrc().connect(filt('highpass', 1800, 0.8)).connect(sg).connect(N.scG).connect(N.amb);
    lfo('sawtooth', 41, 0.5, sg.gain); lfo('square', 13, 0.3, sg.gain);
    N.crowdG = gain(0);
    for (const [f, q, r] of [[500, 1.2, 0.23], [1100, 1.5, 0.37], [2400, 1.8, 0.51]]) {
      const lg = gain(0.5);
      lfo('sine', r, 0.4, lg.gain);
      nsrc().connect(filt('bandpass', f, q)).connect(lg).connect(N.crowdG);
    }
    N.crowdG.connect(N.amb);
    // the warning strip before the sand: a low buzz chopped at a rate that follows the speed, like a rumble strip
    N.rmAm = gain(0.5); N.rmG = gain(0);
    nsrc().connect(filt('bandpass', 130, 1.4)).connect(N.rmAm).connect(N.rmG).connect(N.amb);
    osc('square', 46).connect(filt('lowpass', 240, 0.8)).connect(gain(0.35)).connect(N.rmAm);
    N.rmLfo = osc('square', 14); N.rmLfo.connect(gain(0.5)).connect(N.rmAm.gain);
    // a slide: sand hissing off the side of the pod, with a gritty low end
    N.slG = gain(0);
    nsrc().connect(filt('bandpass', 1500, 0.7)).connect(N.slG);
    nsrc().connect(filt('lowpass', 380, 0.9)).connect(gain(0.6)).connect(N.slG);
    N.slG.connect(N.amb);

    // music: pad (always), drums / bass / lead buses faded by intensity
    N.padF = filt('lowpass', 500, 1.2); N.padG = gain(0.5);
    N.p1 = osc('sawtooth', 165); N.p2 = osc('sawtooth', 165); N.p3 = osc('sawtooth', 247); N.p4 = osc('sine', 82);
    N.p2.detune.value = 9;
    const p3g = gain(0.5); N.p1.connect(N.padF); N.p2.connect(N.padF); N.p3.connect(p3g).connect(N.padF); N.p4.connect(N.padF);
    lfo('sine', 0.07, 350, N.padF.frequency);
    N.padF.connect(N.padG).connect(N.music);
    N.mPerc = gain(0); N.mBass = gain(0); N.mLead = gain(0);
    N.mPerc.connect(N.music); N.mBass.connect(N.music); N.mLead.connect(N.music);
    const ld = ctx.createDelay(1), lfb = gain(0.35), lw = gain(0.35);
    ld.delayTime.value = 60 / 132 * 0.75;
    N.mLead.connect(ld); ld.connect(lfb).connect(ld); ld.connect(lw).connect(N.music);
    setInterval(schedule, 25);
  }

  function init() {
    if (dead) return;
    try {
      if (!ctx) build();
      else if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      findVoice();
      if (typeof speechSynthesis !== 'undefined' && speechSynthesis.addEventListener && !init.sv) {
        init.sv = true; speechSynthesis.addEventListener('voiceschanged', findVoice);
      }
    } catch (e) { dead = true; ctx = null; }
  }

  // ---------- announcer ----------
  function findVoice() {
    try { huVoice = speechSynthesis.getVoices().find((x) => x.lang.toLowerCase().startsWith('hu')) || null; } catch (e) { huVoice = null; }
  }
  function announce(key) {
    if (A.muted || dead || typeof speechSynthesis === 'undefined' || !LINES[key]) return;
    if (!huVoice) findVoice();
    if (!huVoice) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(LINES[key]);
      u.voice = huVoice; u.lang = huVoice.lang; u.rate = 1.1; u.pitch = 0.85; u.volume = 1;
      speechSynthesis.speak(u);
    } catch (e) { /* ignore */ }
  }

  // ---------- one-shot sounds ----------
  function sfx(kind, k = 1) {
    if (!ctx || A.muted) return;
    const t = ctx.currentTime;
    switch (kind) {
      case 'beep': case 'go': {
        const f = kind === 'go' ? 880 : 440, d = kind === 'go' ? 0.6 : 0.22;
        blip({ type: 'square', f: [f, f], dur: d, vol: 0.09, det: -6, wet: 0.25 });
        blip({ type: 'square', f: [f, f], dur: d, vol: 0.09, det: 6, wet: 0.25 });
        break;
      }
      case 'hit':
        burst({ type: 'bandpass', f: [2200, 500], q: 0.9, dur: 0.28, vol: 0.55 * k });
        blip({ f: [130, 40], dur: 0.32, vol: 0.7 * k });
        break;
      case 'boom':
        burst({ type: 'lowpass', f: [700, 70], q: 0.8, dur: 1.2, vol: 0.7 * k, wet: 0.3 });
        blip({ f: [150, 28], dur: 1.4, vol: 0.7 * k, wet: 0.3 });
        break;
      case 'backfire':
        burst({ type: 'lowpass', f: [1800, 120], q: 0.7, dur: 0.22, vol: 0.6 * k });
        blip({ f: [95, 32], dur: 0.25, vol: 0.55 * k });
        break;
      case 'zap':
        burst({ type: 'bandpass', f: [5200, 900], q: 2.5, dur: 0.35, vol: 0.4 * k });
        blip({ type: 'sawtooth', f: [1400, 60], dur: 0.4, vol: 0.12 * k });
        break;
      case 'crash':
        burst({ type: 'lowpass', f: [2600, 60], q: 0.6, dur: 1.6, vol: 0.85 * k, wet: 0.35 });
        burst({ type: 'bandpass', f: [3400, 1200], q: 3, dur: 0.6, vol: 0.3 * k });
        blip({ f: [120, 24], dur: 1.6, vol: 0.8 * k, wet: 0.3 });
        break;
      case 'scrape':
        burst({ type: 'bandpass', f: [3200, 1800], q: 5, dur: 0.3, vol: 0.22 * k });
        blip({ type: 'square', f: [1500, 800], dur: 0.25, vol: 0.04 * k });
        break;
      case 'boostStart':
        burst({ type: 'lowpass', f: [200, 3000], q: 1.5, dur: 0.9, vol: 0.5 * k, att: 0.25 });
        blip({ f: [170, 40], dur: 0.85, vol: 0.6 * k });
        break;
      case 'whoosh':
        burst({ type: 'bandpass', f: [350, 2400, 300], q: 1.2, dur: 0.8, vol: 0.5 * clamp(k, 0.2, 1.2), att: 0.18, wet: 0.15 });
        break;
      case 'brake':
        burst({ type: 'bandpass', f: [5500, 3800], q: 0.8, dur: 0.45, vol: 0.14 * clamp(k, 0.3, 1), att: 0.03 });
        break;
      case 'firework':
        blip({ f: [500, 3200], dur: 0.9, vol: 0.06, att: 0.05, wet: 0.3 });
        for (let i = 0; i < 9; i++) {
          const pt = t + 0.95 + i * rnd(0.05, 0.13) + (i > 4 ? 0.3 : 0);
          burst({ type: 'bandpass', f: [rnd(2200, 4200), 700], q: 1, dur: 0.14, vol: rnd(0.15, 0.35), t: pt, wet: 0.4 });
          for (let j = 0; j < 4; j++) burst({ type: 'highpass', f: [rnd(5000, 8000), 5000], q: 0.7, dur: 0.03, vol: 0.12, t: pt + rnd(0.02, 0.4), wet: 0.3 });
        }
        break;
      case 'lap':
        blip({ f: [660, 660], dur: 0.45, vol: 0.12, wet: 0.35 });
        blip({ type: 'triangle', f: [660, 660], dur: 0.45, vol: 0.08, wet: 0.35 });
        blip({ f: [990, 990], dur: 0.7, vol: 0.12, t: t + 0.13, wet: 0.35 });
        blip({ type: 'triangle', f: [990, 990], dur: 0.7, vol: 0.08, t: t + 0.13, wet: 0.35 });
        break;
      case 'ui':
        blip({ type: 'square', f: [1800, 1100], dur: 0.04, vol: 0.05 });
        break;
      case 'checkpoint':
        blip({ f: [1200, 1200], dur: 0.14, vol: 0.07, wet: 0.2 });
        break;
    }
  }

  // ---------- other pods ----------
  function voice(id) {
    let s = voices.get(id);
    if (s) return s;
    const o1 = osc('sawtooth', 70), o2 = osc('sawtooth', 105), f = filt('lowpass', 900, 1.5), g = gain(0), p = ctx.createPanner();
    o2.detune.value = 12;
    p.panningModel = 'HRTF'; p.distanceModel = 'inverse'; p.refDistance = 12; p.rolloffFactor = 1.2; p.maxDistance = 400;
    o1.connect(f); o2.connect(f); f.connect(g).connect(p).connect(N.eng);
    s = { o1, o2, f, g, p, seen: 0 };
    voices.set(id, s);
    return s;
  }
  function setPos(p, x, y, z, t) {
    if (p.positionX) { p.positionX.setTargetAtTime(x, t, 0.015); p.positionY.setTargetAtTime(y, t, 0.015); p.positionZ.setTargetAtTime(z, t, 0.015); }
    else p.setPosition(x, y, z);
  }
  function setListener(l, t) {
    const L = ctx.listener;
    if (L.positionX) {
      L.positionX.setTargetAtTime(l.x, t, 0.015); L.positionY.setTargetAtTime(l.y, t, 0.015); L.positionZ.setTargetAtTime(l.z, t, 0.015);
      L.forwardX.setTargetAtTime(l.fx, t, 0.015); L.forwardY.setTargetAtTime(l.fy, t, 0.015); L.forwardZ.setTargetAtTime(l.fz, t, 0.015);
      L.upX.setTargetAtTime(l.ux, t, 0.015); L.upY.setTargetAtTime(l.uy, t, 0.015); L.upZ.setTargetAtTime(l.uz, t, 0.015);
    } else { L.setPosition(l.x, l.y, l.z); L.setOrientation(l.fx, l.fy, l.fz, l.ux, l.uy, l.uz); }
  }

  // ---------- crowd cheer ----------
  function cheer(t) {
    swell = 1;
    for (let i = 0; i < 3; i++) blip({ f: [rnd(1700, 1900), rnd(2500, 2700)], dur: rnd(0.5, 0.8), vol: 0.025, att: 0.08, t: t + rnd(0, 0.6), dest: N.amb, wet: 0.3 });
  }

  // ---------- per-frame update ----------
  function update(dt, v) {
    if (!ctx || !v) return;
    const t = ctx.currentTime, p = v.player, env_ = v.env, live = !!v.live;
    state = v.state; frame++;
    if (state !== 'loading') started = true;
    const paused = state === 'paused', duck = paused ? 0.3 : 1, sp = Math.abs(p.fwd), thr = p.throttle;
    const pm = 1 - 0.3 * (v.slowmo || 0);
    // master: slowmo lowpass, reverb/slap sends
    set(N.slowF.frequency, 20000 * Math.pow(1200 / 20000, v.slowmo || 0), t, 0.1);
    set(N.rvSend.gain, clamp(env_.canyon * 0.55 + env_.arch * 0.8 + env_.arena * 0.25, 0, 1) * 0.6, t, 0.25);
    set(N.slapWet.gain, env_.canyon * 0.3, t, 0.25);
    set(N.eng.gain, duck, t, 0.15); set(N.amb.gain, 0.8 * (paused ? 0.5 : 1), t, 0.15);
    setListener(v.listener, t);

    // player engine
    boostT = p.boosting ? Math.min(2.5, boostT + dt) : Math.max(0, boostT - dt * 2);
    const hot = p.overheat > 0;
    if (hot && t > sputUntil && Math.random() < dt * 9) { sputUntil = t + rnd(0.04, 0.12); }
    const sput = hot && t < sputUntil ? 0.15 : 1;
    const base = (46 + sp * 0.72 + thr * 12) * pm * (hot ? 0.82 : 1) * (p.boosting ? 1.04 : 1);
    set(N.o1.frequency, base, t, 0.06); set(N.o2.frequency, base * 1.5, t, 0.06); set(N.o3.frequency, base * 0.5, t, 0.06);
    set(N.lfo.frequency, (22 + sp * 0.18) * pm, t, 0.1);
    set(N.eF.frequency, 260 + sp * 13 + thr * 500 + boostT * 280, t, 0.08);
    set(N.eG.gain, live ? (0.11 + thr * 0.07) * sput : 0, t, hot ? 0.02 : 0.12);
    set(N.tF.frequency, (700 + sp * 20) * pm, t, 0.1);
    set(N.tG.gain, live ? (0.03 + sp * 0.0004 + p.off * 0.03) * (0.5 + thr * 0.5) * sput : 0, t, 0.1);
    set(N.wG.gain, live && p.boosting ? 0.035 : 0, t, 0.08);
    set(N.wO.frequency, (700 + sp * 5 + boostT * 260) * pm, t, 0.1);
    if (live && prevBrake <= 0.5 && p.brake > 0.5 && sp > 30) sfx('brake', sp / 120);
    prevBrake = p.brake;
    // boosting into the red zone: an alarm that beeps faster as the heat nears the overheat
    if (live && p.boosting && p.heat > 80 && !A.muted) {
      alarmT -= dt;
      if (alarmT <= 0) {
        alarmT = 0.34 - 0.26 * clamp((p.heat - 80) / 20, 0, 1);
        blip({ type: 'square', f: [1250, 1250], dur: 0.055, vol: 0.045 });
      }
    } else alarmT = 0;
    // the strip before the sand, and a slide
    set(N.rmG.gain, live ? clamp(p.edge || 0, 0, 1) * clamp(sp / 30, 0, 1) * 0.5 : 0, t, 0.04);
    set(N.rmLfo.frequency, 8 + sp * 0.16, t, 0.1);
    set(N.slG.gain, live ? (p.slide || 0) * clamp(((p.slip || 0) - 0.06) / 0.25, 0, 1) * clamp(sp / 60, 0, 1) * 0.16 : 0, t, 0.06);

    // other pods with doppler
    const l = v.listener;
    for (const o of v.others) {
      const s = voice(o.id); s.seen = frame;
      const dx = o.x - l.x, dy = o.y - l.y, dz = o.z - l.z, d = Math.hypot(dx, dy, dz) || 1;
      const rvx = p.vx - o.vx, rvy = p.vy - o.vy, rvz = p.vz - o.vz;
      const closing = (rvx * dx + rvy * dy + rvz * dz) / d;
      const dop = clamp(343 / Math.max(343 - closing, 1), 0.6, 1.7);
      const f = (46 + Math.abs(o.fwd) * 0.72 + o.throttle * 12) * dop * pm;
      set(s.o1.frequency, f, t, 0.05); set(s.o2.frequency, f * 1.5, t, 0.05);
      set(s.f.frequency, 400 + Math.abs(o.fwd) * 9 + o.throttle * 400, t, 0.1);
      set(s.g.gain, live ? 0.11 * (0.45 + 0.55 * o.throttle) * clamp((350 - d) / 50, 0, 1) : 0, t, 0.06);
      setPos(s.p, o.x, o.y, o.z, t);
      // pass-by whoosh
      const rel = Math.hypot(rvx, rvy, rvz);
      if (live && d < 10 && rel > 40 && t > (passCd.get(o.id) || 0)) { passCd.set(o.id, t + 1.5); sfx('whoosh', rel / 150); }
    }
    for (const s of voices.values()) if (s.seen !== frame) set(s.g.gain, 0, t, 0.06);

    // wind with gusts: the gust field at the camera when the world has one (v.gust, gfx/wind.js), else at random
    if (v.gust !== undefined) gust += (v.gust - gust) * Math.min(1, dt * 3);
    else {
      gustT -= dt;
      if (gustT <= 0) { gustT = rnd(2, 5); gustGoal = Math.random() < 0.5 ? rnd(0, 1) : 0; }
      gust += (gustGoal - gust) * Math.min(1, dt * 0.7);
    }
    const amb = state !== 'loading';
    // (in another pod's slipstream the rush of air drops away)
    set(N.windG.gain, amb ? ((live ? Math.min(0.32, sp / 520) : 0.03) * (1 - 0.45 * (p.draft || 0)) + 0.03 + gust * ((v.gust !== undefined ? 0.08 : 0.05) + sp * 0.0004)) : 0, t, 0.15);
    set(N.windF.frequency, 400 + sp * 9 + gust * 250, t, 0.15);
    set(N.scG.gain, live ? clamp(p.scrape, 0, 1) * 0.22 : 0, t, 0.03);

    // crowd
    crowdRef += (v.crowd - crowdRef) * (1 - Math.exp(-dt / 0.6));
    if (v.crowd - crowdRef > 0.2 && env_.arena > 0.1 && t > cheerCd) { cheerCd = t + 3; cheer(t); }
    swell *= Math.exp(-dt / 1.2);
    set(N.crowdG.gain, amb ? env_.arena * (0.25 + 0.75 * v.crowd + swell * 0.8) * 0.4 : 0, t, 0.2);

    // music: smooth intensity, layer levels, duck
    si += (v.intensity - si) * (1 - Math.exp(-dt / 2));
    const on = A.musicOn && started;
    set(N.music.gain, on ? 0.22 * (paused ? 0.4 : 1) : 0, t, 0.4);
    set(N.mPerc.gain, clamp((si - 0.35) / 0.15, 0, 1) * 0.9, t, 0.3);
    set(N.mBass.gain, clamp((si - 0.55) / 0.15, 0, 1) * 0.9, t, 0.3);
    set(N.mLead.gain, clamp((si - 0.8) / 0.12, 0, 1) * 0.8, t, 0.3);
    set(N.padG.gain, 0.55 - 0.2 * si, t, 0.5);
  }

  // ---------- music scheduler (two-clocks pattern) ----------
  function schedule() {
    if (!ctx || ctx.state !== 'running' || !A.musicOn || !started) return;
    const now = ctx.currentTime;
    if (nextT < now - 0.3) nextT = now + 0.05;
    while (nextT < now + 0.12) { playStep(step, nextT); nextT += STEP; step = (step + 1) % 128; }
  }
  function playStep(s, t) {
    const bar = Math.floor(s / 16), st = s % 16, root = PROG[bar % 4];
    if (st === 0) {
      const f = mtof(root + 12);
      set(N.p1.frequency, f, t, 0.35); set(N.p2.frequency, f, t, 0.35); set(N.p3.frequency, f * 1.5, t, 0.35); set(N.p4.frequency, f / 2, t, 0.35);
    }
    if (si > 0.3) {
      const c = DRUM[st];
      if (bar === 7 && st >= 12) drum('t', t);
      else if (c !== '.') drum(c, t);
    }
    if (si > 0.5 && BASSPAT[st]) {
      const m = root + (st === 6 ? 12 : st === 14 ? 7 : 0);
      bass(m, t, STEP * 1.6, st % 4 === 0);
    }
    if (si > 0.75 && st % 2 === 0) {
      const n = LEAD[bar * 8 + st / 2];
      if (n !== null) {
        if (st % 8 === 0) { const g = SC.find((x) => x > n); lead(64 + g, t - 0.06, 0.06, 0.1); }
        lead(64 + n, t, STEP * 3.2, 0.2);
      }
    }
  }
  function drum(c, t) {
    if (c === 'D') {
      blip({ f: [190, 62], dur: 0.2, vol: 0.55, t, dest: N.mPerc });
      burst({ type: 'lowpass', f: [800, 300], dur: 0.03, vol: 0.12, t, dest: N.mPerc });
    } else {
      const v = c === 'T' ? 1 : 0.45;
      burst({ type: 'bandpass', f: [3200, 2500], q: 2.5, dur: 0.07, vol: 0.2 * v, t, dest: N.mPerc });
      blip({ f: [900, 500], dur: 0.04, vol: 0.06 * v, t, dest: N.mPerc });
    }
  }
  function bass(m, t, d, acc) {
    const o = ctx.createOscillator(), o2 = ctx.createOscillator(), f = filt('lowpass', 1, 2), g = ctx.createGain();
    o.type = 'sawtooth'; o2.type = 'sine'; o.frequency.value = mtof(m); o2.frequency.value = mtof(m);
    f.frequency.setValueAtTime(acc ? 1400 : 900, t); f.frequency.exponentialRampToValueAtTime(250, t + d);
    env(g, t, 0.006, acc ? 0.35 : 0.26, d);
    o.connect(f); o2.connect(f); f.connect(g).connect(N.mBass);
    o.start(t); o2.start(t); o.stop(t + d + 0.05); o2.stop(t + d + 0.05);
  }
  function lead(m, t, d, vol) {
    const o = ctx.createOscillator(), o2 = ctx.createOscillator(), f = filt('bandpass', 1700, 1.1), g = ctx.createGain();
    o.type = 'sawtooth'; o2.type = 'sawtooth'; o.frequency.value = o2.frequency.value = mtof(m); o2.detune.value = 8;
    env(g, t, 0.006, vol, d);
    o.connect(f); o2.connect(f); f.connect(g).connect(N.mLead);
    o.start(t); o2.start(t); o.stop(t + d + 0.05); o2.stop(t + d + 0.05);
  }

  // ---------- public API ----------
  function setMuted(m) {
    A.muted = !!m;
    if (A.muted) try { speechSynthesis.cancel(); } catch (e) { /* ignore */ }
    if (ctx) N.master.gain.setTargetAtTime(A.muted ? 0 : 0.5, ctx.currentTime, 0.05);
  }
  function setMusic(on) { A.musicOn = !!on; }

  A.init = init; A.setMuted = setMuted; A.setMusic = setMusic;
  A.update = (dt, v) => { if (!dead) try { update(dt, v); } catch (e) { /* never break the game loop */ } };
  A.sfx = (kind, k = 1) => { if (!dead) try { sfx(kind, k); } catch (e) { /* ignore */ } };
  A.announce = announce;
  return A;
}
