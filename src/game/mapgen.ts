import * as THREE from 'three'
import { VOXEL, WORLD_Y, WORLD_Z, type ItemKind } from '../config'
import { B, OX, OZ, type VoxelWorld } from './world'

// "ŰRTORNYOK" — two stepped towers facing each other across a floating asteroid.
// Built in voxel indices (48 x 80 x 208, 1 voxel = 0.5 m). The red base is at low z,
// the blue base is the mirror image at high z. Continuous coordinates (x = 24 is the
// centre line, z = 104 is the middle of the map) are used for points.

const MZ = WORLD_Z - 1
const G = 16 // ground surface layer; players stand at y index 17
const STAND = G + 1

export const toWorld = (x: number, y: number, z: number) => new THREE.Vector3(x * VOXEL - OX, y * VOXEL, z * VOXEL - OZ)
const mirrorZ = (z: number) => WORLD_Z - z // for continuous coordinates

function hash(x: number, z: number) {
  const h = Math.sin(x * 127.1 + z * 311.7) * 43758.5453
  return h - Math.floor(h)
}

// Half width (in voxels) of the walkable strip, by distance from the nearer end
function halfWidth(zz: number) {
  if (zz < 3) return 15 - (3 - zz) * 2
  if (zz <= 36) return 18
  if (zz <= 46) return 18 - (zz - 36) * 0.4
  return 14
}

export function buildMap(w: VoxelWorld) {
  // ---- asteroid -----------------------------------------------------------------
  for (let z = 0; z <= MZ; z++) {
    const zz = Math.min(z, MZ - z)
    const hw = halfWidth(zz)
    const x0 = Math.round(24 - hw)
    const x1 = Math.round(24 + hw) - 1
    for (let x = x0; x <= x1; x++) {
      w.set(x, G, z, ((x >> 1) + (z >> 1)) % 2 ? B.DIRT_A : B.DIRT_B)
      // rocky underside: deep in the middle of the strip and under the towers
      const edge = Math.min(x - x0, x1 - x)
      const depth = Math.min(G, Math.floor(2 + edge * 0.75 + Math.max(0, 40 - zz) * 0.18 + hash(x, z) * 2.5))
      for (let y = G - 1; y >= G - depth; y--) w.set(x, y, z, B.ROCK)
    }
  }

  // ---- central ridge with ramps at both ends ----------------------------------------
  for (let z = 75; z <= 132; z++) {
    const h = Math.min(6, Math.floor(Math.min(z - 75, 132 - z) / 3))
    if (h <= 0) continue
    w.fill(18, STAND, z, 29, G + h, z, B.RIDGE)
    if (h === 6 && z % 4 === 0) {
      w.set(18, G + h, z, B.GLOW_GOLD)
      w.set(29, G + h, z, B.GLOW_GOLD)
    }
  }

  // ---- cover (destructible) ---------------------------------------------------------
  const both = (fn: (zf: (z: number) => number) => void) => {
    fn((z) => z)
    fn((z) => MZ - z)
  }
  both((zf) => {
    w.fill(15, STAND, zf(66), 16, STAND + 1, zf(67), B.BOULDER)
    w.fill(31, STAND, zf(84), 32, STAND + 1, zf(85), B.BOULDER)
    w.fill(11, STAND, zf(57), 12, STAND, zf(58), B.BOULDER)
    w.fill(12, STAND, zf(38), 13, STAND + 1, zf(39), B.CRATE)
    w.fill(34, STAND, zf(38), 35, STAND + 1, zf(39), B.CRATE)
    w.fill(14, STAND, zf(40), 14, STAND, zf(40), B.CRATE)
    w.fill(19, STAND, zf(44), 20, STAND, zf(45), B.CRATE)
  })

  tower(w, 0)
  tower(w, 1)
}

