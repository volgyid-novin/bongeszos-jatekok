// ORBITÁLIS (Mester): orbital station, full combos
import { defineMap } from '../sim/builder.js';
import { R } from '../sim/bot.js';
import { rotY, mulberry32 } from '../sim/math.js';
import { cyclePos } from '../sim/world.js';

const CYAN = 0x40e0ff, GOLD = 0xffc84a, WHITE = 0xf0f6fa;
const UPTO = 10;
// S1 dock
const SX = 6, SHA = 7.6, GA = 16.4, GD = 14.0;
// S2 truss
const HOPS = 7, EFF = 0.7, TL = 62.6, G2 = 18.1;
// S2b docking slot: three wall-dodge hops, gaps and height steps
const Q1 = 16.4, Q2 = 13.6, Q3 = 18.5, DQ2 = 2, DQ3 = -2;
// S3 solar panel pistons: gap, speed, wait, the bot's take-off delay (ticks) and the panels' phases
// S4 mega leaps (shield jump + wall dodge + double jump): gaps and height steps
const L1 = 21.6, L2 = 23.5, L3 = 19.3, L4 = 25.2, DL2 = -3, DL3 = 3, DL4 = -6;
// S5 boost corridor and the shield strafe leap
const GB5 = 21.2, GB5B = 18.8, DB5B = 1.5, GSS = 23.2, DSS = 3;
// S6 wheels: radius, speed, exit gap, the bot's boarding offset (m below the entry level) and exit angle (degrees past the entry point)
const RW = 10, SPW = 5.5, GEX = 15.4, BOARD = 0.7, EXU = 1.9, WPH = 13.5;
const RW2 = 13, SPW2 = 6.5, GEX2 = 17.2, BOARD2 = 0.6, EXU2 = 1.9, WPH2 = 0, EXY2 = -1.5;
// S7 spine: up-leap gap, elevator rise and speed, the lift leap gap
const UL = 16.2, CH7 = 13.6, DCH = 2, EH = 10, ESP = 3.5, GE = 17.6, PE7 = 4, WE = 0.25;
// S8 the gate: chain length, hops, the final shield strafe leap, its height step
const HOPS8 = 7, EFF8 = 0.7, TL8 = 35.4, GFIN = 38.3, DF8 = -4;
const PG3 = 10.8, PSP = 3.5, PWT = 0.5, TK3 = 24, P3A = 0, P3B = 1.3, P3C = 2.6, P3D = 0.7, P3E = 2.0, P3F = 3.3;

