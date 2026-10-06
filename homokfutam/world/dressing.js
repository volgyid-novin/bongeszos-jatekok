import * as THREE from 'three';
import { ATMO, SUN_DIR } from '../gfx/atmosphere.js';
import { WIND_DIR } from '../gfx/ground.js';

// ============================================================
//  World dressing: everything that makes the place feel inhabited.
//  Arena: crowd (with stadium waves), cloth banners, flags, standings screens, floodlights,
//  a blimp and camera drones. Track side: sequenced chase lights, corner chevrons, a power
//  line, ruins, wrecks. Far away: mountain ridges and a settlement. Life: scrub, tumbleweeds,
//  vultures and dust devils.
//  ctx = { scene, TR, Q, groundQuery, nearestCoarse, rangeWhere, rng, fbm, vnoise, triplanarMaterial, mergeGeometries }
// ============================================================

const C = (h) => new THREE.Color(h);
const TAU = Math.PI * 2;

function canvasTexture(w, h, draw, srgb = true) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// --- crowd: procedural little people on camera-facing quads ---
const CROWD_V = /* glsl */`
attribute vec4 iPos;       // xyz feet, w along-track metres
attribute vec4 iCol;       // shirt rgb, seed
uniform float uTime, uCheer, uWave;
uniform vec3 hfSunDir;
uniform sampler2DShadow hfShadowMap;
uniform mat4 hfShadowMatrix;
uniform float hfShadowOn;
varying vec2 vUv; varying vec4 vCol; varying float vArms, vSun;
#include <fog_pars_vertex>
void main() {
  float seed = iCol.w;
  // stadium wave travelling along the stands + random jumping when excited
  float wave = uWave * smoothstep( 0.6, 1.0, sin( iPos.w * 0.045 - uTime * 3.2 ) );
  float jump = uCheer * max( 0.0, sin( uTime * ( 7.0 + seed * 5.0 ) + seed * 40.0 ) ) * 0.35;
  float stand = max( wave, smoothstep( 0.2, 0.6, uCheer ) * step( 0.35, fract( seed * 7.3 ) ) );
  vArms = max( wave, uCheer * step( 0.5, fract( seed * 3.1 ) ) );
  vec3 feet = iPos.xyz + vec3( 0.0, jump + wave * 0.4 + stand * 0.25, 0.0 );
  float h = mix( 1.25, 1.75, stand ) * ( 0.9 + fract( seed * 13.7 ) * 0.2 );
  vec3 toCam = cameraPosition - feet; toCam.y = 0.0;
  vec3 right = normalize( vec3( toCam.z, 0.0, - toCam.x ) + 1e-5 );
  vec3 p = feet + right * position.x * 0.75 + vec3( 0.0, ( position.y + 0.5 ) * h, 0.0 );
  vUv = position.xy + 0.5;
  vCol = iCol;
  vec3 sc = ( hfShadowMatrix * vec4( feet + vec3( 0.0, 1.0, 0.0 ) + hfSunDir * 2.0, 1.0 ) ).xyz;
  float inside = step( 0.0, sc.x ) * step( sc.x, 1.0 ) * step( 0.0, sc.y ) * step( sc.y, 1.0 );
  vSun = mix( 1.0, texture( hfShadowMap, vec3( sc.xy, sc.z - 0.001 ) ), inside * hfShadowOn );
  vec4 mvPosition = viewMatrix * vec4( p, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const CROWD_F = /* glsl */`
uniform vec3 uAmbient, uSunCol;
varying vec2 vUv; varying vec4 vCol; varying float vArms, vSun;
#include <common>
#include <fog_pars_fragment>
float box( vec2 p, vec2 b, float r ) { vec2 d = abs( p ) - b + r; return length( max( d, 0.0 ) ) + min( max( d.x, d.y ), 0.0 ) - r; }
void main() {
  vec2 p = vec2( ( vUv.x - 0.5 ) * 0.75, vUv.y );
  float seed = vCol.w;
  float head = length( p - vec2( 0.0, 0.86 ) ) - 0.085;
  float body = box( p - vec2( 0.0, 0.52 ), vec2( 0.13, 0.24 ), 0.06 );
  float legs = box( p - vec2( 0.0, 0.16 ), vec2( 0.1, 0.16 ), 0.03 );
  float armY = mix( 0.5, 0.95, vArms );
  float arms = min( box( p - vec2( 0.17, armY ), vec2( 0.035, 0.18 ), 0.03 ), box( p - vec2( -0.17, armY ), vec2( 0.035, 0.18 ), 0.03 ) );
  float d = min( min( head, body ), min( legs, arms ) );
  if ( d > 0.0 ) discard;
  vec3 skin = mix( vec3( 0.55, 0.36, 0.24 ), vec3( 0.95, 0.75, 0.6 ), fract( seed * 5.7 ) ) * 0.8;
  vec3 col = head < 0.0 ? skin : ( legs < 0.0 && body > 0.0 ? vec3( 0.18, 0.16, 0.15 ) : ( arms < 0.0 && body > 0.0 ? skin : vCol.rgb ) );
  if ( head < 0.0 && p.y > 0.9 ) col = mix( vec3( 0.06, 0.04, 0.03 ), vec3( 0.5, 0.35, 0.15 ), fract( seed * 9.1 ) );
  float shade = 0.75 + 0.25 * vUv.y;
  gl_FragColor = vec4( col * ( uAmbient + uSunCol * vSun * 0.85 ) * shade, 1.0 );
  #include <fog_fragment>
}`;

// --- cloth: vertex displacement on a standard material (lit, shadowed) ---
function clothMaterial(params, { amp = 0.4, freq = 1.2, speed = 3.5, fixedEdge = 'x', length = 3 } = {}) {
  const m = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.85, ...params });
  const u = { uTime: ATMO.hfTime, uAmp: { value: amp }, uFreq: { value: freq }, uSpeed: { value: speed }, uLen: { value: length } };
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, ATMO, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime, uAmp, uFreq, uSpeed, uLen;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        float ph = 0.0;
        #ifdef USE_INSTANCING
          ph = instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.21;
        #endif
        float along = ${fixedEdge === 'x' ? 'position.x' : '( - position.y )'};
        float k = clamp( along / uLen, 0.0, 1.0 );
        float w = sin( along * uFreq - uTime * uSpeed + ph ) + 0.5 * sin( along * uFreq * 2.3 - uTime * uSpeed * 1.7 + ph * 2.0 );
        transformed.z += w * uAmp * k;
        ${fixedEdge === 'x' ? 'transformed.y -= k * k * 0.25;' : ''}`);
  };
  m.customProgramCacheKey = () => 'cloth-' + fixedEdge;
  return m;
}

