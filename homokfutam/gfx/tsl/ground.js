import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, Break, float, int, vec2, vec3, vec4, mix, max, min, clamp, abs, pow, sqrt, exp, dot, normalize, length, fract, floor, sin, cos,
  uniformArray,
  select, smoothstep, step, saturate, dFdx, dFdy, property, attribute, positionWorld, cameraPosition, cameraViewMatrix,
  normalWorldGeometry, faceDirection, materialColor, vertexColor, normalView, positionViewDirection, roughness,
} from 'three/tsl';
import { ATMO } from '../atmosphere.js';
import { GI_ON } from '../gi.js';
import { hfGI } from './gi.js';
import { GU, POM_DEPTH } from '../ground.js';
import { ss, lum, hash4, oneMinus } from './common.js';

// ============================================================
//  Ground and rock surfaces as node materials (WebGPURenderer); the GLSL versions and the notes on
//  what each part does are in gfx/ground.js. The surface is computed once per fragment into a few
//  shader properties (albedo, world normal, roughness, occlusion, glint), which the material's
//  colour, normal, roughness and AO nodes then read.
// ============================================================
const NL = 7;
const TILE = GU.gTile.value, AXIS = GU.gAxis.value, TINT = GU.gTint.value;
const WIND = GU.gWind.value;
const V2 = (v) => vec2(v.x, v.y);

// per-fragment results of the surface function
const sAlb = property('vec3', 'gAlb'), sNW = property('vec3', 'gNW'), sRough = property('float', 'gRough');
const sAO = property('float', 'gAO'), sGlint = property('vec3', 'gGlintK'), sPomSh = property('float', 'gPomSh');

const cloud = (uv) => ATMO.hfCloudTex.sample(uv).r;
const macUv = (xz) => xz.sub(GU.gMacXf.xy).mul(GU.gMacXf.z);
const macOn = () => GU.gMacXf.w.greaterThan(0.5);
const gMacro = (xz) => select(macOn(), GU.gMac.sample(macUv(xz)), vec4(1, 0.5, 0, 0));
const gMacro2 = (xz) => select(macOn(), GU.gMac2.sample(macUv(xz)), vec4(0));

// world-space geometric normal, facing the viewer on back faces
function geoNormal(material) {
  if (material.flatShading) return normalize(positionWorld.dFdx().cross(positionWorld.dFdy())).toVar('hfGN');
  return normalWorldGeometry.mul(faceDirection).toVar('hfGN');
}

// one layer in its own frame, anti-tiled (two lookups at offsets that change with a slow noise)
function gFetch(i, p, dpx, dpy, rnd, tile, GQ) {
  const inv = typeof tile === 'number' ? 1 / tile : float(1).div(tile);
  const uv = p.mul(inv), dx = dpx.mul(inv), dy = dpy.mul(inv);
  const C = (o) => GU.gC.sample(uv.add(o)).depth(int(i)).grad(dx, dy);
  const N = (o) => GU.gN.sample(uv.add(o)).depth(int(i)).grad(dx, dy);
  if (GQ > 0) {
    const l = rnd.mul(5).add(i * 1.37);
    const f = fract(l), ia = floor(l);
    const oa = sin(vec2(3, 7).mul(ia)).toVar(), ob = sin(vec2(3, 7).mul(ia.add(1))).toVar();
    const ca = C(oa).toVar(), cb = C(ob).toVar();
    const k = smoothstep(0.3, 0.7, f.add(cb.a.sub(ca.a).mul(0.35))).toVar();
    return { c: mix(ca, cb, k), n: mix(N(oa), N(ob), k) };
  }
  return { c: C(vec2(0)), n: N(vec2(0)) };
}

// blended surface of the layers with weight > 0 (w: one node per layer, null = never used)
// tr: the track's own frame { a, b, p, tile } for the packed layer (4), so its grooves follow the track
// off: world-xz offset to look the layers up at (parallax occlusion, gParallax); the mip level stays the surface's own
function gBlend(w, xz, rnd, tr, GQ, off = null) {
  const dxz = dFdx(xz).toVar(), dyz = dFdy(xz).toVar();
  const dtx = tr ? dFdx(tr.p).toVar() : null, dty = tr ? dFdy(tr.p).toVar() : null;
  if (off) {
    xz = xz.add(off).toVar();
    if (tr) tr = { ...tr, p: tr.p.add(vec2(dot(off, tr.a), dot(off, tr.b))).toVar() };
  }
  const cs = [], ns = [], hs = [];
  const hmax = float(0).toVar();
  for (let i = 0; i < NL; i++) {
    if (!w[i]) continue;
    cs[i] = vec4(0).toVar(); ns[i] = vec4(0.5, 0.5, 1, 1).toVar(); hs[i] = float(0).toVar();
    If(w[i].greaterThan(0.004), () => {
      let f;
      if (i === 4 && tr) f = gFetch(4, tr.p, dtx, dty, rnd, tr.tile, GQ);
      else {
        const b = V2(AXIS[i]), a = vec2(-AXIS[i].y, AXIS[i].x);
        f = gFetch(i, vec2(dot(xz, a), dot(xz, b)), vec2(dot(dxz, a), dot(dxz, b)), vec2(dot(dyz, a), dot(dyz, b)), rnd, TILE[i], GQ);
      }
      cs[i].assign(f.c); ns[i].assign(f.n);
      hs[i].assign(w[i].mul(cs[i].a.add(0.35)));
      hmax.assign(max(hmax, hs[i]));
    });
  }
  const s = { alb: vec3(0).toVar(), nd: vec2(0).toVar(), rough: float(0).toVar(), ao: float(0).toVar(), h: float(0).toVar(), sand: float(0).toVar() };
  const tot = float(0).toVar(), cut = hmax.sub(0.1).toVar();
  for (let i = 0; i < NL; i++) {
    if (!w[i]) continue;
    const b = select(w[i].greaterThan(0.004), max(hs[i].sub(cut), 0), 0).toVar();
    const t = ns[i].xy.mul(2).sub(1);
    let ax, bx;
    if (i === 4 && tr) { ax = tr.a; bx = tr.b; } else { bx = V2(AXIS[i]); ax = vec2(-AXIS[i].y, AXIS[i].x); }
    s.alb.addAssign(cs[i].rgb.mul(vec3(TINT[i].x, TINT[i].y, TINT[i].z)).mul(b));
    s.nd.addAssign(ax.mul(t.x).add(bx.mul(t.y)).mul(b));
    s.rough.addAssign(ns[i].b.mul(b));
    s.ao.addAssign(ns[i].a.mul(b));
    s.h.addAssign(cs[i].a.mul(b));
    if (i < 2) s.sand.addAssign(b);
    tot.addAssign(b);
  }
  const it = float(1).div(max(tot, 1e-4)).toVar();
  for (const k of Object.keys(s)) s[k].mulAssign(it);
  return s;
}

