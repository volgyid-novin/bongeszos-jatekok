// Edge cases of the v2 round (columbo): the third-person view with the real sim in the loop (toggling V in the air / on a respawn, the own
// figure's animation against the sim's events at 60 and 144 Hz, a respawn close to where you stood, the camera along the proof routes of
// all eight maps), the race (the own figure is never a peer), the stored view setting, the repainted-skin override (any PNG size, survives
// figure rebuilds and map changes), the wall-dodge double jump through the main.js frame loop at 144 Hz, the shield button re-pressed
// inside one frame, and the falling animation (a walk-off goes straight to the held Mid pose, a jump shows the Takeoff, a double jump
// returns to the held Mid).
// Cases named BUG: assert the wanted behaviour and FAIL until the bug is fixed (the report names the code).
// The Gorge cases need the local model (pajzsugras/local-models/gorge.glb, git-ignored) and pass without checking anything when it is not
// there. The real gorge-body.png / gorge-head.png of the player are never read: every fetch is a stub.
import fs from 'node:fs';
import * as THREE from 'three';
import { test, assert, setGlobal } from './harness.mjs';
import * as TM from './trystero-mock.mjs';
import { memStorage, installClock, installDom, fakeMaps, DIFF_LABEL } from './support.mjs';
import { World } from '../sim/world.js';
import { RouteRunner } from '../sim/bot.js';
import { makeCmd } from '../sim/pmove.js';
import { FLAG, EYE, DODGE, TICK } from '../sim/const.js';
import { testArena } from './probes.js';
import { course, dodgeRoute } from './synth.mjs';
import { Input } from '../input.js';
import { ChaseCam, CHASE } from '../render/chasecam.js';
import { Gfx, SELF } from '../render/renderer.js';
import { Figures } from '../render/figures.js';
import { AnimBrain } from '../render/gorge-anim.js';

const { initRace } = await import('../race.js');

const GLB = new URL('../local-models/gorge.glb', import.meta.url);
const HAVE = fs.existsSync(GLB);
const GLB_URL = './local-models/gorge.glb';
const DEG = Math.PI / 180;
const HALF = [CHASE.BOX, CHASE.BOX, CHASE.BOX];
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const finite = (v) => v.every(Number.isFinite);
const arena = (fn) => new World(testArena(fn).build());
const WALL = (b) => b.box([-40, 0, -12], [40, 40, -10], { mat: 'wall' });   // a wall face at z = -10; the start (0, 0, 0) is 10 m from it
const ME = { name: 'Én', color: 0xff8a2a };

// ================================================================ a Gfx without WebGL (as in third-person-tests.mjs) and a main.js-like frame loop
const stubBrowser = (files = {}) => {
  setGlobal('document', { createElement: () => ({ width: 0, height: 0, style: {}, getContext: () => new Proxy({}, { get: (t, k) => (k === 'measureText' ? () => ({ width: 40 }) : () => {}), set: () => true }) }) });
  setGlobal('self', globalThis);
  setGlobal('createImageBitmap', async () => ({ width: 8, height: 8, close() {} }));
  setGlobal('fetch', async (url) => {
    const f = files[String(url).split('/').pop()];
    if (f) return f();
    return String(url).includes('local-models/gorge.glb') && HAVE ? new Response(fs.readFileSync(GLB), { status: 200, headers: { 'content-type': 'model/gltf-binary' } }) : new Response('no', { status: 404 });
  });
};

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
const self = (gfx) => gfx.figures.map.get(SELF);
const selfInfo = (gfx) => gfx.figures.info().find((x) => x.id === SELF);

// What main.js frameBody does: every display frame adds 1/hz to an accumulator, the sim steps at 120 Hz while it holds a tick, the frame is drawn
// with alpha = the rest. script(tick, cmd) edits the cmd of each tick (jump / dodge / respawn are reset before every call: they are edges).
function driver(gfx, w, { hz = 60, view = 'kulso' } = {}) {
  const S = { gfx, w, hz, view, acc: 0, tick: 0, frame: 0, cmd: makeCmd(), frames: [], events: [] };
  S.run = (n, script = null, stop = null) => {
    for (let i = 0; i < n; i++) {
      S.acc += 1 / hz;
      while (S.acc >= 1 / TICK - 1e-9) {
        S.acc -= 1 / TICK;
        S.cmd.dodge = 0; S.cmd.jump = false; S.cmd.respawn = false;
        if (script) script(S.tick, S.cmd);
        w.step(S.cmd);
        for (const e of w.takeEvents()) if (e.type !== 'clockStart') S.events.push({ tick: S.tick, type: e.type, time: (S.tick + 1) / TICK, frame: S.frame, ev: e });
        S.tick++;
      }
      const alpha = Math.max(0, Math.min(1, S.acc * TICK));
      gfx.frame({ dt: 1 / hz, t: S.frame / hz, world: w, alpha, look: { yaw: S.cmd.yaw, pitch: S.cmd.pitch }, mode: 'play', speed: w.ps.speed, vm: {}, view: S.view, me: ME });
      const f = selfInfo(gfx);
      const p = w.lerp(alpha);
      S.frames.push({ i: S.frame, time: (S.frame + 1) / hz, tick: S.tick, clip: f && f.brain ? f.brain.clip : null, rig: f ? f.clip : null, f, flags: w.playerFlags(), air: !w.ps.grounded, lerp: p.pos.slice() });
      S.frame++;
      if (stop && stop(S)) break;
    }
    return S;
  };
  return S;
}
const fam = (c) => (!c ? null : /^Idle/.test(c) ? 'idle' : /^Run/.test(c) ? 'run' : /_Takeoff$/.test(c) ? 'takeoff' : /_Mid$/.test(c) ? 'mid' : /_Land$/.test(c) ? 'land' : /^WallDodge/.test(c) ? 'walldodge' : /^Dodge/.test(c) ? 'dodge' : /^DoubleJump/.test(c) ? 'dj' : c);
const familiesOf = (frames) => frames.map((f) => fam(f.clip)).filter((x, i, a) => x !== a[i - 1]);
const inOrder = (seq, want) => { let k = 0; for (const x of seq) if (x === want[k]) k++; return k === want.length; };
const clipsOf = (frames) => frames.map((f) => f.clip).filter((x, i, a) => x !== a[i - 1]);

