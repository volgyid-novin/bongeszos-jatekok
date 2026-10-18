// The third-person view (V key, "Nézet" setting): render/chasecam.js (the camera math against the sim's collision world), Gfx.frame() driven
// without WebGL (an object made from Gfx.prototype with stub parts: the camera, the player's own figure, the gun), the settings field and the
// V key in input.js. The Gorge cases need the local model (pajzsugras/local-models/gorge.glb, git-ignored) and pass without checking anything
// when it is not there; everything else runs against the robot figures.
import fs from 'node:fs';
import * as THREE from 'three';
import { test, assert, setGlobal } from './harness.mjs';
import { memStorage } from './support.mjs';
import { World } from '../sim/world.js';
import { makeCmd } from '../sim/pmove.js';
import { FLAG, EYE, RUN } from '../sim/const.js';
import { mulberry32, aimOf } from '../sim/math.js';
import { MAPS } from '../maps/index.js';
import { course } from './synth.mjs';
import { testArena } from './probes.js';
import { Input } from '../input.js';
import { ChaseCam, CHASE } from '../render/chasecam.js';
import { Gfx, SELF } from '../render/renderer.js';
import { Figures } from '../render/figures.js';

const GLB = new URL('../local-models/gorge.glb', import.meta.url);
const HAVE = fs.existsSync(GLB);
const DEG = Math.PI / 180;
const HALF = [CHASE.BOX, CHASE.BOX, CHASE.BOX];
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const finite = (v) => v.every(Number.isFinite);
const arena = (fn) => new World(testArena(fn).build());   // a flat floor (y = 0, 600 m wide), no ceiling, plus whatever fn builds
const standAt = (w, pos, yawDeg = 0) => { w.teleport(pos, yawDeg * DEG); return w.ps; };
const headOf = (w) => [w.ps.pos[0], w.ps.pos[1] + EYE, w.ps.pos[2]];

// ================================================================ the camera math
test('chasecam: in the open the camera sits 3.5 m behind the head along the look direction and 0.35 m above that line; turning moves it round the head', () => {
  const w = arena();
  standAt(w, [0, 0, 0]);
  const cam = new ChaseCam(), head = headOf(w);
  let c = cam.update(0.016, w.cw, head, 0, 0);
  assert.ok(near(c.pos[0], 0) && near(c.pos[1], head[1] + CHASE.RISE) && near(c.pos[2], CHASE.DIST), 'yaw 0 looks along -Z: the camera is at +Z: ' + c.pos);
  assert.ok(near(c.dist, Math.hypot(CHASE.DIST, CHASE.RISE)) && near(c.want, c.dist) && c.hit === false && c.hidden === false);
  c = new ChaseCam().update(0.016, w.cw, head, 90 * DEG, 0);
  assert.ok(near(c.pos[0], CHASE.DIST) && near(c.pos[2], 0), 'yaw +90 deg looks along -X: the camera is at +X: ' + c.pos);
  c = new ChaseCam().update(0.016, w.cw, head, 0, -45 * DEG);   // looking down: the camera goes up and back
  const a = aimOf(0, -45 * DEG);
  assert.ok(near(c.pos[1], head[1] - a[1] * CHASE.DIST + CHASE.RISE) && near(c.pos[2], -a[2] * CHASE.DIST) && c.pos[1] > head[1] + 2, 'camera above: ' + c.pos);
  // the camera looks the way the player looks: the head is on the line of sight, RISE below the middle of the picture
  const dir = new THREE.Vector3(...aimOf(30 * DEG, 20 * DEG));
  const cc = new ChaseCam().update(0.016, w.cw, head, 30 * DEG, 20 * DEG);
  const toHead = new THREE.Vector3(head[0] - cc.pos[0], head[1] - cc.pos[1], head[2] - cc.pos[2]);
  assert.ok(toHead.normalize().dot(dir) > 0.99, 'the head is in front of the camera');
});

