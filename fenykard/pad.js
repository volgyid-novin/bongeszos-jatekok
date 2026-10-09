import { pairRoom } from './net.js';

// Phone controller mode (?kard=<pairId>): reads the gyroscope through deviceorientation, turns it into the
// saber's quaternion (game frame, see fight.js) and streams it to the paired PC about 60 times a second.
// No three.js here, so the phone only loads this small file.

const $ = (id) => document.getElementById(id);
const DEG = Math.PI / 180;
const SEND_GAP = 14;        // ms between orientation packets
const HEARTBEAT = 250;      // resend the last one at least this often, even when the phone is still

function qMul(a, b) {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}
function qAxis(x, y, z, ang) {
  const s = Math.sin(ang / 2);
  return [x * s, y * s, z * s, Math.cos(ang / 2)];
}
function qRot(q, v) {
  const [qx, qy, qz, qw] = q, [vx, vy, vz] = v;
  const tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx);
  return [vx + qw * tx + (qy * tz - qz * ty), vy + qw * ty + (qz * tx - qx * tz), vz + qw * tz + (qx * ty - qy * tx)];
}
// deviceorientation is intrinsic Z-X'-Y'' (alpha, beta, gamma) from the device frame to the Earth frame
// (x east, y north, z up). Swapping to the game frame (x right, y up, z back) maps the phone's top edge to the
// saber's local -Z (the blade) and the screen normal to local +Y.
function orientToQ(a, b, g) {
  const qe = qMul(qMul(qAxis(0, 0, 1, a * DEG), qAxis(1, 0, 0, b * DEG)), qAxis(0, 1, 0, g * DEG));
  return [qe[0], qe[2], -qe[1], qe[3]];
}
const r4 = (v) => Math.round(v * 1e4) / 1e4;

