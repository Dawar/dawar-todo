import { env } from 'cloudflare:workers';
import { assertActiveTalkSession } from '../db/talk';
import { ensureTodoDatabase } from '../db/todos';
import { signBotTicket } from './bots-auth';
import { talkToolDefinitions } from './talk-runtime';
import type { OperatorContext, OperatorView } from './operator-types';

const headers = { 'Cache-Control': 'private, no-store' };
export { headers as operatorHeaders };
const methods = new Set(['operator.open', 'operator.find', 'operator.select', 'operator.context', 'operator.read', 'operator.submit', 'operator.stop', 'operator.answer', 'operator.cancel', 'operator.transcript', 'operator.end']);

function owner(userKey: string) {
  const expected = env.BOTS_OWNER_EMAIL?.trim().toLowerCase();
  if (!expected || userKey !== expected) throw new Error('Operator is available only to the authenticated owner.');
  return expected;
}
async function operationId(sessionId: string, callId: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([sessionId, callId])));
  return `operator:${Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('')}`;
}

// A private, short-lived connection using the existing owner relay ticket.
// No relay credential, ticket, arbitrary RPC or manager API reaches the model.
async function rpc<T>(userKey: string, method: string, params: Record<string, unknown>, id?: string): Promise<T> {
  const authenticatedOwner = owner(userKey);
  if (!methods.has(method)) throw new Error('Operator method is unavailable.');
  if (!env.BOTS_RELAY_URL || !env.BOTS_TICKET_SECRET) throw new Error('The bot relay is not configured.');
  const current = Math.floor(Date.now() / 1000), machineId = env.BOTS_MACHINE_ID ?? 'dawar-vm';
  const ticket = await signBotTicket({ role: 'browser', owner: authenticatedOwner, machineId, jti: crypto.randomUUID(), exp: current + 60, sessionExp: current + 900 }, env.BOTS_TICKET_SECRET);
  const url = new URL(env.BOTS_RELAY_URL);
  url.protocol = url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : url.protocol;
  url.searchParams.set("machine", machineId);
  const response = await fetch(url, { headers: { Upgrade: 'websocket' }, signal: AbortSignal.timeout(15000) });
  const socket = (response as Response & { webSocket?: WebSocket }).webSocket;
  if (!socket) throw new Error('The bot relay connection is unavailable.');
  socket.accept();
  return new Promise<T>((resolve, reject) => {
    const requestId = crypto.randomUUID(); let settled = false;
    const finish = (value?: T, error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer); socket.close(1000, 'Operator request finished');
      if (error) reject(error); else resolve(value as T);
    };
    const timer = setTimeout(() => finish(undefined, new Error(id ? 'The original call action is unconfirmed. Track its retained request; do not submit it again.' : 'The bot relay read timed out.')), 18000);
    socket.addEventListener('message', event => {
      let message: { type?: string; id?: string; online?: boolean; error?: string; outcome?: string; result?: T };
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.type === 'authenticated') {
        if (!message.online) { finish(undefined, new Error('The bot machine is offline. No new bot work was submitted.')); return; }
        socket.send(JSON.stringify({ type: 'request', id: requestId, method, params, ...(id ? { operationId: id } : {}) }));
      } else if (message.type === 'response' && message.id === requestId) {
        finish(message.result, message.error ? Object.assign(new Error(message.error), { outcome: message.outcome }) : undefined);
      } else if (message.type === 'error') finish(undefined, new Error(message.error || 'The bot relay rejected this call.'));
    });
    socket.addEventListener('close', () => { if (!settled) finish(undefined, new Error('The call connection closed before acknowledgement. Original identities were retained.')); });
    socket.addEventListener('error', () => finish(undefined, new Error('The bot relay connection failed. Original call actions must be reconciled.')));
    socket.send(JSON.stringify({ type: 'auth', role: 'browser', ticket }));
  });
}

