import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, Break, float, vec2, vec3, vec4, mix, smoothstep, pow, exp, max, min, abs, fract, sin, clamp, step, select, dot, normalize, acos, asin, sign, sqrt,
  uniform, positionWorld, positionLocal, cameraPosition, cameraProjectionMatrix, modelViewMatrix, normalWorldGeometry,
  faceDirection, output, reference, renderGroup, texture, interleavedGradientNoise, screenCoordinate,
} from 'three/tsl';
import { ATMO, PALETTE, PB_SKY, MID_SHADOW, VCLOUDS, CLOUD_DEPTH } from '../atmosphere.js';
import { oneMinus } from './common.js';

// ============================================================
//  Atmosphere for the node materials (WebGPURenderer). The same model as gfx/atmosphere.js:
//   - scene.fogNode: the analytic height fog with sun in-scatter on every fogged material
//   - SunLight: a DirectionalLight whose light node multiplies the sun by hfSunVis() (baked world
//     shadow x cloud shadow) for every lit material, as the patched lights chunk does in GLSL
//   - the sky dome material
//  ATMO's entries are uniform / texture nodes on this renderer (gfx/backend.js).
// ============================================================

// optical depth of the exponential height fog along a ray (Quilez)
export const hfFogAmount = Fn(([ro, rd, dist]) => {
  const b = ATMO.hfFogFalloff;
  const a = ATMO.hfFogDensity.mul(exp(b.negate().mul(ro.y)));
  const ry = rd.y.mul(b);
  const k = select(abs(ry).lessThan(1e-5), dist, float(1).sub(exp(ry.negate().mul(dist))).div(ry));
  return float(1).sub(exp(a.negate().mul(max(k, 0))));
});
export const hfFogTint = Fn(([rd]) => {
  const s = max(dot(rd, ATMO.hfSunDir), 0);
  return mix(ATMO.hfFogCol, ATMO.hfFogSunCol, pow(s, 5)).add(ATMO.hfSunCol.mul(pow(s, 40).mul(0.35)));
});
export const hfCloud = Fn(([p]) => {
  const uv = p.div(5600).add(ATMO.hfWind.mul(ATMO.hfTime));
  const n = ATMO.hfCloudTex.sample(uv).r.mul(0.68).add(ATMO.hfCloudTex.sample(uv.mul(2.9).add(vec2(0.37, 0.71))).r.mul(0.32));
  return smoothstep(ATMO.hfCloudCover, ATMO.hfCloudCover.add(0.2), n);
});
// baked world shadow; hfShadowMatrix maps world space straight to (u, v, depth) of the bake
export const hfStaticShadow = Fn(([wp, wn]) => {
  const c = ATMO.hfShadowMatrix.mul(vec4(wp.add(wn.mul(1.2)), 1)).xyz.toVar();
  const inside = step(0, c.x).mul(step(c.x, 1)).mul(step(0, c.y)).mul(step(c.y, 1)).mul(step(c.z, 1));
  const z = c.z.sub(ATMO.hfShadowBias);
  const t = ATMO.hfShadowTexel.mul(1.5);
  const tap = (o) => ATMO.hfShadowMap.sample(c.xy.add(o)).compare(z);
  const s = tap(vec2(0)).add(tap(vec2(t.x, t.y.mul(0.4)))).add(tap(vec2(t.x.mul(-0.4), t.y)))
    .add(tap(vec2(t.x.negate(), t.y.mul(-0.4)))).add(tap(vec2(t.x.mul(0.4), t.y.negate()))).mul(0.2);
  const v = mix(1, s, inside.mul(ATMO.hfShadowOn));
  if (!MID_SHADOW) return v;
  // the cached mid-distance shadow takes over inside its box, fading at the edge (gfx/atmosphere.js)
  const m = ATMO.hfMidMatrix.mul(vec4(wp.add(wn.mul(0.35)), 1)).xyz.toVar();
  const e = min(m.xy, oneMinus(m.xy));
  const w = smoothstep(0, 0.06, min(e.x, e.y)).mul(step(m.z, 1)).mul(ATMO.hfMidOn);
  const mz = m.z.sub(ATMO.hfMidBias), mt = ATMO.hfMidTexel.mul(1.5);
  const mtap = (o) => ATMO.hfMidMap.sample(m.xy.add(o)).compare(mz);
  const ms = mtap(vec2(0)).add(mtap(vec2(mt.x, mt.y.mul(0.4)))).add(mtap(vec2(mt.x.mul(-0.4), mt.y)))
    .add(mtap(vec2(mt.x.negate(), mt.y.mul(-0.4)))).add(mtap(vec2(mt.x.mul(0.4), mt.y.negate()))).mul(0.2);
  // pods beyond the near shadow map (which has them up close)
  const far = smoothstep(80, 110, wp.sub(cameraPosition).length()).mul(ATMO.hfMidPodsOn);
  const pod = mix(1, ATMO.hfMidPods.sample(m.xy).compare(mz), far);
  return mix(v, ms.mul(pod), w);
});
// static shadow x cloud shadow at a world position (wn: world geometric normal)
export const hfSunVis = Fn(([wp, wn]) => {
  const v = hfStaticShadow(wp, wn);
  const cp = wp.xz.add(ATMO.hfSunDir.xz.mul(ATMO.hfCloudH.sub(wp.y).div(max(ATMO.hfSunDir.y, 0.05))));
  return v.mul(float(1).sub(ATMO.hfCloudShadow.mul(hfCloud(cp))));
});
// how much of a fragment at world position wp the fog hides (additive materials fade by it)
export const hfFogFactor = Fn(([wp]) => {
  const d = wp.sub(cameraPosition);
  const dist = d.length();
  return hfFogAmount(cameraPosition, d.div(max(dist, 1e-4)), dist);
});
// --- physically based sky and aerial perspective (PB_SKY; GLSL version and notes: gfx/atmosphere.js) ---
const hg = (c, g) => { const g2 = g.mul(g), d = max(g2.add(1).sub(g.mul(2).mul(c)), 1e-4); return oneMinus(g2).div(d.mul(sqrt(d)).mul(12.5663706)); };
const rayP = (c) => c.mul(c).add(1).mul(0.0596831);
// in-scattered radiance per unit optical depth of the low dust, at cosine c from the sun (lit by the scene's sun)
export const hfDustRate = Fn(([c]) => {
  const p = hg(c, ATMO.hfDustG).mul(0.75).add(hg(c, float(-0.3)).mul(0.25));
  return ATMO.hfDustAlb.mul(ATMO.hfSunCol.mul(p).add(ATMO.hfPsi).add(ATMO.hfBounce)).mul(ATMO.hfSkyE);
});
const hfDustOD = Fn(([ro, rd, dist]) => {
  const b = ATMO.hfFogFalloff;
  const a = ATMO.hfFogDensity.mul(exp(b.negate().mul(ro.y)));
  const ry = rd.y.mul(b);
  const k = select(abs(ry).lessThan(1e-5), dist, oneMinus(exp(ry.negate().mul(dist))).div(ry));
  return a.mul(max(k, 0));
});
// light scattered towards the eye over dist metres along rd (S) and the transmittance (T)
export function hfAerial(ro, rd, dist) {
  const c = dot(rd, ATMO.hfSunDir).toVar();
  const tauA = ATMO.hfRayS.mul(dist.mul(ATMO.hfApScale)).toVar();
  const tauD = hfDustOD(ro, rd, dist).toVar();
  const rateA = ATMO.hfSunT.mul(rayP(c)).add(ATMO.hfPsi).mul(ATMO.hfSkyE);
  const tau = tauA.add(tauD).toVar();
  const T = exp(tau.negate()).toVar();
  const S = rateA.mul(tauA).add(hfDustRate(c).mul(tauD)).div(max(tau, vec3(1e-6))).mul(oneMinus(T));
  return { S, T };
}
// the baked sky (air above the dust) towards rd
export const hfSkyAir = Fn(([rd]) => {
  const phi = acos(clamp(dot(normalize(rd.xz.add(1e-6)), normalize(ATMO.hfSunDir.xz)), -1, 1));
  const el = asin(clamp(rd.y, -1, 1));
  const uv = vec2(phi.mul(0.3183099), sign(el).mul(sqrt(abs(el).mul(0.6366198))).mul(0.5).add(0.5));
  return ATMO.hfSkyLut.sample(uv).rgb.mul(ATMO.hfSkyE);
});

