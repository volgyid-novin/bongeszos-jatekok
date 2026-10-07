import * as THREE from 'three';
import { ATMO } from '../gfx/atmosphere.js';
import { GUST_GLSL, GUST_ON, WIND_DIR } from '../gfx/wind.js';
import { GPU, U, N } from '../gfx/backend.js';

// ============================================================
//  Sand pouring from the rock (?gfx=trickle:1, docs/visual-next-steps.md E3). The canyon, the tunnel and the
//  arch were perfectly still; a few fine falls of sand from the rim, the tunnel's lips, cracks in its ceiling,
//  the arch and the stone bridge catch the sun against the dark rock and make the places feel old and
//  fragile. Each widens and breaks into clumps as it falls and lands in a small puff; a pod passing under
//  one shakes loose a heavier pour for a couple of seconds, with a few pebbles.
//
//  Each fall is two or three strands, each a strip along a curved path (the arc of a pour leaving the lip, a
//  slow wander in the air, the gust) turned about its own tangent towards the camera; one instanced mesh per
//  cluster of falls. On the shader clock the streaks and the clumps fall at free-fall speed (laid out in the
//  time a grain takes to fall that far). Lit like the canyon's hanging dust: the sun where the world shadow
//  lets it through, strongly forward scattered, so a fall lit from behind glows.
// ============================================================

