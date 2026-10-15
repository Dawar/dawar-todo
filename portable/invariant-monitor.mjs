// @ts-check
// Periodic, read-only state invariant scans inside the running agent and hub.
// Scans use their own read-only connections and yield between checks, so they
// never hold a write lock or block admission. High-severity findings go out
// once each through the bot notification path; the hub keeps the latest
// report per store for Settings → System health.

import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { openReadOnly, checkInvariantsYielding, findingText } from '../bot-bridge/state-invariants.mjs';

/** @typedef {import('../bot-bridge/state-invariants.mjs').Report} Report */
/** @typedef {import('../bot-bridge/state-invariants.mjs').Finding} Finding */
/** @typedef {import('../bot-bridge/state-invariants.mjs').Options} Options */
/** @typedef {{hub?:string|null,node?:string|null,journal?:string|null}} Paths */

export const HEALTH_INTERVAL_MS = 10 * 60000;
/** Findings a node sends to the hub per report; the counts stay exact. */
export const NODE_REPORT_FINDINGS = 100;

/**
 * Notifies each high finding once while it persists. A key that clears and
 * later returns notifies again; the notification ID also dedupes downstream.
 * @param {Report} report @param {Set<string>} seen @param {(finding:Finding)=>unknown} notify
 */
export async function notifyHighFindings(report, seen, notify) {
  const current = new Set();
  for (const finding of report.findings) {
    if (finding.severity !== 'high') continue;
    current.add(finding.key);
    if (seen.has(finding.key)) continue;
    seen.add(finding.key);
    try { await notify(finding); } catch { seen.delete(finding.key); }
  }
  for (const key of seen) if (!current.has(key)) seen.delete(key);
}

/** The deterministic notification ID for a finding (64 hex, as the notification table requires). */
export const findingNotificationId = (/** @type {Finding} */ finding) => createHash('sha256').update(`invariant:${finding.key}`).digest('hex');

export class InvariantMonitor {
  /**
   * @param {object} o
   * @param {()=>Paths} o.paths
   * @param {()=>Options} [o.options]
   * @param {(report:Report)=>void} [o.onReport]
   * @param {((finding:Finding)=>unknown)|null} [o.notify]
   * @param {number} [o.intervalMs]
   * @param {number} [o.initialDelayMs]
   * @param {(error:unknown)=>void} [o.fault]
   */
  constructor({ paths, options = () => ({}), onReport = () => {}, notify = null, intervalMs = HEALTH_INTERVAL_MS, initialDelayMs = 2 * 60000, fault = () => {} }) {
    this.paths = paths; this.options = options; this.onReport = onReport; this.notify = notify; this.fault = fault;
    this.intervalMs = intervalMs; this.initialDelayMs = initialDelayMs;
    /** @type {Report|null} */ this.last = null;
    /** @type {Set<string>} */ this.seen = new Set();
    /** @type {Promise<Report>|null} */ this.running = null;
    /** @type {ReturnType<typeof setTimeout>|null} */ this.timer = null;
    this.stopped = false;
  }
  start() {
    if (this.timer || this.stopped) return this;
    const schedule = (/** @type {number} */ delay) => {
      this.timer = setTimeout(() => void this.run().catch(this.fault).finally(() => { if (!this.stopped) schedule(this.intervalMs); }), delay);
      this.timer.unref?.();
    };
    schedule(this.initialDelayMs);
    return this;
  }
  /** One scan. Concurrent callers share it. */
  run() {
    return this.running ??= this.scan().finally(() => { this.running = null; });
  }
  /** @returns {Promise<Report>} */
  async scan() {
    const paths = this.paths();
    /** @type {{hub?:import('node:sqlite').DatabaseSync,node?:import('node:sqlite').DatabaseSync,journal?:import('node:sqlite').DatabaseSync}} */
    const stores = {};
    let report;
    try {
      for (const key of /** @type {const} */ (['hub', 'node', 'journal'])) {
        const path = paths[key];
        if (path && existsSync(path)) stores[key] = openReadOnly(path);
      }
      report = await checkInvariantsYielding(stores, { budgetMs: 5000, ...this.options() });
    } finally { for (const db of Object.values(stores)) db.close(); }
    this.last = report;
    try { this.onReport(report); } catch (error) { this.fault(error); }
    if (this.notify) await notifyHighFindings(report, this.seen, this.notify);
    return report;
  }
  stop() { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = null; }
}

/** A bounded copy of a report for the node→hub frame. */
export function compactReport(/** @type {Report} */ report) {
  return { ...report, findings: report.findings.slice(0, NODE_REPORT_FINDINGS), truncated: report.truncated || report.findings.length > NODE_REPORT_FINDINGS };
}

