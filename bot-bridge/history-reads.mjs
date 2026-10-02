// Read admission and cursor hints only. Neither cached activity nor delivery
// outcomes live here. Every returned page is a fresh native observation.
export class HistoryReads {
  constructor(runtime, concurrency = 2) {
    this.runtime = runtime; this.concurrency = concurrency;
    this.active = 0; this.threads = new Map(); this.pending = new Map();
    this.busy = new Set(); this.after = null;
    this.metrics = { calls: 0, bytes: 0, turns: 0, items: 0, coalesced: 0, peak: 0 };
  }
  page(threadId, cursor = null, limit = 20, itemsView = 'full') {
    return this.enqueue(threadId, { cursor, limit, itemsView });
  }
  items(threadId, turnId, cursor = null, limit = 8, sortDirection = 'desc') {
    return this.enqueue(threadId, { turnId, cursor, limit, sortDirection, kind: 'items' });
  }
  enqueue(threadId, params) {
    const key = JSON.stringify([threadId, params]);
    const existing = this.pending.get(key);
    if (existing) { this.metrics.coalesced++; return existing; }
    // Bound pending read work, without dropping durable user operations.
    if (this.pending.size >= 128) return Promise.reject(new Error('History reads are busy. Retry opening this history shortly.'));
    const promise = new Promise((resolve, reject) => {
      const queue = this.threads.get(threadId) ?? [];
      const job = { ...params, resolve, reject };
      job.timer = setTimeout(() => {
        const queued = this.threads.get(threadId) ?? [];
        const remaining = queued.filter(entry => entry !== job);
        if (remaining.length) this.threads.set(threadId, remaining); else this.threads.delete(threadId);
        reject(new Error('History admission is delayed. Retry opening this history shortly.'));
      }, 15_000);
      queue.push(job); this.threads.set(threadId, queue);
    });
    this.pending.set(key, promise);
    void promise.finally(() => this.pending.delete(key)).catch(() => {});
    this.drain(); return promise;
  }
  drain() {
    while (this.active < this.concurrency) {
      const ids = [...this.threads.keys()].filter(id => !this.busy.has(id)).sort();
      if (!ids.length) return;
      const id = ids.find(id => this.after === null || id > this.after) ?? ids[0];
      const queue = this.threads.get(id), job = queue.shift();
      clearTimeout(job.timer);
      if (!queue.length) this.threads.delete(id);
      this.after = id; this.busy.add(id); this.active++;
      this.metrics.peak = Math.max(this.metrics.peak, this.active);
      void this.read(id, job).then(job.resolve, job.reject).finally(() => {
        this.busy.delete(id); this.active--; this.drain();
      });
    }
  }
  async read(threadId, { kind, turnId, cursor, limit, itemsView, sortDirection }) {
    const page = kind === 'items' ? await this.runtime.rawHistoryItems(threadId, turnId, cursor, limit, sortDirection) : await this.runtime.rawHistoryPage(threadId, cursor, limit, itemsView);
    this.metrics.calls++; this.metrics.bytes += Buffer.byteLength(JSON.stringify(page));
    if (kind === 'items') { this.metrics.items += page.data.length; return page; }
    this.metrics.turns += page.data.length;
    this.metrics.items += page.data.reduce((n, turn) => n + turn.items.length, 0);
    const insert = this.runtime.store.db.prepare(`INSERT INTO native_history_locations VALUES(?,?,?,?)
      ON CONFLICT(thread_id,turn_id) DO UPDATE SET cursor=excluded.cursor,page_limit=excluded.page_limit`);
    this.runtime.store.transaction(() => {
      for (const turn of page.data) insert.run(threadId, turn.id, cursor, limit);
    });
    return page;
  }
  location(threadId, turnId) {
    return this.runtime.store.db.prepare('SELECT cursor,page_limit AS pageLimit FROM native_history_locations WHERE thread_id=? AND turn_id=?').get(threadId, turnId);
  }
  async metadata(threadId, turnId, cursor = null, batches = 4) {
    const hint = cursor === null && this.location(threadId, turnId);
    if (hint) {
      try { const page = await this.page(threadId, hint.cursor, hint.pageLimit, 'summary');
        const turn = page.data.find(t => t.id === turnId); if (turn) return { turn, nextCursor: null }; }
      catch { /* A hint is not native evidence. Bounded discovery follows. */ }
    }
    const seen = new Set();
    for (let n = 0; n < batches; n++) {
      if (seen.has(cursor)) throw Error('Native history pagination made no progress.');
      seen.add(cursor);
      const page = await this.page(threadId, cursor, 3, 'summary');
      const turn = page.data.find(t => t.id === turnId);
      if (turn) return { turn, nextCursor: null };
      cursor = page.nextCursor; if (!cursor) break;
    }
    return { turn: null, nextCursor: cursor };
  }
  async item(threadId, turnId, itemId) {
    // Exact native turn scope, independent of thread depth. Item anchors are
    // exclusive: reverse from the next item to recover the selected item.
    const after = await this.items(threadId, turnId, { type: 'item', itemId }, 1, 'asc');
    const page = after.data.length
      ? await this.items(threadId, turnId, { type: 'item', itemId: after.data[0].item.id }, 1, 'desc')
      : await this.items(threadId, turnId, null, 1, 'desc');
    const entry = page.data.find(e => e.turnId === turnId && e.item.id === itemId);
    if (!entry) throw Error('The native message could not be verified. Reopen its work log and retry.');
    return entry.item;
  }
  async turn(threadId, turnId) {
    let cursor = null, located;
    do { located = await this.metadata(threadId, turnId, cursor); cursor = located.nextCursor; } while (!located.turn && cursor);
    if (!located.turn) return null;
    const items = []; cursor = null; const seen = new Set();
    do {
      if (seen.has(cursor)) throw Error('Native item pagination made no progress.'); seen.add(cursor);
      const page = await this.items(threadId, turnId, cursor, 20, 'asc');
      items.push(...page.data.map(e => e.item)); cursor = page.nextCursor;
    } while (cursor);
    return { ...located.turn, items, itemsView: 'full' };
  }
}
