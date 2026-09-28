import type { BotAttachment, BotEvent, BotRunContext } from "../../lib/bots-types";
import type { HistoryDetail, HistoryEntry, HistoryPage, HistoryResponse } from "../../lib/bot-history-view";
import type { ThreadItem } from "../../lib/codex-protocol/v2/ThreadItem";
import { reduceBotTurns, type NativeEvent } from "./thread-state";
import { botsClient as client } from "./client";
import { readOpenedDetail, saveOpenedDetail, updateOpenedDetailAttachments } from "./timeline-detail-cache";

const mergeFiles = (old: BotAttachment[], incoming: BotAttachment[]) => [...new Map([...old, ...incoming].map(file => [file.id, file])).values()].slice(-128);
const itemKey = (entry: Pick<HistoryEntry, "turnId" | "id">) => JSON.stringify([entry.turnId, entry.id]);
/** Selected-run reader. No subscriptions, timers, native bodies or fetches for unopened runs. */
export class RunHistoryReader {
  attachments: BotAttachment[] = [];
  private items = new Map<string, ThreadItem>();
  private requests = new Map<string, Promise<ThreadItem>>();
  private listeners = new Set<() => void>();
  private version = 0;
  private dead = false;
  private events: BotEvent[] = [];
  private replayOverflow = false;
  private cursors = new Map<string, number>();
  private frame = 0;
  constructor(readonly owner: string, readonly botId: string, readonly context: BotRunContext) {}
  activate() { this.dead = false; }
  snapshot = () => this.version;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  subscribeDetail = (_entry: Pick<HistoryEntry, "turnId" | "id">, fn: () => void) => this.subscribe(fn);
  private notify() { this.version++; for (const fn of this.listeners) fn(); }
  private valid() { if (this.dead || client.owner !== this.owner) throw Error("This run's owner changed. Reopen Activity."); }
  private scoped(value: { context?: HistoryPage["context"] }) {
    this.valid();
    if (!value.context || value.context.runId !== this.context.runId || value.context.laneId !== this.context.laneId || value.context.threadId !== this.context.threadId) throw Error("The response belongs to a different run. Reopen Activity.");
  }
  receive = (event: BotEvent) => {
    if (!this.matches(event) || event.type !== "run.codex") return;
    const native = (event.data as { message: NativeEvent }).message;
    if (!native?.params || native.params.threadId && native.params.threadId !== this.context.threadId) return;
    // Buffer only for explicitly opened bodies; unopened tools never hydrate.
    if (this.requests.size) {
      this.events.push(event);
      if (this.events.length > 64 || JSON.stringify(this.events).length > 256 * 1024) { this.events = []; this.replayOverflow = true; }
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
  detailPending = (entry: HistoryEntry) => this.requests.has(itemKey(entry));
  detail(entry: HistoryEntry): Promise<ThreadItem> {
    const key = itemKey(entry);
    const pending = this.requests.get(key); if (pending) return pending;
    if (!this.requests.size) { this.events = []; this.replayOverflow = false; }
    const promise = this.read(entry, key).finally(() => { this.requests.delete(key); this.notify(); });
    this.requests.set(key, promise); this.notify(); return promise;
  }
  private async read(entry: HistoryEntry, key: string) {
    this.valid();
    const cacheKey = JSON.stringify([this.context, key]);
    const cached = await readOpenedDetail(this.owner, this.botId, cacheKey, "run").catch(() => null);
    this.valid();
    if (cached) { this.items.set(key, cached.item); this.attachments = mergeFiles(this.attachments, cached.attachments); this.notify(); }
    if (!client.online) {
      if (!cached) throw Error("This detail isn't saved yet. Connect to open it.");
      return cached.item;
    }
    let offset = 0, json = "", version: string | undefined, cursor = 0;
    do {
      const part = await client.rpc<HistoryDetail>("history.detail", this.botId, { runId: this.context.runId, turnId: entry.turnId, itemId: entry.id, offset, version, ...(offset === 0 && cached ? { knownVersion: cached.version } : {}) }, undefined, { owner: this.owner });
      this.scoped(part);
      if (this.replayOverflow) throw Error("This run changed while its detail was loading. Open it again for the latest recorded version.");
      cursor = part.eventCursor ?? cursor;
      this.attachments = mergeFiles(this.attachments, part.attachments ?? []);
      if (part.notModified && cached) {
        await updateOpenedDetailAttachments(this.owner, this.botId, cacheKey, this.attachments, cached.version, "run").catch(() => {});
        this.valid(); this.cursors.set(key, Math.max(cursor, ...this.events.map(event => event.seq)));
        let item = cached.item;
        for (const event of this.events) if (event.seq > cursor) item = this.reduce(item, entry.turnId, (event.data as { message: NativeEvent }).message);
        this.items.set(key, item); return item;
      }
      if (version && part.version !== version) throw Error("This item changed. Open it again for the latest detail.");
      version = part.version; json += part.json;
      if (part.nextOffset === null) break;
      if (part.nextOffset <= offset || part.nextOffset !== json.length) throw Error("Run detail did not advance. Reopen this item.");
      offset = part.nextOffset;
    } while (true);
    let item = JSON.parse(json) as ThreadItem;
    if (item.id !== entry.id) throw Error("The item identity changed. Reopen this run.");
    if (item.type === "reasoning") item = { ...item, content: [] };
    for (const event of this.events) if (event.seq > cursor) item = this.reduce(item, entry.turnId, (event.data as { message: NativeEvent }).message);
    this.items.set(key, item); this.cursors.set(key, Math.max(cursor, ...this.events.map(event => event.seq)));
    // Retain only a handful of explicitly opened bodies in memory; disk has a
    // separate 12 MiB / 12-entry budget and never competes with main detail.
    for (const old of [...this.items.keys()].slice(0, Math.max(0, this.items.size - 8))) this.items.delete(old);
    if (entry.status !== "inProgress" && !this.events.some(event => event.seq > cursor)) void saveOpenedDetail(this.owner, this.botId, cacheKey, item, this.attachments, version!, "run").catch(() => {});
    return item;
  }
  matches(event: BotEvent) {
    const data = event.data as Partial<BotRunContext> | null;
    return client.owner === this.owner && event.botId === this.botId && data?.runId === this.context.runId && data?.laneId === this.context.laneId && data?.threadId === this.context.threadId;
  }
  dispose() { this.dead = true; if (this.frame) cancelAnimationFrame(this.frame); this.items.clear(); this.listeners.clear(); }
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
export function verifyRunPage(value: HistoryResponse, runId: string, known?: Partial<BotRunContext>) {
  if (value.kind !== "page" || value.context?.runId !== runId || !value.context.threadId || !value.context.laneId || known?.threadId && value.context.threadId !== known.threadId || known?.laneId && value.context.laneId !== known.laneId) throw Error("This run's recorded history could not be verified. Refresh Activity.");
  return value;
}
