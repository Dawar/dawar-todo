import { createServer, request as httpRequest } from 'node:http';
import {publicMonitor} from './public-monitor.mjs';

const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const publicFiles = new Set(['/sw.js', '/pwa-build.json', '/manifest.json', '/manifest.webmanifest', '/favicon.ico']);
const maintenancePage = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DawarTodo</title><style>html{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f8f6;color:#24372e;font:16px system-ui,sans-serif}main{max-width:28rem;padding:2rem}h1{font-size:1.6rem}p{line-height:1.5;color:#5c6b62}a{display:inline-block;padding:.75rem 1rem;background:#216d50;color:white;border-radius:.7rem;text-decoration:none}@media(prefers-color-scheme:dark){body{background:#15231c;color:#edf4ee}p{color:#bacbbf}}</style><main><h1>DawarTodo is reconnecting</h1><p>The service is temporarily unavailable. Try again shortly.</p><a href="/">Try again</a></main></html>`;

export function publicFrontConfiguration(value) {
  const keys = ['version', 'kind', 'publicOrigin', 'listenPort', 'upstreamPort', 'sitePort','healthPort','tunnelMetricsPort'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length ||
      Object.keys(value).some(k => !keys.includes(k)) || value.version !== 1 || value.kind !== 'dawar-public-front')
    throw Error('Invalid public front configuration.');
  const origin = new URL(value.publicOrigin);
  if (origin.protocol !== 'https:' || origin.origin !== value.publicOrigin || origin.username || origin.password)
    throw Error('A fixed HTTPS public origin is required.');
  const ports = [value.listenPort, value.upstreamPort, value.sitePort,value.healthPort,value.tunnelMetricsPort];
  if (ports.some(p => !Number.isInteger(p) || p < 1024 || p > 65535) || new Set(ports).size !== ports.length)
    throw Error('Public front ports must be distinct loopback ports.');
  return Object.freeze({ ...value });
}

export function publicAsset(path) {
  if (publicFiles.has(path)) return true;
  if (!path.startsWith('/_next/static/') && !path.startsWith('/portable-assets/')) return false;
  try { return path.split('/').every(s => { const decoded = decodeURIComponent(s); return decoded !== '.' && decoded !== '..' && !/[\\/\0]/.test(decoded); }); }
  catch { return false; }
}

function headersFor(headers, asset = false) {
  const named = String(headers.connection ?? '').split(',').map(s => s.trim().toLowerCase());
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !hopHeaders.has(key.toLowerCase()) && !named.includes(key.toLowerCase()) &&
    (!asset || ['host', 'accept', 'accept-encoding', 'range', 'if-none-match', 'if-modified-since', 'user-agent'].includes(key.toLowerCase()))));
}

