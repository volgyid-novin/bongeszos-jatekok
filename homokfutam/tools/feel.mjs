// Driving feel metrics: how the pod steers, slides, and how much the sand, the walls and small driving
// mistakes cost. The game's own frame loop is held; the probes step the physics themselves (__homok.sim),
// and the modelled keyboard drivers press the real keys through real 60 Hz frames (a synthetic clock).
//
//   node feel.mjs [--tag name] [--slide] [--bots] [--only steer,slide,sand,wall,lap,drivers] [--query "col=0"]
//
// --slide: the build has the slide key (Space): also measure a slide and a driver who slides into tight corners
// --bots: lap times of the bots at every difficulty (three 2-lap races, slow)
// Writes out/feel_<tag>.json and prints a summary.
import fs from 'node:fs';
import path from 'node:path';
import { launch, open, OUT } from './lib.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i < 0 ? d : process.argv[i + 1]; };
const has = (k) => process.argv.includes(k);
const TAG = arg('--tag', 'now'), SLIDE = has('--slide'), BOTS = has('--bots');
const ONLY = arg('--only', 'steer,slide,sand,wall,lap,drivers').split(',');

const browser = await launch({ w: 640, h: 360, webgpu: false });
const page = await open(browser, 'q=low&renderer=webgl' + (arg('--query', '') ? '&' + arg('--query') : ''));
await page.evaluate(() => {
  window.__held = [];
  window.requestAnimationFrame = (cb) => { window.__held.push(cb); return 0; };
  window.__t = performance.now();
  const H = window.__homok;
  // put the player pod at arc length s, lateral d, heading track + yawOff (rad), speed v (m/s), everything else at rest
  window.__place = (s, d, yawOff, v) => {
    const p = H.racer(0), tp = H.trackPoint(s, d);
    Object.assign(p, { x: tp.x, z: tp.z, y: tp.y + 1.55, yaw: tp.yaw + yawOff, vy: 0, heat: 0, overheat: 0, prevS: undefined, steer: 0 });
    p.vx = Math.sin(p.yaw) * v; p.vz = Math.cos(p.yaw) * v;
    for (const k of ['yawRate', 'slide', 'wallCD', 'draft']) if (k in p) p[k] = 0;
    p.loc.i = tp.i;
  };
  window.__solo = (laps = 5) => { H.start(laps, 1, false); H.sim(3.4, true); for (let n = 1; n < 6; n++) H.racer(n).gone = true; };
  window.__slip = (p) => Math.atan2(Math.abs(p.lat), Math.max(1, Math.abs(p.fwd))) * 57.3;
});
await new Promise((r) => setTimeout(r, 200));
const run = (fn, ...a) => page.evaluate(fn, ...a);
const res = { tag: TAG, slide: SLIDE };

// 1. full lock for 1 s at 540 km/h on the open track (left, from the right side of the road)
if (ONLY.includes('steer')) res.steer = await run(() => {
  const H = window.__homok, p = H.racer(0), out = [];
  for (const v of [60, 100, 150]) {
    window.__solo(); window.__place(1100, 14, 0, v);
    const y0 = p.yaw; let slip = 0, t = 0; const row = { kmh: Math.round(v * 3.6) };
    for (let k = 0; k < 120; k++) {
      H.force({ steer: 1, throttle: 1, brake: 0, boostIn: false }); H.sim(1 / 120, true); t += 1 / 120;
      slip = Math.max(slip, window.__slip(p));
      if (k === 29) row.yaw025 = +((p.yaw - y0) * 57.3).toFixed(1);
    }
    Object.assign(row, { yaw1s: +((p.yaw - y0) * 57.3).toFixed(1), slipMax: +slip.toFixed(1), kmhAfter: Math.round(p.fwd * 3.6) });
    out.push(row);
  }
  H.force(null);
  return out;
});

