import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { runtime } from './helpers/load-ts.mjs';

const mocks = { [resolve('components/ai-elements/ai-elements.css')]: {},
  '@/components/ui/button': { Button: (props) => h('button', { type: props.type, disabled: props.disabled, className: props.className, 'aria-label': props['aria-label'], title: props.title, onClick: props.onClick }, props.children) },
  '@/app/copy-to-clipboard': { copyTextToClipboard: async () => {} } };
const env = runtime({}, mocks);
const ai = env.load('lib/ai-elements.ts');
mocks['@/lib/ai-elements'] = ai;
mocks['@/lib/trace-state'] = env.load('lib/trace-state.ts');
const component = (path) => env.load(path);
// Values cross a vm realm; compare their plain JSON shape.
const eq = (actual, expected, message) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message);

test('Tool view reads only the native item parameters, result and error', () => {
  const mcp = { type: 'mcpToolCall', id: 't1', server: 'docs', tool: 'search', status: 'completed', arguments: { q: 'trace' }, appContext: null, mcpAppUi: null, pluginId: null, readOnlyHint: null,
    result: { content: [{ type: 'text', text: 'one' }, { type: 'image', data: 'x' }, { type: 'text', text: 'two' }], structuredContent: null, _meta: null }, error: null, durationMs: 1530 };
  eq({ ...ai.toolView(mcp) }, { name: 'docs · search', input: '{\n  "q": "trace"\n}', output: 'one\n\ntwo', error: null, media: 1, durationMs: 1530 });
  const failed = ai.toolView({ ...mcp, arguments: {}, result: null, error: { message: 'denied' }, durationMs: null });
  assert.equal(failed.input, null, 'empty arguments are not shown as parameters');
  assert.equal(failed.error, 'denied');
  assert.equal(failed.output, null);
  const dynamic = { type: 'dynamicToolCall', id: 'd', namespace: null, tool: 'bots_report_result', arguments: { key: 'k' }, status: 'failed', contentItems: [{ type: 'inputText', text: 'boom' }], success: false, durationMs: 20 };
  assert.equal(ai.toolView(dynamic).error, 'boom');
  assert.equal(ai.toolView(dynamic).output, null, 'a failed dynamic result is an error, never a result');
  assert.equal(ai.toolView({ ...dynamic, contentItems: null }).error, 'The tool reported a failure.');
  assert.equal(ai.toolView({ type: 'commandExecution' }), null);
  assert.equal(ai.formatDuration(null), null);
  assert.equal(ai.formatDuration(850), '850ms');
  assert.equal(ai.formatDuration(1530), '1.5s');
  assert.equal(ai.formatDuration(125_000), '2m 5s');
});

test('Terminal strips escape sequences for display only', () => {
  assert.equal(ai.stripAnsi('\u001b[32m✔ pass\u001b[0m 7\n\u001b]0;title\u0007done'), '✔ pass 7\ndone');
  const plain = 'no escapes here';
  assert.equal(ai.stripAnsi(plain), plain);
});

test('Stack Trace needs two frames of one known shape; prose never becomes a trace', () => {
  const js = ai.parseStackTrace('npm ERR! test failed\nTypeError: Cannot read properties of undefined (reading \'id\')\n    at render (/repo/app/bots/message.tsx:42:7)\n    at Object.run (node:internal/modules/run_main:1:1)\n    at /repo/node_modules/react/index.js:9:3\n');
  assert.equal(js.language, 'javascript');
  assert.equal(js.message, "TypeError: Cannot read properties of undefined (reading 'id')");
  eq(js.frames.map(f => [f.fn, f.file, f.line, f.column, f.internal]), [
    ['render', '/repo/app/bots/message.tsx', 42, 7, false], ['Object.run', 'node:internal/modules/run_main', 1, 1, true], [null, '/repo/node_modules/react/index.js', 9, 3, true]]);
  const py = ai.parseStackTrace('Traceback (most recent call last):\n  File "/repo/app.py", line 3, in <module>\n    main()\n  File "/repo/app.py", line 2, in main\n    1/0\n    ~^~\nZeroDivisionError: division by zero\n');
  assert.equal(py.language, 'python');
  assert.equal(py.message, 'ZeroDivisionError: division by zero');
  eq(py.frames.map(f => [f.fn, f.line]), [['<module>', 3], ['main', 2]]);
  assert.equal(ai.parseStackTrace('We looked at the trace and it was fine.\nat least two things changed'), null);
  assert.equal(ai.parseStackTrace('Error: x\n    at one (/a.js:1:1)\n'), null, 'one frame is not enough evidence');
  const many = 'Error\n' + Array.from({ length: 60 }, (_, i) => `    at f${i} (/a.js:${i}:1)`).join('\n');
  const bounded = ai.parseStackTrace(many);
  assert.equal(bounded.frames.length, 40);
  assert.equal(bounded.truncated, true);
});

