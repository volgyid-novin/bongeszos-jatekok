import * as THREE from 'three';
import { GPU, U, T, maxTextureSize, N, W } from './backend.js';
import { pickQuality } from './quality.js';
import { AIR } from './skylut.js';
import { GI_ON, GI_FUNCS, GI_UNIFORMS } from './gi.js';

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

// ?gfx=noon:1 (docs/visual-next-steps.md D1): midday heat instead of golden hour: a higher, whiter sun, a
// bleached horizon, pale dust, a softer grade. ?gfx=sunEl:<degrees> overrides the sun's height either way.
// Load-time choices: the world shadow, the probes, the sky tables and the panorama are made for one sun.
const QA = pickQuality();
export const NOON = !!QA.noon;
export const NOON_EL = 30;                        // degrees: the noon sun's height (chase-camera frame: D1)
export const SUN_EL = QA.sunEl ? THREE.MathUtils.degToRad(QA.sunEl) : NOON ? THREE.MathUtils.degToRad(NOON_EL) : 0.36;
export const SUN_AZ = -0.62;                      // radians: elevation above the horizon, azimuth from +x
export const SUN_DIR = new THREE.Vector3(Math.cos(SUN_EL) * Math.cos(SUN_AZ), Math.sin(SUN_EL), Math.cos(SUN_EL) * Math.sin(SUN_AZ)).normalize();
// the sky, the dust, the sun and the fill lights (main.js); noon: white sun, cream horizon, pale ochre dust
export const PALETTE = NOON ? {
  zenith: new THREE.Color('#3369b0'),
  skyHorizon: new THREE.Color('#efe1c6'),
  skyMid: new THREE.Color().setRGB(0.46, 0.56, 0.69),
  fog: new THREE.Color('#dcc39a'),
  fogSun: new THREE.Color('#ffe9c8'),
  sun: new THREE.Color('#ffecd2'),
  ground: new THREE.Color('#c29a6c'),
  // a harder light than golden hour: on flat sand the sun gives ~3x the sky's fill (it was ~1.1x), as in a real
  // desert, where the shade is 1.5-2 stops under the sunlit sand
  sunI: 4.0, hemiSky: new THREE.Color('#a7bedb'), hemiGround: new THREE.Color('#cf9f6c'), hemiI: 0.35, envI: 0.4,
  flare: new THREE.Color('#fff0dc'), rays: new THREE.Color().setRGB(1, 0.88, 0.7), veil: 0.06,
} : {
  zenith: new THREE.Color('#2a5fa6'),
  skyHorizon: new THREE.Color('#ebbf8c'),
  skyMid: new THREE.Color().setRGB(0.40, 0.50, 0.61),        // linear: the pale blue between horizon and zenith
  fog: new THREE.Color('#dcae7a'),
  fogSun: new THREE.Color('#ffc47e'),
  sun: new THREE.Color('#ffd6a6'),
  ground: new THREE.Color('#b58556'),
  sunI: 3.1, hemiSky: new THREE.Color('#9db4d2'), hemiGround: new THREE.Color('#c98b52'), hemiI: 0.55, envI: 0.6,
  flare: new THREE.Color('#ffd9a8'), rays: new THREE.Color().setRGB(1, 0.69, 0.35), veil: 0,
};
// the colour grade after tone mapping (gfx/post.js, gfx/tsl/post.js): saturation, contrast, split toning
export const GRADE = NOON
  ? { sat: 1.18, contrast: 1.12, shadow: [0.95, 0.98, 1.05], high: [1.05, 1.0, 0.9] }
  : { sat: 1.3, contrast: 1.15, shadow: [0.94, 0.98, 1.06], high: [1.04, 1.0, 0.94] };

