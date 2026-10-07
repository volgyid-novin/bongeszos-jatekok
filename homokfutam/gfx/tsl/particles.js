import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, vec4, attribute, positionGeometry, positionPrevious, modelViewMatrix, cameraProjectionMatrix, cameraViewMatrix,
  varyingProperty, cameraPosition, mix, max, min, clamp, sqrt, abs, sin, cos, length, dot, normalize, floor, fract, mod, step, select, smoothstep,
} from 'three/tsl';
import { ATMO } from '../atmosphere.js';
import { hfApplyFog, hfFogFactor, hfFogTint } from './atmosphere.js';
import { ss, oneMinus } from './common.js';

// ============================================================
//  Particle materials for WebGPURenderer (GLSL version and notes: gfx/particles.js). Instanced
//  camera-facing quads: iPos (centre), iData (size, rotation, alpha, atlas cell), iCol (rgb, ground
//  height), iVel. The quad is built in view space in the vertex stage; the centre is the vertex
//  position the velocity buffer (TRAA) sees.
// ============================================================

// sun visibility at a world point from the baked world shadow (one tap, as the GLSL does per vertex)
const sunAt = (p) => {
  const sc = ATMO.hfShadowMatrix.mul(vec4(p, 1)).xyz.toVar();
  const inside = step(0, sc.x).mul(step(sc.x, 1)).mul(step(0, sc.y)).mul(step(sc.y, 1));
  return mix(1, ATMO.hfShadowMap.sample(sc.xy).compare(sc.z.sub(0.001)), inside.mul(ATMO.hfShadowOn));
};
export { sunAt };

