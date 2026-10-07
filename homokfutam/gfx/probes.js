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

// --- live reflections for the player's pod (?gfx=refl:1, docs/visual-next-steps.md C4) ----------------
// The probes are baked once and hold no pods: here a cube camera at the player's pod renders one face at a
// time of what is round it (ground, rock, buildings, sky and the other pods; no particles or effects:
// see-through things stay out), and once all six are new the cube is prefiltered (PMREM) into an environment
// the size of the probes', so it drops into the pod materials in their place (setPodEnv). The cube is at
// most 6 * every frames stale. size: per face (the probes' size); every: frames per face (each face costs a
// render pass of its own, ~50-140 draws: on WebGPU ~1.5 ms of CPU); far: what is further is left to the sky.
const LAYER_REFL = 9;
export function createLiveEnv(renderer, scene, { size = 256, far = 3000, every = 1 } = {}) {
  const cubeRT = new (GPU ? W.CubeRenderTarget : THREE.WebGLCubeRenderTarget)(size, { type: THREE.HalfFloatType, generateMipmaps: false });
  const cc = new THREE.CubeCamera(0.5, far, cubeRT);
  for (const c of cc.children) c.layers.set(LAYER_REFL);
  const pmrem = new (GPU ? W.PMREMGenerator : THREE.PMREMGenerator)(renderer);
  const tagged = new WeakSet();
  let out = null, face = 0, tick = 0, lights = [];
  const tag = (root) => {
    if (tagged.has(root)) return;
    tagged.add(root);
    root.traverse((o) => {
      const m = o.material, see = m && !Array.isArray(m) && m.transparent;
      if (o.isLight || ((o.isMesh || o.isInstancedMesh) && !o.isPoints && (!see || o.userData.inProbe))) o.layers.enable(LAYER_REFL);
    });
  };
  const drawFace = (pos, hide, f) => {
    if (cc.coordinateSystem !== renderer.coordinateSystem) { cc.coordinateSystem = renderer.coordinateSystem; cc.updateCoordinateSystem(); }
    cc.position.copy(pos);
    cc.updateMatrixWorld(true);
    const prevRt = renderer.getRenderTarget(), prevFace = renderer.getActiveCubeFace?.() ?? 0, prevMip = renderer.getActiveMipmapLevel?.() ?? 0;
    const prevAuto = renderer.shadowMap.autoUpdate, wasVisible = hide?.visible;
    // the shadow maps follow the main camera and stay as they are; the pod does not see itself
    renderer.shadowMap.autoUpdate = false;
    for (const l of lights) l.shadow.autoUpdate = false;
    if (hide) hide.visible = false;
    renderer.setRenderTarget(cubeRT, f);
    renderer.render(scene, cc.children[f]);
    renderer.setRenderTarget(prevRt, prevFace, prevMip);
    if (hide) hide.visible = wasVisible;
    for (const l of lights) l.shadow.autoUpdate = true;
    renderer.shadowMap.autoUpdate = prevAuto;
  };
  const filter = () => { out = pmrem.fromCubemap(cubeRT.texture, out); };
  return {
    get texture() { return out?.texture ?? null; },
    // the static scene and the lights (call once the world is built); pods are tagged as they come
    collect() {
      tag(scene);
      lights = [];
      scene.traverse((o) => { if (o.isLight && o.castShadow) lights.push(o); });
    },
    // all six faces at once (at load: builds the pipelines and the first environment)
    warm(pos, hide) { for (let f = 0; f < 6; f++) drawFace(pos, hide, f); filter(); },
    // per frame: pos = the pod's centre, hide = the pod itself, pods = the other pods' roots
    update(pos, hide, pods) {
      for (const p of pods) if (p) tag(p);
      if (++tick % every) return;
      drawFace(pos, hide, face);
      face = (face + 1) % 6;
      if (face === 0) filter();
    },
  };
}