// the node materials build against a depth texture before the world shadow is baked (bakeWorldShadow)
const SHADOW_PLACEHOLDER = new THREE.DepthTexture(1, 1, THREE.FloatType);
SHADOW_PLACEHOLDER.compareFunction = THREE.LessEqualCompare;
// { value } uniforms for the GLSL materials, uniform / texture nodes for the node materials (gfx/backend.js)
export const ATMO = {
  hfSunDir: U(SUN_DIR),
  hfSunCol: U(PALETTE.sun),
  hfFogCol: U(PALETTE.fog),
  hfFogSunCol: U(PALETTE.fogSun),
  hfFogDensity: U(0.0002),
  hfFogFalloff: U(0.0055),
  hfTime: U(0),
  hfCloudTex: T(null),
  hfCloudCover: U(0.56),
  hfCloudH: U(1400),
  hfWind: U(new THREE.Vector2(0.0041, 0.0017)),
  hfCloudShadow: U(0.0),
  hfShadowMap: GPU ? T(SHADOW_PLACEHOLDER) : { value: null },
  hfShadowMatrix: U(new THREE.Matrix4()),
  hfShadowOn: U(0),
  hfShadowTexel: U(new THREE.Vector2(1 / 4096, 1 / 4096)),
  hfShadowBias: U(0.0006),
  // physically based sky and aerial perspective (PB_SKY): filled by loadSky()
  hfSkyLut: T(null),
  hfSkyE: U(12.5),                                  // sun irradiance in the units of the scene's sky
  hfSunT: U(new THREE.Vector3(1, 1, 1)),          // sun transmittance down to the ground
  hfPsi: U(new THREE.Vector3()),                  // multiple scattering at the ground (per unit scattering)
  hfRayS: U(new THREE.Vector3(5.8e-6, 13.6e-6, 33.1e-6)),   // Rayleigh scattering at the ground, per metre
  hfApScale: U(3),                                // aerial perspective: distances count this many times
  // the low dust (the height fog): albedo, calibrated so that it keeps the old fog colour side-on (it stands
  // for the dust's albedo and the light it loses inside the layer), and its forward scattering
  hfDustAlb: U(new THREE.Vector3(0.56, 0.43, 0.27)),
  hfDustG: U(0.3),
  hfBounce: U(new THREE.Vector3()),               // the sunlit sand under the dust (per unit scattering)
  // cached mid-distance sun shadow of the static world (MID_SHADOW): createMidShadow()
  hfMidMap: GPU ? T(SHADOW_PLACEHOLDER) : { value: null },
  hfMidMatrix: U(new THREE.Matrix4()),
  hfMidOn: U(0),
  hfMidTexel: U(new THREE.Vector2(1 / 2048, 1 / 1024)),
  hfMidBias: U(0.0006),
  hfMidPods: GPU ? T(SHADOW_PLACEHOLDER) : { value: null },      // the pods in the same box, every frame
  hfMidPodsOn: U(0),
  // D2: darker shade where the sky is hidden (canyon floor and walls, the rocks' baked occlusion), 0..1
  hfShade: U(0),
};
// ?gfx=gi:1 (D4): the baked light's uniforms ride along with ATMO into every GLSL material
Object.assign(ATMO, GI_UNIFORMS);
export function atmoUniforms(shader) { Object.assign(shader.uniforms, ATMO); }

