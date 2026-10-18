// input.js (dodge by double-tap, Shift does nothing, latched short presses) and store.js (localStorage that may throw, PB, corrupt data).
// Events are fed straight into Input.onKeyDown / onKeyUp with explicit timestamps, so no DOM is needed.
import { test, assert, setGlobal } from './harness.mjs';
import { memStorage, brokenStorage } from './support.mjs';
import { Input } from '../input.js';
import { makeCmd } from '../sim/pmove.js';
import { DODGE } from '../sim/const.js';

// ================================================================ input
const mk = (settings = {}) => {
  const inp = new Input({}, { sens: 1, doubleTap: true, ...settings });   // ({} has no requestPointerLock: the soft lock, no DOM needed)
  inp.enabled = true;
  return inp;
};
const key = (inp, down, code, t, o = {}) => (down ? inp.onKeyDown : inp.onKeyUp).call(inp, { code, repeat: false, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, timeStamp: t, preventDefault() {}, ...o });
const down = (inp, code, t, o) => key(inp, true, code, t, o);
const up = (inp, code, t) => key(inp, false, code, t);
const tap = (inp, code, t, hold = 40) => { down(inp, code, t); up(inp, code, t + hold); };
const tick = (inp) => inp.fillCmd(makeCmd());
const dodges = (inp, n) => Array.from({ length: n }, () => tick(inp).dodge);   // the dodge field of the next n ticks

test('input: double-tap dodge needs two separate taps of the same direction within 250 ms (not a long press, not two directions)', () => {
  const inp = mk();
  // two quick taps of W: the dodge shows up exactly once, on the tick after the second tap
  tap(inp, 'KeyW', 1000);
  assert.deepEqual(dodges(inp, 2), [0, 0], 'one tap is no dodge');
  tap(inp, 'KeyW', 1200);
  assert.deepEqual(dodges(inp, 3), [DODGE.F, 0, 0], 'second tap within the window -> one dodge forward');
  tap(inp, 'KeyW', 1250);
  assert.deepEqual(dodges(inp, 1), [0], 'a third tap right after a dodge does not dodge again');
  // exactly 250 ms still counts, 300 ms does not
  tap(inp, 'KeyD', 4000); tap(inp, 'KeyD', 4250);
  assert.deepEqual(dodges(inp, 1), [DODGE.R], '250 ms is inside the window');
  tap(inp, 'KeyA', 6000); tap(inp, 'KeyA', 6300);
  assert.deepEqual(dodges(inp, 1), [0], '300 ms is too slow');
  // a single long press: the keydown auto-repeat events (repeat: true) must not count as taps
  const held = mk();
  down(held, 'KeyW', 1000);
  for (let t = 1500; t <= 3000; t += 33) key(held, true, 'KeyW', t, { repeat: true });
  assert.deepEqual(dodges(held, 3), [0, 0, 0], 'holding W does not dodge');
  up(held, 'KeyW', 3000);
  down(held, 'KeyW', 3100);   // 2.1 s after the first keydown
  assert.deepEqual(dodges(held, 1), [0], 'a long press followed by a press is not a double-tap');
  // two taps of different directions
  const mix = mk();
  tap(mix, 'KeyW', 1000); tap(mix, 'KeyD', 1100); tap(mix, 'KeyS', 1150); tap(mix, 'KeyA', 1200);
  assert.deepEqual(dodges(mix, 1), [0], 'W, D, S, A in a row is no dodge');
  // taps while the game is not being played
  const idle = mk(); idle.enabled = false;
  tap(idle, 'KeyW', 1000); tap(idle, 'KeyW', 1100);
  idle.enabled = true;
  assert.deepEqual(dodges(idle, 1), [0], 'keys are ignored while input is disabled');
});

