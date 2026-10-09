import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { BLADE, HILT, SHOULDERS, ARENA_R } from './fight.js';

// three.js scene: a round platform over a dark shaft, two robed fighters with two-bone IK arms holding their
// sabers, blade trails, sparks, and bloom so the blades glow. Everything is built from primitives.

export const BLADE_COLORS = {
  blue: { name: 'KÉK', hex: 0x2f7dff, css: '#4d92ff' },
  green: { name: 'ZÖLD', hex: 0x2bff5a, css: '#4cff74' },
  purple: { name: 'LILA', hex: 0xa040ff, css: '#b46bff' },
  yellow: { name: 'SÁRGA', hex: 0xffc21a, css: '#ffcc3d' },
  red: { name: 'PIROS', hex: 0xff2020, css: '#ff4a3d' },
};

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _u = new THREE.Vector3();
const _q = new THREE.Quaternion();
const Y = new THREE.Vector3(0, 1, 0);

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d'), grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.35, 'rgba(255,255,255,0.5)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

function floorTexture() {
  const S = 1024, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d'), m = S / 2;
  g.fillStyle = '#1b1e25';
  g.fillRect(0, 0, S, S);
  // plates: rings x sectors with slightly different shades
  const rings = [0, 0.16, 0.36, 0.58, 0.8, 1];
  for (let r = 0; r < rings.length - 1; r++) {
    const n = [1, 8, 12, 18, 24][r];
    for (let s = 0; s < n; s++) {
      const a0 = (s / n) * Math.PI * 2, a1 = ((s + 1) / n) * Math.PI * 2, l = 22 + ((s * 7 + r * 13) % 5) * 2.2;
      g.beginPath();
      g.arc(m, m, rings[r + 1] * m, a0, a1);
      g.arc(m, m, rings[r] * m, a1, a0, true);
      g.closePath();
      g.fillStyle = `hsl(222, 9%, ${l}%)`;
      g.fill();
      g.strokeStyle = '#0b0c10';
      g.lineWidth = 3;
      g.stroke();
    }
  }
  // fine scratches
  g.globalAlpha = 0.06;
  for (let i = 0; i < 900; i++) {
    const x = Math.random() * S, y = Math.random() * S, a = Math.random() * Math.PI, l = 6 + Math.random() * 30;
    g.strokeStyle = Math.random() < 0.5 ? '#fff' : '#000';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
  }
  g.globalAlpha = 1;
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

// ---------- one saber: hilt at the hand, blade along local -Z ----------
class SaberView {
  constructor(scene) {
    const g = (this.g = new THREE.Group());
    const metal = new THREE.MeshStandardMaterial({ color: 0xb8bcc4, metalness: 0.9, roughness: 0.32 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x15161a, metalness: 0.5, roughness: 0.6 });
    const cyl = (r0, r1, len, mat, z) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r0, r1, len, 18), mat);
      m.rotation.x = Math.PI / 2;
      m.position.z = z;
      g.add(m);
      return m;
    };
    cyl(0.021, 0.021, HILT, metal, 0);
    for (let i = 0; i < 5; i++) cyl(0.024, 0.024, 0.018, dark, 0.02 + i * 0.03);
    cyl(0.03, 0.025, 0.05, metal, -HILT / 2 + 0.02);
    cyl(0.024, 0.026, 0.03, dark, HILT / 2 - 0.01);
    const btn = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.016, 0.03), new THREE.MeshBasicMaterial({ color: 0xff3a2a }));
    btn.position.set(0, 0.022, -0.05);
    g.add(btn);

    // blade: unit-length cylinders spanning z 0..-1, scaled by the extension
    const blade = (this.blade = new THREE.Group());
    blade.position.z = -HILT / 2;
    g.add(blade);
    const tube = (r, mat) => {
      const geo = new THREE.CylinderGeometry(r, r, 1, 16, 1, true);
      geo.rotateX(-Math.PI / 2);
      geo.translate(0, 0, -0.5);
      const m = new THREE.Mesh(geo, mat);
      blade.add(m);
      return m;
    };
    this.coreMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    this.glowMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    this.haloMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    tube(0.011, this.coreMat);
    tube(0.026, this.glowMat);
    tube(0.055, this.haloMat);
    // rounded tip (not scaled with the blade)
    this.tip = new THREE.Group();
    g.add(this.tip);
    this.tip.add(new THREE.Mesh(new THREE.SphereGeometry(0.011, 10, 8), this.coreMat));
    this.tip.add(new THREE.Mesh(new THREE.SphereGeometry(0.026, 12, 10), this.glowMat));
    this.light = new THREE.PointLight(0xffffff, 0, 5, 1.6);
    this.light.position.z = -HILT / 2 - BLADE * 0.5;
    g.add(this.light);
    scene.add(g);
  }
  setColor(hex) {
    const c = new THREE.Color(hex);
    this.coreMat.color.copy(c).lerp(new THREE.Color(0xffffff), 0.82).multiplyScalar(1.6);
    this.glowMat.color.copy(c).multiplyScalar(2.2);
    this.haloMat.color.copy(c).multiplyScalar(1.6);
    this.light.color.copy(c);
    this.color = c;
  }
  update(hand, quat, on, flicker) {
    this.g.position.copy(hand);
    this.g.quaternion.copy(quat);
    const len = BLADE * on;
    this.blade.visible = this.tip.visible = on > 0.01;
    this.blade.scale.set(1, 1, Math.max(len, 0.001));
    this.tip.position.z = -HILT / 2 - len;
    this.light.intensity = on * 2.4 * flicker;
    this.light.position.z = -HILT / 2 - len * 0.5;
    this.glowMat.opacity = 0.55 * flicker;
  }
}

