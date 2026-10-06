import * as THREE from 'three';
import { atmoUniforms } from './atmosphere.js';

// ============================================================
//  Surface materials: PBR textures from Poly Haven (CC0), packed by hand:
//  <name>_c.webp = albedo with AO baked in, <name>_n.webp = normal.xy + roughness in B.
//  Triplanar stone for the built structures.
// ============================================================
const url = (f) => new URL(`../assets/tex/${f}.webp`, import.meta.url).href;
const SETS = ['blocks'];          // the ground and rocks moved to gfx/ground.js (KTX2 arrays)
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