// ?gfx=sky:1 (docs/visual-next-steps.md, C1): the sky and the fog from one physically based model.
// A load-time choice like the renderer: the GLSL chunks and node graphs below are built for one or the other.
export const PB_SKY = !!pickQuality().sky;
// ?gfx=csm:1 (C2): a sharper cached shadow of the static world over the few hundred metres ahead
export const MID_SHADOW = !!pickQuality().csm;
// ?gfx=clouds:1 (C11): the cloud layer as a slab with depth (a short raymarch) instead of a flat sheet
export const VCLOUDS = !!pickQuality().clouds;
// slab: base at hfCloudH, this many metres deep
export const CLOUD_DEPTH = 650;

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
// Physically based sky and aerial perspective (PB_SKY). The air above the low dust (Rayleigh, aerosol,
// ozone, multiple scattering) is the baked sky-view table for the sky. Over the distances inside the
// world the clear air is near-constant in density: its Rayleigh scattering is integrated in closed form
// (hfApScale stretches the distances, as the world is a few km where real air needs tens; the aerosol
// near the ground is the low dust). The low dust is the old height fog's exponential layer, now with an
// albedo and a phase function, lit by the same sun and multiple scattering.
const PB_FUNCS = /* glsl */`
#define HF_PB 1
uniform sampler2D hfSkyLut;
uniform float hfSkyE, hfApScale, hfDustG;
uniform vec3 hfSunT, hfPsi, hfRayS, hfDustAlb, hfBounce;
float hfHG( float c, float g ) { float g2 = g * g, d = max( 1.0 + g2 - 2.0 * g * c, 1e-4 ); return ( 1.0 - g2 ) / ( 12.5663706 * d * sqrt( d ) ); }
float hfRayP( float c ) { return 0.0596831 * ( 1.0 + c * c ); }
// in-scattered radiance per unit optical depth of the low dust, looking along a ray at cosine c from the sun.
// The dust is lit by the scene's sun (hfSunCol, the light on the ground beside it), not the air's transmittance.
vec3 hfDustRate( float c ) {
  float p = hfHG( c, hfDustG ) * 0.75 + hfHG( c, -0.3 ) * 0.25;
  return hfDustAlb * ( p * hfSunCol + hfPsi + hfBounce ) * hfSkyE;
}
// dust optical depth along a ray (Quilez), grey
float hfDustOD( vec3 ro, vec3 rd, float dist ) {
  float b = hfFogFalloff, a = hfFogDensity * exp( - b * ro.y ), ry = rd.y * b;
  float k = abs( ry ) < 1e-5 ? dist : ( 1.0 - exp( - ry * dist ) ) / ry;
  return a * max( k, 0.0 );
}
// light scattered towards the eye over dist metres along rd, and (T) the transmittance
vec3 hfAerial( vec3 ro, vec3 rd, float dist, out vec3 T ) {
  float c = dot( rd, hfSunDir );
  vec3 tauA = hfRayS * ( dist * hfApScale );
  float tauD = hfDustOD( ro, rd, dist );
  vec3 rateA = ( hfRayP( c ) * hfSunT + hfPsi ) * hfSkyE;
  vec3 tau = tauA + tauD;
  T = exp( - tau );
  return ( rateA * tauA + hfDustRate( c ) * tauD ) / max( tau, vec3( 1e-6 ) ) * ( 1.0 - T );
}
// the baked sky (air above the dust) towards rd, uv: azimuth from the sun, elevation denser at the horizon
vec3 hfSkyAir( vec3 rd ) {
  float phi = acos( clamp( dot( normalize( rd.xz + vec2( 1e-6 ) ), normalize( hfSunDir.xz ) ), -1.0, 1.0 ) );
  float el = asin( clamp( rd.y, -1.0, 1.0 ) );
  vec2 uv = vec2( phi * 0.3183099, 0.5 + 0.5 * sign( el ) * sqrt( abs( el ) * 0.6366198 ) );
  return texture2D( hfSkyLut, uv ).rgb * hfSkyE;
}
`;
// Cached mid-distance shadow (MID_SHADOW): the static world again, ~3.5x sharper than the world bake, over a
// box ahead of the camera (createMidShadow); it takes over from the bake inside the box, fading at its edge.
const MID_FUNCS = /* glsl */`
#define HF_MID 1
uniform sampler2DShadow hfMidMap, hfMidPods;
uniform mat4 hfMidMatrix;
uniform float hfMidOn, hfMidBias, hfMidPodsOn;
uniform vec2 hfMidTexel;
float hfMidShadow( vec3 wp, vec3 wn, out float w ) {
  vec3 c = ( hfMidMatrix * vec4( wp + wn * 0.35, 1.0 ) ).xyz;
  vec2 e = min( c.xy, 1.0 - c.xy );
  w = smoothstep( 0.0, 0.06, min( e.x, e.y ) ) * step( c.z, 1.0 ) * hfMidOn;
  float z = c.z - hfMidBias;
  vec2 t = hfMidTexel * 1.5;
  float s = texture( hfMidMap, vec3( c.xy, z ) ) * 0.2
    + texture( hfMidMap, vec3( c.xy + vec2( t.x, t.y * 0.4 ), z ) ) * 0.2
    + texture( hfMidMap, vec3( c.xy + vec2( - t.x * 0.4, t.y ), z ) ) * 0.2
    + texture( hfMidMap, vec3( c.xy + vec2( - t.x, - t.y * 0.4 ), z ) ) * 0.2
    + texture( hfMidMap, vec3( c.xy + vec2( t.x * 0.4, - t.y ), z ) ) * 0.2;
  // pods beyond the near shadow map (which has them up close)
  float far = smoothstep( 80.0, 110.0, distance( wp, cameraPosition ) ) * hfMidPodsOn;
  return s * mix( 1.0, texture( hfMidPods, vec3( c.xy, z ) ), far );
}
`;
export const ATMO_FUNCS = /* glsl */`
varying vec3 vHfWorld;
uniform vec3 hfSunDir, hfSunCol, hfFogCol, hfFogSunCol;
uniform float hfFogDensity, hfFogFalloff, hfTime, hfCloudCover, hfCloudH, hfCloudShadow, hfShadowOn, hfShadowBias, hfShade;
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
${MID_SHADOW ? MID_FUNCS : ''}
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
  float v = mix( 1.0, s, inside * hfShadowOn );
#ifdef HF_MID
  float mw, ms = hfMidShadow( wp, wn, mw );
  v = mix( v, ms, mw );
#endif
  return v;
}
float hfSunVis( vec3 wp, vec3 viewNormal ) {
  vec3 wn = normalize( ( vec4( viewNormal, 0.0 ) * viewMatrix ).xyz );
  float v = hfStaticShadow( wp, wn );
  vec2 cp = wp.xz + hfSunDir.xz * ( ( hfCloudH - wp.y ) / max( hfSunDir.y, 0.05 ) );
  return v * ( 1.0 - hfCloudShadow * hfCloud( cp ) );
}
${PB_SKY ? PB_FUNCS : ''}
${GI_ON ? GI_FUNCS : ''}`;
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
  #ifdef HF_PB
    vec3 hfT, hfS = hfAerial( cameraPosition, hfRd, hfDist, hfT );
    #ifdef HF_ADDITIVE
      gl_FragColor.rgb *= hfT;
    #else
      gl_FragColor.rgb = gl_FragColor.rgb * hfT + hfS;
    #endif
  #else
    float fogFactor = hfFogAmount( cameraPosition, hfRd, hfDist );
    #ifdef HF_ADDITIVE
      gl_FragColor.rgb *= 1.0 - fogFactor;
    #else
      gl_FragColor.rgb = mix( gl_FragColor.rgb, hfFogTint( hfRd ), fogFactor );
    #endif
  #endif