test('chasecam: a wall behind the player pulls the camera in at once, in front of the wall by the box and the margin; the camera never ends inside geometry', () => {
  const w = arena((b) => b.box([-20, 0, 2], [20, 30, 4], { mat: 'wall' }));   // a wall face at z = 2, 2 m behind the player
  standAt(w, [0, 0, 0]);
  const cam = new ChaseCam(), head = headOf(w);
  cam.update(0.016, w.cw, [0, head[1], -30], 0, 0);   // (starts far from the wall: the full distance)
  assert.ok(near(cam.dist, Math.hypot(CHASE.DIST, CHASE.RISE)));
  const c = cam.update(0.016, w.cw, head, 0, 0);
  assert.ok(c.hit, 'the wall holds the camera');
  assert.ok(c.dist < 2 && c.dist > 1.2, 'pulled in to about 2 m - box - margin: ' + c.dist);
  assert.ok(c.pos[2] <= 2 - CHASE.BOX - CHASE.MARGIN * 0.99 + 1e-3, 'z ' + c.pos[2] + ' keeps box + margin from the wall at z = 2');
  assert.equal(w.cw.testSolid(c.pos, HALF), false, 'the camera box is in free space');
  assert.ok(c.dist <= c.limit + 1e-9 && c.limit < c.want);
  // a wall right behind (0.1 m): the camera is at the head, the figure is hidden
  const w2 = arena((b) => b.box([-20, 0, 0.55], [20, 30, 3], { mat: 'wall' }));
  standAt(w2, [0, 0, 0]);
  const c2 = new ChaseCam().update(0.016, w2.cw, headOf(w2), 0, 0);
  assert.ok(c2.dist < CHASE.HIDE_IN && c2.hidden === true && c2.hit, 'dist ' + c2.dist);
  assert.equal(w2.cw.testSolid(c2.pos, HALF), false);
  // a low ceiling above: looking down the camera would go through it
  const w3 = arena((b) => b.box([-20, 3, -20], [20, 5, 20], { mat: 'wall' }));
  standAt(w3, [0, 0, 0]);
  const c3 = new ChaseCam().update(0.016, w3.cw, headOf(w3), 0, -60 * DEG);
  assert.ok(c3.hit && c3.pos[1] < 3 - CHASE.BOX, 'under the ceiling: y ' + c3.pos[1]);
  // looking up from the floor: the camera would be under the floor
  const c4 = new ChaseCam().update(0.016, w.cw, head, 0, 80 * DEG);
  assert.ok(c4.hit && c4.pos[1] >= CHASE.BOX - 1e-6, 'above the floor: y ' + c4.pos[1]);
  assert.equal(w.cw.testSolid(c4.pos, HALF), false);
});

test('chasecam: the pull-in is instant, the pull-out eases (never past the free distance, never a jump), a teleport snaps', () => {
  const w = arena((b) => b.box([-20, 0, 2], [20, 30, 4], { mat: 'wall' }));
  const cam = new ChaseCam();
  const dt = 1 / 60;
  let c = cam.update(dt, w.cw, [0, EYE, 0], 0, 0);   // held in by the wall
  const held = c.dist;
  c = cam.update(dt, w.cw, [0, EYE, -10], 0, 0);   // a step of 10 m is a teleport: no easing from the old distance
  assert.ok(near(c.dist, c.want), 'snapped to the full distance');
  // walk toward the wall: the free distance shrinks every frame and the camera follows it exactly
  let prev = c.dist;
  for (let z = -10; z < 0.3; z += 0.05) {
    c = cam.update(dt, w.cw, [0, EYE, z], 0, 0);
    assert.ok(c.dist <= c.limit + 1e-9 && c.dist <= prev + 1e-9, 'pull-in: dist ' + c.dist + ' limit ' + c.limit);
    prev = c.dist;
  }
  assert.ok(near(c.dist, c.limit) && c.dist < held + 0.5);
  // away from the wall by turning the head: the camera eases out over about half a second
  c = cam.update(dt, w.cw, [0, EYE, 0], 180 * DEG, 0);   // looking at the wall: the way back is free
  assert.ok(c.limit > c.dist + 1, 'free now: limit ' + c.limit + ' dist ' + c.dist);
  const first = c.dist;
  assert.ok(first < c.limit - 1, 'one frame later the camera is still near the wall: ' + first);
  let steps = 0;
  for (; steps < 600 && c.dist < c.limit; steps++) {
    const before = c.dist;
    c = cam.update(dt, w.cw, [0, EYE, 0], 180 * DEG, 0);
    assert.ok(c.dist >= before && c.dist - before <= CHASE.OUT_RATE * dt * c.want + 1e-9 && c.dist <= c.limit + 1e-9, 'no jump: ' + before + ' -> ' + c.dist);
  }
  assert.ok(steps > 20 && steps < 300, 'eased out in ' + steps + ' frames');
  assert.ok(near(c.dist, c.want, 1e-3));
  // dt = 0 or garbage does not move the camera out
  const a = cam.update(0, w.cw, [0, EYE, 0], 0, 0).dist;   // pulled in again by the wall, then ...
  const b = cam.update(NaN, w.cw, [0, EYE, 0], 180 * DEG, 0).dist;
  assert.ok(Number.isFinite(a) && Number.isFinite(b) && b >= a - 1e-9 && b <= a + 1e-9, 'a NaN dt eases nothing: ' + a + ' ' + b);
});

