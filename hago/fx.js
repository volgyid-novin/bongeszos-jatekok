import * as THREE from 'three';
import { FX_DEPTH_PARS, fxDepthUniforms, comicMat, U } from './toon.js';
import { Kit } from './models.js';
import { groundHeight, RELICS } from './map.js';
import { K, F, TEAMS, HEROES, LANE } from './data.js';

// Effects: projectiles, explosions, zones, status markers, aiming indicators, and the sounds that go with
// them. Everything is driven by the events of the simulation (see sim.js: ev / fx), so the host and the
// other players see the same thing. Glowing things go to view.fxScene (drawn after the outlines);
// solid things (arrows, daggers, rocks, the falcon, traps) go to the main scene and get outlined.

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const rnd = (a, b) => a + Math.random() * (b - a);
const ease = (t) => (t < 0 ? 0 : t > 1 ? 1 : t * t * (3 - 2 * t));
const _c = new THREE.Color();

// ---------- particle textures ----------
function tex(draw, n = 64) {
  const c = document.createElement('canvas');
  c.width = c.height = n;
  draw(c.getContext('2d'), n);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const TEX = {
  glow: () => tex((g, n) => { const gr = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2); gr.addColorStop(0, '#fff'); gr.addColorStop(0.35, 'rgba(255,255,255,.7)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, n, n); }),
  // a comic cloud puff: flat body, a darker lower half and an ink rim
  puff: () => tex((g, n) => {
    g.beginPath(); g.arc(n / 2, n / 2, n * 0.42, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill();
    g.save(); g.clip(); g.fillStyle = 'rgba(0,0,0,.18)'; g.beginPath(); g.arc(n * 0.58, n * 0.66, n * 0.42, 0, Math.PI * 2); g.fill(); g.restore();
    g.lineWidth = n * 0.06; g.strokeStyle = 'rgba(30,20,15,.85)'; g.beginPath(); g.arc(n / 2, n / 2, n * 0.42, 0, Math.PI * 2); g.stroke();
  }),
  spark: () => tex((g, n) => {
    g.translate(n / 2, n / 2); g.fillStyle = '#fff';
    g.beginPath();
    for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4, r = i % 2 ? n * 0.1 : n * 0.48; g.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
    g.closePath(); g.fill();
  }),
};

// ---------- particle pool ----------
class Pool {
  constructor(scene, n, texture, additive, drag = 2) {
    this.n = n; this.i = 0; this.drag = drag;
    this.pos = new Float32Array(n * 3); this.vel = new Float32Array(n * 3);
    this.col = new Float32Array(n * 3); this.c0 = new Float32Array(n * 3); this.c1 = new Float32Array(n * 3);
    this.life = new Float32Array(n); this.max = new Float32Array(n); this.size0 = new Float32Array(n); this.grow = new Float32Array(n);
    this.grav = new Float32Array(n); this.alpha = new Float32Array(n); this.size = new Float32Array(n); this.rot = new Float32Array(n); this.spin = new Float32Array(n);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    g.setAttribute('aRot', new THREE.BufferAttribute(this.rot, 1));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { tex: { value: texture }, scale: { value: 400 }, ...fxDepthUniforms() },
      vertexShader: `attribute vec3 aColor; attribute float aAlpha; attribute float aSize; attribute float aRot;
        varying vec3 vC; varying float vA; varying float vR; uniform float scale;
        void main(){ vC = aColor; vA = aAlpha; vR = aRot; vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * scale / -mv.z; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform sampler2D tex; varying vec3 vC; varying float vA; varying float vR;
        ${FX_DEPTH_PARS}
        void main(){
          vec2 uv = gl_PointCoord - 0.5; float c = cos(vR), s = sin(vR); uv = mat2(c, -s, s, c) * uv + 0.5;
          vec4 t = texture2D(tex, uv);
          float a = t.a * vA * fxDepthFade(0.35);
          if (a < 0.01) discard;
          gl_FragColor = vec4(vC * t.rgb, a);
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false, depthTest: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.pts = new THREE.Points(g, this.mat);
    this.pts.frustumCulled = false;
    this.pts.renderOrder = additive ? 3 : 2;
    scene.add(this.pts);
  }
  // c0 -> c1 over the life; grow: size multiplier at the end; grav: m/s² (negative rises)
  emit(x, y, z, vx, vy, vz, life, size, c0, c1 = c0, grow = 1, grav = 0) {
    const i = this.i; this.i = (i + 1) % this.n;
    const j = i * 3;
    this.pos[j] = x; this.pos[j + 1] = y; this.pos[j + 2] = z;
    this.vel[j] = vx; this.vel[j + 1] = vy; this.vel[j + 2] = vz;
    _c.set(c0); this.c0[j] = _c.r; this.c0[j + 1] = _c.g; this.c0[j + 2] = _c.b;
    _c.set(c1); this.c1[j] = _c.r; this.c1[j + 1] = _c.g; this.c1[j + 2] = _c.b;
    this.life[i] = life; this.max[i] = life; this.size0[i] = size; this.grow[i] = grow; this.grav[i] = grav;
    this.rot[i] = Math.random() * 6.28; this.spin[i] = (Math.random() - 0.5) * 3;
  }
  step(dt) {
    const k = Math.exp(-this.drag * dt);
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) { if (this.alpha[i] !== 0) this.alpha[i] = 0; continue; }
      this.life[i] -= dt;
      const t = Math.max(0, this.life[i] / this.max[i]), j = i * 3;
      this.vel[j] *= k; this.vel[j + 1] = this.vel[j + 1] * k - this.grav[i] * dt; this.vel[j + 2] *= k;
      this.pos[j] += this.vel[j] * dt; this.pos[j + 1] += this.vel[j + 1] * dt; this.pos[j + 2] += this.vel[j + 2] * dt;
      const u = 1 - t;
      this.col[j] = this.c0[j] + (this.c1[j] - this.c0[j]) * u;
      this.col[j + 1] = this.c0[j + 1] + (this.c1[j + 1] - this.c0[j + 1]) * u;
      this.col[j + 2] = this.c0[j + 2] + (this.c1[j + 2] - this.c0[j + 2]) * u;
      this.alpha[i] = t > 0.8 ? (1 - t) / 0.2 : t / 0.8;
      this.size[i] = this.size0[i] * (1 + u * (this.grow[i] - 1));
      this.rot[i] += this.spin[i] * dt;
    }
    const a = this.pts.geometry.attributes;
    a.position.needsUpdate = a.aColor.needsUpdate = a.aAlpha.needsUpdate = a.aSize.needsUpdate = a.aRot.needsUpdate = true;
  }
}

// ---------- materials ----------
const NOISE = `
float h3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float n3(vec3 x) { vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h3(i), h3(i + vec3(1,0,0)), f.x), mix(h3(i + vec3(0,1,0)), h3(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(h3(i + vec3(0,0,1)), h3(i + vec3(1,0,1)), f.x), mix(h3(i + vec3(0,1,1)), h3(i + vec3(1,1,1)), f.x), f.y), f.z); }
`;
// cel-shaded fire/energy: three flat colour bands, an ink line where it dissolves
function bandMat(cA, cB, cC, o = {}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      cA: { value: new THREE.Color(cA) }, cB: { value: new THREE.Color(cB) }, cC: { value: new THREE.Color(cC) },
      uK: { value: 0 }, uT: U.time, uSeed: { value: Math.random() * 10 }, uScale: { value: o.scale ?? 2.2 }, uInk: { value: o.ink ?? 1 },
      ...fxDepthUniforms(),
    },
    vertexShader: `varying vec3 vN; varying vec3 vV; varying vec3 vP;
      void main(){ vec4 wp = modelMatrix * vec4(position, 1.0); vP = position; vN = normalize(normalMatrix * normal);
        vec4 mv = viewMatrix * wp; vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform vec3 cA; uniform vec3 cB; uniform vec3 cC; uniform float uK; uniform float uT; uniform float uSeed; uniform float uScale; uniform float uInk;
      varying vec3 vN; varying vec3 vV; varying vec3 vP;
      ${NOISE}
      ${FX_DEPTH_PARS}
      void main(){
        float fr = abs(dot(normalize(vN), normalize(vV)));
        float n = n3(vP * uScale + vec3(0.0, -uT * 2.5, uSeed)) * 0.6 + n3(vP * uScale * 2.3 + vec3(uSeed, uT * 1.7, 0.0)) * 0.4;
        float v = fr * 0.75 + n * 0.55 - uK * 1.1;
        if (v < 0.18) discard;
        if (fxDepthFade(0.15) < 0.5) discard;
        vec3 col = v > 0.72 ? cA : v > 0.46 ? cB : cC;
        if (v < 0.24 && uInk > 0.5) col = vec3(0.1, 0.06, 0.05);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
    depthTest: false, depthWrite: false,
  });
}
// flat colour with soft depth, optional additive
function flatMat(color, opacity = 1, additive = false, soft = 0.2) {
  return new THREE.ShaderMaterial({
    uniforms: { uC: { value: new THREE.Color(color) }, uO: { value: opacity }, ...fxDepthUniforms() },
    vertexShader: 'void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform vec3 uC; uniform float uO; ${FX_DEPTH_PARS}
      void main(){ float a = uO * ${soft > 0 ? `fxDepthFade(${soft.toFixed(2)})` : '1.0'}; if (a < 0.01) discard; gl_FragColor = vec4(uC, a);
      #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
}
// a ground circle: ring outline, fill that grows with uP, diagonal stripes
function teleMat(color, opacity = 0.75) {
  return new THREE.ShaderMaterial({
    uniforms: { uC: { value: new THREE.Color(color) }, uO: { value: opacity }, uP: { value: 0 }, uT: U.time, ...fxDepthUniforms() },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform vec3 uC; uniform float uO; uniform float uP; uniform float uT; varying vec2 vUv; ${FX_DEPTH_PARS}
      void main(){
        vec2 q = vUv * 2.0 - 1.0; float r = length(q);
        if (r > 1.0) discard;
        float aa = fwidth(r) * 1.5;
        float ring = smoothstep(0.87 - aa, 0.87, r) * (1.0 - smoothstep(1.0 - aa, 1.0, r));
        float ink = smoothstep(0.83 - aa, 0.83, r) * (1.0 - smoothstep(0.87 - aa, 0.87, r));
        float inside = 1.0 - smoothstep(0.83, 0.83 + aa, r);
        float fill = (1.0 - smoothstep(uP * 0.83 - aa, uP * 0.83, r)) * 0.38;
        float st = step(0.5, fract((q.x + q.y) * 3.0 - uT * 0.8)) * 0.1;
        float a = max(ring, (0.16 + fill + st) * inside);
        vec3 col = mix(uC, vec3(0.08, 0.05, 0.04), ink * 0.85);
        a = max(a, ink * 0.85) * uO * fxDepthFade(0.02);
        if (a < 0.01) discard;
        gl_FragColor = vec4(col, a);
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, depthTest: false,
  });
}
// the shield bubble / recall column: bright rim
function rimMat(color, opacity = 0.8) {
  return new THREE.ShaderMaterial({
    uniforms: { uC: { value: new THREE.Color(color) }, uO: { value: opacity }, uT: U.time, ...fxDepthUniforms() },
    vertexShader: `varying vec3 vN; varying vec3 vV; varying float vY;
      void main(){ vY = position.y; vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform vec3 uC; uniform float uO; uniform float uT; varying vec3 vN; varying vec3 vV; varying float vY; ${FX_DEPTH_PARS}
      void main(){ float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
        float band = step(0.55, f) * 0.85 + 0.15 + step(0.92, fract(vY * 3.0 - uT * 1.5)) * 0.3;
        float a = band * uO * fxDepthFade(0.2); if (a < 0.01) discard; gl_FragColor = vec4(uC, a);
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
}

// ---------- shared geometry ----------
const GEO = {
  sphere: new THREE.IcosahedronGeometry(1, 3),
  ring: new THREE.RingGeometry(0.82, 1, 56),
  disc: new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2),
  cyl: new THREE.CylinderGeometry(1, 1, 1, 24, 1, true),
  cone: new THREE.ConeGeometry(1, 1, 16, 1, true),
  box: new THREE.BoxGeometry(1, 1, 1),
};
GEO.ring.rotateX(-Math.PI / 2);
GEO.cyl.translate(0, 0.5, 0);

function solidGeo(build) { const k = new Kit(); build(k); return k.geo(); }
const SOLID = {
  arrow: () => solidGeo((k) => { k.cyl(0.025, 0.025, 0.9, 5, 0x8a5a2b, 0, 0, 0, Math.PI / 2, 0, 0); k.cone(0.06, 0.18, 5, 0xc8d0da, 0, 0, 0.52, Math.PI / 2, 0, 0); k.box(0.02, 0.1, 0.16, 0xf0ece0, 0, 0.04, -0.38); k.box(0.1, 0.02, 0.16, 0xd04030, 0, 0, -0.38); }),
  dagger: () => solidGeo((k) => { k.box(0.05, 0.12, 0.5, 0xd8e0f0, 0, 0, 0.2); k.box(0.16, 0.04, 0.05, 0xb89a50, 0, 0, -0.06); k.box(0.05, 0.05, 0.18, 0x2a1a10, 0, 0, -0.17); }),
  falcon: () => solidGeo((k) => {
    k.sph(0.16, 0x8a6a4a, 0, 0, 0, 1, 0.9, 1.6); k.sph(0.1, 0xd8c8a8, 0, 0.08, 0.22); k.cone(0.04, 0.1, 4, 0xe2b030, 0, 0.07, 0.34, Math.PI / 2, 0, 0);
    k.box(0.7, 0.04, 0.22, 0x5a4230, 0.38, 0.04, 0, 0, 0, 0.15); k.box(0.7, 0.04, 0.22, 0x5a4230, -0.38, 0.04, 0, 0, 0, -0.15); k.box(0.16, 0.03, 0.24, 0x5a4230, 0, 0, -0.3);
  }),
  rockSpike: () => solidGeo((k) => { k.cone(0.45, 1.3, 5, 0x9a8f80, 0, 0.65, 0); k.rock(0.32, 0x7e7468, 0.3, 0.15, 0.1, 1, 0.7, 1); }),
  meteor: () => solidGeo((k) => { k.rock(1.1, 0x5a4a40, 0, 0, 0, 1, 1, 1); k.rock(0.7, 0x3e332c, 0.5, 0.4, 0.2, 1, 1, 1, 1); }),
  trap: () => solidGeo((k) => { k.cyl(0.45, 0.5, 0.08, 12, 0x5a5048, 0, 0.04, 0); k.tor(0.42, 0.04, Math.PI, 0xa0a8b0, 0, 0.12, 0, Math.PI / 2, 0, 0); k.tor(0.42, 0.04, Math.PI, 0xa0a8b0, 0, 0.12, 0, -Math.PI / 2, 0, 0); for (let i = 0; i < 6; i++) k.cone(0.04, 0.12, 4, 0xd0d8e0, Math.cos(i) * 0.36, 0.2, Math.sin(i) * 0.36); }),
  bigArrow: () => solidGeo((k) => { k.cyl(0.06, 0.06, 2.2, 6, 0xe8f4ff, 0, 0, 0, Math.PI / 2, 0, 0); k.cone(0.2, 0.5, 6, 0xfff07a, 0, 0, 1.3, Math.PI / 2, 0, 0); k.box(0.04, 0.3, 0.4, 0x7ad0ff, 0, 0.12, -1.0); k.box(0.3, 0.04, 0.4, 0x7ad0ff, 0, 0, -1.0); }),
  ball: () => solidGeo((k) => k.sph(0.18, 0x30333a, 0, 0, 0)),
};

// projectile looks
const PROJ = {
  bolt: { orb: [0xfff1a8, 0xffa13a, 0xc8401a], r: 0.22, y: 1.35, trail: 'fire', snd: 'bolt', hit: 'boltHit' },
  arrow: { solid: 'arrow', y: 1.35, trail: 'streak', snd: 'arrow', hit: 'arrowHit' },
  parrow: { solid: 'arrow', s: 1.7, y: 1.25, trail: 'green', snd: 'pierce' },
  mbolt: { orb: 'team', r: 0.15, y: 1.0, trail: 'team', snd: null, hit: null },
  cannon: { solid: 'ball', y: 0.9, arc: 1.2, trail: 'smoke', snd: 'cannon' },
  tshot: { orb: 'teamBig', r: 0.42, y: 6.4, trail: 'team', snd: 'towerShot', hit: 'towerHit' },
  fireball: { orb: [0xfff4c0, 0xffa32e, 0xd63a14], r: 0.5, y: 1.35, trail: 'fireBig', snd: 'fireball' },
  fireballX: { orb: [0xffffff, 0xffd060, 0xff5a1a], r: 0.66, y: 1.35, trail: 'fireBig', snd: 'fireball' },
  fissure: { ground: true, snd: 'quake' },
  dagger: { solid: 'dagger', y: 1.25, spin: true, trail: 'purple', snd: 'throwDagger', hit: 'dagger' },
  falcon: { solid: 'falcon', y: 2.3, flap: true, trail: null, snd: 'falcon' },
  storm: { solid: 'bigArrow', y: 1.5, trail: 'lightning', snd: 'stormArrow' },
};
// palettes for orbs and explosions
const FIRE = [0xfff4c0, 0xffa32e, 0xd63a14];

export class FX {
  constructor(view, sound, hud) {
    this.view = view; this.snd = sound; this.hud = hud;
    this.fs = view.fxScene; this.ms = view.scene;
    this.glow = new Pool(this.fs, 2600, TEX.glow(), true, 1.5);
    this.puff = new Pool(this.fs, 1200, TEX.puff(), false, 1.8);
    this.spark = new Pool(this.fs, 900, TEX.spark(), true, 2.5);
    this.solidGeo = {};
    this.solidMat = comicMat({ vc: true, paint: 0.2, hatch: 0.3, rim: 0.5 });
    this.effects = [];
    this.proj = new Map();
    this.zones = new Map();
    this.timers = [];
    this.status = new Map();     // entity id -> status markers
    this.solids = new Set();     // outlined effect meshes in the main scene
    this.me = null;              // my hero entity id
    this.myTeam = 0;
    this.world = null;
    this.ind = this.makeIndicators();
    this.markers = [];
    this.emberT = 0;
  }
  setPlayer(heroId, team) { this.me = heroId; this.myTeam = team; }
  geo(name) { return (this.solidGeo[name] ||= SOLID[name]()); }
  solid(name, scale = 1) {
    const m = new THREE.Mesh(this.geo(name), this.solidMat);
    m.castShadow = true;
    m.scale.setScalar(scale);
    this.ms.add(m);
    this.solids.add(m);
    m.addEventListener('removed', () => this.solids.delete(m));
    return m;
  }
  // forget everything (a match ended)
  clear() {
    for (const p of this.proj.values()) p.obj?.parent?.remove(p.obj);
    for (const z of this.zones.values()) for (const o of z.objs) o.parent?.remove(o);
    for (const st of this.status.values()) for (const k in st) st[k]?.parent?.remove(st[k]);
    for (const ef of this.effects) ef.obj?.parent?.remove(ef.obj);
    for (const m of [...this.solids]) m.parent?.remove(m);
    this.proj.clear(); this.zones.clear(); this.status.clear(); this.solids.clear();
    this.effects = []; this.timers = [];
    for (const p of [this.glow, this.puff, this.spark]) { p.life.fill(0); p.alpha.fill(0); p.pts.geometry.attributes.aAlpha.needsUpdate = true; }
    this.showIndicator(null);
  }
  later(t, fn) { this.timers.push({ t, fn }); }
  add(obj, dur, upd, scene = this.fs) {
    if (obj) scene.add(obj);
    this.effects.push({ obj, t: 0, dur, upd, scene });
  }
  // sound with distance falloff from the camera
  play(kind, x, z, k = 1) {
    if (!kind) return;
    const c = this.view.cam, d = Math.hypot(x - c.x, (z - c.z) * 1.4);
    const v = clamp(1.25 - d / 26, 0, 1) * k;
    this.snd.play(kind, v, clamp((x - c.x) / 18, -1, 1));
  }
  pos(id) {
    const e = this.world && this.world.get(id);
    return e ? e : null;
  }
  unitY(e, f = 0.6) {
    const v = this.view.vis.get(e.id);
    const h = v ? v.h : 2;
    return groundHeight(e.x, e.z) + h * f + (v && v.rig && v.rig.parts ? v.rig.parts.body.position.y : 0);
  }
  teamCol(team) { return team === 2 ? 0xffd34a : TEAMS[team].hex; }
  word(text, x, y, z, col, size = 1) { this.hud.word(text, x, y, z, col, size); }

  // ============================================================
  //  Events
  // ============================================================
  handle(e) {
    switch (e.k) {
      case 'atk': this.onAtk(e); break;
      case 'cast': this.onCast(e); break;
      case 'pr': this.spawnProj(e); break;
      case 'px': this.endProj(e); break;
      case 'zone': this.spawnZone(e); break;
      case 'zx': this.endZone(e); break;
      case 'fx': this.onFx(e); break;
      case 'hit': this.onHitEv(e); break;
      case 'mh': { this.view.onHit(e.i); const u = this.pos(e.i); if (u) this.play('minionHit', u.x, u.z, 0.35); break; }
      case 'die': this.onDie(e); break;
      case 'cc': {
        if (e.c === 1) this.view.onAir(e.i, e.t);
        const u = this.pos(e.i);
        if (u && (u.kind === K.HERO || u.kind === K.CLONE)) this.play('stun', u.x, u.z, 0.6);
        break;
      }
      case 'leap': this.view.onLeap(e.i, e.d); { const u = this.pos(e.i); if (u) { this.play('leap', u.x, u.z); this.dust(u.x, u.z, 1.2, 10); } } break;
      case 'dash': this.onDash(e); break;
      case 'blink': this.onBlink(e); break;
      case 'lvl': this.onLevel(e); break;
      case 'spawn': { const u = this.pos(e.i); if (u) { this.column(u.x, u.z, this.teamCol(u.team), 0.9, 3.2); this.play('respawn', u.x, u.z, 0.8); } break; }
      case 'rc': this.onRecall(e); break;
      case 'relic': {
        const i = RELICS.findIndex((r) => Math.abs(r.x - e.x) < 0.1 && Math.abs(r.z - e.z) < 0.1);
        this.view.setRelic(i, !!e.on);
        if (!e.on) { this.burst(e.x, 1, e.z, 0x8affa0, 18, 3); this.play('relic', e.x, e.z); }
        break;
      }
      case 'pot': { const u = this.pos(e.i); if (u) this.play('potion', u.x, u.z, e.i === this.me ? 1 : 0.4); break; }
      case 'ann': {
        // a tower or a crystal comes down: debris, smoke, crystal shards in the team colour
        if (e.a !== 'tower' && e.a !== 'nexus') break;
        const u = this.pos(e.i);
        if (!u) break;
        const big = e.a === 'nexus', col = this.teamCol(u.team);
        this.explosion(u.x, big ? 3 : 4, u.z, big ? 4.5 : 2.6, [0xffffff, col, _c.set(col).multiplyScalar(0.45).getHex()]);
        this.slamFx(u.x, u.z, big ? 5 : 3);
        for (let i = 0; i < (big ? 60 : 30); i++) {
          const a = Math.random() * 6.28, sp = rnd(3, big ? 11 : 7);
          this.spark.emit(u.x, big ? 4 : 5.5, u.z, Math.cos(a) * sp, rnd(3, 9), Math.sin(a) * sp, rnd(0.6, 1.1), rnd(0.35, 0.7), 0xffffff, col, 0.6, 9);
        }
        for (let i = 0; i < (big ? 24 : 12); i++) this.puff.emit(u.x + rnd(-2, 2), rnd(1, 4), u.z + rnd(-2, 2), rnd(-1.5, 1.5), rnd(1, 3), rnd(-1.5, 1.5), rnd(1.4, 2.4), rnd(1.4, 2.6), 0x8a7e70, 0x4a4038, 1.6, -0.3);
        this.word(big ? 'KRAAACS!' : 'DÜBÖRR!', u.x, big ? 6 : 7.5, u.z, big ? 0xffffff : 0xe8d8b0, big ? 2 : 1.4);
        this.view.shake(big ? 1.2 : 0.6);
        break;
      }
      default: break;
    }
  }

  onAtk(e) {
    const s = this.pos(e.s);
    this.view.onAttack(e.s, e.w);
    if (!s) return;
    if (s.kind === K.HERO) {
      const def = HEROES[s.sub];
      if (!def.attack.proj) this.later(e.w, () => { const t = this.pos(e.t); if (t) { this.play(def.attack.sound, t.x, t.z, 0.8); this.slash(t, def.id === 'granit' ? 0xdfe8f0 : 0xd8c8ff, def.id === 'granit' ? 1.3 : 0.9); } });
    } else if (s.kind === K.MINION && s.sub === 0) {
      this.later(e.w, () => { const t = this.pos(e.t); if (t) this.play('minionHit', t.x, t.z, 0.5); });
    } else if (s.kind === K.BOSS) {
      this.later(e.w, () => { const t = this.pos(e.t); if (t) { this.play('blunt', t.x, t.z); this.dust(t.x, t.z, 1, 8); } });
    }
  }

  onHitEv(e) {
    this.view.onHit(e.i);
    const u = this.pos(e.i);
    if (!u) return;
    this.hud.damage(e, u, this.me, this.myTeam);
    if (e.c) { this.play('crit', u.x, u.z, 0.8); this.word('KRITT!', u.x, this.unitY(u, 1.1), u.z, 0xffe14a, 0.9); }
  }
  onDie(e) {
    const u = this.view.vis.get(e.i);
    if (u && u.e) {
      const x = u.e.x, z = u.e.z;
      this.puffs(x, 0.6, z, 0xd8ccb8, 6, 0.9);
      this.play('minionDie', x, z, 0.6);
      if (e.by === this.me && e.g > 0) { this.hud.gold(e.g, x, this.unitY(u.e, 1), z); this.play('gold', x, z, 0.7); }
    }
  }
  onDash(e) {
    const u = this.pos(e.i);
    if (!u) return;
    const snd = e.a === 1 ? 'charge' : e.a === 2 ? 'roll' : null;
    if (snd) this.play(snd, u.x, u.z);
    // speed streaks along the way
    const x0 = u.x, z0 = u.z, dx = e.x - x0, dz = e.z - z0;
    for (let i = 0; i < 10; i++) {
      const t = i / 10;
      this.puff.emit(x0 + dx * t, 0.2, z0 + dz * t, rnd(-0.4, 0.4), rnd(0.3, 0.8), rnd(-0.4, 0.4), 0.6, 0.7, 0xe0d4bc, 0xc8b89c, 1.8, 0.3);
    }
  }
  onBlink(e) {
    const u = this.pos(e.i), team = u ? u.team : 0;
    const col = u && u.kind === K.HERO && HEROES[u.sub].id === 'parazs' ? 0xffa23a : 0xb48cff;
    this.burst(e.fx, 1.1, e.fz, col, 22, 3.5);
    this.burst(e.x, 1.1, e.z, col, 22, 3.5);
    this.ringFx(e.x, e.z, 1.6, col, 0.35);
    const s = u && HEROES[u.sub] && HEROES[u.sub].id === 'arny' ? 'shadowStep' : 'blink';
    this.play(s, e.x, e.z);
    void team;
  }
  onLevel(e) {
    const u = this.pos(e.i);
    if (!u) return;
    this.column(u.x, u.z, 0xffe07a, 0.8, 2.6);
    this.burst(u.x, 1, u.z, 0xffe07a, 20, 3);
    if (e.i === this.me) { this.snd.play('levelUp', 1); this.word('SZINT!', u.x, this.unitY(u, 1.2), u.z, 0xffe14a, 1.1); }
  }
  onRecall(e) {
    const u = this.pos(e.i);
    if (!u) return;
    if (e.s === 1) {
      this.play('recall', u.x, u.z, e.i === this.me ? 1 : 0.6);
      const col = this.teamCol(u.team);
      const m = new THREE.Mesh(GEO.cyl, rimMat(col, 0.65));
      m.renderOrder = 4;
      const id = e.i;
      this.add(m, e.t, (k) => {
        const p = this.pos(id);
        if (!p || !(p.flags & F.RECALL)) return false;
        m.position.set(p.x, groundHeight(p.x, p.z), p.z);
        m.scale.set(0.9, 3.2 * Math.min(1, k * 3), 0.9);
        if (Math.random() < 0.6) this.glow.emit(p.x + rnd(-0.6, 0.6), 0.2, p.z + rnd(-0.6, 0.6), 0, rnd(1.5, 3), 0, 0.8, 0.35, col, 0xffffff);
        return true;
      });
    } else if (e.s === 0) { if (this.snd.stop) this.snd.stop('recall'); }
    else if (e.s === 2) { this.play('recallDone', u.x, u.z); this.column(u.x, u.z, this.teamCol(u.team), 0.6, 4); }
  }

  // ---------- casts ----------
  onCast(e) {
    const s = this.pos(e.s);
    this.view.onCast(e.s, e.sl, e.w);
    if (!s) return;
    if (s.kind === K.BOSS) { this.play('bossRoar', s.x, s.z); return; }
    if (s.kind !== K.HERO) return;
    const id = HEROES[s.sub].id, sl = e.sl;
    const snd = {
      granit: [null, null, 'shield', 'taunt', 'spin', null],
      parazs: [null, null, null, null, 'breath', null],
      solyom: [null, null, null, 'trapSet', null, 'stormCharge'],
      arny: [null, 'smoke', null, 'blades', 'clone', 'moonDance'],
    }[id][sl];
    if (snd) this.play(snd, s.x, s.z);
    // hands light up while casting
    if (e.w > 0.05) {
      const col = { granit: 0xc8d8f0, parazs: 0xffa23a, solyom: 0x9fe870, arny: 0xb48cff }[id];
      const sid = e.s;
      this.add(null, e.w, () => {
        const v = this.view.vis.get(sid);
        if (!v || !v.rig) return false;
        const p = v.rig.parts.handR.getWorldPosition(this._v1 ||= new THREE.Vector3());
        this.glow.emit(p.x, p.y, p.z, rnd(-0.5, 0.5), rnd(0.2, 1), rnd(-0.5, 0.5), 0.35, 0.35, col, 0xffffff);
        return true;
      });
    }
    if (id === 'solyom' && sl === 5) this.word('VIHAR!', s.x, this.unitY(s, 1.3), s.z, 0x7ad0ff, 1);
    if (id === 'granit' && sl === 3) this.word('IDE!', s.x, this.unitY(s, 1.3), s.z, 0xff5a3a, 1.1);
  }

  // ---------- projectiles ----------
  spawnProj(e) {
    const P = PROJ[e.p];
    if (!P) return;
    const src = this.pos(e.s);
    const team = src ? src.team : 0;
    const p = { id: e.id, kind: e.p, P, x: e.x, z: e.z, y: P.y, dx: e.dx || 0, dz: e.dz || 0, sp: e.sp, rng: e.r || 0, trav: 0, t: e.t || 0, team, age: 0, crit: !!e.c };
    if (e.p === 'tshot' && src) { const v = this.view.vis.get(e.s); p.y = v && v.tower ? 6.2 * v.root.scale.y : 6.2; }
    if (P.orb) {
      const pal = P.orb === 'team' || P.orb === 'teamBig' ? [0xffffff, this.teamCol(team), _c.set(this.teamCol(team)).multiplyScalar(0.5).getHex()] : P.orb;
      p.obj = new THREE.Mesh(GEO.sphere, bandMat(pal[0], pal[1], pal[2]));
      p.obj.scale.setScalar(P.r);
      p.obj.renderOrder = 5;
      this.fs.add(p.obj);
      p.pal = pal;
    } else if (P.solid) {
      p.obj = this.solid(P.solid, P.s || (p.crit ? 1.4 : 1));
    }
    if (P.ground) p.spikes = [];
    this.proj.set(e.id, p);
    if (P.snd && src) this.play(P.snd, e.x, e.z, e.p === 'arrow' || e.p === 'bolt' ? 0.7 : 1);
  }
  endProj(e) {
    const p = this.proj.get(e.id);
    if (!p) return;
    this.proj.delete(e.id);
    if (p.obj) { p.obj.parent?.remove(p.obj); if (p.obj.material !== this.solidMat) p.obj.material.dispose(); }
    const y = p.y;
    if (p.P.hit && e.h) this.play(p.P.hit, e.x, e.z, 0.7);
    switch (p.kind) {
      case 'bolt': this.burst(e.x, y, e.z, 0xffa23a, 8, 2.2); break;
      case 'mbolt': this.burst(e.x, 1, e.z, this.teamCol(p.team), 5, 1.6); break;
      case 'tshot': this.burst(e.x, 1.2, e.z, this.teamCol(p.team), 14, 3); this.spark.emit(e.x, 1.3, e.z, 0, 0, 0, 0.25, 1.6, 0xffffff, this.teamCol(p.team)); break;
      case 'cannon': this.puffs(e.x, 0.8, e.z, 0x9a8f80, 5, 0.8); break;
      case 'arrow': case 'parrow': if (e.h) this.spark.emit(e.x, 1.2, e.z, 0, 0, 0, 0.18, 0.8, 0xffffff, 0xffe080); break;
      case 'dagger': if (e.h) { this.burst(e.x, 1.2, e.z, 0xb48cff, 10, 2.5); this.play('melee', e.x, e.z, 0.7); } break;
      case 'falcon': if (e.h) { this.burst(e.x, 1.4, e.z, 0x9fe870, 14, 3); this.play('falcon', e.x, e.z, 0.6); } break;
      case 'storm': this.burst(e.x, 1.4, e.z, 0x7ad0ff, 24, 5); break;
      default: break;
    }
  }
  updateProj(dt) {
    for (const p of this.proj.values()) {
      p.age += dt;
      let tx, tz, ty;
      if (p.t) {
        const t = this.pos(p.t);
        if (t) { tx = t.x; tz = t.z; ty = this.unitY(t, 0.55); p.lastT = { x: tx, z: tz, y: ty }; }
        else if (p.lastT) { tx = p.lastT.x; tz = p.lastT.z; ty = p.lastT.y; }
        else { tx = p.x; tz = p.z; ty = p.y; }
        const dx = tx - p.x, dz = tz - p.z, d = Math.hypot(dx, dz), s = p.sp * dt;
        if (d > 0.01) {
          const k = Math.min(1, s / d);
          p.x += dx * k; p.z += dz * k;
          p.y += (ty - p.y) * Math.min(1, s / Math.max(d, 0.3));
          p.dx = dx / d; p.dz = dz / d;
        }
      } else {
        const s = Math.min(p.sp * dt, Math.max(0, p.rng - p.trav));
        p.x += p.dx * s; p.z += p.dz * s; p.trav += s;
      }
      let y = p.y;
      if (p.P.arc && p.t) y += Math.sin(Math.min(1, p.age * 1.5) * Math.PI) * p.P.arc;
      if (p.obj) {
        p.obj.position.set(p.x, y, p.z);
        const yaw = Math.atan2(p.dx, p.dz);
        if (p.P.spin) { p.obj.rotation.set(p.age * 18, yaw, 0, 'YXZ'); }
        else if (p.P.flap) { p.obj.rotation.set(0, yaw, Math.sin(p.age * 18) * 0.25); p.obj.scale.set(1, 1 + Math.sin(p.age * 18) * 0.2, 1); }
        else if (p.P.solid) p.obj.rotation.set(0, yaw, 0);
        else p.obj.rotation.y += dt * 6;
      }
      this.trail(p, y, dt);
      if (p.P.ground) this.fissureStep(p, dt);
    }
  }
  trail(p, y, dt) {
    switch (p.P.trail) {
      case 'fire': this.glow.emit(p.x, y, p.z, rnd(-0.3, 0.3), rnd(0, 0.5), rnd(-0.3, 0.3), 0.3, 0.45, 0xffd070, 0xc83010); break;
      case 'fireBig':
        for (let i = 0; i < 2; i++) this.glow.emit(p.x + rnd(-0.2, 0.2), y + rnd(-0.2, 0.2), p.z + rnd(-0.2, 0.2), rnd(-0.6, 0.6), rnd(0.2, 1.2), rnd(-0.6, 0.6), 0.3, p.kind === 'fireballX' ? 0.8 : 0.6, 0xffd070, 0xd02810, 1.3, -1.5);
        if (Math.random() < 0.4) this.puff.emit(p.x, y + 0.2, p.z, rnd(-0.3, 0.3), rnd(0.6, 1.2), rnd(-0.3, 0.3), 0.8, 0.55, 0x4a3a34, 0x2a2220, 1.8, -0.5);
        break;
      case 'streak': this.glow.emit(p.x, y, p.z, 0, 0, 0, 0.12, 0.18, 0xffffff, 0xd0d8ff); break;
      case 'green': this.glow.emit(p.x, y, p.z, rnd(-0.2, 0.2), rnd(-0.2, 0.2), rnd(-0.2, 0.2), 0.3, 0.42, 0xd8ff9a, 0x4aa02a); break;
      case 'purple': this.glow.emit(p.x, y, p.z, 0, 0, 0, 0.25, 0.32, 0xd8b8ff, 0x6a3ac8); break;
      case 'team': this.glow.emit(p.x, y, p.z, 0, 0, 0, 0.25, p.kind === 'tshot' ? 0.7 : 0.3, 0xffffff, this.teamCol(p.team)); break;
      case 'smoke': if (Math.random() < 0.5) this.puff.emit(p.x, y, p.z, 0, 0.3, 0, 0.5, 0.3, 0x8a8478, 0x5a564e, 1.5); break;
      case 'lightning':
        this.glow.emit(p.x, y, p.z, rnd(-1, 1), rnd(-1, 1), rnd(-1, 1), 0.35, 0.9, 0xeaf8ff, 0x3a8aff);
        if (Math.random() < 0.6) this.spark.emit(p.x + rnd(-0.5, 0.5), y + rnd(-0.4, 0.4), p.z + rnd(-0.5, 0.5), 0, 0, 0, 0.15, 0.6, 0xfff07a, 0x7ad0ff);
        break;
      default: break;
    }
  }
  // Granit's fissure: rock spikes burst out of the ground behind the wave front
  fissureStep(p, dt) {
    p.acc = (p.acc || 0) + dt;
    while (p.acc > 0.035) {
      p.acc -= 0.035;
      const side = (Math.random() - 0.5) * 1.1;
      const x = p.x - p.dz * side, z = p.z + p.dx * side;
      const m = this.solid('rockSpike', rnd(0.55, 0.95));
      m.rotation.set(rnd(-0.25, 0.25), rnd(0, 6), rnd(-0.25, 0.25));
      const gy = groundHeight(x, z);
      m.position.set(x, gy - 1.4, z);
      this.add(null, 1.0, (k) => {
        const up = k < 0.15 ? ease(k / 0.15) : k > 0.65 ? 1 - ease((k - 0.65) / 0.35) : 1;
        m.position.y = gy - 1.4 + up * 1.3;
        if (k >= 1) this.ms.remove(m);
        return true;
      }, null);
      this.puff.emit(x, 0.3, z, rnd(-1, 1), rnd(0.8, 1.6), rnd(-1, 1), 0.7, 0.7, 0xd8c8a8, 0xa89878, 1.6, 2);
    }
  }

  // ---------- zones ----------
  spawnZone(e) {
    const z = { id: e.id, kind: e.z, x: e.x, z: e.z2, r: e.r, ux: e.ux, uz: e.uz, hl: e.hl, hw: e.hw, d: e.d, team: e.tm, src: e.s, hidden: !!e.hd, t: 0, objs: [] };
    const enemy = z.team !== this.myTeam;
    const gy = groundHeight(z.x, z.z) + 0.1;
    const tele = (col) => { const m = new THREE.Mesh(GEO.disc, teleMat(col, 1)); m.scale.set(z.r, 1, z.r); m.position.set(z.x, gy, z.z); m.renderOrder = 1; this.fs.add(m); z.objs.push(m); z.tele = m; };
    switch (z.kind) {
      case 'tele': case 'ringTele': tele(enemy ? 0xff5a2a : 0xffa23a); break;
      case 'meteorTele': tele(enemy ? 0xff3a1a : 0xff8a2a); break;
      case 'rainTele': tele(enemy ? 0xff5a3a : 0x9fe870); break;
      case 'leapTele': tele(enemy ? 0xff5a3a : 0xc8d8f0); break;
      case 'bossTele': tele(0xff3a2a); this.play('bossRoar', z.x, z.z, 0.8); break;
      case 'flameWall': {
        this.play('flameWall', z.x, z.z);
        z.flames = [];
        const n = Math.max(4, Math.round(z.hl * 2 * 1.6));
        for (let i = 0; i < n; i++) {
          const t = (i + 0.5) / n * 2 - 1;
          const m = new THREE.Mesh(GEO.cone, bandMat(0xfff0a0, 0xff9a2a, 0xd8341a, { scale: 1.6 }));
          const x = z.x + z.ux * z.hl * t, zz = z.z + z.uz * z.hl * t;
          m.position.set(x, groundHeight(x, zz) + 0.75, zz);
          m.scale.set(0.55, 1.6, 0.55);
          m.renderOrder = 5;
          this.fs.add(m); z.objs.push(m); z.flames.push(m);
        }
        break;
      }
      case 'smoke': {
        this.play('smoke', z.x, z.z);
        // a few big comic clouds that sit there for the whole duration, plus wisps
        for (let i = 0; i < 9; i++) {
          const a = (i / 9) * 6.28 + Math.random() * 0.5, r = i === 0 ? 0 : z.r * rnd(0.35, 0.75);
          this.puff.emit(z.x + Math.cos(a) * r, rnd(0.5, 1.3), z.z + Math.sin(a) * r, 0, rnd(0.02, 0.1), 0, z.d + rnd(-0.2, 0.3), rnd(1.6, 2.3), z.team === this.myTeam ? 0xcfc6e0 : 0xbdb2cc, 0x9a90b0, 1.15);
        }
        break;
      }
      case 'trap': {
        const m = this.solid('trap', 1);
        m.position.set(z.x, groundHeight(z.x, z.z) + 0.02, z.z);
        z.objs.push(m); z.trap = m;
        break;
      }
      case 'quake': {
        const m = new THREE.Mesh(GEO.disc, teleMat(0x8a7a64, 0.55));
        m.scale.set(z.r, 1, z.r); m.position.set(z.x, gy, z.z); m.material.uniforms.uP.value = 1;
        this.fs.add(m); z.objs.push(m);
        break;
      }
      case 'burnGround': {
        const m = new THREE.Mesh(GEO.disc, teleMat(0x3a1a10, 0.6));
        m.scale.set(z.r, 1, z.r); m.position.set(z.x, gy, z.z); m.material.uniforms.uP.value = 1;
        this.fs.add(m); z.objs.push(m);
        break;
      }
      default: break;
    }
    this.zones.set(z.id, z);
  }
  endZone(e) {
    const z = this.zones.get(e.id);
    if (!z) return;
    this.zones.delete(e.id);
    for (const o of z.objs) { o.parent?.remove(o); if (o.material && o.material !== this.solidMat) o.material.dispose(); }
    if (z.kind === 'trap' && e.tr) {
      this.play('trapSnap', z.x, z.z);
      this.word('CSATT!', z.x, 1.8, z.z, 0xd0d8e0, 1);
      this.spark.emit(z.x, 0.5, z.z, 0, 0, 0, 0.25, 1.8, 0xffffff, 0xc8d0da);
      const m = this.solid('trap', 1);
      m.position.set(z.x, groundHeight(z.x, z.z), z.z);
      this.add(null, 1.8, (k) => { m.scale.set(1, 1 + Math.sin(k * 40) * 0.1 * (1 - k), 1); if (k >= 1) this.ms.remove(m); return true; }, null);
    }
  }
  updateZones(dt) {
    for (const z of this.zones.values()) {
      z.t += dt;
      const k = z.d > 0 ? z.t / z.d : 1;
      if (z.tele) z.tele.material.uniforms.uP.value = Math.min(1, k);
      switch (z.kind) {
        case 'flameWall':
          for (const m of z.flames) m.scale.y = 1.4 + Math.sin(U.time.value * 9 + m.position.x * 3) * 0.3;
          for (let i = 0; i < 2; i++) {
            const t = Math.random() * 2 - 1, x = z.x + z.ux * z.hl * t, zz = z.z + z.uz * z.hl * t;
            this.glow.emit(x, 0.4, zz, rnd(-0.3, 0.3), rnd(2, 4), rnd(-0.3, 0.3), 0.6, 0.6, 0xffd070, 0xc02810, 1.4);
          }
          if (Math.random() < 0.3) { const t = Math.random() * 2 - 1; this.puff.emit(z.x + z.ux * z.hl * t, 1.8, z.z + z.uz * z.hl * t, 0, 1.2, 0, 1.0, 0.7, 0x4a3a34, 0x221a18, 2, -0.3); }
          break;
        case 'smoke': if (Math.random() < 0.12) this.smokePuff(z, false); break;
        case 'trap': {
          // the owner's team always sees it; the enemy only while it is arming
          const vis = z.team === this.myTeam || z.t < 0.8;
          z.trap.visible = vis;
          if (z.t < 0.8) z.trap.scale.setScalar(0.6 + 0.4 * ease(z.t / 0.8));
          break;
        }
        case 'quake': if (Math.random() < 0.35) { const a = Math.random() * 6.28, r = Math.sqrt(Math.random()) * z.r; this.puff.emit(z.x + Math.cos(a) * r, 0.2, z.z + Math.sin(a) * r, 0, rnd(0.5, 1.2), 0, 0.6, 0.5, 0xc8b898, 0x9a8a70, 1.6); } break;
        case 'burnGround':
          for (let i = 0; i < 2; i++) { const a = Math.random() * 6.28, r = Math.sqrt(Math.random()) * z.r; this.glow.emit(z.x + Math.cos(a) * r, 0.2, z.z + Math.sin(a) * r, 0, rnd(1, 2.5), 0, 0.5, 0.55, 0xffd070, 0xc02810, 1.2); }
          break;
        default: break;
      }
    }
  }
  smokePuff(z, first) {
    const a = Math.random() * 6.28, r = Math.sqrt(Math.random()) * z.r * 0.95;
    const enemy = z.team !== this.myTeam;
    this.puff.emit(z.x + Math.cos(a) * r, rnd(0.3, 1.6), z.z + Math.sin(a) * r, rnd(-0.3, 0.3), rnd(0.05, 0.3), rnd(-0.3, 0.3), first ? rnd(1.4, 2.2) : rnd(1.0, 1.4), rnd(0.8, 1.2), enemy ? 0xbdb2cc : 0xcfc6e0, 0x8a80a0, 1.3);
  }

  // ---------- generic effect events ----------
  onFx(e) {
    const s = this.view;
    switch (e.f) {
      case 'boom': this.explosion(e.x, 1.0, e.z, e.r, FIRE); this.play('explode', e.x, e.z); if (e.r > 2) this.word('BUMM!', e.x, 2.4, e.z, 0xffb030, 1); break;
      case 'fizzle': this.puffs(e.x, 1.2, e.z, 0x6a5a50, 4, 0.8); this.burst(e.x, 1.2, e.z, 0xffa23a, 6, 1.5); break;
      case 'bash': this.spark.emit(e.x, 1.3, e.z, 0, 0, 0, 0.3, 2.6, 0xffffff, 0xc8d8f0); this.play('charge', e.x, e.z); this.word('BAMM!', e.x, 2.6, e.z, 0xffffff, 1.1); s.shake(0.3); break;
      case 'slam': this.slamFx(e.x, e.z, e.r); this.play('slam', e.x, e.z); this.word('KRAKK!', e.x, 3, e.z, 0xe8d8b0, 1.5); s.shake(0.9); break;
      case 'quakeHit': this.ringFx(e.x, e.z, 1.6, 0xe8c070, 0.3); this.dust(e.x, e.z, 0.8, 6); this.play('blunt', e.x, e.z, 0.6); break;
      case 'roar': { const u = this.pos(e.i); if (u) { this.ringFx(u.x, u.z, e.r, 0xff5a3a, 0.45, 0.3); this.ringFx(u.x, u.z, e.r * 0.7, 0xff8a5a, 0.35, 0.2); } break; }
      case 'shield': {
        const u = this.pos(e.i);
        if (u) {
          if (e.tg) { this.play('stoneSkin', u.x, u.z, 0.5); this.burst(u.x, 1, u.z, 0xd8c8a8, 8, 2); } else { this.play('shield', u.x, u.z); this.burst(u.x, 1.1, u.z, 0xc8e8ff, 14, 2.5); }
        }
        break;
      }
      case 'heal': { const u = this.pos(e.i); if (u) { this.burst(u.x, 1, u.z, 0x8affa0, 12, 2); this.play('heal', u.x, u.z, 0.6); } break; }
      case 'erupt': this.erupt(e.x, e.z, e.r); this.play('stunRing', e.x, e.z); this.word('FUSS!', e.x, 2.5, e.z, 0xffa23a, 1); break;
      case 'breath': this.breath(e); break;
      case 'meteor': this.meteor(e); break;
      case 'impact': this.explosion(e.x, 0.6, e.z, e.r * 1.1, FIRE); this.slamFx(e.x, e.z, e.r); this.play('meteorImpact', e.x, e.z); this.word('KABUMM!', e.x, 3.2, e.z, 0xff7a2a, 1.6); s.shake(1.1); break;
      case 'overheat': { const u = this.pos(e.i); if (u) { this.burst(u.x, 1.6, u.z, 0xffa23a, 20, 3.5); this.play('overheat', u.x, u.z); } break; }
      case 'arrowRain': this.arrowRain(e); this.play('arrowRain', e.x, e.z); break;
      case 'pierce': this.line(e.x, 1.3, e.z, e.x2, 1.3, e.z2, 0xffffff, 0.2, 0.08); break;
      case 'stormHit': this.burst(e.x, 1.4, e.z, 0x7ad0ff, 30, 6); this.play('stormHit', e.x, e.z); this.word('ZZZAPP!', e.x, 3, e.z, 0x7ad0ff, 1.5); s.shake(0.6); break;
      case 'markPop': { const u = this.pos(e.i); if (u) { this.burst(u.x, 1.5, u.z, 0xb48cff, 14, 3); this.play('mark', u.x, u.z); } break; }
      case 'blades': { const u = this.pos(e.i); if (u) { this.ringFx(u.x, u.z, e.r, 0xd8c8ff, 0.3, 0.12); for (let i = 0; i < 3; i++) this.later(i * 0.06, () => this.slashRing(u.x, u.z, e.r * (0.7 + i * 0.15))); } break; }
      case 'clone': { const u = this.pos(e.i); if (u) { this.puffs(u.x, 1, u.z, 0x5a4a78, 10, 1.2); } break; }
      case 'puff': this.puffs(e.x, 1, e.z, 0x5a4a78, 10, 1.2); this.play('clone', e.x, e.z, 0.6); break;
      case 'moonStrike': {
        const t = this.pos(e.i);
        if (t) {
          this.slash(t, 0xe8d8ff, 1.5);
          this.burst(t.x, 1.3, t.z, 0xb48cff, 8, 3);
          if (e.n === 4) { this.word('SZUSS!', t.x, this.unitY(t, 1.2), t.z, 0xd8b8ff, 1.4); s.shake(0.4); }
        }
        break;
      }
      case 'reset': { const u = this.pos(e.i); if (u) { this.burst(u.x, 1.4, u.z, 0xd8b8ff, 24, 4); this.play('reset', u.x, u.z); } break; }
      case 'chain': this.chain(e.p); this.play('stormHit', this.pos(e.p[0])?.x ?? 0, this.pos(e.p[0])?.z ?? 0, 0.4); break;
      case 'zap': { const u = this.pos(e.i); if (u) { this.line(e.x, 3, e.z, u.x, 1.2, u.z, 0xfff07a, 0.25, 0.18); this.play('fountainZap', u.x, u.z, 0.8); } break; }
      case 'bossSlam': this.slamFx(e.x, e.z, e.r); this.play('bossSlam', e.x, e.z); this.word('DÖRR!', e.x, 3.4, e.z, 0xb0e8e0, 1.5); s.shake(0.8); break;
      default: break;
    }
  }

  // ============================================================
  //  Effect building blocks
  // ============================================================
  burst(x, y, z, col, n, speed) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.28, b = rnd(-0.3, 1);
      this.glow.emit(x, y, z, Math.cos(a) * speed * rnd(0.3, 1), b * speed * 0.8, Math.sin(a) * speed * rnd(0.3, 1), rnd(0.3, 0.6), rnd(0.25, 0.5), 0xffffff, col, 0.6, 2);
    }
  }
  puffs(x, y, z, col, n, size) {
    for (let i = 0; i < n; i++) this.puff.emit(x + rnd(-0.4, 0.4), y + rnd(-0.2, 0.3), z + rnd(-0.4, 0.4), rnd(-1, 1), rnd(0.3, 1.2), rnd(-1, 1), rnd(0.5, 0.9), size * rnd(0.6, 1.1), col, col, 1.7, -0.3);
  }
  dust(x, z, r, n) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.28;
      this.puff.emit(x + Math.cos(a) * r * 0.5, 0.25, z + Math.sin(a) * r * 0.5, Math.cos(a) * rnd(1, 3), rnd(0.4, 1.4), Math.sin(a) * rnd(1, 3), rnd(0.5, 0.9), rnd(0.6, 1.0), 0xe0d0b0, 0xb8a888, 1.8, 1.5);
    }
  }
  ringFx(x, z, r, col, dur, width = 0.18) {
    const m = new THREE.Mesh(GEO.ring, flatMat(col, 0.9, true, 0.02));
    m.position.set(x, groundHeight(x, z) + 0.12, z);
    m.renderOrder = 4;
    this.add(m, dur, (k) => { const s = r * (0.3 + 0.7 * ease(k)); m.scale.set(s, 1, s); m.material.uniforms.uO.value = 0.9 * (1 - k); return true; });
    void width;
  }
  column(x, z, col, dur, h) {
    const m = new THREE.Mesh(GEO.cyl, rimMat(col, 0.8));
    m.position.set(x, groundHeight(x, z), z);
    m.renderOrder = 4;
    this.add(m, dur, (k) => { m.scale.set(0.8 + k * 0.4, h * (1 - k * 0.3), 0.8 + k * 0.4); m.material.uniforms.uO.value = 0.8 * (1 - k); return true; });
    for (let i = 0; i < 16; i++) this.glow.emit(x + rnd(-0.6, 0.6), 0.2, z + rnd(-0.6, 0.6), 0, rnd(2, 5), 0, 0.7, 0.4, 0xffffff, col);
  }
  explosion(x, y, z, r, pal) {
    const m = new THREE.Mesh(GEO.sphere, bandMat(pal[0], pal[1], pal[2], { scale: 1.4 }));
    m.position.set(x, y, z);
    m.renderOrder = 6;
    this.add(m, 0.55, (k) => {
      const s = r * (0.35 + 0.75 * ease(Math.min(1, k * 2.2)));
      m.scale.set(s, s * 0.85, s);
      m.material.uniforms.uK.value = Math.max(0, k - 0.25) * 1.3;
      return true;
    });
    this.ringFx(x, z, r * 1.25, pal[1], 0.4);
    for (let i = 0; i < 10 + r * 6; i++) {
      const a = Math.random() * 6.28, sp = rnd(2, 6) * (0.6 + r * 0.25);
      this.spark.emit(x, y, z, Math.cos(a) * sp, rnd(1, 5), Math.sin(a) * sp, rnd(0.25, 0.5), rnd(0.2, 0.4), 0xfff4c0, pal[1], 0.5, 6);
    }
    for (let i = 0; i < 5 + r * 3; i++) this.puff.emit(x + rnd(-r, r) * 0.5, y + rnd(0, r * 0.6), z + rnd(-r, r) * 0.5, rnd(-1, 1), rnd(0.8, 2), rnd(-1, 1), rnd(0.8, 1.3), rnd(0.8, 1.4) * Math.min(2, 0.6 + r * 0.4), 0x3a302c, 0x1e1816, 1.8, -0.6);
  }
  slamFx(x, z, r) {
    this.ringFx(x, z, r * 1.2, 0xfff0d0, 0.45);
    this.ringFx(x, z, r * 0.8, 0xe8c070, 0.35);
    this.dust(x, z, r, 18 + r * 4);
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * 6.28, d = Math.random() * r;
      const m = this.solid('rockSpike', rnd(0.25, 0.5));
      const px = x + Math.cos(a) * d, pz = z + Math.sin(a) * d;
      const vx = Math.cos(a) * rnd(2, 5), vz = Math.sin(a) * rnd(2, 5);
      let vy = rnd(4, 8), py = 0.3;
      m.position.set(px, py, pz);
      m.rotation.set(rnd(0, 6), rnd(0, 6), 0);
      let mx = px, mz = pz;
      this.add(null, 1.1, (k, dt) => {
        vy -= 22 * dt; py = Math.max(0, py + vy * dt); mx += vx * dt * (py > 0 ? 1 : 0); mz += vz * dt * (py > 0 ? 1 : 0);
        m.position.set(mx, py, mz); m.rotation.x += dt * 6;
        if (k > 0.7) m.scale.setScalar(m.scale.x * 0.92);
        if (k >= 1) this.ms.remove(m);
        return true;
      }, null);
    }
  }
  erupt(x, z, r) {
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * 6.28, d = r * 0.6;
      const m = new THREE.Mesh(GEO.cone, bandMat(0xfff0a0, 0xff9a2a, 0xd8341a, { scale: 1.5 }));
      const px = x + Math.cos(a) * d, pz = z + Math.sin(a) * d;
      m.position.set(px, 0.9, pz);
      m.renderOrder = 5;
      this.add(m, 0.6, (k) => { m.scale.set(0.6 * (1 - k * 0.5), 2.4 * Math.sin(Math.min(1, k * 1.6) * Math.PI * 0.5) * (1 - k * 0.6), 0.6 * (1 - k * 0.5)); m.position.y = m.scale.y / 2; m.material.uniforms.uK.value = k * 0.9; return true; });
    }
    this.explosion(x, 0.8, z, r * 0.8, FIRE);
  }
  breath(e) {
    const ang = e.a * Math.PI / 180;
    for (let i = 0; i < 70; i++) {
      const a = Math.atan2(e.dx, e.dz) + rnd(-ang / 2, ang / 2), sp = rnd(8, 13) * e.r / 6;
      const dl = rnd(0, 0.35);
      this.later(dl, () => this.glow.emit(e.x + e.dx * 0.6, 1.3, e.z + e.dz * 0.6, Math.sin(a) * sp, rnd(-0.5, 1.2), Math.cos(a) * sp, rnd(0.4, 0.55), rnd(0.6, 1.2), 0xfff0a0, 0xc82810, 2.4, -1));
    }
    for (let i = 0; i < 12; i++) {
      const a = Math.atan2(e.dx, e.dz) + rnd(-ang / 2, ang / 2), d = rnd(1, e.r);
      this.later(rnd(0.05, 0.35), () => this.puff.emit(e.x + Math.sin(a) * d, 1.2, e.z + Math.cos(a) * d, 0, 1, 0, 0.8, 0.9, 0x4a3a34, 0x221a18, 1.8, -0.5));
    }
    this.play('breath', e.x, e.z);
  }
  meteor(e) {
    const m = this.solid('meteor', e.s ? 1.25 : 1);
    const shell = new THREE.Mesh(GEO.sphere, bandMat(0xfff4c0, 0xffa32e, 0xd63a14, { scale: 1.3 }));
    shell.renderOrder = 6;
    shell.scale.setScalar(e.s ? 1.9 : 1.55);
    this.fs.add(shell);
    const sx = e.x + 4, sy = 11, sz = e.z - 6;
    this.play('meteorFall', e.x, e.z);
    this.add(null, e.d, (k) => {
      const kk = k * k;
      const x = sx + (e.x - sx) * kk, y = sy + (0.6 - sy) * kk, z = sz + (e.z - sz) * kk;
      m.position.set(x, y, z); m.rotation.x += 0.2; m.rotation.y += 0.13;
      shell.position.set(x, y, z);
      for (let i = 0; i < 3; i++) this.glow.emit(x + rnd(-0.6, 0.6), y + rnd(-0.6, 0.6), z + rnd(-0.6, 0.6), rnd(-1, 1), rnd(0, 2), rnd(-1, 1), 0.5, 1.4, 0xffe080, 0xd02810, 1.6, -1);
      if (Math.random() < 0.5) this.puff.emit(x, y + 0.5, z, rnd(-0.5, 0.5), 1, rnd(-0.5, 0.5), 1.1, 1.4, 0x3a302c, 0x1e1816, 2, -0.3);
      if (k >= 1) { this.ms.remove(m); this.fs.remove(shell); shell.material.dispose(); }
      return true;
    }, null);
  }
  arrowRain(e) {
    for (let i = 0; i < 18; i++) {
      const a = Math.random() * 6.28, r = Math.sqrt(Math.random()) * e.r;
      const tx = e.x + Math.cos(a) * r, tz = e.z + Math.sin(a) * r;
      const delay = rnd(0, e.d * 0.6), dur = e.d - delay + 0.05;
      this.later(delay, () => {
        const m = this.solid('arrow', 1.1);
        const sx = tx - 2, sy = 9, sz = tz + 1.5;
        m.lookAt(tx - sx, -sy, tz - sz);
        this.add(null, dur + 0.6, (k, dt, t) => {
          const kk = Math.min(1, t / dur);
          m.position.set(sx + (tx - sx) * kk, sy + (0.25 - sy) * kk, sz + (tz - sz) * kk);
          m.rotation.set(0, Math.atan2(tx - sx, tz - sz), 0);
          m.rotateX(Math.atan2(sy, Math.hypot(tx - sx, tz - sz)));
          if (kk >= 1 && !m.userData.hit) { m.userData.hit = true; this.puff.emit(tx, 0.2, tz, 0, 0.6, 0, 0.4, 0.4, 0xd8c8a8, 0xa89878, 1.5); }
          if (k >= 1) this.ms.remove(m);
          return true;
        }, null);
      });
    }
  }
  // a quick white arc across a unit (melee hits)
  slash(t, col, size) {
    const m = new THREE.Mesh(GEO.ring, flatMat(col, 1, true, 0.05));
    const y = this.unitY(t, 0.6);
    m.position.set(t.x, y, t.z);
    m.rotation.set(rnd(-0.6, 0.6) + Math.PI / 2, rnd(0, 6), rnd(-0.6, 0.6));
    m.renderOrder = 6;
    this.add(m, 0.18, (k) => { const s = size * (0.6 + k * 0.5); m.scale.set(s, s, s * 0.35); m.material.uniforms.uO.value = 1 - k; return true; });
  }
  slashRing(x, z, r) {
    const m = new THREE.Mesh(GEO.ring, flatMat(0xe8d8ff, 1, true));
    m.position.set(x, 1.1, z);
    m.rotation.z = rnd(-0.2, 0.2);
    m.renderOrder = 6;
    this.add(m, 0.22, (k) => { const s = r * (0.5 + k * 0.6); m.scale.set(s, 1, s); m.rotation.y += 0.4; m.material.uniforms.uO.value = 1 - k; return true; });
  }
  // a glowing bar between two points (fountain laser, piercing arrow)
  line(x0, y0, z0, x1, y1, z1, col, dur, w) {
    const m = new THREE.Mesh(GEO.box, flatMat(col, 1, true, 0.05));
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0, l = Math.hypot(dx, dy, dz);
    m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    m.lookAt(x1, y1, z1);
    m.scale.set(w, w, l);
    m.renderOrder = 6;
    this.add(m, dur, (k) => { m.material.uniforms.uO.value = 1 - k; return true; });
  }
  // jagged lightning between units
  chain(ids) {
    const pts = ids.map((id) => this.pos(id)).filter(Boolean);
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      let px = a.x, py = 1.3, pz = a.z;
      for (let s = 1; s <= 5; s++) {
        const t = s / 5;
        const nx = a.x + (b.x - a.x) * t + (s < 5 ? rnd(-0.4, 0.4) : 0), ny = 1.3 + (s < 5 ? rnd(-0.3, 0.3) : 0), nz = a.z + (b.z - a.z) * t + (s < 5 ? rnd(-0.4, 0.4) : 0);
        this.line(px, py, pz, nx, ny, nz, 0xbfe8ff, 0.22, 0.07);
        px = nx; py = ny; pz = nz;
      }
      this.spark.emit(b.x, 1.3, b.z, 0, 0, 0, 0.2, 1.2, 0xffffff, 0x7ad0ff);
    }
  }

  // ============================================================
  //  Status markers on units (from their state bits)
  // ============================================================
  updateStatus(world, dt) {
    const now = U.time.value;
    const live = new Set();
    for (const e of world.ents.values()) {
      if (!e.alive || (e.kind !== K.HERO && e.kind !== K.BOSS && e.kind !== K.MINION && e.kind !== K.CLONE)) continue;
      const v = this.view.vis.get(e.id);
      if (!v || !v.root.visible) continue;
      const f = e.flags;
      if (!f) continue;
      live.add(e.id);
      let st = this.status.get(e.id);
      if (!st) { st = {}; this.status.set(e.id, st); }
      const gy = groundHeight(e.x, e.z), top = this.view.headPos(v);
      // stun: stars circling the head
      this.toggle(st, 'stun', !!(f & F.STUN), () => this.starRing(), (o) => { o.position.set(e.x, top - 0.2, e.z); o.rotation.y = now * 5; });
      // slow: a blue ring at the feet; root: a brown one
      this.toggle(st, 'slow', !!(f & F.SLOW) && e.kind !== K.MINION, () => this.footRing(0x6ab8ff, 0.7), (o) => { o.position.set(e.x, gy + 0.08, e.z); o.rotation.y = -now * 2; });
      this.toggle(st, 'root', !!(f & F.ROOT), () => this.footRing(0x8a5a2a, 0.95), (o) => { o.position.set(e.x, gy + 0.1, e.z); });
      this.toggle(st, 'shield', !!(f & F.SHIELD) && e.kind !== K.MINION, () => { const m = new THREE.Mesh(GEO.sphere, (this._shieldMat ||= rimMat(0xbfe8ff, 0.45))); m.renderOrder = 4; return m; }, (o) => { const s = (v.h || 2) * 0.62; o.position.set(e.x, gy + s * 0.9 + (v.rig ? v.rig.parts.body.position.y : 0), e.z); o.scale.set(s * 0.75, s, s * 0.75); });
      this.toggle(st, 'boss', !!(f & F.BOSS), () => this.footRing(0xffd34a, 1.0), (o) => { o.position.set(e.x, gy + 0.06, e.z); o.rotation.y = now; });
      this.toggle(st, 'emp', !!(f & F.EMP), () => this.footRing(0xffd34a, 0.55), (o) => { o.position.set(e.x, gy + 0.06, e.z); });
      this.toggle(st, 'taunt', !!(f & F.TAUNT), () => this.footRing(0xff3a2a, 0.75), (o) => { o.position.set(e.x, gy + 0.08, e.z); });
      this.toggle(st, 'markA', !!(f & F.MARK_A), () => this.icon(0xb48cff, 'moon'), (o) => { o.position.set(e.x, top + 0.45, e.z); o.lookAt(this.view.camera.position); });
      this.toggle(st, 'markS', !!(f & F.MARK_S), () => this.icon(0x9fe870, 'target'), (o) => { o.position.set(e.x, top + 0.45, e.z); o.lookAt(this.view.camera.position); o.rotateZ(now * 2); });
      if (f & F.BURN && Math.random() < 0.5) this.glow.emit(e.x + rnd(-0.3, 0.3), gy + rnd(0.3, 1.6), e.z + rnd(-0.3, 0.3), 0, rnd(1, 2), 0, 0.45, 0.5, 0xffd070, 0xc02810, 1, -1);
      if (f & F.HASTE && v.speed > 1 && Math.random() < 0.4) this.puff.emit(e.x, gy + 0.3, e.z, 0, 0.3, 0, 0.35, 0.45, 0xffffff, 0xd0e8ff, 1.5);
      if (f & F.POT && Math.random() < 0.15) this.glow.emit(e.x + rnd(-0.3, 0.3), gy + 0.5, e.z + rnd(-0.3, 0.3), 0, 1.2, 0, 0.6, 0.25, 0xd8ffd8, 0x5ad06a);
      if (f & F.READY && v.rig && v.rig.parts && Math.random() < 0.6) {
        const p = v.rig.parts.handR.getWorldPosition(this._v2 ||= new THREE.Vector3());
        const col = { granit: 0xffb04a, parazs: 0xff8a2a, solyom: 0xfff07a, arny: 0xb48cff }[v.hero] || 0xffffff;
        this.glow.emit(p.x, p.y, p.z, rnd(-0.3, 0.3), rnd(0.3, 1), rnd(-0.3, 0.3), 0.35, 0.4, 0xffffff, col);
      }
      if (f & F.SPIN && Math.random() < 0.8) { const a = now * 18 + Math.random(); this.puff.emit(e.x + Math.sin(a) * 2, gy + 0.6, e.z + Math.cos(a) * 2, Math.cos(a) * 2, 0.4, -Math.sin(a) * 2, 0.35, 0.55, 0xe8e0d0, 0xb8b0a0, 1.6); }
      if (f & F.DANCE && Math.random() < 0.9) this.glow.emit(e.x + rnd(-0.4, 0.4), gy + rnd(0.6, 1.6), e.z + rnd(-0.4, 0.4), 0, 0, 0, 0.3, 0.55, 0xffffff, 0x8a5ad8);
    }
    for (const [id, st] of this.status) {
      if (live.has(id)) continue;
      for (const k in st) if (st[k]) { st[k].parent?.remove(st[k]); }
      this.status.delete(id);
    }
  }
  toggle(st, key, on, make, upd) {
    let o = st[key];
    if (on) {
      if (!o) { o = st[key] = make(); this.fs.add(o); }
      upd(o);
    } else if (o) { o.parent?.remove(o); st[key] = null; }
  }
  footRing(col, r) {
    const mats = (this._ringMats ||= new Map());
    if (!mats.has(col)) mats.set(col, flatMat(col, 0.85, false, 0.02));
    const m = new THREE.Mesh(GEO.ring, mats.get(col));
    m.scale.set(r, 1, r);
    m.renderOrder = 2;
    return m;
  }
  starRing() {
    const g = new THREE.Group();
    const mat = (this._starMat ||= flatMat(0xfff07a, 1, false, 0.02));
    const sg = (this._starGeo ||= (() => {
      const s = new THREE.Shape();
      for (let i = 0; i < 10; i++) { const a = i / 10 * Math.PI * 2 - Math.PI / 2, r = i % 2 ? 0.07 : 0.17; i ? s.lineTo(Math.cos(a) * r, Math.sin(a) * r) : s.moveTo(Math.cos(a) * r, Math.sin(a) * r); }
      return new THREE.ShapeGeometry(s);
    })());
    for (let i = 0; i < 3; i++) {
      const m = new THREE.Mesh(sg, mat);
      const a = i / 3 * Math.PI * 2;
      m.position.set(Math.sin(a) * 0.45, 0, Math.cos(a) * 0.45);
      m.renderOrder = 7;
      g.add(m);
    }
    return g;
  }
  icon(col, kind) {
    const cache = (this._iconMats ||= new Map());
    if (cache.has(kind)) { const m = new THREE.Mesh(this._iconGeo, cache.get(kind)); m.renderOrder = 8; return m; }
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    g.lineWidth = 5; g.strokeStyle = '#140c08';
    g.fillStyle = '#' + new THREE.Color(col).getHexString();
    if (kind === 'moon') {
      g.beginPath(); g.arc(32, 32, 22, 0.5, Math.PI * 2 - 0.5); g.arc(42, 32, 16, Math.PI * 2 - 0.9, 0.9, true); g.closePath(); g.fill(); g.stroke();
    } else {
      g.beginPath(); g.arc(32, 32, 20, 0, Math.PI * 2); g.lineWidth = 9; g.stroke(); g.lineWidth = 5; g.strokeStyle = g.fillStyle; g.stroke();
      g.fillRect(29, 4, 6, 16); g.fillRect(29, 44, 6, 16); g.fillRect(4, 29, 16, 6); g.fillRect(44, 29, 16, 6);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    this._iconGeo ||= new THREE.PlaneGeometry(0.6, 0.6);
    cache.set(kind, new THREE.MeshBasicMaterial({ map: t, transparent: true, depthTest: false, depthWrite: false }));
    return this.icon(col, kind);
  }

  // ============================================================
  //  Aiming indicators and click markers
  // ============================================================
  makeIndicators() {
    const g = new THREE.Group();
    g.visible = false;
    const mk = (geo, col, o) => { const m = new THREE.Mesh(geo, flatMat(col, o, false, 0.0)); m.renderOrder = 9; m.material.depthTest = false; g.add(m); return m; };
    const ind = {
      g,
      range: mk(GEO.ring, 0xffffff, 0.35),
      line: mk(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0, 0, 0.5), 0x9fd8ff, 0.32),
      circle: mk(GEO.disc, 0x9fd8ff, 0.3),
      circleRing: mk(GEO.ring, 0xffffff, 0.7),
      cone: mk(new THREE.CircleGeometry(1, 24, 0, 1).rotateX(-Math.PI / 2), 0x9fd8ff, 0.3),
      wall: mk(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), 0xffa23a, 0.45),
    };
    // a circle for the disc (the plane is square)
    ind.circle.material = teleMat(0x9fd8ff, 0.6);
    ind.circle.material.uniforms.uP.value = 1;
    ind.circle.material.depthTest = false;
    this.fs.add(g);
    return ind;
  }
  // sk: a skill definition (or { kind: 'range', range }); h: my hero entity; aim: ground point
  showIndicator(sk, h, aim, targetOk) {
    const I = this.ind;
    if (!sk || !h) { I.g.visible = false; return; }
    I.g.visible = true;
    for (const k of ['range', 'line', 'circle', 'circleRing', 'cone', 'wall']) I[k].visible = false;
    const y = 0.15;
    const dx = aim.x - h.x, dz = aim.z - h.z, d = Math.hypot(dx, dz) || 1, ux = dx / d, uz = dz / d;
    const yaw = Math.atan2(ux, uz);
    const range = sk.range || sk.radius || 1;
    I.range.visible = true;
    I.range.position.set(h.x, y, h.z);
    I.range.scale.set(range, 1, range);
    const col = targetOk === false ? 0xff6a5a : 0x9fd8ff;
    switch (sk.kind) {
      case 'line': {
        I.line.visible = true;
        I.line.position.set(h.x, y, h.z);
        I.line.rotation.y = yaw;
        I.line.scale.set(sk.width, 1, sk.range);
        I.line.material.uniforms.uC.value.set(col);
        break;
      }
      case 'circle': case 'blink': case 'dash': {
        const r = Math.min(d, sk.range);
        const px = h.x + ux * r, pz = h.z + uz * r;
        if (sk.kind === 'circle') {
          I.circle.visible = true; I.circle.position.set(px, y, pz); I.circle.scale.set(sk.radius, 1, sk.radius);
        } else {
          I.line.visible = true; I.line.position.set(h.x, y, h.z); I.line.rotation.y = yaw; I.line.scale.set(0.5, 1, r);
          I.circleRing.visible = true; I.circleRing.position.set(px, y, pz); I.circleRing.scale.set(0.8, 1, 0.8);
        }
        break;
      }
      case 'cone': {
        I.cone.visible = true;
        const a = sk.angle * Math.PI / 180;
        const key = sk.range + ':' + sk.angle;
        if (I.cone.userData.key !== key) {
          I.cone.userData.key = key;
          I.cone.geometry.dispose();
          I.cone.geometry = new THREE.CircleGeometry(sk.range, 24, Math.PI / 2 - a / 2, a).rotateX(-Math.PI / 2);
        }
        I.cone.position.set(h.x, y, h.z);
        I.cone.rotation.y = yaw + Math.PI;
        break;
      }
      case 'wall': {
        const r = Math.min(d, sk.range);
        I.wall.visible = true;
        I.wall.position.set(h.x + ux * r, y, h.z + uz * r);
        I.wall.rotation.y = yaw;
        I.wall.scale.set(sk.length, 1, 0.9);
        break;
      }
      case 'self': {
        I.range.scale.set(sk.radius, 1, sk.radius);
        I.circle.visible = true; I.circle.position.set(h.x, y, h.z); I.circle.scale.set(sk.radius, 1, sk.radius);
        break;
      }
      default: break;
    }
  }
  // the little chevrons where you right-clicked
  clickMarker(x, z, attack) {
    const col = attack ? 0xff4a3a : 0x7aff8a;
    const m = new THREE.Mesh(GEO.ring, flatMat(col, 1, false, 0.02));
    m.position.set(x, groundHeight(x, z) + 0.1, z);
    m.renderOrder = 9;
    this.add(m, 0.4, (k) => { const s = 0.9 * (1 - k * 0.7); m.scale.set(s, 1, s); m.material.uniforms.uO.value = 1 - k; return true; });
  }

  // ============================================================
  //  Per frame
  // ============================================================
  update(dt, world) {
    this.world = world;
    if (this.timers.length) {
      const due = [];
      for (const t of this.timers) { t.t -= dt; if (t.t <= 0) due.push(t); }
      if (due.length) { this.timers = this.timers.filter((t) => t.t > 0); for (const t of due) t.fn(); }
    }
    this.updateProj(dt);
    this.updateZones(dt);
    this.updateStatus(world, dt);
    for (const ef of this.effects) {
      ef.t += dt;
      const k = Math.min(1, ef.t / ef.dur);
      const keep = ef.upd ? ef.upd(k, dt, ef.t) : true;
      if (ef.t >= ef.dur || keep === false) ef.done = true;
    }
    if (this.effects.some((e) => e.done)) {
      this.effects = this.effects.filter((ef) => {
        if (!ef.done) return true;
        if (ef.obj && ef.scene) { ef.scene.remove(ef.obj); if (ef.obj.material && ef.obj.material !== this.solidMat && ef.obj.material.dispose) ef.obj.material.dispose(); }
        return false;
      });
    }
    // braziers, the fire mage's staff, the crystals of the structures
    this.emberT += dt;
    if (this.emberT > 0.05) {
      this.emberT = 0;
      for (const b of this.view.braziers) this.glow.emit(b[0] + rnd(-0.2, 0.2), b[1], b[2] + rnd(-0.2, 0.2), rnd(-0.2, 0.2), rnd(1, 2), rnd(-0.2, 0.2), 0.5, 0.5, 0xffd070, 0xc02810, 1.2, -1);
      for (const v of this.view.vis.values()) {
        if (v.hero === 'parazs' && v.root.visible && v.e && v.e.alive) {
          const p = v.rig.parts.handR.localToWorld((this._v3 ||= new THREE.Vector3()).set(0, 1.35, 0.05));
          this.glow.emit(p.x, p.y, p.z, rnd(-0.2, 0.2), rnd(0.5, 1.2), rnd(-0.2, 0.2), 0.35, 0.3, 0xffe080, 0xd03010, 1, -1);
        }
      }
    }
    for (const p of [this.glow, this.puff, this.spark]) {
      p.mat.uniforms.scale.value = this.view.h * this.view.dpr / (2 * Math.tan((this.view.camera.fov * Math.PI) / 360));
      p.step(dt);
    }
  }
}
