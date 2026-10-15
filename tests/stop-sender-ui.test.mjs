import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtime as browser } from './helpers/load-ts.mjs';
import { Store } from '../bot-bridge/store.mjs';
import { HubSubmissions } from '../portable/hub-submissions.mjs';
import { enqueuePrompt } from '../bot-bridge/prompt-queue.mjs';
import { BotRuntime } from '../bot-bridge/runtime.mjs';

const env = browser();
const { botStopped, botWorking } = env.load('app/bots/bot-stop-state.ts');
const { StopConfirmation } = env.load('app/bots/stop-confirmation.ts');
const { queuedSender } = env.load('app/bots/queued-sender.ts');

test('stopped is the authoritative queue pause only; active work, idle, error, interrupted history and paused Goals are not stopped', () => {
  const bot = (extra = {}) => ({ id: 'b', status: 'idle', activeTurnId: null, archived: false, ...extra });
  assert.equal(botStopped(bot({ queuePaused: true })), true);
  assert.equal(botStopped(bot({ queuePaused: true, status: 'error' })), true);
  // Active work keeps its spinner even while a Stop is settling.
  assert.equal(botStopped(bot({ queuePaused: true, activeTurnId: 'turn' })), false);
  assert.equal(botWorking(bot({ queuePaused: true, activeTurnId: 'turn' })), true);
  assert.equal(botStopped(bot({ queuePaused: true, workerTasks: { active: 1 } })), false);
  for (const value of [bot(), bot({ status: 'error' }), bot({ status: 'interrupted' }), bot({ queuePaused: false }), bot({ managerPaused: true }),
    bot({ goal: { status: 'paused' } }), bot({ queuePaused: true, archived: true })]) assert.equal(botStopped(value), false);
});

test('a new Stop needs explicit confirmation; cancel sends nothing; double confirm submits once; a saved Stop only re-checks', () => {
  let changes = 0, submits = 0, recovers = 0;
  const gate = new StopConfirmation(() => changes++), submit = () => submits++, recover = () => recovers++;
  gate.request({ saved: false, recover });
  assert.equal(gate.open, true); assert.equal(submits, 0);
  gate.cancel();
  assert.equal(gate.open, false); assert.equal(gate.confirm(submit), false); assert.equal(submits, 0);
  gate.request({ saved: false, recover }); gate.request({ saved: false, recover });
  assert.equal(gate.confirm(submit), true); assert.equal(gate.confirm(submit), false);
  assert.equal(submits, 1); assert.equal(recovers, 0);
  gate.request({ saved: true, recover });
  assert.equal(gate.open, false); assert.equal(recovers, 1); assert.equal(submits, 1);
  assert.ok(changes >= 4);
});

const queued = (extra = {}) => ({ id: 'q', text: 'body', input: [], attachments: [], ...extra });
test('queued sender uses only the linked application source; human, legacy, unknown and mismatched stay neutral', () => {
  const source = { kind: 'bot', id: 'adele', name: 'Adele', color: '#AA3311', avatar: 'adele-1' };
  assert.deepEqual({ ...queuedSender(queued({ sourceSubmissionId: 's1', submission: { submissionId: 's1', source } })) }, source);
  assert.deepEqual({ ...queuedSender(queued({ sourceSubmissionId: 's1', submission: { submissionId: 's1', source: { ...source, color: 'red', avatar: 'https://x/y.png' } } })) },
    { kind: 'bot', id: 'adele', name: 'Adele' });
  assert.equal(queuedSender(queued({ sourceSubmissionId: 's1', submission: { submissionId: 's1', source: { kind: 'system', id: 'sys', name: 'Scheduler' } } })).name, 'Scheduler');
  for (const item of [queued(), queued({ source: { kind: 'bot', operationId: 'x' } }), queued({ submission: { submissionId: 's1', source } }),
    queued({ sourceSubmissionId: 's2', submission: { submissionId: 's1', source } }),
    queued({ sourceSubmissionId: 's1', submission: { submissionId: 's1', source: { kind: 'user', id: 'u', name: 'Dawar' } } }),
    queued({ sourceSubmissionId: 's1', submission: { submissionId: 's1', source: { kind: 'unknown' } } }),
    queued({ sourceSubmissionId: 's1', submission: { submissionId: 's1', source: { ...source, name: 'A\u0007B' } } }),
    queued({ sourceSubmissionId: 's1', submission: { submissionId: 's1', source: { ...source, name: '  ' } } })]) assert.equal(queuedSender(item), null);
});

