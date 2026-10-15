import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { Store } from './store.mjs';
import { BotRuntime } from './runtime.mjs';
import { BOT_INSTRUCTIONS, FILE_DELIVERY_INSTRUCTIONS, RUN_INSTRUCTIONS, threadInstructions } from './profiles.mjs';
import { localFileLink, matchLocalArtifact } from '../lib/local-file-link.mjs';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'bot-file-delivery-'));
  const store = new Store(join(root, 'state.sqlite'));
  const codex = new EventEmitter(); codex.call = async () => ({ data: [], nextCursor: null });
  const runtime = new BotRuntime({ store, codex, root });
  const bots = [];
  for (const id of ['alpha', 'beta']) {
    const bot = { id, slug: id, name: id, threadId: `thread-${id}`, cwd: join(root, id), color: '#123456', archived: false, updatedAt: '2026-01-01T00:00:00.000Z' };
    await mkdir(join(bot.cwd, 'outputs'), { recursive: true }); store.saveBot(bot); bots.push(bot);
  }
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, store, runtime, bots };
}

test('common bot policy tells every bot to deliver files through the registered publisher', () => {
  for (const text of [BOT_INSTRUCTIONS, RUN_INSTRUCTIONS, threadInstructions({ id: 'x', cwd: '/tmp/x' })]) assert.ok(text.includes(FILE_DELIVERY_INSTRUCTIONS));
  assert.match(FILE_DELIVERY_INSTRUCTIONS, /bots_publish_artifact/);
  assert.match(FILE_DELIVERY_INSTRUCTIONS, /Never describe a file as delivered because it was saved/);
  assert.match(FILE_DELIVERY_INSTRUCTIONS, /intentional copy inside your own outputs folder/);
  assert.match(FILE_DELIVERY_INSTRUCTIONS, /Summarize routine setup or status information directly in chat/);
});

test('a published file records its exact source path so the app can match a local-path link', async (t) => {
  const { runtime, store, bots: [alpha, beta] } = await setup(t);
  const source = join(alpha.cwd, 'outputs', 'Baseline review.txt');
  await writeFile(source, 'baseline\n');
  const first = await runtime.publishArtifact(alpha, { path: 'outputs/Baseline review.txt' }, { key: 'publish:call-1' });
  const again = await runtime.publishArtifact(alpha, { path: 'outputs/Baseline review.txt' }, { key: 'publish:call-1' });
  assert.equal(again.attachmentId, first.attachmentId, 'same original publication ID coalesces');
  const record = store.get('attachment', first.attachmentId);
  assert.deepEqual(record.localReferences, [source]);
  const exposed = runtime.publicAttachment(record);
  assert.equal(exposed.path, undefined, 'artifact metadata still omits the storage path field');
  assert.ok(exposed.localReferences.includes(source) && exposed.localReferences.includes(record.path));

  // Markdown absolute path, file: URL and relative output shape resolve to the same registered copy.
  const cwd = alpha.cwd;
  for (const href of [encodeURI(source), `file://${encodeURI(source)}`, 'outputs/Baseline%20review.txt', `${encodeURI(source)}:12`]) {
    const link = localFileLink(href, cwd);
    assert.equal(link?.path, source, href);
    const match = matchLocalArtifact(link, alpha.id, [exposed]);
    assert.equal(match.state, 'registered'); assert.equal(match.attachment.id, first.attachmentId);
  }
  // Another bot's registered file never answers for this bot, even with the same path text.
  assert.equal(matchLocalArtifact(localFileLink(source, cwd), beta.id, [exposed]).state, 'unregistered');
});

test('changed bytes at the same source make a new copy; private and outside paths stay unregistered', async (t) => {
  const { runtime, store, root, bots: [alpha] } = await setup(t);
  const source = join(alpha.cwd, 'outputs', 'receipt.json');
  await writeFile(source, '{"a":1}');
  const first = await runtime.publishArtifact(alpha, { path: source }, { key: 'publish:v1' });
  await new Promise(resolve => setTimeout(resolve, 5));
  await writeFile(source, '{"a":2}');
  const second = await runtime.publishArtifact(alpha, { path: source }, { key: 'publish:v2' });
  assert.notEqual(first.attachmentId, second.attachmentId);
  const exposed = store.list('attachment', alpha.id).map(a => runtime.publicAttachment(a));
  const match = matchLocalArtifact(localFileLink(source, alpha.cwd), alpha.id, exposed);
  assert.equal(match.state, 'registered'); assert.equal(match.attachment.id, second.attachmentId); assert.equal(match.versions, 2);

  const outside = join(root, 'shared-team-file.txt'); await writeFile(outside, 'team');
  await assert.rejects(runtime.publishArtifact(alpha, { path: outside }, { key: 'publish:outside' }));
  await writeFile(join(alpha.cwd, '.env'), 'TOKEN=x');
  await assert.rejects(runtime.publishArtifact(alpha, { path: '.env' }, { key: 'publish:private' }), /private configuration/);
  assert.equal(store.list('attachment', alpha.id).length, 2);
  assert.equal(matchLocalArtifact(localFileLink(outside, alpha.cwd), alpha.id, exposed).state, 'unregistered');
});
