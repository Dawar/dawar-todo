import { createHash, randomUUID } from "node:crypto";
import { UsageHistoryStore, integerText, activityFields } from "./usage-history-store.mjs";

const HOUR = 3_600_000;
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const identifier = value => typeof value === "string" && value.length > 0 && value.length <= 1024 ? value : null;
const iso = value => new Date(value).toISOString();
const emptyActivity = () => ({ state: "collecting", summary: Object.fromEntries(activityFields.map(key => [key, { value: null, observedAt: null }])), daily: [] });
function routing(account) {
  const route = account?.workspaceRouting;
  let origin = null;
  try { origin = new URL(route?.backendOrigin).origin; } catch { /* No verified routing metadata. */ }
  return { id: identifier(route?.chatgptAccountId), origin };
}
const authFingerprint = account => hash([account?.account?.type ?? null, account?.account?.email ?? null, routing(account)]);
function buckets(response) {
  const entries = object(response?.rateLimitsByLimitId) ? Object.entries(response.rateLimitsByLimitId).filter(([, value]) => object(value)) : [];
  const values = entries.length ? entries : object(response?.rateLimits) ? [[response.rateLimits.limitId ?? "legacy", response.rateLimits]] : [];
  if (values.length > 128) throw Error("The service reported more quota buckets than this bounded history reader supports.");
  return values.map(([key, value]) => [identifier(key) ?? "legacy", value]);
}