// ------------------------------------------------------------
//  Placement. ctx: { TR, trackPoint, groundQuery, rng, walls (main.js CANYON_WALLS: the walls' profiles),
//  roofAt, tunnel (the slabs' arc-length ranges), slabs (their meshes), overheads: [{ mesh, s, reach }] (the
//  arch, the bridge) }. Returns [{ top, bot, w0, w1, k }].
// ------------------------------------------------------------
export function placeFalls(ctx) {
  const { TR, trackPoint, groundQuery, rng, walls, roofAt, tunnel, slabs, overheads } = ctx;
  const rand = rng(7781), falls = [];
  const tp = { x: 0, y: 0, z: 0, yaw: 0, i: 0 };
  const rc = new THREE.Raycaster(), UP = new THREE.Vector3(0, 1, 0), O = new THREE.Vector3();
  const up = (meshes, x, y, z) => {        // the underside of the rock over x, z (from y up), or null
    rc.set(O.set(x, y, z), UP); rc.far = 120;
    let best = null;
    // (a LOD: only its finest level)
    for (const m of meshes) for (const h of rc.intersectObject(m.isLOD ? m.levels[0].object : m, false)) if (!best || h.distance < best.distance) best = h;
    return best;
  };
  const at = (s, d) => { trackPoint(((s % TR.L) + TR.L) % TR.L, d, tp); return tp; };
  // out: the horizontal way the sand leaves the rock (unit, x z), u0: how fast (m/s): the pour arcs out from the lip
  const add = (top, bot, w0, w1, k, out, u0) => { if (top.y - bot.y > 3) falls.push({ top, bot, w0, w1, k, out, u0 }); };
  // off an overhang: nothing in the way, so it lands where the arc takes it (u0 times the time to fall)
  const pour = (top, w0, w1, k, out, u0) => {
    const t = Math.sqrt(2 * Math.max(top.y - groundQuery(top.x, top.z), 1) / 9.8), x = top.x + out.x * u0 * t, z = top.z + out.y * u0 * t;
    add(top, new THREE.Vector3(x, groundQuery(x, z), z), w0, w1, k, out, u0);
  };
  const along = (p, dir) => new THREE.Vector2(Math.sin(p.yaw) * dir, Math.cos(p.yaw) * dir);
  // an overhang's edge: from s0 (under the rock, lateral d) step along the track in dir until the rock overhead runs
  // out, then bisect; the last point still under it, or null
  const edge = (meshes, s0, dir, d, run) => {
    let p = at(s0, d), h = up(meshes, p.x, p.y + 2, p.z);
    if (!h) return null;
    let sIn = s0, hIn = h, sOut = null;
    for (let k = 1; k * 2.5 <= run; k++) {
      const s = s0 + dir * k * 2.5;
      p = at(s, d); h = up(meshes, p.x, p.y + 2, p.z);
      if (h) { sIn = s; hIn = h; } else { sOut = s; break; }
    }
    if (sOut === null) return null;
    for (let it = 0; it < 4; it++) {
      const s = (sIn + sOut) / 2;
      p = at(s, d); h = up(meshes, p.x, p.y + 2, p.z);
      if (h) { sIn = s; hIn = h; } else sOut = s;
    }
    return { s: sIn, h: hIn };
  };

  // the canyon rim: off the lip of the top bed, hanging just clear of the face all the way down (the walls lean
  // back, so a fall slants with them), at least ~50 m apart, not where the tunnel roofs the slot
  for (const prof of walls) {
    const rows = prof.rows.filter((r) => r.c > 0.9 && roofAt(r.s) < 0.02 && r.n > r.J);
    const used = [];
    for (let tries = 0; tries < 160 && used.length < 8; tries++) {
      const R = rows[Math.floor(rand() * rows.length)];
      if (!R || used.some((s) => Math.abs(s - R.s) < 50)) continue;
      const J = R.J, clear = 1.4;
      let ot = Infinity;
      for (let j = J - 3; j <= J; j++) ot = Math.min(ot, R.o[j]);
      ot -= 1.0;
      const yt = R.y[J] + 0.4, yb = R.ty - 0.35;
      let ob = ot;
      for (let j = 1; j < J - 1; j++) {
        const f = (yt - yb) / Math.max(yt - R.y[j], 0.5);
        ob = Math.min(ob, ot + (R.o[j] - clear - ot) * f);
      }
      if (ob < R.hw - 3) continue;              // it would come down well out on the road
      used.push(R.s);
      const top = new THREE.Vector3(R.x + R.rx * ot, yt, R.z + R.rz * ot);
      const bx = R.x + R.rx * ob, bz = R.z + R.rz * ob;
      add(top, new THREE.Vector3(bx, groundQuery(bx, bz), bz), 0.25 + rand() * 0.35, 1.4 + rand() * 1.8, 0.55 + rand() * 0.45,
        new THREE.Vector2(-R.rx, -R.rz).normalize(), 0.6 + rand() * 0.8);
    }
  }

  // the tunnel: off its lips into the gaps and the ends (sunlit shafts), and a few thin ones from cracks in its
  // ceiling. A lip is found by stepping out along the track until the rock overhead runs out.
  if (slabs.length) {
    for (const [a, b] of tunnel) {
      // (the lips are ragged by up to ~5 m: start well inside)
      for (const [s0, dir] of [[a + 10, -1], [b - 10, 1]]) {
        for (let n = 0; n < 2; n++) {
          const d = (rand() * 2 - 1) * 13;
          const e = edge(slabs, s0, dir, d, 24);
          if (!e) continue;
          const p = at(e.s + dir * 0.4, d), y = e.h.point.y - 0.3;
          pour(new THREE.Vector3(p.x, y, p.z), 0.18 + rand() * 0.3, 1.0 + rand() * 1.4, 0.6 + rand() * 0.4, along(p, dir), 0.5 + rand() * 0.7);
        }
      }
      // a crack in the ceiling: thin, faint
      const s = a + (b - a) * (0.25 + rand() * 0.5), d = (rand() * 2 - 1) * 10, p = at(s, d);
      const h = up(slabs, p.x, p.y + 2, p.z);
      const ca = rand() * Math.PI * 2;
      if (h) pour(new THREE.Vector3(p.x, h.point.y - 0.2, p.z), 0.08 + rand() * 0.1, 0.6 + rand() * 0.5, 0.35 + rand() * 0.2, new THREE.Vector2(Math.cos(ca), Math.sin(ca)), 0.1 + rand() * 0.2);
    }
  }

  // under the arch and the bridge: off both edges of the span, over the track and beside it
  for (const { mesh, s: sm, reach = 40, n: want = 4 } of overheads) {
    if (!mesh) continue;
    let left = want;
    for (let k = 0; k < want * 2 && left > 0; k++) {
      const d = (rand() * 2 - 1) * (TR.hw[at(sm, 0).i] + 6), dir = k % 2 ? 1 : -1;
      const last = edge([mesh], sm, dir, d, reach / 2);
      if (!last) continue;
      left--;
      const p = at(last.s + dir * 0.4, d), y = last.h.point.y - 0.3;
      pour(new THREE.Vector3(p.x, y, p.z), 0.2 + rand() * 0.3, 1.1 + rand() * 1.4, 0.5 + rand() * 0.5, along(p, dir), 0.5 + rand() * 0.7);
    }
  }
  return falls;
}