// the fog itself, for materials that cannot use scene.fogNode (their own world position)
export const hfApplyFog = Fn(([col, wp]) => {
  const d = wp.sub(cameraPosition);
  const dist = d.length();
  const rd = d.div(max(dist, 1e-4));
  if (PB_SKY) { const { S, T } = hfAerial(cameraPosition, rd, dist); return col.mul(T).add(S); }
  return mix(col, hfFogTint(rd), hfFogAmount(cameraPosition, rd, dist));
});
// what is left of light added at wp (additive materials)
export const hfFogTrans = Fn(([wp]) => {
  if (!PB_SKY) return vec3(oneMinus(hfFogFactor(wp)));
  const d = wp.sub(cameraPosition);
  const dist = d.length();
  return hfAerial(cameraPosition, d.div(max(dist, 1e-4)), dist).T;
});
// the fog over premultiplied colour col with coverage alpha at wp
export const hfApplyFogPremul = Fn(([col, alpha, wp]) => {
  const d = wp.sub(cameraPosition);
  const dist = d.length();
  const rd = d.div(max(dist, 1e-4));
  if (PB_SKY) { const { S, T } = hfAerial(cameraPosition, rd, dist); return col.mul(T).add(S.mul(alpha)); }
  return mix(col, hfFogTint(rd).mul(alpha), hfFogAmount(cameraPosition, rd, dist));
});

