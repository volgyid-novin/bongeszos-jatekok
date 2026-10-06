import * as THREE from 'three'
import { ARMOR_ABSORB, ROCKET_PUSH, ROCKET_RADIUS, ROCKET_SELF_DAMAGE, WEAPONS } from '../config'

export interface Vitals {
  hp: number
  armor: number
}

// Armor soaks up part of the damage while it lasts.
export function applyDamage(v: Vitals, dmg: number) {
  const soak = Math.min(v.armor, dmg * ARMOR_ABSORB)
  v.armor -= soak
  v.hp -= dmg - soak
  return v.hp <= 0
}

// Rocket splash against a player whose feet are at `feet`.
export function splash(center: THREE.Vector3, feet: THREE.Vector3, own: boolean) {
  const body = feet.clone().add(new THREE.Vector3(0, 0.9, 0))
  const dist = body.distanceTo(center)
  if (dist >= ROCKET_RADIUS) return null
  const k = 1 - dist / ROCKET_RADIUS
  const dmg = Math.round(WEAPONS[3].dmg * Math.pow(k, 0.8) * (own ? ROCKET_SELF_DAMAGE : 1))
  const push = body.sub(center).normalize()
  push.y = Math.max(push.y, 0.35)
  push.normalize().multiplyScalar(ROCKET_PUSH * (0.4 + 0.6 * k))
  return { dmg, push }
}