// kind: { spark, add, confetti, flip, fire }; U: the uniform nodes (gfx/particles.js)
export function particleMaterial(K, U, params) {
  const m = new THREE.MeshBasicNodeMaterial({ fog: false, ...params });
  const vUv = varyingProperty('vec2', 'pUv'), vUv1 = varyingProperty('vec2', 'pUv1'), vCorner = varyingProperty('vec2', 'pCorner');
  const vCol = varyingProperty('vec4', 'pCol'), vAlpha = varyingProperty('float', 'pAlpha'), vFragY = varyingProperty('float', 'pFragY');
  const vBlend = varyingProperty('float', 'pBlend'), vLight = varyingProperty('vec3', 'pLight'), vCenter = varyingProperty('vec3', 'pCenter');
  const iPos = attribute('iPos', 'vec3'), iData = attribute('iData', 'vec4');

  // the centre: what the velocity pass reprojects (the quad's own spin and size are left out)
  m.positionNode = Fn((builder) => {
    if (builder.needsPreviousData()) positionPrevious.assign(iPos);
    return iPos;
  })();
  m.vertexNode = Fn(() => {
    const c = positionGeometry.xy.toVar();
    vCorner.assign(c.mul(2));
    const cell = floor(iData.w).toVar();
    vUv.assign(c.add(0.5).mul(0.5).add(vec2(mod(cell, 2), floor(cell.div(2))).mul(0.5)));
    if (K.flip) {
      // the frame follows the particle's age; neighbouring frames cross-fade
      const f = fract(iData.w).mul(U.uSpan).mul(U.uFrames.sub(1)).toVar();
      const f0 = floor(f).toVar();
      vBlend.assign(f.sub(f0));
      const base = mod(cell, U.uVariants).mul(U.uFrames).toVar();
      const lc = mix(vec2(0.004), vec2(0.996), c.add(0.5)).toVar();
      const flipUv = (idx) => vec2(mod(idx, 8).add(lc.x), floor(idx.div(8)).add(1).sub(lc.y)).div(8);
      vUv.assign(flipUv(base.add(f0)));
      vUv1.assign(flipUv(base.add(min(f0.add(1), U.uFrames.sub(1)))));
      // the sun in the particle's own (rotated) frame: x = towards the right of the image, y = up
      const sv = normalize(cameraViewMatrix.mul(vec4(ATMO.hfSunDir, 0)).xyz).toVar();
      const rs = sin(iData.y), rc = cos(iData.y);
      vLight.assign(vec3(dot(sv.xy, vec2(rc, rs)), dot(sv.xy, vec2(rs.negate(), rc)), sv.z));
    }
    const mv = modelViewMatrix.mul(vec4(iPos, 1)).toVar();
    if (K.spark) {
      const m1 = modelViewMatrix.mul(vec4(iPos.sub(attribute('iVel', 'vec3').mul(U.uStretch)), 1));
      const d = mv.xy.sub(m1.xy).toVar();
      const len = max(length(d), iData.x).toVar();
      const dir = select(len.greaterThan(1e-4), d.div(len), vec2(0, 1)).toVar();
      const side = vec2(dir.y.negate(), dir.x);
      mv.xy.addAssign(side.mul(c.x).mul(iData.x).add(dir.mul(c.y.sub(0.5)).mul(len)));
    } else {
      const s = sin(iData.y), co = cos(iData.y);
      mv.xy.addAssign(vec2(c.x.mul(co).sub(c.y.mul(s)), c.x.mul(s).add(c.y.mul(co))).mul(iData.x));
    }
    vFragY.assign(iPos.y.add(c.y.mul(iData.x)));
    vCol.assign(attribute('iCol', 'vec4'));
    vAlpha.assign(iData.z);
    vCenter.assign(iPos);
    return cameraProjectionMatrix.mul(mv);
  })();

  let rgb, alpha;
  const soft = () => smoothstep(0, 1.2, vFragY.sub(vCol.a));
  if (K.flip) {
    const tx = mix(U.uFlip.sample(vUv), U.uFlip.sample(vUv1), vBlend).toVar();
    const L = tx.rgb.mul(tx.rgb).toVar();
    const a = tx.a.mul(soft()).toVar();
    const top = K.fire ? L.r.add(L.g).mul(0.5) : L.b;
    // "6-way" lighting cut down to right / left / top; the bottom borrows from the sides, a sun behind
    // the camera lights everything, a sun behind the puff shines through its thin edges
    const l = vLight;
    const lit = L.r.mul(max(l.x, 0)).add(L.g.mul(max(l.x.negate(), 0))).add(top.mul(max(l.y, 0))).add(min(L.r, L.g).mul(0.5).mul(max(l.y.negate(), 0)))
      .add(L.r.add(L.g).add(top).mul(0.33).mul(max(l.z, 0))).add(oneMinus(tx.a).mul(0.8).mul(max(l.z.negate(), 0)));
    const col = vCol.rgb.mul(U.uAmbient.mul(L.r.add(L.g).add(top).mul(0.33).mul(0.45).add(0.55)).add(U.uSunCol.mul(lit).mul(sunAt(vCenter.add(ATMO.hfSunDir.mul(2)))).mul(1.25)));
    const on = U.uFlipOn.greaterThan(0.5);
    // flipbooks still loading: a plain soft puff
    const pa = ss(1, 0.15, length(vCorner)).mul(0.6).mul(vAlpha);
    if (K.fire) {
      // flame: deep red where it is thin, through orange to a yellow-white core (premultiplied)
      const E = L.b;
      const flame = mix(U.uFlame0, U.uFlame1, smoothstep(0.2, 0.85, E)).mul(E.mul(E).mul(1.2).add(E.mul(E).mul(E).mul(3))).mul(1.6).mul(U.uEmit);
      rgb = select(on, col.mul(a).mul(vAlpha).add(flame.mul(vAlpha)), vCol.rgb.mul(U.uAmbient).add(U.uFlame1.mul(2)).mul(pa));
      alpha = select(on, a.mul(vAlpha), pa);
    } else {
      rgb = select(on, col, vCol.rgb.mul(U.uAmbient).mul(1.4));
      alpha = select(on, a.mul(vAlpha), pa);
    }
  } else if (K.spark) {
    const a = oneMinus(abs(vCorner.x)).mul(smoothstep(-1, -0.2, vCorner.y));
    rgb = vCol.rgb.mul(a).mul(vAlpha); alpha = float(1);
  } else if (K.add) {
    const a = U.uMap.sample(vUv).a.mul(oneMinus(smoothstep(0.4, 1, length(vCorner))));
    rgb = vCol.rgb.mul(a).mul(vAlpha); alpha = float(1);
  } else if (K.confetti) {
    m.maskNode = max(abs(vCorner.x), abs(vCorner.y)).lessThanEqual(0.9);
    rgb = vCol.rgb.mul(U.uAmbient.add(U.uSunCol.mul(0.6))); alpha = vAlpha;
  } else {
    const a = U.uMap.sample(vUv).a.mul(soft());
    // light the puff like a sphere: view-space normal from the quad corner
    const q = vCorner;
    const n = normalize(vec3(q, sqrt(max(oneMinus(dot(q, q)), 0.05))));
    const sunV = normalize(cameraViewMatrix.mul(vec4(ATMO.hfSunDir, 0)).xyz);
    const lam = clamp(dot(n, sunV).mul(0.5).add(0.55), 0, 1);
    rgb = vCol.rgb.mul(U.uAmbient.add(U.uSunCol.mul(lam).mul(sunAt(vCenter.add(ATMO.hfSunDir.mul(2)))))); alpha = a.mul(vAlpha);
  }
  // the height fog at the particle's centre: additive ones fade, premultiplied ones fade towards the fog by their coverage
  if (K.add || K.spark) rgb = rgb.mul(oneMinus(hfFogFactor(vCenter)));
  else if (K.fire) rgb = mix(rgb, hfFogTint(normalize(vCenter.sub(cameraPosition))).mul(alpha), hfFogFactor(vCenter));
  else rgb = hfApplyFog(rgb, vCenter);
  m.colorNode = rgb;
  m.opacityNode = alpha;
  m.uniforms = U;
  return m;
}
