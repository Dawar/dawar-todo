// Real React workspace with a synthetic transport for Stop/sender screenshots.
// No bridge, model, queue or native call is made: every rpc is answered in
// memory and Stop/send-like methods are only recorded (window.harness.calls).
import React from 'react';
import { createRoot } from 'react-dom/client';
import { botsClient as client } from '../../app/bots/client';
import { BotsWorkspace } from '../../app/bots/workspace';

const params = new URLSearchParams(location.search);
const owner = 'synthetic-stop-owner';
const at = '2026-10-14T00:00:00Z', later = '2026-10-14T01:00:00Z';
const bot = (id, name, color, extra = {}) => ({ id, name, purpose: 'Synthetic bot', slug: id, cwd: '/synthetic', threadId: `thread-${id}`, avatar: { version: 1, shape: 'square', color, seed: id },
  status: 'idle', archived: false, model: null, effort: null, mode: 'default', preview: 'Last reply preview', updatedAt: at, lastReadAt: at, activeTurnId: null, executionMode: 'single-thread', ...extra });
const bots = [
  bot('sian', 'Sian', '#3355aa', { activeTurnId: params.has('idle') ? null : 'turn-live', status: params.has('idle') ? 'idle' : 'running', preview: 'Working on the review' }),
  bot('adele', 'Adele', '#aa3311', { queuePaused: true, preview: 'Stopped while drafting' }),
  bot('bert', 'Bert', '#217050', { queuePaused: true, updatedAt: later, preview: 'Stopped with an unread reply' }),
  bot('finley', 'Finley', '#8a5cc4', { status: 'error', preview: 'Unable to continue' }),
  bot('jim', 'Jim', '#485da4', { status: 'interrupted', preview: 'Interrupted earlier (not stopped)' }),
];
client.start = () => {};
client.owner = owner;
client.online = true;
client.snapshot = { bots, pending: [], cursor: 0, ready: true, models: [], schedules: [], runs: [], defaults: { model: 'synthetic', effort: 'medium' },
  capabilities: { singleThreadExecution: 1, backgroundRunLanes: 1, submissionSources: 1 },
  workByBot: bots.map(b => ({ botId: b.id, executionMode: 'single-thread', state: b.activeTurnId ? 'working' : b.queuePaused ? 'paused' : 'ready', activeTurnId: b.activeTurnId, paused: !!b.queuePaused, summary: null, remaining: null, waitingFor: [], goal: null, goalObservedAt: null, migrationReason: null })) };
const text = value => [{ type: 'text', text: value, text_elements: [] }];
const queued = [
  { id: 'submission:adele-1', botId: 'sian', threadId: 'thread-sian', clientUserMessageId: 'submission:adele-1', input: text('Can you double-check the release notes before Dawar reads them? The table in section two looks stale.'), attachments: [], position: 1, createdAt: at, revision: 1, state: 'queued', listId: null,
    sourceSubmissionId: 'submission:adele-1', submission: { submissionId: 'submission:adele-1', source: { kind: 'bot', id: 'adele', name: 'Adele', color: '#aa3311' } } },
  { id: 'human-1', botId: 'sian', threadId: 'thread-sian', clientUserMessageId: 'human-1', input: text('Then summarise what changed for me.'), attachments: [], position: 2, createdAt: at, revision: 1, state: 'queued', listId: null },
  { id: 'submission:ghost-1', botId: 'sian', threadId: 'thread-sian', clientUserMessageId: 'submission:ghost-1', input: text('A bot without an avatar falls back to initials.'), attachments: [], position: 3, createdAt: at, revision: 1, state: 'queued', listId: null,
    sourceSubmissionId: 'submission:ghost-1', submission: { submissionId: 'submission:ghost-1', source: { kind: 'bot', id: 'gone-bot', name: 'Ghost Writer', color: '#c08a00' } } },
  { id: 'legacy-1', botId: 'sian', threadId: 'thread-sian', clientUserMessageId: 'legacy-1', input: text('[From Adele] legacy text is never identity.'), attachments: [], position: 4, createdAt: at, revision: 1, state: 'queued', listId: null, source: { kind: 'bot' } },
];
const calls = [];
client.rpc = async (method, botId, p = {}) => {
  calls.push(method);
  if (method === 'history.view') return { kind: 'page', entries: [], attachments: [], olderCursor: null, revision: 'synthetic', eventCursor: 0, complete: true };
  if (method === 'queue.list') return botId === 'sian' ? queued : [];
  return [];
};
const realFetch = window.fetch.bind(window);
window.fetch = async (url, init = {}) => {
  const path = String(url);
  if (path.startsWith('/api/bots/sidebar-preferences')) return Response.json({ version: 1, owner, choices: [] });
  return path.startsWith('/api/') ? new Response('{}', { status: 404 }) : realFetch(url, init);
};
history.replaceState({}, '', `/harness?bot=${params.get('bot') ?? 'sian'}&${params.toString()}`);
createRoot(document.getElementById('root')).render(<BotsWorkspace />);
window.harness = { calls, stops: () => calls.filter(m => /interrupt|stop/i.test(m)) };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  for (let i = 0; i < 200 && !document.querySelector('.bots-composer textarea:not(:disabled)'); i++) await wait(20);
  await wait(200);
  if (params.has('confirm')) document.querySelector('button[aria-label="Stop main conversation"]')?.click();
  await wait(300);
  document.body.dataset.ready = '1';
})();
