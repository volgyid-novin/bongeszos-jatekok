// Where the optional UT2004 shield gun (shieldgun.js, the owner's own local extract) registers itself once it has been loaded. shieldgun.js is only ever
// imported dynamically, by renderer.js, in a dev build served from this machine; the production bundle has neither it nor its
// file names. viewmodel.js and figures.js read the registry (a module that nobody imported is simply not there) instead of importing the loader.
//   utGun.mod   { loadShieldGun, shieldGunTemplates, attachShieldGun, GunAnim, gunMaterial, MUZZLE_BONE } | null
//   utGun.on    false: switched off again (the setting), the module stays loaded but is not used
export const utGun = { mod: null, on: false };
export const utMod = () => (utGun.on && utGun.mod) || null;
