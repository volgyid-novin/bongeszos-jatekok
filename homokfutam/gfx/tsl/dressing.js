import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, vec4, uv, attribute, materialColor, positionLocal, positionGeometry, positionPrevious, positionWorld,
  cameraPosition, cameraProjectionMatrix, modelViewMatrix, modelWorldMatrix, normalView, normalLocal, normalWorldGeometry, positionViewDirection, instanceIndex,
  mix, max, min, clamp, pow, exp, abs, sin, sqrt, length, dot, cross, normalize, fract, floor, step, select, smoothstep, fwidth, texture, varying,
} from 'three/tsl';
import { ATMO } from '../atmosphere.js';
import { hfStaticShadow } from './atmosphere.js';
import { sunAt } from './particles.js';
import { ss, oneMinus } from './common.js';
import { hfGust, hfWake } from './wind.js';
import { WIND_DIR } from '../wind.js';

// ============================================================
//  World dressing materials for WebGPURenderer: crowd sprites, cloth sway, dust devils
//  (world/dressing.js), canyon haze (world/haze.js), the arena's interior-mapped openings and the
//  nozzle flame glows (main.js). GLSL versions and notes next to their originals.
// ============================================================

const cloud = (p) => ATMO.hfCloudTex.sample(p).r;

// --- crowd: procedural little people on camera-facing quads (iPos: feet + metres along the track,
// iCol: shirt + seed). Atlas: 4 body types x 3 arm poses; R shirt, G skin, B shading, A coverage ---
export function crowdMaterial(U) {
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
  const iPos = attribute('iPos', 'vec4'), iCol = attribute('iCol', 'vec4');
  const seedV = iCol.w;
  const arms = (wave) => max(wave, U.uCheer.mul(step(0.5, fract(seedV.mul(3.1)))));
  const waveAt = () => U.uWave.mul(smoothstep(0.6, 1, sin(iPos.w.mul(0.045).sub(U.uTime.mul(3.2)))));
  m.positionNode = Fn((builder) => {
    const seed = seedV;
    // stadium wave travelling along the stands + random jumping when excited
    const wave = waveAt().toVar();
    const jump = U.uCheer.mul(max(0, sin(U.uTime.mul(seed.mul(5).add(7)).add(seed.mul(40))))).mul(0.35);
    const stand = max(max(wave, smoothstep(0.2, 0.6, U.uCheer).mul(step(0.35, fract(seed.mul(7.3))))), U.uStand ?? 0);
    // sitting: the same figure sunk behind the row in front of it
    const feet = iPos.xyz.add(vec3(0, jump.add(wave.mul(0.4)).sub(oneMinus(stand).mul(0.5)), 0)).toVar();
    const k = fract(seed.mul(13.7)).mul(0.2).add(0.9);
    const toCam = cameraPosition.sub(feet).toVar();
    const right = normalize(vec3(toCam.z, 0, toCam.x.negate()).add(1e-5));
    // the atlas cell is 1.1 m x 2.2 m around a 1.74 m figure
    const p = feet.add(right.mul(positionGeometry.x).mul(1.1).mul(k)).add(vec3(0, positionGeometry.y.add(0.5).mul(2.2).mul(k), 0));
    if (builder.needsPreviousData()) positionPrevious.assign(p);
    return p;
  })();
  m.colorNode = Fn(() => {
    const seed = seedV;
    const q = positionGeometry.xy.add(0.5);         // (the instanced quad has no uv attribute)
    const pUv = vec2(select(fract(seed.mul(5.3)).greaterThan(0.5), oneMinus(q.x), q.x), q.y).toVar();   // mirrored half the time
    const cell = vec2(floor(fract(seed.mul(4.71)).mul(4)), min(floor(arms(waveAt()).mul(3)), 2)).toVar();
    const t = U.uAtlas.sample(vec2(cell.x.add(pUv.x).div(4), oneMinus(cell.y.add(1).sub(pUv.y).div(3)))).toVar();
    // a crisp edge that keeps its coverage when the figure is a few pixels tall (Golus' alpha sharpening)
    t.a.sub(0.5).div(max(fwidth(t.a), 1e-4)).add(0.5).lessThan(0.5).discard();
    const skin = mix(vec3(0.32, 0.19, 0.12), vec3(0.86, 0.66, 0.52), fract(seed.mul(5.7)));
    const hair0 = mix(vec3(0.05, 0.035, 0.025), vec3(0.42, 0.28, 0.14), fract(seed.mul(9.1)).mul(fract(seed.mul(2.3))));
    const hair = select(cell.x.equal(1), mix(vec3(0.62, 0.5, 0.32), vec3(0.25, 0.2, 0.16), fract(seed.mul(3.3))), hair0);     // the hats
    const legs = mix(vec3(0.12, 0.13, 0.17), vec3(0.42, 0.36, 0.27), step(0.6, fract(seed.mul(6.1))));
    const col = select(t.r.greaterThan(0.5), iCol.rgb, select(t.g.greaterThan(0.5), skin, select(pUv.y.greaterThan(0.62), hair, legs)));
    const sun = sunAt(iPos.xyz.add(vec3(0, 1, 0)).add(ATMO.hfSunDir.mul(2)));
    return col.mul(U.uAmbient.add(U.uSunCol.mul(sun).mul(0.85))).mul(mix(0.5, 1.05, t.b));
  })();
  m.uniforms = U;
  return m;
}

