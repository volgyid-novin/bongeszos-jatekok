import * as THREE from 'three'
import { labelTexture } from './textures'
import { buildGun, type GunModel } from './weapons'

// The opponent's voxel body, driven by network poses.
export class Avatar {
  readonly group = new THREE.Group()
  alive = false
  protectedUntil = 0
  private target = new THREE.Vector3()
  private targetYaw = 0
  private yaw = 0
  private pitch = 0
  private moving = 0
  private walk = 0
  private head: THREE.Group
  private arm: THREE.Group
  private legL: THREE.Group
  private legR: THREE.Group
  private gun: GunModel | null = null
  private slot = -1
  private flashMesh: THREE.Mesh
  private flashT = 0
  private hurtT = 0
  private accentMat = new THREE.MeshBasicMaterial({ color: 0xffffff })
  private bodyMat = new THREE.MeshStandardMaterial({ color: 0x2a2640, roughness: 0.6, metalness: 0.3, emissive: 0xff2040, emissiveIntensity: 0 })
  private label: THREE.Sprite
  private hasPose = false
  private flagTeam = -1
  private flagMesh: THREE.Group | null = null
  private t = 0

  constructor(scene: THREE.Scene) {
    const darker = new THREE.MeshStandardMaterial({ color: 0x15131f, roughness: 0.7 })
    const box = (w: number, h: number, d: number, mat: THREE.Material) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)

    const leg = (x: number) => {
      const g = new THREE.Group()
      g.position.set(x, 0.82, 0)
      const m = box(0.22, 0.82, 0.26, darker)
      m.position.y = -0.41
      g.add(m)
      const stripe = box(0.06, 0.5, 0.27, this.accentMat)
      stripe.position.set(0, -0.43, 0)
      g.add(stripe)
      this.group.add(g)
      return g
    }
    this.legL = leg(-0.14)
    this.legR = leg(0.14)

    const torso = box(0.6, 0.66, 0.34, this.bodyMat)
    torso.position.y = 1.14
    this.group.add(torso)
    const chest = box(0.36, 0.08, 0.02, this.accentMat)
    chest.position.set(0, 1.28, -0.18)
    this.group.add(chest)

    this.head = new THREE.Group()
    this.head.position.y = 1.5
    const skull = box(0.38, 0.38, 0.38, this.bodyMat)
    skull.position.y = 0.17
    this.head.add(skull)
    const visor = box(0.3, 0.09, 0.02, this.accentMat)
    visor.position.set(0, 0.2, -0.2)
    this.head.add(visor)
    this.group.add(this.head)

