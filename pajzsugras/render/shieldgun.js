// The UT2004 shield gun, an OPTIONAL local model: the first person viewmodel (viewmodel.js) and the weapon in the Gorge's hand (figures.js) use it
// when it loads (on a dev build served from this machine: renderer.js imports this module only then), and keep PAJZSUGRÁS' own gauntlet / no weapon
// when it does not.
//   await loadShieldGun()          -> { first, third }: two templates (each possibly null), loaded once, never rejects
//   shieldGunTemplates()           the same once loaded
//   first = { scene, clips: Map(name -> AnimationClip), clone, skins }        the viewmodel: Idle, Select, PutDown, Charge, Charged, Fire, Shield
//   third = { scene, clips, clone, skins }                                     the held model (one pose, 'Still')
//   const anim = new GunAnim(root, clips); anim.update(dt, { charging, charge }); anim.fire(); anim.select(); anim.info(); anim.dispose()
//   attachShieldGun(rig, { ghost, solid, color })   a GorgeRig (gorge.js) gets the gun in its right hand -> the holder object, or null
//   gunMaterial({ map, ghost, color }) / shine(mat)   the materials both use
// The files are made from the player's own UT2004 install by tools/ut2004_extract.py into the git-ignored local-models/ folder (shieldgun-1st.glb,
// shieldgun-3rd.glb and the editable skin shieldgun.png) and are fetched from a plain string path, exactly like the Gorge (gorge.js): never
// bundled, not in the repository. Anything wrong with a file (missing, an HTML page from the dev server's fallback, not a glb, not our rig)
// gives null for that model. shieldgun.png replaces the glb's own texture the way gorge-body.png does (same checks, materials matched by name).
import * as THREE from 'three';
import { fetchGltf, applySkins, GHOST_OPACITY, GHOST_TINT, PREPASS_ORDER } from './gorge.js';
import { lin } from './merge.js';
import { utGun } from './ut-gun.js';
import { MODEL_ASSETS } from './model-assets.js';

const FILE_1ST = 'shieldgun-1st.glb', FILE_3RD = 'shieldgun-3rd.glb';
const NEEDED_1ST = ['Idle', 'Charge', 'Fire'];   // a first person glb without these is not the file the extractor makes
const SKIN_FILE = 'shieldgun.png';
export const HAND_BONE = 'Bone_weapon';          // the Gorge's attachment bone of the 'righthand' alias (child of Bip01 R Hand)
export const MUZZLE_BONE = 'Bone_Flash';         // the gun's emitter: the shield bubble and the muzzle flash sit here

// the third person gun is parented to the hand bone. The glb is in the gun's own actor frame (UT2004: x forward); the Gorge's mesh says where
// that frame sits in the bone: AttachCoords of 'righthand' = X (0,0,1), Y (-1,0,0), Z (0,-1,0) in the bone's frame, which in our axes is a
// rotation (the matrix below, gun frame -> bone frame, ROWS = the bone's x, y, z). The scale is the weapon's DrawScale: the glb is at 1 UU = 2 cm.
const ATTACH = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1);
const THIRD_SCALE = 0.38;
const THIRD_POS = [0, 0, 0];

let pending = null;
let tpls = { first: null, third: null };

export const shieldGunTemplates = () => tpls;
export function resetShieldGun() { pending = null; tpls = { first: null, third: null }; }   // (tests: load again with another fetch)

// the file of the PNG that repaints a material of the glb (ShieldTex0 is the one skin), or null
export const shieldSkinFileFor = (materialName) => (/shieldtex/i.test(String(materialName || '')) ? SKIN_FILE : null);

// -> Promise<{ first, third }>; never rejects, loads once (a second call returns the same promise)
export function loadShieldGun(base) {
  if (!pending) {
    const packed = base === undefined && MODEL_ASSETS.packed;
    pending = Promise.all([
      prepare(base === undefined ? MODEL_ASSETS.first : base + FILE_1ST, NEEDED_1ST, packed),
      prepare(base === undefined ? MODEL_ASSETS.third : base + FILE_3RD, [], packed),
    ]).then(([first, third]) => (tpls = { first, third }));
  }
  return pending;
}

