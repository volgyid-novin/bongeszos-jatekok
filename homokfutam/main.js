import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RaceRoom, selfId } from './net.js';
import { loadPodModel, setPodLivery, animatePlayerPod, podLift } from './playerPod.js';
import { pickQuality, saveQuality, createDynRes, ORDER as GFX_ORDER } from './gfx/quality.js';
import { installAtmosphere, ATMO, SUN_DIR, PALETTE, skyMaterial, cloudTexture, buildEnvironment, bakeWorldShadow } from './gfx/atmosphere.js';
import { loadSurfaces, triplanarMaterial } from './gfx/surfaces.js';
import { loadGround, terrainMaterial, trackMaterial, rockMaterial, groundDebug, ROCK as ROCKL, ARENA, WIND_DIR } from './gfx/ground.js';
import { bakeMacro } from './world/macro.js';
import { loadRockModels, LodInstances } from './world/rocks.js';
import { buildScatter } from './world/scatter.js';
import { buildHorizon } from './world/horizon.js';
import { buildHaze } from './world/haze.js';
import { createPost } from './gfx/post.js';
import { Particles, loadFlipbooks } from './gfx/particles.js';
import { createPodFx, createDebris, HeatLayer, createTrailMap } from './gfx/podfx.js';
import { createBeam, createBeamLights, createBeamFlares } from './gfx/beam.js';
import { FxBatch, shown } from './gfx/fxbatch.js';
import { buildDressing } from './world/dressing.js';
import { createAudio } from './audio.js';

const Q = pickQuality();
installAtmosphere();

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
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !Q.post, powerPreference: 'high-performance', stencil: false });
// with post-processing on, tone mapping happens in the effect chain (gfx/post.js)
renderer.toneMapping = Q.post ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.info.autoReset = false;
renderer.shadowMap.type = THREE.PCFShadowMap;
const dynRes = createDynRes(renderer, Q, () => resize());
const SURF = loadSurfaces(renderer);
const GROUND_READY = loadGround(renderer, Q);

const scene = new THREE.Scene();
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
scene.environment = buildEnvironment(renderer);
scene.environmentIntensity = 0.6;
// warm bounce from the sand and rock that the sky-only environment does not have
scene.add(new THREE.HemisphereLight('#9db4d2', '#c98b52', 0.55));
const sun = new THREE.DirectionalLight(PALETTE.sun, 3.1);
sun.castShadow = true;
sun.shadow.mapSize.set(Q.shadow, Q.shadow);
Object.assign(sun.shadow.camera, { left: -Q.shadowBox / 2, right: Q.shadowBox / 2, top: Q.shadowBox / 2, bottom: -Q.shadowBox / 2, near: 10, far: 1600 });
sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.5; sun.shadow.radius = 2.5;
scene.add(sun, sun.target);

