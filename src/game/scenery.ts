import * as THREE from 'three'
import { makeRng } from '../rng'
import { planetTextures } from './textures'

// Space backdrop: a huge planet with clouds and atmosphere, drifting asteroids and stars.
export function buildScenery(scene: THREE.Scene) {
  scene.background = new THREE.Color(0x020308)
  scene.fog = null

  scene.add(new THREE.HemisphereLight(0x9cc4ff, 0x3a2a20, 1.1))
  const sun = new THREE.DirectionalLight(0xfff0dd, 2.4)
  sun.position.set(60, 50, 30)
  scene.add(sun)
  const planetShine = new THREE.DirectionalLight(0x4a7dff, 0.7)
  planetShine.position.set(-80, -10, 0)
  scene.add(planetShine)

  const rand = makeRng(5)

  // stars
  const starPos: number[] = []
  const starCol: number[] = []
  for (let i = 0; i < 4000; i++) {
    const v = new THREE.Vector3(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1).normalize().multiplyScalar(2500)
    starPos.push(v.x, v.y, v.z)
    const b = 0.5 + rand() * 0.5
    starCol.push(b, b, b * (0.9 + rand() * 0.2))
  }
  const starGeo = new THREE.BufferGeometry()
  starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3))
  starGeo.setAttribute('color', new THREE.Float32BufferAttribute(starCol, 3))
  scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true })))

  // planet
  const { surface, clouds } = planetTextures()
  const R = 700
  const planet = new THREE.Group()
  planet.position.set(-1050, -260, 120)
  const ground = new THREE.Mesh(new THREE.SphereGeometry(R, 96, 64), new THREE.MeshStandardMaterial({ map: surface, roughness: 0.9, metalness: 0 }))
  planet.add(ground)
  const cloudMesh = new THREE.Mesh(
    new THREE.SphereGeometry(R * 1.012, 96, 64),
    new THREE.MeshStandardMaterial({ map: clouds, transparent: true, depthWrite: false, roughness: 1 }),
  )
  planet.add(cloudMesh)
  const atmosphere = new THREE.Mesh(
    new THREE.SphereGeometry(R * 1.08, 96, 64),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      vertexShader: `varying vec3 vN; varying vec3 vV;
        void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying vec3 vN; varying vec3 vV;
        void main() { float r = 1.0 - abs(dot(vN, vV)); float a = pow(r, 2.5) * 1.6; gl_FragColor = vec4(0.25, 0.55, 1.0, 1.0) * a; }`,
    }),
  )
  planet.add(atmosphere)
  planet.rotation.z = 0.35
  scene.add(planet)

  // asteroids
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x6a5a4c, roughness: 1, flatShading: true })
  const rocks: { mesh: THREE.Mesh; spin: THREE.Vector3 }[] = []
  const makeRock = (pos: THREE.Vector3, size: number) => {
    const geo = new THREE.IcosahedronGeometry(1, 2)
    const p = geo.attributes.position as THREE.BufferAttribute
    const v = new THREE.Vector3()
    const [a, b, c] = [rand() * 10, rand() * 10, rand() * 10]
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i)
      // displacement depends only on direction, so duplicated vertices stay welded
      const s = 0.85 + 0.2 * Math.sin(v.x * 3.1 + a) * Math.sin(v.y * 2.7 + b) + 0.12 * Math.sin(v.z * 4.3 + c)
      v.multiplyScalar(s)
      p.setXYZ(i, v.x, v.y * 0.8, v.z)
    }
    geo.computeVertexNormals()
    const mesh = new THREE.Mesh(geo, rockMat)
    mesh.position.copy(pos)
    mesh.scale.setScalar(size)
    mesh.rotation.set(rand() * 3, rand() * 3, rand() * 3)
    scene.add(mesh)
    rocks.push({ mesh, spin: new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).multiplyScalar(0.02) })
  }
  makeRock(new THREE.Vector3(18, -38, 10), 16)
  makeRock(new THREE.Vector3(-30, -55, -60), 22)
  for (let i = 0; i < 26; i++) {
    const a = rand() * Math.PI * 2
    const r = 90 + rand() * 300
    makeRock(new THREE.Vector3(Math.cos(a) * r + 120, (rand() - 0.4) * 160, Math.sin(a) * r), 3 + rand() * 18)
  }

  return {
    update(dt: number) {
      cloudMesh.rotation.y += dt * 0.004
      ground.rotation.y += dt * 0.0015
      for (const r of rocks) {
        r.mesh.rotation.x += r.spin.x * dt
        r.mesh.rotation.y += r.spin.y * dt
      }
    },
  }
}