// --- cloth: a standard material whose vertices sway (along: the distance from the fixed edge) ---
class ClothMaterial extends THREE.MeshStandardNodeMaterial {
  setupPosition(builder) {
    const U = this.cloth;
    if (U.gust) return this.setupGustPosition(builder);
    const p = positionGeometry;
    const along = U.fixedEdge === 'x' ? p.x : p.y.negate();
    const ph = builder.object.isInstancedMesh ? float(instanceIndex).mul(1.73) : float(0);     // a phase per copy
    const k = clamp(along.div(U.uLen), 0, 1);
    const w = sin(along.mul(U.uFreq).sub(U.uTime.mul(U.uSpeed)).add(ph)).add(sin(along.mul(U.uFreq).mul(2.3).sub(U.uTime.mul(U.uSpeed).mul(1.7)).add(ph.mul(2))).mul(0.5));
    const d = vec3(0, U.fixedEdge === 'x' ? k.mul(k).mul(-0.25) : 0, w.mul(U.uAmp).mul(k));
    positionLocal.assign(p.add(d));
    if (builder.needsPreviousData()) positionPrevious.assign(p.add(d));
    return super.setupPosition(builder);
  }
  // the one wind (E2): the gust at the cloth's place swells the waves and adds a fast flutter (the flags
  // snap), and a strong gust holds a flag out straighter. The travelling speed stays the same (a speed
  // that followed the gust would jump the phase). The displacement goes on after the copy's transform,
  // along its normal, so the gust can be taken at the copy's place in the world.
  setupGustPosition(builder) {
    super.setupPosition(builder);
    const U = this.cloth;
    const p = positionGeometry;
    const inst = builder.object.isInstancedMesh;
    const along = U.fixedEdge === 'x' ? p.x : p.y.negate();
    const ph = inst ? float(instanceIndex).mul(1.73) : float(0);
    const k = clamp(along.div(U.uLen), 0, 1).toVar();
    const wpos = inst ? positionLocal : modelWorldMatrix.mul(vec4(positionLocal, 1)).xyz;
    const g = hfGust(wpos.xz, U.uTime).toVar();
    const a = along.mul(U.uFreq), b = U.uTime.mul(U.uSpeed);
    const w = sin(a.sub(b).add(ph)).add(sin(a.mul(2.3).sub(b.mul(1.7)).add(ph.mul(2))).mul(0.5))
      .add(sin(a.mul(4.1).sub(b.mul(2.9)).add(ph.mul(3))).mul(g.mul(0.45)));
    const droop = U.fixedEdge === 'x' ? k.mul(k).mul(-0.25).mul(oneMinus(g).add(0.2)) : float(0);
    const d = normalize(normalLocal).mul(w.mul(U.uAmp).mul(g.mul(0.85).add(0.45)).mul(k)).add(vec3(0, droop, 0)).toVar();
    positionLocal.addAssign(d);
    if (builder.needsPreviousData()) positionPrevious.addAssign(d);
    return positionLocal;
  }
  copy(source) { this.cloth = source.cloth; return super.copy(source); }
}
export function clothNodeMaterial(params, U) {
  // cells: a 2 x 2 atlas, each copy showing the cell its iCell attribute (uv offset) names
  const m = new ClothMaterial(U.cells ? { ...params, map: null } : params);
  if (U.cells) m.colorNode = texture(params.map, uv().mul(0.5).add(attribute('iCell', 'vec2')));
  m.cloth = U;
  return m;
}

