// Game data: the two races, their 6 buildings, 6 units and the blacksmith upgrades.
// Distances are in tiles, times in seconds. The simulation runs at 10 ticks a second.

export const MAP = 96;           // tiles per side
export const TICK = 0.1;         // seconds per simulation tick
export const FOOD_MAX = 100;
export const START_RES = { gold: 400, wood: 200 };
export const START_WORKERS = 4;
export const CARRY = 10;         // gold or lumber per trip
export const MINE_TIME = 2.5;    // seconds a worker spends inside a gold mine
export const CHOP_TIME = 4;      // seconds to chop one load of lumber
export const TREE_WOOD = 50;     // lumber in one tree
export const QUEUE_MAX = 5;

// Player colours (slot 0 starts top-left, slot 1 bottom-right)
export const TEAM_COLORS = [0x3d7bff, 0xe2412e];
export const TEAM_CSS = ['#5b93ff', '#ff5f4a'];

// Command card hotkeys: 3 rows x 4 buttons, QWER / ASDF / ZXCV
export const GRID_KEYS = ['Q', 'W', 'E', 'R', 'A', 'S', 'D', 'F', 'Z', 'X', 'C', 'V'];

// atk: melee | arrow | axe | fire | zap | bolt | rock | spear
export const UNITS = {
  // ---------- Emberek ----------
  peasant: {
    race: 'human', name: 'Paraszt', desc: 'Aranyat bányászik, fát vág, épületeket húz fel. Szükség esetén harcol is, de nem sokáig.',
    cost: { g: 50, w: 0 }, food: 1, time: 12, hp: 40, armor: 0, dmg: 4, range: 0.3, cd: 1.2, speed: 2.6, sight: 6, r: 0.3,
    atk: 'melee', worker: true, from: 'townhall', slot: 0,
  },
  footman: {
    race: 'human', name: 'Gyalogos', desc: 'Pajzsos, kardos közelharcos. Olcsó, szívós, a sereg gerince.',
    cost: { g: 120, w: 0 }, food: 1, time: 16, hp: 85, armor: 2, dmg: 8, range: 0.3, cd: 1.0, speed: 2.5, sight: 6, r: 0.36,
    atk: 'melee', from: 'barracks', slot: 0,
  },
  archer: {
    race: 'human', name: 'Íjász', desc: 'Messziről lő, de közelharcban gyorsan elesik. Tartsd a gyalogosok mögött.',
    cost: { g: 80, w: 40 }, food: 1, time: 15, hp: 45, armor: 0, dmg: 7, range: 5, cd: 1.2, speed: 2.7, sight: 8, r: 0.33,
    atk: 'arrow', from: 'barracks', slot: 1,
  },
  knight: {
    race: 'human', name: 'Lovag', desc: 'Páncélos lovas: gyors, erős, sokat kibír. Drága, de egy csapat lovag eldönti a csatát.',
    cost: { g: 200, w: 60 }, food: 2, time: 22, hp: 150, armor: 4, dmg: 12, range: 0.35, cd: 1.2, speed: 3.7, sight: 7, r: 0.5,
    atk: 'melee', from: 'barracks', req: 'blacksmith', slot: 2,
  },
  mage: {
    race: 'human', name: 'Mágus', desc: 'Tűzgolyót dob, ami a becsapódás körül mindenkit megéget. Sűrű csapatok ellen kiváló.',
    cost: { g: 150, w: 100 }, food: 2, time: 22, hp: 55, armor: 0, dmg: 12, range: 6, cd: 2.0, speed: 2.4, sight: 9, r: 0.33,
    atk: 'fire', splash: 1.3, from: 'magetower', slot: 0,
  },
  ballista: {
    race: 'human', name: 'Ballista', desc: 'Óriási nyílvessző nagyon messzire. Épületek ellen másfélszeres sebzés. Lassú, védeni kell.',
    cost: { g: 220, w: 120 }, food: 3, time: 28, hp: 110, armor: 2, dmg: 50, range: 8.5, cd: 3.5, speed: 1.7, sight: 9, r: 0.6,
    atk: 'bolt', bld: 1.5, from: 'blacksmith', slot: 0, siege: true,
  },
  // ---------- Orkok ----------
  peon: {
    race: 'orc', name: 'Peon', desc: 'Aranyat bányászik, fát vág, épületeket húz fel. Morog, de dolgozik.',
    cost: { g: 50, w: 0 }, food: 1, time: 12, hp: 45, armor: 0, dmg: 4, range: 0.3, cd: 1.2, speed: 2.6, sight: 6, r: 0.3,
    atk: 'melee', worker: true, from: 'greathall', slot: 0,
  },
  grunt: {
    race: 'orc', name: 'Morgó', desc: 'Nagy fejszés ork harcos. Több életereje van, mint az emberek gyalogosának, de kevesebb a páncélja.',
    cost: { g: 120, w: 0 }, food: 1, time: 16, hp: 100, armor: 1, dmg: 8, range: 0.3, cd: 1.0, speed: 2.5, sight: 6, r: 0.38,
    atk: 'melee', from: 'warcamp', slot: 0,
  },
  axethrower: {
    race: 'orc', name: 'Fejszevető', desc: 'Troll, aki dobófejszéket hajigál. Kicsit rövidebb a hatótávja, mint az íjászé, de többet bír.',
    cost: { g: 80, w: 40 }, food: 1, time: 15, hp: 52, armor: 0, dmg: 7, range: 4.5, cd: 1.1, speed: 2.7, sight: 8, r: 0.33,
    atk: 'axe', from: 'warcamp', slot: 1,
  },
  wolfrider: {
    race: 'orc', name: 'Farkaslovas', desc: 'Óriásfarkason lovagló ork. A leggyorsabb egység a csatatéren.',
    cost: { g: 190, w: 60 }, food: 2, time: 22, hp: 140, armor: 3, dmg: 13, range: 0.35, cd: 1.1, speed: 3.9, sight: 7, r: 0.5,
    atk: 'melee', from: 'warcamp', req: 'forge', slot: 2,
  },
  shaman: {
    race: 'orc', name: 'Sámán', desc: 'Láncvillámot idéz: a villám a célpontról még két közeli ellenségre átugrik.',
    cost: { g: 150, w: 100 }, food: 2, time: 22, hp: 60, armor: 0, dmg: 11, range: 6, cd: 2.0, speed: 2.4, sight: 9, r: 0.33,
    atk: 'zap', chain: 2, from: 'spirit', slot: 0,
  },
  catapult: {
    race: 'orc', name: 'Katapult', desc: 'Sziklát hajít, ami a becsapódás körül mindent összezúz. Épületek ellen másfélszeres sebzés.',
    cost: { g: 220, w: 120 }, food: 3, time: 28, hp: 120, armor: 1, dmg: 38, range: 8.5, cd: 4.0, speed: 1.6, sight: 9, r: 0.6,
    atk: 'rock', splash: 1.4, bld: 1.5, from: 'forge', slot: 0, siege: true,
  },
};

