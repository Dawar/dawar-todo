// @ts-check
// Key-flow simulations against COPIES of the production stores. They load the
// real bridge runtime over the copied native-control.sqlite (with a stand-in
// native process that answers nothing) and the copied hub store, then run the
// real code paths: snapshots, the hub's queue admission gate, the shared idle
// check and native error recovery resume with the recorded rows. A copy may be
// modified by these runs; production files are never opened here.

import { join } from 'node:path';
import { Store } from '../bot-bridge/store.mjs';
import { BotRuntime } from '../bot-bridge/runtime.mjs';
import { MinimalCodex } from '../bot-bridge/claude-test-support.mjs';
import { captureActivity } from '../bot-bridge/turn-state.mjs';
import { stagedQueue } from '../bot-bridge/prompt-queue.mjs';
import { agentSnapshot } from './agent-snapshot.mjs';
import { fingerprint } from './protocol.mjs';
import { bridgeBlockers, age } from '../bot-bridge/state-invariants.mjs';

/** @typedef {import('../bot-bridge/state-invariants.mjs').Finding} Finding */
/** @typedef {{name:string,checked:number,findings:Finding[],error:string|null}} Simulation */

const HOUR = 3600000;
const IDENTITY = /** @type {const} */ (['id', 'slug', 'threadId', 'executionMode', 'provider', 'archived', 'deletedAt']);
/** Errors that are programming faults rather than a recovery deliberately holding. */
const FAULT = /cannot be bound|is not a function|Cannot read properties|is not defined|is not iterable|SQLITE_|SQLite/;

/**
 * @param {Finding['check']} check @param {Finding['severity']} severity @param {'hub'|'node'} store
 * @param {Record<string, any>|null} bot @param {{kind:string,id:string}} record @param {string} message @param {string} suggestedAction
 * @returns {Finding}
 */
const finding = (check, severity, store, bot, record, message, suggestedAction) => ({
  key: `sim:${check}:${record.kind}:${record.id}`, check, severity, store, botId: bot?.id ?? null, botName: bot ? bot.name ?? bot.slug ?? bot.id : null,
  record, message, suggestedAction, ageMs: null });

/**
 * @param {string} name @param {()=>Promise<{checked:number,findings:Finding[]}>|{checked:number,findings:Finding[]}} fn
 * @returns {Promise<Simulation>}
 */
async function simulation(name, fn) {
  try { return { name, ...(await fn()), error: null }; }
  catch (error) { return { name, checked: 0, findings: [], error: error instanceof Error ? error.message : String(error) }; }
}
/** @param {{bots():Array<Record<string, any>>}} store */
const live = store => store.bots().filter(b => !b.archived && !b.archiving && !b.deletedAt);

/**
 * @param {{hub?:string|null,node?:string|null}} copies Paths of COPIED databases.
 * @param {{now?:number}} [options]
 * @returns {Promise<Simulation[]>}
 */
