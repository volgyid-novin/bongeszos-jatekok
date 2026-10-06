import * as THREE from 'three'
import { AT_BASE, CARRIED, DROPPED, type Flags } from './ctf'
import { chest, type Entity } from './entity'
import { FLAG_BASES, NAV, navNodesTagged } from './mapgen'
import type { MoveInput } from './player'
import type { Loadout } from './weapons'
import type { VoxelWorld } from './world'

export type BotRole = 'attack' | 'defend' | 'roam'

export interface BotEnv {
  world: VoxelWorld
  ents: Entity[]
  flags: Flags
  isAlive(e: Entity): boolean
  isProtected(e: Entity): boolean
  fire(bot: Entity, dir: THREE.Vector3): void
}

const tmp = new THREE.Vector3()

// ---- path finding over the hand-placed nav graph ------------------------------------------------

// Closest nav node we can actually see (so we never pick one behind a wall)
function nearestNode(p: THREE.Vector3, world?: VoxelWorld) {
  const ranked = NAV.map((n) => ({ n, d: Math.hypot(n.pos.x - p.x, n.pos.z - p.z) + Math.abs(n.pos.y - p.y) * 3 })).sort((a, b) => a.d - b.d)
  if (!world) return ranked[0].n.id
  const eye = p.clone().add(new THREE.Vector3(0, 1.2, 0))
  for (const { n } of ranked.slice(0, 8)) {
    const to = n.pos.clone().add(new THREE.Vector3(0, 1.2, 0)).sub(eye)
    const len = to.length()
    if (len < 0.5 || !world.raycast(eye, to.divideScalar(len), len)) return n.id
  }
  return ranked[0].n.id
}

function astar(from: number, to: number): number[] {
  if (from === to) return [to]
  const g = new Map<number, number>([[from, 0]])
  const prev = new Map<number, number>()
  const open = new Set([from])
  const h = (i: number) => NAV[i].pos.distanceTo(NAV[to].pos)
  while (open.size) {
    let cur = -1
    let curF = Infinity
    for (const i of open) {
      const f = g.get(i)! + h(i)
      if (f < curF) {
        curF = f
        cur = i
      }
    }
    if (cur === to) break
    open.delete(cur)
    for (const l of NAV[cur].links) {
      const cost = g.get(cur)! + NAV[cur].pos.distanceTo(NAV[l.to].pos)
      if (cost < (g.get(l.to) ?? Infinity)) {
        g.set(l.to, cost)
        prev.set(l.to, cur)
        open.add(l.to)
      }
    }
  }
  if (!prev.has(to)) return []
  const path = [to]
  let c = to
  while (prev.has(c) && prev.get(c) !== from) {
    c = prev.get(c)!
    path.unshift(c)
  }
  return path
}

// the three ways across the middle: left lane, ridge, right lane
const MID_NODES = NAV.filter((n) => n.team === -1)

function pickLane() {
  return MID_NODES[Math.floor(Math.random() * MID_NODES.length)].id
}

// ---- the brain ----------------------------------------------------------------------------------------

export class BotBrain {
  private path: number[] = []
  private lastNode = -1
  private goal = new THREE.Vector3()
  private goalNode = -1
  private goalT = 0
  private patrolT = 0
  private target: Entity | null = null
  private scanT = 0
  private reactT = 0
  private aimErr = new THREE.Vector2()
  private strafe = 1
  private strafeT = 0
  private stuckT = 0
  private lastPos = new THREE.Vector3()
  private jumpHold = 0
  private lane = pickLane() // which way across the middle this life
  private hurtT = 0 // recently shot: fight back
  private progressT = 0 // time without getting closer to the next node
  private bestDist = Infinity
  private burst = 4 // shots left in the current burst
  private pause = 0 // pause between bursts


  constructor(readonly role: BotRole) {}

  reset() {
    this.lane = pickLane()
    this.path = []
    this.goalNode = -1
    this.goalT = 0
    this.target = null
    this.stuckT = 0
    this.progressT = 0
    this.bestDist = Infinity
  }