// --- parallax occlusion (?gfx=pom:1; GLSL version and notes: gfx/ground.js, gParallax) ------------------
const AXU = uniformArray(AXIS.map((v) => v.clone()), 'vec2'), TLU = uniformArray(TILE.slice(), 'float'), DPU = uniformArray(POM_DEPTH.slice(), 'float');
// height of layer i (int node), anti-tiled as gFetch does (inlined where it is called: the march calls it from
// two loops and once before them, three copies)
function gFetchH(i, p, dpx, dpy, rnd, tile) {
  const inv = float(1).div(tile);
  const uv = p.mul(inv), dx = dpx.mul(inv), dy = dpy.mul(inv);
  const l = rnd.mul(5).add(float(i).mul(1.37)), f = fract(l), ia = floor(l);
  const oa = sin(vec2(3, 7).mul(ia)), ob = sin(vec2(3, 7).mul(ia.add(1)));
  const ha = GU.gC.sample(uv.add(oa)).depth(i).grad(dx, dy).a.toVar(), hb = GU.gC.sample(uv.add(ob)).depth(i).grad(dx, dy).a.toVar();
  return mix(ha, hb, smoothstep(0.3, 0.7, f.add(hb.sub(ha).mul(0.35))));
}
// world-xz offset at which the surface is seen; assigns sPomSh, its self-shadow from the sun.
// tr: the track frame or null; d*: derivatives of xz and of the track frame, taken before any branch
function gParallax(w, xz, rnd, tr, N, dxz, dyz, dtx, dty) {
  const im = int(0).toVar(), wm = float(0).toVar();
  w.forEach((x, i) => { if (x) If(x.greaterThan(wm), () => { wm.assign(x); im.assign(i); }); });
  const toCam = cameraPosition.sub(positionWorld).toVar();
  const camD = length(toCam).toVar();
  const V = toCam.div(camD).toVar();
  // fades out where layers mix, and once a pixel covers more than ~1 cm of ground
  const foot = max(length(dxz), length(dyz));
  const fade = smoothstep(0.4, 0.7, wm).mul(oneMinus(smoothstep(0.005, 0.016, foot))).mul(step(camD, 60)).toVar();
  const D = DPU.element(im).mul(fade).toVar();
  const off = vec2(0).toVar();
  sPomSh.assign(1);
  If(D.greaterThan(1e-3), () => {
    const isTr = tr ? im.equal(4) : null;
    const pick = (a, b) => (tr ? select(isTr, a, b) : b);
    const b = pick(tr?.b, AXU.element(im)).toVar(), a = vec2(b.y.negate(), b.x).toVar();
    const p0 = pick(tr?.p, vec2(dot(xz, a), dot(xz, b))).toVar();
    const dpx = pick(dtx, vec2(dot(dxz, a), dot(dxz, b))).toVar(), dpy = pick(dty, vec2(dot(dyz, a), dot(dyz, b))).toVar();
    const tile = pick(tr?.tile, TLU.element(im)).toVar();
    // down the view ray: xz moves by -V.xz / (V.N) per metre of depth
    const vn = max(dot(V, N), 0.2);           // (offset limiting at grazing angles)
    const dirW = V.xz.negate().div(vn).mul(D).toVar(), dirP = vec2(dot(dirW, a), dot(dirW, b)).toVar();
    const n = int(mix(14, 6, vn.sub(0.2).mul(1.25))).toVar();
    const st = float(1).div(float(n)).toVar(), d = float(0).toVar(), dPrev = float(0).toVar();
    const h = gFetchH(im, p0, dpx, dpy, rnd, tile).toVar(), hPrev = h.toVar();
    Loop(14, ({ i }) => {
      If(i.greaterThanEqual(n).or(d.greaterThanEqual(oneMinus(h))), () => { Break(); });
      dPrev.assign(d); hPrev.assign(h);
      d.addAssign(st);
      h.assign(gFetchH(im, p0.add(dirP.mul(d)), dpx, dpy, rnd, tile));
    });
    // where the ray crosses the surface between the last two samples
    const fp = oneMinus(hPrev).sub(dPrev), fc = oneMinus(h).sub(d);
    const dh = mix(dPrev, d, clamp(fp.div(max(fp.sub(fc), 1e-4)), 0, 1)).toVar();
    // up towards the sun from there: a sample above the ray shades it, less the further out it is
    const ln = max(dot(ATMO.hfSunDir, N), 0.05);
    const sunW = ATMO.hfSunDir.xz.div(ln).mul(D), sunP = vec2(dot(sunW, a), dot(sunW, b)).toVar();
    const ph = p0.add(dirP.mul(dh)).toVar(), hh = oneMinus(dh).toVar(), occ = float(0).toVar();
    Loop({ start: 1, end: 6 }, ({ i }) => {
      const k = float(i);
      const r = oneMinus(hh).mul(k.mul(0.2));
      const hs = gFetchH(im, ph.add(sunP.mul(r)), dpx, dpy, rnd, tile);
      occ.assign(max(occ, hs.sub(hh).sub(r).sub(0.04).mul(oneMinus(k.mul(0.12)))));
    });
    sPomSh.assign(oneMinus(clamp(occ.mul(6), 0, 1).mul(fade).mul(0.8)));
    off.assign(dirW.mul(dh));
  });
  return off;
}