// ================================================================ third person with the sim in the loop
test('third person: V switched on in mid-air / off and on again / on the tick of a respawn / with the look straight up or down - the figure and the camera are right at once and nothing is left behind', async () => {
  const gfx = await fakeGfx();
  const w = arena();
  w.teleport([0, 0, 0], 0);
  const d = driver(gfx, w, { view: 'belso' });
  d.run(10);
  const base = gfx.scene.children.length;
  const jt = d.tick + 2;
  d.run(40, (t, c) => { c.fwd = 1; if (t === jt) c.jump = true; }, (s) => s.tick > jt + 20);
  assert.ok(!w.ps.grounded && w.ps.pos[1] > 0.3, 'setup: in the air at ' + w.ps.pos[1]);
  // 1. switched on in mid-air: the camera behind the head, the figure in the air state of the sim
  d.view = 'kulso';
  d.run(1);
  assert.ok(self(gfx) && self(gfx).root.visible, 'the own figure is there at once');
  assert.equal(d.frames.at(-1).f.flags, w.playerFlags());
  assert.equal(d.frames.at(-1).f.flags & FLAG.GROUND, 0);
  assert.ok(finite(gfx.camera.position.toArray()) && gfx.cameraInfo().self && gfx.cameraInfo().view === 'kulso');
  d.run(5);   // (the animation brain waits 50 ms off the ground before it believes in a jump)
  if (HAVE) assert.ok(/^Jump\w*_(Takeoff|Mid)$/.test(d.frames.at(-1).clip), 'the air pose, not a ground clip: ' + d.frames.at(-1).clip);
  // 2. off and on again six times in the air: one figure, and no figure root, trail or tag left in the scene
  for (let k = 0; k < 6; k++) {
    d.view = k % 2 === 0 ? 'belso' : 'kulso';
    d.run(1, (t, c) => { c.fwd = 1; });
    assert.equal(gfx.figures.has(SELF), d.view === 'kulso', 'toggle ' + k);
    assert.ok(gfx.figures.map.size <= 1);
  }
  d.view = 'belso';
  d.run(1);
  assert.equal(gfx.scene.children.length, base, 'first person again: the scene has exactly what it had before the first third-person frame (' + gfx.scene.children.map((o) => o.name || o.type).join(', ') + ')');
  // 3. straight up and straight down (the sim clamps to +-89 deg, but an editor camera test or a hook can pass the pole itself): finite everywhere
  d.view = 'kulso';
  for (const [yaw, pitch] of [[0, 89 * DEG], [0, -89 * DEG], [3, Math.PI / 2], [-3, -Math.PI / 2], [1e3, 0.2]]) {
    d.cmd.yaw = yaw; d.cmd.pitch = pitch;
    d.run(2, (t, c) => { c.fwd = 0; });
    const c = gfx.camera;
    assert.ok(finite(c.position.toArray()) && finite([c.rotation.x, c.rotation.y, c.rotation.z]) && finite(c.matrixWorld.elements), `camera finite for yaw ${yaw} pitch ${pitch}`);
    const i = gfx.cameraInfo();
    assert.ok(finite([i.dist, i.limit, i.want, i.yawDeg, i.pitchDeg]) && finite(selfInfo(gfx).pos));
    assert.ok(self(gfx).root.position.toArray().every(Number.isFinite) && Number.isFinite(self(gfx).root.rotation.y));
  }
  // 4. a respawn while the view is switched on, and switching on in the very frame of a respawn 30 m away: no streak, the camera is at the new spot
  w.teleport([0, 0, -30], 0);
  d.cmd.yaw = 0; d.cmd.pitch = 0;
  d.view = 'belso'; d.run(2);
  d.view = 'kulso';
  d.run(1, (t, c) => { c.respawn = true; });
  assert.ok(near(w.ps.pos[2], 0, 1e-6) || Math.hypot(w.ps.pos[0], w.ps.pos[2]) < 1, 'setup: respawned at the start ' + w.ps.pos);
  const head = [w.ps.pos[0], w.ps.pos[1] + EYE, w.ps.pos[2]];
  const cp = gfx.camera.position;
  assert.ok(Math.hypot(cp.x - head[0], cp.y - head[1], cp.z - head[2]) < 3.7, 'the camera is round the new head, not on the way from the old spot: ' + cp.toArray());
  assert.ok(near(gfx.cameraInfo().dist, gfx.cameraInfo().want, 0.01), 'snapped to the full distance');
  const g = selfInfo(gfx);
  assert.ok(g.pos.every((v, k) => near(v, w.ps.pos[k], 0.05)), 'the figure stands on the respawn spot: ' + g.pos);
  gfx.figures.dispose();
});

test('BUG: third person: a respawn / restart less than 8 m from where you stood leaves the own figure running in place (or in the landing pose) for a few tenths of a second', async () => {
  if (!HAVE) return;
  const bad = [];
  for (const how of ['running', 'in the air']) {
    const gfx = await fakeGfx();
    const w = arena();
    w.teleport([0, 0, 0], 0);
    const d = driver(gfx, w);
    d.run(30);
    const jt = d.tick + 1;
    if (how === 'running') d.run(36, (t, c) => { c.fwd = 1; });
    else d.run(30, (t, c) => { c.fwd = 1; if (t === jt) c.jump = true; });
    const away = Math.hypot(w.ps.pos[0], w.ps.pos[2]);
    assert.ok(away > 1 && away < 8, `setup: ${how}, ${away.toFixed(1)} m from the start`);
    assert.equal(w.ps.grounded, how === 'running', 'setup: ' + how);
    const n0 = d.frames.length, rt = d.tick + 1;
    d.run(30, (t, c) => { c.fwd = 0; if (t === rt) c.respawn = true; });   // R on the first tick of this stretch; then the player stands still
    assert.ok(Math.hypot(w.ps.pos[0], w.ps.pos[2]) < 0.5 && w.ps.grounded, 'setup: back on the start');
    const odd = d.frames.slice(n0, n0 + 20).map((f) => f.clip).filter((c) => c !== 'Idle_Rifle');
    if (odd.length) bad.push(`${how} (${away.toFixed(1)} m back to the start): ${[...new Set(odd)].join(', ')} in ${odd.length} of the first 20 frames`);
    gfx.figures.dispose();
  }
  assert.ok(!bad.length, 'standing on the respawn spot the figure must idle at once: ' + bad.join(' | '));
});