test('the queue view carries display-only bot authorship that survives a list move; human and legacy items carry none', t => {
  const dir = mkdtempSync(join(tmpdir(), 'queued-sender-')), store = new Store(join(dir, 'state.sqlite'));
  t.after(() => { store.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const owner = { key: 'owner', userId: 'google|owner', name: 'Dawar' };
  for (const [id, name, color] of [['adele', 'Adele', '#aa3311'], ['sian', 'Sian', '#3355aa']])
    store.saveBot({ id, slug: id, name, threadId: `thread-${id}`, executionMode: 'single-thread', mode: 'default', avatar: { version: 1, shape: 'square', color, seed: id }, queuePaused: false });
  const placements = new Map(store.bots().map(b => [b.id, { owner: owner.key, bot_id: b.id, node_id: 'node', epoch: 1, stopped: false }]));
  const runtime = { store, scope: (key, botId) => ({ p: placements.get(botId), b: store.bot(botId) }), assertWriter: () => {}, hub: { node: () => ({}) },
    publicQueued: (_b, q) => q, emitEvent: () => {}, saveBot: (b, patch) => store.saveBot({ ...b, ...patch }),
    activityUnresolved: () => false, plans: { blocked: () => false }, publicAttachment: a => a,
    managedPrompt: (botId, clientId) => BotRuntime.prototype.managedPrompt.call(runtime, botId, clientId) };
  runtime.sources = new HubSubmissions(runtime, owner); runtime.queueSubmission = (...args) => enqueuePrompt(runtime, ...args);
  const view = (bot, item) => BotRuntime.prototype.publicQueued.call(runtime, bot, item);
  const receipt = runtime.sources.tool(owner.key, 'adele', { operation: 'send', recipientBotId: 'sian', text: 'Please review the draft', operationId: 'adele-send-1' },
    { kind: 'authenticated-node-tool', botId: 'adele', nodeId: 'node', epoch: 1 });
  const sian = store.bot('sian'), item = store.get('promptQueue', receipt.submissionId);
  const shown = view(sian, item);
  assert.deepEqual(shown.submission, { submissionId: receipt.submissionId, source: { kind: 'bot', id: 'adele', name: 'Adele', color: '#aa3311' } });
  assert.equal(JSON.stringify(shown.submission).includes('owner'), false);
  assert.deepEqual(shown.input, [{ type: 'text', text: 'Please review the draft', text_elements: [] }]);
  assert.equal(queuedSender(shown).name, 'Adele');
  store.put('promptQueue', { ...item, listId: 'later', revision: item.revision + 1 });
  assert.equal(view(sian, store.get('promptQueue', item.id)).submission.source.id, 'adele');
  const human = enqueuePrompt(runtime, sian, { text: 'Human note' }, 'human-q', [{ type: 'text', text: 'Human note', text_elements: [] }]);
  const humanItem = store.get('promptQueue', human.queuedSubmission?.id ?? 'human-q');
  const ownerRow = runtime.sources.capture(sian, 'human-source', runtime.sources.ownerSource(), '');
  assert.equal(view(sian, humanItem).submission, undefined);
  assert.equal(view(sian, { ...humanItem, sourceSubmissionId: ownerRow.submissionId }).submission, undefined);
  assert.equal(view(sian, { ...humanItem, sourceSubmissionId: 'missing-source' }).submission, undefined);
});
