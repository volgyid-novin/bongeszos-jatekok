// render/shieldgun.js, render/viewmodel.js and the gun in the Gorge's hand (figures.js): the UT2004 shield gun is an OPTIONAL local model (the
// player's own extract in pajzsugras/local-models/: shieldgun-1st.glb, shieldgun-3rd.glb, the editable shieldgun.png). Without it the procedural
// gauntlet stays and the figures hold nothing. (The gun is only used on a local dev build: renderer.js imports shieldgun.js then and calls viewmodel.useUT / figures.refreshGuns, as these cases do.)
// Most cases build their own tiny glb in code (a triangle, three bones, the clips the extractor writes) and stub fetch / createImageBitmap, so they
// run without any Epic data. The cases that look at the real model (placement, clip lengths) need the git-ignored local files and pass without
// checking anything when they are not there; the real gorge-body.png / gorge-head.png / shieldgun.png of the player are never read.
import fs from 'node:fs';
import * as THREE from 'three';
import { test, assert, setGlobal } from './harness.mjs';
import { FLAG } from '../sim/const.js';

const LOCAL = (f) => new URL('../local-models/' + f, import.meta.url);
const REAL = { first: fs.existsSync(LOCAL('shieldgun-1st.glb')), third: fs.existsSync(LOCAL('shieldgun-3rd.glb')), gorge: fs.existsSync(LOCAL('gorge.glb')) };
const MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const pngBytes = (n) => { const b = new Uint8Array(n); b.set(MAGIC); b.fill(7, 8); return b; };
const PNG1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

// ---------------------------------------------------------------- a tiny glb like the extractor's: ShieldGun > Bone_weapon > (Bone_antenna, Bone_Flash), one skinned triangle, one skin
const DURATIONS = { Idle: 3, Select: 0.5, PutDown: 0.5, Charge: 1, Charged: 1, Fire: 0.5, Shield: 1 };
function tinyGlb({ clips = DURATIONS, skin = 'ShieldTex0', skinned = true } = {}) {
  const chunks = []; let len = 0;
  const views = [], accs = [];
  const view = (typed) => {
    const pad = (4 - (len % 4)) % 4;
    if (pad) { chunks.push(new Uint8Array(pad)); len += pad; }
    const u8 = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
    views.push({ buffer: 0, byteOffset: len, byteLength: u8.length });
    chunks.push(u8); len += u8.length;
    return views.length - 1;
  };
  const acc = (typed, componentType, type, count, extra = {}) => { accs.push({ bufferView: view(typed), componentType, type, count, ...extra }); return accs.length - 1; };
  const A = {
    POSITION: acc(new Float32Array([0, 0, 0, 0.1, 0, 0, 0, 0.1, 0]), 5126, 'VEC3', 3, { min: [0, 0, 0], max: [0.1, 0.1, 0] }),
    NORMAL: acc(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 5126, 'VEC3', 3),
    TEXCOORD_0: acc(new Float32Array([0, 0, 1, 0, 0, 1]), 5126, 'VEC2', 3),
    JOINTS_0: acc(new Uint8Array(12), 5121, 'VEC4', 3),
    WEIGHTS_0: acc(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), 5126, 'VEC4', 3),
  };
  const idx = acc(new Uint16Array([0, 1, 2]), 5123, 'SCALAR', 3);
  const ibm = acc(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -0.5, 0, 1,  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1]), 5126, 'MAT4', 3);
  const imgView = view(new Uint8Array(PNG1));
  const animations = Object.entries(clips).map(([name, dur]) => ({
    name,
    samplers: [{ input: acc(new Float32Array([0, dur]), 5126, 'SCALAR', 2, { min: [0], max: [dur] }), output: acc(new Float32Array([0, 0, -1, 0, 0, -1.2]), 5126, 'VEC3', 2), interpolation: 'LINEAR' }],
    channels: [{ sampler: 0, target: { node: 3, path: 'translation' } }],
  }));
  const nodes = [
    { name: 'ShieldGun', children: skinned ? [1, 4] : [1] },
    { name: 'Bone_weapon', children: [2, 3] },
    { name: 'Bone_antenna', translation: [0, 0.5, 0] },
    { name: 'Bone_Flash', translation: [0, 0, -1] },
  ];
  const gltf = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes,
    materials: [{ name: skin, pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.85 } }],
    textures: [{ sampler: 0, source: 0 }], images: [{ bufferView: imgView, mimeType: 'image/png', name: skin }],
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
    animations, accessors: accs, bufferViews: views,
  };
  if (skinned) {
    nodes.push({ name: 'ShieldGunMesh', mesh: 0, skin: 0 });
    gltf.meshes = [{ name: 'ShieldGun', primitives: [{ attributes: A, indices: idx, material: 0, mode: 4 }] }];
    gltf.skins = [{ joints: [1, 2, 3], skeleton: 1, inverseBindMatrices: ibm }];
  }
  const pad = (4 - (len % 4)) % 4;
  if (pad) { chunks.push(new Uint8Array(pad)); len += pad; }
  gltf.buffers = [{ byteLength: len }];
  let js = Buffer.from(JSON.stringify(gltf), 'utf8');
  js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const bin = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  const head = Buffer.alloc(12 + 8), mid = Buffer.alloc(8);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8);
  head.writeUInt32LE(js.length, 12); head.writeUInt32LE(0x4e4f534a, 16);
  mid.writeUInt32LE(bin.length, 0); mid.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([head, js, mid, bin]);
}
const glbResponse = (buf) => () => new Response(buf, { status: 200, headers: { 'content-type': 'model/gltf-binary' } });
const html = () => new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
const missing = () => new Response('no', { status: 404 });

