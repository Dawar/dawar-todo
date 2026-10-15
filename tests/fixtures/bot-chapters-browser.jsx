// Real React workspace with a synthetic transport for Chapters/docked details
// screenshots. No bridge, model, queue or native call is made: every rpc and
// chapter request is answered in memory, and sends are recorded and refused.
import { historyTail } from "../../lib/bot-history-view";
import React from 'react';
import { createRoot } from 'react-dom/client';
import { botsClient as client } from '../../app/bots/client';
import { BotsWorkspace } from '../../app/bots/workspace';

const params = new URLSearchParams(location.search);
const owner = 'synthetic-chapters-owner';
const bots = [['A', 'Cody'], ['B', 'Dwight']].map(([id, name]) => ({ id, name, purpose: 'Codex UI steward', slug: id, cwd: '/synthetic', threadId: `thread-${id}`, color: '#216e4e', status: 'idle', archived: false,
  model: null, effort: null, mode: 'default', preview: '', updatedAt: '2026-10-14T00:00:00Z', lastReadAt: '2026-10-14T00:00:00Z', activeTurnId: null }));
client.start = () => {};
client.owner = owner;
client.online = true;
client.snapshot = { bots, pending: [], cursor: 0, ready: true, models: [], schedules: [], runs: [], defaults: { model: 'synthetic', effort: 'medium' } };
const sends = [];
const answer = (n, text) => ({ id: `turn-${n}`, status: 'completed', startedAt: 1760480000 + n * 600, completedAt: 1760480000 + n * 600 + 90, itemsView: 'full', items: [
  { id: `user-${n}`, type: 'userMessage', clientId: `c-${n}`, content: [{ type: 'text', text: n === 1 ? 'Can you plan the chapters sidebar?' : n === 2 ? 'Show me the diff for the panel.' : 'Run the focused tests.', text_elements: [] }] },
  { id: `answer-${n}`, type: 'agentMessage', text, phase: 'final_answer' },
] });
const turns = [
  answer(1, '## Decision: dock the details panel\n\nOn wide desktops the panel stays open beside the chat. Navigation is the default tab.\n\n```ts\nexport const DOCKED_DETAILS_QUERY = "(min-width: 1000px)";\nexport function useDockedDetails() {\n  return useSyncExternalStore(subscribeDock, matches, () => false);\n}\n```'),
  answer(2, 'Here is the change to the layout grid:\n\n```diff\n--- a/app/bots/bot-details.css\n+++ b/app/bots/bot-details.css\n@@ -64,1 +64,2 @@\n-.bots-details { width: min(500px, 100%); }\n+.bots-layout.has-details-docked { grid-template-columns: 300px minmax(0, 1fr) clamp(300px, 26vw, 420px); }\n+.bots-details-host.is-docked { border-left: 1px solid var(--border); }\n```'),
  { id: 'turn-3', status: 'inProgress', startedAt: 1760482000, itemsView: 'full', items: [
    { id: 'user-3', type: 'userMessage', clientId: 'c-3', content: [{ type: 'text', text: 'Run the focused tests.', text_elements: [] }] },
    { id: 'cmd-3', type: 'commandExecution', command: 'node --test tests/bot-chapters.test.mjs', aggregatedOutput: '✔ chapter titles come from the first heading\n✔ pin is idempotent\nℹ pass 7\nℹ fail 0\n', status: 'completed', exitCode: 0, cwd: '/synthetic', commandActions: [] },
    { id: 'cmd-4', type: 'commandExecution', command: 'npx tsc --noEmit', aggregatedOutput: '', status: 'inProgress', exitCode: null, cwd: '/synthetic', commandActions: [] },
  ] },
];
client.rpc = async (method, botId, params = {}) => {
  if (method === 'history.view') return { kind: 'page', entries: botId === 'A' ? historyTail(turns) : [], attachments: [], olderCursor: null, revision: 'synthetic', eventCursor: 0, complete: true };
  if (method === 'history.detail') { const item = turns.flatMap(turn => turn.items).find(value => value.id === params.itemId); const json = JSON.stringify(item ?? null); return { json, nextOffset: null, totalLength: json.length, version: 'v1' }; }
  // Reads answer empty; any send-like method is recorded so a check can
  // assert navigation caused none.
  if (/^(turn\.(send|steer)|queue\.(add|update|flush)|bursts\.submit)$/.test(method)) sends.push(method);
  return [];
};
// In-memory chapter contract.
const chapters = [{ botId: 'A', threadId: 'thread-A', turnId: 'turn-1', itemId: 'answer-1', title: 'Decision: dock the details panel', messageAt: 1760480600, pinnedAt: '2026-10-14T19:10:00.000Z' }];
const realFetch = window.fetch.bind(window);
window.fetch = async (url, init = {}) => {
  const path = String(url);
  if (path.startsWith('/api/bots/sidebar-preferences')) return Response.json({ version: 1, owner, choices: [] });
  if (!path.startsWith('/api/bots/chapters')) return path.startsWith('/api/') ? new Response('{}', { status: 404 }) : realFetch(url, init);
  if ((init.method ?? 'GET') === 'GET') { const q = new URL(path, location.href).searchParams; return Response.json({ version: 1, owner, botId: q.get('botId'), threadId: q.get('threadId'), chapters: chapters.filter(c => c.botId === q.get('botId')) }); }
  const m = JSON.parse(init.body); const i = chapters.findIndex(c => c.turnId === m.turnId && c.itemId === m.itemId);
  if (m.action === 'pin' && i < 0) chapters.push({ botId: m.botId, threadId: m.threadId, turnId: m.turnId, itemId: m.itemId, title: m.title, messageAt: m.messageAt, pinnedAt: new Date().toISOString() });
  if (m.action === 'unpin' && i >= 0) chapters.splice(i, 1);
  return Response.json({ version: 1, owner, chapter: chapters.find(c => c.turnId === m.turnId && c.itemId === m.itemId) ?? null });
};
try { localStorage.setItem(`dawar-bots:${owner}:details-docked:v1`, params.has('dock') ? 'open' : 'closed'); } catch { /* optional */ }
history.replaceState({}, '', `/harness?bot=A&${params.toString()}`);
createRoot(document.getElementById('root')).render(<BotsWorkspace />);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
window.harness = { sends };
(async () => {
  for (let i = 0; i < 200 && !document.querySelector('.bots-native-entry'); i++) await wait(20);
  if (params.has('expand')) document.querySelectorAll('.bots-native-work > summary, .bots-tool > summary').forEach(node => node.click());
  if (params.has('drawer')) document.querySelector('button[aria-label="Bot details"]')?.click();
  if (params.has('pin')) [...document.querySelectorAll('.bots-chapter-pin')].at(-1)?.click();
  await wait(300);
  document.body.dataset.ready = '1';
})();
