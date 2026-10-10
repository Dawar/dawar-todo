// Optional native protocol probe. Linux + bwrap + existing codex required.
// No model turn is started. Network namespace is disabled; the real home is hidden.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import os from 'node:os';
import assert from 'node:assert/strict';

const directory = await mkdtemp(join(tmpdir(), 'dawar-native-perf-7c578085-'));
let child;
try {
  const binary = await realpath(process.env.PERF_CODEX ?? execFileSync('which', ['codex'], { encoding: 'utf8' }).trim());
  const isolatedHome = join(directory, 'home'), work = join(directory, 'work'), mountedBinary = join(directory, 'codex');
  await mkdir(isolatedHome); await mkdir(work); await writeFile(mountedBinary, '');
  child = spawn('bwrap', ['--die-with-parent', '--unshare-net', '--ro-bind', '/', '/', '--bind', directory, directory,
    '--ro-bind', binary, mountedBinary, '--bind', isolatedHome, os.homedir(), '--chdir', work,
    mountedBinary, 'app-server', '--stdio'], { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let id = 0; const pending = new Map(); let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  createInterface({ input: child.stdout }).on('line', (line) => {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (!pending.has(m.id)) return;
    const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.timer);
    if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const next = ++id;
    const timer = setTimeout(() => { pending.delete(next); reject(new Error(`${method} timeout; process exit=${child.exitCode}; ${stderr.slice(-1500)}`)); }, 15_000);
    pending.set(next, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id: next, method, params }) + '\n');
  });
  const init = await rpc('initialize', { clientInfo: { name: 'synthetic-history-probe', version: '1' }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  const userText = 'USER-SYNTHETIC '.repeat(1000), assistantText = 'ASSISTANT-SYNTHETIC '.repeat(1000), toolText = 'TOOL-SYNTHETIC '.repeat(10000);
  const rawItems = [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: userText }] },
      { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'synthetic-only-not-executed' }), call_id: 'synthetic-call' },
      { type: 'function_call_output', call_id: 'synthetic-call', output: toolText },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: assistantText }], phase: 'final_answer' },
    ];
  let { thread } = await rpc('thread/resume', { threadId: '00000000-0000-4000-8000-000000000001', cwd: work,
    approvalPolicy: 'never', sandbox: 'read-only', history: rawItems });
  // Raw injected messages alone contain no turn boundaries. Supply a synthetic
  // rollout with native lifecycle records, then let native history parse it.
  const nativePath = thread.path.replace(os.homedir(), isolatedHome);
  const records = (await readFile(nativePath, 'utf8')).trim().split('\n').map(JSON.parse);
  const turnId = '00000000-0000-4000-8000-000000000002';
  const fixtureThreadId = '00000000-0000-4000-8000-000000000003';
  const metadata = records.find((r) => r.type === 'session_meta'); metadata.payload.id = fixtureThreadId;
  const row = (type, payload) => JSON.stringify({ timestamp: '2026-09-26T12:00:00Z', type, payload });
  const syntheticRollout = join(work, 'synthetic-rollout.jsonl');
  await writeFile(syntheticRollout, [JSON.stringify(metadata),
    row('event_msg', { type: 'task_started', turn_id: turnId, model_context_window: 100000 }),
    row('event_msg', { type: 'user_message', message: userText, images: [], local_images: [], text_elements: [] }),
    row('event_msg', { type: 'exec_command_begin', call_id: 'synthetic-call', process_id: null, turn_id: turnId, command: ['synthetic-only-not-executed'], cwd: work, parsed_cmd: [], source: 'agent', interaction_input: null }),
    row('event_msg', { type: 'exec_command_end', call_id: 'synthetic-call', process_id: null, turn_id: turnId, command: ['synthetic-only-not-executed'], cwd: work, parsed_cmd: [], source: 'agent', interaction_input: null, stdout: toolText, stderr: '', aggregated_output: toolText, exit_code: 0, duration: { secs: 0, nanos: 1000 }, formatted_output: toolText, status: 'completed' }),
    ...rawItems.map((item) => row('response_item', item)),
    row('event_msg', { type: 'agent_message', message: assistantText, phase: 'final_answer' }),
    row('event_msg', { type: 'task_complete', turn_id: turnId, last_agent_message: assistantText }),
  ].join('\n') + '\n');
  await rpc('thread/unsubscribe', { threadId: thread.id });
  ({ thread } = await rpc('thread/resume', { threadId: fixtureThreadId, path: syntheticRollout, cwd: work, approvalPolicy: 'never', sandbox: 'read-only' }));
  await rpc('thread/read', { threadId: thread.id, includeTurns: true });
  const result = { native: init.userAgent, fixture: { userChars: userText.length, assistantChars: assistantText.length, toolChars: toolText.length }, views: {} };
  for (const itemsView of ['notLoaded', 'summary', 'full']) {
    const page = await rpc('thread/turns/list', { threadId: thread.id, limit: 20, itemsView, sortDirection: 'desc' });
    const items = page.data.flatMap((t) => t.items);
    result.views[itemsView] = { bytes: Buffer.byteLength(JSON.stringify(page)), turns: page.data.length,
      items: items.map((item) => ({ type: item.type, serializedChars: JSON.stringify(item).length,
        textChars: item.text?.length, outputChars: item.aggregatedOutput?.length,
        inputChars: item.type === 'userMessage' ? item.content.reduce((n, c) => n + (c.text?.length ?? 0), 0) : undefined })),
      preservesUser: JSON.stringify(page).includes(userText), preservesAssistant: JSON.stringify(page).includes(assistantText), preservesTool: JSON.stringify(page).includes(toolText) };
  }
  assert.equal(result.views.full.turns, 1, 'Synthetic turn did not hydrate');
  assert.ok(result.views.full.preservesUser && result.views.full.preservesAssistant, 'Synthetic message text did not hydrate');
  result.toolComparisonConclusive = result.views.full.items.some((item) => item.type === 'commandExecution') && result.views.full.preservesTool;
  result.limit = result.toolComparisonConclusive ? null : 'Synthetic command item did not hydrate even in full. No conclusion about native tool-summary semantics or payload savings is valid.';
  console.log(JSON.stringify(result, null, 2));
} finally {
  child?.kill('SIGTERM');
  if (child && child.exitCode === null) await Promise.race([new Promise((r) => child.once('exit', r)), new Promise((r) => setTimeout(r, 1000))]);
  if (child && child.exitCode === null) child.kill('SIGKILL');
  await rm(directory, { recursive: true, force: true, maxRetries: 3 });
}
