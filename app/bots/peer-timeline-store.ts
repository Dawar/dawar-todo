import type { BotEvent, BotPeerExchangeMeta as Meta, BotPeerFeed, BotPeerRequest, BotPeerRoot, BotPeerStatus } from "../../lib/bots-types";
import type { HistoryEntry } from "../../lib/bot-history-view";

type Query = { cursor?: string; after?: string };
type Page = BotPeerFeed & { query: Query };
export type PeerBody = { request: BotPeerRequest; exchange: Meta & { text: string } };
type State = { page: Page | null; recent: Page | null; checkpoint: string | null; pendingNewer: string | null; changed: boolean; busy: boolean; error: string; revision: number };
export type PeerTransport = { owner: string; online: boolean; events: Set<(e: BotEvent) => void>;
  rpc<T>(method: string, botId: string, params: Record<string, unknown>, operationId?: string, options?: { owner: string }): Promise<T>;
  cache<T>(key: string, fallback: T): T; save(key: string, value: unknown): void };
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const sequence = (value: string) => /^\d+$/.test(value) && Number.isSafeInteger(Number(value));
export function scopedPeer(meta: Meta, botId: string) {
  return Boolean(meta && typeof meta.id === "string" && meta.id && typeof meta.requestId === "string" && meta.requestId && meta.rootId && meta.intakeAlias &&
    [meta.senderBotId, meta.recipientBotId].includes(botId) && meta.botId === meta.senderBotId && ["request", "reply", "cancel"].includes(meta.kind) && sequence(meta.arrivalSequence) &&
    Number.isFinite(Date.parse(meta.createdAt)) && Array.isArray(meta.attachmentIds) && meta.attachmentIds.every(id => typeof id === "string") &&
    Number.isSafeInteger(meta.bodyBytes) && meta.bodyBytes >= 0 && (!meta.intake || meta.intake.id === meta.intakeAlias && meta.intake.clientUserMessageId === meta.intakeAlias && meta.intake.botId === meta.recipientBotId));
}
export function peerAliases(meta: Meta) { return [meta.intakeAlias, meta.intake?.clientUserMessageId].filter((id): id is string => Boolean(id)); }
function bodyMatches(body: PeerBody, meta: Meta, botId: string) {
  return Boolean(body?.request && [body.request.senderBotId, body.request.recipientBotId].includes(botId) && body.request.id === meta.requestId && body.request.rootId === meta.rootId && scopedPeer(body.exchange, botId) && body.exchange.id === meta.id && body.exchange.requestId === meta.requestId && body.exchange.senderBotId === meta.senderBotId && body.exchange.recipientBotId === meta.recipientBotId && body.exchange.arrivalSequence === meta.arrivalSequence && body.exchange.intakeAlias === meta.intakeAlias && JSON.stringify(body.exchange.attachmentIds) === JSON.stringify(meta.attachmentIds) && typeof body.exchange.text === "string" && new TextEncoder().encode(body.exchange.text).length === body.exchange.bodyBytes && bytes(body) <= 256 * 1024);
}
/** Stable receipt identity survives native binding, sparse history and late lifecycle events. */
export function peerConversationEntries(native: HistoryEntry[], rows: Meta[]): HistoryEntry[] {
  const aliases = new Set(rows.flatMap(peerAliases));
  const result = native.filter(entry => !entry.peerAlias || !aliases.has(entry.peerAlias));
  for (const peer of rows) {
    const seconds = Date.parse(peer.createdAt) / 1000;
    const peerNativeKeys = native.filter(e => e.peerAlias && peerAliases(peer).includes(e.peerAlias)).map(e => `${e.turnId}:${e.id}`);
    const entry: HistoryEntry = { id: peer.id, turnId: "peer-arrivals", type: "userMessage", label: "Bot message", peer, peerNativeKeys, item: null, complete: true, scheduled: false, status: "received", startedAt: seconds, messageAt: seconds, timeBasis: "received", audience: "conversation" };
    // Preserve native order. Only derived receipts are placed by arrival time;
    // receipt acceptance order breaks ties between peer rows, never round/prose.
    const index = result.findIndex(e => (e.messageAt ?? e.startedAt ?? Infinity) > seconds || e.peer && e.messageAt === seconds && Number(e.peer.arrivalSequence) > Number(peer.arrivalSequence));
    result.splice(index < 0 ? result.length : index, 0, entry);
  }
  return result;
}

