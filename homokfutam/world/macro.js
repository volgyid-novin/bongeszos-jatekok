import * as THREE from 'three';
import { GU, WIND_DIR } from '../gfx/ground.js';

// ============================================================
//  Macro map, baked once at load over the whole terrain square.
//  Two top-down height renders (terrain only, and everything flagged as rock) are read back
//  and turned into the large-scale ground data the surface shaders use:
//   gMac  (RGBA8): R occlusion (horizon based), G dune crest (0.5 = flat, >0.5 convex),
//                  B basin (lowland), A apron (gravel around rocks)
//   gMac2 (RGBA8): R sand tail (downwind of rocks), G scour (upwind of rocks), B bedrock (at the rock)
//   gMacH (half float): R terrain height, G top height including rocks
//  The CPU copies stay in MACRO for scenery placement (scatter, spindrift).
// ============================================================
export const MACRO = { ready: false, res: 0, x0: 0, z0: 0, size: 1, H: null, top: null, crest: null, basin: null, apron: null, tail: null, bedrock: null };

const HEIGHT_MAT = new THREE.ShaderMaterial({
  side: THREE.DoubleSide,
  vertexShader: /* glsl */`
    varying float vY;
    void main() {
      vec4 p = vec4( position, 1.0 );
      #ifdef USE_INSTANCING
        p = instanceMatrix * p;
      #endif
      vec4 wp = modelMatrix * p;
      vY = wp.y;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`,
  fragmentShader: /* glsl */`
    varying float vY;
    void main() { gl_FragColor = vec4( vY, 0.0, 0.0, 1.0 ); }`,
});

function renderHeights(renderer, scene, cam, res, pick) {
  const rt = new THREE.WebGLRenderTarget(res, res, { type: THREE.FloatType, depthBuffer: true, samples: 0 });
  rt.texture.generateMipmaps = false;
  rt.texture.minFilter = rt.texture.magFilter = THREE.NearestFilter;
  const hidden = [];
  scene.traverse((o) => {
    if (!o.visible || o === scene) return;
    if ((o.isMesh || o.isInstancedMesh) && !pick(o)) { o.visible = false; hidden.push(o); }
    else if (o.isPoints || o.isLine || o.isSprite) { o.visible = false; hidden.push(o); }
  });
  const prev = { o: scene.overrideMaterial, bg: scene.background, rt: renderer.getRenderTarget(), auto: renderer.shadowMap.autoUpdate, cc: renderer.getClearColor(new THREE.Color()), ca: renderer.getClearAlpha() };
  scene.overrideMaterial = HEIGHT_MAT;
  scene.background = null;
  renderer.shadowMap.autoUpdate = false;
  renderer.setRenderTarget(rt);
  renderer.setClearColor(0x000000, 0);        // alpha 0 = nothing drawn there
  renderer.clear();
  renderer.render(scene, cam);
  const out = new Float32Array(res * res * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, res, res, out);
  renderer.setRenderTarget(prev.rt);
  renderer.setClearColor(prev.cc, prev.ca);
  renderer.shadowMap.autoUpdate = prev.auto;
  scene.overrideMaterial = prev.o;
  scene.background = prev.bg;
  for (const o of hidden) o.visible = true;
  rt.dispose();
  // rows come bottom-up from the screen, whose top is -z: flip so row 0 = z min. Alpha = covered.
  const H = new Float32Array(res * res), A = new Uint8Array(res * res);
  for (let r = 0; r < res; r++) {
    const src = (res - 1 - r) * res;
    for (let c = 0; c < res; c++) { H[r * res + c] = out[(src + c) * 4]; A[r * res + c] = out[(src + c) * 4 + 3] > 0.5 ? 1 : 0; }
  }
  return { H, A };
}

