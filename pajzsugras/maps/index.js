// The map registry. Static imports (the bundler needs them), in ladder order. meta is read eagerly, build() runs when a
// map is loaded.
import kikepzes from './kikepzes.js';
import ontode from './ontode.js';
import egikikoto from './egikikoto.js';
import kristalyakna from './kristalyakna.js';
import neontorony from './neontorony.js';
import lavatemplom from './lavatemplom.js';
import vihargat from './vihargat.js';
import orbitalis from './orbitalis.js';

const list = [kikepzes, ontode, egikikoto, kristalyakna, neontorony, lavatemplom, vihargat, orbitalis].sort((a, b) => a.meta.order - b.meta.order);
const byId = new Map(list.map((m) => [m.meta.id, m]));

export const MAPS = {
  list,                                   // [{ meta, build() }] in ladder order
  ids: list.map((m) => m.meta.id),
  get: (id) => byId.get(id) || null,
  has: (id) => byId.has(id),
};
export default MAPS;

// difficulty labels for the UI
export const DIFF_LABEL = { kikepzes: 'Kiképzés', konnyu: 'Könnyű', kozepes: 'Közepes', nehez: 'Nehéz', mester: 'Mester' };
