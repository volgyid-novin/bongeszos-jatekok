// Keeps the owner's local UT2004 extracts (pajzsugras/local-models/ and pajzsugras/local-sounds/, Epic's material, see ut2004_extract.py)
// and the maps ported from someone else's UT2004 map (pajzsugras/local-maps/, see ut2004_map.py) on the owner's own machine.
// `npm run dev` listens on the LAN (--host) and vite.config.ts lets a Cloudflare tunnel (*.trycloudflare.com)
// in, so without this a visitor could download gorge.glb, the WAVs and the ported maps from the server: that would be redistribution.
// The dev / preview server answers 403 for those three folders unless the request comes from this machine itself: a loopback client address
// AND a local Host (localhost, 127.0.0.1, [::1]) AND no proxy headers (a tunnel connects from the same machine, but with its own Host).
// The game then keeps the robot and the synthesised sounds for that visitor. Every other path, and every other game, is untouched.
// Used by vite.config.ts (dev and preview server); tested by test/local-guard-tests.mjs.

import { posix } from 'node:path';
import { PUBLIC_MODEL_FILES } from './model-assets.mjs';

const LOCAL_ONLY = /\/pajzsugras\/local-(models|sounds|maps)(\/|$)/i;   // (anywhere in the path: also behind a prefix such as /@fs/D:/...)
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'forwarded', 'x-real-ip', 'cf-connecting-ip', 'cf-ray', 'cdn-loop'];

// the path a request url really asks for: query and hash cut off, percent escapes (also doubled) and backslashes undone, slashes collapsed,
// dot segments resolved (a protocol-relative '//host/..' url is read as a plain path: Vite and the file system do not treat it as a host)
export function normalizedPath(url) {
  const s = String(url || '/');
  let p;
  try { p = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'http://localhost' + (s.startsWith('/') ? '' : '/') + s).pathname; } catch { return null; }
  for (let i = 0; i < 3; i++) {   // (three rounds are more than any real request needs)
    let d;
    try { d = decodeURIComponent(p); } catch { return null; }
    if (d === p) break;
    p = d;
  }
  return posix.normalize(p.replace(/\\/g, '/').replace(/\/+/g, '/'));
}

// true: this url is one of the three local-only folders (or something we cannot read, which is treated the same way)
export function isLocalOnly(url) {
  const p = normalizedPath(url);
  // Only these six model sources are public. Backups and other local extracts
  // still require a direct loopback request, as do local sounds and maps.
  const model = p && p.match(/\/pajzsugras\/local-models\/([^/]+)$/i);
  if (model && PUBLIC_MODEL_FILES.includes(model[1].toLowerCase())) return false;
  return LOCAL_ONLY.test(p === null ? String(url) : p);
}

// true: the request was made from this machine, directly (not through a tunnel / proxy / LAN address)
export function isLocalRequest(req) {
  const addr = req.socket && req.socket.remoteAddress;
  if (!addr || !LOOPBACK.has(addr)) return false;
  const h = req.headers || {};
  if (!LOCAL_HOST.test(String(h.host || ''))) return false;
  return !PROXY_HEADERS.some((k) => h[k] !== undefined);
}

export function localAssetsGuard() {
  return (req, res, next) => {
    if (!isLocalOnly(req.url) || isLocalRequest(req)) return next();
    res.statusCode = 403;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end('403: local files of this machine only');
  };
}

// a Vite plugin (dev server and `vite preview`); registered first, so it runs before the static file serving
export function localAssetsPlugin() {
  return {
    name: 'pajzsugras-local-assets-only',
    configureServer(server) { server.middlewares.use(localAssetsGuard()); },
    configurePreviewServer(server) { server.middlewares.use(localAssetsGuard()); },
  };
}
