import { CAPS_TO_WIN, MAX_ARMOR, MAX_HP, TEAM_COLORS, TEAM_NAMES, WEAPONS } from '../config'
import type { SlotState } from '../game/weapons'

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const hex = (n: number) => '#' + n.toString(16).padStart(6, '0')

function restart(el: HTMLElement, cls: string) {
  el.classList.remove(cls)
  void el.offsetWidth
  el.classList.add(cls)
}

export function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

export function teamSpan(name: string, team: number) {
  return `<b style="color:${hex(TEAM_COLORS[team])}">${esc(name)}</b>`
}

export interface Marker {
  x: number
  y: number
  color: number
  text: string
  edge: boolean
}

export interface ScoreRow {
  name: string
  team: number
  kills: number
  deaths: number
  caps: number
  me: boolean
  bot: boolean
}

export class Hud {
  private slots: HTMLElement[] = []
  private dmgDirs: { el: HTMLElement; angle: number; t: number }[] = []
  private markerEls: HTMLElement[] = []

  constructor() {
    const bar = $('weaponBar')
    WEAPONS.forEach((w, i) => {
      const el = document.createElement('div')
      el.className = 'wslot'
      el.style.setProperty('--wc', hex(w.color))
      el.innerHTML = `<div class="key">${i + 1}</div><div class="name">${w.name}</div><div class="ammo"></div>`
      bar.appendChild(el)
      this.slots.push(el)
    })
    $('scoreGoal').textContent = `${CAPS_TO_WIN} ZÁSZLÓIG`
    for (const t of [0, 1]) {
      $(`caps${t}`).style.color = hex(TEAM_COLORS[t])
      $(`flagIcon${t}`).style.setProperty('--fc', hex(TEAM_COLORS[t]))
    }
  }

  show(on: boolean) {
    $('hud').classList.toggle('hidden', !on)
  }

  setLocked(locked: boolean, active: boolean) {
    $('lockHint').classList.toggle('hidden', locked || !active)
  }

  setCrosshair(x: number, y: number) {
    for (const id of ['crosshair', 'hitmarker']) {
      const el = $(id)
      el.style.left = `${x}px`
      el.style.top = `${y}px`
    }
  }

  setMyTeam(team: number) {
    $('scoreBar').dataset.me = String(team)
  }

  setCaps(caps: [number, number]) {
    for (const t of [0, 1]) {
      const el = $(`caps${t}`)
      if (el.textContent !== String(caps[t])) {
        el.textContent = String(caps[t])
        restart(el, 'bump')
      }
    }
  }

  // state per flag: 0 at base, 1 carried, 2 dropped
  setFlags(info: { s: number; carrier: string; t: number }[]) {
    info.forEach((f, i) => {
      const icon = $(`flagIcon${i}`)
      icon.dataset.s = String(f.s)
      $(`flagState${i}`).textContent = f.s === 0 ? 'BÁZISON' : f.s === 1 ? f.carrier.toUpperCase() : `LEEJTVE ${Math.ceil(f.t)}`
    })
  }

  setCarrying(team: number) {
    const el = $('carryBanner')
    el.classList.toggle('hidden', team < 0)
    if (team >= 0) el.textContent = `NÁLAD A ${TEAM_NAMES[team]} ZÁSZLÓ — VIDD HAZA!`
  }

