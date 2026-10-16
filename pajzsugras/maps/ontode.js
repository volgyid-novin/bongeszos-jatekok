// ÖNTÖDE: a rusty steel foundry at dusk. Catwalks and girders over a molten lake (a lava kill volume under everything), slag
// pots, crane stones, lifts and a low pipe gate; the furnace (the finish) with a column of heat above it is the landmark you see
// from the start. Könnyű: every gap is <= ~60 % of what its technique reaches (run jump 6.5 m flat, jump + DJ 11.4, DJ onto
// +1.5 m 9.8, dodge 6.0 under the gate, dodge + DJ 14.1; the proof bot from a perfect edge takeoff), and every landing deck is
// long enough for a full-power jump (a short landing is what really fails people, not the gap).
//
//   S1 loading yard, two run jumps (3.2 / 3.8 m)       S5 lift 1: a vertical lift, closed front, side exit (the first lift)
//   S2 gangway up, a double-jump gap (6.8 m)           S6 rail car: a horizontal lift, jump off it while it moves (lift jump)
//   S3 girder bridge, a run jump (3.9 m)               S7 crane stones: seven double jumps up (5.4 m, +1.4 m each)
//   S4 slag pots: six round platforms (3.9 m)          S8 a run down, the low pipe gate (dodge 3.6 m), a dodge jump (8.2 m),
//                                                          lift 3 (+13 m, a 3 m hop off it) and the furnace
//
// Layout: a chain of frames like kikepzes.js. `cur` is the frame at the far end of the last element (heading local -z);
// deck() / gap() / gangway() / liftV() / liftH() make their geometry inside b.group() of their frame, and the proof route
// reads the same frames, so it follows edits of the lengths. The upper tiers also get a void slab 9-12 m under the deck so that
// a fall ends in about a second. The lift phases (PH) are tuned so that the proof route never waits for a lift.
import { defineMap } from '../sim/builder.js';
import { R } from '../sim/bot.js';
import { rotY, mulberry32 } from '../sim/math.js';

const EMBER = 0xff7a1a, MOLTEN = 0xff4a08, STEEL = 0x4a4a50, DARK = 0x3a3236, RUST = 0x8a4a2a, BRICKC = 0x8a4a32, WOOD = 0x5a4636;
const LAKE = -6;   // top of the molten lake (kill volume)
// lift phases (s), tuned so that the proof route meets every lift just as it arrives
const PH = { lift1: 1.992, liftH: 0.692, lift3: 4.025 };
const GAP = { j1: 3.2, j2: 3.8, dj: 6.8, j3: 3.9, pot: 3.4, hl: 6.0, stone: 5.4, gate: 3.6, dj2: 8.2, l3: 3.0 };

