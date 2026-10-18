// Edge cases of the Gorge pipeline that gorge-anim-tests.mjs / gorge-figures-tests.mjs do not reach (the tester's hunt):
//   brain: bad numbers, the +-PI yaw wrap, respawns with stale flags, a finish in the air, recorded-ghost step-ups, a random storm;
//   model: broken glb files fall back to the robot, every clip poses the real mesh sanely, the brain's clip lengths match the glb,
//          the figure really faces its yaw;
//   figures: churn without leaks, name tags / trail survive rebuilds, a model that arrives after the figures are gone.
// The cases marked BUG fail until the code is fixed. The model cases need pajzsugras/local-models/gorge.glb (git-ignored, made by
// tools/ut2004_extract.py) and pass without checking anything when it is not there, like gorge-figures-tests.mjs.
import fs from 'node:fs';
import * as THREE from 'three';
import { test, assert, setGlobal } from './harness.mjs';
import { AnimBrain, CLIP_LEN } from '../render/gorge-anim.js';
import { FLAG, RUN } from '../sim/const.js';
import { fwdOf, rightOf, mulberry32 } from '../sim/math.js';

const GLB = new URL('../local-models/gorge.glb', import.meta.url);
const HAVE = fs.existsSync(GLB);
const DT = 1 / 60;
const GROUND = FLAG.GROUND;

// ---- the 36 clips of the glb (tools/ut2004_extract.py CLIPS) ----
const CLIPS = new Set(['Idle_Rifle', 'Idle_Rest', 'RunF', 'RunB', 'RunL', 'RunR', 'Rifle_Burst', 'gesture_cheer']);
for (const p of ['Jump', 'JumpF', 'JumpB', 'JumpL', 'JumpR']) for (const s of ['Takeoff', 'Mid', 'Land']) CLIPS.add(p + '_' + s);
for (const p of ['DoubleJump', 'DoubleJumpF', 'DoubleJumpB', 'DoubleJumpL', 'DoubleJumpR']) CLIPS.add(p);
for (const d of 'FBLR') { CLIPS.add('Dodge' + d); CLIPS.add('WallDodge' + d); }

const rec = (list, o) => { if (!list.length || list[list.length - 1] !== o.clip) list.push(o.clip); return o; };

// ================================================================ the brain
test('BUG (latent): gorge anim: one NaN position sample poisons the brain for good - the runner never moves again (NaN speed, frozen state)', () => {
  const b = new AnimBrain();
  const at = (i) => [0, 0, -RUN * DT * i];
  let o;
  for (let i = 0; i < 30; i++) o = b.update(DT, { pos: at(i), yaw: 0, flags: GROUND });
  assert.equal(o.clip, 'RunF');
  b.update(DT, { pos: [NaN, 0, NaN], yaw: 0, flags: GROUND });   // (a bad sample: a corrupt packet, a division by zero upstream)
  for (let i = 31; i < 120; i++) o = b.update(DT, { pos: at(i), yaw: 0, flags: GROUND });
  assert.ok(Number.isFinite(o.speed) && Math.abs(o.speed - RUN) < 0.5, 'speed 1.5 s after the bad sample: ' + o.speed);
  assert.equal(o.clip, 'RunF');
  // ... and the same for a NaN height in infer mode (a recorded ghost)
  const g = new AnimBrain();
  for (let i = 0; i < 30; i++) g.update(DT, { pos: at(i), yaw: 0, flags: GROUND, infer: true });
  g.update(DT, { pos: [0, NaN, -1], yaw: 0, flags: GROUND, infer: true });
  for (let i = 31; i < 120; i++) o = g.update(DT, { pos: at(i), yaw: 0, flags: GROUND, infer: true });
  assert.ok(Number.isFinite(o.speed) && o.clip === 'RunF' && !o.air, `infer: ${o.clip}, speed ${o.speed}, air ${o.air}`);
});

