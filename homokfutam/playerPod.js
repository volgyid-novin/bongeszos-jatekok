import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { atmoUniforms } from './gfx/atmosphere.js';
import { podEnvPatch } from './gfx/probes.js';
import { GPU, U, maxAnisotropy, N } from './gfx/backend.js';
import { pickQuality } from './gfx/quality.js';

// ?gfx=coat:1 (docs/visual-next-steps.md C7): a clear coat over the paint that is still intact (the livery's
// R and G masks), so the painted panels get a sharp second highlight over the worn, rougher base
const COAT = !!pickQuality().coat;
const COAT_ROUGH = 0.07;

// Detailed pod, used by every racer in its own livery. The model is generated in Blender by models/pod/*.py:
// build_pod.py builds it, bake_export.py bakes the textures and writes the two assets below.
const POD_URL = new URL('./assets/pod_player.glb', import.meta.url).href;
const LIVERY_URL = new URL('./assets/pod_livery.png', import.meta.url).href;

const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));

// The baked base colour is the pod with neutral paint; the livery map says where the primary
// (R) and accent (G) paint is still intact, and the shader tints it there. Its B channel is the
// heat mask: as the engines heat up the metal glows, starting in the nozzles and creeping forward.
// Polish (setPodGloss, gloss 0..1): intact paint (the livery's masks) towards an enamel gloss, bare metal
// (the metalness map) polished; rubber, leather, soot and the worn scratches keep the model's roughness.
export const GLOSS = { paint: 0.2, metal: 0.45, min: 0.06 };
function patchLivery(m, map, paint, trim, heat, gloss) {
  if (m.userData.livery) return;
  m.userData.livery = true;
  const coat = m.isMeshPhysicalMaterial && m.clearcoat > 0;
  m.onBeforeCompile = (sh) => {
    atmoUniforms(sh);
    Object.assign(sh.uniforms, { liveryMap: { value: map }, liveryPaint: { value: paint }, liveryTrim: { value: trim }, liveryHeat: heat, liveryGloss: gloss });
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D liveryMap;\nuniform vec3 liveryPaint;\nuniform vec3 liveryTrim;\nuniform vec2 liveryHeat;\nuniform float liveryGloss;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        vec3 livery = texture2D(liveryMap, vMapUv).rgb;
        diffuseColor.rgb *= mix(vec3(1.0), liveryPaint, livery.r) * mix(vec3(1.0), liveryTrim, livery.g);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        {
          float paintK = smoothstep( 0.35, 0.8, max( livery.r, livery.g ) );
          float k = mix( mix( 1.0, ${GLOSS.metal.toFixed(2)}, smoothstep( 0.4, 0.8, metalnessFactor ) ), ${GLOSS.paint.toFixed(2)}, paintK );
          roughnessFactor = max( roughnessFactor * mix( 1.0, k, liveryGloss ), ${GLOSS.min.toFixed(2)} );
        }`)
      .replace('#include <lights_physical_fragment>', coat ? `#include <lights_physical_fragment>
        // (polished pods: the coat also over paint that is partly worn)
        material.clearcoat *= smoothstep( mix( 0.35, 0.2, liveryGloss ), mix( 0.8, 0.55, liveryGloss ), max( livery.r, livery.g ) );` : '#include <lights_physical_fragment>')
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
  m.customProgramCacheKey = () => (coat ? 'pod-livery-coat' : 'pod-livery');
}

// ============================================================
//  Hull: what a pod collides with (docs/visual-next-steps.md F1)
// ============================================================
// A few capsules in body space (three.js: +z forward, +x left, +y up), per pod model. The model carries them as nodes
// with extras { col: 'capsule', r, half }: the capsule runs along the node's local z, half metres each way from the
// node, radius r (models/pod/build_pod.py makes them, COL_*). A capsule under a breakable part (extras brk) goes
// with that part. A model without them gets capsules fitted to its engines' and body's bounds (fitHull).
// k2: the squared radius of gyration about the origin (the point the physics turns the pod about), from the capsules'
// areas; reach: how far any of it is from the origin.
export function makeHull(caps, { mass = 1, source = 'fitted' } = {}) {
  let A = 0, I = 0, reach = 0;
  for (const c of caps) {
    const len = Math.hypot(c.bx - c.ax, c.bz - c.az), area = 2 * c.r * len + Math.PI * c.r * c.r;
    const mx = (c.ax + c.bx) / 2, mz = (c.az + c.bz) / 2;
    A += area; I += area * (mx * mx + mz * mz + len * len / 12 + c.r * c.r / 2);
    reach = Math.max(reach, Math.hypot(c.ax, c.az) + c.r, Math.hypot(c.bx, c.bz) + c.r);
  }
  return { caps, mass, k2: I / Math.max(A, 1e-6), reach, source };
}
const cap = (ax, ay, az, bx, by, bz, r, bit = 0) => ({ ax, ay, az, bx, by, bz, r, bit });
// pod_player measured (build_pod.py): the engines nose to nozzle, the cockpit tub, the outboard stabilisers, the stub
// wings. Used until the model is in, and by the simple pod.
export const DEFAULT_HULL = makeHull([
  cap(1.75, 0.15, 2.7, 1.75, 0.15, 8.85, 0.86), cap(-1.75, 0.15, 2.7, -1.75, 0.15, 8.85, 0.86),
  cap(0, 0.35, -3.6, 0, 0.35, -0.4, 1.05),
  cap(2.78, 0.15, 2.95, 2.78, 0.15, 3.85, 0.3), cap(-2.78, 0.15, 2.95, -2.78, 0.15, 3.85, 0.3),
  cap(0.95, 0.25, -3.0, 1.35, 0.25, -3.25, 0.4), cap(-0.95, 0.25, -3.0, -1.35, 0.25, -3.25, 0.4),
], { source: 'default' });

// the hull from the model's COL_ nodes (rest pose), or fitted to its parts; parts: the breakable parts' nodes (bit k)
function readHull(src, parts) {
  src.updateMatrixWorld(true);
  const toSrc = new THREE.Matrix4().copy(src.matrixWorld).invert(), m = new THREE.Matrix4();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), caps = [];
  src.traverse((o) => {
    const u = o.userData;
    if (u.col !== 'capsule') return;
    m.multiplyMatrices(toSrc, o.matrixWorld);
    a.set(0, 0, -u.half).applyMatrix4(m); b.set(0, 0, u.half).applyMatrix4(m);
    let bit = 0;
    for (let p = o; p && p !== src; p = p.parent) { const k = parts.indexOf(p); if (k >= 0) { bit = 1 << k; break; } }
    caps.push(cap(a.x, a.y, a.z, b.x, b.y, b.z, u.r, bit));
  });
  if (caps.length) return makeHull(caps, { mass: src.userData.mass ?? 1, source: 'model' });
  // fitted: a capsule along z through each engine's bounds and the body's (its widest part is the radius)
  const box = new THREE.Box3(), fit = [];
  for (const name of ['Engine_L', 'Engine_R', 'Body_static']) {
    const n = src.getObjectByName(name);
    if (!n) continue;
    box.makeEmpty();
    n.traverse((o) => { if (o.isMesh) { o.geometry.computeBoundingBox(); box.union(o.geometry.boundingBox.clone().applyMatrix4(m.multiplyMatrices(toSrc, o.matrixWorld))); } });
    if (box.isEmpty()) continue;
    const r = (box.max.x - box.min.x) / 2, x = (box.max.x + box.min.x) / 2, y = (box.max.y + box.min.y) / 2;
    fit.push(cap(x, y, Math.min(box.min.z + r, (box.min.z + box.max.z) / 2), x, y, Math.max(box.max.z - r, (box.min.z + box.max.z) / 2), r));
  }
  return fit.length ? makeHull(fit) : DEFAULT_HULL;
}

// Loads the model once and returns a factory: every call builds another pod that shares the
// geometry and textures but has its own materials (livery colours, heat glow, emitter glow).
// The factory carries the model's hull (make.hull).
export async function loadPodModel(renderer) {
  const [gltf, livery] = await Promise.all([
    new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(POD_URL),
    loadLivery(),
  ]);
  const aniso = Math.min(8, maxAnisotropy(renderer));
  const src = gltf.scene.getObjectByName('Pod');
  src.traverse((o) => {
    if (!o.isMesh) return;
    const m = o.material;
    m.envMapIntensity = 1.0;     // the scene environment (sky + sand, gfx/atmosphere.js)
    for (const t of [m.map, m.normalMap, m.roughnessMap]) if (t) t.anisotropy = aniso;
  });
  const parts = [];
  src.traverse((o) => { if (o.userData.brk) parts.push(o); });
  const hull = readHull(src, parts);
  // the breakable parts (bit k = parts[k]): where each sits in the pod (its meshes' centre, rest pose), and how big
  src.updateMatrixWorld(true);
  const toSrc = new THREE.Matrix4().copy(src.matrixWorld).invert(), box = new THREE.Box3(), mm = new THREE.Matrix4();
  const brk = parts.map((p) => {
    box.makeEmpty();
    p.traverse((o) => { if (o.isMesh) { o.geometry.computeBoundingBox(); box.union(o.geometry.boundingBox.clone().applyMatrix4(mm.multiplyMatrices(toSrc, o.matrixWorld))); } });
    const c = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
    return { name: p.name, x: c.x, y: c.y, z: c.z, size: box.isEmpty() ? 0.3 : box.getSize(new THREE.Vector3()).length() };
  });
  mergeParts(src);
  const make = () => makePod(src, livery, brk);
  make.hull = hull;
  make.brk = brk;
  return make;
}

// The livery's channels are masks, and its alpha is not coverage: load it unpremultiplied (WebGPU
// uploads an <img> premultiplied, which would wipe out the masks where alpha is 0).
function loadLivery() {
  return new THREE.ImageBitmapLoader().setOptions({ premultiplyAlpha: 'none', colorSpaceConversion: 'none', imageOrientation: 'none' }).loadAsync(LIVERY_URL)
    .then((bmp) => {
      const t = new THREE.Texture(bmp);
      t.flipY = false;   // glTF UV convention
      t.needsUpdate = true;
      return t;
    });
}

// the same material as a MeshPhysicalMaterial with a clear coat (masked to the paint in patchLivery)
function withCoat(m) {
  const p = new THREE.MeshPhysicalMaterial();
  THREE.MeshStandardMaterial.prototype.copy.call(p, m);
  p.defines = { STANDARD: '', PHYSICAL: '' };
  p.clearcoat = 1;
  p.clearcoatRoughness = COAT_ROUGH;
  return p;
}

// float copy of a (possibly quantized, gltfpack) attribute
function floatAttr(a) {
  const n = a.count, k = a.itemSize, out = new Float32Array(n * k);
  for (let i = 0; i < n; i++) for (let j = 0; j < k; j++) out[i * k + j] = a.getComponent(i, j);
  return new THREE.BufferAttribute(out, k);
}

// One draw per material instead of one per part (16 textured parts plus glass, glow and beam,
// about 24 draws and 18 shadow draws per pod). The parts of each material go into one skinned
// mesh, every vertex bound with weight 1 to the node that carried it, so the engines and the
// moving parts (fans, flaps, brakes, nozzles, pilot) still move with their nodes as before.
// The cockpit swings on its cables behind the engines (main.js racerFx turns the Cockpit group made in makePod): the
// cables' vertices are bound to the cockpit at its end and to the engine at the other, blended along the cable, so the
// cables bend instead of tearing.
const CABLE_Z = [0.2, 3.1];       // body-space z: all cockpit at the first, all engine at the second
function mergeParts(src) {
  src.updateMatrixWorld(true);
  const byMat = new Map();
  src.traverse((o) => {
    if (!o.isMesh) return;
    if (!byMat.has(o.material)) byMat.set(o.material, []);
    byMat.get(o.material).push(o);
  });
  const toSrc = new THREE.Matrix4().copy(src.matrixWorld).invert(), mtx = new THREE.Matrix4();
  const bones = [], merged = [];
  const boneOf = (o) => { let i = bones.indexOf(o); if (i < 0) i = bones.push(o) - 1; return i; };
  const named = (n) => src.getObjectByName(n);
  const cable = named('Body_static') && named('Engine_L_static') && named('Engine_R_static')
    ? { c: boneOf(named('Body_static')), l: boneOf(named('Engine_L_static')), r: boneOf(named('Engine_R_static')) } : null;
  for (const [mat, meshes] of byMat) {
    const names = Object.keys(meshes[0].geometry.attributes).sort().join();
    if (meshes.some((m) => Object.keys(m.geometry.attributes).sort().join() !== names)) continue;   // keep these parts as they are
    const geos = meshes.map((m) => {
      let bi = bones.indexOf(m.parent);
      if (bi < 0) bi = bones.push(m.parent) - 1;
      const g = new THREE.BufferGeometry();
      for (const [name, a] of Object.entries(m.geometry.attributes)) g.setAttribute(name, floatAttr(a));
      const idx = m.geometry.index ? Array.from(m.geometry.index.array) : Array.from({ length: g.attributes.position.count }, (_, i) => i);
      mtx.multiplyMatrices(toSrc, m.matrixWorld);
      if (mtx.determinant() < 0) {          // mirrored part: keep the triangles facing out
        for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
        const tg = g.attributes.tangent;
        if (tg) for (let i = 0; i < tg.count; i++) tg.setW(i, -tg.getW(i));
      }
      g.setIndex(idx);
      g.applyMatrix4(mtx);
      const n = g.attributes.position.count, si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
      if (cable && m.parent.name === 'Body_cables') {
        const P = g.attributes.position;
        for (let i = 0; i < n; i++) {
          const u = Math.min(1, Math.max(0, (P.getZ(i) - CABLE_Z[0]) / (CABLE_Z[1] - CABLE_Z[0]))), w = u * u * (3 - 2 * u);
          si[i * 4] = cable.c; sw[i * 4] = 1 - w;
          si[i * 4 + 1] = P.getX(i) > 0 ? cable.l : cable.r; sw[i * 4 + 1] = w;
        }
      } else for (let i = 0; i < n; i++) { si[i * 4] = bi; sw[i * 4] = 1; }
      g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
      g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
      return g;
    });
    const geo = mergeGeometries(geos);
    if (geo) merged.push({ mat, meshes, geo });
  }
  const skeleton = new THREE.Skeleton(bones);          // bone inverses from the rest pose
  for (const { mat, meshes, geo } of merged) {
    for (const m of meshes) m.removeFromParent();
    const sm = new THREE.SkinnedMesh(geo, mat);
    sm.name = mat.name;
    src.add(sm);
    sm.updateMatrixWorld(true);
    sm.bind(skeleton, sm.matrixWorld);
    // the rest-pose bounds; the parts only move a little (the cockpit's swing is the most, ~1 m at its tail), so
    // this stays good for culling and spares SkinnedMesh.computeBoundingSphere() (it skins every vertex on the CPU)
    geo.computeBoundingSphere();
    sm.boundingSphere = geo.boundingSphere.clone();
    sm.boundingSphere.radius *= 1.25;
  }
}

// src.clone(true) keeps the source's skeleton: rebind every copy to its own nodes
function cloneRig(src) {
  const copy = src.clone(true), map = new Map();
  const walk = (a, b) => { map.set(a, b); a.children.forEach((c, i) => walk(c, b.children[i])); };
  walk(src, copy);
  const skeletons = new Map();
  copy.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    const s = o.skeleton;
    if (!skeletons.has(s)) skeletons.set(s, new THREE.Skeleton(s.bones.map((b) => map.get(b)), s.boneInverses));
    o.bind(skeletons.get(s), o.bindMatrix);
  });
  return copy;
}

function makePod(src, livery, brkInfo = []) {
  const root = cloneRig(src);
  const paint = new THREE.Color(), trim = new THREE.Color(), heat = U(new THREE.Vector2()), gloss = U(1);
  const parts = [], mats = new Map();
  const env = { envMapB: { value: null }, envMapMix: { value: 0 } };
  let glow = null, beamMat = null;
  root.traverse((o) => {
    if (o.userData.anim) parts.push(o);
    if (!o.isMesh) return;
    let m = mats.get(o.material);
    if (!m && GPU) {
      // node materials (gfx/tsl/pod.js); the probe blend is set up by setPodEnv
      m = o.material.name.startsWith('PodAtlas') ? N.podLiveryMaterial(o.material, livery, paint, trim, heat, COAT ? COAT_ROUGH : 0, gloss, GLOSS) : N.toNodeMaterial(o.material);
      if (m.transparent && m.side === THREE.DoubleSide) m.forceSinglePass = true;
      mats.set(o.material, m);
    }
    if (!m) {
      m = o.material.clone();
      if (m.name.startsWith('PodAtlas')) {
        if (COAT) m = withCoat(m);
        patchLivery(m, livery, paint, trim, heat, gloss);
      }
      // transparent + double-sided is drawn in two passes, each flagging the material for a
      // shader re-check; the canopy is thin enough that one pass looks the same
      if (m.transparent && m.side === THREE.DoubleSide) m.forceSinglePass = true;
      // light and reflections from the probes of the zone the pod is in (gfx/probes.js, setPodEnv)
      const before = m.onBeforeCompile, key = m.customProgramCacheKey;
      m.onBeforeCompile = (sh, r) => { before.call(m, sh, r); podEnvPatch(sh, env); };
      m.customProgramCacheKey = () => key.call(m) + '|pod-env';
      mats.set(o.material, m);
    }
    o.material = m;
    o.castShadow = m.name !== 'PodGlass' && !m.name.startsWith('PodBeam') && !m.name.startsWith('PodGlow');
    o.receiveShadow = true;
    if (m.name.startsWith('PodGlow')) glow = m;
    if (m.name.startsWith('PodBeam')) beamMat = m;
  });
  const node = (n) => root.getObjectByName(n);
  const engines = [node('Engine_L'), node('Engine_R')];
  // the cockpit (hull, canopy, pilot, the wings and the antenna) in one group under the body, so it can swing on its
  // cables: everything on the body but the engines and the cables. The group sits at the origin, so the bones keep
  // their rest pose
  const body = node('Body'), cockpit = new THREE.Group();
  cockpit.name = 'Cockpit';
  for (const o of [...body.children]) if (!/^(Engine_[LR]|Body_cables)$/.test(o.name)) cockpit.add(o);
  body.add(cockpit);
  // the breakable parts (F6): the part's node, its stump (hidden until the part goes), the node it hangs from
  const brk = brkInfo.map((b) => {
    const n = node(b.name), stump = b.name.startsWith('BREAK_') ? node(b.name.replace(/^BREAK_/, 'STUMP_')) : null;
    if (stump) stump.scale.setScalar(GONE);
    return { ...b, node: n, stump, home: n?.parent, pos: n?.position.clone(), quat: n?.quaternion.clone() };
  });
  // energy beam endpoints in body space (the engines have no rotation in the model)
  const beam = ['BeamAnchor_L', 'BeamAnchor_R'].map((n, k) => node(n).position.clone().add(engines[k].position));
  const flames = ['FlameAnchor_L', 'FlameAnchor_R'].map((n) => node(n).position.clone());
  return {
    root, body: node('Body'), engines, cockpit, beam, flames, parts, glow, beamMat, paint, trim, heat, gloss, env, mats: [...mats.values()], envBase: null,
    smooth: { brake: 0, steer: 0, boost: 0, thr: 0 }, lift: 0, brk, broken: 0,
  };
}

// Breakable parts (docs/visual-next-steps.md F6). A part is a node of the skinned pod: hiding it is scaling it to
// nothing, and flying it off is taking it out of the pod into the world (the caller attaches it to the scene and
// moves it): the merged meshes follow their bones wherever they are, so the piece keeps the pod's own materials.
const GONE = 1e-4;
// mask: the parts that are off (bit k: brk[k]); the ones that come back are put home
export function setBroken(pod, mask) {
  pod.brk.forEach((b, k) => {
    if (!b.node) return;
    const off = !!(mask & (1 << k));
    if (!off && b.node.parent !== b.home) { b.home.add(b.node); b.flying = false; }
    if (!off) { b.node.position.copy(b.pos); b.node.quaternion.copy(b.quat); }
    b.node.scale.setScalar(off ? GONE : 1);
    if (b.stump) b.stump.scale.setScalar(off ? 1 : GONE);
  });
  pod.broken = mask;
}
// part k comes off: its stump shows, and the part is handed back (still in place) for the caller to fly
export function breakPart(pod, k) {
  const b = pod.brk[k];
  pod.broken |= 1 << k;
  if (b.stump) b.stump.scale.setScalar(1);
  return b.node;
}
// a flown part has landed and faded: home again, and hidden
export function stowPart(pod, k) {
  const b = pod.brk[k];
  b.home.add(b.node);
  b.node.position.copy(b.pos); b.node.quaternion.copy(b.quat); b.node.scale.setScalar(GONE);
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

// Light probes (gfx/probes.js): the pod is lit by base, with b faded in by mix; intensity scales both.
export function setPodEnv(pod, base, b, mix, intensity) {
  if (GPU) {
    // one environment node per pod: probe base with b faded in (gfx/tsl/pod.js)
    if (!pod.envNodes) {
      pod.envNodes = N.podEnvNodes(base, b);
      for (const m of pod.mats) { m.envNode = pod.envNodes.node; m.needsUpdate = true; }
    }
    const E = pod.envNodes;
    if (E.A.value !== base) E.A.value = base;
    if (E.B.value !== (b || base)) E.B.value = b || base;
    E.k.value = b ? mix : 0;
    for (const m of pod.mats) m.envMapIntensity = intensity;
    return;
  }
  if (pod.envBase !== base) { pod.envBase = base; for (const m of pod.mats) m.envMap = base; }
  for (const m of pod.mats) m.envMapIntensity = intensity;
  pod.env.envMapB.value = b || null;
  pod.env.envMapMix.value = b ? mix : 0;
}

export function setPodLivery(pod, color, accent) {
  pod.paint.set(color);
  pod.trim.set(accent);
}
// how polished the pod is, 0 (as modelled: worn) .. 1 (paint and metal polished)
export function setPodGloss(pod, g) { pod.gloss.value = g; }

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