const SEVERITIES = new Set(['high', 'medium', 'low']), STORES = new Set(['hub', 'node', 'journal']);
const text = (/** @type {unknown} */ v, /** @type {number} */ max) => typeof v === 'string' ? v.slice(0, max) : '';
/**
 * Validates a node's report. Untrusted shape: only known fields survive, and
 * findings about bots the node is not assigned are dropped.
 * @param {any} value @param {(botId:string)=>boolean} assigned
 * @returns {Report}
 */
export function acceptNodeReport(value, assigned) {
  if (!value || value.version !== 1 || !Array.isArray(value.findings) || value.findings.length > NODE_REPORT_FINDINGS) throw Error('Invalid health report.');
  /** @type {Finding[]} */ const findings = [];
  for (const f of value.findings) {
    if (!f || !SEVERITIES.has(f.severity) || !STORES.has(f.store) || typeof f.key !== 'string' || f.key.length > 200) throw Error('Invalid health finding.');
    const botId = typeof f.botId === 'string' ? f.botId : null;
    if (botId && !assigned(botId)) continue;
    findings.push({ key: f.key, check: text(f.check, 80), severity: f.severity, store: f.store, botId, botName: typeof f.botName === 'string' ? f.botName.slice(0, 160) : null,
      record: { kind: text(f.record?.kind, 80), id: text(f.record?.id, 300) }, message: text(f.message, 1000), suggestedAction: text(f.suggestedAction, 1000),
      ageMs: Number.isFinite(f.ageMs) ? f.ageMs : null });
  }
  const counts = { high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity]++;
  return { version: 1, checkedAt: text(value.checkedAt, 40), durationMs: Number(value.durationMs) || 0, truncated: value.truncated === true,
    counts: value.truncated === true ? { high: Math.max(counts.high, Number(value.counts?.high) || 0), medium: Math.max(counts.medium, Number(value.counts?.medium) || 0), low: Math.max(counts.low, Number(value.counts?.low) || 0) } : counts,
    findings, errors: Array.isArray(value.errors) ? value.errors.slice(0, 20).map((/** @type {unknown} */ e) => text(e, 300)) : [] };
}

/**
 * Hub-side System health: the hub's own scan plus the latest report from each
 * node, and push notifications for high findings through the existing bot
 * notification table (delivered by the site's minute maintenance).
 */
export class HubHealth {
  /**
   * @param {object} o
   * @param {string} o.controlPath
   * @param {string} o.owner
   * @param {{prepare(sql:string):{bind(...v:unknown[]):{run():Promise<unknown>}}}|null} [o.application]
   * @param {(nodeId:string)=>boolean} [o.online]
   * @param {(error:unknown)=>void} [o.fault]
   * @param {number} [o.initialDelayMs]
   */
  constructor({ controlPath, owner, application = null, online = () => false, fault = () => {}, initialDelayMs }) {
    this.owner = owner; this.application = application; this.online = online;
    /** @type {Map<string,{receivedAt:string,report:Report}>} */ this.nodes = new Map();
    /** @type {Set<string>} */ this.nodeSeen = new Set();
    this.monitor = new InvariantMonitor({ paths: () => ({ hub: controlPath }), notify: application ? f => this.notify(f) : null, fault, initialDelayMs });
  }
  start() { this.monitor.start(); return this; }
  stop() { this.monitor.stop(); }
  /** @param {Finding} finding */
  async notify(finding) {
    if (!this.application) return;
    await this.application.prepare('INSERT OR IGNORE INTO todo_bot_notifications(id,owner_key,bot_id,title,body,created_at) VALUES(?,?,?,?,?,?)')
      .bind(findingNotificationId(finding), this.owner.toLowerCase(), (finding.botId ?? 'system-health').slice(0, 180), 'System health', findingText(finding), new Date().toISOString()).run();
  }
  /** @param {string} nodeId @param {Report} report */
  async receive(nodeId, report) {
    this.nodes.set(nodeId, { receivedAt: new Date().toISOString(), report });
    if (!this.application) return;
    const scoped = { ...report, findings: report.findings.map(f => ({ ...f, key: `${nodeId}:${f.key}` })) };
    await notifyHighFindings(scoped, this.nodeSeen, f => this.notify(f));
  }
  view() {
    return { hub: this.monitor.last, nodes: [...this.nodes].map(([nodeId, v]) => ({ nodeId, online: this.online(nodeId), ...v })) };
  }
}
