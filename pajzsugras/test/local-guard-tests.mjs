// tools/local-guard.mjs: the dev / preview server hands pajzsugras/local-models/ and local-sounds/ (the owner's own UT2004 extracts) only to
// requests from this machine itself, so a LAN visitor or a tunnel (*.trycloudflare.com) cannot download them. Unit cases on the pure functions
// and the middleware, plus the real Vite dev server started with the real vite.config.ts.
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { test, assert } from './harness.mjs';
import { isLocalOnly, isLocalRequest, localAssetsGuard, localAssetsPlugin, normalizedPath } from '../tools/local-guard.mjs';

const req = (addr, headers = { host: 'localhost:5173' }, url = '/pajzsugras/local-models/private.glb') => ({ url, headers, socket: { remoteAddress: addr } });
const run = (r) => {
  const out = { next: false, status: 0, body: '', headers: {} };
  const res = { statusCode: 200, setHeader: (k, v) => { out.headers[k.toLowerCase()] = v; }, end: (b) => { out.body = b; out.status = res.statusCode; } };
  localAssetsGuard()(r, res, () => { out.next = true; });
  return out;
};

test('local guard: the six deployed model sources are public on LAN and tunnel hosts; backups remain local', () => {
  for (const file of ['gorge.glb', 'gorge-body.png', 'gorge-head.png', 'shieldgun-1st.glb', 'shieldgun-3rd.glb', 'shieldgun.png']) {
    for (const prefix of ['/pajzsugras/', '/@fs/D:/izsi/lol/pajzsugras/', '/bongeszos-jatekok/pajzsugras/']) {
      const url = prefix + 'local-models/' + file;
      assert.equal(isLocalOnly(url), false);
      assert.equal(run(req('192.168.1.20', { host: 'abc.trycloudflare.com' }, url)).next, true);
    }
  }
  for (const url of ['/pajzsugras/local-models/_mentes-2026-10-18/gorge.glb', '/pajzsugras/local-models/other.glb', '/pajzsugras/local-models/gorge.glb.bak']) {
    assert.equal(run(req('192.168.1.20', { host: 'abc.trycloudflare.com' }, url)).status, 403);
  }
});

test('local guard: only the three local folders of PAJZSUGRAS are local-only - every other path and game is untouched', () => {
  for (const u of ['/pajzsugras/local-models/private.glb', '/pajzsugras/local-sounds/jump1.wav', '/pajzsugras/local-sounds/sounds.json?t=1', '/pajzsugras/local-models/', '/pajzsugras/local-models',
    '/PAJZSUGRAS/Local-Sounds/x.wav', '/@fs/D:/izsi/lol/pajzsugras/local-models/private.glb', '/pajzsugras/local-models/private.glb?import&raw',
    '/pajzsugras/local-maps/hopphopp.json', '/pajzsugras/local-maps', '/PAJZSUGRAS/Local-Maps/x.json', '/@fs/D:/izsi/lol/pajzsugras/local-maps/x.json']) assert.equal(isLocalOnly(u), true, u);
  for (const u of ['/', '/pajzsugras/', '/pajzsugras/main.js', '/pajzsugras/index.html', '/pajzsugras/maps/uj-palya.js', '/hago/index.html', '/hadur/main.js', '/homokfutam/', '/fenykard/',
    '/src/main.ts', '/pajzsugras/local-modelsX/a', '/pajzsugras/local-mapsX/a', '/pajzsugras/tools/local-guard.mjs', '/assets/local-models.js']) assert.equal(isLocalOnly(u), false, u);
});

test('local guard: dot segments, percent escapes (also doubled), backslashes and slashes cannot smuggle a path past it', () => {
  for (const u of ['/pajzsugras/x/../local-models/private.glb', '/pajzsugras/./local-models/private.glb', '/pajzsugras/%6cocal-models/private.glb', '/pajzsugras/%2e%2e/pajzsugras/local-models/a',
    '/pajzsugras/local%2Dmodels/private.glb', '/pajzsugras/%256cocal-models/private.glb', '/pajzsugras\\local-models\\private.glb', '//pajzsugras//local-models//private.glb', '/pajzsugras/local-models%2fprivate.glb',
    '//evil.example/pajzsugras/local-models/private.glb']) assert.equal(isLocalOnly(u), true, u);
  assert.equal(normalizedPath('/a/b/../c//d?x=1#y'), '/a/c/d');
  assert.equal(isLocalOnly('/pajzsugras/local-models/%E0%A4%A'), true, 'a malformed escape behind a local-only path still counts as local-only');
  assert.equal(isLocalOnly(undefined), false);
});

