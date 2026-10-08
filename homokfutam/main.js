import * as THREE from 'three';
import { GPU, FORCE_GL, W, TSL, N, U, loadNodes, RENDERER, WEBGPU_MISSING, saveRenderer } from './gfx/backend.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RaceRoom, selfId } from './net.js';
import { loadPodModel, setPodLivery, setPodGloss, setPodEnv, animatePlayerPod, podLift, DEFAULT_HULL, setBroken, breakPart, stowPart } from './playerPod.js';
import { pickQuality, saveQuality, createDynRes, ORDER as GFX_ORDER } from './gfx/quality.js';
import { createEye } from './gfx/eye.js';
import { loadGI, GI_ON } from './gfx/gi.js';
import { installAtmosphere, ATMO, SUN_DIR, PALETTE, skyMaterial, cloudTexture, buildEnvironment, bakeWorldShadow, loadSky, PB_SKY, MID_SHADOW, createMidShadow } from './gfx/atmosphere.js';
import { loadSurfaces, triplanarMaterial } from './gfx/surfaces.js';
import { collectStatic } from './gfx/bvhscene.js';
import { loadGround, terrainMaterial, trackMaterial, rockMaterial, groundDebug, ROCK as ROCKL, ARENA, WIND_DIR } from './gfx/ground.js';
import { GUST_ON, gust, gustField, WAKE_ON, updateWake, setWake } from './gfx/wind.js';
import { LENS } from './gfx/screen.js';
import { bakeMacro } from './world/macro.js';
import { loadRockModels, LodInstances } from './world/rocks.js';
import { buildScatter } from './world/scatter.js';
import { buildHorizon } from './world/horizon.js';
import { buildHaze } from './world/haze.js';
import { buildDrift } from './world/drift.js';
import { placeFalls, buildTrickle } from './world/trickle.js';
import { buildCourse, COURSE_URL } from './world/course.js';
import { LANDMARK_URL, placeLandmark, buildLandmark } from './world/landmark.js';
import { buildBirds } from './world/birds.js';
import { createSolid, BAND as SOLID_BAND, MAT as SOLID_MAT } from './world/solid.js';
import { createPost } from './gfx/post.js';
import { bakeProbes, createLiveEnv } from './gfx/probes.js';
import { Particles, loadFlipbooks } from './gfx/particles.js';
import { createPodFx, createDebris, HeatLayer, createTrailMap } from './gfx/podfx.js';
import { createBeam, createBeamLights, createBeamFlares } from './gfx/beam.js';
import { FxBatch, shown } from './gfx/fxbatch.js';
import { buildDressing } from './world/dressing.js';
import { createAudio } from './audio.js';
import { createHUD } from './hud.js';

const Q = pickQuality();
// the loading screen (index.html, HF_LOAD): the steps of the build, and the preset it is building
const LOAD = window.HF_LOAD || Object.assign(() => {}, { step: async () => {}, meta: () => {}, done: () => { document.getElementById('loading').hidden = true; } });
LOAD.meta(`${{ low: 'ALACSONY', medium: 'KÖZEPES', high: 'MAGAS', ultra: 'ULTRA' }[Q.name] ?? Q.name.toUpperCase()} GRAFIKA · ${RENDERER.toUpperCase()}`);
LOAD(0.06, 'A PÁLYA ÉPÜL', 0.14);
const SKY_READY = loadSky();       // ?gfx=sky:1: the sky tables bake in a worker while the world is built
await loadNodes();             // WebGPURenderer: the node materials (gfx/tsl/), before anything is built
if (!GPU) installAtmosphere();

// ============================================================
//  Utilities
// ============================================================
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const damp = (a, b, k, dt) => lerp(a, b, 1 - Math.exp(-k * dt));
const TAU = Math.PI * 2;
function wrapAngle(a) { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; }
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash2(ix, iz) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function vnoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz), b = hash2(ix + 1, iz), c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  return lerp(lerp(a, b, ux), lerp(c, d, ux), uz);
}
function fbm(x, z, oct = 4) {
  let s = 0, a = 0.5, f = 1, n = 0;
  for (let o = 0; o < oct; o++) { s += a * vnoise(x * f + o * 17.3, z * f - o * 9.1); n += a; f *= 2.03; a *= 0.5; }
  return s / n;
}
const fmtTime = (t) => {
  if (!isFinite(t)) return '–';
  const m = Math.floor(t / 60), s = t - m * 60;
  return m + ':' + (s < 10 ? '0' : '') + s.toFixed(2);
};

// ============================================================
//  Track
// ============================================================
// Control points in metres (x, z). Index 0 is the start/finish line inside the arena.
const CTRL = [
  [-100, 0], [350, 0], [700, -80], [950, -350], [1000, -700], [850, -1000], [500, -1150],
  [200, -1050], [0, -1250], [-300, -1400], [-650, -1300], [-750, -1050], [-550, -850],
  [-300, -750], [-200, -500], [-420, -380], [-700, -330], [-820, -120], [-650, 30], [-350, 0],
];
const A_LAT = 58;      // lateral grip used for the AI speed profile (m/s²)
const TOP = 150;       // normal top speed (m/s) ≈ 540 km/h

function buildTrack() {
  const curve = new THREE.CatmullRomCurve3(CTRL.map(([x, z]) => new THREE.Vector3(x, 0, z)), true, 'centripetal');
  curve.arcLengthDivisions = 4000;
  const approxL = curve.getLength();
  const N = Math.round(approxL / 4);
  const pts = curve.getSpacedPoints(N);
  const T = {
    N, L: 0,
    px: new Float32Array(N), pz: new Float32Array(N), py: new Float32Array(N),
    tx: new Float32Array(N), tz: new Float32Array(N), yaw: new Float32Array(N),
    s: new Float32Array(N + 1), k: new Float32Array(N), hw: new Float32Array(N),
    arena: new Float32Array(N), canyon: new Float32Array(N), wallH: new Float32Array(N),
    line: new Float32Array(N), vmax: new Float32Array(N), ctrlS: [],
  };
  for (let i = 0; i < N; i++) { T.px[i] = pts[i].x; T.pz[i] = pts[i].z; }
  T.s[0] = 0;
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    T.s[i + 1] = T.s[i] + Math.hypot(T.px[j] - T.px[i], T.pz[j] - T.pz[i]);
  }
  T.L = T.s[N];
  const idx = (i) => ((i % N) + N) % N;
  T.idx = idx;
  for (let i = 0; i < N; i++) {
    const a = idx(i - 1), b = idx(i + 1);
    let dx = T.px[b] - T.px[a], dz = T.pz[b] - T.pz[a];
    const l = Math.hypot(dx, dz) || 1;
    T.tx[i] = dx / l; T.tz[i] = dz / l;
    T.yaw[i] = Math.atan2(T.tx[i], T.tz[i]);
  }
  const ds = T.L / N;
  for (let i = 0; i < N; i++) T.k[i] = wrapAngle(T.yaw[idx(i + 1)] - T.yaw[idx(i - 1)]) / (2 * ds); // + = left turn

  // where each control point landed
  for (const [x, z] of CTRL) {
    let best = 0, bd = 1e18;
    for (let i = 0; i < N; i++) { const d = (T.px[i] - x) ** 2 + (T.pz[i] - z) ** 2; if (d < bd) { bd = d; best = i; } }
    T.ctrlS.push(T.s[best]);
  }

  const cyA = T.ctrlS[5] - 40, cyB = T.ctrlS[8] + 60;
  for (let i = 0; i < N; i++) {
    const s = T.s[i];
    const ss = s > T.L / 2 ? s - T.L : s;
    T.arena[i] = smooth(-330, -250, ss) * (1 - smooth(420, 500, ss));
    T.canyon[i] = smooth(cyA - 90, cyA, s) * (1 - smooth(cyB, cyB + 90, s));
    const u = (s / T.L) * TAU;
    const hills = 9 * Math.sin(u * 3 + 0.6) + 5 * Math.sin(u * 7 + 2.1) + 3 * Math.sin(u * 11);
    T.py[i] = hills * (1 - smooth(-520, -330, ss) * (1 - smooth(420, 640, ss)));
    T.hw[i] = lerp(lerp(19, 23, T.arena[i]), 16, T.canyon[i]);
    T.wallH[i] = 46 + 30 * fbm(s * 0.004, 3.7, 3);
  }
  // smooth elevation so the pods never get launched
  for (let pass = 0; pass < 3; pass++) {
    const c = T.py.slice();
    for (let i = 0; i < N; i++) { let a = 0; for (let o = -6; o <= 6; o++) a += c[idx(i + o)]; T.py[i] = a / 13; }
  }

  // racing line (positive = right of centre) and speed profile for the AI
  const ksm = new Float32Array(N);
  for (let i = 0; i < N; i++) { let a = 0; for (let o = -8; o <= 8; o++) a += T.k[idx(i + o)]; ksm[i] = a / 17; }
  for (let i = 0; i < N; i++) {
    let a = 0; for (let o = -6; o <= 26; o++) a += ksm[idx(i + o)]; a /= 33;
    T.line[i] = -clamp(a * 190, -1, 1) * (T.hw[i] - 5);
  }
  for (let pass = 0; pass < 3; pass++) {
    const c = T.line.slice();
    for (let i = 0; i < N; i++) { let a = 0; for (let o = -12; o <= 12; o++) a += c[idx(i + o)]; T.line[i] = a / 25; }
  }
  for (let i = 0; i < N; i++) T.vmax[i] = Math.min(TOP * 1.2, Math.sqrt(A_LAT / Math.max(Math.abs(ksm[i]), 1e-5)));
  for (let pass = 0; pass < 2; pass++) {
    for (let i = N - 1; i >= 0; i--) {
      const n = idx(i + 1);
      T.vmax[i] = Math.min(T.vmax[i], Math.sqrt(T.vmax[n] * T.vmax[n] + 2 * 42 * ds));
    }
  }

  // spatial hash of samples for terrain queries
  const CELL = 80, grid = new Map();
  T.CELL = CELL; T.grid = grid;
  for (let i = 0; i < N; i++) {
    const key = Math.floor(T.px[i] / CELL) + ',' + Math.floor(T.pz[i] / CELL);
    let a = grid.get(key); if (!a) grid.set(key, (a = [])); a.push(i);
  }
  return T;
}
const TR = buildTrack();

// nearest sample (coarse) via spatial hash — for terrain and scenery placement
function nearestCoarse(x, z, out) {
  const cx = Math.floor(x / TR.CELL), cz = Math.floor(z / TR.CELL);
  let best = -1, bd = 1e18;
  for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) {
    const list = TR.grid.get((cx + a) + ',' + (cz + b));
    if (!list) continue;
    for (const i of list) { const d = (TR.px[i] - x) ** 2 + (TR.pz[i] - z) ** 2; if (d < bd) { bd = d; best = i; } }
  }
  out.i = best; out.d = best < 0 ? 1e9 : Math.sqrt(bd);
  return out;
}

// precise locator for moving pods. loc = { i, s, d (lateral, + = right), y, hw, wall }
function locate(x, z, loc, full) {
  const N = TR.N, idx = TR.idx;
  let best = loc.i | 0, bd = 1e18;
  const from = full ? 0 : best - 40, to = full ? N - 1 : best + 40;
  for (let k = from; k <= to; k++) {
    const i = full ? k : idx(k);
    const d = (TR.px[i] - x) ** 2 + (TR.pz[i] - z) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  let i0 = best, i1 = idx(best + 1);
  let ax = TR.px[i0], az = TR.pz[i0], bx = TR.px[i1] - ax, bz = TR.pz[i1] - az;
  let t = ((x - ax) * bx + (z - az) * bz) / (bx * bx + bz * bz);
  if (t < 0) {
    i1 = i0; i0 = idx(best - 1);
    ax = TR.px[i0]; az = TR.pz[i0]; bx = TR.px[i1] - ax; bz = TR.pz[i1] - az;
    t = ((x - ax) * bx + (z - az) * bz) / (bx * bx + bz * bz);
  }
  t = clamp(t, 0, 1);
  const segL = Math.hypot(bx, bz);
  const tx = bx / segL, tz = bz / segL;
  const rx = -tz, rz = tx;
  loc.i = best;
  loc.s = (TR.s[i0] + t * segL) % TR.L;
  loc.d = (x - (ax + bx * t)) * rx + (z - (az + bz * t)) * rz;
  loc.y = lerp(TR.py[i0], TR.py[i1], t);
  loc.hw = lerp(TR.hw[i0], TR.hw[i1], t);
  loc.tx = tx; loc.tz = tz;
  loc.arena = TR.arena[best]; loc.canyon = TR.canyon[best];
  return loc;
}
// point on track at arc length s with lateral offset d
function trackPoint(s, d, out) {
  s = ((s % TR.L) + TR.L) % TR.L;
  let lo = 0, hi = TR.N;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (TR.s[m] <= s) lo = m; else hi = m; }
  const i0 = lo, i1 = TR.idx(lo + 1);
  const t = (s - TR.s[i0]) / (TR.s[i0 + 1] - TR.s[i0]);
  const tx = lerp(TR.tx[i0], TR.tx[i1], t), tz = lerp(TR.tz[i0], TR.tz[i1], t);
  const l = Math.hypot(tx, tz);
  out.x = lerp(TR.px[i0], TR.px[i1], t) + (-tz / l) * d;
  out.z = lerp(TR.pz[i0], TR.pz[i1], t) + (tx / l) * d;
  out.y = lerp(TR.py[i0], TR.py[i1], t);
  out.yaw = Math.atan2(tx, tz);
  out.i = i0;
  return out;
}

// ============================================================
//  Ground height (analytic, shared by terrain mesh and physics)
// ============================================================
function duneH(x, z) {
  const big = fbm(x * 0.0022, z * 0.0022, 3);
  const ripple = fbm(x * 0.011 + 40, z * 0.006, 2);
  return (big - 0.42) * 70 + ripple * 7;
}
// Transverse dunes built by the wind (WIND_DIR): a long gentle windward slope up to a sharp
// brink, then a short steep slip face. Crests meander, swell and die out along their length.
// Only faded in well away from the track, so the racing surface and its banks are unchanged.
const WDX = 0.92 / Math.hypot(0.92, 0.39), WDZ = 0.39 / Math.hypot(0.92, 0.39), DUNE_L = 175, DUNE_C = 0.78;
function dunePhase(x, z, out) {
  const a = x * WDX + z * WDZ, b = -x * WDZ + z * WDX;
  const warp = (fbm(b * 0.0035 + 7, a * 0.0016, 2) - 0.5) * 2.4 + (fbm(b * 0.011 - 3, a * 0.005, 2) - 0.5) * 0.5;
  const ph = a / DUNE_L + warp;
  out.t = ph - Math.floor(ph);
  out.amp = 4 + 16 * smooth(0.3, 0.75, fbm(b * 0.0028 + 11, a * 0.0013 - 4, 3));
  return out;
}
const _dp = { t: 0, amp: 0 };
function windDune(x, z) {
  const { t, amp } = dunePhase(x, z, _dp);
  const p = t < DUNE_C ? 1 - Math.pow(1 - t / DUNE_C, 1.3) : Math.pow(1 - (t - DUNE_C) / (1 - DUNE_C), 1.2);
  return amp * (p - 0.45);
}
// 0..1: how much a point sits on a tall, sharp brink (spindrift comes off those)
function duneCrest(x, z) {
  const { t, amp } = dunePhase(x, z, _dp);
  return smooth(0.05, 0.0, Math.abs(t - DUNE_C + 0.01)) * smooth(8, 18, amp);
}
const _nc = { i: 0, d: 0 };
function groundAt(x, z, i, dist) {
  if (i < 0) return duneH(x, z) + windDune(x, z);
  const ty = TR.py[i], hw = TR.hw[i], c = TR.canyon[i];
  let far = duneH(x, z) + windDune(x, z) * smooth(hw + 55, 150, dist);
  if (c > 0.001) far = lerp(far, ty + TR.wallH[i] * c - 0.6, c);
  const inner = lerp(hw + 6, hw + 16, c), outer = lerp(hw + 95, hw + 32, c);
  return lerp(ty - 0.35, far, smooth(inner, outer, dist));
}
function groundQuery(x, z) { nearestCoarse(x, z, _nc); return groundAt(x, z, _nc.i, _nc.d); }

