import * as THREE from 'three';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import basisJs from 'three/addons/libs/basis/basis_transcoder.js?url';
import basisWasm from 'three/addons/libs/basis/basis_transcoder.wasm?url';
import { atmoUniforms } from './atmosphere.js';
import { GPU, U, T, maxAnisotropy, N } from './backend.js';

// ============================================================
//  Ground and rock surfaces.
//
//  Texture arrays baked in Blender (models/world/build_textures.py), KTX2:
//   ground_c / ground_n  planar layers, see LAYER    rock_c / rock_n  triplanar layers, see ROCK
//   *_c: RGB albedo (sRGB), A height      *_n: RG tangent normal, B roughness, A occlusion
//
//  The terrain and the track share one layer blend (height-aware, anti-tiled), so where the
//  track's sand berm meets the dunes both sides compute the same surface. On top of that:
//  a macro map baked at load (world/macro.js: large-scale occlusion, dune crests, basins,
//  rock aprons, wind tails), sand glitter and a grazing sheen on the dunes, and for the rocks
//  sand settling on ledges and around their feet.
// ============================================================
export const LAYER = { ripple: 0, soft: 1, gravel: 2, hardpan: 3, packed: 4, slick: 5, paving: 6 };
export const ROCK = { cliff: 0, boulder: 1 };
export const ARENA = { stone: 0, plaster: 1, wood: 2, cloth: 3, metal: 4 };
const NL = 7;
const TILE = [5.0, 5.0, 3.2, 5.0, 4.5, 7.0, 4.5];        // metres per repeat in the game
// parallax occlusion (?gfx=pom:1): depth of each layer's relief in metres
export const POM_DEPTH = [0.035, 0.02, 0.03, 0.018, 0.022, 0.02, 0.028];
export const WIND_DIR = new THREE.Vector2(0.92, 0.39).normalize();

const url = (f) => new URL(`../assets/tex/${f}.ktx2`, import.meta.url).href;

function placeholder(layers, rgba) {
  const d = new Uint8Array(4 * layers);
  for (let i = 0; i < layers; i++) d.set(rgba, i * 4);
  const t = new THREE.DataArrayTexture(d, 1, 1, layers);
  t.needsUpdate = true;
  return t;
}

// shared uniforms: every ground/rock material references these objects, so swapping a
// texture (placeholder -> KTX2, macro map at boot) needs no recompiles. Texture and uniform nodes
// for the node materials (gfx/backend.js); the per-layer constants below stay plain values.
export const GU = {
  gC: T(placeholder(NL, [200, 160, 110, 128])),
  gN: T(placeholder(NL, [128, 128, 230, 255])),
  gRC: T(placeholder(2, [190, 130, 85, 128])),
  gRN: T(placeholder(2, [128, 128, 220, 255])),
  gAC: T(placeholder(5, [215, 190, 150, 128])),
  gAN: T(placeholder(5, [128, 128, 220, 255])),
  gGlint: T(null),
  gMac: T(null),
  gMac2: T(null),
  gMacH: T(null),
  gMacXf: U(new THREE.Vector4(0, 0, 1, 0)),     // (x0, z0, 1/size, on)
  gWind: { value: WIND_DIR },
  gTile: { value: TILE.slice() },
  gAxis: { value: [] },
  // colour trim per layer (ripple, soft, gravel, hardpan, packed, slickrock, paving)
  gTint: { value: [[1, 1, 1], [1, 1, 1], [1.12, 1.08, 1.04], [0.9, 0.82, 0.72], [1, 1, 1], [1, 1, 1], [1, 1, 1]].map((c) => new THREE.Vector3(...c)) },
};
// v axis of each layer in world xz (u = v rotated a quarter turn). Wind layers line their
// ripples up across the wind, the rest get different angles so their repeats never line up.
{
  const ang = [0, 0, 0.7, 2.1, 0, 1.3, 0.25];
  for (let i = 0; i < NL; i++) {
    const a = Math.atan2(WIND_DIR.y, WIND_DIR.x) + ang[i];
    GU.gAxis.value.push(new THREE.Vector2(Math.cos(a), Math.sin(a)));
  }
}

function glintTexture(size = 128) {
  const d = new Uint8Array(size * size * 4);
  let s = 1234567;
  const r = () => { s = (Math.imul(s, 1103515245) + 12345) | 0; return ((s >>> 8) & 255); };
  for (let i = 0; i < d.length; i++) d[i] = r();
  const t = new THREE.DataTexture(d, size, size);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true; t.anisotropy = 4; t.needsUpdate = true;
  return t;
}

// KTX2 loader with the Basis transcoder that Vite bundles (the hashed file names go through the
// loading manager, since KTX2Loader asks for fixed names)
export function ktx2Loader(renderer) {
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((u) => (u.endsWith('basis_transcoder.js') ? basisJs : u.endsWith('basis_transcoder.wasm') ? basisWasm : u));
  return new KTX2Loader(manager).setTranscoderPath('').detectSupport(renderer);
}

export function loadGround(renderer, Q) {
  GU.gGlint.value = glintTexture();
  const loader = ktx2Loader(renderer);
  const aniso = Math.min(Q.aniso ?? 8, maxAnisotropy(renderer));
  const jobs = [['gC', 'ground_c'], ['gN', 'ground_n'], ['gRC', 'rock_c'], ['gRN', 'rock_n'], ['gAC', 'arena_c'], ['gAN', 'arena_n']].map(([key, file]) => {
    const attempt = (n) => loader.loadAsync(url(file)).then((tex) => {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.anisotropy = aniso;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      if (!file.endsWith('_c')) tex.colorSpace = THREE.NoColorSpace;
      tex.needsUpdate = true;
      GU[key].value = tex;
    }, (e) => {
      if (n < 3) return new Promise((r) => setTimeout(r, 400 * (n + 1))).then(() => attempt(n + 1));
      console.warn('HOMOKFUTAM: texture failed', file, e);
    });
    return attempt(0);
  });
  return Promise.all(jobs).finally(() => loader.dispose());
}