test('chasecam: the figure is hidden below 0.8 m and shown again only past 1.0 m (no flicker between), and a head inside a wall gives no camera', () => {
  const stub = (f, startsolid = false) => ({ traceBox: () => ({ fraction: f, startsolid }) });
  const cam = new ChaseCam(), head = [0, 1.6, 0];
  const want = Math.hypot(CHASE.DIST, CHASE.RISE);
  const at = (metres, dt = 0.016) => cam.update(dt, stub((metres + CHASE.MARGIN) / want), head, 0, 0);   // (the free distance after the margin = metres; dt 1 s: the camera is there)
  assert.equal(at(3).hidden, false);
  assert.equal(at(0.9).hidden, false, '0.9 m: still shown');
  assert.equal(at(0.5).hidden, true);
  assert.equal(at(0.9, 1).hidden, true, '0.9 m on the way out: still hidden (hysteresis)');
  assert.equal(at(0.99, 1).hidden, true);
  assert.equal(at(1.01, 1).hidden, false);
  assert.equal(at(0.9).hidden, false, 'and shown on the way in again until 0.8');
  const c = cam.update(0.016, stub(1, true), head, 0, 0);
  assert.ok(c.dist === 0 && c.hidden && c.pos.every((v, i) => near(v, head[i])), 'startsolid: the camera is the head');
});

test('chasecam: NaN / Infinity in the head, yaw, pitch or dt never reach the camera position; the last good position is kept', () => {
  const w = arena();
  const cam = new ChaseCam();
  const head = headOf(w);
  const good = cam.update(0.016, w.cw, head, 0.7, -0.3).pos.slice();
  for (const [h, yaw, pitch] of [[[NaN, 1, 1], 0, 0], [head, NaN, 0], [head, 0, NaN], [head, Infinity, 0], [head, 0, -Infinity], [[1, Infinity, 1], 0, 0]]) {
    const c = cam.update(0.016, w.cw, h, yaw, pitch);
    assert.ok(finite(c.pos) && Number.isFinite(c.dist) && Number.isFinite(c.limit), 'finite for ' + [h, yaw, pitch]);
    assert.deepEqual(c.pos, good, 'unchanged');
  }
  const fresh = new ChaseCam().update(0.016, w.cw, [NaN, 0, 0], 0, 0);
  assert.ok(finite(fresh.pos), 'nothing good yet: still finite');
  // a pitch beyond +-90 deg, huge yaw values, dt of 5 s: all fine
  const odd = new ChaseCam();
  for (const [yaw, pitch, dt] of [[1e6, 2.5, 5], [-1e6, -2.5, 0.0001], [7, Math.PI / 2, 0.016], [0, -Math.PI / 2, 0.016]]) {
    const c = odd.update(dt, w.cw, head, yaw, pitch);
    assert.ok(finite(c.pos) && c.dist >= 0 && c.dist <= c.want + 1e-9, 'odd inputs ' + [yaw, pitch, dt]);
  }
});

