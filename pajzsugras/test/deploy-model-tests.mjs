import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, assert, setGlobal, onCleanup } from './harness.mjs';
import { packModels, readGlb, MODEL_FILES, PUBLIC_MODEL_FILES } from '../tools/model-assets.mjs';

const directory = fileURLToPath(new URL('../local-models', import.meta.url));
const root = fileURLToPath(new URL('../../', import.meta.url));

test('deploy models: packed geometry, bones and all animation tracks are lossless, current skins are shared, and output is deterministic', () => {
  const packed = packModels(directory), again = packModels(directory);
  assert.equal(packed.assets.size, 6, 'three models and three skins, without backups or embedded duplicate images');
  let bytes = 0;
  for (const [name, data] of packed.assets) {
    assert.match(name, /^assets\/pj-models\/[a-z0-9-]+-[a-f0-9]{16}\.(png|glb)$/);
    assert.deepEqual(data, again.assets.get(name));
    bytes += data.length;
  }
  assert.ok(bytes < packed.sourceBytes * 0.6, 'at least 40% smaller than fetching the original models and overrides');
  const weaponSkins = [];
  for (const [key, source] of Object.entries(MODEL_FILES)) {
    const before = readGlb(fs.readFileSync(path.join(directory, source)));
    const after = readGlb(packed.assets.get(packed.models[key]));
    for (const part of ['nodes', 'skins', 'animations', 'meshes', 'materials', 'samplers']) assert.deepEqual(after.json[part], before.json[part], source + ': ' + part);
    const images = new Set(before.json.images.map((image) => image.bufferView));
    const oldViews = before.json.bufferViews.filter((_, i) => !images.has(i));
    assert.equal(after.json.bufferViews.length, oldViews.length);
    for (const [i, view] of oldViews.entries()) {
      const next = after.json.bufferViews[i];
      assert.equal(next.byteOffset % 4, 0);
      assert.deepEqual(after.bin.subarray(next.byteOffset, next.byteOffset + next.byteLength), before.bin.subarray(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength));
    }
    for (const [i, accessor] of before.json.accessors.entries()) {
      const next = after.json.accessors[i];
      assert.deepEqual({ ...next, bufferView: accessor.bufferView }, accessor, 'accessor metadata is preserved');
      const a = before.json.bufferViews[accessor.bufferView], b = after.json.bufferViews[next.bufferView];
      assert.deepEqual(before.bin.subarray(a.byteOffset || 0, (a.byteOffset || 0) + a.byteLength), after.bin.subarray(b.byteOffset, b.byteOffset + b.byteLength), 'each accessor still addresses the same bytes');
    }
    for (const image of after.json.images) {
      assert.equal(image.bufferView, undefined);
      assert.ok(packed.assets.has('assets/pj-models/' + image.uri));
      if (key !== 'gorge') weaponSkins.push(image.uri);
    }
  }
  assert.equal(new Set(weaponSkins).size, 1, 'both gun models reference exactly the same skin URL');
  for (const [name, data] of packed.assets) if (name.endsWith('.png')) {
    const source = path.basename(name).replace(/-[a-f0-9]{16}\.png$/, '.png');
    assert.deepEqual(data, fs.readFileSync(path.join(directory, source)), 'the edited PNG, including alpha, is deployed unchanged');
  }
});

test('deploy models: missing or malformed sources fail the build; edited skins invalidate dependent model URLs', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pj-models-'));
  onCleanup(() => {
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
    fs.rmSync(temp, { recursive: true, force: true });
  });
  assert.throws(() => packModels(temp), /Missing deploy model: gorge-body.png/);
  for (const name of PUBLIC_MODEL_FILES) fs.copyFileSync(path.join(directory, name), path.join(temp, name));
  const before = packModels(temp);
  fs.appendFileSync(path.join(temp, 'shieldgun.png'), Buffer.from([0]));
  const after = packModels(temp);
  assert.equal(before.models.gorge, after.models.gorge, 'unrelated model stays cached');
  assert.notEqual(before.models.first, after.models.first);
  assert.notEqual(before.models.third, after.models.third);
  fs.writeFileSync(path.join(temp, 'gorge-body.png'), '<html>not a skin</html>');
  assert.throws(() => packModels(temp), /Invalid deploy skin/);
  assert.throws(() => readGlb(Buffer.alloc(100)), /Invalid GLB/);
});

test('deploy models: real GLTFLoader resolves skins beneath a deploy prefix and downloads and decodes the gun skin once', async () => {
  const packed = packModels(directory), calls = [], bitmaps = [];
  const base = 'https://example.invalid/bongeszos-jatekok/';
  setGlobal('self', globalThis);
  setGlobal('fetch', async (url) => {
    calls.push(String(url));
    assert.ok(String(url).startsWith(base + 'assets/pj-models/'), 'all assets resolve under the deployed subpath');
    const data = packed.assets.get(String(url).slice(base.length));
    assert.ok(data, 'the referenced asset exists: ' + url);
    return new Response(data, { headers: { 'content-type': String(url).endsWith('.png') ? 'image/png' : 'model/gltf-binary' } });
  });
  setGlobal('createImageBitmap', async (blob) => {
    const bitmap = { width: 1024, height: 1024, bytes: blob.size, close() {} };
    bitmaps.push(bitmap);
    return bitmap;
  });
  const G = await import('../render/gorge.js');
  G.resetGorge();
  onCleanup(() => G.resetGorge());
  const loaded = await Promise.all(Object.values(packed.models).map((file) => G.fetchGltf(base + file)));
  assert.deepEqual(loaded.map((model) => model.gltf.animations.length), [36, 7, 1]);
  assert.equal(calls.length, 6, 'three GLBs and three PNGs, without requests for overrides or duplicate skins');
  assert.equal(bitmaps.length, 3, 'each skin is decoded once');
  const textures = loaded.map(({ gltf }) => {
    const maps = [];
    gltf.scene.traverse((o) => { if (o.isSkinnedMesh) { assert.ok(o.material.map); maps.push(o.material.map); } });
    return maps;
  });
  assert.equal(textures[1][0], textures[2][0], 'the gun variants share the texture object');
});

test('deploy models: production Vite build includes all six assets with working relative URLs and keeps the gun loader', async () => {
  const { build } = await import('vite');
  const result = await build({ root, logLevel: 'silent', build: { write: false, minify: false } });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((item) => item.output);
  const assets = new Map(outputs.filter((item) => item.type === 'asset').map((item) => [item.fileName, item]));
  const expected = packModels(directory);
  for (const [name, data] of expected.assets) assert.deepEqual(Buffer.from(assets.get(name)?.source || []), data, 'asset is present in the production output: ' + name);
  const code = outputs.filter((item) => item.type === 'chunk').map((item) => item.code).join('\n');
  assert.ok(code.includes('loadShieldGun'), 'the production gun loader is not tree-shaken away');
  for (const model of Object.values(expected.models)) {
    const chunk = outputs.find((item) => item.type === 'chunk' && item.code.includes(path.posix.basename(model)));
    assert.ok(chunk, 'each model is referenced from the built JS');
    const relative = path.posix.relative(path.posix.dirname(chunk.fileName), model);
    assert.ok(chunk.code.includes(JSON.stringify(relative)), 'URL is relative to the containing chunk, so Pages subpaths work');
  }
  assert.ok(!outputs.some((item) => /local-(models|sounds|maps)\//.test(item.fileName)), 'raw sources and local-only assets are not copied');
});
