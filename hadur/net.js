import { joinRoom, selfId } from 'trystero';

// Serverless 1v1 room (same approach as BLOCKSHOT and HOMOKFUTAM): peers find each other through
// public Nostr relays, then talk directly over WebRTC. Only the first peer to arrive is accepted.
// The host (lower peer id) is player slot 0 and starts the match.
export { selfId };
export const APP_ID = 'hadur-rts-v1';
const TYPES = ['hello', 'ready', 'start', 'turn', 'hash', 'back'];

export class Duel {
  constructor(code) {
    this.code = code;
    this.peer = null;
    this.handlers = {};
    this.actions = {};
    this.onPeer = null;      // (connected: boolean) => void
    this.room = joinRoom({ appId: APP_ID }, 'duel-' + code);
    for (const type of TYPES) {
      const action = this.room.makeAction(type);
      action.onMessage = (data, ctx) => {
        if (this.peer === null) this.adopt(ctx.peerId);
        if (ctx.peerId !== this.peer) return;
        this.handlers[type]?.(data);
      };
      this.actions[type] = action;
    }
    this.room.onPeerJoin = (pid) => { if (this.peer === null) this.adopt(pid); };
    this.room.onPeerLeave = (pid) => {
      if (pid !== this.peer) return;
      this.peer = null;
      this.onPeer?.(false);
    };
  }
  adopt(pid) {
    this.peer = pid;
    this.onPeer?.(true);
  }
  on(type, cb) { this.handlers[type] = cb; }
  send(type, data) {
    if (!this.peer) return;
    this.actions[type].send(data, { target: this.peer }).catch(() => {});
  }
  get connected() { return this.peer !== null; }
  get isHost() { return this.peer === null || selfId < this.peer; }
  leave() {
    this.peer = null;
    this.room.leave().catch?.(() => {});
  }
}
