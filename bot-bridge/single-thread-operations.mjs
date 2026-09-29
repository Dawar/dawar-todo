import { preferencePatch } from './bot-preferences.mjs';

// These mutations accept only local durable state. Receipt + accepted input
// commit together; failed storage never dispatches an unrecoverable operation.
export async function acceptSingleThreadOperation(runtime, request, fingerprint) {
  const { method, botId, params, operationId } = request;
  if (!['bursts.submit', 'bursts.start', 'bursts.stop', 'work.resume', 'bots.update', 'peers.send', 'peers.reply', 'peers.cancel'].includes(method)) return null;
  if (method === 'bots.update' && (!Object.keys(params).length || Object.keys(params).some(k => !['avatar', 'burstQuietSeconds'].includes(k)))) return null;
  const bot = runtime.store.bot(botId);
  try {
    if (method.startsWith('peers.')) return { result: await runtime.peers.mutate(bot, method, params, operationId, fingerprint) };
    let mutate;
    if (method === 'bursts.submit') mutate = await runtime.bursts.prepare(bot, params, operationId);
    else if (method === 'bursts.start') mutate = () => runtime.bursts.start(bot, operationId);
    else if (method === 'bursts.stop') mutate = () => runtime.bursts.pause(bot.id);
    else if (method === 'work.resume') mutate = await runtime.primary.prepareResume(bot);
    else { const patch = preferencePatch(bot, params); mutate = () => runtime.saveBot(runtime.store.bot(botId), patch); }
    const result = runtime.store.transaction(() => {
      const result = mutate();
      runtime.store.saveOperation(operationId, fingerprint, 'done', { method, botId, params, result, localOnly: 'single-thread-v1', createdAt: new Date().toISOString() });
      return result;
    });
    return { result };
  } catch (error) {
    const committed = runtime.store.operation(operationId);
    if (committed?.status === 'done') return { result: committed.result };
    error.outcome = committed ? 'uncertain' : 'rejected'; throw error;
  }
}
