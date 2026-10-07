import { buildBVH, packBVH } from './bvh.js';

// The BVH for the ray-traced reflections (gfx/tsl/rt.js), built off the main thread while the game boots:
// { tris, alb } in (Float32Arrays, transferred), the packed GPU layout out.
self.onmessage = (e) => {
  const t0 = performance.now();
  const bvh = buildBVH(e.data.tris);
  const p = packBVH(bvh, e.data.alb);
  self.postMessage({ ...p, ms: performance.now() - t0 }, [p.nodes.buffer, p.tris.buffer]);
};
