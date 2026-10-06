import * as THREE from 'three';
import { ktx2Loader } from '../gfx/ground.js';

// ============================================================
//  The far horizon: desert ranges rendered in Blender (models/world/build_panorama.py) as a
//  360-degree band, on an open ring that follows the camera (so it stays "infinitely" far)
//  and gets the same height fog as everything else.
// ============================================================
const LAT_MIN = -3, LAT_MAX = 9;               // degrees, as rendered
const RADIUS = 7600, EYE = 40;                 // ring radius, camera height of the render

export function buildHorizon(scene, renderer) {
  const big = renderer.capabilities.maxTextureSize >= 8192;
  const url = new URL(`../assets/world/${big ? 'panorama' : 'panorama_4k'}.ktx2`, import.meta.url).href;
  const loader = ktx2Loader(renderer);
  return loader.loadAsync(url).then((tex) => {
    loader.dispose();
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = 4;
    // rows follow the latitude (equirectangular), columns the game azimuth atan2(z, x)
    const segs = 256, rows = 10, pos = [], uv = [], index = [];
    for (let j = 0; j <= rows; j++) {
      const lat = THREE.MathUtils.degToRad(LAT_MIN + (LAT_MAX - LAT_MIN) * j / rows);
      const y = RADIUS * Math.tan(lat) + EYE;
      for (let i = 0; i <= segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        pos.push(Math.cos(a) * RADIUS, y, Math.sin(a) * RADIUS);
        uv.push(i / segs, j / rows);
      }
    }
    for (let j = 0; j < rows; j++) for (let i = 0; i < segs; i++) {
      const a = j * (segs + 1) + i, b = a + segs + 1;
      index.push(a, b, a + 1, a + 1, b, b + 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(index);
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide, color: new THREE.Color(0.92, 0.9, 0.88) });
    const ring = new THREE.Mesh(g, mat);
    ring.frustumCulled = false;
    ring.renderOrder = -0.5;
    ring.userData.noBake = true;
    scene.add(ring);
    return {
      mesh: ring,
      update(cam) { ring.position.set(cam.x, 0, cam.z); },
    };
  });
}
