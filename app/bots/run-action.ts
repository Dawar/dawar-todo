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
  error = "";
  private journalRevision = -1;
  private revision = 0;
  private listeners = new Set<() => void>();
  get mounted() { return this.listeners.size > 0; }
  snapshot = () => this.revision;
  subscribe = (fn: () => void) => { this.listeners.add(fn); listen(); void this.refresh(); return () => { this.listeners.delete(fn); }; };
  constructor(readonly owner: string, readonly botId: string, private key: string) {}
  private apply(value: ActionSelection) {
    if (value.revision < this.journalRevision) return;
    this.journalRevision = value.revision; this.ready = true;
    this.intent = value.current;
    this.accepted = !value.current && value.last?.state === "accepted";
    this.error = value.current?.error ?? (value.last?.state === "rejected" && !value.current ? value.last.error ?? "The action was rejected." : "");
    this.notify();
  }
  async refresh() {
    try { this.apply(await runActionJournal(this.key, { kind: "read" })); }
    catch (error) { this.error = error instanceof Error ? error.message : "Action recovery is unavailable. Retry when browser storage is available."; this.notify(); }
  }
  private notify() { this.revision++; for (const fn of this.listeners) fn(); }
  private async execute(command: { method: Method; params: Record<string, unknown> } | { id: string }) {
    if (this.busy || client.owner !== this.owner || !client.online || client.snapshot?.capabilities?.backgroundRunLanes !== 1) throw Error("Connect as this action's owner before continuing.");
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
      const result = await client.rpc(intent.method, this.botId, intent.params, intent.id, { owner: this.owner, managed: true });
      if (!result || typeof result !== "object" || Array.isArray(result)) throw Error("The response did not confirm this action. Check the same saved action again.");
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
    if (!value) { value = new RunAction(owner, botId, key); actions.set(key, value); }
    return value;
  }, [owner, botId, scope]);
  useSyncExternalStore(action.subscribe, action.snapshot, action.snapshot);
  return action;
}
