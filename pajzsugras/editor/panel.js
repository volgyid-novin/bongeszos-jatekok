// PAJZSUGRÁS map editor, the DOM over the canvas: top bar, palette, properties panel (numeric fields), status line, help.
// Only the panels take mouse events (#editor itself is pointer-events: none), so everything else reaches the 3D view.
//
//   const panel = new EditorPanel(rootEl, ed)   ed = the Editor (model, tool, sel, patch(), deleteSel() ... see editor.js)
//   panel.setTool(id)  panel.setSelection()  panel.refresh()  panel.status(text, kind, ms)  panel.clearStatus()  panel.setHidden(b)  panel.toggleHelp()
//   panel.setMarquee({ x, y, w, h } | null)   the selection rectangle, in CSS pixels of the window (a div of the page, outside the zoomed #editor)
//   panel.setSaveState('saved' | 'dirty' | 'fail' | 'new')   the small "Mentve" label next to the map name
import { PALETTE, MATS, MAT_LABEL, KILL_KINDS, KILL_LABEL, DECO_KINDS, DECO_LABEL, TYPE_LABEL, validate } from './model.js';
import { EDITOR_HELP } from './help.js';

const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
};
const hex6 = (n) => '#' + (n >>> 0).toString(16).padStart(6, '0');

export class EditorPanel {
  constructor(root, ed) {
    this.root = root;
    this.ed = ed;
    this.fields = [];
    this.propsFor = null;      // the id the properties are built for
    this.statusTimer = 0;
    this.build();
  }

  build() {
    const ed = this.ed, noFocus = (e) => e.preventDefault();   // buttons never take the keyboard focus: Space must keep flying, not click
    const btn = (act, label, title, extra = {}) => h('button', { type: 'button', class: 'ed-btn', 'data-act': act, title, tabindex: '-1', onmousedown: noFocus, onclick: () => ed.action(act), ...extra }, label);
    this.name = h('input', { type: 'text', class: 'ed-name', maxlength: '40', 'aria-label': 'A pálya neve', spellcheck: 'false', autocomplete: 'off', oninput: () => ed.setName(this.name.value) });
    this.saveState = h('span', { class: 'ed-savestate', title: 'A pálya magától ment: 1,5 mp-cel a módosítás után' });
    this.undoBtn = btn('undo', '↶', 'Visszavonás (Ctrl+Z)');
    this.redoBtn = btn('redo', '↷', 'Újra (Ctrl+Y)');
    this.top = h('div', { class: 'ed-top ed-panel' },
      h('b', { class: 'ed-brand' }, 'SZERKESZTŐ'), this.name, this.saveState, this.undoBtn, this.redoBtn, h('i', { class: 'ed-sep' }),
      btn('test-cam', ['▶ Próba a kamerától ', h('kbd', {}, 'T')], 'Gyakorló próba onnan, ahol a kamera áll (T vagy F2)'),
      btn('test-start', ['▶ Próba a rajttól ', h('kbd', {}, 'Enter')], 'Teljes szabályok a rajtpontról (Enter)'), h('i', { class: 'ed-sep' }),
      btn('save', ['Mentés ', h('kbd', {}, 'Ctrl+S')], 'Mentés most (magától is ment)'), btn('export', 'Exportálás', 'A pálya letöltése .json fájlként'),
      btn('help', ['Súgó ', h('kbd', {}, 'H')], 'Billentyűk (H)'), btn('exit', 'Kilépés', 'Mentés és vissza a főmenübe'));
    // the palette
    this.palBtns = new Map();
    const palBtn = (id, label, key, title = label) => {
      const b = h('button', { type: 'button', class: 'ed-tool', 'data-tool': id, tabindex: '-1', onmousedown: noFocus, onclick: () => ed.setTool(id), title: title + (key ? ` (${key})` : '') },
        h('i', { class: 'ed-sw ed-sw-' + id }), h('span', {}, label), key ? h('kbd', {}, key) : null);
      this.palBtns.set(id, b);
      return b;
    };
    this.pal = h('div', { class: 'ed-pal ed-panel' }, palBtn('select', 'Kijelölés', 'V'), h('hr'), PALETTE.filter((p) => p.t !== 'deco').map((p) => palBtn(p.id, p.label, p.key)),
      h('hr'), h('div', { class: 'ed-pal-h' }, 'Díszek'), h('div', { class: 'ed-pal-grid' }, PALETTE.filter((p) => p.t === 'deco').map((p) => palBtn(p.id, p.label, p.key, 'Dísz: ' + p.label))));
    this.props = h('div', { class: 'ed-props ed-panel' });
    this.hint = h('span', { class: 'ed-hint' });
    this.msg = h('span', { class: 'ed-msg' });
    this.info = h('span', { class: 'ed-info' });
    this.checks = h('ul', { class: 'ed-warn' });   // the validation messages, under the properties of whatever is selected
    this.checkSig = null;
    this.statusBar = h('div', { class: 'ed-status ed-panel' }, this.hint, this.msg, this.info);
    this.help = h('div', { class: 'ed-help ed-panel', hidden: true, onclick: () => this.toggleHelp() },
      h('h3', {}, 'Szerkesztő: billentyűk'),
      h('div', { class: 'ed-help-cols' }, [EDITOR_HELP.slice(0, Math.ceil(EDITOR_HELP.length / 2)), EDITOR_HELP.slice(Math.ceil(EDITOR_HELP.length / 2))]
        .map((half) => h('table', {}, half.map((r) => h('tr', {}, h('td', {}, h('kbd', {}, r[0])), h('td', {}, r[1])))))),
      h('p', {}, 'Kattints ide a bezáráshoz (H vagy Esc is jó).'));
    this.root.replaceChildren(this.top, this.pal, this.props, this.statusBar, this.help);
    this.marquee = h('div', { class: 'ed-marquee', hidden: true });   // (not inside #editor: its zoom would scale the pixel coordinates)
    document.body.append(this.marquee);
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    this.setTool(this.ed.tool);
  }

