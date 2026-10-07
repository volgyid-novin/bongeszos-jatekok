// node deltas.mjs out/<batch>_<label>.log : per variant, per spot, the change against the first variant, per round
// (frame ms from fps, js ms, gpu ms), and the mean of the rounds
import fs from 'node:fs';
const txt = fs.readFileSync(process.argv[2], 'utf8').split('\n');
const runs = [];
for (let i = 0; i < txt.length; i++) {
  const m = txt[i].match(/^\[(\d+)\] (.*)$/);
  if (!m) continue;
  const spots = {};
  for (const part of (txt[i + 1] || '').split('|')) {
    const s = part.trim().match(/^(\w+) ([\d.]+)fps js([\d.]+)(?: gpu([\d.]+))? (\d+)dc/);
    if (s) spots[s[1]] = { ms: 1000 / +s[2], js: +s[3], gpu: s[4] != null ? +s[4] : null, dc: +s[5] };
  }
  runs.push({ round: +m[1], q: m[2], spots });
}
const qs = [...new Set(runs.map((r) => r.q))];
function SPOTS_OF(rs) { return Object.keys(rs[0]?.spots || {}); }
const base = qs[0];
const f = (v) => (v >= 0 ? '+' : '') + v.toFixed(2);
console.log('base:', base);
for (const q of qs) {
  const rows = [];
  for (const spot of SPOTS_OF(runs)) {
    const d = { ms: [], js: [], gpu: [] };
    for (const r of runs.filter((x) => x.q === q)) {
      const b = runs.find((x) => x.q === base && x.round === r.round);
      if (!b || !r.spots[spot] || !b.spots[spot]) continue;
      for (const k of ['ms', 'js', 'gpu']) if (r.spots[spot][k] != null) d[k].push(r.spots[spot][k] - b.spots[spot][k]);
    }
    const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
    rows.push(`${spot} frame ${d.ms.map(f).join('/')} js ${d.js.map(f).join('/')}${d.gpu.length ? ' gpu ' + d.gpu.map(f).join('/') + ' (avg ' + f(mean(d.gpu)) + ')' : ' (avg frame ' + f(mean(d.ms)) + ')'}`);
  }
  const absRows = SPOTS_OF(runs).map((s) => { const rr = runs.filter((x) => x.q === q && x.spots[s]); return `${s} ${(rr.reduce((a, x) => a + x.spots[s].ms, 0) / rr.length).toFixed(2)}ms${rr[0]?.spots[s].gpu != null ? ' gpu ' + (rr.reduce((a, x) => a + x.spots[s].gpu, 0) / rr.length).toFixed(2) : ''}`; });
  console.log(`\n${q}\n  abs: ${absRows.join(' | ')}\n  ` + (q === base ? '' : rows.join('\n  ')));
}