// fetch + createImageBitmap + document stubs; files: file name -> () => Response | 'throw' (anything else: 404)
function stub(files = {}) {
  const calls = [];
  const ctx2d = new Proxy({}, { get: (t, k) => (k === 'measureText' ? () => ({ width: 40 }) : () => {}), set: () => true });
  setGlobal('document', { createElement: () => ({ width: 0, height: 0, style: {}, getContext: () => ctx2d }) });
  setGlobal('self', globalThis);
  setGlobal('createImageBitmap', async (blob) => ({ width: 8, height: 8, size: blob.size, close() {} }));
  setGlobal('fetch', async (url) => {
    calls.push(String(url));
    const f = files[String(url).split('/').pop()];
    if (f === 'throw') throw new TypeError('network down');
    return f ? f() : missing();
  });
  return calls;
}
const BOTH = (extra = {}) => ({ 'shieldgun-1st.glb': glbResponse(tinyGlb()), 'shieldgun-3rd.glb': glbResponse(tinyGlb({ clips: { Still: 0.033 } })), ...extra });

async function load(files) {
  const calls = stub(files);
  const S = await import('../render/shieldgun.js');
  S.resetShieldGun();
  const tpl = await S.loadShieldGun();
  return { S, tpl, calls };
}
const R3 = (v) => Math.round(v * 1000) / 1000;

// ================================================================ the loader
test('shield gun loader: without the local files (404, the dev server\'s HTML fallback, junk, a glTF that is too small, a failing fetch) both models are null and nothing throws', async () => {
  const cases = {
    '404': {},
    'HTML fallback': { 'shieldgun-1st.glb': html, 'shieldgun-3rd.glb': html },
    'junk bytes': { 'shieldgun-1st.glb': () => new Response(new Uint8Array(4000), { status: 200 }), 'shieldgun-3rd.glb': () => new Response(new Uint8Array(4000), { status: 200 }) },
    'a glTF header and nothing behind it': { 'shieldgun-1st.glb': () => new Response(Buffer.concat([Buffer.from('glTF'), Buffer.alloc(100)]), { status: 200 }), 'shieldgun-3rd.glb': () => new Response(Buffer.from('glTF'), { status: 200 }) },
    'network error': { 'shieldgun-1st.glb': 'throw', 'shieldgun-3rd.glb': 'throw' },
    'a server error': { 'shieldgun-1st.glb': () => new Response('boom', { status: 500 }), 'shieldgun-3rd.glb': () => new Response('no', { status: 403 }) },
  };
  for (const [label, files] of Object.entries(cases)) {
    const { S, tpl } = await load(files);
    assert.deepEqual(tpl, { first: null, third: null }, label);
    assert.deepEqual(S.shieldGunTemplates(), { first: null, third: null }, label);
  }
});

test('shield gun loader: the two glbs load from plain string paths next to each other, once; a second call is the same promise', async () => {
  const { S, tpl, calls } = await load(BOTH());
  assert.ok(tpl.first && tpl.third);
  assert.deepEqual(calls.filter((u) => u.endsWith('.glb')).sort(), ['./local-models/shieldgun-1st.glb', './local-models/shieldgun-3rd.glb']);
  assert.deepEqual([...tpl.first.clips.keys()].sort(), Object.keys(DURATIONS).sort());
  assert.deepEqual([...tpl.third.clips.keys()], ['Still']);
  for (const t of [tpl.first, tpl.third]) {
    assert.equal(t.bones, 3);
    assert.equal(typeof t.clone, 'function');
    t.scene.traverse((o) => { if (o.isSkinnedMesh) { assert.equal(o.geometry.userData.shared, true); assert.equal(o.material.userData.shared, true); assert.equal(o.material.name, 'ShieldTex0'); assert.ok(o.material.map, 'the skin is embedded'); } });
  }
  const before = calls.length;
  assert.equal(await S.loadShieldGun(), tpl, 'the same result');
  assert.equal(calls.length, before, 'nothing is fetched again');
});

test('shield gun loader: each model stands alone - a first person glb that lacks Idle / Charge / Fire is refused (not our file), a third person glb without a skinned mesh too, and the other one still loads', async () => {
  let r = await load(BOTH({ 'shieldgun-1st.glb': glbResponse(tinyGlb({ clips: { Idle: 1, Charge: 1 } })) }));
  assert.equal(r.tpl.first, null, 'no Fire');
  assert.ok(r.tpl.third, 'the held model does not need the first person clips');
  r = await load(BOTH({ 'shieldgun-3rd.glb': glbResponse(tinyGlb({ clips: { Still: 0.03 }, skinned: false })) }));
  assert.equal(r.tpl.third, null, 'no skinned mesh');
  assert.ok(r.tpl.first);
  r = await load({ 'shieldgun-3rd.glb': glbResponse(tinyGlb({ clips: {} })) });
  assert.equal(r.tpl.first, null, 'only the third person file is there');
  assert.ok(r.tpl.third, 'a held model needs no clip at all');
});

test('shield gun skin: shieldgun.png (the editable ShieldTex0) replaces the glb\'s texture in both models, the glTF way; a missing, HTML or non-PNG file leaves it', async () => {
  const S = await import('../render/shieldgun.js');
  assert.equal(S.shieldSkinFileFor('ShieldTex0'), 'shieldgun.png');
  assert.equal(S.shieldSkinFileFor('shieldtex0'), 'shieldgun.png');
  for (const n of ['', 'JuggMaleABodyA', 'LinkTex0', null, undefined]) assert.equal(S.shieldSkinFileFor(n), null, String(n));
  let { tpl, calls } = await load(BOTH({ 'shieldgun.png': () => new Response(pngBytes(5000), { status: 200, headers: { 'content-type': 'image/png' } }) }));
  assert.deepEqual(tpl.first.skins, ['shieldgun.png']);
  assert.deepEqual(tpl.third.skins, ['shieldgun.png']);
  assert.ok(calls.includes('./local-models/shieldgun.png'));
  for (const t of [tpl.first, tpl.third]) {
    let m = null;
    t.scene.traverse((o) => { if (o.isSkinnedMesh) m = o.material.map; });
    assert.equal(m.image.size, 5000, 'the player\'s file, not the embedded one');
    assert.equal(m.flipY, false);
    assert.equal(m.colorSpace, THREE.SRGBColorSpace);
    assert.equal(m.userData.shared, true);
    assert.equal(m.userData.skinFile, 'shieldgun.png');
  }
  for (const f of [{}, { 'shieldgun.png': html }, { 'shieldgun.png': () => new Response(new Uint8Array(300).fill(65), { status: 200, headers: { 'content-type': 'image/png' } }) }, { 'shieldgun.png': 'throw' }]) {
    ({ tpl } = await load(BOTH(f)));
    assert.deepEqual([tpl.first.skins, tpl.third.skins], [[], []], JSON.stringify(Object.keys(f)));
    tpl.first.scene.traverse((o) => { if (o.isSkinnedMesh) assert.equal(o.material.map.userData.skinFile, undefined, 'the embedded texture stays'); });
  }
});

