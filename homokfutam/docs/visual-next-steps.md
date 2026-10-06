# HOMOKFUTAM – visual next steps

Working notes for the next round of visual work on HOMOKFUTAM, written so a new session can pick
them up cold. Three parts:

1. **Two deferred items:** batching the exhaust plumes, and moving to WebGPU (three's `WebGPURenderer` with TSL node materials).
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

## B. Moving to `WebGPURenderer` and TSL

### What it would unlock

- **TRAA, temporal anti-aliasing.** This is the single biggest image-quality gain left. It removes the shimmer on the sand glints, rock strata, thin cables and the crowd's alpha edges, and it would let MSAA go away.
- **GTAO and SSGI** as node passes: better AO than N8AO, and screen-space bounce light, e.g. red light in the canyon on everything, not only the pods.
- **Per-object motion blur** from a velocity buffer, replacing the radial speed blur.
- **Compute shaders** for particles: move the 8 pools' CPU update loop (`gfx/particles.js` `update`) to the GPU.
- **Indirect, multi-draw `BatchedMesh`** for the rock LOD sets.

### What has to be rewritten

Every shader customization is GLSL injected through `onBeforeCompile` or `ShaderMaterial`, and none of it carries over. TSL compiles to WGSL, or to GLSL on the WebGL2 fallback. The sites:

| File | What | Notes |
|---|---|---|
| `gfx/atmosphere.js` | global chunk replacement: `fog_*`, `lights_fragment_begin` (sun × `hfSunVis`), `Material.prototype.onBeforeCompile` | Hardest: the height fog becomes a `scene.fogNode`; the baked world shadow multiplying the sun needs a custom shadow or lighting node |
| `gfx/ground.js` | terrain, track and rock/arena materials (~450 lines GLSL: 7-layer texture-array blend, macro map, glint, oil and burn, trails) | Mechanical but long; becomes `MeshStandardNodeMaterial` with `colorNode`, `normalNode`, `roughnessNode`, `aoNode` |
| `gfx/post.js` | pmndrs `postprocessing` + N8AO, custom `SpeedEffect`, `FlareEffect`, `GradeEffect`, AgX tone mapping | pmndrs is WebGL-only. Rebuild with three's TSL post nodes (`pass`, `ao`/GTAO, `bloom`, `dof`, `traa`) and `Fn` nodes for the three custom effects |
| `playerPod.js` | livery patch (paint, trim and heat masks), probe blend (`podEnvPatch` in `gfx/probes.js`) | The probe blend becomes a custom `envNode` mix |
| `gfx/podfx.js` | volumetric plume, cone plume, throats, decals, heat-distortion layer, trail map RT | Raymarch as a TSL `Fn` loop |
| `gfx/beam.js` | beam strands and flares | |
| `gfx/particles.js` | 8 pools, flipbook "6-way" lighting, soft particles | Good fit for compute |
| `gfx/fxbatch.js` and the `FLAMES` batch in `main.js` | instanced billboards | |
| `world/dressing.js` | cloth vertex sway, crowd sprites (`CROWD_V` / `CROWD_F`), dust devils | |
| `world/haze.js`, `world/horizon.js`, `world/macro.js` | haze sheets, horizon ring, macro-map bake | |
| `main.js` | `interiorMaterial()` (arena openings), sky dome (`skyMaterial` in atmosphere.js), probe bake (PMREM is supported) | |

### Approach if we go ahead

- **Spike branch with a renderer switch** (e.g. `?renderer=webgpu`). It uses `WebGPURenderer` with its automatic WebGL2 fallback, so there is still one code path.
- **Port order:**
  1. Renderer and post chain with TRAA, on unmodified materials. This alone shows what TRAA buys.
  2. Atmosphere and fog.
  3. Ground.
  4. Pods.
  5. Effects.
  6. Dressing.
- **Measure at each step,** especially on the WebGL2 fallback, and check shader compile times. TSL-generated programs can be larger, and the game already compiles about 85 programs.
- **Effort:** several sessions; I'd expect 4–6 focused ones.
- **Main risks:**
  - The atmosphere and world-shadow integration.
  - Feature parity of the post chain.
  - Ghosting with TRAA at 500+ km/h. That needs good velocity vectors for the pods and particles, and a reactive mask for additive effects.

### Alternative without changing renderer

A home-made TAA in the current WebGL stack. It needs:
- a jittered projection
- a velocity buffer: either an extra scene render with a velocity material (+~250 draws, so expensive on CPU) or MRT, which means touching every `onBeforeCompile` patch again
- history reprojection with neighbourhood clamping, as a pmndrs `Effect`

`realism-effects` (TRAA/SSGI for pmndrs postprocessing v6) exists, but it appears to be unmaintained. Evaluate it only as a quick experiment.

**Recommendation:** run step 1 of the spike (renderer, post and TRAA on stock materials) before deciding. It's the cheapest way to see what TRAA would give.

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
- Args: `--mute-audio --use-angle=d3d11 --enable-gpu --ignore-gpu-blocklist --disable-gpu-vsync --disable-frame-rate-limit`. The last two give uncapped fps.
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

### Benchmark

- **Spots:** grid (`start` + 0 s), dunes (+10 s), canyon (+10 s), arena (+20 s). `perf(150)` at each.
- **Two runs:** DPR 1, which is mostly CPU-bound and shows draw-call and JS changes, and DPR 2 (deviceScaleFactor 2), which is GPU-bound and shows shader and fill changes.
- **Interleave A and B** (A, B, A, B). Check for other GPU load first: in this session the user's own dev server and Chrome running the game skewed one run by ~35%.

### Draw-call census

- Wrap `renderer.renderBufferDirect` for one frame and tally calls and triangles.
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
  - freeze the shared `uTime` uniform (find any material with `uniforms.uTime` and redefine `value` with a getter)
  - set the grade's `uGrain` to 0
- Then tile the variants side by side into one image.
