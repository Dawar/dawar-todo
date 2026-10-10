import type { BotAttachment, BotEvent, BotRunContext } from "../../lib/bots-types";
import type { HistoryDetail, HistoryEntry, HistoryPage, HistoryResponse } from "../../lib/bot-history-view";
import type { ThreadItem } from "../../lib/codex-protocol/v2/ThreadItem";
import { reduceBotTurns, type NativeEvent } from "./thread-state";
import { botsClient as client } from "./client";
import { readOpenedDetail, saveOpenedDetail, updateOpenedDetailAttachments, invalidateOpenedRunDetails } from "./timeline-detail-cache";
import { runHistoryRefresh, refreshMatches } from "./run-history-refresh";

const mergeFiles = (old: BotAttachment[], incoming: BotAttachment[]) => [...new Map([...old, ...incoming].map(file => [file.id, file])).values()].slice(-128);
const itemKey = (entry: Pick<HistoryEntry, "turnId" | "id">) => JSON.stringify([entry.turnId, entry.id]);
/** Selected-run reader. No subscriptions, timers, native bodies or fetches for unopened runs. */
class ChangedRunDetail extends Error {}
export class RunHistoryReader {
  attachments: BotAttachment[] = [];
  private items = new Map<string, ThreadItem>();
  private entries = new Map<string, HistoryEntry>();
  private requests = new Map<string, Promise<ThreadItem>>();
  private readers = new Map<string, number>();
  private errors = new Map<string, string>();
  private invalidated = new Map<string, number>();
  private retries = new Map<string, number>();
  private listeners = new Set<() => void>();
  private version = 0;
  private dead = false;
  private lifecycle = 0;
  private events: BotEvent[] = [];
  private replayOverflow = false;
  private cursors = new Map<string, number>();
  private refreshCursor = -1;
  private cacheWork: Promise<void> | null = null;
  private cacheChanges = new Map<string, { turnId: string; itemId: string }>();
  private pageRevision = "";
  private queued = new Set<string>();
  private automatic = new Set<string>();
  private reading = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private frame = 0;
  constructor(readonly owner: string, readonly botId: string, readonly context: BotRunContext) {}
  activate() { this.dead = false; }
  snapshot = () => this.version;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  subscribeDetail = (entry: Pick<HistoryEntry, "turnId" | "id">, fn: () => void) => {
    const key = itemKey(entry); this.readers.set(key, (this.readers.get(key) ?? 0) + 1);
    const unsubscribe = this.subscribe(fn);
    return () => { unsubscribe(); const remaining = (this.readers.get(key) ?? 1) - 1; if (remaining) this.readers.set(key, remaining); else { this.readers.delete(key); this.automatic.delete(key); } };
  };
  private notify() { this.version++; for (const fn of this.listeners) fn(); }
  private valid() { if (this.dead || client.owner !== this.owner) throw Error("This run's owner changed. Reopen Activity."); }
  private scoped(value: { context?: HistoryPage["context"] }) {
    this.valid();
    if (!value.context || value.context.runId !== this.context.runId || value.context.laneId !== this.context.laneId || value.context.threadId !== this.context.threadId) throw Error("The response belongs to a different run. Reopen Activity.");
  }
  receive = (event: BotEvent) => {
    if (this.dead || !this.matches(event)) return;
    const refresh = runHistoryRefresh(event);
    if (refresh) {
      if (event.seq <= this.refreshCursor) return;
      this.refreshCursor = event.seq;
      // Only explicitly opened/in-flight bodies are invalidated. Entries retain
      // a closed disclosure's identity; unopened tools never enter this reader.
      for (const [key, entry] of this.entries) {
        if (!refreshMatches(refresh, entry) || event.seq <= (this.cursors.get(key) ?? -1)) continue;
        this.invalidateCache(entry.turnId, entry.id);
        if (refresh.entry?.turnId === entry.turnId && refresh.entry.id === entry.id) this.entries.set(key, refresh.entry);
        else if (refresh.turn) this.entries.set(key, { ...entry, status: refresh.turn.status, turnStatus: refresh.turn.status });
        this.invalidated.set(key, event.seq); this.items.delete(key);
        this.errors.set(key, "This detail changed. Refresh details to read the latest version.");
        if (this.readers.has(key) && !this.requests.has(key)) this.automatic.add(key);
      }
      this.schedule(); this.notify(); return;
    }
    if (event.type !== "run.codex") return;
    const native = (event.data as { message: NativeEvent }).message;
    if (!native?.params || native.params.threadId && native.params.threadId !== this.context.threadId) return;
    if (this.requests.size && !this.replayOverflow) {
      this.events.push(event);
      if (this.events.length > 64 || new TextEncoder().encode(JSON.stringify(this.events)).length > 256 * 1024) { this.events = []; this.replayOverflow = true; }
    }
    for (const [key, item] of this.items) {
      if (event.seq <= (this.cursors.get(key) ?? -1)) continue;
      const [turnId, itemId] = JSON.parse(key) as string[];
      if ((native.params.turnId ?? native.params.turn?.id) !== turnId) continue;
      const value = this.reduce(item, turnId, native);
      if (value?.id === itemId) this.items.set(key, value);
      this.cursors.set(key, event.seq);
    }
    this.frame ||= requestAnimationFrame(() => { this.frame = 0; this.notify(); });
  };
  private reduce(item: ThreadItem, turnId: string, native: NativeEvent) {
    const turns = reduceBotTurns([{ id: turnId, items: [item], itemsView: "full", status: "inProgress", startedAt: null, completedAt: null, durationMs: null, error: null }], native);
    const value = turns.find(turn => turn.id === turnId)?.items.find(value => value.id === item.id) ?? item;
    return value.type === "reasoning" ? { ...value, content: [] } : value;
  }
  detailItem = (entry: HistoryEntry) => this.items.get(itemKey(entry)) ?? null;
  detailError = (entry: HistoryEntry) => this.errors.get(itemKey(entry)) ?? "";
  detailPending = (entry: HistoryEntry) => this.requests.has(itemKey(entry)) || this.automatic.has(itemKey(entry));
  private invalidateCache(turnId: string, itemId: string) {
    this.cacheChanges.set(JSON.stringify([turnId, itemId]), { turnId, itemId });
    if (!this.cacheWork) void this.drainCache().catch(() => {});
  }
  private drainCache(): Promise<void> {
    if (this.cacheWork) return this.cacheWork;
    let complete = false;
    const work = (async () => {
      while (this.cacheChanges.size) {
        const [key, change] = this.cacheChanges.entries().next().value!;
        await invalidateOpenedRunDetails(this.owner, this.botId, this.context, change.turnId, change.itemId);
        if (this.cacheChanges.get(key) === change) this.cacheChanges.delete(key);
      }
      complete = true;
    })();
    this.cacheWork = work.finally(() => { this.cacheWork = null; if (complete && this.cacheChanges.size) void this.drainCache().catch(() => {}); }); return this.cacheWork;
  }
  /** An explicit page refresh also reconciles previously opened full bodies. */
  reconcilePage(page: HistoryPage) {
    const changed = this.pageRevision && this.pageRevision !== page.revision;
    this.pageRevision = page.revision;
    if (!changed) return;
    for (const entry of page.entries) {
      const key = itemKey(entry);
      if (!this.entries.has(key) || page.eventCursor <= (this.cursors.get(key) ?? -1)) continue;
      this.entries.set(key, entry); this.invalidated.set(key, page.eventCursor); this.items.delete(key);
      this.errors.set(key, "This detail changed. Refresh details to read the latest version.");
      this.invalidateCache(entry.turnId, entry.id);
      if (this.readers.has(key) && !this.requests.has(key)) this.automatic.add(key);
    }
    this.schedule(); this.notify();
  }
  private schedule() {
    if (!this.automatic.size || this.timer || this.dead || !client.online || client.owner !== this.owner) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      for (const key of this.automatic) {
        this.automatic.delete(key);
        if (!this.readers.has(key) || this.requests.has(key) || !this.entries.has(key) || !client.online || this.dead || client.owner !== this.owner) continue;
        if ((this.retries.get(key) ?? 0) >= 2) continue;
        this.retries.set(key, (this.retries.get(key) ?? 0) + 1);
        void this.load(this.entries.get(key)!, true).catch(() => {});
      }
      this.notify();
    }, 300);
  }
  async detail(entry: HistoryEntry): Promise<ThreadItem> { this.retries.set(itemKey(entry), 0); return this.load(entry, false); }
  private load(entry: HistoryEntry, automatic: boolean): Promise<ThreadItem> {
    const key = itemKey(entry), pending = this.requests.get(key); if (pending) return pending;
    this.valid();
    // At most 24 retained cache keys plus the eight admitted body identities.
    // Storage backpressure never broadens invalidation to unrelated run parts.
    if (!this.entries.has(key) && this.cacheChanges.size >= 24) { this.errors.set(key, "Saved detail is still updating. Retry after storage is available."); this.notify(); return Promise.reject(Error(this.errors.get(key))); }
    if (!this.entries.has(key) && this.entries.size >= 8) {
      const old = [...this.entries.keys()].find(value => !this.requests.has(value) && !this.readers.has(value));
      if (!old) { this.errors.set(key, "Close an open work detail before opening another."); this.notify(); return Promise.reject(Error(this.errors.get(key))); }
      for (const map of [this.entries, this.items, this.cursors, this.errors, this.invalidated, this.retries]) map.delete(old);
    }
    this.entries.set(key, entry); this.errors.delete(key);
    if (entry.updatedSeq && entry.updatedSeq > (this.invalidated.get(key) ?? -1) && entry.updatedSeq > (this.cursors.get(key) ?? -1)) {
      this.invalidated.set(key, entry.updatedSeq); this.invalidateCache(entry.turnId, entry.id);
    }
    const lifecycle = this.lifecycle;
    if (!this.requests.size) { this.events = []; this.replayOverflow = false; }
    // At most eight admitted bodies and two active native detail reads. Reads
    // already on the wire are fenced on close/navigation, never retargeted.
    let start!: () => void;
    const slot = new Promise<void>(resolve => { start = resolve; });
    this.starts.set(key, start); this.queued.add(key);
    const promise = slot.then(async () => {
      this.valid();
      if (lifecycle !== this.lifecycle) throw Error("Reopen this detail after returning to Activity.");
      if (automatic && !this.readers.has(key)) throw Error("This detail is closed. Reopen it to refresh.");
      return this.read(entry, key);
    }).catch(error => {
      if (!this.dead && client.owner === this.owner) {
        this.errors.set(key, error instanceof Error ? error.message : "This detail could not be refreshed.");
        if (error instanceof ChangedRunDetail && this.readers.has(key) && (this.retries.get(key) ?? 0) < 2) this.automatic.add(key);
      }
      throw error;
    }).finally(() => {
      this.reading--; this.requests.delete(key);
      if (!this.requests.size) { this.events = []; this.replayOverflow = false; }
      this.pump(); this.schedule(); this.notify();
    });
    this.requests.set(key, promise); this.pump(); this.notify(); return promise;
  }
  private starts = new Map<string, () => void>();
  private pump() {
    while (this.reading < 2 && this.queued.size) {
      const key = this.queued.values().next().value!; this.queued.delete(key);
      this.reading++; this.starts.get(key)!(); this.starts.delete(key);
    }
  }
  private async read(entry: HistoryEntry, key: string) {
    this.valid();
    const generation = this.lifecycle, required = this.invalidated.get(key) ?? -1;
    const current = () => !this.dead && client.owner === this.owner && this.lifecycle === generation && (this.invalidated.get(key) ?? -1) === required;
    const check = () => { this.valid(); if (!this.readers.has(key)) throw Error("This detail is closed. Reopen it to refresh."); if (!current()) throw new ChangedRunDetail("This detail changed while loading. Refresh it for the latest version."); };
    await this.drainCache(); check();
    const cacheKey = JSON.stringify([this.context, key]);
    const cached = required < 0 || (this.cursors.get(key) ?? -1) >= required ? await readOpenedDetail(this.owner, this.botId, cacheKey, "run").catch(() => null) : null;
    check();
    if (cached) { this.items.set(key, cached.item); this.attachments = mergeFiles(this.attachments, cached.attachments); this.notify(); }
    if (!client.online) {
      if (!cached) throw Error("This detail isn't saved in its current version. Connect to open it.");
      return cached.item;
    }
    let offset = 0, json = "", version: string | undefined, cursor = 0;
    do {
      const part = await client.rpc<HistoryDetail>("history.detail", this.botId, { runId: this.context.runId, turnId: entry.turnId, itemId: entry.id, offset, version, ...(offset === 0 && cached ? { knownVersion: cached.version } : {}) }, undefined, { owner: this.owner });
      this.scoped(part); check();
      if (this.replayOverflow) throw new ChangedRunDetail("This run changed too much while loading. Refresh this detail.");
      cursor = part.eventCursor ?? cursor;
      if (cursor < required) throw new ChangedRunDetail("The new detail is not available yet. Refresh this item again.");
      this.attachments = mergeFiles(this.attachments, part.attachments ?? []);
      if (part.notModified && cached) {
        await updateOpenedDetailAttachments(this.owner, this.botId, cacheKey, this.attachments, cached.version, "run", current).catch(() => {}); check();
        this.cursors.set(key, Math.max(cursor, ...this.events.map(event => event.seq)));
        let item = cached.item;
        for (const event of this.events) if (event.seq > cursor) item = this.reduce(item, entry.turnId, (event.data as { message: NativeEvent }).message);
        this.items.set(key, item); this.errors.delete(key); return item;
      }
      if (version && part.version !== version) throw new ChangedRunDetail("This item changed. Refresh it for the latest detail.");
      version = part.version; json += part.json;
      if (part.nextOffset === null) break;
      if (part.nextOffset <= offset || part.nextOffset !== json.length) throw Error("Run detail did not advance. Reopen this item.");
      offset = part.nextOffset;
    } while (true);
    check();
    let item = JSON.parse(json) as ThreadItem;
    if (item.id !== entry.id) throw Error("The item identity changed. Reopen this run.");
    if (item.type === "reasoning") item = { ...item, content: [] };
    for (const event of this.events) if (event.seq > cursor) item = this.reduce(item, entry.turnId, (event.data as { message: NativeEvent }).message);
    this.items.set(key, item); this.cursors.set(key, Math.max(cursor, ...this.events.map(event => event.seq))); this.errors.delete(key);
    if ((entry.itemStatus ?? entry.status) !== "inProgress" && !this.events.some(event => event.seq > cursor)) void saveOpenedDetail(this.owner, this.botId, cacheKey, item, this.attachments, version!, "run", current).catch(() => {});
    return item;
  }
  matches(event: BotEvent) {
    const data = event.data as Partial<BotRunContext> | null;
    return client.owner === this.owner && event.botId === this.botId && data?.runId === this.context.runId && data?.laneId === this.context.laneId && data?.threadId === this.context.threadId;
  }
  dispose() {
    this.dead = true; this.lifecycle++; if (this.frame) cancelAnimationFrame(this.frame); if (this.timer) clearTimeout(this.timer);
    this.frame = 0; this.timer = undefined; this.automatic.clear(); this.items.clear(); this.readers.clear(); this.listeners.clear();
  }
}

