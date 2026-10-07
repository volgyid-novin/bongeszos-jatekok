import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, float, vec2, vec3, vec4, uniform, uv, attribute, positionLocal, cameraPosition, cameraProjectionMatrix,
  modelViewMatrix, modelWorldMatrixInverse, normalView, positionViewDirection, screenCoordinate,
  mix, max, min, clamp, pow, exp, abs, sqrt, sin, cos, atan, length, dot, normalize, fract, floor, step, select, smoothstep,
} from 'three/tsl';
import { ATMO } from '../atmosphere.js';
import { ss, oneMinus } from './common.js';

// ============================================================
//  Pod effect materials for WebGPURenderer (the GLSL versions and their notes: gfx/podfx.js).
//  Each returns a node material with .uniforms holding the uniform nodes the CPU side drives.
// ============================================================

const cloud = (p) => ATMO.hfCloudTex.sample(p).r;
const fxMat = (Cls, params) => {
  const m = new Cls({ transparent: true, depthWrite: false, fog: false, ...params });
  m.lights = false;
  return m;
};

// --- volumetric plume: raymarched through its box (-1..1, -1..1, -1..0 in the box's own space) ---
const h31 = Fn(([p0]) => {
  const p = fract(p0.mul(0.3183099).add(0.1)).mul(17).toVar();
  return fract(p.x.mul(p.y).mul(p.z).mul(p.x.add(p.y).add(p.z)));
}).setLayout({ name: 'hfH31', type: 'float', inputs: [{ name: 'p0', type: 'vec3' }] });
const vn3 = Fn(([x]) => {
  const i = floor(x).toVar(), f0 = fract(x);
  const f = f0.mul(f0).mul(f0.mul(-2).add(3)).toVar();
  const h = (dx, dy, dz) => h31(i.add(vec3(dx, dy, dz)));
  return mix(mix(mix(h(0, 0, 0), h(1, 0, 0), f.x), mix(h(0, 1, 0), h(1, 1, 0), f.x), f.y),
    mix(mix(h(0, 0, 1), h(1, 0, 1), f.x), mix(h(0, 1, 1), h(1, 1, 1), f.x), f.y), f.z);
}).setLayout({ name: 'hfVn3', type: 'float', inputs: [{ name: 'x', type: 'vec3' }] });

