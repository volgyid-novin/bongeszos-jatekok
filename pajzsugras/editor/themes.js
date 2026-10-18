// The theme preset of the map editor: sky, fog, light, colour palette and ambient sound. It is the look of KIKÉPZÉS, the first of the eight
// original maps (the other seven themes are gone): every map document names it in its `theme` field (editor/convert.js copies the preset
// into the map's theme), and an unknown id in an old document reads as this one (editor/model.js cleanTheme). Pure data.
export const THEMES = {
  // KIKÉPZÉS
  kikepzes: {
    sky: { type: 'clouds', top: 0x5aa0e8, horizon: 0xeaf6ff, bottom: 0xb8d8f0, sunDir: [0.45, 0.8, -0.35], sunColor: 0xfff3dc, stars: 0, clouds: 0.35 },
    palette: { floor: 0xe6eef2, wall: 0xb4c8d2, trim: 0xff8a2a, accent: 0x1fb8b0, glow: 0x30e8d8, danger: 0xff5a3a },
    fog: { color: 0xdcecf8, near: 120, far: 620 },
    hemi: { sky: 0xdff0ff, ground: 0x9bb2c4, intensity: 1 },
    sun: { color: 0xfff0d8, intensity: 1.9 },
    bloom: 0.45,
    ambient: 'facility',
  },
};

export const THEME_NAMES = {
  kikepzes: 'KIKÉPZÉS',
};
export const THEME_IDS = Object.keys(THEMES);
