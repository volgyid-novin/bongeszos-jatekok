import * as THREE from 'three'
import { EYE_HEIGHT, GRAVITY, JUMP_PAD_SPEED, JUMP_SPEED, MOVE_SPEED, PLAYER_HEIGHT, PLAYER_RADIUS, STEP_HEIGHT, VOXEL } from '../config'
import { B, type VoxelWorld } from './world'

export interface MoveInput {
  forward: number
  right: number
  jump: boolean
}

const below = new THREE.Vector3()

// First-person physics body with voxel collision, auto step-up and jump pads.
// Used by the local player and by the practice bot.
export class Body {
  pos = new THREE.Vector3()
  vel = new THREE.Vector3()
  yaw = 0
  pitch = 0
  onGround = false
  moving = false
  onJumpPad?: () => void
  onLand?: (speed: number) => void
  private bob = 0
  private stepOffset = 0

  constructor(private world: VoxelWorld) {}

  place(pos: THREE.Vector3, yaw: number) {
    this.pos.copy(pos)
    this.vel.set(0, 0, 0)
    this.yaw = yaw
    this.pitch = 0
    this.onGround = false
    this.stepOffset = 0
  }

  look(dx: number, dy: number, sens: number) {
    this.yaw -= dx * sens
    this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch - dy * sens))
  }

  update(dt: number, input: MoveInput) {
    const sin = Math.sin(this.yaw)
    const cos = Math.cos(this.yaw)
    // forward is (-sin, 0, -cos), right is (cos, 0, -sin)
    let wx = -sin * input.forward + cos * input.right
    let wz = -cos * input.forward - sin * input.right
    const len = Math.hypot(wx, wz)
    if (len > 0) {
      wx = (wx / len) * MOVE_SPEED
      wz = (wz / len) * MOVE_SPEED
    }
    if (this.onGround || len > 0) {
      const accel = (this.onGround ? 70 : 16) * dt
      this.vel.x += clamp(wx - this.vel.x, accel)
      this.vel.z += clamp(wz - this.vel.z, accel)
    }

    if (input.jump && this.onGround) {
      this.vel.y = JUMP_SPEED
      this.onGround = false
    }
    this.vel.y = Math.max(-45, this.vel.y - GRAVITY * dt)

    this.moveHorizontal('x', this.vel.x * dt)
    this.moveHorizontal('z', this.vel.z * dt)
    this.moveVertical(this.vel.y * dt)

    if (this.onGround) {
      below.set(this.pos.x, this.pos.y - 0.05, this.pos.z)
      if (this.world.blockAt(below) === B.PAD) {
        this.vel.y = JUMP_PAD_SPEED
        this.onGround = false
        this.onJumpPad?.()
      }
    }

    this.stepOffset = Math.max(0, this.stepOffset - dt * 4)
    const speed = Math.hypot(this.vel.x, this.vel.z)
    this.moving = speed > 0.5 && this.onGround
    if (this.moving) this.bob += dt * speed * 1.5
  }

  eye(out = new THREE.Vector3()) {
    return out.set(this.pos.x, this.pos.y + EYE_HEIGHT - this.stepOffset + Math.sin(this.bob) * 0.035, this.pos.z)
  }

  forward(out = new THREE.Vector3()) {
    const cp = Math.cos(this.pitch)
    return out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp)
  }

  private collides() {
    const p = this.pos
    return this.world.boxHits(p.x - PLAYER_RADIUS, p.y, p.z - PLAYER_RADIUS, p.x + PLAYER_RADIUS, p.y + PLAYER_HEIGHT, p.z + PLAYER_RADIUS)
  }

  private moveHorizontal(axis: 'x' | 'z', d: number) {
    if (!d) return
    const steps = Math.ceil(Math.abs(d) / 0.2)
    const per = d / steps
    for (let i = 0; i < steps; i++) {
      this.pos[axis] += per
      if (!this.collides()) continue
      // try stepping up onto a low ledge
      if (this.onGround) {
        const y0 = this.pos.y
        this.pos.y += STEP_HEIGHT
        if (!this.collides()) {
          this.settle()
          this.stepOffset += this.pos.y - y0
          continue
        }
        this.pos.y = y0
      }
      this.pos[axis] -= per
      this.vel[axis] = 0
      return
    }
  }

  // After a step-up, drop back down onto the surface we stepped onto
  private settle() {
    const y0 = this.pos.y
    this.pos.y -= STEP_HEIGHT
    if (this.collides()) this.pos.y = (Math.floor(this.pos.y / VOXEL) + 1) * VOXEL
    if (this.collides()) this.pos.y = y0
  }

  private moveVertical(d: number) {
    const steps = Math.max(1, Math.ceil(Math.abs(d) / 0.2))
    const per = d / steps
    for (let i = 0; i < steps; i++) {
      this.pos.y += per
      if (!this.collides()) continue
      if (per < 0) {
        this.pos.y = (Math.floor(this.pos.y / VOXEL) + 1) * VOXEL
        if (!this.onGround) this.onLand?.(-this.vel.y)
        this.onGround = true
      } else {
        this.pos.y -= per
      }
      this.vel.y = 0
      return
    }
    this.onGround = false
  }
}

function clamp(v: number, max: number) {
  return Math.max(-max, Math.min(max, v))
}
