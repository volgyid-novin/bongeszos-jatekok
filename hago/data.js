// HÁGÓ: every number of the game lives here: heroes and their skills, minions, towers, the boss, items, gold and XP.
// The simulation (sim.js, skills.js), the bots (ai.js) and the tooltips (hud.js) all read the same values,
// so a skill's tooltip always shows exactly what the skill does.

export const TICK = 1 / 30;            // simulation step (s)
export const SNAP_EVERY = 2;           // a network snapshot every 2nd tick (15 Hz)
export const MAX_LEVEL = 13;
export const START_GOLD = 600;
export const PASSIVE_GOLD = 2.4;       // gold per second for every hero, from 1:00
export const POTION = { cost: 50, max: 3, heal: 160, dur: 10 };

// entity kinds, damage types and the state bits the clients get for the visuals
export const K = { HERO: 0, MINION: 1, TOWER: 2, NEXUS: 3, BOSS: 4, CLONE: 5 };
export const MTYPES = ['melee', 'caster', 'siege'];
export const PHYS = 0, MAGIC = 1, TRUE = 2;
export const F = {
  STUN: 1, ROOT: 2, SLOW: 4, SILENCE: 8, AIR: 16, SHIELD: 32, STEALTH: 64, UNTARGET: 128, BURN: 256, MARK_A: 512,
  MARK_S: 1024, READY: 2048, BOSS: 4096, RECALL: 8192, TAUNT: 16384, HASTE: 32768, DR: 65536, SPIN: 131072,
  LEAP: 262144, DASH: 524288, DANCE: 1048576, CAST: 2097152, EMP: 4194304, POT: 8388608,
};

export const TEAMS = [
  { name: 'KÉK', css: '#3f8cff', hex: 0x3f8cff, dark: 0x1d3f8a },
  { name: 'PIROS', css: '#ff4b3a', hex: 0xff4b3a, dark: 0x8a1d16 },
];
export const NEUTRAL = 2;

// ---------- the lane (x runs from the blue base at -x to the red base at +x) ----------
export const LANE = {
  fountainX: 58,         // |x| of the fountains
  nexusX: 49,
  towers: [17, 30, 41],  // |x| of the outer, inner and guard tower
  baseR: 12,             // the shop works inside this radius around the fountain
};
export const XP_RANGE = 14;            // heroes this close to a dying enemy share its XP
export const ASSIST_WINDOW = 10;       // s
export const RECALL_TIME = 4;
export const respawnTime = (lvl) => 4 + 2 * lvl;
export const xpToNext = (lvl) => 180 + 80 * (lvl - 1);

// ---------- minions ----------
export const MINIONS = {
  melee: { hp: 450, ad: 14, period: 1.25, range: 1.1, ms: 3.25, armor: 0, mr: 0, r: 0.45, gold: 20, xp: 58, windup: 0.35 },
  caster: { hp: 290, ad: 23, period: 1.6, range: 5.0, ms: 3.25, armor: 0, mr: 0, r: 0.42, gold: 15, xp: 29, windup: 0.4, proj: 'mbolt', pspeed: 12 },
  siege: { hp: 900, ad: 40, period: 2.0, range: 6.5, ms: 3.25, armor: 15, mr: 10, r: 0.7, gold: 45, xp: 90, windup: 0.45, proj: 'cannon', pspeed: 11 },
};
export const WAVE = { first: 15, every: 25, comp: ['melee', 'melee', 'melee', 'caster', 'caster'], siegeEvery: 3 };
// minions grow stronger with time (per minute after 1:30)
export const minionGrowth = (t) => { const m = Math.max(0, (t - 90) / 60); return { hp: 1 + 0.045 * m, ad: 1 + 0.035 * m }; };