// ---------------------------------------------------------------------------
//  GLSL
// ---------------------------------------------------------------------------
const PARS = /* glsl */`
uniform highp sampler2DArray gC, gN;
uniform sampler2D gGlint, gMac, gMac2, gMacH;
uniform vec4 gMacXf;
uniform vec2 gWind;
uniform float gTile[ ${NL} ];
uniform vec2 gAxis[ ${NL} ];
uniform vec3 gTint[ ${NL} ];
float gLum( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }
vec4 gHash4( vec2 p ) {          // Hoskins, hash without sine
  vec4 p4 = fract( p.xyxy * vec4( 0.1031, 0.1030, 0.0973, 0.1099 ) );
  p4 += dot( p4, p4.wzxy + 33.33 );
  return fract( ( p4.xxyz + p4.yzzw ) * p4.zywx );
}
vec2 gMacUv( vec2 xz ) { return ( xz - gMacXf.xy ) * gMacXf.z; }
vec4 gMacro( vec2 xz ) { return gMacXf.w > 0.5 ? texture2D( gMac, gMacUv( xz ) ) : vec4( 1.0, 0.5, 0.0, 0.0 ); }
vec4 gMacro2( vec2 xz ) { return gMacXf.w > 0.5 ? texture2D( gMac2, gMacUv( xz ) ) : vec4( 0.0 ); }

// one layer in its own frame (p in metres along u / v), anti-tiled: two lookups at offsets that
// change with a slow noise, blended where the noise steps (Quilez, "texture repetition")
void gFetch( int i, vec2 p, vec2 dpx, vec2 dpy, float rnd, float tile, out vec4 c, out vec4 n ) {
  float inv = 1.0 / tile;
  vec2 uv = p * inv, dx = dpx * inv, dy = dpy * inv;
  float L = float( i );
#if GQ > 0
  float l = rnd * 5.0 + float( i ) * 1.37;
  float f = fract( l ), ia = floor( l );
  vec2 oa = sin( vec2( 3.0, 7.0 ) * ia ), ob = sin( vec2( 3.0, 7.0 ) * ( ia + 1.0 ) );
  vec4 ca = textureGrad( gC, vec3( uv + oa, L ), dx, dy ), cb = textureGrad( gC, vec3( uv + ob, L ), dx, dy );
  float k = smoothstep( 0.3, 0.7, f + ( cb.a - ca.a ) * 0.35 );
  c = mix( ca, cb, k );
  n = mix( textureGrad( gN, vec3( uv + oa, L ), dx, dy ), textureGrad( gN, vec3( uv + ob, L ), dx, dy ), k );
#else
  c = textureGrad( gC, vec3( uv, L ), dx, dy );
  n = textureGrad( gN, vec3( uv, L ), dx, dy );
#endif
}

// blended surface of all layers with weight > 0 (weights sum to 1)
struct GSurf { vec3 alb; vec2 nd; float rough; float ao; float h; float sand; };
// trackFrame: (a, b) world axes of the track's own frame and its coordinates p, used by the
// packed layer (index 4) so its grooves run along the track
// off: world-xz offset to look the layers up at (parallax occlusion, gParallax); the mip level stays the
// surface's own
GSurf gBlend( float w[ ${NL} ], vec2 xz, vec2 off, float rnd, vec2 trA, vec2 trB, vec2 trP, float trTile ) {
  vec2 dxz = dFdx( xz ), dyz = dFdy( xz ), dtx = dFdx( trP ), dty = dFdy( trP );
  xz += off;
  trP += vec2( dot( off, trA ), dot( off, trB ) );
  vec4 cs[ ${NL} ]; vec4 ns[ ${NL} ]; float hs[ ${NL} ];
  float hmax = 0.0;
  for ( int i = 0; i < ${NL}; i ++ ) {
    hs[ i ] = 0.0;
    if ( w[ i ] > 0.004 ) {
      if ( i == 4 ) gFetch( i, trP, dtx, dty, rnd, trTile, cs[ i ], ns[ i ] );
      else {
        vec2 b = gAxis[ i ], a = vec2( - b.y, b.x );
        gFetch( i, vec2( dot( xz, a ), dot( xz, b ) ), vec2( dot( dxz, a ), dot( dxz, b ) ), vec2( dot( dyz, a ), dot( dyz, b ) ), rnd, gTile[ i ], cs[ i ], ns[ i ] );
      }
      hs[ i ] = w[ i ] * ( 0.35 + cs[ i ].a );
      hmax = max( hmax, hs[ i ] );
    }
  }
  GSurf s;
  s.alb = vec3( 0.0 ); s.nd = vec2( 0.0 ); s.rough = 0.0; s.ao = 0.0; s.h = 0.0; s.sand = 0.0;
  float tot = 0.0, cut = hmax - 0.1;
  for ( int i = 0; i < ${NL}; i ++ ) {
    if ( w[ i ] > 0.004 ) {
      float b = max( hs[ i ] - cut, 0.0 );
      vec2 t = ns[ i ].xy * 2.0 - 1.0;
      vec2 ax, bx;
      if ( i == 4 ) { ax = trA; bx = trB; } else { bx = gAxis[ i ]; ax = vec2( - bx.y, bx.x ); }
      s.alb += cs[ i ].rgb * gTint[ i ] * b;
      s.nd += ( t.x * ax + t.y * bx ) * b;
      s.rough += ns[ i ].b * b;
      s.ao += ns[ i ].a * b;
      s.h += cs[ i ].a * b;
      if ( i < 2 ) s.sand += b;
      tot += b;
    }
  }
  float it = 1.0 / max( tot, 1e-4 );
  s.alb *= it; s.nd *= it; s.rough *= it; s.ao *= it; s.h *= it; s.sand *= it;
  return s;
}

#ifdef HF_POM
// --- parallax occlusion (?gfx=pom:1, docs/visual-next-steps.md C3) -----------------------------------
// The layers' heights (alpha of ground_c) as real relief near the camera: the view ray is marched through
// the height field of the dominant layer, and every layer is then looked up where it hits, so ripples,
// gravel, paving and the track's grooves hide what is behind them at grazing angles. A second short march
// towards the sun shades the troughs on the side away from it (the sun is low: long, crisp ripple shadows).
// Depth of each layer's relief in metres (ripple, soft, gravel, hardpan, packed, slickrock, paving):
const float gDepth[ ${NL} ] = float[]( ${POM_DEPTH.join(', ')} );
// height of layer i, anti-tiled as gFetch does
float gFetchH( int i, vec2 p, vec2 dpx, vec2 dpy, float rnd, float tile ) {
  float inv = 1.0 / tile;
  vec2 uv = p * inv, dx = dpx * inv, dy = dpy * inv;
  float L = float( i ), l = rnd * 5.0 + float( i ) * 1.37, f = fract( l ), ia = floor( l );
  vec2 oa = sin( vec2( 3.0, 7.0 ) * ia ), ob = sin( vec2( 3.0, 7.0 ) * ( ia + 1.0 ) );
  float ha = textureGrad( gC, vec3( uv + oa, L ), dx, dy ).a, hb = textureGrad( gC, vec3( uv + ob, L ), dx, dy ).a;
  return mix( ha, hb, smoothstep( 0.3, 0.7, f + ( hb - ha ) * 0.35 ) );
}
// world-xz offset at which the surface is seen; sh: its self-shadow from the sun (1 = lit).
// d*: screen derivatives of xz and of the track frame trP, taken before any branch.
vec2 gParallax( float w[ ${NL} ], vec2 xz, float rnd, vec2 trA, vec2 trB, vec2 trP, float trTile, vec3 N,
                vec2 dxz, vec2 dyz, vec2 dtx, vec2 dty, out float sh ) {
  sh = 1.0;
  int im = 0;
  float wm = 0.0;
  for ( int i = 0; i < ${NL}; i ++ ) if ( w[ i ] > wm ) { wm = w[ i ]; im = i; }
  vec3 V = cameraPosition - vHfWorld;
  float camD = length( V );
  V /= camD;
  // fades out where layers mix (no single relief to follow), and once a pixel covers more than ~1 cm of
  // ground (by then the relief is a few pixels, and a march that coarse only blurs it)
  float foot = max( length( dxz ), length( dyz ) );
  float fade = smoothstep( 0.4, 0.7, wm ) * ( 1.0 - smoothstep( 0.005, 0.016, foot ) ) * step( camD, 60.0 );
  float D = gDepth[ im ] * fade;
  if ( D < 1e-3 ) return vec2( 0.0 );
  // the dominant layer's frame: the track's own (lateral, along) for the packed layer
  bool tr = im == 4;
  vec2 b = tr ? trB : gAxis[ im ], a = vec2( - b.y, b.x );
  vec2 p0 = tr ? trP : vec2( dot( xz, a ), dot( xz, b ) );
  vec2 dpx = tr ? dtx : vec2( dot( dxz, a ), dot( dxz, b ) ), dpy = tr ? dty : vec2( dot( dyz, a ), dot( dyz, b ) );
  float tile = tr ? trTile : gTile[ im ];
  // down the view ray: xz moves by -V.xz / (V.N) per metre of depth
  float vn = max( dot( V, N ), 0.2 );           // (offset limiting at grazing angles)
  vec2 dirW = - V.xz / vn * D, dirP = vec2( dot( dirW, a ), dot( dirW, b ) );
  int n = int( mix( 14.0, 6.0, ( vn - 0.2 ) * 1.25 ) );
  float st = 1.0 / float( n ), d = 0.0, dPrev = 0.0;
  float h = gFetchH( im, p0, dpx, dpy, rnd, tile ), hPrev = h;
  for ( int k = 0; k < 14; k ++ ) {
    if ( k >= n || d >= 1.0 - h ) break;
    dPrev = d; hPrev = h;
    d += st;
    h = gFetchH( im, p0 + dirP * d, dpx, dpy, rnd, tile );
  }
  // where the ray crosses the surface between the last two samples
  float fp = 1.0 - hPrev - dPrev, fc = 1.0 - h - d;
  float dh = mix( dPrev, d, clamp( fp / max( fp - fc, 1e-4 ), 0.0, 1.0 ) );
  // up towards the sun from there: a sample above the ray shades it, less the further out it is
  vec3 L = hfSunDir;
  float ln = max( dot( L, N ), 0.05 );
  vec2 sunW = L.xz / ln * D, sunP = vec2( dot( sunW, a ), dot( sunW, b ) );
  vec2 ph = p0 + dirP * dh;
  float hh = 1.0 - dh, occ = 0.0;
  for ( int k = 1; k <= 5; k ++ ) {
    float r = ( 1.0 - hh ) * float( k ) * 0.2;
    float hs = gFetchH( im, ph + sunP * r, dpx, dpy, rnd, tile );
    occ = max( occ, ( hs - hh - r - 0.04 ) * ( 1.0 - float( k ) * 0.12 ) );
  }
  sh = 1.0 - clamp( occ * 6.0, 0.0, 1.0 ) * fade * 0.8;
  return dirW * dh;
}
#endif

// what the open desert looks like at a point: shared by the terrain and the track's berm
// N = world normal, tD = metres from the track edge
void gDesertWeights( vec2 xz, vec3 N, float tD, vec4 mac, vec4 mac2, out float w[ ${NL} ] ) {
  float slope = 1.0 - N.y;
  vec2 sd = N.xz / max( length( N.xz ), 1e-4 );
  float lee = dot( sd, gWind ) * smoothstep( 0.02, 0.16, slope );
  float near = 1.0 - smoothstep( 6.0, 38.0, tD );
  float n1 = texture2D( hfCloudTex, xz / 170.0 ).r, n2 = texture2D( hfCloudTex, xz / 53.0 + 0.31 ).r;
  float flat_ = smoothstep( 0.14, 0.03, slope );
  // the track corridor is cut lower than the dunes, so the macro map sees it as a basin: ignore that near it
  mac.b *= smoothstep( 30.0, 110.0, tD );
  for ( int i = 0; i < ${NL}; i ++ ) w[ i ] = 0.0;
  // soft sand: slip faces, the sand tails behind rocks, dune crests and the jet-blown strip by the track
  w[ 1 ] = clamp( smoothstep( 0.05, 0.4, lee ) + mac2.r * 0.9 + smoothstep( 0.62, 0.85, mac.g ) * 0.35 + near * 0.75, 0.0, 1.0 );
  // gravel pavement: interdune flats, aprons around rocks, scoured ground upwind of them
  float gv = ( mac.b * flat_ * 1.25 + mac.a * 1.1 + mac2.g * 0.9 ) * ( 0.55 + 0.9 * n1 ) - 0.3;
  w[ 2 ] = clamp( gv, 0.0, 1.0 ) * ( 1.0 - near * 0.7 ) * ( 1.0 - mac2.r * 0.8 );
  // cracked clay in the lowest, flattest basins
  w[ 3 ] = smoothstep( 0.42, 0.92, mac.b * ( 0.6 + 0.8 * n2 ) ) * flat_ * ( 1.0 - near ) * ( 1.0 - mac2.r );
  // bare bedrock right at the rocks
  w[ 5 ] = smoothstep( 0.45, 0.85, mac2.b * ( 0.65 + 0.7 * n2 ) );
  float other = w[ 1 ] + w[ 2 ] + w[ 3 ] + w[ 5 ];
  w[ 0 ] = max( 1.0 - other, 0.0 ) + 0.03;
  float s = 0.0;
  for ( int i = 0; i < ${NL}; i ++ ) s += w[ i ];
  for ( int i = 0; i < ${NL}; i ++ ) w[ i ] /= s;
}

// large-scale colour: lighter crests, darker redder basins, slow hue drift, wind streaks
vec3 gDesertTint( vec2 xz, vec4 mac ) {
  float m1 = texture2D( hfCloudTex, xz / 1700.0 ).r, m2 = texture2D( hfCloudTex, xz / 260.0 + 0.5 ).r;
  vec3 t = vec3( 1.0 );
  t *= 0.9 + 0.2 * m1;
  t *= 0.96 + 0.08 * m2;
  t *= 1.0 + ( mac.g - 0.5 ) * 0.16;
  t *= mix( vec3( 1.0 ), vec3( 0.9, 0.84, 0.8 ), mac.b * 0.6 );
  t = mix( t, t * vec3( 1.06, 0.98, 0.9 ), smoothstep( 0.4, 0.7, m1 ) * 0.5 );
  vec2 wp = vec2( dot( xz, gWind ), dot( xz, vec2( - gWind.y, gWind.x ) ) );
  float st = texture2D( hfCloudTex, vec2( wp.x * 0.0021 - hfTime * 0.006, wp.y * 0.017 ) ).r;
  st *= texture2D( hfCloudTex, vec2( wp.x * 0.0009 - hfTime * 0.0025, wp.y * 0.004 ) + 0.3 ).r;
  t *= 1.0 + smoothstep( 0.32, 0.5, st ) * 0.1;
  return t;
}
`;