// ============================================================
//  Canvas textures
// ============================================================
function canvasTex(w, h, draw, repeat = true) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}
function grain(g, w, h, base, amp, seed) {
  const r = rng(seed), img = g.createImageData(w, h), d = img.data;
  for (let i = 0; i < w * h; i++) {
    const n = (r() - 0.5) * amp;
    d[i * 4] = base[0] + n; d[i * 4 + 1] = base[1] + n * 0.9; d[i * 4 + 2] = base[2] + n * 0.75; d[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
}
const TEX = {
  glow: canvasTex(128, 128, (g, w) => {
    const grd = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.25, 'rgba(255,255,255,.55)');
    grd.addColorStop(0.6, 'rgba(255,255,255,.12)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, w, w);
  }, false),
  checker: canvasTex(64, 16, (g) => {
    for (let x = 0; x < 16; x++) for (let y = 0; y < 4; y++) {
      g.fillStyle = (x + y) % 2 ? '#f4efe6' : '#1c1814'; g.fillRect(x * 4, y * 4, 4, 4);
    }
  }),
};
TEX.checker.magFilter = THREE.NearestFilter;

// ============================================================
//  Renderer, scene, sky, light
// ============================================================
const canvas = document.getElementById('view');
// WebGPURenderer (?renderer=webgpu, gfx/backend.js): WebGPU, or its own WebGL2 backend; it has to finish
// initialising before anything renders or asks for its features (the KTX2 loader does)
const renderer = GPU
  ? new W.WebGPURenderer({ canvas, antialias: !Q.post, powerPreference: 'high-performance', stencil: false, forceWebGL: FORCE_GL,
    trackTimestamp: new URLSearchParams(location.search).has('gputime') })      // GPU time per frame in perf() (localhost hook)
  : new THREE.WebGLRenderer({ canvas, antialias: !Q.post, powerPreference: 'high-performance', stencil: false });
if (GPU) {
  await renderer.init();
  console.log(`HOMOKFUTAM: WebGPURenderer on ${renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2'}`);
  // TSL puts the matrices of an InstancedMesh that fits in a uniform buffer into one: three then rewrites
  // that buffer for every draw, every frame, and the instance count is baked into the shader, so every
  // count is another pipeline to compile (~40 extra copies of the rock shader). With no uniform-buffer
  // budget, instance matrices go into vertex attributes (uploaded when they change) and the pods'
  // skeletons into a bone texture.
  renderer.backend.capabilities.getUniformBufferLimit = () => 0;
}
// with post-processing on, tone mapping happens in the effect chain (gfx/post.js)
// With post-processing the tone mapping is AgX at the end of the post chain (gfx/post.js, like Blender's
// view transform), and it takes this exposure. Without it (LOW) the materials tone map with ACES: it needs
// no extra exposure and keeps its punch without the colour grade.
renderer.toneMapping = Q.post ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = Q.post ? 1.1 : 1.0;
renderer.shadowMap.enabled = true;
renderer.info.autoReset = false;
renderer.shadowMap.type = THREE.PCFShadowMap;
const dynRes = createDynRes(renderer, Q, () => resize());
const SURF = loadSurfaces(renderer);
const GROUND_READY = loadGround(renderer, Q);

const scene = new THREE.Scene();
if (GPU) installAtmosphere(renderer, scene);
// Only switches USE_FOG on: the real fog is ATMO's height fog and the scene's shaders ignore near/far.
// N8AO does read them, to fade the AO out with distance (with 1..2 m it faded out all of it).
scene.fog = new THREE.Fog(PALETTE.fog, 200, 2500);
scene.background = PALETTE.fog.clone();
const camera = new THREE.PerspectiveCamera(70, 1, 0.5, 9000);

ATMO.hfCloudTex.value = cloudTexture();
ATMO.hfCloudShadow.value = Q.cloudShadows ? 0.5 : 0;
{
  const sky = new THREE.Mesh(new THREE.SphereGeometry(8000, 48, 24), skyMaterial());
  sky.frustumCulled = false; sky.renderOrder = -1;
  sky.userData.noBake = true;
  scene.add(sky);
  scene.userData.sky = sky;
}
// (with the physically based sky the environment waits for its tables: boot)
scene.environment = PB_SKY ? null : buildEnvironment(renderer);
scene.environmentIntensity = PALETTE.envI;
// warm bounce from the sand and rock that the sky-only environment does not have
scene.add(new THREE.HemisphereLight(PALETTE.hemiSky, PALETTE.hemiGround, PALETTE.hemiI));
const sun = new (GPU ? N.SunLight : THREE.DirectionalLight)(PALETTE.sun, PALETTE.sunI);
sun.castShadow = true;
sun.shadow.mapSize.set(Q.shadow, Q.shadow);
Object.assign(sun.shadow.camera, { left: -Q.shadowBox / 2, right: Q.shadowBox / 2, top: Q.shadowBox / 2, bottom: -Q.shadowBox / 2, near: 10, far: 1600 });
sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.5; sun.shadow.radius = 2.5;
if (GPU) sun.shadow.filterNode = N.smoothPCF;
scene.add(sun, sun.target);

let post = null;    // gfx/post.js, created at boot when the preset asks for it
let EYE = null;     // eye adaptation (?gfx=eye:1, gfx/eye.js), created with the post chain
// D2: with the eye the shade under the canyon walls and the arch goes darker, so that the eye has something to
// open up to (materials with the baked light, ?gfx=gi:1, get theirs from it; the dust in the slot follows either way)
ATMO.hfShade.value = Q.eye ? 1 : 0;
let heatLayer = null;   // exhaust heat distortion (gfx/podfx.js), sampled by the post chain
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  post?.setSize(w, h);
  heatLayer?.setSize(Math.round(w * renderer.getPixelRatio()), Math.round(h * renderer.getPixelRatio()));
}
window.addEventListener('resize', resize);
resize();

// ============================================================
//  Helpers for building geometry
// ============================================================
const C = (hex) => new THREE.Color(hex);
const ROCK = { light: C('#dcae78'), mid: C('#c0834f'), dark: C('#8e5836'), top: C('#dfc49a') };
const _col = new THREE.Color();
function strata(y, s, out) {
  const b = Math.sin(y * 0.38 + fbm(s * 0.01, y * 0.02, 2) * 4);
  if (b > 0.35) out.copy(ROCK.light).lerp(ROCK.mid, (1 - b) * 0.6);
  else if (b > -0.45) out.copy(ROCK.mid).lerp(ROCK.light, (b + 0.45) * 0.4);
  else out.copy(ROCK.dark).lerp(ROCK.mid, (b + 1) * 0.8);
  return out;
}
// Sweep a cross-section profile along track samples [i0..i1]. profile(i) -> [[offset, y], ...]
function sweep(i0, i1, side, profile, colorFn, step = 1) {
  const pos = [], col = [], index = [];
  let rows = 0, M = 0;
  for (let k = i0; k <= i1; k += step) {
    const i = TR.idx(k);
    const prof = profile(i);
    M = prof.length;
    const rx = -TR.tz[i] * side, rz = TR.tx[i] * side;
    for (let j = 0; j < M; j++) {
      const [o, y] = prof[j];
      pos.push(TR.px[i] + rx * o, y, TR.pz[i] + rz * o);
      colorFn(i, j, y, _col); col.push(_col.r, _col.g, _col.b);
    }
    rows++;
  }
  for (let r = 0; r < rows - 1; r++) for (let j = 0; j < M - 1; j++) {
    const a = r * M + j, b = a + M;
    index.push(a, b, a + 1, a + 1, b, b + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}
const CLIFF = { scale: 1 / 12, chroma: 0.35, contrast: 1.1, side: THREE.DoubleSide, rough: [0.62, 0.35], varnish: 1, foot: 3 };
const rockMat = rockMaterial(Q, ROCKL.cliff, CLIFF);
const rockMatI = rockMaterial(Q, ROCKL.cliff, CLIFF);      // instanced copies (fallback spires), see rockMatAOSolo
// the canyon walls: their own sky occlusion (aAO), and the canyon's light probe once it is baked
// (the texture only adds grain here: its cracks and spots read as drawn on at this scale)
// (giHue: under the baked light the walls take its colour, the warm bounce, but mostly their own occlusion, aAO, for
// how bright their shade is. The bake's cells are 6 m along the track: it blurred the tunnel slabs' shade and the
// sunlit gaps between them into one dark run and flattened the slot; aAO has them sharp, and so had MEDIUM)
const canyonMat = rockMaterial(Q, ROCKL.cliff, { ...CLIFF, contrast: 0.7, chroma: 0.25, ao: true, aoAlbedo: 0.2, aoGI: 0.4, giHue: 0.85 });
const boulderMat = rockMaterial(Q, ROCKL.boulder, { scale: 1 / 6, chroma: 0.45, contrast: 1.05, rough: [0.6, 0.35], foot: 1.2 });
function rangeWhere(arr, thr) {         // contiguous index range where arr > thr (handles wrap)
  let start = -1;
  for (let i = 0; i < TR.N; i++) if (arr[i] > thr && arr[TR.idx(i - 1)] <= thr) { start = i; break; }
  if (start < 0) return null;
  let end = start; while (arr[TR.idx(end + 1)] > thr && end - start < TR.N) end++;
  return [start, end];
}

// ============================================================
//  Terrain
// ============================================================
const COLLIDERS = [];   // {x, z, r} rock bases the pods can hit off-track (the old collisions, ?col=0)
// Everything solid at pod height as one signed distance field (docs/visual-next-steps.md F2): the canyon's and the
// arena's walls go in as they are swept below, the rocks once their models are in (addRockSolids)
const SOLID = createSolid(TR, groundQuery);
// what a pod hovers over: the ground, or the rock it rides up (the canyon walls' low ends); hint: a track sample near;
// top: rock higher than that is a wall to it, not ground (the face beside a pod, the rock ahead of it)
const rideQuery = (x, z, hint, top = Infinity) => { const g = groundQuery(x, z), h = SOLID.rideAt(x, z, hint); return h > g && h < top ? h : g; };
const rideOf = (r) => r.rideFn || (r.rideFn = (x, z) => rideQuery(x, z, r.loc?.i ?? 0, r.y));
const _rs = { x: 0, z: 0 };
const ARCH = { x: 0, z: 0 };
// The tunnel (?gfx=tunnel:1, docs/visual-next-steps.md D7): in the second half of the canyon, past the stone bridge
// and the canyon's light probe, the slot is roofed over by three rock slabs with two gaps of sky between them;
// open canyon before and after. Arc-length ranges [a, b] of the slabs; roofAt(s): 1 under a slab, 0 elsewhere.
const TUNNEL = (() => {
  if (!Q.tunnel) return [];
  const r = rangeWhere(TR.canyon, 0.99);
  if (!r) return [];
  const a = TR.s[r[0]] + 760;
  return [[0, 52], [62, 110], [122, 190]].map(([x, y]) => [a + x, a + y]);
})();
function roofAt(s) {
  let k = 0;
  for (const [a, b] of TUNNEL) k = Math.max(k, smooth(a - 4, a + 4, s) * (1 - smooth(b - 4, b + 4, s)));
  return k;
}
// Sand streaming across the track (?gfx=drift:1, docs/visual-next-steps.md E1): a few stretches of 100-260 m where the
// wind crosses the open track (|tangent . wind| < 0.5, not in the canyon or the arena) with tall dunes upwind, so it is
// an event and not wallpaper. Arc-length ranges [a, b], the best first, at least 400 m apart; driftAt(s): 0..1.
const DRIFT = (() => {
  if (!Q.drift) return [];
  const N = TR.N, score = new Float32Array(N), step = TR.L / N;
  for (let i = 0; i < N; i++) {
    const along = Math.abs(TR.tx[i] * WDX + TR.tz[i] * WDZ);
    if (along > 0.5 || TR.canyon[i] > 0.02 || TR.arena[i] > 0.02) continue;
    let up = 0;
    for (let d = 70; d <= 270; d += 25) up += smooth(6, 16, dunePhase(TR.px[i] - WDX * d, TR.pz[i] - WDZ * d, _dp).amp);
    score[i] = Math.sqrt(1 - along / 0.5) * (0.3 + 0.7 * up / 9);
  }
  // the best window of up to 260 m inside each run of good samples (at least 100 m)
  const cands = [], WIN = Math.round(260 / step), MIN = Math.round(100 / step);
  for (let i = 0; i < N; i++) {
    if (score[i] < 0.3 || score[TR.idx(i - 1)] >= 0.3) continue;
    let j = i; while (score[TR.idx(j + 1)] >= 0.3 && j - i < N) j++;
    if (j - i + 1 < MIN) continue;
    let best = -1, at = i;
    for (let k = i; k + Math.min(WIN, j - i + 1) - 1 <= j; k++) {
      let sum = 0; for (let m = k; m < k + Math.min(WIN, j - i + 1); m++) sum += score[TR.idx(m)];
      if (sum > best) { best = sum; at = k; }
    }
    cands.push({ a: TR.s[TR.idx(at)], len: Math.min(WIN, j - i + 1) * step, sum: best });
  }
  cands.sort((p, q) => q.sum - p.sum);
  const out = [];
  const gap = (p, q) => { const d = Math.abs(p - q) % TR.L; return Math.min(d, TR.L - d); };
  for (const c of cands) {
    if (out.length >= 4) break;
    if (c.a < 40 || c.a + c.len > TR.L - 40) continue;            // not over the line (the track's s wraps there)
    if (out.some(([a, b]) => gap((a + b) / 2, c.a + c.len / 2) < 400 + (b - a + c.len) / 2)) continue;
    out.push([c.a, c.a + c.len]);
  }
  out.sort((p, q) => p[0] - q[0]);
  console.log('HOMOKFUTAM: sand drifts at', out.map(([a, b]) => `${Math.round(a)}-${Math.round(b)} m`).join(', ') || 'none');
  return out;
})();
// 1 on a stretch, fading over ~50 m at its ends (as the sheet and the road's sand do)
function driftAt(s) {
  let k = 0;
  for (const [a, b] of DRIFT) k = Math.max(k, smooth(a - 30, a + 20, s) * (1 - smooth(b - 20, b + 30, s)));
  return k;
}
// Tiles of 150 m whose resolution follows the distance to the track (fine where the pods
// fly, coarse out in the dunes), merged into 16 chunk meshes. Skirts hide the cracks
// between tiles of different resolution; normals come from the height function so they
// match across tile edges.
const TERRAIN = { cx: 90, cz: -690, size: 7200 };
{
  const { cx, cz, size } = TERRAIN, TILE = 150, NT = size / TILE, CH = 12;
  const SEGS = [[24, 12, 7, 4], [40, 22, 12, 7], [50, 30, 16, 10], [60, 36, 22, 13]][Q.terrain];
  const coarse = [];
  for (let i = 0; i < TR.N; i += 6) coarse.push(i);
  const edgeDist = (x, z) => {        // rough distance from a point to the track edge
    let bd = 1e18, bi = 0;
    for (const i of coarse) { const d = (TR.px[i] - x) ** 2 + (TR.pz[i] - z) ** 2; if (d < bd) { bd = d; bi = i; } }
    return Math.sqrt(bd) - TR.hw[bi];
  };
  const mat = terrainMaterial(Q);
  for (let ci = 0; ci < NT / CH; ci++) for (let cj = 0; cj < NT / CH; cj++) {
    const pos = [], nrm = [], trk = [], index = [];
    for (let ti = ci * CH; ti < (ci + 1) * CH; ti++) for (let tj = cj * CH; tj < (cj + 1) * CH; tj++) {
      const x0 = cx - size / 2 + ti * TILE, z0 = cz - size / 2 + tj * TILE;
      const e = edgeDist(x0 + TILE / 2, z0 + TILE / 2) - TILE * 0.71;
      const n = SEGS[e < 70 ? 0 : e < 320 ? 1 : e < 1100 ? 2 : 3], st = TILE / n, W = n + 3;
      const H = new Float32Array(W * W), K = new Float32Array(W * W);
      for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) {
        const x = x0 + (i - 1) * st, z = z0 + (j - 1) * st;
        nearestCoarse(x, z, _nc);
        H[j * W + i] = groundAt(x, z, _nc.i, _nc.d);
        K[j * W + i] = _nc.i >= 0 ? clamp(_nc.d - TR.hw[_nc.i], 0, 250) : 250;
      }
      const base = pos.length / 3;
      const vtx = (i, j, drop) => {
        const x = x0 + i * st, z = z0 + j * st, k = (j + 1) * W + (i + 1), y = H[k];
        pos.push(x, y - drop, z);
        const nx = H[k - 1] - H[k + 1], nz = H[k - W] - H[k + W], ny = 2 * st, l = Math.hypot(nx, ny, nz);
        nrm.push(nx / l, ny / l, nz / l);
        trk.push(K[k]);
      };
      for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) vtx(i, j, 0);
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const a = base + j * (n + 1) + i, b = a + n + 1;
        index.push(a, b, a + 1, a + 1, b, b + 1);
      }
      // skirts on the four edges
      const drop = st * 0.6 + 2.5;
      for (const f of [(k) => [k, 0], (k) => [n, k], (k) => [n - k, n], (k) => [0, n - k]]) {
        const s0 = pos.length / 3;
        for (let k = 0; k <= n; k++) { const [i, j] = f(k); vtx(i, j, drop); }
        for (let k = 0; k < n; k++) {
          const [i0, j0] = f(k), [i1, j1] = f(k + 1);
          const a = base + j0 * (n + 1) + i0, b = base + j1 * (n + 1) + i1;
          index.push(a, b, s0 + k, b, s0 + k + 1, s0 + k);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('aTrackD', new THREE.Float32BufferAttribute(trk, 1));
    g.setIndex(index);
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mat);
    m.receiveShadow = true;
    m.userData.terrain = true;
    scene.add(m);
  }
}

// ============================================================
//  Track surface, start line, edge posts
// ============================================================
let TRACK_MESH = null, DRIFT_SHEET = null;
// Across the track: the packed surface over the half-width, then on each side a berm of sand
// the pods have pushed up (a low ridge ~2.6 m out) running down to meet the terrain ~7 m out.
// Only the look: physics keeps using groundAt. No berm in the arena or the canyon.
// bermB: how much berm at sample i, arc length s, side c (-1 left, 1 right); bermH: its height over the
// track e metres past the edge (the track mesh's columns are at 1.2, 2.6, 4.5 and 7 m)
const BERM_OUT = [1.2, 2.6, 4.5, 7.0];
function bermB(i, s, c) { return (1 - TR.arena[i]) * (1 - TR.canyon[i]) * (0.6 + 0.8 * fbm(s * 0.021, c * 13.1, 2)); }
function bermH(e, b) { return e < 2 ? 0.06 + 0.1 * b : e < 3 ? 0.02 + 0.55 * b - (1 - b) * 0.06 : e < 5 ? -0.14 + 0.26 * b : -0.3; }
// the drawn surface at arc length s, lateral d (sample i, world x, z): the road, the berm, then the terrain
function surfaceAt(i, s, d, x, z) {
  const hw = TR.hw[i], e = Math.abs(d) - hw;
  if (e <= 0) return TR.py[i] + 0.06;
  if (e >= 7) return groundQuery(x, z);
  const b = bermB(i, s, d < 0 ? -1 : 1);
  let e0 = 0, h0 = 0.06;
  for (const e1 of BERM_OUT) {
    const h1 = bermH(e1, b);
    if (e <= e1) return TR.py[i] + h0 + (h1 - h0) * (e - e0) / (e1 - e0);
    e0 = e1; h0 = h1;
  }
  return groundQuery(x, z);
}
{
  const pos = [], tr = [], dir = [], zone = [], index = [];
  const IN = [-1, -0.5, 0, 0.5, 1];                // multiples of the half-width
  const OUT = BERM_OUT;                            // metres past the edge
  const cols = [...OUT.slice().reverse().map((e) => [-1, e]), ...IN.map((c) => [c, null]), ...OUT.map((e) => [1, e])];
  const NC = cols.length;
  for (let k = 0; k <= TR.N; k++) {
    const i = TR.idx(k), hw = TR.hw[i], y = TR.py[i], s = TR.s[k];
    const rx = -TR.tz[i], rz = TR.tx[i];
    for (const [c, e] of cols) {
      let o, h;
      if (e === null) { o = c * hw; h = 0.06; }
      else {
        o = c * (hw + e);
        h = bermH(e, bermB(i, s, c));
      }
      pos.push(TR.px[i] + rx * o, y + h, TR.pz[i] + rz * o);
      tr.push(o, s, TR.line[i], hw);
      dir.push(TR.tx[i], TR.tz[i]);
      zone.push(TR.arena[i], TR.canyon[i]);
    }
  }
  for (let r = 0; r < TR.N; r++) for (let j = 0; j < NC - 1; j++) {
    const a = r * NC + j, b = a + NC;
    index.push(a, a + 1, b, a + 1, b + 1, b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aTr', new THREE.Float32BufferAttribute(tr, 4));
  g.setAttribute('aDir', new THREE.Float32BufferAttribute(dir, 2));
  g.setAttribute('aZone', new THREE.Float32BufferAttribute(zone, 2));
  g.setIndex(index); g.computeVertexNormals();
  const m = new THREE.Mesh(g, trackMaterial(Q, TR.L, TUNNEL, DRIFT));
  m.userData.track = true;
  m.receiveShadow = true;
  scene.add(m);
  TRACK_MESH = m;
  // the streams of sand over the drift stretches (E1): one layer of grains on LOW
  DRIFT_SHEET = buildDrift({ scene, TR, trackPoint, surfaceAt, ranges: DRIFT, layers: Q.name === 'low' ? 1 : 2 });

  // checkered start/finish line
  const line = new THREE.Mesh(new THREE.PlaneGeometry(TR.hw[0] * 2, 3.2), new THREE.MeshStandardMaterial({ map: TEX.checker, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -4 }));
  line.rotation.set(-Math.PI / 2, 0, TR.yaw[0]);
  line.position.set(TR.px[0], TR.py[0] + 0.08, TR.pz[0]);
  line.receiveShadow = true;
  scene.add(line);

}

// ============================================================
//  Canyon
// ============================================================
let CANYON_BRIDGE = null;
const CANYON_WALLS = [];
// the canyon walls' low ends as ramps (F2): all ramp below h0 m of wall, all wall above h1; run: m out per m up;
// climb: how far up a ramp a pod rides before it meets the wall line there (m above the band a wall has); step: how
// much higher than its hull's underside a pod rides onto rock (the hover lifts it); bank: how hard the rock's slope
// pushes a pod riding on it back down (m/s² per unit of slope); taper: how far out the wall line starts where the
// wall is only beginning (m, gone at taperH m of wall), so it comes in from the side, over the ramp, not square on
const RAMP = { h0: 5, h1: 30, run: 2.6, climb: 1.5, step: 1.2, bank: 28, taper: 34, taperH: 20 };
{
  const r = rangeWhere(TR.canyon, 0.01);
  if (r) {
    // The walls, swept every 2 m of arc length. Sandstone beds (4-11 m) dip gently along the canyon
    // and wander; the soft beds are cut back into recesses and alcoves, the hard ones stand out with a
    // lip at the top; vertical joints and buttresses break the wall up along the track. The colour
    // comes from the same beds (pale hard beds, redder soft ones), so the bands follow the ledges.
    // aAO: how much sky a point sees from down in the slot (darker low down and in the recesses).
    const hash1 = (k) => { const x = Math.sin(k * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
    const PAL = ['#d6be9f', '#c8a27e', '#b98864', '#a87457', '#e0d0b6'].map(C);
    const HARD = [0, 4, 1], SOFT = [2, 3, 1, 2];
    const tp = { x: 0, y: 0, z: 0, yaw: 0, i: 0 };
    const at = (arr, s) => {            // arr (per track sample) at arc length s, after trackPoint(s)
      const i0 = tp.i, i1 = TR.idx(i0 + 1), ds = TR.s[i0 + 1] - TR.s[i0];
      return lerp(arr[i0], arr[i1], clamp((((s - TR.s[i0]) % TR.L) + TR.L) % TR.L / ds, 0, 1));
    };
    const bed = (y, s, side) => {       // y: metres above the canyon floor
      const u = (y + s * 0.011 + (fbm(s * 0.004 + side * 2, y * 0.012, 2) - 0.5) * 7) / 7.2 + (fbm(y * 0.06, 3.3, 2) - 0.5) * 0.9;
      const k = Math.floor(u);
      return { k, f: u - k, hard: hash1(k) };
    };
    const s0 = TR.s[TR.idx(r[0] - 2)], len = (((TR.s[TR.idx(r[1] + 2)] - s0) % TR.L) + TR.L) % TR.L;
    // The wall's cross-section, shared by the sweep below and the solid field (F2). slice(): what holds for a whole
    // slice at arc length s (after trackPoint(s) into tp); faceAt(): the face at height fraction h of it (foot: the
    // bottom row): its lateral offset o, height y, bed b, the noise n and the cut-back.
    // The wall's low ends are ramps (F2): where the wall is lower than RAMP.h1 its face lies back towards a slope of 1 m
    // up per RAMP.run m out (all the way below RAMP.h0), so a pod that runs wide at a mouth of the canyon rides up the
    // rock instead of hitting a wall (sc.ramp: 0 a wall, 1 a ramp)
    const slice = (s, side, sc) => {
      trackPoint(s, 0, tp);
      tp.rx = -Math.cos(tp.yaw) * side; tp.rz = Math.sin(tp.yaw) * side;
      sc.c = at(TR.canyon, s); sc.H = at(TR.wallH, s) * sc.c; sc.hw = at(TR.hw, s); sc.ty = tp.y;
      sc.ramp = 1 - smooth(RAMP.h0, RAMP.h1, sc.H);
      const jn = 1 - Math.abs(2 * fbm(s * 0.05 + side * 9, side * 3.1, 2) - 1);
      sc.joint = Math.pow(jn, 10) * 2.6;                                 // narrow vertical slots
      sc.butt = (fbm(s * 0.013 + side * 4, 1.7, 3) - 0.5) * 9;          // buttresses and bays
      return sc;
    };
    const faceAt = (s, side, sc, h, foot, out) => {
      const y = sc.H * h;
      const b = bed(y, s, side), soft = 1 - b.hard;
      const n = fbm(s * 0.035, h * 8 + side * 31, 3) - 0.5;
      const fine = fbm(s * 0.2 + 11, h * 26 + side * 7, 2) - 0.5;
      const up = smooth(0.04, 0.16, h);            // the foot stays plain: the pods scrape along it
      const recess = soft > 0.4 ? Math.pow(Math.sin(Math.PI * b.f), 0.8) * (soft - 0.4) * 4.2 : 0;
      const lip = b.hard > 0.6 ? Math.exp(-Math.pow((1 - b.f) / 0.18, 2)) * 0.7 : 0;
      const alc = smooth(0.58, 0.8, fbm(s * 0.011 + side * 3, h * 1.6 + 2, 2)) * Math.pow(Math.sin(Math.PI * clamp((h - 0.12) / 0.6, 0, 1)), 1.5) * 4.5 * (0.4 + soft);
      const cut = recess + alc + sc.joint * smooth(0.05, 0.3, h);
      out.o = foot ? sc.hw + 0.8 : sc.hw + 2 + 5 * Math.pow(h, 1.6) + sc.butt * h + n * 4 * h + fine * 0.8 * h + (cut - lip) * up;
      if (sc.ramp > 0 && !foot) out.o = lerp(out.o, sc.hw + 0.8 + RAMP.run * y + n * 1.5 * h, sc.ramp);
      out.y = y; out.yw = sc.ty - 1.5 + y + n * 2 * h; out.b = b; out.cut = cut; out.up = up;
      return out;
    };
    // the rim and the slope beyond the face's top row (o: its offset): pushed out where a ramp's top runs past them
    const RIM = [[14, 2], [30, 10], [75, 35], [135, 70]];
    const rimO = (sc, top, k) => sc.ramp > 0 ? Math.max(sc.hw + RIM[k][0], top + RIM[k][1]) : sc.hw + RIM[k][0];
    const SC = {}, FA = {};
    // ?gfx=geo:1 (docs/visual-next-steps.md C9): every metre and 90 rows up, so the fine noise, the joints
    // and the lips of the hard beds are resolved instead of aliased between rows
    const J = Q.geo ? 90 : 56, STEP = Q.geo ? 1 : 2;
    for (const side of [-1, 1]) {
      const pos = [], col = [], occ = [], index = [];
      let rows = 0, M = 0;
      // the wall's profile per row, for placing things against it and on top of it (the sand falls, E3; the
      // spectators on the rim, E4): lateral offset and height of every vertex up the face (0..J), then the rim and
      // the slope beyond (J+1..J+4); side 1 is the left of the direction of travel
      const prof = { side, rows: [] };
      CANYON_WALLS.push(prof);
      let pr = null;
      const vert = (o, y, rgb, a) => { pos.push(tp.x + tp.rx * o, y, tp.z + tp.rz * o); col.push(rgb.r, rgb.g, rgb.b); occ.push(a); if (pr && pr.n < pr.o.length) { pr.o[pr.n] = o; pr.y[pr.n++] = y; } };
      for (let s = s0; s <= s0 + len + 1e-3; s += STEP) {
        const sc = slice(s, side, SC), { c, H, hw, ty } = sc;
        pr = { s, x: tp.x, z: tp.z, rx: tp.rx, rz: tp.rz, ty, H, hw, c, J, o: new Float32Array(J + 5), y: new Float32Array(J + 5), n: 0 };
        prof.rows.push(pr);
        const drift = fbm(s * 0.003 + side, 0.5, 2);
        const start = pos.length / 3;
        let top = 0;
        for (let j = 0; j <= J; j++) {
          const h = j / J, { o, y, yw, b, cut, up } = faceAt(s, side, sc, h, j === 0, FA);
          top = o;
          const pick = b.hard > 0.5 ? HARD[((b.k % 3) + 3) % 3] : SOFT[((b.k % 4) + 4) % 4];
          _col.copy(PAL[pick]).lerp(PAL[1], drift * 0.35)
            .multiplyScalar((0.94 + 0.08 * b.f) * (1 + 0.025 * Math.sin(y * 5.7)) * (1 + (fbm(s * 0.05, y * 0.08 + side, 2) - 0.5) * 0.12));
          // (under the tunnel's roof, below ~25 m, the wall sees almost no sky)
          const sky = (0.32 + 0.68 * Math.pow(h, 0.65)) * (1 - 0.45 * clamp(cut / 3.5, 0, 1) * up) * (1 - 0.8 * roofAt(s) * smooth(27, 22, y));
          vert(o, yw, _col, sky);
        }
        _col.copy(PAL[4]).lerp(PAL[0], 0.4);
        const flat = 1 - sc.ramp;          // (a ramp runs straight on into its top, without the rim's lip)
        vert(rimO(sc, top, 0), ty + H + (1.5 + (fbm(s * 0.05, side * 5) - 0.5) * 3) * flat, _col, 1);
        vert(rimO(sc, top, 1), ty + H + (fbm(s * 0.02, side * 5) - 0.5) * 6 * flat, _col, 1);
        vert(rimO(sc, top, 2), ty + H * 0.85, _col, 1);
        vert(rimO(sc, top, 3), ty - 6, _col, 1);
        M = pos.length / 3 - start;
        rows++;
      }
      for (let q = 0; q < rows - 1; q++) for (let j = 0; j < M - 1; j++) {
        const a = q * M + j, b = a + M;
        index.push(a, b, a + 1, a + 1, b, b + 1);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.setAttribute('aAO', new THREE.Float32BufferAttribute(occ, 1));
      g.setIndex(index);
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, canyonMat);
      m.castShadow = m.receiveShadow = true;
      m.userData.rock = true;
      m.userData.canyonWall = true;          // (the light bake turns its faces towards the track: gfx/gibake.js)
      scene.add(m);
    }
    // The walls into the solid field (F2): per metre of arc length and side, the face where it stands out furthest
    // within the band of heights a pod occupies above the ground at its foot, from the profile itself at a fixed
    // resolution (not from the rows above, which ?gfx=geo:1 changes). Where the wall is lower than the band there is
    // none; where it is more ramp than wall, its surface (the face, the rim and the slope beyond) is one the pods ride
    // on instead (SOLID.addRide, rideQuery).
    for (const side of [-1, 1]) for (let s = s0; s <= s0 + len + 1e-3; s += SOLID.ds) {
      const sc = slice(s, side, SC);
      if (sc.H < 0.5) continue;
      // (the ride surface: the ramps, and wherever else a pod can get onto the rock (round the wall's slanted leading
      // edge, solid.js wallAt, onto the rim behind the face) it rides on it rather than through it)
      {
        const K = 12, o = new Float32Array(K + 5), y = new Float32Array(K + 5);
        for (let k = 0; k <= K; k++) { faceAt(s, side, sc, k / K, k === 0, FA); o[k] = FA.o; y[k] = FA.yw; }
        const flat = 1 - sc.ramp;
        const rimY = [sc.ty + sc.H + (1.5 + (fbm(s * 0.05, side * 5) - 0.5) * 3) * flat, sc.ty + sc.H + (fbm(s * 0.02, side * 5) - 0.5) * 6 * flat, sc.ty + sc.H * 0.85, sc.ty - 6];
        for (let k = 0; k < 4; k++) { o[K + 1 + k] = rimO(sc, o[K], k); y[K + 1 + k] = rimY[k]; }
        SOLID.addRide(side, s, o, y, sc.ramp > 0);
      }
      // the wall line: on a ramp, RAMP.climb higher up (the pod rides that far up it first), so the line runs on
      // unbroken from the ramps into the faces; on a ramp it is soft (SOLID_MAT.ramp: HIT_RAMP)
      const g = groundQuery(tp.x + tp.rx * (sc.hw + 2), tp.z + tp.rz * (sc.hw + 2));
      const lo = SOLID_BAND[0] + RAMP.climb * sc.ramp, hi = SOLID_BAND[1] + RAMP.climb * sc.ramp;
      const dh = Math.min(1 / 64, 0.4 / sc.H);
      let face = Infinity;
      for (let h = dh; h <= 1 + 1e-6; h += dh) {
        const rel = faceAt(s, side, sc, Math.min(h, 1), false, FA).yw - g;
        if (rel > hi) break;
        if (rel >= lo && FA.o < face) face = FA.o;
      }
      face += RAMP.taper * Math.max(0, 1 - sc.H / RAMP.taperH) ** 2;
      // (solid is the face itself, out to a little past its top row: beyond that is the rim, rock to ride on where it
      // is low enough to reach, out of reach where it is not)
      if (face < Infinity) SOLID.setWall(side, s, face, Math.max(face + 3, faceAt(s, side, sc, 1, false, FA).o + 3), sc.ramp >= 0.5 ? SOLID_MAT.ramp : SOLID_MAT.canyon);
    }
    // a natural rock bridge across the canyon
    const mid = TR.idx(Math.round((r[0] + r[1]) / 2) + 18);
    const H = TR.wallH[mid] * 0.82;
    let bg = new THREE.BoxGeometry(2 * (TR.hw[mid] + 22), 9, 16, 48, 8, 12);
    bg.deleteAttribute('uv'); bg.deleteAttribute('normal');
    bg = mergeVertices(bg);
    const bp = bg.attributes.position;
    for (let v = 0; v < bp.count; v++) {
      const x = bp.getX(v), y = bp.getY(v), z = bp.getZ(v);
      const n = fbm(x * 0.09 + 3, y * 0.2 + z * 0.13, 3) - 0.5;
      bp.setY(v, y + (y < 0 ? -Math.cos((x / (TR.hw[mid] + 22)) * Math.PI / 2) * 5 : 0) + n * 2.4);
      bp.setZ(v, z * (1 + n * 0.5) + (fbm(x * 0.05, y * 0.3, 2) - 0.5) * 3);
    }
    const bcol = new Float32Array(bp.count * 3);
    for (let v = 0; v < bp.count; v++) { strata(bp.getY(v) + H, 300, _col); bcol.set([_col.r, _col.g, _col.b], v * 3); }
    bg.setAttribute('color', new THREE.BufferAttribute(bcol, 3));
    bg.computeVertexNormals();
    const bridge = new THREE.Mesh(bg, rockMat);
    bridge.position.set(TR.px[mid], TR.py[mid] + H, TR.pz[mid]);
    bridge.rotation.y = TR.yaw[mid];
    bridge.castShadow = bridge.receiveShadow = true;
    bridge.userData.rock = true;
    bridge.userData.span = 2 * (TR.hw[mid] + 22);
    bridge.userData.s = TR.s[mid];
    scene.add(bridge);
    CANYON_BRIDGE = bridge;          // gets the Blender model once rocks.glb is in
    for (const [a, b] of TUNNEL) buildRoof(a, b);
  }
}

// One roof slab of the tunnel (D7) from arc length a to b: a closed tube swept along the track. Its cross-section is a
// flat ceiling along a bedding plane (~29 m up, off the centre a little) that curves steeply down into the walls (a
// squircle, meeting them ~28 m up), under a top ~9 m higher. The ceiling steps where blocks fell out of it, so it reads
// as sandstone rather than a vault. Over the last ~6 m the ceiling and the top close into a rounded, ragged lip (the
// gaps of sky): a flat end cap read as a tent of triangles from below. Faces point out of the rock: the light bake
// reads back faces as "inside".
function buildRoof(a, b) {
  const J = 40, W = 34, ring = 2 * (J + 1);
  const rows = [];
  for (let s = a; s < b - 1e-3; s += 1.5) rows.push(s);
  rows.push(b);
  const pos = [], col = [], occ = [], index = [], tp = { x: 0, y: 0, z: 0, yaw: 0, i: 0 };
  const centres = [];
  const LIP = 4;            // rows over which an end closes
  rows.forEach((s0, ri) => {
    const end = ri < rows.length / 2 ? -1 : 1;
    const e = Math.min(1, Math.min(ri, rows.length - 1 - ri) / LIP), f = Math.sqrt(e);
    let cx = 0, cy = 0, cz = 0;
    for (let k = 0; k < ring; k++) {
      const top = k > J, j = top ? ring - 1 - k : k, u = (j / J) * 2 - 1;
      // the ends are ragged: each column ends a little earlier or later
      const s = s0 + end * (1 - e) * (fbm(u * 3 + a * 0.013, 0.5, 2) - 0.35) * 7;
      trackPoint(s, 0, tp);
      const lx = -Math.cos(tp.yaw), lz = Math.sin(tp.yaw);
      const Hc = 29 + (fbm(s * 0.02, 1.3, 2) - 0.5) * 5;
      const ua = Math.min(1, Math.abs(u - (fbm(s * 0.015, 4.1, 2) - 0.5) * 0.25));
      const vault = 12 + (Hc - 12) * Math.cbrt(Math.max(0, 1 - ua * ua * ua));
      // blocks that fell out of the ceiling (steps, long along the track), lumps, and fine roughness
      const blk = Math.floor((fbm(s * 0.03 + 9, u * 0.9 + 2, 2) - 0.5) * 4) * 1.6;
      const under = vault + blk + (fbm(s * 0.12 + 3, u * 4 + 7, 3) - 0.5) * 3 + (fbm(s * 0.4, u * 12 + 1, 2) - 0.5) * 1.2;
      const over = under + 9 - 3 * u * u + (fbm(s * 0.05, u * 3 + 11, 2) - 0.5) * 4, mid = (under + over) / 2;
      // towards an end both close on the middle of the slab: a rounded lip
      const y = top ? mid + (over - mid) * f : mid - (mid - under) * f;
      pos.push(tp.x + lx * u * W, tp.y + y, tp.z + lz * u * W);
      strata(y + (fbm(s * 0.07, u * 3 + 5, 2) - 0.5) * 6, s, _col); col.push(_col.r, _col.g, _col.b);
      occ.push(top ? 1 : 0.15 + 0.3 * (1 - e));
      cx += tp.x; cy += tp.y + y; cz += tp.z;
    }
    centres.push([cx / ring, cy / ring, cz / ring]);
  });
  for (let ri = 0; ri < rows.length - 1; ri++) for (let k = 0; k < ring; k++) {
    const a0 = ri * ring + k, a1 = ri * ring + (k + 1) % ring, b0 = a0 + ring, b1 = a1 + ring;
    index.push(a0, b0, a1, a1, b0, b1);
  }
  // caps: a fan from the ring's centre at each end
  for (const ri of [0, rows.length - 1]) {
    const c = pos.length / 3, [x, y, z] = centres[ri];
    pos.push(x, y, z); strata(y, rows[ri], _col); col.push(_col.r, _col.g, _col.b); occ.push(0.4);
    for (let k = 0; k < ring; k++) index.push(c, ri * ring + k, ri * ring + (k + 1) % ring);
  }
  // every triangle facing out: away from its ring's centre (sides), along the track out of the slab (caps)
  const P = (i) => new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
  const sideTris = (rows.length - 1) * ring * 2;
  trackPoint((a + b) / 2, 0, tp);
  for (let t = 0; t < index.length / 3; t++) {
    const A = P(index[t * 3]), B = P(index[t * 3 + 1]), Cc = P(index[t * 3 + 2]);
    const n = B.clone().sub(A).cross(Cc.clone().sub(A));
    let out;
    if (t < sideTris) {
      const ri = Math.floor(t / (ring * 2)), m = A.clone().add(B).add(Cc).divideScalar(3);
      out = m.sub(new THREE.Vector3(...centres[ri]));
    } else {
      const first = t < sideTris + ring;
      out = new THREE.Vector3(Math.sin(tp.yaw), 0, Math.cos(tp.yaw)).multiplyScalar(first ? -1 : 1);
    }
    if (n.dot(out) < 0) { const k = index[t * 3 + 1]; index[t * 3 + 1] = index[t * 3 + 2]; index[t * 3 + 2] = k; }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aAO', new THREE.Float32BufferAttribute(occ, 1));
  g.setIndex(index);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, canyonMat);
  m.castShadow = m.receiveShadow = true;
  m.userData.rock = true;
  m.userData.tunnel = true;
  scene.add(m);
}

// ============================================================
//  Arena: stands, wall bays, awnings, battlements, start gantry with lights
//  The stands are swept along the track here; the wall bays, awnings, battlements, gate towers
//  and the gantry come from assets/world/arena.glb (models/world/build_arena.py) once loaded.
// ============================================================
const START_LIGHTS = [];
let gantrySign = null;
const ARENA_LAYOUT = { range: null, base: null, T: null, R: null, quat: null, hw: 0, y0: 0, span: 0, towers: [], lamps: [], old: [] };
const AM = (layer, o = {}) => rockMaterial(Q, layer, Object.assign({ arena: true, scale: 1 / 4, chroma: 1, rough: [0, 1], macro: 0.1, foot: 0.8 }, o));
// The openings in the arena walls (the modules' "dark" parts): instead of a flat black face, a room
// behind it by interior mapping. The view ray goes through the face into a box 4.5 m deep (module
// space: the openings face +z, the floor is at y = 0); sunlight pools on the floor near the entrance
// and fades into warm darkness at the back. No textures, no extra geometry.
function interiorMaterial() {
  if (GPU) return N.interiorNodeMaterial();         // gfx/tsl/dressing.js: needs the module's z axis per instance (iZ)
  const m = new THREE.MeshStandardMaterial({ color: '#0d0907', roughness: 1 });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, ATMO);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vIntP, vIntC;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        mat4 intM = modelMatrix;
        #ifdef USE_INSTANCING
          intM = modelMatrix * instanceMatrix;
        #endif
        vIntP = position;
        vIntC = ( inverse( intM ) * vec4( cameraPosition, 1.0 ) ).xyz;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vIntP, vIntC;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          vec3 d = normalize( vIntP - vIntC );
          float D = 4.5, tBack = D / max( - d.z, 0.15 );
          float tFloor = d.y < -1e-3 ? vIntP.y / - d.y : 1e9;
          vec3 room;
          if ( tFloor < tBack ) {
            // floor: sunlit sand near the entrance, darker further in
            vec3 q = vIntP + d * tFloor;
            float depth = clamp( ( vIntP.z - q.z ) / D, 0.0, 1.0 );
            room = vec3( 0.42, 0.31, 0.2 ) * mix( 1.0, 0.12, pow( depth, 0.6 ) );
          } else {
            // back wall: bounce light from the floor at its foot, dark above
            vec3 q = vIntP + d * tBack;
            room = vec3( 0.16, 0.11, 0.075 ) * ( 0.25 + 0.75 * exp( - max( q.y, 0.0 ) * 0.9 ) );
          }
          // in the colour of the sunlight that comes in
          totalEmissiveRadiance += room * hfSunCol * 0.9;
        }`);
  };
  m.customProgramCacheKey = () => 'arena-interior';
  return m;
}
const ARENA_MATS = {
  stone: AM(ARENA.stone, { ao: true }),
  plaster: AM(ARENA.plaster, { ao: true }),
  wood: AM(ARENA.wood, { ao: true, scale: 1 / 2, sand: 0.4 }),
  cloth: AM(ARENA.cloth, { ao: true, scale: 1 / 2, sand: 0.12, macro: 0, side: THREE.DoubleSide }),
  metal: AM(ARENA.metal, { ao: true, scale: 1 / 2, sand: 0.2, macro: 0, metalness: 0.2 }),
  dark: interiorMaterial(),
};
{
  const standsStone = AM(ARENA.stone, { flat: true, side: THREE.DoubleSide });
  const standsPlaster = AM(ARENA.plaster, { flat: true, side: THREE.DoubleSide });
  const benchWood = AM(ARENA.wood, { flat: true, scale: 1 / 2, sand: 0.3 });
  const tintA = C('#f3e9d6'), tintB = C('#e4d3b6'), plasterTint = C('#f7efe2');
  const r = rangeWhere(TR.arena, 0.55);
  ARENA_LAYOUT.range = r;
  // the arena's wall into the solid field (F2): the bays' faces on both sides along the stands, solid back to the
  // stands' back wall; then the walls are complete (the canyon's went in above)
  if (r) for (let k = r[0]; k <= r[1]; k++) {
    const i0 = TR.idx(k), i1 = TR.idx(k + 1), sA = TR.s[i0], sB = TR.s[i0 + 1];
    for (let s = sA; s < sB; s += SOLID.ds) {
      const hw = lerp(TR.hw[i0], TR.hw[i1], (s - sA) / (sB - sA));
      for (const side of [-1, 1]) SOLID.setWall(side, s, hw + 1.2, hw + 42, SOLID_MAT.arena);
    }
  }
  SOLID.finishWalls();
  if (r) {
    const tier =(i, j) => [TR.hw[i] + 2.8 + 3.2 * (j + 1), TR.py[i] + 4.2 + 2.2 * j];
    for (const side of [-1, 1]) {
      // the tiers, from behind the front-wall bays up to the last row
      const prof = (i) => {
        const hw = TR.hw[i], y0 = TR.py[i];
        const out = [[hw + 2.8, y0 - 0.6], [hw + 2.8, y0 + 4.2]];
        for (let j = 0; j < 11; j++) { const [o, y] = tier(i, j); out.push([o, y], [o, y + 2.2]); }
        return out;
      };
      const g = sweep(r[0], r[1], side, prof, (i, j, y, out) => out.copy(hash2(i >> 2, j + side * 31) > 0.5 ? tintA : tintB));
      const m = new THREE.Mesh(g, standsStone);
      m.castShadow = m.receiveShadow = true;
      scene.add(m);
      // plastered back wall
      const back = (i) => {
        const [o, y] = tier(i, 10);
        return [[o, y + 2.2], [o, y + 6.7], [o + 2.5, y + 6.7], [o + 2.5, TR.py[i] - 4]];
      };
      const bw = new THREE.Mesh(sweep(r[0], r[1], side, back, (i, j, y, out) => out.copy(plasterTint)), standsPlaster);
      bw.castShadow = bw.receiveShadow = true;
      scene.add(bw);
      // a wooden bench along the back of every row
      for (let j = 0; j < 11; j++) {
        const bench = (i) => {
          const [o, y] = tier(i, j);
          return [[o - 0.75, y], [o - 0.75, y + 0.48], [o - 0.06, y + 0.48], [o - 0.06, y]];
        };
        const b = new THREE.Mesh(sweep(r[0], r[1], side, bench, (i, k, y, out) => out.setRGB(1, 1, 1)), benchWood);
        b.castShadow = b.receiveShadow = true;
        scene.add(b);
      }
    }
  }

  // start gantry: two gate towers and a bridge with five lights
  const i = 0, hw = TR.hw[i], y0 = TR.py[i];
  const T = new THREE.Vector3(TR.tx[i], 0, TR.tz[i]), U = new THREE.Vector3(0, 1, 0), R = new THREE.Vector3(-TR.tz[i], 0, TR.tx[i]);
  const base = new THREE.Vector3(TR.px[i], y0, TR.pz[i]);
  const span = 2 * (hw + 12);
  const quat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(R, U, T.clone().negate()));
  Object.assign(ARENA_LAYOUT, { base, T, R, quat, hw, y0, span });
  for (const side of [-1, 1]) {
    const p = base.clone().addScaledVector(R, side * (hw + 12));
    ARENA_LAYOUT.towers.push(p);
    COLLIDERS.push({ x: p.x, z: p.z, r: 7.5 });
  }
  // lights face the grid (which sits behind the line, on -T)
  for (let k = 0; k < 5; k++) {
    const lamp = new THREE.Mesh(new THREE.CircleGeometry(0.9, 18), new THREE.MeshBasicMaterial({ color: '#2b2118', fog: false }));
    lamp.quaternion.copy(quat);
    lamp.position.copy(base).addScaledVector(R, (k - 2) * 2.6).addScaledVector(T, -2.56).setY(y0 + 15.6);
    scene.add(lamp);
    START_LIGHTS.push(lamp);
  }
  // sign on both faces of the gantry
  const sc = document.createElement('canvas'); sc.width = 1024; sc.height = 128;
  const stex = new THREE.CanvasTexture(sc); stex.colorSpace = THREE.SRGBColorSpace;
  const drawSign = () => {
    const g = sc.getContext('2d');
    g.fillStyle = '#e9dcc5'; g.fillRect(0, 0, 1024, 128);
    g.fillStyle = '#1b140e'; g.font = '800 92px "Saira Condensed", "Arial Narrow", sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('HOMOK', 380, 68); g.fillStyle = '#e8772e'; g.fillText('FUTAM', 640, 68);
    stex.needsUpdate = true;
  };
  drawSign();
  gantrySign = drawSign;
  const signMat = new THREE.MeshStandardMaterial({ map: stex, roughness: 0.8 });
  for (const dir of [1, -1]) {           // gantry local +z points at the grid (-T)
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(18, 2.25), signMat);
    sign.quaternion.copy(quat);
    if (dir > 0) sign.rotateY(Math.PI);
    sign.position.copy(base).addScaledVector(T, 2.56 * dir).setY(y0 + (dir > 0 ? 17 : 18.2));
    scene.add(sign);
  }
}

// the modelled arena pieces, placed along the stands
function buildArenaVisuals(models) {
  const L = ARENA_LAYOUT, MATN = ['stone', 'plaster', 'wood', 'cloth', 'metal', 'dark'];
  const parts = (name) => MATN.map((m) => [m, models.get(`${name}_${m}`)]).filter(([, g]) => g);
  const instances = (name, list) => {
    if (!list.length) return;
    for (const [m, g0] of parts(name)) {
      let g = g0;
      if (GPU && m === 'dark') {
        // the interior mapping's module frame (it turns only about y): its z axis in world xz
        g = g0.clone();
        g.setAttribute('iZ', new THREE.InstancedBufferAttribute(new Float32Array(list.flatMap((mx) => [mx.elements[8], mx.elements[10]])), 2));
      }
      const im = new THREE.InstancedMesh(g, ARENA_MATS[m], list.length);
      list.forEach((mx, n) => im.setMatrixAt(n, mx));
      im.computeBoundingSphere();
      im.castShadow = im.receiveShadow = true;
      scene.add(im);
    }
  };
  // module frame: x along the track (mirrored per side so the module stays right-handed),
  // y up, z towards the track; the Blender modules face the track along their -Y
  const U = new THREE.Vector3(0, 1, 0), X = new THREE.Vector3(), Z = new THREE.Vector3();
  const frame = (x, y, z, tx, tz, side) => {
    X.set(tx * -side, 0, tz * -side);
    Z.set(tz * side, 0, -tx * side);
    return new THREE.Matrix4().makeBasis(X, U, Z).setPosition(x, y, z);
  };
  const bays = [], awnings = [], merlons = [];
  if (L.range) {
    const [r0, r1] = L.range;
    for (const side of [-1, 1]) {
      for (let k = r0 + 1; k < r1; k += 2) {
        const i = TR.idx(k), o = TR.hw[i] + 1.2;
        bays.push(frame(TR.px[i] - TR.tz[i] * side * o, TR.py[i], TR.pz[i] + TR.tx[i] * side * o, TR.tx[i], TR.tz[i], side));
      }
      for (let k = r0 + 2; k < r1 - 1; k++) {
        const i = TR.idx(k), ss = TR.s[i] > TR.L / 2 ? TR.s[i] - TR.L : TR.s[i];
        const o = TR.hw[i] + 2.8 + 3.2 * 11, top = TR.py[i] + 4.2 + 2.2 * 10 + 6.7;
        if (Math.abs(ss - 40) < 170) {
          if ((k - r0) % 4 === 0) awnings.push(frame(TR.px[i] - TR.tz[i] * side * o, top, TR.pz[i] + TR.tx[i] * side * o, TR.tx[i], TR.tz[i], side));
        } else {
          for (const f of [0, 0.5]) {
            const j2 = TR.idx(k + 1);
            const x = lerp(TR.px[i], TR.px[j2], f), z = lerp(TR.pz[i], TR.pz[j2], f), oo = o + 1.7;
            merlons.push(frame(x - TR.tz[i] * side * oo, top, z + TR.tx[i] * side * oo, TR.tx[i], TR.tz[i], side));
          }
        }
      }
    }
  }
  instances('bay', bays);
  instances('awning', awnings);
  instances('merlon', merlons);
  const yaw = Math.atan2(L.T.x, L.T.z);
  instances('tower', L.towers.map((p) => new THREE.Matrix4().compose(p, new THREE.Quaternion().setFromAxisAngle(U, yaw), new THREE.Vector3(1, 1, 1))));
  instances('gantry', [new THREE.Matrix4().compose(L.base, L.quat, new THREE.Vector3(L.span / 70, 1, 1))]);
  for (const lamp of START_LIGHTS) lamp.position.addScaledVector(L.T, -0.38);        // in front of the lamp housings
}
// the old simple shapes, if arena.glb can't be loaded
function buildArenaFallback() {
  const L = ARENA_LAYOUT;
  const towerMat = triplanarMaterial('blocks', { scale: 1 / 4, chroma: 0.2, vertexColors: false, color: '#e9dcc5', rough: [0.5, 0.45], macro: 0.1 });
  if (L.range) for (const side of [-1, 1]) {
    const front = (i) => [[TR.hw[i] + 1.2, TR.py[i] - 0.6], [TR.hw[i] + 1.2, TR.py[i] + 2.4], [TR.hw[i] + 2.8, TR.py[i] + 2.4]];
    const m = new THREE.Mesh(sweep(L.range[0], L.range[1], side, front, (i, j, y, out) => out.setRGB(0.85, 0.78, 0.66)), towerMat);
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
  }
  for (const p of L.towers) {
    const body = new THREE.Mesh(new THREE.CylinderGeometry(6.5, 7.2, 22, 20), towerMat);
    body.position.copy(p).setY(L.y0 + 11);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(6.5, 20, 10, 0, TAU, 0, Math.PI / 2), towerMat);
    dome.position.copy(p).setY(L.y0 + 22);
    for (const o of [body, dome]) { o.castShadow = o.receiveShadow = true; scene.add(o); }
  }
  const gantry = new THREE.Mesh(new THREE.BoxGeometry(L.span, 5, 5), towerMat);
  gantry.quaternion.copy(L.quat);
  gantry.position.copy(L.base).setY(L.y0 + 17);
  gantry.castShadow = true;
  scene.add(gantry);
}
const ARENA_READY = loadRockModels(new URL('./assets/world/arena.glb', import.meta.url).href).then(buildArenaVisuals).catch((e) => {
  console.warn('HOMOKFUTAM: arena models failed, using the simple shapes', e);
  buildArenaFallback();
});

// ============================================================
//  Rock spires, boulders, mesas, natural arch
// ============================================================
// smooth, welded geometry: drop uv/normal so mergeVertices can close the seams
function weld(g) {
  g.deleteAttribute('uv'); g.deleteAttribute('normal');
  return mergeVertices(g);
}
// hoodoo-like spire: bulging profile, noisy cross-section, eroded ledges every ~7 m of height
function spireGeometry(seed, lean) {
  const g = weld(new THREE.CylinderGeometry(1, 1, 1, 30, 52, false));
  g.translate(0, 0.5, 0);
  const p = g.attributes.position;
  const col = new Float32Array(p.count * 3);
  for (let v = 0; v < p.count; v++) {
    const x = p.getX(v), y = p.getY(v), z = p.getZ(v);
    const a = Math.atan2(z, x), ca = Math.cos(a), sa = Math.sin(a);
    const prof = lerp(1, 0.55, y) + 0.1 * Math.sin(y * 5 + seed) + 0.06 * Math.sin(y * 13 + seed * 2) + (y > 0.93 ? -0.2 : 0);
    const big = 0.68 + 0.64 * vnoise(ca * 1.6 + seed * 3.1, y * 5 + sa * 1.6);
    const fine = (vnoise(ca * 4.5 + seed, y * 26 + sa * 4.5) - 0.5) * 0.14;
    const fr = (y * 120 / 7 + vnoise(ca + seed, sa) * 0.6) % 1;
    const ledge = smooth(0.7, 0.95, fr) * 0.05;
    const sc = prof * big * (1 + fine - ledge);
    p.setXYZ(v, x * sc + lean * y * y, y, z * sc);
    strata(y * 120, seed * 40, _col);
    col.set([_col.r, _col.g, _col.b], v * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}
function lumpGeometry(seed, detail = 4) {
  const g = weld(new THREE.IcosahedronGeometry(1, detail));
  const p = g.attributes.position, col = new Float32Array(p.count * 3);
  const rr = rng(Math.floor(seed * 1000) + 7), planes = [];
  for (let k = 0; k < 9; k++) {           // fracture planes give the rock flat faces and edges
    const n = new THREE.Vector3(rr() - 0.5, (rr() - 0.5) * 0.8, rr() - 0.5).normalize();
    planes.push([n, 0.62 + rr() * 0.3]);
  }
  const d = new THREE.Vector3();
  for (let v = 0; v < p.count; v++) {
    const x = p.getX(v), y = p.getY(v), z = p.getZ(v);
    let k = 0.75 + 0.5 * vnoise(x * 1.7 + seed, z * 1.7 + y * 1.3) + 0.14 * (vnoise(x * 5 + y * 3 + seed, z * 5 - y * 2) - 0.5);
    d.set(x, y, z).normalize();
    for (const [n, h] of planes) { const c = d.dot(n); if (c > 0.05) k = Math.min(k, h / c + 0.03 * vnoise(x * 9 + seed, z * 9)); }
    const fy = y < -0.35 ? -0.35 + (y + 0.35) * 0.3 : y;      // flattened where it sits in the sand
    p.setXYZ(v, x * k, fy * k * 0.75, z * k);
    strata(y * 18 + 10, seed * 13, _col);
    col.set([_col.r, _col.g, _col.b], v * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}
// many copies of a few shapes -> one InstancedMesh per shape (fallback when rocks.glb is missing)
function instanced(geos, mat, list) {
  geos.forEach((geo, gi) => {
    const mine = list.filter((it) => it.g % geos.length === gi);
    if (!mine.length) return;
    const im = new THREE.InstancedMesh(geo, mat, mine.length);
    mine.forEach((it, n) => im.setMatrixAt(n, it.mOld || it.m));
    im.computeBoundingSphere();
    im.castShadow = im.receiveShadow = true;
    im.userData.rock = true;
    scene.add(im);
  });
}
const _m4p = new THREE.Vector3(), _m4s = new THREE.Vector3(), _m4q = new THREE.Quaternion(), _m4e = new THREE.Euler();
const mtx = (x, y, z, rx, ry, rz, sx, sy, sz) => new THREE.Matrix4().compose(_m4p.set(x, y, z), _m4q.setFromEuler(_m4e.set(rx, ry, rz)), _m4s.set(sx, sy, sz));
// Placement (and the colliders) is decided here; the meshes are built once rocks.glb has loaded
// (models/world/build_rocks.py): spires and boulders as instanced levels of detail, talus piles
// at the feet of the spires, buttes on the horizon and the arch over the track.
const ROCKS = { spires: [], boulders: [], talus: [], mesas: [], arch: null, lods: [], scatter: [], tick: 0 };
const CLIFF_AO = { scale: 1 / 12, chroma: 0.35, contrast: 1.1, rough: [0.62, 0.35], varnish: 1, foot: 3, ao: true };
const rockMatAO = rockMaterial(Q, ROCKL.cliff, CLIFF_AO);
// the same surface for the single meshes (arch, bridge): a material drawn by both instanced and
// plain meshes makes three.js switch shader programs at every switch between them
const rockMatAOSolo = rockMaterial(Q, ROCKL.cliff, CLIFF_AO);
const BOULDER_AO = { scale: 1 / 6, chroma: 0.45, contrast: 1.05, rough: [0.6, 0.35], foot: 1.2, ao: true };
const boulderMatAO = rockMaterial(Q, ROCKL.boulder, BOULDER_AO);
const mesaMatAO = rockMaterial(Q, ROCKL.cliff, { scale: 1 / 40, chroma: 0.3, normal: 0.6, macro: 0.4, varnish: 1, foot: 14, ao: true });
{
  const rand = rng(1999);
  const place = (x, z, h, r, gi, near) => {
    const y = groundQuery(x, z) - 3, ry = rand() * TAU, s = r / 15;
    ROCKS.spires.push({ g: gi, x, y: y + h * 0.5, z, r: h * 0.5, m: mtx(x, y, z, 0, ry, 0, s, h / 100, s * (0.85 + rand() * 0.3)),
      mOld: mtx(x, y, z, 0, ry, 0, r, h, r) });
    COLLIDERS.push({ x, z, r: r * 0.9 });
    // fallen blocks piled against the foot of the spires near the track
    if (near) for (let k = 0, n = 1 + Math.floor(rand() * 2.2); k < n; k++) {
      const a = rand() * TAU, d = r * (0.95 + rand() * 0.35), tx = x + Math.cos(a) * d, tz = z + Math.sin(a) * d;
      const ts = clamp(r / 9, 0.8, 2.6) * (0.7 + rand() * 0.5), ty = groundQuery(tx, tz);
      ROCKS.talus.push({ g: ROCKS.talus.length, x: tx, y: ty, z: tz, r: ts * 6, m: mtx(tx, ty - 0.4 * ts, tz, 0, rand() * TAU, 0, ts, ts * (0.8 + rand() * 0.4), ts) });
    }
  };
  // a signature cluster you see when leaving the arena
  [[540, -215, 150, 22], [610, -300, 115, 17], [455, -310, 95, 15], [700, -390, 70, 12]].forEach(([x, z, h, r], k) => {
    nearestCoarse(x, z, _nc);
    if (_nc.d > TR.hw[Math.max(_nc.i, 0)] + 30) place(x, z, h, r, k, true);
  });
  let placed = 0, tries = 0;
  while (placed < 70 && tries++ < 3000) {
    const x = 90 + (rand() - 0.5) * 3600, z = -690 + (rand() - 0.5) * 3200;
    nearestCoarse(x, z, _nc);
    if (_nc.i >= 0 && (_nc.d < TR.hw[_nc.i] + 45 || TR.canyon[_nc.i] > 0.05)) continue;
    const near = _nc.i >= 0;
    const h = near ? 40 + rand() * 90 : 60 + rand() * 140;
    place(x, z, h, h * (0.12 + rand() * 0.06), placed + 4, near && _nc.d < 320);
    placed++;
  }

  // boulders near the racing line (open sections only)
  for (let k = 0; k < 140; k++) {
    const i = Math.floor(rand() * TR.N);
    if (TR.arena[i] > 0.05 || TR.canyon[i] > 0.05) continue;
    const side = rand() < 0.5 ? -1 : 1, o = TR.hw[i] + 12 + rand() * 70, r = 1.5 + rand() * rand() * 7;
    const x = TR.px[i] - TR.tz[i] * side * o, z = TR.pz[i] + TR.tx[i] * side * o, gy = groundQuery(x, z);
    const rx = (rand() - 0.5) * 0.5, ry = rand() * TAU, rz = (rand() - 0.5) * 0.5;
    ROCKS.boulders.push({ g: k, x, y: gy, z, r, m: mtx(x, gy + r * 0.05, z, rx, ry, rz, r, r, r), mOld: mtx(x, gy + r * 0.12, z, rx, ry, rz, r, r, r) });
    COLLIDERS.push({ x, z, r: r * 0.85 });
  }
  // blocks fallen from the canyon walls, lying against their feet (the walls already stop the pods)
  const cr = rangeWhere(TR.canyon, 0.5);
  if (cr) for (let k = cr[0]; k <= cr[1]; k += 8 + Math.floor(rand() * 10)) {
    const i = TR.idx(k), side = rand() < 0.5 ? -1 : 1, o = TR.hw[i] + 2.5 + rand() * 2.5;
    const x = TR.px[i] - TR.tz[i] * side * o, z = TR.pz[i] + TR.tx[i] * side * o, y = TR.py[i] - 0.35;
    if (rand() < 0.55) {
      const ts = 0.8 + rand();
      ROCKS.talus.push({ g: ROCKS.talus.length, x, y, z, r: ts * 6, m: mtx(x, y - 0.3 * ts, z, 0, rand() * TAU, 0, ts, ts * (0.7 + rand() * 0.5), ts) });
    } else {
      const r = 1 + rand() * 2.2, rx = (rand() - 0.5) * 0.4, ry = rand() * TAU, rz = (rand() - 0.5) * 0.4;
      ROCKS.boulders.push({ g: ROCKS.boulders.length, x, y, z, r, m: mtx(x, y + r * 0.05, z, rx, ry, rz, r, r, r), mOld: mtx(x, y + r * 0.12, z, rx, ry, rz, r, r, r) });
    }
  }

  // buttes on the horizon
  for (let k = 0; k < 18; k++) {
    const a = (k / 18) * TAU + rand() * 0.25, d = 2300 + rand() * 900;
    const w = 250 + rand() * 450, H = 120 + rand() * 230, asp = 0.5 + rand() * 0.5, ry = rand() * TAU;
    const x = 90 + Math.cos(a) * d, z = -690 + Math.sin(a) * d;
    ROCKS.mesas.push({ g: k, x, z, w, H, asp, ry, m: mtx(x, groundQuery(x, z) - 6, z, 0, ry, 0, w / 330, H / 200, w / 330 * (0.6 + asp * 0.6)) });
  }

  // the natural arch over the track: a sandstone fin with the opening cut through it
  const ai = TR.idx(Math.round(TR.N * (TR.ctrlS[13] + 25) / TR.L));
  ARCH.x = TR.px[ai]; ARCH.z = TR.pz[ai];
  const sx = clamp((TR.hw[ai] + 11) / 30, 0.9, 1.4);
  ROCKS.arch = { i: ai, sx, x: TR.px[ai], y: TR.py[ai] - 2, z: TR.pz[ai], yaw: TR.yaw[ai] };
  for (const side of [-1, 1]) for (const xo of [37, 47, 57, 66, 74]) {
    COLLIDERS.push({ x: TR.px[ai] - TR.tz[ai] * side * xo * sx, z: TR.pz[ai] + TR.tx[ai] * side * xo * sx, r: 11 });
  }
}

function buildRockVisuals(models) {
  const lod = (prefix, n, levels) => Array.from({ length: n }, (_, k) => Array.from({ length: levels }, (_, l) => models.get(`${prefix}${k}_lod${l}`)));
  // (?gfx=geo:1: the spires one level of detail up, rocks_spires_hi.glb, and switching half as far again)
  const far = Q.geo ? 1.5 : 1;
  ROCKS.lods.push(new LodInstances(scene, lod('spire', 8, 3), rockMatAO, ROCKS.spires, [380 * Q.lod * far, 1400 * Q.lod * far]));
  ROCKS.lods.push(new LodInstances(scene, lod('boulder', 6, 2), boulderMatAO, ROCKS.boulders, [160 * Q.lod]));
  ROCKS.lods.push(new LodInstances(scene, lod('talus', 2, 2), boulderMatAO, ROCKS.talus, [180 * Q.lod]));
  // buttes: one instanced mesh per shape, no detail levels (they are always kilometres away)
  for (let v = 0; v < 4; v++) {
    const mine = ROCKS.mesas.filter((it) => it.g % 4 === v);
    const im = new THREE.InstancedMesh(models.get(`mesa${v}`), mesaMatAO, mine.length);
    mine.forEach((it, n) => im.setMatrixAt(n, it.m));
    im.computeBoundingSphere();
    im.receiveShadow = true;
    im.userData.rock = true;
    scene.add(im);
  }
  const A = ROCKS.arch, arch = new THREE.LOD();
  A.matrix = new THREE.Matrix4().compose(new THREE.Vector3(A.x, A.y, A.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), A.yaw), new THREE.Vector3(A.sx, 1, 1));
  [0, 1].forEach((l) => {
    const m = new THREE.Mesh(models.get(`arch_lod${l}`), rockMatAOSolo);
    m.castShadow = m.receiveShadow = true;
    m.userData.rock = true;
    arch.addLevel(m, l ? 900 : 0);
  });
  arch.position.set(A.x, A.y, A.z);
  arch.rotation.y = A.yaw;
  arch.scale.set(A.sx, 1, 1);
  scene.add(arch);
  ROCKS.archMesh = arch;
  if (CANYON_BRIDGE) {
    const b = CANYON_BRIDGE;
    b.geometry.dispose();
    b.geometry = models.get('bridge');
    b.material = rockMatAOSolo;
    b.scale.set(b.userData.span / 76, 1, 1);
  }
}

// The rocks a pod can reach, into the solid field (F2), with the geometry they are drawn with: geo(kind, item) for
// kind spire / boulder / talus / arch (null: not drawn), mtxOf(item) its matrix. From rocks.glb that is the base
// models' finest level, never ?gfx=geo:1's spires, so the physics is the same on every preset.
function addRockSolids(geo, mtxOf = (it) => it.m) {
  const t0 = performance.now();
  const near = (it, r) => { nearestCoarse(it.x, it.z, _nc); return _nc.i >= 0 && _nc.d - r < TR.hw[_nc.i] + 160; };
  const add = (kind, it, r) => { if (!near(it, r)) return; const g = geo(kind, it); if (g) SOLID.addMesh(g, mtxOf(it)); };
  for (const it of ROCKS.spires) add('spire', it, it.r * 0.6);
  for (const it of ROCKS.boulders) add('boulder', it, it.r * 2);
  for (const it of ROCKS.talus) add('talus', it, it.r);
  const A = ROCKS.arch, ag = A && geo('arch', A);
  if (ag) SOLID.addMesh(ag, A.matrix);
  const S = SOLID.stats;
  console.log(`HOMOKFUTAM: solid field: ${S.patches} rock patches, ${(S.cells / 1e6).toFixed(2)}M cells, ${S.tris} triangles near the band, ${Math.round(performance.now() - t0)} ms`);
}
const ROCK_VARIANTS = { spire: 8, boulder: 6, talus: 2 };

// the old procedural shapes, if rocks.glb can't be loaded
function buildRockFallback() {
  const rand = rng(77);
  const spireGeos = Array.from({ length: 8 }, (_, k) => spireGeometry(k * 1.7 + 0.3, (rand() - 0.5) * 0.25));
  const lumps = [lumpGeometry(1), lumpGeometry(2.5), lumpGeometry(4.2)];
  instanced(spireGeos, rockMatI, ROCKS.spires);
  instanced(lumps, boulderMat, ROCKS.boulders);
  const mesas = ROCKS.mesas.map((it, k) => {
    const g = weld(new THREE.CylinderGeometry(1, 1.25, 1, 56, 16));
    const p = g.attributes.position, col = new Float32Array(p.count * 3);
    for (let v = 0; v < p.count; v++) {
      const x = p.getX(v), y = p.getY(v) + 0.5, z = p.getZ(v), ang = Math.atan2(z, x);
      const sc = 0.8 + 0.4 * vnoise(Math.cos(ang) * 2 + k, Math.sin(ang) * 2);
      p.setXYZ(v, x * sc, y, z * sc);
      strata(y * it.H * 0.5, k * 17, _col);
      col.set([_col.r, _col.g, _col.b], v * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.scale(it.w * 0.6, it.H, it.w * 0.6 * it.asp);
    g.rotateY(it.ry);
    g.translate(it.x, -25, it.z);
    return g;
  });
  const mg = mergeGeometries(mesas);
  mg.computeVertexNormals();
  const mesaMesh = new THREE.Mesh(mg, rockMaterial(Q, ROCKL.cliff, { scale: 1 / 40, chroma: 0.3, normal: 0.6, macro: 0.4, varnish: 1, foot: 12 }));
  mesaMesh.receiveShadow = true;
  mesaMesh.userData.rock = true;
  scene.add(mesaMesh);
  const A = ROCKS.arch, R = TR.hw[A.i] + 14;
  const ag = weld(new THREE.TorusGeometry(R, 7, 26, 90, Math.PI));
  const ap = ag.attributes.position, acol = new Float32Array(ap.count * 3);
  for (let v = 0; v < ap.count; v++) {
    const x = ap.getX(v), y = ap.getY(v), z = ap.getZ(v), n = vnoise(x * 0.12 + 3, y * 0.12 + z * 0.1) - 0.5;
    ap.setXYZ(v, x * (1 + n * 0.12), y * (1 + n * 0.1), z * (1.4 + n * 0.6));
    strata(y, 900, _col); acol.set([_col.r, _col.g, _col.b], v * 3);
  }
  ag.setAttribute('color', new THREE.BufferAttribute(acol, 3));
  ag.computeVertexNormals();
  const arch = new THREE.Mesh(ag, rockMat);
  arch.position.set(A.x, A.y - 2, A.z);
  arch.rotation.y = A.yaw;
  arch.castShadow = arch.receiveShadow = true;
  arch.userData.rock = true;
  scene.add(arch);
  ROCKS.archMesh = arch;
  arch.updateMatrix();
  A.matrix = arch.matrix.clone();
  try { addRockSolids((kind, it) => kind === 'spire' ? spireGeos[it.g % 8] : kind === 'boulder' ? lumps[it.g % 3] : kind === 'arch' ? ag : null, (it) => it.mOld || it.m); }
  catch (e) { console.warn('HOMOKFUTAM: solid field (rocks) failed', e); }
}
let PROPS_MODELS = null;          // assets/world/props.glb: ground clutter, placed at boot (needs the macro map)
const PROPS_READY = loadRockModels(new URL('./assets/world/props.glb', import.meta.url).href).then((m) => { PROPS_MODELS = m; })
  .catch((e) => console.warn('HOMOKFUTAM: props failed, no ground clutter', e));
// assets/world/course.glb: the trackside markers and the spectators' camps (E4, E5), placed at boot
let COURSE_MODELS = null, LANDMARK_MODELS = null;
const COURSE_READY = Q.markers || Q.camps ? loadRockModels(COURSE_URL).then((m) => { COURSE_MODELS = m; }).catch((e) => console.warn('HOMOKFUTAM: course props failed', e)) : Promise.resolve();
// assets/world/landmark.glb: the wreck in the dunes (E6), placed at boot
const LANDMARK_READY = Q.landmark ? loadRockModels(LANDMARK_URL).then((m) => { LANDMARK_MODELS = m; }).catch((e) => console.warn('HOMOKFUTAM: landmark failed', e)) : Promise.resolve();
const ROCKS_READY = Promise.all([loadRockModels(), Q.geo && loadRockModels(new URL('./assets/world/rocks_spires_hi.glb', import.meta.url).href)
  .catch((e) => { console.warn('HOMOKFUTAM: detailed spires failed, using the regular ones', e); return null; })])
  .then(([models, hi]) => {
    const base = new Map(models);
    if (hi) for (const [k, g] of hi) models.set(k, g);
    buildRockVisuals(models);
    try { addRockSolids((kind, it) => base.get(kind === 'arch' ? 'arch_lod0' : `${kind}${it.g % ROCK_VARIANTS[kind]}_lod0`)); }
    catch (e) { console.warn('HOMOKFUTAM: solid field (rocks) failed', e); }
  }).catch((e) => {
  console.warn('HOMOKFUTAM: rock models failed, using the simple shapes', e);
  buildRockFallback();
});

// ============================================================
//  Dressing: crowd, flags, screens, power line, ruins, life (world/dressing.js)
// ============================================================
let HORIZON = null;
const DRESS = buildDressing({ scene, TR, Q, groundQuery, nearestCoarse, rangeWhere, rng, fbm, vnoise, triplanarMaterial, mergeGeometries,
  stoneMat: AM(ARENA.stone, { vertexColors: false, color: '#e9dcc6', foot: 1.5 }) });
buildHorizon(scene, renderer).then((h) => { HORIZON = h; for (const m of DRESS.mountains || []) m.visible = false; })
  .catch((e) => console.warn('HOMOKFUTAM: horizon panorama failed, keeping the simple ridges', e));

// ============================================================
//  Pod model: two engines joined by an energy beam, cables, cockpit
// ============================================================
// local frame: +z forward, +x left (three.js: rotation.y = yaw maps +z to heading)
const metalDark = new THREE.MeshStandardMaterial({ color: '#2e2a27', metalness: 0.7, roughness: 0.45 });
const metalLight = new THREE.MeshStandardMaterial({ color: '#9c968e', metalness: 0.8, roughness: 0.35 });
const cableMat = new THREE.MeshStandardMaterial({ color: '#1d1a18', roughness: 0.6 });
// one mesh per material for the meshes directly under a group (they never move on their own)
function mergeChildren(group) {
  const byMat = new Map();
  for (const o of group.children) if (o.isMesh) { if (!byMat.has(o.material)) byMat.set(o.material, []); byMat.get(o.material).push(o); }
  for (const [mat, list] of byMat) {
    if (list.length < 2) continue;
    const geo = mergeGeometries(list.map((o) => { o.updateMatrix(); return o.geometry.clone().applyMatrix4(o.matrix); }));
    if (!geo) continue;
    for (const o of list) group.remove(o);
    group.add(new THREE.Mesh(geo, mat));
  }
}
function buildEngine(paint, hot) {
  const e = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.72, 5.2, 18), paint);
  body.rotation.x = Math.PI / 2;
  const intake = new THREE.Mesh(new THREE.CylinderGeometry(0.78, 0.66, 0.9, 18, 1, true), metalDark);
  intake.rotation.x = Math.PI / 2; intake.position.z = 3.0;
  const spike = new THREE.Mesh(new THREE.ConeGeometry(0.42, 1.6, 14), metalLight);
  spike.rotation.x = Math.PI / 2; spike.position.z = 3.5;
  const band1 = new THREE.Mesh(new THREE.CylinderGeometry(0.76, 0.76, 0.35, 18), metalDark);
  band1.rotation.x = Math.PI / 2; band1.position.z = 1.2;
  const band2 = band1.clone(); band2.position.z = -1.2;
  const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.55, 0.8, 18, 1, true), hot);
  nozzle.rotation.x = Math.PI / 2; nozzle.position.z = -3.0;
  e.add(body, intake, spike, band1, band2, nozzle);
  // split air-brake vanes
  for (const s of [-1, 1]) {
    const vane = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.1, 2.2), paint);
    vane.position.set(0, s * 0.95, -0.4);
    e.add(vane);
  }
  const fin = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.08, 1.6), metalDark);
  fin.position.set(0, 0, -1.9);
  e.add(fin);
  mergeChildren(e);
  return e;
}
// the emitter flares of all beams, and the flame glows at all nozzles, one draw each (gfx/fxbatch.js)
const BEAM_FLARES = createBeamFlares(scene);
const FLAMES = new FxBatch(scene, new THREE.PlaneGeometry(1, 1), GPU ? N.flameGlowMaterial(TEX.glow) : new THREE.ShaderMaterial({
  uniforms: { map: { value: TEX.glow } },
  vertexShader: /* glsl */`
    attribute vec3 aCol;
    varying vec2 vUv; varying vec3 vCol;
    void main() {
      vUv = uv; vCol = aCol;
      vec4 mv = modelViewMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 );
      mv.xy += position.xy * vec2( length( instanceMatrix[ 0 ].xyz ), length( instanceMatrix[ 1 ].xyz ) );   // a camera-facing sprite
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D map;
    varying vec2 vUv; varying vec3 vCol;
    void main() {
      vec4 t = texture2D( map, vUv );
      gl_FragColor = vec4( vCol * t.rgb, t.a );
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
}), 24, { aCol: 3 }, 0, { billboard: true });
// after every racer's racerFx: upload the effect batches
function endFxFrame() {
  podFx.endFrame();
  BEAM_FLARES.flush();
  FLAMES.flush();
}
// energy beam (gfx/beam.js) between the emitter tips (body space, engines at rest)
function addBeam(body, engines, tips) {
  const beam = createBeam({ hdr: Q.post ? 1 : 0.45, flares: BEAM_FLARES });
  body.add(beam.group);
  beam.bind(engines, tips);
  return beam;
}
function buildPod(color, accent) {
  const hot = metalDark.clone();   // nozzles: glow red as the engines heat up
  hot.emissive.set('#ff4a10');
  hot.emissiveIntensity = 0;
  const paint = new THREE.MeshStandardMaterial({ color, metalness: 0.35, roughness: 0.42 });
  const trim = new THREE.MeshStandardMaterial({ color: accent, metalness: 0.3, roughness: 0.5 });
  const root = new THREE.Group();
  const body = new THREE.Group();   // banks and bobs
  root.add(body);
  const engines = [];
  for (const s of [1, -1]) {
    const e = buildEngine(paint, hot);
    e.position.set(s * 1.75, 0.15, 5.4);
    body.add(e); engines.push(e);
    addFlame(e, new THREE.Vector3(0, 0, -3.5));
  }
  // cockpit tub
  const cockpit = new THREE.Group();   // swings on its cables behind the engines (racerFx)
  body.add(cockpit);
  const tub = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), paint);
  tub.scale.set(1.05, 0.62, 2.0);
  tub.position.set(0, 0, -2.2);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.75, 1.6, 16), trim);
  nose.rotation.x = Math.PI / 2; nose.position.set(0, -0.05, -0.1); nose.scale.set(1, 1, 0.55);
  const seat = new THREE.Mesh(new THREE.SphereGeometry(0.66, 14, 8, 0, TAU, 0, Math.PI / 2), metalDark);
  seat.scale.set(1, 0.5, 1.2); seat.position.set(0, 0.42, -2.5);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 8), new THREE.MeshStandardMaterial({ color: '#5b4632', roughness: 0.7 }));
  head.position.set(0, 0.72, -2.55);
  const goggles = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.1, 0.12), metalLight);
  goggles.position.set(0, 0.78, -2.3);
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(2.12, 0.08, 0.5), trim);
  stripe.position.set(0, 0.02, -3.3);
  for (const s of [-1, 1]) {
    const wing = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.08, 1.4), paint);
    wing.position.set(s * 1.25, -0.08, -3.0); wing.rotation.z = s * 0.25;
    cockpit.add(wing);
  }
  cockpit.add(tub, nose, seat, head, goggles, stripe);
  // steering cables from cockpit to engines
  for (const s of [1, -1]) {
    const curve = new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(s * 0.45, 0.1, -0.6), new THREE.Vector3(s * 1.2, -0.25, 1.3), new THREE.Vector3(s * 1.75, 0.05, 2.6));
    body.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 10, 0.06, 5), cableMat));
  }
  mergeChildren(cockpit);
  mergeChildren(body);
  body.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  const beam = addBeam(body, engines, [new THREE.Vector3(1.0, 0.15, 6.7), new THREE.Vector3(-1.0, 0.15, 6.7)]);
  root.userData = { body, engines, beam, hot, cockpit, dynamic: true };
  return root;
}
// the flame glow at a nozzle: an anchor for the FLAMES batch (size = its scale)
function addFlame(engine, pos) {
  const flame = new THREE.Object3D();
  flame.position.copy(pos);
  flame.userData.col = new THREE.Color('#ffb066');
  engine.add(flame); engine.userData.flame = flame;
}

