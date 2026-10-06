import { settings } from '../settings'

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

export interface RoundResult {
  outcome: 'win' | 'lose' | 'draw'
  myCaps: number
  oppCaps: number
  kills: number
  deaths: number
  caps: number
  shots: number
  hits: number
  heads: number
  time: number
}

// Menu, room and result screens.
export class Lobby {
  onCreate?: (name: string) => void
  onJoin?: (name: string, code: string) => void
  onBot?: (name: string) => void
  onReady?: () => void
  onLeave?: () => void

  constructor() {
    const nameInput = $<HTMLInputElement>('nameInput')
    const codeInput = $<HTMLInputElement>('codeInput')
    nameInput.value = safeGet('blockshot-name') ?? ''
    const name = () => {
      const n = nameInput.value.trim().slice(0, 16) || 'Játékos'
      safeSet('blockshot-name', n)
      return n
    }

    const readInvite = () => {
      if (!$('roomView').classList.contains('hidden')) return // already in a room
      const hash = location.hash.replace('#', '').toUpperCase()
      if (/^[A-Z]{4}$/.test(hash)) {
        codeInput.value = hash
        $('joinBtn').classList.add('primary')
        $('inviteNote').classList.remove('hidden')
      }
    }
    readInvite()
    window.addEventListener('hashchange', readInvite)
    codeInput.addEventListener('input', () => {
      codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4)
    })

    $('createBtn').onclick = () => this.onCreate?.(name())
    $('joinBtn').onclick = () => {
      const code = codeInput.value.trim().toUpperCase()
      if (!/^[A-Z]{4}$/.test(code)) {
        codeInput.classList.add('err')
        codeInput.focus()
        return
      }
      this.onJoin?.(name(), code)
    }
    codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('joinBtn').click()
    })
    $('botBtn').onclick = () => this.onBot?.(name())
    const sens = $<HTMLInputElement>('sensInput')
    const showSens = () => ($('sensVal').textContent = Number(sens.value).toFixed(1))
    sens.value = String(settings.sensitivity)
    showSens()
    sens.addEventListener('input', () => {
      settings.setSensitivity(Number(sens.value))
      showSens()
    })
    $('readyBtn').onclick = () => this.onReady?.()
    $('leaveBtn').onclick = () => this.onLeave?.()
    $('rematchBtn').onclick = () => this.onReady?.()
    $('resultLeaveBtn').onclick = () => this.onLeave?.()
    $('copyBtn').onclick = () => {
      const url = $('inviteLink').textContent ?? ''
      void navigator.clipboard?.writeText(url).then(() => {
        $('copyBtn').textContent = 'MÁSOLVA ✓'
        setTimeout(() => ($('copyBtn').textContent = 'LINK MÁSOLÁSA'), 1500)
      })
    }
  }

  showRoom(code: string | null) {
    $('lobby').classList.remove('hidden')
    $('startView').classList.add('hidden')
    $('roomView').classList.remove('hidden')
    $('result').classList.add('hidden')
    if (code) {
      $('roomCode').textContent = code
      $('inviteBox').classList.remove('hidden')
      $('inviteLink').textContent = `${location.origin}${location.pathname}#${code}`
      history.replaceState(null, '', `#${code}`)
    } else {
      $('roomCode').textContent = 'GYAKORLÁS'
      $('inviteBox').classList.add('hidden')
      history.replaceState(null, '', location.pathname)
    }
    this.setPeer(null, false)
    this.setMyReady(false)
  }

  setStatus(text: string) {
    $('roomStatus').textContent = text
  }

  setPeer(name: string | null, ready: boolean) {
    const el = $('peerInfo')
    if (!name) {
      el.innerHTML = '<span class="spinner"></span> Várakozás az ellenfélre…'
      $('readyBtn').setAttribute('disabled', '')
    } else {
      el.innerHTML = `Ellenfél: <b>${escapeHtml(name)}</b> ${ready ? '<span class="ok">✓ KÉSZ</span>' : '<span class="wait">még nem kész</span>'}`
      $('readyBtn').removeAttribute('disabled')
    }
    $('rematchStatus').textContent = ready ? `${name ?? 'Az ellenfél'} visszavágót kér!` : ''
  }

  setMyReady(ready: boolean) {
    $('readyBtn').textContent = ready ? 'MÉGSEM' : 'KÉSZ VAGYOK'
    $('readyBtn').classList.toggle('active', ready)
    $('rematchBtn').textContent = ready ? 'VÁRAKOZÁS…' : 'VISSZAVÁGÓ'
    $('rematchBtn').classList.toggle('active', ready)
  }

  hide() {
    $('lobby').classList.add('hidden')
    $('result').classList.add('hidden')
  }

  showResult(r: RoundResult, oppName: string) {
    $('result').classList.remove('hidden')
    $('lobby').classList.add('hidden')
    const title = $('resultTitle')
    title.textContent = r.outcome === 'win' ? 'GYŐZELEM' : r.outcome === 'lose' ? 'VERESÉG' : 'DÖNTETLEN'
    title.className = r.outcome
    const acc = r.shots ? Math.round((r.hits / r.shots) * 100) : 0
    const m = Math.floor(r.time / 60)
    const s = Math.floor(r.time % 60)
    $('resultSub').textContent = `Zászlók: ${r.myCaps} : ${r.oppCaps}  —  ellenfél: ${oppName}`
    $('resultStats').innerHTML = `
      <div><b>${r.kills}/${r.deaths}</b><span>ölés/halál</span></div>
      <div><b>${r.caps}</b><span>te hoztad</span></div>
      <div><b>${acc}%</b><span>pontosság</span></div>
      <div><b>${m}:${String(s).padStart(2, '0')}</b><span>idő</span></div>`
    this.setMyReady(false)
  }

  backToRoom(message: string) {
    $('result').classList.add('hidden')
    $('lobby').classList.remove('hidden')
    this.setStatus(message)
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function safeGet(key: string) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* ignore */
  }
}
