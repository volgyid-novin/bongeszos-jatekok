// VIHARGÁT: a colossal concrete dam in a thunderstorm at night. The course runs along the gate bridges of the dam crest
// (the dam itself is the lethal floor far below: dark concrete with yellow lines), climbs the gate towers and finishes on the
// roof of the giant floodlit tower that is visible from the start.
//
// Layout (x east, the reservoir lies to the north / -z, the gorge to the south / +z; the course heads +x, decks are 12 m wide):
//   0 start apron -> 1 crest bays (jump + double jump, dodge, two dodge jumps) -> 2 sluice lift (forced lift jump; skip: a
//   full shield jump + double jump onto the maintenance catwalk) -> vista deck -> 3 spillway slot (four wall-dodge hops)
//   -> 4 intake canyon (two shield wall boosts) -> 5 turbine well (five pistons, timed hops) -> 6 crane cages (a ferry and a
//   diagonal lift cage, forced lift jump) -> 7 the tower (shield jumps, an elevator, the roof).
// Margins are measured against the proof bot's edge-perfect maxima (wave 1 probe table + the reach finder): Nehéz 85-90 %.
// The movers' phases are chosen so that the proof route waits only about a second at each; the pistons are hopped with a
// prediction of the target's height at landing (R.until), which is only the bot's way to find the moment.
import { defineMap } from '../sim/builder.js';
import { R } from '../sim/bot.js';
import { mulberry32 } from '../sim/math.js';
import { cyclePos } from '../sim/world.js';

const YEL = 0xffd040, BLUE = 0x40b0ff, WHITE = 0xdce8ff, RED = 0xff4a30;
const LETHAL = -5;   // the dam top: touching it respawns you
// gaps (m) of the crest bays
const G1 = 9.7, G2 = 6.5, G3 = 14.0, G4 = 10.8;
const LIFT_H = 7, GL = 13.0, WH = 3.2, PL = 3;
// the spillway slot: four wall-dodge hops, their gaps and height steps
const H1 = 15.4, H2 = 14.4, H3 = 17.4, H4 = 12.8, DY2 = 1, DY3 = -1.5, DY4 = 2;
// the intake canyon: two wall boosts
const GB = 20, GB2 = 18, DYB2 = 1.5;
// the turbine well: five pistons (travel, phase), the gap between them, the bot's hop prediction (ticks, window in m)
const PG = 6.3, PH1 = 3, PH2 = 4.5, PH3 = 3, PH4 = 6, PH5 = 5, PS = 2.5, PW = 1.0, PP1 = 0, PP2 = 1.3, PP3 = 2.6, PP4 = 0.6, PP5 = 3.1, TK = 24, TF = 95, LO = -1.4, HI = 0.4;
// the crane cages: ferry path, diagonal cage path (x, y), forced gap, bot's jump moment (fraction of the path), speed, wait, phases
const PA = 18, PB = 14, DYC = 8, GC = 16, WC = 0.78, CSP = 5.5, CW = 1.6, PC1 = 4.4, PC2 = 1.5, PE = 7;
// the tower: step heights (m)
const SH1 = 7.0, EH = 7.0, SH3 = 7.0, SH4 = 6.8, SH5 = 6.4, SH6 = 7.0, TW = 12;

