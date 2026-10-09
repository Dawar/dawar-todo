import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_, v) => v && !Array.isArray(v) && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const MAX = 8;
const reader = fileURLToPath(new URL('./native_queue_receipts.py', import.meta.url));
// Reviewed retained originals only. A new terminal-looking row still blocks;
// this is not a general exemption for accepted input or unanswered questions.
const reviewedOriginals = [
  { kind:'primaryInbox', id:'peer:432942828b0fda3ba0dc17b009ea1bc7f0ecb5bde9defb74b86b34ae39b98eb2',
    botId:'bbb1ead9-1f6d-4256-a7ea-5d90c866be0c', threadId:'01a0d925-33f3-7f00-ae17-70d88902aaa9', turnId:'01a10dfc-0097-7452-8d7e-eabe373308d6',
    stableRecordSha256:'0bdd911fbaf08a23aa3196d10d8a99f1518b40441ea4ab28fe83c9c3157368fa' },
  { kind:'pending', id:'async:call_lyPF3QB2taTul9nX7DijB2U5',
    botId:'3f261c5b-9f08-4ccb-8aa1-948d42a405a7', threadId:'01a0e66e-939b-7ca1-839e-50147278592c', turnId:'01a10b13-bc93-7e80-8a40-569e4ce71224',
    rawRecordSha256:'a8f38bb9625ac6aac98c0f0b665c6bf6dd1c7463550bb2cc8bf3b5ff053d14c7' },
  { kind:'pending', id:'async:call_d097a830dc35437ab45a37c30692bb4e',
    botId:'b062a333-5f8a-4904-8bee-2b57557c6cc0', threadId:'01a0dc39-1829-7553-a951-de3d622744fb', turnId:'01a11f91-af1f-7d12-8447-ef7180eefdbf',
    rawRecordSha256:'d973f81caaa47f7eb3cb9c189d020213f3ac44bc239b617269c109d8a418c2b7' },
];

