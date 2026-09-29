import type { Bot, BotSnapshot } from "./single-thread-contract";
import { botsClient, BotRpcError } from "./client";

export type Setting = "model" | "effort" | "serviceTier" | "mode" | "avatar" | "burstQuietSeconds";
export type Values = Omit<Pick<Bot, Setting>, "avatar"> & { avatar?: { shape: NonNullable<Bot["avatar"]>["shape"]; color: string } };
type Versions = Partial<Record<Setting, number>>;
type Pending = {
  values: Partial<Values>;
  versions: Versions;
  operationId: string;
  afterCursor: number;
  phase: "saving" | "checking" | "storage";
};
type Confirmed = { values: Partial<Values>; afterCursor: number; operationId: string };
export type SettingsState = {
  intent: Partial<Values>;
  versions: Versions;
  pending: Pending | null;
  confirmed: Confirmed | null;
  error: string;
  storageError: string;
  confirmationError: string;
  refreshingConfirmation: boolean;
};

export const valuesOf = (bot: Bot): Values => ({
  model: bot.model, effort: bot.effort, serviceTier: bot.serviceTier ?? null, mode: bot.mode, avatar: bot.avatar ? { shape: bot.avatar.shape, color: bot.avatar.color } : undefined, burstQuietSeconds: bot.burstQuietSeconds,
});
const fields: Setting[] = ["model", "effort", "serviceTier", "mode", "avatar", "burstQuietSeconds"];
const confirmationRetryDelays = [2000, 5000, 10000];
const matches = (bot: Bot, values: Partial<Values>) => {
  const stored = valuesOf(bot);
  return fields.every(field => values[field] === undefined || JSON.stringify(values[field]) === JSON.stringify(stored[field]));
};

/** Per-owner, per-bot desired state outlives a sidebar switch. Only one native
 * settings update is in flight; later taps coalesce into the next ordered save. */