test('gorge anim: running through the yaw wrap (+-PI) while heading the same way keeps one clip and does not restart it', () => {
  for (const dir of [1, -1]) {
    const b = new AnimBrain();
    const f = fwdOf(Math.PI);
    const clips = new Set(), seqs = new Set();
    let pos = [0, 0, 0];
    for (let i = 0; i < 240; i++) {
      const yaw = Math.PI + dir * (-0.35 + 0.7 * (i / 240));           // sweeps across PI ...
      const wrapped = Math.atan2(Math.sin(yaw), Math.cos(yaw));        // ... and comes out as -PI..PI like the sim's yaw
      pos = [pos[0] + f[0] * RUN * DT, 0, pos[2] + f[2] * RUN * DT];
      const o = b.update(DT, { pos, yaw: wrapped, flags: GROUND });
      if (i > 20) { clips.add(o.clip); seqs.add(o.seq); }
    }
    assert.deepEqual([...clips], ['RunF'], 'sweep direction ' + dir);
    assert.equal(seqs.size, 1, 'the run clip was restarted ' + seqs.size + ' times');
  }
});

test('gorge anim: a respawn out of the air (2 stale frames of old flags) is no jump or landing; a recorded ghost that restarts mid-fall shows no air or landing afterwards', () => {
  const b = new AnimBrain();
  const clips = [];
  for (let i = 0; i < 40; i++) rec(clips, b.update(DT, { pos: [0, 3, -RUN * DT * i], yaw: 0, flags: 0 }));
  assert.ok(clips.includes('JumpF_Mid'), 'set-up: in the air first: ' + clips.join(' > '));
  const mark = clips.length;
  for (let i = 0; i < 2; i++) rec(clips, b.update(DT, { pos: [50, 0, 0], yaw: 0, flags: 0 }));       // the position moved, the flags are one packet late
  for (let i = 0; i < 90; i++) rec(clips, b.update(DT, { pos: [50, 0, 0], yaw: 0, flags: GROUND }));
  assert.deepEqual(clips.slice(mark), ['Idle_Rifle'], 'after the respawn: ' + clips.slice(mark).join(' > '));
  // infer: the recording restarts (the position jumps back to the start) while the last jump is still in the air
  const g = new AnimBrain();
  const gc = [];
  for (let i = 0; i < 30; i++) rec(gc, g.update(DT, { pos: [0, 0, -RUN * DT * i], yaw: 0, flags: GROUND, infer: true }));
  const v0 = 7.6, G = 19;
  for (let i = 0; i < 30; i++) { const t = i * DT; rec(gc, g.update(DT, { pos: [0, v0 * t - 0.5 * G * t * t, -RUN * (1 + t)], yaw: 0, flags: GROUND, infer: true })); }
  assert.ok(gc.some((c) => c.endsWith('_Mid')), 'set-up: the ghost is in the air: ' + gc.join(' > '));
  const gmark = gc.length;
  for (let i = 0; i < 120; i++) rec(gc, g.update(DT, { pos: [0, 0, 0], yaw: 0, flags: GROUND, infer: true }));
  assert.deepEqual(gc.slice(gmark), ['Idle_Rifle'], 'after the restart: ' + gc.slice(gmark).join(' > '));
});

test('gorge anim: FINISHED set in the air does not cheer in the air; the cheer comes once after landing on the spot, none when the landing keeps running', () => {
  const b = new AnimBrain();
  const clips = [];
  for (let i = 0; i < 30; i++) rec(clips, b.update(DT, { pos: [0, 0, 0], yaw: 0, flags: GROUND }));
  let y = 0, vy = 7.6, landed = false, airClips = null;
  for (let i = 0; i < 240; i++) {
    if (!landed) { vy -= 19 * DT; y += vy * DT; if (y <= 0) { y = 0; landed = true; airClips = clips.slice(); } }
    rec(clips, b.update(DT, { pos: [0, y, 0], yaw: 0, flags: (landed ? GROUND : 0) | FLAG.FINISHED }));
  }
  assert.ok(airClips && !airClips.includes('gesture_cheer'), 'cheered in the air: ' + (airClips || clips).join(' > '));
  assert.equal(clips.filter((c) => c === 'gesture_cheer').length, 1, clips.join(' > '));
  // finishing on the run, jumping on over the line, landing at speed: it keeps running, no cheer
  const r = new AnimBrain();
  const rc = [];
  let z = 0;
  for (let i = 0; i < 30; i++) { z -= RUN * DT; rec(rc, r.update(DT, { pos: [0, 0, z], yaw: 0, flags: GROUND })); }
  for (let i = 0; i < 60; i++) { z -= RUN * DT; rec(rc, r.update(DT, { pos: [0, 0, z], yaw: 0, flags: GROUND | FLAG.FINISHED })); }
  for (let i = 0; i < 30; i++) { z -= RUN * DT; rec(rc, r.update(DT, { pos: [0, 1, z], yaw: 0, flags: FLAG.FINISHED })); }
  for (let i = 0; i < 60; i++) { z -= RUN * DT; rec(rc, r.update(DT, { pos: [0, 0, z], yaw: 0, flags: GROUND | FLAG.FINISHED })); }
  assert.ok(!rc.includes('gesture_cheer'), rc.join(' > '));
});

