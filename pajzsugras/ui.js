// Menus: loading screen, main menu, map cards, settings, controls, pause menu and the solo results screen. Screens are the
// `.screen` containers of index.html (#scr-<id>); the multiplayer (#scr-room) and leaderboard (#scr-lb) ones are filled by
// race.js / leaderboard.js, which hear about it through app.on('screen', id) and get a "hamarosan" placeholder while empty.
import { DIFF_LABEL } from './maps/index.js';
import { QUALITIES, QUALITY_LABEL, cleanName } from './store.js';
import { fmtTime, fmtDelta, MEDAL_NAME } from './hud.js';
import { medalFor, medalTimes } from './sim/world.js';
import { TICK } from './sim/const.js';
import * as leaderboard from './leaderboard.js';

const DIFF_COLOR = { kikepzes: '#4cc9f0', konnyu: '#5af0a0', kozepes: '#ffd24a', nehez: '#ff8a2a', mester: '#ff4fa3' };
const DIFF_LEVEL = { kikepzes: 1, konnyu: 2, kozepes: 3, nehez: 4, mester: 5 };
const SCREENS = ['loading', 'menu', 'play', 'room', 'lb', 'settings', 'controls', 'pause', 'results'];

export const TIPS = [
  'Pajzsugrás: nézz lefelé, tartsd a bal gombot a töltéshez, majd SPACE és a gomb elengedése egyszerre.',
  'Kiugrás: kétszer koppints egy irányra. Utána még jár a dupla ugrás.',
  'A pajzs kb. 1,2 másodperc alatt tölt fel: minél több a töltés, annál nagyobbat lök.',
  'Strafe ugrás: tartsd a SPACE-t, váltogasd az A és D gombot, és húzd az egeret a kanyar felé.',
  'A levegőben, fal mellett is lehet kiugrani: ez a falról kiugrás.',
  'Pajzs a falra a levegőben: a lökés a fal felől elfelé visz, nem csak felfelé.',
  'R: vissza az utolsó ellenőrzőpontra. Enter: újrakezdés. Az óra az első gombnyomásra indul.',
  'A felvonóról ugorj, amíg emelkedik: a sebessége hozzáadódik az ugrásodhoz.',
];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hex = (n) => '#' + (n >>> 0).toString(16).padStart(6, '0');
const $ = (id) => document.getElementById(id);

const LOGO_SVG = `<svg viewBox="0 0 64 64" fill="none" stroke-linejoin="round" stroke-linecap="round"><path d="M32 4 L56 14 V32 C56 46 45 56 32 60 C19 56 8 46 8 32 V14 Z" stroke="#2ee6d4" stroke-width="3.5" fill="rgba(46,230,212,.08)"/><path d="M36 14 L22 34 H31 L27 50 L43 28 H33 Z" fill="#ff8a2a" stroke="#ffb464" stroke-width="1.5"/></svg>`;

