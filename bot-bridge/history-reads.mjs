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
    const key = JSON.stringify([threadId, cursor, limit, itemsView]);
    const existing = this.pending.get(key);
    if (existing) { this.metrics.coalesced++; return existing; }
    // Bound pending read work, without dropping durable user operations.
    if (this.pending.size >= 128) return Promise.reject(new Error('History reads are busy. Retry opening this history shortly.'));
    const promise = new Promise((resolve, reject) => {
      const queue = this.threads.get(threadId) ?? [];
      const job = { cursor, limit, itemsView, resolve, reject };
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
  async read(threadId, { cursor, limit, itemsView }) {
    const page = await this.runtime.rawHistoryPage(threadId, cursor, limit, itemsView);
    this.metrics.calls++; this.metrics.bytes += Buffer.byteLength(JSON.stringify(page));
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
  async turn(threadId, turnId) {
    const hint = this.location(threadId, turnId);
    if (hint) {
      // Cursors may become stale after compaction or native upgrades. Verify
      // exact identity, then fall back to native discovery; hints prove nothing.
      try {
        const page = await this.page(threadId, hint.cursor, hint.pageLimit);
        const turn = page.data.find(turn => turn.id === turnId);
        if (turn) return turn;
      } catch { /* The normal read below supplies the actual error if unavailable. */ }
    }
    let cursor = null; const seen = new Set();
    do {
      if (seen.has(cursor)) throw new Error('Native history pagination made no progress.');
      seen.add(cursor);
      // Metadata scans do not transfer/parse old command outputs. Full detail
      // is fetched only for the page that positively contains the target.
      const page = await this.page(threadId, cursor, 20, 'notLoaded');
      if (page.data.some(turn => turn.id === turnId)) {
        const full = await this.page(threadId, cursor, 20);
        const turn = full.data.find(turn => turn.id === turnId);
        if (turn) return turn;
        // A moving native page is not positive absence. Start a fresh scan.
        throw new Error('History changed while locating this turn. Retry opening it.');
      }
      cursor = page.nextCursor;
    } while (cursor);
    return null;
  }
}