// a recorded ghost is positions only: a riser of the given height at 1.5 s of a run, sampled every `every` seconds, linearly interpolated
function stepUp(every, h) {
  const samples = [];
  for (let t = 0; t <= 3 + every; t += every) samples.push([0, t > 1.5 ? h : 0, -t * RUN]);
  const at = (t) => { const f = t / every, i = Math.min(samples.length - 2, Math.floor(f)), k = f - i; return samples[i].map((v, c) => v + (samples[i + 1][c] - v) * k); };
  const b = new AnimBrain();
  let air = 0;
  const clips = [];
  for (let t = 0; t < 3; t += DT) { const o = rec(clips, b.update(DT, { pos: at(t), yaw: 0, flags: GROUND, infer: true })); if (o.air) air++; }
  return { airSeconds: air * DT, clips };
}
for (const [every, h] of [[0.1, 0.22], [0.05, 0.18]]) {
  test(`BUG: gorge anim, infer: a ${h * 100} cm step-up in a ${1 / every} Hz recording (the sim allows 35 cm) is no jump - no Takeoff / Land flash`, () => {
    const r = stepUp(every, h);
    assert.ok(r.airSeconds <= 0.03 && !r.clips.some((c) => c.endsWith('_Land')), `${r.airSeconds.toFixed(2)} s of air: ${r.clips.join(' > ')}`);
  });
}

test('gorge anim: a random storm of positions, flags, frame times, yaws and respawns only yields clips that exist in the glb, with finite speeds and fades', () => {
  const rnd = mulberry32(20241017);
  for (const infer of [false, true]) {
    const b = new AnimBrain();
    let pos = [0, 0, 0], vel = [0, 0, 0], flags = GROUND;
    for (let i = 0; i < 4000; i++) {
      const dt = 1 / 240 + rnd() * (1 / 12);
      if (rnd() < 0.05) vel = [(rnd() - 0.5) * 28, (rnd() - 0.5) * 16, (rnd() - 0.5) * 28];
      if (rnd() < 0.1) flags = Math.floor(rnd() * 64);
      pos = [pos[0] + vel[0] * dt, pos[1] + vel[1] * dt, pos[2] + vel[2] * dt];
      if (rnd() < 0.004) pos = [rnd() * 200 - 100, rnd() * 20, rnd() * 200 - 100];
      const o = b.update(dt, { pos, yaw: (rnd() - 0.5) * 14, flags, infer });
      assert.ok(CLIPS.has(o.clip), `frame ${i} (infer ${infer}): "${o.clip}" is not a clip of the glb`);
      assert.ok(Number.isFinite(o.timeScale) && o.timeScale >= 0.35 && o.timeScale <= 1.6, 'timeScale ' + o.timeScale);
      assert.ok(Number.isFinite(o.fade) && o.fade > 0 && o.fade < 1, 'fade ' + o.fade);
      assert.ok(Number.isFinite(o.speed) && typeof o.loop === 'boolean' && typeof o.air === 'boolean' && 'FRBL'.includes(o.dir));
    }
  }
});

// ================================================================ the model and the figures
const ctx2d = new Proxy({}, { get: (t, k) => (k === 'measureText' ? () => ({ width: 40 }) : () => {}), set: () => true });
const stubBrowser = (serve) => {
  setGlobal('document', { createElement: () => ({ width: 0, height: 0, style: {}, getContext: () => ctx2d }) });
  setGlobal('self', globalThis);
  setGlobal('createImageBitmap', async () => ({ width: 8, height: 8, close() {} }));
  setGlobal('fetch', async (url) => (String(url).includes('local-models/gorge.glb') ? serve() : new Response('no', { status: 404 })));
};
const glbResponse = (bytes) => new Response(bytes, { status: 200, headers: { 'content-type': 'model/gltf-binary' } });
const model = () => glbResponse(fs.readFileSync(GLB));
const missing = () => new Response('no', { status: 404 });