let post = null;    // gfx/post.js, created at boot when the preset asks for it
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
const COLLIDERS = [];   // {x, z, r} rock bases the pods can hit off-track
const ARCH = { x: 0, z: 0 };
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
let TRACK_MESH = null;
{
  // Across the track: the packed surface over the half-width, then on each side a berm of sand
  // the pods have pushed up (a low ridge ~2.6 m out) running down to meet the terrain ~7 m out.
  // Only the look: physics keeps using groundAt. No berm in the arena or the canyon.
  const pos = [], tr = [], dir = [], zone = [], index = [];
  const IN = [-1, -0.5, 0, 0.5, 1];                // multiples of the half-width
  const OUT = [1.2, 2.6, 4.5, 7.0];                // metres past the edge
  const cols = [...OUT.slice().reverse().map((e) => [-1, e]), ...IN.map((c) => [c, null]), ...OUT.map((e) => [1, e])];
  const NC = cols.length;
  for (let k = 0; k <= TR.N; k++) {
    const i = TR.idx(k), hw = TR.hw[i], y = TR.py[i], s = TR.s[k];
    const rx = -TR.tz[i], rz = TR.tx[i];
    const open = (1 - TR.arena[i]) * (1 - TR.canyon[i]);
    for (const [c, e] of cols) {
      let o, h;
      if (e === null) { o = c * hw; h = 0.06; }
      else {
        const b = open * (0.6 + 0.8 * fbm(s * 0.021, c * 13.1, 2));
        o = c * (hw + e);
        h = e < 2 ? 0.06 + 0.1 * b : e < 3 ? 0.02 + 0.55 * b - (1 - b) * 0.06 : e < 5 ? -0.14 + 0.26 * b : -0.3;
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
  const m = new THREE.Mesh(g, trackMaterial(Q, TR.L));
  m.receiveShadow = true;
  scene.add(m);
  TRACK_MESH = m;

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
{
  const r = rangeWhere(TR.canyon, 0.01);
  if (r) {
    for (const side of [-1, 1]) {
      const J = 36;
      const prof = (i) => {
        const c = TR.canyon[i], H = TR.wallH[i] * c, hw = TR.hw[i], ty = TR.py[i], s = TR.s[i];
        const out = [];
        for (let j = 0; j <= J; j++) {
          const h = j / J, y = H * h;
          const n = fbm(s * 0.035, h * 8 + side * 31, 3) - 0.5;
          const fine = fbm(s * 0.16 + 11, h * 22 + side * 7, 2) - 0.5;
          // eroded sandstone: soft layers stand out as ledges every ~7 m
          const tq = (y + fbm(s * 0.01, side, 2) * 6) / 7, fr = tq - Math.floor(tq);
          const ledge = smooth(0.62, 0.92, fr) * 1.4 * h;
          // alcoves: rounded recesses scooped out of the soft beds, a few metres deep
          const alc = smooth(0.56, 0.78, fbm(s * 0.011 + side * 3, h * 1.6 + 2, 2)) * Math.pow(Math.sin(Math.PI * clamp((h - 0.12) / 0.6, 0, 1)), 1.5) * 4.5;
          out.push([hw + 0.8 + 6 * h * h + n * 6 * h + fine * 1.6 * h - ledge + alc + (j === 0 ? 0 : 1.2), ty - 1.5 + y + n * 2 * h]);
        }
        out.push([hw + 14, ty + H + 1.5 + (fbm(s * 0.05, side * 5) - 0.5) * 3]);
        out.push([hw + 30, ty + H + (fbm(s * 0.02, side * 5) - 0.5) * 6]);
        out.push([hw + 75, ty + H * 0.85]);
        out.push([hw + 135, ty - 6]);
        return out;
      };
      // softer bands than the open-desert strata, drifting in tone along the canyon
      const wallCol = (i, j, y, out) => {
        if (j > J) return out.copy(ROCK.top).lerp(ROCK.light, 0.3);
        strata(y, TR.s[i] + side * 70, out).lerp(ROCK.mid, 0.42);
        return out.lerp(ROCK.light, (fbm(TR.s[i] * 0.006, y * 0.03 + side, 2) - 0.5) * 0.5);
      };
      const g = sweep(r[0] - 2, r[1] + 2, side, prof, wallCol);
      const m = new THREE.Mesh(g, rockMat);
      m.castShadow = m.receiveShadow = true;
      m.userData.rock = true;
      scene.add(m);
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
    scene.add(bridge);
    CANYON_BRIDGE = bridge;          // gets the Blender model once rocks.glb is in
  }
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
const ARENA_MATS = {
  stone: AM(ARENA.stone, { ao: true }),
  plaster: AM(ARENA.plaster, { ao: true }),
  wood: AM(ARENA.wood, { ao: true, scale: 1 / 2, sand: 0.4 }),
  cloth: AM(ARENA.cloth, { ao: true, scale: 1 / 2, sand: 0.12, macro: 0, side: THREE.DoubleSide }),
  metal: AM(ARENA.metal, { ao: true, scale: 1 / 2, sand: 0.2, macro: 0, metalness: 0.2 }),
  dark: new THREE.MeshStandardMaterial({ color: '#241b15', roughness: 0.92 }),
};
{
  const standsStone = AM(ARENA.stone, { flat: true, side: THREE.DoubleSide });
  const standsPlaster = AM(ARENA.plaster, { flat: true, side: THREE.DoubleSide });
  const benchWood = AM(ARENA.wood, { flat: true, scale: 1 / 2, sand: 0.3 });
  const tintA = C('#f3e9d6'), tintB = C('#e4d3b6'), plasterTint = C('#f7efe2');
  const r = rangeWhere(TR.arena, 0.55);
  ARENA_LAYOUT.range = r;
  if (r) {
    const tier = (i, j) => [TR.hw[i] + 2.8 + 3.2 * (j + 1), TR.py[i] + 4.2 + 2.2 * j];
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
    for (const [m, g] of parts(name)) {
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
const boulderMatAO = rockMaterial(Q, ROCKL.boulder, { scale: 1 / 6, chroma: 0.45, contrast: 1.05, rough: [0.6, 0.35], foot: 1.2, ao: true });
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
  ROCKS.lods.push(new LodInstances(scene, lod('spire', 8, 3), rockMatAO, ROCKS.spires, [380 * Q.lod, 1400 * Q.lod]));
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
  if (CANYON_BRIDGE) {
    const b = CANYON_BRIDGE;
    b.geometry.dispose();
    b.geometry = models.get('bridge');
    b.material = rockMatAOSolo;
    b.scale.set(b.userData.span / 76, 1, 1);
  }
}

// the old procedural shapes, if rocks.glb can't be loaded
function buildRockFallback() {
  const rand = rng(77);
  instanced(Array.from({ length: 8 }, (_, k) => spireGeometry(k * 1.7 + 0.3, (rand() - 0.5) * 0.25)), rockMatI, ROCKS.spires);
  instanced([lumpGeometry(1), lumpGeometry(2.5), lumpGeometry(4.2)], boulderMat, ROCKS.boulders);
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
}
let PROPS_MODELS = null;          // assets/world/props.glb: ground clutter, placed at boot (needs the macro map)
const PROPS_READY = loadRockModels(new URL('./assets/world/props.glb', import.meta.url).href).then((m) => { PROPS_MODELS = m; })
  .catch((e) => console.warn('HOMOKFUTAM: props failed, no ground clutter', e));
const ROCKS_READY = loadRockModels().then(buildRockVisuals).catch((e) => {
  console.warn('HOMOKFUTAM: rock models failed, using the simple shapes', e);
  buildRockFallback();
});

// ============================================================
//  Dressing: crowd, flags, screens, chase lights, power line, ruins, life (world/dressing.js)
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
const FLAMES = new FxBatch(scene, new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({
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
}), 24, { aCol: 3 });
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
    body.add(wing);
  }
  body.add(tub, nose, seat, head, goggles, stripe);
  // steering cables from cockpit to engines
  for (const s of [1, -1]) {
    const curve = new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(s * 0.45, 0.1, -0.6), new THREE.Vector3(s * 1.2, -0.25, 1.3), new THREE.Vector3(s * 1.75, 0.05, 2.6));
    body.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 10, 0.06, 5), cableMat));
  }
  mergeChildren(body);
  body.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  const beam = addBeam(body, engines, [new THREE.Vector3(1.0, 0.15, 6.7), new THREE.Vector3(-1.0, 0.15, 6.7)]);
  root.userData = { body, engines, beam, hot, dynamic: true };
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
const PQ = Q.particles;
const DUST = new Particles(scene, { capacity: 2400 * PQ, kind: 'lit', flip: 'smoke', size: [2.2, 9], alpha: 0.2, drag: 1.3, grav: -0.5, color: '#dcb88a' });
const SMOKE = new Particles(scene, { capacity: 400 * PQ, kind: 'lit', flip: 'smoke', size: [1.6, 7.5], alpha: 0.5, drag: 0.7, grav: -3, color: '#5e554d', ambient: '#7a6e62', sun: '#c8b498' });
// simulated fireballs (explosions, backfires): flame emission plus the smoke they roll into
const BLAST = new Particles(scene, { capacity: 120 * PQ, kind: 'fire', size: [2.5, 8], alpha: 1, drag: 1.6, grav: -2.5, color: '#8a7d70', ambient: '#9a8a7a', sun: '#e0c4a0', emit: Q.post ? 1 : 0.5, fadeIn: 0.02 });
const SPARK = new Particles(scene, { capacity: 600 * PQ, kind: 'spark', size: [0.13, 0.1], alpha: 1, drag: 1.1, grav: 24, color: '#ffb35c', stretch: 0.03 });
const FIRE = new Particles(scene, { capacity: 300 * PQ, kind: 'add', size: [1.1, 3.2], alpha: 1, drag: 2.2, grav: -5, color: '#ff7a2e', fadeIn: 0.05 });
const CONFETTI = new Particles(scene, { capacity: 900 * PQ, kind: 'confetti', size: [0.4, 0.4], alpha: 1, drag: 1.8, grav: 4, spin: 14 });
const WIND = new Particles(scene, { capacity: 240, kind: 'spark', size: [0.045, 0.045], alpha: 0.5, drag: 0, grav: 0, color: '#ffe9c8', stretch: 0.03, fadeIn: 0.3 });
const SAND = new Particles(scene, { capacity: 260 * PQ, kind: 'lit', size: [4, 11], alpha: 0.12, drag: 0.15, grav: 0, color: '#e6c597', fadeIn: 0.4 });
function emit(pool, x, y, z, vx, vy, vz, life, p) { pool.emit(x, y, z, vx, vy, vz, life, p); }
const POOLS = [DUST, SMOKE, SPARK, FIRE, CONFETTI, WIND, SAND, BLAST];
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
const SKILL = [0.86, 0.93, 0.985];
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
let podFactory = null;
function wrapDetailedPod(pod) {
  pod.engines.forEach((e, k) => addFlame(e, pod.flames[k]));
  const beam = addBeam(pod.body, pod.engines, pod.beam);
  pod.root.userData = { body: pod.body, engines: pod.engines, beam, pod, dynamic: true };
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
    swapMesh(r, r.detailMesh);
  }
}
loadPodModel(renderer)
  .then((make) => { podFactory = make; attachDetailPods(); })
  .catch((e) => console.warn('HOMOKFUTAM: detailed pod failed to load, using the simple one', e));
const _tp = { x: 0, y: 0, z: 0, yaw: 0, i: 0 };

function placeOnGrid(r, slot) {
  const row = Math.floor(slot / 2), col = slot % 2 ? 1 : -1;
  trackPoint(TR.L - 16 - row * 16, col * 7 + (row % 2 ? 1.5 : -1.5) * col, _tp);
  Object.assign(r, { x: _tp.x, z: _tp.z, y: _tp.y + HOVER, yaw: _tp.yaw, vx: 0, vz: 0, vy: 0, fwd: 0, lat: 0, steer: 0,
    heat: 0, overheat: 0, boosting: false, lap: -1, maxLap: 0, lapTimes: [], finished: false, finishTime: 0, wrong: 0, off: 0 });
  r.loc.i = _tp.i;
  locate(r.x, r.z, r.loc, true);
  r.prog = r.loc.s - TR.L;
  r.prevS = r.loc.s;
}
function respawn(r) {
  trackPoint(r.loc.s - 12, 0, _tp);
  Object.assign(r, { x: _tp.x, z: _tp.z, y: _tp.y + HOVER + 2, yaw: _tp.yaw, vx: 0, vz: 0, vy: 0, fwd: 0, lat: 0, heat: Math.min(r.heat, 60) });
  r.loc.i = _tp.i;
}

function physics(r, dt, t) {
  const loc = locate(r.x, r.z, r.loc);
  const ad = Math.abs(loc.d);
  const off = smooth(loc.hw - 1, loc.hw + 4, ad);
  r.off = off;
  const fx = Math.sin(r.yaw), fz = Math.cos(r.yaw);

  // boost and heat
  const wantBoost = r.boostIn && r.overheat <= 0 && r.throttle > 0.4 && r.fwd > 25;
  r.boosting = wantBoost;
  if (wantBoost) { r.heat += 24 * dt; if (r.heat >= 100) { r.heat = 100; r.overheat = 3.2; r.boosting = false; if (r.player) onOverheat(); } }
  else r.heat = Math.max(0, r.heat - (r.overheat > 0 ? 26 : 15) * dt);
  if (r.overheat > 0) r.overheat -= dt;

  const vmax = TOP * r.topMul * (r.boosting ? 1.3 : 1) * (r.overheat > 0 ? 0.8 : 1) * lerp(1, 0.5, off);
  let fwd = r.vx * fx + r.vz * fz;
  let lat = r.vx * -fz + r.vz * fx;
  let a = 0;
  if (fwd < vmax) a += (r.boosting ? 62 : 44) * r.throttle * (1 - (fwd / vmax) ** 2);
  else a -= 20 + (fwd - vmax) * 0.6;
  if (r.brake > 0) a -= (fwd > 1 ? 72 : 14) * r.brake;
  if (r.throttle < 0.05 && r.brake <= 0) a -= 5 + fwd * 0.035;
  a -= fwd * 0.55 * off;
  fwd = Math.max(-16, fwd + a * dt);

  // steering: yaw-rate limited by lateral grip
  const sp = Math.abs(fwd);
  const omax = Math.min(2.2, 70 / Math.max(sp, 1)) * Math.min(1, sp / 6);
  r.yaw += r.steer * omax * Math.sign(fwd || 1) * dt;
  const nfx = Math.sin(r.yaw), nfz = Math.cos(r.yaw);
  // velocity re-expressed on the new heading: lateral part slides out
  const vx = fx * fwd - fz * lat, vz = fz * fwd + fx * lat;
  fwd = vx * nfx + vz * nfz;
  lat = (vx * -nfz + vz * nfx) * Math.exp(-lerp(6.5, 2.2, off) * dt);
  r.vx = nfx * fwd - nfz * lat;
  r.vz = nfz * fwd + nfx * lat;
  r.fwd = fwd; r.lat = lat;
  r.x += r.vx * dt; r.z += r.vz * dt;

  // walls in the arena and canyon
  const walled = loc.arena > 0.3 || loc.canyon > 0.3;
  const lim = loc.hw - 1.6;
  locate(r.x, r.z, loc);
  if (walled && Math.abs(loc.d) > lim) {
    const sgn = Math.sign(loc.d), nx = -loc.tz * sgn, nz = loc.tx * sgn;
    const pen = Math.abs(loc.d) - lim;
    r.x -= nx * pen; r.z -= nz * pen;
    r.scrape = Math.max(r.scrape || 0, Math.min(1, Math.abs(r.fwd) / 70)); r.scrapeX = r.x + nx * 2.5; r.scrapeZ = r.z + nz * 2.5;
    const vn = r.vx * nx + r.vz * nz;
    if (vn > 0) {
      r.vx -= nx * vn * 1.35; r.vz -= nz * vn * 1.35;
      const loss = 1 - Math.min(0.4, vn / 90);
      r.vx *= loss; r.vz *= loss;
      if (vn > 4) hitFx(r, r.x + nx * 2.5, r.z + nz * 2.5, vn, true);
    }
  }
  // rocks, towers
  if (Math.abs(loc.d) > loc.hw + 3) {
    for (const c of COLLIDERS) {
      const dx = r.x - c.x, dz = r.z - c.z, rr = c.r + POD_R;
      const d2 = dx * dx + dz * dz;
      if (d2 > rr * rr) continue;
      const d = Math.sqrt(d2) || 1, nx = dx / d, nz = dz / d;
      r.x = c.x + nx * rr; r.z = c.z + nz * rr;
      const vn = r.vx * nx + r.vz * nz;
      if (vn < 0) {
        r.vx -= nx * vn * 1.4; r.vz -= nz * vn * 1.4;
        r.vx *= 0.55; r.vz *= 0.55;
        if (-vn > 4) hitFx(r, r.x - nx * POD_R, r.z - nz * POD_R, -vn * 1.6, true);
      }
    }
    if (Math.abs(loc.d) > loc.hw + 150) { respawn(r); if (r.player) toast('VISSZA A PÁLYÁRA'); }
  }

  // height: hover over track or dunes, pitch with the slope
  const gy = groundQuery(r.x, r.z);
  const ga = groundQuery(r.x + nfx * 5, r.z + nfz * 5), gb = groundQuery(r.x - nfx * 5, r.z - nfz * 5);
  const target = Math.max(gy, (ga + gb) / 2) + HOVER + Math.sin(t * 2.7 + r.phase) * 0.12 * (1 - Math.min(1, sp / 80));
  r.vy += ((target - r.y) * 60 - r.vy * 12) * dt;
  r.y += r.vy * dt;
  if (r.y < gy + 0.6) { r.y = gy + 0.6; r.vy = Math.max(0, r.vy); }
  r.pitch = damp(r.pitch, -Math.atan2(ga - gb, 10), 8, dt);
  if (off > 0.5 && ga - gb > 1.5) { r.vx *= 1 - 0.5 * dt; r.vz *= 1 - 0.5 * dt; }

  // lap counting
  const s = r.loc.s, prevS = r.prevS ?? s;
  if (s - prevS < -TR.L / 2) r.lap++;
  else if (s - prevS > TR.L / 2) r.lap--;
  r.prevS = s;
  r.prog = r.lap * TR.L + s;
  // wrong-way detection
  const along = r.vx * loc.tx + r.vz * loc.tz;
  r.wrong = along < -6 ? r.wrong + dt : Math.max(0, r.wrong - dt * 2);
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
  r.brake = r.fwd > vt + 5 ? clamp((r.fwd - vt) / 25, 0, 1) : 0;
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
    boosting: !!p.boosting, overheat: p.overheat || 0, heat: p.heat || 0, off: p.off || 0, scrape: player.scrape || 0 });
  AV.others = racers.filter((r) => r !== player && !r.gone).map((r) => { const o = src(r); return { id: r.n, x: o.x, y: o.y, z: o.z, vx: o.vx, vy: 0, vz: o.vz, fwd: o.fwd, throttle: o.throttle, boosting: !!o.boosting }; });
  nearestCoarse(camera.position.x, camera.position.z, _anc);
  const near = _anc.i >= 0 ? 1 - smooth(TR.hw[_anc.i] + 20, TR.hw[_anc.i] + 120, _anc.d) : 0;
  AV.env.canyon = _anc.i >= 0 ? TR.canyon[_anc.i] * near : 0;
  AV.env.arena = _anc.i >= 0 ? TR.arena[_anc.i] * near : 0;
  AV.env.arch = Math.max(0, 1 - Math.hypot(camera.position.x - ARCH.x, camera.position.z - ARCH.z) / 45);
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
const touchState = { left: false, right: false, brake: false, boost: false };
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
for (const [id, k] of [['tLeft', 'left'], ['tRight', 'right'], ['tBrake', 'brake'], ['tBoost', 'boost']]) {
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
  let boost = k('ShiftLeft', 'ShiftRight', 'Space');
  let analog = false;
  if (touchMode) {
    throttle = touchState.brake ? 0 : 1; brake = touchState.brake ? 1 : 0;
    steer += (touchState.left ? 1 : 0) - (touchState.right ? 1 : 0);
    boost = boost || touchState.boost;
  }
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const gp of pads) {
    if (!gp) continue;
    const ax = gp.axes[0] || 0;
    if (Math.abs(ax) > 0.12) { steer = -ax; analog = true; }
    const rt = gp.buttons[7]?.value || 0, lt = gp.buttons[6]?.value || 0;
    if (rt > 0.05 || gp.buttons[0]?.pressed) throttle = Math.max(throttle, gp.buttons[0]?.pressed ? 1 : rt);
    if (lt > 0.05) brake = Math.max(brake, lt);
    if (gp.buttons[2]?.pressed || gp.buttons[5]?.pressed) boost = true;
    const pressed = gp.buttons.map((b) => b.pressed);
    if (pressed[9] && !padPrev[9]) onPress.Escape?.();
    if (pressed[3] && !padPrev[3]) onPress.KeyC?.();
    padPrev = pressed;
    break;
  }
  return { throttle, brake, steer: clamp(steer, -1, 1), boost, analog };
}

