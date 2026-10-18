// PAJZSUGRÁS map editor, the controller (browser only). Created once by main.js (app.editor); everything is active only while app.state
// is 'editor' (or a test from the editor is running).
//
// Every edit goes: doc (editor/model.js) -> toDef (editor/convert.js, the real map builder) -> createWorld -> a quick level rebuild that
// keeps the Surfaces (the canvas textures) of the current level (gfx.rebuildLevel), 100 ms after the last edit. The ghost, the selection
// outline and everything else in editor/gizmos.js follow the document at once, so dragging and typing never wait for a rebuild.
// Picking and placing are pure maths against the document / the last built world (editor/pick.js).
//
// CONTROLS (editor only; the game keys are off here)
//   hold right button: look (pointer lock while held, drag-look if the lock is refused) · WASD fly · Space / E up · Q / C down · Shift 3x ·
//   wheel: fly speed · left click: place (tool) or select · left drag on the selection: move it on its plane · 1 2 3 .. 9 0 palette tools ·
//   V / Esc select tool (Esc first cancels a pending pad target, then the tool, then the selection) · arrows move 0.5 m in the camera frame ·
//   PgUp / PgDn move up / down · Shift + wheel lifts the ghost before placing (select tool: moves the selection up / down) · Shift + arrows / PgUp / PgDn resize · R rotate 90 · Ctrl+D duplicate · Del / Backspace delete ·
//   Ctrl+Z undo · Ctrl+Y / Ctrl+Shift+Z redo · Ctrl+S save · F focus the selection · G grid 0.5 / 0.1 m · K start point at the aimed point ·
//   pad tool: 1st click the pad, 2nd click the target · T or F2: test from the camera (practice run) · Enter: test from the start point ·
//   F2 / Esc in a test: back here · Tab hide the panels · H help.  No Ctrl as a fly key (Ctrl+W closes the tab). F2 and these keys are
//   ignored in a room and while typing in a field (Ctrl+S still saves there).
//   F2 outside the editor: from the menu the map list (scr-edhome; F2 again opens the last map), from a built-in map the last edited map
//   or a new one, from a custom map you are playing that map.
//
// THE TEST RUN: main.js runs the same sim world (state 'playing', input on). From the camera: the player stands where the camera is
// (feet 1.6 m below, lifted out of walls up to 2 m), every checkpoint counts as taken so the finish works at once, and R / death return
// to the camera spot (note "Gyakorló próba a kamerától"). From the start point: the full rules, nothing pre-taken. No personal best, no
// results screen, no leaderboard; Esc / F2 / losing the mouse capture come back here, to the exact camera pose.
//
// SAVING: every edit starts a 1.5 s timer (each further edit restarts it); then the document goes to store.saveCustom (ed:map:<id>, the list
// ed:index, ed:last). It is also saved when a test starts, on leaving, when the tab is hidden or closed, and by Ctrl+S / the Mentés button.
// A map that was never edited is not saved (opening the editor and leaving leaves no empty map behind). A failed write (quota, blocked
// storage) shows a toast that suggests the Exportálás button; the map stays in memory for the session either way, the top bar keeps saying
// "Nincs mentve!" until a save succeeds, and the editor keeps that unsaved model when it is opened again. The index entry of a save also
// carries the checkpoints / finish / hash of the built world (when it is of this revision), so the JÁTÉK list need not build the map.
//
//   editor.enter(doc | id, onProgress) / editor.leave()  main.js: app.openEditor / app.exitEditor (doc = a document, id = a saved map, nothing =
//                                                        the map of this session, else the last edited one, else a new one)
//   editor.save({ quiet }) -> bool   editor.exportMap()   editor.forget(id)   (the menus renamed / deleted a saved map)
//   editor.update(dt)  editor.camState()                every frame in the 'editor' state
//   editor.testing  editor.startTest({from})  editor.backFromTest()  editor.applyTestStart()  editor.testHint(locked)
//   editor.debug                                         __pj.editor (see main.js)
import './editor.css';
import { DocModel, newItem, sanitizeDoc, serialise, paletteOf, paletteIdOf, itemAabb, worldSize, validate, wrap360, r2, LIM, PALETTE } from './model.js';
import { toDef, docIdOf } from './convert.js';
import { loadDoc, newMapDoc, exportFile, downloadText, importMapText, deleteMap, mapInfo } from './library.js';
import { rayFromCamera, pickRay, surfaceHit, rayPlaneY, placement, snap, snapMin, padArc, findTestSpawn } from './pick.js';
import { Gizmos } from './gizmos.js';
import { EditorPanel } from './panel.js';
import { createWorld } from '../sim/world.js';
import { EYE } from '../sim/const.js';
import { aimOf } from '../sim/math.js';
import { DEG_PER_PX, MAX_PITCH } from '../input.js';

const DEG = Math.PI / 180;
const REBUILD_MS = 100;       // rebuild this long after the last edit
const SAVE_MS = 1500;         // save this long after the last edit
const BOXY = new Set(['block', 'ramp', 'kill', 'cp', 'finish']);   // their MIN corner snaps to the grid, everything else snaps its centre
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const now = () => performance.now();
const toolName = (e) => (e.t === 'deco' ? 'Dísz: ' + e.label : e.label);
const fmt = (n) => (Math.round(n * 100) / 100).toString().replace('.', ',');
const isTyping = (t) => !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);

export class Editor {
  // host (main.js): { useWorld(world, { warm, onProgress }), beginTest({ from, pose }), endTest() }
  constructor(app, host) {
    this.app = app;
    this.host = host;
    this.root = document.getElementById('editor');
    this.model = null;
    this.world = null;
    this.brushItem = [];
    this.ready = false;
    this.testing = false;
    this.starting = false;
    this.tool = 'select';
    this.sel = null;
    this.grid = 0.5;
    this.cam = { pos: [0, 6, 14], yaw: 0, pitch: -0.35 };   // radians
    this.flySpeed = 12;
    this.keys = new Set();
    this.ctrl = false;
    this.mouse = { ndc: [0, 0], inside: false, x: 0, y: 0 };
    this.looking = false;
    this.drag = null; this.dragN = 0;
    this.toolYaw = 0;
    this.lift = 0;              // Shift + wheel: the ghost sits this many metres above the aimed surface
    this.toolSize = new Map();   // palette id -> the size the last edited item of it had
    this.padPending = null;
    this.aim = null; this.ghost = null;
    this.syncedRev = -1; this.builtRev = -1; this.rebuildAt = 0; this.rebuildMs = 0;
    this.building = null; this.lastError = null;
    this.testFrom = null; this.testPose = null;
    this.session = 0;   // (counts leave() calls: a startTest that was waiting for the rebuild gives up when the editor was left meanwhile)
    this.escInTest = null;   // (the Esc keydown that arrived while a test ran: if it ended the test, the editor ignores that same event)
    this.savedRev = 0; this.saveAt = 0; this.failToastAt = -1e9;   // (the model's rev at the last successful save; when the debounced save is due)
    this.unsaved = false;   // (the last write failed: the map exists only in memory)
    this.gizmos = null; this.panel = null;
    this.attach();
    this.debug = this.makeDebug();
  }

