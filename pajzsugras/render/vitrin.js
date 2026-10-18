// The gauntlet showcase (dev machine only): http://localhost:5173/pajzsugras/?vitrin. The game itself does not start; a full-window canvas shows
// the shield gauntlet (render/gauntlet.js) lit by the game's own sky, on a turntable, with a charge slider and a fire button, and the real first
// person viewmodel (render/viewmodel.js) over the same sky. main.js loads this module only in a dev build served from this machine.
//
//   window.__vitrin  (for scripted checks)
//     .set({ mode: 'object' | 'fp', lod: 'fp' | 'tp', charge, yaw, pitch, zoom, auto, hide })     any subset
//     .fire()   .step(seconds)  advance the animation and draw     .render()  draw once     .info() -> { mode, lod, tris, charge, ... }
//     .place({ base, rot, shift, scale })   move the first person gauntlet (to find the numbers for viewmodel.js)
import * as THREE from 'three';
import { EffectComposer, RenderPass, EffectPass, BloomEffect, SMAAEffect, ToneMappingEffect, ToneMappingMode, VignetteEffect } from 'postprocessing';
import { Sky } from './sky.js';
import { Viewmodel } from './viewmodel.js';
import { buildGauntlet } from './gauntlet.js';
import { normalizeTheme } from '../sim/builder.js';

const el = (tag, css, html) => { const e = document.createElement(tag); if (css) e.style.cssText = css; if (html != null) e.innerHTML = html; return e; };