// ---------- blade trail: the last few blade positions as an additive ribbon ----------
const TRAIL = 12;
class Trail {
  constructor(scene) {
    const geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(TRAIL * 2 * 3);
    this.col = new Float32Array(TRAIL * 2 * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    const idx = [];
    for (let i = 0; i < TRAIL - 1; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, b, c, b, d, c);
    }
    geo.setIndex(idx);
    this.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    }));
    this.mesh.frustumCulled = false;
    this.hist = [];
    scene.add(this.mesh);
  }
  reset() { this.hist.length = 0; }
  update(base, tip, color, strength) {
    this.hist.unshift([base.clone(), tip.clone()]);
    if (this.hist.length > TRAIL) this.hist.length = TRAIL;
    const n = this.hist.length;
    for (let i = 0; i < TRAIL; i++) {
      const h = this.hist[Math.min(i, n - 1)], k = i < n ? Math.pow(1 - i / TRAIL, 1.6) * strength : 0;
      // start the ribbon a bit up the blade so it doesn't smear over the hand
      _v.lerpVectors(h[0], h[1], 0.25);
      this.pos.set([_v.x, _v.y, _v.z, h[1].x, h[1].y, h[1].z], i * 6);
      this.col.set([color.r * k * 0.25, color.g * k * 0.25, color.b * k * 0.25, color.r * k, color.g * k, color.b * k], i * 6);
    }
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.mesh.geometry.attributes.color.needsUpdate = true;
    this.mesh.visible = strength > 0.01 && n > 1;
  }
}

