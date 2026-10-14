// Focused, printed calculations for the independent cursor review. No test runner.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { pathToFileURL } from 'node:url';
const ref = process.env.BOT_FEED_REVIEW_REF;
const modules = ['app/bots/timeline-controller.ts', 'app/bots/history-window.ts', 'app/bots/history-reconcile.ts', 'lib/bot-history-view.ts', 'bot-bridge/conversation-view.mjs'];
const bundle = await build({ stdin: { contents: modules.map((path, i) => `import * as m${i} from './${path}';`).join('\n') + `\nexport default {${modules.map((_, i) => `...m${i}`).join(',')}}`, resolveDir: process.cwd() }, bundle: true, format: 'esm', platform: 'node', packages: 'external', write: false,
  plugins: ref ? [{ name: 'reviewed-snapshot', setup(b) { b.onLoad({ filter: /\.(ts|tsx|mjs)$/ }, ({ path }) => { const name = relative(process.cwd(), path); if (name.startsWith('..') || name.includes('node_modules/')) return; return { contents: execFileSync('git', ['show', `${ref}:${name}`], { encoding: 'utf8' }), loader: path.endsWith('.ts') ? 'ts' : path.endsWith('.tsx') ? 'tsx' : 'js' }; }); } }] : [] });
await mkdir('outputs/bot-typing-recent', { recursive: true });
const modulePath = 'outputs/bot-typing-recent/review-modules.mjs';
await writeFile(modulePath, bundle.outputFiles[0].text);
const { BotTimeline, retainHistory, historyBoundaries, orderedHistory, reconcileHistory, projectHistoryItem, historyKey, historyBefore, conversationViewPage } = (await import(pathToFileURL(modulePath))).default;
const answer = (id, text = id) => ({ id, type: 'agentMessage', text, phase: 'final' });
const turn = (i, items = [answer(`a${i}`)], status = 'completed') => ({ id: `t${i}`, status, items, startedAt: null });
const project = (t) => t.items.map(item => projectHistoryItem(t, item, false));
const key = e => historyKey(e.turnId, e.id);
const response = entries => ({ kind: 'page', entries, attachments: [], olderCursor: null, complete: true, revision: 'review:conversation-v2', eventCursor: 0 });
const noCache = { read: async () => null, write: async () => {} };
const stub = pages => ({ historyPage: async (_id, cursor) => ({ data: pages[Number(cursor || 0)], nextCursor: Number(cursor || 0) + 1 < pages.length ? String(Number(cursor || 0) + 1) : null }), store: { db: { prepare: () => ({ all: () => [], get: () => undefined }) } } });
const forward = (pages, after) => conversationViewPage(stub(pages), { id: 'synthetic', threadId: 'synthetic' }, JSON.stringify({ native: null, before: null, after }));
const compact = page => ({ entries: page.entries.length, first: page.entries[0] && key(page.entries[0]), last: page.entries.at(-1) && key(page.entries.at(-1)), olderCursor: page.olderCursor, newerCursor: page.newerCursor, bytes: Buffer.byteLength(JSON.stringify(page)) });

const all = Array.from({ length: 25 }, (_, i) => turn(i));
all[24].status = 'inProgress';
all[24].items.unshift(...Array.from({ length: 230 }, (_, i) => ({ id: `tool${i}`, type: 'commandExecution', command: 'synthetic', status: 'completed', aggregatedOutput: '' })));
// Two readable entries per older turn make the active page start at turn 12.
for (let i = 0; i < 25; i++) all[i].items.unshift({ id: `u${i}`, type: 'userMessage', clientId: `c${i}`, content: [{ type: 'text', text: `Request ${i}` }] });
const native = stub([all.slice().reverse()]);
let page = await conversationViewPage(native, { id: 'synthetic', threadId: 'synthetic' });
const controller = new BotTimeline('synthetic', 'synthetic', { owner: 'synthetic', online: true, rpc: async () => ({ ...response([]), ...page }) }, noCache);
await controller.refresh();
const active = compact(page);
const activePage = page;
all[24].status = 'completed';
page = await conversationViewPage(native, { id: 'synthetic', threadId: 'synthetic' });
await controller.refresh();
const refreshed = controller.getSnapshot();
const refresh = { active, completed: compact(page), order: [...new Set(refreshed.entries.map(e => e.turnId))], latest: key(refreshed.entries.at(-1)), olderCursor: refreshed.olderCursor, complete: refreshed.complete };
if (!ref) await writeFile('outputs/bot-typing-recent/review-pages.json', JSON.stringify({ active: { ...response([]), ...activePage }, completed: { ...response([]), ...page } }));
controller.dispose();

