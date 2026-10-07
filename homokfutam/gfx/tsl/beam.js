import * as THREE from 'three/webgpu';
import {
  Fn, If, float, vec2, vec3, vec4, attribute, positionLocal, uv, modelViewMatrix, cameraProjectionMatrix, varyingProperty,
  mix, max, clamp, pow, exp, abs, sin, cos, atan, length, cross, normalize, fract, floor, step, select, smoothstep,
} from 'three/tsl';
import { ss, h11, oneMinus } from './common.js';

// ============================================================
//  Energy beam materials for WebGPURenderer (GLSL versions and notes: gfx/beam.js). The strands are
//  camera-facing ribbons built in the vertex shader along a path between the two emitters.
// ============================================================

const jag = (x) => { const i = floor(x); return mix(h11(i), h11(i.add(1)), fract(x)).mul(2).sub(1); };
const smo = (x) => {
  const i = floor(x), f0 = fract(x), f = f0.mul(f0).mul(f0.mul(-2).add(3));
  return mix(h11(i), h11(i.add(1)), f).mul(2).sub(1);
};
// lightning-like offset: polyline noise, four octaves, re-rolled every epoch
const bolt = (u, s) => {
  let j = vec2(0), a = 1, f = 3;
  for (let k = 0; k < 4; k++) { j = j.add(vec2(jag(u.mul(f).add(s)), jag(u.mul(f).add(s).add(57))).mul(a)); a *= 0.52; f *= 2.13; }
  return j;
};

export function beamStrandMaterial(U) {
  const vSide = varyingProperty('float', 'vSide'), vU = varyingProperty('float', 'vU'), vK = varyingProperty('float', 'vK'), vA = varyingProperty('float', 'vA');
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, forceSinglePass: true, fog: false });
  m.vertexNode = Fn(() => {
    const info = attribute('aInfo', 'vec4').toVar();
    const ax0 = U.uB.sub(U.uA).toVar();
    const L0 = length(ax0).toVar();
    const ax = select(L0.greaterThan(1e-3), ax0.div(L0), vec3(1, 0, 0)).toVar();
    const L = max(L0, 1e-3).toVar();
    const N1 = normalize(cross(ax, vec3(0, 0, 1))).toVar();
    const N2 = cross(ax, N1).toVar();
    const kind = info.x, seed = info.y;
    const epoch = floor(U.uTime.mul(U.uRate).mul(select(kind.greaterThan(3.5), 1.6, 1)).add(h11(seed).mul(7))).toVar();

    const mainPath = (u, sd, ep, jagged) => {
      const p = mix(U.uA, U.uB, u);
      const env = pow(max(sin(clamp(u, 0, 1).mul(Math.PI)), 0), 0.75);
      let w = vec2(smo(u.mul(1.6).add(U.uTime.mul(3.1))), smo(u.mul(1.9).sub(U.uTime.mul(2.6)).add(5.3))).mul(U.uWobble);
      const b = bolt(u, ep.mul(17).add(sd.mul(31.7))).mul(U.uArc).mul(L).mul(0.085);
      w = w.add(jagged === true ? b : select(jagged, b, vec2(0)));
      return p.add(N1.mul(w.x).add(N2.mul(w.y)).mul(env));
    };
    // one strand's point at t; fade out along forks and whips
    const strand = (t) => {
      const p = vec3(0).toVar(), fade = float(1).toVar();
      If(kind.lessThan(2.5), () => {
        p.assign(mainPath(mix(info.z, info.w, t), seed, epoch, kind.greaterThan(1.5)));
      }).ElseIf(kind.lessThan(3.5), () => {
        // fork: leaves its parent arc somewhere along the beam and drifts off sideways
        const pe = floor(U.uTime.mul(U.uRate).add(h11(seed.sub(3)).mul(7)));
        const u0 = h11(epoch.mul(1.7).add(seed)).mul(0.62).add(0.12), len = h11(epoch.mul(2.3).add(seed)).mul(0.22).add(0.12);
        const base = mainPath(u0.add(len.mul(t)), seed.sub(3), pe, true);
        const ang = h11(epoch.mul(3.9).add(seed)).mul(6.2832);
        const off = vec2(cos(ang), sin(ang)).mul(t).mul(len).mul(L).mul(0.7).add(bolt(t, epoch.mul(5).add(seed)).mul(t).mul(0.12));
        fade.assign(oneMinus(t));
        p.assign(base.add(N1.mul(off.x)).add(N2.mul(off.y)));
      }).Else(() => {
        // whip: rooted on an emitter, flails outwards
        const left = info.z.lessThan(0.5);
        const root = select(left, U.uA, U.uB);
        const out1 = cross(N1, N2).mul(select(left, -1, 1));
        const ang = h11(epoch.mul(4.1).add(seed)).mul(6.2832);
        const dir = normalize(out1.mul(0.5).add(N1.mul(cos(ang))).add(N2.mul(sin(ang)).mul(0.8)).add(vec3(0, 0.35, 0)));
        const len = h11(epoch.mul(2.9).add(seed)).mul(0.7).add(0.35).mul(U.uWhip.mul(0.6).add(0.4));
        const j = bolt(t, epoch.mul(9).add(seed)).mul(0.16).mul(t);
        fade.assign(oneMinus(t.mul(t)));
        p.assign(root.add(dir.mul(len).mul(t)).add(N1.mul(j.x)).add(N2.mul(j.y)));
      });
      return { p, fade };
    };

    const t = positionLocal.x, side = positionLocal.y;
    const A = strand(t);
    const B = strand(t.add(select(t.greaterThan(0.99), -0.02, 0.02)));
    const mv = modelViewMatrix.mul(vec4(A.p, 1)).toVar();
    const tv0 = modelViewMatrix.mul(vec4(B.p, 1)).xyz.sub(mv.xyz).toVar();
    const tv = select(length(tv0).greaterThan(1e-6), normalize(tv0), vec3(0, 1, 0));
    const sv0 = cross(tv, normalize(mv.xyz)).toVar();
    const sv = select(length(sv0).greaterThan(1e-4), normalize(sv0), vec3(1, 0, 0));
    const w = select(kind.lessThan(0.5), U.uThick.mul(0.42), select(kind.lessThan(1.5), U.uThick.mul(0.05), select(kind.lessThan(2.5), 0.04, 0.03))).toVar();
    // keep thin strands at least ~1.3 px wide and dim them instead, so they do not shimmer
    const minW = U.uPx.mul(1.3).mul(mv.z.negate()).toVar();
    const a = A.fade.toVar();
    If(w.lessThan(minW), () => { a.mulAssign(w.div(minW)); w.assign(minW); });
    // which arcs show this epoch
    a.mulAssign(select(kind.greaterThan(1.5).and(kind.lessThan(3.5)), step(h11(epoch.mul(7.3).add(seed.mul(3.1))), U.uArcs), 1));
    a.mulAssign(select(kind.greaterThan(3.5), step(0.35, h11(epoch.mul(5.7).add(seed))).mul(U.uWhip), 1));
    vSide.assign(side);
    vU.assign(select(kind.greaterThan(2.5), t, mix(info.z, info.w, t)));
    vK.assign(kind);
    vA.assign(a);
    return cameraProjectionMatrix.mul(vec4(mv.xyz.add(sv.mul(side).mul(w)), 1));
  })();
  m.colorNode = Fn(() => {
    const x = abs(vSide).toVar();
    const a = select(vK.lessThan(0.5), exp(x.mul(x).mul(-4.5)).mul(0.55), select(vK.lessThan(1.5), pow(max(oneMinus(x), 0), 2.2), pow(max(oneMinus(x), 0), 1.6)));
    const c = select(vK.lessThan(0.5), U.uCol, select(vK.lessThan(1.5), mix(U.uCol, U.uHot, 0.8).mul(3), mix(U.uCol, U.uHot, 0.55).mul(select(vK.greaterThan(3.5), 3.2, 2.4)))).toVar();
    // energy pulses travelling from the left emitter to the right one
    const p = pow(sin(vU.mul(2.2).sub(U.uTime.mul(U.uPulse)).mul(6.2832)).mul(0.5).add(0.5), 12);
    c.mulAssign(select(vK.lessThan(1.5), p.mul(select(vK.lessThan(0.5), 1.6, 1.1)).add(1), 1));
    // re-ignition: only the part up to the travelling head is lit, the head itself flares
    const head = oneMinus(smoothstep(0, 0.08, abs(vU.sub(U.uReach))));
    const relit = step(vU, U.uReach.add(0.02)).mul(head.mul(4).mul(step(U.uReach, 0.99)).add(1)).mul(U.uOn);
    const on = select(vK.greaterThan(3.5), 1, relit);
    return c.mul(a).mul(vA).mul(on).mul(U.uI).mul(U.uFlicker);
  })();
  m.uniforms = U;
  return m;
}