// world-space geometric normal before normal_fragment_begin runs
const GEO_N = /* glsl */`
#ifdef FLAT_SHADED
  vec3 hfGN = normalize( cross( dFdx( vHfWorld ), dFdy( vHfWorld ) ) );
#else
  vec3 hfGN = normalize( ( vec4( normalize( vNormal ), 0.0 ) * viewMatrix ).xyz ) * ( gl_FrontFacing ? 1.0 : -1.0 );
#endif
`;

// normal from the blended surface (nd = world-xz tangent offset), fades with distance
const NORMAL = /* glsl */`
{
  vec2 nd = gS.nd * gNK;
  vec3 d3 = vec3( nd.x, 0.0, nd.y );
  d3 -= hfGN * dot( d3, hfGN );
  gNW = normalize( hfGN * sqrt( max( 1.0 - dot( nd, nd ), 0.04 ) ) + d3 );
  normal = normalize( ( viewMatrix * vec4( gNW, 0.0 ) ).xyz );
}
`;

// sun glitter on sand grains and a broad grazing sheen on the dunes (cf. Journey)
const GLINT = /* glsl */`
#if GQ > 1
{
  vec3 V = normalize( cameraPosition - vHfWorld ), L = hfSunDir, Hh = normalize( L + V );
  float camD = length( vHfWorld - cameraPosition );
  vec4 r1 = texture2D( gGlint, vHfWorld.xz / 5.6 );
  vec4 r2 = texture2D( gGlint, mat2( 0.8, -0.6, 0.6, 0.8 ) * vHfWorld.xz / 2.3 + 0.37 );
  vec3 g1 = normalize( gNW + ( r1.xyz - 0.5 ) * 1.1 ), g2 = normalize( gNW + ( r2.xyz - 0.5 ) * 1.1 );
  float sp = pow( max( dot( g1, Hh ), 0.0 ), 260.0 ) * smoothstep( 0.86, 0.93, r1.w )
           + pow( max( dot( g2, Hh ), 0.0 ), 260.0 ) * smoothstep( 0.88, 0.95, r2.w ) * ( 1.0 - smoothstep( 8.0, 30.0, camD ) );
  sp *= 1.0 - smoothstep( 25.0, 90.0, camD );
  // rim only where the dune turns away from the camera towards the sun, fading out with distance
  float rim = pow( 1.0 - saturate( dot( gNW, V ) ), 6.0 ) * saturate( dot( gNW, L ) ) * ( 1.0 - smoothstep( 60.0, 400.0, camD ) );
  float sheen = pow( saturate( dot( gNW, Hh ) ), 12.0 ) * saturate( dot( gNW, L ) );
  reflectedLight.directSpecular += gSun * gS.sand * ( sp * 9.0 + rim * 0.06 * vec3( 1.0, 0.86, 0.68 ) + sheen * 0.05 );
}
#endif
`;