// ============================================================
//  Particles (gfx/particles.js) and pod effects (gfx/podfx.js)
// ============================================================
// ?gfx=parts:1 (docs/visual-next-steps.md C10): half as many again of every pool and emission rate
const PQ = Q.particles * (Q.parts ? 1.5 : 1);
const DUST = new Particles(scene, { capacity: 2400 * PQ, kind: 'lit', flip: 'smoke', size: [2.2, 9], alpha: 0.2, drag: 1.3, grav: -0.5, color: '#dcb88a' });
const SMOKE = new Particles(scene, { capacity: 400 * PQ, kind: 'lit', flip: 'smoke', size: [1.6, 7.5], alpha: 0.5, drag: 0.7, grav: -3, color: '#5e554d', ambient: '#7a6e62', sun: '#c8b498' });
// simulated fireballs (explosions, backfires): flame emission plus the smoke they roll into
const BLAST = new Particles(scene, { capacity: 120 * PQ, kind: 'fire', size: [2.5, 8], alpha: 1, drag: 1.6, grav: -2.5, color: '#8a7d70', ambient: '#9a8a7a', sun: '#e0c4a0', emit: Q.post ? 1 : 0.5, fadeIn: 0.02 });
const SPARK = new Particles(scene, { capacity: 600 * PQ, kind: 'spark', size: [0.13, 0.1], alpha: 1, drag: 1.1, grav: 24, color: '#ffb35c', stretch: 0.03 });
const FIRE = new Particles(scene, { capacity: 300 * PQ, kind: 'add', size: [1.1, 3.2], alpha: 1, drag: 2.2, grav: -5, color: '#ff7a2e', fadeIn: 0.05 });
const CONFETTI = new Particles(scene, { capacity: 900 * PQ, kind: 'confetti', size: [0.4, 0.4], alpha: 1, drag: 1.8, grav: 4, spin: 14 });
const WIND = new Particles(scene, { capacity: 240, kind: 'spark', size: [0.045, 0.045], alpha: 0.5, drag: 0, grav: 0, color: '#ffe9c8', stretch: 0.03, fadeIn: 0.3 });
const SAND = new Particles(scene, { capacity: 260 * PQ, kind: 'lit', size: [4, 11], alpha: 0.12, drag: 0.15, grav: 0, color: '#e6c597', fadeIn: 0.4 });
// ?gfx=parts:1: sand streaming low across the track in the wind at speed (thin streaks, a few at a time)
const STREAM = Q.parts ? new Particles(scene, { capacity: 700, kind: 'spark', size: [0.11, 0.06], alpha: 0.3, drag: 0.4, grav: 0.6, color: '#f0d6ab', stretch: 0.12, fadeIn: 0.15 }) : null;
// ?gfx=drift:1 (E1): the gust's sheet of sand over the drift stretches, low and wide, and the puffs off the berms
const DRIFTP = DRIFT.length ? new Particles(scene, { capacity: 420 * PQ, kind: 'lit', size: [2, 7], alpha: 0.12, drag: 0.2, grav: 0.15, color: '#e6c597', fadeIn: 0.3 }) : null;
function emit(pool, x, y, z, vx, vy, vz, life, p) { pool.emit(x, y, z, vx, vy, vz, life, p); }
const POOLS = [DUST, SMOKE, SPARK, FIRE, CONFETTI, WIND, SAND, BLAST, ...(STREAM ? [STREAM] : []), ...(DRIFTP ? [DRIFTP] : [])];
loadFlipbooks().catch((e) => console.warn('HOMOKFUTAM: particle flipbooks failed to load, using plain puffs', e));
heatLayer = Q.post && Q.heat ? new HeatLayer() : null;
const podFx = createPodFx(scene, heatLayer, {
  volume: Q.post, steps: Q.name === 'ultra' ? 18 : Q.name === 'high' ? 14 : 10, hdr: Q.post ? 1 : 0.6,
  emit: {
    fire: (...a) => FIRE.emit(...a), smoke: (...a) => SMOKE.emit(...a), blast: (...a) => BLAST.emit(...a), spark: (...a) => SPARK.emit(...a),
  },
  event(kind, r) {
    if (kind !== 'backfire') return;
    const d = Math.hypot(r.x - player.x, r.z - player.z);
    if (d < 120) sfx('backfire', (1 - d / 120) * (r === player ? 1 : 0.7));
    if (r === player) shake = Math.max(shake, 0.18);
  },
});
const TRAILS = createTrailMap(renderer, TR.L);
TRACK_MESH.material.userData.uniforms.kTrail.value = TRAILS.texture;
TRACK_MESH.material.userData.uniforms.kTrailOn.value = 1;
const DEBRIS = createDebris(scene, [new THREE.IcosahedronGeometry(1, 0)], boulderMat, Math.round(90 * PQ));
// torn panels (tinted with the pod's paint) and dark mechanical bits; some trail smoke as they tumble
const METAL = createDebris(scene, [new THREE.BoxGeometry(1, 0.04, 0.6)], new THREE.MeshStandardMaterial({ color: '#ffffff', metalness: 0.55, roughness: 0.5 }), Math.round(70 * PQ), {
  trail(x, y, z, k) {
    if (Math.random() < 0.45) emit(SMOKE, x, y, z, 0, 1.5, 0, 0.7 + Math.random() * 0.4, { size0: 0.4, size1: 2, alpha: 0.3 * k });
    if (Math.random() < 0.12 * k) emit(FIRE, x, y, z, 0, 1, 0, 0.18, { bright: 2.5, size0: 0.35, size1: 0.8 });
  },
});
// models/fx/build_debris.py: Rock0-3 (1 m across: doubled to match the icosahedron), Shard0-3, Bit0-2
new GLTFLoader().loadAsync(new URL('./assets/fx/debris.glb', import.meta.url).href).then((g) => {
  const geo = (n) => g.scene.getObjectByName(n)?.geometry;
  const rocks = [0, 1, 2, 3].map((i) => geo('Rock' + i)?.clone().scale(2, 2, 2)).filter(Boolean);
  const metal = ['Shard0', 'Shard1', 'Shard2', 'Shard3', 'Bit0', 'Bit1', 'Bit2'].map(geo);
  if (rocks.length) DEBRIS.setGeometries(rocks);
  if (metal.every(Boolean)) METAL.setGeometries(metal);
}).catch((e) => console.warn('HOMOKFUTAM: debris models failed to load, using plain shapes', e));

// ============================================================
//  Racers and physics
// ============================================================
// Liveries. Humans take them from the front (the host gets orange), bots fill the rest.
const ROSTER = [
  { name: 'Te', color: '#e8772e', accent: '#f4ece0' },
  { name: 'Zeb Kurr', color: '#2f6fd0', accent: '#f1ebe0' },
  { name: 'Mira Tal', color: '#c8342c', accent: '#2b2522' },
  { name: 'Odo Rakk', color: '#3c8f6a', accent: '#e2b93b' },
  { name: 'Vex Sallo', color: '#e2b93b', accent: '#2b2522' },
  { name: 'Bilu Fenn', color: '#7a4fc0', accent: '#d9d2c4' },
];
const SOLO_GRID = [4, 0, 1, 2, 3, 5];   // grid slot per livery in a solo race
const SKILL = [0.846, 0.923, 0.976];
const HOVER = 1.55, POD_R = 3.0;
const racers = ROSTER.map((d, n) => {
  const mesh = buildPod(d.color, d.accent);
  scene.add(mesh);
  return {
    ...d, n, mesh, baseMesh: mesh, player: n === 0,
    // ctl: 'local' = this player, 'bot' = AI simulated here, 'net' = driven by network states
    ctl: n === 0 ? 'local' : 'bot', owner: n === 0 ? 'me' : null, grid: SOLO_GRID[n], gone: false, left: false, net: null,
    x: 0, y: 0, z: 0, yaw: 0, vx: 0, vz: 0, vy: 0, fwd: 0, lat: 0,
    steer: 0, throttle: 0, brake: 0, boostIn: false, boosting: false, heat: 0, overheat: 0,
    yawRate: 0, slideIn: false, slide: 0, slip: 0, cooling: 0, draft: 0, gust: 0, edge: 0, wallCD: 0, swing: 0, swingV: 0,
    // the pod model and its hull (F1; every racer flies pod_player for now), the spin a hit gives it (F3)
    model: 'pod_player', hull: DEFAULT_HULL, spin: 0, broken: 0, kr: 0, krv: 0, kp: 0, kpv: 0,
    loc: { i: 0 }, lap: -1, prog: 0, maxLap: 0, lapStart: 0, lapTimes: [], finished: false, finishTime: 0,
    roll: 0, pitch: 0, off: 0, wrong: 0, skill: 1, aiOff: 0, aiOffT: 0, aiBoost: false, phase: n * 1.37,
  };
});
let player = racers[0];

