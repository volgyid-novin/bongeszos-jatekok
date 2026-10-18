// Menus: loading screen, main menu, map cards (+ the player's own maps), the editor's map list, settings, controls, pause menu and the solo
// results screen. Screens are the
// `.screen` containers of index.html (#scr-<id>); the multiplayer (#scr-room) and leaderboard (#scr-lb) ones are filled by
// race.js / leaderboard.js, which hear about it through app.on('screen', id) and get a "hamarosan" placeholder while empty.
import { DIFF_LABEL } from './maps/index.js';
import { QUALITIES, QUALITY_LABEL, VIEWS, VIEW_LABEL, CUSTOM_LIMIT, cleanName } from './store.js';
import { fmtTime, fmtDelta, MEDAL_NAME } from './hud.js';
import { medalFor, medalTimes, hasMedals } from './sim/world.js';
import { TICK, SIM_VER } from './sim/const.js';
import * as leaderboard from './leaderboard.js';
import * as lib from './editor/library.js';
import { EDITOR_HELP } from './editor/help.js';

const DIFF_COLOR = { kikepzes: '#4cc9f0', konnyu: '#5af0a0', kozepes: '#ffd24a', nehez: '#ff8a2a', mester: '#ff4fa3', nincs: '#2ee6d4' };
const DIFF_LEVEL = { kikepzes: 1, konnyu: 2, kozepes: 3, nehez: 4, mester: 5, nincs: 0 };
const SCREENS = ['loading', 'menu', 'play', 'edhome', 'room', 'lb', 'settings', 'controls', 'pause', 'results'];

export const TIPS = [
  'Pajzsugrás: nézz lefelé, tartsd a bal gombot a töltéshez, majd SPACE és a gomb elengedése egyszerre.',
  'Kiugrás: kétszer koppints egy irányra. Utána még jár a dupla ugrás.',
  'A pajzs kb. 1,2 másodperc alatt tölt fel: minél több a töltés, annál nagyobbat lök.',
  'Átlós ugrás: tartsd a W-t, koppints kétszer A-ra vagy D-re, és vele egyszerre nyomd a SPACE-t. A dupla ugrás magától jön a csúcson.',
  'A levegőben, fal mellett is lehet kiugrani: ez a falról kiugrás. Utána mindig ugorhatsz még egyet, a dupla ugrást vissza is adja.',
  'Pajzs a falra a levegőben: a lökés a fal felől elfelé visz, nem csak felfelé.',
  'R: vissza az utolsó ellenőrzőpontra. Enter: újrakezdés. Az óra az első gombnyomásra indul.',
  'V: külső nézet. A figurádat hátulról látod, így az ugrásaid alakját is: a kamera nem megy át a falon.',
  'A felvonóról ugorj, amíg emelkedik: a sebessége hozzáadódik az ugrásodhoz.',
];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hex = (n) => '#' + (n >>> 0).toString(16).padStart(6, '0');
const $ = (id) => document.getElementById(id);
const fmtDate = (ms) => {
  if (!ms) return '–';
  try { return new Date(ms).toLocaleString('hu-HU', { dateStyle: 'short', timeStyle: 'short' }); } catch { return new Date(ms).toISOString().slice(0, 16).replace('T', ' '); }
};

const LOGO_SVG = `<svg viewBox="0 0 64 64" fill="none" stroke-linejoin="round" stroke-linecap="round"><path d="M32 4 L56 14 V32 C56 46 45 56 32 60 C19 56 8 46 8 32 V14 Z" stroke="#2ee6d4" stroke-width="3.5" fill="rgba(46,230,212,.08)"/><path d="M36 14 L22 34 H31 L27 50 L43 28 H33 Z" fill="#ff8a2a" stroke="#ffb464" stroke-width="1.5"/></svg>`;

