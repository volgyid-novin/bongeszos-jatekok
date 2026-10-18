// The Gorge (UT2004 juggernaut), the default figure in development and deployment.
//   const tpl = await loadGorge();            the template { scene, clips: Map(name -> AnimationClip), bones, skins (the PNG overrides in use) } or null
//   gorgeTemplate()                            the template once loaded (else null), for the figures to check each frame
//   const rig = new GorgeRig(tpl, { ghost, solid, color });
//   rig.root (add it to the figure)  rig.play(brainOut)  rig.update(dt)  rig.setOpacity(a)  rig.info()  rig.dispose()
// The editable sources live in local-models/. The build packs them with shared, hashed skins. Anything wrong with a response
// (missing, an HTML page from the dev server's fallback, not a glb, not our skeleton) gives null and the figures keep the robot.
// Skin override: next to the glb the extractor also writes the two skins as editable PNGs (gorge-body.png, gorge-head.png, the UV layout of the
// glb's own textures). When one of them is there it replaces the matching texture of the glb (the player repainted Gorge); a missing, HTML,
// oversized or broken PNG leaves the glb's own texture in place, without an error. Nothing is fetched when the glb itself is not there.
//   rig materials: a solid figure (race players) is the opaque textured Gorge with a faint rim in the player's colour; a ghost is translucent
//   (the skin x the player's colour) with a depth-only copy drawn first, so limbs do not shine through each other.
import * as THREE from 'three';
import { lin } from './merge.js';
import { MODEL_ASSETS } from './model-assets.js';

const URL_GLB = MODEL_ASSETS.gorge;
export const GHOST_OPACITY = 0.55;
export const GHOST_TINT = 5;          // the skin is dark: the tint (player colour) is boosted so a ghost reads as coloured
const RIM = 0.55;              // strength of the player-colour rim on a solid figure
const SKIN_BODY = 'gorge-body.png', SKIN_HEAD = 'gorge-head.png';
const MAX_SKIN_PX = 4096;      // a repainted skin may be larger than the 1024 px of the glb, but not absurdly (a 4096 px texture is 64 MB of video memory)
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const NEEDED = ['Idle_Rifle', 'RunF', 'Jump_Mid'];   // a glb without these is not the file the extractor makes
const MAX_BYTES = 32 * 1024 * 1024;   // the real file is 2.7 MB: anything much bigger is not it, and is not downloaded to the end
// the depth-only prepass of a ghost goes into the opaque queue AFTER everything else there (level, solid figures: renderOrder 0): drawn first it
// would hide the level behind the ghost; the queue sorts by renderOrder before the material id
export const PREPASS_ORDER = 1;

let pending = null;   // the load, started once
let template = null;
const packedTextures = new Map();
// GLTFLoader instances share the deployed gun texture, including its in-flight
// request, decoded bitmap and GPU source. No global THREE.Cache setting is changed.
const modelManager = new THREE.LoadingManager();
modelManager.addHandler(/^(gorge-body|gorge-head|shieldgun)-[a-f0-9]{16}\.png$/, {
  load(url, onLoad, _onProgress, onError) {
    if (!packedTextures.has(url)) {
      packedTextures.set(url, fetchSkin(url).then((bitmap) => {
        if (!bitmap) throw new Error('Model skin could not be loaded: ' + url);
        const texture = new THREE.Texture(bitmap);
        texture.needsUpdate = true;
        return texture;
      }));
    }
    packedTextures.get(url).then(onLoad, onError);
  },
});

export const gorgeTemplate = () => template;
export function resetGorge() { pending = null; template = null; packedTextures.clear(); }   // (tests: load again with another fetch)

// -> Promise<template | null>; never rejects, loads once (a second call returns the same promise)
export function loadGorge(url = URL_GLB) {
  if (!pending) pending = fetchTemplate(url).catch(() => null).then((t) => { template = t; return t; });
  return pending;
}

