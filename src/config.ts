// Shared tuning constants. Everything balance-related lives here.

export const APP_ID = 'blockshot-ctf-v1'

// World (voxel grid). One voxel is VOXEL metres; the map is centred on x/z = 0.
export const VOXEL = 0.5
export const WORLD_X = 48
export const WORLD_Y = 80
export const WORLD_Z = 208
export const CHUNK = 16
export const KILL_Y = -6 // falling below this (metres) kills you

// Teams: 0 = red, 1 = blue
export const TEAM_COLORS = [0xff3b3b, 0x3b8bff]
export const TEAM_NAMES = ['PIROS', 'KÉK']
export const TEAM_SIZE = 4
export const BOT_NAMES = ['Vas', 'Kobalt', 'Szikra', 'Titán', 'Bazalt', 'Neon', 'Ónix', 'Rozsda']
export const BOT_DAMAGE = 0.6 // bots hit softer than humans so fights last a bit longer

// Match (capture the flag)
export const CAPS_TO_WIN = 3
export const MATCH_TIME = 600
export const RESPAWN_TIME = 3
export const SPAWN_PROTECT = 2
export const FLAG_RETURN_TIME = 20
export const FLAG_TOUCH = 1.4

// Player
export const MAX_HP = 100
export const MAX_ARMOR = 100
export const ARMOR_ABSORB = 0.6
export const MOVE_SPEED = 7.5
export const JUMP_SPEED = 7.2
export const GRAVITY = 22
export const EYE_HEIGHT = 1.6
export const PLAYER_RADIUS = 0.32
export const PLAYER_HEIGHT = 1.75
export const STEP_HEIGHT = 0.55
export const JUMP_PAD_SPEED = 18.8

// Weapons. index = slot (keys 1-5)
export interface WeaponDef {
  id: string
  name: string
  dmg: number // per pellet (hitscan) or max splash (rocket)
  headMul: number
  pellets: number
  spread: number // radians (hip fire)
  interval: number // seconds between shots
  mag: number
  reload: number
  auto: boolean
  pickupAmmo: number // reserve ammo given by a pickup / spawn
  range: number
  recoil: number
  color: number
}

export const WEAPONS: WeaponDef[] = [
  { id: 'pistol', name: 'PISZTOLY', dmg: 28, headMul: 2, pellets: 1, spread: 0.006, interval: 0.25, mag: 12, reload: 1.1, auto: false, pickupAmmo: Infinity, range: 150, recoil: 0.012, color: 0x22e6ff },
  { id: 'rifle', name: 'GÉPKARABÉLY', dmg: 15, headMul: 2, pellets: 1, spread: 0.014, interval: 0.09, mag: 30, reload: 1.7, auto: true, pickupAmmo: 90, range: 150, recoil: 0.007, color: 0x4dff7a },
  { id: 'shotgun', name: 'SÖRÉTES', dmg: 12, headMul: 1.5, pellets: 10, spread: 0.08, interval: 0.85, mag: 6, reload: 1.6, auto: false, pickupAmmo: 18, range: 45, recoil: 0.05, color: 0xff9a3d },
  { id: 'rocket', name: 'RAKÉTAVETŐ', dmg: 110, headMul: 1, pellets: 1, spread: 0, interval: 0.9, mag: 1, reload: 0.9, auto: false, pickupAmmo: 6, range: 250, recoil: 0.06, color: 0xffe14a },
  { id: 'sniper', name: 'MESTERLÖVÉSZ', dmg: 75, headMul: 2.5, pellets: 1, spread: 0.035, interval: 1.3, mag: 5, reload: 2.0, auto: false, pickupAmmo: 15, range: 300, recoil: 0.06, color: 0xb06bff },
]
export const SNIPER_ZOOM_SPREAD = 0.0005
export const ZOOM_FOV = 22

export const ROCKET_SPEED = 28
export const ROCKET_RADIUS = 3.5 // splash radius (m)
export const ROCKET_HOLE = 1.6 // destructible voxels removed within this radius (m)
export const ROCKET_SELF_DAMAGE = 0.5
export const ROCKET_PUSH = 13

// Pickups
export type ItemKind = 'health' | 'armor' | 'shotgun' | 'rocket' | 'sniper'
export const ITEM_RESPAWN: Record<ItemKind, number> = {
  health: 15,
  armor: 25,
  shotgun: 20,
  rocket: 30,
  sniper: 25,
}
