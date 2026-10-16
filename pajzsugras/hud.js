// The DOM HUD over the canvas: big timer, split delta vs the personal best at every checkpoint, CP n/N, next medal target,
// speedometer, the shield charge ring around the crosshair, the optional Defrag style key overlay, centre messages, the
// live standings list (for races) and the respawn fade.
//
//   const hud = new Hud();
//   hud.show(bool)  hud.setRun({ medals, pb, cpCount })  hud.reset()  hud.update(st)  hud.split(label, ticks, deltaTicks | null)
//   hud.center(msg, { ms = 1800, kind: 'info' | 'good' | 'bad' | 'gold' | 'big' })
//   hud.standings([{ id, name, color (hex number | css), cp, cpCount, time (s | null), finished, me }])  (null / [] hides)
//   hud.fade(ms)   hud.hint(text)   hud.setKeys(bool)
import { TICK } from './sim/const.js';

export const MEDAL_NAME = { author: 'SZERZŐ', gold: 'ARANY', silver: 'EZÜST', bronze: 'BRONZ' };
export const MEDAL_COLOR = { author: '#6df2ff', gold: '#ffd24a', silver: '#d4dde3', bronze: '#d18a4a' };

// seconds -> m:ss.mmm
export function fmtTime(s, decimals = 3) {
  if (s == null || !Number.isFinite(s)) return '–:––.–––';
  const neg = s < 0;
  s = Math.abs(s);
  let m = Math.floor(s / 60), r = s - m * 60;
  let txt = r.toFixed(decimals);
  if (parseFloat(txt) >= 60) { m++; r = 0; txt = (0).toFixed(decimals); }
  return (neg ? '−' : '') + m + ':' + txt.padStart(decimals ? decimals + 3 : 2, '0');
}
export const fmtDelta = (s) => (s < 0 ? '−' : '+') + Math.abs(s).toFixed(3);
export const fmtSpeed = (v) => v.toFixed(1).replace('.', ',');