// the body of a local file as an ArrayBuffer, or null: missing, not 200, an HTML page (the dev server answers a missing file with index.html),
// or longer than MAX_BYTES (by its content-length, or as soon as the stream passes it). A failing fetch throws.
export async function fetchBytes(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok || /html/i.test(res.headers.get('content-type') || '') || Number(res.headers.get('content-length')) > MAX_BYTES) {
      controller.abort();
      return null;
    }
    return await readCapped(res, MAX_BYTES);
  } finally { clearTimeout(timer); }
}

// a clip the extractor wrote as a loop ends on a copy of its first key; a clip that is played once and held must end on its real
// last frame instead, so that copy is cut off (only when every multi-key track really ends on its first value)
export function unwrap(clip) {
  let last = 0, wrapped = false;
  for (const t of clip.tracks) {
    const n = t.times.length, w = t.values.length / n;
    if (n < 3) continue;
    for (let i = 0; i < w; i++) if (Math.abs(t.values[i] - t.values[(n - 1) * w + i]) > 1e-4) return clip;
    wrapped = true;
    last = Math.max(last, t.times[n - 2]);
  }
  if (wrapped && last > 0) { clip.duration = last; clip.trim(); }
  return clip;
}

// a local glb parsed by three's GLTFLoader -> { gltf, clone (SkeletonUtils.clone) }, or null when it is not there (missing, not 200, an HTML page,
// too big, too small, not a glTF binary); a glb that is damaged makes parseAsync throw
export async function fetchGltf(url) {
  const [buf, { GLTFLoader }, { clone }] = await Promise.all([
    fetchBytes(url), import('three/addons/loaders/GLTFLoader.js'), import('three/addons/utils/SkeletonUtils.js'),
  ]);
  if (!buf || buf.byteLength < 1000 || new TextDecoder().decode(new Uint8Array(buf, 0, 4)) !== 'glTF') return null;
  let path = url.slice(0, url.lastIndexOf('/') + 1);
  try { path = new URL('.', new URL(url, globalThis.location?.href)).href; } catch { /* relative test / development URL */ }
  return { gltf: await new GLTFLoader(modelManager).parseAsync(buf, path), clone };
}

async function fetchTemplate(url) {
  const got = await fetchGltf(url);
  if (!got) return null;
  const { gltf, clone } = got;
  const clips = new Map(gltf.animations.map((a) => [a.name, a]));
  if (NEEDED.some((n) => !clips.has(n))) return null;
  for (const [name, clip] of clips) if (/_Mid$/.test(name)) unwrap(clip);   // the falling poses are held, not looped
  let bones = 0, skinned = 0;
  gltf.scene.traverse((o) => {
    if (o.isBone) bones++;
    if (o.isSkinnedMesh) {
      skinned++;
      o.frustumCulled = false;
      o.geometry.userData.shared = true;   // the figures never dispose what is shared
      const m = o.material;
      m.userData.shared = true;
      if (m.map) { m.map.userData.shared = true; m.map.anisotropy = 4; }
    }
  });
  if (!skinned || bones < 20) return null;
  const skins = MODEL_ASSETS.packed && url === URL_GLB ? [SKIN_BODY, SKIN_HEAD] : await applySkins(gltf.scene, url);
  return { scene: gltf.scene, clips, bones, clone, skins };
}

// which override file repaints a material of the glb (the extractor names the materials after the UT2004 skins, JuggMaleABodyA / JuggMaleAHeadA)
export function skinFileFor(materialName) {
  const n = String(materialName || '');
  return /body/i.test(n) ? SKIN_BODY : /head/i.test(n) ? SKIN_HEAD : null;
}