/** A bounded, navigable peer page plus recent arrivals. No whole-history read.
 * Historical pages are replaced only by deliberate navigation; live refreshes
 * keep the reading page. Bodies have their own small LRU, never feed metadata. */
export class PeerTimelineStore {
  private state: State = { page: null, recent: null, checkpoint: null, pendingNewer: null, changed: false, busy: false, error: "", revision: 0 };
  private listeners = new Set<() => void>();
  private alive = false;
  private bodies = new Map<string, PeerBody>();
  private requests = new Map<string, BotPeerRequest>();
  private reads = new Map<string, Promise<PeerBody>>();
  private trail: Query[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private epoch = 0;
  private eventSequence = 0;
  private liveRows = new Map<string, { seq: number; meta: Meta }>();
  private bodyCount = 0;
  private bodyQueue: (() => void)[] = [];
  private key: string;
  constructor(readonly owner: string, readonly botId: string, private client: PeerTransport, readonly enabled = true) {
    this.key = `peer-timeline:v1:${botId}`;
    if (client.owner !== owner) return;
    const saved = client.cache<Partial<State>>(this.key, {});
    try {
      if (saved.page) this.verify(saved.page, saved.page.query);
      if (saved.recent) this.verify(saved.recent, saved.recent.query);
      if (saved.checkpoint && !sequence(saved.checkpoint) || saved.pendingNewer && (typeof saved.pendingNewer !== "string" || saved.pendingNewer.length > 512)) throw Error();
      this.state = { ...this.state, page: saved.page ?? null, recent: saved.recent ?? null, checkpoint: saved.checkpoint ?? null, pendingNewer: saved.pendingNewer ?? null };
      const bodies = client.cache<PeerBody[]>(`${this.key}:bodies`, []);
      if (Array.isArray(bodies) && bodies.length <= 4 && bytes(bodies) <= 256 * 1024) for (const body of bodies) if (body?.exchange && bodyMatches(body,body.exchange,botId)) this.bodies.set(body.exchange.id, body);
    } catch { this.state.error = "Saved bot-message metadata needs a bounded refresh. Original discussions are retained."; }
  }
  getSnapshot = () => this.state;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    if (!this.alive) { this.alive = true; this.epoch++; this.client.events.add(this.event); }
    return () => { this.listeners.delete(fn); if (!this.listeners.size) { this.alive = false; this.epoch++; this.client.events.delete(this.event); if (this.timer) clearTimeout(this.timer); this.timer = null; } };
  };
  private valid(epoch = this.epoch) { return this.alive && epoch === this.epoch && this.client.owner === this.owner; }
  private publish(value: Partial<State>) {
    this.state = { ...this.state, ...value, revision: this.state.revision + 1 };
    for (const fn of this.listeners) fn();
    if (this.valid()) this.client.save(this.key, { page: this.state.page, recent: this.state.recent, checkpoint: this.state.checkpoint, pendingNewer: this.state.pendingNewer });
  }
  private verify(page: BotPeerFeed, query: Query) {
    if (!page || !Array.isArray(page.exchanges) || page.exchanges.length > 12 || page.exchanges.some(e => !scopedPeer(e, this.botId)) || page.pageLimit !== 12 || !sequence(page.highWater) || !["older", "newer"].includes(page.direction) || typeof page.complete !== "boolean" || Boolean(page.nextCursor) === page.complete || page.nextCursor === query.cursor || page.nextCursor && page.nextCursor.length > 512 || bytes(page) > 256 * 1024) throw Error("Bot-message page could not be verified. Its original receipts are retained.");
    const ids = new Set<string>(); let previous = -1;
    for (const e of page.exchanges) { if (ids.has(e.id) || Number(e.arrivalSequence) <= previous || Number(e.arrivalSequence) > Number(page.highWater)) throw Error("Bot-message arrival order could not be verified."); ids.add(e.id); previous = Number(e.arrivalSequence); }
  }
  private async read(query: Query): Promise<Page> {
    const before = this.eventSequence;
    const page = await this.client.rpc<BotPeerFeed>("peers.feed", this.botId, { ...query, limit: 12 }, undefined, { owner: this.owner });
    this.verify(page, query);
    return { ...page, query, exchanges: page.exchanges.map(e => { const live = this.liveRows.get(e.id); return live && live.seq > before ? live.meta : e; }) };
  }
  rows(state = this.state) {
    const rows = new Map<string, Meta>();
    for (const e of [...(state.page?.exchanges ?? []), ...(state.recent?.exchanges ?? [])]) rows.set(e.id, e);
    return [...rows.values()].sort((a, b) => Number(a.arrivalSequence) - Number(b.arrivalSequence));
  }
  private event = (event: BotEvent) => {
    if (!this.enabled || !this.valid()) return;
    if (event.type === "peer-root") {
      const root = (event.data as { root?: BotPeerRoot }).root;
      if (!root || root.version !== 1 || root.nativeInterruption !== false || !this.rows().some(e => e.rootId === root.id)) return;
      if (!Number.isSafeInteger(event.seq) || event.seq <= this.eventSequence) return;
      this.eventSequence = event.seq;
      const update = (page: Page | null) => page && ({ ...page, exchanges: page.exchanges.map(meta => {
        if (meta.rootId !== root.id || meta.intake?.state !== "queued") return meta;
        const next = { ...meta, intake: { ...meta.intake, waitReason: root.state === "active" ? null : root.reasonText } };
        this.liveRows.set(meta.id, { seq: event.seq, meta: next }); return next;
      }) });
      this.publish({ page: update(this.state.page), recent: update(this.state.recent), changed: true });
      if (!this.timer) this.timer = setTimeout(() => { this.timer = null; void this.refresh(); }, 100);
      return;
    }
    if (event.type !== "peer" || event.botId !== this.botId) return;
    if (!Number.isSafeInteger(event.seq) || event.seq <= this.eventSequence) return;
    this.eventSequence = event.seq;
    const data = event.data as { exchange?: Meta; invalidateRequestId?: string; request?: BotPeerRequest };
    if (data.request && [data.request.senderBotId,data.request.recipientBotId].includes(this.botId)) { this.requests.set(data.request.id,data.request); while(this.requests.size > 24) this.requests.delete(this.requests.keys().next().value!); }
    if (data.exchange && scopedPeer(data.exchange, this.botId)) {
      const exchange = data.exchange;
      this.liveRows.set(exchange.id, { seq: event.seq, meta: exchange });
      while (this.liveRows.size > 24) this.liveRows.delete(this.liveRows.keys().next().value!);
      const replace = (page: Page | null) => page && ({ ...page, exchanges: page.exchanges.map(e => e.id === exchange.id ? exchange : e) });
      this.publish({ page: replace(this.state.page), recent: replace(this.state.recent), changed: true });
      if (this.state.recent) {
        const rows = new Map(this.state.recent.exchanges.map(e => [e.id, e])); rows.set(exchange.id, exchange);
        this.publish({ recent: { ...this.state.recent, highWater: String(Math.max(Number(this.state.recent.highWater), Number(exchange.arrivalSequence))), exchanges: [...rows.values()].sort((a,b) => Number(a.arrivalSequence)-Number(b.arrivalSequence)).slice(-12) } });
      }
    } else this.publish({ changed: true });
    // One metadata request for a burst of lifecycle invalidations, no body sweep.
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; void this.refresh(); }, 100);
  };
  async refresh(resetPresence = false) {
    if (!this.enabled || !this.valid() || !this.client.online || this.state.busy) return;
    const epoch = this.epoch; this.publish({ busy: true });
    if (resetPresence) this.requests.clear();
    const before = this.eventSequence;
    try {
      const next = await this.read(this.state.pendingNewer ? { cursor: this.state.pendingNewer } : this.state.checkpoint ? { after: this.state.checkpoint } : {});
      if (!this.valid(epoch)) return;
      // A partial newer traversal retains its original checkpoint and cursor.
      // Never turn a page's absence into deletion of cached/live rows.
      const recent = next.direction === "older" && !this.state.checkpoint ? next : await this.read({});
      if (!this.valid(epoch)) return;
      const status = await this.client.rpc<BotPeerStatus>("peers.status",this.botId,{limit:12},undefined,{owner:this.owner});
      if (!this.valid(epoch)) return;
      if (!Array.isArray(status.requests) || status.requests.length > 12 || status.requests.some(r => ![r.senderBotId,r.recipientBotId].includes(this.botId))) throw Error("Discussion presence could not be verified.");
      if (before === this.eventSequence) for (const r of status.requests) this.requests.set(r.id,r);
      while(this.requests.size > 24) this.requests.delete(this.requests.keys().next().value!);
      const latest = new Map(recent.exchanges.map(e => [e.id, e]));
      this.publish({ page: this.state.page ? { ...this.state.page, exchanges: this.state.page.exchanges.map(e => latest.get(e.id) ?? e) } : recent, recent, checkpoint: next.direction === "older" || next.complete ? next.highWater : this.state.checkpoint, pendingNewer: next.direction === "newer" && !next.complete ? next.nextCursor : null, changed: before !== this.eventSequence || !next.complete && next.direction === "newer", error: "" });
    } catch (reason) { if (this.valid(epoch)) this.publish({ error: reason instanceof Error ? reason.message : "Reconnect to read bot messages." }); }
    finally { if (this.valid(epoch)) this.publish({ busy: false }); }
  }
  async navigate(direction: "older" | "newer" | "recent") {
    if (!this.valid() || !this.client.online || this.state.busy) return;
    const epoch = this.epoch, previous = this.state.page;
    let query: Query;
    if (direction === "recent") query = {};
    else if (direction === "older" && previous?.direction === "older") { if (!previous.nextCursor) return; query = { cursor: previous.nextCursor }; }
    else if (direction === "older" && this.trail.length) query = this.trail.pop()!;
    else if (direction === "newer" && previous?.exchanges.length) query = { after: previous.exchanges.at(-1)!.arrivalSequence };
    else return;
    this.publish({ busy: true });
    try {
      const page = await this.read(query); if (!this.valid(epoch)) return;
      if (direction === "newer" && !page.exchanges.length) return;
      if (direction === "newer" && previous) this.trail = [...this.trail.slice(-63), previous.query]; else if (direction === "recent") this.trail = [];
      this.publish({ page, ...(direction === "recent" ? { recent: page, checkpoint: page.highWater, pendingNewer: null, changed: false } : {}), error: "" });
    } catch (reason) { if (this.valid(epoch)) this.publish({ error: String(reason) }); }
    finally { if (this.valid(epoch)) this.publish({ busy: false }); }
  }
  canOlder() { return Boolean(this.state.page?.direction === "older" ? this.state.page.nextCursor : this.trail.length); }
  canNewer() { return Boolean(this.state.page?.exchanges.length && this.state.recent?.exchanges.length && Number(this.state.page.exchanges.at(-1)!.arrivalSequence) < Number(this.state.recent.exchanges.at(-1)!.arrivalSequence)); }
  body(meta: Meta) { const body = this.bodies.get(meta.id); return body && bodyMatches(body,meta,this.botId) ? body : null; }
  request(id: string) { return this.requests.get(id) ?? null; }
  async loadBody(meta: Meta) {
    if (!this.valid() || !this.client.online || !scopedPeer(meta, this.botId)) throw Error("Reconnect as this message's owner to read it.");
    const cached = this.bodies.get(meta.id); if (cached && bodyMatches(cached,meta,this.botId)) return cached;
    const running = this.reads.get(meta.id); if (running) return running;
    const epoch = this.epoch, before = this.eventSequence;
    const read = (async () => {
      if (this.bodyCount >= 4) await new Promise<void>(resolve => this.bodyQueue.push(resolve)); else this.bodyCount++;
      try {
        if (!this.valid(epoch)) throw Error("Bot-message view changed.");
        return await this.client.rpc<PeerBody>("peers.exchange", this.botId, { id: meta.id }, undefined, { owner: this.owner });
      } finally { const next = this.bodyQueue.shift(); if (next) next(); else this.bodyCount--; }
    })().then(body => {
      if (!this.valid(epoch)) throw Error("Bot-message view changed; the late read was discarded.");
      if (!bodyMatches(body,meta,this.botId)) throw Error("This bot-message body could not be verified. Retry its original receipt.");
      if (before === this.eventSequence) this.requests.set(body.request.id,body.request); while(this.requests.size > 24) this.requests.delete(this.requests.keys().next().value!);
      this.bodies.set(meta.id, body);
      while (this.bodies.size > 16 || [...this.bodies.values()].reduce((n, v) => n + bytes(v), 0) > 512 * 1024) this.bodies.delete(this.bodies.keys().next().value!);
      const saved: PeerBody[] = []; let used = 0;
      for (const value of [...this.bodies.values()].reverse()) { const n = bytes(value); if (saved.length < 4 && used + n <= 256 * 1024) { saved.push(value); used += n; } }
      this.client.save(`${this.key}:bodies`, saved); this.publish({}); return body;
    }).finally(() => this.reads.delete(meta.id));
    this.reads.set(meta.id, read); return read;
  }
}