// ============================================================
//  Detailed pods: models/pod/*.py -> assets/pod_player.glb
// ============================================================
// Loads in the background; until then, or if it fails, everyone races the simple pod. Each racer
// gets its own copy in its own livery (the LOW preset keeps the simple pod for the rivals). The
// copies keep buildPod()'s userData contract, so racerFx() drives them the same way and also
// animates their moving parts.
// Ray-traced reflections on the pods (?gfx=rtr:1, ULTRA, WebGPU only; docs/visual-next-steps.md D9): in place of
// the live cube (refl). The BVH is built in a worker while the game boots (rtStart, awaited before the pipelines
// compile); every detailed pod's materials take the hook, and only the player's pod traces (pod.rtOn).
const RTR = GPU && !!Q.rtr;
if (RTR) Q.refl = false;
let RT = null;
function rtAttach(pod) {
  if (!RT || pod.rtOn) return;
  pod.rtOn = U(0);
  for (const m of pod.mats) {
    if (!m.isMeshStandardNodeMaterial || m.transparent) continue;
    if (Q.rtr >= 2) { m.roughness = 0.02; m.metalness = 1; m.roughnessMap = m.metalnessMap = null; }      // (debug: a mirror)
    N.podTracedReflections(m, RT, pod.rtOn, Q.rtr >= 2 ? Q.rtr : 0);
  }
}
// the static world near the track, without the ground, into the worker
function rtStart() {
  const t0 = performance.now();
  // a corridor 180 m either side of the track (8 m cells): pods only ever see what is near it
  const B = WORLD_BOUNDS, cell = 8, gw = Math.ceil((B.max.x - B.min.x) / cell), gh = Math.ceil((B.max.z - B.min.z) / cell);
  const near = new Uint8Array(gw * gh), reach = Math.ceil(180 / cell);
  for (let i = 0; i < TR.N; i += 2) {
    const cx = Math.floor((TR.px[i] - B.min.x) / cell), cz = Math.floor((TR.pz[i] - B.min.z) / cell);
    for (let dz = -reach; dz <= reach; dz++) for (let dx = -reach; dx <= reach; dx++) {
      const x = cx + dx, z = cz + dz;
      if (x >= 0 && z >= 0 && x < gw && z < gh && dx * dx + dz * dz <= reach * reach) near[z * gw + x] = 1;
    }
  }
  const keep = (x, y, z) => { const cx = Math.floor((x - B.min.x) / cell), cz = Math.floor((z - B.min.z) / cell); return cx >= 0 && cz >= 0 && cx < gw && cz < gh && near[cz * gw + cx] === 1; };
  for (const l of ROCKS.lods) l.force(1);
  const geo = collectStatic(scene, WORLD_BOUNDS, null, { skip: (o) => o.userData.terrain || o.userData.track, keep });
  for (const l of ROCKS.lods) l.update(camera.position);
  const tCollect = performance.now() - t0;
  return new Promise((resolve) => {
    const w = new Worker(new URL('./gfx/bvh.worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => {
      w.terminate();
      try { RT = N.createReflections(e.data); } catch (err) { console.warn('HOMOKFUTAM: ray-traced reflections failed', err); }
      console.log(`HOMOKFUTAM: ray tracing: ${e.data.triCount} triangles (collected in ${Math.round(tCollect)} ms, BVH ${Math.round(e.data.ms)} ms in a worker)`);
      resolve(RT);
    };
    w.onerror = (e) => { w.terminate(); console.warn('HOMOKFUTAM: BVH worker failed', e.message); resolve(null); };
    w.postMessage({ tris: geo.tris, alb: geo.alb }, [geo.tris.buffer, geo.alb.buffer]);
  });
}
// every frame: who traces, and the other pods as boxes in the reflections
const RT_BOX = { hull: [1.05, 0.7, 2.1], engine: [0.9, 0.9, 4.2] };
const _rtM = new THREE.Matrix4(), _rtT = new THREE.Matrix4(), _rtList = [], _rtCols = new Map();
function rtUpdate() {
  if (!RT) return;
  _rtList.length = 0;
  for (const r of racers) {
    const pod = r.mesh?.userData?.pod;
    if (!pod) continue;
    if (!pod.rtOn) rtAttach(pod);
    pod.rtOn.value = r === player && !r.gone ? 1 : 0;
    if (r === player || r.gone || !r.mesh.visible) continue;
    let col = _rtCols.get(r);
    if (!col) { col = new THREE.Color(r.color); _rtCols.set(r, col); }
    _rtList.push({ inv: _rtM.copy(pod.body.matrixWorld).multiply(_rtT.makeTranslation(0, 0.1, -2.2)).clone().invert(), half: RT_BOX.hull, color: col });
    for (const e of pod.engines) _rtList.push({ inv: e.matrixWorld.clone().invert(), half: RT_BOX.engine, color: RT_ENGINE });
  }
  RT.setBoxes(_rtList);
}
const RT_ENGINE = new THREE.Color(0.22, 0.2, 0.18);

let podFactory = null;
function wrapDetailedPod(pod) {
  pod.engines.forEach((e, k) => addFlame(e, pod.flames[k]));
  const beam = addBeam(pod.body, pod.engines, pod.beam);
  pod.root.userData = { body: pod.body, engines: pod.engines, beam, pod, cockpit: pod.cockpit, dynamic: true };
  return pod.root;
}
function swapMesh(r, m) {
  if (r.mesh === m) return;
  m.visible = r.mesh.visible;
  m.position.copy(r.mesh.position);
  m.rotation.copy(r.mesh.rotation);
  scene.remove(r.mesh);
  r.mesh = m;
  scene.add(m);
}
function attachDetailPods() {
  if (!podFactory || !player) return;
  for (const r of racers) {
    if (!r.player && !Q.rivals) { swapMesh(r, r.baseMesh); continue; }
    if (!r.detailMesh) r.detailMesh = wrapDetailedPod(podFactory());
    setPodLivery(r.detailMesh.userData.pod, r.color, r.accent);
    // polish (?gfx=gloss:0 for the worn finish as modelled): the player's pod fully, the rivals between 0.55 and 1,
    // fixed per racer
    setPodGloss(r.detailMesh.userData.pod, !Q.gloss ? 0 : r.player ? 1 : 0.55 + 0.45 * ((racers.indexOf(r) * 0.618034) % 1));
    swapMesh(r, r.detailMesh);
  }
}
// (the hull comes with the model: until it is in, the measured default; the boot waits for it, so a race has it)
const POD_READY = loadPodModel(renderer)
  .then((make) => {
    podFactory = make;
    for (const r of racers) if (r.model === 'pod_player') r.hull = make.hull;
    const H = make.hull;
    console.log(`HOMOKFUTAM: pod hull: ${H.caps.length} capsules (${H.source}), reach ${H.reach.toFixed(1)} m, radius of gyration ${Math.sqrt(H.k2).toFixed(2)} m`);
    attachDetailPods();
  })
  .catch((e) => console.warn('HOMOKFUTAM: detailed pod failed to load, using the simple one', e));
const _tp = { x: 0, y: 0, z: 0, yaw: 0, i: 0 };

function placeOnGrid(r, slot) {
  const row = Math.floor(slot / 2), col = slot % 2 ? 1 : -1;
  trackPoint(TR.L - 16 - row * 16, col * 7 + (row % 2 ? 1.5 : -1.5) * col, _tp);
  Object.assign(r, { x: _tp.x, z: _tp.z, y: _tp.y + HOVER, yaw: _tp.yaw, vx: 0, vz: 0, vy: 0, fwd: 0, lat: 0, steer: 0,
    heat: 0, overheat: 0, boosting: false, lap: -1, maxLap: 0, lapTimes: [], finished: false, finishTime: 0, wrong: 0, off: 0,
    yawRate: 0, slideIn: false, slide: 0, slip: 0, draft: 0, wallCD: 0, spin: 0 });
  r.loc.i = _tp.i;
  locate(r.x, r.z, r.loc, true);
  r.prog = r.loc.s - TR.L;
  r.prevS = r.loc.s;
}
function respawn(r) {
  trackPoint(r.loc.s - 12, 0, _tp);
  Object.assign(r, { x: _tp.x, z: _tp.z, y: _tp.y + HOVER + 2, yaw: _tp.yaw, vx: 0, vz: 0, vy: 0, fwd: 0, lat: 0, heat: Math.min(r.heat, 60), yawRate: 0, slide: 0, slip: 0, spin: 0 });
  r.loc.i = _tp.i;
}

// Handling. The stick asks for a yaw rate (r.yawRate follows it within a few hundredths of a second: any more lag and
// keyboard steering starts to weave). The sideways grip follows the slide angle like a tyre: it grows to a peak at
// 5-9° and gives way past it to a lower sliding grip, so near the limit the nose points a few degrees into the corner,
// and a slide that goes too far has to be caught by easing off. With the slide key (r.slideIn) the stick sets the
// slide angle instead (full lock: slideAngle) and the nose swings round to hold it: the slide grip and the angled
// thrust pull the pod round a tighter line while the sideways speed scrubs speed off. Coming out of a slide, part of
// the sideways speed comes back as forward speed, and while it slides, the engines, off-axis in the airflow, cool down.
const HANDLING = {
  steerA: 70,              // m/s²: the turn full lock asks for above ~115 km/h (yaw rate steerA / v)
  yawMax: 2.2,             // rad/s: the yaw rate full lock asks for at low speed
  yawK: 45,                // 1/s: how fast the yaw rate follows the stick
  peak: 74,                // m/s²: the most sideways grip, reached at linA and held to peakA (rad)
  linA: 0.087, peakA: 0.157,
  lost: 54, lostA: 0.42,   // past the peak the grip falls to `lost` at lostA (24°)
  slide: 100, slideA: 0.454, // the grip in a slide, growing to `slide` at slideA (26°)
  slideAngle: 0.42,        // rad: the slide angle full lock holds (24°)
  slideK: 7,               // 1/s: how fast the nose swings to it
  sling: 0.45,             // on a slide's exit: the share of the sideways speed taken back that returns as forward speed
  cool: 26,                // heat/s a slide takes off the engines on top of the normal cooling
  sand: 0.95,              // grip and steering on the sand
  sandDrag: [15, 0.15],    // m/s² + per m/s: the drag just past the edge (a quarter of the speed per second at full speed)...
  deepDrag: [10, 0.15],    // ...and added further out (hw + 5 to hw + 18 m)
  sandTop: 0.75,           // the share of top speed the engines can still push to on the sand (and again deep out)
  keyRise: 7, keyFall: 12, // 1/s: how fast the keyboard steering comes on and lets go
};
function gripAt(a, slide) {
  const H = HANDLING;
  const g = a < H.linA ? H.peak * a / H.linA : a < H.peakA ? H.peak : lerp(H.peak, H.lost, smooth(H.peakA, H.lostA, a));
  return lerp(g, H.slide * Math.min(1, a / H.slideA), slide);
}
// Gusts (gfx/wind.js) push the pods out in the open: sideways, a little along, and the nose turns into the wind.
// The canyon and the arena are sheltered. ?wind=0 turns the push off (testing).
const WIND_PUSH = !/[?&]wind=0\b/.test(location.search);
const GUST_A = 12, GUST_YAW = 2.5;   // m/s² sideways, rad/s² on the nose (a full gust turns it ~3°/s against the steering)
// Slipstream: in the wake of a pod 6-55 m ahead and within a few metres sideways the air drag drops (top speed +6 %).
const DRAFT_V = 0.06;
// Hits on walls (the arena, the canyon) and rocks: a glancing hit turns the nose along the obstacle and costs a few per
// cent, a square one a lot; one penalty per contact (r.wallCD), only a light scrape while the pod slides along.
const HIT_WALL = { base: 0.02, loss: 0.45, rest: 0.15, restSq: 0.3 }, HIT_ROCK = { base: 0.06, loss: 0.6, rest: 0.25, restSq: 0.4 };
// (the canyon walls' ramps, F2: the pod has ridden up the slope, so meeting the wall line there turns it along the
// wall like a banked berm, its speed kept but for a share that grows with the angle)
const HIT_RAMP = { base: 0, loss: 0.25, rest: 0, restSq: 0, redirect: true };
// n: unit normal pointing at the obstacle, vn > 0: the speed into it; (hx, hz): the contact point for the effects
function impact(r, nx, nz, vn, k, hx, hz, dt, rock) {
  const v = Math.hypot(r.vx, r.vz) || 1, phi = Math.asin(Math.min(1, vn / v));    // 0: grazing, PI/2: square on
  const fresh = !(r.wallCD > 0);
  r.wallCD = 0.3;
  const keep = fresh ? 1 - (k.base + k.loss * (phi / (Math.PI / 2)) ** 1.3) : Math.exp(-0.12 * dt);
  const tvx = (r.vx - nx * vn) * keep, tvz = (r.vz - nz * vn) * keep;
  const rest = lerp(k.rest, k.restSq, smooth(0.3, 0.9, phi));
  r.vx = tvx - nx * vn * rest; r.vz = tvz - nz * vn * rest;
  // the nose pointing into the obstacle turns to the travel direction (2° away from it), over ~0.1 s
  const fx = Math.sin(r.yaw), fz = Math.cos(r.yaw);
  if (fx * nx + fz * nz > 0 && fx * tvx + fz * tvz > 0) {
    const tl = Math.hypot(tvx, tvz) || 1;
    const turn = wrapAngle(Math.atan2(tvx / tl - nx * 0.035, tvz / tl - nz * 0.035) - r.yaw) * (1 - smooth(0.5, 1.1, phi));
    r.yaw += turn * 0.5;
    r.yawRate = turn * 0.5 * HANDLING.yawK;
  } else r.yawRate *= 0.3;
  if (fresh && vn > 4) hitFx(r, hx, hz, rock ? vn * 1.6 : vn, true);
}

// ============================================================
//  Collisions (docs/visual-next-steps.md F): each pod's hull, a few capsules per model (r.hull), against the solid
//  field (SOLID) and against the other pods' hulls. The deepest contact is pushed out and resolved as an impulse at
//  the contact point, so a hit off the centre turns the pod (r.spin, F3); the tuned costs of a hit stay (HIT_WALL,
//  HIT_ROCK: the tangential speed kept, the bounce by the impact angle). ?col=0: the old circles and clamps.
// ============================================================
const COL_NEW = !/[?&]col=0\b/.test(location.search);
// the spin a hit gives: the hull's inertia is scaled by `inertia` (more: less spin), the spin dies away at `decay`
// per second and never exceeds `max` rad/s, nor turns the nose further than `align` times the way to the new
// direction of travel (addSpin); e: the bounce between two pods
const SPIN = { inertia: 1.6, decay: 5, max: 3.5, align: 0.85 }, POD_E = 0.3;
// the hull's capsules in the world at the pod's pose (x, z; y: height above the pod's origin, for the effects)
function hullWorld(r) {
  const H = r.hull, c = Math.cos(r.yaw), s = Math.sin(r.yaw);
  if (!r.hw || r.hw.hull !== H) { r.hw = H.caps.map(() => ({ ax: 0, az: 0, bx: 0, bz: 0, r: 0, y: 0, on: true })); r.hw.hull = H; }
  for (let i = 0; i < H.caps.length; i++) {
    const k = H.caps[i], w = r.hw[i];
    // body (x left, z forward) -> world, as the mesh: (x c + z s, -x s + z c)
    w.ax = r.x + k.ax * c + k.az * s; w.az = r.z - k.ax * s + k.az * c;
    w.bx = r.x + k.bx * c + k.bz * s; w.bz = r.z - k.bx * s + k.bz * c;
    w.r = k.r; w.y = (k.ay + k.by) / 2; w.on = !(k.bit & (r.broken || 0));
  }
  return r.hw;
}
// the deepest point of the hull inside the solid field: ct.pen (m), the contact on the surface (x, z), the outward
// normal, the material, which capsule and its height
const _sq = { d: 0, nx: 0, nz: 0, mat: 0 };
const CT = { pen: 0, x: 0, z: 0, nx: 0, nz: 0, mat: 0, cap: -1, y: 0 };
function worldContact(r, ct) {
  ct.pen = 0;
  const caps = hullWorld(r);
  // nothing solid within the hull's reach of the origin: done (the walls' distance is exact; a rock's patch reads
  // only up to its REACH, so the hash is asked for any patch near; the canyon's ends are checked by height below)
  const hard = SOLID.nearHardAt(r.loc.i);
  const d0 = SOLID.query(r.x, r.z, r.loc.i, _sq);
  if (!hard && d0 > r.hull.reach + 1 && !SOLID.near(r.x, r.z, r.hull.reach + 1)) return false;
  for (let i = 0; i < caps.length; i++) {
    const k = caps[i];
    if (!k.on) continue;
    const len = Math.hypot(k.bx - k.ax, k.bz - k.az), n = Math.max(1, Math.ceil(len / (k.r * 0.7)));
    for (let j = 0; j <= n; j++) {
      const t = j / n, x = k.ax + (k.bx - k.ax) * t, z = k.az + (k.bz - k.az) * t;
      const d = SOLID.query(x, z, r.loc.i, _sq), pen = k.r - d;
      if (pen > ct.pen && (_sq.nx || _sq.nz)) {
        ct.pen = pen; ct.nx = _sq.nx; ct.nz = _sq.nz; ct.x = x - _sq.nx * d; ct.z = z - _sq.nz * d;
        ct.mat = _sq.mat; ct.cap = i; ct.y = k.y;
      }
      if (hard) rockContact(r, k, i, x, z);
    }
  }
  return ct.pen > 0;
}
// On the canyon walls' ramps (F2, RAMP) the hull rides the rock: at a point of a capsule's axis and at its sides (out
// and in across the track), rock above the capsule (its underside on the axis, its middle at the sides) by no more
// than RAMP.step lifts the hover clear of it (r.rockLift, physics). The wall line stops it further up.
function rockContact(r, k, i, x, z) {
  const f = SOLID.frame(x, z, r.loc.i), sd = f.d >= 0 ? 1 : -1, ox = -f.tz * sd, oz = f.tx * sd;
  for (let q = -1; q <= 1; q++) {
    const h = SOLID.rideAt(x + ox * k.r * q, z + oz * k.r * q, r.loc.i, true);
    if (h === -Infinity) continue;
    const under = k.y - (q === 0 ? k.r : 0), e = h - (r.y + under);
    if (e > 0 && e <= RAMP.step) r.rockLift = Math.max(r.rockLift, h - under + 0.15);
  }
}
// the world pushes back: out of the rock, then an impulse at the contact point (up to three contacts a step)
function collideWorld(r, dt) {
  r.rockLift = -Infinity;
  for (let it = 0; it < 3; it++) {
    if (!worldContact(r, CT)) return;
    const push = Math.min(CT.pen, 2.5);
    r.x += CT.nx * push; r.z += CT.nz * push;
    const rx = CT.x - r.x, rz = CT.z - r.z, w = r.yawRate + r.spin;
    // the contact point's velocity (turning about the origin: w (rz, -rx)) into the rock
    const vin = -((r.vx + w * rz) * CT.nx + (r.vz - w * rx) * CT.nz);
    const rock = CT.mat === SOLID_MAT.rock;
    r.scrape = Math.max(r.scrape || 0, Math.min(1, Math.abs(r.fwd) / 70));
    r.scrapeX = CT.x; r.scrapeZ = CT.z; r.scrapeY = CT.y; r.scrapeNX = CT.nx; r.scrapeNZ = CT.nz; r.scrapeMat = CT.mat; r.scrapeN = true;
    if (vin > 0) hitWorld(r, CT, rx, rz, vin, rock ? HIT_ROCK : CT.mat === SOLID_MAT.ramp ? HIT_RAMP : HIT_WALL, dt, rock);
    // a pod left slow with its nose against it (a square hit) is turned along it, the way the track runs, within half
    // a second, as the old collisions did: it does not sit pushing into the rock
    const fx = Math.sin(r.yaw), fz = Math.cos(r.yaw);
    if (-(fx * CT.nx + fz * CT.nz) > 0.35 && Math.hypot(r.vx, r.vz) < 25) {
      const sg = Math.sign(-CT.nz * r.loc.tx + CT.nx * r.loc.tz) || 1;
      r.yaw += wrapAngle(Math.atan2(-CT.nz * sg, CT.nx * sg) - r.yaw) * Math.min(1, 4 * dt);
    }
  }
}
function hitWorld(r, ct, rx, rz, vin, k, dt, rock) {
  const v = Math.hypot(r.vx, r.vz) || 1, vn = r.vx * ct.nx + r.vz * ct.nz;      // vn < 0: the centre moves into it
  const phi = Math.asin(Math.min(1, Math.max(0, -vn) / v));                      // 0: grazing, PI/2: square on
  // (one hit is one cost: the tail swinging in after the nose, or the nose after the tail, is the same hit)
  const fresh = !(r.wallCD > 0);
  r.wallCD = 0.6;
  // the tangential speed: the tuned cost of a hit, or of grinding along
  const keep = fresh ? 1 - (k.base + k.loss * (phi / (Math.PI / 2)) ** 1.3) : Math.exp(-0.12 * dt);
  const tvx = (r.vx - ct.nx * vn) * keep, tvz = (r.vz - ct.nz * vn) * keep;
  // the bounce: the centre's speed into it comes back by the tuned restitution, as before (none if only the turn
  // brought the contact point in); the spin: the impulse that stops the contact point (mass 1, the lever arm about
  // the origin), so a hit off the centre turns the pod without changing what the hit costs
  const rest = lerp(k.rest, k.restSq, smooth(0.3, 0.9, phi));
  const vn1 = vn < 0 ? -vn * rest : vn;
  r.vx = tvx + ct.nx * vn1; r.vz = tvz + ct.nz * vn1;
  if (k.redirect && vn < 0) {
    // (a berm: the speed goes on along the wall instead of into it)
    const tl = Math.hypot(tvx, tvz) || 1, sp = v * (1 - k.loss * phi / (Math.PI / 2));
    r.vx = tvx / tl * sp; r.vz = tvz / tl * sp;
  }
  const lever = ct.nx * rz - ct.nz * rx, I = r.hull.k2 * SPIN.inertia;
  addSpin(r, (1 + rest) * vin / (1 + lever * lever / I) * lever / I);
  if (fresh && vin > 4) hitFx(r, ct.x, ct.z, rock ? vin * 1.6 : vin, rock, ct);
}
// The spin is the contact's, but how far it turns the pod is held in check: towards the new direction of travel at
// most as far as lines the nose up with it (a nose into the wall swings round parallel to it), the other way (a hit
// on the tail) at most ~9 degrees. The turn a spin gives is spin / decay.
function addSpin(r, dw) {
  const w = r.spin + dw, align = wrapAngle(Math.atan2(r.vx, r.vz) - r.yaw);
  const most = (Math.sign(w) === Math.sign(align) ? Math.abs(align) * SPIN.align + 0.02 : 0.15) * SPIN.decay;
  r.spin = clamp(w, -Math.min(most, SPIN.max), Math.min(most, SPIN.max));
}

// closest points of two segments in the plane (Ericson): writes s, t (0..1) into _cp, returns the squared distance
const _cp = { s: 0, t: 0 };
function segSeg(p1x, p1z, q1x, q1z, p2x, p2z, q2x, q2z) {
  const d1x = q1x - p1x, d1z = q1z - p1z, d2x = q2x - p2x, d2z = q2z - p2z, rx = p1x - p2x, rz = p1z - p2z;
  const a = d1x * d1x + d1z * d1z, e = d2x * d2x + d2z * d2z, f = d2x * rx + d2z * rz;
  let s, t;
  if (a < 1e-9 && e < 1e-9) { s = t = 0; }
  else if (a < 1e-9) { s = 0; t = clamp(f / e, 0, 1); }
  else {
    const c = d1x * rx + d1z * rz;
    if (e < 1e-9) { t = 0; s = clamp(-c / a, 0, 1); }
    else {
      const b = d1x * d2x + d1z * d2z, den = a * e - b * b;
      s = den > 1e-9 ? clamp((b * f - c * e) / den, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); } else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
    }
  }
  _cp.s = s; _cp.t = t;
  const dx = p1x + d1x * s - (p2x + d2x * t), dz = p1z + d1z * s - (p2z + d2z * t);
  return dx * dx + dz * dz;
}
// pod against pod: the deepest pair of capsules; only pods simulated on this machine move (a network pod's owner
// resolves its own side, so here it is immovable)
const PC = { pen: 0, x: 0, z: 0, nx: 0, nz: 0, y: 0 };
function collidePods() {
  for (let a = 0; a < racers.length; a++) for (let b = a + 1; b < racers.length; b++) {
    const A = racers[a], B = racers[b];
    if (A.gone || B.gone) continue;
    const simA = A.ctl !== 'net', simB = B.ctl !== 'net';
    if (!simA && !simB) continue;
    const rr = A.hull.reach + B.hull.reach;
    if ((A.x - B.x) ** 2 + (A.z - B.z) ** 2 > rr * rr || Math.abs(A.y - B.y) > 3) continue;
    const ca = hullWorld(A), cb = hullWorld(B);
    PC.pen = 0;
    for (const p of ca) {
      if (!p.on) continue;
      for (const q of cb) {
        if (!q.on) continue;
        const d2 = segSeg(p.ax, p.az, p.bx, p.bz, q.ax, q.az, q.bx, q.bz), R = p.r + q.r;
        if (d2 >= R * R) continue;
        const d = Math.sqrt(d2), pen = R - d;
        if (pen <= PC.pen) continue;
        const px = p.ax + (p.bx - p.ax) * _cp.s, pz = p.az + (p.bz - p.az) * _cp.s;
        const qx = q.ax + (q.bx - q.ax) * _cp.t, qz = q.az + (q.bz - q.az) * _cp.t;
        // n: from A's capsule towards B's (along the line between the two pods if they sit exactly on each other)
        let nx = qx - px, nz = qz - pz;
        if (d > 1e-6) { nx /= d; nz /= d; } else { nx = B.x - A.x; nz = B.z - A.z; const l = Math.hypot(nx, nz) || 1; nx /= l; nz /= l; }
        PC.pen = pen; PC.nx = nx; PC.nz = nz;
        PC.x = px + nx * (p.r - pen / 2); PC.z = pz + nz * (p.r - pen / 2); PC.y = (p.y + q.y) / 2;
      }
    }
    if (PC.pen <= 0) continue;
    const iA = simA ? 1 / A.hull.mass : 0, iB = simB ? 1 / B.hull.mass : 0, wA = iA / (iA + iB), wB = iB / (iA + iB);
    const { nx, nz } = PC;
    A.x -= nx * PC.pen * wA; A.z -= nz * PC.pen * wA; B.x += nx * PC.pen * wB; B.z += nz * PC.pen * wB;
    const rax = PC.x - A.x, raz = PC.z - A.z, rbx = PC.x - B.x, rbz = PC.z - B.z;
    const wa = A.yawRate + (A.spin || 0), wb = B.yawRate + (B.spin || 0);
    const rel = (B.vx + wb * rbz - A.vx - wa * raz) * nx + (B.vz - wb * rbx - A.vz + wa * rax) * nz;
    if (rel >= 0) continue;
    const la = nx * raz - nz * rax, lb = nx * rbz - nz * rbx;
    const IA = simA ? 1 / (A.hull.k2 * A.hull.mass * SPIN.inertia) : 0, IB = simB ? 1 / (B.hull.k2 * B.hull.mass * SPIN.inertia) : 0;
    const j = -(1 + POD_E) * rel / (iA + iB + la * la * IA + lb * lb * IB);
    if (simA) { A.vx -= nx * j * iA; A.vz -= nz * j * iA; addSpin(A, -la * j * IA); }
    if (simB) { B.vx += nx * j * iB; B.vz += nz * j * iB; addSpin(B, lb * j * IB); }
    const victim = A.player ? A : B;
    if (j > 3) hitFx(victim, PC.x, PC.z, j * 2, false, { y: PC.y, nx: victim === A ? -nx : nx, nz: victim === A ? -nz : nz, pod: victim === A ? B : A });
  }
}

function physics(r, dt, t) {
  const H = HANDLING;
  const loc = locate(r.x, r.z, r.loc);
  const ad = Math.abs(loc.d);
  const off = smooth(loc.hw - 1, loc.hw + 4, ad), deep = smooth(loc.hw + 5, loc.hw + 18, ad);
  const walled = loc.arena > 0.3 || loc.canyon > 0.3;
  r.off = off;
  r.edge = walled ? 0 : smooth(loc.hw - 3.5, loc.hw - 0.3, ad);       // the warning strip before the sand
  const fx = Math.sin(r.yaw), fz = Math.cos(r.yaw);
  if (r.wallCD > 0) r.wallCD -= dt;

  // boost and heat; the hotter the engines, the harder the boost pushes
  const wantBoost = r.boostIn && r.overheat <= 0 && r.throttle > 0.4 && r.fwd > 25;
  r.boosting = wantBoost;
  const sliding = r.slide > 0.5 && !wantBoost ? smooth(0.12, 0.3, r.slip || 0) : 0;
  r.cooling = sliding;
  if (wantBoost) { r.heat += 24 * dt; if (r.heat >= 100) { r.heat = 100; r.overheat = 3.2; r.boosting = false; if (r.player) onOverheat(); } }
  else r.heat = Math.max(0, r.heat - ((r.overheat > 0 ? 26 : 15) + H.cool * sliding) * dt);
  if (r.overheat > 0) r.overheat -= dt;
  const h = r.heat / 100;

  // slipstream
  let dr = 0;
  for (const o of racers) {
    if (o === r || o.gone) continue;
    const gap = o.prog - r.prog, dl = Math.abs(o.loc.d - loc.d);
    if (gap < 6 || gap > 55 || dl > 5) continue;
    dr = Math.max(dr, (1 - smooth(25, 55, gap)) * (1 - smooth(2.5, 5, dl)) * clamp(o.fwd / 60, 0, 1));
  }
  r.draft = damp(r.draft || 0, dr, dr > (r.draft || 0) ? 2.5 : 4, dt);

  // along the heading: thrust up to the engines' top speed (vCap); on the sand the thrust gives out lower and a drag
  // slows the pod: just past the edge about a quarter of its speed per second at full speed, so a mistake costs but is
  // not a wall, and deeper out twice that, so running wide does not carry the pod far into the desert
  const vCap = TOP * r.topMul * (r.boosting ? 1.24 + 0.12 * h : 1) * (r.overheat > 0 ? 0.8 : 1) * (1 + DRAFT_V * r.draft);
  const vDrive = vCap * lerp(1, H.sandTop, off) * lerp(1, H.sandTop, deep);
  let fwd = r.vx * fx + r.vz * fz;
  let lat = r.vx * -fz + r.vz * fx;
  let a = 0;
  if (fwd < vDrive) a += (r.boosting ? 56 + 16 * h : 44) * r.throttle * (1 - (fwd / vDrive) ** 2);
  else if (fwd > vCap) a -= 20 + (fwd - vCap) * 0.6;
  if (r.brake > 0) a -= (fwd > 1 ? 72 : 14) * r.brake;
  if (r.throttle < 0.05 && r.brake <= 0) a -= 5 + fwd * 0.035 * (1 - 0.5 * r.draft);
  a -= Math.sign(fwd) * Math.min(Math.abs(fwd) / dt, off * (H.sandDrag[0] + H.sandDrag[1] * Math.abs(fwd)) + deep * (H.deepDrag[0] + H.deepDrag[1] * Math.abs(fwd)));
  fwd = Math.max(-16, fwd + a * dt);

  // the slide: only at speed
  r.slide = damp(r.slide || 0, r.slideIn && fwd > 20 ? 1 : 0, r.slideIn ? 10 : 5, dt);
  const sk = lerp(1, H.sand, off);

  // steering: gripping, the stick asks for a yaw rate; sliding, for a slide angle, held by turning the nose with the
  // path (beta: + = the nose left of the travel direction)
  const sp = Math.abs(fwd), dir = Math.sign(fwd || 1);
  const omax = Math.min(H.yawMax, H.steerA * sk / Math.max(sp, 1)) * Math.max(0.35, Math.min(1, sp / 6));
  let wT = r.steer * omax * dir;
  if (r.slide > 0.01) {
    const beta = Math.atan2(lat, Math.max(sp, 4));
    const wPath = Math.sign(beta) * gripAt(Math.abs(beta), 1) * sk * Math.cos(beta) / Math.max(sp, 10);
    const wSlide = clamp(wPath + H.slideK * (r.steer * H.slideAngle * dir - beta), -H.yawMax * 1.3, H.yawMax * 1.3);
    wT = lerp(wT, wSlide, r.slide);
  }
  r.yawRate = (r.yawRate || 0) + (wT - (r.yawRate || 0)) * (1 - Math.exp(-H.yawK * dt));

  // gusts in the open: sideways, a little along, and the nose turns into the wind
  let gk = 0;
  if (WIND_PUSH) gk = gustField(r.x, r.z, ATMO.hfTime.value) * (1 - loc.canyon) * (1 - 0.85 * loc.arena);
  r.gust = gk;
  const cross = gk > 0 ? WIND_DIR.x * -fz + WIND_DIR.y * fx : 0, along = gk > 0 ? WIND_DIR.x * fx + WIND_DIR.y * fz : 0;
  r.yawRate += GUST_YAW * gk * cross * dt;

  // (a hit's spin turns the pod on top of the steering, and dies away)
  r.yaw += (r.yawRate + r.spin) * dt;
  if (r.spin) r.spin = Math.abs(r.spin) < 1e-3 ? 0 : r.spin * Math.exp(-SPIN.decay * dt);
  const nfx = Math.sin(r.yaw), nfz = Math.cos(r.yaw);
  // velocity re-expressed on the new heading; the grip takes the sideways part back by the tyre curve
  const vx = fx * fwd - fz * lat, vz = fz * fwd + fx * lat;
  fwd = vx * nfx + vz * nfz;
  lat = vx * -nfz + vz * nfx;
  const slip = Math.atan2(Math.abs(lat), Math.max(Math.abs(fwd), 4));
  const take = Math.min(Math.abs(lat), gripAt(slip, r.slide) * sk * dt);
  lat -= Math.sign(lat) * take;
  // coming out of a slide (the key let go, the slide easing off) part of it comes back as forward speed
  if (!r.slideIn && r.slide > 0.05 && fwd > 0 && fwd < vCap) fwd = Math.min(vCap, fwd + take * H.sling);
  fwd += GUST_A * gk * along * 0.2 * dt;
  lat += GUST_A * gk * cross * dt;
  r.slip = slip;
  r.vx = nfx * fwd - nfz * lat;
  r.vz = nfz * fwd + nfx * lat;
  r.fwd = fwd; r.lat = lat;
  r.x += r.vx * dt; r.z += r.vz * dt;

  // the hull against the solid world (F); the old way below (?col=0)
  locate(r.x, r.z, loc);
  if (COL_NEW) {
    collideWorld(r, dt);
    locate(r.x, r.z, loc);
    if (Math.abs(loc.d) > loc.hw + 150) { respawn(r); if (r.player) toast('VISSZA A PÁLYÁRA'); }
  }
  // walls in the arena and canyon
  const lim = loc.hw - 1.6;
  if (!COL_NEW && walled && Math.abs(loc.d) > lim) {
    const sgn = Math.sign(loc.d), nx = -loc.tz * sgn, nz = loc.tx * sgn;
    const pen = Math.abs(loc.d) - lim;
    r.x -= nx * pen; r.z -= nz * pen;
    r.scrape = Math.max(r.scrape || 0, Math.min(1, Math.abs(r.fwd) / 70)); r.scrapeX = r.x + nx * 2.5; r.scrapeZ = r.z + nz * 2.5;
    const vn = r.vx * nx + r.vz * nz;
    if (vn > 0) impact(r, nx, nz, vn, HIT_WALL, r.x + nx * 2.5, r.z + nz * 2.5, dt, false);
  }
  // rocks, towers
  if (!COL_NEW && Math.abs(loc.d) > loc.hw + 3) {
    for (const c of COLLIDERS) {
      const dx = r.x - c.x, dz = r.z - c.z, rr = c.r + POD_R;
      const d2 = dx * dx + dz * dz;
      if (d2 > rr * rr) continue;
      const d = Math.sqrt(d2) || 1, nx = dx / d, nz = dz / d;
      r.x = c.x + nx * rr; r.z = c.z + nz * rr;
      const vn = r.vx * nx + r.vz * nz;
      if (vn < 0) impact(r, -nx, -nz, -vn, HIT_ROCK, r.x - nx * POD_R, r.z - nz * POD_R, dt, true);
    }
    if (Math.abs(loc.d) > loc.hw + 150) { respawn(r); if (r.player) toast('VISSZA A PÁLYÁRA'); }
  }

  // height: hover over track or dunes, pitch with the slope
  // (over the ground, or the rock the pod rides up: F2's ramps; on the rock, its slope pushes the pod back down it)
  const top = r.y + RAMP.step, g0 = groundQuery(r.x, r.z), rk = SOLID.rideAt(r.x, r.z, loc.i), rock = rk < top ? rk : -Infinity, gy = Math.max(g0, rock);
  const ga = rideQuery(r.x + nfx * 5, r.z + nfz * 5, loc.i, top), gb = rideQuery(r.x - nfx * 5, r.z - nfz * 5, loc.i, top);
  if (rock > g0 + 0.05 && SOLID.rideSlope(r.x, r.z, loc.i, _rs)) { r.vx -= RAMP.bank * _rs.x * dt; r.vz -= RAMP.bank * _rs.z * dt; }
  const target = Math.max(Math.max(gy, (ga + gb) / 2) + HOVER, r.rockLift ?? -Infinity) + Math.sin(t * 2.7 + r.phase) * 0.12 * (1 - Math.min(1, sp / 80));
  r.vy += ((target - r.y) * 60 - r.vy * 12) * dt;
  r.y += r.vy * dt;
  if (r.y < gy + 0.6) { r.y = gy + 0.6; r.vy = Math.max(0, r.vy); }
  if (r.rockLift > r.y + 0.3) { r.y = r.rockLift - 0.3; r.vy = Math.max(0, r.vy); }      // (rock under the hull: F2)
  r.pitch = damp(r.pitch, -Math.atan2(ga - gb, 10), 8, dt);
  if (off > 0.5 && ga - gb > 1.5) { r.vx *= 1 - 0.3 * dt; r.vz *= 1 - 0.3 * dt; }

  // lap counting
  const s = r.loc.s, prevS = r.prevS ?? s;
  if (s - prevS < -TR.L / 2) r.lap++;
  else if (s - prevS > TR.L / 2) r.lap--;
  r.prevS = s;
  r.prog = r.lap * TR.L + s;
  // wrong-way detection
  const alongT = r.vx * loc.tx + r.vz * loc.tz;
  r.wrong = alongT < -6 ? r.wrong + dt : Math.max(0, r.wrong - dt * 2);
}

function separate() {
  for (let a = 0; a < racers.length; a++) for (let b = a + 1; b < racers.length; b++) {
    const A = racers[a], B = racers[b];
    if (A.gone || B.gone) continue;
    // only pods simulated on this machine get pushed; a network pod's owner resolves its own side
    const simA = A.ctl !== 'net', simB = B.ctl !== 'net';
    if (!simA && !simB) continue;
    const wa = simA ? (simB ? 0.5 : 1) : 0, wb = simB ? (simA ? 0.5 : 1) : 0;
    const ax = A.x + Math.sin(A.yaw) * 2.5, az = A.z + Math.cos(A.yaw) * 2.5;
    const bx = B.x + Math.sin(B.yaw) * 2.5, bz = B.z + Math.cos(B.yaw) * 2.5;
    const dx = bx - ax, dz = bz - az, d2 = dx * dx + dz * dz, rr = POD_R * 2;
    if (d2 > rr * rr || d2 < 1e-6) continue;
    const d = Math.sqrt(d2), nx = dx / d, nz = dz / d, pen = rr - d;
    A.x -= nx * pen * wa; A.z -= nz * pen * wa; B.x += nx * pen * wb; B.z += nz * pen * wb;
    const rel = (B.vx - A.vx) * nx + (B.vz - A.vz) * nz;
    if (rel < 0) {
      const j = -rel * 0.65;
      if (simA) { A.vx -= nx * j; A.vz -= nz * j; }
      if (simB) { B.vx += nx * j; B.vz += nz * j; }
      if (j > 3) hitFx(A.player ? A : B, (ax + bx) / 2, (az + bz) / 2, j * 2);
    }
  }
}

// ============================================================
//  AI driver
// ============================================================
// every other bot slides into the corners it comes at too fast (and brakes only when far too fast)
const aiSlider = (r) => r.n % 2 === 1;
function driveAI(r, dt, raceT) {
  const loc = r.loc;
  r.aiOffT -= dt;
  if (r.aiOffT <= 0) { r.aiOffT = 2 + Math.random() * 4; r.aiOffGoal = (Math.random() - 0.5) * 8; }
  r.aiOff = damp(r.aiOff, r.aiOffGoal || 0, 0.8, dt);
  // dodge the pod right ahead
  let dodge = 0;
  for (const o of racers) {
    if (o === r || o.gone) continue;
    let gap = o.prog - r.prog;
    if (gap > 0 && gap < 30) {
      const dl = o.loc.d - loc.d;
      if (Math.abs(dl) < 6) dodge += (dl > 0 ? -1 : 1) * (6 - Math.abs(dl)) * (1 - gap / 30) * 1.6;
    }
  }
  const look = 20 + Math.max(r.fwd, 0) * 0.42;
  const li = TR.idx(loc.i + Math.round(look / 4));
  const latGoal = clamp(TR.line[li] + r.aiOff + dodge, -TR.hw[li] + 3.5, TR.hw[li] - 3.5);
  trackPoint(loc.s + look, latGoal, _tp);
  const err = wrapAngle(Math.atan2(_tp.x - r.x, _tp.z - r.z) - r.yaw);
  r.steer = clamp(err * 2.8, -1, 1);

  // target speed from the profile ahead, with gentle rubber-banding
  let vt = 1e9;
  for (let k = 0; k <= 12; k += 2) vt = Math.min(vt, TR.vmax[TR.idx(loc.i + k)]);
  let lead = -1e9;                       // the best human sets the pace
  for (const h of racers) if (h.owner && !h.gone && h.prog > lead) lead = h.prog;
  const gap = lead > -1e8 ? r.prog - lead : 0;
  const band = gap > 250 ? 0.95 : gap < -250 ? 1.05 : 1;
  vt *= r.skill * band * (r.off > 0.5 ? 0.6 : 1);
  vt = Math.min(vt, TOP * 1.28);
  r.throttle = r.fwd < vt ? 1 : 0.2;
  // (a slider slides where the others brake)
  r.slideIn = aiSlider(r) && r.fwd > 40 && r.fwd > vt + 4 && Math.abs(err) > 0.035 && r.off < 0.5;
  r.brake = r.fwd > vt + (r.slideIn ? 18 : 5) ? clamp((r.fwd - vt) / 25, 0, 1) : 0;
  // boost on long fast stretches
  if (!r.aiBoost && r.heat < 30 && vt > TOP * 1.05 && Math.abs(err) < 0.08 && Math.random() < dt * 0.8) r.aiBoost = true;
  if (r.aiBoost && (r.heat > 72 + r.n * 2 || vt < TOP)) r.aiBoost = false;
  r.boostIn = r.aiBoost && raceT > 2;
}

