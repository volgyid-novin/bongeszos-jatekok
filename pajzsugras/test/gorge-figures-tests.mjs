// render/figures.js + render/gorge.js with real three.js objects (a Scene, no renderer): the robot fallback, loading the local Gorge model,
// the clips a figure plays, ghost / solid materials, and that disposing a figure never touches the shared model.
// The Gorge cases need the local model (pajzsugras/local-models/gorge.glb, made by tools/ut2004_extract.py, git-ignored): they pass
// without checking anything when it is not there. A stub document / fetch / createImageBitmap stand in for the browser.
import fs from 'node:fs';
import * as THREE from 'three';
import { test, assert, setGlobal } from './harness.mjs';
import { FLAG, RUN } from '../sim/const.js';

const GLB = new URL('../local-models/gorge.glb', import.meta.url);
const HAVE = fs.existsSync(GLB);
const DT = 1 / 60;

const ctx2d = new Proxy({}, { get: (t, k) => (k === 'measureText' ? () => ({ width: 40 }) : () => {}), set: () => true });
const stubBrowser = (serve) => {
  setGlobal('document', { createElement: () => ({ width: 0, height: 0, style: {}, getContext: () => ctx2d }) });
  setGlobal('self', globalThis);
  setGlobal('createImageBitmap', async () => ({ width: 8, height: 8, close() {} }));
  setGlobal('fetch', async (url, o) => (String(url).includes('local-models/gorge.glb') ? serve() : new Response('no', { status: 404 })));
};
const missing = () => new Response('no', { status: 404 });
const html = () => new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
const model = () => new Response(fs.readFileSync(GLB), { status: 200, headers: { 'content-type': 'model/gltf-binary' } });

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
  return { G, figs, scene, camera };
}
// run a figure for `sec` seconds, moving it with the velocity v and the flags; returns the figure info after
function drive(figs, camera, id, o, sec, v = [0, 0, 0], st = {}) {
  st.pos = st.pos || o.pos.slice();
  for (let i = 0; i < Math.round(sec / DT); i++) {
    st.pos = [st.pos[0] + v[0] * DT, st.pos[1] + v[1] * DT, st.pos[2] + v[2] * DT];
    figs.upsert(id, { ...o, pos: st.pos });
    figs.update(DT, camera);
  }
  return figs.info().find((f) => f.id === id);
}

test('figures: without the local model (404, or the dev server\'s HTML fallback) every figure is the robot and nothing breaks', async () => {
  for (const serve of [missing, html]) {
    const { figs, camera, G } = await setup(serve);
    assert.equal(G.gorgeTemplate(), null);
    figs.upsert('a', { name: 'Anna', color: 0xff8a2a, pos: [0, 0, 0], yaw: 0, flags: FLAG.GROUND, ghost: true, solid: true });
    figs.upsert('b', { name: 'Bob', color: 0x2ee6d4, pos: [2, 0, 0], yaw: 1, flags: 0 });
    const f = drive(figs, camera, 'a', { name: 'Anna', color: 0xff8a2a, yaw: 0, flags: FLAG.GROUND, ghost: true, solid: true, pos: [0, 0, 0] }, 0.5, [0, 0, -RUN]);
    assert.equal(f.model, 'robot');
    assert.equal(figs.info().length, 2);
    figs.upsert('a', { ghost: false });   // rebuilds
    figs.update(DT, camera);
    figs.remove('a'); figs.remove('b');
    assert.equal(figs.info().length, 0);
    figs.dispose();
  }
});

test('figures: the Gorge loads from the local glb (36 clips, 28 bones, 2 skinned meshes) and a figure uses it; an HTML page or junk bytes never do', async () => {
  const bad = await setup(() => new Response(new Uint8Array(4000), { status: 200, headers: { 'content-type': 'application/octet-stream' } }));
  assert.equal(bad.G.gorgeTemplate(), null, 'bytes that are not a glb');
  if (!HAVE) return;   // (the model is a local, git-ignored file)
  const { G, figs, camera } = await setup(model);
  const tpl = G.gorgeTemplate();
  assert.ok(tpl, 'template');
  assert.equal(tpl.clips.size, 36);
  assert.equal(tpl.bones, 28);
  for (const n of ['Idle_Rifle', 'RunF', 'RunB', 'RunL', 'RunR', 'Jump_Mid', 'JumpF_Takeoff', 'JumpL_Land', 'DoubleJumpR', 'DodgeB', 'WallDodgeF', 'gesture_cheer']) assert.ok(tpl.clips.has(n), n);
  assert.ok(Math.abs(tpl.clips.get('RunF').duration - 20 / 30) < 1e-3, 'RunF loops in 0.667 s');
  const f = drive(figs, camera, 'g', { name: 'Gorge', color: 0x2ee6d4, yaw: 0, flags: FLAG.GROUND, ghost: true, solid: true, pos: [0, 0, 0] }, 0.6);
  assert.equal(f.model, 'gorge');
  assert.equal(f.skinned, 2);
  assert.equal(f.bones, 28);
  assert.equal(f.clip, 'Idle_Rifle');
  assert.equal(f.translucent, false, 'a solid figure is opaque');
  figs.dispose();
});

