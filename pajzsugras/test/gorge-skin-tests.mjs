// render/gorge.js skin override: the player repaints Gorge by editing local-models/gorge-body.png and gorge-head.png (written by
// tools/ut2004_extract.py next to gorge.glb); when one is there it replaces the matching texture of the glb, and anything wrong with it
// (missing, an HTML page from the dev server's fallback, not a PNG, too big, undecodable) leaves the glb's own texture, silently.
// The applySkins cases use small hand-made scenes and stub fetch / createImageBitmap, so they run without the model. The loadGorge cases
// need the local model (pajzsugras/local-models/gorge.glb, git-ignored) and pass without checking anything when it is not there.
import fs from 'node:fs';
import * as THREE from 'three';
import { test, assert, setGlobal } from './harness.mjs';

const GLB = new URL('../local-models/gorge.glb', import.meta.url);
const HAVE = fs.existsSync(GLB);
const GLB_URL = './local-models/gorge.glb';
const BODY = 'JuggMaleABodyA', HEAD = 'JuggMaleAHeadA';
const MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// bytes that start like a PNG and are n long (the decoder is a stub: it tells the files apart by their size)
const pngBytes = (n) => { const b = new Uint8Array(n); b.set(MAGIC); b.fill(7, 8); return b; };
const reply = (bytes, type = 'image/png', extra = {}) => () => new Response(bytes, { status: 200, headers: { 'content-type': type, ...extra } });
const html = () => new Response('<!doctype html><html><body>index</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });

// fetch + createImageBitmap stubs; files: file name -> () => Response | 'throw'; bitmap(blob) -> what the decoder returns (default 16 x 16)
function stub({ files = {}, bitmap = null } = {}) {
  const calls = { fetch: [], bitmap: [], bitmaps: [] };
  setGlobal('fetch', async (url) => {
    calls.fetch.push(String(url));
    const f = files[String(url).split('/').pop()];
    if (f === 'throw') throw new TypeError('network down');
    return f ? f() : new Response('no', { status: 404 });
  });
  setGlobal('createImageBitmap', async (blob, opts) => {
    calls.bitmap.push({ size: blob.size, type: blob.type, opts });
    if (bitmap) return bitmap(blob);
    const b = { width: 16, height: 16, size: blob.size, closed: false, close() { this.closed = true; } };
    calls.bitmaps.push(b);
    return b;
  });
  return calls;
}

// a scene like the glb's: one skinned mesh per named material, each with an "embedded" texture
function skinScene(names = [BODY, HEAD]) {
  const scene = new THREE.Scene(), olds = [], mats = [];
  for (const name of names) {
    const old = new THREE.Texture({ width: 4, height: 4 });
    old.flipY = false; old.colorSpace = THREE.SRGBColorSpace; old.wrapS = THREE.MirroredRepeatWrapping; old.wrapT = THREE.RepeatWrapping;
    old.magFilter = THREE.LinearFilter; old.minFilter = THREE.LinearMipmapLinearFilter; old.anisotropy = 4;
    old.userData.shared = true;
    old.disposed = 0;
    old.addEventListener('dispose', () => old.disposed++);
    const mat = new THREE.MeshStandardMaterial({ map: old, name });
    scene.add(new THREE.SkinnedMesh(new THREE.BoxGeometry(), mat));
    olds.push(old); mats.push(mat);
  }
  return { scene, olds, mats };
}

test('gorge skins: skinFileFor maps the glb\'s material names (body / head, any case) to the two PNG names and nothing else', async () => {
  const { skinFileFor } = await import('../render/gorge.js');
  assert.equal(skinFileFor(BODY), 'gorge-body.png');
  assert.equal(skinFileFor(HEAD), 'gorge-head.png');
  assert.equal(skinFileFor('jugg_BODY'), 'gorge-body.png');
  assert.equal(skinFileFor('JuggMaleAHEADb'), 'gorge-head.png');
  for (const n of ['', 'Armor', 'Material', null, undefined, 5]) assert.equal(skinFileFor(n), null, String(n));
});

test('gorge skins: both PNGs present - each replaces its texture the glTF way (flipY false, sRGB, the embedded sampler, shared), the old textures are released, the files are decoded untouched', async () => {
  const { applySkins } = await import('../render/gorge.js');
  const calls = stub({ files: { 'gorge-body.png': reply(pngBytes(1000)), 'gorge-head.png': reply(pngBytes(2000)) } });
  const { scene, olds, mats } = skinScene();
  const used = await applySkins(scene, GLB_URL);
  assert.deepEqual(used, ['gorge-body.png', 'gorge-head.png']);
  assert.deepEqual(calls.fetch.slice().sort(), ['./local-models/gorge-body.png', './local-models/gorge-head.png'], 'fetched next to the glb, nothing else');
  assert.deepEqual(calls.bitmap.map((c) => c.size).sort((a, b) => a - b), [1000, 2000]);
  for (const c of calls.bitmap) {
    assert.equal(c.type, 'image/png');
    assert.deepEqual(c.opts, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }, 'the options GLTFLoader uses: the pixels are not converted');
  }
  [[0, 1000, 'gorge-body.png'], [1, 2000, 'gorge-head.png']].forEach(([i, size, file]) => {
    const m = mats[i].map, old = olds[i];
    assert.notEqual(m, old);
    assert.equal(m.isTexture, true);
    assert.equal(m.image.size, size, 'the right file went to the right material');
    assert.equal(m.flipY, false);
    assert.equal(m.colorSpace, THREE.SRGBColorSpace);
    assert.deepEqual([m.wrapS, m.wrapT, m.magFilter, m.minFilter, m.anisotropy, m.generateMipmaps], [old.wrapS, old.wrapT, old.magFilter, old.minFilter, old.anisotropy, old.generateMipmaps], 'the embedded texture\'s sampler');
    assert.equal(m.userData.shared, true, 'the figures never dispose it');
    assert.equal(m.userData.skinFile, file);
    assert.ok(m.version > 0, 'marked for upload');
    assert.equal(old.disposed, 1, 'the embedded texture is released');
  });
});