// ================================================================ first person: the clip follows the shield state
const clipsOf = (d) => new Map(Object.entries(d).map(([n, dur]) => [n, new THREE.AnimationClip(n, dur, [new THREE.VectorKeyframeTrack('Bone_Flash.position', [0, dur], [0, 0, -1, 0, 0, -1.2])])]));
function gunRoot() {
  const root = new THREE.Group();
  const flash = new THREE.Object3D(); flash.name = 'Bone_Flash';
  root.add(flash);
  return root;
}
const step = (anim, sec, st = {}, dt = 1 / 60) => { for (let i = 0; i < Math.round(sec / dt); i++) anim.update(dt, st); return anim.info(); };

test('gun animation: Select once, then Idle looping; Charge is scrubbed to the charge value, Charged loops at full charge, a release without a blast goes back to Idle', async () => {
  const { GunAnim } = await import('../render/shieldgun.js');
  const a = new GunAnim(gunRoot(), clipsOf(DURATIONS));
  assert.equal(a.info().state, 'select');
  assert.equal(a.info().clip, 'Select');
  assert.equal(step(a, 0.2).clip, 'Select');
  const i = step(a, 0.4);
  assert.deepEqual([i.state, i.clip], ['idle', 'Idle'], 'Select (0.5 s) is over');
  step(a, 3.5);
  assert.equal(a.info().clip, 'Idle', 'Idle loops (3 s clip, 3.9 s later)');
  assert.ok(a.info().time < 3, 'and it wrapped: ' + a.info().time);
  // charging: the sequence time follows the charge, whatever the clock does
  for (const c of [0.1, 0.4, 0.8]) {
    const s = step(a, 0.05, { charging: true, charge: c });
    assert.deepEqual([s.state, s.clip], ['charge', 'Charge']);
    assert.ok(Math.abs(s.time - c * DURATIONS.Charge) < 1e-6, `charge ${c}: the Charge clip is at ${s.time}`);
  }
  // a longer clock at the same charge does not move it
  assert.ok(Math.abs(step(a, 1, { charging: true, charge: 0.8 }).time - 0.8) < 1e-6, 'held at 0.8 while the charge stays');
  const full = step(a, 0.05, { charging: true, charge: 1 });
  assert.deepEqual([full.state, full.clip], ['charged', 'Charged']);
  const loop = step(a, 2.5, { charging: true, charge: 1 });
  assert.equal(loop.clip, 'Charged', 'the wound-up gun holds its loop');
  const out = step(a, 0.05, { charging: false, charge: 0.9 });
  assert.deepEqual([out.state, out.clip], ['idle', 'Idle'], 'released without a blast');
});

test('gun animation: a blast plays Fire once and returns to Idle; Charge takes over again when a new charge builds up during it; a respawn plays Select; charging below 3 % is still Idle', async () => {
  const { GunAnim } = await import('../render/shieldgun.js');
  const a = new GunAnim(gunRoot(), clipsOf(DURATIONS));
  step(a, 1);
  a.fire();
  assert.deepEqual([a.info().state, a.info().clip], ['fire', 'Fire']);
  assert.equal(step(a, 0.3).clip, 'Fire');
  assert.equal(step(a, 0.25).clip, 'Idle', 'Fire (0.5 s) is over');
  a.fire();
  step(a, 0.1);
  assert.equal(step(a, 0.05, { charging: true, charge: 0.02 }).clip, 'Fire', 'a hair of charge does not cut the fire');
  assert.equal(step(a, 0.05, { charging: true, charge: 0.3 }).clip, 'Charge', 'a real charge does');
  a.fire();
  a.select();
  assert.deepEqual([a.info().state, a.info().clip], ['select', 'Select']);
  assert.equal(step(a, 0.6).clip, 'Idle');
  assert.equal(step(a, 0.2, { charging: true, charge: 0.01 }).clip, 'Idle');
  // the same clip again restarts it (two blasts in a row)
  a.fire(); step(a, 0.3);
  const t = a.info().time;
  a.fire();
  assert.ok(a.info().time < t, 'Fire starts over');
});

test('gun animation: a glb that lacks Select / Charged / Fire still works - Idle instead; dispose releases the mixer', async () => {
  const { GunAnim } = await import('../render/shieldgun.js');
  const a = new GunAnim(gunRoot(), clipsOf({ Idle: 2, Charge: 1 }));
  assert.equal(a.info().clip, 'Idle', 'no Select: Idle from the start');
  a.fire();
  assert.equal(a.info().clip, 'Idle', 'no Fire: stays Idle');
  assert.equal(step(a, 0.1, { charging: true, charge: 0.5 }).clip, 'Charge');
  assert.equal(step(a, 0.1, { charging: true, charge: 1 }).clip, 'Charge', 'no Charged: the end of Charge is held');
  const root = gunRoot();
  const b = new GunAnim(root, clipsOf(DURATIONS));
  step(b, 0.1);
  b.dispose();
  assert.equal(b.info().clip, null);
  assert.deepEqual(b.info().active, []);
});