const CONTROLS = [
  ['<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>', 'mozgás'],
  ['<kbd>Egér</kbd>', 'körbenézés'],
  ['<kbd>SPACE</kbd>', 'ugrás, a levegőben dupla ugrás (tartva: automatikus bunnyhop, ha be van kapcsolva)'],
  ['2× <kbd>W</kbd> / <kbd>A</kbd> / <kbd>S</kbd> / <kbd>D</kbd>', 'kiugrás az adott irányba'],
  ['<kbd>SHIFT</kbd>', 'nincs funkciója: sprint nincs, mindig teljes sebességgel futsz'],
  ['<kbd>Bal gomb</kbd> nyomva', 'pajzs töltése (kb. 1,2 mp), elengedésre lökés arra, amerre nézel'],
  ['<kbd>R</kbd>', 'vissza az utolsó ellenőrzőpontra'],
  ['<kbd>Enter</kbd>', 'a pálya újrakezdése'],
  ['<kbd>Tab</kbd>', 'eredménytábla (szobában)'],
  ['<kbd>Esc</kbd>', 'szünet menü'],
];
const TECHNIQUES = [
  ['Dupla ugrás', 'A levegőben még egyszer SPACE: kicsit magasabbra visz. Levegőnként egyszer használható, földetéréskor újra megvan. A csúcson a leghatásosabb.'],
  ['Kiugrás', 'Dupla koppintás egy irányra: gyors, alacsony ugrás oldalra, előre vagy hátra. Földetérés után rövid szünet kell a következőhöz. Sprint nincs, mint a UT2004-ben: mindig teljes sebességgel futsz.'],
  ['Kiugró ugrás', 'Kiugrás után a levegőben dupla ugrás: ez viszi a legmesszebbre, a legszélesebb résekhez kell.'],
  ['Falról kiugrás', 'A levegőben, fal közelében kiugrás a faltól elfelé vagy a fal mentén. Légterenként egyszer megy, utána még jár a dupla ugrás.'],
  ['Pajzsugrás', 'Nézz a padlóra, tartsd a bal gombot (töltés), majd SPACE és a gomb elengedése egyszerre. A lökés a töltéstől függ: rövid kattintás kicsi, teljes töltés kb. 6–7 méteres emelkedés.'],
  ['Pajzs + dupla ugrás', 'A pajzsugrás csúcsán még egy dupla ugrás: ez a legmagasabb ugrás a játékban.'],
  ['Fali lökés', 'A levegőben tölts pajzsot, és lőj egy közeli falra: a lökés elfelé visz a faltól. Hátrafelé néző fal előre lök.'],
  ['Pajzs-strafe', 'Futás közben ferdén lefelé lőj: a lökés vízszintes sebességet ad, és a strafe-gyorsulás ráadódik.'],
  ['Strafe ugrás', 'Tartsd a SPACE-t, nyomd W + A / D váltakozva, miközben az egeret mindig a kanyar irányába húzod: így a sebességed 8,8 m/s fölé nő.'],
  ['Bunnyhop', 'Ha földetéréskor azonnal újra ugrasz, nem veszítesz sebességet. Az automatikus ugrás beállítással elég tartani a SPACE-t.'],
  ['Felvonós ugrás', 'Mozgó padlóról ugorj el: a platform sebessége hozzáadódik. Emelkedő felvonóról magasabbra jutsz.'],
  ['Ugrópárna', 'Rálépsz, és a párna célba lő. A levegőben irányíthatod magad, és a dupla ugrás is megvan.'],
];

export class UI {
  constructor(app) {
    this.app = app;
    this.els = {};
    for (const id of SCREENS) this.els[id] = $('scr-' + id);
    this.current = 'loading';
    this.back = 'menu';
    this.tipN = 0;
    this.built = {};
    this.wireGlobal();
    this.buildMenu();
    this.buildControls();
    this.tipTimer = setInterval(() => this.nextTip(), 6500);
    this.nextTip();
  }

