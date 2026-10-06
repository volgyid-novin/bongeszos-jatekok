import { joinRoom, selfId, type MessageAction, type Room } from 'trystero'
import { APP_ID } from '../config'
import { LinkBase, MSG_TYPES, type MsgType, type Msgs } from './protocol'

// Serverless WebRTC link. Peers find each other through public Nostr relays,
// then talk directly. Only the first peer to join is accepted.
export class P2PLink extends LinkBase {
  readonly kind = 'p2p'
  private room: Room
  private peerId: string | null = null
  private actions = new Map<MsgType, MessageAction>()

  constructor(code: string) {
    super()
    this.room = joinRoom({ appId: APP_ID }, 'room-' + code.toUpperCase())
    for (const type of MSG_TYPES) {
      const action = this.room.makeAction(type)
      action.onMessage = (data, ctx) => {
        if (this.peerId === null) this.adopt(ctx.peerId)
        if (ctx.peerId !== this.peerId) return
        this.emit(type, data as unknown as Msgs[typeof type])
      }
      this.actions.set(type, action)
    }
    this.room.onPeerJoin = (pid) => {
      if (this.peerId === null) this.adopt(pid)
    }
    this.room.onPeerLeave = (pid) => {
      if (pid !== this.peerId) return
      this.peerId = null
      this.emitPeer(false)
    }
  }

  get isHost() {
    return this.peerId === null || selfId < this.peerId
  }

  get connected() {
    return this.peerId !== null
  }

  send<K extends MsgType>(type: K, data: Msgs[K]) {
    if (!this.peerId) return
    this.actions
      .get(type)
      ?.send(data as never, { target: this.peerId })
      .catch(() => {})
  }

  leave() {
    this.peerId = null
    void this.room.leave()
  }

  private adopt(pid: string) {
    this.peerId = pid
    this.emitPeer(true)
  }
}
