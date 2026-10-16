// A tiny test harness for the app-level suites (nostr, leaderboard, race, input, store): `test(name, fn)` registers a case,
// `runAll()` runs them one after another and returns [{ name, ok, detail }] (the same row shape as test/trace.js).
// Every case gets a clean slate: globals that a case replaced with setGlobal() are restored afterwards, onCleanup() callbacks
// run, and a case that hangs or leaves an unhandled promise rejection behind fails instead of freezing / crashing the run.
import assert from 'node:assert/strict';

export { assert };
const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };   // (race cases swap in a virtual clock)
const cases = [];
const saved = new Map();
const cleanups = [];
const finals = [];

export const test = (name, fn) => cases.push({ name, fn });
export const sleep = (ms) => new Promise((r) => real.setTimeout(r, ms));
export const onCleanup = (fn) => cleanups.push(fn);
// runs once after the last case (for things a suite had to change at import time)
export const afterAll = (fn) => finals.push(fn);

// replace a global (document, localStorage, WebSocket, ...) for the running case only
export function setGlobal(name, value) {
  if (!saved.has(name)) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true, enumerable: true });
}
function restore() {
  while (cleanups.length) { try { cleanups.pop()(); } catch { /* ignore */ } }
  for (const [name, d] of saved) { if (d) Object.defineProperty(globalThis, name, d); else delete globalThis[name]; }
  saved.clear();
}

export async function runAll({ only = null, caseTimeoutMs = 60000 } = {}) {
  const rows = [];
  const rejections = [];
  const onRej = (e) => rejections.push(e);
  process.on('unhandledRejection', onRej);
  try {
    for (const c of cases) {
      if (only && !c.name.includes(only)) continue;
      rejections.length = 0;
      const t0 = performance.now();
      let ok = true, detail = '';
      let timer = 0;
      try {
        await Promise.race([c.fn(), new Promise((_, rej) => { timer = real.setTimeout(() => rej(new Error(`timed out after ${caseTimeoutMs} ms`)), caseTimeoutMs); })]);
        await sleep(0);   // let a stray rejection surface
        if (rejections.length) throw new Error('unhandled promise rejection: ' + String(rejections[0] && rejections[0].stack || rejections[0]).split('\n').slice(0, 3).join(' | '));
      } catch (e) {
        ok = false;
        detail = String(e && e.message || e).split('\n').slice(0, 6).join('\n        ');
      } finally {
        real.clearTimeout(timer);
        restore();
      }
      rows.push({ name: c.name, ok, detail, ms: performance.now() - t0 });
    }
  } finally {
    process.off('unhandledRejection', onRej);
    while (finals.length) { try { finals.pop()(); } catch { /* ignore */ } }
  }
  return rows;
}