const $ = (id) => document.getElementById(id);
const css = (c) => (typeof c === 'number' ? '#' + c.toString(16).padStart(6, '0') : String(c || '#fff'));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export class Hud {
  constructor() {
    this.root = $('hud');
    this.el = {
      time: $('h-time'), cp: $('h-cp'), pb: $('h-pb'), medal: $('h-medal'), split: $('h-split'), cross: $('h-cross'), ring: $('h-ring'),
      speed: $('h-speed-n'), bar: $('h-speed-bar'), keys: $('h-keys'), center: $('h-center'), stand: $('h-stand'), hint: $('h-hint'), fade: $('fade'),
    };
    this.last = {};
    this.medals = null; this.pb = null; this.cpCount = 0;
    this.splitTimer = 0; this.centerTimer = 0; this.fadeTimer = 0;
    this.keyEls = {};
    for (const b of this.el.keys.querySelectorAll('[data-k]')) this.keyEls[b.dataset.k] = b;
    this.setKeys(false);
  }

  show(b) { this.root.hidden = !b; }
  setKeys(b) { this.el.keys.hidden = !b; }
  hint(text) { if (this.last.hint !== text) { this.last.hint = text; this.el.hint.textContent = text || ''; } }

  // run info: medals { author, gold, silver, bronze } (s), pb { ticks, splits } | null
  setRun({ medals, pb, cpCount }) {
    this.medals = medals; this.pb = pb; this.cpCount = cpCount;
    this.last = {};
    this.el.pb.innerHTML = pb ? `PB <b>${fmtTime(pb.ticks / TICK)}</b>` : '';
    this.reset();
  }
  reset() {
    this.last.time = null;
    this.el.split.className = 'hide';
    this.el.split.textContent = '';
    this.splitTimer = 0;
    this.el.center.textContent = '';
    this.last.cpTxt = null; this.last.medalTxt = null;
  }

  // st: { time (s), state 'ready' | 'running' | 'finished', cp, speed, charge, charging, keys, medalsDone }
  update(st) {
    const e = this.el, L = this.last;
    const ts = fmtTime(st.time);
    if (ts !== L.time) { L.time = ts; e.time.textContent = ts; }
    if (st.state !== L.state) { L.state = st.state; e.time.className = st.state === 'ready' ? 'ready' : st.state === 'finished' ? 'done' : ''; }
    const cpTxt = `CP <b>${st.cp}</b>/${this.cpCount}`;
    if (cpTxt !== L.cpTxt) { L.cpTxt = cpTxt; e.cp.innerHTML = cpTxt; }
    this.updateMedal(st.time, st.state);
    const sp = Math.round(st.speed * 10) / 10;
    if (sp !== L.speed) { L.speed = sp; e.speed.textContent = fmtSpeed(sp); e.bar.style.width = Math.min(100, (sp / 20) * 100).toFixed(0) + '%'; }
    const ch = st.charging ? st.charge : 0, rq = Math.round(ch * 100);
    if (rq !== L.ring) {
      L.ring = rq;
      e.ring.setAttribute('stroke-dashoffset', (163.4 * (1 - ch)).toFixed(1));
      e.cross.classList.toggle('full', ch >= 0.995);
    }
    if (st.keys && !e.keys.hidden) {
      const k = st.keys;
      for (const name of ['w', 'a', 's', 'd', 'jump', 'fire']) {
        const on = !!k[name];
        if (L['k' + name] !== on) { L['k' + name] = on; this.keyEls[name].classList.toggle('on', on); }
      }
    }
  }

  // the best medal that can still be earned with the current time (or, before the run, the next one above your best)
  updateMedal(time, state) {
    const m = this.medals;
    if (!m) return;
    let txt = '';
    if (state === 'finished') txt = '';
    else {
      const best = this.pb ? this.pb.ticks / TICK : Infinity;
      const order = [['bronze', m.bronze], ['silver', m.silver], ['gold', m.gold], ['author', m.author]];
      // target: the worst medal better than the personal best that is still reachable
      let target = null;
      for (const [k, t] of order) if (best > t && time <= t) { target = [k, t]; break; }
      if (!target && best > m.author) for (const [k, t] of order) if (time <= t) { target = [k, t]; break; }
      if (target) txt = `<span style="--c:${MEDAL_COLOR[target[0]]}">CÉL <b>${MEDAL_NAME[target[0]]} ${fmtTime(target[1], 1)}</b></span>`;
    }
    if (txt !== this.last.medalTxt) { this.last.medalTxt = txt; this.el.medal.innerHTML = txt; }
  }

  // a checkpoint split: ticks = the time at the checkpoint, deltaTicks vs the PB (null without a PB)
  split(label, ticks, deltaTicks) {
    const e = this.el.split;
    if (deltaTicks == null) { e.className = ''; e.innerHTML = `<small>${esc(label)}</small>${fmtTime(ticks / TICK)}`; }
    else { const d = deltaTicks / TICK; e.className = d <= 0 ? 'good' : 'bad'; e.innerHTML = `<small>${esc(label)}</small>${fmtDelta(d)}`; }
    this.splitTimer = 3.2;
  }

  center(msg, { ms = 1800, kind = 'info' } = {}) {
    const c = this.el.center;
    c.className = (kind === 'info' ? '' : kind + ' ') + 'pop';
    c.textContent = msg;
    void c.offsetWidth;
    c.className = (kind === 'info' ? '' : kind + ' ') + 'pop';
    this.centerTimer = ms / 1000;
  }

  standings(list) {
    const s = this.el.stand;
    if (!list || !list.length) { s.innerHTML = ''; this.last.stand = ''; return; }
    const html = list.map((p, i) => {
      const st = p.finished ? fmtTime(p.time) : p.cpCount ? `CP ${p.cp}/${p.cpCount}` : `CP ${p.cp ?? 0}`;
      return `<div class="r${p.me ? ' me' : ''}${p.finished ? ' fin' : ''}" style="--c:${css(p.color)}"><span class="p">${i + 1}.</span><i></i><span class="n">${esc(p.name)}</span><span class="s">${st}</span></div>`;
    }).join('');
    if (html !== this.last.stand) { this.last.stand = html; s.innerHTML = html; }
  }

  // black flash that fades out (respawn)
  fade(ms = 380, from = 0.85) {
    const f = this.el.fade;
    f.style.transition = 'none'; f.style.opacity = String(from);
    void f.offsetWidth;
    f.style.transition = `opacity ${ms}ms ease-out`; f.style.opacity = '0';
  }

  // called every frame (real seconds)
  tick(dt) {
    if (this.splitTimer > 0) { this.splitTimer -= dt; if (this.splitTimer <= 0.6) this.el.split.classList.add('hide'); }
    if (this.centerTimer > 0) { this.centerTimer -= dt; if (this.centerTimer <= 0) { this.el.center.textContent = ''; this.el.center.className = ''; } }
  }
}