export function buildDressing(ctx) {
  const { scene, TR, Q, groundQuery, nearestCoarse, rangeWhere, rng, fbm, vnoise, triplanarMaterial, mergeGeometries } = ctx;
  const rand = rng(4242);
  const updaters = [];
  const D = Q.dressing;
  const _nc = { i: 0, d: 0 };
  const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), P = new THREE.Vector3(), S = new THREE.Vector3(1, 1, 1);
  const metal = new THREE.MeshStandardMaterial({ color: '#3b342e', metalness: 0.75, roughness: 0.45 });
  // the same for instanced meshes: sharing one material between instanced and plain meshes makes
  // three.js switch shader programs every time the draw order alternates between them
  const metalI = metal.clone();
  const metalLight = new THREE.MeshStandardMaterial({ color: '#8c857c', metalness: 0.8, roughness: 0.35 });
  const stoneMat = ctx.stoneMat || triplanarMaterial('blocks', { scale: 1 / 4, chroma: 0.25, vertexColors: false, color: '#d8c3a0', rough: [0.55, 0.45], macro: 0.15 });
  const out = { update: null, setStandings: null, cheer: 0, wave: 0 };

  // ---------------- arena ----------------
  const ar = rangeWhere(TR.arena, 0.55);
  const arenaSamples = [];
  if (ar) for (let k = ar[0]; k <= ar[1]; k++) arenaSamples.push(TR.idx(k));
  const side = (i, s, o, y) => P.set(TR.px[i] - TR.tz[i] * s * o, y, TR.pz[i] + TR.tx[i] * s * o);

  // crowd
  const crowdU = { uTime: ATMO.hfTime, uCheer: { value: 0 }, uWave: { value: 0 }, uAmbient: { value: C('#7d6f63') }, uSunCol: { value: C('#ffd9b0') } };
  if (arenaSamples.length && Q.crowd > 0) {
    const pos = [], col = [];
    const shirts = ['#c8342c', '#2f6fd0', '#e8772e', '#efe6d4', '#e2b93b', '#3c8f6a', '#7a4fc0', '#1d1a18', '#9c4a2a', '#5a7da8'].map(C);
    arenaSamples.forEach((i, n) => {
      const hw = TR.hw[i], y0 = TR.py[i];
      for (const s of [-1, 1]) for (let j = 0; j < 11; j++) for (let a = 0; a < 4; a++) {
        if (rand() > 0.82 * Q.crowd) continue;
        const along = (a - 1.5) * 1.0 + (rand() - 0.5) * 0.3;
        const o = TR.hw[i] + 2.8 + 3.2 * j + 0.9 + rand() * 0.8;
        side(i, s, o, y0 + 4.2 + 2.2 * j);
        pos.push(P.x + TR.tx[i] * along, P.y, P.z + TR.tz[i] * along, (TR.s[i] + along) * s + j * 3);
        const c = shirts[Math.floor(rand() * shirts.length)];
        const v = 0.75 + rand() * 0.4;
        col.push(c.r * v, c.g * v, c.b * v, rand());
      }
    });
    const g = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    g.index = quad.index; g.attributes.position = quad.attributes.position;
    g.setAttribute('iPos', new THREE.InstancedBufferAttribute(new Float32Array(pos), 4));
    g.setAttribute('iCol', new THREE.InstancedBufferAttribute(new Float32Array(col), 4));
    g.instanceCount = pos.length / 4;
    const mat = new THREE.ShaderMaterial({
      vertexShader: CROWD_V, fragmentShader: CROWD_F, side: THREE.DoubleSide, fog: true,
      uniforms: Object.assign({}, THREE.UniformsUtils.clone(THREE.UniformsLib.fog), ATMO, crowdU),
    });
    const crowd = new THREE.Mesh(g, mat);
    crowd.frustumCulled = false;
    crowd.userData.dynamic = true;
    scene.add(crowd);
    out.crowdCount = g.instanceCount;
  }

  // cloth banners in front of the stands, with printed emblems
  if (arenaSamples.length) {
    const emblem = canvasTexture(512, 512, (g) => {
      const cells = [
        (x, y) => { g.fillRect(x + 40, y + 30, 48, 196); g.fillRect(x + 168, y + 30, 48, 196); },
        (x, y) => { g.beginPath(); g.arc(x + 128, y + 110, 64, 0, TAU); g.lineWidth = 22; g.stroke(); g.fillRect(x + 118, y + 180, 20, 60); },
        (x, y) => { for (let k = 0; k < 3; k++) { g.beginPath(); g.moveTo(x + 40, y + 40 + k * 64); g.lineTo(x + 128, y + 90 + k * 64); g.lineTo(x + 216, y + 40 + k * 64); g.lineWidth = 20; g.stroke(); } },
        (x, y) => { g.beginPath(); g.moveTo(x + 128, y + 24); g.lineTo(x + 200, y + 140); g.lineTo(x + 128, y + 230); g.lineTo(x + 56, y + 140); g.closePath(); g.fill(); },
      ];
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, 512, 512);
      g.fillStyle = g.strokeStyle = 'rgba(25,18,12,0.85)';
      cells.forEach((f, k) => f((k % 2) * 256, (k >> 1) * 256));
      // fringe band at the bottom of each cell
      g.fillStyle = 'rgba(0,0,0,0.35)';
      for (let k = 0; k < 4; k++) g.fillRect((k % 2) * 256, (k >> 1) * 256 + 236, 256, 20);
    });
    const geo = new THREE.PlaneGeometry(2.8, 11, 3, 18);
    geo.translate(0, -5.5, 0);
    // pick one of the four emblem cells per banner through the uv
    const PAL = ['#2f6fd0', '#e8772e', '#c8342c', '#efe6d4', '#e2b93b', '#3c8f6a', '#7a4fc0'].map(C);
    const mat = clothMaterial({ map: emblem }, { amp: 0.22, freq: 0.9, speed: 2.2, fixedEdge: 'y', length: 11 });
    const variants = [0, 1, 2, 3].map((cell) => {
      const g2 = geo.clone();
      const uv = g2.attributes.uv;
      for (let v = 0; v < uv.count; v++) uv.setXY(v, (cell % 2) * 0.5 + uv.getX(v) * 0.5, 0.5 - (cell >> 1) * 0.5 + uv.getY(v) * 0.5);
      return g2;
    });
    const items = [];
    for (let k = 4; k < arenaSamples.length - 4; k += 4) for (const s of [-1, 1]) items.push([arenaSamples[k], s]);
    variants.forEach((vg, cell) => {
      const mine = items.filter((_, n) => n % 4 === cell);
      const im = new THREE.InstancedMesh(vg, mat, mine.length);
      const T = new THREE.Vector3(), U = new THREE.Vector3(0, 1, 0), R = new THREE.Vector3();
      mine.forEach(([i, s], n) => {
        T.set(TR.tx[i], 0, TR.tz[i]); R.set(-TR.tz[i], 0, TR.tx[i]);
        mtx.makeBasis(T, U, R.clone().multiplyScalar(s));
        side(i, s, TR.hw[i] + 2.2, TR.py[i] + 14.2);
        mtx.setPosition(P);
        im.setMatrixAt(n, mtx);
        im.setColorAt(n, PAL[Math.floor(rand() * PAL.length)]);
      });
      im.castShadow = true;
      scene.add(im);
    });
    // the hanging rods
    const rods = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.08, 0.08, 3.2, 6).rotateZ(Math.PI / 2), metalI, items.length);
    items.forEach(([i, s], n) => {
      side(i, s, TR.hw[i] + 2.2, TR.py[i] + 14.25);
      mtx.compose(P, q.setFromEuler(e.set(0, TR.yaw[i], 0)), S.set(1, 1, 1));
      rods.setMatrixAt(n, mtx);
    });
    scene.add(rods);
  }

  // flags on poles along the top of the stands, streaming with the wind
  if (arenaSamples.length) {
    const fl = [];
    for (let k = 2; k < arenaSamples.length - 2; k += 5) for (const s of [-1, 1]) fl.push([arenaSamples[k], s]);
    const pole = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.1, 0.14, 9, 6).translate(0, 4.5, 0), metalLight, fl.length);
    const flagGeo = new THREE.PlaneGeometry(4, 2.2, 12, 4).translate(2, 0, 0);
    const flagMat = clothMaterial({}, { amp: 0.55, freq: 1.6, speed: 7, fixedEdge: 'x', length: 4 });
    const flags = new THREE.InstancedMesh(flagGeo, flagMat, fl.length);
    const PAL = ['#e8772e', '#f4ece0', '#c8342c', '#2f6fd0', '#e2b93b'].map(C);
    const windYaw = Math.atan2(WIND_DIR.y, WIND_DIR.x);
    fl.forEach(([i, s], n) => {
      const top = TR.py[i] + 32.9;
      side(i, s, TR.hw[i] + 39.4, top);
      mtx.compose(P, q.identity(), S.set(1, 1, 1));
      pole.setMatrixAt(n, mtx);
      mtx.compose(P.setY(top + 7.6), q.setFromEuler(e.set(0, -windYaw, 0)), S.set(1, 1, 1));
      flags.setMatrixAt(n, mtx);
      flags.setColorAt(n, PAL[n % PAL.length]);
    });
    pole.castShadow = flags.castShadow = true;
    scene.add(pole, flags);
  }

  // big standings screens on frames, one each side near the line
  const screens = [];
  if (arenaSamples.length) {
    const cv = document.createElement('canvas'); cv.width = 1024; cv.height = 512;
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
    const glow = new THREE.MeshBasicMaterial({ map: tex, color: new THREE.Color(1, 1, 1).multiplyScalar(Q.post ? 1.6 : 1), toneMapped: true });
    const frameMat = metal;
    const at = [Math.floor(arenaSamples.length * 0.3), Math.floor(arenaSamples.length * 0.62)];
    at.forEach((n, k) => {
      const i = arenaSamples[n], s = k ? 1 : -1;
      const g = new THREE.Group();
      const scr = new THREE.Mesh(new THREE.PlaneGeometry(24, 12), glow);
      scr.position.set(0, 0, 0.3);
      const back = new THREE.Mesh(new THREE.BoxGeometry(25.5, 13.5, 0.6), frameMat);
      const legL = new THREE.Mesh(new THREE.BoxGeometry(0.8, 34, 0.8), frameMat); legL.position.set(-9, -17, -0.5);
      const legR = legL.clone(); legR.position.x = 9;
      g.add(scr, back, legL, legR);
      side(i, s, TR.hw[i] + 44, TR.py[i] + 40);
      g.position.copy(P);
      // face the track
      g.lookAt(TR.px[i], TR.py[i] + 20, TR.pz[i]);
      g.traverse((o) => { if (o.isMesh && o !== scr) o.castShadow = true; });
      scene.add(g);
      screens.push(g);
    });
    let last = '';
    out.setStandings = (rows, title) => {
      const key = JSON.stringify(rows) + title;
      if (key === last) return;
      last = key;
      const g = cv.getContext('2d');
      g.fillStyle = '#120d09'; g.fillRect(0, 0, 1024, 512);
      g.fillStyle = '#ff7b2e'; g.fillRect(0, 0, 1024, 70);
      g.fillStyle = '#120d09'; g.font = '800 54px "Saira Condensed", "Arial Narrow", sans-serif'; g.textBaseline = 'middle';
      g.fillText(title || 'HOMOKFUTAM', 28, 38);
      g.font = '700 50px "Saira Condensed", "Arial Narrow", sans-serif';
      rows.slice(0, 6).forEach((r, k) => {
        const y = 110 + k * 66;
        g.fillStyle = k % 2 ? '#1d1610' : '#251c14'; g.fillRect(0, y - 32, 1024, 64);
        g.fillStyle = '#c4ad8b'; g.fillText(String(k + 1), 30, y);
        g.fillStyle = r.color; g.fillRect(90, y - 20, 16, 40);
        g.fillStyle = r.me ? '#ff9a52' : '#f2e4c9'; g.fillText(r.name.toUpperCase(), 126, y);
        g.fillStyle = '#c4ad8b'; g.textAlign = 'right'; g.fillText(r.info || '', 994, y); g.textAlign = 'left';
      });
      // scanlines
      g.fillStyle = 'rgba(0,0,0,0.18)';
      for (let y = 0; y < 512; y += 4) g.fillRect(0, y, 1024, 1);
      tex.needsUpdate = true;
    };
    out.setStandings([], 'HOMOKFUTAM');
  }

  // floodlight towers around the arena (lamps on for the golden hour)
  // (one merged mesh for all towers and one for all lamps)
  if (arenaSamples.length) {
    const lampMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#fff1d6').multiplyScalar(Q.post ? 6 : 1.2) });
    const towers = [], lamps = [], o3 = new THREE.Object3D();
    for (const [f, s] of [[0.12, -1], [0.12, 1], [0.5, -1], [0.5, 1], [0.88, -1], [0.88, 1]]) {
      const i = arenaSamples[Math.floor(arenaSamples.length * f)];
      side(i, s, TR.hw[i] + 46, TR.py[i] - 2);
      o3.position.copy(P);
      o3.lookAt(TR.px[i], TR.py[i] - 2, TR.pz[i]);
      o3.rotateX(0.22);
      o3.updateMatrix();
      towers.push(new THREE.CylinderGeometry(0.6, 1.4, 58, 8).translate(0, 29, 0).applyMatrix4(o3.matrix));
      towers.push(new THREE.BoxGeometry(9, 5, 1.2).translate(0, 58, 0.4).applyMatrix4(o3.matrix));
      for (let a = 0; a < 3; a++) for (let b = 0; b < 2; b++) lamps.push(new THREE.CircleGeometry(0.85, 12).translate(-3 + a * 3, 56.9 + b * 2.2, 1.05).applyMatrix4(o3.matrix));
    }
    const tm = new THREE.Mesh(mergeGeometries(towers.map((g) => g.toNonIndexed())), metal);
    tm.castShadow = true;
    scene.add(tm, new THREE.Mesh(mergeGeometries(lamps.map((g) => g.toNonIndexed())), lampMat));
  }

  // blimp circling above the arena, with a banner
  {
    const mid = arenaSamples.length ? arenaSamples[Math.floor(arenaSamples.length / 2)] : 0;
    const cx = TR.px[mid] + 120, cz = TR.pz[mid] - 160;
    const blimp = new THREE.Group();
    const skin = new THREE.MeshStandardMaterial({ color: '#d9d2c4', roughness: 0.55, metalness: 0.1 });
    const body = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16).scale(9, 9, 32), skin);
    const fins = [];
    for (let k = 0; k < 4; k++) fins.push(new THREE.BoxGeometry(0.4, 9, 7).translate(0, 7, -27).rotateZ(k * Math.PI / 2));
    fins.push(new THREE.BoxGeometry(3, 2.4, 9).translate(0, -9.5, 2));
    blimp.add(body, new THREE.Mesh(mergeGeometries(fins), new THREE.MeshStandardMaterial({ color: '#e8772e', roughness: 0.6 })));
    const banner = canvasTexture(1024, 256, (g) => {
      g.fillStyle = '#1b140e'; g.fillRect(0, 0, 1024, 256);
      g.font = '800 170px "Saira Condensed", "Arial Narrow", sans-serif'; g.textBaseline = 'middle'; g.textAlign = 'center';
      g.fillStyle = '#f2e4c9'; g.fillText('HOMOK', 340, 135); g.fillStyle = '#ff7b2e'; g.fillText('FUTAM', 700, 135);
    });
    for (const s of [-1, 1]) {
      const b = new THREE.Mesh(new THREE.PlaneGeometry(30, 7.5), new THREE.MeshStandardMaterial({ map: banner, roughness: 0.6 }));
      b.position.set(s * 9.15, 0, 0);
      b.rotation.y = s * Math.PI / 2;
      blimp.add(b);
    }
    blimp.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    blimp.userData.dynamic = true;
    scene.add(blimp);
    updaters.push((dt, t) => {
      const a = t * 0.025;
      blimp.position.set(cx + Math.cos(a) * 420, 190 + Math.sin(t * 0.2) * 4, cz + Math.sin(a) * 420);
      blimp.rotation.set(0, -a, Math.sin(t * 0.3) * 0.02);
    });
  }

  // camera drones that shadow the leaders
  const drones = [];
  {
    const body = new THREE.BoxGeometry(0.9, 0.3, 0.9), arm = new THREE.BoxGeometry(1.8, 0.08, 0.1);
    const led = new THREE.MeshBasicMaterial({ color: new THREE.Color('#ff3030').multiplyScalar(Q.post ? 8 : 1) });
    for (let k = 0; k < 2; k++) {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(body, metal));
      const a1 = new THREE.Mesh(arm, metal); a1.rotation.y = Math.PI / 4;
      const a2 = new THREE.Mesh(arm, metal); a2.rotation.y = -Math.PI / 4;
      const l = new THREE.Mesh(new THREE.SphereGeometry(0.12, 6, 4), led); l.position.y = -0.2;
      g.add(a1, a2, l);
      g.userData = { dynamic: true, led: l, x: 0, y: 30, z: 0 };
      scene.add(g);
      drones.push(g);
    }
  }
  out.updateDrones = (targets, dt, t) => {
    drones.forEach((d, k) => {
      const tg = targets[k];
      if (!tg) { d.visible = false; return; }
      d.visible = true;
      const u = d.userData, fx = Math.sin(tg.yaw), fz = Math.cos(tg.yaw);
      const gx = tg.x + fx * 25 + (k ? 8 : -8), gz = tg.z + fz * 25, gy = tg.y + 9 + Math.sin(t * 1.3 + k) * 1.2;
      const kk = 1 - Math.exp(-2.2 * dt);
      u.x += (gx - u.x) * kk; u.y += (gy - u.y) * kk; u.z += (gz - u.z) * kk;
      if (Math.hypot(gx - u.x, gz - u.z) > 300) { u.x = gx; u.y = gy; u.z = gz; }
      d.position.set(u.x, u.y, u.z);
      d.rotation.set(0.25, tg.yaw + Math.PI, Math.sin(t * 2 + k) * 0.05);
      u.led.visible = (t * 2 + k * 0.5) % 1 < 0.15;
    });
  };

  // ---------------- track side ----------------
  // sequenced chase lights on short posts along the open sections
  {
    const list = [];
    for (let k = 0; k < TR.N; k += 5) {
      const i = TR.idx(k);
      if (TR.arena[i] > 0.05 || TR.canyon[i] > 0.05) continue;
      for (const s of [-1, 1]) list.push([i, s]);
    }
    const postGeo = new THREE.CylinderGeometry(0.18, 0.26, 1.4, 6).translate(0, 0.7, 0);
    const posts = new THREE.InstancedMesh(postGeo, new THREE.MeshStandardMaterial({ color: '#2b2622', roughness: 0.6, metalness: 0.4 }), list.length);
    const lampGeo = new THREE.InstancedBufferGeometry();
    const sph = new THREE.SphereGeometry(0.26, 10, 6);
    lampGeo.index = sph.index; lampGeo.attributes.position = sph.attributes.position;
    const lp = new Float32Array(list.length * 4);
    list.forEach(([i, s], n) => {
      const o = TR.hw[i] + 1.6;
      side(i, s, o, TR.py[i]);
      const gy = Math.max(TR.py[i], groundQuery(P.x, P.z)) - 0.05;
      mtx.makeTranslation(P.x, gy, P.z);
      posts.setMatrixAt(n, mtx);
      lp.set([P.x, gy + 1.55, P.z, TR.s[i]], n * 4);
    });
    lampGeo.setAttribute('iPos', new THREE.InstancedBufferAttribute(lp, 4));
    lampGeo.instanceCount = list.length;
    const lampMat = new THREE.ShaderMaterial({
      uniforms: { uTime: ATMO.hfTime, uK: { value: Q.post ? 7 : 1.5 } },
      vertexShader: `attribute vec4 iPos; uniform float uTime; varying float vI;
        void main(){ float ph = fract( iPos.w / 60.0 - uTime * 1.6 ); vI = 0.12 + pow( smoothstep( 0.86, 1.0, ph ), 2.0 ) * 1.0;
          gl_Position = projectionMatrix * viewMatrix * vec4( position + iPos.xyz, 1.0 ); }`,
      fragmentShader: `uniform float uK; varying float vI; void main(){ gl_FragColor = vec4( vec3( 1.0, 0.45, 0.12 ) * vI * uK, 1.0 ); }`,
    });
    const lamps = new THREE.Mesh(lampGeo, lampMat);
    lamps.frustumCulled = false;
    lamps.userData.noBake = true;
    posts.castShadow = true;
    scene.add(posts, lamps);
  }

  // chevron boards on the outside of the sharpest corners
  {
    const tex = canvasTexture(256, 128, (g) => {
      g.fillStyle = '#f4ece0'; g.fillRect(0, 0, 256, 128);
      g.fillStyle = '#d0342a';
      for (let k = 0; k < 2; k++) {
        const x = 40 + k * 100;
        g.beginPath(); g.moveTo(x, 14); g.lineTo(x + 46, 64); g.lineTo(x, 114); g.lineTo(x + 30, 114); g.lineTo(x + 76, 64); g.lineTo(x + 30, 14); g.closePath(); g.fill();
      }
    });
    const boards = [];
    let lastK = -999;
    for (let k = 0; k < TR.N; k++) {
      const kk = TR.k[k];
      if (Math.abs(kk) < 0.0085 || TR.canyon[k] > 0.1 || TR.arena[k] > 0.1 || k - lastK < 3) continue;
      lastK = k;
      boards.push([k, kk > 0 ? 1 : -1]);
    }
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, side: THREE.DoubleSide });
    const im = new THREE.InstancedMesh(new THREE.PlaneGeometry(3.6, 1.8).translate(0, 2.2, 0), mat, boards.length);
    const legs = new THREE.InstancedMesh(new THREE.BoxGeometry(0.15, 2.4, 0.15).translate(0, 1.2, 0), metalI, boards.length * 2);
    boards.forEach(([i, dir], n) => {
      // outside of the turn: a left turn (k > 0) has its outside on the right (+d)
      const s = dir > 0 ? 1 : -1;
      side(i, s, TR.hw[i] + 7, 0);
      const gy = groundQuery(P.x, P.z);
      // the board faces the oncoming pods; arrows point into the turn
      const yaw = TR.yaw[i] + Math.PI + (s > 0 ? 0.25 : -0.25);
      mtx.compose(P.setY(gy), q.setFromEuler(e.set(0, yaw, 0)), S.set(dir > 0 ? -1 : 1, 1, 1));
      im.setMatrixAt(n, mtx);
      for (const l of [-1.4, 1.4]) {
        mtx.compose(new THREE.Vector3(P.x + Math.cos(yaw) * l, gy, P.z - Math.sin(yaw) * l), q.identity(), S.set(1, 1, 1));
        legs.setMatrixAt(n * 2 + (l > 0 ? 1 : 0), mtx);
      }
    });
    im.castShadow = legs.castShadow = true;
    scene.add(im, legs);
  }

  // a power line marching across the desert
  {
    const a0 = new THREE.Vector2(-1500, 600), a1 = new THREE.Vector2(1900, -2100);
    const n = Math.round(14 * D) + 4;
    const towers = [];
    const towerGeo = (() => {
      const parts = [];
      for (const [x, z] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) {
        const leg = new THREE.CylinderGeometry(0.25, 0.35, 34, 5);
        leg.rotateX(z * 0.016); leg.rotateZ(-x * 0.016);
        leg.translate(x * 0.75, 17, z * 0.75);
        parts.push(leg);
      }
      for (let k = 0; k < 5; k++) {
        const y = 4 + k * 6.5, w = 3.6 - k * 0.45;
        parts.push(new THREE.BoxGeometry(w, 0.2, 0.2).translate(0, y, w / 2), new THREE.BoxGeometry(w, 0.2, 0.2).translate(0, y, -w / 2));
        parts.push(new THREE.BoxGeometry(0.2, 0.2, w).translate(w / 2, y, 0), new THREE.BoxGeometry(0.2, 0.2, w).translate(-w / 2, y, 0));
      }
      parts.push(new THREE.BoxGeometry(14, 0.6, 0.6).translate(0, 33.5, 0));
      parts.push(new THREE.BoxGeometry(9, 0.5, 0.5).translate(0, 28, 0));
      return mergeGeometries(parts.map((p) => p.toNonIndexed()));
    })();
    for (let k = 0; k < n; k++) {
      const t = k / (n - 1);
      const x = a0.x + (a1.x - a0.x) * t + (rand() - 0.5) * 30, z = a0.y + (a1.y - a0.y) * t + (rand() - 0.5) * 30;
      nearestCoarse(x, z, _nc);
      if (_nc.i >= 0 && _nc.d < TR.hw[_nc.i] + 25) continue;
      towers.push(new THREE.Vector3(x, groundQuery(x, z) - 0.5, z));
    }
    const yaw = Math.atan2(a1.x - a0.x, a1.y - a0.y) + Math.PI / 2;
    const im = new THREE.InstancedMesh(towerGeo, metalI, towers.length);
    towers.forEach((p, k) => { mtx.compose(p, q.setFromEuler(e.set(0, yaw, 0)), S.set(1, 1, 1)); im.setMatrixAt(k, mtx); });
    im.castShadow = true;
    scene.add(im);
    // sagging cables between neighbouring towers
    const pts = [];
    const ox = Math.cos(yaw), oz = -Math.sin(yaw);
    for (let k = 0; k < towers.length - 1; k++) for (const off of [-6.5, 0, 6.5]) {
      const A = towers[k], B = towers[k + 1];
      const ya = A.y + (off ? 33.2 : 27.7), yb = B.y + (off ? 33.2 : 27.7);
      const L = Math.hypot(B.x - A.x, B.z - A.z);
      for (let j = 0; j < 16; j++) {
        for (const jj of [j, j + 1]) {
          const t = jj / 16;
          pts.push(A.x + (B.x - A.x) * t + ox * off, ya + (yb - ya) * t - Math.sin(t * Math.PI) * L * 0.045, A.z + (B.z - A.z) * t + oz * off);
        }
      }
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: '#2a2420' }));
    lines.userData.noBake = true;
    scene.add(lines);
  }

  // ruins: broken columns and wall stubs of an old station near the track
  {
    const sites = [Math.floor(TR.N * 0.18), Math.floor(TR.N * 0.47), Math.floor(TR.N * 0.83)];
    const parts = [];
    for (const i0 of sites) {
      const i = TR.idx(i0), s = rand() < 0.5 ? -1 : 1;
      if (TR.canyon[i] > 0.05 || TR.arena[i] > 0.05) continue;
      side(i, s, TR.hw[i] + 55 + rand() * 30, 0);
      const cx = P.x, cz = P.z;
      for (let k = 0; k < 9; k++) {
        const a = rand() * TAU, d = 6 + rand() * 26, x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
        const gy = groundQuery(x, z);
        if (rand() < 0.6) {
          const h = 3 + rand() * 12;
          const g = new THREE.CylinderGeometry(1.1, 1.3, h, 12, Math.ceil(h / 1.6));
          const p = g.attributes.position;
          for (let v = 0; v < p.count; v++) if (p.getY(v) > h / 2 - 0.01) p.setY(v, p.getY(v) - rand() * 1.5);   // broken top
          g.rotateZ((rand() - 0.5) * 0.15);
          g.translate(x, gy + h / 2 - 0.6, z);
          parts.push(g);
          if (rand() < 0.5) parts.push(new THREE.BoxGeometry(3.2, 0.9, 3.2).translate(x, gy + 0.2, z));
        } else {
          const w = 6 + rand() * 10, h = 2 + rand() * 6;
          const g = new THREE.BoxGeometry(w, h, 1.4, 6, 3, 1);
          const p = g.attributes.position;
          for (let v = 0; v < p.count; v++) if (p.getY(v) > 0) p.setY(v, p.getY(v) * (0.5 + 0.5 * vnoise(p.getX(v) * 0.6 + k, 3)));
          g.rotateY(rand() * TAU);
          g.translate(x, gy + h / 2 - 0.8, z);
          parts.push(g);
        }
      }
    }
    if (parts.length) {
      const g = mergeGeometries(parts.map((p) => { p.deleteAttribute('uv'); return p.toNonIndexed(); }));
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, stoneMat);
      m.castShadow = m.receiveShadow = true;
      scene.add(m);
    }
  }

  // wrecks: old engines half buried in the sand beside the track
  {
    const rust = new THREE.MeshStandardMaterial({ color: '#5a3a26', roughness: 0.8, metalness: 0.5 });
    const parts = [];
    for (let k = 0; k < Math.round(6 * D); k++) {
      const i = TR.idx(Math.floor(rand() * TR.N));
      if (TR.canyon[i] > 0.05 || TR.arena[i] > 0.05) continue;
      side(i, rand() < 0.5 ? -1 : 1, TR.hw[i] + 18 + rand() * 40, 0);
      const gy = groundQuery(P.x, P.z);
      const g = new THREE.CylinderGeometry(0.7, 0.8, 5.5, 14, 1, false);
      g.rotateZ(Math.PI / 2 + (rand() - 0.5) * 0.6);
      g.rotateY(rand() * TAU);
      g.translate(P.x, gy + 0.2, P.z);
      const n2 = new THREE.CylinderGeometry(0.85, 0.65, 1, 14, 1, true);
      n2.rotateZ(Math.PI / 2); n2.rotateY(rand() * TAU); n2.translate(P.x + 2, gy + 0.3, P.z + 1);
      parts.push(g, n2);
    }
    if (parts.length) {
      const g = mergeGeometries(parts.map((p) => p.toNonIndexed()));
      const m = new THREE.Mesh(g, rust);
      m.castShadow = m.receiveShadow = true;
      scene.add(m);
    }
  }

  // ---------------- far away ----------------
  // mountain ridges on the horizon (the height fog turns them into blue-grey silhouettes)
  {
    const ring = (R, H, seed, segs = 360) => {
      const pos = [], col = [], index = [];
      const c1 = C('#9a6e4c'), c2 = C('#c9a07a');
      for (let k = 0; k <= segs; k++) {
        const a = (k / segs) * TAU;
        const n = fbm(Math.cos(a) * 3 + seed, Math.sin(a) * 3 - seed, 5);
        const h = H * (0.25 + n * 1.2) * (0.6 + 0.4 * Math.sin(a * 3 + seed));
        const x = 90 + Math.cos(a) * R, z = -690 + Math.sin(a) * R;
        pos.push(x, -60, z, x + Math.cos(a) * 300, Math.max(0, h), z + Math.sin(a) * 300);
        for (let j = 0; j < 2; j++) col.push(...(j ? c2 : c1).toArray());
      }
      for (let k = 0; k < segs; k++) { const a = k * 2; index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.setIndex(index); g.computeVertexNormals();
      return g;
    };
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide });
    out.mountains = [];          // replaced by the rendered horizon (world/horizon.js) once it loads
    for (const [R, H, sd] of [[5200, 520, 1.3], [6600, 900, 4.1]]) {
      const m = new THREE.Mesh(ring(R, H, sd), mat);
      m.userData.noBake = true;
      scene.add(m);
      out.mountains.push(m);
    }
  }
  // a settlement on the horizon: domes, a tower with a beacon
  {
    const parts = [];
    const cx = 90 + Math.cos(2.4) * 3300, cz = -690 + Math.sin(2.4) * 3300;
    for (let k = 0; k < 26; k++) {
      const x = cx + (rand() - 0.5) * 420, z = cz + (rand() - 0.5) * 260, r = 8 + rand() * 18, h = 6 + rand() * 18;
      parts.push(new THREE.CylinderGeometry(r, r * 1.05, h, 16).translate(x, h / 2 - 2, z));
      parts.push(new THREE.SphereGeometry(r, 16, 8, 0, TAU, 0, Math.PI / 2).translate(x, h - 2, z));
    }
    parts.push(new THREE.CylinderGeometry(4, 7, 120, 10).translate(cx, 58, cz));
    parts.push(new THREE.SphereGeometry(9, 12, 8).translate(cx, 122, cz));
    const g = mergeGeometries(parts.map((p) => { p.deleteAttribute('uv'); return p.toNonIndexed(); }));
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: '#d9c5a3', roughness: 0.9 }));
    m.userData.noBake = true;
    scene.add(m);
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(3, 8, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color('#ff3020').multiplyScalar(Q.post ? 20 : 1), fog: false }));
    beacon.position.set(cx, 133, cz);
    beacon.userData.noBake = true;
    scene.add(beacon);
    updaters.push((dt, t) => { beacon.visible = t % 1.6 < 0.25; });
  }

  // ---------------- life ----------------
  // dry scrub: crossed cards with a branch texture
  {
    const tex = canvasTexture(128, 128, (g) => {
      const r = rng(77);
      g.strokeStyle = '#5b4630'; g.lineCap = 'round';
      const branch = (x, y, a, len, w) => {
        if (len < 4) return;
        const x2 = x + Math.cos(a) * len, y2 = y - Math.sin(a) * len;
        g.lineWidth = w; g.beginPath(); g.moveTo(x, y); g.lineTo(x2, y2); g.stroke();
        branch(x2, y2, a + 0.5 + r() * 0.3, len * 0.68, w * 0.7);
        branch(x2, y2, a - 0.5 - r() * 0.3, len * 0.68, w * 0.7);
      };
      for (let k = 0; k < 5; k++) branch(64 + (r() - 0.5) * 20, 128, Math.PI / 2 + (r() - 0.5) * 0.9, 30 + r() * 12, 4);
    });
    const card = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
    const g = mergeGeometries([card.clone(), card.clone().rotateY(Math.PI / 2)]);
    const mat = new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 1 });
    const list = [];
    for (let k = 0; k < 900 * D; k++) {
      const i = TR.idx(Math.floor(rand() * TR.N));
      if (TR.arena[i] > 0.05 || TR.canyon[i] > 0.3) continue;
      side(i, rand() < 0.5 ? -1 : 1, TR.hw[i] + 6 + Math.pow(rand(), 1.5) * 160, 0);
      list.push([P.x, groundQuery(P.x, P.z) - 0.1, P.z, 0.6 + rand() * 1.4]);
    }
    const im = new THREE.InstancedMesh(g, mat, list.length);
    list.forEach(([x, y, z, s], n) => { mtx.compose(P.set(x, y, z), q.setFromEuler(e.set(0, rand() * TAU, 0)), S.set(s * 1.3, s, s * 1.3)); im.setMatrixAt(n, mtx); });
    im.castShadow = true;
    scene.add(im);
  }

  // tumbleweeds rolling with the wind near the camera
  const weeds = [];
  {
    const tex = canvasTexture(128, 128, (g) => {
      const r = rng(9);
      g.strokeStyle = '#7a5c3a'; g.lineWidth = 2.2;
      for (let k = 0; k < 70; k++) {
        g.beginPath();
        const a = r() * TAU, rr = 20 + r() * 44;
        g.arc(64 + (r() - 0.5) * 30, 64 + (r() - 0.5) * 30, rr, a, a + 0.8 + r() * 1.6);
        g.stroke();
      }
    });
    const mat = new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 1 });
    const geo = new THREE.IcosahedronGeometry(1, 1);
    for (let k = 0; k < Math.round(10 * D); k++) {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true;
      m.userData = { dynamic: true, r: 0.6 + rand() * 0.5, ph: rand() * 10, x: 1e9, z: 1e9, sp: 5 + rand() * 5 };
      scene.add(m);
      weeds.push(m);
    }
  }

  // vultures circling above the canyon and the spires
  const birds = [];
  {
    const wing = new THREE.BufferGeometry();
    wing.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0.6, 0, 0, -0.6, 2.6, 0.1, -0.2, 0, 0, 0.6, -2.6, 0.1, -0.2, 0, 0, -0.6], 3));
    wing.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: '#241c16', side: THREE.DoubleSide, roughness: 1 });
    const centres = [[TR.px[TR.idx(Math.floor(TR.N * 0.38))], TR.pz[TR.idx(Math.floor(TR.N * 0.38))]], [560, -260]];
    for (let k = 0; k < 9; k++) {
      const m = new THREE.Mesh(wing, mat);
      const c = centres[k % 2];
      m.userData = { dynamic: true, cx: c[0], cz: c[1], R: 60 + rand() * 120, h: 140 + rand() * 90, w: 0.12 + rand() * 0.1, ph: rand() * TAU };
      m.scale.setScalar(1.3);
      scene.add(m);
      birds.push(m);
    }
  }

  // dust devils wandering across the dunes
  const devils = [];
  {
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true, fog: true,
      uniforms: Object.assign({}, THREE.UniformsUtils.clone(THREE.UniformsLib.fog), ATMO, { uCol: { value: C('#d7b58a') } }),
      vertexShader: `varying vec2 vUv; varying vec3 vN, vV;
        #include <fog_pars_vertex>
        void main(){ vUv = uv; vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 ); vN = normalize( normalMatrix * normal ); vV = normalize( - mvPosition.xyz );
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: `uniform vec3 uCol; varying vec2 vUv; varying vec3 vN, vV;
        #include <common>
        #include <fog_pars_fragment>
        void main(){
          float n = texture2D( hfCloudTex, vec2( vUv.x * 3.0 + hfTime * 0.9 + vUv.y * 1.5, vUv.y * 1.2 - hfTime * 0.35 ) ).r;
          float n2 = texture2D( hfCloudTex, vec2( vUv.x * 5.0 - hfTime * 1.3, vUv.y * 2.0 - hfTime * 0.6 ) ).r;
          float edge = pow( abs( dot( normalize( vN ), normalize( vV ) ) ), 0.8 );
          float a = smoothstep( 0.35, 0.75, n * n2 * 1.6 ) * edge * smoothstep( 0.0, 0.12, vUv.y ) * smoothstep( 1.0, 0.5, vUv.y );
          gl_FragColor = vec4( uCol * ( 0.75 + 0.35 * vUv.y ), a * 0.55 );
          #include <fog_fragment>
        }`,
    });
    const geo = new THREE.CylinderGeometry(14, 3, 120, 24, 8, true).translate(0, 60, 0);
    for (let k = 0; k < 3; k++) {
      const m = new THREE.Mesh(geo, mat);
      const a = rand() * TAU, d = 900 + rand() * 900;
      m.userData = { dynamic: true, x: 90 + Math.cos(a) * d, z: -690 + Math.sin(a) * d, vx: (rand() - 0.5) * 6, vz: (rand() - 0.5) * 6 };
      m.renderOrder = 2;
      scene.add(m);
      devils.push(m);
    }
  }

  out.update = (dt, t, camPos) => {
    for (const f of updaters) f(dt, t);
    crowdU.uCheer.value = out.cheer;
    crowdU.uWave.value = out.wave;
    // tumbleweeds: respawn upwind of the camera, roll and bounce downwind
    for (const w of weeds) {
      const u = w.userData;
      if (Math.hypot(u.x - camPos.x, u.z - camPos.z) > 260) {
        const a = Math.random() * TAU, d = 60 + Math.random() * 160;
        u.x = camPos.x + Math.cos(a) * d - WIND_DIR.x * 80; u.z = camPos.z + Math.sin(a) * d - WIND_DIR.y * 80;
      }
      u.x += WIND_DIR.x * u.sp * dt; u.z += WIND_DIR.y * u.sp * dt;
      const g = groundQuery(u.x, u.z);
      const hop = Math.abs(Math.sin(t * 2.2 + u.ph)) * 1.4;
      w.position.set(u.x, g + u.r + hop, u.z);
      w.scale.setScalar(u.r);
      w.rotation.set(t * u.sp / u.r * 0.9, Math.atan2(WIND_DIR.x, WIND_DIR.y), 0);
    }
    for (const b of birds) {
      const u = b.userData, a = t * u.w + u.ph;
      b.position.set(u.cx + Math.cos(a) * u.R, u.h + Math.sin(t * 0.3 + u.ph) * 6, u.cz + Math.sin(a) * u.R);
      b.rotation.set(0, -a, 0.35);
      const flap = Math.sin(t * 6 + u.ph) > 0.7 ? Math.sin(t * 14 + u.ph) * 0.35 : 0.05;
      b.scale.set(1.3, 1.3 + flap, 1.3);
    }
    for (const d of devils) {
      const u = d.userData;
      u.x += u.vx * dt; u.z += u.vz * dt;
      if (Math.hypot(u.x - 90, u.z + 690) > 2200) { u.vx = -u.vx; u.vz = -u.vz; }
      d.position.set(u.x, groundQuery(u.x, u.z) - 2, u.z);
      d.rotation.y = t * 1.5;
    }
  };
  return out;
}