// 2. a slide: full lock with the slide key held for 1.2 s at 400 km/h on the open track, then let go (the exit; by
// then the pod has usually run out of road, offMax says how far onto the sand it got)
if (SLIDE && ONLY.includes('slide')) res.slide = await run(() => {
  const H = window.__homok, p = H.racer(0), out = [];
  for (const [v, steer] of [[111, 1], [111, 0.5], [80, 1]]) {
    window.__solo(); window.__place(1100, 16, 0, v); p.heat = 60;
    const y0 = p.yaw; let slip = 0, minV = 1e9, offMax = 0;
    for (let k = 0; k < 144; k++) {
      H.force({ steer, throttle: 1, brake: 0, boostIn: false, slideIn: true }); H.sim(1 / 120, true);
      slip = Math.max(slip, window.__slip(p)); offMax = Math.max(offMax, p.off);
    }
    const atRelease = { kmh: Math.round(Math.hypot(p.vx, p.vz) * 3.6), yaw: +((p.yaw - y0) * 57.3).toFixed(1), heat: Math.round(p.heat) };
    for (let k = 0; k < 90; k++) { H.force({ steer: 0, throttle: 1, brake: 0, boostIn: false, slideIn: false }); H.sim(1 / 120, true); minV = Math.min(minV, p.fwd); offMax = Math.max(offMax, p.off); }
    out.push({ kmh: Math.round(v * 3.6), steer, slipMax: +slip.toFixed(1), yaw12s: atRelease.yaw, kmhAtRelease: atRelease.kmh, heat60to: atRelease.heat, kmhExit075: Math.round(p.fwd * 3.6), offMax: +offMax.toFixed(2) });
  }
  // the same 1.2 s at full lock without the slide, for the turn it gains
  window.__solo(); window.__place(1100, 16, 0, 111); const y0 = p.yaw;
  for (let k = 0; k < 144; k++) { H.force({ steer: 1, throttle: 1, brake: 0, boostIn: false, slideIn: false }); H.sim(1 / 120, true); }
  out.push({ kmh: 400, steer: 1, noSlide: true, yaw12s: +((p.yaw - y0) * 57.3).toFixed(1), kmhAtRelease: Math.round(p.fwd * 3.6) });
  H.force(null);
  return out;
});

// 3. one second on the sand at 540 km/h, beside the open straight
if (ONLY.includes('sand')) res.sand = await run(() => {
  const H = window.__homok, p = H.racer(0), out = [];
  for (const dOff of [4, 8]) {
    window.__solo(); const hw = H.TR.hw[H.trackPoint(1200, 0).i]; window.__place(1200, hw + dOff, 0, 150);
    H.force({ throttle: 1, brake: 0, boostIn: false }); H.sim(1, true);
    const a = Math.round(p.fwd * 3.6);
    window.__place(1200, hw + dOff, 0, 150); H.sim(3, true);
    out.push({ metresOut: dOff, kmhAfter1s: a, kmhAfter3s: Math.round(p.fwd * 3.6) });
  }
  H.force(null);
  return out;
});

// 4. glancing wall hits in the canyon at 540 km/h; the driver steers away 0.25 s after the contact
if (ONLY.includes('wall')) res.wall = await run(() => {
  const H = window.__homok, TR = H.TR, p = H.racer(0), out = [];
  let cy = 0; for (let i = 0; i < TR.N; i++) if (TR.canyon[i] > 0.99) { cy = TR.s[i] + 150; break; }
  for (const ang of [3, 10, 20, 35, 60]) {
    window.__solo(); window.__place(cy, 8, -ang / 57.3, 150);
    let touched = -1, tt = 0, first = 0, contacts = 0, was = false;
    while (tt < 1.5) {
      const corr = touched >= 0 && tt > touched + 0.25;
      H.force({ steer: corr ? 1 : 0, throttle: 1, brake: 0, boostIn: false }); H.sim(1 / 120, true); tt += 1 / 120;
      const inW = Math.abs(p.loc.d) > p.loc.hw - 1.7;
      if (inW && !was) contacts++;
      was = inW;
      if (touched < 0 && inW) touched = tt;
      if (touched >= 0 && !first && tt > touched + 0.1) first = Math.round(Math.hypot(p.vx, p.vz) * 3.6);
    }
    out.push({ deg: ang, kmhAfterContact: first, kmhAfter1_5s: Math.round(Math.hypot(p.vx, p.vz) * 3.6), contacts });
  }
  H.force(null);
  return out;
});

// 5. the autopilot drives the player at full skill (alone): lap 2 time, how much of it at full throttle
if (ONLY.includes('lap')) res.lap = await run(() => {
  const H = window.__homok, p = H.racer(0);
  window.__solo(3); p.skill = 1; p.topMul = 1;
  let n = 0, full = 0, brake = 0, slide = 0, slip = 0;
  for (let k = 0; k < 30 * 200 && p.lap < 2; k++) {
    H.sim(1 / 30, true);
    if (p.lap === 1) { n++; if (p.throttle > 0.95) full++; if (p.brake > 0.05) brake++; if (p.slide > 0.5) slide++; slip = Math.max(slip, window.__slip(p)); }
  }
  return { lapSec: +p.lapTimes[1]?.toFixed(2), fullThrottle: +(full / n).toFixed(2), braking: +(brake / n).toFixed(2), sliding: +(slide / n).toFixed(2), slipMax: +slip.toFixed(1) };
});