// ---------- sparks ----------
const SPARKS = 260;
class Sparks {
  constructor(scene, tex) {
    const geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(SPARKS * 3);
    this.col = new Float32Array(SPARKS * 3);
    this.vel = new Float32Array(SPARKS * 3);
    this.life = new Float32Array(SPARKS);
    this.max = new Float32Array(SPARKS);
    this.tint = new Float32Array(SPARKS * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.pts = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 0.05, map: tex, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }));
    this.pts.frustumCulled = false;
    this.i = 0;
    scene.add(this.pts);
  }
  burst(p, n, color, speed, up = 1) {
    for (let k = 0; k < n; k++) {
      const i = this.i, j = i * 3;
      this.i = (i + 1) % SPARKS;
      _v.set(Math.random() * 2 - 1, Math.random() * 2 - 1 + up * 0.5, Math.random() * 2 - 1).normalize().multiplyScalar(speed * (0.3 + Math.random()));
      this.pos.set([p.x, p.y, p.z], j);
      this.vel.set([_v.x, _v.y, _v.z], j);
      this.max[i] = this.life[i] = 0.25 + Math.random() * 0.45;
      const w = Math.random() < 0.5 ? 1 : 0.4;  // half of them white-hot
      this.tint.set([color.r * (1 - w) + w * 2.2, color.g * (1 - w) + w * 2, color.b * (1 - w) + w * 1.6], j);
    }
  }
  update(dt) {
    for (let i = 0; i < SPARKS; i++) {
      const j = i * 3;
      if (this.life[i] <= 0) { this.col[j] = this.col[j + 1] = this.col[j + 2] = 0; continue; }
      this.life[i] -= dt;
      this.vel[j + 1] -= 9.8 * dt;
      for (let a = 0; a < 3; a++) { this.vel[j + a] *= 1 - dt * 1.5; this.pos[j + a] += this.vel[j + a] * dt; }
      if (this.pos[j + 1] < 0.01) { this.pos[j + 1] = 0.01; this.vel[j + 1] *= -0.35; }
      const k = Math.max(0, this.life[i] / this.max[i]);
      for (let a = 0; a < 3; a++) this.col[j + a] = this.tint[j + a] * k;
    }
    this.pts.geometry.attributes.position.needsUpdate = true;
    this.pts.geometry.attributes.color.needsUpdate = true;
  }
}

