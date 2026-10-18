// Keyboard + mouse. Turns browser events into the sim's per-tick `cmd` (sim/pmove.js makeCmd).
//
//   const input = new Input(canvas, settings, hooks);   hooks = { onLockChange(locked), onEscape(), onTab(down), onView() }
//   (onView: the V key while playing, not while typing in a field - main.js toggles the first / third person camera)
//   input.enabled      game keys only work while true (the game is being played)
//   input.yaw / pitch  look angles in radians, updated straight from the mouse (the camera reads them every frame)
//   input.lock()       pointer lock (unadjustedMovement where available, plain lock as a fallback, soft lock if unsupported)
//   input.fillCmd(cmd) fills a makeCmd() for ONE sim tick: held keys + latched presses shorter than a tick
//                      (jump, shield, dodge, respawn, restart are seen by the sim for at least one tick). A Space (or the shield button) that was
//                      released and pressed again before the next tick is seen as released for one tick in between, so the sim gets both presses
//   input.keyState()   what is currently pressed (for the key overlay)
//
// Dodge: double-tap a direction within 0.25 s, as in UT2004. Shift does nothing: there is no sprint, you always run.
import { DODGE } from './sim/const.js';

const DIR_KEYS = { KeyW: DODGE.F, ArrowUp: DODGE.F, KeyS: DODGE.B, ArrowDown: DODGE.B, KeyA: DODGE.L, ArrowLeft: DODGE.L, KeyD: DODGE.R, ArrowRight: DODGE.R };
const GAME_KEYS = new Set([...Object.keys(DIR_KEYS), 'Space', 'KeyR', 'Enter', 'Tab']);
const TAP_WINDOW = 250;            // ms between the two taps of a double-tap dodge
export const MAX_PITCH = (89 * Math.PI) / 180;
const isTyping = (t) => !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
export const DEG_PER_PX = 0.05;    // at sensitivity 1.0 (about 23 cm per full turn at 800 dpi); the editor's fly camera uses both

export class Input {
  constructor(canvas, settings, hooks = {}) {
    this.canvas = canvas;
    this.s = settings;
    this.hooks = hooks;
    this.enabled = false;
    this.locked = false;
    this.soft = !('requestPointerLock' in canvas);   // no pointer lock API: mouse look without the lock
    this.yaw = 0;
    this.pitch = 0;
    this.dyaw = 0; this.dpitch = 0;                   // look change since the last frame (for the viewmodel sway)
    this.keys = new Set();
    this.dirOrder = [];                               // held direction keys, most recent last
    this.lastTap = {};                                // dodge direction -> time of the last tap
    this.fireDown = false;
    this.latch = { jump: false, fire: false, dodge: 0, respawn: false, restart: false };
    // The sim reacts to a fresh press only (a jump / a shield release), so a release and a new press between two ticks must not merge into one
    // held stretch: xSent = the last cmd had it on, xGap = it went up since, so the next cmd shows it off for one tick (the latch keeps the new press)
    this.jumpSent = false; this.jumpGap = false;
    this.fireSent = false; this.fireGap = false;
    this.attached = false;
  }