async function setup(serve) {
  stubBrowser(serve);
  const G = await import('../render/gorge.js');
  G.resetGorge();
  const { Figures } = await import('../render/figures.js');
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 1.7, 8);
  const figs = new Figures(scene);
  await G.loadGorge();
  await new Promise((r) => setTimeout(r, 0));
  return { G, figs, scene, camera };
}
const BASE = { name: 'Edge', color: 0xff8a2a, yaw: 0, flags: GROUND, pos: [0, 0, 0] };

test('gorge: a glb cut off halfway, or one without the clips the brain needs, never becomes the Gorge - the figures stay robots and nothing throws', async () => {
  if (!HAVE) return;
  const whole = fs.readFileSync(GLB);
  const noRunF = Buffer.from(whole);
  const at = noRunF.indexOf('"name":"RunF"');
  assert.ok(at > 0, 'set-up: RunF is named in the glb');
  noRunF.write('"name":"RunX"', at);
  for (const [label, bytes] of [['cut off halfway', whole.subarray(0, whole.length >> 1)], ['no RunF clip', noRunF]]) {
    const { G, figs, camera } = await setup(() => glbResponse(bytes));
    assert.equal(G.gorgeTemplate(), null, label);
    figs.upsert('a', { ...BASE, ghost: true, solid: true });
    figs.update(DT, camera);
    assert.equal(figs.info()[0].model, 'robot', label);
    figs.dispose();
  }
});

test('gorge: every one of the 36 clips poses the real mesh inside a sane envelope (finite, no exploding vertices, rigid bone lengths, feet on the ground for the ground clips)', async () => {
  if (!HAVE) return;
  const { G } = await setup(model);
  const tpl = G.gorgeTemplate();
  assert.equal(tpl.clips.size, 36);
  assert.deepEqual([...tpl.clips.keys()].sort(), [...CLIPS].sort());
  const rig = new G.GorgeRig(tpl, { ghost: true, solid: true, color: 0xffffff });
  const bones = [];
  rig.root.traverse((o) => { if (o.isBone) bones.push(o); });
  const bind = new Map(bones.map((b) => [b, b.position.length()]));   // (the template's rest pose, before any clip)
  const v = new THREE.Vector3();
  const groundClips = new Set(['Idle_Rifle', 'Idle_Rest', 'RunF', 'RunB', 'RunL', 'RunR', 'Rifle_Burst', 'gesture_cheer']);
  for (const [name, clip] of tpl.clips) {
    const action = rig.mixer.clipAction(clip);
    action.reset().play();
    const box = new THREE.Box3();
    for (const f of [0, 0.5, 1]) {
      action.time = clip.duration * f;
      rig.mixer.update(0);
      rig.root.updateMatrixWorld(true);
      for (const b of bones) {
        if (b.parent && b.parent.isBone) assert.ok(Math.abs(b.position.length() / bind.get(b) - 1) < 0.03, `${name}: bone ${b.name} changes length (${b.position.length()} vs ${bind.get(b)})`);
      }
      for (const m of rig.skinned) {
        m.skeleton.update();
        const n = m.geometry.attributes.position.count;
        for (let i = 0; i < n; i++) { m.getVertexPosition(i, v); assert.ok(Number.isFinite(v.x + v.y + v.z), `${name}: NaN vertex ${i}`); box.expandByPoint(v); }
      }
    }
    assert.ok(box.min.x > -1.5 && box.max.x < 1.5 && box.min.z > -1.5 && box.max.z < 1.5 && box.min.y > -0.5 && box.max.y < 2.4,
      `${name}: pose envelope ${box.min.toArray().map((c) => c.toFixed(2))} .. ${box.max.toArray().map((c) => c.toFixed(2))}`);
    if (groundClips.has(name)) assert.ok(box.min.y > -0.1 && box.min.y < 0.1, `${name}: the feet are ${box.min.y.toFixed(2)} m from the ground`);
    rig.mixer.stopAllAction();
  }
  rig.dispose();
});