// ---------- a fighter: robe, hood with a glowing visor, IK arms, the saber ----------
const ROBES = [
  { robe: 0xb9a37c, under: 0x5b4a36, hood: 0x8d7a58 },   // slot 0: sand
  { robe: 0x2b2c33, under: 0x16161b, hood: 0x1f2026 },   // slot 1: charcoal
];
const tN = new THREE.Vector3(), tP = new THREE.Vector3(), tE = new THREE.Vector3(), tEnd = new THREE.Vector3(), tD = new THREE.Vector3();
function place(m, from, to) {
  tD.subVectors(to, from);
  const l = tD.length();
  m.position.copy(from);
  m.quaternion.setFromUnitVectors(Y, tD.multiplyScalar(1 / (l || 1)));
  m.scale.set(1, l, 1);
}
class FighterView {
  constructor(scene, slot) {
    const p = ROBES[slot];
    const root = (this.root = new THREE.Group());
    const mats = (this.mats = []);
    const mk = (color, rough = 0.85, metal = 0) => {
      const m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
      mats.push(m);
      return m;
    };
    const robe = mk(p.robe), under = mk(p.under), hood = mk(p.hood), skin = mk(0x26272c, 0.5, 0.4), belt = mk(0x3a3328, 0.5, 0.5);
    const add = (geo, mat, x, y, z) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      root.add(m);
      return m;
    };
    this.body = [];
    for (const s of [-1, 1]) this.body.push(add(new THREE.CapsuleGeometry(0.075, 0.5, 4, 10), under, s * 0.11, 0.38, 0));
    const skirt = add(new THREE.CylinderGeometry(0.2, 0.31, 0.66, 22, 1, true), robe, 0, 0.62, 0);
    skirt.material.side = THREE.DoubleSide;
    const torso = add(new THREE.CapsuleGeometry(0.17, 0.32, 4, 14), robe, 0, 1.2, 0);
    torso.scale.set(1, 1, 0.74);
    const sash = add(new THREE.CylinderGeometry(0.182, 0.19, 0.08, 22), belt, 0, 0.97, 0);
    this.buckle = add(new THREE.BoxGeometry(0.06, 0.05, 0.02), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), 0, 0.97, -0.19);
    const neck = add(new THREE.CylinderGeometry(0.05, 0.06, 0.1, 10), skin, 0, 1.52, 0);
    const head = add(new THREE.SphereGeometry(0.115, 20, 14), skin, 0, 1.65, 0);
    // hood: a sphere with the front cut open (SphereGeometry: phi = 270 deg is -Z)
    const hd = add(new THREE.SphereGeometry(0.145, 22, 14, (320 * Math.PI) / 180, (260 * Math.PI) / 180, 0, Math.PI * 0.64), hood, 0, 1.665, 0.02);
    hd.material.side = THREE.DoubleSide;
    const cowl = add(new THREE.TorusGeometry(0.17, 0.05, 8, 20), hood, 0, 1.47, 0.01);
    cowl.rotation.x = Math.PI / 2;
    this.visorMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    const visor = add(new THREE.BoxGeometry(0.14, 0.026, 0.03), this.visorMat, 0, 1.67, -0.108);
    this.body.push(skirt, torso, sash, this.buckle, neck, head, hd, cowl, visor);
    for (const s of SHOULDERS) this.body.push(add(new THREE.SphereGeometry(0.085, 14, 10), robe, s.x, s.y, s.z));
    // arms live in world space (IK), not under root
    this.arms = [];
    const limb = (r0, r1, mat) => {
      const geo = new THREE.CylinderGeometry(r1, r0, 1, 10);
      geo.translate(0, 0.5, 0);
      const m = new THREE.Mesh(geo, mat);
      scene.add(m);
      return m;
    };
    for (let i = 0; i < 2; i++) {
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 8), skin);
      scene.add(hand);
      this.arms.push({ up: limb(0.06, 0.05, robe), lo: limb(0.05, 0.04, under), hand });
    }
    // blob shadow
    const sh = new THREE.Mesh(new THREE.CircleGeometry(0.55, 24), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.45, depthWrite: false }));
    sh.rotation.x = -Math.PI / 2;
    sh.position.y = 0.005;
    root.add(sh);
    this.saber = new SaberView(scene);
    this.trail = new Trail(scene);
    this.flashT = 0;
    scene.add(root);
  }
  setColor(hex) {
    this.saber.setColor(hex);
    const c = new THREE.Color(hex);
    this.visorMat.color.copy(c).multiplyScalar(1.8);
    this.buckle.material.color.copy(c).multiplyScalar(1.2);
  }
  hitFlash() { this.flashT = 0.35; }
  // place one arm from shoulder to hand (two-bone IK, elbow pulled towards pole)
  arm(a, S, H, pole) {
    const L1 = 0.29, L2 = 0.28;
    tN.subVectors(H, S);
    const dist = tN.length();
    tN.multiplyScalar(1 / (dist || 1));
    const len = Math.min(Math.max(dist, 0.08), L1 + L2 - 0.001);
    const along = (L1 * L1 - L2 * L2 + len * len) / (2 * len), h = Math.sqrt(Math.max(0, L1 * L1 - along * along));
    tP.copy(pole).addScaledVector(tN, -pole.dot(tN)).normalize();
    tE.copy(S).addScaledVector(tN, along).addScaledVector(tP, h);
    tEnd.copy(S).addScaledVector(tN, Math.min(dist, L1 + L2));
    place(a.up, S, tE);
    place(a.lo, tE, tEnd);
    a.hand.position.copy(tEnd);
  }
  update(f, dt, firstPerson, flicker) {
    this.root.position.copy(f.pos);
    this.root.rotation.y = f.yaw;
    for (const m of this.body) m.visible = !firstPerson;
    const lq = f.rig(true);
    const q = _q.copy(f.bodyQ).multiply(lq);
    this.saber.update(f.hand, q, f.on, flicker);
    // right hand on the hilt, left hand just below it
    const S0 = SHOULDERS[0].clone().applyQuaternion(f.bodyQ).add(f.pos);
    const S1 = SHOULDERS[1].clone().applyQuaternion(f.bodyQ).add(f.pos);
    const H1 = f.hand.clone().addScaledVector(f.dir, 0.1);
    const pole0 = new THREE.Vector3(0.6, -1, 0.4).applyQuaternion(f.bodyQ);
    const pole1 = new THREE.Vector3(-0.6, -1, 0.4).applyQuaternion(f.bodyQ);
    this.arm(this.arms[0], S0, f.hand.clone().addScaledVector(f.dir, -0.04), pole0);
    this.arm(this.arms[1], S1, H1.addScaledVector(f.dir, 0.02), pole1);
    this.flashT = Math.max(0, this.flashT - dt);
    const k = this.flashT / 0.35;
    for (const m of this.mats) { m.emissive.setRGB(1.6 * k, 0.35 * k, 0.1 * k); }
    this.trail.update(f.base, f.tip, this.saber.color, Math.min(1, Math.max(0, (f.swing - 2.5) / 6)) * f.on);
  }
}

