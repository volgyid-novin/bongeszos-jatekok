// Map builder DSL. A map file is
//
//   export default defineMap(meta, (b) => { ...b.box(...) etc... });
//
// defineMap(meta, fn) -> { meta, build() }. The registry (maps/index.js) reads meta eagerly; build() runs fn once
// (memoised) and returns the static map data (see World / world.js for what it contains). Coordinates: Y up, metres,
// feet positions for anything a player stands on. Angles in the DSL are DEGREES; yaw 0 faces -Z, +90 faces -X
// (three.js camera.rotation.y). Colours are 0xRRGGBB numbers.
//
// meta = {
//   id, name (Hungarian), diff: 'kikepzes'|'konnyu'|'kozepes'|'nehez'|'mester'|'nincs' (none: no difficulty chip), order (1..n), blurb,
//   authorTime,   // seconds, = ticks of the nominal route / 120 (the test runner prints the right value); 0 / missing: no proof route, no medals
//   custom,       // true for the player's own editor maps (editor/convert.js): no finish / checkpoint / brush / route required
//   exported,     // true for a built-in map that was exported from the editor (maps/*.js, npm run add-map): same relaxations, but it is a normal
//                 // map in JÁTÉK / rooms / the global leaderboard (without a proof route there are no medals)
//   theme: {
//     sky: { type: 'gradient'|'nebula'|'clouds'|'stars', top, horizon, bottom, sunDir: [x,y,z], sunColor, stars: 0..1, clouds: 0..1 },
//     fog: { color, near, far }, hemi: { sky, ground, intensity }, sun: { color, intensity },
//     palette: { floor, wall, trim, accent, glow, danger }, bloom: 0..2, ambient: 'facility'|'forge'|'wind'|'cave'|'neon'|'lava'|'storm'|'space'
//   } }
//
// Builder methods (b):
//   b.start(pos, yaw)                       spawn (feet) and heading
//   b.mat(name, { base, color, trim, emissive })   material; bases: panel grate concrete metal rust rock crystal neon glass hazard stripe
//        built-ins from the palette: floor (panel), wall (panel), walldodge (stripe panel: the visual promise "wall dodge here"
//        for the easy maps; in the sim EVERY near-vertical surface can be wall-dodged), trim (neon)
//   b.box(min, max, { mat, yaw })           axis aligned box from two corners (yaw about its centre)
//   b.block(c, size, { mat, yaw })          box by centre + size
//   b.ramp(c, size, { mat, yaw })           wedge in a box of that size; rises toward local +z (walk +z at yaw 0); walkable up to 45°
//   b.prism(c, r, h, { sides = 8, mat, yaw })   regular prism (pillar), c = centre, r = circumradius, h = height
//   b.hull(points, { mat })                 convex hull of >= 4 points (free shapes)
//   b.group({ at, yaw }, fn)                local frame: yaw 0|90|180|270 only; nests; everything inside is transformed
//   b.mover(id, { path, speed, wait, mode, phase }, fn)   brushes (and deco) made inside fn move together.
//        path: offsets from the authored position, first waypoint = [0,0,0] is implicit: path: [[0,6,0]] goes 6 m up.
//        speed m/s (2), wait s at every waypoint (1), mode 'pingpong' (default) | 'loop', phase s (0). Translation only.
//        Rule: no crushing geometry (a mover that pushes a player into a wall respawns them).
//   b.pad(pos, { target, apex })            jump pad: throws you to target (feet) on a parabola peaking at apex (absolute y)
//   b.checkpoint(min, max, { spawn, yaw, label })   trigger box; spawn = feet position of the respawn; in definition order
//   b.finish(min, max)                      trigger box, only counts after all checkpoints
//   b.kill(min, max, kind)                  'void' | 'lava' | 'laser'; a void plane 15 m under the lowest brush is automatic
//   b.deco(kind, { pos, size, yaw, color, ... })   no collision. kinds: pipe beam cable crate pillar fan rock crystal screen arch ring beacon;
//        pos = centre of the bounding box, size [sx,sy,sz] (defaults per kind), pipe/beam run along local x, pillar/beacon/crystal
//        along y, arch/ring/screen/fan stand in the local xy plane facing +z; cable takes { to: [x,y,z] } instead of size
//   b.decoBrush(shape, ...args, { mat })    any brush shape without collision: shape 'box'|'block'|'ramp'|'prism'|'hull', then
//        that shape's arguments
//   b.sign(pos, yaw, { title, keys, text }) hologram sign, yaw = heading of the player reading it (it faces back at them)
//   b.glyph(pos, kind, yaw)                 floor glyph: 'shield' | 'walldodge' | 'arrow' | 'dj'; yaw = heading it reads/points to
//   b.marker(pos, text)                     floating text (distance markers)
//   b.light(pos, color, intensity, range)   point light hint
//   b.route(steps)                          the proof route (R.* steps from bot.js), the author time comes from it
//   b.skip(name, steps)                     an alternative complete route (a shortcut), must also finish
//   b.gate(name, { start, goal, solve, deny, spread, margin, combo })   a COMBO GATE: a gap that only a combination of techniques crosses
//        (test data like b.route: never hashed, never rendered; positions are transformed by the current group like checkpoints).
//        The test runner (test/gates.mjs) proves it twice: (1) `solve` (R.* steps, from the start) reaches the goal, nominal and with
//        the sloppy jitter (Kiképzés/Könnyű/Közepes 5/5 seeds, Nehéz 4/5, Mester 2/5); (2) a DENY SEARCH of ~1100-2200 single-technique runs
//        (below) must not reach it. A gate whose goal a single technique can reach fails the suite.
//          start   { pos: [x, y, z], yaw } (feet, yaw degrees) or { cp: i } = that checkpoint's spawn and yaw (put a checkpoint
//                  before every gate: the player respawns there, and the solve begins there)
//          goal    [min, max] box the feet must stand in (grounded, end of a tick) before dying. Make it cover the WHOLE far ledge
//                  (a landing on the ledge outside the box is reported as a survivable landing), from the floor top - 0.1 up to
//                  about + 2.5 m, so a fly-through counts as reaching it
//          solve   the steps of the intended combo, e.g. [R.run(x, z), R.diagJump('L', { to, approach, air: [R.wallDodge('F')] })];
//                  the checker stops as soon as the feet stand in the goal, so the steps may go on (the proof route reuses them)
//          deny    'all' (default) | an array of families that must NOT cross: 'jump' 'dj' 'dodge' 'dodgeJump' 'diag' 'wallDodge'
//                  'shield' 'wallBoost' (a combo of two of them is what the gate is for, so name the single ones you deny)
//          spread  lateral spread (m) of the deny takeoffs around the start line (default 1.0; a wide start platform wants 3)
//          margin  m; a denied run that ever gets this close (3D, feet to the goal box, in the air or on landing) fails the gate
//                  (default 0.6: a gate must be 0.6 m beyond the closest single technique, so a slightly better single would not do)
//          combo   the human name of the combo, printed in the report ('átlós ugrás + falról kiugrás')
//        The deny search (what to design against): from the start area, 9 run-up headings toward the goal +-{0,10,20,35,56} degrees (the
//        shield family 13: also +-46 / +-66) x 3 lateral offsets (-spread, 0, +spread), launching at the last moment: the first edge (a few
//        ticks before the hull has no ground left; the run-up is played ahead to find that tick, so a lane that ends in a wall counts), where a
//        wall stops the run, or where a kill volume (a laser curtain) is about to touch the hull (with one near the lane also 2 m before it). Steering = the bot's air steering toward the
//        goal centre (it aims the landing point at it and never brakes), starting `steer` s after takeoff; or plain "W looking at the goal".
//        Families (a double jump after the main technique belongs to it: shield + dj is one technique, so is jump + wall dodge + dj):
//        jump (+ a standing one) | dj: double jump at 0.15 s / apex / 0.6 s / 0.9 s / 1.25 s, steering from 0 or 0.4 s, also released a few
//        ticks before the lip | dodge F, L, R | dodgeJump: forward dodge + double jump at the apex or 0.45 s | diag: side dodge + Space (same
//        tick or 12 ticks later) from lanes 46 / 56 / 66 degrees off the goal heading | wallDodge: jump + wall dodge F, L, R at the wall /
//        0.3 s / 0.6 s, each also followed by a double jump (at the apex, 0.3 s after the wall dodge, 0.9 s into the flight) | shield: the run-up
//        along the heading with the gun charging a fixed run-up distance before the release, the view flicking to the aim at the release
//        (charge 0 .. 1, pitch -89 / -65 / -45 / -25, aimed away from the goal or along the run heading, double jump none / apex / 0.9 s /
//        1.25 s, the release at the lip of the centre column or a few ticks before the hull's lip), a coarse set on every lane and a dense
//        charge x pitch x double jump x aim grid on the straight lanes and the three lanes that came closest, standing: the full product |
//        wallBoost: full charge, jump, release at a wall aimed back / left / right, pitch -20 / -50, 0.15 s or 0.45 s into the flight, or on
//        the takeoff tick itself, or followed by a double jump (apex / 0.9 s). The wall families only continue where the first variant found
//        a wall. Refinement: the closest runs (a few per family) are nudged one parameter at a time (heading, offset, times, charge, pitch,
//        lead, double jump time, steering mode), for up to three rounds; they must stay out of the margin as well.
//        A run ends on landing, death, 6 s in the air, or when it is hopeless (> 6 m under the goal and falling). A search is only valid
//        if the technique really happened (classified by the events: jump, dodge, walldodge, dj, blast that hit): a denied family that
//        happened in fewer than 25 % of its runs fails the gate (the wall families: at least the takeoff must have happened).
//        Gates must sit over lava / void: a survivable landing elsewhere is only a warning, but then the search proves nothing about chains.
//        Geometry denies better than distance: a ceiling, a wall that blocks the line of sight, a narrow lane, a kill curtain.
//        Output (npm run test:pj, section (c); --gate=<text> selects gates, with -v every family's closest run; --nodeny skips (2)):
//          kapu "name" (combo): megoldás ok, sloppy 5/5, tiltás 1700 + 240 finomító futás 3.1 s [jump 28/28, dj 200/214, ... wallDodge 76/153
//          (felszállt 153), shield 599/690], legközelebb: diag R +56° 2.1 m
//        [family executed / placed runs; "nem indítható" = start points off the ground or inside a kill volume] "legközelebb" = the closest
//        executed denied run (family, variant, lane heading degrees relative to the goal heading, lateral offset, its 3D distance to the goal
//        box): the gap must be >= margin beyond it. A failing gate prints the run that crossed (or came too close) with its landing point (or
//        the closest point), and the family whose search was not valid. Section (d) has the column kapuk: gates ok / gates, and the smallest
//        closest distance.
//        Measured reaches on flat ground (horizontal takeoff -> landing / peak height above the takeoff; run-up speed 8.8 m/s; the numbers
//        of the probe table in test/probes.js): jump 6.2 / 1.22; jump + double jump 11.15 / 2.62; dodge 5.7; dodge + double jump 13.9 / 1.87;
//        DIAGONAL JUMP 16.65 / 1.87 (15.9 m/s; Space 3 ticks before the dodge 16.1, 12 ticks after it 14.4 = no diagonal jump); wall dodge
//        after a jump 8.3 / 1.44; wall boost 14.8; standing full shield jump 9.30 high (+ double jump 10.70; a tap 5.61 with the Space); RUNNING shield jump 27.8 / 6.73
//        (+ double jump 35.6 / 8.13); diagonal jump + wall dodge forward along a wall 20.5 / 2.25 (the wall dodge sets 13.2 m/s along its direction); diagonal jump + wall boost (wall 0.9 m
//        beside the flight, full shield held, aimed at the wall, pitch -40, released 0.62 s into the flight) 27.5 / 3.37; dodge jump into a
//        wall 10.5 m ahead + wall dodge sideways 9.2 m sideways; running shield jump + double jump into a wall 24 m ahead + wall dodge
//        sideways 14.4 m sideways (7.25 high); full vertical shield jump at a wall + wall dodge away at the apex + double jump 22.5 / 11.17.
//        Design notes (learned the hard way): (a) a dodge keeps the sideways part of the run velocity, so a run-up lane that is angled to the
//        goal makes even a plain dodge jump toward the goal fast (15 m/s): the diag and dodgeJump families both find it, size lanes with
//        the checker, not with the table; (b) measure a gap from the corner of the lane's end face that is nearest the goal; (c) a straight
//        wall can be slid along into an opening beside it (jump + wall dodge at the opening: the wallDodge family), so put openings far
//        down the wall; (d) a wall dodge needs a wall within 0.64 m of the hull (behind the dodge or beside it): for a close `to`, give R.wallDodge a world yaw (a number) as its
//        direction, 'L' / 'R' flip when `to` is under you; (e) the bot's steering stops pulling when the flight moves away from `to`,
//        but a `to` that is behind the wall dodge still looks odd: pass [x, y, z] when the landing floor is not the first one below.
import { SIM_VER } from './const.js';
import { makeBrush } from './brush.js';
import { rotY, cyrb53 } from './math.js';

