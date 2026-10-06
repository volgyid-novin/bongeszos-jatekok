import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import {
  BOT_DAMAGE, BOT_NAMES, CAPS_TO_WIN, KILL_Y, MATCH_TIME, MAX_ARMOR, MAX_HP, RESPAWN_TIME, ROCKET_HOLE, ROCKET_SPEED,
  SNIPER_ZOOM_SPREAD, SPAWN_PROTECT, TEAM_COLORS, TEAM_NAMES, TEAM_SIZE, WEAPONS, ZOOM_FOV, type WeaponDef,
} from '../config'
import type { EntityState, Link, Msgs, Vec3 } from '../net/protocol'
import { settings } from '../settings'
import { esc, Hud, teamSpan, type Marker } from '../ui/hud'
import type { RoundResult } from '../ui/lobby'
import { sfx } from './audio'
import { Avatar } from './avatar'
import { BotBrain, roleFor, type BotEnv } from './bot'
import { applyDamage, splash } from './combat'
import { AT_BASE, CARRIED, Flags, type FlagEvent } from './ctf'
import { Effects } from './effects'
import { chest, Entity, hitboxes } from './entity'
import { Items, weaponSlotOf } from './items'
import { buildMap, FLAG_BASES, SPAWNS, spawnFor, spawnYaw } from './mapgen'
import { Body } from './player'
import { buildScenery } from './scenery'
import { Arsenal, Loadout } from './weapons'
import { blockColor, VoxelWorld } from './world'

type Phase = 'menu' | 'countdown' | 'playing' | 'over'

export interface MatchSetup {
  side: number // our team
  myName: string
  oppName: string
  solo: boolean // practice: every bot runs locally
}

const SENSITIVITY = 0.0022
const BASE_FOV = 80
const ROCKET_LIFE = 6

interface Rocket {
  owner: number
  id: number
  local: boolean
  mesh: THREE.Mesh
  pos: THREE.Vector3
  vel: THREE.Vector3
  life: number
  trail: number
}

export class Game {
  onRoundOver?: (r: RoundResult) => void

  private renderer: THREE.WebGLRenderer
  private composer: EffectComposer
  private scene = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private world: VoxelWorld
  private scenery: ReturnType<typeof buildScenery>
  private items: Items
  private flags: Flags
  private avatars: Avatar[] = []
  private body: Body
  private arsenal = new Arsenal()
  private fx: Effects
  private hud = new Hud()

  private link: Link | null = null
  private phase: Phase = 'menu'
  private setup: MatchSetup = { side: 0, myName: '', oppName: '', solo: true }
  private ents: Entity[] = []
  private me!: Entity
  private botEnv!: BotEnv
  private now = 0
  private countdown = 0
  private lastCount = 0
  private stats = { shots: 0, hits: 0, heads: 0 }
  private killerText = ''

  private rockets: Rocket[] = []
  private rocketSeq = 0
  private rocketGeo = new THREE.BoxGeometry(0.12, 0.12, 0.38)

  private keys = new Set<string>()
  private firing = false
  private locked = false
  private freeAim = false
  private cursor = new THREE.Vector2()
  private cursorIn = false
  private lastWheel = 0
  private shake = 0
  private stTimer = 0
  private t = 0
  private clock = new THREE.Clock()

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(window.innerWidth, window.innerHeight)
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.1
    container.prepend(this.renderer.domElement)

    this.camera = new THREE.PerspectiveCamera(BASE_FOV, window.innerWidth / window.innerHeight, 0.05, 5000)
    this.camera.rotation.order = 'YXZ'
    this.camera.add(this.arsenal.viewmodel)
    this.scene.add(this.camera)

    this.scenery = buildScenery(this.scene)
    this.world = new VoxelWorld(this.scene)
    buildMap(this.world)
    this.world.update()
    this.items = new Items(this.scene)
    this.flags = new Flags(this.scene)
    for (let i = 0; i < TEAM_SIZE * 2; i++) this.avatars.push(new Avatar(this.scene))
    this.fx = new Effects(this.scene)
    this.body = new Body(this.world)
    this.body.onJumpPad = () => sfx.jumpPad()
    this.body.onLand = (v) => v > 9 && sfx.land(v)
    this.arsenal.onReloaded = () => sfx.reload()
    this.arsenal.viewmodel.visible = false