test('chasecam: on the built-in maps and the synthetic course (walls, a tunnel, pillars), from the start, every checkpoint and a few spots in the tunnel, in 25 random directions the camera is in free space, on a free line from the head, and finite', () => {
  const rng = mulberry32(2026);
  let n = 0, held = 0;
  const course_ = course();
  for (const def of [...MAPS.list, { meta: course_.meta, build: () => course_ }]) {
    const map = def.build();
    const w = new World(map);
    const spots = [map.start.pos, ...map.checkpoints.map((c) => c.spawn), ...(map === course_ ? [[0, 0, -55], [4.6, 0, -60], [-4.6, 0, -50], [0, 0, -25]] : [])];
    for (const p of spots) {
      w.teleport(p, 0);
      const head = headOf(w);
      for (let i = 0; i < 25; i++) {
        const yaw = (rng() - 0.5) * 12, pitch = (rng() - 0.5) * 2 * (89 * DEG);
        const c = new ChaseCam().update(0.016, w.cw, head, yaw, pitch);
        n++;
        assert.ok(finite(c.pos) && c.dist >= 0 && c.dist <= c.want + 1e-9 && c.dist <= c.limit + 1e-9, `${def.meta.id}: bad camera ${JSON.stringify(c)}`);
        assert.equal(w.cw.testSolid(c.pos, HALF), false, `${def.meta.id}: the camera box is inside geometry at ${c.pos} (head ${head}, yaw ${yaw}, pitch ${pitch})`);
        assert.equal(w.cw.traceBox(head, c.pos, HALF).fraction, 1, `${def.meta.id}: something is between the head and the camera`);
        if (c.hit) held++;
      }
    }
  }
  assert.ok(n > 150 && held > 20 && held < n, `${n} cameras, ${held} held in by a wall`);
});

// ================================================================ Gfx.frame without WebGL
const stubBrowser = () => {
  setGlobal('document', { createElement: () => ({ width: 0, height: 0, style: {}, getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }) }) });
  setGlobal('self', globalThis);
  setGlobal('createImageBitmap', async () => ({ width: 8, height: 8, close() {} }));
  setGlobal('fetch', async (url) => (String(url).includes('local-models/gorge.glb') && HAVE ? new Response(fs.readFileSync(GLB), { status: 200, headers: { 'content-type': 'model/gltf-binary' } }) : new Response('no', { status: 404 })));
};

// a Gfx without a renderer: the real frame() / cameraInfo() on stub parts (the camera, the effects, the sky, the gun)
async function fakeGfx() {
  stubBrowser();
  const G = await import('../render/gorge.js');
  G.resetGorge();
  const gfx = Object.create(Gfx.prototype);
  const scene = new THREE.Scene();
  Object.assign(gfx, {
    scene, camera: new THREE.PerspectiveCamera(70, 16 / 9, 0.06, 2400), aspect: 16 / 9, level: null, retired: [], tmp: { pos: [0, 0, 0], yaw: 0, pitch: 0 }, ppos: new THREE.Vector3(),
    fx: { cam: { y: 0, pitch: 0, roll: 0, fov: 0 }, update() {}, setScale() {} }, sky: { update() {} },
    viewmodel: { last: null, update(dt, t, st) { this.last = st; } }, renderer: { domElement: { height: 720 } },
    chase: new ChaseCam(), third: false, eye: [0, 0, 0], figures: new Figures(scene),
    updateFov() {}, draw() {}, menuCamera() {},
  });
  gfx.camera.rotation.order = 'YXZ';
  await G.loadGorge();
  return gfx;
}
const ME = { name: 'Én', color: 0xff8a2a };
const frameOf = (gfx, w, o = {}) => gfx.frame({ dt: 1 / 60, t: 0, world: w, alpha: 1, look: { yaw: 0, pitch: 0 }, mode: 'play', speed: 0, vm: {}, view: 'kulso', me: ME, ...o });
const self = (gfx) => gfx.figures.map.get(SELF);

