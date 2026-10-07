import * as THREE from 'three';
import { GPU, N } from '../gfx/backend.js';
import { ATMO, SUN_DIR } from '../gfx/atmosphere.js';

// ============================================================
//  The landmark (?gfx=landmark:1, docs/visual-next-steps.md E6): the wreck of a colossal bucket-wheel
//  excavator in the dunes (models/world/build_landmark.py -> assets/world/landmark.glb, three levels of
//  detail). One great silhouette made by people, seen from several stretches of the lap, to steer by.
//
//  Placed at load by a search over the map: a spot the track passes once at 150-260 m, ahead of the driver
//  (within ~30 degrees of the heading, 350-1300 m away) on as much straight track as possible; not in the
//  canyon or the arena, clear of the mesas and spires. It is turned broadside to those views (its outline
//  is its side), and tilted to follow the ground under it, then sunk a little into the sand. Static: the world
//  shadow and the cached mid shadow include it.
// ============================================================
export const LANDMARK_URL = new URL('../assets/world/landmark.glb', import.meta.url).href;

// how big it stands: 1.3 x the model (the pylon ~108 m, the wheel ~47 m across, ~280 m end to end)
export const LANDMARK_SCALE = 1.3;

// ctx: { TR, groundQuery, obstacles: [{ x, z, r }] }; returns { x, z, yaw, score, near } or null
export function placeLandmark({ TR, groundQuery, obstacles = [] }) {
  const sl = Math.hypot(SUN_DIR.x, SUN_DIR.z), sun = { x: SUN_DIR.x / sl, z: SUN_DIR.z / sl };
  let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
  for (let i = 0; i < TR.N; i++) { x0 = Math.min(x0, TR.px[i]); x1 = Math.max(x1, TR.px[i]); z0 = Math.min(z0, TR.pz[i]); z1 = Math.max(z1, TR.pz[i]); }
  const pad = 700, step = 40;
  let best = null;
  for (let x = x0 - pad; x <= x1 + pad; x += step) {
    for (let z = z0 - pad; z <= z1 + pad; z += step) {
      // the nearest pass: 150-260 m, not by the canyon or the arena
      let dmin = 1e9, imin = 0;
      for (let i = 0; i < TR.N; i += 2) { const d = Math.hypot(TR.px[i] - x, TR.pz[i] - z); if (d < dmin) { dmin = d; imin = i; } }
      if (dmin < 150 || dmin > 260 || TR.canyon[imin] > 0.05 || TR.arena[imin] > 0.05) continue;
      if (obstacles.some((o) => Math.hypot(o.x - x, o.z - z) < o.r + 180)) continue;
      // the views: track samples that look at it from 350-1300 m, nearly ahead, on the straighter parts, not from
      // down in the canyon or inside the arena's stands; best with the sun behind or beside the driver (looking
      // into it, the haze and the glare wash a far silhouette out)
      let score = 0, vx = 0, vz = 0;
      for (let i = 0; i < TR.N; i++) {
        const dx = x - TR.px[i], dz = z - TR.pz[i], d = Math.hypot(dx, dz);
        if (d < 350 || d > 1300) continue;
        const c = (dx * TR.tx[i] + dz * TR.tz[i]) / d;
        if (c < 0.87) continue;
        const toSun = Math.max(0, (dx * sun.x + dz * sun.z) / d);
        const w = (c - 0.87) / 0.13 * (1 - Math.min(1, Math.abs(TR.k[i]) / 0.006)) * (1 - 0.5 * (d - 350) / 950) * (1 - TR.canyon[i]) * (1 - TR.arena[i])
          * (1 - 0.8 * toSun);
        score += w; vx += dx / d * w; vz += dz / d * w;
      }
      if (!best || score > best.score) best = { x, z, score, vx, vz, near: dmin };
    }
  }
  if (!best || best.score <= 0) return null;
  // broadside to the views: its long axis (the boom, the model's +x) across the mean line of sight
  const yaw = Math.atan2(best.vx, best.vz);      // (three's yaw about y: +x of the model goes to (cos yaw, -sin yaw))
  return { x: best.x, z: best.z, yaw, score: best.score, near: best.near };
}

// vertex colour tint darkened by the baked occlusion (as the course's props: world/course.js)
function wreckMaterial() {
  const params = { vertexColors: true, roughness: 0.78, metalness: 0.35 };
  if (GPU) return N.propNodeMaterial(params);
  const m = new THREE.MeshStandardMaterial(params);
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, ATMO);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aAO;\nvarying float vAO;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvAO = aAO;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vAO;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= mix( 1.0, vAO, 0.75 );');
  };
  m.customProgramCacheKey = () => 'prop-ao';
  return m;
}

// models: loadRockModels(LANDMARK_URL); spot: placeLandmark(); returns the LOD object
export function buildLandmark({ scene, models, spot, groundQuery, lod = 1 }) {
  const levels = [0, 1, 2].map((k) => models.get(`wreck_lod${k}`)).filter(Boolean);
  if (!levels.length) return null;
  const obj = new THREE.LOD();
  const mat = wreckMaterial();
  levels.forEach((g, k) => {
    const m = new THREE.Mesh(g, mat);
    m.castShadow = m.receiveShadow = true;
    m.userData.rock = true;            // (a big static caster, as the rocks are)
    obj.addLevel(m, [0, 450, 1200][k] * lod * LANDMARK_SCALE);
  });
  // follow the ground: pitch along the boom (wheel end vs counterweight end), roll across it
  const K = LANDMARK_SCALE;
  const ax = Math.cos(spot.yaw), az = -Math.sin(spot.yaw);       // the model's +x in the world
  const g = (a, b) => groundQuery(spot.x + ax * a - az * b, spot.z + az * a + ax * b);
  const g0 = g(0, 0), gw = g(100 * K, 0), gc = g(-70 * K, 0), gl = g(0, -25 * K), gr = g(0, 25 * K);
  const pitch = Math.atan2(gw - gc, 170 * K) * 0.6, roll = Math.atan2(gr - gl, 50 * K) * 0.6;
  obj.position.set(spot.x, Math.min(g0, (gw + gc) / 2) - 3 * K, spot.z);
  obj.scale.setScalar(K);
  obj.rotation.set(0, spot.yaw, 0, 'YXZ');
  obj.rotateZ(pitch);
  obj.rotateX(-roll);
  obj.userData.landmark = true;
  scene.add(obj);
  return obj;
}
