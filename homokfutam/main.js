import * as THREE from 'three';
import { RaceRoom, selfId } from './net.js';
import { loadPlayerPod, setPodLivery, animatePlayerPod } from './playerPod.js';

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
const _nc = { i: 0, d: 0 };
function groundAt(x, z, i, dist) {
  if (i < 0) return duneH(x, z);
  const ty = TR.py[i], hw = TR.hw[i], c = TR.canyon[i];
  let far = duneH(x, z);
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
  track: canvasTex(256, 512, (g, w, h) => {
    grain(g, w, h, [205, 170, 122], 26, 7);
    const r = rng(11);
    for (let k = 0; k < 140; k++) {           // streaks along the racing direction
      const x = r() * w, len = 60 + r() * 380, y = r() * h;
      g.strokeStyle = `rgba(${r() < 0.5 ? '120,85,50' : '245,220,180'},${0.05 + r() * 0.12})`;
      g.lineWidth = 1 + r() * 4;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + (r() - 0.5) * 6, y + len); g.stroke();
      g.beginPath(); g.moveTo(x, y - h); g.lineTo(x + (r() - 0.5) * 6, y - h + len); g.stroke();
    }
    const grd = g.createLinearGradient(0, 0, w, 0);      // darker, packed edges
    grd.addColorStop(0, 'rgba(110,75,40,.45)'); grd.addColorStop(0.08, 'rgba(110,75,40,0)');
    grd.addColorStop(0.92, 'rgba(110,75,40,0)'); grd.addColorStop(1, 'rgba(110,75,40,.45)');
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
  }),
  ground: canvasTex(256, 256, (g, w, h) => {
    grain(g, w, h, [236, 214, 178], 30, 3);
    const r = rng(5);
    for (let k = 0; k < 60; k++) {
      g.strokeStyle = `rgba(150,110,70,${0.04 + r() * 0.06})`; g.lineWidth = 1 + r() * 2;
      const y = r() * h; g.beginPath(); g.moveTo(0, y);
      for (let x = 0; x <= w; x += 16) g.lineTo(x, y + Math.sin(x * 0.05 + k) * 4);
      g.stroke();
    }
  }),
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
  bolt: canvasTex(16, 64, (g, w, h) => {         // soft falloff across the energy beam
    const grd = g.createLinearGradient(0, 0, 0, h);
    grd.addColorStop(0, 'rgba(255,255,255,0)'); grd.addColorStop(0.42, 'rgba(255,255,255,.55)');
    grd.addColorStop(0.5, 'rgba(255,255,255,1)'); grd.addColorStop(0.58, 'rgba(255,255,255,.55)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
  }, false),
};
TEX.checker.magFilter = THREE.NearestFilter;

// ============================================================
//  Renderer, scene, sky, light
// ============================================================
const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.02;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
const HAZE = new THREE.Color('#e6d2b2');
scene.fog = new THREE.Fog(HAZE, 320, 3300);
scene.background = HAZE;
const camera = new THREE.PerspectiveCamera(70, 1, 0.5, 9000);

const SUN_DIR = new THREE.Vector3(-0.55, 0.62, 0.42).normalize();
{
  const geo = new THREE.SphereGeometry(8000, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      zenith: { value: new THREE.Color('#3f7fc8') },
      horizon: { value: HAZE },
      sunCol: { value: new THREE.Color('#fff2d6') },
      sunDir: { value: SUN_DIR },
    },
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position.z = gl_Position.w; }`,
    fragmentShader: `uniform vec3 zenith; uniform vec3 horizon; uniform vec3 sunCol; uniform vec3 sunDir; varying vec3 vDir;
      void main(){
        float h = max(vDir.y, 0.0);
        vec3 col = mix(horizon, zenith, pow(smoothstep(0.0, 0.55, h), 0.75));
        float sd = max(dot(normalize(vDir), sunDir), 0.0);
        col += sunCol * (pow(sd, 900.0) * 6.0 + pow(sd, 12.0) * 0.18);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(geo, mat);
  sky.frustumCulled = false; sky.renderOrder = -1;
  scene.add(sky);
  scene.userData.sky = sky;
}
scene.add(new THREE.HemisphereLight('#c4d9f0', '#c99a62', 1.4));
const sun = new THREE.DirectionalLight('#fff0d8', 2.7);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -70, right: 70, top: 70, bottom: -70, near: 10, far: 1400 });
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.6;
scene.add(sun, sun.target);

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
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
const rockMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95, side: THREE.DoubleSide });
const stoneMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide });
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
{
  const SIZE = 7200, SEG = 300;
  const cx = 90, cz = -690;
  const g = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
  g.rotateX(-Math.PI / 2);
  const p = g.attributes.position, colors = new Float32Array(p.count * 3);
  const sandHi = C('#ead2a6'), sandLo = C('#d2a46c'), packed = C('#c49563');
  for (let v = 0; v < p.count; v++) {
    const x = p.getX(v) + cx, z = p.getZ(v) + cz;
    nearestCoarse(x, z, _nc);
    const y = groundAt(x, z, _nc.i, _nc.d);
    p.setXYZ(v, x, y, z);
    const t = clamp((y + 10) / 45, 0, 1) * 0.7 + fbm(x * 0.01, z * 0.01, 2) * 0.3;
    _col.copy(sandLo).lerp(sandHi, t);
    if (_nc.i >= 0) _col.lerp(packed, (1 - smooth(TR.hw[_nc.i], TR.hw[_nc.i] + 40, _nc.d)) * 0.5);
    colors[v * 3] = _col.r; colors[v * 3 + 1] = _col.g; colors[v * 3 + 2] = _col.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.computeVertexNormals();
  TEX.ground.repeat.set(SEG * 0.5, SEG * 0.5);
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: TEX.ground, vertexColors: true, roughness: 1 }));
  m.receiveShadow = true;
  scene.add(m);
}

