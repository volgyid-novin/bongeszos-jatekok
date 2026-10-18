// Small synthetic maps for the tests. The eight hand-made maps with their proof routes are gone (the built-in maps are exports of the editor and
// have no route), so what used to run on them runs here: a COURSE with a proof route that uses every movement technique the animation brain and the
// camera care about (wall dodge, jump + double jump, dodge, diagonal jump, a tunnel with a ceiling, pillars), checkpoints and a finish.
//
//   courseDef(opts) -> defineMap(...)      { id, authorTime }: the author time is the route's tick count / 120 (courseAuthorTime())
//   course()        -> the built map (memoised)
//   runCourse(map = course()) -> { world, rr, ticks, ok }   the proof route played to the end
import { defineMap } from '../sim/builder.js';
import { World } from '../sim/world.js';
import { RouteRunner, R } from '../sim/bot.js';
import { makeCmd } from '../sim/pmove.js';
import { TICK, DODGE } from '../sim/const.js';
import { testArena } from './probes.js';

let authorTime = 0;
export const courseAuthorTime = () => authorTime || (authorTime = Math.ceil((runCourse(buildCourse('probe-course', 1)).ticks / TICK) * 1000) / 1000);

function buildCourse(id, author) {
  return defineMap({ id, name: 'Próbapálya', diff: 'kikepzes', order: 1, blurb: '', authorTime: author }, (b) => {
    b.start([0, 0, 2.4], 0);
    b.box([-30, -1, -130], [30, 0, 10], { mat: 'floor' });
    b.box([-10, 0, 3], [10, 20, 4], { mat: 'wall' });                                  // behind the start: the wall dodge at the very beginning
    b.checkpoint([-6, 0, -42], [6, 4, -40]);
    // a tunnel: side walls and a ceiling (the chase camera is squeezed in it)
    b.box([-5.5, 0, -70], [-5, 4, -48], { mat: 'wall' });
    b.box([5, 0, -70], [5.5, 4, -48], { mat: 'wall' });
    b.box([-5.5, 4, -70], [5.5, 4.5, -48], { mat: 'wall' });
    for (const x of [-4, 4]) b.prism([x, 3, -25], 0.6, 6, { sides: 8, mat: 'wall' });   // two pillars beside the route
    b.finish([-6, 0, -104], [6, 5, -100]);
    b.route([
      R.jump({ to: [0, 0, -12], air: [R.wallDodge('F', { at: 0.15 })] }),
      R.run(0, -20),
      R.jump({ to: [0, 0, -34], dj: 'apex' }),
      R.run(0, -44),
      R.dodge('F', { to: [0, 0, -56] }),
      R.run(0, -74),
      R.dodge('F', { to: [0, 0, -100] }), R.run(0, -80),
      R.dodge('F', { to: [0, 0, -100] }), R.run(0, -84),
      R.diagJump('L', { to: [-207.3, -84 - 139.8], approach: 0 }),
      R.run(0, -102),
    ]);
  });
}

let def = null, map = null;
export function courseDef() { return def || (def = buildCourse('probe-course', courseAuthorTime())); }
export function course() { return map || (map = courseDef().build()); }

export function runCourse(d = course()) {
  const m = d.build ? d.build() : d;
  const world = new World(m), rr = new RouteRunner(world, m.route);
  const res = rr.run();
  return { world, rr, ticks: res.ticks, ok: res.ok, res, map: m };
}

// A flat arena (the probe arena) with a wall right behind the start and a SCRIPTED run (no bot: the view never turns, W is held, a human's keys) with
// every kind of dodge: a wall dodge, then ground dodges forward / left / right / back, a diagonal jump (left) and a forward dodge again. For the checks
// of the Gorge's dodge clips against the sim. -> { w, tick() }  (tick() steps one tick and returns false when the script is over; the same shape as
// RouteRunner, whose tick() the tests drive)
export function dodgeRoute() {
  const map = testArena((b) => { b.box([-10, 0, 0.55], [10, 20, 2], { mat: 'wall' }); }, 'dodge-course').build();
  const w = new World(map);
  w.teleport([0, 0, 0], 0);
  const c = makeCmd();
  const at = { 0: { jump: true }, 12: { dodge: DODGE.F }, 150: { dodge: DODGE.F }, 300: { dodge: DODGE.L }, 450: { dodge: DODGE.R }, 600: { dodge: DODGE.B },
    750: { dodge: DODGE.L, jump: true }, 960: { dodge: DODGE.F } };
  let t = 0;
  return {
    w,
    tick() {
      if (t >= 1100) return false;
      Object.assign(c, { fwd: t < 8 ? 0 : 1, jump: false, dodge: 0, ...at[t] });
      w.step(c);
      t++;
      return true;
    },
  };
}

// A flat arena and a route of real jumps (jump + double jump, a diagonal jump, a dodge jump): long flights, the kind of air time the Gorge's
// airborne inference from recorded positions (gorge-anim.js, infer) has to find. -> { map, steps }
export function jumpRoute() {
  const map = testArena(null, 'jump-course').build();
  const steps = [
    R.run(0, -20), R.jump({ to: [0, 0, -40], dj: 'apex' }),
    R.run(0, -50), R.jump({ to: [0, 0, -70], dj: 'apex' }),
    R.run(0, -80), R.diagJump('L', { to: [-207.3, -80 - 139.8], approach: 0 }),
    R.run(0, -125), R.dodgeJump('F', { to: [0, 0, -200] }),
    R.run(0, -150), R.jump({ to: [0, 0, -170], dj: 'apex' }),
  ];
  return { map, steps };
}
