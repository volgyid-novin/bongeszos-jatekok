import * as THREE from 'three';
import { sdf, groundHeight, fbm, vnoise, BRUSHES, RELICS, PIT } from './map.js';
import { LANE } from './data.js';

// The comic look, in the spirit of XIII: flat toon bands, ink hatching in the shadows, painted textures,
// and thick black outlines drawn by a post pass from depth + normals. Glowing effects are drawn after the
// outlines (fx scene) and test against the scene depth themselves.

export const U = {
  time: { value: 0 },
  paint: { value: null },
  rock: { value: null },
  sunI: { value: 2.7 },
  tDepth: { value: null },
  res: { value: new THREE.Vector2(1, 1) },
  near: { value: 1 },
  far: { value: 400 },
};

// 3 light bands: shadow side, half lit, full sun
export const GRAD = (() => {
  const d = new Uint8Array([70, 70, 165, 255]);
  const t = new THREE.DataTexture(d, 4, 1, THREE.RedFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
})();

const COMIC_VERT_PARS = `
varying vec3 vWPos;
varying vec3 vWN;
`;
const COMIC_VERT = `
  {
    vec4 cwp = vec4(transformed, 1.0);
    vec3 cwn = objectNormal;
    #ifdef USE_INSTANCING
      cwp = instanceMatrix * cwp;
      cwn = mat3(instanceMatrix) * cwn;
    #endif
    cwp = modelMatrix * cwp;
    vWPos = cwp.xyz;
    vWN = normalize(mat3(modelMatrix) * cwn);
  }
`;
const COMIC_FRAG_PARS = `
varying vec3 vWPos;
varying vec3 vWN;
uniform sampler2D uPaint;
uniform sampler2D uRock;
uniform float uPaintAmt;
uniform float uHatch;
uniform float uSunI;
uniform float uRim;
uniform float uFlash;
uniform vec3 uFlashCol;
uniform float uTerrain;
vec3 triW(vec3 n) { vec3 w = pow(abs(n), vec3(4.0)); return w / (w.x + w.y + w.z + 1e-5); }
float triPaint(vec3 p, vec3 n, float s) {
  vec3 w = triW(n);
  return texture2D(uPaint, p.zy * s).r * w.x + texture2D(uPaint, p.xz * s).r * w.y + texture2D(uPaint, p.xy * s).r * w.z;
}
float hatchLines(vec2 p, float dens, float width) {
  float v = (p.x + p.y) * dens;
  float f = abs(fract(v) - 0.5);
  float aa = fwidth(v) * 1.2;
  return smoothstep(0.5 - width - aa, 0.5 - width + aa, f);
}
float hatch(vec3 p, vec3 n, float dens, float width, float flip) {
  vec3 w = triW(n);
  vec2 a = p.zy, b = p.xz, c = p.xy;
  if (flip > 0.5) { a.x = -a.x; b.x = -b.x; c.x = -c.x; }
  return hatchLines(a, dens, width) * w.x + hatchLines(b, dens, width) * w.y + hatchLines(c, dens, width) * w.z;
}
`;
const COMIC_COLOR = `
  #include <color_fragment>
  {
    float pv = triPaint(vWPos, vWN, 0.21) * 0.6 + triPaint(vWPos, vWN, 0.71) * 0.4;
    diffuseColor.rgb *= mix(1.0, 0.78 + pv * 0.42, uPaintAmt);
    if (uTerrain > 0.5) {
      // cliffs: layered rock where the ground gets steep
      float steep = 1.0 - smoothstep(0.55, 0.82, vWN.y);
      vec3 w = triW(vWN);
      vec3 rk = texture2D(uRock, vec2(vWPos.x * 0.09, vWPos.y * 0.16)).rgb * w.z + texture2D(uRock, vec2(vWPos.z * 0.09, vWPos.y * 0.16)).rgb * w.x + texture2D(uRock, vWPos.xz * 0.08).rgb * w.y;
      diffuseColor.rgb = mix(diffuseColor.rgb, rk, steep);
      // the chasm fades into a cool blue haze
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.34, 0.42, 0.55), smoothstep(-2.0, -14.0, vWPos.y) * 0.75);
    }
  }
`;
const COMIC_OUT = `
  {
    float lumD = dot(reflectedLight.directDiffuse, vec3(0.299, 0.587, 0.114));
    float lumC = max(dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114)) * RECIPROCAL_PI, 1e-4);
    float lit = lumD / lumC / uSunI;
    float shade = 1.0 - smoothstep(0.25, 0.5, lit);
    float deep = 1.0 - smoothstep(0.05, 0.22, lit);
    float h1 = hatch(vWPos, vWN, 4.2, 0.13, 0.0);
    float h2 = hatch(vWPos, vWN, 4.2, 0.13, 1.0);
    outgoingLight *= 1.0 - uHatch * (shade * h1 * 0.55 + deep * h2 * 0.45);
    // a hard rim light keeps characters readable against the ground
    float rim = 1.0 - max(dot(normal, normalize(vViewPosition)), 0.0);
    outgoingLight += uRim * smoothstep(0.62, 0.7, rim) * (0.35 + 0.65 * (1.0 - shade)) * diffuseColor.rgb;
    outgoingLight = mix(outgoingLight, uFlashCol, uFlash);
  }
  #include <opaque_fragment>
`;

// opts: { color, vc (vertex colors), paint, hatch, rim, flash (true: own uniform), terrain, map, side, emissive }
export function comicMat(opts = {}) {
  const m = new THREE.MeshToonMaterial({
    color: opts.color ?? 0xffffff, vertexColors: !!opts.vc, gradientMap: GRAD, map: opts.map || null,
    side: opts.side ?? THREE.FrontSide, emissive: opts.emissive ?? 0x000000, transparent: !!opts.transparent, opacity: opts.opacity ?? 1,
  });
  const u = {
    uPaint: U.paint, uRock: U.rock, uSunI: U.sunI,
    uPaintAmt: { value: opts.paint ?? 0.55 }, uHatch: { value: opts.hatch ?? 0.5 }, uRim: { value: opts.rim ?? 0 },
    uFlash: { value: 0 }, uFlashCol: { value: new THREE.Color(1, 1, 1) }, uTerrain: { value: opts.terrain ? 1 : 0 },
  };
  m.userData.u = u;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = COMIC_VERT_PARS + sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n' + COMIC_VERT);
    sh.fragmentShader = COMIC_FRAG_PARS + sh.fragmentShader
      .replace('#include <color_fragment>', COMIC_COLOR)
      .replace('#include <opaque_fragment>', COMIC_OUT);
  };
  m.customProgramCacheKey = () => 'comic' + (opts.terrain ? 't' : '');
  return m;
}