// --- the sun -----------------------------------------------------------------
export class SunLight extends THREE.DirectionalLight {}
class SunLightNode extends THREE.DirectionalLightNode {
  static get type() { return 'SunLightNode'; }
  setupDirect(builder) {
    const d = super.setupDirect(builder);
    d.lightColor = d.lightColor.mul(hfSunVis(positionWorld, normalWorldGeometry.mul(faceDirection)));
    return d;
  }
}

export function installNodeAtmosphere(renderer, scene) {
  renderer.library.addLight(SunLightNode, SunLight);
  scene.fogNode = Fn(() => {
    const d = positionWorld.sub(cameraPosition);
    const dist = d.length();
    const rd = d.div(max(dist, 1e-4));
    if (PB_SKY) { const { S, T } = hfAerial(cameraPosition, rd, dist); return vec4(output.rgb.mul(T).add(S), output.a); }
    return vec4(mix(output.rgb, hfFogTint(rd), hfFogAmount(cameraPosition, rd, dist)), output.a);
  })();
}

// --- sky ---------------------------------------------------------------------
// the gradient blends in Oklab (Ottosson): mixing the warm horizon and the blue zenith in linear RGB
// goes through a greyish lilac halfway up
const lin2ok = Fn(([c]) => {
  const l = pow(max(vec3(
    dot(c, vec3(0.4122214708, 0.5363325363, 0.0514459929)),
    dot(c, vec3(0.2119034982, 0.6806995451, 0.1073969566)),
    dot(c, vec3(0.0883024619, 0.2817188376, 0.6299787005))), vec3(0)), vec3(1 / 3));
  return vec3(dot(l, vec3(0.2104542553, 0.7936177850, -0.0040720468)), dot(l, vec3(1.9779984951, -2.4285922050, 0.4505937099)), dot(l, vec3(0.0259040371, 0.7827717662, -0.8086757660)));
});
const ok2lin = Fn(([c]) => {
  const l = vec3(c.x.add(c.y.mul(0.3963377774)).add(c.z.mul(0.2158037573)), c.x.sub(c.y.mul(0.1055613458)).sub(c.z.mul(0.0638541728)), c.x.sub(c.y.mul(0.0894841775)).sub(c.z.mul(1.2914855480)));
  const l3 = l.mul(l).mul(l);
  return vec3(dot(l3, vec3(4.0767416621, -3.3077115913, 0.2309699292)), dot(l3, vec3(-1.2684380046, 2.6097574011, -0.3413193965)), dot(l3, vec3(-0.0041960863, -0.7034186147, 1.7076147010)));
});