// separable box blur (running sums), clamped edges; `passes` box passes ~ gaussian
function blur(src, n, r, passes = 2) {
  let a = Float32Array.from(src), b = new Float32Array(n * n);
  if (r < 1) return a;
  const w = 2 * r + 1;
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < n; y++) {
      const row = y * n;
      let s = 0;
      for (let k = -r; k <= r; k++) s += a[row + Math.min(n - 1, Math.max(0, k))];
      for (let x = 0; x < n; x++) {
        b[row + x] = s / w;
        s += a[row + Math.min(n - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < n; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += b[Math.min(n - 1, Math.max(0, k)) * n + x];
      for (let y = 0; y < n; y++) {
        a[y * n + x] = s / w;
        s += b[Math.min(n - 1, y + r + 1) * n + x] - b[Math.max(0, y - r) * n + x];
      }
    }
  }
  return a;
}

const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export function bakeMacro(renderer, scene, { x0, z0, size, res = 1024 }) {
  const t0 = performance.now();
  const cx = x0 + size / 2, cz = z0 + size / 2;
  const cam = new THREE.OrthographicCamera(-size / 2, size / 2, size / 2, -size / 2, 1, 5000);
  cam.position.set(cx, 2500, cz);
  cam.up.set(0, 0, -1);                       // screen right = +x, screen top = -z
  cam.lookAt(cx, 0, cz);
  cam.updateMatrixWorld();
  const ter = renderHeights(renderer, scene, cam, res, (o) => o.userData.terrain);
  const all = renderHeights(renderer, scene, cam, res, (o) => o.userData.terrain || o.userData.rock);
  const n = res, N = n * n, px = size / n;
  const H = ter.H;
  for (let i = 0; i < N; i++) if (!ter.A[i]) H[i] = 0;
  const top = new Float32Array(N), rock = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    top[i] = all.A[i] ? Math.max(all.H[i], H[i]) : H[i];
    rock[i] = top[i] > H[i] + 0.8 ? 1 : 0;
  }
  const at = (a, x, y) => a[Math.min(n - 1, Math.max(0, y)) * n + Math.min(n - 1, Math.max(0, x))];

  // horizon occlusion over 8 directions, 6 distances (7 m .. 230 m)
  const ao = new Float32Array(N);
  const dirs = [];
  for (let k = 0; k < 8; k++) dirs.push([Math.cos(k * Math.PI / 4), Math.sin(k * Math.PI / 4)]);
  const steps = [1, 2, 4, 8, 16, 32];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const h0 = top[y * n + x];
    let occ = 0;
    for (const [dx, dy] of dirs) {
      let m = 0;
      for (const s of steps) {
        const dh = at(top, Math.round(x + dx * s), Math.round(y + dy * s)) - h0;
        const sl = dh / (s * px);
        if (sl > m) m = sl;
      }
      occ += m / Math.sqrt(1 + m * m);
    }
    ao[y * n + x] = 1 - Math.min(0.85, (occ / 8) * 1.15);
  }
  // crests: height above the local mean (~20 m), basins: below the wide mean (~150 m)
  const m1 = blur(H, n, 2), m2 = blur(H, n, 18);
  const crest = new Float32Array(N), basin = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    crest[i] = Math.min(1, Math.max(0, 0.5 + (H[i] - m1[i]) / 5));
    basin[i] = sstep(1.5, 11, m2[i] - H[i]);
  }
  // rock surroundings
  const r1 = blur(rock, n, 1), r3 = blur(rock, n, 4), r8 = blur(rock, n, 10);
  const apron = new Float32Array(N), bedrock = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const free = 1 - rock[i];
    apron[i] = free * Math.min(1, sstep(0.01, 0.25, r3[i]) * 0.8 + sstep(0.01, 0.2, r8[i]) * 0.5);
    bedrock[i] = free * sstep(0.05, 0.45, r1[i] + r3[i] * 0.6);
  }
  // sand tails downwind of rocks and scour upwind, scaled by how far the rock stands out
  const tail = new Float32Array(N), scour = new Float32Array(N);
  const wx = WIND_DIR.x, wz = WIND_DIR.y;
  const K = 14;
  const rh = new Float32Array(N);
  for (let i = 0; i < N; i++) rh[i] = rock[i] ? Math.min(1, (top[i] - H[i]) / 25) : 0;
  const rhb = blur(rh, n, 1);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (rock[y * n + x]) continue;
    let t = 0, sc = 0;
    for (let k = 1; k <= K; k++) {
      const v = at(rhb, Math.round(x - wx * k * 1.5), Math.round(y - wz * k * 1.5));
      t = Math.max(t, v * (1 - k / (K + 1)) * Math.min(1, v * 3 + 0.3));
    }
    for (let k = 1; k <= 3; k++) sc = Math.max(sc, at(rhb, Math.round(x + wx * k), Math.round(y + wz * k)) * (1 - k / 4));
    tail[y * n + x] = Math.min(1, t * 1.6);
    scour[y * n + x] = Math.min(1, sc * 2);
  }
  const tailB = blur(tail, n, 1);

  const b8 = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
  const d1 = new Uint8Array(N * 4), d2 = new Uint8Array(N * 4), dh = new Uint16Array(N * 4);
  for (let i = 0; i < N; i++) {
    d1[i * 4] = b8(ao[i]); d1[i * 4 + 1] = b8(crest[i]); d1[i * 4 + 2] = b8(basin[i]); d1[i * 4 + 3] = b8(apron[i]);
    d2[i * 4] = b8(tailB[i]); d2[i * 4 + 1] = b8(scour[i]); d2[i * 4 + 2] = b8(bedrock[i]); d2[i * 4 + 3] = 255;
    dh[i * 4] = THREE.DataUtils.toHalfFloat(H[i]); dh[i * 4 + 1] = THREE.DataUtils.toHalfFloat(top[i]);
    dh[i * 4 + 2] = 0; dh[i * 4 + 3] = THREE.DataUtils.toHalfFloat(1);
  }
  const mk = (data, type) => {
    const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat, type);
    t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.generateMipmaps = type === THREE.UnsignedByteType;
    if (!t.generateMipmaps) t.minFilter = THREE.LinearFilter;
    t.anisotropy = 4;
    t.needsUpdate = true;
    return t;
  };
  GU.gMac.value = mk(d1, THREE.UnsignedByteType);
  GU.gMac2.value = mk(d2, THREE.UnsignedByteType);
  GU.gMacH.value = mk(dh, THREE.HalfFloatType);
  GU.gMacXf.value.set(x0, z0, 1 / size, 1);
  Object.assign(MACRO, { ready: true, res: n, x0, z0, size, H, top, crest, basin, apron, tail: tailB, bedrock, ao });
  console.log(`HOMOKFUTAM: macro map ${n}² in ${(performance.now() - t0).toFixed(0)} ms`);
  return MACRO;
}

// bilinear lookup of a macro array at world (x, z)
export function macroAt(arr, x, z) {
  if (!MACRO.ready) return 0;
  const n = MACRO.res;
  const fx = (x - MACRO.x0) / MACRO.size * n - 0.5, fz = (z - MACRO.z0) / MACRO.size * n - 0.5;
  const ix = Math.max(0, Math.min(n - 2, Math.floor(fx))), iz = Math.max(0, Math.min(n - 2, Math.floor(fz)));
  const tx = Math.min(1, Math.max(0, fx - ix)), tz = Math.min(1, Math.max(0, fz - iz));
  const i = iz * n + ix;
  return (arr[i] * (1 - tx) + arr[i + 1] * tx) * (1 - tz) + (arr[i + n] * (1 - tx) + arr[i + n + 1] * tx) * tz;
}
