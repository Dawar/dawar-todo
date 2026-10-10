import { createHash } from 'node:crypto';

const inputMethod = 'item/tool/requestUserInput';
const stale = () => Object.assign(new Error('This input question changed, expired or was already answered. Read the selected bot context again; nothing was queued or answered.'), { outcome: 'rejected' });
export function inputQuestionVersion(pending) {
  return createHash('sha256').update(JSON.stringify([pending.botId, pending.epoch ?? null, !!pending.async, pending.request])).digest('hex');
}
export function selectedInputQuestions(runtime, bot) {
  const pending = runtime.store.list('pending', bot.id).filter(row => row.request?.method === inputMethod &&
    row.request.params?.threadId === bot.threadId && typeof row.request.params.turnId === 'string' &&
    (row.async || row.epoch === runtime.epoch && bot.activeTurnId === row.request.params.turnId));
  return pending.map(row => {
    const answer = runtime.answers.get(bot, row.id);
    const p = row.request.params;
    return { key: row.id, requestId: String(row.request.id), threadId: bot.threadId, turnId: p.turnId, itemId: p.itemId,
      version: inputQuestionVersion(row), kind: row.async ? 'async' : 'blocking', isBlocking: !row.async && p.isBlocking !== false,
      createdAt: row.createdAt, answerState: answer?.state ?? 'pending',
      voiceAnswerable: !p.questions.some(q => q.isSecret),
      questions: p.questions.map(q => q.isSecret ? { id: q.id, header: q.header, question: 'Private input: use the normal bot controls.', isSecret: true, isOther: false, options: null } : q) };
  });
}

// Rechecked under the normal bot input lock, after any UI answer/switch races.
// This is an observational binding to a native question, not workflow state.
export function validateOperatorQuestion(bot, pending, binding, result) {
  const p = pending?.request?.params;
  if (!binding || binding.botId !== bot.id || binding.threadId !== bot.threadId || pending?.botId !== bot.id ||
      pending.request.method !== inputMethod || p.threadId !== bot.threadId || p.turnId !== binding.turnId ||
      String(pending.request.id) !== binding.requestId || inputQuestionVersion(pending) !== binding.version) throw stale();
  if (p.questions.some(q => q.isSecret)) throw Object.assign(new Error('Private inputs and tool approvals require the normal bot controls.'), { outcome: 'rejected' });
  const keys = Object.keys(result?.answers ?? {});
  if (keys.length !== p.questions.length || keys.some(k => !p.questions.some(q => q.id === k)) ||
      p.questions.some(q => !Array.isArray(result?.answers?.[q.id]?.answers) || result.answers[q.id].answers.length !== 1 ||
        typeof result.answers[q.id].answers[0] !== 'string' || !result.answers[q.id].answers[0].trim() || result.answers[q.id].answers[0].length > 20000))
    throw Object.assign(new Error('Read and answer each exact question with one human-selected option label or free-text answer. Clarify missing or ambiguous answers; nothing was submitted.'), { outcome: 'rejected' });
  if (p.questions.some(q => !q.isOther && q.options?.length && !q.options.some(option => option.label === result.answers[q.id].answers[0])))
    throw Object.assign(new Error('Use the exact human-selected option label for this choice-only question. Clarify the choice before answering.'), { outcome: 'rejected' });
  return pending;
}
