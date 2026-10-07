import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, float, vec2, vec3, vec4, uniform, uv, pass, mrt, output, velocity, time, screenSize, screenCoordinate,
  mix, max, min, clamp, pow, exp, abs, sin, cos, atan, length, dot, fract, step, select, smoothstep, rtt, renderOutput,
  texture, interleavedGradientNoise, getViewPosition, normalize,
} from 'three/tsl';
import { ATMO } from '../atmosphere.js';
import { hfStaticShadow } from './atmosphere.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { ao as gtao } from 'three/addons/tsl/display/GTAONode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { dof as dofNode } from 'three/addons/tsl/display/DepthOfFieldNode.js';
import { denoise } from 'three/addons/tsl/display/DenoiseNode.js';
import { ss, hash12, oneMinus } from './common.js';

// ============================================================
//  Post-processing on WebGPURenderer (TSL nodes), the same look as gfx/post.js:
//   scene (+ velocity) -> AO (GTAO) -> TRAA -> [heat shimmer, exhaust distortion, speed blur,
//   chromatic aberration] -> [depth of field] -> [god rays, bloom, lens flare] -> AgX -> grade,
//   vignette, grain -> sRGB
//  TRAA (temporal reprojection AA) replaces MSAA and SMAA: the scene is drawn jittered and
//  without multisampling, every pixel accumulates over frames along its velocity.
// ============================================================

