import { useMemo, useSyncExternalStore } from "react";
import type { BotOperations } from "../../lib/bots-operations";
import { botsClient as client } from "./client";

type Method = "runs.interrupt" | "runs.resume" | "requests.respond" | "turn.interrupt";
type Intent = { id: string; method: Method; params: Record<string, unknown> };
const actions = new Map<string, RunAction>();
/** Exact receipt recovery, outside disposable snapshot caches. No automatic write retry. */
class RunAction {
  intent: Intent | null = null;
  busy = false;
  accepted = false;
  error = "";
  private revision = 0;
  private listeners = new Set<() => void>();
  snapshot = () => this.revision;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  constructor(readonly owner: string, readonly botId: string, private key: string) { this.read(); }
  private read() {
    try {
      const raw = localStorage.getItem(this.key);
      const value = raw ? JSON.parse(raw) : null;
      if (value && (!value.id || !["runs.interrupt", "runs.resume", "requests.respond", "turn.interrupt"].includes(value.method) || !value.params)) throw Error();
      this.intent = value; this.error = "";
    } catch { this.error = "The saved action could not be read. Keep this tab open and retry storage recovery."; }
  }
  private notify() { this.revision++; for (const fn of this.listeners) fn(); }
  async perform(method: Method, params: BotOperations[Method]["params"]) {
    if (this.busy || client.owner !== this.owner || !client.online || client.snapshot?.capabilities?.backgroundRunLanes !== 1) return;
    this.read();
    if (this.error) { this.notify(); throw Error(this.error); }
    const intent = this.intent ?? { id: crypto.randomUUID(), method, params };
    // If a previous action is uncertain, only its exact payload may be retried.
    if (this.intent && (intent.method !== method || JSON.stringify(intent.params) !== JSON.stringify(params))) throw Error("Confirm the earlier action first. Its original answer and destination are retained.");
    try { localStorage.setItem(this.key, JSON.stringify(intent)); }
    catch { this.error = "This action could not be saved. Nothing was dispatched; retry when browser storage is available."; this.notify(); throw Error(this.error); }
    this.intent = intent; this.accepted = false; this.busy = true; this.error = ""; this.notify();
    try {
      await client.rpc(intent.method, this.botId, intent.params, intent.id, { owner: this.owner, managed: true });
      // Settlement belongs to the originating owner even while presentation is hidden.
      localStorage.removeItem(this.key); this.intent = null; this.accepted = true;
    } catch (reason) {
      if ((reason as { outcome?: string }).outcome === "rejected") {
        try { localStorage.removeItem(this.key); this.intent = null; } catch { /* retain exact identity */ }
      }
      this.error = reason instanceof Error ? reason.message : "This action is unconfirmed. Retry the same action to check it.";
      throw reason;
    } finally { this.busy = false; this.notify(); }
  }
  retry = () => this.intent ? this.perform(this.intent.method, this.intent.params) : Promise.resolve();
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