// ============================================================
//  Sound: audio.js (engines, spatial pods, reverb, crowd, music, announcer)
// ============================================================
const AUDIO = createAudio();
const SND = { get muted() { return AUDIO.muted; } };
function initAudio() { AUDIO.init(); }
function setMuted(m) { AUDIO.setMuted(m); }
function sfx(kind, k = 1) { AUDIO.sfx(kind, k); }
function announce(key) { AUDIO.announce(key); }
const AV = {
  state: 'loading', live: false, crowd: 0, intensity: 0, slowmo: 0, others: [],
  listener: { x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: -1, ux: 0, uy: 1, uz: 0 },
  player: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, fwd: 0, throttle: 0, brake: 0, boosting: false, overheat: 0, heat: 0, off: 0, scrape: 0 },
  env: { canyon: 0, arena: 0, arch: 0 },
};
const _ad = new THREE.Vector3(), _au = new THREE.Vector3(), _anc = { i: 0, d: 0 };
function updateAudio(dt, live) {
  AV.state = state; AV.live = live;
  camera.getWorldDirection(_ad); _au.set(0, 1, 0).applyQuaternion(camera.quaternion);
  const L = AV.listener;
  L.x = camera.position.x; L.y = camera.position.y; L.z = camera.position.z;
  L.fx = _ad.x; L.fy = _ad.y; L.fz = _ad.z; L.ux = _au.x; L.uy = _au.y; L.uz = _au.z;
  const src = (r) => (CINE.replay ? CINE.replay.proxies[r.n] : r);
  const p = src(player), P = AV.player;
  Object.assign(P, { x: p.x, y: p.y, z: p.z, vx: p.vx, vy: p.vy || 0, vz: p.vz, fwd: p.fwd, throttle: p.throttle, brake: p.brake || 0,
    boosting: !!p.boosting, overheat: p.overheat || 0, heat: p.heat || 0, off: p.off || 0, scrape: player.scrape || 0,
    slide: p.slide || 0, slip: Math.atan2(Math.abs(p.lat || 0), Math.max(4, Math.abs(p.fwd))), edge: CINE.replay ? 0 : player.edge || 0, draft: CINE.replay ? 0 : player.draft || 0 });
  AV.others = racers.filter((r) => r !== player && !r.gone).map((r) => { const o = src(r); return { id: r.n, x: o.x, y: o.y, z: o.z, vx: o.vx, vy: 0, vz: o.vz, fwd: o.fwd, throttle: o.throttle, boosting: !!o.boosting }; });
  nearestCoarse(camera.position.x, camera.position.z, _anc);
  const near = _anc.i >= 0 ? 1 - smooth(TR.hw[_anc.i] + 20, TR.hw[_anc.i] + 120, _anc.d) : 0;
  AV.env.canyon = _anc.i >= 0 ? TR.canyon[_anc.i] * near : 0;
  AV.env.arena = _anc.i >= 0 ? TR.arena[_anc.i] * near : 0;
  AV.env.arch = Math.max(0, 1 - Math.hypot(camera.position.x - ARCH.x, camera.position.z - ARCH.z) / 45);
  // the one wind (E2): the sound swells as a gust front reaches the camera (half as much down in the canyon)
  AV.gust = GUST_ON ? gust(camera.position.x, camera.position.z, ATMO.hfTime.value) * (1 - 0.5 * AV.env.canyon) : undefined;
  AV.crowd = CROWD.cheer;
  AV.intensity = state === 'menu' || state === 'room' || state === 'loading' ? 0.2
    : state === 'countdown' ? (CINE.introT > 0 ? 0.3 : 0.5)
    : state === 'results' ? 0.35
    : state === 'finished' ? 0.6
    : player.lap >= laps - 1 ? 1 : 0.82;
  AV.slowmo = clamp((1 - CINE.timeScale) / 0.75, 0, 1);
  AUDIO.update(dt, AV);
}

// ============================================================
//  Input: keyboard, gamepad, touch
// ============================================================
const keys = new Set();
const GAME_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'ShiftLeft', 'ShiftRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD']);
const touchState = { left: false, right: false, brake: false, boost: false, slide: false };
let touchMode = false;
const onPress = {};   // filled by the UI section: code -> handler
window.addEventListener('keydown', (e) => {
  const inGame = state === 'race' || state === 'countdown' || state === 'finished';
  if (GAME_KEYS.has(e.code) && (inGame || !(e.target instanceof HTMLButtonElement))) e.preventDefault();
  initAudio();
  if (CINE.introT > 0 && state === 'countdown' && !e.repeat && e.code !== 'Escape' && e.code !== 'KeyP') skipIntro();
  if (!e.repeat && onPress[e.code]) onPress[e.code](e);
  keys.add(e.code);
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());
for (const [id, k] of [['tLeft', 'left'], ['tRight', 'right'], ['tBrake', 'brake'], ['tBoost', 'boost'], ['tSlide', 'slide']]) {
  const el = document.getElementById(id);
  const set = (v) => (e) => { e.preventDefault(); touchState[k] = v; el.classList.toggle('on', v); if (v) initAudio(); };
  el.addEventListener('pointerdown', set(true));
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(ev, set(false));
}
let padPrev = [];
function readInput() {
  const k = (...c) => c.some((x) => keys.has(x));
  let throttle = k('KeyW', 'ArrowUp') ? 1 : 0;
  let brake = k('KeyS', 'ArrowDown') ? 1 : 0;
  let steer = (k('KeyA', 'ArrowLeft') ? 1 : 0) - (k('KeyD', 'ArrowRight') ? 1 : 0);
  let boost = k('ShiftLeft', 'ShiftRight');
  let slide = k('Space');
  let analog = false;
  if (touchMode) {
    throttle = touchState.brake ? 0 : 1; brake = touchState.brake ? 1 : 0;
    steer += (touchState.left ? 1 : 0) - (touchState.right ? 1 : 0);
    boost = boost || touchState.boost;
    slide = slide || touchState.slide;
  }
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const gp of pads) {
    if (!gp) continue;
    HAPTIC.pad = gp.index;
    // a response curve past the dead zone: fine corrections at speed, full lock still at the stop
    const ax = gp.axes[0] || 0, DZ = 0.12;
    if (Math.abs(ax) > DZ) { steer = -Math.sign(ax) * ((Math.abs(ax) - DZ) / (1 - DZ)) ** 1.5; analog = true; }
    const rt = gp.buttons[7]?.value || 0, lt = gp.buttons[6]?.value || 0;
    if (rt > 0.05 || gp.buttons[0]?.pressed) throttle = Math.max(throttle, gp.buttons[0]?.pressed ? 1 : rt);
    if (lt > 0.05) brake = Math.max(brake, lt);
    if (gp.buttons[2]?.pressed || gp.buttons[5]?.pressed) boost = true;
    if (gp.buttons[4]?.pressed || gp.buttons[1]?.pressed) slide = true;
    const pressed = gp.buttons.map((b) => b.pressed);
    if (pressed[9] && !padPrev[9]) onPress.Escape?.();
    if (pressed[3] && !padPrev[3]) onPress.KeyC?.();
    padPrev = pressed;
    break;
  }
  return { throttle, brake, steer: clamp(steer, -1, 1), boost, slide, analog };
}
// gamepad rumble: the warning strip before the sand, the sand, a slide, the boost, and pulses for hits
const HAPTIC = { pad: -1, t: 0, pulse: 0 };
function haptics(dt) {
  HAPTIC.pulse = Math.max(0, HAPTIC.pulse - dt * 4);
  if ((HAPTIC.t -= dt) > 0 || HAPTIC.pad < 0) return;
  HAPTIC.t = 0.09;
  const act = navigator.getGamepads?.()[HAPTIC.pad]?.vibrationActuator;
  if (!act?.playEffect) return;
  const p = player, live = state === 'race' && !MP.menuOpen && !p.finished, sp = clamp(Math.abs(p.fwd) / 150, 0, 1);
  const strong = live ? Math.min(1, HAPTIC.pulse + p.off * 0.45 * sp + (p.boosting ? 0.1 : 0)) : 0;
  const weak = live ? Math.min(1, HAPTIC.pulse * 0.5 + p.edge * 0.5 * sp + p.slide * 0.25 * smooth(0.1, 0.4, p.slip) + (p.boosting ? 0.15 : 0)) : 0;
  if (strong < 0.02 && weak < 0.02) return;
  act.playEffect('dual-rumble', { duration: 120, strongMagnitude: strong, weakMagnitude: weak }).catch(() => {});
}

// ============================================================
//  Effects
// ============================================================
let shake = 0;
// Parts that come off in a crash (docs/visual-next-steps.md F6): the pod's breakable parts nearest the contact.
// Each flies off as itself (its node taken out of the pod: playerPod.js breakPart) and tumbles to the ground, smoking,
// then is put away; its stump stays on the pod until the next race. r.broken is the mask of the parts that are off:
// it goes over the network and into the replay, and those parts' capsules stop counting (hullWorld). Visual only.
const FLYING = [];
const _fq = new THREE.Quaternion(), _fe = new THREE.Euler(), _fv = new THREE.Vector3();
const podOf = (r) => r.mesh?.userData?.pod;
function breakParts(r, x, z, power) {
  const pod = podOf(r);
  if (!pod?.brk?.length) return 0;
  // the contact in body space (the inverse of the mesh's turn)
  const c = Math.cos(r.yaw), s = Math.sin(r.yaw), wx = x - r.x, wz = z - r.z;
  const bx = wx * c - wz * s, bz = wx * s + wz * c;
  const near = pod.brk.map((b, k) => ({ k, d: Math.hypot(b.x - bx, b.z - bz) })).filter((o) => !((r.broken || 0) & (1 << o.k)) && o.d < 5)
    .sort((a, b) => a.d - b.d);
  const n = Math.min(near.length, power > 75 ? 3 : power > 52 ? 2 : 1);
  for (let i = 0; i < n; i++) flyPart(r, near[i].k);
  return n;
}
function flyPart(r, k) {
  const pod = podOf(r), b = pod.brk[k];
  r.broken = (r.broken || 0) | (1 << k);
  if (!b.node) return;
  // its centre in the world now, and in its own frame (it tumbles about that)
  const ctr = r.mesh.localToWorld(new THREE.Vector3(b.x, b.y, b.z));
  breakPart(pod, k);
  b.node.updateWorldMatrix(true, false);
  const off = b.node.worldToLocal(ctr.clone());
  scene.attach(b.node);
  // off it goes: most of the pod's speed, out from the pod's centre and up, tumbling
  const c = Math.cos(r.yaw), s = Math.sin(r.yaw), ox = b.x * c + b.z * s, oz = -b.x * s + b.z * c, ol = Math.hypot(ox, oz) || 1;
  const out = 4 + Math.random() * 7, R = () => Math.random() - 0.5;
  FLYING.push({ r, pod, k, node: b.node, c: ctr, off, vx: (r.vx || 0) * 0.82 + ox / ol * out + R() * 5, vy: 3 + Math.random() * 7, vz: (r.vz || 0) * 0.82 + oz / ol * out + R() * 5,
    wx: R() * 18, wy: R() * 12, wz: R() * 18, t: 0, life: 3.2 + Math.random() * 1.6, size: b.size, smoke: Math.random() < 0.6 });
  // (its bone can now be far from the pod: the pod's meshes must not be culled by their rest bounds meanwhile)
  r.mesh.traverse((o) => { if (o.isSkinnedMesh) o.frustumCulled = false; });
  if (camera.position.distanceTo(ctr) < 250) {
    for (let i = 0; i < Math.round(14 * PQ); i++) emit(SPARK, ctr.x, ctr.y, ctr.z, (r.vx || 0) * 0.7 + R() * 22, Math.random() * 10, (r.vz || 0) * 0.7 + R() * 22, 0.25 + Math.random() * 0.4, { bright: 7 });
  }
}
function updateFlying(dt) {
  for (let i = FLYING.length - 1; i >= 0; i--) {
    const f = FLYING[i];
    f.t += dt;
    const drag = Math.exp(-0.35 * dt);
    f.vx *= drag; f.vz *= drag; f.vy -= 22 * dt;
    f.c.x += f.vx * dt; f.c.y += f.vy * dt; f.c.z += f.vz * dt;
    const g = groundQuery(f.c.x, f.c.z) + 0.08 + f.size * 0.12;
    if (f.c.y < g) {
      f.c.y = g;
      if (f.vy < -2) {
        const hit = Math.min(1, -f.vy / 12);
        if (camera.position.distanceTo(f.c) < 200) emit(DUST, f.c.x, g, f.c.z, f.vx * 0.3, 1 + hit * 3, f.vz * 0.3, 0.8 + hit, { ground: g - 0.1, size0: 0.6 + f.size * 0.3, size1: 2 + f.size, alpha: 0.35 });
        f.vy = -f.vy * 0.32; f.vx *= 0.55; f.vz *= 0.55; f.wx *= 0.5; f.wy *= 0.5; f.wz *= 0.5;
      } else { f.vy = Math.max(0, f.vy); f.vx *= 1 - Math.min(1, 4 * dt); f.vz *= 1 - Math.min(1, 4 * dt); f.wx *= 1 - Math.min(1, 5 * dt); f.wy *= 1 - Math.min(1, 5 * dt); f.wz *= 1 - Math.min(1, 5 * dt); }
    }
    _fq.setFromEuler(_fe.set(f.wx * dt, f.wy * dt, f.wz * dt));
    f.node.quaternion.premultiply(_fq);
    f.node.position.copy(_fv.copy(f.off).applyQuaternion(f.node.quaternion)).negate().add(f.c);
    if (f.smoke && f.t < 2 && Math.random() < dt * 14 * PQ) emit(SMOKE, f.c.x, f.c.y, f.c.z, f.vx * 0.2, 1.5, f.vz * 0.2, 1 + Math.random() * 0.6, { alpha: 0.35 * (1 - f.t / 2), size0: 0.4, size1: 2.5 });
    // it sinks into the sand at the end of its life, then is put away
    if (f.t > f.life - 0.6) f.c.y -= dt * f.size * 0.9;
    if (f.t >= f.life) {
      stowPart(f.pod, f.k);
      FLYING.splice(i, 1);
      if (!FLYING.some((o) => o.pod === f.pod)) f.r.mesh.traverse((o) => { if (o.isSkinnedMesh) o.frustumCulled = true; });
    }
  }
}
// r (a racer or a replay proxy) to the parts mask m: parts newly off fly off, parts back are put back at once
// (instant: none fly)
function partsTo(r, m, instant = false) {
  const pod = podOf(r), was = r.broken || 0;
  if (!pod?.brk?.length) { r.broken = m; return; }
  if (was & ~m || instant) {
    for (let i = FLYING.length - 1; i >= 0; i--) if (FLYING[i].pod === pod) { stowPart(pod, FLYING[i].k); FLYING.splice(i, 1); }
    setBroken(pod, m); r.broken = m;
    return;
  }
  for (let k = 0; k < pod.brk.length; k++) if (m & ~was & (1 << k)) flyPart(r, k);
  r.broken = m;
}
// every pod whole again (a new race, a replay starting)
function partsReset() {
  for (const f of FLYING) stowPart(f.pod, f.k);
  FLYING.length = 0;
  for (const r of racers) {
    r.broken = 0;
    const pod = podOf(r);
    if (pod?.brk) { setBroken(pod, 0); r.mesh.traverse((o) => { if (o.isSkinnedMesh) o.frustumCulled = true; }); }
  }
}

// Hard hits (visual only; the physics is unchanged): a fireball, the beam snaps, parts tear off (F6) and panels,
// the pod shudders and one engine trails smoke for a few seconds.
const CRASH_POWER = 40;
function crashFx(r, x, z, power, replay = false) {
  if ((r.crashCD ?? 0) > 0) return;
  r.crashCD = 3;
  if (!replay) r.crashN = (r.crashN ?? 0) + 1;
  if (!replay && (state === 'race' || state === 'finished')) HUD.crash(r, player, raceT);
  // (the parts that come off: on this machine only for the pods it drives; the others' come with their state)
  const torn = !replay && r.ctl !== 'net' ? breakParts(r, x, z, power) : 0;
  r.dmg = 4.5; r.shudder = 1; r.dmgEngine = Math.random() < 0.5 ? 0 : 1;
  const ud = r.mesh.userData;
  ud.beam?.snap();
  const d = Math.hypot(x - player.x, z - player.z);
  if (d < 160) { sfx('crash', Math.min(1, power / 70) * (1 - d / 160)); sfx('zap', 0.8 * (1 - d / 160)); }
  if (r === player) { FX.flash = Math.max(FX.flash, 0.45); shake = Math.max(shake, 1); HAPTIC.pulse = 1; }
  if (camera.position.distanceTo(r.mesh.position) > 300) return;
  const y = r.y, R = () => Math.random() - 0.5;
  for (let k = 0; k < 3; k++) {
    emit(BLAST, x + R() * 2.5, y + R(), z + R() * 2.5, r.vx * 0.8 + R() * 6, 2 + Math.random() * 3, r.vz * 0.8 + R() * 6,
      1.5 + Math.random() * 0.7, { size0: 2.4 + Math.random(), size1: 7 + Math.random() * 3 });
  }
  ud.engines[r.dmgEngine].getWorldPosition(_v3);
  emit(BLAST, _v3.x, _v3.y, _v3.z, r.vx * 0.85, 2, r.vz * 0.85, 1.3, { size0: 2, size1: 6 });
  const paint = r.color ?? racers[r.n].color;
  for (let k = 0; k < Math.round((torn ? 3 : 8) * PQ); k++) {
    METAL.emit(x + R() * 2, y + R(), z + R() * 2, r.vx * 0.7 + R() * 18, 5 + Math.random() * 10, r.vz * 0.5 + R() * 18,
      0.45 + Math.random() * 0.7, k % 4, paint, Math.random() < 0.4 ? 1.6 : 0);
  }
  for (let k = 0; k < Math.round(4 * PQ); k++) {
    METAL.emit(x + R() * 2, y, z + R() * 2, r.vx * 0.7 + R() * 14, 4 + Math.random() * 8, r.vz * 0.5 + R() * 14,
      0.35 + Math.random() * 0.4, 4 + (k % 3), '#3b3733', Math.random() < 0.5 ? 1.2 : 0);
  }
  for (let k = 0; k < Math.round(40 * PQ); k++) {
    emit(SPARK, x, y, z, r.vx * 0.6 + R() * 40, Math.random() * 16, r.vz * 0.6 + R() * 40, 0.3 + Math.random() * 0.6, { bright: 6 + Math.random() * 6 });
  }
}

// collisions: sparks, dust, rock chips and (when it is us) a camera kick and a flash. ct (the new collisions, F):
// where the hull touched: y (the height on the pod), nx/nz (the normal out of what it hit), mat (the solid's
// material), cap (the hull capsule), pod (the other pod, pod against pod). ?gfx=hitfx:0: the old effects.
function hitFx(r, x, z, power, rock = false, ct = null) {
  if (power >= CRASH_POWER) crashFx(r, x, z, power);
  else if (power > 15) r.mesh.userData.beam?.hit(power / 40);
  const R = () => Math.random() - 0.5;
  const g = groundQuery(x, z);
  const near = camera.position.distanceTo(_v3.set(x, r.y, z)) < 300;
  if (Q.hitfx && ct) {
    const y = r.y + ct.y, nx = ct.nx, nz = ct.nz;
    kickPod(r, x, z, nx, nz, power, ct.cap);
    if (near) {
      // sparks from where it touched: dragged along the way the pod slides, thrown off the surface, white-hot and
      // cooling, skipping off the ground
      const vn = r.vx * nx + r.vz * nz, tx = r.vx - nx * vn, tz = r.vz - nz * vn;
      const n = Math.round(Math.min(60, power * 1.6) * PQ);
      for (let k = 0; k < n; k++) {
        const a = 0.35 + Math.random() * 0.6, o = 2 + Math.random() * 10;
        emit(SPARK, x + R() * 0.5, y + R() * 0.6, z + R() * 0.5, tx * a + nx * o + R() * 9, 1 + Math.random() * 9, tz * a + nz * o + R() * 9,
          0.35 + Math.random() * 0.65, { bright: 6 + Math.random() * 7, ground: g, cool: true, bounce: 0.35 });
      }
      // the flash where it bit
      emit(FIRE, x + nx * 0.3, y, z + nz * 0.3, tx * 0.25, 0.5, tz * 0.25, 0.06 + Math.random() * 0.04, { bright: 2.5 + Math.min(4, power * 0.06), size0: 0.7 + Math.min(1.5, power * 0.02), size1: 2 + Math.min(3, power * 0.05) });
      const arena = ct.mat === SOLID_MAT.arena, pod = ct.pod;
      // dust and grit blown off the face and rolling up it (the arena's: pale plaster)
      for (let k = 0; k < Math.min(12, power * 0.35) * (pod ? 0.3 : 1); k++) {
        emit(DUST, x + nx * 0.6 + R() * 1.5, y - 0.4 + Math.random() * 0.8, z + nz * 0.6 + R() * 1.5, tx * 0.25 + nx * (1.5 + Math.random() * 4), 1.5 + Math.random() * 4, tz * 0.25 + nz * (1.5 + Math.random() * 4),
          1 + Math.random() * 1.2, { ground: g, size0: 1.2 + Math.random(), size1: 5 + power * 0.06, alpha: 0.35, color: arena ? '#efe4d2' : undefined });
      }
      // rock chips knocked off, flung out from the face
      if (!pod && power > 8) {
        for (let k = 0; k < Math.min(10, power * 0.18) * PQ; k++) {
          DEBRIS.emit(x + nx * 0.3, y, z + nz * 0.3, tx * 0.35 + nx * (3 + Math.random() * 7) + R() * 6, 3 + Math.random() * 8, tz * 0.35 + nz * (3 + Math.random() * 7) + R() * 6, (arena ? 0.08 : 0.12) + Math.random() * (arena ? 0.2 : 0.35));
        }
      }
      // pod against pod: flecks of the other one's paint, and the two beams arc
      if (pod) {
        const paint = pod.color ?? racers[pod.n].color;
        for (let k = 0; k < Math.min(14, power * 0.4) * PQ; k++) {
          emit(CONFETTI, x + R() * 0.6, y + R() * 0.5, z + R() * 0.6, tx * 0.5 + nx * (2 + Math.random() * 6) + R() * 6, 2 + Math.random() * 5, tz * 0.5 + nz * (2 + Math.random() * 6) + R() * 6,
            3, { color: Math.random() < 0.7 ? paint : '#3b3733', size0: 0.06 + Math.random() * 0.1, size1: 0.08, grav: 9.8, drag: 0.6, spin: 14, ground: g });
        }
        if (power > 8) { r.mesh.userData.beam?.hit(Math.min(1, power / 30)); pod.mesh?.userData.beam?.hit(Math.min(1, power / 30)); }
      }
    }
  } else {
    const n = Math.round(Math.min(40, power * 1.2) * PQ);
    const y = r.y - 0.3;
    for (let k = 0; k < n; k++) {
      emit(SPARK, x, y, z, (Math.random() - 0.5) * 30 + r.vx * 0.6, Math.random() * 12, (Math.random() - 0.5) * 30 + r.vz * 0.6, 0.25 + Math.random() * 0.5, { bright: 5 + Math.random() * 5 });
    }
    for (let k = 0; k < Math.min(10, power * 0.3); k++) {
      emit(DUST, x + (Math.random() - 0.5) * 3, y, z + (Math.random() - 0.5) * 3, r.vx * 0.3 + (Math.random() - 0.5) * 10, 2 + Math.random() * 6, r.vz * 0.3 + (Math.random() - 0.5) * 10, 1 + Math.random(), { ground: g, size0: 2, size1: 7 });
    }
    if (rock && power > 12) {
      for (let k = 0; k < Math.min(8, power * 0.15) * PQ; k++) {
        DEBRIS.emit(x, y + 0.5, z, r.vx * 0.4 + (Math.random() - 0.5) * 14, 4 + Math.random() * 9, r.vz * 0.4 + (Math.random() - 0.5) * 14, 0.15 + Math.random() * 0.45);
      }
    }
  }
  const y = r.y - 0.3;
  if (power > 30) emit(SMOKE, x, y + 1, z, r.vx * 0.2, 3, r.vz * 0.2, 1.6, { size0: 3, size1: 10, alpha: 0.4 });
  const d = Math.hypot(x - player.x, z - player.z);
  if (d < 70) {
    const k = clamp(power / 45, 0.1, 1) * (1 - d / 70);
    shake = Math.max(shake, k);
    if (r === player && power > 25) FX.flash = Math.max(FX.flash, Math.min(0.35, power / 160));
    if (r === player) HAPTIC.pulse = Math.max(HAPTIC.pulse, clamp(power / 40, 0.3, 1));
    sfx('hit', k);
  }
}
// The pod reacts to a hit (F4, visual): the body rolls up on the side that was struck and pitches (a nose hit lifts
// the nose), on a spring; the cockpit whips on its cables (the swing spring in racerFx); the struck engine is
// knocked aside on its own spring; the body shudders with the hit.
function kickPod(r, x, z, nx, nz, power, cap) {
  const c = Math.cos(r.yaw), s = Math.sin(r.yaw), wx = x - r.x, wz = z - r.z;
  const bx = wx * c - wz * s, bz = wx * s + wz * c, nbx = nx * c - nz * s;      // the contact and the push, body space
  const k = Math.min(1, power / 45);
  r.krv = (r.krv || 0) + Math.sign(bx || 1) * Math.min(1, Math.abs(bx) / 2.5) * k * 1.6;
  r.kpv = (r.kpv || 0) + (bz > 2.5 ? -1 : bz < -1.5 ? 1 : 0) * k * 0.9;
  // the cockpit hangs behind on its cables: a shove of the engines leaves it behind, a hit on it pushes it
  r.swingV = (r.swingV || 0) + (bz > 0.5 ? 1 : -1) * nbx * k * 2.2;
  const hc = cap != null ? r.hull.caps[cap] : null;
  if (hc && Math.abs(hc.ax + hc.bx) > 1.5) {
    const e = (hc.ax + hc.bx > 0 ? 0 : 1);
    r.knock = r.knock || [{ x: 0, v: 0, y: 0, w: 0 }, { x: 0, v: 0, y: 0, w: 0 }];
    r.knock[e].v += nbx * k * 3; r.knock[e].w += k * 2;
  }
  if (power > 10) r.shudder = Math.max(r.shudder || 0, Math.min(0.55, power / 80));
}
let toastTimer = 0;
const toastEl = document.getElementById('toast');
// the middle slot: lap times and toggles, and warnings in red (sub: a smaller second line)
function toast(text, warn = false, dur = 1.6, sub = '') {
  toastEl.textContent = text;
  if (sub) toastEl.appendChild(document.createElement('small')).textContent = sub;
  toastEl.classList.toggle('warn', warn);
  toastEl.hidden = false;
  toastTimer = dur;
}
function onOverheat() { toast('TÚLMELEGEDÉS', true, 1.8, '3 MÁSODPERCIG NINCS BOOST'); sfx('boom', 0.6); }

// world metres per pixel at 1 m from the camera (beam strands keep a minimum on-screen width)
let PX_SCALE = 0.001;
const BEAM_LIST = [];
const BEAM_LIGHTS = createBeamLights(scene, Q.name === 'low' ? 0 : Q.name === 'medium' ? 1 : 2);
function beamLights() {
  PX_SCALE = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / Math.max(1, renderer.domElement.height);
  if (!BEAM_LIST.length) return;     // paused / photo mode: no pod updates, keep the lights where they are
  BEAM_LIST.sort((a, b) => a.camD - b.camD);
  BEAM_LIGHTS.update(BEAM_LIST);
  BEAM_LIST.length = 0;
}
const SWING_PIVOT = 3.0;     // body-space z the cockpit swings about: where its cables meet the engines
const FLAME_COL = { idle: new THREE.Color('#ffb066').multiplyScalar(2.2), boost: new THREE.Color('#cfe2ff').multiplyScalar(3.5), over: new THREE.Color('#ff5a2a').multiplyScalar(2) };
const POD_FX = { hot: 0, flash: 0, beam: 0, beamCol: new THREE.Color() };
function racerFx(r, dt, t) {
  const m = r.mesh, ud = m.userData;
  m.position.set(r.x, r.y, r.z);
  m.rotation.y = r.yaw;
  const sp = Math.abs(r.fwd);
  // the slide angle as seen (network pods and the replay do not carry r.slip)
  const slipV = Math.atan2(Math.abs(r.lat || 0), Math.max(4, sp)), slideV = r.slide || 0;
  r.roll = damp(r.roll, r.steer * 0.42 * clamp(sp / 50, 0, 1) + clamp((r.lat || 0) * 0.012, -0.15, 0.15) + slideV * 0.1 * Math.sign(r.steer), 6, dt);
  ud.body.rotation.set(r.pitch, 0, -r.roll);
  // a hit's kick (kickPod, F4): roll and pitch on a spring that rings out in about half a second
  if (r.krv || r.kr || r.kpv || r.kp) {
    r.krv += (-r.kr * 150 - r.krv * 9) * dt; r.kr = clamp(r.kr + r.krv * dt, -0.3, 0.3);
    r.kpv += (-r.kp * 150 - r.kpv * 9) * dt; r.kp = clamp(r.kp + r.kpv * dt, -0.2, 0.2);
    ud.body.rotation.z += r.kr; ud.body.rotation.x += r.kp;
    if (Math.abs(r.kr) + Math.abs(r.krv) + Math.abs(r.kp) + Math.abs(r.kpv) < 1e-4) r.kr = r.krv = r.kp = r.kpv = 0;
  }
  if (r.knock) for (const kn of r.knock) { kn.v += (-kn.x * 220 - kn.v * 12) * dt; kn.x += kn.v * dt; kn.w += (-kn.y * 220 - kn.w * 12) * dt; kn.y += kn.w * dt; }
  // the cockpit hangs on its cables behind the engines: it swings out in a turn (and overshoots a little coming out
  // of it), and the outer engine leads with both engines toed into the turn. Visual only.
  const yr = dt > 0 ? wrapAngle(r.yaw - (r.fxYaw ?? r.yaw)) / dt : 0;
  r.fxYaw = r.yaw;
  r.fxYr = damp(r.fxYr || 0, clamp(yr, -3, 3), 12, dt);
  const latAcc = r.fwd * r.fxYr;                         // m/s², + = turning left
  r.swingV = (r.swingV || 0) + ((clamp(latAcc / 600, -0.14, 0.14) - (r.swing || 0)) * 70 - (r.swingV || 0) * 8) * dt;
  r.swing = clamp((r.swing || 0) + r.swingV * dt, -0.2, 0.2);
  if (ud.cockpit) {
    ud.cockpit.rotation.y = r.swing;
    ud.cockpit.position.set(-SWING_PIVOT * Math.sin(r.swing), 0, SWING_PIVOT * (1 - Math.cos(r.swing)));
  }
  const lead = clamp(latAcc / 80, -1, 1);
  if (r.shudder > 0) {
    // after a crash the body shakes itself out
    r.shudder = Math.max(0, r.shudder - dt * 1.3);
    const w = r.shudder * r.shudder;
    ud.body.rotation.x += Math.sin(t * 37) * 0.1 * w;
    ud.body.rotation.z += Math.sin(t * 29 + 1) * 0.28 * w;
  }
  if (r.crashCD > 0) r.crashCD -= dt;
  let by = 0;
  ud.engines.forEach((e, k) => {
    const kn = r.knock?.[k];
    const y = 0.15 + Math.sin(t * 6.3 + k * 2.1 + r.phase) * 0.07 + (kn ? kn.y : 0);
    e.position.y = y; by += y / 2;
    if (e.userData.x0 === undefined) e.userData.x0 = e.position.x;
    e.position.x = e.userData.x0 + (kn ? clamp(kn.x, -0.4, 0.4) : 0);           // (knocked aside by a hit, F4)
    e.rotation.z = Math.sin(t * 4.1 + k + r.phase) * 0.05;
    if (e.userData.z0 === undefined) e.userData.z0 = e.position.z;
    e.position.z = e.userData.z0 + 0.3 * lead * (e.position.x < 0 ? 1 : -1);    // the right engine (x < 0) leads a left turn
    e.rotation.y = lead * 0.05;
    const f = e.userData.flame;
    const s = (r.overheat > 0 ? 1.0 : 1.3 + r.throttle * 1.5 + (r.boosting ? 2.4 : 0)) * (0.9 + Math.random() * 0.2) * (Q.post ? 0.5 : 1);
    f.scale.set(s, s, s);
    f.userData.col.copy(r.overheat > 0 ? FLAME_COL.over : r.boosting ? FLAME_COL.boost : FLAME_COL.idle);
  });
  const camD = camera.position.distanceTo(m.position);
  ud.beam.update(r, dt, t + r.phase, camD, PX_SCALE);
  if (camD < 150) {
    // the emitters spit sparks, more when the beam strains, overheats or has just snapped
    const S = ud.beam.S, n = Math.floor(S.sparks * dt * PQ + Math.random() * Math.min(1, S.sparks * dt * PQ));
    for (let k = 0; k < n; k++) {
      ud.beam.end(Math.random() < 0.5 ? 0 : 1, _v3);
      emit(SPARK, _v3.x, _v3.y, _v3.z, r.vx * 0.85 + (Math.random() - 0.5) * 9, Math.random() * 6, r.vz * 0.85 + (Math.random() - 0.5) * 9,
        0.12 + Math.random() * 0.25, { color: Math.random() < 0.5 ? '#ff7ae6' : '#ffe2fa', bright: 7 });
    }
  }
  BEAM_LIST.push({ beam: ud.beam, camD });
  const pfx = ud.fx;
  if (ud.hot && pfx) ud.hot.emissiveIntensity = (pfx.hot * pfx.hot * 2.2 + Math.max(pfx.flash[0], pfx.flash[1]) * 2) * (Q.post ? 1 : 0.6);
  if (ud.pod) {
    POD_FX.hot = pfx ? pfx.hot : 0; POD_FX.flash = pfx ? Math.max(pfx.flash[0], pfx.flash[1]) : 0;
    POD_FX.beam = ud.beam.S.k + ud.beam.S.flash[0] * 0.5; POD_FX.beamCol.copy(ud.beam.group.children[0].material.uniforms.uCol.value);
    animatePlayerPod(ud.pod, r, dt, POD_FX);
    // the player's pod reflects the live cube (?gfx=refl:1) instead of the baked probes
    if (LIVE?.texture && r === player) setPodEnv(ud.pod, LIVE.texture, null, 0, PROBE_K);
    else if (PROBES) { const [base, b, w] = podProbe(r); setPodEnv(ud.pod, base, b, w, PROBE_K); }
    ud.body.position.y = podLift(ud.pod, r, rideOf(r), dt);
  }
  podFx.update(r, dt, rideOf(r), camera.position);       // also brings the pod's world matrices up to date
  ud.beam.pushFlares();
  for (const e of ud.engines) { const f = e.userData.flame; if (shown(f)) FLAMES.push(f.matrixWorld, f.userData.col); }
  // boost kicks in: shockwave ring (the ignition flash and ring of fire come from podFx)
  if (r.boosting && !r.wasBoost) {
    podFx.shockwave(r);
    if (r === player) { sfx('boostStart'); shake = Math.max(shake, 0.25); HAPTIC.pulse = Math.max(HAPTIC.pulse, 0.35); }
  }
  r.wasBoost = r.boosting;
  if (camD > 420) return;
  const fx = Math.sin(r.yaw), fz = Math.cos(r.yaw);
  const gy = rideOf(r)(r.x, r.z), h = r.y - gy;
  // dust trail: thicker on sand, nothing when flying high
  if (sp > 8 && h < 5) {
    const rate = sp * (0.32 + r.off * 1.1) * dt * PQ;
    const n = Math.floor(rate + Math.random());
    for (let k = 0; k < n; k++) {
      const side = (Math.random() - 0.5) * 5;
      const x = r.x - fx * 4 - fz * side, z = r.z - fz * 4 + fx * side;
      emit(DUST, x, gy + 0.4, z, r.vx * 0.3 + (Math.random() - 0.5) * 6, 1.5 + Math.random() * 4, r.vz * 0.3 + (Math.random() - 0.5) * 6,
        0.9 + Math.random() * 1.3, { ground: gy, size0: 2 + r.off * 2, size1: 7 + r.off * 7 + sp * 0.03 });
    }
    // rooster tail thrown up behind the pod when it is out on the sand
    if (r.off > 0.3 && sp > 30) {
      const n2 = Math.floor(sp * r.off * 0.18 * dt * PQ + Math.random());
      for (let k = 0; k < n2; k++) {
        const side = (Math.random() - 0.5) * 3;
        emit(DUST, r.x - fx * 5 - fz * side, gy + 0.5, r.z - fz * 5 + fx * side, r.vx * 0.15 + (Math.random() - 0.5) * 5, 7 + Math.random() * 10, r.vz * 0.15 + (Math.random() - 0.5) * 5,
          1.4 + Math.random() * 1.2, { ground: gy, size0: 2.5, size1: 12, color: '#e3c49a', alpha: 0.5 });
      }
    }
  }
  // a slide throws a sheet of sand out to the side the pod slides toward
  if (slideV > 0.3 && sp > 20 && h < 5) {
    const k = slideV * smooth(0.08, 0.35, slipV), side = Math.sign(r.lat || 0) || 1, rx = -fz * side, rz = fx * side;
    const n = Math.floor(k * sp * 0.3 * dt * PQ + Math.random() * Math.min(1, k * 2));
    for (let i = 0; i < n; i++) {
      const back = (Math.random() - 0.3) * 6, out = 6 + Math.random() * 10;
      const x = r.x + rx * 2.6 - fx * back, z = r.z + rz * 2.6 - fz * back;
      emit(DUST, x, gy + 0.4, z, r.vx * 0.35 + rx * out, 1.5 + Math.random() * 4, r.vz * 0.35 + rz * out,
        0.9 + Math.random() * 0.9, { ground: gy, size0: 1.8, size1: 8 + r.off * 4, alpha: 0.32, color: '#e3c49a' });
    }
  }
  // exhaust blast: low over the ground each jet kicks up a V of sand behind it, much more off the track
  if (h < 4.5 && camD < 220 && r.throttle > 0.2) {
    const k = (1 - h / 4.5) * (0.35 + r.off * 1.4) * (r.throttle + (r.boosting ? 1 : 0));
    const n = Math.floor(k * 22 * dt * PQ + Math.random());
    for (let i = 0; i < n; i++) {
      const e = ud.engines[i & 1];
      e.getWorldPosition(_v3);
      const side = e.position.x > 0 ? 1 : -1, back = 6 + Math.random() * 6;
      const x = _v3.x - fx * back, z = _v3.z - fz * back, g = groundQuery(x, z);
      // outward (away from the pod's centre line) and up, while the pod pulls away
      const out = 5 + Math.random() * 7;
      emit(DUST, x, g + 0.3, z, r.vx * 0.2 + fz * side * out, 2 + Math.random() * 4, r.vz * 0.2 - fx * side * out,
        0.8 + Math.random() * 0.9, { ground: g, size0: 1.5, size1: 6 + r.off * 4, alpha: 0.22 + r.off * 0.12, color: '#e0c39a' });
    }
  }
  // repulsor wash when hovering slowly: puffs pushed out along the ground
  if (sp < 35 && h < 3.5 && Math.random() < dt * (6 + r.throttle * 26) * PQ) {
    const a = Math.random() * TAU, rr = 2 + Math.random() * 2;
    emit(DUST, r.x + Math.cos(a) * rr, gy + 0.3, r.z + Math.sin(a) * rr, Math.cos(a) * (6 + r.throttle * 8), 0.6 + Math.random(), Math.sin(a) * (6 + r.throttle * 8),
      1 + Math.random(), { ground: gy, size0: 1.2, size1: 5, alpha: 0.3 });
  }
  // grinding along a wall: a stream of sparks at the contact point (F5: from where the hull touches, dragged along
  // the face, thrown off it, cooling and skipping off the ground, with grit off the face)
  if (r.scrape > 0) {
    const n = Math.floor(r.scrape * 90 * dt * PQ + Math.random());
    if (Q.hitfx && r.scrapeN) {
      const nx = r.scrapeNX, nz = r.scrapeNZ, vn = r.vx * nx + r.vz * nz, tx = r.vx - nx * vn, tz = r.vz - nz * vn;
      const sy = r.y + r.scrapeY, g = groundQuery(r.scrapeX, r.scrapeZ), R = () => Math.random() - 0.5;
      for (let k = 0; k < n * 1.4; k++) {
        const a = 0.5 + Math.random() * 0.45, o = 1 + Math.random() * 5;
        emit(SPARK, r.scrapeX + R() * 0.4, sy + R() * 0.6, r.scrapeZ + R() * 0.4, tx * a + nx * o + R() * 5, 0.5 + Math.random() * 5, tz * a + nz * o + R() * 5,
          0.3 + Math.random() * 0.5, { bright: 5 + Math.random() * 4, ground: g, cool: true, bounce: 0.3 });
      }
      if (Math.random() < dt * 14 * r.scrape * PQ) {
        emit(DUST, r.scrapeX + nx * 0.5, sy, r.scrapeZ + nz * 0.5, tx * 0.3 + nx * 2, 1 + Math.random() * 2, tz * 0.3 + nz * 2, 0.9 + Math.random() * 0.6,
          { ground: g, size0: 0.8, size1: 3.5, alpha: 0.28, color: r.scrapeMat === SOLID_MAT.arena ? '#efe4d2' : undefined });
      }
    } else for (let k = 0; k < n; k++) {
      emit(SPARK, r.scrapeX, r.y - 0.2 + Math.random() * 0.8, r.scrapeZ, r.vx * 0.5 + (Math.random() - 0.5) * 8, 2 + Math.random() * 6, r.vz * 0.5 + (Math.random() - 0.5) * 8, 0.2 + Math.random() * 0.35, { bright: 6 });
    }
    r.scrape = Math.max(0, r.scrape - dt * 5);
  }
  if (r.dmg > 0) {
    r.dmg -= dt;
    if (camD < 300) {
      const k = Math.min(1, r.dmg / 2);
      ud.engines[r.dmgEngine ?? 0].getWorldPosition(_v3);
      if (Math.random() < dt * 28 * PQ) emit(SMOKE, _v3.x, _v3.y + 0.4, _v3.z, r.vx * 0.55, 2 + Math.random() * 2, r.vz * 0.55, 1.1 + Math.random() * 0.6, { alpha: 0.45 * k, size0: 1, size1: 5.5 });
      if (Math.random() < dt * 10 * k) emit(FIRE, _v3.x, _v3.y + 0.2, _v3.z, r.vx * 0.7, 1.5, r.vz * 0.7, 0.2 + Math.random() * 0.15, { bright: 2.5, size0: 0.7, size1: 1.8 });
    }
  }
  if (r.overheat > 0 && camD < 300 && Math.random() < dt * 12) {
    const e = ud.engines[Math.random() < 0.5 ? 0 : 1];
    e.getWorldPosition(_v3);
    emit(SMOKE, _v3.x, _v3.y + 0.5, _v3.z, r.vx * 0.6, 3 + Math.random() * 3, r.vz * 0.6, 1 + Math.random(), { alpha: 0.35, size0: 1.2, size1: 5 });
    if (Math.random() < 0.5) emit(FIRE, _v3.x, _v3.y + 0.3, _v3.z, r.vx * 0.7, 2, r.vz * 0.7, 0.2 + Math.random() * 0.2, { bright: 2.5, size0: 0.8, size1: 2 });
  }
}
const _v3 = new THREE.Vector3();