test('gorge: the clip lengths the brain assumes (CLIP_LEN) are the lengths of the extracted clips, in every direction variant', async () => {
  if (!HAVE) return;
  const { G } = await setup(model);
  const clips = G.gorgeTemplate().clips;
  const near = (name, want) => assert.ok(Math.abs(clips.get(name).duration - want) < 0.01, `${name} lasts ${clips.get(name).duration}, the brain assumes ${want}`);
  for (const d of ['', 'F', 'B', 'L', 'R']) { near('Jump' + d + '_Takeoff', CLIP_LEN.takeoff); near('DoubleJump' + d, CLIP_LEN.dj); }
  for (const d of 'FBLR') { near('Dodge' + d, CLIP_LEN.dodge); near('WallDodge' + d, CLIP_LEN.wallDodge); }
  near('gesture_cheer', CLIP_LEN.cheer);
});

for (const yaw of [0.9, -2.2]) {
  test(`figures: the Gorge faces its yaw (${yaw} rad): the toes point along the sim's forward vector and the left foot is on the left`, async () => {
    if (!HAVE) return;
    const { figs, scene, camera } = await setup(model);
    figs.upsert('f', { ...BASE, yaw, pos: [5, 0, -3], ghost: true, solid: true });
    figs.update(DT, camera);
    figs.update(DT, camera);
    scene.updateMatrixWorld(true);
    const P = {};
    scene.getObjectByName('figure:f').traverse((o) => { if (o.isBone) P[o.name] = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld); });
    const toe = P.Bip01_L_Toe0.clone().sub(P.Bip01_L_Foot), lr = P.Bip01_L_Foot.clone().sub(P.Bip01_R_Foot);
    const f = fwdOf(yaw), r = rightOf(yaw);
    assert.ok((toe.x * f[0] + toe.z * f[2]) / Math.hypot(toe.x, toe.z) > 0.6, `toes point ${(toe.x * f[0] + toe.z * f[2]) / Math.hypot(toe.x, toe.z)} of the way along forward`);
    assert.ok(lr.x * r[0] + lr.z * r[2] < -0.1, 'the left foot is on the left side');
    assert.ok(Math.abs(P.Bip01_Pelvis.x - 5) < 0.3 && Math.abs(P.Bip01_Pelvis.z + 3) < 0.3, 'the body stands where the figure is');
    figs.dispose();
  });
}

// watches every geometry, material and texture of a scene (incl. the bone textures a renderer would create) for dispose events
function leakWatch(isShared) {
  const seen = new Map(), disposed = new Set();
  const watch = (x, kind) => { if (x && !seen.has(x)) { seen.set(x, kind); x.addEventListener('dispose', () => disposed.add(x)); } };
  const scan = (scene) => scene.traverse((o) => {
    if (o.geometry && !o.isSprite && o.geometry.type !== 'SphereGeometry') watch(o.geometry, 'geometry');   // (the aura sphere and three's sprite quad are module-wide geometries by design)
    for (const m of [].concat(o.material || [])) { watch(m, 'material'); watch(m.map, 'texture'); watch(m.emissiveMap, 'texture'); }
    if (o.isSkinnedMesh) { if (!o.skeleton.boneTexture) o.skeleton.computeBoneTexture(); watch(o.skeleton.boneTexture, 'bone texture'); }
  });
  const verdict = () => {
    const leaked = [], wrong = [];
    for (const [x, kind] of seen) {
      if (isShared(x)) { if (disposed.has(x)) wrong.push(kind); } else if (!disposed.has(x)) leaked.push(kind);
    }
    return { leaked, wrong, total: seen.size };
  };
  return { scan, verdict };
}
const count = (list) => { const c = {}; for (const k of list) c[k] = (c[k] || 0) + 1; return JSON.stringify(c); };

