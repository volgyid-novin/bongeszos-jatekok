import { joinRoom, selfId } from 'trystero';

// Serverless WebRTC room, the same approach as the other games: peers find each other through public
// Nostr relays, then talk directly. Up to 4 players; empty seats are bots. The host (lowest peer id)
// runs the simulation and sends snapshots; the others send their commands.
export { selfId };
export const APP_ID = 'hago-moba-v1';
// hello: name; lobby: seats (host -> all); pick: seat / hero / ready (-> host); start: match config (host -> all)
// c: commands (-> host); s: snapshot + events (host -> all); back: someone is back in the room
const TYPES = ['hello', 'lobby', 'pick', 'start', 'c', 's', 'back'];

export class Room {
  constructor(code) {
    this.code = code;
    this.peers = new Set();
    this.handlers = {};
    this.actions = {};
    this.onJoin = null;
    this.onLeave = null;
    this.room = joinRoom({ appId: APP_ID }, 'hago-' + code);
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
    if (this.peers.size >= 3) return;          // room full (4 players)
    this.peers.add(pid);
    this.onJoin?.(pid);
  }
  on(type, cb) { this.handlers[type] = cb; }
  // target: a peer id, or omit to send to everyone
  send(type, data, target) {
    if (!this.peers.size || (target && !this.peers.has(target))) return;
    this.actions[type].send(data, target ? { target } : undefined).catch(() => {});
  }
  get hostId() { return [selfId, ...this.peers].sort()[0]; }
  get isHost() { return this.hostId === selfId; }
  leave() {
    this.peers.clear();
    this.room.leave()?.catch?.(() => {});
  }
}
