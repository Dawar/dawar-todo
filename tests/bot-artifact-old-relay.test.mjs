import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import ts from 'typescript';
import { Store } from '../bot-bridge/store.mjs';
import { BotRuntime } from '../bot-bridge/runtime.mjs';
import { bridgeResponse } from '../bot-bridge/response.mjs';
import { runtime as browserRuntime } from './helpers/load-ts.mjs';
import { syntheticArtifactPdf } from './fixtures/bot-artifact-files.mjs';

test('gallery metadata, previews and original multi-chunk download traverse actual old relay -> real owner-scoped client', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'artifact-relay-contract-')), store = new Store(join(dir, 'state.sqlite'));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const bot = { id: 'synthetic-artifact-bot', slug: 'synthetic', name: 'Synthetic', threadId: 'synthetic-thread', cwd: join(dir, 'bot'), color: '#123456' };
  await mkdir(bot.cwd); store.saveBot(bot);
  const runtime = new BotRuntime({ store, codex: new EventEmitter(), root: dir });
  const bytes = Buffer.alloc(600_000, 73); await writeFile(join(bot.cwd, 'original.bin'), bytes);
  const { attachmentId } = await runtime.publishArtifact(bot, { path: 'original.bin' });
  const env = browserRuntime({ Blob, Error, btoa, atob, WebSocket: { OPEN: 1 }, setTimeout, clearTimeout });
  const client = new (env.load('app/bots/client.ts').BotsClient)(); client.owner = 'synthetic-owner'; client.online = true;
  const oldSource = execFileSync('git', ['show', '80a3826e3617a2fa39ba6a7a051d82d95d0e304d:bots-relay/src/index.ts'], { encoding: 'utf8' });
  const exports = {};
  vm.runInNewContext(ts.transpileModule(oldSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports, crypto, Date, JSON, Error, WebSocket: { OPEN: 1 }, require(name) {
      if (name === 'cloudflare:workers') return { DurableObject: class { constructor(ctx) { this.ctx = ctx; } } };
      if (name === '../../lib/bots-auth') return {};
      throw new Error('Unexpected relay dependency');
    },
  });
  const socket = (id, role, send) => ({ readyState: 1, send, deserializeAttachment: () => ({ id, role, owner: client.owner, expiresAt: Date.now() + 60000 }) });
  const browser = socket('synthetic-browser', 'browser', (json) => client.receive(JSON.parse(json)));
  const methods = [], failures = [];
  const machine = socket('synthetic-machine', 'machine', (json) => {
    const request = JSON.parse(json); methods.push(request.method);
    void bridgeResponse(runtime, request).then((reply) => relay.webSocketMessage(machine, JSON.stringify(reply))).catch((error) => failures.push(error));
  });
  const relay = new exports.BotRelay({ getWebSockets: () => [browser, machine] });
  client.socket = { readyState: 1, send: (json) => { void relay.webSocketMessage(browser, json); } };
  const page = await client.rpc('artifacts.list', undefined, {}, undefined, { owner: client.owner });
  assert.equal(page.items[0].id, attachmentId); assert.equal(page.items[0].botId, bot.id); assert.equal(page.items[0].size, bytes.length);
  assert.equal('path' in page.items[0], false);
  assert.deepEqual(methods, ['artifacts.list']); // No file bytes/history fetched for cards.
  const preview = await client.rpc('artifacts.preview', bot.id, { id: attachmentId }, undefined, { owner: client.owner });
  assert.equal(preview.status, 'unavailable');
  const download = await client.download(bot.id, attachmentId, client.owner);
  assert.equal(download.name, 'original.bin'); assert.deepEqual(Buffer.from(await download.blob.arrayBuffer()), bytes);
  assert.equal(methods.filter((m) => m === 'attachments.read').length, 3);
  const pdf = syntheticArtifactPdf(); await writeFile(join(bot.cwd, 'report.pdf'), pdf);
  const publication = await runtime.publishArtifact(bot, { path: 'report.pdf' });
  const pdfPage = await client.rpc('artifacts.list', bot.id, { type: 'pdf' }, undefined, { owner: client.owner });
  const pdfItem = pdfPage.items[0]; assert.equal(pdfItem.id, publication.attachmentId);
  const pdfPreview = await client.rpc('artifacts.preview', bot.id, { id: pdfItem.id, version: pdfItem.preview.version }, undefined, { owner: client.owner });
  assert.equal(pdfPreview.status, 'ready', pdfPreview.reason); assert.equal(pdfPreview.mimeType, 'image/webp');
  assert.ok(pdfPreview.width <= 512 && pdfPreview.height <= 512);
  assert.equal(Buffer.from(pdfPreview.data, 'base64').toString('ascii', 0, 4), 'RIFF');
  const originalPdf = await client.download(bot.id, pdfItem.id, client.owner);
  assert.equal(originalPdf.blob.type, 'application/pdf'); assert.deepEqual(Buffer.from(await originalPdf.blob.arrayBuffer()), pdf);
  await assert.rejects(client.download(bot.id, attachmentId, 'different-owner'), /owner|account|identity|changed/i);
  assert.deepEqual(failures, []);
});
