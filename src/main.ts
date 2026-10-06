import './style.css'
import './hud.css'
import { Game } from './game/game'
import { sfx } from './game/audio'
import { P2PLink } from './net/p2pLink'
import type { Link } from './net/protocol'
import { Lobby } from './ui/lobby'

const game = new Game(document.getElementById('app')!)
const lobby = new Lobby()

let link: Link | null = null
let solo = false
let myName = 'Játékos'
let peerName = ''
let myReady = false
let peerReady = false

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const randomCode = () => Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('')

lobby.onCreate = (name) => {
  const code = randomCode()
  connect(name, new P2PLink(code), code)
}
lobby.onJoin = (name, code) => connect(name, new P2PLink(code), code)

// Practice: you + 3 bots against 4 bots, everything runs locally
lobby.onBot = (name) => {
  sfx.unlock()
  solo = true
  myName = name
  game.attach(null)
  startSolo()
}

lobby.onReady = () => {
  if (solo) {
    startSolo()
    return
  }
  if (!link?.connected) return
  myReady = !myReady
  link.send('ready', { r: myReady })
  lobby.setMyReady(myReady)
  maybeStart()
}
lobby.onLeave = () => {
  link?.leave()
  history.replaceState(null, '', location.pathname)
  location.reload()
}

function startSolo() {
  lobby.hide()
  game.startRound({ side: 0, myName, oppName: 'BOTOK', solo: true })
}

function connect(name: string, l: Link, code: string) {
  sfx.unlock()
  myName = name
  link = l
  game.attach(l)
  lobby.showRoom(code)
  lobby.setStatus('Kapcsolódás a szobához…')

  const joinTimer = window.setTimeout(() => {
    if (!l.connected) lobby.setStatus('Még senki… Küldd el a kódot / linket a haverodnak. (Ha ő már bent van: ellenőrizzétek a kódot.)')
  }, 15000)

  l.onPeer((connected) => {
    if (connected) {
      clearTimeout(joinTimer)
      l.send('hello', { name: myName })
      lobby.setStatus('Kapcsolódva! Ha mindketten készen álltok, indul a meccs. (Mindkettőtök mellé 3 bot kerül.)')
      lobby.setPeer(peerName || '…', peerReady)
    } else {
      peerName = ''
      peerReady = false
      myReady = false
      lobby.setPeer(null, false)
      lobby.setMyReady(false)
      game.abort()
      lobby.backToRoom('Az ellenfél kilépett. Várakozás új ellenfélre…')
    }
  })
  l.on('hello', (d) => {
    peerName = String(d.name ?? '').slice(0, 16) || 'Ellenfél'
    lobby.setPeer(peerName, peerReady)
  })
  l.on('ready', (d) => {
    peerReady = !!d.r
    lobby.setPeer(peerName || 'Ellenfél', peerReady)
    maybeStart()
  })
  l.on('start', () => beginRound())
}

// The host (lower peer id) starts the match once both players are ready.
function maybeStart() {
  if (!link || !link.isHost || !link.connected || !myReady || !peerReady) return
  link.send('start', { seed: Math.floor(Math.random() * 2 ** 31) })
  beginRound()
}

// Host plays red (team 0), guest plays blue (team 1)
function beginRound() {
  if (!link) return
  myReady = false
  peerReady = false
  lobby.hide()
  lobby.setMyReady(false)
  game.startRound({ side: link.isHost ? 0 : 1, myName, oppName: peerName || 'Ellenfél', solo: false })
}

game.onRoundOver = (r) => {
  lobby.showResult(r, solo ? 'BOTOK' : peerName || 'Ellenfél')
  if (!solo) lobby.setPeer(peerName || 'Ellenfél', peerReady)
}
