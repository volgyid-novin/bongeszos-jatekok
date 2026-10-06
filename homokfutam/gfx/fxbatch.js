import * as THREE from 'three';

// ============================================================
//  One draw for every copy of a small effect piece (nozzle throats, ground decals, beam flares,
//  flame glows) on all the pods, instead of one draw per pod.
//
//  The pods keep a plain Object3D where the piece used to be, so it still follows the engine or
//  the beam through the scene graph. Each frame push() copies its world matrix and a few values
//  into the batch; flush() uploads them once every pod has been updated.
//  Values arrive in the shader as per-instance attributes (attrs: { name: itemSize }).
// ============================================================
export class FxBatch {
  constructor(scene, geometry, material, capacity, attrs, renderOrder = 0) {
    const g = geometry.clone();
    this.attrs = Object.entries(attrs).map(([name, size]) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * size), size).setUsage(THREE.DynamicDrawUsage);
      g.setAttribute(name, a);
      return a;
    });
    const m = new THREE.InstancedMesh(g, material, capacity);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled = false;            // the instances move every frame
    m.renderOrder = renderOrder;
    m.count = 0;
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
    this.mesh.setMatrixAt(i, matrix);
    this.attrs.forEach((a, k) => {
      const v = vals[k], o = i * a.itemSize;
      if (typeof v === 'number') a.array[o] = v;
      else if (v.toArray) v.toArray(a.array, o);
      else a.array.set(v, o);
    });
  }
  flush() {
    const m = this.mesh;
    m.count = this.n;
    m.visible = this.n > 0;
    if (this.n) {
      m.instanceMatrix.needsUpdate = true;
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
