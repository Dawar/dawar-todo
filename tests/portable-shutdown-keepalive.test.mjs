import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, Agent } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { startPublicFront } from '../portable/public-front.mjs';
import { closeHttpServer } from '../portable/close-http.mjs';

const freePort = () => new Promise(resolve => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const listening = server => new Promise(resolve => server.listening ? resolve() : server.once('listening', resolve));

// The 2026-10-14 hang: dawar-portable-front proxies browsers to the backend
// gateway through Node's keep-alive agent. While browsers keep polling, every
// pooled socket is reused before it is ever idle, and event streams never end,
// so the backend's `server.close()` never called back.
async function frontAndBackend(t) {
  const backend = createServer((req, res) => {
    if (req.url === '/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: open\n\n'); return; }
    setTimeout(() => res.end(JSON.stringify({ ok: true })), 5);
  });
  const sockets = new WebSocketServer({ noServer: true });
  backend.on('upgrade', (req, socket, head) => sockets.handleUpgrade(req, socket, head, ws => ws.send('hello')));
  backend.listen(0, '127.0.0.1'); await listening(backend);
  const [listenPort, sitePort, healthPort, tunnelMetricsPort] = [await freePort(), await freePort(), await freePort(), await freePort()];
  const front = startPublicFront({ version: 1, kind: 'dawar-public-front', publicOrigin: 'https://work.example.test', listenPort,
    upstreamPort: backend.address().port, sitePort, healthPort, tunnelMetricsPort },
  { monitorFactory: () => ({ status: () => null, check() {}, close() {} }) });
  await listening(front.server);
  const browser = new Agent({ keepAlive: true, maxSockets: 4 });
  const get = path => new Promise(resolve => {
    const r = request({ port: listenPort, path, agent: browser, headers: { host: 'work.example.test' } }, res => {
      if (path === '/events') return resolve(res.statusCode);
      res.resume(); res.on('end', () => resolve(res.statusCode)); res.on('error', () => resolve(0));
    });
    r.on('error', () => resolve(0)); r.end();
  });
  let polling = true;
  const poll = (async () => { while (polling) await get('/api/bots/state'); })();
  assert.equal(await get('/events'), 200);
  const ws = new WebSocket(`ws://127.0.0.1:${listenPort}/connect`, { headers: { origin: 'https://work.example.test', host: 'work.example.test' } });
  ws.on('error', () => {});
  await new Promise(resolve => ws.once('message', resolve));
  await new Promise(resolve => setTimeout(resolve, 100));
  t.after(async () => {
    polling = false; ws.terminate(); browser.destroy(); backend.closeAllConnections(); backend.close();
    await front.close(); await poll;
  });
  return { backend, sockets, get };
}

test('reproduces stop-sigterm: plain close never returns while the front holds keep-alive connections', async t => {
  const f = await frontAndBackend(t);
  let closed = false; f.backend.close(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(closed, false, 'the backend should still be waiting on front connections');
});

test('after a proven drain the backend closes keep-alive, streaming and WebSocket connections and exits promptly', async t => {
  const f = await frontAndBackend(t);
  const started = Date.now();
  await closeHttpServer(f.backend, { graceMs: 300, sockets: () => f.sockets.clients });
  assert.ok(Date.now() - started < 2000, `close took ${Date.now() - started}ms`);
  assert.equal(f.backend.listening, false);
  // The persistent front keeps serving its maintenance response meanwhile.
  assert.equal(await f.get('/api/bots/state'), 503);
});

test('an idle server closes immediately and a stopped server does not block', async () => {
  const server = createServer((_, res) => res.end()); server.listen(0, '127.0.0.1'); await listening(server);
  await closeHttpServer(server, { graceMs: 5000 });
  await closeHttpServer(server, { graceMs: 5000 });
});

test('the bounded-close backstop arms only after the claimed idle proof', async () => {
  const { combinedShutdown } = await import('../portable/combined-shutdown.mjs');
  const make = proof => {
    const events = [], noop = name => () => { events.push(name); };
    const agent = { runtime: { maintenance: { prepareShutdown: proof, counts: () => ({}), close: noop('maintenance') }, usage: { stop() {} }, codex: { close() {} }, store: { close() {} } },
      transport: { pending: new Map(), controlPending: new Map(), close() {} }, manager: { close() {} }, journal: { close() {} } };
    return { events, close: combinedShutdown({ agent, gateway: { close: noop('gateway') }, health: { close() {}, closeAllConnections: noop('health-connections') }, stopping() {}, effectsStarted: noop('backstop') }) };
  };
  const refused = make(async () => { throw Error('not claimed'); });
  await assert.rejects(refused.close(), /not claimed/);
  assert.deepEqual(refused.events, []);
  const proven = make(async () => {});
  await proven.close();
  assert.deepEqual(proven.events.slice(0, 3), ['backstop', 'gateway', 'health-connections']);
});
