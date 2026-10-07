import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, Break, float, int, vec2, vec3, vec4, uniform, storage, uv, min, max, abs, dot, cross, normalize, select, sign, floor, fract, sin, array, mix,
} from 'three/tsl';
import { buildBVH, traceClosest, packBVH } from '../bvh.js';
import { collectStatic } from '../bvhscene.js';
import { ATMO, PALETTE } from '../atmosphere.js';
import { GI_ON } from '../gi.js';
import { hfStaticShadow, hfApplyFog } from './atmosphere.js';
import { hfGI } from './gi.js';

// ============================================================
//  Ray tracing on the GPU (WebGPU only; docs/visual-next-steps.md D9). A BVH of the static world
//  (gfx/bvh.js) is laid out depth first with a skip link per node: a hit goes on to the next node
//  (the first child), a miss jumps to the skip (the next node outside this one's subtree). The
//  traversal needs no stack, so it is one while loop in TSL, in any shader stage that can read
//  storage buffers (a fragment pass of the post graph, a compute pass).
//  nodes: 2 vec4 per node, (min.xyz, skip), (max.xyz, leaf: first triangle x 8 + count, inner: -1)
//  tris: 3 vec4 per triangle, (v0.xyz, albedo r), (e1.xyz, albedo g), (e2.xyz, albedo b)
//  Indices are kept as floats: exact below 2^24 (2M triangles at 8 per slot).
// ============================================================

// storage buffer nodes for a packed BVH (read only: fragment shaders can read them)
export function bvhBuffers(packed) {
  const nodeAttr = new THREE.StorageBufferAttribute(packed.nodes, 4), triAttr = new THREE.StorageBufferAttribute(packed.tris, 4);
  return {
    nodes: storage(nodeAttr, 'vec4', packed.nodeCount * 2).toReadOnly(),
    tris: storage(triAttr, 'vec4', packed.triCount * 3).toReadOnly(),
    count: packed.nodeCount,
  };
}

// a direction with no zero component (the slab test divides by it)
const safeDir = (d) => select(abs(d).lessThan(1e-8), float(1e-8), d);

// Closest hit along ro + t rd for t < tmax: vec4(t, triangle, steps, back face 0/1); t = -1 for none.
// any = true: stop at the first hit (shadow rays)
export function traceTSL(B, ro, rd, tmax, any = false) {
  const res = vec4(-1, -1, 0, 0).toVar();
  const d = vec3(safeDir(rd.x), safeDir(rd.y), safeDir(rd.z)).toVar();
  const inv = vec3(1).div(d).toVar();
  const best = float(tmax).toVar(), hitTri = int(-1).toVar(), node = int(0).toVar(), steps = int(0).toVar();
  Loop(node.lessThan(B.count), () => {
    steps.addAssign(1);
    const A = B.nodes.element(node.mul(2)).toVar(), M = B.nodes.element(node.mul(2).add(1)).toVar();
    const t0 = A.xyz.sub(ro).mul(inv), t1 = M.xyz.sub(ro).mul(inv);
    const lo = max(max(min(t0.x, t1.x), min(t0.y, t1.y)), min(t0.z, t1.z));
    const hi = min(min(max(t0.x, t1.x), max(t0.y, t1.y)), max(t0.z, t1.z));
    If(hi.greaterThanEqual(max(lo, 0)).and(lo.lessThan(best)), () => {
      If(M.w.greaterThanEqual(0), () => {
        const f = floor(M.w.div(8));
        const firstTri = int(f), cnt = int(M.w.sub(f.mul(8)));
        Loop(cnt, ({ i }) => {
          const k = firstTri.add(i).mul(3);
          const v0 = B.tris.element(k).xyz, e1 = B.tris.element(k.add(1)).xyz, e2 = B.tris.element(k.add(2)).xyz;
          const p = cross(d, e2).toVar();
          const det = dot(e1, p).toVar();
          If(abs(det).greaterThan(1e-9), () => {
            const id = float(1).div(det);
            const s = ro.sub(v0).toVar();
            const u = dot(s, p).mul(id);
            const q = cross(s, e1).toVar();
            const v = dot(d, q).mul(id);
            const t = dot(e2, q).mul(id);
            If(u.greaterThanEqual(0).and(v.greaterThanEqual(0)).and(u.add(v).lessThanEqual(1)).and(t.greaterThan(1e-4)).and(t.lessThan(best)), () => {
              best.assign(t); hitTri.assign(firstTri.add(i));
              res.w.assign(select(det.lessThan(0), 1, 0));
            });
          });
        });
        node.assign(int(A.w));
        if (any) If(hitTri.greaterThanEqual(0), () => { Break(); });
      }).Else(() => { node.addAssign(1); });
    }).Else(() => { node.assign(int(A.w)); });
  });
  res.x.assign(select(hitTri.greaterThanEqual(0), best, -1));
  res.y.assign(float(hitTri));
  res.z.assign(float(steps));
  return res;
}

