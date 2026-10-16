// The first person shield gun. It lives in its own scene with its own camera (fixed field of view, depth cleared), so it
// never clips into walls and keeps its shape at any FOV setting. The renderer draws it after the world (still before the
// bloom, so the core glows).
//
//   const vm = new Viewmodel();   vm.scene / vm.camera / vm.resize(aspect) / vm.setEnvironment(tex) / vm.setTheme(theme)
//   vm.update(dt, t, { charge, charging, speed, grounded, vy, look: [dyaw, dpitch], hidden })
//   vm.onBlast(charge)  vm.onLand(speed)  vm.onJump()  vm.onDodge(dir)  vm.onRespawn()
import * as THREE from 'three';
import { lin } from './merge.js';
import { DODGE } from '../sim/const.js';

class Spring {
  constructor(k, d) { this.x = 0; this.v = 0; this.k = k; this.d = d; }
  step(dt) {
    let t = dt;
    while (t > 0) { const h = Math.min(t, 1 / 240); this.v += (-this.k * this.x - this.d * this.v) * h; this.x += this.v * h; t -= h; }
  }
}

const BUBBLE_V = /* glsl */`
varying vec3 vN, vV;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;
const BUBBLE_F = /* glsl */`
uniform vec3 uColor;
uniform float uA, uTime;
varying vec3 vN, vV;
void main() {
  float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.0);
  float bands = 0.75 + 0.25 * sin(vN.y * 26.0 + uTime * 6.0);
  gl_FragColor = vec4(uColor * (f * 1.7 + 0.14) * bands, (f * 0.9 + 0.08) * uA);
  #include <colorspace_fragment>
}`;

export class Viewmodel {
  constructor() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(58, 16 / 9, 0.02, 6);
    this.hemi = new THREE.HemisphereLight(0xdfeaff, 0x556070, 1.8);
    this.key = new THREE.DirectionalLight(0xffffff, 2.4);
    this.key.position.set(0.6, 1, 0.5);
    this.coreLight = new THREE.PointLight(0x40e8d4, 0, 1.2, 2);
    this.scene.add(this.hemi, this.key, this.coreLight);

    const metal = new THREE.MeshStandardMaterial({ color: 0x3a444c, metalness: 0.8, roughness: 0.34 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1b2127, metalness: 0.6, roughness: 0.5 });
    const orange = new THREE.MeshStandardMaterial({ color: 0xff8a2a, metalness: 0.35, roughness: 0.42 });
    this.coreMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(...lin(0x40e8d4, 3)) });
    this.trimMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(...lin(0x40e8d4, 2.2)) });
    this.glowMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(...lin(0x40e8d4, 2)), transparent: true, opacity: 0.3, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    this.bubbleMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(...lin(0x50f0e0, 1)) }, uA: { value: 0 }, uTime: { value: 0 } },
      vertexShader: BUBBLE_V, fragmentShader: BUBBLE_F, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });

    const root = new THREE.Group();   // placement + bob + recoil
    const gun = new THREE.Group();
    root.add(gun);
    this.scene.add(root);
    this.root = root;
    this.gun = gun;
    const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0, parent = gun) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z); m.rotation.set(rx, ry, rz);
      parent.add(m);
      return m;
    };
    // body: a tube with the housing, plates and the forearm
    add(new THREE.CylinderGeometry(0.04, 0.046, 0.34, 18), metal, 0, 0, -0.04, Math.PI / 2);
    add(new THREE.BoxGeometry(0.1, 0.085, 0.17), metal, 0, -0.005, 0.02);
    add(new THREE.BoxGeometry(0.012, 0.072, 0.14), orange, 0.057, -0.004, 0.02);
    add(new THREE.BoxGeometry(0.012, 0.072, 0.14), orange, -0.057, -0.004, 0.02);
    add(new THREE.BoxGeometry(0.07, 0.014, 0.15), orange, 0, 0.046, 0.02);
    add(new THREE.BoxGeometry(0.012, 0.004, 0.13), this.trimMat, 0, 0.0545, 0.02);
    add(new THREE.CylinderGeometry(0.052, 0.052, 0.03, 18), orange, 0, 0, -0.1, Math.PI / 2);
    add(new THREE.CylinderGeometry(0.056, 0.056, 0.012, 18), dark, 0, 0, -0.118, Math.PI / 2);
    add(new THREE.CylinderGeometry(0.052, 0.062, 0.34, 14), dark, 0.03, -0.1, 0.27, 1.05, 0, 0.08);
    add(new THREE.CylinderGeometry(0.066, 0.066, 0.03, 14), orange, 0.02, -0.07, 0.17, 1.05, 0, 0.08);
    // the emitter dish, front = -z; we look at its back
    const em = new THREE.Group();
    em.position.set(0, 0, -0.27);
    gun.add(em);
    this.em = em;
    add(new THREE.CylinderGeometry(0.085, 0.125, 0.045, 32), metal, 0, 0, 0, Math.PI / 2, 0, 0, em);
    add(new THREE.TorusGeometry(0.128, 0.011, 8, 40), orange, 0, 0, -0.022, 0, 0, 0, em);
    add(new THREE.TorusGeometry(0.095, 0.006, 8, 36), this.trimMat, 0, 0, 0.026, 0, 0, 0, em);
    this.core = add(new THREE.SphereGeometry(0.036, 18, 12), this.coreMat, 0, 0, 0.03, 0, 0, 0, em);
    this.disc = add(new THREE.CircleGeometry(0.14, 32), this.glowMat, 0, 0, 0.034, 0, 0, 0, em);
    // prongs around the rim
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 0.5;
      add(new THREE.BoxGeometry(0.014, 0.014, 0.09), dark, Math.cos(a) * 0.12, Math.sin(a) * 0.12, -0.05, 0, 0, 0, em);
      add(new THREE.SphereGeometry(0.01, 8, 6), this.trimMat, Math.cos(a) * 0.12, Math.sin(a) * 0.12, -0.098, 0, 0, 0, em);
    }
    // spinning ring of energy lights
    this.orbit = new THREE.Group();
    em.add(this.orbit);
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      add(new THREE.BoxGeometry(0.016, 0.016, 0.016), this.trimMat, Math.cos(a) * 0.145, Math.sin(a) * 0.145, 0.0, 0, 0, a, this.orbit);
    }
    // the shield bubble in front of the dish
    this.bubble = new THREE.Mesh(new THREE.SphereGeometry(0.19, 28, 18, 0, Math.PI * 2, 0, Math.PI / 2), this.bubbleMat);
    this.bubble.rotation.x = -Math.PI / 2;
    this.bubble.position.z = -0.03;
    em.add(this.bubble);
    // muzzle flash
    this.flashMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(...lin(0xb8fff4, 3)), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    this.flash = add(new THREE.CircleGeometry(0.2, 24), this.flashMat, 0, 0, -0.07, 0, 0, 0, em);
    this.base = new THREE.Vector3(0.2, -0.205, -0.44);
    root.position.copy(this.base);
    root.scale.setScalar(0.62);
    gun.rotation.set(0.03, 0.06, 0);

    this.recoil = new Spring(230, 19);
    this.gdip = new Spring(140, 14);
    this.hop = new Spring(170, 16);
    this.tilt = new Spring(120, 12);
    this.phase = 0;
    this.sway = [0, 0];
    this.ch = 0;
    this.flashT = 0;
    this.appear = 1;
    this.spin = 0;
    this.speedSm = 0;
  }

  resize(aspect) { this.camera.aspect = aspect; this.camera.updateProjectionMatrix(); }
  setEnvironment(tex) { this.scene.environment = tex; this.scene.environmentIntensity = 0.7; }
  setTheme(theme) {
    this.hemi.color.setHex(theme.hemi.sky); this.hemi.groundColor.setHex(theme.hemi.ground);
    this.key.color.setHex(theme.sun.color);
  }

  onBlast(charge) { this.recoil.v += 3.2 + 4.2 * charge; this.flashT = 1; this.hop.v += 0.4; }
  onLand(speed) { this.gdip.v -= Math.min(1.8, Math.max(0, (speed - 3) * 0.14)); }
  onJump() { this.hop.v += 0.45; }
  onDodge(dir) { this.tilt.v += dir === DODGE.L ? -2.4 : dir === DODGE.R ? 2.4 : 0; this.gdip.v -= dir === DODGE.F ? 0.8 : 0; }
  onRespawn() { this.appear = 0; this.recoil.x = 0; this.recoil.v = 0; }

  update(dt, t, st) {
    this.root.visible = !st.hidden;
    if (st.hidden) return;
    this.appear = Math.min(1, this.appear + dt * 3);
    this.recoil.step(dt); this.gdip.step(dt); this.hop.step(dt); this.tilt.step(dt);
    // charge smoothing
    const target = st.charging ? st.charge : 0;
    this.ch += (target - this.ch) * Math.min(1, dt * (target > this.ch ? 14 : 8));
    const c = this.ch;
    this.flashT = Math.max(0, this.flashT - dt * 9);
    // bob while running on the ground
    this.speedSm += (Math.min(st.speed, 14) - this.speedSm) * Math.min(1, dt * 8);
    if (st.grounded) this.phase += dt * (3.2 + this.speedSm * 0.62);
    const amp = st.grounded ? Math.min(1, this.speedSm / 8.8) : 0;
    const bx = Math.sin(this.phase) * 0.0075 * amp, by = Math.abs(Math.sin(this.phase)) * -0.007 * amp;
    // sway: the gun lags behind the look
    const k = Math.exp(-dt * 9);
    this.sway[0] = Math.max(-0.05, Math.min(0.05, this.sway[0] * k + (st.look ? st.look[0] : 0) * 0.55));
    this.sway[1] = Math.max(-0.04, Math.min(0.04, this.sway[1] * k + (st.look ? st.look[1] : 0) * 0.5));
    const vy = Math.max(-0.02, Math.min(0.02, -(st.vy || 0) * 0.0012));
    const shake = c * 0.0018;
    const rr = () => (Math.random() - 0.5) * shake;
    this.root.position.set(
      this.base.x + bx + this.sway[0] + rr() + Math.sin(t * 1.3) * 0.0012,
      this.base.y + by + this.sway[1] + vy - this.gdip.x * 0.02 + this.hop.x * 0.012 - (1 - this.appear) * 0.28 + Math.sin(t * 1.7) * 0.0014 + rr(),
      this.base.z + this.recoil.x * 0.016 + c * 0.022,
    );
    this.root.rotation.set(this.recoil.x * 0.05 - this.sway[1] * 0.6 - (1 - this.appear) * 0.6, -this.sway[0] * 1.2, this.tilt.x * 0.05 - this.sway[0] * 0.6);
    // charge visuals
    this.spin += dt * (1.5 + 15 * c + (this.flashT > 0 ? 6 : 0));
    this.orbit.rotation.z = this.spin;
    const hot = new THREE.Color().setRGB(...lin(0x40e8d4, 3 + 5 * c)).lerp(new THREE.Color(8, 8, 8), Math.pow(c, 3) * 0.7);
    this.coreMat.color.copy(hot);
    this.core.scale.setScalar(1 + c * 0.9 + this.flashT * 0.8);
    this.trimMat.color.setRGB(...lin(c > 0.7 ? 0xb8fff4 : 0x40e8d4, 2.2 + 2.5 * c));
    this.glowMat.opacity = 0.25 + 0.55 * c + 0.4 * this.flashT;
    this.disc.scale.setScalar(0.8 + 0.5 * c + 0.4 * this.flashT);
    this.bubbleMat.uniforms.uA.value = c > 0.02 ? 0.35 + 0.65 * c : 0;
    this.bubbleMat.uniforms.uTime.value = t;
    this.bubble.scale.setScalar(0.45 + 0.75 * c);
    this.bubble.visible = c > 0.02;
    this.flashMat.opacity = this.flashT * 0.9;
    this.flash.scale.setScalar(0.6 + (1 - this.flashT) * 1.4);
    this.coreLight.intensity = 0.1 + c * 2.4 + this.flashT * 3;
    this.coreLight.position.copy(this.root.position).add(new THREE.Vector3(0, 0, -0.3));
  }

  dispose() {
    this.scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  }
}