// what the open desert looks like at a point (shared by the terrain and the track's berm)
function gDesertWeights(xz, N, tD, mac, mac2) {
  const slope = oneMinus(N.y).toVar();
  const sd = N.xz.div(max(length(N.xz), 1e-4));
  const lee = dot(sd, V2(WIND)).mul(smoothstep(0.02, 0.16, slope));
  const near = oneMinus(smoothstep(6, 38, tD)).toVar();
  const n1 = cloud(xz.div(170)), n2 = cloud(xz.div(53).add(0.31)).toVar();
  const flat = ss(0.14, 0.03, slope).toVar();
  // the track corridor is cut lower than the dunes, so the macro map sees it as a basin: ignore that near it
  const macB = mac.b.mul(smoothstep(30, 110, tD)).toVar();
  const w = new Array(NL).fill(null);
  w[1] = clamp(smoothstep(0.05, 0.4, lee).add(mac2.r.mul(0.9)).add(smoothstep(0.62, 0.85, mac.g).mul(0.35)).add(near.mul(0.75)), 0, 1).toVar();
  const gv = macB.mul(flat).mul(1.25).add(mac.a.mul(1.1)).add(mac2.g.mul(0.9)).mul(n1.mul(0.9).add(0.55)).sub(0.3);
  w[2] = clamp(gv, 0, 1).mul(oneMinus(near.mul(0.7))).mul(oneMinus(mac2.r.mul(0.8))).toVar();
  w[3] = smoothstep(0.42, 0.92, macB.mul(n2.mul(0.8).add(0.6))).mul(flat).mul(oneMinus(near)).mul(oneMinus(mac2.r)).toVar();
  w[5] = smoothstep(0.45, 0.85, mac2.b.mul(n2.mul(0.7).add(0.65))).toVar();
  const other = w[1].add(w[2]).add(w[3]).add(w[5]);
  w[0] = max(oneMinus(other), 0).add(0.03).toVar();
  const sum = w[0].add(other).toVar();
  return w.map((x) => (x ? x.div(sum).toVar() : null));
}

// large-scale colour: lighter crests, darker redder basins, slow hue drift, wind streaks
function gDesertTint(xz, mac) {
  const m1 = cloud(xz.div(1700)).toVar(), m2 = cloud(xz.div(260).add(0.5));
  const t = vec3(m1.mul(0.2).add(0.9).mul(m2.mul(0.08).add(0.96)).mul(mac.g.sub(0.5).mul(0.16).add(1))).toVar();
  t.mulAssign(mix(vec3(1), vec3(0.9, 0.84, 0.8), mac.b.mul(0.6)));
  t.assign(mix(t, t.mul(vec3(1.06, 0.98, 0.9)), smoothstep(0.4, 0.7, m1).mul(0.5)));
  const wp = vec2(dot(xz, V2(WIND)), dot(xz, vec2(-WIND.y, WIND.x))).toVar();
  const st = cloud(vec2(wp.x.mul(0.0021).sub(ATMO.hfTime.mul(0.006)), wp.y.mul(0.017)))
    .mul(cloud(vec2(wp.x.mul(0.0009).sub(ATMO.hfTime.mul(0.0025)), wp.y.mul(0.004)).add(0.3)));
  return t.mul(smoothstep(0.32, 0.5, st).mul(0.1).add(1));
}

// world normal from the blended surface (nd = world-xz tangent offset)
function bendNormal(gN, nd) {
  const d3 = vec3(nd.x, 0, nd.y).toVar();
  d3.subAssign(gN.mul(dot(d3, gN)));
  return normalize(gN.mul(sqrt(max(oneMinus(dot(nd, nd)), 0.04))).add(d3));
}