test('input: Shift does nothing (no sprint, no dodge), in either order with a direction; a double-tap still dodges while Shift is held', () => {
  const a = mk();
  down(a, 'KeyW', 1000);                              // running forward ...
  down(a, 'ShiftLeft', 1100, { shiftKey: true });     // ... then Shift
  assert.deepEqual(dodges(a, 6), [0, 0, 0, 0, 0, 0], 'W held, Shift pressed: no dodge');
  const b = mk();
  down(b, 'ShiftLeft', 1000, { shiftKey: true });
  down(b, 'KeyD', 1100, { shiftKey: true });          // Shift held, then a direction
  assert.deepEqual(dodges(b, 6), [0, 0, 0, 0, 0, 0], 'Shift held, D pressed: no dodge');
  assert.equal(tick(b).side, 1, 'D still strafes right with Shift held');
  up(b, 'KeyD', 1200); down(b, 'KeyD', 1300, { shiftKey: true });
  assert.deepEqual(dodges(b, 1), [DODGE.R], 'a double-tap of D with Shift held is the normal dodge');
});

test('input: presses shorter than a tick are latched; held keys stay on; axes, blur and disable behave; there is no auto-hop', () => {
  const inp = mk();
  // Space pressed and released between two ticks: the sim still sees the jump, once
  down(inp, 'Space', 1000); up(inp, 'Space', 1010);
  assert.deepEqual([tick(inp).jump, tick(inp).jump], [true, false], 'short Space tap = one tick of jump');
  down(inp, 'Space', 2000);
  assert.deepEqual([tick(inp).jump, tick(inp).jump, tick(inp).jump], [true, true, true], 'held Space = jump on every tick');
  up(inp, 'Space', 2100);
  assert.equal(tick(inp).jump, false);
  // respawn / restart / fire clicks
  down(inp, 'KeyR', 3000); up(inp, 'KeyR', 3005); down(inp, 'Enter', 3010); up(inp, 'Enter', 3015);
  let c = tick(inp); assert.ok(c.respawn && c.restart, 'R and Enter taps latched');
  c = tick(inp); assert.ok(!c.respawn && !c.restart, '... for one tick only');
  inp.onMouseDown({ button: 0 });                      // the click that captures the mouse does not shoot
  assert.ok(inp.locked && !tick(inp).fire, 'first click only locks');
  inp.onMouseDown({ button: 0 }); inp.onMouseUp({ button: 0 });
  assert.deepEqual([tick(inp).fire, tick(inp).fire], [true, false], 'a click shorter than a tick still fires once');
  // clearLatches drops what is pending
  down(inp, 'Space', 4000); up(inp, 'Space', 4001); inp.clearLatches();
  assert.equal(tick(inp).jump, false, 'clearLatches');
  // axes
  down(inp, 'KeyW', 5000); down(inp, 'KeyS', 5001); down(inp, 'KeyD', 5002);
  c = tick(inp); assert.deepEqual([c.fwd, c.side], [0, 1], 'W+S cancel, D = +1');
  up(inp, 'KeyS', 5100); up(inp, 'KeyD', 5100); down(inp, 'ArrowUp', 5101); up(inp, 'KeyW', 5200);
  assert.equal(tick(inp).fwd, 1, 'W released but ArrowUp still held');
  down(inp, 'ArrowLeft', 5300);
  assert.equal(tick(inp).side, -1);
  inp.releaseAll();                                    // window blur
  c = tick(inp); assert.deepEqual([c.fwd, c.side, c.jump, c.fire], [0, 0, false, false], 'blur releases everything');
  assert.equal('autoHop' in tick(mk({ autoHop: true })), false, 'the old autoHop setting has no effect any more: no bunnyhop');
  const off = mk(); off.enabled = false; down(off, 'Space', 1000);
  assert.equal(tick(off).jump, false, 'a disabled input ignores keys');
});

// ================================================================ store
let storeN = 0;
const freshStore = () => import('../store.js?fresh=' + (++storeN));   // a new module instance = an empty in-memory fallback

test('store: localStorage that throws on every call (private mode, blocked) -> values live in memory, nothing throws', async () => {
  setGlobal('localStorage', brokenStorage());
  const { store, DEFAULTS } = await freshStore();
  assert.equal(store.set('x', { a: 1 }), false, 'not persisted');
  assert.deepEqual(store.get('x'), { a: 1 }, 'but readable for this session');
  assert.equal(store.setPB('m', 'h', { ticks: 5000, splits: [1, 2], ghost: 'AAA' }), false);
  const pb = store.getPB('m', 'h');
  assert.ok(pb && pb.ticks === 5000 && pb.ghost === 'AAA', 'PB round trip from memory');
  store.remove('x'); assert.equal(store.get('x', 'dflt'), 'dflt');
  store.clearPB('m'); assert.equal(store.getPB('m', 'h'), null);
  store.saveSettings({ name: 'Bob', sens: 2 });
  assert.equal(store.loadSettings().name, 'Bob');
  setGlobal('localStorage', undefined);                // no storage object at all
  assert.deepEqual((await freshStore()).store.loadSettings(), DEFAULTS);
});