// ============================================================
//  Track surface, start line, edge posts
// ============================================================
{
  const pos = [], uv = [], index = [];
  const cols = [-1.25, -1, 1, 1.25];        // multiples of half-width (outer = sand shoulder)
  for (let k = 0; k <= TR.N; k++) {
    const i = TR.idx(k), hw = TR.hw[i], y = TR.py[i];
    const rx = -TR.tz[i], rz = TR.tx[i];
    for (const c of cols) {
      const o = c * hw;
      pos.push(TR.px[i] + rx * o, y + (Math.abs(c) > 1 ? -0.3 : 0.06), TR.pz[i] + rz * o);
      uv.push((c + 1) / 2, TR.s[k] / 46);
    }
  }
  for (let r = 0; r < TR.N; r++) for (let j = 0; j < 3; j++) {
    const a = r * 4 + j, b = a + 4;
    index.push(a, a + 1, b, a + 1, b + 1, b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(index); g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: TEX.track, roughness: 0.97, polygonOffset: true, polygonOffsetFactor: -2 }));
  m.receiveShadow = true;
  scene.add(m);

  // checkered start/finish line
  const line = new THREE.Mesh(new THREE.PlaneGeometry(TR.hw[0] * 2, 3.2), new THREE.MeshStandardMaterial({ map: TEX.checker, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -4 }));
  line.rotation.set(-Math.PI / 2, 0, TR.yaw[0]);
  line.position.set(TR.px[0], TR.py[0] + 0.08, TR.pz[0]);
  line.receiveShadow = true;
  scene.add(line);

  // edge posts in the open desert sections
  const list = [];
  for (let k = 0; k < TR.N; k += 7) {
    if (TR.arena[k] > 0.05 || TR.canyon[k] > 0.05) continue;
    for (const side of [-1, 1]) list.push([k, side]);
  }
  const post = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.22, 0.3, 1.6, 6), new THREE.MeshStandardMaterial({ roughness: 0.6 }), list.length);
  const mtx = new THREE.Matrix4(), orange = C('#ff7b2e'), white = C('#f4ece0');
  list.forEach(([i, side], n) => {
    const o = TR.hw[i] + 1.4;
    mtx.makeTranslation(TR.px[i] - TR.tz[i] * side * o, TR.py[i] + 0.7, TR.pz[i] + TR.tx[i] * side * o);
    post.setMatrixAt(n, mtx);
    post.setColorAt(n, (n >> 1) % 2 ? orange : white);
  });
  post.castShadow = true;
  scene.add(post);
}

// ============================================================
//  Canyon
// ============================================================
{
  const r = rangeWhere(TR.canyon, 0.01);
  if (r) {
    for (const side of [-1, 1]) {
      const prof = (i) => {
        const c = TR.canyon[i], H = TR.wallH[i] * c, hw = TR.hw[i], ty = TR.py[i], s = TR.s[i];
        const out = [];
        for (let j = 0; j <= 9; j++) {
          const h = j / 9;
          const n = fbm(s * 0.035, j * 0.9 + side * 31, 3) - 0.5;
          out.push([hw + 0.8 + 6 * h * h + n * 5 * h + (j === 0 ? 0 : 1.2), ty - 1.5 + H * h + n * 2 * h]);
        }
        out.push([hw + 30, ty + H + (fbm(s * 0.02, side * 5) - 0.5) * 6]);
        out.push([hw + 75, ty + H * 0.85]);
        out.push([hw + 135, ty - 6]);
        return out;
      };
      const g = sweep(r[0] - 2, r[1] + 2, side, prof, (i, j, y, out) => (j >= 10 ? out.copy(ROCK.top).lerp(ROCK.light, 0.3) : strata(y, TR.s[i] + side * 70, out)));
      const m = new THREE.Mesh(g, rockMat);
      m.castShadow = m.receiveShadow = true;
      scene.add(m);
    }
    // a natural rock bridge across the canyon
    const mid = TR.idx(Math.round((r[0] + r[1]) / 2) + 18);
    const H = TR.wallH[mid] * 0.82;
    const bg = new THREE.BoxGeometry(2 * (TR.hw[mid] + 22), 9, 16, 12, 3, 3);
    const bp = bg.attributes.position;
    for (let v = 0; v < bp.count; v++) {
      const x = bp.getX(v), y = bp.getY(v);
      bp.setY(v, y + (y < 0 ? -Math.cos((x / (TR.hw[mid] + 22)) * Math.PI / 2) * 5 : 0) + (hash2(v, 3) - 0.5) * 1.5);
      bp.setZ(v, bp.getZ(v) + (hash2(v, 9) - 0.5) * 2.5);
    }
    const bcol = new Float32Array(bp.count * 3);
    for (let v = 0; v < bp.count; v++) { strata(bp.getY(v) + H, 300, _col); bcol.set([_col.r, _col.g, _col.b], v * 3); }
    bg.setAttribute('color', new THREE.BufferAttribute(bcol, 3));
    bg.computeVertexNormals();
    const bridge = new THREE.Mesh(bg, rockMat);
    bridge.position.set(TR.px[mid], TR.py[mid] + H, TR.pz[mid]);
    bridge.rotation.y = TR.yaw[mid];
    bridge.castShadow = bridge.receiveShadow = true;
    scene.add(bridge);
  }
}