export const BUILDINGS = {
  // ---------- Emberek ----------
  townhall: {
    race: 'human', name: 'Városháza', desc: 'A falu szíve. Parasztokat képez, ide hordják az aranyat és a fát. 6 élelmet ad.',
    cost: { g: 400, w: 250 }, time: 60, hp: 1400, armor: 3, size: 4, sight: 9, food: 6, drop: true, hq: true,
    trains: ['peasant'], slot: 0,
  },
  farm: {
    race: 'human', name: 'Tanya', desc: '8 élelmet ad: ennyivel több egységet tudsz eltartani.',
    cost: { g: 80, w: 40 }, time: 20, hp: 400, armor: 1, size: 2, sight: 4, food: 8, slot: 1,
  },
  barracks: {
    race: 'human', name: 'Kaszárnya', desc: 'Gyalogost, íjászt és (kovácsműhellyel) lovagot képez.',
    cost: { g: 160, w: 60 }, time: 35, hp: 900, armor: 2, size: 3, sight: 6, trains: ['footman', 'archer', 'knight'], slot: 2,
  },
  blacksmith: {
    race: 'human', name: 'Kovácsműhely', desc: 'Ballistát épít, és itt fejlesztheted a fegyvereket és a páncélt. Kell hozzá a lovag is.',
    cost: { g: 150, w: 100 }, time: 35, hp: 750, armor: 2, size: 3, sight: 6, req: 'barracks',
    trains: ['ballista'], research: ['w', 'a'], slot: 3,
  },
  tower: {
    race: 'human', name: 'Őrtorony', desc: 'Messzire lát, és nyilakkal lövi a közelébe érő ellenséget.',
    cost: { g: 120, w: 100 }, time: 30, hp: 550, armor: 5, size: 2, sight: 10, req: 'barracks',
    attack: { dmg: 10, range: 7.5, cd: 1.3, atk: 'arrow' }, slot: 4,
  },
  magetower: {
    race: 'human', name: 'Mágustorony', desc: 'Mágusokat képez.',
    cost: { g: 150, w: 150 }, time: 40, hp: 650, armor: 1, size: 3, sight: 7, req: 'blacksmith', trains: ['mage'], slot: 5,
  },
  // ---------- Orkok ----------
  greathall: {
    race: 'orc', name: 'Nagyterem', desc: 'A törzs központja. Peonokat képez, ide hordják az aranyat és a fát. 6 élelmet ad.',
    cost: { g: 400, w: 250 }, time: 60, hp: 1500, armor: 2, size: 4, sight: 9, food: 6, drop: true, hq: true,
    trains: ['peon'], slot: 0,
  },
  pigfarm: {
    race: 'orc', name: 'Disznóól', desc: '8 élelmet ad: ennyivel több egységet tudsz eltartani.',
    cost: { g: 80, w: 40 }, time: 20, hp: 420, armor: 1, size: 2, sight: 4, food: 8, slot: 1,
  },
  warcamp: {
    race: 'orc', name: 'Barakk', desc: 'Morgót, fejszevetőt és (fegyverkováccsal) farkaslovast képez.',
    cost: { g: 160, w: 60 }, time: 35, hp: 950, armor: 1, size: 3, sight: 6, trains: ['grunt', 'axethrower', 'wolfrider'], slot: 2,
  },
  forge: {
    race: 'orc', name: 'Fegyverkovács', desc: 'Katapultot épít, és itt fejlesztheted a fegyvereket és a páncélt. Kell hozzá a farkaslovas is.',
    cost: { g: 150, w: 100 }, time: 35, hp: 800, armor: 1, size: 3, sight: 6, req: 'warcamp',
    trains: ['catapult'], research: ['w', 'a'], slot: 3,
  },
  watchtower: {
    race: 'orc', name: 'Őrbástya', desc: 'Cölöpökre épített őrhely: messzire lát, és lándzsákat hajít az ellenségre.',
    cost: { g: 120, w: 100 }, time: 30, hp: 600, armor: 4, size: 2, sight: 10, req: 'warcamp',
    attack: { dmg: 10, range: 7.5, cd: 1.3, atk: 'spear' }, slot: 4,
  },
  spirit: {
    race: 'orc', name: 'Szellemkunyhó', desc: 'Sámánokat képez.',
    cost: { g: 150, w: 150 }, time: 40, hp: 700, armor: 1, size: 3, sight: 7, req: 'forge', trains: ['shaman'], slot: 5,
  },
};