function tower(w: VoxelWorld, team: number) {
  const zf = (z: number) => (team === 0 ? z : MZ - z)
  const f = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, v: number) => w.fill(x0, y0, zf(z0), x1, y1, zf(z1), v)
  const glow = team === 0 ? B.GLOW_RED : B.GLOW_BLUE

  // tier 1: base room with the flag
  f(13, STAND, 5, 34, STAND, 26, B.STONE) // plinth
  f(14, STAND, 6, 33, 29, 25, B.SAND)
  f(16, STAND, 8, 31, 29, 23, B.AIR)
  f(21, STAND, 24, 26, 24, 25, B.AIR) // front door
  f(14, STAND, 14, 15, 22, 17, B.AIR) // side doors
  f(32, STAND, 14, 33, 22, 17, B.AIR)
  f(20, STAND, 26, 20, 25, 26, glow) // door frame
  f(27, STAND, 26, 27, 25, 26, glow)
  f(20, 25, 26, 27, 25, 26, glow)
  ring(f, 14, 33, 6, 25, 29, glow)
  f(19, G, 12, 20, G, 13, B.PAD) // lift to level 2

  // level 2 floor (its outer ring is an open balcony)
  f(14, 30, 6, 33, 30, 25, B.STONE)
  f(18, 30, 11, 21, 30, 14, B.AIR) // hole above the lift
  f(26, 30, 18, 27, 30, 19, B.PAD) // lift to the top deck

  // tier 2: sniper room
  f(16, 31, 8, 31, 41, 23, B.SAND_DARK)
  f(18, 31, 10, 29, 41, 21, B.AIR)
  f(21, 31, 22, 26, 36, 23, B.AIR) // front opening onto the balcony
  f(16, 33, 14, 17, 36, 17, B.AIR) // side windows
  f(30, 33, 14, 31, 36, 17, B.AIR)
  ring(f, 16, 31, 8, 23, 41, glow)

  // top deck with battlements
  f(16, 42, 8, 31, 42, 23, B.STONE)
  f(25, 42, 17, 28, 42, 20, B.AIR) // hole above the second lift
  for (let i = 16; i <= 31; i++) {
    if (i % 4 < 2) {
      f(i, 43, 8, i, 44, 8, B.SAND)
      f(i, 43, 23, i, 44, 23, B.SAND)
    }
  }
  for (let i = 8; i <= 23; i++) {
    if (i % 4 < 2) {
      f(16, 43, i, 16, 44, i, B.SAND)
      f(31, 43, i, 31, 44, i, B.SAND)
    }
  }

  // stepped spire and antennas
  f(19, 43, 10, 24, 54, 15, B.SAND)
  f(20, 55, 11, 23, 60, 14, B.SAND_DARK)
  ring(f, 19, 24, 10, 15, 54, glow)
  f(20, 61, 12, 20, Math.min(WORLD_Y - 2, 66), 12, B.STONE)
  f(23, 61, 13, 23, Math.min(WORLD_Y - 2, 66), 13, B.STONE)
  f(20, 67, 12, 20, 67, 12, glow)
  f(23, 67, 13, 23, 67, 13, glow)
}

// One-voxel ring around the outside of a box at height y
function ring(
  f: (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, v: number) => void,
  x0: number, x1: number, z0: number, z1: number, y: number, v: number,
) {
  f(x0, y, z0, x1, y, z0, v)
  f(x0, y, z1, x1, y, z1, v)
  f(x0, y, z0, x0, y, z1, v)
  f(x1, y, z0, x1, y, z1, v)
}

// ---- flags, spawns, items ---------------------------------------------------------------

export const FLAG_BASES = [toWorld(24, STAND, 11), toWorld(24, STAND, mirrorZ(11))]

// Nobody respawns inside the flag room, so a thief has a chance to get out.
const RED_SPAWNS: [number, number, number][] = [
  [20.5, 31, 19], [28.5, 31, 12.5], [9, STAND, 16], [39, STAND, 16],
  [12, STAND, 3], [36, STAND, 3], [29, 43, 10],
]
export const SPAWNS = [
  RED_SPAWNS.map(([x, y, z]) => toWorld(x, y, z)),
  RED_SPAWNS.map(([x, y, z]) => toWorld(x, y, mirrorZ(z))),
]

export function spawnFor(team: number) {
  const list = SPAWNS[team]
  return list[Math.floor(Math.random() * list.length)].clone()
}

// camera yaw that looks down the map towards the enemy base
export function spawnYaw(team: number) {
  return team === 0 ? Math.PI : 0
}

export interface ItemSpawn {
  id: number
  kind: ItemKind
  pos: THREE.Vector3
}

export const ITEMS: ItemSpawn[] = (() => {
  const red: [ItemKind, number, number, number][] = [
    ['sniper', 24, 43.6, 21.5],
    ['shotgun', 14, 17.6, 60],
    ['health', 34, 17.6, 60],
    ['health', 28, 17.6, 17],
    ['armor', 24, 31.6, 17],
  ]
  const list: [ItemKind, number, number, number][] = [['rocket', 24, 23.6, 104]]
  for (const [k, x, y, z] of red) list.push([k, x, y, z], [k, x, y, mirrorZ(z)])
  return list.map(([kind, x, y, z], id) => ({ id, kind, pos: toWorld(x, y, z) }))
})()

// ---- navigation graph for bots ----------------------------------------------------------------

export interface NavLink {
  to: number
  jump?: boolean // lift: wait until airborne above the target before steering
}

export interface NavNode {
  id: number
  pos: THREE.Vector3
  links: NavLink[]
  team: number // -1 neutral, otherwise which base the node belongs to
  tag?: string
}

