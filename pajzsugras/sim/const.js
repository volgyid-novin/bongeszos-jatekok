// All tuning of the PAJZSUGRÁS simulation, in one place. Y up, metres, seconds; yaw/pitch in radians inside the sim.
// Changing a number here (or the movement/collision code) changes the physics: bump SIM_VER. SIM_VER is part of the
// map hash, so stored global times for the old physics disappear instead of being compared with the new ones.
export const SIM_VER = 3;   // 3: the double jump always sets vy = DJ_V and a wall dodge gives it back; the wall dodge always sets vy = DODGE_Y and reaches further, and closes the jump / shield combo windows

export const TICK = 120;            // fixed simulation rate (Hz)
export const DT = 1 / TICK;

// movement
export const G = 19;                // gravity, m/s²
export const RUN = 8.8;             // run speed, m/s
export const ACCEL = 41;            // ground acceleration, m/s²
export const FRICTION = 8;          // ground friction (Q3 style), also the bleed above RUN
export const STOP = 2.5;            // Q3 stopspeed: friction never works on less than this (snappy stop)
export const AIR_CONTROL = 0.35;    // UT air control: in the air the wish direction accelerates at AIR_CONTROL · ACCEL, but never past max(speed, RUN)
export const JUMP_V = 6.8;          // ground jump, m/s up
export const DJ_V = 7.3;            // double jump: a Space press in the air SETS vy to this, once per airtime (a wall dodge gives it back); no timing window, but a press while vy is already above it is ignored (it would cut a shield / pad / lift launch short)
export const DODGE_XY = 13.2;       // dodge speed along the dodge direction
export const DODGE_Y = 4.2;         // dodge hop
export const WALL_RANGE = 0.64;     // wall dodge: a wall within this distance of the hull, behind the dodge or to its sides (UT: 32 UU)
export const WALL_NY = 0.3;         // ... and |normal.y| below this counts as a wall
export const DODGE_CD = 0.35;       // s after landing from a dodge before the next ground dodge
export const DODGE_JUMP_TICKS = 8;  // jump and dodge this close together (either order, ~67 ms) = the diagonal jump: the double jump comes at the apex
export const STEP = 0.35;           // max step height (the up-trace gets 0.02 slack)
export const STEP_SLACK = 0.02;
export const MIN_WALK_NY = 0.7;     // steepest walkable slope: 45.57°
export const GROUND_D = 0.06;       // ground probe distance
export const NOSNAP = 0.1;          // s after an upward launch during which ground contact is ignored
export const VMAX = 60;             // speed clamp, m/s
export const FASTEST_XZ = 30;       // the horizontal speed no run reaches without a pad or a mover (shield, dodge and diagonal-jump chains top out near 20): the leaderboard's geometric floor (world.js routeFloor)
export const OVERCLIP = 1.001;
export const DIST_EPS = 0.001;      // trace pull-back from surfaces

// shield gun
export const CHARGE_T = 1.2;        // s from 0 to 100 %
export const SH_IMIN = 2.5;         // impulse of a tap, m/s
export const SH_IMAX = 9.0;         // impulse of a full charge
export const SH_RANGE = 2.4;        // blast ray length from the eye
export const SH_LOCK = 0.2;         // s after a blast in which the gun is dead
export const COMBO_TICKS = 10;      // jump and release this close together (either order) stack

// player hull: an upright box, origin at the feet
export const HULL_HX = 0.4;         // half width (x and z)
export const HULL_H = 1.76;         // height
export const HULL_HY = HULL_H / 2;
export const EYE = 1.6;

export const PAD_CD = 0.3;          // s after a jump pad in which it does not fire again
export const GHOST_EVERY = 6;       // ghost sample interval in ticks (20 Hz)

// medals: multiples of the author time (the proof route), ceil to 0.1 s
export const MEDAL_GOLD = 1.15, MEDAL_SILVER = 1.4, MEDAL_BRONZE = 1.9;

// cmd.dodge
export const DODGE = { NONE: 0, F: 1, B: 2, L: 3, R: 4 };

// player flags bitmask (World.playerFlags())
// WALL (64) is for the picture only: the wall dodge of this airtime is used (World.playerFlags adds it; ps.flags, and so stateHash, do not have it)
export const FLAG = { GROUND: 1, CHARGE: 2, FINISHED: 4, BLAST: 8, DODGING: 16, DJ_USED: 32, WALL: 64 };

export const ticks = (s) => Math.round(s * TICK);
