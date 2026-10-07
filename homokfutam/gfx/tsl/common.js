import { Fn, float, vec3, vec4, smoothstep, dot, fract, sin } from 'three/tsl';

// ============================================================
//  Small TSL helpers shared by the node materials.
// ============================================================

// smoothstep that also takes falling edges (a > b), as GLSL code here often writes it; WGSL leaves
// smoothstep with low > high undefined
export const ss = (a, b, x) => (typeof a === 'number' && typeof b === 'number' && a > b ? float(1).sub(smoothstep(b, a, x)) : smoothstep(a, b, x));
export const lum = (c) => dot(c, vec3(0.2126, 0.7152, 0.0722));
export const oneMinus = (x) => float(1).sub(x);

// Hoskins, hash without sine
export const hash4 = Fn(([p]) => {
  const p4 = fract(p.xyxy.mul(vec4(0.1031, 0.1030, 0.0973, 0.1099))).toVar();
  p4.addAssign(dot(p4, p4.wzxy.add(33.33)));
  return fract(p4.xxyz.add(p4.yzzw).mul(p4.zywx));
});
export const hash12 = Fn(([p]) => {
  const p3 = fract(vec3(p.xyx).mul(0.1031)).toVar();
  p3.addAssign(dot(p3, p3.yzx.add(33.33)));
  return fract(p3.x.add(p3.y).mul(p3.z));
});
// 1D hash and value noise as the beam shader writes them
export const h11 = (n) => fract(sin(n.mul(12.9898).add(4.1414)).mul(43758.5453));