test('gorge skins: only one of the two present - that one is replaced, the other keeps the glb\'s texture', async () => {
  const { applySkins } = await import('../render/gorge.js');
  stub({ files: { 'gorge-head.png': reply(pngBytes(2000)) } });
  const { scene, olds, mats } = skinScene();
  assert.deepEqual(await applySkins(scene, GLB_URL), ['gorge-head.png']);
  assert.equal(mats[0].map, olds[0], 'the body is untouched');
  assert.equal(olds[0].disposed, 0);
  assert.equal(mats[1].map.image.size, 2000);
});

test('gorge skins: missing files (404), the dev server\'s HTML fallback and bytes that are not a PNG leave the glb\'s textures alone - no error, nothing decoded', async () => {
  const { applySkins } = await import('../render/gorge.js');
  const junk = new Uint8Array(500).fill(65);
  const cases = {
    '404 for both': {},
    'HTML fallback (index.html, 200, text/html)': { 'gorge-body.png': html, 'gorge-head.png': html },
    'HTML with a charset': { 'gorge-body.png': reply('<html></html>'.repeat(20), 'text/html; charset=utf-8'), 'gorge-head.png': html },
    'HTML served without a content type': { 'gorge-body.png': reply(new TextEncoder().encode('<!doctype html>' + 'x'.repeat(200)), ''), 'gorge-head.png': reply(junk, '') },
    'JPEG / junk behind a png name': { 'gorge-body.png': reply(Uint8Array.from([0xff, 0xd8, 0xff, ...new Array(300).fill(1)]), 'image/jpeg'), 'gorge-head.png': reply(junk) },
    'a PNG signature cut short': { 'gorge-body.png': reply(Uint8Array.from(MAGIC.slice(0, 6))), 'gorge-head.png': reply(pngBytes(40)) },
    'a server error': { 'gorge-body.png': () => new Response('boom', { status: 500 }), 'gorge-head.png': () => new Response('no', { status: 403 }) },
  };
  for (const [label, files] of Object.entries(cases)) {
    const calls = stub({ files });
    const { scene, olds, mats } = skinScene();
    assert.deepEqual(await applySkins(scene, GLB_URL), [], label);
    assert.deepEqual(mats.map((m) => m.map), olds, label + ': embedded textures kept');
    assert.deepEqual(olds.map((o) => o.disposed), [0, 0], label);
    assert.equal(calls.bitmap.length, 0, label + ': nothing was decoded');
  }
});

