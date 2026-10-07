import { Fn, If, float, vec2, vec3, min, max, clamp, dot, exp2, mix, step } from 'three/tsl';
import { GIU } from '../gi.js';

// The baked light (?gfx=gi:1, docs/visual-next-steps.md D4) for the node materials: E(n) / E_open(n)
// at world position wp for world normal n (RGB), 1 outside the volumes. GLSL version and the data
// layout: gfx/gi.js.
export const hfGI = Fn(([wp, n]) => {
  const out = vec3(1).toVar();
  If(GIU.hfGIOn.greaterThan(0.5), () => {
    const sum = vec3(0).toVar(), ws = float(0).toVar();
    const refs = [GIU.hfGIRef0, GIU.hfGIRef1, GIU.hfGIRef2];
    for (let b = 0; b < GIU.O.length; b++) {
      const O = GIU.O[b], A = GIU.A[b], S = GIU.S[b];
      // a cell and a half out along the normal: off the surface, into the air the bake saw
      const d = wp.add(n.mul(1.5)).sub(O.xyz).toVar();
      const c = vec3(dot(d.xz, A.xy).mul(A.z), d.y.mul(A.w), dot(d.xz, vec2(A.y.negate(), A.x)).mul(S.x)).toVar();
      const e = min(c, S.yzw.sub(c));
      const w = clamp(min(e.x, min(e.y, e.z)), 0, 1).mul(step(0.5, S.y)).toVar();
      If(w.greaterThan(0), () => {
        const cc = clamp(c, vec3(0.5), S.yzw.sub(0.5)).toVar();
        const T = vec3(0).toVar();
        for (let ch = 0; ch < 3; ch++) {
          const p = vec3(cc.z.add(GIU.hfGIDim.x.mul(ch)), cc.y, cc.x.add(O.w)).div(GIU.hfGIDim.yzw);
          const t = GIU.hfGITex.sample(p).level(0);
          const E = exp2(t.x.mul(10).sub(8)).mul(max(dot(t.yzw.mul(2).sub(1), n).mul(2).add(1), 0.03));
          T['xyz'[ch]].assign(E.div(max(dot(refs[ch], n).add(1), 0.03)));
        }
        sum.addAssign(T.mul(w));
        ws.addAssign(w);
      });
    }
    const T = sum.div(max(ws, 1e-4));
    out.assign(mix(vec3(1), min(T, vec3(4)), min(ws, 1).mul(GIU.hfGIK)));
  });
  return out;
});