// ---------- the view ----------
export class View {
  constructor(canvas) {
    const r = (this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' }));
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    const scene = (this.scene = new THREE.Scene());
    scene.background = new THREE.Color(0x04050a);
    scene.fog = new THREE.FogExp2(0x04050a, 0.045);
    this.camera = new THREE.PerspectiveCamera(66, 1, 0.03, 220);
    scene.add(new THREE.HemisphereLight(0x8090b8, 0x0a0b10, 0.65));
    const key = new THREE.DirectionalLight(0xc8d6ff, 0.85);
    key.position.set(-3, 7, 4);
    scene.add(key);
    this.glowTex = glowTexture();
    this.buildArena();
    this.fighters = [new FighterView(scene, 0), new FighterView(scene, 1)];
    this.sparks = new Sparks(scene, this.glowTex);
    this.flashLight = new THREE.PointLight(0xffffff, 0, 6, 1.5);
    scene.add(this.flashLight);
    this.shakeT = 0;
    this.camPos = new THREE.Vector3(0, 3, 6);
    this.camLook = new THREE.Vector3(0, 1.2, 0);
    this.orbit = 0;
    this.shift = 0;          // menu panel on the left: push the scene to the right
    this.time = 0;

    this.composer = new EffectComposer(r);
    this.composer.addPass(new RenderPass(scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.95, 0.55, 0.85);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.resize();
  }
  buildArena() {
    const s = this.scene;
    const top = new THREE.MeshStandardMaterial({ map: floorTexture(), metalness: 0.55, roughness: 0.5 });
    const side = new THREE.MeshStandardMaterial({ color: 0x14161b, metalness: 0.6, roughness: 0.5 });
    const plat = new THREE.Mesh(new THREE.CylinderGeometry(ARENA_R + 0.5, ARENA_R + 0.2, 0.6, 96), [side, top, side]);
    plat.position.y = -0.3;
    s.add(plat);
    const glow = (r, w, color, y = 0.006) => {
      const m = new THREE.Mesh(new THREE.RingGeometry(r - w, r, 128), new THREE.MeshBasicMaterial({ color, toneMapped: false, transparent: true, opacity: 0.9, depthWrite: false }));
      m.rotation.x = -Math.PI / 2;
      m.position.y = y;
      s.add(m);
      return m;
    };
    glow(ARENA_R + 0.42, 0.04, new THREE.Color(0x58c8ff).multiplyScalar(1.6));
    glow(ARENA_R - 1.6, 0.015, new THREE.Color(0x58c8ff).multiplyScalar(0.5));
    glow(0.55, 0.012, new THREE.Color(0x58c8ff).multiplyScalar(0.45));
    // underside lights
    const under = new THREE.Mesh(new THREE.TorusGeometry(ARENA_R + 0.25, 0.05, 8, 96), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff8a3a).multiplyScalar(1.4), toneMapped: false }));
    under.rotation.x = Math.PI / 2;
    under.position.y = -0.62;
    s.add(under);
    // the shaft: pillars all around, light strips, a glow far below
    const pil = new THREE.MeshStandardMaterial({ color: 0x101218, metalness: 0.4, roughness: 0.7 });
    const strip = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x58c8ff).multiplyScalar(0.7), toneMapped: false });
    const N = 14;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2, R = 12;
      const p = new THREE.Mesh(new THREE.BoxGeometry(1.6, 44, 1.6), pil);
      p.position.set(Math.cos(a) * R, -6, Math.sin(a) * R);
      p.rotation.y = -a;
      s.add(p);
      const l = new THREE.Mesh(new THREE.BoxGeometry(0.06, 40, 0.06), strip);
      l.position.set(Math.cos(a) * (R - 0.82), -6, Math.sin(a) * (R - 0.82));
      s.add(l);
      if (i % 2 === 0) {
        const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.3, R - ARENA_R - 1.2), pil);
        bridge.position.set(Math.cos(a) * (R + ARENA_R) / 2, -1.6 - (i % 4) * 2.5, Math.sin(a) * (R + ARENA_R) / 2);
        bridge.rotation.y = -a + Math.PI / 2;
        s.add(bridge);
      }
    }
    const pit = new THREE.Mesh(new THREE.CircleGeometry(16, 48), new THREE.MeshBasicMaterial({ map: this.glowTex, color: new THREE.Color(0x2a6cff).multiplyScalar(0.7), transparent: true, depthWrite: false, toneMapped: false, fog: false }));
    pit.rotation.x = -Math.PI / 2;
    pit.position.y = -26;
    s.add(pit);
    // stars through the open top
    const n = 900, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      _v.set(Math.random() * 2 - 1, Math.random() * 0.9 + 0.1, Math.random() * 2 - 1).normalize().multiplyScalar(90);
      pos.set([_v.x, _v.y, _v.z], i * 3);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    s.add(new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xcfd8ff, size: 0.35, map: this.glowTex, transparent: true, depthWrite: false, fog: false })));
  }
  setColors(hexes) { hexes.forEach((h, i) => this.fighters[i].setColor(h)); }
  resize() {
    const w = Math.max(1, innerWidth), h = Math.max(1, innerHeight);
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.applyShift();
  }
  applyShift() {
    const w = Math.max(1, innerWidth), h = Math.max(1, innerHeight);
    if (this.shift > 0.001) this.camera.setViewOffset(w, h, -w * this.shift, 0, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }
  spark(p, n, color, speed, up) { this.sparks.burst(p, n, color, speed, up); }
  flash(p, color, power = 6) {
    this.flashLight.position.copy(p);
    this.flashLight.color.copy(color);
    this.flashLight.intensity = power;
  }
  shake(k) { this.shakeT = Math.max(this.shakeT, k); }
  resetTrails() { for (const fv of this.fighters) fv.trail.reset(); }
  // mode: 'fp' (first person of slot me), 'shoulder' (behind slot 0), 'orbit'. shift: 0..0.2 menu offset
  update(dt, fs, mode, me, shift) {
    this.time += dt;
    const flick = 0.93 + Math.sin(this.time * 61) * 0.035 + Math.sin(this.time * 23) * 0.035;
    fs.forEach((f, i) => this.fighters[i].update(f, dt, mode === 'fp' && i === me, flick));
    this.sparks.update(dt);
    this.flashLight.intensity *= Math.exp(-dt * 14);
    const target = Math.abs(this.shift - shift) > 0.0005 ? this.shift + (shift - this.shift) * Math.min(1, dt * 5) : shift;
    if (target !== this.shift) { this.shift = target; this.applyShift(); }

    const cam = this.camera, a = fs[me], b = fs[1 - me];
    const pos = _v, look = _w;
    if (mode === 'fp') {
      pos.set(0, 1.63, 0.1).applyQuaternion(a.bodyQ).add(a.pos);
      look.set(0, 1.28, 0).add(b.pos);
      this.camPos.copy(pos);
      this.camLook.lerp(look, Math.min(1, dt * 12));
    } else {
      if (mode === 'shoulder') {
        pos.set(0.55, 1.95, 1.75).applyQuaternion(a.bodyQ).add(a.pos);
        look.set(0, 1.15, 0).add(b.pos).lerp(a.pos, 0.25);
        look.y = 1.2;
      } else {
        this.orbit += dt * 0.07;
        const mid = _u.addVectors(a.pos, b.pos).multiplyScalar(0.5);
        pos.set(Math.cos(this.orbit) * 4.6 + mid.x, 2.1 + Math.sin(this.orbit * 0.7) * 0.4, Math.sin(this.orbit) * 4.6 + mid.z);
        look.set(mid.x, 1.15, mid.z);
      }
      this.camPos.lerp(pos, Math.min(1, dt * 3));
      this.camLook.lerp(look, Math.min(1, dt * 3));
    }
    cam.position.copy(this.camPos);
    if (this.shakeT > 0) {
      this.shakeT = Math.max(0, this.shakeT - dt);
      const k = this.shakeT * 0.12;
      cam.position.x += (Math.random() - 0.5) * k;
      cam.position.y += (Math.random() - 0.5) * k;
    }
    cam.lookAt(this.camLook);
  }
  render() { this.composer.render(); }
}
