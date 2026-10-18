// The renderer facade: WebGLRenderer, camera, post-processing chain, and the scene parts (sky, level, figures, fx, viewmodel).
//
//   const gfx = new Gfx(canvas, settings);
//   await gfx.loadMap(world.map, onProgress)     builds sky + level (textures, merged meshes); replaces the previous map
//   gfx.setQuality('alacsony' | 'kozepes' | 'magas')   pixel ratio, shadows, bloom / composer, texture size; rebuilds the level
//   gfx.setFov(horizontalDegrees)  gfx.resize()
//   await gfx.rebuildLevel(map, { warm })   the editor's quick swap: a new level (shared Surfaces, no UI yields) replaces the current
//                                           one; a different theme redoes the sky; warm: make every material of map.materials first
//   gfx.frame({ dt, t, world, alpha, look: { yaw, pitch }, mode: 'play' | 'menu' | 'editor', cam: { pos, yaw, pitch } (editor), speed, vm: {...},
//               view: 'belso' | 'kulso', me: { name, color } })
//     view 'kulso' (play mode only): the camera orbits the head behind the player (chasecam.js, kept out of the walls with the sim's collision
//     world) and the player's own figure is drawn (figure id SELF, a Gorge or the robot, driven by the interpolated sim state); the gun is hidden
//   gfx.cameraInfo() -> { view, pos, yawDeg, pitchDeg, dist, limit, want, hit, hidden, self }   what the camera does (__pj.state().camera)
//   gfx.fx / gfx.figures / gfx.level / gfx.viewmodel / gfx.sky / gfx.chase
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
import { ChaseCam } from './chasecam.js';
import { ensureFonts } from './textures.js';
import { utGun } from './ut-gun.js';
import { EYE } from '../sim/const.js';