export function createNodePost(renderer, scene, camera, Q, sunDir, heat = null) {
  const taa = Q.taa !== false;
  const scenePass = pass(scene, camera, { samples: taa ? 0 : Math.min(Q.msaa || 0, 4) });
  // Velocity for TRAA from opaque surfaces only: see-through ones (plume boxes, glows, smoke) write it
  // with alpha 0 into a blended attachment, so the ground behind a plume's box keeps its own motion
  // instead of taking the pod's (which outlines the box as it smears)
  const vel = Fn((builder) => (builder.material?.transparent ? vec4(0) : vec4(velocity, 0, 1)))();
  const sceneMRT = mrt({ output, velocity: vel });
  sceneMRT.setBlendMode('velocity', new THREE.BlendMode(THREE.NormalBlending));
  scenePass.setMRT(sceneMRT);
  const color = scenePass.getTextureNode('output');
  const depth = scenePass.getTextureNode('depth');
  const viewZ = scenePass.getViewZNode();

  // --- ambient occlusion: GTAO at half resolution, tinted like N8AO and faded out with distance ---
  let aoPass = null;
  const aoOn = uniform(1), aoOnly = uniform(0);
  let lit = color;
  if (Q.ao) {
    aoPass = gtao(depth, null, camera);
    // ?gfx=aoq:1 (docs/visual-next-steps.md C6): more samples and a wider radius, so the big shapes (stands,
    // canyon foot, mesas) get their contact darkening too; aoq:2 also at full resolution
    const aoq = Q.aoq || 0;
    aoPass.resolutionScale = aoq >= 2 ? 1 : 0.5;
    aoPass.radius.value = aoq ? 6 : 4;
    aoPass.distanceExponent.value = 1.2;
    aoPass.thickness.value = aoq ? 3 : 2;
    aoPass.samples.value = (Q.name === 'ultra' ? 16 : 12) + (aoq ? 8 : 0);
    aoPass.useTemporalFiltering = taa;
    // GTAO is noisy by design; TRAA alone leaves grain under the pods (and on the glows drawn over
    // them), so a depth-aware spatial denoise first, as N8AO does (normals rebuilt from depth)
    const aoTex = denoise(aoPass.getTextureNode(), depth, null, camera);
    lit = Fn(() => {
      const fogF = smoothstep(200, 2500, viewZ.negate());
      const a = mix(pow(aoTex.r, 2.2), 1, fogF);         // (denoise() works in place, at this pixel)
      const k = mix(vec3(1), mix(vec3(0.0232, 0.0103, 0.0052), vec3(1), a), aoOn);    // #2a1a10 in linear
      return vec4(select(aoOnly.greaterThan(0.5), k, color.rgb.mul(k)), 1);
    })();
  }
  // --- volumetric light (?gfx=vol:1, docs/visual-next-steps.md C5) ---------------------------------------
  // Shafts of sun through dust in the canyon and under the arch: at half resolution, the view ray (to the
  // depth buffer, at most 220 m) is marched through extra dust that hangs in these places (denser low down,
  // broken up by drifting noise), each step lit by the sun as far as the baked world shadow (and the cached
  // mid shadow, if on) lets it through. Jittered per pixel and per frame, and laid over the scene before
  // TRAA, which averages the jitter away. VOL.k: how much the camera is in such a place (main.js); 0 skips it.
  const VOL = {
    k: uniform(0), y: uniform(0), density: uniform(0.022), frame: uniform(0), center: uniform(new THREE.Vector3()), radius: uniform(200),
    projInv: uniform(new THREE.Matrix4()), camWorld: uniform(new THREE.Matrix4()), camPos: uniform(new THREE.Vector3()),
  };
  if (Q.vol) {
    const STEPS = 16;          // (TRAA averages the jitter; the WebGL chain takes 24 on Ultra)
    const volFn = Fn(() => {
      const p = uv();
      const out = vec4(0, 0, 0, 1).toVar();
      If(VOL.k.greaterThan(0.01), () => {
        const vp = getViewPosition(p, depth.sample(p).r, VOL.projInv);
        const dv = VOL.camWorld.mul(vec4(vp, 1)).xyz.sub(VOL.camPos).toVar();
        const dist = min(length(dv), 220).toVar();
        const rd = normalize(dv).toVar();
        const ds = dist.div(STEPS).toVar();
        const t = ds.mul(interleavedGradientNoise(screenCoordinate.add(vec2(VOL.frame.mul(5.588), VOL.frame.mul(2.317))))).toVar();
        // phase: forward glow towards the sun on an even floor
        const c = dot(rd, ATMO.hfSunDir), g = 0.55;
        const phase = float((1 - g * g) / (4 * Math.PI)).div(pow(c.mul(-2 * g).add(1 + g * g), 1.5)).mul(0.75).add(0.25 / (4 * Math.PI));
        const sunL = ATMO.hfSunCol.mul(phase.mul(3.1));
        // dust in shadow still glows with the sky and the sunlit rock round it: about the shaded walls' level
        const amb = ATMO.hfFogCol.mul(0.32);
        const T = float(1).toVar(), acc = vec3(0).toVar();
        Loop(STEPS, () => {
          const q = VOL.camPos.add(rd.mul(t)).toVar();
          const drift = ATMO.hfTime.mul(vec2(0.011, 0.004));
          const n = ATMO.hfCloudTex.sample(q.xz.div(37).add(drift)).r.mul(ATMO.hfCloudTex.sample(q.xz.add(vec2(q.y.mul(0.8))).div(11).sub(drift.mul(2))).r).mul(2.6);
          // the dust lies low in the slot or round the arch (centre, radius), in drifting wisps
          const zone = oneMinus(smoothstep(VOL.radius.mul(0.6), VOL.radius, length(q.xz.sub(VOL.center.xz))));
          const sig = VOL.density.mul(VOL.k).mul(zone).mul(exp(max(q.y.sub(VOL.y), 0).div(-16))).mul(smoothstep(0.15, 0.75, n)).toVar();
          const vis = hfStaticShadow(q, vec3(0));
          acc.addAssign(sunL.mul(vis).add(amb).mul(sig).mul(T).mul(ds));
          T.mulAssign(exp(sig.mul(ds).negate()));
          t.addAssign(ds);
        });
        out.assign(vec4(acc, T));
      });
      return out;
    });
    const volTex = rtt(volFn(), null, null, { resolutionScale: 0.5 });
    const base = lit;
    lit = Fn(() => { const v = volTex.sample(uv()); return vec4(base.rgb.mul(v.a).add(v.rgb), 1); })();
  }
  const resolved = taa ? traa(lit, depth, scenePass.getTextureNode('velocity'), camera) : lit;
  const src = taa ? resolved.getTextureNode() : rtt(lit);

  // --- heat haze + speed blur + chromatic aberration (samples the frame at other uvs) ---
  const S = {
    uBlur: uniform(0), uAberr: uniform(0), uHeat: uniform(Q.heat ? 1 : 0), uCenter: uniform(new THREE.Vector2(0.5, 0.5)),
    uDistortOn: uniform(heat ? 1 : 0),
  };
  const distortTex = texture(heat ? heat.rt.texture : new THREE.Texture());
  const aspect = screenSize.x.div(screenSize.y);
  const speed = Fn(() => {
    const p0 = uv().toVar();
    const vz = viewZ.negate();
    const sky = step(0.99999, depth.sample(p0).r);
    // heat shimmer over distant ground
    const far = smoothstep(120, 700, vz).mul(oneMinus(sky));
    const off = vec2(sin(p0.y.mul(260).add(time.mul(7)).add(sin(p0.x.mul(35).add(time)).mul(2))),
      cos(p0.y.mul(210).sub(time.mul(5.5)).add(p0.x.mul(20)))).mul(0.0011).mul(far).mul(S.uHeat).toVar();
    // exhaust heat behind the engines
    if (heat) {
      const dist = distortTex.sample(p0);
      off.addAssign(dist.rg.mul(2).sub(1).mul(dist.a).mul(0.018).mul(S.uDistortOn));
    }
    const suv = p0.add(off).toVar();
    const col = vec3(0).toVar();
    If(S.uBlur.add(S.uAberr).lessThan(1e-4), () => {
      col.assign(src.sample(suv).rgb);
    }).Else(() => {
      const dir = suv.sub(S.uCenter).toVar();
      const r = length(dir.mul(vec2(aspect, 1))).toVar();
      // radial (zoom) blur from the look point, stronger towards the edges
      const k = S.uBlur.mul(smoothstep(0.12, 0.9, r)).mul(0.06).toVar();
      // chromatic aberration grows with the distance from the centre
      const ca = dir.mul(S.uAberr).mul(r).mul(0.012).toVar();
      Loop(8, ({ i }) => {
        const p = suv.sub(dir.mul(k).mul(float(i).div(7))).toVar();
        col.addAssign(vec3(src.sample(p.add(ca)).level(0).r, src.sample(p).level(0).g, src.sample(p.sub(ca)).level(0).b));
      });
      col.divAssign(8);
    });
    // scrub NaN/Inf so one bad pixel cannot spread through the bloom chain (GPU max() drops a NaN)
    return vec4(min(max(col, vec3(0)), vec3(6e4)), 1);
  })();
  const speedTex = rtt(speed);

  // --- depth of field (menus, photo mode): a second output graph, swapped in when it is on ---
  const D = { focus: uniform(20), range: uniform(14) };
  const dofd = dofNode(speedTex, viewZ, D.focus, D.range, 3);

  // --- sun on screen, shared by the god rays and the lens flare ---
  const F = { uSun: uniform(new THREE.Vector2()), uOn: uniform(0), uIntensity: uniform(Q.flare ? 1 : 0), uTint: uniform(new THREE.Color('#ffd9a8')), uRays: uniform(Q.godrays ? 1 : 0) };
  // (no explicit LOD on the depth texture: on the WebGL2 backend that path returns a vec4 where TSL expects a float)
  const isSky = (p) => step(0.99999, depth.sample(clamp(p, 0.001, 0.999)).r);

  // god rays: the visible sun disc smeared towards the screen position of the sun (as pmndrs'
  // GodRaysEffect: 48 samples, density 0.94, decay 0.93, weight 0.32, exposure 0.42), half resolution
  let rays = null;
  if (Q.godrays) {
    const sunCol = vec3(1, 0.69, 0.35);
    const discR = Math.atan(150 / 6000);              // the angular radius of the old sun sphere
    const rayFn = Fn(() => {
      const p = uv().toVar();
      const delta = p.sub(F.uSun).mul(0.94 / 48).toVar();
      const acc = float(0).toVar(), decay = float(1).toVar();
      p.subAssign(delta.mul(interleavedGradientNoise(screenCoordinate)));      // breaks up the banding
      // the disc in uv: radius in screen heights
      const rUv = float(discR).div(F.uFovT);
      Loop(48, () => {
        p.subAssign(delta);
        const d = length(p.sub(F.uSun).mul(vec2(aspect, 1)));
        acc.addAssign(isSky(p).mul(oneMinus(smoothstep(rUv.mul(0.6), rUv, d))).mul(decay));
        decay.mulAssign(0.93);
      });
      return vec4(sunCol.mul(min(acc.mul(0.32 * 0.42), 1)).mul(F.uOn.mul(0.6).add(0.4)), 1);
    });
    F.uFovT = uniform(1);
    rays = rtt(rayFn(), null, null, { resolutionScale: 0.5 });
  }

  // lens flare: ghosts, halo, starburst and an anamorphic streak, occluded by the depth at the sun
  const flare = Fn(([p]) => {
    const px = vec2(0.012, aspect.mul(0.012));
    const v = isSky(F.uSun).add(isSky(F.uSun.add(vec2(px.x, 0)))).add(isSky(F.uSun.sub(vec2(px.x, 0))))
      .add(isSky(F.uSun.add(vec2(0, px.y)))).add(isSky(F.uSun.sub(vec2(0, px.y)))).mul(0.2);
    const sx = F.uSun.x, sy = F.uSun.y;
    const onScreen = smoothstep(-0.15, 0.1, sx).mul(ss(1.15, 0.9, sx)).mul(smoothstep(-0.15, 0.1, sy)).mul(ss(1.15, 0.9, sy));
    const I = v.mul(F.uOn).mul(F.uIntensity).mul(onScreen).toVar();
    const c = vec3(0).toVar();
    If(I.greaterThan(0.001), () => {
      const asp = vec2(aspect, 1);
      const d = p.sub(F.uSun).mul(asp).toVar();
      const r = length(d).toVar();
      // glow + starburst around the sun
      const ang = atan(d.y, d.x);
      const star = pow(abs(sin(ang.mul(6).add(0.3))), 40).add(pow(abs(sin(ang.mul(4).add(1.1))), 60).mul(0.6));
      c.addAssign(F.uTint.mul(exp(r.mul(-9)).mul(0.35).add(star.mul(exp(r.mul(-6))).mul(0.25))));
      // anamorphic streak
      c.addAssign(vec3(1, 0.75, 0.5).mul(exp(abs(d.y).mul(-140))).mul(exp(abs(d.x).mul(-2.6))).mul(0.25));
      // ghosts along the line through the screen centre
      const axis = vec2(0.5).sub(F.uSun);
      for (let i = 0; i < 5; i++) {
        const pos = 0.45 + i * 0.38 + i * i * 0.03, size = 0.02 + ((i * 0.37) % 0.05) + i * 0.006;
        const g = p.sub(F.uSun.add(axis.mul(pos * 2))).mul(asp);
        const gl = ss(size, size * 0.6, length(g));
        const t = (i * 0.43) % 1;
        const tint = [1 + (0.35 - 1) * t, 0.55 + (0.65 - 0.55) * t, 0.25 + (1 - 0.25) * t];
        c.addAssign(vec3(...tint).mul(gl).mul(0.05 + 0.03 * i));
      }
    });
    return c.mul(I);
  });

  // --- grade after tone mapping: split toning, contrast, saturation, vignette, grain, flash, fade ---
  const G = {
    uSat: uniform(1.3), uContrast: uniform(1.15), uVignette: uniform(0.38), uGrain: uniform(0.022), uFade: uniform(0), uFlash: uniform(0),
    uShadow: uniform(new THREE.Vector3(0.94, 0.98, 1.06)), uHigh: uniform(new THREE.Vector3(1.04, 1.0, 0.94)), uFlashCol: uniform(new THREE.Color('#fff3e0')),
  };
  const grade = Fn(([c0]) => {
    const p = uv();
    const c = c0.toVar();
    const lw = vec3(0.2126, 0.7152, 0.0722);
    c.mulAssign(mix(G.uShadow, G.uHigh, smoothstep(0, 0.6, dot(c, lw))));
    c.assign(max(vec3(0), c.sub(0.18).mul(G.uContrast).add(0.18)));
    const l = dot(c, lw).toVar();
    c.assign(mix(vec3(l), c, G.uSat));
    const q = p.sub(0.5).mul(vec2(aspect, 1));
    c.mulAssign(oneMinus(G.uVignette.mul(smoothstep(0.35, 1.05, length(q)))));
    // film grain, a little stronger in the darks
    c.addAssign(hash12(p.mul(screenSize).add(fract(time.mul(13.7)).mul(211))).sub(0.5).mul(G.uGrain).mul(float(1.2).sub(l)));
    c.assign(mix(c, G.uFlashCol, G.uFlash));
    c.mulAssign(oneMinus(G.uFade));
    return c;
  });

  const exposure = renderer.toneMappingExposure || 1.1;
  const bloomStrength = Q.bloom ? 0.85 : 0;
  const finish = (base) => {
    let hdr = base.rgb;
    if (rays) hdr = hdr.add(rays.rgb.mul(F.uRays));
    const bl = bloom(base, bloomStrength, 0.72, 0.92);
    bl.smoothWidth.value = 0.25;
    hdr = hdr.add(bl.rgb).add(flare(uv()));
    // AgX: highlights roll off to white instead of skewing yellow; the grade puts back saturation and contrast
    const mapped = vec4(hdr, 1).toneMapping(THREE.AgXToneMapping, exposure);
    return renderOutput(vec4(grade(mapped.rgb), 1), THREE.NoToneMapping, renderer.outputColorSpace);
  };
  const outPlain = finish(speedTex), outDof = finish(dofd);

  // one pipeline per output graph: swapping a pipeline's outputNode rebuilds its passes' materials, and
  // their pipelines (a stall at every menu <-> race switch)
  const makePipeline = (node) => {
    const p = new THREE.RenderPipeline(renderer);
    p.outputColorTransform = false;
    p.outputNode = node;
    return p;
  };
  const pipeline = makePipeline(outPlain), pipelineDof = Q.dof ? makePipeline(outDof) : pipeline;
  let dofOn = false;

  const _v = new THREE.Vector3(), _f = new THREE.Vector3();
  const api = {
    pipeline, scenePass, aoPass, taa, vol: VOL,
    // the same handles the tests use on the WebGL chain (gfx/post.js)
    grade: { uniforms: new Map(Object.entries(G)) },
    speed: { uniforms: new Map(Object.entries(S)) },
    flare: { uniforms: new Map(Object.entries(F)) },
    ao: aoPass && { setAoOnly(on) { aoOnly.value = on ? 1 : 0; }, setOn(on) { aoOn.value = on ? 1 : 0; } },
    setSize() { /* the passes follow the renderer's size */ },
    update(dt, v) {
      if (Q.vol) {
        VOL.k.value = v.vol?.k ?? 0;
        VOL.y.value = v.vol?.y ?? 0;
        if (v.vol?.center) VOL.center.value.copy(v.vol.center);
        VOL.radius.value = v.vol?.radius ?? 200;
        VOL.density.value = v.vol?.density ?? 0.01;
        VOL.frame.value = (VOL.frame.value + 1) % 64;
        VOL.projInv.value.copy(camera.projectionMatrixInverse);
        VOL.camWorld.value.copy(camera.matrixWorld);
        VOL.camPos.value.setFromMatrixPosition(camera.matrixWorld);
      }
      S.uBlur.value = v.blur || 0;
      S.uAberr.value = v.aberr || 0;
      if (v.center) S.uCenter.value.copy(v.center);
      _v.copy(camera.position).addScaledVector(sunDir, 6000).project(camera);
      camera.getWorldDirection(_f);
      F.uSun.value.set(_v.x * 0.5 + 0.5, 0.5 - _v.y * 0.5);          // texture v runs down on this renderer
      F.uOn.value = THREE.MathUtils.smoothstep(_f.dot(sunDir), 0.35, 0.75);
      if (F.uFovT) F.uFovT.value = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
      G.uFlash.value = v.flash || 0;
      G.uFade.value = v.fade || 0;
      const wantDof = !!(Q.dof && v.dof && v.dof.on);
      if (wantDof) {
        D.focus.value = Math.max(0.5, _v.copy(v.dof.focus).sub(camera.position).dot(_f));
        D.range.value = v.dof.range ?? 14;
      }
      dofOn = wantDof;
    },
    render() { (dofOn ? pipelineDof : pipeline).render(); },
  };
  return api;
}