const DIFFS = ['kikepzes', 'konnyu', 'kozepes', 'nehez', 'mester', 'nincs'];
export const GATE_FAMILIES = ['jump', 'dj', 'dodge', 'dodgeJump', 'diag', 'wallDodge', 'shield', 'wallBoost'];
const BASES = ['panel', 'grate', 'concrete', 'metal', 'rust', 'rock', 'crystal', 'neon', 'glass', 'hazard', 'stripe'];
const DECO_KINDS = ['pipe', 'beam', 'cable', 'crate', 'pillar', 'fan', 'rock', 'crystal', 'screen', 'arch', 'ring', 'beacon'];
const GLYPHS = ['shield', 'walldodge', 'arrow', 'dj'];
const KILLS = ['void', 'lava', 'laser'];
const r3 = (v) => Math.round(v * 1000) / 1000;
const r2 = (v) => Math.round(v * 100) / 100;

export function normalizeTheme(t = {}) {
  const sky = { type: 'gradient', top: 0x4a7fc0, horizon: 0xbcd4e8, bottom: 0x8aa0b0, sunDir: [0.4, 0.8, 0.3], sunColor: 0xfff2d8, stars: 0, clouds: 0, ...t.sky };
  const palette = { floor: 0x9aa6ad, wall: 0x6f7c85, trim: 0xffa040, accent: 0xff8a2a, glow: 0x40d0e0, danger: 0xff4040, ...t.palette };
  return {
    sky, palette,
    fog: { color: sky.horizon, near: 60, far: 400, ...t.fog },
    hemi: { sky: sky.top, ground: 0x445058, intensity: 0.9, ...t.hemi },
    sun: { color: sky.sunColor, intensity: 1.6, ...t.sun },
    bloom: t.bloom ?? 0.6,
    ambient: t.ambient || 'facility',
  };
}

