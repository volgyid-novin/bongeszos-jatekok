import * as THREE from 'three/webgpu';
import {
  Fn, vec3, uniform, uv, texture, materialColor, materialEmissive, diffuseColor, roughness, pmremTexture,
  mix, clamp, dot, smoothstep,
} from 'three/tsl';

// ============================================================
//  The detailed pods on WebGPURenderer (GLSL version and notes: playerPod.js): the glTF materials
//  become node materials; livery paint, the engines' heat glow and the two-probe environment blend
//  are nodes instead of shader patches.
// ============================================================

const NODE_CLASS = {
  MeshStandardMaterial: THREE.MeshStandardNodeMaterial, MeshPhysicalMaterial: THREE.MeshPhysicalNodeMaterial,
  MeshBasicMaterial: THREE.MeshBasicNodeMaterial, MeshLambertMaterial: THREE.MeshLambertNodeMaterial, MeshPhongMaterial: THREE.MeshPhongNodeMaterial,
};
const SKIP = new Set(['id', 'uuid', 'type', 'version', '_listeners', 'onBeforeCompile', 'customProgramCacheKey', 'onBeforeRender', 'onBuild']);
// a node material with the classic material's settings (maps, colours, flags), or the material itself
export function toNodeMaterial(m) {
  const C = NODE_CLASS[m.type];
  if (!C) return m;
  const n = new C();
  for (const k in m) {
    if (SKIP.has(k) || k.startsWith('is') || typeof m[k] === 'function') continue;
    n[k] = m[k];
  }
  n.userData = { ...m.userData };
  return n;
}

// the livery map says where the primary (R) and accent (G) paint is still intact; B is the heat mask:
// as the engines heat up the metal glows, from the nozzles creeping forward (heat: x level, y backfire flash)
export function podLiveryMaterial(m, liveryMap, paint, trim, heat) {
  const n = toNodeMaterial(m);
  n.userData.liveryMap = liveryMap;
  // the livery shares the base map's uvs, including its transform (gltfpack dequantizes uvs through it)
  let luv = uv(m.map?.channel ?? 0);
  if (m.map) { m.map.updateMatrix(); luv = uniform(m.map.matrix).mul(vec3(luv, 1)).xy; }
  const liv = texture(liveryMap, luv).rgb;
  n.colorNode = materialColor.mul(mix(vec3(1), uniform(paint), liv.r)).mul(mix(vec3(1), uniform(trim), liv.g));
  n.emissiveNode = Fn(() => {
    const lv = heat.x, edge = lv.mul(-0.9).add(1);
    const g = smoothstep(edge, edge.add(0.5), liv.b).mul(lv).mul(liv.b).toVar();
    const hc = mix(vec3(0.45, 0.02, 0), vec3(1, 0.24, 0.03), smoothstep(0.4, 1, g));
    // soot and scale glow less than bare metal: break the glow up with the baked surface
    const vary = clamp(dot(diffuseColor.rgb, vec3(0.33)).mul(5), 0.3, 1.3).mul(roughness.mul(-0.6).add(1.25));
    return materialEmissive.add(hc.mul(g.mul(g).mul(0.5).mul(vary).add(liv.b.mul(heat.y))));
  })();
  return n;
}

// image-based light from probe a, with probe b faded in by k (PMREM textures of the same size)
export function podEnvNodes(a, b) {
  const A = pmremTexture(a), B = pmremTexture(b || a), k = uniform(0);
  return { A, B, k, node: mix(A, B, k) };
}
