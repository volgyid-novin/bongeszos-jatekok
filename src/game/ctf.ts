import * as THREE from 'three'
import { FLAG_RETURN_TIME, FLAG_TOUCH, TEAM_COLORS } from '../config'
import type { FlagNet } from '../net/protocol'
import type { Entity } from './entity'
import { FLAG_BASES } from './mapgen'
import { glowTexture } from './textures'

export const AT_BASE = 0
export const CARRIED = 1
export const DROPPED = 2

export interface FlagState {
  s: number
  by: number
  pos: THREE.Vector3
  t: number // seconds until a dropped flag returns
}

export type FlagEventKind = 'taken' | 'dropped' | 'returned' | 'captured'
const KINDS: FlagEventKind[] = ['taken', 'dropped', 'returned', 'captured']

export interface FlagEvent {
  kind: FlagEventKind
  team: number // whose flag
  by: number // entity id, -1 if none
}

// Capture-the-flag state. The host runs the rules; the guest mirrors the host's state.
export class Flags {
  states: FlagState[] = []
  caps: [number, number] = [0, 0]
  onEvent?: (ev: FlagEvent) => void
  onChange?: (ev: FlagEvent | null) => void // host: broadcast new state
  private meshes: THREE.Group[] = []
  private cloths: THREE.Mesh[] = []

  constructor(scene: THREE.Scene) {
    const gt = glowTexture()
    for (const team of [0, 1]) {
      const color = TEAM_COLORS[team]
      // base pedestal
      const pad = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.2, 0.12, 24), new THREE.MeshStandardMaterial({ color: 0x3a3440, metalness: 0.6, roughness: 0.4 }))
      pad.position.copy(FLAG_BASES[team]).add(new THREE.Vector3(0, 0.06, 0))
      scene.add(pad)
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1.05, 0.05, 8, 40), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(2) }))
      ring.rotation.x = Math.PI / 2
      ring.position.copy(pad.position).add(new THREE.Vector3(0, 0.08, 0))
      scene.add(ring)

      const g = new THREE.Group()
      const pole = new THREE.Mesh(new THREE.BoxGeometry(0.06, 2.2, 0.06), new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 0.8, roughness: 0.3 }))
      pole.position.y = 1.1
      g.add(pole)
      const cloth = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.55, 0.03), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(1.6) }))
      cloth.position.set(0.47, 1.85, 0)
      g.add(cloth)
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: gt, color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.8 }))
      glow.scale.setScalar(2.6)
      glow.position.y = 1.4
      g.add(glow)
      scene.add(g)
      this.meshes.push(g)
      this.cloths.push(cloth)
    }
    this.reset()
  }

  reset() {
    this.states = [0, 1].map((t) => ({ s: AT_BASE, by: -1, pos: FLAG_BASES[t].clone(), t: 0 }))
    this.caps = [0, 0]
  }

  // Which enemy flag (team index) this entity carries, or -1
  carriedBy(id: number) {
    return this.states.findIndex((f) => f.s === CARRIED && f.by === id)
  }

  position(team: number, ents: Entity[], out = new THREE.Vector3()) {
    const f = this.states[team]
    if (f.s === CARRIED) return out.copy(ents[f.by].pos)
    return out.copy(f.s === AT_BASE ? FLAG_BASES[team] : f.pos)
  }

  // ---- host rules ----------------------------------------------------------------------------

  hostUpdate(dt: number, ents: Entity[], isAlive: (e: Entity) => boolean) {
    for (const team of [0, 1]) {
      const f = this.states[team]
      if (f.s === CARRIED) {
        const c = ents[f.by]
        const home = this.states[c.team]
        if (home.s === AT_BASE && flat(c.pos, FLAG_BASES[c.team]) < FLAG_TOUCH * 1.4 && Math.abs(c.pos.y - FLAG_BASES[c.team].y) < 2) {
          this.caps[c.team]++
          c.caps++
          this.toBase(team)
          this.emit({ kind: 'captured', team, by: c.id })
        }
        continue
      }
      if (f.s === DROPPED) {
        f.t -= dt
        if (f.t <= 0) {
          this.toBase(team)
          this.emit({ kind: 'returned', team, by: -1 })
          continue
        }
      }
      const fp = f.s === AT_BASE ? FLAG_BASES[team] : f.pos
      for (const e of ents) {
        if (!isAlive(e)) continue
        if (flat(e.pos, fp) > FLAG_TOUCH || Math.abs(e.pos.y - fp.y) > 1.8) continue
        if (e.team !== team) {
          if (this.carriedBy(e.id) >= 0) continue
          f.s = CARRIED
          f.by = e.id
          this.emit({ kind: 'taken', team, by: e.id })
          break
        } else if (f.s === DROPPED) {
          this.toBase(team)
          this.emit({ kind: 'returned', team, by: e.id })
          break
        }
      }
    }
  }

  hostOnDeath(victim: number, at: THREE.Vector3, fell: boolean) {
    const team = this.carriedBy(victim)
    if (team < 0) return
    if (fell) {
      this.toBase(team)
      this.emit({ kind: 'returned', team, by: -1 })
      return
    }
    const f = this.states[team]
    f.s = DROPPED
    f.by = -1
    f.pos.copy(at)
    f.t = FLAG_RETURN_TIME
    this.emit({ kind: 'dropped', team, by: victim })
  }

  // ---- network --------------------------------------------------------------------------------

  serialize(): FlagNet[] {
    return this.states.map((f) => [f.s, f.by, r2(f.pos.x), r2(f.pos.y), r2(f.pos.z), r2(f.t)])
  }

  serializeEvent(ev: FlagEvent | null): [number, number, number] | null {
    return ev ? [KINDS.indexOf(ev.kind), ev.team, ev.by] : null
  }

  apply(net: FlagNet[], caps: [number, number], ev: [number, number, number] | null) {
    net.forEach(([s, by, x, y, z, t], i) => {
      const f = this.states[i]
      f.s = s
      f.by = by
      f.pos.set(x, y, z)
      f.t = t
    })
    this.caps = [caps[0], caps[1]]
    if (ev) this.onEvent?.({ kind: KINDS[ev[0]], team: ev[1], by: ev[2] })
  }

  // ---- rendering ------------------------------------------------------------------------------

  render(t: number, dt: number) {
    for (const team of [0, 1]) {
      const f = this.states[team]
      const g = this.meshes[team]
      g.visible = f.s !== CARRIED
      if (f.s === AT_BASE) g.position.copy(FLAG_BASES[team])
      else if (f.s === DROPPED) {
        g.position.copy(f.pos)
        f.t = Math.max(0, f.t - (this.onChange ? 0 : dt)) // guest: count down locally for the HUD
      }
      g.rotation.y = f.s === DROPPED ? t * 1.5 : 0
      this.cloths[team].rotation.y = Math.sin(t * 3 + team) * 0.25
    }
  }

  private toBase(team: number) {
    const f = this.states[team]
    f.s = AT_BASE
    f.by = -1
    f.pos.copy(FLAG_BASES[team])
    f.t = 0
  }

  private emit(ev: FlagEvent) {
    this.onEvent?.(ev)
    this.onChange?.(ev)
  }
}

function flat(a: THREE.Vector3, b: THREE.Vector3) {
  return Math.hypot(a.x - b.x, a.z - b.z)
}

function r2(n: number) {
  return Math.round(n * 100) / 100
}
