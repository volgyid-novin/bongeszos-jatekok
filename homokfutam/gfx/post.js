import * as THREE from 'three';
import {
  EffectComposer, RenderPass, EffectPass, Effect, EffectAttribute, BlendFunction, BloomEffect, SMAAEffect,
  ToneMappingEffect, ToneMappingMode, GodRaysEffect, DepthOfFieldEffect, KernelSize, Pass,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import { ATMO, ATMO_FUNCS } from './atmosphere.js';

// ============================================================
//  Post-processing chain (pmndrs/postprocessing + N8AO):
//   scene -> AO -> [heat shimmer, exhaust distortion, speed blur, chromatic aberration]
//         -> [depth of field] -> [god rays, bloom, lens flare, tone mapping, grade, vignette, grain]
//         -> SMAA (when the preset has no MSAA)
// ============================================================

// --- heat haze + speed blur + chromatic aberration (samples the frame at other uvs) ---
const SPEED_FRAG = /* glsl */`
uniform float uBlur, uAberr, uHeat, uDistortOn;
uniform vec2 uCenter;
uniform sampler2D uDistort;
void mainImage( const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor ) {
  float vz = - getViewZ( depth );
  float sky = step( 0.99999, depth );
  // heat shimmer over distant ground
  float far = smoothstep( 120.0, 700.0, vz ) * ( 1.0 - sky );
  vec2 off = vec2( sin( uv.y * 260.0 + time * 7.0 + sin( uv.x * 35.0 + time ) * 2.0 ),
                   cos( uv.y * 210.0 - time * 5.5 + uv.x * 20.0 ) ) * 0.0011 * far * uHeat;
  // exhaust heat behind the engines
  vec4 dist = texture2D( uDistort, uv );
  off += ( dist.rg * 2.0 - 1.0 ) * dist.a * 0.018 * uDistortOn;
  vec2 suv = uv + off;
  vec2 dir = suv - uCenter;
  float r = length( dir * vec2( aspect, 1.0 ) );
  vec3 col = vec3( 0.0 );
  // radial (zoom) blur from the look point, stronger towards the edges
  float k = uBlur * smoothstep( 0.12, 0.9, r ) * 0.06;
  for ( int i = 0; i < 8; i ++ ) {
    float t = float( i ) / 7.0;
    vec2 p = suv - dir * k * t;
    // chromatic aberration grows with the distance from the centre
    vec2 ca = dir * uAberr * r * 0.012;
    col += vec3( texture2D( inputBuffer, p + ca ).r, texture2D( inputBuffer, p ).g, texture2D( inputBuffer, p - ca ).b );
  }
  col /= 8.0;
  // scrub NaN/Inf so one bad pixel cannot spread through the bloom chain
  if ( any( isnan( col ) ) || any( isinf( col ) ) ) col = vec3( 0.0 );
  outputColor = vec4( min( col, vec3( 6e4 ) ), inputColor.a );
}`;
class SpeedEffect extends Effect {
  constructor() {
    super('SpeedEffect', SPEED_FRAG, {
      attributes: EffectAttribute.CONVOLUTION | EffectAttribute.DEPTH,
      uniforms: new Map([
        ['uBlur', new THREE.Uniform(0)], ['uAberr', new THREE.Uniform(0)], ['uHeat', new THREE.Uniform(1)],
        ['uCenter', new THREE.Uniform(new THREE.Vector2(0.5, 0.5))],
        ['uDistort', new THREE.Uniform(null)], ['uDistortOn', new THREE.Uniform(0)],
      ]),
    });
  }
}

// --- lens flare: ghosts, halo, starburst and an anamorphic streak, occluded by the depth at the sun ---
const FLARE_FRAG = /* glsl */`
uniform vec2 uSun;
uniform float uOn, uIntensity;
uniform vec3 uTint;
float vis( vec2 p ) { return step( 0.99999, readDepth( clamp( p, 0.001, 0.999 ) ) ); }
void mainImage( const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor ) {
  float v = 0.0;
  vec2 px = vec2( 0.012, 0.012 * aspect );
  v += vis( uSun ) * 0.2 + vis( uSun + vec2( px.x, 0.0 ) ) * 0.2 + vis( uSun - vec2( px.x, 0.0 ) ) * 0.2
     + vis( uSun + vec2( 0.0, px.y ) ) * 0.2 + vis( uSun - vec2( 0.0, px.y ) ) * 0.2;
  float onScreen = smoothstep( -0.15, 0.1, uSun.x ) * smoothstep( 1.15, 0.9, uSun.x ) * smoothstep( -0.15, 0.1, uSun.y ) * smoothstep( 1.15, 0.9, uSun.y );
  float I = v * uOn * uIntensity * onScreen;
  if ( I < 0.001 ) { outputColor = inputColor; return; }
  vec2 asp = vec2( aspect, 1.0 );
  vec2 d = ( uv - uSun ) * asp;
  float r = length( d );
  vec3 c = vec3( 0.0 );
  // glow + starburst around the sun
  float ang = atan( d.y, d.x );
  float star = pow( abs( sin( ang * 6.0 + 0.3 ) ), 40.0 ) + pow( abs( sin( ang * 4.0 + 1.1 ) ), 60.0 ) * 0.6;
  c += uTint * ( exp( - r * 9.0 ) * 0.35 + star * exp( - r * 6.0 ) * 0.25 );
  // anamorphic streak
  c += vec3( 1.0, 0.75, 0.5 ) * exp( - abs( d.y ) * 140.0 ) * exp( - abs( d.x ) * 2.6 ) * 0.25;
  // ghosts along the line through the screen centre
  vec2 axis = vec2( 0.5 ) - uSun;
  for ( int i = 0; i < 5; i ++ ) {
    float t = float( i );
    float pos = 0.45 + t * 0.38 + t * t * 0.03;
    float size = 0.02 + mod( t * 0.37, 0.05 ) + t * 0.006;
    vec2 g = ( uv - ( uSun + axis * pos * 2.0 ) ) * asp;
    float gl = smoothstep( size, size * 0.6, length( g ) );
    vec3 tint = mix( vec3( 1.0, 0.55, 0.25 ), vec3( 0.35, 0.65, 1.0 ), fract( t * 0.43 ) );
    c += tint * gl * ( 0.05 + 0.03 * t );
  }
  outputColor = vec4( inputColor.rgb + c * I, inputColor.a );
}`;
class FlareEffect extends Effect {
  constructor() {
    super('FlareEffect', FLARE_FRAG, {
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map([
        ['uSun', new THREE.Uniform(new THREE.Vector2())], ['uOn', new THREE.Uniform(0)], ['uIntensity', new THREE.Uniform(1)],
        ['uTint', new THREE.Uniform(new THREE.Color('#ffd9a8'))],
      ]),
    });
  }
}

// --- grade after tone mapping: warm highlights / cool shadows, contrast, saturation, vignette, grain ---
const GRADE_FRAG = /* glsl */`
uniform float uSat, uContrast, uVignette, uGrain, uFade, uFlash;
uniform vec3 uShadow, uHigh, uFlashCol;
float hash12( vec2 p ) { vec3 p3 = fract( vec3( p.xyx ) * 0.1031 ); p3 += dot( p3, p3.yzx + 33.33 ); return fract( ( p3.x + p3.y ) * p3.z ); }
void mainImage( const in vec4 inputColor, const in vec2 uv, out vec4 outputColor ) {
  vec3 c = inputColor.rgb;
  float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
  // split toning
  c *= mix( uShadow, uHigh, smoothstep( 0.0, 0.6, l ) );
  // contrast around mid grey (linear)
  c = max( vec3( 0.0 ), ( c - 0.18 ) * uContrast + 0.18 );
  l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
  c = mix( vec3( l ), c, uSat );
  // vignette
  vec2 q = ( uv - 0.5 ) * vec2( aspect, 1.0 );
  c *= 1.0 - uVignette * smoothstep( 0.35, 1.05, length( q ) );
  // film grain, a little stronger in the darks
  c += ( hash12( uv * resolution + fract( time * 13.7 ) * 211.0 ) - 0.5 ) * uGrain * ( 1.2 - l );
  c = mix( c, uFlashCol, uFlash );
  if ( any( isnan( c ) ) || any( isinf( c ) ) ) c = vec3( 0.0 );
  c *= 1.0 - uFade;
  outputColor = vec4( c, inputColor.a );
}`;
class GradeEffect extends Effect {
  constructor() {
    super('GradeEffect', GRADE_FRAG, {
      uniforms: new Map([
        ['uSat', new THREE.Uniform(1.3)], ['uContrast', new THREE.Uniform(1.15)], ['uVignette', new THREE.Uniform(0.38)],
        ['uGrain', new THREE.Uniform(0.022)], ['uFade', new THREE.Uniform(0)], ['uFlash', new THREE.Uniform(0)],
        ['uShadow', new THREE.Uniform(new THREE.Vector3(0.94, 0.98, 1.06))], ['uHigh', new THREE.Uniform(new THREE.Vector3(1.04, 1.0, 0.94))],
        ['uFlashCol', new THREE.Uniform(new THREE.Color('#fff3e0'))],
      ]),
    });
  }
}

// --- volumetric light (?gfx=vol:1; notes: gfx/tsl/post.js) ---------------------------------------------
// Half-resolution march through the dust of the canyon / arch, lit by the baked world shadow (and the
// cached mid shadow): rgb = light scattered in, a = transmittance. Without TRAA here the jitter is a fixed
// per-pixel pattern (no shimmer), softened by the bilinear upsampling in VolEffect.
const VOL_F = /* glsl */`
  ${ATMO_FUNCS}
  uniform sampler2D depthBuffer;
  uniform mat4 uProjInv, uCamWorld;
  uniform vec3 uCamPos, uCenter;
  uniform float uK, uY, uDensity, uRadius;
  varying vec2 vUv;
  float ign( vec2 p ) { return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) ); }
  void main() {
    if ( uK < 0.01 ) { gl_FragColor = vec4( 0.0, 0.0, 0.0, 1.0 ); return; }
    float z = texture2D( depthBuffer, vUv ).r;
    vec4 v = uProjInv * vec4( vUv * 2.0 - 1.0, z * 2.0 - 1.0, 1.0 );
    vec3 dv = ( uCamWorld * vec4( v.xyz / v.w, 1.0 ) ).xyz - uCamPos;
    float dist = min( length( dv ), 220.0 );
    vec3 rd = normalize( dv );
    float ds = dist / float( STEPS ), t = ds * ign( gl_FragCoord.xy );
    float c = dot( rd, hfSunDir ), g = 0.55;
    float phase = ( 1.0 - g * g ) / ( 12.5663706 * pow( 1.0 + g * g - 2.0 * g * c, 1.5 ) ) * 0.75 + 0.25 / 12.5663706;
    vec3 sunL = hfSunCol * phase * 3.1, amb = hfFogCol * 0.32;
    vec2 drift = hfTime * vec2( 0.011, 0.004 );
    float T = 1.0;
    vec3 acc = vec3( 0.0 );
    for ( int k = 0; k < STEPS; k ++ ) {
      vec3 q = uCamPos + rd * t;
      float n = texture2D( hfCloudTex, q.xz / 37.0 + drift ).r * texture2D( hfCloudTex, ( q.xz + q.y * 0.8 ) / 11.0 - drift * 2.0 ).r * 2.6;
      float zone = 1.0 - smoothstep( uRadius * 0.6, uRadius, length( q.xz - uCenter.xz ) );
      float sig = uDensity * uK * zone * exp( - max( q.y - uY, 0.0 ) / 16.0 ) * smoothstep( 0.15, 0.75, n );
      acc += ( sunL * hfStaticShadow( q, vec3( 0.0 ) ) + amb ) * sig * T * ds;
      T *= exp( - sig * ds );
      t += ds;
    }
    gl_FragColor = vec4( acc, T );
  }`;
class VolPass extends Pass {
  constructor(camera, steps) {
    super('VolPass');
    this.needsSwap = false;
    this.needsDepthTexture = true;
    this.sceneCamera = camera;
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.target.texture.generateMipmaps = false;
    this.fullscreenMaterial = new THREE.ShaderMaterial({
      defines: { STEPS: steps },
      uniforms: Object.assign({}, ATMO, {
        depthBuffer: { value: null }, uProjInv: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() },
        uCamPos: { value: new THREE.Vector3() }, uCenter: { value: new THREE.Vector3() },
        uK: { value: 0 }, uY: { value: 0 }, uDensity: { value: 0.01 }, uRadius: { value: 200 },
      }),
      vertexShader: 'varying vec2 vUv; varying vec3 vHfWorld; void main() { vUv = position.xy * 0.5 + 0.5; vHfWorld = vec3( 0.0 ); gl_Position = vec4( position.xy, 1.0, 1.0 ); }',
      fragmentShader: VOL_F, depthWrite: false, depthTest: false,
    });
  }
  setDepthTexture(depthTexture) { this.fullscreenMaterial.uniforms.depthBuffer.value = depthTexture; }
  setSize(w, h) { this.target.setSize(Math.max(1, Math.round(w / 2)), Math.max(1, Math.round(h / 2))); }
  render(renderer) {
    const u = this.fullscreenMaterial.uniforms, cam = this.sceneCamera;
    u.uProjInv.value.copy(cam.projectionMatrixInverse);
    u.uCamWorld.value.copy(cam.matrixWorld);
    u.uCamPos.value.setFromMatrixPosition(cam.matrixWorld);
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.camera);
  }
}
class VolEffect extends Effect {
  constructor(tex) {
    super('VolEffect', /* glsl */`
      uniform sampler2D uVol;
      void mainImage( const in vec4 inputColor, const in vec2 uv, out vec4 outputColor ) {
        vec4 v = texture2D( uVol, uv );
        outputColor = vec4( inputColor.rgb * v.a + v.rgb, inputColor.a );
      }`, { uniforms: new Map([['uVol', new THREE.Uniform(tex)]]) });
  }
}