// --- dust devils: an open cone of drifting noise, edges fading ---
export function dustDevilMaterial(U) {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true });
  const t = ATMO.hfTime;
  m.colorNode = U.uCol.mul(uv().y.mul(0.35).add(0.75));
  m.opacityNode = Fn(() => {
    const p = uv();
    const n = cloud(vec2(p.x.mul(3).add(t.mul(0.9)).add(p.y.mul(1.5)), p.y.mul(1.2).sub(t.mul(0.35))));
    const n2 = cloud(vec2(p.x.mul(5).sub(t.mul(1.3)), p.y.mul(2).sub(t.mul(0.6))));
    const edge = pow(abs(dot(normalView, positionViewDirection)), 0.8);
    return smoothstep(0.35, 0.75, n.mul(n2).mul(1.6)).mul(edge).mul(smoothstep(0, 0.12, p.y)).mul(ss(1, 0.5, p.y)).mul(0.55);
  })();
  m.uniforms = U;
  return m;
}

// --- dust hanging in the canyon and under the arch: sheets lit where the baked shadow lets the sun through ---
export function hazeMaterial(U) {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true, fog: false });
  const A = ATMO, t = A.hfTime;
  const lit = hfStaticShadow(positionWorld, vec3(0, 1, 0)).toVar();
  const V = () => normalize(positionWorld.sub(cameraPosition));
  m.colorNode = Fn(() => {
    const phase = pow(max(dot(V(), A.hfSunDir), 0), 5).mul(2.2).add(0.35);
    // (the shaded part darker with the darker shade of D2, hfShade)
    return mix(A.hfFogCol.mul(0.55).mul(A.hfShade.mul(-0.55).add(1)), A.hfSunCol.mul(1.5), lit).mul(phase);
  })();
  m.opacityNode = Fn(() => {
    const p = uv();
    const dist = length(positionWorld.sub(cameraPosition));
    const n = cloud(p.mul(vec2(2.2, 1.1)).add(vec2(t.mul(0.012), t.mul(0.004)))).mul(cloud(p.mul(vec2(5, 2.7)).sub(vec2(t.mul(0.02), 0)).add(0.37))).mul(1.6);
    const shape = smoothstep(0, 0.12, p.x).mul(ss(1, 0.88, p.x)).mul(smoothstep(0, 0.06, p.y)).mul(pow(oneMinus(p.y), 1.6));
    const fade = smoothstep(0.12, 0.45, abs(dot(V(), normalWorldGeometry))).mul(smoothstep(6, 30, dist));
    return clamp(n.mul(shape).mul(fade).mul(U.uK).mul(lit.mul(0.75).add(0.25)), 0, 0.5);
  })();
  m.uniforms = U;
  return m;
}

// --- the arena's wall openings: a room behind the face by interior mapping. Module space: the opening
// faces +z, the floor is at y = 0; iZ (per instance) = the module's z axis in world xz (the modules are
// only turned about y). Sunlight pools on the floor near the entrance, warm darkness at the back. ---
export function interiorNodeMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ color: '#0d0907', roughness: 1 });
  m.emissiveNode = Fn(() => {
    const iz = attribute('iZ', 'vec2');
    const Z = vec3(iz.x, 0, iz.y), X = cross(vec3(0, 1, 0), Z);
    const dw = positionWorld.sub(cameraPosition).toVar();
    const d = normalize(vec3(dot(dw, X), dw.y, dot(dw, Z))).toVar();
    const P = positionGeometry;
    const D = 4.5;
    const tBack = float(D).div(max(d.z.negate(), 0.15));
    const tFloor = select(d.y.lessThan(-1e-3), P.y.div(d.y.negate()), 1e9);
    // floor: sunlit sand near the entrance, darker further in
    const qf = P.add(d.mul(tFloor));
    const depth = clamp(P.z.sub(qf.z).div(D), 0, 1);
    const floorC = vec3(0.42, 0.31, 0.2).mul(mix(1, 0.12, pow(depth, 0.6)));
    // back wall: bounce light from the floor at its foot, dark above
    const qb = P.add(d.mul(tBack));
    const backC = vec3(0.16, 0.11, 0.075).mul(exp(max(qb.y, 0).mul(-0.9)).mul(0.75).add(0.25));
    // in the colour of the sunlight that comes in
    return select(tFloor.lessThan(tBack), floorC, backC).mul(ATMO.hfSunCol).mul(0.9);
  })();
  return m;
}

