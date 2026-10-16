// Effects: shield blast rings and sparks, ground puffs, and the camera springs (blast kick, landing dip, dodge roll, FOV punch).
//
//   const fx = new Fx(scene);
//   fx.blast({ pos, normal, dir, charge, hit })   fx.pop(pos, hex, size)   fx.land(speed)   fx.dodge(dir)   fx.respawn()
//   fx.update(dt, speed)                          fx.cam = { y, pitch, roll, fov } offsets for the camera this frame
import * as THREE from 'three';
import { softTexture } from './textures.js';
import { lin } from './merge.js';
import { DODGE } from '../sim/const.js';

const MAX_RINGS = 10, MAX_PARTS = 192;

// sparks: soft round points with their own colour, alpha and size (normal blending: additive vanishes on the bright maps)
const P_V = /* glsl */`
attribute vec4 aCol;
attribute float aSize;
uniform float uScale;
varying vec4 vCol;
void main() {
  vCol = aCol;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = max(1.0, aSize * uScale / max(0.1, -mv.z));
  gl_Position = projectionMatrix * mv;
}`;
const P_F = /* glsl */`
uniform sampler2D uMap;
varying vec4 vCol;
void main() {
  float a = texture2D(uMap, gl_PointCoord).a;
  gl_FragColor = vec4(vCol.rgb, vCol.a * a);
  #include <colorspace_fragment>
}`;

class Spring {
  constructor(k, d) { this.x = 0; this.v = 0; this.k = k; this.d = d; }
  step(dt) {
    let t = dt;
    while (t > 0) {
      const h = Math.min(t, 1 / 240);
      this.v += (-this.k * this.x - this.d * this.v) * h;
      this.x += this.v * h;
      t -= h;
    }
  }
  reset() { this.x = 0; this.v = 0; }
}

