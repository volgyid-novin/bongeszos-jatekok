// Sky and light: theme-driven sky dome shader (gradient / clouds / nebula / stars + sun disc), fog, a hemisphere light, one
// directional "sun" with a shadow box that follows the player, and an environment map made from the dome (reflections +
// ambient for the PBR materials).
//
//   const sky = new Sky(scene, renderer, quality);
//   sky.setTheme(theme)                  theme = world.map.theme (normalised)
//   sky.update(camPos, playerPos, t)     dome follows the camera, the shadow box follows the player (texel snapped)
//   sky.setQuality(quality)  sky.dispose()
import * as THREE from 'three';

// The sky is expensive (fbm clouds / nebula / stars), so it is baked once per map into a cube map; the dome only samples it
// (and adds the sun disc), and turns slowly so clouds and stars drift.
const BAKE_V = /* glsl */`
varying vec3 vDir;
void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const BAKE_F = /* glsl */`
uniform vec3 uTop, uHorizon, uBottom;
uniform float uStars, uClouds;
uniform vec3 uSunDir, uSunColor;
uniform int uType;
uniform vec3 uCloudA, uCloudB;                 // cloud colour in shade / in the sun
uniform vec4 uPlanet;                          // xyz direction, w angular radius (0 = no planet)
uniform vec3 uPlanetSea, uPlanetLand, uPlanetAtmo;
varying vec3 vDir;
float h31(vec3 p) { p = fract(p * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yxz + 33.33); return fract((p.x + p.y) * p.z); }
float vn3(vec3 p) {
  vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h31(i), h31(i + vec3(1, 0, 0)), f.x), mix(h31(i + vec3(0, 1, 0)), h31(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(h31(i + vec3(0, 0, 1)), h31(i + vec3(1, 0, 1)), f.x), mix(h31(i + vec3(0, 1, 1)), h31(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float fbm(vec3 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * vn3(p); p = p * 2.02 + 11.7; a *= 0.5; } return s; }
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col;
  if (h >= 0.0) col = mix(uHorizon, uTop, pow(h, 0.5));
  else col = mix(uHorizon, uBottom, smoothstep(0.0, 0.35, -h));
  float sd = max(dot(d, uSunDir), 0.0);
  if (uType >= 2) {
    float n1 = fbm(d * 2.3);
    float n2 = fbm(d * 4.6 + 7.0);
    vec3 base = mix(uBottom, uTop, 0.5 + 0.5 * h) * 0.55;
    float neb = pow(smoothstep(0.38, 0.85, n1), 1.4);
    vec3 ncol = mix(uHorizon, uTop * 2.0, n2);
    col = base + ncol * neb * (uType == 2 ? 1.1 : 0.45);
    vec3 bn = normalize(vec3(0.3, 1.0, 0.2));
    float band = exp(-pow(dot(d, bn) * 3.2, 2.0)) * smoothstep(0.35, 0.8, fbm(d * 3.0 + 3.0));
    col += mix(uHorizon, vec3(1.0), 0.5) * band * 0.35;
  }
  if (uStars > 0.0) {
    vec3 sp = d * 120.0;
    vec3 cell = floor(sp);
    float r = h31(cell);
    float on = step(1.0 - 0.014 * uStars, r);
    vec3 f = fract(sp) - 0.5;
    float dist = length(f - (vec3(h31(cell + 1.7), h31(cell + 3.1), h31(cell + 5.3)) - 0.5) * 0.5);
    float star = on * smoothstep(0.3, 0.0, dist) * (0.55 + 0.9 * h31(cell + 9.0));
    float vis = uType >= 2 ? 1.0 : smoothstep(0.1, 0.9, h) * 0.8;
    col += vec3(0.85, 0.92, 1.0) * star * 2.0 * vis;
  }
  if (uClouds > 0.0 && h > 0.01 && uType < 2) {
    vec2 uv = d.xz / (h + 0.22);
    float n = fbm(vec3(uv * 0.85, 1.7));
    float cov = smoothstep(1.0 - uClouds * 0.9, 1.0 - uClouds * 0.9 + 0.22, n);
    float lit = 0.6 + 0.4 * smoothstep(0.0, 1.0, dot(d, uSunDir) * 0.5 + 0.5);
    vec3 cc = mix(uCloudA, uCloudB, lit) * mix(0.75, 1.0, n);
    cc = mix(cc, uSunColor, pow(sd, 6.0) * 0.4);
    col = mix(col, cc, cov * smoothstep(0.01, 0.16, h) * 0.92);
  }
  if (uPlanet.w > 0.0) {
    // a lit planet disc in front of the stars: oceans, continents, clouds, a thin atmosphere rim and halo
    vec3 pd = normalize(uPlanet.xyz);
    vec3 t1 = normalize(cross(pd, abs(pd.y) > 0.99 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0)));
    vec3 t2 = cross(t1, pd);
    vec3 off = d - pd * dot(d, pd);
    vec2 q = vec2(dot(off, t1), dot(off, t2)) / sin(uPlanet.w);
    float r2 = dot(q, q);
    if (dot(d, pd) > 0.0 && r2 < 1.0) {
      vec3 n = normalize(q.x * t1 + q.y * t2 - pd * sqrt(1.0 - r2));
      float land = smoothstep(0.5, 0.56, fbm(n * 2.6 + 5.0));
      float cl = smoothstep(0.52, 0.72, fbm(n * 5.2 + 17.0));
      vec3 surf = mix(mix(uPlanetSea, uPlanetLand, land), vec3(0.95), cl * 0.85);
      float lit = max(dot(n, uSunDir), 0.0);
      col = surf * (0.03 + 1.15 * lit) + uPlanetAtmo * pow(1.0 - sqrt(1.0 - r2), 2.5) * (0.15 + 1.2 * lit);
    } else if (dot(d, pd) > 0.0) {
      float lit = max(dot(normalize(q.x * t1 + q.y * t2), uSunDir), 0.0);
      col += uPlanetAtmo * exp(-(sqrt(r2) - 1.0) * 30.0) * (0.1 + 0.9 * lit) * 0.8;
    }
  }
  gl_FragColor = vec4(col, 1.0);
}`;
const DOME_V = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_Position.z = gl_Position.w * 0.99999;
}`;
const DOME_F = /* glsl */`
uniform samplerCube uSky;
uniform vec3 uSunDir, uSunColor;
uniform mat3 uRot;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  vec3 col = textureCube(uSky, uRot * d).rgb;
  float sd = max(dot(d, uSunDir), 0.0);
  col += uSunColor * (pow(sd, 900.0) * 9.0 + pow(sd, 60.0) * 0.45 + pow(sd, 7.0) * 0.1);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const SHADOW_HALF = 36;

export class Sky {
  constructor(scene, renderer, quality) {
    this.scene = scene;
    this.renderer = renderer;
    this.quality = quality;
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x445058, 1);
    this.sun = new THREE.DirectionalLight(0xffffff, 1.5);
    this.sun.shadow.camera.left = -SHADOW_HALF; this.sun.shadow.camera.right = SHADOW_HALF;
    this.sun.shadow.camera.top = SHADOW_HALF; this.sun.shadow.camera.bottom = -SHADOW_HALF;
    this.sun.shadow.camera.near = 1; this.sun.shadow.camera.far = 200;
    this.sun.shadow.bias = -0.0006; this.sun.shadow.normalBias = 0.05;
    this.sunDir = new THREE.Vector3(0.4, 0.8, 0.3).normalize();
    this.sunDirU = this.sunDir.clone();
    this.bakeUniforms = {
      uTop: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uBottom: { value: new THREE.Color() },
      uSunDir: { value: this.sunDirU }, uSunColor: { value: new THREE.Color() },
      uStars: { value: 0 }, uClouds: { value: 0 }, uType: { value: 0 },
      uCloudA: { value: new THREE.Color() }, uCloudB: { value: new THREE.Color() },
      uPlanet: { value: new THREE.Vector4() },
      uPlanetSea: { value: new THREE.Color() }, uPlanetLand: { value: new THREE.Color() }, uPlanetAtmo: { value: new THREE.Color() },
    };
    this.bakeMat = new THREE.ShaderMaterial({ uniforms: this.bakeUniforms, vertexShader: BAKE_V, fragmentShader: BAKE_F, side: THREE.BackSide, depthTest: false, depthWrite: false });
    this.bakeScene = new THREE.Scene();
    this.bakeScene.add(new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), this.bakeMat));
    this.uniforms = {
      uSky: { value: null }, uSunDir: { value: this.sunDirU }, uSunColor: this.bakeUniforms.uSunColor, uRot: { value: new THREE.Matrix3() },
    };
    this.mat = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: DOME_V, fragmentShader: DOME_F, side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false });
    this.rt = null;
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(900, 40, 20), this.mat);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -1000;
    this.group = new THREE.Group();
    this.group.add(this.hemi, this.sun, this.sun.target, this.dome);
    scene.add(this.group);
    this.env = null;
    this.hemiK = 1; this.sunK = 1;
    this.setQuality(quality);
  }

  setQuality(q) {
    this.quality = q;
    const size = q === 'magas' ? 2048 : 1024;
    this.sun.castShadow = q !== 'alacsony';
    if (this.sun.shadow.mapSize.x !== size || !this.sun.shadow.map) {
      this.sun.shadow.mapSize.set(size, size);
      if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
    }
    this.texel = (SHADOW_HALF * 2) / size;
  }

  setTheme(theme) {
    const u = this.bakeUniforms, s = theme.sky, type = { gradient: 0, clouds: 1, nebula: 2, stars: 3 }[s.type] ?? 0;
    u.uTop.value.setHex(s.top); u.uHorizon.value.setHex(s.horizon); u.uBottom.value.setHex(s.bottom);
    u.uSunColor.value.setHex(s.sunColor);
    this.sunDir.set(s.sunDir[0], s.sunDir[1], s.sunDir[2]).normalize();
    this.sunDirU.copy(this.sunDir);
    u.uType.value = type;
    u.uStars.value = s.stars || (type >= 2 ? 1 : 0);
    u.uClouds.value = type === 1 ? (s.clouds || 0.4) : s.clouds || 0;
    // optional theme.sky.cloudDark / cloudLight (hex); the default is the white daylight cloud
    if (s.cloudDark != null) u.uCloudA.value.setHex(s.cloudDark); else u.uCloudA.value.setRGB(0.62, 0.68, 0.76, THREE.LinearSRGBColorSpace);
    if (s.cloudLight != null) u.uCloudB.value.setHex(s.cloudLight); else u.uCloudB.value.setRGB(1.0, 0.99, 0.97, THREE.LinearSRGBColorSpace);
    // optional theme.sky.planet = { dir: [x,y,z], radius (degrees), sea, land, atmo }
    const pl = s.planet;
    u.uPlanet.value.set(pl ? pl.dir[0] : 0, pl ? pl.dir[1] : -1, pl ? pl.dir[2] : 0, pl ? (pl.radius ?? 30) * Math.PI / 180 : 0);
    if (pl) { u.uPlanetSea.value.setHex(pl.sea ?? 0x1d4f9a); u.uPlanetLand.value.setHex(pl.land ?? 0x4a7d3a); u.uPlanetAtmo.value.setHex(pl.atmo ?? 0x6ab8ff); }
    this.hemi.color.setHex(theme.hemi.sky); this.hemi.groundColor.setHex(theme.hemi.ground);
    this.sun.color.setHex(theme.sun.color);
    // the map authors think in "1.0 = full light"; three's physical units want about pi times that
    const hasEnv = this.quality !== 'alacsony';
    this.hemiK = theme.hemi.intensity * (hasEnv ? 1.6 : 2.6);
    this.sunK = theme.sun.intensity * 2.4;
    this.hemi.intensity = this.hemiK; this.sun.intensity = this.sunK;
    this.scene.fog = new THREE.Fog(theme.fog.color, theme.fog.near, theme.fog.far);
    this.scene.background = new THREE.Color(theme.fog.color);
    this.bake();
    this.buildEnv();
  }

  // render the sky into the cube map (once per map / quality change)
  bake() {
    const size = this.quality === 'magas' ? 1024 : this.quality === 'kozepes' ? 768 : 512;
    if (!this.rt || this.rt.width !== size) {
      if (this.rt) this.rt.dispose();
      this.rt = new THREE.WebGLCubeRenderTarget(size, { type: THREE.UnsignedByteType, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
      this.rt.texture.colorSpace = THREE.SRGBColorSpace;
      this.cubeCam = new THREE.CubeCamera(0.1, 10, this.rt);
    }
    this.cubeCam.update(this.renderer, this.bakeScene);
    this.uniforms.uSky.value = this.rt.texture;
  }

  // an environment map from the baked sky (PBR reflections, bounce light); alacsony skips it
  buildEnv() {
    if (this.env) { this.env.dispose(); this.env = null; }
    this.scene.environment = null;
    if (this.quality === 'alacsony') return;
    try {
      const pm = new THREE.PMREMGenerator(this.renderer);
      this.env = pm.fromCubemap(this.rt.texture);
      this.scene.environment = this.env.texture;
      this.scene.environmentIntensity = 0.55;
      pm.dispose();
    } catch (e) { console.warn('env map failed', e); }
  }

  update(camPos, playerPos, t) {
    const ang = t * 0.004, ca = Math.cos(ang), sa = Math.sin(ang);
    this.uniforms.uRot.value.set(ca, 0, sa, 0, 1, 0, -sa, 0, ca);   // the clouds and stars drift slowly
    this.dome.position.copy(camPos);
    if (!this.sun.castShadow) {
      this.sun.position.copy(playerPos).addScaledVector(this.sunDir, 80);
      this.sun.target.position.copy(playerPos);
      return;
    }
    // shadow box around the player, snapped to shadow-map texels so the shadows do not shimmer
    const L = this.sunDir, up = Math.abs(L.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(up, L).normalize();
    const upL = new THREE.Vector3().crossVectors(L, right).normalize();
    const px = playerPos.dot(right), py = playerPos.dot(upL), pz = playerPos.dot(L);
    const sx = Math.round(px / this.texel) * this.texel, sy = Math.round(py / this.texel) * this.texel;
    const c = right.multiplyScalar(sx).addScaledVector(upL, sy).addScaledVector(L, pz);
    this.sun.target.position.copy(c);
    this.sun.position.copy(c).addScaledVector(L, 100);
    this.sun.target.updateMatrixWorld();
  }

  dispose() {
    if (this.env) this.env.dispose();
    if (this.rt) this.rt.dispose();
    this.scene.environment = null;
    this.mat.dispose(); this.bakeMat.dispose();
    this.dome.geometry.dispose();
    this.scene.remove(this.group);
  }
}
