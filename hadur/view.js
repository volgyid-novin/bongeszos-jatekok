import * as THREE from 'three';
import { MAP, TICK, UNITS, BUILDINGS, TEAM_COLORS } from './data.js';
import { TREE, ROCK, fbm } from './sim.js';
import { unitGeo, scaffoldGeo, C } from './models.js';

// Everything the player sees: terrain, forest, fog of war, entities, projectiles and effects.
// The simulation is never touched from here; positions are interpolated between ticks.

const N = MAP;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerpAngle = (a, b, k) => { let d = b - a; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return a + d * k; };
function hash(i) { let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return (h >>> 0) / 4294967296; }

// ---------- fog of war, injected into the standard materials ----------
const fogU = { fogTex: { value: null }, fogSize: { value: N } };
function fogify(mat) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.fogTex = fogU.fogTex;
    sh.uniforms.fogSize = fogU.fogSize;
    sh.vertexShader = 'varying vec2 vFogUv;\nuniform float fogSize;\n' + sh.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
      vec4 fogWp = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        fogWp = instanceMatrix * fogWp;
      #endif
      fogWp = modelMatrix * fogWp;
      vFogUv = fogWp.xz / fogSize;`);
    sh.fragmentShader = 'varying vec2 vFogUv;\nuniform sampler2D fogTex;\n' + sh.fragmentShader.replace('#include <dithering_fragment>', `#include <dithering_fragment>
      float fogIn = step(0.0, vFogUv.x) * step(vFogUv.x, 1.0) * step(0.0, vFogUv.y) * step(vFogUv.y, 1.0);
      gl_FragColor.rgb *= texture2D(fogTex, vFogUv).r * fogIn;`);
  };
  mat.customProgramCacheKey = () => 'fog1';
  return mat;
}

// ---------- particles ----------
function softTex() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.4, 'rgba(255,255,255,.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
class Pool {
  constructor(scene, n, color, additive, tex, grow = 1) {
    this.n = n; this.i = 0; this.grow = grow;
    this.pos = new Float32Array(n * 3); this.vel = new Float32Array(n * 3);
    this.life = new Float32Array(n); this.max = new Float32Array(n); this.size0 = new Float32Array(n);
    this.alpha = new Float32Array(n); this.size = new Float32Array(n);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { color: { value: new THREE.Color(color) }, tex: { value: tex }, scale: { value: 400 } },
      vertexShader: `attribute float aAlpha; attribute float aSize; varying float vA; uniform float scale;
        void main(){ vA = aAlpha; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = aSize * scale / -mv.z; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform vec3 color; uniform sampler2D tex; varying float vA;
        void main(){ vec4 t = texture2D(tex, gl_PointCoord); gl_FragColor = vec4(color, t.a * vA); if (gl_FragColor.a < 0.01) discard; }`,
      transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.pts = new THREE.Points(g, this.mat);
    this.pts.frustumCulled = false;
    scene.add(this.pts);
  }
  emit(x, y, z, vx, vy, vz, life, size) {
    const i = this.i; this.i = (i + 1) % this.n;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.life[i] = life; this.max[i] = life; this.size0[i] = size;
  }
  step(dt, drag, grav) {
    const k = Math.exp(-drag * dt);
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) { this.alpha[i] = 0; continue; }
      this.life[i] -= dt;
      const t = Math.max(0, this.life[i] / this.max[i]);
      this.vel[i * 3] *= k; this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * k + grav * dt; this.vel[i * 3 + 2] *= k;
      this.pos[i * 3] += this.vel[i * 3] * dt; this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt; this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.alpha[i] = t < 0.7 ? t / 0.7 : (1 - t) / 0.3;
      this.size[i] = this.size0[i] * (1 + (1 - t) * this.grow);
    }
    this.pts.geometry.attributes.position.needsUpdate = true;
    this.pts.geometry.attributes.aAlpha.needsUpdate = true;
    this.pts.geometry.attributes.aSize.needsUpdate = true;
  }
}

// ---------- the view ----------
export class View {
  constructor(canvas) {
    const r = (this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' }));
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0d0f0c);
    this.camera = new THREE.PerspectiveCamera(36, 1, 1, 400);
    this.cam = { x: 16, z: 22, dist: 30, pitch: 0.98 };
    const hemi = new THREE.HemisphereLight(0xdfeeff, 0x4a5a2a, 1.25);
    this.scene.add(hemi);
    const sun = (this.sun = new THREE.DirectionalLight(0xfff1d6, 2.3));
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -34; sc.right = 34; sc.top = 34; sc.bottom = -34; sc.near = 1; sc.far = 120;
    sun.shadow.bias = -0.0008;
    sun.shadow.normalBias = 0.03;
    this.scene.add(sun, sun.target);
    this.sunDir = new THREE.Vector3(-0.55, 1, 0.35).normalize();

    this.fogData = new Uint8Array(N * N * 4);
    this.fogTex = new THREE.DataTexture(this.fogData, N, N, THREE.RGBAFormat);
    this.fogTex.magFilter = THREE.LinearFilter;
    this.fogTex.minFilter = THREE.LinearFilter;
    fogU.fogTex.value = this.fogTex;
    this.fogCur = new Float32Array(N * N);
    this.vis = new Uint8Array(N * N);       // currently seen by the local player
    this.explored = new Uint8Array(N * N);
    this.reveal = false;

    this.mat = fogify(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
    this.matFlash = fogify(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, emissive: 0xffffff, emissiveIntensity: 0.45 }));
    this.ghostMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, transparent: true, opacity: 0.55, depthWrite: false });
    this.views = new Map();
    this.projViews = new Map();
    this.flashes = [];
    this.bolts = [];
    this.markers = [];
    const tex = softTex();
    this.FIRE = new Pool(this.scene, 500, 0xff8a2a, true, tex, 0.2);
    this.SMOKE = new Pool(this.scene, 600, 0x3a3532, false, tex, 1.6);
    this.DUST = new Pool(this.scene, 300, 0xb39d78, false, tex, 1.2);
    this.SPARK = new Pool(this.scene, 300, 0xffe28a, true, tex, 0);
    this.MAGIC = new Pool(this.scene, 300, 0x9bff7a, true, tex, 0.3);
    this.BLUE = new Pool(this.scene, 200, 0x8fd8ff, true, tex, 0.3);
    this.rings = [];
    this.ringGeo = new THREE.RingGeometry(0.92, 1, 40).rotateX(-Math.PI / 2);
    this.ringMats = {
      own: new THREE.MeshBasicMaterial({ color: 0x5dff7a, transparent: true, opacity: 0.85, depthWrite: false }),
      foe: new THREE.MeshBasicMaterial({ color: 0xff4a3a, transparent: true, opacity: 0.85, depthWrite: false }),
      neu: new THREE.MeshBasicMaterial({ color: 0xffe066, transparent: true, opacity: 0.85, depthWrite: false }),
      hov: new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false }),
    };
    this.projGeo = {};
    this.buildProjGeos();
    this.ghost = null;
    this.rally = this.makeRally();
    this.t = 0;
    this.resize();
  }

  // ---------- world setup ----------
  setWorld(sim, mySlot) {
    this.sim = sim;
    this.me = mySlot;
    this.clearWorld();
    this.world = new THREE.Group();
    this.scene.add(this.world);
    this.buildTerrain();
    this.buildTrees();
    this.vis.fill(0);
    this.explored.fill(0);
    this.fogCur.fill(0);
    this.reveal = false;
    this.seen = new Set();
    this.computeVis(true);
  }
  clearWorld() {
    for (const v of this.views.values()) this.scene.remove(v.root);
    this.views.clear();
    for (const p of this.projViews.values()) this.scene.remove(p);
    this.projViews.clear();
    for (const b of this.bolts) { this.scene.remove(b.line); b.line.geometry.dispose(); }
    this.bolts = [];
    for (const r of this.rings) r.visible = false;
    if (this.world) {
      this.world.traverse((o) => { if (o.geometry && o.geometry !== this.ringGeo) o.geometry.dispose(); });
      this.scene.remove(this.world);
      this.world = null;
    }
  }
  groundColor(x, z) {
    const n = fbm(x * 0.09, z * 0.09, 51), m = fbm(x * 0.35, z * 0.35, 77, 2);
    const c = new THREE.Color().setRGB(0.27 + n * 0.12 + m * 0.05, 0.42 + n * 0.12 + m * 0.06, 0.16 + n * 0.04, THREE.SRGBColorSpace);
    return c;
  }
  buildTerrain() {
    const sim = this.sim, V = N + 1;
    const g = new THREE.PlaneGeometry(N, N, N, N);
    g.rotateX(-Math.PI / 2);
    g.translate(N / 2, 0, N / 2);
    const pos = g.attributes.position, col = new Float32Array(pos.count * 3);
    const dirt = new THREE.Color(0x8a7048).convertSRGBToLinear(), dark = new THREE.Color(0x24391a).convertSRGBToLinear();
    const forestN = (x, z) => {
      let n = 0;
      for (let dz = -2; dz <= 1; dz++) for (let dx = -2; dx <= 1; dx++) {
        const tx = x + dx, tz = z + dz;
        if (tx < 0 || tz < 0 || tx >= N || tz >= N || sim.block[tz * N + tx] === TREE) n++;
      }
      return n / 16;
    };
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const c = this.groundColor(x, z);
      const f = forestN(Math.round(x), Math.round(z));
      c.lerp(dark, f * 0.55);
      // worn dirt paths through the open middle
      const d = fbm(x * 0.05 + 3, z * 0.05 - 7, 91, 2);
      if (d > 0.62) c.lerp(dirt, Math.min(0.55, (d - 0.62) * 4));
      pos.setY(i, (fbm(x * 0.2, z * 0.2, 13, 2) - 0.5) * 0.12 - f * 0.05);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeVertexNormals();
    this.groundCol = col;
    this.groundV = V;
    const tex = this.grassTex();
    const mat = fogify(new THREE.MeshLambertMaterial({ vertexColors: true, map: tex }));
    const ground = new THREE.Mesh(g, mat);
    ground.receiveShadow = true;
    this.ground = ground;
    this.world.add(ground);
    // dark surroundings beyond the map
    const out = new THREE.Mesh(new THREE.PlaneGeometry(N * 4, N * 4).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x0d0f0c }));
    out.position.set(N / 2, -0.2, N / 2);
    this.world.add(out);
    // packed earth around the gold mines (buildings stain their own ground when they appear)
    for (const e of sim.ents) if (e.cls === 'm') this.stainGround(e);
  }
  grassTex() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#e4e4e4'; g.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 2600; i++) {
      const v = 200 + Math.floor(Math.random() * 55);
      g.fillStyle = `rgb(${v},${v},${v})`;
      g.fillRect(Math.random() * 128, Math.random() * 128, 1 + Math.random() * 2, 1 + Math.random() * 3);
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(N / 4, N / 4);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }
  // packed earth under buildings and mines
  stainGround(e) {
    if (!this.ground) return;
    const col = this.groundCol, V = this.groundV;
    const dirt = new THREE.Color(e.cls === 'm' ? 0x7d6a52 : 0x86704e).convertSRGBToLinear();
    const pad = e.cls === 'm' ? 1.4 : 0.8;
    for (let z = Math.floor(e.tz - pad); z <= Math.ceil(e.tz + e.size + pad); z++) for (let x = Math.floor(e.tx - pad); x <= Math.ceil(e.tx + e.size + pad); x++) {
      if (x < 0 || z < 0 || x > N || z > N) continue;
      const dx = Math.max(e.tx - x, 0, x - (e.tx + e.size)), dz = Math.max(e.tz - z, 0, z - (e.tz + e.size));
      const k = clamp(1 - Math.sqrt(dx * dx + dz * dz) / (pad + 0.01), 0, 1) * 0.75;
      if (k <= 0) continue;
      const i = (z * V + x) * 3;
      col[i] += (dirt.r - col[i]) * k; col[i + 1] += (dirt.g - col[i + 1]) * k; col[i + 2] += (dirt.b - col[i + 2]) * k;
    }
    this.ground.geometry.attributes.color.needsUpdate = true;
  }
  buildTrees() {
    const sim = this.sim;
    const pines = [], leaves = [], rocks = [];
    for (let i = 0; i < N * N; i++) {
      if (sim.block[i] === TREE) (hash(i) < 0.55 ? pines : leaves).push(i);
      else if (sim.block[i] === ROCK) rocks.push(i);
    }
    const make = (type, list, colorFn, scaleFn) => {
      const m = new THREE.InstancedMesh(unitGeo(type, 0), fogify(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true })), Math.max(1, list.length));
      m.castShadow = true;
      m.receiveShadow = true;
      const mat4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), col = new THREE.Color();
      list.forEach((ti, k) => {
        const x = (ti % N) + 0.5 + (hash(ti * 3) - 0.5) * 0.35, z = Math.floor(ti / N) + 0.5 + (hash(ti * 5) - 0.5) * 0.35;
        const sc = scaleFn(ti);
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), hash(ti * 7) * Math.PI * 2);
        m.setMatrixAt(k, mat4.compose(p.set(x, 0, z), q, s.set(sc, sc * (0.9 + hash(ti * 11) * 0.3), sc)));
        m.setColorAt(k, colorFn(ti, col));
      });
      m.count = list.length;
      this.world.add(m);
      return m;
    };
    const greens = (ti, c) => c.setHSL(0.27 + hash(ti * 13) * 0.08, 0.45 + hash(ti * 17) * 0.2, 0.2 + hash(ti * 19) * 0.1, THREE.SRGBColorSpace);
    const leafy = (ti, c) => c.setHSL(0.2 + hash(ti * 13) * 0.1, 0.5 + hash(ti * 17) * 0.2, 0.28 + hash(ti * 19) * 0.1, THREE.SRGBColorSpace);
    this.treeMesh = { pine: make('pine', pines, greens, (ti) => 0.85 + hash(ti * 23) * 0.4), leaf: make('leaf', leaves, leafy, (ti) => 0.8 + hash(ti * 23) * 0.35) };
    make('boulder', rocks, (ti, c) => c.setHSL(0.08, 0.06, 0.38 + hash(ti) * 0.12, THREE.SRGBColorSpace), (ti) => 1 + hash(ti * 29) * 0.4);
    this.treeIdx = new Map();
    pines.forEach((ti, k) => this.treeIdx.set(ti, ['pine', k]));
    leaves.forEach((ti, k) => this.treeIdx.set(ti, ['leaf', k]));
    this.stumps = new THREE.InstancedMesh(unitGeo('stump', 0), this.mat, pines.length + leaves.length);
    this.stumps.count = 0;
    this.stumps.receiveShadow = true;
    this.world.add(this.stumps);
    this.shakes = new Map();
  }
  removeTree(ti) {
    const t = this.treeIdx.get(ti);
    if (!t) return;
    this.treeIdx.delete(ti);
    const m = this.treeMesh[t[0]], mat4 = new THREE.Matrix4();
    m.getMatrixAt(t[1], mat4);
    const p = new THREE.Vector3().setFromMatrixPosition(mat4);
    m.setMatrixAt(t[1], mat4.makeScale(0, 0, 0));
    m.instanceMatrix.needsUpdate = true;
    this.stumps.setMatrixAt(this.stumps.count++, mat4.makeTranslation(p.x, 0, p.z));
    this.stumps.instanceMatrix.needsUpdate = true;
    if (this.isVisXZ(p.x, p.z)) for (let k = 0; k < 8; k++) this.DUST.emit(p.x, 0.5 + Math.random(), p.z, (Math.random() - 0.5) * 2, 0.5, (Math.random() - 0.5) * 2, 0.9, 0.7);
  }
  shakeTree(ti) {
    const t = this.treeIdx.get(ti);
    if (!t) return;
    if (!this.shakes.has(ti)) {
      const m = this.treeMesh[t[0]], base = new THREE.Matrix4();
      m.getMatrixAt(t[1], base);
      this.shakes.set(ti, { m, k: t[1], base, t: 0 });
    } else this.shakes.get(ti).t = 0;
  }

  // ---------- fog of war ----------
  computeVis(force) {
    const sim = this.sim, vis = this.vis, ex = this.explored;
    vis.fill(0);
    if (this.reveal) { vis.fill(1); ex.fill(1); return; }
    for (const e of sim.ents) {
      if (e.owner !== this.me || e.dead || e.cls === 'm') continue;
      const d = e.cls === 'u' ? UNITS[e.type] : BUILDINGS[e.type];
      const r = e.cls === 'b' && !e.done ? 3 : d.sight;
      const cx = e.x, cz = e.z, r2 = r * r;
      const z0 = Math.max(0, Math.floor(cz - r)), z1 = Math.min(N - 1, Math.floor(cz + r));
      for (let z = z0; z <= z1; z++) {
        const dz = z + 0.5 - cz, w = r2 - dz * dz;
        if (w < 0) continue;
        const hw = Math.sqrt(w);
        const x0 = Math.max(0, Math.floor(cx - hw)), x1 = Math.min(N - 1, Math.floor(cx + hw));
        for (let x = x0; x <= x1; x++) { vis[z * N + x] = 1; ex[z * N + x] = 1; }
      }
    }
    if (force) for (let i = 0; i < N * N; i++) this.fogCur[i] = vis[i] ? 1 : ex[i] ? 0.5 : 0;
  }
  isVis(x, z) {
    const tx = Math.floor(x), tz = Math.floor(z);
    if (tx < 0 || tz < 0 || tx >= N || tz >= N) return false;
    return this.vis[tz * N + tx] === 1;
  }
  isVisXZ(x, z) { return this.isVis(x, z); }
  isExplored(tx, tz) { return tx >= 0 && tz >= 0 && tx < N && tz < N && this.explored[tz * N + tx] === 1; }
  updateFog(dt) {
    const k = 1 - Math.exp(-dt * 6), cur = this.fogCur, vis = this.vis, ex = this.explored, data = this.fogData;
    for (let i = 0; i < N * N; i++) {
      const target = vis[i] ? 1 : ex[i] ? 0.5 : 0.04;
      cur[i] += (target - cur[i]) * k;
      data[i * 4] = cur[i] * 255;
    }
    this.fogTex.needsUpdate = true;
  }
  // can the local player see this entity right now?
  canSee(e) {
    if (this.reveal || e.owner === this.me) return true;
    if (e.cls === 'u') return !e.hidden && this.isVis(e.x, e.z);
    if (e.cls === 'b') {
      if (this.seen.has(e.id)) return true;
      for (let z = e.tz; z < e.tz + e.size; z++) for (let x = e.tx; x < e.tx + e.size; x++) {
        if (this.vis[z * N + x]) { this.seen.add(e.id); return true; }
      }
      return false;
    }
    return true;
  }

  // ---------- entities ----------
  makeView(e) {
    const root = new THREE.Group();
    const geo = unitGeo(e.type, e.owner >= 0 ? TEAM_COLORS[e.owner] : 0);
    const body = new THREE.Mesh(geo, this.mat);
    body.castShadow = true;
    body.receiveShadow = true;
    root.add(body);
    const v = { id: e.id, e, root, body, yaw: e.owner === 1 ? Math.PI : 0, walk: Math.random() * 6, flash: 0, dying: 0, cls: e.cls };
    if (e.cls === 'u') {
      if (UNITS[e.type].worker) {
        v.sack = new THREE.Mesh(unitGeo('sack', 0), this.mat); v.sack.visible = false; body.add(v.sack);
        v.logs = new THREE.Mesh(unitGeo('logs', 0), this.mat); v.logs.visible = false; body.add(v.logs);
      }
      v.yaw = Math.atan2(N / 2 - e.x, N / 2 - e.z);
    } else if (e.cls === 'b') {
      v.scaffold = new THREE.Mesh(scaffoldGeo(e.size), this.mat);
      v.scaffold.castShadow = true;
      root.add(v.scaffold);
      this.stainGround(e);
      v.fireT = 0;
    }
    root.position.set(e.x, 0, e.z);
    this.scene.add(root);
    this.views.set(e.id, v);
    return v;
  }
  killView(id, ev) {
    const v = this.views.get(id);
    if (!v || v.dying) return;
    v.dying = 0.001;
    v.silent = ev && ev.silent;
    if (v.cls === 'b' && !v.silent && v.root.visible) {
      const s = v.e.size;
      for (let k = 0; k < 40; k++) {
        const x = v.e.tx + Math.random() * s, z = v.e.tz + Math.random() * s;
        this.SMOKE.emit(x, Math.random() * 1.5, z, (Math.random() - 0.5) * 1.5, 1 + Math.random() * 1.5, (Math.random() - 0.5) * 1.5, 2 + Math.random() * 1.5, 1.4);
        if (k % 2) this.FIRE.emit(x, Math.random(), z, (Math.random() - 0.5) * 2, 2 + Math.random() * 2, (Math.random() - 0.5) * 2, 0.7, 0.9);
      }
    }
    if (v.cls === 'm') { v.root.visible = false; v.dying = 9; }
  }
  sync(alpha, dt, sim) {
    this.t += dt;
    const tick = sim.tick;
    for (const e of sim.ents) {
      if (e.dead) continue;
      const v = this.views.get(e.id) || this.makeView(e);
      if (v.dying) continue;
      const see = this.canSee(e);
      v.root.visible = see && !e.hidden;
      if (!v.root.visible) continue;
      if (e.cls === 'u') this.syncUnit(v, e, alpha, dt, tick);
      else if (e.cls === 'b') this.syncBuilding(v, e, dt, tick);
      else if (e.inside > 0 && Math.random() < dt * 3) this.SPARK.emit(e.x + (Math.random() - 0.5), 0.8, e.z + 1.3, 0, 1, 0.5, 0.5, 0.25);
      if (v.flash > 0) { v.flash -= dt; v.body.material = v.flash > 0 ? this.matFlash : this.mat; }
    }
    // dying entities
    for (const [id, v] of this.views) {
      if (!v.dying) continue;
      v.dying += dt;
      if (v.cls === 'u') {
        const k = Math.min(1, v.dying / 0.35);
        v.body.rotation.z = k * 1.45;
        v.body.position.y = v.dying > 1.6 ? -(v.dying - 1.6) * 0.6 : 0;
        v.body.material = this.mat;
        if (v.dying > 3) this.disposeView(id, v);
      } else if (v.cls === 'b') {
        if (v.silent) { this.disposeView(id, v); continue; }
        v.body.scale.y = Math.max(0.05, 1 - v.dying * 0.9);
        v.root.position.y = -v.dying * 0.25;
        if (v.dying < 1.4 && Math.random() < 0.6) this.SMOKE.emit(v.e.tx + Math.random() * v.e.size, 0.4, v.e.tz + Math.random() * v.e.size, 0, 1.2, 0, 2.2, 1.6);
        if (v.dying > 1.6) this.disposeView(id, v);
      } else this.disposeView(id, v);
    }
    // tree shakes
    for (const [ti, s] of this.shakes) {
      s.t += dt;
      const a = Math.sin(s.t * 40) * 0.06 * Math.max(0, 1 - s.t / 0.35);
      const m4 = new THREE.Matrix4().makeRotationZ(a).premultiply(s.base);
      m4.copyPosition(s.base);
      s.m.setMatrixAt(s.k, s.t >= 0.35 || !this.treeIdx.has(ti) ? s.base : m4);
      s.m.instanceMatrix.needsUpdate = true;
      if (s.t >= 0.35 || !this.treeIdx.has(ti)) this.shakes.delete(ti);
    }
    this.syncProjectiles(alpha, sim);
  }
  disposeView(id, v) {
    this.scene.remove(v.root);
    this.views.delete(id);
  }
  syncUnit(v, e, alpha, dt, tick) {
    const d = UNITS[e.type];
    const x = e.px + (e.x - e.px) * alpha, z = e.pz + (e.z - e.pz) * alpha;
    const mx = e.x - e.px, mz = e.z - e.pz, moving = mx * mx + mz * mz > 1e-5;
    v.root.position.set(x, 0, z);
    let face = null;
    const tgt = e.tgt > 0 ? this.sim.byId.get(e.tgt) : null;
    const working = e.ord.t === 'gather' && e.ord.s === 'work' && e.ord.res === 'w';
    const attacking = tick - e.atkT < Math.max(4, d.cd / TICK);
    if (working) face = Math.atan2((e.ord.tree % N) + 0.5 - e.x, Math.floor(e.ord.tree / N) + 0.5 - e.z);
    else if (e.still && tgt && !tgt.dead) face = Math.atan2(tgt.x - e.x, tgt.z - e.z);
    else if (moving) face = Math.atan2(mx, mz);
    else if (attacking && tgt && !tgt.dead) face = Math.atan2(tgt.x - e.x, tgt.z - e.z);
    if (face !== null) v.yaw = lerpAngle(v.yaw, face, 1 - Math.exp(-dt * 12));
    v.root.rotation.y = v.yaw;
    const b = v.body, mount = d.r >= 0.5 && !d.siege;
    b.position.set(0, 0, 0); b.rotation.set(0, 0, 0);
    if (moving) {
      v.walk += dt * d.speed * (mount ? 4.5 : 6);
      if (d.siege) b.rotation.x = Math.sin(v.walk * 2) * 0.02;
      else if (mount) { b.position.y = Math.abs(Math.sin(v.walk)) * 0.07; b.rotation.x = Math.sin(v.walk) * 0.07; }
      else { b.position.y = Math.abs(Math.sin(v.walk)) * 0.05; b.rotation.z = Math.sin(v.walk) * 0.07; }
    }
    const at = (tick - e.atkT + alpha) * TICK;
    if (at >= 0 && at < 0.35) {
      const k = Math.sin((at / 0.35) * Math.PI);
      if (d.siege) b.position.z = -k * 0.12;
      else if (d.atk === 'melee') { b.position.z = k * 0.14; b.rotation.x = k * 0.22; }
      else b.rotation.x = -k * 0.12;
    }
    if (working || (e.ord.t === 'help' && e.still)) {
      const k = Math.max(0, Math.sin(this.t * 9 + e.id));
      b.rotation.x = k * 0.3;
    }
    if (v.sack) { v.sack.visible = e.carry > 0 && e.cres === 'g'; v.logs.visible = e.carry > 0 && e.cres === 'w'; }
  }
  syncBuilding(v, e, dt, tick) {
    const d = BUILDINGS[e.type];
    v.root.position.set(e.x, 0, e.z);
    v.body.scale.y = e.done ? 1 : 0.08 + 0.92 * e.prog;
    v.scaffold.visible = !e.done;
    const hp = e.hp / d.hp;
    if (e.done && hp < 0.55 && Math.random() < dt * (hp < 0.3 ? 14 : 6)) {
      const x = e.tx + 0.3 + Math.random() * (e.size - 0.6), z = e.tz + 0.3 + Math.random() * (e.size - 0.6), y = 0.6 + Math.random() * e.size * 0.5;
      this.FIRE.emit(x, y, z, 0, 1.2 + Math.random(), 0, 0.6, 0.55);
      if (Math.random() < 0.5) this.SMOKE.emit(x, y + 0.4, z, 0.2, 1.4, 0, 2.2, 0.9);
    }
    if (e.done && (e.type === 'blacksmith' || e.type === 'forge') && Math.random() < dt * 3) {
      const [ox, oz, oy] = e.type === 'blacksmith' ? [0.85, -0.85, 2] : [-0.4, -0.5, 2.5];
      this.SMOKE.emit(e.x + ox, oy, e.z + oz, 0.3, 1.0, 0, 2.6, 0.7);
    }
    if (e.done && e.type === 'spirit' && Math.random() < dt * 4) this.MAGIC.emit(e.x + 0.85 + (Math.random() - 0.5) * 0.3, 1.8, e.z + 0.6, 0, 0.6, 0, 1.0, 0.3);
    if (e.done && e.type === 'magetower' && Math.random() < dt * 4) this.BLUE.emit(e.x + (Math.random() - 0.5) * 0.4, 5.2, e.z + (Math.random() - 0.5) * 0.4, 0, 0.4, 0, 1.0, 0.3);
    if (!e.done && e.bt === 0 && Math.random() < dt * 0) this.DUST.emit(e.x, 0.2, e.z, 0, 0.5, 0, 1, 0.5);
  }

  // ---------- projectiles ----------
  buildProjGeos() {
    const g = this.projGeo;
    g.arrow = new THREE.BoxGeometry(0.03, 0.03, 0.45);
    g.spear = new THREE.BoxGeometry(0.04, 0.04, 0.7);
    g.bolt = new THREE.BoxGeometry(0.06, 0.06, 0.9);
    g.axe = new THREE.BoxGeometry(0.2, 0.04, 0.14);
    g.rock = new THREE.DodecahedronGeometry(0.16, 0);
    g.fire = new THREE.IcosahedronGeometry(0.16, 1);
    this.projMat = {
      arrow: new THREE.MeshBasicMaterial({ color: 0x5a3c22 }), spear: new THREE.MeshBasicMaterial({ color: 0x6b4a2a }),
      bolt: new THREE.MeshBasicMaterial({ color: 0x4a3420 }), axe: new THREE.MeshBasicMaterial({ color: 0xb8c0c8 }),
      rock: new THREE.MeshLambertMaterial({ color: 0x77706a, flatShading: true }), fire: new THREE.MeshBasicMaterial({ color: 0xffd27a }),
    };
  }
  syncProjectiles(alpha, sim) {
    const live = new Set();
    for (const p of sim.projs) {
      live.add(p.id);
      let m = this.projViews.get(p.id);
      if (!m) {
        m = new THREE.Mesh(this.projGeo[p.kind], this.projMat[p.kind]);
        this.scene.add(m);
        this.projViews.set(p.id, m);
      }
      const x = p.px + (p.x - p.px) * alpha, z = p.pz + (p.z - p.pz) * alpha;
      const dx = p.x - p.sx, dz = p.z - p.sz;
      const prog = clamp(Math.sqrt(dx * dx + dz * dz) / p.d0, 0, 1);
      const y0 = p.fromB ? 2.6 : 0.6;
      const arc = p.kind === 'rock' ? 3.2 : p.kind === 'fire' ? 0.6 : 0.5;
      const y = y0 + (0.4 - y0) * prog + Math.sin(prog * Math.PI) * arc * Math.min(1, p.d0 / 6);
      m.position.set(x, y, z);
      m.lookAt(p.tx, 0.4, p.tz);
      if (p.kind === 'axe') m.rotation.x += this.t * 25;
      m.visible = this.reveal || p.owner === this.me || this.isVis(x, z);
      if (p.kind === 'fire' && m.visible) {
        this.FIRE.emit(x, y, z, 0, 0.3, 0, 0.35, 0.55);
        if (Math.random() < 0.4) this.SMOKE.emit(x, y, z, 0, 0.3, 0, 0.8, 0.4);
      }
    }
    for (const [id, m] of this.projViews) if (!live.has(id)) { this.scene.remove(m); this.projViews.delete(id); }
  }

  // ---------- events from the simulation ----------
  event(ev) {
    const sim = this.sim;
    switch (ev.e) {
      case 'die': this.killView(ev.id, ev); break;
      case 'tree': this.removeTree(ev.i); break;
      case 'hit': {
        const v = this.views.get(ev.id);
        if (v) v.flash = 0.09;
        const t = sim.byId.get(ev.id);
        if (t && v && v.root.visible && t.cls === 'u') for (let k = 0; k < 3; k++) this.SPARK.emit(t.x, 0.5, t.z, (Math.random() - 0.5) * 2, 1 + Math.random(), (Math.random() - 0.5) * 2, 0.25, 0.18);
        break;
      }
      case 'chop': {
        const u = sim.byId.get(ev.id);
        if (u && u.ord.tree >= 0) this.shakeTree(u.ord.tree);
        break;
      }
      case 'impact': {
        if (!this.isVis(ev.x, ev.z) && !this.reveal) break;
        if (ev.k === 'fire') {
          for (let k = 0; k < 26; k++) this.FIRE.emit(ev.x, 0.3, ev.z, (Math.random() - 0.5) * 4, Math.random() * 3, (Math.random() - 0.5) * 4, 0.5, 0.8);
          for (let k = 0; k < 8; k++) this.SMOKE.emit(ev.x, 0.4, ev.z, (Math.random() - 0.5) * 1.5, 1, (Math.random() - 0.5) * 1.5, 1.5, 0.9);
        } else if (ev.k === 'rock') {
          for (let k = 0; k < 18; k++) this.DUST.emit(ev.x, 0.2, ev.z, (Math.random() - 0.5) * 4, 1 + Math.random() * 2, (Math.random() - 0.5) * 4, 1.1, 0.9);
          for (let k = 0; k < 6; k++) this.SPARK.emit(ev.x, 0.3, ev.z, (Math.random() - 0.5) * 5, 2 + Math.random() * 2, (Math.random() - 0.5) * 5, 0.4, 0.2);
        } else if (ev.k === 'bolt') {
          for (let k = 0; k < 8; k++) this.DUST.emit(ev.x, 0.3, ev.z, (Math.random() - 0.5) * 2, 1, (Math.random() - 0.5) * 2, 0.7, 0.5);
        }
        break;
      }
      case 'zap': this.lightning(ev.pts); break;
      case 'place': { const b = sim.byId.get(ev.id); if (b) for (let k = 0; k < 14; k++) this.DUST.emit(b.tx + Math.random() * b.size, 0.1, b.tz + Math.random() * b.size, 0, 0.6, 0, 1.2, 0.8); break; }
      case 'built': {
        const b = sim.byId.get(ev.id);
        if (b && this.canSee(b)) for (let k = 0; k < 20; k++) this.SPARK.emit(b.tx + Math.random() * b.size, 0.2 + Math.random() * 2, b.tz + Math.random() * b.size, 0, 1.5, 0, 0.8, 0.25);
        break;
      }
      case 'trained': {
        const u = sim.byId.get(ev.id);
        if (u && u.owner === this.me) for (let k = 0; k < 10; k++) this.BLUE.emit(u.x, 0.1 + Math.random() * 0.8, u.z, (Math.random() - 0.5), 0.8, (Math.random() - 0.5), 0.6, 0.25);
        break;
      }
    }
  }
  lightning(pts) {
    if (!this.reveal && !this.isVis(pts[2], pts[3]) && !this.isVis(pts[0], pts[1])) return;
    const arr = [];
    for (let k = 0; k + 3 < pts.length; k += 2) {
      const ax = pts[k], az = pts[k + 1], bx = pts[k + 2], bz = pts[k + 3];
      const ay = k === 0 ? 1.1 : 0.5;
      for (let s = 0; s < 6; s++) {
        const t0 = s / 6, t1 = (s + 1) / 6;
        const j = (t) => (t > 0 && t < 1 ? (Math.random() - 0.5) * 0.35 : 0);
        arr.push(ax + (bx - ax) * t0 + j(t0), ay + (0.5 - ay) * t0 + j(t0), az + (bz - az) * t0 + j(t0));
        arr.push(ax + (bx - ax) * t1 + j(t1), ay + (0.5 - ay) * t1 + j(t1), az + (bz - az) * t1 + j(t1));
      }
      for (let q = 0; q < 6; q++) this.MAGIC.emit(bx, 0.5, bz, (Math.random() - 0.5) * 2, Math.random() * 2, (Math.random() - 0.5) * 2, 0.35, 0.3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    const line = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xc8ffd0, transparent: true, blending: THREE.AdditiveBlending }));
    this.scene.add(line);
    this.bolts.push({ line, t: 0.28 });
  }

  // ---------- selection, markers, placement ghost ----------
  // sel: [{e, kind:'own'|'foe'|'neu'}], hover: entity or null
  drawRings(sel, hover) {
    let n = 0;
    const put = (e, kind, alpha) => {
      let r = this.rings[n];
      if (!r) { r = new THREE.Mesh(this.ringGeo, this.ringMats.own); r.renderOrder = 2; this.scene.add(r); this.rings.push(r); }
      n++;
      const v = this.views.get(e.id);
      r.material = this.ringMats[kind];
      const rad = e.cls === 'u' ? e.r + 0.12 : e.size * 0.72;
      r.scale.setScalar(rad);
      if (v && e.cls === 'u') r.position.set(v.root.position.x, 0.05, v.root.position.z);
      else r.position.set(e.x, 0.05, e.z);
      r.visible = true;
      return r;
    };
    for (const s of sel) if (!s.e.dead && (s.e.cls !== 'u' || !s.e.hidden)) put(s.e, s.kind);
    if (hover && !sel.some((s) => s.e === hover)) put(hover, 'hov');
    for (let k = n; k < this.rings.length; k++) this.rings[k].visible = false;
  }
  marker(x, z, attack) {
    const m = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color: attack ? 0xff4a3a : 0x6dff8a, transparent: true, depthWrite: false }));
    m.position.set(x, 0.06, z);
    this.scene.add(m);
    this.markers.push({ m, t: 0 });
  }
  makeRally() {
    const g = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.1, 5), new THREE.MeshLambertMaterial({ color: 0x5a3c22 }));
    pole.position.y = 0.55;
    const cloth = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.3, 0.45), new THREE.MeshLambertMaterial({ color: 0x6dff8a }));
    cloth.position.set(0, 0.92, 0.23);
    g.add(pole, cloth);
    g.visible = false;
    this.scene.add(g);
    return g;
  }
  showRally(p) {
    this.rally.visible = !!p;
    if (p) this.rally.position.set(p.x, 0, p.z);
  }
  // placement preview: type or null, top-left tile, per-tile validity
  setGhost(type, team, tx, tz, okTiles) {
    if (!type) { if (this.ghost) this.ghost.root.visible = false; return; }
    const d = BUILDINGS[type];
    if (!this.ghost || this.ghost.type !== type) {
      if (this.ghost) this.scene.remove(this.ghost.root);
      const root = new THREE.Group();
      const body = new THREE.Mesh(unitGeo(type, team), this.ghostMat);
      root.add(body);
      const tiles = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.92, 0.92).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.45, depthWrite: false }), d.size * d.size);
      tiles.position.set(-d.size / 2, 0.07, -d.size / 2);
      root.add(tiles);
      this.scene.add(root);
      this.ghost = { type, root, tiles };
    }
    const g = this.ghost, c = new THREE.Color(), m = new THREE.Matrix4();
    g.root.visible = true;
    g.root.position.set(tx + d.size / 2, 0, tz + d.size / 2);
    let k = 0;
    for (let z = 0; z < d.size; z++) for (let x = 0; x < d.size; x++) {
      g.tiles.setMatrixAt(k, m.makeTranslation(x + 0.5, 0, z + 0.5));
      g.tiles.setColorAt(k, c.set(okTiles[k] ? 0x4dff6a : 0xff3a2a));
      k++;
    }
    g.tiles.instanceMatrix.needsUpdate = true;
    g.tiles.instanceColor.needsUpdate = true;
  }

  // ---------- camera ----------
  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const ps = this.renderer.getPixelRatio() * h * 0.5 / Math.tan((this.camera.fov * Math.PI) / 360);
    for (const p of [this.FIRE, this.SMOKE, this.DUST, this.SPARK, this.MAGIC, this.BLUE]) p.mat.uniforms.scale.value = ps * 0.5;
    this.w = w; this.h = h;
  }
  placeCamera() {
    const c = this.cam;
    c.x = clamp(c.x, 0, N); c.z = clamp(c.z, 2, N + 4);
    this.camera.position.set(c.x, Math.sin(c.pitch) * c.dist, c.z + Math.cos(c.pitch) * c.dist);
    this.camera.lookAt(c.x, 0, c.z);
    this.camera.updateMatrixWorld();
    // shadow box follows the view (and grows with the zoom), snapped to texels to avoid shimmering
    const half = Math.round(c.dist * 0.95 + 6), sc = this.sun.shadow.camera;
    if (sc.right !== half) { sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half; sc.updateProjectionMatrix(); }
    const step = (half * 2) / 2048;
    const tx = Math.round(c.x / step) * step, tz = Math.round((c.z - 3) / step) * step;
    this.sun.target.position.set(tx, 0, tz);
    this.sun.position.set(tx + this.sunDir.x * 60, this.sunDir.y * 60, tz + this.sunDir.z * 60);
  }
  ray(sx, sy) {
    const v = new THREE.Vector3((sx / this.w) * 2 - 1, -(sy / this.h) * 2 + 1, 0.5).unproject(this.camera);
    const o = this.camera.position, dir = v.sub(o).normalize();
    if (dir.y >= -1e-4) return null;
    const t = -o.y / dir.y;
    return { x: o.x + dir.x * t, z: o.z + dir.z * t };
  }
  project(x, y, z) {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    return { x: (v.x + 1) * 0.5 * this.w, y: (1 - v.y) * 0.5 * this.h, front: v.z < 1 };
  }
  // ground points of the screen corners (for the minimap frame)
  frustum(bottomPx) {
    const h = this.h - bottomPx;
    return [[0, 0], [this.w, 0], [this.w, h], [0, h]].map(([x, y]) => this.ray(x, y) || { x: this.cam.x, z: this.cam.z - 40 });
  }

  render(dt) {
    for (const p of [this.FIRE, this.SMOKE, this.DUST, this.SPARK, this.MAGIC, this.BLUE]) {
      const drag = p === this.SPARK ? 1.5 : 0.8, grav = p === this.SPARK ? -6 : p === this.DUST ? -1.5 : 0.3;
      p.step(dt, drag, grav);
    }
    for (let k = this.bolts.length - 1; k >= 0; k--) {
      const b = this.bolts[k];
      b.t -= dt;
      b.line.material.opacity = Math.max(0, b.t / 0.28);
      if (b.t <= 0) { this.scene.remove(b.line); b.line.geometry.dispose(); b.line.material.dispose(); this.bolts.splice(k, 1); }
    }
    for (let k = this.markers.length - 1; k >= 0; k--) {
      const m = this.markers[k];
      m.t += dt;
      const s = 0.7 * (1 - m.t / 0.6) + 0.1;
      m.m.scale.setScalar(Math.max(0.05, s));
      m.m.material.opacity = Math.max(0, 1 - m.t / 0.6);
      if (m.t > 0.6) { this.scene.remove(m.m); m.m.material.dispose(); this.markers.splice(k, 1); }
    }
    this.placeCamera();
    this.renderer.render(this.scene, this.camera);
  }

  // ---------- portraits ----------
  // Renders each model once into a small image for the HUD buttons.
  icons(types, team) {
    const size = 96, rt = new THREE.WebGLRenderTarget(size, size, { colorSpace: THREE.SRGBColorSpace });
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x445533, 1.6));
    const l = new THREE.DirectionalLight(0xffffff, 2.2);
    l.position.set(-2, 4, 3);
    scene.add(l);
    const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    const buf = new Uint8Array(size * size * 4);
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const g = cv.getContext('2d'), img = g.createImageData(size, size);
    const out = {};
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    const prevTarget = this.renderer.getRenderTarget(), prevClear = this.renderer.getClearAlpha();
    for (const type of types) {
      const mesh = new THREE.Mesh(unitGeo(type, team), mat);
      scene.add(mesh);
      const bb = new THREE.Box3().setFromObject(mesh), c = bb.getCenter(new THREE.Vector3()), sz = bb.getSize(new THREE.Vector3());
      const r = Math.max(sz.x, sz.y, sz.z) * 0.62;
      const unit = !!UNITS[type];
      cam.position.set(c.x + r * 1.5, c.y + r * (unit ? 1.0 : 1.3), c.z + r * 2.6);
      cam.lookAt(c.x, c.y - (unit ? 0 : r * 0.1), c.z);
      this.renderer.setRenderTarget(rt);
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.clear();
      this.renderer.render(scene, cam);
      this.renderer.readRenderTargetPixels(rt, 0, 0, size, size, buf);
      for (let y = 0; y < size; y++) img.data.set(buf.subarray((size - 1 - y) * size * 4, (size - y) * size * 4), y * size * 4);
      g.putImageData(img, 0, 0);
      out[type] = cv.toDataURL();
      scene.remove(mesh);
    }
    this.renderer.setRenderTarget(prevTarget);
    this.renderer.setClearColor(0x0d0f0c, prevClear);
    rt.dispose();
    return out;
  }
}