export function volumePlumeMaterial(U, steps) {
  const m = fxMat(THREE.MeshBasicNodeMaterial, { blending: THREE.AdditiveBlending, side: THREE.FrontSide });
  m.colorNode = Fn(() => {
    const ro = modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz.toVar();
    const rd = normalize(positionLocal.sub(ro)).toVar();
    // where the view ray enters and leaves the box
    const inv = float(1).div(rd.add(1e-6));
    const t0 = vec3(-1).sub(ro).mul(inv), t1 = vec3(1, 1, 0).sub(ro).mul(inv);
    const tmin = min(t0, t1).toVar(), tmax = max(t0, t1).toVar();
    const tStart = max(max(max(tmin.x, tmin.y), tmin.z), 0).toVar();
    const tEnd = min(min(tmax.x, tmax.y), tmax.z);
    const dt = max(tEnd.sub(tStart), 0).div(steps).toVar();
    const wlen = length(rd.mul(U.uScale)).mul(dt).toVar();              // world metres per step
    const jit = h31(vec3(screenCoordinate.xy, U.uTime.mul(60))).toVar();
    const acc = vec3(0).toVar();
    const I = U.uThr.mul(0.9).add(U.uBoost.mul(0.8)).add(U.uIgn.mul(2.5)).add(0.25).mul(oneMinus(U.uSput.mul(0.85))).toVar();
    Loop(steps, ({ i }) => {
      const p = ro.add(rd.mul(tStart.add(float(i).add(jit).mul(dt)))).toVar();
      const z = clamp(p.z.negate(), 0, 1).toVar();                      // 0 at the nozzle, 1 at the tip
      const R = mix(0.62, 1, sqrt(z));                                   // the jet widens downstream
      const r = length(p.xy).div(R).toVar();
      If(r.lessThanEqual(1), () => {
        // turbulence, carried downstream
        const q = vec3(p.xy.mul(2.2), z.mul(5).sub(U.uTime.mul(9))).add(U.uSeed).toVar();
        const n = vn3(q).mul(0.65).add(vn3(q.mul(2.3).add(7.1)).mul(0.35));
        const core = exp(r.mul(r).negate().mul(z.mul(2).add(3.5))).toVar();
        const body = core.mul(pow(oneMinus(z), 1.4)).mul(n.mul(0.9).mul(smoothstep(0, 0.35, z)).add(0.55).add(oneMinus(smoothstep(0, 0.3, z)).mul(0.45)));
        // temperature: hottest in the core near the nozzle
        const T = clamp(oneMinus(z.mul(1.25)).mul(core.mul(0.6).add(0.4)).add(U.uBoost.mul(0.25)), 0, 1).toVar();
        const c = mix(mix(U.uCool, U.uMid, smoothstep(0.05, 0.45, T)), U.uHot, smoothstep(0.55, 0.9, T));
        // boost: a blue-white Mach core with standing shock diamonds
        const mach = U.uBoost.mul(exp(r.mul(r).mul(-22))).mul(ss(0.75, 0.05, z))
          .mul(pow(max(cos(z.mul(30)).mul(0.5).add(0.5), 0), 8).mul(1.6).add(0.35));
        acc.addAssign(c.mul(body).mul(I).add(U.uCore.mul(mach).mul(2.2)).mul(wlen));
      });
    });
    acc.mulAssign(select(U.uOver.greaterThan(0.5), step(0.5, fract(U.uTime.mul(9).add(U.uSeed))).mul(0.65).add(0.35), 1));
    // looking down the jet integrates metres of flame: compress so it stays a hot core, not a white-out
    acc.mulAssign(0.75);
    return acc.div(dot(acc, vec3(0.33)).mul(0.45).add(1));
  })();
  m.uniforms = U;
  return m;
}

// --- exhaust plume without post-processing: an open cone, brightest through its core ---
export function conePlumeMaterial(U) {
  const m = fxMat(THREE.MeshBasicNodeMaterial, { blending: THREE.AdditiveBlending, side: THREE.DoubleSide, forceSinglePass: true });
  m.colorNode = Fn(() => {
    const p = uv();
    const along = oneMinus(p.y).toVar();                       // 0 at the nozzle, 1 at the tip
    const core = pow(abs(dot(normalView, positionViewDirection)), 1.8).toVar();
    const n = cloud(vec2(p.x.mul(2).add(U.uSeed), along.mul(0.7).sub(U.uTime.mul(2.6))));
    const n2 = cloud(vec2(p.x.mul(3).sub(U.uSeed), along.mul(1.3).sub(U.uTime.mul(4.1))));
    const flick = n.mul(n2).mul(0.7).add(0.65);
    const body = core.mul(pow(clamp(oneMinus(along), 0, 1), 1.6)).mul(flick);
    // shock diamonds when boosting
    const dia = U.uBoost.mul(pow(max(cos(along.mul(34).sub(U.uTime.mul(6))).mul(0.5).add(0.5), 0), 6)).mul(ss(0.75, 0.05, along)).mul(core);
    const col = mix(mix(U.uCool, U.uMid, ss(0.85, 0.3, along)), U.uHot, ss(0.35, 0, along).mul(core));
    const I = U.uThr.mul(1.1).add(U.uBoost.mul(1.6)).add(0.35)
      .mul(select(U.uOver.greaterThan(0.5), step(0.5, fract(U.uTime.mul(9).add(U.uSeed))).mul(0.6).add(0.4), 1));
    return col.mul(body.mul(I).mul(2.4).add(dia.mul(5)));
  })();
  m.uniforms = U;
  return m;
}

