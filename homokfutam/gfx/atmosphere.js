import * as THREE from 'three';

// ============================================================
//  Atmosphere: height fog with sun in-scatter, cloud layer + cloud shadows,
//  static world sun shadow, sky dome and the image-based environment.
//
//  Every built-in material gets the shared ATMO uniforms through a default
//  Material.onBeforeCompile, and three's fog / light chunks are replaced so that:
//   - all fogged materials use the same analytic height fog as the sky horizon,
//   - lit materials multiply the sun by hfSunVis() (baked world shadow * clouds).
//  Materials with their own onBeforeCompile must call atmoUniforms(shader) themselves.
// ============================================================

export const SUN_EL = 0.36, SUN_AZ = -0.62;     // radians: elevation above the horizon, azimuth from +x
export const SUN_DIR = new THREE.Vector3(Math.cos(SUN_EL) * Math.cos(SUN_AZ), Math.sin(SUN_EL), Math.cos(SUN_EL) * Math.sin(SUN_AZ)).normalize();
export const PALETTE = {
  zenith: new THREE.Color('#2a5fa6'),
  skyHorizon: new THREE.Color('#ebbf8c'),
  fog: new THREE.Color('#dcae7a'),
  fogSun: new THREE.Color('#ffc47e'),
  sun: new THREE.Color('#ffd6a6'),
  ground: new THREE.Color('#b58556'),
};

export const ATMO = {
  hfSunDir: { value: SUN_DIR },
  hfSunCol: { value: PALETTE.sun },
  hfFogCol: { value: PALETTE.fog },
  hfFogSunCol: { value: PALETTE.fogSun },
  hfFogDensity: { value: 0.0002 },
  hfFogFalloff: { value: 0.0055 },
  hfTime: { value: 0 },
  hfCloudTex: { value: null },
  hfCloudCover: { value: 0.56 },
  hfCloudH: { value: 1400 },
  hfWind: { value: new THREE.Vector2(0.0041, 0.0017) },
  hfCloudShadow: { value: 0.0 },
  hfShadowMap: { value: null },
  hfShadowMatrix: { value: new THREE.Matrix4() },
  hfShadowOn: { value: 0 },
  hfShadowTexel: { value: new THREE.Vector2(1 / 4096, 1 / 4096) },
  hfShadowBias: { value: 0.0006 },
};
export function atmoUniforms(shader) { Object.assign(shader.uniforms, ATMO); }

