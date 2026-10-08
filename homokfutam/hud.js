import * as THREE from 'three';

// The race HUD (index.html #hud): position, lap and the live standings top left; time, the delta to the best lap
// and four sectors top right; the lap strip top centre; speed with the heat arc and the gaps to the pods ahead and
// behind bottom centre; name tags over the pods; a glow on the side of a pod closing in from behind; an event feed;
// the start lights with the perfect-start window. main.js calls update() once a frame and reports crashes and
// players leaving. Everything is measured here from what every client knows about every pod (prog and lap), so it
// works the same for bots, for this player and for the other players in a room.

const STEP = 10;                       // the time at every 10 m of a pod's progress (gaps, lap times, the delta)
const SET_KEY = 'homokfutam:hud';
const HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => HTML_ESC[c]);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const up = (s) => String(s).toLocaleUpperCase('hu');
const MINUS = '−';
const fmtGap = (g) => (Math.abs(g) < 0.05 ? '' : g < 0 ? MINUS : '+') + Math.abs(g).toFixed(1);
const fmtDelta = (g) => (g < 0 ? MINUS : '+') + Math.abs(g).toFixed(2);
const ICON = { pass: '▲', lost: '▼', crash: '!', fast: '◆', left: '–', lead: '1' };

export function createHUD({ camera, TR, fmtTime, archS, touch }) {
  const $ = (id) => document.getElementById(id);
  const hudEl = $('hud');
  const L = TR.L;

  // ---------- settings (menu: BEÁLLÍTÁSOK / KIJELZŐ) ----------
  // tags: 0 off, 1 the nearest pods, 2 all; tower: 0 compact, 1 full; map: 1 minimap, 2 strip, 3 both;
  // near: the closing-pod glow; feed: the event feed; scale: HUD size in %
  const S = { tags: 1, tower: 0, map: touch ? 2 : 3, near: 1, feed: 1, scale: 100 };
  try { Object.assign(S, JSON.parse(localStorage.getItem(SET_KEY) || '{}')); } catch { /* storage blocked */ }
  let hs = 1;
  function resize() {
    const fit = Math.min(innerWidth / 1920, innerHeight / 1080);
    hs = (S.scale / 100) * clamp(fit, touch ? 0.5 : 0.6, 1.25);
    hudEl.style.setProperty('--hs', hs.toFixed(3));
  }
  function applySettings() {
    hudEl.classList.toggle('nomap', !(S.map & 1));
    hudEl.classList.toggle('nostrip', !(S.map & 2));
    if (!S.feed) feedEl.textContent = '';
    resize();
  }
  function set(key, v) {
    S[key] = v;
    try { localStorage.setItem(SET_KEY, JSON.stringify(S)); } catch { /* storage blocked */ }
    applySettings();
  }

  // ---------- sectors: the canyon entry and exit and the arch split the lap in four ----------
  function sectorLines() {
    let a = 0, b = 0;
    for (let i = 0; i < TR.N; i++) if (TR.canyon[i] > 0.5) { a = TR.s[i]; break; }
    for (let i = TR.N - 1; i >= 0; i--) if (TR.canyon[i] > 0.5) { b = TR.s[i + 1]; break; }
    const c = archS();
    if (!(a > 0 && b > a && c > b && c < L)) return [L * 0.2861, L * 0.4768, L * 0.7076];
    return [a, b, c];
  }
  const SECT_NAMES = ['SZIKLATŰK', 'KANYON', 'DŰNÉK', 'SZIKLAÍV'];
  let lines = sectorLines();

  // ---------- static DOM ----------
  const towerEl = $('tower'), stripEl = $('strip'), feedEl = $('feed'), tagsEl = $('tags'), sectorsEl = $('sectors');
  const speedBox = $('speedBox'), heatArc = $('heatArc'), boostTag = $('boostTag'), draftTag = $('draftTag');
  const lightsEl = $('lights'), meterEl = $('meter'), splitEl = $('split');
  const lamps = [...lightsEl.querySelectorAll('.lamp')];
  // the heat arc: 220 degrees over the speed, the red zone from 80
  const arc = (() => {
    let d = '';
    for (let i = 0; i <= 72; i++) { const a = (200 - 220 * i / 72) * Math.PI / 180; d += (i ? ' L' : 'M') + (170 + 140 * Math.cos(a)).toFixed(1) + ' ' + (165 - 140 * Math.sin(a)).toFixed(1); }
    return d;
  })();
  for (const id of ['heatUnd', 'heatTrk', 'heatRed', 'heatArc']) $(id).setAttribute('d', arc);
  {
    const a = 24 * Math.PI / 180, t = $('heatTick');
    t.setAttribute('x1', (170 + 127 * Math.cos(a)).toFixed(1)); t.setAttribute('y1', (165 - 127 * Math.sin(a)).toFixed(1));
    t.setAttribute('x2', (170 + 153 * Math.cos(a)).toFixed(1)); t.setAttribute('y2', (165 - 153 * Math.sin(a)).toFixed(1));
  }
  sectorsEl.innerHTML = SECT_NAMES.map((n) => `<div class="s"><i></i><span>${n}</span></div>`).join('');
  const sectorEls = [...sectorsEl.children];
  $('meterWin').style.width = (0.5 / 3.2 * 100).toFixed(1) + '%';
  const W_STRIP = 720;
  function buildStrip() {
    let h = '<div class="ln"></div><div class="pr"></div><span class="fin"></span>';
    const cut = [0, ...lines, L];
    for (let k = 0; k < 4; k++) {
      if (k) h += `<i class="tk" style="left:${(cut[k] / L * 100).toFixed(2)}%"></i>`;
      h += `<span class="sl" style="left:${((cut[k] + cut[k + 1]) / 2 / L * 100).toFixed(2)}%">${SECT_NAMES[k]}</span>`;
    }
    stripEl.innerHTML = h + '<span class="lapn"><small>KÖR</small><b></b></span>';
  }
  buildStrip();

  // ---------- per-race state ----------
  let P = [];                // per racer (by r.n)
  let shown = [], cand = null, candT = 0;
  let fastest = { t: Infinity, n: -1 };
  let ref = null, raceBest = null;      // the reference lap for the delta: this race's best, else the stored best lap
  let cur = null, curLap = -1, secDone = 0, secT = [0, 0, 0, 0], secState = ['', '', '', ''];
  let leadT = -99, splitT = 0, feedItems = [], tabHeld = false, histT = 0, hist = [], myLapEnds = [];
  let laps = 3, mp = false, now = 0;
  const cache = {};
  const setHTML = (el, key, v) => { if (cache[key] !== v) { cache[key] = v; el.innerHTML = v; } };
  const setText = (el, key, v) => { if (cache[key] !== v) { cache[key] = v; el.textContent = v; } };

  function loadPB() {
    try {
      const o = JSON.parse(localStorage.getItem('homokfutam:pbtrace') || 'null');
      if (o && o.step === STEP && Math.abs(o.L - L) < 1 && Array.isArray(o.t)) return { lap: o.lap, t: Float32Array.from(o.t, (v) => v / 100), n: o.t.length };
    } catch { /* storage blocked */ }
    return null;
  }
  function savePB(tr) {
    try { localStorage.setItem('homokfutam:pbtrace', JSON.stringify({ step: STEP, L: Math.round(L), lap: tr.lap, t: Array.from(tr.t.subarray(0, tr.n), (v) => Math.round(v * 100)) })); } catch { /* storage blocked */ }
  }

  function reset(racers, o) {
    laps = o.laps; mp = o.mp;
    lines = sectorLines(); buildStrip();
    const cap = Math.ceil((laps * L + 400) / STEP);
    P = racers.map((r) => ({ tr: new Float32Array(cap), next: 0, p0: r.prog, t0: 0, laps: [], rank: 0, chg: 0, chgT: -9, gaps: [], tag: P[r.n]?.tag || null }));
    shown = []; cand = null; candT = 0;
    fastest = { t: Infinity, n: -1 };
    raceBest = null; ref = loadPB();
    cur = { t: new Float32Array(Math.ceil(L / STEP) + 2), n: 0, lap: 0 }; curLap = -1; secDone = 0; secT = [0, 0, 0, 0]; secState = ['', '', '', ''];
    splitT = 0; splitEl.hidden = true;
    feedItems = []; feedEl.textContent = '';
    hist = []; histT = 0; myLapEnds = [];
    for (const p of P) if (p.tag) p.tag.el.hidden = true;
    for (const c of clusters) c.el.hidden = true;
    for (const k in cache) delete cache[k];
    $('deltaVal').hidden = true;
  }

  // ---------- traces: the race time at every STEP metres of each pod's progress ----------
  function trace(r, t) {
    const p = P[r.n], x = r.prog;
    if (x > p.p0) {
      while (p.next < p.tr.length && p.next * STEP <= x) {
        const m = p.next * STEP;
        p.tr[p.next++] = m <= p.p0 ? t : p.t0 + (t - p.t0) * (m - p.p0) / (x - p.p0);
      }
    }
    p.p0 = x; p.t0 = t;
  }
  function timeAt(p, d) {
    if (d < 0) return null;
    const i = d / STEP, i0 = Math.floor(i);
    if (i0 + 1 >= p.next) return null;
    return p.tr[i0] + (p.tr[i0 + 1] - p.tr[i0]) * (i - i0);
  }
  // seconds between pod r and me: + when r is ahead (how long ago r was where I am now)
  function gapOf(r, me, t) {
    if (r === me) return 0;
    if (r.prog >= me.prog) { const a = timeAt(P[r.n], me.prog); return a == null ? null : t - a; }
    const a = timeAt(P[me.n], r.prog); return a == null ? null : -(t - a);
  }
  const lapsOf = (r) => (r.lapTimes && r.lapTimes.length ? r.lapTimes : P[r.n]?.laps || []);
  const nameOf = (r) => (r.player ? 'TE' : up(r.name));

  // ---------- event feed ----------
  // key: a newer message about the same thing replaces the last one (two pods swapping places side by side)
  function feed(kind, html, key = '') {
    if (!S.feed) return;
    if (key && feedItems[0]?.key === key && now - feedItems[0].t < 5) feedItems.shift().el.remove();
    const el = document.createElement('div');
    el.className = 'fe ' + kind;
    el.innerHTML = `<i>${ICON[kind] || '•'}</i><span>${html}</span>`;
    feedEl.prepend(el);
    feedItems.unshift({ el, t: now, key });
    while (feedItems.length > 4) feedItems.pop().el.remove();
  }
  function tickFeed() {
    for (let k = feedItems.length - 1; k >= 0; k--) {
      const it = feedItems[k], age = now - it.t;
      if (age > 6.6) { it.el.remove(); feedItems.splice(k, 1); } else if (age > 6) it.el.classList.add('old');
    }
  }

  // ---------- standings: a new order counts once it has held for a moment (no flicker side by side) ----------
  const same = (a, b) => a.length === b.length && a.every((r, k) => r === b[k]);
  function commitRanks(ranks, me, dt, t) {
    if (shown.length !== ranks.length) { shown = ranks.slice(); shown.forEach((r, k) => (P[r.n].rank = k)); return; }
    if (same(ranks, shown)) { cand = null; return; }
    if (!cand || !same(ranks, cand)) { cand = ranks.slice(); candT = 0; return; }
    if ((candT += dt) < 0.35) return;
    const before = [], lead0 = shown[0];
    shown.forEach((r, k) => (before[r.n] = k));
    shown = cand; cand = null;
    shown.forEach((r, k) => {
      const p = P[r.n], d = before[r.n] - k;
      if (d && !r.gone) { p.chg = d; p.chgT = now; }
      p.rank = k;
    });
    if (t < 3) return;                                         // the start shuffle is not news
    const mi = shown.indexOf(me), mb = before[me.n], lead1 = shown[0];
    if (lead1 !== lead0 && !lead1.gone && now - leadT > 8) {
      leadT = now;
      if (lead1 === me) { feed('lead', 'ÁTVETTED A VEZETÉST'); return; }
      feed('lead', `<b>${esc(nameOf(lead1))}</b> ÁTVETTE A VEZETÉST`);
    }
    if (mi < mb) {
      for (const r of shown.slice(mi + 1)) if (!r.gone && before[r.n] < mb) feed('pass', `MEGELŐZTED: <b>${esc(nameOf(r))}</b>`, 'pos' + r.n);
    } else if (mi > mb) {
      for (const r of shown.slice(0, mi)) if (!r.gone && !r.finished && before[r.n] > mb) feed('lost', `<b>${esc(nameOf(r))}</b> MEGELŐZÖTT`, 'pos' + r.n);
    }
  }

  // ---------- my lap: the sector splits and the delta to the reference lap ----------
  const refAt = (d) => {
    if (!ref) return null;
    const i = d / STEP, i0 = Math.floor(i);
    if (i0 + 1 >= ref.n) return d >= L - STEP ? ref.lap : null;
    return ref.t[i0] + (ref.t[i0 + 1] - ref.t[i0]) * (i - i0);
  };
  const curAt = (d) => {
    const i = d / STEP, i0 = Math.floor(i);
    if (i0 + 1 >= cur.n) return null;
    return cur.t[i0] + (cur.t[i0 + 1] - cur.t[i0]) * (i - i0);
  };
  function popup(name, val, cls, sub) {
    splitEl.className = cls; splitT = 2.4; splitEl.hidden = false;
    $('splitName').textContent = name; $('splitVal').textContent = val; $('splitSub').textContent = sub;
  }
  function sector(k, t) {
    const ts = t - (k ? secT[k - 1] : 0);
    secT[k] = t;
    const r1 = refAt(k < 3 ? lines[k] : L), r0 = k ? refAt(lines[k - 1]) : 0;
    if (r1 != null && r0 != null) {
      const good = ts <= r1 - r0;
      secState[k] = good ? 'good' : 'slow';
      popup(SECT_NAMES[k], fmtDelta(t - r1), good ? 'good' : 'slow', 'A LEGJOBB KÖRÖDHÖZ');
    } else {
      secState[k] = 'done';
      popup(SECT_NAMES[k], fmtTime(ts).replace(/^0:/, ''), '', 'SZEKTORIDŐ');
    }
  }
  function myLap(me, t, solo) {
    // a lap just ended: the last sector, then this lap may become the reference
    if (me.lapTimes.length > cur.lap) {
      const lt = me.lapTimes[me.lapTimes.length - 1];
      if (curLap >= 0) {
        if (cur.n < cur.t.length) cur.t[cur.n++] = lt;
        for (let k = secDone; k < 3; k++) sector(k, curAt(lines[k]) ?? lt);
        sector(3, lt);
        const lapTrace = { lap: lt, t: cur.t.slice(0, cur.n), n: cur.n };
        if (!raceBest || lt < raceBest.lap) raceBest = lapTrace;
        if (solo) { const pb = loadPB(); if (!pb || lt < pb.lap) savePB(lapTrace); }   // records count in solo races only
        if (!ref || raceBest.lap <= ref.lap) ref = raceBest;                           // the better of your best and this race's
        myLapEnds.push(t);
      }
      cur.lap = me.lapTimes.length; cur.n = 0; curLap = -1; secDone = 0;
    }
    if (me.finished || me.lap < 0 || me.lap !== me.lapTimes.length) return;
    // the lap being timed: record it, close the sectors as their lines go by
    if (curLap !== me.lap) { curLap = me.lap; cur.n = 0; secDone = 0; secState = ['', '', '', '']; }
    const s = me.prog - me.lap * L, lt = t - me.lapStart;
    while (cur.n < cur.t.length && cur.n * STEP <= s) cur.t[cur.n++] = lt;
    while (secDone < 3 && s >= lines[secDone]) { sector(secDone, curAt(lines[secDone]) ?? lt); secDone++; }
    const r = s > 30 ? refAt(s) : null;
    const dv = $('deltaVal');
    if (r == null) { dv.hidden = true; return; }
    const d = lt - r;
    dv.hidden = false;
    setText(dv, 'delta', fmtDelta(d));
    dv.className = 'delta num ' + (d <= 0 ? 'good' : 'slow');
  }
  function drawSectors(me) {
    const s = me.lap >= 0 ? me.prog - me.lap * L : 0, cut = [0, ...lines, L];
    for (let k = 0; k < 4; k++) {
      const el = sectorEls[k];
      let cls = 's ' + (secState[k] || ''), p = '';
      if (!secState[k] && k === secDone && me.lap >= 0 && !me.finished) { cls = 's now'; p = clamp((s - cut[k]) / (cut[k + 1] - cut[k]) * 100, 0, 100).toFixed(0) + '%'; }
      if (el.className !== cls) el.className = cls;
      if (cls === 's now') el.style.setProperty('--p', p); else el.style.removeProperty('--p');
    }
  }

  // ---------- the standings list ----------
  function towerHTML(me, t, full) {
    const mi = shown.indexOf(me);
    let keep = null;
    if (!full) {
      keep = new Set([0, mi - 1, mi, mi + 1]);
      if (mp) shown.forEach((r, k) => { if (r.owner) keep.add(k); });
    }
    let h = '', last = -1;
    shown.forEach((r, k) => {
      if (keep && !keep.has(k)) return;
      if (last >= 0 && k - last > 1) h += '<div class="tsep">···</div>';
      last = k;
      const p = P[r.n], isMe = r === me;
      let g = '';
      if (r.gone) g = 'KIESETT';
      else if (r.finished) g = 'CÉLBAN';
      else if (!isMe) {
        const dl = Math.trunc((r.prog - me.prog) / L);
        if (dl) g = (dl > 0 ? '+' : MINUS) + Math.abs(dl) + ' KÖR';
        else { const v = gapOf(r, me, t); if (v != null) g = fmtGap(v); }
      }
      const chg = now - p.chgT < 3 && p.chg ? `<span class="c ${p.chg > 0 ? 'up' : 'dn'}">${p.chg > 0 ? '▲' : '▼'}${Math.abs(p.chg)}</span>` : '<span></span>';
      const bot = mp && !r.owner;
      const cls = `trw${isMe ? ' me' : ''}${bot ? ' bot' : ''}${r.gone ? ' gone' : ''}${r.finished ? ' fin' : ''}`;
      h += `<div class="${cls}"><span class="p">${k + 1}</span><i style="background:${r.color}"></i><span class="n">${esc(nameOf(r))}${bot ? '<em>BOT</em>' : ''}</span>${chg}<span class="g">${g}</span></div>`;
    });
    if (keep && last < shown.length - 1) h += '<div class="tsep">···</div>';
    return h;
  }

  // ---------- name tags ----------
  const _v = new THREE.Vector3();
  const clusters = [0, 1].map(() => {
    const el = document.createElement('div');
    el.className = 'tag cl'; el.hidden = true;
    el.innerHTML = '<span class="chs"></span><span class="n"></span><span class="d"></span><i class="ld"></i>';
    tagsEl.appendChild(el);
    return { el, chs: el.children[0], n: el.children[1], d: el.children[2], ld: el.children[3] };
  });
  function tagOf(r) {
    const p = P[r.n];
    if (!p.tag) {
      const el = document.createElement('div');
      el.className = 'tag'; el.hidden = true;
      el.innerHTML = '<span class="p"></span><span class="n"></span><span class="d"></span><i class="ld"></i>';
      tagsEl.appendChild(el);
      p.tag = { el, p: el.children[0], n: el.children[1], d: el.children[2], ld: el.children[3], key: '' };
    }
    return p.tag;
  }
  function place(el, x, y, lead) {
    el.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) scale(${hs.toFixed(3)}) translate(-50%,calc(-100% - 11px))`;
    const ld = el.lastElementChild;
    if (lead > 1) { ld.hidden = false; ld.style.height = (lead / hs + 11).toFixed(1) + 'px'; } else ld.hidden = true;
  }
  function drawTags(racers, me, state, live) {
    const used = new Set();
    if (live && S.tags) {
      const W = innerWidth, H = innerHeight, grid = state === 'countdown';
      camera.updateMatrixWorld();
      const cands = [];
      for (const r of racers) {
        if (r === me || r.gone || !r.mesh.visible) continue;
        const d = Math.hypot(r.x - me.x, r.z - me.z), human = mp && !!r.owner;
        const ok = grid ? mp : S.tags === 2 ? d < 600 : d < 160 || (human && d < 600);
        if (!ok) continue;
        _v.set(r.mesh.position.x, r.mesh.position.y + 2.6, r.mesh.position.z).project(camera);
        if (_v.z > 1 || Math.abs(_v.x) > 1.02 || _v.y > 1.02 || _v.y < -1) continue;
        cands.push({ r, d, human, x: (_v.x + 1) / 2 * W, y: (1 - _v.y) / 2 * H, lvl: grid ? 'mid' : d < 50 ? 'close' : d < 120 || human ? 'mid' : 'far' });
      }
      cands.sort((a, b) => a.d - b.d);
      if (S.tags === 1 && !grid) { let n = 0; for (let k = 0; k < cands.length; k++) if (!cands[k].human && ++n > 3) cands.splice(k--, 1); }
      // far pods bunched together on screen become one tag
      const groups = [];
      for (const c of cands) {
        if (c.lvl !== 'far') continue;
        const g = groups.find((q) => Math.abs(q.x - c.x) < 90 * hs && Math.abs(q.y - c.y) < 26 * hs);
        if (g) g.m.push(c); else groups.push({ x: c.x, y: c.y, m: [c] });
      }
      const placed = [];
      const fit = (x, y, w, h) => {
        let y1 = y - 11 * hs;
        for (let k = 0; k < 4; k++) {
          const hit = placed.find((q) => x - w / 2 < q.x1 && x + w / 2 > q.x0 && y1 - h < q.y1 && y1 > q.y0);
          if (!hit) break;
          y1 = hit.y0 - 4;
        }
        placed.push({ x0: x - w / 2, x1: x + w / 2, y0: y1 - h, y1 });
        return y1 + 11 * hs;
      };
      let ci = 0;
      for (const c of cands) {
        const grp = c.lvl === 'far' ? groups.find((g) => g.m.includes(c)) : null;
        if (grp && grp.m.length > 1) {
          if (grp.m[0] !== c || ci >= clusters.length) continue;
          const cl = clusters[ci++], w = (110 + grp.m.length * 9) * hs, h = 30 * hs;
          const ty = fit(grp.x, grp.y, w, h);
          cl.el.hidden = false;
          setHTML(cl.chs, 'cl' + ci + 'c', grp.m.map((m) => `<i style="background:${m.r.color}"></i>`).join(''));
          setText(cl.n, 'cl' + ci + 'n', `${grp.m.length} POD`);
          setText(cl.d, 'cl' + ci + 'd', `${Math.round(c.d)} m`);
          place(cl.el, grp.x, ty, grp.y - ty);
          continue;
        }
        const r = c.r, t = tagOf(r), nm = nameOf(r);
        const cls = `tag ${c.lvl}${c.human ? ' hum' : ''}${mp && !r.owner ? ' bot' : ''}`;
        if (t.el.className !== cls) t.el.className = cls;
        t.el.style.setProperty('--c', r.color);
        const pos = grid ? '' : String(P[r.n].rank + 1);
        if (t.key !== nm + pos) { t.key = nm + pos; t.n.textContent = nm; t.p.textContent = pos; }
        setText(t.d, 'td' + r.n, grid ? `P${P[r.n].rank + 1}` : `${Math.round(c.d)} m`);
        const w = (c.lvl === 'far' ? 40 + nm.length * 8 : 70 + nm.length * 10) * hs, h = (c.lvl === 'far' ? 18 : 30) * hs;
        const ty = fit(c.x, c.y, w, h);
        t.el.hidden = false;
        place(t.el, c.x, ty, c.y - ty);
        used.add(r.n);
      }
      for (let k = ci; k < clusters.length; k++) clusters[k].el.hidden = true;
    } else for (const c of clusters) c.el.hidden = true;
    for (const p of P) if (p.tag && !used.has(P.indexOf(p))) p.tag.el.hidden = true;
  }

  // ---------- a pod closing in from behind, where the chase camera can't show it ----------
  const nearSide = { left: { el: $('nearL'), lab: $('nearLl'), n: -1 }, right: { el: $('nearR'), lab: $('nearRl'), n: -1 } };
  const rgba = (h, a) => { const n = parseInt(h.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
  function drawNear(racers, me, t, live) {
    const best = { left: null, right: null };
    if (live && S.near && t > 3) {
      for (const r of racers) {
        if (r === me || r.gone || r.prog > me.prog + 4) continue;
        const d = Math.hypot(r.x - me.x, r.z - me.z);
        if (d > 30) continue;
        _v.copy(r.mesh.position).project(camera);
        if (_v.z < 1 && Math.abs(_v.x) < 0.95 && Math.abs(_v.y) < 0.95) continue;   // on screen: you can see it
        _v.copy(r.mesh.position).applyMatrix4(camera.matrixWorldInverse);
        const side = _v.x < 0 ? 'left' : 'right';
        if (!best[side] || d < best[side].d) best[side] = { r, d };
      }
    }
    for (const side of ['left', 'right']) {
      const o = nearSide[side], b = best[side];
      if (!b) { o.el.classList.remove('on'); o.el.style.opacity = ''; o.lab.classList.remove('on'); continue; }
      const k = clamp(1 - (b.d - 8) / 22, 0.25, 1);
      if (o.n !== b.r.n) {
        o.n = b.r.n;
        const at = side === 'left' ? '0%' : '100%';
        o.el.style.background = `radial-gradient(ellipse 100% 50% at ${at} 55%, ${rgba(b.r.color, 0.62)}, ${rgba(b.r.color, 0)} 74%)`;
        o.lab.style.setProperty('--c', b.r.color);
      }
      o.el.classList.add('on'); o.el.style.opacity = k.toFixed(2);
      o.lab.classList.add('on');
      const g = gapOf(b.r, me, t);
      setHTML(o.lab, 'near' + side, side === 'left'
        ? `<i>◀</i>${esc(nameOf(b.r))} <b>${g == null ? '' : Math.abs(g).toFixed(1)}</b>`
        : `${esc(nameOf(b.r))} <b>${g == null ? '' : Math.abs(g).toFixed(1)}</b><i>▶</i>`);
    }
  }

  // ---------- the pods ahead and behind, next to the speed ----------
  function battle(el, key, r, me, t, label, sign) {
    if (!r) { el.hidden = true; return; }
    const g = gapOf(r, me, t);
    if (g == null) { el.hidden = true; return; }
    const p = P[r.n];
    // is the gap closing? (compared with a second ago)
    if (!p.gaps.length || now - p.gaps[p.gaps.length - 1].t > 0.25) { p.gaps.push({ t: now, g }); if (p.gaps.length > 6) p.gaps.shift(); }
    const old = p.gaps[0], closing = now - old.t > 0.7 && Math.abs(g) < Math.abs(old.g) - 0.03;
    el.hidden = false;
    el.style.setProperty('--c', r.color);
    const cls = closing ? (sign > 0 ? 'good' : 'warn') : '';
    const dl = Math.trunc((r.prog - me.prog) / L);           // a lap or more between us: say so
    const txt = dl ? (dl > 0 ? '+' : MINUS) + Math.abs(dl) + ' KÖR' : fmtGap(g);
    setHTML(el, key, `<span class="lbl">${label}</span><span class="nm"><i></i>${esc(nameOf(r))}</span><b class="${dl ? '' : cls}">${txt}</b>`);
  }

  // ---------- once a frame ----------
  function update(f) {
    const { racers, player: me, raceT: t, state, dt } = f;
    now += dt;
    const racing = state === 'race' || state === 'finished';
    if (racing && !f.paused) {
      for (const r of racers) if (!r.gone) trace(r, t);
      // laps of every pod from its trace (the other players' lap times are not sent over the network)
      for (const r of racers) {
        const p = P[r.n];
        while (p.laps.length < laps) {
          const k = p.laps.length, end = timeAt(p, (k + 1) * L);
          if (end == null) break;
          const lt = end - (k ? timeAt(p, k * L) ?? 0 : 0);
          p.laps.push(lt);
          const real = r.lapTimes && r.lapTimes[k] != null ? r.lapTimes[k] : lt;
          if (real < fastest.t) {
            const first = fastest.n < 0;
            fastest = { t: real, n: r.n };
            if (!first) feed('fast', r === me ? `LEGGYORSABB KÖR: <b>TE</b> · ${fmtTime(real)}` : `<b>${esc(nameOf(r))}</b> · LEGGYORSABB KÖR ${fmtTime(real)}`);
          }
        }
      }
      if ((histT -= dt) <= 0) { histT = 1; hist.push({ t, ranks: shown.map((r) => (r.gone ? null : r.n)) }); }
    }
    commitRanks(f.ranks, me, racing ? dt : 0, t);
    if (racing && !f.paused) myLap(me, t, !mp);
    tickFeed();

    // position and standings
    const mi = Math.max(0, shown.indexOf(me));
    setHTML($('posBig'), 'pos', `${mi + 1}<small>/${racers.length}</small>`);
    setHTML(towerEl, 'tower', towerHTML(me, t, S.tower === 1 || tabHeld));
    if (f.pauseOpen) setHTML($('pauseTower'), 'ptower', towerHTML(me, t, true));
    drawSectors(me);

    // the lap strip
    if (S.map & 2) {
      const dots = stripEl.querySelectorAll('.dt');
      if (dots.length !== racers.length) {
        stripEl.querySelectorAll('.dt, .mel').forEach((e) => e.remove());
        for (const r of [...racers].sort((a, b) => a.player - b.player)) {
          const d = document.createElement('i');
          d.className = 'dt' + (r.player ? ' me' : ''); d.dataset.n = r.n; d.style.background = r.color;
          stripEl.appendChild(d);
          if (r.player) { const m = document.createElement('span'); m.className = 'mel'; m.textContent = 'TE'; m.dataset.n = r.n; stripEl.appendChild(m); }
        }
      }
      const frac = (r) => (r.finished ? 1 : r.prog <= 0 ? 0 : (r.prog % L) / L);
      for (const d of stripEl.querySelectorAll('.dt, .mel')) {
        const r = racers[+d.dataset.n];
        d.hidden = r.gone;
        if (d.classList.contains('dt')) {
          const cls = 'dt' + (r === me ? ' me' : '') + (mp && r.owner && r !== me ? ' hum' : '');
          if (d.className !== cls) d.className = cls;
          if (d.dataset.c !== r.color) { d.dataset.c = r.color; d.style.background = r.color; }
        } else d.hidden = r !== me;
        d.style.transform = `translateX(${(frac(r) * W_STRIP).toFixed(1)}px)`;
      }
      stripEl.querySelector('.pr').style.width = (frac(me) * 100).toFixed(2) + '%';
      setText(stripEl.querySelector('.lapn b'), 'slap', `${clamp(me.lap + 1, 1, laps)}/${laps}`);
    }

    // speed and heat
    setText($('speedVal'), 'spd', String(Math.round(Math.abs(me.fwd) * 3.6)));
    const over = me.overheat > 0, warn = !over && me.boosting && me.heat > 80, cool = !over && me.cooling > 0.3;
    const sc = 'hud-speed' + (over ? ' over' : warn ? ' warn' : cool ? ' cool' : '');
    if (speedBox.className !== sc) {
      speedBox.className = sc;
      const g = cool ? ['#8fd0ff', '#c86bff'] : warn ? ['#ff7b2e', '#ff5a4a'] : over ? ['#ff5a4a', '#ff5a4a'] : ['#c86bff', '#ff7b2e'];
      $('heatG0').setAttribute('stop-color', g[0]); $('heatG1').setAttribute('stop-color', g[1]);
    }
    const hv = clamp(me.heat, 0, 100);
    if (Math.abs((cache.heat ?? -9) - hv) > 0.3) { cache.heat = hv; heatArc.setAttribute('stroke-dasharray', `${hv.toFixed(1)} 100`); heatArc.style.visibility = hv < 0.5 ? 'hidden' : ''; }
    setText($('heatVal'), 'hv', String(Math.round(hv)));
    const bt = over ? `HŰL ${me.overheat.toFixed(1)}` : cool ? 'HŰT' : 'BOOST';
    setText(boostTag, 'bt', bt);
    const bc = 'chip' + (over ? ' off' : cool ? ' cool' : me.boosting ? ' on' : '');
    if (boostTag.className !== bc) boostTag.className = bc;
    draftTag.hidden = !(racing && me.draft > 0.35 && !me.finished);

    // the fight for position (while racing; not in the finish orbit)
    const live = racing && !me.finished && !f.cine;
    battle($('batAhead'), 'bA', live ? shown.slice(0, mi).reverse().find((r) => !r.gone && !r.finished) : null, me, t, 'Előtted', 1);
    battle($('batBehind'), 'bB', live ? shown.slice(mi + 1).find((r) => !r.gone) : null, me, t, 'Mögötted', -1);
    if (!live) { $('batAhead').hidden = true; $('batBehind').hidden = true; }
    drawTags(racers, me, state, (live || (state === 'countdown' && !f.intro)) && !f.cine);
    drawNear(racers, me, t, live);

    // the start lights and the perfect-start window
    if (state === 'countdown' && !f.intro) {
      lightsEl.hidden = false; meterEl.hidden = false;
      const c = Math.ceil(f.countT), lit = f.countT > 3 ? 0 : c === 3 ? 2 : c === 2 ? 4 : 5;
      lamps.forEach((l, k) => { const cls = 'lamp' + (k < lit ? ' on' : ''); if (l.className !== cls) l.className = cls; });
      setText($('lightsDigit'), 'ld', c >= 1 && c <= 3 ? String(c) : '');
      $('meterFill').style.width = (clamp((3.2 - f.countT) / 3.2, 0, 1) * 100).toFixed(1) + '%';
      const hit = $('meterHit');
      hit.hidden = !(f.throttleAt > 0);
      if (f.throttleAt > 0) hit.style.left = (clamp((3.2 - f.throttleAt) / 3.2, 0, 1) * 100).toFixed(1) + '%';
      meterEl.classList.toggle('good', f.throttleAt > 0 && f.throttleAt < 0.5);
    } else if (racing && t < 1.2) {
      lightsEl.hidden = false;
      lamps.forEach((l) => { if (l.className !== 'lamp go') l.className = 'lamp go'; });
      setText($('lightsDigit'), 'ld', '');
      $('meterFill').style.width = '100%';
      meterEl.hidden = !(f.throttleAt > 0);
    } else { lightsEl.hidden = true; meterEl.hidden = true; }

    if (splitT > 0 && (splitT -= dt) <= 0) splitEl.hidden = true;
  }

  // big crashes of the pods around you (two places either way) and of the other players; not in the start scramble
  function crash(r, me, t) {
    if (r === me || r.gone || t < 5) return;
    const d = Math.abs(shown.indexOf(r) - shown.indexOf(me));
    if (d > 2 && !(mp && r.owner)) return;
    const p = P[r.n];
    if (now - (p.crashT ?? -99) < 10) return;
    p.crashT = now;
    feed('crash', `<b>${esc(nameOf(r))}</b> NAGYOT ÜTKÖZÖTT`);
  }

  // the positions over the race, for the results (one sample a second)
  function chartSVG(racers, me) {
    if (hist.length < 3) return '';
    const T = hist[hist.length - 1].t || 1, n = racers.length;
    const x0 = 34, x1 = 470, y0 = 30, dy = 46, X = (t) => x0 + (x1 - x0) * t / T, Y = (p) => y0 + p * dy;
    let g = '';
    for (let p = 0; p < n; p++) g += `<line x1="${x0}" x2="${x1}" y1="${Y(p)}" y2="${Y(p)}" stroke="rgba(242,228,201,.1)"/><text x="${x0 - 14}" y="${Y(p) + 5}" fill="#9a8466" font-size="14" text-anchor="end">${p + 1}</text>`;
    const marks = [0, ...myLapEnds.filter((t) => t < T), T];
    for (let k = 1; k < marks.length - 1; k++) g += `<line x1="${X(marks[k])}" x2="${X(marks[k])}" y1="${y0 - 14}" y2="${Y(n - 1) + 10}" stroke="rgba(242,228,201,.28)" stroke-dasharray="3 4"/>`;
    for (let k = 0; k < marks.length - 1; k++) if (X(marks[k + 1]) - X(marks[k]) > 40) g += `<text x="${(X(marks[k]) + X(marks[k + 1])) / 2}" y="${y0 - 16}" fill="#c4ad8b" font-size="12.5" letter-spacing="2.5" text-anchor="middle">${k + 1}. KÖR</text>`;
    const order = [...racers].sort((a, b) => (a === me) - (b === me));
    for (const r of order) {
      const pts = [];
      let lastT = 0, lastP = 0;
      for (const h of hist) { const p = h.ranks.indexOf(r.n); if (p < 0) break; pts.push(`${X(h.t).toFixed(1)},${Y(p).toFixed(1)}`); lastT = h.t; lastP = p; }
      if (pts.length < 2) continue;
      const isMe = r === me, lx = X(lastT), ly = Y(lastP);
      g += `<polyline points="${pts.join(' ')}" fill="none" stroke="${r.color}" stroke-width="${isMe ? 5 : 2.6}" stroke-linejoin="round" stroke-linecap="round" opacity="${isMe ? 1 : 0.85}"/>`;
      g += `<circle cx="${lx}" cy="${ly}" r="${isMe ? 6 : 4}" fill="${r.color}" stroke="#1b140e" stroke-width="2"/>`;
      g += r.gone ? `<text x="${lx + 10}" y="${ly + 5}" fill="#ff5a4a" font-size="13" letter-spacing="1.5">KIESETT</text>`
        : `<text x="${x1 + 14}" y="${ly + 5}" fill="${isMe ? '#ff7b2e' : '#f2e4c9'}" font-size="15" letter-spacing="1">${esc(nameOf(r))}</text>`;
    }
    return `<svg viewBox="0 0 572 ${Y(n - 1) + 20}" aria-label="Helyezés a futam alatt">${g}</svg>`;
  }

  addEventListener('resize', resize);
  applySettings();
  return {
    S, set, reset, update, crash, chartSVG, lapsOf,
    feed: (kind, html) => feed(kind, html),
    rankOf: (r) => shown.indexOf(r),
    get fastest() { return fastest; },
    setTab(v) { tabHeld = v; },
  };
}