const gapEntries = [...Array.from({ length: 21 }, (_, i) => turn(i)), ...Array.from({ length: 10 }, (_, i) => turn(i + 30))].flatMap(project);
const gap = { before: 't30:a30', stop: 't20:a20', cursor: historyBefore(project(turn(30))[0]) };
const retained = retainHistory(gapEntries, { following: true, anchor: null, offset: 0 }, [gap], null, 10, 4 * 1024 * 1024);
const gaps = { first: key(retained.entries[0]), last: key(retained.entries.at(-1)), gaps: retained.gaps, olderCursor: retained.olderCursor };
const olderNative = stub([Array.from({ length: 25 }, (_, i) => turn(39 - i)), Array.from({ length: 15 }, (_, i) => turn(14 - i))]);
const recovered = new BotTimeline('synthetic', 'synthetic', { owner: 'synthetic', online: true, rpc: async (_method, _bot, params) => ({ ...response([]), ...await conversationViewPage(olderNative, { id: 'synthetic', threadId: 'synthetic' }, params.cursor) }) }, noCache);
recovered.state = { ...recovered.getSnapshot(), ...retained, cached: true };
gaps.recovery = [];
for (let step = 0; step < 4 && recovered.state.olderCursor; step++) {
  await recovered.older(); gaps.recovery.push({ entries: recovered.state.entries.length, first: key(recovered.state.entries[0]), last: key(recovered.state.entries.at(-1)), gaps: recovered.state.gaps, olderCursor: recovered.state.olderCursor });
}
recovered.dispose();
const exhausted = new BotTimeline('synthetic', 'synthetic', { owner: 'synthetic', online: true, rpc: async () => response([]) }, noCache);
exhausted.state = { ...exhausted.getSnapshot(), entries: [project(turn(20))[0], project(turn(30))[0]], gaps: [gap], cached: true };
await exhausted.fillGap(gap);
gaps.afterExhaustion = exhausted.getSnapshot().gaps;
exhausted.dispose();