test('third person: along the synthetic routes (the course with its tunnel and the arena full of dodges) the chase camera is always in free space on a free line from the head, finite, whatever way the player looks', () => {
  let n = 0, held = 0, hid = 0;
  const course_ = course(), cw = new World(course_), dr = dodgeRoute();
  for (const [id, w, rr] of [['course', cw, new RouteRunner(cw, course_.route)], ['dodges', dr.w, dr]]) {
    const def = { meta: { id } };
    const cam = new ChaseCam();
    let tick = 0, mine = 0;
    while (rr.tick()) {
      tick++;
      if (tick % 3) continue;
      const ps = w.ps;
      const head = [ps.pos[0], ps.pos[1] + EYE, ps.pos[2]];
      const yaw = ps.yaw + tick * 0.021, pitch = Math.sin(tick * 0.017) * 87 * DEG;   // the look drifts round the player and up and down
      const c = cam.update(1 / 40, w.cw, head, yaw, pitch);
      n++; mine++;
      if (!finite(c.pos) || !(c.dist >= 0) || c.dist > c.limit + 1e-9 || c.dist > c.want + 1e-9) assert.fail(`${def.meta.id} tick ${tick}: bad camera ${JSON.stringify(c)}`);
      if (w.cw.testSolid(c.pos, HALF)) assert.fail(`${def.meta.id} tick ${tick}: the camera box is inside geometry at ${c.pos.map((v) => v.toFixed(2))} (head ${head.map((v) => v.toFixed(2))}, yaw ${yaw.toFixed(2)}, pitch ${(pitch / DEG).toFixed(0)})`);
      if (w.cw.traceBox(head, c.pos, HALF).fraction !== 1) assert.fail(`${def.meta.id} tick ${tick}: geometry between the head and the camera`);
      if (c.dist < CHASE.HIDE_IN && !c.hidden) assert.fail(`${def.meta.id} tick ${tick}: camera ${c.dist} m from the head and the figure is still drawn`);
      if (c.dist >= CHASE.HIDE_OUT && c.hidden) assert.fail(`${def.meta.id} tick ${tick}: camera ${c.dist} m from the head and the figure is still hidden`);
      if (c.hit) held++;
      if (c.hidden) hid++;
    }
    assert.ok(mine > 100, `${def.meta.id}: the route gave ${mine} camera samples`);
  }
  assert.ok(n > 800 && held > 20, `${n} cameras along the routes, ${held} held in by geometry, ${hid} with the figure hidden`);
});

test('third person in a race: the own figure is a local thing - the state packets come from the sim, the peers\' figures come and go, and the own one is never touched by the room', async () => {
  TM.reset();
  const clock = installClock();
  installDom();
  const maps = fakeMaps(), L = new Map(), figs = new Map();
  const hashOf = (id) => (maps.has(id) ? 'hash-' + id : null);
  const app = {
    maps, DIFF_LABEL, settings: { name: 'Teszt', view: 'kulso' }, local: { name: 'Teszt' }, mapId: 'alpha', get mapHash() { return hashOf(app.mapId); },
    mode: 'solo', state: 'menu', pauseFreezes: true, allow: { restart: true, respawn: true },
    world: { ps: { pos: [1, 2, 3], yaw: 0.5, pitch: 0.1 }, cpIndex: 0, playerFlags: () => 1 },
    mapHashOf: hashOf, loadMap: async (id) => { app.mapId = id; }, restartRun() {}, startRun() {}, setFrozen() {},
    setMode: (m) => { app.mode = m; }, play: () => { app.state = 'playing'; }, setSetting: (k, v) => { app.settings[k] = v; },
    showScreen: (id) => { app.ui.current = id; app.emit('screen', { id }); },
    on: (t, cb) => { if (!L.has(t)) L.set(t, new Set()); L.get(t).add(cb); return () => L.get(t).delete(cb); },
    emit: (t, p = {}) => { for (const cb of [...(L.get(t) || [])]) cb(p); },
    figures: { upsert: (id, o) => figs.set(id, o), remove: (id) => figs.delete(id), has: (id) => figs.has(id) },
    hud: { center() {}, standings() {} }, ui: { current: 'menu', toast() {} }, audio: { unlock() {} }, input: { lock: () => Promise.resolve(true) },
  };
  initRace(app);
  try {
    const R = app.race;
    R.enter('ABCD', true);
    const room = () => TM.rooms[TM.rooms.length - 1];
    room().onPeerJoin('zzzz');
    room().actions.hello.onMessage({ name: 'Zed', mh: 'hash-alpha', host: '' }, { peerId: 'zzzz' });
    const mine = { name: 'Én', color: 0xff8a2a, pos: [99, 99, 99], yaw: 2, pitch: 0, flags: 0 };   // the own figure, as renderer.js upserts it in the third person view
    figs.set(SELF, mine);
    const m0 = TM.sent.length;
    await clock.advance(600);
    room().actions.st.onMessage([100, 50, 200, 157, 0, 1, 1], { peerId: 'zzzz' });
    await clock.advance(300);
    app.emit('tick');
    assert.ok(figs.has('p:zzzz'), 'the peer is drawn');
    assert.equal(figs.get(SELF), mine, 'the own figure is the renderer\'s, race.js leaves it alone');
    const sts = TM.sent.slice(m0).filter((m) => m.type === 'st');
    assert.ok(sts.length >= 15, sts.length + ' state packets');
    for (const s of sts) {
      assert.deepEqual(s.data, [100, 200, 300, 50, 10, 0, 1], 'x y z, yaw, pitch, checkpoint, flags of the SIM (the figure is at 99, 99, 99)');
    }
    assert.equal(TM.sent.slice(m0).filter((m) => /fig|self|__me/i.test(JSON.stringify(m))).length, 0, 'nothing mentions a figure');
    room().onPeerLeave('zzzz');
    await clock.advance(400);
    assert.ok(!figs.has('p:zzzz') && figs.get(SELF) === mine, 'the peer left, the own figure stays');
  } finally { app.emit('exit'); }
  assert.equal(figs.get(SELF) && figs.get(SELF).name, 'Én', 'and leaving the room does not remove it either');
});