// --- 2.5D clouds (VCLOUDS; GLSL version and notes: gfx/atmosphere.js) --------------------------------
const hfCloudD = Fn(([p]) => {
  const h = clamp(p.y.sub(ATMO.hfCloudH).div(CLOUD_DEPTH), 0, 1).toVar();
  const uv = p.xz.div(5600).add(ATMO.hfWind.mul(ATMO.hfTime)).toVar();
  const n = ATMO.hfCloudTex.sample(uv).r.mul(0.68).add(ATMO.hfCloudTex.sample(uv.mul(2.9).add(vec2(0.37, 0.71))).r.mul(0.32))
    .sub(ATMO.hfCloudTex.sample(uv.mul(9.7).add(vec2(h.mul(0.6), 0.13))).r.mul(0.05));
  const c = ATMO.hfCloudCover.add(h.mul(h).mul(0.18));
  return smoothstep(c, c.add(0.17), n).mul(smoothstep(0, 0.12, h)).mul(oneMinus(smoothstep(0.8, 1, h)));
});
const hfCloudSlab = Fn(([col, ro, rd, sd]) => {
  const rdy = max(rd.y, 0.012);
  const tA = max(ATMO.hfCloudH.sub(ro.y).div(rdy), 0).toVar(), tB = ATMO.hfCloudH.add(CLOUD_DEPTH).sub(ro.y).div(rdy);
  // (at grazing angles only the near 2.2 km of the slab: longer steps band the edges)
  const ds = min(tB.sub(tA), 2200).div(10).toVar();
  const fade = smoothstep(0.012, 0.12, rd.y);
  // per pixel and per frame (TRAA averages it)
  const jit = interleavedGradientNoise(screenCoordinate.add(fract(ATMO.hfTime.mul(7.31)).mul(vec2(97, 53)))).toVar();
  const sunC = mix(vec3(1, 0.95, 0.88), ATMO.hfSunCol.mul(1.6), pow(sd, 4)).mul(1.35).toVar();
  const skyC = vec3(0.5, 0.57, 0.72);
  const g = 0.6;
  const phase = float(0.9 * (1 - g * g)).div(pow(sd.mul(-2 * g).add(1 + g * g), 1.5)).mul(0.1).add(0.65).toVar();
  const T = float(1).toVar(), S = vec3(0).toVar();
  Loop(10, ({ i }) => {
    const p = ro.add(rd.mul(tA.add(float(i).add(jit).mul(ds)))).toVar();
    const d = hfCloudD(p).toVar();
    If(d.greaterThan(0.002), () => {
      const l = hfCloudD(p.add(ATMO.hfSunDir.mul(110))).mul(1.3).add(hfCloudD(p.add(ATMO.hfSunDir.mul(300))));
      const lt = exp(l.mul(-1.6)).mul(oneMinus(exp(d.mul(-6)).mul(0.5)));
      const h = p.y.sub(ATMO.hfCloudH).div(CLOUD_DEPTH);
      const L = sunC.mul(lt).mul(phase).add(skyC.mul(h.mul(0.4).add(0.45)));
      const a = oneMinus(exp(d.mul(ds).mul(-0.006))).toVar();
      S.addAssign(L.mul(a).mul(T));
      T.mulAssign(oneMinus(a));
      If(T.lessThan(0.02), () => { Break(); });
    });
  });
  return mix(col, col.mul(T).add(S), fade);
});