  get active() { return this.ready && !this.testing && this.app.state === 'editor'; }

  // ---------------------------------------------------------------- events
  attach() {
    const cv = this.app.gfx.canvas;
    document.addEventListener('keydown', (e) => { this.escInTest = this.testing && e.code === 'Escape' ? e : null; }, true);
    document.addEventListener('keydown', (e) => this.onKeyDown(e));
    document.addEventListener('keyup', (e) => this.onKeyUp(e));
    cv.addEventListener('mousedown', (e) => this.onMouseDown(e));
    document.addEventListener('mouseup', (e) => this.onMouseUp(e));
    document.addEventListener('mousemove', (e) => this.onMouseMove(e));
    cv.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    window.addEventListener('blur', () => { this.keys.clear(); this.ctrl = false; this.stopLook(); this.primaryUp(); });   // (a mouseup over another window never comes: the drag ends here, as a mouseup would end it)
    const flush = () => { if (this.ready && this.model) this.saveIfDirty(); };   // (a closed tab must not lose the last second of work)
    document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
    window.addEventListener('pagehide', flush);
  }

  onKeyDown(e) {
    if (this.app.mode === 'room' || this.escInTest === e) return;   // (that Esc already ended the test: it must not also reset the tool here)
    const typing = isTyping(e.target);
    this.ctrl = e.ctrlKey || e.metaKey;
    if (e.code === 'F2') {
      if (typing) return;
      e.preventDefault();
      if (e.repeat) return;
      if (this.testing) this.backFromTest();
      else if (this.active) this.startTest({ from: 'cam' });
      else this.openFromKey();
      return;
    }
    if (!this.active) return;
    if (typing) {
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS') { e.preventDefault(); this.save(); }   // (not the browser's save-page dialog)
      else if (e.code === 'Enter' || e.code === 'Escape') e.target.blur();
      return;
    }
    this.keys.add(e.code);
    if (!e.repeat || e.code.startsWith('Arrow') || e.code.startsWith('Page') || e.code === 'Delete' || e.code === 'Backspace') this.handleKey(e);
    else if (['Space', 'Tab'].includes(e.code)) e.preventDefault();
  }
  onKeyUp(e) {
    this.ctrl = e.ctrlKey || e.metaKey;
    this.keys.delete(e.code);
  }

  // F2 outside the editor: the map list from the menu (F2 on it opens the last map), the map being played if it is one of ours, else the last
  // edited map or a new one
  openFromKey() {
    const app = this.app, st = app.state;
    if (st === 'menu') {
      if (app.ui.current === 'edhome') app.openEditor();
      else app.showScreen('edhome');
    } else if (['playing', 'paused', 'results'].includes(st)) {
      const id = docIdOf(app.mapId);
      app.openEditor(id && app.store.hasCustom(id) ? id : undefined);
    }
  }

  // a key press (also what __pj.editor.key sends); true when the editor used it
  handleKey(e) {
    const code = e.code, ctrl = e.ctrlKey || e.metaKey, shift = e.shiftKey;
    const pd = () => { if (e.preventDefault) e.preventDefault(); return true; };
    if (ctrl) {
      switch (code) {
        case 'KeyZ': pd(); if (shift) this.redo(); else this.undo(); return true;
        case 'KeyY': pd(); this.redo(); return true;
        case 'KeyD': pd(); this.action('duplicate'); return true;
        case 'KeyS': pd(); this.save(); return true;
        default: return false;   // Ctrl+W, Ctrl+R ... stay with the browser
      }
    }
    if (e.altKey) return false;
    const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code);
    if (digit) { const p = PALETTE.find((q) => q.key === digit[1]); if (p) this.setTool(p.id); return pd(); }
    const { fwd, right } = this.camAxes();
    const step = this.grid;
    switch (code) {
      case 'KeyV': this.setTool('select'); return true;
      case 'Escape': this.escape(); return true;
      case 'KeyR': this.action('rotate'); return true;
      case 'Delete': case 'Backspace': pd(); this.action('delete'); return true;
      case 'KeyF': this.focusSel(); return true;
      case 'KeyG': this.grid = this.grid === 0.5 ? 0.1 : 0.5; this.panel.status(`Rács: ${fmt(this.grid)} m`); return true;
      case 'KeyK': this.setStartAtAim(); return true;
      case 'KeyT': this.startTest({ from: 'cam' }); return true;
      case 'Enter': case 'NumpadEnter': pd(); this.startTest({ from: 'start' }); return true;
      case 'Tab': pd(); this.panel.setHidden(!this.panel.top.hidden); return true;
      case 'KeyH': this.panel.toggleHelp(); return true;
      case 'ArrowUp': pd(); if (shift) this.resizeSel(fwd, 1); else this.nudge(fwd.map((v) => v * step)); return true;
      case 'ArrowDown': pd(); if (shift) this.resizeSel(fwd, -1); else this.nudge(fwd.map((v) => -v * step)); return true;
      case 'ArrowRight': pd(); if (shift) this.resizeSel(right, 1); else this.nudge(right.map((v) => v * step)); return true;
      case 'ArrowLeft': pd(); if (shift) this.resizeSel(right, -1); else this.nudge(right.map((v) => -v * step)); return true;
      case 'PageUp': pd(); if (shift) this.resizeSel([0, 1, 0], 1); else this.nudge([0, step, 0]); return true;
      case 'PageDown': pd(); if (shift) this.resizeSel([0, 1, 0], -1); else this.nudge([0, -step, 0]); return true;
      case 'Space': pd(); return true;   // (fly up, handled per frame)
      default: return false;
    }
  }

  mouseFrom(e) {
    const r = this.app.gfx.canvas.getBoundingClientRect();
    this.mouse.x = e.clientX; this.mouse.y = e.clientY;
    this.mouse.ndc = [((e.clientX - r.left) / r.width) * 2 - 1, -(((e.clientY - r.top) / r.height) * 2 - 1)];
    this.mouse.inside = e.target === this.app.gfx.canvas;
  }
  onMouseDown(e) {
    if (!this.active) return;
    const a = document.activeElement;
    if (a && isTyping(a)) a.blur();
    this.mouseFrom(e);
    if (e.button === 2) { e.preventDefault(); this.startLook(); }
    else if (e.button === 0) { e.preventDefault(); this.primaryDown(); }
  }
  onMouseUp(e) {
    if (e.button === 2) this.stopLook();
    if (e.button === 0) this.primaryUp();
  }
  onMouseMove(e) {
    this.mouseFrom(e);
    if (!this.active) return;
    if (this.looking) {
      const k = (DEG_PER_PX * (this.app.settings.sens || 1) * Math.PI) / 180;
      const dx = e.movementX || 0, dy = e.movementY || 0;
      if (Math.abs(dx) > 600 || Math.abs(dy) > 600) return;
      this.cam.yaw -= dx * k;
      this.cam.pitch = clamp(this.cam.pitch - dy * k, -MAX_PITCH, MAX_PITCH);
    } else if (this.drag) this.dragMove();
  }
  onWheel(e) {
    if (!this.active) return;
    e.preventDefault();
    if (e.shiftKey) {
      // Shift + wheel: with a placement tool it lifts / sinks the ghost (a click then places it in the air), with the select tool it
      // moves the selected item up / down. (Chrome on Windows turns Shift + wheel into a horizontal scroll, hence deltaX.)
      const d = -Math.sign(e.deltaY || e.deltaX);
      if (!d) return;
      if (this.tool !== 'select') {
        this.lift = clamp(r2(this.lift + d * this.grid), -50, 200);
        this.panel.status(`Emelés: ${this.lift > 0 ? '+' : ''}${fmt(this.lift)} m`, 'info', 1200);
      } else if (this.sel) this.nudge([0, d * this.grid, 0]);
      return;
    }
    this.flySpeed = clamp(this.flySpeed * Math.exp(-Math.sign(e.deltaY) * 0.14), 1, 200);
    this.panel.status(`Repülési sebesség: ${Math.round(this.flySpeed)} m/s`, 'info', 1200);
  }

  startLook() {
    if (this.looking) return;
    this.looking = true;
    document.body.classList.add('ed-look');
    this.app.input.lock();   // (refused right after an Esc in Chrome: the drag-look below still works)
  }
  stopLook() {
    if (!this.looking) return;
    this.looking = false;
    document.body.classList.remove('ed-look');
    this.app.input.unlock();
  }

  // ---------------------------------------------------------------- lifecycle
  async enter(doc, onProgress = () => {}) {
    if (!this.panel) {
      this.panel = new EditorPanel(this.root, this);
      this.gizmos = new Gizmos(this.app.gfx);
    }
    const store = this.app.store, kept = this.model;
    let d = null, keep = false;
    if (typeof doc === 'string') {
      if (kept && kept.doc.id === doc) keep = true;
      else { d = loadDoc(store, doc); if (!d) this.app.ui.toast('A pálya nem található, vagy a fájlja hibás.'); }
    } else if (doc) {
      d = sanitizeDoc(doc);
      if (!d) this.app.ui.toast('A pálya fájlja hibás, új pálya indul.');
    } else if (kept && (store.hasCustom(kept.doc.id) || this.unsaved || (kept.rev === 0 && !store.lastCustom()))) keep = true;   // (an untouched new map gives way to the last edited one; a map whose save failed or was refused exists only here, so it stays; a map deleted in the menus since is not taken back)
    if (!keep && !d) {
      const last = doc && typeof doc !== 'string' ? null : store.lastCustom();
      d = (last && loadDoc(store, last)) || newMapDoc(store, Date.now());
    }
    if (d) { this.model = new DocModel(d); this.savedRev = 0; this.unsaved = false; }
    d = this.model.doc;
    this.model.onRefuse = (msg) => this.panel.status(msg, 'bad', 5000);
    this.saveAt = 0;
    if (store.hasCustom(d.id)) store.setLastCustom(d.id);
    this.cam = { pos: d.cam.pos.slice(), yaw: d.cam.yaw * DEG, pitch: d.cam.pitch * DEG };
    this.sel = null; this.tool = 'select'; this.padPending = null; this.drag = null; this.keys.clear(); this.lift = 0;
    const { def, brushItem } = toDef(d);
    const w = createWorld(def);
    const session = this.session;
    await this.host.useWorld(w, { warm: true, onProgress });
    if (session !== this.session) return false;   // (left meanwhile, e.g. a room invite opened while the editor was loading)
    this.world = w; this.brushItem = brushItem;
    this.builtRev = this.model.rev; this.syncedRev = -1; this.lastError = null;
    this.root.hidden = false;
    this.panel.setHidden(false);
    this.panel.setTool('select');
    this.panel.setSelection();
    this.panel.setSaveState(this.unsaved ? 'fail' : this.model.rev !== this.savedRev ? 'dirty' : store.hasCustom(d.id) ? 'saved' : 'new');
    this.gizmos.setVisible(true);
    document.body.classList.add('editing');
    this.ready = true;
    this.syncDoc();
    this.panel.status('Szerkesztő. H: súgó · 1–0: eszközök · jobb gomb: körbenézés', 'info', 6000);
    return true;
  }

  // out of the editor (to the menu, or because the debug hook loads something): the document stays for the next F2
  leave() {
    if (!this.model) return;
    this.saveCam();
    this.saveIfDirty();
    this.testing = false; this.starting = false; this.session++;
    this.stopLook(); this.drag = null; this.keys.clear();
    this.ready = false;
    this.root.hidden = true;
    document.body.classList.remove('editing', 'ed-look', 'ed-drag');
    if (this.gizmos) this.gizmos.setVisible(false);
  }

  saveCam() {
    const c = this.cam;
    this.model.doc.cam = { pos: c.pos.map(r2), yaw: r2(c.yaw / DEG), pitch: r2(c.pitch / DEG) };
  }
  camState() { return this.cam; }

  // ---------------------------------------------------------------- the frame
  update(dt) {
    if (!this.ready || this.testing) return;
    this.flyStep(dt);
    const m = this.model;
    if (m.rev !== this.syncedRev) { this.syncDoc(); this.rebuildAt = now() + REBUILD_MS; }
    if (m.rev !== this.builtRev && !this.building && !this.drag && now() >= this.rebuildAt) this.rebuild();
    if (this.saveAt && !this.drag && now() >= this.saveAt) this.save({ quiet: true });
    this.computeAim();
    this.updateGizmos();
    this.gizmos.update(this.cam.pos);
  }

  syncDoc() {
    const rev = this.model.rev;
    if (rev !== this.syncedRev && rev !== this.savedRev) { this.saveAt = now() + SAVE_MS; this.panel.setSaveState(this.unsaved ? 'fail' : 'dirty'); }   // (every edit restarts the timer)
    this.syncedRev = rev;
    this.gizmos.syncDoc(this.model.doc);
    this.panel.refresh();
  }

  flyStep(dt) {
    if (this.ctrl) return;
    const k = this.keys;
    const f = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0), r = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    const u = (k.has('Space') || k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') || k.has('KeyC') ? 1 : 0);
    if (!f && !r && !u) return;
    const sp = this.flySpeed * (k.has('ShiftLeft') || k.has('ShiftRight') ? 3 : 1) * dt;
    const a = aimOf(this.cam.yaw, this.cam.pitch), c = this.cam, rx = Math.cos(c.yaw), rz = -Math.sin(c.yaw);
    c.pos[0] += (a[0] * f + rx * r) * sp;
    c.pos[1] += (a[1] * f + u) * sp;
    c.pos[2] += (a[2] * f + rz * r) * sp;
    for (let i = 0; i < 3; i++) c.pos[i] = clamp(c.pos[i], -LIM.coord, LIM.coord);
  }

  // the ray under the pointer (the screen centre while looking), the surface it meets and, with the select tool, the item it enters
  computeAim(ndcOverride = null) {
    const ndc = ndcOverride || (this.looking ? [0, 0] : this.mouse.inside ? this.mouse.ndc : null);
    if (!ndc) { this.aim = null; return null; }
    const g = this.app.gfx, ray = rayFromCamera(this.cam, ndc, g.camera.fov, g.aspect);
    let hit = surfaceHit(this.world, ray.o, ray.d);
    if (hit && this.lift && this.tool !== 'select') hit = { ...hit, point: [hit.point[0], hit.point[1] + this.lift, hit.point[2]] };   // Shift + wheel lift
    const aim = { ndc, ray, hit, pick: null };
    if (this.tool === 'select' && !this.drag) aim.pick = pickRay(this.model.doc, ray.o, ray.d);
    this.aim = aim;
    return aim;
  }

  // what a click would place right now (null: nothing to place)
  ghostItem(aim) {
    const e = paletteOf(this.tool);
    if (!e || e.t === 'start' || !aim || !aim.hit) return null;
    const over = {}, rem = this.toolSize.get(e.id);
    if (rem) { if (rem.size) over.size = rem.size; if (rem.r) { over.r = rem.r; over.h = rem.h; } }
    if (['block', 'ramp', 'prism', 'deco'].includes(e.t)) over.yaw = this.toolYaw;
    const base = newItem(e, over);
    const pl = placement(e, aim.hit, { grid: this.grid, size: worldSize(base), yaw: base.yaw || 0, camYaw: this.cam.yaw });
    return newItem(e, { ...over, ...pl });
  }

  defaultApex(pos, target) {
    const dist = Math.hypot(target[0] - pos[0], target[2] - pos[2]);
    return r2(Math.max(pos[1], target[1]) + clamp(dist * 0.3, 3, 15));
  }

  updateGizmos() {
    const g = this.gizmos, aim = this.aim, e = paletteOf(this.tool);
    g.setSelection(this.sel ? this.model.find(this.sel) : null);
    let ghost = null, arc = null, centre = null;
    if (e && !this.drag && aim && aim.hit) {
      const p = aim.hit.point, sn = (v) => snap(v, this.grid);
      if (e.t === 'start') {
        const pl = placement(e, aim.hit, { grid: this.grid, camYaw: this.cam.yaw });
        ghost = { t: 'start', pos: pl.pos, yaw: pl.yaw };
      } else if (e.t === 'pad') {
        const target = [sn(p[0]), r2(p[1]), sn(p[2])];
        if (this.padPending) {
          const pos = this.padPending.pos, it = newItem('pad', { pos, target, apex: this.defaultApex(pos, target) });
          ghost = it; arc = padArc(it, 24);
        } else ghost = newItem('pad', { pos: placement(e, aim.hit, { grid: this.grid }).pos });
      } else ghost = this.ghostItem(aim);
      centre = [sn(p[0]), p[1], sn(p[2])];
    }
    this.ghost = ghost;
    g.setGhost(ghost);
    g.setPadPreview(arc);
    g.setGrid(this.grid, centre);
    // the status line
    const hit = aim && aim.hit ? aim.hit.point : null;
    const lifted = this.lift && this.tool !== 'select' ? `emelés ${this.lift > 0 ? '+' : ''}${fmt(this.lift)} m  ·  ` : '';
    this.panel.setInfo(`${hit ? `x ${fmt(hit[0])}  y ${fmt(hit[1])}  z ${fmt(hit[2])}  ·  ` : ''}${lifted}rács ${fmt(this.grid)} m  ·  repülés ${Math.round(this.flySpeed)} m/s`);
    this.panel.setHint(this.hintText());
  }

  hintText() {
    if (this.padPending) return 'Ugrópárna: kattints a cél helyére (Esc: mégse)';
    if (this.tool === 'select') return this.sel ? 'Húzással mozgatod · R forgat · Del töröl · nyilak: finom mozgatás · Shift+nyilak: méret' : 'Bal gomb: kijelöl · jobb gomb nyomva: körbenézés · 1–0: eszköz · H: súgó';
    const e = paletteOf(this.tool);
    return e.t === 'pad' ? 'Ugrópárna: kattints a párna helyére' : `${toolName(e)}: kattints a lerakáshoz · R forgat · Esc: kijelölés`;
  }

  // ---------------------------------------------------------------- rebuild
  rebuild() {
    if (this.building) return this.building;
    this.building = this.buildNow().finally(() => { this.building = null; });
    return this.building;
  }
  // never rejects: a failed build keeps the last good world and shows the error (and is not retried until the next edit)
  async buildNow() {
    const rev = this.model.rev, t0 = now();
    try {
      const { def, brushItem } = toDef(this.model.doc);
      const w = createWorld(def);
      await this.host.useWorld(w);
      this.world = w; this.brushItem = brushItem;
      this.rebuildMs = now() - t0;
      this.lastError = null;
      if (this.ready && rev === this.model.rev) this.panel.updateChecks(this.model.doc);   // (the checks that need the built world: a start inside a wall ...)
    } catch (err) {
      this.lastError = String((err && err.message) || err);
      this.panel.status('Hiba az építéskor: ' + this.lastError, 'bad', 8000);
      console.error('[pajzsugras] editor rebuild failed', err);
    } finally {
      this.builtRev = rev;
    }
  }
  // bring the built world up to date with the document now
  async flush() {
    if (this.building) await this.building;
    if (this.model.rev !== this.builtRev) await this.rebuild();
  }

  // ---------------------------------------------------------------- tools and selection
  setTool(id) {
    if (id !== 'select' && !paletteOf(id)) return;
    if (this.padPending) { this.padPending = null; this.panel.clearStatus(); }   // (no stale "click the target" prompt)
    if (id === this.tool) return;
    this.tool = id;
    this.panel.setTool(id);
  }
  select(id) {
    if (id === this.sel) return;
    this.sel = id;
    this.panel.setSelection();
  }
  escape() {
    if (!this.panel.help.hidden) this.panel.toggleHelp();
    else if (this.padPending) { this.padPending = null; this.panel.status('Ugrópárna megszakítva'); }
    else if (this.tool !== 'select') this.setTool('select');
    else this.select(null);
  }

  primaryDown() {
    const aim = this.computeAim();
    if (this.tool === 'select') {
      const pk = aim && aim.pick;
      if (!pk) { this.select(null); return null; }
      this.select(pk.id);
      this.beginDrag(pk);
      return pk.id;
    }
    return this.placeAtAim(aim);
  }
  primaryUp() {
    if (!this.drag) return;
    this.drag = null;
    document.body.classList.remove('ed-drag');
  }

  // the click of a placement tool; returns the id of the new item (or 'start')
  placeAtAim(aim) {
    const e = paletteOf(this.tool), m = this.model;
    if (!aim || !aim.hit) { this.panel.status('Nincs hová lerakni: célozz a padlóra vagy egy felületre.', 'warn'); return null; }
    if (e.t === 'start') return this.setStartAt(aim);
    if (e.t === 'pad') {
      const pl = placement(e, aim.hit, { grid: this.grid });
      if (!this.padPending) { this.padPending = { pos: pl.pos }; this.panel.status('Most kattints a párna céljára.'); return null; }
      const pos = this.padPending.pos, target = pl.pos;
      if (Math.hypot(target[0] - pos[0], target[2] - pos[2]) < 1) { this.panel.status('A cél túl közel van a párnához.', 'warn'); return null; }
      this.padPending = null;
      const id = m.add({ t: 'pad', pos, target, apex: this.defaultApex(pos, target) }, { label: 'Lerakás: ugrópárna' });
      if (id == null) { this.limitNote(); return null; }
      this.select(id);
      this.panel.status('Ugrópárna kész.', 'info', 1500);   // (replaces the "click the target" prompt)
      return id;
    }
    const item = this.ghostItem(aim);
    if (!item) return null;
    const moved = item.t === 'finish' && !!m.finish;   // a second finish moves the first
    const id = m.add(item, { label: 'Lerakás: ' + toolName(e) });
    if (id == null) { this.limitNote(); return null; }
    this.select(id);
    if (moved) this.panel.status('A cél áthelyezve.', 'info', 1500);
    return id;
  }

  // an add that returned null: the item limit (a refusal for the collision grid said so itself, model.onRefuse)
  limitNote() { if (this.model.doc.items.length >= LIM.items) this.panel.status(`Elérted a ${LIM.items} elemes határt.`, 'bad'); }

  setStartAt(aim) {
    const pl = placement('start', aim.hit, { grid: this.grid, camYaw: this.cam.yaw });
    this.model.setStart(pl.pos, pl.yaw);
    this.select('start');
    this.panel.status('Rajtpont áthelyezve.', 'info', 1500);
    return 'start';
  }
  setStartAtAim() {
    const aim = this.aim || this.computeAim([0, 0]);
    if (!aim || !aim.hit) { this.panel.status('Nincs hová tenni a rajtpontot.', 'warn'); return; }
    this.setStartAt(aim);
  }

  beginDrag(pk) {
    const it = this.model.find(pk.id), base = it.c || it.pos;
    this.drag = { id: pk.id, key: 'drag' + (++this.dragN), y: pk.point[1], off: [base[0] - pk.point[0], base[2] - pk.point[2]], from: [this.mouse.x, this.mouse.y], moved: false };
  }
  dragMove(ndc = null) {
    const d = this.drag, m = this.model;
    if (!ndc && !d.moved && Math.hypot(this.mouse.x - d.from[0], this.mouse.y - d.from[1]) < 4) return;
    const g = this.app.gfx, ray = rayFromCamera(this.cam, ndc || this.mouse.ndc, g.camera.fov, g.aspect);
    const p = rayPlaneY(ray.o, ray.d, d.y);
    if (!p || Math.hypot(p[0] - ray.o[0], p[2] - ray.o[2]) > 500) return;
    d.moved = true;
    document.body.classList.add('ed-drag');
    const it = m.find(d.id);
    if (!it) { this.drag = null; return; }
    const ws = worldSize(it), x = p[0] + d.off[0], z = p[2] + d.off[1];
    const nx = BOXY.has(it.t) ? snapMin(x, ws[0], this.grid) : snap(x, this.grid), nz = BOXY.has(it.t) ? snapMin(z, ws[2], this.grid) : snap(z, this.grid);
    const k = it.c ? 'c' : 'pos', cur = it[k];
    m.update(d.id, { [k]: [r2(nx), cur[1], r2(nz)] }, { label: 'Mozgatás', mergeKey: d.key, mergeMs: Infinity });
  }

  // ---------------------------------------------------------------- editing the selection
  // the panel's field edits (and the numeric ones in general); key merges typing in one field into one undo step
  patch(patch, key = null) {
    if (!this.sel) return false;
    const ok = this.model.update(this.sel, patch, { label: 'Módosítás', mergeKey: key });
    if (ok) this.afterEdit();
    return ok;
  }
  afterEdit() {
    const it = this.sel && this.model.find(this.sel);
    if (!it || it.id === 'start') return;
    const pid = paletteIdOf(it);
    if (!pid) return;
    if (it.t === 'prism') this.toolSize.set(pid, { r: it.r, h: it.h });
    else if (it.size && it.t !== 'deco') this.toolSize.set(pid, { size: it.size.slice() });
  }
  setName(name) { this.model.setName(name); }
  setTheme(id) {
    if (this.model.setTheme(id)) this.panel.status('Téma váltása…', 'info', 2500);
  }

  camAxes() {
    const y = this.cam.yaw, f = [-Math.sin(y), -Math.cos(y)], r = [Math.cos(y), -Math.sin(y)];
    const dom = (v) => (Math.abs(v[0]) >= Math.abs(v[1]) ? [Math.sign(v[0]) || 1, 0, 0] : [0, 0, Math.sign(v[1]) || 1]);
    return { fwd: dom(f), right: dom(r) };
  }

  nudge(vec) {
    const it = this.sel && this.model.find(this.sel);
    if (!it) return;
    const k = it.c ? 'c' : 'pos';
    this.model.update(this.sel, { [k]: it[k].map((v, i) => v + vec[i]) }, { label: 'Mozgatás', mergeKey: 'nudge:' + this.sel });
  }

  // grow (+1) / shrink (-1) by one grid step along a world axis: the face on the +direction side of that axis moves, the other one stays
  resizeSel(axisVec, sign) {
    const it = this.sel && this.model.find(this.sel), m = this.model;
    if (!it) return;
    const ax = axisVec.findIndex((v) => v !== 0), dir = axisVec[ax], step = this.grid * sign, key = 'size:' + it.id;
    const opts = { label: 'Átméretezés', mergeKey: key };
    switch (it.t) {
      case 'prism':
        if (ax === 1) { const h = clamp(r2(it.h + step), 0.1, LIM.sizeMax), d = h - it.h; if (d) m.update(it.id, { h, c: [it.c[0], r2(it.c[1] + d / 2), it.c[2]] }, opts); }
        else m.update(it.id, { r: clamp(r2(it.r + step / 2), 0.1, LIM.sizeMax / 2) }, opts);
        break;
      case 'pad': if (ax === 1) m.update(it.id, { apex: r2(it.apex + step) }, opts); break;
      case 'light': if (ax === 1) m.update(it.id, { range: clamp(r2(it.range + sign), 1, 100) }, opts); break;
      case 'start': break;
      default: {
        if (!it.size) break;
        const turned = (it.t === 'block' || it.t === 'ramp' || it.t === 'deco') && Math.round(it.yaw / 90) % 2 === 1;
        const la = ax === 1 ? 1 : turned ? 2 - ax : ax;
        const nv = clamp(r2(it.size[la] + step), 0.1, LIM.sizeMax), d = nv - it.size[la];
        if (!d) break;
        const size = it.size.slice(); size[la] = nv;
        const k = it.c ? 'c' : 'pos', c = it[k].slice(); c[ax] = r2(c[ax] + (dir * d) / 2);
        m.update(it.id, { size, [k]: c }, opts);
      }
    }
    this.afterEdit();
  }

  focusSel() {
    const it = this.sel && this.model.find(this.sel);
    if (!it) { this.panel.status('Nincs kijelölt elem.', 'warn', 1500); return; }
    const b = itemAabb(it), c = [0, 1, 2].map((a) => (b.min[a] + b.max[a]) / 2);
    const dist = Math.max(5, Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) * 1.3), a = aimOf(this.cam.yaw, this.cam.pitch);
    this.cam.pos = [c[0] - a[0] * dist, c[1] - a[1] * dist, c[2] - a[2] * dist];
  }

  // the buttons and keys that do something to the selection / the document
  action(name) {
    const m = this.model, it = this.sel && m.find(this.sel);
    switch (name) {
      case 'undo': this.undo(); break;
      case 'redo': this.redo(); break;
      case 'test-cam': this.startTest({ from: 'cam' }); break;
      case 'test-start': this.startTest({ from: 'start' }); break;
      case 'help': this.panel.toggleHelp(); break;
      case 'save': this.save(); break;
      case 'export': this.exportMap(); break;
      case 'exit': this.app.exitEditor(); break;
      case 'rotate':
        if (!it) { this.toolYaw = wrap360(this.toolYaw + 90); this.panel.status(`Az új elem forgatása: ${this.toolYaw}°`, 'info', 1500); break; }
        m.rotate(it.id);
        if (it.t === 'block' || it.t === 'ramp' || it.t === 'prism' || it.t === 'deco') this.toolYaw = m.find(it.id).yaw;
        break;
      case 'duplicate': {
        if (!it || it.id === 'start' || it.t === 'finish') break;
        const { fwd } = this.camAxes(), ws = worldSize(it), ax = fwd.findIndex((v) => v !== 0), off = [0, 0, 0];
        off[ax] = fwd[ax] * Math.max(this.grid, snap(ws[ax], this.grid));
        const id = m.duplicate(it.id, off);
        if (id != null) this.select(id); else this.limitNote();
        break;
      }
      case 'delete':
        if (!it || it.id === 'start') break;
        m.remove(it.id);
        this.select(null);
        break;
      case 'cp-up': if (it && it.t === 'cp') m.reorderCp(it.id, -1); break;
      case 'cp-down': if (it && it.t === 'cp') m.reorderCp(it.id, 1); break;
      default: break;
    }
  }

  undo() { this.afterHistory(this.model.undo(), 'Visszavonva', 'Nincs mit visszavonni.'); }
  redo() { this.afterHistory(this.model.redo(), 'Újra', 'Nincs mit újra csinálni.'); }
  afterHistory(r, ok, none) {
    if (!r) { this.panel.status(none, 'warn', 1500); return; }
    this.panel.status(`${ok}: ${r.label}`, 'info', 1800);
    if (this.sel && !this.model.find(this.sel)) this.select(null);
    if (!this.sel && r.ids.length && this.model.find(r.ids[0])) this.select(r.ids[0]);
    this.panel.setSelection();
  }

  // the document to the store now; quiet: no "Mentve" message (the debounced save, the one before a test / on leaving). -> whether it was written
  save({ quiet = false } = {}) {
    const m = this.model;
    if (!m) return false;
    this.saveAt = 0;
    this.saveCam();
    m.doc.updated = Date.now();
    const ok = this.app.store.saveCustom(m.doc, { info: this.saveInfo() });
    this.unsaved = !ok;
    if (ok) this.savedRev = m.rev;   // (a failed write leaves the map dirty: the top bar keeps saying "Nincs mentve!", leaving / hiding / the next edit try again)
    this.panel.setSaveState(ok ? 'saved' : 'fail');
    if (ok) { if (!quiet) this.panel.status('Mentve: ' + m.doc.name, 'good', 2000); return true; }
    this.panel.status('Nincs mentve: megtelt a tárhely, vagy a böngésző letiltotta. Exportáld a pályát fájlba!', 'bad', 8000);
    const t = now();
    if (!quiet || t - this.failToastAt > 20000) {   // (an autosave after every edit must not toast every time)
      this.failToastAt = t;
      this.app.ui.toast('A mentés nem sikerült (megtelt a tárhely, vagy a böngésző letiltotta). Az Exportálás gombbal fájlba mentheted a pályát.', 6500);
    }
    return false;
  }
  // what the map list shows without building the map: only when the built world is of this very revision
  saveInfo() {
    const w = this.world, m = this.model;
    return w && this.builtRev === m.rev && !this.lastError ? mapInfo(w.map) : null;
  }
  saveIfDirty() { return this.model && this.model.rev !== this.savedRev ? this.save({ quiet: true }) : true; }

  // the .json file of the map (Blob + a temporary <a download>); the map is saved first
  exportMap() {
    if (!this.model) return false;
    this.save({ quiet: true });
    const f = exportFile(this.model.doc);
    try { downloadText(f.name, f.text); } catch (err) { console.error('[pajzsugras] export failed', err); this.panel.status('Az exportálás nem sikerült.', 'bad', 5000); return false; }
    this.panel.status('Exportálva: ' + f.name + ' (a böngésző letöltései között)', 'good', 4500);
    return true;
  }

  // the menus renamed or deleted a saved map: do not keep a stale copy for the next F2
  forget(id) { if (this.model && !this.ready && this.model.doc.id === id) this.model = null; }

  // ---------------------------------------------------------------- the test run
  async startTest({ from = 'cam' } = {}) {
    if (!this.active || this.starting) return false;
    this.starting = true;
    const session = this.session;
    try {
      await this.flush();
      if (session !== this.session || !this.active) return false;   // (left the editor while the rebuild ran)
      let pose = null;
      if (from === 'cam') {
        const c = this.cam, spot = findTestSpawn(this.world, [c.pos[0], c.pos[1] - EYE, c.pos[2]]);
        if (!spot) { this.panel.status('Innen nem lehet indulni: a kamera falban vagy halálzónában van.', 'bad', 4000); return false; }
        pose = { pos: spot, yaw: c.yaw, pitch: c.pitch };
      }
      if (this.lastError) this.panel.status('A pálya most hibás: a legutóbbi jó változatot próbálod ki.', 'warn', 4000);
      this.saveCam();
      this.saveIfDirty();
      this.testFrom = from; this.testPose = pose;
      this.testing = true;
      this.endLookForTest(); this.drag = null; this.keys.clear();
      this.root.hidden = true;
      document.body.classList.remove('editing', 'ed-look', 'ed-drag');
      this.gizmos.setVisible(false);
      this.host.beginTest({ from, pose });
      return true;
    } finally { if (session === this.session) this.starting = false; }
  }
  // T / F2 / Enter with the right button held: the mouse capture goes on into the test (unlocking here would send a late
  // pointerlockchange(false) into the 'playing' state, which would end the test at once)
  endLookForTest() {
    if (this.looking && this.app.input.locked) { this.looking = false; document.body.classList.remove('ed-look'); }
    else this.stopLook();
  }

  // after world.restart: a camera test starts where the camera was (also again after R / Enter in the test)
  applyTestStart() {
    const w = this.world;
    if (this.testFrom !== 'cam' || !this.testPose) return;
    const p = this.testPose;
    w.teleport(p.pos, p.yaw);
    w.spawn = { pos: p.pos.slice(), yaw: p.yaw };
    w.cpIndex = w.cpCount;   // practice: the finish counts without the checkpoints
  }
  get testPitch() { return this.testFrom === 'cam' && this.testPose ? this.testPose.pitch : null; }
  testHint(locked) {
    return (this.testFrom === 'cam' ? 'Gyakorló próba a kamerától' : 'Próba a rajttól') + ' · F2 / Esc: vissza a szerkesztőbe' + (locked ? '' : ' · kattints a képre az egér befogásához');
  }

  backFromTest() {
    if (!this.testing) return false;
    this.testing = false;
    this.host.endTest();
    this.testFrom = null; this.testPose = null;
    this.keys.clear();
    this.root.hidden = false;
    document.body.classList.add('editing');
    this.gizmos.setVisible(true);
    this.syncDoc();
    this.panel.status('Vissza a szerkesztőben.', 'info', 1500);
    return true;
  }

  // ---------------------------------------------------------------- the debug hook (__pj.editor)
  snapshot() {
    const m = this.model, d = m && m.doc, c = this.cam, w = this.world;
    return {
      active: this.active, ready: this.ready, testing: this.testing, tool: this.tool, sel: this.sel, rev: m ? m.rev : null, builtRev: this.builtRev, building: !!this.building,
      items: d ? d.items.length : 0, cps: m ? m.cpItems().length : 0, finish: !!(m && m.finish), name: d ? d.name : null, theme: d ? d.theme : null,
      grid: this.grid, flySpeed: Math.round(this.flySpeed * 10) / 10, toolYaw: this.toolYaw, padPending: this.padPending ? this.padPending.pos : null,
      cam: { pos: c.pos.map(r2), yawDeg: r2(c.yaw / DEG), pitchDeg: r2(c.pitch / DEG) }, canUndo: !!m && m.history.canUndo, canRedo: !!m && m.history.canRedo,
      rebuildMs: Math.round(this.rebuildMs * 10) / 10, lastError: this.lastError, ghost: this.ghost ? JSON.parse(JSON.stringify(this.ghost)) : null,
      aim: this.aim ? { hit: this.aim.hit ? { point: this.aim.hit.point.map(r2), normal: this.aim.hit.normal.map(r2) } : null, pick: this.aim.pick ? this.aim.pick.id : null } : null,
      world: w ? { brushes: w.map.brushes.length, cps: w.map.checkpoints.length, finish: !!w.map.finish, kills: w.map.kills.length, pads: w.map.pads.length, lights: w.map.lights.length, deco: w.map.deco.length, hash: w.map.mapHash } : null,
      validate: d ? validate(d, w) : null, panelHidden: this.panel ? this.panel.top.hidden : null, testFrom: this.testFrom,
      id: d ? d.id : null, dirty: !!m && m.rev !== this.savedRev, unsaved: this.unsaved, saveDueMs: this.saveAt ? Math.round(this.saveAt - now()) : null, stored: !!d && this.app.store.hasCustom(d.id),
    };
  }

  makeDebug() {
    const ed = this;
    const need = () => { if (!ed.ready) throw new Error('the editor is not open: await __pj.editor.open()'); };
    const settle = async (r) => { await ed.flush(); ed.syncDoc(); return r; };
    return {
      // open the editor (doc: an editor document, or nothing = the last one / a new one); resolves with state()
      async open(doc) { ed.leave(); if (ed.app.state === 'editor') ed.app.exitEditor(); const ok = await ed.app.openEditor(doc); return { ok, ...ed.snapshot() }; },
      close() { ed.app.exitEditor(); return ed.snapshot(); },
      // saving and files: save() -> { ok, ...state } · list() the saved maps · exportText() the file's text · importText(text) -> { ok, id, renamed, saved } | { ok: false, error }
      //   (a saved map is opened with open(id)) · remove(id) deletes a saved map
      save() { need(); const ok = ed.save(); return { ok, ...ed.snapshot() }; },
      list: () => ed.app.store.listCustom(),
      exportText() { need(); ed.saveCam(); return serialise(ed.model.doc); },
      importText(text) { const r = importMapText(ed.app.store, text); return r.error ? { ok: false, error: r.error } : { ok: true, id: r.doc.id, name: r.doc.name, renamed: r.renamed, saved: r.saved }; },
      remove(id) { const ok = deleteMap(ed.app.store, id); ed.forget(id); return ok; },
      doc: () => JSON.parse(JSON.stringify(ed.model && ed.model.doc)),
      // ops: add(itemOrPaletteId, over?) update(id, patch) remove(id) duplicate(id, offset?) rotate(id) reorderCp(id, dir) setStart(pos, yawDeg) setTheme(id)
      //      setName(name) undo() redo() select(id|null) tool(id) grid(0.5|0.1) toolYaw(deg); async: resolves after the rebuild with { ok, result, rev, rebuildMs, items }
      async exec(op, ...a) {
        need();
        const m = ed.model;
        let r;
        switch (op) {
          case 'add': r = m.add(typeof a[0] === 'string' ? newItem(a[0], a[1] || {}) : a[0]); break;
          case 'update': r = m.update(a[0], a[1]); break;
          case 'remove': r = m.remove(a[0]); if (ed.sel === a[0]) ed.select(null); break;
          case 'duplicate': r = m.duplicate(a[0], a[1]); break;
          case 'rotate': r = m.rotate(a[0]); break;
          case 'reorderCp': r = m.reorderCp(a[0], a[1]); break;
          case 'setStart': r = m.setStart(a[0], a[1]); break;
          case 'setTheme': r = m.setTheme(a[0]); break;
          case 'setName': r = m.setName(a[0]); break;
          case 'undo': r = m.undo(); if (ed.sel && !m.find(ed.sel)) ed.select(null); break;
          case 'redo': r = m.redo(); if (ed.sel && !m.find(ed.sel)) ed.select(null); break;
          case 'select': ed.select(a[0] ?? null); r = ed.sel; break;
          case 'tool': ed.setTool(a[0]); r = ed.tool; break;
          case 'grid': ed.grid = a[0] === 0.1 ? 0.1 : 0.5; r = ed.grid; break;
          case 'toolYaw': ed.toolYaw = wrap360(Math.round((a[0] || 0) / 90) * 90); r = ed.toolYaw; break;
          default: throw new Error('unknown editor op: ' + op);
        }
        await settle();
        return { ok: r !== false && r !== null && r !== undefined, result: r, rev: m.rev, rebuildMs: Math.round(ed.rebuildMs * 10) / 10, items: m.doc.items.length };
      },
      setCam(pos, yawDeg = 0, pitchDeg = -20) { need(); ed.cam = { pos: pos.slice(), yaw: yawDeg * DEG, pitch: clamp(pitchDeg * DEG, -MAX_PITCH, MAX_PITCH) }; return ed.snapshot().cam; },
      // the virtual mouse at normalised device coordinates (-1..1, +y up): -> { hit: { point, normal }, pick: { id, t, point } (select tool), ghost }
      aim(x = 0, y = 0) {
        need();
        ed.mouse.ndc = [x, y]; ed.mouse.inside = true;
        ed.computeAim();
        ed.updateGizmos();
        const s = ed.snapshot(), pk = ed.aim && ed.aim.pick;
        return { hit: s.aim && s.aim.hit, pick: pk ? { id: pk.id, t: r2(pk.t), point: pk.point.map(r2) } : null, ghost: s.ghost };
      },
      // a left click at the aim: places (tool) or selects; -> { id, sel }
      click() { need(); ed.computeAim(); const id = ed.primaryDown(); ed.primaryUp(); return settle({ id, sel: ed.sel, tool: ed.tool }); },
      // drag the item under `from` to `to` (ndc pairs): one undo step; -> { id, sel }
      drag(from, to) {
        need();
        ed.mouse.ndc = from; ed.mouse.inside = true; ed.computeAim();
        const id = ed.primaryDown();
        if (id != null && ed.drag) { ed.dragMove(to); }
        ed.primaryUp();
        return settle({ id, sel: ed.sel });
      },
      // a key press, e.g. key('KeyR'), key('KeyZ', { ctrlKey: true }), key('ArrowUp', { shiftKey: true }); -> whether the editor used it
      key(code, mods = {}) { need(); const used = ed.handleKey({ code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, preventDefault() {}, ...mods }); return settle({ used, ...ed.snapshot() }); },
      // keys held for flying: hold('KeyW', 0.5) flies for 0.5 s of frames (without waiting for real time)
      hold(code, sec = 0.2) { need(); ed.keys.add(code); for (let t = 0; t < sec; t += 1 / 60) ed.flyStep(1 / 60); ed.keys.delete(code); return ed.snapshot().cam; },
      async test({ from = 'cam' } = {}) { need(); const ok = await ed.startTest({ from }); return { ok, ...ed.snapshot() }; },
      back() { return { ok: ed.backFromTest(), ...ed.snapshot() }; },
      flush: () => ed.flush().then(() => ed.snapshot()),
      get rebuildMs() { return ed.rebuildMs; },
      state: () => ed.snapshot(),
    };
  }
}
