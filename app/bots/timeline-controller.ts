import { turnTiming, type NativeTiming } from '../../lib/bot-timing';
import { reconcileHistory, conversationEntries, orderedHistory } from "./history-reconcile";
import { turnAudience, scheduleInput, peerInput, humanInput, reportedFinding, projectConversationItem, type TurnAudience } from "../../lib/bot-conversation";
import { historyBoundaries, retainHistory, retainedAttachments, CACHE_ENTRIES, CACHE_BYTES } from "./history-window";
import { HISTORY_TEXT_LIMIT, withTurnState, conversationItem, historyTail, historyBefore, historyKey, projectHistoryItem, projectWorkPlan, type HistoryEntry, type HistoryResponse, type HistoryDetail, type HistoryPosition, type HistoryGap } from "../../lib/bot-history-view";
import { workPlanSource } from '../../lib/native-work-plan';
import type { BotAttachment, BotEvent, BotScheduledTurn, BotScheduledEventData } from "../../lib/bots-types";
import type { ThreadItem } from "../../lib/codex-protocol/v2/ThreadItem";
import type { Turn } from "../../lib/codex-protocol/v2/Turn";
import { readOpenedDetail, saveOpenedDetail, updateOpenedDetailAttachments } from "./timeline-detail-cache";
import { reduceBotTurns, reduceItemEvent, type NativeEvent } from "./thread-state";
import { timelineCache, type createTimelineCache, type TimelineMetadata } from "./timeline-cache";

export type TimelineTransport = {
  owner: string; online: boolean;
  snapshot?: { bots: { id: string; threadId: string | null; activeTurnId?: string | null }[] } | null;
  rpc<T>(method: "history.view" | "history.detail", botId: string, params?: Record<string, unknown>): Promise<T>;
};
export type TimelineState = {
  currentTiming?: NativeTiming & { threadId: string; turnId: string; turnStatus?: Turn['status'] };
  partialTurn?: boolean; entries: HistoryEntry[]; contextEntries: HistoryEntry[]; attachments: BotAttachment[]; olderCursor: string | null;
  revision: string; eventCursor: number; complete: boolean; loading: boolean;
  error: string; cached: boolean; gaps: HistoryGap[]; position: HistoryPosition;
};
const initial = (): TimelineState => ({ entries: [], contextEntries: [], attachments: [], olderCursor: null, revision: "", eventCursor: 0,
  complete: false, loading: false, gaps: [], error: "", cached: false, position: { anchor: null, offset: 0, following: true } });
type Cache = ReturnType<typeof createTimelineCache>;
const scopedPage = (page: HistoryResponse, threadId: string | null | undefined): HistoryResponse => page.kind !== 'page' || !threadId ? page : ({ ...page,
  entries: page.entries.map(entry => ({ ...entry, sourceThreadId: threadId })),
  contextEntries: page.contextEntries?.map(entry => ({ ...entry, sourceThreadId: threadId })) });

