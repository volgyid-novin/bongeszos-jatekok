import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

// Detailed pod for the local player. The model is generated in Blender by models/pod/*.py:
// build_pod.py builds it, bake_export.py bakes the textures and writes the two assets below.
const POD_URL = new URL('./assets/pod_player.glb', import.meta.url).href;
const LIVERY_URL = new URL('./assets/pod_livery.png', import.meta.url).href;

const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));

// Desert sky + sand for the metal reflections. Only the pod uses it, the rest of the scene keeps
// its hemisphere light.
function desertEnv(renderer) {
  const s = new THREE.Scene();
  s.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: {
      zen: { value: new THREE.Color('#3f7fc8') },
      hor: { value: new THREE.Color('#e6d2b2') },
      gnd: { value: new THREE.Color('#9c7650') },
    },
    vertexShader: 'varying vec3 d; void main(){ d = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform vec3 zen, hor, gnd; varying vec3 d;
      void main(){
        vec3 c = d.y > 0.0 ? mix(hor, zen, pow(smoothstep(0.0, 0.6, d.y), 0.8)) : mix(hor, gnd, smoothstep(0.0, 0.2, -d.y));
        gl_FragColor = vec4(c, 1.0);
      }`,
  })));
  const pm = new THREE.PMREMGenerator(renderer);
  const tex = pm.fromScene(s, 0).texture;
  pm.dispose();
  return tex;
}

// The baked base colour is the pod with neutral paint; the livery map says where the primary
// (R) and accent (G) paint is still intact, and the shader tints it there.
function patchLivery(m, map, paint, trim) {
  if (m.userData.livery) return;
  m.userData.livery = true;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, { liveryMap: { value: map }, liveryPaint: { value: paint }, liveryTrim: { value: trim } });
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D liveryMap;\nuniform vec3 liveryPaint;\nuniform vec3 liveryTrim;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        vec2 livery = texture2D(liveryMap, vMapUv).rg;
        diffuseColor.rgb *= mix(vec3(1.0), liveryPaint, livery.r) * mix(vec3(1.0), liveryTrim, livery.g);`);
  };
  m.customProgramCacheKey = () => 'pod-livery';
}

export async function loadPlayerPod(renderer) {
  const [gltf, livery] = await Promise.all([
    new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(POD_URL),
    new THREE.TextureLoader().loadAsync(LIVERY_URL),
  ]);
  livery.flipY = false;   // glTF UV convention
  const env = desertEnv(renderer);
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const paint = new THREE.Color(), trim = new THREE.Color();
  const root = gltf.scene.getObjectByName('Pod');
  const parts = [];
  let glow = null;
  root.traverse((o) => {
    if (o.userData.anim) parts.push(o);
    if (!o.isMesh) return;
    const m = o.material;
    o.castShadow = m.name !== 'PodGlass';
    m.envMap = env;
    m.envMapIntensity = 0.6;
    for (const t of [m.map, m.normalMap, m.roughnessMap]) if (t) t.anisotropy = aniso;
    if (m.name.startsWith('PodAtlas')) patchLivery(m, livery, paint, trim);
    if (m.name.startsWith('PodGlow')) glow = m;
  });
  const node = (n) => root.getObjectByName(n);
  const engines = [node('Engine_L'), node('Engine_R')];
  // energy beam endpoints in body space (the engines have no rotation in the model)
  const beam = ['BeamAnchor_L', 'BeamAnchor_R'].map((n, k) => node(n).position.clone().add(engines[k].position));
  const flames = ['FlameAnchor_L', 'FlameAnchor_R'].map((n) => node(n).position.clone());
  return {
    root, body: node('Body'), engines, beam, flames, parts, glow, paint, trim,
    smooth: { brake: 0, steer: 0, boost: 0, thr: 0 },
  };
}

export function setPodLivery(pod, color, accent) {
  pod.paint.set(color);
  pod.trim.set(accent);
}

// Moving parts. Each pivot carries its settings as glTF extras: anim, axis, sign, max (rad or scale).
export function animatePlayerPod(pod, r, dt) {
  const s = pod.smooth;
  s.brake = damp(s.brake, r.brake > 0 && r.fwd > 2 ? r.brake : 0, 7, dt);
  s.steer = damp(s.steer, r.steer, 8, dt);
  s.boost = damp(s.boost, r.boosting ? 1 : 0, 5, dt);
  s.thr = damp(s.thr, r.overheat > 0 ? 0 : r.throttle, 3, dt);
  for (const p of pod.parts) {
    const a = p.userData;
    switch (a.anim) {
      case 'fan': p.rotation.z = (p.rotation.z + a.sign * dt * (4 + 30 * s.thr + 24 * s.boost)) % (Math.PI * 2); break;
      case 'brake': p.rotation.z = a.sign * a.max * s.brake; break;
      case 'flap': p.rotation.x = a.sign * a.max * s.steer; break;
      case 'flare': p.scale.x = p.scale.y = 1 + a.max * s.boost; break;
      case 'lean': p.rotation.z = -a.sign * a.max * s.steer; break;
    }
  }
  if (pod.glow) {
    pod.glow.emissiveIntensity = r.overheat > 0
      ? 0.25 + Math.random() * 0.5
      : 0.35 + 1.1 * s.thr + 1.8 * s.boost + (r.heat / 100) * 0.6;
  }
}
