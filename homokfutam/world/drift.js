import * as THREE from 'three';
import { ATMO } from '../gfx/atmosphere.js';
import { WIND_DIR } from '../gfx/ground.js';
import { GUST_GLSL, WAKE_ON, WAKE, WAKE_GLSL } from '../gfx/wind.js';
import { GPU, U, N } from '../gfx/backend.js';

// ============================================================
//  Sand streaming across the track (?gfx=drift:1, docs/visual-next-steps.md E1). On a few stretches
//  where the wind crosses the open track with dunes upwind (picked in main.js, DRIFT), low sheets of sand
//  flow across the road downwind in braided, snaking ribbons: thin and fast most of the time; when a gust
//  front comes through (gfx/wind.js) they swell and merge into a sheet that hazes the road for a second or
//  two. The road there carries fresh tongues of sand (trackMaterial), and in a gust sand puffs up where the
//  stream pours over the berm (main.js, updateWind).
//
//  One strip mesh per stretch, each culled on its own: draped a little over the ground (the road, the berms
//  and ~28 m beyond either edge), transparent after the opaque pass. Everything that moves is in the shader,
//  on the shader clock: two layers of fine streaks racing along the wind (the grains, 9 and 13 m/s), under
//  a slow, warped mask (the ribbons, their front lobed) and the gust field (the sheets). Lit by the scene's
//  palette (the dust's colour as fill, the sun through the world shadow, brighter looking into the sun; a fixed
//  orange read far too saturated without the post chain on LOW) and fogged. A passing pod (?gfx=wake:1, E7)
//  blows a lane through it.
// ============================================================
const SAND = { alb: '#eadcc4', amb: 0.55, sun: 1.0 };      // the grains' albedo; how much of the fill and the sun

// Across a stretch: metres past the track's edge on the outside (on the berm's own break lines, so the sheet
// follows its ridge: main.js BERM_OUT), and fractions of the half-width over the road
const OUT_E = [28, 24, 20, 16.5, 13, 10, 7, 4.5, 2.6, 1.2, 0];
const IN_N = 12;
const COLS = [...OUT_E.map((e) => [-1, e]), ...Array.from({ length: IN_N - 1 }, (_, k) => [-1 + 2 * (k + 1) / IN_N, null]), ...OUT_E.slice().reverse().map((e) => [1, e])];