export function startPad(pairId) {
  $('pc').hidden = true;
  $('pad').hidden = false;
  document.title = 'Fénykard · kontroller';

  const room = pairRoom(pairId);
  let pc = null;              // peer id of the PC
  let armed = false;
  let raw = null;             // latest uncalibrated quaternion
  let cal = [0, 0, 0, 1];     // yaw correction
  let needCal = true;         // calibrate on the first sample
  let q = [0, 0, 0, 1];
  let lastSend = 0, lastData = 0;
  let wake = null;
  let status = null;

  const hi = () => room.send('hi', { armed });
  room.onJoin = (pid) => { pc = pid; hi(); renderConn(); };
  room.onLeave = (pid) => { if (pid === pc) { pc = [...room.peers][0] || null; renderConn(); } };
  room.on('ps', (d, pid) => { pc = pid; status = d; renderStatus(); renderConn(); });
  room.on('bz', (d) => { try { navigator.vibrate?.(d); } catch { /* not supported */ } });

  function renderConn() {
    const el = $('padConn');
    el.textContent = pc ? 'Csatlakozva a géphez' : 'Kapcsolódás a géphez…';
    el.classList.toggle('ok', !!pc);
  }
  function renderStatus() {
    if (!status) return;
    if (status.col) document.documentElement.style.setProperty('--blade', status.col);
    $('padStatus').textContent = status.t || '';
    const hp = status.hp;
    $('padHp').hidden = !hp;
    if (hp) {
      $('padHpMe').style.width = hp[0] + '%';
      $('padHpOp').style.width = hp[1] + '%';
      $('padHpMeTxt').textContent = hp[0];
      $('padHpOpTxt').textContent = hp[1];
    }
    const rb = $('padReady');
    rb.hidden = status.rdy == null;
    rb.textContent = status.rdy ? 'MÉGSEM' : 'KÉSZ VAGYOK';
    rb.classList.toggle('on', !!status.rdy);
  }
  function note(text) { $('padNote').textContent = text; $('padNote').hidden = !text; }

  function calibrate() {
    if (!raw) return false;
    const b = qRot(raw, [0, 0, -1]);
    if (Math.hypot(b[0], b[2]) < 0.5) return false;   // pointing up or down: no usable heading
    cal = qAxis(0, 1, 0, -Math.atan2(-b[0], -b[2]));
    needCal = false;
    return true;
  }
  function send(now) {
    lastSend = now;
    room.send('o', [r4(q[0]), r4(q[1]), r4(q[2]), r4(q[3])]);
  }
  function onOrient(e) {
    if (e.alpha == null || e.beta == null || e.gamma == null) return;
    raw = orientToQ(e.alpha, e.beta, e.gamma);
    if (needCal) calibrate();
    q = qMul(cal, raw);
    const now = performance.now();
    if (!lastData) note('');
    lastData = now;
    if (now - lastSend >= SEND_GAP) send(now);
  }
  setInterval(() => {
    const now = performance.now();
    if (armed && lastData && now - lastSend > HEARTBEAT) send(now);
    if (pc && !status) hi();
  }, HEARTBEAT);

  async function lockWake() {
    try { wake = await navigator.wakeLock?.request('screen'); } catch { wake = null; }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && armed && (!wake || wake.released)) lockWake();
  });

  $('armBtn').addEventListener('click', async () => {
    const DOE = window.DeviceOrientationEvent;
    if (!DOE) { note('Ez az eszköz nem ad mozgásadatot (nincs giroszkóp).'); return; }
    // iPhone (and newer Chrome) ask first. A refusal isn't final here: if data still arrives, the note goes away.
    let perm = 'granted';
    if (typeof DOE.requestPermission === 'function') {
      try { perm = await DOE.requestPermission(); } catch { perm = 'error'; }
    }
    if (perm !== 'granted') note('Nem kaptunk engedélyt a mozgásérzékelőhöz. Töltsd újra az oldalt, és engedélyezd (iPhone-on: Beállítások › Safari › Mozgás és tájolás).');
    window.addEventListener('deviceorientation', onOrient);
    armed = true;
    needCal = true;
    lockWake();
    // fullscreen + portrait lock where allowed (not on iPhone); don't wait for them, some browsers never answer
    document.documentElement.requestFullscreen?.({ navigationUI: 'hide' })
      ?.then(() => screen.orientation?.lock?.('portrait'))
      .catch(() => {});
    $('padStart').hidden = true;
    $('padLive').hidden = false;
    room.send('pb', { k: 'arm' });
    hi();
    try { navigator.vibrate?.(60); } catch { /* not supported */ }
    setTimeout(() => {
      if (!lastData) note('Nem jön mozgásadat. Androidon Chrome-ot, iPhone-on Safarit használj, és HTTPS-en nyisd meg az oldalt.');
    }, 1500);
  });

  // hold to re-centre, so a stray thumb mid-swing doesn't do it
  const calBtn = $('calBtn');
  let holdT = 0;
  const cancel = () => { clearTimeout(holdT); calBtn.classList.remove('hold'); };
  calBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    calBtn.classList.add('hold');
    holdT = setTimeout(() => {
      calBtn.classList.remove('hold');
      if (calibrate()) {
        q = qMul(cal, raw);
        send(performance.now());
        room.send('pb', { k: 'cal' });
        flash('Igazítva');
        try { navigator.vibrate?.(40); } catch { /* not supported */ }
      } else flash('Fogd vízszintesen, a monitor felé');
    }, 450);
  });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) calBtn.addEventListener(ev, cancel);
  calBtn.addEventListener('contextmenu', (e) => e.preventDefault());

  let flashT = 0;
  function flash(text) {
    const el = $('calMsg');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(flashT);
    flashT = setTimeout(() => el.classList.remove('show'), 1300);
  }

  $('padReady').addEventListener('click', () => {
    room.send('pb', { k: 'rdy' });
    try { navigator.vibrate?.(20); } catch { /* not supported */ }
  });

  window.addEventListener('beforeunload', () => room.leave());
  renderConn();
  if (!window.isSecureContext) note('Az oldalt HTTPS-en kell megnyitni, különben nem megy a mozgásérzékelő és a kapcsolat.');
  $('loading').hidden = true;
}
