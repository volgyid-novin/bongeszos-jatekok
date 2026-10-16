// Fakes for the app-level suites: DOM, storage, virtual clock, Nostr relays, a map registry, signed-event forging.
// Nothing here touches the network or the real maps.
import { createHash } from 'node:crypto';
import * as secp from '@noble/secp256k1';
import { setGlobal, onCleanup, afterAll } from './harness.mjs';
import { SIM_VER } from '../sim/const.js';

export const { bytesToHex, hexToBytes } = secp.etc;

// nostr.js grabs globalThis.WebSocket when it is imported: make that a trap, so a test that forgets to inject mock relays fails
// instead of dialling a real relay (call before importing nostr.js / leaderboard.js; idempotent; undone after the last case)
let guarded = false;
export function guardWebSocket() {
  if (guarded) return;
  guarded = true;
  const real = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  Object.defineProperty(globalThis, 'WebSocket', { value: class { constructor(url) { throw new Error('a test tried to open a real WebSocket: ' + url); } }, configurable: true, writable: true });
  afterAll(() => { guarded = false; if (real) Object.defineProperty(globalThis, 'WebSocket', real); else delete globalThis.WebSocket; });
}

// ---------------------------------------------------------------- storage
export function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
    _m: m,
  };
}
// a storage whose methods throw (Safari private mode, blocked cookies); pass overrides to break only some of them
export function brokenStorage(over = {}) {
  const boom = () => { throw new DOMException('storage blocked', 'SecurityError'); };
  return { getItem: boom, setItem: boom, removeItem: boom, clear: boom, key: boom, length: 0, ...over };
}

// ---------------------------------------------------------------- fake DOM (just enough for race.js and leaderboard.js)
export class El {
  constructor() {
    this._html = ''; this._kids = new Map();
    this.hidden = false; this.textContent = ''; this.value = ''; this.dataset = {}; this.style = {}; this.disabled = false; this.onclick = null;
    this.classList = { toggle() {}, add() {}, remove() {} };
  }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); this._kids = new Map(); }
  has(sel) {
    const h = this._html;
    if (sel[0] === '#') return h.includes(`id="${sel.slice(1)}"`);
    if (sel[0] === '.') return new RegExp(`class="[^"]*\\b${sel.slice(1)}\\b`).test(h);
    const m = sel.match(/^\[data-act=(\w+)\]$/);
    return !!m && h.includes(`data-act="${m[1]}"`);
  }
  querySelector(sel) {
    if (!this.has(sel)) return null;
    if (!this._kids.has(sel)) this._kids.set(sel, new El());
    return this._kids.get(sel);
  }
  querySelectorAll(sel) {
    if (sel[0] !== '.') return [];
    const cls = sel.slice(1), out = [];
    for (const m of this._html.matchAll(new RegExp(`class="[^"]*\\b${cls}\\b[^"]*"(?: data-map="([^"]*)")?`, 'g'))) {
      const key = 'all:' + cls + ':' + out.length;
      if (!this._kids.has(key)) this._kids.set(key, new El());
      const e = this._kids.get(key);
      if (m[1] !== undefined) e.dataset.map = m[1];
      out.push(e);
    }
    return out;
  }
  focus() {} select() {} after() {}
}

export function installDom() {
  const els = new Map(), winListeners = {};
  setGlobal('document', {
    getElementById: (id) => { if (!els.has(id)) els.set(id, new El()); return els.get(id); },
    querySelector: () => null, createElement: () => new El(), execCommand: () => true,
  });
  setGlobal('window', { addEventListener: (t, f) => { winListeners[t] = f; } });
  setGlobal('location', { hash: '', origin: 'http://test.invalid', pathname: '/pajzsugras/', search: '' });
  setGlobal('history', { replaceState() {} });
  return { els, winListeners };
}

// ---------------------------------------------------------------- virtual clock (setTimeout / setInterval / performance.now)
// advance(ms) fires due timers in order and lets promises settle after each one, so a 3-minute race takes milliseconds.
export function installClock() {
  const origNow = performance.now;
  let t = 0, seq = 0;
  const timers = new Map();
  setGlobal('setTimeout', (fn, ms = 0) => { const k = ++seq; timers.set(k, { at: t + Math.max(0, +ms || 0), fn, every: 0 }); return k; });
  setGlobal('setInterval', (fn, ms = 0) => { const k = ++seq, e = Math.max(1, +ms || 1); timers.set(k, { at: t + e, fn, every: e }); return k; });
  setGlobal('clearTimeout', (k) => { timers.delete(k); });
  setGlobal('clearInterval', (k) => { timers.delete(k); });
  performance.now = () => t;
  onCleanup(() => { performance.now = origNow; });
  const settle = () => new Promise((r) => setImmediate(r));
  return {
    now: () => t,
    pending: () => timers.size,
    settle,
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        let best = null, bk = 0;
        for (const [k, tm] of timers) if (tm.at <= end && (!best || tm.at < best.at || (tm.at === best.at && k < bk))) { best = tm; bk = k; }
        if (!best) break;
        t = best.at;
        if (best.every) best.at += best.every; else timers.delete(bk);
        best.fn();
        await settle();
      }
      t = end;
      await settle();
    },
  };
}

