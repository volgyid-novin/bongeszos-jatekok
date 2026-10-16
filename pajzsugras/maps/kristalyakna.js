// KRISTÁLYAKNA: an abandoned crystal mine. A dark cavern full of glowing crystals, timber galleries and rails over a bottomless
// chasm; the Heart (a giant crystal on the far side of the cavern, with a beam of light) is the landmark you can see from the
// start. Közepes: most gaps are ~75 % of what their technique reaches (run jump 6.5 m flat, jump + DJ 11.4, DJ onto +1.5 m 9.8,
// dodge + DJ 14.1, wall-dodge chute 16.8, a standing wall-dodge hop between 3 m deep ledges 2.4 m higher: 8.8-9.1 m, full
// shield jump + DJ 8.0 m up; the proof bot from a perfect takeoff).
//
//   S1 entrance, two run jumps (4.2 / 4.8 m), the mine incline     S5 the mine cart over a chasm (a mover, 24 m)
//   S2 wall-dodge chute (11 m)                                     S6 a dodge jump (10.4 m), then the switchback up to the terrace
//   S3 wall-dodge shaft: four standing hops (6.5 m, +2.4 each)         ... or the SKIP: a full-charge shield jump straight up the 5.9 m wall
//   S4 a run jump (4.8 m), the cage lift (+16 m)                   S7 two dodge jumps in a row, a second shaft (5 hops), seven crystal
//                                                                      outcrops (7.2 m, +1.5 m each), the last chute (12.6 m): the Heart
//
// Layout: a chain of frames like kikepzes.js (lane 1 north along x = 0, a connector east, lane 2 south, a connector east, lane 3
// north to the Heart). `cur` is the frame at the far end of the last element (heading local -z). The switchback and the skip
// share the proof route: pre + detour + post (main) and pre + skip + post. Both movers sit BEFORE the skip, so the time it saves
// is real (a periodic lift after it would just eat the difference). The lift and the cart phases (PH) are tuned to the proof route.
import { defineMap } from '../sim/builder.js';
import { R } from '../sim/bot.js';
import { rotY, mulberry32 } from '../sim/math.js';

const VIO = 0xb060ff, CYAN = 0x60f0ff, PINK = 0xff70c0, WARM = 0xffb868;
const GAP = { j1: 4.2, j2: 4.8, chute1: 11.0, dj: 10.4, stone: 7.2, hopA: 6.5, hopB: 6.8, chute2: 12.6 };
const PH = { lift: 3.492, cart: 4.017 };