export async function runSimulations(copies, { now = Date.now() } = {}) {
  const hub = copies.hub ? new Store(copies.hub) : null, node = copies.node ? new Store(copies.node) : null;
  /** @type {BotRuntime|null} */ let runtime = null;
  try {
    if (node && copies.node) runtime = new BotRuntime({ store: node, codex: new MinimalCodex(), root: join(copies.node, '..', 'workspaces') });
    const r = runtime;
    /** @type {Array<Record<string, any>>} */
    const placements = hub && hub.db.prepare("SELECT 1 FROM sqlite_master WHERE name='portable_placements'").get()
      ? /** @type {Array<Record<string, any>>} */ (hub.db.prepare('SELECT * FROM portable_placements ORDER BY bot_id').all()) : [];
    const nodeBot = (/** @type {string} */ id) => { try { return node?.bot(id) ?? null; } catch { return null; } };
    const results = [];

    // 1. Snapshot equivalence: the node's fresh snapshot of each placed bot
    // agrees with the hub's record and the hub's cached snapshot on identity.
    results.push(await simulation('snapshot-equivalence', () => {
      const findings = [];
      if (!r || !hub) return { checked: 0, findings };
      let checked = 0;
      for (const p of placements) {
        const n = nodeBot(p.bot_id); let h = null;
        try { h = hub.bot(p.bot_id); } catch { /* reported below */ }
        if (!n || !h) {
          if (n || h) findings.push(finding('sim-snapshot-missing', 'medium', 'hub', h ?? n, { kind: 'bot', id: p.bot_id },
            `Bot is placed on this node but exists only in the ${n ? 'node' : 'hub'} store.`, 'Re-run creation reconciliation for this bot or remove the stale placement.'));
          continue;
        }
        checked++;
        const snap = agentSnapshot(r.snapshot(p.bot_id), p.bot_id).bots[0];
        const cachedRow = /** @type {{result:string}|undefined} */ (hub.db.prepare("SELECT result FROM portable_rpc_cache WHERE bot_id=? AND epoch=? AND method='snapshot' AND params_hash=?").get(p.bot_id, p.epoch, fingerprint({})));
        const cached = cachedRow ? JSON.parse(cachedRow.result)?.bots?.find((/** @type {{id:string}} */ b) => b.id === p.bot_id) : null;
        for (const [label, other] of /** @type {Array<[string, Record<string, any>|null]>} */ ([['hub record', h], ['hub cached snapshot', cached]])) {
          if (!other) continue;
          const differs = IDENTITY.filter(f => (other[f] ?? null) !== (snap?.[f] ?? null));
          if (differs.length) findings.push(finding('sim-snapshot-mismatch', 'medium', 'hub', h, { kind: 'bot', id: p.bot_id },
            `The node's snapshot and the ${label} disagree on ${differs.map(f => `${f} (${JSON.stringify(other[f] ?? null)} vs ${JSON.stringify(snap?.[f] ?? null)})`).join(', ')}.`,
            'The browser shows the hub view; find which side missed an update and replay it from the original event.'));
        }
      }
      return { checked, findings };
    }));

    // 2. Queue admission: the hub scheduler's per-bot gate (hub-controls tick)
    // with the node's real work view. An admissible head that waited an hour
    // means the scheduler is not dispatching it.
    results.push(await simulation('queue-admission', () => {
      const findings = [];
      if (!r || !hub) return { checked: 0, findings };
      let checked = 0;
      for (const p of placements) {
        let bot; try { bot = hub.bot(p.bot_id); } catch { continue; }
        const head = stagedQueue(hub, bot.id)[0];
        if (!head || head.state !== 'queued' || bot.archived || bot.deletedAt) continue;
        checked++;
        const waited = now - Date.parse(head.createdAt);
        if (!(waited > HOUR)) continue;
        const n = nodeBot(bot.id);
        const mailbox = hub.db.prepare("SELECT operation_id,state FROM portable_mailbox WHERE bot_id=? AND state<>'terminal' LIMIT 1").get(bot.id);
        const work = n ? r.primary.work(n) : null;
        const holds = [p.stopped ? 'Stop' : null, bot.queuePaused ? 'queue paused' : null, hub.list('planExecution', bot.id).some(x => x.state === 'dispatching') ? 'Plan dispatching' : null,
          mailbox ? `mailbox row ${/** @type {any} */ (mailbox).state}` : null, !n ? 'missing on node' : null,
          work && (work.state !== 'ready' || work.activeTurnId || work.paused || work.goal?.status === 'active') ? `node work ${work.state}${work.activeTurnId ? ' with active turn' : ''}` : null].filter(Boolean);
        if (!holds.length) findings.push(finding('sim-queue-head-stalled', 'high', 'hub', bot, { kind: 'promptQueue', id: head.id },
          `The queue head has waited ${age(waited)}, and every admission gate is open: the hub would dispatch it now.`,
          'Check that the hub scheduler tick runs and that the node answers work.read; the item itself is fine.'));
        else if (waited > 6 * HOUR) findings.push(finding('sim-queue-head-held', 'low', 'hub', bot, { kind: 'promptQueue', id: head.id },
          `The queue head has waited ${age(waited)}, held by: ${holds.join(', ')}.`, 'Expected while the hold lasts; clear the hold if it is stale.'));
      }
      return { checked, findings };
    }));

    // 3. Idle check: the real shared idle predicate against the store's
    // pending work, for every single-thread bot on the node.
    results.push(await simulation('idle-check', () => {
      const findings = [];
      if (!r || !node) return { checked: 0, findings };
      let checked = 0;
      for (const bot of live(node).filter(b => b.executionMode === 'single-thread' && b.threadId)) {
        checked++;
        const idle = r.memoryMaintenance.idle(bot), blockers = bridgeBlockers(node.db, bot);
        if (!idle && !blockers.length) findings.push(finding('sim-idle-busy-without-blocker', 'high', 'node', bot, { kind: 'bot', id: bot.id },
          'The shared idle check reports this bot busy, but the store shows no pending work. Proactive reviews and memory maintenance skip it.',
          'Find the term of the idle predicate that is true for this bot and fix it.'));
        if (idle && blockers.length) findings.push(finding('sim-idle-ignores-work', 'high', 'node', bot, { kind: 'bot', id: bot.id },
          `The shared idle check reports this bot idle while it has: ${blockers.join(', ')}. Maintenance could start under real work.`,
          'Add the missing term to the idle predicate.'));
      }
      return { checked, findings };
    }));

    // 4. Recovery resume with the recorded rows: what the next recovery pass
    // would do with each open native error recovery, against an idle thread.
    results.push(await simulation('recovery-resume', async () => {
      const findings = [];
      if (!r || !node) return { checked: 0, findings };
      let checked = 0;
      for (const row of node.list('nativeErrorRecovery').filter(x => !['recovered', 'superseded'].includes(x.phase ?? ''))) {
        const bot = nodeBot(row.botId);
        if (!bot || bot.archived || bot.deletedAt || bot.threadId !== row.threadId) continue;
        checked++;
        const read = async () => ({ id: bot.threadId, status: { type: 'idle' } });
        const call = /** @type {any} */ (async () => ({}));
        call.remainingMs = () => 12000;
        const error = await Promise.resolve().then(() => r.nativeErrorRecovery.resume(bot.id, captureActivity(/** @type {any} */ (r), bot.id), read, 'idle', call)).then(() => null, e => e);
        if (error && !error.nativeRecoverySafe && FAULT.test(String(error.message)))
          findings.push(finding('sim-recovery-resume-fault', 'high', 'node', bot, { kind: 'nativeErrorRecovery', id: row.id },
            `Resuming the recorded recovery (phase ${row.phase}) fails with a code fault: ${String(error.message).slice(0, 300)}. Every pass would repeat it.`,
            'Fix the recovery path for this row shape; the bot refuses input until recovery settles.'));
      }
      return { checked, findings };
    }));
    return results;
  } finally {
    runtime?.usage.stop();
    hub?.close(); node?.close();
  }
}
