// The first person weapon: PAJZSUGRÁS' own shield gauntlet (gauntlet.js) on an armoured forearm. It lives in its own scene with its own camera (fixed
// field of view, depth cleared), so it never clips into walls and keeps its shape at any FOV setting. The renderer draws it after the world (still
// before the bloom, so the glow blooms).
//
//   const vm = new Viewmodel();   vm.scene / vm.camera / vm.resize(aspect) / vm.setEnvironment(tex) / vm.setTheme(theme)
//   vm.update(dt, t, { charge, charging, speed, grounded, vy, look: [dyaw, dpitch], hidden })
//   vm.onBlast(charge)  vm.onLand(speed)  vm.onJump()  vm.onDodge(dir)  vm.onRespawn()
//   vm.info() -> { ut: is the UT2004 gun in use, state, clip, ... }   (__pj.state().viewmodel)
// What the gauntlet does with the shield (gauntlet.js): the prongs open up to 10 degrees with the charge and snap shut on a blast, a micro-shake grows
// with the charge, the fins glow after a blast and cool over 0.6 s, the power cell pulses. This file adds the first person parts: the placement in the
// view, the bob / sway / recoil springs, the shield bubble and the muzzle flash that hang on the muzzle, and the charge light.
// Only on a dev build served from this machine (local-ut.js) the owner's UT2004 shield gun can replace it (useUT, called by renderer.js after it has
// loaded shieldgun.js through ut-gun.js); the bubble, the flash and the muzzle glow stay either way.
import * as THREE from 'three';
import { lin } from './merge.js';
import { DODGE } from '../sim/const.js';
import { buildGauntlet } from './gauntlet.js';
import { utMod } from './ut-gun.js';

// where the gauntlet sits: real size (metres), the muzzle plane at z = 0 of its own frame. The arm comes in from the lower right: the gauntlet is turned a
// little towards the middle and its muzzle tilted up, so the forearm runs off the bottom of the screen and mostly the emitter head shows. shift: the picture
// moves right / down by this part of the view (a lens shift of the viewmodel camera, so the gauntlet keeps its shape and only its far end is off screen).
const GAUNTLET = { base: [0.06, -0.12, -0.5], rot: [0.25, 0.38, 0.08], scale: 1, shift: [0.08, 0.03] };