export default defineMap({
  id: 'kristalyakna', name: 'KRISTÁLYAKNA', diff: 'kozepes', order: 4, authorTime: 91.892,
  blurb: 'Kristálybánya falugrásos aknákkal. Kiugrás a falról, kiugrásos ugrások, pajzsos rövidítés.',
  theme: {
    sky: { type: 'gradient', top: 0x120a22, horizon: 0x3a2060, bottom: 0x0a0614, sunDir: [0, 1, 0], sunColor: 0xb080ff },
    fog: { color: 0x1c1034, near: 35, far: 560 },
    hemi: { sky: 0x7050b0, ground: 0x1a1030, intensity: 0.7 }, sun: { color: 0xa070ff, intensity: 0.6 },
    palette: { floor: 0x4a4060, wall: 0x2f2a45, trim: VIO, accent: CYAN, glow: 0xc080ff, danger: 0xff4080 },
    bloom: 1.1, ambient: 'cave',
  },
}, (b) => {
  b.mat('floor', { base: 'rock', color: 0x5c5282, trim: VIO });
  b.mat('wall', { base: 'rock', color: 0x2a2540, trim: VIO });
  b.mat('walldodge', { base: 'stripe', color: 0x5a4e8a, trim: CYAN, emissive: 0x2a1a70 });
  b.mat('trim', { base: 'neon', color: VIO, emissive: VIO });
  b.mat('trimC', { base: 'neon', color: CYAN, emissive: CYAN });
  b.mat('timber', { base: 'panel', color: 0x6a4a30, trim: 0x3a2818 });
  b.mat('iron', { base: 'metal', color: 0x6a6a7a, trim: VIO });
  b.mat('lift', { base: 'metal', color: 0x8a8aa0, trim: CYAN });
  b.mat('hazard', { base: 'hazard', color: 0xe0b020, trim: 0x201830 });
  b.mat('rockdark', { base: 'rock', color: 0x1c1830, trim: VIO });
  b.mat('cV', { base: 'crystal', color: 0xa060ff, emissive: 0x7a3ae0 });
  b.mat('cC', { base: 'crystal', color: 0x50e8ff, emissive: 0x20b8e0 });
  b.mat('cP', { base: 'crystal', color: 0xff70c8, emissive: 0xc02a90 });
  b.mat('heart', { base: 'crystal', color: 0xd8f4ff, emissive: 0x70d8ff });
  b.mat('lamp', { base: 'neon', color: WARM, emissive: 0xff9a40 });
  b.mat('glowfloor', { base: 'neon', color: 0x3a1a70, emissive: 0x2a1060 });

  // ---------- frames ----------
  const trail = [];
  const frame = (at, yaw) => (trail.push(at), { at, yaw, p: (x, y, z) => { const q = rotY([x, y, z], yaw); return [q[0] + at[0], q[1] + at[1], q[2] + at[2]]; } });
  const XZ = (f, x, z) => { const q = f.p(x, 0, z); return [q[0], q[2]]; };
  const inF = (f, fn) => b.group({ at: f.at, yaw: f.yaw }, fn);
  let cur = frame([0, 0, 0], 0);
  const route = [];
  const rnd = mulberry32(5150);
  const voidSlab = (f, len, w = 14) => b.kill([-w, -12, 0], [w, -9, -len], 'void');

  // ---------- decoration helpers (local coordinates of the active group) ----------
  const light = (x, y, z, c = VIO, i = 1.2, r = 16) => b.light([x, y, z], c, i, r);
  const CM = ['cV', 'cC', 'cP'];
  const crystal = (x, y, z, h, r, mat, dx = 0, dz = 0) => {
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI) / 3;
      pts.push([x + Math.cos(a) * r, y, z + Math.sin(a) * r]);
      pts.push([x + dx * 0.72 + Math.cos(a) * r * 0.78, y + h * 0.72, z + dz * 0.72 + Math.sin(a) * r * 0.78]);
    }
    pts.push([x + dx, y + h, z + dz]);
    b.decoBrush('hull', pts, { mat });
  };
  // a crystal growing sideways out of a wall (its axis along x, dir = +1 / -1)
  const crystalX = (x, y, z, len, r, dir, mat) => {
    const pts = [];
    for (let i = 0; i < 6; i++) { const a = (i * Math.PI) / 3; pts.push([x, y + Math.cos(a) * r, z + Math.sin(a) * r]); pts.push([x + dir * len * 0.72, y + Math.cos(a) * r * 0.78, z + Math.sin(a) * r * 0.78]); }
    pts.push([x + dir * len, y, z]);
    b.decoBrush('hull', pts, { mat });
  };
  const cluster = (x, y, z, s, mat, n = 5) => {
    for (let i = 0; i < n; i++) crystal(x + (rnd() - 0.5) * 2.2 * s, y, z + (rnd() - 0.5) * 2.2 * s, (1.1 + rnd() * 2.2) * s, (0.22 + rnd() * 0.28) * s, mat || CM[Math.floor(rnd() * 3)], (rnd() - 0.5) * 1.3 * s, (rnd() - 0.5) * 1.3 * s);
  };
  // a rough convex rock
  const blob = (cx, cy, cz, rx, ry, rz, mat = 'rockdark') => {
    const pts = [];
    for (let i = 0; i < 12; i++) { const a = rnd() * Math.PI * 2, e = (rnd() - 0.5) * 2, k = Math.sqrt(1 - e * e * 0.7) * (0.65 + rnd() * 0.35); pts.push([cx + Math.cos(a) * rx * k, cy + e * ry, cz + Math.sin(a) * rz * k]); }
    b.decoBrush('hull', pts, { mat });
  };
  const lamp = (x, y, z) => { b.decoBrush('box', [x - 0.2, y - 0.2, z - 0.2], [x + 0.2, y + 0.2, z + 0.2], { mat: 'lamp' }); light(x, y - 0.1, z, WARM, 0.9, 14); };
  // a mine gallery: timber frames every 8 m with lamps, rails on the floor, trestles down into the dark
  const gallery = (len, w, o = {}) => {
    // (o.gal === 'low': no timber frames, e.g. over a wall-dodge chute, where a beam across the slot would look like an obstacle)
    for (let z = -4, i = 0; o.gal !== 'low' && z > -len + 1.5; z -= 8, i++) {
      for (const s of [-1, 1]) b.decoBrush('box', [s * (w / 2 + 0.15) - 0.17, -0.8, z - 0.17], [s * (w / 2 + 0.15) + 0.17, 3.7, z + 0.17], { mat: 'timber' });
      b.decoBrush('box', [-w / 2 - 0.5, 3.45, z - 0.2], [w / 2 + 0.5, 3.9, z + 0.2], { mat: 'timber' });
      if (i % 2 === 0) lamp((i % 4 === 0 ? -1 : 1) * (w / 2 + 0.15), 3.0, z + 0.45);
    }
    if (o.rails !== false) {
      for (const s of [-1, 1]) b.decoBrush('box', [s * 1.1 - 0.05, 0.004, -len + 1], [s * 1.1 + 0.05, 0.07, -1], { mat: 'iron' });
      for (let z = -1.6; z > -len + 1; z -= 1.7) b.decoBrush('box', [-1.5, 0.002, z - 0.1], [1.5, 0.04, z + 0.1], { mat: 'timber' });
    }
    for (let z = -2; z > -len; z -= 10) {
      for (const s of [-1, 1]) b.deco('pillar', { pos: [s * (w / 2 - 0.5), -13.8, z], size: [0.5, 26, 0.5], color: 0x3a2c22 });
      b.deco('beam', { pos: [0, -9, z], size: [w, 0.3, 0.3], color: 0x3a2c22 });
    }
  };

  // ---------- pieces ----------
  const deck = (len, o = {}) => {
    const f = cur, w = o.w ?? 7;
    inF(f, () => {
      b.box([-w / 2, -0.8, -len], [w / 2, 0, 0], { mat: o.mat || 'floor' });
      voidSlab(f, len);
      for (const s of [-1, 1]) b.decoBrush('box', [s * (w / 2 - 0.1) - 0.05, 0.004, -len + 0.3], [s * (w / 2 - 0.1) + 0.05, 0.03, -0.3], { mat: 'trim' });
      if (o.lip !== false && len >= 4) b.decoBrush('box', [-w / 2, 0.004, -len], [w / 2, 0.03, -len + 0.3], { mat: 'trimC' });
      if (o.gal) gallery(len, w, o);
    });
    cur = frame(f.p(0, 0, -len), f.yaw);
    return f;
  };
  const gap = (len, dy = 0) => { const f = cur; inF(f, () => voidSlab(f, len)); cur = frame(f.p(0, dy, -len), f.yaw); return f; };
  const ledge = (len, dy, w = 8, mat = 'wall') => {
    const f = cur;
    inF(f, () => { b.box([-w / 2, -8, -len], [w / 2, dy, 0], { mat }); voidSlab(f, len); });
    cur = frame(f.p(0, dy, -len), f.yaw);
    return frame(f.p(0, dy, 0), f.yaw);   // the top of the ledge, at its near edge
  };
  const gangway = (len, rise, w = 4.6) => {
    const f = cur;
    inF(f, () => {
      const pts = [];
      for (const x of [-w / 2, w / 2]) pts.push([x, 0, 0], [x, rise, -len], [x, -0.8, 0], [x, rise - 0.8, -len]);
      b.hull(pts, { mat: 'floor' });
      for (const s of [-1, 1]) b.decoBrush('hull', [[s * (w / 2 - 0.1) - 0.05, 0.01, 0], [s * (w / 2 - 0.1) + 0.05, 0.01, 0], [s * (w / 2 - 0.1) - 0.05, rise + 0.03, -len], [s * (w / 2 - 0.1) + 0.05, rise + 0.03, -len], [s * (w / 2 - 0.1) - 0.05, 0.05, 0], [s * (w / 2 - 0.1) + 0.05, 0.05, 0], [s * (w / 2 - 0.1) - 0.05, rise + 0.07, -len], [s * (w / 2 - 0.1) + 0.05, rise + 0.07, -len]], { mat: 'trim' });
      voidSlab(f, len);
    });
    cur = frame(f.p(0, rise, -len), f.yaw);
    return f;
  };
  const cp = (label, w = 3.4, z0 = -0.5, z1 = -9) => b.checkpoint([-w, 0, z0], [w, 12, z1], { spawn: [0, 0, -3], yaw: 0, label });
  const turn = (side, len, w) => { cur = frame(cur.p(-side * w / 2, 0, len / 2), cur.yaw + side * 90); };

  // the wall-dodge chute: two striped walls 1.7 m apart over the gap (like the one in KIKÉPZÉS), a funnel at the entrance
  const chuteWalls = (f, run, gp, tail, w = 8) => {
    const zEnd = -(run + gp + tail);
    inF(f, () => {
      for (const s of [-1, 1]) {
        const pts = [];
        for (const y of [-9, 8]) for (const q of [[s * w / 2, -(run - 15)], [s * 0.85, -(run - 8)], [s * 0.85, zEnd], [s * w / 2, zEnd]]) pts.push([q[0], y, q[1]]);
        b.hull(pts, { mat: 'walldodge' });
        // crystals on top of the walls, light in the slot
        for (let z = -(run - 6); z > zEnd + 2; z -= 7) cluster(s * 0.85, 8, z, 0.6, CM[(Math.abs(Math.round(z)) + (s > 0 ? 1 : 0)) % 3], 3);
      }
      for (let z = -(run - 8); z > zEnd; z -= 9) light(0, 4, z, CYAN, 1.1, 13);
    });
  };

  // a wall-dodge shaft: striped walls, `hops` ledges alternating west / east, HOPD higher each; entered through a doorway at the
  // bottom (south end, west side), left through a doorway at the top (north end, on the side of the last ledge). The ledges have
  // no runway toward the next one: a standing jump + wall dodge off the wall behind you + a double jump crosses it.
  const HOPD = 2.4;
  const shaft = (hops, G, o = {}) => {
    const f0 = cur, D = o.depth ?? 3, SW = G / 2 + D, top = hops * HOPD, H = top + 9, ex = hops % 2 ? 1 : -1;
    const S = frame(f0.p(SW - D / 2, 0, 0), f0.yaw);
    inF(S, () => {
      b.box([-SW - 2, -14, 0], [-SW, H, -11.4], { mat: 'walldodge' });
      b.box([SW, -14, 0], [SW + 2, H, -11.4], { mat: 'walldodge' });
      // south end wall (doorway on the west side), north end wall (doorway on the exit side)
      b.box([-SW + 6, -14, 0], [SW, H, -1.2], { mat: 'wall' });
      b.box([-SW, 4.6, 0], [-SW + 6, H, -1.2], { mat: 'wall' });
      b.box([-SW, -14, -10.2], [SW, top - 0.8, -11.4], { mat: 'wall' });
      b.box(ex > 0 ? [-SW, top - 0.8, -10.2] : [-SW + 6, top - 0.8, -10.2], ex > 0 ? [SW - 6, H, -11.4] : [SW, H, -11.4], { mat: 'wall' });
      b.box(ex > 0 ? [SW - 6, top + 4.6, -10.2] : [-SW, top + 4.6, -10.2], ex > 0 ? [SW, H, -11.4] : [-SW + 6, H, -11.4], { mat: 'wall' });
      // floors: the entry, the ledges, the exit
      b.box([-SW, -0.8, -4.5], [-SW + 6, 0, 0], { mat: 'floor' });
      b.box([-SW, -0.8, -10.2], [-SW + D, 0, -4.5], { mat: 'floor' });
      for (let k = 1; k <= hops; k++) {
        const east = k % 2 === 1, y = k * HOPD;
        b.box([east ? SW - D : -SW, y - 0.8, -2.5], [east ? SW : -SW + D, y, k === hops ? -10.2 : -9.5], { mat: 'floor' });
      }
      b.box(ex > 0 ? [SW - 6, top - 0.8, -8.5] : [-SW, top - 0.8, -8.5], ex > 0 ? [SW, top, -11.4] : [-SW + 6, top, -11.4], { mat: 'floor' });
      b.kill([-SW, -4, -1.2], [SW, -2, -10.2], 'void');
      b.kill([-14, -12, 0], [14, -9, -11.4], 'void');
      // dressing: glowing ledge edges, a light and small wall crystals at every ledge, wall-dodge glyphs where you stand
      for (let k = 0; k <= hops; k++) {
        const east = k % 2 === 1, y = k * HOPD, wx = east ? SW : -SW, dir = east ? -1 : 1;
        b.decoBrush('box', [east ? SW - D : -SW, y + 0.004, -9.2], [east ? SW - D + 0.25 : -SW + D, y + 0.03, -2.6], { mat: 'trimC' });
        light(wx + dir * 2.2, y + 3, -6.5, k % 2 ? CYAN : VIO, 1.3, 14);
        for (const z of [-3.2, -9.5]) crystalX(wx, y + 4.6 + (z < -5 ? 0.6 : 0), z, 0.6, 0.22, dir, CM[(k + (z < -5 ? 1 : 0)) % 3]);
        if (o.glyphs) b.glyph([wx + dir * 0.55, y + 0.02, -6.5], 'walldodge', east ? 90 : -90);
      }
      for (const s of [-1, 1]) for (let y = -9; y < H - 4; y += 6.5) crystalX(s * SW, y, y % 2 ? -1.9 : -10.0, 0.7, 0.2, -s, CM[Math.abs(Math.round(y)) % 3]);
    });
    cur = frame(S.p(ex * (SW - D / 2), top, -11.4), f0.yaw);
    // the proof route: hug the wall behind the ledge, jump, wall dodge at once, double jump at the apex
    const steps = [];
    const hug = (k) => (k % 2 === 0 ? -SW + 0.45 : SW - 0.45), mid = (k) => (k % 2 === 0 ? -SW + D / 2 : SW - D / 2);
    for (let k = 0; k < hops; k++) {
      steps.push(R.run(...XZ(S, hug(k), -6.5), { stop: true, tol: 0.15 }));
      steps.push(R.jump({ to: XZ(S, mid(k + 1), -6.5), air: [R.wallDodge('F', { at: 'wall' })], dj: 'apex' }));
    }
    return { S, steps };
  };

  // a mine cart: a 6 x 6 car on rails, entered from behind, open in front (flush with the platform at the far station)
  const LL = 6, LW = 6;
  const cartBody = () => {
    b.box([-LW / 2, -0.6, -0.08 - LL], [LW / 2, 0, -0.08], { mat: 'lift' });
    for (const s of [-1, 1]) {
      b.box([s > 0 ? LW / 2 - 0.14 : -LW / 2, 0, -0.08 - LL], [s > 0 ? LW / 2 : -LW / 2 + 0.14, 1.05, -0.08], { mat: 'lift' });
      b.decoBrush('box', [s * LW / 2 - 0.08, 1.05, -0.08 - LL], [s * LW / 2 + 0.08, 1.12, -0.08], { mat: 'trimC' });
    }
    b.decoBrush('box', [-LW / 2, 0.004, -0.08 - LL], [LW / 2, 0.03, -0.08 - LL + 0.4], { mat: 'hazard' });
    for (const s of [-1, 1]) for (const z of [-1.2, -LL + 1.1]) b.decoBrush('prism', [s * 2.4, -0.9, z], 0.55, 0.3, { sides: 8, mat: 'iron', yaw: 0 });
  };

  // ================= S1: entrance, two run jumps =================
  const E0 = deck(52, { w: 8, gal: true });
  inF(E0, () => {
    b.start([0, 0, -6], 0);
    // the mine entrance behind the start: a real rock wall, a dark tunnel mouth in a timber portal
    b.box([-14, -14, 0.1], [14, 30, 4], { mat: 'wall' });
    b.decoBrush('box', [-3.4, 0, 0.0], [3.4, 5.4, 0.12], { mat: 'rockdark' });
    for (const s of [-1, 1]) b.decoBrush('box', [s * 3.8 - 0.4, -0.8, -0.3], [s * 3.8 + 0.4, 6.4, 0.2], { mat: 'timber' });
    b.decoBrush('box', [-4.4, 5.6, -0.3], [4.4, 6.5, 0.2], { mat: 'timber' });
    lamp(-3.2, 5.0, -0.6); lamp(3.2, 5.0, -0.6);
    for (const s of [-1, 1]) cluster(s * 8.5, 0.5, 6, 1.3, CM[s > 0 ? 1 : 0], 5);
    // a cart and barrels at the side of the rails, glowing ore in the cart
    b.box([3.0, 0, -13.6], [4.6, 1.0, -11.4], { mat: 'iron' });   // (real: it stands next to the rails)
    cluster(3.8, 1.0, -12.5, 0.45, 'cC', 4);
    for (const z of [-9, -9.9]) b.decoBrush('prism', [-3.2, 0.5, z], 0.38, 1.0, { sides: 8, mat: 'timber' });
    b.sign([-3.4, 2.6, -12], 0, { title: 'KRISTÁLYAKNA', keys: 'W A S D · SPACE', text: 'Elhagyott kristálybánya. A távoli, ragyogó kristály, a Szív a cél. A csíkos falak a falról kiugráshoz valók.' });
    light(0, 5, -8, VIO, 1.4, 22); light(0, 4, -28, CYAN, 1.2, 20);
    for (const [x, z, m] of [[5.6, -20, 'cV'], [-5.8, -26, 'cC'], [5.2, -33, 'cP']]) { blob(x, -2.6, z, 2.2, 1.8, 2.2); cluster(x, -1.2, z, 0.9, m, 4); }
  });
  gap(GAP.j1);
  const d1 = deck(10);
  inF(d1, () => { light(0, 3, -4, CYAN, 1.0, 12); cluster(-4.4, -0.6, -6, 0.8, 'cV', 3); });
  gap(GAP.j2);
  const d2 = deck(8);
  inF(d2, () => { cluster(4.4, -0.6, -3, 0.8, 'cP', 3); });
  route.push(R.jump({ edge: true, to: XZ(d1, 0, -5) }));
  route.push(R.jump({ edge: true, to: XZ(d2, 0, -4) }));
  // the mine incline: a long ramp up, rails on it, timber frames with lamps over it
  const INC = 40, INCR = 6;
  const inc = gangway(INC, INCR, 6);
  inF(inc, () => {
    for (const s of [-1, 1]) b.decoBrush('hull', [[s * 1.1 - 0.05, 0.01, 0], [s * 1.1 + 0.05, 0.01, 0], [s * 1.1 - 0.05, INCR + 0.03, -INC], [s * 1.1 + 0.05, INCR + 0.03, -INC], [s * 1.1 - 0.05, 0.08, 0], [s * 1.1 + 0.05, 0.08, 0], [s * 1.1 - 0.05, INCR + 0.1, -INC], [s * 1.1 + 0.05, INCR + 0.1, -INC]], { mat: 'iron' });
    for (let z = -5, i = 0; z > -INC + 2; z -= 8, i++) {
      const y = (INCR * -z) / INC;
      for (const s of [-1, 1]) b.decoBrush('box', [s * 3.35 - 0.17, y - 0.8, z - 0.17], [s * 3.35 + 0.17, y + 3.7, z + 0.17], { mat: 'timber' });
      b.decoBrush('box', [-3.8, y + 3.45, z - 0.2], [3.8, y + 3.9, z + 0.2], { mat: 'timber' });
      if (i % 2 === 0) lamp((i % 4 === 0 ? -1 : 1) * 3.35, y + 3.0, z + 0.45);
      for (const s of [-1, 1]) b.deco('pillar', { pos: [s * 2.4, y - 13.8, z], size: [0.5, 26, 0.5], color: 0x3a2c22 });
    }
    cluster(-4.5, -0.6, -12, 1.2, 'cC', 5); cluster(4.6, INCR * 0.6 - 0.6, -24, 1.2, 'cV', 5);
  });

  // ================= S2: wall-dodge chute =================
  const RUN = 22, TAIL = 9;
  const run = deck(RUN, { w: 8, gal: 'low', rails: false });
  gap(GAP.chute1);
  const G1 = deck(16, { w: 8, gal: 'low', rails: false });
  chuteWalls(run, RUN, GAP.chute1, TAIL);
  inF(run, () => {
    b.sign([-3.6, 2.6, -5], 0, { title: 'FALRÓL KIUGRÁS', keys: 'ugrás · levegőben 2× előre a fal mellett · SPACE', text: 'A szűk, csíkos folyosóban ugorj, majd a levegőben kiugrás előre a fal mentén; utána dupla ugrás a túloldalra.' });
    b.glyph([0, 0.02, -RUN + 3.4], 'walldodge', 0);
  });
  inF(G1, () => cp('1 · FOLYOSÓ'));
  route.push(R.run(...XZ(run, 0, -9), { tol: 1.0 }));
  route.push(R.jump({ edge: true, to: XZ(G1, 0, -8), air: [R.wallDodge('F', { at: 'wall' })], dj: 'apex' }));

  // ================= S3: the wall-dodge shaft =================
  const shA = shaft(4, GAP.hopA, { glyphs: true });
  inF(shA.S, () => b.sign([-3.2, 2.6, 4.2], 0, { title: 'AKNA', keys: 'állj a falhoz · SPACE · kiugrás a faltól · SPACE', text: 'Állj neki a csíkos falnak, ugorj, és azonnal kiugrás a szemközti perem felé; a csúcson dupla ugrás.' }));
  route.push(...shA.steps);
  const X1 = deck(32, { w: 6, gal: true });
  inF(X1, () => cp('2 · AKNA'));
  route.push(R.run(...XZ(X1, 0, -8), { tol: 1.0 }));

  // ================= S4: the cage lift (up the main shaft) =================
  const NC = deck(8, { w: 8 });
  inF(NC, () => { cluster(-5.4, -0.6, -3, 1, 'cC', 4); light(0, 3, -4, VIO, 1.1, 14); });
  route.push(R.run(...XZ(NC, 0, -4), { tol: 1.0 }));
  turn(-1, 8, 8);
  deck(14, { w: 7, gal: true });
  gap(GAP.j2);
  const N1b = deck(22, { w: 7, gal: true });
  route.push(R.jump({ edge: true, to: XZ(N1b, 0, -8) }));
  const RISE = 16;
  const liftF = cur;
  inF(liftF, () => {
    b.mover('lift', { path: [[0, RISE, 0]], speed: 3.4, wait: 1.2, phase: PH.lift }, () => {
      b.box([-LW / 2, -0.6, -0.08 - LL], [LW / 2, 0, -0.08], { mat: 'lift' });
      b.box([-LW / 2, 0, -0.08 - LL], [-LW / 2 + 0.14, 1.05, -0.08], { mat: 'lift' });   // the right side stays open: the exit
      b.box([-LW / 2, 0, -0.08 - LL], [LW / 2, 1.3, -0.08 - LL + 0.14], { mat: 'lift' });
      b.decoBrush('box', [LW / 2 - 0.4, 0.004, -0.08 - LL], [LW / 2, 0.03, -0.08], { mat: 'hazard' });
      b.decoBrush('box', [-LW / 2, 1.3, -0.08 - LL - 0.02], [LW / 2, 1.36, -0.08 - LL + 0.16], { mat: 'trimC' });
      b.deco('pillar', { pos: [-LW / 2 + 0.3, 6, -0.08 - LL / 2], size: [0.12, 12, 0.12], color: 0x2a2a30 });
    });
    // the head frame: timber posts around the shaft, a crown with a pulley wheel
    const top = RISE + 11;
    for (const sx of [-1, 1]) for (const z of [-0.08, -0.08 - LL]) b.deco('pillar', { pos: [sx * (LW / 2 + 0.9), top / 2 - 7, z], size: [0.6, top + 14, 0.6], color: 0x5a3e2a });
    for (const z of [-0.08, -0.08 - LL]) b.deco('beam', { pos: [0, top, z], size: [LW + 2.4, 0.6, 0.6], color: 0x5a3e2a });
    b.deco('beam', { pos: [0, top + 0.1, -0.08 - LL / 2], size: [LL, 0.5, 0.5], color: 0x5a3e2a, yaw: 90 });
    b.deco('ring', { pos: [0, top + 1.8, -0.08 - LL / 2], size: [3.4, 3.4, 0.5], yaw: 90, color: CYAN });
    light(0, 3, -3.1, CYAN, 1.4, 16); light(0, RISE + 4, -3.1, VIO, 1.3, 16);
    b.sign([-3.2, 2.6, 5], 0, { title: 'BÁNYALIFT', keys: 'lépj rá és várj', text: 'A lift felviszi a következő szintre. Fent jobbra lépj le róla.' });
  });
  cur = frame(liftF.p(LW / 2 + 0.08, RISE, -0.08 - LL / 2), liftF.yaw - 90);
  const EG = deck(16, { w: 7, gal: true });
  inF(EG, () => cp('3 · FŐAKNA'));
  route.push(R.run(...XZ(liftF, 0, 1.5), { stop: true, tol: 0.4 }));
  route.push(R.waitMover('lift', { near: [0, 0, 0], tol: 0.05, within: 0.6 }));
  route.push(R.run(...XZ(liftF, 0, -LL / 2), { tol: 0.4 }));
  route.push(R.waitMover('lift', { near: [0, RISE, 0], tol: 0.05 }));
  route.push(R.run(...XZ(EG, 0, -6), { tol: 0.6 }));

  // ================= S5: the mine cart over a chasm =================
  const TRAVEL = 24;
  const cartF = cur;
  inF(cartF, () => {
    b.mover('cart', { path: [[0, 0, -TRAVEL]], speed: 6, wait: 1.5, phase: PH.cart }, cartBody);
    voidSlab(cartF, LL + TRAVEL + 0.4);
    // the track: two iron beams on timber trestles over the whole ride
    const Lt = LL + TRAVEL + 0.4;
    for (const s of [-1, 1]) b.deco('beam', { pos: [s * 2.4, -0.95, -Lt / 2], size: [Lt, 0.3, 0.3], color: 0x6a6a7a, yaw: 90 });
    for (let z = 0; z > -Lt; z -= 6) b.deco('beam', { pos: [0, -1.1, z - 0.08], size: [6.4, 0.25, 0.25], color: 0x4a3a2a });
    for (const z of [-1, -Lt + 1]) for (const s of [-1, 1]) b.deco('pillar', { pos: [s * 2.4, -13, z], size: [0.5, 24, 0.5], color: 0x3a2c22 });
    for (let z = -6; z > -Lt; z -= 8) { b.deco('pillar', { pos: [-2.4, -13, z], size: [0.4, 24, 0.4], color: 0x3a2c22 }); b.deco('pillar', { pos: [2.4, -13, z], size: [0.4, 24, 0.4], color: 0x3a2c22 }); }
    light(0, 3, -1.5, CYAN, 1.2, 14); light(0, 3, -Lt + 1.5, VIO, 1.2, 14);
    b.sign([-3.6, 2.6, 4], 0, { title: 'BÁNYAKOCSI', keys: 'szállj fel és várd meg', text: 'A kocsi átviszi a mélység felett. Az innenső peremről lépj fel, a túloldalon le.' });
    b.glyph([0, 0.02, 3], 'arrow', 0);
  });
  cur = frame(cartF.p(0, 0, -LL - TRAVEL - 0.16), cartF.yaw);
  const CL = deck(10, { w: 8, gal: true, rails: false });
  inF(CL, () => cp('4 · KOCSI', 3.9));
  route.push(R.run(...XZ(EG, 0, -12), { tol: 1.0 }));
  route.push(R.run(...XZ(cartF, 0, 1.5), { stop: true, tol: 0.4 }));
  route.push(R.waitMover('cart', { near: [0, 0, 0], tol: 0.05, within: 0.6 }));
  route.push(R.run(...XZ(cartF, 0, -LL / 2), { tol: 0.4 }));
  route.push(R.waitMover('cart', { near: rotY([0, 0, -TRAVEL], cartF.yaw), tol: 0.05 }));
  route.push(R.run(...XZ(CL, 0, -4), { tol: 0.6 }));

  // ================= S6: a dodge jump over a chasm =================
  gap(GAP.dj);
  const P = deck(14, { w: 8 });
  route.push(R.dodgeJump('F', { edge: true, to: XZ(P, 0, -6) }));

  // ================= S7: the switchback up to the terrace T, or the shield jump up the wall =================
  const pre = route.slice();
  const post = [], detourSteps = [], skipSteps = [];
  const mainCur = cur;
  cur = frame(P.p(4, 0, -7), P.yaw - 90);
  const LA = 34, LB = 18;
  const dA = gangway(LA, 2.0);
  const plA = deck(6, { w: 6 });
  turn(1, 6, 6);
  const dB = gangway(LB, 1.9);
  const plB = deck(6, { w: 6 });
  turn(1, 6, 6);
  const dC = gangway(LA, 2.0);
  detourSteps.push(R.run(...XZ(P, 3, -7), { tol: 0.8 }), R.run(...XZ(plA, 0, -3), { tol: 1.0 }), R.run(...XZ(plB, 0, -3), { tol: 1.0 }));
  // dressing of the switchback: lamps and trestles on the plazas, crystals on the way
  for (const [pf, rise] of [[plA, 0], [plB, 0]]) inF(pf, () => {
    for (const x of [-2.4, 2.4]) for (const z of [-0.8, -5.2]) b.deco('pillar', { pos: [x, -13, z], size: [0.5, 24, 0.5], color: 0x3a2c22 });
    lamp(2.6, 2.4, -3); light(0, 3, -3, VIO, 1.0, 12);
  });
  for (const gf of [dA, dB, dC]) inF(gf, () => { b.deco('pillar', { pos: [0, -13.5, -8], size: [0.5, 24, 0.5], color: 0x3a2c22 }); cluster(-3.4, -1.2, -6, 0.9, CM[Math.floor(rnd() * 3)], 3); });
  cur = mainCur;
  inF(P, () => { lamp(-4.4, 2.4, -2); lamp(4.4, 2.4, -12); light(0, 3, -7, CYAN, 1.1, 14); });
  const T = ledge(22, 5.9, 8, 'wall');
  inF(T, () => {
    cp('5 · TERASZ', 3.9, -0.5, -21);
    // the wall face is plain rock, with a few glowing crystals up on its edge: something is up there
    for (const x of [-2.6, 0.4, 2.8]) crystal(x, -0.1, -0.7, 1.1 + rnd(), 0.25, 'cC', 0.2, -0.3);
    light(0, 2.2, -4, CYAN, 1.4, 14);
    for (const z of [-10, -19]) { lamp(-3.8, 2.3, z); lamp(3.8, 2.3, z); }
  });
  detourSteps.push(R.run(...XZ(T, 0, -(LB - 1)), { tol: 1.0 }));
  skipSteps.push(R.run(...XZ(P, 0, -13.4), { stop: true, tol: 0.25 }), R.shieldJump({ charge: 1, dj: 'apex', to: XZ(T, 0, -3) }));
  post.push(R.run(...XZ(T, 0, -16), { tol: 1.0 }));

  // ================= S8: two dodge jumps in a row =================
  const TC = deck(8, { w: 8 });
  post.push(R.run(...XZ(TC, 0, -4), { tol: 1.0 }));
  turn(1, 8, 8);
  deck(22, { w: 7, gal: true });
  gap(GAP.dj);
  const M = deck(16, { w: 7, gal: true });
  gap(GAP.dj);
  const M2 = deck(14, { w: 8, gal: true, rails: false });
  inF(M2, () => cp('6 · BARLANG', 3.9));
  inF(TC, () => { cluster(5.4, -0.6, -3, 1, 'cP', 4); });
  post.push(R.dodgeJump('F', { edge: true, to: XZ(M, 0, -6) }));
  post.push(R.dodgeJump('F', { edge: true, to: XZ(M2, 0, -6) }));

  // ================= S9: a second shaft, outcrops toward the Heart, the final chute =================
  const CC = deck(8, { w: 8 });
  inF(CC, () => { cluster(5.4, -0.6, -3, 1, 'cV', 4); light(0, 3, -4, CYAN, 1.1, 14); });
  post.push(R.run(...XZ(CC, 0, -4), { tol: 1.0 }));
  turn(1, 8, 8);
  const shB = shaft(5, GAP.hopB);
  post.push(...shB.steps);
  const X2 = deck(20, { w: 6, gal: true });
  post.push(R.run(...XZ(X2, 0, -7), { tol: 1.0 }));
  const stones = [];
  for (let i = 0; i < 7; i++) { gap(GAP.stone, 1.5); stones.push(deck(4.4, { w: 4.4 })); }
  gap(GAP.stone, 1.5);
  const RUN2 = 20;
  const run2 = deck(RUN2, { w: 8, gal: 'low', rails: false });
  inF(run2, () => cp('7 · KRISTÁLYOK'));
  // every outcrop floats on a rock with crystals growing out of it
  stones.forEach((f, i) => inF(f, () => {
    blob(0, -2.4, -2.2, 2.6, 2.0, 2.6);
    cluster(i % 2 ? 3.9 : -3.9, -1.0, -2.2, 0.8, CM[i % 3], 4);
    for (let k = 0; k < 2; k++) crystal((k ? 1 : -1) * 1.2, -4.4, -2.2 + (k ? 0.6 : -0.6), -1.5 - 0.5 * k, 0.3, CM[(i + k + 1) % 3], 0.2, 0);
    light(0, 2.4, -2.2, CM[i % 3] === 'cV' ? VIO : CM[i % 3] === 'cC' ? CYAN : PINK, 1.2, 13);
    if (i === 0) b.glyph([0, 0.02, -3.4], 'dj', 0);
  }));
  stones.forEach((f) => post.push(R.jump({ edge: true, to: XZ(f, 0, -2.2), dj: 'apex' })));
  post.push(R.jump({ edge: true, to: XZ(run2, 0, -6), dj: 'apex' }));
  gap(GAP.chute2);
  const heart = deck(14, { w: 10, gal: false });
  chuteWalls(run2, RUN2, GAP.chute2, 9);
  inF(run2, () => b.glyph([0, 0.02, -RUN2 + 3.4], 'walldodge', 0));
  // the Heart: a giant crystal cluster growing out of the far end of the last platform, a beam of light up to the ceiling
  inF(heart, () => {
    b.finish([-3, 0, -6], [3, 6, -11]);
    b.decoBrush('prism', [0, 0.02, -8.5], 5.2, 0.04, { sides: 12, mat: 'trimC' });
    blob(0, -3.2, -13.5, 9.5, 3.4, 5.5);
    crystal(0, -0.5, -15.5, 62, 6.2, 'heart', 3, -5);
    crystal(-7, -0.5, -13.5, 38, 4.2, 'cC', -3, -4);
    crystal(7.2, -0.5, -13.8, 44, 4.6, 'cV', 4, -5);
    crystal(-3.4, -0.5, -17.5, 30, 3.4, 'cP', -2, -3);
    crystal(4, -0.5, -17.8, 26, 3, 'cC', 2, -3);
    cluster(-8.5, -0.5, -4, 1.4, 'cC', 5); cluster(8.5, -0.5, -4, 1.4, 'cP', 5); cluster(-8, -0.5, -11, 1.8, 'cV', 5); cluster(8.2, -0.5, -10, 1.8, 'cC', 5);
    b.deco('beacon', { pos: [0, 60, -15.5], size: [4.5, 150, 4.5], color: 0xc8f4ff });
    b.deco('ring', { pos: [0, 34, -12.5], size: [30, 30, 1.4], color: 0x90e8ff });
    light(0, 5, -10, 0xa0f0ff, 2.6, 40); light(0, 34, -15.5, 0xd8f4ff, 2.4, 70); light(-6, 4, -4, VIO, 1.6, 22); light(6, 4, -4, PINK, 1.6, 22);
    b.sign([-3.6, 2.6, 0], 0, { title: 'A KRISTÁLY SZÍVE', keys: 'gratulálunk', text: 'Lépj a ragyogó kristályhoz. Jöhet a következő pálya!' });
  });
  post.push(R.run(...XZ(run2, 0, -10), { tol: 1.0 }));
  post.push(R.jump({ edge: true, to: XZ(heart, 0, -6), air: [R.wallDodge('F', { at: 'wall' })], dj: 'apex' }));
  post.push(R.run(...XZ(heart, 0, -9), { tol: 0.8 }));

  // ================= scenery: the cavern =================
  // distance (XZ) of a point to the whole course, so that the cavern decoration never sits on it
  const nearCourse = (x, z, r) => {
    for (let i = 0; i + 1 < trail.length; i++) {
      const a = trail[i], c = trail[i + 1], dx = c[0] - a[0], dz = c[2] - a[2], l2 = dx * dx + dz * dz;
      const t = l2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[2]) * dz) / l2)) : 0;
      if (Math.hypot(x - (a[0] + dx * t), z - (a[2] + dz * t)) < r) return true;
    }
    return false;
  };
  const X0 = -110, X1w = 260, Z0 = -340, Z1 = 90, CEIL = 150;
  // the shell: ceiling, four walls, a glowing abyss far below
  b.decoBrush('box', [X0, CEIL, Z0], [X1w, CEIL + 30, Z1], { mat: 'rockdark' });
  b.decoBrush('box', [X0 - 30, -110, Z0], [X0, CEIL + 30, Z1], { mat: 'rockdark' });
  b.decoBrush('box', [X1w, -110, Z0], [X1w + 30, CEIL + 30, Z1], { mat: 'rockdark' });
  b.decoBrush('box', [X0, -110, Z0 - 30], [X1w, CEIL + 30, Z0], { mat: 'rockdark' });
  b.decoBrush('box', [X0, -110, Z1], [X1w, CEIL + 30, Z1 + 30], { mat: 'rockdark' });
  b.decoBrush('box', [X0, -112, Z0], [X1w, -92, Z1], { mat: 'glowfloor' });
  // buttresses of rock along the walls, crystal clusters growing out of them
  for (let i = 0; i < 46; i++) {
    const side = i % 4, t = rnd();
    const x = side === 0 ? X0 + 6 + rnd() * 14 : side === 1 ? X1w - 6 - rnd() * 14 : X0 + t * (X1w - X0);
    const z = side === 2 ? Z0 + 6 + rnd() * 14 : side === 3 ? Z1 - 6 - rnd() * 14 : Z0 + t * (Z1 - Z0);
    const y = -60 + rnd() * 160, r = 12 + rnd() * 18;
    blob(x, y, z, r, 18 + rnd() * 26, r);
    if (rnd() < 0.7) { const dx = side === 0 ? 1 : side === 1 ? -1 : 0, dz = side === 2 ? 1 : side === 3 ? -1 : 0; for (let k = 0; k < 3; k++) crystal(x + dx * r * 0.6 + (rnd() - 0.5) * r, y + (rnd() - 0.5) * 30, z + dz * r * 0.6 + (rnd() - 0.5) * r, 5 + rnd() * 9, 0.9 + rnd() * 0.9, CM[(i + k) % 3], dx * 4, dz * 4); }
  }
  // stalactites from the ceiling
  for (let i = 0; i < 70; i++) {
    const x = X0 + 10 + rnd() * (X1w - X0 - 20), z = Z0 + 10 + rnd() * (Z1 - Z0 - 20), len = 12 + rnd() * 44, r = 1.6 + rnd() * 3.4;
    if (nearCourse(x, z, 14 + r) && len > 40) continue;
    const pts = [[x, CEIL - len, z]];
    for (let k = 0; k < 7; k++) { const a = (k / 7) * Math.PI * 2; pts.push([x + Math.cos(a) * r, CEIL, z + Math.sin(a) * r]); }
    b.decoBrush('hull', pts, { mat: rnd() < 0.25 ? CM[i % 3] : 'rockdark' });
  }
  // the crystal forest below the course: spires out of the abyss (never within 14 m of the course in plan)
  for (let i = 0; i < 90; i++) {
    const x = X0 + 10 + rnd() * (X1w - X0 - 20), z = Z0 + 10 + rnd() * (Z1 - Z0 - 20);
    if (nearCourse(x, z, 16)) continue;
    const h = 40 + rnd() * 90, r = 1.5 + rnd() * 3;
    crystal(x, -95, z, h, r, CM[i % 3], (rnd() - 0.5) * 6, (rnd() - 0.5) * 6);
    if (i % 5 === 0) light(x, -60, z, [VIO, CYAN, PINK][i % 3 === 0 ? 0 : i % 3 === 1 ? 1 : 2], 1.6, 50);
  }
  // lights along the course, deep in the chasms
  for (let i = 0; i < trail.length; i += 6) { const a = trail[i]; b.light([a[0], a[1] - 6, a[2]], [VIO, CYAN, PINK][i % 3], 1.3, 26); }

  b.route([...pre, ...detourSteps, ...post]);
  b.skip('pajzs a falon', [...pre, ...skipSteps, ...post]);

});
