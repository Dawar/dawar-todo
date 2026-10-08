// Only the independently reviewed original pre-effect refusals are passive.
// Retain uncertain records and never execute/recover an operation here.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import review from './legacy-manager-rejections.json' with { type: 'json' };

const hash = value => createHash('sha256').update(value).digest('hex');
const producerMatches = hash(readFileSync(new URL('./manager.mjs', import.meta.url))) === review.managerSourceSha256;
export function legacyManagerRejection(raw, target, bot, evidence = review, sourceMatches = producerMatches) {
  try {
    if (!sourceMatches || typeof raw !== 'string' || Buffer.byteLength(raw) > 1024 * 1024) return null;
    const row = JSON.parse(raw);
    const known = evidence.records.find(r => r.id === row.id);
    const guard = known && evidence.guards[known.operation];
    if (!known || !guard || hash(raw) !== known.recordSha256 || row.state !== 'uncertain' ||
        Object.hasOwn(row, 'result') || row.origin || bot?.id !== known.botId || bot.deletedAt ||
        ['id', 'botId', 'name', 'opId', 'fingerprint', 'createdAt', 'finishedAt', 'error'].some(k => row[k] !== known[k]) ||
        row.name !== guard.name || row.error !== guard.error || typeof row.createdAt !== 'string' || typeof row.finishedAt !== 'string' ||
        !Number.isFinite(Date.parse(row.createdAt)) || !Number.isFinite(Date.parse(row.finishedAt)) ||
        Date.parse(row.finishedAt) < Date.parse(row.createdAt)) return null;
    const args = row.args;
    if (!args || Array.isArray(args) || args.operation !== known.operation || args.operationId !== row.opId ||
        Object.entries(args).some(([key, value]) => typeof value !== guard.argumentTypes[key]) ||
        hash(`${row.botId}:${row.opId}`) !== row.id ||
        hash(JSON.stringify({ name: row.name, args })) !== row.fingerprint) return null;
    if (guard.targetKind && (args[guard.targetArgument] !== known.targetId ||
        target?.id !== known.targetId || target.botId !== row.botId)) return null;
    if (!guard.targetKind && Object.hasOwn(args, 'prompt')) return null;
    return { id: row.id, botId: row.botId, fingerprint: row.fingerprint, recordSha256: known.recordSha256,
      classification: 'reviewed-pre-effect-rejection', targetId: known.targetId };
  } catch { return null; }
}

export function passiveLegacyManagerRejections(store) {
  const rows = store.db.prepare("SELECT CASE WHEN length(CAST(json AS BLOB))<=1048576 THEN json ELSE NULL END AS json FROM records WHERE kind='managerOperation' AND json_extract(json,'$.state') IN ('dispatching','uncertain') LIMIT 13").all();
  if (rows.length > review.records.length || rows.some(row => typeof row.json !== 'string')) return [];
  return rows.flatMap(({ json }) => {
    const row = JSON.parse(json), known = review.records.find(r => r.id === row.id);
    const guard = known && review.guards[known.operation];
    const target = guard?.targetKind && store.db.prepare("SELECT json_object('id',json_extract(json,'$.id'),'botId',json_extract(json,'$.botId')) AS json FROM records WHERE kind=? AND id=?").get(guard.targetKind, known.targetId);
    const bot = store.db.prepare("SELECT json FROM bots WHERE id=?").get(row.botId);
    const proof = legacyManagerRejection(json, target ? JSON.parse(target.json) : null, bot ? JSON.parse(bot.json) : null);
    return proof ? [proof] : [];
  });
}