async function prepare(url, needed, packed) {
  try {
    const got = await fetchGltf(url);
    if (!got) return null;
    const { gltf, clone } = got;
    const clips = new Map(gltf.animations.map((a) => [a.name, a]));
    if (needed.some((n) => !clips.has(n))) return null;
    let skinned = 0, bones = 0;
    gltf.scene.traverse((o) => {
      if (o.isBone) bones++;
      if (o.isSkinnedMesh) {
        skinned++;
        o.frustumCulled = false;
        o.geometry.userData.shared = true;   // nothing that is shared is ever disposed by a user of the template
        const m = o.material;
        m.userData.shared = true;
        if (m.map) { m.map.userData.shared = true; m.map.anisotropy = 4; }
      }
    });
    if (!skinned || !bones) return null;
    const skins = packed ? [SKIN_FILE] : await applySkins(gltf.scene, url, shieldSkinFileFor);
    return { scene: gltf.scene, clips, clone, skins, bones };
  } catch { return null; }
}

// UT2004 keeps the specular mask in the alpha channel of its skins: shiny (low roughness) where it is high. The map's alpha is never used as
// transparency (an opaque material ignores it; a ghost material below drops it).
export function shine(mat) {
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = mix(roughnessFactor, 0.3, sampledDiffuseColor.a);');
  };
  mat.customProgramCacheKey = () => 'shieldgun-shine';
  return mat;
}

// a material for a skinned mesh of the gun: ghost = translucent, tinted with the player's colour (the alpha of the map is dropped, it is not
// opacity); else lit, with a faint glow of its own so the dark skin reads
export function gunMaterial({ map, ghost = false, color = 0xffffff }) {
  if (ghost) {
    const mat = new THREE.MeshBasicMaterial({ map, color: new THREE.Color(...lin(color, GHOST_TINT)), transparent: true, opacity: GHOST_OPACITY, depthWrite: false });
    mat.onBeforeCompile = (shader) => { shader.fragmentShader = shader.fragmentShader.replace('diffuseColor *= sampledDiffuseColor;', 'diffuseColor.rgb *= sampledDiffuseColor.rgb;'); };
    mat.customProgramCacheKey = () => 'shieldgun-ghost';
    return mat;
  }
  return shine(new THREE.MeshStandardMaterial({ map, roughness: 0.62, metalness: 0.3, emissive: new THREE.Color(0.1, 0.1, 0.1), emissiveMap: map }));
}

// ---------------------------------------------------------------- first person animation
const FADE = { select: 0.05, idle: 0.2, charge: 0.1, charged: 0.12, fire: 0.04 };
const CHARGED_AT = 0.985;   // from this charge on the wound-up gun holds its Charged loop
const WIND_AT = 0.03;       // the Charge sequence takes over from the idle one when the charge is above this

// Drives a first person gun from the shield state: Idle loops; while charging, Charge is played to the charge value (0 = start, 1 = fully
// wound), then Charged loops; fire() (a blast) plays Fire once; select() (a respawn) plays Select once; everything else goes back to Idle.
export class GunAnim {
  constructor(root, clips) {
    this.mixer = new THREE.AnimationMixer(root);
    this.clips = clips;
    this.actions = new Map();
    this.cur = null;      // the action that is playing / scrubbed
    this.state = 'none';  // 'select' | 'idle' | 'charge' | 'charged' | 'fire'
    this.t = 0;           // seconds in this state
    this.charge = 0;
    this.select();
  }

  // start `clip` as state `state`; false (and nothing changes) when the glb lacks the clip
  play(state, clip, fade, once) {
    const c = this.clips.get(clip);
    if (!c) return false;
    let a = this.actions.get(clip);
    if (!a) this.actions.set(clip, a = this.mixer.clipAction(c));
    const prev = this.cur;
    a.reset();
    a.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    a.clampWhenFinished = true;
    a.setEffectiveTimeScale(1);
    a.setEffectiveWeight(1);
    a.play();
    if (prev && prev !== a) prev.crossFadeTo(a, fade, false);
    this.cur = a;
    this.state = state;
    this.t = 0;
    return true;
  }