/** One observational collector for the account, never a bot scheduler or execution policy. */
export class AccountUsageCollector {
  constructor({ store, codex, allowed = () => codex.ready, onChange = () => {}, clock = Date.now }) {
    this.historyStore = new UsageHistoryStore(store);
    Object.assign(this, { codex, allowed, onChange, clock });
    this.epoch = randomUUID();
    this.generation = 0;
    this.sequence = 0;
    this.accountGeneration = randomUUID();
    this.accountType = null;
    this.identity = "unavailable";
    this.key = null;
    this.reason = "Collecting account usage.";
    this.failures = 0;
    this.inflight = null;
    this.stopped = true;
    this.quotaReadAt = null;
    this.metadata = { ordinaryUsageAllowed: null, availableResetCredits: null,
      ordinaryUsageAllowedObservedAt: null, availableResetCreditsObservedAt: null };
  }
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    void this.refresh("startup");
  }
  stop() {
    this.stopped = true;
    this.generation++;
    clearTimeout(this.timer);
    clearTimeout(this.eventTimer);
    clearTimeout(this.changeTimer);
    this.nextAttemptAt = null;
  }
  disconnected() {
    this.invalidate("Account connection is unavailable.");
    clearTimeout(this.timer);
    this.nextAttemptAt = null;
  }
  invalidate(reason) {
    this.generation++;
    this.accountGeneration = randomUUID();
    this.key = null;
    this.identity = "unavailable";
    this.accountType = null;
    this.quotaReadAt = null;
    this.boundIdentity = null;
    this.boundAuth = null;
    this.lastAttempt = null;
    this.metadata = { ordinaryUsageAllowed: null, availableResetCredits: null,
      ordinaryUsageAllowedObservedAt: null, availableResetCreditsObservedAt: null };
    this.reason = reason;
    this.forceSegment = true;
    this.viewCache = null;
    this.changed();
  }
  changed() {
    // Body-free invalidation. The owner reads a bounded scoped page if the panel is open.
    if (this.changeTimer || this.stopped) return;
    this.changeTimer = setTimeout(() => { this.changeTimer = null; this.onChange({ accountGeneration: this.accountGeneration }); }, 1000);
    this.changeTimer.unref?.();
  }
  notification(message) {
    if (message.method === "account/updated") {
      this.invalidate(message.params?.authMode === null ? "Sign in to Codex to collect usage history." : "Account changed. Verifying usage identity.");
      this.requestObservation();
      return true;
    }
    if (message.method !== "account/rateLimits/updated") return false;
    const at = this.clock(), seq = ++this.sequence;
    if (this.key && object(message.params?.rateLimits)) {
      try {
        this.historyStore.merge(this.key, buckets(message.params), { at, seq, epoch: this.epoch });
        this.changed();
      } catch { this.reason = "A quota update could not be recorded. Refresh to read the current snapshot."; }
    } else this.requestObservation();
    return true;
  }
  requestObservation() {
    if (this.stopped || this.eventTimer) return;
    this.eventTimer = setTimeout(() => { this.eventTimer = null; void this.refresh("account-update"); }, 500);
    this.eventTimer.unref?.();
  }
  plan() {
    clearTimeout(this.timer);
    if (this.stopped) return;
    const wait = this.failures ? Math.min(HOUR, 60_000 * 2 ** Math.min(this.failures, 6)) : HOUR;
    this.nextAttemptAt = iso(this.clock() + wait);
    this.timer = setTimeout(() => void this.refresh("hourly"), wait);
    this.timer.unref?.();
  }
  legacy() {
    if (this.stopped) return this.viewCache ?? { accountType: null, ordinaryUsageAllowed: null, availableResetCredits: null,
      limits: [], readAt: iso(this.clock()), reason: "Account usage collection is offline." };
    const activity = this.key ? this.historyStore.activity(this.key) : null;
    // Preserve the old unpaged account contract. Chart paging remains exclusively usage.history.
    const rows = this.key ? this.historyStore.db.prepare("SELECT bucket,json FROM usage_windows WHERE account=? ORDER BY bucket,slot LIMIT 256").all(this.key) : [];
    const grouped = new Map(), observed = [];
    for (const row of rows) {
      const state = JSON.parse(row.json);
      if (state.usedPercent.value === null) continue;
      const key = row.bucket;
      const limit = grouped.get(key) ?? { limitId: state.limitId, limitName: state.limitName, model: state.model, windows: [] };
      limit.windows.push({ usedPercent: state.usedPercent.value, windowDurationMins: state.windowDurationMins.value, resetsAt: state.resetsAt.value });
      grouped.set(key, limit);
      for (const field of [state.usedPercent, state.windowDurationMins, state.resetsAt]) if (field.observedAt) observed.push(field.observedAt);
    }
    this.viewCache = { accountType: this.accountType, ...this.metadata, limits: [...grouped.values()],
      // A sparse update cannot label older fields with the latest poll time.
      readAt: observed.sort()[0] ?? this.quotaReadAt ?? iso(this.clock()),
      ...(this.reason ? { reason: this.reason } : {}), tokenReadAt: activity?.readAt ?? null };
    return this.viewCache;
  }
  async refresh(reason = "manual") {
    if (this.inflight) { if (reason === "account-update") this.refreshAgain = true; return this.inflight; }
    if (this.lastAttempt && this.clock() - this.lastAttempt < 5000) return this.legacy();
    const promise = this.collect(reason);
    this.inflight = promise;
    try { return await promise; }
    finally {
      if (this.inflight === promise) this.inflight = null;
      this.plan();
      if (this.refreshAgain) { this.refreshAgain = false; this.requestObservation(); }
    }
  }
  async collect() {
    const generation = this.generation, seq = ++this.sequence, at = this.clock();
    const valid = () => !this.stopped && generation === this.generation;
    if (!valid() || !this.allowed()) {
      this.reason = "Usage collection is waiting for the account connection or runtime maintenance to finish.";
      this.failures++;
      this.changed();
      return this.legacy();
    }
    this.lastAttempt = at;
    try {
      const before = await this.codex.call("account/read", { refreshToken: false }, 15_000);
      if (!valid()) return this.legacy();
      if (!before?.account) {
        this.invalidate("Sign in to Codex to collect usage history.");
        this.failures++;
        return this.legacy();
      }
      if (!this.allowed()) throw Error("Collection deferred during runtime maintenance.");
      const [quota, tokens] = await Promise.allSettled([
        this.codex.call("account/rateLimits/read", {}, 15_000),
        before.account.type === "chatgpt" ? this.codex.call("account/usage/read", {}, 15_000) : Promise.reject(Error("Optional token activity is unavailable for this sign-in.")),
      ]);
      if (!valid()) return this.legacy();
      if (!this.allowed()) throw Error("Collection deferred during runtime maintenance.");
      const after = await this.codex.call("account/read", { refreshToken: false }, 15_000);
      if (!valid()) return this.legacy();
      if (!this.allowed()) throw Error("Collection deferred during runtime maintenance.");
      if (!after?.account || authFingerprint(before) !== authFingerprint(after)) {
        this.invalidate("Account changed during the read. Collecting a separate history segment.");
        this.requestObservation();
        return this.legacy();
      }
      const response = quota.status === "fulfilled" ? quota.value : null;
      const route = routing(after), quotaId = identifier(response?.accountId);
      const auth = authFingerprint(after);
      // IDs have distinct native namespaces. Missing identity on a successful read is not continuity proof.
      const binding = !response && auth === this.boundAuth ? this.boundIdentity : { quotaId, routingId: route.id, origin: route.origin };
      const verified = Boolean(binding?.quotaId || binding?.routingId);
      const key = verified ? hash(["codex-usage", binding, auth]) : hash(["unverified-connection", this.epoch, generation, auth]);
      const changedAccount = this.key && this.key !== key;
      if (changedAccount) this.accountGeneration = randomUUID();
      this.key = key;
      this.boundAuth = auth;
      this.boundIdentity = binding;
      this.identity = verified ? "verified" : "connection";
      this.accountType = after.account.type;
      if (changedAccount) { this.quotaReadAt = null; this.metadata = { ordinaryUsageAllowed: null, availableResetCredits: null,
        ordinaryUsageAllowedObservedAt: null, availableResetCreditsObservedAt: null }; }
      const fresh = response ? buckets(response) : [];
      if (response) {
        this.historyStore.merge(key, fresh, { at, seq, epoch: this.epoch }, Boolean(changedAccount || this.forceSegment));
        this.forceSegment = false;
        this.quotaReadAt = iso(at);
        if (typeof response.ordinaryUsageAllowed === "boolean") { this.metadata.ordinaryUsageAllowed = response.ordinaryUsageAllowed; this.metadata.ordinaryUsageAllowedObservedAt = iso(at); }
        const credits = integerText(response.rateLimitResetCredits?.availableCount);
        if (credits !== null) { this.metadata.availableResetCredits = credits; this.metadata.availableResetCreditsObservedAt = iso(at); }
      }
      if (tokens.status === "fulfilled") this.historyStore.mergeActivity(key, tokens.value, at);
      else this.historyStore.unavailableActivity(key, at);
      this.historyStore.prune(at);
      this.reason = response ? null : "Account quota is unavailable right now. Saved observations retain their original update times.";
      this.failures = response ? 0 : this.failures + 1;
      this.changed();
      return this.legacy();
    } catch {
      if (valid()) {
        this.reason = "Account usage could not be refreshed. Saved observations retain their original update times.";
        this.failures++;
        this.changed();
      }
      return this.legacy();
    }
  }
  history(params = {}) {
    if (!object(params) || Object.keys(params).some(key => !["range", "cursor"].includes(key))) throw Error("Unsupported usage history query.");
    const range = params.range ?? "24h";
    if (!["24h", "7d", "30d"].includes(range)) throw Error("Choose a 24-hour, 7-day or 30-day usage view.");
    let after = null;
    if (params.cursor !== undefined && params.cursor !== null) {
      if (typeof params.cursor !== "string" || params.cursor.length > 2048) throw Error("Invalid usage cursor.");
      try {
        const cursor = JSON.parse(Buffer.from(params.cursor, "base64url").toString());
        if (cursor.generation !== this.accountGeneration || cursor.range !== range || !identifier(cursor.bucket) || !["primary", "secondary"].includes(cursor.slot)) throw Error();
        after = { bucket: cursor.bucket, slot: cursor.slot };
      } catch { throw Error("Usage history changed. Return to the first page."); }
    }
    const at = this.clock(), page = this.key && !this.stopped ? this.historyStore.page(this.key, range, after, at) : null;
    return { version: 1, range, accountGeneration: this.accountGeneration, identity: this.identity, collectedAt: iso(at),
      quotaReadAt: this.quotaReadAt, tokenReadAt: page?.activity.readAt ?? null, nextAttemptAt: this.nextAttemptAt ?? null,
      reason: this.reason, windows: page?.windows ?? [],
      nextCursor: page?.after ? Buffer.from(JSON.stringify({ generation: this.accountGeneration, range, ...page.after })).toString("base64url") : null,
      activity: page?.activity ?? emptyActivity(), retentionDays: 90 };
  }
}