  setTimer(secondsLeft: number) {
    const s = Math.max(0, Math.ceil(secondsLeft))
    $('timer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
    $('timer').classList.toggle('low', s <= 60)
  }

  setVitals(hp: number, armor: number) {
    const h = Math.max(0, Math.ceil(hp))
    $('hpVal').textContent = String(h)
    $('armorVal').textContent = String(Math.ceil(armor))
    $('hpFill').style.width = `${Math.min(100, (h / MAX_HP) * 100)}%`
    $('armorFill').style.width = `${Math.min(100, (armor / MAX_ARMOR) * 100)}%`
    $('vitals').classList.toggle('low', h <= 30)
    $('lowHp').classList.toggle('on', h > 0 && h <= 30)
  }

  setWeapons(slots: SlotState[], current: number, reloading: boolean, reloadProgress: number) {
    slots.forEach((s, i) => {
      const el = this.slots[i]
      el.classList.toggle('owned', s.owned)
      el.classList.toggle('active', i === current)
      el.querySelector('.ammo')!.textContent = s.owned ? (s.reserve === Infinity ? '∞' : String(s.mag + s.reserve)) : ''
    })
    const s = slots[current]
    const w = WEAPONS[current]
    $('weaponName').textContent = w.name
    $('weaponName').style.color = hex(w.color)
    $('ammoVal').textContent = String(s.mag)
    $('ammoReserve').textContent = s.reserve === Infinity ? '∞' : String(s.reserve)
    $('ammo').classList.toggle('reloading', reloading)
    $('ammo').classList.toggle('low', !reloading && s.mag <= Math.ceil(w.mag / 4))
    ;($('reloadBar').firstElementChild as HTMLElement).style.width = `${(reloading ? reloadProgress : 1) * 100}%`
  }

  setScope(on: boolean) {
    $('scope').classList.toggle('hidden', !on)
    $('crosshair').classList.toggle('hidden', on)
  }

  setMarkers(list: Marker[]) {
    const box = $('markers')
    while (this.markerEls.length < list.length) {
      const el = document.createElement('div')
      el.className = 'marker'
      el.innerHTML = '<i></i><span></span>'
      box.appendChild(el)
      this.markerEls.push(el)
    }
    this.markerEls.forEach((el, i) => {
      const m = list[i]
      el.style.display = m ? '' : 'none'
      if (!m) return
      el.style.left = `${m.x}px`
      el.style.top = `${m.y}px`
      el.style.setProperty('--mc', hex(m.color))
      el.classList.toggle('edge', m.edge)
      el.querySelector('span')!.textContent = m.text
    })
  }

  scoreboard(rows: ScoreRow[] | null) {
    const el = $('scoreboard')
    el.classList.toggle('hidden', !rows)
    if (!rows) return
    el.innerHTML = [0, 1]
      .map((t) => {
        const body = rows
          .filter((r) => r.team === t)
          .sort((a, b) => b.caps * 10 + b.kills - (a.caps * 10 + a.kills))
          .map((r) => `<tr class="${r.me ? 'me' : ''}"><td>${esc(r.name)}${r.bot ? ' <small>BOT</small>' : ''}</td><td>${r.caps}</td><td>${r.kills}</td><td>${r.deaths}</td></tr>`)
          .join('')
        return `<table style="--tc:${hex(TEAM_COLORS[t])}"><thead><tr><th>${TEAM_NAMES[t]} CSAPAT</th><th>ZÁSZLÓ</th><th>ÖLÉS</th><th>HALÁL</th></tr></thead><tbody>${body}</tbody></table>`
      })
      .join('')
  }

  hitmarker(head = false, kill = false) {
    const el = $('hitmarker')
    el.classList.toggle('head', head)
    el.classList.toggle('kill', kill)
    restart(el, 'on')
  }

  damage(angle: number | null) {
    restart($('damage'), 'on')
    if (angle === null) return
    const el = document.createElement('div')
    el.className = 'dmgDir'
    $('hud').appendChild(el)
    this.dmgDirs.push({ el, angle, t: 1 })
  }

  updateDamageDirs(dt: number, yaw: number) {
    this.dmgDirs = this.dmgDirs.filter((d) => {
      d.t -= dt
      if (d.t <= 0) {
        d.el.remove()
        return false
      }
      const rel = d.angle - yaw
      d.el.style.transform = `translate(-50%, -50%) rotate(${-rel}rad) translateY(-90px)`
      d.el.style.opacity = String(Math.min(1, d.t * 2))
      return true
    })
  }

  feed(html: string) {
    const el = document.createElement('div')
    el.className = 'feedItem'
    el.innerHTML = html
    const box = $('killfeed')
    box.prepend(el)
    while (box.children.length > 6) box.lastElementChild!.remove()
    setTimeout(() => el.remove(), 6000)
  }

  toast(text: string, kind: 'good' | 'bad' | 'info' = 'info') {
    const el = document.createElement('div')
    el.className = `toast ${kind}`
    el.textContent = text
    $('toasts').appendChild(el)
    setTimeout(() => el.remove(), 2500)
  }

  big(text: string, cls = '') {
    const el = $('bigMsg')
    el.className = cls
    el.textContent = text
    restart(el, 'show')
  }

  clearBig() {
    $('bigMsg').className = ''
    $('bigMsg').textContent = ''
  }

  setDead(dead: boolean, killer = '', respawnIn = 0) {
    $('deathScreen').classList.toggle('hidden', !dead)
    if (dead) {
      $('deathBy').innerHTML = killer
      $('respawnIn').textContent = String(Math.max(1, Math.ceil(respawnIn)))
    }
  }
}