// air streaks that rush past the camera at speed, and sand blowing across the dunes
const _wnc = { i: 0, d: 0 }, _wtp = { x: 0, y: 0, z: 0, yaw: 0, i: 0 };
function updateWind(dt) {
  const racing = state === 'race' || state === 'finished';
  const sp = Math.abs(player.fwd), k = racing ? clamp((sp - 60) / 120, 0, 1) : 0;
  const fx = Math.sin(player.yaw), fz = Math.cos(player.yaw);
  const n = Math.floor(k * 160 * dt + Math.random() * k);
  for (let i = 0; i < n; i++) {
    const along = 18 + Math.random() * 60, a = Math.random() * TAU, rad = 5 + Math.random() * 14;
    const x = camera.position.x + fx * along + Math.cos(a) * rad * -fz;
    const z = camera.position.z + fz * along + Math.cos(a) * rad * fx;
    const y = camera.position.y + Math.sin(a) * rad * 0.5 + 1;
    emit(WIND, x, y, z, -player.vx * 0.15, 0, -player.vz * 0.15, 0.5 + Math.random() * 0.3, { alpha: 0.25 + k * 0.35 });
  }
  // the one wind (?gfx=gust:1, E2): the sand moves with the gust where it is; without it, a steady 0.5
  const t = ATMO.hfTime.value, G = (x, z) => (GUST_ON ? gust(x, z, t) : 0.5);
  // the drift stretches (E1) near the camera: a gust lifts a low sheet of sand across the road, and puffs it up
  // where the stream pours over the berm on the downwind side
  let onDrift = 0;
  if (DRIFTP) {
    nearestCoarse(camera.position.x, camera.position.z, _wnc);
    if (_wnc.i >= 0 && _wnc.d < 140) onDrift = driftAt(TR.s[_wnc.i]);
    for (let r = Math.floor(dt * 70 * PQ * onDrift + Math.random()); r > 0; r--) {
      const s = TR.s[_wnc.i] + (Math.random() - 0.3) * 160;
      const kd = driftAt(s);
      if (kd <= 0 || Math.random() > kd) continue;
      trackPoint(((s % TR.L) + TR.L) % TR.L, 0, _wtp);
      const hw = TR.hw[_wtp.i], rx = -Math.cos(_wtp.yaw), rz = Math.sin(_wtp.yaw);
      const berm = Math.random() < 0.3, down = rx * WIND_DIR.x + rz * WIND_DIR.y > 0 ? 1 : -1;
      const d = berm ? down * (hw + 2 + Math.random() * 2) : (Math.random() * 2 - 1) * (hw + 18);
      const x = _wtp.x + rx * d, z = _wtp.z + rz * d, gu = G(x, z);
      if (Math.random() > (berm ? gu * gu * 1.6 : 0.1 + 0.9 * gu)) continue;
      const y = surfaceAt(_wtp.i, s, d, x, z), v = (8 + Math.random() * 4) * (0.6 + 0.7 * gu);
      if (berm) emit(DRIFTP, x, y + 0.6, z, WIND_DIR.x * v * 0.7, 1.4 + Math.random() * 1.6, WIND_DIR.y * v * 0.7, 1.6 + Math.random() * 1.2,
        { ground: y, size0: 1.5 + Math.random(), size1: 6 + Math.random() * 4, alpha: 0.1 + 0.14 * gu });
      else emit(DRIFTP, x, y + 0.3 + Math.random() * 0.8, z, WIND_DIR.x * v, 0.2 + Math.random() * 0.3, WIND_DIR.y * v, 1.8 + Math.random() * 1.4,
        { ground: y, size0: 2 + Math.random() * 1.5, size1: 5 + Math.random() * 4, alpha: 0.05 + 0.13 * gu });
    }
  }
  // grains hitting the lens in the sand streams (?gfx=lens:1, E8), more in a gust and at speed
  if (Q.lens) LENS.grit.value = onDrift * Math.min(1, 0.3 + 1.2 * G(camera.position.x, camera.position.z)) * (0.4 + 0.6 * k);
  // streamers: ribbons of grains sliding across the track ahead, faster than the air above them (more on the drift
  // stretches)
  if (STREAM && k > 0) {
    const gp = G(player.x, player.z);
    for (let r = Math.floor(k * 26 * (0.4 + 1.2 * gp) * (1 + 2 * onDrift) * dt + Math.random()); r > 0; r--) {
      const along = 12 + Math.random() * 70, side = (Math.random() - 0.5) * 50;
      let x = player.x + fx * along - fz * side, z = player.z + fz * along + fx * side;
      const v = (9 + Math.random() * 6) * (0.7 + 0.6 * gp), n = 3 + Math.floor(Math.random() * 5);
      for (let j = 0; j < n; j++) {
        x += WIND_DIR.y * (Math.random() - 0.5) * 0.8 - WIND_DIR.x * 0.4; z -= WIND_DIR.x * (Math.random() - 0.5) * 0.8 + WIND_DIR.y * 0.4;
        const g = groundQuery(x, z);
        emit(STREAM, x, g + 0.08 + Math.random() * 0.35, z, WIND_DIR.x * v, 0.2 + Math.random() * 0.4, WIND_DIR.y * v, 0.5 + Math.random() * 0.5,
          { alpha: (0.2 + k * 0.25) * (0.6 + 0.8 * gp), ground: g });
      }
    }
  }
  {
    const a = Math.random() * TAU, d = 25 + Math.random() * 110;
    const x = camera.position.x + Math.cos(a) * d, z = camera.position.z + Math.sin(a) * d, gu = G(x, z);
    if (Math.random() < dt * 18 * PQ * (0.25 + 1.5 * gu)) {
      const g = groundQuery(x, z), v = 0.7 + 0.6 * gu;
      emit(SAND, x, g + 0.8 + Math.random() * 2, z, WIND_DIR.x * (5 + Math.random() * 5) * v, 0.3, WIND_DIR.y * (5 + Math.random() * 5) * v, 4 + Math.random() * 3, { ground: g });
    }
  }
  // spindrift: thin veils of sand streaming off the dune brinks downwind (in a gust they thicken and fly
  // faster; a lull leaves a few wisps)
  for (let k = Math.floor(dt * 60 * PQ * (GUST_ON ? 2 : 1) + Math.random()); k > 0; k--) {
    const a = Math.random() * TAU, d = 40 + Math.random() * 260;
    const x = camera.position.x + Math.cos(a) * d, z = camera.position.z + Math.sin(a) * d;
    const cr = duneCrest(x, z);
    if (cr < 0.25 || Math.random() > cr) continue;
    const gu = G(x, z);
    if (GUST_ON && Math.random() > 0.15 + 0.85 * gu) continue;
    const g = groundQuery(x, z), v = (7 + Math.random() * 6) * (0.7 + 0.6 * gu);
    emit(SAND, x, g + 0.3, z, WIND_DIR.x * v, 0.6 + Math.random() * 0.8, WIND_DIR.y * v, 2.2 + Math.random() * 1.5,
      { ground: g - 3, size0: 1.5 + Math.random(), size1: 6 + Math.random() * 5, alpha: (0.1 + cr * 0.08) * (0.7 + 0.6 * gu) });
  }
}

// ============================================================
//  Race control
// ============================================================
let state = 'loading';   // loading | menu | countdown | race | finished | results | paused
let pausedFrom = null;
let laps = 3, diff = 1, raceT = 0, countT = 0, finishWait = 0, lastCount = 0, throttleAt = -1;
let camMode = 0, camYaw = 0, camY = 0, fov = 60, simT = 0, centerTimer = 0, bestLapRace = Infinity, newRecord = false, prevBestLap = Infinity;
const STORE_KEY = 'homokfutam:v1';
const loadStore = () => { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; } };
const saveStore = (o) => { try { localStorage.setItem(STORE_KEY, JSON.stringify(o)); } catch { /* storage blocked */ } };
let store = loadStore();
let debugAuto = false;
let DEBUG_FORCE = null;   // testing hook: input fields forced onto the player after the autopilot
// multiplayer session (null room = solo)
const MP = { room: null, peers: new Map(), myReady: false, inRace: false, menuOpen: false, raceHost: null,
  sendT: 0, joinT: 0, note: '', noteT: 0, rLaps: 3, rDiff: 1 };
const NO_INPUT = { throttle: 0, brake: 0, steer: 0, boost: false, slide: false, analog: true };

const $ = (id) => document.getElementById(id);
const hudEl = $('hud'), touchEl = $('touch'), menuEl = $('menu'), pauseEl = $('pause'), resultEl = $('result'), centerEl = $('center'), roomEl = $('room');
function showScreen(el) { for (const s of [menuEl, roomEl, pauseEl, resultEl]) s.hidden = s !== el; }
function setLights(n, green) {
  const hdr = Q.post ? 5 : 1;
  START_LIGHTS.forEach((l, k) => l.material.color.set(green ? '#55ff86' : k < n ? '#ff3b2a' : '#2b2118').multiplyScalar(green || k < n ? hdr : 1));
}
function standings() {
  const tier = (r) => (r.finished ? 0 : r.gone ? 2 : 1);   // finished, still racing, dropped out
  return [...racers].sort((a, b) => {
    if (tier(a) !== tier(b)) return tier(a) - tier(b);
    if (a.finished) return a.finishTime - b.finishTime;
    return b.prog - a.prog;
  });
}

function newRace() {
  racers.forEach((r) => {
    placeOnGrid(r, r.grid);
    const v = (Math.random() - 0.5) * 0.03;
    r.skill = r.player ? 0.82 : (SKILL[diff] + v) * (aiSlider(r) ? 0.955 : 1);   // (the sliders carry more speed into corners)
    r.topMul = r.player ? 1 : SKILL[diff] + 0.05 + v;
    Object.assign(r, { aiOff: 0, aiOffT: 0, aiBoost: false, lapStart: 0, throttle: 0, brake: 0, boostIn: false, pitch: 0, roll: 0 });
  });
  partsReset();
  raceT = 0; countT = 3.2; finishWait = 0; lastCount = 9; throttleAt = -1; bestLapRace = Infinity; newRecord = false; prevBestLap = store.lap ?? Infinity;
  HUD.reset(racers, { laps, mp: !!MP.room });
  camYaw = player.yaw; camY = player.y + 4; CAMV.dist = CAMS[camMode].d;
  stopReplay();
  TRAILS.clear();
  for (const r of racers) r.trailS = undefined;
  Object.assign(CINE, { introT: MP.room ? 0 : CINE.introLen, finishT: 0, timeScale: 1 });
  REC.frames.length = 0;
  hideCards();
  $('titleSub').textContent = `${laps} KÖR · ARÉNA · SZIKLATŰK · KANYON`;
  setLights(0, false);
  showScreen(null);
  hudEl.hidden = CINE.introT > 0; touchEl.hidden = !touchMode || CINE.introT > 0;
  hudEl.classList.remove('menu-open');
  $('photoBtn').hidden = !!MP.room;
  centerEl.textContent = ''; toastEl.hidden = true;
  $('bestLapVal').classList.remove('fresh');
  $('restartBtn').hidden = !!MP.room;
  $('menuBtn').textContent = MP.room ? 'VISSZA A SZOBÁBA' : 'FŐMENÜ';
  state = 'countdown';
}
function endIntro() {
  CINE.introT = 0;
  hideCards();
  if (state === 'countdown') { hudEl.hidden = false; touchEl.hidden = !touchMode; }
}
function showMenu() {
  state = 'menu';
  stopReplay(); CINE.finishT = 0; CINE.introT = 0; CINE.timeScale = 1; hideCards();
  hudEl.hidden = true; touchEl.hidden = true;
  assignSolo();
  racers.forEach((r) => placeOnGrid(r, r.grid));
  setLights(0, false);
  renderRecord();
  showScreen(menuEl);
}
// the pause menu: with friends the race goes on, so it says so and keeps the live standings in view
function showPause(open) {
  const m = !!MP.room;
  $('pauseTitle').textContent = m ? 'MENÜ' : 'SZÜNET';
  $('pauseLive').hidden = !m; $('pauseNote').hidden = !m;
  $('resumeBtn').firstElementChild.textContent = m ? 'VISSZA A VERSENYBE' : 'FOLYTATÁS';
  hudEl.classList.toggle('menu-open', open);
  showScreen(open ? pauseEl : null);
  if (open) $('resumeBtn').focus({ preventScroll: true });
}
function togglePause() {
  if (MP.room) {               // the race keeps running for everyone else: just an overlay
    if (state !== 'countdown' && state !== 'race' && state !== 'finished') return;
    MP.menuOpen = !MP.menuOpen;
    showPause(MP.menuOpen);
    return;
  }
  if (state === 'photo') { exitPhoto(); return; }
  if (state === 'paused') { state = pausedFrom; showPause(false); hudEl.hidden = CINE.introT > 0; return; }
  if (state === 'countdown' || state === 'race' || state === 'finished') {
    pausedFrom = state; state = 'paused'; showPause(true);
  }
}
function onPlayerLap(lt) {
  sfx('lap');
  CROWD.boost = Math.max(CROWD.boost, 0.6);
  if (player.lap === laps - 1) announce('finalLap');
  if (lt < bestLapRace) { bestLapRace = lt; $('bestLapVal').classList.add('fresh'); }
  if (player.lap < laps) toast(player.lap === laps - 1 ? `UTOLSÓ KÖR · ${fmtTime(lt)}` : `${player.lap + 1}. KÖR · ${fmtTime(lt)}`);
}
function onPlayerFinish() {
  state = 'finished';
  CINE.finishT = 5;
  celebrate();
  const pos = standings().indexOf(player) + 1;
  announce(pos === 1 ? 'win' : 'finish');
  centerEl.innerHTML = `CÉL<small>${pos}. HELY · ${fmtTime(player.finishTime)}</small>`;
  centerEl.className = 'go'; centerTimer = 4;
  if (MP.room) return;          // records count in solo races only
  const best = store.best || {};
  if (!(best[laps] < player.finishTime)) { best[laps] = player.finishTime; newRecord = true; }
  store.best = best;
  const bl = Math.min(...player.lapTimes);
  if (!(store.lap < bl)) store.lap = bl;
  saveStore(store);
}
function showResults() {
  state = 'results';
  CINE.finishT = 0; CINE.timeScale = 1;
  startReplay();
  hudEl.hidden = true; touchEl.hidden = true;
  const ranks = standings(), pos = ranks.indexOf(player) + 1;
  const myBest = player.lapTimes.length ? Math.min(...player.lapTimes) : Infinity;
  const pbLap = !MP.room && isFinite(myBest) && !(prevBestLap <= myBest);
  $('resHead').innerHTML = `${pos}.<small>HELY</small>`;
  $('resSub').innerHTML = (player.finished ? `Idő ${fmtTime(player.finishTime)}` : 'Nem értél célba') + ` · legjobb kör ${fmtTime(myBest)}`
    + (newRecord ? ' · <b>új rekord</b>' : pbLap ? ' · <b>új legjobb kör</b>' : '');
  $('againBtn').firstElementChild.textContent = MP.room ? 'VISSZA A SZOBÁBA' : 'ÚJ FUTAM';
  $('resMenuBtn').textContent = MP.room ? 'KILÉPÉS' : 'FŐMENÜ';
  const fast = HUD.fastest;
  $('resTable').innerHTML = '<div class="h"><span>#</span><span>PILÓTA</span><span class="t">IDŐ</span><span class="bl">LEGJOBB KÖR</span></div>' + ranks.map((r, k) => {
    let t, est = false;
    if (r.finished) t = k === 0 ? fmtTime(r.finishTime) : '+' + (r.finishTime - ranks[0].finishTime).toFixed(2);
    else if (r.gone) t = 'KIESETT';
    else {                     // still on the way: an estimate from the average speed so far
      const avg = Math.max(r.prog / Math.max(raceT, 1), 50);
      t = '~+' + (raceT + (laps * TR.L - r.prog) / avg - ranks[0].finishTime).toFixed(1); est = true;
    }
    const lts = HUD.lapsOf(r), bl = lts.length ? Math.min(...lts) : Infinity, isFast = fast.n === r.n && isFinite(bl);
    const blTxt = !isFinite(bl) ? '–' : isFast ? `<span>${fmtTime(bl)}</span>` : fmtTime(bl);
    const cls = [r.player ? 'me' : '', r.gone ? 'gone' : '', est ? 'est' : ''].filter(Boolean).join(' ');
    return `<div class="${cls}"><span class="p">${k + 1}</span><span class="nm"><i style="background:${r.color}"></i>${escapeHtml(r.player ? 'Te' : r.name)}${MP.room && !r.owner ? '<em>BOT</em>' : ''}</span>`
      + `<span class="t num">${t}</span><span class="bl num${isFast ? ' fast' : ''}${r.player && pbLap && !isFast ? ' pb' : ''}">${blTxt}</span></div>`;
  }).join('');
  $('resLaps').innerHTML = player.lapTimes.map((lt, i) => `<div class="${lt === myBest && player.lapTimes.length > 1 ? 'pb' : ''}"><span class="lbl">${i + 1}. kör</span><b class="num">${fmtTime(lt)}</b></div>`).join('');
  $('resLapsBox').hidden = !player.lapTimes.length;
  const chart = HUD.chartSVG(racers, player);
  $('resChart').innerHTML = chart;
  $('resChartBox').hidden = !chart;
  showScreen(resultEl);
  $('againBtn').focus({ preventScroll: true });
}
function renderRecord() {
  const b = store.best?.[laps];
  $('recordTxt').innerHTML = `<div><span class="lbl">Rekordod · ${laps} kör</span><b class="num">${fmtTime(b)}</b></div>`
    + `<div><span class="lbl">Legjobb kör</span><b class="num">${fmtTime(store.lap)}</b></div>`;
  $('navSoloSub').textContent = b ? `Öt bot ellen · rekordod ${fmtTime(b)}` : 'Öt bot ellen';
}

function stepSim(dt) {
  const inp = MP.menuOpen ? (readInput(), NO_INPUT) : readInput(), p = player;
  if (state === 'countdown') {
    if (CINE.introT > 0) { CINE.introT -= dt; if (CINE.introT <= 0) endIntro(); return; }
    if (inp.throttle > 0.5 && p.throttle < 0.5) throttleAt = countT;
    if (inp.throttle < 0.5) throttleAt = -1;
    p.throttle = inp.throttle;
    for (const r of racers) if (r.ctl === 'bot') r.throttle = countT < 1 ? 0.6 : 0;
    countT -= dt;
    const c = Math.ceil(countT);
    if (c !== lastCount && c > 0 && c <= 3) {
      lastCount = c;                // (the digits are in the HUD's start lights, next to the lamps)
      setLights(c === 3 ? 2 : c === 2 ? 4 : 5, false); sfx('beep');
      announce(c === 3 ? 'three' : c === 2 ? 'two' : 'one');
    }
    if (countT <= 0) {
      state = 'race'; raceT = 0;
      setLights(5, true); centerEl.textContent = 'RAJT!'; centerEl.className = 'go'; centerTimer = 0.9; sfx('go'); announce('go');
      for (const r of racers) {
        if (r.ctl === 'net') continue;
        const f = r.player ? (throttleAt > 0 && throttleAt < 0.5 ? 34 : 0) : 6 + Math.random() * 16;
        r.vx = Math.sin(r.yaw) * f; r.vz = Math.cos(r.yaw) * f;
      }
      if (throttleAt > 0 && throttleAt < 0.5) toast('TÖKÉLETES RAJT');
    }
    return;
  }
  if (state !== 'race' && state !== 'finished' && state !== 'results') return;
  raceT += dt;
  for (const r of racers) {
    if (r.gone) continue;
    if (r.ctl === 'net') { netStep(r, dt); continue; }
    if (r.player && state === 'race' && !debugAuto) {
      p.steer = inp.analog ? inp.steer : damp(p.steer, inp.steer, inp.steer === 0 ? HANDLING.keyFall : HANDLING.keyRise, dt);
      p.throttle = inp.throttle; p.brake = inp.brake; p.boostIn = inp.boost; p.slideIn = inp.slide;
    } else driveAI(r, dt, raceT);
    if (DEBUG_FORCE && r.player) Object.assign(r, DEBUG_FORCE);
    physics(r, dt, simT);
    if (r.lap > r.maxLap) {
      r.maxLap = r.lap;
      if (r.lap >= 1 && !r.finished) {
        const lt = raceT - r.lapStart;
        r.lapTimes.push(lt); r.lapStart = raceT;
        if (r.lap >= laps) { r.finished = true; r.finishTime = raceT; if (r.player) onPlayerFinish(); }
        else if (r.player) onPlayerLap(lt);
        if (r.player && r.finished && lt < bestLapRace) bestLapRace = lt;
      }
    }
  }
  if (COL_NEW) collidePods(); else separate();
  if (state === 'finished') {
    finishWait += dt;
    if (MP.room) {               // wait for the other humans (bots don't hold up the results)
      const humans = racers.filter((r) => r.owner && !r.gone);
      if (humans.every((r) => r.finished) ? finishWait > 3 : finishWait > 25) showResults();
    } else if (finishWait > 7 || racers.every((r) => r.finished)) showResults();
  }
}

// ============================================================
//  Camera
// ============================================================
const CAMS = [{ d: 13, h: 4.3, look: 1.8 }, { d: 20, h: 7.2, look: 2.6 }, { d: 8.2, h: 2.5, look: 1.3 }];
const camLoc = { i: 0 };
const CAMV = { dist: 13, roll: 0, lookX: 0, accel: 0, lastFwd: 0, lastVy: 0, t: 0 };
// cinematic state: intro flyover, finish orbit + slow motion, replay behind the results, photo mode
const CINE = { introT: 0, introLen: 8.6, finishT: 0, timeScale: 1, replay: null, card: -1, offset: 0 };
const REC = { frames: [], acc: 0 };
const PHOTO = { yaw: 0, pitch: 0.25, dist: 12, h: 0, dof: true, help: true, drag: null, shot: false };
const cineEl = $('cine'), titleCardEl = $('titleCard'), nameCardEl = $('nameCard'), replayTagEl = $('replayTag');
const _ca = new THREE.Vector3(), _cb = new THREE.Vector3(), _cq = new THREE.Quaternion(), _cq2 = new THREE.Quaternion();
const _cam2 = new THREE.PerspectiveCamera();
const noise1 = (t, s) => Math.sin(t * 1.9 + s) * 0.5 + Math.sin(t * 4.3 + s * 2.3) * 0.3 + Math.sin(t * 9.7 + s * 0.7) * 0.2;

// the classic chase camera, with springy distance, look-ahead into turns, banking and noise shake. It follows the
// direction of travel more than the nose, and a little behind, so the pod is seen to turn into a corner and to hold
// its angle in a slide. As the view widens with speed the camera comes closer, so the pod does not shrink away.
function chaseCam(dt, p, c) {
  const vYaw = p.fwd > 8 ? Math.atan2(p.vx, p.vz) : p.yaw;
  camYaw += wrapAngle(vYaw + wrapAngle(p.yaw - vYaw) * 0.35 - camYaw) * (1 - Math.exp(-5 * dt));
  const sp = Math.abs(p.fwd);
  const acc = (p.fwd - CAMV.lastFwd) / Math.max(dt, 1e-3);
  CAMV.lastFwd = p.fwd;
  CAMV.accel = damp(CAMV.accel, clamp(acc / 60, -1, 1), 4, dt);
  const fovK = Math.sqrt(Math.tan(32 * Math.PI / 180) / Math.tan(fov * Math.PI / 360));
  CAMV.dist = damp(CAMV.dist, c.d * fovK + (p.boosting ? 1.6 : 0) + CAMV.accel * 1.3, 3, dt);
  const fx = Math.sin(camYaw), fz = Math.cos(camYaw);
  let x = p.x - fx * CAMV.dist, z = p.z - fz * CAMV.dist;
  camLoc.i = p.loc.i;
  locate(x, z, camLoc);
  if (camLoc.arena > 0.3 || camLoc.canyon > 0.3) {
    const lim = camLoc.hw - 0.5, ad = Math.abs(camLoc.d);
    if (ad > lim) { const sg = Math.sign(camLoc.d), k = ad - lim; x += camLoc.tz * sg * k; z -= camLoc.tx * sg * k; }
  }
  camY = damp(camY, Math.max(p.y + c.h, groundQuery(x, z) + 1.5), 10, dt);
  // a hard landing kicks the camera
  const dvy = (p.vy || 0) - CAMV.lastVy;
  CAMV.lastVy = p.vy || 0;
  if (dvy > 5) shake = Math.max(shake, Math.min(0.5, dvy / 28));
  // smooth noise instead of white noise: hits shake, high speed and boost rumble
  CAMV.t += dt;
  const t = CAMV.t, sh = shake * shake * 1.1;
  // (and the warning strip before the sand, and the sand itself, rattle it)
  const rum = Math.pow(clamp(sp / 190, 0, 1), 2) * 0.045 + (p.boosting ? 0.035 : 0) + ((p.edge || 0) * 0.03 + (p.off || 0) * 0.05) * clamp(sp / 60, 0, 1);
  shake = Math.max(0, shake - dt * 2.2);
  camera.position.set(x + noise1(t * 3.1, 1) * sh + noise1(t * 23, 7) * rum, camY + noise1(t * 2.7, 4) * sh + noise1(t * 26, 3) * rum, z + noise1(t * 3.3, 9) * sh * 0.6);
  CAMV.lookX = damp(CAMV.lookX, p.steer * clamp(sp / 40, 0, 1) * 3.2, 2.5, dt);
  camera.lookAt(p.x + fx * 12 + fz * CAMV.lookX, p.y + c.look, p.z + fz * 12 - fx * CAMV.lookX);
  CAMV.roll = damp(CAMV.roll, -p.roll * 0.2 - (p.slide || 0) * Math.sign(p.steer) * 0.035 + noise1(t * 2.2, 5) * sh * 0.05, 5, dt);
  camera.rotateZ(CAMV.roll);
  fov = damp(fov, 64 + 24 * clamp(sp / 190, 0, 1) + (p.boosting ? 7 : 0), 3, dt);
}

// grid tracking shot: slides down the grid at pod height and shows who is who
function gridCam(k) {
  const s0 = TR.L - 6, s1 = TR.L - 16 - 2 * 16 - 10;
  const s = lerp(s0, s1, smooth(0, 1, k));
  trackPoint(s, TR.hw[0] * 0.55 + 4, _tp);
  camera.position.set(_tp.x, _tp.y + 2.4, _tp.z);
  // look at the pod nearest to the camera along the grid
  let best = null, bd = 1e9;
  for (const r of racers) {
    if (r.gone) continue;
    const d = Math.abs(((r.loc.s - s + TR.L * 1.5) % TR.L) - TR.L / 2);
    if (d < bd) { bd = d; best = r; }
  }
  if (best) {
    camera.lookAt(best.x, best.y + 0.6, best.z);
    showNameCard(best);
  }
  fov = 40;
}
function showNameCard(r) {
  if (CINE.card === r.n) return;
  CINE.card = r.n;
  $('ncNo').textContent = '#' + (r.grid + 1);
  $('ncSw').style.background = r.color;
  $('ncName').innerHTML = `${escapeHtml(r.player && !MP.room ? 'Te' : r.name)}<small>${r.player ? 'JÁTÉKOS' : r.owner ? 'JÁTÉKOS' : 'PILÓTA'}</small>`;
  nameCardEl.classList.remove('on');
  void nameCardEl.offsetWidth;
  nameCardEl.classList.add('on');
}
function hideCards() { nameCardEl.classList.remove('on'); titleCardEl.classList.remove('on'); CINE.card = -1; }

// solo intro: aerial flyover from the spires to the arena, the grid, then a crane down to the chase camera
function introCam(dt) {
  const T = CINE.introLen - CINE.introT;
  if (T < 3.6) {
    const k = smooth(0, 3.6, T);
    trackPoint(560, 0, _tp);
    _ca.set(700, 150, -470); _cb.set(_tp.x - 40, _tp.y + 30, _tp.z + 30);
    camera.position.lerpVectors(_ca, _cb, k);
    camera.position.y += Math.sin(k * Math.PI) * 25;
    _ca.set(540, 70, -215); _cb.set(TR.px[0], TR.py[0] + 14, TR.pz[0]);
    camera.lookAt(_ca.lerp(_cb, smooth(0.15, 1, k)));
    fov = 48;
    titleCardEl.classList.toggle('on', T > 0.4 && T < 3.2);
  } else if (T < 6.9) {
    titleCardEl.classList.remove('on');
    gridCam((T - 3.6) / 3.3);
  } else {
    nameCardEl.classList.remove('on');
    const k = smooth(6.9, CINE.introLen, T);
    chaseCam(dt, player, CAMS[camMode]);
    _cb.copy(camera.position); _cq2.copy(camera.quaternion);
    const fx = Math.sin(player.yaw), fz = Math.cos(player.yaw);
    _ca.set(player.x - fx * 34, player.y + 22, player.z - fz * 34);
    _cam2.position.copy(_ca);
    _cam2.lookAt(player.x + fx * 20, player.y, player.z + fz * 20);
    camera.position.lerpVectors(_ca, _cb, k);
    camera.quaternion.slerpQuaternions(_cam2.quaternion, _cq2, k);
    fov = lerp(50, fov, k);
  }
}

// after the finish line: orbit around the pod (in slow motion when racing alone)
function finishCam(dt) {
  const T = 5 - CINE.finishT, p = player;
  const a = p.yaw + Math.PI * 0.8 - T * 0.55, R = 10 + T * 1.1;
  const out = smooth(4.1, 5, T);
  const gy = groundQuery(p.x + Math.sin(a) * R, p.z + Math.cos(a) * R);
  _ca.set(p.x + Math.sin(a) * R, Math.max(p.y + 2 + T * 0.5, gy + 1.5), p.z + Math.cos(a) * R);
  if (out > 0) {
    chaseCam(dt, p, CAMS[camMode]);
    _cb.copy(camera.position); _cq2.copy(camera.quaternion);
    _cam2.position.copy(_ca); _cam2.lookAt(p.x, p.y + 1, p.z);
    camera.position.lerpVectors(_ca, _cb, out);
    camera.quaternion.slerpQuaternions(_cam2.quaternion, _cq2, out);
  } else {
    camera.position.copy(_ca);
    camera.lookAt(p.x, p.y + 1, p.z);
    fov = 46;
    CAMV.dist = CAMS[camMode].d; camYaw = p.yaw; camY = p.y + CAMS[camMode].h;
  }
}

// TV-style replay cameras: a fixed station beside the track ahead of the pod, long lens
function tvCam(dt, p) {
  const R = CINE.replay;
  const ahead = (st) => ((st.s - p.loc.s + TR.L * 1.5) % TR.L) - TR.L / 2;
  if (!R.station || ahead(R.station) < -45) {
    const s = p.loc.s + 45 + Math.random() * 40, side = Math.random() < 0.5 ? -1 : 1;
    trackPoint(s, side * (TR.hw[TR.idx(Math.round(TR.N * s / TR.L))] + 9 + Math.random() * 10), _tp);
    R.station = { s, x: _tp.x, y: Math.max(_tp.y, groundQuery(_tp.x, _tp.z)) + 2 + Math.random() * 6, z: _tp.z };
  }
  const st = R.station;
  camera.position.set(st.x, st.y, st.z);
  _ca.set(p.x, p.y + 0.8, p.z);
  R.look = R.look ? R.look.lerp(_ca, 1 - Math.exp(-10 * dt)) : _ca.clone();
  camera.lookAt(R.look);
  const d = camera.position.distanceTo(_ca);
  fov = clamp(2 * Math.atan(7 / Math.max(d, 1)) * 180 / Math.PI, 9, 55);
}

// menus: slow swing around the player's pod from the open outer side of its grid slot
function menuCam() {
  const p = player, col = p.grid % 2 ? 1 : -1;
  const a = p.yaw - col * Math.PI / 2 + Math.sin(simT * 0.09) * 0.6, R = 12.5 + Math.sin(simT * 0.21) * 1.5;
  const gy = groundQuery(p.x + Math.sin(a) * R, p.z + Math.cos(a) * R);
  camera.position.set(p.x + Math.sin(a) * R, Math.max(p.y + 3.4 + Math.sin(simT * 0.17) * 0.9, gy + 1.2), p.z + Math.cos(a) * R);
  camera.lookAt(p.x, p.y + 0.5, p.z);
  fov = 40;
}

