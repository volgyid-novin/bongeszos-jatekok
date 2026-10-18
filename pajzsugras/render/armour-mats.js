// The hard-surface material set of PAJZSUGRÁS' own gear: the shield gauntlet (gauntlet.js) and, in the same family, the BÁSTYA character.
//
//   const mats = armourMats(tint = 0xff8a2a)  ->  { paint, frame, steel, suit, trim, lens, dispose() }
//     paint  player-tinted enamel, clear coat, a fine detail normal map        (MeshPhysical, vertex colours = AO x edge wear from hardkit.js)
//     frame  gunmetal, the under-layer of every plate                          (MeshStandard)
//     steel  bright brushed steel for the big turned parts that must not read black   (MeshStandard)
//     suit   black rubber: bellows, cables                                     (MeshStandard)
//     trim   emissive teal that crosses the bloom threshold; the owner animates its colour
//     lens   smoked glass over the emitter core                                (MeshPhysical, translucent)
// Every call returns its own set (the tint, and the trim the owner animates, differ per figure); the detail normal map is made once and shared
// (userData.shared), and there is none where no canvas exists (node), so the models build there too.
import * as THREE from 'three';
import { armourDetailCanvas } from './textures.js';
import { lin } from './merge.js';

let detail;
function detailMap() {
  if (detail !== undefined) return detail;
  let canvas = null;
  try { canvas = armourDetailCanvas(256); } catch { /* no usable canvas: the detail map is only decoration */ }
  if (!canvas) return (detail = null);
  detail = new THREE.CanvasTexture(canvas);
  detail.wrapS = detail.wrapT = THREE.RepeatWrapping;
  detail.colorSpace = THREE.NoColorSpace;
  detail.anisotropy = 4;
  detail.userData.shared = true;
  return detail;
}

export function armourMats(tint = 0xff8a2a) {
  const normalMap = detailMap();
  const n = (k) => (normalMap ? { normalMap, normalScale: new THREE.Vector2(k, k) } : {});
  const paint = new THREE.MeshPhysicalMaterial({ color: tint, roughness: 0.38, metalness: 0.15, clearcoat: 0.6, clearcoatRoughness: 0.25, vertexColors: true, ...n(0.3) });
  const frame = new THREE.MeshStandardMaterial({ color: 0x3a3f45, roughness: 0.32, metalness: 0.85, vertexColors: true, ...n(0.8) });
  const steel = new THREE.MeshStandardMaterial({ color: 0x98a2ac, roughness: 0.3, metalness: 0.9, vertexColors: true, ...n(0.6) });
  const suit = new THREE.MeshStandardMaterial({ color: 0x16181b, roughness: 0.75, metalness: 0.1, vertexColors: true });
  const trim = new THREE.MeshBasicMaterial({ color: new THREE.Color(...lin(0x40e8d4, 2.6)) });
  const lens = new THREE.MeshPhysicalMaterial({ color: 0x0b1a1f, roughness: 0.06, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.05, transparent: true, opacity: 0.4, envMapIntensity: 1.8, depthWrite: false });
  const all = [paint, frame, steel, suit, trim, lens];
  return { paint, frame, steel, suit, trim, lens, dispose() { for (const m of all) m.dispose(); } };
}
