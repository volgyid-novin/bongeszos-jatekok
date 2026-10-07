import { Fn, float, vec2, vec3, floor, fract, mix, min, max, abs, exp, cos, step, length, dot, smoothstep, select } from 'three/tsl';
import { GUST, WIND_DIR, WAKE, WAKE_N } from '../wind.js';

// ============================================================
//  One wind for the node materials: hfGust(xz, t), 0 in a lull and up to 1 in a gust's core.
//  The same model and constants as gust() and GUST_GLSL in gfx/wind.js (notes there).
// ============================================================
const h11 = (p) => {
  const a = fract(p.mul(0.1031)).toVar();
  a.mulAssign(a.add(33.33));
  a.mulAssign(a.add(a));
  return fract(a);
};
const n11 = (x) => {
  const i = floor(x), f = fract(x);
  return mix(h11(i), h11(i.add(1)), f.mul(f).mul(f.mul(-2).add(3)));
};

export const hfGust = Fn(([p, t]) => {
  const W = vec2(WIND_DIR.x, WIND_DIR.y);
  const a = dot(p, W).toVar(), c = p.y.mul(W.x).sub(p.x.mul(W.y)).toVar();
  let g = float(0);
  GUST.FRONTS.forEach(([P, w, amp, ph], k) => {
    const u = t.div(P).sub(a.div(GUST.V * P)).add(ph).add(n11(c.div(GUST.BEND).add(k * 7.1)).sub(0.5).mul(0.6)).toVar();
    const cyc = floor(u), x = fract(u).div(w).toVar();
    const pulse = select(x.lessThan(1), smoothstep(0, 0.25, x).mul(float(1).sub(smoothstep(0.25, 1, x))), 0);
    const s = smoothstep(0.28, 0.72, n11(c.div(GUST.SEG).add(cyc.mul(3.71)).add(k * 17.3))).mul(h11(cyc.mul(1.37).add(k * 9.1)).mul(0.45).add(0.55));
    g = g.add(s.mul(pulse).mul(amp));
  });
  return min(g, 1);
}).setLayout({ name: 'hfGust', type: 'float', inputs: [{ name: 'p', type: 'vec2' }, { name: 't', type: 'float' }] });

// pods disturb the world (E7): the wake of the n nearest pods at wp (vec3): (push x, push z, the corridor's core);
// unrolled over the pods (the GLSL version and notes: WAKE_GLSL in gfx/wind.js)
export function hfWake(wp, n = WAKE_N) {
  let push = vec2(0), clear = float(0);
  for (let k = 0; k < n; k++) {
    const p = WAKE.hfWakeP.element(k), v = WAKE.hfWakeV.element(k);
    const rel = wp.xz.sub(p.xz).toVar();
    const along = dot(rel, v.xy).negate().toVar();
    const latV = rel.add(v.xy.mul(along)).toVar();
    const lat = length(latV), h = abs(wp.y.sub(p.y));
    const w = max(along, 0).mul(0.3).add(3.5), t = max(along, 0).div(max(v.z, 5)).toVar();
    const behind = step(0, along);
    const ring = exp(t.mul(-2.2)).mul(cos(t.mul(8))).mul(behind);
    const core = exp(lat.mul(lat).div(w.mul(w)).negate()).mul(exp(h.mul(h).div(-30))).toVar();
    push = push.add(v.xy.mul(-0.8).add(latV.div(max(lat, 1e-3)).mul(0.5)).mul(ring).mul(core).mul(p.w));
    const bow = exp(dot(rel, rel).div(-60)).mul(0.6).mul(p.w).mul(float(1).sub(behind));
    push = push.add(rel.div(max(length(rel), 1e-3)).mul(bow));
    clear = clear.add(core.mul(exp(t.mul(-1.5))).mul(behind).mul(p.w));
  }
  return vec3(push, clear);
}