test('figures: a Gorge figure plays RunF / RunL, JumpF_Takeoff -> JumpF_Mid, DoubleJump and Dodge from real flags, cross-fading (weights add up to 1) and facing along its yaw', async () => {
  if (!HAVE) return;
  const { figs, camera, scene } = await setup(model);
  const st = {};
  const base = { name: 'G', color: 0xff8a2a, yaw: 0, flags: FLAG.GROUND, ghost: true, solid: true, pos: [0, 0, 0] };
  let f = drive(figs, camera, 'g', base, 0.7, [0, 0, -RUN], st);
  assert.equal(f.clip, 'RunF');
  assert.ok(Math.abs(f.timeScale - 1) < 0.1);
  assert.ok(f.time >= 0 && f.time <= 0.68, 'time inside the looped clip: ' + f.time);
  // a direction change cross-fades: two clips are active for a moment
  figs.upsert('g', { ...base, pos: st.pos });
  let seen2 = false;
  for (let i = 0; i < 40; i++) {
    st.pos = [st.pos[0] - RUN * DT, st.pos[1], st.pos[2]];   // now running to the left (-X)
    figs.upsert('g', { ...base, pos: st.pos }); figs.update(DT, camera);
    const fi = figs.info().find((x) => x.id === 'g');
    if (fi.active.length > 1) seen2 = true;
  }
  f = figs.info().find((x) => x.id === 'g');
  assert.equal(f.clip, 'RunL');
  assert.ok(seen2, 'RunF faded out while RunL faded in');
  assert.equal(f.active.length, 1, 'the fade is over');
  // a figure turned to face +X runs "forward" along +X
  const t = {};
  f = drive(figs, camera, 'h', { ...base, yaw: -Math.PI / 2, pos: [5, 0, 0] }, 0.7, [RUN, 0, 0], t);
  assert.equal(f.clip, 'RunF', 'the facing is the yaw: -90 deg looks along +X');
  // jump: flags without GROUND
  const j = {};
  drive(figs, camera, 'j', { ...base, pos: [10, 0, 0] }, 0.5, [0, 0, -RUN], j);
  f = drive(figs, camera, 'j', { ...base, flags: 0, pos: j.pos }, 0.15, [0, 6, -RUN], j);
  assert.equal(f.clip, 'JumpF_Takeoff');
  f = drive(figs, camera, 'j', { ...base, flags: 0, pos: j.pos }, 0.4, [0, 0, -RUN], j);
  assert.equal(f.clip, 'JumpF_Mid');
  f = drive(figs, camera, 'j', { ...base, flags: FLAG.DJ_USED, pos: j.pos }, 0.3, [0, 3, -RUN], j);
  assert.equal(f.clip, 'DoubleJumpF');
  assert.equal(f.loop, false);
  // dodge to the right from standing
  const d = {};
  drive(figs, camera, 'd', { ...base, pos: [20, 0, 0] }, 0.3, [0, 0, 0], d);
  f = drive(figs, camera, 'd', { ...base, flags: FLAG.DODGING, pos: d.pos }, 0.25, [13.2, 4, 0], d);
  assert.equal(f.clip, 'DodgeR');
  // the pose is really applied: the head is about 1.4 m above the figure's feet, in the mixer-driven skeleton
  figs.update(DT, camera);
  scene.updateMatrixWorld(true);
  let head = null;
  scene.getObjectByName('figure:j').traverse((o) => { if (o.isBone && o.name === 'Bip01_Head') head = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld); });
  assert.ok(head && head.y > j.pos[1] + 1.2 && head.y < j.pos[1] + 1.8, 'head height ' + (head && head.y - j.pos[1]));
  figs.dispose();
});