type SavedPage = { key: string; page: HistoryPage };
const PAGE_CACHE = "run-history-pages:v1";
export function savedRunPage(owner: string, botId: string, runId: string, turnId?: string | null, cursor?: string | null) {
  if (client.owner !== owner) return null;
  const key = JSON.stringify([botId, runId, turnId ?? null, cursor ?? null]);
  return client.cache<SavedPage[]>(PAGE_CACHE, []).find(value => value.key === key)?.page ?? null;
}
export function saveRunPage(owner: string, botId: string, runId: string, turnId: string | null | undefined, cursor: string | null, page: HistoryPage) {
  if (client.owner !== owner || page.context?.runId !== runId) return;
  const key = JSON.stringify([botId, runId, turnId ?? null, cursor]);
  client.save(PAGE_CACHE, [{ key, page }, ...client.cache<SavedPage[]>(PAGE_CACHE, []).filter(value => value.key !== key)].slice(0, 6));
}
export function verifyRunPage(value: HistoryResponse, runId: string, known?: { threadId?: string | null; laneId?: string | null }) {
  if (value.kind !== "page" || value.context?.runId !== runId || !value.context.threadId || !value.context.laneId || known?.threadId && value.context.threadId !== known.threadId || known?.laneId && value.context.laneId !== known.laneId) throw Error("This run's recorded history could not be verified. Refresh Activity.");
  return value;
}
