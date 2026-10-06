import { useMemo, useSyncExternalStore } from "react";
import type { BotOperations } from "../../lib/bots-operations";
import { botsClient as client } from "./client";
import { runActionJournal, type RunActionMethod as Method, type RunActionIntent as Intent, type ActionSelection } from "./run-action-journal";

const actions = new Map<string, RunAction>();
let channel: BroadcastChannel | undefined, listening = false;
function listen() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  const refresh = (key?: string) => { for (const [scope, action] of actions) if ((!key || key === scope) && action.owner === client.owner && action.mounted) void action.refresh(); };
  if (typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel("dawar-run-actions-v2");
    channel.onmessage = event => { if (typeof event.data === "string") refresh(event.data); };
  }
  window.addEventListener("storage", event => {
    if (event.key === "dawar-run-action-change:v2") refresh();
    else if (event.key?.startsWith("dawar-run-action:v1:")) refresh(event.key);
  });
  window.addEventListener("focus", () => refresh()); window.addEventListener("pageshow", () => refresh());
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  let owner = client.owner;
  client.subscribe(() => { if (owner !== client.owner) { owner = client.owner; refresh(); } });
}
function changed(key: string) {
  try { channel?.postMessage(key); } catch { /* storage/focus also reconciles */ }
  // Notification only; identity/settlement never depend on this fallible write.
  try { localStorage.setItem("dawar-run-action-change:v2", crypto.randomUUID()); } catch { /* focus/resume also reconciles */ }
}
/** Origin-owned, exact-ID recovery. No automatic uncertain write retry. */
class RunAction {
  intent: Intent | null = null;
  busy = false;
  ready = false;
  accepted = false;
  confirmation: Intent | null = null;
  error = "";
  private journalRevision = -1;
  private revision = 0;
  private listeners = new Set<() => void>();
  get mounted() { return this.listeners.size > 0; }
  snapshot = () => this.revision;
  subscribe = (fn: () => void) => { this.listeners.add(fn); listen(); void this.refresh(); return () => { this.listeners.delete(fn); }; };
  constructor(readonly owner: string, readonly botId: string, private key: string, private scope: string) {}
  private apply(value: ActionSelection) {
    if (value.revision < this.journalRevision) return;
    this.journalRevision = value.revision; this.ready = true;
    this.intent = value.current;
    this.accepted = !value.current && value.last?.state === "accepted";
    this.confirmation = value.last?.state === "accepted" ? value.last : null;
    this.error = value.current?.error ?? (value.last?.state === "rejected" && !value.current ? value.last.error ?? "The action was rejected." : "");
    this.notify();
  }
  async refresh() {
    try { this.apply(await runActionJournal(this.key, { kind: "read" })); }
    catch (error) { this.error = error instanceof Error ? error.message : "Action recovery is unavailable. Retry when browser storage is available."; this.notify(); }
  }
  private notify() { this.revision++; for (const fn of this.listeners) fn(); }
  private async execute(command: { method: Method; params: Record<string, unknown> } | { id: string }) {
    if (this.busy || client.owner !== this.owner || !client.online) throw Error("Connect as this action's owner before continuing.");
    this.busy = true; this.notify();
    let intent: Intent | undefined;
    try {
      const selected = await runActionJournal(this.key, "id" in command ? { kind: "exact", id: command.id } : { kind: "admit", intent: { id: crypto.randomUUID(), ...command } });
      this.apply(selected); changed(this.key);
      const operation = selected.selected;
      if (!operation) throw Error("No saved action was selected. Retry recovery.");
      if (operation.state === "accepted") return;
      if (operation.state === "rejected") throw Error(operation.error || "This exact action was rejected. Review the current state before making a new action.");
      intent = operation;
      if (intent.method === "peers.control" && this.scope !== `peer-root:${intent.params.rootId}`) throw Error("The saved control belongs to a different discussion. Its original identity is retained; no control was sent.");
      if (intent.method === "runs.decide" && client.snapshot?.capabilities?.scheduleDecisions !== 1) throw Error("Connect to a service that supports scheduled-run choices. The saved choice is retained.");
      if (intent.method === "bursts.discard" && client.snapshot?.capabilities?.burstDiscard !== 1) throw Error("Connect to the updated service to discard these messages. The saved action is retained.");
      if ((intent.method === "bursts.resume" || intent.method === "bursts.discard" && intent.params.pendingOnly) && client.snapshot?.capabilities?.burstControls !== 1) throw Error("Connect to the updated service for held-message controls. This saved action is retained.");
      const capability = intent.method === "peers.control" ? "peerRootControls" : intent.method.startsWith("bursts.") ? "messageBursts" : (intent.method === "work.resume" || intent.method === "turn.interrupt" && intent.params.scope === "main" && client.snapshot?.capabilities?.singleThreadExecution === 1) ? "singleThreadExecution" : intent.method === "peers.cancel" ? "peerInbox" : "backgroundRunLanes";
      if (client.snapshot?.capabilities?.[capability] !== 1) throw Error("This service does not support the saved action. Its identity is retained.");
      const result = await client.rpc(intent.method, this.botId, intent.params, intent.id, { owner: this.owner, managed: true });
      if (!result || typeof result !== "object" || Array.isArray(result)) throw Error("The response did not confirm this action. Check the same saved action again.");
      if (intent.method === "runs.decide") {
        const receipt = result as { operationId?: string; run?: { id?: string; botId?: string } };
        if (receipt.operationId !== intent.id || receipt.run?.id !== intent.params.runId || receipt.run?.botId !== this.botId) throw Error("The response did not confirm this exact choice. Check the saved choice again.");
      }
      if (intent.method === "bursts.discard") {
        const receipt = result as { discardedIds?: string[]; hiddenIds?: string[] };
        const ids = intent.params.pendingOnly ? receipt.discardedIds ?? [] : [...(receipt.discardedIds ?? []), ...(receipt.hiddenIds ?? [])];
        const requested = intent.params.messageIds as string[];
        if (ids.length !== requested.length || requested.some(id => !ids.includes(id))) throw Error("The reply did not confirm the exact messages. Check the saved discard action again.");
      }
      if (["bursts.stop", "bursts.start", "bursts.resume"].includes(intent.method) && client.snapshot?.capabilities?.burstControls === 1) {
        const receipt = (result as { control?: { operationId?: string; method?: string; botId?: string } }).control;
        if (receipt?.operationId !== intent.id || receipt.method !== intent.method || receipt.botId !== this.botId) throw Error("This burst control was not confirmed. Check the same saved action again.");
      }
      if (intent.method === "peers.cancel" && (result as { request?: { id?: string } }).request?.id !== intent.params.id) throw Error("The reply did not confirm this discussion. Retry its saved action.");
      if (intent.method === "peers.control") {
        const { control, root } = result as import("../../lib/bots-types").BotPeerControl;
        if (control?.operationId !== intent.id || control.botId !== this.botId || control.rootId !== intent.params.rootId || control.action !== intent.params.action || control.expectedRevision !== intent.params.expectedRevision || control.appliedRevision !== Number(intent.params.expectedRevision) + 1 || control.scope !== "discussion-admission" || control.nativeInterruption !== false || root?.id !== control.rootId || root.revision !== control.appliedRevision || root.version !== 1) throw Error("This discussion control was not confirmed. Check the same saved action again.");
      }
      this.apply(await runActionJournal(this.key, { kind: "settle", id: intent.id, state: "accepted" })); changed(this.key);
    } catch (reason) {
      const error = reason instanceof Error ? reason.message : "This action is unconfirmed. Check the same saved action again.";
      if (intent) {
        try { this.apply(await runActionJournal(this.key, { kind: "settle", id: intent.id, state: (reason as { outcome?: string }).outcome === "rejected" ? "rejected" : "pending", error })); changed(this.key); }
        catch { this.error = `${error} The action journal needs recovery; its saved identity is retained.`; }
      } else this.error = error;
      throw reason;
    } finally { this.busy = false; this.notify(); }
  }
  perform = (method: Method, params: BotOperations[Method]["params"]) => this.execute({ method, params });
  retry = () => this.intent ? this.execute({ id: this.intent.id }) : this.refresh();
}
export function useRunAction(owner: string, botId: string, scope: string) {
  const action = useMemo(() => {
    const key = `dawar-run-action:v1:${JSON.stringify([owner, botId, scope])}`;
    let value = actions.get(key);
    if (!value) { value = new RunAction(owner, botId, key, scope); actions.set(key, value); }
    return value;
  }, [owner, botId, scope]);
  useSyncExternalStore(action.subscribe, action.snapshot, action.snapshot);
  return action;
}
