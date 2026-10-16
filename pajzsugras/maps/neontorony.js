// NEONTORONY: a cyberpunk megatower at night. The course starts on a sky terrace, hops billboard stands to the tower's door,
// climbs the glass atrium on four full-charge shield jumps, crosses a 3 m wide light-well twice with a shield wall boost, wall
// dodges along a billboard wall, shield-jumps onto the neighbour roof, crosses a canyon (gondola, or a strafe-jump skip)
// and finally climbs the neon staircase of the sky lobby to the observation deck.
//
// Layout (x east, z south, the tower stands at the origin, the course winds around it clockwise seen from above):
//   start terrace + 3 billboard stands (south, y 0) -> door -> atrium (inside the tower, y 0..21.4) -> east window -> light-well
//   alley (x 14..17, heading north, y 21.4 / 23.4) -> north face billboard wall (heading east) -> East Block roof (y 29.4, heading
//   south) -> canyon -> south terrace -> staircase of ledges heading west to the deck (y 51.2), in front of the tower's south face.
// Margins are measured against the proof bot's edge-perfect maxima (wave 1 probe table), Közepes ~75 % (the first hops ~65 %).
import { defineMap } from '../sim/builder.js';
import { R } from '../sim/bot.js';
import { rotY, mulberry32 } from '../sim/math.js';

const CYAN = 0x00f0ff, PINK = 0xff40c0, AMBER = 0xffb020, VIOLET = 0x8060ff;
// gaps (m) and heights (m)
const GAP = { hop: [7.6, 8.2, 8.6, 9.0], boost: [16.5, 13.5], wall: [13.0, 13.4], canyon: 17.5, link: 9.0 };
const UP = { g1: 4.5, g2: 6.0, g3: 4.9, g4: 6.0, boost2: 2.0, roof: 6.0, lb: 4.9, lc: 4.9, ld: 6.0, le: 6.0 };
const Y_ATRIUM = UP.g1 + UP.g2 + UP.g3 + UP.g4, Y_BILL = Y_ATRIUM + UP.boost2, Y_ROOF = Y_BILL + UP.roof, Y_TALL = Y_ROOF + 8;
const CEIL = 36;   // the atrium's ceiling

