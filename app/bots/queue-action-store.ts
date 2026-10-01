export const queueActionPrefix = (owner: string, botId: string) => `dawar:bot:queue-action:${JSON.stringify([owner, botId])}:`;
export type QueueActionMethod = 'queue.delete' | 'queue.reorder' | 'queue.resume' | 'queue.move' | 'queue.merge' | 'queue.update' | 'queueLists.save' | 'queueLists.delete' | 'queueLists.flush';
export type PendingQueueAction = { id: string; method: QueueActionMethod; params: Record<string, unknown>; owner: string; botId: string };
const message = (error: unknown) => error instanceof Error ? error.message : 'Queue action could not be confirmed.';
export function readQueueAction(owner: string, botId: string): { pending: PendingQueueAction | null; error: string } {
  const prefix = queueActionPrefix(owner, botId);
  try {
    if (typeof localStorage === 'undefined') return { pending: null, error: '' };
    const keys = Array.from({length:localStorage.length},(_,index)=>localStorage.key(index)).filter((key):key is string=>Boolean(key?.startsWith(prefix))).sort();
    for (const key of keys) {
      const raw = localStorage.getItem(key); if (!raw) continue;
      const p = JSON.parse(raw) as PendingQueueAction;
      const params = p.params;
      const validParams = params && typeof params === 'object' && !Array.isArray(params) && (p.method === 'queue.delete' ? typeof params.id === 'string' && params.id.length > 0 && (params.expectedRevision === undefined || Number.isSafeInteger(params.expectedRevision) && Number(params.expectedRevision) > 0) :
        p.method === 'queue.reorder' ? (Array.isArray(params.ids) && params.ids.every(id => typeof id === 'string') || typeof params.id === 'string' && (params.beforeId === null || typeof params.beforeId === 'string') && Number.isSafeInteger(params.expectedRevision) && Number(params.expectedRevision)>0) : p.method === 'queue.resume' ? Object.keys(params).length === 0 : p.method === 'queue.move' || p.method === 'queue.merge' ? Array.isArray(params.items) && params.items.length > 0 && params.items.every(item => item && typeof item.id === 'string' && Number.isSafeInteger(item.revision)) : p.method === 'queue.update' ? typeof params.id === 'string' && typeof params.text === 'string' && Array.isArray(params.attachments) : p.method === 'queueLists.save' ? typeof params.name === 'string' && (params.cron === null || typeof params.cron === 'string') && typeof params.timeZone === 'string' && typeof params.enabled === 'boolean' : ['queueLists.delete','queueLists.flush'].includes(p.method) && typeof params.id === 'string' && Number.isSafeInteger(params.expectedRevision));
      if (p.owner !== owner || p.botId !== botId || typeof p.id !== 'string' || !/^[a-zA-Z0-9:_-]{10,180}$/.test(p.id) || key !== prefix+p.id || !validParams)
        throw Error('Saved queue action cannot be read. Keep this site’s storage and ask for recovery.');
      return { pending: p, error: '' };
    }
    return { pending: null, error: '' };
  } catch (error) { return { pending: null, error: message(error) }; }
}