function photoCam() {
  const p = player;
  const cp = Math.cos(PHOTO.pitch), x = p.x + Math.sin(PHOTO.yaw) * cp * PHOTO.dist, z = p.z + Math.cos(PHOTO.yaw) * cp * PHOTO.dist;
  const y = Math.max(p.y + 0.8 + Math.sin(PHOTO.pitch) * PHOTO.dist + PHOTO.h, groundQuery(x, z) + 0.6);
  camera.position.set(x, y, z);
  camera.lookAt(p.x, p.y + 0.8 + PHOTO.h * 0.5, p.z);
}

function updateCamera(dt) {
  const menuish = state === 'menu' || state === 'loading' || state === 'room';
  const cinematic = CINE.introT > 0 || (state === 'countdown' && MP.room && countT > 1.3);
  cineEl.classList.toggle('on', cinematic || CINE.finishT > 0 || !!CINE.replay);
  cineEl.classList.toggle('intro', CINE.introT > 0);
  replayTagEl.hidden = !CINE.replay;
  // frame the subject to the right of the menu / results panel
  const offset = (menuish || state === 'results') && window.innerWidth > 700 ? -0.17 : 0;
  CINE.offset = damp(CINE.offset, offset, 3, dt);
  // (setViewOffset also overwrites camera.aspect with fullWidth / fullHeight, so pass the real canvas
  // size and re-assert the aspect: clearViewOffset does not restore it)
  const vw = window.innerWidth, vh = window.innerHeight;
  if (Math.abs(CINE.offset) > 0.002) camera.setViewOffset(vw, vh, CINE.offset * vw, 0, vw, vh);
  else if (camera.view?.enabled) camera.clearViewOffset();
  camera.aspect = vw / vh;

  if (DEBUG_CAM) debugCam(DEBUG_CAM);
  else if (state === 'photo') photoCam();
  else if (menuish) menuCam();
  else if (CINE.replay) tvCam(dt, CINE.replay.proxies[player.n]);
  else if (CINE.introT > 0) introCam(dt);
  else if (state === 'countdown' && MP.room && countT > 1.3) gridCam((3.2 - countT) / 1.9);
  else if (CINE.finishT > 0) finishCam(dt);
  else {
    if (state === 'countdown') hideCards();
    chaseCam(dt, player, CAMS[camMode]);
  }
  camera.fov = fov;
  camera.updateProjectionMatrix();
  scene.userData.sky.position.copy(camera.position);
}

// testing hook: camera at a pod-relative offset (x left, y up, z forward), looking at a pod-relative point
let DEBUG_CAM = null;
function debugCam(d) {
  if (d.abs) {   // world coordinates
    camera.position.fromArray(d.eye);
    camera.lookAt(_v3.fromArray(d.look));
    if (d.fov) fov = d.fov;
    return;
  }
  const p = racers[d.n ?? player.n], fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);
  const at = (o, out) => out.set(p.x + o[0] * fz + o[2] * fx, p.y + o[1], p.z - o[0] * fx + o[2] * fz);
  at(d.eye, camera.position);
  camera.lookAt(at(d.look ?? [0, 0, 2], _v3));
  if (d.fov) fov = d.fov;
}

// ring buffer of the last 12 s of every pod, for the replay behind the results
function recordReplay(dt) {
  if (state !== 'race' && state !== 'finished') return;
  if ((REC.acc += dt) < 1 / 30) return;
  REC.acc = 0;
  REC.frames.push({ t: raceT, s: racers.map((r) => [r.x, r.y, r.z, r.yaw, r.fwd, r.steer, r.lat, r.pitch, r.throttle, r.boosting ? 1 : 0, r.overheat > 0 ? 1 : 0, r.off, r.vx, r.vz, r.gone ? 1 : 0, r.heat, r.brake, r.loc.s, r.crashN ?? 0, r.slide || 0, r.broken || 0]) });
  while (REC.frames.length > 360) REC.frames.shift();
}
function startReplay() {
  if (REC.frames.length < 90) return;
  CINE.replay = {
    t: REC.frames[0].t, station: null, look: null,
    proxies: racers.map((r) => ({ n: r.n, mesh: r.mesh, player: r.player, phase: r.phase, roll: 0, loc: { s: 0, arena: 0 }, vy: 0, wasBoost: false, scrape: 0, broken: r.broken || 0, color: r.color })),
  };
  // the pods show their parts as they were when the replay starts (the racers' own masks stay: a pod still racing
  // on another machine keeps sending its own)
  for (const f of FLYING) stowPart(f.pod, f.k);
  FLYING.length = 0;
  CINE.replay.proxies.forEach((p, n) => { p.broken = 0; partsTo(p, REC.frames[0].s[n][20] | 0, true); });
}
function stopReplay() { CINE.replay = null; }
function stepReplay(dt) {
  const R = CINE.replay, F = REC.frames;
  R.t += dt;
  if (R.t > F[F.length - 1].t) { R.t = F[0].t; R.station = null; }
  let i = 0;
  while (i < F.length - 2 && F[i + 1].t < R.t) i++;
  const A = F[i], B = F[i + 1], k = clamp((R.t - A.t) / Math.max(B.t - A.t, 1e-3), 0, 1);
  R.proxies.forEach((p, n) => {
    const a = A.s[n], b = B.s[n];
    const L = (j) => a[j] + (b[j] - a[j]) * k;
    Object.assign(p, { x: L(0), y: L(1), z: L(2), yaw: a[3] + wrapAngle(b[3] - a[3]) * k, fwd: L(4), steer: L(5), lat: L(6), pitch: L(7), throttle: L(8),
      boosting: !!b[9], overheat: b[10], off: L(11), vx: L(12), vz: L(13), gone: !!b[14], heat: L(15), brake: L(16), slide: L(19), mesh: racers[n].mesh });
    p.loc.s = a[17] + (((b[17] - a[17] + TR.L * 1.5) % TR.L) - TR.L / 2) * k;
    p.mesh.visible = !p.gone;
    if (p.crashN !== undefined && b[18] > p.crashN) crashFx(p, p.x, p.z, 50, true);
    p.crashN = b[18];
    if ((b[20] | 0) !== p.broken) partsTo(p, b[20] | 0);
    if (!p.gone) racerFx(p, dt, simT);
  });
}

