import * as THREE from 'three';
import { LodInstances } from './rocks.js';
import { MACRO, macroAt } from './macro.js';
import { buildGrass } from './grass.js';
import { ATMO } from '../gfx/atmosphere.js';
import { GPU, W, TSL } from '../gfx/backend.js';

// ============================================================
//  Ground clutter from assets/world/props.glb (models/world/build_props.py): pebbles and
//  stones (densest where the macro map says gravel: around rocks, in the flats, upwind scour),
//  dry shrubs, a few carcasses and bones, and scrap from crashed pods along the track.
//  Instanced, drawn only near the camera; counts follow the dressing setting. Each field's copies rise out of the
//  ground over the last ~28 % of its draw distance (they popped in at it): the materials are made per field with
//  that distance (fadeRock, fadeMetal: main.js; the plain ones here).
// ============================================================

// a vertex-coloured standard material whose copies rise out of the ground (sunk by depth m) towards far
function fadedStandard(params, far, depth) {
  if (GPU) {
    const { positionLocal, cameraPosition, vec3, smoothstep, length } = TSL;
    const m = new W.MeshStandardNodeMaterial(params);
    m.positionNode = positionLocal.sub(vec3(0, smoothstep(far * 0.72, far, length(positionLocal.sub(cameraPosition))).mul(depth), 0));
    return m;
  }
  const m = new THREE.MeshStandardMaterial(params);
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, ATMO);
    sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      #ifdef USE_INSTANCING
        transformed.y -= smoothstep( ${(far * 0.72).toFixed(2)}, ${far.toFixed(2)}, distance( ( modelMatrix * instanceMatrix[ 3 ] ).xyz, cameraPosition ) ) * ${depth.toFixed(2)} / max( length( instanceMatrix[ 1 ].xyz ), 1e-3 );
      #endif`);
  };
  m.customProgramCacheKey = () => `scatter-fade-${far}-${depth}`;
  return m;
}