function unavailable(req, res, outcome) {
  if (res.headersSent || res.destroyed) return res.destroy();
  const html = req.method === 'GET' && (req.headers.accept ?? '').includes('text/html');
  const body = html ? maintenancePage : JSON.stringify({
    error: outcome === 'rejected' ? 'DawarTodo is unavailable. This request was not submitted.' : 'Connection interrupted. Check the original delivery before retrying.',
    code: outcome === 'rejected' ? 'service-unavailable' : 'delivery-unconfirmed', outcome,
  });
  res.writeHead(503, { 'content-type': html ? 'text/html; charset=utf-8' : 'application/json',
    'cache-control': 'no-store', 'retry-after': '10', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" });
  res.end(req.method === 'HEAD' ? undefined : body);
}

// This process owns no application/control database, native thread or scheduler.
// Requests stream through the existing authenticated gateway. Only fixed public
// assets may use the standalone site when the gateway is unreachable.
export function startPublicFront(value, { request = httpRequest,monitorFactory=publicMonitor } = {}) {
  const config = publicFrontConfiguration(value), connections = new Set();
  const monitor=monitorFactory(config);
  let originReachable = null, lastOriginCheck = null, stopping = false;
  const observed = reachable => { originReachable = reachable; lastOriginCheck = new Date().toISOString(); };
  const server = createServer((req, res) => {
    let url;
    try { url = new URL(req.url, config.publicOrigin); if (url.origin !== config.publicOrigin) throw Error('Foreign origin.'); }
    catch { res.writeHead(400).end(); return; }
    if (url.pathname === '/_service/status' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ frontReady: !stopping,
        originReachable: lastOriginCheck && Date.now() - Date.parse(lastOriginCheck) < 30000 ? originReachable : null, lastOriginCheck,
        health:monitor.status() })); return;
    }
    if (stopping) return unavailable(req, res, 'rejected');
    const forward = (port, asset = false) => {
      let connected = false, responded = false, dialTimer, responseTimer;
      const clearTimers = () => { clearTimeout(dialTimer); clearTimeout(responseTimer); };
      const upstream = request({ host: '127.0.0.1', port, path: req.url, method: req.method, headers: headersFor(req.headers, asset) }, response => {
        responded = true; clearTimers(); if (!asset) observed(true);
        res.writeHead(response.statusCode ?? 502, headersFor(response.headers));
        response.on('error', () => res.destroy()); res.on('close', () => response.destroy()); response.pipe(res);
      });
      upstream.on('socket', socket => {
        if (!socket.connecting) { connected = true; return; }
        dialTimer = setTimeout(() => upstream.destroy(Error('Origin connection timeout.')), 3000);
        dialTimer.unref();
        socket.once('connect', () => { connected = true; clearTimeout(dialTimer); });
      });
      upstream.once('finish', () => {
        if (responded) return;
        responseTimer = setTimeout(() => upstream.destroy(Error('Origin response timeout.')), 90000); responseTimer.unref();
      });
      upstream.on('error', () => {
        clearTimers(); if (responded || res.destroyed) return;
        if (!asset) observed(false);
        if (!asset && ['GET', 'HEAD'].includes(req.method) && publicAsset(url.pathname)) return forward(config.sitePort, true);
        unavailable(req, res, connected ? 'uncertain' : 'rejected');
      });
      req.once('aborted', () => upstream.destroy());
      res.once('close', () => { if (!res.writableFinished) upstream.destroy(); });
      if (asset) upstream.end(); else req.pipe(upstream);
    };
    forward(config.upstreamPort);
  });
  server.on('connection', socket => { connections.add(socket); socket.once('close', () => connections.delete(socket)); });
  server.on('upgrade', (req, client, head) => {
    try {
      if (req.method !== 'GET' || req.headers.upgrade?.toLowerCase() !== 'websocket' || new URL(req.url, config.publicOrigin).origin !== config.publicOrigin)
        throw Error('Invalid upgrade.');
    } catch { client.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return; }
    if (stopping) { client.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: 10\r\n\r\n'); return; }
    let connected = false, upgraded = false;
    const upstream = request({ host: '127.0.0.1', port: config.upstreamPort, method: req.method, path: req.url,
      headers: { ...headersFor(req.headers), connection: 'Upgrade', upgrade: req.headers.upgrade } });
    const timer = setTimeout(() => upstream.destroy(Error('Upgrade timeout.')), 10000); timer.unref();
    upstream.on('socket', socket => socket.once('connect', () => { connected = true; }));
    upstream.on('upgrade', (response, socket, upstreamHead) => {
      upgraded = true; clearTimeout(timer); observed(true);
      client.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n${response.rawHeaders.reduce((s, v, i, a) => i % 2 ? s : s + v + ': ' + a[i + 1] + '\r\n', '')}\r\n`);
      if (upstreamHead.length) client.write(upstreamHead); if (head.length) socket.write(head);
      socket.on('error', () => client.destroy()); client.on('error', () => socket.destroy());
      socket.on('close', () => client.destroy()); client.on('close', () => socket.destroy());
      socket.pipe(client); client.pipe(socket);
    });
    upstream.on('response', response => { clearTimeout(timer); observed(true); response.resume(); client.end(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\nConnection: close\r\n\r\n`); });
    upstream.on('error', () => {
      clearTimeout(timer); observed(false);
      if (upgraded) return client.destroy();
      if (!client.destroyed) client.end(`HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nX-Dawar-Outcome: ${connected ? 'uncertain' : 'rejected'}\r\n\r\n`);
    });
    client.once('close', () => upstream.destroy()); upstream.end();
  });
  server.listen(config.listenPort, '127.0.0.1');
  server.once('listening',()=>void monitor.check());
  let closing;
  const close = () => closing ??= new Promise(resolve => {
    stopping = true; monitor.close();server.close(resolve); server.closeIdleConnections();
    const timer = setTimeout(() => { for (const socket of connections) socket.destroy(); }, 15000); timer.unref();
    server.once('close', () => clearTimeout(timer));
  });
  return { server, close };
}
