import * as THREE from 'three';
import {
  EffectComposer, RenderPass, EffectPass, Effect, EffectAttribute, BlendFunction, BloomEffect, SMAAEffect,
  ToneMappingEffect, ToneMappingMode, GodRaysEffect, DepthOfFieldEffect, KernelSize,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';

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
    Object.assign(ao.configuration, { aoRadius: 5, distanceFalloff: 1.2, intensity: 2.2, color: new THREE.Color('#2a1a10'), halfRes: true, depthAwareUpsampling: true, transparencyAware: false });
    ao.setQualityMode(Q.name === 'ultra' ? 'High' : 'Medium');
    composer.addPass(ao);
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
    composer, speed, dof, dofPass, bloom, flare, grade, rays, ao, sunMesh,
    exposure: 1,
    setSize(width, height) { composer.setSize(width, height); },
    // per frame: v = { blur, aberr, center: Vector2, flash, fade, dof: {on, focus, range} }
    update(dt, v) {
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
