import { HISTORY_TEXT_LIMIT, historyKey, projectHistoryItem, type HistoryEntry, type HistoryResponse, type HistoryDetail, type HistoryPosition } from "../../lib/bot-history-view";
import type { BotAttachment, BotEvent } from "../../lib/bots-types";
import type { ThreadItem } from "../../lib/codex-protocol/v2/ThreadItem";
import type { Turn } from "../../lib/codex-protocol/v2/Turn";
import { timelineCache, type createTimelineCache, type TimelineMetadata } from "./timeline-cache";

export type TimelineTransport = {
  owner: string; online: boolean;
  rpc<T>(method: "history.view" | "history.detail", botId: string, params?: Record<string, unknown>): Promise<T>;
};
export type TimelineState = {
  entries: HistoryEntry[]; attachments: BotAttachment[]; olderCursor: string | null;
  revision: string; eventCursor: number; complete: boolean; loading: boolean;
  error: string; cached: boolean; position: HistoryPosition;
};
const initial = (): TimelineState => ({ entries: [], attachments: [], olderCursor: null, revision: "", eventCursor: 0,
  complete: false, loading: false, error: "", cached: false, position: { anchor: null, offset: 0, following: true } });
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
  private writeTimer?: ReturnType<typeof setTimeout>;
  private publishTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private detailRequests = new Map<string, Promise<ThreadItem>>();
  constructor(readonly owner: string, readonly botId: string, private transport: TimelineTransport, private cache: Cache = timelineCache) {}
  getSnapshot = () => this.state;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private publish(patch: Partial<TimelineState>, immediate = false) {
    this.state = { ...this.state, ...patch };
    if (immediate) { if (this.publishTimer) clearTimeout(this.publishTimer); this.publishTimer = undefined; this.listeners.forEach((fn) => fn()); }
    else this.publishTimer ??= setTimeout(() => { this.publishTimer = undefined; this.listeners.forEach((fn) => fn()); }, 16);
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
          attachments: m.attachments, complete: m.complete, position: m.position ?? this.state.position, cached: true }, true);
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
          this.merge(response.entries, false, startCursor);
          // Keep loaded older pages; a latest-page refresh never replaces them.
          this.publish({ attachments: mergeAttachments(this.state.attachments, response.attachments),
            olderCursor: this.state.cached || this.state.entries.length > response.entries.length ? this.state.olderCursor ?? response.olderCursor : response.olderCursor,
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
  receive(event: BotEvent) {
    if (this.disposed || event.botId !== this.botId || event.seq <= this.state.eventCursor) return;
    if (event.type === "history.refresh") { void this.refresh(); return; }
    if (event.type === "attachment") { this.publish({ attachments: mergeAttachments(this.state.attachments, [event.data as BotAttachment]), eventCursor: event.seq }); this.scheduleWrite(); return; }
    if (event.type !== "codex") return;
    const { method, params: p } = event.data as { method: string; params: { turnId?: string; itemId?: string; item?: ThreadItem; turn?: Turn; delta?: string } };
    const turnId = p.turnId ?? p.turn?.id;
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
    } else if (p.turn && method === "turn/completed") {
      for (const item of p.turn.items) update(projectHistoryItem(p.turn, item, p.turn.items.some((i) => i.type === "userMessage" && Boolean(i.clientId?.startsWith("schedule:")))));
    } else if (p.itemId && /(?:\/delta|Delta)$/.test(method)) {
      const entry = this.state.entries.find((e) => e.turnId === turnId && e.id === p.itemId);
      if (entry?.item && (entry.item.type === "agentMessage" || entry.item.type === "plan")) {
        const text = entry.item.text + (p.delta ?? "");
        update({ ...entry, item: { ...entry.item, text: text.slice(0, HISTORY_TEXT_LIMIT) }, complete: entry.complete && text.length <= HISTORY_TEXT_LIMIT });
      }
      // Closed tool output stays deferred; authoritative detail is fetched on demand.
    }
    this.publish({ eventCursor: event.seq }); this.scheduleWrite();
    if (method === "turn/completed" || method === "item/completed") void this.flush();
  }
  position(position: HistoryPosition) { this.state = { ...this.state, position }; this.scheduleWrite(); }
  private scheduleWrite() { if (!this.disposed) this.writeTimer ??= setTimeout(() => { this.writeTimer = undefined; void this.flush(); }, 250); }
  async flush(): Promise<void> {
    if (this.writeTimer) clearTimeout(this.writeTimer); this.writeTimer = undefined;
    if (this.write) { await this.write; if (this.dirty.size) return this.flush(); return; }
    if (!this.state.cached && !this.state.entries.length) return;
    const dirty = [...this.dirty.values()]; this.dirty.clear();
    const metadata: TimelineMetadata = { owner: this.owner, botId: this.botId, order: this.state.entries.map((e) => historyKey(e.turnId, e.id)),
      revision: this.state.revision, eventCursor: this.state.eventCursor, olderCursor: this.state.olderCursor,
      attachments: this.state.attachments, complete: this.state.complete, position: this.state.position, touched: Date.now() };
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
      if (!this.transport.online || this.transport.owner !== this.owner) throw new Error("Full detail is not cached. Reconnect to load it from the native thread.");
      let offset = 0, json = "", version: string | undefined;
      do {
        const part = await this.transport.rpc<HistoryDetail>("history.detail", this.botId, { turnId: entry.turnId, itemId: entry.id, offset, version });
        if (this.transport.owner !== this.owner || this.disposed) throw new Error("Conversation owner changed.");
        if (version && version !== part.version) throw new Error("The item changed. Open its details again.");
        json += part.json; version = part.version;
        if (part.nextOffset === null) break;
        if (part.nextOffset <= offset || json.length > 64 * 1024 * 1024) throw new Error("Detail is too large to display here. Open the native thread.");
        offset = part.nextOffset;
      } while (true);
      return JSON.parse(json) as ThreadItem;
    })().finally(() => this.detailRequests.delete(key));
    this.detailRequests.set(key, promise); return promise;
  }
  async dispose() { await this.flush(); this.disposed = true; if (this.publishTimer) clearTimeout(this.publishTimer); this.listeners.clear(); }
}
function mergeAttachments(old: BotAttachment[], incoming: BotAttachment[]) {
  if (!incoming.length) return old;
  const map = new Map(old.map((a) => [a.id, a])); for (const item of incoming) map.set(item.id, item);
  return [...map.values()];
}