// 6. modelled keyboard drivers: real keys, 60 Hz frames, a reaction delay, binary steering
if (ONLY.includes('drivers')) {
  const drivers = [
    { name: 'skilled', delay: 9, db: 0.03, grip: 1.08 },
    { name: 'average', delay: 14, db: 0.05, grip: 1.15 },
    ...(SLIDE ? [{ name: 'slider', delay: 9, db: 0.03, grip: 1.08, slide: true }] : []),
  ];
  res.drivers = [];
  for (const cfg of drivers) res.drivers.push(await run((cfg) => {
    const H = window.__homok, TR = H.TR, p = H.racer(0);
    const held = new Set();
    const key = (code, on) => {
      if (on === held.has(code)) return;
      window.dispatchEvent(new KeyboardEvent(on ? 'keydown' : 'keyup', { code }));
      if (on) held.add(code); else held.delete(code);
    };
    const frame = () => { const cbs = window.__held.splice(0); window.__t += 1000 / 60; for (const cb of cbs) cb(window.__t); };
    H.start(2, 1, false); H.sim(0.01, false);
    for (let n = 1; n < 6; n++) H.racer(n).gone = true;
    const hist = [];
    let frames = 0, offF = 0, hits = 0, wasScr = false, slideF = 0;
    while (frames < 60 * 160 && p.lap < 2) {
      const loc = p.loc, look = 20 + Math.max(p.fwd, 0) * 0.42;
      const li = TR.idx(loc.i + Math.round(look / 4)), tp = H.trackPoint(loc.s + look, TR.line[li]);
      let err = Math.atan2(tp.x - p.x, tp.z - p.z) - p.yaw; err = Math.atan2(Math.sin(err), Math.cos(err));
      let vt = 1e9; for (let k = 0; k <= 14; k += 2) vt = Math.min(vt, TR.vmax[TR.idx(loc.i + k)] * cfg.grip);
      let vAhead = 1e9; for (let k = 0; k <= 40; k += 4) vAhead = Math.min(vAhead, TR.vmax[TR.idx(loc.i + k)]);
      hist.push({ err, vt, vAhead, fwd: p.fwd, heat: p.heat, boosting: p.boosting });
      const o = hist[Math.max(0, hist.length - 1 - cfg.delay)];
      key('KeyA', o.err > cfg.db); key('KeyD', o.err < -cfg.db);
      const over = o.fwd - o.vt;
      // the slider slides where the others brake hard, and brakes only when far too fast
      const slide = cfg.slide && over > 4 && Math.abs(o.err) > 0.04;
      const brake = cfg.slide ? over > 22 : over > 6;
      key('KeyW', !brake); key('KeyS', brake); key('Space', !!slide);
      key('ShiftLeft', o.vAhead > 160 && (o.boosting ? o.heat < 82 : o.heat < 40));
      frame(); frames++;
      if (p.off > 0.05) offF++;
      if ((p.slide || 0) > 0.5) slideF++;
      const scr = (p.scrape || 0) > 0.05; if (scr && !wasScr) hits++; wasScr = scr;
    }
    for (const c of [...held]) key(c, false);
    return { driver: cfg.name, laps: p.lapTimes.map((t) => +t.toFixed(1)), finished: p.lap >= 2, offTrack: +(offF / frames).toFixed(3), wallContacts: hits, sliding: +(slideF / frames).toFixed(3) };
  }, cfg));
}

// 7. the bots' lap times at each difficulty, the autopilot (player skill 0.82) along
if (BOTS) {
  res.bots = [];
  for (const diff of [0, 1, 2]) res.bots.push(await run((diff) => {
    const H = window.__homok; for (let n = 0; n < 6; n++) H.racer(n).gone = false; H.start(3, diff, false); H.sim(3.4, true);
    for (let k = 0; k < 400 && H.info().racers.some((r) => !r.fin); k++) H.sim(1, true);
    const info = H.info();
    return { diff, best: info.racers.map((r) => ({ n: r.n, best: r.laps.length > 1 ? Math.min(...r.laps.slice(1)) : null })) };
  }, diff));
}

await browser.close();
fs.writeFileSync(path.join(OUT, `feel_${TAG}.json`), JSON.stringify(res, null, 1));
console.log(JSON.stringify(res, null, 1));