test('viewmodel: by default the gauntlet is what is drawn and no local-models file is requested; info() says so and update / blast / respawn work', async () => {
  const calls = stub({});
  const S = await import('../render/shieldgun.js');
  S.resetShieldGun();
  const { Viewmodel } = await import('../render/viewmodel.js');
  const vm = new Viewmodel();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls.filter((u) => /local-models/.test(u)), [], 'nothing is fetched until the local dev build loads the UT2004 gun');
  assert.equal(vm.ut, null);
  assert.equal(vm.gauntlet.group.visible, true);
  assert.equal(vm.gauntlet.lod, 'fp');
  assert.ok(vm.gauntlet.tris >= 10000 && vm.gauntlet.tris <= 20000, 'the first person gauntlet is ' + vm.gauntlet.tris + ' triangles');
  const i = vm.info();
  assert.deepEqual([i.ut, i.state, i.clip], [false, null, null]);
  assert.equal(vm.bubble.parent, vm.fx, 'the shield bubble and the muzzle flash hang on the muzzle group');
  assert.equal(vm.flash.parent, vm.fx);
  assert.equal(vm.glow.parent, vm.gauntlet.group, 'the halo belongs to the gauntlet');
  assert.equal(vm.fx.parent, vm.gun);
  assert.equal(vm.gauntlet.group.parent, vm.gun);
  const p0 = vm.fx.position.clone();
  const hinge = () => vm.parts.prongs.children[0].userData.hinge.rotation.y;
  assert.equal(hinge(), 0);
  for (let k = 0; k < 40; k++) vm.update(1 / 60, k / 60, { charge: 1, charging: true, speed: 0, grounded: true, vy: 0, look: [0, 0], hidden: false });
  assert.ok(hinge() < -0.15 && hinge() > -0.2, 'the prongs open about 10 degrees at full charge: ' + hinge());
  vm.onBlast(1);
  for (let k = 0; k < 3; k++) vm.update(1 / 60, 1 + k / 60, { charge: 0, charging: false, speed: 0, grounded: true, vy: 0, look: [0, 0], hidden: false });
  assert.ok(hinge() > -0.06, 'and snap shut on a blast: ' + hinge());
  assert.ok(vm.gauntlet.mats.fin.emissiveIntensity > 1.5, 'the fins are hot after it');
  for (let k = 0; k < 40; k++) vm.update(1 / 60, 2 + k / 60, { charge: 0, charging: false, speed: 0, grounded: true, vy: 0, look: [0, 0], hidden: false });
  assert.ok(vm.gauntlet.mats.fin.emissiveIntensity < 0.05, 'and cool down within 0.6 s: ' + vm.gauntlet.mats.fin.emissiveIntensity);
  vm.onBlast(0.5); vm.onRespawn(); vm.onJump(); vm.onLand(8); vm.onDodge(1);
  vm.update(1 / 60, 3.2, { charge: 0, charging: false, speed: 5, grounded: true, vy: 0, look: [0.01, 0], hidden: false });
  assert.ok(vm.fx.position.equals(p0), 'the muzzle group stays at the gauntlet muzzle');
  assert.equal(vm.root.visible, true);
  vm.update(1 / 60, 3.3, { hidden: true });
  assert.equal(vm.root.visible, false);
  assert.equal(vm.info().hidden, true);
  vm.dispose();
});

test('viewmodel: when the model loads the UT2004 gun replaces the procedural one, its clip follows charging / blast / respawn, the glow follows the muzzle bone, and nothing shared is disposed', async () => {
  stub(BOTH());
  const S = await import('../render/shieldgun.js');
  S.resetShieldGun();
  const { Viewmodel } = await import('../render/viewmodel.js');
  const vm = new Viewmodel();
  await S.loadShieldGun();
  vm.useUT(S.shieldGunTemplates().first);   // (renderer.js does this once the local dev build has loaded the gun)
  assert.ok(vm.ut, 'swapped in');
  assert.equal(vm.gauntlet.group.visible, false);
  assert.equal(vm.glow.parent, vm.fx, 'the muzzle halo moved over to the gun muzzle');
  assert.equal(vm.ut.group.parent, vm.gun);
  assert.deepEqual([vm.info().ut, vm.info().state, vm.info().clip], [true, 'select', 'Select']);
  const st = (o = {}) => ({ charge: 0, charging: false, speed: 0, grounded: true, vy: 0, look: [0, 0], hidden: false, ...o });
  for (let i = 0; i < 40; i++) vm.update(1 / 60, i / 60, st());
  assert.equal(vm.info().clip, 'Idle');
  // the glow group sits on the muzzle bone (the bone moves in Idle: z -1 -> -1.2 over 3 s)
  const z = () => vm.fx.position.z;
  const z1 = z();
  assert.ok(Math.abs(z1 - -1 * vm.ut.group.scale.x) < 0.05 * vm.ut.group.scale.x + 0.02, `the muzzle group is at the bone: ${z1}`);
  for (let i = 0; i < 90; i++) vm.update(1 / 60, 1 + i / 60, st());
  assert.ok(z() < z1 - 1e-4, 'and follows it as the sequence moves: ' + z1 + ' -> ' + z());
  // charging: the sequence goes with the smoothed charge
  for (let i = 0; i < 30; i++) vm.update(1 / 60, 3 + i / 60, st({ charging: true, charge: Math.min(1, i / 40) }));
  assert.ok(['Charge', 'Charged'].includes(vm.info().clip), vm.info().clip);
  for (let i = 0; i < 90; i++) vm.update(1 / 60, 4 + i / 60, st({ charging: true, charge: 1 }));
  assert.equal(vm.info().clip, 'Charged');
  vm.onBlast(1);
  assert.equal(vm.info().clip, 'Fire');
  vm.update(1 / 60, 6, st());
  assert.equal(vm.info().clip, 'Fire', 'it is not Idle at once');
  for (let i = 0; i < 40; i++) vm.update(1 / 60, 6 + i / 60, st());
  assert.equal(vm.info().clip, 'Idle');
  vm.onRespawn();
  assert.equal(vm.info().clip, 'Select');
  // hidden (third person, menu, editor): the sequence does not run
  const time = vm.info().time;
  vm.update(0.3, 7, st({ hidden: true }));
  assert.equal(vm.info().time, time);
  assert.equal(vm.root.visible, false);
  // dispose: the template's geometry / material / texture are shared and survive, the viewmodel's own materials and skeletons go
  const tpl = S.shieldGunTemplates().first;
  let geo = null, shared = null;
  tpl.scene.traverse((o) => { if (o.isSkinnedMesh) { geo = o.geometry; shared = o.material; } });
  let geoDisposed = 0, sharedDisposed = 0;
  geo.addEventListener('dispose', () => geoDisposed++);
  shared.addEventListener('dispose', () => sharedDisposed++);
  let own = 0;
  vm.ut.group.traverse((o) => { if (o.isSkinnedMesh) { assert.notEqual(o.material, shared, 'its own material'); o.material.addEventListener('dispose', () => own++); } });
  vm.dispose();
  assert.equal(geoDisposed + sharedDisposed, 0, 'nothing of the template is disposed');
  assert.equal(own, 1);
  assert.equal(vm.ut, null);
  // a second viewmodel (a new Gfx) gets its own clone of the same template
  const vm2 = new Viewmodel();
  vm2.useUT(tpl);
  assert.ok(vm2.ut && vm2.ut.group !== tpl.scene, 'a clone, never the template itself');
  vm2.dropUT();
  assert.equal(vm2.ut, null);
  assert.equal(vm2.gauntlet.group.visible, true, 'switched off again: the gauntlet is back');
  assert.equal(vm2.glow.parent, vm2.gauntlet.group);
  vm2.dispose();
});