// ============================================================
//  Effects
// ============================================================
let shake = 0;
// Hard hits (visual only; the physics is unchanged): a fireball, the beam snaps, panels tear off,
// the pod shudders and one engine trails smoke for a few seconds.
const CRASH_POWER = 40;
function crashFx(r, x, z, power, replay = false) {
  if ((r.crashCD ?? 0) > 0) return;
  r.crashCD = 3;
  if (!replay) r.crashN = (r.crashN ?? 0) + 1;
  r.dmg = 4.5; r.shudder = 1; r.dmgEngine = Math.random() < 0.5 ? 0 : 1;
  const ud = r.mesh.userData;
  ud.beam?.snap();
  const d = Math.hypot(x - player.x, z - player.z);
  if (d < 160) { sfx('crash', Math.min(1, power / 70) * (1 - d / 160)); sfx('zap', 0.8 * (1 - d / 160)); }
  if (r === player) { FX.flash = Math.max(FX.flash, 0.45); shake = Math.max(shake, 1); }
  if (camera.position.distanceTo(r.mesh.position) > 300) return;
  const y = r.y, R = () => Math.random() - 0.5;
  for (let k = 0; k < 3; k++) {
    emit(BLAST, x + R() * 2.5, y + R(), z + R() * 2.5, r.vx * 0.8 + R() * 6, 2 + Math.random() * 3, r.vz * 0.8 + R() * 6,
      1.5 + Math.random() * 0.7, { size0: 2.4 + Math.random(), size1: 7 + Math.random() * 3 });
  }
  ud.engines[r.dmgEngine].getWorldPosition(_v3);
  emit(BLAST, _v3.x, _v3.y, _v3.z, r.vx * 0.85, 2, r.vz * 0.85, 1.3, { size0: 2, size1: 6 });
  const paint = r.color ?? racers[r.n].color;
  for (let k = 0; k < Math.round(8 * PQ); k++) {
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

// collisions: sparks, dust, rock chips and (when it is us) a camera kick and a flash
function hitFx(r, x, z, power, rock = false) {
  if (power >= CRASH_POWER) crashFx(r, x, z, power);
  else if (power > 15) r.mesh.userData.beam?.hit(power / 40);
  const n = Math.round(Math.min(40, power * 1.2) * PQ);
  const y = r.y - 0.3;
  for (let k = 0; k < n; k++) {
    emit(SPARK, x, y, z, (Math.random() - 0.5) * 30 + r.vx * 0.6, Math.random() * 12, (Math.random() - 0.5) * 30 + r.vz * 0.6, 0.25 + Math.random() * 0.5, { bright: 5 + Math.random() * 5 });
  }
  const g = groundQuery(x, z);
  for (let k = 0; k < Math.min(10, power * 0.3); k++) {
    emit(DUST, x + (Math.random() - 0.5) * 3, y, z + (Math.random() - 0.5) * 3, r.vx * 0.3 + (Math.random() - 0.5) * 10, 2 + Math.random() * 6, r.vz * 0.3 + (Math.random() - 0.5) * 10, 1 + Math.random(), { ground: g, size0: 2, size1: 7 });
  }
  if (rock && power > 12) {
    for (let k = 0; k < Math.min(8, power * 0.15) * PQ; k++) {
      DEBRIS.emit(x, y + 0.5, z, r.vx * 0.4 + (Math.random() - 0.5) * 14, 4 + Math.random() * 9, r.vz * 0.4 + (Math.random() - 0.5) * 14, 0.15 + Math.random() * 0.45);
    }
  }
  if (power > 30) emit(SMOKE, x, y + 1, z, r.vx * 0.2, 3, r.vz * 0.2, 1.6, { size0: 3, size1: 10, alpha: 0.4 });
  const d = Math.hypot(x - player.x, z - player.z);
  if (d < 70) {
    const k = clamp(power / 45, 0.1, 1) * (1 - d / 70);
    shake = Math.max(shake, k);
    if (r === player && power > 25) FX.flash = Math.max(FX.flash, Math.min(0.35, power / 160));
    sfx('hit', k);
  }
}
let toastTimer = 0;
const toastEl = document.getElementById('toast');
function toast(text, warn = false, dur = 1.6) {
  toastEl.textContent = text;
  toastEl.classList.toggle('warn', warn);
  toastEl.hidden = false;
  toastTimer = dur;
}
function onOverheat() { toast('TÚLMELEGEDÉS', true); sfx('boom', 0.6); }

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
const FLAME_COL = { idle: new THREE.Color('#ffb066').multiplyScalar(2.2), boost: new THREE.Color('#cfe2ff').multiplyScalar(3.5), over: new THREE.Color('#ff5a2a').multiplyScalar(2) };
const POD_FX = { hot: 0, flash: 0, beam: 0, beamCol: new THREE.Color() };
function racerFx(r, dt, t) {
  const m = r.mesh, ud = m.userData;
  m.position.set(r.x, r.y, r.z);
  m.rotation.y = r.yaw;
  const sp = Math.abs(r.fwd);
  r.roll = damp(r.roll, r.steer * 0.42 * clamp(sp / 50, 0, 1) + r.lat * 0.012, 6, dt);
  ud.body.rotation.set(r.pitch, 0, -r.roll);
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
    const y = 0.15 + Math.sin(t * 6.3 + k * 2.1 + r.phase) * 0.07;
    e.position.y = y; by += y / 2;
    e.rotation.z = Math.sin(t * 4.1 + k + r.phase) * 0.05;
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
    ud.body.position.y = podLift(ud.pod, r, groundQuery, dt);
  }
  podFx.update(r, dt, groundQuery, camera.position);       // also brings the pod's world matrices up to date
  ud.beam.pushFlares();
  for (const e of ud.engines) { const f = e.userData.flame; if (shown(f)) FLAMES.push(f.matrixWorld, f.userData.col); }
  // boost kicks in: shockwave ring (the ignition flash and ring of fire come from podFx)
  if (r.boosting && !r.wasBoost) {
    podFx.shockwave(r);
    if (r === player) { sfx('boostStart'); shake = Math.max(shake, 0.25); }
  }
  r.wasBoost = r.boosting;
  if (camD > 420) return;
  const fx = Math.sin(r.yaw), fz = Math.cos(r.yaw);
  const gy = groundQuery(r.x, r.z), h = r.y - gy;
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
  // grinding along a wall: a stream of sparks at the contact point
  if (r.scrape > 0) {
    const n = Math.floor(r.scrape * 90 * dt * PQ + Math.random());
    for (let k = 0; k < n; k++) {
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
  if (Math.random() < dt * 18 * PQ) {
    const a = Math.random() * TAU, d = 25 + Math.random() * 110;
    const x = camera.position.x + Math.cos(a) * d, z = camera.position.z + Math.sin(a) * d, g = groundQuery(x, z);
    emit(SAND, x, g + 0.8 + Math.random() * 2, z, WIND_DIR.x * (5 + Math.random() * 5), 0.3, WIND_DIR.y * (5 + Math.random() * 5), 4 + Math.random() * 3, { ground: g });
  }
  // spindrift: thin veils of sand streaming off the dune brinks downwind
  for (let k = Math.floor(dt * 60 * PQ + Math.random()); k > 0; k--) {
    const a = Math.random() * TAU, d = 40 + Math.random() * 260;
    const x = camera.position.x + Math.cos(a) * d, z = camera.position.z + Math.sin(a) * d;
    const cr = duneCrest(x, z);
    if (cr < 0.25 || Math.random() > cr) continue;
    const g = groundQuery(x, z), v = 7 + Math.random() * 6;
    emit(SAND, x, g + 0.3, z, WIND_DIR.x * v, 0.6 + Math.random() * 0.8, WIND_DIR.y * v, 2.2 + Math.random() * 1.5,
      { ground: g - 3, size0: 1.5 + Math.random(), size1: 6 + Math.random() * 5, alpha: 0.1 + cr * 0.08 });
  }
}

// ============================================================
//  Race control
// ============================================================
let state = 'loading';   // loading | menu | countdown | race | finished | results | paused
let pausedFrom = null;
let laps = 3, diff = 1, raceT = 0, countT = 0, finishWait = 0, lastCount = 0, throttleAt = -1;
let camMode = 0, camYaw = 0, camY = 0, fov = 60, simT = 0, centerTimer = 0, bestLapRace = Infinity, newRecord = false;
const STORE_KEY = 'homokfutam:v1';
const loadStore = () => { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; } };
const saveStore = (o) => { try { localStorage.setItem(STORE_KEY, JSON.stringify(o)); } catch { /* storage blocked */ } };
let store = loadStore();
let debugAuto = false;
let DEBUG_FORCE = null;   // testing hook: input fields forced onto the player after the autopilot
// multiplayer session (null room = solo)
const MP = { room: null, peers: new Map(), myReady: false, inRace: false, menuOpen: false, raceHost: null,
  sendT: 0, joinT: 0, note: '', noteT: 0, rLaps: 3, rDiff: 1 };
const NO_INPUT = { throttle: 0, brake: 0, steer: 0, boost: false, analog: true };

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
    r.skill = r.player ? 0.82 : SKILL[diff] + v;
    r.topMul = r.player ? 1 : SKILL[diff] + 0.05 + v;
    Object.assign(r, { aiOff: 0, aiOffT: 0, aiBoost: false, lapStart: 0, throttle: 0, brake: 0, boostIn: false, pitch: 0, roll: 0 });
  });
  raceT = 0; countT = 3.2; finishWait = 0; lastCount = 9; throttleAt = -1; bestLapRace = Infinity; newRecord = false;
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
function togglePause() {
  if (MP.room) {               // the race keeps running for everyone else: just an overlay
    if (state !== 'countdown' && state !== 'race' && state !== 'finished') return;
    MP.menuOpen = !MP.menuOpen;
    showScreen(MP.menuOpen ? pauseEl : null);
    if (MP.menuOpen) $('resumeBtn').focus({ preventScroll: true });
    return;
  }
  if (state === 'photo') { exitPhoto(); return; }
  if (state === 'paused') { state = pausedFrom; showScreen(null); hudEl.hidden = CINE.introT > 0; return; }
  if (state === 'countdown' || state === 'race' || state === 'finished') {
    pausedFrom = state; state = 'paused'; showScreen(pauseEl); $('resumeBtn').focus({ preventScroll: true });
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
  $('resHead').innerHTML = `${pos}.<small>HELY</small>`;
  $('resSub').textContent = `Idő ${fmtTime(player.finishTime)} · legjobb kör ${fmtTime(Math.min(...player.lapTimes))}` + (newRecord ? ' · új rekord!' : '');
  $('againBtn').firstElementChild.textContent = MP.room ? 'VISSZA A SZOBÁBA' : 'ÚJ FUTAM';
  $('resMenuBtn').textContent = MP.room ? 'KILÉPÉS A SZOBÁBÓL' : 'FŐMENÜ';
  $('resTable').innerHTML = ranks.map((r, k) => {
    let t;
    if (r.finished) t = k === 0 ? fmtTime(r.finishTime) : '+' + (r.finishTime - ranks[0].finishTime).toFixed(2);
    else if (r.gone) t = 'kiesett';
    else {
      const avg = Math.max(r.prog / Math.max(raceT, 1), 50);
      t = '+' + (raceT + (laps * TR.L - r.prog) / avg - ranks[0].finishTime).toFixed(1);
    }
    return `<tr class="${r.player ? 'me' : ''}"><td>${k + 1}</td><td><span class="swatch" style="background:${r.color}"></span>${r.player ? 'Te' : escapeHtml(r.name)}</td><td class="num">${t}</td></tr>`;
  }).join('');
  showScreen(resultEl);
  $('againBtn').focus({ preventScroll: true });
}
function renderRecord() {
  const b = store.best?.[laps];
  $('recordTxt').innerHTML = b
    ? `Rekordod (${laps} kör): <b class="num">${fmtTime(b)}</b>` + (store.lap ? ` · legjobb kör <b class="num">${fmtTime(store.lap)}</b>` : '')
    : `Még nincs rekordod ${laps} körön.`;
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
      lastCount = c; centerEl.textContent = c; centerEl.className = ''; centerTimer = 1.2;
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
      p.steer = inp.analog ? inp.steer : damp(p.steer, inp.steer, inp.steer === 0 ? 12 : 5, dt);
      p.throttle = inp.throttle; p.brake = inp.brake; p.boostIn = inp.boost;
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
  separate();
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

// the classic chase camera, with springy distance, look-ahead into turns, banking and noise shake
function chaseCam(dt, p, c) {
  camYaw += wrapAngle(p.yaw - camYaw) * (1 - Math.exp(-7 * dt));
  const sp = Math.abs(p.fwd);
  const acc = (p.fwd - CAMV.lastFwd) / Math.max(dt, 1e-3);
  CAMV.lastFwd = p.fwd;
  CAMV.accel = damp(CAMV.accel, clamp(acc / 60, -1, 1), 4, dt);
  CAMV.dist = damp(CAMV.dist, c.d * (1 + 0.07 * clamp(sp / 150, 0, 1)) + (p.boosting ? 2.4 : 0) + CAMV.accel * 1.3, 3, dt);
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
  const rum = Math.pow(clamp(sp / 190, 0, 1), 2) * 0.045 + (p.boosting ? 0.035 : 0);
  shake = Math.max(0, shake - dt * 2.2);
  camera.position.set(x + noise1(t * 3.1, 1) * sh + noise1(t * 23, 7) * rum, camY + noise1(t * 2.7, 4) * sh + noise1(t * 26, 3) * rum, z + noise1(t * 3.3, 9) * sh * 0.6);
  CAMV.lookX = damp(CAMV.lookX, p.steer * clamp(sp / 40, 0, 1) * 3.2, 2.5, dt);
  camera.lookAt(p.x + fx * 12 + fz * CAMV.lookX, p.y + c.look, p.z + fz * 12 - fx * CAMV.lookX);
  CAMV.roll = damp(CAMV.roll, -p.roll * 0.2 + noise1(t * 2.2, 5) * sh * 0.05, 5, dt);
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
  REC.frames.push({ t: raceT, s: racers.map((r) => [r.x, r.y, r.z, r.yaw, r.fwd, r.steer, r.lat, r.pitch, r.throttle, r.boosting ? 1 : 0, r.overheat > 0 ? 1 : 0, r.off, r.vx, r.vz, r.gone ? 1 : 0, r.heat, r.brake, r.loc.s, r.crashN ?? 0]) });
  while (REC.frames.length > 360) REC.frames.shift();
}
function startReplay() {
  if (REC.frames.length < 90) return;
  CINE.replay = {
    t: REC.frames[0].t, station: null, look: null,
    proxies: racers.map((r) => ({ n: r.n, mesh: r.mesh, player: r.player, phase: r.phase, roll: 0, loc: { s: 0, arena: 0 }, vy: 0, wasBoost: false, scrape: 0 })),
  };
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
      boosting: !!b[9], overheat: b[10], off: L(11), vx: L(12), vz: L(13), gone: !!b[14], heat: L(15), brake: L(16), mesh: racers[n].mesh });
    p.loc.s = a[17] + (((b[17] - a[17] + TR.L * 1.5) % TR.L) - TR.L / 2) * k;
    p.mesh.visible = !p.gone;
    if (p.crashN !== undefined && b[18] > p.crashN) crashFx(p, p.x, p.z, 50, true);
    p.crashN = b[18];
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
  }
}
const hudCache = {};
function setHTML(id, v) { if (hudCache[id] !== v) { hudCache[id] = v; $(id).innerHTML = v; } }
function updateHUD() {
  const pos = standings().indexOf(player) + 1;
  setHTML('posBig', `${pos}<small>/${racers.length}</small>`);
  setHTML('lapTxt', player.finished ? 'CÉLBAN' : `KÖR ${clamp(player.lap + 1, 1, laps)}/${laps}`);
  const t = state === 'countdown' ? 0 : player.finished ? player.finishTime : raceT;
  setHTML('totalVal', fmtTime(t));
  setHTML('lapVal', fmtTime(player.finished ? player.lapTimes[player.lapTimes.length - 1] : state === 'countdown' ? 0 : raceT - player.lapStart));
  setHTML('bestLapVal', fmtTime(bestLapRace));
  setHTML('speedVal', String(Math.round(Math.abs(player.fwd) * 3.6)));
  $('heatFill').style.width = player.heat.toFixed(1) + '%';
  const over = player.overheat > 0;
  $('heatFill').classList.toggle('over', over);
  $('boostTag').classList.toggle('off', over);
  setHTML('boostTag', over ? 'HŰL' : 'BOOST');
  if (state === 'race' && player.wrong > 1.2) toast('ROSSZ IRÁNY', true, 0.3);
  drawMinimap();
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
onPress.KeyM = () => { setMuted(!SND.muted); toast(SND.muted ? 'HANG KI' : 'HANG BE'); };
onPress.KeyN = () => { AUDIO.setMusic(!AUDIO.musicOn); toast(AUDIO.musicOn ? 'ZENE BE' : 'ZENE KI'); try { localStorage.setItem('homokfutam:music', AUDIO.musicOn ? '1' : '0'); } catch { /* storage blocked */ } };
try { if (localStorage.getItem('homokfutam:music') === '0') AUDIO.setMusic(false); } catch { /* storage blocked */ }
document.addEventListener('click', (e) => { if (e.target.closest?.('button')) { initAudio(); sfx('ui'); } });
canvas.addEventListener('pointerdown', () => initAudio());
document.addEventListener('visibilitychange', () => { if (!MP.room && document.hidden && state !== 'paused') togglePause(); });
touchMode = window.matchMedia('(pointer: coarse)').matches;
document.body.classList.toggle('touch', touchMode);
if (touchMode) {
  $('keysHelp').innerHTML = '<kbd>◀ ▶</kbd><span>kormányzás (a gáz automatikus)</span><kbd>FÉK</kbd><span>lassítás</span><kbd>BOOST</kbd><span>gyorsítás, melegíti a hajtóműveket</span>';
}
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
    if (MP.inRace) toast(`${who.toUpperCase()} KILÉPETT`); else roomNote(`${who} kilépett.`);
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
  $('playerList').innerHTML = rows.map(([id, p]) => {
    const tags = (id === selfId ? '<em>te</em>' : '') + (id === host ? '<em>házigazda</em>' : '');
    const st = p.racing ? '<b>VERSENYEZ…</b>' : p.ready ? '<b class="ok">KÉSZ</b>' : '<b>NEM KÉSZ</b>';
    return `<li><span>${escapeHtml(p.name)}${tags}</span>${st}</li>`;
  }).join('');
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
// [livery, x, y, z, yaw, vx, vz, fwd, lat, steer, throttle, flags, lap, s, finishTime, heat, pitch]
const rd = (v, k = 100) => Math.round(v * k) / k;
function netSend(dt) {
  if (!MP.room || !MP.inRace || state === 'room') return;
  if ((MP.sendT -= dt) > 0) return;
  MP.sendT = 0.05;
  const e = [];
  for (const r of racers) {
    if (r.gone || r.ctl === 'net') continue;
    e.push([r.n, rd(r.x), rd(r.y), rd(r.z), rd(r.yaw, 1000), rd(r.vx), rd(r.vz), rd(r.fwd), rd(r.lat), rd(r.steer), rd(r.throttle),
      (r.boosting ? 1 : 0) | (r.overheat > 0 ? 2 : 0) | (r.finished ? 4 : 0), r.lap, rd(r.loc.s), rd(r.finishTime), Math.round(r.heat), rd(r.pitch, 1000), r.crashN ?? 0]);
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
      f: e[11] | 0, lap: e[12] | 0, s: +e[13], ft: +e[14], heat: +e[15], pitch: +e[16], crash: e[17] | 0, fresh: !r.net || r.net.fresh };
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
  Object.assign(r, { vx: n.vx, vz: n.vz, fwd: n.fwd, lat: n.lat, steer: n.steer, throttle: n.th, boosting: !!(n.f & 1),
    overheat: n.f & 2 ? 1 : 0, heat: n.heat, pitch: n.pitch, lap: n.lap, finished: !!(n.f & 4), finishTime: n.ft });
  r.prog = n.lap * TR.L + n.s;
  if (r.crashN !== undefined && n.crash > r.crashN) crashFx(r, r.x, r.z, 50, true);
  r.crashN = n.crash;
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
    if (CINE.replay) stepReplay(sdt);
    else for (const r of racers) if (!r.gone) racerFx(r, sdt, simT);
    endFxFrame();
    recordReplay(sdt);
    if (state === 'race' || state === 'finished') {
      for (const r of racers) if (!r.gone) TRAILS.stamp(r, groundQuery(r.x, r.z));
      TRAILS.render(sdt);
    }
    netSend(dt);
    roomTimers(dt);
    updateWind(sdt);
    if (toastTimer > 0 && (toastTimer -= dt) <= 0) toastEl.hidden = true;
    if (centerTimer > 0 && (centerTimer -= dt) <= 0) centerEl.textContent = '';
  }
  if (state === 'photo') PHOTO.h = clamp(PHOTO.h + ((keys.has('KeyE') ? 1 : 0) - (keys.has('KeyQ') ? 1 : 0)) * dt * 4, -1.5, 25);
  arenaLife(sdt);
  updateCamera(dt);
  placeSunShadow();
  if (state === 'countdown' || state === 'race' || state === 'finished' || state === 'paused') updateHUD();
  updateAudio(dt, state === 'countdown' || state === 'race' || state === 'finished' || state === 'results');
  renderFrame(dt);
  if (PHOTO.shot) { PHOTO.shot = false; savePhoto(); }
  PERF.js += (performance.now() - tStart - PERF.js) * 0.05;
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
const FX = { blur: 0, aberr: 0, flash: 0, fade: 0, center: new THREE.Vector2(0.5, 0.5), dof: { on: false, focus: new THREE.Vector3(), range: 14 } };
const _pv = new THREE.Vector3();
function renderFrame(dt) {
  beamLights();
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
  const fp = CINE.replay ? CINE.replay.proxies[player.n] : player;
  if (FX.dof.on) { FX.dof.focus.set(fp.x, fp.y + 1, fp.z); FX.dof.range = state === 'photo' ? Math.max(6, PHOTO.dist * 0.6) : CINE.replay ? 30 : 18; }
  post.update(dt, FX);
  heatLayer?.render(renderer, camera);
  post.render(dt);
}


// local testing hook (only on localhost): fast-forward the race without rendering every frame
if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
  window.__homok = {
    THREE, scene, renderer, camera, fx: () => ({ DUST, SMOKE, SPARK, FIRE, CONFETTI, WIND, SAND, BLAST }), get post() { return post; }, set post(v) { post = v; },
    start(l = 1, d = 1, intro = false) { laps = l; diff = d; newRace(); if (!intro) endIntro(); return this.info(); },
    cine: CINE, photo: PHOTO,
    perf(frames = 120) {
      return new Promise((res) => {
        let n = 0; const t0 = performance.now();
        const tick = () => {
          if (++n >= frames) res({ fps: +(frames * 1000 / (performance.now() - t0)).toFixed(1), jsMs: +PERF.js.toFixed(2), calls: renderer.info.render.calls, tris: renderer.info.render.triangles, ratio: renderer.getPixelRatio(), q: Q.name });
          else requestAnimationFrame(tick);
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
          if (CINE.finishT > 0) CINE.finishT = Math.max(0, CINE.finishT - dt * 4);
        }
      }
      updateCamera(0.5); if (state !== 'results') updateHUD(); renderFrame(0.016);
      return this.info();
    },
    cam(m) { camMode = m; updateCamera(1); renderFrame(0.016); },
    // view({ eye: [x, y, z], look: [x, y, z], n, fov }) pod-relative; view(null) back to the game cameras
    view(d) { DEBUG_CAM = d; updateCamera(1); renderFrame(0.016); },
    racer(n = 0) { return racers[n]; },
    force(o) { DEBUG_FORCE = o; },
    groundDebug(n) { groundDebug(n); renderFrame(0.016); },
    crash(n = 0, power = 60) { const r = racers[n]; crashFx(r, r.x + Math.sin(r.yaw) * 2, r.z + Math.cos(r.yaw) * 2, power); },
    info() {
      return { state, raceT: +raceT.toFixed(1), mp: MP.room ? { code: MP.room.code, host: MP.room.isHost, peers: MP.room.peers.size, inRace: MP.inRace } : null, racers: racers.map((r) => ({ n: r.name, ctl: r.ctl, gone: r.gone, lap: r.lap, prog: Math.round(r.prog), d: +r.loc.d.toFixed(1), v: Math.round(r.fwd * 3.6), fin: r.finished, ft: +r.finishTime.toFixed(1), laps: r.lapTimes.map((t) => +t.toFixed(1)), heat: Math.round(r.heat), roll: +r.roll.toFixed(2) })) };
    },
  };
}

// static sun shadow for the whole world, rendered once everything static exists
const WORLD_BOUNDS = new THREE.Box3(new THREE.Vector3(-1850, -70, -2450), new THREE.Vector3(2050, 270, 1000));
function boot(data) {
  try { bakeMacro(renderer, scene, { x0: TERRAIN.cx - TERRAIN.size / 2, z0: TERRAIN.cz - TERRAIN.size / 2, size: TERRAIN.size, res: 1024 }); }
  catch (e) { console.warn('HOMOKFUTAM: macro map failed', e); }
  if (PROPS_MODELS) {
    try { ROCKS.scatter = buildScatter({ scene, TR, Q, groundQuery, rng, models: PROPS_MODELS, rockMat: boulderMatAO, metalMat: ARENA_MATS.metal }); }
    catch (e) { console.warn('HOMOKFUTAM: ground clutter failed', e); }
  }
  bakeWorldShadow(renderer, scene, WORLD_BOUNDS, Q.staticShadow);
  // LOW: only the things that move (pods, debris) draw into the near shadow map every frame; the
  // static world keeps just its baked shadow
  if (Q.casters === false) {
    const moves = (o) => { for (let p = o; p; p = p.parent) if (p.userData.dynamic) return true; return false; };
    scene.traverse((o) => { if (o.isMesh && o.castShadow && !moves(o)) o.castShadow = false; });
  }
  try { buildHaze({ scene, TR, rangeWhere, arch: ROCKS.arch, Q }); } catch (e) { console.warn('HOMOKFUTAM: haze failed', e); }
  if (Q.post) {
    try {
      post = createPost(renderer, scene, camera, Q, SUN_DIR);
      if (heatLayer) { post.speed.uniforms.get('uDistort').value = heatLayer.rt.texture; post.speed.uniforms.get('uDistortOn').value = 1; }
      resize();
    }
    catch (e) { console.warn('HOMOKFUTAM: post-processing failed, rendering without it', e); post = null; renderer.toneMapping = THREE.ACESFilmicToneMapping; }
  }
  if (data && data.laps) { laps = data.laps; syncSeg('lapsSeg', laps); }
  if (data && data.diff != null) { diff = data.diff; syncSeg('diffSeg', diff); }
  if (data && data.muted) setMuted(true);
  showMenu();
  readInvite();
  window.addEventListener('hashchange', readInvite);
  requestAnimationFrame((t) => { lastT = t; frame(t); $('loading').hidden = true; });
}
// show the game once the surface textures are in (or after 10 s, whatever happens first)
const texturesReady = Promise.race([Promise.all([SURF.ready, GROUND_READY, ROCKS_READY, ARENA_READY, PROPS_READY]), new Promise((r) => setTimeout(r, 15000))]);
const hot = window.claude && window.claude.hot;
if (hot && typeof hot.snapshot === 'function') { try { hot.snapshot(() => ({ laps, diff, muted: SND.muted })); } catch { /* ignore */ } }
if (hot && typeof hot.ready === 'function') hot.ready((d) => texturesReady.then(() => boot(d)));
else texturesReady.then(() => boot((hot && hot.data) || {}));
