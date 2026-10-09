// One page, two roles: opened with ?kard=<pairId> (the QR code) it is the phone controller, otherwise the game.
const pairId = new URLSearchParams(location.search).get('kard');
const boot = pairId && /^[a-z0-9]{6,32}$/.test(pairId)
  ? import('./pad.js').then((m) => m.startPad(pairId))
  : import('./pc.js').then((m) => m.startPC());
boot.catch((err) => {
  console.error(err);
  const el = document.getElementById('loading');
  if (el) el.innerHTML = '<div id="err">A játék nem tudott elindulni: ' + String(err && err.message || err).replace(/</g, '&lt;') + '</div>';
});