// --- batched throats and ground decals (gfx/fxbatch.js; aFx = the per-instance values) ---
export function throatMaterial(U) {
  const m = fxMat(THREE.MeshBasicNodeMaterial, { blending: THREE.AdditiveBlending });
  m.colorNode = Fn(() => {
    const fx = attribute('aFx', 'vec3');
    const k = fx.x, boost = fx.y, seed = fx.z;
    const c = uv().sub(0.5).mul(2).toVar();
    const r = length(c).toVar();
    r.greaterThan(1).discard();
    const ring = exp(pow(r.sub(0.78).div(0.13), 2).negate());
    const flick = sin(U.uTime.mul(63).add(seed).add(atan(c.y, c.x).mul(3))).mul(0.15).add(0.85);
    const core = exp(r.mul(r).mul(-5));
    return U.uRing.mul(ring).mul(1.6).mul(flick).add(mix(U.uRing.mul(1.2), U.uCore.mul(2.2), boost).mul(core)).add(U.uRing.mul(0.35)).mul(k);
  })();
  m.uniforms = U;
  return m;
}
export function glowDecalMaterial(U, params) {
  const m = fxMat(THREE.MeshBasicNodeMaterial, params);
  m.colorNode = Fn(() => {
    const fx = attribute('aFx', 'vec3');
    const c = uv().sub(0.5).mul(vec2(1, 1.4));
    const r = length(c).mul(2).toVar();
    const pool = exp(r.mul(r).mul(-3));
    const rings = pow(max(sin(r.mul(26).sub(U.uTime.mul(14)).add(fx.y)).mul(0.5).add(0.5), 0), 6).mul(ss(1, 0.3, r)).mul(0.35);
    return U.uCol.mul(pool.add(rings)).mul(fx.x);
  })();
  m.uniforms = U;
  return m;
}
export function shadowDecalMaterial(params) {
  const m = fxMat(THREE.MeshBasicNodeMaterial, params);
  m.colorNode = vec3(0);
  m.opacityNode = Fn(() => {
    const c = uv().sub(0.5).mul(2);
    const a = ss(1, 0.1, length(c.mul(vec2(1, 0.75))));
    return a.mul(a).mul(attribute('aFx', 'vec3').x);
  })();
  m.uniforms = {};
  return m;
}

// --- trail map stamps (gfx/podfx.js createTrailMap): iRect = (u0, v0, du, dv), iCol = (groove, scorch).
// Plain per-instance attributes, not an InstancedMesh, whose colours TSL refreshes once per frame
// (the map can be drawn several times in one frame when the race is fast-forwarded) ---
export function trailStampMaterial() {
  const m = fxMat(THREE.MeshBasicNodeMaterial, { blending: THREE.AdditiveBlending, depthTest: false });
  const r = attribute('iRect', 'vec4');
  m.positionNode = vec3(r.xy.add(positionLocal.xy.mul(r.zw)), 0);
  m.colorNode = vec3(attribute('iCol', 'vec2'), 0);
  return m;
}

// --- all heat quads in one draw (HeatLayer on WebGPURenderer): iHeat = (world position, size),
// iHeatK = (strength, ring) ---
export function heatBatchMaterial(time) {
  const m = fxMat(THREE.MeshBasicNodeMaterial, { depthTest: false, blending: THREE.NormalBlending });
  const iHeat = attribute('iHeat', 'vec4'), k = attribute('iHeatK', 'vec2');
  m.vertexNode = Fn(() => {
    const mv = modelViewMatrix.mul(vec4(iHeat.xyz, 1)).toVar();
    return cameraProjectionMatrix.mul(vec4(mv.xy.add(positionLocal.xy.mul(iHeat.w)), mv.z, 1));
  })();
  const ring = k.y.greaterThan(0.5);
  const p = uv(), c = p.sub(0.5), r = length(c).mul(2);
  const n = vec2(cloud(p.mul(1.7).add(vec2(0, time.mul(-1.8)))), cloud(p.mul(1.7).add(vec2(0.5, time.mul(-2.3)))));
  m.colorNode = vec3(select(ring, normalize(c.add(1e-4)).mul(0.5), n.sub(0.5)).mul(0.5).add(0.5), 0);
  m.opacityNode = select(ring, ss(0.12, 0, abs(r.sub(0.82))), ss(1, 0.2, r)).mul(k.x);
  return m;
}