test('figures: the finish cheer, and a recorded ghost (infer: true, flags always GROUND) that jumps is drawn as in the air', async () => {
  if (!HAVE) return;
  const { figs, camera } = await setup(model);
  const base = { name: 'G', color: 0xff8a2a, yaw: 0, flags: FLAG.GROUND, ghost: true, pos: [0, 0, 0] };
  drive(figs, camera, 'c', base, 0.4);
  let f = drive(figs, camera, 'c', { ...base, flags: FLAG.GROUND | FLAG.FINISHED, pos: [0, 0, 0] }, 0.3);
  assert.equal(f.clip, 'gesture_cheer');
  // a ghost: only positions; a ballistic hop
  const g = { ...base, infer: true, ghost: true };
  const st = { pos: [0, 0, 0] };
  const arcY = (t) => 7.6 * t - 0.5 * 19 * t * t;
  let t = 0;
  const clips = new Set();
  for (; t < 1.5; t += DT) {
    const y = t > 0.5 && t < 0.5 + 2 * 7.6 / 19 ? arcY(t - 0.5) : 0;
    figs.upsert('gh', { ...g, pos: [0, y, -RUN * t] });
    figs.update(DT, camera);
    clips.add(figs.info().find((x) => x.id === 'gh').clip);
  }
  assert.ok([...clips].some((c) => c.endsWith('_Mid')), 'the ghost hop shows an air clip: ' + [...clips].join(', '));
  assert.ok(clips.has('RunF'), 'and runs before it');
  figs.dispose();
});

test('figures: ghost = translucent skin x colour with a depth-only copy; solid = opaque standard material with a rim; materials are per figure, the skin texture is shared', async () => {
  if (!HAVE) return;
  const { figs, camera, scene } = await setup(model);
  const base = { name: 'G', yaw: 0, flags: FLAG.GROUND, pos: [0, 0, 0] };
  figs.upsert('ghost', { ...base, color: 0xff8a2a, ghost: true });
  figs.upsert('solid', { ...base, color: 0x2ee6d4, ghost: true, solid: true, pos: [3, 0, 0] });
  figs.upsert('solid2', { ...base, color: 0xffffff, ghost: false, pos: [-3, 0, 0] });
  figs.update(DT, camera);
  const meshes = (id) => { const r = []; scene.getObjectByName('figure:' + id).traverse((o) => { if (o.isSkinnedMesh) r.push(o); }); return r; };
  const gm = meshes('ghost'), sm = meshes('solid'), s2 = meshes('solid2');
  assert.equal(gm.length, 4, 'two skinned meshes + two depth-only copies');
  const colour = gm.filter((m) => !m.name.endsWith(':depth')), depth = gm.filter((m) => m.name.endsWith(':depth'));
  assert.equal(colour.length, 2); assert.equal(depth.length, 2);
  for (const m of colour) { assert.equal(m.material.transparent, true); assert.equal(m.material.depthWrite, false); assert.ok(m.material.map, 'textured'); assert.equal(m.castShadow, false); }
  for (const m of depth) { assert.equal(m.material.colorWrite, false); assert.equal(m.material.transparent, false); }
  assert.equal(sm.length, 2);
  for (const m of sm) { assert.equal(m.material.transparent, false); assert.ok(m.material.isMeshStandardMaterial); assert.ok(m.material.userData.rim, 'rim colour'); assert.equal(m.castShadow, true); }
  assert.notEqual(sm[0].material, s2[0].material, 'materials are per figure');
  assert.equal(sm[0].material.map, s2[0].material.map, 'the skin texture is shared');
  assert.equal(sm[0].geometry, s2[0].geometry, 'so is the geometry');
  assert.equal(sm[0].geometry, colour[0].geometry);
  assert.notEqual(sm[0].skeleton, s2[0].skeleton, 'the skeleton is per figure');
  // the ghost fades with the camera distance, and disappears inside the figure
  camera.position.set(0, 1.7, 4);
  figs.update(DT, camera);
  const far = colour[0].material.opacity;
  camera.position.set(0, 1.7, 1.5);
  figs.update(DT, camera);
  assert.ok(colour[0].material.opacity < far, 'closer = more transparent');
  camera.position.set(0, 1.0, 0.2);   // (the fade measures from the feet)
  figs.update(DT, camera);
  assert.equal(scene.getObjectByName('figure:ghost').visible, false, 'invisible with the camera inside');
  figs.dispose();
});

