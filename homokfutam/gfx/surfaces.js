import * as THREE from 'three';
import { atmoUniforms } from './atmosphere.js';

// ============================================================
//  Surface materials: PBR textures from Poly Haven (CC0), packed by hand:
//  <name>_c.webp = albedo with AO baked in, <name>_n.webp = normal.xy + roughness in B.
//  Terrain and track use planar projection, rocks and stone use triplanar.
// ============================================================
const url = (f) => new URL(`../assets/tex/${f}.webp`, import.meta.url).href;
const SETS = ['sand', 'track', 'cliff', 'boulder', 'blocks'];
export const SURF = {};

export function loadSurfaces(renderer) {
  const loader = new THREE.TextureLoader();
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const pending = [];
  const load = (f, srgb) => {
    let done;
    pending.push(new Promise((r) => { done = r; }));
    const t = new THREE.Texture();
    const attempt = (n) => loader.load(url(f), (tex) => { t.image = tex.image; t.needsUpdate = true; done(); }, undefined, () => {
      if (n < 3) setTimeout(() => attempt(n + 1), 400 * (n + 1));     // flaky networks: try again a few times
      else { console.warn('HOMOKFUTAM: texture failed', f); done(); }
    });
    attempt(0);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = aniso;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    return t;
  };
  for (const s of SETS) SURF[s] = { c: load(s + '_c', true), n: load(s + '_n', false) };
  SURF.ready = Promise.all(pending);
  return SURF;
}

// shared snippets ------------------------------------------------------------
const UNPACK = /* glsl */`
vec3 hfUnpackN( vec4 t, float k ) {
  vec2 xy = ( t.rg * 2.0 - 1.0 ) * k;
  return vec3( xy, sqrt( max( 1.0 - dot( xy, xy ), 0.0 ) ) );
}
float hfLum( vec3 c ) { return dot( c, vec3( 0.299, 0.587, 0.114 ) ); }
`;
// world-space geometric normal before normal_fragment_begin runs
const GEO_N = /* glsl */`
#ifdef FLAT_SHADED
  vec3 hfGN = normalize( cross( dFdx( vHfWorld ), dFdy( vHfWorld ) ) );
#else
  vec3 hfGN = normalize( ( vec4( normalize( vNormal ), 0.0 ) * viewMatrix ).xyz ) * ( gl_FrontFacing ? 1.0 : -1.0 );
#endif
`;

function patch(material, key, uniforms, frag, vert) {
  material.onBeforeCompile = (sh) => {
    atmoUniforms(sh);
    Object.assign(sh.uniforms, uniforms);
    if (vert) vert(sh);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\n' + UNPACK + frag.pars);
    for (const [chunk, code] of Object.entries(frag.chunks)) sh.fragmentShader = sh.fragmentShader.replace(`#include <${chunk}>`, code);
  };
  material.customProgramCacheKey = () => key;
  material.userData.uniforms = uniforms;
  return material;
}