// --- shader chunks -------------------------------------------------------
const PARS_V = /* glsl */`
varying vec3 vHfWorld;
#ifdef USE_FOG
  varying float vFogDepth;
#endif
`;
const VERT = /* glsl */`
vHfWorld = cameraPosition + ( vec4( mvPosition.xyz, 0.0 ) * viewMatrix ).xyz;
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
#endif
`;
export const ATMO_FUNCS = /* glsl */`
varying vec3 vHfWorld;
uniform vec3 hfSunDir, hfSunCol, hfFogCol, hfFogSunCol;
uniform float hfFogDensity, hfFogFalloff, hfTime, hfCloudCover, hfCloudH, hfCloudShadow, hfShadowOn, hfShadowBias;
uniform vec2 hfWind, hfShadowTexel;
uniform sampler2D hfCloudTex;
uniform sampler2DShadow hfShadowMap;
uniform mat4 hfShadowMatrix;

// optical depth of the exponential height fog along a ray (Quilez)
float hfFogAmount( vec3 ro, vec3 rd, float dist ) {
  float b = hfFogFalloff;
  float a = hfFogDensity * exp( - b * ro.y );
  float ry = rd.y * b;
  float k = abs( ry ) < 1e-5 ? dist : ( 1.0 - exp( - ry * dist ) ) / ry;
  return 1.0 - exp( - a * max( k, 0.0 ) );
}
vec3 hfFogTint( vec3 rd ) {
  float s = max( dot( rd, hfSunDir ), 0.0 );
  return mix( hfFogCol, hfFogSunCol, pow( s, 5.0 ) ) + hfSunCol * pow( s, 40.0 ) * 0.35;
}
float hfCloud( vec2 p ) {
  vec2 uv = p / 5600.0 + hfWind * hfTime;
  float n = texture2D( hfCloudTex, uv ).r * 0.68 + texture2D( hfCloudTex, uv * 2.9 + vec2( 0.37, 0.71 ) ).r * 0.32;
  return smoothstep( hfCloudCover, hfCloudCover + 0.2, n );
}
float hfStaticShadow( vec3 wp, vec3 wn ) {
  vec3 c = ( hfShadowMatrix * vec4( wp + wn * 1.2, 1.0 ) ).xyz;
  float inside = step( 0.0, c.x ) * step( c.x, 1.0 ) * step( 0.0, c.y ) * step( c.y, 1.0 ) * step( c.z, 1.0 );
  float z = c.z - hfShadowBias;
  vec2 t = hfShadowTexel * 1.5;
  float s = texture( hfShadowMap, vec3( c.xy, z ) ) * 0.2
    + texture( hfShadowMap, vec3( c.xy + vec2( t.x, t.y * 0.4 ), z ) ) * 0.2
    + texture( hfShadowMap, vec3( c.xy + vec2( - t.x * 0.4, t.y ), z ) ) * 0.2
    + texture( hfShadowMap, vec3( c.xy + vec2( - t.x, - t.y * 0.4 ), z ) ) * 0.2
    + texture( hfShadowMap, vec3( c.xy + vec2( t.x * 0.4, - t.y ), z ) ) * 0.2;
  return mix( 1.0, s, inside * hfShadowOn );
}
float hfSunVis( vec3 wp, vec3 viewNormal ) {
  vec3 wn = normalize( ( vec4( viewNormal, 0.0 ) * viewMatrix ).xyz );
  float v = hfStaticShadow( wp, wn );
  vec2 cp = wp.xz + hfSunDir.xz * ( ( hfCloudH - wp.y ) / max( hfSunDir.y, 0.05 ) );
  return v * ( 1.0 - hfCloudShadow * hfCloud( cp ) );
}
`;
const PARS_F = ATMO_FUNCS + /* glsl */`
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif
`;
const FRAG = /* glsl */`
#ifdef USE_FOG
  vec3 hfRd = vHfWorld - cameraPosition;
  float hfDist = length( hfRd );
  hfRd /= max( hfDist, 1e-4 );
  float fogFactor = hfFogAmount( cameraPosition, hfRd, hfDist );
  #ifdef HF_ADDITIVE
    gl_FragColor.rgb *= 1.0 - fogFactor;
  #else
    gl_FragColor.rgb = mix( gl_FragColor.rgb, hfFogTint( hfRd ), fogFactor );
  #endif
#endif
`;

let installed = false;
export function installAtmosphere() {
  if (installed) return;
  installed = true;
  const C = THREE.ShaderChunk;
  C.fog_pars_vertex = PARS_V;
  C.fog_vertex = VERT;
  C.fog_pars_fragment = PARS_F;
  C.fog_fragment = FRAG;
  const lfb = C.lights_fragment_begin;
  const dir = lfb.indexOf('#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )');
  const re = dir < 0 ? -1 : lfb.indexOf('RE_Direct( directLight', dir);
  if (re < 0) console.warn('HOMOKFUTAM: lights chunk changed, sun shadows from the world bake are off');
  else C.lights_fragment_begin = lfb.slice(0, re) + 'directLight.color *= hfSunVis( vHfWorld, geometryNormal );\n\t\t' + lfb.slice(re);
  // every material without its own hook gets the shared uniforms
  THREE.Material.prototype.onBeforeCompile = function (shader) { Object.assign(shader.uniforms, ATMO); };
}