// occlusion on the indirect light only (texture cavities + large-scale macro occlusion)
const AO = /* glsl */`
{
  float ambientOcclusion = gAO;
  reflectedLight.indirectDiffuse *= ambientOcclusion;
  #ifdef HF_GI
    // the baked light (?gfx=gi:1, gfx/gi.js): sky visibility and bounce, over the open desert's
    vec3 gGI = hfGI( vHfWorld, gNW );
    #ifdef GI_HUE
      // (rockMaterial giHue: the bake's colour, but mostly the surface's own, sharper occlusion for how bright. Less
      // saturated: deep in the shade the bake is nearly all red bounce, and without its darkness that read as a dark
      // red glow where the shade should be near black. Where the bake is near nothing its colour is noise: bounded)
      gGI = max( gGI, vec3( 0.0 ) );
      float gGIL = max( dot( gGI, vec3( 0.2126, 0.7152, 0.0722 ) ), 0.02 );
      gGI = mix( vec3( 1.0 ), min( gGI / gGIL, vec3( 3.0 ) ), 1.0 - 0.7 * GI_HUE ) * pow( gGIL, 1.0 - GI_HUE );
    #endif
    reflectedLight.indirectDiffuse *= gGI;
    ambientOcclusion *= min( dot( gGI, vec3( 0.2126, 0.7152, 0.0722 ) ), 1.0 );
  #endif
  #if defined( USE_ENVMAP ) && defined( STANDARD )
    float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
    reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );
  #endif
}
#ifdef GDEBUG
{
  // debug views (__homok.groundDebug(n)): 1 albedo, 2 roughness, 3 occlusion, 4 world normal, 5 direct only, 6 indirect only, 7 specular only
  vec3 dbg = GDEBUG == 1 ? diffuseColor.rgb : GDEBUG == 2 ? vec3( material.roughness ) : GDEBUG == 3 ? vec3( gAO ) : GDEBUG == 4 ? gNW * 0.5 + 0.5
    : GDEBUG == 5 ? reflectedLight.directDiffuse : GDEBUG == 6 ? reflectedLight.indirectDiffuse : GDEBUG == 7 ? reflectedLight.directSpecular + reflectedLight.indirectSpecular
    : GDEBUG < 20 ? texture( gC, vec3( vHfWorld.xz / 5.0, float( GDEBUG - 10 ) ) ).rgb : texture( gN, vec3( vHfWorld.xz / 5.0, float( GDEBUG - 20 ) ) ).rgb;
  reflectedLight.directDiffuse = vec3( 0.0 ); reflectedLight.directSpecular = vec3( 0.0 ); reflectedLight.indirectSpecular = vec3( 0.0 );
  reflectedLight.indirectDiffuse = dbg;
}
#endif
`;

function lightsBegin(pom = false) {
  const src = THREE.ShaderChunk.lights_fragment_begin;
  const mark = 'directLight.color *= hfSunVis( vHfWorld, geometryNormal );';
  // (pom: the relief's own shadow, gParallax)
  return src.includes(mark) ? src.replace(mark, mark + (pom ? '\n\t\tdirectLight.color *= gPomSh;' : '') + '\n\t\tgSun += directLight.color;') : src;
}

export const GROUND_MATS = [];
// switch every ground / rock material to a debug view (0 = off)
export function groundDebug(n) {
  for (const m of GROUND_MATS) { if (n) m.defines.GDEBUG = n; else delete m.defines.GDEBUG; m.needsUpdate = true; }
}

function patch(material, key, defines, uniforms, frag, vert) {
  material.onBeforeCompile = (sh) => {
    atmoUniforms(sh);
    Object.assign(sh.uniforms, GU, uniforms);
    if (vert) vert(sh);
    // after fog_pars_fragment: the helpers use the atmosphere uniforms (hfCloudTex, hfTime...)
    let f = sh.fragmentShader.replace('#include <fog_pars_fragment>', '#include <fog_pars_fragment>\n' + PARS + (frag.pars || ''));
    for (const [chunk, code] of Object.entries(frag.chunks)) f = f.replace(`#include <${chunk}>`, code);
    sh.fragmentShader = f;
  };
  material.defines = Object.assign(material.defines || {}, defines);
  material.customProgramCacheKey = () => key + JSON.stringify(material.defines);
  GROUND_MATS.push(material);
  material.userData.uniforms = uniforms;
  return material;
}

