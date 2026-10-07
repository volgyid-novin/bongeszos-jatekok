# HOMOKFUTAM – visual next steps

Working notes for the next round of visual work on HOMOKFUTAM, written so a new session can pick
them up cold. Three parts:

1. **Two deferred items:** batching the exhaust plumes, and moving to WebGPU (three's `WebGPURenderer` with TSL node materials). The WebGPU move is now done behind `?renderer=webgpu`; section B has the results and what is left.
2. **Optional upgrades:** improvements that cost performance. Measure each one on its own, then decide whether it is worth it.
3. **How to measure:** the harness used so far, and the numbers to compare against.

## Where things stand (October 2026)

Commits on `homokfutam-aaa-map`, newest first:

| Commit | What changed |
|---|---|
| `f14d57a` | crowd rendered in Blender (sprite atlas), fake interiors in the arena wall openings |
| `8c3a70a` | dunes at mid distance, clay pans, oil and scorch streaks, berm width |
| `b73a3af` | new canyon walls (dipping sandstone beds, joints, sky occlusion), spires with dipping beds |
| `4461cf3` | light probes for the pods, AgX tone mapping, Oklab sky gradient |
| `ba33f36` | draw-call work: merged pods, batched pod effects, N8AO fixed and made cheaper, Low budget |

**Baselines.** Measured on an RTX 3080 Ti, headless Chrome (ANGLE/D3D11), 1920×1080 viewport, uncapped frame rate.

- These numbers are from after `ba33f36`. The later rounds were measured at the same values within noise.
- The draw counts are per frame and include the shadow pass.
- The resolution in brackets is the size actually rendered.

| Preset | Pixel ratio | fps (grid / dunes / canyon / arena) | Draws per frame | JS per frame |
|---|---|---|---|---|
| Low | 1 (1920×1080) | 596–765 | 202–302 | 1.1–1.5 ms |
| Medium | 1 (1920×1080) | 355–502 | 236–300 | 1.6–3.0 ms |
| High | 1 (1920×1080) | 383–404 | 265–325 | 2.1–2.6 ms |
| High | 2× screen, capped at 1.5 (2880×1620) | 219–272 | ~300 | 3–4.5 ms |
| Ultra | 2× screen (3840×2160) | 114–131 | ~300 | 6–9.5 ms |

**Cost of individual features.** Measured on High at 3360×1890, before `ba33f36`; those settings have changed since.

| Feature | Cost |
|---|---|
| Whole post-processing chain | ~3.0 ms |
| N8AO (half resolution, Medium quality) | ~1.5 ms; it was drawing nothing then, and is cheaper now |
| MSAA 4× | ~1.5 ms |
| God rays | ~0.4 ms |
| Heat shimmer | ~0 |
| Ground shader quality, level 2 vs 1 | ~0.2 ms |
| Speed-blur pass | not measurable |

**Draw calls on High (dunes spot), main pass:**
- 6 terrain chunks
- ~46 rock instanced meshes (empty LOD levels are hidden)
- 4 per pod (skinned meshes)
- 12 volumetric plumes and 6 beam strand meshes (see item A)
- 5 batched effect draws: throats, flames, flares, ground glow, ground shadow
- 8 particle pools, plus the sky, horizon, haze and crowd

---

## A. Batching the volumetric plumes (and the beam strands)

### What it is now

**Plumes** (`gfx/podfx.js`, `createPodFx` → `attach`):
- Each pod has one `ShaderMaterial` (`VOL_V` / `VOL_F`, raymarched, `STEPS` = 10/14/18 by preset).
- Each engine has a `Mesh(VOL_GEO, mat)` as its child, so there are 2 per pod and 12 draws in all.
- `update()` sets per-pod uniforms every frame: `uThr`, `uBoost`, `uOver`, `uIgn`, `uSput`, `uScale` (width, width, length) and `uSeed`.
- It also switches the material between `FrontSide` and `BackSide` when the camera is inside a plume's box, which happens in close chase views.
- The vertex shader computes `inverse(modelMatrix)` to march in the box's own space.

**Beam strands** (`gfx/beam.js`, `createBeam`):
- One mesh per pod, so 6 draws.
- They share an `InstancedBufferGeometry` with one instance per strand.
- Each has its own `ShaderMaterial` with ~16 uniforms: `uA`, `uB`, `uTime`, `uI`, `uArc`, `uWobble` and others.
- `onBeforeRender` sets `instanceCount` per pod.

Without post-processing (Low), the plume is a cheap cone (`PLUME_GEO` / `PLUME_F`) with the same uniforms.

### Why it was left for later

It is the riskiest of the batching work, for three reasons:
- Per-instance state has to replace 7 uniforms.
- The front/back face switch is per pod.
- The march needs the inverse instance matrix.

The other effect pieces (throats, flames, flares, ground glow and shadow) are already batched through `gfx/fxbatch.js`. That covers the easy cases.

### How to do it

1. **Use the existing batch helper.** Build on `FxBatch` (`gfx/fxbatch.js`): `push(matrix, ...values)` per pod each frame, then `flush()` in `podFx.endFrame()`. Per-instance attributes:
   - `aS0` = (thr, boost, over, ign)
   - `aS1` = (sput, seed, width, length)
2. **Vertex shader:** `mat4 m = modelMatrix * instanceMatrix; vCam = (inverse(m) * vec4(cameraPosition, 1)).xyz;`. Doing the inverse per vertex is fine: 8 vertices per box. Pass the per-instance state to the fragment shader as flat varyings.
3. **Two batches, one per facing.** Each frame, put a pod's plumes in the `BackSide` batch when the camera is inside its box (the test already exists in `update()`), otherwise in the `FrontSide` batch. Both batches keep `renderOrder = 4`, additive blending and `depthWrite: false`.
4. **Push timing.** Push from `podFx.update()` after `r.mesh.updateMatrixWorld(true)`, which is already there, using each plume's `matrixWorld` scaled as `update()` scales it now. Keep the plume meshes as plain `Object3D` anchors, as the throats are.
5. **Beam strands.** One `InstancedBufferGeometry` for every pod. Two ways to give each strand instance its pod's values:
   - **Data texture:** per pod, a row of 4–5 `vec4` texels with the uniforms. The strand reads its pod index from an attribute.
   - **Per-instance attributes:** total instances = pods × strands. Note that `count` switches to 2 strands per pod beyond 160 m (`camD > 160`).

### Expected gain and how to judge it

- **Gain:** about 16 fewer draw calls per frame (18 → 2–3). The GPU cost doesn't change, since the raymarch dominates.
- **Desktop:** about 0.05–0.1 ms of JS per frame, which is noise.
- **Phones:** maybe 0.3–0.5 ms. Measure with CPU throttling (see part 3).
- **Decision:** do it only if a throttled-CPU profile of `?q=low` or `?q=medium` is draw-call bound. Otherwise it's tidiness, not performance.

---

## B. `WebGPURenderer` and TSL: done, behind a switch

**Status (October 2026).** Every material, effect and the whole post chain now also exists as TSL node code, and three's `WebGPURenderer` draws the game.

- **Default:** WebGPU on desktops, wherever the browser hands out a WebGPU adapter; otherwise the classic `WebGLRenderer`. Phones and tablets (`pointer: coarse`, as the quality guess detects them) default to WebGL because of the CPU cost.
- **Menu:** the RENDERELŐ row (WEBGPU / WEBGL) switches; the choice is saved in `localStorage` (`homokfutam:renderer`) and the page reloads.
- **URL:** `?renderer=webgpu|webgl` overrides both; `?renderer=webgpu-gl` forces WebGPURenderer's WebGL2 backend, for comparisons only.
- **Cost:** the WebGPU path takes about three times the CPU per frame (see the measurements below). The default was switched anyway, for the image quality; WEBGL in the menu is the faster choice on weak CPUs.

### What it gives

- **TRAA** replaces MSAA and SMAA on Medium, High and Ultra. Temporal flicker under a slow pan, as the mean second difference |f(k+1) − 2f(k) + f(k−1)| in the frame centre (lower is steadier), WebGL High with MSAA vs WebGPU High with TRAA:

  | Spot | WebGL (MSAA 4×) | WebGPU (TRAA) | WebGPU, no AA |
  |---|---|---|---|
  | Sand glints | 0.80 | 0.38 | 0.44 |
  | Power line, distant | 0.16 | 0.08 | 0.10 |
  | Grid paving | 1.58 | 1.30 | 2.05 |
  | Crowd | 4.75 | 4.41 | 4.75 |

  The crowd number is dominated by the sprites turning towards the camera, not by aliasing. No ghosting was visible behind pods or plumes at full boost.
- **GTAO** (half resolution, depth-aware denoise) instead of N8AO.
- **No compile stutter.** Race start on WebGPU: worst frame 25 ms; on WebGL there is a 258 ms hitch.
- **What it unlocks next:** SSGI, per-object motion blur from the velocity buffer, compute shaders for the particle pools, and the GPU-side work for item A.

### How it is built

| File | What |
|---|---|
| `gfx/backend.js` | The switch (`GPU`, `FORCE_GL`). Lazy loading: `W` = `three/webgpu` and `TSL` = `three/tsl`, loaded with a top-level `await` only when needed; `N` = the node materials, filled by `loadNodes()` (main.js awaits it first). Shared uniforms: `U(v)` / `T(tex)` give `{ value }` objects for GLSL and uniform / texture nodes for TSL, so the CPU code that drives them (`.value = …`) is the same on both renderers. |
| `gfx/tsl/atmosphere.js` | Height fog as `scene.fogNode`. `SunLight`, a `DirectionalLight` whose registered light node multiplies the sun by `hfSunVis()` (baked world shadow × cloud shadow) for every lit material: the equivalent of the old `lights_fragment_begin` patch. The sky. `smoothPCF`, the near shadow filter. |
| `gfx/tsl/ground.js` | Terrain, track, rock and triplanar materials. `SurfaceMaterial` computes the surface once per fragment, in `setupDiffuseColor`, into property nodes that the colour, normal and roughness nodes read. `GroundLighting` adds the sand glint to the sun's direct light and applies the surface occlusion. |
| `gfx/tsl/podfx.js`, `beam.js`, `particles.js`, `dressing.js`, `pod.js` | The effects, crowd, cloth, haze, arena interiors, flame glows, and the pods' livery and probe blend. |
| `gfx/tsl/post.js` | Scene pass with an MRT of colour + velocity → GTAO + denoise → TRAA → heat shimmer / exhaust distortion / speed blur / chromatic aberration → [DoF] → god rays, bloom, lens flare → AgX → grade → sRGB. There are two `RenderPipeline`s, with and without DoF, chosen per frame. |
| `main.js` | `precompile()`: before the loading screen hides, one frame of each post graph is drawn with everything visible and unculled, then it waits for `queue.onSubmittedWorkDone()`. |

The GLSL path is unchanged, apart from the shared uniform objects and two loaders:
- WebGL output of the working tree vs the previous commit, from fixed cameras: within the run-to-run noise of the race sim.
- The WebGL page's JS is 513 KB gzipped, against 506 KB before. The WebGPU chunks (~240 KB gzipped) load only with `?renderer=webgpu`.

### Things that bit, and how they were solved

These are worth knowing before touching the TSL path:

- **`material.aoNode` never reached the lighting.** The lighting context brings its own `ambientOcclusion`, fixed at 1. The surface occlusion is applied in `GroundLighting.ambientOcclusion()` instead. Without it the canyon floor turned blue in the shade.
- **Instanced matrices in uniform buffers.** TSL puts an `InstancedMesh` whose matrices fit in a uniform buffer into one. three then rewrites that buffer for every draw, every frame (~1,200 `writeBuffer` calls per frame). It also bakes the instance count into the shader, which made ~40 extra pipelines of the rock shader. Fix: `renderer.backend.capabilities.getUniformBufferLimit = () => 0`. Instancing then goes through vertex attributes, and skeletons through a bone texture.
- **At most 8 vertex buffers per pipeline.** Attribute instancing plus the previous-frame matrix (for velocity) uses two buffers. The camera-facing batches (flame glows, beam flares) are therefore plain instanced geometry with a packed centre+size attribute (`FxBatch` `billboard` option).
- **Pipeline compilation.**
  - Pipelines are compiled the first time they are drawn, and the MRT scene pass needs its own variant of every material.
  - Swapping a `RenderPipeline`'s `outputNode` rebuilds its passes. Hence two pipelines.
  - `PassNode.compileAsync()` before the first render compiles for the wrong target (no MRT yet): ~115 wasted heavy pipelines. It is not used.
  - The GPU process keeps compiling after the warm-up, so the boot waits for it.
- **The TSL PCF filter rotates its taps by screen-space noise that does not change over frames.** It read as grain under the pods. `smoothPCF` is a 9-tap bilinear grid, like WebGL's PCF.
- **GTAO noise.** TRAA alone left speckle under the pods, and on the glows drawn over them; hence `denoise()`.
- **Transparent surfaces must not write velocity.** A plume's bounding box outlined itself as the ground inside it took the pod's motion. Velocity is written with alpha 1 by opaque materials and 0 by transparent ones, into a normally blended MRT attachment.
- **Render bundles.** `BundleGroup` for the static scenery gave +20 % fps. But replayed bundles kept stale camera-dependent state: the scene froze to the recording camera after some bind-group rebuilds, and crowd sprites were mis-placed. Removed; worth another try after a three update.
- **WGSL / WebGPU details:**
  - Comparison sampling is not allowed in vertex shaders. The particle and crowd shadow lookup moved to the fragment stage, at the centre.
  - `smoothstep` with low > high is undefined (`ss()` in `tsl/common.js` handles falling edges).
  - Render-target textures are sampled with v running down (trail map, shadow matrices).
  - `readRenderTargetPixelsAsync` returns rows top-down.
  - An `<img>` is uploaded premultiplied: the pod livery mask, whose alpha is 0, now loads as an unpremultiplied `ImageBitmap`.
  - The pod's UVs are dequantised by the map's texture transform. The livery has to use the same transform.
- **TSL refreshes `InstancedMesh` colours once per frame, not per render.** The trail map is drawn many times per frame while `sim()` fast-forwards, so its stamps use plain per-instance attributes.
- **The WebGL2 backend of `WebGPURenderer`.**
  - Explicit-LOD sampling of a depth texture returns a `vec4` where TSL expects a float; plain `.sample()` is used instead.
  - It is slow here (below), so the classic `WebGLRenderer` stays the fallback.

### Measurements

RTX 3080 Ti, headless Chrome with vsync and the frame-rate limit off, `perf(150)` at grid / dunes / canyon / arena. WebGPU needs those flags: with vsync on, headless WebGPU presentation stalls at 7–12 fps.

| Preset, size | WebGL fps (JS ms) | WebGPU fps (JS ms) |
|---|---|---|
| Low, 1920×1080 | 687–882 (1.0–1.3) | 269–353 (2.7–3.6) |
| Medium, 1920×1080 | 566–622 (1.5–1.6) | 176–189 (4.8–5.3) |
| High, 1920×1080 | 378–449 (1.9–2.4) | 162–176 (5.4–6.0) |
| High, 2880×1620 | 218–262 | 151–175 |
| Ultra, 3840×2160 | 117–140 | 92–129 |

- **CPU, not GPU.**
  - WebGPU High runs at about the same frame rate at 640×360 as at 1920×1080 (~190 fps in a quick check).
  - At 4K it is close to WebGL. The GPU cost of the WebGPU chain (TRAA, GTAO + denoise, …) is about the same as the WebGL chain's.
  - The gap is three's per-draw and per-pass CPU work in `WebGPURenderer`: render-object bookkeeping, node cache keys, and a uniform-buffer write per object.
  - Costs on WebGPU High: the whole post chain ~1.2 ms, static casters in the near shadow map ~1 ms. The heat layer cost ~0.4 ms as 13 separate quads; it is now one instanced draw (not re-measured).
- **Loading, High.**

  | Load | WebGL | WebGPU |
  |---|---|---|
  | First (cold profile) | 8.0 s | 11.4 s |
  | Repeat (persistent profile) | 3.5 s | 8.0 s |

  - The WebGPU time is pipeline compilation: ~57 large shaders (>30 KB of WGSL), many of them variants of the rock material.
  - The probe bake renders the scene into its own target format, so it needs a full second set.
- **WebGL2 backend of `WebGPURenderer`:** Low 96–157 fps, Medium ~30, High without post ~65. Not usable as a fallback.

### Recommendation

The first recommendation was to keep `WebGLRenderer` as the default until the WebGPU path is cheaper. Instead, WebGPU was made the default (for the image quality), with WebGL one click away in the menu.

Targets for the WebGPU path:
1. CPU per frame on High within ~1.5× of WebGL. That needs about −2.5 ms.
2. Cold load within ~2 s of WebGL.

Until then phones and tablets default to WEBGL (`pointer: coarse`, in `gfx/backend.js`); weak desktop CPUs may also be better off on WEBGL, but there is no reliable way to detect them up front.

### Next steps for B, in order of expected payoff

1. **CPU per frame:**
   - Render bundles for the static scenery once replay is reliable (+20 % measured).
   - A static-caster shadow map that is only redrawn when the shadow box moves by a texel row, instead of every frame (−1 ms).
   - A cheaper bloom (BloomNode is 12 passes), and merging the quad passes that do not need their own target.
   - Item A (one draw for all plumes and beams) is worth more here than on WebGL.
   - Rock LOD sets as an indirect `BatchedMesh`.
2. **Load time:**
   - Turn the rock material's compile-time variants (arena, AO attribute, vertex colours) into uniforms, which collapses ~20 shaders into a few.
   - Bake the probes with the cheaper ground shader (`groundQ` 0).
3. **Use the unlocks:**
   - Per-object motion blur instead of the radial speed blur.
   - SSGI for red bounce light in the canyon.
   - Compute particles.
   - Drop the GLSL path once WebGPU is the default and WebGL is the fallback only.

---

## C. Upgrades that cost performance (measure one at a time)

**The A/B switch.** Put each upgrade behind a `?gfx=` key so it can be switched on and off in the same build.
- `gfx/quality.js` only accepts keys that exist in `PRESETS`. Add each new key to all four presets, defaulting to off.
- Then e.g. `?q=high&gfx=csm:1` vs `?q=high&gfx=csm:0`.

**Decision rule.** On the reference GPU at the High preset and 2560×1440 (or the 2× pixel-ratio runs above):

| Cost | Decision |
|---|---|
| ≤ 0.3 ms | enable on High if the gain is visible in the montage |
| 0.3–1.5 ms | Ultra only, unless the gain is large |
| > 1.5 ms | only for a major gain, and only on Ultra |

Also check the effect on draw calls and JS time on Low and Medium. Keep Low at about 300 draws and 1.5M triangles or less.

Ordered by my guess of gain per cost:

### 1. Physically based sky and aerial perspective (low cost)

- **Gain:** a richer, correct horizon gradient and distance haze. Mountains and buttes shift towards blue with distance the way real air does. The fog and sky colors stay consistent because they come from one model.
- **How:** Hillaire 2020 lookup tables: transmittance, multi-scattering and sky view, plus an aerial-perspective volume. The sun never moves, so bake them once at load in `gfx/atmosphere.js`. The sky shader and `hfFogTint` / `hfFogAmount` then read the tables.
- **Cost:** load time (a few ms of GPU) plus 1–2 texture reads per fogged pixel.
- **Measure:** frame time at the dunes spot (lots of sky and distance).

### 2. Cascaded / sharper near shadows

- **Now:**
  - One 2048 map covers a 130 m box in front of the camera (High; 4096 and 150 m on Ultra).
  - A static 4096 world bake covers ~4 km, about 1 m per texel, so shadows beyond the box are soft and blobby.
  - Pods far ahead have no shadow.
- **How:** three's `CSM` addon (`three/addons/csm/CSM.js`) with 3 cascades, e.g. 0–40 m, 40–150 m and 150–600 m. Pods and rocks keep casting, and the static bake stays for beyond 600 m. Alternatively, a second static bake at 8192 over the track corridor only.
- **Cost:** +1–2 shadow passes (each ~100–130 draws on High, so CPU) plus shadow sampling per pixel.
- **Measure:** draws per pass with the draw-call census, fps at the grid and canyon.

### 3. Parallax occlusion mapping on the ground (near only)

- **Gain:** ripples, gravel, paving and the track's grooves get real depth and self-occlusion at grazing angles near the pod. This is the biggest close-up ground gain.
- **How:** the height is already in the alpha channel of `ground_c`. In `gBlend`, for the 2–3 heaviest layers within ~40 m, march 8–16 steps along the view ray in texture space, then fetch color and normal at the offset uv. `GQ` 2 only.
- **Cost:** fill rate, about +8–16 fetches per near-ground pixel. Expensive at high pixel ratios; likely Ultra only.
- **Measure:** 2× pixel-ratio fps at the grid (paving) and dunes, plus a close-up montage.

### 4. Real-time reflections on the player's pod

- **Gain:** the other pods, boost flames and nearby track show up in the player's metal and canopy. That isn't possible with the static probes.
- **How:** a `CubeCamera` at 64–128 px, one face per frame, rendering only terrain, rocks, arena, sky and other pods (no particles or effects) via camera layers. Feed it to the player's pod materials as `envMapB`, which is already wired through `podEnvPatch`. Either run PMREM on it every few frames, or sample the raw cube with a roughness-based mip.
- **Cost:** +60–150 draws per frame (CPU) plus a small GPU pass; PMREM is ~10 small passes.
- **Measure:** JS time and draws on High, and a close-up montage behind the player.

### 5. True volumetric light in the canyon and under the arch

- **Gain:** real light shafts through dust where the sun cuts into the slot, instead of the transparent haze sheets (`world/haze.js`) plus screen-space god rays.
- **How:** a half-resolution post pass that raymarches the height fog plus a dust density (noise), sampling the static world shadow (`hfShadowMap`). It runs only where the canyon or arch fills the screen, gated by a zone uniform. Composite before bloom.
- **Cost:** ~0.5–1.5 ms at 1440p for 16–32 steps.
- **Measure:** canyon spot fps, and a montage of the canyon and arch.

### 6. Better AO

- **Options:** N8AO "High" quality on High (now "Medium"), full resolution on Ultra (now half, since `ba33f36`), or a larger radius for big shapes (stands, canyon base).
- **Cost:** half resolution "Medium" was ~1.5 ms at 3360×1890 including the extra transparency renders that are now gone. Full resolution "High" was about 2–3× that on Ultra before `ba33f36`.
- **Measure:** `?gfx=ao:1` variants, plus the AO-only view (`__homok.post.ao.configuration.renderMode = 1`).

### 7. Clearcoat paint on the pods

- **Gain:** sharp, glossy highlights on the painted panels over the worn base.
- **How:** use `MeshPhysicalMaterial` with `clearcoat` for the `PodAtlas` materials in `playerPod.js`, with the clearcoat mask from the livery's paint channel. That means a small patch in `patchLivery`.
- **Cost:** a heavier shader, but pods cover few pixels; it also adds one more program.
- **Measure:** close-up montage, and fps on the grid with all 6 pods on screen.

### 8. Denser near-track clutter and swaying dry grass

- **Gain:** a richer mid-ground at speed.
- **How:** more instances in `world/scatter.js` within 60–80 m, plus a grass-tuft card mesh with vertex sway (like the cloth in `world/dressing.js`). No shadow casting.
- **Cost:** vertices plus 2–4 draws; overdraw if the cards are alpha-tested.
- **Measure:** triangle and draw counts on Low (keep it off there) and fps on High at the dunes spot.

### 9. More geometry for rocks and canyon walls

- **How:**
  - Spire LOD0 from 12k to 30–40k triangles, and LOD switch distances ×1.5 on Ultra (`build_rocks.py`, then the `Q.lod` factor).
  - Canyon walls: `STEP` from 2 m to 1 m and `J` from 56 to 90 within ~150 m of the track (`main.js`, the canyon block).
- **Cost:** triangles in both the main and shadow passes.
- **Measure:** `tris` from `perf()`, fps at the canyon spot.

### 10. Particle quality

- **How:** denser dust and smoke behind the pods, larger flipbooks (more frames: `build_flipbooks.py`), and sand streamers across the track at high speed. Optionally, a shadow lookup per particle (the crowd already does this per vertex).
- **Cost:** overdraw. The worst case is a full grid boosting at the start.
- **Measure:** fps at the arena start right after "RAJT!" with all bots boosting.

### 11. Volumetric clouds

- **How:** a cheap 2.5D raymarch of 6–8 steps through a cloud slab, replacing the 2D cloud layer in the sky shader. The cloud shadows on the ground stay as they are.
- **Cost:** sky pixels can be half the screen; ~0.3–1 ms.
- **Measure:** dunes spot fps, sky montage.

### 12. Anti-aliasing tiers (if WebGPU/TRAA is not pursued)

- **Options:** SMAA on top of MSAA on High, or 1.5× supersampling on Ultra.
- **Cost:** supersampling at 1.5× is about 2.25× the fill cost, and is only worth considering for screenshots / photo mode.

---

## Measuring: harness and method

The scripts used so far lived in the session scratchpad and are not in the repo. Recreate them as below, or ask to have them added under `homokfutam/tools/` first.

### Browser

- `puppeteer-core` driving the locally installed Chrome (`C:/Program Files/Google/Chrome/Application/chrome.exe`), `headless: 'new'`.
- Args: `--mute-audio --use-angle=d3d11 --enable-gpu --ignore-gpu-blocklist --disable-gpu-vsync --disable-frame-rate-limit`. The last two give uncapped fps. For `?renderer=webgpu` add `--enable-unsafe-webgpu`, and always use the last two: with vsync on, headless WebGPU presentation stalls at 7–12 fps.
- **Silence:** `--mute-audio` alone is not enough. In `page.evaluateOnNewDocument`, stub `speechSynthesis.speak` (the announcer plays through the OS speech engine) and keep every `AudioContext` suspended.
- **Loading:**
  - Start Vite with `--host 127.0.0.1` (it otherwise listens on `::1` only here).
  - Wait for `#loading` to be hidden.
  - Retry with a fresh `page.goto` when a load stalls. Headless Chrome sometimes drops a request with `ERR_NO_BUFFER_SPACE`.

### Debug hooks

`window.__homok`, on localhost only:

| Hook | What it does |
|---|---|
| `start(laps, diff, intro)` | starts a race |
| `sim(seconds)` | fast-forwards the race |
| `perf(frames)` | → `{fps, jsMs, calls, tris, ratio}` |
| `view({eye, look, fov, abs})` | debug camera: pod-relative, or world space with `abs: true`; `view(null)` restores |
| `force({...})` | forces inputs on the player, e.g. boost |
| `crash(n, power)` | visual crash on racer n |
| `podEnv(k)` | 0 = sky-only lighting on the pods; k = probes at strength k |
| `rebakeProbes()` | bakes the light probes again |
| `rocks` | the rock lists, for framing spires |
| `groundDebug(n)` | ground shader debug views |
| `post`, `scene`, `renderer`, `camera` | for direct probing |
| `ATMO`, `TSL`, `GPUTHREE`, `GPU`, `trails` | the shared atmosphere uniforms (freeze `ATMO.hfTime` to stop shader time on either renderer), three's TSL and WebGPU modules on the WebGPU path, the trail map |

On the WebGPU path `post` has `grade` / `speed` / `flare` handles with the same `uniforms.get(...)` as the WebGL chain, and `post.ao.setAoOnly(true)` shows the AO alone.

### Benchmark

- **Spots:** grid (`start` + 0 s), dunes (+10 s), canyon (+10 s), arena (+20 s). `perf(150)` at each.
- **Two runs:** DPR 1, which is mostly CPU-bound and shows draw-call and JS changes, and DPR 2 (deviceScaleFactor 2), which is GPU-bound and shows shader and fill changes.
- **Pass the renderer explicitly** (`renderer=webgl` or `renderer=webgpu`): without it the page uses the menu's saved choice or the WebGPU default.
- **Interleave A and B** (A, B, A, B). Check for other GPU load first: in this session the user's own dev server and Chrome running the game skewed one run by ~35%.

### Draw-call census

- Wrap `renderer.renderBufferDirect` for one frame and tally calls and triangles. On `WebGPURenderer` wrap `renderer._renderObjectDirect` instead; `perf()` reports `info.render.drawCalls` there.
- Split by pass: a `MeshDepthMaterial` or `MeshDistanceMaterial` means the shadow pass.
- Split by object family: `userData.terrain`, `.rock`, `.scatter`, otherwise the nearest named ancestor and the material name.

### Mobile proxy

- Chrome DevTools Protocol `Emulation.setCPUThrottlingRate` with `{ rate: 4 }` on `?q=low` and `?q=medium`, comparing JS ms per frame.
- On Windows the real GPU is still used, so this only models the CPU side.

### Visual A/B

- Same build: switch the variant at runtime.
- Different builds: `git archive` of the base commit into a scratch folder, with a junction to the repo's `node_modules`, served on another port. Its Vite config needs `resolve: { preserveSymlinks: true }`. Otherwise the basis transcoder wasm is requested via `/@fs/…`, comes back as HTML, and the copy silently runs without KTX2 textures.
- **Freeze before each capture:**
  - pause the race (Escape)
  - set a static `view()`
  - freeze the shared `uTime` uniform: `ATMO.hfTime` (or, on older builds, any material with `uniforms.uTime`), by redefining `value` with a getter; restore it by redefining it as a plain writable value, not with `delete` (a node with no `value` breaks the next shader build)
  - compare from fixed world-space cameras (`view({ eye, look, abs: true })`): the race sim is not deterministic, so pod-relative views land in different places on each run
  - a WebGPU canvas can only be read (`drawImage`, screenshots) after the frame is presented: step one frame per `requestAnimationFrame`
  - set the grade's `uGrain` to 0
- Then tile the variants side by side into one image.