export default defineMap({
  id: 'orbitalis', name: 'ORBITÁLIS', diff: 'mester', order: 8, authorTime: 153.85,
  blurb: 'Orbitális állomás az űrben. Teljes kombinációk: pajzsugrás, falról kiugrás, dupla ugrás, strafe-láncok.',
  theme: {
    sky: { type: 'nebula', top: 0x050818, horizon: 0x2a1858, bottom: 0x02030c, sunDir: [0.6, 0.35, -0.7], sunColor: 0xfff0e0, stars: 1,
      planet: { dir: [0.35, -0.55, -0.75], radius: 38, sea: 0x1a4a92, land: 0x3f7040, atmo: 0x5ab0ff } },
    fog: { color: 0x05061a, near: 300, far: 4000 },
    hemi: { sky: 0x6080c0, ground: 0x101828, intensity: 0.7 }, sun: { color: 0xfff0e0, intensity: 2.0 },
    palette: { floor: 0xdfe7ee, wall: 0x9aa6b4, trim: CYAN, accent: GOLD, glow: CYAN, danger: 0xff3040 },
    bloom: 1.0, ambient: 'space',
  },
}, (b) => {
  b.mat('floor', { base: 'panel', color: 0xdfe7ee, trim: CYAN });
  b.mat('wall', { base: 'panel', color: 0x9aa6b4, trim: GOLD });
  b.mat('walldodge', { base: 'stripe', color: 0xc8d2dc, trim: GOLD, emissive: 0x3a2a00 });
  b.mat('boostwall', { base: 'panel', color: 0x2a6a88, trim: CYAN, emissive: CYAN });
  b.mat('trim', { base: 'neon', color: CYAN, emissive: CYAN });
  b.mat('gold', { base: 'neon', color: GOLD, emissive: GOLD });
  b.mat('mover', { base: 'metal', color: 0xd8b04a, trim: GOLD });
  b.mat('hull', { base: 'metal', color: 0xc4ccd4, trim: CYAN });

  const frame = (at, yaw) => ({ at, yaw, p: (x, y, z) => { const q = rotY([x, y, z], yaw); return [q[0] + at[0], q[1] + at[1], q[2] + at[2]]; } });
  const XZ = (f, x, z) => { const q = f.p(x, 0, z); return [q[0], q[2]]; };
  const inF = (f, fn) => b.group({ at: f.at, yaw: f.yaw }, fn);
  const box = (x0, y0, z0, x1, y1, z1, mat = 'wall') => b.decoBrush('box', [x0, y0, z0], [x1, y1, z1], { mat });
  let r = null;
  const parts = [];
  const sections = [];
  const section = (fn) => sections.push(() => { r = []; parts.push(r); return fn(); });

  // a walkable deck (local frame, forward = +x), top at y
  const deck = (x0, x1, y, o = {}) => {
    const hw = o.hw ?? 5, z0 = o.z0 ?? -hw, z1 = o.z1 ?? hw;
    b.box([x0, y - 1.2, z0], [x1, y, z1], { mat: o.mat || 'floor' });
    for (const [z, s] of [[z0, 1], [z1, -1]]) box(x0 + 0.4, y + 0.004, z + s * 0.25 - 0.1, x1 - 0.4, y + 0.03, z + s * 0.25 + 0.1, 'trim');
    box(x1 - 0.6, y + 0.004, z0, x1, y + 0.03, z1, 'gold');
    return { x0, x1, y, hw, z0, z1 };
  };
  const slot = (xa, xb, xe, y, o = {}) => {
    const cw = o.cw ?? 0.9, top = y + (o.h ?? 11), bot = y - 14, fw = o.fw ?? 5;
    for (const s of [-1, 1]) {
      const pts = [];
      for (const yy of [bot, top]) for (const q of [[xa, s * fw], [xb, s * cw], [xe, s * cw], [xe, s * fw]]) pts.push([q[0], yy, q[1]]);
      b.hull(pts, { mat: o.mat || 'walldodge' });
    }
    return top;
  };
  const mv = (w, id) => w.movers.find((m) => m.id === id);
  const moverY = (w, id, dt) => cyclePos(mv(w, id).cycle, w.mt + dt, [0, 0, 0]).pos[1];
  // predicted LOCAL offset of a mover (frame f) after dt more ticks
  const moverLoc = (w, id, f, dt) => rotY(cyclePos(mv(w, id).cycle, w.mt + dt, [0, 0, 0]).pos, -f.yaw);
  // the bot's hop planner (not part of the map): would a jump + double jump that takes off TK3 ticks from now land on the target
  // panel? The flight is the proof bot's: 8.8 m/s, jump 6.8 m/s plus the platform's vertical speed, double jump at the apex.
  const hopOk = (w, fromId, toId, toY, gap, len) => {
    const y0 = fromId ? moverY(w, fromId, TK3) : 0;
    let y = y0, vy = 6.8 + (fromId ? (moverY(w, fromId, TK3 + 6) - y0) * 20 : 0), dj = false, inside = false;
    for (let i = 1; i < 400; i++) {
      const x = (8.8 * i) / 120;
      vy -= 19 / 120; y += vy / 120;
      if (!dj && vy <= 0) { vy = 7.3; dj = true; }
      const th = toId ? moverY(w, toId, TK3 + i) : toY;
      if (x >= gap + 0.3 && x <= gap + len - 0.3) {
        if (!inside) { inside = true; if (y < th - 0.35) return false; }
        if (vy < 0 && y <= th + 0.02) return true;
      } else if (x > gap + len) return false;
    }
    return false;
  };
  const cpIn = (f, d, label) => inF(f, () => b.checkpoint([d.x0 + 0.5, d.y, d.z0 + 0.5], [d.x0 + 3.5, d.y + 14, d.z1 - 0.5], { spawn: [d.x0 + 2, d.y, (d.z0 + d.z1) / 2], yaw: 270, label }));

  b.start([-24, 0, 0], 270);
  b.kill([-200, -60, -400], [1200, -30, 400], 'void');
  let F = frame([0, 0, 0], 0);   // the current frame: the end of the last deck, local +x forward

  // ================= 1: the dock =================
  section(() => {
    const f = F;
    inF(f, () => {
      deck(-30, SX + 16, 0, { hw: 8 });
      b.box([SX, -14, -5], [SX + 16, SHA - 0.4, 5], { mat: 'hull' });
      b.box([SX, SHA - 0.4, -5], [SX + 16, SHA, 5], { mat: 'floor' });
      const roofEnd = SX + 16, armX0 = roofEnd + GA;
      slot(SX + 2, SX + 10, armX0 + 12, SHA, {});
      deck(armX0, armX0 + 20, SHA, { hw: 5 });
      const radX0 = armX0 + 20 + GD;
      deck(radX0, radX0 + 24, SHA, { hw: 5 });
      f.armX0 = armX0; f.radX0 = radX0;
    });
    r.push(R.run(...XZ(f, SX - 2.6, 0), { stop: true, tol: 0.3 }));
    r.push(R.shieldJump({ charge: 1, dj: 'apex', to: XZ(f, SX + 3, 0) }));
    r.push(R.jump({ edge: true, to: XZ(f, f.armX0 + 4, 0), air: [R.wallDodge('F', { at: 'wall' })], dj: 'apex' }));
    r.push(R.dodgeJump('F', { edge: true, to: XZ(f, f.radX0 + 5, 0) }));
    const d = { x0: f.radX0, x1: f.radX0 + 24, y: SHA, z0: -5, z1: 5 };
    cpIn(f, d, '1');
    F = frame(f.p(f.radX0 + 24, SHA, 0), f.yaw);
  });

  // ================= 2: the truss =================
  section(() => {
    const f = F;
    inF(f, () => {
      deck(0, TL, 0, { hw: 2.2 });
      deck(TL + G2, TL + G2 + 22, 0, { hw: 6 });
    });
    r.push(R.run(...XZ(f, 1, 0), { tol: 1.0 }));
    r.push(R.strafe({ hops: HOPS, eff: EFF, to: XZ(f, TL + 300, 0), tol: 1 }));
    r.push(R.jump({ to: XZ(f, TL + G2 + 6, 0), dj: 'apex' }));
    F = frame(f.p(TL + G2 + 22, 0, 0), f.yaw);
  });

  // ================= 2b: the docking slot =================
  section(() => {
    const f = F;
    const e1 = { x0: Q1, x1: Q1 + 8, y: 0 };
    const e2 = { x0: e1.x1 + Q2, x1: e1.x1 + Q2 + 8, y: DQ2 };
    const e3 = { x0: e2.x1 + Q3, x1: e2.x1 + Q3 + 8, y: DQ2 + DQ3 };
    const dend = { x0: e3.x1, x1: e3.x1 + 18, y: DQ2 + DQ3, z0: -6, z1: 6 };
    inF(f, () => {
      slot(-12, -6, dend.x0, 0, { fw: 6 });
      for (const e of [e1, e2, e3]) deck(e.x0, e.x1, e.y, { hw: 1.6 });
      deck(dend.x0, dend.x1, dend.y, { hw: 6 });
    });
    r.push(R.run(...XZ(f, -3, 0), { tol: 0.6 }));
    for (const e of [e1, e2, e3]) r.push(R.jump({ edge: true, to: XZ(f, e.x0 + 4, 0), air: [R.wallDodge('F', { at: 'wall' })], dj: 'apex' }));
    cpIn(f, dend, '2');
    F = frame(f.p(dend.x1, dend.y, 0), f.yaw);
  });

  // ================= 3: the solar wings =================
  section(() => {
    const f = F, trav = [4, 6, 4, 7, 5, 8], phs = [P3A, P3B, P3C, P3D, P3E, P3F];
    const ps = [];
    let px = PG3;
    inF(f, () => {
      trav.forEach((h, k) => {
        const k0 = px, id = 'S' + (k + 1);
        b.mover(id, { path: [[0, h, 0]], speed: PSP, wait: PWT, phase: phs[k] }, () => b.box([k0, -1, -4], [k0 + 6, 0, 4], { mat: 'mover' }));
        ps.push({ id, x0: k0, x1: k0 + 6 });
        px += 6 + PG3;
      });
      deck(px, px + 24, trav[trav.length - 1], { hw: 6 });
    });
    const m0 = { x0: px, x1: px + 24, x: px };
    const hop = (from, to, toId, toY) => [
      R.run(...XZ(f, from.x1 - 1.0, 0), { stop: true, tol: 0.3 }),
      R.until((w) => hopOk(w, from.id, toId, toY, PG3, toId ? 6 : 24), { timeout: 40 }),
      R.jump({ edge: true, to: XZ(f, to.x0 + 3, 0), dj: 'apex' }),
    ];
    r.push(...hop({ x1: 0 }, ps[0], 'S1', 0));
    for (let k = 1; k < ps.length; k++) r.push(...hop(ps[k - 1], ps[k], ps[k].id, 0));
    r.push(...hop(ps[ps.length - 1], m0, null, trav[trav.length - 1]));
    cpIn(f, { x0: m0.x0, x1: m0.x1, y: trav[trav.length - 1], z0: -6, z1: 6 }, '3');
    F = frame(f.p(px + 24, trav[trav.length - 1], 0), f.yaw);
  });

  // ================= 4: the giant leaps =================
  section(() => {
    const f = F;
    // module k: its deck ends at xe[k]; a launch slot over its last 12 m
    const mods = [{ x0: -24, x1: 0, y: 0 }];
    const m2 = { x0: L1, x1: L1 + 18, y: 0 };
    const m3 = { x0: m2.x1 + L2, x1: m2.x1 + L2 + 18, y: DL2 };
    const m4 = { x0: m3.x1 + L3, x1: m3.x1 + L3 + 18, y: DL2 + DL3 };
    const m5 = { x0: m4.x1 + L4, x1: m4.x1 + L4 + 24, y: DL2 + DL3 + DL4 };
    mods.push(m2, m3, m4, m5);
    inF(f, () => {
      for (const m of [mods[1], mods[2], mods[3], mods[4]]) deck(m.x0, m.x1, m.y, { hw: 6 });
      for (const m of [mods[0], mods[1], mods[2], mods[3]]) slot(m.x1 - 12, m.x1 - 6, m.x1 + 3, m.y, { fw: 6 });
    });
    for (let k = 0; k < 4; k++) {
      const m = mods[k], n = mods[k + 1];
      r.push(R.run(...XZ(f, m.x1 - 5.5, 0), { stop: true, tol: 0.3 }));
      r.push(R.shieldJump({ charge: 1, to: XZ(f, n.x0 + 5, 0), air: [R.wallDodge('F', { at: 'wall' })], dj: 'apex' }));
      if (k === 1) cpIn(f, { x0: n.x0, x1: n.x1, y: n.y, z0: -6, z1: 6 }, '4');
    }
    F = frame(f.p(m5.x1, m5.y, 0), f.yaw);
  });

  // ================= 5: the boost corridor and the shield strafe leap =================
  section(() => {
    const f = F, CB = 1.2;
    const xm0 = GB5, xm1 = GB5 + 12, xa0 = xm1 + GB5B, xa1 = xa0 + 30;
    inF(f, () => {
      slot(-18, -10, xa0 + 10, 0, { cw: CB, mat: 'boostwall', fw: 6 });
      deck(xm0, xm1, 0, { hw: 1.8 });
      deck(xa0, xa1, DB5B, { hw: 6 });
      deck(xa1 + GSS, xa1 + GSS + 24, DB5B + DSS, { hw: 6 });
    });
    r.push(R.run(...XZ(f, -10, 0), { stop: true, tol: 0.4 }));
    r.push(R.charge(true, { to: 1 }));
    r.push(R.jump({ edge: true, to: XZ(f, xm0 + 6, 0), air: [R.wallBoost({ aimAt: f.p(-1, 1.6, -CB), at: 0 })], dj: 'apex' }));
    r.push(R.charge(false));
    r.push(R.run(...XZ(f, xm0 + 3, 0), { stop: true, tol: 0.3 }));
    r.push(R.charge(true, { to: 1 }));
    r.push(R.jump({ edge: true, to: XZ(f, xa0 + 6, 0), air: [R.wallBoost({ aimAt: f.p(xm1 - 1, 1.6, -CB), at: 0 })], dj: 'apex' }));
    r.push(R.charge(false));
    cpIn(f, { x0: xa0, x1: xa1, y: DB5B, z0: -6, z1: 6 }, '5');
    r.push(R.charge(true));
    r.push(R.run(...XZ(f, xa1 - 0.4, 0), { tol: 0.3 }));
    r.push(R.shieldJump({ charge: 1, push: XZ(f, xa1 + 500, 0), pitch: -50, run: XZ(f, xa1 + 500, 0), to: XZ(f, xa1 + GSS + 6, 0), dj: 'apex' }));
    F = frame(f.p(xa1 + GSS + 24, DB5B + DSS, 0), f.yaw);
  });

  // ================= 6: the wheels =================
  // wheel(f, c): an entry deck, three gondolas on a loop (A: board on the left, ride over the top; B: board at the bottom, ride up the
  // far side), an exit deck behind a forced lift jump. c = { id, kind, R, speed, gex, exu, exy, board, wph, ed, label }
  const wheel = (f, c) => {
    const Rw = c.R, xP = c.ed + 4.5;   // the gondola's centre at P0
    const rel = (a) => (c.kind === 'A' ? [Rw * (1 - Math.cos(a)), Rw * Math.sin(a), 0] : [Rw * Math.sin(a), Rw * (1 - Math.cos(a)), 0]);
    const pts = [];
    for (let i = 1; i < 8; i++) pts.push(rel((i * Math.PI) / 4));
    const loop = [[0, 0, 0], ...pts];
    const off = (p) => rotY(p, f.yaw);
    const at = (u) => { const i = Math.floor(u) % 8, k = u - Math.floor(u), p = loop[i], q = loop[(i + 1) % 8]; return off([p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k, 0]); };
    const period = (8 * 2 * Rw * Math.sin(Math.PI / 8)) / c.speed;
    const exitX = xP + Rw + 3 + c.gex, exitY = loop[2][1] + c.exy;
    inF(f, () => {
      deck(0, c.ed, 0, { hw: 6 });
      for (let k = 0; k < 3; k++) b.mover(c.id + (k + 1), { path: pts, speed: c.speed, wait: 0, mode: 'loop', phase: c.wph + (k * period) / 3 }, () => b.box([xP - 3, -1, -3], [xP + 3, 0, 3], { mat: 'mover' }));
      deck(exitX, exitX + 24, exitY, { hw: 6 });
    });
    if (c.turn) r.push(R.run(...XZ(f, 0, 0), { tol: 1.5 }));
    r.push(R.run(...XZ(f, c.ed - 1, 0), { stop: true, tol: 0.3 }));
    r.push(R.waitMover(c.id + '1', { near: at(8 - c.board), tol: 0.4 }));
    r.push(R.jump({ edge: true, to: XZ(f, xP - 1.6, 0) }));
    r.push(R.waitMover(c.id + '1', { near: at(c.exu), tol: 0.4 }));
    r.push(R.jump({ edge: true, to: XZ(f, exitX + 6, 0), dj: 'apex' }));
    cpIn(f, { x0: exitX, x1: exitX + 24, y: exitY, z0: -6, z1: 6 }, c.label);
    return frame(f.p(exitX + 24, exitY, 0), f.yaw);
  };
  section(() => {
    F = wheel(frame(F.at, F.yaw + 90), { id: 'W', kind: 'A', R: RW, speed: SPW, gex: GEX, exu: EXU, exy: -1.5, board: BOARD, wph: WPH, ed: 22, label: '6', turn: true });
  });
  section(() => {
    F = wheel(F, { id: 'V', kind: 'A', R: RW2, speed: SPW2, gex: GEX2, exu: EXU2, exy: EXY2, board: BOARD2, wph: WPH2, ed: 20, label: '7' });
  });

  // ================= 7: the reactor spine =================
  section(() => {
    const f = F, SA = 6, MA = 14, yb = SHA + 6;
    const bx0 = SA + MA + UL, bx1 = bx0 + 18;
    const yc = yb + DCH, cx0 = bx1 + CH7, cx1 = cx0 + 18;
    const exA = cx1 + 0.4, ex1 = exA + 4, lx0 = ex1 + GE;
    inF(f, () => {
      deck(0, SA + MA, 0, { hw: 7 });
      b.box([SA, -14, -5], [SA + MA, SHA - 0.4, 5], { mat: 'hull' });
      b.box([SA, SHA - 0.4, -5], [SA + MA, SHA, 5], { mat: 'floor' });
      slot(SA + 2, SA + 8, SA + MA + 3, SHA, { fw: 5 });
      deck(bx0, bx1, yb, { hw: 6 });
      slot(bx1 - 12, bx1 - 6, cx0 + 10, yb, { fw: 6 });
      deck(cx0, cx1, yc, { hw: 6 });
      slot(cx1 - 8, cx1 - 3, ex1 + 3, yc, { h: EH + 12, fw: 6 });
      b.mover('E', { path: [[0, EH, 0]], speed: ESP, wait: 1.5, phase: PE7 }, () => b.box([exA, yc - 1, -0.85], [ex1, yc, 0.85], { mat: 'mover' }));
      deck(lx0, lx0 + 14, yc + EH, { hw: 6 });
    });
    r.push(R.run(...XZ(f, SA - 2.6, 0), { stop: true, tol: 0.3 }));
    r.push(R.shieldJump({ charge: 1, dj: 'apex', to: XZ(f, SA + 3, 0) }));
    r.push(R.run(...XZ(f, SA + MA - 5.5, 0), { stop: true, tol: 0.3 }));
    r.push(R.shieldJump({ charge: 1, to: XZ(f, bx0 + 5, 0), air: [R.wallDodge('F', { at: 'wall' })], dj: 'apex' }));
        r.push(R.run(...XZ(f, bx1 - 9, 0), { tol: 0.5 }));
    r.push(R.jump({ edge: true, to: XZ(f, cx0 + 5, 0), air: [R.wallDodge('F', { at: 'wall' })], dj: 'apex' }));
    r.push(R.run(...XZ(f, cx1 - 4, 0), { stop: true, tol: 0.4 }));
    r.push(R.waitMover('E', { near: [0, 0, 0], tol: 0.05, within: 0.5 }));
    r.push(R.run(...XZ(f, exA + 1.2, 0), { tol: 0.4 }));
    r.push(R.waitMover('E', { near: [0, EH * (1 - WE), 0], tol: 0.12 }));
    r.push(R.jump({ edge: true, to: XZ(f, lx0 + 5, 0), air: [R.wallDodge('F', { at: 'wall' })], dj: 'apex' }));
    cpIn(f, { x0: lx0, x1: lx0 + 14, y: yc + EH, z0: -6, z1: 6 }, '8');
    F = frame(f.p(lx0 + 14, yc + EH, 0), f.yaw);
  });

  // ================= 8: the gate =================
  section(() => {
    const f = F, SB = 6, MB = 12;
    const fx0 = SB + MB + TL8 + GFIN, fx1 = fx0 + 26;
    inF(f, () => {
      deck(0, SB + MB, 0, { hw: 7 });
      b.box([SB, -14, -5], [SB + MB, SHA - 0.4, 5], { mat: 'hull' });
      b.box([SB, SHA - 0.4, -5], [SB + MB, SHA, 5], { mat: 'floor' });
      deck(SB + MB, SB + MB + TL8, SHA, { hw: 2.2 });
      deck(fx0, fx1, SHA + DF8, { hw: 8 });
      b.finish([fx0 + 14, SHA + DF8, -7], [fx0 + 16, SHA + DF8 + 14, 7]);
    });
    r.push(R.run(...XZ(f, SB - 2.6, 0), { stop: true, tol: 0.3 }));
    r.push(R.shieldJump({ charge: 1, dj: 'apex', to: XZ(f, SB + 3, 0) }));
    r.push(R.charge(true));
    r.push(R.strafe({ hops: HOPS8, eff: EFF8, to: XZ(f, SB + MB + 400, 0), tol: 1 }));
    r.push(R.shieldJump({ charge: 1, push: XZ(f, SB + MB + 600, 0), pitch: -50, run: XZ(f, SB + MB + 600, 0), to: XZ(f, fx0 + 6, 0), dj: 'apex' }));
    r.push(R.run(...XZ(f, fx0 + 15, 0), { tol: 0.8 }));
    F = frame(f.p(fx1, SHA + DF8, 0), f.yaw);
  });

  for (let i = 0; i < sections.length; i++) { sections[i](); if (i + 1 === UPTO) break; }
  b.route(parts.flat());
});
