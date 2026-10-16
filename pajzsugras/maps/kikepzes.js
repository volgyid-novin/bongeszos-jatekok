// KIKÉPZÉS: the training course. One station per technique, in the order of the ladder: run jump, double jump, dodge,
// dodge jump, wall dodge, tap shield jump, full shield jump, shield jump + double jump, shield wall boost, lift jump,
// jump pads, strafe jump, bunnyhop. Every station has a hologram sign with its keys, glyphs on the floor, generous gaps
// (60-75 % of what the technique reaches, see the probe table) and a checkpoint on the far side.
//
// Layout: a chain of frames. `cur` is the frame at the far edge of the last element, heading local -z. build(len)
// makes a floor platform and moves on, pit(len, dy) only moves on, turnLeft(len) turns the course on a platform.
// An element's geometry is made inside b.group() of its frame, and the route reads the same frames (XZ / P), so the
// proof route follows any edit of the lengths automatically.
import { defineMap } from '../sim/builder.js';
import { R } from '../sim/bot.js';
import { rotY, mulberry32 } from '../sim/math.js';

const TEAL = 0x1fb8b0, GLOW = 0x30e8d8, ORANGE = 0xff8a2a;
// gaps (m) and ledge heights (m)
const GAP = { jump: 3.5, dj: 8.2, dodge: 5.0, dodgeJump: 12.6, chute: 13.5, boost: 17, lift: 6.3, stone: 4.4 };
const UP = { tap: 1.6, full: 5.0, fullDj: 6.8, lift: 6, roof: 2.35 };