test('figures: removing / rebuilding a Gorge figure disposes its own materials and bone textures but never the shared geometry or skin; the model keeps working', async () => {
  if (!HAVE) return;
  const { G, figs, camera } = await setup(model);
  const tpl = G.gorgeTemplate();
  let geoDisposed = 0, texDisposed = 0;
  const skinned = []; tpl.scene.traverse((o) => { if (o.isSkinnedMesh) skinned.push(o); });
  for (const m of skinned) { m.geometry.addEventListener('dispose', () => geoDisposed++); if (m.material.map) m.material.map.addEventListener('dispose', () => texDisposed++); }
  const base = { name: 'G', yaw: 0, flags: FLAG.GROUND, pos: [0, 0, 0], color: 0xff8a2a };
  for (let k = 0; k < 3; k++) {
    figs.upsert('x', { ...base, ghost: true });
    figs.update(DT, camera);
    figs.upsert('x', { ...base, ghost: true, solid: true });      // rebuild: translucent -> solid
    figs.update(DT, camera);
    figs.upsert('x', { ...base, ghost: false, color: 0x44aaff });  // rebuild again
    figs.update(DT, camera);
    figs.remove('x');
  }
  assert.equal(geoDisposed, 0, 'shared geometry disposed');
  assert.equal(texDisposed, 0, 'shared texture disposed');
  figs.upsert('y', { ...base, ghost: true });
  const f = drive(figs, camera, 'y', { ...base, ghost: true }, 0.3);
  assert.equal(f.model, 'gorge');
  figs.clear();
  assert.equal(geoDisposed, 0);
  figs.dispose();
});

test('figures: figures created before the model arrives are robots and become Gorges when it loads', async () => {
  if (!HAVE) return;
  stubBrowser(() => new Promise((resolve) => setTimeout(() => resolve(model()), 30)));
  const G = await import('../render/gorge.js');
  G.resetGorge();
  const { Figures } = await import('../render/figures.js');
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 1.7, 8);
  const figs = new Figures(scene);
  figs.upsert('a', { name: 'A', color: 0xff8a2a, pos: [0, 0, 0], yaw: 0, flags: FLAG.GROUND, ghost: true, solid: true });
  figs.update(DT, camera);
  assert.equal(figs.info()[0].model, 'robot');
  await G.loadGorge();
  await new Promise((r) => setTimeout(r, 0));
  figs.update(DT, camera);
  assert.equal(figs.info()[0].model, 'gorge', 'rebuilt when the template arrived');
  figs.dispose();
});

test('figures: a solid Gorge is hidden while the camera is inside its body (the race countdown: every runner on the start, eyes 1.6 m above the feet) and visible again outside', async () => {
  if (!HAVE) return;
  const { figs, scene, camera } = await setup(model);
  const base = { name: 'S', color: 0xff8a2a, yaw: 0, flags: FLAG.GROUND, ghost: true, solid: true, pos: [0, 0, 0] };
  for (let i = 0; i < 7; i++) figs.upsert('s' + i, { ...base, pos: [0, 0, 0], color: 0x2ee6d4 + i });
  figs.upsert('plain', { ...base, ghost: false, pos: [0, 0, 0] });
  const shown = () => [...figs.map.keys()].filter((id) => scene.getObjectByName('figure:' + id).visible);
  const at = (x, y, z) => { camera.position.set(x, y, z); figs.update(DT, camera); return shown(); };
  assert.deepEqual(at(0, 1.6, 0), [], 'the camera at [0, 1.6, 0] is inside all eight bodies');
  assert.deepEqual(at(0.4, 1.3, -0.3), [], 'still inside the body (0.5 m from the axis, chest height)');
  assert.equal(at(0, 1.6, 1.2).length, 8, '1.2 m away: all visible');
  assert.equal(at(1.0, 1.6, 0).length, 8, '1 m to the side: visible');
  assert.equal(at(0, 2.6, 0).length, 8, 'above the head: visible');
  assert.equal(at(0, -0.6, 0).length, 8, 'below the feet: visible');
  assert.deepEqual(at(0, 1.6, 0), [], 'and gone again');
  figs.dispose();
});

test('figures: the depth-only prepass of a ghost draws after the opaque level (renderOrder above the default 0), the colour pass does not claim it', async () => {
  if (!HAVE) return;
  const { figs, scene, camera } = await setup(model);
  figs.upsert('g', { name: 'G', color: 0xff8a2a, yaw: 0, flags: FLAG.GROUND, ghost: true, pos: [0, 0, 0] });
  figs.update(DT, camera);
  const pre = [], col = [];
  scene.getObjectByName('figure:g').traverse((o) => { if (o.isSkinnedMesh) (o.name.endsWith(':depth') ? pre : col).push(o); });
  assert.equal(pre.length, 2); assert.equal(col.length, 2);
  for (const m of pre) assert.ok(m.renderOrder > 0 && m.material.colorWrite === false, 'prepass renderOrder ' + m.renderOrder);
  for (const m of col) assert.equal(m.renderOrder, 0);
  figs.dispose();
});

