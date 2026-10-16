// ÉGI KIKÖTŐ: a sky harbour above the clouds. Wooden docks and grassy floating islands, balloons and airships in the sky, a
// lighthouse (with a beam of light up into the sky) as the landmark you can see from the start. Könnyű: every gap is <= ~60 %
// of what its technique reaches (run jump 6.5 m flat, jump + DJ 11.4, dodge 6.0, dodge + DJ 14.1 flat / 13.2 at +0.5 m, tap
// shield + DJ about 3.7 m up; the proof bot from a perfect edge takeoff).
//
//   S1 pier, a run jump (3.4 m), the first jump pad to island A    S5 a rope bridge of five planks (run jumps 3.6 m), the boardwalk
//   S2 dodge jump 8.4 m to the cargo dock                              (rest and vista), three pontoons on balloons (dodge jumps 8.0 m)
//   S3 two cargo ledges: tap shield jump + DJ (2.2 m each)         S6 three pads over small islands to the lighthouse island
//   S4 crane deck, a long pad (26 m) to island B                   S7 the lighthouse: a square spiral of gangways with a run jump
//                                                                      (3.6 m), a shield ledge (2.2 m), a DJ gap (6.5 m), a dodge jump
//                                                                      (8.0 m), then the balcony (a last tap shield ledge, 2.2 m)
//
// Layout: a chain of frames like kikepzes.js. `cur` is the frame at the far end of the last element (heading local -z);
// deck() / disc() / gap() / ledge() / gangway() make their geometry inside b.group() of their frame, the proof route reads the
// same frames. Under every element (and every gap) there is a void slab 9-12 m down, except under the lighthouse spiral: the
// island is the safety net there. The sky decoration is kept away from the course (clear() against the trail of frames).
import { defineMap } from '../sim/builder.js';
import { R } from '../sim/bot.js';
import { rotY, mulberry32 } from '../sim/math.js';

const GLOW = 0x60e0ff, GOLD = 0xffc040, BLUE = 0x2a8fd0, WOODC = 0x6a4a30;
const GAP = { j1: 3.4, pad1: 14, dj1: 8.4, pad2: 26, dj: 8.0, pad3: [16, 18, 20], sj: 3.6, sdj: 6.5, sdj2: 8.0, pk: 3.6 };