test('Plan step state and Sources/Inline Citation come only from existing evidence', () => {
  assert.equal(ai.planStepState('completed'), 'completed');
  assert.equal(ai.planStepState('inProgress'), 'running');
  assert.equal(ai.planStepState('anything'), 'pending');
  const sources = ai.messageSources(['https://www.example.com/docs/ai%20elements#part', 'https://example.com/docs/ai%20elements', 'bot-artifact:abc', 'file:///etc/passwd', 'javascript:alert(1)', 'https://user:pw@example.com/x', 'http://news.test/']);
  eq(sources.map(s => ({ ...s })), [
    { url: 'https://www.example.com/docs/ai%20elements', host: 'example.com', label: 'ai elements' },
    { url: 'https://example.com/docs/ai%20elements', host: 'example.com', label: 'ai elements' },
    { url: 'http://news.test/', host: 'news.test', label: 'news.test' }]);
  assert.equal(ai.messageSources(Array.from({ length: 40 }, (_, i) => `https://a.test/${i}`)).length, 20);
  eq({ ...ai.inlineCitation('[2]', 'https://www.example.com/a') }, { index: '2', host: 'example.com' });
  eq({ ...ai.inlineCitation('https://example.com/a', 'https://example.com/a') }, { index: null, host: 'example.com' });
  assert.equal(ai.inlineCitation('the docs', 'https://example.com/a'), null, 'ordinary link text stays an ordinary link');
  assert.equal(ai.inlineCitation('1', 'bot-artifact:x'), null);
});

test('Context meter needs native tokens and a known window; no guessed percentage', () => {
  const context = { tokens: 190_510, window: 200_000, observedAt: '2026-10-15T00:00:00Z', lastActivityAt: '2026-10-15T00:00:00Z', compacted: false };
  eq({ ...ai.contextMeter(context) }, { tokens: 190_510, window: 200_000, percent: 95, level: 'high', compacted: false, observedAt: context.observedAt });
  assert.equal(ai.contextMeter({ ...context, tokens: 150_000 }).level, 'warn');
  assert.equal(ai.contextMeter({ ...context, tokens: 10_000 }).level, 'ok');
  assert.equal(ai.contextMeter({ ...context, tokens: 400_000 }).percent, 100);
  assert.equal(ai.contextMeter({ ...context, window: null }), null, 'unknown window stays unknown');
  assert.equal(ai.contextMeter({ ...context, window: 0 }), null);
  assert.equal(ai.contextMeter({ ...context, tokens: 1.5 }), null);
  assert.equal(ai.contextMeter(null), null);
  assert.equal(ai.compactTokens(272_000), '272k');
  assert.equal(ai.compactTokens(1_000_000), '1M');
});

test('Subagent display requires native agent thread provenance', () => {
  const activity = { type: 'subAgentActivity', id: 's', kind: 'completed', agentThreadId: 'thread-abcdef123456', agentPath: '/agents/reviewer', model: 'gpt-x', reasoningEffort: 'high' };
  const view = ai.subagentView(activity);
  assert.equal(view.title, 'Subagent completed');
  eq(view.agents.map(a => ({ ...a })), [{ threadId: 'thread-abcdef123456', name: 'reviewer', status: 'completed', message: null }]);
  assert.equal(ai.subagentView({ ...activity, agentThreadId: '' }), null);
  const collab = { type: 'collabAgentToolCall', id: 'c', tool: 'spawnAgent', status: 'completed', senderThreadId: 'main', receiverThreadIds: ['child-1'], prompt: 'Review it', model: null, reasoningEffort: null,
    agentsStates: { 'child-1': { status: 'running', message: null } } };
  assert.equal(ai.subagentView(collab).title, 'Started subagent');
  assert.equal(ai.subagentView(collab).agents[0].status, 'running');
  assert.equal(ai.subagentView({ ...collab, receiverThreadIds: [] }), null, 'no receiver identity keeps the Tool fallback');
  // Claude Task calls arrive as ordinary tool items without agent identities.
  assert.equal(ai.subagentView({ type: 'mcpToolCall', server: 'claude', tool: 'Task' }), null);
});