// a PNG next to the glb -> an ImageBitmap, or null (anything wrong: missing, HTML, too big, not a PNG, undecodable, no createImageBitmap)
async function fetchSkin(url) {
  try {
    if (typeof createImageBitmap !== 'function' || typeof Blob !== 'function') return null;
    const buf = await fetchBytes(url);
    if (!buf || buf.byteLength < 64) return null;
    const head = new Uint8Array(buf, 0, 8);
    if (PNG_MAGIC.some((b, i) => head[i] !== b)) return null;
    // (the options GLTFLoader uses for the glb's own textures: the colours are not touched, and flipY stays false on the texture)
    const bmp = await createImageBitmap(new Blob([buf], { type: 'image/png' }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    if (!bmp || !(bmp.width >= 1 && bmp.height >= 1 && bmp.width <= MAX_SKIN_PX && bmp.height <= MAX_SKIN_PX)) { if (bmp && bmp.close) bmp.close(); return null; }
    return bmp;
  } catch { return null; }
}

// Replace the base colour map of the body / head material with the player's PNG, in the glTF way (flipY false, sRGB, the sampler of the embedded
// texture). -> the files that were used. The template's materials are shared by every figure, so this runs once, before the first rig is made.
// fileFor(material name) names the PNG of a material (the shield gun, shieldgun.js, brings its own).
export async function applySkins(scene, glbUrl, fileFor = skinFileFor) {
  const dir = glbUrl.slice(0, glbUrl.lastIndexOf('/') + 1);
  const users = new Map();   // file -> [material]
  scene.traverse((o) => {
    const m = o.isSkinnedMesh && o.material;
    const file = m && m.map ? fileFor(m.name) : null;
    if (!file) return;
    if (!users.has(file)) users.set(file, new Set());
    users.get(file).add(m);
  });
  const used = [];
  await Promise.all([...users].map(async ([file, mats]) => {
    const bmp = await fetchSkin(dir + file);
    if (!bmp) return;
    for (const m of mats) {
      const old = m.map, tex = new THREE.Texture(bmp);
      tex.name = old.name || file;
      tex.flipY = false;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = old.wrapS; tex.wrapT = old.wrapT; tex.magFilter = old.magFilter; tex.minFilter = old.minFilter;
      tex.generateMipmaps = old.generateMipmaps; tex.anisotropy = old.anisotropy;
      tex.userData.shared = true;
      tex.userData.skinFile = file;
      tex.needsUpdate = true;
      m.map = tex;
      old.dispose();
    }
    used.push(file);
  }));
  return used.sort();
}

// the body of a response as one ArrayBuffer, or null as soon as it is longer than `max` bytes (a chunked response has no length to check first)
async function readCapped(res, max) {
  if (!res.body || !res.body.getReader) { const b = await res.arrayBuffer(); return b.byteLength > max ? null : b; }
  const reader = res.body.getReader(), chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out.buffer;
}

// a faint player-colour rim on a MeshStandardMaterial (view-dependent emissive; all figures share one program, the colour is a uniform)
function addRim(mat, color) {
  mat.userData.rim = { value: color };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.rimColor = mat.userData.rim;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 rimColor;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += rimColor * pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 4.0);');
  };
  mat.customProgramCacheKey = () => 'gorge-rim';
}