test('figures: churn - 40 Gorge figures created, rebuilt (ghost / solid / colour) and removed leave an empty scene; their materials, bone textures and labels are disposed, the shared geometry and skin never', async () => {
  if (!HAVE) return;
  const { figs, scene, camera } = await setup(model);
  const w = leakWatch((x) => x.userData && x.userData.shared);
  for (let i = 0; i < 40; i++) {
    const id = 'c' + i;
    figs.upsert(id, { ...BASE, name: 'Churn ' + i, ghost: i % 2 === 0, solid: i % 3 === 0, pos: [i, 0, 0] });
    figs.update(DT, camera);
    w.scan(scene);
    figs.upsert(id, { ghost: i % 2 !== 0 });                   // rebuild 1
    figs.update(DT, camera);
    w.scan(scene);
    figs.upsert(id, { color: 0x44aaff + i, solid: i % 3 !== 0 });   // rebuild 2
    figs.update(DT, camera);
    w.scan(scene);
    if (i % 4 === 3) { for (let k = i - 3; k <= i; k++) figs.remove('c' + k); }   // some leave while others are alive
  }
  figs.clear();
  assert.equal(scene.children.length, 0, 'the scene still holds ' + scene.children.map((c) => c.name || c.type).join(', '));
  const v = w.verdict();
  assert.ok(v.total > 200, 'set-up: watched ' + v.total);
  assert.deepEqual(v.leaked, [], 'never disposed: ' + count(v.leaked));
  assert.deepEqual(v.wrong, [], 'shared things disposed: ' + count(v.wrong));
  figs.upsert('after', { ...BASE, ghost: true });
  figs.update(DT, camera);
  assert.equal(figs.info()[0].model, 'gorge', 'the model still works after the churn');
  figs.dispose();
});

test('figures: churn without the model - 40 robots created, rebuilt and removed leave an empty scene and dispose all their own geometry, materials and labels', async () => {
  const { figs, scene, camera } = await setup(missing);
  const robotBody = (x) => x.isMeshStandardMaterial && x.vertexColors;   // the one vertex-coloured material every robot shares
  const w = leakWatch(robotBody);
  for (let i = 0; i < 40; i++) {
    const id = 'r' + i;
    figs.upsert(id, { ...BASE, name: 'Robot ' + i, ghost: i % 2 === 0, pos: [i, 0, 0] });
    figs.update(DT, camera);
    w.scan(scene);
    figs.upsert(id, { ghost: i % 2 !== 0, color: 0x123456 + i });
    figs.update(DT, camera);
    w.scan(scene);
    if (i % 5 === 4) for (let k = i - 4; k <= i; k++) figs.remove('r' + k);
  }
  figs.clear();
  assert.equal(scene.children.length, 0, 'the scene still holds ' + scene.children.map((c) => c.name || c.type).join(', '));
  const v = w.verdict();
  assert.ok(v.total > 200, 'set-up: watched ' + v.total);
  assert.deepEqual(v.leaked, [], 'never disposed: ' + count(v.leaked));
  figs.dispose();
});

test('figures: the name tag and the trail survive every rebuild (ghost / solid / colour / the model arriving), a new name is shown, label:false removes the tag, one trail per figure', async () => {
  if (!HAVE) return;
  stubBrowser(() => new Promise((resolve) => setTimeout(() => resolve(model()), 20)));
  const G = await import('../render/gorge.js');
  G.resetGorge();
  const { Figures } = await import('../render/figures.js');
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 1.7, 8);
  const figs = new Figures(scene);
  const sprites = () => { const r = []; scene.getObjectByName('figure:t').traverse((o) => { if (o.isSprite) r.push(o); }); return r; };
  const trails = () => scene.children.filter((c) => c.isMesh && !c.name).length;
  figs.upsert('t', { ...BASE, name: 'Tagged', ghost: true, solid: true });
  figs.update(DT, camera);
  assert.equal(figs.info()[0].model, 'robot');
  assert.equal(sprites().length, 2, 'name + colour bar (robot)');
  await G.loadGorge();
  await new Promise((r) => setTimeout(r, 0));
  figs.update(DT, camera);
  assert.equal(figs.info()[0].model, 'gorge');
  assert.equal(sprites().length, 2, 'name + colour bar (after the model arrived)');
  for (const o of [{ ghost: false }, { solid: true, ghost: true }, { color: 0x2ee6d4 }]) {
    figs.upsert('t', o);
    figs.update(DT, camera);
    assert.equal(sprites().length, 2, 'after ' + JSON.stringify(o));
    assert.ok(sprites().every((s) => s.material.map || s.material.color), 'sprites keep their material');
  }
  const before = sprites().find((s) => s.material.map).material.map;
  figs.upsert('t', { name: 'Renamed' });
  assert.notEqual(sprites().find((s) => s.material.map).material.map, before, 'a new name gets a new label texture');
  assert.equal(trails(), 1, 'one trail mesh for the one figure');
  figs.upsert('t', { label: false });
  assert.equal(sprites().length, 0, 'label:false removes the tag and its bar');
  figs.upsert('t', { label: true });
  assert.equal(sprites().length, 2);
  figs.dispose();
});

