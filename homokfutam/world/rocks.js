import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

// ============================================================
//  Rock models from Blender (models/world/build_rocks.py -> assets/world/rocks.glb) and an
//  instanced level-of-detail field for the many copies (spires, boulders, talus).
// ============================================================
export const ROCKS_URL = new URL('../assets/world/rocks.glb', import.meta.url).href;

// float copy of a (possibly quantized) attribute
function toFloat(attr, itemSize = attr.itemSize) {
  const n = attr.count, a = new Float32Array(n * itemSize);
  for (let i = 0; i < n; i++) for (let k = 0; k < itemSize; k++) a[i * itemSize + k] = attr.getComponent(i, k);
  return new THREE.BufferAttribute(a, itemSize);
}

// name -> geometry in world units: position, normal, color (rgb) and aAO (the baked occlusion
// that the Blender script stores in the colour's alpha)
export function loadRockModels(url = ROCKS_URL) {
  return new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(url).then((gltf) => {
    gltf.scene.updateMatrixWorld(true);
    const out = new Map();
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      const src = o.geometry, g = new THREE.BufferGeometry();
      g.setAttribute('position', toFloat(src.attributes.position));
      if (src.attributes.normal) g.setAttribute('normal', toFloat(src.attributes.normal));
      const col = src.attributes.color;
      if (col) {
        const c = toFloat(col), n = col.count, rgb = new Float32Array(n * 3), ao = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          rgb[i * 3] = c.array[i * c.itemSize]; rgb[i * 3 + 1] = c.array[i * c.itemSize + 1]; rgb[i * 3 + 2] = c.array[i * c.itemSize + 2];
          ao[i] = c.itemSize > 3 ? c.array[i * 4 + 3] : 1;
        }
        g.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
        g.setAttribute('aAO', new THREE.BufferAttribute(ao, 1));
      }
      g.setIndex(src.index ? Array.from(src.index.array) : null);
      g.applyMatrix4(o.matrixWorld);
      if (!g.attributes.normal) g.computeVertexNormals();
      g.computeBoundingBox();
      g.computeBoundingSphere();
      // gltfpack keeps the named node and hangs an unnamed mesh node under it (three calls it mesh_N)
      out.set(/^(mesh_\d+|_?\d*)$/.test(o.name) ? o.parent?.name : o.name, g);
    });
    return out;
  });
}

// Many copies of a few shapes, each shape with 1..3 levels of detail. items: { g (variant),
// m (Matrix4), x, y, z, r (rough radius, for the distance test) }. dists: switch distances.
export class LodInstances {
  // cull: items beyond the last distance are not drawn at all (small scatter)
  constructor(scene, variants, mat, items, dists, { shadow = true, flag = 'rock', cull = false, noBake = false } = {}) {
    this.items = items;
    this.cull = cull;
    items.forEach((it, i) => { it._i = i; });
    this.dists = dists;
    this.meshes = variants.map((lods, vi) => {
      const mine = items.filter((it) => it.g % variants.length === vi);
      return lods.map((geo) => {
        const im = new THREE.InstancedMesh(geo, mat, Math.max(1, mine.length));
        mine.forEach((it, k) => im.setMatrixAt(k, it.m));
        im.count = mine.length;
        im.computeBoundingSphere();         // over every instance: stays valid whatever the LOD split
        im.count = 0;
        im.castShadow = shadow; im.receiveShadow = true;
        im.userData[flag] = true;
        if (noBake) im.userData.noBake = true;
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        scene.add(im);
        return im;
      });
    });
    this.byVariant = variants.map((_, vi) => items.filter((it) => it.g % variants.length === vi));
    this.sig = new Int8Array(items.length).fill(-2);
    this.force(Math.min(1, variants[0].length - 1));
  }
  // every instance at one level (for the one-off bakes)
  force(lod) { this._assign(() => lod); }
  update(cam) {
    const { dists } = this;
    this._assign((it) => {
      const d = Math.hypot(it.x - cam.x, it.y - cam.y, it.z - cam.z) - it.r;
      return d < dists[0] ? 0 : d < (dists[1] ?? Infinity) ? 1 : 2;
    });
  }
  _assign(pick) {
    this.byVariant.forEach((list, vi) => {
      const lods = this.meshes[vi], L = lods.length;
      let changed = false;
      const want = list.map((it) => { const w = pick(it); return w >= L ? (this.cull ? -1 : L - 1) : w; });
      list.forEach((it, k) => { if (this.sig[it._i] !== want[k]) { changed = true; this.sig[it._i] = want[k]; } });
      if (!changed) return;
      const n = new Array(L).fill(0);
      list.forEach((it, k) => { if (want[k] >= 0) lods[want[k]].setMatrixAt(n[want[k]]++, it.m); });
      lods.forEach((m, l) => { m.count = n[l]; m.instanceMatrix.needsUpdate = true; });
    });
  }
}