test('store: setItem fails (quota, old Safari private mode) but getItem works -> the value just saved must still be readable', async () => {
  const ls = memStorage();
  ls.setItem = () => { throw new DOMException('quota', 'QuotaExceededError'); };
  setGlobal('localStorage', ls);
  const { store } = await freshStore();
  assert.equal(store.setPB('m', 'h', { ticks: 5000, splits: [1, 2], ghost: null }), false);
  const pb = store.getPB('m', 'h');
  assert.ok(pb && pb.ticks === 5000, 'a PB that could not be written to localStorage is lost for the rest of the session (store.js rawGet never looks at the memory fallback)');
});

test('store: corrupt JSON / wrong shapes fall back to defaults, a changed map hash drops the PB, settings are clamped', async () => {
  const ls = memStorage({
    'pajzsugras:settings': '{bad json', 'pajzsugras:pb:a': '"a string"', 'pajzsugras:pb:b': '{"ticks":"abc","splits":[]}',
    'pajzsugras:pb:c': '{"ticks":5000,"splits":"x"}', 'pajzsugras:pb:d': JSON.stringify({ hash: 'h1', ticks: 5000, splits: [100, 200], ghost: 7, date: 5 }),
  });
  setGlobal('localStorage', ls);
  const { store, sanitizeSettings, cleanName, DEFAULTS } = await freshStore();
  assert.deepEqual(store.loadSettings(), DEFAULTS, 'bad settings JSON -> defaults');
  for (const id of ['a', 'b', 'c']) assert.equal(store.getPB(id, 'h1'), null, 'malformed PB ' + id);
  const pb = store.getPB('d', 'h1');
  assert.ok(pb && pb.ticks === 5000 && pb.ghost === null, 'valid PB, non-string ghost dropped');
  assert.equal(store.getPB('d', 'h2'), null, 'the map changed: the old time does not count');
  const circular = {}; circular.self = circular;
  assert.equal(store.set('loop', circular), false, 'unserialisable value: false, no throw');
  const s = sanitizeSettings({ name: '<b>' + 'x'.repeat(40) + '\u0001', sens: 99, fov: 10, volume: NaN, quality: 'ultra', doubleTap: 'yes', lastMap: 'm'.repeat(100) });
  assert.ok(s.name.length === 16 && !/[<>\u0001]/.test(s.name), 'name cleaned and cut to 16: ' + s.name);
  assert.deepEqual([s.sens, s.fov, s.volume, s.quality, s.doubleTap, s.lastMap.length], [3, 80, DEFAULTS.volume, DEFAULTS.quality, DEFAULTS.doubleTap, 40]);
  assert.equal(cleanName('  <>  '), DEFAULTS.name, 'a name that is empty after cleaning falls back');
  assert.equal('autoHop' in sanitizeSettings({ autoHop: true }) || 'autoHop' in DEFAULTS, false, 'an old stored autoHop key is dropped (no bunnyhop any more)');
});

test('store: cleanName (settings, room hello / lobby names) strips controls, DEL / C1, line separators and bidi overrides as well as markup, and falls back when nothing is left', async () => {
  const { cleanName, DEFAULTS } = await freshStore();
  const bad = [0x1, 0x7f, 0x85, 0x9f, 0x2028, 0x2029, 0x202a, 0x202e, 0x2066, 0x2069].map((c) => String.fromCharCode(c)).join('');
  assert.equal(cleanName('A' + bad + 'B<i>C'), 'ABiC');
  assert.equal(cleanName(bad + ' <> '), DEFAULTS.name);
  assert.equal(cleanName('Ünicode név ő'), 'Ünicode név ő', 'ordinary text is untouched');
});