export default defineMap({
  id: 'ontode', name: 'ÖNTÖDE', diff: 'konnyu', order: 2, authorTime: 60.442,
  blurb: 'Rozsdás öntöde catwalkokkal és felvonókkal. Dupla ugrás, felvonós ugrás, rövid kiugrások.',
  theme: {
    sky: { type: 'gradient', top: 0x1c1210, horizon: 0xc8683a, bottom: 0x3a2218, sunDir: [0.3, 0.25, -0.6], sunColor: 0xff9a50 },
    fog: { color: 0x4a2a1c, near: 50, far: 520 },
    hemi: { sky: 0xc08050, ground: 0x3a2014, intensity: 0.9 }, sun: { color: 0xff9a50, intensity: 1.3 },
    palette: { floor: 0x6a5a4e, wall: 0x7a4a30, trim: EMBER, accent: 0xffb030, glow: MOLTEN, danger: 0xff3010 },
    bloom: 0.9, ambient: 'forge',
  },
}, (b) => {
  b.mat('floor', { base: 'grate', color: 0x6a5a4e, trim: EMBER });
  b.mat('wall', { base: 'rust', color: 0x7a4a30, trim: 0xffa040 });
  b.mat('trim', { base: 'neon', color: EMBER, emissive: EMBER });
  b.mat('plate', { base: 'panel', color: 0x5e5048, trim: EMBER });
  b.mat('steel', { base: 'metal', color: STEEL, trim: EMBER });
  b.mat('hazard', { base: 'hazard', color: 0xe8a010, trim: 0x201810 });
  b.mat('lift', { base: 'metal', color: 0xc89638, trim: EMBER });
  b.mat('lava', { base: 'neon', color: MOLTEN, emissive: MOLTEN });
  b.mat('slag', { base: 'rock', color: 0x2a201c, trim: EMBER });
  b.mat('brick', { base: 'concrete', color: BRICKC, trim: EMBER });
  b.mat('dark', { base: 'rust', color: 0x2c2420, trim: EMBER });
  b.mat('hot', { base: 'neon', color: 0xffb060, emissive: 0xff8a30 });
  b.mat('window', { base: 'neon', color: 0xffc070, emissive: 0xffa040 });

  // ---------- frames ----------
  const frame = (at, yaw) => ({ at, yaw, p: (x, y, z) => { const q = rotY([x, y, z], yaw); return [q[0] + at[0], q[1] + at[1], q[2] + at[2]]; } });
  const XZ = (f, x, z) => { const q = f.p(x, 0, z); return [q[0], q[2]]; };
  const inF = (f, fn) => b.group({ at: f.at, yaw: f.yaw }, fn);
  let cur = frame([0, 0, 0], 0);
  const route = [];
  const W = 7;   // catwalk width
  const rnd = mulberry32(7117);

  // ---------- pieces ----------
  const pillarDown = (f, x, z, w = 0.8, dy = 0) => { const h = f.at[1] + dy - LAKE; b.deco('pillar', { pos: [x, dy - 0.7 - h / 2 + 0.2, z], size: [w, h, w], color: DARK }); };
  // the lake kills below tier 0; the upper tiers get a void slab 9-12 m under the deck
  const voidSlab = (f, len) => { if (f.at[1] > 4) b.kill([-14, -12, 0], [14, -9, -len], 'void'); };
  const edgeTrim = (w, len) => { for (const s of [-1, 1]) b.decoBrush('box', [s * (w / 2 - 0.16) - 0.06, 0.004, -len + 0.3], [s * (w / 2 - 0.16) + 0.06, 0.03, -0.3], { mat: 'trim' }); };
  const lip = (w, len) => b.decoBrush('box', [-w / 2, 0.004, -len], [w / 2, 0.03, -len + 0.45], { mat: 'hazard' });   // takeoff edge
  const rails = (w, len, z0 = 1.8, z1 = 1.8) => {
    for (const s of [-1, 1]) {
      const x0 = s > 0 ? w / 2 - 0.14 : -w / 2, x1 = s > 0 ? w / 2 : -w / 2 + 0.14;
      b.box([x0, 0, -len + z1], [x1, 1.05, -z0], { mat: 'steel' });
      b.decoBrush('box', [x0 - 0.02, 1.05, -len + z1], [x1 + 0.02, 1.11, -z0], { mat: 'trim' });
      for (let z = z0 + 1; z < len - z1; z += 3) b.decoBrush('box', [x0 - 0.01, 0, -z - 0.06], [x1 + 0.01, 1.05, -z + 0.06], { mat: 'dark' });
    }
  };
  const supports = (f, w, len) => {
    for (const z of len > 9 ? [-len * 0.25, -len * 0.75] : [-len / 2]) {
      pillarDown(f, -(w / 2 - 0.7), z); pillarDown(f, w / 2 - 0.7, z);
      b.deco('beam', { pos: [0, -0.95, z], size: [w + 0.4, 0.4, 0.4], color: DARK });
    }
  };
  const deck = (len, o = {}) => {
    const f = cur, w = o.w ?? W;
    inF(f, () => {
      b.box([-w / 2, -0.7, -len], [w / 2, 0, 0], { mat: o.mat || 'floor' });
      edgeTrim(w, len);
      if (o.lip !== false) lip(w, len);
      if (o.rails ?? (len >= 9 && w >= 4)) rails(w, len);
      supports(f, w, len);
      voidSlab(f, len);
      if (o.pipe && len >= 6) b.deco('pipe', { pos: [-(w / 2 + 0.9), -0.6, -len / 2], size: [len, 0.5, 0.5], yaw: 90, color: 0x6a5040 });
    });
    cur = frame(f.p(0, 0, -len), f.yaw);
    return f;
  };
  const gap = (len, dy = 0) => {
    const f = cur;
    inF(f, () => voidSlab(f, len));
    cur = frame(f.p(0, dy, -len), f.yaw);
    return f;
  };
  const gangway = (len, rise, w = W) => {
    const f = cur;
    inF(f, () => {
      const pts = [];
      for (const x of [-w / 2, w / 2]) pts.push([x, 0, 0], [x, rise, -len], [x, -0.7, 0], [x, rise - 0.7, -len]);
      b.hull(pts, { mat: 'floor' });
      for (const s of [-1, 1]) {
        const x0 = s > 0 ? w / 2 - 0.14 : -w / 2, x1 = s > 0 ? w / 2 : -w / 2 + 0.14;
        b.hull([[x0, 0, 0], [x1, 0, 0], [x0, rise, -len], [x1, rise, -len], [x0, 1.05, 0], [x1, 1.05, 0], [x0, rise + 1.05, -len], [x1, rise + 1.05, -len]], { mat: 'steel' });
        b.decoBrush('hull', [[x0, 1.05, 0], [x1, 1.05, 0], [x0, rise + 1.05, -len], [x1, rise + 1.05, -len], [x0, 1.1, 0], [x1, 1.1, 0], [x0, rise + 1.1, -len], [x1, rise + 1.1, -len]], { mat: 'trim' });
      }
      for (const z of [-len * 0.3, -len * 0.7]) { pillarDown(f, -(w / 2 - 0.7), z, 0.8, rise * (-z / len)); pillarDown(f, w / 2 - 0.7, z, 0.8, rise * (-z / len)); b.deco('beam', { pos: [0, rise * (-z / len) - 0.95, z], size: [w + 0.4, 0.4, 0.4], color: DARK }); }
      voidSlab(f, len);
    });
    cur = frame(f.p(0, rise, -len), f.yaw);
    return f;
  };
  const cp = (label, w = 3.4, z0 = -0.5, z1 = -9) => b.checkpoint([-w, 0, z0], [w, 12, z1], { spawn: [0, 0, -3], yaw: 0, label });
  const turn = (side, len, w) => { cur = frame(cur.p(-side * w / 2, 0, len / 2), cur.yaw + side * 90); };   // side +1 left, -1 right
  const arrows = (...zs) => zs.forEach((z) => b.glyph([0, 0.02, z], 'arrow', 0));
  const light = (x, y, z, c = 0xffa050, i = 1, r = 16) => b.light([x, y, z], c, i, r);
  // a glowing post on each side (takeoff / landing cue)
  const beaconPosts = (z, w = W, h = 3.2, color = 0xff6a20) => { for (const s of [-1, 1]) { b.deco('pillar', { pos: [s * (w / 2 + 0.4), h / 2, z], size: [0.35, h, 0.35], color: 0x2c2420 }); b.deco('beacon', { pos: [s * (w / 2 + 0.4), h + 0.3, z], size: [0.5, 0.7, 0.5], color }); } };

  // lifts: a 6 x 6 deck with side rails. Vertical: closed front (so nobody runs off), entered from behind, left at the top
  // through the open side. Horizontal: open front (you jump off it).
  const LL = 6, LW = 6;
  const liftBody = (o) => {
    b.box([-LW / 2, -0.6, -0.08 - LL], [LW / 2, 0, -0.08], { mat: 'lift' });
    for (const s of [-1, 1]) {
      if (o.exit && s === (o.exit === 'R' ? 1 : -1)) continue;
      const x0 = s > 0 ? LW / 2 - 0.14 : -LW / 2, x1 = s > 0 ? LW / 2 : -LW / 2 + 0.14;
      b.box([x0, 0, -0.08 - LL], [x1, 1.05, -0.08], { mat: 'lift' });
      b.decoBrush('box', [x0 - 0.02, 1.05, -0.08 - LL], [x1 + 0.02, 1.11, -0.08], { mat: 'trim' });
    }
    if (o.exit) {
      b.box([-LW / 2, 0, -0.08 - LL], [LW / 2, 1.3, -0.08 - LL + 0.14], { mat: 'lift' });
      b.decoBrush('box', [-LW / 2, 1.3, -0.08 - LL - 0.02], [LW / 2, 1.36, -0.08 - LL + 0.16], { mat: 'trim' });
      const ex = o.exit === 'R' ? 1 : -1;   // the open side gets a hazard edge
      b.decoBrush('box', [ex > 0 ? LW / 2 - 0.4 : -LW / 2, 0.004, -0.08 - LL], [ex > 0 ? LW / 2 : -LW / 2 + 0.4, 0.03, -0.08], { mat: 'hazard' });
    } else {
      b.decoBrush('box', [-LW / 2, 0.004, -0.08 - LL], [LW / 2, 0.03, -0.08 - LL + 0.45], { mat: 'hazard' });
    }
    b.decoBrush('box', [-1.2, -0.7, -0.08 - LL / 2 - 0.3], [1.2, -0.6, -0.08 - LL / 2 + 0.3], { mat: 'steel' });
  };
  const liftV = (id, rise, o = {}) => {
    const f = cur, ex = o.exit === 'L' ? -1 : 1, gx = o.gap ?? 0.08;
    inF(f, () => {
      b.mover(id, { path: [[0, rise, 0]], speed: o.speed ?? 3.5, wait: o.wait ?? 2, phase: o.phase ?? 0 }, () => liftBody({ exit: o.exit || 'R' }));
      // the tower: two posts on the closed side and a gantry over the top
      const bot = LAKE - f.at[1], top = rise + 7;
      for (const z of [-0.08, -0.08 - LL]) {
        b.deco('pillar', { pos: [-ex * (LW / 2 + 0.5), (top + bot) / 2, z], size: [0.45, top - bot, 0.45], color: WOOD });
        b.deco('beam', { pos: [ex * 1.5, top, z], size: [LW + 4, 0.5, 0.5], color: EMBER });
      }
      b.deco('beam', { pos: [-ex * (LW / 2 + 0.5), top, -0.08 - LL / 2], size: [LL, 0.5, 0.5], color: WOOD, yaw: 90 });
      light(0, rise + 4.5, -0.08 - LL / 2, 0xffb060, 1.2, 16);
      light(0, 3, -0.08 - LL / 2, 0xffb060, 1, 14);
    });
    cur = frame(f.p(ex * (LW / 2 + gx), rise, -0.08 - LL / 2), f.yaw - ex * 90);
    return f;
  };
  const liftH = (id, travel, endGap, o = {}) => {
    const f = cur;
    inF(f, () => {
      b.mover(id, { path: [[0, 0, -travel]], speed: o.speed ?? 4, wait: o.wait ?? 1.5, phase: o.phase ?? 0 }, () => liftBody({}));
      voidSlab(f, LL + travel + endGap + 0.2);
      // the gantry track over the whole ride
      const L = LL + travel, bot = LAKE - f.at[1];
      for (const s of [-1, 1]) {
        b.deco('beam', { pos: [s * 3.8, 6.2, -L / 2 - 0.08], size: [L + 4, 0.6, 0.6], color: WOOD, yaw: 90 });
        for (let z = 0; z < L + 1; z += 7) b.deco('pillar', { pos: [s * 3.8, (6.2 + bot) / 2, -z - 0.08], size: [0.5, 6.2 - bot, 0.5], color: DARK });
      }
      for (const z of [0, L / 3, (2 * L) / 3, L]) b.deco('beam', { pos: [0, 6.2, -z - 0.08], size: [8, 0.4, 0.4], color: EMBER });
      for (let z = 4; z < L + 8; z += 8) light(0, 3, -z, 0xff9040, 1, 14);
      b.sign([-4.6, 2.6, 6], 0, { title: 'SÍNES KOCSI', keys: 'ugorj le menet közben + SPACE', text: 'Állj a kocsira, és ha közel a túlsó part, ugorj le róla: a lendülete hozzáadódik. A csúcson újra SPACE.' });
      b.glyph([0, 0.02, 3], 'arrow', 0);
      beaconPosts(-L - endGap - 0.5, 10, 3.2);
    });
    cur = frame(f.p(0, 0, -LL - travel - 0.08 - endGap), f.yaw);
    return f;
  };

  // ================= S1: the loading yard =================
  const YARD = 48, YW = 16;
  const f0 = deck(YARD, { w: YW, mat: 'plate', rails: false });
  inF(f0, () => {
    b.start([0, 0, -7], 0);
    // back wall and side walls (real: nobody walks off the yard), the warehouse door behind the start
    b.box([-YW / 2, 0, -0.5], [YW / 2, 1.3, 0.1], { mat: 'steel' });
    b.decoBrush('box', [-14, -0.7, 0.1], [14, 17, 12], { mat: 'brick' });
    b.decoBrush('box', [-4.4, 0, 0.06], [4.4, 7.4, 0.1], { mat: 'hot' });
    b.decoBrush('box', [-5, 0, 0.0], [-4.4, 8, 0.12], { mat: 'dark' }); b.decoBrush('box', [4.4, 0, 0.0], [5, 8, 0.12], { mat: 'dark' });
    b.decoBrush('box', [-5, 7.4, 0.0], [5, 8, 0.12], { mat: 'dark' });
    for (const s of [-1, 1]) {
      const x0 = s > 0 ? YW / 2 - 0.4 : -YW / 2, x1 = s > 0 ? YW / 2 : -YW / 2 + 0.4;
      b.box([x0, 0, -YARD + 4], [x1, 1.2, -0.5], { mat: 'steel' });
      b.decoBrush('box', [x0 - 0.03, 1.2, -YARD + 4], [x1 + 0.03, 1.27, -0.5], { mat: 'trim' });
    }
    // crates (real) along the walls
    const crate = (x, z, s, y = 0) => b.box([x - s / 2, y, z - s / 2], [x + s / 2, y + s, z + s / 2], { mat: 'wall' });
    crate(-6.4, -14, 2.2); crate(-6.4, -14, 1.5, 2.2); crate(-6.2, -22, 2.6); crate(6.4, -18, 2.4); crate(6.4, -18, 1.6, 2.4); crate(6.0, -27, 2.2); crate(-6.3, -31, 2.0);
    // rail tracks and sleepers on the floor
    for (const s of [-1, 1]) b.decoBrush('box', [s * 2.3 - 0.06, 0.004, -YARD + 5], [s * 2.3 + 0.06, 0.07, -2], { mat: 'steel' });
    for (let z = -2.4; z > -YARD + 5; z -= 1.4) b.decoBrush('box', [-2.9, 0.002, z - 0.12], [2.9, 0.04, z + 0.12], { mat: 'dark' });
    arrows(-12, -20, -28, -36);
    // overhead crane: runways, a bridge and a hook on a chain
    for (const s of [-1, 1]) { b.deco('beam', { pos: [s * 7.6, 11, -YARD / 2], size: [YARD, 0.7, 0.7], color: WOOD, yaw: 90 }); for (const z of [-3, -20, -37]) b.deco('pillar', { pos: [s * 7.6, 5, z], size: [0.8, 11, 0.8], color: WOOD }); }
    b.deco('beam', { pos: [0, 10.4, -24], size: [16, 0.8, 0.8], color: EMBER });
    b.deco('cable', { pos: [0.5, 10, -24], to: [0.5, 4.6, -24], color: 0x1c1816 });
    b.deco('crate', { pos: [0.5, 3.8, -24], size: [1.8, 1.6, 1.8], color: RUST });
    b.deco('screen', { pos: [0, 9.2, -0.5], size: [6, 1.2, 0.2], yaw: 180, color: EMBER });
    b.sign([-4.2, 2.6, -11], 0, { title: 'ÖNTÖDE', keys: 'W A S D · SPACE', text: 'Fuss előre a nyilak mentén a kemencéig. A láva öl, de az ellenőrzőpont azonnal visszahoz.' });
    light(0, 5, -10, 0xffb070, 1.2, 22); light(0, 5, -30, 0xff9040, 1.2, 22);
    beaconPosts(-YARD + 0.6, YW - 6, 3.2);
  });
  gap(GAP.j1);
  const d1 = deck(10, { pipe: true });
  inF(d1, () => { arrows(-5); light(0, 3, -2, 0xff8030, 1, 14); });
  gap(GAP.j2);
  const d2 = deck(12);
  inF(d2, () => { cp('1 · RAKODÓ'); arrows(-6); });
  route.push(R.jump({ edge: true, to: XZ(d1, 0, -5) }));
  route.push(R.jump({ edge: true, to: XZ(d2, 0, -6) }));

  // ================= S2: gangway and the double-jump gap =================
  gangway(12, 3.2);
  const dg = deck(8);
  gap(GAP.dj);
  const d3 = deck(10);
  inF(dg, () => {
    b.glyph([0, 0.02, -7.0], 'dj', 0);
    light(0, 3, -3, 0xff8030, 1, 14);
    beaconPosts(-0.5, W, 3);
    // a ladle on a crane trolley hangs over the wide channel
    const zc = -8 - GAP.dj / 2;
    b.deco('beam', { pos: [0, 12, zc], size: [W + 6, 0.8, 0.8], color: WOOD });
    for (const s of [-1, 1]) b.deco('pillar', { pos: [s * (W / 2 + 2.8), 5.5, zc], size: [0.8, 12, 0.8], color: WOOD });
    for (const s of [-1, 1]) b.deco('cable', { pos: [s * 1.2, 11.6, zc], to: [s * 1.2, 9.4, zc], color: 0x1c1816 });
    b.decoBrush('hull', [[-1.9, 9.4, zc - 1.6], [1.9, 9.4, zc - 1.6], [-1.9, 9.4, zc + 1.6], [1.9, 9.4, zc + 1.6], [-1.2, 6.4, zc - 0.9], [1.2, 6.4, zc - 0.9], [-1.2, 6.4, zc + 0.9], [1.2, 6.4, zc + 0.9]], { mat: 'dark' });
    b.decoBrush('box', [-1.0, 6.35, zc - 0.8], [1.0, 6.45, zc + 0.8], { mat: 'hot' });
  });

  // ================= S3: girder bridge =================
  const gird = deck(16, { w: 2.4, lip: false });
  inF(gird, () => { for (const z of [-3, -8, -13]) b.deco('beam', { pos: [0, 5.4, z], size: [3.6, 0.3, 0.3], color: EMBER }); b.deco('pipe', { pos: [-2.2, 5.2, -8], size: [16, 0.4, 0.4], yaw: 90, color: 0x6a5040 }); });
  gap(GAP.j3);
  const d4 = deck(12);
  inF(d4, () => { cp('2 · LÁVAHÍD'); arrows(-6); });
  route.push(R.jump({ edge: true, to: XZ(d3, 0, -5), dj: 'apex' }));
  route.push(R.jump({ edge: true, to: XZ(d4, 0, -6) }));

  // ================= S4: slag pots =================
  const POT_R = 2.5, PX = [0, 1.5, -1.5, 1.5, -1.5, 0];
  const hs = cur, pots = [];
  let pz = 0;
  PX.forEach((x) => { pz -= GAP.pot + POT_R; pots.push([x, pz]); pz -= POT_R; });
  inF(hs, () => {
    pots.forEach(([x, z], i) => {
      b.prism([x, -0.35, z], POT_R, 0.7, { sides: 12, mat: 'floor' });
      b.decoBrush('prism', [x, 0.015, z], POT_R - 0.12, 0.03, { sides: 12, mat: 'trim' });
      b.decoBrush('prism', [x, 0.03, z], POT_R - 0.42, 0.03, { sides: 12, mat: 'floor' });
      b.decoBrush('prism', [x, -1.2, z], 1.3, 1.0, { sides: 8, mat: 'dark' });
      // each pot hangs from the crane runway overhead on two chains
      b.deco('cable', { pos: [x - 1.2, 11, z], to: [x - 1.8, 0.1, z + 0.3], color: 0x1c1816 });
      b.deco('cable', { pos: [x + 1.2, 11, z], to: [x + 1.8, 0.1, z - 0.3], color: 0x1c1816 });
      if (i % 2 === 0) light(x, 2.5, z, 0xff8a40, 1, 13);
    });
    for (const s of [-1, 1]) b.deco('beam', { pos: [s * 6, 11.6, pz / 2], size: [-pz + 6, 0.7, 0.7], color: WOOD, yaw: 90 });
    for (let i = 0; i < 4; i++) b.deco('pillar', { pos: [i % 2 ? 6 : -6, (11.6 + LAKE - hs.at[1]) / 2, pz * (0.15 + i * 0.28)], size: [0.8, 11.6 - (LAKE - hs.at[1]), 0.8], color: WOOD });
    voidSlab(hs, -pz);
  });
  inF(hs, () => arrows(1.8));
  cur = frame(hs.p(0, 0, pz), hs.yaw);
  pots.forEach(([x, z]) => route.push(R.jump({ edge: true, to: XZ(hs, x, z) })));
  gap(GAP.pot);
  const d4b = deck(8);
  inF(d4b, () => {
    b.sign([-3.0, 2.6, -2.2], 0, { title: 'FELVONÓ', keys: 'lépj rá és várj', text: 'Állj a lent várakozó felvonóra: felvisz a következő szintre. Fent oldalt lépj le.' });
    arrows(-6.2);
  });
  route.push(R.jump({ edge: true, to: XZ(d4b, 0, -4) }));

  // ================= S5: lift 1 (vertical, exit to the right) =================
  const L1 = liftV('lift1', 8, { exit: 'R', phase: PH.lift1, speed: 3, wait: 1.5 });
  const d5 = deck(22, { pipe: true });
  inF(d5, () => { cp('3 · FELVONÓ'); arrows(-4); });
  route.push(R.run(...XZ(L1, 0, 1.5), { stop: true, tol: 0.4 }));
  route.push(R.waitMover('lift1', { near: [0, 0, 0], tol: 0.05, within: 0.8 }));
  route.push(R.run(...XZ(L1, 0, -LL / 2), { tol: 0.4 }));
  route.push(R.waitMover('lift1', { near: [0, 8, 0], tol: 0.05 }));
  route.push(R.run(...XZ(d5, 0, -6), { tol: 0.6 }));

  // ================= S6: rail car (horizontal lift) =================
  const TR = 14;
  const LH = liftH('liftH', TR, GAP.hl, { phase: PH.liftH, speed: 6, wait: 1.5 });
  const d6 = deck(12, { w: 10, rails: false });
  inF(d6, () => { cp('4 · KOCSIPÁLYA', 4.5); for (const x of [-1.5, -3, -4.4]) b.glyph([x, 0.02, -6], 'arrow', 90); });
  route.push(R.run(...XZ(LH, 0, 1.5), { stop: true, tol: 0.4 }));
  route.push(R.waitMover('liftH', { near: [0, 0, 0], tol: 0.05, within: 0.8 }));
  route.push(R.run(...XZ(LH, 0, -LL / 2), { tol: 0.4 }));
  route.push(R.waitMover('liftH', { near: rotY([0, 0, -3], LH.yaw), tol: 0.1 }));
  route.push(R.jump({ edge: true, dj: 'apex', to: XZ(d6, 0, -6) }));

  // ================= S7: crane stones =================
  turn(1, 12, 10);
  const stones = [];
  for (let i = 0; i < 7; i++) { gap(GAP.stone, 1.4); stones.push(deck(6.4, { w: 5 })); }
  gap(GAP.stone, 1.4);
  const d7 = deck(12, { w: 10, rails: false });
  inF(d7, () => { cp('5 · DARUTORONY', 4.5); for (const x of [1.5, 3, 4.4]) b.glyph([x, 0.02, -6], 'arrow', -90); });
  {
    // the crane runway over the stones, each stone on two chains
    const top = stones[stones.length - 1].at[1] + 12, a = stones[0], z = stones[stones.length - 1];
    const L = Math.hypot(z.at[0] - a.at[0], z.at[2] - a.at[2]) + 6;
    inF(a, () => {
      for (const sx of [-1, 1]) b.deco('beam', { pos: [sx * 2.2, top - a.at[1], -L / 2 + 3], size: [L + 4, 0.6, 0.6], color: WOOD, yaw: 90 });
      b.glyph([0, 0.02, -5.4], 'dj', 0);
    });
    stones.forEach((f, i) => inF(f, () => {
      const ly = top - f.at[1];
      for (const sx of [-1, 1]) b.deco('cable', { pos: [sx * 2.2, ly, -3.2], to: [sx * 2.45, 0.05, -3.2], color: 0x1c1816 });
      if (i > 0) b.glyph([0, 0.02, -5.4], 'arrow', 0);
      if (i % 2 === 0) light(0, 3, -3.2, 0xff8a40, 1, 13);
    }));
  }
  route.push(R.run(...XZ(d6, 0, -10), { tol: 1.0 }));
  stones.forEach((f) => route.push(R.jump({ edge: true, to: XZ(f, 0, -3.2), dj: 'apex' })));
  route.push(R.jump({ edge: true, to: XZ(d7, 0, -6), dj: 'apex' }));
  turn(-1, 12, 10);

  // ================= S8: a run down, the low pipe gate, a dodge jump =================
  gangway(14, -4);
  const d8 = deck(8);
  gap(GAP.gate);
  const d9 = deck(10);
  gap(GAP.dj2);
  const d9b = deck(10);
  inF(d8, () => {
    const z0 = 1, z1 = -(8 + GAP.gate + 1);
    b.box([-W / 2 - 0.6, 2.3, z1], [W / 2 + 0.6, 3.6, z0], { mat: 'hazard' });
    for (const s of [-1, 1]) b.box([s > 0 ? W / 2 : -W / 2 - 0.6, -9, z1], [s > 0 ? W / 2 + 0.6 : -W / 2, 3.6, z0], { mat: 'wall' });
    for (const x of [-2.4, 0, 2.4]) b.deco('pipe', { pos: [x, 4.1, (z0 + z1) / 2], size: [z0 - z1 + 1, 0.55, 0.55], yaw: 90, color: 0x6a5040 });
    light(0, 1.9, (z0 + z1) / 2, 0xffa050, 1, 12);
    b.sign([-3.0, 2.6, -2.6], 0, { title: 'ALACSONY CSŐ', keys: '2× koppintás egy irányra', text: 'A cső alatt nincs hely ugrani: kiugrással (dodge) csússz át a résen.' });
    arrows(-5);
  });
  inF(d9, () => { arrows(-5); beaconPosts(-9.5, W, 3.2); });
  inF(d9b, () => { beaconPosts(-0.6, W, 3.2); });
  route.push(R.run(...XZ(d7, -2, -6), { tol: 1.0 }));
  route.push(R.run(...XZ(d8, 0, -3), { tol: 1.0 }));
  route.push(R.dodge('F', { edge: true, to: XZ(d9, 0, -5) }));
  route.push(R.dodgeJump('F', { edge: true, to: XZ(d9b, 0, -5) }));

  // ================= S9: lift 3 and the furnace =================
  const L3 = liftV('lift3', 13, { exit: 'L', gap: GAP.l3, phase: PH.lift3, speed: 3.2, wait: 1.5 });
  const d10 = deck(27, { w: 14, lip: false });
  inF(d10, () => {
    cp('6 · KEMENCE', 6); b.finish([-3, 0, -22], [3, 6, -26]);
    arrows(-5, -11, -17);
    b.sign([-4.5, 2.6, -8], 0, { title: 'KÉSZ AZ ÖNTÖDE!', keys: 'gratulálunk', text: 'Lépj be a kemence izzó szájába. Jöhet a következő pálya!' });
    // the furnace: a real front (nobody walks into it), a deep body, a glowing door, three stacks
    const Z0 = -21, BOT = LAKE - d10.at[1] - 6;
    b.box([-18, -0.7, Z0 - 6], [-4.6, 40, Z0], { mat: 'brick' });
    b.box([4.6, -0.7, Z0 - 6], [18, 40, Z0], { mat: 'brick' });
    b.box([-4.6, 8.2, Z0 - 6], [4.6, 40, Z0], { mat: 'brick' });
    b.decoBrush('box', [-18, BOT, Z0 - 6], [18, -0.7, Z0], { mat: 'dark' });
    b.decoBrush('box', [-18, BOT, Z0 - 36], [18, 34, Z0 - 6], { mat: 'brick' });
    b.decoBrush('box', [-4.4, 0, Z0 - 6.06], [4.4, 8.2, Z0 - 6], { mat: 'hot' });
    b.decoBrush('box', [-4.6, 0, Z0 - 6.0], [-4.4, 8.2, Z0], { mat: 'trim' });
    b.decoBrush('box', [4.4, 0, Z0 - 6.0], [4.6, 8.2, Z0], { mat: 'trim' });
    b.decoBrush('box', [-4.6, 8.0, Z0 - 6.0], [4.6, 8.2, Z0], { mat: 'trim' });
    // glowing molten falls from the side vents into the lake
    for (const s of [-1, 1]) {
      b.decoBrush('box', [s * 12 - 0.7, BOT, Z0 + 0.02], [s * 12 + 0.7, 27, Z0 + 0.5], { mat: 'hot' });
      b.decoBrush('box', [s * 12 - 1.1, 26, Z0 + 0.02], [s * 12 + 1.1, 28.5, Z0 + 0.7], { mat: 'dark' });
    }
    // brick courses, pipes and the big ring over the door
    for (const y of [12, 18, 24, 30]) b.decoBrush('box', [-18.1, y, Z0 - 0.2], [18.1, y + 0.35, Z0 + 0.2], { mat: 'dark' });
    for (const y of [15, 21]) b.deco('pipe', { pos: [0, y, Z0 + 0.8], size: [34, 0.7, 0.7], color: 0x6a5040 });
    for (const x of [-15.5, 15.5]) b.deco('pillar', { pos: [x, 12, Z0 + 0.9], size: [0.9, 70, 0.9], color: 0x6a5040 });
    b.deco('ring', { pos: [0, 24, Z0 + 0.4], size: [20, 20, 1.2], color: EMBER });
    b.deco('beacon', { pos: [0, 34 + 110, Z0 - 20], size: [7, 220, 7], color: 0xff7a20 });   // a column of heat into the smoke: visible from the start
    b.decoBrush('box', [-14, 33, Z0 + 0.05], [14, 36, Z0 + 0.6], { mat: 'hot' });
    b.deco('arch', { pos: [0, 5.3, Z0 + 0.5], size: [10.6, 10.6, 0.9], color: 0xffa040 });
    b.deco('screen', { pos: [-11, 5, Z0 + 0.3], size: [4.5, 2.4, 0.3], color: EMBER }); b.deco('screen', { pos: [11, 5, Z0 + 0.3], size: [4.5, 2.4, 0.3], color: EMBER });
    // the stacks: the landmark, taller than anything else
    for (const x of [-10, 0, 10]) {
      const h = x === 0 ? 96 : 78;
      b.decoBrush('prism', [x, 34 + h / 2, Z0 - 20], 3.4, h, { sides: 10, mat: 'brick' });
      for (const t of [0.35, 0.62, 0.86]) b.decoBrush('prism', [x, 34 + h * t, Z0 - 20], 3.7, 1.3, { sides: 10, mat: 'trim' });
      b.decoBrush('prism', [x, 34 + h - 0.6, Z0 - 20], 3.9, 1.4, { sides: 10, mat: 'dark' });
      b.deco('beacon', { pos: [x, 34 + h + 2.2, Z0 - 20], size: [1.6, 4, 1.6], color: 0xff3020 });
    }
    light(0, 4, Z0 + 2, 0xff8a30, 1.8, 28); light(0, 12, -8, 0xff9040, 1.2, 26);
  });
  route.push(R.run(...XZ(L3, 0, 1.5), { stop: true, tol: 0.4 }));
  route.push(R.waitMover('lift3', { near: [0, 0, 0], tol: 0.05, within: 0.8 }));
  route.push(R.run(...XZ(L3, 0, -LL / 2), { tol: 0.4 }));
  route.push(R.waitMover('lift3', { near: [0, 13, 0], tol: 0.05 }));
  route.push(R.jump({ edge: true, to: XZ(d10, 0, -6) }));
  route.push(R.run(...XZ(d10, 0, -24), { tol: 0.8 }));

  // ================= scenery =================
  // the molten lake (a hair under the kill volume, so it never z-fights with it) and cooling slag plates
  b.kill([-700, LAKE - 3, -700], [700, LAKE, 700], 'lava');
  b.decoBrush('box', [-700, LAKE - 3, -700], [700, LAKE - 0.12, 700], { mat: 'lava' });
  for (let i = 0; i < 70; i++) {
    const x = -140 + rnd() * 380, z = 70 - rnd() * 470, r = 2 + rnd() * 8;
    b.decoBrush('prism', [x, LAKE - 0.05, z], r, 0.2, { sides: 6 + Math.floor(rnd() * 3), mat: 'slag', yaw: rnd() * 90 });
  }
  for (const [x, z] of [[-20, -30], [20, -70], [-20, -120], [25, -170], [70, -150], [90, -210], [60, -250], [120, -230], [140, -300]]) light(x, LAKE + 4, z, 0xff5010, 1.3, 30);
  // smokestacks and foundry halls around, glowing bands on them
  const stacks = [[-34, -40, 3.6, 70], [-46, -125, 4.2, 92], [30, -62, 3, 58], [34, -140, 3.4, 66], [-26, -205, 4.6, 100], [14, -232, 3.2, 62], [82, -140, 4, 84], [112, -190, 3.6, 70], [140, -255, 4.4, 96], [60, -318, 3.4, 74], [150, -330, 5, 110], [-80, -80, 5, 120], [-70, -250, 4, 80]];
  for (const [x, z, r, h] of stacks) {
    b.decoBrush('prism', [x, LAKE + h / 2 - 8, z], r, h + 16, { sides: 10, mat: 'brick' });
    for (const t of [0.4, 0.7, 0.9]) b.decoBrush('prism', [x, LAKE - 8 + (h + 16) * t, z], r + 0.3, 1.1, { sides: 10, mat: 'trim' });
    b.deco('beacon', { pos: [x, LAKE + h + 10, z], size: [1.2, 3, 1.2], color: 0xff3020 });
  }
  for (let i = 0; i < 18; i++) {
    const a = rnd() * Math.PI * 2, d = 190 + rnd() * 230, x = 70 + Math.cos(a) * d * 1.1, z = -170 + Math.sin(a) * d;
    const w = 20 + rnd() * 34, dd = 20 + rnd() * 30, h = 18 + rnd() * 50;
    b.decoBrush('box', [x - w / 2, LAKE - 12, z - dd / 2], [x + w / 2, LAKE - 12 + h, z + dd / 2], { mat: 'dark' });
    b.decoBrush('box', [x - w / 2 - 0.15, LAKE - 12 + h * 0.62, z - dd / 2 - 0.15], [x + w / 2 + 0.15, LAKE - 12 + h * 0.62 + 1.3, z + dd / 2 + 0.15], { mat: 'window' });
  }

  b.route(route);
});
