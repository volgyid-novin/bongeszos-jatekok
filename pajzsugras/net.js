import { joinRoom, selfId } from 'trystero';

// Serverless WebRTC room (same approach as HOMOKFUTAM): peers find each other through public Nostr relays, then talk
// directly. Up to 8 humans, no bots. The host picks the map and starts the races. It is sticky: the creator of the room holds it,
// peers that join later never take it over (whatever their id), and only when it leaves is a successor elected (see elect). A room that
// formed twice has two hosts until they meet; race.js settles that (the stronger one stays).
//
// message types (race.js owns the payloads):
//   hello  { name, mh, host }                               every peer -> new peer / everyone (name, map hash or followed host changed;
//                                                           host = the host this peer follows, '' while it has none)
//   lobby  { host, mapId, mapHash, phase, raceNo, players, totals }   host -> everyone (state of the room; `host` is the sender, required)
//          { host, full: true }                                       host -> a peer that does not fit (it leaves)
//   st     [x, y, z (cm), yaw, pitch (rad*100), cp, flags]  every peer -> everyone, 20 Hz (position while free-running / racing; flags = the FLAG bits, an int, WALL = 64 included)
//   start  { raceNo, mapId, mapHash, delayMs }              host -> everyone (countdown)
//   cp     { no, n, ticks }                                 a peer reached a checkpoint (n = checkpoints reached)
//   fin    { no, ticks, splits }                            a peer finished
//   end    { no, results, totals }                          host -> everyone (race over)
export { selfId };
export const APP_ID = 'pajzsugras-v1';
export const MAX_PLAYERS = 8;
const TYPES = ['hello', 'lobby', 'st', 'start', 'cp', 'fin', 'end'];

// 24 letters, no I and O (they look like 1 and 0)
export const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const isCode = (c) => /^[A-HJ-NP-Z]{4}$/.test(c);
export const cleanCode = (v) => String(v ?? '').toUpperCase().replace(/[^A-HJ-NP-Z]/g, '').slice(0, 4);
export function randomCode() {
  const r = new Uint32Array(4);
  if (globalThis.crypto && crypto.getRandomValues) crypto.getRandomValues(r);
  else for (let i = 0; i < 4; i++) r[i] = Math.floor(Math.random() * 0xffffffff);
  return Array.from(r, (v) => CODE_CHARS[v % CODE_CHARS.length]).join('');
}

export class RaceRoom {
  constructor(code) {
    this.code = code;
    this.peers = new Set();
    this.handlers = {};
    this.actions = {};
    this.onJoin = null;
    this.onLeave = null;
    this.host = selfId;   // alone in the room = the host; a joiner follows the host's lobby messages (race.js)
    this.room = joinRoom({ appId: APP_ID }, 'pj-' + code);
    for (const type of TYPES) {
      const action = this.room.makeAction(type);
      action.onMessage = (data, ctx) => {
        const pid = ctx.peerId;
        if (!this.peers.has(pid)) this.join(pid);
        this.handlers[type]?.(data, pid);
      };
      this.actions[type] = action;
    }
    this.room.onPeerJoin = (pid) => { if (!this.peers.has(pid)) this.join(pid); };
    this.room.onPeerLeave = (pid) => {
      if (!this.peers.delete(pid)) return;
      this.onLeave?.(pid);
    };
  }

  join(pid) {
    this.peers.add(pid);
    this.onJoin?.(pid);
  }

  on(type, cb) { this.handlers[type] = cb; }

  // target: a peer id, or omit to send to everyone
  send(type, data, target) {
    if (!this.peers.size) return;
    try { this.actions[type].send(data, target ? { target } : undefined).catch(() => {}); } catch { /* peer gone */ }
  }

  get hostId() { return this.host; }
  get isHost() { return this.host === selfId; }
  follow(id) { this.host = id; }

  // the host is gone: the lowest connected id of `pool` (the race's entrants, or the roster) takes over, so every peer picks the same
  // one; when none of them is here any more, the lowest of everybody
  elect(pool) {
    const here = pool.filter((id) => id === selfId || this.peers.has(id));
    this.host = (here.length ? here : [selfId, ...this.peers]).sort()[0];
    return this.host;
  }

  leave() {
    this.peers.clear();
    this.room.leave().catch(() => {});
  }
}