export class Fx {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.kick = new Spring(150, 17);
    this.dip = new Spring(120, 15);
    this.roll = new Spring(70, 10);
    this.fovS = new Spring(95, 12);
    this.cam = { y: 0, pitch: 0, roll: 0, fov: 0 };
    this.speedFov = 0;
    // rings
    this.ringGeo = new THREE.RingGeometry(0.78, 1, 44);
    this.rings = [];
    for (let i = 0; i < MAX_RINGS; i++) {
      const mat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, opacity: 0 });
      const mesh = new THREE.Mesh(this.ringGeo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.rings.push({ mesh, mat, t: 1, life: 0.4, s0: 0.3, s1: 1.5, k: 1 });
    }
    // sparks
    this.dotTex = softTexture();
    const g = new THREE.BufferGeometry();
    this.pp = new Float32Array(MAX_PARTS * 3); this.pc = new Float32Array(MAX_PARTS * 4); this.ps = new Float32Array(MAX_PARTS);
    this.pv = new Float32Array(MAX_PARTS * 3); this.pl = new Float32Array(MAX_PARTS); this.pt = new Float32Array(MAX_PARTS);
    this.pbase = new Float32Array(MAX_PARTS * 3);
    g.setAttribute('position', new THREE.BufferAttribute(this.pp, 3));
    g.setAttribute('aCol', new THREE.BufferAttribute(this.pc, 4));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.ps, 1));
    this.pmat = new THREE.ShaderMaterial({ uniforms: { uMap: { value: this.dotTex }, uScale: { value: 600 } }, vertexShader: P_V, fragmentShader: P_F, transparent: true, depthWrite: false });
    this.points = new THREE.Points(g, this.pmat);
    this.points.frustumCulled = false;
    this.group.add(this.points);
    this.pn = 0;
  }

  ring(pos, normal, hex, k, s0, s1, life) {
    let r = this.rings.find((x) => x.t >= 1) || this.rings.reduce((a, b) => (a.t > b.t ? a : b));
    r.t = 0; r.life = life; r.s0 = s0; r.s1 = s1; r.k = k;
    r.mat.color.setRGB(...lin(hex, hex === 0xffffff ? 2.2 : 1.1));
    r.mesh.position.set(pos[0], pos[1], pos[2]);
    r.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(normal[0], normal[1], normal[2]).normalize());
    r.mesh.visible = true;
  }

  spark(pos, vel, hex, life) {
    const i = this.pn++ % MAX_PARTS, c = lin(hex, 1.2);
    this.pp[i * 3] = pos[0]; this.pp[i * 3 + 1] = pos[1]; this.pp[i * 3 + 2] = pos[2];
    this.pv[i * 3] = vel[0]; this.pv[i * 3 + 1] = vel[1]; this.pv[i * 3 + 2] = vel[2];
    this.pbase[i * 3] = c[0]; this.pbase[i * 3 + 1] = c[1]; this.pbase[i * 3 + 2] = c[2];
    this.pl[i] = life; this.pt[i] = life; this.ps[i] = 0.09 + Math.random() * 0.09;
  }
  // pixels per world unit at distance 1 (for the point sizes); called by the renderer every frame
  setScale(px) { this.pmat.uniforms.uScale.value = px; }

  // ev = world 'blast' event { pos, normal | null, dir, charge, hit }
  blast(ev) {
    const c = Math.max(0, Math.min(1, ev.charge || 0));
    const hex = c > 0.6 ? 0x00c9b8 : 0x08b3a6;   // saturated: on the bright maps a pale ring would vanish
    const n = ev.normal || (ev.dir ? [-ev.dir[0], -ev.dir[1], -ev.dir[2]] : [0, 1, 0]);
    const p = ev.pos || [0, 0, 0];
    if (ev.hit !== false) {
      const off = [p[0] + n[0] * 0.04, p[1] + n[1] * 0.04, p[2] + n[2] * 0.04];
      this.ring(off, n, hex, 0.95, 0.25, 1.1 + 2.2 * c, 0.34 + 0.16 * c);
      this.ring(off, n, 0xffffff, 0.8, 0.1, 0.8 + 1.4 * c, 0.2);
      const count = 10 + Math.round(26 * c);
      for (let i = 0; i < count; i++) {
        const a = Math.random() * Math.PI * 2, b = Math.random() * 0.9 + 0.1, sp = 2 + Math.random() * (4 + 5 * c);
        // a cone around the surface normal
        const t1 = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
        const u = [t1[1] * n[2] - t1[2] * n[1], t1[2] * n[0] - t1[0] * n[2], t1[0] * n[1] - t1[1] * n[0]];
        const ul = Math.hypot(u[0], u[1], u[2]) || 1;
        u[0] /= ul; u[1] /= ul; u[2] /= ul;
        const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
        const sx = Math.cos(a) * b, sy = Math.sin(a) * b;
        this.spark(off, [(n[0] * 0.9 + u[0] * sx + v[0] * sy) * sp, (n[1] * 0.9 + u[1] * sx + v[1] * sy) * sp, (n[2] * 0.9 + u[2] * sx + v[2] * sy) * sp], hex, 0.35 + Math.random() * 0.35);
      }
    } else {
      this.ring(p, n, hex, 0.45, 0.2, 0.9 + 0.8 * c, 0.22);
    }
    this.kick.v += 1.7 + 3.4 * c;
    this.fovS.v += 30 + 70 * c;
  }

  pop(pos, hex = 0xffffff, size = 1.6, k = 0.5) { this.ring(pos, [0, 1, 0], hex, k, 0.3, size, 0.35); }
  land(speed, pos) {
    this.dip.v -= Math.min(7, Math.max(0, (speed - 3) * 0.5));
    if (speed > 6 && pos) this.pop([pos[0], pos[1] + 0.03, pos[2]], 0xdde6ee, 1 + Math.min(1.5, speed * 0.08), 0.35);
  }
  dodge(dir) {
    if (dir === DODGE.L) this.roll.v += 2.1; else if (dir === DODGE.R) this.roll.v -= 2.1;
    else if (dir === DODGE.F) this.kick.v -= 1.2; else this.kick.v += 1.2;
    this.fovS.v += 70;
  }
  respawn() { for (const s of [this.kick, this.dip, this.roll, this.fovS]) s.reset(); for (const r of this.rings) { r.t = 1; r.mesh.visible = false; } this.pl.fill(0); this.pt.fill(0); for (let i = 0; i < MAX_PARTS; i++) this.pc[i * 4 + 3] = 0; }

  update(dt, speed) {
    this.kick.step(dt); this.dip.step(dt); this.roll.step(dt); this.fovS.step(dt);
    const target = Math.max(0, Math.min(4, (speed - 9.5) * 0.45));
    this.speedFov += (target - this.speedFov) * Math.min(1, dt * 2.5);
    this.cam.y = Math.max(-0.22, this.dip.x * 0.012);
    this.cam.pitch = this.kick.x * 0.05;
    this.cam.roll = this.roll.x * 0.04;
    this.cam.fov = Math.max(-2, Math.min(8, this.fovS.x * 0.07)) + this.speedFov;
    for (const r of this.rings) {
      if (r.t >= 1) { r.mesh.visible = false; continue; }
      r.t = Math.min(1, r.t + dt / r.life);
      const e = 1 - Math.pow(1 - r.t, 3);
      r.mesh.scale.setScalar(r.s0 + (r.s1 - r.s0) * e);
      r.mat.opacity = Math.pow(1 - r.t, 1.4) * r.k;
    }
    let live = false;
    for (let i = 0; i < MAX_PARTS; i++) {
      if (this.pl[i] <= 0) { this.pc[i * 4 + 3] = 0; continue; }
      live = true;
      this.pl[i] -= dt;
      const f = Math.max(0, this.pl[i] / this.pt[i]);
      this.pv[i * 3 + 1] -= 9 * dt;
      const drag = 1 - Math.min(1, 2.2 * dt);
      this.pv[i * 3] *= drag; this.pv[i * 3 + 1] *= drag; this.pv[i * 3 + 2] *= drag;
      this.pp[i * 3] += this.pv[i * 3] * dt; this.pp[i * 3 + 1] += this.pv[i * 3 + 1] * dt; this.pp[i * 3 + 2] += this.pv[i * 3 + 2] * dt;
      this.pc[i * 4] = this.pbase[i * 3]; this.pc[i * 4 + 1] = this.pbase[i * 3 + 1]; this.pc[i * 4 + 2] = this.pbase[i * 3 + 2]; this.pc[i * 4 + 3] = Math.min(1, f * 1.6);
    }
    if (live || this.wasLive) {
      const g = this.points.geometry;
      g.attributes.position.needsUpdate = true; g.attributes.aCol.needsUpdate = true; g.attributes.aSize.needsUpdate = true;
    }
    this.wasLive = live;
  }

  dispose() {
    this.scene.remove(this.group);
    this.ringGeo.dispose();
    for (const r of this.rings) r.mat.dispose();
    this.points.geometry.dispose(); this.pmat.dispose(); this.dotTex.dispose();
  }
}