// --- the flame glow at every nozzle, one camera-facing sprite each (gfx/fxbatch.js billboard batch:
// iBB = (position, x scale), iBS = y scale) ---
export function flameGlowMaterial(map) {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  m.vertexNode = Fn(() => {
    const bb = attribute('iBB', 'vec4');
    const mv = modelViewMatrix.mul(vec4(bb.xyz, 1)).toVar();
    const s = vec2(bb.w, attribute('iBS', 'float'));
    return cameraProjectionMatrix.mul(vec4(mv.xy.add(positionLocal.xy.mul(s)), mv.z, 1));
  })();
  const tx = texture(map, uv());
  m.colorNode = attribute('aCol', 'vec3').mul(tx.rgb);
  m.opacityNode = tx.a;
  return m;
}

// --- dry grass (world/grass.js): the tips sway with the wind; positionLocal is already the copy's
// position in the world when this runs (the instanced mesh itself sits at the origin) ---
class GrassMaterial extends THREE.MeshStandardNodeMaterial {
  setupPosition(builder) {
    const U = this.grass;
    // grows in towards the edge of the grass's distance: shrinks to nothing at its root (iRoot) before the copy's
    // transform (world/grass.js buildGrass)
    const fade = oneMinus(smoothstep(U.uFar.mul(0.62), U.uFar.mul(0.96), length(attribute('iRoot', 'vec3').sub(cameraPosition)))).toVar();
    positionLocal.assign(positionGeometry.mul(fade));
    super.setupPosition(builder);
    const y = positionGeometry.y.mul(fade), wp = positionLocal.xz.toVar();
    const k = y.mul(y).mul(2);
    if (U.gust) {
      // the one wind (E2): the gust field bows the tufts, a slow breath and a little flutter between fronts
      const g = hfGust(wp, U.uTime).toVar();
      const gust = clamp(sin(U.uTime.mul(1.6).add(dot(wp, U.uWind).mul(0.11))).mul(0.12).add(0.2).add(g.mul(1.6)), 0, 2);
      const flick = sin(U.uTime.mul(7.3).add(wp.x.mul(1.7)).add(wp.y.mul(2.3)).add(positionGeometry.x.mul(9))).mul(0.25).mul(g.add(0.4));
      const d = U.uWind.mul(gust.add(0.35)).add(vec2(U.uWind.y.negate(), U.uWind.x).mul(flick)).mul(U.uAmp).mul(k);
      positionLocal.addAssign(vec3(d.x, U.uAmp.mul(k).mul(gust).mul(-0.25), d.y));
      if (U.wake) {
        // a passing pod (E7): flattened by the jets behind it, whipping back and forth as it springs up
        const wk = hfWake(vec3(wp.x, positionLocal.y, wp.y)).toVar();
        positionLocal.addAssign(vec3(wk.x.mul(0.42).mul(k), length(wk.xy).mul(-0.12).mul(k), wk.y.mul(0.42).mul(k)));
      }
      return positionLocal;
    }
    const gust = sin(dot(wp, U.uWind).mul(0.06).sub(U.uTime.mul(1.9))).mul(0.5).add(0.5);
    const flick = sin(U.uTime.mul(7.3).add(wp.x.mul(1.7)).add(wp.y.mul(2.3)).add(positionGeometry.x.mul(9))).mul(0.25);
    const d = U.uWind.mul(gust.add(0.35)).add(vec2(U.uWind.y.negate(), U.uWind.x).mul(flick)).mul(U.uAmp).mul(k);
    positionLocal.addAssign(vec3(d.x, U.uAmp.mul(k).mul(gust).mul(-0.15), d.y));
    if (U.wake) {
      const wk = hfWake(vec3(wp.x, positionLocal.y, wp.y)).toVar();
      positionLocal.addAssign(vec3(wk.x.mul(0.42).mul(k), length(wk.xy).mul(-0.12).mul(k), wk.y.mul(0.42).mul(k)));
    }
    return positionLocal;
  }
  copy(source) { this.grass = source.grass; return super.copy(source); }
}
export function grassNodeMaterial(params, U) {
  const m = new GrassMaterial(params);
  m.grass = U;
  return m;
}