export function skyNodeMaterial() {
  const u = {
    hfZenith: uniform(PALETTE.zenith), hfSkyHorizon: uniform(PALETTE.skyHorizon), hfSkyMid: uniform(PALETTE.skyMid),
    hfGround: uniform(PALETTE.ground), hfEnv: uniform(0),
  };
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
  // on the far plane, whatever the dome's size
  m.vertexNode = Fn(() => cameraProjectionMatrix.mul(modelViewMatrix).mul(vec4(positionLocal, 1)).xyww)();
  m.colorNode = Fn(() => {
    const A = ATMO, rd = normalize(positionLocal).toVar();
    const h = max(rd.y, 0);
    const sd = max(dot(rd, A.hfSunDir), 0).toVar();
    let col;
    if (PB_SKY) {
      // the air above the low dust, from the baked tables (its aerosol makes the glow round the sun)
      col = hfSkyAir(vec3(rd.x, h, rd.z)).toVar();
    } else {
      // warm horizon (cooler on the side away from the sun) -> pale blue -> zenith blue
      const toSun = dot(normalize(rd.xz.add(1e-5)), normalize(A.hfSunDir.xz)).mul(0.5).add(0.5);
      const hor = mix(u.hfSkyHorizon.mul(vec3(0.84, 0.92, 1.06)), u.hfSkyHorizon, toSun.mul(toSun));
      let ok = mix(lin2ok(hor), lin2ok(u.hfSkyMid), smoothstep(0, 0.2, h));
      ok = mix(ok, lin2ok(u.hfZenith), pow(smoothstep(0.06, 0.7, h), 0.85));
      col = ok2lin(ok).toVar();
      col.addAssign(A.hfSunCol.mul(pow(sd, 10).mul(0.22).add(pow(sd, 120).mul(0.6))));
    }
    // cloud layer on a plane above the camera
    const ro = select(u.hfEnv.greaterThan(0.5), vec3(0, 40, 0), cameraPosition).toVar();
    const t = A.hfCloudH.sub(ro.y).div(max(rd.y, 0.015));
    const cp = ro.xz.add(rd.xz.mul(t)).toVar();
    const cl = hfCloud(cp).mul(smoothstep(0.015, 0.14, rd.y)).toVar();
    if (VCLOUDS) col.assign(hfCloudSlab(col, ro, rd, sd));
    else {
      const thick = hfCloud(cp.add(A.hfSunDir.xz.mul(260)));          // denser towards the sun = darker base
      const lit = mix(vec3(1, 0.95, 0.88), A.hfSunCol.mul(1.6), pow(sd, 4)).mul(1.15);
      const cloudCol = mix(lit, vec3(0.62, 0.6, 0.66), thick.mul(0.55));
      col.assign(mix(col, cloudCol, cl.mul(0.88)));
    }
    // sun disc on top of thin cloud
    col.addAssign(A.hfSunCol.mul(smoothstep(0.99965, 0.9999, sd)).mul(38).mul(float(1).sub(cl.mul(0.8))).mul(float(1).sub(u.hfEnv)));
    const below = rd.y.lessThan(0);
    if (PB_SKY) {
      // below the horizon (environment map only): sunlit sand behind the dust; then the low dust in front,
      // out to infinity (the same layer and light as the fog on the ground)
      col.assign(select(below, u.hfGround.mul(A.hfSunDir.y.mul(0.6).add(0.55)), col));
      const up = A.hfFogDensity.mul(exp(A.hfFogFalloff.negate().mul(ro.y))).div(A.hfFogFalloff.mul(max(rd.y, 1e-4)));
      const tauD = select(below, oneMinus(smoothstep(0, 0.3, rd.y.negate())).mul(50), up);
      const dT = exp(vec3(tauD).negate());
      return col.mul(dT).add(hfDustRate(dot(rd, A.hfSunDir)).mul(oneMinus(dT)));
    }
    // below the horizon (environment map only): sunlit sand
    col.assign(select(below, mix(A.hfFogCol, u.hfGround.mul(A.hfSunDir.y.mul(0.6).add(0.55)), smoothstep(0, 0.25, rd.y.negate())), col));
    // horizon haze: the ground fog at infinite distance
    const up = float(1).sub(exp(A.hfFogDensity.negate().mul(exp(A.hfFogFalloff.negate().mul(ro.y))).div(A.hfFogFalloff.mul(max(rd.y, 1e-4)))));
    const fogK = select(below, float(1).sub(smoothstep(0, 0.3, rd.y.negate())), up);
    return mix(col, hfFogTint(rd), clamp(fogK, 0, 1));
  })();
  m.uniforms = u;
  return m;
}

// The near shadow map's filter: 9 bilinear compare taps on a grid radius texels apart, as WebGL's
// PCFShadowMap does. three's TSL PCF turns 5 taps by a per-pixel noise that stays put on screen,
// which reads as grain (TRAA cannot average noise that does not change).
export const smoothPCF = Fn(({ depthTexture, shadowCoord, shadow }) => {
  const size = reference('mapSize', 'vec2', shadow).setGroup(renderGroup);
  const radius = reference('radius', 'float', shadow).setGroup(renderGroup);
  const d = vec2(1).div(size).mul(radius).toVar();
  let s = float(0);
  for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) {
    s = s.add(texture(depthTexture, shadowCoord.xy.add(d.mul(vec2(x, y)))).compare(shadowCoord.z));
  }
  return s.div(9);
});
