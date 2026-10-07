// Collision metrics (docs/visual-next-steps.md F): scripted hits from a fixed start, the race held and the physics
// stepped at 120 Hz (__homok.sim). For each: how deep the player's hull got into the solid world or into the other
// pod's hull (the clipping), the speed just after the contact and a second later, the turn it gave, the spin.
//
//   node hits.mjs [--tag name] ["query"]      e.g. node hits.mjs --tag old "col=0"
//
// The hull and the field are the same in both modes (?col=0 only changes what resolves the contact), so the depths
// compare the old circles and clamps with the new hull on equal terms. Writes out/hits_<tag>.json.
import fs from 'node:fs';
import path from 'node:path';
import { launch, open, OUT } from './lib.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i < 0 ? d : process.argv[i + 1]; };
const TAG = arg('--tag', 'now');
const QUERY = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--tag').pop() || '';

const browser = await launch({ w: 640, h: 360, webgpu: false });
const page = await open(browser, 'q=low&renderer=webgl' + (QUERY ? '&' + QUERY : ''));
await page.evaluate(() => {
  window.requestAnimationFrame = () => 0;           // the game's own frame loop held: only the probes step it
  const H = window.__homok;
  window.__solo = (others = 0) => { H.start(1, 1, false); H.sim(3.4, true); for (let n = 1; n < 6; n++) H.racer(n).gone = n > others; };
  // racer n at arc length s, lateral d, heading track + yawOff (rad), speed v (m/s)
  window.__place = (n, s, d, yawOff, v) => {
    const p = H.racer(n), tp = H.trackPoint(s, d);
    Object.assign(p, { x: tp.x, z: tp.z, y: tp.y + 1.55, yaw: tp.yaw + yawOff, vy: 0, heat: 0, overheat: 0, prevS: undefined, steer: 0, spin: 0, yawRate: 0, slide: 0, wallCD: 0, crashCD: 0 });
    p.vx = Math.sin(p.yaw) * v; p.vz = Math.cos(p.yaw) * v;
    p.loc.i = tp.i;
  };
  // the deepest the player's hull is in the world (field) and in racer m's hull, sampled every 0.2 m
  const sq = {};
  const caps = (r) => r.hull.caps.filter((k) => !(k.bit & (r.broken || 0))).map((k) => {
    const c = Math.cos(r.yaw), s = Math.sin(r.yaw);
    return { ax: r.x + k.ax * c + k.az * s, az: r.z - k.ax * s + k.az * c, bx: r.x + k.bx * c + k.bz * s, bz: r.z - k.bx * s + k.bz * c, r: k.r };
  });
  window.__pen = (m) => {
    const p = H.racer(0);
    let world = -Infinity, pod = -Infinity;
    for (const k of caps(p)) {
      const len = Math.hypot(k.bx - k.ax, k.bz - k.az), n = Math.max(1, Math.ceil(len / 0.2));
      for (let j = 0; j <= n; j++) {
        const t = j / n, x = k.ax + (k.bx - k.ax) * t, z = k.az + (k.bz - k.az) * t;
        world = Math.max(world, k.r - H.solid.query(x, z, p.loc.i, sq));
      }
    }
    if (m != null && !H.racer(m).gone) {
      const q = H.racer(m);
      for (const a of caps(p)) for (const b of caps(q)) {
        // capsule against capsule, sampled: the distance from points along a to the segment b
        const len = Math.hypot(a.bx - a.ax, a.bz - a.az), n = Math.max(1, Math.ceil(len / 0.2));
        for (let j = 0; j <= n; j++) {
          const t = j / n, x = a.ax + (a.bx - a.ax) * t, z = a.az + (a.bz - a.az) * t;
          const ux = b.bx - b.ax, uz = b.bz - b.az, l2 = ux * ux + uz * uz || 1;
          const u = Math.min(1, Math.max(0, ((x - b.ax) * ux + (z - b.az) * uz) / l2));
          pod = Math.max(pod, a.r + b.r - Math.hypot(x - b.ax - ux * u, z - b.az - uz * u));
        }
      }
    }
    return { world, pod };
  };
  // one scenario: inputs(t, touched) -> forced inputs; runs `secs`; contact = the hull first within 0.05 m of
  // the world or the other pod
  window.__run = (secs, inputs, other) => {
    const p = H.racer(0);
    let t = 0, touched = -1, yaw0 = 0, v0 = Math.hypot(p.vx, p.vz), vAfter = 0, yawAfter = 0, worldMax = -Infinity, podMax = -Infinity, spinMax = 0, contacts = 0, was = false, minV = 1e9;
    while (t < secs) {
      H.force(inputs(t, touched)); H.sim(1 / 120, true); t += 1 / 120;
      const pen = window.__pen(other);
      worldMax = Math.max(worldMax, pen.world); podMax = Math.max(podMax, pen.pod);
      spinMax = Math.max(spinMax, Math.abs(p.spin || 0));
      const inC = pen.world > -0.05 || pen.pod > -0.05;
      if (inC && !was) contacts++;
      was = inC;
      if (touched < 0 && inC) { touched = t; yaw0 = p.yaw; }
      if (touched >= 0 && !vAfter && t > touched + 0.1) vAfter = Math.hypot(p.vx, p.vz);
      if (touched >= 0 && !yawAfter && t > touched + 0.5) yawAfter = p.yaw - yaw0;
      if (touched >= 0) minV = Math.min(minV, Math.hypot(p.vx, p.vz));
    }
    H.force(null);
    const kmh = (v) => Math.round(v * 3.6);
    return {
      kmh0: kmh(v0), touchedAt: +touched.toFixed(2), kmhAfter01: kmh(vAfter), kmhEnd: kmh(Math.hypot(p.vx, p.vz)), kmhMin: kmh(minV),
      turn05: +(Math.atan2(Math.sin(yawAfter), Math.cos(yawAfter)) * 57.3).toFixed(1), spinMax: +spinMax.toFixed(2),
      clipWorld: +Math.max(0, worldMax).toFixed(2), clipPod: +Math.max(0, podMax).toFixed(2), contacts,
    };
  };
});
const run = (fn, ...a) => page.evaluate(fn, ...a);
const res = { tag: TAG, query: QUERY, hull: await run(() => { const h = window.__homok.racer(0).hull; return { source: h.source, caps: h.caps.length, reach: +h.reach.toFixed(2), k: +Math.sqrt(h.k2).toFixed(2) }; }) };