test('frame: the third-person view puts the camera behind the head, shows the player\'s own figure, hides the gun; the first-person view, the menu and the editor show none of it', async () => {
  const gfx = await fakeGfx();
  const w = arena();
  standAt(w, [3, 0, -4]);
  frameOf(gfx, w);
  let i = gfx.cameraInfo();
  assert.equal(i.view, 'kulso');
  assert.ok(near(gfx.camera.position.x, 3, 0.01) && near(gfx.camera.position.z, -4 + CHASE.DIST, 0.01) && near(gfx.camera.position.y, EYE + CHASE.RISE, 0.01), 'camera ' + gfx.camera.position.toArray());
  assert.ok(near(i.dist, Math.hypot(CHASE.DIST, CHASE.RISE), 0.01) && i.hit === false && i.hidden === false && i.self === true);
  assert.equal(gfx.viewmodel.last.hidden, true, 'no gun in third person');
  assert.ok(self(gfx) && self(gfx).root.visible, 'the own figure is drawn');
  const f = gfx.figures.info().find((x) => x.id === SELF);
  assert.deepEqual([f.ghost, f.solid, f.infer], [false, false, false]);
  assert.ok(f.pos.every((v, k) => near(v, w.ps.pos[k], 1e-3)), 'on the player\'s feet: ' + f.pos);
  assert.equal(self(gfx).tag, undefined, 'no name tag over your own head');
  assert.equal(self(gfx).trailMesh.visible, false, 'no trail');
  // the first person view: the camera is at the eye, the figure is gone, the gun is back
  frameOf(gfx, w, { view: 'belso' });
  assert.ok(near(gfx.camera.position.x, 3, 0.01) && near(gfx.camera.position.y, EYE, 0.01) && near(gfx.camera.position.z, -4, 0.01), 'eye ' + gfx.camera.position.toArray());
  assert.equal(gfx.figures.has(SELF), false);
  assert.equal(gfx.viewmodel.last.hidden, false);
  assert.equal(gfx.cameraInfo().view, 'belso');
  // ... and back; the menu and the editor never show it, whatever the setting says
  frameOf(gfx, w);
  assert.equal(gfx.figures.has(SELF), true);
  frameOf(gfx, w, { mode: 'menu' });
  assert.equal(gfx.figures.has(SELF), false, 'menu');
  frameOf(gfx, w);
  frameOf(gfx, w, { mode: 'editor', cam: { pos: [0, 5, 5], yaw: 0, pitch: -0.3 } });
  assert.equal(gfx.figures.has(SELF), false, 'editor');
  assert.ok(near(gfx.camera.position.y, 5), 'the editor camera is the editor\'s');
  assert.equal(gfx.viewmodel.last.hidden, true);
  frameOf(gfx, null);
  assert.equal(gfx.figures.has(SELF), false, 'no world');
  gfx.figures.dispose();
});

test('frame: the camera follows the sim\'s interpolated position, yaw and pitch; the figure faces the look direction and shows the real flags', async () => {
  const gfx = await fakeGfx();
  const w = arena();
  standAt(w, [0, 0, 0]);
  const c = makeCmd();
  c.fwd = 1;
  for (let t = 0; t < 60; t++) w.step(c);
  const mid = w.lerp(0.5);
  frameOf(gfx, w, { alpha: 0.5, look: { yaw: 40 * DEG, pitch: -20 * DEG } });
  const a = aimOf(40 * DEG, -20 * DEG);
  const eye = [mid.pos[0], mid.pos[1] + EYE, mid.pos[2]];
  const want = [eye[0] - a[0] * CHASE.DIST, eye[1] - a[1] * CHASE.DIST + CHASE.RISE, eye[2] - a[2] * CHASE.DIST];
  assert.ok(gfx.camera.position.toArray().every((v, k) => near(v, want[k], 1e-4)), 'camera ' + gfx.camera.position.toArray() + ' want ' + want);
  assert.ok(near(gfx.camera.rotation.y, 40 * DEG) && near(gfx.camera.rotation.x, -20 * DEG), 'looks along the sim yaw / pitch');
  const f = self(gfx);
  assert.ok(near(f.pos.x, mid.pos[0], 1e-6) && near(f.pos.z, mid.pos[2], 1e-6), 'the figure is at the interpolated feet');
  assert.ok(near(f.root.rotation.y, 40 * DEG), 'and faces the look yaw');
  assert.equal(gfx.figures.info().find((x) => x.id === SELF).flags, w.playerFlags());
  assert.ok((w.playerFlags() & FLAG.GROUND) !== 0);
  // shield charging: the flag reaches the figure (its aura)
  c.fire = true;
  for (let t = 0; t < 40; t++) w.step(c);
  assert.ok((w.playerFlags() & FLAG.CHARGE) !== 0, 'the sim is charging');
  for (let k = 0; k < 20; k++) frameOf(gfx, w);
  assert.equal(self(gfx).aura.visible, true, 'the shield aura shows');
  gfx.figures.dispose();
});

