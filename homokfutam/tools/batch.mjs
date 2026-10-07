// node batch.mjs <jobs.txt> [--name d7] [--port 5207]
// Freezes the working tree into a snapshot (os temp dir; node_modules linked to the repo's), serves it with
// Vite on its own port and runs every job against it, so edits made meanwhile cannot reload the pages
// mid-benchmark. jobs.txt: one job per line, "label|<bench.mjs arguments>", e.g.
//   gpu1440|--size 2560x1440 --rounds 2 "q=high&renderer=webgpu&gputime&gfx=eye:0" "q=high&renderer=webgpu&gputime"
// Lines with "gputime" get Chrome's timestamp-query flag. Logs: out/<name>_<label>.log (read with deltas.mjs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { HERE, OUT } from './lib.mjs';

const argv = process.argv.slice(2);
const jobsFile = argv.shift();
let name = 'batch', port = 5207;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--name') name = argv[++i];
  else if (argv[i] === '--port') port = +argv[++i];
}
if (!jobsFile) { console.error('usage: node batch.mjs <jobs.txt> [--name n] [--port p]'); process.exit(1); }

// --- snapshot ---------------------------------------------------------------------------------------------
const REPO = path.resolve(HERE, '..', '..');
const SNAP = path.join(os.tmpdir(), `homokfutam-snap-${name}`);
fs.rmSync(SNAP, { recursive: true, force: true });
const skip = new Set(['build', '__pycache__', 'node_modules', 'out']);
fs.cpSync(path.join(REPO, 'homokfutam'), path.join(SNAP, 'homokfutam'), { recursive: true, filter: (src) => !skip.has(path.basename(src)) });
for (const f of ['index.html', 'package.json']) fs.copyFileSync(path.join(REPO, f), path.join(SNAP, f));
fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(SNAP, 'node_modules'), 'junction');
// preserveSymlinks: without it Vite asks for the basis transcoder through /@fs/ and the KTX2 textures fail
fs.writeFileSync(path.join(SNAP, 'vite.config.mjs'), "export default { base: './', resolve: { preserveSymlinks: true } };\n");
console.log('snapshot', SNAP);

// --- serve it ---------------------------------------------------------------------------------------------
const vite = spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  { cwd: SNAP, stdio: 'ignore' });
const base = `http://127.0.0.1:${port}/homokfutam/`;
for (let k = 0; ; k++) {
  try { if ((await fetch(base)).ok) break; } catch { /* not up yet */ }
  if (k > 60) { vite.kill(); throw new Error('vite did not start'); }
  await new Promise((r) => setTimeout(r, 1000));
}

// --- run the jobs -----------------------------------------------------------------------------------------
// split a job's arguments like a shell would: "quoted strings" stay whole
const split = (s) => [...s.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
try {
  for (const line of fs.readFileSync(jobsFile, 'utf8').split(/\r?\n/)) {
    const bar = line.indexOf('|');
    if (bar < 0 || line.trim().startsWith('#')) continue;
    const label = line.slice(0, bar).trim(), args = split(line.slice(bar + 1));
    const env = { ...process.env, HF_BASE: base };
    if (line.includes('gputime')) env.HF_ARGS = '--enable-dawn-features=allow_unsafe_apis'; else delete env.HF_ARGS;
    const log = fs.openSync(path.join(OUT, `${name}_${label}.log`), 'w');
    fs.writeSync(log, `== ${label}: ${args.join(' ')}\n`);
    await new Promise((resolve) => {
      const p = spawn(process.execPath, [path.join(HERE, 'bench.mjs'), ...args], { cwd: HERE, env, stdio: ['ignore', log, log] });
      p.on('exit', resolve);
    });
    fs.closeSync(log);
    console.log('done', label);
  }
} finally {
  vite.kill();
}
console.log('all done');
