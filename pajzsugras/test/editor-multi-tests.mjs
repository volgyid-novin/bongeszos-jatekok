// The map editor's multi-select, sticking and resize-arrow work (registered by app-tests.mjs): model.batch() and the History subset merge,
// worldToNdc, snap.js, handles.js, and the controller on the stub DOM of editor-tests.mjs (Shift+click, selection rectangle, group drag /
// R / Ctrl+D / Del / nudge, the placement that sticks to the item under the cursor, the arrows that resize). What the screen looks like
// (the arrows, the selection rectangle, the outlines of a group) is checked by a person: these cases only look at the document.
import { test, assert } from './harness.mjs';
import { openEditor } from './editor-tests.mjs';
import { DocModel, History, newDoc, newItem, itemAabb, docCells, LIM } from '../editor/model.js';
import { rayFromCamera, worldToNdc } from '../editor/pick.js';
import { snapAxis, stickMove } from '../editor/snap.js';
import { handlesFor, handleSeg, resizePatch } from '../editor/handles.js';

const FOV = 70, ASPECT = 16 / 9;
const near = (a, b, eps = 1e-6, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} !~ ${b}`);
const nearV = (a, b, eps = 1e-6, msg = '') => { assert.equal(a.length, b.length, msg + ' length'); a.forEach((v, i) => near(v, b[i], eps, `${msg}[${i}]`)); };
const sorted = (l) => l.slice().sort((a, b) => String(a).localeCompare(String(b)));
const clock = { t: 0 };
const model = () => { const m = new DocModel(newDoc({ id: 'multi' }), { now: () => clock.t }); m.doc.items = []; return m; };

// ---- controller helpers: the camera looks down at the origin from behind (+z), everything is placed with D.exec('add') on an empty map
const ndcOf = (ed, p) => { const n = worldToNdc(ed.cam, p, FOV, ASPECT); assert.ok(n, 'the point is in front of the camera: ' + p); return [n[0], n[1]]; };
const px = (n) => [((n[0] + 1) / 2) * 1280, ((1 - n[1]) / 2) * 720];
const topOf = (it) => { const b = itemAabb(it); return [(b.min[0] + b.max[0]) / 2, b.max[1], (b.min[2] + b.max[2]) / 2]; };
const scene = async () => {
  const t = await openEditor();
  for (const it of t.ed.model.doc.items.slice()) await t.D.exec('remove', it.id);
  t.D.setCam([0, 14, 14], 0, -50);
  return t;
};
const addAll = async (D, specs) => { const ids = []; for (const [id, over] of specs) ids.push((await D.exec('add', id, over)).result); return ids; };
const aimAt = (D, ed, p) => D.aim(...ndcOf(ed, p));
const ids = (ed) => ed.model.doc.items.map((i) => i.id);
const histLen = (ed) => ed.model.history.undoStack.length;
// a real left-button drag between two NDC points (mouse events, several moves), the way a person drags
const mouseDrag = (t, from, to, { steps = 3, mods = {} } = {}) => {
  const at = (k) => px([from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k]);
  const [x0, y0] = at(0);
  t.fire(t.canvas, 'mousedown', { target: t.canvas, clientX: x0, clientY: y0, button: 0, ...mods });
  for (let i = 1; i <= steps; i++) { const [x, y] = at(i / steps); t.fire(t.canvas, 'mousemove', { target: t.canvas, clientX: x, clientY: y }); }
  t.fire(t.canvas, 'mouseup', { target: t.canvas, button: 0 });
};
// a world point on the arrow of one face of an item (frac 0 = its foot, 1 = its tip)
const arrowPoint = (ed, id, axis, dir, frac = 0.5) => {
  const h = handlesFor(ed.model.find(id)).find((x) => x.axis === axis && x.dir === dir), s = handleSeg(h, ed.cam, FOV);
  return [0, 1, 2].map((a) => s.base[a] + (s.tip[a] - s.base[a]) * frac);
};
const moved = (p, axis, d) => { const q = p.slice(); q[axis] += d; return q; };
// drag the arrow of face (axis, dir) of the one selected item by `d` metres, outward when d > 0
const dragArrow = (t, id, axis, dir, d, frac = 0.5, steps = 3) => {
  const p = arrowPoint(t.ed, id, axis, dir, frac);
  mouseDrag(t, ndcOf(t.ed, p), ndcOf(t.ed, moved(p, axis, d * dir)), { steps });
};

// ================================================================ model: batch and the History merge
test('editor batch: many changes are ONE history entry (undo / redo bring back all of them and the selection); an empty batch records nothing', () => {
  const m = model();
  const a = m.add(newItem('floor', { c: [0, 0, 0] })), b = m.add(newItem('wall', { c: [10, 0, 0] }));
  const n0 = m.history.undoStack.length, rev0 = m.rev;
  let extra = null;
  const ok = m.batch('Group', () => { m.update(a, { c: [1, 0, 0] }); m.update(b, { c: [11, 0, 0] }); extra = m.add(newItem('floor', { c: [20, 0, 0] })); }, { sel: () => [[a, b], [a, b, 99]] });
  assert.equal(ok, true);
  assert.equal(m.history.undoStack.length, n0 + 1, 'one entry');
  assert.equal(m.rev, rev0 + 1, 'one revision');
  const u = m.undo();
  assert.deepEqual([m.find(a).c, m.find(b).c, m.doc.items.length], [[0, 0, 0], [10, 0, 0], 2], 'undo takes everything back');
  assert.deepEqual(u.sel, [a, b], 'undo hands back the selection from before');
  assert.ok(u.ids.includes(a) && u.ids.includes(b) && u.ids.includes(extra));
  const r = m.redo();
  assert.deepEqual([m.find(a).c, m.find(b).c, m.doc.items.length], [[1, 0, 0], [11, 0, 0], 3], 'redo puts everything back');
  assert.deepEqual(r.sel, [a, b, 99], 'redo hands back the selection from after');
  // nothing changed inside: no entry; a batch inside a batch joins the outer one
  const n1 = m.history.undoStack.length;
  assert.equal(m.batch('Nothing', () => { m.update(a, { c: [1, 0, 0] }); }), false);
  assert.equal(m.history.undoStack.length, n1);
  assert.equal(m.batch('Outer', () => { m.batch('Inner', () => { m.update(a, { c: [5, 0, 0] }); }); m.update(b, { c: [15, 0, 0] }); }), true);
  assert.equal(m.history.undoStack.length, n1 + 1, 'the inner batch made no entry of its own');
  m.undo();
  assert.deepEqual([m.find(a).c, m.find(b).c], [[1, 0, 0], [11, 0, 0]]);
});

test('editor batch: fn returning false, a throw and a refused collision-grid limit each put EVERYTHING back and record nothing', () => {
  const m = model();
  const a = m.add(newItem('floor', { c: [0, -0.5, 0] })), b = m.add(newItem('floor', { c: [20, -0.5, 0] }));
  const s0 = JSON.stringify(m.doc.items), n0 = m.history.undoStack.length, rev0 = m.rev;
  const untouched = (why) => { assert.equal(JSON.stringify(m.doc.items), s0, why + ': the document is as it was'); assert.equal(m.history.undoStack.length, n0, why + ': no entry'); assert.equal(m.rev, rev0, why + ': no revision'); };
  assert.equal(m.batch('x', () => { m.update(a, { c: [1, -0.5, 0] }); m.add(newItem('wall', { c: [5, 2, 5] })); return false; }), false);
  untouched('false');
  assert.throws(() => m.batch('x', () => { m.update(a, { c: [2, -0.5, 0] }); throw new Error('boom'); }), /boom/);
  untouched('throw');
  assert.equal(m.pending, null, 'a throw leaves no half open batch behind');
  const lim = LIM.cells, refused = [];
  try {
    LIM.cells = docCells(m.doc);   // (no room to grow)
    m.onRefuse = (msg) => refused.push(msg);
    assert.equal(m.batch('x', () => { m.update(a, { c: [3, -0.5, 0] }); m.update(b, { size: [60, 1, 60] }); }), false, 'the second change is refused: the first goes too');
  } finally { LIM.cells = lim; }
  untouched('cells refusal');
  assert.equal(refused.length, 1, 'the refusal was reported');
  assert.equal(m.update(a, { c: [4, -0.5, 0] }), true, 'the model works as usual afterwards'); assert.equal(m.history.undoStack.length, n0 + 1);
});

test('editor history: a set-only entry of the same key whose ids are a subset of the last one is folded into it; another id, an add or another key is not', () => {
  const set = (idl, v) => ({ label: 'x', ch: idl.map((id) => ({ k: 'set', id, before: { v: v - 1 }, after: { v } })), sel: [[1], [v]] });
  const O = { mergeKey: 'drag', mergeMs: Infinity };
  const h = new History();
  h.push(set([1, 2], 1), { ...O, now: 0 });
  h.push(set([1], 2), { ...O, now: 5000 });
  assert.equal(h.undoStack.length, 1, 'a subset (item 1 of {1, 2}) merges, however late (a drag has no time limit)');
  const e = h.undoStack[0], by = Object.fromEntries(e.ch.map((c) => [c.id, c]));
  assert.deepEqual([by[1].before, by[1].after], [{ v: 0 }, { v: 2 }], 'it keeps the first before and takes the last after');
  assert.deepEqual([by[2].before, by[2].after], [{ v: 0 }, { v: 1 }], 'an item the new entry does not touch keeps its own change');
  assert.deepEqual(e.sel, [[1], [2]], 'the selection after is the newest one');
  h.push(set([3], 1), { ...O, now: 6000 });
  assert.equal(h.undoStack.length, 2, 'a different id is its own entry');
  h.push(set([1], 9), { ...O, now: 6001 });
  assert.equal(h.undoStack.length, 3, 'item 1 is no subset of {3}');
  h.push(set([1], 10), { mergeKey: 'other', mergeMs: Infinity, now: 6002 });
  assert.equal(h.undoStack.length, 4, 'another key');
  h.push({ label: 'add', ch: [{ k: 'add', item: { id: 7 }, index: 0 }] }, { ...O, now: 6003 });
  h.push(set([7], 1), { ...O, now: 6004 });
  assert.equal(h.undoStack.length, 6, 'an add is never folded into, nor folded');
  const t = new History();   // typing: 600 ms
  t.push(set([1], 1), { mergeKey: 'f', now: 0 }); t.push(set([1], 2), { mergeKey: 'f', now: 100 }); assert.equal(t.undoStack.length, 1);
  t.push(set([1], 3), { mergeKey: 'f', now: 900 }); assert.equal(t.undoStack.length, 2, 'later than 600 ms: a new step');
});

// ================================================================ pick.js: worldToNdc
test('editor pick: worldToNdc is the exact inverse of rayFromCamera (any pose), depth is the distance in front, and behind the camera gives null', () => {
  const cams = [{ pos: [1, 2, 3], yaw: 0.4, pitch: -0.3 }, { pos: [-20, 5, 7], yaw: -2.5, pitch: 0.6 }, { pos: [0, 40, 0], yaw: 3.1, pitch: -1.2 }];
  for (const cam of cams) {
    for (const ndc of [[0, 0], [0.9, -0.8], [-0.7, 0.6], [1, 1]]) {
      const ray = rayFromCamera(cam, ndc, FOV, ASPECT);
      for (const t of [0.5, 7, 120]) {
        const p = ray.o.map((v, i) => v + ray.d[i] * t), n = worldToNdc(cam, p, FOV, ASPECT);
        assert.ok(n, 'in front');
        nearV([n[0], n[1]], ndc, 1e-8, `cam ${cams.indexOf(cam)} ndc ${ndc} t ${t}`);
        near(n[2], t * Math.cos(Math.atan2(Math.hypot(ndc[0] * Math.tan(FOV * Math.PI / 360) * ASPECT, ndc[1] * Math.tan(FOV * Math.PI / 360)), 1)), 1e-8, 'depth along the view axis');
      }
      const behind = ray.o.map((v, i) => v - ray.d[i] * 5);
      assert.equal(worldToNdc(cam, behind, FOV, ASPECT), null, 'behind the camera');
    }
  }
});

// ================================================================ sticking
test('editor sticking: on an OFF-grid block the new item lines its edges up with the target (ghost == click), else it follows the grid of the target\'s min corner', async () => {
  const { ed, D } = await scene();
  const [T] = await addAll(D, [['floor', { c: [10.3, 0.5, -4.3], size: [6, 1, 6] }]]);   // x 7.3 .. 13.3, z -7.3 .. -1.3: nothing on the 0.5 grid
  await D.exec('tool', 'wall');   // a 1 x 4 x 6 wall
  // out of reach of every edge: the grid that starts at the target's min corner (still a whole number of half metres from it)
  let a = aimAt(D, ed, [9.9, 1, -4.3]);
  const w = itemAabb(a.ghost), k = (w.min[0] - 7.3) / 0.5;
  near(k, Math.round(k), 1e-6, "the offset from the target's min corner is whole grid steps");
  assert.ok(Math.abs(w.min[0] - (9.9 - 0.5)) <= 0.25 + 0.01, 'and it is the nearest such step to the cursor');
  // near its west edge: the edges meet
  a = aimAt(D, ed, [7.6, 1, -4.3]);   // (the sim's own trace puts the hit a hair off the exact point: aim a bit inside the 0.25 reach)
  nearV(a.hit.point, [7.6, 1, -4.3], 0.01, 'the cursor is where we aimed');
  const g = a.ghost, b = itemAabb(g);
  near(b.min[0], 7.3, 1e-6, "its west edge meets the target's (the plain grid would give 7.0)");
  nearV([b.min[2], b.max[2]], [-7.3, -1.3], 1e-6, 'it covers the target along z');
  near(b.min[1], 1, 0.01, 'it stands on the top');
  const id = (await D.click()).id;
  assert.deepEqual(ed.model.find(id).c, g.c, 'the click places exactly what the ghost showed');
  assert.equal(ed.model.find(T).c[0], 10.3, 'the target did not move');
});

test('editor sticking: on an on-grid block the new item stays on the grid, flush on the hit face and within the reach of the cursor (0.35 of its extent: 0.5 m across the 1 m wall, 2 m along its 6 m); a pillar on a side face stands against it, its foot on the grid', async () => {
  const { ed, D } = await scene();
  await addAll(D, [['floor', { c: [0, 0.5, -10], size: [12, 1, 12] }]]);
  await D.exec('tool', 'wall');
  for (const p of [[-5.3, 1, -5.1], [0.13, 1, -9.87], [5.77, 1, -15.6], [3.01, 1, -8.1], [-5.9, 1, -15.9], [1.2, 1, -4.1]]) {
    const a = aimAt(D, ed, p), hit = ed.aim.hit.point, b = itemAabb(a.ghost);   // (the exact hit, not the rounded one of aim())
    for (const v of [b.min[0], b.min[2]]) near(v / 0.5, Math.round(v / 0.5), 1e-6, 'its min corner is on the grid at ' + p);
    near(b.min[1], 1, 1e-6, 'it stands on the top of the floor at ' + p);
    assert.ok(Math.abs(a.ghost.c[0] - hit[0]) <= 0.5 + 1e-6 && Math.abs(a.ghost.c[2] - hit[2]) <= 2 + 1e-6, 'and it is within the reach of the cursor at ' + p);
  }
  // a pillar against the west face of a wall at x 9.5: outside it (the old placement sank half of it into the wall), foot on the grid
  await addAll(D, [['wall', { c: [10, 2, 0] }]]);
  D.setCam([-4, 1.5, 0], -90, 0);
  await D.exec('tool', 'pillar');
  const a = aimAt(D, ed, [9.5, 1.3, 0.2]);
  assert.deepEqual(a.hit.normal.map((v) => v + 0), [-1, 0, 0], 'the aimed face looks west');
  const bb = itemAabb(a.ghost);
  near(bb.max[0], 9.5, 0.02, 'the pillar touches the wall from outside (the old placement sank half of it in: 10.05)');
  const foot = bb.min[1] / 0.5;
  near(foot, Math.round(foot), 1e-6, 'its foot is on the grid');
  const id = (await D.click()).id;
  assert.deepEqual(ed.model.find(id).c, a.ghost.c, 'ghost == click');
});

test('editor sticking: snapAxis meets a neighbour flush, snaps to the grid of the anchor otherwise; stickMove keeps a deco\'s offset (no half-size jump on the first drag)', () => {
  // an item 2 m wide (h = 1) whose cursor is at 9.2; the neighbour spans 10.3 .. 14.3
  near(snapAxis(9.2, [1, 1], [{ lo: 10.3, hi: 14.3 }], 0, 0.5), 9.3, 1e-9, 'flush against the neighbour\'s near edge (our far edge on 10.3)');
  near(snapAxis(6.0, [1, 1], [{ lo: 10.3, hi: 14.3 }], 0.3, 0.5), 0.3 + Math.round((6.0 - 1 - 0.3) / 0.5) * 0.5 + 1, 1e-9, 'out of reach: the grid from the anchor');
  // the target wins a tie with a neighbour at the same distance
  near(snapAxis(5.0, [0.5, 0.5], [{ lo: 4.5, hi: 7.5 }, { lo: 3.0, hi: 4.0 }], 4.5, 0.5), 5.0, 1e-9);
  // a crate 1.3 m big, its centre off the grid: nudging the pointer by less than half a step does not move it; a step moves it exactly one step
  const deco = newItem('deco', { pos: [3.15, 0.65, 3.15] }), start = deco.pos.slice(), ctx = { cache: [], grid: 0.5, exclude: [] };
  const to = (dx, dz) => stickMove(deco, [start[0] + dx, start[1], start[2] + dz], start, ctx);
  nearV(to(0.1, -0.2), start, 1e-9, 'a small move: it stays (the old centre snap jumped it by 0.35)');
  nearV(to(0.3, 0.55), [start[0] + 0.5, start[1], start[2] + 0.5], 1e-9, 'a bigger move: whole grid steps from where it was');
  nearV(to(-1.1, 0), [start[0] - 1, start[1], start[2]], 1e-9);
});

// ================================================================ the controller: selecting
test('editor select: Shift+click adds / removes, a click on one of a group keeps just that item, Ctrl+A takes everything, Esc clears; the panel counts them', async () => {
  const t = await scene(), { ed, D } = t;
  const [A, B, C] = await addAll(D, [['floor', { c: [-5, 1, -4], size: [2, 2, 2] }], ['floor', { c: [5, 1, -4], size: [2, 2, 2] }], ['floor', { c: [0, 1, -4], size: [2, 2, 2] }]]);
  const at = (id) => D.aim(...ndcOf(ed, topOf(ed.model.find(id))));
  at(A); let r = await D.click();
  assert.deepEqual([r.sel, r.sels], [A, [A]], 'a click selects');
  at(B); r = await D.click({ shift: true });
  assert.deepEqual([r.sel, r.sels], [B, [A, B]], 'Shift+click adds; the new one is the primary');
  assert.ok(ed.panel.props.textContent.includes('2 elem kijelölve'), 'the panel says how many');
  const entries = histLen(ed);
  at(B); r = await D.click({ shift: true });
  assert.deepEqual([r.sel, r.sels], [A, [A]], 'Shift+click on a selected one removes it');
  at(C); await D.click({ shift: true });
  assert.deepEqual(D.state().sels, [A, C]);
  at(C); r = await D.click();
  assert.deepEqual(r.sels, [C], 'a plain click on a member of a group (no drag) keeps just that item');
  assert.equal(histLen(ed), entries, 'selecting is no edit');
  // the shared material of a group
  await D.exec('select', [A, B]);
  const sel = ed.panel.props.find((e) => e.tagName === 'SELECT')[0];
  sel.value = 'metal'; for (const f of sel.listeners.change) f();
  assert.deepEqual([ed.model.find(A).mat, ed.model.find(B).mat, histLen(ed)], ['metal', 'metal', entries + 1], 'the material of both changed in one step');
  // everything / nothing
  await D.key('KeyA', { ctrlKey: true });
  assert.deepEqual(sorted(D.state().sels), sorted(['start', A, B, C]), 'Ctrl+A: every item and the start point');
  await D.key('Escape');
  assert.deepEqual(D.state().sels, [], 'Esc clears the selection');
  assert.equal(D.state().sel, null);
});

test('editor select: the selection rectangle takes the items that are wholly inside it (all 8 corners, in front of the camera; not a big floor under them), a point by its spot, Shift adds, a plain one replaces', async () => {
  const t = await scene(), { ed, D } = t;
  const [A, B, C, Z] = await addAll(D, [['floor', { c: [-5, 1, -4], size: [2, 2, 2] }], ['floor', { c: [5, 1, -4], size: [2, 2, 2] }], ['floor', { c: [0, 1, -4], size: [2, 2, 2] }], ['floor', { c: [0, 14, 30], size: [2, 2, 2] }]]);
  const corners = (id) => { const b = itemAabb(ed.model.find(id)); return Array.from({ length: 8 }, (_, i) => ndcOf(ed, [i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]])); };
  const box = (ids2, pad = 0.03) => {
    const ns = ids2.flatMap(corners);
    return [[Math.min(...ns.map((n) => n[0])) - pad, Math.min(...ns.map((n) => n[1])) - pad], [Math.max(...ns.map((n) => n[0])) + pad, Math.max(...ns.map((n) => n[1])) + pad]];
  };
  assert.equal(worldToNdc(ed.cam, ed.model.find(Z).c, FOV, ASPECT), null, 'the last block is behind the camera');
  // a big floor under A, B and C: its middle is inside every rectangle that holds them, but it does not fit in
  const [G] = await addAll(D, [['floor', { c: [0, -0.5, -4], size: [24, 1, 24] }]]);
  let r = await D.boxSelect(...box([A, C]));
  assert.deepEqual(sorted(r.sels), sorted([A, C]), 'A and C are inside, B, the floor under them and the start point are not');
  r = await D.boxSelect(...box([B]), { shift: true });
  assert.deepEqual(sorted(r.sels), sorted([A, B, C]), 'Shift adds the new ones to the old');
  r = await D.boxSelect(...box([B]));
  assert.deepEqual(r.sels, [B], 'a plain rectangle replaces the selection');
  const [[x0, y0], [x1, y1]] = box([A], 0);
  r = await D.boxSelect([x0 + 0.03, y0 + 0.03], [x1 - 0.03, y1 - 0.03]);
  assert.deepEqual(r.sels, [], 'a rectangle that holds the middle of A but not all of it takes nothing');
  await D.exec('remove', G);
  r = await D.boxSelect([-1, -1], [1, 1]);
  assert.deepEqual(sorted(r.sels), sorted(['start', A, B, C]), 'the whole screen: everything in front of the camera, nothing behind it');
});

// ================================================================ the controller: group operations
test('editor group: dragging one of the group moves all by the same step (pads with target and apex), sticks to a neighbour outside the group, is ONE undo step, and undo / redo bring the selection back', async () => {
  const t = await scene(), { ed, D, press } = t;
  const [A, B, C, P, N] = await addAll(D, [['floor', { c: [-5, 1, -4], size: [2, 2, 2] }], ['floor', { c: [5, 1.3, -4], size: [2, 2.6, 2] }], ['floor', { c: [0, 1, 6], size: [2, 2, 2] }],
    ['pad', { pos: [-2, 0, 6], target: [-2, 0, 12], apex: 5 }], ['floor', { c: [-5, 1, -14.1], size: [2, 2, 2] }]]);   // N: an off-grid neighbour 6 m behind A
  await D.exec('select', [A, B, P]);
  const was = ed.model.doc.items.map((i) => JSON.parse(JSON.stringify(i))), n0 = histLen(ed);
  const same = (k) => [0, 1, 2].map((i) => ed.model.find(k).c[i]);
  // 1. four metres away from the camera: nothing in reach, an exact grid step
  const from = topOf(ed.model.find(A));
  mouseDrag(t, ndcOf(ed, from), ndcOf(ed, moved(from, 2, -4)), { steps: 4 });
  const now = ed.model.doc.items, dA = now[0].c.map((v, i) => v - was[0].c[i]);
  near(dA[2], -4, 1e-6, 'the dragged block moved 4 m'); near(dA[0], 0, 1e-6); near(dA[1], 0, 1e-6, 'a drag keeps the height');
  nearV(now[1].c.map((v, i) => v - was[1].c[i]), dA, 1e-9, 'the second block moved by the same');
  nearV(now[2].c, was[2].c, 1e-9, 'a block outside the group did not move');
  const pad = now[3];
  nearV(pad.pos.map((v, i) => v - was[3].pos[i]), dA, 1e-9, 'the pad');
  nearV(pad.target.map((v, i) => v - was[3].target[i]), dA, 1e-9, 'its target moved with it');
  near(pad.apex, was[3].apex, 1e-9, 'a move on the ground plane leaves the apex');
  assert.equal(histLen(ed), n0 + 1, 'the whole drag (many mouse moves, four items) is one undo step');
  assert.deepEqual(sorted(D.state().sels), sorted([A, B, P]), 'the group is still selected');
  // 2. almost four metres more, towards the off-grid block N: A's edge meets N's (a grid step would stop 0.1 short), the others keep their distance to A
  const a1 = same(A), b1 = same(B), from2 = topOf(ed.model.find(A));
  mouseDrag(t, ndcOf(ed, from2), ndcOf(ed, moved(from2, 2, -3.9)), { steps: 3 });
  near(itemAabb(ed.model.find(A)).min[2], itemAabb(ed.model.find(N)).max[2], 1e-9, 'flush against the neighbour that is not in the group');
  const d2 = ed.model.find(A).c[2] - a1[2];
  near(d2, -4.1, 1e-9); near(ed.model.find(B).c[2] - b1[2], d2, 1e-9, 'B kept its place relative to A'); near(ed.model.find(P).pos[2] - pad.pos[2], d2, 1e-9);
  assert.equal(histLen(ed), n0 + 2, 'the second drag is a step of its own');
  await D.exec('select', [C]);
  press('KeyZ', { ctrlKey: true });
  assert.deepEqual(sorted(D.state().sels), sorted([A, B, P]), 'undo selects the group again');
  press('KeyZ', { ctrlKey: true });
  assert.deepEqual(ed.model.doc.items, was, 'two Ctrl+Z put every item back');
  press('KeyY', { ctrlKey: true });
  near(ed.model.find(A).c[2], was[0].c[2] - 4, 1e-6, 'redo moves them again');
  assert.deepEqual(sorted(D.state().sels), sorted([A, B, P]));
});

test('editor group: R turns the group a quarter about its middle, 4 turns are the identity, a ramp stays attached to its landing block; each turn is one step', async () => {
  const { ed, D } = await scene();
  const [R, L] = await addAll(D, [['ramp', { c: [0, 1, 0], size: [4, 2, 6] }], ['floor', { c: [0, 1, 6], size: [4, 2, 6] }]]);   // the ramp rises toward +z into the block
  await D.exec('select', [R, L]);
  const start = JSON.parse(JSON.stringify(ed.model.doc.items)), n0 = histLen(ed);
  for (let k = 1; k <= 4; k++) {
    await D.key('KeyR');
    assert.equal(histLen(ed), n0 + k, `turn ${k} is one step`);
    const r = ed.model.find(R), l = ed.model.find(L), rb = itemAabb(r), lb = itemAabb(l);
    const up = [Math.sin(r.yaw * Math.PI / 180), Math.cos(r.yaw * Math.PI / 180)], d = [l.c[0] - r.c[0], l.c[2] - r.c[2]], len = Math.hypot(d[0], d[1]);
    nearV([d[0] / len, d[1] / len], up, 1e-9, `turn ${k}: the ramp still rises toward its block`);
    const gap = [0, 2].map((a) => Math.max(lb.min[a] - rb.max[a], rb.min[a] - lb.max[a]));
    near(Math.max(...gap), 0, 1e-9, `turn ${k}: the two still touch`);
    near(rb.max[1], lb.max[1], 1e-9, `turn ${k}: the top of the ramp meets the top of the block`);
  }
  assert.deepEqual(ed.model.doc.items, start, 'four turns: every item exactly where it began');
  await D.key('KeyZ', { ctrlKey: true });
  assert.equal(ed.model.find(R).yaw, 270, 'one undo is one quarter turn');
  assert.deepEqual(sorted(D.state().sels), sorted([R, L]), 'with the selection');
});

test('editor group: Ctrl+D copies after the last selected item in the original order (checkpoint order follows), skips the start and the finish, is one step, and is all or nothing', async () => {
  const { ed, D } = await scene();
  const [cpA, cpB, F, P1, W] = await addAll(D, [['cp', { c: [-8, 2, -10] }], ['cp', { c: [8, 2, -10] }], ['finish', { c: [0, 2.5, -20] }], ['floor', { c: [0, 1, 6], size: [2, 2, 2] }], ['wall', { c: [-10, 2, 0] }]]);
  const group = [cpA, cpB, F, P1, 'start'], order0 = ids(ed), start0 = JSON.stringify(ed.model.doc.start);
  await D.exec('select', group);
  // all or nothing: the copy of the block (the last to be made) does not fit the collision grid, so the checkpoint copies made before it go too
  const lim = LIM.cells, n0 = histLen(ed);
  try { LIM.cells = docCells(ed.model.doc); await D.key('KeyD', { ctrlKey: true }); } finally { LIM.cells = lim; }
  assert.deepEqual(ids(ed), order0, 'refused: no copy was made');
  assert.equal(histLen(ed), n0, 'and no history entry');
  assert.deepEqual(sorted(D.state().sels), sorted(group), 'the selection is as it was');
  // the real copy
  await D.key('KeyD', { ctrlKey: true });
  const items = ed.model.doc.items;
  assert.deepEqual(items.map((i) => i.t), ['cp', 'cp', 'finish', 'block', 'cp', 'cp', 'block', 'block'], 'copies go right after the last selected item (the block), before the wall; no second finish');
  assert.equal(items[7].id, W); assert.deepEqual(items.slice(0, 4).map((i) => i.id), [cpA, cpB, F, P1]);
  const off = items[4].c.map((v, i) => v - items[0].c[i]);
  assert.equal(off.filter((v) => v !== 0).length, 1, 'shifted along one axis');
  nearV(items[5].c.map((v, i) => v - items[1].c[i]), off, 1e-9); nearV(items[6].c.map((v, i) => v - items[3].c[i]), off, 1e-9);
  assert.deepEqual(ed.model.cpItems().map((c) => c.c[0]), [-8, 8, -8 + off[0], 8 + off[0]], 'checkpoint order: the originals, then the copies in the same order');
  assert.equal(JSON.stringify(ed.model.doc.start), start0, 'the start point did not move or multiply');
  assert.deepEqual(D.state().sels, [items[4].id, items[5].id, items[6].id], 'the copies are the selection');
  assert.equal(histLen(ed), n0 + 1, 'one step');
  await D.key('KeyZ', { ctrlKey: true });
  assert.deepEqual(ids(ed), order0, 'undo removes all three copies');
  assert.deepEqual(sorted(D.state().sels), sorted(group), 'and brings the old selection back');
  await D.key('KeyY', { ctrlKey: true });
  assert.equal(ed.model.doc.items.length, 8, 'redo');
});

test('editor group: Del removes all but the start point (which stays selected), keeps the checkpoint order of the rest, is one step, and undo puts every item back in its place', async () => {
  const { ed, D } = await scene();
  const [cpA, cpB, F, P1, W] = await addAll(D, [['cp', { c: [-8, 2, -10] }], ['cp', { c: [8, 2, -10] }], ['finish', { c: [0, 2.5, -20] }], ['floor', { c: [0, 1, 6], size: [2, 2, 2] }], ['wall', { c: [-10, 2, 0] }]]);
  const group = [cpA, F, 'start', P1], order0 = ids(ed), start0 = JSON.stringify(ed.model.doc.start), n0 = histLen(ed);
  await D.exec('select', group);
  await D.key('Delete');
  assert.deepEqual(ids(ed), [cpB, W], 'the rest, in order');
  assert.equal(JSON.stringify(ed.model.doc.start), start0, 'the start point cannot be deleted');
  assert.deepEqual(D.state().sels, ['start'], 'it stays selected');
  assert.equal(ed.model.cpItems()[0].id, cpB); assert.equal(ed.model.finish, null);
  assert.equal(histLen(ed), n0 + 1, 'one step');
  await D.key('KeyZ', { ctrlKey: true });
  assert.deepEqual(ids(ed), order0, 'undo: every item back in its old place (checkpoint A before B again)');
  assert.deepEqual(sorted(D.state().sels), sorted(group), 'with the selection');
  await D.key('KeyY', { ctrlKey: true });
  assert.deepEqual(ids(ed), [cpB, W]);
});

test('editor group: arrow keys move the whole group (a pad with its target and apex; one pad alone moves only itself), one undo step each press', async () => {
  const { ed, D } = await scene();
  const [Pd, B] = await addAll(D, [['pad', { pos: [2, 0, 2], target: [10, 0, 2], apex: 6 }], ['floor', { c: [-6, 1, 2], size: [2, 2, 2] }]]);
  const pad0 = JSON.parse(JSON.stringify(ed.model.find(Pd))), b0 = ed.model.find(B).c.slice(), n0 = histLen(ed);
  await D.exec('select', [Pd, B]);
  await D.key('ArrowRight');   // the camera looks along -z: right is +x
  const pad = ed.model.find(Pd);
  nearV(pad.pos, [2.5, 0, 2], 1e-9); nearV(pad.target, [10.5, 0, 2], 1e-9, 'the target moved too'); near(pad.apex, 6, 1e-9);
  nearV(ed.model.find(B).c, [b0[0] + 0.5, b0[1], b0[2]], 1e-9);
  assert.equal(histLen(ed), n0 + 1, 'one step');
  await D.key('PageUp');
  nearV(ed.model.find(Pd).target, [10.5, 0.5, 2], 1e-9); near(ed.model.find(Pd).apex, 6.5, 1e-9, 'up: the apex rises with the pad');
  while (histLen(ed) > n0) await D.exec('undo');   // (two quick nudges of the same group may be one step)
  assert.deepEqual([ed.model.find(Pd), ed.model.find(B).c], [pad0, b0], 'undone');
  await D.exec('select', [Pd]);
  await D.key('ArrowRight');
  nearV(ed.model.find(Pd).pos, [2.5, 0, 2], 1e-9); nearV(ed.model.find(Pd).target, [10, 0, 2], 1e-9, 'a single pad nudge moves only the pad');
  // a group cannot be resized with the keys: nothing changes, and it says so
  await D.exec('select', [Pd, B]);
  const before = JSON.stringify(ed.model.doc.items);
  await D.key('ArrowRight', { shiftKey: true });
  assert.equal(JSON.stringify(ed.model.doc.items), before, 'Shift+arrow on a group changes nothing');
  assert.match(ed.panel.msg.textContent, /Csoportot nem lehet/);
});

// A test whose name starts with "BUG:" pins a defect found by the first pass: it fails until the product is fixed (see editor-edge-tests.mjs).
test('fix: editor group: R on a group with a pad at its edge keeps the blocks on the grid and four turns are the identity (the pivot and the grid snap use the bodies of the group, not the 0.9 m box of a pad)', async () => {
  const { ed, D } = await scene();
  const [B, P] = await addAll(D, [['floor', { c: [-5, -0.5, 0], size: [10, 1, 6] }], ['pad', { pos: [-10, 0, 0], target: [-10, 0, -8], apex: 5 }]]);   // the pad at the west edge of an on-grid floor
  await D.exec('select', [B, P]);
  const start = JSON.parse(JSON.stringify(ed.model.doc.items));
  for (let k = 1; k <= 4; k++) {
    await D.key('KeyR');
    const bb = itemAabb(ed.model.find(B));
    for (const v of [...bb.min, ...bb.max]) near(v / 0.5, Math.round(v / 0.5), 1e-6, `turn ${k}: every edge of the floor is still on the grid`);
  }
  assert.deepEqual(ed.model.doc.items, start, 'four turns bring everything back');
});

// ================================================================ resize arrows
test('editor handles: an arrow is hit before an item behind it; dragging it is ONE undo step, the opposite face stays, the face meets a neighbour\'s off-grid face', async () => {
  const t = await scene(), { ed, D } = t;
  const [X, N] = await addAll(D, [['floor', { c: [0, 1, -3], size: [4, 2, 4] }], ['floor', { c: [4.1, 1, -3], size: [2, 2, 4] }]]);   // N's west face at 3.1 stands behind X's east arrow
  await D.exec('select', X);
  const hs = D.handles();
  assert.equal(hs.length, 6, 'six arrows'); assert.ok(hs.every((h) => h.ndc && Math.abs(h.ndc[0]) < 1 && Math.abs(h.ndc[1]) < 1), 'all on the screen');
  const grab = arrowPoint(ed, X, 0, 1, 0.85);
  assert.equal(D.aim(...ndcOf(ed, grab)).pick.id, N, 'precondition: without the arrow a click here would pick the other block');
  const n0 = histLen(ed);
  dragArrow(t, X, 0, 1, 1.0, 0.85, 4);
  const x = ed.model.find(X), bx = itemAabb(x);
  assert.equal(ed.sel, X, 'the arrow was grabbed, not the block behind it');
  near(bx.min[0], -2, 1e-9, 'the west face stayed'); near(bx.max[0], 3.1, 1e-9, 'the east face went to the neighbour\'s face, not to the grid (3.0)');
  nearV([x.size[1], x.size[2], x.c[1], x.c[2]], [2, 4, 1, -3], 1e-9, 'nothing else changed');
  assert.deepEqual(ed.model.find(N).c, [4.1, 1, -3], 'the neighbour did not move');
  assert.equal(histLen(ed), n0 + 1, 'many mouse moves, one undo step');
  await D.key('KeyZ', { ctrlKey: true });
  assert.deepEqual(ed.model.find(X).size, [4, 2, 4]); assert.equal(ed.sel, X);
});

test('editor handles: a block turned by 90 degrees resizes the right WORLD axis, from the arrows and from Shift+arrows alike', async () => {
  const t = await scene(), { ed, D } = t;
  const [Y] = await addAll(D, [['floor', { c: [0, 0.5, -3], size: [2, 1, 6], yaw: 90 }]]);   // x -3 .. 3, z -4 .. -2
  await D.exec('select', Y);
  await D.key('ArrowRight', { shiftKey: true });
  assert.deepEqual(ed.model.find(Y).size, [2, 1, 6.5], 'the east face grew: the block\'s own z (its length)');
  let b = itemAabb(ed.model.find(Y));
  nearV([b.min[0], b.max[0]], [-3, 3.5], 1e-9, 'the west face stayed');
  await D.key('ArrowUp', { shiftKey: true });   // away from the camera: -z
  assert.deepEqual(ed.model.find(Y).size, [2.5, 1, 6.5], 'the north face grew: the block\'s own x (its width)');
  b = itemAabb(ed.model.find(Y));
  nearV([b.min[2], b.max[2]], [-4.5, -2], 1e-9, 'the south face stayed');
  dragArrow(t, Y, 0, 1, 1.0);
  assert.deepEqual(ed.model.find(Y).size, [2.5, 1, 7.5], 'dragging the east arrow by a metre: +1 on the length again');
  b = itemAabb(ed.model.find(Y));
  nearV([b.min[0], b.max[0]], [-3, 4.5], 1e-9);
  await D.key('ArrowLeft', { shiftKey: true });
  assert.deepEqual(ed.model.find(Y).size, [2.5, 1, 7], 'Shift+left shrinks it by a step');
});

test('editor handles: a pillar\'s top / bottom arrows change its height (the other end stays), its side arrows change the radius about the centre', async () => {
  const t = await scene(), { ed, D } = t;
  const [Q] = await addAll(D, [['pillar', { c: [0, 2, -3] }]]);   // r 0.6, h 4: y 0 .. 4
  await D.exec('select', Q);
  const kinds = D.handles().map((h) => `${h.axis}${h.dir > 0 ? '+' : '-'}${h.kind}`).sort();
  assert.deepEqual(kinds, ['0+r', '0-r', '1+h', '1-h', '2+r', '2-r'].sort());
  const n0 = histLen(ed);
  dragArrow(t, Q, 1, 1, 1.0);
  let q = ed.model.find(Q);
  near(q.h, 5, 1e-9, 'one metre taller'); near(itemAabb(q).min[1], 0, 1e-9, 'the foot stayed'); near(itemAabb(q).max[1], 5, 1e-9);
  dragArrow(t, Q, 1, -1, 1.0);
  q = ed.model.find(Q);
  near(q.h, 6, 1e-9, 'the bottom arrow grows it downwards'); near(itemAabb(q).max[1], 5, 1e-9, 'the top stayed'); near(itemAabb(q).min[1], -1, 1e-9);
  const r0 = q.r;
  dragArrow(t, Q, 0, 1, 0.5);
  q = ed.model.find(Q);
  assert.ok(q.r > r0 + 0.2, 'the radius grew'); nearV(q.c, [0, 2, -3], 1e-9, 'about the same centre'); near(q.h, 6, 1e-9, 'the height is not touched');
  const w = itemAabb(q); near(w.max[0] - w.min[0], 2.0, 0.03, 'its width is the grid step the pointer reached');
  assert.equal(histLen(ed), n0 + 3, 'three drags, three steps');
  // the pure rule: the radius scales with the pillar's width
  const p = newItem('pillar', { c: [0, 2, 0] }), width = itemAabb(p).max[0] - itemAabb(p).min[0];
  near(resizePatch(p, 0, 1, width * 2).r, p.r * 2, 0.011);
});

test('editor handles: an arrow never flips the box (min size 0.1, the fixed face stays), the other side works too, and a huge extent is clamped to 400', async () => {
  const t = await scene(), { ed, D } = t;
  const [X] = await addAll(D, [['floor', { c: [0, 1, -3], size: [4, 2, 4] }]]);
  await D.exec('select', X);
  dragArrow(t, X, 0, 1, -8.0);   // the east arrow dragged 8 m through the west face
  let b = itemAabb(ed.model.find(X));
  near(ed.model.find(X).size[0], 0.1, 1e-9, 'squeezed to the minimum, not turned inside out'); near(b.min[0], -2, 1e-9, 'the west face is where it was');
  await D.key('KeyZ', { ctrlKey: true });
  dragArrow(t, X, 0, -1, 2.0);   // the west arrow pulled out to the west
  b = itemAabb(ed.model.find(X));
  nearV([b.min[0], b.max[0]], [-4, 2], 1e-9, 'the west face moved, the east one stayed');
  assert.equal(resizePatch(ed.model.find(X), 0, 1, 1e6).size[0], LIM.sizeMax);
  assert.equal(resizePatch(ed.model.find(X), 0, 1, -5).size[0], LIM.sizeMin);
});

test('editor sticking: Shift+wheel lifts the ghost, and changing the tool resets the lift (choosing the same tool again does not)', async () => {
  const t = await scene(), { ed, D, press, fire, canvas } = t;
  press('Digit1');
  fire(canvas, 'wheel', { target: canvas, shiftKey: true, deltaY: -100 }); fire(canvas, 'wheel', { target: canvas, shiftKey: true, deltaY: -100 });
  assert.equal(ed.lift, 1, 'two notches up');
  const flat = aimAt(D, ed, [0, 0, 0]).ghost;   // the ghost sits 1 m above the surface
  near(itemAabb(flat).min[1], 1, 1e-9, 'the ghost is lifted');
  press('Digit1'); assert.equal(ed.lift, 1, 'the same tool: still lifted');
  press('Digit2'); assert.equal(ed.tool, 'wall'); assert.equal(ed.lift, 0, 'another tool: back on the surface');
  near(itemAabb(aimAt(D, ed, [0, 0, 0]).ghost).min[1], 0, 1e-9);
});

// ================================================================ the fix round: group R pivot, slope placement of points, Ctrl+D limit, camera inside a solid, keys during a drag
const snapshot = (ed) => JSON.parse(JSON.stringify(ed.model.doc.items));
const onGrid = (v, g = 0.5) => near(v / g, Math.round(v / g), 1e-6, 'on the grid:');
// select every item of the scene, press R four times (real key path); `check(k)` runs after each turn; four turns must give back the exact document
const fourTurns = async (t, check) => {
  const { ed, D } = t;
  await D.exec('select', ids(ed));
  const start = snapshot(ed), n0 = histLen(ed);
  for (let k = 1; k <= 4; k++) {
    await D.key('KeyR');
    assert.equal(histLen(ed), n0 + k, `turn ${k} is one step`);
    if (k < 4) assert.notDeepEqual(snapshot(ed), start, `turn ${k} did turn something`);
    check(k);
  }
  assert.deepEqual(snapshot(ed), start, 'four turns: every item exactly where it began');
};

test('editor group: R about a group whose block is on the grid keeps that block on the grid after EVERY turn (floor + a crate sticking out 0.65 m past its edge), and an off-grid group comes back exactly after four turns', async () => {
  let t = await scene();
  const [F] = await addAll(t.D, [['floor', { c: [3, -0.5, 3], size: [6, 1, 6] }], ['deco', { pos: [6.65, 0.65, 3] }]]);   // the middle of the group is x 3.65: not a grid point
  await fourTurns(t, (k) => {
    const b = itemAabb(t.ed.model.find(F));
    onGrid(b.min[0]); onGrid(b.min[2]);
    nearV([b.max[0] - b.min[0], b.max[2] - b.min[2]], [6, 6], 1e-9, `turn ${k}: the floor keeps its size`);
  });
  // nothing on the grid, and the middle of the group (x 3.955, z 3.655) is not a whole 0.01 either: the pivot is the middle rounded to 0.01 and is
  // remembered, so the rounding does not push the group about by 0.005 m a turn
  t = await scene();
  await addAll(t.D, [['floor', { c: [3.3, -0.5, 3.11], size: [6, 1, 6] }], ['deco', { pos: [6.96, 0.65, 6.55] }]]);
  await fourTurns(t, () => {});
});

test('editor group: R about a floor + the default pillar (r 0.6, 8 sides) next to it keeps the floor on the grid after EVERY turn and four turns are the identity', async () => {
  const t = await scene();
  const [F, Q] = await addAll(t.D, [['floor', { c: [3, -0.5, 3], size: [6, 1, 6] }], ['pillar', { c: [7, 2, 3] }]]);
  await fourTurns(t, (k) => {
    const b = itemAabb(t.ed.model.find(F)), q = itemAabb(t.ed.model.find(Q));
    onGrid(b.min[0]); onGrid(b.min[2]);
    // the pillar stays beside the floor: a turn about one point keeps their layout, only turned
    const gap = [0, 2].map((a) => Math.max(q.min[a] - b.max[a], b.min[a] - q.max[a]));
    assert.ok(Math.max(...gap) >= -1e-6 && Math.max(...gap) <= 0.5, `turn ${k}: the pillar is still beside the floor: gaps ${gap}`);
  });
});

test('editor sticking: a pad, a light and the start point aimed at a ramp sit ON the slope; the start is lifted by the uphill reach of the player\'s hull (~0.14 m), so the validator does not call it "in a solid"', async () => {
  const { ed, D } = await scene();
  await addAll(D, [['ramp', { c: [0, 1, 0], size: [4, 2, 6] }]]);   // rises toward +z: the slope is y = (z + 3) / 3
  const slope = (z) => (z + 3) / 3, solidWarn = () => D.state().validate.warnings.filter((w) => /szilárd elemben/.test(w));
  await D.exec('setStart', [0, slope(-1.5), -1.5], 0);
  assert.equal(solidWarn().length, 1, 'precondition: a start exactly on the slope IS inside the ramp for the validator');
  const aim = () => aimAt(D, ed, [0, slope(-1.7), -1.7]);
  await D.exec('tool', 'pad');
  let a = aim();
  nearV([a.hit.point[0], a.hit.point[2]], [0, -1.7], 0.05, 'the cursor is on the slope where we aimed');
  near(a.ghost.pos[1], slope(a.ghost.pos[2]), 0.02, 'the pad: on the slope plane, not on the ground (y 0)');
  assert.ok(a.ghost.pos[1] > 0.3, 'well above the ground');
  await D.exec('tool', 'light');
  a = aim();
  near(a.ghost.pos[1] - 2, slope(a.ghost.pos[2]), 0.02, 'the light: two metres over the slope plane');
  await D.exec('tool', 'start');
  aim();
  await D.click();
  const sp = ed.model.doc.start.pos, above = sp[1] - slope(sp[2]);
  assert.ok(sp[1] > 0.4, 'the start is on the ramp, not on the ground: y ' + sp[1]);
  assert.ok(above >= 0.1 && above <= 0.2, 'lifted by about the hull reach over the plane: ' + above);
  assert.deepEqual(solidWarn(), [], 'the validator (on the rebuilt world) finds the start free');
});

test('editor group: Ctrl+D on a group that would not fit under the item limit changes nothing and says so; a group that exactly fits (the start point does not count) is copied', async () => {
  const { ed, D } = await scene();
  const group = [...await addAll(D, [['floor', { c: [-8, 0, 0], size: [2, 1, 2] }], ['floor', { c: [0, 0, 0], size: [2, 1, 2] }], ['floor', { c: [8, 0, 0], size: [2, 1, 2] }]]), 'start'];
  await D.exec('select', group);
  const was = snapshot(ed), n0 = histLen(ed), lim = LIM.items;
  try {
    LIM.items = ed.model.doc.items.length + 2;   // room for two copies, three wanted
    await D.key('KeyD', { ctrlKey: true });
    assert.deepEqual(snapshot(ed), was, 'no copy was made');
    assert.equal(histLen(ed), n0, 'no history entry');
    assert.deepEqual(sorted(D.state().sels), sorted(group), 'the selection is as it was');
    assert.match(ed.panel.msg.textContent, /A másolatok nem férnek el/);
    LIM.items = ed.model.doc.items.length + 3;   // exactly three
    await D.key('KeyD', { ctrlKey: true });
    assert.equal(ed.model.doc.items.length, was.length + 3, 'three copies');
    assert.equal(histLen(ed), n0 + 1, 'one step');
  } finally { LIM.items = lim; }
});

test('editor aim: with the camera INSIDE a solid block the ghost is not put at the camera (no target, the surface is the ground); from outside the same block is still the target', async () => {
  const { ed, D } = await scene();
  const [B] = await addAll(D, [['floor', { c: [0, 2, 0], size: [20, 4, 20] }]]);   // y 0 .. 4
  await D.exec('tool', 'wall');
  D.setCam([0, 2, 0], 0, -30);
  const a = D.aim(0, 0), cam = ed.cam.pos;
  assert.equal(ed.aim.target, null, 'the block the ray starts inside is no target');
  assert.ok(Math.hypot(...a.hit.point.map((v, i) => v - cam[i])) > 1, 'the aimed surface is not the camera\'s own spot: ' + a.hit.point);
  assert.ok(Math.hypot(...a.ghost.c.map((v, i) => v - cam[i])) > 1, 'the ghost is not at the camera: ' + a.ghost.c);
  D.setCam([0, 12, 12], 0, -45);   // control: from outside, the top of the block is the target
  D.aim(0, 0);
  assert.equal(ed.aim.target && ed.aim.target.id, B, 'from outside the block is the target');
});

test('editor drag: while a drag is on, R / Del / Ctrl+Z / Ctrl+D / arrows / Shift+wheel change nothing (no history step either), and R works again after the mouse is released', async () => {
  const t = await scene(), { ed, D, press, fire, canvas } = t;
  const [A, B] = await addAll(D, [['floor', { c: [-5, 1, -4], size: [2, 2, 2] }], ['floor', { c: [5, 1, -4], size: [2, 2, 2] }]]);
  await D.exec('select', [A, B]);
  const from = ndcOf(ed, topOf(ed.model.find(A))), to = ndcOf(ed, moved(topOf(ed.model.find(A)), 2, -3));
  const [x0, y0] = px(from);
  fire(canvas, 'mousedown', { target: canvas, clientX: x0, clientY: y0, button: 0 });
  for (let i = 1; i <= 3; i++) { const [x, y] = px([from[0] + ((to[0] - from[0]) * i) / 3, from[1] + ((to[1] - from[1]) * i) / 3]); fire(canvas, 'mousemove', { target: canvas, clientX: x, clientY: y }); }
  assert.ok(ed.drag && ed.drag.moved, 'precondition: a move drag is on');
  const mid = snapshot(ed), n0 = histLen(ed), sels = sorted(D.state().sels);
  assert.notEqual(ed.model.find(A).c[2], -4, 'precondition: the drag moved the block');
  for (const [code, o] of [['KeyR', {}], ['Delete', {}], ['KeyZ', { ctrlKey: true }], ['KeyD', { ctrlKey: true }], ['ArrowRight', {}], ['PageUp', {}]]) {
    press(code, o);
    assert.deepEqual(snapshot(ed), mid, `${code} mid-drag: the document is untouched`);
  }
  fire(canvas, 'wheel', { target: canvas, shiftKey: true, deltaY: -100 });
  assert.deepEqual(snapshot(ed), mid, 'Shift+wheel mid-drag: the document is untouched');
  assert.equal(histLen(ed), n0, 'and no history step was added');
  assert.deepEqual(sorted(D.state().sels), sels, 'the selection is as it was');
  fire(canvas, 'mouseup', { target: canvas, button: 0 });
  assert.equal(ed.drag, null);
  press('KeyR');
  assert.equal(histLen(ed), n0 + 1, 'after the mouse is up R is one step again');
  assert.notEqual(ed.model.find(A).yaw, mid[0].yaw, 'and it turned the group');
});
