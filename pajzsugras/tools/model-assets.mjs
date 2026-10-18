// Build the deployable models without changing the editable source files.
// Geometry, skeletons and animation data remain byte-for-byte intact. Embedded
// textures are replaced with the current PNG skins, shared by both gun models.
import { readFileSync } from 'node:fs';
import { resolve, posix } from 'node:path';
import { createHash } from 'node:crypto';

export const MODEL_FILES = {
  gorge: 'gorge.glb', first: 'shieldgun-1st.glb', third: 'shieldgun-3rd.glb',
};
export const SKIN_FILES = ['gorge-body.png', 'gorge-head.png', 'shieldgun.png'];
export const PUBLIC_MODEL_FILES = [...Object.values(MODEL_FILES), ...SKIN_FILES];
const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const hash = (data) => createHash('sha256').update(data).digest('hex').slice(0, 16);
const assetName = (name, data) => `assets/pj-models/${name.replace(/\.(glb|png)$/, '')}-${hash(data)}.${name.split('.').pop()}`;
const skinFor = (name) => /body/i.test(name) ? SKIN_FILES[0] : /head/i.test(name) ? SKIN_FILES[1] : /shieldtex/i.test(name) ? SKIN_FILES[2] : null;
const pad4 = (n) => (4 - n % 4) % 4;

export function readGlb(bytes) {
  if (bytes.length < 28 || bytes.toString('ascii', 0, 4) !== 'glTF' || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) throw new Error('Invalid GLB header');
  const jsonLength = bytes.readUInt32LE(12), binStart = 20 + jsonLength;
  if (bytes.readUInt32LE(16) !== 0x4e4f534a || binStart + 8 > bytes.length || bytes.readUInt32LE(binStart + 4) !== 0x004e4942 || binStart + 8 + bytes.readUInt32LE(binStart) !== bytes.length) throw new Error('Invalid GLB chunks');
  const json = JSON.parse(bytes.toString('utf8', 20, binStart));
  const bin = bytes.subarray(binStart + 8);
  if (json.buffers?.length !== 1 || json.buffers[0].uri || json.buffers[0].byteLength > bin.length || json.extensionsUsed?.length) throw new Error('Unsupported model buffers or extensions');
  return { json, bin };
}

function writeGlb(json, bin) {
  const text = Buffer.from(JSON.stringify(json));
  const body = Buffer.concat([text, Buffer.alloc(pad4(text.length), 0x20)]);
  const binary = Buffer.concat([bin, Buffer.alloc(pad4(bin.length))]);
  const header = Buffer.alloc(20), binHeader = Buffer.alloc(8);
  header.write('glTF'); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + body.length + binary.length, 8);
  header.writeUInt32LE(body.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  binHeader.writeUInt32LE(binary.length); binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, body, binHeader, binary]);
}

export function packGlb(bytes, skins) {
  const { json, bin } = readGlb(bytes);
  const removed = new Set();
  if (!json.images?.length) throw new Error('Model has no skins');
  for (const image of json.images) {
    const skin = skins.get(skinFor(image.name));
    if (!skin || !Number.isInteger(image.bufferView)) throw new Error(`Unknown model skin: ${image.name}`);
    removed.add(image.bufferView);
    delete image.bufferView;
    image.uri = posix.basename(skin.fileName);
  }
  const remap = new Map(), views = [], chunks = [];
  let length = 0;
  for (const [index, view] of json.bufferViews.entries()) {
    if (removed.has(index)) continue;
    const start = view.byteOffset || 0;
    if (view.buffer !== 0 || !Number.isInteger(start) || start < 0 || !Number.isInteger(view.byteLength) || view.byteLength < 1 || start + view.byteLength > bin.length) throw new Error('Invalid model buffer view');
    const padding = pad4(length);
    chunks.push(Buffer.alloc(padding)); length += padding;
    remap.set(index, views.length);
    views.push({ ...view, byteOffset: length });
    chunks.push(bin.subarray(start, start + view.byteLength)); length += view.byteLength;
  }
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'bufferView') {
        if (!remap.has(child)) throw new Error('An image buffer is also used as model data');
        value[key] = remap.get(child);
      } else visit(child);
    }
  };
  visit(json);
  json.bufferViews = views;
  json.buffers[0].byteLength = length;
  return writeGlb(json, Buffer.concat(chunks));
}

export function packModels(directory) {
  const assets = new Map(), skins = new Map(), models = {};
  let sourceBytes = 0;
  const read = (file) => {
    let data;
    try { data = readFileSync(resolve(directory, file)); }
    catch { throw new Error(`Missing deploy model: ${file}. Include all six pajzsugras/local-models files in the checkout.`); }
    sourceBytes += data.length;
    return data;
  };
  for (const file of SKIN_FILES) {
    const data = read(file);
    if (data.length < 33 || !data.subarray(0, 8).equals(PNG_MAGIC) || data.toString('ascii', 12, 16) !== 'IHDR' || ![16, 20].every((offset) => data.readUInt32BE(offset) >= 1 && data.readUInt32BE(offset) <= 4096)) throw new Error(`Invalid deploy skin: ${file}`);
    const fileName = assetName(file, data);
    assets.set(fileName, data); skins.set(file, { fileName });
  }
  for (const [key, file] of Object.entries(MODEL_FILES)) {
    const data = packGlb(read(file), skins);
    const fileName = assetName(file, data);
    assets.set(fileName, data); models[key] = fileName;
  }
  return { assets, models, sourceBytes };
}

export function modelAssetsPlugin() {
  let root;
  return {
    name: 'pajzsugras-deploy-models',
    apply: 'build',
    enforce: 'pre',
    configResolved(config) { root = config.root; },
    transform(_code, id) {
      if (id.replace(/\\/g, '/') !== resolve(root, 'pajzsugras/render/model-assets.js').replace(/\\/g, '/')) return;
      const directory = resolve(root, 'pajzsugras/local-models');
      for (const file of PUBLIC_MODEL_FILES) this.addWatchFile(resolve(directory, file));
      const { assets, models } = packModels(directory);
      const refs = new Map();
      for (const [fileName, source] of assets) refs.set(fileName, this.emitFile({ type: 'asset', fileName, source }));
      return {
        code: `export const MODEL_ASSETS = { packed: true, ${Object.entries(models).map(([key, file]) => `${key}: import.meta.ROLLUP_FILE_URL_${refs.get(file)}`).join(', ')} };`,
        map: null,
      };
    },
    resolveFileUrl({ fileName, chunkId }) {
      if (!fileName.startsWith('assets/pj-models/')) return;
      return `new URL(${JSON.stringify(posix.relative(posix.dirname(chunkId), fileName))}, import.meta.url).href`;
    },
  };
}
