import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { savePrivate } from '../portable/private-file.mjs';
import { runHub } from '../portable/run-hub.mjs';
import { runRunner } from '../portable/run-runner.mjs';

// Stage 1 of SPLIT_HUB_RUNNER.md: `run hub` and `run agent` as separate
// services, each with its own /healthz and a shutdown that never waits on
// peers. The gateway and agent are injected; their protocol behaviour across a
// hub replacement is covered by portable-hub-replacement.test.mjs.
const freePort = () => new Promise(resolve => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const SOURCE = 'd'.repeat(40);
function directory(t) { const root = mkdtempSync(join(tmpdir(), 'split-')); chmodSync(root, 0o700); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }
async function hubConfig(t, extra = {}) {
  const root = directory(t), path = join(root, 'hub.json');
  savePrivate(path, JSON.stringify({ version: 1, mode: 'hub', dataDirectory: join(root, 'hub'), gatewayPort: await freePort(), sitePort: await freePort(), healthPort: await freePort(),
    externalSite: true, teamWorkspaceRoot: join(root, 'bots'), publicOrigin: 'https://work.example.test', owner: { key: 'owner', userId: 'user' }, identityBindings: [],
    gatewaySecret: 'x'.repeat(43), hub: { source: SOURCE }, ...extra }));
  return path;
}
function fakeGateway({ voiceIdle = () => true } = {}) {
  const calls = [];
  const start = config => {
    const server = createServer((req, res) => res.end('gateway')).listen(config.gatewayPort, '127.0.0.1');
    const gateway = { server, config, writer: true, router: { connections: new Map([['node-one', {}]]) },
      controls: { assertWriter() { if (!gateway.writer) throw Error('frozen'); } },
      voice: { idle: voiceIdle, status: () => ({ sockets: voiceIdle() ? 0 : 1 }), async drain() { if (!voiceIdle()) throw Error('voice busy'); calls.push('voice.drain'); } },
      async close() { calls.push('gateway.close'); await new Promise(r => server.close(r)); } };
    start.gateway = gateway; return gateway;
  };
  start.calls = calls; return start;
}
const health = async port => { const r = await fetch(`http://127.0.0.1:${port}/healthz`); return { http: r.status, ...await r.json() }; };

test('run hub serves front-facing hub health that never requires a runner', async t => {
  const path = await hubConfig(t), start = fakeGateway();
  const hub = await runHub(path, { startGateway: start, signals: false, siteHealth: async () => true });
  t.after(() => hub.close().catch(() => {}));
  const port = start.gateway.config.healthPort, h = await health(port);
  assert.deepEqual({ http: h.http, ready: h.ready, role: h.role, source: h.source, nodes: h.nodes, relayConnected: h.relayConnected, siteReady: h.siteReady },
    { http: 200, ready: true, role: 'hub', source: SOURCE, nodes: ['node-one'], relayConnected: true, siteReady: true });
  start.gateway.router.connections.clear();
  assert.equal((await health(port)).ready, true, 'a disconnected runner does not make the hub unready');
  start.gateway.writer = false;
  const frozen = await health(port);
  assert.deepEqual({ http: frozen.http, ready: frozen.ready, writer: frozen.writer }, { http: 503, ready: false, writer: { ready: false } });
  assert.equal(hub.child, null, 'externalSite: the separately supervised site is not spawned');
});

test('run hub refuses a combined or agent configuration', async t => {
  const combined = await hubConfig(t, { mode: 'both' });
  await assert.rejects(runHub(combined, { startGateway: fakeGateway(), signals: false }), /mode "hub"/);
  const named = await hubConfig(t, { agentConfigFile: '/somewhere/agent.json' });
  await assert.rejects(runHub(named, { startGateway: fakeGateway(), signals: false }), /names no agent configuration/);
});

test('hub shutdown drains voice first, then closes despite keep-alive peers', async t => {
  let busy = true;
  const path = await hubConfig(t), start = fakeGateway({ voiceIdle: () => !busy });
  const hub = await runHub(path, { startGateway: start, signals: false, siteHealth: async () => true });
  // A pooled keep-alive client, like dawar-portable-front.
  const agent = new (await import('node:http')).Agent({ keepAlive: true });
  await new Promise((resolve, reject) => request({ port: start.gateway.config.healthPort, path: '/healthz', agent }, res => { res.resume(); res.on('end', resolve); }).on('error', reject).end());
  await assert.rejects(hub.close(), /voice busy/, 'active voice work refuses the stop');
  assert.deepEqual(start.calls, []);
  busy = false;
  await hub.close();
  assert.deepEqual(start.calls, ['voice.drain', 'gateway.close']);
  agent.destroy();
});

function fakeAgent({ relayOnline = true, claimed = false } = {}) {
  const calls = [];
  const runtime = { ready: true, relayOnline, models: [{ model: 'gpt-test', provider: 'codex' }], codex: { claudeReady: false, close: () => calls.push('codex.close') },
    store: { bots: () => [], close: () => calls.push('store.close') }, usage: { stop() {} }, desktops: null, secure: null,
    maintenance: { snapshot: () => ({ phase: claimed ? 'claimed' : 'open' }), counts: () => ({ nativeRpc: 0 }), current: claimed ? { phase: 'claimed' } : null,
      async prepareShutdown() { if (!claimed) throw Error('An unexpired original restart claim is required for shutdown.'); }, close() {} } };
  const agent = { runtime, source: SOURCE, transport: { startupReady: true, pending: new Map(), controlPending: new Map(), enrollment: { nodeId: 'node-one' }, hello: () => ({ capabilities: {} }), close: () => calls.push('transport.close') },
    journal: { close() {} }, manager: { async close() { calls.push('manager.close'); } } };
  return { agent, calls, runAgent: async () => agent };
}
async function agentConfig(t, port) {
  const root = directory(t), path = join(root, 'agent.json');
  savePrivate(path, JSON.stringify({ version: 1, mode: 'agent', dataDirectory: join(root, 'agent'), agent: { healthPort: port, centralRouting: true, loopbackHubPort: 3210 } }));
  return path;
}

test('run agent serves runner health: own readiness, hub connection reported separately', async t => {
  const port = await freePort(), fake = fakeAgent({ relayOnline: false });
  const runner = await runRunner(await agentConfig(t, port), { runAgent: fake.runAgent, signals: false });
  t.after(() => runner.health.close());
  const h = await health(port);
  assert.deepEqual({ http: h.http, ready: h.ready, role: h.role, relayConnected: h.relayConnected, source: h.source, models: h.models, phase: h.maintenance.phase },
    { http: 200, ready: true, role: 'runner', relayConnected: false, source: SOURCE, models: ['gpt-test'], phase: 'open' });
  fake.agent.runtime.relayOnline = true;
  assert.equal((await health(port)).relayConnected, true, 'reconnects after a hub restart show up without a runner restart');
});

test('run agent shutdown keeps the claimed-drain rule of the combined process', async t => {
  const port = await freePort(), unclaimed = fakeAgent();
  const runner = await runRunner(await agentConfig(t, port), { runAgent: unclaimed.runAgent, signals: false });
  await assert.rejects(runner.close(), /restart claim/);
  assert.deepEqual(unclaimed.calls, [], 'nothing closed without the claim');
  runner.health.close();
  const claimed = fakeAgent({ claimed: true }), other = await freePort();
  const proven = await runRunner(await agentConfig(t, other), { runAgent: claimed.runAgent, signals: false });
  await proven.close();
  assert.deepEqual(claimed.calls, ['transport.close', 'codex.close', 'manager.close', 'store.close']);
  await assert.rejects(fetch(`http://127.0.0.1:${other}/healthz`), 'health closed');
});