// sun glitter on sand grains and a broad grazing sheen on the dunes (cf. Journey); added to the
// sun's direct specular by GroundLighting
function glint(gNW, sand) {
  const wp = positionWorld;
  const V = normalize(cameraPosition.sub(wp)).toVar(), L = ATMO.hfSunDir, Hh = normalize(L.add(V)).toVar();
  const camD = length(wp.sub(cameraPosition)).toVar();
  const r1 = GU.gGlint.sample(wp.xz.div(5.6)).toVar();
  const q = wp.xz.div(2.3);
  const r2 = GU.gGlint.sample(vec2(q.x.mul(0.8).add(q.y.mul(0.6)), q.x.mul(-0.6).add(q.y.mul(0.8))).add(0.37)).toVar();
  const g1 = normalize(gNW.add(r1.xyz.sub(0.5).mul(1.1))), g2 = normalize(gNW.add(r2.xyz.sub(0.5).mul(1.1)));
  const sp = pow(max(dot(g1, Hh), 0), 260).mul(smoothstep(0.86, 0.93, r1.w))
    .add(pow(max(dot(g2, Hh), 0), 260).mul(smoothstep(0.88, 0.95, r2.w)).mul(oneMinus(smoothstep(8, 30, camD))))
    .mul(oneMinus(smoothstep(25, 90, camD)));
  // rim only where the dune turns away from the camera towards the sun, fading out with distance
  const rim = pow(oneMinus(saturate(dot(gNW, V))), 6).mul(saturate(dot(gNW, L))).mul(oneMinus(smoothstep(60, 400, camD)));
  const sheen = pow(saturate(dot(gNW, Hh)), 12).mul(saturate(dot(gNW, L)));
  return vec3(sp.mul(9)).add(vec3(1, 0.86, 0.68).mul(rim.mul(0.06))).add(sheen.mul(0.05)).mul(sand);
}

// The standard model, plus: the glint on the sun's light (the near shadow and hfSunVis are already in
// lightColor), and the surface's occlusion on the indirect light. (Through material.aoNode it does not
// arrive: the lighting context brings its own ambientOcclusion, fixed at 1.)
class GroundLighting extends THREE.PhysicalLightingModel {
  constructor(glint, pom) { super(); this.glint = glint; this.pom = pom; }
  direct(params, builder) {
    // the relief's own shadow (parallax occlusion) on the sun
    if (this.pom && params.lightNode?.light?.isDirectionalLight) params = { ...params, lightColor: params.lightColor.mul(sPomSh) };
    super.direct(params, builder);
    if (this.glint && params.lightNode?.light?.isDirectionalLight) params.reflectedLight.directSpecular.addAssign(params.lightColor.mul(sGlint));
  }
  ambientOcclusion(builder) {
    const { reflectedLight } = builder.context;
    const dotNV = normalView.dot(positionViewDirection).clamp();
    let ao = sAO;
    if (GI_ON) {
      // the baked light (?gfx=gi:1, gfx/gi.js): sky visibility and bounce, over the open desert's
      const gi = hfGI(positionWorld, sNW).toVar();
      reflectedLight.indirectDiffuse.mulAssign(gi);
      ao = sAO.mul(min(dot(gi, vec3(0.2126, 0.7152, 0.0722)), 1));
    }
    const spec = ao.sub(dotNV.add(ao).pow(roughness.mul(-16).oneMinus().negate().exp2()).oneMinus()).clamp();
    reflectedLight.indirectDiffuse.mulAssign(sAO);
    reflectedLight.indirectSpecular.mulAssign(spec);
  }
}

// A MeshStandardNodeMaterial whose surface comes from surface(material): runs once at the start of
// the fragment shader and assigns the s* properties.
class SurfaceMaterial extends THREE.MeshStandardNodeMaterial {
  constructor(params, surface, glintOn, pom = false) {
    super(params);
    this.surface = surface;
    this.glintOn = glintOn;
    this.pom = pom;
    this.vertexColors = false;            // the surface multiplies them in itself (before blending in sand)
    this.colorNode = sAlb;
    this.normalNode = normalize(cameraViewMatrix.mul(vec4(sNW, 0)).xyz);
    this.roughnessNode = sRough;
  }
  setupDiffuseColor(builder) {
    this.surface(this);                   // TSL statements go onto the fragment stack being built
    super.setupDiffuseColor(builder);
  }
  setupLightingModel() { return new GroundLighting(this.glintOn, this.pom); }
  copy(source) { this.surface = source.surface; this.glintOn = source.glintOn; this.pom = source.pom; return super.copy(source); }
}