// Ordered traversal (the nearer child first, the other on a short stack): fewer nodes per closest hit than the
// skip links, at the price of a local array. Same result as traceTSL. With the depth-first layout the left child is
// node + 1 and the right child is the left one's skip.
const STACK = 48;
export function traceOrderedTSL(B, ro, rd, tmax, any = false) {
  const res = vec4(-1, -1, 0, 0).toVar();
  const d = vec3(safeDir(rd.x), safeDir(rd.y), safeDir(rd.z)).toVar();
  const inv = vec3(1).div(d).toVar();
  const best = float(tmax).toVar(), hitTri = int(-1).toVar(), node = int(0).toVar(), steps = int(0).toVar();
  const stack = array('int', STACK).toVar(), sp = int(0).toVar();
  // entry distance into a node's box, or a huge value when it is missed or behind the best hit
  const enter = (n) => {
    const A = B.nodes.element(n.mul(2)), M = B.nodes.element(n.mul(2).add(1));
    const t0 = A.xyz.sub(ro).mul(inv), t1 = M.xyz.sub(ro).mul(inv);
    const lo = max(max(min(t0.x, t1.x), min(t0.y, t1.y)), min(t0.z, t1.z));
    const hi = min(min(max(t0.x, t1.x), max(t0.y, t1.y)), max(t0.z, t1.z));
    return select(hi.greaterThanEqual(max(lo, 0)).and(lo.lessThan(best)), max(lo, 0), 1e30);
  };
  const pop = () => { If(sp.greaterThan(0), () => { sp.subAssign(1); node.assign(stack.element(sp)); }).Else(() => { node.assign(-1); }); };
  If(enter(int(0)).greaterThan(1e29), () => { node.assign(-1); });
  Loop(node.greaterThanEqual(0), () => {
    steps.addAssign(1);
    const M = B.nodes.element(node.mul(2).add(1)).toVar();
    If(M.w.greaterThanEqual(0), () => {
      const f = floor(M.w.div(8));
      const firstTri = int(f), cnt = int(M.w.sub(f.mul(8)));
      Loop(cnt, ({ i }) => {
        const k = firstTri.add(i).mul(3);
        const v0 = B.tris.element(k).xyz, e1 = B.tris.element(k.add(1)).xyz, e2 = B.tris.element(k.add(2)).xyz;
        const p = cross(d, e2).toVar();
        const det = dot(e1, p).toVar();
        If(abs(det).greaterThan(1e-9), () => {
          const id = float(1).div(det);
          const s = ro.sub(v0).toVar();
          const u = dot(s, p).mul(id);
          const q = cross(s, e1).toVar();
          const v = dot(d, q).mul(id);
          const t = dot(e2, q).mul(id);
          If(u.greaterThanEqual(0).and(v.greaterThanEqual(0)).and(u.add(v).lessThanEqual(1)).and(t.greaterThan(1e-4)).and(t.lessThan(best)), () => {
            best.assign(t); hitTri.assign(firstTri.add(i));
            res.w.assign(select(det.lessThan(0), 1, 0));
          });
        });
      });
      if (any) If(hitTri.greaterThanEqual(0), () => { Break(); });
      pop();
    }).Else(() => {
      const l = node.add(1).toVar();
      const r = int(B.nodes.element(l.mul(2)).w).toVar();
      const dl = enter(l).toVar(), dr = enter(r).toVar();
      If(dl.lessThan(1e29).and(dr.lessThan(1e29)), () => {
        If(sp.lessThan(STACK), () => { stack.element(sp).assign(select(dl.lessThanEqual(dr), r, l)); sp.addAssign(1); });
        node.assign(select(dl.lessThanEqual(dr), l, r));
      }).ElseIf(dl.lessThan(1e29), () => { node.assign(l); })
        .ElseIf(dr.lessThan(1e29), () => { node.assign(r); })
        .Else(() => { pop(); });
    });
  });
  res.x.assign(select(hitTri.greaterThanEqual(0), best, -1));
  res.y.assign(float(hitTri));
  res.z.assign(float(steps));
  return res;
}

