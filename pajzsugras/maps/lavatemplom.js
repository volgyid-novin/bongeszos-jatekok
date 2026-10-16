// LÁVATEMPLOM: an ancient stone temple on a lava lake, a volcano erupting behind it. The pilgrim's road: a broken bridge
// (dodge jumps and one wall-dodge gap), a forest of pillars (double-jump hops, one of them slides), a lava river with a ferry,
// a rising stone, the cracked stair of the temple (tilted shield jumps over lava cracks: the shield strafe jump, standing), the
// sacred way (strafe-jump runs, gaps that need the speed), the great chasm, where the running shield strafe jump carries you
// across, and the crown of pillars up to the altar. Skip: the same shield strafe jump over the lava river instead of the ferry.
// Margins are measured against the proof bot's edge-perfect maxima (wave 1 probe table), Nehéz ~85-90 %.
import { defineMap } from '../sim/builder.js';
import { R } from '../sim/bot.js';
import { rotY, mulberry32 } from '../sim/math.js';

const EMBER = 0xff6a00, GOLD = 0xffb040, FIRE = 0xff3a00, ASH = 0x241814;
// gaps (m): bridge = dodge jumps (the 3rd with a wall dodge), forest = jump + double jump (edge to edge), river = the ferry's crossing (also the
// shield strafe skip), ferry/lift = the run jump off the moving stone, road = jumps after strafe runs, chasm = running shield strafe jump
const GAP = { bridge: [11.0, 12.2, 14.4, 13.0, 13.6], forest: [10.4, 9.8, 10.9, 10.2, 10.4, 9.8, 10.6, 9.6], ferry: 6.2, river: 24.2, lift: 6.2, road: [14.8, 11.5], chasm: 24.0 };
// the cracked stair: rise of every step (m), width of the lava crack in front of it (m), double jump or not
const STAIR = { rise: [4.0, 5.0, 4.6, 5.8, 5.2, 6.0], crack: [4.6, 7.8, 5.2, 7.8, 7.0, 7.4], dj: [0, 1, 0, 1, 1, 1], pitch: [-55, -62, -55, -62, -62, -62] };
// the crown: three pillar tops climbing from the sanctum to the altar (tilted shield jumps): rise, gap, double jump, aim pitch, direction (deg), top radius
const CROWN = { rise: [4.5, 5.0, 5.4], gap: [5.6, 9.0, 8.6], dj: [0, 1, 1], pitch: [-55, -62, -62], ang: [8, -12, 6], r: [2.3, 2.3, 4.6] };
const LIFT_RISE = 9.0;

