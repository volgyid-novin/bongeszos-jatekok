import * as THREE from 'three';
import { GPU } from './backend.js';

// ============================================================
//  One draw for every copy of a small effect piece (nozzle throats, ground decals, beam flares,
//  flame glows) on all the pods, instead of one draw per pod.
//
//  The pods keep a plain Object3D where the piece used to be, so it still follows the engine or
//  the beam through the scene graph. Each frame push() copies its world matrix and a few values
//  into the batch; flush() uploads them once every pod has been updated.
//  Values arrive in the shader as per-instance attributes (attrs: { name: itemSize }).
//
//  billboard: camera-facing pieces that only need the anchor's position and size. On
//  WebGPURenderer those are a plain instanced geometry with iBB = (world position, x scale) and
//  iBS = y scale: node materials apply an InstancedMesh's matrix to the vertex before they see it,
//  and its matrix buffers (this frame's and the last, for the velocity pass) would also take two of
//  the eight vertex buffers a pipeline may have.
// ============================================================
export class FxBatch {
  constructor(scene, geometry, material, capacity, attrs, renderOrder = 0, { billboard = false } = {}) {
    const g = geometry.clone();
    this.bb = GPU && billboard;
    if (this.bb) attrs = { ...attrs, iBB: 4, iBS: 1 };
    this.attrs = Object.entries(attrs).map(([name, size]) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * size), size).setUsage(THREE.DynamicDrawUsage);
      g.setAttribute(name, a);
      return a;
    });
    let m;
    if (this.bb) {
      const ig = new THREE.InstancedBufferGeometry();        // (the same attribute objects, not copies)
      ig.index = g.index;
      for (const [name, a] of Object.entries(g.attributes)) ig.setAttribute(name, a);
      ig.instanceCount = 0;
      m = new THREE.Mesh(ig, material);
    } else {
      m = new THREE.InstancedMesh(g, material, capacity);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
    }
    m.frustumCulled = false;            // the instances move every frame
    m.renderOrder = renderOrder;
    m.visible = false;
    m.userData.dynamic = true;          // not part of the baked world shadow
    scene.add(m);
    this.mesh = m;
    this.cap = capacity;
    this.n = 0;
  }
  // matrix: world matrix; one value per attribute: a number, an array, or a Color / Vector
  push(matrix, ...vals) {
    if (this.n >= this.cap) return;
    const i = this.n++;
    if (this.bb) {
      const e = matrix.elements, bb = this.attrs[this.attrs.length - 2].array, bs = this.attrs[this.attrs.length - 1].array;
      bb[i * 4] = e[12]; bb[i * 4 + 1] = e[13]; bb[i * 4 + 2] = e[14];
      bb[i * 4 + 3] = Math.hypot(e[0], e[1], e[2]);
      bs[i] = Math.hypot(e[4], e[5], e[6]);
    } else this.mesh.setMatrixAt(i, matrix);
    this.attrs.forEach((a, k) => {
      if (k >= vals.length) return;
      const v = vals[k], o = i * a.itemSize;
      if (typeof v === 'number') a.array[o] = v;
      else if (v.toArray) v.toArray(a.array, o);
      else a.array.set(v, o);
    });
  }
  flush() {
    const m = this.mesh;
    m.visible = this.n > 0;
    if (this.bb) m.geometry.instanceCount = this.n;
    else m.count = this.n;
    if (this.n) {
      if (!this.bb) m.instanceMatrix.needsUpdate = true;
      for (const a of this.attrs) a.needsUpdate = true;
    }
    this.n = 0;
  }
}

// is o drawn: it and every parent visible
export function shown(o) {
  for (let p = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}