test('local guard: a request counts as local only from a loopback address with a local Host and no proxy headers', () => {
  for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) for (const host of ['localhost:5173', 'localhost', '127.0.0.1:4173', '[::1]:5173', 'LocalHost:80']) assert.equal(isLocalRequest(req(addr, { host })), true, addr + ' ' + host);
  assert.equal(isLocalRequest(req('192.168.1.20')), false, 'a LAN client');
  assert.equal(isLocalRequest(req('10.0.0.5', { host: '10.0.0.5:5173' })), false);
  assert.equal(isLocalRequest(req('::ffff:192.168.1.20')), false);
  assert.equal(isLocalRequest(req(undefined)), false, 'no address');
  assert.equal(isLocalRequest({ url: '/', headers: { host: 'localhost' } }), false, 'no socket');
  // a tunnel connects from this machine (loopback) but with its own Host and proxy headers
  assert.equal(isLocalRequest(req('127.0.0.1', { host: 'abc-def-123.trycloudflare.com' })), false, 'a Cloudflare tunnel');
  assert.equal(isLocalRequest(req('127.0.0.1', { host: 'localhost:5173', 'x-forwarded-for': '203.0.113.9' })), false);
  assert.equal(isLocalRequest(req('::1', { host: 'localhost:5173', 'cf-connecting-ip': '203.0.113.9' })), false);
  assert.equal(isLocalRequest(req('127.0.0.1', { host: 'localhost:5173', 'cf-ray': 'abc' })), false);
  assert.equal(isLocalRequest(req('127.0.0.1', { host: 'localhost.evil.com' })), false, 'a look-alike host');
  assert.equal(isLocalRequest(req('127.0.0.1', {})), false, 'no Host header');
});

test('local guard: the middleware answers 403 (no-store, no file) for a stranger and lets the owner and every other path through', () => {
  const stranger = run(req('192.168.1.20', { host: '192.168.1.5:5173' }));
  assert.deepEqual([stranger.next, stranger.status], [false, 403]);
  assert.equal(stranger.headers['cache-control'], 'no-store');
  assert.ok(!stranger.body.includes('glTF'));
  const tunnel = run(req('127.0.0.1', { host: 'x.trycloudflare.com' }, '/pajzsugras/local-sounds/jump1.wav'));
  assert.deepEqual([tunnel.next, tunnel.status], [false, 403]);
  const owner = run(req('127.0.0.1'));
  assert.deepEqual([owner.next, owner.status], [true, 0]);
  const other = run(req('192.168.1.20', { host: '192.168.1.5:5173' }, '/pajzsugras/main.js'));
  assert.deepEqual([other.next, other.status], [true, 0], 'the game itself is open to the LAN as before');
  const hago = run(req('127.0.0.1', { host: 'x.trycloudflare.com' }, '/hago/index.html'));
  assert.deepEqual([hago.next, hago.status], [true, 0], 'other games are unaffected');
  const plugin = localAssetsPlugin();
  const used = [];
  plugin.configureServer({ middlewares: { use: (f) => used.push(f) } });
  plugin.configurePreviewServer({ middlewares: { use: (f) => used.push(f) } });
  assert.equal(used.length, 2, 'registered on the dev server and on the preview server');
});