// Blacksmith research: 2 levels each. Weapons add +2 damage, armour +1 armour to every non-worker unit.
export const UPGRADES = {
  w: {
    name: { human: 'Acélpengék', orc: 'Fűrészes pengék' },
    desc: 'Minden harcos egység sebzése +2.',
    cost: [{ g: 150, w: 100 }, { g: 250, w: 200 }], time: [40, 55],
  },
  a: {
    name: { human: 'Lemezpáncél', orc: 'Tüskés vért' },
    desc: 'Minden harcos egység páncélja +1.',
    cost: [{ g: 150, w: 100 }, { g: 250, w: 200 }], time: [40, 55],
  },
};

export const RACES = {
  human: {
    name: 'Emberek', hq: 'townhall', farm: 'farm', worker: 'peasant',
    buildings: ['townhall', 'farm', 'barracks', 'blacksmith', 'tower', 'magetower'],
    units: ['peasant', 'footman', 'archer', 'knight', 'mage', 'ballista'],
    needFood: 'Több tanyát kell építened.',
  },
  orc: {
    name: 'Orkok', hq: 'greathall', farm: 'pigfarm', worker: 'peon',
    buildings: ['greathall', 'pigfarm', 'warcamp', 'forge', 'watchtower', 'spirit'],
    units: ['peon', 'grunt', 'axethrower', 'wolfrider', 'shaman', 'catapult'],
    needFood: 'Több disznóólat kell építened.',
  },
};

for (const [k, d] of Object.entries(UNITS)) d.key = k;
for (const [k, d] of Object.entries(BUILDINGS)) d.key = k;

export const MINE = { key: 'mine', name: 'Aranybánya', size: 3, hp: 1 };
export const defOf = (type) => UNITS[type] || BUILDINGS[type] || (type === 'mine' ? MINE : null);
