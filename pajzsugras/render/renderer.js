// The renderer facade: WebGLRenderer, camera, post-processing chain, and the scene parts (sky, level, figures, fx, viewmodel).
//
//   const gfx = new Gfx(canvas, settings);
//   await gfx.loadMap(world.map, onProgress)     builds sky + level (textures, merged meshes); replaces the previous map
//   gfx.setQuality('alacsony' | 'kozepes' | 'magas')   pixel ratio, shadows, bloom / composer, texture size; rebuilds the level
//   gfx.setFov(horizontalDegrees)  gfx.resize()
//   gfx.frame({ dt, t, world, alpha, look: { yaw, pitch }, mode: 'play' | 'menu', speed, vm: {...} })
//   gfx.fx / gfx.figures / gfx.level / gfx.viewmodel / gfx.sky
//
// Quality levels
//   alacsony  no composer (direct render, native MSAA), pixel ratio 1, no shadows, no normal maps, 256 px textures, no env map
//   kozepes   composer (bloom + ACES + vignette + SMAA), pixel ratio <= 1.25, 1024 shadow map (72 m box), 512 px textures
//   magas     composer with 4x MSAA (no SMAA), pixel ratio <= 2, 2048 shadow map, 16x anisotropy
import * as THREE from 'three';
import { EffectComposer, RenderPass, EffectPass, BloomEffect, SMAAEffect, ToneMappingEffect, ToneMappingMode, VignetteEffect } from 'postprocessing';
import { Level } from './level.js';
import { Sky } from './sky.js';
import { Fx } from './fx.js';
import { Figures } from './figures.js';
import { Viewmodel } from './viewmodel.js';
import { ensureFonts } from './textures.js';
import { EYE } from '../sim/const.js';

const DEG = Math.PI / 180;