const CONTROLS = [
  ['<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>', 'mozgás'],
  ['<kbd>Egér</kbd>', 'körbenézés'],
  ['<kbd>SPACE</kbd>', 'ugrás, a levegőben dupla ugrás: mindig ugyanakkora és bármikor elsül (a tartott SPACE csak egyszer ugrik: bunnyhop nincs)'],
  ['2× <kbd>W</kbd> / <kbd>A</kbd> / <kbd>S</kbd> / <kbd>D</kbd>', 'kiugrás az adott irányba'],
  ['<kbd>SHIFT</kbd>', 'nincs funkciója: sprint nincs, mindig teljes sebességgel futsz'],
  ['<kbd>Bal gomb</kbd> nyomva', 'pajzs töltése (kb. 1,2 mp), elengedésre lökés arra, amerre nézel'],
  ['<kbd>V</kbd>', 'külső / belső nézet váltása: a figurád hátulról (mint a UT2004 behindview-ja) vagy a saját szemedből (a Beállításokban is megadható)'],
  ['<kbd>R</kbd>', 'vissza az utolsó ellenőrzőpontra'],
  ['<kbd>Enter</kbd>', 'a pálya újrakezdése'],
  ['<kbd>Tab</kbd>', 'eredménytábla (szobában)'],
  ['<kbd>Esc</kbd>', 'szünet menü'],
  ['<kbd>F2</kbd>', 'pályaszerkesztő: a főmenüből a pályalista, játék közben az utoljára szerkesztett pálya (szobában nem elérhető); a szerkesztőben H a súgó'],
];
const TECHNIQUES = [
  ['Dupla ugrás', 'A levegőben még egyszer SPACE: mindig ugyanakkora (a felfelé sebességed 7,3 m/s lesz), és bármikor elsül, nincs időablak. Levegőnként egyszer használható, földetéréskor és falról kiugrás után újra megvan. A csúcson a leghatásosabb. Csak ha még gyorsabban emelkedsz nála (közvetlenül egy pajzsugrás vagy ugrópárna után), nem csinál semmit, és nem is használódik el.'],
  ['Kiugrás', 'Dupla koppintás egy irányra: gyors, alacsony ugrás oldalra, előre vagy hátra. Földetérés után rövid szünet kell a következőhöz. Sprint nincs, mint a UT2004-ben: mindig teljes sebességgel futsz.'],
  ['Kiugró ugrás', 'Kiugrás után a levegőben dupla ugrás: ez viszi a legmesszebbre, a legszélesebb résekhez kell.'],
  ['Falról kiugrás', 'A levegőben, fal közelében (kb. 0,6 m-en belül, a hátad mögött vagy az oldaladnál) kiugrás a faltól elfelé vagy a fal mentén. Mindig ugyanolyan alacsony (kb. fél métert emelkedsz), légterenként egyszer megy, kiugrás vagy átlós ugrás után is. A dupla ugrást visszaadja: falról kiugrás után mindig ugorhatsz még egyet, a SPACE azonnal dupla ugrás, minél később nyomod, annál messzebbre visz.'],
  ['Pajzsugrás', 'Nézz a padlóra, tartsd a bal gombot (töltés), majd SPACE és a gomb elengedése egyszerre. A lökés a töltéstől függ: rövid kattintás kicsi, teljes töltés kb. 6–7 méteres emelkedés.'],
  ['Pajzs + dupla ugrás', 'A pajzsugrás csúcsán még egy dupla ugrás: ez a legmagasabb ugrás a játékban.'],
  ['Fali lökés', 'A levegőben tölts pajzsot, és lőj egy közeli falra: a lökés elfelé visz a faltól. Hátrafelé néző fal előre lök.'],
  ['Futó pajzsugrás', 'Futás közben nézz ferdén hátra és lefelé (kb. 50°), töltsd a pajzsot, majd SPACE és a gomb elengedése egyszerre: a lökés vízszintes sebességet ad, ez kb. 21 métert visz, a csúcson jövő dupla ugrással 28-at.'],
  ['Átlós ugrás', 'W-t tartva koppints 2× A-ra vagy D-re, és vele egyszerre nyomd a SPACE-t (előbb vagy később is jó, kb. 0,07 mp-en belül). A dupla ugrás magától jön a csúcson. Ugrás után nézz a cél felé: a W oda húzza az ugrást. Kb. 16–17 métert visz, többet, mint bármelyik sima ugrás.'],
  ['Kombók', 'A nehéz pályákon egy technika nem elég, kombinálni kell őket: átlós ugrás + falról kiugrás, pajzsugrás + falról kiugrás + dupla ugrás, átlós ugrás + pajzs a falon. Sebességet csak a technikák adnak: futva és ugrálva nem gyorsulsz 8,8 m/s fölé, az elugrás eldobja a landolás előtti lendületet.'],
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
    if (c === 'play' || c === 'controls' || c === 'room' || c === 'lb' || c === 'edhome') this.app.showScreen('menu');
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
    if (id === 'edhome') this.buildEdhome();
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
            <button class="mbtn" data-go="play"><b>Játék</b><span>a beépített pályák saját rekordokkal és szellemmel, meg a saját pályáid</span></button>
            <button class="mbtn" data-go="room"><b>Szoba</b><span>futam haverokkal, élő állással</span></button>
            <button class="mbtn" data-go="lb"><b>Ranglista</b><span>a legjobb idők pályánként</span></button>
            <button class="mbtn" data-go="editor"><b>Szerkesztő</b><span>saját pálya építése, mentése és kipróbálása (F2)</span></button>
            <button class="mbtn" data-go="settings"><b>Beállítások</b><span>egér, látómező, hang, grafika</span></button>
            <button class="mbtn" data-go="controls"><b>Irányítás</b><span>billentyűk és minden technika röviden</span></button>
          </div>
        </div>
        <div class="menu-foot tipline"></div>
      </div>
      <div class="vers">v1 · sim ${SIM_VER}</div>`;
    for (const b of this.els.menu.querySelectorAll('[data-go]')) {
      b.onclick = () => {
        const id = b.dataset.go;
        if (id === 'editor') { this.app.showScreen('edhome'); return; }
        if (id === 'settings') this.back = 'menu';
        this.app.showScreen(id);
      };
    }
  }

  // ---------------------------------------------------------------- map select
  buildPlay() {
    const app = this.app;
    const cards = app.maps.list.map((entry, i) => {
      const m = entry.meta, id = m.id, th = m.theme, sky = th.sky, pal = th.palette;
      const medals = hasMedals(m) ? medalTimes(m.authorTime) : null;   // (a map without a proof route has none)
      const hash = app.mapHashOf(id);
      const pb = app.store.getPB(id, hash);
      const t = pb ? pb.ticks / TICK : null, medal = t != null && medals ? medalFor(t, medals) : null;
      const dc = DIFF_COLOR[m.diff] || '#fff', lvl = DIFF_LEVEL[m.diff] ?? 1, label = DIFF_LABEL[m.diff] ?? m.diff;
      const art = `background: radial-gradient(circle at 78% 70%, ${hex(pal.glow)}66, transparent 55%), radial-gradient(circle at 18% 90%, ${hex(pal.accent)}55, transparent 50%), linear-gradient(180deg, ${hex(sky.top)} 0%, ${hex(sky.horizon)} 64%, ${hex(sky.bottom)} 100%)`;
      const coin = (k) => `<span class="coin m-${k}"></span>`;
      return `
        <button class="card" data-map="${esc(id)}" style="--dc:${dc};animation-delay:${i * 45}ms">
          <div class="art" style="${art}">
            ${label ? `<span class="chip">${label}</span>` : ''}
            <span class="no">${String(m.order).padStart(2, '0')}</span>
            ${lvl ? `<span class="ico">${[1, 2, 3, 4, 5].map((n) => `<i class="${n <= lvl ? 'on' : ''}"></i>`).join('')}</span>` : ''}
          </div>
          <div class="cbody">
            <h3>${esc(m.name)}</h3>
            <p>${esc(m.blurb)}</p>
            <div class="stat"><span class="k">Saját rekord</span><span class="v">${t != null ? fmtTime(t) : '–'} ${!medals ? '' : medal ? coin(medal) : '<span class="coin none"></span>'}</span></div>
            <div class="stat"><span class="k">Globális #1</span><span class="v" id="top1-${esc(id)}">–</span></div>
            ${medals ? `<div class="targets"><span>${coin('author')}${fmtTime(medals.author, 1)}</span><span>${coin('gold')}${fmtTime(medals.gold, 1)}</span><span>${coin('silver')}${fmtTime(medals.silver, 1)}</span><span>${coin('bronze')}${fmtTime(medals.bronze, 1)}</span></div>` : ''}
          </div>
        </button>`;
    }).join('');
    const earned = app.maps.list.filter((e) => { const pb = app.store.getPB(e.meta.id, app.mapHashOf(e.meta.id)); return pb; }).length;
    this.els.play.innerHTML = `
      <div class="top"><button class="btn ghost" data-act="back">‹ Vissza</button><h2 class="h1">Pályák</h2><p class="sub">${app.maps.list.length ? `Mind elérhető, válassz kedvedre. Teljesítve: ${earned}/${app.maps.list.length}` : 'Még nincs beépített pálya: építs egyet a szerkesztőben, vagy játssz a saját pályáiddal.'}</p></div>
      <div class="scroll"><div class="cards">${cards}</div>
        <h3 class="h2 custom-h">Saját pályák</h3><div class="crows" id="custom-list"></div></div>`;
    this.els.play.querySelector('[data-act=back]').onclick = () => app.showScreen('menu');
    this.fillCustomList($('custom-list'), 'play');
    for (const c of this.els.play.querySelectorAll('.card')) c.onclick = () => app.startSolo(c.dataset.map);
    for (const e of app.maps.list) {
      const id = e.meta.id;
      Promise.resolve().then(() => leaderboard.top1(id)).then((r) => {
        const el = $('top1-' + id);
        if (el && r && Number.isFinite(r.time)) el.textContent = fmtTime(r.time) + (r.name ? ' · ' + r.name : '');
      }).catch(() => {});
    }
  }

  // ---------------------------------------------------------------- the player's own maps (editor/library.js)
  // The rows of the saved maps. mode 'play' (JÁTÉK > Saját pályák): Játék / Szerkesztés / Törlés; mode 'edit' (the editor's home): Megnyitás /
  // Átnevezés / Exportálás / Törlés. A map without a finish cannot be played ("Hiányzik a cél").
  fillCustomList(box, mode, flashId = null) {
    const app = this.app, play = mode === 'play';
    if (!box) return;
    const maps = app.store.listCustom().map((e) => lib.describeMap(app.store, e));
    if (!maps.length) {
      box.innerHTML = play
        ? '<p class="sub">Még nincs saját pályád. A szerkesztőben építhetsz egyet, és itt azonnal játszhatsz vele.</p><button class="btn" data-a="home">Szerkesztő</button>'
        : '<p class="sub">Még nincs saját pályád. Kattints az „Új pálya” gombra, vagy importálj egy fájlt.</p>';
      const home = box.querySelector('[data-a=home]');
      if (home) home.onclick = () => app.showScreen('edhome');
      return;
    }
    box.innerHTML = maps.map((c, i) => {
      const problem = !c.ok ? c.error : !c.fin ? 'Hiányzik a cél' : '';
      const meta = [
        c.n + ' elem', c.cps + ' ellenőrzőpont', problem ? '<span class="warn">' + esc(problem) + '</span>' : c.fin ? 'van cél' : '',
        play ? (c.pb ? 'rekord <span class="pbt">' + fmtTime(c.pb.ticks / TICK) + '</span>' : 'nincs rekord') : 'módosítva ' + fmtDate(c.updated),
      ].filter(Boolean).join(' · ');
      const acts = play
        ? `<button class="btn primary sm" data-a="play" ${problem ? 'disabled' : ''} title="${problem ? esc(problem) : 'Játék a pályán'}">Játék</button><button class="btn sm" data-a="edit">Szerkesztés</button><button class="btn ghost sm" data-a="del">Törlés</button>`
        : '<button class="btn primary sm" data-a="edit">Megnyitás</button><button class="btn sm" data-a="rename">Átnevezés</button><button class="btn sm" data-a="export">Exportálás</button><button class="btn ghost sm" data-a="del">Törlés</button>';
      return `<div class="crow${c.id === flashId ? ' flash' : ''}" data-id="${esc(c.id)}" style="animation-delay:${i * 30}ms"><div class="cinfo"><div class="cn">${esc(c.name)}</div><div class="cm">${meta}</div></div><div class="cact">${acts}</div></div>`;
    }).join('');
    const refresh = () => this.fillCustomList(box, mode);
    for (const row of box.querySelectorAll('.crow')) {
      const id = row.dataset.id, c = maps.find((m) => m.id === id), q = (a) => row.querySelector('[data-a=' + a + ']');
      if (q('play')) q('play').onclick = () => app.startCustom(id);
      q('edit').onclick = () => app.openEditor(id);
      if (q('rename')) q('rename').onclick = () => this.startRename(row, c, refresh);
      if (q('export')) q('export').onclick = () => this.exportMap(id);
      this.confirmButton(q('del'), () => {
        lib.deleteMap(app.store, id);
        if (app.editor) app.editor.forget(id);
        refresh();
        this.toast('Pálya törölve: ' + c.name);
      });
    }
  }

  // the list on screen (JÁTÉK > Saját pályák, or the editor's home) after maps were added from outside (main.js: local-maps/)
  refreshCustomLists(flashId = null) {
    if (this.current === 'play') this.fillCustomList($('custom-list'), 'play', flashId);
    else if (this.current === 'edhome') this.fillCustomList($('ed-list'), 'edit', flashId);
  }

  // a button that needs a second click within 3.5 s ("Biztos? Töröl")
  confirmButton(btn, onYes) {
    const label = btn.textContent;
    let timer = 0;
    btn.onclick = () => {
      if (btn.classList.contains('armed')) { clearTimeout(timer); onYes(); return; }
      btn.classList.add('armed');
      btn.textContent = 'Biztos? Töröl';
      timer = setTimeout(() => { btn.classList.remove('armed'); btn.textContent = label; }, 3500);
    };
  }

  // the name of a row becomes a text field: Enter / click away saves it, Esc cancels
  startRename(row, c, done) {
    const cn = row.querySelector('.cn'), inp = document.createElement('input');
    inp.type = 'text'; inp.maxLength = 40; inp.value = c.name; inp.className = 'ren'; inp.setAttribute('aria-label', 'A pálya új neve');
    cn.replaceChildren(inp);
    inp.focus(); inp.select();
    let over = false;
    const finish = (save) => {
      if (over) return;
      over = true;
      const name = inp.value.trim();
      if (save && name && name !== c.name) {
        if (!lib.renameMap(this.app.store, c.id, name)) this.toast('Az átnevezést nem sikerült elmenteni.');
        if (this.app.editor) this.app.editor.forget(c.id);
      }
      done();
    };
    inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); };
    inp.onblur = () => finish(true);
  }

  exportMap(id) {
    const doc = lib.loadDoc(this.app.store, id);
    if (!doc) { this.toast('A pálya nem található.'); return; }
    const f = lib.exportFile(doc);
    try { lib.downloadText(f.name, f.text); this.toast('Exportálva: ' + f.name, 3200); } catch { this.toast('Az exportálás nem sikerült.'); }
  }

  // ---------------------------------------------------------------- the editor's home: new / import / the list
  buildEdhome() {
    const app = this.app, el = this.els.edhome;
    el.innerHTML = `
      <div class="top"><button class="btn ghost" data-act="back">‹ Vissza</button><h2 class="h1">Szerkesztő</h2><p class="sub">Építsd meg a saját pályádat, és próbáld ki azonnal. A pálya magától mentődik ebben a böngészőben.</p></div>
      <div class="scroll"><div class="edhome">
        <div class="row"><button class="btn primary" data-act="new">+ Új pálya</button><button class="btn" data-act="import">Importálás (.json)</button></div>
        <p class="edmsg" id="ed-msg"></p>
        <div class="crows" id="ed-list"></div>
        <p class="sub" style="margin-top:22px">A pályák ebben a böngészőben tárolódnak (legfeljebb ${CUSTOM_LIMIT}). Ha át akarod vinni másik gépre, vagy biztonsági másolat kell, az Exportálás .json fájlba menti, az Importálás visszatölti. F2: a legutóbbi pálya megnyitása.</p>
      </div></div>`;
    const file = document.createElement('input');
    file.type = 'file'; file.accept = '.json,application/json'; file.hidden = true;
    el.append(file);
    el.querySelector('[data-act=back]').onclick = () => app.showScreen('menu');
    el.querySelector('[data-act=new]').onclick = () => this.newMap();
    el.querySelector('[data-act=import]').onclick = () => file.click();
    file.onchange = () => this.importFile(file);
    this.fillCustomList($('ed-list'), 'edit');
  }
  edNote(text, kind = '') {
    const m = $('ed-msg');
    if (m) { m.textContent = text; m.className = 'edmsg ' + kind; }
  }
  newMap() {
    const app = this.app;
    if (app.store.listCustom().length >= CUSTOM_LIMIT) { this.edNote(`Legfeljebb ${CUSTOM_LIMIT} saját pálya fér el: törölj egyet.`, 'bad'); return; }
    app.openEditor(lib.newMapDoc(app.store, Date.now()));
  }
  async importFile(input) {
    const f = input.files && input.files[0];
    input.value = '';   // (the same file can be picked again)
    if (!f) return;
    if (f.size > 4e6) { this.edNote(f.name + ': a fájl túl nagy.', 'bad'); return; }
    let text;
    try { text = await f.text(); } catch { this.edNote(f.name + ': a fájlt nem sikerült beolvasni.', 'bad'); return; }
    let r;
    try { r = lib.importMapText(this.app.store, text); } catch (err) { console.error('[pajzsugras] import failed', err); this.toast('A fájlt nem sikerült feldolgozni.'); return; }   // (a hostile file must not end in a silent unhandled rejection)
    if (r.error) { this.edNote(f.name + ': ' + r.error, 'bad'); return; }
    if (this.app.editor) this.app.editor.forget(r.doc.id);
    if (!r.saved) this.edNote('„' + r.doc.name + '” betöltve, de a böngésző nem tudta elmenteni (megtelt a tárhely?). Nyisd meg, és exportáld újra, ha meg akarod őrizni.', 'bad');
    else this.edNote('Betöltve: „' + r.doc.name + '”' + (r.renamed ? ' (új azonosítóval: a régi példány megmaradt)' : '') + '.', 'good');
    this.fillCustomList($('ed-list'), 'edit', r.doc.id);
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
        </div>
        <div class="sec"><h3 class="h2">Megjelenítés</h3>
          <div class="field"><div><label for="s-quality">Grafika</label><small>Alacsony: gyenge gépekre. Közepes: ajánlott. Magas: árnyékok, élsimítás, nagy felbontás.</small></div><select id="s-quality" data-key="quality">${QUALITIES.map((q) => `<option value="${q}" ${s.quality === q ? 'selected' : ''}>${QUALITY_LABEL[q]}</option>`).join('')}</select><span></span></div>
          <div class="field"><div><label for="s-view">Nézet</label><small>Belső: a saját szemedből. Külső: a figurádat látod hátulról (játék közben a V billentyű vált).</small></div><select id="s-view" data-key="view">${VIEWS.map((v) => `<option value="${v}" ${s.view === v ? 'selected' : ''}>${VIEW_LABEL[v]}</option>`).join('')}</select><span></span></div>
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
        <div class="panel" style="grid-column:1 / -1"><h3 class="h2">Szerkesztő</h3>
          <p class="sub">F2 vagy a főmenü Szerkesztő pontja. Szabadon repülsz, a palettáról építesz, T-vel kipróbálod; a pálya magától mentődik, és fájlba is exportálható. A JÁTÉK képernyőn a Saját pályák között ott lesz.</p>
          <div class="ctl" style="gap:0 30px">${[EDITOR_HELP.slice(0, Math.ceil(EDITOR_HELP.length / 2)), EDITOR_HELP.slice(Math.ceil(EDITOR_HELP.length / 2))].map((half) => `<table class="keys">${half.map((r) => `<tr><td><kbd>${esc(r[0])}</kbd></td><td>${esc(r[1])}</td></tr>`).join('')}</table>`).join('')}</div></div>
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
  // run: { mapId, name, mapName, ticks, splits, labels[], prev (pb before this run | null), isPB, medal, medals, hasNext, custom (an editor map) }
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
    const custom = !!run.custom;   // an editor map: no medals, no next map, the record is local only
    const m = run.medals, order = ['author', 'gold', 'silver', 'bronze'];   // (m: null on a map without a proof route: no medal block)
    const badge = !m ? '' : run.medal ? `<div class="medal-big m-${run.medal}">${MEDAL_NAME[run.medal]}</div>` : '<div class="medal-big" style="--c:#47545e;box-shadow:none"><span style="color:#a8b6be">nincs<br>érem</span></div>';
    const medalCol = !m ? '' : order.map((k) => `<div class="mrow ${run.medal === k ? 'got' : ''}"><span class="coin m-${k}"></span><span>${MEDAL_NAME[k]}</span><b>${fmtTime(m[k], 1)}</b></div>`).join('');
    this.els.results.innerHTML = `
      <div class="panel results">
        <div class="res-left">
          ${run.isPB ? '<div class="newrec">Új rekord!</div>' : ''}
          <div class="lbl">${esc(run.mapName)} · ${esc(run.name)}</div>
          <div class="bigtime">${fmtTime(t)}</div>
          <div class="sub" style="margin:2px 0 14px">${run.isPB ? (prev ? 'Javítottál ' + fmtTime((prev.ticks - run.ticks) / TICK) + ' másodpercet.' : 'Ez az első teljesített futásod.') : prev ? 'A rekordod: ' + fmtTime(prev.ticks / TICK) : ''}</div>
          ${m ? `<div class="res-medal">${badge}<div class="mcol">${medalCol}</div></div>` : ''}
          <p class="sub" id="res-note" style="min-height:22px">${custom ? 'Saját pálya: nincs érem és nincs globális ranglista, a rekord csak ezen a gépen él.' : ''}</p>
          <div class="res-btns">
            <button class="btn primary" data-act="again">Újra</button>
            ${custom ? '' : `<button class="btn" data-act="next" ${run.hasNext ? '' : 'disabled'}>Következő pálya</button>`}
            <button class="btn ghost" data-act="maps">Pályák</button>
          </div>
        </div>
        <div class="res-right"><table class="splits"><thead><tr><th>Ellenőrzőpont</th><th>Idő</th><th>Rekord</th><th>Különbség</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>
      </div>`;
    const q = (a) => this.els.results.querySelector(`[data-act=${a}]`);
    q('again').onclick = () => this.app.retry();
    if (q('next')) q('next').onclick = () => this.app.nextMap();
    q('maps').onclick = () => this.app.showScreen('play');
    this.show('results');
  }
  setResultNote(text) { const n = $('res-note'); if (n) n.textContent = text; }
}