export class ComposerSettingsController {
  private state: SettingsState = { intent: {}, versions: {}, pending: null, confirmed: null, error: "", storageError: "",
    confirmationError: "", refreshingConfirmation: false };
  private listeners = new Set<() => void>();
  private serial = 0;
  private bot: Bot | null = null;
  private snapshot: BotSnapshot | null = null;
  private online = false;
  private storageKey: string;
  private confirmationRequest: string | null = null;
  private confirmationAttempt = { operationId: "", count: 0 };
  private confirmationTimer: ReturnType<typeof setTimeout> | null = null;
  // Standalone controllers become observable via observe(); the component
  // binds its mounted/Activity/page lifecycle through attach().
  private present = true;
  private presentations = 0;
  private pageActive = true;
  private confirmationAvailable = false;
  constructor(readonly owner: string, readonly botId: string) {
    this.storageKey = `dawar-bots:${owner}:settings:${botId}`;
    if (typeof localStorage === "undefined") return;
    try {
      const stored = JSON.parse(localStorage.getItem(this.storageKey) ?? "null");
      if (![1, 2].includes(stored?.version) || !stored.state || typeof stored.savedAt !== "number") return;
      const prior = stored.state as SettingsState;
      const intent: Partial<Values> = {};
      for (const field of fields) {
        const value: unknown = prior.intent?.[field];
        if (value === null || typeof value === "string" || field === "burstQuietSeconds" && typeof value === "number" && [0, 3, 8, 15].includes(value) || field === "avatar" && value && typeof value === "object" && "shape" in value && "color" in value && typeof value.shape === "string" && typeof value.color === "string") Object.assign(intent, { [field]: value });
      }
      const pending = prior.pending && typeof prior.pending.operationId === "string" &&
        prior.pending.operationId.length >= 10 && typeof prior.pending.afterCursor === "number" &&
        prior.pending.values && typeof prior.pending.values === "object"
          ? { ...prior.pending, phase: "checking" as const } : null;
      // v1 copied an entire Bot into confirmation, including unsubmitted
      // fields. Retain its pending operation/intent, never that stale overlay.
      const confirmed = stored.version === 2 && prior.confirmed?.values &&
        typeof prior.confirmed.afterCursor === "number" ? prior.confirmed : null;
      this.serial = Math.max(0, ...Object.values(prior.versions ?? {}).filter((value): value is number =>
        typeof value === "number" && Number.isSafeInteger(value)));
      this.state = { intent, versions: prior.versions ?? {}, pending, confirmed,
        error: pending ? "A previous save is unconfirmed. Retry the saved change to reconcile it before saving your latest choice." : "",
        storageError: "", confirmationError: "", refreshingConfirmation: false };
    } catch { /* An invalid cache cannot prevent opening this bot. */ }
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  attach() {
    this.presentations++;
    this.present = true;
    this.pageActive = true;
    const update = () => this.updateConfirmationAvailability();
    const hide = () => { this.pageActive = false; update(); };
    const show = () => { this.pageActive = true; update(); };
    document.addEventListener("visibilitychange", update);
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    update();
    return () => {
      this.present = --this.presentations > 0;
      this.updateConfirmationAvailability();
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", show);
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }
  private setLocal(state: SettingsState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  private publish(state: SettingsState): boolean {
    state = { ...state, storageError: "" };
    try {
      if (typeof localStorage === "undefined") throw new Error("Storage unavailable");
      if (state.pending || state.confirmed || Object.keys(state.intent).length)
        localStorage.setItem(this.storageKey, JSON.stringify({ version: 2, savedAt: Date.now(), state }));
      else localStorage.removeItem(this.storageKey);
    } catch {
      this.setLocal({ ...state, storageError: "Your latest choice could not be kept in browser storage. Keep this tab open and retry storage before another save." });
      return false;
    }
    this.setLocal(state);
    return true;
  }
  private currentBot() {
    return (botsClient.owner === this.owner ? botsClient.snapshot?.bots.find(bot => bot.id === this.botId) : null) ?? this.bot;
  }
  private currentCursor() {
    return botsClient.owner === this.owner ? botsClient.snapshot?.cursor ?? this.snapshot?.cursor ?? 0 : this.snapshot?.cursor ?? 0;
  }
  private committed() {
    return { ...valuesOf(this.currentBot()!), ...this.state.confirmed?.values };
  }
  displayed(bot = this.currentBot()!) {
    return { ...valuesOf(bot), ...this.state.confirmed?.values, ...this.state.intent };
  }
  observe(bot: Bot, snapshot: BotSnapshot, online: boolean) {
    this.bot = bot; this.snapshot = snapshot; this.online = online;
    this.updateConfirmationAvailability();
    if (online && !this.state.pending && Object.keys(this.state.intent).length) this.pump();
  }
  edit(values: Partial<Values>) {
    if (botsClient.owner !== this.owner || !this.online) {
      this.publish({ ...this.state, error: "Reconnect to change this bot's settings." });
      return;
    }
    const versions = { ...this.state.versions };
    for (const field of fields) if (values[field] !== undefined) versions[field] = ++this.serial;
    if (this.publish({ ...this.state, intent: { ...this.state.intent, ...values }, versions,
      error: this.state.pending?.phase === "checking" ? this.state.error : "" })) this.pump();
  }
  private pump() {
    if (this.state.pending || this.state.storageError || !this.online || botsClient.owner !== this.owner || !this.currentBot()) return;
    const committed = this.committed();
    const values: Partial<Values> = {};
    for (const field of fields) {
      const wanted = this.state.intent[field];
      if (wanted !== undefined && JSON.stringify(wanted) !== JSON.stringify(committed[field])) Object.assign(values, { [field]: wanted });
    }
    if (!Object.keys(values).length) {
      if (Object.keys(this.state.intent).length)
        this.publish({ ...this.state, intent: {}, versions: {} });
      return;
    }
    const pending: Pending = { values, versions: { ...this.state.versions },
      operationId: crypto.randomUUID(), afterCursor: this.currentCursor(), phase: "saving" };
    void this.send(pending);
  }
  private async send(pending: Pending) {
    // Persist the exact operation AND latest intent before the RPC can leave.
    // This preflight is also mandatory for explicit same-ID recovery retries.
    if (!this.publish({ ...this.state, pending: { ...pending, phase: "saving" } })) {
      this.setLocal({ ...this.state, pending: { ...pending, phase: "storage" } });
      return;
    }
    try {
      const saved = await botsClient.rpc<Bot>("bots.update", this.botId, pending.values,
        pending.operationId, { owner: this.owner });
      if (!saved || saved.id !== this.botId || !matches(saved, pending.values))
        throw new BotRpcError("The settings reply could not be confirmed. Retry the saved change.", "uncertain");
      this.accept(saved, pending);
    } catch (reason) {
      if (this.state.pending?.operationId !== pending.operationId) return;
      if (botsClient.owner !== this.owner) {
        this.publish({ ...this.state, pending: { ...pending, phase: "checking" },
          error: "Connection changed while saving. Reopen this bot and retry the saved change to reconcile it." });
        return;
      }
      // A retry failing before dispatch says nothing about the earlier
      // uncertain attempt. Only a terminal rejection for that ID can clear it.
      if (!(reason instanceof BotRpcError) || reason.outcome === "uncertain" ||
          reason.outcome === "not-sent" && pending.phase !== "saving") {
        this.publish({ ...this.state, pending: { ...pending, phase: "checking" },
          error: "The last save is unconfirmed. Retry the saved change to reconcile it; your latest choice will follow only after it finishes." });
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
        error: "The signed-in owner changed while saving. Reopen this bot and retry the saved change to reconcile it." });
      return;
    }
    const submitted: Partial<Values> = {};
    const stored = valuesOf(saved);
    for (const field of fields) if (pending.values[field] !== undefined)
      Object.assign(submitted, { [field]: stored[field] });
    const confirmed: Confirmed = { values: { ...this.state.confirmed?.values, ...submitted },
      afterCursor: pending.afterCursor, operationId: pending.operationId };
    this.publish({ ...this.state, confirmed, pending: null, error: "", confirmationError: "" });
    // The queued latest intent stays visible while the next save is dispatched.
    this.pump();
    this.reconcileConfirmation();
  }
  private clearConfirmationTimer() {
    if (this.confirmationTimer !== null) clearTimeout(this.confirmationTimer);
    this.confirmationTimer = null;
  }
  private canReconcileConfirmation() {
    return this.present && this.pageActive && this.online && botsClient.online && botsClient.owner === this.owner &&
      (typeof document === "undefined" || document.visibilityState !== "hidden") &&
      (typeof navigator === "undefined" || navigator.onLine !== false);
  }
  private updateConfirmationAvailability() {
    const available = this.canReconcileConfirmation();
    const resumed = available && !this.confirmationAvailable;
    this.confirmationAvailable = available;
    if (!available) this.clearConfirmationTimer();
    else this.reconcileConfirmation(resumed);
  }
  private reconcileConfirmation(reset = false) {
    const confirmed = this.state.confirmed;
    if (!this.canReconcileConfirmation()) {
      this.confirmationAvailable = false;
      this.clearConfirmationTimer();
      return;
    }
    if (!confirmed) { this.clearConfirmationTimer(); return; }
    if (reset || this.confirmationAttempt.operationId !== confirmed.operationId) {
      this.clearConfirmationTimer();
      this.confirmationAttempt = { operationId: confirmed.operationId,
        count: this.confirmationRequest === confirmed.operationId ? 1 : 0 };
    }
    if (this.confirmationRequest || this.confirmationTimer !== null ||
        this.confirmationAttempt.count > confirmationRetryDelays.length) return;
    this.confirmationAttempt.count++;
    this.confirmationRequest = confirmed.operationId;
    this.setLocal({ ...this.state, refreshingConfirmation: true });
    // This full snapshot is requested AFTER a terminal success for the exact
    // operation. Unlike value equality, it can reconcile the acknowledged
    // overlay, including a later authoritative change from another client.
    // Do not compare against the provisional cached/event cursor: that cursor
    // can exceed the complete snapshot's cursor without containing its state.
    void botsClient.refresh().then(snapshot => {
      if (botsClient.owner !== this.owner || this.state.confirmed?.operationId !== confirmed.operationId ||
          !snapshot.bots.some(bot => bot.id === this.botId)) return;
      this.clearConfirmationTimer();
      this.publish({ ...this.state, confirmed: null, confirmationError: "" });
      this.pump();
    }).catch(() => {}).finally(() => {
      this.confirmationRequest = null;
      const stillConfirmed = this.state.confirmed?.operationId === confirmed.operationId;
      if (!this.canReconcileConfirmation()) {
        this.confirmationAvailable = false;
        this.clearConfirmationTimer();
      } else if (stillConfirmed) {
        const delay = confirmationRetryDelays[this.confirmationAttempt.count - 1];
        // One timer, only after the preceding read settles. No render/event is
        // needed to wake it; hidden/offline/owner transitions cancel or guard it.
        this.clearConfirmationTimer();
        if (delay !== undefined) this.confirmationTimer = setTimeout(() => {
          this.confirmationTimer = null;
          this.reconcileConfirmation();
        }, delay);
        // Exhausted: error/action stay visible, with no more automatic reads.
      }
      // Schedule before notifying subscribers so observation cannot bypass the
      // backoff between clearing the in-flight marker and installing the timer.
      this.setLocal({ ...this.state, refreshingConfirmation: false,
        ...(botsClient.owner === this.owner && stillConfirmed ? {
          confirmationError: "Your change was saved, but current settings could not be refreshed. Displayed settings may be out of date.",
        } : {}) });
      if (!stillConfirmed) this.reconcileConfirmation();
    });
  }
  refreshConfirmed() {
    if (!this.confirmationRequest) this.reconcileConfirmation(true);
  }
  retry() {
    const pending = this.state.pending;
    if (!pending || pending.phase !== "checking" || !this.online || botsClient.owner !== this.owner) return;
    void this.send(pending); // Same operation ID and same parameters; never a blind new mutation.
  }
  retryStorage() {
    if (!this.online || botsClient.owner !== this.owner) return;
    const pending = this.state.pending;
    if (pending?.phase === "storage") void this.send(pending);
    else if (this.publish(this.state)) this.pump();
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