    this.arm = new THREE.Group()
    this.arm.position.set(0.34, 1.36, 0)
    const upper = box(0.15, 0.15, 0.42, this.bodyMat)
    upper.position.set(0, 0, -0.2)
    this.arm.add(upper)
    this.group.add(this.arm)
    this.flashMesh = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.16),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffe9a8).multiplyScalar(3), transparent: true }),
    )
    this.flashMesh.visible = false

    const offArm = box(0.15, 0.56, 0.15, this.bodyMat)
    offArm.position.set(-0.37, 1.14, -0.05)
    this.group.add(offArm)

    this.label = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false, depthTest: false }))
    this.label.position.set(0, 2.25, 0)
    this.label.scale.set(1.8, 0.45, 1)
    this.label.renderOrder = 10
    this.group.add(this.label)

    this.setWeapon(0)
    this.group.visible = false
    scene.add(this.group)
  }

  // Teammates' names show through walls, enemies' don't.
  setIdentity(name: string, color: number, ally: boolean) {
    this.accentMat.color.setHex(color).multiplyScalar(2)
    const mat = this.label.material
    mat.map?.dispose()
    mat.map = labelTexture(name.toUpperCase(), '#' + new THREE.Color(color).getHexString())
    mat.depthTest = !ally
    mat.needsUpdate = true
  }

  // Show (or hide with -1) the flag of `team` on our back
  setFlag(team: number, color = 0xffffff) {
    if (team === this.flagTeam) return
    this.flagTeam = team
    if (this.flagMesh) this.group.remove(this.flagMesh)
    this.flagMesh = null
    if (team < 0) return
    const g = new THREE.Group()
    const pole = new THREE.Mesh(new THREE.BoxGeometry(0.04, 1.3, 0.04), new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 0.8 }))
    pole.position.y = 0.65
    g.add(pole)
    const cloth = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.32, 0.02), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(1.6) }))
    cloth.position.set(0.27, 1.1, 0)
    g.add(cloth)
    g.position.set(-0.15, 0.9, 0.22)
    g.rotation.z = 0.2
    this.group.add(g)
    this.flagMesh = g
  }

  // Local bots: no interpolation, just follow the simulated body
  sync(p: THREE.Vector3, yaw: number, pitch: number, moving: boolean) {
    this.target.copy(p)
    this.group.position.copy(p)
    this.targetYaw = this.yaw = yaw
    this.pitch = pitch
    this.moving = moving ? 1 : 0
    this.hasPose = true
  }

  setWeapon(slot: number) {
    if (slot === this.slot) return
    this.slot = slot
    if (this.gun) this.arm.remove(this.gun.group)
    this.gun = buildGun(slot)
    this.gun.group.scale.setScalar(1.15)
    this.gun.group.position.set(0, 0.04, -0.5)
    this.gun.muzzle.add(this.flashMesh)
    this.arm.add(this.gun.group)
  }

  place(pos: THREE.Vector3, yaw: number) {
    this.target.copy(pos)
    this.group.position.copy(pos)
    this.yaw = this.targetYaw = yaw
    this.hasPose = false
  }

  setPose(p: [number, number, number], yaw: number, pitch: number, moving: number) {
    this.target.set(p[0], p[1], p[2])
    this.targetYaw = yaw
    this.pitch = pitch
    this.moving = moving
    // snap after a respawn / long jump instead of sliding across the map
    if (!this.hasPose || this.group.position.distanceTo(this.target) > 6) {
      this.group.position.copy(this.target)
      this.yaw = yaw
      this.hasPose = true
    }
  }

  flash() {
    this.flashT = 0.06
  }

  hurt() {
    this.hurtT = 0.15
  }

  muzzleWorld(out = new THREE.Vector3()) {
    this.group.updateMatrixWorld()
    return (this.gun?.muzzle ?? this.group).getWorldPosition(out)
  }

  bodyBox() {
    const p = this.group.position
    return new THREE.Box3(new THREE.Vector3(p.x - 0.36, p.y, p.z - 0.36), new THREE.Vector3(p.x + 0.36, p.y + 1.45, p.z + 0.36))
  }

  headBox() {
    const p = this.group.position
    return new THREE.Box3(new THREE.Vector3(p.x - 0.23, p.y + 1.45, p.z - 0.23), new THREE.Vector3(p.x + 0.23, p.y + 1.9, p.z + 0.23))
  }

  center(out = new THREE.Vector3()) {
    return out.copy(this.group.position).add(new THREE.Vector3(0, 1.1, 0))
  }

  update(dt: number, now: number) {
    this.t += dt
    this.group.visible = this.alive
    const k = Math.min(1, dt * 16)
    this.group.position.lerp(this.target, k)
    let dy = this.targetYaw - this.yaw
    dy = Math.atan2(Math.sin(dy), Math.cos(dy))
    this.yaw += dy * k
    this.group.rotation.y = this.yaw
    this.head.rotation.x = this.pitch * 0.6
    this.arm.rotation.x = this.pitch
    this.walk += dt * (this.moving ? 11 : 0)
    const swing = this.moving ? Math.sin(this.walk) * 0.6 : 0
    this.legL.rotation.x = swing
    this.legR.rotation.x = -swing
    this.flashT -= dt
    this.flashMesh.visible = this.flashT > 0
    this.flashMesh.rotation.z += 1.3
    this.hurtT = Math.max(0, this.hurtT - dt)
    const shielded = now < this.protectedUntil
    this.bodyMat.emissive.setHex(shielded ? 0x88ccff : 0xff2040)
    this.bodyMat.emissiveIntensity = this.hurtT > 0 ? 1.5 : shielded ? 0.4 + Math.sin(this.t * 20) * 0.3 : 0
  }
}