export function defineMap(meta, fn) {
  if (!meta || typeof meta.id !== 'string') throw new Error('defineMap: meta.id missing');
  if (!DIFFS.includes(meta.diff)) throw new Error(`map ${meta.id}: bad diff ${meta.diff}`);
  for (const k of ['name', 'blurb']) if (typeof meta[k] !== 'string') throw new Error(`map ${meta.id}: meta.${k} missing`);
  if (!(meta.order >= 1) || !Number.isFinite(meta.authorTime)) throw new Error(`map ${meta.id}: meta.order / authorTime missing`);
  const m = { ...meta, theme: normalizeTheme(meta.theme) };
  let built = null;
  return { meta: m, build() { return built || (built = buildMap(m, fn)); } };
}

class Builder {
  constructor(meta) {
    this.meta = meta;
    this.tf = [{ at: [0, 0, 0], yaw: 0 }];
    this.map = {
      meta, theme: meta.theme, mapHash: '', materials: {}, brushes: [], movers: [], decoBrushes: [], deco: [], checkpoints: [], finish: null,
      kills: [], pads: [], start: null, signs: [], glyphs: [], markers: [], lights: [], route: null, skips: [], gates: [], bounds: null,
    };
    this.cur = null;     // the mover being built
    this.hash = [];      // canonical hash inputs
    const p = meta.theme.palette;
    this.mat('floor', { base: 'panel', color: p.floor, trim: p.trim });
    this.mat('wall', { base: 'panel', color: p.wall, trim: p.trim });
    this.mat('walldodge', { base: 'stripe', color: p.wall, trim: p.accent, emissive: p.accent });
    this.mat('trim', { base: 'neon', color: p.trim, emissive: p.trim });
  }
  get T() { return this.tf[this.tf.length - 1]; }
  P(p) { const q = rotY(p, this.T.yaw), a = this.T.at; return [q[0] + a[0], q[1] + a[1], q[2] + a[2]]; }
  box3(min, max) {   // transformed axis aligned box (group yaw is a multiple of 90)
    const a = this.P(min), c = this.P(max);
    return { min: [Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.min(a[2], c[2])], max: [Math.max(a[0], c[0]), Math.max(a[1], c[1]), Math.max(a[2], c[2])] };
  }
  check(cond, msg) { if (!cond) throw new Error(`map ${this.meta.id}: ${msg}`); }
  vec(v, what) { this.check(Array.isArray(v) && v.length === 3 && v.every(Number.isFinite), `${what} must be [x, y, z]`); return v; }