// ------------------------------------------------------------
//  The ribbons: a strip per strand along a curved path. Instances: iTop = (top, width there), iBot = (where it
//  lands, width there), iK = (seed, strength, pour: 0..1 when a pod shakes it, the drop), iOut = (the way the sand
//  leaves the rock: x, z; how fast, m/s; how much it wanders).
//
//  The path, from the top (v = 0) to the landing (v = 1), on the shader clock:
//   - the arc of a pour: sand leaves the lip at iOut.z m/s outwards, so it curves out first and then drops (the
//     landing stays where it was placed: the straight line plus out * u0 * (tau - tau_end * v), tau the time a
//     grain takes to fall that far);
//   - a slow wander in the air, growing with the distance fallen, travelling down the stream with the sand;
//   - the gust swings the lower part downwind.
//  The strip turns about the path's own tangent towards the camera. Its width necks and swells as clumps fall
//  (a pattern travelling at the fall's speed), the edges are ragged and the streaks break into clumps low down.
// ------------------------------------------------------------
const SEG = 28;
const PATH_GLSL = /* glsl */`
vec3 fallPath( float v, float g ) {
  float len = iK.w, d = v * len;
  float tau = sqrt( 2.0 * d / 9.8 ), tauE = sqrt( 2.0 * len / 9.8 );
  vec3 P = mix( iTop.xyz, iBot.xyz, v );
  vec2 o = iOut.xy, q = vec2( - o.y, o.x );
  P.xz += o * iOut.z * ( tau - tauE * v );
  float s = iK.x;
  float m1 = sin( tau * 2.3 - uTime * 1.1 + s * 3.0 ) * 0.6 + sin( tau * 4.1 - uTime * 1.9 + s * 7.0 ) * 0.4;
  float m2 = sin( tau * 1.7 - uTime * 0.8 + s * 5.0 ) * 0.6 + sin( tau * 3.3 - uTime * 1.5 + s * 2.0 ) * 0.4;
  P.xz += ( q * m1 + o * m2 * 0.5 ) * iOut.w * d * 0.035 * smoothstep( 0.0, 0.15, v );
  P.xz += uWind * ( 0.25 + g ) * v * v * len * 0.02;
  return P;
}`;
const VERT = /* glsl */`
attribute vec4 iTop, iBot, iK, iOut;
uniform float uTime;
uniform vec2 uWind;
varying vec2 vUv;
varying vec3 vW;
varying vec4 vK;
varying float vThin, vTau;
#include <fog_pars_vertex>
${GUST_ON ? GUST_GLSL : ''}
${PATH_GLSL}
void main() {
  float v = position.y;                                  // 0 at the top, 1 where it lands
  ${GUST_ON ? 'float g = hfGust( iTop.xz, uTime );' : 'float g = 0.3;'}
  vec3 P = fallPath( v, g );
  vec3 T = fallPath( min( v + 0.02, 1.0 ), g ) - fallPath( max( v - 0.02, 0.0 ), g );
  vec3 toCam = cameraPosition - P;
  vec3 right = normalize( cross( normalize( T ), toCam ) + 1e-5 );
  float tau = sqrt( 2.0 * v * iK.w / 9.8 );
  // necking and swelling as clumps fall (a pattern travelling down at the fall's speed)
  float clump = 0.72 + 0.56 * ( 0.5 + 0.5 * sin( tau * 6.0 - uTime * 6.0 + iK.x * 13.0 ) ) * ( 0.5 + 0.5 * sin( tau * 2.6 - uTime * 2.6 + iK.x * 5.0 ) );
  float w = mix( iTop.w, iBot.w, pow( v, 0.8 ) ) * ( 1.0 + iK.z * 0.7 ) * mix( 1.0, clump, smoothstep( 0.05, 0.3, v ) );
  // no thinner than ~1.5 px (assuming ~1080 rows): far falls widen and fade instead of shimmering
  float px = length( toCam ) * 2.0 / ( projectionMatrix[ 1 ][ 1 ] * 1080.0 ) * 1.5;
  vThin = w / max( w, px );
  P += right * position.x * max( w, px );
  vUv = vec2( position.x, v ); vW = P; vK = iK; vTau = tau;
  vec4 mvPosition = viewMatrix * vec4( P, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const FRAG = /* glsl */`