// --- sand streaming across the track (world/drift.js, E1; GLSL version and notes there): ribbons, grains
// racing along the wind, the gust's sheet; aF = (fade at the stretch's ends, fade across) ---
export function driftMaterial(U, params, layers = 2, wake = false) {
  const m = new THREE.MeshBasicNodeMaterial({ ...params, fog: true });
  const A = ATMO, t = A.hfTime;
  const W = vec2(WIND_DIR.x, WIND_DIR.y);
  const V = () => normalize(positionWorld.sub(cameraPosition));
  m.colorNode = Fn(() => {
    const fs = pow(max(dot(V(), A.hfSunDir), 0), 4);
    const vis = hfStaticShadow(positionWorld.add(vec3(0, 0.3, 0)), vec3(0, 1, 0));
    // (the grains in the air catch the sun: a little lighter than the sand they leave)
    return U.uAlb.mul(A.hfFogCol.mul(U.uAmb).add(A.hfSunCol.mul(U.uSun).mul(vis).mul(fs.mul(0.9).add(0.8)))).mul(1.15);
  })();
  m.opacityNode = Fn(() => {
    const xz = positionWorld.xz.toVar();
    const a = dot(xz, W).toVar(), c = xz.y.mul(W.x).sub(xz.x.mul(W.y)).toVar();
    // billows: the gust's sheet comes in lumps travelling with it, its leading edge lobed
    const bil = cloud(vec2(a.sub(t.mul(12)).div(240), c.div(90))).toVar();
    const g = hfGust(xz.add(W.mul(bil.sub(0.5).mul(40))), t).toVar();
    // the ribbons: braided, snaking, drifting slowly downwind
    const warp = cloud(vec2(a.div(260).sub(t.mul(0.004)), c.div(120)));
    const ribbons = smoothstep(0.42, 0.62, cloud(vec2(a.sub(t.mul(3.5)).div(220), c.add(warp.mul(22)).div(34))));
    // the grains: fine streaks racing along the wind
    let n = cloud(vec2(a.sub(t.mul(13)).div(22), c.div(1.1)));
    if (layers > 1) n = n.mul(0.55).add(cloud(vec2(a.sub(t.mul(9)).div(14), c.div(0.7)).add(0.37)).mul(0.45));
    const grains = smoothstep(0.38, 0.75, n);
    // a gust: the ribbons swell and merge into a sheet that hazes the road
    const sheet = smoothstep(0.2, 0.85, g).mul(smoothstep(0.25, 0.65, bil.add(g.mul(0.25))));
    const cover = mix(ribbons, 1, sheet.mul(0.6));
    const f = attribute('aF', 'vec2');
    const dist = length(positionWorld.sub(cameraPosition));
    const alpha = cover.mul(mix(0.15, 0.3, sheet).add(mix(0.45, 0.35, sheet).mul(grains))).mul(g.mul(0.4).add(0.6)).mul(f.x).mul(f.y).mul(U.uK)
      // a longer path through the layer at grazing angles; nothing in the last metres before the lens
      .mul(oneMinus(abs(V().y)).mul(0.8).add(0.7)).mul(smoothstep(1.5, 6, dist));
    // a passing pod (E7) parts the stream: its jets blow a lane clear behind it, filling back in
    if (wake) return clamp(alpha.mul(oneMinus(clamp(hfWake(positionWorld, 4).z, 0, 1).mul(0.7))), 0, 0.85);
    return clamp(alpha, 0, 0.85);
  })();
  m.uniforms = U;
  return m;
}