test('frame: with a wall right behind the player the camera is held in and the figure is hidden, then shows again as the camera eases out; a map change or the first person view leaves nothing behind', async () => {
  const gfx = await fakeGfx();
  const w = arena((b) => b.box([-20, 0, 0.55], [20, 30, 3], { mat: 'wall' }));
  standAt(w, [0, 0, 0]);
  frameOf(gfx, w);
  let i = gfx.cameraInfo();
  assert.ok(i.hit && i.hidden && i.dist < CHASE.HIDE_IN, JSON.stringify(i));
  assert.equal(self(gfx).root.visible, false, 'hidden with the camera at the head');
  assert.ok(gfx.camera.position.z < 0.55 - CHASE.BOX, 'in front of the wall');
  // turn round: the way back is free, the camera eases out and the figure comes back past 1 m
  let frames = 0, shown = -1, last = i.dist;
  for (; frames < 120; frames++) {
    frameOf(gfx, w, { look: { yaw: Math.PI, pitch: 0 } });
    i = gfx.cameraInfo();
    assert.ok(i.dist >= last - 1e-9, 'the camera only moves out');
    last = i.dist;
    if (shown < 0 && self(gfx).root.visible) shown = frames;
  }
  assert.ok(shown >= 1 && shown < 30, 'the figure came back after ' + shown + ' frames');
  assert.ok(near(i.dist, i.want, 0.01) && !i.hit && !i.hidden);
  // a new map clears the figures: the next frame brings the own figure back, with the camera snapped (no easing from the old distance)
  gfx.figures.clear();
  frameOf(gfx, w, { look: { yaw: Math.PI, pitch: 0 } });
  assert.ok(self(gfx) && self(gfx).root.visible);
  frameOf(gfx, w, { view: 'belso' });
  frameOf(gfx, w, { look: { yaw: 0, pitch: 0 } });   // (switched on again, facing the wall: held in from the very first frame)
  assert.ok(gfx.cameraInfo().hit && gfx.cameraInfo().dist < CHASE.HIDE_IN);
  gfx.figures.dispose();
});

test('frame: the own figure runs, jumps and shows the Gorge when the local model is there (the robot otherwise)', async () => {
  const gfx = await fakeGfx();
  const w = arena();
  standAt(w, [0, 0, 0]);
  const c = makeCmd();
  c.fwd = 1;
  const run = (ticks, each) => { for (let t = 0; t < ticks; t++) { w.step(c); if (t % 2 === 1) { frameOf(gfx, w); if (each) each(); } } };
  run(120);
  let f = gfx.figures.info().find((x) => x.id === SELF);
  assert.equal(f.model, HAVE ? 'gorge' : 'robot');
  if (HAVE) {
    assert.equal(f.clip, 'RunF');
    assert.equal(f.translucent, false, 'the own figure is opaque');
    assert.ok(Math.abs(f.timeScale - w.ps.speed / RUN) < 0.2, 'playback follows the speed: ' + f.timeScale);
    c.jump = true;
    const clips = new Set();
    run(60, () => clips.add(gfx.figures.info().find((x) => x.id === SELF).clip));
    assert.ok([...clips].some((n) => /^Jump/.test(n)), 'a jump clip played: ' + [...clips].join(', '));
  } else {
    assert.equal(self(gfx).root.visible, true);
  }
  gfx.figures.dispose();
});

// ================================================================ the V key and the setting
const keyEvent = (code, o = {}) => ({ code, repeat: false, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, timeStamp: 1000, target: { tagName: 'CANVAS' }, preventDefault() {}, ...o });

