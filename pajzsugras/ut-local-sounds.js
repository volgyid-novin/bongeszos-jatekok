// The owner's own UT2004 sounds: a git-ignored ./local-sounds/ folder next to the page (sounds the player owns, extracted from their own install by
// tools/ut2004_extract.py) can replace the shield charge / blast, jump, double jump, dodge, wall dodge, footsteps and landing.
// audio.js loads this module with a dynamic import() only when the build is a dev build (import.meta.env.DEV), the page is served from this machine
// AND the player switched "Helyi UT2004-fájlok" on in the settings; the production bundle carries none of it, and nothing here is ever requested otherwise.
//
//   loadUTSounds(ctx, onBuffer)   fetches ./local-sounds/sounds.json = { charge, fire, jump, dodge, step: [file, ...] } (several files of one kind
//                                 are played at random); without the list only shield-charge.wav and shield-fire.wav are tried. Each decoded
//                                 sound is handed to onBuffer(name, AudioBuffer). Anything missing is just skipped (the bundled sound plays).
const KINDS = ['charge', 'fire', 'jump', 'dodge', 'step'];

export function loadUTSounds(ctx, onBuffer) {
  const load = (name, file) => fetch(`./local-sounds/${file}`)
    .then((r) => (r.ok && /audio|wav|octet/.test(r.headers.get('content-type') || '') ? r.arrayBuffer() : null))
    .then((buf) => (buf ? ctx.decodeAudioData(buf) : null))
    .then((ab) => { if (ab) onBuffer(name, ab); })
    .catch(() => { /* no local sample */ });
  return fetch('./local-sounds/sounds.json')
    .then((r) => (r.ok && /json/.test(r.headers.get('content-type') || '') ? r.json() : null))
    .catch(() => null)
    .then((list) => {
      const files = list && typeof list === 'object' ? list : { charge: ['shield-charge.wav'], fire: ['shield-fire.wav'] };
      const jobs = [];
      for (const name of KINDS) {
        for (const f of Array.isArray(files[name]) ? files[name].slice(0, 12) : []) if (typeof f === 'string' && /^[\w.-]+\.wav$/i.test(f)) jobs.push(load(name, f));
      }
      return Promise.all(jobs);
    });
}
