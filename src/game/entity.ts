import * as THREE from 'three'
import { MAX_HP } from '../config'
import type { Avatar } from './avatar'
import type { BotBrain } from './bot'
import type { Vitals } from './combat'
import type { Body } from './player'
import type { Loadout } from './weapons'

// One of the 8 players. `local` entities are simulated on this client
// (our human + our bots); the rest are driven by network state.
export class Entity {
  vit: Vitals = { hp: MAX_HP, armor: 0 }
  alive = false
  respawnT = 0
  protUntil = 0
  kills = 0
  deaths = 0
  caps = 0
  weapon = 1 // what a remote entity holds
  netPos = new THREE.Vector3()
  body: Body | null = null
  loadout: Loadout | null = null
  avatar: Avatar | null = null
  brain: BotBrain | null = null

  constructor(
    readonly id: number,
    readonly team: number,
    public name: string,
    readonly bot: boolean,
    readonly local: boolean,
  ) {}

  get pos(): THREE.Vector3 {
    return this.body ? this.body.pos : this.netPos
  }

  // Where hits are tested: the simulated body for local entities, the rendered avatar otherwise
  get hitPos(): THREE.Vector3 {
    return this.body ? this.body.pos : (this.avatar?.group.position ?? this.netPos)
  }

  get yaw() {
    return this.body ? this.body.yaw : 0
  }
}

export function hitboxes(e: Entity) {
  const p = e.hitPos
  return {
    body: new THREE.Box3(new THREE.Vector3(p.x - 0.36, p.y, p.z - 0.36), new THREE.Vector3(p.x + 0.36, p.y + 1.45, p.z + 0.36)),
    head: new THREE.Box3(new THREE.Vector3(p.x - 0.23, p.y + 1.45, p.z - 0.23), new THREE.Vector3(p.x + 0.23, p.y + 1.9, p.z + 0.23)),
  }
}

export function chest(e: Entity, out = new THREE.Vector3()) {
  return out.copy(e.hitPos).add(new THREE.Vector3(0, 1.15, 0))
}