test('figures: figures removed or disposed while the model is still loading are not resurrected when it arrives, and the late arrival throws nothing', async () => {
  if (!HAVE) return;
  let release;
  stubBrowser(() => new Promise((resolve) => { release = () => resolve(model()); }));
  const G = await import('../render/gorge.js');
  G.resetGorge();
  const { Figures } = await import('../render/figures.js');
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 1.7, 8);
  const gone = new Figures(scene), kept = new Figures(scene);
  gone.upsert('a', { ...BASE, ghost: true });
  gone.upsert('b', { ...BASE, ghost: true, pos: [2, 0, 0] });
  kept.upsert('k', { ...BASE, ghost: true, pos: [4, 0, 0] });
  gone.remove('a');
  gone.dispose();                       // the whole set leaves before the model is there
  gone.update(DT, camera);
  await new Promise((r) => setTimeout(r, 5));
  release();
  await G.loadGorge();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(scene.children.filter((c) => c.name && c.name.startsWith('figure:')).map((c) => c.name), ['figure:k'], 'only the live figure is in the scene');
  kept.update(DT, camera);
  assert.equal(kept.info()[0].model, 'gorge');
  kept.dispose();
  assert.equal(scene.children.length, 0);
});

// ================================================================ real flags end to end: sim -> 20 Hz packets -> race.js -> brain
// The animation brain with real flags is only ever fed by race.js: a peer's 20 Hz `st` packets, drawn 120 ms behind with linear position
// interpolation (flags of the later packet). This replays the proof routes of two maps through the REAL race.js (mock room, virtual clock)
// and runs the brain on what race.js hands the figure, then compares the dodge clips with the dodges the sim made.
function raceApp(maps, figs) {
  const L = new Map();
  const app = {
    maps, settings: { name: 'T' }, local: { name: 'T' }, mapId: 'alpha', get mapHash() { return 'hash-' + app.mapId; },
    mode: 'solo', state: 'menu', pauseFreezes: true, allow: { restart: true, respawn: true },
    world: { ps: { pos: [1, 2, 3], yaw: 0.5, pitch: 0.1 }, cpIndex: 0, playerFlags: () => 1 },
    mapHashOf: (id) => (maps.has(id) ? 'hash-' + id : null), loadMap: async (id) => { app.mapId = id; }, restartRun() {}, startRun() {}, setFrozen() {},
    setMode: (m) => { app.mode = m; }, play: () => { app.state = 'playing'; }, setSetting() {}, showScreen: (id) => { app.ui.current = id; app.emit('screen', { id }); },
    on: (t, cb) => { if (!L.has(t)) L.set(t, new Set()); L.get(t).add(cb); return () => L.get(t).delete(cb); },
    emit: (t, p = {}) => { for (const cb of [...(L.get(t) || [])]) cb(p); },
    figures: { upsert: (id, o) => figs.set(id, o), remove: (id) => figs.delete(id), has: (id) => figs.has(id) },
    hud: { center() {}, standings() {} }, ui: { current: 'menu', toast() {} }, audio: { unlock() {} }, input: { lock: () => Promise.resolve(true) },
  };
  return app;
}