#endif
`;

let installed = false;
// renderer / scene are for the node materials (WebGPURenderer): they get the fog and the sun's world
// shadow from the scene's fog node and the SunLight's light node instead (gfx/tsl/atmosphere.js)
export function installAtmosphere(renderer, scene) {
  if (installed) return;
  installed = true;
  if (GPU) { N.installNodeAtmosphere(renderer, scene); return; }
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

// --- physically based sky tables (PB_SKY) -----------------------------------
// Baked in a worker (gfx/skylut.js, ~0.3 s of CPU) while the world loads; resolves once the uniforms are
// filled. Until then the sky reads the placeholder table (white): nothing is drawn before boot anyway.
export function loadSky() {
  if (!PB_SKY) return Promise.resolve();
  return new Promise((resolve) => {
    const w = new Worker(new URL('./skylut.worker.js', import.meta.url), { type: 'module' });
    const done = () => { w.terminate(); resolve(); };
    w.onmessage = (e) => { applySky(e.data); done(); };
    w.onerror = (e) => { console.warn('HOMOKFUTAM: sky bake failed', e.message); done(); };
    w.postMessage({ x: SUN_DIR.x, y: SUN_DIR.y, z: SUN_DIR.z });
  });
}
function applySky(r) {
  const half = new Uint16Array(r.sky.length);
  for (let i = 0; i < half.length; i++) half[i] = THREE.DataUtils.toHalfFloat(r.sky[i]);
  const t = new THREE.DataTexture(half, r.skyW, r.skyH, THREE.RGBAFormat, THREE.HalfFloatType);
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  ATMO.hfSkyLut.value = t;
  ATMO.hfSunT.value.fromArray(r.sunT);
  ATMO.hfPsi.value.fromArray(r.psi);
  ATMO.hfRayS.value.fromArray(r.rayS);
  // the sunlit sand under the dust: albedo x sun x cosine / pi, from the lower half of the sphere
  const sun = PALETTE.sun.toArray();
  ATMO.hfBounce.value.fromArray(AIR.ground.map((g, k) => g * sun[k] * SUN_DIR.y / Math.PI * 0.5));
  console.log(`HOMOKFUTAM: sky tables baked in ${Math.round(r.time)} ms`);
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

// --- 2.5D clouds (VCLOUDS) ----------------------------------------------------
// The flat layer's noise read as columns: a point of the slab is cloud where the noise is over the coverage,
// with the threshold rising towards the top (flat bases, rounded tops) and a finer noise eating the edges.
// 10 (WebGPU) or 16 (WebGL, no TRAA) steps through the slab along the view ray; each lit by two density samples towards the sun (self
// shadowing; the "powder" darkening of thin edges facing away from it), plus sky light from above.
const VCLOUD_FUNCS = /* glsl */`
const float HF_BAYER[ 16 ] = float[]( 0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0 );
// lod: mip level of the coarse octave (explicit: derivatives inside the march's loop cost the D3D compiler dearly)
float hfCloudD( vec3 p, float lod ) {
  float h = clamp( ( p.y - hfCloudH ) / ${CLOUD_DEPTH.toFixed(1)}, 0.0, 1.0 );
  vec2 uv = p.xz / 5600.0 + hfWind * hfTime;
  float n = textureLod( hfCloudTex, uv, lod ).r * 0.68 + textureLod( hfCloudTex, uv * 2.9 + vec2( 0.37, 0.71 ), lod + 1.5 ).r * 0.32;
  n -= textureLod( hfCloudTex, uv * 9.7 + vec2( h * 0.6, 0.13 ), lod + 3.3 ).r * 0.05;
  float c = hfCloudCover + h * h * 0.18;
  return smoothstep( c, c + 0.17, n ) * smoothstep( 0.0, 0.12, h ) * ( 1.0 - smoothstep( 0.8, 1.0, h ) );
}
// over a background col, along rd from ro: returns the colour behind and in the clouds; fade at the horizon
vec3 hfCloudSlab( vec3 col, vec3 ro, vec3 rd, float sd ) {
  float rdy = max( rd.y, 0.012 );
  float tA = max( ( hfCloudH - ro.y ) / rdy, 0.0 ), tB = ( hfCloudH + ${CLOUD_DEPTH.toFixed(1)} - ro.y ) / rdy;
  // (no TRAA on this renderer: a fixed 4x4 ordered dither, and more, shorter steps)
  // (at grazing angles only the near 1.5 km of the slab: longer steps band the edges)
  float len = min( tB - tA, 1500.0 ), ds = len / 16.0;
  float fade = smoothstep( 0.012, 0.12, rd.y );
  // a pixel's footprint where the slab starts (~1.3 mrad per pixel), in texels of the 256-texel noise
  float lod = log2( max( tA * 0.0013 / ( 5600.0 / 256.0 ) / rdy, 1.0 ) );
  ivec2 bq = ivec2( mod( gl_FragCoord.xy, 4.0 ) );
  float jit = ( HF_BAYER[ bq.x + bq.y * 4 ] + 0.5 ) / 16.0;
  vec3 sunC = mix( vec3( 1.0, 0.95, 0.88 ), hfSunCol * 1.6, pow( sd, 4.0 ) ) * 1.35;
  vec3 skyC = vec3( 0.5, 0.57, 0.72 );
  float g = 0.6, phase = 0.65 + 0.9 * ( 1.0 - g * g ) / pow( 1.0 + g * g - 2.0 * g * sd, 1.5 ) * 0.1;
  float T = 1.0;
  vec3 S = vec3( 0.0 );
  for ( int k = 0; k < 16; k ++ ) {
    vec3 p = ro + rd * ( tA + ( float( k ) + jit ) * ds );
    float d = hfCloudD( p, lod );
    if ( d > 0.002 ) {
      float l = hfCloudD( p + hfSunDir * 110.0, lod + 1.0 ) * 1.3 + hfCloudD( p + hfSunDir * 300.0, lod + 1.0 );
      float lt = exp( - l * 1.6 ) * ( 1.0 - exp( - d * 6.0 ) * 0.5 );
      float h = ( p.y - hfCloudH ) / ${CLOUD_DEPTH.toFixed(1)};
      vec3 L = sunC * lt * phase + skyC * ( 0.45 + 0.4 * h );
      float a = 1.0 - exp( - d * ds * 0.006 );
      S += T * a * L;
      T *= 1.0 - a;
      if ( T < 0.02 ) break;
    }
  }
  return mix( col, col * T + S, fade );
}
`;

// --- sky -----------------------------------------------------------------
export function skyMaterial() {
  if (GPU) return N.skyNodeMaterial();
  return new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    defines: VCLOUDS ? { HF_VCLOUD: '' } : {},
    uniforms: { hfZenith: { value: PALETTE.zenith }, hfSkyHorizon: { value: PALETTE.skyHorizon }, hfSkyMid: { value: PALETTE.skyMid }, hfGround: { value: PALETTE.ground }, hfEnv: { value: 0 } },
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
      uniform vec3 hfZenith, hfSkyHorizon, hfGround, hfSkyMid;
      uniform float hfEnv;
      varying vec3 vDir;
      #include <common>
      #include <fog_pars_fragment>
      ${VCLOUDS ? VCLOUD_FUNCS : ''}
      // the gradient blends in Oklab (Ottosson): mixing the warm horizon and the blue zenith in
      // linear RGB goes through a greyish lilac halfway up
      vec3 hfLin2Ok( vec3 c ) {
        vec3 lms = vec3( dot( c, vec3( 0.4122214708, 0.5363325363, 0.0514459929 ) ), dot( c, vec3( 0.2119034982, 0.6806995451, 0.1073969566 ) ), dot( c, vec3( 0.0883024619, 0.2817188376, 0.6299787005 ) ) );
        lms = pow( max( lms, vec3( 0.0 ) ), vec3( 1.0 / 3.0 ) );
        return vec3( dot( lms, vec3( 0.2104542553, 0.7936177850, -0.0040720468 ) ), dot( lms, vec3( 1.9779984951, -2.4285922050, 0.4505937099 ) ), dot( lms, vec3( 0.0259040371, 0.7827717662, -0.8086757660 ) ) );
      }
      vec3 hfOk2Lin( vec3 c ) {
        vec3 lms = vec3( c.x + 0.3963377774 * c.y + 0.2158037573 * c.z, c.x - 0.1055613458 * c.y - 0.0638541728 * c.z, c.x - 0.0894841775 * c.y - 1.2914855480 * c.z );
        lms = lms * lms * lms;
        return vec3( dot( lms, vec3( 4.0767416621, -3.3077115913, 0.2309699292 ) ), dot( lms, vec3( -1.2684380046, 2.6097574011, -0.3413193965 ) ), dot( lms, vec3( -0.0041960863, -0.7034186147, 1.7076147010 ) ) );
      }
      void main() {
        vec3 rd = normalize( vDir );
        float h = max( rd.y, 0.0 );
        float sd = max( dot( rd, hfSunDir ), 0.0 );
      #ifdef HF_PB
        // the air above the low dust, from the baked tables (its aerosol makes the glow round the sun)
        vec3 col = hfSkyAir( vec3( rd.x, h, rd.z ) );
      #else
        // warm horizon (cooler on the side away from the sun) -> pale blue -> zenith blue
        float toSun = 0.5 + 0.5 * dot( normalize( rd.xz + vec2( 1e-5 ) ), normalize( hfSunDir.xz ) );
        vec3 hor = mix( hfSkyHorizon * vec3( 0.84, 0.92, 1.06 ), hfSkyHorizon, toSun * toSun );
        vec3 ok = mix( hfLin2Ok( hor ), hfLin2Ok( hfSkyMid ), smoothstep( 0.0, 0.2, h ) );
        ok = mix( ok, hfLin2Ok( hfZenith ), pow( smoothstep( 0.06, 0.7, h ), 0.85 ) );
        vec3 col = hfOk2Lin( ok );
        col += hfSunCol * ( pow( sd, 10.0 ) * 0.22 + pow( sd, 120.0 ) * 0.6 );
      #endif
        // cloud layer on a plane above the camera
        vec3 ro = hfEnv > 0.5 ? vec3( 0.0, 40.0, 0.0 ) : cameraPosition;
      #ifdef HF_VCLOUD
        col = hfCloudSlab( col, ro, rd, sd );
        // (the sun disc below is dimmed by the cover at the slab's base)
        float cl = hfCloud( ro.xz + rd.xz * ( ( hfCloudH - ro.y ) / max( rd.y, 0.015 ) ) ) * smoothstep( 0.015, 0.14, rd.y );
      #else
        float t = ( hfCloudH - ro.y ) / max( rd.y, 0.015 );
        vec2 cp = ro.xz + rd.xz * t;
        float cl = hfCloud( cp ) * smoothstep( 0.015, 0.14, rd.y );
        float thick = hfCloud( cp + hfSunDir.xz * 260.0 );          // denser towards the sun = darker base
        vec3 lit = mix( vec3( 1.0, 0.95, 0.88 ), hfSunCol * 1.6, pow( sd, 4.0 ) ) * 1.15;
        vec3 cloudCol = mix( lit, vec3( 0.62, 0.6, 0.66 ), thick * 0.55 );
        col = mix( col, cloudCol, cl * 0.88 );
      #endif
        // sun disc on top of thin cloud
        col += hfSunCol * smoothstep( 0.99965, 0.9999, sd ) * 38.0 * ( 1.0 - cl * 0.8 ) * ( 1.0 - hfEnv );
      #ifdef HF_PB
        // below the horizon (environment map only): sunlit sand, behind the dust
        if ( rd.y < 0.0 ) col = hfGround * ( 0.55 + 0.6 * hfSunDir.y );
        // the low dust in front, out to infinity (the same layer and light as the fog on the ground)
        float tauD = rd.y > 0.0 ? hfFogDensity * exp( - hfFogFalloff * ro.y ) / ( hfFogFalloff * max( rd.y, 1e-4 ) ) : 50.0;
        if ( rd.y < 0.0 ) tauD *= 1.0 - smoothstep( 0.0, 0.3, - rd.y );
        vec3 dT = exp( - vec3( tauD ) );
        col = col * dT + hfDustRate( dot( rd, hfSunDir ) ) * ( 1.0 - dT );
      #else
        // below the horizon (environment map only): sunlit sand
        if ( rd.y < 0.0 ) col = mix( hfFogCol, hfGround * ( 0.55 + 0.6 * hfSunDir.y ), smoothstep( 0.0, 0.25, - rd.y ) );
        // horizon haze: the ground fog at infinite distance
        float fogK = rd.y > 0.0 ? 1.0 - exp( - hfFogDensity * exp( - hfFogFalloff * ro.y ) / ( hfFogFalloff * max( rd.y, 1e-4 ) ) ) : 1.0;
        if ( rd.y < 0.0 ) fogK *= 1.0 - smoothstep( 0.0, 0.3, - rd.y );
        col = mix( col, hfFogTint( rd ), clamp( fogK, 0.0, 1.0 ) );
      #endif
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
  const pm = new (GPU ? W.PMREMGenerator : THREE.PMREMGenerator)(renderer);
  const rt = pm.fromScene(s, 0.02, 0.1, 1000);
  pm.dispose();
  m.dispose();
  return rt.texture;
}

// --- static world shadow ---------------------------------------------------
// what the static shadows leave out: things that move, see-through or unlit things, and flagged ones
const notStatic = (o) => o.userData.dynamic || o.userData.noBake || o.isPoints || o.isSprite || o.isLine
  || (o.isMesh && (Array.isArray(o.material) ? false : (o.material.transparent || o.material.isShaderMaterial || o.material.isMeshBasicMaterial)));

// One big orthographic depth render along the sun, done once after the world is built.
// It gives every static shadow out to the horizon; the regular shadow map near the
// camera adds the pods and crisp local detail on top.

export function bakeWorldShadow(renderer, scene, bounds, size) {
  const cam = new THREE.OrthographicCamera();
  if (GPU) cam.coordinateSystem = renderer.coordinateSystem;
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

  size = Math.min(size, maxTextureSize(renderer));
  const depth = new THREE.DepthTexture(size, size, THREE.FloatType);
  depth.compareFunction = THREE.LessEqualCompare;
  depth.minFilter = depth.magFilter = THREE.LinearFilter;
  const rt = new (GPU ? THREE.RenderTarget : THREE.WebGLRenderTarget)(size, size, { depthTexture: depth, depthBuffer: true, samples: 0 });
  rt.texture.generateMipmaps = false;

  // only static casters: everything flagged dynamic, transparent or unlit is hidden
  const hidden = [];
  scene.traverse((o) => {
    if (o.visible && notStatic(o)) { o.visible = false; hidden.push(o); }
  });
  const prevOverride = scene.overrideMaterial, prevBg = scene.background, prevRt = renderer.getRenderTarget();
  const prevAuto = renderer.shadowMap.autoUpdate;
  // (WebGPURenderer has no MeshDepthMaterial: any material that writes depth only does)
  const depthMat = GPU ? new W.MeshBasicNodeMaterial({ side: THREE.DoubleSide, colorWrite: false, fog: false })
    : new THREE.MeshDepthMaterial({ side: THREE.DoubleSide });
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

  // world -> [0,1] shadow texture space. WebGPURenderer: texture v runs down from the top (on its WebGL2
  // backend as well), and WebGPU's clip space already has the depth in 0..1
  const zk = GPU && renderer.coordinateSystem === THREE.WebGPUCoordinateSystem ? [1, 0] : [0.5, 0.5];
  const bias = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, GPU ? -0.5 : 0.5, 0, 0.5, 0, 0, zk[0], zk[1], 0, 0, 0, 1);
  ATMO.hfShadowMatrix.value.copy(bias).multiply(cam.projectionMatrix).multiply(cam.matrixWorldInverse);
  ATMO.hfShadowMap.value = depth;
  ATMO.hfShadowTexel.value.set(1 / size, 1 / size);
  ATMO.hfShadowOn.value = 1;
  // ~1.5 depth texels of slope tolerance in metres -> depth units
  ATMO.hfShadowBias.value = 1.5 / (cam.far - cam.near);
  return { rt, cam };
}

// --- cached mid-distance shadow (MID_SHADOW, docs/visual-next-steps.md C2) --------------------------
// The world bake is ~1 m per texel, so shadows past the near map's box (High: 130 m) are soft and blobby.
// This is the static world once more at ~0.3 m per texel (High), over a box of light space that covers
// the ground from just behind the camera to ~600 m ahead. Only static casters are in it, so it is redrawn
// only when the camera has moved an eighth of the box (about once a second at race speed), not per frame:
// a full extra cascade per frame would cost ~1-2 ms of CPU on the WebGPU path. It replaces the bake inside
// the box (hfStaticShadow), and with it everything that reads the bake: the lit materials' sun, the haze.
// box: light-space width and height in metres (the ground along the sun's azimuth is 1/sin(elevation)
// longer, so half the height covers about as far).
const LAYER_STATIC = 7, LAYER_PODS = 8;
export function createMidShadow(renderer, scene, { size = 2048, box = [640, 320], ahead = 230 } = {}) {
  const [BX, BY] = box, SW = Math.min(size, maxTextureSize(renderer)), SH = SW / 2;
  const cam = new THREE.OrthographicCamera(-BX / 2, BX / 2, BY / 2, -BY / 2, 1, 3200);
  // (WebGPU: depth runs 0..1; the renderer only rebuilds a projection whose coordinate system it has to change)
  if (GPU) { cam.coordinateSystem = renderer.coordinateSystem; cam.updateProjectionMatrix(); }
  cam.layers.set(LAYER_STATIC);
  const depth = new THREE.DepthTexture(SW, SH, THREE.FloatType);
  depth.compareFunction = THREE.LessEqualCompare;
  depth.minFilter = depth.magFilter = THREE.LinearFilter;
  const rt = new (GPU ? THREE.RenderTarget : THREE.WebGLRenderTarget)(SW, SH, { depthTexture: depth, depthBuffer: true, samples: 0 });
  rt.texture.generateMipmaps = false;
  const depthMat = GPU ? new W.MeshBasicNodeMaterial({ side: THREE.DoubleSide, colorWrite: false, fog: false })
    : new THREE.MeshDepthMaterial({ side: THREE.DoubleSide });
  // light-space axes (as the near shadow map's: x across the sun, y up the sun's vertical plane)
  const Z = SUN_DIR.clone(), X = new THREE.Vector3(0, 1, 0).cross(Z).normalize(), Y = Z.clone().cross(X);
  const zk = GPU && renderer.coordinateSystem === THREE.WebGPUCoordinateSystem ? [1, 0] : [0.5, 0.5];
  const bias = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, GPU ? -0.5 : 0.5, 0, 0.5, 0, 0, zk[0], zk[1], 0, 0, 0, 1);
  const tx = BX / SW, ty = BY / SH;
  const P = new THREE.Vector3(), F = new THREE.Vector3();
  let cu = Infinity, cv = Infinity, draws = 0;
  // the pods: a quarter of the texels, drawn every frame while one is in the box and past the near map
  const pdepth = new THREE.DepthTexture(SW / 2, SH / 2, THREE.FloatType);
  pdepth.compareFunction = THREE.LessEqualCompare;
  pdepth.minFilter = pdepth.magFilter = THREE.LinearFilter;
  const prt = new (GPU ? THREE.RenderTarget : THREE.WebGLRenderTarget)(SW / 2, SH / 2, { depthTexture: pdepth, depthBuffer: true, samples: 0 });
  prt.texture.generateMipmaps = false;
  const pcam = cam.clone();
  pcam.layers.set(LAYER_PODS);
  const tagged = new WeakSet(), Q4 = new THREE.Vector4();
  ATMO.hfMidPods.value = pdepth;
  ATMO.hfMidMap.value = depth;
  ATMO.hfMidTexel.value.set(1 / SW, 1 / SH);
  ATMO.hfMidBias.value = 0.5 / (cam.far - cam.near);
  const draw = (target, c) => {
    const prevOverride = scene.overrideMaterial, prevBg = scene.background, prevRt = renderer.getRenderTarget();
    const prevAuto = renderer.shadowMap.autoUpdate;
    scene.overrideMaterial = depthMat;
    scene.background = null;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.render(scene, c);
    renderer.setRenderTarget(prevRt);
    renderer.shadowMap.autoUpdate = prevAuto;
    scene.overrideMaterial = prevOverride;
    scene.background = prevBg;
  };
  const api = {
    rt, cam, get draws() { return draws; }, renders: 0,
    // the static casters (call after the world is built): they go on a layer of their own
    collect() {
      let n = 0;
      scene.traverse((o) => { if ((o.isMesh || o.isInstancedMesh) && !notStatic(o)) { o.layers.enable(LAYER_STATIC); n++; } });
      return n;
    },
    // follows the camera; redraws when the wanted box has moved an eighth of its size (or when forced)
    update(camera, force = false) {
      camera.getWorldDirection(F);
      F.y = 0;
      if (F.lengthSq() < 1e-6) F.set(0, 0, -1);
      F.normalize();
      P.copy(camera.position).addScaledVector(F, ahead);
      const u = P.dot(X), v = P.dot(Y);
      if (!force && Math.abs(u - cu) < BX / 8 && Math.abs(v - cv) < BY / 8) return false;
      cu = Math.round(u / tx) * tx; cv = Math.round(v / ty) * ty;        // whole texels: static edges stay put
      cam.position.copy(X).multiplyScalar(cu).addScaledVector(Y, cv).addScaledVector(Z, P.dot(Z) + 1600);
      cam.lookAt(F.copy(cam.position).sub(Z));
      cam.updateMatrixWorld();
      pcam.position.copy(cam.position); pcam.quaternion.copy(cam.quaternion); pcam.updateMatrixWorld();
      const calls0 = GPU ? renderer.info.render.drawCalls : renderer.info.render.calls;
      draw(rt, cam);
      // (WebGL: a depth texture is only allocated once drawn into, and sampling it before then drops the draws)
      if (api.renders === 0) draw(prt, pcam);
      draws = (GPU ? renderer.info.render.drawCalls : renderer.info.render.calls) - calls0;
      ATMO.hfMidMatrix.value.copy(bias).multiply(cam.projectionMatrix).multiply(cam.matrixWorldInverse);
      ATMO.hfMidOn.value = 1;
      api.renders++;
      return true;
    },
    // pods: their roots (the casting meshes go on a layer of their own); drawn when one is inside the box
    // and more than ~80 m from the camera, where the near shadow map no longer has it (force: draw anyway,
    // to build its pipelines at load)
    pods(roots, camera, force = false) {
      let any = false;
      for (const r of roots) {
        if (!r || !r.visible) continue;
        if (!tagged.has(r)) { tagged.add(r); r.traverse((o) => { if (o.isMesh && o.castShadow) o.layers.enable(LAYER_PODS); }); }
        if (r.position.distanceToSquared(camera.position) < 75 * 75) continue;
        Q4.set(r.position.x, r.position.y, r.position.z, 1).applyMatrix4(ATMO.hfMidMatrix.value);
        if (Q4.x > 0.02 && Q4.x < 0.98 && Q4.y > 0.02 && Q4.y < 0.98) any = true;
      }
      ATMO.hfMidPodsOn.value = any ? 1 : 0;
      if (any || force) draw(prt, pcam);
      return any;
    },
  };
  return api;
}