// ============================================================
//  Arena: wall, stands, banners, start gantry with lights
// ============================================================
const START_LIGHTS = [];
let gantrySign = null;
{
  const stoneA = C('#e6d3b3'), stoneB = C('#cfb38c'), stoneC = C('#b99a72');
  const standsMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.92, side: THREE.DoubleSide });
  const r = rangeWhere(TR.arena, 0.55);
  if (r) {
    for (const side of [-1, 1]) {
      const prof = (i) => {
        const hw = TR.hw[i], y0 = TR.py[i];
        const out = [[hw + 1.2, y0 - 0.6], [hw + 1.2, y0 + 2.4], [hw + 2.8, y0 + 2.4], [hw + 2.8, y0 + 4.2]];
        for (let j = 0; j < 11; j++) {
          const o = hw + 2.8 + 3.2 * (j + 1), y = y0 + 4.2 + 2.2 * j;
          out.push([o, y], [o, y + 2.2]);
        }
        const last = out[out.length - 1];
        out.push([last[0], last[1] + 4.5], [last[0] + 2.5, last[1] + 4.5], [last[0] + 2.5, y0 - 4]);
        return out;
      };
      const g = sweep(r[0], r[1], side, prof, (i, j, y, out) => {
        if (j < 3) return out.copy(stoneC);
        const block = hash2(i >> 3, side + 7);
        out.copy(j % 2 ? stoneA : stoneB).lerp(stoneC, block * 0.35);
        return out;
      });
      const m = new THREE.Mesh(g, standsMat);
      m.castShadow = m.receiveShadow = true;
      scene.add(m);
    }

    // banners on the arena wall
    const PAL = ['#2f6fd0', '#e8772e', '#c8342c', '#efe6d4', '#e2b93b', '#3c8f6a', '#7a4fc0'].map(C);
    const items = [];
    for (let k = r[0] + 4; k <= r[1] - 4; k += 4) for (const side of [-1, 1]) items.push([TR.idx(k), side]);
    const geo = new THREE.BoxGeometry(2.8, 11, 0.18);
    geo.translate(0, 5.5, 0);
    const banners = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.85 }), items.length);
    const T = new THREE.Vector3(), U = new THREE.Vector3(0, 1, 0), R = new THREE.Vector3(), mtx = new THREE.Matrix4();
    items.forEach(([i, side], n) => {
      T.set(TR.tx[i], 0, TR.tz[i]); R.set(-TR.tz[i], 0, TR.tx[i]);
      mtx.makeBasis(T, U, R);
      const o = (TR.hw[i] + 2) * side;
      mtx.setPosition(TR.px[i] + R.x * o, TR.py[i] + 2.4, TR.pz[i] + R.z * o);
      banners.setMatrixAt(n, mtx);
      banners.setColorAt(n, PAL[Math.floor(hash2(n, 77) * PAL.length)]);
    });
    banners.castShadow = true;
    scene.add(banners);
  }

  // start gantry: two domed towers and a bridge with five lights
  const i = 0, hw = TR.hw[i], y0 = TR.py[i];
  const T = new THREE.Vector3(TR.tx[i], 0, TR.tz[i]), U = new THREE.Vector3(0, 1, 0), R = new THREE.Vector3(-TR.tz[i], 0, TR.tx[i]);
  const base = new THREE.Vector3(TR.px[i], y0, TR.pz[i]);
  const towerMat = new THREE.MeshStandardMaterial({ color: '#e9dcc5', roughness: 0.8, flatShading: true });
  const darkMat = new THREE.MeshStandardMaterial({ color: '#4a3b2c', roughness: 0.7 });
  for (const side of [-1, 1]) {
    const t = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(6.5, 7.2, 22, 20), towerMat);
    body.position.y = 11;
    const dome = new THREE.Mesh(new THREE.SphereGeometry(6.5, 20, 10, 0, TAU, 0, Math.PI / 2), towerMat);
    dome.position.y = 22;
    const band = new THREE.Mesh(new THREE.CylinderGeometry(6.65, 6.65, 1.2, 20), darkMat);
    band.position.y = 17;
    t.add(body, dome, band);
    t.position.copy(base).addScaledVector(R, side * (hw + 12));
    t.traverse((o) => { o.castShadow = o.receiveShadow = true; });
    scene.add(t);
    COLLIDERS.push({ x: t.position.x, z: t.position.z, r: 7.5 });
  }
  const span = 2 * (hw + 12);
  const gantry = new THREE.Mesh(new THREE.BoxGeometry(span, 5, 5), towerMat);
  const mtx = new THREE.Matrix4().makeBasis(R, U, T.clone().negate());
  gantry.quaternion.setFromRotationMatrix(mtx);
  gantry.position.copy(base).setY(y0 + 17);
  gantry.castShadow = true;
  scene.add(gantry);
  // lights face the grid (which sits behind the line, on -T)
  for (let k = 0; k < 5; k++) {
    const lamp = new THREE.Mesh(new THREE.CircleGeometry(0.9, 18), new THREE.MeshBasicMaterial({ color: '#2b2118', fog: false }));
    lamp.quaternion.copy(gantry.quaternion);
    lamp.position.copy(base).addScaledVector(R, (k - 2) * 2.6).addScaledVector(T, -2.56).setY(y0 + 15.6);
    scene.add(lamp);
    START_LIGHTS.push(lamp);
  }
  // sign on the far side of the gantry
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
    sign.quaternion.copy(gantry.quaternion);
    if (dir > 0) sign.rotateY(Math.PI);
    sign.position.copy(base).addScaledVector(T, 2.56 * dir).setY(y0 + (dir > 0 ? 17 : 18.2));
    scene.add(sign);
  }
}