test('input: V toggles the view once per press while playing - not on key repeat, not with Ctrl / Alt / Meta, not in a text field, not while the input is off (the editor), and it is no game key', () => {
  let n = 0;
  const inp = new Input({}, { sens: 1, doubleTap: true }, { onView: () => n++ });
  inp.enabled = true;
  inp.onKeyDown(keyEvent('KeyV')); inp.onKeyUp(keyEvent('KeyV'));
  assert.equal(n, 1);
  inp.onKeyDown(keyEvent('KeyV')); inp.onKeyUp(keyEvent('KeyV'));
  assert.equal(n, 2, 'each press');
  inp.onKeyDown(keyEvent('KeyV')); inp.onKeyDown(keyEvent('KeyV', { repeat: true })); inp.onKeyDown(keyEvent('KeyV', { repeat: true })); inp.onKeyUp(keyEvent('KeyV'));
  assert.equal(n, 3, 'holding V is one press');
  for (const mod of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }]) { inp.onKeyDown(keyEvent('KeyV', mod)); inp.onKeyUp(keyEvent('KeyV')); }
  assert.equal(n, 3, 'Ctrl+V (paste), Alt+V and Meta+V are not the view key');
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) { inp.onKeyDown(keyEvent('KeyV', { target: { tagName } })); inp.onKeyUp(keyEvent('KeyV')); }
  inp.onKeyDown(keyEvent('KeyV', { target: { tagName: 'DIV', isContentEditable: true } })); inp.onKeyUp(keyEvent('KeyV'));
  assert.equal(n, 3, 'typing a V into a field is not a view change');
  inp.onKeyDown(keyEvent('KeyV', { target: { tagName: 'DIV' } })); inp.onKeyUp(keyEvent('KeyV'));
  assert.equal(n, 4);
  inp.enabled = false;
  inp.onKeyDown(keyEvent('KeyV')); inp.onKeyUp(keyEvent('KeyV'));
  assert.equal(n, 4, 'the editor (input off) uses V for the select tool');
  inp.enabled = true;
  const cmd = inp.fillCmd(makeCmd());
  assert.deepEqual([cmd.fwd, cmd.side, cmd.jump, cmd.fire, cmd.dodge, cmd.respawn, cmd.restart], [0, 0, false, false, 0, false, false], 'V moves nothing');
  // no hook, no problem
  const bare = new Input({}, { sens: 1 });
  bare.enabled = true;
  bare.onKeyDown(keyEvent('KeyV'));
});

let storeN = 0;
const freshStore = () => import('../store.js?view=' + (++storeN));

test('settings: the view is "belso" by default, "kulso" is kept, anything else falls back, and the choice survives a reload', async () => {
  const ls = memStorage();
  setGlobal('localStorage', ls);
  const { store, sanitizeSettings, DEFAULTS, VIEWS, VIEW_LABEL } = await freshStore();
  assert.equal(DEFAULTS.view, 'belso');
  assert.deepEqual(VIEWS, ['belso', 'kulso']);
  assert.deepEqual(VIEWS.map((v) => VIEW_LABEL[v]), ['Belső', 'Külső']);
  assert.equal(store.loadSettings().view, 'belso', 'nothing stored: first person');
  for (const bad of ['', 'third', 'KULSO', null, 5, {}, ['kulso']]) assert.equal(sanitizeSettings({ view: bad }).view, 'belso', JSON.stringify(bad));
  assert.equal(sanitizeSettings({ view: 'kulso' }).view, 'kulso');
  assert.equal(sanitizeSettings({}).view, 'belso', 'an old save without the field');
  assert.equal(store.saveSettings({ ...store.loadSettings(), view: 'kulso' }), true);
  assert.equal((await freshStore()).store.loadSettings().view, 'kulso', 'a new page load');
  assert.equal(JSON.parse(ls.getItem('pajzsugras:settings')).view, 'kulso');
  store.saveSettings({ ...store.loadSettings(), view: 'belso' });
  assert.equal((await freshStore()).store.loadSettings().view, 'belso');
  assert.deepEqual(Object.keys(sanitizeSettings({ view: 'kulso' })).sort(), Object.keys(DEFAULTS).sort(), 'the sanitised settings have exactly the default fields');
});