    this.composer = new EffectComposer(this.renderer)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.5, 0.4, 0.78))
    this.composer.addPass(new OutputPass())

    this.flags.onEvent = (ev) => this.onFlagEvent(ev)
    this.bindInput()
    window.addEventListener('resize', () => this.resize())
    this.renderer.setAnimationLoop(() => this.frame())
    ;(window as unknown as { __game: Game }).__game = this
  }

  private get isHost() {
    return this.setup.solo || !this.link || this.link.isHost
  }

  // ---- session ------------------------------------------------------------------

  attach(link: Link | null) {
    this.link = link
    if (!link) return
    link.on('st', (d) => this.onState(d.e))
    link.on('shot', (d) => this.onRemoteShot(d))
    link.on('hit', (d) => {
      const t = this.ents[d.t]
      if (this.phase === 'playing' && t?.local) this.applyHit(t, d.dmg, d.head, new THREE.Vector3(...d.d), d.a)
    })
    link.on('rocket', (d) => {
      if (this.phase === 'menu') return
      this.spawnRocket(d.a, d.id, false, new THREE.Vector3(...d.o), new THREE.Vector3(...d.d))
      this.ents[d.a]?.avatar?.flash()
      sfx.shoot(3, this.distVolume(new THREE.Vector3(...d.o)))
    })
    link.on('boom', (d) => {
      if (this.phase === 'menu') return
      const r = this.rockets.find((x) => !x.local && x.owner === d.a && x.id === d.id)
      if (r) this.removeRocket(r)
      this.explode(new THREE.Vector3(...d.p), d.a)
    })
    link.on('died', (d) => {
      const v = this.ents[d.v]
      if (this.phase !== 'playing' || !v || v.local) return
      this.onDeath(d.v, d.k, new THREE.Vector3(...d.p))
    })
    link.on('take', (d) => this.items.take(d.id, this.now))
    link.on('flag', (d) => {
      if (this.phase === 'menu' || this.isHost) return
      this.flags.apply(d.f, d.c, d.ev)
    })
    link.on('end', (d) => {
      if (this.phase !== 'playing' && this.phase !== 'countdown') return
      this.flags.caps = [d.c[0], d.c[1]]
      this.endRound()
    })
  }

  startRound(setup: MatchSetup) {
    this.setup = setup
    this.now = 0
    this.stats = { shots: 0, hits: 0, heads: 0 }
    for (const r of [...this.rockets]) this.removeRocket(r)
    this.world.data.fill(0)
    buildMap(this.world)
    this.world.update()
    this.items.reset()
    this.flags.reset()
    this.flags.onChange = this.isHost
      ? (ev) => {
          this.link?.send('flag', { f: this.flags.serialize(), c: this.flags.caps, ev: this.flags.serializeEvent(ev) })
          if (ev?.kind === 'captured' && Math.max(...this.flags.caps) >= CAPS_TO_WIN) this.finishMatch()
        }
      : undefined

    // 8 players: team 0 ids 0-3, team 1 ids 4-7; slot 0 of each team is a human (unless practice)
    this.ents = []
    for (let team = 0; team < 2; team++) {
      for (let k = 0; k < TEAM_SIZE; k++) {
        const id = team * TEAM_SIZE + k
        const mine = team === setup.side
        const human = k === 0 && (mine || !setup.solo)
        const local = setup.solo || mine
        const name = human ? (mine ? setup.myName : setup.oppName) : BOT_NAMES[id]
        const e = new Entity(id, team, name, !human, local)
        if (human && mine) {
          e.body = this.body
          e.loadout = this.arsenal
          this.me = e
        } else {
          e.avatar = this.avatars[id]
          e.avatar.setIdentity(name, TEAM_COLORS[team], team === setup.side)
          e.avatar.setFlag(-1)
          if (local) {
            e.body = new Body(this.world)
            e.loadout = new Loadout()
            e.loadout.onSwitch = (slot) => e.avatar?.setWeapon(slot)
            e.brain = new BotBrain(roleFor(k - (setup.solo && !mine ? 0 : 1), !(setup.solo && !mine)))
          }
        }
        this.ents.push(e)
      }
    }
    this.avatars[this.me.id].alive = false
    this.botEnv = {
      world: this.world,
      ents: this.ents,
      flags: this.flags,
      isAlive: (e) => e.alive,
      isProtected: (e) => this.now < e.protUntil,
      fire: (b, d) => this.fireWeapon(b, b.body!.eye(), d),
    }
    for (const e of this.ents) {
      const k = e.id % TEAM_SIZE
      if (e.local) this.spawnLocal(e, k)
      else {
        const p = SPAWNS[e.team][k].clone()
        e.netPos.copy(p)
        e.alive = true
        e.avatar!.place(p, spawnYaw(e.team))
        e.avatar!.alive = true
      }
    }

    this.hud.show(true)
    this.hud.setMyTeam(setup.side)
    this.hud.setCaps([0, 0])
    this.hud.setTimer(MATCH_TIME)
    this.hud.setDead(false)
    this.phase = 'countdown'
    this.countdown = 3
    this.lastCount = 4
    this.requestLock()
  }

  abort() {
    if (this.phase === 'menu') return
    this.phase = 'menu'
    this.hud.show(false)
    this.hud.clearBig()
    for (const a of this.avatars) a.alive = false
    this.arsenal.hidden = true
    this.arsenal.zoomed = false
    this.arsenal.viewmodel.visible = false
    this.firing = false
    document.exitPointerLock?.()
  }

  // host decides when the match is over
  private finishMatch() {
    if (!this.isHost) return
    this.link?.send('end', { c: this.flags.caps })
    this.endRound()
  }

  private endRound() {
    if (this.phase !== 'playing' && this.phase !== 'countdown') return
    this.phase = 'over'
    this.firing = false
    this.arsenal.zoomed = false
    this.hud.setDead(false)
    this.hud.setScope(false)
    const mine = this.flags.caps[this.me.team]
    const theirs = this.flags.caps[1 - this.me.team]
    const outcome: RoundResult['outcome'] = mine > theirs ? 'win' : mine < theirs ? 'lose' : 'draw'
    this.hud.big(outcome === 'win' ? 'GYŐZELEM!' : outcome === 'lose' ? 'VERESÉG' : 'DÖNTETLEN', outcome)
    if (outcome === 'win') sfx.win()
    else sfx.lose()
    const result: RoundResult = {
      outcome,
      myCaps: mine,
      oppCaps: theirs,
      kills: this.me.kills,
      deaths: this.me.deaths,
      caps: this.me.caps,
      shots: this.stats.shots,
      hits: this.stats.hits,
      heads: this.stats.heads,
      time: this.now,
    }
    setTimeout(() => {
      if (this.phase !== 'over') return
      document.exitPointerLock?.()
      this.hud.clearBig()
      this.onRoundOver?.(result)
    }, 2500)
  }

  // ---- spawning, damage, death --------------------------------------------------------

  private spawnLocal(e: Entity, slot?: number) {
    const list = SPAWNS[e.team]
    const p = slot !== undefined ? list[slot % list.length].clone() : spawnFor(e.team)
    e.body!.place(p, spawnYaw(e.team))
    e.vit = { hp: MAX_HP, armor: 0 }
    e.loadout!.reset()
    e.alive = true
    e.protUntil = slot !== undefined ? 0 : this.now + SPAWN_PROTECT
    e.brain?.reset()
    if (e === this.me) {
      this.arsenal.hidden = false
      if (slot === undefined) sfx.spawn()
    }
    if (e.avatar) {
      e.avatar.place(p, spawnYaw(e.team))
      e.avatar.alive = true
      e.avatar.setWeapon(e.loadout!.current)
    }
  }

  private deliverHit(att: Entity, tgt: Entity, dmg: number, head: boolean, dir: THREE.Vector3) {
    if (tgt.local) this.applyHit(tgt, dmg, head ? 1 : 0, dir, att.id)
    else {
      this.link?.send('hit', { t: tgt.id, a: att.id, dmg: Math.round(dmg), head: head ? 1 : 0, d: v3(dir) })
      tgt.avatar?.hurt()
    }
  }

  private applyHit(tgt: Entity, dmg: number, head: number, dir: THREE.Vector3, attackerId: number) {
    if (!tgt.alive || this.now < tgt.protUntil) return
    const att = this.ents[attackerId]
    if (att && att.team === tgt.team && att !== tgt) return // no friendly fire
    const dead = applyDamage(tgt.vit, dmg)
    if (tgt === this.me) {
      this.hud.damage(Math.atan2(dir.x, dir.z))
      sfx.hurt()
      this.shake = Math.max(this.shake, head ? 0.5 : 0.3)
    } else {
      tgt.avatar?.hurt()
      if (att) tgt.brain?.onHurt(att)
    }
    tgt.body!.vel.x += dir.x * 1.5
    tgt.body!.vel.z += dir.z * 1.5
    if (dead) this.killLocal(tgt, attackerId)
  }

  private killLocal(e: Entity, killer: number) {
    if (!e.alive) return
    e.alive = false
    e.respawnT = RESPAWN_TIME
    const p = e.body!.pos.clone()
    this.link?.send('died', { v: e.id, k: killer, p: v3(p) })
    if (e === this.me) {
      this.arsenal.hidden = true
      this.arsenal.zoomed = false
      this.firing = false
      const k = this.ents[killer]
      this.killerText = killer === -1 ? 'Leestél az aszteroidáról' : killer === e.id ? 'Saját rakéta' : `Lelőtt: ${teamSpan(k.name, k.team)}`
    }
    this.onDeath(e.id, killer, p)
  }

  // shared by local deaths and "died" messages
  private onDeath(v: number, k: number, p: THREE.Vector3) {
    const victim = this.ents[v]
    victim.alive = false
    victim.deaths++
    const killer = k >= 0 ? this.ents[k] : null
    if (killer && k !== v) killer.kills++
    if (victim.avatar) victim.avatar.alive = false
    this.fx.burst(p.clone().add(new THREE.Vector3(0, 1, 0)), TEAM_COLORS[victim.team], 36, 7, 0.2)
    const vn = teamSpan(victim.name, victim.team)
    if (k === -1) this.hud.feed(`${vn} lezuhant`)
    else if (k === v) this.hud.feed(`${vn} felrobbantotta magát`)
    else if (killer) this.hud.feed(`${teamSpan(killer.name, killer.team)} ▸ ${vn}`)
    if (k === this.me.id && v !== this.me.id) {
      this.hud.hitmarker(false, true)
      this.hud.toast(`LELŐTTED: ${victim.name}`, 'good')
      sfx.kill()
    }
    if (v === this.me.id) sfx.death()
    if (this.isHost) this.flags.hostOnDeath(v, p, p.y < KILL_Y + 2)
  }

  // ---- flags ------------------------------------------------------------------------------

  private onFlagEvent(ev: FlagEvent) {
    if (this.phase === 'menu') return
    const fname = `${TEAM_NAMES[ev.team]} ZÁSZLÓ`
    const flagSpan = `<b style="color:#${new THREE.Color(TEAM_COLORS[ev.team]).getHexString()}">${fname.toLowerCase()}</b>`
    const by = ev.by >= 0 ? this.ents[ev.by] : null
    const ours = ev.team === this.me.team
    switch (ev.kind) {
      case 'taken':
        this.hud.feed(`${by ? teamSpan(by.name, by.team) : '?'} elvitte: ${flagSpan}`)
        if (by === this.me) this.hud.toast('NÁLAD A ZÁSZLÓ! VIDD HAZA!', 'good')
        else if (ours) this.hud.toast('ELLOPTÁK A ZÁSZLÓNKAT!', 'bad')
        else this.hud.toast(`${by?.name ?? ''} elvitte az ellenfél zászlaját!`, 'good')
        sfx.flagTaken(!ours)
        break
      case 'dropped':
        this.hud.feed(`Leejtették: ${flagSpan}`)
        this.hud.toast(ours ? 'A ZÁSZLÓNK A FÖLDÖN — HOZD VISSZA!' : 'AZ ELLENFÉL ZÁSZLAJA A FÖLDÖN!', ours ? 'bad' : 'info')
        break
      case 'returned':
        this.hud.feed(`Visszakerült: ${flagSpan}`)
        sfx.flagReturned()
        break
      case 'captured': {
        const scorer = by ? by.team : 1 - ev.team
        this.hud.feed(`${by ? teamSpan(by.name, by.team) : '?'} PONTOT SZERZETT!`)
        this.hud.big(`${TEAM_NAMES[scorer]} PONT!`, scorer === this.me.team ? 'win' : 'lose')
        setTimeout(() => this.phase === 'playing' && this.hud.clearBig(), 1600)
        sfx.flagCaptured(scorer === this.me.team)
        break
      }
    }
  }

  // ---- network in -----------------------------------------------------------------------

  private onState(list: EntityState[]) {
    if (this.phase === 'menu') return
    for (const [id, x, y, z, yaw, pitch, mv, w, alive, prot] of list) {
      const e = this.ents[id]
      if (!e || e.local) continue
      e.netPos.set(x, y, z)
      if (alive && !e.alive) e.avatar!.place(e.netPos, yaw) // respawned: snap
      e.alive = !!alive
      e.protUntil = this.now + prot
      e.weapon = w
      const a = e.avatar!
      a.alive = e.alive
      a.protectedUntil = e.protUntil
      a.setPose([x, y, z], yaw, pitch, mv)
      a.setWeapon(w)
    }
  }

  private onRemoteShot(d: Msgs['shot']) {
    if (this.phase === 'menu') return
    const shooter = this.ents[d.a]
    const from = shooter?.avatar && shooter.alive ? shooter.avatar.muzzleWorld() : new THREE.Vector3(...d.o)
    const color = WEAPONS[d.w]?.color ?? 0xffffff
    for (const e of d.e) {
      const end = new THREE.Vector3(...e)
      this.fx.tracer(from, end, color, d.w === 2 ? 0.018 : d.w === 4 ? 0.05 : 0.03)
      this.fx.burst(end, color, 2, 2, 0.06)
    }
    shooter?.avatar?.flash()
    sfx.shoot(d.w, this.distVolume(from))
  }

  // ---- input --------------------------------------------------------------------------

  private bindInput() {
    const canvas = this.renderer.domElement
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas
      if (!this.locked) {
        this.firing = false
        this.arsenal.zoomed = false
      }
    })
    document.getElementById('lockHint')!.addEventListener('click', () => this.requestLock())
    canvas.addEventListener('mousedown', (e) => {
      sfx.unlock()
      if (this.phase === 'menu' || this.phase === 'over') return
      if (!this.aiming) {
        this.requestLock()
        return
      }
      if (e.button === 0) {
        this.firing = true
        this.tryFire(true)
      } else if (e.button === 2 && this.me.alive && this.arsenal.def.id === 'sniper' && !this.arsenal.busy) {
        this.arsenal.zoomed = true
        sfx.zoom()
      }
    })
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.firing = false
      if (e.button === 2) this.arsenal.zoomed = false
    })
    window.addEventListener('mousemove', (e) => {
      if (this.phase === 'menu') return
      if (this.locked) {
        const zoom = this.arsenal.zoomed ? 0.35 : 1
        if (this.me.alive) this.body.look(e.movementX, e.movementY, SENSITIVITY * settings.sensitivity * zoom)
      } else if (this.freeAim) {
        const r = canvas.getBoundingClientRect()
        this.cursor.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
        this.cursorIn = true
        this.hud.setCrosshair(e.clientX - r.left, e.clientY - r.top)
      }
    })
    canvas.addEventListener('mouseleave', () => (this.cursorIn = false))
    canvas.addEventListener('contextmenu', (e) => e.preventDefault())
    window.addEventListener(
      'wheel',
      (e) => {
        if (!this.aiming || !this.me?.alive || this.phase === 'menu') return
        const now = performance.now()
        if (now - this.lastWheel < 120) return
        this.lastWheel = now
        if (this.arsenal.cycle(e.deltaY > 0 ? 1 : -1)) sfx.switchWeapon()
      },
      { passive: true },
    )
    window.addEventListener('keydown', (e) => this.onKey(e, true))
    window.addEventListener('keyup', (e) => this.onKey(e, false))
    window.addEventListener('blur', () => {
      this.keys.clear()
      this.firing = false
      this.arsenal.zoomed = false
    })
  }

  private get aiming() {
    return this.locked || this.freeAim
  }

  private requestLock() {
    const canvas = this.renderer.domElement
    if (document.pointerLockElement === canvas || this.freeAim) return
    if (!('requestPointerLock' in canvas)) {
      this.enableFreeAim()
      return
    }
    const failed = (e: unknown) => {
      // NotAllowed/Security just means "no user gesture yet"; anything else means we can never grab the mouse
      const name = (e as Error)?.name
      if (name !== 'NotAllowedError' && name !== 'SecurityError') this.enableFreeAim()
    }
    // raw mouse input (no OS acceleration) like a real FPS; fall back if unsupported
    const attempt = (raw: boolean) => {
      try {
        const p = (raw ? canvas.requestPointerLock({ unadjustedMovement: true }) : canvas.requestPointerLock()) as unknown as
          | Promise<void>
          | undefined
        p?.catch?.((e: unknown) => (raw && (e as Error)?.name === 'NotSupportedError' ? attempt(false) : failed(e)))
      } catch (e) {
        if (raw) attempt(false)
        else failed(e)
      }
    }
    attempt(true)
  }

  private enableFreeAim() {
    if (this.freeAim) return
    this.freeAim = true
    document.body.classList.add('freeAim')
    this.hud.toast('Kurzoros célzás: vidd a kurzort a képernyő széle felé a forduláshoz', 'info')
  }

  private onKey(e: KeyboardEvent, down: boolean) {
    if (this.phase === 'menu') return
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return
    const code = e.code
    if (code === 'Space' || code === 'Tab') e.preventDefault()
    if (!down) {
      this.keys.delete(code)
      return
    }
    this.keys.add(code)
    if (e.repeat || !this.me.alive || this.phase === 'over') return
    if (code === 'KeyR') {
      if (this.arsenal.startReload()) sfx.reload()
    } else if (/^Digit[1-5]$/.test(code)) {
      if (this.arsenal.switchTo(Number(code.slice(5)) - 1)) sfx.switchWeapon()
    }
  }

  // ---- shooting -----------------------------------------------------------------------

  private aimRay() {
    this.camera.updateMatrixWorld()
    const origin = this.camera.getWorldPosition(new THREE.Vector3())
    const dir = this.locked
      ? this.camera.getWorldDirection(new THREE.Vector3())
      : new THREE.Vector3(this.cursor.x, this.cursor.y, 0.5).unproject(this.camera).sub(origin).normalize()
    return { origin, dir }
  }

  private tryFire(click = false) {
    if (this.phase !== 'playing' || !this.me.alive || !this.aiming) return
    const def = this.arsenal.def
    if (!def.auto && !click) return
    if (!this.arsenal.canFire()) {
      if (click && this.arsenal.state.mag <= 0 && !this.arsenal.busy) sfx.empty()
      return
    }
    const { origin, dir } = this.aimRay()
    this.fireWeapon(this.me, origin, dir)
  }

  private fireWeapon(e: Entity, origin: THREE.Vector3, dir: THREE.Vector3) {
    const lo = e.loadout!
    const def = lo.def
    const slot = lo.current
    lo.fire()
    if (e === this.me) {
      this.stats.shots++
      sfx.shoot(slot)
      this.body.pitch = Math.min(1.5, this.body.pitch + def.recoil * (this.arsenal.zoomed ? 0.4 : 1))
    } else {
      e.avatar?.flash()
      sfx.shoot(slot, this.distVolume(origin))
    }
    if (def.id === 'rocket') this.fireRocket(e, origin, dir)
    else this.fireHitscan(e, origin, dir, def, slot)
  }

  private fireHitscan(e: Entity, origin: THREE.Vector3, base: THREE.Vector3, def: WeaponDef, slot: number) {
    const mine = e === this.me
    const muzzle = mine ? this.arsenal.muzzleWorld() : (e.avatar?.muzzleWorld() ?? origin.clone())
    let spread = def.id === 'sniper' && mine && this.arsenal.zoomed ? SNIPER_ZOOM_SPREAD : def.spread
    if (!e.body!.onGround) spread += 0.015
    const targets = this.ents.filter((t) => t.team !== e.team && t.alive).map((t) => ({ t, boxes: hitboxes(t) }))
    const dealt = new Map<Entity, { dmg: number; head: boolean }>()
    const ends: Vec3[] = []
    for (let i = 0; i < def.pellets; i++) {
      const dir = coneDir(base, spread)
      const ray = new THREE.Ray(origin, dir)
      const wh = this.world.raycast(origin, dir, def.range)
      let best = wh ? wh.dist : def.range
      let hit: { t: Entity; head: boolean } | null = null
      for (const { t, boxes } of targets) {
        const ph = ray.intersectBox(boxes.head, new THREE.Vector3())
        const pb = ray.intersectBox(boxes.body, new THREE.Vector3())
        const dh = ph ? ph.distanceTo(origin) : Infinity
        const db = pb ? pb.distanceTo(origin) : Infinity
        const d = Math.min(dh, db)
        if (d < best) {
          best = d
          hit = { t, head: dh <= db }
        }
      }
      const end = origin.clone().addScaledVector(dir, best)
      if (hit) {
        if (this.now >= hit.t.protUntil) {
          const prev = dealt.get(hit.t) ?? { dmg: 0, head: false }
          prev.dmg += def.dmg * (hit.head ? def.headMul : 1) * (e.bot ? BOT_DAMAGE : 1)
          prev.head ||= hit.head
          dealt.set(hit.t, prev)
        }
        this.fx.burst(end, TEAM_COLORS[hit.t.team], 4, 4, 0.08)
      } else if (wh) {
        this.fx.burst(wh.point.clone().addScaledVector(wh.normal, 0.05), blockColor(this.world.get(...wh.voxel)), 3, 3, 0.07)
      }
      ends.push(v3(end))
      this.fx.tracer(muzzle, end, def.color, def.id === 'shotgun' ? 0.018 : def.id === 'sniper' ? 0.05 : 0.03)
    }
    this.link?.send('shot', { a: e.id, o: v3(muzzle), e: ends, w: slot })
    for (const [t, { dmg, head }] of dealt) {
      this.deliverHit(e, t, dmg, head, base)
      if (mine) {
        this.hud.hitmarker(head)
        sfx.hit(head)
        this.stats.hits++
        if (head) this.stats.heads++
      }
    }
  }

  private fireRocket(e: Entity, origin: THREE.Vector3, dir: THREE.Vector3) {
    const id = ++this.rocketSeq
    const start = origin.clone().addScaledVector(dir, 0.5)
    this.spawnRocket(e.id, id, true, start, dir)
    this.link?.send('rocket', { a: e.id, id, o: v3(start), d: v3(dir) })
  }

  private spawnRocket(owner: number, id: number, local: boolean, pos: THREE.Vector3, dir: THREE.Vector3) {
    const mesh = new THREE.Mesh(this.rocketGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffe14a).multiplyScalar(2) }))
    mesh.position.copy(pos)
    mesh.lookAt(pos.clone().add(dir))
    this.scene.add(mesh)
    this.rockets.push({ owner, id, local, mesh, pos: pos.clone(), vel: dir.clone().normalize().multiplyScalar(ROCKET_SPEED), life: ROCKET_LIFE, trail: 0 })
  }

  private removeRocket(r: Rocket) {
    this.scene.remove(r.mesh)
    ;(r.mesh.material as THREE.Material).dispose()
    this.rockets = this.rockets.filter((x) => x !== r)
  }

  private updateRockets(dt: number) {
    for (const r of [...this.rockets]) {
      r.life -= dt
      const step = r.vel.length() * dt
      const dir = r.vel.clone().normalize()
      let hitAt: THREE.Vector3 | null = null
      const wh = this.world.raycast(r.pos, dir, step)
      if (wh) hitAt = wh.point.clone().addScaledVector(wh.normal, 0.1)
      if (r.local) {
        const ownerTeam = this.ents[r.owner]?.team
        const ray = new THREE.Ray(r.pos, dir)
        for (const t of this.ents) {
          if (!t.alive || t.team === ownerTeam) continue
          const { body, head } = hitboxes(t)
          for (const box of [body, head]) {
            const p = ray.intersectBox(box.expandByScalar(0.15), new THREE.Vector3())
            if (p && p.distanceTo(r.pos) <= step && (!hitAt || p.distanceTo(r.pos) < hitAt.distanceTo(r.pos))) hitAt = p
          }
        }
      }
      if (hitAt || r.life <= 0) {
        if (r.local) {
          const at = hitAt ?? r.pos
          this.removeRocket(r)
          this.link?.send('boom', { a: r.owner, id: r.id, p: v3(at) })
          this.explode(at, r.owner)
        } else {
          r.mesh.visible = false // the owner decides where it blows up
          if (r.life <= 0) this.removeRocket(r)
        }
        continue
      }
      r.pos.addScaledVector(r.vel, dt)
      r.mesh.position.copy(r.pos)
      r.trail -= dt
      if (r.trail <= 0) {
        r.trail = 0.02
        this.fx.burst(r.pos, 0xffa040, 1, 0.6, 0.12)
      }
    }
  }

  private explode(at: THREE.Vector3, ownerId: number) {
    this.fx.explosion(at)
    sfx.explosion(this.distVolume(at))
    this.shake = Math.max(this.shake, Math.max(0, 1 - this.camera.position.distanceTo(at) / 15))
    const removed = this.world.explode(at, ROCKET_HOLE)
    const c = new THREE.Vector3()
    removed.slice(0, 80).forEach((v, i) => {
      if (i % 2 === 0) this.fx.burst(this.world.voxelCenter(v.x, v.y, v.z, c), blockColor(v.v), 1, 6, 0.22)
    })
    if (this.phase !== 'playing') return
    const owner = this.ents[ownerId]
    for (const e of this.ents) {
      if (!e.local || !e.alive || this.now < e.protUntil) continue
      if (owner && e.team === owner.team && e !== owner) continue
      const s = splash(at, e.body!.pos, e === owner)
      if (!s) continue
      e.body!.vel.add(s.push)
      e.body!.onGround = false
      if (owner?.bot) s.dmg = Math.round(s.dmg * BOT_DAMAGE)
      if (s.dmg <= 0) continue
      if (e === this.me) {
        this.hud.damage(e === owner ? null : Math.atan2(e.body!.pos.x - at.x, e.body!.pos.z - at.z))
        sfx.hurt()
      } else if (owner && e !== owner) e.brain?.onHurt(owner)
      if (applyDamage(e.vit, s.dmg)) this.killLocal(e, ownerId)
    }
  }

  // ---- pickups --------------------------------------------------------------------------

  private checkPickups(e: Entity) {
    const it = this.items.touching(e.body!.pos, this.now)
    if (!it) return
    const v = e.vit
    const slot = weaponSlotOf(it.kind)
    let msg = ''
    if (it.kind === 'health') {
      if (v.hp >= MAX_HP) return
      v.hp = Math.min(MAX_HP, v.hp + 25)
      msg = '+25 ÉLET'
    } else if (it.kind === 'armor') {
      if (v.armor >= MAX_ARMOR) return
      v.armor = Math.min(MAX_ARMOR, v.armor + 50)
      msg = '+50 PÁNCÉL'
    } else if (slot !== undefined) {
      msg = e.loadout!.give(slot) ? WEAPONS[slot].name : `${WEAPONS[slot].name} LŐSZER`
    } else return
    this.items.take(it.id, this.now)
    this.link?.send('take', { id: it.id })
    if (e === this.me) {
      this.hud.toast(msg, 'good')
      if (slot !== undefined) sfx.weaponPickup()
      else sfx.pickup()
    }
  }

  // ---- main loop --------------------------------------------------------------------------

  private frame() {
    const dt = Math.min(this.clock.getDelta(), 0.05)
    this.t += dt
    this.link?.update?.(dt)

    if (this.phase === 'menu') {
      const a = this.t * 0.05
      this.camera.position.set(Math.sin(a) * 42, 26 + Math.sin(this.t * 0.2) * 3, Math.cos(a) * 42)
      this.camera.lookAt(0, 9, 0)
      this.items.update(this.t)
      this.flags.render(this.t, dt)
    } else {
      this.updateRound(dt)
    }

    this.world.update()
    for (const a of this.avatars) a.update(dt, this.now)
    this.fx.update(dt)
    this.scenery.update(dt)
    this.composer.render()
  }

  private updateRound(dt: number) {
    const active = this.phase === 'countdown' || this.phase === 'playing'
    const playing = this.phase === 'playing'

    if (this.phase === 'countdown') {
      this.countdown -= dt
      const n = Math.ceil(this.countdown)
      if (n !== this.lastCount && n > 0) {
        this.lastCount = n
        this.hud.big(String(n), 'count')
        sfx.beep()
      }
      if (this.countdown <= 0) {
        this.phase = 'playing'
        this.hud.big('HARC!', 'go')
        setTimeout(() => this.phase === 'playing' && this.hud.clearBig(), 700)
        sfx.beep(true)
      }
    }

    if (playing) {
      this.now += dt
      if (this.firing) this.tryFire()
    }

    // local simulation: our human and our bots
    for (const e of this.ents) {
      if (!e.local) continue
      if (!e.alive) {
        if (playing) {
          e.respawnT -= dt
          if (e.respawnT <= 0) this.spawnLocal(e)
        }
        continue
      }
      let input = { forward: 0, right: 0, jump: false }
      if (playing) {
        if (e === this.me) {
          input = {
            forward: (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0),
            right: (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0),
            jump: this.keys.has('Space'),
          }
        } else if (e.brain) {
          input = e.brain.update(dt, e, this.botEnv)
        }
      }
      e.body!.update(dt, input)
      if (e !== this.me) {
        e.loadout!.tick(dt)
        e.avatar!.sync(e.body!.pos, e.body!.yaw, e.body!.pitch, e.body!.moving)
        e.avatar!.alive = true
        e.avatar!.protectedUntil = e.protUntil
      }
      if (playing) {
        if (e.body!.pos.y < KILL_Y) this.killLocal(e, -1)
        else this.checkPickups(e)
      }
    }
    this.arsenal.update(dt, this.body.moving)
    this.updateRockets(dt)
    this.items.update(this.now)

    if (playing && this.isHost) {
      this.flags.hostUpdate(dt, this.ents, (e) => e.alive)
      if (this.now >= MATCH_TIME) this.finishMatch()
    }
    this.flags.render(this.t, dt)
    for (const e of this.ents) {
      const f = this.flags.carriedBy(e.id)
      e.avatar?.setFlag(f, f >= 0 ? TEAM_COLORS[f] : undefined)
    }

    // cursor-aim fallback: turn when the cursor nears the screen edge
    if (this.freeAim && !this.locked && this.cursorIn && this.me.alive) {
      const edge = (v: number) => (Math.abs(v) < 0.6 ? 0 : Math.sign(v) * ((Math.abs(v) - 0.6) / 0.4))
      this.body.yaw -= edge(this.cursor.x) * 2.6 * dt
      this.body.pitch = Math.max(-1.5, Math.min(1.5, this.body.pitch + edge(this.cursor.y) * 1.6 * dt))
    }

    // camera: while dead, look at whoever killed us (or just stay put)
    this.shake = Math.max(0, this.shake - dt * 2.5)
    const sh = this.shake * this.shake * 0.25
    this.body.eye(this.camera.position)
    this.camera.position.x += (Math.random() - 0.5) * sh
    this.camera.position.y += (Math.random() - 0.5) * sh
    this.camera.rotation.set(this.body.pitch, this.body.yaw, this.me.alive ? 0 : 0.25)
    const fov = this.arsenal.zoomed ? ZOOM_FOV : BASE_FOV
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov += (fov - this.camera.fov) * Math.min(1, dt * 14)
      this.camera.updateProjectionMatrix()
    }

    // HUD
    const me = this.me
    this.hud.setVitals(me.alive ? me.vit.hp : 0, me.alive ? me.vit.armor : 0)
    this.hud.setWeapons(this.arsenal.slots, this.arsenal.current, this.arsenal.reloading, this.arsenal.reloadProgress())
    this.hud.setCaps(this.flags.caps)
    this.hud.setFlags(this.flags.states.map((f) => ({ s: f.s, carrier: f.by >= 0 ? this.ents[f.by].name : '', t: f.t })))
    this.hud.setCarrying(this.flags.carriedBy(me.id))
    this.hud.setTimer(MATCH_TIME - this.now)
    this.hud.setScope(this.arsenal.zoomed)
    this.hud.updateDamageDirs(dt, this.body.yaw)
    this.hud.setDead(!me.alive && playing, this.killerText, me.respawnT)
    this.hud.setLocked(this.aiming, active)
    this.hud.setMarkers(this.markers())
    this.hud.scoreboard(
      this.keys.has('Tab') || this.phase === 'over'
        ? this.ents.map((e) => ({ name: e.name, team: e.team, kills: e.kills, deaths: e.deaths, caps: e.caps, me: e === me, bot: e.bot }))
        : null,
    )

    // network out: our team's state at 20 Hz
    this.stTimer -= dt
    if (this.stTimer <= 0 && this.link) {
      this.stTimer = 0.05
      const e: EntityState[] = this.ents
        .filter((x) => x.local)
        .map((x) => {
          const p = x.body!.pos
          return [x.id, r2(p.x), r2(p.y), r2(p.z), r2(x.body!.yaw), r2(x.body!.pitch), x.body!.moving ? 1 : 0, x.loadout!.current, x.alive ? 1 : 0, Math.max(0, r2(x.protUntil - this.now))]
        })
      this.link.send('st', { e })
    }
  }

  // Objective markers: enemy flag, our flag when it's away, home base while carrying
  private markers(): Marker[] {
    const out: Marker[] = []
    const me = this.me
    const w = window.innerWidth
    const h = window.innerHeight
    const add = (pos: THREE.Vector3, color: number, label: string) => {
      const d = Math.round(this.camera.position.distanceTo(pos))
      const v = pos.clone().project(this.camera)
      let x = ((v.x + 1) / 2) * w
      let y = ((1 - v.y) / 2) * h
      let edge = false
      if (v.z > 1) {
        x = w - x
        y = h - 40
        edge = true
      }
      const m = 40
      if (x < m || x > w - m || y < m + 60 || y > h - m) edge = true
      x = Math.max(m, Math.min(w - m, x))
      y = Math.max(m + 60, Math.min(h - m, y))
      out.push({ x, y, color, text: `${label} ${d}m`, edge })
    }
    const enemy = 1 - me.team
    const carrying = this.flags.carriedBy(me.id) >= 0
    if (!carrying) add(this.flags.position(enemy, this.ents).add(new THREE.Vector3(0, 2.6, 0)), TEAM_COLORS[enemy], 'ZÁSZLÓ')
    const own = this.flags.states[me.team]
    if (own.s !== AT_BASE) add(this.flags.position(me.team, this.ents).add(new THREE.Vector3(0, 2.6, 0)), TEAM_COLORS[me.team], own.s === CARRIED ? 'TOLVAJ' : 'ZÁSZLÓNK')
    if (carrying) add(FLAG_BASES[me.team].clone().add(new THREE.Vector3(0, 2.6, 0)), TEAM_COLORS[me.team], 'HAZA')
    // teammate carrying the enemy flag
    for (const e of this.ents) {
      if (e !== me && e.team === me.team && e.alive && this.flags.carriedBy(e.id) >= 0) add(chest(e).add(new THREE.Vector3(0, 1.2, 0)), 0xffd54a, esc(e.name))
    }
    return out
  }

  private distVolume(p: THREE.Vector3) {
    return Math.max(0.1, 1 - this.camera.position.distanceTo(p) / 60)
  }

  private resize() {
    const w = window.innerWidth
    const h = window.innerHeight
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h)
    this.composer.setSize(w, h)
  }
}

// Random direction inside a cone around `base`
function coneDir(base: THREE.Vector3, spread: number) {
  if (spread <= 0) return base.clone()
  const up = Math.abs(base.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)
  const u = new THREE.Vector3().crossVectors(base, up).normalize()
  const v = new THREE.Vector3().crossVectors(base, u).normalize()
  const r = Math.sqrt(Math.random()) * spread
  const a = Math.random() * Math.PI * 2
  return base.clone().addScaledVector(u, Math.cos(a) * r).addScaledVector(v, Math.sin(a) * r).normalize()
}

function v3(v: THREE.Vector3): Vec3 {
  return [r2(v.x), r2(v.y), r2(v.z)]
}

function r2(n: number) {
  return Math.round(n * 100) / 100
}
