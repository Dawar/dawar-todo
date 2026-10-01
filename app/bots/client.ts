import { readBotHistory, queueBotHistory, type CachedBotHistory } from "./history-cache.ts";
import { cloudStatus, cloudUpload, cloudDownload, CloudStorageError } from "./cloud-storage";
import { botFailureOutcome } from "../../lib/bots-response.ts";
import { validRunState } from "./run-context";
import type { BotOperations, BotSnapshot, WorkState } from "./single-thread-contract";
import type {
  BotEvent,
  BridgeRequest,
  BotAttachment,
  BotScheduledEventData,
  BotRunStateEvent,
} from "../../lib/bots-types";

export class BotRpcError extends Error {
  readonly outcome: "not-sent" | "rejected" | "uncertain";
  constructor(message: string, outcome: "not-sent" | "rejected" | "uncertain") { super(message); this.outcome = outcome; }
}

type Pending = {
  owner: string;
  managed: boolean;
  request: BridgeRequest;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  chunks?: Uint8Array;
  received?: number;
};
type Session = {
  ticket: string;
  url: string;
  machineId: string;
  timeZone: string;
  owner: string;
};
function validComposerResult(method: string, result: Record<string, unknown> | undefined) {
  const identified = (value: unknown) => Boolean(value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string");
  if (method === "bursts.submit") return Boolean(result && identified(result.message) && identified(result.burst));
  if (method === "turn.send") return Boolean(result && (identified(result.turn) || typeof result.turnId === "string"));
  if (method === "queue.add") return Boolean(result && (identified(result.queuedSubmission) || typeof result.consumedTurnId === "string"));
  if (method === "queue.update") return Boolean(result && identified(result.queuedSubmission));
  return true;
}
function snapshotEventKey(event: BotEvent) {
  if (event.type === "work" && event.botId) return `work:${event.botId}`;
  if (event.type === "run.state" && event.botId) return `run:${event.botId}:${(event.data as BotRunStateEvent).runId}`;
  if (event.type === "run.request" || event.type === "run.request.resolved") return `request:${(event.data as { key: string }).key}`;
  if (event.type === "schedules" && event.botId && Object.hasOwn(event.data as object, "activeScheduledTurn")) return `scheduled:${event.botId}`;
  if (event.type === "teams") return "teams";
  if (event.type === "bot") return `bot:${(event.data as BotSnapshot["bots"][number]).id}`;
  if (event.type === "request" || event.type === "request.resolved")
    return `request:${(event.data as { key: string }).key}`;
  return null;
}
function applySnapshotEvent(snapshot: BotSnapshot, event: BotEvent, key?: string): BotSnapshot {
  if (event.type === "teams") {
    const teams = (event.data as { teams?: BotSnapshot["teams"] }).teams;
    return Array.isArray(teams) ? { ...snapshot, teams } : snapshot;
  }
  if (event.type === "work" && event.botId) {
    const work = event.data as WorkState;
    if (work.botId !== event.botId) return snapshot;
    return { ...snapshot, workByBot: [...(snapshot.workByBot ?? []).filter(value => value.botId !== event.botId), work] };
  }
  if (event.type === "run.state" && event.botId && snapshot.capabilities?.backgroundRunLanes === 1) {
    const data = event.data as BotRunStateEvent;
    if (!validRunState(data, event.botId)) return snapshot;
    if (key?.startsWith("background:")) return { ...snapshot, backgroundByBot: [...(snapshot.backgroundByBot ?? []).filter(value => value.botId !== event.botId), { ...data.background, botId: event.botId }] };
    return { ...snapshot, runs: [data.run, ...snapshot.runs.filter(run => run.id !== data.runId)].slice(0, 100),
      // Keep an older unfinished run's snapshot row current too. This patch
      // uses the same per-run event/snapshot sequence fence as recent runs.
      ...(snapshot.backgroundRuns ? { backgroundRuns: snapshot.backgroundRuns.map(run => run.id === data.runId && run.botId === event.botId ? data.run : run) } : {}) };
  }
  if (event.type === "schedules" && event.botId && Object.hasOwn(event.data as object, "activeScheduledTurn")) {
    const active = (event.data as BotScheduledEventData).activeScheduledTurn;
    if (active !== null && (!active || active.botId !== event.botId || !active.turnId || !active.runId)) return snapshot;
    return { ...snapshot, activeScheduledTurns: [...(snapshot.activeScheduledTurns ?? []).filter(turn => turn.botId !== event.botId), ...(active ? [active] : [])] };
  }
  if (event.type === "bot") {
    const deleted = event.data as BotSnapshot["bots"][number];
    if (deleted.deletedAt) return { ...snapshot, bots: snapshot.bots.filter(bot => bot.id !== deleted.id) };
    const bot = event.data as BotSnapshot["bots"][number];
    return { ...snapshot, bots: [...snapshot.bots.filter(item => item.id !== bot.id), bot]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) };
  }
  if (event.type === "request" || event.type === "run.request") {
    const request = event.data as BotSnapshot["pending"][number];
    return { ...snapshot, pending: [...snapshot.pending.filter(item => item.key !== request.key), request] };
  }
  if (event.type === "request.resolved" || event.type === "run.request.resolved")
    return { ...snapshot, pending: snapshot.pending.filter(item => item.key !== (event.data as { key: string }).key) };
  return snapshot;
}
export class BotsClient {
  relayClientId: string | null = null;
  socket: WebSocket | null = null;
  snapshot: BotSnapshot | null = null;
  eventChunks = new Map<number, { bytes: Uint8Array; received: number }>();
  online = false;
  storageAvailable = false;
  storageCatalogAvailable = false;
  error = "";
  timeZone = "UTC";
  owner = "";
  started = false;
  stopped = false;
  listeners = new Set<() => void>();
  events = new Set<(event: BotEvent) => void>();
  pending = new Map<string, Pending>();
  retry = 0;
  reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  renewTimer: ReturnType<typeof setTimeout> | null = null;
  heartbeat: ReturnType<typeof setInterval> | null = null;
  subscribe = (callback: () => void) => {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  };
  notify() {
    for (const listener of this.listeners) listener();
  }
  private snapshotTimer?: ReturnType<typeof setTimeout>;
  private flushSnapshot() {
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer); this.snapshotTimer = undefined;
    if (this.snapshot && this.owner) this.save("snapshot", { ...this.snapshot, pending: [] });
  }
  private histories = new Map<string, unknown>();
  private connectionEpoch = 0;
  // A cache or an isolated event is not proof that all earlier events arrived.
  // Only a full server snapshot advances this watermark. Keep the latest patch
  // per entity so a full snapshot can heal gaps without undoing newer events.
  private fullSnapshotCursor = -1;
  private latestSnapshotEvent = 0;
  private snapshotPatches = new Map<string, BotEvent>();
  private authChannel?: BroadcastChannel;
  private authListeners = false;
  cacheKey(key: string) {
    return `dawar-bots:${this.owner}:${key}`;
  }
  cache<T>(key: string, fallback: T): T {
    if (key.startsWith("history:")) return (this.histories.get(this.cacheKey(key)) as T) ?? fallback;
    try {
      return (
        JSON.parse(localStorage.getItem(this.cacheKey(key)) ?? "null") ??
        fallback
      );
    } catch {
      return fallback;
    }
  }
  save(key: string, value: unknown) {
    if (key.startsWith("history:")) {
      this.histories.set(this.cacheKey(key), value);
      queueBotHistory(this.owner, key.slice("history:".length), value as CachedBotHistory);
      if (this.histories.size > 4) this.histories.delete(this.histories.keys().next().value!);
      return;
    }
    try {
      localStorage.setItem(this.cacheKey(key), JSON.stringify(value));
    } catch {
      /* caches must never prevent work */
    }
  }
  async cachedHistory(botId: string) {
    return this.cache<CachedBotHistory | null>(`history:${botId}`, null) ?? readBotHistory(this.owner, botId);
  }
  private detachOwner() {
    this.flushSnapshot();
    this.connectionEpoch++;
    this.relayClientId = null;
    this.online = false;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.renewTimer) clearTimeout(this.renewTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.eventChunks.clear();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new BotRpcError("The signed-in owner changed. The submitted operation is retained for its original owner.", "uncertain"));
    }
    this.pending.clear();
    this.snapshot = null;
    this.fullSnapshotCursor = -1;
    this.latestSnapshotEvent = 0;
    this.snapshotPatches.clear();
    this.histories.clear();
    this.owner = "";
    this.storageAvailable = false;
    this.storageCatalogAvailable = false;
  }
  clearOwnerCache(broadcast = true) {
    // Revoke access, not data. Drafts/bytes and legacy originals remain owned.
    this.detachOwner();
    this.stopped = true;
    try { localStorage.removeItem("dawar-bots:last-owner"); } catch {}
    if (broadcast) this.authChannel?.postMessage("revoked");
    this.notify();
  }
  private useOwner(owner: string) {
    if (this.owner !== owner) this.detachOwner();
    this.owner = owner;
    this.snapshot ??= this.cache<BotSnapshot | null>("snapshot", null);
    void this.refreshStorage(owner);
  }
  private async refreshStorage(owner:string) {
    try {
      const status=await cloudStatus(owner,()=>this.owner);
      if (this.owner!==owner) return;
      this.storageAvailable=status.enabled; this.storageCatalogAvailable=status.catalogReady; this.notify();
    } catch { if (this.owner===owner) { this.storageAvailable=false; this.storageCatalogAvailable=false; this.notify(); } }
  }
  async session(): Promise<Session> {
    const epoch = this.connectionEpoch;
    const registration =
      "serviceWorker" in navigator
        ? await navigator.serviceWorker.getRegistration()
        : null;
    const push = await registration?.pushManager
      ?.getSubscription()
      .catch(() => null);
    const response = await fetch("/api/bots/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ push: push?.toJSON() }),
      credentials: "same-origin",
      cache: "no-store",
    });
    if ((response.status === 401 || response.status === 403) && epoch === this.connectionEpoch)
      this.clearOwnerCache();
    const body = (await response.json().catch(() => ({}))) as Session & { error?: string };
    if (!response.ok) {
      throw new Error(body.error ?? "Bots could not connect.");
    }
    return body;
  }
  start() {
    if (this.started && !this.stopped) return;
    this.started = true;
    this.stopped = false;
    // An established local owner opens cached-first, including offline restart.
    // Explicit sign-out/auth denial revokes this permission without deleting data.
    if (!this.authChannel && typeof BroadcastChannel !== "undefined") {
      this.authChannel = new BroadcastChannel("dawar-bots-auth");
      this.authChannel.onmessage = () => this.clearOwnerCache(false);
    }
    if (!this.authListeners && typeof document !== "undefined") {
      this.authListeners = true;
      window.addEventListener("pagehide", () => this.flushSnapshot());
      document.addEventListener("visibilitychange", () => { if (document.hidden) this.flushSnapshot(); });
      document.addEventListener("click", (event) => {
        const target = event.target;
        if (target instanceof Element && target.closest('a[href^="/signout-with-chatgpt"]')) this.clearOwnerCache();
      }, { capture: true });
      window.addEventListener("storage", (event) => {
        if (event.key !== "dawar-bots:last-owner") return;
        if (!event.newValue) this.clearOwnerCache(false);
        else if (event.newValue !== this.owner) {
          this.detachOwner(); this.notify(); void this.connect();
        }
      });
    }
    try {
      const owner = localStorage.getItem("dawar-bots:last-owner");
      if (owner) this.useOwner(owner);
    } catch {}
    this.notify();
    void this.connect();
  }
  async connect() {
    if (this.stopped) return;
    const epoch = this.connectionEpoch;
    try {
      const session = await this.session();
      if (this.stopped || epoch !== this.connectionEpoch) return;
      this.useOwner(session.owner);
      this.timeZone = session.timeZone;
      try { localStorage.setItem("dawar-bots:last-owner", this.owner); } catch {}
      if (!this.snapshot)
        this.snapshot = this.cache<BotSnapshot | null>("snapshot", null);
      const url = new URL(session.url);
      url.searchParams.set("machine", session.machineId);
      const socket = new WebSocket(url);
      this.socket = socket;
      socket.onopen = () => {
        if (this.socket === socket) socket.send(JSON.stringify({ type: "auth", ticket: session.ticket }));
      };
      socket.onmessage = ({ data }) => {
        if (this.socket !== socket || this.owner !== session.owner || data === "pong") return;
        try {
          this.receive(JSON.parse(data));
        } catch {
          this.error = "The connection returned an invalid response.";
          this.notify();
        }
      };
      socket.onerror = () => {};
      socket.onclose = () => {
        if (this.socket !== socket) return;
        this.online = false;
        this.eventChunks.clear();
        for (const p of this.pending.values()) {
          p.chunks = undefined;
          p.received = undefined;
        }
        this.notify();
        this.scheduleReconnect();
      };
      this.notify();
    } catch (e) {
      if (!this.stopped && epoch === this.connectionEpoch && e instanceof TypeError && !this.owner) {
        try { const owner = localStorage.getItem("dawar-bots:last-owner"); if (owner) this.useOwner(owner); } catch {}
      }
      this.error = e instanceof Error ? e.message : "Connection failed.";
      this.notify();
      this.scheduleReconnect();
    }
  }
  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    if (this.renewTimer) clearTimeout(this.renewTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.reconnectTimer = setTimeout(
      () => {
        this.reconnectTimer = null;
        void this.connect();
      },
      Math.min(30000, 1000 * 2 ** Math.min(this.retry++, 5)),
    );
  }
  receive(message: Record<string, unknown>) {
    if (message.type === "eventChunk") {
      const seq = Number(message.seq),
        total = Number(message.total),
        offset = Number(message.offset);
      if (!Number.isSafeInteger(total) || total > 32 * 1024 * 1024 || total < 0)
        throw new Error("Invalid event transfer.");
      let chunk = this.eventChunks.get(seq);
      if (!chunk) {
        if (offset !== 0 || this.eventChunks.size > 4)
          throw new Error("Invalid event offset.");
        chunk = { bytes: new Uint8Array(total), received: 0 };
        this.eventChunks.set(seq, chunk);
      }
      if (offset !== chunk.received) throw new Error("Invalid event order.");
      const bytes = Uint8Array.from(atob(String(message.data)), (c) =>
        c.charCodeAt(0),
      );
      chunk.bytes.set(bytes, offset);
      chunk.received += bytes.length;
      if (chunk.received === total) {
        this.eventChunks.delete(seq);
        this.receive({
          type: "event",
          event: JSON.parse(new TextDecoder().decode(chunk.bytes)),
        });
      }
      return;
    }
    if (message.type === "authenticated") {
      this.relayClientId = typeof message.clientId === "string" ? message.clientId : null;
      this.online = Boolean(message.online);
      this.error = "";
      this.retry = 0;
      if (this.renewTimer) clearTimeout(this.renewTimer);
      const renewingSocket = this.socket;
      const renewingEpoch = this.connectionEpoch;
      this.renewTimer = setTimeout(
        () =>
          void this.session()
            .then((s) => {
              if (this.socket !== renewingSocket || this.connectionEpoch !== renewingEpoch) return;
              if (s.owner !== this.owner) { this.detachOwner(); void this.connect(); return; }
              this.socket?.send(JSON.stringify({ type: "auth", ticket: s.ticket }));
            })
            .catch((e) => {
              if (this.socket !== renewingSocket || this.connectionEpoch !== renewingEpoch) return;
              this.error = e.message;
              this.socket?.close();
              this.notify();
            }),
        12 * 60 * 1000,
      );
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => {
        if (this.socket?.readyState === WebSocket.OPEN)
          this.socket.send("ping");
      }, 25000);
      const refreshedOwner = this.owner;
      if (this.online)
        void this.refresh()
          .then(() => { if (this.owner === refreshedOwner) this.replayPending(); })
          .catch((e) => {
            this.error = e.message;
            this.notify();
          });
      this.notify();
      return;
    }
    if (message.type === "presence") {
      this.online = Boolean(message.online);
      const refreshedOwner = this.owner;
      if (this.online)
        void this.refresh()
          .then(() => { if (this.owner === refreshedOwner) this.replayPending(); })
          .catch(() => {});
      this.notify();
      return;
    }
    if (message.type === "error") {
      this.error = String(message.error);
      this.notify();
      return;
    }
    if (message.type === "response") {
      const pending = this.pending.get(String(message.id));
      if (!pending || pending.owner !== this.owner) return;
      let result = message.result as Record<string, unknown>;
      if (result?.__chunk) {
        const total = Number(result.total),
          offset = Number(result.offset);
        if (
          !Number.isSafeInteger(total) ||
          total > 32 * 1024 * 1024 ||
          offset !== (pending.received ?? 0)
        ) {
          clearTimeout(pending.timer);
          pending.reject(new BotRpcError("Invalid response transfer. Acknowledgement is unconfirmed.", "uncertain"));
          this.pending.delete(String(message.id));
          return;
        }
        pending.chunks ??= new Uint8Array(total);
        const bytes = Uint8Array.from(atob(String(result.data)), (c) =>
          c.charCodeAt(0),
        );
        pending.chunks.set(bytes, offset);
        pending.received = offset + bytes.length;
        if (pending.received < total) return;
        result = JSON.parse(new TextDecoder().decode(pending.chunks));
      }
      clearTimeout(pending.timer);
      this.pending.delete(String(message.id));
      // An uncertain native mutation may have succeeded. Keep its stable ID
      // for reconciliation on reconnect instead of creating a second request.
      // Error text is not evidence that a native mutation failed. Old bridges,
      // relay failures and unknown parser/service errors must retain the ID.
      const uncertain = botFailureOutcome(message, result, pending.request.operationId) !== "rejected";
      if (!pending.managed && (!message.error || !uncertain)) this.forgetOperation(pending.request.operationId);
      if (message.error) pending.reject(new BotRpcError(String(message.error), uncertain ? "uncertain" : "rejected"));
      else if (pending.managed && !validComposerResult(pending.request.method, result))
        pending.reject(new BotRpcError("The response did not confirm the submitted message. Check the same send again.", "uncertain"));
      else pending.resolve(result);
      return;
    }
    if (message.type === "event") {
      const event = message.event as BotEvent;
      this.latestSnapshotEvent = Math.max(this.latestSnapshotEvent, event.seq);
      const keys = [snapshotEventKey(event), ...(event.type === "run.state" && event.botId ? [`background:${event.botId}`] : [])];
      for (const key of keys) if (key && event.seq > this.fullSnapshotCursor && event.seq > (this.snapshotPatches.get(key)?.seq ?? -1)) {
        this.snapshotPatches.set(key, event);
        if (this.snapshot) this.snapshot = applySnapshotEvent(this.snapshot, event, key);
      }
      // Keep run metadata bounded; counts have their own per-bot sequence fence.
      if (event.type === "run.state") {
        const runPatches = [...this.snapshotPatches].filter(([key]) => key.startsWith("run:")).sort((a, b) => b[1].seq - a[1].seq);
        for (const [key] of runPatches.slice(100)) this.snapshotPatches.delete(key);
      }
      if (this.snapshot) {
        this.snapshot = { ...this.snapshot, cursor: Math.max(this.snapshot.cursor, event.seq) };
        // Pending requests may contain secrets; only cache the visible bot list.
        this.snapshotTimer ??= setTimeout(() => this.flushSnapshot(), 1000);
      }
      if (event.type === "runtime" && (event.data as { ready: boolean }).ready)
        void this.refresh().catch(() => {});
      if (event.type === "schedules") void this.refresh().catch(() => {});
      for (const listener of this.events) listener(event);
      if (event.type !== "codex" && event.type !== "run.codex") this.notify();
    }
  }
  rememberOperation(request: BridgeRequest) {
    if (!["turn.send", "bots.create", "queue.add"].includes(request.method)) return;
    const ops = this.cache<Record<string, BridgeRequest>>("operations", {});
    ops[request.operationId] = request;
    // A mutation must not leave the browser before its identity is saved.
    localStorage.setItem(this.cacheKey("operations"), JSON.stringify(ops));
  }
  forgetOperation(id: string) {
    const ops = this.cache<Record<string, BridgeRequest>>("operations", {});
    if (ops[id]) {
      delete ops[id];
      this.save("operations", ops);
    }
  }
  replayPending() {
    for (const pending of this.pending.values())
      if (pending.owner === this.owner && !["snapshot", "history"].includes(pending.request.method))
        this.socket?.send(JSON.stringify(pending.request));
    for (const request of Object.values(
      this.cache<Record<string, BridgeRequest>>("operations", {}),
    )) {
      // Composer sends are migrated and reconciled by the durable controller.
      if (["turn.send", "queue.add", "queue.update"].includes(request.method)) continue;
      if (
        [...this.pending.values()].some(
          (p) => p.request.operationId === request.operationId,
        )
      )
        continue;
      void this.rpc(
        request.method as keyof BotOperations,
        request.botId,
        request.params,
        request.operationId,
      )
        .then(() => this.refresh())
        .catch((e) => {
          this.error = e.message;
          this.notify();
        });
    }
  }
  async refresh() {
    const owner = this.owner;
    const epoch = this.connectionEpoch;
    const snapshot = await this.rpc<BotSnapshot>("snapshot");
    if (this.owner !== owner || this.connectionEpoch !== epoch)
      throw new BotRpcError("The signed-in owner changed.", "not-sent");
    if (this.snapshot && snapshot.cursor < this.fullSnapshotCursor)
      return this.snapshot;
    this.fullSnapshotCursor = snapshot.cursor;
    let merged = snapshot;
    for (const [key, event] of [...this.snapshotPatches].sort((a, b) => a[1].seq - b[1].seq)) {
      if (event.seq <= snapshot.cursor) this.snapshotPatches.delete(key);
      else merged = applySnapshotEvent(merged, event, key);
    }
    this.snapshot = { ...merged, cursor: Math.max(snapshot.cursor, this.latestSnapshotEvent) };
    this.online = snapshot.ready;
    if (this.online)
      void this.rpc(
        "settings.timeZone",
        undefined,
        { timeZone: this.timeZone },
        `timezone:${this.timeZone}:${new Date().toISOString().slice(0, 13)}`,
      ).catch(() => {});
    this.save("snapshot", { ...this.snapshot, pending: [] });
    this.notify();
    return this.snapshot;
  }
  rpc<T = unknown>(
    method: keyof BotOperations,
    botId?: string,
    params: Record<string, unknown> = {},
    operationId = crypto.randomUUID(),
    options: { owner?: string; managed?: boolean } = {},
  ): Promise<T> {
    if (options.owner && options.owner !== this.owner) return Promise.reject(new BotRpcError("The signed-in owner changed.", "not-sent"));
    if (!this.online || this.socket?.readyState !== WebSocket.OPEN)
      return Promise.reject(
        new BotRpcError("The VM is offline. Your draft has been kept.", "not-sent"),
      );
    const id = crypto.randomUUID();
    const request: BridgeRequest = {
      type: "request",
      id,
      operationId,
      method,
      botId,
      params,
    };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new BotRpcError(
            "Still waiting for acknowledgement. Check again to reconcile the same send.", "uncertain",
          ),
        );
      }, 125000);
      this.pending.set(id, {
        request, owner: this.owner, managed: options.managed ?? false,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      try {
        if (!options.managed) this.rememberOperation(request);
        this.socket!.send(JSON.stringify(request));
      } catch {
        clearTimeout(timer); this.pending.delete(id);
        reject(new BotRpcError("The request could not be dispatched. Its draft is retained.", "uncertain"));
      }
    });
  }
  async upload(botId: string, file: File, onProgress: (value: number) => void, uploadId = crypto.randomUUID(), owner = this.owner,mode?:"cloud"|"legacy") {
    if (mode === "cloud" || mode !== "legacy" && (await cloudStatus(owner,()=>this.owner)).enabled) return cloudUpload(owner,()=>this.owner,botId,file,uploadId,onProgress);
    const options = { owner, managed: true };
    const a = await this.rpc<BotAttachment>("attachments.begin", botId, {
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      size: file.size,
    }, uploadId, options);
    for (let offset = 0; offset < file.size; offset += 256 * 1024) {
      const bytes = new Uint8Array(
        await file.slice(offset, offset + 256 * 1024).arrayBuffer(),
      );
      let binary = "";
      for (let i = 0; i < bytes.length; i += 8192)
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      await this.rpc("attachments.chunk", botId, {
        id: a.id,
        offset,
        data: btoa(binary),
      }, `${uploadId}:chunk:${offset}`, options);
      onProgress(
        Math.min(100, Math.round(((offset + bytes.length) / file.size) * 100)),
      );
    }
    return this.rpc<BotAttachment>("attachments.finish", botId, { id: a.id }, `${uploadId}:finish`, options);
  }
  async download(botId: string, id: string, owner = this.owner, signal?:AbortSignal) {
    try { return await cloudDownload(owner,()=>this.owner,botId,id,signal); }
    catch (error) { if (!(error instanceof CloudStorageError) || !["not_found","not_ready"].includes(error.code) && error.status!==404) throw error; }
    const chunks: Uint8Array[] = [];
    let offset = 0,
      name = "download",
      mimeType = "application/octet-stream";
    do {
      signal?.throwIfAborted();
      const p = await this.rpc<{
        data: string;
        nextOffset: number;
        size: number;
        name: string;
        mimeType: string;
      }>("attachments.read", botId, { id, offset }, undefined, { owner });
      chunks.push(Uint8Array.from(atob(p.data), (c) => c.charCodeAt(0)));
      name = p.name;
      mimeType = p.mimeType;
      if (p.nextOffset === p.size) break;
      if (p.nextOffset <= offset) throw new Error("Download stalled.");
      offset = p.nextOffset;
    } while (true);
    const blob = new Blob(chunks as BlobPart[], { type: mimeType });
    return { blob, name };
  }
}
export const botsClient = new BotsClient();
