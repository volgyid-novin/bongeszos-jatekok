import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, vec4, uv, attribute, positionLocal, positionGeometry, positionPrevious, positionWorld,
  cameraPosition, cameraProjectionMatrix, modelViewMatrix, normalView, normalWorldGeometry, positionViewDirection, instanceIndex,
  mix, max, min, clamp, pow, exp, abs, sin, length, dot, cross, normalize, fract, floor, step, select, smoothstep, fwidth, texture,
} from 'three/tsl';
import { ATMO } from '../atmosphere.js';
import { hfStaticShadow } from './atmosphere.js';
import { sunAt } from './particles.js';
import { ss, oneMinus } from './common.js';

// ============================================================
//  World dressing materials for WebGPURenderer: crowd sprites, cloth sway, chase lamps, dust devils
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
    const stand = max(wave, smoothstep(0.2, 0.6, U.uCheer).mul(step(0.35, fract(seed.mul(7.3)))));
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
  copy(source) { this.cloth = source.cloth; return super.copy(source); }
}
export function clothNodeMaterial(params, U) {
  const m = new ClothMaterial(params);
  m.cloth = U;
  return m;
}

// --- sequenced chase lights along the open sections (iPos: lamp position + metres along the track) ---
export function chaseLampMaterial(U) {
  const m = new THREE.MeshBasicNodeMaterial({ fog: false });
  const iPos = attribute('iPos', 'vec4');
  m.positionNode = positionLocal.add(iPos.xyz);
  m.colorNode = Fn(() => {
    const ph = fract(iPos.w.div(60).sub(U.uTime.mul(1.6)));
    return vec3(1, 0.45, 0.12).mul(pow(smoothstep(0.86, 1, ph), 2).add(0.12)).mul(U.uK);
  })();
  m.uniforms = U;
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
    return mix(A.hfFogCol.mul(0.55), A.hfSunCol.mul(1.5), lit).mul(phase);
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