export default defineMap({
  id: 'egikikoto', name: 'ÉGI KIKÖTŐ', diff: 'konnyu', order: 3, authorTime: 73.933,
  blurb: 'Lebegő szigetek a felhők felett. Ugrópárnák, kiugrásos ugrások, pajzsugrás jelzett helyeken.',
  theme: {
    sky: { type: 'clouds', top: 0x3d8fe0, horizon: 0xdff0ff, bottom: 0x9cc8f0, sunDir: [0.5, 0.7, -0.3], sunColor: 0xfff4d8, clouds: 0.6 },
    fog: { color: 0xcfe4f8, near: 90, far: 700 },
    hemi: { sky: 0xbfe0ff, ground: 0x8aa0b8, intensity: 1.0 }, sun: { color: 0xfff0d0, intensity: 1.8 },
    palette: { floor: 0xb48a5c, wall: 0xe4ecf0, trim: BLUE, accent: GOLD, glow: GLOW, danger: 0xff5050 },
    bloom: 0.5, ambient: 'wind',
  },
}, (b) => {
  b.mat('floor', { base: 'panel', color: 0xb48a5c, trim: 0x6a4a2a });
  b.mat('wall', { base: 'panel', color: 0xe4ecf0, trim: BLUE });
  b.mat('trim', { base: 'neon', color: BLUE, emissive: BLUE });
  b.mat('turf', { base: 'rock', color: 0x6aa648, trim: 0x4a8a30 });
  b.mat('cliff', { base: 'rock', color: 0x9a8a78, trim: 0x6a5a48 });
  b.mat('steel', { base: 'metal', color: 0xc8d4dc, trim: BLUE });
  b.mat('cargoR', { base: 'panel', color: 0xc8442c, trim: 0xf0e0d0 });
  b.mat('cargoB', { base: 'panel', color: 0x2c6ab0, trim: 0xf0e0d0 });
  b.mat('cargoY', { base: 'panel', color: 0xd8a828, trim: 0x4a3818 });
  b.mat('cargoG', { base: 'panel', color: 0x3c8a58, trim: 0xf0e0d0 });
  b.mat('hazard', { base: 'hazard', color: 0xffc400, trim: 0x203040 });
  b.mat('plank', { base: 'panel', color: 0x7a5636, trim: 0x4a3018 });
  b.mat('wood', { base: 'panel', color: 0x8a5e3a, trim: 0x4a3018 });
  b.mat('leaf', { base: 'concrete', color: 0x3f9a3c, trim: 0x2a7a2a });
  b.mat('leaf2', { base: 'concrete', color: 0x66b848, trim: 0x2a7a2a });
  b.mat('roof', { base: 'panel', color: 0xc8442c, trim: 0x8a2a18 });
  b.mat('roofB', { base: 'panel', color: 0x2c6ab0, trim: 0x1c4a80 });
  b.mat('lamp', { base: 'neon', color: 0xffe2a0, emissive: 0xffd070 });
  b.mat('glassl', { base: 'glass', color: 0xfff0b0, emissive: 0xffd870 });
  b.mat('beam', { base: 'neon', color: 0xfff6c0, emissive: 0xfff0a0 });
  b.mat('cloud', { base: 'concrete', color: 0xffffff, emissive: 0x9aa6b8 });
  b.mat('canR', { base: 'panel', color: 0xd8483a, trim: 0xf4e0c0 });
  b.mat('canY', { base: 'panel', color: 0xf0c040, trim: 0xf4e0c0 });
  b.mat('canT', { base: 'panel', color: 0x30b0b0, trim: 0xf4e0c0 });
  b.mat('canW', { base: 'panel', color: 0xf4f0e8, trim: 0xd8483a });

  // ---------- frames ----------
  const trail = [];
  const frame = (at, yaw) => (trail.push(at), { at, yaw, p: (x, y, z) => { const q = rotY([x, y, z], yaw); return [q[0] + at[0], q[1] + at[1], q[2] + at[2]]; } });
  const XZ = (f, x, z) => { const q = f.p(x, 0, z); return [q[0], q[2]]; };
  const inF = (f, fn) => b.group({ at: f.at, yaw: f.yaw }, fn);
  let cur = frame([0, 0, 0], 0);
  const route = [];
  const rnd = mulberry32(3131);
  let slabs = true;   // void slabs under the elements (off over the lighthouse island)
  const voidSlab = (f, len, w = 14) => { if (slabs) b.kill([-w, -12, 0], [w, -9, -len], 'void'); };

  // ---------- decoration helpers (local coordinates of the active group) ----------
  const light = (x, y, z, c = 0xffe0a0, i = 0.9, r = 13) => b.light([x, y, z], c, i, r);
  const arrows = (...zs) => zs.forEach((z) => b.glyph([0, 0.02, z], 'arrow', 0));
  const lamp = (x, z, h = 3.2) => {
    b.deco('pillar', { pos: [x, h / 2, z], size: [0.18, h, 0.18], color: 0x3a4650 });
    b.decoBrush('box', [x - 0.24, h, z - 0.24], [x + 0.24, h + 0.5, z + 0.24], { mat: 'lamp' });
    light(x, h + 0.4, z);
  };
  const tree = (x, z, s = 1, y = 0) => {
    b.prism([x, y + 1.1 * s, z], 0.36 * s, 2.2 * s, { sides: 6, mat: 'wood' });   // a real trunk: nobody walks through a tree
    b.decoBrush('prism', [x, y + 3.1 * s, z], 1.9 * s, 2.6 * s, { sides: 7, mat: 'leaf' });
    b.decoBrush('prism', [x, y + 4.7 * s, z], 1.3 * s, 2.0 * s, { sides: 7, mat: 'leaf2' });
  };
  const flag = (x, z, mat, h = 5) => {
    b.deco('pillar', { pos: [x, h / 2, z], size: [0.16, h, 0.16], color: 0xdde6ec });
    b.decoBrush('box', [x, h - 1.1, z - 0.03], [x + 1.7, h - 0.1, z + 0.03], { mat });
  };
  const hut = (x, z, w, d, h, wall = 'wall', roof = 'roof') => {
    b.box([x - w / 2, 0, z - d / 2], [x + w / 2, h, z + d / 2], { mat: wall });
    const o = 0.5;
    b.decoBrush('hull', [[x - w / 2 - o, h, z - d / 2 - o], [x + w / 2 + o, h, z - d / 2 - o], [x - w / 2 - o, h, z + d / 2 + o], [x + w / 2 + o, h, z + d / 2 + o], [x, h + w * 0.42, z]], { mat: roof });
    b.decoBrush('box', [x - 0.5, 0, z + d / 2 - 0.02], [x + 0.5, 1.9, z + d / 2 + 0.04], { mat: 'plank' });
    b.decoBrush('box', [x - w / 2 + 0.5, h * 0.45, z + d / 2 - 0.02], [x - w / 2 + 1.4, h * 0.45 + 0.9, z + d / 2 + 0.04], { mat: 'trim' });
  };
  // pilings under a dock (down into the clouds)
  const pilings = (w, len, f) => {
    const bot = -26 - f.at[1];
    for (const z of len > 10 ? [-1.2, -len / 2, -len + 1.2] : [-1.2, -len + 1.2]) for (const s of [-1, 1]) b.deco('pillar', { pos: [s * (w / 2 - 0.5), (bot - 0.6) / 2, z], size: [0.55, -bot - 0.6, 0.55], color: WOODC });
    b.deco('beam', { pos: [0, -8, -len / 2], size: [w - 0.4, 0.3, 0.3], color: WOODC, yaw: 0 });
  };
  const rock = (x, z, s) => b.prism([x, 0.4 * s, z], 0.8 * s, 0.8 * s, { sides: 6, mat: 'cliff', yaw: x * 7 });
  // the rock underside of a floating island
  const underRock = (r, t = 1.2, depth = r * 1.15) => {
    const pts = [], n = 12;
    for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2, k = 0.93 + 0.07 * Math.sin(i * 2.3); pts.push([Math.cos(a) * r * k, -t, -r + Math.sin(a) * r * k]); }
    for (let i = 0; i < n; i++) { const a = ((i + 0.5) / n) * Math.PI * 2, k = 0.62 + 0.08 * Math.sin(i * 1.7); pts.push([Math.cos(a) * r * k, -t - depth * (0.45 + 0.1 * Math.sin(i * 3.1)), -r + Math.sin(a) * r * k]); }
    pts.push([0.08 * r, -t - depth, -r - 0.05 * r]);
    b.decoBrush('hull', pts, { mat: 'cliff' });
  };

  const airship = (cx, cy, cz, L, yaw, mat) => {
    const R_ = L * 0.15, pts = [[-L / 2, 0, 0], [L / 2, 0, 0]];
    for (const [t, k] of [[-0.32, 0.72], [0, 1], [0.32, 0.78]]) for (let i = 0; i < 8; i++) { const a = (i * Math.PI) / 4; pts.push([t * L, Math.sin(a) * R_ * k * 0.92, Math.cos(a) * R_ * k]); }
    const T = (p) => { const q = rotY(p, yaw); return [q[0] + cx, q[1] + cy, q[2] + cz]; };
    b.decoBrush('hull', pts.map(T), { mat });
    b.decoBrush('block', T([0, -R_ * 1.02, 0]), [L * 0.2, R_ * 0.45, R_ * 0.44], { mat: 'wood', yaw });
    b.decoBrush('block', T([-L * 0.42, R_ * 0.55, 0]), [L * 0.1, R_ * 0.9, 0.3], { mat: 'steel', yaw });
    b.decoBrush('block', T([-L * 0.42, 0, 0]), [L * 0.1, 0.3, R_ * 1.8], { mat: 'steel', yaw });
  };

  // ---------- pieces ----------
  const deck = (len, o = {}) => {
    const f = cur, w = o.w ?? 8;
    inF(f, () => {
      b.box([-w / 2, -0.6, -len], [w / 2, 0, 0], { mat: o.mat || 'floor' });
      voidSlab(f, len);
      for (const s of [-1, 1]) b.decoBrush('box', [s * (w / 2 - 0.06) - 0.06, 0.004, -len + 0.3], [s * (w / 2 - 0.06) + 0.06, 0.03, -0.3], { mat: 'trim' });
      if (o.lip !== false) b.decoBrush('box', [-w / 2, 0.004, -len], [w / 2, 0.03, -len + 0.45], { mat: 'hazard' });
      for (let z = -2; z > -len + 0.5; z -= 2) b.decoBrush('box', [-w / 2 + 0.2, 0.002, z - 0.025], [w / 2 - 0.2, 0.022, z + 0.025], { mat: 'plank' });
      if (o.rails ?? (len >= 9 && w <= 10)) {
        for (const s of [-1, 1]) {
          const x0 = s > 0 ? w / 2 - 0.12 : -w / 2, x1 = s > 0 ? w / 2 : -w / 2 + 0.12;
          b.box([x0, 0, -len + 1.8], [x1, 1.0, -1.8], { mat: 'steel' });
          b.decoBrush('box', [x0 - 0.02, 1.0, -len + 1.8], [x1 + 0.02, 1.06, -1.8], { mat: 'trim' });
          for (let z = 2.4; z < len - 1.8; z += 3) b.decoBrush('box', [x0 - 0.02, 0, -z - 0.07], [x1 + 0.02, 1.0, -z + 0.07], { mat: 'wall' });
        }
      }
      if (o.pilings !== false) pilings(w, len, f);
    });
    cur = frame(f.p(0, 0, -len), f.yaw);
    return f;
  };
  const disc = (r, o = {}) => {
    const f = cur, t = 1.2, n = o.sides ?? 14;
    inF(f, () => {
      b.prism([0, -t / 2, -r], r, t, { sides: n, mat: 'turf' });
      b.decoBrush('prism', [0, 0.02, -r], r - 0.05, 0.04, { sides: n, mat: 'turf' });
      underRock(r);
      voidSlab(f, 2 * r, r + 8);
    });
    cur = frame(f.p(0, 0, -2 * r), f.yaw);
    return f;
  };
  const gap = (len, dy = 0) => { const f = cur; inF(f, () => voidSlab(f, len)); cur = frame(f.p(0, dy, -len), f.yaw); return f; };
  const ledge = (len, dy, w = 6, mat = 'cargoR') => {
    const f = cur;
    inF(f, () => {
      b.box([-w / 2, -6, -len], [w / 2, dy, 0], { mat });
      voidSlab(f, len);
      b.decoBrush('box', [-w / 2, dy - 0.04, 0], [w / 2, dy + 0.02, 0.06], { mat: 'trim' });
    });
    cur = frame(f.p(0, dy, -len), f.yaw);
    return frame(f.p(0, dy, 0), f.yaw);   // the top of the ledge, at its near edge
  };
  const gangway = (len, rise, w = 4.6) => {
    const f = cur;
    inF(f, () => {
      const pts = [];
      for (const x of [-w / 2, w / 2]) pts.push([x, 0, 0], [x, rise, -len], [x, -0.6, 0], [x, rise - 0.6, -len]);
      b.hull(pts, { mat: 'floor' });
      for (const s of [-1, 1]) {
        const x0 = s > 0 ? w / 2 - 0.12 : -w / 2, x1 = s > 0 ? w / 2 : -w / 2 + 0.12;
        b.hull([[x0, 0, 0], [x1, 0, 0], [x0, rise, -len], [x1, rise, -len], [x0, 1.0, 0], [x1, 1.0, 0], [x0, rise + 1.0, -len], [x1, rise + 1.0, -len]], { mat: 'steel' });
        b.decoBrush('hull', [[x0, 1.0, 0], [x1, 1.0, 0], [x0, rise + 1.0, -len], [x1, rise + 1.0, -len], [x0, 1.06, 0], [x1, 1.06, 0], [x0, rise + 1.06, -len], [x1, rise + 1.06, -len]], { mat: 'trim' });
      }
      voidSlab(f, len);
    });
    cur = frame(f.p(0, rise, -len), f.yaw);
    return f;
  };
  const cp = (label, w = 3.4, z0 = -0.5, z1 = -9) => b.checkpoint([-w, 0, z0], [w, 12, z1], { spawn: [0, 0, -3], yaw: 0, label });
  const turn = (side, len, w) => { cur = frame(cur.p(-side * w / 2, 0, len / 2), cur.yaw + side * 90); };   // side +1 left, -1 right
  const beaconPosts = (z, w, h = 3, color = GLOW) => { for (const s of [-1, 1]) { b.deco('pillar', { pos: [s * (w / 2 + 0.4), h / 2, z], size: [0.3, h, 0.3], color: 0xdde6ec }); b.deco('beacon', { pos: [s * (w / 2 + 0.4), h + 0.3, z], size: [0.5, 0.7, 0.5], color }); } };

  // a jump pad throws to its target on a parabola; three rings mark the arc
  const padHop = (f, padZ, tf, tz, apexAbove = 6, ringD = 5) => {
    const p0 = f.p(0, 0, padZ), p1 = tf.p(0, 0, tz);
    const apex = Math.max(p0[1], p1[1]) + apexAbove;
    b.pad(p0, { target: p1, apex });
    const g = 19, vy = Math.sqrt(2 * g * (apex - p0[1])), T = vy / g + Math.sqrt((2 * (apex - p1[1])) / g);
    const dist = Math.hypot(p1[0] - p0[0], p1[2] - p0[2]);
    inF(f, () => {
      b.deco('ring', { pos: [0, 0.3, padZ], size: [2.6, 2.6, 0.3], color: GLOW });
      for (const t of [0.25, 0.5, 0.75]) b.deco('ring', { pos: [0, vy * T * t - 0.5 * g * (T * t) * (T * t) + 1.0, padZ - dist * t], size: [ringD, ringD, 0.3], color: GLOW });
      light(0, 2.2, padZ, GLOW, 1.2, 12);
    });
  };

  // ================= S1: the pier, the first pad =================
  const P0 = deck(40, { w: 10 });
  inF(P0, () => {
    b.start([0, 0, -6], 0);
    // the harbour office behind the start, a real back wall
    b.box([-5, 0, -0.5], [5, 2.4, 0.1], { mat: 'wall' });
    b.decoBrush('box', [-13, -0.6, 0.1], [13, 9, 15], { mat: 'wall' });
    b.decoBrush('hull', [[-14, 9, -0.6], [14, 9, -0.6], [-14, 9, 16], [14, 9, 16], [-7, 13.5, 3], [7, 13.5, 3], [-7, 13.5, 12], [7, 13.5, 12]], { mat: 'roofB' });
    b.decoBrush('box', [-3.4, 0, 0.06], [3.4, 5.6, 0.12], { mat: 'cargoY' });
    for (const x of [-9.5, -6.5, 6.5, 9.5]) b.decoBrush('box', [x - 0.7, 3.2, 0.06], [x + 0.7, 5.4, 0.12], { mat: 'trim' });
    b.deco('screen', { pos: [0, 7.4, -0.5], size: [7, 1.6, 0.2], yaw: 180, color: GOLD });
    // cargo (real) at the sides
    const crate = (x, z, mat, h = 1.6) => b.box([x - 1, 0, z - 1], [x + 1, h, z + 1], { mat });
    crate(3.7, -12, 'cargoR'); crate(-3.7, -18, 'cargoB'); crate(3.7, -24, 'cargoY', 2.2); crate(-3.7, -29, 'cargoG');
    for (const z of [-8, -20, -32]) { lamp(-4.5, z); lamp(4.5, z); }
    flag(-4.7, -3, 'canR'); flag(4.7, -3, 'canY'); flag(-4.7, -37, 'canT'); flag(4.7, -37, 'canW');
    arrows(-14, -22, -30, -36);
    b.sign([-3.4, 2.6, -11], 0, { title: 'ÉGI KIKÖTŐ', keys: 'W A S D · SPACE', text: 'Ugorj át a réseken, és kövesd a nyilakat a világítótoronyig. Ha leesel, az ellenőrzőpontra térsz vissza.' });
    // a moored airship overhead (nose to the mast), a crane at the side
    airship(0, 21, -20, 38, 90, 'canW');
    b.deco('pillar', { pos: [4.5, 6, -38], size: [0.4, 12, 0.4], color: 0x5a6a78 });
    b.deco('cable', { pos: [0, 20.5, -39], to: [4.5, 12, -38], color: 0x3a3030 });
    b.deco('pillar', { pos: [-8.5, 7, -22], size: [0.7, 14, 0.7], color: 0x5a6a78 });
    b.deco('beam', { pos: [-7.1, 14.2, -22], size: [3.6, 0.6, 0.6], color: GOLD });
    b.deco('cable', { pos: [-6, 13.9, -22], to: [-6, 8.6, -22], color: 0x3a3030 });
    b.deco('crate', { pos: [-6, 8.0, -22], size: [1.8, 1.4, 1.8], color: 0xc8442c });
  });
  gap(GAP.j1);
  const P1 = deck(12);
  inF(P1, () => {
    arrows(-3);
    for (const z of [-3, -10]) lamp(-4.4, z);
    b.sign([-3.2, 2.6, -2.6], 0, { title: 'UGRÓPÁRNA', keys: 'lépj az izzó párnára', text: 'A párna átrepít a szigetre. Közben W + egér: irányíthatod a landolást.' });
  });
  route.push(R.jump({ edge: true, to: XZ(P1, 0, -6) }));

  // ================= S1b: pad to island A =================
  gap(GAP.pad1, 4);
  const A = disc(10);
  padHop(P1, -9, A, -4);
  route.push(R.run(...XZ(P1, 0, -9), { tol: 0.4 }));
  route.push(R.glide({ to: XZ(A, 0, -4) }));
  inF(A, () => {
    cp('1 · SZIGET');
    // a windmill, trees, a few rocks
    b.prism([-5.2, 4.4, -15], 1.9, 9, { sides: 8, mat: 'wall' });
    b.decoBrush('hull', [[-7.4, 8.8, -17.2], [-3, 8.8, -17.2], [-7.4, 8.8, -12.8], [-3, 8.8, -12.8], [-5.2, 11.6, -15]], { mat: 'roof' });
    b.deco('fan', { pos: [-5.2, 8.6, -12.7], size: [8.5, 8.5, 0.3], color: 0xf4f0e8 });
    b.decoBrush('box', [-5.7, 0, -13.2], [-4.7, 1.9, -13.1], { mat: 'plank' });
    tree(6.3, -4, 1.1); tree(7.2, -9, 1.3); tree(-7, -6.5, 1); tree(5.6, -16.5, 1.2); tree(-3.2, -18, 0.9);
    rock(6.5, -13, 1.2); rock(-6.8, -10.5, 0.8); rock(-2.6, -3, 0.5);
    arrows(-9, -16);
    light(0, 3, -10, 0xfff0d0, 0.8, 16);
  });

  // ================= S2: dodge jump to the cargo dock =================
  gap(GAP.dj1);
  const B = deck(18, { w: 6 });
  inF(A, () => beaconPosts(-19.2, 6, 3));
  inF(B, () => { beaconPosts(-0.3, 6, 3); });
  route.push(R.dodgeJump('F', { edge: true, to: XZ(B, 0, -6) }));

  // ================= S3: two cargo ledges (tap shield jump + double jump) =================
  const C1 = ledge(7, 2.2, 6, 'cargoR');
  const C2 = ledge(8, 2.2, 6, 'cargoB');
  inF(B, () => {
    b.glyph([0, 0.02, -17.1], 'shield', 0);
    for (const z of [-4, -13]) { lamp(-2.7, z); lamp(2.7, z); }
    b.sign([-3.4, 2.6, -10], 0, { title: 'RÖVID PAJZSUGRÁS', keys: 'kattints röviden + SPACE · a csúcson SPACE', text: 'Nézz le a jelzett körre. Rövid kattintás a bal gombbal és SPACE egyszerre, a csúcson még egy SPACE.' });
    arrows(-5);
  });
  inF(C1, () => { b.glyph([0, 0.02, -6.1], 'shield', 0); lamp(-2.7, -2); lamp(2.7, -2); });
  route.push(R.run(...XZ(B, 0, -18 + 0.6), { stop: true, tol: 0.25 }));
  route.push(R.shieldJump({ charge: 0, dj: 'apex', to: XZ(C1, 0, -3) }));
  route.push(R.run(...XZ(C1, 0, -4), { tol: 0.5 }));
  route.push(R.shieldJump({ charge: 0, dj: 'apex', run: XZ(C2, 0, -3), to: XZ(C2, 0, -3) }));

  // ================= S4: crane deck, long pad to island B =================
  const CR = deck(10, { w: 8, pilings: false });
  inF(CR, () => {
    cp('2 · DARU');
    // a gantry crane with a container on its hook
    for (const s of [-1, 1]) b.deco('pillar', { pos: [s * 5.2, 5, -6], size: [0.6, 10, 0.6], color: 0x5a6a78 });
    b.deco('beam', { pos: [0, 10, -6], size: [11.4, 0.7, 0.7], color: GOLD });
    for (const s of [-1, 1]) b.deco('cable', { pos: [s * 1.1, 9.7, -6], to: [s * 1.1, 7.0, -6], color: 0x3a3030 });
    b.decoBrush('box', [-1.6, 4.6, -7], [1.6, 7.0, -5], { mat: 'cargoY' });
    for (const z of [-3, -8]) { lamp(-3.6, z); lamp(3.6, z); }
    arrows(-6.5);
    beaconPosts(-9.6, 8, 3);
  });
  gap(GAP.pad2, -2.4);
  const B2 = disc(11);
  padHop(CR, -8, B2, -5, 9, 7);
  route.push(R.run(...XZ(CR, 0, -8), { tol: 0.4 }));
  route.push(R.glide({ to: XZ(B2, 0, -5) }));
  inF(B2, () => {
    hut(-6.5, -16.5, 4.4, 3.2, 3.0, 'wall', 'roof');
    tree(6.8, -4.5, 1.2); tree(6.2, -17.6, 1); tree(-7.2, -5, 1.1); tree(3.5, -18.8, 1.2);
    rock(-4.5, -3.5, 0.9); rock(5, -17.5, 0.7);
    flag(2.6, -2.4, 'canR', 4.2);
    light(0, 3, -10, 0xfff0d0, 0.8, 16);
  });

  // ================= S5: boardwalk east (rest), three pontoons (dodge jumps) =================
  route.push(R.run(...XZ(B2, 9.5, -11), { tol: 1 }));
  turn(-1, 22, 22);
  // the rope bridge: five planks over the clouds (run jumps), ropes along both sides
  const plankF = [];
  const bridgeStart = cur;
  for (let i = 0; i < 5; i++) { gap(GAP.pk); plankF.push(deck(4.0, { w: 2.2, pilings: false, rails: false })); }
  gap(GAP.pk);
  const BW = deck(46, { w: 5 });
  inF(bridgeStart, () => {
    const L = 5 * 4.0 + 6 * GAP.pk;
    for (const sx of [-1, 1]) {
      b.deco('cable', { pos: [sx * 1.35, 1.15, 0.8], to: [sx * 1.35, 1.15, -L - 0.8], color: 0x6a4a30 });
      b.deco('cable', { pos: [sx * 1.35, 0.55, 0.8], to: [sx * 1.35, 0.55, -L - 0.8], color: 0x6a4a30 });
    }
    for (let i = 0; i <= 5; i++) { const z = -i * (4.0 + GAP.pk); for (const sx of [-1, 1]) b.deco('pillar', { pos: [sx * 1.35, 0.7, z === 0 ? 0.4 : z + (i ? GAP.pk * 0.5 : 0)], size: [0.14, 1.5, 0.14], color: WOODC }); }
    for (const z of [-GAP.pk - 5, -3 * (GAP.pk + 4.0) + 1]) { b.deco('pillar', { pos: [-1.8, 1.4, z], size: [0.12, 2.8, 0.12], color: WOODC }); b.decoBrush('block', [-1.8, 2.95, z], [0.4, 0.5, 0.4], { mat: 'lamp' }); light(-1.8, 3.0, z, 0xffe0a0, 0.9, 12); }
  });

  const pontoons = [];
  for (let i = 0; i < 3; i++) { gap(GAP.dj, 0.5); pontoons.push(deck(13, { w: 5 })); }
  gap(GAP.dj, 0.5);
  const PL = deck(14, { w: 10, rails: false });
  inF(BW, () => {
    for (const z of [-8, -20, -32, -44]) { lamp(-2.9, z, 3.4); lamp(2.9, z, 3.4); }
    arrows(-6, -14, -40);
    beaconPosts(-45.6, 5, 3);
    light(0, 3, -23, 0xfff0d0, 0.8, 18);
  });
  // each pontoon hangs from a balloon on four ropes
  const BALL = ['canR', 'canY', 'canT'];
  const balloonAt = (x, y, z, r, mat) => {
    const pts = [[0, r * 1.2, 0], [0, -r * 1.05, 0]];
    for (const [t, k] of [[0.62, 0.84], [0, 1], [-0.62, 0.74]]) for (let i = 0; i < 8; i++) { const a = (i * Math.PI) / 4; pts.push([Math.cos(a) * r * k, t * r, Math.sin(a) * r * k]); }
    b.decoBrush('hull', pts.map((p) => [p[0] + x, p[1] + y, p[2] + z]), { mat });
    b.decoBrush('prism', [x, y + r * 0.2, z], r * 1.02, r * 0.1, { sides: 8, mat: 'canW' });
  };
  pontoons.forEach((f, i) => inF(f, () => {
    balloonAt(0, 15, -6.5, 4.2, BALL[i]);
    for (const sx of [-1, 1]) for (const z of [-1.2, -11.8]) b.deco('cable', { pos: [sx * 2.2, 0.05, z], to: [sx * 1.3, 11.6, -6.5 + (z > -6 ? 1.3 : -1.3)], color: 0x4a3a30 });
    lamp(-2.2, -6.5, 2.6); lamp(2.2, -6.5, 2.6);
    arrows(-3, -10);
  }));
  inF(PL, () => {
    cp('3 · PIAC');
    hut(-3.3, -11, 2.4, 2.4, 2.6, 'wall', 'roofB'); hut(3.3, -11, 2.4, 2.4, 2.6, 'cargoY', 'roof');
    for (const z of [-3, -9]) { lamp(-4.5, z); lamp(4.5, z); }
    flag(-4.8, -12.8, 'canR', 5); flag(4.8, -12.8, 'canT', 5);
    for (const x of [-1.5, -3, -4.2]) b.glyph([x, 0.02, -7], 'arrow', 90);   // the course turns left here
  });
  route.push(R.jump({ edge: true, to: XZ(plankF[0], 0, -2) }));
  plankF.forEach((f, i) => route.push(R.jump({ edge: true, to: i + 1 < plankF.length ? XZ(plankF[i + 1], 0, -2) : XZ(BW, 0, -6) })));
  route.push(R.dodgeJump('F', { edge: true, to: XZ(pontoons[0], 0, -4) }));
  pontoons.forEach((f, i) => route.push(R.dodgeJump('F', { edge: true, to: i + 1 < pontoons.length ? XZ(pontoons[i + 1], 0, -4) : XZ(PL, 0, -6) })));

  // ================= S6: three pads over small islands to the lighthouse island =================
  route.push(R.run(...XZ(PL, 0, -9), { tol: 1 }));
  turn(1, 14, 10);
  const PL2 = deck(8, { w: 8 });
  gap(GAP.pad3[0], 2);
  const isl = [disc(5.5)];
  gap(GAP.pad3[1], 2);
  isl.push(disc(5.5));
  gap(GAP.pad3[2], 2.5);
  const LI = disc(30, { sides: 24 });
  padHop(PL2, -6, isl[0], -4, 6);
  padHop(isl[0], -8, isl[1], -4, 6);
  padHop(isl[1], -8, LI, -5, 6.5);
  isl.forEach((f, i) => inF(f, () => { tree(i ? -3.7 : 3.7, -2.4, 0.9); tree(i ? 3.6 : -3.6, -5.4, 0.8); rock(0, -10, 0.5); }));
  inF(PL2, () => { for (const z of [-2]) { lamp(-3.2, z); lamp(3.2, z); } beaconPosts(-7.6, 8, 3); });
  route.push(R.run(...XZ(PL2, 0, -6), { tol: 0.4 }));
  route.push(R.glide({ to: XZ(isl[0], 0, -4) }));
  route.push(R.run(...XZ(isl[0], 0, -8), { tol: 0.4 }));
  route.push(R.glide({ to: XZ(isl[1], 0, -4) }));
  route.push(R.run(...XZ(isl[1], 0, -8), { tol: 0.4 }));
  route.push(R.glide({ to: XZ(LI, 0, -5) }));
  inF(LI, () => cp('4 · MAJÁK'));

  // ================= S7: the lighthouse =================
  // a square spiral of gangways and corner plazas around the tower, counter-clockwise from the south side, 6 m corner plazas
  const TZ = -30, TRAD = 7, SD = 17, SIDE = 2 * SD - 6, HALF = SD - 3, BAL = 14;   // tower axis (island frame), tower radius, spiral half-width, side / half-side lengths, balcony radius
  slabs = false;
  const plazaF = [];
  const plaza = (side) => {
    const f = cur;
    inF(f, () => {
      b.box([-3, -0.6, -6], [3, 0, 0], { mat: 'floor' });
      b.box([-3, 0, -6], [3, 1.0, -5.88], { mat: 'steel' });
      b.box([side > 0 ? 2.88 : -3, 0, -6], [side > 0 ? 3 : -2.88, 1.0, 0], { mat: 'steel' });
      for (const s of [-1, 1]) b.decoBrush('box', [s * 2.94 - 0.06, 0.004, -5.7], [s * 2.94 + 0.06, 0.03, -0.3], { mat: 'trim' });
      const h = f.at[1] - LI.at[1];
      for (const x of [-2.4, 2.4]) for (const z of [-0.8, -5.2]) b.prism([x, -0.6 - (h - 0.6) / 2, z], 0.4, h - 0.6, { sides: 6, mat: 'wood' });
      lamp(side > 0 ? 2.5 : -2.5, -5.4, 2.6);
    });
    cur = frame(f.p(0, 0, -6), f.yaw);
    plazaF.push(f);
    turn(side, 6, 6);
    return f;
  };
  const planks = { pilings: false, rails: false };
  cur = frame(LI.p(0, 0, TZ + SD), LI.yaw - 90);
  const spiralStart = cur;
  // side 1 (east): the walk from the island up to the first corner
  gangway(HALF, 1.7);
  plaza(1);
  // side 2 (north): a gap in the planks (run jump)
  gangway(8, 1.6);
  deck(4, { w: 4.6, ...planks });
  gap(GAP.sj);
  const s2b = deck(3, { w: 4.6, ...planks });
  gangway(SIDE - 8 - 4 - GAP.sj - 3, 1.8);
  plaza(1);
  // side 3 (west): a plain walk, the checkpoint at the corner
  gangway(SIDE, 3.4);
  const NW = plaza(1);
  inF(NW, () => cp('5 · TORONYLÉPCSŐ', 2.9, -0.5, -5.5));
  // side 4 (south): a broken stair, a ledge (tap shield jump)
  gangway(14, 1.2);
  const s4a = deck(4, { w: 4.6, ...planks });
  const s4L = ledge(SIDE - 14 - 4, 2.2, 4.6, 'cargoB');
  inF(s4a, () => b.glyph([0, 0.02, -3.1], 'shield', 0));
  plaza(1);
  // side 5 (east): a double-jump gap
  gangway(10, 2.8);
  const s5a = deck(4, { w: 4.6, ...planks });
  gap(GAP.sdj, 0.6);
  const s5b = deck(SIDE - 10 - 4 - GAP.sdj, { w: 4.6, ...planks });
  inF(s5a, () => b.glyph([0, 0.02, -3.0], 'dj', 0));
  plaza(1);
  // side 6 (north): a dodge jump over a missing section, the checkpoint at the corner after it
  gangway(8, 2.8);
  const s6a = deck(5, { w: 4.6, ...planks });
  gap(GAP.sdj2, 0.6);
  const s6b = deck(SIDE - 8 - 5 - GAP.sdj2, { w: 4.6, ...planks });
  inF(s6a, () => b.glyph([0, 0.02, -3.6], 'arrow', 0));
  const NE2 = plaza(1);
  inF(NE2, () => cp('6 · KILÁTÓ', 2.9, -0.5, -5.5));
  // side 7 (west): the narrow walkway, no rails (a little tension)
  gangway(SIDE, 3.4, 2.6);
  plaza(1);
  // side 8 (south): up to the tower's west side
  gangway(HALF - 3, 1.7);
  const FP = deck(6, { w: 6, ...planks });
  const FPy = FP.at[1] - LI.at[1];
  inF(FP, () => {
    b.box([-3, 0, -6], [3, 1.0, -5.88], { mat: 'steel' });
    b.box([2.88, 0, -6], [3, 1.0, 0], { mat: 'steel' });
    b.glyph([-1.7, 0.02, -3], 'shield', 90);
    b.sign([2.2, 2.6, 1.5], 0, { title: 'AZ UTOLSÓ PÁRKÁNY', keys: 'rövid kattintás + SPACE · SPACE', text: 'Fordulj a torony felé, nézz le, és pajzsugorj fel az erkélyre. A fénylő ajtó a cél.' });
  });
  // the tower, the balcony, the door (on the west face)
  inF(LI, () => {
    const t1 = 54, BT = FPy + 2.2;
    b.prism([0, t1 / 2, TZ], TRAD, t1, { sides: 12, mat: 'wall' });
    b.prism([0, BT - 2.2, TZ], BAL, 4.4, { sides: 12, mat: 'cargoR' });   // the balcony: a block down to below the plaza
    b.decoBrush('prism', [0, BT + 0.02, TZ], BAL - 0.05, 0.04, { sides: 12, mat: 'floor' });
    b.finish([-9.6, BT, TZ - 1.6], [-6.8, BT + 4, TZ + 1.6]);
    // red and white bands, the door, windows, the lantern room, roof, spire and the beam
    for (let y = 0, i = 0; y < t1; y += 4, i++) b.decoBrush('prism', [0, y + 2, TZ], TRAD + 0.06, 4, { sides: 12, mat: i % 2 ? 'cargoR' : 'wall' });
    b.decoBrush('box', [-6.95, BT, TZ - 1.1], [-6.7, BT + 3.2, TZ + 1.1], { mat: 'lamp' });
    for (let y = 8; y < t1 - 4; y += 7) { if (Math.abs(y - BT) < 3) continue; for (const sx of [-1, 1]) b.decoBrush('block', [sx * 6.95, y, TZ], [0.2, 1.6, 1.1], { mat: 'trim' }); for (const sz of [-1, 1]) b.decoBrush('block', [0, y, TZ + sz * 6.95], [1.1, 1.6, 0.2], { mat: 'trim' }); }
    b.decoBrush('prism', [0, t1 + 2.6, TZ], 4.6, 5.2, { sides: 12, mat: 'glassl' });
    b.decoBrush('prism', [0, t1 + 0.2, TZ], 5.8, 0.8, { sides: 12, mat: 'steel' });
    b.decoBrush('prism', [0, t1 + 5.4, TZ], 5.4, 0.5, { sides: 12, mat: 'steel' });
    b.decoBrush('hull', Array.from({ length: 8 }, (_, i) => [Math.cos((i * Math.PI) / 4) * 5.4, t1 + 5.6, TZ + Math.sin((i * Math.PI) / 4) * 5.4]).concat([[0, t1 + 11, TZ]]), { mat: 'roof' });
    b.deco('pillar', { pos: [0, t1 + 13.5, TZ], size: [0.3, 5, 0.3], color: 0xdde6ec });
    b.deco('beacon', { pos: [0, t1 + 2.6, TZ], size: [5, 7, 5], color: 0xfff0a0 });
    b.deco('beacon', { pos: [0, t1 + 70, TZ], size: [3.2, 120, 3.2], color: 0xfff6c8 });   // the beam into the sky
    b.light([-12, BT + 2, TZ], 0xffe0a0, 1.6, 24);
    b.light([0, t1 + 2.6, TZ], 0xfff0b0, 2, 40);
    // the keeper's house, trees and rocks on the island rim
    hut(-24, -12, 5, 4, 3.2, 'wall', 'roof'); hut(22, -50, 4.4, 3.6, 3, 'cargoY', 'roofB');
    for (const [x, z, s] of [[-25, -24, 1.3], [-27, -38, 1.1], [-24, -50, 1.2], [25, -16, 1.2], [27, -30, 1], [10, -57, 1.1], [-8, -58, 1.3], [-28, -30, 1.4], [26, -44, 1.2], [18, -56, 1], [-18, -56, 1.1]]) tree(x, z, s);
    rock(-10, -8, 1); rock(12, -9, 0.8); rock(25, -52, 1.1); rock(-22, -6, 0.9);
    arrows(-9);
  });

  // ---------- the proof route through the lighthouse ----------
  route.push(R.run(...XZ(spiralStart, 0, 2.5), { tol: 0.6 }));
  route.push(R.run(...XZ(plazaF[0], 0, -3), { tol: 1.0 }));
  route.push(R.jump({ edge: true, to: XZ(s2b, 0, -1.5) }));
  route.push(R.run(...XZ(plazaF[1], 0, -3), { tol: 1.0 }));
  route.push(R.run(...XZ(plazaF[2], 0, -3), { tol: 1.0 }));
  route.push(R.run(...XZ(s4a, 0, -3.4), { stop: true, tol: 0.25 }));
  route.push(R.shieldJump({ charge: 0, dj: 'apex', to: XZ(s4L, 0, -3) }));
  route.push(R.run(...XZ(plazaF[3], 0, -3), { tol: 1.0 }));
  route.push(R.jump({ edge: true, dj: 'apex', to: XZ(s5b, 0, -2) }));
  route.push(R.run(...XZ(plazaF[4], 0, -3), { tol: 1.0 }));
  route.push(R.dodgeJump('F', { edge: true, to: XZ(s6b, 0, -2) }));
  route.push(R.run(...XZ(plazaF[5], 0, -3), { tol: 1.0 }));
  route.push(R.run(...XZ(plazaF[6], 0, -3), { tol: 1.0 }));
  route.push(R.run(...XZ(FP, -1.8, -3), { stop: true, tol: 0.25 }));
  route.push(R.shieldJump({ charge: 0, dj: 'apex', to: XZ(LI, -10, TZ) }));
  route.push(R.run(...XZ(LI, -8, TZ), { tol: 0.8 }));

  // ================= scenery: the sky =================
  const clear = (x, y, z, r) => {
    for (let i = 0; i + 1 < trail.length; i++) {
      const a = trail[i], c = trail[i + 1], dx = c[0] - a[0], dy = c[1] - a[1], dz = c[2] - a[2];
      const l2 = dx * dx + dy * dy + dz * dz;
      const t = l2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy + (z - a[2]) * dz) / l2)) : 0;
      if (Math.hypot(x - (a[0] + dx * t), y - (a[1] + dy * t), z - (a[2] + dz * t)) < r) return false;
    }
    return true;
  };
  const sky = () => {
    // cloud sea far below, with puffs on top
    b.decoBrush('box', [-1200, -50, -1200], [1200, -36, 1200], { mat: 'cloud' });
    const cloud = (x, y, z, s) => {
      b.decoBrush('prism', [x, y, z], 7 * s, 3 * s, { sides: 9, mat: 'cloud' });
      b.decoBrush('prism', [x + 4.5 * s, y + 0.5 * s, z + 1.5 * s], 4.5 * s, 3.4 * s, { sides: 8, mat: 'cloud' });
      b.decoBrush('prism', [x - 4 * s, y + 0.4 * s, z - 1.8 * s], 4 * s, 3.2 * s, { sides: 8, mat: 'cloud' });
      b.decoBrush('prism', [x + 0.5 * s, y + 2.2 * s, z - 0.5 * s], 4 * s, 3 * s, { sides: 8, mat: 'cloud' });
    };
    for (let i = 0; i < 70; i++) cloud(-200 + rnd() * 620, -35 + rnd() * 3, 120 - rnd() * 640, 1.5 + rnd() * 2.5);
    for (let i = 0; i < 40; i++) { const x = -250 + rnd() * 720, y = 24 + rnd() * 70, z = 80 - rnd() * 560, c = 2.5 + rnd() * 3; if (clear(x, y, z, 22 + c * 8)) cloud(x, y, z, c); }
    // airships
    for (const [x, y, z, L, yaw, m] of [[-70, 26, -60, 46, 18, 'canW'], [190, 58, -150, 60, -35, 'canY'], [-60, 44, -250, 52, 80, 'canR'], [260, 36, -40, 44, 160, 'canT'], [40, 74, -330, 70, 10, 'canW'], [-100, 14, -170, 40, -70, 'canY'], [110, 90, -120, 56, 30, 'canR']]) if (clear(x, y, z, L * 0.6 + 12)) airship(x, y, z, L, yaw, m);
    // hot-air balloons
    const hot = (x, y, z, r, mat) => {
      balloonAt(x, y, z, r, mat);
      b.decoBrush('box', [x - r * 0.28, y - r * 1.9, z - r * 0.28], [x + r * 0.28, y - r * 1.4, z + r * 0.28], { mat: 'wood' });
      for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) b.deco('cable', { pos: [x + dx * r * 0.26, y - r * 1.4, z + dz * r * 0.26], to: [x + dx * r * 0.6, y - r * 0.55, z + dz * r * 0.6], color: 0x4a3a30 });
    };
    for (const [x, y, z, r, m] of [[-35, 30, -20, 5, 'canR'], [30, 40, -90, 6, 'canY'], [-40, 36, -150, 5.5, 'canT'], [80, 30, -120, 5, 'canW'], [150, 46, -80, 6, 'canR'], [60, 20, -230, 4.6, 'canY'], [180, 34, -230, 5.4, 'canT'], [-20, 52, -300, 6, 'canR'], [110, 62, -270, 6, 'canY'], [210, 54, -190, 5, 'canW'], [95, 28, -60, 5, 'canT'], [-15, 18, -210, 5, 'canY']]) if (clear(x, y, z, r * 2 + 14)) hot(x, y, z, r, m);
    // distant floating islands
    const farIsland = (x, y, z, r) => {
      b.decoBrush('prism', [x, y - 0.6, z], r, 1.2, { sides: 12, mat: 'turf' });
      const pts = [];
      for (let i = 0; i < 10; i++) { const a = (i / 10) * Math.PI * 2; pts.push([x + Math.cos(a) * r * 0.9, y - 1.2, z + Math.sin(a) * r * 0.9]); }
      pts.push([x, y - 1.2 - r * 1.1, z]);
      b.decoBrush('hull', pts, { mat: 'cliff' });
      for (let i = 0; i < 3; i++) { const a = rnd() * 6.28, d = rnd() * r * 0.6; const tx = x + Math.cos(a) * d, tz = z + Math.sin(a) * d, s = 1.6; b.deco('pillar', { pos: [tx, y + 1.5, tz], size: [0.8, 3, 0.8], color: WOODC }); b.decoBrush('prism', [tx, y + 4.5, tz], 2.6, 3.6, { sides: 7, mat: 'leaf' }); }
    };
    for (const [x, y, z, r] of [[-60, 6, -120, 14], [170, 12, -10, 12], [-80, 20, -240, 16], [230, 22, -140, 14], [20, 34, -380, 15], [-30, -4, 30, 11], [250, 30, -270, 13], [120, 8, 60, 10], [60, 16, -60, 9], [-50, 12, -60, 10]]) if (clear(x, y, z, r * 1.5 + 18)) farIsland(x, y, z, r);
  };
  sky();

  b.route(route);
});
