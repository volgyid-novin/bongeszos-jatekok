import * as THREE from 'three';
import { GPU, U, TSL } from './backend.js';
import { pickQuality } from './quality.js';

// ============================================================
//  Baked ray-traced light (?gfx=gi:1, docs/visual-next-steps.md D4): sky visibility and one bounce
//  off the sunlit rock and sand, in volumes over the canyon and the arch (baked by gfx/gibake.js
//  into assets/world/gi.bin). Every ground / rock material multiplies its indirect light by
//  hfGI(world position, world normal): E(n) / E_open(n), the light the point gets from its
//  surroundings over what open, flat desert gets. 1 outside the volumes.
//
//  gi.bin: 'HFGI', u32 header length, header JSON, then the RGBA8 atlas (x = across, three
//  colour channels side by side; y = up; z = along, the volumes one after another). A texel:
//  r = log2 of a / a_open over [-8, 2], gba = b / 2a in [-1, 1] (gfx/gibake.js).
// ============================================================
export const GI_VERSION = 1;
export const GI_ON = !!pickQuality().gi;
const MAX = 4;

const placeholder = () => {
  const t = new THREE.Data3DTexture(new Uint8Array([204, 128, 128, 128]), 1, 1, 1);
  t.needsUpdate = true;
  return t;
};
const v4 = () => new THREE.Vector4();
// the volumes' uniforms: per volume O = (corner, atlas z0), A = (along x, along z, cells per metre along,
// cells per metre up), S = (cells per metre across, cells along, up, across); S.y = 0 marks an unused slot
export const GIU = {
  hfGIOn: U(0),
  hfGIK: U(1),                                  // strength (0 = off, 1 = as baked)
  hfGITex: GPU ? TSL.texture3D(placeholder()) : { value: placeholder() },
  hfGIDim: U(new THREE.Vector4(1, 3, 1, 1)),   // (cells across per channel block, atlas width, height, depth)
  hfGIRef0: U(new THREE.Vector3()), hfGIRef1: U(new THREE.Vector3()), hfGIRef2: U(new THREE.Vector3()),   // b_open / a_open per channel
  O: Array.from({ length: MAX }, () => U(v4())), A: Array.from({ length: MAX }, () => U(v4())), S: Array.from({ length: MAX }, () => U(v4())),
};
// for the GLSL materials (Object.assign into shader.uniforms): the arrays as array uniforms
export const GI_UNIFORMS = GPU ? {} : {
  hfGIOn: GIU.hfGIOn, hfGIK: GIU.hfGIK, hfGITex: GIU.hfGITex, hfGIDim: GIU.hfGIDim, hfGIRef0: GIU.hfGIRef0, hfGIRef1: GIU.hfGIRef1, hfGIRef2: GIU.hfGIRef2,
  hfGIO: { value: GIU.O.map((u) => u.value) }, hfGIA: { value: GIU.A.map((u) => u.value) }, hfGIS: { value: GIU.S.map((u) => u.value) },
};

export const GI_FUNCS = /* glsl */`
#define HF_GI 1
uniform highp sampler3D hfGITex;
uniform vec4 hfGIO[ ${MAX} ], hfGIA[ ${MAX} ], hfGIS[ ${MAX} ], hfGIDim;
uniform vec3 hfGIRef0, hfGIRef1, hfGIRef2;
uniform float hfGIOn, hfGIK;
// the baked light at world position wp for world normal n, over the open desert's (RGB)
vec3 hfGI( vec3 wp, vec3 n ) {
  if ( hfGIOn < 0.5 ) return vec3( 1.0 );
  vec3 sum = vec3( 0.0 );
  float ws = 0.0;
  for ( int b = 0; b < ${MAX}; b ++ ) {
    vec4 O = hfGIO[ b ], A = hfGIA[ b ], S = hfGIS[ b ];
    if ( S.y < 0.5 ) continue;
    // a cell and a half out along the normal: off the surface, into the air the bake saw
    vec3 d = wp + n * 1.5 - O.xyz;
    vec3 c = vec3( dot( d.xz, A.xy ) * A.z, d.y * A.w, dot( d.xz, vec2( - A.y, A.x ) ) * S.x );
    vec3 e = min( c, S.yzw - c );
    float w = clamp( min( e.x, min( e.y, e.z ) ), 0.0, 1.0 );
    if ( w <= 0.0 ) continue;
    c = clamp( c, vec3( 0.5 ), S.yzw - 0.5 );
    vec3 T;
    for ( int ch = 0; ch < 3; ch ++ ) {
      vec4 t = textureLod( hfGITex, vec3( c.z + float( ch ) * hfGIDim.x, c.y, c.x + O.w ) / hfGIDim.yzw, 0.0 );
      vec3 ref = ch == 0 ? hfGIRef0 : ch == 1 ? hfGIRef1 : hfGIRef2;
      float E = exp2( t.x * 10.0 - 8.0 ) * max( 1.0 + 2.0 * dot( t.yzw * 2.0 - 1.0, n ), 0.03 );
      T[ ch ] = E / max( 1.0 + dot( ref, n ), 0.03 );
    }
    sum += T * w;
    ws += w;
  }
  vec3 T = ws > 0.0 ? sum / ws : vec3( 1.0 );
  return mix( vec3( 1.0 ), min( T, vec3( 4.0 ) ), min( ws, 1.0 ) * hfGIK );
}
`;

// fetch and install assets/world/gi.bin; resolves to the header, or null (no file, wrong version)
export async function loadGI(sunDir) {
  if (!GI_ON) return null;
  try {
    const r = await fetch(new URL('../assets/world/gi.bin', import.meta.url).href);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = await r.arrayBuffer();
    const dv = new DataView(buf);
    if (dv.getUint32(0, false) !== 0x48464749) throw new Error('not a gi.bin');
    const len = dv.getUint32(4, true);
    const h = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, len)));
    if (h.version !== GI_VERSION) throw new Error(`version ${h.version}, want ${GI_VERSION}`);
    const [W, H, D] = h.atlas;
    const tex = new THREE.Data3DTexture(new Uint8Array(buf, 8 + len, W * H * D * 4), W, H, D);
    tex.format = THREE.RGBAFormat; tex.type = THREE.UnsignedByteType;
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;
    GIU.hfGITex.value = tex;
    GIU.hfGIDim.value.set(h.maxC, W, H, D);
    [GIU.hfGIRef0, GIU.hfGIRef1, GIU.hfGIRef2].forEach((u, c) => u.value.fromArray(h.ref.b[c].map((b) => b / h.ref.a[c])));
    h.boxes.slice(0, MAX).forEach((b, i) => {
      GIU.O[i].value.set(b.o[0], b.o[1], b.o[2], b.z0);
      GIU.A[i].value.set(b.ux, b.uz, b.n[0] / b.size[0], b.n[1] / b.size[1]);
      GIU.S[i].value.set(b.n[2] / b.size[2], b.n[0], b.n[1], b.n[2]);
    });
    GIU.hfGIOn.value = 1;
    const sd = h.sun[0] * sunDir.x + h.sun[1] * sunDir.y + h.sun[2] * sunDir.z;
    if (sd < 0.999) console.warn('HOMOKFUTAM: gi.bin was baked for another sun; the bounce light will be off (rebake: ?bakegi)');
    console.log(`HOMOKFUTAM: baked light: ${h.boxes.length} volumes, ${W}x${H}x${D}`);
    return h;
  } catch (e) {
    console.warn('HOMOKFUTAM: baked light (gi.bin) not loaded:', e.message);
    return null;
  }
}