export function openVitrin() {
  document.title = 'PAJZSUGRÁS · vitrin';
  const root = el('div', 'position:fixed;inset:0;z-index:100000;background:#0b1015;font:13px/1.35 "Exo 2",system-ui,sans-serif;color:#cfe6ee');
  const canvas = el('canvas', 'position:absolute;inset:0;width:100%;height:100%;display:block');
  root.appendChild(canvas);
  document.body.appendChild(root);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.02, 50);
  const sky = new Sky(scene, renderer, 'kozepes');
  const theme = normalizeTheme({});
  sky.setTheme(theme);
  const vm = new Viewmodel();
  vm.setEnvironment(scene.environment);
  vm.setTheme(theme);

  const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, multisampling: 4 });
  composer.addPass(new RenderPass(scene, camera));
  const vmPass = new RenderPass(vm.scene, vm.camera);
  vmPass.clearPass.setClearFlags(false, true, false);
  composer.addPass(vmPass);
  composer.addPass(new EffectPass(camera, new BloomEffect({ mipmapBlur: true, luminanceThreshold: 0.8, luminanceSmoothing: 0.25, intensity: 0.6 * 0.9, radius: 0.72 }), new VignetteEffect({ darkness: 0.42, offset: 0.32 }), new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC })));
  composer.addPass(new EffectPass(camera, new SMAAEffect()));

  const S = { mode: 'object', lod: 'fp', charge: 0, yaw: 0.6, pitch: 0.28, zoom: 1, auto: true, t: 0, flash: 0, g: null, hide: false };
  const gauntlets = {};
  const get = (lod) => {
    if (!gauntlets[lod]) { const g = buildGauntlet({ lod }); g.group.visible = false; scene.add(g.group); gauntlets[lod] = g; }
    return gauntlets[lod];
  };

  // ---- the controls
  const panel = el('div', 'position:absolute;left:14px;top:14px;padding:12px 14px;background:rgba(9,15,22,.82);border:1px solid rgba(110,215,232,.25);border-radius:10px;min-width:250px;backdrop-filter:blur(6px)');
  panel.innerHTML = `
    <div style="font:15px 'Russo One',sans-serif;color:#2ee6d4;margin-bottom:8px">Pajzskesztyű · vitrin</div>
    <div style="display:flex;gap:6px;margin-bottom:8px">
      <button data-mode="object">Tárgy</button><button data-mode="fp">Első személy</button>
      <button data-lod="fp">fp</button><button data-lod="tp">tp</button>
    </div>
    <label style="display:block">Töltés <span id="v-c">0</span><input id="v-charge" type="range" min="0" max="1" step="0.01" value="0" style="width:100%"></label>
    <label style="display:block">Forgás <input id="v-yaw" type="range" min="-3.14" max="3.14" step="0.01" value="0.6" style="width:100%"></label>
    <label style="display:block">Dőlés <input id="v-pitch" type="range" min="-1.4" max="1.4" step="0.01" value="0.28" style="width:100%"></label>
    <label style="display:block">Közelítés <input id="v-zoom" type="range" min="0.25" max="3" step="0.01" value="1" style="width:100%"></label>
    <div style="display:flex;gap:6px;margin-top:8px;align-items:center"><button id="v-fire">Lövés</button><label><input id="v-auto" type="checkbox" checked> automatikus forgás</label></div>
    <div id="v-info" style="margin-top:8px;color:#7f9aa6;font-size:12px"></div>`;
  for (const b of panel.querySelectorAll('button')) b.style.cssText = 'padding:5px 10px;background:#12202b;color:#cfe6ee;border:1px solid rgba(110,215,232,.35);border-radius:6px;cursor:pointer';
  root.appendChild(panel);
  const $ = (id) => panel.querySelector('#' + id);

  // ---- the frame
  function layout() {
    const w = Math.max(2, window.innerWidth), h = Math.max(2, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setSize(w, h, false);
    composer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    vm.resize(w / h);
  }
  function frame(dt) {
    S.t += dt;
    S.flash = Math.max(0, S.flash - dt * 9);
    if (S.auto && S.mode === 'object') S.yaw += dt * 0.5;
    const obj = S.mode === 'object';
    for (const [lod, g] of Object.entries(gauntlets)) g.group.visible = obj && lod === S.lod && !S.hide;
    if (obj) {
      const g = get(S.lod);
      g.group.visible = !S.hide;
      g.update(dt, S.t, { charge: S.charge, flash: S.flash });
      const c = new THREE.Vector3(0, 0, S.lod === 'fp' ? 0.36 : 0.2), d = (S.lod === 'fp' ? 1.4 : 0.8) / S.zoom;
      camera.position.set(c.x + Math.sin(S.yaw) * Math.cos(S.pitch) * d, c.y + Math.sin(S.pitch) * d, c.z + Math.cos(S.yaw) * Math.cos(S.pitch) * d);
      camera.lookAt(c);
    } else {
      camera.position.set(0, 1.7, 3); camera.lookAt(0, 1.6, 0);
    }
    vm.update(dt, S.t, { charge: S.charge, charging: S.charge > 0.001, speed: 0, grounded: true, vy: 0, look: [0, 0], hidden: obj || S.hide });
    sky.update(camera.position, new THREE.Vector3(0, 0, 0), S.t);
    composer.render(dt);
    $('v-c').textContent = S.charge.toFixed(2);
    $('v-info').textContent = obj ? `${S.lod}: ${get(S.lod).tris | 0} háromszög` : `első személy: ${vm.info().ut ? 'UT' : 'saját'} · ${vm.gauntlet ? vm.gauntlet.tris | 0 : 0} háromszög`;
  }
  let last = performance.now(), running = true;
  const loop = (now) => { if (!running) return; frame(Math.min(0.05, (now - last) / 1000)); last = now; requestAnimationFrame(loop); };

  const api = {
    set(o = {}) {
      Object.assign(S, o);
      if (o.mode) for (const b of panel.querySelectorAll('[data-mode]')) b.style.outline = b.dataset.mode === S.mode ? '1px solid #2ee6d4' : 'none';
      $('v-charge').value = S.charge; $('v-yaw').value = S.yaw; $('v-pitch').value = S.pitch; $('v-zoom').value = S.zoom; $('v-auto').checked = S.auto;
      return api.info();
    },
    fire() { S.flash = 1; get(S.lod).fire(); vm.onBlast(S.charge); },
    step(sec = 0.016) { const n = Math.max(1, Math.round(sec / (1 / 60))); for (let i = 0; i < n; i++) frame(1 / 60); return api.info(); },
    render() { frame(0); },
    info() { return { mode: S.mode, lod: S.lod, tris: get(S.lod).tris, charge: S.charge, yaw: S.yaw, pitch: S.pitch, zoom: S.zoom, vm: vm.info() }; },
    // (tuning aid for the first person placement: the numbers that then go into viewmodel.js GAUNTLET)
    place({ base, rot, shift, scale } = {}) {
      if (base) vm.base.set(...base);
      if (rot) vm.gun.rotation.set(...rot);
      if (scale != null) vm.root.scale.setScalar(scale);
      if (shift) vm.camera.setViewOffset(vm.camera.aspect, 1, -shift[0] * vm.camera.aspect, -shift[1], vm.camera.aspect, 1);
    },
    stop() { running = false; },
  };
  panel.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.mode) api.set({ mode: b.dataset.mode });
    else if (b.dataset.lod) api.set({ lod: b.dataset.lod });
    else if (b.id === 'v-fire') api.fire();
  });
  panel.addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    if (e.target.id === 'v-charge') S.charge = v; else if (e.target.id === 'v-yaw') { S.yaw = v; S.auto = false; $('v-auto').checked = false; } else if (e.target.id === 'v-pitch') S.pitch = v;
    else if (e.target.id === 'v-zoom') S.zoom = v; else if (e.target.id === 'v-auto') S.auto = e.target.checked;
  });
  // drag to turn, wheel to zoom
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => { drag = [e.clientX, e.clientY]; canvas.setPointerCapture(e.pointerId); S.auto = false; $('v-auto').checked = false; });
  canvas.addEventListener('pointermove', (e) => { if (!drag) return; S.yaw -= (e.clientX - drag[0]) * 0.008; S.pitch = Math.max(-1.4, Math.min(1.4, S.pitch + (e.clientY - drag[1]) * 0.006)); drag = [e.clientX, e.clientY]; });
  canvas.addEventListener('pointerup', () => { drag = null; });
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); S.zoom = Math.max(0.25, Math.min(3, S.zoom * Math.exp(-e.deltaY * 0.001))); }, { passive: false });
  window.addEventListener('resize', layout);
  layout();
  api.set({ mode: 'object' });
  requestAnimationFrame(loop);
  window.__vitrin = api;
  return api;
}