// ================================================================ third person: the gun in the hand
function fakeRig() {
  const root = new THREE.Group();
  const bone = new THREE.Object3D(); bone.name = 'Bone_weapon';
  root.add(bone);
  return { root, bone, mats: [], fadeMats: [], translucent: false };
}

test('shield gun in the hand: no model or no hand bone gives null and changes nothing; with both the gun hangs under Bone_weapon, turned by the attach coordinates, with the rig\'s own materials', async () => {
  let { S } = await load({});
  let rig = fakeRig();
  assert.equal(S.attachShieldGun(rig, {}), null, 'no model');
  assert.equal(rig.bone.children.length, 0);
  ({ S } = await load(BOTH()));
  const noBone = { root: new THREE.Group(), mats: [], fadeMats: [] };
  assert.equal(S.attachShieldGun(noBone, {}), null, 'no hand bone (a rig that is not the Gorge)');
  assert.deepEqual([noBone.mats.length, noBone.fadeMats.length], [0, 0]);
  rig = fakeRig();
  const holder = S.attachShieldGun(rig, { solid: true, ghost: true, color: 0x2ee6d4 });
  assert.ok(holder);
  assert.equal(holder.parent, rig.bone);
  assert.equal(holder.children.length, 1);
  assert.equal(holder.children[0].name, 'shieldgun');
  // the gun frame -> bone frame turn of render/shieldgun.js: gun +y -> bone +z, gun +z -> bone -y, gun +x stays
  const v = (x, y, z) => new THREE.Vector3(x, y, z).applyQuaternion(holder.quaternion).toArray().map(R3);
  assert.deepEqual(v(1, 0, 0), [1, 0, 0]);
  assert.deepEqual(v(0, 1, 0), [0, 0, 1]);
  assert.deepEqual(v(0, 0, 1), [0, -1, 0]);
  assert.ok(holder.scale.x > 0.2 && holder.scale.x < 0.6 && holder.scale.x === holder.scale.y, 'a uniform draw scale: ' + holder.scale.x);
  // solid: a lit material of its own that shares the template's texture; shadows; one skinned mesh
  const meshes = [];
  holder.traverse((o) => { if (o.isSkinnedMesh) meshes.push(o); });
  assert.equal(meshes.length, 1);
  const tplMesh = (() => { let m; S.shieldGunTemplates().third.scene.traverse((o) => { if (o.isSkinnedMesh) m = o; }); return m; })();
  const m = meshes[0];
  assert.ok(m.material.isMeshStandardMaterial && !m.material.transparent && m.material.map === tplMesh.material.map);
  assert.notEqual(m.material, tplMesh.material);
  assert.equal(m.geometry, tplMesh.geometry, 'the geometry is shared');
  assert.notEqual(m.skeleton, tplMesh.skeleton, 'each gun has its own skeleton');
  assert.equal(m.castShadow, true);
  assert.equal(m.frustumCulled, false);
  assert.deepEqual([rig.mats.length, rig.fadeMats.length], [1, 0], 'the rig will dispose the material; a solid gun does not fade');
  // two figures, two guns: separate objects and skeletons, one geometry
  const rig2 = fakeRig();
  const h2 = S.attachShieldGun(rig2, { solid: true });
  let m2; h2.traverse((o) => { if (o.isSkinnedMesh) m2 = o; });
  assert.notEqual(m2.skeleton, m.skeleton);
  assert.equal(m2.geometry, m.geometry);
});