// ---------------------------------------------------------------------------
//  Triplanar rock / stone. The texture is normalised by its own mean, so the vertex colours
//  (strata) or the material colour set the hue and the texture adds the detail.
// ---------------------------------------------------------------------------
export function triplanarMaterial(set, { scale = 1 / 10, chroma = 0.5, contrast = 1, normal = 1, rough = [0.55, 0.6], vertexColors = true, color = '#ffffff', macro = 0.3, side = THREE.FrontSide, flat = false } = {}) {
  const m = new THREE.MeshStandardMaterial({ vertexColors, color, roughness: 1, metalness: 0, side, flatShading: flat });
  const u = {
    tpC: { value: SURF[set].c }, tpN: { value: SURF[set].n }, tpScale: { value: scale }, tpChroma: { value: chroma }, tpContrast: { value: contrast },
    tpNormal: { value: normal }, tpRough: { value: new THREE.Vector2(...rough) }, tpMacro: { value: macro },
  };
  return patch(m, 'hf-tri', u, {
    pars: /* glsl */`uniform sampler2D tpC, tpN; uniform float tpScale, tpNormal, tpMacro, tpChroma, tpContrast; uniform vec2 tpRough;`,
    chunks: {
      map_fragment: GEO_N + /* glsl */`
        vec3 tpP = vHfWorld * tpScale;
        vec3 tpW = pow( abs( hfGN ), vec3( 4.0 ) ); tpW /= tpW.x + tpW.y + tpW.z;
        vec4 tpCx = texture2D( tpC, tpP.zy ), tpCy = texture2D( tpC, tpP.xz ), tpCz = texture2D( tpC, tpP.xy );
        vec4 tpNx = texture2D( tpN, tpP.zy ), tpNy = texture2D( tpN, tpP.xz ), tpNz = texture2D( tpN, tpP.xy );
        vec3 tpAlb = tpCx.rgb * tpW.x + tpCy.rgb * tpW.y + tpCz.rgb * tpW.z;
        float tpR = tpNx.b * tpW.x + tpNy.b * tpW.y + tpNz.b * tpW.z;
        float tpMac = texture2D( hfCloudTex, vHfWorld.xz / 1300.0 ).r;
        vec3 tpRel = tpAlb / max( textureLod( tpC, vec2( 0.5 ), 12.0 ).rgb, vec3( 0.03 ) );
        tpRel = max( mix( vec3( hfLum( tpRel ) ), tpRel, tpChroma ), 0.0 );
        tpRel = pow( tpRel, vec3( tpContrast ) );
        diffuseColor.rgb *= tpRel * ( 1.0 - tpMacro * 0.5 + tpMacro * tpMac );`,
      roughnessmap_fragment: /* glsl */`float roughnessFactor = clamp( tpRough.x + tpRough.y * tpR, 0.04, 1.0 );`,
      normal_fragment_maps: /* glsl */`
        {
          vec3 wn = normalize( ( vec4( normal, 0.0 ) * viewMatrix ).xyz );
          float fade = tpNormal * ( 1.0 - smoothstep( 120.0, 700.0, length( vHfWorld - cameraPosition ) ) * 0.7 );
          vec3 tX = hfUnpackN( tpNx, fade ), tY = hfUnpackN( tpNy, fade ), tZ = hfUnpackN( tpNz, fade );
          tX = vec3( tX.xy + wn.zy, abs( tX.z ) * wn.x );
          tY = vec3( tY.xy + wn.xz, abs( tY.z ) * wn.y );
          tZ = vec3( tZ.xy + wn.xy, abs( tZ.z ) * wn.z );
          vec3 nW = normalize( tX.zyx * tpW.x + tY.xzy * tpW.y + tZ.xyz * tpW.z );
          normal = normalize( ( viewMatrix * vec4( nW, 0.0 ) ).xyz );
        }`,
    },
  });
}