test('gorge skins: a file over the size cap is refused by its content-length or while streaming (not read to the end), and too many pixels or a zero-size bitmap is refused', async () => {
  const { applySkins } = await import('../render/gorge.js');
  const big = 33 * 1024 * 1024;
  let pulled = 0;
  const calls = stub({
    files: {
      'gorge-body.png': () => new Response(pngBytes(100), { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(big) } }),
      'gorge-head.png': () => new Response(new ReadableStream({ pull(ctrl) { pulled++; ctrl.enqueue(new Uint8Array(1024 * 1024).fill(1)); if (pulled > 40) ctrl.close(); } }), { status: 200, headers: { 'content-type': 'image/png' } }),
    },
  });
  let s = skinScene();
  assert.deepEqual(await applySkins(s.scene, GLB_URL), []);
  assert.ok(pulled <= 36, 'the stream was cut off at the cap, not read to the end (' + pulled + ' MB pulled)');
  assert.equal(calls.bitmap.length, 0);
  assert.deepEqual(s.mats.map((m) => m.map), s.olds);
  // 5000 x 5000 pixels: more than 4096 a side (64 MB of video memory for one skin)
  const huge = stub({ files: { 'gorge-body.png': reply(pngBytes(1000)), 'gorge-head.png': reply(pngBytes(2000)) }, bitmap: (b) => { const r = { width: b.size === 1000 ? 5000 : 0, height: 5000, closed: false, close() { this.closed = true; } }; huge.bitmaps.push(r); return r; } });
  s = skinScene();
  assert.deepEqual(await applySkins(s.scene, GLB_URL), [], 'too big / empty bitmaps');
  assert.deepEqual(s.mats.map((m) => m.map), s.olds);
  assert.deepEqual(huge.bitmaps.map((b) => b.closed), [true, true], 'and they are closed');
  // 4096 x 4096 is the largest accepted (a repaint at 4x the glb\'s size)
  stub({ files: { 'gorge-body.png': reply(pngBytes(1000)) }, bitmap: () => ({ width: 4096, height: 4096, close() {} }) });
  s = skinScene();
  assert.deepEqual(await applySkins(s.scene, GLB_URL), ['gorge-body.png']);
  assert.equal(s.mats[0].map.image.width, 4096);
});

test('gorge skins: a failing fetch, a decoder that rejects, and a browser without createImageBitmap all leave the glb\'s textures alone and throw nothing', async () => {
  const { applySkins } = await import('../render/gorge.js');
  const both = { 'gorge-body.png': reply(pngBytes(1000)), 'gorge-head.png': reply(pngBytes(2000)) };
  stub({ files: { 'gorge-body.png': 'throw', 'gorge-head.png': 'throw' } });
  let s = skinScene();
  assert.deepEqual(await applySkins(s.scene, GLB_URL), [], 'network error');
  assert.deepEqual(s.mats.map((m) => m.map), s.olds);
  stub({ files: both, bitmap: () => { throw new DOMException('The source image could not be decoded.', 'InvalidStateError'); } });
  s = skinScene();
  assert.deepEqual(await applySkins(s.scene, GLB_URL), [], 'undecodable image');
  assert.deepEqual(s.mats.map((m) => m.map), s.olds);
  // one good, one bad: the good one still applies
  stub({ files: { 'gorge-body.png': reply(pngBytes(1000)), 'gorge-head.png': 'throw' } });
  s = skinScene();
  assert.deepEqual(await applySkins(s.scene, GLB_URL), ['gorge-body.png']);
  assert.equal(s.mats[1].map, s.olds[1]);
  const calls = stub({ files: both });
  setGlobal('createImageBitmap', undefined);
  s = skinScene();
  assert.deepEqual(await applySkins(s.scene, GLB_URL), [], 'no createImageBitmap: the embedded textures');
  assert.equal(calls.fetch.length, 0, 'and nothing is downloaded for nothing');
  assert.deepEqual(s.mats.map((m) => m.map), s.olds);
});

test('gorge skins: only the body / head materials of skinned meshes are touched; two materials of one kind share one download; the URL follows the glb\'s folder', async () => {
  const { applySkins } = await import('../render/gorge.js');
  const calls = stub({ files: { 'gorge-body.png': reply(pngBytes(1000)), 'gorge-head.png': reply(pngBytes(2000)) } });
  const s = skinScene(['JuggMaleABodyA', 'JuggMaleABodyB', 'Armor', HEAD]);
  // a plain (not skinned) mesh called Body, a body material without a map: both ignored
  const plain = new THREE.Texture({ width: 2, height: 2 });
  s.scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ map: plain, name: 'Body' })));
  const bare = new THREE.MeshStandardMaterial({ name: 'BodyNoMap' });
  s.scene.add(new THREE.SkinnedMesh(new THREE.BoxGeometry(), bare));
  const used = await applySkins(s.scene, 'https://example.test/assets/models/gorge.glb');
  assert.deepEqual(used, ['gorge-body.png', 'gorge-head.png']);
  assert.deepEqual(calls.fetch.slice().sort(), ['https://example.test/assets/models/gorge-body.png', 'https://example.test/assets/models/gorge-head.png'], 'one download per file, next to the glb');
  assert.equal(s.mats[0].map.image.size, 1000);
  assert.equal(s.mats[1].map.image.size, 1000);
  assert.notEqual(s.mats[0].map, s.mats[1].map, 'a texture per material');
  assert.equal(s.mats[2].map, s.olds[2], 'Armor is not a skin');
  assert.equal(s.mats[3].map.image.size, 2000);
  assert.equal(bare.map, null);
  // a path without a folder
  const c2 = stub({ files: {} });
  await applySkins(skinScene().scene, 'gorge.glb');
  assert.deepEqual(c2.fetch.slice().sort(), ['gorge-body.png', 'gorge-head.png']);
});