// --- ray-traced reflections on the pods (?gfx=rtr:1, D9) ---------------------------------------------------------
// The static world in the BVH (no ground: rays that leave it fall back to the pod's probes, which have the sky and the
// sand), the other pods as boxes (POD_BOXES per pod, updated every frame: rows 0-2 = the inverse of the box's world
// matrix, row 3 = half size, row 4 = colour). A hit is lit the way the scene is: the triangle's albedo x (the sun x
// the static world shadow x cos + the fill lights x the baked light) / pi, then the fog to the camera.
export const POD_BOXES = 3, MAX_PODS = 7;
const lin = (c) => vec3(c.r, c.g, c.b);
export function createReflections(packed) {
  const B = bvhBuffers(packed);
  const boxData = new Float32Array(MAX_PODS * POD_BOXES * 5 * 4);
  const boxAttr = new THREE.StorageBufferAttribute(boxData, 4);
  const boxes = storage(boxAttr, 'vec4', MAX_PODS * POD_BOXES * 5).toReadOnly();
  const boxCount = uniform(0, 'int');
  // the fill lights as the materials get them (hemisphere + environment), roughly
  const P = PALETTE, envSky = [1.4, 1.6, 1.95].map((v) => v * P.envI), envGround = [0.35, 0.25, 0.15].map((v) => v * Math.PI * P.envI);
  const shade = (Pw, n, alb) => {
    const sv = hfStaticShadow(Pw, n);
    const sun = ATMO.hfSunCol.mul(P.sunI).mul(sv.mul(max(dot(n, ATMO.hfSunDir), 0)));
    const up = n.y.mul(0.5).add(0.5);
    let amb = mix(lin(P.hemiGround), lin(P.hemiSky), up).mul(P.hemiI).add(mix(vec3(...envGround), vec3(...envSky), up));
    if (GI_ON) amb = amb.mul(hfGI(Pw, n));
    return hfApplyFog(alb.mul(sun.add(amb)).mul(1 / Math.PI), Pw);
  };
  // radiance along ro + t rd (t < tmax) and 1, or 0 and 0 for a miss
  const trace = Fn(([ro, rd, tmax]) => {
    const out = vec4(0).toVar();
    const h = traceOrderedTSL(B, ro, rd, tmax).toVar();
    const best = select(h.x.greaterThan(0), h.x, tmax).toVar();
    const nrm = vec3(0).toVar(), alb = vec3(0).toVar();
    If(h.x.greaterThan(0), () => {
      const k = int(h.y).mul(3);
      const t0 = B.tris.element(k), t1 = B.tris.element(k.add(1)), t2 = B.tris.element(k.add(2));
      const n = normalize(cross(t1.xyz, t2.xyz)).toVar();
      nrm.assign(select(dot(n, rd).greaterThan(0), n.negate(), n));
      alb.assign(vec3(t0.w, t1.w, t2.w));
    });
    // the other pods: boxes in their own frames
    Loop(MAX_PODS * POD_BOXES, ({ i }) => {
      If(int(i).lessThan(boxCount), () => {
        const o = int(i).mul(5);
        const r0 = boxes.element(o), r1 = boxes.element(o.add(1)), r2 = boxes.element(o.add(2)), hs = boxes.element(o.add(3)).xyz, col = boxes.element(o.add(4)).xyz;
        const lo = vec3(dot(r0.xyz, ro).add(r0.w), dot(r1.xyz, ro).add(r1.w), dot(r2.xyz, ro).add(r2.w)).toVar();
        const ld = vec3(dot(r0.xyz, rd), dot(r1.xyz, rd), dot(r2.xyz, rd)).toVar();
        const inv = vec3(1).div(vec3(safeDir(ld.x), safeDir(ld.y), safeDir(ld.z)));
        const ta = hs.negate().sub(lo).mul(inv), tb = hs.sub(lo).mul(inv);
        const tn = max(max(min(ta.x, tb.x), min(ta.y, tb.y)), min(ta.z, tb.z)), tf = min(min(max(ta.x, tb.x), max(ta.y, tb.y)), max(ta.z, tb.z));
        If(tf.greaterThanEqual(tn).and(tn.greaterThan(0.05)).and(tn.lessThan(best)), () => {
          best.assign(tn);
          // the face hit: the axis where the point is furthest out, in units of the half size
          const p = lo.add(ld.mul(tn)).div(hs).toVar(), a = abs(p);
          const nl = select(a.x.greaterThan(max(a.y, a.z)), vec3(sign(p.x), 0, 0), select(a.y.greaterThan(a.z), vec3(0, sign(p.y), 0), vec3(0, 0, sign(p.z))));
          nrm.assign(normalize(r0.xyz.mul(nl.x).add(r1.xyz.mul(nl.y)).add(r2.xyz.mul(nl.z))));
          alb.assign(col);
          h.x.assign(tn);
        });
      });
    });
    If(h.x.greaterThan(0), () => { out.assign(vec4(shade(ro.add(rd.mul(best)), nrm, alb), 1)); });
    return out;
  });
  return {
    B, boxCount, trace,
    // boxes: [{ inv: Matrix4 (world -> box), half: [x, y, z], color: Color }] (the other pods' parts)
    setBoxes(list) {
      const n = Math.min(list.length, MAX_PODS * POD_BOXES);
      for (let k = 0; k < n; k++) {
        const b = list[k], e = b.inv.elements, o = k * 20;
        // rows of the matrix (three's elements are column-major)
        boxData.set([e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14], b.half[0], b.half[1], b.half[2], 0, b.color.r, b.color.g, b.color.b, 0], o);
      }
      boxCount.value = n;
      boxAttr.needsUpdate = true;
    },
  };
}

