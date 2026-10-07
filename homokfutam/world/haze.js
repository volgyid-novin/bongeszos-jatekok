import * as THREE from 'three';
import { ATMO, ATMO_FUNCS } from '../gfx/atmosphere.js';
import { GPU, U, N } from '../gfx/backend.js';

// ============================================================
//  Dust hanging in the canyon and under the arch. Thin sheets across the track, drifting noise,
//  lit only where the baked sun shadow says the light gets through, so the sunlit parts read as
//  shafts. Brighter looking towards the sun (forward scattering), faded when seen edge-on or up close.
// ============================================================
const VERT = /* glsl */`
  varying vec3 vHfWorld;
  varying vec2 vUv;
  varying vec3 vN;
  void main() {
    vUv = uv;
    vec4 w = modelMatrix * vec4( position, 1.0 );
    vHfWorld = w.xyz;
    vN = normalize( mat3( modelMatrix ) * normal );
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;
const FRAG = /* glsl */`
  ${ATMO_FUNCS}
  uniform float uK;
  varying vec2 vUv;
  varying vec3 vN;
  void main() {
    vec3 d = vHfWorld - cameraPosition;
    float dist = length( d );
    vec3 V = d / dist;
    float n = texture2D( hfCloudTex, vUv * vec2( 2.2, 1.1 ) + vec2( hfTime * 0.012, hfTime * 0.004 ) ).r;
    n *= texture2D( hfCloudTex, vUv * vec2( 5.0, 2.7 ) - vec2( hfTime * 0.02, 0.0 ) + 0.37 ).r * 1.6;
    float shape = smoothstep( 0.0, 0.12, vUv.x ) * smoothstep( 1.0, 0.88, vUv.x ) * smoothstep( 0.0, 0.06, vUv.y ) * pow( 1.0 - vUv.y, 1.6 );
    float fade = smoothstep( 0.12, 0.45, abs( dot( V, vN ) ) ) * smoothstep( 6.0, 30.0, dist );
    float lit = hfStaticShadow( vHfWorld, vec3( 0.0, 1.0, 0.0 ) );
    float phase = 0.35 + 2.2 * pow( max( dot( V, hfSunDir ), 0.0 ), 5.0 );
    vec3 col = mix( hfFogCol * 0.55, hfSunCol * 1.5, lit ) * phase;
    float a = n * shape * fade * uK * ( 0.25 + 0.75 * lit );
    gl_FragColor = vec4( col, clamp( a, 0.0, 0.5 ) );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

export function buildHaze({ scene, TR, rangeWhere, arch, Q }) {
  const k0 = 0.16 * (Q.particles ?? 1), uK = U(k0);
  const mat = GPU ? N.hazeMaterial({ uK }) : new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true,
    uniforms: Object.assign({}, ATMO, { uK }),
  });
  const geos = [];
  const sheet = (x, y, z, yaw, w, h) => {
    const g = new THREE.PlaneGeometry(w, h, 1, 1);
    g.translate(0, h / 2, 0);
    g.rotateY(yaw);                 // the sheet faces along the track
    g.translate(x, y, z);
    geos.push(g);
  };
  const r = rangeWhere(TR.canyon, 0.6);
  if (r) for (let k = r[0]; k <= r[1]; k += 11) {
    const i = TR.idx(k);
    sheet(TR.px[i], TR.py[i] - 1, TR.pz[i], TR.yaw[i], 2 * (TR.hw[i] + 8), TR.wallH[i] * 0.85);
  }
  if (arch) for (const o of [-24, -10, 4, 18]) {
    const i = TR.idx(arch.i + Math.round(o / 4));
    sheet(TR.px[i], TR.py[i] - 1, TR.pz[i], TR.yaw[i], 64, 44);
  }
  if (!geos.length) return null;
  const merged = new THREE.BufferGeometry();
  const pos = [], uv = [], nrm = [], index = [];
  for (const g of geos) {
    const base = pos.length / 3;
    pos.push(...g.attributes.position.array);
    uv.push(...g.attributes.uv.array);
    nrm.push(...g.attributes.normal.array);
    for (const v of g.index.array) index.push(base + v);
  }
  merged.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  merged.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  merged.setIndex(index);
  const m = new THREE.Mesh(merged, mat);
  m.userData.noBake = true;
  m.userData.dynamic = true;
  m.userData.uK = uK; m.userData.k0 = k0;        // (main.js fades them where the volumetric light takes over)
  m.renderOrder = 2;
  scene.add(m);
  return m;
}
