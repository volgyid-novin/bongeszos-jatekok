import * as THREE from 'three/webgpu';
import {
  Fn, If, vec3, uniform, uv, texture, materialColor, materialEmissive, diffuseColor, roughness, pmremTexture,
  mix, clamp, dot, smoothstep, max, float, vec4, positionView, cameraWorldMatrix, reflectVector, materialRoughness, materialMetalness,
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
export function toNodeMaterial(m, C = NODE_CLASS[m.type]) {
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
// coat: the roughness of a clear coat over the paint that is still intact, or 0 (?gfx=coat:1, playerPod.js)
// gloss: how polished, 0..1, with G = { paint, metal, min } (playerPod.js, GLOSS)
export function podLiveryMaterial(m, liveryMap, paint, trim, heat, coat = 0, gloss = null, G = null) {
  const n = toNodeMaterial(m, coat ? THREE.MeshPhysicalNodeMaterial : NODE_CLASS[m.type]);
  n.userData.liveryMap = liveryMap;
  // the livery shares the base map's uvs, including its transform (gltfpack dequantizes uvs through it)
  let luv = uv(m.map?.channel ?? 0);
  if (m.map) { m.map.updateMatrix(); luv = uniform(m.map.matrix).mul(vec3(luv, 1)).xy; }
  const liv = texture(liveryMap, luv).rgb;
  n.colorNode = materialColor.mul(mix(vec3(1), uniform(paint), liv.r)).mul(mix(vec3(1), uniform(trim), liv.g));
  if (gloss && G) {
    // intact paint towards an enamel gloss, bare metal polished; the rest as modelled
    const k = mix(mix(float(1), G.metal, smoothstep(0.4, 0.8, materialMetalness)), G.paint, smoothstep(0.35, 0.8, max(liv.r, liv.g)));
    n.roughnessNode = max(materialRoughness.mul(mix(float(1), k, gloss)), G.min);
  }
  if (coat) {
    // (polished pods, gloss: the coat also over paint that is partly worn)
    n.clearcoatNode = gloss ? smoothstep(mix(0.35, 0.2, gloss), mix(0.8, 0.55, gloss), max(liv.r, liv.g)) : smoothstep(0.35, 0.8, max(liv.r, liv.g));
    n.clearcoatRoughnessNode = float(coat);
  }
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

// Ray-traced reflections (?gfx=rtr:1, docs/visual-next-steps.md D9; gfx/tsl/rt.js createReflections). The lighting
// model's indirect specular takes the traced radiance instead of the probes' where the surface is smooth (and under
// the clear coat), and keeps the probes where the ray left the world it knows (the ground, the far desert) or the
// surface is rough. on: a uniform per pod (only the player's pod traces). The diffuse light stays the probes'.
const RT_MAX = 150;                 // metres: further, the probe has it
// debug (?gfx=rtr:2): every surface a mirror, the traced light only (magenta where a ray missed)
export function podTracedReflections(material, refl, on, debug = false) {
  const setup = material.setupLightingModel.bind(material);
  material.setupLightingModel = (builder) => {
    const lm = setup(builder);
    const spec = lm.indirectSpecular.bind(lm);
    lm.indirectSpecular = (b) => {
      const ctx = b.context;
      If(on.greaterThan(0.5), () => {
        const w = smoothstep(0.15, 0.5, roughness).oneMinus().toVar();
        const cc = lm.clearcoatRadiance;
        If(w.greaterThan(0.01).or(float(cc ? 1 : 0).greaterThan(0.5)), () => {
          // from view space (positionWorld leaves out the pods' skinning here); the probes' own reflection vector
          const R = reflectVector.toVar();
          const ro = cameraWorldMatrix.mul(vec4(positionView, 1)).xyz.add(R.mul(0.05));
          const h = refl.trace(ro, R, RT_MAX).toVar();
          if (debug === 3) { ctx.radiance.assign(R.mul(0.5).add(0.5).mul(2)); if (cc) cc.assign(ctx.radiance); }
          else if (debug) { ctx.radiance.assign(mix(vec3(1, 0, 1), h.rgb, h.a)); if (cc) cc.assign(ctx.radiance); }
          else {
            ctx.radiance.assign(mix(ctx.radiance, h.rgb, h.a.mul(w)));
            if (cc) cc.assign(mix(cc, h.rgb, h.a));
          }
        });
      });
      spec(b);
    };
    return lm;
  };
  material.needsUpdate = true;
}
