// The shield gauntlet (pajzskesztyű): PAJZSUGRÁS' own first person weapon and the one on the character's forearm. Built from code with the
// hard-surface kit (hardkit.js): a layered armour housing on a gunmetal frame, knuckle guards, a power cell under a window, cooling fins, cables,
// bellows and, at the front, the emitter: a ringed dish with a hex lens, three prongs and a spinning ring of lights.
//
//   const g = buildGauntlet({ lod: 'fp' | 'tp', tint = 0xff8a2a, seed })
//     -> { group, parts, mats, tris, lod, update(dt, t, { charge, flash, quiet }), fire(), dispose() }
//   parts = { core, glow, rings, prongs, orbit, fins, cell, muzzle }
//   Frame: metres, the muzzle plane is z = 0 and the gauntlet extends BACK along +z (the player looks along -z), y up, x right.
//   fp: 10 - 20k triangles, with the armoured forearm that runs off the screen;  tp: 2 - 3k, the housing and the emitter only.
//   update drives the behaviour from the shield state: charge 0..1 (the prongs open up to 10 degrees, the rings / orbit / core / cell brighten,
//   a micro-shake grows), flash 1 -> 0 after a blast (the core flares); fire() snaps the prongs shut and heats the fins, which glow and cool over
//   0.6 s. quiet: the first person UT2004 gun is in use and the muzzle glow (parts.glow, re-parented there) is dimmer.
import * as THREE from 'three';
import { Kit, m4, rbox, cbox, plate, hexPlate, rrect, lathe, loft, sweep, tube, bolt } from './hardkit.js';
import { armourMats } from './armour-mats.js';
import { lin } from './merge.js';

const PI = Math.PI, TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const MIRROR = new THREE.Matrix4().makeScale(-1, 1, 1);
const mir = (m) => new THREE.Matrix4().multiplyMatrices(MIRROR, m);
const mul = (...ms) => ms.reduce((a, b) => new THREE.Matrix4().multiplyMatrices(a, b));

const LODS = {
  // rich: the detail that only a close look sees (bolts, vents, frame under-layers, gussets, collar, cuff, forearm, ribs)
  fp: { rich: true, seg: 48, mini: 40, corner: 4, bev: 2, boxSeg: 2, tubular: 20, radial: 6, lames: 3, fins: 5, lights: 12, clamps: 12, shell: 14, curve: 6 },
  tp: { rich: false, seg: 20, mini: 16, corner: 2, bev: 1, boxSeg: 1, tubular: 6, radial: 4, lames: 1, fins: 2, lights: 6, clamps: 0, shell: 6, curve: 3 },
};

// the outline of a convex polygon moved inwards by d (the paint plate sits inside its frame plate with a seam of d)
function inset(pts, d) {
  const n = pts.length;
  let area = 0;
  for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; area += a[0] * b[1] - b[0] * a[1]; }
  const s = area > 0 ? 1 : -1, out = [];
  const unit = (a, b) => { const x = b[0] - a[0], y = b[1] - a[1], l = Math.hypot(x, y) || 1; return [x / l, y / l]; };
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i + n - 1) % n], p1 = pts[i], p2 = pts[(i + 1) % n];
    const e1 = unit(p0, p1), e2 = unit(p1, p2), n1 = [-e1[1] * s, e1[0] * s], n2 = [-e2[1] * s, e2[0] * s];
    const k = d / (1 + n1[0] * n2[0] + n1[1] * n2[1]);
    out.push([p1[0] + (n1[0] + n2[0]) * k, p1[1] + (n1[1] + n2[1]) * k]);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------- profiles (r, f), f = forward distance from the muzzle plane