let storeN = 0;
test('settings: a stored view that is not "belso" / "kulso" (hand-edited save, newer version, junk) falls back to "belso" without touching the other fields; unreadable saves give the defaults', async () => {
  const ls = memStorage();
  setGlobal('localStorage', ls);
  const { store } = await import('../store.js?tpe=' + (++storeN));
  const KEY = 'pajzsugras:settings';
  const load = (raw) => { ls.setItem(KEY, raw); return store.loadSettings(); };
  assert.equal(load('{"view":"kulso","fov":90}').view, 'kulso');
  let s = load('{"view":"sideways","fov":90,"sens":2}');
  assert.deepEqual([s.view, s.fov, s.sens], ['belso', 90, 2], 'only the bad field is replaced');
  for (const raw of ['{"view":null}', '{"view":["kulso"]}', '{"view":{"v":"kulso"}}', '{"view":" kulso"}', '{"view":"Kulso"}', '{"view":1}', '{"view":true}']) assert.equal(load(raw).view, 'belso', raw);
  for (const raw of ['{"view":', 'not json', '[]', 'null', '"kulso"', '7', '', '{"__proto__":{"view":"kulso"}}']) assert.equal(load(raw).view, 'belso', 'unreadable / not an object: ' + JSON.stringify(raw));
  ls.removeItem(KEY);
  assert.equal(store.loadSettings().view, 'belso', 'nothing saved');
});

// ================================================================ the own figure against the sim (Gorge model)
const HOP = { start: [0, 0, -9.5] };

test('own figure: dodge, wall dodge, double jump and landing of the LOCAL sim show up as the right Gorge clip within 0.2 s, in order, at 60 and at 144 Hz; the figure is always where the sim interpolates it', async () => {
  if (!HAVE) return;
  const bad = [];
  for (const hz of [60, 144]) {
    const gfx = await fakeGfx();
    const w = arena(WALL);
    w.teleport(HOP.start, 0);
    const d = driver(gfx, w, { hz });
    // stand 0.3 s, jump at the wall, wall dodge away from it 60 ms later, a double jump half a second after that, land, wait, dodge right on the ground
    const T = { jump: 40, wall: 55, dj: 110 };
    let groundDodgeAt = null, landedAt = null;
    d.run(600, (t, c) => {
      if (t === T.jump) c.jump = true;
      if (t === T.wall) c.dodge = DODGE.B;
      if (t === T.dj) c.jump = true;
      if (landedAt === null && t > T.dj + 5 && d.w.ps.grounded) landedAt = t;
      if (landedAt !== null && groundDodgeAt === null && t === landedAt + 150) { groundDodgeAt = t; c.dodge = DODGE.R; }
    }, (s) => groundDodgeAt !== null && s.tick > groundDodgeAt + 120 && s.w.ps.grounded);
    const tag = `${hz} Hz`;
    const ev = (type, nth = 0) => d.events.filter((e) => e.type === type)[nth];
    const want = [['jump', 'takeoff'], ['walldodge', 'walldodge'], ['dj', 'dj'], ['land', 'land'], ['dodge', 'dodge']];
    for (const [type, family] of want) {
      const e = type === 'land' ? d.events.filter((x) => x.type === 'land' && x.time > T.dj / TICK).find((x) => x.ev.speed > 2) || d.events.filter((x) => x.type === 'land').at(-2) : ev(type);
      if (!e) { bad.push(`${tag}: the sim never emitted ${type}`); continue; }
      const hit = d.frames.find((f) => f.time >= e.time - 1 / hz && f.time <= e.time + 0.2 && fam(f.clip) === family);
      if (!hit) bad.push(`${tag}: ${type} at ${e.time.toFixed(3)} s but no ${family} clip within 0.2 s (${d.frames.filter((f) => f.time >= e.time - 0.05 && f.time <= e.time + 0.25).map((f) => f.clip).filter((x, i, a) => x !== a[i - 1]).join(' > ')})`);
    }
    const fams = familiesOf(d.frames);
    if (!inOrder(fams, ['idle', 'takeoff', 'walldodge', 'dj', 'mid', 'land', 'dodge'])) bad.push(`${tag}: clip families ${fams.join(' > ')}`);
    const wd = d.frames.find((f) => fam(f.clip) === 'walldodge');
    const gd = d.frames.find((f) => fam(f.clip) === 'dodge');
    if (!wd || wd.clip !== 'WallDodgeB') bad.push(`${tag}: the wall dodge away from the wall plays ${wd && wd.clip} (WallDodgeB wanted)`);
    if (!gd || gd.clip !== 'DodgeR') bad.push(`${tag}: the right dodge plays ${gd && gd.clip}`);
    if (d.frames.some((f) => f.f && f.f.clip !== f.clip)) bad.push(`${tag}: the rig played ${d.frames.find((f) => f.f.clip !== f.clip).f.clip} while the brain asked for ${d.frames.find((f) => f.f.clip !== f.clip).clip}`);
    // the figure is exactly where the sim says (interpolated), every frame, also during the dodges
    const off = d.frames.filter((f) => f.f.pos.some((v, k) => !near(v, f.lerp[k], 2e-3)));
    if (off.length) bad.push(`${tag}: the figure is off the interpolated sim position in ${off.length} frames (first ${off[0].f.pos} vs ${off[0].lerp})`);
    gfx.figures.dispose();
  }
  assert.ok(!bad.length, bad.join(' | '));
});

