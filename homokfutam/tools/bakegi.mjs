// node bakegi.mjs ["query"] [file] : runs __homok.bakeGI() and writes homokfutam/assets/world/<file>; the file is
// gi_tunnel.bin unless the query turns the tunnel off (?gfx=tunnel:0 -> gi.bin)
import fs from 'node:fs';
import path from 'node:path';
import { launch, open, ASSETS } from './lib.mjs';
const q = process.argv[2] || 'q=low&renderer=webgl';
const browser = await launch({ w: 800, h: 450, webgpu: !/renderer=webgl/.test(q) });
const page = await open(browser, q);
page.on('console', (m) => { if (/GI bake/.test(m.text())) console.log(m.text()); });
const r = await page.evaluate(async () => {
  const r = await window.__homok.bakeGI();
  const u8 = new Uint8Array(r.buffer);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return { b64: btoa(s), header: r.header, ms: r.ms, triangles: r.triangles };
});
const out = path.join(ASSETS, 'world', process.argv[3] || (/tunnel:0/.test(q) ? 'gi.bin' : 'gi_tunnel.bin'));
fs.writeFileSync(out, Buffer.from(r.b64, 'base64'));
console.log('wrote', out, fs.statSync(out).size, 'bytes;', Math.round(r.ms), 'ms;', r.triangles, 'triangles');
console.log(JSON.stringify(r.header.boxes.map((b) => ({ n: b.name, cells: b.n, size: b.size.map(Math.round) }))));
console.log('ref', JSON.stringify(r.header.ref));
const errs = page.logs.filter((l) => /error|PAGEERROR/i.test(l));
if (errs.length) console.log('ERR', errs.slice(0, 5).join('\n'));
await browser.close();
