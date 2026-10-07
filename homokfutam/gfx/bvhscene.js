import * as THREE from 'three';

// The static world as triangles for the BVHs of the light bake (gfx/gibake.js) and the ray-traced reflections
// (gfx/tsl/rt.js); gfx/bvh.js builds and walks them.

// what the light bake and the ray tracer leave out: as the world shadow bake (gfx/atmosphere.js), anything under a
// mover, and the small scatter
function excluded(o) {
  for (let p = o; p; p = p.parent) if (p.userData.dynamic || p.userData.noBake || p.userData.scatter) return true;
  if (o.isPoints || o.isSprite || o.isLine || o.isSkinnedMesh) return true;
  const m = Array.isArray(o.material) ? o.material[0] : o.material;
  return !m || m.transparent || m.isShaderMaterial || m.isMeshBasicMaterial || m.isMeshBasicNodeMaterial;
}

// The static triangles that touch region (a Box3), with an albedo each (sand / stone: linear albedos for the ground
// and for textured structures with a white material colour). Canyon walls (userData.canyonWall) are double sided:
// with towards(x, z) -> [x, z] their triangles are turned to face the track, so back-face hits mean "inside rock".
// skip(o): leave an object out as well (the reflections leave the ground to the probes); keep(x, y, z): a test on
// each triangle's centre (the reflections keep a corridor along the track)
export function collectStatic(scene, region, towards = null, { sand = [0.55, 0.4, 0.25], stone = [0.5, 0.42, 0.33], skip = null, keep = null } = {}) {
  const tris = [], alb = [];
  const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], m4 = new THREE.Matrix4(), im = new THREE.Matrix4();
  const tb = new THREE.Box3(), c = new THREE.Color();
  const add = (o, mw) => {
    const g = o.geometry, pos = g.attributes.position, col = g.attributes.color, ix = g.index;
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    const base = o.userData.terrain || o.userData.track ? sand : null;
    const mc = mat.color || new THREE.Color(1, 1, 1);
    const n = ix ? ix.count / 3 : pos.count / 3;
    for (let t = 0; t < n; t++) {
      const a = ix ? ix.getX(t * 3) : t * 3, b = ix ? ix.getX(t * 3 + 1) : t * 3 + 1, d = ix ? ix.getX(t * 3 + 2) : t * 3 + 2;
      v[0].fromBufferAttribute(pos, a).applyMatrix4(mw); v[1].fromBufferAttribute(pos, b).applyMatrix4(mw); v[2].fromBufferAttribute(pos, d).applyMatrix4(mw);
      tb.makeEmpty().expandByPoint(v[0]).expandByPoint(v[1]).expandByPoint(v[2]);
      if (!tb.intersectsBox(region)) continue;
      if (keep && !keep((v[0].x + v[1].x + v[2].x) / 3, (v[0].y + v[1].y + v[2].y) / 3, (v[0].z + v[1].z + v[2].z) / 3)) continue;
      let [p0, p1, p2] = v;
      if (o.userData.canyonWall && towards) {
        // steep faces towards the nearest centre-line point, flat ones (the plateau) up
        const ex = p1.x - p0.x, ey = p1.y - p0.y, ez = p1.z - p0.z, fx = p2.x - p0.x, fy = p2.y - p0.y, fz = p2.z - p0.z;
        const nx = ey * fz - ez * fy, ny = ez * fx - ex * fz, nz = ex * fy - ey * fx;
        if (Math.abs(ny) > 0.7 * Math.hypot(nx, ny, nz)) { if (ny < 0) [p1, p2] = [p2, p1]; }
        else { const [tx, tz] = towards(p0.x, p0.z); if (nx * (tx - p0.x) + nz * (tz - p0.z) < 0) [p1, p2] = [p2, p1]; }
      }
      tris.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
      if (base) alb.push(...base);
      else if (col) {
        let r = 0, gg = 0, bb = 0;
        for (const k of [a, b, d]) { r += col.getX(k); gg += col.getY(k); bb += col.getZ(k); }
        alb.push(r / 3 * mc.r, gg / 3 * mc.g, bb / 3 * mc.b);
      } else if (mat.map || (mc.r > 0.99 && mc.g > 0.99 && mc.b > 0.99)) alb.push(stone[0] * mc.r, stone[1] * mc.g, stone[2] * mc.b);
      else { c.copy(mc); alb.push(c.r, c.g, c.b); }
    }
  };
  scene.updateMatrixWorld(true);
  scene.traverse((o) => {
    if (!o.isMesh || excluded(o) || skip?.(o)) return;
    // a LOD contributes its finest level only; LodInstances levels: only the visible (forced) one
    if (o.parent?.isLOD && o.parent.levels[0]?.object !== o) return;
    let vis = true;
    for (let p = o; p; p = p.parent) if (!p.visible && !(p.parent?.isLOD)) vis = false;
    if (!vis) return;
    if (o.isInstancedMesh) {
      for (let k = 0; k < o.count; k++) { o.getMatrixAt(k, im); m4.multiplyMatrices(o.matrixWorld, im); add(o, m4); }
    } else add(o, o.matrixWorld);
  });
  return { tris: new Float32Array(tris), alb: new Float32Array(alb) };
}
