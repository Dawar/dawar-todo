import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { readPrivate } from './private-file.mjs';

export const retainedHash = row => createHash('sha256').update(JSON.stringify(row, Object.keys(row).sort())).digest('hex');
const digest = text => createHash('sha256').update(text).digest('hex');
const kinds = new Set(['portable_async_work', 'voice_effects', 'voice_values']);
const refused = () => Error('Private retained-record lifetime evidence is invalid. Preserve the original records.');
const dead = pid => {if(!Number.isSafeInteger(pid)||pid<1)return false;try{process.kill(pid,0);return false;}catch(error){return error.code==='ESRCH';}};

// An owner-reviewed private contract describes ended LIFETIMES, not successful
// effects. Every entry binds unchanged original bytes and separately retained
// evidence. It never settles a receipt, enables replay or authorizes new work.
export class RetainedRecords {
  constructor(path) {
    this.entries = new Map(); this.fingerprint = digest('empty-retained-contract-v1');
    if (!path) return;
    if (!isAbsolute(path)) throw refused();
    const text = readPrivate(path, 128 * 1024), contract = JSON.parse(text);
    if (contract.version !== 1 || contract.kind !== 'retained-lifetime-contract' || !Array.isArray(contract.entries) || contract.entries.length > 128) throw refused();
    for (const entry of contract.entries) {
      if (!kinds.has(entry.table) || typeof entry.id !== 'string' || !entry.id || entry.id.length > 1024 || !/^[a-f0-9]{64}$/.test(entry.recordSHA256) ||
          !isAbsolute(entry.evidencePath ?? '') || !/^[a-f0-9]{64}$/.test(entry.evidenceSHA256)) throw refused();
      const evidenceText = readPrivate(entry.evidencePath, 32768), evidence = JSON.parse(evidenceText);
      if (digest(evidenceText) !== entry.evidenceSHA256 || evidence.version !== 1 || evidence.kind !== 'reviewed-retained-lifetime' ||
          typeof evidence.authorityId !== 'string' || !evidence.authorityId || evidence.table !== entry.table || evidence.id !== entry.id ||
          evidence.recordSHA256 !== entry.recordSHA256 || evidence.noReplay !== true ||
          !['proven-pre-effect-refusal','original-native-terminal','provider-terminal','original-process-ended'].includes(evidence.basis) ||
          !/^[a-f0-9]{64}$/.test(evidence.originalEvidenceSHA256 ?? '') || !evidence.originalIdentity || !Number.isFinite(Date.parse(evidence.observedAt??''))) throw refused();
      if(evidence.basis==='original-process-ended'&&(!dead(evidence.originalIdentity.pid)||evidence.externalOutcome!=='unknown'))throw refused();
      const key = `${entry.table}:${entry.id}`;
      if (this.entries.has(key)) throw refused();
      this.entries.set(key, Object.freeze({ ...entry, basis: evidence.basis,processPid:evidence.basis==='original-process-ended'?evidence.originalIdentity.pid:null }));
    }
    this.fingerprint = digest(text);
  }
  retained(table, id, row) {
    const entry = this.entries.get(`${table}:${id}`);
    return Boolean(entry && row && retainedHash(row) === entry.recordSHA256 && (!entry.processPid||dead(entry.processPid)));
  }
}