// --- cloud noise (tileable) ----------------------------------------------
export function cloudTexture(size = 256) {
  const data = new Uint8Array(size * size * 4);
  const hash = (x, y, p) => {
    x = ((x % p) + p) % p; y = ((y % p) + p) % p;
    let h = (x * 374761393 + y * 668265263) ^ 0x5bd1e995;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  const vn = (x, y, p) => {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    const a = hash(ix, iy, p), b = hash(ix + 1, iy, p), c = hash(ix, iy + 1, p), d = hash(ix + 1, iy + 1, p);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let f = 0, amp = 0.5, per = 4;
    for (let o = 0; o < 6; o++) { f += amp * vn(x / size * per, y / size * per, per); amp *= 0.5; per *= 2; }
    const i = (y * size + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = Math.round(Math.min(1, f / 0.984) * 255); data[i + 3] = 255;
  }
  const t = new THREE.DataTexture(data, size, size);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true; t.needsUpdate = true;
  return t;
}

// --- sky -----------------------------------------------------------------
export function skyMaterial() {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { hfZenith: { value: PALETTE.zenith }, hfSkyHorizon: { value: PALETTE.skyHorizon }, hfGround: { value: PALETTE.ground }, hfEnv: { value: 0 } },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      #include <fog_pars_vertex>
      void main() {
        vDir = normalize( position );
        vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
        gl_Position = projectionMatrix * mvPosition;
        gl_Position.z = gl_Position.w;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 hfZenith, hfSkyHorizon, hfGround;
      uniform float hfEnv;
      varying vec3 vDir;
      #include <common>
      #include <fog_pars_fragment>
      void main() {
        vec3 rd = normalize( vDir );
        float h = max( rd.y, 0.0 );
        vec3 col = mix( hfSkyHorizon, hfZenith, pow( smoothstep( 0.0, 0.62, h ), 0.72 ) );
        float sd = max( dot( rd, hfSunDir ), 0.0 );
        col += hfSunCol * ( pow( sd, 10.0 ) * 0.22 + pow( sd, 120.0 ) * 0.6 );
        // cloud layer on a plane above the camera
        vec3 ro = hfEnv > 0.5 ? vec3( 0.0, 40.0, 0.0 ) : cameraPosition;
        float t = ( hfCloudH - ro.y ) / max( rd.y, 0.015 );
        vec2 cp = ro.xz + rd.xz * t;
        float cl = hfCloud( cp ) * smoothstep( 0.015, 0.14, rd.y );
        float thick = hfCloud( cp + hfSunDir.xz * 260.0 );          // denser towards the sun = darker base
        vec3 lit = mix( vec3( 1.0, 0.95, 0.88 ), hfSunCol * 1.6, pow( sd, 4.0 ) ) * 1.15;
        vec3 cloudCol = mix( lit, vec3( 0.62, 0.6, 0.66 ), thick * 0.55 );
        col = mix( col, cloudCol, cl * 0.88 );
        // sun disc on top of thin cloud
        col += hfSunCol * smoothstep( 0.99965, 0.9999, sd ) * 38.0 * ( 1.0 - cl * 0.8 ) * ( 1.0 - hfEnv );
        // below the horizon (environment map only): sunlit sand
        if ( rd.y < 0.0 ) col = mix( hfFogCol, hfGround * ( 0.55 + 0.6 * hfSunDir.y ), smoothstep( 0.0, 0.25, - rd.y ) );
        // horizon haze: the ground fog at infinite distance
        float fogK = rd.y > 0.0 ? 1.0 - exp( - hfFogDensity * exp( - hfFogFalloff * ro.y ) / ( hfFogFalloff * max( rd.y, 1e-4 ) ) ) : 1.0;
        if ( rd.y < 0.0 ) fogK *= 1.0 - smoothstep( 0.0, 0.3, - rd.y );
        col = mix( col, hfFogTint( rd ), clamp( fogK, 0.0, 1.0 ) );
        gl_FragColor = vec4( col, 1.0 );
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

// Image-based light: the sky and the sunlit sand prefiltered for PBR reflections/ambient.
export function buildEnvironment(renderer) {
  const s = new THREE.Scene();
  const m = skyMaterial();
  m.uniforms.hfEnv.value = 1;
  s.add(new THREE.Mesh(new THREE.SphereGeometry(100, 64, 32), m));
  const pm = new THREE.PMREMGenerator(renderer);
  const rt = pm.fromScene(s, 0.02, 0.1, 1000);
  pm.dispose();
  m.dispose();
  return rt.texture;
}

// --- static world shadow ---------------------------------------------------
// One big orthographic depth render along the sun, done once after the world is built.
// It gives every static shadow out to the horizon; the regular shadow map near the
// camera adds the pods and crisp local detail on top.
export function bakeWorldShadow(renderer, scene, bounds, size) {
  const cam = new THREE.OrthographicCamera();
  const center = bounds.getCenter(new THREE.Vector3());
  const R = bounds.getSize(new THREE.Vector3()).length() * 0.5;
  cam.position.copy(center).addScaledVector(SUN_DIR, R * 2);
  cam.lookAt(center);
  cam.updateMatrixWorld();
  // fit the box corners in light space
  const inv = cam.matrixWorldInverse, p = new THREE.Vector3();
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, z0 = 1e9, z1 = -1e9;
  for (let k = 0; k < 8; k++) {
    p.set(k & 1 ? bounds.max.x : bounds.min.x, k & 2 ? bounds.max.y : bounds.min.y, k & 4 ? bounds.max.z : bounds.min.z).applyMatrix4(inv);
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z);
  }
  Object.assign(cam, { left: x0, right: x1, bottom: y0, top: y1, near: -z1 - 10, far: -z0 + 10 });
  cam.updateProjectionMatrix();

  const max = renderer.capabilities.maxTextureSize;
  size = Math.min(size, max);
  const depth = new THREE.DepthTexture(size, size, THREE.FloatType);
  depth.compareFunction = THREE.LessEqualCompare;
  depth.minFilter = depth.magFilter = THREE.LinearFilter;
  const rt = new THREE.WebGLRenderTarget(size, size, { depthTexture: depth, depthBuffer: true, samples: 0 });
  rt.texture.generateMipmaps = false;

  // only static casters: everything flagged dynamic, transparent or unlit is hidden
  const hidden = [];
  scene.traverse((o) => {
    if (!o.visible) return;
    const skip = o.userData.dynamic || o.userData.noBake || o.isPoints || o.isSprite || o.isLine
      || (o.isMesh && (Array.isArray(o.material) ? false : (o.material.transparent || o.material.isShaderMaterial || o.material.isMeshBasicMaterial)));
    if (skip) { o.visible = false; hidden.push(o); }
  });
  const prevOverride = scene.overrideMaterial, prevBg = scene.background, prevRt = renderer.getRenderTarget();
  const prevAuto = renderer.shadowMap.autoUpdate;
  const depthMat = new THREE.MeshDepthMaterial({ side: THREE.DoubleSide });
  scene.overrideMaterial = depthMat;
  scene.background = null;
  renderer.shadowMap.autoUpdate = false;
  renderer.setRenderTarget(rt);
  renderer.clear();
  renderer.render(scene, cam);
  renderer.setRenderTarget(prevRt);
  renderer.shadowMap.autoUpdate = prevAuto;
  scene.overrideMaterial = prevOverride;
  scene.background = prevBg;
  for (const o of hidden) o.visible = true;
  depthMat.dispose();

  // world -> [0,1] shadow texture space
  const bias = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
  ATMO.hfShadowMatrix.value.copy(bias).multiply(cam.projectionMatrix).multiply(cam.matrixWorldInverse);
  ATMO.hfShadowMap.value = depth;
  ATMO.hfShadowTexel.value.set(1 / size, 1 / size);
  ATMO.hfShadowOn.value = 1;
  // ~1.5 depth texels of slope tolerance in metres -> depth units
  ATMO.hfShadowBias.value = 1.5 / (cam.far - cam.near);
  return { rt, cam };
}