// --- sand pouring from the rock (world/trickle.js, E3; GLSL version and notes there): a strip per strand along a
// curved path (the arc of a pour, a wander in the air, the gust); iTop = (top, width), iBot = (landing, width),
// iK = (seed, strength, pour, drop), iOut = (out x, z, its speed, how much it wanders) ---
export function trickleMaterial(U, params, gust) {
  const m = new THREE.MeshBasicNodeMaterial({ ...params, fog: true });
  const iTop = attribute('iTop', 'vec4'), iBot = attribute('iBot', 'vec4'), iK = attribute('iK', 'vec4'), iOut = attribute('iOut', 'vec4');
  const t = U.uTime;
  const g = () => (gust ? hfGust(iTop.xz, t) : float(0.3));
  const tauAt = (v) => sqrt(v.mul(iK.w).mul(2 / 9.8));
  const path = (v, gv) => {
    const len = iK.w, d = v.mul(len), tau = tauAt(v), tauE = sqrt(len.mul(2 / 9.8));
    const o = iOut.xy, q = vec2(o.y.negate(), o.x), s = iK.x;
    // the arc of a pour leaving the lip
    const arc = o.mul(iOut.z.mul(tau.sub(tauE.mul(v))));
    // a slow wander in the air, growing with the distance fallen, travelling down the stream with the sand
    const m1 = sin(tau.mul(2.3).sub(t.mul(1.1)).add(s.mul(3))).mul(0.6).add(sin(tau.mul(4.1).sub(t.mul(1.9)).add(s.mul(7))).mul(0.4));
    const m2 = sin(tau.mul(1.7).sub(t.mul(0.8)).add(s.mul(5))).mul(0.6).add(sin(tau.mul(3.3).sub(t.mul(1.5)).add(s.mul(2))).mul(0.4));
    const wander = q.mul(m1).add(o.mul(m2).mul(0.5)).mul(iOut.w.mul(d).mul(0.035).mul(smoothstep(0, 0.15, v)));
    // the gust swings the lower part downwind
    const sway = U.uWind.mul(gv.add(0.25)).mul(v.mul(v)).mul(len).mul(0.02);
    const h = arc.add(wander).add(sway);
    return mix(iTop.xyz, iBot.xyz, v).add(vec3(h.x, 0, h.y));
  };
  const v = positionGeometry.y;
  const width = () => {
    const tau = tauAt(v), s = iK.x;
    // necking and swelling as clumps fall
    const clump = sin(tau.mul(6).sub(t.mul(6)).add(s.mul(13))).mul(0.5).add(0.5).mul(sin(tau.mul(2.6).sub(t.mul(2.6)).add(s.mul(5))).mul(0.5).add(0.5)).mul(0.56).add(0.72);
    return mix(iTop.w, iBot.w, pow(v, 0.8)).mul(iK.z.mul(0.7).add(1)).mul(mix(1, clump, smoothstep(0.05, 0.3, v)));
  };
  // no thinner than ~1.5 px: far falls widen and fade instead of shimmering
  const pxW = (P) => length(cameraPosition.sub(P)).mul(2).div(cameraProjectionMatrix.element(1).y.mul(1080)).mul(1.5);
  m.positionNode = Fn(() => {
    const gv = g().toVar();
    const P = path(v, gv).toVar();
    const T = path(min(v.add(0.02), 1), gv).sub(path(max(v.sub(0.02), 0), gv));
    const right = normalize(cross(normalize(T), cameraPosition.sub(P)).add(1e-5));
    return P.add(right.mul(positionGeometry.x).mul(max(width(), pxW(P))));
  })();
  const thin = varying(Fn(() => { const w = width().toVar(); return w.div(max(w, pxW(path(v, g())))); })(), 'vThin');
  m.colorNode = Fn(() => {
    const V = normalize(positionWorld.sub(cameraPosition));
    const lit = hfStaticShadow(positionWorld, vec3(0, 1, 0));
    const phase = pow(max(dot(V, ATMO.hfSunDir), 0), 5).mul(2.6).add(0.45);
    return mix(ATMO.hfFogCol.mul(0.5).mul(oneMinus(ATMO.hfShade.mul(0.55))), ATMO.hfSunCol.mul(1.6), lit).mul(phase).mul(U.uAlb);
  })();
  m.opacityNode = Fn(() => {
    const seed = iK.x, k = iK.y, pour = iK.z, x = positionGeometry.x;
    // laid out in the time a grain takes to fall this far, so the streaks speed up as they fall
    const tau = tauAt(v).toVar();
    const n1 = cloud(vec2(x.mul(0.35).add(seed), tau.mul(0.9).sub(t.mul(0.9))));
    const n2 = cloud(vec2(x.mul(0.9).add(seed.mul(1.7)), tau.mul(2.3).sub(t.mul(2.3))));
    const streak = smoothstep(pour.mul(-0.12).add(0.36), 0.7, n1.mul(0.6).add(n2.mul(0.4)));
    // a dense thin core and a hazy, ragged edge; lower down it breaks into clumps
    const rag = cloud(vec2(tau.mul(1.6).sub(t.mul(1.6)).add(seed), x.mul(0.25).add(seed.mul(0.3)))).sub(0.5);
    const core = oneMinus(smoothstep(v.mul(0.25).add(0.05), 0.45, abs(x).add(rag.mul(v.mul(0.25).add(0.1)))));
    const a = core.mul(mix(0.95, streak, v.mul(0.6).add(0.3))).mul(smoothstep(0, 0.03, v)).mul(oneMinus(smoothstep(0.72, 1, v)))
      .mul(k).mul(pour.mul(0.6).add(0.8)).mul(thin)
      // (a fall a few metres from the lens would smear across the frame: it fades out up close)
      .mul(smoothstep(3, 12, length(positionWorld.sub(cameraPosition))));
    return clamp(a, 0, 0.95);
  })();
  m.uniforms = U;
  return m;
}