test('request pattern and attachment metadata are presentation only', () => {
  assert.equal(ai.requestPattern('item/tool/requestUserInput'), 'questionnaire');
  assert.equal(ai.requestPattern('item/commandExecution/requestApproval'), 'confirmation');
  assert.equal(ai.requestPattern('execCommandApproval'), 'confirmation');
  assert.equal(ai.requestPattern('mcpServer/elicitation/request', { mode: 'url' }), 'authorization');
  assert.equal(ai.requestPattern('mcpServer/elicitation/request', { mode: 'form' }), 'form');
  assert.equal(ai.requestPattern('item/unknown'), 'other');
  assert.equal(ai.attachmentKind('image/png', 'a.png'), 'image');
  assert.equal(ai.attachmentKind('application/octet-stream', 'report.PDF'), 'pdf');
  assert.equal(ai.attachmentKind('application/octet-stream', 'main.tsx'), 'code');
  assert.equal(ai.attachmentKind('application/zip', 'x.zip'), 'archive');
  assert.equal(ai.attachmentKind('application/octet-stream', 'blob'), 'file');
  assert.equal(ai.formatBytes(512), '512 B');
  assert.equal(ai.formatBytes(1536), '1.5 KB');
  assert.equal(ai.formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(ai.formatBytes(-1), null);
});

test('components render accessible, display-only markup', () => {
  const { StackTrace } = component('components/ai-elements/stack-trace.tsx');
  const trace = ai.parseStackTrace('TypeError: x\n    at a (/repo/a.js:1:2)\n    at b (/repo/node_modules/b.js:3:4)\n');
  const stack = renderToStaticMarkup(h(StackTrace, { trace }));
  assert.match(stack, /aria-label="Stack trace"/);
  assert.match(stack, /\/repo\/a\.js:1:2/);
  assert.match(stack, /1 library frame/);
  const { ContextMeter } = component('components/ai-elements/context.tsx');
  const meter = renderToStaticMarkup(h(ContextMeter, { meter: ai.contextMeter({ tokens: 50_000, window: 200_000, observedAt: '', lastActivityAt: '', compacted: false }) }));
  assert.match(meter, /aria-label="Context 25% used: 50k of 200k tokens"/);
  assert.doesNotMatch(meter, /<button/, 'no action without an explicit navigation callback');
  const { Sources, InlineCitation } = component('components/ai-elements/sources.tsx');
  const list = renderToStaticMarkup(h(Sources, { sources: ai.messageSources(['https://example.com/a']) }));
  assert.match(list, /Used 1 source/);
  assert.match(list, /rel="noopener noreferrer"/);
  assert.equal(renderToStaticMarkup(h(Sources, { sources: [] })), '');
  assert.match(renderToStaticMarkup(h(InlineCitation, { href: 'https://example.com/a', index: '3', host: 'example.com' })), /aria-label="Source 3: example.com"/);
  const { PlanProgress, PlanStepStatus } = component('components/ai-elements/plan.tsx');
  assert.match(renderToStaticMarkup(h(PlanProgress, { completed: 2, total: 5 })), /aria-label="2 of 5 steps completed"/);
  assert.equal(renderToStaticMarkup(h(PlanProgress, { completed: 0, total: 0 })), '');
  assert.match(renderToStaticMarkup(h(PlanStepStatus, { state: 'running' })), /In progress/);
  const { Marker } = component('components/ai-elements/marker.tsx');
  assert.match(renderToStaticMarkup(h(Marker, null, 'Context compacted')), /role="separator"/);
  const { Subagent } = component('components/ai-elements/subagent.tsx');
  const agent = renderToStaticMarkup(h(Subagent, { view: ai.subagentView({ type: 'subAgentActivity', id: 's', kind: 'started', agentThreadId: 'thread-1', agentPath: 'explorer', model: null, reasoningEffort: null }) }));
  assert.match(agent, /explorer/);
  assert.doesNotMatch(agent, /<button/);
});

test('display wiring adds no sends, answers, queue entries or fetches', () => {
  const read = (path) => readFileSync(path, 'utf8');
  for (const path of ['lib/ai-elements.ts', 'components/ai-elements/tool.tsx', 'components/ai-elements/stack-trace.tsx', 'components/ai-elements/plan.tsx', 'components/ai-elements/sources.tsx',
    'components/ai-elements/context.tsx', 'components/ai-elements/marker.tsx', 'components/ai-elements/subagent.tsx'])
    assert.doesNotMatch(read(path), /\brpc\(|fetch\(|\.send\(|requests\.respond|queue\.|turn\.|dangerouslySetInnerHTML/, path);
  const message = read('app/bots/message.tsx');
  assert.match(message, /copyText=\{item\.aggregatedOutput \?\? ""\}/, 'terminal Copy returns the exact raw output');
  assert.match(message, /item\.exitCode !== 0 && <CommandStackTrace/, 'stack traces only for non-success commands');
  const request = read('app/bots/request-card.tsx');
  assert.match(request, /respond\(result\)/, 'answers still go through the original respond route');
  const followup = read('app/bots/codex-followup.tsx');
  assert.match(followup, /controller\.prefillText\(/, 'Suggestion fills the composer only');
  assert.doesNotMatch(followup, /\.send\(|rpc\(/);
  const workspace = read('app/bots/workspace.tsx');
  assert.match(workspace, /contextMeter\(bot\?\.contextCompaction\?\.context\)/);
  assert.match(workspace, /onOpen=\{\(\) => openDetails\("settings"\)\}/, 'the meter only navigates to existing settings');
});