const bowlF = (r) => -0.034 * (1 - (r / 0.1035) * (r / 0.1035));   // the concave front of the dish
const ringRadii = (L) => (L.rich ? [0.085, 0.06, 0.036] : [0.07]);
// walked counter-clockwise (r to the right, f up): the back of the dish from the neck out to the rim, then the front back in to the centre
function dishProfile(L) {
  const P = [[0.054, -0.124], [0.054, -0.106], [0.06, -0.1]];
  const N = L.rich ? 6 : 2;
  for (let i = 1; i <= N; i++) {
    const t = i / N, r = 0.06 + 0.048 * Math.pow(t, 0.8), f = -0.1 + 0.088 * t;
    P.push([r, f]);
    if (L.rich && (i === 2 || i === 4)) P.push([r + 0.0035, f], [r + 0.0035, f + 0.0035], [r, f + 0.0035]);   // cooling ribs on the back
  }
  P.push([0.109, 0], [0.1035, 0]);                         // the lip of the rim
  let r = 0.1035;
  const steps = (to, n) => { const from = r; for (let i = 1; i <= n; i++) { r = from + (to - from) * i / n; P.push([r, bowlF(r)]); } };
  for (const rk of ringRadii(L)) {   // a groove for each glowing ring
    steps(rk + 0.003, 1);
    const fb = bowlF(rk + 0.003) - 0.003;
    P.push([rk + 0.003, fb], [rk - 0.003, fb], [rk - 0.003, bowlF(rk - 0.003)]);
    r = rk - 0.003;
  }
  steps(0, L.rich ? 2 : 1);
  return P;
}
// a chamfered band around the axis: r0..r1, f0..f1, chamfer c (counter-clockwise, left open on the inside)
const band = (r0, r1, f0, f1, c) => [[r0, f0], [r1 - c, f0], [r1, f0 + c], [r1, f1 - c], [r1 - c, f1], [r0, f1]];

