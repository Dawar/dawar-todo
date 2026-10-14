// Bridge-owned transcript for Claude threads, stored in the existing generic
// `records` table so it lives in the same SQLite file and backup as every
// other bot record. Codex keeps its own history; Claude threads are served
// from here in Codex `Thread` / `Turn` / `ThreadItemEntry` shapes.
//
// claudeThread: { id, sessionId, cwd, name, model, effort, instructions,
//   dynamicTools, archived, preview, sessionStarted, nextSeq, createdAt, updatedAt }
// claudeTurn:   { id, botId: threadId, seq, turn, times }

const THREAD = "claudeThread", TURN = "claudeTurn";
const seconds = (ms) => Math.floor(ms / 1000);

export class ClaudeStore {
  constructor(store) { this.store = store; }
  thread(id) { return this.store.get(THREAD, id); }
  threads() { return this.store.list(THREAD); }
  saveThread(thread) { return this.store.put(THREAD, { ...thread, updatedAt: Date.now() }); }
  turns(threadId) { return this.store.list(TURN, threadId).sort((a, b) => a.seq - b.seq); }
  turnRecord(turnId) { return this.store.get(TURN, turnId); }
  /** Persist a turn snapshot; a new turn takes the thread's next sequence. */
  saveTurn(threadId, state) {
    return this.store.transaction(() => {
      const prior = this.store.get(TURN, state.turn.id);
      let seq = prior?.seq;
      if (seq === undefined) {
        const thread = this.thread(threadId);
        seq = thread.nextSeq ?? 1;
        this.saveThread({ ...thread, nextSeq: seq + 1 });
      }
      return this.store.put(TURN, { id: state.turn.id, botId: threadId, seq, turn: state.turn, times: state.times });
    });
  }
  /** Codex `Thread` for a stored Claude thread. */
  nativeThread(record, status, turns = []) {
    return {
      id: record.id, environments: null, extra: null, sessionId: record.sessionId, forkedFromId: null, parentThreadId: null,
      preview: record.preview ?? "", ephemeral: false, section: null, sectionEnteredAt: null, projectId: null,
      historyMode: "paginated", modelProvider: "anthropic", model: record.model ?? null, reasoningEffort: record.effort ?? null,
      createdAt: seconds(record.createdAt), updatedAt: seconds(record.updatedAt), recencyAt: seconds(record.updatedAt),
      status, path: null, cwd: record.cwd, cliVersion: "claude-agent-sdk", originator: "dawar-todo-bots", source: "appServer",
      canAcceptDirectInput: true, threadSource: null, agentNickname: null, agentRole: null, gitInfo: null,
      name: record.name ?? null, daybreakEnabled: null, turns,
    };
  }
  /** `thread/turns/list`: cursors are `seq` values, exclusive in the page direction. */
  turnsPage(threadId, { cursor = null, limit = 20, sortDirection = "desc", itemsView = "full" } = {}) {
    const desc = sortDirection !== "asc";
    const all = this.turns(threadId);
    if (desc) all.reverse();
    const after = cursor === null || cursor === undefined ? null : Number(cursor);
    const rows = after === null ? all : all.filter((r) => (desc ? r.seq < after : r.seq > after));
    const size = Math.max(1, Math.min(Number(limit) || 20, 100));
    const page = rows.slice(0, size);
    return {
      data: page.map((r) => view(r.turn, itemsView)),
      nextCursor: rows.length > size ? String(page.at(-1).seq) : null,
      // Reversing direction includes the anchor turn again.
      backwardsCursor: page.length ? String(desc ? page[0].seq + 1 : page[0].seq - 1) : null,
    };
  }
  /** `thread/items/list`: the cursor is an offset into the ordered item list. */
  itemsPage(threadId, { turnId = null, cursor = null, limit = 8, sortDirection = "desc" } = {}) {
    const entries = [];
    for (const r of this.turns(threadId)) {
      if (turnId && r.id !== turnId) continue;
      for (const item of r.turn.items)
        entries.push({ turnId: r.id, item, startedAtMs: r.times?.[item.id]?.startedAtMs ?? null,
          completedAtMs: r.times?.[item.id]?.completedAtMs ?? null });
    }
    if (sortDirection !== "asc") entries.reverse();
    const start = typeof cursor === "string" && /^\d+$/.test(cursor) ? Number(cursor) : 0;
    const size = Math.max(1, Math.min(Number(limit) || 8, 100));
    const data = entries.slice(start, start + size);
    return {
      data,
      nextCursor: start + size < entries.length ? String(start + size) : null,
      backwardsCursor: data.length ? String(Math.max(0, entries.length - start - 1)) : null,
    };
  }
}

export function view(turn, itemsView = "full") {
  if (itemsView === "full") return { ...turn, itemsView: "full" };
  if (itemsView === "notLoaded") return { ...turn, items: [], itemsView: "notLoaded" };
  const lastAgent = turn.items.findLast((i) => i.type === "agentMessage");
  return { ...turn, itemsView: "summary",
    items: turn.items.filter((i) => i.type === "userMessage" || i === lastAgent) };
}