export function buildScatter({ scene, TR, Q, groundQuery, rng, models, rockMat, metalMat, fadeRock, fadeMetal }) {
  const rand = rng(5150), D = Q.dressing;
  const TAU = Math.PI * 2;
  const P = new THREE.Vector3(), S = new THREE.Vector3(), E = new THREE.Euler(), QQ = new THREE.Quaternion();
  const item = (g, x, z, scale, sink, tilt = 0.25, sy = scale) => {
    const y = groundQuery(x, z);
    const m = new THREE.Matrix4().compose(P.set(x, y - sink, z), QQ.setFromEuler(E.set((rand() - 0.5) * tilt, rand() * TAU, (rand() - 0.5) * tilt)), S.set(scale, sy, scale));
    return { g, x, y, z, r: scale, m };
  };
  // a point beside the track, `o` metres out from the edge; null in the arena
  const beside = (o) => {
    const i = Math.floor(rand() * TR.N);
    if (TR.arena[i] > 0.2) return null;
    const side = rand() < 0.5 ? -1 : 1, hw = TR.hw[i];
    const off = TR.canyon[i] > 0.3 ? hw + 0.7 + rand() * 1.4 : hw + o;      // in the canyon: only along the wall feet
    return { i, x: TR.px[i] - TR.tz[i] * side * off, z: TR.pz[i] + TR.tx[i] * side * off };
  };
  const gravelish = (x, z) => MACRO.ready ? Math.min(1, macroAt(MACRO.apron, x, z) * 1.2 + macroAt(MACRO.basin, x, z) * 0.6 + macroAt(MACRO.bedrock, x, z)) : 0.3;
  const out = [];
  // mat: a material, or a function of the fade ({ far, depth }) that makes one for this field
  const field = (variants, items, mat, dist, opts = {}, depth = 1) => {
    if (!items.length || variants.some((v) => !v)) return;
    const far = dist * (Q.lod ?? 1);
    const m = typeof mat === 'function' ? mat({ far, depth }) : mat;
    out.push(new LodInstances(scene, variants.map((g) => [g]), m, items, [far], { cull: true, flag: 'scatter', noBake: true, ...opts }));
  };
  const rockF = fadeRock || rockMat, metalF = fadeMetal || metalMat;
  const plainF = (params) => ({ far, depth }) => fadedStandard(params, far, depth);

  // pebbles and stones
  const pebbles = [], stones = [];
  for (let k = 0, n = Math.round(5200 * D); k < n; k++) {
    const p = beside(1.5 + 130 * Math.pow(rand(), 1.8));
    if (!p || rand() > 0.3 + 0.7 * gravelish(p.x, p.z)) continue;
    pebbles.push(item(k % 3, p.x, p.z, 0.6 + rand() * 1.6, 0.02, 0.6));
  }
  // ?gfx=grass:1 (docs/visual-next-steps.md C8): the near band gets twice the pebbles (same draws)
  if (Q.grass) for (let k = 0, n = Math.round(5200 * D); k < n; k++) {
    const p = beside(1.2 + 70 * Math.pow(rand(), 1.6));
    if (!p || rand() > 0.35 + 0.65 * gravelish(p.x, p.z)) continue;
    pebbles.push(item(k % 3, p.x, p.z, 0.5 + rand() * 1.4, 0.02, 0.6));
  }
  for (let k = 0, n = Math.round(1900 * D); k < n; k++) {
    const p = beside(3 + 190 * Math.pow(rand(), 2));
    if (!p || rand() > 0.25 + 0.75 * gravelish(p.x, p.z)) continue;
    const s = 0.5 + rand() * rand() * 1.8;
    stones.push(item(k % 3, p.x, p.z, s, 0.08 * s, 0.5));
  }
  field([models.get('pebble0'), models.get('pebble1'), models.get('pebble2')], pebbles, rockF, 110, { shadow: false }, 0.4);
  field([models.get('stone0'), models.get('stone1'), models.get('stone2')], stones, rockF, 260, {}, 1.5);

  // dry shrubs on the sand, not on steep slopes
  const bushMat = plainF({ vertexColors: true, roughness: 0.95 });
  const bushes = [];
  for (let k = 0, n = Math.round(260 * D); k < n; k++) {
    const p = beside(7 + 170 * Math.pow(rand(), 1.4));
    if (!p) continue;
    const slope = Math.abs(groundQuery(p.x + 1.5, p.z) - groundQuery(p.x - 1.5, p.z)) + Math.abs(groundQuery(p.x, p.z + 1.5) - groundQuery(p.x, p.z - 1.5));
    if (slope > 1.2) continue;
    const s = 0.7 + rand() * 0.8;
    bushes.push(item(k % 2, p.x, p.z, s, 0.1, 0.2, s * (0.8 + rand() * 0.4)));
  }
  field([models.get('bush0'), models.get('bush1')], bushes, bushMat, 320, {}, 3);

  // ?gfx=grass:1: tufts of dry grass on the sand by the track, thickest along the berm, none on gravel,
  // slopes or in the canyon; drawn within ~75 m (they are small, and a pixel or less further out)
  if (Q.grass) {
    const tufts = [];
    for (let k = 0, n = Math.round(26000 * D); k < n; k++) {
      const p = beside(2.2 + 60 * Math.pow(rand(), 2.2));
      if (!p || TR.canyon[p.i] > 0.2 || rand() < gravelish(p.x, p.z) * 0.85) continue;
      const y0 = groundQuery(p.x, p.z);
      if (Math.abs(groundQuery(p.x + 1, p.z) - y0) + Math.abs(groundQuery(p.x, p.z + 1) - y0) > 0.45) continue;
      // in loose clumps: a few more tufts round each one
      const m = rand() < 0.5 ? 1 + Math.floor(rand() * 4) : 1;
      for (let j = 0; j < m; j++) {
        const x = p.x + (j ? (rand() - 0.5) * 2.5 : 0), z = p.z + (j ? (rand() - 0.5) * 2.5 : 0), s = 0.9 + rand() * 0.9;
        const y = (j ? groundQuery(x, z) : y0) - 0.03;
        const sx = s * (0.75 + rand() * 0.5), sz = s * (0.75 + rand() * 0.5);
        tufts.push({ s: TR.s[p.i], x, y, z, m: new THREE.Matrix4().compose(P.set(x, y, z), QQ.identity(), S.set(sx, s * (0.8 + rand() * 0.5), sz)) });
      }
    }
    out.push(buildGrass(scene, tufts, TR.L, 75 * (Q.lod ?? 1)));
  }

  // the remains of animals that didn't make it across
  const boneMat = plainF({ vertexColors: true, roughness: 0.7 });
  const carc = [], bones = [];
  for (let k = 0; k < 7; k++) { const p = beside(14 + rand() * 70); if (p) carc.push(item(0, p.x, p.z, 1.2 + rand() * 0.8, 0.12, 0.15)); }
  for (let k = 0; k < 16; k++) { const p = beside(6 + rand() * 60); if (p) bones.push(item(0, p.x, p.z, 0.9 + rand() * 0.5, 0.02, 0.1)); }
  field([models.get('carcass')], carc, boneMat, 260, {}, 1.2);
  field([models.get('bones')], bones, boneMat, 160, { shadow: false }, 0.3);

  // scrap from pods that crashed here: a panel, a pipe and sometimes a burnt engine, together
  const panels = [], pipes = [], engines = [];
  for (let k = 0, n = Math.round(30 * D); k < n; k++) {
    const p = beside(5 + rand() * 35);
    if (!p) continue;
    const a = rand() * TAU;
    panels.push(item(0, p.x, p.z, 0.8 + rand() * 0.5, 0.05, 0.6));
    pipes.push(item(0, p.x + Math.cos(a) * 3, p.z + Math.sin(a) * 3, 0.8 + rand() * 0.6, 0.04, 0.3));
    if (rand() < 0.4) engines.push(item(0, p.x - Math.cos(a) * 5, p.z - Math.sin(a) * 5, 0.9 + rand() * 0.4, 0.35, 0.5));
  }
  field([models.get('scrap_panel')], panels, metalF, 240, {}, 1);
  field([models.get('scrap_pipe')], pipes, metalF, 180, { shadow: false }, 0.5);
  field([models.get('scrap_engine')], engines, metalF, 320, {}, 1.6);
  return out;
}