export default defineMap({
  id: 'lavatemplom', name: 'LÁVATEMPLOM', diff: 'nehez', order: 6, authorTime: 105.183,
  blurb: 'Ősi templom a lávatóban: törött híd, oszloperdő, repedezett lépcső, strafe-futás és a nagy szakadék, amit a pajzs-strafe ugrás győz le.',
  theme: {
    sky: { type: 'clouds', top: 0x140806, horizon: 0xc8501a, bottom: 0x2a0c06, sunDir: [0.3, 0.45, 0.8], sunColor: 0xff7a30, clouds: 0.75, cloudDark: 0x140a08, cloudLight: 0x5a2a1a },
    fog: { color: 0x5a2010, near: 60, far: 720 },
    hemi: { sky: 0xff8a50, ground: 0x401810, intensity: 0.9 }, sun: { color: 0xff7a30, intensity: 1.3 },
    palette: { floor: 0x5a4a3a, wall: 0x3a2a22, trim: EMBER, accent: GOLD, glow: 0xff5000, danger: 0xff2000 },
    bloom: 1.2, ambient: 'lava',
  },
}, (b) => {
  b.mat('floor', { base: 'rock', color: 0x6a5848, trim: EMBER });
  b.mat('wall', { base: 'rock', color: 0x3a2c26, trim: EMBER });
  b.mat('step', { base: 'concrete', color: 0x86705a, trim: GOLD });
  b.mat('pillar', { base: 'concrete', color: 0x74604c, trim: EMBER });
  b.mat('walldodge', { base: 'stripe', color: 0x5a4636, trim: EMBER, emissive: 0x401800 });
  b.mat('lava', { base: 'crystal', color: 0x7a1c08, trim: 0xff7a20, emissive: 0xff5010 });
  b.mat('ember', { base: 'neon', color: EMBER, emissive: EMBER });
  b.mat('gold', { base: 'neon', color: GOLD, emissive: GOLD });
  b.mat('ash', { base: 'rock', color: ASH, trim: FIRE });
  b.mat('crag', { base: 'rock', color: 0x4a3226, trim: FIRE });

  // ---------- frames ----------
  const frame = (at, yaw = 0) => ({ at, yaw, p: (x, y, z) => { const q = rotY([x, y, z], yaw); return [q[0] + at[0], q[1] + at[1], q[2] + at[2]]; } });
  const XZ = (f, x, z) => { const q = f.p(x, 0, z); return [q[0], q[2]]; };
  const inF = (f, fn) => b.group({ at: f.at, yaw: f.yaw }, fn);
  const step = (f, len, dy = 0) => frame(f.p(0, dy, -len), f.yaw);   // the frame `len` ahead (and dy higher)
  const TH = 1;
  const box = (p, q, o) => b.box([Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.min(p[2], q[2])], [Math.max(p[0], q[0]), Math.max(p[1], q[1]), Math.max(p[2], q[2])], o);
  const dbox = (p, q, mat) => b.decoBrush('box', [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.min(p[2], q[2])], [Math.max(p[0], q[0]), Math.max(p[1], q[1]), Math.max(p[2], q[2])], { mat });
  // a brazier: a bronze stand, a bowl, a flame (coordinates of the current group)
  const brazier = (x, y, z, s = 1) => {
    b.deco('pillar', { pos: [x, y + 0.7 * s, z], size: [0.5 * s, 1.4 * s, 0.5 * s], color: 0x6a5238 });
    b.decoBrush('prism', [x, y + 1.5 * s, z], 0.75 * s, 0.3 * s, { sides: 8, mat: 'ash' });
    b.deco('beacon', { pos: [x, y + 1.65 * s + 1.1 * s, z], size: [0.7 * s, 2.2 * s, 0.7 * s], color: 0xff7a1a });
  };
  // rails and braziers of a stone barge (a mover's deco: it rides along)
  const bargeDeco = () => {
    for (const x of [-GW / 2 + 0.2, GW / 2 - 0.2]) dbox([x - 0.15, 0, -GL + 0.2], [x + 0.15, 0.55, -0.2], 'step');
    dbox([-GW / 2, -TH - 0.01, -GL], [GW / 2, -TH + 0.15, 0], 'gold');
    for (const z of [-0.5, -GL + 0.5]) for (const x of [-GW / 2 + 0.5, GW / 2 - 0.5]) brazier(x, 0, z, 0.6);
  };
  const spots = [];   // the ground plan of everything solid (world x0, x1, z0, z1), the scenery keeps its distance
  const track = (f, x0, x1, len) => {
    const a = f.p(x0, 0, 0), c = f.p(x1, 0, -len);
    spots.push([Math.min(a[0], c[0]), Math.max(a[0], c[0]), Math.min(a[2], c[2]), Math.max(a[2], c[2])]);
  };
  // a floor slab in frame f: x0..x1 across, z 0 .. -len along, top at local y 0
  const slab = (f, x0, x1, len, mat = 'floor') => { track(f, x0, x1, len); inF(f, () => box([x0, -TH, -len], [x1, 0, 0], { mat })); };
  // a solid block from the lava lake up to the frame's level (a temple foundation)
  const FOUND = -6;
  const blockF = (f, x0, x1, len, mat = 'step') => { track(f, x0, x1, len); inF(f, () => box([x0, FOUND - f.at[1], -len], [x1, 0, 0], { mat })); };
  const cp = (f, label, x0, x1, z0, z1, spawn, yaw = 0) => inF(f, () => b.checkpoint([x0, 0, z0], [x1, 14, z1], { spawn, yaw, label }));
  const kill = (x0, x1, z0, z1, yBot, yTop) => b.kill([x0, yBot, z0], [x1, yTop, z1], 'lava');

  const pre = [], ferry = [], skipRoute = [], post = [];

  // ================= A: the dock =================
  const DOCK = 56;
  const fA = frame([0, 0, 0], 0);
  slab(fA, -5, 5, DOCK);
  inF(fA, () => { box([-30, -1, 0], [30, 0, 40], { mat: 'floor' }); b.start([0, 0, -4], 0); });
  spots.push([-30, 30, 0, 40]);

  // ================= B: the broken bridge (dodge jumps, one wall dodge) =================
  const SEG = [9, 9, 10, 9, 12];
  const bridge = [];
  let fPrev = fA, lenPrev = DOCK;
  GAP.bridge.forEach((g, i) => {
    const f = step(fPrev, lenPrev + g);
    slab(f, -3, 3, SEG[i]);
    bridge.push(f);
    if (i === 2) {
      // the ruined aqueduct wall along the left edge, over the gap: the wall dodge gap
      inF(fPrev, () => box([-3.5, -3, 0], [-2.5, 6, -(lenPrev + g + 3)], { mat: 'walldodge' }));
      pre.push(R.run(...XZ(fPrev, -1.9, -2), { tol: 0.5 }));
      pre.push(R.jump({ edge: true, to: XZ(f, -1.9, -3), air: [R.wallDodge('F', { at: 'wall' })], dj: 'apex' }));
    } else {
      pre.push(R.dodgeJump('F', { edge: true, to: XZ(f, 0, -4.5) }));
    }
    fPrev = f; lenPrev = SEG[i];
  });
  const fBr = step(fPrev, lenPrev);   // the bridge's far end
  cp(bridge[4], '1 · HÍD', -3, 3, -0.5, -5, [0, 0, -3]);

  // ================= C: the forest of pillars (jump + double jump) =================
  // each pillar top: the direction of the jump (deg from north), the rise
  const PR = 2.15;   // radius of a pillar top (12-sided prism)
  const FOREST = [[8, 0], [-18, 0.8], [20, -0.8], [-16, 0.5], [14, 0], [-12, 0.6], [8, 0]];
  const SLIDER = 3, SLIDE = 7;   // the 4th pillar slides toward the next one (m)
  let c = [0, 0], cy = 0;
  const tops = [];
  FOREST.forEach(([ang, dy], i) => {
    const d = GAP.forest[i] + (i ? 2 * PR : PR), a = (ang * Math.PI) / 180;
    c = [c[0] + Math.sin(a) * d, c[1] + Math.cos(a) * d];   // local x, distance forward
    cy += dy;
    tops.push([c[0], cy, -c[1]]);
  });
  tops.forEach((pc, i) => {
    if (i === SLIDER) {
      const nx = tops[i + 1], l = Math.hypot(nx[0] - pc[0], nx[2] - pc[2]), off = [((nx[0] - pc[0]) / l) * SLIDE, 0, ((nx[2] - pc[2]) / l) * SLIDE];
      inF(fBr, () => b.mover('slider', { path: [off], speed: 2.2, wait: 2.5 }, () => {
        b.prism([pc[0], pc[1] - 7, pc[2]], PR, 14, { sides: 12, mat: 'pillar' });
        b.decoBrush('prism', [pc[0], pc[1] - 0.6, pc[2]], PR + 0.5, 0.25, { sides: 12, mat: 'gold' });
        brazier(pc[0], pc[1] + 0.02, pc[2] - 1.5, 0.7);
      }));
      spots.push([fBr.p(pc[0], 0, pc[2])[0] - PR - 8, fBr.p(pc[0], 0, pc[2])[0] + PR + 8, fBr.p(pc[0], 0, pc[2])[2] - PR - 8, fBr.p(pc[0], 0, pc[2])[2] + PR + 8]);
      pre.push(R.waitMover('slider', { near: [0, 0, 0], tol: 0.05, within: 0.3 }));
      pre.push(R.jump({ edge: true, to: XZ(fBr, pc[0], pc[2]), dj: 'apex' }));
      pre.push(R.waitMover('slider', { near: off, tol: 0.05 }));
    } else {
      inF(fBr, () => b.prism([pc[0], pc[1] - 7, pc[2]], PR, 14, { sides: 12, mat: 'pillar' }));
      spots.push([fBr.p(pc[0], 0, pc[2])[0] - PR, fBr.p(pc[0], 0, pc[2])[0] + PR, fBr.p(pc[0], 0, pc[2])[2] - PR, fBr.p(pc[0], 0, pc[2])[2] + PR]);
      pre.push(R.jump({ edge: true, to: XZ(fBr, pc[0], pc[2]), dj: i === SLIDER + 1 ? false : 'apex' }));
    }
  });
  // the shrine: a wide platform, its south edge GAP.forest[7] beyond the last pillar, extending east for the ferry
  const SH = { w0: -8, w1: 16, len: 12 };
  const lastTop = tops[tops.length - 1];
  const shF = -lastTop[2] + PR + GAP.forest[7];                           // forward distance of the shrine's south edge
  const fSh = frame(fBr.p(lastTop[0], lastTop[1] + 1.0, -shF), 0);               // origin: south edge, above the last pillar's x
  slab(fSh, SH.w0, SH.w1, SH.len);
  cp(fSh, '2 · SZENTÉLY', SH.w0, SH.w1, -0.5, -SH.len, [0, 0, -4]);
  pre.push(R.jump({ edge: true, to: XZ(fSh, 0, -4), dj: 'apex' }));

  // ================= D: the lava river and the ferry =================
  // the ferry docks at the shrine's east edge (local x = SH.w1) and runs east; the island is GAP.river away
  const fE = frame(fSh.p(SH.w1, 0, -SH.len / 2), 270);   // heading east, origin on the shrine's east edge
  const GL = 8, GW = 7, TRAVEL = GAP.river - GL - GAP.ferry;
  inF(fE, () => {
    b.mover('ferry', { path: [[0, 0, -TRAVEL]], speed: 2.5, wait: 2.5 }, () => {
      box([-GW / 2, -TH, -GL], [GW / 2, 0, 0], { mat: 'floor' });
      bargeDeco();
    });
  });
  const fIs = step(fE, GAP.river);   // the island's west edge
  const IS = 16;
  slab(fIs, -8, 8, IS);
  cp(fIs, '3 · SZIGET', -8, 8, -0.5, -IS, [0, 0, -5]);
  ferry.push(R.run(...XZ(fSh, 0, -4), { tol: 1 }));
  ferry.push(R.run(...XZ(fE, 0, 4), { stop: true, tol: 0.5 }));
  ferry.push(R.waitMover('ferry', { near: [0, 0, 0], tol: 0.05, within: 1.2 }));
  ferry.push(R.run(...XZ(fE, 0, -GL / 2), { tol: 0.5 }));
  ferry.push(R.waitMover('ferry', { near: fE.p(0, 0, -TRAVEL).map((v, i) => v - fE.at[i]), tol: 0.05 }));
  ferry.push(R.jump({ edge: true, to: XZ(fIs, 0, -6) }));
  // skip: the shield strafe jump over the whole river
  skipRoute.push(R.run(...XZ(fE, 0, 11.6), { tol: 0.4 }));
  skipRoute.push(R.shieldJump({ push: XZ(fIs, 0, -50), pitch: -50, charge: 1, run: XZ(fIs, 0, -50), dj: 'apex', to: XZ(fIs, 0, -8) }));

  // ================= E: the rising stone (a lift and a run jump) =================
  const fLf = step(fIs, IS);   // the island's east edge
  inF(fLf, () => {
    b.mover('lift', { path: [[0, LIFT_RISE, 0]], speed: 2.2, wait: 2.5 }, () => {
      box([-GW / 2, -TH, -GL], [GW / 2, 0, 0], { mat: 'floor' });
      bargeDeco();
    });
  });
  const fPl = step(fLf, GL + GAP.lift, LIFT_RISE);   // the plaza at the foot of the stair
  const PL = 16;
  slab(fPl, -8, 8, PL);
  post.push(R.run(...XZ(fIs, 0, -IS + 4), { tol: 1 }));
  post.push(R.run(...XZ(fLf, 0, 4), { stop: true, tol: 0.5 }));
  post.push(R.waitMover('lift', { near: [0, 0, 0], tol: 0.05, within: 1.2 }));
  post.push(R.run(...XZ(fLf, 0, -GL / 2), { tol: 0.5 }));
  post.push(R.waitMover('lift', { near: [0, LIFT_RISE, 0], tol: 0.05 }));
  post.push(R.jump({ edge: true, to: XZ(fPl, 0, -6) }));

  // ================= F: the cracked stair of the temple (tilted shield jumps over lava cracks) =================
  // heading north from the plaza's north edge, in the middle of it (the plaza is x -8..8 along the east-heading frame)
  const fS0 = frame(fPl.p(-8, 0, -PL / 2), 0);
  const STEP_W = 8, STEP_D = 9;
  const stairs = [];
  fPrev = fS0; lenPrev = 0;
  STAIR.rise.forEach((rise, i) => {
    const top = i === STAIR.rise.length - 1;
    const f = step(fPrev, lenPrev + STAIR.crack[i], rise);
    const len = top ? 16 : STEP_D;
    blockF(f, -STEP_W, STEP_W, len);
    stairs.push({ f, len });
    post.push(R.run(...XZ(fPrev, 0, -lenPrev + 0.6), { stop: true, tol: 0.25 }));
    post.push(R.shieldJump({ charge: 1, push: XZ(f, 0, -50), pitch: STAIR.pitch[i], dj: STAIR.dj[i] ? 'apex' : false, to: XZ(f, 0, -4) }));
    fPrev = f; lenPrev = len;
  });
  cp(stairs[2].f, '4 · LÉPCSŐ', -STEP_W, STEP_W, -0.5, -STEP_D, [0, 0, -3]);
  const fTerr = stairs[stairs.length - 1].f;

  // ================= G: the sacred way (strafe runs + gaps that need the speed) =================
  const ROAD1 = 46, MID = 12.8;
  const fRd = step(fTerr, 16);
  slab(fRd, -4, 4, ROAD1);
  const fMid = step(fRd, ROAD1 + GAP.road[0]);
  slab(fMid, -4, 4, MID);
  const fCy = step(fMid, MID + GAP.road[1]);
  const CY = 24;
  blockF(fCy, -30, 30, CY);
  cp(fCy, '5 · UDVAR', -6, 6, -0.5, -8, [0, 0, -3]);
  post.push(R.run(...XZ(fRd, 0, -3), { tol: 0.5 }));
  post.push(R.strafe({ hops: 5, to: XZ(fMid, 0, -8), eff: 0.75 }));
  post.push(R.jump({ to: XZ(fMid, 0, -8), dj: 'apex' }));
  post.push(R.strafe({ hops: 1, to: XZ(fCy, 0, -8), eff: 0.75 }));
  post.push(R.jump({ to: XZ(fCy, 0, -8), dj: 'apex' }));

  // ================= H: the great chasm (running shield strafe jump) and the altar =================
  const fSn = step(fCy, CY + GAP.chasm);
  const SN = 14;
  blockF(fSn, -30, 30, SN);
  cp(fSn, '6 · SZENTÉLY-TÉR', -6, 6, -0.5, -8, [0, 0, -3]);
  post.push(R.run(...XZ(fCy, 0, -CY + 11.6), { tol: 0.4 }));
  post.push(R.shieldJump({ push: XZ(fSn, 0, -50), pitch: -50, charge: 1, run: XZ(fSn, 0, -50), dj: 'apex', to: XZ(fSn, 0, -6) }));
  // the crown: pillar tops (x, forward distance from the sanctum's near edge, height above the sanctum)
  const crown = [];
  let cur = [0, SN], cyc = 0;
  CROWN.rise.forEach((rise, i) => {
    const a = (CROWN.ang[i] * Math.PI) / 180, dir = [Math.sin(a), Math.cos(a)];
    const prevR = i ? CROWN.r[i - 1] : 0, d = CROWN.gap[i] + prevR + CROWN.r[i];
    const stand = i ? [cur[0] + dir[0] * (prevR - 0.6), cur[1] + dir[1] * (prevR - 0.6)] : [0, SN - 0.6];
    cur = [cur[0] + dir[0] * d, cur[1] + dir[1] * d]; cyc += rise;
    crown.push({ x: cur[0], fwd: cur[1], y: cyc, r: CROWN.r[i] });
    const base = FOUND - fSn.at[1];
    inF(fSn, () => b.prism([cur[0], (cyc + base) / 2, -cur[1]], CROWN.r[i], cyc - base, { sides: 16, mat: 'step' }));
    spots.push([fSn.p(cur[0], 0, -cur[1])[0] - CROWN.r[i], fSn.p(cur[0], 0, -cur[1])[0] + CROWN.r[i], fSn.p(cur[0], 0, -cur[1])[2] - CROWN.r[i], fSn.p(cur[0], 0, -cur[1])[2] + CROWN.r[i]]);
    post.push(R.run(...XZ(fSn, stand[0], -stand[1]), { stop: true, tol: 0.25 }));
    post.push(R.shieldJump({ charge: 1, push: XZ(fSn, cur[0] + dir[0] * 30, -(cur[1] + dir[1] * 30)), pitch: CROWN.pitch[i], dj: CROWN.dj[i] ? 'apex' : false, to: XZ(fSn, cur[0], -cur[1]) }));
  });
  const alt = crown[crown.length - 1], mid = crown[1];
  inF(fSn, () => {
    b.checkpoint([mid.x - 2.2, mid.y, -mid.fwd - 2.2], [mid.x + 2.2, mid.y + 14, -mid.fwd + 2.2], { spawn: [mid.x, mid.y, -mid.fwd], yaw: 0, label: '7 · KORONA' });
    b.finish([alt.x - 2.5, alt.y, -alt.fwd - 2.5], [alt.x + 2.5, alt.y + 8, -alt.fwd + 2.5]);
  });
  post.push(R.run(...XZ(fSn, alt.x, -alt.fwd), { tol: 0.6 }));

  // ================= scenery =================
  const LAKE = -3.4;   // the lava lake's surface; the kill volume ends here
  const STONE = 0x8a7458;
  const rnd = mulberry32(666);
  const near = (x, z, r) => spots.some(([x0, x1, z0, z1]) => x > x0 - r && x < x1 + r && z > z0 - r && z < z1 + r);
  // a column out of the lava up to `top` (world coordinates)
  const col = (x, z, top, w, color = STONE) => b.deco('pillar', { pos: [x, (top + LAKE - 6) / 2, z], size: [w, top - LAKE + 6, w], color });
  // a guardian statue (coordinates of the current group), yaw 90 faces +x, 270 faces -x, 0 faces +z, 180 faces -z
  const statue = (x, y, z, yaw, s = 1, solid = false) => b.group({ at: [x, y, z], yaw }, () => {
    if (solid) box([-2.2 * s, 0, -2.2 * s], [2.2 * s, 1.2 * s, 2.2 * s], { mat: 'step' });
    const parts = [
      [[-1.5, 1.2, -0.9], [-0.2, 4.2, 0.9], 'step'], [[0.2, 1.2, -0.9], [1.5, 4.2, 0.9], 'step'],
      [[-2, 4.2, -1.3], [2, 8.2, 1.3], 'step'], [[-3, 4.6, -0.7], [-2, 8, 0.7], 'step'], [[2, 4.6, -0.7], [3, 8, 0.7], 'step'],
      [[-1.1, 8.2, -1.1], [1.1, 10.4, 1.1], 'step'], [[-1.4, 10.4, -1.4], [1.4, 11, 1.4], 'gold'],
      [[-0.8, 9.3, 1.0], [-0.2, 9.7, 1.15], 'ember'], [[0.2, 9.3, 1.0], [0.8, 9.7, 1.15], 'ember'], [[-0.8, 5.8, 1.25], [0.8, 7.2, 1.35], 'ember'],
    ];
    for (const [p, q, m] of parts) dbox([p[0] * s, p[1] * s, p[2] * s], [q[0] * s, q[1] * s, q[2] * s], m);
  });
  // a battered gate tower (a frustum), base w x d, height h
  const pylon = (x, y, z, w, d, h) => {
    const pts = [];
    for (const [k, y2] of [[1, 0], [0.78, h]]) for (const sx of [-1, 1]) for (const sz of [-1, 1]) pts.push([x + sx * (w / 2) * k, y + y2, z + sz * (d / 2) * k]);
    b.decoBrush('hull', pts, { mat: 'step' });
    dbox([x - w * 0.3, y + h * 0.15, z + (d / 2) * 0.99], [x - w * 0.3 + 0.35, y + h * 0.9, z + (d / 2) * 0.99 + 0.12], 'ember');
    dbox([x + w * 0.3 - 0.35, y + h * 0.15, z + (d / 2) * 0.99], [x + w * 0.3, y + h * 0.9, z + (d / 2) * 0.99 + 0.12], 'ember');
  };
  // a light strip along a platform's edges (frame coordinates, top at local y 0)
  const edgeStrips = (f, x0, x1, len, far = true) => inF(f, () => {
    for (const x of [x0 + 0.3, x1 - 0.3]) dbox([x - 0.07, 0.004, -len + 0.5], [x + 0.07, 0.03, -0.5], 'ember');
    if (far) dbox([x0, -0.06, -len], [x1, 0.012, -len + 0.15], 'gold');
  });
  // piers from the lava up to a platform
  const piers = (f, x0, x1, len, w = 2.6) => {
    for (const x of [x0 + w, x1 - w]) for (const z of [-w, -len + w]) { const p = f.p(x, 0, z); col(p[0], p[2], f.at[1] - 1.1, w); }
  };

  // --- the lake and the volcano ---
  dbox([-1700, LAKE - 3, -2000], [1700, LAKE, 700], 'lava');
  const VC = [80, -960];   // the volcano's centre (x, z)
  const TIERS = [[420, 290, -6, 90], [290, 190, 90, 190], [190, 80, 190, 310]];
  TIERS.forEach(([R0, R1, y0, y1]) => {
    const pts = [];
    for (let k = 0; k < 16; k++) { const a = (k / 16) * Math.PI * 2; pts.push([VC[0] + Math.cos(a) * R0, y0, VC[1] + Math.sin(a) * R0]); pts.push([VC[0] + Math.cos(a) * R1, y1, VC[1] + Math.sin(a) * R1]); }
    b.decoBrush('hull', pts, { mat: 'ash' });
  });
  [[0.1, 0], [0.9, 1], [1.5, 2], [2.2, 0], [3.0, 1], [3.7, 2], [4.4, 0], [5.1, 1], [5.7, 2], [4.0, 1], [2.6, 2], [1.0, 1]].forEach(([a, tier]) => {
    const [R0, R1, y0, y1] = TIERS[tier], pts = [];
    for (const [r, y] of [[R0, y0], [R1, y1]]) for (const da of [-0.035, 0.035]) for (const out of [0, 2.5]) pts.push([VC[0] + Math.cos(a + da) * (r + out), y, VC[1] + Math.sin(a + da) * (r + out)]);
    b.decoBrush('hull', pts, { mat: 'lava' });
  });
  b.decoBrush('prism', [VC[0], 311, VC[1]], 78, 2, { sides: 16, mat: 'lava' });
  b.deco('beacon', { pos: [VC[0], 400, VC[1]], size: [34, 170, 34], color: FIRE });
  for (let i = 0; i < 11; i++) {
    const a = (i / 11) * Math.PI * 2 + 0.3, r = 52 + (i % 3) * 14;
    b.deco('crystal', { pos: [VC[0] + Math.cos(a) * r, 335 + (i % 4) * 16, VC[1] + Math.sin(a) * r], size: [8, 40 + (i % 3) * 14, 8], color: i % 2 ? 0xff6a10 : 0xff9a30 });
  }
  for (let i = 0; i < 16; i++) {   // lava bombs
    const a = rnd() * Math.PI * 2, r = 30 + rnd() * 110, y = 360 + rnd() * 260, sz = 8 + rnd() * 20;
    b.deco('rock', { pos: [VC[0] + Math.cos(a) * r, y, VC[1] + Math.sin(a) * r], size: [sz, sz * 0.8, sz], color: 0x2c1a12 });
  }
  for (let i = 0; i < 9; i++) b.deco('rock', { pos: [VC[0] + (rnd() - 0.5) * 160, 520 + i * 55, VC[1] + (rnd() - 0.5) * 160], size: [150 + rnd() * 60, 70 + rnd() * 30, 150 + rnd() * 60], color: 0x1a1210 });   // the ash column

  // --- rocks, geysers and embers over the lake ---
  for (let i = 0, n = 0; i < 400 && n < 70; i++) {
    const x = (rnd() - 0.5) * 900 + 40, z = 120 - rnd() * 640;
    if (near(x, z, 38)) continue;
    const h = 12 + rnd() * 50, w = 8 + rnd() * 22;
    b.deco('rock', { pos: [x, LAKE + h * 0.3, z], size: [w, h, w * (0.8 + rnd() * 0.5)], color: 0x3a261c });
    n++;
  }
  for (let i = 0, n = 0; i < 300 && n < 16; i++) {
    const x = (rnd() - 0.5) * 700 + 40, z = 60 - rnd() * 560;
    if (near(x, z, 30)) continue;
    const h = 30 + rnd() * 70;
    b.deco('beacon', { pos: [x, LAKE + h / 2, z], size: [3 + rnd() * 5, h, 3 + rnd() * 5], color: i % 2 ? FIRE : 0xff8a20 });
    n++;
  }
  for (let i = 0; i < 90; i++) {
    const t = rnd(), z = 10 - t * 520, x = (z < -250 ? 80 : 4) + (rnd() - 0.5) * 120, y = 2 + rnd() * 70;
    if (near(x, z, 4)) continue;
    b.deco('crystal', { pos: [x, y, z], size: [0.5, 1.1 + rnd() * 0.8, 0.5], color: rnd() < 0.5 ? 0xff7020 : GOLD });
  }

  // --- the shore and the dock ---
  inF(fA, () => {
    dbox([-90, -14, 40], [90, 40, 160], 'crag');
    dbox([-60, -14, 8], [60, 16, 60], 'crag');
    for (let k = 0; k < 9; k++) b.deco('rock', { pos: [-50 + k * 12 + rnd() * 6, 8 + rnd() * 12, 40 + rnd() * 30], size: [14 + rnd() * 12, 14 + rnd() * 16, 12 + rnd() * 10], color: 0x3a261c });
    b.deco('arch', { pos: [0, 5.4, -6], size: [11.5, 10.8, 1.4], color: EMBER });
    for (let z = -3; z > -DOCK + 2; z -= 8) for (const x of [-4.4, 4.4]) brazier(x, 0, z);
    for (const x of [-9, 9]) statue(x, 0, 12, x < 0 ? 90 : 270, 1.1, true);
    for (const z of [-16, -34, -50]) for (const x of [-8.2, 8.2]) { box([x - 2.6, FOUND, z - 2.6], [x + 2.6, 0, z + 2.6], { mat: 'step' }); statue(x, 0, z, x < 0 ? 90 : 270, 0.95); }
    b.deco('arch', { pos: [0, 5.4, -27], size: [11.5, 10.8, 1.4], color: EMBER });
    b.deco('arch', { pos: [0, 5.4, -DOCK + 4], size: [11.5, 10.8, 1.4], color: EMBER });
  });
  edgeStrips(fA, -5, 5, DOCK);
  b.light(fA.p(0, 4, -10), 0xff7a30, 1.2, 26);

  // --- the broken bridge ---
  bridge.forEach((f, i) => {
    const len = SEG[i];
    edgeStrips(f, -3, 3, len);
    piers(f, -3, 3, len, 1.6);
    inF(f, () => {
      for (const x of [-3.2, 3.2]) b.deco('arch', { pos: [x, -4.4, -len / 2], size: [len - 0.5, 6.8, 0.8], yaw: 90, color: EMBER });
      for (const x of [-2.7, 2.7]) brazier(x, 0, -0.6, 0.8);
      for (let k = 0; k < 4; k++) {   // the broken end: rubble under the edge
        const r = rnd();
        b.decoBrush('block', [(rnd() - 0.5) * 4.6, -1.2 - rnd() * 1.8, -len - 0.3 - rnd() * 1.2], [0.8 + r * 1.3, 0.7 + r, 0.8 + r], { mat: 'step', yaw: rnd() * 80 });
      }
    });
    b.light(f.p(0, 3.5, -len / 2), 0xff7a30, 1, 20);
  });
  inF(bridge[1], () => {   // the ruined aqueduct wall: a gold coping, pillars at both ends
    const wl = SEG[1] + GAP.bridge[2] + 3;
    dbox([-3.5, 6, 0], [-2.5, 6.15, -wl], 'gold');
    b.deco('arch', { pos: [-3, 1.5, -wl / 2], size: [wl - 1, 9, 1], yaw: 90, color: EMBER });
  });
  for (const z of [-0.5, -(SEG[1] + GAP.bridge[2] + 3) + 0.5]) { const p = bridge[1].p(-3, 0, z); col(p[0], p[2], 5.5, 1.5); }

  // --- the forest: columns and capitals ---
  const zA = fBr.p(0, 0, 0)[2], zB = fSh.p(0, 0, 0)[2];
  for (let i = 0, n = 0; i < 500 && n < 34; i++) {
    const z = zA - rnd() * (zA - zB + 20), x = (rnd() - 0.5) * 80 + 2;
    if (near(x, z, 7)) continue;
    const top = 16 + rnd() * 30, w = 2 + rnd() * 1.6;
    col(x, z, top, w, i % 3 ? STONE : 0x6a5640);
    b.decoBrush('prism', [x, top - 0.3, z], w * 0.5 + 0.55, 0.6, { sides: 10, mat: 'step' });
    if (n % 3 === 0) brazier(x, top, z, 1.1);
    n++;
  }
  tops.forEach((pc, i) => {
    if (i === SLIDER) return;
    inF(fBr, () => {
      b.decoBrush('prism', [pc[0], pc[1] - 0.6, pc[2]], PR + 0.5, 0.25, { sides: 12, mat: 'gold' });
      b.deco('crystal', { pos: [pc[0] + (i % 2 ? 1 : -1) * 1.3, pc[1] + 0.9, pc[2] - 1.0], size: [0.4, 1.4, 0.4], color: 0xff7a1a });
    });
  });
  b.light(fBr.p(0, 4, -40), 0xff7a30, 1.2, 28);
  b.light(fBr.p(2, 4, -90), 0xff7a30, 1.2, 28);

  // --- the shrine and the ferry ---
  edgeStrips(fSh, SH.w0, SH.w1, SH.len, false);
  piers(fSh, SH.w0, SH.w1, SH.len, 2.6);
  inF(fSh, () => {
    b.deco('arch', { pos: [6, 4.8, -6], size: [12, 9.6, 1.2], yaw: 90, color: EMBER });
    for (const z of [-2.5, -9.5]) statue(-6.2, 0, z, 90, 0.85, true);
    for (const z of [-0.8, -SH.len + 0.8]) for (const x of [SH.w0 + 0.8, SH.w1 - 0.8]) brazier(x, 0, z);
    dbox([SH.w1 - 0.5, 0.004, -SH.len], [SH.w1, 0.04, 0], 'gold');
  });
  b.light(fSh.p(8, 5, -6), 0xff7a30, 1.4, 26);
  inF(fE, () => {   // dock posts of the ferry
    for (const x of [-GW / 2 - 0.6, GW / 2 + 0.6]) {
      b.deco('pillar', { pos: [x, 1.5, -GAP.river + 0.4], size: [0.8, 3, 0.8], color: STONE });
      b.deco('pillar', { pos: [x, 1.5, -0.4], size: [0.8, 3, 0.8], color: STONE });
    }
  });

  // --- the island and the rising stone ---
  edgeStrips(fIs, -8, 8, IS, false);
  piers(fIs, -8, 8, IS, 3);
  inF(fIs, () => {
    b.deco('pillar', { pos: [0, 7, -IS / 2], size: [2.2, 14, 2.2], color: STONE });
    b.deco('beacon', { pos: [0, 15.5, -IS / 2], size: [1.4, 3, 1.4], color: 0xff7a1a });
    for (const x of [-7.2, 7.2]) for (const z of [-1, -IS + 1]) brazier(x, 0, z, 0.9);
  });
  b.light(fIs.p(0, 5, -IS / 2), 0xff7a30, 1.3, 26);
  inF(fLf, () => {
    for (const x of [-GW / 2 - 0.8, GW / 2 + 0.8]) {
      b.deco('pillar', { pos: [x, LIFT_RISE / 2 + 4, -GL / 2], size: [1.6, LIFT_RISE + 8, 1.6], color: STONE });
      b.deco('beacon', { pos: [x, LIFT_RISE + 9.6, -GL / 2], size: [0.6, 1.4, 0.6], color: 0xff7a1a });
    }
    b.deco('beam', { pos: [0, LIFT_RISE + 8.4, -GL / 2], size: [GW + 2.4, 0.9, 0.9], color: 0xc89a50 });
  });

  // --- the plaza and the cracked stair ---
  edgeStrips(fPl, -8, 8, PL, false);
  piers(fPl, -8, 8, PL, 3);
  inF(fPl, () => { for (const x of [-7.2, 7.2]) for (const z of [-1, -PL + 1]) brazier(x, 0, z, 0.9); dbox([-16, -5.1, 2], [16, -5, -22], 'lava'); });
  for (const sx of [-1, 1]) pylon(...fS0.p(sx * 17, FOUND - fS0.at[1], 6), 8, 8, 26 - FOUND + fS0.at[1]);
  b.glyph(fS0.p(0, 0.02, 0.6), 'shield', 0);
  b.sign(fS0.p(-4.6, 2.8, 4.5), 0, { title: 'PAJZS-STRAFE UGRÁS', keys: 'hátra-lefelé célzás · töltés · SPACE + elengedés', text: 'Nézz magad mögé, kb. 50°-kal lefelé, töltsd a pajzsot, majd ugorj és lőj egyszerre: a lökés előre és fel visz. A csúcson: dupla ugrás.' });
  stairs.forEach(({ f, len }, i) => {
    const fp = i ? stairs[i - 1].f : fS0, lp = i ? stairs[i - 1].len : 0;
    const crack = STAIR.crack[i], rise = STAIR.rise[i];
    inF(f, () => {
      dbox([-STEP_W, 0, -0.35], [STEP_W, 0.05, -0.02], 'gold');   // the landing lip
      for (const x of [-STEP_W + 0.3, STEP_W - 0.3]) dbox([x - 0.07, 0.004, -len + 0.5], [x + 0.07, 0.03, -0.5], 'ember');
      if (i < stairs.length - 1) dbox([-STEP_W, -0.06, -len], [STEP_W, 0.012, -len + 0.15], 'gold');
      for (let x = -6; x <= 6; x += 4) dbox([x - 0.18, -rise - 4.4, 0.01], [x + 0.18, -0.5, 0.16], 'ember');   // carved glyph strips on the riser
      for (const x of [-STEP_W - 0.2, STEP_W + 0.2]) { b.deco('pillar', { pos: [x, 3.2, -len / 2], size: [1.6, 6.4, 1.6], color: STONE }); brazier(x, 6.4, -len / 2, 1); }
    });
    inF(fp, () => dbox([-STEP_W - 0.6, -5.15, -lp - crack], [STEP_W + 0.6, -5.05, -lp], 'lava'));   // the lava in the crack
    inF(f, () => dbox([-45, -9.1, 3], [45, -9, -len - 3], 'lava'));                                  // the lava flow on both sides of the step
    if (i % 2 === 0) for (const sx of [-1, 1]) {
      const px = sx * (STEP_W + 7);
      inF(f, () => { box([px - 2.6, FOUND - f.at[1], -len / 2 - 2.6], [px + 2.6, 0, -len / 2 + 2.6], { mat: 'step' }); statue(px, 0, -len / 2, sx < 0 ? 90 : 270, 1.15); });
      track(f, px - 2.6, px + 2.6, len / 2 + 2.6);
    }
    b.light(f.p(0, 5, -len / 2), 0xff7a30, 1.2, 22);
  });

  // --- the sacred way ---
  piers(fRd, -4, 4, ROAD1, 1.8);
  piers(fMid, -4, 4, MID, 1.8);
  edgeStrips(fRd, -4, 4, ROAD1);
  edgeStrips(fMid, -4, 4, MID);
  const ROADEND = ROAD1 + GAP.road[0] + MID + GAP.road[1];
  for (const [f, len] of [[fRd, ROAD1], [fMid, MID]]) inF(f, () => { for (const x of [-4, 4]) box([x - (x < 0 ? 0.4 : 0), 0, -len], [x + (x < 0 ? 0 : 0.4), 1, 0], { mat: 'step' }); });
  for (const [f, len] of [[fRd, ROAD1], [fMid, MID]]) inF(f, () => { for (const x of [-4, 4]) dbox([x - 0.2, 1, -len], [x + 0.2, 1.07, 0], 'ember'); });
  inF(fRd, () => {
    b.deco('arch', { pos: [0, 6.2, 1.5], size: [11, 12.4, 1.2], color: EMBER });
    for (let z = -10; z > -ROAD1; z -= 10) b.marker([4.7, 1.7, z], `${-z} m`);
    for (let z = -6; z > -ROAD1 + 3; z -= 14) for (const x of [-6.2, 6.2]) { const p = fRd.p(x, 0, z); col(p[0], p[2], fRd.at[1] + 6, 1.8); brazier(x, 6, z, 1); }
    for (const z of [-3, -ROAD1 + 8]) for (const x of [-9, 9]) { box([x - 2.6, FOUND - fRd.at[1], z - 2.6], [x + 2.6, 0, z + 2.6], { mat: 'step' }); statue(x, 0, z, x < 0 ? 90 : 270, 1.15); }
    dbox([-30, -6.05, 6], [30, -6, -ROADEND], 'lava');
  });
  for (let z = 4; z < ROAD1; z += 16) { const p = fRd.p(0, 0, -z); col(p[0], p[2], fRd.at[1] - 1.1, 3.4); }
  b.light(fRd.p(0, 5, -12), 0xff7a30, 1.3, 30);
  b.light(fRd.p(0, 5, -34), 0xff7a30, 1.3, 30);
  b.light(fMid.p(0, 5, -6), 0xff7a30, 1.3, 30);

  // --- the courtyard, the great chasm, the sanctum and the altar ---
  inF(fCy, () => {
    dbox([-10, 0.004, -CY], [10, 0.04, -CY + 0.5], 'gold');
    for (const x of [-26, -18, 18, 26]) statue(x, 0, -4, 0, 1.5, true);
    for (const x of [-12, 12]) for (const z of [-3, -CY + 3]) brazier(x, 0, z, 1.2);
    dbox([-30, -7.05, -CY], [30, -7, -CY - GAP.chasm], 'lava');
    for (const x of [-30.2, 30.2]) dbox([x - 0.15, -7, -CY], [x + 0.15, 0, -CY - GAP.chasm], 'ember');
  });
  b.sign(fCy.p(-6.5, 2.9, -4), 0, { title: 'FUTÓ PAJZS-STRAFE', keys: 'futás · töltés · SPACE + elengedés hátra-lefelé', text: 'A szakadék szélén, futás közben lőj magad mögé, kb. 50°-kal lefelé: a lendület és a lökés átvisz. A csúcson: dupla ugrás.' });
  b.light(fCy.p(0, 6, -8), 0xff7a30, 1.4, 30);
  b.light(fCy.p(0, 6, -CY - GAP.chasm / 2), 0xff6a20, 1.6, 40);
  inF(fSn, () => {
    for (const x of [-22, -12, 12, 22]) statue(x, 0, -5, 180, 2.0, true);
    for (const x of [-9, 9]) for (const z of [-2, -SN + 2]) brazier(x, 0, z, 1.3);
    dbox([-10, 0.004, -0.35], [10, 0.04, -0.02], 'gold');
  });
  b.light(fSn.p(0, 6, -7), 0xff7a30, 1.5, 32);
  inF(fSn, () => {
    dbox([-3, 0.004, -SN], [3, 0.04, -SN + 0.3], 'gold');
    crown.forEach((p, i) => {
      b.decoBrush('prism', [p.x, p.y - 0.5, -p.fwd], p.r + 0.5, 0.25, { sides: 16, mat: 'gold' });
      if (i < crown.length - 1) b.deco('crystal', { pos: [p.x + 1.1, p.y + 0.8, -p.fwd - 0.9], size: [0.4, 1.4, 0.4], color: 0xff7a1a });
    });
    b.deco('ring', { pos: [alt.x, alt.y + 5.4, -alt.fwd - 3.5], size: [11, 11, 0.7], color: 0xffffff });
    b.deco('ring', { pos: [alt.x, alt.y + 5.4, -alt.fwd - 3.5], size: [8, 8, 0.5], color: GOLD });
    b.deco('beacon', { pos: [alt.x, alt.y + 17, -alt.fwd - 1], size: [3.5, 32, 3.5], color: FIRE });
    for (const sx of [-1, 1]) { b.deco('beacon', { pos: [alt.x + sx * 5, alt.y + 7, -alt.fwd - 3], size: [1, 14, 1], color: 0xff8a20 }); brazier(alt.x + sx * 3.6, alt.y, -alt.fwd + 1.5, 1.1); }
    dbox([-60, -9.05, -SN], [60, -9, -SN - 60], 'lava');
  });
  b.light(fSn.p(alt.x, alt.y + 6, -alt.fwd), 0xffc070, 1.8, 36);

  b.route([...pre, ...ferry, ...post]);
  b.skip('pajzs-strafe ugrás a lávafolyón', [...pre, ...skipRoute, ...post]);

  // ---------- kill volumes (lava) ----------
  kill(-1700, 1700, -2000, 700, -60, LAKE + 0.2);
  stairs.forEach(({ f, len }, i) => {
    const lp = i ? stairs[i - 1].len : 0, crack = STAIR.crack[i], fp = i ? stairs[i - 1].f : fS0;
    inF(fp, () => kill(-STEP_W - 0.6, STEP_W + 0.6, -lp - crack, -lp, -12, -5));   // the crack
    inF(f, () => kill(-45, 45, 3, -len - 3, -14, -9));                               // the sides of the step (a lava flow, see the scenery)
  });
  inF(fRd, () => kill(-30, 30, 6, -ROADEND, -12, -6));                               // the lava under the sacred way
  inF(fCy, () => kill(-30.6, 30.6, 0, -CY - GAP.chasm, -16, -7));                    // the chasm
  inF(fSn, () => kill(-60, 60, 0, -SN - 60, -16, -9));
  inF(fPl, () => kill(-16, 16, 2, -22, -9, -5));                                     // the plaza
});