// ---------- structures ----------
export const TOWERS = [
  { hp: 2400, ad: 150, range: 7.5, period: 0.9, armor: 40, mr: 40, r: 1.3, gold: 120 },
  { hp: 2800, ad: 165, range: 7.5, period: 0.9, armor: 45, mr: 45, r: 1.3, gold: 130 },
  { hp: 3200, ad: 180, range: 7.5, period: 0.9, armor: 50, mr: 50, r: 1.3, gold: 150 },
];
export const TOWER_RAMP = 0.3;         // +30% damage per consecutive shot on the same hero, up to +90%
export const TOWER_MINION_DMG = { melee: 0.45, caster: 0.65, siege: 0.14 };   // share of max HP per shot
export const BACKDOOR = 0.4;           // damage reduction while no enemy minion is near the structure
export const NEXUS = { hp: 4000, armor: 0, mr: 0, r: 2.3 };

// ---------- the boss in the side pit ----------
export const BOSS = {
  name: 'A HÁGÓ ŐRE',
  first: 120, respawn: 180,
  hp: 3800, hpPerMin: 260, ad: 85, adPerMin: 6, armor: 30, mr: 30, r: 1.5, range: 2.6, period: 1.5, ms: 3.0,
  slamEvery: 8, slamWindup: 1.0, slamR: 4.2, slamDmg: 160,
  leash: 11.5,
  gold: 150, xp: 350,
  buffDur: 120,                        // "Az Őr áldása": +20% damage, and minions near you deal +50% and take -30%
};

// ---------- items ----------
// Advanced items have one unique passive; a hero carries 6 items at most (potions are separate).
export const ITEMS = [
  { id: 'kard', name: 'Acélkard', cost: 400, icon: 'sword', st: { ad: 15 } },
  { id: 'kristaly', name: 'Szikrakristály', cost: 435, icon: 'gem', st: { ap: 25 } },
  { id: 'rubin', name: 'Rubinszív', cost: 400, icon: 'heart', st: { hp: 160 } },
  { id: 'lancing', name: 'Láncing', cost: 300, icon: 'vest', st: { armor: 18 } },
  { id: 'kopeny', name: 'Varázsköpeny', cost: 350, icon: 'cloak', st: { mr: 20 } },
  { id: 'csizma', name: 'Szélcsizma', cost: 300, icon: 'boot', st: { ms: 0.45 } },
  { id: 'tor', name: 'Fürge tőr', cost: 300, icon: 'dagger', st: { as: 0.15 } },
  { id: 'verszomj', name: 'Vérszomj', cost: 1400, icon: 'fang', adv: true, st: { ad: 30, ls: 0.15 }, tip: 'Az alaptámadásaid sebzésének 15%-át visszagyógyítod.' },
  { id: 'hasito', name: 'Hasító', cost: 1600, icon: 'axe', adv: true, st: { ad: 40, cdr: 0.2 }, tip: '20%-kal rövidebb visszatöltés.' },
  { id: 'viharij', name: 'Viharíj', cost: 1500, icon: 'bolt', adv: true, st: { as: 0.35, ms: 0.35 }, tip: 'Minden 3. alaptámadásod villámot ugrat 3 ellenségre (60 + 25% VE mágikus).' },
  { id: 'holdtor', name: 'Holdtőr', cost: 1550, icon: 'moon', adv: true, st: { ad: 35, pen: 12 }, tip: 'Figyelmen kívül hagyja a célpont páncéljából 12 pontot.' },
  { id: 'lang', name: 'Lángkorona', cost: 1600, icon: 'crown', adv: true, st: { ap: 70, cdr: 0.15 }, tip: '15%-kal rövidebb visszatöltés.' },
  { id: 'kalap', name: 'Mágus kalapja', cost: 2400, icon: 'hat', adv: true, st: { ap: 110, apMul: 0.25 }, tip: 'A varázserőd 25%-kal nő.' },
  { id: 'granitvert', name: 'Gránitvért', cost: 1500, icon: 'plate', adv: true, st: { hp: 350, armor: 40, thorns: 0.2 }, tip: 'Az alaptámadások sebzésének 20%-át visszaveri a támadóra (mágikus).' },
  { id: 'eletfa', name: 'Életfa', cost: 1450, icon: 'tree', adv: true, st: { hp: 300, mr: 35, regen: 3 }, tip: '+3 életerő-visszatöltés másodpercenként.' },
];
export const MAX_CDR = 0.4;