const LIGHT_CHUNKS = (extra = '', pom = false) => ({
  lights_fragment_begin: 'vec3 gSun = vec3( 0.0 );\n' + lightsBegin(pom),
  lights_fragment_end: '#include <lights_fragment_end>\n' + GLINT + extra,
  aomap_fragment: AO,
});

// ---------------------------------------------------------------------------
//  Terrain (dunes). aTrackD = metres from the track edge (vertex attribute)
// ---------------------------------------------------------------------------
export function terrainMaterial(Q) {
  if (GPU) return N.terrainNodeMaterial(Q);
  const m = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 });
  const pom = !!Q.pom && (Q.groundQ ?? 2) > 1;
  return patch(m, 'hf-terrain2', pom ? { GQ: Q.groundQ ?? 2, HF_POM: 1 } : { GQ: Q.groundQ ?? 2 }, {}, {
    pars: /* glsl */`varying float vTrackD;`,
    chunks: {
      map_fragment: GEO_N + /* glsl */`
        vec2 xz = vHfWorld.xz;
        float camD = length( vHfWorld - cameraPosition );
        vec4 mac = gMacro( xz ), mac2 = gMacro2( xz );
        float w[ ${NL} ];
        gDesertWeights( xz, hfGN, vTrackD, mac, mac2, w );
        float rnd = texture2D( hfCloudTex, xz / 61.0 ).r;
        vec2 gOff = vec2( 0.0 );
        float gPomSh = 1.0;
        #ifdef HF_POM
          vec2 gdx = dFdx( xz ), gdy = dFdy( xz );
          gOff = gParallax( w, xz, rnd, vec2( 1.0, 0.0 ), vec2( 0.0, 1.0 ), xz, 1.0, hfGN, gdx, gdy, gdx, gdy, gPomSh );
        #endif
        GSurf gS = gBlend( w, xz, gOff, rnd, vec2( 1.0, 0.0 ), vec2( 0.0, 1.0 ), xz, 1.0 );
        diffuseColor.rgb = gS.alb * gDesertTint( xz, mac );
        // larger wind ripples where the texture's own have blurred away (from ~30 m): the ripple layer
        // again at 7x the size, broken up by noise so its repeat does not show
        {
          vec2 dxzM = dFdx( xz ), dyzM = dFdy( xz );
          float midK = smoothstep( 25.0, 110.0, camD ) * ( 1.0 - smoothstep( 500.0, 1400.0, camD ) ) * ( w[ 0 ] + w[ 1 ] * 0.6 ) * ( 0.35 + rnd );
          if ( midK > 0.01 ) {
            vec2 b = gAxis[ 0 ], a = vec2( - b.y, b.x );
            float inv = 1.0 / ( gTile[ 0 ] * 7.0 );
            vec2 p = vec2( dot( xz, a ), dot( xz, b ) ) * inv + rnd * 0.37;
            vec2 gx = vec2( dot( dxzM, a ), dot( dxzM, b ) ) * inv, gy = vec2( dot( dyzM, a ), dot( dyzM, b ) ) * inv;
            vec4 mc = textureGrad( gC, vec3( p, 0.0 ), gx, gy ), mn = textureGrad( gN, vec3( p, 0.0 ), gx, gy );
            vec2 t = mn.xy * 2.0 - 1.0;
            gS.nd += ( t.x * a + t.y * b ) * midK;
            diffuseColor.rgb *= 1.0 + ( mc.a - 0.5 ) * 0.18 * midK;
          }
        }
        float gAO = mix( 1.0, gS.ao, 0.85 ) * mac.r;
        diffuseColor.rgb *= mix( 1.0, gS.ao, 0.35 );
        float gNK = 1.25 * ( 1.0 - smoothstep( 120.0, 1100.0, camD ) * 0.7 );
        vec3 gNW = hfGN;`,
      roughnessmap_fragment: /* glsl */`float roughnessFactor = clamp( gS.rough, 0.3, 1.0 );`,
      normal_fragment_maps: NORMAL,
      ...LIGHT_CHUNKS('', pom),
    },
  }, (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aTrackD;\nvarying float vTrackD;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTrackD = aTrackD;');
  });
}