// where the UT2004 gun sits: its sequences carry the placement in the view (right, low, forward; UT units of 2 cm at scale 1, the camera at the
// origin), so a scale about the camera changes nothing but the near clipping: the gun is pushed forward (base) to its place at the lower right,
// 0.4 m from the camera at the nearest (the gun's own scene never clips into walls).
// GROW: the gun is drawn this much bigger around its own centre (UT_CENTRE: where the Idle gun's vertices average out, camera space), which on
// the screen is exactly the same as bringing it closer to the camera: 1.15 for a bigger model x 1.13 for closer = 1.3, as the user asked.
// shift: the picture of the gun moves right / down by this part of the view (a lens shift of the viewmodel camera, so the gun looks the same,
// only its grip is off screen and mostly the head shows in the lower right corner).
const UT_BASE = [0.06, -0.01, -0.36], UT_CENTRE = [0.226, -0.097, -0.764], UT_GROW = 1.3;
const UT = {
  scale: 0.3, base: UT_BASE.map((b, i) => b * UT_GROW + UT_CENTRE[i] * (1 - UT_GROW)), rootScale: UT_GROW, rot: [0, 0, 0], shift: [0.2, 0.13],
};

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
    // the gauntlet (the muzzle plane is the origin of its group, it extends back along +z)
    this.gauntlet = buildGauntlet({ lod: 'fp' });
    this.parts = this.gauntlet.parts;
    gun.add(this.gauntlet.group);
    // what glows at the muzzle (the halo, the shield bubble, the muzzle flash) has its own group, so it can follow the UT2004 gun's muzzle bone instead
    const fx = new THREE.Group();
    fx.position.copy(this.parts.muzzle.position);
    gun.add(fx);
    this.fx = fx;
    this.glow = this.parts.glow;
    // the shield bubble in front of the muzzle
    this.bubble = new THREE.Mesh(new THREE.SphereGeometry(0.2, 32, 20, 0, Math.PI * 2, 0, Math.PI / 2), this.bubbleMat);
    this.bubble.rotation.x = -Math.PI / 2;
    this.bubble.position.z = -0.03;
    fx.add(this.bubble);
    // muzzle flash
    this.flashMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(...lin(0xb8fff4, 3)), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    this.flash = new THREE.Mesh(new THREE.CircleGeometry(0.24, 28), this.flashMat);
    this.flash.position.z = -0.09;
    fx.add(this.flash);
    this.base = new THREE.Vector3(...GAUNTLET.base);
    root.position.copy(this.base);
    root.scale.setScalar(GAUNTLET.scale);
    gun.rotation.set(...GAUNTLET.rot);

    this.recoil = new Spring(230, 19);
    this.gdip = new Spring(140, 14);
    this.hop = new Spring(170, 16);
    this.tilt = new Spring(120, 12);
    this.phase = 0;
    this.sway = [0, 0];
    this.ch = 0;
    this.flashT = 0;
    this.appear = 1;
    this.speedSm = 0;
    this.ut = null;   // { group, anim, muzzle, mod } while the UT2004 gun is in use
    this.vec = new THREE.Vector3();
    this.disposed = false;
  }

  // The UT2004 shield gun instead of the gauntlet: a clone of the template with its own materials, driven by a GunAnim. Needs shieldgun.js to be
  // loaded (ut-gun.js); renderer.js calls it when the template arrives. The gauntlet's muzzle halo moves over to the gun's muzzle.
  useUT(tpl) {
    const m = utMod();
    if (this.ut || !tpl || !m) return;
    const group = tpl.clone(tpl.scene);
    group.name = 'ut-gun-first';
    group.scale.setScalar(UT.scale);
    group.traverse((o) => {
      if (!o.isSkinnedMesh) return;
      o.material = m.gunMaterial({ map: o.material.map });
      o.material.envMapIntensity = 0.8;
    });
    this.gun.add(group);
    this.gauntlet.group.visible = false;
    this.fx.add(this.glow);
    this.glow.position.set(0, 0, 0);
    this.base.set(...UT.base);
    this.root.scale.setScalar(UT.rootScale);
    this.gun.rotation.set(...UT.rot);
    this.ut = { group, anim: new m.GunAnim(group, tpl.clips), muzzle: group.getObjectByName(m.MUZZLE_BONE) || null };
    this.resize(this.camera.aspect);
  }

  // back to the gauntlet (the setting was switched off)
  dropUT() {
    const ut = this.ut;
    if (!ut) return;
    this.ut = null;
    ut.anim.dispose();
    ut.group.traverse((o) => { if (o.isSkinnedMesh) { o.skeleton.dispose(); if (o.material) o.material.dispose(); } });
    ut.group.removeFromParent();
    this.gauntlet.group.visible = true;
    this.gauntlet.group.add(this.glow);
    this.glow.position.set(0, 0, -0.004);
    this.fx.position.copy(this.parts.muzzle.position);
    this.base.set(...GAUNTLET.base);
    this.root.scale.setScalar(GAUNTLET.scale);
    this.gun.rotation.set(...GAUNTLET.rot);
    this.resize(this.camera.aspect);
  }

  resize(aspect) {
    const c = this.camera, sh = this.ut ? UT.shift : GAUNTLET.shift;
    c.aspect = aspect;
    c.setViewOffset(aspect, 1, -sh[0] * aspect, -sh[1], aspect, 1);   // also updates the projection
  }
  setEnvironment(tex) { this.scene.environment = tex; this.scene.environmentIntensity = 0.7; }
  setTheme(theme) {
    this.hemi.color.setHex(theme.hemi.sky); this.hemi.groundColor.setHex(theme.hemi.ground);
    this.key.color.setHex(theme.sun.color);
  }

  onBlast(charge) { this.recoil.v += 3.2 + 4.2 * charge; this.flashT = 1; this.hop.v += 0.4; this.gauntlet.fire(); if (this.ut) this.ut.anim.fire(); }
  onLand(speed) { this.gdip.v -= Math.min(1.8, Math.max(0, (speed - 3) * 0.14)); }
  onJump() { this.hop.v += 0.45; }
  onDodge(dir) { this.tilt.v += dir === DODGE.L ? -2.4 : dir === DODGE.R ? 2.4 : 0; this.gdip.v -= dir === DODGE.F ? 0.8 : 0; }
  onRespawn() { this.appear = 0; this.recoil.x = 0; this.recoil.v = 0; if (this.ut) this.ut.anim.select(); }

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
    // sway: the gauntlet lags behind the look
    const k = Math.exp(-dt * 9);
    this.sway[0] = Math.max(-0.05, Math.min(0.05, this.sway[0] * k + (st.look ? st.look[0] : 0) * 0.55));
    this.sway[1] = Math.max(-0.04, Math.min(0.04, this.sway[1] * k + (st.look ? st.look[1] : 0) * 0.5));
    const vy = Math.max(-0.02, Math.min(0.02, -(st.vy || 0) * 0.0012));
    this.root.position.set(
      this.base.x + bx + this.sway[0] + Math.sin(t * 1.3) * 0.0012,
      this.base.y + by + this.sway[1] + vy - this.gdip.x * 0.02 + this.hop.x * 0.012 - (1 - this.appear) * 0.28 + Math.sin(t * 1.7) * 0.0014,
      this.base.z + this.recoil.x * 0.016 + c * 0.022,
    );
    this.root.rotation.set(this.recoil.x * 0.05 - this.sway[1] * 0.6 - (1 - this.appear) * 0.6, -this.sway[0] * 1.2, this.tilt.x * 0.05 - this.sway[0] * 0.6);
    // the gauntlet's own behaviour (prongs, rings, core, cell, fins, micro-shake) and what hangs on the muzzle
    this.gauntlet.update(dt, t, { charge: c, flash: this.flashT, quiet: !!this.ut });
    this.bubbleMat.uniforms.uA.value = c > 0.02 ? 0.35 + 0.65 * c : 0;
    this.bubbleMat.uniforms.uTime.value = t;
    this.bubble.scale.setScalar(0.45 + 0.75 * c);
    this.bubble.visible = c > 0.02;
    this.flashMat.opacity = this.flashT * 0.9;
    this.flash.scale.setScalar(0.6 + (1 - this.flashT) * 1.4);
    this.coreLight.intensity = 0.1 + c * 2.4 + this.flashT * 3;
    if (this.ut) this.updateUT(dt, st, c);
    else {
      // (the charge light sits just in front of the muzzle)
      this.root.updateMatrixWorld(true);
      this.parts.muzzle.getWorldPosition(this.vec);
      this.coreLight.position.copy(this.vec);
      this.coreLight.position.z -= 0.05;
    }
  }

  // the UT2004 gun: its sequences follow the shield state, the glow group follows the muzzle bone
  updateUT(dt, st, c) {
    const ut = this.ut;
    ut.anim.update(dt, { charging: !!st.charging, charge: c });
    if (!ut.muzzle) return;
    this.root.updateMatrixWorld(true);
    ut.muzzle.getWorldPosition(this.vec);
    this.coreLight.position.copy(this.vec);   // (the charge light sits at the muzzle too)
    this.gun.worldToLocal(this.vec);
    this.fx.position.copy(this.vec);
  }

  // what the gun is (__pj.state().viewmodel): ut = the UT2004 model, with the sequence it plays
  info() {
    return { ut: !!this.ut, ...(this.ut ? this.ut.anim.info() : { state: null, clip: null, time: 0, charge: 0, active: [] }), hidden: !this.root.visible };
  }

  dispose() {
    this.disposed = true;
    if (this.ut) { this.ut.anim.dispose(); this.ut.group.traverse((o) => { if (o.isSkinnedMesh) o.skeleton.dispose(); }); this.ut = null; }   // (the template's geometry and textures are shared: the scene walk below skips them)
    this.gauntlet.dispose();
    this.scene.traverse((o) => { if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose(); if (o.material && !o.material.userData.shared) o.material.dispose(); });
  }
}