test('BUG (cosmetic): own figure: a double jump pressed with / right after a wall dodge (the UT2004 combo) shows the DoubleJump clip - now the WallDodge clip hides it when both flags arrive in one frame', () => {
  const R = (hz, delay) => {
    const w = arena(WALL);
    w.teleport(HOP.start, 0);
    const c = makeCmd(), brain = new AnimBrain(), clips = [];
    let acc = 0, tick = 0;
    for (let f = 0; f < 140; f++) {
      acc += 1 / hz;
      while (acc >= 1 / TICK - 1e-9) {
        acc -= 1 / TICK;
        c.dodge = 0; c.jump = false;
        if (tick === 5) c.jump = true;
        if (tick === 15) c.dodge = DODGE.B;
        if (tick === 15 + delay) c.jump = true;
        w.step(c); w.takeEvents(); tick++;
      }
      clips.push(brain.update(1 / hz, { pos: w.lerp(acc * TICK).pos, yaw: 0, flags: w.playerFlags() }).clip);
    }
    return clips.filter((x, i, a) => x !== a[i - 1]);
  };
  const bad = [];
  for (const hz of [60, 144]) for (const delay of [0, 1, 4]) {
    const seq = R(hz, delay);
    if (!seq.some((x) => /^DoubleJump/.test(x))) bad.push(`${hz} Hz, Space ${delay} tick(s) after the wall dodge: ${seq.join(' > ')}`);
    if (!seq.some((x) => /^(WallDodge|DoubleJump)/.test(x))) bad.push(`${hz} Hz, +${delay}: neither dodge clip`);
    if (seq.some((x) => /^Dodge/.test(x))) bad.push(`${hz} Hz, +${delay}: a ground dodge clip for a wall dodge`);
  }
  assert.ok(!bad.length, 'the double jump the player pressed must be visible: ' + bad.join(' | '));
});

// ================================================================ falling
const LEDGE = (b) => b.box([-4, 98, -4], [4, 100, 4], { mat: 'floor' });   // a 100 m high platform, 4 m to its edge in front of the start (z = -4)

test('falling: the Mid clips of the real glb have lost their loop copy (they end on a real pose), the run / idle loops keep it', async () => {
  if (!HAVE) return;
  const gfx = await fakeGfx();
  const G = await import('../render/gorge.js');
  const tpl = G.gorgeTemplate();
  assert.ok(tpl);
  const wrapped = (clip) => clip.tracks.filter((t) => t.times.length >= 3).every((t) => {
    const n = t.times.length, wd = t.values.length / n;
    return t.values.slice(0, wd).every((v, i) => Math.abs(v - t.values[(n - 1) * wd + i]) <= 1e-4);
  });
  const mids = [...tpl.clips].filter(([n]) => /_Mid$/.test(n));
  assert.equal(mids.length, 5, 'Jump_Mid + four directions');
  for (const [name, clip] of mids) {
    assert.ok(!wrapped(clip), name + ' still ends on its first pose: the held frame would be the first one');
    assert.ok(near(clip.duration, 0.25, 1e-3), name + ' lasts ' + clip.duration);
    assert.ok(clip.tracks.every((t) => near(t.times[t.times.length - 1], t.times.length > 1 ? 0.25 : t.times[0], 1e-3) || t.times.length < 3), name + ': a track runs past the clip');
  }
  for (const name of ['Idle_Rifle', 'RunF', 'RunB', 'RunL', 'RunR']) assert.ok(wrapped(tpl.clips.get(name)), name + ' must keep its wrap key: it loops');
  gfx.figures.dispose();
});

// the mixer-driven pose of a bone against the clip's keys: the first pose of the clip and the last one
function boneVsKeys(root, clip) {
  let best = null;
  for (const t of clip.tracks) {
    if (!/quaternion$/.test(t.name) || t.times.length < 3) continue;
    const n = t.times.length;
    let diff = 0;
    for (let i = 0; i < 4; i++) diff += Math.abs(t.values[i] - t.values[(n - 1) * 4 + i]);
    if (!best || diff > best.diff) best = { t, diff };
  }
  const { nodeName } = THREE.PropertyBinding.parseTrackName(best.t.name);
  const bone = root.getObjectByName(nodeName);
  const n = best.t.times.length;
  const q = (i) => new THREE.Quaternion().fromArray(best.t.values, i * 4);
  const cur = bone.quaternion;
  const ang = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a.dot(b))));   // radians between two rotations
  return { bone: nodeName, first: ang(cur, q(0)), last: ang(cur, q(n - 1)), span: ang(q(0), q(n - 1)) };
}

