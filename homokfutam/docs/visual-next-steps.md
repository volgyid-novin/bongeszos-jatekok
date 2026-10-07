# HOMOKFUTAM – visual next steps

Working notes for the next round of visual work on HOMOKFUTAM, written so a new session can pick
them up cold. Three parts:

1. **Two deferred items:** batching the exhaust plumes, and moving to WebGPU (three's `WebGPURenderer` with TSL node materials). The WebGPU move is now done behind `?renderer=webgpu`; section B has the results and what is left.
2. **Optional upgrades:** improvements that cost performance, each measured on its own. All eleven are now done, each behind a `?gfx=` key, and the High and Ultra presets switch on the ones worth their cost; section C has the results and what is left.
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

## C. Upgrades that cost performance: done, each behind a `?gfx=` key

**Status (October 2026).** Items 1–11 are implemented on both renderers, each behind its own key, and the presets switch them on by the decision rule below. Item 12 is moot: TRAA on WebGPU (section B) replaced it.

- **Keys:** `sky`, `csm`, `pom`, `refl`, `vol`, `aoq` (0, 1 or 2), `coat`, `grass`, `geo`, `clouds`, `parts`. All exist in all four presets in `gfx/quality.js`; `?gfx=sky:1` or `?gfx=grass:0` overrides a preset.
- **Load-time choices:** each key changes what is built (shader variants, meshes, passes), so switching one reloads the page, like the preset itself. The GLSL chunks read their key once at import (`PB_SKY`, `MID_SHADOW`, `VCLOUDS` in `gfx/atmosphere.js`, `COAT` in `playerPod.js`); the node graphs are built for one or the other.

**Decision rule.** On the reference GPU at the High preset and 2560×1440 (or the 2× pixel-ratio runs):

| Cost | Decision |
|---|---|
| ≤ 0.3 ms | enable on High if the gain is visible in the montage |
| 0.3–1.5 ms | Ultra only, unless the gain is large |
| > 1.5 ms | only for a major gain, and only on Ultra |

Low and Medium get none of them: they keep their draw and triangle budgets (Low: ~300 draws, ≤ 1.5M triangles).

### Results

RTX 3080 Ti, headless Chrome. Each key measured on its own against the same build with it off, interleaved, median of 2 rounds, High at 2560×1440 at the four benchmark spots. GPU time is the WebGPU timestamp-query total of all render passes (`?gputime`, see part 3); CPU is the JS time per frame on WebGPU at 1920×1080; the WebGL column is the change in frame time at 2560×1440 (mostly GPU-bound there; noise about ±0.3 ms).

| # | Key | WebGPU GPU | CPU (WebGPU) | WebGL frame | Preset | Why |
|---|---|---|---|---|---|---|
| 1 | `sky` | +0.2–0.5 ms | – | ≈ 0 | Ultra | cost; it also shifts the palette (see below) |
| 2 | `csm` | +0.05–0.1 ms | +0.2 ms avg (redraw spike 1.8 ms ~1/s) | +0.2–0.5 ms | High | sharper shadows 100–600 m out, far pods cast real shadows |
| 3 | `pom` | +0.1–0.3 ms | – | +0.1–0.7 ms | Ultra | shows only in close-ups (photo mode, ground-level cameras) |
| 4 | `refl` | +0.2–1.2 ms | +1.5–2 ms with a face every frame; it now draws one every other frame | +0.3 ms, +100 draws | Ultra | CPU |
| 5 | `vol` | canyon +0.45 ms (24 steps; it now takes 16), elsewhere ~0 | – | canyon +0.5 ms, elsewhere 0 | High | large gain where it runs, nothing elsewhere |
| 6 | `aoq` | 1: +0.1–0.3 ms, 2: +1.0–1.75 ms | – | 1: +0.3–0.5 ms | High and Ultra: 1 | full resolution (2) is not worth its cost |
| 7 | `coat` | +0.16 ms at the grid, ~0 elsewhere | – | ≈ 0 | High | cheap; the player's pod is on screen all race |
| 8 | `grass` | +0.1–0.3 ms | +0.2–0.3 ms, +2–7 draws | ≈ 0 | High | richer mid-ground |
| 9 | `geo` | +0.15–0.3 ms; triangles 3.45M → 5.7M | – | +0.2–0.5 ms | Ultra | triangles cost far more on weaker GPUs than here |
| 10 | `parts` | ≈ 0 (start grid, all boosting) | ≈ 0 | ≈ 0 | High | denser dust and smoke, streamers |
| 11 | `clouds` | +0.2–0.35 ms | – | +0.1–0.7 ms (at 12 steps; it now takes 16 there) | High | big visible gain over half the screen |

Totals with the new presets against the same build with every key off: see "Totals" at the end of this section.

### 1. Physically based sky and aerial perspective (`sky`)

- **Built:** `gfx/skylut.js` bakes Hillaire 2020's tables on the CPU in a worker at load (`gfx/skylut.worker.js`, ~0.3 s, hidden behind the world build): transmittance 256×64, multiple scattering 32×32, sky view 192×112 at ground level (u = azimuth from the sun, symmetric, so 0..π; v = elevation, denser at the horizon). The sun never moves, so the bake happens once. `boot()` builds the environment map after it.
- **Sky:** the table (Rayleigh, a thin aerosol, ozone ×2 for a deeper zenith, multiple scattering, sand albedo) times `hfSkyE`, then the low dust in front of it out to infinity.
- **Fog / aerial perspective (`hfAerial`):** per pixel, in closed form. Rayleigh at ground density over the distance × `hfApScale` (3: the world is a few km, real air needs tens to turn things blue); the old exponential height fog becomes the low dust layer with an albedo and a two-lobe Henyey–Greenstein phase, lit by the scene's sun (`hfSunCol`, the same light as the ground), the multiple scattering from the tables and the sunlit sand under it. The two are combined by optical depth, per channel: transmittance `T` and in-scatter `S`, so additive materials fade by `T` and the rest get `col × T + S`.
- **Calibration:** with real coefficients the dust haze came out ~1.6× brighter than the hand-tuned fog, and the aerosol's forward lobe blew out everything near the sun through the bloom. The dust's "albedo" (0.56, 0.43, 0.27) keeps the old fog colour side-on (it stands for the albedo and the light lost inside the layer), its phase is a gentle g = 0.3, and the aerosol is kept thin (0.8× Hillaire's clear sky, g = 0.65). The node-graph and GLSL versions share every constant.
- **What it looks like:** away from the sun, distant mesas and the horizon ranges now layer into blue-violet with distance; the sky is a paler, more natural blue; looking towards the sun the haze is brighter. It is a palette shift from the hand-tuned look (warmer, more saturated), which is why it is not on High even though it is nearly free on WebGL. Decide by eye: `?gfx=sky:1` vs `sky:0`.

### 2. Cached mid-distance shadow (`csm`)

- **Not three's CSM:** three cascades re-rendered every frame would add ~150–200 shadow draws a frame, ~1.5–2 ms of CPU on the WebGPU path, which is CPU-bound already.
- **Built (`createMidShadow`, `gfx/atmosphere.js`):** the static world once more, into a 2048×1024 depth map over a 640×320 m light-space box (≈0.3 m per texel; Ultra 4096×2048 over 760×380 m) placed ~230 m ahead of the camera. Only static casters, on a layer of their own (7), so it is redrawn only when the wanted box has moved an eighth of its size, about once a second at race speed (100–120 draws, 0.5 ms on WebGL, 1.8 ms on WebGPU, then nothing until the next).
- **Far pods:** a quarter-size map of the pods alone (layer 8), drawn every frame while a pod is in the box and more than 75 m away (~20 draws). Their shadows used to be only the soft blob; now they have their real outline out to ~600 m.
- **Sampling:** `hfStaticShadow` takes the mid map inside the box (fading at its edge) instead of the 1 m world bake, so everything that reads the bake gets sharper: the lit materials' sun, the haze, the volumetric light.

### 3. Parallax occlusion on the ground (`pom`)

- **Built (`gParallax` in both `gfx/ground.js` and `gfx/tsl/ground.js`):** the view ray is marched (6–14 steps) through the height field of the *dominant* layer only, then every layer is looked up at the hit; a 5-step march towards the sun shades the lee side of ripples and grooves. Marching every layer was out of the question, and following one layer avoids seams where layers swap.
- **Faded by the pixel footprint,** not by distance: off once a pixel covers more than ~1.6 cm of ground. Without that, ripples 8–20 m away turned to mush: the march is far too coarse for them there.
- **Result:** at photo-mode heights (0.5 m) the relief is real (crests hide what is behind, lee sides darken); from the chase camera (2–4 m up) the ground is already too foreshortened for it to show. Hence Ultra.
- **Compile time:** the sun march first unrolled into seven inlined copies of the height fetch in WGSL, and the cold compile of the terrain and track shaders took 11 s longer. As a loop it is ~1 s. (A `setLayout` TSL function would be the cleaner fix, but in this three version a laid-out function cannot reach the texture bindings.)

### 4. Live reflections on the player's pod (`refl`)

- **Built (`createLiveEnv`, `gfx/probes.js`):** a cube camera at the player's pod renders one face every other frame into a 256² half-float cube, of everything on layer 9: ground, rock, buildings, sky, horizon and the other pods; no particles or effects. Once all six faces are new it is prefiltered (PMREM) to the probes' size, so it drops into the pod's materials in place of the probe pair without a shader change (`setPodEnv`).
- **Gain:** the paving, the stands and the neighbouring pods show in the player's metal and canopy (a mirror test confirms orientation). On the worn paint it is subtle; with `coat` it shows more.
- **Cost:** a face is a full scene pass with 50–140 draws, ~1.5–2 ms of CPU on WebGPU; every other frame halves that, and the cube is at most 12 frames old.

### 5. Volumetric light in the canyon and under the arch (`vol`)

- **Built:** a half-resolution pass marching the view ray (16 steps; 24 on WebGL Ultra, which has no TRAA; up to 220 m) through extra dust that hangs low in these places (a zone sphere around the arch, the slot around the camera in the canyon), lit by the sun as far as `hfStaticShadow` lets it through. WebGPU: composited into the scene colour before TRAA, which averages the per-frame jitter. WebGL: a `VolPass` into a half-size target and a composite effect, with a fixed per-pixel jitter.
- **Zone:** `volZone()` in `main.js` sets how far the camera is in the canyon or under the arch (and fades the old dust sheets of `world/haze.js` out as the volume comes in). Outside both, the passes do not run at all.
- **Tuning that mattered:** shadowed dust must glow at about the level of the shaded walls (sky and bounce light), or the canyon fills with dark smoke; the arch's dust must stay within ~75 m of it, or the whole landscape seen through it hazes over.

### 6. Better AO (`aoq`)

- `aoq:1`: WebGPU GTAO +8 samples, radius 4 → 6 m, thickness 2 → 3; WebGL N8AO one quality mode up, radius 5 → 7 m. The stands, the canyon foot and the bays get their contact darkening.
- `aoq:2`: also at full resolution: sharper fine detail, +1.0–1.75 ms at 1440p. Not enabled anywhere.

### 7. Clear coat on the pods (`coat`)

- The `PodAtlas` materials become physical materials with a clear coat (roughness 0.07) where the livery's paint masks (R, G) say the paint is intact; the worn metal keeps its rough base. GLSL: `withCoat()` + a line in `patchLivery`; TSL: `clearcoatNode` from the same masks.

### 8. Dry grass and denser near-track clutter (`grass`)

- **Grass (`world/grass.js`):** tufts of 34 thin curved blades, real geometry (no alpha-tested cards: no overdraw, nothing for the anti-aliasing to shimmer on), straw coloured, swaying with the wind (gusts travelling along it, a flicker across it), tips moving most. ~40k tufts in clumps beside the track (2–60 m out, none on gravel, slopes or in the canyon), drawn within 75 m. No shadows.
- **Chunks, not the rock LOD fields:** the tufts sit in 130 m chunks along the track, one instanced mesh each, uploaded once; a chunk is shown by distance and frustum-culled by three. Through `LodInstances` they cost ~2 ms of CPU a frame (re-sorting and re-uploading tens of thousands of matrices as the camera moved); three shapes per chunk still cost ~0.5 ms in draws. The copies are only moved and scaled (never turned or mirrored, which would flip the double-sided blades' normals), so the sway can use the wind in world space.
- **Clutter:** twice the pebbles within ~70 m of the track, in the existing pebble meshes (no new draws).

### 9. More geometry (`geo`)

- **Canyon walls:** swept every 1 m instead of 2, with 90 rows instead of 56: the fine noise, the joints and the hard beds' lips resolve instead of aliasing between rows. Clearly visible.
- **Spires:** `build_rocks.py -- --hi 1` writes `assets/world/rocks_spires_hi.glb` (36k / 12k / 3.5k triangles per spire instead of 12k / 3.5k / 1k; 2.3 MB, loaded only with the key) and the LOD distances go ×1.5. A modest gain at mid range.
- Triangles on High: 3.45M → 5.7M (main and shadow passes). On Low it would be ~2.1M, over its budget.

### 10. Particles (`parts`)

- Every pool and emission rate ×1.5 (denser dust and smoke behind the pods); sand streamers: short ribbons of grains sliding across the track ahead in the wind at speed (a stretched `spark` pool).
- Not done: re-rendering the flipbooks with more frames (the shader already cross-fades frames, so the gain is small for a long Mantaflow + Cycles run); per-particle shadow lookups were already there.

### 11. 2.5D clouds (`clouds`)

- The sky's cloud layer becomes a 650 m slab marched in 10 steps (WebGPU, jittered per frame for TRAA) or 16 (WebGL, fixed 4×4 ordered dither), over at most the first ~2 km of the slab along the ray (at grazing angles a longer march bands the cloud edges near the horizon): the flat layer's noise read as columns, with flat bases, rounded tops and eroded edges, each step lit through two density samples towards the sun (self-shadowing, a silver lining towards it, darker bases) plus sky light. The cloud shadows on the ground keep using the flat layer at the slab's base, so they still line up.
- On WebGL the lookups are at an explicit mip level: with implicit derivatives inside the loop the D3D compiler's output cost +1.4–2.3 ms; with explicit LOD +0.1–0.7 ms.

### Things that bit

- **An orthographic camera set to WebGPU's coordinate system must rebuild its projection** (`updateProjectionMatrix()`). The renderer only fixes cameras whose system differs from its own, so a camera already set to WebGPU kept WebGL's −1..1 depth, and half the depth range was clipped: the mid map silently lost everything above the ground plane (the canyon floor came out sunlit).
- **WebGL allocates a depth texture only when it is first drawn into;** sampling it before that drops the draw (`GL_INVALID_OPERATION: Mismatch between texture format and sampler type`). The pods map is drawn once at creation for that reason.
- **First load after a shader change:** shader compiles are cached by the driver, so a second load hides them. Measure load-time regressions on a cold shader (change a constant), as for `pom` above.
- **Physically based is not automatically better:** the sky and the dust needed calibrating against the art direction (the bloom amplifies any bright haze).

### Totals

Each preset as it is now against the same preset with every key off (`?gfx=sky:0,csm:0,...`), grid / dunes / canyon / arena, median of 2 interleaved rounds:

| Preset, size, renderer | Frame time, all off → as shipped | GPU time (WebGPU) |
|---|---|---|
| High, 1920×1080, WebGPU | 6.5 / 6.1 / 6.8 / 6.5 → 6.8 / 6.8 / 7.4 / 7.3 ms (CPU-bound; JS +0.5–0.8 ms) | – |
| High, 2560×1440, WebGPU | 6.5 / 5.9 / 6.7 / 6.4 → 6.9 / 6.8 / 7.4 / 7.3 ms | 4.6 / 3.3 / 4.8 / 3.0 → 5.2 / 4.1 / 5.9 / 3.7 ms |
| High, 2560×1440, WebGL | 4.1 / 3.3 / 3.7 / 3.4 → 5.1 / 3.9 / 4.8 / 5.2 ms | – |
| Ultra, 2× screen (3840×2160), WebGPU | 10.6 / 8.5 / 10.9 / 6.9 → 14.0 / 11.4 / 14.7 / 9.4 ms | 9.9 / 7.5 / 10.2 / 7.0 → 10.9 / 10.9 / 14.1 / 9.3 ms |
| Ultra, 2× screen, WebGL | 8.4 / 7.3 / 7.1 / 6.2 → 10.9 / 9.1 / 12.8 / 9.2 ms (reflections a face every frame then; now every other) | – |

- **High** pays ~0.4–0.9 ms a frame on WebGPU (5–11 % of the frame rate) and 0.6–1.9 ms on WebGL, still 190–255 fps at 1440p here.
- **Ultra** at 4K is GPU-bound: +1–4 ms of GPU. Of that, the High set is +1.1–2.9 ms at this resolution (clouds and `aoq` alone ~1–1.8 ms; in the canyon the volume) and the four Ultra-only keys ~+1 ms more. Still 68–106 fps here; on smaller GPUs the dynamic resolution steps in. If Ultra needs to get cheaper, `aoq` back to 0 and `clouds` at half resolution are the first places to look.
- **Low and Medium** are unchanged (all keys off).
- **Load:** warm loads are unchanged (~11.5 s for High on WebGPU in this harness). On a cold shader cache, everything compiles anyway after any shader change; `sky` makes every material's fog a little bigger.

### What is left in C

1. **`sky` on High** once the palette shift is accepted: it is ~free on WebGL and 0.2–0.5 ms on WebGPU.
2. **Clouds at half resolution** (render the sky's cloud term into a half-size target, upsample): would bring `clouds` under 0.2 ms at 4K.
3. **Live reflections on High:** needs a cheaper face pass (render bundles, or only the nearest pods and a few big meshes per face).
4. **Volumetric light in more places:** the same pass works anywhere `hfStaticShadow` has structure (under the arena gantry, by the mesas at the start); only `volZone()` needs to know about them.
5. **Flipbooks with more frames:** only if close-ups of smoke show the cross-fade.

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
| `perf(frames)` | → `{fps, jsMs, calls, tris, ratio}`, plus `gpuMs` with `?gputime` (below) |
| `view({eye, look, fov, abs})` | debug camera: pod-relative, or world space with `abs: true`; `view(null)` restores |
| `force({...})` | forces inputs on the player, e.g. boost |
| `crash(n, power)` | visual crash on racer n |
| `podEnv(k)` | 0 = sky-only lighting on the pods; k = probes at strength k |
| `rebakeProbes()` | bakes the light probes again |
| `rocks` | the rock lists, for framing spires (`rocks.arch`: the arch's position) |
| `mid` | the cached mid-distance shadow (`?gfx=csm:1`): `renders`, `draws`, `update(camera, true)` |
| `groundDebug(n)` | ground shader debug views |
| `post`, `scene`, `renderer`, `camera` | for direct probing |
| `ATMO`, `TSL`, `GPUTHREE`, `GPU`, `trails` | the shared atmosphere uniforms (freeze `ATMO.hfTime` to stop shader time on either renderer), three's TSL and WebGPU modules on the WebGPU path, the trail map |

On the WebGPU path `post` has `grade` / `speed` / `flare` handles with the same `uniforms.get(...)` as the WebGL chain, and `post.ao.setAoOnly(true)` shows the AO alone. `post.vol` (WebGPU) and `post.vol.fullscreenMaterial.uniforms` (WebGL) hold the volumetric light's uniforms (`?gfx=vol:1`).

### Benchmark

- **Spots:** grid (`start` + 0 s), dunes (+10 s), canyon (+10 s), arena (+20 s). `perf(150)` at each.
- **Two runs:** DPR 1, which is mostly CPU-bound and shows draw-call and JS changes, and DPR 2 (deviceScaleFactor 2), which is GPU-bound and shows shader and fill changes.
- **Pass the renderer explicitly** (`renderer=webgl` or `renderer=webgpu`): without it the page uses the menu's saved choice or the WebGPU default.
- **Interleave A and B** (A, B, A, B). Check for other GPU load first: in this session the user's own dev server and Chrome running the game skewed one run by ~35%.
- **GPU time on WebGPU:** `?gputime` creates the renderer with `trackTimestamp`, and `perf()` then also returns `gpuMs`, the timestamp-query total of all render passes per frame. Section C's numbers were taken with Chrome also launched with `--enable-dawn-features=allow_unsafe_apis`. This is what section C measured with: the WebGPU path is CPU-bound at 1080p and 1440p, so frame time hides GPU costs there.
- **WebGL frame time** at 2560×1440 is mostly GPU-bound; expect about ±0.3 ms of noise between rounds.
- **Freeze the speed blur for captures:** pausing lets `FX.blur` ease out over many frames; redefine `post.speed.uniforms.get('uBlur'|'uAberr').value` as 0, as `ATMO.hfTime` is frozen.
- **Cold shaders:** the GPU driver caches compiled shaders across runs, so the second load of a variant hides its compile time. For load-time regressions, change a literal in the shader (a cache miss) and load once.

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