test('shield gun in the hand: a ghost gun is translucent with the player\'s colour, drops the texture\'s alpha (it is the specular mask) and has a depth-only copy drawn first; the rig fades it', async () => {
  const { S } = await load(BOTH());
  const { GHOST_OPACITY, PREPASS_ORDER } = await import('../render/gorge.js');
  const rig = fakeRig();
  const holder = S.attachShieldGun(rig, { ghost: true, color: 0xff8a2a });
  const meshes = [];
  holder.traverse((o) => { if (o.isSkinnedMesh) meshes.push(o); });
  assert.equal(meshes.length, 2, 'the gun and its depth-only copy');
  const gun = meshes.find((o) => !/:depth$/.test(o.name)), pre = meshes.find((o) => /:depth$/.test(o.name));
  assert.ok(gun.material.isMeshBasicMaterial && gun.material.transparent && gun.material.depthWrite === false);
  assert.equal(gun.material.opacity, GHOST_OPACITY);
  assert.ok(gun.material.color.r > gun.material.color.b, 'tinted orange');
  assert.equal(pre.material.colorWrite, false);
  assert.equal(pre.renderOrder, PREPASS_ORDER);
  assert.equal(pre.geometry, gun.geometry);
  assert.equal(pre.skeleton, gun.skeleton, 'it follows the same bones');
  assert.equal(gun.castShadow, false);
  assert.deepEqual(rig.fadeMats, [gun.material]);
  assert.deepEqual(rig.mats.sort((a, b) => a.id - b.id), [gun.material, pre.material].sort((a, b) => a.id - b.id), 'both are the rig\'s to dispose');
  const shader = { fragmentShader: '#include <map_fragment>\n diffuseColor *= sampledDiffuseColor;' };
  gun.material.onBeforeCompile(shader);
  assert.ok(shader.fragmentShader.includes('diffuseColor.rgb *= sampledDiffuseColor.rgb;') && !shader.fragmentShader.includes('diffuseColor *= sampledDiffuseColor;'), 'the alpha of the skin is not opacity');
  // the lit gun uses the alpha as the shininess mask
  const lit = S.gunMaterial({ map: gun.material.map });
  const sh = { fragmentShader: '#include <roughnessmap_fragment>' };
  lit.onBeforeCompile(sh);
  assert.ok(/roughnessFactor = mix\(roughnessFactor, [\d.]+, sampledDiffuseColor\.a\)/.test(sh.fragmentShader));
  assert.notEqual(lit.customProgramCacheKey(), S.gunMaterial({ map: gun.material.map, ghost: true }).customProgramCacheKey(), 'different programs, different cache keys');
});

// ================================================================ figures: the real Gorge holds the gun
const GORGE_URL = 'local-models/gorge.glb';
async function figSetup(files) {
  const calls = stub({ ...files });
  const real = globalThis.fetch;
  setGlobal('fetch', async (url, o) => (String(url).includes(GORGE_URL) && REAL.gorge ? new Response(fs.readFileSync(LOCAL('gorge.glb')), { status: 200, headers: { 'content-type': 'model/gltf-binary' } }) : real(url, o)));
  const G = await import('../render/gorge.js');
  G.resetGorge();
  const S = await import('../render/shieldgun.js');
  S.resetShieldGun();
  const { Figures } = await import('../render/figures.js');
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(); camera.position.set(0, 1.7, 8);
  const figs = new Figures(scene);
  await Promise.all([G.loadGorge(), S.loadShieldGun()]);
  await new Promise((r) => setTimeout(r, 0));
  figs.refreshGuns();   // (renderer.js does this when the local dev build has loaded the gun)
  return { G, S, figs, scene, camera, calls };
}
const heldGun = (fig) => (fig.rig ? fig.rig.root.getObjectByName('shieldgun') : null);

test('figures: every Gorge - the own figure, race peers (solid) and ghosts (translucent) - holds the shield gun in its right hand; the robot gets none', async () => {
  if (!REAL.gorge) return;
  const { figs, camera, G } = await figSetup(BOTH());
  assert.ok(G.gorgeTemplate());
  figs.upsert('me', { name: 'Én', color: 0xff8a2a, pos: [0, 0, 0], yaw: 0, flags: FLAG.GROUND });
  figs.upsert('peer', { name: 'Bob', color: 0x2ee6d4, pos: [2, 0, 0], yaw: 0, flags: FLAG.GROUND, ghost: true, solid: true });
  figs.upsert('ghost', { name: 'PB', color: 0xffffff, pos: [4, 0, 0], yaw: 0, flags: FLAG.GROUND, ghost: true });
  figs.update(1 / 60, camera);
  const info = new Map(figs.info().map((f) => [f.id, f]));
  for (const id of ['me', 'peer', 'ghost']) {
    assert.equal(info.get(id).model, 'gorge', id);
    assert.equal(info.get(id).weapon, true, id + ' holds the gun');
    const gun = heldGun(figs.map.get(id));
    assert.ok(gun, id);
    let p = gun.parent;
    assert.equal(p.name, 'shieldgun-hand');
    assert.equal(p.parent.name, 'Bone_weapon', 'in the right hand');
    assert.equal(info.get(id).skinned, 2, 'the Gorge\'s own two skinned meshes are still the only ones counted');
  }
  const gm = (id) => { const o = []; figs.map.get(id).rig.root.getObjectByName('shieldgun').traverse((x) => { if (x.isSkinnedMesh && !/:depth/.test(x.name)) o.push(x.material); }); return o[0]; };
  assert.ok(gm('me').isMeshStandardMaterial && gm('peer').isMeshStandardMaterial);
  assert.ok(gm('ghost').isMeshBasicMaterial && gm('ghost').transparent);
  // the ghost's gun fades with the figure
  const rig = figs.map.get('ghost').rig;
  const before = gm('ghost').opacity;
  rig.setOpacity(0.5);
  assert.ok(Math.abs(gm('ghost').opacity - before * 0.5) < 1e-9);
  // a rebuild (ghost -> solid, another colour) keeps exactly one gun and never touches the model's shared things
  figs.upsert('ghost', { solid: true });
  figs.upsert('peer', { color: 0x00ff00 });
  figs.update(1 / 60, camera);
  for (const id of ['ghost', 'peer']) { let n = 0; figs.map.get(id).rig.root.traverse((o) => { if (o.name === 'shieldgun') n++; }); assert.equal(n, 1, id); }
  figs.remove('me');
  assert.equal(figs.map.has('me'), false);
  figs.dispose();
});