export default defineMap({
  id: 'vihargat', name: 'VIHARGÁT', diff: 'nehez', order: 7, authorTime: 115.567,
  blurb: 'Viharos éjszakai gát: zsilipek, mozgó kosarak, fali lökés és falugrás-lánc, a végén a világító torony.',
  theme: {
    sky: { type: 'gradient', top: 0x03060a, horizon: 0x1e2a36, bottom: 0x0a1016, sunDir: [-0.45, 0.4, 0.55], sunColor: 0x506880 },
    fog: { color: 0x1e2a36, near: 80, far: 2300 },
    hemi: { sky: 0x5a7490, ground: 0x1a2128, intensity: 0.72 }, sun: { color: 0x8aa4c0, intensity: 0.55 },
    palette: { floor: 0xb4c0cc, wall: 0x3a444e, trim: YEL, accent: BLUE, glow: 0xa8d8ff, danger: RED },
    bloom: 0.85, ambient: 'storm',
  },
}, (b) => {
  b.mat('floor', { base: 'panel', color: 0xb4c0cc, trim: YEL });
  b.mat('wall', { base: 'concrete', color: 0x3a444e, trim: BLUE });
  b.mat('damtop', { base: 'concrete', color: 0x3c4852, trim: YEL });
  b.mat('tower', { base: 'concrete', color: 0x7a8794, trim: BLUE });
  b.mat('walldodge', { base: 'stripe', color: 0x6a7682, trim: YEL, emissive: 0x3a2e00 });
  b.mat('boostwall', { base: 'panel', color: 0x3a7a96, trim: 0x80e0ff, emissive: 0x80e0ff });
  b.mat('trim', { base: 'neon', color: YEL, emissive: YEL });
  b.mat('glow', { base: 'neon', color: WHITE, emissive: WHITE });
  b.mat('gate', { base: 'hazard', color: 0xffc400, trim: 0x1c2228 });
  b.mat('steel', { base: 'metal', color: 0x5a6672, trim: YEL });
  b.mat('water', { base: 'metal', color: 0x0c1824, trim: BLUE });
  b.mat('rock', { base: 'rock', color: 0x20282e });

  let r = null;
  const parts = [];
  const rnd = mulberry32(7);
  const box = (x0, y0, z0, x1, y1, z1, mat = 'wall') => b.decoBrush('box', [x0, y0, z0], [x1, y1, z1], { mat });

  // a walkable deck, top at y, with a concrete pier down to the dam; a yellow lip marks the take-off edge
  const deck = (x0, x1, y, o = {}) => {
    const hw = o.hw ?? 6, z0 = o.z0 ?? -hw, z1 = o.z1 ?? hw;
    b.box([x0, y - 1.2, z0], [x1, y, z1], { mat: 'floor' });
    b.box([x0 + 0.8, y - Math.max(8, y + 8), z0 + 0.8], [x1 - 0.8, y - 1.2, z1 - 0.8], { mat: 'wall' });
    for (const [z, s] of [[z0, 1], [z1, -1]]) box(x0 + 0.5, y + 0.004, z + s * 0.25 - 0.1, x1 - 0.5, y + 0.03, z + s * 0.25 + 0.1, 'trim');
    box(x1 - 0.6, y + 0.004, z0, x1, y + 0.03, z1, 'gate');
    box(x0, y - 0.5, z0 - 0.15, x1, y - 0.3, z1 + 0.15, 'trim');   // a lit strip under the slab edge
    return { x0, x1, y, hw, z0, z1 };
  };
  // a lamp post outside the deck edge: it is lit, never in the way
  const lamp = (x, y, z, color = WHITE, light = true) => {
    b.deco('pillar', { pos: [x, y + 2.6, z], size: [0.32, 6.6, 0.32], color: 0x56626e });
    box(x - 0.5, y + 5.9, z - 0.5, x + 0.5, y + 6.2, z + 0.5, 'glow');
    b.deco('beacon', { pos: [x, y + 6.9, z], size: [0.35, 1.2, 0.35], color });
    if (light) b.light([x, y + 5.4, z], color, 1.0, 24);
  };
  const lamps = (d, step = 14, color) => { for (let x = d.x0 + 4; x < d.x1 - 2; x += step) for (const s of [-1, 1]) lamp(x, d.y, s * (d.hw + 0.4), color, s > 0 && x < d.x1 - 6); };
  // walled slot: a funnel from xa to xb, inner half-width cw from xb to xe (a hull block per side)
  const slot = (xa, xb, xe, y, o = {}) => {
    const cw = o.cw ?? 0.9, top = y + (o.h ?? 11), bot = -8, fw = o.fw ?? 6;
    for (const s of [-1, 1]) {
      const pts = [];
      for (const yy of [bot, top]) for (const q of [[xa, s * fw], [xb, s * cw], [xe, s * cw], [xe, s * fw]]) pts.push([q[0], yy, q[1]]);
      b.hull(pts, { mat: o.mat || 'walldodge' });
    }
    return top;
  };
  const cp = (d, label, y = d.y) => b.checkpoint([d.x0 + 0.5, y, d.z0 + 0.5], [d.x0 + 3.5, y + 14, d.z1 - 0.5], { spawn: [d.x0 + 2, y, (d.z0 + d.z1) / 2], yaw: 270, label });
  const mv = (w, id) => w.movers.find((m) => m.id === id);
  const moverY = (w, id, dt) => cyclePos(mv(w, id).cycle, w.mt + dt, [0, 0, 0]).pos[1];
  // a ring over a jump: the path of the intended flight
  const guide = (x, y, d = 7, color = WHITE) => b.deco('ring', { pos: [x, y, 0], size: [d, d, 0.35], color, yaw: 90 });
  // a girder across the course (along z)
  const girder = (x, y, len = 14, color = 0x6a7886) => b.deco('beam', { pos: [x, y, 0], size: [len, 1.0, 0.8], color, yaw: 90 });

  b.start([-48, 0, 0], 270);
  b.kill([-100, -12, -300], [900, LETHAL, 300], 'void');
  let d = deck(-52, 0, 0, { hw: 8 });   // the start apron
  const sections = [];
  const section = (fn) => sections.push(() => { r = []; parts.push(r); fn(); });
  let skipSteps = null;

  // ================= 0 + 1: the start apron and the crest bays =================
  section(() => {
    const ap = d;
    // low real parapets along the apron, a control hut, crates, lamps
    for (const s of [-1, 1]) b.box([ap.x0 + 2, 0, s > 0 ? 7.5 : -8], [ap.x1 - 5, 1.0, s > 0 ? 8 : -7.5], { mat: 'wall' });
    lamps(ap, 12);
    box(-50, 0, -22, -36, 7.5, -12, 'wall'); box(-50.5, 7.5, -22.5, -35.5, 8.1, -11.5, 'steel');
    for (let i = 0; i < 4; i++) box(-48 + i * 3.2, 4.2, -12.05, -46 + i * 3.2, 5.6, -11.95, 'glow');
    b.deco('pillar', { pos: [-43, 12, -17], size: [0.5, 9, 0.5], color: 0x56626e });
    b.deco('beacon', { pos: [-43, 16.8, -17], size: [0.4, 1.6, 0.4], color: RED });
    b.deco('crate', { pos: [-30, 0.65, -6.5], size: [1.3, 1.3, 1.3] }); b.deco('crate', { pos: [-30, 0.65, -5.2], size: [1.3, 1.3, 1.3] }); b.deco('crate', { pos: [-30, 1.95, -5.9], size: [1.3, 1.3, 1.3] });
    b.deco('pipe', { pos: [-24, 1.4, 6.6], size: [12, 0.5, 0.5] });
    b.deco('arch', { pos: [-14, 4.5, 0], size: [16, 9, 0.8], color: YEL, yaw: 90 });
    b.sign([-28, 2.3, -3.5], 270, { title: 'VIHARGÁT', keys: 'NEHÉZ', text: 'A gát tetején át a világító toronyig. Mozgó emelvények, fali lökés, falugrás-lánc.' });
    b.light([-40, 6, 0], WHITE, 1.2, 30);

    const d1 = deck(d.x1 + G1, d.x1 + G1 + 14, 1);
    const d2 = deck(d1.x1 + G2, d1.x1 + G2 + 14, 1);
    const d3 = deck(d2.x1 + G3, d2.x1 + G3 + 18, 0);
    const d3b = deck(d3.x1 + G4, d3.x1 + G4 + 18, 1.5);
    r.push(R.jump({ edge: true, to: [d1.x0 + 5, 0], dj: 'apex' }));
    r.push(R.dodge('F', { edge: true, to: [d2.x0 + 5, 0] }));
    r.push(R.dodgeJump('F', { edge: true, to: [d3.x0 + 5, 0] }));
    r.push(R.dodgeJump('F', { edge: true, to: [d3b.x0 + 5, 0] }));
    cp(d3b, '1');
    for (const dk of [d1, d2, d3, d3b]) lamps(dk, 14);
    // the gate frames over the bays: arches, girders and rings mark the flight; hoist cables hang beside the path
    for (const [a, c, y0] of [[ap.x1, d1.x0, 3.5], [d1.x1, d2.x0, 3], [d2.x1, d3.x0, 3.2], [d3.x1, d3b.x0, 4]]) {
      const m = (a + c) / 2;
      b.deco('arch', { pos: [m, y0 + 4.5, 0], size: [15, 9, 0.7], color: BLUE, yaw: 90 });
      guide(m, y0 + 0.4, 6);
      girder(m - 0.9, y0 + 9.6, 15); girder(m + 0.9, y0 + 9.6, 15);
    }
    d = d3b;
  });

  // ================= 2: the sluice lift (and the shield skip) =================
  section(() => {
    const lx0 = d.x1, LL = 9, prev = d, yb = d.y;
    b.mover('L1', { path: [[0, LIFT_H, 0]], speed: 3, wait: 1.5, phase: PL }, () => {
      b.box([lx0, yb - 1, -4], [lx0 + LL, yb, 4], { mat: 'gate' });
      box(lx0, yb - 0.5, -4.15, lx0 + LL, yb - 0.3, 4.15, 'trim');
    });
    const d4 = deck(lx0 + LL + GL, lx0 + LL + GL + 40, yb + LIFT_H);
    // the maintenance catwalk beside the shaft (the skip): reachable by a full shield jump + double jump, it joins the deck
    const sy = yb + LIFT_H;
    b.box([lx0 + 1.5, sy - 1.2, -10.5], [d4.x0, sy, -4.4], { mat: 'floor' });
    b.box([lx0 + 2.3, sy - 16, -9.7], [d4.x0 - 0.8, sy - 1.2, -5.2], { mat: 'wall' });
    box(lx0 + 1.5, sy - 0.5, -10.65, d4.x0, sy - 0.3, -4.25, 'trim');
    for (const z of [-10.5 + 0.25, -4.4 - 0.25]) box(lx0 + 2, sy + 0.004, z - 0.1, d4.x0 - 0.5, sy + 0.03, z + 0.1, 'trim');
    box(lx0 + 1.5, sy + 0.004, -10.5, lx0 + 2.1, sy + 0.03, -4.4, 'gate');
    r.push(R.run(prev.x1 - 3, 0));
    r.push(R.waitMover('L1', { near: [0, 0, 0], tol: 0.05, within: 0.6 }));
    r.push(R.run(lx0 + 1.5, 0, { tol: 0.4 }));
    r.push(R.waitMover('L1', { near: [0, WH, 0], tol: 0.12 }));
    r.push(R.jump({ edge: true, to: [d4.x0 + 5, 0], dj: 'apex' }));
    skipSteps = [
      R.run(lx0 - 1.5, -5.2, { stop: true, tol: 0.3 }),
      R.shieldJump({ charge: 1, dj: 'apex', to: [lx0 + 6, -7.5] }),
      R.run(d4.x0 - 1, -5.4, { tol: 0.8 }),
      R.run(d4.x0 + 4, -3),
    ];
    cp(d4, '2');
    // the shaft: guide rails, the winch house on top, warning lights; the catwalk (skip) with its own lamps
    for (const z of [-4.6, 4.6]) for (const x of [lx0 + 0.6, lx0 + LL - 0.6]) b.deco('pillar', { pos: [x, yb + 7, z], size: [0.5, 16, 0.5], color: 0x56626e });
    box(lx0 - 0.5, yb + 15, -5.4, lx0 + LL + 0.5, yb + 17.5, 5.4, 'steel'); box(lx0 + 1, yb + 17.5, -3, lx0 + LL - 1, yb + 20, 3, 'wall');
    box(lx0 + 2, yb + 18, 3.01, lx0 + LL - 2, yb + 19, 3.2, 'glow');
    b.deco('beacon', { pos: [lx0 + LL / 2, yb + 21.2, 0], size: [0.5, 1.6, 0.5], color: RED });
    for (const x of [lx0 + 1.8, lx0 + LL - 1.8]) b.deco('cable', { pos: [x, yb + 15, 4.4], to: [x, yb + 1.5, 4.4], radius: 0.08 });
    b.light([lx0 + LL / 2, yb + 4, 0], YEL, 1.1, 22);
    lamp(lx0 + 3, sy, -10.9, YEL); lamp(lx0 + 13, sy, -10.9, YEL, false);
    b.sign([lx0 - 6, yb + 2.4, 3.5], 270, { title: 'FELVONÓS UGRÁS', keys: 'ugorj, amíg a felvonó emelkedik', text: 'Felfelé menet a felvonó lendülete hozzáadódik az ugrásodhoz. Pajzsugrással a bal oldali átjárón is feljuthatsz.' });
    guide(lx0 + LL + GL / 2, yb + LIFT_H + 2.5, 8, YEL);
    lamps(d4, 16);
    // the vista: a tall floodlight mast beside the deck
    b.deco('pillar', { pos: [d4.x0 + 22, d4.y + 9, -11], size: [1.2, 20, 1.2], color: 0x56626e });
    box(d4.x0 + 20, d4.y + 18.8, -12.8, d4.x0 + 24, d4.y + 19.8, -9.2, 'glow'); b.light([d4.x0 + 22, d4.y + 17, -9], WHITE, 1.3, 40);
    d = d4;
  });

  // ================= 3: the spillway slot, a wall-dodge chain =================
  section(() => {
    const d4 = d, xa = d4.x1 - 20, xb = xa + 9;
    const e1 = deck(d4.x1 + H1, d4.x1 + H1 + 8, d4.y, { hw: 1.6 });
    const e2 = deck(e1.x1 + H2, e1.x1 + H2 + 8, d4.y + DY2, { hw: 1.6 });
    const e3 = deck(e2.x1 + H3, e2.x1 + H3 + 8, d4.y + DY2 + DY3, { hw: 1.6 });
    const e4 = deck(e3.x1 + H4, e3.x1 + H4 + 8, d4.y + DY2 + DY3 + DY4, { hw: 1.6 });
    const top = slot(xa, xb, e4.x1, d4.y + 2);
    const d5 = deck(e4.x1, e4.x1 + 30, e4.y);
    r.push(R.run(d4.x1 - 6, 0));
    for (const e of [e1, e2, e3, e4]) r.push(R.jump({ edge: true, to: [e.x0 + 4, 0], air: [R.wallDodge('F', { at: 'wall' })], dj: 'apex' }));
    cp(d5, '3');
    // the slot: cross girders and lamps high above, a ring over every hop, piers under the little decks
    for (let x = xb + 6; x < e4.x1; x += 12) { girder(x, top + 0.5, 8, 0x6a7886); b.deco('beacon', { pos: [x, top + 1.4, 0], size: [0.3, 0.6, 0.3], color: RED }); }
    for (let x = xb + 4; x < e4.x1; x += 24) b.light([x, top - 1.5, 0], (x - xb) % 48 < 24 ? WHITE : YEL, 1.0, 24);
    [[d4, e1], [e1, e2], [e2, e3], [e3, e4]].forEach(([p, q]) => guide((p.x1 + q.x0) / 2, (p.y + q.y) / 2 + 3.6, 3.2, YEL));
    for (const e of [e1, e2, e3, e4]) { box(e.x0 - 0.1, e.y - 9, -1.6, e.x1 + 0.1, e.y - 1.2, 1.6, 'wall'); b.deco('beacon', { pos: [e.x0 + 4, e.y + 0.45, 0], size: [0.3, 0.5, 0.3], color: YEL }); }
    lamps(d5, 14);
    // the machinery gallery on the gorge side: penstock pipes and fans
    for (let k = 0; k < 6; k++) b.deco('pipe', { pos: [d4.x1 + 8 + k * 22, 3, 14 + (k % 2) * 3], size: [20, 1.6, 1.6], color: 0x6a7886 });
    for (let k = 0; k < 4; k++) b.deco('fan', { pos: [d4.x1 + 20 + k * 32, 5, 21], size: [9, 9, 1.4], yaw: 0 });
    d = d5;
  });

  // ================= 4: the intake canyon, two shield wall boosts =================
  section(() => {
    const d5 = d, CB = 1.2;
    const d6a = deck(d5.x1 + GB, d5.x1 + GB + 12, d5.y, { hw: 1.8 });
    const d6 = deck(d6a.x1 + GB2, d6a.x1 + GB2 + 34, d5.y + DYB2);
    const top = slot(d5.x0 + 4, d5.x0 + 13, d6.x0 + 10, d5.y, { cw: CB, mat: 'boostwall', fw: 6 });
    r.push(R.run(d5.x1 - 12, 0, { stop: true, tol: 0.4 }));
    r.push(R.charge(true, { to: 1 }));
    r.push(R.jump({ edge: true, to: [d6a.x0 + 6, 0], air: [R.wallBoost({ aimAt: [d5.x1 - 1, d5.y + 1.6, -CB], at: 0 })], dj: 'apex' }));
    r.push(R.charge(false));
    r.push(R.run(d6a.x0 + 3, 0, { stop: true, tol: 0.3 }));
    r.push(R.charge(true, { to: 1 }));
    r.push(R.jump({ edge: true, to: [d6.x0 + 6, 0], air: [R.wallBoost({ aimAt: [d6a.x1 - 1, d5.y + 1.6, -CB], at: 0 })], dj: 'apex' }));
    r.push(R.charge(false));
    cp(d6, '4');
    box(d6a.x0 + 0.1, d5.y - 9, -1.8, d6a.x1 - 0.1, d5.y - 1.2, 1.8, 'wall');
    for (const x of [d5.x1 + 4, d5.x1 + 10, d5.x1 + 16, d6a.x1 + 5, d6a.x1 + 11, d6a.x1 + 16]) girder(x, top + 0.5, 6, 0x60d0ff);
    for (const x of [d5.x1 + 2, d5.x1 + 12, d6a.x1 + 2, d6a.x1 + 12]) b.light([x, d5.y + 3, 0], 0x60d0ff, 1.0, 20);
    b.sign([d5.x0 + 2, d5.y + 2.4, 3.2], 270, { title: 'FALI LÖKÉS', keys: 'töltés · ugrás · lövés a falra', text: 'Töltsd fel a pajzsot, ugorj, és a levegőben lőj hátra a közeli falra.' });
    b.glyph([d5.x1 - 3, d5.y + 0.02, 0], 'shield', 270);
    lamps(d6, 16, BLUE);
    d = d6;
  });

  // ================= 5: the turbine well, five pistons =================
  section(() => {
    const d6 = d, y6 = d6.y, trav = [PH1, PH2, PH3, PH4, PH5], phs = [PP1, PP2, PP3, PP4, PP5];
    let px = d6.x1 + PG;
    const ks = trav.map((h, k) => {
      const k0 = px, id = 'K' + (k + 1);
      b.mover(id, { path: [[0, h, 0]], speed: PS, wait: PW, phase: phs[k] }, () => {
        b.box([k0, y6 - 1, -3.5], [k0 + 6, y6, 3.5], { mat: 'gate' });
        box(k0, y6 - 0.5, -3.65, k0 + 6, y6 - 0.3, 3.65, 'trim');
        b.deco('pillar', { pos: [k0 + 3, y6 - 13, 0], size: [1.2, 24, 1.2], color: 0x56626e });   // the piston rod
      });
      px += 6 + PG;
      return { id, x0: k0, x1: k0 + 6, h };
    });
    const topH = trav[trav.length - 1];
    const m0 = deck(px, px + 26, y6 + topH);
    // hop k -> k+1 when the target's predicted height at landing is within [LO, HI] of our height at take-off
    const hop = (from, to, toY, toId) => [
      R.run(from.x1 - 1.0, 0, { stop: true, tol: 0.3 }),
      R.until((w) => { const own = from.id ? y6 + moverY(w, from.id, TK) : y6; const tgt = toId ? y6 + moverY(w, toId, TK + TF) : toY; const dy = tgt - own; return dy >= LO && dy <= HI; }, { timeout: 40 }),
      R.jump({ edge: true, to: [to.x0 + 3, 0] }),
    ];
    r.push(...hop({ x1: d6.x1 }, ks[0], 0, 'K1'));
    for (let k = 1; k < ks.length; k++) r.push(...hop(ks[k - 1], ks[k], 0, ks[k].id));
    r.push(...hop(ks[ks.length - 1], m0, y6 + topH, null));
    cp(m0, '5');
    // the well: turbine rotors far below, penstock pipes beside it, amber light from the depth, gate frames overhead
    const wx0 = d6.x1 + 1, wx1 = m0.x0 - 1;
    ks.forEach((k, i) => {
      b.deco('fan', { pos: [k.x0 + 3, y6 - 9 - (i % 2) * 2, 0], size: [8.5, 8.5, 1.6], yaw: 90 });
      b.light([k.x0 + 3, y6 - 5.5, 0], 0xffa040, 0.9, 20);
    });
    for (let i = 0; i < 6; i++) b.deco('pipe', { pos: [(wx0 + wx1) / 2, y6 - 3.5 - (i % 3) * 1.5, (i % 2 ? 1 : -1) * (7 + (i % 3))], size: [wx1 - wx0, 0.9, 0.9], color: 0x6a7886 });
    for (let x = wx0 + 6; x < wx1; x += 13) { b.deco('arch', { pos: [x, y6 + 6.5 + PH4, 0], size: [14, 11, 0.5], color: YEL, yaw: 90 }); girder(x, y6 + 12 + PH4, 15); }
    lamps(m0, 14);
    b.sign([d6.x1 - 4, d6.y + 2.4, 3.6], 270, { title: 'DUGATTYÚK', keys: 'ugorj, ha a következő a szinted közelében van', text: 'Állj a szélre, és várd meg a megfelelő pillanatot.' });
    d = m0;
  });

  // ================= 6: the crane cages =================
  section(() => {
    const m0 = d, y5 = m0.y, c1x = m0.x1 + 1.5, CS = 6;
    const cageFrame = (x0, len) => {
      for (const z of [-3.5, 3.5]) for (const x of [x0 + 0.3, x0 + len - 0.3]) b.deco('pillar', { pos: [x, y5 + 3.2, z], size: [0.3, 6.4, 0.3], color: 0x56626e });
      box(x0 - 0.2, y5 + 6.2, -3.7, x0 + len + 0.2, y5 + 6.5, 3.7, 'steel');
      b.deco('cable', { pos: [x0 + len / 2, y5 + 6.5, 0], to: [x0 + len / 2, y5 + 15.5, 0], radius: 0.1 });
    };
    b.mover('C1', { path: [[PA, 0, 0]], speed: CSP, wait: CW, phase: PC1 }, () => {
      b.box([c1x, y5 - 0.6, -3.5], [c1x + CS, y5, 3.5], { mat: 'gate' });
      box(c1x, y5 - 0.4, -3.65, c1x + CS, y5 - 0.2, 3.65, 'trim');
      cageFrame(c1x, CS);
    });
    const m1 = deck(c1x + PA + CS + 1.5, c1x + PA + CS + 1.5 + 16, y5);
    const c2x = m1.x1 + 1.5;
    b.mover('C2', { path: [[PB, DYC, 0]], speed: CSP, wait: CW, phase: PC2 }, () => {
      b.box([c2x, y5 - 0.6, -3.5], [c2x + 8, y5, 3.5], { mat: 'gate' });
      box(c2x, y5 - 0.4, -3.65, c2x + 8, y5 - 0.2, 3.65, 'trim');
      cageFrame(c2x, 8);
    });
    const d9 = deck(c2x + 8 + PB + GC, c2x + 8 + PB + GC + 30, y5 + DYC);
    r.push(R.run(m0.x1 - 3, 0));
    r.push(R.waitMover('C1', { near: [0, 0, 0], tol: 0.05, within: 0.5 }));
    r.push(R.jump({ edge: true, to: [c1x + 3, 0] }));
    r.push(R.waitMover('C1', { near: [PA, 0, 0], tol: 0.05 }));
    r.push(R.jump({ edge: true, to: [m1.x0 + 4, 0] }));
    r.push(R.run(m1.x1 - 3, 0));
    r.push(R.waitMover('C2', { near: [0, 0, 0], tol: 0.05, within: 0.5 }));
    r.push(R.jump({ edge: true, to: [c2x + 3, 0] }));
    r.push(R.waitMover('C2', { near: [PB * WC, DYC * WC, 0], tol: 0.12 }));
    r.push(R.jump({ edge: true, to: [d9.x0 + 5, 0], dj: 'apex' }));
    cp(d9, '6');
    // the crane gantries: portal frames with a long rail beam, lamps, rings over the two cage flights
    for (const [gx, gy] of [[c1x - 2, y5], [c1x + PA + CS + 2, y5], [c2x - 2, y5], [c2x + 8 + PB + 3, y5 + DYC]]) {
      for (const z of [-8, 8]) b.deco('pillar', { pos: [gx, gy + 11, z], size: [1.0, 24, 1.0], color: 0x56626e });
      girder(gx, gy + 23.4, 17, 0xb4bec5);
    }
    b.deco('beam', { pos: [(c1x + c2x + 8 + PB) / 2, y5 + 24.6, 0], size: [c2x + 8 + PB - c1x + 12, 1.2, 0.9], color: 0xb4bec5 });
    for (const x of [c1x + PA / 2, c2x + PB / 2 + 2]) b.light([x, y5 + 12, 0], YEL, 1.0, 30);
    guide(c1x + CS + PA + 0.7, y5 + 3.2, 5, YEL); guide((c2x + 8 + PB + d9.x0) / 2, y5 + DYC + 3.6, 6, YEL);
    lamps(m1, 12, YEL); lamps(d9, 14);
    b.sign([m0.x1 - 5, m0.y + 2.4, 3.6], 270, { title: 'KOSARAK', keys: 'ugorj, amíg a kosár mozog', text: 'A kosár sebessége hozzáadódik az ugrásodhoz: a lendület viszi át a szakadékon.' });
    d = d9;
  });

  // ================= 7: the floodlight tower =================
  section(() => {
    const d9 = d, xt = d9.x1, y9 = d9.y;
    const yT1 = y9 + SH1, yT2 = yT1 + EH, yT3 = yT2 + SH3, yT4 = yT3 + SH4, yT5 = yT4 + SH5, yTop = yT5 + SH6;
    b.box([xt, -8, -TW], [xt + 18, yTop - 1.2, TW], { mat: 'tower' });
    const ledge = (z0, z1, y, depth = 6) => { b.box([xt - depth, y - 1.2, z0], [xt, y, z1], { mat: 'floor' }); box(xt - depth, y - 0.5, z0 - 0.1, xt, y - 0.3, z1 + 0.1, 'trim'); box(xt - 0.6, y + 0.004, z0, xt - 0.05, y + 0.03, z1, 'trim'); };
    ledge(2, 8, yT1); ledge(2, 8, yT2); ledge(-8, 0.5, yT3, 8); ledge(2, 8, yT4); ledge(-8, 0.5, yT5);
    b.mover('E1', { path: [[0, EH, 0]], speed: 2.5, wait: 1.5, phase: PE }, () => {
      b.box([xt - 6, yT1 - 0.6, -6.5], [xt - 0.3, yT1, -0.4], { mat: 'gate' });
      box(xt - 6, yT1 - 0.4, -6.65, xt - 0.3, yT1 - 0.2, -0.25, 'trim');
    });
    b.box([xt, yTop - 1.2, -TW], [xt + 18, yTop, TW], { mat: 'floor' });
    r.push(R.run(xt - 3, 1.0, { stop: true, tol: 0.3 }));
    r.push(R.shieldJump({ charge: 1, dj: 'apex', to: [xt - 3, 5] }));
    r.push(R.waitMover('E1', { near: [0, 0, 0], tol: 0.05, within: 0.5 }));
    r.push(R.jump({ edge: true, to: [xt - 3, -3] }));
    r.push(R.run(xt - 3, -3.5, { stop: true, tol: 0.3 }));
    r.push(R.waitMover('E1', { near: [0, EH, 0], tol: 0.05 }));
    r.push(R.jump({ edge: true, to: [xt - 3, 5] }));
    r.push(R.run(xt - 3, 3, { stop: true, tol: 0.3 }));
    r.push(R.shieldJump({ charge: 1, dj: 'apex', to: [xt - 3, -3] }));
    b.checkpoint([xt - 8, yT3, -8], [xt, yT3 + 14, 0.5], { spawn: [xt - 4, yT3, -3], yaw: 270, label: '7' });
    r.push(R.run(xt - 3, -0.3, { stop: true, tol: 0.3 }));
    r.push(R.shieldJump({ charge: 1, dj: 'apex', to: [xt - 3, 5] }));
    r.push(R.run(xt - 3, 2.8, { stop: true, tol: 0.3 }));
    r.push(R.shieldJump({ charge: 1, dj: 'apex', to: [xt - 3, -3] }));
    r.push(R.run(xt - 1.2, -3, { stop: true, tol: 0.3 }));
    r.push(R.shieldJump({ charge: 1, dj: 'apex', to: [xt + 3, -3] }));
    r.push(R.run(xt + 11, 0));
    b.finish([xt + 10, yTop, -8], [xt + 12, yTop + 10, 8]);

    // the tower: floodlit concrete, yellow bands, lit windows, a mast with giant floodlight arrays and the light column
    for (let y = y9 + 4; y < yTop - 3; y += 4.6) {
      box(xt - 0.2, y, -TW - 0.2, xt + 18.2, y + 0.5, TW + 0.2, 'steel'); box(xt - 0.22, y + 0.5, -TW - 0.22, xt + 18.22, y + 0.6, TW + 0.22, 'trim');
      for (let z = -TW + 2; z < TW - 1; z += 3.2) { box(xt - 0.1, y + 1.4, z, xt, y + 3.2, z + 1.4, 'glow'); box(xt + 18, y + 1.4, z, xt + 18.1, y + 3.2, z + 1.4, 'glow'); }
      for (const z of [-TW - 0.3, TW + 0.3]) box(xt + 1, y + 1.4, z - 0.1, xt + 17, y + 2.2, z + 0.1, 'glow');
    }
    b.deco('pillar', { pos: [xt + 9, yTop + 12, 0], size: [1.4, 24, 1.4], color: 0x8a96a2 });
    for (const h of [8, 15, 22]) for (const s of [-1, 1]) {
      box(xt + 8, yTop + h - 1.3, s * 5 - 3, xt + 8.5, yTop + h + 1.3, s * 5 + 3, 'steel');
      box(xt + 7.8, yTop + h - 1.1, s * 5 - 2.8, xt + 8, yTop + h + 1.1, s * 5 + 2.8, 'glow');
    }
    b.deco('beacon', { pos: [xt + 9, yTop + 26, 0], size: [0.8, 3, 0.8], color: RED });
    // the landmark, visible from the start over the gate frames: a column of light and two huge rings in the storm
    b.deco('beacon', { pos: [xt + 9, yTop + 130, 0], size: [6, 260, 6], color: WHITE });
    b.deco('ring', { pos: [xt + 9, yTop + 95, 0], size: [70, 70, 3], color: WHITE, yaw: 90 });
    b.deco('ring', { pos: [xt + 9, yTop + 95, 0], size: [46, 46, 2], color: YEL, yaw: 90 });
    for (const z of [-TW + 1, TW - 1]) for (const x of [xt + 1, xt + 17]) { b.deco('pillar', { pos: [x, yTop + 3, z], size: [0.5, 6, 0.5], color: 0x56626e }); b.deco('beacon', { pos: [x, yTop + 6.4, z], size: [0.5, 1.2, 0.5], color: RED }); }
    b.deco('ring', { pos: [xt + 13.5, yTop + 5, 0], size: [17, 17, 0.8], color: YEL, yaw: 90 });
    b.sign([xt + 5, yTop + 2.4, 0], 270, { title: 'GRATULÁLUNK!', keys: 'CÉL', text: 'Átjutottál a gáton. Fuss át a kapun!' });
    b.light([xt + 4, yTop + 6, 0], WHITE, 1.4, 40); b.light([xt + 14, yTop + 6, 0], YEL, 1.2, 36);
    b.light([xt - 4, y9 + 6, 0], WHITE, 1.3, 36);
    for (const y of [yT1, yT2, yT3, yT4, yT5]) b.light([xt - 3, y + 3, 0], WHITE, 1.0, 22);
    for (let x = xt - 26; x < xt - 2; x += 12) { lamp(x, y9, 6.4, WHITE, false); lamp(x, y9, -6.4, WHITE, false); }
    d = { x1: xt + 18, y: yTop, hw: 12 };
  });

  for (const s of sections) s();

  // ================= the scenery: the dam, the reservoir, the gorge, the mountains =================
  const X0 = -180, X1 = 780;
  box(X0, -80, -26, X1, LETHAL - 0.02, 28, 'damtop');   // the dam top: the lethal floor
  for (const z of [-24.6, 26.6]) box(X0, LETHAL - 0.02, z - 0.35, X1, LETHAL, z + 0.35, 'trim');
  for (let x = X0 + 4; x < X1; x += 12) box(x, LETHAL - 0.02, -0.15, x + 5, LETHAL, 0.15, 'trim');
  for (let x = X0 + 10; x < X1; x += 24) box(x, LETHAL - 0.02, -24, x + 2.4, LETHAL + 0.01, 26, 'gate');
  for (let i = 0; i < 8; i++) box(X0, -150, 28 + i * 16, X1, LETHAL - 10 * (i + 1), 44 + i * 16, 'wall');   // the stepped downstream face
  box(-420, -170, 156, 1100, -92, 700, 'water');                                                            // the river in the gorge
  box(-420, -60, -900, 1100, LETHAL - 0.1, -26, 'water');                                                   // the reservoir
  box(X0, LETHAL - 0.12, -27, X1, LETHAL - 0.08, -26, 'glow');                                              // the foam line along the dam
  // the far mountains and cliffs
  const peak = (cx, cz, rad, h) => {
    const pts = [];
    for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2 + rnd() * 0.3, rr = rad * (0.8 + rnd() * 0.4); pts.push([cx + Math.cos(a) * rr, -40, cz + Math.sin(a) * rr]); }
    for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2 + rnd(), rr = rad * (0.15 + rnd() * 0.3); pts.push([cx + Math.cos(a) * rr, h * (0.78 + rnd() * 0.22), cz + Math.sin(a) * rr]); }
    b.decoBrush('hull', pts, { mat: 'rock' });
  };
  for (let i = 0; i < 14; i++) peak(-250 + i * 85, -520 - rnd() * 160, 120 + rnd() * 90, 70 + rnd() * 110);   // the far shore
  for (let i = 0; i < 12; i++) peak(-200 + i * 95, 330 + rnd() * 120, 110 + rnd() * 80, 90 + rnd() * 120);   // the gorge cliffs
  for (let i = 0; i < 5; i++) { peak(900 + rnd() * 120, -300 + i * 150, 140, 100 + rnd() * 80); peak(-400 - rnd() * 100, -300 + i * 150, 140, 90 + rnd() * 80); }

  b.route(parts.flat());
  b.skip('pajzsugrás a felvonó helyett', parts.map((p, i) => (i === 1 ? skipSteps : p)).flat());
});
