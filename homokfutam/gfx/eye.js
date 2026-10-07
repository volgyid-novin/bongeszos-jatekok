// ============================================================
//  Eye adaptation (?gfx=eye:1, docs/visual-next-steps.md D3)
//  The post chain meters the HDR scene colour into a small target (METER_W x METER_H texels:
//  r = mean log2 luminance of the texel's 4x4 taps, g = weight: centre-weighted, the sky counts
//  less). The chain draws it only when asked, every fourth frame, and it is read back asynchronously; this turns it into a metered
//  EV (weighted mean of the middle of the distribution: the brightest 2 % and darkest 10 % are
//  dropped, so the sun disc, flames and the pods' undersides do not steer it) and eases the
//  exposure towards it. The exposure then multiplies the HDR frame before bloom, god rays, flare
//  and AgX (gfx/post.js, gfx/tsl/post.js), so a blown-out exit also blooms.
// ============================================================
export const METER_W = 64, METER_H = 36;

// The metered EV that counts as "open desert": the exposure stays at the preset's there. Measured with
// __homok.eye on the open stretches at noon (D3); the dead band keeps turning towards / away from the sun
// (~0.3 EV apart) from pumping.
export const EYE = {
  refEV: -1.7,
  dead: 0.25,
  minEV: -0.5, maxEV: 1.7,            // around the preset's exposure
  amount: 0.85,                       // share of the difference made up: the shade still reads as shade
  tauBright: 0.4,                     // s: back into the light (the glare fades in ~1-1.5 s)
  tauDark: 0.9,                       // s: into the shade (settled in ~2.5 s)
};

const order = new Uint16Array(METER_W * METER_H);
// weighted mean of r over the [lo, hi] share of the total weight
export function meterEV(buf, lo = 0.1, hi = 0.98) {
  const n = METER_W * METER_H;
  let total = 0;
  for (let i = 0; i < n; i++) { order[i] = i; total += buf[i * 4 + 1]; }
  if (!(total > 0)) return null;
  order.sort((a, b) => buf[a * 4] - buf[b * 4]);
  let acc = 0, sw = 0, s = 0;
  const a = lo * total, b = hi * total;
  for (let k = 0; k < n; k++) {
    const i = order[k], w = buf[i * 4 + 1];
    // the part of this texel's weight inside [a, b]
    const u = Math.max(0, Math.min(acc + w, b) - Math.max(acc, a));
    acc += w;
    if (u > 0) { s += buf[i * 4] * u; sw += u; }
    if (acc >= b) break;
  }
  return sw > 0 ? s / sw : null;
}

// base: the preset's exposure. meter(): Promise of the metered target's pixels (Float32Array, RGBA),
// or null when the chain cannot meter this frame. Without a meter (?gfx=eye:2, LOW and MEDIUM: no extra
// pass, no readback), zone() gives the target in EV from where the camera is (main.js).
export function createEye(base, meter, zone = null) {
  let ev = 0, target = 0, metered = EYE.refEV, pending = false, frame = 0, snapNext = true, lastCam = null;
  const eye = {
    get exposure() { return base * 2 ** ev; },
    get ev() { return ev; },
    get target() { return target; },
    get metered() { return metered; },
    // the next reading sets the exposure at once (a cut, the race start, a fast-forward)
    snap() { snapNext = true; },
    // lock: menus and the like stay at the preset's exposure; hold: photo mode keeps the moment's
    update(dt, camPos, { lock = false, hold = false } = {}) {
      if (lock) { ev = 0; target = 0; snapNext = true; lastCam = null; return; }
      // a camera that jumps is a cut
      if (lastCam && camPos.distanceToSquared(lastCam) > 30 * 30) snapNext = true;
      lastCam = (lastCam || camPos.clone()).copy(camPos);
      if (!meter && zone) {
        target = Math.min(EYE.maxEV, Math.max(EYE.minEV, zone()));
        if (snapNext) { ev = target; snapNext = false; }
      } else if (!pending && (frame++ & 3) === 0) {
        const p = meter();
        if (p) {
          pending = true;
          const snapThis = snapNext;
          p.then((buf) => {
            pending = false;
            const m = meterEV(buf);
            if (m == null || !isFinite(m)) return;
            metered = m;
            const d = EYE.refEV - m;
            target = Math.min(EYE.maxEV, Math.max(EYE.minEV, Math.sign(d) * Math.max(Math.abs(d) - EYE.dead, 0) * EYE.amount));
            if (snapThis && snapNext) { ev = target; snapNext = false; }
          }, () => { pending = false; });
        }
      }
      if (hold || snapNext) return;
      const tau = target < ev ? EYE.tauBright : EYE.tauDark;
      ev += (target - ev) * (1 - Math.exp(-Math.min(dt, 0.1) / tau));
    },
  };
  return eye;
}