// ---------------------------------------------------------------------------
//  Terrain (dunes). aTrackD = metres from the track edge
// ---------------------------------------------------------------------------
export function terrainNodeMaterial(Q) {
  const GQ = Q.groundQ ?? 2, pom = !!Q.pom && GQ > 1;
  const m = new SurfaceMaterial({ roughness: 1, metalness: 0 }, (mat) => {
    const hfGN = geoNormal(mat);
    const xz = positionWorld.xz.toVar();
    const camD = length(positionWorld.sub(cameraPosition)).toVar();
    const mac = gMacro(xz).toVar(), mac2 = gMacro2(xz).toVar();
    const w = gDesertWeights(xz, hfGN, attribute('aTrackD', 'float'), mac, mac2);
    const rnd = cloud(xz.div(61)).toVar();
    let off = null;
    if (pom) { const dx = dFdx(xz).toVar(), dy = dFdy(xz).toVar(); off = gParallax(w, xz, rnd, null, hfGN, dx, dy, null, null); }
    const gS = gBlend(w, xz, rnd, null, GQ, off);
    const col = gS.alb.mul(gDesertTint(xz, mac)).toVar();
    // larger wind ripples where the texture's own have blurred away (from ~30 m)
    const midK = smoothstep(25, 110, camD).mul(oneMinus(smoothstep(500, 1400, camD))).mul(w[0].add(w[1].mul(0.6))).mul(rnd.add(0.35)).toVar();
    const dxzM = dFdx(xz).toVar(), dyzM = dFdy(xz).toVar();
    If(midK.greaterThan(0.01), () => {
      const b = V2(AXIS[0]), a = vec2(-AXIS[0].y, AXIS[0].x), inv = 1 / (TILE[0] * 7);
      const p = vec2(dot(xz, a), dot(xz, b)).mul(inv).add(rnd.mul(0.37));
      const gx = vec2(dot(dxzM, a), dot(dxzM, b)).mul(inv), gy = vec2(dot(dyzM, a), dot(dyzM, b)).mul(inv);
      const mc = GU.gC.sample(p).depth(int(0)).grad(gx, gy), mn = GU.gN.sample(p).depth(int(0)).grad(gx, gy);
      const t = mn.xy.mul(2).sub(1);
      gS.nd.addAssign(a.mul(t.x).add(b.mul(t.y)).mul(midK));
      col.mulAssign(mc.a.sub(0.5).mul(0.18).mul(midK).add(1));
    });
    sAO.assign(mix(1, gS.ao, 0.85).mul(mac.r));
    sAlb.assign(col.mul(mix(1, gS.ao, 0.35)));
    sRough.assign(clamp(gS.rough, 0.3, 1));
    const gNK = oneMinus(smoothstep(120, 1100, camD).mul(0.7)).mul(1.25);
    sNW.assign(bendNormal(hfGN, gS.nd.mul(gNK)));
    if (GQ > 1) sGlint.assign(glint(sNW, gS.sand));
  }, GQ > 1, pom);
  m.userData.uniforms = {};
  return m;
}

