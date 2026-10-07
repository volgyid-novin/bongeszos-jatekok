// node gidecode.mjs x,y,z [...] : T(n) of gi.bin at world points for normals +y, -y, +x, -x, +z, -z
import fs from 'node:fs';
import path from 'node:path';
import { ASSETS } from './lib.mjs';
const buf = fs.readFileSync(path.join(ASSETS, 'world', 'gi.bin'));
const len = buf.readUInt32LE(4);
const h = JSON.parse(buf.subarray(8, 8 + len).toString());
const data = buf.subarray(8 + len);
const [W, H, D] = h.atlas;
const ref = [0, 1, 2].map((c) => h.ref.b[c].map((b) => b / h.ref.a[c]));
console.log('boxes', h.boxes.map((b) => `${b.name} o=${b.o.map(Math.round)} u=(${b.ux.toFixed(2)},${b.uz.toFixed(2)}) size=${b.size.map(Math.round)} n=${b.n} z0=${b.z0}`).join('\n      '));
const texel = (x, y, z) => { const o = ((z * H + y) * W + x) * 4; return [data[o] / 255, data[o + 1] / 255, data[o + 2] / 255, data[o + 3] / 255]; };
function T(p, n) {
  for (const b of h.boxes) {
    const d = [p[0] + n[0] * 1.5 - b.o[0], p[1] + n[1] * 1.5 - b.o[1], p[2] + n[2] * 1.5 - b.o[2]];
    const c = [(d[0] * b.ux + d[2] * b.uz) * b.n[0] / b.size[0], d[1] * b.n[1] / b.size[1], (d[0] * -b.uz + d[2] * b.ux) * b.n[2] / b.size[2]];
    if (c.some((v, k) => v < 0 || v > b.n[k])) continue;
    const ci = c.map((v, k) => Math.min(b.n[k] - 1, Math.max(0, Math.floor(v))));
    const out = [];
    for (let ch = 0; ch < 3; ch++) {
      const t = texel(ci[2] + ch * h.maxC, ci[1], ci[0] + b.z0);
      const E = 2 ** (t[0] * 10 - 8) * Math.max(1 + 2 * ((t[1] * 2 - 1) * n[0] + (t[2] * 2 - 1) * n[1] + (t[3] * 2 - 1) * n[2]), 0.03);
      out.push(+(E / Math.max(1 + ref[ch][0] * n[0] + ref[ch][1] * n[1] + ref[ch][2] * n[2], 0.03)).toFixed(2));
    }
    return { box: b.name, cell: ci, T: out };
  }
  return null;
}
for (const arg of process.argv.slice(2)) {
  const p = arg.split(',').map(Number);
  console.log('point', p);
  for (const [nm, n] of [['+y', [0, 1, 0]], ['-y', [0, -1, 0]], ['+x', [1, 0, 0]], ['-x', [-1, 0, 0]], ['+z', [0, 0, 1]], ['-z', [0, 0, -1]]]) console.log('  ', nm, JSON.stringify(T(p, n)));
}