  wireGlobal() {
    document.addEventListener('click', (e) => {
      this.app.audio.unlock();
      if (e.target.closest && e.target.closest('.btn,.mbtn,.card')) this.app.audio.click();
    }, true);
    document.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && !this.app.input.enabled) this.escape();
      if ((e.code === 'Enter' || e.code === 'NumpadEnter') && this.current === 'results' && !(e.target && e.target.tagName === 'BUTTON')) { e.preventDefault(); this.app.retry(); }
    });
  }
  escape() {
    const c = this.current;
    if (c === 'play' || c === 'controls' || c === 'room' || c === 'lb') this.app.showScreen('menu');
    else if (c === 'settings') this.app.showScreen(this.back);
    else if (c === 'pause') this.app.resume();
    else if (c === 'results') this.app.showScreen('play');
  }

  // ---------------------------------------------------------------- screens
  show(id) {
    this.current = id;
    if (id) this.app.emit('screen', { id });
    for (const k of SCREENS) {
      const el = this.els[k];
      if (el) el.hidden = k !== id;
    }
    if (id === 'room' || id === 'lb') this.fillExternal(id);
    if (id === 'play') this.buildPlay();
    if (id === 'settings') this.buildSettings();
    const first = id && this.els[id] && this.els[id].querySelector('.mbtn,.card,.btn.primary,.btn');
    if (first && id !== 'results') { try { first.focus({ preventScroll: true }); } catch { /* ignore */ } }
  }

  // #scr-room / #scr-lb belong to wave 3: tell them, and show a placeholder while nothing is there
  fillExternal(id) {
    const el = this.els[id];
    const ph = el.querySelector('[data-ph]');
    if (el.children.length > (ph ? 1 : 0)) { if (ph) ph.remove(); return; }
    if (ph) return;
    const title = id === 'room' ? 'SZOBA' : 'RANGLISTA';
    const msg = id === 'room' ? 'A többjátékos futam hamarosan érkezik: haverokkal együtt futhatod ugyanazt a pályát, élő állással.' : 'A globális ranglista hamarosan érkezik. Addig a saját rekordjaid a pályakártyákon láthatók.';
    el.innerHTML = `<div class="panel center-panel" data-ph="1"><h2 class="h1">${title}</h2><p class="sub">${msg}</p><button class="btn primary" data-act="menu">Vissza</button></div>`;
    el.querySelector('[data-act=menu]').onclick = () => this.app.showScreen('menu');
  }

  loading(p, text) {
    $('load-bar').style.width = Math.round(Math.max(0, Math.min(1, p)) * 100) + '%';
    if (text) $('load-text').textContent = text;
  }
  nextTip() {
    const t = TIPS[this.tipN++ % TIPS.length];
    const a = $('load-tip'), b = this.els.menu && this.els.menu.querySelector('.tipline');
    if (a) a.textContent = 'Tipp: ' + t;
    if (b) b.innerHTML = '<b>Tipp</b> · ' + esc(t);
  }
  toast(msg, ms = 2200) {
    const t = $('toast');
    t.textContent = msg; t.classList.add('on');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => t.classList.remove('on'), ms);
  }

  // ---------------------------------------------------------------- main menu
  buildMenu() {
    this.els.menu.innerHTML = `
      <div class="menu-col">
        <div>
          <div class="logo">${LOGO_SVG}<span class="t">PAJZSUGRÁS</span><span class="s">trükkugrás · pajzsugrás · rekordok</span><span class="slash"></span></div>
          <div class="menu-list">
            <button class="mbtn" data-go="play"><b>Játék</b><span>8 pálya a kiképzéstől a mesterig, saját rekordokkal és szellemmel</span></button>
            <button class="mbtn" data-go="room"><b>Szoba</b><span>futam haverokkal, élő állással</span></button>
            <button class="mbtn" data-go="lb"><b>Ranglista</b><span>a legjobb idők pályánként</span></button>
            <button class="mbtn" data-go="settings"><b>Beállítások</b><span>egér, látómező, hang, grafika</span></button>
            <button class="mbtn" data-go="controls"><b>Irányítás</b><span>billentyűk és minden technika röviden</span></button>
          </div>
        </div>
        <div class="menu-foot tipline"></div>
      </div>
      <div class="vers">v1 · sim ${'1'}</div>`;
    for (const b of this.els.menu.querySelectorAll('[data-go]')) {
      b.onclick = () => { const id = b.dataset.go; if (id === 'settings') this.back = 'menu'; this.app.showScreen(id); };
    }
  }

  // ---------------------------------------------------------------- map select
  buildPlay() {
    const app = this.app;
    const cards = app.maps.list.map((entry, i) => {
      const m = entry.meta, id = m.id, th = m.theme, sky = th.sky, pal = th.palette;
      const medals = medalTimes(m.authorTime);
      const hash = app.mapHashOf(id);
      const pb = app.store.getPB(id, hash);
      const t = pb ? pb.ticks / TICK : null, medal = t != null ? medalFor(t, medals) : null;
      const dc = DIFF_COLOR[m.diff] || '#fff', lvl = DIFF_LEVEL[m.diff] || 1;
      const art = `background: radial-gradient(circle at 78% 70%, ${hex(pal.glow)}66, transparent 55%), radial-gradient(circle at 18% 90%, ${hex(pal.accent)}55, transparent 50%), linear-gradient(180deg, ${hex(sky.top)} 0%, ${hex(sky.horizon)} 64%, ${hex(sky.bottom)} 100%)`;
      const coin = (k) => `<span class="coin m-${k}"></span>`;
      return `
        <button class="card" data-map="${esc(id)}" style="--dc:${dc};animation-delay:${i * 45}ms">
          <div class="art" style="${art}">
            <span class="chip">${DIFF_LABEL[m.diff] || m.diff}</span>
            <span class="no">${String(m.order).padStart(2, '0')}</span>
            <span class="ico">${[1, 2, 3, 4, 5].map((n) => `<i class="${n <= lvl ? 'on' : ''}"></i>`).join('')}</span>
          </div>
          <div class="cbody">
            <h3>${esc(m.name)}</h3>
            <p>${esc(m.blurb)}</p>
            <div class="stat"><span class="k">Saját rekord</span><span class="v">${t != null ? fmtTime(t) : '–'} ${medal ? coin(medal) : '<span class="coin none"></span>'}</span></div>
            <div class="stat"><span class="k">Globális #1</span><span class="v" id="top1-${esc(id)}">–</span></div>
            <div class="targets"><span>${coin('author')}${fmtTime(medals.author, 1)}</span><span>${coin('gold')}${fmtTime(medals.gold, 1)}</span><span>${coin('silver')}${fmtTime(medals.silver, 1)}</span><span>${coin('bronze')}${fmtTime(medals.bronze, 1)}</span></div>
          </div>
        </button>`;
    }).join('');
    const earned = app.maps.list.filter((e) => { const pb = app.store.getPB(e.meta.id, app.mapHashOf(e.meta.id)); return pb; }).length;
    this.els.play.innerHTML = `
      <div class="top"><button class="btn ghost" data-act="back">‹ Vissza</button><h2 class="h1">Pályák</h2><p class="sub">Mind elérhető, válassz kedvedre. Teljesítve: ${earned}/${app.maps.list.length}</p></div>
      <div class="scroll"><div class="cards">${cards}</div></div>`;
    this.els.play.querySelector('[data-act=back]').onclick = () => app.showScreen('menu');
    for (const c of this.els.play.querySelectorAll('.card')) c.onclick = () => app.startSolo(c.dataset.map);
    for (const e of app.maps.list) {
      const id = e.meta.id;
      Promise.resolve().then(() => leaderboard.top1(id)).then((r) => {
        const el = $('top1-' + id);
        if (el && r && Number.isFinite(r.time)) el.textContent = fmtTime(r.time) + (r.name ? ' · ' + r.name : '');
      }).catch(() => {});
    }
  }

  // ---------------------------------------------------------------- settings
  buildSettings() {
    const app = this.app, s = app.settings;
    const range = (key, label, hint, min, max, step, fmt) => `
      <div class="field"><div><label for="s-${key}">${label}</label>${hint ? `<small>${hint}</small>` : ''}</div><input id="s-${key}" type="range" min="${min}" max="${max}" step="${step}" value="${s[key]}" data-key="${key}"><span class="val" id="v-${key}">${fmt(s[key])}</span></div>`;
    const toggle = (key, label, hint) => `
      <div class="field"><div><label for="s-${key}">${label}</label>${hint ? `<small>${hint}</small>` : ''}</div><span></span><span class="sw"><input id="s-${key}" type="checkbox" data-key="${key}" ${s[key] ? 'checked' : ''}><i></i></span></div>`;
    this.els.settings.innerHTML = `
      <div class="top"><button class="btn ghost" data-act="back">‹ Vissza</button><h2 class="h1">Beállítások</h2></div>
      <div class="scroll"><div class="form panel">
        <div class="sec"><h3 class="h2">Játékos</h3>
          <div class="field"><div><label for="s-name">Név</label><small>Szobában és a ranglistán ez látszik (legfeljebb 16 karakter).</small></div><input id="s-name" type="text" maxlength="16" value="${esc(s.name)}" autocomplete="off" spellcheck="false"><span></span></div>
        </div>
        <div class="sec"><h3 class="h2">Irányítás</h3>
          ${range('sens', 'Egér érzékenység', '', 0.1, 3, 0.05, (v) => Number(v).toFixed(2).replace('.', ','))}
          ${range('fov', 'Látómező (FOV)', 'Vízszintes, fokban. Alapérték: 100.', 80, 120, 1, (v) => v + '°')}
          ${toggle('autoHop', 'Automatikus ugrás tartott SPACE-re', 'Bunnyhop: földetéréskor azonnal újra ugrik, ha tartod.')}
        </div>
        <div class="sec"><h3 class="h2">Megjelenítés</h3>
          <div class="field"><div><label for="s-quality">Grafika</label><small>Alacsony: gyenge gépekre. Közepes: ajánlott. Magas: árnyékok, élsimítás, nagy felbontás.</small></div><select id="s-quality" data-key="quality">${QUALITIES.map((q) => `<option value="${q}" ${s.quality === q ? 'selected' : ''}>${QUALITY_LABEL[q]}</option>`).join('')}</select><span></span></div>
          ${toggle('keys', 'Billentyű-kijelző', 'A lenyomott gombok a bal alsó sarokban (Defrag stílus).')}
          ${toggle('ghost', 'Saját rekord szelleme', 'Áttetsző futó mutatja a legjobb futásodat.')}
        </div>
        <div class="sec"><h3 class="h2">Hang</h3>
          ${range('volume', 'Hangerő', '', 0, 1, 0.01, (v) => Math.round(v * 100) + '%')}
        </div>
        <div class="row"><button class="btn primary" data-act="back">Kész</button></div>
      </div></div>`;
    for (const b of this.els.settings.querySelectorAll('[data-act=back]')) b.onclick = () => app.showScreen(this.back);
    const name = $('s-name');
    name.oninput = () => app.setSetting('name', name.value.slice(0, 16), true);
    name.onchange = () => { const v = cleanName(name.value); name.value = v; app.setSetting('name', v); };
    for (const inp of this.els.settings.querySelectorAll('[data-key]')) {
      const key = inp.dataset.key;
      const apply = () => {
        let v;
        if (inp.type === 'checkbox') v = inp.checked;
        else if (inp.type === 'range') v = parseFloat(inp.value);
        else v = inp.value;
        app.setSetting(key, v);
        const lab = $('v-' + key);
        if (lab) lab.textContent = key === 'sens' ? Number(v).toFixed(2).replace('.', ',') : key === 'fov' ? v + '°' : key === 'volume' ? Math.round(v * 100) + '%' : v;
      };
      inp.addEventListener(inp.type === 'range' ? 'input' : 'change', apply);
    }
  }

  // ---------------------------------------------------------------- controls
  buildControls() {
    this.els.controls.innerHTML = `
      <div class="top"><button class="btn ghost" data-act="back">‹ Vissza</button><h2 class="h1">Irányítás</h2><p class="sub">Billentyűk és technikák</p></div>
      <div class="scroll"><div class="ctl">
        <div class="panel"><h3 class="h2">Billentyűk</h3><table class="keys">${CONTROLS.map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join('')}</table>
          <p class="sub" style="margin-top:16px">Az óra az első gombnyomásnál indul. Ha leesel, azonnal visszatérsz az utolsó ellenőrzőpontra, az idő közben is fut.</p></div>
        <div class="panel"><h3 class="h2">Technikák</h3>${TECHNIQUES.map((t) => `<div class="tech"><b>${t[0]}</b><p>${t[1]}</p></div>`).join('')}</div>
      </div></div>`;
    this.els.controls.querySelector('[data-act=back]').onclick = () => this.app.showScreen('menu');
  }

  // ---------------------------------------------------------------- pause
  showPause({ mapName, time, hint, canRestart = true } = {}) {
    this.els.pause.innerHTML = `
      <div class="panel center-panel">
        <h2 class="h1">Szünet</h2>
        <p class="sub">${esc(mapName || '')}${time != null ? ' · ' + fmtTime(time) : ''}</p>
        ${hint ? `<p class="sub" style="color:var(--orange-l)">${esc(hint)}</p>` : ''}
        <button class="btn primary" data-act="resume">Folytatás</button>
        ${canRestart ? '<button class="btn" data-act="restart">Újrakezdés</button>' : ''}
        <button class="btn" data-act="settings">Beállítások</button>
        <button class="btn ghost" data-act="exit">Kilépés a menübe</button>
      </div>`;
    const q = (a) => this.els.pause.querySelector(`[data-act=${a}]`);
    q('resume').onclick = () => this.app.resume();
    if (canRestart) q('restart').onclick = () => this.app.retry();
    q('settings').onclick = () => { this.back = 'pause'; this.app.showScreen('settings'); };
    q('exit').onclick = () => this.app.exitToMenu();
    this.show('pause');
  }

  // ---------------------------------------------------------------- results
  // run: { mapId, name, mapName, ticks, splits, labels[], prev (pb before this run | null), isPB, medal, medals, hasNext }
  showResults(run) {
    const t = run.ticks / TICK;
    const prev = run.prev;
    const rows = run.splits.map((s, i) => {
      const p = prev && prev.splits[i] != null ? prev.splits[i] : null;
      const d = p != null ? (s - p) / TICK : null;
      return `<tr><td>${esc(run.labels[i] || 'CP ' + (i + 1))}</td><td>${fmtTime(s / TICK)}</td><td>${p != null ? fmtTime(p / TICK) : '–'}</td><td class="${d == null ? '' : d <= 0 ? 'good' : 'bad'}">${d == null ? '–' : fmtDelta(d)}</td></tr>`;
    });
    const fd = prev ? (run.ticks - prev.ticks) / TICK : null;
    rows.push(`<tr><td><b>CÉL</b></td><td><b>${fmtTime(t)}</b></td><td>${prev ? fmtTime(prev.ticks / TICK) : '–'}</td><td class="${fd == null ? '' : fd <= 0 ? 'good' : 'bad'}">${fd == null ? '–' : fmtDelta(fd)}</td></tr>`);
    const m = run.medals, order = ['author', 'gold', 'silver', 'bronze'];
    const badge = run.medal ? `<div class="medal-big m-${run.medal}">${MEDAL_NAME[run.medal]}</div>` : '<div class="medal-big" style="--c:#47545e;box-shadow:none"><span style="color:#a8b6be">nincs<br>érem</span></div>';
    const medalCol = order.map((k) => `<div class="mrow ${run.medal === k ? 'got' : ''}"><span class="coin m-${k}"></span><span>${MEDAL_NAME[k]}</span><b>${fmtTime(m[k], 1)}</b></div>`).join('');
    this.els.results.innerHTML = `
      <div class="panel results">
        <div class="res-left">
          ${run.isPB ? '<div class="newrec">Új rekord!</div>' : ''}
          <div class="lbl">${esc(run.mapName)} · ${esc(run.name)}</div>
          <div class="bigtime">${fmtTime(t)}</div>
          <div class="sub" style="margin:2px 0 14px">${run.isPB ? (prev ? 'Javítottál ' + fmtTime((prev.ticks - run.ticks) / TICK) + ' másodpercet.' : 'Ez az első teljesített futásod.') : prev ? 'A rekordod: ' + fmtTime(prev.ticks / TICK) : ''}</div>
          <div class="res-medal">${badge}<div class="mcol">${medalCol}</div></div>
          <p class="sub" id="res-note" style="min-height:22px"></p>
          <div class="res-btns">
            <button class="btn primary" data-act="again">Újra</button>
            <button class="btn" data-act="next" ${run.hasNext ? '' : 'disabled'}>Következő pálya</button>
            <button class="btn ghost" data-act="maps">Pályák</button>
          </div>
        </div>
        <div class="res-right"><table class="splits"><thead><tr><th>Ellenőrzőpont</th><th>Idő</th><th>Rekord</th><th>Különbség</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>
      </div>`;
    const q = (a) => this.els.results.querySelector(`[data-act=${a}]`);
    q('again').onclick = () => this.app.retry();
    q('next').onclick = () => this.app.nextMap();
    q('maps').onclick = () => this.app.showScreen('play');
    this.show('results');
  }
  setResultNote(text) { const n = $('res-note'); if (n) n.textContent = text; }
}
