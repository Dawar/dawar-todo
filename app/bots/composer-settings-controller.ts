import type { Bot, BotSnapshot } from "../../lib/bots-types";
import { botsClient, BotRpcError } from "./client";

export type Setting = "model" | "effort" | "serviceTier" | "mode";
export type Values = Pick<Bot, Setting>;
type Versions = Partial<Record<Setting, number>>;
type Pending = {
  values: Partial<Values>;
  versions: Versions;
  operationId: string;
  afterCursor: number;
  phase: "saving" | "checking" | "verifying";
};
type Confirmed = { values: Values; afterCursor: number; operationId: string };
export type SettingsState = {
  intent: Partial<Values>;
  versions: Versions;
  pending: Pending | null;
  confirmed: Confirmed | null;
  error: string;
};

export const valuesOf = (bot: Bot): Values => ({
  model: bot.model, effort: bot.effort, serviceTier: bot.serviceTier ?? null, mode: bot.mode,
});
const fields: Setting[] = ["model", "effort", "serviceTier", "mode"];
const same = (a: Values, b: Values) => fields.every(field => a[field] === b[field]);
const matches = (bot: Bot, values: Partial<Values>) => {
  const stored = valuesOf(bot);
  return fields.every(field => values[field] === undefined || values[field] === stored[field]);
};

/** Per-owner, per-bot desired state outlives a sidebar switch. Only one native
 * settings update is in flight; later taps coalesce into the next ordered save. */
