import * as THREE from 'three';

// ============================================================
//  Which renderer draws the game: the URL (?renderer=), else the choice saved in the menu
//  (RENDERELŐ), else WebGPU on desktops and WebGL on phones and tablets (the WebGPU path costs
//  about three times the CPU per frame; docs/visual-next-steps.md, B).
//   webgpu     three's WebGPURenderer on WebGPU: node (TSL) materials and the TSL post chain
//              (gfx/tsl/), with TRAA. Taken only when the browser hands out a WebGPU adapter.
//   webgl      WebGLRenderer with the GLSL patches and pmndrs postprocessing; also where WebGPU is
//              missing (WebGPURenderer's own WebGL2 backend is far slower than this)
//   webgpu-gl  WebGPURenderer forced onto that WebGL2 backend, for comparisons only
// ============================================================
const KEY = 'homokfutam:renderer';
const fromUrl = new URLSearchParams(location.search).get('renderer');
let saved = null;
try { saved = localStorage.getItem(KEY); } catch { /* storage blocked */ }
const touch = window.matchMedia?.('(pointer: coarse)').matches;      // as the quality guess does (gfx/quality.js)
const choice = fromUrl || saved || (touch ? 'webgl' : 'webgpu');
async function webgpuWorks() {
  try { return !!(navigator.gpu && await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })); } catch { return false; }
}
export const FORCE_GL = choice === 'webgpu-gl';
export const GPU = FORCE_GL || (choice === 'webgpu' && await webgpuWorks());
// for the menu: what is drawing, and whether WebGPU was asked for but is not available here
export const RENDERER = GPU ? 'webgpu' : 'webgl';
export const WEBGPU_MISSING = choice === 'webgpu' && !GPU;
export function saveRenderer(name) {
  try { localStorage.setItem(KEY, name); } catch { /* storage blocked */ }
}

// The WebGPU side loads only when it is used (three's WebGPU build and TSL are ~230 KB gzipped):
// W = three/webgpu, TSL = three/tsl, N = our node materials (gfx/tsl/), filled by loadNodes(),
// which main.js awaits before it builds anything.
export const W = GPU ? await import('three/webgpu') : null;
export const TSL = GPU ? await import('three/tsl') : null;
export const N = {};
export async function loadNodes() {
  if (GPU) Object.assign(N, await import('./tsl/index.js'));
}

// Shared uniforms: { value } objects for the GLSL materials, uniform / texture nodes for the node
// materials. Both have .value, so the code that drives them is the same on either renderer.
const WHITE = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
WHITE.needsUpdate = true;
export const U = (v) => (GPU ? TSL.uniform(v) : { value: v });
export const T = (t) => (GPU ? TSL.texture(t ?? WHITE) : { value: t ?? null });

// capabilities that the two renderers report in different places
export function maxTextureSize(renderer) {
  if (!renderer.isWebGPURenderer) return renderer.capabilities.maxTextureSize;
  const b = renderer.backend;
  return b.device?.limits.maxTextureDimension2D ?? b.gl?.getParameter(b.gl.MAX_TEXTURE_SIZE) ?? 4096;
}
export function maxAnisotropy(renderer) {
  return renderer.isWebGPURenderer ? renderer.getMaxAnisotropy() : renderer.capabilities.getMaxAnisotropy();
}
