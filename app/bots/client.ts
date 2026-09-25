import type { BotOperations } from "../../lib/bots-operations";
import type {
  BotEvent,
  BotSnapshot,
  BridgeRequest,
  BotAttachment,
} from "../../lib/bots-types";

type Pending = {
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
export class BotsClient {
  socket: WebSocket | null = null;
  snapshot: BotSnapshot | null = null;
  eventChunks = new Map<number, { bytes: Uint8Array; received: number }>();
  online = false;
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
  cacheKey(key: string) {
    return `dawar-bots:${this.owner}:${key}`;
  }
  cache<T>(key: string, fallback: T): T {
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
    try {
      localStorage.setItem(this.cacheKey(key), JSON.stringify(value));
    } catch {
      /* caches must never prevent work */
    }
  }
  clearOwnerCache() {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith("dawar-bots:")) localStorage.removeItem(key);
    }
    this.snapshot = null;
    this.notify();
  }
  async session(): Promise<Session> {
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
    const body = (await response.json()) as Session & { error?: string };
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        this.clearOwnerCache();
        this.stopped = true;
      }
      throw new Error(body.error ?? "Bots could not connect.");
    }
    return body;
  }
  start() {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    try {
      this.owner = localStorage.getItem("dawar-bots:last-owner") ?? "";
      if (this.owner)
        this.snapshot = this.cache<BotSnapshot | null>("snapshot", null);
    } catch {}
    this.notify();
    void this.connect();
  }
  async connect() {
    if (this.stopped) return;
    try {
      const session = await this.session();
      this.owner = session.owner;
      this.timeZone = session.timeZone;
      localStorage.setItem("dawar-bots:last-owner", this.owner);
      if (!this.snapshot)
        this.snapshot = this.cache<BotSnapshot | null>("snapshot", null);
      const url = new URL(session.url);
      url.searchParams.set("machine", session.machineId);
      const socket = new WebSocket(url);
      this.socket = socket;
      socket.onopen = () =>
        socket.send(JSON.stringify({ type: "auth", ticket: session.ticket }));
      socket.onmessage = ({ data }) => {
        if (data === "pong") return;
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
      this.online = Boolean(message.online);
      this.error = "";
      this.retry = 0;
      if (this.renewTimer) clearTimeout(this.renewTimer);
      this.renewTimer = setTimeout(
        () =>
          void this.session()
            .then((s) =>
              this.socket?.send(
                JSON.stringify({ type: "auth", ticket: s.ticket }),
              ),
            )
            .catch((e) => {
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
      if (this.online)
        void this.refresh()
          .then(() => this.replayPending())
          .catch((e) => {
            this.error = e.message;
            this.notify();
          });
      this.notify();
      return;
    }
    if (message.type === "presence") {
      this.online = Boolean(message.online);
      if (this.online)
        void this.refresh()
          .then(() => this.replayPending())
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
      if (!pending) return;
      let result = message.result as Record<string, unknown>;
      if (result?.__chunk) {
        const total = Number(result.total),
          offset = Number(result.offset);
        if (
          !Number.isSafeInteger(total) ||
          total > 32 * 1024 * 1024 ||
          offset !== (pending.received ?? 0)
        ) {
          pending.reject(new Error("Invalid response transfer."));
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
      this.forgetOperation(pending.request.operationId);
      if (message.error) pending.reject(new Error(String(message.error)));
      else pending.resolve(result);
      return;
    }
    if (message.type === "event") {
      const event = message.event as BotEvent;
      if (this.snapshot) {
        if (event.type === "bot") {
          const bot = event.data as BotSnapshot["bots"][number];
          this.snapshot = {
            ...this.snapshot,
            bots: [
              ...this.snapshot.bots.filter((b) => b.id !== bot.id),
              bot,
            ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
          };
        }
        if (event.type === "request")
          this.snapshot = {
            ...this.snapshot,
            pending: [
              ...this.snapshot.pending.filter(
                (p) => p.key !== (event.data as { key: string }).key,
              ),
              event.data as BotSnapshot["pending"][number],
            ],
          };
        if (event.type === "request.resolved")
          this.snapshot = {
            ...this.snapshot,
            pending: this.snapshot.pending.filter(
              (p) => p.key !== (event.data as { key: string }).key,
            ),
          };
        this.snapshot = { ...this.snapshot, cursor: event.seq };
        // Pending requests may contain secrets; only cache the visible bot list.
        this.save("snapshot", { ...this.snapshot, pending: [] });
      }
      if (event.type === "runtime" && (event.data as { ready: boolean }).ready)
        void this.refresh().catch(() => {});
      if (event.type === "schedules") void this.refresh().catch(() => {});
      for (const listener of this.events) listener(event);
      this.notify();
    }
  }
  rememberOperation(request: BridgeRequest) {
    if (!["turn.send", "bots.create"].includes(request.method)) return;
    const ops = this.cache<Record<string, BridgeRequest>>("operations", {});
    ops[request.operationId] = request;
    this.save("operations", ops);
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
      if (!["snapshot", "history"].includes(pending.request.method))
        this.socket?.send(JSON.stringify(pending.request));
    for (const request of Object.values(
      this.cache<Record<string, BridgeRequest>>("operations", {}),
    )) {
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
    const snapshot = await this.rpc<BotSnapshot>("snapshot");
    this.snapshot = snapshot;
    this.online = snapshot.ready;
    if (this.online)
      void this.rpc(
        "settings.timeZone",
        undefined,
        { timeZone: this.timeZone },
        `timezone:${this.timeZone}:${new Date().toISOString().slice(0, 13)}`,
      ).catch(() => {});
    this.save("snapshot", { ...snapshot, pending: [] });
    this.notify();
    return snapshot;
  }
  rpc<T = unknown>(
    method: keyof BotOperations,
    botId?: string,
    params: Record<string, unknown> = {},
    operationId = crypto.randomUUID(),
  ): Promise<T> {
    if (!this.online || this.socket?.readyState !== WebSocket.OPEN)
      return Promise.reject(
        new Error("The VM is offline. Your draft has been kept."),
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
          new Error(
            "Still waiting for acknowledgement. Reconnect to check the result before sending again.",
          ),
        );
      }, 125000);
      this.pending.set(id, {
        request,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      this.rememberOperation(request);
      this.socket!.send(JSON.stringify(request));
    });
  }
  async upload(botId: string, file: File, onProgress: (value: number) => void) {
    const a = await this.rpc<BotAttachment>("attachments.begin", botId, {
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      size: file.size,
    });
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
      });
      onProgress(
        Math.min(100, Math.round(((offset + bytes.length) / file.size) * 100)),
      );
    }
    return this.rpc<BotAttachment>("attachments.finish", botId, { id: a.id });
  }
  async download(botId: string, id: string) {
    const chunks: Uint8Array[] = [];
    let offset = 0,
      name = "download",
      mimeType = "application/octet-stream";
    do {
      const p = await this.rpc<{
        data: string;
        nextOffset: number;
        size: number;
        name: string;
        mimeType: string;
      }>("attachments.read", botId, { id, offset });
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