// 1. the canyon wall at 540 km/h, nose in at 5, 20 and 60 degrees; the driver steers away 0.25 s after the contact
res.canyon = await run(() => {
  const H = window.__homok, TR = H.TR, out = [];
  let cy = 0; for (let i = 0; i < TR.N; i++) if (TR.canyon[i] > 0.99) { cy = TR.s[i] + 150; break; }
  for (const ang of [5, 20, 60]) {
    window.__solo(); window.__place(0, cy, 6, ang / 57.3 * -1, 150);
    out.push({ deg: ang, ...window.__run(1.5, (t, tc) => ({ steer: tc >= 0 && t > tc + 0.25 ? 1 : 0, throttle: 1, brake: 0, boostIn: false })) });
  }
  return out;
});
// 2. the arena wall at 20 degrees, 400 km/h
res.arena = await run(() => {
  window.__solo(); window.__place(0, 120, 6, -20 / 57.3, 111);
  return [{ deg: 20, ...window.__run(1.5, (t, tc) => ({ steer: tc >= 0 && t > tc + 0.25 ? 1 : 0, throttle: 1, brake: 0, boostIn: false })) }];
});
// 3. rocks head on: the biggest boulder near the open track and the nearest spire, from 45 m at 300 km/h
res.rocks = await run(() => {
  const H = window.__homok, R = H.rocks, out = [];
  const near = (it) => { let best = 1e9; for (let i = 0; i < H.TR.N; i += 2) best = Math.min(best, Math.hypot(H.TR.px[i] - it.x, H.TR.pz[i] - it.z)); return best; };
  const boulder = R.boulders.filter((b) => b.r > 4).sort((a, b) => near(a) - near(b))[0];
  const spire = [...R.spires].sort((a, b) => near(a) - near(b))[0];
  for (const [name, it] of [['boulder', boulder], ['spire', spire]]) {
    window.__solo();
    const p = H.racer(0);
    // 45 m out from the rock's surface, on the line from the track towards it, aimed at its centre
    const tp = H.trackPoint(0, 0); let bi = 0, bd = 1e18;
    for (let i = 0; i < H.TR.N; i++) { const d = (H.TR.px[i] - it.x) ** 2 + (H.TR.pz[i] - it.z) ** 2; if (d < bd) { bd = d; bi = i; } }
    const dx = H.TR.px[bi] - it.x, dz = H.TR.pz[bi] - it.z, l = Math.hypot(dx, dz);
    let surf = 0; const o = {}; for (let k = 0; k < 400; k++) { if (H.solid.query(it.x + dx / l * k * 0.25, it.z + dz / l * k * 0.25, bi, o) > 0) { surf = k * 0.25; break; } }
    window.__place(0, H.TR.s[bi], 0, 0, 0);
    Object.assign(p, { x: it.x + dx / l * (surf + 45), z: it.z + dz / l * (surf + 45) });
    p.yaw = Math.atan2(-dx, -dz); p.vx = Math.sin(p.yaw) * 83; p.vz = Math.cos(p.yaw) * 83; p.loc.i = bi;
    out.push({ rock: name, size: +it.r.toFixed(1), ...window.__run(1.2, () => ({ steer: 0, throttle: 1, brake: 0, boostIn: false })) });
  }
  return out;
});
// 4. nose to tail: a slower pod 14 m ahead in the same lane; 5. side by side, the player steers into the other
res.pods = await run(() => {
  const H = window.__homok, out = [];
  window.__solo(1); window.__place(0, 1100, 4, 0, 130); window.__place(1, 1114, 4, 0, 95); H.racer(1).topMul = 0.6;
  out.push({ case: 'nose to tail', ...window.__run(1.2, () => ({ steer: 0, throttle: 1, brake: 0, boostIn: false }), 1) });
  window.__solo(1); window.__place(0, 1100, -3.5, 0, 120); window.__place(1, 1101, 3.5, 0, 120); H.racer(1).topMul = 1;
  out.push({ case: 'side by side', ...window.__run(1.2, () => ({ steer: -0.6, throttle: 1, brake: 0, boostIn: false }), 1) });
  return out;
});

await browser.close();
fs.writeFileSync(path.join(OUT, `hits_${TAG}.json`), JSON.stringify(res, null, 1));
console.log(`hull: ${JSON.stringify(res.hull)}`);
for (const k of ['canyon', 'arena', 'rocks', 'pods']) console.table(res[k]);