// ---------------------------------------------------------------------------
//  Track. aTr = (lateral m, arc length m, racing line lateral m, half width), aDir = track
//  direction (x, z), aZone = (arena, canyon)
// ---------------------------------------------------------------------------
export function trackNodeMaterial(Q, trackLength, u) {
  const GQ = Q.groundQ ?? 2, pom = !!Q.pom && GQ > 1;
  const m = new SurfaceMaterial({ roughness: 1, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2 }, (mat) => {
    const hfGN = geoNormal(mat);
    const xz = positionWorld.xz.toVar();
    const tr = attribute('aTr', 'vec4').toVar(), dir = attribute('aDir', 'vec2'), zone = attribute('aZone', 'vec2').toVar();
    const d = tr.x, s = tr.y, hw = tr.w;
    const e = abs(d).sub(hw).toVar();
    const arena = zone.x, canyon = zone.y;
    const camD = length(positionWorld.sub(cameraPosition)).toVar();
    const mac = gMacro(xz).toVar(), mac2 = gMacro2(xz).toVar();
    const fwd = normalize(dir).toVar(), lat = vec2(fwd.y.negate(), fwd.x).toVar();
    const ds = vec2(d, s).toVar();
    const n1 = cloud(ds.div(vec2(23, 61))).toVar();
    const n2 = cloud(ds.div(vec2(9, 140)).add(0.4)).toVar();
    const n3 = cloud(ds.div(vec2(31, 90)).add(0.7)).toVar();
    // loose sand creeping in from the edges and lying in patches
    const edge = abs(d).div(hw).toVar();
    const drift = smoothstep(0.74, 1, edge.add(n1.sub(0.5).mul(0.5))).toVar();
    drift.assign(max(drift, smoothstep(0.63, 0.76, n2).mul(smoothstep(0.3, 0.8, edge)).mul(0.85)));
    drift.mulAssign(oneMinus(arena.mul(0.9)));
    const tw = gDesertWeights(xz, vec3(0, 1, 0), max(e, 0), mac, mac2);
    const bed = oneMinus(drift);
    const rockPatch = canyon.mul(smoothstep(0.52, 0.68, n3)).toVar();
    const w0 = new Array(NL).fill(float(0));
    w0[4] = bed.mul(oneMinus(arena)).mul(oneMinus(rockPatch));
    w0[5] = bed.mul(oneMinus(arena)).mul(rockPatch);
    w0[6] = bed.mul(arena);
    w0[1] = drift.mul(0.8);
    w0[0] = drift.mul(0.2).mul(smoothstep(0.2, 0.7, n1));
    // outside the edge: the berm of pushed-up sand, then the open desert
    const out = smoothstep(0, 1.2, e).toVar();
    const far = smoothstep(2.5, 6.5, e.sub(n3.sub(0.5).mul(3.5))).toVar();         // the berm's width wanders
    const w = w0.map((x, i) => {
      const berm = i === 1 ? float(0.85) : i === 2 ? smoothstep(0.45, 0.7, n2).mul(0.15) : float(0);
      return mix(x, mix(berm, tw[i] ?? float(0), far), out).toVar();
    });
    const ws = w.reduce((a, b) => a.add(b), float(0)).toVar();
    const wn = w.map((x) => x.div(max(ws, 1e-4)).toVar());
    const rnd = cloud(xz.div(61)).toVar();
    const trf = { a: lat, b: fwd, p: ds, tile: u.kTile };
    const off = pom ? gParallax(wn, xz, rnd, trf, hfGN, dFdx(xz).toVar(), dFdy(xz).toVar(), dFdx(ds).toVar(), dFdy(ds).toVar()) : null;
    const gS = gBlend(wn, xz, rnd, trf, GQ, off);
    const col = gS.alb.toVar();
    // the racing line: packed hard, darker, with jet scorch
    const ld = d.sub(tr.z).div(5.5);
    const onBed = oneMinus(drift).mul(oneMinus(out));
    const groove = exp(ld.mul(ld).negate()).mul(onBed).mul(oneMinus(arena.mul(0.6))).toVar();
    const scorch = smoothstep(0.55, 0.78, cloud(vec2(d.div(6), s.div(55)).add(0.7))).mul(groove);
    // (the trail map is a render target: its v runs down from the top on this renderer)
    const trail = select(u.kTrailOn.greaterThan(0.5), min(u.kTrail.sample(vec2(d.div(hw.mul(2.6)).add(0.5), oneMinus(s.div(u.kL)))), vec4(1)), vec4(0)).toVar();
    col.mulAssign(oneMinus(groove.mul(0.14)).sub(scorch.mul(0.32)));
    col.mulAssign(oneMinus(trail.r.mul(0.3)));
    col.assign(mix(col, vec3(0.14, 0.11, 0.09), trail.g.mul(0.4)));
    // marks left by earlier races: oil stains (dark, glossy) and scorch blasts (sooty, with a paler
    // burnt ring), one per hashed cell at most, irregular through the noise
    const oil = float(0).toVar(), burn = float(0).toVar();
    {
      const cellSz = vec2(9, 13), q = ds.div(cellSz), ci = floor(q).toVar();
      const gdx = dFdx(ds).toVar(), gdy = dFdy(ds).toVar();
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const c = ci.add(vec2(ox, oy)).toVar();
        const h = hash4(c).toVar();
        If(h.w.lessThanEqual(0.12), () => {
          const an = h.z.sub(0.5).mul(0.5), ca = cos(an).toVar(), sa = sin(an).toVar();          // streaks along the track
          const rot = (v) => vec2(ca.mul(v.x).add(sa.mul(v.y)), sa.negate().mul(v.x).add(ca.mul(v.y)));   // GLSL mat2( ca, -sa, sa, ca ) * v
          const sz = mix(1.1, 3.2, fract(h.z.mul(7.31)));
          const div = vec2(0.8, mix(2.5, 7.0, fract(h.x.mul(13.1)))).mul(sz).toVar();
          const rel = rot(ds.sub(c.add(0.2).add(h.xy.mul(0.6)).mul(cellSz))).div(div).toVar();
          const rdx = rot(gdx).div(div), rdy = rot(gdy).div(div);
          const nn = ATMO.hfCloudTex.sample(rel.mul(0.3).add(h.xy.mul(7))).grad(rdx.mul(0.3), rdy.mul(0.3)).r.mul(0.65)
            .add(ATMO.hfCloudTex.sample(rel.mul(1.1).add(h.yx.mul(3))).grad(rdx.mul(1.1), rdy.mul(1.1)).r.mul(0.35)).toVar();
          const r = length(rel).add(nn.sub(0.5).mul(1.5)).toVar();
          const mk = ss(1.0, 0.55, r).mul(smoothstep(0.3, 0.7, nn).mul(0.45).add(0.55)).toVar();
          const isOil = fract(h.w.mul(9.7)).lessThan(0.55);
          oil.assign(select(isOil, max(oil, mk), oil));
          burn.assign(select(isOil, burn, max(burn, mk.add(ss(1.25, 1.0, r).mul(smoothstep(0.8, 1.0, r)).mul(-0.6)))));
        });
      }
      const keep = oneMinus(drift).mul(oneMinus(out)).mul(oneMinus(arena.mul(0.6))).toVar();
      oil.mulAssign(keep); burn.mulAssign(keep);
    }
    col.mulAssign(oneMinus(oil.mul(0.35)));
    col.assign(mix(col, vec3(0.075, 0.06, 0.05), clamp(burn, 0, 1).mul(0.45)));
    col.mulAssign(clamp(burn.negate(), 0, 1).mul(0.25).add(1));
    // packed sand is darker where it meets the loose edge (shadowed lip)
    col.mulAssign(oneMinus(smoothstep(0.9, 1, edge).mul(oneMinus(smoothstep(1, 1.15, edge))).mul(0.15)));
    col.assign(col.mul(mix(vec3(1), gDesertTint(xz, mac), mix(0.45, 1, out))));
    const ao = mix(1, gS.ao, 0.85).mul(mix(1, mac.r, out)).toVar();
    // down in the canyon the floor sees only a strip of sky, less still by the walls
    // (hfShade, D2: deeper, as the floor of a real slot sees ~10-25 % of the sky)
    const shade = ATMO.hfShade;
    // (the baked light, gi, has the real thing)
    if (!GI_ON) {
      ao.mulAssign(oneMinus(canyon.mul(smoothstep(0.55, 1, edge).mul(mix(0.25, 0.2, shade)).add(mix(0.35, 0.62, shade)))));
      // under the tunnel's roof (D7)
      const roofK = (r) => smoothstep(r.x.sub(4), r.x.add(4), s).mul(oneMinus(smoothstep(r.y.sub(4), r.y.add(4), s)));
      ao.mulAssign(oneMinus(max(roofK(u.kRoof0), max(roofK(u.kRoof1), roofK(u.kRoof2))).mul(0.8)));
    }
    sAO.assign(ao);
    sAlb.assign(col.mul(mix(1, gS.ao, 0.35)));
    const polish = groove.mul(0.2).add(trail.r.mul(0.1)).add(oil.mul(0.42));
    sRough.assign(clamp(gS.rough.sub(polish), 0.25, 1));
    const gNK = oneMinus(smoothstep(80, 600, camD).mul(0.7)).mul(oneMinus(groove.mul(0.4)));
    sNW.assign(bendNormal(hfGN, gS.nd.mul(gNK)));
    if (GQ > 1) sGlint.assign(glint(sNW, gS.sand));
  }, GQ > 1, pom);
  m.userData.uniforms = u;
  return m;
}