// ============================================================
//  Rock spires, boulders, mesas, natural arch
// ============================================================
function spireGeometry(seed, lean) {
  const g = new THREE.CylinderGeometry(1, 1, 1, 9, 14, true);
  g.translate(0, 0.5, 0);
  const p = g.attributes.position;
  const col = new Float32Array(p.count * 3);
  for (let v = 0; v < p.count; v++) {
    const x = p.getX(v), y = p.getY(v), z = p.getZ(v);
    const a = Math.atan2(z, x);
    const prof = lerp(1, 0.55, y) + 0.1 * Math.sin(y * 5 + seed) + (y > 0.93 ? -0.2 : 0);
    const sc = prof * (0.68 + 0.64 * vnoise(Math.cos(a) * 1.6 + seed * 3.1, y * 5 + Math.sin(a) * 1.6));
    p.setXYZ(v, x * sc + lean * y * y, y, z * sc);
    strata(y * 120, seed * 40, _col);
    col.set([_col.r, _col.g, _col.b], v * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}
function lumpGeometry(seed, detail = 1) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.attributes.position, col = new Float32Array(p.count * 3);
  for (let v = 0; v < p.count; v++) {
    const x = p.getX(v), y = p.getY(v), z = p.getZ(v);
    const k = 0.75 + 0.5 * vnoise(x * 1.7 + seed, z * 1.7 + y * 1.3);
    p.setXYZ(v, x * k, y * k * 0.75, z * k);
    strata(y * 18 + 10, seed * 13, _col);
    col.set([_col.r, _col.g, _col.b], v * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}
{
  const rand = rng(1999);
  const spires = Array.from({ length: 8 }, (_, k) => spireGeometry(k * 1.7 + 0.3, (rand() - 0.5) * 0.25));
  const place = (x, z, h, r, gi) => {
    const m = new THREE.Mesh(spires[gi % spires.length], rockMat);
    m.scale.set(r, h, r);
    m.position.set(x, groundQuery(x, z) - 3, z);
    m.rotation.y = rand() * TAU;
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
    COLLIDERS.push({ x, z, r: r * 0.9 });
  };
  // a signature cluster you see when leaving the arena
  [[540, -215, 150, 22], [610, -300, 115, 17], [455, -310, 95, 15], [700, -390, 70, 12]].forEach(([x, z, h, r], k) => {
    nearestCoarse(x, z, _nc);
    if (_nc.d > TR.hw[Math.max(_nc.i, 0)] + 30) place(x, z, h, r, k);
  });
  let placed = 0, tries = 0;
  while (placed < 70 && tries++ < 3000) {
    const x = 90 + (rand() - 0.5) * 3600, z = -690 + (rand() - 0.5) * 3200;
    nearestCoarse(x, z, _nc);
    if (_nc.i >= 0 && (_nc.d < TR.hw[_nc.i] + 45 || TR.canyon[_nc.i] > 0.05)) continue;
    const near = _nc.i >= 0;
    const h = near ? 40 + rand() * 90 : 60 + rand() * 140;
    place(x, z, h, h * (0.12 + rand() * 0.06), placed);
    placed++;
  }

  // boulders near the racing line (open sections only)
  const lumps = [lumpGeometry(1), lumpGeometry(2.5), lumpGeometry(4.2)];
  for (let k = 0; k < 140; k++) {
    const i = Math.floor(rand() * TR.N);
    if (TR.arena[i] > 0.05 || TR.canyon[i] > 0.05) continue;
    const side = rand() < 0.5 ? -1 : 1, o = TR.hw[i] + 12 + rand() * 70, r = 1.5 + rand() * rand() * 7;
    const x = TR.px[i] - TR.tz[i] * side * o, z = TR.pz[i] + TR.tx[i] * side * o;
    const m = new THREE.Mesh(lumps[k % 3], rockMat);
    m.scale.setScalar(r);
    m.position.set(x, groundQuery(x, z) + r * 0.2, z);
    m.rotation.set(rand() * 3, rand() * 3, rand() * 3);
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
    COLLIDERS.push({ x, z, r: r * 0.85 });
  }

  // distant mesas
  for (let k = 0; k < 18; k++) {
    const a = (k / 18) * TAU + rand() * 0.25, d = 2300 + rand() * 900;
    const g = new THREE.CylinderGeometry(1, 1.25, 1, 14, 3);
    const p = g.attributes.position;
    for (let v = 0; v < p.count; v++) {
      const x = p.getX(v), z = p.getZ(v), sc = 0.8 + 0.4 * vnoise(x * 2 + k, z * 2);
      p.setXYZ(v, x * sc, p.getY(v) + 0.5, z * sc);
    }
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: k % 3 ? '#c99566' : '#b98157', flatShading: true, roughness: 1 }));
    const w = 250 + rand() * 450;
    m.scale.set(w, 120 + rand() * 230, w * (0.5 + rand() * 0.5));
    m.position.set(90 + Math.cos(a) * d, -25, -690 + Math.sin(a) * d);
    m.rotation.y = rand() * TAU;
    scene.add(m);
  }

  // natural arch over the track
  const ai = TR.idx(Math.round(TR.N * (TR.ctrlS[13] + 25) / TR.L));
  const R = TR.hw[ai] + 14;
  const ag = new THREE.TorusGeometry(R, 7, 9, 30, Math.PI);
  const ap = ag.attributes.position, acol = new Float32Array(ap.count * 3);
  for (let v = 0; v < ap.count; v++) {
    const x = ap.getX(v), y = ap.getY(v), z = ap.getZ(v);
    const n = vnoise(x * 0.12 + 3, y * 0.12 + z * 0.1) - 0.5;
    ap.setXYZ(v, x * (1 + n * 0.12), y * (1 + n * 0.1), z * (1.4 + n * 0.6));
    strata(y, 900, _col); acol.set([_col.r, _col.g, _col.b], v * 3);
  }
  ag.setAttribute('color', new THREE.BufferAttribute(acol, 3));
  ag.computeVertexNormals();
  const arch = new THREE.Mesh(ag, rockMat);
  arch.position.set(TR.px[ai], TR.py[ai] - 4, TR.pz[ai]);
  arch.rotation.y = TR.yaw[ai];
  arch.castShadow = arch.receiveShadow = true;
  scene.add(arch);
  for (const side of [-1, 1]) COLLIDERS.push({ x: TR.px[ai] - TR.tz[ai] * side * R, z: TR.pz[ai] + TR.tx[ai] * side * R, r: 9 });
}