// a flat glow disc whose brightness falls off smoothly to nothing at the edge (vertex colours; no texture, so it also builds in node)
function haloGeometry(R, segs, rings) {
  const pos = [0, 0, 0], col = [1, 1, 1], idx = [];
  for (let j = 1; j <= rings; j++) {
    const u = j / rings, k = Math.pow(1 - u, 3.2);
    for (let i = 0; i < segs; i++) { const a = i / segs * TAU; pos.push(Math.cos(a) * R * u, Math.sin(a) * R * u, 0); col.push(k, k, k); }
  }
  for (let i = 0; i < segs; i++) idx.push(0, 1 + i, 1 + (i + 1) % segs);
  for (let j = 1; j < rings; j++) {
    for (let i = 0; i < segs; i++) {
      const a = 1 + (j - 1) * segs + i, b = 1 + (j - 1) * segs + (i + 1) % segs, c = a + segs, d = b + segs;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

// ---------------------------------------------------------------------------------------------------- the build
export function buildGauntlet({ lod = 'fp', tint = 0xff8a2a, seed = 7 } = {}) {
  const L = LODS[lod] || LODS.fp, rich = L.rich;
  const mats = armourMats(tint);
  const kit = new Kit(seed);
  const toZ = m4({ r: [-PI / 2, 0, 0] });                                  // a lathe about Y -> about -Z (its y is the forward distance)
  const topM = (y) => m4({ p: [0, y, 0], r: [-PI / 2, 0, 0] });            // a plate drawn as (x, forward distance), lying flat at height y
  const sideM = (x) => m4({ p: [x, 0, 0], r: [0, PI / 2, 0] });            // a plate drawn as (forward distance, y), standing at x (right side)
  const pair = (key, geo, m, opt) => { kit.add(key, geo, m, opt); kit.add(key, geo, mir(m), opt); };
  const P = (pts, o = {}) => plate(pts, { thick: o.thick ?? 0.006, bevel: o.bevel ?? 0.0022, segs: L.bev, holes: o.holes || [], curve: L.curve });
  const cs = L.corner;
  // a cap screw at p, its axis along 'x' | '-x' | 'y' | '-y' | 'z' | '-z' or an angle in the xy plane (only where the model is looked at closely)
  const screw = (p, dir = 'y', r = 0.0032) => {
    if (!rich) return;
    const rot = typeof dir === 'number' ? [0, 0, dir - PI / 2] : { y: [0, 0, 0], x: [0, 0, -PI / 2], '-x': [0, 0, PI / 2], z: [PI / 2, 0, 0], '-z': [-PI / 2, 0, 0], '-y': [PI, 0, 0] }[dir];
    kit.add('frame', bolt(r, r * 0.9), m4({ p, r: rot }));
  };

  // ---- the dish: a turned shell with grooves for the rings, ribs on the back, a paint band round the rim held by clamps
  kit.add('steel', lathe(dishProfile(L), L.seg), toZ);
  kit.add('paint', lathe(rich ? band(0.1095, 0.1215, -0.02, 0.008, 0.0035) : [[0.1095, -0.02], [0.1215, -0.02], [0.1215, 0.008], [0.1095, 0.008]], L.seg), toZ, { wear: 'lathe' });
  for (let i = 0; i < L.clamps; i++) {
    const a = (i + 0.5) / L.clamps * TAU, c = Math.cos(a), s = Math.sin(a);
    // (cbox's thin axis is z: this block is 16 mm tangent x 30 mm radial x 22 mm deep, turned so that its long side points out from the axis)
    kit.add('frame', cbox(0.016, 0.03, 0.022, 0.0035), m4({ p: [c * 0.1225, s * 0.1225, 0.002], r: [0, 0, a - PI / 2] }), { wear: 'plate' });
    screw([c * 0.1345, s * 0.1345, 0.002], a, 0.0026);
  }
  if (rich) {
    // the mount collar and three gussets that tie the dish to it
    kit.add('steel', lathe([[0.05, -0.15], [0.065, -0.15], [0.0705, -0.1445], [0.0705, -0.1055], [0.0655, -0.1], [0.058, -0.096], [0.05, -0.096]], L.mini), toZ, { wear: 'lathe' });
    for (let i = 0; i < 3; i++) {
      const a = PI / 2 + PI / 3 + i * TAU / 3;
      kit.add('paint', P([[0.062, -0.1], [0.092, -0.045], [0.1, -0.03], [0.1, -0.102]], { thick: 0.007 }), mul(m4({ r: [0, 0, a] }), m4({ r: [-PI / 2, 0, 0] })), { wear: 'plate' });
    }
  }
  // the glowing rings, in their grooves (front) and one around the back of the dish: a low ridge each, so they show from the side too
  for (const rk of ringRadii(L)) {
    const fb = bowlF(rk + 0.003) - 0.003;
    kit.add('ring', lathe([[rk - 0.0017, fb + 0.0004], [rk, fb + 0.0032], [rk + 0.0017, fb + 0.0004]], L.seg, { crease: 80 }), toZ);
  }
  if (rich) kit.add('ring', lathe([[0.0885, -0.0508], [0.09, -0.0545], [0.0915, -0.0508]], L.seg, { crease: 80 }), toZ);
  // the hex lens at the centre: a paint frame with a hex window; the core glows behind the glass
  const hexPts = (r) => Array.from({ length: 6 }, (_, i) => [Math.cos(i / 6 * TAU) * r, Math.sin(i / 6 * TAU) * r]);
  if (rich) kit.add('steel', P(hexPts(0.029), { thick: 0.005, bevel: 0.0018, holes: [hexPts(0.0215)] }), m4({ p: [0, 0, 0.0305] }), { wear: 'plate' });
  const lensGeo = hexPlate(0.0215, 0.002, 0.0008);

  // ---- the knuckle guards: arched lames that step forward over the collar, each on a frame ring
  const lames = [{ r0: 0.0735, z0: 0.132, z1: 0.178 }, { r0: 0.0765, z0: 0.102, z1: 0.146 }, { r0: 0.083, z0: 0.07, z1: 0.112 }].slice(0, L.lames);
  for (const [k, ln] of lames.entries()) {
    const arc = 2.1 - 0.12 * k, from = PI / 2 - arc / 2;
    if (rich) kit.add('frame', lathe(band(ln.r0 - 0.002, ln.r0 + 0.001, -ln.z1 - 0.003, -ln.z0 + 0.003, 0.0006), L.shell, { from: from - 0.1, sweep: arc + 0.2, caps: true }), toZ, { wear: 'lathe' });
    kit.add('paint', lathe(band(ln.r0, ln.r0 + 0.0065, -ln.z1, -ln.z0, 0.0028), L.shell, { from, sweep: arc, caps: true }), toZ, { wear: 'lathe' });
    for (const u of [-0.5, 0, 0.5]) { const a = PI / 2 + u * (arc - 0.34); screw([Math.cos(a) * (ln.r0 + 0.0065), Math.sin(a) * (ln.r0 + 0.0065), ln.z1 - 0.01], a, 0.003); }
    kit.occlude([0, ln.r0 - 0.006, (ln.z0 + ln.z1) / 2], 0.022, 0.7);
  }

  // ---- the housing: a frame core, layered plates (on frame under-layers up close), vents, the power cell, fins, cables
  kit.add('frame', rbox(0.124, 0.1, 0.3, 0.018, L.boxSeg), m4({ p: [0, 0, 0.25] }), { wear: 'box' });
  // side plates (the right one is drawn, then mirrored): a frame under-layer, the paint plate 7 mm inside it, a vent window and an accent line
  const under = [[-0.395, -0.04], [-0.378, -0.047], [-0.14, -0.047], [-0.115, -0.03], [-0.115, 0.036], [-0.135, 0.047], [-0.385, 0.047], [-0.395, 0.037]];
  const ventHole = [[-0.34, -0.022], [-0.34, 0.022], [-0.268, 0.022], [-0.268, -0.022]];
  if (rich) pair('frame', P(under, { thick: 0.003, bevel: 0.0012 }), sideM(0.0635), { wear: 'plate' });
  pair('paint', P(inset(under, rich ? 0.007 : 0.002), { thick: 0.006, holes: rich ? [ventHole] : [] }), sideM(0.068), { wear: 'plate' });
  pair('trim', cbox(0.2, 0.0022, 0.0022, 0.0008), m4({ p: [0.0715, -0.0335, 0.25], r: [0, PI / 2, 0] }));
  if (rich) {
    // a shoulder plate laid over the front of the side plate, on its own frame plate, and a slanted accent line behind it
    const shoulder = [[-0.226, -0.034], [-0.206, -0.04], [-0.128, -0.04], [-0.12, -0.02], [-0.12, 0.031], [-0.132, 0.04], [-0.226, 0.04]];
    pair('frame', P(shoulder, { thick: 0.003, bevel: 0.0012 }), sideM(0.0725), { wear: 'plate' });
    pair('paint', P(inset(shoulder, 0.005), { thick: 0.006 }), sideM(0.0765), { wear: 'plate' });
    pair('trim', cbox(0.07, 0.0022, 0.0022, 0.0008), mul(m4({ p: [0.0745, 0.0, 0.27] }), m4({ r: [0.62, 0, 0] }), m4({ r: [0, PI / 2, 0] })));
    for (const [z, y] of [[0.14, 0.028], [0.14, -0.028], [0.21, 0.032], [0.21, -0.032]]) { screw([0.0795, y, z], 'x'); screw([-0.0795, y, z], '-x'); }
  }
  if (rich) {
    const ventM = mul(m4({ p: [0.0655, 0, 0.304] }), m4({ r: [0, PI / 2, 0] }));
    for (const m of [ventM, mir(ventM)]) kit.vent('frame', m, 0.07, 0.042, 6, { depth: 0.006 });
    pair('frame', cbox(0.074, 0.046, 0.004, 0.001), m4({ p: [0.063, 0, 0.304], r: [0, PI / 2, 0] }));
  }
  for (const [z, y] of [[0.13, 0.03], [0.13, -0.03], [0.38, 0.03], [0.38, -0.03], [0.255, 0.037], [0.255, -0.04]]) { screw([0.0715, y, z], 'x'); screw([-0.0715, y, z], '-x'); }
  // top covers: a rear one, and a middle one with the window over the power cell
  const rear = [[-0.052, -0.397], [0.052, -0.397], [0.06, -0.3], [0.046, -0.284], [-0.046, -0.284], [-0.06, -0.3]];
  if (rich) kit.add('frame', P(rear, { thick: 0.003, bevel: 0.0012 }), topM(0.0535), { wear: 'plate' });
  kit.add('paint', P(inset(rear, rich ? 0.006 : 0.002), { thick: 0.006 }), topM(0.0575), { wear: 'plate' });
  if (rich) {
    for (const x of [-0.022, 0.022]) kit.add('frame', cbox(0.004, 0.092, 0.004, 0.001), m4({ p: [x, 0.0645, 0.348], r: [PI / 2, 0, 0] }), { wear: 'plate' });
    for (let i = 0; i < 4; i++) kit.add('frame', cbox(0.036, 0.007, 0.004, 0.001), m4({ p: [0, 0.0645, 0.322 + i * 0.0135], r: [PI / 2, 0, 0] }), { wear: 'plate' });
    for (const [x, z] of [[-0.042, 0.39], [0.042, 0.39], [-0.04, 0.3], [0.04, 0.3]]) screw([x, 0.0635, z], 'y');
  }
  const mid = [[-0.047, -0.28], [0.047, -0.28], [0.047, -0.182], [0.036, -0.172], [-0.036, -0.172], [-0.047, -0.182]];
  const rr = (w, h) => rrect(w, h, Math.min(w, h) * 0.25, cs).map(([x, y]) => [x, y - 0.2225]);
  if (rich) kit.add('frame', P(mid, { thick: 0.003, bevel: 0.0012 }), topM(0.0535), { wear: 'plate' });
  kit.add('paint', P(inset(mid, rich ? 0.006 : 0.002), { thick: 0.006, holes: [rr(0.036, 0.072)] }), topM(0.0575), { wear: 'plate' });
  kit.add('frame', P(rr(0.054, 0.09), { thick: 0.004, bevel: 0.0015, holes: [rr(0.038, 0.074)] }), topM(0.0618), { wear: 'plate' });
  if (rich) kit.add('frame', cbox(0.038, 0.074, 0.004, 0.001), m4({ p: [0, 0.0475, 0.2225], r: [-PI / 2, 0, 0] }));   // the floor of the window
  const lensCell = rich ? plate(rrect(0.034, 0.07, 0.008, cs), { thick: 0.0016, bevel: 0.0006, segs: 1, curve: 2 }) : null;   // (centred: the mesh is placed over the window)
  for (const z of [0.176, 0.269]) for (const x of [-0.04, 0.04]) screw([x, 0.0645, z], 'y');
  // under the housing: a guard with vents
  if (rich) {
    kit.add('frame', rbox(0.104, 0.02, 0.22, 0.008, 1), m4({ p: [0, -0.06, 0.25] }), { wear: 'box' });
    for (let i = 0; i < 4; i++) kit.add('suit', cbox(0.07, 0.012, 0.003, 0.0008), m4({ p: [0, -0.0705, 0.2 + i * 0.03], r: [PI / 2, 0, 0] }));
  }
  // cooling fins: a bank on each shoulder, standing across the housing on a rail
  const finGeo = P([[0.052, 0.05], [0.088, 0.05], [0.092, 0.058], [0.082, 0.074], [0.052, 0.074]], { thick: 0.0032, bevel: 0.0011 });
  for (let i = 0; i < L.fins; i++) pair('fin', finGeo, m4({ p: [0, 0, 0.195 + i * (0.17 / (L.fins - 1))] }), { wear: 'plate' });
  pair('frame', cbox(0.038, 0.2, 0.008, 0.002), m4({ p: [0.068, 0.0495, 0.285], r: [PI / 2, 0, 0] }), { wear: 'plate' });
  if (rich) {
    // wrist: a ring and the rubber bellows
    kit.add('frame', lathe(band(0.05, 0.07, -0.42, -0.396, 0.004), L.mini), toZ, { wear: 'lathe' });
    const bell = [[0.05, -0.5]], ribsN = 5;
    for (let i = 0; i <= ribsN * 3; i++) { const t = i / (ribsN * 3); bell.push([0.054 + 0.0075 * (0.5 + 0.5 * Math.sin(t * ribsN * TAU - PI / 2)), -0.5 + 0.08 * t]); }
    bell.push([0.05, -0.42]);
    kit.add('suit', lathe(bell, L.mini), toZ);
  }
  // cables from the cuff to the housing front, with clamps and plugs
  const cab = (pts, r) => pair('suit', tube(pts, r, { tubular: L.tubular, radial: L.radial }), new THREE.Matrix4());
  cab([[0.03, 0.04, 0.43], [0.042, 0.066, 0.36], [0.05, 0.066, 0.3], [0.053, 0.063, 0.215], [0.052, 0.06, 0.18]], 0.0062);
  if (rich) {
    cab([[0.066, -0.015, 0.43], [0.078, -0.022, 0.37], [0.079, -0.03, 0.31], [0.076, -0.02, 0.255]], 0.0042);
    pair('frame', cbox(0.014, 0.016, 0.016, 0.003), m4({ p: [0.0505, 0.066, 0.3] }), { wear: 'plate' });
    pair('frame', cbox(0.014, 0.016, 0.016, 0.003), m4({ p: [0.053, 0.0625, 0.215] }), { wear: 'plate' });
  }
  pair('frame', cbox(0.016, 0.022, 0.016, 0.003), m4({ p: [0.052, 0.058, 0.174], r: [PI / 2, 0, 0] }), { wear: 'plate' });
  // the armoured forearm of the first person view
  if (rich) {
    const tubeR = (z) => 0.054 + (z - 0.49) * 0.024;
    kit.add('suit', lathe([[0, -0.84], [0.0645, -0.84], [0.0645, -0.8], [tubeR(0.6), -0.6], [0.054, -0.49], [0, -0.49]], L.mini, { crease: 60 }), toZ);
    for (const [z0, z1, arc] of [[0.53, 0.64, 4.0], [0.66, 0.79, 4.2]]) {
      const r0 = tubeR((z0 + z1) / 2) + 0.004, from = PI / 2 - arc / 2;
      kit.add('frame', lathe(band(r0 - 0.003, r0 + 0.0, -z1 - 0.004, -z0 + 0.004, 0.0006), L.shell, { from: from + 0.1, sweep: arc - 0.2, caps: true }), toZ, { wear: 'lathe' });
      kit.add('paint', lathe(band(r0, r0 + 0.008, -z1, -z0, 0.0035), L.shell, { from, sweep: arc, caps: true }), toZ, { wear: 'lathe' });
      for (const u of [-0.5, 0, 0.5]) { const a = PI / 2 + u * (arc - 0.8); screw([Math.cos(a) * (r0 + 0.008), Math.sin(a) * (r0 + 0.008), z1 - 0.012], a, 0.0034); }
    }
    for (const z of [0.515, 0.65, 0.81]) kit.add('frame', lathe(band(tubeR(z) - 0.002, tubeR(z) + 0.009, -z - 0.006, -z + 0.006, 0.0025), L.mini), toZ, { wear: 'lathe' });
  }
  // ---- ambient occlusion proxies: in the window, between the fins, round the collar, under the cuff
  kit.occlude([0, 0.05, 0.2225], 0.03, 0.8);
  for (const sx of [1, -1]) for (let i = 0; i < L.fins; i++) kit.occlude([sx * 0.07, 0.062, 0.195 + i * (0.17 / (L.fins - 1)) + 0.01], 0.011, 0.7);
  kit.occlude([0, 0, 0.145], 0.045, 0.5);
  kit.occlude([0, 0, 0.41], 0.05, 0.6);
  kit.occlude([0, 0, 0.034], 0.03, 0.7);

  const geos = kit.build({ aoStrength: 0.85, wear: 0.5, uvTile: 0.08 });
  const mesh = (key, mat) => { const g = geos.get(key); if (!g) return null; const m = new THREE.Mesh(g, mat); m.name = 'gauntlet:' + key; return m; };

  // ---- materials that move
  const coreMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(...lin(0x40e8d4, 3)) });
  const cellMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(...lin(0x40e8d4, 2)) });
  const glowMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(...lin(0x40e8d4, 2)), vertexColors: true, transparent: true, opacity: 0.3, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const finMat = new THREE.MeshStandardMaterial({ color: 0x3a3f45, roughness: 0.32, metalness: 0.85, vertexColors: true, emissive: new THREE.Color(0, 0, 0) });
  if (mats.frame.normalMap) { finMat.normalMap = mats.frame.normalMap; finMat.normalScale = mats.frame.normalScale.clone(); }
  // the glow follows the baked AO / edge wear (vertex colour): the bevels burn brightest, the crevices stay dark, so a hot fin is not a flat blob
  finMat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance *= pow(vColor.rgb, vec3(2.6));');
  };
  finMat.customProgramCacheKey = () => 'gauntlet-fin';

  const group = new THREE.Group();
  group.name = 'gauntlet-' + lod;
  for (const [key, mat] of [['paint', mats.paint], ['frame', mats.frame], ['steel', mats.steel], ['suit', mats.suit], ['trim', mats.trim]]) { const m = mesh(key, mat); if (m) group.add(m); }
  const rings = mesh('ring', mats.trim), fins = mesh('fin', finMat);
  group.add(rings, fins);
  // the power cell under its window: a glowing block, with a glass cover
  const cell = new THREE.Mesh(rich ? rbox(0.028, 0.012, 0.058, 0.005, 1) : cbox(0.028, 0.058, 0.012, 0.003), cellMat);
  cell.position.set(0, 0.0535, 0.2225);
  if (!rich) cell.rotation.x = PI / 2;
  cell.name = 'gauntlet:cell';
  group.add(cell);
  if (lensCell) {
    const cover = new THREE.Mesh(lensCell, mats.lens);
    cover.position.set(0, 0.0605, 0.2225);
    cover.rotation.x = -PI / 2;
    cover.renderOrder = 2;
    group.add(cover);
  }
  // the muzzle marker, the lens glass over the core, the core, the halo
  const muzzle = new THREE.Object3D();
  muzzle.name = 'gauntlet:muzzle';
  group.add(muzzle);
  const glass = rich ? new THREE.Mesh(lensGeo, mats.lens) : null;
  if (glass) { glass.position.set(0, 0, 0.0285); glass.renderOrder = 2; group.add(glass); }
  const core = new THREE.Mesh(new THREE.SphereGeometry(0.015, rich ? 16 : 8, rich ? 10 : 6), coreMat);
  core.position.set(0, 0, 0.034);
  core.name = 'gauntlet:core';
  const glow = new THREE.Mesh(haloGeometry(0.2, rich ? 40 : 20, rich ? 6 : 3), glowMat);
  glow.position.set(0, 0, -0.004);
  glow.name = 'gauntlet:glow';
  group.add(core, glow);

  // ---- the prongs: blades that curve in from the rim, each on a hinge at the rim
  const prongs = new THREE.Group();
  prongs.name = 'gauntlet:prongs';
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const bladeCurve = new THREE.CatmullRomCurve3([V(0, 0, 0.004), V(0.002, 0, -0.05), V(-0.004, 0, -0.1), V(-0.022, 0, -0.145)]);
  const tipCurve = new THREE.CatmullRomCurve3([V(-0.012, 0, -0.1), V(-0.026, 0, -0.152)]);
  const bladeLoop = rrect(0.013, 0.026, 0.0045, rich ? 2 : 1), tipLoop = rrect(0.008, 0.013, 0.003, 2);
  for (let i = 0; i < 3; i++) {
    const a = PI / 2 + i * TAU / 3;
    const pivot = new THREE.Group(), hinge = new THREE.Group();
    pivot.position.set(Math.cos(a) * 0.127, Math.sin(a) * 0.127, 0);
    pivot.rotation.z = a;
    pivot.name = 'gauntlet:prong' + i;
    pivot.add(hinge);
    pivot.userData.hinge = hinge;
    const pk = new Kit(seed + 11 + i);
    pk.add('paint', sweep(bladeLoop, bladeCurve, rich ? 9 : 4, (t) => [1 - 0.4 * t, 1 - 0.5 * t]));
    pk.add('frame', cbox(0.024, 0.026, 0.036, 0.004), m4({ p: [0, 0, 0.006], r: [PI / 2, 0, 0] }), { wear: 'plate' });
    pk.add('frame', cbox(0.014, 0.02, 0.012, 0.003), m4({ p: [-0.003, 0, -0.02], r: [PI / 2, 0, 0] }), { wear: 'plate' });
    if (rich) pk.add('trim', sweep(tipLoop, tipCurve, 3, (t) => [1 - 0.4 * t, 1 - 0.6 * t]));
    else pk.add('trim', cbox(0.009, 0.013, 0.016, 0.002), m4({ p: [-0.022, 0, -0.146], r: [PI / 2, 0, 0] }), { wear: 'plate' });
    pk.occlude([0, 0, 0.02], 0.02, 0.5);
    const pg = pk.build({ aoStrength: 0.7, wear: 0.5, uvTile: 0.08 });
    for (const [key, mat] of [['paint', mats.paint], ['frame', mats.frame], ['trim', mats.trim]]) { const g = pg.get(key); if (g) hinge.add(new THREE.Mesh(g, mat)); }
    prongs.add(pivot);
  }
  group.add(prongs);

  // ---- the orbit ring: lights on a thin ring that spins round the dish
  const orbit = new THREE.Group();
  orbit.position.z = 0.012;
  orbit.name = 'gauntlet:orbit';
  const ok = new Kit(seed + 5);
  if (rich) ok.add('frame', lathe(band(0.1385, 0.1425, -0.0015, 0.0015, 0.0008), L.seg), toZ, { wear: 'lathe' });
  for (let i = 0; i < L.lights; i++) {
    const a = i / L.lights * TAU, c = Math.cos(a) * 0.1405, s = Math.sin(a) * 0.1405;
    ok.add('trim', cbox(0.018, 0.0085, 0.0085, 0.0018), m4({ p: [c, s, 0], r: [0, 0, a + PI / 2] }), { wear: 'plate' });
    if (rich && i % 4 === 0) ok.add('frame', cbox(0.006, 0.016, 0.006, 0.0015), m4({ p: [c, s, 0], r: [0, 0, a] }), { wear: 'plate' });
  }
  const og = ok.build({ aoStrength: 0, wear: 0.4, uvTile: 0.08 });
  for (const [key, mat] of [['frame', mats.frame], ['trim', mats.trim]]) { const g = og.get(key); if (g) orbit.add(new THREE.Mesh(g, mat)); }
  group.add(orbit);

  // ---- behaviour
  const state = { spin: 0, heat: 0, open: 0, openV: 0, lock: 0 };
  const hot = new THREE.Color(), white = new THREE.Color();
  const parts = { core, glow, rings, prongs, orbit, fins, cell, muzzle };
  const open10 = THREE.MathUtils.degToRad(10);
  function update(dt, t, { charge = 0, flash = 0, quiet = false } = {}) {
    const c = clamp(charge, 0, 1);
    state.spin += dt * (1.5 + 15 * c + (flash > 0 ? 6 : 0));
    orbit.rotation.z = state.spin;
    // the core heats towards white and swells; the trim brightens from 0.7 on
    hot.setRGB(...lin(0x40e8d4, 3 + 5 * c)).lerp(white.setRGB(8, 8, 8), Math.pow(c, 3) * 0.7);
    coreMat.color.copy(hot);
    core.scale.setScalar(1 + c * 0.9 + flash * 0.8);
    mats.trim.color.setRGB(...lin(c > 0.7 ? 0xb8fff4 : 0x40e8d4, 2.2 + 2.5 * c));
    glowMat.opacity = (quiet ? 0.05 : 0.14) + 0.5 * c + 0.5 * flash;
    glow.scale.setScalar((quiet ? 0.6 : 0.75) + 0.4 * c + 0.4 * flash);
    // the prongs open up to 10 degrees with the charge; a blast slams them shut and holds them closed for 0.14 s (fire()), then a spring brings them back
    state.lock = Math.max(0, state.lock - dt);
    const target = state.lock > 0 ? -THREE.MathUtils.degToRad(2) : open10 * smooth(0.02, 0.95, c);
    state.openV += (900 * (target - state.open) - 38 * state.openV) * dt;
    state.open += state.openV * dt;
    for (const p of prongs.children) p.userData.hinge.rotation.y = -state.open;
    // the fins glow with the heat of a blast and cool over 0.6 s; a little glow while charging
    state.heat = Math.max(0, state.heat - dt / 0.6);
    const h = Math.pow(state.heat, 1.3);
    finMat.emissive.setRGB(...lin(0x40e8d4, 1)).lerp(white.setRGB(...lin(0xff5a14, 1)), smooth(0.02, 0.4, h)).lerp(white.setRGB(1, 0.85, 0.6), h * h);
    finMat.emissiveIntensity = 4 * h + 0.5 * c * c;
    // the cell pulses faster as it fills
    const pulse = 0.5 + 0.5 * Math.sin(t * TAU * (0.7 + 3.2 * c));
    cellMat.color.setRGB(...lin(c > 0.8 ? 0xb8fff4 : 0x40e8d4, 1.4 + 0.9 * pulse + 1.6 * c));
    // a micro-shake that grows with the charge (smooth sines, no randomness)
    const sh = c * c;
    group.position.set(Math.sin(t * 61.3) * 0.0011 * sh + Math.sin(t * 37.1) * 0.0007 * sh, Math.sin(t * 53.7 + 1) * 0.0011 * sh, Math.sin(t * 43.9 + 2) * 0.0008 * sh);
    group.rotation.set(Math.sin(t * 47.3) * 0.0022 * sh, Math.sin(t * 59.9 + 3) * 0.0022 * sh, Math.sin(t * 41.3 + 4) * 0.004 * sh);
  }
  function fire() {
    state.heat = 1;
    state.lock = 0.14;
    state.openV = -(state.open + THREE.MathUtils.degToRad(4)) * 70;   // slam shut, a little past closed
  }

  let tris = 0;
  group.traverse((o) => { if (o.isMesh) tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; });
  const own = [coreMat, cellMat, glowMat, finMat];
  function dispose() {
    group.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
    mats.dispose();
    for (const m of own) m.dispose();
  }
  return { group, parts, mats: { ...mats, core: coreMat, cell: cellMat, glow: glowMat, fin: finMat }, tris, lod, update, fire, dispose };
}
