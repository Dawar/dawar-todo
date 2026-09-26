import { botsClient as client } from "./client";
import { BotDraftStore } from "./draft-store";
import { BotComposer } from "./composer-controller";

class ComposerService {
  private controllers = new Map<string, BotComposer>();
  private store?: BotDraftStore;
  private channel?: BroadcastChannel;
  private started = false;
  private owner = "";
  private online = false;
  error = "";
  private revision = 0;
  snapshot = () => this.revision;
  peek(owner: string, botId: string | null) { return botId ? this.controllers.get(JSON.stringify([owner, botId])) ?? null : null; }
  async openComposer(owner: string, botId: string) {
    try {
      const composer = this.get(owner, botId);
      this.notify();
      await composer.open();
      void composer.resumeUploads(); void composer.reconcile();
    } catch {
      this.error = "Browser storage is unavailable. Draft recovery is blocked; enable site storage and reopen Bots.";
      this.notify();
    }
  }
  listeners = new Set<() => void>();
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private notify = () => { this.revision++; for (const listener of this.listeners) listener(); };
  get(owner: string, botId: string) {
    if (!this.store) this.store = new BotDraftStore(indexedDB, localStorage);
    const key = JSON.stringify([owner, botId]);
    let composer = this.controllers.get(key);
    if (!composer) {
      composer = new BotComposer(owner, botId, this.store, client, () => {
        this.channel?.postMessage({ owner, botId });
      });
      composer.subscribe(this.notify);
      this.controllers.set(key, composer);
    }
    return composer;
  }
  private flush = () => {
    for (const c of this.controllers.values()) if (c.owner === client.owner) void c.flush().catch(() => {});
  };
  private refresh = () => {
    for (const c of this.controllers.values()) if (c.owner === client.owner) void c.refresh();
  };
  async recoverOwner() {
    const owner = client.owner;
    if (!owner) return;
    try {
      this.store ??= new BotDraftStore(indexedDB, localStorage);
      const records = await this.store.list(owner);
      const legacyIds = this.store.legacyBotIds(owner);
      const ids = new Set([
        ...records.filter((r) => Object.keys(r.operations).length || Object.values(r.slots).some((d) => d.files.some((f) => !f.remote || !f.hasBytes))).map((r) => r.botId),
        ...legacyIds,
      ]);
      for (const botId of ids) {
        if (client.owner !== owner) return;
        const c = this.get(owner, botId);
        await c.open(false);
        void c.resumeUploads(true);
        void c.reconcile();
      }
      this.error = "";
    } catch {
      this.error = "Some bot drafts or pending sends could not be recovered. Their original data is retained. Retry recovery before closing this tab.";
    }
    this.notify();
  }
  start() {
    if (this.started) return;
    this.started = true;
    if (typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel("dawar-bot-drafts");
      this.channel.onmessage = (event) => {
        const data = event.data as { owner?: string; botId?: string };
        if (data.owner !== client.owner || !data.botId) return;
        const c = this.controllers.get(JSON.stringify([data.owner, data.botId]));
        if (c) void c.refresh();
      };
    }
    window.addEventListener("pagehide", this.flush);
    window.addEventListener("dawar-before-navigation", this.flush);
    window.addEventListener("popstate", this.flush);
    window.addEventListener("dawar-shell-popstate", this.flush);
    window.addEventListener("pageshow", this.refresh);
    window.addEventListener("focus", this.refresh);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") this.flush(); else this.refresh();
    });
    window.addEventListener("beforeunload", (event) => {
      this.flush();
      if ([...this.controllers.values()].some((c) => c.owner === client.owner && c.dirty)) {
        event.preventDefault(); event.returnValue = "";
      }
    });
    client.subscribe(() => {
      const reconnected = client.online && (!this.online || this.owner !== client.owner);
      const changedOwner = this.owner !== client.owner;
      this.owner = client.owner; this.online = client.online;
      if (changedOwner || reconnected) void this.recoverOwner();
      if (reconnected) for (const c of this.controllers.values()) if (c.owner === client.owner) {
        void c.resumeUploads(true); void c.reconcile();
      }
    });
    void this.recoverOwner();
  }
  get unsavedElsewhere() {
    return [...this.controllers.values()].filter((c) => c.owner === client.owner && c.storageError);
  }
}
export const botComposers = new ComposerService();
