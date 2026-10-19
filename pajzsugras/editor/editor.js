// PAJZSUGRÁS map editor, the controller (browser only). Created once by main.js (app.editor); everything is active only while app.state
// is 'editor' (or a test from the editor is running).
//
// Every edit goes: doc (editor/model.js) -> toDef (editor/convert.js, the real map builder) -> createWorld -> a quick level rebuild that
// keeps the Surfaces (the canvas textures) of the current level (gfx.rebuildLevel), 100 ms after the last edit. The ghost, the selection
// outline and everything else in editor/gizmos.js follow the document at once, so dragging and typing never wait for a rebuild.
// Picking and placing are pure maths against the document / the last built world (editor/pick.js); a new item or a drag then sticks to the
// edges of the item under the cursor and of its neighbours (editor/snap.js).
//
// CONTROLS (editor only; the game keys are off here)
//   hold right button: look (pointer lock while held, drag-look if the lock is refused) · WASD fly · Space / E up · Q / C down · Shift 3x ·
//   wheel: fly speed · left click: place (tool) or select · Shift + click: add to / remove from the selection · drag on empty space: a selection
//   rectangle (Shift: adds) · Ctrl+A everything · left drag on the selection (also a group): move it on its plane · the arrows on the faces of one
//   selected item resize it · 1 2 3 .. 9 0 palette tools ·
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
import { DocModel, newItem, sanitizeDoc, serialise, paletteOf, paletteIdOf, itemAabb, worldSize, isSolid, validate, wrap360, r2, LIM, PALETTE } from './model.js';
import { toDef, docIdOf } from './convert.js';
import { loadDoc, newMapDoc, exportFile, downloadText, importMapText, deleteMap, mapInfo } from './library.js';
import { rayFromCamera, worldToNdc, pickRay, surfaceHit, rayPlaneY, placement, faceNormal, snap, padArc, findTestSpawn } from './pick.js';
import { aabbCache, stickPlacement, stickMove, moveReach } from './snap.js';
import { handlesFor, handleSeg, hitHandle, axisParam, extentOf, resizePatch } from './handles.js';
import { Gizmos } from './gizmos.js';
import { EditorPanel } from './panel.js';
import { createWorld } from '../sim/world.js';
import { EYE } from '../sim/const.js';
import { aimOf } from '../sim/math.js';
import { DEG_PER_PX, MAX_PITCH } from '../input.js';