// ---------------------------------------------------------------------------
//  Track: packed sand down the middle, the dark polished racing line with jet scorch,
//  loose sand creeping in from the edges, a sand berm outside the edge that turns into
//  the open desert, bedrock showing through in the canyon, paving in the arena, and the
//  dynamic trail map (pods' scorch / grooves).
//  aTr = (lateral metres, arc length metres, racing line lateral metres, half width)
//  aDir = track direction (x, z), aZone = (arena, canyon)
// ---------------------------------------------------------------------------
// roof: the tunnel's slabs as arc-length ranges [a, b] (D7; at most 3): the floor under them sees almost no sky
// drift: the stretches where sand streams across the track (E1; at most 4): fresh tongues of sand lie on the road,
// long along the wind
export function trackMaterial(Q, trackLength, roof = [], drift = []) {
  const reps = Math.max(1, Math.round(trackLength / TILE[4]));
  const R = [0, 1, 2].map((k) => new THREE.Vector2(...(roof[k] || [-1e6, -1e6])));
  const D = [0, 1, 2, 3].map((k) => new THREE.Vector2(...(drift[k] || [-1e6, -1e6])));
  const u = { kL: U(trackLength), kTile: U(trackLength / reps), kTrail: T(null), kTrailOn: U(0), kRoof0: U(R[0]), kRoof1: U(R[1]), kRoof2: U(R[2]),
    kDrift0: U(D[0]), kDrift1: U(D[1]), kDrift2: U(D[2]), kDrift3: U(D[3]) };
  if (GPU) return N.trackNodeMaterial(Q, trackLength, u, drift.length > 0);
  const m = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2 });
  const pom = !!Q.pom && (Q.groundQ ?? 2) > 1;
  // (GI_HUE: in the canyon the baked light gives only its colour, see below)
  const defs = { GQ: Q.groundQ ?? 2, GI_HUE: 'gGIHue', ...(pom ? { HF_POM: 1 } : {}), ...(drift.length ? { HF_DRIFT: 1 } : {}) };
  return patch(m, 'hf-track2', defs, u, {
    pars: /* glsl */`uniform sampler2D kTrail; uniform float kL, kTile, kTrailOn; uniform vec2 kRoof0, kRoof1, kRoof2, kDrift0, kDrift1, kDrift2, kDrift3; varying vec4 vTr; varying vec2 vDir, vZone;
      float kRoofK( vec2 r, float s ) { return smoothstep( r.x - 4.0, r.x + 4.0, s ) * ( 1.0 - smoothstep( r.y - 4.0, r.y + 4.0, s ) ); }
      float kDriftK( vec2 r, float s ) { return smoothstep( r.x - 30.0, r.x + 20.0, s ) * ( 1.0 - smoothstep( r.y - 20.0, r.y + 30.0, s ) ); }`,
    chunks: {
      map_fragment: GEO_N + /* glsl */`
        vec2 xz = vHfWorld.xz;
        float d = vTr.x, s = vTr.y, hw = vTr.w, e = abs( d ) - hw;
        float arena = vZone.x, canyon = vZone.y;
        float camD = length( vHfWorld - cameraPosition );
        vec4 mac = gMacro( xz ), mac2 = gMacro2( xz );
        vec2 fwd = normalize( vDir ), lat = vec2( - fwd.y, fwd.x );
        float n1 = texture2D( hfCloudTex, vec2( d, s ) / vec2( 23.0, 61.0 ) ).r;
        float n2 = texture2D( hfCloudTex, vec2( d, s ) / vec2( 9.0, 140.0 ) + 0.4 ).r;
        float n3 = texture2D( hfCloudTex, vec2( d, s ) / vec2( 31.0, 90.0 ) + 0.7 ).r;
        // loose sand creeping in from the edges and lying in patches
        float edge = abs( d ) / hw;
        float drift = smoothstep( 0.74, 1.0, edge + ( n1 - 0.5 ) * 0.5 );
        drift = max( drift, smoothstep( 0.63, 0.76, n2 ) * smoothstep( 0.3, 0.8, edge ) * 0.85 );
        #ifdef HF_DRIFT
        {
          // where sand streams across the track (E1): fresh tongues blown over the road, long along the wind
          float dk = max( max( kDriftK( kDrift0, s ), kDriftK( kDrift1, s ) ), max( kDriftK( kDrift2, s ), kDriftK( kDrift3, s ) ) );
          vec2 W = gWind;
          float wa = dot( xz, W ), wc = xz.y * W.x - xz.x * W.y;
          float tn = texture2D( hfCloudTex, vec2( wa / 120.0, wc / 18.0 ) ).r * 0.7 + texture2D( hfCloudTex, vec2( wa / 40.0, wc / 6.0 ) + 0.5 ).r * 0.3;
          drift = max( drift, dk * smoothstep( 0.56, 0.7, tn ) * 0.9 );
        }
        #endif
        drift *= 1.0 - arena * 0.9;
        float w[ ${NL} ];
        float tw[ ${NL} ];
        gDesertWeights( xz, vec3( 0.0, 1.0, 0.0 ), max( e, 0.0 ), mac, mac2, tw );
        for ( int i = 0; i < ${NL}; i ++ ) w[ i ] = 0.0;
        float bed = 1.0 - drift;
        float rockPatch = canyon * smoothstep( 0.52, 0.68, n3 );
        w[ 4 ] = bed * ( 1.0 - arena ) * ( 1.0 - rockPatch );
        w[ 5 ] = bed * ( 1.0 - arena ) * rockPatch;
        w[ 6 ] = bed * arena;
        w[ 1 ] = drift * 0.8;
        w[ 0 ] = drift * 0.2 * smoothstep( 0.2, 0.7, n1 );
        // outside the edge: the berm of pushed-up sand, then the open desert
        float out_ = smoothstep( 0.0, 1.2, e );
        float far_ = smoothstep( 2.5, 6.5, e - ( n3 - 0.5 ) * 3.5 );         // the berm's width wanders
        for ( int i = 0; i < ${NL}; i ++ ) {
          float berm = i == 1 ? 0.85 : i == 2 ? 0.15 * smoothstep( 0.45, 0.7, n2 ) : 0.0;
          w[ i ] = mix( w[ i ], mix( berm, tw[ i ], far_ ), out_ );
        }
        float ws = 0.0;
        for ( int i = 0; i < ${NL}; i ++ ) ws += w[ i ];
        for ( int i = 0; i < ${NL}; i ++ ) w[ i ] /= max( ws, 1e-4 );
        float rnd = texture2D( hfCloudTex, xz / 61.0 ).r;
        vec2 gOff = vec2( 0.0 );
        float gPomSh = 1.0;
        #ifdef HF_POM
          gOff = gParallax( w, xz, rnd, lat, fwd, vec2( d, s ), kTile, hfGN, dFdx( xz ), dFdy( xz ), dFdx( vec2( d, s ) ), dFdy( vec2( d, s ) ), gPomSh );
        #endif
        GSurf gS = gBlend( w, xz, gOff, rnd, lat, fwd, vec2( d, s ), kTile );
        vec3 col = gS.alb;
        // the racing line: packed hard, darker, with jet scorch
        float ld = ( d - vTr.z ) / 5.5;
        float onBed = ( 1.0 - drift ) * ( 1.0 - out_ );
        float groove = exp( - ld * ld ) * onBed * ( 1.0 - arena * 0.6 );
        float scorch = smoothstep( 0.55, 0.78, texture2D( hfCloudTex, vec2( d / 6.0, s / 55.0 ) + 0.7 ).r ) * groove;
        vec4 trail = kTrailOn > 0.5 ? min( texture2D( kTrail, vec2( d / ( hw * 2.6 ) + 0.5, s / kL ) ), vec4( 1.0 ) ) : vec4( 0.0 );
        col *= 1.0 - groove * 0.14 - scorch * 0.32;
        col *= 1.0 - trail.r * 0.3;
        col = mix( col, vec3( 0.14, 0.11, 0.09 ), trail.g * 0.4 );
        // marks left by earlier races: oil stains (dark, glossy) and scorch blasts (sooty, with a
        // paler burnt ring), one per hashed cell at most, irregular through the noise
        float oil = 0.0, burn = 0.0;
        {
          vec2 cellSz = vec2( 9.0, 13.0 ), q = vec2( d, s ) / cellSz, ci = floor( q );
          for ( int oy = -1; oy <= 1; oy ++ ) for ( int ox = -1; ox <= 1; ox ++ ) {
            vec2 c = ci + vec2( ox, oy );
            vec4 h = gHash4( c );
            if ( h.w > 0.12 ) continue;
            vec2 rel = vec2( d, s ) - ( c + 0.2 + h.xy * 0.6 ) * cellSz;
            float an = ( h.z - 0.5 ) * 0.5, ca = cos( an ), sa = sin( an );          // streaks along the track
            rel = mat2( ca, -sa, sa, ca ) * rel;
            float sz = mix( 1.1, 3.2, fract( h.z * 7.31 ) );
            rel /= sz * vec2( 0.8, mix( 2.5, 7.0, fract( h.x * 13.1 ) ) );
            float nn = texture2D( hfCloudTex, rel * 0.3 + h.xy * 7.0 ).r * 0.65 + texture2D( hfCloudTex, rel * 1.1 + h.yx * 3.0 ).r * 0.35;
            float r = length( rel ) + ( nn - 0.5 ) * 1.5;
            float m = smoothstep( 1.0, 0.55, r ) * ( 0.55 + 0.45 * smoothstep( 0.3, 0.7, nn ) );
            if ( fract( h.w * 9.7 ) < 0.55 ) oil = max( oil, m );
            else burn = max( burn, m + smoothstep( 1.25, 1.0, r ) * smoothstep( 0.8, 1.0, r ) * -0.6 );
          }
          float keep = ( 1.0 - drift ) * ( 1.0 - out_ ) * ( 1.0 - arena * 0.6 );
          oil *= keep; burn *= keep;
        }
        col *= 1.0 - oil * 0.35;
        col = mix( col, vec3( 0.075, 0.06, 0.05 ), clamp( burn, 0.0, 1.0 ) * 0.45 );
        col *= 1.0 + clamp( -burn, 0.0, 1.0 ) * 0.25;
        // packed sand is darker where it meets the loose edge (shadowed lip)
        col *= 1.0 - smoothstep( 0.9, 1.0, edge ) * ( 1.0 - smoothstep( 1.0, 1.15, edge ) ) * 0.15;
        diffuseColor.rgb = col * mix( vec3( 1.0 ), gDesertTint( xz, mac ), mix( 0.45, 1.0, out_ ) );
        float gAO = mix( 1.0, gS.ao, 0.85 ) * mix( 1.0, mac.r, out_ );
        // down in the canyon the floor sees only a strip of sky, less still by the walls
        // (hfShade, D2: deeper, as the floor of a real slot sees ~10-25 % of the sky)
        // and under the tunnel's roof (D7), the slabs as arc-length ranges with a sharp edge to each
        float gRoof = max( kRoofK( kRoof0, s ), max( kRoofK( kRoof1, s ), kRoofK( kRoof2, s ) ) );
        float gOcc = ( 1.0 - canyon * ( mix( 0.35, 0.62, hfShade ) + mix( 0.25, 0.2, hfShade ) * smoothstep( 0.55, 1.0, edge ) ) )
          * ( 1.0 - 0.8 * gRoof );
        #ifndef HF_GI
          gAO *= gOcc;
        #else
          // with the baked light, in the canyon: its colour (the warm bounce), but this for how bright (GI_HUE in AO).
          // Its 6 m cells blur the slabs' shade and the 10-12 m sunlit gaps between them into one dark run
          float gGIHue = 0.85 * canyon;
          gAO *= pow( max( gOcc, 1e-4 ), gGIHue );
        #endif
        diffuseColor.rgb *= mix( 1.0, gS.ao, 0.35 );
        float polish = groove * 0.2 + trail.r * 0.1 + oil * 0.42;
        float gNK = ( 1.0 - smoothstep( 80.0, 600.0, camD ) * 0.7 ) * ( 1.0 - groove * 0.4 );
        vec3 gNW = hfGN;`,
      roughnessmap_fragment: /* glsl */`float roughnessFactor = clamp( gS.rough - polish, 0.25, 1.0 );`,
      normal_fragment_maps: NORMAL,
      ...LIGHT_CHUNKS('', pom),
    },
  }, (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aTr;\nattribute vec2 aDir, aZone;\nvarying vec4 vTr;\nvarying vec2 vDir, vZone;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTr = aTr; vDir = aDir; vZone = aZone;');
  });
}