const DEG = Math.PI / 180;
export const SELF = '__me';   // the figure id of the local player in the third-person view

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
    this.chase = new ChaseCam();
    this.third = false;
    this.spawns = 0;   // world.spawns of the last frame: a change = a respawn / restart / teleport
    this.eye = [0, 0, 0];
    this.level = null;
    this.retired = [];   // levels (and Surfaces) swapped out by rebuildLevel, disposed after the next frame
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

  // Load the bundled gun once, alongside the figure and map, on every host.
  setLocalUT(on) {
    this.localUT = !!on;
    if (!on) {
      this.modelsReady = null;
      const had = utGun.on || !!this.viewmodel.ut;
      utGun.on = false;
      if (had) { this.viewmodel.dropUT(); this.figures.refreshGuns(); }
      return;
    }
    if (this.modelsReady) return this.modelsReady;
    this.modelsReady = import('./shieldgun.js').then(async (m) => {
      const { first } = await m.loadShieldGun();
      if (!this.localUT) return;
      utGun.on = true;
      if (first) this.viewmodel.useUT(first);
      this.figures.refreshGuns();
    }).catch(() => { /* keep the fallback if a network request fails */ });
    return this.modelsReady;
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
    this.flushRetired();
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
    onProgress(0.96, 'Modellek');
    await Promise.all([this.figures.ready, this.modelsReady]);
    onProgress(0.97, 'Shaderek');
    try { await this.renderer.compileAsync(this.scene, this.camera); } catch { /* compiled on first use */ }
    await this.figures.warm(this.renderer, this.camera);   // (the Gorge's programs against this map's lighting, if the local model is there)
    try { await this.renderer.compileAsync(this.viewmodel.scene, this.viewmodel.camera); } catch { /* compiled on first use */ }
    onProgress(1, 'Kész');
  }

  // The editor's rebuild after every edit: the Surfaces (the slow canvas textures) move on to the new level, which is built without
  // yielding to the UI and swapped in at once. If the build throws, the current level stays. warm: generate every material of the
  // map first (the first block of a new material would stall otherwise) and compile the shaders. A new theme makes new Surfaces
  // (the old theme's textures and materials are freed, not kept for ever) and so is built like a warm one. The old level is disposed
  // after the next frame (flushRetired), when the new one has taken over the shader programs it shares (the lava shader).
  async rebuildLevel(map, { warm = false, onProgress = () => {} } = {}) {
    const old = this.level;
    if (!old) return this.loadMap(map, onProgress);
    this.flushRetired();
    const themed = JSON.stringify(map.theme) !== JSON.stringify(old.map.theme);
    warm = warm || themed;
    if (themed) {
      this.sky.setTheme(map.theme);
      this.viewmodel.setEnvironment(this.scene.environment);
      this.viewmodel.setTheme(map.theme);
      this.setBloom(map.theme.bloom);
    }
    const level = new Level(map, { quality: this.q, maxAniso: this.renderer.capabilities.getMaxAnisotropy(), surf: themed ? null : old.surf, sync: !warm });
    try {
      if (warm) {
        const names = Object.keys(map.materials);
        let last = performance.now();
        for (let i = 0; i < names.length; i++) {
          for (const top of [true, false]) level.surf.material(map.materials[names[i]], top);
          onProgress(0.1 + 0.7 * ((i + 1) / names.length), 'Textúrák');
          if (performance.now() - last > 40) { await new Promise((r) => setTimeout(r, 0)); last = performance.now(); }   // (let the loading bar paint now and then)
        }
      }
      await level.build();
    } catch (e) { level.dispose({ keepSurf: true }); if (themed) level.surf.dispose(); throw e; }
    this.scene.remove(old.group);
    this.scene.add(level.group);
    this.level = level;
    this.map = map;
    this.retired.push({ level: old, surf: themed ? old.surf : null });
    if (warm) {
      onProgress(0.9, 'Shaderek');
      // every material of the map on a speck of geometry, so that all its shader programs are compiled now, not at the first block of that kind
      const geo = new THREE.BoxGeometry(0.01, 0.01, 0.01), speck = new THREE.Group();
      for (const m of level.surf.mats.values()) { const mesh = new THREE.Mesh(geo, m); mesh.frustumCulled = false; speck.add(mesh); }
      this.scene.add(speck);
      try { await this.renderer.compileAsync(this.scene, this.camera); } catch { /* compiled on first use */ }
      this.scene.remove(speck);
      geo.dispose();
    }
  }

  // dispose the levels that rebuildLevel swapped out (their Surfaces too when the theme changed)
  flushRetired() {
    for (const { level, surf } of this.retired) { level.dispose({ keepSurf: true }); if (surf) surf.dispose(); }
    this.retired.length = 0;
  }

  // ---------------------------------------------------------------- per frame
  // opts: dt, t, world, alpha, look { yaw, pitch } (radians), mode 'play' | 'menu' | 'editor' (cam { pos, yaw, pitch } radians), menuT, speed,
  //       vm { charge, charging, speed, grounded, vy, look, hidden }, view 'belso' | 'kulso' (play mode: the third person camera), me { name, color }
  frame(o) {
    const cam = this.camera, { dt, t, world } = o;
    const w = world;
    let third = false;
    if (o.mode === 'editor' && o.cam) {
      cam.position.set(o.cam.pos[0], o.cam.pos[1], o.cam.pos[2]);
      cam.rotation.set(o.cam.pitch, o.cam.yaw, 0);
      this.updateFov(0);
      this.ppos.copy(cam.position);
    } else if (o.mode === 'menu' || !w) {
      this.menuCamera(o.menuT || 0);
      this.ppos.copy(cam.position);
    } else {
      const p = w.lerp(o.alpha, this.tmp);
      const reborn = (w.spawns | 0) !== this.spawns;   // (the sim put the player somewhere else since the last frame)
      this.spawns = w.spawns | 0;
      this.fx.update(dt, o.speed || 0);
      if (o.view === 'kulso' && o.mode === 'play') {
        const eye = this.eye;
        eye[0] = p.pos[0]; eye[1] = p.pos[1] + EYE; eye[2] = p.pos[2];
        if (!this.third) this.chase.reset();   // (switched on just now: no easing from an old distance)
        const c = this.chase.update(dt, w.cw, eye, o.look.yaw, o.look.pitch);
        cam.position.set(c.pos[0], c.pos[1], c.pos[2]);
        cam.rotation.set(o.look.pitch + this.fx.cam.pitch, o.look.yaw, 0);   // (no landing dip and no dodge roll from behind)
        third = true;
        const me = o.me || {};
        this.figures.upsert(SELF, { name: me.name || '', color: me.color ?? 0xff8a2a, pos: p.pos, yaw: o.look.yaw, pitch: o.look.pitch, flags: w.playerFlags(), ghost: false, solid: false, infer: false, trail: false, label: false, hidden: c.hidden });
        if (reborn) this.figures.snap(SELF);   // (the figure starts afresh on the new spot: no run in place, no landing, whatever the distance)
      } else {
        cam.position.set(p.pos[0], p.pos[1] + EYE + this.fx.cam.y, p.pos[2]);
        cam.rotation.set(o.look.pitch + this.fx.cam.pitch, o.look.yaw, this.fx.cam.roll);
      }
      this.updateFov(this.fx.cam.fov);
      this.ppos.set(p.pos[0], p.pos[1] + 1, p.pos[2]);
    }
    if (!third && this.figures.has(SELF)) this.figures.remove(SELF);   // (first person, the menu and the editor never show the player's own figure)
    this.third = third;
    if (o.mode === 'menu' || o.mode === 'editor') this.fx.update(dt, 0);
    if (this.level && w) this.level.update(w, o.alpha ?? 1, t, dt, cam.position);
    this.sky.update(cam.position, this.ppos, t);
    this.figures.update(dt, cam);
    this.viewmodel.update(dt, t, { ...o.vm, hidden: o.mode === 'menu' || o.mode === 'editor' || third || !!(o.vm && o.vm.hidden) });
    cam.updateMatrixWorld();
    this.fx.setScale((this.renderer.domElement.height * 0.5) / Math.tan((cam.fov * DEG) / 2));
    this.draw(dt);
    if (this.retired.length) this.flushRetired();   // (one frame after the swap: the new level has acquired the shared shader programs by now)
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

  // what the camera does now (__pj.state().camera): the third person numbers are those of the last third-person frame
  cameraInfo() {
    const c = this.camera, h = this.chase.out, r2 = (v) => Math.round(v * 100) / 100;
    return {
      view: this.third ? 'kulso' : 'belso', pos: c.position.toArray().map((v) => Math.round(v * 1000) / 1000), yawDeg: r2(c.rotation.y / DEG), pitchDeg: r2(c.rotation.x / DEG),
      dist: this.third ? r2(h.dist) : 0, limit: this.third ? r2(h.limit) : 0, want: r2(h.want), hit: this.third && h.hit, hidden: this.third && h.hidden, self: this.figures.has(SELF),
    };
  }

  info() {
    const i = this.renderer.info;
    return { calls: i.render.calls, triangles: i.render.triangles, geometries: i.memory.geometries, textures: i.memory.textures, programs: i.programs ? i.programs.length : 0 };
  }

  screenshot(type = 'image/jpeg', q = 0.85) { return this.canvas.toDataURL(type, q); }
}