  start(pos, yaw = 0) { this.map.start = { pos: this.P(this.vec(pos, 'start')), yaw: yaw + this.T.yaw }; return this; }
  mat(name, o = {}) {
    this.check(!o.base || BASES.includes(o.base), `material ${name}: bad base ${o.base}`);
    this.map.materials[name] = { base: 'panel', color: 0x888888, trim: 0xffffff, emissive: 0, ...this.map.materials[name], ...o };
    return this;
  }

  // ---- shapes (descriptors in world space) ----
  shapeBox(min, max, o) { this.vec(min, 'box min'); this.vec(max, 'box max'); return this.shapeBlock([(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2], [max[0] - min[0], max[1] - min[1], max[2] - min[2]], o); }
  shapeBlock(c, size, o = {}) { this.vec(c, 'block centre'); this.vec(size, 'block size'); return { kind: 'block', c: this.P(c), size: size.slice(), yaw: (o.yaw || 0) + this.T.yaw }; }
  shapeRamp(c, size, o = {}) { this.vec(c, 'ramp centre'); this.vec(size, 'ramp size'); return { kind: 'ramp', c: this.P(c), size: size.slice(), yaw: (o.yaw || 0) + this.T.yaw }; }
  shapePrism(c, r, h, o = {}) { this.vec(c, 'prism centre'); return { kind: 'prism', c: this.P(c), r, h, sides: o.sides || 8, yaw: (o.yaw || 0) + this.T.yaw }; }
  shapeHull(points) { this.check(Array.isArray(points) && points.length >= 4, 'hull needs >= 4 points'); return { kind: 'hull', points: points.map((p) => this.P(this.vec(p, 'hull point'))) }; }
  shapeOf(kind, args) {
    const last = args[args.length - 1];
    const o = last && typeof last === 'object' && !Array.isArray(last) ? last : {};
    switch (kind) {
      case 'box': return [this.shapeBox(args[0], args[1], o), o];
      case 'block': return [this.shapeBlock(args[0], args[1], o), o];
      case 'ramp': return [this.shapeRamp(args[0], args[1], o), o];
      case 'prism': return [this.shapePrism(args[0], args[1], args[2], o), o];
      case 'hull': return [this.shapeHull(args[0]), o];
      default: throw new Error(`map ${this.meta.id}: unknown shape ${kind}`);
    }
  }
  solid(kind, args) {
    const [shape, o] = this.shapeOf(kind, args);
    let brush;
    try { brush = makeBrush(shape); } catch (e) { throw new Error(`map ${this.meta.id}: bad ${kind} brush #${this.map.brushes.length} (${e.message})`); }
    brush.mat = o.mat || 'floor';
    brush.id = this.map.brushes.length;
    brush.mover = this.cur ? this.cur.id : null;
    brush.shape = shape;
    this.map.brushes.push(brush);
    if (this.cur) this.cur.brushes.push(brush.id);
    this.hash.push(['b', brush.mover, shapeKey(shape)]);
    return brush.id;
  }
  box(...a) { return this.solid('box', a); }
  block(...a) { return this.solid('block', a); }
  ramp(...a) { return this.solid('ramp', a); }
  prism(...a) { return this.solid('prism', a); }
  hull(...a) { return this.solid('hull', a); }

  decoBrush(kind, ...args) {
    const [shape, o] = this.shapeOf(kind, args);
    const brush = makeBrush(shape);
    brush.mat = o.mat || 'wall';
    brush.mover = this.cur ? this.cur.id : null;
    this.map.decoBrushes.push(brush);
    if (this.cur) this.cur.decoBrushes.push(this.map.decoBrushes.length - 1);
    return this;
  }

  group(o, fn) {
    const yaw = o.yaw || 0;
    this.check(yaw % 90 === 0, 'group yaw must be a multiple of 90');
    this.tf.push({ at: this.P(o.at || [0, 0, 0]), yaw: this.T.yaw + yaw });
    try { fn(this); } finally { this.tf.pop(); }
    return this;
  }

  mover(id, o, fn) {
    this.check(!this.cur, 'movers cannot nest');
    this.check(!this.map.movers.some((m) => m.id === id), `duplicate mover ${id}`);
    this.check(Array.isArray(o.path) && o.path.length >= 1, `mover ${id}: path needs at least one waypoint`);
    const yaw = this.T.yaw;
    const path = [[0, 0, 0], ...o.path.map((p) => rotY(this.vec(p, 'mover waypoint'), yaw))];
    const m = {
      id, index: this.map.movers.length, brushes: [], decoBrushes: [], deco: [], path, speed: o.speed ?? 2, wait: o.wait ?? 1,
      mode: o.mode === 'loop' ? 'loop' : 'pingpong', phase: o.phase ?? 0,
    };
    this.check(m.speed > 0, `mover ${id}: speed must be > 0`);
    this.map.movers.push(m);
    this.cur = m;
    try { fn(this); } finally { this.cur = null; }
    this.check(m.brushes.length > 0, `mover ${id} has no brushes`);
    this.hash.push(['m', id, m.path.map((p) => p.map(r3)), r3(m.speed), r3(m.wait), m.mode, r3(m.phase)]);
    return this;
  }

  pad(pos, o) {
    this.vec(pos, 'pad pos'); this.vec(o.target, 'pad target');
    const p = this.P(pos), target = this.P(o.target);
    this.check(o.apex > Math.max(p[1], target[1]) + 0.3, 'pad apex must be above both ends');
    const pad = { pos: p, target, apex: o.apex, min: [p[0] - 0.9, p[1] - 0.1, p[2] - 0.9], max: [p[0] + 0.9, p[1] + 0.6, p[2] + 0.9] };
    this.map.pads.push(pad);
    this.hash.push(['p', p.map(r3), target.map(r3), r3(o.apex)]);
    return this;
  }
  checkpoint(min, max, o = {}) {
    const bx = this.box3(this.vec(min, 'cp min'), this.vec(max, 'cp max'));
    const sp = o.spawn ? this.P(this.vec(o.spawn, 'cp spawn')) : [(bx.min[0] + bx.max[0]) / 2, bx.min[1], (bx.min[2] + bx.max[2]) / 2];
    const i = this.map.checkpoints.length;
    this.map.checkpoints.push({ i, min: bx.min, max: bx.max, spawn: sp, yaw: (o.yaw || 0) + this.T.yaw, label: o.label || `CP ${i + 1}` });
    this.hash.push(['c', bx.min.map(r3), bx.max.map(r3), sp.map(r3)]);
    return this;
  }
  finish(min, max) {
    this.check(!this.map.finish, 'only one finish');
    const bx = this.box3(this.vec(min, 'finish min'), this.vec(max, 'finish max'));
    this.map.finish = { min: bx.min, max: bx.max };
    this.hash.push(['f', bx.min.map(r3), bx.max.map(r3)]);
    return this;
  }
  kill(min, max, kind = 'void') {
    this.check(KILLS.includes(kind), `bad kill kind ${kind}`);
    const bx = this.box3(this.vec(min, 'kill min'), this.vec(max, 'kill max'));
    this.map.kills.push({ min: bx.min, max: bx.max, kind });
    this.hash.push(['k', bx.min.map(r3), bx.max.map(r3)]);
    return this;
  }

  // ---- cosmetics (never collide, never hashed) ----
  deco(kind, o = {}) {
    this.check(DECO_KINDS.includes(kind), `bad deco kind ${kind}`);
    const d = { ...o, kind, pos: this.P(this.vec(o.pos, 'deco pos')), yaw: (o.yaw || 0) + this.T.yaw, mover: this.cur ? this.cur.id : null };
    if (o.to) d.to = this.P(this.vec(o.to, 'deco to'));
    this.map.deco.push(d);
    if (this.cur) this.cur.deco.push(this.map.deco.length - 1);
    return this;
  }
  sign(pos, yaw, o = {}) { this.map.signs.push({ pos: this.P(this.vec(pos, 'sign pos')), yaw: (yaw || 0) + this.T.yaw, title: o.title || '', keys: o.keys || '', text: o.text || '' }); return this; }
  glyph(pos, kind, yaw = 0) {
    this.check(GLYPHS.includes(kind), `bad glyph ${kind}`);
    this.map.glyphs.push({ pos: this.P(this.vec(pos, 'glyph pos')), kind, yaw: yaw + this.T.yaw });
    return this;
  }
  marker(pos, text) { this.map.markers.push({ pos: this.P(this.vec(pos, 'marker pos')), text: String(text) }); return this; }
  light(pos, color = 0xffffff, intensity = 1, range = 10) { this.map.lights.push({ pos: this.P(this.vec(pos, 'light pos')), color, intensity, range }); return this; }

  route(steps) { this.map.route = steps; return this; }
  skip(name, steps) { this.map.skips.push({ name, steps }); return this; }

  // a combo gate (test data, see the header): { start: { pos, yaw } | { cp }, goal: [min, max], solve, deny, spread, margin, combo }
  gate(name, o = {}) {
    this.check(typeof name === 'string' && name, 'gate needs a name');
    const what = `gate "${name}"`;
    this.check(Array.isArray(o.goal) && o.goal.length === 2, `${what}: goal must be [min, max]`);
    const goal = this.box3(this.vec(o.goal[0], `${what} goal min`), this.vec(o.goal[1], `${what} goal max`));
    this.check(goal.min.every((v, i) => v < goal.max[i]), `${what}: the goal box is empty`);
    this.check(o.start && (Number.isInteger(o.start.cp) || Array.isArray(o.start.pos)), `${what}: start must be { pos, yaw } or { cp: index }`);
    const start = Number.isInteger(o.start.cp) ? { cp: o.start.cp } : { pos: this.P(this.vec(o.start.pos, `${what} start`)), yaw: (o.start.yaw || 0) + this.T.yaw };
    this.check(Array.isArray(o.solve) && o.solve.length > 0, `${what}: solve must be a non-empty list of route steps`);
    const deny = o.deny === undefined || o.deny === 'all' ? 'all' : o.deny;
    this.check(deny === 'all' || (Array.isArray(deny) && deny.length > 0 && deny.every((f) => GATE_FAMILIES.includes(f))), `${what}: deny must be 'all' or a list of ${GATE_FAMILIES.join(' ')}`);
    this.map.gates.push({ name, start, goal, solve: o.solve, deny, spread: o.spread ?? 1.0, margin: o.margin ?? 0.6, combo: o.combo || '' });
    return this;
  }
}

function shapeKey(s) {
  const v = (a) => a.map(r3);
  switch (s.kind) {
    case 'block': case 'ramp': return [s.kind, v(s.c), v(s.size), r2(s.yaw)];
    case 'prism': return ['prism', v(s.c), r3(s.r), r3(s.h), s.sides, r2(s.yaw)];
    default: return ['hull', s.points.map(v)];
  }
}

function buildMap(meta, fn) {
  const b = new Builder(meta);
  fn(b);
  const m = b.map;
  b.check(m.start, 'no b.start()');
  // meta.custom (the in-game editor's maps) and meta.exported (built-in maps made in the editor): half-built maps are fine while they
  // are being drawn, so no finish, no checkpoint, no brush and no proof route are required. Everything else is checked as for the others.
  if (!meta.custom && !meta.exported) {
    b.check(m.finish, 'no b.finish()');
    b.check(m.checkpoints.length >= 1, 'needs at least one checkpoint');
    b.check(m.brushes.length > 0, 'no brushes');
    b.check(Array.isArray(m.route) && m.route.length > 0, 'no b.route()');
  }
  for (const g of m.gates) {   // { cp: i } starts become the checkpoint's spawn and yaw
    if (g.start.cp !== undefined) {
      const cp = m.checkpoints[g.start.cp];
      b.check(cp, `gate "${g.name}": checkpoint ${g.start.cp} does not exist`);
      g.start = { cp: g.start.cp, pos: cp.spawn.slice(), yaw: cp.yaw };
    }
  }
  for (const br of m.brushes.concat(m.decoBrushes)) b.check(m.materials[br.mat], `unknown material ${br.mat}`);
  // bounds + the automatic void plane
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const br of m.brushes) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], br.min[a]); max[a] = Math.max(max[a], br.max[a]); }
  if (!m.brushes.length) for (let a = 0; a < 3; a++) { min[a] = m.start.pos[a] - 8; max[a] = m.start.pos[a] + 8; }   // custom, no brushes: the area round the start
  m.bounds = { min, max };
  m.kills.push({ min: [min[0] - 300, min[1] - 400, min[2] - 300], max: [max[0] + 300, min[1] - 15, max[2] + 300], kind: 'void', auto: true });
  m.mapHash = cyrb53(JSON.stringify([SIM_VER, [m.start.pos.map(r3), r2(m.start.yaw)], b.hash]));
  return m;
}