  select() { if (!this.play('select', 'Select', FADE.select, true)) this.play('idle', 'Idle', FADE.select, false); }
  fire() { if (!this.play('fire', 'Fire', FADE.fire, true)) this.idle(); }
  idle() { this.play('idle', 'Idle', FADE.idle, false); }
  duration(clip) { const c = this.clips.get(clip); return c ? c.duration : 0; }

  update(dt, { charging = false, charge = 0 } = {}) {
    this.t += dt;
    this.charge = charge;
    const s = this.state, wind = charging && charge > WIND_AT;
    if (wind) {
      if (s !== 'charge' && s !== 'charged') this.play('charge', 'Charge', FADE.charge, true);
      else if (s === 'charge' && charge >= CHARGED_AT) this.play('charged', 'Charged', FADE.charged, false);
    } else if (s === 'charge' || s === 'charged') this.idle();
    else if (s === 'fire' && this.t >= this.duration('Fire')) this.idle();
    else if (s === 'select' && this.t >= this.duration('Select')) this.idle();
    if (this.state === 'charge') {   // the wind-up follows the charge, not the clock
      this.cur.time = Math.max(0, Math.min(1, charge)) * this.cur.getClip().duration;
      this.cur.setEffectiveTimeScale(0);
    }
    this.mixer.update(dt);
  }

  // what is playing (for __pj.state().viewmodel and the tests)
  info() {
    const a = this.cur;
    return {
      state: this.state, clip: a ? a.getClip().name : null, time: a ? Math.round(a.time * 1000) / 1000 : 0, charge: Math.round(this.charge * 1000) / 1000,
      active: [...this.actions.values()].filter((x) => x.isScheduled() && x.getEffectiveWeight() > 0.001).map((x) => x.getClip().name),
    };
  }

  dispose() {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.mixer.getRoot());
    this.actions.clear();
    this.cur = null;
  }
}

// ---------------------------------------------------------------- third person
// The gun in the right hand of a Gorge rig (figures.js): a clone of the held model under the hand bone, with the rig's own treatment (ghost:
// translucent + a depth-only copy drawn first; solid / own figure: lit). The rig fades it with the figure and disposes its materials and
// skeleton (the geometry and textures are the template's and are never disposed). -> the holder object, or null (no model / no hand bone).
export function attachShieldGun(rig, { ghost = false, solid = false, color = 0xffffff } = {}) {
  const tpl = tpls.third;
  const bone = tpl && rig.root.getObjectByName(HAND_BONE);
  if (!bone) return null;
  const gun = tpl.clone(tpl.scene);
  gun.name = 'shieldgun';
  const holder = new THREE.Group();
  holder.name = 'shieldgun-hand';
  holder.quaternion.setFromRotationMatrix(ATTACH);
  holder.scale.setScalar(THIRD_SCALE);
  holder.position.set(...THIRD_POS);
  holder.add(gun);
  bone.add(holder);
  const translucent = ghost && !solid, meshes = [];
  gun.traverse((o) => { if (o.isSkinnedMesh) meshes.push(o); });
  for (const mesh of meshes) {
    const mat = gunMaterial({ map: mesh.material.map, ghost: translucent, color });
    if (translucent) {
      rig.fadeMats.push(mat);
      const pre = new THREE.SkinnedMesh(mesh.geometry, new THREE.MeshBasicMaterial({ colorWrite: false }));
      pre.bind(mesh.skeleton, mesh.bindMatrix);
      pre.frustumCulled = false;
      pre.renderOrder = PREPASS_ORDER;
      pre.name = mesh.name + ':depth';
      mesh.parent.add(pre);
      rig.mats.push(pre.material);
    }
    mesh.material = mat;
    mesh.castShadow = !translucent;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    rig.mats.push(mat);
  }
  return holder;
}

// loading this module is the opt-in: figures.js and viewmodel.js find the gun through the registry (ut-gun.js)
utGun.mod = { loadShieldGun, shieldGunTemplates, attachShieldGun, GunAnim, gunMaterial, MUZZLE_BONE };
utGun.on = true;