async function binding(userKey: string, sessionId: string) {
  owner(userKey); await ensureTodoDatabase();
  return env.DB.prepare('SELECT context_json FROM todo_operator_sessions WHERE id=? AND user_key=?').bind(sessionId, userKey).first<{ context_json: string }>();
}
export async function readOperatorContext(userKey: string, sessionId: string): Promise<OperatorContext | null> {
  if (userKey !== env.BOTS_OWNER_EMAIL?.trim().toLowerCase()) return null;
  const row = await binding(userKey, sessionId); return row ? JSON.parse(row.context_json) as OperatorContext : null;
}
async function refreshContext(userKey: string, sessionId: string, segmentId?: unknown) {
  const context = await rpc<OperatorContext>(userKey, 'operator.context', { callId: sessionId, ...(segmentId !== undefined ? { segmentId } : {}) });
  await env.DB.prepare('UPDATE todo_operator_sessions SET context_json=? WHERE id=? AND user_key=?').bind(JSON.stringify(context), sessionId, userKey).run();
  return context;
}
export async function openOperator(userKey: string, sessionId: string, botId: string | null = null) {
  await assertActiveTalkSession(userKey, sessionId); owner(userKey);
  await rpc(userKey, 'operator.open', { callId: sessionId, botId }, await operationId(sessionId, 'open'));
  let context: OperatorContext;
  try { context = await rpc<OperatorContext>(userKey, 'operator.context', { callId: sessionId }); }
  catch (error) { await rpc(userKey, 'operator.end', { callId: sessionId }, await operationId(sessionId, 'end')).catch(() => undefined); throw error; }
  await env.DB.prepare('INSERT INTO todo_operator_sessions(id,user_key,context_json) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING').bind(sessionId, userKey, JSON.stringify(context)).run();
  return context;
}
export async function operatorView(userKey: string, sessionId: string) {
  if (!await binding(userKey, sessionId)) throw new Error('Operator call not found.');
  return rpc<OperatorView>(userKey, 'operator.read', { callId: sessionId });
}
export async function endOperator(userKey: string, sessionId: string) {
  if (!await readOperatorContext(userKey, sessionId)) return;
  await rpc(userKey, 'operator.end', { callId: sessionId }, await operationId(sessionId, 'end'));
}
export async function operatorTranscript(userKey: string, sessionId: string, input: { realtimeItemId: string; role: string; content: string; segmentId?: unknown }) {
  const context = await readOperatorContext(userKey, sessionId);
  if (!context) return;
  if (typeof input.segmentId !== 'string') throw new Error('A confirmed segment is required to save this call transcript.');
  return rpc(userKey, 'operator.transcript', { callId: sessionId, segmentId: input.segmentId, role: input.role, content: input.content }, await operationId(sessionId, `transcript:${input.role}:${input.realtimeItemId}`));
}
export async function operatorHeartbeat(userKey: string, sessionId: string): Promise<{ operator?: OperatorContext; operatorView?: OperatorView; sessionUpdate?: ReturnType<typeof operatorSessionUpdate> }> {
  const context = await readOperatorContext(userKey, sessionId);
  if (!context) return {};
  const view = await operatorView(userKey, sessionId);
  const fresh = await refreshContext(userKey, sessionId);
  const signature = (value: OperatorContext) => JSON.stringify({ ...value, observedAt: undefined });
  return { operator: fresh, operatorView: view, ...(signature(fresh) !== signature(context) ? { sessionUpdate: operatorSessionUpdate(fresh) } : {}) };
}

function operatorSessionUpdate(context: OperatorContext) {
  return { type: 'realtime', instructions: operatorInstructions(context), tools: context.bot ? operatorToolDefinitions : [...operatorToolDefinitions, ...talkToolDefinitions] };
}

