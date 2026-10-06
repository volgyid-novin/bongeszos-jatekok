import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { atmoUniforms } from './gfx/atmosphere.js';

// Detailed pod, used by every racer in its own livery. The model is generated in Blender by models/pod/*.py:
// build_pod.py builds it, bake_export.py bakes the textures and writes the two assets below.
const POD_URL = new URL('./assets/pod_player.glb', import.meta.url).href;
const LIVERY_URL = new URL('./assets/pod_livery.png', import.meta.url).href;

const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));

// The baked base colour is the pod with neutral paint; the livery map says where the primary
// (R) and accent (G) paint is still intact, and the shader tints it there. Its B channel is the
// heat mask: as the engines heat up the metal glows, starting in the nozzles and creeping forward.
function patchLivery(m, map, paint, trim, heat) {
  if (m.userData.livery) return;
  m.userData.livery = true;
  m.onBeforeCompile = (sh) => {
    atmoUniforms(sh);
    Object.assign(sh.uniforms, { liveryMap: { value: map }, liveryPaint: { value: paint }, liveryTrim: { value: trim }, liveryHeat: heat });
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D liveryMap;\nuniform vec3 liveryPaint;\nuniform vec3 liveryTrim;\nuniform vec2 liveryHeat;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        vec3 livery = texture2D(liveryMap, vMapUv).rgb;
        diffuseColor.rgb *= mix(vec3(1.0), liveryPaint, livery.r) * mix(vec3(1.0), liveryTrim, livery.g);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          // liveryHeat.x = heat level 0..1, .y = backfire flash
          float lv = liveryHeat.x;
          float edge = 1.0 - lv * 0.9;
          float g = smoothstep( edge, edge + 0.5, livery.b ) * lv * livery.b;
          vec3 hc = mix( vec3( 0.45, 0.02, 0.0 ), vec3( 1.0, 0.24, 0.03 ), smoothstep( 0.4, 1.0, g ) );
          // soot and scale glow less than bare metal: break the glow up with the baked surface
          float vary = clamp( dot( diffuseColor.rgb, vec3( 0.33 ) ) * 5.0, 0.3, 1.3 ) * ( 1.25 - roughnessFactor * 0.6 );
          totalEmissiveRadiance += hc * ( g * g * 0.5 * vary + livery.b * liveryHeat.y * 1.0 );
        }`);
  };
  m.customProgramCacheKey = () => 'pod-livery';
}

// Loads the model once and returns a factory: every call builds another pod that shares the
// geometry and textures but has its own materials (livery colours, heat glow, emitter glow).
export async function loadPodModel(renderer) {
  const [gltf, livery] = await Promise.all([
    new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(POD_URL),
    new THREE.TextureLoader().loadAsync(LIVERY_URL),
  ]);
  livery.flipY = false;   // glTF UV convention
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const src = gltf.scene.getObjectByName('Pod');
  src.traverse((o) => {
    if (!o.isMesh) return;
    const m = o.material;
    m.envMapIntensity = 1.0;     // the scene environment (sky + sand, gfx/atmosphere.js)
    for (const t of [m.map, m.normalMap, m.roughnessMap]) if (t) t.anisotropy = aniso;
  });
  return () => makePod(src, livery);
}

function makePod(src, livery) {
  const root = src.clone(true);
  const paint = new THREE.Color(), trim = new THREE.Color(), heat = { value: new THREE.Vector2() };
  const parts = [], mats = new Map();
  let glow = null, beamMat = null;
  root.traverse((o) => {
    if (o.userData.anim) parts.push(o);
    if (!o.isMesh) return;
    let m = mats.get(o.material);
    if (!m) {
      m = o.material.clone();
      if (m.name.startsWith('PodAtlas')) patchLivery(m, livery, paint, trim, heat);
      mats.set(o.material, m);
    }
    o.material = m;
    o.castShadow = m.name !== 'PodGlass' && !m.name.startsWith('PodBeam');
    o.receiveShadow = true;
    if (m.name.startsWith('PodGlow')) glow = m;
    if (m.name.startsWith('PodBeam')) beamMat = m;
  });
  const node = (n) => root.getObjectByName(n);
  const engines = [node('Engine_L'), node('Engine_R')];
  // energy beam endpoints in body space (the engines have no rotation in the model)
  const beam = ['BeamAnchor_L', 'BeamAnchor_R'].map((n, k) => node(n).position.clone().add(engines[k].position));
  const flames = ['FlameAnchor_L', 'FlameAnchor_R'].map((n) => node(n).position.clone());
  return {
    root, body: node('Body'), engines, beam, flames, parts, glow, beamMat, paint, trim, heat,
    smooth: { brake: 0, steer: 0, boost: 0, thr: 0 }, lift: 0,
  };
}

// Ground clearance. The physics keeps the pod's centre HOVER above the ground, but racerFx banks
// the body up to ~0.55 rad, which pushes the inside engine into the sand (and off the track the
// sand rises under the engines). The lowest parts of the model are tested against the ground under
// each of them, and the body is lifted just enough to clear it. Visual only, physics is unchanged.
// Body-space (three.js) sizes from models/pod/build_pod.py: engine shells as circles across the
// engine axis (radius incl. bands and a flared nozzle), then the stabiliser tips, wing end plates
// and belly skids as points.
const ENGINE_R = 0.86, ENGINE_DZ = [3.4, 0, -3.4];
const LOW_POINTS = [
  [3.08, 0.0, 3.0], [-3.08, 0.0, 3.0], [1.7, -0.1, -3.3], [-1.7, -0.1, -3.3],
  [0.42, -0.6, -1.0], [-0.42, -0.6, -1.0], [0.42, -0.6, -3.5], [-0.42, -0.6, -3.5],
];
const CLEAR = 0.2;

export function podLift(pod, r, groundAt, dt) {
  // body rotation in racerFx is Euler(pitch, 0, -roll), order XYZ: rotate by z first, then x
  const cr = Math.cos(-r.roll), sr = Math.sin(-r.roll), cp = Math.cos(r.pitch), sp = Math.sin(r.pitch);
  const fx = Math.sin(r.yaw), fz = Math.cos(r.yaw);
  let need = 0;
  const test = (x, y, z, rad) => {
    const x1 = x * cr - y * sr, y1 = x * sr + y * cr;
    const y2 = y1 * cp - z * sp, z2 = y1 * sp + z * cp;
    const g = groundAt(r.x + x1 * fz + z2 * fx, r.z - x1 * fx + z2 * fz);
    need = Math.max(need, g + CLEAR - (r.y + y2 - rad));
  };
  for (const e of pod.engines) for (const dz of ENGINE_DZ) test(e.position.x, e.position.y, e.position.z + dz, ENGINE_R);
  for (const p of LOW_POINTS) test(p[0], p[1], p[2], 0);
  // rise fast so nothing cuts in, settle back slowly so it does not bob
  pod.lift += (need - pod.lift) * (1 - Math.exp(-(need > pod.lift ? 30 : 4) * dt));
  return pod.lift;
}

export function setPodLivery(pod, color, accent) {
  pod.paint.set(color);
  pod.trim.set(accent);
}

// Moving parts. Each pivot carries its settings as glTF extras: anim, axis, sign, max (rad or scale).
// fx (optional): { hot: engine heat glow 0..1, flash: backfire flash, beam: beam brightness, beamCol }
export function animatePlayerPod(pod, r, dt, fx) {
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
  if (fx) {
    pod.heat.value.set(fx.hot, fx.flash);
    if (pod.beamMat) {
      pod.beamMat.emissive.copy(fx.beamCol);
      pod.beamMat.emissiveIntensity = 0.25 + fx.beam * 3.5;
    }
  }
  if (pod.glow) {
    pod.glow.emissiveIntensity = r.overheat > 0
      ? 0.25 + Math.random() * 0.5
      : 0.35 + 1.1 * s.thr + 1.8 * s.boost + (r.heat / 100) * 0.6;
  }
}