// ---------------------------------------------------------------- a map registry with two tiny maps (the real ones are covered by the route tests)
//   alpha: author 40 s (the 180 s floor of the race cap applies), 2 checkpoints     beta: author 100 s (cap 300 s), 3 checkpoints
export function fakeMaps() {
  const defs = [
    { id: 'alpha', name: 'ALFA', order: 1, diff: 'konnyu', authorTime: 40, cps: 2 },
    { id: 'beta', name: 'BÉTA', order: 2, diff: 'nehez', authorTime: 100, cps: 3 },
  ];
  const stats = { builds: 0 };
  const list = defs.map((d) => ({
    meta: { id: d.id, name: d.name, order: d.order, diff: d.diff, authorTime: d.authorTime },
    build: () => { stats.builds++; return { mapHash: 'hash-' + d.id, checkpoints: Array.from({ length: d.cps }, (_, i) => ({ i, label: 'CP' + (i + 1) })) }; },
  }));
  const byId = new Map(list.map((e) => [e.meta.id, e]));
  return { list, ids: list.map((e) => e.meta.id), get: (id) => byId.get(id) || null, has: (id) => byId.has(id), stats };
}
export const DIFF_LABEL = { kikepzes: 'Kiképzés', konnyu: 'Könnyű', kozepes: 'Közepes', nehez: 'Nehéz', mester: 'Mester' };

// ---------------------------------------------------------------- mock Nostr relays (a WebSocket class that never leaves the process)
// spec: { 'wss://x': { mode, events: [] } }   mode: ok | down | mute (never answers) | reject (OK false) | garbage (junk frames, then the truth)
export function makeRelays(spec) {
  const st = { connects: 0, reqs: 0, posts: 0 };
  const urls = Object.keys(spec);
  const dOf = (e) => (e.tags.find((t) => t[0] === 'd') || [])[1];
  class FakeWS {
    constructor(url) {
      st.connects++;
      this.url = url; this.rel = spec[url]; this.closed = false;
      if (!this.rel) throw new Error('test relay not configured: ' + url);
      setTimeout(() => {
        if (this.closed) return;
        if (this.rel.mode === 'down') { if (this.onerror) this.onerror({}); if (this.onclose) this.onclose({}); } else if (this.onopen) this.onopen({});
      }, 1);
    }
    reply(x) { setTimeout(() => { if (!this.closed && this.onmessage) this.onmessage({ data: typeof x === 'string' ? x : JSON.stringify(x) }); }, 1); }
    send(raw) {
      const a = JSON.parse(raw), mode = this.rel.mode;
      if (mode === 'mute') return;
      if (a[0] === 'EVENT') {
        st.posts++;
        if (mode === 'reject') { this.reply(['OK', a[1].id, false, 'blocked: nope']); return; }
        const d = dOf(a[1]);   // replaceable: the relay keeps the newest per (pubkey, d)
        this.rel.events = this.rel.events.filter((e) => !(e.pubkey === a[1].pubkey && dOf(e) === d));
        this.rel.events.push(a[1]);
        this.reply(['OK', a[1].id, true, '']);
      } else if (a[0] === 'REQ') {
        st.reqs++;
        const [, sub, ...filters] = a;   // (one filter per map)
        if (mode === 'garbage') {
          for (const g of ['not json', '42', '{}', '[]', JSON.stringify(['EVENT', 'other-sub', {}]), JSON.stringify(['EVENT', sub, null]), JSON.stringify(['EVENT', sub, { id: 5 }]), JSON.stringify(['NOTICE', 'hi'])]) this.reply(g);
        }
        st.filters = filters;
        for (const e of this.rel.events) if (filters.some((f) => f['#d'].includes(dOf(e)))) this.reply(['EVENT', sub, e]);
        this.reply(['EOSE', sub]);
      }
    }
    close() { if (this.closed) return; this.closed = true; setTimeout(() => { if (this.onclose) this.onclose({}); }, 0); }
  }
  return { WS: FakeWS, urls, spec, st };
}

// ---------------------------------------------------------------- signed events from "other players" (and forgeries)
export const sha256Hex = (s) => createHash('sha256').update(s).digest('hex');
export const eventIdOf = (ev) => sha256Hex(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]));
export const splitsFor = (n, ticks) => Array.from({ length: n }, (_, j) => Math.max(j + 1, Math.floor((ticks * (j + 1)) / (n + 1))));

// info = { id, hash, authorTime, cpCount }; o: { ticks, name, splits, ver, ghost, content (raw object), pubkey (claim someone else's), d, hash, created, sk }
// -> { ev, sk, pk }
export async function forge(info, o = {}) {
  const sk = o.sk ?? secp.utils.randomSecretKey();
  const pk = bytesToHex(secp.schnorr.getPublicKey(sk));
  const ticks = o.ticks ?? Math.round(info.authorTime * 120 * 1.05);
  const content = JSON.stringify(o.content ?? {
    name: o.name ?? 'P', ticks, time: ticks / 120, splits: o.splits ?? splitsFor(info.cpCount, ticks), ver: o.ver ?? SIM_VER, ...(o.ghost ? { ghost: o.ghost } : {}),
  });
  const ev = { pubkey: o.pubkey ?? pk, created_at: o.created ?? 1700000000, kind: 30078, tags: [['d', o.d ?? `pajzsugras-v1:${info.id}:${o.hash ?? info.hash}`], ['t', 'pajzsugras']], content };
  ev.id = eventIdOf(ev);
  ev.sig = bytesToHex(await secp.schnorr.signAsync(hexToBytes(ev.id), sk));   // (signed by `sk`, even when the claimed pubkey is someone else's)
  return { ev, sk, pk };
}