// ---------------------------------------------------------------------------
//  Terrain: rippled sand at two scales (anti-tiling), packed sand along the track (aTrackK),
//  slope darkening, slow drifting sand streaks, macro colour variation.
// ---------------------------------------------------------------------------
export const WIND_DIR = new THREE.Vector2(0.92, 0.39).normalize();
export function terrainMaterial() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
  const u = {
    sC: { value: SURF.sand.c }, sN: { value: SURF.sand.n }, kC: { value: SURF.track.c }, kN: { value: SURF.track.n },
    tWind: { value: WIND_DIR },
  };
  return patch(m, 'hf-terrain', u, {
    pars: /* glsl */`uniform sampler2D sC, sN, kC, kN; uniform vec2 tWind; varying float vTrackK;`,
    chunks: {
      map_fragment: /* glsl */`
        vec2 tp = vHfWorld.xz;
        float camD = length( vHfWorld - cameraPosition );
        vec2 uv1 = tp / 6.5, uv2 = mat2( 0.8, -0.6, 0.6, 0.8 ) * tp / 27.0;
        vec4 c1 = texture2D( sC, uv1 ), c2 = texture2D( sC, uv2 );
        vec4 n1 = texture2D( sN, uv1 ), n2 = texture2D( sN, uv2 );
        vec4 k1 = texture2D( kC, tp / 9.0 ), kn = texture2D( kN, tp / 9.0 );
        float mean = max( hfLum( textureLod( sC, vec2( 0.5 ), 12.0 ).rgb ), 0.02 );
        float kMean = max( hfLum( textureLod( kC, vec2( 0.5 ), 12.0 ).rgb ), 0.02 );
        float near = 1.0 - smoothstep( 60.0, 380.0, camD );
        float det = mix( hfLum( c2.rgb ), hfLum( c1.rgb ), 0.35 + 0.4 * near ) / mean;
        float sh = smoothstep( 0.15, 0.85, vTrackK );
        det = mix( det, hfLum( k1.rgb ) / kMean, sh );
        float mac = texture2D( hfCloudTex, tp / 1700.0 ).r;
        float mac2 = texture2D( hfCloudTex, tp / 260.0 + 0.5 ).r;
        // drifting sand streaks along the wind
        vec2 wp = vec2( dot( tp, tWind ), dot( tp, vec2( -tWind.y, tWind.x ) ) );
        float st = texture2D( hfCloudTex, vec2( wp.x * 0.0021 - hfTime * 0.006, wp.y * 0.017 ) ).r;
        st *= texture2D( hfCloudTex, vec2( wp.x * 0.0009 - hfTime * 0.0025, wp.y * 0.004 ) + 0.3 ).r;
        float drift = smoothstep( 0.32, 0.5, st ) * ( 1.0 - sh );
        vec3 tint = mix( vec3( 1.0 ), vec3( 0.86, 0.8, 0.74 ), sh * 0.8 );
        diffuseColor.rgb *= ( 0.35 + 0.65 * det ) * tint * ( 0.84 + 0.32 * mac ) * ( 0.94 + 0.12 * mac2 ) * ( 1.0 + drift * 0.13 );
        float tR = mix( mix( n2.b, n1.b, 0.5 ), kn.b, sh );`,
      roughnessmap_fragment: /* glsl */`float roughnessFactor = clamp( 0.72 + 0.32 * tR, 0.0, 1.0 );`,
      normal_fragment_maps: /* glsl */`
        {
          vec3 wn = normalize( ( vec4( normal, 0.0 ) * viewMatrix ).xyz );
          float k = 1.15 * ( 1.0 - smoothstep( 90.0, 900.0, camD ) * 0.75 );
          vec3 a = hfUnpackN( n1, k * ( 0.35 + 0.65 * near ) ), b = hfUnpackN( n2, k * 0.8 ), c = hfUnpackN( kn, k );
          vec3 t = normalize( vec3( a.xy + b.xy, a.z * b.z ) );
          t = mix( t, c, sh );
          vec3 nW = normalize( vec3( t.x + wn.x, abs( t.z ) * wn.y, t.y + wn.z ) );
          normal = normalize( ( viewMatrix * vec4( nW, 0.0 ) ).xyz );
        }`,
    },
  }, (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aTrackK;\nvarying float vTrackK;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTrackK = aTrackK;');
  });
}

