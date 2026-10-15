// Real React workspace with a synthetic transport for Chapters/docked details
// screenshots. No bridge, model, queue or native call is made: every rpc and
// chapter request is answered in memory, and sends are recorded and refused.
import { historyTail } from "../../lib/bot-history-view";
import React from 'react';
import { createRoot } from 'react-dom/client';
import { botsClient as client } from '../../app/bots/client';
import { BotsWorkspace } from '../../app/bots/workspace';
import { getBotTimeline } from '../../app/bots/use-timeline';

const params = new URLSearchParams(location.search);
const owner = params.get('owner') ?? 'synthetic-chapters-owner';
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
const filler = n => Array.from({ length: 6 }, (_, i) => `Paragraph ${i + 1} of answer ${n}. ` + 'Steady detail about the change and its checks. '.repeat(4)).join('\n\n');
const extra = params.has('long') ? Array.from({ length: Number(params.get('long')) || 10 }, (_, i) => answer(10 + i, `## Answer ${10 + i}\n\n${filler(10 + i)}`)) : [];
// Opt-in AI Elements evidence: native shapes only (Codex/Claude item contracts).
const stack = 'FAIL tests/panel.test.mjs\nTypeError: Cannot read properties of undefined (reading \'id\')\n    at renderPanel (/synthetic/app/bots/chapter-panel.tsx:42:17)\n    at TestContext.<anonymous> (/synthetic/tests/panel.test.mjs:12:3)\n    at Test.run (node:internal/test_runner/test:1402:25)\n';
const elements = params.has('elements') ? [{ id: 'turn-4', status: 'inProgress', startedAt: 1760483000, itemsView: 'full', items: [
  { id: 'user-4', type: 'userMessage', clientId: 'c-4', content: [{ type: 'text', text: 'Check the panel test and look up the docs.', text_elements: [] }] },
  { id: 'reason-4', type: 'reasoning', summary: ['Reading the failing test before changing the panel.'], content: [] },
  { id: 'cmd-5', type: 'commandExecution', command: 'node --test tests/panel.test.mjs', aggregatedOutput: `\u001b[31m${stack}\u001b[0m`, status: 'failed', exitCode: 1, durationMs: 2140, cwd: '/synthetic', commandActions: [] },
  { id: 'mcp-4', type: 'mcpToolCall', server: 'docs', tool: 'search', status: 'completed', arguments: { query: 'AI Elements Trace' }, appContext: null, mcpAppUi: null, pluginId: null, readOnlyHint: true,
    result: { content: [{ type: 'text', text: 'Trace: compact expandable activity rows.' }], structuredContent: null, _meta: null }, error: null, durationMs: 830 },
  { id: 'sub-4', type: 'subAgentActivity', kind: 'completed', agentThreadId: 'thread-reviewer-7f3a', agentPath: 'agents/reviewer', model: 'synthetic-mini', reasoningEffort: 'low' },
  { id: 'compact-4', type: 'contextCompaction' },
] }, { id: 'turn-5', status: 'completed', startedAt: 1760483300, completedAt: 1760483400, itemsView: 'full', items: [
  { id: 'user-5', type: 'userMessage', clientId: 'c-5', content: [{ type: 'text', text: 'What did you find?', text_elements: [] }] },
  { id: 'answer-4', type: 'agentMessage', phase: 'final_answer', text: 'The panel test fails because the chapter row is read before it loads. The Trace docs [1](https://ui.shadcn.com/docs/ai-elements) and the [changelog](https://ui.shadcn.com/docs/changelog/2026-10-ai-elements) describe the row pattern.\n\nNext: :codex-followup[Fix the panel guard]{prompt=\"Add a guard for the unloaded chapter row.\"} :codex-followup[Explain the trace]{prompt=\"Explain the stack trace frames.\"}' },
] }] : [];
const turns = [...extra,
  answer(1, '## Decision: dock the details panel\n\nOn wide desktops the panel stays open beside the chat. Navigation is the default tab.\n\n```ts\nexport const DOCKED_DETAILS_QUERY = "(min-width: 1000px)";\nexport function useDockedDetails() {\n  return useSyncExternalStore(subscribeDock, matches, () => false);\n}\n```'),
  answer(2, 'Here is the change to the layout grid:\n\n```diff\n--- a/app/bots/bot-details.css\n+++ b/app/bots/bot-details.css\n@@ -64,1 +64,2 @@\n-.bots-details { width: min(500px, 100%); }\n+.bots-layout.has-details-docked { grid-template-columns: 300px minmax(0, 1fr) clamp(300px, 26vw, 420px); }\n+.bots-details-host.is-docked { border-left: 1px solid var(--border); }\n```'),
  { id: 'turn-3', status: 'inProgress', startedAt: 1760482000, itemsView: 'full', items: [
    { id: 'user-3', type: 'userMessage', clientId: 'c-3', content: [{ type: 'text', text: 'Run the focused tests.', text_elements: [] }] },
    { id: 'cmd-3', type: 'commandExecution', command: 'node --test tests/bot-chapters.test.mjs', aggregatedOutput: '✔ chapter titles come from the first heading\n✔ pin is idempotent\nℹ pass 7\nℹ fail 0\n', status: 'completed', exitCode: 0, cwd: '/synthetic', commandActions: [] },
    { id: 'cmd-4', type: 'commandExecution', command: 'npx tsc --noEmit', aggregatedOutput: '', status: 'inProgress', exitCode: null, cwd: '/synthetic', commandActions: [] },
  ] },
  ...elements,
];
if (params.has('elements')) {
  bots[0].contextCompaction = { state: null, context: { tokens: 151_000, window: 200_000, observedAt: '2026-10-14T19:00:00Z', lastActivityAt: '2026-10-14T19:00:00Z', compacted: false } };
  client.snapshot.pending = [{ key: 'question-1', botId: 'A', threadId: 'thread-A', createdAt: '2026-10-14T19:00:00Z', request: { method: 'item/tool/requestUserInput', id: 1, params: { threadId: 'thread-A', turnId: 'turn-4', itemId: 'q-1', questions: [
    { id: 'scope', header: 'Scope', question: 'Which fix should go first?', isOther: true, isSecret: false, options: [{ label: 'Panel guard', description: 'Smallest change' }, { label: 'Loader rewrite', description: 'Larger refactor' }] },
    { id: 'tests', header: 'Tests', question: 'Run the full suite afterwards?', isOther: true, isSecret: false, options: [{ label: 'Yes', description: '' }, { label: 'Focused only', description: '' }] }] } } }];
}
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
let seq = 0;
const live = (method, params) => client.receive({ type: 'event', event: { type: 'codex', botId: 'A', seq: ++seq, data: { method, params: { threadId: 'thread-A', ...params } } } });
window.harness = { sends,
  // Resolves the synthetic pending question locally (no answer is sent).
  clearPending() { client.snapshot = { ...client.snapshot, pending: [] }; client.notify(); },
  entries: () => getBotTimeline(owner, 'A').getSnapshot().entries.slice(-6).map(e => [e.turnId, e.id, e.type, e.status, e.itemStatus, e.messageAt, e.startedAt, e.item?.type === 'agentMessage' ? e.item.text.length : null]),
  // One live native turn arriving after the conversation has loaded.
  append(n, text = `## Live answer ${n}\n\n${filler(n)}`) {
    const turnId = `live-${n}`, startedAt = 1770000000 + n * 60;
    live('turn/started', { turnId, turn: { id: turnId, status: 'inProgress', startedAt, items: [], itemsView: 'full' } });
    live('item/completed', { turnId, item: { id: `live-user-${n}`, type: 'userMessage', clientId: `live-c-${n}`, content: [{ type: 'text', text: `Live question ${n}`, text_elements: [] }] } });
    const answerItem = { id: `live-answer-${n}`, type: 'agentMessage', text, phase: 'final_answer' };
    live('item/completed', { turnId, item: answerItem });
    live('turn/completed', { turnId, turn: { id: turnId, status: 'completed', startedAt, completedAt: startedAt + 30, items: [answerItem], itemsView: 'summary' } });
  },
  // Streamed: started, deltas, completed. Returns a function per phase.
  stream(n) {
    const turnId = `live-${n}`, startedAt = 1770000000 + n * 60, id = `live-answer-${n}`, text = `## Live answer ${n}\n\n${filler(n)}`;
    const parts = text.match(/[\s\S]{1,120}/g);
    return {
      start() {
        live('turn/started', { turnId, turn: { id: turnId, status: 'inProgress', startedAt, items: [], itemsView: 'full' } });
        live('item/completed', { turnId, item: { id: `live-user-${n}`, type: 'userMessage', clientId: `live-c-${n}`, content: [{ type: 'text', text: `Live question ${n}`, text_elements: [] }] } });
        live('item/started', { turnId, item: { id, type: 'agentMessage', text: '', phase: 'final_answer' } });
      },
      delta(i) { if (parts[i]) live('item/agentMessage/delta', { turnId, itemId: id, delta: parts[i] }); return i + 1 < parts.length; },
      finish() {
        const item = { id, type: 'agentMessage', text, phase: 'final_answer' };
        live('item/completed', { turnId, item });
        live('turn/completed', { turnId, turn: { id: turnId, status: 'completed', startedAt, completedAt: startedAt + 30, items: [item], itemsView: 'summary' } });
      },
    };
  },
};
(async () => {
  for (let i = 0; i < 200 && !document.querySelector('.bots-native-entry'); i++) await wait(20);
  if (params.has('expand')) document.querySelectorAll('.bots-native-work > summary, .bots-tool > summary').forEach(node => node.click());
  if (params.has('drawer')) document.querySelector('button[aria-label="Bot details"]')?.click();
  // Deep link through the real presence button (opens Work → Up next).
  if (params.has('presence')) document.querySelector('button[aria-label="Open work details"]')?.click();
  if (params.get('tab')) { await wait(100); const tab = [...document.querySelectorAll('.bots-details-nav [role=tab]')].find(node => node.textContent === params.get('tab')); if (tab) { tab.focus(); tab.click(); } }
  if (params.get('sub')) { await wait(100); const sub = [...document.querySelectorAll('.bots-details-subnav [role=tab]')].find(node => node.textContent === params.get('sub')); if (sub) { sub.focus(); sub.click(); } }
  if (params.has('pin')) [...document.querySelectorAll('.bots-chapter-pin')].at(-1)?.click();
  await wait(300);
  document.body.dataset.ready = '1';
})();