  setHidden(b) { for (const e of [this.top, this.pal, this.props]) e.hidden = b; }
  toggleHelp() { this.help.hidden = !this.help.hidden; }
  setTool(id) { for (const [k, b] of this.palBtns) b.classList.toggle('on', k === id); }
  setName(name) { if (document.activeElement !== this.name) this.name.value = name; }
  setMarquee(r) {
    if (!r) { this.marquee.hidden = true; return; }
    Object.assign(this.marquee.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
    this.marquee.hidden = false;
  }
  setHint(text) { if (this.hint.textContent !== text) this.hint.textContent = text; }
  setInfo(text) { if (this.info.textContent !== text) this.info.textContent = text; }
  setSaveState(kind) {
    const text = { saved: 'Mentve', dirty: 'Mentés…', fail: 'Nincs mentve!', new: '' }[kind] || '';
    if (this.saveState.textContent !== text) this.saveState.textContent = text;
    this.saveState.className = 'ed-savestate ' + kind;
  }
  clearStatus() { clearTimeout(this.statusTimer); this.msg.textContent = ''; }
  status(text, kind = 'info', ms = 3500) {
    this.msg.textContent = text;
    this.msg.className = 'ed-msg ' + kind;
    clearTimeout(this.statusTimer);
    if (ms) this.statusTimer = setTimeout(() => { this.msg.textContent = ''; }, ms);
  }

  // ---------------------------------------------------------------- properties
  // rebuild for the selected item (or the map itself when nothing is selected)
  setSelection() {
    const ed = this.ed, it = ed.sel ? ed.model.find(ed.sel) : null;
    this.propsFor = it ? it.id : null;
    this.fields = [];
    this.cpLabel = null;
    const p = this.props;
    p.replaceChildren();
    if (!it) { this.buildMapInfo(); this.refresh(); return; }
    if (ed.selIds.length > 1) { this.buildGroup(); return; }
    p.append(h('h3', {}, TYPE_LABEL[it.t] || it.t, it.id !== 'start' ? h('small', {}, ' #' + it.id) : null));
    const patch = (prop) => (v) => ed.patch({ [prop]: v }, `f:${it.id}:${prop}`);
    switch (it.t) {
      case 'block': case 'ramp':
        p.append(this.vec('Középpont', 'c', 0.5, patch('c')), this.vec('Méret', 'size', 0.5, patch('size')), this.yawSel(patch('yaw')), this.matSel(patch('mat')));
        break;
      case 'prism':
        p.append(this.vec('Középpont', 'c', 0.5, patch('c')), this.one('Sugár', 'r', 0.1, patch('r'), 0.1), this.one('Magasság', 'h', 0.5, patch('h')), this.one('Oldalak', 'sides', 1, patch('sides'), 3, 16), this.yawSel(patch('yaw')), this.matSel(patch('mat')));
        break;
      case 'kill':
        p.append(this.vec('Középpont', 'c', 0.5, patch('c')), this.vec('Méret', 'size', 0.5, patch('size')), this.sel('Fajta', 'kind', KILL_KINDS.map((k) => [k, KILL_LABEL[k]]), patch('kind')));
        break;
      case 'cp':
        p.append(this.vec('Középpont', 'c', 0.5, patch('c')), this.vec('Méret', 'size', 0.5, patch('size')), this.one('Irány (°)', 'yaw', 15, patch('yaw')), this.cpOrder(it));
        break;
      case 'finish':
        p.append(this.vec('Középpont', 'c', 0.5, patch('c')), this.vec('Méret', 'size', 0.5, patch('size')));
        break;
      case 'pad':
        p.append(this.vec('Párna', 'pos', 0.5, patch('pos')), this.vec('Cél', 'target', 0.5, patch('target')), this.one('Csúcs (m)', 'apex', 0.5, patch('apex')));
        break;
      case 'light':
        p.append(this.vec('Hely', 'pos', 0.5, patch('pos')), this.color(patch('color')), this.one('Fényerő', 'intensity', 0.1, patch('intensity'), 0.1, 10), this.one('Hatótáv (m)', 'range', 1, patch('range'), 1, 100));
        break;
      case 'deco':
        p.append(this.sel('Fajta', 'kind', DECO_KINDS.map((k) => [k, DECO_LABEL[k]]), patch('kind')), this.vec('Középpont', 'pos', 0.5, patch('pos')), this.vec('Méret', 'size', 0.5, patch('size')), this.one('Irány (°)', 'yaw', 15, patch('yaw')));
        break;
      case 'start':
        p.append(this.vec('Lábak', 'pos', 0.5, (v) => ed.patch({ pos: v }, 'f:start:pos')), this.one('Irány (°)', 'yaw', 15, (v) => ed.patch({ yaw: v }, 'f:start:yaw')));
        break;
      default: break;
    }
    if (it.t !== 'start') {
      const noFocus = (e) => e.preventDefault();
      p.append(h('div', { class: 'ed-actions' },
        it.t !== 'light' && it.t !== 'pad' ? h('button', { type: 'button', class: 'ed-btn', tabindex: '-1', onmousedown: noFocus, onclick: () => ed.action('rotate') }, ['Forgat ', h('kbd', {}, 'R')]) : null,
        it.t !== 'finish' ? h('button', { type: 'button', class: 'ed-btn', tabindex: '-1', onmousedown: noFocus, onclick: () => ed.action('duplicate') }, ['Másol ', h('kbd', {}, 'Ctrl+D')]) : null,
        h('button', { type: 'button', class: 'ed-btn bad', tabindex: '-1', onmousedown: noFocus, onclick: () => ed.action('delete') }, ['Töröl ', h('kbd', {}, 'Del')])));
    } else {
      p.append(h('p', { class: 'ed-note' }, 'A rajtpont: ide érkezel a „Próba a rajttól” és az újrakezdés (Enter) után. K: ahová célzol.'));
    }
    p.append(this.checks);
    this.refresh();
  }

  // several items selected: the count and the buttons that work on all of them (and the material, when they all have one)
  buildGroup() {
    const ed = this.ed, p = this.props, noFocus = (e) => e.preventDefault(), items = ed.selItems();
    const btn = (act, label, key, cls = '') => h('button', { type: 'button', class: 'ed-btn ' + cls, 'data-act': act, tabindex: '-1', onmousedown: noFocus, onclick: () => ed.action(act) }, [label + ' ', h('kbd', {}, key)]);
    p.append(h('h3', {}, `${items.length} elem kijelölve`, ed.isSel('start') ? h('small', {}, ' · rajtpont') : null));
    if (items.every((it) => it.mat)) {   // (mixed materials show "Vegyes")
      p.append(this.sel('Anyag', 'mat', [['', 'Vegyes'], ...MATS.map((m) => [m, MAT_LABEL[m]])], (v) => { if (v) ed.patchGroup({ mat: v }, 'f:group:mat'); }));
      this.fields[0].read = () => { const ms = new Set(ed.selItems().map((it) => it.mat)); return ms.size === 1 ? [...ms][0] : ''; };
    }
    p.append(h('div', { class: 'ed-actions' }, btn('rotate', 'Forgatás', 'R'), btn('duplicate', 'Másolás', 'Ctrl+D'), btn('delete', 'Törlés', 'Del', 'bad')),
      h('p', { class: 'ed-note' }, 'Együtt mozognak: húzd bármelyiket. Shift + kattintás: hozzáad / elvesz. A rajtpont és a cél nem másolódik, a rajtpont nem törlődik.'), this.checks);
    this.refresh();
  }

  buildMapInfo() {
    const p = this.props;
    this.mapSummary = h('p', { class: 'ed-note' });
    p.append(h('h3', {}, 'Pálya'), this.mapSummary, this.checks,
      h('p', { class: 'ed-note' }, 'Válassz egy eszközt a bal oldalon (1–0), és kattints a térbe. Kijelöléshez V, majd kattints az elemre. H: súgó.'));
  }

  row(label, ...kids) { return h('div', { class: 'ed-row' }, h('label', {}, label), ...kids); }
  // a number field; read() pulls the value from the item on refresh
  numInput(prop, idx, step, onSet, min, max) {
    const inp = h('input', { type: 'number', class: 'ed-num', step: String(step), min: min ?? false, max: max ?? false, inputmode: 'decimal', tabindex: '0' });
    inp.addEventListener('input', () => { if (Number.isFinite(inp.valueAsNumber)) onSet(idx); });
    return inp;
  }
  one(label, prop, step, set, min, max) {
    const inp = this.numInput(prop, 0, step, () => set(inp.valueAsNumber), min, max);
    this.fields.push({ inp, read: (it) => it[prop] });
    return this.row(label, inp);
  }
  vec(label, prop, step, set, min) {
    const ins = [0, 1, 2].map((i) => this.numInput(prop, i, step, () => { if (ins.every((x) => Number.isFinite(x.valueAsNumber))) set(ins.map((x) => x.valueAsNumber)); }, min));
    ins.forEach((inp, i) => this.fields.push({ inp, read: (it) => it[prop][i] }));
    return this.row(label, h('span', { class: 'ed-vec' }, ins));
  }
  sel(label, prop, options, set) {
    const s = h('select', { class: 'ed-sel', tabindex: '-1', onchange: () => { set(s.value); s.blur(); } }, options.map(([v, t]) => h('option', { value: v }, t)));
    this.fields.push({ inp: s, read: (it) => it[prop] });
    return this.row(label, s);
  }
  matSel(set) { return this.sel('Anyag', 'mat', MATS.map((m) => [m, MAT_LABEL[m]]), set); }
  yawSel(set) { return this.sel('Forgatás', 'yaw', [0, 90, 180, 270].map((y) => [String(y), y + '°']), (v) => set(Number(v))); }
  color(set) {
    const inp = h('input', { type: 'color', class: 'ed-color', tabindex: '-1', oninput: () => set(parseInt(inp.value.slice(1), 16)), onchange: () => inp.blur() });
    this.fields.push({ inp, read: (it) => hex6(it.color) });
    return this.row('Szín', inp);
  }
  cpOrder(it) {
    const noFocus = (e) => e.preventDefault();
    this.cpLabel = h('span', { class: 'ed-cpn' });
    return this.row('Sorrend', this.cpLabel,
      h('button', { type: 'button', class: 'ed-btn sm', tabindex: '-1', title: 'Előrébb', onmousedown: noFocus, onclick: () => this.ed.action('cp-up') }, '▲'),
      h('button', { type: 'button', class: 'ed-btn sm', tabindex: '-1', title: 'Hátrébb', onmousedown: noFocus, onclick: () => this.ed.action('cp-down') }, '▼'));
  }

  // push the document's current values into the fields (not the one being typed in) and the toolbar state
  refresh() {
    const ed = this.ed, m = ed.model;
    this.undoBtn.disabled = !m.history.canUndo;
    this.redoBtn.disabled = !m.history.canRedo;
    this.setName(m.doc.name);
    this.updateChecks(m.doc);
    const it = ed.sel ? m.find(ed.sel) : null;
    if (ed.sel && !it) return;
    if (it) {
      for (const f of this.fields) if (document.activeElement !== f.inp) { const v = f.read(it); const s = String(v); if (f.inp.value !== s) f.inp.value = s; }
      if (it.t === 'cp' && this.cpLabel) { const cps = m.cpItems(); this.cpLabel.textContent = `${cps.findIndex((c) => c.id === it.id) + 1}. / ${cps.length}`; }
    } else if (this.mapSummary) {
      const d = m.doc;
      this.mapSummary.textContent = `${d.items.length} elem · ${m.cpItems().length} ellenőrzőpont · ${m.finish ? 'van cél' : 'nincs cél'}`;
    }
  }

  // the validation messages (model.js validate, with the built world: the editor calls this again when a rebuild is done); rebuilt only when they change
  updateChecks(doc) {
    const v = validate(doc, this.ed.world), sig = JSON.stringify([v.errors, v.warnings]);
    if (sig === this.checkSig) return;
    this.checkSig = sig;
    const rows = [...v.errors.map((t) => [t, 'bad']), ...v.warnings.map((t) => [t, ''])];
    this.checks.replaceChildren(...(rows.length ? rows : [['Nincs figyelmeztetés: a pálya játszható.', 'ok']]).map(([t, c]) => h('li', { class: c }, t)));
  }
}
