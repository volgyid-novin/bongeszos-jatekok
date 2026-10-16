// Run recording for the personal-best ghost (and the optional #1 ghost on the leaderboard).
//   GhostRecorder   sampled by World every GHOST_EVERY ticks while the clock runs
//   encodeGhost     -> Uint8Array: header, first frame absolute (cm), then int16 cm deltas (escape for teleports)
//   decodeGhost     -> { every, n, data: Float32Array(n * 5) } | null (bad data)  per frame x, y, z (m), yaw, pitch (rad)
//   ghostAt         interpolated [x, y, z, yaw, pitch] at a clock tick
//   toB64 / fromB64 pure base64 (the caller deflates if it wants: CompressionStream('deflate-raw') in the browser)
import { GHOST_EVERY } from './const.js';
import { angDiff } from './math.js';

const MAGIC = 0x47, VER = 1, ESC = -32768;
const MIN_FRAME_BYTES = 10;   // a delta frame: 3 x int16 position + 2 x int16 angles (an escaped one takes 18)
const MAX_FRAMES = 120000;    // 1 h at 20 Hz is 72000
const wrap = (a) => angDiff(a, 0);

export class GhostRecorder {
  constructor(every = GHOST_EVERY) { this.every = every; this.reset(); }
  reset() { this.data = []; this.n = 0; }
  // call with the clock tick (0 = the start) and the player; records when tick is a multiple of `every`, or force = true
  sample(tick, ps, force = false) {
    if (!force && tick % this.every !== 0) return;
    this.data.push(ps.pos[0], ps.pos[1], ps.pos[2], wrap(ps.yaw), ps.pitch);
    this.n++;
  }
  // { every, n, data: number[] } snapshot of the run so far
  get() { return { every: this.every, n: this.n, data: this.data.slice() }; }
}

// step: keep every step-th frame (10 Hz from the 20 Hz recording: step 2)
export function encodeGhost(rec, step = 1) {
  const frames = [];
  for (let i = 0; i < rec.n; i += step) frames.push(i);
  if (rec.n && frames[frames.length - 1] !== rec.n - 1) frames.push(rec.n - 1);
  const n = frames.length;
  const buf = new Uint8Array(8 + n * 18 + 64);   // worst case: every frame escaped
  const dv = new DataView(buf.buffer);
  let o = 0;
  dv.setUint8(o++, MAGIC); dv.setUint8(o++, VER); dv.setUint8(o++, rec.every * step); dv.setUint8(o++, 0); dv.setUint32(o, n, true); o += 4;
  let px = 0, py = 0, pz = 0;
  frames.forEach((fi, k) => {
    const d = rec.data, b = fi * 5;
    const x = Math.round(d[b] * 100), y = Math.round(d[b + 1] * 100), z = Math.round(d[b + 2] * 100);
    const yaw = Math.round((d[b + 3] / Math.PI) * 32767), pitch = Math.round((d[b + 4] / (Math.PI / 2)) * 32767);
    const dx = x - px, dy = y - py, dz = z - pz;
    if (k === 0 || Math.abs(dx) > 32000 || Math.abs(dy) > 32000 || Math.abs(dz) > 32000) {
      dv.setInt16(o, ESC, true); o += 2;
      dv.setInt32(o, x, true); dv.setInt32(o + 4, y, true); dv.setInt32(o + 8, z, true); o += 12;
    } else {
      dv.setInt16(o, dx, true); dv.setInt16(o + 2, dy, true); dv.setInt16(o + 4, dz, true); o += 6;
    }
    dv.setInt16(o, yaw, true); dv.setInt16(o + 2, pitch, true); o += 4;
    px = x; py = y; pz = z;
  });
  return buf.slice(0, o);
}

// -> { every, n, data } | null (not a ghost, truncated, or absurd sizes; nothing is allocated before the header is checked)
export function decodeGhost(bytes) {
  try {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.getUint8(0) !== MAGIC || dv.getUint8(1) !== VER) return null;
    const every = dv.getUint8(2), n = dv.getUint32(4, true);
    if (every < 1 || n > MAX_FRAMES || n > (bytes.byteLength - 8) / MIN_FRAME_BYTES) return null;
    const data = new Float32Array(n * 5);
    let o = 8, x = 0, y = 0, z = 0;
    for (let k = 0; k < n; k++) {
      const t = dv.getInt16(o, true);
      if (t === ESC) { x = dv.getInt32(o + 2, true); y = dv.getInt32(o + 6, true); z = dv.getInt32(o + 10, true); o += 14; }
      else { x += t; y += dv.getInt16(o + 2, true); z += dv.getInt16(o + 4, true); o += 6; }
      data[k * 5] = x / 100; data[k * 5 + 1] = y / 100; data[k * 5 + 2] = z / 100;
      data[k * 5 + 3] = (dv.getInt16(o, true) / 32767) * Math.PI;
      data[k * 5 + 4] = (dv.getInt16(o + 2, true) / 32767) * (Math.PI / 2);
      o += 4;
    }
    return { every, n, data };
  } catch { return null; }   // (a RangeError: the frames run past the end of the data)
}

// pose of a decoded ghost at a clock tick (clamped to its first/last frame); out is optional
export function ghostAt(g, tick, out = [0, 0, 0, 0, 0]) {
  if (!g.n) return out;
  const f = Math.max(0, Math.min(g.n - 1, tick / g.every));   // frame k was taken at tick k * every (frame 0 = clock start)
  const i = Math.floor(f), j = Math.min(g.n - 1, i + 1), t = f - i, d = g.data;
  for (let c = 0; c < 3; c++) out[c] = d[i * 5 + c] + (d[j * 5 + c] - d[i * 5 + c]) * t;
  out[3] = d[i * 5 + 3] + angDiff(d[j * 5 + 3], d[i * 5 + 3]) * t;
  out[4] = d[i * 5 + 4] + (d[j * 5 + 4] - d[i * 5 + 4]) * t;
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    s += B64[a >> 2] + B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    s += i + 1 < bytes.length ? B64[((b & 15) << 2) | ((c ?? 0) >> 6)] : '=';
    s += i + 2 < bytes.length ? B64[c & 63] : '=';
  }
  return s;
}
export function fromB64(str) {
  const clean = str.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const v = [0, 1, 2, 3].map((k) => (i + k < clean.length ? B64.indexOf(clean[i + k]) : 0));
    if (o < out.length) out[o++] = (v[0] << 2) | (v[1] >> 4);
    if (o < out.length) out[o++] = ((v[1] & 15) << 4) | (v[2] >> 2);
    if (o < out.length) out[o++] = ((v[2] & 3) << 6) | v[3];
  }
  return out;
}