// ---------------------------------------------------------------------------
//  Rock (triplanar). Vertex colours (strata) or the material colour set the hue, the texture
//  adds the detail. Sand settles on ledges that face up and drifts against the foot of the
//  rock (needs the macro height map); cliffs get desert varnish streaks.
// ---------------------------------------------------------------------------
export function rockMaterial(Q, layer, { scale = 1 / 10, chroma = 0.5, contrast = 1, normal = 1, rough = [0.55, 0.6], vertexColors = true, color = '#ffffff',
  macro = 0.3, side = THREE.FrontSide, flat = false, sand = 1, foot = 2.5, varnish = 0, ao = false, aoAlbedo = 0.45, aoGI = 1, arena = false, metalness = 0,
  fade = null, giHue = 0 } = {}) {
  const u = {
    // arena: the building texture set, used for its own colour (not relative to its mean)
    gRC: arena ? GU.gAC : GU.gRC, gRN: arena ? GU.gAN : GU.gRN,
    rLayer: U(layer), rScale: U(scale), rChroma: U(chroma), rContrast: U(contrast),
    rNormal: U(normal), rRough: U(new THREE.Vector2(...rough)), rMacro: U(macro),
    rSand: U(sand), rFoot: U(foot), rVarnish: U(varnish), rAOAlb: U(aoAlbedo),
    // with the baked light (gi): how much of the geometry's own occlusion (aAO) to keep (the canyon's is
    // analytic sky visibility, which the bake replaces; the rocks' Blender AO is finer than the bake)
    rAOgi: U(aoGI),
    // fade: { far, depth }: copies of a culled scatter field (world/scatter.js) rise out of the ground over the last
    // ~28 % of its draw distance instead of popping in (sunk by depth metres at far)
    rFadeFar: U(fade?.far ?? 1e6), rFadeDepth: U(fade?.depth ?? 0),
  };
  // giHue (0..1, with the baked light): how much of the brightness of the indirect light comes from the geometry's own
  // occlusion (aAO, as without the bake) rather than the bake, which then gives only its colour. The canyon walls: the
  // bake's 6 m cells blur the tunnel slabs' shade and the gaps between them, which aAO has sharp
  if (GPU) return N.rockNodeMaterial(Q, { color, roughness: 1, metalness, side, flatShading: flat }, u, { vertexColors, ao, arena, fade: !!fade, giHue });
  const m = new THREE.MeshStandardMaterial({ vertexColors, color, roughness: 1, metalness, side, flatShading: flat });
  const defs = { GQ: Q.groundQ ?? 2 };
  if (giHue > 0) defs.GI_HUE = giHue.toFixed(3);
  if (ao) defs.ROCK_AO = 1;          // the geometry carries the occlusion baked in Blender (aAO)
  if (arena) defs.ABSOLUTE = 1;
  if (fade) defs.HF_FADE = 1;        // (also keeps the program apart in three's cache: the vertex shader differs)
  return patch(m, 'hf-rock2', defs, u, {
    pars: /* glsl */`uniform highp sampler2DArray gRC, gRN; uniform float rLayer, rScale, rChroma, rContrast, rNormal, rMacro, rSand, rFoot, rVarnish, rAOAlb, rAOgi; uniform vec2 rRough;
      #ifdef ROCK_AO
        varying float vRockAO;
      #endif
      vec3 hfUnpackN( vec4 t, float k ) { vec2 xy = ( t.rg * 2.0 - 1.0 ) * k; return vec3( xy, sqrt( max( 1.0 - dot( xy, xy ), 0.0 ) ) ); }`,
    chunks: {
      map_fragment: GEO_N + /* glsl */`
        vec3 tpP = vHfWorld * rScale;
        vec3 tpW = pow( abs( hfGN ), vec3( 4.0 ) ); tpW /= tpW.x + tpW.y + tpW.z;
        vec4 tpCx = texture( gRC, vec3( tpP.zy, rLayer ) ), tpCy = texture( gRC, vec3( tpP.xz, rLayer ) ), tpCz = texture( gRC, vec3( tpP.xy, rLayer ) );
        vec4 tpNx = texture( gRN, vec3( tpP.zy, rLayer ) ), tpNy = texture( gRN, vec3( tpP.xz, rLayer ) ), tpNz = texture( gRN, vec3( tpP.xy, rLayer ) );
        vec3 tpAlb = tpCx.rgb * tpW.x + tpCy.rgb * tpW.y + tpCz.rgb * tpW.z;
        float tpH = tpCx.a * tpW.x + tpCy.a * tpW.y + tpCz.a * tpW.z;
        float tpR = tpNx.b * tpW.x + tpNy.b * tpW.y + tpNz.b * tpW.z;
        float tpAO = tpNx.a * tpW.x + tpNy.a * tpW.y + tpNz.a * tpW.z;
        float tpMac = texture2D( hfCloudTex, vHfWorld.xz / 1300.0 ).r;
        #ifdef ABSOLUTE
          vec3 tpMean = vec3( 1.0 );
        #else
          vec3 tpMean = textureLod( gRC, vec3( 0.5, 0.5, rLayer ), 16.0 ).rgb;
        #endif
        vec3 tpRel = tpAlb / max( tpMean, vec3( 0.03 ) );
        tpRel = max( mix( vec3( gLum( tpRel ) ), tpRel, rChroma ), 0.0 );
        tpRel = pow( tpRel, vec3( rContrast ) );
        diffuseColor.rgb *= tpRel * ( 1.0 - rMacro * 0.5 + rMacro * tpMac );
        // desert varnish: dark streaks running down steep faces
        float steep = 1.0 - smoothstep( 0.35, 0.7, abs( hfGN.y ) );
        float vk = texture2D( hfCloudTex, vec2( dot( vHfWorld.xz, vec2( 0.71, 0.7 ) ) / 23.0, vHfWorld.y / 900.0 ) ).r;
        float varn = smoothstep( 0.55, 0.78, vk ) * steep * rVarnish;
        diffuseColor.rgb *= 1.0 - varn * 0.45;
        // sand on the ledges and around the foot
        vec4 macH = gMacXf.w > 0.5 ? texture2D( gMacH, gMacUv( vHfWorld.xz ) ) : vec4( -1e4 );
        float sn = texture2D( hfCloudTex, vHfWorld.xz / 9.0 + vHfWorld.y / 31.0 ).r;
        float sandUp = smoothstep( 0.6, 0.86, hfGN.y + ( sn - 0.5 ) * 0.35 + ( 0.5 - tpH ) * 0.3 );
        float sandFoot = smoothstep( rFoot, rFoot * 0.15, vHfWorld.y - macH.r + ( sn - 0.5 ) * rFoot * 0.8 + tpH * 0.6 );
        float sandK = max( sandUp, sandFoot ) * rSand;
        vec2 sb = gAxis[ 1 ], sa = vec2( - sb.y, sb.x );
        vec2 suv = vec2( dot( vHfWorld.xz, sa ), dot( vHfWorld.xz, sb ) ) / gTile[ 1 ];
        vec4 sC = texture( gC, vec3( suv, 1.0 ) ), sN = texture( gN, vec3( suv, 1.0 ) );
        // no anti-tiling here: fade the sand's detail to its average before the repeat shows
        float sFar = smoothstep( 35.0, 160.0, length( vHfWorld - cameraPosition ) );
        sC = mix( sC, textureLod( gC, vec3( 0.5, 0.5, 1.0 ), 16.0 ), sFar );
        sN = mix( sN, vec4( 0.5, 0.5, sN.b, sN.a ), sFar );
        vec3 sandCol = sC.rgb * gDesertTint( vHfWorld.xz, gMacro( vHfWorld.xz ) );
        diffuseColor.rgb = mix( diffuseColor.rgb, sandCol, sandK );
        float gAO = mix( mix( 1.0, tpAO, 0.9 ), sN.a, sandK );
        diffuseColor.rgb *= mix( 1.0, tpAO, 0.3 * ( 1.0 - sandK ) );
        #ifdef ROCK_AO
          #if defined( HF_GI ) && defined( GI_HUE )
            gAO *= pow( max( vRockAO, 0.0 ), mix( rAOgi, 1.0 + 0.7 * hfShade, float( GI_HUE ) ) );
          #elif defined( HF_GI )
            gAO *= pow( max( vRockAO, 0.0 ), rAOgi );          // (the baked light has the large-scale part)
          #else
            // (max: with MSAA an edge pixel extrapolates the attribute, and pow of a negative is NaN)
            gAO *= pow( max( vRockAO, 0.0 ), 1.0 + 0.7 * hfShade );
          #endif
          diffuseColor.rgb *= mix( 1.0, vRockAO, rAOAlb );        // deep cavities stay dark in sunlight too (aoAlbedo)
        #endif
        vec3 gNW = hfGN;`,
      roughnessmap_fragment: /* glsl */`float roughnessFactor = clamp( mix( rRough.x + rRough.y * tpR - varn * 0.15, sN.b, sandK ), 0.04, 1.0 );`,
      normal_fragment_maps: /* glsl */`
        {
          vec3 wn = hfGN;
          float fade = rNormal * ( 1.0 - smoothstep( 120.0, 700.0, length( vHfWorld - cameraPosition ) ) * 0.7 );
          vec3 tX = hfUnpackN( tpNx, fade ), tY = hfUnpackN( tpNy, fade ), tZ = hfUnpackN( tpNz, fade );
          tX = vec3( tX.xy + wn.zy, abs( tX.z ) * wn.x );
          tY = vec3( tY.xy + wn.xz, abs( tY.z ) * wn.y );
          tZ = vec3( tZ.xy + wn.xy, abs( tZ.z ) * wn.z );
          vec3 nRock = normalize( tX.zyx * tpW.x + tY.xzy * tpW.y + tZ.xyz * tpW.z );
          vec2 t = ( sN.xy * 2.0 - 1.0 );
          vec2 nd = t.x * sa + t.y * sb;
          vec3 nSand = normalize( vec3( nd.x, 1.0, nd.y ) );
          gNW = normalize( mix( nRock, normalize( mix( wn, nSand, 0.6 ) ), sandK ) );
          normal = normalize( ( viewMatrix * vec4( gNW, 0.0 ) ).xyz );
        }`,
      lights_fragment_begin: 'vec3 gSun = vec3( 0.0 );\n' + lightsBegin(),
      aomap_fragment: AO,
    },
  }, ao || fade ? (sh) => {
    if (ao) sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aAO;\nvarying float vRockAO;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRockAO = aAO;');
    if (fade) sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float rFadeFar, rFadeDepth;')
      .replace('#include <begin_vertex>', /* glsl */`#include <begin_vertex>
        #ifdef USE_INSTANCING
        {
          float f = 1.0 - smoothstep( rFadeFar * 0.72, rFadeFar, distance( ( modelMatrix * instanceMatrix[ 3 ] ).xyz, cameraPosition ) );
          transformed.y -= ( 1.0 - f ) * rFadeDepth / max( length( instanceMatrix[ 1 ].xyz ), 1e-3 );
        }
        #endif`);
  } : null);
}
