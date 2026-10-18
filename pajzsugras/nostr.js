// Global leaderboard transport: personal bests as Nostr events (kind 30078, parameterised replaceable), no server of our own.
//
//   event   { kind: 30078, tags: [['d', 'pajzsugras-v1:<mapId>:<mapHash>'], ['t', 'pajzsugras']],
//             content: JSON { name, ticks, time, splits[], ver: SIM_VER, ghost? (base64 of a deflate-raw 10 Hz ghost, <= 16 kB) } }
//   key     a secp256k1 key made once per browser (localStorage 'pajzsugras:nostr-sk'); the id is sha256 of the NIP-01
//           serialisation, the signature a BIP-340 schnorr one (@noble/secp256k1 v3, async: uses crypto.subtle, so https / localhost)
//   publish to every relay in RELAYS, wait <= 5 s for the OK
//   query   one REQ per relay with one filter per map (each with its own limit), until EOSE or 4 s; ids and signatures are verified,
//           every (pubkey, d) keeps its lowest time, implausible entries are dropped (wrong ver, faster than minTicks, bad splits)
//   cache   5 minutes in sessionStorage + memory (ghosts only on the rank 1 entries)
// Pure ES module (no DOM at import time), so node can test it with an injected WebSocket (see __setTransport).
import * as secp from '@noble/secp256k1';
import { SIM_VER, TICK } from './sim/const.js';
import { decodeGhost, encodeGhost, toB64, fromB64 } from './sim/ghost.js';
import { stripText } from './text.js';

export const KIND = 30078;
export const APP_TAG = 'pajzsugras';
export const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.nostr.band', 'wss://nostr.mom'];
export const TOP_N = 50;
export const GHOST_MAX = 16 * 1024;           // characters of base64
const SK_KEY = 'pajzsugras:nostr-sk';
const CACHE_KEY = 'pajzsugras:lb-cache';
const CACHE_MS = 5 * 60 * 1000;
const FAIL_MS = 30 * 1000;                    // after a failed query do not hammer the relays again for a while
const PUBLISH_MS = 5000;
const QUERY_MS = 4000;
const EARLY_MS = 700;                         // once two relays are done, wait this long for the rest, then go on
const MAX_VERIFY = 400;                       // signatures checked per map and query
const PER_MAP_LIMIT = 300;                    // events asked for per map and relay (relays cap one REQ at about 500)
const MIN_FRACTION = 0.5;                     // a time below half the author time is not credible (the bot's skip routes reach 0.86)
const MIN_SECONDS = 3;                        // ... and the floor of a map that has no author time (an export of the editor)

const { bytesToHex, hexToBytes } = secp.etc;
const T = { WS: globalThis.WebSocket, relays: RELAYS, now: () => Date.now() };
// test hook: inject a fake WebSocket / relay list / clock
export function __setTransport(o = {}) { Object.assign(T, o); }

// the fastest credible run of a map in sim ticks (checked for a board record here and for a `fin` in a room, race.js). A map without a proof
// route (authorTime 0 / missing) has a floor of MIN_SECONDS or, when the caller knows the map's geometry, the geometric floor `floor` (seconds,
// sim/world.js routeFloor: the shortest way start -> checkpoints -> finish at the fastest speed), whichever is larger. The board passes it
// (leaderboard.js infoOf); a room's `fin` is checked with the fixed floor only.
export const minTicks = (authorTime, floor = 0) => (authorTime > 0 ? Math.ceil(MIN_FRACTION * authorTime * TICK)
  : Math.ceil(Math.max(MIN_SECONDS, Number.isFinite(floor) ? floor : 0) * TICK));
export const dTag = (id, hash) => `pajzsugras-v1:${id}:${hash}`;
export const hasCrypto = () => !!(globalThis.crypto && globalThis.crypto.subtle);
export function sanitizeName(v) {
  return stripText(String(v ?? '')).trim().slice(0, 16);
}

// ---------------------------------------------------------------- keys
let keys = null;
export function getKeys() {
  if (keys) return keys;
  let skHex = null;
  try { skHex = localStorage.getItem(SK_KEY); } catch { /* storage blocked */ }
  if (!skHex || !/^[0-9a-f]{64}$/.test(skHex) || !secp.utils.isValidSecretKey(hexToBytes(skHex))) {
    skHex = bytesToHex(secp.utils.randomSecretKey());
    try { localStorage.setItem(SK_KEY, skHex); } catch { /* storage blocked: the key lives for this session */ }
  }
  const sk = hexToBytes(skHex);
  keys = { sk, pk: bytesToHex(secp.schnorr.getPublicKey(sk)) };
  return keys;
}