export class Gfx {
  constructor(canvas, settings) {
    this.canvas = canvas;
    this.q = settings.quality || 'kozepes';
    this.hfov = settings.fov || 100;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', alpha: false, stencil: false });
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.info.autoReset = false;   // reset by hand in draw(): the numbers then cover every pass of the frame
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.06, 2400);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);
    this.sky = new Sky(this.scene, this.renderer, this.q);
    this.fx = new Fx(this.scene);
    this.figures = new Figures(this.scene);
    this.viewmodel = new Viewmodel();
    this.level = null;
    this.map = null;
    this.composer = null;
    this.bloom = null;
    this.bloomK = 0.6;
    this.tmp = { pos: [0, 0, 0], yaw: 0, pitch: 0 };
    this.ppos = new THREE.Vector3();
    this.lastFrameMs = 16;
    this.applyQuality();
    this.resize();
  }

  // ---------------------------------------------------------------- size / quality
  pixelRatio() {
    const d = window.devicePixelRatio || 1;
    return this.q === 'alacsony' ? 1 : this.q === 'kozepes' ? Math.min(d, 1.25) : Math.min(d, 2);
  }
  resize() {
    const w = Math.max(2, window.innerWidth), h = Math.max(2, window.innerHeight);
    this.renderer.setPixelRatio(this.pixelRatio());
    this.renderer.setSize(w, h, false);
    if (this.composer) this.composer.setSize(w, h, false);
    this.aspect = w / h;
    this.camera.aspect = this.aspect;
    this.viewmodel.resize(this.aspect);
    this.updateFov(0);
  }
  setFov(h) { this.hfov = h; this.updateFov(0); }
  updateFov(extra) {
    const hf = this.hfov * DEG;
    const vf = 2 * Math.atan(Math.tan(hf / 2) / this.aspect) / DEG + extra;
    this.camera.fov = Math.max(30, Math.min(125, vf));
    this.camera.updateProjectionMatrix();
  }

  applyQuality() {
    const r = this.renderer, q = this.q;
    r.shadowMap.enabled = q !== 'alacsony';
    if (this.composer) { this.composer.dispose(); this.composer = null; }
    if (q === 'alacsony') {
      r.toneMapping = THREE.ACESFilmicToneMapping;
      r.autoClear = false;   // draw() clears by hand: the gun is a second render on top
    } else {
      r.toneMapping = THREE.NoToneMapping;
      const composer = new EffectComposer(r, { frameBufferType: THREE.HalfFloatType, multisampling: q === 'magas' ? 4 : 0 });
      composer.addPass(new RenderPass(this.scene, this.camera));
      const vmPass = new RenderPass(this.viewmodel.scene, this.viewmodel.camera);
      vmPass.clearPass.setClearFlags(false, true, false);   // only the depth: the gun is drawn over the world
      composer.addPass(vmPass);
      this.bloom = new BloomEffect({ mipmapBlur: true, luminanceThreshold: 0.8, luminanceSmoothing: 0.25, intensity: this.bloomK * 0.9, radius: 0.72 });
      composer.addPass(new EffectPass(this.camera, this.bloom, new VignetteEffect({ darkness: 0.42, offset: 0.32 }), new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC })));
      if (q === 'kozepes') composer.addPass(new EffectPass(this.camera, new SMAAEffect()));
      this.composer = composer;
    }
    this.sky.setQuality(q);
  }

  async setQuality(q) {
    if (q === this.q) return;
    this.q = q;
    this.applyQuality();
    this.resize();
    if (this.map) await this.loadMap(this.map);
  }

  setBloom(k) {
    this.bloomK = k;
    if (this.bloom) this.bloom.intensity = k * 0.9;
  }

  // ---------------------------------------------------------------- map
  async loadMap(map, onProgress = () => {}) {
    await ensureFonts();
    if (this.level) { this.scene.remove(this.level.group); this.level.dispose(); this.level = null; }
    this.figures.clear();
    this.map = map;
    onProgress(0.02, 'Égbolt');
    this.sky.setTheme(map.theme);
    this.viewmodel.setEnvironment(this.scene.environment);
    this.viewmodel.setTheme(map.theme);
    this.setBloom(map.theme.bloom);
    const level = new Level(map, { quality: this.q, maxAniso: this.renderer.capabilities.getMaxAnisotropy() });
    await level.build(onProgress);
    this.level = level;
    this.scene.add(level.group);
    onProgress(0.97, 'Shaderek');
    try { await this.renderer.compileAsync(this.scene, this.camera); } catch { /* compiled on first use */ }
    onProgress(1, 'Kész');
  }

  // ---------------------------------------------------------------- per frame
  // opts: dt, t, world, alpha, look { yaw, pitch } (radians), mode 'play' | 'menu', menuT, speed, vm { charge, charging, speed, grounded, vy, look, hidden }
  frame(o) {
    const cam = this.camera, { dt, t, world } = o;
    const w = world;
    if (o.mode === 'menu' || !w) {
      this.menuCamera(o.menuT || 0);
      this.ppos.copy(cam.position);
    } else {
      const p = w.lerp(o.alpha, this.tmp);
      this.fx.update(dt, o.speed || 0);
      cam.position.set(p.pos[0], p.pos[1] + EYE + this.fx.cam.y, p.pos[2]);
      cam.rotation.set(o.look.pitch + this.fx.cam.pitch, o.look.yaw, this.fx.cam.roll);
      this.updateFov(this.fx.cam.fov);
      this.ppos.set(p.pos[0], p.pos[1] + 1, p.pos[2]);
    }
    if (o.mode === 'menu') this.fx.update(dt, 0);
    if (this.level && w) this.level.update(w, o.alpha ?? 1, t, dt, cam.position);
    this.sky.update(cam.position, this.ppos, t);
    this.figures.update(dt, cam);
    this.viewmodel.update(dt, t, { ...o.vm, hidden: o.mode === 'menu' || !!(o.vm && o.vm.hidden) });
    cam.updateMatrixWorld();
    this.fx.setScale((this.renderer.domElement.height * 0.5) / Math.tan((cam.fov * DEG) / 2));
    this.draw(dt);
  }

  menuCamera(mt) {
    const m = this.map, cam = this.camera;
    if (!m) return;
    const s = m.start.pos, b = m.bounds;
    const size = Math.hypot(b.max[0] - b.min[0], b.max[2] - b.min[2]);
    const r = Math.max(9, Math.min(20, size * 0.12));
    const a = (m.start.yaw * DEG) + Math.PI + 0.5 + Math.sin(mt * 0.08) * 0.7;
    cam.position.set(s[0] + Math.sin(a) * r, s[1] + 5.5 + Math.sin(mt * 0.13) * 1.2, s[2] + Math.cos(a) * r);
    cam.lookAt(s[0] - Math.sin(m.start.yaw * DEG) * 8, s[1] + 2.2, s[2] - Math.cos(m.start.yaw * DEG) * 8);
    this.updateFov(0);
  }

  draw(dt) {
    const r = this.renderer;
    r.info.reset();
    if (this.composer) this.composer.render(dt);
    else {
      r.clear();
      r.render(this.scene, this.camera);
      r.clearDepth();
      r.render(this.viewmodel.scene, this.viewmodel.camera);
    }
  }

  info() {
    const i = this.renderer.info;
    return { calls: i.render.calls, triangles: i.render.triangles, geometries: i.memory.geometries, textures: i.memory.textures, programs: i.programs ? i.programs.length : 0 };
  }

  screenshot(type = 'image/jpeg', q = 0.85) { return this.canvas.toDataURL(type, q); }
}