// --- the spike: rays per second against the static world (dev: __homok.rtSpike) -----------------------------
// mode 'primary': through the pixels of the camera (coherent); 'random': from the camera in random directions
// (incoherent, the worst case); 'shadow': random directions, stop at the first hit
export async function rtSpike({ renderer, scene, camera, region, size = [960, 540], modes = ['primary', 'random', 'shadow'], reps = 10, check = 64, ordered = false }) {
  const t0 = performance.now();
  const geo = collectStatic(scene, region);
  const bvh = buildBVH(geo.tris);
  const packed = packBVH(bvh, geo.alb);
  const B = bvhBuffers(packed);
  const tBuild = performance.now() - t0;
  const [W, H] = size;
  const U = { camPos: uniform(new THREE.Vector3()), projInv: uniform(new THREE.Matrix4()), camWorld: uniform(new THREE.Matrix4()), seed: uniform(0) };
  const rt = new THREE.RenderTarget(W, H, { type: THREE.FloatType, depthBuffer: false });
  rt.texture.minFilter = rt.texture.magFilter = THREE.NearestFilter;
  const hash = (p) => fract(sin(dot(p, vec2(12.9898, 78.233))).mul(43758.5453));
  const out = {};
  const prevRT = renderer.getRenderTarget();
  for (const mode of modes) {
    const mat = new THREE.NodeMaterial();
    mat.fragmentNode = Fn(() => {
      const p = uv().toVar();
      const ro = U.camPos;
      let rd;
      if (mode === 'primary') {
        // (texture v runs down on this renderer)
        const c = U.projInv.mul(vec4(p.x.mul(2).sub(1), p.y.mul(-2).add(1), 1, 1));
        rd = normalize(U.camWorld.mul(vec4(c.xyz.div(c.w), 0)).xyz);
      } else {
        const a = hash(p.add(U.seed)).mul(6.2831853), z = hash(p.add(U.seed).add(17.3)).mul(2).sub(1);
        const r = float(1).sub(z.mul(z)).max(0).sqrt();
        rd = vec3(a.cos().mul(r), z, a.sin().mul(r));
      }
      const h = (ordered ? traceOrderedTSL : traceTSL)(B, ro, rd, 2000, mode === 'shadow');
      return vec4(h.x, h.y, h.z, 1);
    })();
    const quad = new THREE.QuadMesh(mat);
    U.camPos.value.copy(camera.position); U.projInv.value.copy(camera.projectionMatrixInverse); U.camWorld.value.copy(camera.matrixWorld);
    // compile, then draw until the pass really runs: WebGPURenderer builds pipelines asynchronously and draws
    // nothing until one is ready, so without this the timed passes can be empty
    // (never await with rt bound: the game's frame loop runs meanwhile, and its post chain draws its output into
    // whatever target is bound)
    renderer.setRenderTarget(rt);
    const compiling = renderer.compileAsync(quad, quad.camera);
    renderer.setRenderTarget(prevRT);
    await compiling;
    for (let k = 0; ; k++) {
      renderer.setRenderTarget(rt); quad.render(renderer); renderer.setRenderTarget(prevRT);
      const p = await renderer.readRenderTargetPixelsAsync(rt, W >> 1, H >> 1, 1, 1);
      if (p[2] > 0) break;
      if (k > 100) throw new Error('the ray tracing pass never ran');
      await new Promise((r) => setTimeout(r, 50));
    }
    if (renderer.backend.trackTimestamp) await renderer.resolveTimestampsAsync('render');
    const w0 = performance.now();
    for (let k = 0; k < reps; k++) { U.seed.value = mode === 'primary' ? 0 : k * 0.137; renderer.setRenderTarget(rt); quad.render(renderer); }
    renderer.setRenderTarget(prevRT);
    await renderer.backend.device.queue.onSubmittedWorkDone();
    const wall = (performance.now() - w0) / reps;
    const gpu = renderer.backend.trackTimestamp ? (await renderer.resolveTimestampsAsync('render')) / reps : null;
    // read back the last pass: mean traversal steps, hit share, and a check of some primary rays against the CPU BVH
    const px = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, W, H);
    let steps = 0, hits = 0;
    for (let i = 0; i < W * H; i++) { steps += px[i * 4 + 2]; if (px[i * 4] > 0) hits++; }
    let bad = 0, checked = 0;
    if (mode === 'primary' && check) {
      const hit = [0], v = new THREE.Vector3();
      for (let c = 0; c < check; c++) {
        const x = Math.floor(((c * 0.618034) % 1) * W), y = Math.floor(((c * 0.414214) % 1) * H);
        // rows of the readback run top-down on this renderer (pixel row y = texture v (y + 0.5) / H)
        v.set(((x + 0.5) / W) * 2 - 1, 1 - ((y + 0.5) / H) * 2, 1).applyMatrix4(camera.projectionMatrixInverse).transformDirection(camera.matrixWorld);
        const tc = traceClosest(bvh, camera.position.x, camera.position.y, camera.position.z, v.x, v.y, v.z, 2000, hit);
        const tg = px[(y * W + x) * 4];
        const cpu = tc === Infinity ? -1 : tc;
        checked++;
        if (Math.abs(cpu - tg) > Math.max(0.05, cpu * 0.002)) bad++;
      }
    }
    const ms = gpu ?? wall;
    out[mode] = { ms: +ms.toFixed(3), wallMs: +wall.toFixed(3), mrays: +((W * H) / (ms / 1000) / 1e6).toFixed(1), steps: +(steps / (W * H)).toFixed(1), hitShare: +(hits / (W * H)).toFixed(2), check: checked ? `${checked - bad}/${checked}` : undefined };
    mat.dispose();
  }
  rt.dispose();
  return { triangles: packed.triCount, nodes: packed.nodeCount, buildMs: Math.round(tBuild), rays: W * H, ...out };
}
