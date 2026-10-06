import { joinRoom, selfId } from 'trystero';

// Serverless WebRTC room (same approach as BLOCKSHOT): peers find each other through
// public Nostr relays, then talk directly. Up to 6 humans race; bots fill the other pods.
// The host is the peer with the lowest id: it starts races and simulates the bots.
export { selfId };
export const APP_ID = 'homokfutam-race-v1';
const TYPES = ['hello', 'ready', 'cfg', 'start', 'st', 'back'];

export class RaceRoom {
  constructor(code) {
    this.code = code;
    this.peers = new Set();
    this.handlers = {};
    this.actions = {};
    this.onJoin = null;
    this.onLeave = null;
    this.room = joinRoom({ appId: APP_ID }, 'race-' + code);
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
    this.actions[type].send(data, target ? { target } : undefined).catch(() => {});
  }

  get hostId() { return [selfId, ...this.peers].sort()[0]; }
  get isHost() { return this.hostId === selfId; }

  leave() {
    this.peers.clear();
    this.room.leave().catch(() => {});
  }
}
