# HOMOKFUTAM tools

The measurement harness behind `docs/visual-next-steps.md` (sections B to F), and the light bake. Headless Chrome
driven by `puppeteer-core`, against the game on a local Vite dev server. Dev only: nothing here ships.

## Setup

```
cd homokfutam/tools && npm install          # puppeteer-core, pngjs (no browser download)
npx vite --host 127.0.0.1 --port 5199       # from the repo root, in another terminal
```

- The game must be served on `127.0.0.1` (its `window.__homok` hooks exist only on localhost). Without `--host`
  Vite may listen on `::1` only.
- `HF_BASE` picks the server (default `http://127.0.0.1:5199/homokfutam/`), `HF_CHROME` the Chrome binary (default
  the Windows install path), `HF_ARGS` adds Chrome flags (`--enable-dawn-features=allow_unsafe_apis` for
  `?gputime`).
- Every page is silenced (`speechSynthesis` stubbed, `AudioContext` suspended): `--mute-audio` alone still lets the
  announcer speak.
- Captures and logs go to `out/` (not in git). `views.json` holds the fixed world-space cameras.

## Scripts

| Script | What |
|---|---|
| `bench.mjs [--size WxH] [--dpr n] [--rounds n] [--spots name:s,…] "query A" "query B" …` | `perf()` at grid / dunes / canyon / arena (or the given spots: sim seconds after the previous one) for each query, interleaved (A, B, A, B); fps, JS ms, draws, triangles, and GPU ms with `&gputime` on WebGPU |
| `batch.mjs jobs.txt [--name n] [--port p]` | freezes the tree into a snapshot, serves it on its own port and runs a list of `bench.mjs` jobs against it (edits made meanwhile cannot reload the pages); logs in `out/<name>_<label>.log` |
| `deltas.mjs out/<log>` | per spot and round, each variant's change against the first one in a `bench.mjs` log |
| `shots.mjs name [--views a,b] [--size WxH] [--js snippet] "query" …` | the same fixed views for each query, paused, shader time and grain frozen, tiled side by side in `out/` |
| `clip.mjs name "query" [--view v \| --eye x,y,z --look x,y,z \| --ground x,z,h,lx,lz,lh \| --track s,d,h,ahead,lh \| --tuft x,z,d,h] [--from t] [--every s] [--frames n] [--crop x,y,w,h[,up]] [--real]` | things that move (gusts, falls, wakes, E): steps the shader clock through `--frames` times from a fixed camera with the race paused and tiles the frames into `out/<name>_clip.png`; `--real` lets the game run and captures in real time instead. `--tuft` frames the grass tuft nearest x, z from across the wind |
| `lum.mjs tag "query"` | HDR brightness of the scene pass per view (EV, centre-weighted EV, median, percentiles); WebGPU |
| `trace.mjs tag "query" [--from s] [--until s] [--shots t,…] [--every a:b:step]` | a race in real time through the canyon with the chase camera, logging the eye adaptation every 100 ms, screenshots at race times |
| `eyecheck.mjs "query"` | the eye's metered EV, target and exposure at a few points of a race |
| `canyontime.mjs` | seconds and metres the player spends in the canyon and under the arch at race speed |
| `feel.mjs [--tag t] [--slide] [--bots] [--only steer,slide,sand,wall,lap,drivers] [--query q]` | driving feel: full-lock turns (yaw, slide angle, speed kept), a slide and its exit, a second on the sand, wall hits at 3-60°, the autopilot's lap, and modelled keyboard drivers (real keys, 60 Hz frames, a reaction delay) with their lap times, time off the track and wall contacts; `--bots`: the bots' best laps per difficulty. Writes `out/feel_<tag>.json` |
| `hits.mjs [--tag t] ["query"]` | collisions (docs F): scripted hits at fixed starts, physics stepped at 120 Hz: the canyon wall at 5, 20 and 60°, the arena wall, a boulder and a spire head on, nose to tail, side by side. Per case: how deep the hull got into the solid field or the other pod (the clipping), the speed just after and at the end, the turn, the spin. `"col=0"` for the old collisions. Writes `out/hits_<tag>.json` |
| `bakegi.mjs ["query"]` | runs the light bake (`__homok.bakeGI()`, ~2 minutes) and writes `../assets/world/gi.bin` |
| `gidecode.mjs x,y,z …` | the baked light at world points, as E(n) / E_open(n) for the six axis normals |
| `rtspike.mjs [--radius 300,700] [--views canyonFwd,dunes,grid] [--ordered]` | GPU ray tracing (`gfx/tsl/rt.js`) against the static world round fixed cameras: rays per second for primary, random and shadow rays, checked against the CPU BVH |
| `nanscan.mjs ["query"] [view]` | WebGL: NaN / Inf in the post chain's buffers after each pass (one NaN pixel blacks out the frame through the bloom) |

Examples:

```
node bench.mjs --size 2560x1440 --rounds 2 "q=high&renderer=webgpu&gputime&gfx=sss:0" "q=high&renderer=webgpu&gputime"
node shots.mjs canyon --views canyonFwd,archIn "q=high&renderer=webgpu&gfx=gi:0" "q=high&renderer=webgpu"
node trace.mjs exit "q=high&renderer=webgpu" --from 15 --until 30 --every 25:28:0.25
```

## Notes

- Headless WebGPU needs `--disable-gpu-vsync --disable-frame-rate-limit` (set by `lib.mjs`): with vsync on,
  presentation stalls at 7–12 fps.
- Headless Chrome sometimes drops a request (`ERR_NO_BUFFER_SPACE`); `open()` retries the page load.
- Check for other GPU load before benchmarking (a game tab, another dev server's browser): it skews whole runs.
- Noise on this machine (RTX 3080 Ti): about ±0.3 ms on WebGPU GPU time, ±0.5 ms on WebGL frame time at 1440p.