test('BUG: race peers: the dodge clip a peer\'s figure plays has the direction of the sim\'s dodge, through the real 20 Hz packets + 120 ms interpolation of race.js (two synthetic routes)', async () => {
  const TM = await import('./trystero-mock.mjs');
  const { installClock, installDom, fakeMaps } = await import('./support.mjs');
  const { World } = await import('../sim/world.js');
  const { RouteRunner } = await import('../sim/bot.js');
  const { course, dodgeRoute } = await import('./synth.mjs');
  const { TICK } = await import('../sim/const.js');
  const { initRace } = await import('../race.js');
  // the sim: the synthetic routes (test/synth.mjs: the proof route of the course, and a flat arena full of dodges), tick by tick, and the dodges they make
  const sources = [['course', () => { const map = course(), w = new World(map); return { w, rr: new RouteRunner(w, map.route) }; }], ['dodges', dodgeRoute]];
  const runs = sources.map(([id, make]) => {
    const made = make(), w = made.w, rr = made.rr || made;
    const ticks = [], dodges = [];
    while (rr.tick()) {
      ticks.push([w.ps.pos[0], w.ps.pos[1], w.ps.pos[2], w.ps.yaw, w.ps.pitch, w.playerFlags()]);
      for (const e of w.takeEvents()) if (e.type === 'dodge' || e.type === 'walldodge') dodges.push({ at: (ticks.length - 1) / TICK * 1000, dir: e.dir, yaw: w.ps.yaw });
    }
    return { id, ticks, dodges };
  });
  assert.ok(runs.every((r) => r.dodges.length >= 5), 'set-up: the routes dodge ' + runs.map((r) => r.dodges.length).join(' / '));
  // race.js with a mock room and a virtual clock, one remote peer per route
  TM.reset();
  const clock = installClock();
  installDom();
  const figs = new Map();
  const app = raceApp(fakeMaps(), figs);
  initRace(app);
  app.race.enter('ABCD', true);
  const room = () => TM.rooms[TM.rooms.length - 1];
  const peers = runs.map((r, i) => {
    const id = 'peer' + i;
    room().onPeerJoin(id);
    room().actions.hello.onMessage({ name: id, mh: 'hash-alpha', host: '' }, { peerId: id });
    return { id, run: r, brain: new AnimBrain(), seen: [], last: -1 };
  });
  // send packets exactly as sendState does (cm, yaw x100), 3 frames of ~16.7 ms between two packets; the figure is fed to the brain every frame
  const N = Math.max(...runs.map((r) => r.ticks.length));
  let vt = 0;
  for (let k = 0; k * 6 < N; k++) {
    for (const p of peers) {
      const t = p.run.ticks[Math.min(p.run.ticks.length - 1, k * 6)];
      room().actions.st.onMessage([Math.round(t[0] * 100), Math.round(t[1] * 100), Math.round(t[2] * 100), Math.round(t[3] * 100), Math.round(t[4] * 100), 0, t[5] | 0], { peerId: p.id });
    }
    for (const step of [16, 17, 17]) {
      await clock.advance(step);
      vt += step;
      app.emit('tick');
      for (const p of peers) {
        const f = figs.get('p:' + p.id);
        if (!f) continue;
        const o = p.brain.update(step / 1000, { pos: f.pos, yaw: f.yaw, flags: f.flags });
        if (o.seq !== p.last && /^(Dodge|WallDodge)/.test(o.clip)) p.seen.push({ at: vt - 120, clip: o.clip });   // (race.js draws 120 ms behind: back to sim time)
        p.last = o.seq;
      }
    }
  }
  const letter = (d, yaw) => {
    const f = fwdOf(yaw), r = rightOf(yaw);
    return 'FRBL'[((Math.round(Math.atan2(d[0] * r[0] + d[2] * r[2], d[0] * f[0] + d[2] * f[2]) / (Math.PI / 2)) % 4) + 4) % 4];
  };
  let good = 0, total = 0;
  const bad = [];
  for (const p of peers) {
    for (const d of p.run.dodges) {
      const s = p.seen.find((x) => x.at >= d.at - 60 && x.at <= d.at + 450);
      if (!s) continue;   // (a dodge that never became a clip is not a direction error)
      total++;
      if (s.clip.endsWith(letter(d.dir, d.yaw))) good++; else bad.push(`${p.run.id} @${(d.at / 1000).toFixed(1)}s sim ${letter(d.dir, d.yaw)} shown ${s.clip}`);
    }
  }
  assert.ok(total >= 10, 'set-up: ' + total + ' dodges were shown at all');
  assert.ok(good / total >= 0.8, `${good} of ${total} dodge clips have the sim's direction (want >= 80%); wrong: ${bad.slice(0, 4).join('; ')}`);
});