test('local guard: pajzsugras/local-maps/ (maps ported from someone else\'s UT2004 map) is local-only too: remote and tunnel clients get 403, this machine and the neighbouring paths get through', () => {
  for (const u of ['/pajzsugras/local-maps/x.json', '/pajzsugras/local-maps/hopphopp.json?t=1', '/pajzsugras/local-maps/', '/pajzsugras/local-maps', '/PAJZSUGRAS/Local-Maps/X.json',
    '/@fs/D:/izsi/lol/pajzsugras/local-maps/hopphopp.json', '/pajzsugras/x/../local-maps/x.json', '/pajzsugras/%6cocal-maps/x.json', '/pajzsugras/%256cocal-maps/x.json', '/pajzsugras\\local-maps\\x.json',
    '//pajzsugras//local-maps//x.json']) assert.equal(isLocalOnly(u), true, u);
  for (const u of ['/pajzsugras/local-mapsX/x.json', '/pajzsugras/local-map/x.json', '/pajzsugras/maps/uj-palya.js', '/pajzsugras/tools/ut2004_map.py', '/hago/local-maps/x.json', '/assets/local-maps.js']) assert.equal(isLocalOnly(u), false, u);
  const url = '/pajzsugras/local-maps/x.json';
  for (const [who, r] of [['a LAN client', req('192.168.1.20', { host: '192.168.1.5:5173' }, url)], ['a tunnel', req('127.0.0.1', { host: 'abc.trycloudflare.com' }, url)],
    ['a proxied request', req('127.0.0.1', { host: 'localhost:5173', 'x-forwarded-for': '203.0.113.9' }, url)], ['no address', req(undefined, { host: 'localhost' }, url)]]) {
    const o = run(r);
    assert.deepEqual([o.next, o.status], [false, 403], who);
    assert.equal(o.headers['cache-control'], 'no-store', who);
    assert.ok(!o.body.includes('"items"'), who + ': no map text in the answer');
  }
  for (const [addr, host] of [['127.0.0.1', 'localhost:5173'], ['::1', '[::1]:5173'], ['::ffff:127.0.0.1', '127.0.0.1:4173']]) {
    const o = run(req(addr, { host }, url));
    assert.deepEqual([o.next, o.status], [true, 0], 'this machine: ' + addr + ' ' + host);
  }
});

test('local guard: the real Vite dev server (vite.config.ts) serves the local folders to this machine and answers 403 to a tunnel Host, a proxied request and tricks', async () => {
  const { createServer } = await import('vite');
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const server = await createServer({ root, configFile: fileURLToPath(new URL('../../vite.config.ts', import.meta.url)), logLevel: 'silent', server: { host: '127.0.0.1', port: 0, strictPort: false } });
  try {
    await server.listen();
    const port = server.httpServer.address().port;
    const get = (path, headers = {}) => new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, path, headers: { host: `localhost:${port}`, ...headers } }, (resp) => { resp.resume(); resp.on('end', () => resolve(resp.statusCode)); });
      r.on('error', reject);
      r.end();
    });
    const tunnel = { host: 'abc-def.trycloudflare.com' };
    for (const file of ['gorge.glb', 'gorge-body.png', 'gorge-head.png', 'shieldgun-1st.glb', 'shieldgun-3rd.glb', 'shieldgun.png']) {
      assert.equal(await get('/pajzsugras/local-models/' + file, tunnel), 200, 'deployed model is also available through a tunnel: ' + file);
    }
    for (const [path, headers] of [['/pajzsugras/local-models/private.glb', tunnel], ['/pajzsugras/local-sounds/sounds.json', tunnel], ['/pajzsugras/local-models/private.glb', { 'x-forwarded-for': '203.0.113.9' }],
      ['/pajzsugras/x/../local-models/private.glb', tunnel], ['/pajzsugras/%6cocal-sounds/jump1.wav', tunnel], ['/pajzsugras/local-maps/hopphopp.json', tunnel],
      ['/pajzsugras/local-maps/hopphopp.json', { 'x-forwarded-for': '203.0.113.9' }], ['/pajzsugras/%6cocal-maps/hopphopp.json', tunnel], ['/@fs/' + root.replace(/\\/g, '/') + 'pajzsugras/local-models/private.glb', tunnel]]) {
      assert.equal(await get(path, headers), 403, path + ' ' + JSON.stringify(headers));
    }
    assert.notEqual(await get('/pajzsugras/local-models/private.glb'), 403, 'this machine, through localhost, is not refused');
    assert.notEqual(await get('/pajzsugras/local-maps/hopphopp.json'), 403, 'this machine, through localhost, may open a ported map (404 when it is not there)');
    assert.equal(await get('/pajzsugras/main.js', tunnel), 200, 'the game code itself is served to the tunnel as before');
    assert.equal(await get('/hago/index.html', tunnel), 200, 'and the other games');
  } finally {
    await server.close();
  }
});
