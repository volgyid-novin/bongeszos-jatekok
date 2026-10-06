import * as THREE from 'three'
import { CHUNK, VOXEL, WORLD_X, WORLD_Y, WORLD_Z } from '../config'

export const OX = (WORLD_X * VOXEL) / 2
export const OZ = (WORLD_Z * VOXEL) / 2

export const B = {
  AIR: 0,
  ROCK: 1,
  DIRT_A: 2,
  DIRT_B: 3,
  SAND: 4,
  SAND_DARK: 5,
  STONE: 6,
  GLOW_RED: 7,
  GLOW_BLUE: 8,
  GLOW_GOLD: 9,
  PAD: 10,
  CRATE: 11,
  BOULDER: 12,
  METAL: 13,
  RIDGE: 14,
} as const

interface BlockDef {
  color: number
  glow?: boolean
  hard?: boolean // indestructible
}

const BLOCKS: BlockDef[] = [
  { color: 0 },
  { color: 0x5a4030, hard: true },
  { color: 0x8a6a48, hard: true },
  { color: 0x7d6142, hard: true },
  { color: 0xc8a26a, hard: true },
  { color: 0xa88552, hard: true },
  { color: 0x9c8f7a, hard: true },
  { color: 0xff3b3b, glow: true, hard: true },
  { color: 0x3b8bff, glow: true, hard: true },
  { color: 0xffc860, glow: true, hard: true },
  { color: 0xffe14a, glow: true, hard: true },
  { color: 0x8a5a30 },
  { color: 0x6f5a48 },
  { color: 0x4a4a55, hard: true },
  { color: 0x8f7b62, hard: true },
]

export function blockColor(v: number) {
  return BLOCKS[v]?.color ?? 0xffffff
}

// Faces: normal + 4 corners (unit cube), winding fixed up at load time.
const FACES = [
  { n: [1, 0, 0], c: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]], shade: 0.82 },
  { n: [-1, 0, 0], c: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]], shade: 0.82 },
  { n: [0, 1, 0], c: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]], shade: 1 },
  { n: [0, -1, 0], c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], shade: 0.55 },
  { n: [0, 0, 1], c: [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]], shade: 0.7 },
  { n: [0, 0, -1], c: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]], shade: 0.7 },
]
for (const f of FACES) {
  const [a, b, c] = f.c.map((p) => new THREE.Vector3(...(p as [number, number, number])))
  const nrm = new THREE.Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a))
  if (nrm.dot(new THREE.Vector3(...(f.n as [number, number, number]))) < 0) f.c.reverse()
}
const AO_CURVE = [0.5, 0.68, 0.84, 1]

export interface RayHit {
  dist: number
  point: THREE.Vector3
  normal: THREE.Vector3
  voxel: [number, number, number]
}

interface ChunkMeshes {
  solid: THREE.Mesh
  glow: THREE.Mesh
}

