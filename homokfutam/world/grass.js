import * as THREE from 'three';
import { ATMO } from '../gfx/atmosphere.js';
import { WIND_DIR } from '../gfx/ground.js';
import { GUST_ON, GUST_GLSL, WAKE_ON, WAKE, WAKE_GLSL, WAKE_N } from '../gfx/wind.js';
import { GPU, U, N } from '../gfx/backend.js';

// ============================================================
//  Dry grass tufts by the track (?gfx=grass:1, docs/visual-next-steps.md C8): a few dozen thin curved
//  blades per tuft, real geometry rather than alpha-tested cards (no overdraw, nothing for the
//  anti-aliasing to shimmer on), straw coloured, swaying in the wind with the tips moving most.
//  The copies are only moved and scaled (unevenly), never turned or mirrored, so the shader can take
//  the wind in world space; one tuft shape, so a chunk of them is one draw. They cast no shadow.
// ============================================================
const TAU = Math.PI * 2;

// one tuft: blades fanning out from a small clump, curved over by their own weight
export function tuftGeometry(seed, blades = 30) {
  let s = seed * 9301 + 49297;
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  const pos = [], nrm = [], col = [], index = [];
  const SEG = 3;
  const base = new THREE.Color(), tip = new THREE.Color();
  for (let b = 0; b < blades; b++) {
    const a = rnd() * TAU, r = Math.sqrt(rnd()) * 0.12;
    const bx = Math.cos(a) * r, bz = Math.sin(a) * r;
    const h = 0.25 + rnd() * 0.45, w = 0.018 + rnd() * 0.014;
    // leans outwards (more for the outer ones) and droops at the tip
    const lean = 0.15 + rnd() * 0.45 + r * 3, la = a + (rnd() - 0.5) * 0.8;
    const lx = Math.cos(la), lz = Math.sin(la);
    // across the blade: roughly facing the clump's centre so it catches light from both sides
    const cx = -lz, cz = lx;
    base.setRGB(0.3 + rnd() * 0.06, 0.25 + rnd() * 0.05, 0.16);
    tip.setRGB(0.72 + rnd() * 0.1, 0.6 + rnd() * 0.08, 0.38 + rnd() * 0.06);
    if (rnd() < 0.25) tip.multiplyScalar(0.8);           // a few greyer, older blades
    const v0 = pos.length / 3;
    for (let k = 0; k <= SEG; k++) {
      const t = k / SEG, y = h * t * (1 - 0.18 * lean * t);
      const out = h * lean * t * t;
      const px = bx + lx * out, pz = bz + lz * out, hw = w * (1 - t * 0.92) * 0.5;
      pos.push(px - cx * hw, y, pz - cz * hw, px + cx * hw, y, pz + cz * hw);
      // soft, mostly upward normals: thin blades scatter light, they do not show a dark back face
      const nx = lx * 0.35, nz = lz * 0.35, ny = 1, l = Math.hypot(nx, ny, nz);
      nrm.push(nx / l, ny / l, nz / l, nx / l, ny / l, nz / l);
      const c = base.clone().lerp(tip, Math.pow(t, 0.7));
      col.push(c.r, c.g, c.b, c.r, c.g, c.b);
      if (k < SEG) { const i = v0 + k * 2; index.push(i, i + 1, i + 2, i + 1, i + 3, i + 2); }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(index);
  g.computeBoundingSphere();
  return g;
}

// Tufts in static chunks along the track (CHUNK metres of it each, one instanced mesh): the matrices go up
// once, and a chunk is shown while the camera is within dist of it (three's frustum test
// does the rest). A per-tuft distance test, as the rock fields do, would re-sort and re-upload tens of
// thousands of matrices as the camera moves (~2 ms of CPU a frame on WebGPU).
// tufts: { s (arc length of the track beside it), x, y, z, m (Matrix4) }; returns { update(cam) }
// A chunk switches on whole, so the tufts themselves grow in: each shrinks to nothing towards its root over the
// last third of dist (by its own distance), and is gone before its chunk can switch off (a tuft within dist of the
// camera is always in a chunk that is shown). iRoot: each copy's root, for the node material (WebGL reads the
// instance matrix).
const CHUNK = 130;
export function buildGrass(scene, tufts, trackLength, dist) {
  const shapes = [tuftGeometry(2, 34)], mat = grassMaterial(dist);
  const n = Math.ceil(trackLength / CHUNK), cells = Array.from({ length: n }, () => [[]]);
  for (const t of tufts) cells[Math.min(n - 1, Math.floor(t.s / CHUNK))][0].push(t);
  const chunks = [];
  for (const cell of cells) {
    const meshes = [], c = new THREE.Vector3();
    let cnt = 0;
    cell.forEach((list, g) => {
      if (!list.length) return;
      const geo = shapes[g].clone();
      geo.setAttribute('iRoot', new THREE.InstancedBufferAttribute(new Float32Array(list.flatMap((t) => [t.x, t.y, t.z])), 3));
      const im = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((t, k) => { im.setMatrixAt(k, t.m); c.x += t.x; c.y += t.y; c.z += t.z; cnt++; });
      im.computeBoundingSphere();
      im.receiveShadow = true;
      im.userData.noBake = true;
      im.userData.scatter = true;
      im.name = 'grass';
      im.visible = false;
      scene.add(im);
      meshes.push(im);
    });
    if (!meshes.length) continue;
    c.divideScalar(cnt);
    let r = 0;
    for (const m of meshes) r = Math.max(r, m.boundingSphere.center.distanceTo(c) + m.boundingSphere.radius);
    chunks.push({ meshes, c, r });
  }
  return {
    chunks,
    update(cam) {
      for (const k of chunks) {
        const on = k.c.distanceTo(cam) - k.r < dist;
        if (k.meshes[0].visible !== on) for (const m of k.meshes) m.visible = on;
      }
    },
  };
}

// sway: the tips move along the wind (gusts travelling with it) and a little across it. With the one wind
// (?gfx=gust:1, E2) the gust field bows them: a front crossing a field of grass is a visible wave, and
// between fronts only a slow breath and a little flutter are left.
// far: the distance the grass is drawn to (the tufts grow in over its last third, see buildGrass)
export function grassMaterial(far = 75) {
  const u = { uTime: ATMO.hfTime, uWind: U(new THREE.Vector2(WIND_DIR.x, WIND_DIR.y)), uAmp: U(0.11), uFar: U(far) };
  const params = { vertexColors: true, roughness: 0.92, metalness: 0, side: THREE.DoubleSide };
  if (GPU) return N.grassNodeMaterial(params, { ...u, gust: GUST_ON, wake: WAKE_ON });
  const m = new THREE.MeshStandardMaterial(params);
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, ATMO, u, WAKE_ON ? WAKE : {});
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime, uAmp, uFar;\nuniform vec2 uWind;\n' + (GUST_ON ? GUST_GLSL : '') + (WAKE_ON ? WAKE_GLSL : ''))
      .replace('#include <begin_vertex>', /* glsl */`#include <begin_vertex>
        {
          vec2 wp = vec2( 0.0 );
          #ifdef USE_INSTANCING
            wp = instanceMatrix[3].xz;
            // grows in towards the edge of the grass's distance (shrinks to nothing at its root)
            transformed *= 1.0 - smoothstep( uFar * 0.62, uFar * 0.96, distance( ( modelMatrix * instanceMatrix[ 3 ] ).xyz, cameraPosition ) );
          #endif
          float k = transformed.y * transformed.y * 2.0;        // tips sway, roots stay
          ${GUST_ON ? /* glsl */`
          float g = hfGust( wp, uTime );
          float gust = clamp( 0.2 + 0.12 * sin( uTime * 1.6 + dot( wp, uWind ) * 0.11 ) + g * 1.6, 0.0, 2.0 );
          float flick = sin( uTime * 7.3 + wp.x * 1.7 + wp.y * 2.3 + transformed.x * 9.0 ) * 0.25 * ( 0.4 + g );
          vec2 d = uWind * ( 0.35 + gust ) + vec2( - uWind.y, uWind.x ) * flick;
          transformed.xz += d * uAmp * k;
          transformed.y -= uAmp * k * gust * 0.25;` : /* glsl */`
          float gust = sin( dot( wp, uWind ) * 0.06 - uTime * 1.9 ) * 0.5 + 0.5;
          float flick = sin( uTime * 7.3 + wp.x * 1.7 + wp.y * 2.3 + transformed.x * 9.0 ) * 0.25;
          vec2 d = uWind * ( 0.35 + gust ) + vec2( - uWind.y, uWind.x ) * flick;
          transformed.xz += d * uAmp * k;
          transformed.y -= uAmp * k * gust * 0.15;`}
          ${WAKE_ON ? /* glsl */`
          // a passing pod (E7): flattened by the jets behind it, whipping back and forth as it springs up
          #ifdef USE_INSTANCING
          vec3 wk = hfWake( vec3( wp.x, instanceMatrix[ 3 ].y, wp.y ), ${WAKE_N} );
          transformed.xz += wk.xy * 0.42 * k;
          transformed.y -= length( wk.xy ) * 0.12 * k;
          #endif` : ''}
        }`);
  };
  m.customProgramCacheKey = () => 'grass' + (GUST_ON ? '-gust' : '') + (WAKE_ON ? '-wake' : '');
  return m;
}
