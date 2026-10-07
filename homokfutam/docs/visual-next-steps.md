# HOMOKFUTAM – visual next steps

Working notes for the next round of visual work on HOMOKFUTAM, written so a new session can pick
them up cold. Six parts:

1. **Two deferred items:** batching the exhaust plumes, and moving to WebGPU (three's `WebGPURenderer` with TSL node materials). The WebGPU move is now done behind `?renderer=webgpu`; section B has the results and what is left.
2. **Optional upgrades:** improvements that cost performance, each measured on its own. All eleven are now done, each behind a `?gfx=` key, and the High and Ultra presets switch on the ones worth their cost; section C has the results and what is left.
3. **Light:** a hot midday desert instead of golden hour, eye adaptation (the tunnel effect in the canyon), baked ray-traced bounce light, mirages and contact shadows: items 1–6 done, each behind a `?gfx=` key and measured; what ray tracing can and cannot do here (items 8–9). Section D.
4. **Finishing touches:** a living, windy desert: one gust for everything, sand streaming across the track, sand pouring off the rock, spectators and camps out on the course, trackside markers in place of the chase lights, a landmark (a giant excavator's wreck), pods that disturb the world, lens dirt (on trial). Items 1–8 done, each behind a `?gfx=` key and measured. Section E.
5. **Collisions and hits:** the pods collide with their real shape (capsules made in Blender, per model) against a distance field of everything solid at pod height; an off-centre hit turns the pod; the pod reacts, sparks fly from where it touches, parts break off. Section F.
6. **How to measure:** the harness used so far, and the numbers to compare against.

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
- **Rebalanced (October 2026)** with the deeper enclosed shade of the baked light (D4): the shaded dust's glow 0.32 → 0.22 of the dust colour, and the canyon's density 0.009 → 0.0045. At the old values the slot hazed over milky on High and Ultra and its shadows washed out; Medium (no volume) read crisper.

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

## D. Light: eye adaptation, a hot bright desert, ray tracing: items 1–6 done

**Status (October 2026).** Items 1–6 are built on both renderers, each behind a `?gfx=` key, and on by the presets below. Item 9 is built as ray-traced reflections on the pods (Ultra, WebGPU, `rtr`), after a spike that measured what GPU ray tracing in the browser can do. Item 7 is built as a tunnel over part of the canyon (`tunnel`), on trial; item 8 (SSGI) was measured and turned down.

The goals, from the art side:
1. **The tunnel moment.** Driving into the canyon, the eye opens up over a couple of seconds and the exit ahead is a blown-out white hole. Coming out, the desert is blinding for a second, then settles.
2. **Hot, not golden.** The open desert reads as midday heat: high key, bleached, short hard shadows, a milky pale horizon, shimmering air and mirages on the flats.
3. **Bounce light.** The canyon's shaded walls and floor glow warm from the sunlit rock around them. This is where ray tracing pays off in this game, and it is baked (item 4).

| # | Key | What | Presets |
|---|---|---|---|
| 1 | `noon` (0/1), `sunEl` (degrees) | midday light: sun 30° up, harder light, bleached sky, pale dust, yellow-warm grade, glare veil | `noon` on all four; `sunEl` for tests |
| 2 | – (comes with `eye`) | darker shade where the sky is hidden: canyon floor and walls, the rocks' baked occlusion, the shaded dust | all four |
| 3 | `eye` (0, 1 = metered, 2 = by place) | eye adaptation; the exposure moves in front of bloom, god rays, flare and AgX | Low, Medium: 2; High, Ultra: 1 |
| 4 | `gi` (0/1) | baked ray-traced light: sky visibility and two bounces, in volumes over the canyon and the arch | High, Ultra |
| 5 | `mirage` (0/1) | mirage on the far flats, stronger heat shimmer there | High, Ultra |
| 6 | `sss` (0, 1, 2 = debug view) | contact shadows: screen-space rays towards the sun, only on the sun's share of the light | High, Ultra |
| 7 | `tunnel` (0/1) | a tunnel over ~190 m of the canyon's second half, with gaps of sky | all four (on trial) |
| 9 | `rtr` (0, 1; 2 / 3 = debug views) | ray-traced reflections on the player's pod, in place of the live cube camera (`refl`) | Ultra, WebGPU only |
| 9 | `gloss` (0/1) | polished pods: intact paint and bare metal much smoother, the wear kept | all four |

- **Load-time choices, like C's:** every key changes what is built (shader variants, passes, the sun all the bakes use), so switching one reloads the page. `?gfx=noon:0` brings golden hour back (with its own exposure and grade).
- **Decision rule:** C's (≤ 0.3 ms: High if the gain is visible; 0.3–1.5 ms: Ultra unless the gain is large). Low and Medium get only what costs nothing measurable: `noon`, and the eye driven by where the camera is.

### Results

RTX 3080 Ti, headless Chrome, the C protocol: each key on its own against the same build with it off, two interleaved rounds, at grid / dunes / canyon / arena. Changes per spot (round 1 / round 2 where it matters); noise is about ±0.3 ms on WebGPU's GPU time and ±0.5 ms on WebGL's frame time, so small numbers of either sign are "no change".

| # | Key | WebGPU GPU, High 2560×1440 | CPU (WebGPU frame, High 1920×1080) | WebGL frame, High 2560×1440 | Preset | Why |
|---|---|---|---|---|---|---|
| 1 | `noon` | −0.27 / +0.08 / +0.03 / −0.09 ms | – | ≈ 0 | all | free; the art direction |
| 3 | `eye:1` | −0.29 / −0.02 / +0.12 / +0.05 | +0.06 / −0.14 / +0.13 / +0.17 | +0.26 / +0.11 / −0.29 / −0.33 | High, Ultra | the tunnel moment; ≈ 0 |
| 3 | `eye:1` on Medium | – | +0.16 / +0.18 / +0.21 / +0.18 (1080p) | +0.20 to +0.37 (1080p, 500+ fps) | no | Medium is the phone preset: a readback can stall a tiled mobile GPU |
| 3 | `eye:2` on Low / Medium | see Totals | | | Low, Medium | no GPU work |
| 4 | `gi` | −0.21 / +0.03 / +0.13 / +0.12 | noise | +0.3 to +0.5 at grid and dunes, ≈ 0 elsewhere | High, Ultra | large gain in the canyon; 3.55 MB download, only with the key |
| 5 | `mirage` | −0.16 / 0 / +0.07 / −0.01 | noise | ≈ 0 | High, Ultra | free |
| 6 | `sss` | −0.08 / +0.21 / +0.16 / +0.13 | noise | +0.35 / +0.59 / −0.21 / −0.02 | High, Ultra | ~0.2 ms; WebGL ~0.4 ms in the open |
| | all four | −0.04 / +0.24 / +0.19 / +0.21 | −0.05 / −0.01 / +0.07 / +0.46 | +0.14 / +0.39 / +0.25 / −0.49 | | |

Totals with the new presets against the same presets with the D keys off: see "Totals" at the end of this section.

### Before: what the image did, measured

- **Light:** sun 20.6° up (`SUN_EL` 0.36), `#ffd6a6` at 3.1; hemisphere `#9db4d2` / `#c98b52` at 0.55, environment 0.6; fog `#dcae7a`, horizon `#ebbf8c`; grade saturation ×1.3. Orange four times over (sun, fog, horizon, grade), and a 20° sun is golden hour whatever the grade does.
- **Flat light:** on flat sand the sky's fill (hemisphere + environment, ~1.4) was about as strong as the sun (1.55 at 30°), so a shadow was only ~1 stop under the sunlit sand. In a real desert it is 2–3 stops.
- **Exposure was a constant** (1.1 into AgX), with bloom, god rays and the flare on the HDR in front of it.
- **Brightness by place** (scene pass, HDR before AO and tone mapping, High, WebGPU, 1600×900, `lum.mjs`; EV = log2 of the geometric mean luminance):

  | View | EV | Median | 95th percentile |
  |---|---|---|---|
  | Dunes / far dunes | −1.9 / −1.7 | 0.26 / 0.27 | 0.68 / 0.71 |
  | Towards / away from the sun | −2.0 / −2.2 | 0.24 / 0.21 | 0.61 / 0.49 |
  | Arena straight / start grid | −2.3 / −3.5 | 0.19 / 0.09 | 0.51 / 0.38 |
  | Under the arch | −2.8 | 0.12 | 0.44 |
  | Canyon (three views) | −4.4 to −4.9 | 0.035–0.04 | 0.05–0.22 |
  | Canyon, looking at the exit | −4.5 | 0.04 | 0.23 |
  | Just outside the exit / before the entrance | −2.4 / −2.5 | 0.19 / 0.16 | 0.48 / 0.36 |

  The canyon was 2.5–3 EV under the open desert: room for adaptation. But a +2 EV mock (WebGL, `renderer.toneMappingExposure`) turned the canyon a flat, milky orange and the exit did not blow out: the shaded walls had the same fill all over, and the exit sat on AgX's shoulder. Hence items 2 and 4 next to the eye, and the exposure in front of bloom.
- **Timing:** at race speed the canyon (`loc.canyon > 0.5`) takes 11.4 s over 1,183 m (autopilot, ~373 km/h); the arch's shade lasts 1.2 s.
- **The chase camera** pitches ~6° down, with a vertical FOV of 64° standing, ~77° at race speed and up to ~90° on boost: a sun higher than ~32° is above the frame at race speed (~39° on full boost).

### 1. Midday light (`noon`, `sunEl`)

- **Built (`gfx/atmosphere.js`: `NOON`, `PALETTE`, `GRADE`):**
  - Sun 30° up (`NOON_EL`), `#ffecd2` at 4.0; hemisphere `#a7bedb` / `#cf9f6c` at 0.35; environment 0.4. On flat sand the sun now gives ~3× the sky's fill (it was ~1.1×), so shade is 1.5–2 stops under the sunlit sand.
  - Sky: horizon `#efe1c6` (bleached cream), mid (0.46, 0.56, 0.69), zenith `#3369b0`; dust `#dcc39a`, towards the sun `#ffe9c8`.
  - Grade: saturation 1.18, contrast 1.12, highlights (1.05, 1.0, 0.9) (yellow-warm: film's "hot" is yellow-ochre, not white), shadows (0.95, 0.98, 1.05).
  - Glare veil: a broad faint glow round the sun in the flare (`PALETTE.veil`), the squint.
  - The god rays and the flare take their colours from the palette; the far horizon is `panorama_noon*.ktx2` (`build_panorama.py -- --noon 1`, 19 s in Cycles).
- **Sun height:** 30°, 38° and 45° compared by eye. Above ~32° the sun leaves the chase camera's frame at race speed (no god rays or flare in normal play), and 38–45° flatten the dunes' relief; 30° keeps both and still reads as midday. `?gfx=sunEl:45` tries any height (the panorama stays the noon one).
- **What it looks like:** high key, pale warm haze, short shadows; the arena and the open desert read hot. With a white sun the sand first went grey-beige (AgX desaturates bright sand, and a neutral light on pale sand reads cool): the warmth went into the grade's highlights and a slightly warm sun.
- **Cost:** none (see Results).

### 2. Darker shade where the sky is hidden (with `eye`)

- **Built:** `ATMO.hfShade` (1 whenever the eye is on):
  - the canyon floor (`trackMaterial`) keeps 38 % of its sky and bounce fill mid-slot and 18 % at the walls (it was 65 % / 40 %);
  - the rocks' occlusion attribute (`aAO`: the canyon walls' analytic sky visibility, the Blender AO of the arch and the rocks) goes in as `aAO^1.7`;
  - the shaded dust of the volumetric light (C5) and the haze sheets (`world/haze.js`) at 45 % (bright dust in an opened-up slot turns it milky).
- **With `gi`** the surfaces take the baked light instead (`#ifdef HF_GI` / `GI_ON`); the dust follows `hfShade` either way.
- **Cost:** none.

### 3. Eye adaptation (`eye`)

- **Built (`gfx/eye.js`, the meter in `gfx/post.js` `MeterPass` and `gfx/tsl/post.js`):**
  - **Meter (`eye:1`):** every fourth frame the scene colour goes into a 64×36 target (mean log2 luminance of 4×4 taps per texel; centre-weighted, σ = 0.3 of the frame; the sky at 0.4), read back asynchronously (`readRenderTargetPixelsAsync`). The CPU takes the weighted mean of the middle of the distribution (drops the darkest 10 % and brightest 2 %: sun disc, flames, the pods' undersides).
  - **By place (`eye:2`):** no meter; the target is the camera's place on the track (`zoneEV()` in `main.js`): canyon +1.5 EV, under the arch +0.9, the arena +0.5, faded with the distance from the track. About what the meter asks for there; no GPU work.
  - **Curve:** open desert = metered EV −1.7 (`EYE.refEV`), where the exposure stays the preset's; a ±0.25 EV dead band (towards / away from the sun are ~0.3 EV apart); 85 % of the rest is made up; clamp −0.5 … +1.7 EV.
  - **Speed:** exponential in EV, τ 0.4 s towards bright, 0.9 s towards dark. A camera jump of over 30 m (cuts, the race start, `sim()`) snaps to the next reading. Menus are locked to the preset's exposure; photo mode holds the moment's.
  - **Exposure in front of the light:** the speed pass multiplies the frame by it, so bloom, god rays, flare and AgX see the exposed frame (AgX then gets 1; god rays and flare scale with it; the bloom threshold moves with the preset's exposure, so the open desert blooms as before). On Low (no post chain) it is `renderer.toneMappingExposure`.
- **Trace through the canyon** (High, WebGPU, chase camera, real time; `trace.mjs`): metered −4.1 to −4.7 EV inside. Entering: +0.95 EV after 0.5 s, +1.27 after 1 s, +1.45 after 1.5 s, +1.62 after 2.5 s (cap 1.7). At the exit: +1.58 → +1.0 after 0.25 s → +0.74 after 0.5 s → +0.43 after 1 s, settled (+0.34: the stretch after the canyon meters a little darker) after 1.5 s. From inside, the exit is a white-hot hole; outside, the desert is bleached for about a second.
- **First version:** metered every other frame, it cost ~0.25 ms of CPU a frame on WebGPU (the extra pass and the readback); every fourth frame it is within noise.

### 4. Baked ray-traced light (`gi`)

- **Why bake:** the sun never moves and neither does the world, so the rays only have to be traced once.
- **Built:**
  - `gfx/bvh.js`: a BVH over triangles (binned SAH, 16 bins, ≤ 4 triangles per leaf), closest-hit and any-hit traversal with an explicit stack. The node layout follows lisyarus/webgpu-raytracer (MIT): a box plus one word that is either the first child or the first triangle, and a count.
  - `gfx/gibake.js` (dev only, loaded by `__homok.bakeGI()` or `?bakegi`, which downloads `gi.bin`): collects the static triangles round the volumes (the world shadow's rules, plus no scatter; the canyon walls are double sided, so their faces are turned towards the track and back-face hits mean "inside rock"), builds the BVH, and traces 128 rays from every cell (Fibonacci directions, turned per cell). A ray that escapes upwards sees the sky (the hemisphere light plus a model of the dome), downwards open sunlit sand; a hit sees the surface's albedo × (the sun, if a second ray towards it gets out, × cos + the indirect light on it). Two passes: the first takes a rough sky term for that indirect light, the second the first pass's own result at the hit (a second bounce, which is what makes red rock glow in its own shade). The radiance goes into L1 spherical harmonics per cell, as E(n) = a + b·n per channel; cells inside rock (more than a quarter of the rays hit back faces) take their neighbours' values.
  - **Volumes:** three boxes along the canyon (~445 m each; cells 6 m along, 4 m up, 3.5 m across) and one over the arch (150 × 70 × 160 m, 3.5 m cells): 224,132 cells. `assets/world/gi.bin` (3.55 MB): per cell and channel `log2(a / a_open)` and `b / 2a` in 8 bits each, as one RGBA8 3D atlas.
  - **Bake:** 387,183 triangles, BVH (241k nodes) in 0.97 s; 57.4M rays in 128 s, on the CPU in the page, one thread.
  - **Run time (`gfx/gi.js` `hfGI`, `gfx/tsl/gi.js`):** every ground and rock material multiplies its indirect light by E(n) / E_open(n), RGB: the light from its surroundings over what flat open desert gets (1 in the open, outside the volumes, and in their outer cell, which fades). The lookup is 1.5 m out along the normal (off the surface, into the air the bake saw); 3 texel fetches inside a volume, a few box tests elsewhere. The specular occlusion takes its luminance (≤ 1). The canyon walls keep `aAO^0.4` for the detail the 3.5 m cells cannot have; the rocks' Blender AO stays as it is.
- **Values (`gidecode.mjs`):** on the canyon floor an upward-facing surface gets (1.02, 0.63, 0.46) of the open desert's light: much less sky, much more warm bounce. The walls get 0.27–0.6, warmer towards the side facing the sunlit wall. Under the arch: 0.5–0.86.
- **What it looks like:** the canyon glows warm in its own shade (walls and floor red-gold rather than grey-brown), the shade under the arch warms; with the eye opened up the slot reads like Antelope Canyon rather than smoke. The pods take the canyon and arch probes, which are baked with this light on.
- **Changed from the plan:** a CPU tracer instead of a WebGPU compute shader. The result is an asset both renderers read, and a two-minute bake once is fine; the BVH layout is the one a compute shader would take (item 9).
- **The second bounce** turned the first version's grey, slightly blue shade (one bounce: mostly sky through the slot) into the warm glow.
- **Rebalanced (October 2026):** in play the canyon read flatter on High and Ultra than on Medium (no bake there): the bounce lit the floor's shade to ~0.7 of the open desert's, and with the eye opened up +1.7 EV the shadows (the bridge's, the walls') all but washed out. Where the bake's light is under ~0.7 of the open desert's (luminance), it is now taken down to 0.62 of itself, easing back to the bake towards 1 (`GIU.hfGIShade`; open ground inside a volume, where the ratio is ~1, is unchanged, so no volume's box shows). The shade stays warm, but deep again, and the shadows read.
- **In the canyon the bake gives the colour, not the brightness (October 2026, `giHue`):** its cells are 6 m along the track, and the tunnel's slabs (D7) are 48–68 m with 10–12 m gaps of sky between them: the bake blurred each slab's shade and the sunlit gap after it into one dark run, so on High and Ultra the slabs' shadows did not separate (Medium, and Ultra with `gi:0`, had them crisp). Now the canyon walls (`rockMaterial` option `giHue: 0.85`) and the track floor in the canyon (by its canyon weight) take 85 % of how bright their indirect light is from their own sharp occlusion, as without the bake (the walls' `aAO` with its roof term, the floor's analytic canyon and roof terms), blended geometrically so the deep shade stays deep, and the bake's colour at 40 % of its saturation (deep in the shade the bake is nearly all red bounce, which without its darkness read as a dark red glow where the shade should be near black). Down the tunnel's floor, the lit gap over the slab's shade: Medium 1.8, Ultra 1.6, High 2.0, Ultra WebGL 1.9, Ultra `gi:0` 1.8 (it had all but gone). Open ground and everything outside the canyon take the bake as before.
- **Only where there is a bake (October 2026, `hfGIW`):** what the bake stands in for (the rocks' own cavity and foot shade, `aAO` at exponent 1.7 without it, `rAOgi` = 1 with it; the canyon floor's analytic terms) was dropped wherever `gi` was on, also outside its four volumes, where `hfGI` is 1 and nothing took its place: the spires, boulders, mesas and talus all over the desert read flatter on High and Ultra than on Medium. Now it is faded by how much the bake has to say there (`hfGIW`, the volumes' weights without the texture reads): outside the volumes, and with no bake loaded (a missing or stale `gi.bin`), as without `gi`.

### 5. Mirage (`mirage`)

- **Built (the speed pass: `SpeedEffect` in `gfx/post.js`, `speed` in `gfx/tsl/post.js`; `horizonUv()` in `gfx/screen.js`):**
  - The horizon on screen from the camera every frame (two points at infinity level with it): it rolls and pitches at speed.
  - A band from just under the horizon to ~2° below it, beyond 120–300 m: the frame mirrored about the horizon in the same column, squashed to 0.8, wobbling, patchy along the horizon, at 45–85 %; not where the mirrored point is something nearer than the ground (a pod, a rock). The heat shimmer is 2.5× in the band.
- **Exaggerated on purpose:** a real inferior mirage lies within ~0.5° of the horizon, a few pixels from a chase camera (tried first: invisible even at 20× strength).
- **What it looks like:** a pale, sky-coloured sheen on the far straights, with the feet of the bollards and spires mirrored in it. Subtle by design.

### 6. Contact shadows (`sss`)

- **Built (`ContactEffect` in `gfx/post.js`, after the AO; in `gfx/tsl/post.js` on the scene colour before TRAA; constants in `gfx/screen.js` `CONTACT`):**
  - From each pixel within 70 m, a ray towards the sun is marched over 1 m through the depth buffer; where it passes behind a surface (less than 0.3 m in front of it) the pixel is in contact shadow, the more the nearer the occluder (dark at the foot of a thing, gone a metre out).
  - Only the sun's share of the pixel's light goes: k = s / (s + 1), s = N·L (normal rebuilt from depth) × the baked world shadow × the sun-to-sky ratio on flat sand (`sunShare()`, 4.3 at noon). Shade stays as it is.
  - WebGPU: 10 steps, jittered per pixel and frame (TRAA averages it). WebGL: 16 steps with a 4×4 ordered dither (no TRAA: a random jitter reads as a screen door, one fixed offset as terraces).
  - `?gfx=sss:2`: debug view (red = in contact shadow, green = the estimated sun share).
- **What it looks like:** the feet of bollards, rocks, grass tufts and the pods' skids get crisp contact darkening under the soft shadow map. three's `SSSNode` (screen-space shadows, Bend's method) was the cost probe; the shipped version is our own, the same on both renderers.

### 7. A tunnel in part of the canyon (`tunnel`, on trial)

- **Why:** the canyon is a slot open to the sky (floor 32 m wide, walls 51–67 m), so it is shade, not darkness; the open canyon's light is worth keeping. So only part of it is roofed: about 190 m in the second half, past the stone bridge (s 2464 m) and the canyon's light probe (s 2392 m), with open canyon before and after (~155 m after it, before the canyon ends).
- **Built (`main.js`: `TUNNEL`, `roofAt()`, `buildRoof()`):**
  - Three rock slabs over the slot (52, 48 and 68 m long) with gaps of 10 and 12 m: shafts of sun through the dust (`vol`, C5) and patches of light on the floor.
  - Each slab is a closed tube swept along the track: a flat ceiling along a bedding plane ~29 m up (off the centre a little) that curves steeply down into the walls (a squircle; it meets them ~28 m up), a top ~9 m higher, blocks fallen out of the ceiling (steps), lumps and fine roughness, strata colours with noise. Over the last ~6 m of a slab the ceiling and the top close into a rounded, ragged lip. Faces point out of the rock (the light bake reads back faces as "inside").
  - The rest follows from the geometry: the world shadow and the near and mid shadows (the slabs are static casters), the volumetric light, the reflections' BVH.
  - Light where nothing is baked: the canyon walls' sky occlusion drops by 80 % under the roof (below ~25 m); the track floor takes the slabs as arc-length ranges (`trackMaterial(Q, L, roof)`) and loses 80 % of its fill under them (without `gi`); the shaded dust's glow follows the camera's place (`FX.vol.amb`); the zone eye (`eye:2`) opens up 1.7 EV in the tunnel; the pods cross-fade from the canyon's probe to one baked under the last slab (`podProbe`).
  - The baked light has its own file with the roof, `assets/world/gi_tunnel.bin` (`tools/bakegi.mjs` picks the name; `gi.bin` stays for `tunnel:0`).
  - `?gfx=tunnel:0` takes it out; on in every preset for now, to be judged in play.
- **What it does:** metered −6.4 to −7.1 EV under the roof against about −4.5 in the open canyon (High, `tools/trace.mjs`): the eye is at its +1.7 EV limit, so the tunnel stays ~2 stops darker on screen, warm with the bounce off the floor and walls (with `gi`), the ceiling near black, the gaps and the exit blazing; out of it the canyon is bleached for a moment.
- **Measured** (against `tunnel:0`; grid / dunes / canyon / tunnel / arena, the tunnel spot inside it; two rounds; `bench.mjs --spots`):
  - High, WebGPU, 2560×1440: GPU +0.21 / +0.13 / +0.33 / +0.21 / +0.24 ms (noise: spots that cannot see it moved as much).
  - High, WebGL, 2560×1440: frame −0.02 / −0.16 / −0.56 / +0.18 / −0.12 ms (noise).
  - Low, WebGL, 1920×1080: frame +0.33 / +0.03 / +0.07 / −0.01 / −0.01 ms.
  - +3 draws (+3 in the shadow pass), ~19k triangles. The bake: 406k triangles (387k without the roof), same time and size.
- **Things that bit:**
  - **A pointed arch with strata colours read as a pitched timber roof**, and the slabs' flat end caps (a fan of triangles) as a tent from below. The flat-ceilinged squircle and the closing lips fixed both.
  - **The dust under the roof glowed with sky light it does not get there**, and the tunnel turned milky; its glow now follows the camera's place.

### 8. Screen-space GI (`ssgi`): measured, not worth it now

- three r186's `SSGINode` (visibility-bitmask screen-space GI, also gives AO, so it would replace GTAO), in a scratch copy at full resolution (the node has no resolution scale), composited roughly. GPU ms at grid / dunes / canyon / arena, two rounds:

  | Setting | grid | dunes | canyon | arena |
  |---|---|---|---|---|
  | 1 slice × 12 steps | +2.0 / +3.2 | +1.7 / +1.8 | +2.6 / +2.6 | +1.8 / +1.7 |
  | 2 slices × 8 steps | +4.7 / +4.6 | +3.1 / +2.9 | +4.8 / +3.8 | +3.7 / +3.1 |

- Over the 1.5 ms line even at its cheapest, and ~2.25× that at 4K. Most of the bounce here is static and item 4 has it for ~0.1 ms. What SSGI would add is the moving part (engine glow on the ground and walls, the liveries' colour on the track): revisit at half resolution (a patched node), Ultra only.

### 9. Ray tracing at run time: a spike, then reflections on the pods (`rtr`, Ultra, WebGPU)

- **No hardware ray tracing in the browsers' WebGPU** (October 2026: ray-tracing extensions are proposals; only experimental forks such as a Dawn branch and WebRTX). Everything below is a BVH walked by a shader.

#### The spike (`tools/rtspike.mjs`, `__homok.rtSpike()`)

- **Built (`gfx/tsl/rt.js`):** the static world round a camera (`gfx/bvhscene.js` `collectStatic`) into `gfx/bvh.js`'s BVH, packed depth first with a skip link per node (`packBVH`; lisyarus/webgpu-raytracer's node idea: a box plus one word that is the first child or the first triangle), as two read-only storage buffers. Two walks in TSL, in a fragment pass (the way a post pass would use it):
  - `traceTSL`: stackless (hit: next node, miss: the skip). One `while` loop, no arrays.
  - `traceOrderedTSL`: the nearer child first, the other on a 48-entry local stack (`array('int', 48)`).
- **Measured** (960×540 = 518k rays a pass, GPU timestamps, the game's frame loop held; every configuration checked against the CPU BVH, 64/64):

  | Place, radius | Triangles | Stackless: primary / random / shadow (M rays/s) | Ordered: primary / random / shadow | Nodes per ray (random, stackless → ordered) |
  |---|---|---|---|---|
  | Canyon, 300 m | 153k | 82 / 58 / 155 | 125 / 97 / 104 | 83 → 30 |
  | Canyon, 700 m | 459k | 99 / 80 / 259 | 129 / 99 / 374 | 114 → 46 |
  | Dunes, 300 m | 272k | 954 / 401 / 690 | 802 / 665 / 717 | 32 → 15 |
  | Dunes, 700 m | 746k | 180 / 82 / 186 | 120 / 95 / 111 | 42 → 19 |
  | Arena, 300 m | 405k | 274 / 98 / 202 | 148 / 109 / 122 | 67 → 29 |
  | Arena, 700 m | 825k | 127 / 47 / 161 | 105 / 77 / 92 | 85 → 38 |

  - About 100M incoherent closest-hit rays a second where the world is dense (canyon, arena), several hundred million in the open. The ordered walk visits a third of the nodes but is only up to ~1.7× faster: the local array lives in slow private memory, and each step loads both children's boxes. Shadow rays (any hit) are often faster stackless.
  - **Verdict:** full-screen effects (one-bounce GI or ray-traced AO at quarter resolution: ~230k rays a frame at 1440p, plus denoising) are out of budget. Reflections on the pods are not: rays only from pod pixels.

#### Reflections on the pods (`rtr`)

- **Built:**
  - **BVH:** at boot, the static world in a corridor 180 m either side of the track, without the ground (terrain, track): 1.09M triangles, collected in 0.3 s, built in a worker (`gfx/bvh.worker.js`, 2 s) while the shadows and probes bake. Boot waits for it before the pipelines compile, so nothing recompiles later. ~70 MB of GPU memory.
  - **The other pods:** three boxes each (hull, two engines) in their own frames, updated every frame (`createReflections().setBoxes`, a storage buffer).
  - **The pod materials (`podTracedReflections` in `gfx/tsl/pod.js`):** the lighting model's `indirectSpecular` traces one ray per pixel along three's reflection vector (out to 150 m) and puts the result in place of the probes' radiance where the surface is smooth (roughness 0.15 → 0.5) and under the clear coat. A ray that misses keeps the probe, which has the sky, the ground and the far desert. A hit is lit like the scene: the triangle's albedo × (sun × the static world shadow × cos + the fill lights × the baked light, `gi`) / π, then the fog. Only the player's pod traces (`pod.rtOn`).
  - It replaces the live cube camera (`refl`, C4) on WebGPU; WebGL keeps the cube.
  - **Debug views:** `?gfx=rtr:2` turns the pod into a mirror showing only the traced light (magenta where a ray missed); `rtr:3` paints the reflection direction.
- **Measured** (Ultra, WebGPU; grid / dunes / canyon / arena; two interleaved rounds):

  | | Cube camera (`refl`, as before) | Probes only | Traced (`rtr`) |
  |---|---|---|---|
  | GPU, 3840×2160 | 11.29 / 11.56 / 14.66 / 9.72 ms | 12.54 / 11.28 / 14.19 / 9.15 ms | 13.45 / 10.81 / 15.10 / 9.12 ms |
  | Frame, 1280×720 (CPU-bound) | 9.01 / 8.26 / 8.50 / 8.32 ms | 7.29 / 6.92 / 7.50 / 7.48 ms | 7.12 / 7.01 / 7.76 / 7.46 ms |

  - **CPU:** tracing costs what the probes cost; the cube camera's 0.8–1.9 ms a frame is gone. Ultra on WebGPU is CPU-bound at most sizes, so this is the number that matters most.
  - **GPU:** +0.4–0.9 ms against the probes where the pod is surrounded (the canyon; the grid with five pods beside it), ~0 in the open. The grid's probes-only GPU time is an outlier in both rounds; against the cube the grid is +2.2 ms.
- **What it looks like:** per-pixel reflections with the right parallax (the canyon wall slides across the hull, the pods beside you show in the engine shells), where the cube saw everything from the pod's centre. On these pods the gain is modest: the paint and metal are worn and mostly rough, so only the clear coat and the polished parts mirror.
- **Things that bit:**
  - **`positionWorld` in the pods' lighting leaves out their skinning:** the rays started at the bind pose, far from the pod, and missed everything. The origin is now the camera's world matrix × `positionView`, and the direction three's `reflectVector`.
  - **WebGPURenderer compiles pipelines asynchronously and draws nothing until one is ready:** the first spike timed empty passes. Now: `compileAsync()`, then draw until the output is real.
  - **Never `await` with a render target bound:** the game's frame loop runs meanwhile, and the post chain draws its output into whatever target is bound (the spike read back sand colours). The spike also holds the frame loop, so the GPU timestamps cover only its own passes.
  - **TSL local arrays work** (`array('int', n).toVar()`, `.element(i).assign()`) but are slow (private memory).
- **What is left:**
  1. Rocks at their lowest level of detail in the BVH, and a narrower corridor (1.09M triangles is more than reflections need).
  2. The arena's seating (custom shader materials, left out by the collection's rules; the probe shows it instead).
  3. A bounding test per pod before its three boxes, and no boxes for pods far away (the grid case).
  4. ~~Glossier pods~~: done, see "Polished pods" below.
  5. Rivals close to the camera could trace too (`pod.rtOn`), at +0.2–0.5 ms each when near.
#### Polished pods (`gloss`)

- **Why:** the traced reflections (and the probes' and the cube's) barely showed on the pods: their paint and metal are worn and mostly rough (roughness ~0.6–0.8 in the model).
- **Built (`patchLivery` in `playerPod.js`, `podLiveryMaterial` in `gfx/tsl/pod.js`, constants `GLOSS`):** per pod a polish amount (`setPodGloss`, 0..1): where the livery's masks say the paint is intact, roughness × 0.2 (an enamel gloss); bare metal (the metalness map) × 0.45; rubber, leather, soot and the worn scratches keep the model's roughness, so the pods stay battle-worn, but cared for. With the clear coat (High, Ultra) the coat also covers paint that is partly worn. The player's pod is fully polished, the rivals between 0.55 and 1 (fixed per racer). `?gfx=gloss:0` brings back the finish as modelled.
- **What it looks like:** the canyon wall and the sky slide across the hull as a clean band, the paving shows in the lower hull, the engines read as polished copper; the sun's highlight is crisp.
- **Cost** (High, both renderers, against `gloss:0`, two rounds): WebGPU GPU +0.12 / −0.05 / −0.01 / 0.00 ms; WebGL frame −0.31 / −0.01 / −0.30 / +0.45 ms (noise). Free; on every preset.

- **`VXGINode`** (voxel cone-traced GI) is in three releases after r186: WebGPU only, a static scene, at most 256 voxels along the longest axis. A local volume (canyon, arena) at best.

### Things that bit

- **`pow()` of a negative under MSAA is NaN.** With MSAA an edge pixel's attributes are extrapolated outside the triangle, so the rocks' occlusion went slightly negative and `pow(aAO, 1.7)` turned NaN. One NaN pixel, spread by the bloom, made the whole WebGL frame black wherever rock was in view, and the speed pass's `isnan()` scrub had been compiled away (ANGLE / D3D). Fix: `pow(max(aAO, 0.0), …)`, and a `max()` / `min()` clamp after the scrub (D3D's `max()` drops a NaN).
- **TSL's `cameraNear` / `cameraFar` in a post-processing pass are the quad's camera**, not the scene's: every depth-to-distance conversion in the post chain was wrong until the scene camera's planes went in as uniforms (`camNear`, `camFar`). It broke the contact shadows and the mirage's depth test on WebGPU only.
- **Importing `gfx/post.js` from `gfx/tsl/post.js` pulls postprocessing and N8AO into the WebGPU bundle:** the shared helpers (`horizonUv`, `CONTACT`, `sunShare`) live in `gfx/screen.js`.
- **Boolean `?gfx=` keys take only 1 / true:** `sss` and `eye` are numbers (0 / 1 / 2) so that `sss:2` and `eye:2` work.
- **The baked light and the hand-made shade would count the occlusion twice:** with `gi` the canyon floor factor is compiled out and the walls keep `aAO^0.4`.
- **A bake volume per piece of track:** the canyon split into a short last piece made five volumes for four uniform slots, and the arch silently went missing. Pieces are now equal (three for the canyon).
- **WebGL draws the arch more orange than WebGPU, at HEAD too:** the rock material differs between the two renderers on the arch's model (vertex colour or AO); not from this work, still open.

### Totals

Each preset as it is now against the same preset with the D keys off (`?gfx=eye:0,gi:0,mirage:0,sss:0`; `noon` stays on, it is free), grid / dunes / canyon / arena, two interleaved rounds:

| Preset, size, renderer | Frame time, D keys off → as shipped | GPU time (WebGPU) |
|---|---|---|
| High, 2560×1440, WebGPU | 7.28 / 7.10 / 7.87 / 7.72 → 7.91 / 7.29 / 8.30 / 7.95 ms | 5.33 / 4.13 / 5.87 / 3.69 → 5.52 / 4.50 / 6.00 / 3.94 ms |
| High, 1920×1080, WebGPU | 7.10 / 6.98 / 7.72 / 7.83 → 7.73 / 7.38 / 8.23 / 7.99 ms (CPU-bound; JS +0.1–0.4 ms) | – |
| High, 2560×1440, WebGL | 5.40 / 4.09 / 5.09 / 5.62 → 5.66 / 4.49 / 5.84 / 5.66 ms | – |
| Ultra, 2× screen (3840×2160), WebGPU | 13.64 / 11.91 / 15.21 / 9.99 → 14.12 / 12.90 / 15.70 / 10.34 ms | 11.64 / 11.09 / 14.12 / 9.40 → 11.34 / 11.60 / 14.64 / 9.66 ms |
| Medium, 1920×1080, WebGL (`eye` 0 → 2) | 2.29 / 1.86 / 1.97 / 2.28 → 2.14 / 1.85 / 2.57 / 2.13 ms (the canyon's +0.6 is one round's hitch: +1.2 / 0.0) | – |
| Low, 1920×1080, WebGL (`eye` 0 → 2) | within ±0.15 ms, except one round's hitch at the grid | – |

- **High** pays +0.15–0.35 ms of GPU on WebGPU at 1440p, and +0.2–0.6 ms a frame where it is CPU-bound (1080p: the meter's readback every fourth frame, the extra contact pass). WebGL: 0 to +0.7 ms. Still 120–140 fps at 1440p here.
- **Ultra** at 4K: about +0.5 ms of GPU (the contact march and the bake lookups scale with the pixels).
- **Low and Medium:** unchanged within noise. `noon` is free and `eye:2` is a few lines of JS a frame.
- **Load:** `gi` fetches `gi.bin` (3.55 MB) on High and Ultra; there is no bake at load.

### What is left in D

1. **Item 7, the tunnel:** keep it or not, after a look in play (`?gfx=tunnel:0` to compare); if kept, `gi.bin` can go.
1. **Item 9's follow-ups** (its "What is left").
2. **A bake volume over the arena** (the stands' shade and the bounce off the paving), and per-zone strength (`hfGIK` is global).
3. **The arch's renderer difference** (above).
4. **Contact shadows on WebGL** keep a fine dither at their edges; a depth-aware blur of the contact term would remove it.
5. **Item 9:** port `gfx/bvh.js`'s traversal to WGSL, measure rays per second, then decide on a run-time trace for Ultra.
6. **Item 8:** SSGI at half resolution for the moving light, once item 4's static light is settled.

### Measuring D

- **Cost:** C's protocol (GPU via `?gputime` at 2560×1440 on High, CPU at 1080p, WebGL frame time at 1440p). Benchmarks run against a frozen copy of the tree (`tools/batch.mjs`: a snapshot served on its own port), so that edits do not reload the pages mid-run; `tools/deltas.mjs` turns the logs into per-round changes.
- **Brightness (`lum.mjs`):** for each fixed view, reads the scene pass's colour target (`post.scenePass.renderTarget`, half float) with `readRenderTargetPixelsAsync`; reports EV (log2 of the geometric mean luminance), a centre-weighted EV, the median and the 5th / 95th / 99th percentiles.
- **Adaptation trace (`trace.mjs`):** a fresh race fast-forwarded to just before the canyon, then in real time with the chase camera, logging race time, canyon, metered EV, target and exposure every 100 ms, with screenshots at given race times.
- **The bake (`bakegi.mjs`):** runs `__homok.bakeGI()` in the page and writes `assets/world/gi.bin`; `gidecode.mjs` prints E(n) / E_open(n) at world points for the six axis normals.
- **The SSGI / `SSSNode` cost probe:** a `git archive` copy with the nodes wired into `gfx/tsl/post.js` after the AO; only the cost is meaningful.

---

## E. Finishing touches: a living, windy desert: items 1–8 done

**Status (October 2026).** Items 1–8 are built on both renderers, each behind its own `?gfx=` key, and on by the presets below; the lens touches (item 8) are built but off everywhere, on trial. The chase lights are gone (below).

The goals, from the art side:
1. **The wind is a character.** It is the one thing that moves in an empty desert. Sand, grass, cloth, dust and the wind's sound move with the same gusts, and the player drives through them.
2. **The race happens in a place.** People, camps and signs of use out on the course, not only in the arena, and a landmark the player learns to look for.
3. **The world reacts to the pods.** A pod passing at 400 km/h blows things about.
4. **Nothing that nags.** Nothing blinks or pulls the eye off the racing line; that is why the chase lights went.

| # | Key | What | Presets |
|---|---|---|---|
| 1 | `drift` | sheets of sand streaming across the track on the stretches where the wind crosses it with dunes upwind; fresh tongues of sand on the road there | all four (Low: one layer of grains) |
| 2 | `gust` | one gust field for the grass, the scrub, the cloth, the sand (streams, crest veils, streamers), the tumbleweeds and the wind's sound | all four |
| 3 | `trickle` | 40 falls of sand from the canyon rim, the tunnel's lips and ceiling, the arch and the bridge; a passing pod shakes loose a heavier pour and a few pebbles | all four |
| 4 | `camps` | spectators on the stone bridge, on the canyon rim by the tunnel, on top of the arch and on a dune crest by a fast corner, cheering as the pack comes by; tents, an awning, hover-bikes, a crawler, a smoking fire, banners | Medium up |
| 5 | `markers` | weathered poles with cloth strips every 25–40 m on the open stretches, cairns by the chevron boards, drums at the braking points | all four |
| 6 | `landmark` | the wreck of a colossal bucket-wheel excavator in the dunes, seen ahead from several straights and passed close by once | all four |
| 7 | `wake` | the pods disturb the world: grass and scrub thrash and spring back, the canyon's dust and the sand streams are blown clear behind them, tumbleweeds get kicked, birds on the canyon rim startle | Medium up |
| 8 | `lens` | dirt on the lens lit by the bloom (the sun, the tunnel's exit), grains hitting the lens in the sand streams | none (on trial: `?gfx=lens:1`) |

- **Load-time choices, like C's and D's:** every key changes what is built (meshes, shader variants), so switching one reloads the page. `?gfx=gust:0` brings back the old per-thing sines.
- **Decision rule:** C's (≤ 0.3 ms: High if the gain is visible; 0.3–1.5 ms: Ultra unless the gain is large). Low and Medium take what costs nothing measurable.
- **New assets:** `assets/world/course.glb` (56 KB: the markers' and the camps' props, `models/world/build_course.py`) and `assets/world/landmark.glb` (205 KB: the wreck in three levels of detail, `models/world/build_landmark.py`). Both load only with their keys.
- **Moving things:** stills do not show a gust or a fall; `tools/clip.mjs` steps the shader clock from a fixed camera (or captures in real time) and tiles the frames.

### Results

RTX 3080 Ti, headless Chrome, the D protocol: each key alone on, against the same build with every E key off, two interleaved rounds, at grid / dunes / drift (the first drift stretch) / canyon / tunnel / arena (`--spots grid:0,dunes:10,drift:2.5,canyon:7.5,tunnel:7,arena:13`). Mean change of the two rounds; noise is about ±0.3 ms on WebGPU's GPU time and ±0.5 ms on WebGL's frame time, so small numbers of either sign are "no change".

| # | Key | WebGPU GPU, High 2560×1440 (ms) | WebGL frame, High 2560×1440 (ms) | Draws (WebGPU, with the shadow pass) | Preset | Why |
|---|---|---|---|---|---|---|
| 2 | `gust` | +0.30 / +0.22 / +0.02 / +0.04 / −0.07 / −0.08 | +0.22 / −0.30 / −0.21 / −0.02 / −0.61 / +0.11 | 0 | all | the art direction; ~0.2 ms where the grass is (an ALU field per grass vertex), not seen together with the rest |
| 1 | `drift` | +0.06 / +0.04 / +0.06 / +0.09 / +0.02 / +0.02 | +0.02 / −0.13 / +0.24 / +0.21 / −0.16 / −0.37 | +1–3 near a stretch | all (Low: one layer) | free |
| 3 | `trickle` | −0.14 / +0.07 / −0.01 / 0.00 / −0.03 / −0.04 | +0.57 / +0.06 / +0.30 / −0.10 / +0.37 / +0.26 (noise: the grid sees none) | +2–4 in the canyon | all | free |
| 5 | `markers` | +0.25 / 0.00 / +0.01 / +0.05 / 0.00 / +0.03 | +0.15 / −0.01 / +0.30 / +0.06 / +0.40 / −0.11 | +2–6; +0.18M triangles | all | free |
| 4 | `camps` | +0.22 / −0.04 / −0.01 / +0.02 / −0.06 / −0.02 | +0.11 / −0.32 / +0.03 / +0.22 / −0.38 / −0.16 | +10–14 (before the culling below) | Medium up | the draws cost CPU on WebGPU; Low is the phone preset |
| 6 | `landmark` | −0.12 / +0.05 / +0.06 / +0.01 / −0.02 / +0.03 | +0.36 / −0.08 / 0.00 / +0.06 / −0.04 / −0.04 | 0–3 (where it is in view) | all | free |
| 7 | `wake` | +0.02 / +0.14 / −0.09 / +0.13 / −0.04 / 0.00 | +0.12 / −0.15 / +0.05 / +0.40 / −0.06 / +0.05 | 0–1 (the birds) | Medium up | ~0.1–0.4 ms in the canyon (the wake inside the volumetric dust's march: now 2 pods, it was 3); the grass is on High only |
| 8 | `lens` | not measured (off everywhere) | | 0 | none | on trial |
| | all of E | +0.07 / +0.14 / +0.03 / +0.20 / +0.02 / −0.01 | +0.16 / +0.10 / −0.39 / +1.00 / −0.29 / +0.18 | +10–26 (before the culling below); +0.24–0.27M triangles | | |

- **On the GPU** all of E together is within the noise to +0.2 ms on WebGPU (the canyon: the wake in the volumetric dust). On WebGL the canyon came out at +1.0 ms (+0.57 / +1.44 in the two rounds), the rest within noise.
- **On the CPU** (WebGPU, High, 1920×1080, where it is CPU-bound): all of E cost +0.15–0.6 ms a frame at most spots, with outliers of +1.5–1.7 ms at the tunnel and the arena in one round of two. The extra draws are most of it (WebGPU's per-draw CPU cost, section B). After this measurement: each crowd group is culled by a sphere round its people (they were never culled), the drift sheet is one mesh per stretch, the falls one mesh per cluster (the canyon and the bridge, the arch), the birds culled by a sphere round their flights, and the four banner meshes one (a per-copy atlas cell, `clothMaterial`'s `cells`); the wake in the volumetric march takes 2 pods instead of 3. Re-measured below ("Totals").
- **Medium and Low (WebGL, 1920×1080), all of E:** Medium −0.13 / −0.06 / +0.11 / +0.13 / +0.19 / +0.30 ms; Low −0.04 / 0.00 / +0.21 / −0.01 / −0.01 / +0.19 ms (within noise; Low has no camps and no wake).
- **Load:** +56 KB (`course.glb`) and +205 KB (`landmark.glb`); placement at boot: the falls ~130 ms, the landmark ~70 ms, the drift stretches and the course a few ms. WebGPU's pipeline compile at boot stayed at 7–9 s in this harness (warm).

### Done: the chase lights are gone

- **What they were:** orange lamps on 1.4 m posts every ~20 m on both sides of the open stretches (~500 of them), pulsing in a wave that ran along the track (`world/dressing.js`, `chaseLampMaterial` in `gfx/tsl/dressing.js`). They drew the eye off the racing line. Removed with their posts.
- **Measured** (with lights → without; grid / dunes / canyon / arena; two rounds):
  - High, WebGPU, 2560×1440: GPU −0.13 / −0.15 / −0.27 / −0.12 ms.
  - High, WebGL, 2560×1440: frame −0.17 / −1.13 / −0.52 / +0.12 ms (noisy).
  - Low, WebGL, 1920×1080: frame −0.54 / +0.01 / +0.01 / +0.12 ms (noise).
  - −3 draws (the lamps, the posts, the posts' shadow).
- **What went with them:** a rhythm of things passing close by on the open stretches, which helped the sense of speed. Item 5 gives that back without the blinking.

### 1. Sand streaming across the track (`drift`)

- **The stretches (main.js `DRIFT`):** picked at load as arc-length ranges: the wind crosses the track (|tangent · wind| < 0.5), open desert (not canyon or arena), tall dunes upwind (`dunePhase().amp`, sampled 70–270 m upwind); the best window of up to 260 m in each run of at least 100 m, at least 400 m apart, not over the start line. On this track: **1080–1340 m and 3597–3837 m** (two; the code allows four).
- **The sheet (`world/drift.js`, `driftMaterial`):** one strip mesh per stretch (each culled on its own), from 28 m outside one edge to 28 m outside the other, draped 12 cm over the *drawn* surface: the road is 0.35 m above `groundQuery`, and the berm exists only in the track mesh, so the berm profile became shared functions (`bermB`, `bermH`, `surfaceAt` in main.js) and the sheet's columns sit on the berm's own break lines. Transparent, after the opaque pass. In the shader, on the shader clock:
  - **the grains:** two layers of fine streaks racing along the wind at 9 and 13 m/s (one layer on Low);
  - **the ribbons:** a slow, warped low-frequency mask, braided and snaking, drifting at 3.5 m/s;
  - **the sheets:** the gust field; a gust swells the ribbons into a lumpy sheet that hazes the road. The gust is sampled through a travelling billow noise, which lobes its leading edge (the field's straight front read as a ruled line across the road).
  - It fades out in the last metres before the lens, thickens at grazing angles, is lit by the scene's palette (fill from the dust's colour, the sun through the world shadow, brighter towards the sun) and fogged.
- **The road** (`trackMaterial`, both renderers, `kDrift0..3`): fresh tongues of sand lying across it, long along the wind (~30 × 4 m), covering about a third of it, into the track's existing loose-sand weights (they also cover the racing line's groove and the oil and scorch marks).
- **Height in a gust (main.js `updateWind`, the `DRIFTP` pool):** near the camera, low wide puffs across the stretch with the gust, and sand kicked up where the stream pours over the downwind berm; the C10 streamers are three times as dense on the stretches.
- **What it looks like:** thin ribbons most of the time; when a front comes through, the road hazes over with streaks of sand for a second or two, and the berm smokes. It does not hide the racing line.
- **Things that bit:** a fixed sand orange (the SAND pool's) read far too saturated on Low, which has no post chain; the tongues first covered most of the road, so the bare road between them read as dark stains.

### 2. One wind (`gust`)

Built first: everything after it moves with it.

- **The field (`gfx/wind.js`: `gust()`, `GUST_GLSL`; `gfx/tsl/wind.js`: `hfGust`, a laid-out function):** three gust fronts travelling downwind at 14 m/s. Front k is a pulse of u = t / P − along / (V P) + phase, with a slow bend across the wind so the fronts are not ruler-straight; at a point it rises over the first quarter of its width and dies away over the rest (a sharp leading edge, a slow tail), every P = 11, 15.3 and 7.4 s. Its strength along the front is a 1D value noise (segments of ~380 m, lulls between them), re-seeded for every pass, so no two gusts at a point are alike. 0 in a lull, up to 1 in a core. The same function, with the same constants, in JS, GLSL and TSL; no textures, so it goes into vertex shaders as well.
- **Statistics** (10 minutes at four points): mean 0.16; above 0.5 for 11–13 % of the time; a gust (crossing 0.5) every 11–13 s on median, 1–2 s at the shortest (a double peak) and ~44 s at the longest (a long lull).
- **What it moves:**
  - **Grass** (`world/grass.js`, `GrassMaterial`): the field bows the tufts (up to ~0.25 m at the tips), the flutter grows with it; between gusts only a slow breath is left. A front crossing a field of grass is a visible wave.
  - **Scrub** (`swayMaterial` in `world/dressing.js`, `SwayMaterial`): it did not move at all before. Stiff and woody: the top bows downwind in a gust and shivers. The copies are turned at random, so the push is worked out in the world and turned back into the copy's frame (WebGL: the inverse of the instance matrix; WebGPU: after the instance transform).
  - **Cloth** (`clothMaterial`: the arena's flags and banners, the course's strips, awnings and banners): the gust at the cloth's place swells the waves and adds a fast flutter (the flags snap); a strong gust holds a flag out straighter. The travelling speed stays the same: a speed that followed the gust would jump the phase. On WebGPU the displacement now goes on after the copy's transform, along its normal, so the gust can be taken at the copy's place.
  - **Sand:** the streamers (C10), the drifting puffs and the spindrift off the crests are emitted and moved with the gust where they are (twice the spindrift attempts, most dropped in a lull: the veils thicken in a gust).
  - **Tumbleweeds** all but stop in a lull and race in a gust; their roll and hops follow the distance travelled.
  - **The wind's sound** (`audio.js`): the gust at the camera (half of it down in the canyon) replaces the random one; it swells as a front reaches the camera.
- **What it looks like:** from a tuft's side, a front arriving bows it over within a second and lets it up over the next few (`clip.mjs --tuft`). The wave across a field of grass reads from the chase camera; across the open dunes it shows in the spindrift and the sand streams.

### 3. Sand pouring from the rock (`trickle`)

- **Placement (`world/trickle.js`, `placeFalls`, ~130 ms at load):**
  - **The canyon rim:** the walls' profiles are recorded while they are swept (main.js `CANYON_WALLS`: every vertex of a row, and the rim beyond). The walls lean back, so a fall from the rim cannot drop straight: each slants from just in front of the top lip down to the floor, its bottom chosen so that the whole line clears every vertex of the face by 1.4 m. Up to 8 a side, at least 50 m apart, not under the tunnel.
  - **The tunnel's lips, the arch and the bridge:** raycasts up into the slabs (`userData.tunnel`), the arch's finest level and the bridge; an overhang's edge is found by stepping out along the track until the rock overhead runs out, then bisecting (stepping every 0.75 m took ~670 ms; this takes ~130). Two per tunnel lip, five off the arch's edges and four off the bridge's, plus a thin one from a crack in each slab's ceiling.
  - 40 falls on this track.
- **The strands (`buildTrickle`, `trickleMaterial`):** each fall is two or three strands (the main one, thinner and fainter ones beside it along the lip, some starting a little lower), one instanced mesh per cluster of falls (the canyon and the bridge, the arch: each culled on its own). A strand is a strip of 28 segments along a curved path, turned about the path's own tangent towards the camera, widening as it falls (0.1–0.5 m at the top, 0.6–3 m at the bottom). The path: the arc of a pour (the sand leaves the lip outwards at 0.5–1.4 m/s, so it curves out first and then drops; off an overhang the landing point is where the arc takes it, on the canyon rim the landing stays clear of the face and the arc bulges out from it), a slow wander in the air that grows with the distance fallen and travels down the stream with the sand, and the gust swinging the lower part downwind. The width necks and swells as clumps fall (a pattern travelling at the fall's speed); the edges are ragged (grains straying out of the stream). The streaks are laid out in the time a grain takes to fall that far (τ = √(2d/g)), so they speed up as they fall; lower down they break into clumps. No thinner than ~1.5 px (far falls widen and fade instead of shimmering), and they fade out within ~12 m of the lens (a fall right by the camera smeared across the frame). Lit like the canyon's hanging dust: the sun through the world shadow, strongly forward scattered, so a fall lit from behind glows.
- **Per frame:** a dust puff where each lands (near the camera); a pod passing within 24 m shakes loose a heavier pour (wider, denser, for ~2.5 s) and 4–8 pebbles (the confetti pool, falling).
- **What it looks like:** the tunnel's gaps are the best of it: thin glowing falls in the shafts of sun, against the dark under the slabs, read at race speed. The bridge has two falls under it. The rim falls are subtle (pale sand against the same sandstone, or in the wall's shade); up close they read as fine streams down the face.
- **Things that bit:** a single straight ribbon per fall read as a light beam or a hanging sheet, not sand: hence the strands, the arc and the wander. A ribbon seen end-on from right under it is a wide bright streak; the near fade handles most of it.

### 4. Spectators out on the course (`camps`)

- **People:** the crowd's sprites (they are whole standing figures already, so no new atlas row was needed). The crowd shader got `uStand`: the arena's sitting figures are sunk 0.5 m behind the row in front, which out here would cut them off at the knees. One crowd draw per group, culled by a sphere round its people, with its own cheer: the pack within ~160 m and they jump and wave, fading over a few seconds after (`dress.crowdGroup` in `world/dressing.js`).
- **The groups (`world/course.js`):**
  - **The stone bridge:** 18 along both edges of its deck (found by raycasting down onto it and stepping out to the edge: anywhere back from it, the deck hides them from the slot), and two fan banners hanging off the side the pack comes from. From the slot they are silhouettes against the sky.
  - **The canyon rim** over the tunnel's gaps and after its exit: 11 each, on the face's very top edge (the rim rises behind it and would hide them), their camp 35–50 m back on the rim's top (heights from the walls' profiles).
  - **On top of the arch:** 12 along its front and back edges (raycast down onto it; its top is broad and rounded, so anywhere else the bulge hides them from the road).
  - **A dune crest outside a fast corner** on the open desert (the corner with the largest curvature × speed, the highest ground 40–95 m outside it): 26 along the crest, the biggest camp behind them.
- **The camps:** tents (a ridge tent, canvas sagging between the poles; tinted per copy), an awning (its frame from Blender, its canvas cloth in the game, tied along the high bar and flapping over the low one), hover-bikes (tinted per copy), a cargo crawler, a fire pit with a thin plume of smoke (the smoke pool, near the camera), and a banner strung between two poles (fan banners: "HAJRÁ!", "HOMOKFUTAM", "GYERÜNK!", "★ 7 ★", sun-faded). Only the pale painted parts of a copy take its tint.
- **What it looks like:** the bridge with people on its edge and the banners hanging off it reads from far down the slot; the crest camp reads from the track at ~120 m; the rim groups show as small silhouettes against the sky. At race speed they read as people where they stand against the sky.

### 5. Trackside markers (`markers`)

- **Props (`models/world/build_course.py` → `assets/world/course.glb`):** a weathered wooden pole (3 m, a little crooked, the grain opened up, sun-bleached at the top and sand-blasted dark at the foot, a rope wrap where the strip is tied) and the same pole snapped at ~1.7 m (a splintered top); two cairns (stacked cut stones, each a little off the one below); two oil drums (rolled rims, rolling hoops, dents, red and blue paint going to rust). Vertex colour tint, baked occlusion in the alpha, as the other props; every part's normals made consistent before the bake (`bmesh.ops.recalc_face_normals`).
- **Placement (`world/course.js`):**
  - **Poles:** both sides of the open stretches (not the canyon, the arena or near the arch), every 25–40 m, just past the berm's ridge (3.4–4.8 m out), on the drawn surface. 18 % lean (6–15°), 8 % are snapped. 252 on this track. Each whole pole has a strip of faded cloth (1.15 × 0.2 m) tied under its top, streaming downwind and flapping with the gust (`clothMaterial`).
  - **Cairns:** beside every chevron board (dressing.js now exposes its board list), 9.5–11 m out.
  - **Drums:** where the braking for a corner starts (where `TR.vmax`, which already brakes ahead of the corners, starts to fall by at least 12 m/s), 2–3 on the corner's outside, sunk 0.25–0.5 m and tilted up to 26°. 23 on this track.
- **Draws:** the poles, drums and all the camps' props are one merged mesh (`propMaterial`: vertex colour × the baked occlusion); the cairns another (the rock material); the strips one instanced mesh.
- **What it looks like:** from the chase camera the poles and their strips flick past at the edge of the frame on the open stretches; nothing blinks. Whether the speed reads as well as with the lights needs a judgement in play (a side-by-side clip against the commit before the lights' removal is still to do).

### 6. A landmark (`landmark`)

- **Changed from the plan:** neither the statue nor the crashed carrier, but **the wreck of a colossal bucket-wheel excavator** (the biggest crawler there is). A first try at a crashed carrier (a long hull, the mid-section stripped to its ribs, a command tower) read as a submarine from the side, and its loose plates in the gap read as noise. The excavator's outline is unmistakable at any distance: a great wheel, a long diagonal boom, a lattice pylon with its stays.
- **Built (`models/world/build_landmark.py` → `assets/world/landmark.glb`):** three track units sunk in the sand and a turntable; the machine house with the operator's cab under the boom; the main boom (a lattice truss) come down so that the 36 m wheel at its end lies half buried; the wheel with two rims, spokes and its buckets (some torn off); the counterweight boom reared up behind with its block; an A-frame pylon of two lattice legs (~83 m); stay cables to both booms, two of them snapped and hanging; a discharge boom off the side, its end in the sand. The whole machine lists a few degrees. Weathered paint (a dark ochre, so it holds against the noon haze) going to rust, bare steel low down where the sand scours it, sand on whatever faces up.
  - **Levels of detail are built, not decimated** (decimation would eat the thin lattice): LOD0 the full lattice (7.2k triangles), LOD1 the chords and the bays' frames (4.8k), LOD2 solid box beams and a plain wheel (0.9k), switching at 450 and 1200 m (× the scale).
- **Placement (`world/landmark.js`, ~70 ms at load):** a search over the map for a spot the track passes once at 150–260 m that is ahead of the driver (within ~30° of the heading, 350–1300 m away) on as much straight track as possible, not from the canyon or the arena's stands, best with the sun behind or beside the driver (looking into the sun the haze and the glare washed it out), clear of the mesas and spires. It is turned broadside to those views, scaled 1.3× (the pylon ~108 m, the wheel ~47 m across), tilted to follow the ground and sunk a few metres. On this track: at (−1001, −262), nearest pass 206 m.
- **What it looks like:** ~850 m away a small but distinct outline of a wheel and a tower over the dunes; ~450 m away dead ahead at the end of a straight; on the close pass the wheel stands huge beside the road. Static: the world shadow and the mid shadow have it.

### 7. Pods disturb the world (`wake`)

- **The wake (`gfx/wind.js`: `updateWake`, `WAKE_GLSL`, `wakeAt`; `gfx/tsl/wind.js`: `hfWake`):** the 8 pods nearest the camera go into two uniform arrays every frame (position and a strength from the speed; heading and speed). The wake is stateless: behind a pod, in a corridor that widens with the distance (3.5 m + 0.3 m per metre), things are blasted back by the jets and dragged along, and ring down like a damped spring: a point `along` metres behind was passed along / speed seconds ago, so exp(−2.2 t) cos(8 t) needs no history. In front of it a bow wave pushes things out (~8 m). Returns the push and the corridor's core.
- **Grass and scrub** add the push to the sway (all 8 pods).
- **The sand streams** (item 1): a lane behind each pod is blown clear and fills back in (4 pods).
- **The canyon's hanging dust** (the volumetric light, C5): its wisps are pushed along the wake and a lane behind each pod is cleared (3 pods per step).
- **Tumbleweeds** (JS twin `wakeAt`): kicked along by the blast and thrown up into the air, then roll on.
- **Birds (`world/birds.js`):** three small flocks perched on the canyon's top edge (from the walls' profiles, not by the bridge or under the tunnel), wings folded. When the pack comes within ~170 m they startle, each a beat apart: a burst of wingbeats out over the slot and up, circling on the rising air, then after half a minute a long glide back down to the perch. One instanced mesh.
- **What it looks like:** a tuft beside a passing pod is flattened by the blast and whips back and forth for a second (checked with a pinned virtual pod through `__homok.setWake`).
- **Cost:** a loop over 8 pods per grass and scrub vertex; 3 per step of the volumetric march (16 steps, half resolution, the canyon only); 4 per drift-sheet pixel.

### 8. Lens touches (`lens`, on trial)

- **Built (`gfx/screen.js`: `LENS`, `lensDirt()`, `GRIT_GLSL`; `LensEffect` in `gfx/post.js`; the composite in `gfx/tsl/post.js`):** a procedural smudge texture (soft blotches denser towards the edges of the glass, wipe arcs, specks of grit) multiplied by the bloom's blurred bright areas and added in front of the tone mapping, so it shows only round the sun, the tunnel's exit and gaps. In the sand streams (item 1), short-lived grains streak across a few cells of a grid over the screen, more in a gust and at speed (`LENS.grit`, main.js `updateWind`).
- **What it looks like:** facing the sun, specks and smudges glow round it; elsewhere nothing. At strength 0.9 it did not show; 2.5 is the default now. A matter of taste: off on every preset, `?gfx=lens:1` to try.

### Grow-in instead of pop-in (the grass, the ground clutter)

- **What it was:** the grass (C8) is drawn in 130 m chunks that switch on whole within 75 m of the camera, so a block of tufts appeared at once; the ground clutter (pebbles, stones, bushes, bones, scrap: `world/scatter.js`) is culled copy by copy at a hard distance per field, re-sorted every fourth frame, so it arrived in clumps at that ring.
- **Now:** each tuft shrinks to nothing at its root over the last third of the grass's distance (by its own distance to the camera: a tuft within the distance is always in a chunk that is shown, so the chunk's switch is invisible); WebGL reads the root from the instance matrix, the node material from a per-copy `iRoot` attribute. Each clutter field's copies rise out of the ground (sunk by about their height) over the last ~28 % of its draw distance: `rockMaterial`'s `fade: { far, depth }` (the stones, pebbles and scrap), a small faded standard material for the bushes and bones; every field gets its own material, made with its distance. All in the vertex shader: no CPU.
- **Cost:** a distance and a smoothstep per vertex.

### Things that bit

- **A camera jump in the harness:** the first capture after a big camera move came out washed out (the exposure and TRAA's history settling); captures now wait ~40–60 frames after a `view()`.
- **Hidden behind the rock:** people on the canyon rim, the arch and the bridge had to stand on the very edge (found by raycasting); anywhere back from it the edge hides them from below.
- **Thin geometry and LODs:** the wreck's lattice cannot be decimated; its levels are built.
- **The drawn surface is not `groundQuery`:** the road is 0.35 m above it and the berm exists only in the track mesh; anything draped over the track needs `surfaceAt`.
- **`|` inside a JS snippet** split the harness's view definitions (`name|js`): split at the first one only.

### Totals

All of E as shipped against every E key off (`?gfx=gust:0,drift:0,trickle:0,markers:0,camps:0,landmark:0,wake:0`), after the culling above; grid / dunes / drift / canyon / tunnel / arena, interleaved rounds:

| Preset, size, renderer | Change (ms) | Draws |
|---|---|---|
| High, 2560×1440, WebGPU (GPU time, 2 rounds) | +0.37 / +0.12 / +0.08 / +0.08 / +0.03 / −0.08 (the grid's is one round's +0.65) | |
| High, 1920×1080, WebGPU (frame, CPU-bound; 3 rounds) | −0.12 / +0.08 / +0.10 / +0.05 / −0.27 / −0.30 | +13 / +4 / +13 / +19 / +1 / +11 |
| High, 2560×1440, WebGL (frame, 2 rounds) | +0.75 / −0.16 / +0.29 / +0.51 / +0.06 / −0.08 (the grid's is one round's +1.21) | |
| Medium, 1920×1080, WebGL (frame, 2 rounds, before the culling) | −0.13 / −0.06 / +0.11 / +0.13 / +0.19 / +0.30 | |
| Low, 1920×1080, WebGL (frame, 2 rounds) | −0.04 / 0.00 / +0.21 / −0.01 / −0.01 / +0.19 | |

- **WebGPU:** nothing measurable on the CPU now (it was +0.15–0.6 ms with outliers before the culling), ~0.1 ms of GPU.
- **WebGL:** within noise except the canyon, +0.5 ms (falls, birds, the bridge's and the rim's groups, the wake in the volumetric dust), +1.0 before.
- **Low and Medium:** within noise.

### What is left in E

1. **Markers vs the chase lights:** the side-by-side clip at race speed (markers, nothing, and the commit before the lights' removal), to judge whether the speed reads.
2. **More drift stretches:** this track has two; the criteria allow up to four (looser wind-crossing, or dunes nearer).
3. **The rim falls** are subtle; a few from overhanging lips (where a fall hangs free in front of a shaded face) would read better than falls down the face.
4. **The wreck in the light bake:** it is outside the `gi` volumes; a small volume round it would warm its shade.
5. **Birds and cheering in replays** follow the live racers, not the replay's proxies.
6. **The lens:** decide in play (it is off).

### Measuring E

- **Cost:** the D protocol (`tools/batch.mjs` against a frozen snapshot), with a bench spot on the first drift stretch: `--spots grid:0,dunes:10,drift:2.5,canyon:7.5,tunnel:7,arena:13`. Variants: every E key off, all on (as shipped), and each key alone on.
- **Clips (`tools/clip.mjs`):** steps the shader clock through a series of times from a fixed camera with the race paused (gusts, the sheet's streaks, falls), or captures in real time (`--real`); `--tuft x,z` frames the grass tuft nearest a point from across the wind, `--track s,d,h,ahead,lh` a camera over the track.
- **Fixed views (`tools/views.json`):** `driftRoad` (the first drift stretch), `tunnelGap` (the falls in the tunnel's first gap), `bridgeCrowd`, `crestCamp`, `wreck` (the landmark ahead at ~450 m), `markers` (an open straight); the montage: `node shots.mjs e --views driftRoad,tunnelGap,bridgeCrowd,crestCamp,wreck,markers "q=high&renderer=webgpu&gfx=gust:0,drift:0,trickle:0,markers:0,camps:0,landmark:0,wake:0" "q=high&renderer=webgpu"`. Several views in one page carry the eye's exposure from one to the next (a dark tunnel after a bright desert): compare dark places in runs of their own.
- **Debug hooks:** `__homok.gust(x, z, t)`, `drift` (the stretches), `driftSheet`, `trickle` (the falls), `course` (the groups, counts), `landmark`, `birds`, `setWake(k, p, v)` (pins a virtual pod into the wake arrays while paused), `LENS`, `ground(x, z)`, `trackPoint(s, d)`.

---

## F. Collisions and hits: items 1–6 done

**Status (October 2026).** Items 1–6 are built and work on both renderers:
- the hull;
- the field;
- the spin;
- the pod's reaction;
- the sparks;
- the breakable parts.

Not done yet: item 7 (debris kit v2) and item 8 (scrape marks), see "What is left in F".

Decided with the user:
- **Per-model hulls:** each pod model collides with its own shape. There is no standard size.
- **Hits turn the pod:** an off-centre contact spins it.
- **Damage stays visual,** but parts can break off (modelled in Blender).
- **The world's solid parts are one distance field** (option B3), not a shape per object.
- **Blender:** the collision capsules are authored there, and effects can be made there too.

**Switches:**
- `?col=0` brings back the old collision (one circle, the clamps). It is not a `?gfx=` key: graphics presets must never change the physics.
- `?gfx=hitfx:0` brings back the old hit effects. It is on in all four presets.

### Results

**Clipping and cost of a hit:** `tools/hits.mjs`, old (`?col=0`) against new, the same hull and field in both.
- *clip*: the deepest the hull got into the world, or for the two pod cases, into the other pod's hull.
- *end*: the speed at the end of the case.
- *turn*: the heading change over 0.5 s after the contact.

| Case | clip old → new (m) | end old → new (km/h) | turn old → new (°) |
|---|---|---|---|
| Canyon wall, 5°, 540 km/h | 0.55 → 0 | 511 → 505 | 21 → 20 |
| Canyon wall, 20° | 1.83 → 0 | 486 → 473 | 32 → 30 |
| Canyon wall, 60° | 5.73 → 0 | 265 → 229 | 28 → 57 |
| Arena wall, 20°, 400 km/h | 2.71 → 0 | 430 → 420 | 29 → 29 |
| Boulder, head on, 300 km/h | 1.57 → 0 | 2 → 13 | |
| Spire, head on | 6.94 → 0 | 57 → 3 | |
| Nose to tail, 468 vs 342 km/h | 1.90 → 0 | 441 → 374 | |
| Side by side, steering in | 1.90 → 0 | 417 → 461 | |

- **Clipping:** nothing gets into anything any more.
- **Grazing hits:** they cost what they did, within 1–3%.
- **A near-square hit** (60°) now swings the pod round parallel to the wall: the turn the user asked for. It ends ~14% slower than before.
- **Nose to tail:** the pods now meet where the follower's nose meets the leader's tail, not 8 m deeper.

**Driving feel:** `tools/feel.mjs --slide --bots`, old against new.
- **Unchanged:**
  - steering, slides and the sand;
  - the wall hits at 3–35° (within 1%);
  - the autopilot's lap (50.24 → 50.22 s);
  - the bots' best laps (+0.0–0.6 s per difficulty).
- **The modelled keyboard drivers vary from run to run, even with the old collisions.** A small difference early changes the whole lap. So each mode was run three times; the numbers are the mean of all laps:

  | Driver | old | new |
  |---|---|---|
  | Skilled | 54.2 s | 56.1 s (one 64 s lap; 50.7–57.8 otherwise) |
  | Slider | 50.2 s | 52.7 s |
  | Average (weaves, ~40% of the time on the sand) | finished 1 run of 3 | finished 1 run of 3 |

  - **In the canyon:** they touch the walls about as often as before. The old clamp let their engines sink ~3 m into the rock instead.
  - **Where the extra time goes:** things that were not solid before, mainly boulders 11+ m off the edge. The model never reverses and has no respawn key, so after it hits one and ends up facing backwards it can stay there; it did that with the old collisions too.
  - **The canyon's mouths** cost these drivers time and got them stuck before the ramps (item 2's ramps, below). Now they ride up and are turned back.
- **The bots in full races** (three 3-lap races, all six, per difficulty): no pod is ever stopped for more than ~1 s, and the best laps match the old ones. Before the slow-pod turn (item 3), a bot that hit the canyon wall square sometimes sat against it for ~2 s.

**Cost:**
- **Simulation:** 0.084 → 0.118–0.143 ms per 1/120 s physics step, for six pods with the AI and the effects (`__homok.sim`, two rounds). That is ~+0.1 ms per frame at 60 fps.
- **Frame benchmark** (`bench.mjs`, Low, WebGL, 1080p): within its noise of ±0.5 ms JS.
- **Boot:**
  - the rock patches take ~145 ms (153 patches, 0.89M cells, 3.5 MB);
  - the walls take a few ms;
  - the pod is one more promise the boot waits for.
- **Pod model:** 1.95 MB as before, 43.9k triangles. It has 11 breakable parts and 7 stumps. The atlas is re-baked.

### Why: what the old code does

The pod is ~14.1 m long and ~6.2 m wide. In body space (+z forward, +x left), the cockpit tail is at z −4.5 and the engine fans at +9.7. Every check stood one 3 m circle (`POD_R`) in for it:

| Case | Old code | Result (from the model's sizes) |
|---|---|---|
| Sliding along a wall | The pod's origin is clamped to `hw − 1.6`. The drawn canyon foot is at `hw + 0.8` and the face at pod height at ~`hw + 2`; the arena bays are at `hw + 1.2`. | The outer engine is ~0.7 m into the rock. |
| Nose into a wall at 20° / square on | Same clamp. | ~3.8 m / ~7 m of engine inside the rock before the pod stops. |
| Rock, head on | A circle round the origin, no forward offset; only tested when `\|d\| > hw + 3`. | The engine fronts are ~6.5 m inside the rock when the hit registers. |
| Pod behind pod | A circle 2.5 m ahead of each origin; it covers z −0.5…5.5 only. | The follower's engines sit ~8 m deep, beside the leader's cockpit. |

The world disagrees with itself too:
- The talus piles and fallen blocks at the canyon foot have no collider and spill onto the road.
- The canyon wall is drawn from `canyon > 0.01` but solid only from `> 0.3`.
- The arena is solid from `0.3` but drawn from `0.55`, so there is an invisible wall.
- Boulders are slabs and shards but collide as circles.
- The arch's circles stop a pod 3–7 m short of the rock.

The hit itself:
- `impact()` turns the heading by up to half the angle to the wall in one step (a visible pop).
- The sparks spawn at a fixed offset from the centre, at body height.
- Nothing falls off the pod but generic shards.

### The items

| # | What | Switch | State |
|---|---|---|---|
| 1 | **Hull (A1, A2):** a few capsules per pod model, in body space, made in Blender (`COL_*`), read from the model | `?col=0` | done |
| 2 | **The world's solid parts as one distance field (B3)**, at pod height | (1's) | done |
| 3 | **Hits turn the pod (A3)** | (1's) | done |
| 4 | **The pod reacts (A4):** roll and pitch kick, the cockpit whips, the struck engine is knocked, shudder | `?gfx=hitfx:0` | done |
| 5 | **Sparks where it touches (D1):** from the contact, along the slide, cooling, bouncing; flash, dust, chips, paint flecks | `?gfx=hitfx:0` | done |
| 6 | **Parts break off (D5):** real parts in Blender, with torn stumps | (crashes) | done |
| 7 | Debris kit v2 (Blender): torn two-tone panels, bolts, sandstone chips | | left |
| 8 | Scrape marks on the walls (D3) | | left |

### 1. Hull (`hull`, playerPod.js `readHull`, `makeHull`; models/pod/build_pod.py `capsule`)

- **In Blender:** `capsule(name, parent, a, b, r)` makes an empty `COL_<name>` at the capsule's centre, along its local Y, with the extras `col: 'capsule'`, `r`, `half`. A wireframe `COLVIS_` child shows it in Blender; `bake_export.py` deletes those before baking. The glTF export and gltfpack (`-kn -ke`) keep the empties and their extras.
- **pod_player's seven capsules:**
  - each engine, intake lip to nozzle (r 0.86);
  - the cockpit tub, nose scoop to rear grille (r 1.05);
  - each outboard stabiliser fin (r 0.3), under its breakable part;
  - each stub wing (r 0.42), under its breakable part.
- **In the game:** the capsules are read from the source scene's rest pose into body space (`readHull`). A capsule under a breakable part carries that part's bit, so when the part has gone the capsule no longer counts (`hullWorld`). A model without `COL_*` gets one capsule each along z through the bounds of `Engine_L`, `Engine_R` and `Body_static`. `DEFAULT_HULL` holds the same measured numbers and is used until the model is in, and by the simple pod. The boot now waits for the pod model (`POD_READY`), so a race always has the model's hull.
- **The hull drives:**
  - `k2`, the squared radius of gyration about the origin, from the capsules' areas (pod_player: 5.4 m);
  - `reach`, the broad phase (9.9 m);
  - `mass` (extras on `Pod`, default 1).
- **Per-model and per racer:** every racer has `r.model` and `r.hull`, all `pod_player` today. A second model will need the lobby to carry each player's model, so every machine collides with the right hull.

### 2. The world's solid parts as one field (`world/solid.js`; main.js `SOLID`, `addRockSolids`)

- **The band:** what counts is the rock between 0.6 and 3.2 m above the ground (`BAND`), the heights a hovering pod's hull occupies. A low slab below that is flown over, an overhang above it is passed under.
- **Walls**, per metre of arc length and side of the track:
  - each has a face offset from the centre line and a back, with end caps where a wall starts or stops (`setWall`, `finishWalls`);
  - a query finds the track frame from a hint sample, the pod's own, ±6 samples;
  - the distance is the intersection of three half-planes in (s, d), and the normal comes back to the world through the frame.
  - **The canyon:**
    - The sweep's cross-section is now two functions shared with the mesh: `slice()` per arc length, `faceAt()` per height.
    - The field takes, per metre, the face where it stands out furthest within the band above the ground at its foot. It is computed at a fixed resolution, so `?gfx=geo:1` (finer rows) does not change it.
    - The face comes out at ~hw + 2.0 in full canyon. Where the wall is lower than the band (the ends) there is none.
    - Solid is the face itself, out to 3 m past its top row (the back). Beyond that is the rim.
    - The ends are ramps; see "The canyon's mouths are ramps" below.
  - **The arena:** the bays' line (hw + 1.2), solid back to the stands' back wall (hw + 42), over the range where the bays are drawn.
- **Rocks**, one patch each (`addMesh`):
  - **Which rocks:** every spire, boulder (including the canyon's fallen blocks) and talus pile within hw + 160 of the track, plus the arch.
  - **Which geometry:** the base `rocks.glb` models' finest level, never the `?gfx=geo:1` spires, with the instance's matrix. If `rocks.glb` fails to load, the fallback shapes are used.
  - **How a patch is made:**
    - Triangles near the band are clipped to it, using the ground under each triangle from a 4 m lattice.
    - Their XZ footprints are filled conservatively: every cell they touch, so a vertical face makes a closed ring.
    - Free cells the border cannot reach are filled in as solid.
    - A Felzenszwalb distance transform is run both ways.
  - **Resolution:** 0.25 m cells under 14 m across, 0.5 m above, plus 6 m of distance round each rock.
  - **Lookup:** a 32 m hash finds the patches near a point.
  - This track has 153 patches.
- **What changed on the course:**
  - the talus at the canyon foot and the fallen blocks are solid;
  - the canyon walls are solid where they are drawn, from their low ends at the mouths;
  - the arena's invisible wall between `arena` 0.3 and 0.55 is gone;
  - the arch's legs are solid from ~28 m off the centre line (the circles began at 23 m);
  - boulders have their real outlines.
- **Not yet in the field (they were not solid before either):** ruins, wrecks, pylons, markers, boards, the landmark.

#### The canyon's mouths are ramps (main.js `RAMP`, `slice`, `faceAt`, `rockContact`, `HIT_RAMP`; world/solid.js `addRide`, `rideAt`, `rideSlope`)

**Why:** with the walls solid where drawn, a pod that ran wide at a mouth hit the rock prows 6–30 m off the road, square on, and wedged there 2–3 hits in a row.

- **Drawn:** where the wall is lower than 30 m (`RAMP.h1`), its face lies back towards a slope of 1 m up per 2.6 m out. It is all slope below 5 m of wall (`h0`). The rim moves out past the slope's top and loses its lip. At each mouth the wall's end now runs down into the sand as a long rock ramp; deeper in, the faces are as they were.
- **Ridden:**
  - The field keeps, per metre and side, the drawn cross-section (face, rim, slope beyond), and the pods hover over it where it is higher than the ground (`rideQuery`: the physics' height, the visual clearance, the dust, the contact shadow).
  - On the ramps, rock under any part of the hull lifts it clear, if it is within 1.2 m of the hull's underside (`RAMP.step`).
  - On the rock, its slope pushes the pod back down (`RAMP.bank`, 28 m/s² per unit of slope).
- **The wall line:**
  - It runs unbroken from the ramps into the faces. On a ramp it sits 1.5 m higher up the slope (`RAMP.climb`), so a pod rides that far up first.
  - Its start comes in from the side: where the wall is only beginning, the line starts up to 34 m further out (`RAMP.taper`, gone at 20 m of wall). So it is met at an angle over drawn rock, never square on.
- **Soft on the ramps:** meeting the line on a ramp turns the pod along it like a banked berm (`HIT_RAMP`): no bounce, the speed kept but for up to 25% at a square hit.
- **Measured** (a pod running wide at a mouth at 300 km/h, no steering):

  | Angle out | Before the ramps | With them |
  |---|---|---|
  | 7° | rock face, −49%, wedged | rides up, turned back to the road, −14% |
  | 15° | −29% | climbs ~4 m up the ramp, turned back, −28% |
  | 30° | stuck | climbs ~8 m, turned back, −33% |

### 3. Hits turn the pod (main.js `collideWorld`, `hitWorld`, `addSpin`, `collidePods`)

- **Against the world, each 1/120 s step:**
  - The deepest point of the hull in the field (capsules sampled every 0.7 r) is pushed out along the normal.
  - Up to three contacts are resolved per step.
  - Pods with nothing within reach skip the samples: the walls' distance at the origin and the patch hash rule that out.
- **The response:**
  - **Bounce and speed kept:** exactly as tuned (`HIT_WALL`, `HIT_ROCK`), on the pod's centre.
  - **The turn:** from the impulse that stops the contact point, with its lever arm about the origin and the hull's inertia × `SPIN.inertia` (1.6). It goes into `r.spin`, which the yaw integrates on top of the steering and which dies away at `SPIN.decay` (5/s). The steering's yaw rate follows the stick within ~20 ms, so a kick there would vanish.
  - **How far it turns:** towards the new direction of travel, at most `SPIN.align` (0.85) times the way that lines the nose up with it. The other way (a hit on the tail), at most ~9°.
  - **One hit, one cost:** the nose and then the tail swinging in count once (`wallCD` 0.6 s).
  - **A slow pod left nose-first against the rock** (below 25 m/s after a square hit) is turned along it, the way the track runs, within ~0.5 s, as the old collisions did. Before this, bots sometimes sat pushing into the canyon wall for ~2 s.
- **Pod against pod:**
  - the deepest pair of capsules (segment–segment distance in the plane);
  - a two-body impulse with both lever arms and spins, e = 0.3;
  - a pod driven by another machine is immovable here, as before.

### 4–5. The pod reacts, sparks where it touches (`kickPod`, `hitFx`, `racerFx`; gfx/particles.js)

- **Every contact** carries where it touched: the point on the surface, the capsule's height, the normal, the material (canyon, arena, rock), the capsule, the other pod.
- **Kick:**
  - The body rolls up on the struck side and pitches (a nose hit lifts the nose) on a spring that rings out in ~0.5 s (peaks ~7° and ~4°).
  - The cockpit swing spring gets the shove: it is left behind when the engines are hit, pushed when it is hit itself.
  - The struck engine (an engine or fin capsule) is knocked aside and up on its own spring (up to 0.4 m).
  - The body shudders in proportion to the hit.
- **Sparks** come from the contact:
  - they are dragged along the slide and thrown off the face;
  - the particle pools have two new per-particle options: `cool` (white-hot through orange to a dull red, dimming, on the CPU so both renderers get it) and `bounce` (off the ground);
  - a short flash marks the bite (the fire pool);
  - dust and grit blow off the face (pale plaster in the arena);
  - rock chips fly out along the normal.
- **Pod against pod:** flecks of the other pod's paint (the confetti pool), and both beams strain and arc.
- **Scrape:** the stream follows the contact point while the pod grinds along, with grit off the face.

### 6. Parts break off (models/pod/build_pod.py `build_wing`, `build_antenna`, `build_engine`; playerPod.js `setBroken`, `breakPart`, `stowPart`; main.js `breakParts`, `flyPart`, `updateFlying`, `partsTo`)

- **The parts (11):** two stub wings, two outboard stabilisers with their flaps, four air-brake leaves, the antenna with its pennant, two engine access hatches.
- **In Blender:**
  - Each part is an empty with the extra `brk` (`BREAK_<name>`, or the brake pivots).
  - Beside it sits `STUMP_<name>`: a torn wing root, a ragged stabiliser root, the dark opening behind a hatch with two pipes, a snapped mast.
  - The meshes keep the parent's coordinates, so the shapes did not change.
  - The stumps are baked 40 m away (`bake_export.py`): baked in place, a stump inside its part would darken both, through the surface's bevel and AO nodes.
- **In the game:**
  - A part is a node of the skinned pod. A crash takes the 1–3 parts nearest the contact (by power).
  - Each part is lifted out of the pod into the scene (`scene.attach`) and flown: it keeps most of the pod's speed, gets a push out from the pod's centre and up, tumbles about its centre, bounces on the sand with a puff, smokes, sinks after 3–5 s and is put away.
  - Its stump shows from the moment it breaks until the next race.
  - The merged meshes follow their bones wherever they are, so a flying piece is the pod's own geometry in its own livery: no new meshes, materials or shader compiles. While a piece flies, the pod's meshes are not culled by their rest bounds.
  - When parts tear, a crash throws 3 generic painted shards instead of 8.
- **Sync:**
  - `r.broken` (the mask) goes over the network as the 19th field of a pod's state. Each machine flies the parts that newly went.
  - It is recorded in the replay. The replay shows the parts as they were at its start, without touching the racers' own masks.
  - A new race puts every part back (`partsReset`).
- **The simple pod** (LOW's rivals) has no parts and keeps the generic shards.

### Things that bit

- **The spin at first took the bounce:** an impulse at an off-centre point puts part of it into rotation, so the pods kept less speed than with the tuned response (a 20° graze cost 5% more). Now the linear response is the tuned one and only the turn comes from the contact.
- **The tail slap counted twice:** the nose hit, the spin swung the tail into the wall 0.3 s later, a second "fresh" hit with its cost.
- **Stumps inside parts:** both would bake dark; baked apart.
- **A wing stump inside the hull:** the first torn wing root ended at x 0.97, inside the tub (~1.0 there); it now reaches 1.1–1.3.
- **WebGPU captures with the game's loop held** show a stale frame (nothing is presented); capture WebGPU in real time.
- **Field queries need a hint:** a query far from the hint sample got a nonsense frame (the walls are skipped when the nearest sample is over 200 m away).
- **Line endings:** the sources are CRLF on disk; multi-line edits by script must match them.
- **The ramps took four goes.** A flat field cannot tell a pod riding up the rock from one at road level:
  - A ramp before a wall in the field left a square end, which pods on the ramp met head on.
  - A slanted end over the ramp stood on open sand in front of the canyon, where nothing is drawn.
  - Collision by the rock's height made pods drive into gentle slopes: the hover only looked under the pod's centre.
  - What works: the hover lifts for rock under the whole hull, and one wall line runs on from the ramps into the faces, its start coming in from the side and soft on the ramps.
- **The driver models are not deterministic:** compare three runs each, not one.

### What is left in F

1. **Running wide** now rides the canyon's mouths (the ramps). Off-road boulders are still solid where drawn: decide in play whether hitting them costs too much for players who run wide.
2. **Debris kit v2 (item 7):** two-tone torn panels (paint outside, bare metal inside) need a paint mask in the debris material on both renderers (a vertex attribute mixing the instance colour with metal). Bolts, brackets and sandstone chips too.
3. **Scrape marks (item 8):** a ribbon along the contact on the canyon and arena walls (the face is known from the field), with a texture from Blender.
4. **Multiplayer (E):**
   - remote pods still are not pushed locally, so with lag their hulls can overlap ours for a few frames;
   - contact events are not shared;
   - the lobby does not carry the pod model yet.
5. **Other solids:** ruins, wrecks and the landmark's lattice could become patches the same way.
6. **Not started:** D4 (damage on the pod), D6 (camera kick, hit-stop), D7 (impact sounds per material), C (smashable props).

### Measuring F

- **`tools/hits.mjs`:** scripted hits from a fixed start. The scenarios:
  - the canyon wall at 5°, 20° and 60°;
  - an arena wall;
  - a spire and a boulder, head on;
  - nose to tail;
  - side by side.

  For each it reports:
  - the deepest any hull capsule got into the world field or into the other pod's hull, over the scenario;
  - the speed after 0.1 s and 1 s;
  - the heading change.

  Old (`?col=0`) against new.
- **`tools/feel.mjs`:** the wall costs, the lap times of the autopilot and the modelled drivers, the bots.
- **Cost:** the JS time per frame with six pods (`bench.mjs`), and the boot time of the field.
- **Visual:** frames of the scripted hits from a fixed camera.

---

## Measuring: harness and method

The scripts are in `homokfutam/tools/` (setup and usage: its README). The notes below are what they do and why.

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
| `solid` | the solid field (F2): `solid.query(x, z, hint, out)` → signed distance (m), `out.nx/nz` (outward normal), `out.mat`; `solid.stats`, `solid.walls`, `solid.patches` |
| `podEnv(k)` | 0 = sky-only lighting on the pods; k = probes at strength k |
| `rebakeProbes()` | bakes the light probes again |
| `rocks` | the rock lists, for framing spires (`rocks.arch`: the arch's position) |
| `mid` | the cached mid-distance shadow (`?gfx=csm:1`): `renders`, `draws`, `update(camera, true)` |
| `eye` | the eye adaptation (`?gfx=eye:1|2`): `metered` (EV), `target`, `ev`, `exposure` |
| `bakeGI()` | the light bake (D4): resolves to `{ buffer, header, ms, triangles }`; `?bakegi` downloads `gi.bin` instead |
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
