import { joinRoom, selfId } from 'trystero';

// Serverless rooms, same approach as the other games: peers find each other through public Nostr relays,
// then talk directly over WebRTC. Two kinds of room:
//  - pair room 'kard-<pairId>': one PC and its phone. The PC makes up the long random pairId and shows it
//    as a QR code, so only a phone that scanned it gets in.
//  - duel room 'duel-<code>': the two PCs, like HADÚR. The host (lower peer id) referees the hits.
export { selfId };
export const APP_ID = 'fenykard-duel-v1';

// PC <-> phone. Phone sends: hi (hello), o (saber quaternion), pb (button). PC sends: ps (status), bz (vibrate).
const PAIR_TYPES = ['hi', 'o', 'pb', 'ps', 'bz'];
// PC <-> PC
const DUEL_TYPES = ['hello', 'ready', 'start', 's', 'ev', 'back'];

export class Room {
  constructor(roomId, types) {
    this.peers = new Set();
    this.handlers = {};
    this.actions = {};
    this.onJoin = null;     // (peerId) => void
    this.onLeave = null;    // (peerId) => void
    this.room = joinRoom({ appId: APP_ID }, roomId);
    for (const type of types) {
      const action = this.room.makeAction(type);
      action.onMessage = (data, ctx) => {
        this.seen(ctx.peerId);
        this.handlers[type]?.(data, ctx.peerId);
      };
      this.actions[type] = action;
    }
    this.room.onPeerJoin = (pid) => this.seen(pid);
    this.room.onPeerLeave = (pid) => { if (this.peers.delete(pid)) this.onLeave?.(pid); };
  }
  seen(pid) {
    if (this.peers.has(pid)) return;
    this.peers.add(pid);
    this.onJoin?.(pid);
  }
  on(type, cb) { this.handlers[type] = cb; }
  // target: a peer id, or omit to send to everyone
  send(type, data, target) {
    if (!this.peers.size || (target && !this.peers.has(target))) return;
    this.actions[type].send(data, target ? { target } : undefined).catch(() => {});
  }
  leave() {
    this.peers.clear();
    this.room.leave()?.catch?.(() => {});
  }
}

export const pairRoom = (pairId) => new Room('kard-' + pairId, PAIR_TYPES);

// 1v1: only the first PC to arrive is accepted
export class Duel extends Room {
  constructor(code) {
    super('duel-' + code, DUEL_TYPES);
    this.code = code;
    this.peer = null;
    this.onPeer = null;     // (connected: boolean) => void
    this.onJoin = (pid) => { if (this.peer === null) { this.peer = pid; this.onPeer?.(true); } };
    this.onLeave = (pid) => { if (pid === this.peer) { this.peer = null; this.onPeer?.(false); } };
  }
  on(type, cb) { super.on(type, (data, pid) => { if (pid === this.peer) cb(data); }); }
  send(type, data) { if (this.peer) super.send(type, data, this.peer); }
  get connected() { return this.peer !== null; }
  get isHost() { return this.peer === null || selfId < this.peer; }
}