// ---------------------------------------------------------------- events
async function sha256Hex(str) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str))));
}
export const eventId = (ev) => sha256Hex(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]));

// info = { id, hash }, run = { ticks, splits[], name }, ghost = base64 | null (already packed)
export async function buildEvent(info, run, ghost = null) {
  const { sk, pk } = getKeys();
  const content = { name: sanitizeName(run.name) || 'Játékos', ticks: run.ticks, time: Math.round((run.ticks / TICK) * 1000) / 1000, splits: run.splits, ver: SIM_VER };
  if (ghost) content.ghost = ghost;
  const ev = { pubkey: pk, created_at: Math.floor(T.now() / 1000), kind: KIND, tags: [['d', dTag(info.id, info.hash)], ['t', APP_TAG]], content: JSON.stringify(content) };
  ev.id = await eventId(ev);
  ev.sig = bytesToHex(await secp.schnorr.signAsync(hexToBytes(ev.id), sk));
  return ev;
}

export async function verifyEvent(ev) {
  try {
    if ((await eventId(ev)) !== ev.id) return false;
    return await secp.schnorr.verifyAsync(hexToBytes(ev.sig), hexToBytes(ev.id), hexToBytes(ev.pubkey));
  } catch { return false; }
}

// ---------------------------------------------------------------- ghost packing
async function pipe(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}
// the run's ghost (base64 of encodeGhost at 20 Hz) -> 10 Hz, deflate-raw, base64; null when unsupported or over 16 kB
export async function packGhost(b64) {
  try {
    if (!b64 || typeof CompressionStream === 'undefined') return null;
    const g = decodeGhost(fromB64(b64));
    if (!g) return null;
    const bytes = encodeGhost(g, 2);
    const out = toB64(await pipe(bytes, new CompressionStream('deflate-raw')));
    return out.length <= GHOST_MAX ? out : null;
  } catch { return null; }
}
// base64 from an event -> decoded ghost { every, n, data } | null
export async function unpackGhost(b64) {
  try {
    if (!b64 || typeof DecompressionStream === 'undefined') return null;
    return decodeGhost(await pipe(fromB64(b64), new DecompressionStream('deflate-raw')));
  } catch { return null; }
}

// ---------------------------------------------------------------- sockets
function openSocket(url) {
  try { return new T.WS(url); } catch { return null; }
}
const safeJson = (s) => { try { return JSON.parse(s); } catch { return null; } };
const closeQuiet = (ws) => { try { ws.close(); } catch { /* already closed */ } };

// -> Promise<boolean> (the relay answered OK true)
function publishTo(url, ev, timeout) {
  return new Promise((resolve) => {
    const ws = openSocket(url);
    if (!ws) { resolve(false); return; }
    let done = false;
    const finish = (ok) => { if (done) return; done = true; clearTimeout(timer); closeQuiet(ws); resolve(ok); };
    const timer = setTimeout(() => finish(false), timeout);
    ws.onopen = () => { try { ws.send(JSON.stringify(['EVENT', ev])); } catch { finish(false); } };
    ws.onmessage = (m) => { const a = safeJson(m.data); if (Array.isArray(a) && a[0] === 'OK' && a[1] === ev.id) finish(a[2] === true); };
    ws.onerror = () => finish(false);
    ws.onclose = () => finish(false);
  });
}

// -> { accepted, total }
export async function publishEvent(ev, { timeout = PUBLISH_MS } = {}) {
  const res = await Promise.all(T.relays.map((u) => publishTo(u, ev, timeout)));
  return { accepted: res.filter(Boolean).length, total: res.length };
}

// info = { id, hash }; returns { ok, accepted, total, error? }
export async function publishPB(info, run) {
  if (!hasCrypto()) return { ok: false, accepted: 0, total: 0, error: 'crypto' };
  try {
    const ghost = await packGhost(run.ghost);
    const ev = await buildEvent(info, run, ghost);
    const r = await publishEvent(ev);
    return { ok: r.accepted > 0, ...r, event: ev };
  } catch (e) {
    return { ok: false, accepted: 0, total: T.relays.length, error: String(e && e.message || e) };
  }
}

