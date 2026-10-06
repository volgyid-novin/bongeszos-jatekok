import * as THREE from 'three'
import { ITEM_RESPAWN, type ItemKind } from '../config'
import { ITEMS } from './mapgen'
import { glowTexture } from './textures'
import { buildGun } from './weapons'

const SLOT_OF: Partial<Record<ItemKind, number>> = { shotgun: 2, rocket: 3, sniper: 4 }
const GLOW: Record<ItemKind, number> = {
  health: 0xff4d6a,
  armor: 0x22e6ff,
  shotgun: 0xff9a3d,
  rocket: 0xffe14a,
  sniper: 0xb06bff,
}

export function weaponSlotOf(kind: ItemKind) {
  return SLOT_OF[kind]
}

function buildModel(kind: ItemKind) {
  const g = new THREE.Group()
  const slot = SLOT_OF[kind]
  if (slot !== undefined) {
    const gun = buildGun(slot)
    gun.group.scale.setScalar(1.8)
    gun.group.rotation.y = Math.PI / 2
    g.add(gun.group)
    return g
  }
  const basic = (c: number, k = 1.4) => new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(k) })
  if (kind === 'armor') {
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.55, 0.14), new THREE.MeshStandardMaterial({ color: 0x2a3a66, metalness: 0.6, roughness: 0.4 }))
    g.add(plate)
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.08, 0.16), basic(0x22e6ff))
    stripe.position.y = 0.1
    g.add(stripe)
    const stripe2 = stripe.clone()
    stripe2.position.y = -0.1
    g.add(stripe2)
    return g
  }
  const size = 0.38
  const cube = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), new THREE.MeshStandardMaterial({ color: 0xf2f0ff, roughness: 0.4 }))
  g.add(cube)
  const crossColor = 0xff4d6a
  for (const [w, h] of [[size * 0.22, size * 0.7], [size * 0.7, size * 0.22]]) {
    for (const z of [-1, 1]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.02), basic(crossColor))
      bar.position.z = (z * size) / 2
      g.add(bar)
      const side = bar.clone()
      side.rotation.y = Math.PI / 2
      side.position.set((z * size) / 2, 0, 0)
      g.add(side)
    }
  }
  return g
}

// Pickups placed around the map. Availability is tracked per client
// and synchronised with "take" messages.
export class Items {
  private nodes: { root: THREE.Group; model: THREE.Group; glow: THREE.Sprite }[] = []
  private availableAt: number[] = []

  constructor(scene: THREE.Scene) {
    const gt = glowTexture()
    for (const it of ITEMS) {
      const root = new THREE.Group()
      root.position.copy(it.pos)
      const model = buildModel(it.kind)
      root.add(model)
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: gt, color: GLOW[it.kind], transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.7 }))
      glow.scale.setScalar(1.6)
      root.add(glow)
      const base = new THREE.Mesh(
        new THREE.RingGeometry(0.35, 0.45, 24),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(GLOW[it.kind]).multiplyScalar(1.5), side: THREE.DoubleSide }),
      )
      base.rotation.x = -Math.PI / 2
      base.position.y = -0.28 // items float 0.3 m above the surface
      root.add(base)
      scene.add(root)
      this.nodes.push({ root, model, glow })
    }
    this.reset()
  }

  reset() {
    this.availableAt = ITEMS.map(() => 0)
  }

  isAvailable(id: number, now: number) {
    return now >= this.availableAt[id]
  }

  take(id: number, now: number) {
    this.availableAt[id] = now + ITEM_RESPAWN[ITEMS[id].kind]
  }

  // Item the player is touching (if any) that is currently available
  touching(feet: THREE.Vector3, now: number) {
    for (const it of ITEMS) {
      if (!this.isAvailable(it.id, now)) continue
      const dx = it.pos.x - feet.x
      const dz = it.pos.z - feet.z
      const dy = it.pos.y - (feet.y + 0.6)
      if (dx * dx + dz * dz < 0.9 && Math.abs(dy) < 1.1) return it
    }
    return null
  }

  update(now: number) {
    ITEMS.forEach((it, i) => {
      const n = this.nodes[i]
      const avail = this.isAvailable(it.id, now)
      n.model.visible = avail
      n.glow.visible = avail
      n.model.rotation.y = now * 1.6 + i
      n.model.position.y = Math.sin(now * 2.2 + i) * 0.08
      // shimmer a moment before respawning
      const soon = this.availableAt[i] - now
      if (!avail && soon < 1.2) {
        n.glow.visible = true
        n.glow.material.opacity = 0.3 + Math.sin(now * 30) * 0.2
      } else {
        n.glow.material.opacity = 0.7
      }
    })
  }
}