// ---------------------------------------------------------------------------
//  Track: packed sand, a polished/darker racing line with scorch marks from the jets,
//  loose sand drifting in from the edges, and the dynamic trail map (pods' scorch/grooves).
//  aTr = (lateral metres, arc length metres, racing line lateral metres, half width)
// ---------------------------------------------------------------------------
export function trackMaterial(streakTex, trackLength) {
  const m = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2 });
  const u = {
    kC: { value: SURF.track.c }, kN: { value: SURF.track.n }, sC: { value: SURF.sand.c }, sN: { value: SURF.sand.n },
    kStreak: { value: streakTex }, kL: { value: trackLength },
    kTrail: { value: null }, kTrailOn: { value: 0 },
  };
  return patch(m, 'hf-track', u, {
    pars: /* glsl */`uniform sampler2D kC, kN, sC, sN, kStreak, kTrail; uniform float kL, kTrailOn; varying vec4 vTr;`,
    chunks: {
      map_fragment: /* glsl */`
        float d = vTr.x, s = vTr.y, hw = vTr.w;
        float camD = length( vHfWorld - cameraPosition );
        vec2 tuv = vec2( d, s ) / 8.5, suv = vHfWorld.xz / 6.5;
        vec4 kc = texture2D( kC, tuv ), kn = texture2D( kN, tuv );
        vec4 sc = texture2D( sC, suv ), sn = texture2D( sN, suv );
        float kMean = max( hfLum( textureLod( kC, vec2( 0.5 ), 12.0 ).rgb ), 0.02 ), sMean = max( hfLum( textureLod( sC, vec2( 0.5 ), 12.0 ).rgb ), 0.02 );
        vec3 streak = texture2D( kStreak, vec2( d / ( hw * 2.5 ) + 0.5, s / 46.0 ) ).rgb;
        float n1 = texture2D( hfCloudTex, vec2( d, s ) / vec2( 23.0, 61.0 ) ).r;
        float n2 = texture2D( hfCloudTex, vec2( d, s ) / vec2( 9.0, 140.0 ) + 0.4 ).r;
        // loose sand blown in from the edges
        float edge = abs( d ) / hw;
        float drift = smoothstep( 0.72, 1.02, edge + ( n1 - 0.5 ) * 0.55 );
        drift = max( drift, smoothstep( 0.62, 0.75, n2 ) * smoothstep( 0.3, 0.8, edge ) * 0.8 );
        // the racing line: packed hard, darker, with jet scorch
        float ld = ( d - vTr.z ) / 5.5;
        float groove = exp( - ld * ld ) * ( 1.0 - drift );
        float scorch = smoothstep( 0.55, 0.78, texture2D( hfCloudTex, vec2( d / 6.0, s / 55.0 ) + 0.7 ).r ) * groove;
        vec4 trail = kTrailOn > 0.5 ? min( texture2D( kTrail, vec2( d / ( hw * 2.6 ) + 0.5, s / kL ) ), vec4( 1.0 ) ) : vec4( 0.0 );
        vec3 base = vec3( 0.47, 0.29, 0.15 ) * ( hfLum( kc.rgb ) / kMean ) * mix( vec3( 1.0 ), streak / vec3( 0.6, 0.4, 0.19 ), 0.35 );
        vec3 sand = vec3( 0.68, 0.46, 0.26 ) * ( 0.4 + 0.6 * hfLum( sc.rgb ) / sMean );
        vec3 col = mix( base, sand, drift );
        col *= 1.0 - groove * 0.16 - scorch * 0.3;
        col *= 1.0 - trail.r * 0.32;
        col = mix( col, vec3( 0.16, 0.12, 0.1 ), trail.g * 0.55 );
        col *= 1.0 - smoothstep( 0.92, 1.0, edge ) * 0.2 * ( 1.0 - drift );
        diffuseColor.rgb *= col;
        float tR = mix( kn.b, sn.b, drift );
        float polish = groove * 0.22 + trail.r * 0.1;`,
      roughnessmap_fragment: /* glsl */`float roughnessFactor = clamp( 0.7 + 0.32 * tR - polish, 0.0, 1.0 );`,
      normal_fragment_maps: /* glsl */`
        {
          vec3 wn = normalize( ( vec4( normal, 0.0 ) * viewMatrix ).xyz );
          float k = 1.0 - smoothstep( 80.0, 600.0, camD ) * 0.7;
          vec3 t = normalize( mix( hfUnpackN( kn, k * ( 1.0 - groove * 0.5 ) ), hfUnpackN( sn, k * 1.2 ), drift ) );
          // the track frame: lateral along d, forward along s; approximate with world xz (texture detail only)
          vec3 nW = normalize( vec3( t.x + wn.x, abs( t.z ) * wn.y, t.y + wn.z ) );
          normal = normalize( ( viewMatrix * vec4( nW, 0.0 ) ).xyz );
        }`,
    },
  }, (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aTr;\nvarying vec4 vTr;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTr = aTr;');
  });
}
