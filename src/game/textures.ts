import * as THREE from 'three'

function canvas(w: number, h: number) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return [c, c.getContext('2d')!] as const
}

function tex(c: HTMLCanvasElement) {
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  return t
}

export function labelTexture(text: string, color: string) {
  const [c, g] = canvas(512, 128)
  g.font = 'bold 60px Orbitron, Rajdhani, sans-serif'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.shadowColor = 'rgba(0,0,0,0.9)'
  g.shadowBlur = 10
  g.fillStyle = color
  g.fillText(text, 256, 64)
  return tex(c)
}

// Soft round glow for pickups and explosions
export function glowTexture() {
  const [c, g] = canvas(128, 128)
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.3, 'rgba(255,255,255,0.5)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, 128, 128)
  return tex(c)
}

// ---- procedural planet ---------------------------------------------------------------------

function hash3(x: number, y: number, z: number) {
  let h = (x * 374761393 + y * 668265263 + z * 1274126177) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

function noise3(x: number, y: number, z: number) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z)
  const xf = x - xi, yf = y - yi, zf = z - zi
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf)
  const l = (a: number, b: number, t: number) => a + (b - a) * t
  const c = (dx: number, dy: number, dz: number) => hash3(xi + dx, yi + dy, zi + dz)
  return l(
    l(l(c(0, 0, 0), c(1, 0, 0), u), l(c(0, 1, 0), c(1, 1, 0), u), v),
    l(l(c(0, 0, 1), c(1, 0, 1), u), l(c(0, 1, 1), c(1, 1, 1), u), v),
    w,
  )
}

function fbm(x: number, y: number, z: number, oct: number) {
  let a = 0.5, f = 1, s = 0
  for (let i = 0; i < oct; i++) {
    s += a * noise3(x * f, y * f, z * f)
    f *= 2.03
    a *= 0.5
  }
  return s
}

// Earth-like equirectangular surface + cloud layer, sampled from 3D noise so there is no seam.
export function planetTextures(w = 1024, h = 512) {
  const [sc, sg] = canvas(w, h)
  const [cc, cg] = canvas(w, h)
  const surf = sg.createImageData(w, h)
  const cloud = cg.createImageData(w, h)
  const mix = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i] - v) * t)
  const deep = [8, 30, 90], shallow = [30, 95, 170]
  const green = [70, 110, 50], desert = [190, 150, 95], mountain = [120, 95, 75]
  for (let j = 0; j < h; j++) {
    const lat = (0.5 - j / h) * Math.PI
    for (let i = 0; i < w; i++) {
      const lon = (i / w) * Math.PI * 2
      const x = Math.cos(lat) * Math.cos(lon), y = Math.sin(lat), z = Math.cos(lat) * Math.sin(lon)
      const n = fbm(x * 2.2 + 5, y * 2.2, z * 2.2, 6)
      const k = (j * w + i) * 4
      let col: number[]
      if (n < 0.5) {
        col = mix(deep, shallow, Math.pow(n / 0.5, 3))
      } else {
        const t = (n - 0.5) / 0.25
        const dry = fbm(x * 4 + 11, y * 4, z * 4, 3)
        col = mix(mix(green, desert, Math.min(1, dry * 1.6 - 0.2)), mountain, Math.min(1, Math.max(0, t - 0.6)))
      }
      if (Math.abs(lat) > 1.2) col = mix(col, [240, 245, 255], Math.min(1, (Math.abs(lat) - 1.2) * 6))
      surf.data[k] = col[0]
      surf.data[k + 1] = col[1]
      surf.data[k + 2] = col[2]
      surf.data[k + 3] = 255
      const cn = fbm(x * 3 + 40, y * 3, z * 3, 5)
      const a = Math.max(0, Math.min(1, (cn - 0.52) * 4))
      cloud.data[k] = cloud.data[k + 1] = cloud.data[k + 2] = 255
      cloud.data[k + 3] = a * 230
    }
  }
  sg.putImageData(surf, 0, 0)
  cg.putImageData(cloud, 0, 0)
  return { surface: tex(sc), clouds: tex(cc) }
}