uniform vec3 uAlb;
uniform float uTime;
varying vec2 vUv;
varying vec3 vW;
varying vec4 vK;
varying float vThin, vTau;
#include <common>
#include <fog_pars_fragment>
void main() {
  float seed = vK.x, k = vK.y, pour = vK.z;
  float v = vUv.y, x = vUv.x, tau = vTau;
  // laid out in the time a grain takes to fall this far, so the streaks speed up as they fall
  float n1 = texture2D( hfCloudTex, vec2( x * 0.35 + seed, tau * 0.9 - uTime * 0.9 ) ).r;
  float n2 = texture2D( hfCloudTex, vec2( x * 0.9 + seed * 1.7, tau * 2.3 - uTime * 2.3 ) ).r;
  float streak = smoothstep( 0.36 - 0.12 * pour, 0.7, n1 * 0.6 + n2 * 0.4 );
  // a dense thin core and a hazy edge, ragged (grains straying out of the stream); lower down it breaks into clumps
  float rag = texture2D( hfCloudTex, vec2( tau * 1.6 - uTime * 1.6 + seed, x * 0.25 + seed * 0.3 ) ).r - 0.5;
  float core = 1.0 - smoothstep( 0.05 + 0.25 * v, 0.45, abs( x ) + rag * ( 0.1 + 0.25 * v ) );
  float a = core * mix( 0.95, streak, 0.3 + 0.6 * v );
  a *= smoothstep( 0.0, 0.03, v ) * ( 1.0 - smoothstep( 0.72, 1.0, v ) );
  a *= k * ( 0.8 + 0.6 * pour ) * vThin;
  // the sun where the world shadow lets it through, strongly forward scattered; shade as the canyon's dust
  vec3 V = normalize( vW - cameraPosition );
  float lit = hfStaticShadow( vW, vec3( 0.0, 1.0, 0.0 ) );
  float phase = pow( max( dot( V, hfSunDir ), 0.0 ), 5.0 ) * 2.6 + 0.45;
  vec3 col = mix( hfFogCol * 0.5 * ( 1.0 - 0.55 * hfShade ), hfSunCol * 1.6, lit ) * phase * uAlb;
  // (a fall a few metres from the lens would smear across the frame: it fades out up close)
  a *= smoothstep( 3.0, 12.0, distance( vW, cameraPosition ) );
  gl_FragColor = vec4( col, clamp( a, 0.0, 0.95 ) );
  #include <fog_fragment>
}`;

// falls from placeFalls(); fx: { puff(x, y, z, k), pebble(x, y, z) } (main.js: the particle pools). Each fall is
// two or three strands (a main one and thinner ones beside it, some starting a little lower), so it reads as sand
// pouring rather than one sheet. The strands are split into clusters (the canyon and the bridge, the arch: far
// apart), one mesh each, culled on its own.
export function buildTrickle({ scene, falls, fx }) {
  if (!falls.length) return null;
  const u = { uTime: ATMO.hfTime, uWind: U(new THREE.Vector2(WIND_DIR.x, WIND_DIR.y)), uAlb: U(new THREE.Color('#f0d9b5')) };
  const params = { transparent: true, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true };
  const mat = GPU ? N.trickleMaterial(u, params, GUST_ON) : new THREE.ShaderMaterial({
    ...params, fog: true, vertexShader: VERT, fragmentShader: FRAG,
    uniforms: Object.assign({}, THREE.UniformsUtils.clone(THREE.UniformsLib.fog), ATMO, u),
  });
  const strip = [], index = [];
  for (let j = 0; j <= SEG; j++) { const v = j / SEG; strip.push(-0.5, v, 0, 0.5, v, 0); if (j < SEG) index.push(j * 2, j * 2 + 1, j * 2 + 2, j * 2 + 1, j * 2 + 3, j * 2 + 2); }
  // the strands
  const strands = [];
  for (const f of falls) {
    f.pour = 0; f.acc = Math.random(); f.cool = 0;
    const out = f.out || new THREE.Vector2(1, 0), side = new THREE.Vector2(-out.y, out.x);
    const n = f.w0 > 0.15 ? 2 + (Math.random() < 0.5 ? 1 : 0) : 1;
    for (let j = 0; j < n; j++) {
      if (j === 0) { strands.push({ f, top: f.top, bot: f.bot, w0: f.w0, w1: f.w1, k: f.k, u0: f.u0 ?? 0.5, wander: 0.8 + Math.random() * 0.5 }); continue; }
      // beside the main one (along the lip), thinner and fainter, some starting a little lower down the stream
      const off = (j === 1 ? 1 : -1) * (0.25 + Math.random() * 0.5), drop = Math.random() * 0.12;
      const top = f.top.clone().lerp(f.bot, drop), bot = f.bot.clone();
      top.x += side.x * off; top.z += side.y * off;
      bot.x += side.x * off * 1.6; bot.z += side.y * off * 1.6;
      strands.push({ f, top, bot, w0: f.w0 * (0.35 + Math.random() * 0.2), w1: f.w1 * (0.45 + Math.random() * 0.2), k: f.k * (0.45 + Math.random() * 0.25),
        u0: (f.u0 ?? 0.5) * (0.7 + Math.random() * 0.5), wander: 0.7 + Math.random() * 0.8 });
    }
  }
  const clusters = [];
  for (const st of strands) {
    let c = clusters.find((k) => k.c.distanceTo(st.bot) < 450);
    if (!c) clusters.push(c = { c: st.bot.clone(), strands: [] });
    c.strands.push(st);
    c.c.multiplyScalar(c.strands.length - 1).add(st.bot).divideScalar(c.strands.length);
  }
  for (const cl of clusters) {
    const n = cl.strands.length;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(strip, 3));
    g.setIndex(index);
    const top = new Float32Array(n * 4), bot = new Float32Array(n * 4), K = new Float32Array(n * 4), O = new Float32Array(n * 4);
    let r = 0;
    cl.strands.forEach((st, i) => {
      const o = st.f.out || new THREE.Vector2(1, 0);
      top.set([st.top.x, st.top.y, st.top.z, st.w0], i * 4);
      bot.set([st.bot.x, st.bot.y, st.bot.z, st.w1], i * 4);
      K.set([Math.random() * 10, st.k, 0, st.top.distanceTo(st.bot)], i * 4);
      O.set([o.x, o.y, st.u0, st.wander], i * 4);
      r = Math.max(r, cl.c.distanceTo(st.top), cl.c.distanceTo(st.bot));
    });
    g.setAttribute('iTop', new THREE.InstancedBufferAttribute(top, 4));
    g.setAttribute('iBot', new THREE.InstancedBufferAttribute(bot, 4));
    g.setAttribute('iOut', new THREE.InstancedBufferAttribute(O, 4));
    cl.aK = new THREE.InstancedBufferAttribute(K, 4).setUsage(THREE.DynamicDrawUsage);
    cl.K = K;
    g.setAttribute('iK', cl.aK);
    g.instanceCount = n;
    g.boundingSphere = new THREE.Sphere(cl.c.clone(), r + 15);      // (the strands arc, wander and swing a little)
    cl.mesh = new THREE.Mesh(g, mat);
    cl.mesh.renderOrder = 2;
    cl.mesh.userData.noBake = true;
    scene.add(cl.mesh);
  }

  return {
    meshes: clusters.map((c) => c.mesh), falls, strands,
    // racers: the pods (x, z, fwd); a pod passing within ~24 m of where a fall lands shakes it (all its strands)
    update(dt, camPos, racers) {
      for (const f of falls) {
        f.cool -= dt;
        if (f.cool <= 0) for (const r of racers) {
          if (r.gone || Math.abs(r.fwd) < 30) continue;
          const dx = r.x - f.bot.x, dz = r.z - f.bot.z;
          if (dx * dx + dz * dz > 24 * 24 || Math.abs(r.y - f.bot.y) > 12) continue;
          f.pour = 1; f.cool = 3;
          for (let p = 0; p < 4 + Math.random() * 5; p++) fx.pebble(f.top.x + (Math.random() - 0.5) * 0.8, f.top.y - Math.random() * 3, f.top.z + (Math.random() - 0.5) * 0.8);
          break;
        }
        f.pour = Math.max(0, f.pour - dt / 2.5);
        // the puff where it lands, near the camera
        if (camPos.distanceTo(f.bot) < 240) {
          f.acc += dt * (0.7 + 3 * f.pour) * f.k;
          while (f.acc > 1) { f.acc -= 1; fx.puff(f.bot.x + (Math.random() - 0.5) * f.w1, f.bot.y + 0.2, f.bot.z + (Math.random() - 0.5) * f.w1, f.k * (1 + f.pour)); }
        }
      }
      for (const cl of clusters) {
        let dirty = false;
        cl.strands.forEach((st, i) => { if (cl.K[i * 4 + 2] !== st.f.pour) { cl.K[i * 4 + 2] = st.f.pour; dirty = true; } });
        if (dirty) { cl.aK.clearUpdateRanges(); cl.aK.addUpdateRange(0, cl.strands.length * 4); cl.aK.needsUpdate = true; }
      }
    },
  };
}