test('figures: warm() compiles hidden solid + ghost rigs against the figure scene with the renderer (nothing is added to the scene), survives a failing compile, and replaces its rigs on the next call', async () => {
  if (!HAVE) return;
  const { figs, scene, camera } = await setup(model);
  const calls = [];
  const renderer = { compileAsync: async (holder, cam, target) => { calls.push({ holder, cam, target, mats: new Set() }); holder.traverse((o) => { if (o.isMesh) calls[calls.length - 1].mats.add(o.material); }); } };
  const before = scene.children.length;
  await figs.warm(renderer, camera);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].target, scene, 'compiled against the figure scene (its lights and environment)');
  assert.notEqual(calls[0].holder, scene, 'in a holder scene of its own');
  assert.equal(scene.children.length, before, 'nothing is added to the figure scene');
  assert.ok([...calls[0].mats].some((m) => m.isMeshStandardMaterial) && [...calls[0].mats].some((m) => m.isMeshBasicMaterial && m.transparent) && [...calls[0].mats].some((m) => m.isMeshBasicMaterial && m.colorWrite === false),
    'solid, ghost and depth-only materials were all handed over');
  assert.equal(figs.warmRigs.length, 2);
  const first = figs.warmRigs.slice();
  await figs.warm();   // (remembers the renderer: this is what the model arriving late does)
  assert.equal(calls.length, 2);
  assert.ok(figs.warmRigs.every((r) => !first.includes(r)), 'new rigs');
  await figs.warm({ compileAsync: async () => { throw new Error('no GL'); } }, camera);   // a failing compile is ignored
  assert.equal(figs.warmRigs.length, 2);
  figs.dispose();
  assert.equal(figs.warmRigs.length, 0);
  // without the model there is nothing to compile
  const none = await setup(missing);
  let n = 0;
  await none.figs.warm({ compileAsync: async () => { n++; } }, none.camera);
  assert.equal(n, 0);
  none.figs.dispose();
});

test('gorge: a glb over 32 MB is refused (by its content-length, or while streaming a chunked body) and never parsed; a normal one still loads', async () => {
  const sizes = { big: 33 * 1024 * 1024 };
  const lengthy = () => new Response(new Uint8Array(100), { status: 200, headers: { 'content-type': 'model/gltf-binary', 'content-length': String(sizes.big) } });
  let pulled = 0;
  const chunked = () => new Response(new ReadableStream({
    pull(ctrl) { pulled++; ctrl.enqueue(new Uint8Array(1024 * 1024).fill(1)); if (pulled > 40) ctrl.close(); },
  }), { status: 200, headers: { 'content-type': 'model/gltf-binary' } });
  const a = await setup(lengthy);
  assert.equal(a.G.gorgeTemplate(), null, 'content-length over the cap');
  const b = await setup(chunked);
  assert.equal(b.G.gorgeTemplate(), null, 'a chunked body over the cap');
  assert.ok(pulled <= 36, 'the stream was cut off at the cap, not read to the end (' + pulled + ' MB pulled)');
  if (!HAVE) return;
  const c = await setup(model);
  assert.ok(c.G.gorgeTemplate(), 'the real 2.7 MB file is fine');
});

test('figures: unwrap() cuts the loop copy of the first key off a held clip, and leaves a clip that does not end on its first pose alone', async () => {
  const { unwrap } = await import('../render/gorge.js');
  const wrapped = new THREE.AnimationClip('JumpF_Mid', 0.3, [new THREE.VectorKeyframeTrack('b.position', [0, 0.1, 0.2, 0.3], [0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 0, 0])]);
  unwrap(wrapped);
  assert.ok(Math.abs(wrapped.duration - 0.2) < 1e-6, 'held on the real last frame: ' + wrapped.duration);
  assert.equal(wrapped.tracks[0].times.length, 3);
  const open = new THREE.AnimationClip('X', 0.3, [new THREE.VectorKeyframeTrack('b.position', [0, 0.1, 0.2, 0.3], [0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0])]);
  unwrap(open);
  assert.ok(Math.abs(open.duration - 0.3) < 1e-6 && open.tracks[0].times.length === 4, 'not wrapped: untouched');
});