  // Someone shot us: look at them
  onHurt(attacker: Entity) {
    this.hurtT = 2.5
    if (!this.target || this.role === 'attack') {
      this.target = attacker
      this.reactT = 0.25
      this.aimErr.set((Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.2)
    }
  }

  update(dt: number, me: Entity, env: BotEnv): MoveInput {
    const body = me.body!
    const lo = me.loadout!

    // ---- objectives
    this.goalT -= dt
    this.patrolT -= dt
    if (this.goalT <= 0) {
      this.goalT = 0.5
      this.chooseGoal(me, env)
    }

    // ---- enemies
    this.hurtT -= dt
    this.scanT -= dt
    if (this.scanT <= 0) {
      this.scanT = 0.2
      this.scan(me, env)
    }
    if (this.target && (!env.isAlive(this.target) || env.isProtected(this.target))) this.target = null

    // ---- steering along the path
    let moveTo: THREE.Vector3 | null = null
    let hold = false
    if (this.path.length) {
      const n = NAV[this.path[0]]
      const reached = Math.hypot(n.pos.x - body.pos.x, n.pos.z - body.pos.z) < 0.9 && Math.abs(n.pos.y - body.pos.y) < 1.6
      if (reached) {
        this.lastNode = this.path.shift()!
        this.progressT = 0
        this.bestDist = Infinity
      } else {
        // not getting any closer (wrong floor, blocked, knocked off the route): plan again
        const d = n.pos.distanceTo(body.pos)
        if (d < this.bestDist - 0.3) {
          this.bestDist = d
          this.progressT = 0
        } else if ((this.progressT += dt) > 3) {
          this.path = []
          this.goalNode = -1
          this.progressT = 0
          this.bestDist = Infinity
        }
      }
      if (this.path.length) {
        const next = NAV[this.path[0]]
        const viaLift = this.lastNode >= 0 && NAV[this.lastNode].links.some((l) => l.to === next.id && l.jump)
        if (viaLift && body.pos.y < next.pos.y - 0.2) {
          // riding a lift: stay centred over the pad until we are above the next floor
          moveTo = NAV[this.lastNode].pos
          hold = true
        } else {
          moveTo = next.pos
        }
      }
    }
    if (!moveTo && body.pos.distanceTo(this.goal) > 1) moveTo = this.goal

    const dir = new THREE.Vector3()
    if (moveTo) {
      dir.set(moveTo.x - body.pos.x, 0, moveTo.z - body.pos.z)
      const len = dir.length()
      if (len > 0.05) dir.divideScalar(len)
      if (hold && len < 0.25) dir.set(0, 0, 0)
    }

    // ---- combat: aim, strafe, shoot
    let wantYaw = dir.lengthSq() > 0 ? Math.atan2(-dir.x, -dir.z) : body.yaw
    let wantPitch = 0
    if (this.target) {
      const eye = body.eye()
      const aim = chest(this.target)
      if (Math.random() < 0.15) aim.y += 0.55
      const to = aim.sub(eye)
      const dist = to.length()
      this.pickWeapon(lo, dist)
      wantYaw = Math.atan2(-to.x, -to.z)
      wantPitch = Math.atan2(to.y, Math.hypot(to.x, to.z))
      // aim error shrinks while tracking, but never to zero
      const base = 0.026 + dist * 0.001
      this.aimErr.multiplyScalar(Math.exp(-dt * 2.2))
      wantYaw += this.aimErr.x + (Math.random() - 0.5) * base
      wantPitch += this.aimErr.y + (Math.random() - 0.5) * base * 0.7
      this.reactT -= dt
      // strafe, but not off a ledge
      this.strafeT -= dt
      if (this.strafeT <= 0) {
        this.strafeT = 0.5 + Math.random()
        this.strafe = -this.strafe
      }
      const side = new THREE.Vector3(Math.cos(wantYaw), 0, -Math.sin(wantYaw)).multiplyScalar(this.strafe * 0.7)
      if (this.groundAhead(env.world, body.pos, side)) dir.add(side)
      else this.strafe = -this.strafe
    } else if (lo.state.mag < lo.def.mag / 2) {
      lo.startReload()
    }

    // turn with a limited rate
    let dy = wantYaw - body.yaw
    dy = Math.atan2(Math.sin(dy), Math.cos(dy))
    const turn = 6 * dt
    body.yaw += Math.max(-turn, Math.min(turn, dy))
    body.pitch += Math.max(-turn, Math.min(turn, wantPitch - body.pitch))

    this.pause -= dt
    if (this.target && this.reactT <= 0 && this.pause <= 0 && Math.abs(dy) < (lo.def.id === 'shotgun' ? 0.15 : 0.06) && lo.canFire()) {
      env.fire(me, forward(body.yaw, body.pitch))
      // fire in short bursts, then re-aim
      if (--this.burst <= 0) {
        this.burst = 3 + Math.floor(Math.random() * 4)
        this.pause = 0.35 + Math.random() * 0.45
        this.aimErr.add(new THREE.Vector2((Math.random() - 0.5) * 0.12, (Math.random() - 0.5) * 0.06))
      }
    }

    // ---- stuck detection
    const moved = Math.hypot(body.pos.x - this.lastPos.x, body.pos.z - this.lastPos.z)
    if (dir.lengthSq() > 0.1 && moved < dt * 1.5) this.stuckT += dt
    else this.stuckT = Math.max(0, this.stuckT - dt)
    this.lastPos.copy(body.pos)
    let jump = false
    if (this.stuckT > 0.5) {
      jump = true
      this.jumpHold = 0.2
    }
    if (this.stuckT > 2.5) {
      this.stuckT = 0
      this.path = []
      this.goalNode = -1
    }
    this.jumpHold -= dt

    // world-space direction -> input relative to our facing
    const fx = -Math.sin(body.yaw), fz = -Math.cos(body.yaw)
    const rx = Math.cos(body.yaw), rz = -Math.sin(body.yaw)
    return {
      forward: dir.x * fx + dir.z * fz,
      right: dir.x * rx + dir.z * rz,
      jump: jump || this.jumpHold > 0,
    }
  }

  private chooseGoal(me: Entity, env: BotEnv) {
    const { flags, ents } = env
    const mine = flags.states[me.team]
    const theirs = flags.states[1 - me.team]
    const goal = new THREE.Vector3()
    let node = -1

    if (flags.carriedBy(me.id) >= 0) {
      goal.copy(FLAG_BASES[me.team]) // run home
    } else if (mine.s === CARRIED && this.role !== 'attack') {
      goal.copy(ents[mine.by].pos) // hunt the thief
    } else if (mine.s === DROPPED && this.role !== 'attack') {
      goal.copy(mine.pos) // return our flag
    } else if (this.role === 'attack' || (this.role === 'roam' && Math.random() < 0.3)) {
      if (theirs.s === AT_BASE) goal.copy(FLAG_BASES[1 - me.team])
      else if (theirs.s === DROPPED) goal.copy(theirs.pos)
      else goal.copy(ents[theirs.by].pos) // escort our carrier
    } else {
      // defend / roam: wander between interesting spots
      if (this.patrolT > 0 && this.goalNode >= 0) return
      this.patrolT = 6 + Math.random() * 6
      const spots = this.role === 'defend'
        ? [...navNodesTagged(me.team, 'tower'), ...navNodesTagged(me.team, 'tower'), ...navNodesTagged(me.team, 'front'), ...navNodesTagged(me.team, 'base')]
        : Math.random() < 0.5 ? navNodesTagged(me.team, 'mid') : navNodesTagged(1 - me.team, 'front')
      const pick = spots[Math.floor(Math.random() * spots.length)]
      goal.copy(pick.pos)
      node = pick.id
    }

    if (node < 0) node = nearestNode(goal)
    this.goal.copy(goal)
    if (node !== this.goalNode || !this.path.length) {
      this.goalNode = node
      const start = this.path.length ? this.path[0] : nearestNode(me.pos, env.world)
      // cross the middle through a random lane so not everyone meets on the ridge
      const crosses = Math.sign(NAV[start].pos.z) !== Math.sign(NAV[node].pos.z)
      if (crosses) {
        this.path = [...astar(start, this.lane), ...astar(this.lane, node)]
      } else {
        this.path = astar(start, node)
      }
      if (this.path[0] !== start) this.path.unshift(start)
    }
  }

  private scan(me: Entity, env: BotEnv) {
    const eye = me.body!.eye()
    // attackers and flag carriers focus on the objective: only close threats
    const carrying = env.flags.carriedBy(me.id) >= 0
    const focused = this.role === 'attack' || carrying
    const maxRange = carrying ? 12 : focused ? 18 : this.role === 'defend' ? 45 : 60
    if (focused && this.target && env.isAlive(this.target) && this.hurtT > 0) return // keep fighting whoever shot us
    let best: Entity | null = null
    let bestScore = Infinity
    for (const e of env.ents) {
      if (e.team === me.team || !env.isAlive(e) || env.isProtected(e)) continue
      const c = chest(e, tmp)
      const d = c.distanceTo(eye)
      if (d > maxRange) continue
      const dir = c.clone().sub(eye).normalize()
      if (env.world.raycast(eye, dir, d)) continue
      // flag carriers are top priority
      const score = d - (env.flags.carriedBy(e.id) >= 0 ? 40 : 0)
      if (score < bestScore) {
        bestScore = score
        best = e
      }
    }
    if (best && best !== this.target) {
      this.reactT = 0.35 + Math.random() * 0.4
      this.aimErr.set((Math.random() - 0.5) * 0.35, (Math.random() - 0.5) * 0.15)
    }
    this.target = best
  }

  private pickWeapon(lo: Loadout, dist: number) {
    const has = (slot: number) => lo.slots[slot].owned && lo.slots[slot].mag + lo.slots[slot].reserve > 0
    let want = has(1) ? 1 : 0
    if (dist < 9 && has(2)) want = 2
    else if (dist > 7 && dist < 35 && has(3)) want = 3
    else if (dist > 30 && has(4)) want = 4
    if (want !== lo.current && !lo.busy) lo.switchTo(want)
  }

  private groundAhead(world: VoxelWorld, p: THREE.Vector3, d: THREE.Vector3) {
    const x = p.x + d.x * 1.2
    const z = p.z + d.z * 1.2
    for (let y = p.y - 0.1; y > p.y - 2.5; y -= 0.5) if (world.solid(world.vx(x), world.vy(y), world.vz(z))) return true
    return false
  }
}

export function forward(yaw: number, pitch: number) {
  const cp = Math.cos(pitch)
  return new THREE.Vector3(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp)
}

export function roleFor(index: number, withHuman: boolean): BotRole {
  const roles: BotRole[] = withHuman ? ['attack', 'defend', 'roam'] : ['attack', 'attack', 'defend', 'roam']
  return roles[index % roles.length]
}