export default defineMap({
  id: 'neontorony', name: 'NEONTORONY', diff: 'kozepes', order: 5, authorTime: 91.608,
  blurb: 'Neonfényes felhőkarcoló: üvegatrium, fényakna, reklámfal és tetőfutás. Teljes töltésű pajzsugrások, fali lökés, strafe-os rövidítés.',
  theme: {
    sky: { type: 'stars', top: 0x04041a, horizon: 0x4a1470, bottom: 0x0a0a24, sunDir: [-0.3, 0.35, -0.8], sunColor: 0xff40c0, stars: 0.8 },
    fog: { color: 0x160a38, near: 40, far: 420 },
    hemi: { sky: 0x4a58d0, ground: 0x1a1240, intensity: 0.8 }, sun: { color: 0x9070ff, intensity: 0.8 },
    palette: { floor: 0x242a46, wall: 0x141830, trim: CYAN, accent: PINK, glow: CYAN, danger: 0xff2060 },
    bloom: 1.5, ambient: 'neon',
  },
}, (b) => {
  b.mat('floor', { base: 'panel', color: 0x242a46, trim: CYAN });
  b.mat('wall', { base: 'panel', color: 0x141830, trim: PINK });
  b.mat('walldodge', { base: 'stripe', color: 0x1c1030, trim: PINK, emissive: PINK });
  b.mat('boostwall', { base: 'panel', color: 0x0c2a40, trim: CYAN, emissive: CYAN });
  b.mat('roof', { base: 'concrete', color: 0x1a2040, trim: PINK });
  b.mat('tower', { base: 'panel', color: 0x10142c, trim: CYAN });
  b.mat('trim', { base: 'neon', color: CYAN, emissive: CYAN });
  b.mat('pink', { base: 'neon', color: PINK, emissive: PINK });
  b.mat('amber', { base: 'neon', color: AMBER, emissive: AMBER });
  b.mat('glass', { base: 'glass', color: 0x2a60c0, trim: CYAN, emissive: 0x102860 });
  b.mat('lift', { base: 'metal', color: 0x3a4060, trim: AMBER });
  b.mat('puddleC', { base: 'glass', color: 0x1890c0, trim: CYAN, emissive: 0x0a5070 });
  b.mat('puddleP', { base: 'glass', color: 0xc02890, trim: PINK, emissive: 0x701850 });
  b.mat('bldgC', { base: 'panel', color: 0x0e1230, trim: CYAN });
  b.mat('bldgP', { base: 'panel', color: 0x160e2e, trim: PINK });
  b.mat('bldgA', { base: 'panel', color: 0x14122a, trim: AMBER });
  b.mat('city', { base: 'panel', color: 0x07091a, trim: PINK });

  // ---------- frames ----------
  const frame = (at, yaw = 0) => ({ at, yaw, p: (x, y, z) => { const q = rotY([x, y, z], yaw); return [q[0] + at[0], q[1] + at[1], q[2] + at[2]]; } });
  const XZ = (f, x, z) => { const q = f.p(x, 0, z); return [q[0], q[2]]; };
  const inF = (f, fn) => b.group({ at: f.at, yaw: f.yaw }, fn);
  const step = (f, len, dy = 0) => frame(f.p(0, dy, -len), f.yaw);   // the frame `len` ahead (and dy higher)
  const TH = 1;   // platform thickness
  // b.box with the corners in any order
  const box = (p, q, o) => b.box([Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.min(p[2], q[2])], [Math.max(p[0], q[0]), Math.max(p[1], q[1]), Math.max(p[2], q[2])], o);
  // the same for a decoration brush (no collision)
  const dbox = (p, q, mat) => b.decoBrush('box', [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.min(p[2], q[2])], [Math.max(p[0], q[0]), Math.max(p[1], q[1]), Math.max(p[2], q[2])], { mat });
  // a floor slab in frame f: x0..x1 across, z 0 .. -len along, top at local y 0
  const slab = (f, x0, x1, len, mat = 'floor') => inF(f, () => box([x0, -TH, -len], [x1, 0, 0], { mat }));
  // a ledge block: from `base` up to dy, x0..x1 across, z 0 .. -len
  const ledge = (f, x0, x1, len, dy, base, mat = 'floor') => inF(f, () => box([x0, base, -len], [x1, dy, 0], { mat }));
  // a checkpoint across a level (y = the floor height in frame f), tall so it cannot be flown over
  const cp = (f, label, x0, x1, z0, z1, spawn, yaw = 0, y = 0) => inF(f, () => b.checkpoint([x0, y, z0], [x1, y + 12, z1], { spawn, yaw, label }));
  const kill = (x0, x1, z0, z1, yBot, yTop) => b.kill([x0, yBot, z0], [x1, yTop, z1], 'void');

  const pre = [], gondola = [], strafeSkip = [], post = [];

  // ================= S0 + S1: sky terrace and three billboard stands (double jump gaps) =================
  const L = { terrace: 42, stand: 8, court: 22 };
  const total = L.terrace + 3 * L.stand + L.court + GAP.hop.reduce((a, c) => a + c, 0);
  const fS = frame([0, 0, 14 + total], 0);
  slab(fS, -7, 7, L.terrace);
  inF(fS, () => b.start([0, 0, -4], 0));
  const stands = [];
  let fPrev = fS, lenPrev = L.terrace;
  GAP.hop.forEach((g, i) => {
    const f = step(fPrev, lenPrev + g);
    const last = i === GAP.hop.length - 1;
    slab(f, last ? -7 : -4, last ? 7 : 4, last ? L.court : L.stand);
    stands.push(f);
    fPrev = f; lenPrev = last ? L.court : L.stand;
  });
  const fCt = stands[stands.length - 1];
  cp(fCt, '1 · TORNÁC', -7, 7, -0.5, -10, [0, 0, -4]);
  stands.forEach((f, i) => pre.push(R.jump({ edge: true, to: i === stands.length - 1 ? XZ(f, 0, -8) : XZ(f, 0, -4), dj: 'apex' })));

  // ================= S2: the atrium (inside the tower) =================
  // fA: the door, heading north; local z 0 .. -2 is the south wall, interior x -12..12, z -2 .. -26, floor y 0
  const fA = frame([0, 0, 14], 0);
  const WIN = { zMin: -7, zMax: -2 };   // the east window, local z (above the gallery G4)
  inF(fA, () => {
    box([-12, -1, -26], [12, 0, -2], { mat: 'floor' });
    box([-4.5, -1, -2], [4.5, 0, 0], { mat: 'floor' });
    // walls
    box([-14, -14, 0], [-4.5, CEIL, -2], { mat: 'tower' });
    box([4.5, -14, 0], [14, CEIL, -2], { mat: 'tower' });
    box([-4.5, 7, 0], [4.5, CEIL, -2], { mat: 'tower' });
    box([-14, -14, 0], [-12, CEIL, -28], { mat: 'boostwall' });
    box([-14, -14, -26], [14, CEIL, -28], { mat: 'tower' });
    box([12, -14, WIN.zMax], [14, CEIL, 0], { mat: 'boostwall' });
    box([12, -14, -28], [14, CEIL, WIN.zMin], { mat: 'boostwall' });
    box([12, -14, WIN.zMin], [14, Y_ATRIUM, WIN.zMax], { mat: 'boostwall' });
    box([12, Y_ATRIUM + 6, WIN.zMin], [14, CEIL, WIN.zMax], { mat: 'boostwall' });
    // the shaft above: the atrium's ceiling and the tower's body
    box([-14, CEIL, 0], [14, 130, -28], { mat: 'tower' });
    // the galleries, counter-clockwise: east wall, north wall, west wall, south wall (floating over the door)
    box([7, 0, -26], [12, UP.g1, -3], { mat: 'floor' });
    box([-12, 0, -26], [12, UP.g1 + UP.g2, -21], { mat: 'floor' });
    box([-12, 0, -21], [-7, UP.g1 + UP.g2 + UP.g3, -7], { mat: 'floor' });
    box([-12, Y_ATRIUM - 8, -7], [12, Y_ATRIUM, -2], { mat: 'floor' });
  });
  cp(fA, '2 · ATRIUM', 4, 12, -2, -7, [9, Y_ATRIUM, -4.5], 270, Y_ATRIUM);
  // the route: stand 1.2 m from each ledge face, shield jump, walk on
  pre.push(R.run(...XZ(fA, 0, -8), { tol: 0.8 }));
  pre.push(R.run(...XZ(fA, 5.8, -12), { stop: true, tol: 0.3 }));
  pre.push(R.shieldJump({ charge: 1, to: XZ(fA, 9.5, -12) }));
  pre.push(R.run(...XZ(fA, 9.5, -19.8), { stop: true, tol: 0.3 }));
  pre.push(R.shieldJump({ charge: 1, dj: 'apex', to: XZ(fA, 9.5, -23.5) }));
  pre.push(R.run(...XZ(fA, -9.5, -22.4), { stop: true, tol: 0.3 }));
  pre.push(R.shieldJump({ charge: 1, to: XZ(fA, -9.5, -18) }));
  pre.push(R.run(...XZ(fA, -9.5, -8.3), { stop: true, tol: 0.3 }));
  pre.push(R.shieldJump({ charge: 1, dj: 'apex', to: XZ(fA, -9.5, -4.5) }));
  pre.push(R.run(...XZ(fA, 9, -4.5), { tol: 0.8 }));

  // ================= S3: the light-well alley (shield wall boost, twice) =================
  // fAl: the alley floor south end, x 14..17 (3 m wide), heading north, at the atrium's top level
  const fAl = frame([15.5, Y_ATRIUM, 14], 0);
  const ALLEY_A = 28, B1 = 10, B2 = 22;
  slab(fAl, -1.5, 1.5, ALLEY_A);
  const fB1 = step(fAl, ALLEY_A + GAP.boost[0]);
  slab(fB1, -1.5, 1.5, B1);
  const fB2 = step(fB1, B1 + GAP.boost[1], UP.boost2);
  slab(fB2, -1.5, 1.5, B2);
  // the walls: the tower's east face (left) + a fin continuing it, and the neighbour block's panel (right)
  box([12.5, -30, -78], [14, 60, -14], { mat: 'boostwall' });
  box([17, -30, -76], [18, Y_TALL, 14], { mat: 'boostwall' });
  box([14, Y_ATRIUM, 14], [17, Y_ATRIUM + 3, 14.6], { mat: 'wall' });
  cp(fB1, '3 · FÉNYAKNA', -1.5, 1.5, -0.5, -B1, [0, 0, -4], 0);
  cp(fB2, '4 · FÉNYAKNA 2', -1.5, 1.5, -0.5, -B2, [0, 0, -4], 0);
  const boost = (from, lenFrom, to) => {
    pre.push(R.run(...XZ(from, -0.4, -lenFrom + 6), { stop: true, tol: 0.4 }));
    pre.push(R.charge(true, { to: 1 }));
    pre.push(R.jump({ edge: true, to: XZ(to, 0, -9), air: [R.wallBoost({ aimAt: from.p(1.5, 1.6, -lenFrom + 1), at: 0 })], dj: 'apex' }));
    pre.push(R.charge(false));
  };
  pre.push(R.run(...XZ(fA, 15.5, -4.5), { tol: 0.6 }));
  boost(fAl, ALLEY_A, fB1);
  boost(fB1, B1, fB2);

  // ================= S4: billboard wall (wall dodges) =================
  // fT: the pads hug the East Block's north face (local x +1.6), heading east
  const fT = frame([14, Y_BILL, -77.6], 270);
  const T0 = 12, PAD = 6, WALLX = 1.6;
  slab(fT, -WALLX, WALLX, T0);
  const fP1 = step(fT, T0 + GAP.wall[0]);
  slab(fP1, -WALLX, WALLX, PAD);
  const fP2 = step(fP1, PAD + GAP.wall[1]);
  slab(fP2, -WALLX, WALLX, PAD);
  // the East Block (x 18..72, z -76..8): the west part is 8 m taller, so the shield jump onto the lower roof (Y_ROOF) is only possible beside the last pad
  box([18, -30, -76], [50, Y_TALL, 8], { mat: 'roof' });
  box([50, -30, -76], [72, Y_ROOF, 8], { mat: 'roof' });
  pre.push(R.run(...XZ(fB2, 0, -B2 + 4), { tol: 1 }));
  pre.push(R.run(...XZ(fT, 1.0, -5), { tol: 0.8 }));
  pre.push(R.jump({ edge: true, to: XZ(fP1, 1.0, -2), air: [R.wallDodge('F', { at: 'wall' })], dj: 'apex' }));
  pre.push(R.jump({ edge: true, to: XZ(fP2, 1.0, -2), air: [R.wallDodge('F', { at: 'wall' })], dj: 'apex' }));
  // shield jump up the billboard wall onto the roof
  const fR = frame([60, Y_ROOF, -76], 180);
  pre.push(R.run(...XZ(fP2, 1.0, -3.0), { stop: true, tol: 0.3 }));
  pre.push(R.shieldJump({ charge: 1, dj: 'apex', to: XZ(fR, -1.6, -2.5) }));
  cp(fR, '5 · TETŐ', -14, 44, -0.5, -8, [-1.6, 0, -3], 0);

  // ================= S5: roof run + canyon + gondola =================
  // fR: the roof run, heading south, local z 0 .. -84 (world z -76 .. 8)
  const RUN = 84;
  const fC = frame(fR.p(0, 0, -RUN), 180);   // the roof's south edge
  const fD = step(fC, GAP.canyon);            // the south terrace
  slab(fD, -8, 8, 15);
  cp(fD, '6 · TÚLOLDAL', -8, 8, -0.5, -9, [0, 0, -4], 0);
  const GW = 7, GL = 6;
  inF(fC, () => {
    b.mover('gondola', { path: [[0, 0, -(GAP.canyon - GL)]], speed: 2.0, wait: 2.5 }, () => {
      box([-GW / 2, -TH, -GL], [GW / 2, 0, 0], { mat: 'lift' });
      for (const x of [-GW / 2 + 0.3, GW / 2 - 0.3]) dbox([x - 0.07, 0.004, -GL + 0.4], [x + 0.07, 0.03, -0.4], 'amber');
      dbox([-GW / 2, -TH - 0.01, -GL - 0.01], [GW / 2, -TH + 0.14, 0.01], 'amber');
      for (const x of [-GW / 2, GW / 2]) for (const z of [-0.2, -GL + 0.2]) dbox([x - 0.1, 0, z - 0.1], [x + 0.1, 1.1, z + 0.1], 'lift');
      dbox([-GW / 2, 1.1, -GL + 0.1], [-GW / 2 + 0.2, 1.2, -0.1], 'amber');
      dbox([GW / 2 - 0.2, 1.1, -GL + 0.1], [GW / 2, 1.2, -0.1], 'amber');
    });
  });
  gondola.push(R.run(...XZ(fR, 0, -8), { tol: 1.2 }));
  gondola.push(R.run(...XZ(fC, 0, 1.5), { stop: true, tol: 0.5 }));
  gondola.push(R.waitMover('gondola', { near: [0, 0, 0], tol: 0.05, within: 1.0 }));
  gondola.push(R.run(...XZ(fC, 0, -3), { tol: 0.4 }));
  gondola.push(R.waitMover('gondola', { near: [0, 0, GAP.canyon - GL], tol: 0.05 }));
  gondola.push(R.run(...XZ(fD, 0, -4), { tol: 0.8 }));
  // the skip: strafe along the roof, one jump + double jump over the whole canyon
  strafeSkip.push(R.run(...XZ(fR, 0, -39.2), { tol: 0.5 }));
  strafeSkip.push(R.strafe({ hops: 5, to: XZ(fD, 0, -8), eff: 1 }));
  strafeSkip.push(R.jump({ to: XZ(fD, 0, -8), dj: 'apex' }));
  strafeSkip.push(R.run(...XZ(fD, 0, -4), { tol: 0.8 }));

  // ================= S6: the staircase of ledges (shield jumps) =================
  // heading west from the south terrace's west edge at z 33
  const fL0 = frame([52, Y_ROOF, 33], 90);
  const LEN = 8, W6 = 6;
  const fLA = step(fL0, GAP.link);
  slab(fLA, -W6, W6, LEN);
  const fLB = step(fLA, LEN, UP.lb);
  ledge(fLB, -W6, W6, LEN, 0, -8);
  const fLC = step(fLB, LEN, UP.lc);
  ledge(fLC, -W6, W6, LEN, 0, -8);
  const fLD = step(fLC, LEN, UP.ld);
  ledge(fLD, -W6, W6, LEN, 0, -8);
  const fLE = step(fLD, LEN, UP.le);
  ledge(fLE, -W6, W6, 12, 0, -8);
  cp(fLC, '7 · LÉPCSŐ', -W6, W6, -0.5, -LEN, [0, 0, -3], 0);
  inF(fLE, () => b.finish([-5, 0, -8], [5, 6, -11]));
  post.push(R.jump({ edge: true, to: XZ(fLA, 0, -4), dj: 'apex' }));
  [[fLA, fLB, false], [fLB, fLC, false], [fLC, fLD, true], [fLD, fLE, true]].forEach(([from, to, dj]) => {
    post.push(R.run(...XZ(from, 0, -LEN + 1.2), { stop: true, tol: 0.3 }));
    post.push(R.shieldJump({ charge: 1, dj: dj ? 'apex' : false, to: XZ(to, 0, -4) }));
  });
  post.push(R.run(...XZ(fLE, 0, -10), { tol: 0.8 }));

  // ================= scenery =================
  const GROUND = -170;
  const NEON = ['trim', 'pink', 'amber'];
  const HEXMAT = { [CYAN]: 'trim', [PINK]: 'pink', [AMBER]: 'amber', [VIOLET]: 'pink' };
  // light strips on a platform in frame f (top at local y 0): along both long edges, a pink launch line on the far edge, a column down to the city
  const trimPlat = (f, x0, x1, len, o = {}) => inF(f, () => {
    for (const x of [x0 + 0.3, x1 - 0.3]) dbox([x - 0.07, 0.004, -len + 0.5], [x + 0.07, 0.03, -0.5], 'trim');
    if (o.far !== false) dbox([x0, -0.06, -len], [x1, 0.012, -len + 0.15], o.far || 'pink');
    if (o.column !== false) {
      const h = f.at[1] - 1 - GROUND, w = Math.min(3, (x1 - x0) / 3);
      b.deco('pillar', { pos: [(x0 + x1) / 2, -1 - h / 2, -len / 2], size: [w, h, w], color: 0x1a2046 });
    }
  });
  // a billboard above a stand: two posts and a screen that faces the approach
  const billboard = (f, w, len, col) => inF(f, () => {
    for (const x of [-(w / 2 + 0.6), w / 2 + 0.6]) b.deco('pillar', { pos: [x, (GROUND - f.at[1] + 7.6) / 2, -len / 2], size: [0.8, 7.6 - GROUND + f.at[1], 0.8], color: 0x1a2046 });
    b.deco('screen', { pos: [0, 9.4, -len / 2], size: [w, 3.6, 0.4], color: col });
    dbox([-w / 2 - 1, 7.5, -len / 2 - 0.2], [w / 2 + 1, 7.65, -len / 2 + 0.2], HEXMAT[col]);
  });

  // --- the start: sky terrace, stands, forecourt ---
  trimPlat(fS, -7, 7, L.terrace);
  stands.forEach((f, i) => {
    const last = i === stands.length - 1;
    trimPlat(f, last ? -7 : -4, last ? 7 : 4, last ? L.court : L.stand, { far: last ? false : 'pink' });
    if (!last) billboard(f, 8, L.stand, [PINK, CYAN, AMBER][i % 3]);
    b.light(f.p(0, 6, -L.stand / 2), i % 2 ? CYAN : PINK, 1, 20);
  });
  inF(fS, () => b.deco('arch', { pos: [0, 4.2, -L.terrace + 0.5], size: [9, 8.4, 0.5], color: PINK }));
  b.light(fS.p(0, 4, -12), PINK, 1, 24);
  inF(fCt, () => {
    for (const x of [-6, 6]) b.deco('pillar', { pos: [x, 4, -1.5], size: [0.8, 8, 0.8], color: 0x1c2250 });
    b.deco('beacon', { pos: [-6, 8.6, -1.5], size: [0.6, 1.2, 0.6], color: CYAN });
    b.deco('beacon', { pos: [6, 8.6, -1.5], size: [0.6, 1.2, 0.6], color: PINK });
  });
  b.light(fCt.p(0, 5, -8), CYAN, 1.2, 26);

  // --- the door and the atrium ---
  inF(fA, () => {
    b.deco('arch', { pos: [0, 4.2, 0.6], size: [10.4, 8.4, 0.8], color: PINK });
    b.deco('screen', { pos: [0, 10.5, 0.4], size: [9, 2.6, 0.4], color: CYAN });
    b.deco('beacon', { pos: [0, 17, -14], size: [1.6, 34, 1.6], color: CYAN });
    for (const [y, d, yaw, col] of [[8, 10, 0, PINK], [17, 13, 90, CYAN], [26, 16, 0, PINK], [30, 10, 90, CYAN]]) b.deco('ring', { pos: [0, y, -14], size: [d, d, 0.5], yaw, color: col });
    for (let i = 0; i < 5; i++) dbox([-12, CEIL - 0.22, -4 - i * 5.2], [12, CEIL, -4.3 - i * 5.2], i % 2 ? 'pink' : 'trim');
    for (const x of [-8, 0, 8]) dbox([x - 0.15, CEIL - 0.22, -2], [x + 0.15, CEIL, -26], 'trim');
    // windows on the walls
    for (const x of [-9, -4.5, 0, 4.5, 9]) dbox([x - 1.5, 13, -25.95], [x + 1.5, 32, -25.9], 'glass');
    for (const z of [-12, -16.5, -21]) dbox([11.9, 8, z - 1.5], [11.95, 32, z + 1.5], 'glass');
    for (const z of [-5, -10, -14.5, -19, -23.5]) dbox([-11.95, 18, z - 1.5], [-11.9, 32, z + 1.5], 'glass');
    // lips on the landing edges of the galleries
    dbox([7.05, UP.g1, -25.6], [7.35, UP.g1 + 0.04, -3.4], 'trim');
    dbox([-11.6, UP.g1 + UP.g2, -21.35], [11.6, UP.g1 + UP.g2 + 0.04, -21.05], 'trim');
    dbox([-11.6, UP.g1 + UP.g2 + UP.g3, -20.95], [-7.4, UP.g1 + UP.g2 + UP.g3 + 0.04, -20.65], 'trim');
    dbox([-11.6, Y_ATRIUM, -6.95], [11.6, Y_ATRIUM + 0.04, -6.65], 'trim');
    // the floating gallery: columns and a lit underside
    for (const x of [-10.5, 10.5]) { box([x - 0.8, 0, -5.4], [x + 0.8, Y_ATRIUM - 8, -3.8], { mat: 'tower' }); dbox([x - 0.82, 0.3, -5.42], [x - 0.74, Y_ATRIUM - 8.5, -3.78], 'trim'); }
    dbox([-11, Y_ATRIUM - 8.2, -6.9], [11, Y_ATRIUM - 8, -6.6], 'pink');
    // a hologram plate on every gallery face
    for (const [x, y, z, yaw, col] of [[6.9, 2.4, -14, 270, CYAN], [0, UP.g1 + 3, -20.9, 0, PINK], [-6.9, 7.8, -14, 90, AMBER]]) b.deco('screen', { pos: [x, y, z], size: [8, 2.6, 0.3], yaw, color: col });
  });
  b.glyph(fA.p(5.8, 0.02, -12), 'shield', 270);
  b.sign(fA.p(-2.8, 2.5, -8), 0, { title: 'TELJES TÖLTÉS', keys: 'bal gomb tartva · SPACE + elengedés', text: 'Nézz a padlóra, tölts 1,2 mp-ig, majd ugorj és engedd el egyszerre. A csúcson jöhet a dupla ugrás.' });
  b.light(fA.p(0, 7, -14), CYAN, 1.4, 30);
  b.light(fA.p(0, 24, -14), PINK, 1.4, 30);
  b.light(fA.p(0, 15, -4), PINK, 1, 18);

  // --- the light-well alley ---
  trimPlat(fAl, -1.5, 1.5, ALLEY_A, { column: false });
  trimPlat(fB1, -1.5, 1.5, B1);
  trimPlat(fB2, -1.5, 1.5, B2, { far: false });
  [[fAl, ALLEY_A], [fB1, B1], [fB2, B2]].forEach(([f, len]) => inF(f, () => {
    for (let z = -2; z > -len; z -= 4.5) {
      for (const [x, m] of [[-1.58, 'trim'], [1.58, 'pink']]) dbox([x - 0.05, 0.4, z - 0.12], [x + 0.05, 9, z + 0.12], m);
    }
  }));
  // light lines along the walls, over the whole alley (also across the gaps)
  for (const [x, m] of [[14.04, 'trim'], [16.96, 'pink']]) {
    dbox([x - 0.03, Y_ATRIUM + 1.5, -77], [x + 0.03, Y_ATRIUM + 1.62, 13], m);
    dbox([x - 0.03, Y_ATRIUM + 5, -77], [x + 0.03, Y_ATRIUM + 5.12, 13], m === 'trim' ? 'pink' : 'trim');
  }
  for (let z = -6; z > -76; z -= 11) b.deco('cable', { pos: [14.1, Y_BILL + 11.5, z], to: [16.9, Y_BILL + 11, z - 1.5], color: 0x2a3050 });
  for (let z = -20, i = 0; z > -74; z -= 22, i++) b.deco('screen', { pos: [16.85, Y_ATRIUM + 8, z], size: [2.6, 1.4, 0.2], yaw: 270, color: i % 2 ? PINK : CYAN });
  b.sign(fA.p(6, Y_ATRIUM + 2.8, -4.5), 270, { title: 'FALI LÖKÉS', keys: 'töltött pajzs · ugrás · lövés a falra', text: 'Ugorj a résen át, és a levegőben lőj hátra a közeli falra: a lökés előre visz.' });
  b.light(fAl.p(0, 4, -12), CYAN, 1.2, 22);
  b.light(fB1.p(0, 4, -4), PINK, 1.2, 22);
  b.light(fB2.p(0, 4, -12), CYAN, 1.2, 22);

  // --- the billboard wall ---
  trimPlat(fT, -WALLX, WALLX, T0, { far: false });
  trimPlat(fP1, -WALLX, WALLX, PAD);
  trimPlat(fP2, -WALLX, WALLX, PAD, { far: false });
  dbox([18, Y_BILL, -76.09], [72, Y_BILL + 1.8, -76], 'walldodge');
  [[26, PINK], [40, CYAN], [54, AMBER], [68, VIOLET]].forEach(([x, col]) => {
    b.deco('screen', { pos: [x, Y_BILL + 4.1, -76.2], size: [9, 3.4, 0.35], yaw: 180, color: col });
    dbox([x - 4.6, Y_BILL + 2.35, -76.12], [x + 4.6, Y_BILL + 2.45, -76.05], HEXMAT[col]);
  });
  b.light([30, Y_BILL + 3, -78], PINK, 1.2, 24);
  b.light([58, Y_BILL + 3, -78], CYAN, 1.2, 24);

  // --- the East Block: facade lines, foot, roof ---
  dbox([18, GROUND, -76], [72, -30, 8], 'roof');
  for (const [m, y] of [['trim', Y_ROOF - 9], ['pink', Y_ROOF - 16], ['trim', Y_ROOF - 23], ['pink', Y_ROOF - 30]]) {
    dbox([18, y, 8], [72, y + 0.3, 8.3], m);
    dbox([72, y, -76], [72.3, y + 0.3, 8], m);
    dbox([18, y - 3.5, -76.3], [72, y - 3.2, -76], m === 'trim' ? 'pink' : 'trim');
  }
  for (const x of [24, 36, 48, 60, 70]) dbox([x - 0.15, -30, 8], [x + 0.15, x < 50 ? Y_TALL : Y_ROOF, 8.3], x % 12 ? 'pink' : 'trim');
  b.deco('screen', { pos: [44, Y_ROOF - 4.5, 8.25], size: [14, 4.6, 0.4], color: PINK });
  b.deco('screen', { pos: [72.25, Y_ROOF - 4.5, -30], size: [14, 4.6, 0.4], yaw: 90, color: CYAN });
  // roof: parapets (real, a jumpable 1 m), lane lines, distance markers, rain puddles, equipment
  box([71.5, Y_ROOF, -76], [72, Y_ROOF + 1, 8], { mat: 'wall' });
  dbox([71.5, Y_ROOF + 1, -76], [72, Y_ROOF + 1.08, 8], 'pink');
  dbox([50, Y_ROOF - 0.3, -76.35], [72, Y_ROOF, -76], 'pink');   // the lit coping of the billboard wall: the roof edge you shield-jump onto
  dbox([18, Y_TALL - 0.3, -76.35], [50, Y_TALL, -76], 'trim');
  for (let z = -66, i = 0; z < 8; z += 10, i++) dbox([52, Y_ROOF, z - 0.1], [68, Y_ROOF + 0.03, z + 0.1], NEON[i % 2]);
  [[-56, '20 m'], [-36, '40 m'], [-16, '60 m'], [4, '80 m']].forEach(([z, t]) => b.marker([70, Y_ROOF + 1.8, z], t));
  const rnd = mulberry32(5150);
  for (let i = 0; i < 14; i++) {
    const west = i % 2 === 0, x = west ? 21 + rnd() * 26 : 66.5 + rnd() * 2, z = -70 + rnd() * 74, w = 1.5 + rnd() * 2.5;
    const y0 = x < 50 ? Y_TALL : Y_ROOF;
    dbox([x, y0, z], [x + w, y0 + 0.025, z + 0.8 + rnd() * 1.4], i % 3 ? 'puddleC' : 'puddleP');
  }
  for (const [x, z, w, h, d] of [[24, -62, 4, 2.4, 3], [30, -48, 3, 2, 3], [26, -30, 5, 2.6, 3.5], [36, -22, 3, 2.2, 3], [24, -8, 4, 2.4, 3], [40, -4, 3, 2, 3], [44, -56, 3.5, 2.2, 3], [46, -34, 4, 2.4, 3]]) {
    box([x - w / 2, Y_TALL, z - d / 2], [x + w / 2, Y_TALL + h, z + d / 2], { mat: 'wall' });
    if (w > 3.2) b.deco('fan', { pos: [x, Y_TALL + h + 1.3, z], size: [2.4, 2.4, 0.5], color: 0x6a7388 });
    dbox([x - w / 2, Y_TALL + h, z - d / 2], [x + w / 2, Y_TALL + h + 0.08, z + d / 2], NEON[(x | 0) % 3]);
  }
  for (const [x, z] of [[22, -40], [28, -12], [46, -68], [42, 2]]) box([x - 0.45, Y_TALL, z - 4.5], [x + 0.45, Y_TALL + 0.9, z + 4.5], { mat: 'wall' });   // ducts
  [[20, -72, 24], [20, -2, 18], [47, -72, 30], [47, 4, 22], [70, -72, 20], [70, 6, 26]].forEach(([x, z, h], i) => {
    const y0 = x < 50 ? Y_TALL : Y_ROOF;
    b.deco('pillar', { pos: [x, y0 + h / 2, z], size: [0.5, h, 0.5], color: 0x2a3050 });
    b.deco('beacon', { pos: [x, y0 + h + 0.8, z], size: [0.5, 1.4, 0.5], color: i % 2 ? PINK : CYAN });
  });
  b.light([60, Y_ROOF + 5, -62], PINK, 1.2, 28);
  b.light([60, Y_ROOF + 5, -30], CYAN, 1.2, 28);
  b.light([60, Y_ROOF + 5, 0], AMBER, 1.2, 28);
  b.sign(fR.p(-6, 2.6, -10), 180, { title: 'STRAFE-UGRÁS', keys: 'SPACE tartva · A / D váltva · egér', text: 'A hosszú tetőn gyorsulj fel strafe-ugrással, és ugord át a szakadékot egyetlen ugrással: gyorsabb a gondolánál.' });

  // --- the canyon: gondola rails, the south terrace ---
  inF(fC, () => {
    for (const x of [-3.7, 3.7]) {
      dbox([x - 0.12, 4.6, -GAP.canyon], [x + 0.12, 4.9, 0], 'lift');
      b.deco('pillar', { pos: [x, 2.3, 0.6], size: [0.7, 4.6, 0.7], color: 0x2a3050 });
      b.deco('pillar', { pos: [x, 2.3, -GAP.canyon - 0.6], size: [0.7, 4.6, 0.7], color: 0x2a3050 });
      b.deco('beacon', { pos: [x, 5.6, 0.6], size: [0.5, 1.2, 0.5], color: AMBER });
    }
    dbox([-4, 0.004, -0.15], [4, 0.03, 0.15], 'amber');   // the dock line on the roof edge (local z 0 is the edge)
  });
  trimPlat(fD, -8, 8, 15, { far: false });
  inF(fD, () => {
    dbox([7.7, 0.004, -14.5], [8, 0.04, -0.5], 'pink');   // the west edge launches onto the staircase
    for (const x of [-8, 8]) b.deco('pillar', { pos: [x * 0.9, 4, -14], size: [0.8, 8, 0.8], color: 0x1c2250 });
    b.deco('arch', { pos: [0, 4.2, -14.5], size: [15, 8.4, 0.6], color: CYAN });
  });
  b.light(fD.p(0, 5, -8), CYAN, 1.2, 24);

  // --- the staircase and the deck ---
  [[fLA, 8, 'trim'], [fLB, 8, 'trim'], [fLC, 8, 'pink'], [fLD, 8, 'trim'], [fLE, 12, 'pink']].forEach(([f, len, m], i) => {
    inF(f, () => {
      if (i) dbox([-W6 + 0.4, 0, -0.3], [W6 - 0.4, 0.04, -0.01], m);   // the landing lip (this ledge's near edge, local z 0)
      for (const x of [-W6 + 0.3, W6 - 0.3]) dbox([x - 0.07, 0.004, -len + 0.5], [x + 0.07, 0.03, -0.5], 'trim');
      if (i < 4) dbox([-W6, -0.06, -len], [W6, 0.012, -len + 0.15], 'pink');
      const base = i ? 8 : 1, h = f.at[1] - base - GROUND;
      b.deco('pillar', { pos: [0, -base - h / 2, -len / 2], size: [3, h, 3], color: 0x1a2046 });
      if (i) for (const x of [-W6 + 0.5, W6 - 0.5]) dbox([x - 0.1, -8, 0.02], [x + 0.1, -0.2, 0.2], 'trim');
    });
    b.light(f.p(0, 5, -len / 2), i % 2 ? CYAN : PINK, 1, 18);
  });
  b.glyph(fLA.p(0, 0.02, -LEN + 1.2), 'shield', 90);
  inF(fLE, () => {
    b.deco('ring', { pos: [0, 5.5, -9.5], size: [11, 11, 0.6], color: 0xffffff });
    b.deco('ring', { pos: [0, 5.5, -9.5], size: [8, 8, 0.4], color: AMBER });
    b.deco('beacon', { pos: [-5.5, 4, -11], size: [0.7, 8, 0.7], color: CYAN });
    b.deco('beacon', { pos: [5.5, 4, -11], size: [0.7, 8, 0.7], color: PINK });
    b.deco('screen', { pos: [0, 9, -11.8], size: [10, 2.4, 0.3], color: AMBER });
  });
  b.light(fLE.p(0, 6, -8), 0xffffff, 1.6, 26);

  // --- the megatower: facade lines, screens, tiers, spire ---
  dbox([-14, GROUND, -14], [14, -14, 14], 'tower');
  for (const [cx, cz] of [[14, 14], [-14, 14], [14, -14], [-14, -14]]) dbox([cx - 0.3, -14, cz - 0.3], [cx + 0.3, 130, cz + 0.3], cx * cz > 0 ? 'trim' : 'pink');
  for (let y = 44, i = 0; y < 128; y += 12, i++) {
    const m = i % 2 ? 'pink' : 'trim';
    dbox([-14.3, y, 14], [14.3, y + 0.35, 14.3], m);
    dbox([-14.3, y, -14.3], [14.3, y + 0.35, -14], m);
    dbox([14, y, -14.3], [14.3, y + 0.35, 14.3], m);
    dbox([-14.3, y, -14.3], [-14, y + 0.35, 14.3], m);
  }
  b.deco('screen', { pos: [0, 72, 14.3], size: [18, 8.5, 0.4], color: PINK });
  b.deco('screen', { pos: [-7, 98, 14.3], size: [10, 5, 0.4], color: CYAN });
  b.deco('screen', { pos: [8, 110, 14.3], size: [9, 4, 0.4], color: AMBER });
  b.deco('screen', { pos: [14.3, 78, -2], size: [16, 8, 0.4], yaw: 90, color: VIOLET });
  b.deco('screen', { pos: [-14.3, 84, 0], size: [16, 8, 0.4], yaw: 270, color: CYAN });
  [[130, 172, 24], [172, 208, 18], [208, 238, 12], [238, 258, 7]].forEach(([h0, h1, w], i) => {
    dbox([-w / 2, h0, -w / 2], [w / 2, h1, w / 2], 'tower');
    dbox([-w / 2 - 0.05, h1 - 1.4, -w / 2 - 0.05], [w / 2 + 0.05, h1 - 1.1, w / 2 + 0.05], i % 2 ? 'pink' : 'trim');
    dbox([-w / 2 - 0.1, h0 + 2, w / 2 - 0.2], [-w / 2 + 0.3, h1 - 2, w / 2 + 0.1], 'trim');
    dbox([w / 2 - 0.3, h0 + 2, -w / 2 - 0.1], [w / 2 + 0.1, h1 - 2, -w / 2 + 0.2], 'pink');
  });
  b.deco('pillar', { pos: [0, 295, 0], size: [1.8, 76, 1.8], color: 0x2a3050 });
  b.deco('beacon', { pos: [0, 340, 0], size: [3, 14, 3], color: PINK });
  for (const [y, d, yaw, col] of [[150, 46, 0, CYAN], [150, 46, 90, PINK], [190, 34, 0, PINK], [190, 34, 90, CYAN], [225, 22, 45, CYAN]]) b.deco('ring', { pos: [0, y, 0], size: [d, d, 1], yaw, color: col });
  b.light([0, 60, 60], PINK, 1.5, 60);

  // --- the city: a street grid far below, a ring of towers around the course ---
  dbox([-720, GROUND - 3, -720], [720, GROUND, 720], 'city');
  for (let k = -10; k <= 10; k++) {
    const m = k % 5 === 0 ? 'amber' : k % 2 ? 'pink' : 'trim';
    dbox([k * 36 - 0.45, GROUND + 0.05, -380], [k * 36 + 0.45, GROUND + 0.15, 380], m);
    dbox([-380, GROUND + 0.05, k * 36 - 0.45], [380, GROUND + 0.15, k * 36 + 0.45], m);
  }
  const keepOut = [[-34, 36, -6, 140], [-34, 104, -104, 34], [-14, 94, 6, 62]];   // the course (x0, x1, z0, z1), with margin
  const r2 = mulberry32(2077);
  for (let n = 0, built = 0; n < 400 && built < 48; n++) {
    const a = r2() * Math.PI * 2, rad = 70 + r2() * 270, cx = 30 + Math.cos(a) * rad, cz = 10 + Math.sin(a) * rad;
    const w = 14 + r2() * 24, d = 14 + r2() * 24, top = -80 + r2() * 150;
    if (keepOut.some(([x0, x1, z0, z1]) => cx + w / 2 > x0 && cx - w / 2 < x1 && cz + d / 2 > z0 && cz - d / 2 < z1)) continue;
    dbox([cx - w / 2, GROUND, cz - d / 2], [cx + w / 2, top, cz + d / 2], ['bldgC', 'bldgP', 'bldgA'][built % 3]);
    dbox([cx - w / 2 - 0.1, GROUND, cz - d / 2 - 0.1], [cx - w / 2 + 0.5, top, cz - d / 2 + 0.5], NEON[built % 3]);
    dbox([cx + w / 2 - 0.5, GROUND, cz + d / 2 - 0.5], [cx + w / 2 + 0.1, top, cz + d / 2 + 0.1], NEON[(built + 1) % 3]);
    if (built % 2 === 0) dbox([cx - w / 2 - 0.1, top - 3, cz - d / 2 - 0.1], [cx + w / 2 + 0.1, top - 2.6, cz + d / 2 + 0.1], NEON[(built + 2) % 3]);
    if (built % 3 !== 1) {
      b.deco('pillar', { pos: [cx, top + 5, cz], size: [0.4, 10, 0.4], color: 0x2a3050 });
      b.deco('beacon', { pos: [cx, top + 10.8, cz], size: [0.5, 1.4, 0.5], color: [PINK, CYAN, AMBER][built % 3] });
    }
    built++;
  }

  b.route([...pre, ...gondola, ...post]);
  b.skip('strafe-ugrás a tetőn', [...pre, ...strafeSkip, ...post]);

  // ---------- kill volumes ----------
  kill(-40, 40, 16, 150, -20, -12);
  kill(12.5, 18, -78, 14, Y_ATRIUM - 12, Y_ATRIUM - 4);
  kill(14, 80, -122, -76, Y_BILL - 12, Y_BILL - 4);
  kill(30, 58, 6, 28, Y_ROOF - 14, Y_ROOF - 5);
  kill(-34, 58, 20, 60, 10, 16);
});
