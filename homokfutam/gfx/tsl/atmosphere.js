import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, vec4, mix, smoothstep, pow, exp, max, abs, clamp, step, select, dot, normalize,
  uniform, positionWorld, positionLocal, cameraPosition, cameraProjectionMatrix, modelViewMatrix, normalWorldGeometry,
  faceDirection, output, reference, renderGroup, texture,
} from 'three/tsl';
import { ATMO, PALETTE } from '../atmosphere.js';

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
  return mix(1, s, inside.mul(ATMO.hfShadowOn));
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
// the fog itself, for materials that cannot use scene.fogNode (their own world position)
export const hfApplyFog = Fn(([col, wp]) => {
  const d = wp.sub(cameraPosition);
  const dist = d.length();
  const rd = d.div(max(dist, 1e-4));
  return mix(col, hfFogTint(rd), hfFogAmount(cameraPosition, rd, dist));
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
    // warm horizon (cooler on the side away from the sun) -> pale blue -> zenith blue
    const toSun = dot(normalize(rd.xz.add(1e-5)), normalize(A.hfSunDir.xz)).mul(0.5).add(0.5);
    const hor = mix(u.hfSkyHorizon.mul(vec3(0.84, 0.92, 1.06)), u.hfSkyHorizon, toSun.mul(toSun));
    let ok = mix(lin2ok(hor), lin2ok(u.hfSkyMid), smoothstep(0, 0.2, h));
    ok = mix(ok, lin2ok(u.hfZenith), pow(smoothstep(0.06, 0.7, h), 0.85));
    const col = ok2lin(ok).toVar();
    const sd = max(dot(rd, A.hfSunDir), 0).toVar();
    col.addAssign(A.hfSunCol.mul(pow(sd, 10).mul(0.22).add(pow(sd, 120).mul(0.6))));
    // cloud layer on a plane above the camera
    const ro = select(u.hfEnv.greaterThan(0.5), vec3(0, 40, 0), cameraPosition).toVar();
    const t = A.hfCloudH.sub(ro.y).div(max(rd.y, 0.015));
    const cp = ro.xz.add(rd.xz.mul(t)).toVar();
    const cl = hfCloud(cp).mul(smoothstep(0.015, 0.14, rd.y)).toVar();
    const thick = hfCloud(cp.add(A.hfSunDir.xz.mul(260)));          // denser towards the sun = darker base
    const lit = mix(vec3(1, 0.95, 0.88), A.hfSunCol.mul(1.6), pow(sd, 4)).mul(1.15);
    const cloudCol = mix(lit, vec3(0.62, 0.6, 0.66), thick.mul(0.55));
    col.assign(mix(col, cloudCol, cl.mul(0.88)));
    // sun disc on top of thin cloud
    col.addAssign(A.hfSunCol.mul(smoothstep(0.99965, 0.9999, sd)).mul(38).mul(float(1).sub(cl.mul(0.8))).mul(float(1).sub(u.hfEnv)));
    // below the horizon (environment map only): sunlit sand
    const below = rd.y.lessThan(0);
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