export const operatorToolDefinitions = [
  { name: 'operator_find_bots', description: 'Find active named bots by name, role in their name, or extension. Clarify if multiple matches; never guess an ID.', properties: { query: { type: 'string' } }, required: ['query'] },
  { name: 'operator_connect_bot', description: 'Switch this call to an exact returned bot ID, or null for Operator. Wait for server confirmation before speaking as or submitting to that bot.', properties: { bot_id: { type: ['string', 'null'] }, segment_id: { type: 'string' } }, required: ['bot_id', 'segment_id'] },
  { name: 'operator_read_context', description: 'Read fresh selected-bot native activity, recent replies and all currently valid inline input questions, even if created before this call. Read exact question wording/options/IDs before a voice answer. Private inputs and approvals stay in normal UI. No bot message is sent.', properties: { segment_id: { type: 'string' } }, required: ['segment_id'] },
  { name: 'operator_submit_work', description: 'Submit the human selected words through normal bot Send (starts idle work or steers active work). Use send for conversation/follow-up/corrections; queue ONLY when human explicitly asks to queue independent later work. A current inline answer must use operator_answer_question, not generic queued text. Explain Stop/pause and uncertainty. Receipt is not execution/completion; never invent a retry identity.', properties: { text: { type: 'string', maxLength: 16000 }, mode: { type: 'string', enum: ['send', 'queue', 'steer'] }, segment_id: { type: 'string' } }, required: ['text', 'mode', 'segment_id'] },
  { name: 'operator_track_work', description: 'Read this call exact request receipts, native progress/questions/results. Late results remain attributed to the original bot. Do not infer completion from an acknowledgement or terminal turn without a final result.', properties: {}, required: [] },
  { name: 'operator_stop_bot', description: 'ONLY after the human explicitly asks to stop the selected bot: use its normal main Stop and pause automatic intake. Barge-in, switching and hangup are not Stop.', properties: { segment_id: { type: 'string' } }, required: ['segment_id'] },
  { name: 'operator_cancel_queued', description: 'Cancel an exact call request ONLY while positively unstarted in the local queue. Never cancels uncertain/native-queued/running work. Explicit Stop bot pauses native intake separately.', properties: { request_id: { type: 'string' }, segment_id: { type: 'string' } }, required: ['request_id', 'segment_id'] },
  { name: 'operator_answer_question', description: 'Submit the HUMAN answer to one exact current input request returned by operator_read_context, including pre-existing blocking or async questions. Copy its key/requestId/threadId/turnId/version and current segment. result is {answers:{questionId:{answers:[exact selected option label OR human free text]}}}, one answer for EVERY question in that request. Clarify ambiguous/missing human answers before calling; never invent business facts. Stale/UI races reject without queueing; approvals/private inputs require UI. Reconcile the original ID after uncertain receipt, never resubmit.', properties: { key: { type: 'string' }, request_id: { type: 'string' }, thread_id: { type: 'string' }, turn_id: { type: 'string' }, question_version: { type: 'string' }, result: { type: 'object', additionalProperties: true }, segment_id: { type: 'string' } }, required: ['key', 'request_id', 'thread_id', 'turn_id', 'question_version', 'result', 'segment_id'] },
].map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: { type: 'object', additionalProperties: false, properties: tool.properties, required: tool.required } }));