// REQ on one relay -> Promise<{ eose: bool }>; events go into `out` (Map id|sig|content -> event). Copies of one id that differ are
// all kept, so a forged copy that arrives first cannot hide the real record: the signature check tells them apart later.
function queryRelay(url, filters, timeout, out) {
  return new Promise((resolve) => {
    const ws = openSocket(url);
    if (!ws) { resolve({ eose: false }); return; }
    const sub = 'pj' + Math.random().toString(36).slice(2, 8);
    let done = false;
    const finish = (eose) => {
      if (done) return; done = true; clearTimeout(timer);
      try { ws.send(JSON.stringify(['CLOSE', sub])); } catch { /* socket not open */ }
      closeQuiet(ws); resolve({ eose });
    };
    const timer = setTimeout(() => finish(false), timeout);
    ws.onopen = () => { try { ws.send(JSON.stringify(['REQ', sub, ...filters])); } catch { finish(false); } };
    ws.onmessage = (m) => {
      const a = safeJson(m.data);
      if (!Array.isArray(a) || a[1] !== sub) return;
      if (a[0] === 'EVENT' && a[2] && typeof a[2].id === 'string') { const k = a[2].id + '|' + a[2].sig + '|' + a[2].content; if (!out.has(k)) out.set(k, a[2]); }
      else if (a[0] === 'EOSE') finish(true);
      else if (a[0] === 'CLOSED') finish(false);
    };
    ws.onerror = () => finish(false);
    ws.onclose = () => finish(false);
  });
}

// ---------------------------------------------------------------- reading the boards
const HEX = (n) => new RegExp('^[0-9a-f]{' + n + '}$');
const HEX64 = HEX(64), HEX128 = HEX(128);

// cheap structural + plausibility checks (no signature yet) -> entry | null
function parseEvent(ev, byD) {
  if (!ev || ev.kind !== KIND || typeof ev.content !== 'string' || !Array.isArray(ev.tags)) return null;
  if (!HEX64.test(ev.id || '') || !HEX64.test(ev.pubkey || '') || !HEX128.test(ev.sig || '')) return null;
  const dt = ev.tags.find((t) => Array.isArray(t) && t[0] === 'd');
  const info = dt && byD.get(dt[1]);
  if (!info) return null;
  const c = safeJson(ev.content);
  if (!c || typeof c !== 'object' || c.ver !== SIM_VER) return null;
  const { ticks, splits } = c;
  if (!Number.isInteger(ticks) || ticks < minTicks(info.authorTime, info.floor) || ticks > TICK * 3600) return null;
  if (!Array.isArray(splits) || splits.length !== info.cpCount) return null;
  let prev = 0;
  // (non-decreasing: overlapping checkpoint volumes can be reached in the same tick)
  for (const s of splits) { if (!Number.isInteger(s) || s < prev || s > ticks) return null; prev = s; }
  const name = sanitizeName(c.name);
  if (!name) return null;
  const ghost = typeof c.ghost === 'string' && c.ghost.length <= GHOST_MAX ? c.ghost : null;
  return { id: ev.id, mapId: info.id, pk: ev.pubkey, name, ticks, time: ticks / TICK, splits, ghost, created: ev.created_at | 0, ev };
}

// candidates of one map (sorted by ticks) -> { top: [...], me: { rank, ...entry } | null, total }
async function resolveBoard(cands, myPk) {
  cands.sort((a, b) => a.ticks - b.ticks || a.created - b.created);
  const pks = new Set(cands.map((c) => c.pk));
  const seen = new Set(), ranked = [];
  let checked = 0;
  for (const c of cands) {
    if (seen.has(c.pk)) continue;
    if (ranked.length >= TOP_N && (seen.has(myPk) || !pks.has(myPk))) break;
    if (checked++ >= MAX_VERIFY) break;
    if (!(await verifyEvent(c.ev))) continue;
    seen.add(c.pk);
    ranked.push(c);
  }
  const strip = (c, i) => ({ rank: i + 1, pk: c.pk, name: c.name, ticks: c.ticks, time: c.time, splits: c.splits, ghost: i === 0 ? c.ghost : null, mine: c.pk === myPk });
  const all = ranked.map(strip);
  const mi = all.findIndex((e) => e.mine);
  return { top: all.slice(0, TOP_N), me: mi >= 0 ? all[mi] : null, total: ranked.length };
}