export class GorgeRig {
  constructor(tpl, { ghost = false, solid = false, color = 0xffffff } = {}) {
    this.tpl = tpl;
    this.translucent = ghost && !solid;
    this.root = tpl.clone(tpl.scene);
    this.root.name = 'gorge';
    this.mats = [];            // per-figure materials (the geometry, textures and skin of the template are shared and never disposed)
    this.fadeMats = [];        // the translucent ones, driven by setOpacity
    this.skinned = [];
    this.opacity = 1;
    const tint = new THREE.Color(...lin(color, GHOST_TINT));
    const rim = new THREE.Color(...lin(color, RIM));
    const meshes = [];
    this.root.traverse((o) => { if (o.isSkinnedMesh) meshes.push(o); });
    for (const mesh of meshes) {
      const map = mesh.material.map;
      let mat;
      if (this.translucent) {
        mat = new THREE.MeshBasicMaterial({ map, color: tint, transparent: true, opacity: GHOST_OPACITY, depthWrite: false });
        this.fadeMats.push(mat);
        // depth-only copy first (opaque queue, no colour): the translucent pass then only shows the nearest surface of the figure
        const pre = new THREE.SkinnedMesh(mesh.geometry, new THREE.MeshBasicMaterial({ colorWrite: false }));
        pre.bind(mesh.skeleton, mesh.bindMatrix);
        pre.frustumCulled = false;
        pre.renderOrder = PREPASS_ORDER;
        pre.name = mesh.name + ':depth';
        mesh.parent.add(pre);
        this.mats.push(pre.material);
      } else {
        mat = new THREE.MeshStandardMaterial({ map, roughness: 0.85, metalness: 0, emissive: new THREE.Color(0.12, 0.12, 0.12), emissiveMap: map });
        addRim(mat, rim);
      }
      mesh.material = mat;
      mesh.castShadow = !this.translucent;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      this.mats.push(mat);
      this.skinned.push(mesh);
    }
    this.mixer = new THREE.AnimationMixer(this.root);
    this.cur = null;           // { name, seq, action }
    this.used = new Set();     // every action started so far (info())
    this.out = null;
  }

  // the AnimBrain output: start / cross-fade / retime the clip
  play(out) {
    this.out = out;
    const cur = this.cur;
    if (cur && cur.name === out.clip && cur.seq === out.seq) { cur.action.setEffectiveTimeScale(out.timeScale); return; }
    const clip = this.tpl.clips.get(out.clip);
    if (!clip) return;   // a trimmed glb: keep what is playing
    const action = this.mixer.clipAction(clip);
    this.used.add(action);
    const run = /^Run[FBLR]$/;
    const phase = cur && cur.action !== action && run.test(cur.name) && run.test(out.clip) ? cur.action.time / cur.action.getClip().duration : -1;
    action.reset();
    action.setLoop(out.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    action.clampWhenFinished = true;
    action.setEffectiveTimeScale(out.timeScale);
    action.setEffectiveWeight(1);
    if (phase >= 0) action.time = phase * clip.duration;   // legs keep their phase when the run direction changes
    action.play();
    if (cur && cur.action !== action) cur.action.crossFadeTo(action, Math.max(0.02, out.fade), false);
    this.cur = { name: out.clip, seq: out.seq, action };
  }

  update(dt) { this.mixer.update(dt); }

  // ghost fade (camera inside the figure): 0..1 of the ghost opacity
  setOpacity(a) {
    this.opacity = a;
    for (const m of this.fadeMats) m.opacity = GHOST_OPACITY * a;
  }

  // what is playing (for __pj.state() / tests)
  info() {
    const a = this.cur && this.cur.action;
    return {
      model: 'gorge', clip: this.cur ? this.cur.name : null, loop: this.out ? this.out.loop : null, timeScale: a ? a.getEffectiveTimeScale() : 0,
      time: a ? Math.round(a.time * 1000) / 1000 : 0, weight: a ? Math.round(a.getEffectiveWeight() * 1000) / 1000 : 0,
      translucent: this.translucent, skinned: this.skinned.length, bones: this.skinned.length ? this.skinned[0].skeleton.bones.length : 0,
      active: [...this.used].filter((x) => x.getEffectiveWeight() > 0.001 && x.isRunning()).map((x) => x.getClip().name),
    };
  }

  dispose() {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
    this.used.clear();
    for (const m of this.mats) m.dispose();
    const seen = new Set();
    this.root.traverse((o) => { if (o.isSkinnedMesh && !seen.has(o.skeleton)) { seen.add(o.skeleton); o.skeleton.dispose(); } });   // (each clone has its own bone texture)
    this.root.removeFromParent();
    this.mats = []; this.fadeMats = []; this.skinned = [];
  }
}