// photo mode: free orbit around the pod while the race is frozen
function enterPhoto() {
  if (state !== 'paused' || MP.room) return;
  state = 'photo';
  showScreen(null); hudEl.hidden = true;
  $('photoHelp').hidden = !PHOTO.help;
  const d = camera.position.clone().sub(_ca.set(player.x, player.y, player.z));
  PHOTO.yaw = Math.atan2(d.x, d.z); PHOTO.dist = clamp(d.length(), 4, 40); PHOTO.pitch = 0.2; PHOTO.h = 0;
}
function exitPhoto() {
  if (state !== 'photo') return;
  state = 'paused';
  $('photoHelp').hidden = true;
  showScreen(pauseEl);
}
canvas.addEventListener('pointerdown', (e) => { if (state === 'photo') { PHOTO.drag = [e.clientX, e.clientY]; canvas.setPointerCapture(e.pointerId); } });
canvas.addEventListener('pointermove', (e) => {
  if (state !== 'photo' || !PHOTO.drag) return;
  PHOTO.yaw -= (e.clientX - PHOTO.drag[0]) * 0.006;
  PHOTO.pitch = clamp(PHOTO.pitch + (e.clientY - PHOTO.drag[1]) * 0.005, -0.15, 1.3);
  PHOTO.drag = [e.clientX, e.clientY];
});
canvas.addEventListener('pointerup', () => { PHOTO.drag = null; });
canvas.addEventListener('wheel', (e) => { if (state === 'photo') PHOTO.dist = clamp(PHOTO.dist * (1 + Math.sign(e.deltaY) * 0.1), 3, 60); }, { passive: true });
function savePhoto() {
  canvas.toBlob((b) => {
    if (!b) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = `homokfutam-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
}

// ============================================================
//  HUD and minimap
// ============================================================
const mm = $('minimap'), mmx = mm.getContext('2d');
const mmBg = document.createElement('canvas'); mmBg.width = mmBg.height = 340;
const MM = (() => {
  let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
  for (let i = 0; i < TR.N; i++) { x0 = Math.min(x0, TR.px[i]); x1 = Math.max(x1, TR.px[i]); z0 = Math.min(z0, TR.pz[i]); z1 = Math.max(z1, TR.pz[i]); }
  return { s: 250 / Math.max(x1 - x0, z1 - z0), cx: (x0 + x1) / 2, cz: (z0 + z1) / 2 };
})();
const mmX = (x) => 170 + (x - MM.cx) * MM.s, mmY = (z) => 170 + (z - MM.cz) * MM.s;
{
  const g = mmBg.getContext('2d');
  g.lineJoin = g.lineCap = 'round';
  g.beginPath();
  for (let i = 0; i <= TR.N; i += 2) { const k = TR.idx(i); i ? g.lineTo(mmX(TR.px[k]), mmY(TR.pz[k])) : g.moveTo(mmX(TR.px[k]), mmY(TR.pz[k])); }
  g.closePath();
  g.strokeStyle = 'rgba(27,20,14,.55)'; g.lineWidth = 13; g.stroke();
  g.strokeStyle = 'rgba(242,228,201,.92)'; g.lineWidth = 5; g.stroke();
  g.strokeStyle = '#ff7b2e'; g.lineWidth = 4;
  const sx = mmX(TR.px[0]), sy = mmY(TR.pz[0]), nx = -TR.tz[0] * 9, ny = TR.tx[0] * 9;
  g.beginPath(); g.moveTo(sx - nx, sy - ny); g.lineTo(sx + nx, sy + ny); g.stroke();
}
function drawMinimap() {
  mmx.clearRect(0, 0, 340, 340);
  mmx.drawImage(mmBg, 0, 0);
  for (const r of [...racers.filter((o) => !o.player && !o.gone), player]) {
    mmx.beginPath();
    mmx.arc(mmX(r.x), mmY(r.z), r.player ? 9 : 6.5, 0, TAU);
    mmx.fillStyle = r.color; mmx.fill();
    mmx.lineWidth = r.player ? 3 : 2; mmx.strokeStyle = r.player ? '#fff' : 'rgba(27,20,14,.8)'; mmx.stroke();
    if (MP.room && r.owner && !r.player) {      // the other players: a ring around the dot
      mmx.beginPath(); mmx.arc(mmX(r.x), mmY(r.z), 10.5, 0, TAU);
      mmx.lineWidth = 2.5; mmx.strokeStyle = 'rgba(242,228,201,.95)'; mmx.stroke();
    }
  }
}
// hud.js: the standings, gaps, sectors, name tags, the lap strip, heat, the start lights
const HUD = createHUD({ camera, TR, fmtTime, archS: () => (ROCKS.arch ? TR.s[ROCKS.arch.i] : 0), touch: window.matchMedia('(pointer: coarse)').matches });
const hudCache = {};
function setHTML(id, v) { if (hudCache[id] !== v) { hudCache[id] = v; $(id).innerHTML = v; } }
function updateHUD(dt = 0) {
  HUD.update({
    racers, player, ranks: standings(), raceT, dt, countT, throttleAt,
    state: state === 'paused' ? pausedFrom : state, paused: state === 'paused',
    intro: CINE.introT > 0, cine: CINE.finishT > 0 || !!CINE.replay, pauseOpen: !pauseEl.hidden,
  });
  setHTML('lapTxt', player.finished ? 'CÉL' : `${clamp(player.lap + 1, 1, laps)}/${laps}`);
  const t = state === 'countdown' ? 0 : player.finished ? player.finishTime : raceT;
  setHTML('totalVal', fmtTime(t));
  setHTML('lapVal', fmtTime(player.finished ? player.lapTimes[player.lapTimes.length - 1] : state === 'countdown' ? 0 : raceT - player.lapStart));
  setHTML('bestLapVal', fmtTime(bestLapRace));
  if (state === 'race' && player.wrong > 1.2) toast('ROSSZ IRÁNY', true, 0.3);
  if (HUD.S.map & 1) drawMinimap();
}

// ============================================================
//  UI wiring
// ============================================================
function bindSeg(segId, onPick) {
  const btns = [...$(segId).querySelectorAll('button')];
  btns.forEach((b) => b.addEventListener('click', () => {
    btns.forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
    onPick(Number(b.dataset.v));
  }));
}
function syncSeg(segId, v) { $(segId).querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.v) === v))); }
bindSeg('lapsSeg', (v) => { laps = v; renderRecord(); });
bindSeg('diffSeg', (v) => { diff = v; });
// graphics preset: saved, then the page reloads (terrain detail, crowd size etc. are built at load)
syncSeg('gfxSeg', GFX_ORDER.indexOf(Q.name));
bindSeg('gfxSeg', (v) => {
  if (GFX_ORDER[v] === Q.name) return;
  saveQuality(GFX_ORDER[v]);
  $('gfxNote').hidden = false;
  setTimeout(() => { const u = new URL(location.href); u.searchParams.delete('q'); location.replace(u.href); }, 350);
});
// renderer (gfx/backend.js): WebGPU by default where the browser supports it; saved, then the page reloads
const RENDERERS = ['webgpu', 'webgl'];
syncSeg('rendererSeg', RENDERERS.indexOf(RENDERER));
if (WEBGPU_MISSING || !navigator.gpu) {
  $('rendererSeg').querySelector('[data-v="0"]').disabled = true;
  $('rendererNote').textContent = 'Ez a böngésző nem támogatja a WebGPU-t, ezért WebGL-lel fut.';
  $('rendererNote').hidden = false;
}
bindSeg('rendererSeg', (v) => {
  if (RENDERERS[v] === RENDERER) return;
  saveRenderer(RENDERERS[v]);
  $('rendererNote').textContent = 'A váltás újratölti az oldalt.';
  $('rendererNote').hidden = false;
  setTimeout(() => { const u = new URL(location.href); u.searchParams.delete('renderer'); location.replace(u.href); }, 350);
});
$('startBtn').addEventListener('click', () => { initAudio(); newRace(); });
$('resumeBtn').addEventListener('click', togglePause);
$('photoBtn').addEventListener('click', enterPhoto);
onPress.KeyH = () => { if (state === 'photo') { PHOTO.help = !PHOTO.help; $('photoHelp').hidden = !PHOTO.help; } };
onPress.KeyF = () => { if (state === 'photo') PHOTO.dof = !PHOTO.dof; };
onPress.Enter = () => { if (state === 'photo') PHOTO.shot = true; };
function skipIntro() { if (CINE.introT > 0 && state === 'countdown') endIntro(); }
canvas.addEventListener('pointerdown', skipIntro);
$('restartBtn').addEventListener('click', () => { initAudio(); newRace(); });
$('menuBtn').addEventListener('click', () => (MP.room ? backToRoom() : showMenu()));
$('againBtn').addEventListener('click', () => { initAudio(); if (MP.room) backToRoom(); else newRace(); });
$('resMenuBtn').addEventListener('click', () => (MP.room ? leaveRoom() : showMenu()));
onPress.Escape = onPress.KeyP = togglePause;
onPress.KeyC = () => { camMode = (camMode + 1) % CAMS.length; };
onPress.KeyR = () => { if (state === 'race') { respawn(player); toast('VISSZA A PÁLYÁRA'); } };
onPress.KeyM = () => { setMuted(!SND.muted); syncSeg('soundSeg', SND.muted ? 0 : 1); toast(SND.muted ? 'HANG KI' : 'HANG BE'); };
// Tab held: the full standings
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Tab' || !(state === 'race' || state === 'countdown' || state === 'finished')) return;
  e.preventDefault(); HUD.setTab(true);
});
window.addEventListener('keyup', (e) => { if (e.code === 'Tab') HUD.setTab(false); });
window.addEventListener('blur', () => HUD.setTab(false));
// main menu: the four pages, the tabs inside them
function showPage(p) {
  document.querySelectorAll('#menuNav button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.page === p)));
  for (const k of ['solo', 'friends', 'settings', 'controls']) $('page-' + k).hidden = k !== p;
}
$('menuNav').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) showPage(b.dataset.page); });
function bindTabs(id) {
  const btns = [...$(id).querySelectorAll('button')];
  const show = (t) => btns.forEach((b) => { b.setAttribute('aria-pressed', String(b.dataset.tab === t)); $('tab-' + b.dataset.tab).hidden = b.dataset.tab !== t; });
  btns.forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
  return show;
}
bindTabs('setTabs');
const showControls = bindTabs('ctlTabs');
// display settings (hud.js keeps them)
for (const [seg, key] of [['tagsSeg', 'tags'], ['towerSeg', 'tower'], ['mapSeg', 'map'], ['nearSeg', 'near'], ['feedSeg', 'feed'], ['scaleSeg', 'scale']]) {
  syncSeg(seg, HUD.S[key]);
  bindSeg(seg, (v) => HUD.set(key, v));
}
bindSeg('soundSeg', (v) => setMuted(v === 0));
// FPS meter and film grain: menu rows and keys I / G (not while typing in a text field), saved in the browser
const FPS = { on: false, n: 0, t0: 0 };
const loadPref = (k, d) => { try { const v = localStorage.getItem('homokfutam:' + k); return v === null ? d : v === '1'; } catch { return d; } };
const savePref = (k, on) => { try { localStorage.setItem('homokfutam:' + k, on ? '1' : '0'); } catch { /* storage blocked */ } };
let grainOn = loadPref('grain', true), grainK = 0;          // grainK: the grade's own grain strength (gfx/post.js), read at boot
function setFps(on) {
  FPS.on = on; FPS.n = 0; FPS.t0 = performance.now();
  $('fps').hidden = !on;
  $('fps').textContent = '';
  syncSeg('fpsSeg', on ? 1 : 0);
  savePref('fps', on);
}
function setGrain(on) {
  grainOn = on;
  const u = post?.grade?.uniforms?.get('uGrain');
  if (u) u.value = on ? grainK : 0;
  syncSeg('grainSeg', on ? 1 : 0);
  savePref('grain', on);
}
// called every frame: frames per second and the average frame time over half a second, the JS time per frame,
// the renderer and the preset
function updateFps(now) {
  if (!FPS.on) return;
  FPS.n++;
  const el = now - FPS.t0;
  if (el < 500) return;
  const preset = $('gfxSeg').querySelector(`[data-v="${GFX_ORDER.indexOf(Q.name)}"]`)?.textContent ?? Q.name;
  $('fps').innerHTML = `${Math.round(FPS.n * 1000 / el)} FPS<small>${(el / FPS.n).toFixed(1)} ms · JS ${PERF.js.toFixed(1)} ms · ${RENDERER.toUpperCase()} · ${preset}</small>`;
  FPS.n = 0; FPS.t0 = now;
}
const typing = (e) => e?.target instanceof HTMLInputElement || e?.target instanceof HTMLTextAreaElement;
bindSeg('fpsSeg', (v) => setFps(v === 1));
bindSeg('grainSeg', (v) => setGrain(v === 1));
if (!Q.post) {
  $('grainSeg').querySelectorAll('button').forEach((b) => { b.disabled = true; });
  $('grainNote').hidden = false;
}
syncSeg('grainSeg', grainOn && Q.post ? 1 : 0);          // (no post-processing on Low: no grain to show)
setFps(loadPref('fps', false));
onPress.KeyI = (e) => { if (typing(e)) return; setFps(!FPS.on); toast(FPS.on ? 'FPS-MÉRŐ BE' : 'FPS-MÉRŐ KI'); };
onPress.KeyG = (e) => { if (typing(e) || !Q.post) return; setGrain(!grainOn); toast(grainOn ? 'FILMSZEMCSE BE' : 'FILMSZEMCSE KI'); };
function setMusic(on) {
  AUDIO.setMusic(on);
  syncSeg('musicSeg', on ? 1 : 0);
  try { localStorage.setItem('homokfutam:music', on ? '1' : '0'); } catch { /* storage blocked */ }
}
onPress.KeyN = () => { setMusic(!AUDIO.musicOn); toast(AUDIO.musicOn ? 'ZENE BE' : 'ZENE KI'); };
bindSeg('musicSeg', (v) => setMusic(v === 1));
try { if (localStorage.getItem('homokfutam:music') === '0') AUDIO.setMusic(false); } catch { /* storage blocked */ }
syncSeg('musicSeg', AUDIO.musicOn ? 1 : 0);
syncSeg('soundSeg', SND.muted ? 0 : 1);
document.addEventListener('click', (e) => { if (e.target.closest?.('button')) { initAudio(); sfx('ui'); } });
canvas.addEventListener('pointerdown', () => initAudio());
document.addEventListener('visibilitychange', () => { if (!MP.room && document.hidden && state !== 'paused') togglePause(); });
touchMode = window.matchMedia('(pointer: coarse)').matches;
document.body.classList.toggle('touch', touchMode);
if (touchMode) showControls('phone');
document.fonts?.load('800 92px "Saira Condensed"').then(() => gantrySign && gantrySign()).catch(() => {});

// ============================================================
//  Multiplayer: rooms over WebRTC, like BLOCKSHOT
// ============================================================
// Each player simulates their own pod and broadcasts its state 20 times a second.
// The race host (lowest peer id) starts the race and simulates the bots.
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const randomCode = () => Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
const HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => HTML_ESC[c]);
const cleanName = (v) => String(v ?? '').trim().slice(0, 16) || 'Játékos';
const CROWN = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M2 12 L3 5 L6.5 8.5 L8 3.5 L9.5 8.5 L13 5 L14 12 Z"/></svg>';
const inviteUrl = (code) => `${location.origin}${location.pathname}#${code}`;
const nameInput = $('nameInput'), codeInput = $('codeInput');
try { nameInput.value = localStorage.getItem('homokfutam:name') || ''; } catch { /* storage blocked */ }
function myName() {
  const n = cleanName(nameInput.value);
  try { localStorage.setItem('homokfutam:name', n); } catch { /* storage blocked */ }
  return n;
}
function menuNote(text, warn) {
  const el = $('inviteNote');
  el.textContent = text; el.hidden = !text;
  el.style.color = warn ? 'var(--bad)' : '';
  if (text) showPage('friends');
}
function readInvite() {
  const code = location.hash.replace('#', '').toUpperCase();
  if (MP.room || !/^[A-Z]{4}$/.test(code)) return;
  codeInput.value = code;
  $('joinBtn').classList.add('hot');
  menuNote('Meghívtak egy szobába: írd be a neved, és nyomj a BELÉPÉS gombra.');
}

function assignSolo() {
  racers.forEach((r, k) => {
    Object.assign(r, { owner: k === 0 ? 'me' : null, ctl: k === 0 ? 'local' : 'bot', player: k === 0, name: ROSTER[k].name,
      grid: SOLO_GRID[k], gone: false, left: false, net: null });
    r.mesh.visible = true;
  });
  player = racers[0];
  attachDetailPods();
}
function assignMP(cfg) {
  const order = [0, 1, 2, 3, 4, 5], rand = rng(cfg.seed);
  for (let i = 5; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  racers.forEach((r, k) => {
    const owner = cfg.owners[k] || null;
    const ctl = owner === selfId ? 'local' : owner ? 'net' : cfg.host === selfId ? 'bot' : 'net';
    Object.assign(r, { owner, ctl, player: owner === selfId, name: owner ? cleanName(cfg.names[k]) : ROSTER[k].name,
      grid: order[k], gone: false, left: false, net: null });
    r.mesh.visible = true;
  });
  player = racers.find((r) => r.player);
  attachDetailPods();
}

function enterRoom(code) {
  initAudio();
  let room;
  try {
    room = new RaceRoom(code);
  } catch (err) {
    menuNote('Nem sikerült csatlakozni. A többjátékos módhoz HTTPS vagy localhost kell.', true);
    console.error(err);
    return;
  }
  Object.assign(MP, { room, myReady: false, inRace: false, menuOpen: false, joinT: 15, note: '', noteT: 0, rLaps: laps, rDiff: diff });
  MP.peers.clear();
  room.onJoin = (pid) => {
    peerOf(pid);
    room.send('hello', { name: myName(), r: MP.myReady }, pid);
    if (room.isHost) room.send('cfg', { laps: MP.rLaps, diff: MP.rDiff }, pid);
    renderRoom();
  };
  room.onLeave = (pid) => {
    const p = MP.peers.get(pid);
    MP.peers.delete(pid);
    const who = p ? p.name : 'Valaki';
    if (MP.inRace) HUD.feed('left', `<b>${escapeHtml(who.toLocaleUpperCase('hu'))}</b> KILÉPETT`); else roomNote(`${who} kilépett.`);
    peerLeftRace(pid);
    renderRoom();
    maybeStart();
  };
  room.on('hello', (d, pid) => {
    const p = peerOf(pid), fresh = p.name === '…';
    p.name = cleanName(d?.name); p.ready = !!d?.r;
    if (fresh) roomNote(`${p.name} belépett.`); else renderRoom();
    maybeStart();
  });
  room.on('ready', (d, pid) => {
    const p = peerOf(pid);
    p.ready = !!d?.r; p.racing = false;
    renderRoom();
    maybeStart();
  });
  room.on('cfg', (d, pid) => {
    if (pid !== room.hostId) return;
    MP.rLaps = [1, 3, 5].includes(d?.laps) ? d.laps : 3;
    MP.rDiff = clamp(d?.diff | 0, 0, 2);
    renderRoom();
  });
  room.on('start', (d, pid) => {
    if (pid !== room.hostId || MP.inRace || !d || !Array.isArray(d.owners)) return;
    beginMP(d);
  });
  room.on('st', (d, pid) => { if (MP.inRace) applyStates(d, pid); });
  room.on('back', (d, pid) => {
    const p = peerOf(pid);
    p.racing = false; p.ready = false;
    peerLeftRace(pid);
    renderRoom();
  });
  history.replaceState(null, '', '#' + code);
  menuNote('');
  showRoom();
}
function peerOf(pid) {
  let p = MP.peers.get(pid);
  if (!p) MP.peers.set(pid, (p = { name: '…', ready: false, racing: false }));
  return p;
}
function roomNote(text) { MP.note = text; MP.noteT = 5; renderRoom(); }
function roomTimers(dt) {
  if (state !== 'room') return;
  if (MP.joinT > 0 && (MP.joinT -= dt) <= 0) renderRoom();
  if (MP.noteT > 0 && (MP.noteT -= dt) <= 0) { MP.note = ''; renderRoom(); }
}
function showRoom() {
  state = 'room';
  stopReplay(); CINE.finishT = 0; CINE.introT = 0; CINE.timeScale = 1; hideCards();
  hudEl.hidden = true; touchEl.hidden = true;
  racers.forEach((r) => { r.mesh.visible = true; placeOnGrid(r, r.grid); });
  setLights(0, false);
  showScreen(roomEl);
  renderRoom();
}
function renderRoom() {
  const room = MP.room;
  if (!room) return;
  const host = room.hostId;
  $('roomCode').textContent = room.code;
  $('inviteLink').textContent = inviteUrl(room.code);
  const rows = [[selfId, { name: myName(), ready: MP.myReady, racing: false }], ...MP.peers];
  // six slots in start order (the host first, as maybeStart hands them out); the bot that drives each free one
  const all = new Map(rows), order = [host, ...[...all.keys()].filter((id) => id !== host).sort()].filter((id) => all.has(id));
  let slots = order.slice(0, 6).map((id) => {
    const p = all.get(id);
    const tags = [id === selfId ? 'te' : '', id === host ? `${CROWN} házigazda` : ''].filter(Boolean).join(' · ') || 'játékos';
    const st = p.racing ? '<span class="st wait">VERSENYEZ…</span>' : p.ready ? '<span class="st ok">KÉSZ</span>' : '<span class="st wait">VÁR…</span>';
    return `<div class="slot${id === selfId ? ' me' : ''}"><i></i><div class="n"><b>${escapeHtml(p.name)}</b><span>${tags}</span></div>${st}</div>`;
  }).join('');
  for (let k = order.length; k < 6; k++) slots += `<div class="slot empty"><i></i><div class="n"><b>Szabad hely</b><span>bot vezeti: ${ROSTER[k].name}</span></div><span class="st wait">BOT</span></div>`;
  $('playerList').innerHTML = slots;
  const free = 6 - Math.min(6, order.length);
  $('slotsLbl').textContent = `Játékosok · ${Math.min(6, order.length)} / 6` + (free ? ` · ${free === 1 ? 'a szabad helyen' : `a ${free} szabad helyen`} bot indul` : '');
  syncSeg('roomLapsSeg', MP.rLaps);
  syncSeg('roomDiffSeg', MP.rDiff);
  for (const b of document.querySelectorAll('#roomLapsSeg button, #roomDiffSeg button')) b.disabled = !room.isHost;
  $('readyTxt').textContent = MP.myReady ? 'MÉGSEM' : 'KÉSZ VAGYOK';
  $('readyBtn').classList.toggle('on', MP.myReady);
  let status;
  if (!MP.peers.size) status = MP.joinT > 0 ? 'Kapcsolódás a szobához…' : 'Még senki nincs itt. Küldd el a linket vagy a kódot a haverjaidnak.';
  else if (rows.some(([, p]) => p.racing)) status = 'Valaki még az előző futamot nézi, megvárjuk.';
  else if (!rows.every(([, p]) => p.ready)) status = 'Ha mindenki KÉSZ, indul a futam. A maradék podokat botok vezetik.';
  else status = 'Indul…';
  if (rows.length > 6) status += ' Egy futamon legfeljebb 6 játékos indul.';
  if (MP.peers.size && !room.isHost) status += ' A köröket és a botokat a házigazda állítja.';
  $('roomStatus').textContent = MP.note || status;
}
function maybeStart() {
  const room = MP.room;
  if (!room || !room.isHost || MP.inRace || !MP.myReady || !MP.peers.size) return;
  const ids = [selfId, ...[...MP.peers.keys()].sort()].slice(0, 6);
  if (!ids.every((id) => id === selfId || (MP.peers.get(id).ready && !MP.peers.get(id).racing))) return;
  const owners = [0, 1, 2, 3, 4, 5].map((k) => ids[k] || null);
  const names = owners.map((id) => (id === selfId ? myName() : id ? MP.peers.get(id).name : ''));
  const cfg = { seed: Math.floor(Math.random() * 2 ** 31), laps: MP.rLaps, diff: MP.rDiff, owners, names, host: selfId };
  room.send('start', cfg);
  beginMP(cfg);
}
function beginMP(cfg) {
  MP.myReady = false;
  for (const [id, p] of MP.peers) { p.ready = false; p.racing = cfg.owners.includes(id); }
  if (!cfg.owners.includes(selfId)) { roomNote('A futam elindult nélküled (legfeljebb 6 játékos). A következőre beszállhatsz.'); return; }
  laps = [1, 3, 5].includes(cfg.laps) ? cfg.laps : 3;
  diff = clamp(cfg.diff | 0, 0, 2);
  Object.assign(MP, { inRace: true, menuOpen: false, raceHost: cfg.host, sendT: 0 });
  assignMP(cfg);
  newRace();
}
// A player went back to the room or left: their unfinished pod drops out.
// If they were running the bots, the next player in id order takes them over.
function peerLeftRace(pid) {
  if (!MP.inRace) return;
  for (const r of racers) {
    if (r.owner !== pid) continue;
    r.left = true;
    if (!r.finished) { r.gone = true; r.mesh.visible = false; }
  }
  if (pid !== MP.raceHost) return;
  const next = racers.filter((r) => r.owner && !r.left).map((r) => r.owner).sort()[0];
  MP.raceHost = next || selfId;
  if (MP.raceHost !== selfId) return;
  for (const r of racers) {
    if (r.owner || r.ctl !== 'net') continue;
    r.ctl = 'bot';
    locate(r.x, r.z, r.loc, true);
    Object.assign(r, { prevS: r.loc.s, maxLap: r.lap, lapStart: raceT, lapTimes: [], aiBoost: false, aiOffT: 0, net: null });
  }
}
function backToRoom() {
  if (!MP.room) { showMenu(); return; }
  MP.inRace = false; MP.menuOpen = false;
  MP.room.send('back', {});
  showRoom();
}
function leaveRoom() {
  if (MP.room) MP.room.leave();
  Object.assign(MP, { room: null, inRace: false, myReady: false, menuOpen: false, raceHost: null });
  MP.peers.clear();
  history.replaceState(null, '', location.pathname + location.search);
  showMenu();
}

// Pod state on the wire:
// [livery, x, y, z, yaw, vx, vz, fwd, lat, steer, throttle, flags, lap, s, finishTime, heat, pitch, crashes, broken parts]
const rd = (v, k = 100) => Math.round(v * k) / k;
function netSend(dt) {
  if (!MP.room || !MP.inRace || state === 'room') return;
  if ((MP.sendT -= dt) > 0) return;
  MP.sendT = 0.05;
  const e = [];
  for (const r of racers) {
    if (r.gone || r.ctl === 'net') continue;
    e.push([r.n, rd(r.x), rd(r.y), rd(r.z), rd(r.yaw, 1000), rd(r.vx), rd(r.vz), rd(r.fwd), rd(r.lat), rd(r.steer), rd(r.throttle),
      (r.boosting ? 1 : 0) | (r.overheat > 0 ? 2 : 0) | (r.finished ? 4 : 0) | (r.slide > 0.5 ? 8 : 0), r.lap, rd(r.loc.s), rd(r.finishTime), Math.round(r.heat), rd(r.pitch, 1000), r.crashN ?? 0, r.broken || 0]);
  }
  MP.room.send('st', { e });
}
function applyStates(d, pid) {
  if (!d || !Array.isArray(d.e)) return;
  const now = performance.now();
  for (const e of d.e) {
    if (!Array.isArray(e) || e.length < 17) continue;
    const r = racers[e[0]];
    if (!r || r.ctl !== 'net' || r.gone) continue;
    if (r.owner ? r.owner !== pid : pid !== MP.raceHost) continue;   // bots only from the race host
    r.net = { t: now, x: +e[1], y: +e[2], z: +e[3], yaw: +e[4], vx: +e[5], vz: +e[6], fwd: +e[7], lat: +e[8], steer: +e[9], th: +e[10],
      f: e[11] | 0, lap: e[12] | 0, s: +e[13], ft: +e[14], heat: +e[15], pitch: +e[16], crash: e[17] | 0, broken: e[18] | 0, fresh: !r.net || r.net.fresh };
  }
}
// dead reckoning toward the last received state, smoothed
function netStep(r, dt) {
  const n = r.net;
  if (!n) return;
  const age = Math.min(0.3, (performance.now() - n.t) / 1000);
  const px = n.x + n.vx * age, pz = n.z + n.vz * age;
  if (n.fresh || Math.hypot(px - r.x, pz - r.z) > 25) {
    r.x = px; r.z = pz; r.y = n.y; r.yaw = n.yaw; n.fresh = false;
    locate(r.x, r.z, r.loc, true);
  } else {
    const k = 1 - Math.exp(-12 * dt);
    r.x += (px - r.x) * k; r.z += (pz - r.z) * k; r.y += (n.y - r.y) * k;
    r.yaw += wrapAngle(n.yaw - r.yaw) * k;
    locate(r.x, r.z, r.loc);
  }
  r.slide = damp(r.slide || 0, n.f & 8 ? 1 : 0, 8, dt);
  Object.assign(r, { vx: n.vx, vz: n.vz, fwd: n.fwd, lat: n.lat, steer: n.steer, throttle: n.th, boosting: !!(n.f & 1),
    overheat: n.f & 2 ? 1 : 0, heat: n.heat, pitch: n.pitch, lap: n.lap, finished: !!(n.f & 4), finishTime: n.ft });
  r.prog = n.lap * TR.L + n.s;
  if (r.crashN !== undefined && n.crash > r.crashN) {
    crashFx(r, r.x, r.z, 50, true);
    if (state === 'race' || state === 'finished') HUD.crash(r, player, raceT);
  }
  r.crashN = n.crash;
  if (n.broken !== (r.broken || 0)) partsTo(r, n.broken);
}

$('createBtn').addEventListener('click', () => enterRoom(randomCode()));
$('joinBtn').addEventListener('click', () => {
  const code = codeInput.value.trim().toUpperCase();
  if (!/^[A-Z]{4}$/.test(code)) { codeInput.classList.add('err'); codeInput.focus(); menuNote('A szobakód 4 betű.', true); return; }
  enterRoom(code);
});
codeInput.addEventListener('input', () => {
  codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  codeInput.classList.remove('err');
});
codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('joinBtn').click(); });
nameInput.addEventListener('change', () => {
  myName();
  if (MP.room) MP.room.send('hello', { name: myName(), r: MP.myReady });
});
$('readyBtn').addEventListener('click', () => {
  if (!MP.room) return;
  initAudio();
  MP.myReady = !MP.myReady;
  MP.room.send('ready', { r: MP.myReady });
  renderRoom();
  maybeStart();
});
$('leaveBtn').addEventListener('click', leaveRoom);
$('copyBtn').addEventListener('click', () => {
  const url = inviteUrl(MP.room ? MP.room.code : '');
  const done = () => { $('copyBtn').textContent = 'MÁSOLVA'; setTimeout(() => ($('copyBtn').textContent = 'LINK MÁSOLÁSA'), 1500); };
  const fallback = () => {
    const sel = getSelection(), range = document.createRange();
    range.selectNodeContents($('inviteLink')); sel.removeAllRanges(); sel.addRange(range);
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(done, fallback); else fallback();
});
const sendCfg = () => { if (MP.room?.isHost) MP.room.send('cfg', { laps: MP.rLaps, diff: MP.rDiff }); renderRoom(); };
bindSeg('roomLapsSeg', (v) => { MP.rLaps = v; sendCfg(); });
bindSeg('roomDiffSeg', (v) => { MP.rDiff = v; sendCfg(); });
window.addEventListener('beforeunload', () => MP.room?.leave());

// ============================================================
//  Main loop
// ============================================================
let lastT = performance.now();
const PERF = { js: 0 };
function frame(now) {
  requestAnimationFrame(frame);
  const tStart = performance.now();
  renderer.info.reset();
  const dt = Math.min(0.05, Math.max(0, (now - lastT) / 1000));
  lastT = now;
  dynRes.tick(dt * 1000);
  ATMO.hfTime.value = now / 1000;
  // slow motion after the finish line (solo only: the others keep racing in multiplayer)
  if (CINE.finishT > 0) {
    CINE.finishT = Math.max(0, CINE.finishT - dt);
    const T = 5 - CINE.finishT;
    CINE.timeScale = MP.room ? 1 : T < 0.25 ? lerp(1, 0.25, T / 0.25) : T < 2.2 ? 0.25 : T < 3 ? lerp(0.25, 1, (T - 2.2) / 0.8) : 1;
  } else CINE.timeScale = 1;
  const sdt = dt * CINE.timeScale;
  if (state !== 'paused' && state !== 'photo') {
    simT += sdt;
    const n = Math.max(1, Math.ceil(sdt / (1 / 120)));
    for (let k = 0; k < n; k++) stepSim(sdt / n);
    for (const p of POOLS) p.update(sdt);
    DEBRIS.update(sdt, groundQuery);
    METAL.update(sdt, groundQuery);
    updateFlying(sdt);
    if (CINE.replay) stepReplay(sdt);
    else for (const r of racers) if (!r.gone) racerFx(r, sdt, simT);
    endFxFrame();
    recordReplay(sdt);
    if (state === 'race' || state === 'finished') {
      for (const r of racers) if (!r.gone) TRAILS.stamp(r, groundQuery(r.x, r.z));
      TRAILS.render(sdt);
    }
    netSend(dt);
    haptics(dt);
    roomTimers(dt);
    updateWind(sdt);
    if (WAKE_ON) updateWake(racers, camera.position);       // pods disturb the world (E7): their wakes for the shaders
    if (toastTimer > 0 && (toastTimer -= dt) <= 0) toastEl.hidden = true;
    if (centerTimer > 0 && (centerTimer -= dt) <= 0) centerEl.textContent = '';
  }
  if (state === 'photo') PHOTO.h = clamp(PHOTO.h + ((keys.has('KeyE') ? 1 : 0) - (keys.has('KeyQ') ? 1 : 0)) * dt * 4, -1.5, 25);
  arenaLife(sdt);
  updateCamera(dt);
  placeSunShadow();
  if (MID) { MID.update(camera); MID.pods(racers.map((r) => !r.gone && r.mesh), camera); }
  if (LIVE && player && !player.gone) LIVE.update(livePos(), player.mesh, racers.map((r) => r !== player && r.mesh));
  if (state === 'countdown' || state === 'race' || state === 'finished' || state === 'paused') updateHUD(dt);
  updateAudio(dt, state === 'countdown' || state === 'race' || state === 'finished' || state === 'results');
  renderFrame(dt);
  if (PHOTO.shot) { PHOTO.shot = false; savePhoto(); }
  PERF.js += (performance.now() - tStart - PERF.js) * 0.05;
  updateFps(now);
}

// the near shadow map follows what the camera looks at, snapped to its texels so it does not shimmer
const SUN_BASIS = (() => {
  const z = SUN_DIR.clone(), x = new THREE.Vector3(0, 1, 0).cross(z).normalize(), y = z.clone().cross(x);
  return { x, y, z };
})();
function placeSunShadow() {
  camera.getWorldDirection(_ca);
  _cb.copy(camera.position).addScaledVector(_ca, Q.shadowBox * 0.38);
  const texel = Q.shadowBox / Q.shadow;
  const u = Math.round(_cb.dot(SUN_BASIS.x) / texel) * texel, v = Math.round(_cb.dot(SUN_BASIS.y) / texel) * texel, w = _cb.dot(SUN_BASIS.z);
  sun.target.position.copy(SUN_BASIS.x).multiplyScalar(u).addScaledVector(SUN_BASIS.y, v).addScaledVector(SUN_BASIS.z, w);
  sun.position.copy(sun.target.position).addScaledVector(SUN_DIR, 600);
}

// ============================================================
//  Arena life: crowd excitement, standings screens, drones, fireworks
// ============================================================
const CROWD = { cheer: 0, wave: 0, boost: 0, screenT: 0, fireworks: [], fwT: 0 };
function arenaLife(dt) {
  const racing = state === 'race' || state === 'finished';
  let target = 0.08;
  if (state === 'countdown') target = countT < 1.2 ? 0.9 : 0.35;
  if (racing && raceT < 3) target = 1;
  if (racing) for (const r of racers) if (!r.gone && r.loc.arena > 0.5 && Math.abs(r.fwd) > 40) target = Math.max(target, 0.5);
  if (state === 'finished' || state === 'results') target = Math.max(target, finishWait < 6 ? 1 : 0.4);
  CROWD.boost = Math.max(0, CROWD.boost - dt * 0.3);
  target = Math.max(target, CROWD.boost);
  CROWD.cheer = damp(CROWD.cheer, target, 3, dt);
  // a stadium wave now and then, and whenever the leader is in the arena
  const lead = standings()[0];
  const waveOn = state === 'menu' || state === 'room' ? (simT % 26) < 11 : racing && lead && lead.loc.arena > 0.5;
  CROWD.wave = damp(CROWD.wave, waveOn ? 1 : 0, 1.5, dt);
  DRESS.cheer = CROWD.cheer; DRESS.wave = CROWD.wave;
  DRESS.update(dt, simT, camera.position);
  TRICKLE?.update(dt, camera.position, racers);
  COURSE?.update(dt, camera.position, racers);
  BIRDS?.update(dt, racers);
  for (const l of ROCKS.lods) l.update(camera.position);
  HORIZON?.update(camera.position);
  if ((ROCKS.tick++ & 3) === 0) for (const l of ROCKS.scatter) l.update(camera.position);
  // drones follow the two leading pods (in the menu: the player and the pod beside it)
  const order = racing || state === 'countdown' ? standings().filter((r) => !r.gone) : [player, racers.find((r) => r !== player)];
  DRESS.updateDrones(order.slice(0, 2), dt, simT);
  if ((CROWD.screenT -= dt) <= 0 && DRESS.setStandings) {
    CROWD.screenT = 0.5;
    const rows = standings().map((r) => ({
      name: r.player && !MP.room ? 'Te' : r.name, color: r.color, me: r.player,
      info: r.finished ? fmtTime(r.finishTime) : r.gone ? 'KIESETT' : state === 'race' || state === 'finished' ? `KÖR ${clamp(r.lap + 1, 1, laps)}/${laps}` : '',
    }));
    DRESS.setStandings(rows, state === 'race' || state === 'finished' || state === 'results' ? `FUTAM · ${laps} KÖR` : 'RAJTLISTA');
  }
  // fireworks over the stands after the finish
  if (CROWD.fwT > 0) {
    CROWD.fwT -= dt;
    if (Math.random() < dt * 2.6) launchFirework();
  }
  for (let k = CROWD.fireworks.length - 1; k >= 0; k--) {
    const f = CROWD.fireworks[k];
    f.t += dt; f.vy -= 9 * dt; f.x += f.vx * dt; f.y += f.vy * dt; f.z += f.vz * dt;
    if (Math.random() < 0.8) emit(SPARK, f.x, f.y, f.z, (Math.random() - 0.5) * 2, -6, (Math.random() - 0.5) * 2, 0.4, { bright: 4, color: '#ffd9a0' });
    if (f.vy < 4) {
      const c = new THREE.Color().setHSL(Math.random(), 0.85, 0.6);
      for (let n = 0; n < 70 * PQ; n++) {
        const a = Math.random() * TAU, b = Math.acos(2 * Math.random() - 1), sp = 18 + Math.random() * 10;
        emit(SPARK, f.x, f.y, f.z, Math.sin(b) * Math.cos(a) * sp, Math.cos(b) * sp, Math.sin(b) * Math.sin(a) * sp, 1 + Math.random() * 0.8, { bright: 8, color: c, size0: 0.35, size1: 0.2, drag: 1.6, grav: 6 });
      }
      emit(FIRE, f.x, f.y, f.z, 0, 0, 0, 0.35, { bright: 6, color: c, size0: 8, size1: 22 });
      sfx('firework', 0.6);
      CROWD.fireworks.splice(k, 1);
    }
  }
}
function launchFirework() {
  const i = TR.idx(Math.floor((Math.random() - 0.5) * 60)), s = Math.random() < 0.5 ? -1 : 1, o = TR.hw[i] + 30 + Math.random() * 10;
  CROWD.fireworks.push({ t: 0, x: TR.px[i] - TR.tz[i] * s * o, y: TR.py[i] + 32, z: TR.pz[i] + TR.tx[i] * s * o,
    vx: (Math.random() - 0.5) * 8, vy: 48 + Math.random() * 16, vz: (Math.random() - 0.5) * 8 });
}
function celebrate() {
  CROWD.fwT = 8;
  CROWD.boost = 1;
  // confetti over the finish line
  for (let n = 0; n < 700 * PQ; n++) {
    const i = TR.idx(Math.floor((Math.random() - 0.5) * 12)), d = (Math.random() - 0.5) * TR.hw[i] * 2.2;
    const x = TR.px[i] - TR.tz[i] * d, z = TR.pz[i] + TR.tx[i] * d;
    emit(CONFETTI, x, TR.py[i] + 14 + Math.random() * 16, z, (Math.random() - 0.5) * 4, -2 - Math.random() * 2, (Math.random() - 0.5) * 4, 7 + Math.random() * 4,
      { color: new THREE.Color().setHSL(Math.random(), 0.8, 0.55), ground: TR.py[i], size0: 0.38, size1: 0.38 });
  }
}

// screen effects driven by the race: speed blur, aberration, flashes, depth of field in menus
const FX = { blur: 0, aberr: 0, flash: 0, fade: 0, center: new THREE.Vector2(0.5, 0.5), dof: { on: false, focus: new THREE.Vector3(), range: 14 }, vol: { k: 0, y: 0, center: new THREE.Vector3(), radius: 200, density: 0.01, amb: 1 } };
// volumetric light (?gfx=vol:1): how far the camera is in the canyon or under the arch, and the track height
// there; the dust sheets (world/haze.js) give way to the real volume as it comes in
const _vnc = { i: 0, d: 0 };
function volZone() {
  nearestCoarse(camera.position.x, camera.position.z, _vnc);
  const i = _vnc.i;
  if (i < 0) { FX.vol.k = 0; return; }
  const inside = 1 - smooth(TR.hw[i] + 25, TR.hw[i] + 70, _vnc.d);
  const canyon = TR.canyon[i], arch = 1 - smooth(12, 50, archGap(i));
  FX.vol.k = Math.max(canyon, arch) * inside;
  // under the tunnel's roof (D7) the shaded dust has almost no sky to glow with
  FX.vol.amb = 1 - 0.75 * roofAt(TR.s[i]);
  FX.vol.y = TR.py[i];
  // the canyon's dust fills the slot round the camera; the arch's hangs under and round it
  if (arch > canyon && ROCKS.arch) { FX.vol.center.set(ROCKS.arch.x, 0, ROCKS.arch.z); FX.vol.radius = 75; FX.vol.density = 0.013; }
  // (thinner than it was, 0.009: with the bounce light it hazed the slot milky and washed its shadows out)
  else { FX.vol.center.copy(camera.position); FX.vol.radius = 260; FX.vol.density = 0.0045; }
  if (HAZE) HAZE.userData.uK.value = HAZE.userData.k0 * (1 - FX.vol.k);
}
// eye adaptation without a meter (?gfx=eye:2, LOW / MEDIUM): the EV to open up by where the camera is, about what
// the meter asks for there (the canyon's slot, the shade under the arch, the stands round the arena)
const _znc = { i: 0, d: 0 };
function zoneEV() {
  nearestCoarse(camera.position.x, camera.position.z, _znc);
  const i = _znc.i;
  if (i < 0) return 0;
  const inside = 1 - smooth(TR.hw[i] + 25, TR.hw[i] + 70, _znc.d);
  return Math.max(TR.canyon[i] * 1.5, roofAt(TR.s[i]) * 1.7, (1 - smooth(12, 50, archGap(i))) * 0.9, TR.arena[i] * 0.5) * inside;
}
const _pv = new THREE.Vector3();
function renderFrame(dt) {
  beamLights();
  rtUpdate();
  if (EYE) {
    // menus stay at the preset's exposure; photo mode keeps the moment's
    EYE.update(dt, camera.position, { lock: state === 'menu' || state === 'room' || state === 'loading', hold: state === 'photo' });
    FX.exposure = EYE.exposure;
    if (!post) renderer.toneMappingExposure = EYE.exposure;          // LOW: the materials tone map
  }
  if (!post) { renderer.render(scene, camera); return; }
  const racing = (state === 'race' || state === 'finished' || state === 'countdown') && CINE.finishT <= 0 && CINE.introT <= 0;
  const sp = racing ? Math.abs(player.fwd) : 0;
  FX.blur = damp(FX.blur, clamp((sp - 80) / 110, 0, 1) * 0.55 + (racing && player.boosting ? 0.45 : 0), 4, dt);
  FX.aberr = damp(FX.aberr, (racing && player.boosting ? 0.6 : 0) + shake * 1.5, 6, dt);
  FX.flash = Math.max(0, FX.flash - dt * 3);
  _pv.set(player.x + Math.sin(player.yaw) * 40, player.y + 2, player.z + Math.cos(player.yaw) * 40).project(camera);
  if (racing) FX.center.set(clamp(_pv.x * 0.5 + 0.5, 0.2, 0.8), clamp(_pv.y * 0.5 + 0.5, 0.2, 0.8));
  else FX.center.set(0.5, 0.5);
  FX.dof.on = state === 'menu' || state === 'room' || state === 'results' || (state === 'photo' && PHOTO.dof);
  if (Q.vol) volZone();
  const fp = CINE.replay ? CINE.replay.proxies[player.n] : player;
  if (FX.dof.on) { FX.dof.focus.set(fp.x, fp.y + 1, fp.z); FX.dof.range = state === 'photo' ? Math.max(6, PHOTO.dist * 0.6) : CINE.replay ? 30 : 18; }
  post.update(dt, FX);
  heatLayer?.render(renderer, camera);
  post.render(dt);
}


// local testing hook (only on localhost): fast-forward the race without rendering every frame
if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
  window.__homok = {
    THREE, scene, renderer, camera, rocks: ROCKS, TR, TSL, GPUTHREE: W, ATMO, GPU, trails: TRAILS, fx: () => ({ DUST, SMOKE, SPARK, FIRE, CONFETTI, WIND, SAND, BLAST, STREAM, DRIFTP }), get post() { return post; }, set post(v) { post = v; },
    start(l = 1, d = 1, intro = false) { laps = l; diff = d; newRace(); if (!intro) endIntro(); return this.info(); },
    cine: CINE, photo: PHOTO, get mid() { return MID; }, get eye() { return EYE; }, get rt() { return RT; }, bakeGI,
    // the one wind (E2): the gust field at a point (0 in a lull, up to 1), at shader time t
    gust: (x, z, t = ATMO.hfTime.value) => gust(x, z, t), drift: DRIFT, get driftSheet() { return DRIFT_SHEET; }, get trickle() { return TRICKLE; }, get course() { return COURSE; }, get landmark() { return LANDMARK; }, get birds() { return BIRDS; }, setWake, LENS, tunnel: TUNNEL,
    ground: (x, z) => groundQuery(x, z), trackPoint: (s, d = 0) => { const o = {}; trackPoint(s, d, o); return o; },
    // the solid field (F2): solid.query(x, z, hint, out) -> signed distance, out.nx/nz/mat
    solid: SOLID,
    // ray tracing spike (D9, WebGPU): rays per second against a BVH of the static world within radius m of the camera
    async rtSpike(opts = {}) {
      if (!GPU) return 'WebGPU only';
      const { rtSpike } = await import('./gfx/tsl/rt.js');
      const r = opts.radius ?? 300, c = camera.position;
      const region = new THREE.Box3(new THREE.Vector3(c.x - r, c.y - 80, c.z - r), new THREE.Vector3(c.x + r, c.y + 220, c.z + r));
      for (const l of ROCKS.lods) l.force(1);
      // the game's frame loop held meanwhile: its passes would count in the GPU timestamps
      const raf = window.requestAnimationFrame, held = [];
      window.requestAnimationFrame = (cb) => { held.push(cb); return 0; };
      await new Promise((r) => setTimeout(r, 100));
      try { return await rtSpike({ renderer, scene, camera, region, ...opts }); } finally {
        window.requestAnimationFrame = raf; for (const cb of held) raf(cb);
        for (const l of ROCKS.lods) l.update(camera.position);
      }
    },
    perf(frames = 120) {
      // ?gputime on WebGPU: the GPU time of all render passes per frame (timestamp queries)
      const timed = GPU && renderer.backend.trackTimestamp;
      return new Promise((res) => {
        let n = 0, gpu = 0, gn = 0; const t0 = performance.now();
        const tick = () => {
          if (timed && n > 0) renderer.resolveTimestampsAsync('render').then((ms) => { if (ms > 0) { gpu += ms; gn++; } });
          if (++n >= frames) {
            const out = { fps: +(frames * 1000 / (performance.now() - t0)).toFixed(1), jsMs: +PERF.js.toFixed(2), calls: GPU ? renderer.info.render.drawCalls : renderer.info.render.calls, tris: renderer.info.render.triangles, ratio: renderer.getPixelRatio(), q: Q.name };
            if (timed) setTimeout(() => res({ ...out, gpuMs: +(gpu / Math.max(gn, 1)).toFixed(3) }), 100); else res(out);
          } else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    },
    sim(sec, auto = true) {
      debugAuto = auto;
      const dt = 1 / 120;
      for (let k = 0; k < sec * 120; k++) {
        simT += dt; stepSim(dt); netSend(dt);
        if (k % 4 === 0) {
          if (CINE.replay) stepReplay(dt * 4); else for (const r of racers) if (!r.gone) racerFx(r, dt * 4, simT);
          endFxFrame();
          recordReplay(dt * 4);
          if (state === 'race' || state === 'finished') { for (const r of racers) if (!r.gone) TRAILS.stamp(r, groundQuery(r.x, r.z)); TRAILS.render(dt * 4); }
          for (const p of POOLS) p.update(dt * 4);
          updateFlying(dt * 4);
          if (CINE.finishT > 0) CINE.finishT = Math.max(0, CINE.finishT - dt * 4);
          if (state === 'race' || state === 'finished') updateHUD(dt * 4);    // (the HUD measures gaps as the race goes)
        }
      }
      updateCamera(0.5); if (state !== 'results') updateHUD(); renderFrame(0.016);
      return this.info();
    },
    cam(m) { camMode = m; updateCamera(1); renderFrame(0.016); },
    // view({ eye: [x, y, z], look: [x, y, z], n, fov }) pod-relative; view(null) back to the game cameras
    view(d) { DEBUG_CAM = d; updateCamera(1); renderFrame(0.016); },
    racer(n = 0) { return racers[n]; },
    handling: HANDLING,
    force(o) { DEBUG_FORCE = o; },
    groundDebug(n) { groundDebug(n); renderFrame(0.016); },
    rebakeProbes() { PROBES = bakePodProbes(); },
    // podEnv(0): pods back on the sky-only environment; podEnv(k): the light probes at strength k
    podEnv(k) {
      for (const r of racers) {
        const p = r.mesh.userData.pod;
        if (!p || !PROBES) continue;
        if (k === 0) { for (const m of p.mats) m.envMap = null; p.envBase = null; p.env.envMapMix.value = 0; }
        else { const [base, b, w] = podProbe(r); setPodEnv(p, base, b, w, k); }
      }
      renderFrame(0.016);
    },
    crash(n = 0, power = 60) { const r = racers[n]; crashFx(r, r.x + Math.sin(r.yaw) * 2, r.z + Math.cos(r.yaw) * 2, power); },
    info() {
      return { state, raceT: +raceT.toFixed(1), mp: MP.room ? { code: MP.room.code, host: MP.room.isHost, peers: MP.room.peers.size, inRace: MP.inRace } : null, racers: racers.map((r) => ({ n: r.name, ctl: r.ctl, gone: r.gone, lap: r.lap, prog: Math.round(r.prog), d: +r.loc.d.toFixed(1), v: Math.round(r.fwd * 3.6), fin: r.finished, ft: +r.finishTime.toFixed(1), laps: r.lapTimes.map((t) => +t.toFixed(1)), heat: Math.round(r.heat), roll: +r.roll.toFixed(2) })) };
    },
  };
}

// Light probes for the pods (gfx/probes.js), at pod height: the middle of the longest open stretch,
// the arena, the canyon and under the arch. A pod is lit by the open-desert probe with the probe
// of the zone it is in faded in (TR.arena / TR.canyon fade along the track; the arch's shade is short).
let PROBES = null;
const PROBE_K = 1.0;              // probe light strength on the pods
let LIVE = null;                  // live reflections on the player's pod (?gfx=refl:1, gfx/probes.js)
const _lp = new THREE.Vector3();
const livePos = () => _lp.copy(player.mesh.position).setY(player.mesh.position.y + 1);
// metres along the track from sample i to the arch
const archGap = (i) => { if (!ROCKS.arch) return 1e9; const d = Math.abs(TR.s[i] - TR.s[ROCKS.arch.i]); return Math.min(d, TR.L - d); };
function bakePodProbes() {
  const at = (i) => new THREE.Vector3(TR.px[i], TR.py[i] + 2, TR.pz[i]);
  let best = [0, 0], run = 0;
  for (let i = 0; i < TR.N; i++) {
    run = TR.arena[i] < 0.01 && TR.canyon[i] < 0.01 && archGap(i) > 300 ? run + 1 : 0;
    if (run > best[1]) best = [i, run];
  }
  const points = { desert: at(best[0] - (best[1] >> 1)) };
  const ar = rangeWhere(TR.arena, 0.55), cr = rangeWhere(TR.canyon, 0.5);
  if (ar) points.arena = at(TR.idx(Math.round((ar[0] + ar[1]) / 2)));
  if (cr) points.canyon = at(TR.idx(Math.round((cr[0] + cr[1]) / 2)));
  if (ROCKS.arch) points.arch = at(ROCKS.arch.i);
  if (TUNNEL.length) { const [a, b] = TUNNEL[TUNNEL.length - 1]; const p = { x: 0, y: 0, z: 0, yaw: 0, i: 0 }; trackPoint((a + b) / 2, 0, p); points.tunnel = new THREE.Vector3(p.x, p.y + 2, p.z); }
  const t0 = performance.now();
  const probes = bakeProbes(renderer, scene, points, (p) => { scene.userData.sky.position.copy(p); HORIZON?.update(p); });
  console.log(`HOMOKFUTAM: ${Object.keys(probes).length} light probes in ${Math.round(performance.now() - t0)} ms`);
  return probes;
}
// [base, blend, weight]: the open desert's probe with the zone's faded in; in the tunnel (D7) the canyon's with the
// tunnel's faded in
function podProbe(r) {
  const i = r.loc.i, a = TR.arena[i], c = TR.canyon[i];
  const t = PROBES.tunnel ? roofAt(TR.s[i]) : 0;
  if (t > 0.01) return [PROBES.canyon, PROBES.tunnel, t];
  const h = 1 - smooth(10, 45, archGap(i));
  if (a >= c && a >= h) return [PROBES.desert, PROBES.arena, a];
  return c >= h ? [PROBES.desert, PROBES.canyon, c] : [PROBES.desert, PROBES.arch, h];
}

// WebGPURenderer builds a pipeline the first time it draws an object with a material, and the post
// chain's scene pass (colour + velocity) needs its own variant of every one: without this the race
// start stutters for seconds. Build them all behind the loading screen by drawing a frame of each post
// graph (with and without depth of field) with everything briefly visible and exempt from frustum
// culling; that also builds the shadow pass's pipelines. The pods get their probe lighting first (it
// rebuilds their materials).
async function precompile() {
  const t0 = performance.now(), saved = [];
  if (PROBES) for (const r of racers) { const p = r.mesh.userData.pod; if (p) { const [base, b, w] = podProbe(r); setPodEnv(p, base, b, w, PROBE_K); } }
  scene.traverse((o) => { saved.push([o, o.visible, o.frustumCulled]); o.visible = true; o.frustumCulled = false; });
  try {
    // (no compileAsync: before the post chain has drawn once its scene pass has no MRT targets yet, and
    // compileAsync would build ~100 heavy pipelines for a target format nothing uses)
    heatLayer?.render(renderer, camera);
    for (const on of [true, false]) {
      if (post) { post.update(0.016, { ...FX, dof: { on, focus: camera.position.clone().add(new THREE.Vector3(0, 0, -20)), range: 14 } }); post.render(); }
      else renderer.render(scene, camera);
    }
  } catch (e) { console.warn('HOMOKFUTAM: precompile failed', e); }
  for (const [o, v, f] of saved) { o.visible = v; o.frustumCulled = f; }
  // the GPU process compiles those pipelines in the background: wait for it, or the first frames stall
  await renderer.backend.device?.queue.onSubmittedWorkDone();
  console.log(`HOMOKFUTAM: pipelines compiled in ${Math.round(performance.now() - t0)} ms`);
}

// static sun shadow for the whole world, rendered once everything static exists
let MID = null;          // the cached mid-distance shadow (?gfx=csm:1)
let HAZE = null;         // the dust sheets in the canyon and under the arch (world/haze.js)
let TRICKLE = null;      // the sand falls (world/trickle.js, E3)
let COURSE = null;       // the trackside markers and the camps (world/course.js, E4, E5)
let LANDMARK = null;     // the wreck in the dunes (world/landmark.js, E6)
let BIRDS = null;        // the birds on the canyon rim that startle (world/birds.js, E7)
const WORLD_BOUNDS = new THREE.Box3(new THREE.Vector3(-1850, -70, -2450), new THREE.Vector3(2050, 270, 1000));
async function boot(data) {
  if (PB_SKY) { await SKY_READY; scene.environment = buildEnvironment(renderer); }       // (the loading timeout may have won the race)
  await LOAD.step(0.6, 'TALAJTÉRKÉP', 0.64);
  try { await bakeMacro(renderer, scene, { x0: TERRAIN.cx - TERRAIN.size / 2, z0: TERRAIN.cz - TERRAIN.size / 2, size: TERRAIN.size, res: 1024 }); }
  catch (e) { console.warn('HOMOKFUTAM: macro map failed', e); }
  await LOAD.step(0.64, 'TÁRGYAK A PÁLYA MENTÉN', 0.68);
  if (PROPS_MODELS) {
    try {
      ROCKS.scatter = buildScatter({ scene, TR, Q, groundQuery, rng, models: PROPS_MODELS, rockMat: boulderMatAO, metalMat: ARENA_MATS.metal,
        // (each field its own copy, whose copies rise out of the ground towards its draw distance)
        fadeRock: (fade) => rockMaterial(Q, ROCKL.boulder, { ...BOULDER_AO, fade }),
        fadeMetal: (fade) => AM(ARENA.metal, { ao: true, scale: 1 / 2, sand: 0.2, macro: 0, metalness: 0.2, fade }) });
    }
    catch (e) { console.warn('HOMOKFUTAM: ground clutter failed', e); }
  }
  // the trackside markers and the spectators' camps (?gfx=markers:1, camps:1; E4, E5): static, so before the bakes
  if (COURSE_MODELS) {
    try {
      COURSE = buildCourse({
        scene, TR, Q, groundQuery, surfaceAt, trackPoint, rng, models: COURSE_MODELS, rockMat: boulderMatAO, dress: DRESS, walls: CANYON_WALLS, tunnel: TUNNEL,
        arch: ROCKS.arch && ROCKS.archMesh ? { mesh: ROCKS.archMesh, s: TR.s[ROCKS.arch.i] } : null, bridge: CANYON_BRIDGE,
        fx: { smoke: (x, y, z) => emit(SMOKE, x, y, z, WIND_DIR.x * 0.7 + (Math.random() - 0.5) * 0.3, 0.9 + Math.random() * 0.4, WIND_DIR.y * 0.7 + (Math.random() - 0.5) * 0.3,
          6 + Math.random() * 2, { size0: 0.4, size1: 3.5 + Math.random() * 2, alpha: 0.2, color: '#a39c92', ground: y - 0.4 }) },
      });
      console.log('HOMOKFUTAM: course:', JSON.stringify(COURSE.counts));
    } catch (e) { console.warn('HOMOKFUTAM: course props failed', e); }
  }
  // birds on the canyon rim that startle as the pack comes in (?gfx=wake:1, E7)
  if (Q.wake && CANYON_WALLS.length) {
    try { BIRDS = buildBirds({ scene, walls: CANYON_WALLS, roofAt, rng, avoid: CANYON_BRIDGE ? [CANYON_BRIDGE.userData.s] : [] }); }
    catch (e) { console.warn('HOMOKFUTAM: birds failed', e); }
  }
  // the landmark (?gfx=landmark:1, E6): the wreck in the dunes, placed where several straights look at it
  if (LANDMARK_MODELS) {
    try {
      const obstacles = [...ROCKS.spires.map((s) => ({ x: s.x, z: s.z, r: s.r })), ...ROCKS.mesas.map((m) => ({ x: m.x, z: m.z, r: m.w * 0.6 }))];
      const t0 = performance.now(), spot = placeLandmark({ TR, groundQuery, obstacles });
      if (spot) LANDMARK = buildLandmark({ scene, models: LANDMARK_MODELS, spot, groundQuery, lod: Q.lod ?? 1 });
      console.log(`HOMOKFUTAM: landmark at ${spot ? `${Math.round(spot.x)}, ${Math.round(spot.z)} (nearest pass ${Math.round(spot.near)} m, score ${spot.score.toFixed(0)})` : 'nowhere'} in ${Math.round(performance.now() - t0)} ms`);
    } catch (e) { console.warn('HOMOKFUTAM: landmark failed', e); }
  }
  await LOAD.step(0.68, 'ÁRNYÉKOK SÜTÉSE', 0.73);
  // the ray tracer's BVH builds in a worker while the shadows and probes bake (?gfx=rtr:1, D9)
  const rtReady = RTR ? rtStart() : null;
  bakeWorldShadow(renderer, scene, WORLD_BOUNDS, Q.staticShadow);
  if (MID_SHADOW) {
    // ?gfx=csm:1: the sharper cached shadow ahead of the camera (before anything samples it)
    MID = createMidShadow(renderer, scene, Q.name === 'ultra' ? { size: 4096, box: [760, 380], ahead: 280 } : {});
    const n = MID.collect();
    MID.update(camera, true);
    MID.pods(racers.map((r) => r.mesh), camera, true);
    console.log(`HOMOKFUTAM: mid shadow: ${n} static casters, ${MID.draws} draws`);
  }
  // the baked light (?gfx=gi:1, D4) before the probes: they see the world lit by it
  await LOAD.step(0.73, 'FÉNY ÉS FÉNYPRÓBÁK', 0.8);
  if (GI_ON) await loadGI(SUN_DIR, TUNNEL.length ? 'gi_tunnel.bin' : 'gi.bin');
  try { PROBES = bakePodProbes(); } catch (e) { console.warn('HOMOKFUTAM: light probes failed', e); }
  if (PROBES?.canyon) { canyonMat.envMap = PROBES.canyon; canyonMat.needsUpdate = true; }        // sky through the slot, red rock all round
  if (Q.refl && PROBES && player) {
    // a face every other frame: the cube is at most 12 frames old, and each face is a full scene pass
    try { LIVE = createLiveEnv(renderer, scene, { every: 2 }); LIVE.collect(); LIVE.warm(livePos(), player.mesh); }
    catch (e) { console.warn('HOMOKFUTAM: live reflections failed', e); LIVE = null; }
  }
  // LOW: only the things that move (pods, debris) draw into the near shadow map every frame; the
  // static world keeps just its baked shadow
  if (Q.casters === false) {
    const moves = (o) => { for (let p = o; p; p = p.parent) if (p.userData.dynamic) return true; return false; };
    scene.traverse((o) => { if (o.isMesh && o.castShadow && !moves(o)) o.castShadow = false; });
  }
  await LOAD.step(0.8, 'POR, HOMOK, UTÓFELDOLGOZÁS', GPU ? 0.88 : 0.97);
  try { HAZE = buildHaze({ scene, TR, rangeWhere, arch: ROCKS.arch, Q }); } catch (e) { console.warn('HOMOKFUTAM: haze failed', e); }
  // sand pouring from the rock (?gfx=trickle:1, E3): off the canyon rim, the tunnel's lips and ceiling, the arch and
  // the bridge; placed against the built rock (raycasts up into the overhangs, the walls' own profiles)
  if (Q.trickle) {
    try {
      scene.updateMatrixWorld(true);
      const slabs = [];
      scene.traverse((o) => { if (o.isMesh && o.userData.tunnel) slabs.push(o); });
      const overheads = [];
      if (ROCKS.archMesh && ROCKS.arch) overheads.push({ mesh: ROCKS.archMesh, s: TR.s[ROCKS.arch.i], reach: 60, n: 5 });
      if (CANYON_BRIDGE) overheads.push({ mesh: CANYON_BRIDGE, s: CANYON_BRIDGE.userData.s, reach: 40, n: 4 });
      const t0 = performance.now();
      const falls = placeFalls({ TR, trackPoint, groundQuery, rng, walls: CANYON_WALLS, roofAt, tunnel: TUNNEL, slabs, overheads });
      TRICKLE = buildTrickle({
        scene, falls, fx: {
          puff: (x, y, z, k) => emit(DUST, x, y, z, WIND_DIR.x * 0.6 + (Math.random() - 0.5) * 0.6, 0.3 + Math.random() * 0.4, WIND_DIR.y * 0.6 + (Math.random() - 0.5) * 0.6,
            2 + Math.random() * 1.5, { size0: 0.6 + Math.random() * 0.5, size1: 2.5 + Math.random() * 2 * k, alpha: 0.1 + 0.08 * Math.min(k, 1.5), ground: y - 0.2 }),
          pebble: (x, y, z) => emit(CONFETTI, x, y, z, (Math.random() - 0.5) * 1.5, -2 - Math.random() * 3, (Math.random() - 0.5) * 1.5, 6,
            { color: Math.random() < 0.5 ? '#8a6446' : '#a7825c', size0: 0.12 + Math.random() * 0.12, size1: 0.12, grav: 9.8, drag: 0.05, spin: 6, ground: groundQuery(x, z) }),
        },
      });
      console.log(`HOMOKFUTAM: ${falls.length} sand falls placed in ${Math.round(performance.now() - t0)} ms`);
    } catch (e) { console.warn('HOMOKFUTAM: sand falls failed', e); }
  }
  if (Q.post) {
    try {
      post = GPU ? N.createNodePost(renderer, scene, camera, Q, SUN_DIR, heatLayer) : createPost(renderer, scene, camera, Q, SUN_DIR);
      if (heatLayer && !GPU) { post.speed.uniforms.get('uDistort').value = heatLayer.rt.texture; post.speed.uniforms.get('uDistortOn').value = 1; }
      grainK = post.grade.uniforms.get('uGrain').value;
      setGrain(grainOn);
      resize();
    }
    catch (e) { console.warn('HOMOKFUTAM: post-processing failed, rendering without it', e); post = null; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.0; }
  }
  // eye adaptation (D3): metered from the frame on HIGH / ULTRA (eye: 1), from the camera's place on LOW / MEDIUM
  // (eye: 2, or when the chain cannot meter)
  if (rtReady) { await rtReady; rtUpdate(); }
  if (Q.eye) EYE = createEye(renderer.toneMappingExposure || 1, Q.eye === 1 ? post?.meter ?? null : null, zoneEV);
  if (GPU) { await LOAD.step(0.88, 'SHADEREK FORDÍTÁSA · EZ TART A LEGTOVÁBB', 0.99); await precompile(); }
  if (data && data.laps) { laps = data.laps; syncSeg('lapsSeg', laps); }
  if (data && data.diff != null) { diff = data.diff; syncSeg('diffSeg', diff); }
  if (data && data.muted) setMuted(true);
  showMenu();
  readInvite();
  window.addEventListener('hashchange', readInvite);
  requestAnimationFrame((t) => { lastT = t; frame(t); LOAD.done(); });
  // ?bakegi (dev): bake the light volumes for ?gfx=gi:1 and download them as gi.bin (for assets/world/)
  if (new URLSearchParams(location.search).has('bakegi')) {
    const r = await bakeGI();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([r.buffer])); a.download = TUNNEL.length ? 'gi_tunnel.bin' : 'gi.bin'; a.click();
  }
}
// the light bake (gfx/gibake.js, D4): with every rock at the same level of detail as for the shadow bakes
async function bakeGI(opts = {}) {
  const { bakeGI: bake } = await import('./gfx/gibake.js');
  for (const l of ROCKS.lods) l.force(1);
  try {
    return await bake({ scene, TR, rangeWhere, arch: ROCKS.arch, palette: PALETTE, sunDir: SUN_DIR, envI: scene.environmentIntensity, ...opts });
  } finally { for (const l of ROCKS.lods) l.update(camera.position); }
}
// show the game once the surface textures are in (or after 10 s, whatever happens first)
const ASSETS = [SURF.ready, GROUND_READY, ROCKS_READY, POD_READY, ARENA_READY, PROPS_READY, COURSE_READY, LANDMARK_READY, DRESS.ready, SKY_READY];
let assetsIn = 0;
const assetIn = () => LOAD(0.14 + 0.44 * (++assetsIn / ASSETS.length), `MODELLEK ÉS TEXTÚRÁK · ${assetsIn}/${ASSETS.length}`, 0.6);
LOAD(0.14, `MODELLEK ÉS TEXTÚRÁK · 0/${ASSETS.length}`, 0.58);
for (const a of ASSETS) Promise.resolve(a).then(assetIn, assetIn);
const texturesReady = Promise.race([Promise.all(ASSETS), new Promise((r) => setTimeout(r, 15000))]);
const hot = window.claude && window.claude.hot;
if (hot && typeof hot.snapshot === 'function') { try { hot.snapshot(() => ({ laps, diff, muted: SND.muted })); } catch { /* ignore */ } }
if (hot && typeof hot.ready === 'function') hot.ready((d) => texturesReady.then(() => boot(d)));
else texturesReady.then(() => boot((hot && hot.data) || {}));