export const NAV: NavNode[] = (() => {
  // red half; blue is mirrored. z = 104 nodes are shared.
  const pts: Record<string, [number, number, number, string?]> = {
    flag: [24, STAND, 11, 'flag'],
    base: [24, STAND, 18, 'base'],
    pad1: [20, STAND, 13],
    l2land: [24, 31, 13, 'tower'],
    l2pad: [27, 31, 19],
    l2front: [24, 31, 21, 'tower'],
    balcony: [24, 31, 25.5, 'tower'],
    topland: [30, 43, 22, 'tower'], // front corner, so walking to the snipe spot skips the lift hole
    topsnipe: [23, 43, 21.5, 'tower'], // in front of a gap in the battlements
    doorin: [24, STAND, 23],
    doorout: [24, STAND, 28, 'front'],
    sidelIn: [17.5, STAND, 16],
    sidelOut: [12, STAND, 16],
    siderIn: [30.5, STAND, 16],
    siderOut: [36, STAND, 16],
    backl: [12, STAND, 3.5],
    backr: [36, STAND, 3.5],
    yardl: [12, STAND, 31, 'front'],
    yardc: [24, STAND, 33, 'front'],
    yardr: [36, STAND, 31, 'front'],
    lanel1: [14, STAND, 52, 'mid'],
    lanel2: [14, STAND, 72, 'mid'],
    lanel3: [14, STAND, 104, 'mid'],
    laner1: [34, STAND, 52, 'mid'],
    laner2: [34, STAND, 72, 'mid'],
    laner3: [34, STAND, 104, 'mid'],
    ridge0: [24, STAND, 66, 'mid'],
    ridge1: [24, 19, 82, 'mid'],
    ridgetop: [24, 23, 104, 'mid'],
  }
  const links: [string, string, 'both' | 'jump' | 'drop'][] = [
    ['flag', 'base', 'both'],
    ['base', 'pad1', 'both'],
    ['pad1', 'l2land', 'jump'],
    ['l2land', 'l2front', 'both'],
    ['l2land', 'l2pad', 'both'],
    ['l2front', 'l2pad', 'both'],
    ['l2pad', 'topland', 'jump'],
    ['topland', 'topsnipe', 'both'],
    ['topsnipe', 'balcony', 'drop'], // hop down through the battlements
    ['l2front', 'balcony', 'both'],
    ['balcony', 'doorout', 'drop'],
    ['base', 'doorin', 'both'],
    ['doorin', 'doorout', 'both'],
    ['base', 'sidelIn', 'both'],
    ['sidelIn', 'sidelOut', 'both'],
    ['base', 'siderIn', 'both'],
    ['siderIn', 'siderOut', 'both'],
    ['backl', 'sidelOut', 'both'],
    ['backr', 'siderOut', 'both'],
    ['doorout', 'yardc', 'both'],
    ['sidelOut', 'yardl', 'both'],
    ['siderOut', 'yardr', 'both'],
    ['yardl', 'yardc', 'both'],
    ['yardc', 'yardr', 'both'],
    ['yardl', 'lanel1', 'both'],
    ['lanel1', 'lanel2', 'both'],
    ['lanel2', 'lanel3', 'both'],
    ['yardr', 'laner1', 'both'],
    ['laner1', 'laner2', 'both'],
    ['laner2', 'laner3', 'both'],
    ['yardc', 'ridge0', 'both'],
    ['ridge0', 'lanel1', 'both'],
    ['ridge0', 'laner1', 'both'],
    ['ridge0', 'ridge1', 'both'],
    ['ridge1', 'ridgetop', 'both'],
    ['ridgetop', 'lanel3', 'drop'],
    ['ridgetop', 'laner3', 'drop'],
  ]

  const nodes: NavNode[] = []
  const index = new Map<string, number>()
  for (const team of [0, 1]) {
    for (const [name, [x, y, z, tag]] of Object.entries(pts)) {
      const shared = z === 104
      if (shared && team === 1) continue
      const key = shared ? name : `${team}:${name}`
      index.set(key, nodes.length)
      nodes.push({ id: nodes.length, pos: toWorld(x, y, team === 0 ? z : mirrorZ(z)), links: [], team: shared ? -1 : team, tag })
    }
  }
  const id = (team: number, name: string) => index.get(index.has(name) ? name : `${team}:${name}`)!
  for (const team of [0, 1]) {
    for (const [a, b, kind] of links) {
      const ia = id(team, a)
      const ib = id(team, b)
      const add = (from: number, to: number, jump = false) => {
        if (!nodes[from].links.some((l) => l.to === to)) nodes[from].links.push({ to, jump })
      }
      if (kind === 'both') {
        add(ia, ib)
        add(ib, ia)
      } else {
        add(ia, ib, kind === 'jump')
      }
    }
  }
  return nodes
})()

export function navNodesTagged(team: number, tag: string) {
  return NAV.filter((n) => n.tag === tag && (n.team === team || n.team === -1))
}
