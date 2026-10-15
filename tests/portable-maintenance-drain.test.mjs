import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderRouter } from '../bot-bridge/provider-router.mjs';
import { CodexManager, maintenanceReason } from '../bot-bridge/manager.mjs';
import { Store } from '../bot-bridge/store.mjs';
import { RuntimeMaintenance } from '../bot-bridge/runtime-maintenance.mjs';

class Backend extends EventEmitter {
  constructor() { super(); this.ready = true; this.pending = new Map(); this.waiting = []; }
  call(method, params) { return new Promise(resolve => this.waiting.push({ method, params, resolve })); }
}

test('in-flight Claude backend requests are counted in the maintenance drain', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'claude-drain-')), store = new Store(join(directory, 'control.sqlite'));
  const codex = new Backend(), claude = new Backend(), router = new ProviderRouter({ codex, claude });
  const maintenance = new RuntimeMaintenance({ store, epoch: 'e', codex: router }, { source: () => {}, invocation: 'i' });
  t.after(() => { maintenance.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal(maintenance.counts().nativeRpc, 0);
  codex.pending.set(7, { method: 'thread/read', threadId: 'codex-thread' });
  const call = router.call('turn/start', { threadId: 'claude:abc' });
  assert.equal(maintenance.counts().nativeRpc, 2, 'one Codex and one Claude request in flight');
  assert.ok([...router.pending.values()].some(p => p.threadId === 'claude:abc' && p.method === 'turn/start'), 'per-thread work views see the Claude call');
  claude.waiting[0].resolve({ ok: true }); await call; codex.pending.clear();
  assert.equal(maintenance.counts().nativeRpc, 0);
  const failing = router.call('thread/read', { threadId: 'claude:abc' });
  claude.waiting[1].resolve(Promise.reject(Error('session closed')));
  await assert.rejects(failing, /session closed/);
  assert.equal(router.pending.size, 0, 'a failed Claude call is no longer in flight');
});

test('a maintenance 409 carries a bounded reason', async () => {
  const runtime = { codex: {}, maintenance: { control: async () => { throw Error('Fresh drained state is not proven; no restart authorized.'); } } };
  const manager = new CodexManager({ runtime, store: {}, directory: tmpdir(), maintenanceCredential: 'x'.repeat(40) });
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ action: 'seal' }))]), { method: 'POST', headers: { authorization: `Bearer ${'x'.repeat(40)}` } });
  let status, body;
  const res = { writeHead(s) { status = s; return this; }, end(text) { body = JSON.parse(text); } };
  await manager.maintenanceRequest(req, res);
  assert.equal(status, 409);
  assert.equal(body.reason, 'Fresh drained state is not proven; no restart authorized.');
  assert.match(body.error, /Maintenance blocked/);
  assert.equal(maintenanceReason(Error(`Bearer secret-token ${'z'.repeat(400)}`)).includes('secret-token'), false);
  assert.ok(maintenanceReason(Error('y '.repeat(400))).length <= 300);
});