// ============================================================
//  Painted textures (canvas)
// ============================================================
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const canvasTex = (c, repeat) => {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
};

// grey brush strokes, tileable: the "paint" every surface is modulated by
export function makePaintTex() {
  const N = 512, c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d'), r = rng(7);
  g.fillStyle = '#808080'; g.fillRect(0, 0, N, N);
  for (let i = 0; i < 1600; i++) {
    const x = r() * N, y = r() * N, l = 10 + r() * 46, w = 3 + r() * 9, a = -0.7 + (r() - 0.5) * 0.9, v = Math.floor(70 + r() * 120);
    g.fillStyle = `rgba(${v},${v},${v},${0.18 + r() * 0.25})`;
    for (const ox of [-N, 0, N]) for (const oy of [-N, 0, N]) {
      g.save(); g.translate(x + ox, y + oy); g.rotate(a);
      g.beginPath(); g.ellipse(0, 0, l, w, 0, 0, Math.PI * 2); g.fill();
      g.restore();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

// layered rock for the cliffs: warm sandstone bands with cracks
export function makeRockTex() {
  const N = 512, c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d'), r = rng(11);
  const bands = ['#a88b6c', '#93775c', '#b89a76', '#7f6650', '#a2876a', '#8c7259', '#c0a17c'];
  let y = 0;
  while (y < N) {
    const h = 18 + r() * 40;
    g.fillStyle = bands[Math.floor(r() * bands.length)];
    g.fillRect(0, y, N, h + 1);
    y += h;
  }
  for (let i = 0; i < 900; i++) {
    const x = r() * N, yy = r() * N, l = 8 + r() * 40, v = r() < 0.5 ? 'rgba(60,45,35,.22)' : 'rgba(235,215,185,.18)';
    g.fillStyle = v;
    for (const ox of [-N, 0, N]) { g.beginPath(); g.ellipse(x + ox, yy, l, 2 + r() * 4, (r() - 0.5) * 0.25, 0, Math.PI * 2); g.fill(); }
  }
  g.strokeStyle = 'rgba(45,32,25,.55)'; g.lineWidth = 2;
  for (let i = 0; i < 70; i++) {
    let x = r() * N, yy = r() * N;
    g.beginPath(); g.moveTo(x, yy);
    for (let k = 0; k < 4; k++) { x += (r() - 0.5) * 30; yy += 10 + r() * 26; g.lineTo(x, yy); }
    g.stroke();
  }
  return canvasTex(c, true);
}

// The whole ground painted as one picture: grass, the dirt lane, the stone plazas of the bases, the pit floor.
// Mapped onto the terrain plane by its UVs (TERRAIN bounds).
export const TERRAIN = { minX: -92, maxX: 92, minZ: -52, maxZ: 46 };
export function makeGroundTex() {
  const W = 2048, H = Math.round(W * (TERRAIN.maxZ - TERRAIN.minZ) / (TERRAIN.maxX - TERRAIN.minX));
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d'), r = rng(23);
  const sx = (x) => (x - TERRAIN.minX) / (TERRAIN.maxX - TERRAIN.minX) * W;
  const sz = (z) => (z - TERRAIN.minZ) / (TERRAIN.maxZ - TERRAIN.minZ) * H;
  const ppm = W / (TERRAIN.maxX - TERRAIN.minX);
  // base layer from the distance field at low resolution
  const w2 = 736, h2 = Math.round(w2 * H / W), small = document.createElement('canvas');
  small.width = w2; small.height = h2;
  const sg = small.getContext('2d'), img = sg.createImageData(w2, h2), d = img.data;
  const mix = (a, b, t) => a + (b - a) * t;
  for (let j = 0; j < h2; j++) {
    for (let i = 0; i < w2; i++) {
      const x = TERRAIN.minX + (i + 0.5) / w2 * (TERRAIN.maxX - TERRAIN.minX);
      const z = TERRAIN.minZ + (j + 0.5) / h2 * (TERRAIN.maxZ - TERRAIN.minZ);
      const s = sdf(x, z), n = fbm(x * 0.25, z * 0.25, 3), n2 = vnoise(x * 1.3, z * 1.3);
      // grass
      let R = mix(96, 138, n), G = mix(140, 178, n), B = mix(58, 72, n);
      if (n2 > 0.72) { R += 22; G += 14; B -= 6; }
      // dirt lane, with a soft painted edge
      const lane = 1 - Math.min(1, Math.max(0, (s + 1.6) / 1.8));
      const dr = mix(196, 222, n), dg = mix(160, 186, n), db = mix(108, 128, n);
      R = mix(R, dr, lane); G = mix(G, dg, lane); B = mix(B, db, lane);
      // worn middle of the path
      const worn = Math.max(0, 1 - Math.abs(z) / 2.6) * (Math.abs(x) < 52 ? 1 : 0) * 0.35 * lane;
      R = mix(R, 232, worn); G = mix(G, 204, worn); B = mix(B, 150, worn);
      const k = (j * w2 + i) * 4;
      d[k] = R; d[k + 1] = G; d[k + 2] = B; d[k + 3] = 255;
    }
  }
  sg.putImageData(img, 0, 0);
  g.imageSmoothingEnabled = true;
  g.drawImage(small, 0, 0, W, H);

  // brush strokes over everything, coloured by what is underneath
  for (let i = 0; i < 26000; i++) {
    const x = TERRAIN.minX + r() * (TERRAIN.maxX - TERRAIN.minX), z = TERRAIN.minZ + r() * (TERRAIN.maxZ - TERRAIN.minZ);
    const s = sdf(x, z);
    const inLane = s < -1;
    const l = (inLane ? 0.35 : 0.25 + r() * 0.35) * ppm, w = (0.06 + r() * 0.1) * ppm;
    let col;
    if (inLane) col = r() < 0.5 ? `rgba(160,120,78,${0.12 + r() * 0.16})` : `rgba(240,214,160,${0.12 + r() * 0.16})`;
    else col = r() < 0.5 ? `rgba(62,104,40,${0.18 + r() * 0.2})` : `rgba(170,200,90,${0.14 + r() * 0.18})`;
    g.fillStyle = col;
    g.save(); g.translate(sx(x), sz(z)); g.rotate(inLane ? (r() - 0.5) * 0.6 : -0.9 + (r() - 0.5) * 0.8);
    g.beginPath(); g.ellipse(0, 0, l, w, 0, 0, Math.PI * 2); g.fill();
    g.restore();
  }
  // pebbles with an ink outline
  g.lineWidth = 1.4;
  for (let i = 0; i < 1500; i++) {
    const x = TERRAIN.minX + r() * (TERRAIN.maxX - TERRAIN.minX), z = TERRAIN.minZ + r() * (TERRAIN.maxZ - TERRAIN.minZ);
    if (sdf(x, z) > -0.4) continue;
    const rr = (0.08 + r() * 0.16) * ppm, v = Math.floor(150 + r() * 70);
    g.fillStyle = `rgb(${v},${v - 12},${v - 30})`; g.strokeStyle = 'rgba(40,28,20,.7)';
    g.beginPath(); g.ellipse(sx(x), sz(z), rr, rr * 0.7, r() * 3, 0, Math.PI * 2); g.fill(); g.stroke();
  }
  // grass tufts as ink strokes along the lane edge
  g.strokeStyle = 'rgba(40,62,24,.75)'; g.lineWidth = 1.6;
  for (let i = 0; i < 5000; i++) {
    const x = TERRAIN.minX + r() * (TERRAIN.maxX - TERRAIN.minX), z = TERRAIN.minZ + r() * (TERRAIN.maxZ - TERRAIN.minZ);
    const s = sdf(x, z);
    if (s < -0.6 || s > 4) continue;
    const px = sx(x), pz = sz(z);
    g.beginPath();
    for (let k = -1; k <= 1; k++) { g.moveTo(px + k * 2, pz); g.lineTo(px + k * 4 + (r() - 0.5) * 3, pz - 6 - r() * 6); }
    g.stroke();
  }
  // stone plazas in the bases, with team-coloured inlay
  const plaza = (cx, col) => {
    const R = 10.5;
    for (let ring = 0; ring < 7; ring++) {
      const r0 = 1.4 + ring * 1.45, n = 6 + ring * 6;
      for (let k = 0; k < n; k++) {
        const a0 = (k / n) * Math.PI * 2 + ring * 0.3, a1 = ((k + 1) / n) * Math.PI * 2 + ring * 0.3;
        const v = Math.floor(176 + r() * 40);
        g.fillStyle = `rgb(${v},${v - 6},${v - 18})`;
        g.strokeStyle = 'rgba(55,45,38,.8)'; g.lineWidth = 2;
        g.beginPath();
        g.arc(sx(cx), sz(0), r0 * ppm, a0, a1);
        g.arc(sx(cx), sz(0), Math.min(R, r0 + 1.45) * ppm, a1, a0, true);
        g.closePath(); g.fill(); g.stroke();
      }
    }
    g.strokeStyle = col; g.lineWidth = 0.35 * ppm;
    g.beginPath(); g.arc(sx(cx), sz(0), 3.6 * ppm, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(sx(cx), sz(0), 9.6 * ppm, 0, Math.PI * 2); g.stroke();
  };
  plaza(-LANE.fountainX + 3, '#3f8cff');
  plaza(LANE.fountainX - 3, '#ff4b3a');
  // the pit floor: old flagstones and a rune ring
  for (let i = 0; i < 120; i++) {
    const a = r() * Math.PI * 2, rr = Math.sqrt(r()) * (PIT.r - 0.4);
    const x = PIT.x + Math.cos(a) * rr, z = PIT.z + Math.sin(a) * rr, s = (0.5 + r() * 0.6) * ppm, v = Math.floor(160 + r() * 40);
    g.fillStyle = `rgb(${v},${v - 14},${v - 34})`; g.strokeStyle = 'rgba(70,52,40,.55)'; g.lineWidth = 1.2;
    g.save(); g.translate(sx(x), sz(z)); g.rotate(r() * 3);
    g.fillRect(-s / 2, -s / 2, s, s * 0.8); g.strokeRect(-s / 2, -s / 2, s, s * 0.8);
    g.restore();
  }
  g.strokeStyle = 'rgba(70,200,190,.55)'; g.lineWidth = 0.18 * ppm;
  g.beginPath(); g.arc(sx(PIT.x), sz(PIT.z), 4.2 * ppm, 0, Math.PI * 2); g.stroke();
  g.font = `${Math.round(0.7 * ppm)}px serif`; g.fillStyle = 'rgba(70,200,190,.6)';
  for (let k = 0; k < 16; k++) {
    const a = k / 16 * Math.PI * 2;
    g.save(); g.translate(sx(PIT.x + Math.cos(a) * 5), sz(PIT.z + Math.sin(a) * 5)); g.rotate(a + Math.PI / 2);
    g.fillText('ᚠᚢᚦᚨᚱᚲᚷᚹᚺᚾᛁᛃᛇᛈᛉᛊ'[k], -0.25 * ppm, 0.25 * ppm); g.restore();
  }
  // relic spots
  for (const rl of RELICS) {
    g.strokeStyle = 'rgba(120,230,140,.8)'; g.lineWidth = 0.12 * ppm;
    g.beginPath(); g.arc(sx(rl.x), sz(rl.z), 1.0 * ppm, 0, Math.PI * 2); g.stroke();
  }
  // darker soil under the brushes
  for (const b of BRUSHES) {
    g.fillStyle = 'rgba(50,80,30,.55)';
    g.beginPath(); g.ellipse(sx(b.x), sz(b.z), (b.rx + 0.4) * ppm, (b.rz + 0.4) * ppm, 0, 0, Math.PI * 2); g.fill();
  }
  const t = canvasTex(c, false);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

// one tile of the terrain (tiles let the camera and the shadow pass skip what they can't see)
export function makeTerrainGeo(x0, x1, z0, z1, res = 2) {
  const W = TERRAIN.maxX - TERRAIN.minX, D = TERRAIN.maxZ - TERRAIN.minZ, w = x1 - x0, d = z1 - z0;
  const g = new THREE.PlaneGeometry(w, d, Math.max(1, Math.round(w * res)), Math.max(1, Math.round(d * res)));
  g.rotateX(-Math.PI / 2);
  g.translate((x0 + x1) / 2, 0, (z0 + z1) / 2);
  const p = g.attributes.position, uv = g.attributes.uv, n = new Float32Array(p.count * 3);
  const e = 0.25;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    p.setY(i, groundHeight(x, z));
    uv.setXY(i, (x - TERRAIN.minX) / W, 1 - (z - TERRAIN.minZ) / D);
    // normals from the height function, so the strips join without seams
    const nx = groundHeight(x - e, z) - groundHeight(x + e, z), nz = groundHeight(x, z - e) - groundHeight(x, z + e), l = Math.hypot(nx, 2 * e, nz);
    n[i * 3] = nx / l; n[i * 3 + 1] = 2 * e / l; n[i * 3 + 2] = nz / l;
  }
  g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
  g.computeBoundingSphere();
  return g;
}

// ============================================================
//  Outline post pass
// ============================================================
const FS_VERT = `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const COMPOSITE_FRAG = `
uniform sampler2D tColor; uniform sampler2D tDepth; uniform sampler2D tNormal;
uniform vec2 res; uniform float cNear; uniform float cFar; uniform float uLine; uniform vec3 uInk; uniform float uFogFar;
uniform float uGray; uniform float uTime;
varying vec2 vUv;
float viewZ(float d) { float z = d * 2.0 - 1.0; return (2.0 * cNear * cFar) / (cFar + cNear - z * (cFar - cNear)); }
float iz(vec2 uv) { return 1.0 / viewZ(texture2D(tDepth, uv).r); }
vec3 nrm(vec2 uv) { return texture2D(tNormal, uv).xyz * 2.0 - 1.0; }
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec2 px = uLine / res;
  float c = iz(vUv);
  float l = iz(vUv - vec2(px.x, 0.0)), r = iz(vUv + vec2(px.x, 0.0));
  float u = iz(vUv + vec2(0.0, px.y)), d = iz(vUv - vec2(0.0, px.y));
  float lap = (abs(l + r - 2.0 * c) + abs(u + d - 2.0 * c)) / c;
  float jump = max(max(abs(l - c), abs(r - c)), max(abs(u - c), abs(d - c))) / c;
  float eD = max(smoothstep(0.004, 0.012, lap), smoothstep(0.03, 0.07, jump));
  vec3 n0 = nrm(vUv);
  float nd = max(max(1.0 - dot(n0, nrm(vUv - vec2(px.x, 0.0))), 1.0 - dot(n0, nrm(vUv + vec2(px.x, 0.0)))),
                 max(1.0 - dot(n0, nrm(vUv + vec2(0.0, px.y))), 1.0 - dot(n0, nrm(vUv - vec2(0.0, px.y)))));
  float eN = smoothstep(0.28, 0.5, nd);
  float vz = 1.0 / c;
  float edge = max(eD, eN) * (1.0 - smoothstep(uFogFar * 0.55, uFogFar, vz));
  vec3 col = texture2D(tColor, vUv).rgb;
  // a little more saturation, then the ink
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(lum), col, 1.12);
  col = mix(col, vec3(lum * 0.9), uGray);
  col = mix(col, uInk, edge * 0.92);
  // paper grain and a soft vignette
  float gr = hash(floor(gl_FragCoord.xy / 2.0) + floor(uTime * 8.0)) - 0.5;
  col *= 1.0 + gr * 0.035;
  vec2 q = vUv - 0.5;
  col *= 1.0 - dot(q, q) * 0.45;
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

export class ComicPost {
  constructor(renderer) {
    this.r = renderer;
    const opts = { type: THREE.HalfFloatType, samples: 4 };
    this.rtScene = new THREE.WebGLRenderTarget(1, 1, opts);
    this.rtScene.depthTexture = new THREE.DepthTexture(1, 1);
    this.rtScene.depthTexture.type = THREE.UnsignedIntType;
    this.rtNormal = new THREE.WebGLRenderTarget(1, 1, { type: THREE.UnsignedByteType });
    this.normalMat = new THREE.MeshNormalMaterial();
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: this.rtScene.texture }, tDepth: { value: this.rtScene.depthTexture }, tNormal: { value: this.rtNormal.texture },
        res: U.res, cNear: U.near, cFar: U.far, uLine: { value: 1 }, uInk: { value: new THREE.Color(0x1b120e) }, uFogFar: { value: 120 },
        uGray: { value: 0 }, uTime: U.time,
      },
      vertexShader: FS_VERT, fragmentShader: COMPOSITE_FRAG, depthTest: false, depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    this.quad.frustumCulled = false;
    this.qScene = new THREE.Scene();
    this.qScene.add(this.quad);
    this.qCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    U.tDepth.value = this.rtScene.depthTexture;
  }
  setSize(w, h, dpr) {
    const W = Math.max(1, Math.floor(w * dpr)), H = Math.max(1, Math.floor(h * dpr));
    this.rtScene.setSize(W, H);
    this.rtNormal.setSize(W, H);
    U.res.value.set(W, H);
    this.mat.uniforms.uLine.value = Math.max(1, dpr * 1.05);
  }
  render(scene, fxScene, camera) {
    const r = this.r;
    U.near.value = camera.near; U.far.value = camera.far;
    r.shadowMap.needsUpdate = true;
    r.setRenderTarget(this.rtScene);
    r.render(scene, camera);
    // normals, without shadows and without the sky colour
    const bg = scene.background, fog = scene.fog;
    scene.background = null; scene.fog = null;
    scene.overrideMaterial = this.normalMat;
    r.setClearColor(0x8080ff, 1);
    r.setRenderTarget(this.rtNormal);
    r.render(scene, camera);
    scene.overrideMaterial = null;
    scene.background = bg; scene.fog = fog;
    r.setRenderTarget(null);
    r.render(this.qScene, this.qCam);
    r.autoClear = false;
    // heroes hidden behind towers and cliffs show through as flat silhouettes (layer 1)
    // (a colour background would force a clear, so it is switched off for this pass)
    scene.background = null;
    camera.layers.set(1);
    r.render(scene, camera);
    camera.layers.set(0);
    scene.background = bg;
    if (fxScene) r.render(fxScene, camera);
    r.autoClear = true;
  }
}

// depth test against the scene for effect shaders (they are drawn after the outline pass, straight to the screen)
export const FX_DEPTH_PARS = `
uniform sampler2D tDepth; uniform vec2 res; uniform float cNear; uniform float cFar;
float fxViewZ(float d) { float z = d * 2.0 - 1.0; return (2.0 * cNear * cFar) / (cFar + cNear - z * (cFar - cNear)); }
// 0 when hidden behind the scene, fades in over 'soft' metres in front of it
float fxDepthFade(float soft) {
  float sceneZ = fxViewZ(texture2D(tDepth, gl_FragCoord.xy / res).r);
  float myZ = fxViewZ(gl_FragCoord.z);
  return clamp((sceneZ - myZ) / soft, 0.0, 1.0);
}
`;
export const fxDepthUniforms = () => ({ tDepth: U.tDepth, res: U.res, cNear: U.near, cFar: U.far });

// the see-through silhouette: drawn only where something in the scene is in front of it
const silCache = new Map();
export function silMat(color) {
  let m = silCache.get(color);
  if (m) return m;
  m = new THREE.ShaderMaterial({
    uniforms: { uC: { value: new THREE.Color(color) }, ...fxDepthUniforms() },
    vertexShader: `varying vec3 vN; varying vec3 vV;
      void main(){ vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform vec3 uC; varying vec3 vN; varying vec3 vV;
      ${FX_DEPTH_PARS}
      void main(){
        float sceneZ = fxViewZ(texture2D(tDepth, gl_FragCoord.xy / res).r);
        float myZ = fxViewZ(gl_FragCoord.z);
        if (myZ < sceneZ + 0.3) discard;
        float rim = 1.0 - abs(dot(normalize(vN), normalize(vV)));
        vec3 c = mix(uC * 0.55, uC * 1.25, smoothstep(0.45, 0.75, rim));
        gl_FragColor = vec4(c, 0.62 + 0.3 * step(0.7, rim));
        #include <colorspace_fragment>
      }`,
    transparent: true,
  });
  silCache.set(color, m);
  return m;
}