test('figures: the Gorge without the gun files holds nothing (weapon false); the gun arriving later is handed to the figures that already stand there; the robot never has one', async () => {
  // no gun files
  if (REAL.gorge) {
    const { figs, camera } = await figSetup({});
    figs.upsert('a', { name: 'A', color: 0xff8a2a, pos: [0, 0, 0], yaw: 0, flags: FLAG.GROUND });
    figs.update(1 / 60, camera);
    const f = figs.info()[0];
    assert.equal(f.model, 'gorge');
    assert.equal(f.weapon, false);
    assert.ok(!heldGun(figs.map.get('a')));
    figs.dispose();
  }
  // no Gorge at all: the robot (it has its own gun in the arm); the loaded gun template is not used
  stub(BOTH());
  setGlobal('fetch', async (url) => (String(url).endsWith('.glb') && String(url).includes('shieldgun') ? glbResponse(tinyGlb())() : missing()));
  const G = await import('../render/gorge.js');
  G.resetGorge();
  const S = await import('../render/shieldgun.js');
  S.resetShieldGun();
  const { Figures } = await import('../render/figures.js');
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  const figs = new Figures(scene);
  await Promise.all([G.loadGorge(), S.loadShieldGun()]);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(G.gorgeTemplate(), null);
  assert.ok(S.shieldGunTemplates().third, 'the gun is there, the Gorge is not');
  figs.upsert('r', { name: 'R', color: 0xff8a2a, pos: [0, 0, 0], yaw: 0, flags: FLAG.GROUND });
  figs.update(1 / 60, camera);
  const f = figs.info()[0];
  assert.equal(f.model, 'robot');
  assert.equal(scene.getObjectByName('shieldgun'), undefined);
  figs.dispose();
});

test('figures: the gun that loads after the Gorge is attached to the figures that were built without it', async () => {
  if (!REAL.gorge) return;
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = (buf) => async () => { await gate; return glbResponse(buf)(); };
  stub({});
  const real = globalThis.fetch;
  setGlobal('fetch', async (url, o) => {
    const u = String(url);
    if (u.includes(GORGE_URL)) return new Response(fs.readFileSync(LOCAL('gorge.glb')), { status: 200, headers: { 'content-type': 'model/gltf-binary' } });
    if (u.endsWith('shieldgun-3rd.glb')) return slow(tinyGlb({ clips: { Still: 0.03 } }))();
    if (u.endsWith('shieldgun-1st.glb')) return slow(tinyGlb())();
    return real(url, o);
  });
  const G = await import('../render/gorge.js');
  G.resetGorge();
  const S = await import('../render/shieldgun.js');
  S.resetShieldGun();
  const { Figures } = await import('../render/figures.js');
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  const figs = new Figures(scene);
  await G.loadGorge();
  figs.upsert('a', { name: 'A', color: 0xff8a2a, pos: [0, 0, 0], yaw: 0, flags: FLAG.GROUND });
  figs.update(1 / 60, camera);
  assert.equal(figs.info()[0].weapon, false, 'the gun file is still on its way');
  release();
  await S.loadShieldGun();
  await new Promise((r) => setTimeout(r, 0));
  figs.refreshGuns();
  figs.update(1 / 60, camera);
  assert.equal(figs.info()[0].weapon, true, 'handed over when it arrived');
  assert.ok(heldGun(figs.map.get('a')));
  figs.dispose();
});

// ================================================================ the real model (the player's own extract)
async function realLoad() {
  const calls = stub({
    'shieldgun-1st.glb': () => new Response(fs.readFileSync(LOCAL('shieldgun-1st.glb')), { status: 200, headers: { 'content-type': 'model/gltf-binary' } }),
    'shieldgun-3rd.glb': () => new Response(fs.readFileSync(LOCAL('shieldgun-3rd.glb')), { status: 200, headers: { 'content-type': 'model/gltf-binary' } }),
  });
  const S = await import('../render/shieldgun.js');
  S.resetShieldGun();
  const tpl = await S.loadShieldGun();
  return { S, tpl, calls };
}

test('real shield gun: both glbs load (7 sequences with the extractor\'s lengths, 11 bones, one RGBA skin ShieldTex0), Idle and Charged loop, Select / Fire do not', async () => {
  if (!REAL.first || !REAL.third) return;
  const { tpl } = await realLoad();
  assert.ok(tpl.first && tpl.third);
  assert.deepEqual([...tpl.first.clips.keys()].sort(), ['Charge', 'Charged', 'Fire', 'Idle', 'PutDown', 'Select', 'Shield']);
  assert.deepEqual([...tpl.third.clips.keys()], ['Still']);
  const want = { Idle: 59 / 20, Select: 9 / 20, PutDown: 9 / 20, Charge: 59 / 60, Charged: 1, Fire: 29 / 60, Shield: 59 / 60 };
  for (const [n, d] of Object.entries(want)) assert.ok(Math.abs(tpl.first.clips.get(n).duration - d) < 1e-3, `${n}: ${tpl.first.clips.get(n).duration}`);
  assert.deepEqual([tpl.first.bones, tpl.third.bones], [11, 11]);
  for (const t of [tpl.first, tpl.third]) {
    let n = 0;
    t.scene.traverse((o) => { if (o.isSkinnedMesh) { n++; assert.equal(o.material.name, 'ShieldTex0'); assert.ok(o.material.map && o.material.map.image); } });
    assert.equal(n, 1);
    for (const b of ['Bone_weapon', 'Bone_Flash', 'Bone_antenna']) assert.ok(t.scene.getObjectByName(b), b);
  }
});

