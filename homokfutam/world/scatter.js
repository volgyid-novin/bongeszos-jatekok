import * as THREE from 'three';
import { LodInstances } from './rocks.js';
import { MACRO, macroAt } from './macro.js';

// ============================================================
//  Ground clutter from assets/world/props.glb (models/world/build_props.py): pebbles and
//  stones (densest where the macro map says gravel: around rocks, in the flats, upwind scour),
//  dry shrubs, a few carcasses and bones, and scrap from crashed pods along the track.
//  Instanced, drawn only near the camera; counts follow the dressing setting.
// ============================================================
export function buildScatter({ scene, TR, Q, groundQuery, rng, models, rockMat, metalMat }) {
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
  const field = (variants, items, mat, dist, opts = {}) => {
    if (!items.length || variants.some((v) => !v)) return;
    out.push(new LodInstances(scene, variants.map((g) => [g]), mat, items, [dist * (Q.lod ?? 1)], { cull: true, flag: 'scatter', noBake: true, ...opts }));
  };

  // pebbles and stones
  const pebbles = [], stones = [];
  for (let k = 0, n = Math.round(5200 * D); k < n; k++) {
    const p = beside(1.5 + 130 * Math.pow(rand(), 1.8));
    if (!p || rand() > 0.3 + 0.7 * gravelish(p.x, p.z)) continue;
    pebbles.push(item(k % 3, p.x, p.z, 0.6 + rand() * 1.6, 0.02, 0.6));
  }
  for (let k = 0, n = Math.round(1900 * D); k < n; k++) {
    const p = beside(3 + 190 * Math.pow(rand(), 2));
    if (!p || rand() > 0.25 + 0.75 * gravelish(p.x, p.z)) continue;
    const s = 0.5 + rand() * rand() * 1.8;
    stones.push(item(k % 3, p.x, p.z, s, 0.08 * s, 0.5));
  }
  field([models.get('pebble0'), models.get('pebble1'), models.get('pebble2')], pebbles, rockMat, 110, { shadow: false });
  field([models.get('stone0'), models.get('stone1'), models.get('stone2')], stones, rockMat, 260);

  // dry shrubs on the sand, not on steep slopes
  const bushMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
  const bushes = [];
  for (let k = 0, n = Math.round(260 * D); k < n; k++) {
    const p = beside(7 + 170 * Math.pow(rand(), 1.4));
    if (!p) continue;
    const slope = Math.abs(groundQuery(p.x + 1.5, p.z) - groundQuery(p.x - 1.5, p.z)) + Math.abs(groundQuery(p.x, p.z + 1.5) - groundQuery(p.x, p.z - 1.5));
    if (slope > 1.2) continue;
    const s = 0.7 + rand() * 0.8;
    bushes.push(item(k % 2, p.x, p.z, s, 0.1, 0.2, s * (0.8 + rand() * 0.4)));
  }
  field([models.get('bush0'), models.get('bush1')], bushes, bushMat, 320);

  // the remains of animals that didn't make it across
  const boneMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 });
  const carc = [], bones = [];
  for (let k = 0; k < 7; k++) { const p = beside(14 + rand() * 70); if (p) carc.push(item(0, p.x, p.z, 1.2 + rand() * 0.8, 0.12, 0.15)); }
  for (let k = 0; k < 16; k++) { const p = beside(6 + rand() * 60); if (p) bones.push(item(0, p.x, p.z, 0.9 + rand() * 0.5, 0.02, 0.1)); }
  field([models.get('carcass')], carc, boneMat, 260);
  field([models.get('bones')], bones, boneMat, 160, { shadow: false });

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
  field([models.get('scrap_panel')], panels, metalMat, 240);
  field([models.get('scrap_pipe')], pipes, metalMat, 180, { shadow: false });
  field([models.get('scrap_engine')], engines, metalMat, 320);
  return out;
}