// ---------------------------------------------------------------------------
//  Rock (triplanar): vertex colours (strata) or the material colour set the hue, the texture the
//  detail; sand on ledges and around the foot, desert varnish on cliffs.
// ---------------------------------------------------------------------------
const unpackN = (t, k) => {
  const xy = t.rg.mul(2).sub(1).mul(k).toVar();
  return vec3(xy, sqrt(max(oneMinus(dot(xy, xy)), 0)));
};
export function rockNodeMaterial(Q, params, u, { vertexColors, ao, arena }) {
  const m = new SurfaceMaterial(params, (mat) => {
    const hfGN = geoNormal(mat);
    const wp = positionWorld.toVar();
    const camD = length(wp.sub(cameraPosition)).toVar();
    const layer = int(u.rLayer);
    const tpP = wp.mul(u.rScale).toVar();
    const tpW = pow(abs(hfGN), vec3(4)).toVar();
    tpW.divAssign(tpW.x.add(tpW.y).add(tpW.z));
    const RC = (p) => u.gRC.sample(p).depth(layer), RN = (p) => u.gRN.sample(p).depth(layer);
    const cx = RC(tpP.zy).toVar(), cy = RC(tpP.xz).toVar(), cz = RC(tpP.xy).toVar();
    const nx = RN(tpP.zy).toVar(), ny = RN(tpP.xz).toVar(), nz = RN(tpP.xy).toVar();
    const tri = (a, b, c) => a.mul(tpW.x).add(b.mul(tpW.y)).add(c.mul(tpW.z));
    const tpAlb = tri(cx.rgb, cy.rgb, cz.rgb), tpH = tri(cx.a, cy.a, cz.a).toVar(), tpR = tri(nx.b, ny.b, nz.b), tpAO = tri(nx.a, ny.a, nz.a).toVar();
    const tpMac = cloud(wp.xz.div(1300));
    const tpMean = arena ? vec3(1) : u.gRC.sample(vec2(0.5)).depth(layer).level(16).rgb;
    const rel = tpAlb.div(max(tpMean, vec3(0.03))).toVar();
    rel.assign(pow(max(mix(vec3(lum(rel)), rel, u.rChroma), vec3(0)), vec3(u.rContrast)));
    let base = materialColor.rgb;
    if (vertexColors) base = base.mul(vertexColor().rgb);
    const col = base.mul(rel).mul(oneMinus(u.rMacro.mul(0.5)).add(u.rMacro.mul(tpMac))).toVar();
    // desert varnish: dark streaks running down steep faces
    const steep = oneMinus(smoothstep(0.35, 0.7, abs(hfGN.y)));
    const vk = cloud(vec2(dot(wp.xz, vec2(0.71, 0.7)).div(23), wp.y.div(900)));
    const varn = smoothstep(0.55, 0.78, vk).mul(steep).mul(u.rVarnish).toVar();
    col.mulAssign(oneMinus(varn.mul(0.45)));
    // sand on the ledges and around the foot
    const macH = select(macOn(), GU.gMacH.sample(macUv(wp.xz)), vec4(-1e4));
    const sn = cloud(wp.xz.div(9).add(wp.y.div(31))).toVar();
    const sandUp = smoothstep(0.6, 0.86, hfGN.y.add(sn.sub(0.5).mul(0.35)).add(float(0.5).sub(tpH).mul(0.3)));
    const fy = wp.y.sub(macH.r).add(sn.sub(0.5).mul(u.rFoot).mul(0.8)).add(tpH.mul(0.6));
    const sandFoot = oneMinus(smoothstep(u.rFoot.mul(0.15), u.rFoot, fy));
    const sandK = max(sandUp, sandFoot).mul(u.rSand).toVar();
    const sb = V2(AXIS[1]), sa = vec2(-AXIS[1].y, AXIS[1].x);
    const suv = vec2(dot(wp.xz, sa), dot(wp.xz, sb)).div(TILE[1]).toVar();
    // no anti-tiling here: fade the sand's detail to its average before the repeat shows
    const sFar = smoothstep(35, 160, camD).toVar();
    const sC = mix(GU.gC.sample(suv).depth(int(1)), GU.gC.sample(vec2(0.5)).depth(int(1)).level(16), sFar).toVar();
    const sN0 = GU.gN.sample(suv).depth(int(1)).toVar();
    const sN = mix(sN0, vec4(0.5, 0.5, sN0.b, sN0.a), sFar).toVar();
    const sandCol = sC.rgb.mul(gDesertTint(wp.xz, gMacro(wp.xz)));
    col.assign(mix(col, sandCol, sandK));
    const occ = mix(mix(1, tpAO, 0.9), sN.a, sandK).toVar();
    col.mulAssign(mix(1, tpAO, oneMinus(sandK).mul(0.3)));
    if (ao) {
      const rockAO = attribute('aAO', 'float').toVar();
      // (with the baked light, gi, only part of it: rAOgi; gfx/ground.js)
      occ.mulAssign(pow(max(rockAO, 0), GI_ON ? u.rAOgi : ATMO.hfShade.mul(0.7).add(1)));
      col.mulAssign(mix(1, rockAO, u.rAOAlb));         // deep cavities stay dark in sunlight too (aoAlbedo)
    }
    sAO.assign(occ);
    sAlb.assign(col);
    sRough.assign(clamp(mix(u.rRough.x.add(u.rRough.y.mul(tpR)).sub(varn.mul(0.15)), sN.b, sandK), 0.04, 1));
    // normal: triplanar (whiteout blend) rock detail, bent towards the sand's where it lies
    const fade = u.rNormal.mul(oneMinus(smoothstep(120, 700, camD).mul(0.7))).toVar();
    const wn = hfGN;
    const tX0 = unpackN(nx, fade), tY0 = unpackN(ny, fade), tZ0 = unpackN(nz, fade);
    const tX = vec3(tX0.xy.add(wn.zy), abs(tX0.z).mul(wn.x));
    const tY = vec3(tY0.xy.add(wn.xz), abs(tY0.z).mul(wn.y));
    const tZ = vec3(tZ0.xy.add(wn.xy), abs(tZ0.z).mul(wn.z));
    const nRock = normalize(tX.zyx.mul(tpW.x).add(tY.xzy.mul(tpW.y)).add(tZ.xyz.mul(tpW.z)));
    const t = sN.xy.mul(2).sub(1);
    const nd = sa.mul(t.x).add(sb.mul(t.y));
    const nSand = normalize(vec3(nd.x, 1, nd.y));
    sNW.assign(normalize(mix(nRock, normalize(mix(wn, nSand, 0.6)), sandK)));
  }, false);
  m.userData.uniforms = u;
  return m;
}