test('real shield gun, first person: the viewmodel sits in the lower right corner, in front of the camera (never inside its near plane), mostly off screen so the head shows and the grip does not, in every sequence', async () => {
  if (!REAL.first || !REAL.third) return;
  const { S } = await realLoad();
  const { Viewmodel } = await import('../render/viewmodel.js');
  const vm = new Viewmodel();
  await S.loadShieldGun();
  vm.useUT(S.shieldGunTemplates().first);
  assert.ok(vm.ut);
  vm.resize(16 / 9);
  const cam = vm.camera;
  const st = (o = {}) => ({ charge: 0, charging: false, speed: 0, grounded: true, vy: 0, look: [0, 0], hidden: false, ...o });
  const sample = () => {
    vm.root.updateMatrixWorld(true);
    cam.updateMatrixWorld(true); cam.updateProjectionMatrix();
    let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9], cx = 0, cy = 0, n = 0, nearest = 1e9;
    const v = new THREE.Vector3();
    vm.ut.group.traverse((o) => {
      if (!o.isSkinnedMesh) return;
      const p = o.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) {
        o.getVertexPosition(i, v); v.applyMatrix4(o.matrixWorld);
        nearest = Math.min(nearest, -v.z);
        v.project(cam);
        cx += v.x; cy += v.y; n++;
        mn = [Math.min(mn[0], v.x), Math.min(mn[1], v.y), 0]; mx = [Math.max(mx[0], v.x), Math.max(mx[1], v.y), 0];
      }
    });
    const m = vm.ut.muzzle.getWorldPosition(new THREE.Vector3()).project(cam);
    return { cx: cx / n, cy: cy / n, mn, mx, nearest, muzzle: m };
  };
  for (const [label, run] of [
    // (not Select: before the first update() the root is wherever the gauntlet put it, and the real first frames of Select are the gun rising on the respawn)
    ['Idle', () => { for (let i = 0; i < 90; i++) vm.update(1 / 60, i / 60, st()); }],
    ['Charge', () => { for (let i = 0; i < 40; i++) vm.update(1 / 60, 2 + i / 60, st({ charging: true, charge: i / 70 })); }],
    ['Charged', () => { for (let i = 0; i < 90; i++) vm.update(1 / 60, 3 + i / 60, st({ charging: true, charge: 1 })); }],
    ['Fire', () => { vm.onBlast(1); vm.update(0.1, 5, st()); }],
  ]) {
    run();
    const s = sample();
    assert.ok(s.nearest > 0.1 && s.nearest > cam.near * 3, `${label}: the nearest vertex of the gun is ${R3(s.nearest)} m from the camera (the viewmodel near plane is ${cam.near}; the Fire kick brings the grip closest)`);
    assert.ok(s.cx > 0.5 && s.cx < 1.3, `${label}: the gun's centre is far right on the screen: ${R3(s.cx)}`);
    assert.ok(s.cy < -0.3 && s.cy > -1.3, `${label}: and low: ${R3(s.cy)}`);
    assert.ok(s.mn[0] > 0.4, `${label}: it stays in the right fifth of the screen, well away from the crosshair: left edge ${R3(s.mn[0])}`);
    assert.ok(s.mx[1] < 0.1, `${label}: and below the crosshair (the first frame of Select reaches about level with it, far to the right): top ${R3(s.mx[1])}`);
    assert.ok(s.mx[0] - s.mn[0] > 0.58, `${label}: the gun is drawn big and close (UT_GROW): its picture is ${R3(s.mx[0] - s.mn[0])} wide`);
    assert.ok(s.mx[0] > 1 && s.mn[1] < -1, `${label}: the grip runs off the right and the bottom edge: ${R3(s.mx[0])}, ${R3(s.mn[1])}`);
    assert.ok(s.muzzle.x > 0.4 && s.muzzle.x < 1 && s.muzzle.y > -0.95 && s.muzzle.y < -0.1, `${label}: the muzzle (the head) is on the screen in the lower right corner: ${R3(s.muzzle.x)}, ${R3(s.muzzle.y)}`);
  }
  vm.dispose();
});

test('real shield gun, third person: in Idle_Rifle the gun in the Gorge\'s hand points along the figure\'s forward axis, level, at chest height in front of the body', async () => {
  if (!REAL.first || !REAL.third || !REAL.gorge) return;
  const { figs, camera, G } = await (async () => {
    stub({});
    const real = globalThis.fetch;
    setGlobal('fetch', async (url, o) => {
      const u = String(url);
      const f = u.includes(GORGE_URL) ? 'gorge.glb' : u.endsWith('shieldgun-1st.glb') ? 'shieldgun-1st.glb' : u.endsWith('shieldgun-3rd.glb') ? 'shieldgun-3rd.glb' : null;
      return f ? new Response(fs.readFileSync(LOCAL(f)), { status: 200, headers: { 'content-type': 'model/gltf-binary' } }) : real(url, o);
    });
    const G2 = await import('../render/gorge.js'); G2.resetGorge();
    const S2 = await import('../render/shieldgun.js'); S2.resetShieldGun();
    const { Figures } = await import('../render/figures.js');
    const f = new Figures(new THREE.Scene());
    await Promise.all([G2.loadGorge(), S2.loadShieldGun()]);
    await new Promise((r) => setTimeout(r, 0));
    const cam = new THREE.PerspectiveCamera(); cam.position.set(0, 1.7, 8);
    return { figs: f, camera: cam, G: G2 };
  })();
  assert.ok(G.gorgeTemplate());
  figs.upsert('me', { name: 'Én', color: 0xff8a2a, pos: [0, 0, 0], yaw: 0, flags: FLAG.GROUND });
  for (let i = 0; i < 30; i++) figs.update(1 / 60, camera);
  const fig = figs.map.get('me');
  assert.equal(fig.rig.info().clip, 'Idle_Rifle');
  fig.R.updateMatrixWorld(true);
  fig.root.updateMatrixWorld(true);
  const gun = fig.rig.root.getObjectByName('shieldgun');
  const inv = new THREE.Matrix4().copy(fig.root.matrixWorld).invert();
  const at = (name) => gun.getObjectByName(name).getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
  const grip = at('Bone_weapon'), tip = at('Bone_Flash');
  const dir = tip.clone().sub(grip).normalize();
  assert.ok(dir.z < -0.9, 'the barrel points forward (-z of the figure): ' + dir.toArray().map(R3));
  assert.ok(Math.abs(dir.y) < 0.35 && Math.abs(dir.x) < 0.35, 'level and straight: ' + dir.toArray().map(R3));
  assert.ok(grip.y > 1.0 && grip.y < 1.6, 'at chest height: ' + R3(grip.y));
  assert.ok(tip.z < -0.5 && tip.y > 1.0 && tip.y < 1.8, 'the muzzle is ahead of the body: ' + tip.toArray().map(R3));
  const len = tip.distanceTo(grip);
  assert.ok(len > 0.3 && len < 1.1, 'a gun-sized gun: ' + R3(len) + ' m from grip to muzzle');
  figs.dispose();
});