test('gorge skins: when the glb itself is not there (the live site, the dev server\'s HTML fallback, junk) the skins are not even asked for', async () => {
  const G = await import('../render/gorge.js');
  const junk = () => new Response(new Uint8Array(4000), { status: 200, headers: { 'content-type': 'application/octet-stream' } });
  for (const [label, glb] of [['404', undefined], ['HTML', html], ['junk bytes', junk], ['network error', 'throw']]) {
    const calls = stub({ files: { 'gorge.glb': glb, 'gorge-body.png': reply(pngBytes(1000)), 'gorge-head.png': reply(pngBytes(2000)) } });
    G.resetGorge();
    assert.equal(await G.loadGorge(GLB_URL), null, label);
    assert.deepEqual(calls.fetch, [GLB_URL], label + ': a single request, no skin probes');
  }
});

const glbReply = () => new Response(fs.readFileSync(GLB), { status: 200, headers: { 'content-type': 'model/gltf-binary' } });
const asked = (calls) => calls.fetch.filter((u) => !u.startsWith('blob:'));   // (GLTFLoader fetches the glb's own embedded images through blob: urls)

test('gorge skins: loadGorge with the real glb - both PNGs repaint the template and every rig uses them; without them (404, HTML) the embedded skins stay', async () => {
  if (!HAVE) return;
  setGlobal('self', globalThis);   // (GLTFLoader reads self.URL; the document is for the figure at the end)
  setGlobal('document', { createElement: () => ({ width: 0, height: 0, style: {}, getContext: () => new Proxy({}, { get: (t, k) => (k === 'measureText' ? () => ({ width: 40 }) : () => {}), set: () => true }) }) });
  const G = await import('../render/gorge.js');
  const maps = (tpl) => { const r = {}; tpl.scene.traverse((o) => { if (o.isSkinnedMesh) r[o.material.name] = o.material.map; }); return r; };
  // 1. no PNGs: the glb's own textures
  let calls = stub({ files: { 'gorge.glb': glbReply } });
  G.resetGorge();
  let tpl = await G.loadGorge(GLB_URL);
  assert.ok(tpl);
  assert.deepEqual(tpl.skins, []);
  assert.deepEqual(asked(calls).sort(), [GLB_URL, './local-models/gorge-body.png', './local-models/gorge-head.png'].sort());
  const own = maps(tpl);
  assert.deepEqual(Object.keys(own).sort(), [BODY, HEAD]);
  assert.ok(Object.values(own).every((t) => t.userData.shared === true && t.anisotropy === 4 && t.flipY === false && t.userData.skinFile === undefined));
  // 2. HTML for both: the same
  calls = stub({ files: { 'gorge.glb': glbReply, 'gorge-body.png': html, 'gorge-head.png': html } });
  G.resetGorge();
  tpl = await G.loadGorge(GLB_URL);
  assert.deepEqual(tpl.skins, []);
  assert.ok(Object.values(maps(tpl)).every((t) => t.userData.skinFile === undefined));
  // 3. both PNGs: repainted
  calls = stub({ files: { 'gorge.glb': glbReply, 'gorge-body.png': reply(pngBytes(1000)), 'gorge-head.png': reply(pngBytes(2000)) } });
  G.resetGorge();
  tpl = await G.loadGorge(GLB_URL);
  assert.deepEqual(tpl.skins, ['gorge-body.png', 'gorge-head.png']);
  const painted = maps(tpl);
  assert.equal(painted[BODY].image.size, 1000);
  assert.equal(painted[HEAD].image.size, 2000);
  assert.ok(painted[BODY].anisotropy === 4 && painted[BODY].flipY === false && painted[BODY].colorSpace === THREE.SRGBColorSpace);
  for (const o of [{ ghost: true, solid: true }, { ghost: true }, {}]) {
    const rig = new G.GorgeRig(tpl, { ...o, color: 0xff8a2a });
    const used = rig.skinned.map((m) => m.material.map);
    assert.deepEqual(used.map((t) => t.image.size).sort((a, b) => a - b), [1000, 2000], 'every kind of rig draws the repainted skins: ' + JSON.stringify(o));
    rig.dispose();
  }
  assert.equal(asked(calls).length, 3, 'one request each for the glb and the two skins');
  // 4. a figure made after the load uses it (the Gorge, not the robot)
  const { Figures } = await import('../render/figures.js');
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 1.7, 8);
  const figs = new Figures(scene);
  figs.upsert('a', { name: 'A', color: 0xff8a2a, pos: [0, 0, 0], yaw: 0, flags: 1, ghost: true, solid: true });
  figs.update(1 / 60, camera);
  assert.equal(figs.info()[0].model, 'gorge');
  figs.dispose();
});
