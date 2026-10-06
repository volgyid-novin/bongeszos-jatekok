export type Vec3 = [number, number, number]

// Entity ids are global: 0-3 red team (host's), 4-7 blue team (guest's).
// Each client simulates its own team (its human + 3 bots) and reports it.
export type EntityState = [
  id: number, x: number, y: number, z: number, yaw: number, pitch: number,
  moving: number, weapon: number, alive: number, protect: number,
]

// flag state on the wire: [state 0 base / 1 carried / 2 dropped, carrier id, x, y, z, return timer]
export type FlagNet = [number, number, number, number, number, number]

export interface Msgs {
  hello: { name: string }
  ready: { r: boolean }
  start: { seed: number }
  st: { e: EntityState[] }
  shot: { a: number; o: Vec3; e: Vec3[]; w: number } // visual only
  hit: { t: number; a: number; dmg: number; head: number; d: Vec3 } // to the target's owner
  rocket: { a: number; id: number; o: Vec3; d: Vec3 }
  boom: { a: number; id: number; p: Vec3 }
  died: { v: number; k: number; p: Vec3 } // victim, killer (-1: fell)
  take: { id: number } // picked up an item
  flag: { f: FlagNet[]; c: [number, number]; ev: [kind: number, team: number, by: number] | null } // host -> guest
  end: { c: [number, number] } // host: match over, final captures
}

export type MsgType = keyof Msgs

export const MSG_TYPES: MsgType[] = ['hello', 'ready', 'start', 'st', 'shot', 'hit', 'rocket', 'boom', 'died', 'take', 'flag', 'end']

export interface Link {
  readonly kind: 'p2p' | 'bot'
  readonly isHost: boolean
  readonly connected: boolean
  send<K extends MsgType>(type: K, data: Msgs[K]): void
  on<K extends MsgType>(type: K, cb: (data: Msgs[K]) => void): void
  onPeer(cb: (connected: boolean) => void): void
  update?(dt: number): void
  leave(): void
}

export abstract class LinkBase implements Link {
  abstract readonly kind: 'p2p' | 'bot'
  abstract readonly isHost: boolean
  abstract readonly connected: boolean
  abstract send<K extends MsgType>(type: K, data: Msgs[K]): void
  abstract leave(): void

  private handlers = new Map<MsgType, ((d: never) => void)[]>()
  private peerHandlers: ((c: boolean) => void)[] = []

  on<K extends MsgType>(type: K, cb: (data: Msgs[K]) => void) {
    const list = this.handlers.get(type) ?? []
    list.push(cb as (d: never) => void)
    this.handlers.set(type, list)
  }

  onPeer(cb: (connected: boolean) => void) {
    this.peerHandlers.push(cb)
  }

  protected emit<K extends MsgType>(type: K, data: Msgs[K]) {
    for (const cb of this.handlers.get(type) ?? []) (cb as (d: Msgs[K]) => void)(data)
  }

  protected emitPeer(connected: boolean) {
    for (const cb of this.peerHandlers) cb(connected)
  }
}
