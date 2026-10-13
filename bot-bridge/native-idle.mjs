import { terminalTurn } from './native-turn.mjs';

// Process-owned native state, not an all-account history scan. Extra threads
// must be registered main conversations when checking account recovery.
export async function inspectNativeIdle(runtime, read, { terminalErrors = false, extraThreads = [], onlyThreads = null } = {}) {
  const seen = new Set(), threads = new Set();
  let cursor = null;
  if (onlyThreads !== null && (!Array.isArray(onlyThreads) || !onlyThreads.length || onlyThreads.length > 100 ||
      onlyThreads.some(id => !runtime.store.bots().some(b => b.threadId === id && !b.archived && !b.deletedAt))))
    throw Error('Scoped recovery requires registered bot conversations.');
  if (onlyThreads === null) do {
    if (seen.has(cursor) || seen.size >= 10) throw Error('Loaded native session pagination exceeded its bound.');
    seen.add(cursor);
    const page = await read('thread/loaded/list', { cursor, limit: 100 });
    if (!Array.isArray(page?.data) || !Object.hasOwn(page, 'nextCursor') || page.data.some(id => typeof id !== 'string') ||
        page.nextCursor !== null && typeof page.nextCursor !== 'string') throw Error('Loaded native session metadata is incomplete.');
    page.data.forEach(id => threads.add(id)); cursor = page.nextCursor;
  } while (cursor !== null);
  else onlyThreads.forEach(id => threads.add(id));
  for (const id of extraThreads) {
    if (typeof id !== 'string' || !runtime.store.bots().some(b => b.threadId === id && !b.archived && !b.deletedAt))
      throw Error('Native recovery thread is not registered.');
    threads.add(id);
  }
  if (threads.size > 100) throw Error('Native state observation exceeds 100 sessions.');
  let active = 0, activeGoals = 0, nativeQueues = 0, backgroundTerminals = 0;
  const settledErrors = [];
  for (const threadId of threads) {
    const { thread } = await read('thread/read', { threadId, includeTurns: false });
    if (thread?.id !== threadId) throw Error('Native session identity changed.');
    if (thread.status?.type === 'systemError' && terminalErrors) {
      if (!runtime.store.bots().some(b => b.threadId === threadId && !b.archived && !b.deletedAt))
        throw Error('Unregistered native system error remains unresolved.');
      const page = await read('thread/turns/list', { threadId, cursor: null, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
      if (!Array.isArray(page?.data) || page.data.length !== 1 || !terminalTurn(page.data[0]))
        throw Error('Native system error has no current terminal turn proof.');
      settledErrors.push({ threadId, turnId: page.data[0].id, status: page.data[0].status });
    } else if (!['idle', 'notLoaded'].includes(thread.status?.type)) { active++; continue; }
    const goal = await read('thread/goal/get', { threadId });
    if (!goal || !Object.hasOwn(goal, 'goal') || goal.goal && (goal.goal.threadId !== threadId ||
        !['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'].includes(goal.goal.status)))
      throw Error('Native Goal state is unknown.');
    if (goal.goal?.status === 'active') activeGoals++;
    const queue = await read('thread/queue/list', { threadId, cursor: null, limit: 1 });
    if (!Array.isArray(queue?.data) || !Object.hasOwn(queue, 'nextCursor') || queue.nextCursor !== null && typeof queue.nextCursor !== 'string')
      throw Error('Native queue state is unknown.');
    if (queue.data.length || queue.nextCursor !== null) nativeQueues++;
    // notLoaded sessions have no process-owned background command. Loaded
    // idle/systemError sessions can still retain terminals, which must finish.
    if (thread.status.type !== 'notLoaded') {
      const terminals = await read('thread/backgroundTerminals/list', { threadId, cursor: null, limit: 1 });
      if (!Array.isArray(terminals?.data) || !Object.hasOwn(terminals, 'nextCursor') ||
          terminals.nextCursor !== null && typeof terminals.nextCursor !== 'string') throw Error('Native background tool state is unknown.');
      if (terminals.data.length || terminals.nextCursor !== null) backgroundTerminals++;
    }
  }
  return { loaded: threads.size, active, activeGoals, nativeQueues, backgroundTerminals, settledErrors,
    safe: !active && !activeGoals && !nativeQueues && !backgroundTerminals };
}
