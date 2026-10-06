import * as THREE from 'three'
import { WEAPONS } from '../config'

// ---- voxel gun models (shared by the viewmodel, avatars and pickups) ---------------------------

const bodyMat = new THREE.MeshStandardMaterial({ color: 0x2b2840, roughness: 0.45, metalness: 0.6 })
const darkMat = new THREE.MeshStandardMaterial({ color: 0x15131f, roughness: 0.8 })
const accentMats = WEAPONS.map((w) => new THREE.MeshBasicMaterial({ color: new THREE.Color(w.color).multiplyScalar(0.9) }))

export interface GunModel {
  group: THREE.Group
  muzzle: THREE.Object3D
}

export function buildGun(slot: number): GunModel {
  const g = new THREE.Group()
  const accent = accentMats[slot]
  const box = (w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number, rx = 0) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m)
    mesh.position.set(x, y, z)
    mesh.rotation.x = rx
    g.add(mesh)
  }
  const muzzle = new THREE.Object3D()
  switch (WEAPONS[slot].id) {
    case 'pistol':
      box(0.075, 0.085, 0.34, bodyMat, 0, 0, 0)
      box(0.065, 0.16, 0.08, darkMat, 0, -0.12, 0.09, -0.25)
      box(0.03, 0.03, 0.06, bodyMat, 0, -0.005, -0.19)
      box(0.004, 0.012, 0.24, accent, -0.039, 0.015, -0.01)
      box(0.004, 0.012, 0.24, accent, 0.039, 0.015, -0.01)
      muzzle.position.set(0, 0, -0.24)
      break
    case 'rifle':
      box(0.08, 0.11, 0.6, bodyMat, 0, 0, -0.05)
      box(0.035, 0.035, 0.24, darkMat, 0, 0.01, -0.46)
      box(0.06, 0.18, 0.08, darkMat, 0, -0.13, -0.1, 0.2)
      box(0.06, 0.14, 0.07, darkMat, 0, -0.1, 0.12, -0.3)
      box(0.05, 0.05, 0.16, darkMat, 0, 0.09, -0.02) // sight
      box(0.052, 0.052, 0.015, accent, 0, 0.09, -0.1)
      box(0.004, 0.012, 0.5, accent, -0.041, -0.02, -0.05)
      box(0.004, 0.012, 0.5, accent, 0.041, -0.02, -0.05)
      muzzle.position.set(0, 0.01, -0.6)
      break
    case 'shotgun':
      box(0.1, 0.1, 0.5, bodyMat, 0, 0, -0.05)
      box(0.045, 0.045, 0.32, darkMat, -0.025, 0.02, -0.42)
      box(0.045, 0.045, 0.32, darkMat, 0.025, 0.02, -0.42)
      box(0.09, 0.07, 0.16, accent, 0, -0.05, -0.32)
      box(0.08, 0.14, 0.24, darkMat, 0, -0.08, 0.25, -0.35)
      muzzle.position.set(0, 0.02, -0.6)
      break
    case 'rocket':
      box(0.16, 0.16, 0.8, bodyMat, 0, 0.02, -0.1)
      box(0.18, 0.18, 0.05, accent, 0, 0.02, -0.48)
      box(0.18, 0.18, 0.05, accent, 0, 0.02, 0.25)
      box(0.06, 0.15, 0.08, darkMat, 0, -0.12, 0.02, -0.2)
      muzzle.position.set(0, 0.02, -0.52)
      break
    case 'sniper':
      box(0.07, 0.1, 0.55, bodyMat, 0, 0, 0)
      box(0.03, 0.03, 0.55, darkMat, 0, 0.01, -0.52)
      box(0.06, 0.06, 0.26, darkMat, 0, 0.1, -0.02) // scope
      box(0.064, 0.064, 0.02, accent, 0, 0.1, -0.16)
      box(0.064, 0.064, 0.02, accent, 0, 0.1, 0.11)
      box(0.07, 0.13, 0.22, darkMat, 0, -0.07, 0.3, -0.25) // stock
      box(0.072, 0.012, 0.4, accent, 0, -0.03, 0)
      muzzle.position.set(0, 0.01, -0.8)
      break
  }
  g.add(muzzle)
  return { group: g, muzzle }
}

// ---- weapon logic (used by players and bots) ------------------------------------------------------

export interface SlotState {
  owned: boolean
  mag: number
  reserve: number
}

export class Loadout {
  slots: SlotState[] = []
  current = 1
  onSwitch?: (slot: number) => void
  onReloaded?: () => void
  protected cooldown = 0
  protected reloadT = 0
  protected switchT = 0

  get def() {
    return WEAPONS[this.current]
  }
  get state() {
    return this.slots[this.current]
  }
  get reloading() {
    return this.reloadT > 0
  }
  get busy() {
    return this.reloadT > 0 || this.switchT > 0
  }