// ranges: [[a, b], ...] arc lengths; trackPoint(s, d, out); surfaceAt(i, s, d, x, z): the drawn surface (road,
// berm, terrain); layers: 1 (Low) or 2
export function buildDrift({ scene, TR, trackPoint, surfaceAt, ranges, layers = 2 }) {
  if (!ranges.length) return null;
  const tp = { x: 0, y: 0, z: 0, yaw: 0, i: 0 };
  const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const NC = COLS.length;
  // one mesh per stretch (they are far apart: each is culled on its own)
  const geos = ranges.map(([a, b]) => {
    const pos = [], fade = [], index = [];
    const s0 = a - 30, s1 = b + 30, rows = Math.ceil((s1 - s0) / 2);
    for (let r = 0; r <= rows; r++) {
      const s = ((s0 + (s1 - s0) * r / rows) % TR.L + TR.L) % TR.L, sr = s0 + (s1 - s0) * r / rows;
      trackPoint(s, 0, tp);
      const hw = TR.hw[tp.i];
      const end = smooth(a - 30, a + 20, sr) * (1 - smooth(b - 20, b + 30, sr));
      for (let c = 0; c < NC; c++) {
        const [k, e] = COLS[c], d = e === null ? k * hw : k * (hw + e);
        // trackPoint's lateral axis: d > 0 to the right of the direction of travel
        const x = tp.x - Math.cos(tp.yaw) * d, z = tp.z + Math.sin(tp.yaw) * d;
        pos.push(x, surfaceAt(tp.i, s, d, x, z) + 0.12, z);
        fade.push(end, e === null ? 1 : 1 - smooth(16, 28, e));
        if (r < rows && c < NC - 1) {
          const i = r * NC + c;
          index.push(i, i + 1, i + NC, i + 1, i + NC + 1, i + NC);        // (as the track mesh: facing up)
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aF', new THREE.Float32BufferAttribute(fade, 2));
    g.setIndex(index);
    g.computeBoundingSphere();
    return g;
  });
  const C = (h) => new THREE.Color(h);
  const u = { uAlb: U(C(SAND.alb)), uAmb: U(SAND.amb), uSun: U(SAND.sun), uK: U(1) };
  const params = { transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 };
  const mat = GPU ? N.driftMaterial(u, params, layers, WAKE_ON) : new THREE.ShaderMaterial({
    ...params, fog: true,
    uniforms: Object.assign({}, THREE.UniformsUtils.clone(THREE.UniformsLib.fog), ATMO, u, WAKE_ON ? WAKE : {}),
    vertexShader: /* glsl */`
      attribute vec2 aF;
      varying vec2 vF;
      varying vec3 vW;
      #include <fog_pars_vertex>
      void main() {
        vF = aF;
        vec4 wp = modelMatrix * vec4( position, 1.0 );
        vW = wp.xyz;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uAlb;
      uniform float uAmb, uSun;
      uniform float uK;
      varying vec2 vF;
      varying vec3 vW;
      #include <common>
      #include <fog_pars_fragment>
      ${GUST_GLSL}
      ${WAKE_ON ? WAKE_GLSL : ''}
      void main() {
        const vec2 W = vec2( ${WIND_DIR.x}, ${WIND_DIR.y} );
        vec2 xz = vW.xz;
        float a = dot( xz, W ), c = xz.y * W.x - xz.x * W.y, t = hfTime;
        // billows: the gust's sheet comes in lumps travelling with it, and its leading edge is lobed (fingers of
        // sand), not the field's straight front
        float bil = texture2D( hfCloudTex, vec2( ( a - t * 12.0 ) / 240.0, c / 90.0 ) ).r;
        float g = hfGust( xz + W * ( bil - 0.5 ) * 40.0, t );
        // the ribbons: braided, snaking, drifting slowly downwind
        float warp = texture2D( hfCloudTex, vec2( a / 260.0 - t * 0.004, c / 120.0 ) ).r;
        float rib = texture2D( hfCloudTex, vec2( ( a - t * 3.5 ) / 220.0, ( c + warp * 22.0 ) / 34.0 ) ).r;
        float ribbons = smoothstep( 0.42, 0.62, rib );
        // the grains: fine streaks racing along the wind
        float n = texture2D( hfCloudTex, vec2( ( a - t * 13.0 ) / 22.0, c / 1.1 ) ).r;
        ${layers > 1 ? 'n = n * 0.55 + texture2D( hfCloudTex, vec2( ( a - t * 9.0 ) / 14.0, c / 0.7 ) + 0.37 ).r * 0.45;' : ''}
        float grains = smoothstep( 0.38, 0.75, n );
        // a gust: the ribbons swell and merge into a lumpy sheet that hazes the road
        float sheet = smoothstep( 0.2, 0.85, g ) * smoothstep( 0.25, 0.65, bil + 0.25 * g );
        float cover = mix( ribbons, 1.0, sheet * 0.6 );
        vec3 V = vW - cameraPosition;
        float dist = length( V );
        V /= max( dist, 1e-4 );
        float alpha = cover * ( mix( 0.15, 0.3, sheet ) + mix( 0.45, 0.35, sheet ) * grains ) * ( 0.6 + 0.4 * g ) * vF.x * vF.y * uK;
        // a longer path through the layer at grazing angles; nothing in the last metres before the lens
        alpha *= ( 0.7 + 0.8 * ( 1.0 - abs( V.y ) ) ) * smoothstep( 1.5, 6.0, dist );
        ${WAKE_ON ? '// a passing pod (E7) parts the stream: its jets blow a lane clear behind it, filling back in\n        alpha *= 1.0 - 0.7 * clamp( hfWake( vW, 4 ).z, 0.0, 1.0 );' : ''}
        float fs = pow( max( dot( V, hfSunDir ), 0.0 ), 4.0 );
        float vis = hfStaticShadow( vW + vec3( 0.0, 0.3, 0.0 ), vec3( 0.0, 1.0, 0.0 ) );
        // (the grains in the air catch the sun: a little lighter than the sand they leave)
        gl_FragColor = vec4( uAlb * ( hfFogCol * uAmb + hfSunCol * uSun * vis * ( 0.8 + 0.9 * fs ) ) * 1.15, clamp( alpha, 0.0, 0.85 ) );
        #include <fog_fragment>
      }`,
  });
  const meshes = geos.map((g) => {
    const mesh = new THREE.Mesh(g, mat);
    mesh.renderOrder = 1;
    mesh.userData.noBake = true;
    scene.add(mesh);
    return mesh;
  });
  return { meshes, uniforms: u };
}