export class VoxelWorld {
  readonly data = new Uint8Array(WORLD_X * WORLD_Y * WORLD_Z)
  private chunks = new Map<string, ChunkMeshes>()
  private dirty = new Set<string>()
  private group: THREE.Group | null = null
  private solidMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.1 })
  private glowMat = new THREE.MeshBasicMaterial({ vertexColors: true })

  // Pass a scene to get meshes; without one the world is data-only (used by the bot).
  constructor(scene?: THREE.Scene) {
    if (scene) {
      this.group = new THREE.Group()
      scene.add(this.group)
    }
  }

  idx(x: number, y: number, z: number) {
    return x + WORLD_X * (z + WORLD_Z * y)
  }

  // Outside the grid is empty space: you can fall off the map.
  get(x: number, y: number, z: number) {
    if (x < 0 || z < 0 || y < 0 || x >= WORLD_X || z >= WORLD_Z || y >= WORLD_Y) return B.AIR
    return this.data[this.idx(x, y, z)]
  }

  solid(x: number, y: number, z: number) {
    return this.get(x, y, z) !== B.AIR
  }

  set(x: number, y: number, z: number, v: number) {
    if (x < 0 || z < 0 || y < 0 || x >= WORLD_X || y >= WORLD_Y || z >= WORLD_Z) return
    this.data[this.idx(x, y, z)] = v
    this.markDirty(x, y, z)
  }

  fill(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, v: number) {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++)
      for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++)
        for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) this.set(x, y, z, v)
  }

  // world metres -> voxel index
  vx(x: number) {
    return Math.floor((x + OX) / VOXEL)
  }
  vy(y: number) {
    return Math.floor(y / VOXEL)
  }
  vz(z: number) {
    return Math.floor((z + OZ) / VOXEL)
  }

  voxelCenter(x: number, y: number, z: number, out = new THREE.Vector3()) {
    return out.set((x + 0.5) * VOXEL - OX, (y + 0.5) * VOXEL, (z + 0.5) * VOXEL - OZ)
  }

  blockAt(p: THREE.Vector3) {
    return this.get(this.vx(p.x), this.vy(p.y), this.vz(p.z))
  }

  // Does an axis-aligned box (metres) overlap any solid voxel?
  boxHits(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number) {
    const e = 1e-4
    const x0 = this.vx(minX + e), x1 = this.vx(maxX - e)
    const y0 = this.vy(minY + e), y1 = this.vy(maxY - e)
    const z0 = this.vz(minZ + e), z1 = this.vz(maxZ - e)
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++) if (this.solid(x, y, z)) return true
    return false
  }

  // Voxel DDA raycast. dir must be normalised.
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): RayHit | null {
    const px = (origin.x + OX) / VOXEL
    const py = origin.y / VOXEL
    const pz = (origin.z + OZ) / VOXEL
    let ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz)
    const sx = Math.sign(dir.x), sy = Math.sign(dir.y), sz = Math.sign(dir.z)
    const dx = sx ? Math.abs(1 / dir.x) : Infinity
    const dy = sy ? Math.abs(1 / dir.y) : Infinity
    const dz = sz ? Math.abs(1 / dir.z) : Infinity
    let tx = sx > 0 ? (ix + 1 - px) * dx : sx < 0 ? (px - ix) * dx : Infinity
    let ty = sy > 0 ? (iy + 1 - py) * dy : sy < 0 ? (py - iy) * dy : Infinity
    let tz = sz > 0 ? (iz + 1 - pz) * dz : sz < 0 ? (pz - iz) * dz : Infinity
    const maxT = maxDist / VOXEL
    let t = 0
    const n = new THREE.Vector3()
    for (let i = 0; i < 1000 && t <= maxT; i++) {
      // left the grid: nothing more to hit
      if (ix < -1 || iz < -1 || iy < -1 || ix > WORLD_X || iz > WORLD_Z || iy > WORLD_Y) return null
      if (this.solid(ix, iy, iz)) {
        return { dist: t * VOXEL, point: origin.clone().addScaledVector(dir, t * VOXEL), normal: n, voxel: [ix, iy, iz] }
      }
      if (tx < ty && tx < tz) {
        ix += sx
        t = tx
        tx += dx
        n.set(-sx, 0, 0)
      } else if (ty < tz) {
        iy += sy
        t = ty
        ty += dy
        n.set(0, -sy, 0)
      } else {
        iz += sz
        t = tz
        tz += dz
        n.set(0, 0, -sz)
      }
    }
    return null
  }

  // Remove destructible voxels inside a sphere. Returns what was removed (for debris).
  explode(center: THREE.Vector3, radius: number) {
    const removed: { x: number; y: number; z: number; v: number }[] = []
    const r = Math.ceil(radius / VOXEL)
    const cx = this.vx(center.x), cy = this.vy(center.y), cz = this.vz(center.z)
    const c = new THREE.Vector3()
    for (let y = cy - r; y <= cy + r; y++)
      for (let z = cz - r; z <= cz + r; z++)
        for (let x = cx - r; x <= cx + r; x++) {
          const v = this.get(x, y, z)
          if (!v || BLOCKS[v]?.hard) continue
          if (this.voxelCenter(x, y, z, c).distanceTo(center) > radius) continue
          this.set(x, y, z, B.AIR)
          removed.push({ x, y, z, v })
        }
    return removed
  }

  // Rebuild meshes for chunks that changed. Call once per frame.
  update() {
    if (!this.group) {
      this.dirty.clear()
      return
    }
    for (const key of this.dirty) {
      const [cx, cy, cz] = key.split(',').map(Number)
      this.buildChunk(cx, cy, cz)
    }
    this.dirty.clear()
  }

  private markDirty(x: number, y: number, z: number) {
    const cx = Math.floor(x / CHUNK), cy = Math.floor(y / CHUNK), cz = Math.floor(z / CHUNK)
    this.dirty.add(`${cx},${cy},${cz}`)
    // neighbours share faces along chunk borders
    if (x % CHUNK === 0 && cx > 0) this.dirty.add(`${cx - 1},${cy},${cz}`)
    if (x % CHUNK === CHUNK - 1) this.dirty.add(`${cx + 1},${cy},${cz}`)
    if (y % CHUNK === 0 && cy > 0) this.dirty.add(`${cx},${cy - 1},${cz}`)
    if (y % CHUNK === CHUNK - 1) this.dirty.add(`${cx},${cy + 1},${cz}`)
    if (z % CHUNK === 0 && cz > 0) this.dirty.add(`${cx},${cy},${cz - 1}`)
    if (z % CHUNK === CHUNK - 1) this.dirty.add(`${cx},${cy},${cz + 1}`)
  }

  private buildChunk(cx: number, cy: number, cz: number) {
    if (cx * CHUNK >= WORLD_X || cy * CHUNK >= WORLD_Y || cz * CHUNK >= WORLD_Z) return
    const key = `${cx},${cy},${cz}`
    const solid = { pos: [] as number[], nor: [] as number[], col: [] as number[], idx: [] as number[] }
    const glow = { pos: [] as number[], nor: [] as number[], col: [] as number[], idx: [] as number[] }
    const col = new THREE.Color()
    const ao = [0, 0, 0, 0]

    for (let y = cy * CHUNK; y < Math.min(WORLD_Y, (cy + 1) * CHUNK); y++)
      for (let z = cz * CHUNK; z < Math.min(WORLD_Z, (cz + 1) * CHUNK); z++)
        for (let x = cx * CHUNK; x < Math.min(WORLD_X, (cx + 1) * CHUNK); x++) {
          const v = this.data[this.idx(x, y, z)]
          if (!v) continue
          const def = BLOCKS[v]
          const out = def.glow ? glow : solid
          const h = (((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) >>> 0) % 255
          const tint = def.glow ? 1.6 : 0.9 + (h / 255) * 0.16
          for (const f of FACES) {
            const [nx, ny, nz] = f.n
            if (this.solid(x + nx, y + ny, z + nz)) continue
            // ambient occlusion per corner
            for (let i = 0; i < 4; i++) {
              if (def.glow) {
                ao[i] = 3
                continue
              }
              const c = f.c[i]
              const ax = nx !== 0 ? [1, 2] : ny !== 0 ? [0, 2] : [0, 1]
              const o = [x + nx, y + ny, z + nz]
              const s1 = [...o], s2 = [...o]
              s1[ax[0]] += c[ax[0]] ? 1 : -1
              s2[ax[1]] += c[ax[1]] ? 1 : -1
              const cr = [...o]
              cr[ax[0]] += c[ax[0]] ? 1 : -1
              cr[ax[1]] += c[ax[1]] ? 1 : -1
              const a = this.solid(s1[0], s1[1], s1[2]) ? 1 : 0
              const b = this.solid(s2[0], s2[1], s2[2]) ? 1 : 0
              const k = this.solid(cr[0], cr[1], cr[2]) ? 1 : 0
              ao[i] = a && b ? 0 : 3 - (a + b + k)
            }
            const base = out.pos.length / 3
            for (let i = 0; i < 4; i++) {
              const c = f.c[i]
              out.pos.push((x + c[0]) * VOXEL - OX, (y + c[1]) * VOXEL, (z + c[2]) * VOXEL - OZ)
              out.nor.push(nx, ny, nz)
              col.setHex(def.color).multiplyScalar(tint * (def.glow ? 1 : f.shade * AO_CURVE[ao[i]]))
              out.col.push(col.r, col.g, col.b)
            }
            if (ao[0] + ao[2] < ao[1] + ao[3]) out.idx.push(base + 1, base + 2, base + 3, base + 1, base + 3, base)
            else out.idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
          }
        }

    let meshes = this.chunks.get(key)
    if (!meshes) {
      meshes = { solid: new THREE.Mesh(new THREE.BufferGeometry(), this.solidMat), glow: new THREE.Mesh(new THREE.BufferGeometry(), this.glowMat) }
      this.group!.add(meshes.solid, meshes.glow)
      this.chunks.set(key, meshes)
    }
    for (const [mesh, d] of [[meshes.solid, solid], [meshes.glow, glow]] as const) {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(d.pos, 3))
      g.setAttribute('normal', new THREE.Float32BufferAttribute(d.nor, 3))
      g.setAttribute('color', new THREE.Float32BufferAttribute(d.col, 3))
      g.setIndex(d.idx)
      g.computeBoundingSphere()
      mesh.geometry.dispose()
      mesh.geometry = g
    }
  }
}
