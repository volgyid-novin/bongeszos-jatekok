import * as THREE from 'three';
import { GPU, W } from './backend.js';

// ============================================================
//  Light probes: the real scene rendered into a few prefiltered cube maps at load, from where the pods
//  fly (open desert, arena, canyon, under the arch). The pods light and reflect themselves with the
//  probe of the place they are in instead of the sky-only environment: red rock bouncing in the
//  canyon, the stands in the arena, the shade of the arch.
//
//  Each pod material blends two probes (base + a second one with a weight, see podEnvPatch), so a pod
//  fades from one to the next as the track moves from one zone into another.
// ============================================================

// points: { name: Vector3 }; prepare(pos): move the camera-following parts of the world (sky dome,
// horizon ring) to the probe before it is rendered. Everything that moves or is see-through is left
// out, except objects flagged userData.inProbe (the horizon ring).
export function bakeProbes(renderer, scene, points, prepare) {
  const hidden = [];
  scene.traverse((o) => {
    if (!o.visible) return;
    const m = o.material, see = m && !Array.isArray(m) && m.transparent;
    if (o.userData.dynamic || o.isPoints || o.isSprite || o.isLine || (see && !o.userData.inProbe)) { o.visible = false; hidden.push(o); }
  });
  // the near shadow map is not redrawn for every face (it follows the main camera anyway); but at load
  // no frame has drawn it yet, and sampling the missing map makes WebGL drop the draws: let the first
  // probe render create it
  const autoShadow = renderer.shadowMap.autoUpdate;
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;
  const pmrem = new (GPU ? W.PMREMGenerator : THREE.PMREMGenerator)(renderer);
  const out = {};
  for (const [name, pos] of Object.entries(points)) {
    prepare?.(pos);
    out[name] = pmrem.fromScene(scene, 0, 0.5, 9000, { position: pos }).texture;
  }
  pmrem.dispose();
  renderer.shadowMap.autoUpdate = autoShadow;
  for (const o of hidden) o.visible = true;
  return out;
}

// Shader patch for a MeshStandardMaterial: image-based light from envMap blended with envMapB by
// envMapMix (uniforms: { envMapB, envMapMix }). Both maps must come from the same PMREM size.
export function podEnvPatch(shader, uniforms) {
  Object.assign(shader.uniforms, uniforms);
  const chunk = THREE.ShaderChunk.envmap_physical_pars_fragment.replaceAll('textureCubeUV( envMap, ', 'hfEnvPair( ');
  shader.fragmentShader = shader.fragmentShader.replace('#include <envmap_physical_pars_fragment>', /* glsl */`
    #ifdef USE_ENVMAP
      uniform sampler2D envMapB;
      uniform float envMapMix;
      vec4 hfEnvPair( vec3 dir, float rough ) {
        vec4 a = textureCubeUV( envMap, dir, rough );
        return envMapMix > 0.001 ? mix( a, textureCubeUV( envMapB, dir, rough ), envMapMix ) : a;
      }
    #endif
    ${chunk}`);
}