export function createPost(renderer, scene, camera, Q, sunDir) {
  // on high-density screens the pixels are small enough that 2x MSAA looks like 4x for half the cost
  const msaa = Q.msaa && renderer.getPixelRatio() >= 1.4 ? Math.min(Q.msaa, 2) : Q.msaa;
  const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, multisampling: msaa });
  composer.addPass(new RenderPass(scene, camera));
  const w = window.innerWidth, h = window.innerHeight;

  let ao = null;
  if (Q.ao) {
    ao = new N8AOPostPass(scene, camera, w, h);
    // transparencyAware off: N8AO turns it on by itself when the scene has any transparent material
    // (particles, plumes), and then re-renders every transparent object twice and walks the whole
    // scene several times per frame. It also cut the AO out in a box around every volumetric plume
    // (the plume shader writes alpha 1 over its whole box).
    // The AO fades out with distance by scene.fog's near/far (main.js).
    ao.autoDetectTransparency = false;
    // ?gfx=aoq:1 (docs/visual-next-steps.md C6): one quality mode up and a wider radius, so the big shapes
    // (stands, canyon foot, mesas) get their contact darkening too; aoq:2 also at full resolution
    const aoq = Q.aoq || 0;
    Object.assign(ao.configuration, { aoRadius: aoq ? 7 : 5, distanceFalloff: 1.2, intensity: 2.2, color: new THREE.Color('#2a1a10'), halfRes: aoq < 2, depthAwareUpsampling: true, transparencyAware: false });
    ao.setQualityMode(['Medium', 'High', 'Ultra'][Math.min(2, (Q.name === 'ultra' ? 1 : 0) + (aoq ? 1 : 0))]);
    composer.addPass(ao);
  }

  let vol = null, volMix = null;
  if (Q.vol) {
    vol = new VolPass(camera, Q.name === 'ultra' ? 24 : 16);
    volMix = new EffectPass(camera, new VolEffect(vol.target.texture));
    composer.addPass(vol);
    composer.addPass(volMix);
  }

  const speed = new SpeedEffect();
  speed.uniforms.get('uHeat').value = Q.heat ? 1 : 0;
  const speedPass = new EffectPass(camera, speed);
  composer.addPass(speedPass);

  const dof = new DepthOfFieldEffect(camera, { focusDistance: 20, focusRange: 14, bokehScale: 3, resolutionScale: 0.5 });
  dof.target = new THREE.Vector3();
  const dofPass = new EffectPass(camera, dof);
  dofPass.enabled = false;
  composer.addPass(dofPass);

  // god rays need a light source mesh: a small sun sphere, kept out of the scene
  const sunMesh = new THREE.Mesh(new THREE.SphereGeometry(150, 16, 8), new THREE.MeshBasicMaterial({ color: '#ffd9a0', transparent: true, depthWrite: false, fog: false }));
  sunMesh.frustumCulled = false;
  const effects = [];
  let rays = null;
  if (Q.godrays) {
    rays = new GodRaysEffect(camera, sunMesh, { samples: 48, density: 0.94, decay: 0.93, weight: 0.32, exposure: 0.42, clampMax: 1, resolutionScale: 0.5, kernelSize: KernelSize.SMALL, blur: true });
    effects.push(rays);
  }
  const bloom = new BloomEffect({ mipmapBlur: true, luminanceThreshold: 0.92, luminanceSmoothing: 0.25, intensity: Q.bloom ? 0.85 : 0, radius: 0.72 });
  effects.push(bloom);
  const flare = new FlareEffect();
  flare.uniforms.get('uIntensity').value = Q.flare ? 1 : 0;
  effects.push(flare);
  // AgX: highlights (sun, flames, the beam) roll off to white instead of skewing yellow, and the sand and
  // rock keep their hue; the grade puts back the saturation and contrast it takes out
  const tone = new ToneMappingEffect({ mode: ToneMappingMode.AGX });
  effects.push(tone);
  const grade = new GradeEffect();
  effects.push(grade);
  composer.addPass(new EffectPass(camera, ...effects));
  if (Q.smaa) composer.addPass(new EffectPass(camera, new SMAAEffect()));

  const _v = new THREE.Vector3(), _f = new THREE.Vector3();
  const api = {
    composer, speed, dof, dofPass, bloom, flare, grade, rays, ao, sunMesh, vol,
    exposure: 1,
    setSize(width, height) { composer.setSize(width, height); },
    // per frame: v = { blur, aberr, center: Vector2, flash, fade, dof: {on, focus, range} }
    update(dt, v) {
      if (vol) {
        const u = vol.fullscreenMaterial.uniforms;
        u.uK.value = v.vol?.k ?? 0; u.uY.value = v.vol?.y ?? 0; u.uDensity.value = v.vol?.density ?? 0.01; u.uRadius.value = v.vol?.radius ?? 200;
        if (v.vol?.center) u.uCenter.value.copy(v.vol.center);
        vol.enabled = volMix.enabled = u.uK.value > 0.01;           // outside the canyon and the arch: no passes at all
      }
      const su = speed.uniforms;
      su.get('uBlur').value = v.blur || 0;
      su.get('uAberr').value = v.aberr || 0;
      if (v.center) su.get('uCenter').value.copy(v.center);
      sunMesh.position.copy(camera.position).addScaledVector(sunDir, 6000);
      sunMesh.updateMatrixWorld();
      _v.copy(sunMesh.position).project(camera);
      camera.getWorldDirection(_f);
      const facing = _f.dot(sunDir);
      flare.uniforms.get('uSun').value.set(_v.x * 0.5 + 0.5, _v.y * 0.5 + 0.5);
      flare.uniforms.get('uOn').value = THREE.MathUtils.smoothstep(facing, 0.35, 0.75);
      const g = grade.uniforms;
      g.get('uFlash').value = v.flash || 0;
      g.get('uFade').value = v.fade || 0;
      dofPass.enabled = !!(Q.dof && v.dof && v.dof.on);
      if (dofPass.enabled) {
        dof.target.copy(v.dof.focus);
        dof.cocMaterial.focusRange = v.dof.range ?? 14;
      }
    },
    render(dt) { composer.render(dt); },
  };
  return api;
}