test('falling: walking off a 100 m ledge goes straight to the held Mid pose (no take-off clip) and the action holds the clip\'s last real frame for the whole 3 s fall - not the first pose, not a loop', async () => {
  if (!HAVE) return;
  const gfx = await fakeGfx();
  const G = await import('../render/gorge.js');
  const w = arena(LEDGE);
  w.teleport([0, 100, 0], 0);
  const d = driver(gfx, w);
  d.run(12);
  assert.ok(w.ps.grounded, 'setup: on the ledge');
  d.run(300, (t, c) => { c.fwd = 1; }, (s) => !s.w.ps.grounded);
  const t0 = d.frames.length;
  d.run(400, (t, c) => { c.fwd = 1; }, (s) => s.frames.length - t0 >= 120);   // 2 s into the fall
  assert.ok(!w.ps.grounded, 'setup: still falling');
  const clipNow = d.frames.at(-1).clip;
  const clip = G.gorgeTemplate().clips.get(clipNow);
  assert.ok(/^Jump\w*_Mid$/.test(clipNow), clipNow);
  // the skeleton really is in the clip's last pose (and not in its first one)
  const p = boneVsKeys(self(gfx).root, clip);
  assert.ok(p.span > 0.05, 'the clip moves a bone (' + p.bone + ') by ' + p.span);
  assert.ok(p.last < 0.15 * p.span, `the bone ${p.bone} sits on the last key (off by ${p.last}, the first key is off by ${p.first})`);
  assert.ok(p.first > 0.85 * p.span, 'and not on the first one');
  d.run(400, (t, c) => { c.fwd = 1; }, (s) => s.w.ps.grounded);
  const fall = d.frames.slice(t0 - 1);
  const flight = fall.length / 60;
  assert.ok(flight > 2.8, 'setup: a long fall, ' + flight.toFixed(2) + ' s');
  const airborne = fall.filter((f) => f.air);
  assert.ok(!airborne.some((f) => fam(f.clip) === 'takeoff'), 'a walk-off has no take-off clip: ' + clipsOf(airborne).join(' > '));
  const mids = clipsOf(airborne.slice(4));
  assert.equal(mids.length, 1, 'one Mid clip for the whole fall (no flicker, no restart): ' + mids.join(' > '));
  assert.equal(mids[0], clipNow);
  for (const sec of [0.5, 1.0, 2.0, 2.7]) {
    const f = airborne[Math.min(airborne.length - 1, Math.round(sec * 60) + 3)];
    assert.equal(f.f.loop, false, `${sec} s into the fall: played once`);
    assert.ok(near(f.f.time, clip.duration, 2e-3), `${sec} s into the fall the action is held at its end (${clip.duration} s), not at ${f.f.time}`);
    assert.ok(near(f.f.weight, 1, 1e-3));
  }
  gfx.figures.dispose();
});

test('falling: a jump off the ledge shows the Takeoff once, a double jump plays DoubleJump and returns to the HELD Mid (not the Takeoff again), the landing shows the Land pose and the figure goes back to idle', async () => {
  if (!HAVE) return;
  const gfx = await fakeGfx();
  const w = arena(LEDGE);
  w.teleport([0, 100, 0], 0);
  const d = driver(gfx, w);
  d.run(12);
  let jumpedAt = null;
  d.run(500, (t, c) => {
    if (jumpedAt === null && d.w.ps.pos[2] < -2.6) { jumpedAt = t; c.jump = true; }   // the jump off the edge
    c.fwd = 1;
    if (jumpedAt !== null && t === jumpedAt + 36) c.jump = true;   // the double jump 0.3 s later
  }, (s) => jumpedAt !== null && s.tick > jumpedAt + 100 && s.w.ps.grounded);
  const events = d.events.map((e) => e.type);
  assert.ok(events.includes('jump') && events.includes('dj') && events.includes('land'), 'setup: ' + events.join(' '));
  const air = d.frames.filter((f) => f.air);
  const fams = familiesOf(air);
  assert.deepEqual(fams.filter((x) => x === 'takeoff').length, 1, 'one take-off: ' + clipsOf(air).join(' > '));
  assert.ok(inOrder(fams, ['takeoff', 'dj', 'mid']), 'jump, double jump, then the falling pose: ' + clipsOf(air).join(' > '));
  const dj = d.frames.findIndex((f) => fam(f.clip) === 'dj');
  const after = d.frames.slice(dj).filter((f) => f.air && fam(f.clip) === 'mid');
  assert.ok(after.length > 60, 'a long fall after the double jump: ' + after.length + ' frames');
  const last = after.at(-4);
  assert.equal(last.f.loop, false);
  const clip = (await import('../render/gorge.js')).gorgeTemplate().clips.get(last.clip);
  assert.ok(near(last.f.time, clip.duration, 2e-3), 'the Mid after the double jump is held at its end: ' + last.f.time + ' of ' + clip.duration);
  assert.equal(fams.at(-1), 'mid', 'it stays in the held Mid until the ground');
  // the landing
  const land = d.events.filter((e) => e.type === 'land').at(-1);
  const frame = d.frames.find((f) => f.time >= land.time - 1 / 60 && fam(f.clip) === 'land');
  assert.ok(frame && frame.time - land.time < 0.1, 'the Land pose within 0.1 s of the landing: ' + (frame && frame.clip));
  d.run(60, (t, c) => { c.fwd = 0; });
  assert.equal(d.frames.at(-1).clip, 'Idle_Rifle', 'and idle again');
  gfx.figures.dispose();
});

// ================================================================ the repainted skins
const MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const pngBytes = (n) => { const b = new Uint8Array(n); b.set(MAGIC); b.fill(7, 8); return b; };
const png = (n) => () => new Response(pngBytes(n), { status: 200, headers: { 'content-type': 'image/png' } });
const BODY = 'JuggMaleABodyA', HEAD = 'JuggMaleAHeadA';

test('gorge skins: a PNG of any size from 1 x 1 to 4096 x 4096 (also not square, not a power of two, a different size for the body and the head - the player\'s 1254 x 1254 repaint) is used as it is; the UV layout is relative, so only the cap matters', async () => {
  const { applySkins } = await import('../render/gorge.js');
  const cases = [[[1254, 1254], [1024, 1024]], [[1, 1], [7, 13]], [[4096, 4096], [4096, 1]], [[300, 77], [2048, 2048]]];
  for (const [b, h] of cases) {
    const sizes = new Map([[1000, b], [2000, h]]);
    const made = [];
    setGlobal('fetch', async (url) => { const f = String(url).split('/').pop(); return f === 'gorge-body.png' ? png(1000)() : f === 'gorge-head.png' ? png(2000)() : new Response('no', { status: 404 }); });
    setGlobal('createImageBitmap', async (blob) => { const [width, height] = sizes.get(blob.size); const r = { width, height, closed: false, close() { this.closed = true; } }; made.push(r); return r; });
    const scene = new THREE.Scene(), olds = [], mats = [];
    for (const name of [BODY, HEAD]) {
      const old = new THREE.Texture({ width: 4, height: 4 });
      old.wrapS = THREE.MirroredRepeatWrapping; old.minFilter = THREE.LinearMipmapLinearFilter; old.anisotropy = 4;
      const mat = new THREE.MeshStandardMaterial({ map: old, name });
      scene.add(new THREE.SkinnedMesh(new THREE.BoxGeometry(), mat));
      olds.push(old); mats.push(mat);
    }
    assert.deepEqual(await applySkins(scene, GLB_URL), ['gorge-body.png', 'gorge-head.png'], JSON.stringify([b, h]));
    assert.deepEqual([mats[0].map.image.width, mats[0].map.image.height, mats[1].map.image.width, mats[1].map.image.height], [...b, ...h]);
    assert.ok(made.every((m) => m.closed === false), 'the bitmaps in use are not closed');
    for (let i = 0; i < 2; i++) {
      assert.equal(mats[i].map.wrapS, olds[i].wrapS);
      assert.equal(mats[i].map.minFilter, olds[i].minFilter);
      assert.equal(mats[i].map.anisotropy, 4);
      assert.equal(mats[i].map.flipY, false);
      assert.equal(mats[i].map.colorSpace, THREE.SRGBColorSpace);
    }
  }
});