// maps = [{ id, hash, authorTime, cpCount, floor? }]   (floor: seconds, see minTicks)
// -> { ok, boards: { mapId: { top, me, total } }, at, relays (answered with EOSE), error? }
export async function queryBoards(maps, { timeout = QUERY_MS } = {}) {
  if (!hasCrypto()) return { ok: false, error: 'crypto', boards: {}, at: T.now(), relays: 0 };
  if (!T.WS) return { ok: false, error: 'offline', boards: {}, at: T.now(), relays: 0 };
  const byD = new Map(maps.map((m) => [dTag(m.id, m.hash), m]));
  const filters = maps.map((m) => ({ kinds: [KIND], '#d': [dTag(m.id, m.hash)], limit: PER_MAP_LIMIT }));
  const out = new Map();
  const jobs = T.relays.map((u) => queryRelay(u, filters, timeout, out));
  let eose = 0;
  const early = new Promise((go) => jobs.forEach((j) => j.then((r) => { if (r.eose && ++eose === 2) setTimeout(go, EARLY_MS); })));
  await Promise.race([Promise.all(jobs), early]);   // (a slow relay does not hold the board up; its late events are not used)
  const relays = eose, events = [...out.values()];
  if (!relays && !events.length) return { ok: false, error: 'offline', boards: {}, at: T.now(), relays: 0 };
  const myPk = getKeys().pk;
  const per = new Map(maps.map((m) => [m.id, []]));
  for (const ev of events) { const e = parseEvent(ev, byD); if (e) per.get(e.mapId).push(e); }
  const boards = {};
  for (const m of maps) boards[m.id] = await resolveBoard(per.get(m.id), myPk);
  return { ok: true, boards, at: T.now(), relays };
}

// ---------------------------------------------------------------- cache (5 minutes)
let mem = null, inflight = null, failAt = 0, memKey = '';
const keyOf = (maps) => maps.map((m) => dTag(m.id, m.hash)).sort().join(',');

// a cached result has the shape the leaderboard screen reads: { ok, at, boards: { mapId: { top: [rows], me, total } } }
const saneRow = (e) => !!e && typeof e.name === 'string' && Number.isFinite(e.ticks) && Number.isFinite(e.time) && Number.isFinite(e.rank);
const saneBoard = (b) => !!b && Array.isArray(b.top) && b.top.every(saneRow) && (b.me === null || saneRow(b.me)) && Number.isFinite(b.total);
const saneResult = (r) => !!r && r.ok === true && Number.isFinite(r.at) && !!r.boards && typeof r.boards === 'object' && Object.values(r.boards).every(saneBoard);
function loadSession(key) {
  try {
    const c = JSON.parse(sessionStorage.getItem(CACHE_KEY) || 'null');
    if (c && c.key === key && saneResult(c.res) && T.now() - c.res.at < CACHE_MS) return c.res;
  } catch { /* storage blocked / bad json */ }
  return null;
}
function saveSession(key, res) {
  try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ key, res })); } catch { /* quota / blocked */ }
}
export function clearCache() {
  mem = null; failAt = 0;
  try { sessionStorage.removeItem(CACHE_KEY); } catch { /* ignore */ }
}

// cached query; concurrent callers share one request. force: ignore the cache (the refresh button)
export async function getBoards(maps, { force = false } = {}) {
  const key = keyOf(maps);
  if (!force) {
    if (mem && memKey === key && T.now() - mem.at < CACHE_MS) return { ...mem, cached: true };
    const s = loadSession(key);
    if (s) { mem = s; memKey = key; return { ...s, cached: true }; }
    if (failAt && T.now() - failAt < FAIL_MS) return { ok: false, error: 'offline', boards: {}, at: failAt, relays: 0, cached: true };
  }
  if (inflight && inflight.key === key) return inflight.p;
  const p = queryBoards(maps).then((res) => {
    if (res.ok) { mem = res; memKey = key; failAt = 0; saveSession(key, res); } else failAt = T.now();
    return res;
  }).catch(() => { failAt = T.now(); return { ok: false, error: 'offline', boards: {}, at: failAt, relays: 0 }; })
    .finally(() => { inflight = null; });
  inflight = { key, p };
  return p;
}