const DEG = Math.PI / 180;
const REBUILD_MS = 100;       // rebuild this long after the last edit
const SAVE_MS = 1500;         // save this long after the last edit
const SYNC_MS = 60;           // while dragging: the helper meshes and the panel follow the document at most this often
const EDIT_KEYS = new Set(['KeyR', 'KeyK', 'Delete', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown']);   // keys that change items (not while a drag is on: they would fight its patches)
const BODIES = new Set(['block', 'ramp', 'prism', 'kill', 'cp', 'finish', 'deco']);   // the items with a real footprint (a pad, a light and the start point are points)
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
    this.sel = null;            // the primary selected id (the last one added), 'start' for the start point
    this.selIds = []; this.selVer = 0;   // everything selected, in the order it was added (sel is the last); selVer counts the changes
    this.hoverHandle = null; this.handleList = []; this.multiKey = null;   // the resize arrow under the pointer / the arrows of the selected item / what the group outline was built for
    this.syncAt = 0;
    this.turnMemo = null;       // the pivot of the last group rotation { selVer, rev, pivot }: the next R about the same selection and document turns about it again
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
    if (this.drag && (ctrl ? ['KeyZ', 'KeyY', 'KeyD'].includes(code) : EDIT_KEYS.has(code))) return pd();   // (the camera keys, Esc, the tools ... still work)
    if (ctrl) {
      switch (code) {
        case 'KeyZ': pd(); if (shift) this.redo(); else this.undo(); return true;
        case 'KeyY': pd(); this.redo(); return true;
        case 'KeyD': pd(); this.action('duplicate'); return true;
        case 'KeyA': pd(); this.selectAll(); return true;
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
    else if (e.button === 0) { e.preventDefault(); this.primaryDown({ shift: e.shiftKey }); }
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
      } else if (this.sel && !this.drag) this.nudge([0, d * this.grid, 0]);
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
    this.model.onRefuse = (msg) => {   // (a drag that keeps hitting the limit says it once)
      if (this.drag) { if (this.drag.refused) return; this.drag.refused = true; }
      this.panel.status(msg, 'bad', 5000);
    };
    this.saveAt = 0;
    if (store.hasCustom(d.id)) store.setLastCustom(d.id);
    this.cam = { pos: d.cam.pos.slice(), yaw: d.cam.yaw * DEG, pitch: d.cam.pitch * DEG };
    this.sel = null; this.selIds = []; this.selVer++; this.multiKey = null; this.tool = 'select'; this.padPending = null; this.drag = null; this.keys.clear(); this.lift = 0;
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
    this.panel.setMarquee(null);
    document.body.classList.remove('editing', 'ed-look', 'ed-drag', 'ed-handle');
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
    if (m.rev !== this.syncedRev && (!this.drag || now() - this.syncAt >= SYNC_MS)) { this.syncDoc(); this.rebuildAt = now() + REBUILD_MS; }   // (a drag redraws the helper meshes at most every 60 ms)
    if (m.rev !== this.builtRev && !this.building && !this.drag && now() >= this.rebuildAt) this.rebuild();
    if (this.saveAt && !this.drag && now() >= this.saveAt) this.save({ quiet: true });
    this.computeAim();
    this.updateGizmos();
    this.gizmos.update(this.cam.pos);
  }

  syncDoc() {
    const rev = this.model.rev;
    this.syncAt = now();
    this.pruneSel();
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
    let hit = surfaceHit(this.world, ray.o, ray.d), target = null;
    if (!this.drag) {
      // the solid item the placement sticks to: the first one on the live document. The built world can lag behind it by 100 ms: a solid
      // in front of the trace is a new one, so the surface is that one's; one at the trace's distance is the surface's item
      // (a solid the ray starts inside is no surface: the camera in a wall does not put the ghost at the camera)
      const pk = pickRay(this.model.doc, ray.o, ray.d, { filter: isSolid });
      if (pk && pk.t > 0.01) {
        if (!hit || pk.t < hit.t - 0.02) { hit = { point: pk.point, normal: faceNormal(itemAabb(pk.item), pk.point), t: pk.t }; target = pk.item; }
        else if (Math.abs(pk.t - hit.t) <= 0.05) target = pk.item;
      }
    }
    if (hit && this.lift && this.tool !== 'select') hit = { ...hit, point: [hit.point[0], hit.point[1] + this.lift, hit.point[2]] };   // Shift + wheel lift
    const aim = { ndc, ray, hit, target, pick: null };
    if (this.tool === 'select' && !this.drag) aim.pick = pickRay(this.model.doc, ray.o, ray.d);
    this.aim = aim;
    return aim;
  }

  // The position fields a click would give palette entry e (base: its item with the remembered size / yaw): placement() on the aimed surface,
  // then stuck to the target and its neighbours. The ghost and the click both come from here, so they never differ.
  placeOn(e, aim, base = null) {
    const pl = placement(e, aim.hit, { grid: this.grid, size: base ? worldSize(base) : null, yaw: base ? base.yaw || 0 : 0, camYaw: this.cam.yaw });
    if (!aim.target) return pl;
    const k = pl.c ? 'c' : 'pos', m = this.model;
    const to = stickPlacement({ ...(base || { t: e.t }), ...pl }, aim.hit, aim.target, { cache: aabbCache(m.doc, m.rev), grid: this.grid, lifted: !!this.lift });
    return { ...pl, [k]: to.map(r2) };
  }

  // what a click would place right now (null: nothing to place)
  ghostItem(aim) {
    const e = paletteOf(this.tool);
    if (!e || e.t === 'start' || !aim || !aim.hit) return null;
    const over = {}, rem = this.toolSize.get(e.id);
    if (rem) { if (rem.size) over.size = rem.size; if (rem.r) { over.r = rem.r; over.h = rem.h; } }
    if (['block', 'ramp', 'prism', 'deco'].includes(e.t)) over.yaw = this.toolYaw;
    const base = newItem(e, over);
    return newItem(e, { ...over, ...this.placeOn(e, aim, base) });
  }

  defaultApex(pos, target) {
    const dist = Math.hypot(target[0] - pos[0], target[2] - pos[2]);
    return r2(Math.max(pos[1], target[1]) + clamp(dist * 0.3, 3, 15));
  }

  updateGizmos() {
    const g = this.gizmos, aim = this.aim, e = paletteOf(this.tool);
    g.setSelection(this.sel ? this.model.find(this.sel) : null);
    const mk = this.selVer + ':' + this.model.rev;
    if (mk !== this.multiKey) { this.multiKey = mk; g.setMulti(this.selIds.length > 1 ? this.selItems().slice(0, -1) : [], mk); }   // (the other items of a group: rebuilt only when it or the document changed)
    this.updateHandles();
    let ghost = null, arc = null, centre = null;
    if (e && !this.drag && aim && aim.hit) {
      const p = aim.hit.point, sn = (v) => snap(v, this.grid);
      if (e.t === 'start') {
        const pl = this.placeOn(e, aim);
        ghost = { t: 'start', pos: pl.pos, yaw: pl.yaw };
      } else if (e.t === 'pad') {
        const pl = this.placeOn(e, aim);
        if (this.padPending) {
          const pos = this.padPending.pos, target = pl.pos, it = newItem('pad', { pos, target, apex: this.defaultApex(pos, target) });
          ghost = it; arc = padArc(it, 24);
        } else ghost = newItem('pad', { pos: pl.pos });
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
    if (this.tool === 'select') {
      if (this.drag && this.drag.kind === 'box') return 'Kijelölő keret · Shift: a meglévő kijelöléshez adja';
      if (this.selIds.length > 1) return 'Húzással együtt mozognak · R forgat · Ctrl+D másol · Del töröl · Shift+kattintás: hozzáad / elvesz';
      return this.sel ? `Húzással mozgatod · ${this.handleList.length ? 'a nyilakat húzva átméretezed · ' : ''}R forgat · Del töröl · nyilak: finom mozgatás · Shift+kattintás: több elem` : 'Bal gomb: kijelöl · húzás üres helyen: kijelölő keret · jobb gomb nyomva: körbenézés · 1–0: eszköz · H: súgó';
    }
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
    this.lift = 0;   // (the lift belongs to the tool it was set with)
    this.panel.setTool(id);
  }
  // The selection: selIds in the order the items were added, sel (the primary one: the panel shows it, a handle drag and Shift+arrow resize
  // work on it) is the last of them. Ids that do not exist (any more) never stay in it.
  setSel(ids, primary = null) {
    const have = new Set(this.model.doc.items.map((i) => i.id)), list = [];
    for (const id of ids) if (!list.includes(id) && (id === 'start' || have.has(id))) list.push(id);
    if (primary != null && list.includes(primary)) list.push(list.splice(list.indexOf(primary), 1)[0]);
    if (list.length === this.selIds.length && list.every((id, i) => id === this.selIds[i])) return;
    this.selIds = list; this.sel = list.length ? list[list.length - 1] : null; this.selVer++;
    this.panel.setSelection();
  }
  select(id) { this.setSel(id == null ? [] : [id]); }
  toggleSel(id) { this.setSel(this.isSel(id) ? this.selIds.filter((x) => x !== id) : [...this.selIds, id]); }
  isSel(id) { return this.selIds.includes(id); }
  selItems() {
    const by = new Map(this.model.doc.items.map((i) => [i.id, i]));
    return this.selIds.map((id) => by.get(id) || (id === 'start' ? this.model.find('start') : null)).filter(Boolean);
  }
  selectAll() {
    this.setTool('select');
    this.setSel(['start', ...this.model.doc.items.map((i) => i.id)]);
  }
  // an undo, a delete or a debug op took items away: drop them from the selection
  pruneSel() {
    if (!this.selIds.length) return;
    const have = new Set(this.model.doc.items.map((i) => i.id));
    if (!this.selIds.every((id) => id === 'start' || have.has(id))) this.setSel(this.selIds);
  }
  escape() {
    if (!this.panel.help.hidden) this.panel.toggleHelp();
    else if (this.padPending) { this.padPending = null; this.panel.status('Ugrópárna megszakítva'); }
    else if (this.tool !== 'select') this.setTool('select');
    else this.select(null);
  }

  // mods = { shift }. Select tool: a resize arrow of the one selected item, else the item under the pointer (Shift: add / remove it, no drag;
  // one of a group: the whole group moves, a click without moving then keeps just that item), else a selection rectangle.
  primaryDown(mods = {}) {
    const aim = this.computeAim();
    if (this.tool !== 'select') return this.placeAtAim(aim);
    const hh = !this.looking && aim ? this.handleHit(aim.ndc) : null;
    if (hh) { this.beginHandle(hh, aim); return this.sel; }
    const pk = aim && aim.pick;
    if (!pk) { this.beginBox(!!mods.shift); return null; }
    if (mods.shift) { this.toggleSel(pk.id); return pk.id; }
    const grouped = this.selIds.length > 1 && this.isSel(pk.id);
    if (grouped) this.setSel(this.selIds, pk.id); else this.select(pk.id);
    this.beginDrag(pk, grouped);
    return pk.id;
  }
  primaryUp() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    document.body.classList.remove('ed-drag');
    if (d.kind === 'box') this.endBox(d);
    else if (d.kind === 'move' && d.collapse && !d.moved) this.select(d.id);
  }

  // the click of a placement tool; returns the id of the new item (or 'start')
  placeAtAim(aim) {
    const e = paletteOf(this.tool), m = this.model;
    if (!aim || !aim.hit) { this.panel.status('Nincs hová lerakni: célozz a padlóra vagy egy felületre.', 'warn'); return null; }
    if (e.t === 'start') return this.setStartAt(aim);
    if (e.t === 'pad') {
      const pl = this.placeOn(e, aim);
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
    const pl = this.placeOn(paletteOf('start'), aim);
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

  // The mouse at normalised device coordinates (the debug hook; also keeps the pixel position the 4 px drag threshold and the rectangle use).
  setMouseNdc(ndc) {
    const r = this.app.gfx.canvas.getBoundingClientRect();
    this.mouse.ndc = ndc.slice(); this.mouse.inside = true;
    this.mouse.x = r.left + ((ndc[0] + 1) / 2) * r.width; this.mouse.y = r.top + ((1 - ndc[1]) / 2) * r.height;
  }

  // ---- the three drags: move (one item or the whole selection), resize (an arrow), selection rectangle
  beginDrag(pk, group = false) {
    const m = this.model, ids = this.selIds.slice(), it = m.find(pk.id), base = it.c || it.pos;
    this.drag = {
      kind: 'move', id: pk.id, ids, orig: new Map(ids.map((id) => [id, JSON.parse(JSON.stringify(m.find(id)))])), key: 'drag' + (++this.dragN),
      y: pk.point[1], off: [base[0] - pk.point[0], base[2] - pk.point[2]], from: [this.mouse.x, this.mouse.y], moved: false,
      start: base.slice(), cache: aabbCache(m.doc, m.rev), delta: null, collapse: group,   // (start: the centre it began from: its grid starts at its min corner; the others do not move meanwhile)
    };
  }
  beginBox(add) { this.drag = { kind: 'box', add, from: [this.mouse.x, this.mouse.y], cur: [this.mouse.x, this.mouse.y], moved: false }; }
  beginHandle(hh, aim) {
    const m = this.model, it = m.find(this.sel), b = itemAabb(it), vec = [0, 0, 0];
    vec[hh.axis] = 1;
    const s0 = axisParam(aim.ray, hh.face, vec);
    if (s0 === null) return;   // (looking along the arrow: nothing to grab)
    // the face that stays; a pillar's side arrow scales the radius about the centre, so there the face's distance from the centre is what follows the
    // pointer, times k = (the width of its bounds) / (that distance now): an odd number of sides is not symmetric about the centre
    const fixed = hh.kind === 'r' ? it.c[hh.axis] : hh.dir > 0 ? b.min[hh.axis] : b.max[hh.axis];
    const k = hh.kind === 'r' ? (b.max[hh.axis] - b.min[hh.axis]) / (hh.dir * (hh.face[hh.axis] - fixed)) : 1;
    this.drag = {
      kind: 'handle', id: it.id, h: hh, vec, s0, fixed, k, box: b, orig: JSON.parse(JSON.stringify(it)), key: 'handle' + (++this.dragN),
      cache: aabbCache(m.doc, m.rev), from: [this.mouse.x, this.mouse.y], moved: false,
    };
  }
  dragMove(ndc = null) {
    const d = this.drag;
    if (ndc) this.setMouseNdc(ndc);
    if (!ndc && !d.moved && Math.hypot(this.mouse.x - d.from[0], this.mouse.y - d.from[1]) < 4) return;
    if (d.kind === 'box') this.moveBox(d);
    else if (d.kind === 'handle') this.moveHandle(d);
    else this.moveItems(d);
  }
  moveItems(d) {
    const m = this.model, g = this.app.gfx, ray = rayFromCamera(this.cam, this.mouse.ndc, g.camera.fov, g.aspect);
    const p = rayPlaneY(ray.o, ray.d, d.y);
    if (!p || Math.hypot(p[0] - ray.o[0], p[2] - ray.o[2]) > 500) return;
    d.moved = true;
    document.body.classList.add('ed-drag');
    const it = m.find(d.id);
    if (!it) { this.drag = null; return; }
    const k = it.c ? 'c' : 'pos', cur = it[k];
    // the pointer's item sticks to its neighbours, everything selected moves by the same step from where it began
    const to = stickMove(it, [p[0] + d.off[0], cur[1], p[2] + d.off[1]], d.start, { cache: d.cache, grid: this.grid, exclude: d.ids });
    const delta = [to[0] - d.start[0], 0, to[2] - d.start[2]];
    if (d.delta && d.delta[0] === delta[0] && d.delta[2] === delta[2]) return;
    d.delta = delta;
    m.batch('Mozgatás', () => { for (const id of d.ids) m.update(id, this.shifted(d.orig.get(id), delta, d.ids.length > 1)); },
      { mergeKey: d.key, mergeMs: Infinity, sel: () => [d.ids, d.ids] });
  }
  moveHandle(d) {
    const m = this.model, g = this.app.gfx, h = d.h, ax = h.axis, ray = rayFromCamera(this.cam, this.mouse.ndc, g.camera.fov, g.aspect);
    const s = axisParam(ray, h.face, d.vec);
    if (s === null) return;
    d.moved = true;
    document.body.classList.add('ed-drag');
    // the face follows the pointer along the arrow; a face of a neighbour (that is beside this face) within the reach (a fifth of the extent along
    // the arrow, half a grid step to a metre) wins over the grid
    const side = this.grid / 2, f0 = h.face[ax] + (s - d.s0), B = d.box, k = d.k;
    let f = null, best = moveReach(this.grid, B.max[ax] - B.min[ax]) + 1e-9;
    for (const e of d.cache) {
      if (e.id === d.id || [0, 1, 2].some((o) => o !== ax && (e.b.min[o] > B.max[o] + side || e.b.max[o] < B.min[o] - side))) continue;
      for (const c of [e.b.min[ax], e.b.max[ax]]) if (Math.abs(c - f0) < best) { best = Math.abs(c - f0); f = c; }
    }
    const dist = h.dir * ((f === null ? f0 : f) - d.fixed);   // how far the face is from the one that stays (a pillar: from its centre)
    const q = f !== null ? dist : h.kind === 'r' ? snap(dist * 2, this.grid) / 2 : snap(dist, this.grid);   // (a pillar: its width is on the grid when it is symmetric)
    const extent = clamp(k * q, LIM.sizeMin, LIM.sizeMax);   // (no flipping through the opposite face)
    m.update(d.id, resizePatch(d.orig, ax, h.dir, extent), { label: 'Átméretezés', mergeKey: d.key, mergeMs: Infinity });
    this.afterEdit();
  }
  moveBox(d) {
    d.moved = true;
    d.cur = [this.mouse.x, this.mouse.y];
    this.panel.setMarquee({ x: Math.min(d.from[0], d.cur[0]), y: Math.min(d.from[1], d.cur[1]), w: Math.abs(d.cur[0] - d.from[0]), h: Math.abs(d.cur[1] - d.from[1]) });
  }
  // the rectangle is done: without moving it is a click on empty space (clears the selection, Shift keeps it); else the items that are wholly
  // inside it (all 8 corners of their bounds, in front of the camera) are selected, a pad / a light / the start point by their spot; Shift adds
  // them to the selection. (A big floor under the things in the rectangle is not taken.)
  endBox(d) {
    this.panel.setMarquee(null);
    if (!d.moved) { if (!d.add) this.select(null); return; }
    const g = this.app.gfx, r = g.canvas.getBoundingClientRect();
    const nx = (x) => ((x - r.left) / r.width) * 2 - 1, ny = (y) => -(((y - r.top) / r.height) * 2 - 1);
    const x0 = nx(Math.min(d.from[0], d.cur[0])), x1 = nx(Math.max(d.from[0], d.cur[0])), y0 = ny(Math.max(d.from[1], d.cur[1])), y1 = ny(Math.min(d.from[1], d.cur[1]));
    const ids = [];
    const inside = (p) => { const w = worldToNdc(this.cam, p, g.camera.fov, g.aspect); return !!w && w[0] >= x0 && w[0] <= x1 && w[1] >= y0 && w[1] <= y1; };
    for (const it of [this.model.find('start'), ...this.model.doc.items]) {
      const b = itemAabb(it);
      const spots = BODIES.has(it.t) ? Array.from({ length: 8 }, (_, i) => [i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]]) : [it.pos];
      if (spots.every(inside)) ids.push(it.id);
    }
    this.setSel(d.add ? [...this.selIds, ...ids] : ids);
  }

  // ---- the resize arrows of the one selected item
  handleHit(ndc) {
    if (this.tool !== 'select' || this.selIds.length !== 1 || !ndc) return null;
    const list = handlesFor(this.model.find(this.sel));
    if (!list.length) return null;
    const g = this.app.gfx, r = g.canvas.getBoundingClientRect();
    return hitHandle(list, this.cam, ndc, g.camera.fov, g.aspect, r.width, r.height);
  }
  // every frame: the arrows of the selected item (only while no other drag is on), the one under the pointer (or being dragged) highlighted
  updateHandles() {
    const d = this.drag, g = this.app.gfx;
    const it = this.tool === 'select' && this.selIds.length === 1 && (!d || d.kind === 'handle') ? this.model.find(this.sel) : null;
    const list = it ? handlesFor(it) : [];
    this.handleList = list;
    let hover = -1;
    const find = (h) => (h ? list.findIndex((x) => x.axis === h.axis && x.dir === h.dir) : -1);
    if (d && d.kind === 'handle') hover = find(d.h);
    else if (list.length && this.mouse.inside && !this.looking) hover = find(this.handleHit(this.mouse.ndc));
    this.hoverHandle = hover >= 0 ? list[hover] : null;
    this.gizmos.setHandles(list.length ? list.map((h) => ({ ...handleSeg(h, this.cam, g.camera.fov), axis: h.axis, dir: h.dir })) : null, hover);
    document.body.classList.toggle('ed-handle', hover >= 0);
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

  // the patch that moves an item by v; in a group a pad takes its target and apex along, alone it moves only its own spot
  shifted(it, v, group) {
    const add = (p) => p.map((x, i) => x + v[i]);
    if (it.t === 'pad') return group ? { pos: add(it.pos), target: add(it.target), apex: it.apex + v[1] } : { pos: add(it.pos) };
    return { [it.c ? 'c' : 'pos']: add(it.c || it.pos) };
  }

  nudge(vec) {
    if (this.selIds.length > 1) {
      const m = this.model, ids = this.selIds.slice();
      m.batch('Mozgatás', () => { for (const id of ids) m.update(id, this.shifted(m.find(id), vec, true)); }, { mergeKey: 'nudge:' + ids.slice().sort().join(','), sel: () => [ids, ids] });
      return;
    }
    const it = this.sel && this.model.find(this.sel);
    if (!it) return;
    const k = it.c ? 'c' : 'pos';
    this.model.update(this.sel, { [k]: it[k].map((v, i) => v + vec[i]) }, { label: 'Mozgatás', mergeKey: 'nudge:' + this.sel });
  }

  // grow (+1) / shrink (-1) by one grid step along a world axis: the face on the +direction side of that axis moves, the other one stays
  resizeSel(axisVec, sign) {
    if (this.selIds.length > 1) { this.panel.status('Csoportot nem lehet átméretezni', 'warn', 2000); return; }
    const it = this.sel && this.model.find(this.sel), m = this.model;
    if (!it) return;
    const ax = axisVec.findIndex((v) => v !== 0), dir = axisVec[ax], step = this.grid * sign, key = 'size:' + it.id;
    const opts = { label: 'Átméretezés', mergeKey: key };
    switch (it.t) {
      case 'pad': if (ax === 1) m.update(it.id, { apex: r2(it.apex + step) }, opts); break;
      case 'light': if (ax === 1) m.update(it.id, { range: clamp(r2(it.range + sign), 1, 100) }, opts); break;
      case 'start': break;
      default: {   // a box or a pillar: that face moves by one step, the opposite one stays
        const patch = resizePatch(it, ax, dir, extentOf(it, ax) + step);
        if (patch) m.update(it.id, patch, opts);
      }
    }
    this.afterEdit();
  }

  focusSel() {
    const items = this.selItems();
    if (!items.length) { this.panel.status('Nincs kijelölt elem.', 'warn', 1500); return; }
    const b = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };   // (the bounds of everything selected)
    for (const it of items) { const ib = itemAabb(it); for (let a = 0; a < 3; a++) { b.min[a] = Math.min(b.min[a], ib.min[a]); b.max[a] = Math.max(b.max[a], ib.max[a]); } }
    const c = [0, 1, 2].map((a) => (b.min[a] + b.max[a]) / 2);
    const dist = Math.max(5, Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) * 1.3), a = aimOf(this.cam.yaw, this.cam.pitch);
    this.cam.pos = [c[0] - a[0] * dist, c[1] - a[1] * dist, c[2] - a[2] * dist];
  }

  // the buttons and keys that do something to the selection / the document
  action(name) {
    const m = this.model, group = this.selIds.length > 1, it = !group && this.sel && m.find(this.sel);
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
        if (group) { this.rotateGroup(); break; }
        if (!it) { this.toolYaw = wrap360(this.toolYaw + 90); this.panel.status(`Az új elem forgatása: ${this.toolYaw}°`, 'info', 1500); break; }
        m.rotate(it.id);
        if (it.t === 'block' || it.t === 'ramp' || it.t === 'prism' || it.t === 'deco') this.toolYaw = m.find(it.id).yaw;
        break;
      case 'duplicate': {
        if (group) { this.duplicateGroup(); break; }
        if (!it || it.id === 'start' || it.t === 'finish') break;
        const { fwd } = this.camAxes(), ws = worldSize(it), ax = fwd.findIndex((v) => v !== 0), off = [0, 0, 0];
        off[ax] = fwd[ax] * Math.max(this.grid, snap(ws[ax], this.grid));
        const id = m.duplicate(it.id, off);
        if (id != null) this.select(id); else this.limitNote();
        break;
      }
      case 'delete':
        if (group) { this.deleteGroup(); break; }
        if (!it || it.id === 'start') break;
        m.remove(it.id);
        this.select(null);
        break;
      case 'cp-up': if (it && it.t === 'cp') m.reorderCp(it.id, -1); break;
      case 'cp-down': if (it && it.t === 'cp') m.reorderCp(it.id, 1); break;
      default: break;
    }
  }

  // ---- operations on a group (several items selected): each is ONE undo step that brings the selection back
  // the panel's material for all of them
  patchGroup(patch, key = null) {
    const m = this.model, ids = this.selIds.slice();
    return m.batch('Módosítás', () => { for (const id of ids) m.update(id, patch); }, { mergeKey: key, sel: () => [ids, ids] });
  }
  // 90 degrees about a pivot, each item also turning on its own (model.rotate). Only the items with a footprint make the bounds (a pad, a light and
  // the start point are points: with nothing else, the spots do). If the min corner of the bounds is on the grid the pivot is the grid point nearest
  // their middle (a quarter turn about a grid point takes grid points to grid points, so blocks on the grid stay on it), else the middle itself
  // (an off-grid group is not pulled). Turning again at once (same selection and grid, nothing edited since) keeps the pivot: four turns are the identity.
  rotateGroup() {
    const m = this.model, ids = this.selIds.slice(), items = this.selItems(), bodies = items.filter((it) => BODIES.has(it.t));
    const lo = [Infinity, 0, Infinity], hi = [-Infinity, 0, -Infinity], spots = [];
    const grow = (x, z) => { lo[0] = Math.min(lo[0], x); hi[0] = Math.max(hi[0], x); lo[2] = Math.min(lo[2], z); hi[2] = Math.max(hi[2], z); };
    if (bodies.length) for (const it of bodies) { const b = itemAabb(it); grow(b.min[0], b.min[2]); grow(b.max[0], b.max[2]); }
    else for (const it of items) for (const p of it.t === 'pad' ? [it.pos, it.target] : [it.pos]) { grow(p[0], p[2]); spots.push(p); }
    const memo = this.turnMemo, onGrid = (v) => Math.abs(v / this.grid - Math.round(v / this.grid)) < 1e-6;
    const gridded = bodies.length ? onGrid(lo[0]) && onGrid(lo[2]) : spots.every((p) => onGrid(p[0]) && onGrid(p[2]));
    const mx = (lo[0] + hi[0]) / 2, mz = (lo[2] + hi[2]) / 2;
    const pivot = memo && memo.selVer === this.selVer && memo.rev === m.rev && memo.grid === this.grid ? memo.pivot : gridded ? [snap(mx, this.grid), snap(mz, this.grid)] : [r2(mx), r2(mz)];   // (0.01 m numbers: the turns stay exact)
    const turn = (p) => [pivot[0] + (p[2] - pivot[1]), p[1], pivot[1] - (p[0] - pivot[0])];   // (dx, dz) -> (dz, -dx): the way a yaw of +90 turns things in three.js and in itemAabb
    const ok = m.batch('Forgatás', () => {
      for (const it of items) {
        m.rotate(it.id);   // (a pad and a light have no turn of their own)
        m.update(it.id, it.t === 'pad' ? { pos: turn(it.pos), target: turn(it.target) } : { [it.c ? 'c' : 'pos']: turn(it.c || it.pos) });
      }
    }, { sel: () => [ids, ids] });
    if (ok) this.turnMemo = { selVer: this.selVer, rev: m.rev, grid: this.grid, pivot };
  }
  // copies one step along the axis the camera looks along, after the last selected item in the list, in the original order; the start point and
  // the finish are not copied; all or nothing; the copies become the selection
  duplicateGroup() {
    const m = this.model, items = this.selItems().filter((it) => it.id !== 'start' && it.t !== 'finish').sort((a, b) => m.indexOf(a.id) - m.indexOf(b.id));
    if (!items.length) return;
    if (m.doc.items.length + items.length > LIM.items) {
      this.panel.status(`A másolatok nem férnek el: ${items.length} új elem kellene, de a ${LIM.items} elemes határig csak ${LIM.items - m.doc.items.length} fér még.`, 'bad', 5000);
      return;
    }
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const it of items) { const b = itemAabb(it); for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], b.min[a]); hi[a] = Math.max(hi[a], b.max[a]); } }
    const { fwd } = this.camAxes(), ax = fwd.findIndex((v) => v !== 0), off = [0, 0, 0];
    off[ax] = fwd[ax] * Math.max(this.grid, snap(hi[ax] - lo[ax], this.grid));
    const before = this.selIds.slice(), made = [], last = Math.max(...items.map((it) => m.indexOf(it.id)));
    const ok = m.batch('Másolás', () => {
      for (const it of items) { const id = m.duplicate(it.id, off, { index: last + 1 + made.length }); if (id == null) return false; made.push(id); }
    }, { sel: () => [before, made] });
    if (ok) this.setSel(made);
  }
  // everything selected but the start point
  deleteGroup() {
    const m = this.model, ids = this.selIds.filter((id) => id !== 'start'), before = this.selIds.slice();
    if (!ids.length) return;
    m.batch('Elemek törlése', () => { for (const id of ids) m.remove(id); }, { sel: () => [before, before.filter((id) => id === 'start')] });
    this.setSel(before.filter((id) => id === 'start'));
  }

  undo() { this.afterHistory(this.model.undo(), 'Visszavonva', 'Nincs mit visszavonni.'); }
  redo() { this.afterHistory(this.model.redo(), 'Újra', 'Nincs mit újra csinálni.'); }
  afterHistory(r, ok, none) {
    if (!r) { this.panel.status(none, 'warn', 1500); return; }
    this.panel.status(`${ok}: ${r.label}`, 'info', 1800);
    if (r.sel) this.setSel(r.sel);   // (a group operation brings its selection back)
    else {
      this.pruneSel();
      if (!this.sel && r.ids.length && this.model.find(r.ids[0])) this.select(r.ids[0]);
    }
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
      this.panel.setMarquee(null);
      document.body.classList.remove('editing', 'ed-look', 'ed-drag', 'ed-handle');
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
      active: this.active, ready: this.ready, testing: this.testing, tool: this.tool, sel: this.sel, sels: this.selIds.slice(), rev: m ? m.rev : null, builtRev: this.builtRev, building: !!this.building,
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
      //      setName(name) undo() redo() select(id|[ids]|null) selectAll() tool(id) grid(0.5|0.1) toolYaw(deg); async: resolves after the rebuild with { ok, result, rev, rebuildMs, items }
      async exec(op, ...a) {
        need();
        const m = ed.model;
        let r;
        switch (op) {
          case 'add': r = m.add(typeof a[0] === 'string' ? newItem(a[0], a[1] || {}) : a[0]); break;
          case 'update': r = m.update(a[0], a[1]); break;
          case 'remove': r = m.remove(a[0]); ed.pruneSel(); break;
          case 'duplicate': r = m.duplicate(a[0], a[1]); break;
          case 'rotate': r = m.rotate(a[0]); break;
          case 'reorderCp': r = m.reorderCp(a[0], a[1]); break;
          case 'setStart': r = m.setStart(a[0], a[1]); break;
          case 'setTheme': r = m.setTheme(a[0]); break;
          case 'setName': r = m.setName(a[0]); break;
          case 'undo': r = m.undo(); ed.pruneSel(); break;
          case 'redo': r = m.redo(); ed.pruneSel(); break;
          case 'select': if (Array.isArray(a[0])) { ed.setSel(a[0]); r = ed.selIds.slice(); } else { ed.select(a[0] ?? null); r = ed.sel; } break;
          case 'selectAll': ed.selectAll(); r = ed.selIds.length; break;
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
        ed.setMouseNdc([x, y]);
        ed.computeAim();
        ed.updateGizmos();
        const s = ed.snapshot(), pk = ed.aim && ed.aim.pick;
        return { hit: s.aim && s.aim.hit, pick: pk ? { id: pk.id, t: r2(pk.t), point: pk.point.map(r2) } : null, ghost: s.ghost };
      },
      // a left click at the aim: places (tool) or selects; mods = { shift } -> { id, sel, sels, tool }
      click(mods = {}) { need(); ed.computeAim(); const id = ed.primaryDown(mods); ed.primaryUp(); return settle({ id, sel: ed.sel, sels: ed.selIds.slice(), tool: ed.tool }); },
      // drag from `from` to `to` (ndc pairs) with the left button: the item under `from` (the whole selection when it is in a group) moves, a resize arrow
      // resizes, empty space makes a selection rectangle; one undo step; -> { id, sel, sels }
      drag(from, to, mods = {}) {
        need();
        ed.setMouseNdc(from); ed.computeAim();
        const id = ed.primaryDown(mods);
        if (ed.drag) ed.dragMove(to);
        ed.primaryUp();
        return settle({ id, sel: ed.sel, sels: ed.selIds.slice() });
      },
      // the selection rectangle from `a` to `b` (ndc pairs), also over items; mods = { shift } adds to the selection; -> { sel, sels }
      boxSelect(a, b, mods = {}) {
        need();
        ed.setMouseNdc(a); ed.beginBox(!!mods.shift);
        ed.dragMove(b);
        ed.primaryUp();
        return settle({ sel: ed.sel, sels: ed.selIds.slice() });
      },
      // the resize arrows of the one selected item: [{ axis, dir, kind, ndc }] (ndc: the middle of the arrow on the screen; null: behind the camera)
      handles() {
        need();
        const g = ed.app.gfx, it = ed.selIds.length === 1 ? ed.model.find(ed.sel) : null;
        return handlesFor(it).map((h) => {
          const s = handleSeg(h, ed.cam, g.camera.fov), n = worldToNdc(ed.cam, [0, 1, 2].map((a) => (s.base[a] + s.tip[a]) / 2), g.camera.fov, g.aspect);
          return { axis: h.axis, dir: h.dir, kind: h.kind, ndc: n ? [n[0], n[1]] : null };
        });
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