test('gorge skins: the repainted textures outlive figure rebuilds (ghost / solid / colour), a map change (figures.clear), a re-made figure and the warm-up rigs - none of them ever disposes the shared skin; the robot is untouched', async () => {
  if (!HAVE) return;
  const files = { 'gorge-body.png': png(1000), 'gorge-head.png': png(2000) };
  stubBrowser(files);
  setGlobal('createImageBitmap', async (blob) => ({ width: 1254, height: 1254, size: blob.size, close() {} }));
  const G = await import('../render/gorge.js');
  G.resetGorge();
  const tpl = await G.loadGorge(GLB_URL);
  assert.deepEqual(tpl.skins, ['gorge-body.png', 'gorge-head.png']);
  const skins = [];
  tpl.scene.traverse((o) => { if (o.isSkinnedMesh) skins.push(o.material.map); });
  let disposed = 0;
  for (const t of skins) t.addEventListener('dispose', () => disposed++);
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 1.7, 8);
  const figs = new Figures(scene);
  const used = () => figs.map.get('a').rig.skinned.map((m) => m.material.map);
  const isSkin = (tex) => tex.userData.skinFile && tex.image.width === 1254;
  figs.upsert('a', { name: 'A', color: 0xff8a2a, pos: [0, 0, 0], yaw: 0, flags: FLAG.GROUND, ghost: true, solid: true });
  figs.update(1 / 60, camera);
  assert.ok(used().every(isSkin), 'a race peer wears the repaint');
  for (const o of [{ ghost: true, solid: false }, { ghost: false, solid: false }, { color: 0x2ee6d4 }, { ghost: true, solid: true }]) {
    figs.upsert('a', { name: 'A', color: 0xff8a2a, pos: [0, 0, 0], yaw: 0, flags: FLAG.GROUND, ...o });
    figs.update(1 / 60, camera);
    assert.ok(used().every(isSkin), 'after the rebuild ' + JSON.stringify(o));
  }
  figs.clear();   // a new map
  figs.upsert('a', { name: 'A', color: 0xff8a2a, pos: [0, 0, 0], yaw: 0, flags: FLAG.GROUND });
  figs.update(1 / 60, camera);
  assert.ok(used().every(isSkin), 'after a map change');
  await figs.warm({ compileAsync: async () => {} }, camera);
  await figs.warm({ compileAsync: async () => {} }, camera);   // (the second warm-up disposes the first one's rigs)
  figs.remove('a');
  assert.equal(disposed, 0, 'the shared skin textures were never disposed');
  assert.ok(skins.every((t) => t.image && t.image.width === 1254), 'and are still there');
  figs.dispose();
  // no model: the figures stay robots whatever PNGs lie around
  stubBrowser({ ...files, 'gorge.glb': () => new Response('no', { status: 404 }) });
  G.resetGorge();
  const robots = new Figures(new THREE.Scene());
  await G.loadGorge(GLB_URL);
  robots.upsert('r', { name: 'R', color: 0xff8a2a, pos: [0, 0, 0], yaw: 0, flags: 1, ghost: true, solid: true });
  robots.update(1 / 60, camera);
  assert.equal(robots.info()[0].model, 'robot');
  robots.dispose();
});

// ================================================================ the wall-dodge double jump and the shield, through the main.js frame loop
const TICK_MS = 1000 / TICK;
// events [{ t (ms), code | mouse, down }] reach the Input between display frames exactly as in the browser: a frame at hz adds 1000/hz ms, the
// events up to its end are delivered first, then the sim ticks that the accumulator holds are run (main.js frameBody)
function loop(events, { hz, ms, arena: fn = null, start = [0, 0, 0] }) {
  const w = arena(fn);
  w.teleport(start, 0);
  const inp = new Input({}, { sens: 1, doubleTap: true });
  inp.enabled = true; inp.locked = true; inp.setLook(0, 0);
  const sorted = events.slice().sort((a, b) => a.t - b.t);
  const frameMs = 1000 / hz, log = [], delivered = [];
  let ei = 0, acc = 0, tick = 0;
  for (let f = 0; (f + 1) * frameMs <= ms; f++) {
    const end = (f + 1) * frameMs;
    while (ei < sorted.length && sorted[ei].t < end) {
      const e = sorted[ei];
      const kb = { code: e.code, repeat: false, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, timeStamp: e.t, preventDefault() {} };
      if (e.mouse) (e.down ? inp.onMouseDown : inp.onMouseUp).call(inp, { button: 0 });
      else (e.down ? inp.onKeyDown : inp.onKeyUp).call(inp, kb);
      delivered[ei] = tick;
      ei++;
    }
    acc += frameMs;
    while (acc >= TICK_MS) {
      acc -= TICK_MS;
      w.step(inp.fillCmd(makeCmd()));
      for (const e of w.takeEvents()) if (e.type !== 'clockStart') log.push({ tick, type: e.type, auto: !!e.auto, hit: e.hit, charge: e.charge });
      tick++;
    }
  }
  return { log, delivered, w, tick };
}
const k = (t, code, down) => ({ t, code, down });