// --- the course's props (world/course.js, E4/E5): vertex colour tint, darkened by the occlusion Blender baked into
// aAO (the vertex colour and a copy's own colour multiply in after this) ---
export function propNodeMaterial(params) {
  const m = new THREE.MeshStandardNodeMaterial({ vertexColors: true, ...params });
  m.colorNode = vec4(materialColor.mul(mix(1, attribute('aAO', 'float'), 0.75)), 1);
  return m;
}

// --- dry scrub (world/dressing.js) in the one wind (E2): stiff, woody; the top bows downwind in a gust
// and shivers. The copies are turned at random, so the push goes on in the world, after their transform
// (the instanced mesh sits at the origin); positionGeometry.y is 0 at the root and 1 at the top. ---
class SwayMaterial extends THREE.MeshStandardNodeMaterial {
  setupPosition(builder) {
    super.setupPosition(builder);
    const U = this.sway;
    const y = clamp(positionGeometry.y, 0, 1), k = y.mul(y);
    const wp = positionLocal.xz.toVar(), t = U.uTime;
    const g = hfGust(wp, t).toVar();
    const lean = sin(t.mul(1.3).add(dot(wp, U.uWind).mul(0.07))).mul(0.1).add(0.25).add(g.mul(1.2)).toVar();
    const shiver = sin(t.mul(11).add(wp.x.mul(0.4)).add(wp.y.mul(0.35))).mul(0.3).mul(g);
    const d = U.uWind.mul(lean).add(vec2(U.uWind.y.negate(), U.uWind.x).mul(shiver)).mul(U.uAmp).mul(k);
    positionLocal.addAssign(vec3(d.x, U.uAmp.mul(k).mul(lean).mul(-0.2), d.y));
    if (U.wake) {
      // a passing pod (E7): thrashed by the jets, then springing back
      const wk = hfWake(vec3(wp.x, positionLocal.y, wp.y)).toVar();
      positionLocal.addAssign(vec3(wk.x, 0, wk.y).mul(k).mul(0.3));
    }
    return positionLocal;
  }
  copy(source) { this.sway = source.sway; return super.copy(source); }
}
export function swayNodeMaterial(params, U) {
  const m = new SwayMaterial(params);
  m.sway = U;
  return m;
}
