import { randomUUID } from "node:crypto";
import { usageForecast } from "../lib/usage-history.ts";

const HOUR = 3_600_000, DAY = 24 * HOUR;
const ranges = { "24h": DAY, "7d": 7 * DAY, "30d": 30 * DAY };
const iso = value => new Date(value).toISOString();
const number = value => typeof value === "number" && Number.isFinite(value);
const emptyField = () => ({ value: null, observedAt: null, version: null });
export const integerText = value => typeof value === "bigint" && value >= 0n ? value.toString() :
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) :
    typeof value === "string" && /^\d+$/.test(value) ? value : null;
export const activityFields = ["lifetimeTokens", "peakDailyTokens", "longestRunningTurnSec", "currentStreakDays", "longestStreakDays"];
const validDate = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

/** Separate numeric account metadata. It never reads bots, native threads or operation receipts. */
export class UsageHistoryStore {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage_windows(account TEXT NOT NULL,bucket TEXT NOT NULL,slot TEXT NOT NULL,json TEXT NOT NULL,updated_at INTEGER NOT NULL,
        PRIMARY KEY(account,bucket,slot));
      CREATE TABLE IF NOT EXISTS usage_samples(account TEXT NOT NULL,bucket TEXT NOT NULL,slot TEXT NOT NULL,segment TEXT NOT NULL,minute INTEGER NOT NULL,
        at INTEGER NOT NULL,used_percent REAL NOT NULL,PRIMARY KEY(account,bucket,slot,segment,minute));
      CREATE INDEX IF NOT EXISTS usage_sample_time ON usage_samples(account,bucket,slot,at);
      CREATE INDEX IF NOT EXISTS usage_sample_retention ON usage_samples(at);
      CREATE TABLE IF NOT EXISTS usage_tokens(account TEXT NOT NULL,date TEXT NOT NULL,tokens TEXT NOT NULL,observed_at INTEGER NOT NULL,PRIMARY KEY(account,date));
      CREATE TABLE IF NOT EXISTS usage_activity(account TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at INTEGER NOT NULL);`);
  }
  state(account, bucket, slot) {
    const row = this.db.prepare("SELECT json FROM usage_windows WHERE account=? AND bucket=? AND slot=?").get(account, bucket, slot);
    return row ? JSON.parse(row.json) : null;
  }
  /** Nullable fields are unavailable observations, not permission to clear or freshen old values. */
  merge(account, snapshots, observation, forceSegment = false) {
    return this.store.transaction(() => {
      for (const [bucket, value] of snapshots) for (const slot of ["primary", "secondary"]) {
        const window = value?.[slot];
        if (!window || typeof window !== "object") continue;
        const previous = this.state(account, bucket, slot);
        const state = previous ? structuredClone(previous) : {
          limitId: value.limitId ?? bucket, limitName: null, model: null, metadataVersion: null, slot,
          segment: randomUUID(), segmentStartedAt: observation.at,
          usedPercent: emptyField(), windowDurationMins: emptyField(), resetsAt: emptyField(),
        };
        let percentageObserved = false, split = forceSegment && Boolean(previous);
        for (const key of ["usedPercent", "windowDurationMins", "resetsAt"]) {
          const next = window[key];
          if (!number(next) || (key === "usedPercent" ? next < 0 || next > 100 :
            !Number.isSafeInteger(next) || next <= 0 || key === "resetsAt" && !Number.isFinite(new Date(next * 1000).getTime()))) continue;
          const field = state[key];
          if (field.version?.epoch === observation.epoch && field.version.seq > observation.seq) continue;
          if (previous && (key === "usedPercent" ? field.value !== null && next < field.value : next !== field.value)) split = true;
          state[key] = { value: next, observedAt: iso(observation.at), version: { epoch: observation.epoch, seq: observation.seq } };
          if (key === "usedPercent") percentageObserved = true;
        }
        for (const [key, native] of [["limitName", "limitName"], ["model", "normalModelSlug"]]) {
          if (!(state.metadataVersion?.epoch === observation.epoch && state.metadataVersion.seq > observation.seq) &&
              typeof value[native] === "string" && value[native].length <= 256) {
            if (previous && key === "model" && state[key] !== null && state[key] !== value[native]) split = true;
            state[key] = value[native];
            state.metadataVersion = { epoch: observation.epoch, seq: observation.seq };
          }
        }
        if (split) { state.segment = randomUUID(); state.segmentStartedAt = observation.at; }
        this.db.prepare(`INSERT INTO usage_windows VALUES(?,?,?,?,?) ON CONFLICT(account,bucket,slot)
          DO UPDATE SET json=excluded.json,updated_at=excluded.updated_at`).run(account, bucket, slot, JSON.stringify(state), observation.at);
        if (percentageObserved) {
          // One observation per minute/window, even if a reset arrives during that minute.
          this.db.prepare("DELETE FROM usage_samples WHERE account=? AND bucket=? AND slot=? AND minute=? AND segment<>?")
            .run(account, bucket, slot, Math.floor(observation.at / 60_000), state.segment);
          this.db.prepare(`INSERT INTO usage_samples VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(account,bucket,slot,segment,minute) DO UPDATE SET at=excluded.at,used_percent=excluded.used_percent
          WHERE excluded.at>=usage_samples.at`).run(account, bucket, slot, state.segment, Math.floor(observation.at / 60_000), observation.at, state.usedPercent.value);
        }
      }
    });
  }
  activity(account) {
    const row = this.db.prepare("SELECT json FROM usage_activity WHERE account=?").get(account);
    return row ? JSON.parse(row.json) : { readAt: null, state: "collecting", summary: Object.fromEntries(activityFields.map(key => [key, emptyField()])) };
  }
  mergeActivity(account, response, at) {
    const activity = this.activity(account);
    let observed = false;
    for (const key of activityFields) {
      const value = integerText(response?.summary?.[key]);
      if (value !== null) { activity.summary[key] = { value, observedAt: iso(at) }; observed = true; }
    }
    const cutoff = iso(at - 90 * DAY).slice(0, 10);
    this.store.transaction(() => {
      if (Array.isArray(response?.dailyUsageBuckets)) for (const bucket of response.dailyUsageBuckets) {
        const tokens = integerText(bucket?.tokens);
        // Retain the service's date label. No local-time conversion or inferred zero buckets.
        if (!validDate(bucket?.startDate) || tokens === null || bucket.startDate < cutoff) continue;
        this.db.prepare(`INSERT INTO usage_tokens VALUES(?,?,?,?) ON CONFLICT(account,date)
          DO UPDATE SET tokens=excluded.tokens,observed_at=excluded.observed_at`).run(account, bucket.startDate, tokens, at);
        observed = true;
      }
      activity.state = !response?.usagePrecisionUnavailable && (observed || Array.isArray(response?.dailyUsageBuckets)) ? "available" : "unavailable";
      activity.readAt = iso(at);
      this.db.prepare("INSERT OR REPLACE INTO usage_activity VALUES(?,?,?)").run(account, JSON.stringify(activity), at);
    });
  }
  unavailableActivity(account, at) {
    const value = { ...this.activity(account), state: "unavailable" };
    this.db.prepare("INSERT OR REPLACE INTO usage_activity VALUES(?,?,?)").run(account, JSON.stringify(value), at);
  }
  prune(at) {
    if (this.prunedAt && at - this.prunedAt < HOUR) return;
    this.store.transaction(() => {
      this.db.prepare("DELETE FROM usage_samples WHERE at<?").run(at - 90 * DAY);
      this.db.prepare("DELETE FROM usage_tokens WHERE date<?").run(iso(at - 90 * DAY).slice(0, 10));
      this.db.prepare("DELETE FROM usage_windows WHERE updated_at<?").run(at - 90 * DAY);
      this.db.prepare("DELETE FROM usage_activity WHERE updated_at<?").run(at - 90 * DAY);
    });
    this.prunedAt = at;
  }
  page(account, range, after, at) {
    const start = at - ranges[range];
    const rows = this.db.prepare(`SELECT bucket,slot,json FROM usage_windows WHERE account=?
      AND (bucket>? OR (bucket=? AND slot>?)) ORDER BY bucket,slot LIMIT 7`)
      .all(account, after?.bucket ?? "", after?.bucket ?? "", after?.slot ?? "");
    const windows = rows.slice(0, 6).map(row => {
      const state = JSON.parse(row.json);
      // SQL samples one point per hour using the latest exact observation; a changed segment breaks the chart line.
      const points = this.db.prepare(`SELECT at,used_percent,segment FROM (
        SELECT at,used_percent,segment,ROW_NUMBER() OVER (PARTITION BY CAST(at/3600000 AS INTEGER) ORDER BY at DESC,minute DESC) AS rank
        FROM usage_samples WHERE account=? AND bucket=? AND slot=? AND at>=? AND at<=?)
        WHERE rank=1 ORDER BY at LIMIT 722`).all(account, row.bucket, row.slot, start, at)
        .map(value => ({ at: value.at, usedPercent: value.used_percent, segment: value.segment }));
      const coverage = this.db.prepare(`SELECT COUNT(*) AS observations,MIN(at) AS first,MAX(at) AS last
        FROM usage_samples WHERE account=? AND bucket=? AND slot=? AND at>=? AND at<=?`).get(account, row.bucket, row.slot, start, at);
      const recent = this.db.prepare(`SELECT at,used_percent FROM usage_samples
        WHERE account=? AND bucket=? AND slot=? AND segment=? AND at>=? AND at<=? ORDER BY at LIMIT 1442`)
        .all(account, row.bucket, row.slot, state.segment, at - DAY, at)
        .map(value => ({ at: value.at, usedPercent: value.used_percent, segment: state.segment }));
      const validIdentity = state.windowDurationMins.value !== null && state.resetsAt.value !== null &&
        state.usedPercent.observedAt && Date.parse(state.usedPercent.observedAt) >= (state.segmentStartedAt ?? 0);
      const stale = [state.usedPercent, state.windowDurationMins, state.resetsAt].some(field =>
        field.observedAt && at - Date.parse(field.observedAt) >= 90 * 60_000);
      const forecasts = [6, 24].map(horizon => {
        const value = usageForecast(recent, horizon, at, state.resetsAt.value);
        return stale ? { ...value, state: "stale" } : validIdentity ? value : { ...value, state: "collecting", pointsPerDay: null, depletionHours: null, resetFirst: null, projectedRemainingAtReset: null };
      });
      const resetHours = state.resetsAt.value === null ? null : (state.resetsAt.value * 1000 - at) / HOUR;
      const field = key => ({ value: state[key].value, observedAt: state[key].observedAt });
      return { id: `${row.bucket}:${row.slot}`, limitId: state.limitId, limitName: state.limitName, model: state.model, slot: row.slot,
        usedPercent: field("usedPercent"), windowDurationMins: field("windowDurationMins"), resetsAt: field("resetsAt"),
        sustainablePointsPerDay: !stale && validIdentity && state.usedPercent.value !== null && resetHours > 0
          ? Math.max(0, 100 - state.usedPercent.value) * 24 / resetHours : null,
        forecasts, points, coverage: { observations: coverage.observations, from: coverage.first, to: coverage.last, chartLimited: points.length > 721 } };
    });
    const activity = this.activity(account);
    const daily = this.db.prepare("SELECT date,tokens,observed_at FROM usage_tokens WHERE account=? AND date>=? ORDER BY date LIMIT 92")
      .all(account, iso(start).slice(0, 10)).map(value => ({ date: value.date, tokens: value.tokens, observedAt: iso(value.observed_at) }));
    return { windows, after: rows.length > 6 ? { bucket: rows[5].bucket, slot: rows[5].slot } : null,
      activity: { ...activity, state: activity.state === "available" && activity.readAt && at - Date.parse(activity.readAt) >= 90 * 60_000 ? "stale" : activity.state, daily } };
  }
}