test('input path at 144 Hz (and the same run at 60): jump at a wall, double-tap S (a wall dodge), Space 0 - 250 ms after the second tap is one immediate double jump, never an automatic one, within 2 ticks of the frame that brought the press', () => {
  const bad = [];
  let n = 0;
  for (const hz of [144, 60]) for (const delay of [0, 4, 17, 60, 150, 250]) {
    const ts = 200.3 + delay;
    const ev = [k(0.5, 'Space', true), k(60, 'Space', false), k(100.3, 'KeyS', true), k(140, 'KeyS', false), k(200.3, 'KeyS', true), k(260, 'KeyS', false), k(ts, 'Space', true), k(ts + 80, 'Space', false)];
    const r = loop(ev, { hz, ms: 900, arena: WALL, start: [0, 0, -9.5] });
    n++;
    const wd = r.log.filter((e) => e.type === 'walldodge'), dj = r.log.filter((e) => e.type === 'dj');
    const tag = `${hz} Hz +${delay} ms`;
    if (wd.length !== 1) { bad.push(`${tag}: ${wd.length} wall dodges`); continue; }
    if (dj.length !== 1 || dj[0].auto) { bad.push(`${tag}: double jumps ${JSON.stringify(dj)}`); continue; }
    const pressTick = Math.max(r.delivered[6], wd[0].tick);   // the first tick that can see the press (and the wall dodge it follows)
    if (dj[0].tick < wd[0].tick || dj[0].tick > pressTick + 2) bad.push(`${tag}: wall dodge at tick ${wd[0].tick}, press delivered before tick ${r.delivered[6]}, double jump at tick ${dj[0].tick}`);
  }
  assert.ok(!bad.length, bad.slice(0, 4).join('; ') + ` (${n} runs)`);
});

test('shield: releasing and pressing the button again inside one display frame (60 and 144 Hz) is two shots - the charge is let go, the gun recharges after its lock and fires again; a plain hold fires once', () => {
  const bad = [];
  for (const hz of [144, 60]) for (const gap of [1, 3.5]) {
    const press = (up, again) => [{ t: 10, mouse: true, down: true }, { t: up, mouse: true, down: false }, ...(again ? [{ t: up + gap, mouse: true, down: true }, { t: 1900, mouse: true, down: false }] : [])];
    const two = loop(press(700, true), { hz, ms: 2400, arena: (b) => b.box([-5, 0, -5], [5, 3, -4], { mat: 'wall' }) });
    const blasts = two.log.filter((e) => e.type === 'blast');
    const tag = `${hz} Hz, ${gap} ms between release and press`;
    if (blasts.length !== 2) { bad.push(`${tag}: ${blasts.length} blasts (${two.log.map((e) => e.type + e.tick).join(' ')})`); continue; }
    if (!(blasts[0].tick > 70 && blasts[0].tick < 100)) bad.push(`${tag}: the first blast at tick ${blasts[0].tick} (the release is at about tick 83)`);
    if (!(blasts[1].tick > 220 && blasts[1].tick < 235)) bad.push(`${tag}: the second blast at tick ${blasts[1].tick} (the final release is at about tick 227)`);
    const one = loop([{ t: 10, mouse: true, down: true }, { t: 1900, mouse: true, down: false }], { hz, ms: 2400 });
    if (one.log.filter((e) => e.type === 'blast').length !== 1) bad.push(`${tag}: a plain hold fires ${one.log.filter((e) => e.type === 'blast').length} times`);
  }
  assert.ok(!bad.length, bad.join('; '));
});

// ================================================================ the sim: a wall dodge with the double jump already spent
test('wall dodge with the double jump already used: it gives the double jump back - Space after it (at once, later, in the same tick) is one more immediate double jump, never a third, nothing buffered, no automatic one; the other order gives exactly one', () => {
  const run = (script, ticks = 260) => {
    const w = arena(WALL);
    w.teleport([0, 0, -9.5], 0);
    const c = makeCmd(), ev = [];
    let bufSeen = false;
    for (let t = 0; t < ticks; t++) {
      c.dodge = 0; c.jump = false;
      script(t, c);
      w.step(c);
      for (const e of w.takeEvents()) if (e.type !== 'clockStart') ev.push({ t, type: e.type, auto: !!e.auto });
      if (w.ps.djBuf && !w.ps.grounded) bufSeen = true;
      if (t > 30 && w.ps.grounded) break;
    }
    return { ev, dj: ev.filter((e) => e.type === 'dj'), wd: ev.filter((e) => e.type === 'walldodge'), bufSeen, w };
  };
  // jump, double jump (Space again), wall dodge, then Space at once / 1 / 5 / 20 ticks later and in the same tick: the restored double jump fires on the press tick, and a further press does nothing
  const bad = [];
  for (const after of [0, 1, 5, 20]) {
    const r = run((t, c) => { if (t === 0 || t === 10) c.jump = true; if (t === 18) c.dodge = DODGE.B; if (t === 18 + after || t === 18 + after + 3) c.jump = true; });
    if (r.wd.length !== 1) bad.push(`+${after}: ${r.wd.length} wall dodges`);
    if (r.dj.length !== 2 || r.dj[0].t !== 10 || r.dj[1].t !== 18 + after || r.dj[1].auto) bad.push(`+${after}: double jumps ${JSON.stringify(r.dj)}`);
    if (r.bufSeen) bad.push(`+${after}: the double jump was buffered`);
  }
  // the other order: wall dodge first, Space with it: one double jump; more Space presses afterwards: none
  const r = run((t, c) => { if (t === 0) c.jump = true; if (t === 12) { c.dodge = DODGE.B; c.jump = true; } if (t === 14 || t === 30 || t === 60) c.jump = true; });
  if (r.dj.length !== 1 || r.dj[0].auto || r.dj[0].t !== 12) bad.push('wall dodge + Space: ' + JSON.stringify(r.dj));
  if (r.bufSeen) bad.push('wall dodge + Space buffered something');
  assert.ok(!bad.length, bad.join('; '));
});
