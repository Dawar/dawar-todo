import { HISTORY_TEXT_LIMIT, historyTail, historyBefore, historyKey, projectHistoryItem, type HistoryEntry, type HistoryResponse, type HistoryDetail, type HistoryPosition, type HistoryGap } from "../../lib/bot-history-view";
import type { BotAttachment, BotEvent } from "../../lib/bots-types";
import type { ThreadItem } from "../../lib/codex-protocol/v2/ThreadItem";
import type { Turn } from "../../lib/codex-protocol/v2/Turn";
import { readOpenedDetail, saveOpenedDetail } from "./timeline-detail-cache";
import { reduceBotTurns, type NativeEvent } from "./thread-state";
import { timelineCache, type createTimelineCache, type TimelineMetadata } from "./timeline-cache";

export type TimelineTransport = {
  owner: string; online: boolean;
  rpc<T>(method: "history.view" | "history.detail", botId: string, params?: Record<string, unknown>): Promise<T>;
};
export type TimelineState = {
  entries: HistoryEntry[]; contextEntries: HistoryEntry[]; attachments: BotAttachment[]; olderCursor: string | null;
  revision: string; eventCursor: number; complete: boolean; loading: boolean;
  error: string; cached: boolean; gaps: HistoryGap[]; position: HistoryPosition;
};
const initial = (): TimelineState => ({ entries: [], contextEntries: [], attachments: [], olderCursor: null, revision: "", eventCursor: 0,
  complete: false, loading: false, gaps: [], error: "", cached: false, position: { anchor: null, offset: 0, following: true } });
type Cache = ReturnType<typeof createTimelineCache>;

