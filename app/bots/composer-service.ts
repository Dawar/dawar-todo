import { botsClient as client } from "./client";
import { BotDraftStore, PORTABLE_COMPOSER, draftFingerprint } from "./draft-store";
import { BotComposer } from "./composer-controller";
import { registerPwaUpdateGuard } from "../pwa-update";

export type ComposerClipboard = { type:"dawar-composer"; version:1; snapshotId:string; sourceBotId:string; text:string; files:{name:string;size:number;mimeType:string;state:"ready"|"uploading"}[] };
export type ComposerPaste = { owner:string; snapshotId:string; targetBotId:string; targetFingerprint:string; operationId:string; move:boolean; nonEmpty:boolean };
export class ComposerService {
  private controllers = new Map<string, BotComposer>();
  private store?: BotDraftStore;
  private channel?: BroadcastChannel;
  private started = false;
  private owner = "";
  private online = false;
  private storageAvailable = false;
  error = "";
  private revision = 0;
  snapshot = () => this.revision;
  peek(owner: string, botId: string | null) {
    if (!botId) return null;
    return this.controllers.get(JSON.stringify([owner, botId])) ?? null;
  }
  async openComposer(owner: string, botId: string) {
    try {
      const composer = this.get(owner, botId);
      this.notify();
      await composer.flush();
      await this.store!.restorePortable(owner,botId);
      if(composer.ready) await composer.refresh();
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
    return this.controller(owner, botId);
  }
  private controller(owner: string, botId: string, portable = false) {
    if (!this.store) this.store = new BotDraftStore(indexedDB, localStorage);
    const storageKey = portable ? PORTABLE_COMPOSER : botId;
    const key = JSON.stringify([owner, storageKey]);
    let composer = this.controllers.get(key);
    if (!composer) {
      composer = new BotComposer(owner, botId, this.store, client, () => {
        this.channel?.postMessage({ owner, botId: storageKey });
      }, undefined, portable);
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
        ...records.filter((r) => !r.botId.startsWith("clipboard:") && (Object.keys(r.operations).length || r.botId!==PORTABLE_COMPOSER && Object.values(r.slots).some((d) => d.files.some((f) => !f.remote?.ready)))).map((r) => r.botId),
        ...legacyIds,
      ]);
      for (const botId of ids) {
        if (client.owner !== owner) return;
        const row=records.find(record=>record.botId===botId);
        const frozenTarget=Object.values(row?.operations??{}).find(operation=>operation.botId)?.botId;
        const c=botId===PORTABLE_COMPOSER ? (frozenTarget?this.controller(owner,frozenTarget,true):undefined) : this.controller(owner,botId);
        if(!c)continue;
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
    registerPwaUpdateGuard("bot-drafts", async () => {
      if ([...this.controllers.values()].some(c => c.owner !== client.owner && (c.dirty || c.storageError)))
        throw Error("An earlier sign-in has unsaved bot input. Preserve it before refreshing.");
      const controllers = [...this.controllers.values()].filter(c => c.owner === client.owner);
      if (controllers.some(c => c.committing)) throw Error("Finish the current composer action before refreshing.");
      await Promise.all(controllers.map(c => c.flush()));
      if (controllers.some(c => c.dirty || c.storageError)) throw Error("Save your bot drafts before refreshing. Keep this page open.");
    });
    if (typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel("dawar-bot-drafts");
      this.channel.onmessage = (event) => {
        const data = event.data as { owner?: string; botId?: string };
        if (data.owner !== client.owner || !data.botId) return;
        const c = this.controllers.get(JSON.stringify([data.owner, data.botId]));
        if (c) void c.refresh();
      };
    }
    window.addEventListener("storage",()=>this.notify());
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
      const storageConnected = client.storageAvailable && !this.storageAvailable;
      this.storageAvailable = client.storageAvailable;
      this.owner = client.owner; this.online = client.online;
      if (changedOwner || reconnected || storageConnected) void this.recoverOwner();
      if (reconnected || storageConnected) for (const c of this.controllers.values()) if (c.owner === client.owner) {
        void c.resumeUploads(true); void c.reconcile();
      }
    });
    void this.recoverOwner();
  }
  clipboard(owner:string):ComposerClipboard|null {
    try {
      const value=JSON.parse(localStorage.getItem(`dawar-bots:${owner}:composer-clipboard`)??"null");
      return value?.type==="dawar-composer"&&value.version===1&&/^clipboard:composer:[a-f0-9-]{36}$/.test(value.snapshotId)?value:null;
    } catch{return null;}
  }
  async capture(owner:string,botId:string){
    const composer=this.get(owner,botId);await composer.prepareCopy();
    if(!composer.canUseOwner || composer.committing)throw Error("Finish the current composer action before copying.");
    return this.store!.captureComposer(owner,botId,botId,draftFingerprint(composer.record));
  }
  async copyComposer(owner:string,botId:string){
    const snapshot=await this.capture(owner,botId);
    if(client.owner!==owner)throw Error("Sign back in as the draft owner to copy it.");
    const clipboard:ComposerClipboard={type:"dawar-composer",version:1,snapshotId:snapshot.botId,sourceBotId:botId,text:snapshot.slots.normal.text,
      files:snapshot.slots.normal.files.map(file=>({name:file.name,size:file.size,mimeType:file.mimeType,state:file.remote?.ready?"ready":"uploading"}))};
    localStorage.setItem(`dawar-bots:${owner}:composer-clipboard`,JSON.stringify(clipboard));this.notify();
  }
  async preparePaste(owner:string,targetBotId:string,snapshotId=this.clipboard(owner)?.snapshotId,move=false):Promise<ComposerPaste>{
    if(!snapshotId)throw Error("Copy a composer first.");
    const composer=this.get(owner,targetBotId);await composer.open();await composer.flush();await composer.refresh();
    if(!composer.canUseOwner || composer.committing || Object.keys(composer.record.operations).length)throw Error("Confirm the destination's current action before replacing its draft.");
    const snapshot=await this.store!.get(owner,snapshotId);
    if(!snapshot?.clipboardSource)throw Error("Copied composer is unavailable on this device. Copy it again.");
    return {owner,snapshotId,targetBotId,targetFingerprint:draftFingerprint(composer.record),operationId:crypto.randomUUID(),move,nonEmpty:Boolean(composer.draft.text||composer.draft.files.length)};
  }
  async applyPaste(paste:ComposerPaste){
    if(client.owner!==paste.owner)throw Error("The signed-in owner changed. Original drafts are retained.");
    const snapshot=await this.store!.get(paste.owner,paste.snapshotId);
    const source=snapshot?.clipboardSource?this.controllers.get(JSON.stringify([paste.owner,snapshot.clipboardSource.storageKey])):undefined;
    const target=this.get(paste.owner,paste.targetBotId);
    if(paste.move&&source?.committing)throw Error("Finish the source's current action before moving its draft.");
    await target.flush();if(paste.move)await source?.flush();
    if(target.committing)throw Error("Finish the destination's current action before replacing its draft.");
    await this.store!.pasteComposer(paste.owner,paste.snapshotId,paste.targetBotId,paste.targetFingerprint,paste.operationId,paste.move);
    // Refresh all source/destination controllers; late upload acknowledgements
    // cannot resurrect a file absent from the current record.
    await target.refresh();target.select("normal");await target.flush();
    if(paste.move){await source?.refresh();source?.select("normal");await source?.flush();}
    this.channel?.postMessage({owner:paste.owner,botId:paste.targetBotId});
    if(paste.move){const snapshot=await this.store!.get(paste.owner,paste.snapshotId);if(snapshot?.clipboardSource)this.channel?.postMessage({owner:paste.owner,botId:snapshot.clipboardSource.storageKey});}
    void target.resumeUploads();this.notify();
  }
  async savedDrafts(owner:string) {
    this.store ??= new BotDraftStore(indexedDB,localStorage);
    return (await this.store.list(owner)).filter(record=>record.botId===PORTABLE_COMPOSER&&(!record.restoredTo||draftFingerprint(record)!==record.restoredFingerprint)&&(record.slots.normal.text||record.slots.normal.files.length));
  }
  async restoreDraft(owner:string,sourceKey:string,targetBotId:string) {
    const record=await this.store!.get(owner,sourceKey);
    if(!record)throw Error("Earlier draft is unavailable.");
    const snapshot=await this.store!.captureComposer(owner,sourceKey,targetBotId,draftFingerprint(record));
    const paste=await this.preparePaste(owner,targetBotId,snapshot.botId);
    if(paste.nonEmpty&&!window.confirm("Replace this bot's draft with the earlier shared draft?"))return;
    await this.applyPaste(paste);
    return true;
  }
  get unsavedElsewhere() {
    return [...this.controllers.values()].filter((c) => c.owner === client.owner && c.storageError);
  }
}
export const botComposers = new ComposerService();