// ============================================================
//  Pod model: two engines joined by an energy beam, cables, cockpit
// ============================================================
// local frame: +z forward, +x left (three.js: rotation.y = yaw maps +z to heading)
const metalDark = new THREE.MeshStandardMaterial({ color: '#2e2a27', metalness: 0.7, roughness: 0.45 });
const metalLight = new THREE.MeshStandardMaterial({ color: '#9c968e', metalness: 0.8, roughness: 0.35 });
const cableMat = new THREE.MeshStandardMaterial({ color: '#1d1a18', roughness: 0.6 });
function buildEngine(paint) {
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
  const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.55, 0.8, 18, 1, true), metalDark);
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
  return e;
}
function buildBolt() {
  const SEG = 14;
  const pos = new Float32Array((SEG + 1) * 4 * 3), uv = new Float32Array((SEG + 1) * 4 * 2), index = [];
  for (let i = 0; i <= SEG; i++) {
    for (let k = 0; k < 4; k++) { uv[(i * 4 + k) * 2] = i / SEG; uv[(i * 4 + k) * 2 + 1] = k % 2; }
    if (i < SEG) {
      const a = i * 4, b = a + 4;
      index.push(a, b, a + 1, a + 1, b, b + 1, a + 2, b + 2, a + 3, a + 3, b + 2, b + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(index);
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
    map: TEX.bolt, color: '#ff4fe0', transparent: true, blending: THREE.NormalBlending,
    depthWrite: false, side: THREE.DoubleSide, fog: false,
  }));
  m.frustumCulled = false;
  m.userData.SEG = SEG;
  return m;
}
function updateBolt(m, x0, x1, y, z, t, amp) {
  const p = m.geometry.attributes.position.array, SEG = m.userData.SEG;
  for (let i = 0; i <= SEG; i++) {
    const u = i / SEG, env = Math.sin(u * Math.PI);
    const jy = (Math.sin(t * 61 + i * 1.7) + Math.sin(t * 37 - i * 2.9)) * 0.14 * env * amp;
    const jz = Math.sin(t * 47 + i * 2.3) * 0.18 * env * amp;
    const x = lerp(x0, x1, u), w = 0.32 + 0.12 * Math.sin(t * 90 + i);
    const o = i * 12;
    p[o] = x; p[o + 1] = y + jy - w; p[o + 2] = z + jz;
    p[o + 3] = x; p[o + 4] = y + jy + w; p[o + 5] = z + jz;
    p[o + 6] = x; p[o + 7] = y + jy; p[o + 8] = z + jz - w;
    p[o + 9] = x; p[o + 10] = y + jy; p[o + 11] = z + jz + w;
  }
  m.geometry.attributes.position.needsUpdate = true;
}
function buildPod(color, accent) {
  const paint = new THREE.MeshStandardMaterial({ color, metalness: 0.35, roughness: 0.42 });
  const trim = new THREE.MeshStandardMaterial({ color: accent, metalness: 0.3, roughness: 0.5 });
  const root = new THREE.Group();
  const body = new THREE.Group();   // banks and bobs
  root.add(body);
  const engines = [];
  for (const s of [1, -1]) {
    const e = buildEngine(paint);
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
  const bolt = buildBolt();
  body.add(bolt);
  body.traverse((o) => { if (o.isMesh && o !== bolt) o.castShadow = true; });
  root.userData = { body, engines, bolt, beamX0: 1.0, beamX1: -1.0, beamZ: 6.7 };
  return root;
}
function addFlame(engine, pos) {
  const flame = new THREE.Sprite(new THREE.SpriteMaterial({ map: TEX.glow, color: '#ffb066', blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false }));
  flame.position.copy(pos);
  engine.add(flame); engine.userData.flame = flame;
}

// ============================================================
//  Particles: dust and sparks (one shared pool each)
// ============================================================
function makePool(n, size, color, opacity, blending) {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(n * 3).fill(-9999);
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const m = new THREE.Points(g, new THREE.PointsMaterial({
    size, map: TEX.glow, color, transparent: true, opacity, depthWrite: false, blending, sizeAttenuation: true,
  }));
  m.frustumCulled = false;
  scene.add(m);
  return { mesh: m, pos, vel: new Float32Array(n * 3), life: new Float32Array(n), n, head: 0 };
}
const DUST = makePool(900, 5.5, '#d8b98c', 0.42, THREE.NormalBlending);
const SPARK = makePool(240, 0.9, '#ffd28a', 1, THREE.AdditiveBlending);
function emit(pool, x, y, z, vx, vy, vz, life) {
  const i = pool.head; pool.head = (pool.head + 1) % pool.n;
  pool.pos[i * 3] = x; pool.pos[i * 3 + 1] = y; pool.pos[i * 3 + 2] = z;
  pool.vel[i * 3] = vx; pool.vel[i * 3 + 1] = vy; pool.vel[i * 3 + 2] = vz;
  pool.life[i] = life;
}
function stepPool(pool, dt, drag, grav) {
  const p = pool.pos, v = pool.vel, k = Math.exp(-drag * dt);
  for (let i = 0; i < pool.n; i++) {
    if (pool.life[i] <= 0) continue;
    pool.life[i] -= dt;
    if (pool.life[i] <= 0) { p[i * 3 + 1] = -9999; continue; }
    v[i * 3] *= k; v[i * 3 + 1] = v[i * 3 + 1] * k - grav * dt; v[i * 3 + 2] *= k;
    p[i * 3] += v[i * 3] * dt; p[i * 3 + 1] += v[i * 3 + 1] * dt; p[i * 3 + 2] += v[i * 3 + 2] * dt;
  }
  pool.mesh.geometry.attributes.position.needsUpdate = true;
}

// speed streaks around the camera
const STREAKS = (() => {
  const n = 160, g = new THREE.BufferGeometry();
  const pos = new Float32Array(n * 6);
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const m = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: '#fff3dc', transparent: true, opacity: 0, depthWrite: false, fog: false }));
  m.frustumCulled = false;
  scene.add(m);
  const seeds = Array.from({ length: n }, () => [Math.random(), Math.random(), Math.random()]);
  return { m, pos, seeds, n };
})();

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
//  Detailed player pod: models/pod/*.py -> assets/pod_player.glb
// ============================================================
// Loads in the background; until then, or if it fails, the player drives the simple pod.
// It goes on whichever racer this player controls and keeps buildPod()'s userData contract,
// so racerFx() drives it the same way and also animates its moving parts.
let detailPod = null;
function wrapDetailedPod(pod) {
  pod.engines.forEach((e, k) => addFlame(e, pod.flames[k]));
  const bolt = buildBolt();
  pod.body.add(bolt);
  pod.root.userData = {
    body: pod.body, engines: pod.engines, bolt, pod,
    beamX0: pod.beam[0].x, beamX1: pod.beam[1].x, beamZ: (pod.beam[0].z + pod.beam[1].z) / 2,
  };
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
function attachDetailPod() {
  if (!detailPod || !player) return;
  for (const r of racers) if (r.mesh === detailPod && r !== player) swapMesh(r, r.baseMesh);
  setPodLivery(detailPod.userData.pod, player.color, player.accent);
  swapMesh(player, detailPod);
}
loadPlayerPod(renderer)
  .then((pod) => { detailPod = wrapDetailedPod(pod); attachDetailPod(); })
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
    const vn = r.vx * nx + r.vz * nz;
    if (vn > 0) {
      r.vx -= nx * vn * 1.35; r.vz -= nz * vn * 1.35;
      const loss = 1 - Math.min(0.4, vn / 90);
      r.vx *= loss; r.vz *= loss;
      if (vn > 4) hitFx(r, r.x + nx * 2.5, r.z + nz * 2.5, vn);
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
        if (-vn > 4) hitFx(r, r.x - nx * POD_R, r.z - nz * POD_R, -vn * 1.6);
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
//  Sound (WebAudio, synthesized)
// ============================================================
const SND = { ctx: null, muted: false };
function initAudio() {
  if (SND.ctx) { if (SND.ctx.state === 'suspended') SND.ctx.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  const ctx = new AC();
  SND.ctx = ctx;
  const master = ctx.createGain(); master.gain.value = SND.muted ? 0 : 0.5; master.connect(ctx.destination);
  const nb = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), nd = nb.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  const osc = (type, f) => { const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.start(); return o; };
  const gain = (v) => { const g = ctx.createGain(); g.gain.value = v; return g; };
  const filt = (type, f, q) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };
  // player engine: two detuned saws + sub square, rasped by a fast tremolo
  const eF = filt('lowpass', 600, 2.5), am = gain(0.75), eG = gain(0);
  const o1 = osc('sawtooth', 60), o2 = osc('sawtooth', 60), o3 = osc('square', 30), sub = gain(0.35);
  o2.detune.value = 14;
  o1.connect(eF); o2.connect(eF); o3.connect(sub).connect(eF);
  const lfo = osc('sine', 32), lfoG = gain(0.28); lfo.connect(lfoG).connect(am.gain);
  eF.connect(am).connect(eG).connect(master);
  // boost whine
  const wO = osc('triangle', 900), wG = gain(0); wO.connect(wG).connect(master);
  // wind
  const wind = ctx.createBufferSource(); wind.buffer = nb; wind.loop = true; wind.start();
  const windF = filt('bandpass', 700, 0.7), windG = gain(0); wind.connect(windF).connect(windG).connect(master);
  // nearest rival
  const rO = osc('sawtooth', 70), rF = filt('lowpass', 900, 1.5), rG = gain(0); rO.connect(rF).connect(rG).connect(master);
  Object.assign(SND, { master, noise: nb, o1, o2, o3, eF, eG, lfo, wO, wG, windF, windG, rO, rF, rG });
}
function setMuted(m) {
  SND.muted = m;
  if (SND.ctx) SND.master.gain.setTargetAtTime(m ? 0 : 0.5, SND.ctx.currentTime, 0.05);
}
function sfx(kind, k = 1) {
  const ctx = SND.ctx; if (!ctx || SND.muted) return;
  const t = ctx.currentTime, g = ctx.createGain();
  g.connect(SND.master);
  if (kind === 'beep' || kind === 'go') {
    const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = kind === 'go' ? 880 : 440;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.12, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (kind === 'go' ? 0.6 : 0.22));
    o.connect(g); o.start(t); o.stop(t + 0.7);
  } else {
    const s = ctx.createBufferSource(); s.buffer = SND.noise;
    const f = ctx.createBiquadFilter(); f.type = kind === 'hit' ? 'bandpass' : 'lowpass';
    f.frequency.value = kind === 'hit' ? 1800 : 400; f.Q.value = 0.8;
    g.gain.setValueAtTime(0.5 * k, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    s.connect(f).connect(g); s.start(t, Math.random()); s.stop(t + 0.4);
  }
}
function updateAudio(live) {
  if (!SND.ctx) return;
  const t = SND.ctx.currentTime, p = player, sp = Math.abs(p.fwd);
  const base = 46 + sp * 0.72 + p.throttle * 12;
  SND.o1.frequency.setTargetAtTime(base, t, 0.06);
  SND.o2.frequency.setTargetAtTime(base * 1.5, t, 0.06);
  SND.o3.frequency.setTargetAtTime(base * 0.5, t, 0.06);
  SND.lfo.frequency.setTargetAtTime(22 + sp * 0.18, t, 0.1);
  SND.eF.frequency.setTargetAtTime(260 + sp * 13 + p.throttle * 500, t, 0.08);
  SND.eG.gain.setTargetAtTime(live ? 0.11 + p.throttle * 0.07 : 0, t, 0.12);
  SND.wG.gain.setTargetAtTime(live && p.boosting ? 0.035 : 0, t, 0.08);
  SND.wO.frequency.setTargetAtTime(700 + sp * 5, t, 0.1);
  SND.windG.gain.setTargetAtTime(live ? Math.min(0.32, sp / 520) : 0, t, 0.1);
  SND.windF.frequency.setTargetAtTime(400 + sp * 9, t, 0.1);
  let best = null, bd = 1e9;
  for (const r of racers) {
    if (r === p || r.gone) continue;
    const d = Math.hypot(r.x - p.x, r.z - p.z);
    if (d < bd) { bd = d; best = r; }
  }
  if (best) {
    const dx = (best.x - p.x) / (bd || 1), dz = (best.z - p.z) / (bd || 1);
    const closing = (p.vx - best.vx) * dx + (p.vz - best.vz) * dz;
    const dop = clamp(1 + closing / 340, 0.6, 1.6);
    SND.rO.frequency.setTargetAtTime((46 + Math.abs(best.fwd) * 0.72) * 1.5 * dop, t, 0.05);
    SND.rG.gain.setTargetAtTime(live ? 0.09 * clamp(1 - bd / 80, 0, 1) : 0, t, 0.05);
  }
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
const SMOKE = makePool(300, 4.5, '#3d342c', 0.5, THREE.NormalBlending);
let shake = 0;
function hitFx(r, x, z, power) {
  const n = Math.min(28, Math.round(power));
  for (let k = 0; k < n; k++) {
    emit(SPARK, x, r.y, z, (Math.random() - 0.5) * 24 + r.vx * 0.6, Math.random() * 9, (Math.random() - 0.5) * 24 + r.vz * 0.6, 0.25 + Math.random() * 0.45);
  }
  const d = Math.hypot(x - player.x, z - player.z);
  if (d < 70) {
    const k = clamp(power / 45, 0.1, 1) * (1 - d / 70);
    shake = Math.max(shake, k);
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

function racerFx(r, dt, t) {
  const m = r.mesh, ud = m.userData;
  m.position.set(r.x, r.y, r.z);
  m.rotation.y = r.yaw;
  const sp = Math.abs(r.fwd);
  r.roll = damp(r.roll, r.steer * 0.42 * clamp(sp / 50, 0, 1) + r.lat * 0.012, 6, dt);
  ud.body.rotation.set(r.pitch, 0, -r.roll);
  let by = 0;
  ud.engines.forEach((e, k) => {
    const y = 0.15 + Math.sin(t * 6.3 + k * 2.1 + r.phase) * 0.07;
    e.position.y = y; by += y / 2;
    e.rotation.z = Math.sin(t * 4.1 + k + r.phase) * 0.05;
    const f = e.userData.flame;
    const s = (r.overheat > 0 ? 1.0 : 1.3 + r.throttle * 1.5 + (r.boosting ? 2.4 : 0)) * (0.9 + Math.random() * 0.2);
    f.scale.set(s, s, s);
    f.material.color.set(r.overheat > 0 ? '#ff5a2a' : r.boosting ? '#d9e8ff' : '#ffb066');
  });
  const camD = camera.position.distanceTo(m.position);
  if (camD < 260) updateBolt(ud.bolt, ud.beamX0, ud.beamX1, by, ud.beamZ, t + r.phase, r.boosting ? 2.2 : 1);
  if (ud.pod) animatePlayerPod(ud.pod, r, dt);
  ud.bolt.material.opacity = r.overheat > 0 ? 0.35 : 1;
  ud.bolt.visible = camD < 600;
  // dust behind the pod
  if (camD < 380 && sp > 8) {
    const rate = sp * (0.12 + r.off * 0.5) * dt;
    const n = Math.floor(rate + Math.random());
    const fx = Math.sin(r.yaw), fz = Math.cos(r.yaw);
    for (let k = 0; k < n; k++) {
      const side = (Math.random() - 0.5) * 5;
      emit(DUST, r.x - fx * 4 - fz * side, r.y - 1.0, r.z - fz * 4 + fx * side,
        r.vx * 0.35 + (Math.random() - 0.5) * 6, 2 + Math.random() * 5, r.vz * 0.35 + (Math.random() - 0.5) * 6, 0.7 + Math.random() * 0.9);
    }
  }
  if (r.overheat > 0 && camD < 300 && Math.random() < dt * 30) {
    const e = ud.engines[Math.random() < 0.5 ? 0 : 1];
    e.getWorldPosition(_v3);
    emit(SMOKE, _v3.x, _v3.y + 0.5, _v3.z, r.vx * 0.6, 3 + Math.random() * 3, r.vz * 0.6, 1 + Math.random());
  }
}
const _v3 = new THREE.Vector3();

function updateStreaks(dt) {
  const k = clamp((Math.abs(player.fwd) - 70) / 110, 0, 1) * (state === 'race' || state === 'finished' ? 1 : 0);
  STREAKS.m.material.opacity = k * 0.35;
  if (k <= 0) return;
  const fx = Math.sin(player.yaw), fz = Math.cos(player.yaw), p = STREAKS.pos, len = 3 + k * 9;
  const sp = Math.abs(player.fwd);
  for (let i = 0; i < STREAKS.n; i++) {
    const s = STREAKS.seeds[i];
    s[2] -= dt * sp / 60;
    if (s[2] < 0) { s[2] += 1; s[0] = Math.random(); s[1] = Math.random(); }
    const along = s[2] * 60 - 10, a = s[0] * TAU, rad = 6 + s[1] * 10;
    const x = camera.position.x + fx * along + Math.cos(a) * rad * -fz;
    const z = camera.position.z + fz * along + Math.cos(a) * rad * fx;
    const y = camera.position.y + Math.sin(a) * rad * 0.6;
    p.set([x, y, z, x - fx * len, y, z - fz * len], i * 6);
  }
  STREAKS.m.geometry.attributes.position.needsUpdate = true;
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
// multiplayer session (null room = solo)
const MP = { room: null, peers: new Map(), myReady: false, inRace: false, menuOpen: false, raceHost: null,
  sendT: 0, joinT: 0, note: '', noteT: 0, rLaps: 3, rDiff: 1 };
const NO_INPUT = { throttle: 0, brake: 0, steer: 0, boost: false, analog: true };

const $ = (id) => document.getElementById(id);
const hudEl = $('hud'), touchEl = $('touch'), menuEl = $('menu'), pauseEl = $('pause'), resultEl = $('result'), centerEl = $('center'), roomEl = $('room');
function showScreen(el) { for (const s of [menuEl, roomEl, pauseEl, resultEl]) s.hidden = s !== el; }
function setLights(n, green) {
  START_LIGHTS.forEach((l, k) => l.material.color.set(green ? '#55ff86' : k < n ? '#ff3b2a' : '#2b2118'));
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
  camYaw = player.yaw; camY = player.y + 4;
  setLights(0, false);
  showScreen(null);
  hudEl.hidden = false; touchEl.hidden = !touchMode;
  centerEl.textContent = ''; toastEl.hidden = true;
  $('bestLapVal').classList.remove('fresh');
  $('restartBtn').hidden = !!MP.room;
  $('menuBtn').textContent = MP.room ? 'VISSZA A SZOBÁBA' : 'FŐMENÜ';
  state = 'countdown';
}
function showMenu() {
  state = 'menu';
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
  if (state === 'paused') { state = pausedFrom; showScreen(null); hudEl.hidden = false; return; }
  if (state === 'countdown' || state === 'race' || state === 'finished') {
    pausedFrom = state; state = 'paused'; showScreen(pauseEl); $('resumeBtn').focus({ preventScroll: true });
  }
}
function onPlayerLap(lt) {
  if (lt < bestLapRace) { bestLapRace = lt; $('bestLapVal').classList.add('fresh'); }
  if (player.lap < laps) toast(player.lap === laps - 1 ? `UTOLSÓ KÖR · ${fmtTime(lt)}` : `${player.lap + 1}. KÖR · ${fmtTime(lt)}`);
}
function onPlayerFinish() {
  state = 'finished';
  const pos = standings().indexOf(player) + 1;
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
    if (inp.throttle > 0.5 && p.throttle < 0.5) throttleAt = countT;
    if (inp.throttle < 0.5) throttleAt = -1;
    p.throttle = inp.throttle;
    for (const r of racers) if (r.ctl === 'bot') r.throttle = countT < 1 ? 0.6 : 0;
    countT -= dt;
    const c = Math.ceil(countT);
    if (c !== lastCount && c > 0 && c <= 3) {
      lastCount = c; centerEl.textContent = c; centerEl.className = ''; centerTimer = 1.2;
      setLights(c === 3 ? 2 : c === 2 ? 4 : 5, false); sfx('beep');
    }
    if (countT <= 0) {
      state = 'race'; raceT = 0;
      setLights(5, true); centerEl.textContent = 'RAJT!'; centerEl.className = 'go'; centerTimer = 0.9; sfx('go');
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
const camLoc = { i: 0 }, _tp2 = { x: 0, y: 0, z: 0, yaw: 0, i: 0 };
function updateCamera(dt) {
  if (state === 'menu' || state === 'loading' || state === 'room') {
    trackPoint(TR.L - 92 + Math.sin(simT * 0.11) * 20, Math.sin(simT * 0.07) * 12, _tp);
    trackPoint(TR.L - 20, 0, _tp2);
    camera.position.set(_tp.x, _tp.y + 6.5 + Math.sin(simT * 0.09) * 1.5, _tp.z);
    camera.lookAt(_tp2.x, _tp2.y + 5, _tp2.z);
    fov = 52;
  } else {
    const p = player, c = CAMS[camMode];
    camYaw += wrapAngle(p.yaw - camYaw) * (1 - Math.exp(-8 * dt));
    const fx = Math.sin(camYaw), fz = Math.cos(camYaw);
    let x = p.x - fx * c.d, z = p.z - fz * c.d;
    camLoc.i = p.loc.i;
    locate(x, z, camLoc);
    if (camLoc.arena > 0.3 || camLoc.canyon > 0.3) {
      const lim = camLoc.hw - 0.5, ad = Math.abs(camLoc.d);
      if (ad > lim) { const sg = Math.sign(camLoc.d), k = ad - lim; x += camLoc.tz * sg * k; z -= camLoc.tx * sg * k; }
    }
    camY = damp(camY, Math.max(p.y + c.h, groundQuery(x, z) + 1.5), 10, dt);
    const sh = shake * shake * 0.9;
    shake = Math.max(0, shake - dt * 2.4);
    camera.position.set(x + (Math.random() - 0.5) * sh, camY + (Math.random() - 0.5) * sh, z + (Math.random() - 0.5) * sh);
    camera.lookAt(p.x + fx * 12, p.y + c.look, p.z + fz * 12);
    fov = damp(fov, 64 + 24 * clamp(Math.abs(p.fwd) / 190, 0, 1) + (p.boosting ? 6 : 0), 3, dt);
  }
  camera.fov = fov;
  camera.updateProjectionMatrix();
  scene.userData.sky.position.copy(camera.position);
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
$('startBtn').addEventListener('click', () => { initAudio(); newRace(); });
$('resumeBtn').addEventListener('click', togglePause);
$('restartBtn').addEventListener('click', () => { initAudio(); newRace(); });
$('menuBtn').addEventListener('click', () => (MP.room ? backToRoom() : showMenu()));
$('againBtn').addEventListener('click', () => { initAudio(); if (MP.room) backToRoom(); else newRace(); });
$('resMenuBtn').addEventListener('click', () => (MP.room ? leaveRoom() : showMenu()));
onPress.Escape = onPress.KeyP = togglePause;
onPress.KeyC = () => { camMode = (camMode + 1) % CAMS.length; };
onPress.KeyR = () => { if (state === 'race') { respawn(player); toast('VISSZA A PÁLYÁRA'); } };
onPress.KeyM = () => { setMuted(!SND.muted); toast(SND.muted ? 'HANG KI' : 'HANG BE'); };
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
  attachDetailPod();
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
  attachDetailPod();
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
      (r.boosting ? 1 : 0) | (r.overheat > 0 ? 2 : 0) | (r.finished ? 4 : 0), r.lap, rd(r.loc.s), rd(r.finishTime), Math.round(r.heat), rd(r.pitch, 1000)]);
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
      f: e[11] | 0, lap: e[12] | 0, s: +e[13], ft: +e[14], heat: +e[15], pitch: +e[16], fresh: !r.net || r.net.fresh };
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
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, Math.max(0, (now - lastT) / 1000));
  lastT = now;
  if (state !== 'paused') {
    simT += dt;
    const n = Math.max(1, Math.ceil(dt / (1 / 120)));
    for (let k = 0; k < n; k++) stepSim(dt / n);
    stepPool(DUST, dt, 1.3, -0.6);
    stepPool(SPARK, dt, 1.5, 24);
    stepPool(SMOKE, dt, 0.7, -3);
    for (const r of racers) if (!r.gone) racerFx(r, dt, simT);
    netSend(dt);
    roomTimers(dt);
    updateStreaks(dt);
    if (toastTimer > 0 && (toastTimer -= dt) <= 0) toastEl.hidden = true;
    if (centerTimer > 0 && (centerTimer -= dt) <= 0) centerEl.textContent = '';
  }
  updateCamera(dt);
  const focus = state === 'menu' || state === 'loading' || state === 'room' ? _tp2 : player;
  sun.target.position.set(focus.x, focus.y || 0, focus.z);
  sun.position.copy(sun.target.position).addScaledVector(SUN_DIR, 600);
  if (state === 'countdown' || state === 'race' || state === 'finished' || state === 'paused') updateHUD();
  updateAudio(state === 'countdown' || state === 'race' || state === 'finished' || state === 'results');
  renderer.render(scene, camera);
}


// local testing hook (only on localhost): fast-forward the race without rendering every frame
if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
  window.__homok = {
    start(l = 1, d = 1) { laps = l; diff = d; newRace(); return this.info(); },
    sim(sec, auto = true) {
      debugAuto = auto;
      const dt = 1 / 120;
      for (let k = 0; k < sec * 120; k++) { simT += dt; stepSim(dt); netSend(dt); if (k % 4 === 0) for (const r of racers) if (!r.gone) racerFx(r, dt * 4, simT); }
      stepPool(DUST, 0.016, 1.3, -0.6);
      updateCamera(0.5); if (state !== 'results') updateHUD(); renderer.render(scene, camera);
      return this.info();
    },
    cam(m) { camMode = m; updateCamera(1); renderer.render(scene, camera); },
    info() {
      return { state, raceT: +raceT.toFixed(1), mp: MP.room ? { code: MP.room.code, host: MP.room.isHost, peers: MP.room.peers.size, inRace: MP.inRace } : null, racers: racers.map((r) => ({ n: r.name, ctl: r.ctl, gone: r.gone, lap: r.lap, prog: Math.round(r.prog), d: +r.loc.d.toFixed(1), v: Math.round(r.fwd * 3.6), fin: r.finished, ft: +r.finishTime.toFixed(1), laps: r.lapTimes.map((t) => +t.toFixed(1)), heat: Math.round(r.heat) })) };
    },
  };
}

function boot(data) {
  if (data && data.laps) { laps = data.laps; syncSeg('lapsSeg', laps); }
  if (data && data.diff != null) { diff = data.diff; syncSeg('diffSeg', diff); }
  if (data && data.muted) SND.muted = true;
  showMenu();
  readInvite();
  window.addEventListener('hashchange', readInvite);
  requestAnimationFrame((t) => { lastT = t; frame(t); $('loading').hidden = true; });
}
const hot = window.claude && window.claude.hot;
if (hot && typeof hot.snapshot === 'function') { try { hot.snapshot(() => ({ laps, diff, muted: SND.muted })); } catch { /* ignore */ } }
if (hot && typeof hot.ready === 'function') hot.ready(boot); else boot((hot && hot.data) || {});
