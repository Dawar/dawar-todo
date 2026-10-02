import { projectHistoryItem } from '../lib/bot-history-view.ts';
export const MAX_LIVE_EVENT_BYTES = 16 * 1024;

/** Native history owns full data. Stored replay and browser wire share this cap. */
export function boundHistoryEvent(type, data) {
  if (type !== 'codex' || Buffer.byteLength(JSON.stringify(data)) <= MAX_LIVE_EVENT_BYTES) return { type, data };
  const { method, params = {} } = data;
  const turnId = params.turnId ?? params.turn?.id, itemId = params.itemId ?? params.item?.id;
  // A compatible refresh remains meaningful to old clients. New clients can
  // update this descriptor without fetching a page for every closed-tool delta.
  const compact = { reason: 'large-native-event', method, turnId, itemId };
  if (params.item && turnId) {
    const entry = projectHistoryItem({ id: turnId, startedAt: null, status: 'inProgress' }, params.item,
      params.item.type === 'userMessage' && Boolean(params.item.clientId?.startsWith('schedule:')));
    if (entry.item?.type === 'agentMessage' || entry.item?.type === 'plan') {
      entry.item.text = entry.item.text.slice(0, 2048); entry.complete = false;
    } else if (entry.item?.type === 'userMessage') {
      entry.item.content = [{ type: 'text', text: params.item.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n').slice(0, 2048), text_elements: [] }]; entry.complete = false;
    }
    if (data.messageAt) { entry.messageAt = data.messageAt; entry.timeBasis = "received"; }
    Object.assign(entry, ...(data.reply ? [{ reply: data.reply }] : []), ...(data.replyMessages ? [{ replyMessages: data.replyMessages }] : []));
    // Large reply aggregates use the normal bounded page refresh, not oversized replay.
    if (Buffer.byteLength(JSON.stringify(entry)) <= MAX_LIVE_EVENT_BYTES - 2048) compact.entry = entry;
  }
  let supplement;
  if (turnId && (method === 'turn/diff/updated' || method === 'turn/plan/updated')) {
    const diff = method === 'turn/diff/updated';
    supplement = { id: diff ? 'live-turn-diff' : 'live-turn-plan', type: 'plan', text: diff ? '```diff\n' + (params.diff ?? '') + '\n```' : JSON.stringify(params.plan, null, 2) };
    compact.entry = { id: supplement.id, turnId, type: 'plan', item: null, label: diff ? 'Turn changes' : 'Work plan', complete: false, scheduled: false, startedAt: null, status: 'inProgress' };
    compact.itemId = supplement.id;
  }
  if (params.turn) compact.turn = { id: params.turn.id, status: params.turn.status, items: [], startedAt: params.turn.startedAt, completedAt: params.turn.completedAt, durationMs: params.turn.durationMs,
    error: params.turn.error ? { message: String(params.turn.error.message).slice(0, 512) } : null };
  return { type: 'history.refresh', data: compact, supplement };
}