export default defineMap({
  id: 'kikepzes', name: 'KIKÉPZÉS', diff: 'kikepzes', order: 1, authorTime: 91.075,
  blurb: 'Egy-egy állomás minden technikához: ugrás, dupla ugrás, kiugrás, falról kiugrás, pajzsugrás, felvonó, párnák, strafe és bunnyhop.',
  theme: {
    sky: { type: 'clouds', top: 0x5aa0e8, horizon: 0xeaf6ff, bottom: 0xb8d8f0, sunDir: [0.45, 0.8, -0.35], sunColor: 0xfff3dc, clouds: 0.35 },
    fog: { color: 0xdcecf8, near: 120, far: 620 },
    hemi: { sky: 0xdff0ff, ground: 0x9bb2c4, intensity: 1.0 }, sun: { color: 0xfff0d8, intensity: 1.9 },
    palette: { floor: 0xe6eef2, wall: 0xb4c8d2, trim: ORANGE, accent: TEAL, glow: GLOW, danger: 0xff5a3a },
    bloom: 0.45, ambient: 'facility',
  },
}, (b) => {
  const W = 14, HW = W / 2;
  b.mat('floor', { base: 'panel', color: 0xe6eef2, trim: TEAL });
  b.mat('wall', { base: 'panel', color: 0xb4c8d2, trim: ORANGE });
  b.mat('walldodge', { base: 'stripe', color: 0xf4f8fa, trim: ORANGE, emissive: 0x301400 });
  b.mat('boostwall', { base: 'panel', color: 0x2a5a66, trim: GLOW, emissive: GLOW });
  b.mat('gate', { base: 'hazard', color: 0xffc400, trim: 0x202830 });
  b.mat('lift', { base: 'metal', color: 0xc8d2d8, trim: ORANGE });
  b.mat('trim', { base: 'neon', color: ORANGE, emissive: ORANGE });
  b.mat('glow', { base: 'neon', color: GLOW, emissive: GLOW });
  b.mat('ground', { base: 'panel', color: 0xcfe0e8, trim: TEAL });
  b.mat('tower', { base: 'concrete', color: 0xdfe8ec, trim: TEAL });

  // ---------- frames ----------
  const frame = (at, yaw) => ({ at, yaw, p: (x, y, z) => { const q = rotY([x, y, z], yaw); return [q[0] + at[0], q[1] + at[1], q[2] + at[2]]; } });
  const XZ = (f, x, z) => { const q = f.p(x, 0, z); return [q[0], q[2]]; };
  const inF = (f, fn) => b.group({ at: f.at, yaw: f.yaw }, fn);
  let cur = frame([0, 0, 0], 0);
  const pit = (len, dy = 0) => { cur = frame(cur.p(0, dy, -len), cur.yaw); };
  const turnLeft = (len) => { cur = frame(cur.p(-HW, 0, len / 2), cur.yaw + 90); };   // cur sits at the far end of a len-long platform
  const gapLabel = (len) => inF(cur, () => b.marker([0, 1.3, -len / 2], 'rés ' + len.toFixed(1).replace('.', ',') + ' m'));   // call before pit(len)
  const GROUND = -26;   // top of the decorative ground far below

  // floor platform in frame f (a 1 m slab, top at local y 0), edge light strips, a support column, a kill slab 12 m under it
  const platform = (f, len, o = {}) => {
    const w = o.w ?? W, base = -1;
    inF(f, () => {
      b.box([-w / 2, base, -len], [w / 2, 0, 0], { mat: o.mat || 'floor' });
      for (const s of [-1, 1]) b.decoBrush('box', [s * (w / 2 - 0.3) - 0.07, 0.004, -len + 0.5], [s * (w / 2 - 0.3) + 0.07, 0.03, -0.5], { mat: 'trim' });
      b.decoBrush('box', [-w / 2, -0.06, -len], [w / 2, 0, -len + 0.15], { mat: 'trim' });   // the far edge glows (a warning line)
      if (!o.nocolumn) {
        const h = f.at[1] - GROUND - 1;
        b.deco('pillar', { pos: [0, base - h / 2 + 0.05, -len / 2], size: [Math.min(3, w / 3), h, Math.min(3, w / 3)], color: 0xdfe8ec });
      }
      b.kill([-30, -14, 6], [30, -12, -len - 6], 'void');
    });
  };
  const build = (len, o) => { const f = cur; platform(f, len, o); pit(len); return f; };
  // a block from the base up to dy (a ledge): the next frame is at its far end, on top
  const ledge = (len, dy) => {
    const f = cur;
    inF(f, () => {
      b.box([-HW, -1 - f.at[1], -len], [HW, dy, 0], { mat: 'floor' });
      for (const s of [-1, 1]) b.decoBrush('box', [s * (HW - 0.3) - 0.07, dy + 0.004, -len + 0.5], [s * (HW - 0.3) + 0.07, dy + 0.03, -0.5], { mat: 'trim' });
      b.decoBrush('box', [-HW, dy - 0.12, -0.05], [HW, dy, 0.1], { mat: 'trim' });   // glowing lip of the ledge face
      const h = f.at[1] - GROUND - 1;
      b.deco('pillar', { pos: [0, -1 - f.at[1] - h / 2 + 0.05, -len / 2], size: [3, h, 3], color: 0xdfe8ec });
      b.kill([-30, -14 - f.at[1], 6], [30, -12 - f.at[1], -len - 6], 'void');
    });
    cur = frame(f.p(0, dy, -len), f.yaw);
    return frame(f.p(0, dy, 0), f.yaw);   // the ledge top, at its near edge
  };
  const pillar = (x, z, h = 6) => { b.deco('pillar', { pos: [x, h / 2, z], size: [0.9, h, 0.9] }); b.deco('beacon', { pos: [x, h + 0.7, z], size: [0.6, 1.4, 0.6], color: GLOW }); };
  const pillars = (z, h = 5, x = HW - 0.5) => { pillar(-x, z, h); pillar(x, z, h); };
  const sign = (x, z, title, keys, text, y = 2.5) => b.sign([x, y, z], 0, { title, keys, text });
  const arrows = (zs, x = 0) => zs.forEach((z) => b.glyph([x, 0.02, z], 'arrow', 0));
  // a checkpoint across the near end of a platform (tall and deep: it cannot be flown over)
  const cp = (label, z0 = -0.5, z1 = -10, w = HW - 0.5) => b.checkpoint([-w, 0, z0], [w, 12, z1], { spawn: [0, 0, -3], yaw: 0, label });
  const ring = (x, y, z, d = 8, color = GLOW) => b.deco('ring', { pos: [x, y, z], size: [d, d, 0.4], color });
  const arch = (z, h = 7, color = ORANGE, w = W + 1) => b.deco('arch', { pos: [0, h / 2, z], size: [w, h, 0.7], color });

  const route = [];

  // ================= S0: start hall =================
  const HALL = 48;
  const f0 = build(HALL);
  inF(f0, () => {
    b.start([0, 0, -4], 0);
    for (const s of [-1, 1]) {
      b.box([s > 0 ? HW - 0.4 : -HW, 0, -HALL], [s > 0 ? HW : -HW + 0.4, 1.1, 0], { mat: 'wall' });
      b.decoBrush('box', [s > 0 ? HW - 0.45 : -HW - 0.05, 1.1, -HALL], [s > 0 ? HW + 0.05 : -HW + 0.45, 1.18, 0], { mat: 'trim' });
    }
    for (const z of [-1, -14, -27, -39]) pillars(z, 7, HW + 0.6);
    arch(-1.5, 8); b.deco('screen', { pos: [0, 6.6, -2.1], size: [7, 1.5, 0.2], color: TEAL });
    arch(-39, 7, TEAL);
    for (const z of [-12, -21, -30]) ring(0, 3.6, z, 9);
    for (let i = 0; i < 6; i++) b.deco('beam', { pos: [0, 7.6, -4 - i * 7], size: [W + 2, 0.35, 0.5], color: 0xdde8ee });
    arrows([-9, -16, -24, -32]);
    sign(-3.8, -11, 'ÜDV A KIKÉPZÉSEN', 'W A S D · egér', 'Nézz körül, majd menj előre a nyilak mentén. Minden állomás egy technikát tanít.');
    sign(3.8, -19, 'ELLENŐRZŐPONT', 'R · ENTER', 'R: vissza az utolsó ellenőrzőpontra. Enter: újrakezdés. Ha leesel, azonnal visszatérsz.');
    sign(-3.8, -30, 'UGRÁS', 'SPACE', 'Fuss neki a peremnek, és ugorj át a résen. A másik oldalon ellenőrzőpont vár.');
    b.light([0, 5, -8], 0xffffff, 1, 20); b.light([0, 5, -26], 0xffffff, 1, 20);
  });
  inF(f0, () => ring(0, 3.2, -HALL - GAP.jump / 2, 6));

  // ================= S1: run jump =================
  gapLabel(GAP.jump); pit(GAP.jump);
  const E = 24;
  const f1 = build(E);
  inF(f1, () => {
    cp('1 · UGRÁS');
    arrows([-5, -12]); pillars(-1);
    sign(-3.8, -9, 'DUPLA UGRÁS', 'SPACE · a levegőben újra SPACE', 'A csúcson a leghatásosabb. Egy ugrásonként egyszer használhatod, földetéréskor újra megvan.');
    b.glyph([0, 0.02, -E + 2.6], 'dj', 0);
    ring(0, 3.6, -E - GAP.dj / 2, 7);
  });
  route.push(R.jump({ edge: true, to: XZ(f1, 0, -8) }));

  // ================= S2: double jump =================
  gapLabel(GAP.dj); pit(GAP.dj);
  const f2 = build(E);
  inF(f2, () => {
    cp('2 · DUPLA UGRÁS');
    arrows([-5, -12]); pillars(-1);
    sign(-3.8, -9, 'KIUGRÁS', '2× koppintás egy irányra', 'Gyors, alacsony ugrás előre, oldalra vagy hátra. Az alacsony kapu alatt csak így jutsz át.');
    // the low gate: a roof 2.35 m over the gap (and 1 m over each edge), the sides closed
    const z0 = -(E - 1), z1 = -(E + GAP.dodge + 1);
    b.box([-HW - 0.6, UP.roof, z0], [HW + 0.6, UP.roof + 1.25, z1], { mat: 'gate' });
    for (const s of [-1, 1]) b.box([s > 0 ? HW : -HW - 0.6, -9, z0], [s > 0 ? HW + 0.6 : -HW, 3.6, z1], { mat: 'wall' });
    b.deco('beam', { pos: [0, UP.roof - 0.07, z0 + 0.1], size: [W, 0.1, 0.1], color: ORANGE });
    b.light([0, 1.9, (z0 + z1) / 2], 0xffc060, 1, 12);
    b.glyph([0, 0.02, -E + 3.6], 'arrow', 0);
  });
  route.push(R.jump({ edge: true, to: XZ(f2, 0, -9), dj: 'apex' }));

  // ================= S3: dodge under the low gate =================
  gapLabel(GAP.dodge); pit(GAP.dodge);
  const f3 = build(E);
  inF(f3, () => {
    cp('3 · KIUGRÁS');
    arrows([-5, -12]); pillars(-1);
    sign(-3.8, -9, 'KIUGRÓ UGRÁS', 'kiugrás, majd a levegőben SPACE', 'Kiugrás után még megvan a dupla ugrás: így jutsz a legmesszebbre.');
    ring(0, 3.6, -E - GAP.dodgeJump * 0.3, 7); ring(0, 4.4, -E - GAP.dodgeJump * 0.7, 7);
  });
  route.push(R.dodge('F', { edge: true, to: XZ(f3, 0, -9) }));

  // ================= S4: dodge jump =================
  gapLabel(GAP.dodgeJump); pit(GAP.dodgeJump);
  const PLAZA = 24;
  const f4 = build(PLAZA);   // the course turns left in the middle of this plaza
  inF(f4, () => {
    cp('4 · KIUGRÓ UGRÁS');
    pillars(-1); pillars(-PLAZA + 1);
    arch(-PLAZA / 2, 8, TEAL, W + 1);
    for (const z of [-5, -10]) arrows([z]);
    for (let i = 1; i <= 4; i++) b.glyph([-i * 2.4 - 1.5, 0.02, -PLAZA / 2], 'arrow', 90);
    b.light([0, 5, -PLAZA / 2], 0xffffff, 1, 20);
  });
  route.push(R.dodgeJump('F', { edge: true, to: XZ(f4, 0, -8) }));
  route.push(R.run(...XZ(f4, -2, -PLAZA / 2), { tol: 1.0 }));
  turnLeft(PLAZA);

  // ----- chute (S5 striped walls, S9 shield walls): two walls 1.7 m apart over the gap, a funnel at the entrance -----
  const chute = (f, len, gap, mat, tail = 9) => {
    const zEnd = -(len + gap + tail);
    inF(f, () => {
      for (const s of [-1, 1]) {
        const pts = [];
        for (const y of [-9, 6]) for (const q of [[s * HW, -(len - 15)], [s * 0.85, -(len - 8)], [s * 0.85, zEnd], [s * HW, zEnd]]) pts.push([q[0], y, q[1]]);
        b.hull(pts, { mat });
      }
      b.deco('beam', { pos: [0, 6.2, -(len - 8)], size: [1.9, 0.3, 0.3], color: mat === 'boostwall' ? GLOW : ORANGE });
    });
  };

  // ================= S5: wall dodge in a chute =================
  const CH = 28, LAND = 30;
  const f5 = build(CH);
  gapLabel(GAP.chute); pit(GAP.chute);
  const f5b = build(LAND);
  chute(f5, CH, GAP.chute, 'walldodge');
  inF(f5, () => {
    arrows([-5, -10]); pillars(-1);
    b.glyph([0, 0.02, -17], 'walldodge', 0);
    sign(-3.8, -4, 'FALRÓL KIUGRÁS', 'a levegőben 2× előre, a csíkos fal mellett', 'Ugorj a keskeny folyosóban, és a levegőben kiugorj előre a fal mentén. Utána még jár a dupla ugrás.');
  });
  inF(f5b, () => {
    cp('5 · FALRÓL KIUGRÁS', -10, -20);
    arrows([-14, -18]);
    sign(-3.8, -22, 'PAJZSUGRÁS', 'nézz lefelé · bal gomb + SPACE', 'Nézz a padlóra, és nyomd le egyszerre a bal gombot és a SPACE-t. Rövid kattintás = kis lökés.');
    b.glyph([0, 0.02, -LAND + 5.5], 'shield', 0);
    pillars(-LAND + 1);
  });
  route.push(R.run(...XZ(f5, 0, -9), { tol: 1.0 }));
  route.push(R.jump({ edge: true, to: XZ(f5b, 0, -12), air: [R.wallDodge('F', { at: 'wall' })], dj: 'apex' }));

  // ================= S6: tap shield jump =================
  const LEDGE = 28;
  const L1 = ledge(LEDGE, UP.tap);
  inF(L1, () => {
    cp('6 · PAJZSUGRÁS');
    arrows([-5, -12]); pillars(-1);
    sign(-3.8, -9, 'TÖLTÖTT PAJZS', 'tartsd a bal gombot · SPACE + engedd el', 'Minél tovább töltesz (kb. 1,2 mp), annál nagyobbat lök. Nézz lefelé a padlóra.');
    b.glyph([0, 0.02, -LEDGE + 0.9], 'shield', 0);
  });
  route.push(R.run(...XZ(f5b, 0, -LAND + 4.5), { tol: 0.5 }));
  route.push(R.shieldJump({ charge: 0, run: XZ(L1, 0, -10), to: XZ(L1, 0, -8) }));

  // ================= S7: full-charge shield jump =================
  const L2 = ledge(LEDGE, UP.full);
  inF(L2, () => {
    cp('7 · TÖLTÖTT PAJZS');
    arrows([-5, -12]); pillars(-1);
    sign(-3.8, -9, 'PAJZS + DUPLA UGRÁS', 'töltött pajzsugrás, a csúcson SPACE', 'A legmagasabb ugrás: a pajzsugrás csúcsán még egy dupla ugrás.');
    b.glyph([0, 0.02, -LEDGE + 0.9], 'shield', 0);
  });
  route.push(R.run(...XZ(L1, 0, -LEDGE + 0.6), { stop: true, tol: 0.25 }));
  route.push(R.shieldJump({ charge: 1, to: XZ(L2, 0, -8) }));

  // ================= S8: shield jump + double jump =================
  const L3 = ledge(PLAZA, UP.fullDj);
  inF(L3, () => {
    cp('8 · PAJZS + DUPLA UGRÁS');
    pillars(-1); pillars(-PLAZA + 1, 6);
    arch(-PLAZA / 2, 8, TEAL);
    for (let i = 1; i <= 4; i++) b.glyph([-i * 2.4 - 1.5, 0.02, -PLAZA / 2], 'arrow', 90);
    b.light([0, 5, -PLAZA / 2], 0xffffff, 1, 20);
  });
  route.push(R.run(...XZ(L2, 0, -LEDGE + 0.6), { stop: true, tol: 0.25 }));
  route.push(R.shieldJump({ charge: 1, dj: 'apex', to: XZ(L3, 0, -8) }));
  route.push(R.run(...XZ(L3, -2, -PLAZA / 2), { tol: 1.0 }));
  turnLeft(PLAZA);

  // ================= S9: shield wall boost in a chute =================
  const f9 = build(CH);
  gapLabel(GAP.boost); pit(GAP.boost);
  const f9b = build(LAND);
  chute(f9, CH, GAP.boost, 'boostwall');
  inF(f9, () => {
    arrows([-5, -10]); pillars(-1);
    b.glyph([0, 0.02, -17], 'shield', 0);
    sign(-3.8, -4, 'FALI LÖKÉS', 'a levegőben: töltött pajzs a falra', 'Töltsd fel a pajzsot, ugorj, és a levegőben lőj hátra a közeli falra: a lökés előre visz.');
  });
  inF(f9b, () => {
    cp('9 · FALI LÖKÉS', -10, -20);
    arrows([-14, -18]);
    sign(-3.8, -22, 'FELVONÓS UGRÁS', 'ugorj a felvonóról, amíg emelkedik', 'A mozgó felvonó sebessége hozzáadódik az ugrásodhoz: így messzebbre jutsz.');
    pillars(-LAND + 1);
  });
  route.push(R.run(...XZ(f9, 0, -9), { stop: true, tol: 0.4 }));
  route.push(R.charge(true, { to: 1 }));
  route.push(R.jump({ edge: true, to: XZ(f9b, 0, -12), air: [R.wallBoost({ aimAt: f9.p(-0.85, 1.6, -CH + 1), at: 0 })], dj: 'apex' }));
  route.push(R.charge(false));

  // ================= S10: lift jump =================
  const f10 = cur;   // the lift stands at the far end of f9b
  pit(5 + GAP.lift, UP.lift);
  const fH = build(E);
  inF(f10, () => {
    b.mover('lift', { path: [[0, UP.lift, 0]], speed: 3, wait: 0.8 }, () => {
      b.box([-2.5, -0.5, -5], [2.5, 0, 0], { mat: 'lift' });
      b.decoBrush('box', [-2.5, -0.1, -5], [2.5, 0, -4.8], { mat: 'trim' });
      b.decoBrush('box', [-2.5, -0.1, -0.2], [2.5, 0, 0], { mat: 'trim' });
    });
    for (const s of [-1, 1]) for (const z of [-0.3, -4.7]) b.deco('pillar', { pos: [s * 3.1, UP.lift / 2 + 1, z], size: [0.35, UP.lift + 4, 0.35] });
    for (const z of [-0.3, -4.7]) b.deco('beam', { pos: [0, UP.lift + 3.2, z], size: [6.6, 0.3, 0.3], color: ORANGE });
    b.glyph([0, 0.02, 3], 'arrow', 0);
    b.light([0, 4, -2.5], 0xffd9a0, 1, 14);
  });
  inF(fH, () => {
    cp('10 · FELVONÓS UGRÁS');
    arrows([-4]); pillars(-1);
    sign(-3.8, -9, 'UGRÓPÁRNÁK', 'lépj rá a párnára', 'A párna a célig repít, közben a levegőben irányíthatod magad. A következő párna a leszállóhelyen vár.');
  });
  route.push(R.run(...XZ(f10, 0, 1.2), { stop: true, tol: 0.4 }));
  route.push(R.waitMover('lift', { near: [0, 0, 0], tol: 0.05, within: 0.3 }));
  route.push(R.run(...XZ(f10, 0, -1.2), { tol: 0.4 }));
  route.push(R.waitMover('lift', { near: [0, 3.3, 0], tol: 0.12 }));
  route.push(R.jump({ edge: true, to: XZ(fH, 0, -9) }));

  // ================= S11: jump pads =================
  // a pad throws to its target (feet) on a parabola; three rings mark the arc
  const padHop = (f, padZ, tf, tz, apexAbove = 5) => {
    const p0 = f.p(0, 0, padZ), p1 = tf.p(0, 0, tz);
    const apex = Math.max(p0[1], p1[1]) + apexAbove;
    b.pad(p0, { target: p1, apex });   // world coordinates (no group here)
    const g = 19, vy = Math.sqrt(2 * g * (apex - p0[1])), T = vy / g + Math.sqrt((2 * (apex - p1[1])) / g);
    const dist = Math.hypot(p1[0] - p0[0], p1[2] - p0[2]);
    inF(f, () => {
      b.deco('ring', { pos: [0, 0.3, padZ], size: [2.6, 2.6, 0.3], color: GLOW });
      for (const t of [0.3, 0.5, 0.7]) ring(0, vy * T * t - 0.5 * g * (T * t) * (T * t) + 1.0, padZ - dist * t, 5);
    });
  };
  inF(fH, () => b.glyph([0, 0.02, -E + 7], 'arrow', 0));
  const PAD1 = -(E - 4);
  pit(16, -3);
  const T1 = build(12, { w: 10 });
  padHop(fH, PAD1, T1, -6);
  pit(21, 7);
  const T2 = build(12, { w: 10 });
  padHop(T1, -10, T2, -6);
  pit(23, -5);
  const T3 = build(PLAZA);
  padHop(T2, -10, T3, -8);
  inF(T3, () => {
    cp('11 · UGRÓPÁRNÁK');
    pillars(-1); pillars(-PLAZA + 1);
    arch(-PLAZA / 2, 8, ORANGE);
    for (let i = 1; i <= 4; i++) b.glyph([-i * 2.4 - 1.5, 0.02, -PLAZA / 2], 'arrow', 90);
    sign(-3.8, -4, 'STRAFE UGRÁS', 'SPACE tartva · W + A / D váltva · egér', 'Tartsd a SPACE-t, és váltogasd az A és D gombot, miközben az egeret mindig a kanyar felé húzod: így gyorsulsz.');
  });
  route.push(R.run(...XZ(fH, 0, PAD1), { tol: 0.4 }));
  route.push(R.glide({ to: XZ(T1, 0, -6) }));
  route.push(R.run(...XZ(T1, 0, -10), { tol: 0.4 }));
  route.push(R.glide({ to: XZ(T2, 0, -6) }));
  route.push(R.run(...XZ(T2, 0, -10), { tol: 0.4 }));
  route.push(R.glide({ to: XZ(T3, 0, -8) }));
  route.push(R.run(...XZ(T3, -2, -PLAZA / 2), { tol: 1.0 }));
  turnLeft(PLAZA);

  // ================= S12: strafe corridor =================
  const LEN12 = 200;
  const f12 = build(LEN12, { w: 10, nocolumn: true });
  inF(f12, () => {
    for (const s of [-1, 1]) {
      b.box([s > 0 ? 5 : -5.4, 0, -LEN12], [s > 0 ? 5.4 : -5, 1.2, 0], { mat: 'wall' });
      b.decoBrush('box', [s > 0 ? 4.95 : -5.45, 1.2, -LEN12], [s > 0 ? 5.45 : -4.95, 1.28, 0], { mat: 'trim' });
    }
    for (let i = 1; i <= LEN12 / 10 - 1; i++) {
      b.decoBrush('box', [-5, 0.004, -i * 10 - 0.08], [5, 0.03, -i * 10 + 0.08], { mat: i % 5 === 0 ? 'trim' : 'glow' });
      b.marker([-4.4, 1.5, -i * 10], i * 10 + ' m');
      if (i % 4 === 0) b.deco('arch', { pos: [0, 2.8, -i * 10], size: [11, 5.6, 0.5], color: i % 8 === 0 ? ORANGE : TEAL });
    }
    for (let i = 0; i < 8; i++) b.deco('beam', { pos: [0, 5.4, -6 - i * 22], size: [11, 0.3, 0.4], color: 0xdde8ee });
    const hc = f12.at[1] - GROUND - 1;
    for (let i = 0; i < 6; i++) b.deco('pillar', { pos: [0, -1 - hc / 2 + 0.05, -14 - i * 30], size: [2.4, hc, 2.4], color: 0xdfe8ec });
    arrows([-6, -14, -22], 0);
    for (let z = -20; z > -LEN12; z -= 30) for (const s of [-1, 1]) pillar(s * 5.9, z, 4);
  });
  const f12end = build(22, { w: 10 });
  inF(f12end, () => {
    cp('12 · STRAFE UGRÁS', -0.5, -10, 4.5);
    pillars(-1, 5, 5.6); pillars(-21, 5, 5.6);
    sign(-3.4, -8, 'BUNNYHOP', 'SPACE nyomva tartva', 'Ha a földetéréskor azonnal újra ugrasz, nem veszítesz sebességet. Ugorj végig a köveken!');
    b.glyph([0, 0.02, -19.5], 'arrow', 0);
  });
  route.push(R.run(...XZ(f12, 0, -3), { tol: 0.8 }));
  route.push(R.strafe({ hops: 40, to: XZ(f12, 0, -LEN12 + 6), tol: 4 }));
  route.push(R.run(...XZ(f12end, 0, -8), { tol: 1.0 }));

  // ================= S13: stepping stones (bunnyhop) and the finish =================
  const dxs = [0, 2, -2, 2, -2, 2, -2, 2, -2, 2, -2, 0], STONE = 3.2;
  const stones = [];
  dxs.forEach((dx, i) => {
    pit(GAP.stone, -0.4);
    cur = frame(cur.p(dx - (i ? dxs[i - 1] : 0), 0, 0), cur.yaw);
    stones.push(build(STONE, { w: 5, nocolumn: i % 3 !== 1 }));
  });
  pit(GAP.stone, -0.4);
  const FIN = 30;
  const fin = build(FIN);
  stones.forEach((f, i) => inF(f, () => { pillar(i % 2 ? -2.9 : 2.9, -1.2, 3); if (i % 3 === 0) ring(0, 2.8, -STONE / 2 - GAP.stone / 2 - 1.6, 5); }));
  inF(fin, () => {
    cp('13 · BUNNYHOP', -0.5, -9);
    arrows([-6, -10]);
    for (const z of [-2, -12, -28]) pillars(z, 7);
    arch(-18, 10, ORANGE); ring(0, 5, -18.8, 11);
    b.deco('screen', { pos: [0, 9.4, -18.3], size: [8, 1.8, 0.2], color: TEAL });
    sign(0, -11, 'KÉSZ A KIKÉPZÉS!', 'gratulálunk', 'Most jöhetnek a valódi pályák. Sok sikert!', 3);
    b.finish([-HW + 1, 0, -19.5], [HW - 1, 6, -24]);
    b.light([0, 6, -12], 0xffffff, 1.2, 22);
    b.light([0, 6, -24], 0xffe0b0, 1.2, 22);
  });
  route.push(R.jump({ edge: true, to: XZ(stones[0], 0, -STONE / 2) }));
  stones.forEach((f, i) => route.push(R.jump({ edge: true, to: i + 1 < stones.length ? XZ(stones[i + 1], 0, -STONE / 2) : XZ(fin, 0, -4) })));
  route.push(R.run(...XZ(fin, 0, -22), { tol: 1.0 }));

  // ================= scenery =================
  // the ground far below, a central tower as a landmark and a ring of pylons
  b.decoBrush('block', [-5, GROUND - 2, -10], [900, 4, 900], { mat: 'ground' });
  b.deco('pillar', { pos: [-75, 28, -45], size: [10, 112, 10], color: 0xdfe8ec });
  for (const y of [14, 34, 54]) b.deco('ring', { pos: [-75, y, -45], size: [24, 24, 1.2], color: y === 34 ? ORANGE : GLOW });
  b.deco('beacon', { pos: [-75, 90, -45], size: [4, 14, 4], color: GLOW });
  const rnd = mulberry32(2024);
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2 + rnd() * 0.3, r = 230 + rnd() * 90, h = 40 + rnd() * 70;
    const x = -5 + Math.cos(a) * r * 1.0, z = -10 + Math.sin(a) * r;
    b.deco('pillar', { pos: [x, GROUND + h / 2, z], size: [6 + rnd() * 4, h, 6 + rnd() * 4], color: 0xdfe8ec });
    if (i % 3 === 0) b.deco('beacon', { pos: [x, GROUND + h + 3, z], size: [2, 6, 2], color: i % 2 ? ORANGE : GLOW });
  }

  b.route(route);
});
