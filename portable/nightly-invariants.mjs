#!/usr/bin/env node
// @ts-check
// Nightly production-copy replay. Copies the production stores with SQLite's
// online backup (the source is opened read-only and never written), runs the
// invariant checker and the key-flow simulations against the copies, writes a
// JSON report plus a short Markdown summary, and deletes the copies.
//
//   node portable/nightly-invariants.mjs --config <portable config.json> --out <directory>
//   node portable/nightly-invariants.mjs --hub-data <dir> --node-data <dir> --out <directory>
//
// Exit status: 0 when the job ran (findings or not), 2 when it could not run,
// 1 with --fail-on-high when any high finding exists.

import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { checkPaths } from '../bot-bridge/state-invariants.mjs';
import { runSimulations } from './replay-simulations.mjs';

/** @typedef {import('../bot-bridge/state-invariants.mjs').Finding} Finding */

const FILES = /** @type {const} */ ({ hub: 'control.sqlite', node: 'native-control.sqlite', journal: 'node-journal.sqlite' });
const KEEP_REPORTS = 30;

/** Data directories from a portable config: the hub's, and the agent's (its own file in combined mode). */
export function dataDirectories(/** @type {string} */ configPath) {
  const c = JSON.parse(readFileSync(configPath, 'utf8'));
  const agent = c.mode === 'both' && c.agentConfigFile ? JSON.parse(readFileSync(c.agentConfigFile, 'utf8')) : c.mode === 'agent' ? c : null;
  return { hub: c.mode === 'agent' ? null : c.dataDirectory, node: agent?.dataDirectory ?? null };
}

/**
 * Online backup of one live database into `target`. The source connection is
 * read-only; backup only reads its pages and copes with concurrent writers.
 * @param {string} source @param {string} target
 */
export async function copyDatabase(source, target) {
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000');
    await backup(db, target, { rate: 256 });
  } finally { db.close(); }
  chmodSync(target, 0o600);
}

/**
 * @param {{hubData?:string|null,nodeData?:string|null,out:string,now?:number,keepCopies?:boolean}} o
 */
export async function nightly({ hubData = null, nodeData = null, out, now = Date.now(), keepCopies = false }) {
  const started = Date.now();
  const work = mkdtempSync(join(tmpdir(), 'dawar-invariants-'));
  chmodSync(work, 0o700);
  /** @type {{hub?:string,node?:string,journal?:string}} */ const copies = {};
  /** @type {Record<string,string>} */ const sources = {};
  try {
    for (const [key, file] of /** @type {Array<['hub'|'node'|'journal', string]>} */ (Object.entries(FILES))) {
      const dir = key === 'hub' ? hubData : nodeData, source = dir ? join(dir, file) : null;
      if (!source || !existsSync(source)) continue;
      copies[key] = join(work, file);
      sources[key] = source;
      await copyDatabase(source, copies[key]);
    }
    if (!Object.keys(copies).length) throw Error('No production database was found to copy.');
    const invariants = checkPaths(copies, { now, budgetMs: 60000, rowLimit: 2000, maxFindings: 500 });
    const simulations = await runSimulations(copies, { now });
    const findings = [...invariants.findings, ...simulations.flatMap(s => s.findings)];
    const counts = { high: 0, medium: 0, low: 0 };
    for (const f of findings) counts[f.severity]++;
    const report = { version: 1, kind: 'nightly-invariants', checkedAt: new Date(now).toISOString(), durationMs: Date.now() - started, sources,
      counts, invariants, simulations: simulations.map(s => ({ name: s.name, checked: s.checked, findings: s.findings.length, error: s.error })), findings };
    write(out, report);
    return report;
  } finally {
    if (!keepCopies) rmSync(work, { recursive: true, force: true });
  }
}

/** @param {string} out @param {any} report */
function write(out, report) {
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const stamp = report.checkedAt.replace(/[:.]/g, '-');
  writeFileSync(join(out, `invariants-${stamp}.json`), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  writeFileSync(join(out, 'latest.md'), markdown(report), { mode: 0o600 });
  const old = readdirSync(out).filter(name => /^invariants-.*\.json$/.test(name)).sort().slice(0, -KEEP_REPORTS);
  for (const name of old) rmSync(join(out, name), { force: true });
}

/** @param {any} report */
export function markdown(report) {
  const lines = [`# State invariants, ${report.checkedAt}`, '',
    `${report.counts.high} high, ${report.counts.medium} medium, ${report.counts.low} low. Ran in ${Math.round(report.durationMs / 100) / 10} s on copies of: ${Object.values(report.sources).join(', ')}.`, '',
    '| Simulation | Checked | Findings | Error |', '|---|---|---|---|',
    ...report.simulations.map((/** @type {any} */ s) => `| ${s.name} | ${s.checked} | ${s.findings} | ${s.error ?? ''} |`), ''];
  if (report.invariants.errors.length) lines.push('Checker errors:', ...report.invariants.errors.map((/** @type {string} */ e) => `- ${e}`), '');
  for (const f of /** @type {Finding[]} */ (report.findings))
    lines.push(`## ${f.severity.toUpperCase()} · ${f.check} · ${f.botName ?? f.botId ?? f.store}`, '', f.message, '', `Next: ${f.suggestedAction}`, '', `Record: ${f.store} ${f.record.kind} \`${f.record.id}\``, '');
  if (!report.findings.length) lines.push('No findings.');
  return lines.join('\n') + '\n';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { config: { type: 'string' }, 'hub-data': { type: 'string' }, 'node-data': { type: 'string' },
    out: { type: 'string' }, 'fail-on-high': { type: 'boolean' }, 'keep-copies': { type: 'boolean' } } });
  try {
    const dirs = values.config ? dataDirectories(resolve(values.config)) : { hub: null, node: null };
    const out = resolve(values.out ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'dawar-todo', 'invariants'));
    const report = await nightly({ hubData: values['hub-data'] ?? dirs.hub, nodeData: values['node-data'] ?? dirs.node, out, keepCopies: values['keep-copies'] === true });
    console.log(JSON.stringify({ event: 'invariants.nightly', checkedAt: report.checkedAt, counts: report.counts, out }));
    process.exitCode = values['fail-on-high'] && report.counts.high ? 1 : 0;
  } catch (error) {
    console.error(JSON.stringify({ event: 'invariants.nightly.failed', message: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 2;
  }
}