  attach() {
    if (this.attached) return;
    this.attached = true;
    const on = (t, ev, fn, o) => t.addEventListener(ev, fn, o);
    on(document, 'keydown', (e) => this.onKeyDown(e));
    on(document, 'keyup', (e) => this.onKeyUp(e));
    on(this.canvas, 'mousedown', (e) => this.onMouseDown(e));
    on(document, 'mouseup', (e) => this.onMouseUp(e));
    on(document, 'mousemove', (e) => this.onMouseMove(e));
    on(this.canvas, 'contextmenu', (e) => e.preventDefault());
    on(window, 'blur', () => this.releaseAll());
    on(document, 'visibilitychange', () => { if (document.hidden) this.releaseAll(); });
    on(document, 'pointerlockchange', () => {
      const was = this.locked;
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) this.releaseAll();
      if (was !== this.locked && this.hooks.onLockChange) this.hooks.onLockChange(this.locked);
    });
    on(document, 'pointerlockerror', () => { if (this.hooks.onLockError) this.hooks.onLockError(); });
  }

  setLook(yaw, pitch) { this.yaw = yaw; this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch)); }

  // pointer lock; true when the lock was granted (or the soft fallback is used)
  async lock() {
    const el = this.canvas;
    if (this.soft) { this.setSoftLocked(true); return true; }
    if (document.pointerLockElement === el) return true;
    try {
      const p = el.requestPointerLock({ unadjustedMovement: true });
      if (p && typeof p.then === 'function') await p;
      return true;
    } catch {
      try {
        const p2 = el.requestPointerLock();
        if (p2 && typeof p2.then === 'function') await p2;
        return true;
      } catch { return false; }
    }
  }
  unlock() {
    if (this.soft) { this.setSoftLocked(false); return; }
    try { if (document.pointerLockElement === this.canvas) document.exitPointerLock(); } catch { /* ignore */ }
  }
  setSoftLocked(b) {
    if (this.locked === b) return;
    this.locked = b;
    if (!b) this.releaseAll();
    if (this.hooks.onLockChange) this.hooks.onLockChange(b);
  }

  releaseAll() {
    this.keys.clear();
    this.dirOrder.length = 0;
    this.fireDown = false;
    this.jumpGap = false; this.fireGap = false;
  }

  // ---- events ----
  onKeyDown(e) {
    const code = e.code;
    if (code === 'Escape') {
      // with pointer lock the browser swallows Escape (pointerlockchange tells us); this is for the soft lock / no lock
      if (this.enabled && (!this.locked || this.soft) && this.hooks.onEscape) this.hooks.onEscape();
      return;
    }
    if (!this.enabled) return;
    if (GAME_KEYS.has(code) && !e.ctrlKey && !e.metaKey && !e.altKey) e.preventDefault();
    if (e.repeat) return;
    this.keys.add(code);
    if (code === 'Space') this.latch.jump = true;
    else if (code === 'KeyR') this.latch.respawn = true;
    else if (code === 'Enter') this.latch.restart = true;
    else if (code === 'Tab') { if (this.hooks.onTab) this.hooks.onTab(true); }
    else if (code === 'KeyV') { if (this.hooks.onView && !isTyping(e.target) && !e.ctrlKey && !e.metaKey && !e.altKey) this.hooks.onView(); }
    const dir = DIR_KEYS[code];
    if (dir) {
      this.dirOrder = this.dirOrder.filter((k) => k !== dir);
      this.dirOrder.push(dir);
      const t = e.timeStamp;
      if (this.lastTap[dir] !== undefined && t - this.lastTap[dir] <= TAP_WINDOW) { this.latch.dodge = dir; this.lastTap[dir] = -1e9; }
      else this.lastTap[dir] = t;
    }
  }
  onKeyUp(e) {
    const code = e.code;
    if (code === 'Tab' && this.keys.has('Tab') && this.hooks.onTab) this.hooks.onTab(false);
    if (code === 'Space' && this.jumpSent) this.jumpGap = true;
    this.keys.delete(code);
    const dir = DIR_KEYS[code];
    if (dir && !this.heldDir(dir)) this.dirOrder = this.dirOrder.filter((k) => k !== dir);
  }
  // is another key of the same direction still down (W and ArrowUp)
  heldDir(dir) {
    for (const c of this.keys) if (DIR_KEYS[c] === dir) return true;
    return false;
  }
  onMouseDown(e) {
    if (e.button !== 0) return;
    if (!this.enabled) return;
    if (!this.locked) { this.lock(); return; }   // the click that (re)captures the mouse does not shoot
    this.fireDown = true;
    this.latch.fire = true;
  }
  onMouseUp(e) {
    if (e.button === 0) { if (this.fireSent) this.fireGap = true; this.fireDown = false; }
  }
  onMouseMove(e) {
    if (!this.locked || !this.enabled) return;
    let dx = e.movementX || 0, dy = e.movementY || 0;
    if (Math.abs(dx) > 600 || Math.abs(dy) > 600) return;   // a known spike when the lock engages
    const k = (DEG_PER_PX * this.s.sens * Math.PI) / 180;
    this.yaw -= dx * k;
    this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.pitch - dy * k));
    this.dyaw -= dx * k; this.dpitch -= dy * k;
  }

  // the look change since the last call (radians)
  takeLookDelta() {
    const d = [this.dyaw, this.dpitch];
    this.dyaw = 0; this.dpitch = 0;
    return d;
  }

  // ---- sim cmd ----
  fillCmd(cmd) {
    const k = this.keys, L = this.latch;
    const up = k.has('KeyW') || k.has('ArrowUp'), dn = k.has('KeyS') || k.has('ArrowDown');
    const lf = k.has('KeyA') || k.has('ArrowLeft'), rt = k.has('KeyD') || k.has('ArrowRight');
    cmd.fwd = (up ? 1 : 0) - (dn ? 1 : 0);
    cmd.side = (rt ? 1 : 0) - (lf ? 1 : 0);
    cmd.yaw = this.yaw;
    cmd.pitch = this.pitch;
    // a gap tick keeps the latch: a press that came after the release is sent on the tick after it
    if (this.jumpGap) { cmd.jump = false; this.jumpGap = false; } else { cmd.jump = k.has('Space') || L.jump; L.jump = false; }
    if (this.fireGap) { cmd.fire = false; this.fireGap = false; } else { cmd.fire = this.fireDown || L.fire; L.fire = false; }
    this.jumpSent = cmd.jump; this.fireSent = cmd.fire;
    cmd.dodge = L.dodge;
    cmd.respawn = k.has('KeyR') || L.respawn;
    cmd.restart = k.has('Enter') || L.restart;
    L.dodge = 0; L.respawn = false; L.restart = false;
    return cmd;
  }
  // discard pending presses (menus open, map change)
  clearLatches() {
    const L = this.latch;
    L.jump = false; L.fire = false; L.dodge = 0; L.respawn = false; L.restart = false;
    this.jumpGap = false; this.fireGap = false;
  }
  keyState() {
    const k = this.keys;
    return {
      w: k.has('KeyW') || k.has('ArrowUp'), a: k.has('KeyA') || k.has('ArrowLeft'), s: k.has('KeyS') || k.has('ArrowDown'), d: k.has('KeyD') || k.has('ArrowRight'),
      jump: k.has('Space'), fire: this.fireDown,
    };
  }
}