// ---------------------------------------------------------------------------
//  Triplanar stone for the built structures (gfx/surfaces.js): plain 2D textures, normalised by
//  their own mean so the vertex colours or the material colour set the hue.
// ---------------------------------------------------------------------------
export function triplanarNodeMaterial(params, u, vertexColors) {
  const m = new SurfaceMaterial(params, (mat) => {
    const hfGN = geoNormal(mat);
    const wp = positionWorld.toVar();
    const tpP = wp.mul(u.tpScale).toVar();
    const tpW = pow(abs(hfGN), vec3(4)).toVar();
    tpW.divAssign(tpW.x.add(tpW.y).add(tpW.z));
    const cx = u.tpC.sample(tpP.zy).toVar(), cy = u.tpC.sample(tpP.xz).toVar(), cz = u.tpC.sample(tpP.xy).toVar();
    const nx = u.tpN.sample(tpP.zy).toVar(), ny = u.tpN.sample(tpP.xz).toVar(), nz = u.tpN.sample(tpP.xy).toVar();
    const tri = (a, b, c) => a.mul(tpW.x).add(b.mul(tpW.y)).add(c.mul(tpW.z));
    const tpAlb = tri(cx.rgb, cy.rgb, cz.rgb), tpR = tri(nx.b, ny.b, nz.b);
    const tpMac = cloud(wp.xz.div(1300));
    const rel = tpAlb.div(max(u.tpC.sample(vec2(0.5)).level(12).rgb, vec3(0.03))).toVar();
    rel.assign(pow(max(mix(vec3(dot(rel, vec3(0.299, 0.587, 0.114))), rel, u.tpChroma), vec3(0)), vec3(u.tpContrast)));
    let base = materialColor.rgb;
    if (vertexColors) base = base.mul(vertexColor().rgb);
    sAlb.assign(base.mul(rel).mul(oneMinus(u.tpMacro.mul(0.5)).add(u.tpMacro.mul(tpMac))));
    sRough.assign(clamp(u.tpRough.x.add(u.tpRough.y.mul(tpR)), 0.04, 1));
    sAO.assign(1);
    const fade = u.tpNormal.mul(oneMinus(smoothstep(120, 700, length(wp.sub(cameraPosition))).mul(0.7))).toVar();
    const wn = hfGN;
    const tX0 = unpackN(nx, fade), tY0 = unpackN(ny, fade), tZ0 = unpackN(nz, fade);
    const tX = vec3(tX0.xy.add(wn.zy), abs(tX0.z).mul(wn.x));
    const tY = vec3(tY0.xy.add(wn.xz), abs(tY0.z).mul(wn.y));
    const tZ = vec3(tZ0.xy.add(wn.xy), abs(tZ0.z).mul(wn.z));
    sNW.assign(normalize(tX.zyx.mul(tpW.x).add(tY.xzy.mul(tpW.y)).add(tZ.xyz.mul(tpW.z))));
  }, false);
  m.userData.uniforms = u;
  return m;
}