// Fixed private metadata reader, no caller path, RPC, transcript or credential.
export function readTerminalProof(input, timeout) {
  return new Promise((resolve, reject) => {
    const child = execFile('python3', ['-B', reader, '--maintenance-proof'],
      { timeout: Math.min(timeout, 7000), maxBuffer: 65536 }, (error, stdout) => {
        if (error) return reject(Error('Bounded retained terminal proof unavailable.'));
        try { resolve(JSON.parse(stdout)); } catch { reject(Error('Invalid retained terminal proof.')); }
      });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

export class MaintenanceTerminalProof {
  constructor(store, { read = readTerminalProof, fresh = nativeProofFresh, originals = reviewedOriginals } = {}) {
    Object.assign(this, { store, read, fresh, originals });
  }
  snapshot() {
    const records = [];
    for (const [kind, clause] of [['primaryInbox', "json_extract(json,'$.state')='accepted' AND json_extract(json,'$.terminalStatus') IS NULL"], ['pending', '1']]) {
      const rows = this.store.db.prepare(`SELECT id,CASE WHEN length(CAST(json AS BLOB))<=1048576 THEN json ELSE NULL END json FROM records WHERE kind=? AND ${clause} LIMIT 9`).all(kind);
      if (rows.some(r => !r.json)) return null;
      for (const r of rows) {
        const row = JSON.parse(r.json);
        if (row.id !== r.id || typeof row.id !== 'string' || typeof row.botId !== 'string') return null;
        if (kind === 'primaryInbox') {
          if (row.state !== 'accepted' || typeof row.threadId !== 'string' || typeof row.turnId !== 'string') return null;
        } else {
          const p = row.request?.params;
          if (row.async !== true || row.request?.method !== 'item/tool/requestUserInput' || row.request.id !== row.id ||
              p?.isBlocking !== false || typeof p.threadId !== 'string' || typeof p.turnId !== 'string' ||
              typeof p.itemId !== 'string' || row.id !== `async:${p.itemId}`) return null;
        }
        const original = this.originals.find(x => x.kind === kind && x.id === r.id);
        if (!original || original.botId !== row.botId || original.threadId !== (row.threadId ?? row.request?.params?.threadId) ||
            original.turnId !== (row.turnId ?? row.request?.params?.turnId)) return null;
        // Only original recovery scheduling varies before capture. Full current
        // bytes (including that time) still fence every later await/Seal/Claim.
        const stable = { ...row }; delete stable.reconcileAfter;
        if (original.rawRecordSha256 && hash(r.json) !== original.rawRecordSha256 ||
            original.stableRecordSha256 && hash(canonical(stable)) !== original.stableRecordSha256) return null;
        records.push({ kind, id: r.id, rawHash: hash(r.json), row });
      }
    }
    if (!records.length || records.length > MAX) return null;
    const bots = this.store.bots();
    const input = { bots: bots.map(b => ({ id:b.id, threadId:b.threadId, deletedAt:b.deletedAt, archived:b.archived, archiving:b.archiving })), accepted: [], questions: [] };
    for (const { kind, row:r } of records) {
      if (kind === 'primaryInbox') input.accepted.push({ id:r.id, botId:r.botId, threadId:r.threadId, turnId:r.turnId, state:r.state });
      else input.questions.push({ id:r.id, botId:r.botId, async:r.async,
        request:{ id:r.request?.id, method:r.request?.method, params:{ threadId:r.request?.params?.threadId, turnId:r.request?.params?.turnId, itemId:r.request?.params?.itemId, isBlocking:r.request?.params?.isBlocking } } });
    }
    if (Buffer.byteLength(JSON.stringify(input)) > 16384) return null;
    return { input, fingerprint:hash(JSON.stringify([records.map(r => [r.kind,r.id,r.rawHash]), bots])) };
  }
  matches(snapshot, proof) {
    if (!snapshot || !proof || !Array.isArray(proof.terminalInputs) || !Array.isArray(proof.passiveQuestions)) return false;
    const match = (rows, originals, completedOnly) => rows.length === originals.length &&
      new Set(rows.map(r => r.id)).size === rows.length && rows.every(r => {
      const original = originals.find(x => x.id === r.id);
      return original && r.botId === original.botId && r.threadId === (original.threadId ?? original.request.params.threadId) &&
        r.turnId === (original.turnId ?? original.request.params.turnId) && (completedOnly ? r.status === 'completed' : ['completed','failed','interrupted'].includes(r.status));
    });
    return match(proof.terminalInputs, snapshot.input.accepted, false) && match(proof.passiveQuestions, snapshot.input.questions, true);
  }
}

export function nativeProofFresh(proof, root = join(homedir(), '.codex')) {
  try {
    const stamp = (path, boundary) => {
      const rel = relative(boundary, path);
      if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('../')) throw Error('Foreign proof path');
      let current = boundary;
      for (const part of ['', ...rel.split('/')]) {
        if (part) current = join(current, part);
        const s = lstatSync(current, { bigint:true });
        if (s.isSymbolicLink() || s.uid !== BigInt(process.getuid())) throw Error('Unsafe proof path');
      }
      const s = lstatSync(path, { bigint:true });
      if (!s.isFile()) throw Error('Unsafe proof file');
      return [s.dev,s.ino,s.size,s.mtimeNs].map(String);
    };
    const names = ['thread_history_1.sqlite','queue_1.sqlite','goals_1.sqlite','state_5.sqlite'];
    if (!Array.isArray(proof.databaseStamps) || proof.databaseStamps.length !== 4 || !Array.isArray(proof.rolloutStamps) || proof.rolloutStamps.length > MAX) return false;
    return names.every((name,i) => {
      let wal; try { wal = stamp(join(root,name+'-wal'), root); } catch (e) { if (e.code !== 'ENOENT') throw e; wal=null; }
      return JSON.stringify([stamp(join(root,name), root),wal]) === JSON.stringify(proof.databaseStamps[i]);
    }) && proof.rolloutStamps.every(([path,expected]) => JSON.stringify(stamp(path,join(root,'sessions'))) === JSON.stringify(expected));
  } catch { return false; }
}