// emitter flares of every pod in one draw (gfx/fxbatch.js): aFx = size, brightness, rotation
export function beamFlareMaterial() {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  m.vertexNode = Fn(() => {
    const mv = modelViewMatrix.mul(vec4(attribute('iBB', 'vec4').xyz, 1)).toVar();     // (fxbatch.js billboard batch)
    mv.xyz.addAssign(normalize(mv.xyz.negate()).mul(0.6));        // pull towards the camera so the engine does not clip it
    return cameraProjectionMatrix.mul(vec4(mv.xy.add(positionLocal.xy.mul(attribute('aFx', 'vec3').x)), mv.z, 1));
  })();
  m.colorNode = Fn(() => {
    const fx = attribute('aFx', 'vec3'), col = attribute('aCol', 'vec3'), hot = attribute('aHot', 'vec3');
    const c2 = uv().sub(0.5).mul(2).toVar();
    const r = length(c2).toVar();
    const ang = atan(c2.y, c2.x), rot = fx.z;
    const core = exp(r.mul(-14)).mul(3).add(exp(r.mul(r).mul(-9)).mul(0.5)).toVar();
    const rays = pow(abs(cos(ang.mul(2).add(rot))), 40).add(pow(abs(cos(ang.mul(3).sub(rot.mul(1.7)).add(0.7))), 60).mul(0.6)).mul(exp(r.mul(-3.2)));
    return mix(col, hot, clamp(core.mul(0.4), 0, 1)).mul(core.add(rays.mul(0.9))).mul(fx.y).mul(ss(1, 0.6, r));
  })();
  return m;
}