export class ComposerSettingsController {
  private state: SettingsState = { intent: {}, versions: {}, pending: null, confirmed: null, error: "" };
  private listeners = new Set<() => void>();
  private serial = 0;
  private bot: Bot | null = null;
  private snapshot: BotSnapshot | null = null;
  private online = false;
  private storageKey: string;
  constructor(readonly owner: string, readonly botId: string) {
    this.storageKey = `dawar-bots:${owner}:settings:${botId}`;
    if (typeof localStorage === "undefined") return;
    try {
      const stored = JSON.parse(localStorage.getItem(this.storageKey) ?? "null");
      if (stored?.version !== 1 || !stored.state || typeof stored.savedAt !== "number") return;
      const prior = stored.state as SettingsState;
      const intent: Partial<Values> = {};
      for (const field of fields) {
        const value = prior.intent?.[field];
        if (value === null || typeof value === "string") Object.assign(intent, { [field]: value });
      }
      const pending = prior.pending && typeof prior.pending.operationId === "string" &&
        prior.pending.operationId.length >= 10 && typeof prior.pending.afterCursor === "number" &&
        prior.pending.values && typeof prior.pending.values === "object"
          ? { ...prior.pending, phase: "checking" as const } : null;
      const confirmed = Date.now() - stored.savedAt < 60 * 60 * 1000 && prior.confirmed?.values &&
        typeof prior.confirmed.afterCursor === "number" ? prior.confirmed : null;
      this.serial = Math.max(0, ...Object.values(prior.versions ?? {}).filter((value): value is number =>
        typeof value === "number" && Number.isSafeInteger(value)));
      this.state = { intent, versions: prior.versions ?? {}, pending, confirmed,
        error: pending ? "A previous setting save is unconfirmed. Check it before sending your latest choice." : "" };
    } catch { /* An invalid cache cannot prevent opening this bot. */ }
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(state: SettingsState) {
    if (typeof localStorage !== "undefined") try {
      if (state.pending || state.confirmed || Object.keys(state.intent).length)
        localStorage.setItem(this.storageKey, JSON.stringify({ version: 1, savedAt: Date.now(), state }));
      else localStorage.removeItem(this.storageKey);
    } catch {
      if (state.pending || Object.keys(state.intent).length)
        state = { ...state, error: state.error || "Browser storage is unavailable. Keep this tab open until the setting finishes saving." };
    }
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  private currentBot() {
    return (botsClient.owner === this.owner ? botsClient.snapshot?.bots.find(bot => bot.id === this.botId) : null) ?? this.bot;
  }
  private currentCursor() {
    return botsClient.owner === this.owner ? botsClient.snapshot?.cursor ?? this.snapshot?.cursor ?? 0 : this.snapshot?.cursor ?? 0;
  }
  private committed() {
    return this.state.confirmed?.values ?? valuesOf(this.currentBot()!);
  }
  displayed(bot = this.currentBot()!) {
    return { ...valuesOf(bot), ...this.state.confirmed?.values, ...this.state.intent };
  }
  observe(bot: Bot, snapshot: BotSnapshot, online: boolean) {
    this.bot = bot; this.snapshot = snapshot; this.online = online;
    const confirmation = this.state.confirmed;
    if (confirmation && snapshot.cursor > confirmation.afterCursor && same(valuesOf(bot), confirmation.values))
      this.publish({ ...this.state, confirmed: null });
    if (online && !this.state.pending && Object.keys(this.state.intent).length) this.pump();
  }
  edit(values: Partial<Values>) {
    if (botsClient.owner !== this.owner || !this.online) {
      this.publish({ ...this.state, error: "Reconnect to change this bot's settings." });
      return;
    }
    const versions = { ...this.state.versions };
    for (const field of fields) if (values[field] !== undefined) versions[field] = ++this.serial;
    this.publish({ ...this.state, intent: { ...this.state.intent, ...values }, versions,
      error: this.state.pending?.phase === "checking" || this.state.pending?.phase === "verifying" ? this.state.error : "" });
    this.pump();
  }
  private pump() {
    if (this.state.pending || !this.online || botsClient.owner !== this.owner || !this.currentBot()) return;
    const committed = this.committed();
    const values: Partial<Values> = {};
    for (const field of fields) {
      const wanted = this.state.intent[field];
      if (wanted !== undefined && wanted !== committed[field]) Object.assign(values, { [field]: wanted });
    }
    if (!Object.keys(values).length) {
      if (Object.keys(this.state.intent).length)
        this.publish({ ...this.state, intent: {}, versions: {} });
      return;
    }
    const pending: Pending = { values, versions: { ...this.state.versions },
      operationId: crypto.randomUUID(), afterCursor: this.currentCursor(), phase: "saving" };
    this.publish({ ...this.state, pending });
    void this.send(pending);
  }
  private async send(pending: Pending) {
    try {
      const saved = await botsClient.rpc<Bot>("bots.update", this.botId, pending.values,
        pending.operationId, { owner: this.owner });
      if (!saved || saved.id !== this.botId || !matches(saved, pending.values))
        throw new BotRpcError("The settings reply could not be confirmed. Check the saved state.", "uncertain");
      this.accept(saved, pending);
    } catch (reason) {
      if (this.state.pending?.operationId !== pending.operationId) return;
      if (botsClient.owner !== this.owner) {
        this.publish({ ...this.state, pending: { ...pending, phase: "checking" },
          error: "Connection changed while saving. Reopen this bot and check the setting." });
        return;
      }
      if (!(reason instanceof BotRpcError) || reason.outcome === "uncertain") {
        this.publish({ ...this.state, pending: { ...pending, phase: "checking" },
          error: "The last save is unconfirmed. Your latest choice is waiting; check it or retry the same save." });
        return;
      }
      const intent = { ...this.state.intent }, versions = { ...this.state.versions };
      for (const field of fields) if (pending.values[field] !== undefined && versions[field] === pending.versions[field]) {
        delete intent[field]; delete versions[field];
      }
      this.publish({ ...this.state, intent, versions, pending: null,
        error: reason.message || "This setting could not be saved." });
      this.pump();
    }
  }
  private accept(saved: Bot, pending: Pending) {
    if (this.state.pending?.operationId !== pending.operationId) return;
    if (botsClient.owner !== this.owner) {
      this.publish({ ...this.state, pending: { ...pending, phase: "checking" },
        error: "The signed-in owner changed while saving. Reopen this bot and check the setting." });
      return;
    }
    const confirmed: Confirmed = { values: valuesOf(saved), afterCursor: pending.afterCursor, operationId: pending.operationId };
    this.publish({ ...this.state, confirmed, pending: null, error: "" });
    // The queued latest intent stays visible while the next save is dispatched.
    this.pump();
    void botsClient.refresh().then(snapshot => {
      if (botsClient.owner !== this.owner || this.state.confirmed?.operationId !== confirmed.operationId ||
          snapshot.cursor <= confirmed.afterCursor) return;
      this.publish({ ...this.state, confirmed: null });
      this.pump();
    }).catch(() => {});
  }
  async check() {
    const pending = this.state.pending;
    if (!pending || pending.phase !== "checking" || !this.online || botsClient.owner !== this.owner) return;
    this.publish({ ...this.state, pending: { ...pending, phase: "verifying" } });
    try {
      const snapshot = await botsClient.refresh();
      if (botsClient.owner !== this.owner || this.state.pending?.operationId !== pending.operationId) return;
      const bot = snapshot.bots.find(item => item.id === this.botId);
      if (snapshot.cursor > pending.afterCursor && bot && matches(bot, pending.values)) this.accept(bot, pending);
      else this.publish({ ...this.state, pending, error: "Still unconfirmed. Check again or retry the same save." });
    } catch (reason) {
      if (this.state.pending?.operationId === pending.operationId)
        this.publish({ ...this.state, pending, error: reason instanceof Error ? reason.message : "Could not check the setting." });
    }
  }
  retry() {
    const pending = this.state.pending;
    if (!pending || pending.phase !== "checking" || !this.online || botsClient.owner !== this.owner) return;
    this.publish({ ...this.state, pending: { ...pending, phase: "saving" }, error: "" });
    void this.send(pending); // Same operation ID and same parameters; never a blind new mutation.
  }
}

const controllers = new Map<string, ComposerSettingsController>();
export function getComposerSettings(owner: string, botId: string) {
  if (typeof window === "undefined") return new ComposerSettingsController(owner, botId);
  const key = JSON.stringify([owner, botId]);
  let controller = controllers.get(key);
  if (!controller) { controller = new ComposerSettingsController(owner, botId); controllers.set(key, controller); }
  else { controllers.delete(key); controllers.set(key, controller); }
  if (controllers.size > 20) for (const [oldKey, old] of controllers) {
    if (oldKey !== key && !old.getSnapshot().pending && !Object.keys(old.getSnapshot().intent).length) {
      controllers.delete(oldKey); break;
    }
  }
  return controller;
}