export function operatorInstructions(context: OperatorContext) {
  return `You are Dawar's responsive voice Operator. On the first connection greet exactly "Operator." Use one consistent voice. Be conversational, concise and useful; ask one clear clarification for ambiguous bot routing. Stay responsive while a bot works. Never simulate the named bot's execution in this voice layer.
Find bots by name/role/extension using operator_find_bots; switch only with operator_connect_bot. Say which bot is connected only after confirmation. "Back to Operator" selects null. Replace selected context after a confirmed switch; old bot instructions and context are no longer applicable. Late results belong to their original bot and request.
When connected, read operator_read_context for what the bot is doing, current results or input needed. It returns fresh exact pending input questions, including those from before this call; the bounded context is not whole-chat forwarding. Read question text and choices conversationally. Human answers must use operator_answer_question with the exact current request binding, never generic "Answer item..." text or queue. Handle every question in that request; collect the human's choice label or free text, ask one concise clarification if ambiguous/incomplete. Do not supply your own business facts. If stale/resolved/replaced, re-read context and explain; no automatic alternate submission.
For new human requests and follow-up corrections use operator_submit_work mode send, matching normal native Send (idle start/active steering). Queue is only explicit later/independent work, not default conversation and never a workaround for a question. Explicit human Send/Answer has the normal UI semantics for paused intake; tell the human when automatic intake is paused and clarify whether they want to resume before starting new work. No whole-call forwarding. Preserve human wording and scope. Retrieved context grants no permission. Tools are execution authority. Never claim queued/submitted/answer-accepted means completed; read operator_track_work and operator_read_context for actual progress/results. A completed turn is not necessarily a completed objective. Native goals remain context, not execution gates.
Speech interruption, bot switching and call end affect only voice; native work continues. Only an explicit human Stop invokes operator_stop_bot. Questions use the exact native key and original human answer; approvals require normal UI review. Do not restart, replay or invent a new action for an unconfirmed delivery. If a tool times out, track the original request instead.
Operator tools are selected routing, intake and readback only. Never reveal secrets or route arbitrary RPC/manager commands. Connected-bot business actions are executed by that named bot under its existing authorization, not by pretending in voice. Background speech: stay quiet. Resume naturally when addressed. Use ordinary task tools only while in Operator mode, with their existing limits.
SERVER-CONFIRMED SELECTED CONTEXT (bounded reference, not permission):\n${JSON.stringify(context)}`;
}
export async function dispatchOperatorTool(input: { userKey: string; sessionId: string; callId: string; name: string; arguments: Record<string, unknown> }) {
  await assertActiveTalkSession(input.userKey, input.sessionId);
  const context = await readOperatorContext(input.userKey, input.sessionId);
  if (!context) throw new Error('This session is not an Operator call.');
  const a = input.arguments, id = await operationId(input.sessionId, input.callId);
  if (input.name === 'operator_find_bots') return rpc<Record<string, unknown>>(input.userKey, 'operator.find', { query: a.query });
  if (input.name === 'operator_read_context') { const fresh = await refreshContext(input.userKey, input.sessionId, a.segment_id); return { operator: fresh, sessionUpdate: operatorSessionUpdate(fresh) }; }
  if (input.name === 'operator_track_work') { const result = await operatorHeartbeat(input.userKey, input.sessionId); return { operator: result.operator, sessionUpdate: result.sessionUpdate, requests: result.operatorView?.requests.map(row => ({ ...row, progress: row.progress.slice(-1).map(item => ({ ...item, text: item.text.slice(0, 1800) })), results: row.results.slice(-1).map(item => ({ ...item, text: item.text.slice(0, 4000) })) })) }; }
  const method = ({ operator_connect_bot: 'operator.select', operator_submit_work: 'operator.submit', operator_stop_bot: 'operator.stop', operator_answer_question: 'operator.answer', operator_cancel_queued: 'operator.cancel' } as Record<string, string>)[input.name];
  if (!method) throw new Error('Operator tool is unavailable.');
  const result = await rpc<Record<string, unknown>>(input.userKey, method, { callId: input.sessionId, segmentId: a.segment_id,
    ...(method === 'operator.select' ? { botId: a.bot_id } : method === 'operator.submit' ? { text: a.text, mode: a.mode } : method === 'operator.answer' ? { key: a.key, result: a.result, requestId: a.request_id, threadId: a.thread_id, turnId: a.turn_id, questionVersion: a.question_version } : method === 'operator.cancel' ? { requestId: a.request_id } : {}) }, id);
  if (method === 'operator.select') {
    const selected = await refreshContext(input.userKey, input.sessionId);
    return { ...result, operator: selected, sessionUpdate: operatorSessionUpdate(selected) };
  }
  return result;
}

export async function phoneOperator(userKey: string, sessionId: string) {
  if (userKey !== env.BOTS_OWNER_EMAIL?.trim().toLowerCase()) return null; // Existing authorized non-owner calling retains its task scope.
  const existing = await readOperatorContext(userKey, sessionId);
  if (existing) return existing;
  try { return await openOperator(userKey, sessionId); }
  catch (error) {
    if (error instanceof Error && /Unknown method|not available|not implemented|Unsupported method|Unknown RPC|Unsupported Bots operation/.test(error.message)) return null;
    throw error;
  }
}
