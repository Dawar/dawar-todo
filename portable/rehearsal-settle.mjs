import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const TERMINAL = new Set(['completed', 'failed', 'interrupted']);

/**
 * The rehearsal stand-in runs no Codex, so copied in-flight state never
 * finishes on its own and the drain could never pass. In the COPY only, settle
 * what the real agent's watchdogs (reconcileActiveTurns, reconcileAcceptedInbox)
 * would: a bot's active turn, or an accepted inbox row's original turn, whose
 * exact native turn (same thread and turn ID) is terminal in read-only native
 * history. Absent, ambiguous or inProgress turns stay and keep blocking; the
 * drain names them through RuntimeMaintenance.blockers().
 */
export function settleProvenTerminal(store, historyPath) {
  if (!historyPath || !existsSync(historyPath)) return [];
  const native = new DatabaseSync(historyPath, { readOnly: true });
  try {
    const turns = native.prepare('SELECT status FROM thread_turns WHERE thread_id=? AND turn_id=? LIMIT 2');
    const terminal = (threadId, turnId) => {
      if (typeof threadId !== 'string' || typeof turnId !== 'string' || !turnId) return null;
      const rows = turns.all(threadId, turnId);
      return rows.length === 1 && TERMINAL.has(rows[0].status) ? rows[0].status : null;
    };
    const settled = [];
    store.transaction(() => {
      const bots = new Map(store.bots().map(b => [b.id, b]));
      for (const { id } of store.db.prepare(`SELECT id FROM records WHERE kind='primaryInbox' AND json_extract(json,'$.state')='accepted'
          AND json_extract(json,'$.terminalStatus') IS NULL AND json_extract(json,'$.turnId') IS NOT NULL ORDER BY rowid`).all()) {
        const row = store.get('primaryInbox', id), bot = bots.get(row?.botId);
        const status = bot && row.threadId === bot.threadId ? terminal(row.threadId, row.turnId) : null;
        if (!status) continue;
        store.put('primaryInbox', { ...row, terminalStatus: status });
        settled.push({ kind: 'primaryInbox', id, botId: row.botId, turnId: row.turnId, status });
      }
      for (const bot of bots.values()) {
        const status = bot.activeTurnId ? terminal(bot.threadId, bot.activeTurnId) : null;
        if (!status) continue;
        store.saveBot({ ...bot, activeTurnId: null, status: status === 'interrupted' ? 'interrupted' : status === 'failed' ? 'error' : 'idle' });
        settled.push({ kind: 'activeTurn', id: bot.id, botId: bot.id, turnId: bot.activeTurnId, status });
      }
    });
    return settled;
  } finally { native.close(); }
}
