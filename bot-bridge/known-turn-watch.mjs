import { findNativeTurn } from './native-reconcile.mjs';
import { usableTurn, terminalTurn } from './native-turn.mjs';

function needsOriginalItems(runtime, bot, turnId) {
  const exists = (sql, params) => Boolean(runtime.store.db.prepare(sql).get(...params));
  // Existence checks return one scalar, never materialize historical prompt,
  // question or Plan bodies merely to decide which native view is necessary.
  return Boolean(runtime.scheduledContext(bot.id, turnId)) ||
    exists(`SELECT 1 FROM records WHERE kind='pending' AND bot_id=?
      AND json_extract(json,'$.request.params.threadId')=? AND json_extract(json,'$.request.params.turnId')=? LIMIT 1`, [bot.id, bot.threadId, turnId]) ||
    exists(`SELECT 1 FROM records WHERE kind='planExecution' AND bot_id=?
      AND json_extract(json,'$.threadId')=? AND json_extract(json,'$.turnId')=?
      AND COALESCE(json_extract(json,'$.state'),'') NOT IN ('consumed','superseded','finished') LIMIT 1`, [bot.id, bot.threadId, turnId]) ||
    exists(`SELECT 1 FROM records WHERE kind='run' AND bot_id=?
      AND json_extract(json,'$.status') IN ('starting','running','uncertain')
      AND COALESCE(json_extract(json,'$.executionLane'),'main-legacy')<>'run-v1'
      AND (json_extract(json,'$.threadId') IS NULL OR json_extract(json,'$.threadId')=?)
      AND (json_extract(json,'$.turnId') IS NULL OR json_extract(json,'$.turnId')=?) LIMIT 1`, [bot.id, bot.threadId, turnId]) ||
    exists(`SELECT 1 FROM records WHERE kind='runTurn' AND bot_id=?
      AND json_extract(json,'$.status') IN ('starting','running','uncertain') AND json_extract(json,'$.laneId') IS NULL
      AND (json_extract(json,'$.threadId') IS NULL OR json_extract(json,'$.threadId')=?)
      AND (json_extract(json,'$.turnId') IS NULL OR json_extract(json,'$.turnId')=?) LIMIT 1`, [bot.id, bot.threadId, turnId]);
}

// Only the confirmed-current watchdog calls this projection. Client/receipt
// discovery keeps findNativeTurn's original full-evidence contract.
export async function readKnownActiveTurn(runtime, bot, cursor, current) {
  let found;
  try { found = await runtime.historyReads.metadata(bot.threadId, bot.activeTurnId, cursor); }
  catch { /* Preserve the existing full reader's hydration/error recovery. */ }
  if (!current()) return { turn: null, nextCursor: null, completeEvidence: false };
  const turn = found?.turn;
  const needsItems = !usableTurn(turn) || turn.id !== bot.activeTurnId || terminalTurn(turn) ||
    !['summary', 'full'].includes(turn.itemsView) || needsOriginalItems(runtime, bot, turn.id);
  if (!needsItems) return { ...found, completeEvidence: turn.itemsView === 'full' };
  // Absence/sparse summaries do not narrow the original four-by-25 discovery
  // bound or its continuation. Terminal/provenance consumers need actual full
  // items; a requested view alone does not prove the response supplied them.
  const location = usableTurn(turn) && turn.id === bot.activeTurnId
    ? runtime.historyReads.location(bot.threadId, turn.id) : null;
  const full = await findNativeTurn(runtime, bot.threadId, {
    turnId: bot.activeTurnId, cursor: location ? location.cursor : cursor,
  });
  if (!current() || full.turn && full.turn.itemsView !== 'full')
    return { turn: null, nextCursor: full.nextCursor, completeEvidence: false };
  return { ...full, completeEvidence: Boolean(full.turn) };
}