  // Everyone spawns with a pistol and a rifle
  reset() {
    this.slots = WEAPONS.map((w, i) => ({
      owned: i <= 1,
      mag: i <= 1 ? w.mag : 0,
      reserve: i === 0 ? Infinity : i === 1 ? w.pickupAmmo : 0,
    }))
    this.cooldown = 0
    this.reloadT = 0
    this.switchT = 0
    this.current = 1
    this.onSwitch?.(1)
  }

  // Pickup: returns true if it was a new weapon
  give(slot: number) {
    const w = WEAPONS[slot]
    const s = this.slots[slot]
    if (!s.owned) {
      s.owned = true
      s.mag = w.mag
      s.reserve = w.pickupAmmo
      this.switchTo(slot)
      return true
    }
    s.reserve = Math.min(s.reserve + w.pickupAmmo, w.pickupAmmo * 2)
    return false
  }

  switchTo(slot: number) {
    if (slot === this.current || !this.slots[slot]?.owned) return false
    this.reloadT = 0
    this.switchT = 0.28
    this.current = slot
    this.onSwitch?.(slot)
    return true
  }

  cycle(dir: number) {
    const n = WEAPONS.length
    for (let k = 1; k <= n; k++) {
      const s = (this.current + dir * k + n * 4) % n
      if (this.slots[s].owned) return this.switchTo(s)
    }
    return false
  }

  canFire() {
    return this.cooldown <= 0 && !this.busy && this.state.mag > 0
  }

  fire() {
    this.state.mag--
    this.cooldown = this.def.interval
    if (this.state.mag <= 0) this.startReload()
  }

  startReload() {
    const s = this.state
    if (this.reloadT > 0 || s.mag >= this.def.mag || s.reserve <= 0) return false
    this.reloadT = this.def.reload
    return true
  }

  reloadProgress() {
    return this.reloadT > 0 ? 1 - this.reloadT / this.def.reload : 1
  }

  tick(dt: number) {
    this.cooldown -= dt
    this.switchT = Math.max(0, this.switchT - dt)
    if (this.reloadT > 0) {
      this.reloadT -= dt
      if (this.reloadT <= 0) {
        this.reloadT = 0
        const s = this.state
        const take = Math.min(this.def.mag - s.mag, s.reserve)
        s.mag += take
        s.reserve -= take
        this.onReloaded?.()
      }
    }
  }
}

// ---- the local player's arsenal: logic + first-person viewmodel --------------------------------------

export class Arsenal extends Loadout {
  readonly viewmodel = new THREE.Group()
  zoomed = false
  hidden = true // while dead / in menus
  private models: GunModel[]
  private kick = 0
  private flashT = 0
  private sway = 0
  private flash: THREE.Mesh
  private light = new THREE.PointLight(0xffd27a, 0, 7, 2)

  constructor() {
    super()
    this.models = WEAPONS.map((_, i) => buildGun(i))
    for (const m of this.models) {
      m.group.visible = false
      this.viewmodel.add(m.group)
    }
    this.flash = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.07),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffe9a8).multiplyScalar(4), transparent: true }),
    )
    this.flash.scale.set(1, 1, 2)
    this.flash.visible = false
    this.onSwitch = (slot) => {
      this.zoomed = false
      this.models.forEach((m, i) => (m.group.visible = i === slot))
      this.models[slot].muzzle.add(this.flash, this.light)
    }
    this.reset()
  }

  fire() {
    super.fire()
    this.kick = 1
    this.flashT = 0.05
    this.flash.rotation.z = Math.random() * Math.PI
  }

  muzzleWorld(out = new THREE.Vector3()) {
    return this.models[this.current].muzzle.getWorldPosition(out)
  }

  update(dt: number, moving: boolean) {
    this.tick(dt)
    if (this.reloading) this.zoomed = false
    this.kick = Math.max(0, this.kick - dt * 8)
    this.flashT -= dt
    this.flash.visible = this.flashT > 0
    this.light.intensity = this.flashT > 0 ? 10 : 0

    this.sway += dt * (moving ? 9 : 1.5)
    const swayAmt = moving ? 0.012 : 0.003
    const dip = this.reloadT > 0 ? Math.sin(this.reloadProgress() * Math.PI) : this.switchT / 0.28
    const heavy = this.def.id === 'rocket' || this.def.id === 'shotgun' || this.def.id === 'sniper'
    this.viewmodel.visible = !this.zoomed && !this.hidden
    this.viewmodel.position.set(
      0.24 + Math.sin(this.sway) * swayAmt,
      -0.22 + Math.abs(Math.cos(this.sway)) * swayAmt - dip * 0.18,
      -0.5 + this.kick * (heavy ? 0.12 : 0.06),
    )
    this.viewmodel.rotation.set(this.kick * 0.2 - dip * 0.7, 0, dip * 0.4)
  }
}