// ---------- heroes ----------
// Skill numbers: [base, per level above 1, x attack damage (VE), x spell power (VA)]. val() turns them into a number.
// Skill slots: 0 Q, 1 W, 2 E, 3 D, 4 F, 5 R (ult). The two passives: P1 from the start, P2 from level 4.
export const SLOT_KEYS = ['Q', 'W', 'E', 'D', 'F', 'R'];
export const UNLOCK = [1, 1, 1, 2, 3, 5];
export const P2_LEVEL = 4;

export function val(n, st) {
  if (typeof n === 'number') return n;
  return n[0] + (n[1] || 0) * (st.lvl - 1) + (n[2] || 0) * st.ad + (n[3] || 0) * st.ap + (n[4] || 0) * st.maxHp;
}

// Skill kinds (what the aiming indicator looks like and how the target is read):
//  line  { range, width }            skillshot toward the cursor
//  circle{ range, radius }           ground target
//  cone  { range, angle }            toward the cursor
//  dash  { range }                   toward the cursor
//  blink { range }                   toward the cursor
//  unit  { range, targets }          the unit under the cursor ('enemy' | 'ally' | 'any' | 'hero')
//  self  { radius }                  instant, around the hero
//  wall  { range, length }           a wall across the cast direction
// ai: what the bots use it for: poke, cc, engage, aoe, escape, shield, trap, mark, execute, farm
export const HEROES = [
  {
    id: 'granit', name: 'GRANIT', title: 'a Kőlovag', role: 'Harcos', css: '#8fb3d9', hex: 0x8fb3d9,
    blurb: 'Páncélos kőlovag pajzzsal és kalapáccsal. Berobban, elkábít, magára vonja a figyelmet, és megvédi a társát.',
    diff: 1, melee: true,
    stats: { hp: 680, hpG: 96, regen: 2.2, regenG: 0.16, ad: 62, adG: 3.5, as: 0.67, asG: 0.022, range: 2.0, armor: 35, armorG: 4.3, mr: 30, mrG: 1.25, ms: 3.35, r: 0.65 },
    attack: { windup: 0.3, sound: 'blunt' },
    passives: [
      { name: 'Kőbőr', icon: 'stoneskin', n: { sh: [0, 0, 0, 0, 0.09] },
        desc: 'Ha 6 mp-ig nem ér sebzés, kőpáncél nő rád, ami <b>{sh}</b> sebzést nyel el.' },
      { name: 'Földrengető', icon: 'fist', n: { d: [20, 4] },
        desc: 'Minden 3. alaptámadásod rengést kelt: <b class=p>{d} + a célpont max. életerejének 4%-a</b> fizikai sebzés és 30% lassítás 1 mp-ig.' },
    ],
    skills: [
      { id: 'q', name: 'Pajzsroham', icon: 'shieldbash', kind: 'dash', range: 4.6, cd: 11, cast: 0, n: { d: [40, 15, 0.5] }, stun: 1.0,
        desc: 'Előrerohan a pajzsával. Az első eltalált ellenséges hős <b class=p>{d}</b> fizikai sebzést kap, és 1 mp-re elkábul. A minionokat félrelöki.',
        ai: { use: 'engage', range: 4.6 } },
      { id: 'w', name: 'Földhasítás', icon: 'fissure', kind: 'line', range: 8.5, width: 1.4, speed: 16, cd: 10, cast: 0.25, n: { d: [70, 22, 0.6] },
        desc: 'Kalapácsát a földbe vágja: a hasadék minden eltalált ellenségnek <b class=p>{d}</b> fizikai sebzést okoz, és 0,5 mp-re a levegőbe dobja.',
        ai: { use: 'cc', range: 8 } },
      { id: 'e', name: 'Kőpajzs', icon: 'stoneshield', kind: 'self', radius: 7, cd: 14, cast: 0, n: { sh: [70, 22, 0, 0, 0.04] },
        desc: 'Kőpajzsot von magára és a legközelebbi szövetségesére (7 m-en belül): 3 mp-ig <b>{sh}</b> sebzést nyel el.',
        ai: { use: 'shield' } },
      { id: 'd', name: 'Dübörgés', icon: 'roar', kind: 'self', radius: 3.6, cd: 16, cast: 0.1, n: {}, taunt: 1.1,
        desc: 'Megdöngeti a pajzsát: a 3,6 m-en belüli ellenségek 1,1 mp-ig csak őt támadhatják. 3 mp-ig 30%-kal kevesebb sebzést kap.',
        ai: { use: 'cc', range: 3.3 } },
      { id: 'f', name: 'Forgószél', icon: 'whirl', kind: 'self', radius: 2.6, cd: 10, cast: 0, n: { d: [12, 4, 0.18] },
        desc: '2 mp-ig pörgeti a kalapácsát, és közben mozoghat: 0,33 mp-enként <b class=p>{d}</b> fizikai sebzés a körülötte állóknak.',
        ai: { use: 'aoe', range: 2.4 } },
      { id: 'r', name: 'Hegyomlás', icon: 'mountain', kind: 'circle', range: 9, radius: 3.6, cd: 75, cast: 0.1, n: { d: [180, 40, 0.8] },
        desc: 'Magasba ugrik, és a kijelölt helyre csapódik: <b class=p>{d}</b> fizikai sebzés és 1 mp-es levegőbe dobás 3,6 m-en belül. Utána 2,5 mp-ig remeg a föld (40% lassítás).',
        ai: { use: 'engage', range: 9 } },
    ],
    build: ['rubin', 'csizma', 'granitvert', 'hasito', 'eletfa', 'verszomj'],
  },
  {
    id: 'parazs', name: 'PARÁZS', title: 'a Lángszövő', role: 'Varázsló', css: '#ff7a2e', hex: 0xff7a2e,
    blurb: 'Tűzvarázslónő. Messziről éget, falat emel, robban, és a végén meteort hív a fejükre.',
    diff: 2, melee: false,
    stats: { hp: 490, hpG: 80, regen: 1.4, regenG: 0.1, ad: 48, adG: 2.6, as: 0.64, asG: 0.016, range: 5.6, armor: 20, armorG: 3.4, mr: 30, mrG: 0.5, ms: 3.35, r: 0.5 },
    attack: { windup: 0.28, proj: 'bolt', pspeed: 13, sound: 'bolt' },
    passives: [
      { name: 'Égés', icon: 'burn', n: { d: [8, 2, 0, 0.08] },
        desc: 'A képességei felgyújtják az ellenséget: 3 mp-ig másodpercenként <b class=m>{d}</b> mágikus sebzés.' },
      { name: 'Túlhevülés', icon: 'overheat', n: {},
        desc: 'Minden 4. képessége túlhevül: 35%-kal nagyobb sebzés, 25%-kal nagyobb terület.' },
    ],
    skills: [
      { id: 'q', name: 'Tűzgolyó', icon: 'fireball', kind: 'line', range: 9.5, width: 0.8, speed: 16, cd: 4, cast: 0.2, n: { d: [70, 22, 0, 0.6] },
        desc: 'Tűzgolyót lő, ami az első eltalált ellenségen felrobban: <b class=m>{d}</b> mágikus sebzés, a körülötte állóknak a fele.',
        ai: { use: 'poke', range: 9.5 } },
      { id: 'w', name: 'Lángfal', icon: 'flamewall', kind: 'wall', range: 8, length: 6, cd: 14, cast: 0.25, n: { d: [30, 8, 0, 0.15] },
        desc: '3,5 mp-ig égő falat emel. Az ellenség benne 0,5 mp-enként <b class=m>{d}</b> mágikus sebzést kap, és 35%-kal lassul. A szövetségesei, akik átmennek rajta, 25%-kal gyorsulnak.',
        ai: { use: 'cc', range: 8 } },
      { id: 'e', name: 'Lángugrás', icon: 'blink', kind: 'blink', range: 5, cd: 12, cast: 0, n: { d: [40, 12, 0, 0.35] },
        desc: 'Lángként átugrik a kijelölt helyre. Az indulásnál és az érkezésnél is robban: <b class=m>{d}</b> mágikus sebzés.',
        ai: { use: 'escape' } },
      { id: 'd', name: 'Izzó kör', icon: 'ring', kind: 'circle', range: 8.5, radius: 2.3, cd: 11, cast: 0.2, n: { d: [80, 25, 0, 0.7] }, stun: 1.1,
        desc: 'A kijelölt helyen 0,8 mp múlva feltör a föld: <b class=m>{d}</b> mágikus sebzés és 1,1 mp kábulás.',
        ai: { use: 'cc', range: 8.5 } },
      { id: 'f', name: 'Lángnyelv', icon: 'breath', kind: 'cone', range: 6, angle: 55, cd: 8, cast: 0.2, n: { d: [60, 20, 0, 0.55] },
        desc: 'Lángot fúj maga elé: <b class=m>{d}</b> mágikus sebzés, és az Égés kétszer annyi ideig tart.',
        ai: { use: 'aoe', range: 5.5 } },
      { id: 'r', name: 'Meteor', icon: 'meteor', kind: 'circle', range: 14, radius: 3.4, cd: 70, cast: 0.35, n: { d: [220, 50, 0, 1.0], g: [25, 6, 0, 0.1] },
        desc: 'Meteort hív: 1,3 mp múlva becsapódik, <b class=m>{d}</b> mágikus sebzés és 0,75 mp levegőbe dobás. A helye 3 mp-ig ég (0,5 mp-enként <b class=m>{g}</b>).',
        ai: { use: 'engage', range: 14 } },
    ],
    build: ['kristaly', 'csizma', 'lang', 'kalap', 'eletfa', 'kopeny'],
  },
  {
    id: 'solyom', name: 'SÓLYOM', title: 'a Vadász', role: 'Lövész', css: '#7bc950', hex: 0x7bc950,
    blurb: 'Íjász a sólymával. Messziről lő, csapdát rak, hátraszaltózik, és egyetlen nyíllal átlövi a pályát.',
    diff: 2, melee: false,
    stats: { hp: 510, hpG: 82, regen: 1.6, regenG: 0.11, ad: 55, adG: 3.0, as: 0.68, asG: 0.028, range: 6.0, armor: 24, armorG: 3.6, mr: 30, mrG: 0.5, ms: 3.4, r: 0.5 },
    attack: { windup: 0.26, proj: 'arrow', pspeed: 20, sound: 'arrow' },
    passives: [
      { name: 'Feszített húr', icon: 'bowstring', n: {},
        desc: 'Minden 4. alaptámadása kritikus: 175% sebzés, és a nyíl átüt a mögötte álló ellenségbe is (50%).' },
      { name: 'Lendület', icon: 'feather', n: {},
        desc: 'Képesség után a következő 2 alaptámadása 60%-kal gyorsabb, és 1,5 mp-ig 20%-kal gyorsabban fut.' },
    ],
    skills: [
      { id: 'q', name: 'Átütő nyíl', icon: 'arrow', kind: 'line', range: 10, width: 0.6, speed: 26, cd: 7, cast: 0.2, n: { d: [55, 18, 0.9] },
        desc: 'Átütő nyilat lő, ami mindenkin áthatol: <b class=p>{d}</b> fizikai sebzés, minden újabb célpontnak 15%-kal kevesebb.',
        ai: { use: 'poke', range: 10 } },
      { id: 'w', name: 'Nyílzápor', icon: 'rain', kind: 'circle', range: 9, radius: 2.6, cd: 10, cast: 0.2, n: { d: [50, 18, 0.6] },
        desc: 'Nyílesőt lő a kijelölt helyre: 0,5 mp múlva <b class=p>{d}</b> fizikai sebzés és 40% lassítás 1,5 mp-ig.',
        ai: { use: 'aoe', range: 9 } },
      { id: 'e', name: 'Vetődés', icon: 'roll', kind: 'dash', range: 3.8, cd: 7, cast: 0, n: { d: [20, 6, 0.4] },
        desc: 'Elvetődik a kurzor felé. A következő alaptámadása azonnal indul, és <b class=p>{d}</b> plusz fizikai sebzést okoz.',
        ai: { use: 'escape' } },
      { id: 'd', name: 'Medvecsapda', icon: 'trap', kind: 'circle', range: 6, radius: 0.9, cd: 12, cast: 0.25, n: { d: [40, 15, 0.4] },
        desc: 'Csapdát rak le (legfeljebb 3). 0,8 mp múlva élesedik, és az ellenség nem látja. Ha hős lép bele: <b class=p>{d}</b> fizikai sebzés, 1,6 mp gyökerezés.',
        ai: { use: 'trap', range: 6 } },
      { id: 'f', name: 'Sólyomroham', icon: 'falcon', kind: 'unit', range: 10, targets: 'enemy', cd: 12, cast: 0.15, n: { d: [50, 16, 0.5] },
        desc: 'Ráküldi a sólymát egy ellenségre: <b class=p>{d}</b> fizikai sebzés, és 4 mp-ig megjelöli: a jelölt célpont 12%-kal több sebzést kap Sólyomtól és a társától, és nem tud elbújni.',
        ai: { use: 'mark', range: 10 } },
      { id: 'r', name: 'Viharnyíl', icon: 'storm', kind: 'line', range: 32, width: 1.4, speed: 26, cd: 70, cast: 0.6, n: { d: [180, 40, 1.1] },
        desc: 'Villámmal töltött nyilat lő át a pályán. Az első eltalált hős <b class=p>{d}</b> fizikai sebzést kap és elkábul; minél messzebbről jön, annál nagyobbat üt (legfeljebb +50%) és annál tovább kábít (1–2 mp). Az útjába eső minionok a felét kapják.',
        ai: { use: 'execute', range: 30 } },
    ],
    build: ['kard', 'tor', 'viharij', 'verszomj', 'csizma', 'hasito'],
  },
  {
    id: 'arny', name: 'ÁRNY', title: 'az Orgyilkos', role: 'Orgyilkos', css: '#a678ff', hex: 0xa678ff,
    blurb: 'Kétpengés orgyilkos. Füstbe bújik, árnyékként lép, hasonmást küld, és ha egy hős elesik, minden képessége újratöltődik.',
    diff: 3, melee: true,
    stats: { hp: 585, hpG: 90, regen: 2.0, regenG: 0.14, ad: 65, adG: 3.6, as: 0.7, asG: 0.026, range: 1.8, armor: 30, armorG: 4.0, mr: 30, mrG: 1.0, ms: 3.6, r: 0.5 },
    attack: { windup: 0.25, sound: 'dagger' },
    passives: [
      { name: 'Árnyjel', icon: 'mark', n: { d: [35, 12, 0.4] },
        desc: 'A képességei 5 mp-re megjelölik az ellenséget. A következő alaptámadása a jelölt célponton felrobbantja a jelet: <b class=m>{d}</b> mágikus sebzés.' },
      { name: 'Kivégzés', icon: 'skull', n: {},
        desc: 'Ha egy ellenséges hős meghal, és 3 mp-en belül megsebezte, minden képessége (a végső kivételével) újratöltődik, és 2 mp-ig 30%-kal gyorsabb.' },
    ],
    skills: [
      { id: 'q', name: 'Pengedobás', icon: 'dagger', kind: 'line', range: 8.5, width: 0.6, speed: 20, cd: 5, cast: 0.15, n: { d: [65, 22, 0.8] },
        desc: 'Tőrt dob: az első eltalált ellenség <b class=p>{d}</b> fizikai sebzést kap, 1,5 mp-ig 30%-kal lassul, és megjelölődik.',
        ai: { use: 'poke', range: 8.5 } },
      { id: 'w', name: 'Füstbomba', icon: 'smoke', kind: 'self', radius: 3, cd: 18, cast: 0, n: {},
        desc: 'Füstfelhőt robbant maga körül 3,5 mp-ig. A füstben láthatatlan, és 25%-kal gyorsabb. Ha támad, egy pillanatra előbukkan.',
        ai: { use: 'escape' } },
      { id: 'e', name: 'Árnylépés', icon: 'step', kind: 'unit', range: 6.5, targets: 'any', cd: 9, cast: 0, n: { d: [40, 14, 0.6] },
        desc: 'Bármelyik egység mögé lép (szövetségeséhez is). Ha ellenség: <b class=p>{d}</b> fizikai sebzés és jelölés.',
        ai: { use: 'engage', range: 6.5 } },
      { id: 'd', name: 'Pengevihar', icon: 'blades', kind: 'self', radius: 2.6, cd: 7, cast: 0, n: { d: [50, 17, 0.7] },
        desc: 'Megpördül a két pengéjével: <b class=p>{d}</b> fizikai sebzés körben, mindenkit megjelöl. A hősöknek okozott sebzés 25%-át visszagyógyítja.',
        ai: { use: 'aoe', range: 2.4 } },
      { id: 'f', name: 'Árnykép', icon: 'clone', kind: 'dash', range: 6, cd: 20, cast: 0, n: {},
        desc: 'Hasonmása a kurzor felé fut, ő maga 1,5 mp-re láthatatlan lesz, és 40%-kal gyorsabb. A hasonmás egy ütéstől szétfoszlik.',
        ai: { use: 'escape' } },
      { id: 'r', name: 'Holdtánc', icon: 'moon', kind: 'unit', range: 6.5, targets: 'hero', cd: 60, cast: 0, n: { d: [35, 9, 0.35] },
        desc: 'Egy ellenséges hős köré táncol, és 1,25 mp alatt ötször lecsap rá: csapásonként <b class=p>{d}</b> fizikai sebzés, az utolsó plusz a célpont hiányzó életerejének 15%-a. Közben nem lehet megsebezni.',
        ai: { use: 'execute', range: 6.5 } },
    ],
    build: ['kard', 'csizma', 'holdtor', 'hasito', 'verszomj', 'granitvert'],
  },
];
export const heroIndex = (id) => HEROES.findIndex((h) => h.id === id);

// What the stat abbreviations mean in tooltips
export const STAT_NAMES = {
  ad: 'VE', ap: 'VA', hp: 'ÉLET', armor: 'PÁNCÉL', mr: 'MÁGIAV.', ms: 'SEB.', as: 'TÁMADÁSI SEB.', cdr: 'VISSZATÖLTÉS', ls: 'ÉLETLOPÁS', pen: 'PÁNCÉLÁTÜTÉS', regen: 'REGEN.', thorns: 'VISSZAVERÉS', apMul: 'VA SZORZÓ',
};

export const DIFFS = [
  { id: 'easy', name: 'Könnyű', aim: 1.1, react: 0.55, dodge: 0.1, lastHit: 0.55, retreat: 0.2, aggr: 0.75, ult: 0.4 },
  { id: 'normal', name: 'Normál', aim: 0.55, react: 0.32, dodge: 0.35, lastHit: 0.8, retreat: 0.28, aggr: 1.0, ult: 0.8 },
  { id: 'hard', name: 'Nehéz', aim: 0.22, react: 0.16, dodge: 0.65, lastHit: 0.95, retreat: 0.32, aggr: 1.15, ult: 1.0 },
];
