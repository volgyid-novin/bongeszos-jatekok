// Comic-style icons for skills, passives and items: a white glyph with an ink outline on a coloured disc.
// Glyphs are drawn in a 24x24 box.

const G = {
  // ---- Granit ----
  shieldbash: '<path d="M7 4h7l3 3v7c0 4-4 6-6 7-2-1-6-3-6-7V6z"/><path d="M18 9l4 3-4 3" fill="none"/>',
  fissure: '<path d="M2 20l5-3 2 3 3-6 2 4 3-7 2 3 3-6" fill="none" stroke-width="2.4"/><path d="M6 11l2-4 2 3" fill="none"/>',
  stoneshield: '<path d="M12 2l8 3v7c0 5-4 8-8 10-4-2-8-5-8-10V5z"/><path d="M8 9l3 2 5-3M8 14l4 1 4-2" fill="none"/>',
  roar: '<circle cx="9" cy="12" r="4"/><path d="M15 7c2 1 3 3 3 5s-1 4-3 5M18 4c3 2 5 5 5 8s-2 6-5 8" fill="none"/>',
  whirl: '<path d="M12 12c0-3 3-4 5-2s1 7-4 7-8-4-7-9 7-7 11-4" fill="none" stroke-width="2.4"/><rect x="15" y="2" width="6" height="5" rx="1"/>',
  mountain: '<path d="M1 21l8-13 4 6 3-4 7 11z"/><path d="M12 2v5M9 4l3 3 3-3" fill="none"/>',
  stoneskin: '<path d="M5 6l6-3 7 3 2 7-4 7H8l-4-6z"/><path d="M8 9l4 3 4-2M10 15l3-3" fill="none"/>',
  fist: '<rect x="5" y="8" width="13" height="9" rx="3"/><path d="M8 8V5M11 8V4M14 8V5M3 20l3-2M20 20l-3-2M12 22v-3" fill="none"/>',
  // ---- Parázs ----
  fireball: '<circle cx="14" cy="10" r="6"/><path d="M9 14L2 21M8 10L3 12M14 16l-3 6" fill="none"/>',
  flamewall: '<path d="M3 21c0-4 2-5 2-8 2 2 3 4 3 8M9 21c0-6 3-7 3-12 3 3 3 7 3 12M16 21c0-4 2-5 2-8 2 2 3 5 3 8"/>',
  blink: '<path d="M4 18l4-4M2 13l3-1M8 21l1-3"/><path d="M13 4c3 2 6 5 6 8a5 5 0 01-10 0c0-3 3-4 4-8z"/>',
  ring: '<circle cx="12" cy="13" r="7" fill="none" stroke-width="2.6"/><path d="M12 3v4M5 5l2 3M19 5l-2 3"/>',
  breath: '<path d="M3 12l7-5v10z"/><path d="M11 6c4 0 9 2 11 6-2 4-7 6-11 6"/>',
  meteor: '<circle cx="15" cy="15" r="5"/><path d="M11 11L3 3M13 9L8 2M9 13L2 8" fill="none"/>',
  burn: '<path d="M12 2c4 5 7 8 7 13a7 7 0 01-14 0c0-3 2-5 3-7 1 2 2 3 3 3 0-3 0-6 1-9z"/>',
  overheat: '<path d="M12 2c3 4 5 6 5 10a5 5 0 01-10 0c0-2 1-4 2-5 1 2 2 2 2 2 0-3 0-5 1-7z"/><path d="M3 20h18M5 17l-2-2M19 17l2-2" fill="none"/>',
  // ---- Sólyom ----
  arrow: '<path d="M2 22L20 4" fill="none" stroke-width="2.4"/><path d="M14 3h7v7z"/><path d="M2 17l3 1 1 3M5 15l3 1 1 3" fill="none"/>',
  rain: '<path d="M5 2v9M12 3v9M19 2v9M8 11v9M15 12v9" fill="none"/><path d="M3 10l2 3 2-3M10 11l2 3 2-3M17 10l2 3 2-3M6 19l2 3 2-3M13 20l2 3 2-3"/>',
  roll: '<path d="M4 15a8 8 0 0114-6" fill="none" stroke-width="2.4"/><path d="M19 4v6h-6z"/><circle cx="8" cy="18" r="3"/>',
  trap: '<path d="M2 16c3-8 17-8 20 0z"/><path d="M5 12l1-3 2 2 2-3 2 3 2-3 2 3 2-2 1 3" fill="none"/>',
  falcon: '<path d="M2 9c4 0 7 1 10 4 3-4 6-6 10-7-2 4-4 8-8 10l-2 5-2-5c-4-1-6-4-8-7z"/>',
  storm: '<path d="M13 2L5 13h6l-2 9 10-13h-6z"/>',
  bowstring: '<path d="M7 2c8 4 8 16 0 20" fill="none" stroke-width="2.4"/><path d="M7 2v20" fill="none"/><path d="M7 12h14M17 9l4 3-4 3" fill="none"/>',
  feather: '<path d="M20 3C10 4 5 10 4 20l2-1c1-4 3-7 7-9-3 3-5 5-6 9 7-2 12-8 13-16z"/>',
  // ---- Árny ----
  dagger: '<path d="M4 20l9-9 2 2-9 9z"/><path d="M13 11l7-8 1 1-7 9z" fill="#fff"/>',
  smoke: '<circle cx="8" cy="14" r="5"/><circle cx="15" cy="11" r="5"/><circle cx="17" cy="17" r="4"/>',
  step: '<circle cx="15" cy="5" r="3"/><path d="M14 9l-4 6 4 2-1 6M10 15l-6 1M14 13l5 1"/><path d="M2 8h5M1 12h4" fill="none"/>',
  blades: '<path d="M12 3c5 0 8 4 8 8M21 12c0 5-4 8-8 8M12 21c-5 0-8-4-8-8M3 12c0-5 4-8 8-8" fill="none" stroke-width="2.4"/><circle cx="12" cy="12" r="2"/>',
  clone: '<circle cx="9" cy="6" r="3"/><path d="M5 22v-8l4-3 4 3v8z"/><circle cx="16" cy="6" r="3" opacity=".55"/><path d="M12 22v-8l4-3 4 3v8z" opacity=".55"/>',
  moon: '<path d="M15 2a10 10 0 100 20 8 8 0 010-20z"/>',
  mark: '<path d="M12 2l3 7 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z"/>',
  skull: '<path d="M12 2a8 8 0 00-8 8c0 3 2 5 3 6v4h10v-4c1-1 3-3 3-6a8 8 0 00-8-8z"/><circle cx="9" cy="11" r="2" fill="#1b120e"/><circle cx="15" cy="11" r="2" fill="#1b120e"/>',
  // ---- items ----
  sword: '<path d="M18 2h4v4L9 19l-4-4z"/><path d="M4 14l6 6M3 21l3-3" fill="none"/>',
  gem: '<path d="M6 3h12l4 6-10 13L2 9z"/><path d="M2 9h20M9 3l3 6 3-6M12 9v13" fill="none"/>',
  heart: '<path d="M12 21C5 16 2 12 2 8a5 5 0 0110-2 5 5 0 0110 2c0 4-3 8-10 13z"/>',
  vest: '<path d="M7 2l5 3 5-3 4 4-2 4v12H5V10L3 6z"/><path d="M12 5v17" fill="none"/>',
  cloak: '<path d="M8 2h8l2 4 3 16H3L6 6z"/><path d="M12 6v16" fill="none"/>',
  boot: '<path d="M6 2h7v11l7 3v6H4z"/><path d="M15 6h6M16 10h5" fill="none"/>',
  fang: '<path d="M4 3h16l-3 10-3-4-2 12-2-12-3 4z"/>',
  axe: '<path d="M7 22L19 4" fill="none" stroke-width="2.6"/><path d="M14 3c5 0 8 3 8 8-4-1-6-2-8-4z"/>',
  bolt: '<path d="M13 2L5 13h6l-2 9 10-13h-6z"/>',
  crown: '<path d="M2 8l5 4 5-8 5 8 5-4-2 12H4z"/>',
  hat: '<path d="M12 2l6 14H6z"/><path d="M2 18h20v3H2z"/><circle cx="12" cy="10" r="1.5" fill="#1b120e"/>',
  plate: '<path d="M4 4h16v8c0 6-4 9-8 10-4-1-8-4-8-10z"/><path d="M8 8h8M8 12h8" fill="none"/>',
  tree: '<circle cx="12" cy="9" r="7"/><path d="M12 14v8M8 22h8" fill="none" stroke-width="2.4"/>',
  potion: '<path d="M9 2h6v5l5 7c1 4-2 8-8 8s-9-4-8-8l5-7z"/><path d="M6 15h12" fill="none"/>',
};

// returns an <svg> string: glyph `name` on a disc of `col`
export function icon(name, col = '#5a6a80', opts = {}) {
  const g = G[name] || G.mark;
  const id = 'g' + Math.random().toString(36).slice(2, 8);
  const sq = opts.square;
  const bg = sq
    ? `<rect x="0.5" y="0.5" width="23" height="23" rx="3" fill="url(#${id})" stroke="#1b120e" stroke-width="1"/>`
    : `<circle cx="12" cy="12" r="11.5" fill="url(#${id})" stroke="#1b120e" stroke-width="1"/>`;
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><defs><radialGradient id="${id}" cx="35%" cy="30%" r="80%"><stop offset="0" stop-color="${col}" stop-opacity="1"/><stop offset="1" stop-color="${shade(col, 0.45)}"/></radialGradient></defs>${bg}<g transform="translate(3.6 3.6) scale(.7)" fill="#fff" stroke="#1b120e" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" paint-order="stroke">${g}</g></svg>`;
}
function shade(hex, k) {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = Math.round(((n >> 16) & 255) * k), g = Math.round(((n >> 8) & 255) * k), b = Math.round((n & 255) * k);
  return `rgb(${r},${g},${b})`;
}