const large = turn('large', Array.from({ length: 300 }, (_, i) => answer(`large${i}`)));
const oversized = await forward([[large], [turn(0)]], 't0:a0');
let remainder = oversized.newerCursor ? await conversationViewPage(stub([[large], [turn(0)]]), { id: 'synthetic', threadId: 'synthetic' }, oversized.newerCursor) : null;
const empty = Array.from({ length: 25 }, (_, i) => turn(i + 1, []));
const acrossEmpty = await forward([[turn(26)], empty.slice().reverse(), [turn(0)]], 't0:a0');
const backwardRuntime = stub([empty.slice().reverse(), empty.slice().reverse(), [turn(0)]]);
const backward = await conversationViewPage(backwardRuntime, { id: 'synthetic', threadId: 'synthetic' });
const backwardNext = backward.olderCursor ? await conversationViewPage(backwardRuntime, { id: 'synthetic', threadId: 'synthetic' }, backward.olderCursor) : null;
const result = { refresh, gaps, forward: { oversized: compact(oversized), remainder: remainder && compact(remainder), acrossEmpty: compact(acrossEmpty) }, backward: { empty: compact(backward), continuation: backwardNext && compact(backwardNext) } };
const user = (turnId, id, clientId, updatedSeq = 0) => ({ ...projectHistoryItem({ id: turnId, status: 'completed', startedAt: null }, { type: 'userMessage', id, clientId, content: [{ type: 'text', text: 'Identical intentional text' }] }, false), updatedSeq });
const oldAlias = user('t20', 'client:c20', 'c20', 100), canonical = user('t20', 'native20', 'c20');
const repeated = user('t21', 'native21', 'c21'), live = { ...project(turn(22))[0], updatedSeq: 101, item: answer('a22', 'new live text') };
if (orderedHistory && historyBoundaries) {
const identityResult = reconcileHistory(orderedHistory([oldAlias, repeated, live], [project(turn(19))[0], canonical, repeated, project(turn(22))[0]], false, 50));
result.identity = { order: identityResult.entries.map(key), aliases: [...identityResult.aliases], liveText: identityResult.entries.at(-1).item.text, distinctUsers: identityResult.entries.filter(e => e.type === 'userMessage').length, canonicalClient: identityResult.entries.find(e => e.id === 'native20')?.item.clientId };
const missingStop = historyBoundaries(retained.entries, [gap], null);
const removedBefore = historyBoundaries([project(turn(20))[0], project(turn(31))[0]], [gap], null, [project(turn(20))[0], project(turn(30))[0], project(turn(31))[0]]);
const removedBoth = historyBoundaries([project(turn(19))[0], project(turn(31))[0]], [gap], null, [19, 20, 30, 31].flatMap(i => project(turn(i))));
const inverted = historyBoundaries([0, 20, 30].flatMap(i => project(turn(i))), [{ ...gap, before: 't0:a0' }], null);
result.gapVariants = { missingStop, removedBefore, removedBoth, inverted };
}
// Repeated empty native pages must advance their cursor, then terminate.
const emptyChain = [], emptyRuntime = stub([...Array.from({ length: 6 }, () => empty), [turn(0)]]);
let next;
do { const p = await conversationViewPage(emptyRuntime, { id: 'synthetic', threadId: 'synthetic' }, next); emptyChain.push(compact(p)); next = p.olderCursor; } while (next && emptyChain.length < 8);
result.backward.chain = emptyChain;
// Byte-limited and turn-limited forward windows, including exact completion.
for (const [name, pages] of [['byteLimited', [[turn('bytes', Array.from({ length: 300 }, (_, i) => answer(`large${i}`, 'x'.repeat(1200))))], [turn(0)]]], ['turnLimited', [...Array.from({ length: 3 }, (_, page) => Array.from({ length: 25 }, (_, i) => turn(75 - page * 25 - i))), [turn(0)]]]]) {
  const windows = []; let cursor = JSON.stringify({ native: null, before: null, after: 't0:a0' });
  do { const p = await conversationViewPage(stub(pages), { id: 'synthetic', threadId: 'synthetic' }, cursor); windows.push({ ...compact(p), turns: p.turnIds.length }); cursor = p.newerCursor; } while (cursor && windows.length < 10);
  result.forward[name] = windows;
}
// Exercise controller backward exhaustion and canonical endpoint connection.
const connected = new BotTimeline('synthetic', 'synthetic', { owner: 'synthetic', online: true, rpc: async () => response([canonical, project(turn(25))[0]]) }, noCache);
connected.state = { ...connected.getSnapshot(), entries: [oldAlias, project(turn(30))[0]], gaps: [{ ...gap, stop: key(oldAlias) }], cached: true, position: { anchor: key(oldAlias), offset: -12, following: false } };
await connected.fillGap(connected.state.gaps[0]);
result.aliasGap = { entries: connected.state.entries.map(key), gaps: connected.state.gaps, anchor: connected.state.position.anchor, offset: connected.state.position.offset };
connected.dispose();
const savedEntries = [oldAlias, canonical, project(turn(30))[0]];
const cached = new BotTimeline('synthetic', 'synthetic', { owner: 'synthetic', online: false, rpc: async () => { throw Error('Offline'); } }, { ...noCache, read: async () => ({ entries: savedEntries, metadata: { owner: 'synthetic', botId: 'synthetic', order: savedEntries.map(key), olderCursor: null, complete: false, revision: 'old:conversation-v1', eventCursor: 100, attachments: [], gaps: [{ ...gap, stop: key(oldAlias) }], position: { anchor: key(oldAlias), offset: -12, following: false } } }) });
await cached.hydrate();
result.cachedAlias = { entries: cached.state.entries.map(key), gaps: cached.state.gaps, anchor: cached.state.position.anchor, offset: cached.state.position.offset, revision: cached.state.revision };
cached.dispose();
await mkdir('outputs/bot-typing-recent', { recursive: true });
await writeFile(`outputs/bot-typing-recent/review-${process.env.BOT_FEED_REVIEW_LABEL || 'current'}.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
