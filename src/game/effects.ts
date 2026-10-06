import * as THREE from 'three'
import { glowTexture } from './textures'

const MAX_PARTICLES = 1400
const MAX_TRACERS = 40
const MAX_FLASHES = 12

interface Tracer {
  mesh: THREE.Mesh
  mat: THREE.MeshBasicMaterial
  life: number
}

interface Flash {
  sprite: THREE.Sprite
  life: number
  max: number
  size: number
}

// Voxel debris, bullet tracers and explosion flashes.
export class Effects {
  private mesh: THREE.InstancedMesh
  private pos = new Float32Array(MAX_PARTICLES * 3)
  private vel = new Float32Array(MAX_PARTICLES * 3)
  private life = new Float32Array(MAX_PARTICLES)
  private maxLife = new Float32Array(MAX_PARTICLES)
  private size = new Float32Array(MAX_PARTICLES)
  private spin = new Float32Array(MAX_PARTICLES)
  private next = 0
  private tracers: Tracer[] = []
  private tracerIdx = 0
  private flashes: Flash[] = []
  private flashIdx = 0
  private light = new THREE.PointLight(0xffb060, 0, 18, 1.5)
  private lightT = 0
  private m = new THREE.Matrix4()
  private q = new THREE.Quaternion()
  private e = new THREE.Euler()
  private s = new THREE.Vector3()
  private p = new THREE.Vector3()
  private c = new THREE.Color()

  constructor(scene: THREE.Scene) {
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), MAX_PARTICLES)
    this.mesh.frustumCulled = false
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.mesh.setMatrixAt(i, this.m.makeScale(0, 0, 0))
      this.mesh.setColorAt(i, this.c.setHex(0xffffff))
    }
    scene.add(this.mesh)

    const geo = new THREE.BoxGeometry(1, 1, 1)
    geo.translate(0, 0, 0.5)
    for (let i = 0; i < MAX_TRACERS; i++) {
      const mat = new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })
      const mesh = new THREE.Mesh(geo, mat)
      mesh.visible = false
      mesh.frustumCulled = false
      scene.add(mesh)
      this.tracers.push({ mesh, mat, life: 0 })
    }
    const gt = glowTexture()
    for (let i = 0; i < MAX_FLASHES; i++) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: gt, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }))
      sprite.visible = false
      scene.add(sprite)
      this.flashes.push({ sprite, life: 0, max: 1, size: 1 })
    }
    scene.add(this.light)
  }

  burst(at: THREE.Vector3, color: number, count: number, speed = 6, size = 0.16) {
    for (let k = 0; k < count; k++) {
      const i = this.next
      this.next = (this.next + 1) % MAX_PARTICLES
      this.pos[i * 3] = at.x
      this.pos[i * 3 + 1] = at.y
      this.pos[i * 3 + 2] = at.z
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.3, Math.random() - 0.5).normalize()
      const v = speed * (0.4 + Math.random() * 0.8)
      this.vel[i * 3] = dir.x * v
      this.vel[i * 3 + 1] = dir.y * v + speed * 0.5
      this.vel[i * 3 + 2] = dir.z * v
      const l = 0.5 + Math.random() * 0.8
      this.life[i] = l
      this.maxLife[i] = l
      this.size[i] = size * (0.6 + Math.random() * 0.8)
      this.spin[i] = Math.random() * 10
      this.mesh.setColorAt(i, this.c.setHex(color).multiplyScalar(1.2 + Math.random()))
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
  }

  tracer(from: THREE.Vector3, to: THREE.Vector3, color: number, width = 0.03) {
    const t = this.tracers[this.tracerIdx]
    this.tracerIdx = (this.tracerIdx + 1) % MAX_TRACERS
    const len = from.distanceTo(to)
    if (len < 0.01) return
    t.mesh.position.copy(from)
    t.mesh.lookAt(to)
    t.mesh.scale.set(width, width, len)
    t.mat.color.setHex(color).multiplyScalar(2.2)
    t.mat.opacity = 1
    t.life = 0.08
    t.mesh.visible = true
  }

  flash(at: THREE.Vector3, color: number, size: number, life = 0.35) {
    const f = this.flashes[this.flashIdx]
    this.flashIdx = (this.flashIdx + 1) % MAX_FLASHES
    f.sprite.position.copy(at)
    f.sprite.material.color.setHex(color)
    f.life = f.max = life
    f.size = size
    f.sprite.visible = true
  }

  explosion(at: THREE.Vector3) {
    this.flash(at, 0xffb060, 7, 0.4)
    this.flash(at, 0xffffff, 3.5, 0.18)
    this.burst(at, 0xffa040, 40, 10, 0.2)
    this.burst(at, 0xffe14a, 20, 6, 0.14)
    this.light.position.copy(at)
    this.lightT = 0.3
  }

  update(dt: number) {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (this.life[i] <= 0) continue
      this.life[i] -= dt
      const i3 = i * 3
      this.vel[i3 + 1] -= 14 * dt
      this.pos[i3] += this.vel[i3] * dt
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt
      if (this.pos[i3 + 1] < 0.5 + this.size[i] / 2) {
        this.pos[i3 + 1] = 0.5 + this.size[i] / 2
        this.vel[i3 + 1] *= -0.35
        this.vel[i3] *= 0.7
        this.vel[i3 + 2] *= 0.7
      }
      const k = this.life[i] > 0 ? Math.min(1, (this.life[i] / this.maxLife[i]) * 2) : 0
      this.spin[i] += dt * 6
      this.q.setFromEuler(this.e.set(this.spin[i], this.spin[i] * 0.7, 0))
      this.s.setScalar(this.size[i] * k)
      this.p.set(this.pos[i3], this.pos[i3 + 1], this.pos[i3 + 2])
      this.mesh.setMatrixAt(i, this.m.compose(this.p, this.q, this.s))
    }
    this.mesh.instanceMatrix.needsUpdate = true

    for (const t of this.tracers) {
      if (t.life <= 0) continue
      t.life -= dt
      t.mat.opacity = Math.max(0, t.life / 0.08)
      if (t.life <= 0) t.mesh.visible = false
    }
    for (const f of this.flashes) {
      if (f.life <= 0) continue
      f.life -= dt
      const k = Math.max(0, f.life / f.max)
      f.sprite.scale.setScalar(f.size * (1.4 - k * 0.4))
      f.sprite.material.opacity = k
      if (f.life <= 0) f.sprite.visible = false
    }
    this.lightT = Math.max(0, this.lightT - dt)
    this.light.intensity = this.lightT * 200
  }
}