/** One owner/thread store and one refresh in flight, independent of React selection. */
export class BotTimeline {
  private state = initial();
  private listeners = new Set<() => void>();
  private dirty = new Map<string, HistoryEntry>();
  private hydration?: Promise<void>;
  private request?: Promise<void>;
  private olderRequest?: Promise<void>;
  private write?: Promise<void>;
  private writeVersion = 0;
  private writeTimer?: ReturnType<typeof setTimeout>;
  private publishTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private metadataVersion = 0;
  private detailItems = new Map<string, ThreadItem>();
  private detailListeners = new Map<string, Set<() => void>>();
  private detailEvents = new Map<string, BotEvent[]>();
  detailItem = (entry: HistoryEntry) => this.detailItems.get(historyKey(entry.turnId, entry.id)) ?? null;
  subscribeDetail(entry: Pick<HistoryEntry, "turnId" | "id">, listener: () => void) {
    const key = historyKey(entry.turnId, entry.id), listeners = this.detailListeners.get(key) ?? new Set();
    listeners.add(listener); this.detailListeners.set(key, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) { this.detailListeners.delete(key); this.detailItems.delete(key); } };
  }
  private detailRequests = new Map<string, Promise<ThreadItem>>();
  constructor(readonly owner: string, readonly botId: string, private transport: TimelineTransport, private cache: Cache = timelineCache) {}
  getSnapshot = () => this.state;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private publish(patch: Partial<TimelineState>, immediate = false) {
    this.state = { ...this.state, ...patch };
    if (immediate) { if (this.publishTimer) clearTimeout(this.publishTimer); this.publishTimer = undefined; this.listeners.forEach((fn) => fn()); for (const listeners of this.detailListeners.values()) listeners.forEach((fn) => fn()); }
    else this.publishTimer ??= setTimeout(() => { this.publishTimer = undefined; this.listeners.forEach((fn) => fn()); for (const listeners of this.detailListeners.values()) listeners.forEach((fn) => fn()); }, 16);
  }
  private merge(entries: HistoryEntry[], prepend = false, preserveAfter = Infinity) {
    const existing = new Map(this.state.entries.map((e) => [historyKey(e.turnId, e.id), e]));
    const fresh = new Map(entries.map((e) => [historyKey(e.turnId, e.id), e]));
    const merged = this.state.entries.map((old) => {
      const key = historyKey(old.turnId, old.id), next = fresh.get(key);
      if (!next || (old.updatedSeq ?? 0) > preserveAfter) return old;
      this.dirty.set(key, next); return next;
    });
    const added = entries.filter((e) => !existing.has(historyKey(e.turnId, e.id)));
    for (const e of added) this.dirty.set(historyKey(e.turnId, e.id), e);
    this.state = { ...this.state, entries: prepend ? [...added, ...merged] : [...merged, ...added] };
  }
  seed(turns: Turn[], attachments: BotAttachment[]) {
    if (this.state.cached || this.state.entries.length || !turns.length || this.disposed) return;
    const entries = historyTail(turns, turns.reduce((n, turn) => n + turn.items.length, 0));
    this.merge(entries);
    this.publish({ cached: true, attachments, olderCursor: entries.length ? historyBefore(entries[0]) : null }, true);
    this.scheduleWrite();
  }
  async hydrate() {
    this.hydration ??= (async () => {
      try {
        const cached = await this.cache.read(this.owner, this.botId);
        if (!cached || this.disposed) return;
        const live = this.state.eventCursor;
        const liveDirty = new Map(this.dirty);
        this.merge(cached.entries, true, -1); this.dirty = liveDirty;
        const m = cached.metadata;
        this.publish({ revision: m.revision, eventCursor: Math.max(live, m.eventCursor), olderCursor: m.olderCursor,
          attachments: m.attachments, contextEntries: m.contextEntries ?? [], gaps: m.gaps ?? [], complete: m.complete, position: m.position ?? this.state.position, cached: true }, true);
      } catch (e) { this.publish({ error: `Offline history cache unavailable: ${String(e)}` }, true); }
    })();
    return this.hydration;
  }
  async refresh() {
    await this.hydrate();
    if (!this.transport.online || this.transport.owner !== this.owner || this.disposed) return;
    if (this.request) return this.request;
    const startCursor = this.state.eventCursor;
    this.publish({ loading: true, error: "" }, true);
    this.request = (async () => {
      try {
        const response = await this.transport.rpc<HistoryResponse>("history.view", this.botId, { revision: this.state.revision || undefined, after: this.state.eventCursor });
        if (this.disposed || this.transport.owner !== this.owner) return;
        if (response.kind === "events") for (const event of response.events) this.receive(event);
        if (response.kind === "page") {
          const empty = this.state.entries.length === 0;
          const known = new Set(this.state.entries.map((entry) => historyKey(entry.turnId, entry.id)));
          const overlaps = response.entries.some((entry) => known.has(historyKey(entry.turnId, entry.id)));
          const oldLast = this.state.entries.at(-1), newFirst = response.entries[0];
          if (oldLast && newFirst && !overlaps && response.olderCursor) {
            const gap = { before: historyKey(newFirst.turnId, newFirst.id), stop: historyKey(oldLast.turnId, oldLast.id), cursor: historyBefore(newFirst) };
            this.state = { ...this.state, gaps: [...this.state.gaps, gap] };
          }
          this.merge(response.entries, false, startCursor);
          // Keep loaded older pages; a latest-page refresh never replaces them.
          this.publish({ attachments: mergeAttachments(this.state.attachments, response.attachments), contextEntries: response.contextEntries ?? [],
            olderCursor: this.state.cached ? this.state.olderCursor : response.olderCursor,
            complete: empty ? response.complete : response.complete && this.state.complete, cached: true });
        }
        this.publish({ revision: response.revision, eventCursor: Math.max(this.state.eventCursor, response.eventCursor) });
        this.scheduleWrite();
      } catch (e) { this.publish({ error: e instanceof Error ? e.message : String(e) }); }
      finally { this.request = undefined; if (!this.disposed) this.publish({ loading: false }, true); }
    })();
    return this.request;
  }
  async older() {
    if (this.olderRequest) return this.olderRequest;
    const cursor = this.state.olderCursor;
    if (!cursor || !this.transport.online || this.transport.owner !== this.owner) return;
    this.olderRequest = (async () => {
      try {
        const page = await this.transport.rpc<HistoryResponse>("history.view", this.botId, { cursor });
        if (this.disposed || this.transport.owner !== this.owner || page.kind !== "page") return;
        this.merge(page.entries, true, -1);
        this.publish({ olderCursor: page.olderCursor, attachments: mergeAttachments(this.state.attachments, page.attachments), complete: page.complete }, true);
        this.scheduleWrite();
      } catch (e) { this.publish({ error: String(e) }, true); }
      finally { this.olderRequest = undefined; }
    })();
    return this.olderRequest;
  }
  async fillGap(gap: HistoryGap) {
    if (!this.transport.online || this.transport.owner !== this.owner || this.disposed) return;
    try {
      const page = await this.transport.rpc<HistoryResponse>("history.view", this.botId, { cursor: gap.cursor });
      if (this.disposed || this.transport.owner !== this.owner || page.kind !== "page") return;
      const boundary = this.state.entries.findIndex((entry) => historyKey(entry.turnId, entry.id) === gap.before);
      if (boundary < 0 || !this.state.gaps.includes(gap)) return;
      const olderKeys = new Set(this.state.entries.slice(0, boundary).map((entry) => historyKey(entry.turnId, entry.id)));
      const connected = page.entries.some((entry) => olderKeys.has(historyKey(entry.turnId, entry.id)));
      const allKeys = new Set(this.state.entries.map((entry) => historyKey(entry.turnId, entry.id)));
      const added = page.entries.filter((entry) => !allKeys.has(historyKey(entry.turnId, entry.id)));
      for (const entry of added) this.dirty.set(historyKey(entry.turnId, entry.id), entry);
      const entries = [...this.state.entries.slice(0, boundary), ...added, ...this.state.entries.slice(boundary)];
      const gaps = this.state.gaps.flatMap((value) => value !== gap ? [value] : connected || !page.olderCursor ? [] : [{ ...gap,
        before: added.length ? historyKey(added[0].turnId, added[0].id) : gap.before, cursor: page.olderCursor }]);
      this.publish({ entries, gaps, attachments: mergeAttachments(this.state.attachments, page.attachments) }, true); this.scheduleWrite();
    } catch (e) { this.publish({ error: String(e) }, true); }
  }
  receive(event: BotEvent) {
    if (this.disposed || event.botId !== this.botId || event.seq <= this.state.eventCursor) return;
    if (event.type === "history.refresh") { this.state = { ...this.state, revision: "" }; void this.refresh(); return; }
    if (event.type === "attachment") { this.publish({ attachments: mergeAttachments(this.state.attachments, [event.data as BotAttachment]), eventCursor: event.seq }); this.scheduleWrite(); return; }
    if (event.type !== "codex") return;
    const { method, params: p } = event.data as { method: string; params: { turnId?: string; itemId?: string; item?: ThreadItem; turn?: Turn; delta?: string } };
    const turnId = p.turnId ?? p.turn?.id;
    for (const [key, events] of this.detailEvents) if (key.startsWith(`${turnId}:`)) events.push(event);
    for (const [key, item] of this.detailItems) {
      if (!key.startsWith(`${turnId}:`)) continue;
      const reduced = reduceBotTurns([{ id: turnId!, items: [item], itemsView: "full", status: "inProgress", startedAt: null, completedAt: null, durationMs: null, error: null }], event.data as NativeEvent);
      const next = reduced[0]?.items.find((value) => value.id === item.id);
      if (next && next !== item) { this.detailItems.set(key, next); }
    }
    if (!turnId) { this.publish({ eventCursor: event.seq }); return; }
    const update = (entry: HistoryEntry) => {
      const next = { ...entry, updatedSeq: event.seq }, key = historyKey(entry.turnId, entry.id);
      const index = this.state.entries.findIndex((e) => historyKey(e.turnId, e.id) === key);
      const entries = [...this.state.entries]; if (index < 0) entries.push(next); else entries[index] = next;
      this.state = { ...this.state, entries }; this.dirty.set(key, next);
    };
    if (p.item && /item\/(started|completed)$/.test(method)) {
      const prior = this.state.entries.find((e) => e.turnId === turnId);
      update(projectHistoryItem({ id: turnId, startedAt: prior?.startedAt ?? Date.now() / 1000, status: prior?.status ?? "inProgress" }, p.item,
        prior?.scheduled || p.item.type === "userMessage" && Boolean(p.item.clientId?.startsWith("schedule:"))));
    } else if (p.turn && (method === "turn/completed" || method === "turn/started")) {
      for (const entry of this.state.entries) if (entry.turnId === turnId && entry.status !== p.turn.status) update({ ...entry, status: p.turn.status });
      for (const item of p.turn.items) update(projectHistoryItem(p.turn, item, p.turn.items.some((i) => i.type === "userMessage" && Boolean(i.clientId?.startsWith("schedule:")))));
    } else if (p.itemId && /(?:\/delta|Delta)$/.test(method)) {
      const entry = this.state.entries.find((e) => e.turnId === turnId && e.id === p.itemId);
      if (entry?.item && (entry.item.type === "agentMessage" || entry.item.type === "plan")) {
        const text = entry.item.text + (p.delta ?? "");
        update({ ...entry, item: { ...entry.item, text: text.slice(0, HISTORY_TEXT_LIMIT) }, complete: entry.complete && text.length <= HISTORY_TEXT_LIMIT });
      }
      if (!entry && method === "item/agentMessage/delta") {
        update(projectHistoryItem({ id: turnId, startedAt: Date.now() / 1000, status: "inProgress" }, { type: "agentMessage", id: p.itemId, text: p.delta ?? "", phase: null, memoryCitation: null, delivery: null, questions: null }));
        // Reconcile an event whose item/started fell outside the replay window.
        this.state = { ...this.state, revision: "" }; void this.refresh();
      }
      // Closed tool output stays deferred; authoritative detail is fetched on demand.
    }
    this.publish({ eventCursor: event.seq }); this.scheduleWrite();
    if (method === "turn/completed" || method === "item/completed") void this.flush();
  }
  position(position: HistoryPosition) { this.state = { ...this.state, position }; this.scheduleWrite(); }
  private scheduleWrite() { this.metadataVersion++; if (!this.disposed) this.writeTimer ??= setTimeout(() => { this.writeTimer = undefined; void this.flush(); }, 250); }
  async flush(): Promise<void> {
    if (this.writeTimer) clearTimeout(this.writeTimer); this.writeTimer = undefined;
    if (this.write) { const version = this.writeVersion; await this.write; if (version < this.metadataVersion) return this.flush(); return; }
    if (!this.state.cached && !this.state.entries.length) return;
    const dirty = [...this.dirty.values()]; this.dirty.clear();
    const tail = this.state.entries.slice(-240);
    const metadata: TimelineMetadata = { owner: this.owner, botId: this.botId, order: tail.map((e) => historyKey(e.turnId, e.id)),
      revision: this.state.revision, eventCursor: this.state.eventCursor, olderCursor: tail.length < this.state.entries.length ? historyBefore(tail[0]) : this.state.olderCursor,
      attachments: this.state.attachments, contextEntries: this.state.contextEntries, gaps: this.state.gaps.filter((gap) => tail.some((entry) => historyKey(entry.turnId, entry.id) === gap.before)), complete: tail.length === this.state.entries.length && this.state.complete, position: this.state.position, touched: Date.now() };
    this.writeVersion = this.metadataVersion;
    this.write = this.cache.write(metadata, dirty).catch((error) => {
      for (const e of dirty) if (!this.dirty.has(historyKey(e.turnId, e.id))) this.dirty.set(historyKey(e.turnId, e.id), e);
      this.publish({ error: `History is visible but its offline cache could not be updated: ${String(error)}` }, true);
    }).finally(() => { this.write = undefined; });
    return this.write;
  }
  detail(entry: HistoryEntry): Promise<ThreadItem> {
    const key = historyKey(entry.turnId, entry.id);
    if (entry.complete && entry.item) return Promise.resolve(entry.item);
    const prior = this.detailRequests.get(key); if (prior) return prior;
    const promise = (async () => {
      this.detailEvents.set(key, []);
      if (this.transport.owner !== this.owner || this.disposed) throw new Error("Conversation owner changed.");
      const cached = await readOpenedDetail(this.owner, this.botId, key).catch(() => null);
      if (this.transport.owner !== this.owner || this.disposed) throw new Error("Conversation owner changed.");
      if (cached) { this.detailItems.set(key, cached.item); this.detailListeners.get(key)?.forEach((listener) => listener()); }
      if (!this.transport.online) {
        if (!cached) throw new Error("Full detail is not cached. Reconnect to load it from the native thread.");
        if (this.transport.owner !== this.owner || this.disposed) throw new Error("Conversation owner changed.");
        this.detailItems.set(key, cached.item); this.publish({ attachments: mergeAttachments(this.state.attachments, cached.attachments) });
        this.detailListeners.get(key)?.forEach((listener) => listener()); return cached.item;
      }
      let offset = 0, json = "", version: string | undefined, cursor = this.state.eventCursor;
      do {
        const part = await this.transport.rpc<HistoryDetail>("history.detail", this.botId, { turnId: entry.turnId, itemId: entry.id, offset, version, ...(offset === 0 && cached?.version ? { knownVersion: cached.version } : {}) });
        if (this.transport.owner !== this.owner || this.disposed) throw new Error("Conversation owner changed.");
        if (part.notModified && cached) { this.publish({ attachments: mergeAttachments(this.state.attachments, cached.attachments) }); return cached.item; }
        if (version && version !== part.version) throw new Error("The item changed. Open its details again.");
        json += part.json; version = part.version; cursor = part.eventCursor ?? cursor;
        if (part.attachments?.length) this.publish({ attachments: mergeAttachments(this.state.attachments, part.attachments) });
        if (part.nextOffset === null) break;
        if (part.nextOffset <= offset) throw new Error("Invalid detail continuation.");
        offset = part.nextOffset;
      } while (true);
      let item = JSON.parse(json) as ThreadItem;
      // The server detail version is authoritative. A completed/started native
      // item received during the read supersedes it; deltas reconcile on refresh.
      for (const event of this.detailEvents.get(key) ?? []) {
        const native = event.data as NativeEvent;
        if (event.seq <= cursor) continue;
        const reduced = reduceBotTurns([{ id: entry.turnId, items: [item], itemsView: "full", status: entry.status, startedAt: entry.startedAt, completedAt: null, durationMs: null, error: null }], native);
        item = reduced[0]?.items.find((value) => value.id === entry.id) ?? item;
      }
      this.detailItems.set(key, item);
      if (entry.status !== "inProgress") void saveOpenedDetail(this.owner, this.botId, key, item, this.state.attachments, version!).catch(() => {});
      this.detailListeners.get(key)?.forEach((listener) => listener());
      return item;
    })().finally(() => { this.detailRequests.delete(key); this.detailEvents.delete(key); });
    this.detailRequests.set(key, promise); return promise;
  }
  async dispose() { this.disposed = true; await this.flush(); if (this.publishTimer) clearTimeout(this.publishTimer); this.listeners.clear(); }
}
function mergeAttachments(old: BotAttachment[], incoming: BotAttachment[]) {
  if (!incoming.length) return old;
  const map = new Map(old.map((a) => [a.id, a])); for (const item of incoming) map.set(item.id, item);
  return [...map.values()];
}