/** One owner/thread store and one refresh in flight, independent of React selection. */
export class BotTimeline {
  private state = initial();
  private attributed = new Map<string, string>();
  private normalScheduled = new Set<string>();
  private attributionCursor = -1;
  /** Metadata invalidates projection; only a full native projection can prove
   * absence of human input. Never hide a partial cached turn from a receipt. */
  scheduled(turns: BotScheduledTurn[]) {
    if (this.disposed || this.transport.owner !== this.owner) return;
    let changed = false;
    for (const turn of turns) {
      if (turn.botId !== this.botId || !turn.turnId || !turn.runId) continue;
      if (this.attributed.get(turn.turnId) === turn.runId && (!turn.conversation || this.normalScheduled.has(turn.turnId))) continue;
      this.attributed.set(turn.turnId, turn.runId); changed = true;
      if (turn.conversation) {
        this.normalScheduled.add(turn.turnId);
        this.turnAudiences.set(turn.turnId, { kind: "conversation", runId: turn.runId, active: true });
      }
    }
    while (this.attributed.size > 384) this.attributed.delete(this.attributed.keys().next().value!);
    if (changed) { this.state = { ...this.state, revision: "" }; if (this.hydration) this.scheduleRefresh(); }
  }
  private turnAudiences = new Map<string, TurnAudience>();
  private configurations = new Map<string, import("../../lib/bot-collaboration").TurnConfiguration | null>();
  configuration = (threadId: string | null | undefined, turnId: string) => threadId ? this.configurations.get(JSON.stringify([threadId,turnId])) ?? null : null;
  private aliases = new Map<string, string>();
  private identityAliases = new Map<string, string>();
  resolveKey = (key: string | null): string | null => {
    const seen = new Set<string>();
    while (key && this.aliases.has(key) && !seen.has(key)) { seen.add(key); key = this.aliases.get(key)!; }
    return key;
  };
  private normalize(entries: HistoryEntry[]) {
    const reconciled = reconcileHistory(conversationEntries(entries, this.turnAudiences));
    for (const [from, to] of reconciled.aliases) { this.aliases.set(from, to); this.identityAliases.set(from, to); }
    const kept = new Set(reconciled.entries.map((entry) => historyKey(entry.turnId, entry.id)));
    const successors: (HistoryEntry | undefined)[] = new Array(entries.length);
    let next: HistoryEntry | undefined, previous: HistoryEntry | undefined;
    for (let index = entries.length - 1; index >= 0; index--) {
      if (kept.has(historyKey(entries[index].turnId, entries[index].id))) next = entries[index];
      successors[index] = next;
    }
    for (let index = 0; index < entries.length; index++) {
      const key = historyKey(entries[index].turnId, entries[index].id);
      if (kept.has(key)) { previous = entries[index]; continue; }
      if (this.aliases.has(key)) continue;
      const replacement = successors[index] ?? previous;
      if (replacement) this.aliases.set(key, historyKey(replacement.turnId, replacement.id));
    }
    const boundaries = historyBoundaries(reconciled.entries, this.mapGaps(this.state.gaps), this.state.olderCursor, entries);
    this.state = { ...this.state, ...boundaries, position: { ...this.state.position, anchor: this.resolveKey(this.state.position.anchor) } };
    for (const entry of reconciled.entries) if (reconciled.aliases.size) this.dirty.set(historyKey(entry.turnId, entry.id), entry);
    return reconciled.entries;
  }
  private mapGaps(gaps: HistoryGap[]) {
    // Reading anchors may fall back to a neighbour after a tool disappears.
    // Gap endpoints need identity aliases only; removal must retain the hole.
    const identity = (key: string) => {
      const seen = new Set<string>();
      while (this.identityAliases.has(key) && !seen.has(key)) { seen.add(key); key = this.identityAliases.get(key)!; }
      return key;
    };
    return gaps.map(gap => ({ ...gap, before: identity(gap.before), stop: identity(gap.stop) }));
  }
  private listeners = new Set<() => void>();
  private dirty = new Map<string, HistoryEntry>();
  private hydration?: Promise<void>;
  private request?: Promise<void>;
  private latestRequest?: Promise<void>;
  private latestCursor: string | null = null;
  private olderRequest?: Promise<void>;
  private gapRequests = new Map<string, Promise<void>>();
  private write?: Promise<void>;
  private writeVersion = 0;
  private writeTimer?: ReturnType<typeof setTimeout>;
  private publishTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private metadataVersion = 0;
  private cachedKeys = new Set<string>();
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private refreshAgain = false;
  private detailTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private detailInvalidations = new Map<string, number>();
  private detailCursors = new Map<string, number>();
  private supplements = new Map<string, ThreadItem>();
  private planScope(threadId: string | undefined, turnId: string | undefined) {
    if (!turnId || !threadId || threadId !== this.currentThread()) return false;
    const active = this.transport.snapshot?.bots.find(bot => bot.id === this.botId)?.activeTurnId ??
      (this.state.currentTiming?.turnStatus === 'inProgress' ? this.state.currentTiming.turnId : null);
    return !active || active === turnId || this.state.entries.some(entry => entry.turnId === turnId);
  }
  private detailItems = new Map<string, ThreadItem>();
  private detailListeners = new Map<string, Set<() => void>>();
  private detailEvents = new Map<string, BotEvent[]>();
  detailPending = (entry: HistoryEntry) => this.detailInvalidations.has(historyKey(entry.turnId, entry.id));
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
    const existing = new Map(this.state.entries.map(entry => [historyKey(entry.turnId, entry.id), entry]));
    const normalized = this.normalize(orderedHistory(this.state.entries, entries, prepend, preserveAfter));
    for (const entry of normalized) if (existing.get(historyKey(entry.turnId, entry.id)) !== entry) this.dirty.set(historyKey(entry.turnId, entry.id), entry);
    this.state = { ...this.state, entries: normalized };
  }
  private rememberPage(page: Extract<HistoryResponse, { kind: "page" }>) {
    for (const value of page.turnConfigurations ?? []) {
      if (value.threadId !== this.currentThread() || !value.turnId) continue;
      const key = JSON.stringify([value.threadId,value.turnId]), old = this.configurations.get(key);
      // Conflicting original evidence is Unknown, never filled from selectors.
      this.configurations.set(key, this.configurations.has(key) && JSON.stringify(old) !== JSON.stringify(value) ? null : value);
    }
    while (this.configurations.size > 384) this.configurations.delete(this.configurations.keys().next().value!);
    for (const value of page.activityTurns ?? []) this.turnAudiences.set(value.turnId, { kind: "activity", runId: value.runId, active: value.active });
    for (const entry of page.entries) if (entry.audience)
      this.turnAudiences.set(entry.turnId, { kind: entry.audience === "finding" ? "activity" : entry.audience, runId: entry.runId, active: entry.turnStatus === "inProgress" });
    for (const entry of page.entries) if (entry.runId && entry.audience === "conversation" && entry.scheduled) this.normalScheduled.add(entry.turnId);
  }
  /** A contiguous native page can extend or close previously evicted ranges. */
  private pageBoundaries(page: Extract<HistoryResponse, { kind: "page" }>, older = false) {
    const entries = this.state.entries, indices = new Map(entries.map((entry, index) => [historyKey(entry.turnId, entry.id), index]));
    const positions = page.entries.map(entry => indices.get(this.resolveKey(historyKey(entry.turnId, entry.id))!)).filter((index): index is number => index !== undefined);
    const first = Math.min(...positions), last = Math.max(...positions);
    const gaps = this.state.gaps.flatMap(gap => {
      const before = indices.get(gap.before)!, stop = indices.get(gap.stop)!;
      if (last >= before && (first <= stop || !page.olderCursor)) return [];
      if (last >= before && first < before && first > stop) return [{ ...gap, before: historyKey(entries[first].turnId, entries[first].id), cursor: page.olderCursor ?? historyBefore(entries[first]) }];
      if (first <= stop && last > stop && last < before) return [{ ...gap, stop: historyKey(entries[last].turnId, entries[last].id) }];
      return [gap];
    });
    const olderCursor = older || first === 0 || !entries.length || !page.olderCursor ? page.olderCursor : this.state.olderCursor;
    return { gaps, olderCursor, complete: !olderCursor && !gaps.length && entries.every(entry => entry.complete) };
  }
  seed(turns: Turn[], attachments: BotAttachment[]) {
    if (this.state.cached || this.state.entries.length || !turns.length || this.disposed) return;
    for (const turn of turns) this.turnAudiences.set(turn.id, { ...turnAudience(turn.items), active: turn.status === "inProgress" });
    const entries = historyTail(turns, turns.reduce((n, turn) => n + turn.items.length, 0));
    this.merge(entries);
    this.publish({ cached: true, attachments, olderCursor: entries.length ? historyBefore(entries[0]) : null }, true);
    this.scheduleWrite();
  }
  async hydrate() {
    this.hydration ??= (async () => {
      try {
        const cached = await this.cache.read(this.owner, this.botId);
        if (!cached || this.disposed || this.transport.owner !== this.owner) return;
        const live = this.state.eventCursor;
        const liveDirty = new Map(this.dirty);
        for (const { turnId, ...audience } of cached.metadata.turnAudiences ?? [])
          if (!this.turnAudiences.has(turnId)) this.turnAudiences.set(turnId, audience);
        for (const { turnId, kind, runId } of cached.metadata.turnAudiences ?? [])
          if (kind === "conversation" && runId) this.normalScheduled.add(turnId);
        // Existing revisions encode the original native thread. Older caches
        // without that evidence remain readable but supply no navigation ticks.
        const cachedThread = cached.metadata.revision.split(':')[1];
        const scoped = cached.entries.map(entry => entry.sourceThreadId || !cached.metadata.revision.endsWith(':conversation-v8') ? entry : { ...entry, sourceThreadId: cachedThread });
        this.merge(scoped, true, -1); this.dirty = liveDirty;
        const m = cached.metadata; this.cachedKeys = new Set(m.order ?? []);
        const boundaries = historyBoundaries(this.state.entries, this.mapGaps(m.gaps ?? []), m.olderCursor, cached.entries);
        const present = new Set(cached.entries.map(entry => historyKey(entry.turnId, entry.id)));
        const intact = m.order.every(key => present.has(key));
        this.publish({ revision: intact && m.revision.endsWith(":conversation-v8") ? m.revision : "", eventCursor: Math.max(live, m.eventCursor), ...boundaries,
          partialTurn: m.partialTurn, attachments: m.attachments, contextEntries: conversationEntries((m.contextEntries ?? []).map(entry => entry.sourceThreadId || !m.revision.endsWith(':conversation-v8') ? entry : { ...entry, sourceThreadId: cachedThread }), this.turnAudiences), complete: m.complete && !boundaries.olderCursor && !boundaries.gaps.length, position: { ...(m.position ?? this.state.position), anchor: this.resolveKey(m.position?.anchor ?? null) }, cached: true }, true);
        this.scheduleWrite();
      } catch (e) { this.publish({ error: `Offline history cache unavailable: ${String(e)}` }, true); }
    })();
    return this.hydration;
  }
  /** Cache revisions describe an earlier projection, not proof of the live
   * tail. Opening/reconnecting/resuming checks one bounded latest page without
   * throwing away older pages or changing the user's reading position. */
  refreshLatest() {
    if (this.latestRequest) return this.latestRequest;
    this.latestRequest = (async () => {
      await this.hydrate();
      // A conditional request already in flight cannot satisfy this check.
      // Coalesce its callers into one subsequent unconditional projection.
      await this.request;
      if (!this.transport.online || this.transport.owner !== this.owner || this.disposed) return;
      this.latestCursor = null;
      this.state = { ...this.state, revision: "" };
      await this.refresh();
    })().finally(() => { this.latestRequest = undefined; });
    return this.latestRequest;
  }
  invalidateLatest() { if (!this.disposed && this.transport.owner === this.owner) this.scheduleRefresh(); }
  recoverLatest() { return this.latestCursor ? this.refresh() : this.refreshLatest(); }
  private currentThread() { return this.transport.snapshot?.bots.find(bot => bot.id === this.botId)?.threadId; }
  async refresh() {
    await this.hydrate();
    if (!this.transport.online || this.transport.owner !== this.owner || this.disposed) return;
    if (this.request) return this.request;
    const startCursor = this.state.eventCursor;
    const threadId = this.currentThread();
    const latestCursor = this.latestCursor;
    this.publish({ loading: true, error: "" }, true);
    this.request = (async () => {
      try {
        const response = scopedPage(await this.transport.rpc<HistoryResponse>("history.view", this.botId, {
          projection: "conversation", ...(latestCursor ? { cursor: latestCursor } : { revision: this.state.revision || undefined }), after: this.state.eventCursor }), threadId);
        if (this.disposed || this.transport.owner !== this.owner) return;
        if (threadId !== this.currentThread()) { this.scheduleRefresh(); return; }
        if (threadId && response.context?.threadId && response.context.threadId !== threadId)
          throw Error("The conversation changed while loading. Reconnect and reload its history.");
        if (response.kind === "events") for (const event of response.events) this.receive(event);
        if (response.kind === "page") {
          if (!response.entries.length && response.olderCursor === latestCursor && latestCursor)
            throw Error("Recent history did not advance. Reconnect and reload the conversation.");
          // Filtered native pages must not make an old cached tail look current.
          // Retain the new cursor separately from the older reading window;
          // Reload conversation advances exactly one page, never a scan loop.
          this.latestCursor = !response.entries.length ? response.olderCursor : null;
          this.rememberPage(response);
          const known = new Set(this.state.entries.map((entry) => historyKey(entry.turnId, entry.id)));
          const clients = new Set(this.state.entries.flatMap((entry) => entry.item?.type === "userMessage" && entry.item.clientId ? [entry.item.clientId] : []));
          const overlaps = response.entries.some((entry) => known.has(historyKey(entry.turnId, entry.id)) || entry.item?.type === "userMessage" && entry.item.clientId && clients.has(entry.item.clientId));
          const oldLast = this.state.entries.at(-1), newFirst = response.entries[0];
          if (oldLast && newFirst && !overlaps && response.olderCursor) {
            const gap = { before: historyKey(newFirst.turnId, newFirst.id), stop: historyKey(oldLast.turnId, oldLast.id), cursor: historyBefore(newFirst) };
            this.state = { ...this.state, gaps: [...this.state.gaps, gap] };
          }
          const terminal = new Map(response.entries.filter((entry) => entry.turnStatus && entry.turnStatus !== "inProgress").map((entry) => [entry.turnId, { status: entry.turnStatus!, error: entry.turnError ? { message: entry.turnError } : null }]));
          this.state = { ...this.state, entries: this.state.entries.map((entry) => {
            if (!terminal.has(entry.turnId) || (entry.updatedSeq ?? 0) > startCursor) return entry;
            const settled = { ...withTurnState(entry, terminal.get(entry.turnId)!), updatedSeq: response.eventCursor };
            this.dirty.set(historyKey(settled.turnId, settled.id), settled);
            return settled;
          }) };
          this.merge(response.entries, false, startCursor);
          // Keep loaded older pages; a latest-page refresh never replaces them.
          this.publish({ partialTurn: response.partialTurn, attachments: mergeAttachments(this.state.attachments, response.attachments), contextEntries: response.contextEntries ?? [],
            ...this.pageBoundaries(response), cached: true,
            ...(this.latestCursor ? { error: "Recent history continues beyond this page. Reload conversation to continue; your saved messages are kept." }
              : !response.entries.length && this.state.entries.length && !response.contextEntries?.length
                ? { error: "No visible messages were returned from the current conversation. Saved history is retained; reload to check again." } : {}) });
        }
        this.publish({ revision: this.latestCursor ? "" : response.revision, eventCursor: Math.max(this.state.eventCursor, response.eventCursor) });
        this.scheduleWrite();
      } catch (e) { if (!this.disposed && this.transport.owner === this.owner && threadId === this.currentThread())
        this.publish({ error: e instanceof Error ? e.message : String(e) }); }
      finally { this.request = undefined; if (!this.disposed) { this.publish({ loading: false }, true); if (this.refreshAgain) { this.refreshAgain = false; this.scheduleRefresh(); } } }
    })();
    return this.request;
  }
  revealSource(entry: HistoryEntry) {
    const before = this.state.entries, key = historyKey(entry.turnId, entry.id);
    if (before.some(value => historyKey(value.turnId, value.id) === key)) return;
    const index = before.findIndex(value => (value.messageAt ?? value.startedAt ?? Infinity) > (entry.messageAt ?? entry.startedAt ?? -Infinity));
    const at = index < 0 ? before.length : index;
    const entries = this.normalize([...before.slice(0, at), entry, ...before.slice(at)]);
    const previous = before[at - 1], next = before[at];
    // Split a pre-existing hole instead of retaining an overlapping third gap.
    const gaps = this.state.gaps.filter(gap => !next || gap.before !== historyKey(next.turnId, next.id));
    if (previous) gaps.push({ before: key, stop: historyKey(previous.turnId, previous.id), cursor: historyBefore(entry) });
    if (next) gaps.push({ before: historyKey(next.turnId, next.id), stop: key, cursor: historyBefore(next) });
    this.dirty.set(key, entry);
    this.publish({ entries, gaps, olderCursor: at === 0 ? historyBefore(entry) : this.state.olderCursor, complete: false }, true);
    this.scheduleWrite();
  }
  async older() {
    if (this.olderRequest) return this.olderRequest;
    const cursor = this.state.olderCursor;
    if (!cursor || !this.transport.online || this.transport.owner !== this.owner || this.disposed) return;
    const threadId = this.currentThread();
    this.publish({ error: "" }, true);
    this.olderRequest = (async () => {
      try {
        const page = scopedPage(await this.transport.rpc<HistoryResponse>("history.view", this.botId, { projection: "conversation", cursor }), threadId);
        if (this.disposed || this.transport.owner !== this.owner || threadId !== this.currentThread() || page.kind !== "page") return;
        if (threadId && page.context?.threadId && page.context.threadId !== threadId) throw Error("The conversation changed while loading earlier history.");
        this.rememberPage(page);
        if (!page.entries.length && page.olderCursor === cursor) throw new Error("History pagination made no progress. Retry to reconnect these pages.");
        this.merge(page.entries, true, -1);
        this.publish({ partialTurn: page.partialTurn, ...this.pageBoundaries(page, true), attachments: mergeAttachments(this.state.attachments, page.attachments) }, true);
        this.scheduleWrite();
      } catch (e) { if (!this.disposed && this.transport.owner === this.owner && threadId === this.currentThread()) this.publish({ error: String(e) }, true); }
      finally { this.olderRequest = undefined; }
    })();
    return this.olderRequest;
  }
  async fillGap(gap: HistoryGap, direction = -1) {
    const key = JSON.stringify([gap.before, gap.stop, direction]);
    const pending = this.gapRequests.get(key); if (pending) return pending;
    const request = this.readGap(gap, direction).finally(() => this.gapRequests.delete(key));
    this.gapRequests.set(key, request); return request;
  }
  private async readGap(gap: HistoryGap, direction: number) {
    if (!this.transport.online || this.transport.owner !== this.owner || this.disposed) return;
    const threadId = this.currentThread();
    this.publish({ error: "" }, true);
    try {
      const page = scopedPage(await this.transport.rpc<HistoryResponse>("history.view", this.botId, { projection: "conversation", cursor: direction > 0 ? JSON.stringify({ native: null, before: null, after: gap.stop }) : gap.cursor }), threadId);
      if (this.disposed || this.transport.owner !== this.owner || threadId !== this.currentThread() || page.kind !== "page") return;
      if (threadId && page.context?.threadId && page.context.threadId !== threadId) throw Error("The conversation changed while loading this history gap.");
      this.rememberPage(page);
      const beforeKey = this.resolveKey(gap.before), stopKey = this.resolveKey(gap.stop);
      const boundary = this.state.entries.findIndex((entry) => historyKey(entry.turnId, entry.id) === beforeKey);
      const currentGap = this.state.gaps.find((value) => value.before === beforeKey && value.stop === stopKey);
      if (boundary < 0 || !currentGap) return;
      const stop = this.state.entries.findIndex((entry) => historyKey(entry.turnId, entry.id) === stopKey);
      const targetKeys = new Set((direction > 0 ? this.state.entries.slice(boundary) : this.state.entries.slice(0, boundary)).map((entry) => historyKey(entry.turnId, entry.id)));
      const clients = new Map(this.state.entries.flatMap(entry => entry.item?.type === "userMessage" && entry.item.clientId ? [[entry.item.clientId, historyKey(entry.turnId, entry.id)] as const] : []));
      const identity = (entry: HistoryEntry) => entry.item?.type === "userMessage" && entry.item.clientId && clients.get(entry.item.clientId) || this.resolveKey(historyKey(entry.turnId, entry.id))!;
      const connected = page.entries.some((entry) => targetKeys.has(identity(entry)));
      const allKeys = new Set(this.state.entries.map((entry) => historyKey(entry.turnId, entry.id)));
      const added = page.entries.filter((entry) => !allKeys.has(identity(entry)));
      const exhausted = direction > 0 ? page.newerCursor === null : !page.olderCursor;
      if (!connected && !exhausted && !added.length && (direction > 0 || page.olderCursor === currentGap.cursor)) throw new Error("History pagination made no progress. Retry to reconnect these pages.");
      const insertion = direction > 0 && stop >= 0 ? stop + 1 : boundary;
      const previous = this.state.entries;
      const gaps = this.state.gaps.flatMap((value) => value !== currentGap ? [value] : connected || exhausted ? [] : [direction > 0 ? {
        ...currentGap, stop: added.length ? historyKey(added.at(-1)!.turnId, added.at(-1)!.id) : currentGap.stop,
      } : { ...currentGap, before: added.length ? historyKey(added[0].turnId, added[0].id) : currentGap.before, cursor: page.olderCursor! }]);
      if (page.entries.some(entry => allKeys.has(identity(entry)))) this.merge(page.entries, direction < 0, -1);
      else {
        const normalized = this.normalize([...previous.slice(0, insertion), ...added, ...previous.slice(insertion)]);
        this.state = { ...this.state, entries: normalized };
        for (const entry of added) this.dirty.set(historyKey(entry.turnId, entry.id), entry);
      }
      const first = this.state.entries[0], incomingFirst = page.entries[0];
      const ownsOldest = direction < 0 && (!page.olderCursor || first && incomingFirst && this.resolveKey(historyKey(incomingFirst.turnId, incomingFirst.id)) === historyKey(first.turnId, first.id));
      const boundaries = historyBoundaries(this.state.entries, this.mapGaps(gaps), ownsOldest ? page.olderCursor : this.state.olderCursor, previous);
      this.publish({ ...boundaries, complete: !boundaries.olderCursor && !boundaries.gaps.length && this.state.entries.every(entry => entry.complete), attachments: mergeAttachments(this.state.attachments, page.attachments) }, true); this.scheduleWrite();
    } catch (e) { if (!this.disposed && this.transport.owner === this.owner && threadId === this.currentThread()) this.publish({ error: String(e) }, true); }
  }
  private scheduleRefresh() {
    this.latestCursor = null;
    this.state = { ...this.state, revision: "" };
    if (this.request) { this.refreshAgain = true; return; }
    this.refreshTimer ??= setTimeout(() => { this.refreshTimer = undefined; if (!this.disposed) void this.refresh(); }, 250);
  }
  private invalidateDetail(entry: HistoryEntry, seq: number) {
    const key = historyKey(entry.turnId, entry.id);
    if (!this.detailListeners.get(key)?.size || entry.item && !this.detailItems.has(key)) return;
    this.detailInvalidations.set(key, seq);
    if (this.detailTimers.has(key)) return;
    this.detailTimers.set(key, setTimeout(async () => {
      this.detailTimers.delete(key);
      if (this.disposed || !this.detailListeners.get(key)?.size || !this.transport.online) return;
      const wanted = this.detailInvalidations.get(key) ?? seq;
      try {
        await this.detail(this.state.entries.find((value) => historyKey(value.turnId, value.id) === key) ?? entry);
        if ((this.detailCursors.get(key) ?? 0) < wanted || (this.detailInvalidations.get(key) ?? 0) > wanted) this.invalidateDetail(entry, this.detailInvalidations.get(key) ?? wanted);
        else { this.detailInvalidations.delete(key); this.publish({}, true); }
      } catch (error) { this.detailInvalidations.delete(key); if (entry.workPlan) this.detailItems.delete(key); this.publish({ error: `Open detail could not refresh: ${String(error)}` }, true); }
    }, 1000));
  }
  receive(event: BotEvent) {
    if (event.type.startsWith("run.")) return; // Run traffic never enters main history/detail/write lanes.
    if (this.disposed || event.botId !== this.botId) return;
    if (event.type === "schedules") {
      if (event.seq <= this.attributionCursor) return;
      this.attributionCursor = event.seq;
      const data = event.data as BotScheduledEventData;
      if (data.activeScheduledTurn) this.scheduled([data.activeScheduledTurn]);
      // Even a previously seen receipt can now be terminal/acknowledged. A
      // new projection heals an old cached classification without guessing.
      if (data.runTurn?.botId === this.botId && data.runTurn.turnId) {
        this.state = { ...this.state, revision: "" }; this.scheduleRefresh();
      }
      return;
    }
    if (event.seq <= this.state.eventCursor) return;
    if (event.type === "history.refresh") {
      const data = event.data as { reason?: string; method?: string; threadId?: string; turnId?: string; itemId?: string; entry?: HistoryEntry; turn?: Turn };
      if (data.reason !== "large-native-event") { this.scheduleRefresh(); return; }
      if (data.method === 'turn/plan/updated' && data.threadId && !this.planScope(data.threadId, data.turnId)) return;
      // This descriptor supersedes the earlier small notification's local
      // body. The full replacement is now in the existing server detail lane.
      if (data.method === 'turn/plan/updated' && data.turnId) this.supplements.delete(historyKey(data.turnId, 'live-turn-plan'));
      const entries = this.state.entries.filter(entry => !(data.method === 'turn/plan/updated' && !data.entry && entry.turnId === data.turnId && entry.id === 'live-turn-plan'));
      if (data.entry) {
        const terminal = this.state.entries.find((entry) => entry.turnId === data.entry!.turnId && entry.turnStatus && entry.turnStatus !== "inProgress");
        const timing = this.state.currentTiming;
        const status = terminal?.turnStatus ?? (data.entry.workPlan && timing?.turnId === data.entry.turnId && timing.threadId === this.currentThread() ? timing.turnStatus : undefined);
        const next = { ...data.entry, ...(status && status !== 'inProgress' ? { turnStatus: status, status } : {}), updatedSeq: event.seq }, key = historyKey(next.turnId, next.id);
        const index = entries.findIndex((entry) => historyKey(entry.turnId, entry.id) === key);
        if (index < 0) entries.push(next); else entries[index] = { ...next, scheduled: entries[index].scheduled || next.scheduled };
        this.dirty.set(key, index < 0 ? next : entries[index]);
      }
      if (data.turn) {
        for (let i = 0; i < entries.length; i++) if (entries[i].turnId === data.turn.id) {
          entries[i] = { ...withTurnState(entries[i], data.turn), updatedSeq: event.seq };
          this.dirty.set(historyKey(entries[i].turnId, entries[i].id), entries[i]);
        }
        for (const entry of entries) if (entry.turnId === data.turn.id) this.invalidateDetail(entry, event.seq);
        this.scheduleRefresh(); // Sparse/final turns can contain previously unseen items.
      }
      const entry = entries.find((entry) => entry.turnId === data.turnId && entry.id === data.itemId);
      if (entry) this.invalidateDetail(entry, event.seq);
      else if (!data.turn && data.method !== 'turn/plan/updated') this.scheduleRefresh();
      // Oversized text deltas carry no text; refresh the bounded readable view.
      // A mounted preview must not silently request the entire native item.
      if (entry?.item && !data.entry && !data.turn) this.scheduleRefresh();
      this.publish({ entries: this.normalize(entries), eventCursor: event.seq }); this.scheduleWrite();
      if (data.method === "turn/completed" || data.method === "item/completed") void this.flush();
      return;
    }
    if (event.type === "attachment") { this.publish({ attachments: mergeAttachments(this.state.attachments, [event.data as BotAttachment]), eventCursor: event.seq }); this.scheduleWrite(); return; }
    if (event.type !== "codex") return;
    const { method, messageAt, operatorSegmentId, reply, replyMessages, replyByClientId, params: p } = event.data as { method: string; messageAt?: number; operatorSegmentId?: string; reply?: HistoryEntry["reply"]; replyMessages?: HistoryEntry["replyMessages"]; replyByClientId?: Record<string, Pick<HistoryEntry, "reply" | "replyMessages">>; params: { threadId?: string; startedAtMs?: number | null; completedAtMs?: number | null; turnId?: string; itemId?: string; item?: ThreadItem; turn?: Turn; delta?: string; diff?: string; plan?: unknown; explanation?: string | null } };
    const turnId = p.turnId ?? p.turn?.id;
    if (method === 'turn/plan/updated' && !this.planScope(p.threadId, turnId)) return;
    if (p.turn && p.threadId && p.threadId === this.currentThread() && ['turn/started', 'turn/completed'].includes(method)) {
      const current = this.state.currentTiming;
      // An unrelated old terminal observation never replaces the live start.
      if (method === 'turn/started' || !current || current.turnId === p.turn.id)
        this.publish({ currentTiming: { ...(current?.turnId === p.turn.id ? current : {}), ...turnTiming(p.turn), turnStatus: p.turn.status, threadId: p.threadId, turnId: p.turn.id } });
    }

    for (const [key, events] of this.detailEvents) if (key.startsWith(`${turnId}:`)) events.push(event);
    for (const [key, item] of this.detailItems) {
      if (!key.startsWith(`${turnId}:`)) continue;
      const reduced = reduceBotTurns([{ id: turnId!, items: [item], itemsView: "full", status: "inProgress", startedAt: null, completedAt: null, durationMs: null, error: null }], event.data as NativeEvent);
      const next = reduced[0]?.items.find((value) => value.id === item.id);
      if (next && next !== item) { this.detailItems.set(key, next.type === "reasoning" ? { ...next, content: [] } : next); }
    }
    if (!turnId) { this.publish({ eventCursor: event.seq }); return; }
    if (p.item && scheduleInput(p.item)) {
      const runId = p.item.type === "userMessage" ? p.item.clientId!.slice(9) : undefined;
      const mixed = this.state.entries.some(entry => entry.turnId === turnId && entry.item && humanInput(entry.item));
      this.turnAudiences.set(turnId, { kind: mixed ? "mixed" : this.normalScheduled.has(turnId) ? "conversation" : "activity", runId, active: true });
    } else if (p.item && peerInput(p.item) && !this.turnAudiences.get(turnId)?.runId) {
      this.turnAudiences.set(turnId, { kind: "conversation", active: true });
      this.scheduleRefresh();
    } else if (p.item && humanInput(p.item) && this.turnAudiences.get(turnId)?.kind === "activity") {
      this.turnAudiences.set(turnId, { ...this.turnAudiences.get(turnId)!, kind: "mixed" });
      this.scheduleRefresh(); // Recover surrounding replies hidden before the human steered in.
    }
    if (p.turn?.items.some(item => scheduleInput(item) || peerInput(item))) this.turnAudiences.set(turnId, turnAudience(p.turn.items, this.turnAudiences.get(turnId)?.runId, this.normalScheduled.has(turnId)));
    if (p.turn && this.turnAudiences.has(turnId)) this.turnAudiences.set(turnId, { ...this.turnAudiences.get(turnId)!, active: p.turn.status === "inProgress" });
    const update = (entry: HistoryEntry) => {
      const prior = this.state.entries.find(value => value.turnId === entry.turnId && value.id === entry.id);
      const observed = messageAt ?? (prior?.timeBasis === "received" ? prior.messageAt : null);
      this.merge([{ ...prior, ...entry, ...(p.threadId ? { sourceThreadId: p.threadId } : {}), ...(entry.item ? { workPlan: undefined } : {}), ...(entry.item?.type === "userMessage" ? replyByClientId?.[entry.item.clientId ?? ""] : {}), ...(reply ? { reply } : {}), ...(replyMessages ? { replyMessages } : {}), ...(operatorSegmentId ? { operatorSegmentId } : {}), ...(observed ? { messageAt: observed, timeBasis: "received" as const } : {}), updatedSeq: event.seq }]);
    };
    if (p.item && /item\/(started|completed)$/.test(method)) {
      const prior = this.state.entries.find((e) => e.turnId === turnId);
      const known = this.state.currentTiming?.turnId === turnId && this.state.currentTiming.threadId === this.currentThread() ? this.state.currentTiming : prior;
      const audience = this.turnAudiences.get(turnId);
      if (audience?.kind === "activity" && reportedFinding(p.item)) {
        const entry = projectConversationItem({ id: turnId, startedAt: known?.turnStartedAt ?? prior?.startedAt ?? null, completedAt: known?.turnCompletedAt, durationMs: known?.turnDurationMs, status: prior?.turnStatus ?? "inProgress" }, p.item, audience);
        if (entry) update(entry);
      }
      else
      update(projectHistoryItem({ id: turnId, startedAt: known?.turnStartedAt ?? prior?.startedAt ?? null, completedAt: known?.turnCompletedAt, durationMs: known?.turnDurationMs, status: prior?.turnStatus ?? "inProgress" }, p.item,
        prior?.scheduled || p.item.type === "userMessage" && Boolean(p.item.clientId?.startsWith("schedule:")), p));
    } else if (p.turn && (method === "turn/completed" || method === "turn/started")) {
      for (const entry of this.state.entries) if (entry.turnId === turnId) update({ ...withTurnState(entry, p.turn), ...(entry.timeBasis !== "received" ? { messageAt: entry.type === "agentMessage" && entry.item?.type === "agentMessage" && entry.item.phase === "final_answer" ? p.turn.completedAt : p.turn.startedAt } : {}) });
      if (method === "turn/completed") for (const entry of this.state.entries) if (entry.turnId === turnId) this.invalidateDetail(entry, event.seq);
      for (const item of p.turn.items) {
        const audience = this.turnAudiences.get(turnId) ?? turnAudience(p.turn.items);
        const entry = projectConversationItem(p.turn, item, audience);
        if (entry) update(entry);
      }
      // Removing a tool-heavy live tail admits older readable turns and can
      // remove a gap's newest endpoint. Reconcile that boundary once, even
      // when native completion contains only sparse item/status information.
      if (method === "turn/completed") this.scheduleRefresh();
    } else if (method === "turn/diff/updated" || method === "turn/plan/updated") {
      const id = method === "turn/diff/updated" ? "live-turn-diff" : "live-turn-plan";
      const item: ThreadItem = { id, type: "plan", text: method === "turn/diff/updated" ? "```diff\n" + (p.diff ?? "") + "\n```" : workPlanSource(p.plan, p.explanation) };
      const key = historyKey(turnId, id); this.supplements.set(key, item);
      let supplementChars = 0;
      for (const [oldKey, value] of [...this.supplements].reverse()) {
        supplementChars += value.type === 'plan' ? value.text.length : 0;
        if (supplementChars > 8 * 1024 * 1024 || this.supplements.size > 8 && oldKey !== key) this.supplements.delete(oldKey);
      }
      if (this.detailItems.has(key)) this.detailItems.set(key, item);
      if (method === "turn/plan/updated") {
        const prior = this.state.entries.find(entry => entry.turnId === turnId);
        const current = this.state.currentTiming;
        const timing = current?.turnId === turnId && current.threadId === p.threadId ? current : undefined;
        const projected = projectWorkPlan({ id: turnId, status: prior?.turnStatus ?? timing?.turnStatus ?? 'inProgress', startedAt: prior?.startedAt ?? timing?.turnStartedAt ?? null }, p.plan, p.explanation);
        if (projected) update(projected);
        else { this.state = { ...this.state, entries: this.state.entries.filter(entry => historyKey(entry.turnId, entry.id) !== key) }; this.supplements.delete(key); this.detailItems.delete(key); }
      }
      else update({ id, turnId, type: "plan", label: method === "turn/diff/updated" ? "Turn changes" : "Work plan", item: null, complete: false, scheduled: false, status: "inProgress", startedAt: null });
    } else if (p.itemId && (/(?:\/delta|Delta)$/.test(method) || method === "item/reasoning/summaryPartAdded")) {
      const entry = this.state.entries.find((e) => e.turnId === turnId && e.id === p.itemId);
      if (entry?.item && (entry.item.type === "agentMessage" || entry.item.type === "plan")) {
        const item = reduceItemEvent(entry.item, event.data as NativeEvent);
        if (item !== entry.item && (item.type === "agentMessage" || item.type === "plan")) {
          update({ ...entry, item: { ...item, text: item.text.slice(0, HISTORY_TEXT_LIMIT) }, complete: entry.complete && item.text.length <= HISTORY_TEXT_LIMIT });
        }
      }
      if (!entry && method === "item/agentMessage/delta") {
        update(projectHistoryItem({ id: turnId, startedAt: null, status: "inProgress" }, { type: "agentMessage", id: p.itemId, text: p.delta ?? "", phase: null, memoryCitation: null, delivery: null, questions: null }));
        // Reconcile an event whose item/started fell outside the replay window.
        this.state = { ...this.state, revision: "" }; void this.refresh();
      }
      if (entry?.item?.type === "reasoning" && method.includes("summary")) {
        const reduced = reduceBotTurns([{ id: turnId, items: [entry.item], itemsView: "full", status: "inProgress", startedAt: entry.startedAt, completedAt: null, durationMs: null, error: null }], event.data as NativeEvent);
        const item = reduced[0]?.items[0];
        if (item?.type === "reasoning") update(projectHistoryItem({ id: turnId, startedAt: entry.startedAt, status: entry.turnStatus ?? "inProgress" }, { ...item, content: [] }, entry.scheduled));
      }
      if (!entry && method === "item/reasoning/summaryTextDelta") {
        // Reconnect/replay can omit item/started. Paint the available summary
        // immediately, then recover its authoritative prefix from history.
        const seed: ThreadItem = { type: "reasoning", id: p.itemId, summary: [], content: [] };
        const reduced = reduceBotTurns([{ id: turnId, items: [seed], itemsView: "full", status: "inProgress", startedAt: null, completedAt: null, durationMs: null, error: null }], event.data as NativeEvent);
        const item = reduced[0]?.items[0];
        if (item?.type === "reasoning") update(projectHistoryItem({ id: turnId, startedAt: null, status: "inProgress" }, item));
        this.state = { ...this.state, revision: "" }; this.scheduleRefresh();
      }
      // Closed tool output stays deferred; authoritative detail is fetched on demand.
    }
    const normalized = this.normalize(this.state.entries);
    this.state = { ...this.state, entries: normalized };
    this.publish({ eventCursor: event.seq }); this.scheduleWrite();
    if (method === "turn/completed" || method === "item/completed") void this.flush();
  }
  position(position: HistoryPosition) {
    const old = this.state.position;
    if (old.anchor === position.anchor && old.offset === position.offset && old.following === position.following && Boolean(old.tailContext) === Boolean(position.tailContext)) return;
    this.state = { ...this.state, position }; this.scheduleWrite();
  }
  private scheduleWrite() { this.metadataVersion++; if (!this.disposed) this.writeTimer ??= setTimeout(() => { this.writeTimer = undefined; void this.flush(); }, 250); }
  async flush(): Promise<void> {
    if (this.writeTimer) clearTimeout(this.writeTimer); this.writeTimer = undefined;
    if (this.write) { const version = this.writeVersion; await this.write; if (version < this.metadataVersion) return this.flush(); return; }
    if (!this.state.cached && !this.state.entries.length) return;
    const dirtyMap = new Map(this.dirty); this.dirty.clear();
    const retained = retainHistory(this.state.entries, this.state.position, this.state.gaps, this.state.olderCursor, CACHE_ENTRIES, CACHE_BYTES);
    const tail = retained.entries, gaps = retained.gaps;
    const attachments = retainedAttachments(tail, this.state.attachments);
    if (tail.length < this.state.entries.length) this.publish({ entries: tail, attachments, gaps, olderCursor: retained.olderCursor, complete: false });
    else if (this.state.attachments.length > attachments.length || JSON.stringify(gaps) !== JSON.stringify(this.state.gaps) || retained.olderCursor !== this.state.olderCursor) this.publish({ attachments, gaps, olderCursor: retained.olderCursor });
    const keys = new Set(tail.map((entry) => historyKey(entry.turnId, entry.id)));
    for (const entry of tail) if (!this.cachedKeys.has(historyKey(entry.turnId, entry.id))) dirtyMap.set(historyKey(entry.turnId, entry.id), entry);
    const dirty = [...dirtyMap.values()].filter((entry) => keys.has(historyKey(entry.turnId, entry.id)));
    if (this.turnAudiences.size > 384) {
      const retainedTurns = new Set(tail.map(entry => entry.turnId));
      for (const [turnId, audience] of this.turnAudiences) if (!retainedTurns.has(turnId) && !audience.active && this.turnAudiences.size > 384) this.turnAudiences.delete(turnId);
    }
    const metadata: TimelineMetadata = { owner: this.owner, botId: this.botId, order: tail.map((e) => historyKey(e.turnId, e.id)),
      turnAudiences: [...this.turnAudiences].map(([turnId, audience]) => ({ turnId, ...audience })),
      partialTurn: this.state.partialTurn, revision: this.state.revision, eventCursor: this.state.eventCursor, olderCursor: retained.olderCursor,
      attachments, contextEntries: this.state.contextEntries, gaps: gaps.filter((gap) => keys.has(gap.before)), complete: tail.length === this.state.entries.length && this.state.complete, position: this.state.position, touched: Date.now() };
    this.writeVersion = this.metadataVersion;
    this.write = this.cache.write(metadata, dirty).then(() => { this.cachedKeys = keys; }).catch((error) => {
      for (const e of dirty) if (!this.dirty.has(historyKey(e.turnId, e.id))) this.dirty.set(historyKey(e.turnId, e.id), e);
      this.publish({ error: `History is visible but its offline cache could not be updated: ${String(error)}` }, true);
    }).finally(() => { this.write = undefined; });
    return this.write;
  }
  async flushForUpdate() {
    await this.flush();
    if (this.dirty.size || this.state.error.startsWith("History is visible but its offline cache"))
      throw Error("Your conversation position could not be saved. Keep this page open and retry.");
  }
  detail(entry: HistoryEntry): Promise<ThreadItem> {
    if (entry.status === "received") return Promise.reject(Error("Peer receipt bodies use their scoped discussion reader."));
    const key = historyKey(entry.turnId, entry.id);
    if (this.transport.owner !== this.owner || this.disposed) return Promise.reject(new Error("Conversation owner changed."));
    const supplement = this.supplements.get(key);
    if (supplement) { this.detailItems.set(key, supplement); this.detailListeners.get(key)?.forEach((listener) => listener()); return Promise.resolve(supplement); }
    if (entry.complete && entry.item) {
      this.detailCursors.set(key, this.state.eventCursor); this.detailItems.set(key, entry.item);
      this.detailListeners.get(key)?.forEach((listener) => listener()); return Promise.resolve(entry.item);
    }
    const prior = this.detailRequests.get(key); if (prior) return prior;
    const timingThread = this.currentThread();
    const promise = (async () => {
      this.detailEvents.set(key, []);
      if (this.transport.owner !== this.owner || this.disposed) throw new Error("Conversation owner changed.");
      const cached = await readOpenedDetail(this.owner, this.botId, key).catch(() => null);
      if (cached?.item.type === "reasoning") cached.item = { ...cached.item, content: [] };
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
        const attachmentsAtRequest = this.state.attachments;
        const part = await this.transport.rpc<HistoryDetail>("history.detail", this.botId, { projection: "conversation", turnId: entry.turnId, itemId: entry.id, offset, version, ...(offset === 0 && cached?.version ? { knownVersion: cached.version } : {}) });
        if (this.transport.owner !== this.owner || this.disposed) throw new Error("Conversation owner changed.");
        if (part.timing && timingThread === this.currentThread() && (!part.context || part.context.threadId === timingThread)) {
          const current = this.state.entries.find(value => historyKey(value.turnId, value.id) === key);
          if (current && (current.updatedSeq ?? 0) <= (part.eventCursor ?? cursor)) {
            const next = { ...current, ...part.timing }; this.dirty.set(key, next);
            this.publish({ entries: this.state.entries.map(value => value === current ? next : value) }); this.scheduleWrite();
          }
        }
        if (part.notModified && cached) {
          this.detailCursors.set(key, part.eventCursor ?? cursor);
          // Text versions do not cover later publications or preview metadata.
          // Preserve attachment events received while this request was in flight.
          const before = new Map(attachmentsAtRequest.map((file) => [file.id, file]));
          const arrived = this.state.attachments.filter((file) => before.get(file.id) !== file);
          const attachments = mergeAttachments(mergeAttachments(mergeAttachments(cached.attachments, this.state.attachments), part.attachments ?? []), arrived);
          this.publish({ attachments }); this.scheduleWrite();
          await updateOpenedDetailAttachments(this.owner, this.botId, key, attachments, cached.version).catch(() => {});
          if (this.transport.owner !== this.owner || this.disposed) throw new Error("Conversation owner changed.");
          return cached.item;
        }
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
        if (entry.status === "received") throw Error("Peer receipt bodies use the scoped discussion reader.");
        const reduced = reduceBotTurns([{ id: entry.turnId, items: [item], itemsView: "full", status: entry.status, startedAt: entry.startedAt, completedAt: null, durationMs: null, error: null }], native);
        item = reduced[0]?.items.find((value) => value.id === entry.id) ?? item;
      }
      if (item.type === "reasoning") item = { ...item, content: [] };
      const current = this.state.entries.find((value) => historyKey(value.turnId, value.id) === key) ?? entry;
      if (current.workPlan && (current.updatedSeq ?? 0) > cursor) {
        const latest = this.supplements.get(key);
        if (!latest) throw Error('The Work plan changed while loading. Its latest bounded snapshot is retained; reopen full details.');
        item = latest; cursor = current.updatedSeq!;
      }
      this.detailItems.set(key, item); this.detailCursors.set(key, cursor);
      if (current.status !== "inProgress" && conversationItem(item.type) && item.id !== "live-turn-diff") void saveOpenedDetail(this.owner, this.botId, key, item, this.state.attachments, version!).catch(() => {});
      this.detailListeners.get(key)?.forEach((listener) => listener());
      return item;
    })().finally(() => { this.detailRequests.delete(key); this.detailEvents.delete(key); });
    this.detailRequests.set(key, promise); return promise;
  }
  async dispose() { this.disposed = true; if (this.refreshTimer) clearTimeout(this.refreshTimer); for (const timer of this.detailTimers.values()) clearTimeout(timer); this.detailTimers.clear(); await this.flush(); if (this.publishTimer) clearTimeout(this.publishTimer); this.listeners.clear(); }
}
function mergeAttachments(old: BotAttachment[], incoming: BotAttachment[]) {
  if (!incoming.length) return old;
  const map = new Map(old.map((a) => [a.id, a])); for (const item of incoming) map.set(item.id, item);
  return [...map.values()];
}
