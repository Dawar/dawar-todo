import { constants } from 'node:fs';
import { open, lstat, realpath, mkdir, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const MEMORY_VERSION = 1;
export const MEMORY_TRIGGER = 32768;
export const PROFILE_LIMIT = 128 * 1024;
export const SUMMARY_LIMIT = 24 * 1024;
export const MEMORY_SOURCE_LIMIT = 8 * 1024 * 1024;
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const uid = process.getuid();
const sameStat = (a, b) => ['dev', 'ino', 'uid', 'mode', 'size', 'mtimeNs', 'ctimeNs'].every(k => a[k] === b[k]);
const sourceVersion = source => ['dev', 'ino', 'uid', 'mode', 'size', 'mtimeNs', 'ctimeNs'].map(k => String(source.stat[k])).join(':');
const fail = message => { throw new Error(message); };
const utf8 = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const owned = (stat, label, directory = false, privateFile = false) => {
  if (!(directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1n) || stat.uid !== BigInt(uid) || Number(stat.mode) & 0o022 ||
      privateFile && (Number(stat.mode) & 0o777) !== 0o600) fail(`${label} must be an owned, safe ${directory ? 'directory' : 'regular file'}.`);
};

// Linux mutations remain anchored to directory descriptors. Darwin permits
// read-only scopes with repeated root/file identity checks; no path-based
// write replaces the atomic helper. Names are fixed application file names.
export async function memoryWorkspace(bot, { readOnly = false, platform = process.platform } = {}) {
  if (platform !== 'linux' && (platform !== 'darwin' || !readOnly)) fail('Atomic memory maintenance is unavailable on this platform; current files and receipts are retained.');
  const cwd = resolve(bot.cwd), root = await open(cwd, flags | constants.O_DIRECTORY);
  try {
    const identity = await root.stat({ bigint: true }); owned(identity, 'Bot workspace', true);
    if (await realpath(cwd) !== cwd || platform === 'linux' && await realpath(`/proc/self/fd/${root.fd}`) !== cwd) fail('Bot workspace changed or contains a symlink.');
    const path = name => { if (typeof name !== 'string' || !name || basename(name) !== name || ['.', '..'].includes(name)) fail('Use a fixed workspace file name.'); return join(platform === 'linux' ? `/proc/self/fd/${root.fd}` : cwd, name); };
    const check = async () => {
      const current = await lstat(cwd, { bigint: true }); owned(current, 'Bot workspace', true);
      if (current.dev !== identity.dev || current.ino !== identity.ino || await realpath(cwd) !== cwd) fail('Bot workspace was replaced.');
    };
    return { cwd, root, path, check, readOnly, platform, sync: () => root.sync(), identity: `${identity.dev}:${identity.ino}:${identity.uid}`, close: () => root.close() };
  } catch (error) { await root.close(); throw error; }
}
export async function readOwnedFile(scope, name, limit, privateFile = false, signal = null) {
  await scope.check(); signal?.throwIfAborted();
  let handle;
  try { handle = await open(scope.path(name), flags); }
  catch (error) { if (error.code === 'ENOENT') error.memoryMissingAtOpen = true; throw error; }
  try {
    const before = await handle.stat({ bigint: true }); owned(before, name, false, privateFile);
    const openedTarget = await lstat(scope.path(name), { bigint: true });
    if (!sameStat(before, openedTarget)) fail(`${name} changed while opening.`);
    await scope.check();
    if (before.size > BigInt(limit)) fail(`${name} exceeds the ${limit}-byte safe read limit.`);
    const chunks = []; let size = 0;
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, limit + 1 - size), size);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > limit) fail(`${name} grew beyond its safe read limit.`);
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    const after = await handle.stat({ bigint: true }), target = await lstat(scope.path(name), { bigint: true });
    if (!sameStat(before, after) || !sameStat(before, target) || BigInt(size) !== before.size) fail(`${name} changed while being read.`);
    await scope.check(); signal?.throwIfAborted();
    const bytes = Buffer.concat(chunks);
    return { bytes, text: utf8(bytes), hash: digest(bytes), stat: before, size };
  } finally { await handle.close(); }
}
export async function profileFile(bot, name) {
  const scope = await memoryWorkspace(bot, { readOnly: true });
  try { return { ...await readOwnedFile(scope, name, name === 'MEMORY.md' ? MEMORY_SOURCE_LIMIT : PROFILE_LIMIT), workspaceIdentity: scope.identity }; }
  catch (error) { if (error.memoryMissingAtOpen) error.profileMissing = true; throw error; }
  finally { await scope.close(); }
}
async function privateDirectory(parent, name, create = true) {
  await parent.check();
  if (create && parent.readOnly) fail('This memory directory is read-only.');
  if (create) {
    await mkdir(parent.path(name), { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
    await parent.sync();
  }
  const handle = await open(parent.path(name), flags | constants.O_DIRECTORY);
  try {
    const before = await handle.stat({ bigint: true }); owned(before, name, true);
    if ((Number(before.mode) & 0o777) !== 0o700) fail(`${name} must be private (0700).`);
    const directory = parent.path(name);
    const path = file => { if (typeof file !== 'string' || !file || basename(file) !== file || ['.', '..'].includes(file)) fail('Use a fixed memory file name.'); return join(parent.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : directory, file); };
    const check = async () => {
      await parent.check(); const current = await lstat(parent.path(name), { bigint: true });
      if (!sameStat({ ...before, size: current.size, mtimeNs: current.mtimeNs, ctimeNs: current.ctimeNs }, current)) fail(`${name} was replaced or its permissions changed.`);
    };
    await check();
    return { path, check, readOnly: parent.readOnly, platform: parent.platform, sync: () => handle.sync(), close: () => handle.close() };
  } catch (error) { await handle.close(); throw error; }
}
async function putNew(scope, name, bytes) {
  if (scope.readOnly) fail('This memory directory is read-only.');
  await scope.check();
  const file = await open(scope.path(name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  const verified = await readOwnedFile(scope, name, Math.max(bytes.length, 1), true);
  if (verified.hash !== digest(bytes)) fail('Private memory copy did not verify.');
  await scope.sync();
  return verified;
}
async function putReceipt(scope, receipt) {
  return replacePrivateJson(scope, 'receipt.json', receipt);
}
async function replacePrivateJson(scope, name, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  const temporary = `receipt-${randomUUID()}.tmp`;
  await putNew(scope, temporary, bytes);
  try { await scope.check(); await rename(scope.path(temporary), scope.path(name)); await scope.sync(); }
  finally { await unlink(scope.path(temporary)).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}
function matchBot(receipt, bot, workspace, id) {
  if (receipt.version !== MEMORY_VERSION || receipt.botId !== bot.id || receipt.threadId !== bot.threadId || receipt.cwd !== workspace.cwd || receipt.workspaceIdentity !== workspace.identity)
    fail('Memory receipt belongs to another bot, thread or workspace version.');
  if (receipt.id !== id || !/^[a-f0-9]{64}$/.test(receipt.sourceHash ?? '') || !Number.isSafeInteger(receipt.sourceBytes) || receipt.sourceBytes < 0 || receipt.sourceBytes > MEMORY_SOURCE_LIMIT ||
      !/^\d+:\d+:\d+:\d+:\d+:\d+:\d+$/.test(receipt.sourceIdentity ?? '') || !['prepared', 'verified', 'committing', 'done', 'stale'].includes(receipt.state) ||
      id !== `memory-v1-${digest(JSON.stringify([receipt.botId, receipt.threadId, receipt.cwd, receipt.workspaceIdentity, receipt.sourceHash, receipt.sourceIdentity]))}`)
    fail('Memory receipt identity or source metadata is corrupt.');
  if (receipt.state !== 'prepared') {
    const review = receipt.review, p = review?.provenance;
    if (!/^[a-f0-9]{64}$/.test(receipt.resultHash ?? '') || !Number.isSafeInteger(receipt.resultBytes) || receipt.resultBytes < 64 || receipt.resultBytes > SUMMARY_LIMIT ||
        receipt.verifiedSourceHash !== receipt.sourceHash || !review || ['constraints', 'approvals', 'unfinishedWork', 'uncertainOperations', 'references'].some(k => typeof review[k] !== 'string' || !review[k].trim() || review[k].length > 800) ||
        !p || !['native-tool', 'authenticated-bot-mcp'].includes(p.authority) || p.source !== 'own-model-semantic-review' || p.botId !== bot.id || p.threadId !== bot.threadId || typeof p.turnId !== 'string' || !p.turnId)
      fail('Memory semantic-review provenance or candidate metadata is corrupt.');
  }
}
export const memoryId = (bot, source, workspaceIdentity) => `memory-v1-${digest(JSON.stringify([bot.id, bot.threadId, resolve(bot.cwd), workspaceIdentity, source.hash, sourceVersion(source)]))}`;
async function markCurrent(workspace, id) {
  const parent = await privateDirectory(workspace, '.memory-maintenance');
  try { await replacePrivateJson(parent, 'current.json', { operationId: id }); } finally { await parent.close(); }
}
const receiptName = id => { if (typeof id !== 'string' || !/^memory-v1-[a-f0-9]{64}$/.test(id)) fail('Use the original memory operation ID.'); return id; };

// Ordinary profile reads never join a preparation/verification mutation lock.
// All directories/files remain anchored, private and bounded. A committing
// receipt still takes the exclusive, original-ID reconciliation path below.
async function inspectMemoryOperation(bot, id, read, { metadataOnly = false } = {}) {
  const workspace = await memoryWorkspace(bot, { readOnly: true }); let parent, scope;
  try {
    parent = await privateDirectory(workspace, '.memory-maintenance', false);
    scope = await privateDirectory(parent, receiptName(id), false);
    const before = await readOwnedFile(scope, 'receipt.json', 64 * 1024, true);
    const receipt = JSON.parse(before.text); matchBot(receipt, bot, workspace, id);
    if (receipt.state === 'committing') return null;
    const value = await read({ workspace, scope, receipt });
    const after = await readOwnedFile(scope, 'receipt.json', 64 * 1024, true);
    const current = JSON.parse(after.text); matchBot(current, bot, workspace, id);
    if (current.state === 'committing') return null;
    if (!metadataOnly && after.hash !== before.hash) fail('Memory summary receipt changed during its read. Retain input and inspect the original operation.');
    return { value };
  } finally { await scope?.close(); await parent?.close(); await workspace.close(); }
}

export async function memoryOperation(bot, id, callback, { create = false } = {}) {
  const workspace = await memoryWorkspace(bot); let parent, scope, lock;
  try {
    parent = await privateDirectory(workspace, '.memory-maintenance');
    if (!create) await lstat(parent.path(receiptName(id))); // Never manufacture a missing original operation.
    scope = await privateDirectory(parent, receiptName(id));
    const lockBytes = Buffer.from(JSON.stringify({ pid: process.pid, nonce: randomUUID() }));
    try { await putNew(scope, 'lock.json', lockBytes); lock = digest(lockBytes); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = await readOwnedFile(scope, 'lock.json', 1024, true), value = JSON.parse(previous.text);
      if (!Number.isSafeInteger(value.pid) || value.pid < 1) fail('Memory lock needs inspection.');
      try { process.kill(value.pid, 0); fail('Memory maintenance is already preparing this original operation.'); }
      catch (e) { if (e.code !== 'ESRCH') throw e; }
      if ((await readOwnedFile(scope, 'lock.json', 1024, true)).hash !== previous.hash) fail('Memory lock changed.');
      await unlink(scope.path('lock.json'));
      await putNew(scope, 'lock.json', lockBytes); lock = digest(lockBytes);
    }
    let receipt = null;
    try { receipt = JSON.parse((await readOwnedFile(scope, 'receipt.json', 64 * 1024, true)).text); matchBot(receipt, bot, workspace, id); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return await callback({ workspace, scope, receipt, save: value => putReceipt(scope, value), put: (name, bytes) => putNew(scope, name, bytes) });
  } finally {
    try {
      if (lock && scope && (await readOwnedFile(scope, 'lock.json', 1024, true)).hash === lock) await unlink(scope.path('lock.json'));
    } finally { await scope?.close(); await parent?.close(); await workspace.close(); }
  }
}
export function memoryReceipt(receipt) {
  return { operationId: receipt.id, version: receipt.version, botId: receipt.botId, threadId: receipt.threadId, state: receipt.state,
    sourceHash: receipt.sourceHash, sourceBytes: receipt.sourceBytes, resultHash: receipt.resultHash ?? null, resultBytes: receipt.resultBytes ?? null,
    archive: `${receipt.cwd}/.memory-maintenance/${receipt.id}/source.md`, candidate: `${receipt.cwd}/.memory-maintenance/${receipt.id}/candidate.md`,
    reviewedAt: receipt.review?.at ?? null, completedAt: receipt.completedAt ?? null };
}
export async function prepareMemory(bot, signal = null) {
  const workspace = await memoryWorkspace(bot);
  let source, id;
  try { source = await readOwnedFile(workspace, 'MEMORY.md', MEMORY_SOURCE_LIMIT, false, signal); id = memoryId(bot, source, workspace.identity); }
  finally { await workspace.close(); }
  await memoryCurrentState(bot, source);
  return memoryOperation(bot, id, async ({ workspace, scope, receipt, save, put }) => {
    const current = await readOwnedFile(workspace, 'MEMORY.md', MEMORY_SOURCE_LIMIT, false, signal);
    if (current.hash !== source.hash || memoryId(bot, current, workspace.identity) !== id) fail('Memory changed before preparing its backup.');
    if (receipt) { await verifyArchive(scope, receipt); await markCurrent(workspace, id); return memoryReceipt(receipt); }
    try { await put('source.md', current.bytes); }
    catch (error) { if (error.code !== 'EEXIST' || (await readOwnedFile(scope, 'source.md', MEMORY_SOURCE_LIMIT, true)).hash !== current.hash) throw error; }
    receipt = { version: MEMORY_VERSION, id, botId: bot.id, threadId: bot.threadId, cwd: workspace.cwd, workspaceIdentity: workspace.identity,
      sourceHash: current.hash, sourceBytes: current.size, sourceIdentity: sourceVersion(current), state: 'prepared', createdAt: new Date().toISOString() };
    await save(receipt);
    await markCurrent(workspace, id);
    return memoryReceipt(receipt);
  }, { create: true });
}
async function verifyArchive(scope, receipt) {
  const archive = await readOwnedFile(scope, 'source.md', MEMORY_SOURCE_LIMIT, true);
  if (archive.hash !== receipt.sourceHash || archive.size !== receipt.sourceBytes) fail('Original memory backup failed verification.');
  return archive;
}
async function candidateBytes(scope, receipt) {
  const candidate = await readOwnedFile(scope, 'candidate.md', SUMMARY_LIMIT, true);
  if (candidate.size < 64 || !/^# Memory\b/m.test(candidate.text) || !candidate.text.includes(`.memory-maintenance/${receipt.id}/source.md`) || candidate.size >= receipt.sourceBytes)
    fail('Candidate must be a smaller, readable # Memory summary with its exact private archive reference.');
  return candidate;
}
export async function verifyMemory(bot, id, expectedHash, review, provenance) {
  return memoryOperation(bot, id, async ({ workspace, scope, receipt, save }) => {
    if (!receipt) fail('Original memory operation is missing.');
    if (receipt.state === 'done' || receipt.state === 'committing') {
      if (expectedHash !== receipt.resultHash) fail('Reconcile the original committing candidate hash; do not change an uncertain operation.');
      return memoryReceipt(receipt);
    }
    const source = await readOwnedFile(workspace, 'MEMORY.md', MEMORY_SOURCE_LIMIT);
    if (source.hash !== receipt.sourceHash || sourceVersion(source) !== receipt.sourceIdentity) fail('Source changed. This candidate cannot replace current constraints.');
    await verifyArchive(scope, receipt);
    const candidate = await candidateBytes(scope, receipt);
    if (candidate.hash !== expectedHash || !/^[a-f0-9]{64}$/.test(expectedHash ?? '')) fail('Candidate hash changed; review its exact bytes again.');
    const categories = ['constraints', 'approvals', 'unfinishedWork', 'uncertainOperations', 'references'];
    if (!review || Array.isArray(review) || Object.keys(review).some(k => !categories.includes(k)) || categories.some(k => typeof review[k] !== 'string' || !review[k].trim() || review[k].length > 800))
      fail('Review current constraints, approvals, unfinished work, uncertainty IDs and references against the full source.');
    const current = await readOwnedFile(workspace, 'MEMORY.md', MEMORY_SOURCE_LIMIT);
    if (current.hash !== source.hash || sourceVersion(current) !== sourceVersion(source)) fail('Source version changed during semantic verification. Retain this candidate and review current facts.');
    receipt = { ...receipt, state: 'verified', resultHash: candidate.hash, resultBytes: candidate.size,
      review: { ...review, at: new Date().toISOString(), provenance }, verifiedSourceHash: source.hash };
    await save(receipt); await markCurrent(workspace, id); return memoryReceipt(receipt);
  });
}
export async function commitMemory(bot, id, expectedHash, guard = () => true, signal = null) {
  return memoryOperation(bot, id, async ({ workspace, scope, receipt, save, put }) => {
    if (!receipt) fail('Original memory operation is missing.');
    await verifyArchive(scope, receipt);
    const source = await readOwnedFile(workspace, 'MEMORY.md', MEMORY_SOURCE_LIMIT);
    if (!['verified', 'committing', 'done'].includes(receipt.state) || expectedHash !== receipt.resultHash) fail('Verify this original operation and exact candidate before committing.');
    if (source.hash === receipt.resultHash && ['committing', 'done'].includes(receipt.state)) {
      if (receipt.state === 'committing' && (await readOwnedFile(scope, `commit-${receipt.resultHash}.md`, MEMORY_SOURCE_LIMIT)).hash !== receipt.sourceHash)
        fail('Displaced memory needs inspection before confirming the original exchange.');
      if (receipt.state !== 'done') { await workspace.sync(); await save(receipt = { ...receipt, state: 'done', completedAt: new Date().toISOString() }); }
      return memoryReceipt(receipt); // Lost ACK/restart: no second rename.
    }
    if (receipt.state === 'done') fail('Compaction completed, but memory has newer facts. Nothing was replaced.');
    if (source.hash !== receipt.sourceHash || sourceVersion(source) !== receipt.sourceIdentity) fail('Source changed; retained candidate and backup need a fresh semantic review.');
    const candidate = await candidateBytes(scope, receipt);
    if (candidate.hash !== receipt.resultHash || !receipt.review || receipt.verifiedSourceHash !== source.hash) fail('Verified candidate or provenance changed.');
    const tempName = `commit-${receipt.resultHash}.md`;
    try { await put(tempName, candidate.bytes); }
    catch (error) { if (error.code !== 'EEXIST' || (await readOwnedFile(scope, tempName, SUMMARY_LIMIT, true)).hash !== candidate.hash) throw error; }
    await markCurrent(workspace, id);
    await save(receipt = { ...receipt, state: 'committing' });
    // Hash CAS and activity fence after all awaited preparation. Linux atomic
    // exchange also retains the displaced file, closing the destructive
    // check/rename gap for a concurrent source edit.
    const checked = await readOwnedFile(workspace, 'MEMORY.md', MEMORY_SOURCE_LIMIT);
    if (checked.hash !== source.hash || !sameStat(checked.stat, source.stat) || !guard()) fail('Memory or current work changed before commit; nothing was replaced.');
    await workspace.check(); await scope.check();
    const target = await lstat(workspace.path('MEMORY.md'), { bigint: true });
    if (!sameStat(target, checked.stat) || !guard()) fail('Memory or activity changed at the commit fence.');
    signal?.throwIfAborted();
    await new Promise((resolve, reject) => {
      const child = execFile('python3', [fileURLToPath(new URL('./memory-atomic.py', import.meta.url))],
        { timeout: 30000, maxBuffer: 16384, ...(signal ? { signal } : {}) }, (error, stdout) => {
          if (error) reject(error); else {
            try { if (JSON.parse(stdout).exchanged !== true) fail('Atomic memory exchange was not acknowledged.'); resolve(); }
            catch (error) { reject(error); }
          }
        });
      child.stdin.end(JSON.stringify({ cwd: workspace.cwd, workspaceIdentity: workspace.identity, operationId: id,
        sourceHash: receipt.sourceHash, sourceIdentity: receipt.sourceIdentity, candidateHash: receipt.resultHash }));
    });
    const written = await readOwnedFile(workspace, 'MEMORY.md', SUMMARY_LIMIT, true);
    if (written.hash !== receipt.resultHash) fail('Replacement outcome needs original-ID reconciliation.');
    await save(receipt = { ...receipt, state: 'done', completedAt: new Date().toISOString() });
    return memoryReceipt(receipt);
  });
}
export async function memoryFallback(bot, id, source) {
  const read = async ({ scope, receipt, workspace }) => {
    if (!receipt || receipt.sourceHash !== source.hash || receipt.sourceIdentity !== sourceVersion(source) || receipt.verifiedSourceHash !== source.hash || !receipt.review || !['verified', 'committing'].includes(receipt.state))
      fail('No verified summary matches the current memory. Retain the message/files and finish memory recovery first.');
    await verifyArchive(scope, receipt);
    const candidate = await candidateBytes(scope, receipt);
    if (candidate.hash !== receipt.resultHash) fail('Verified memory summary changed.');
    const current = await readOwnedFile(workspace, 'MEMORY.md', MEMORY_SOURCE_LIMIT);
    if (current.hash !== source.hash || sourceVersion(current) !== sourceVersion(source)) fail('Memory version changed during fallback preparation.');
    return { text: candidate.text, receipt: memoryReceipt(receipt) };
  };
  const inspected = await inspectMemoryOperation(bot, id, read);
  return inspected ? inspected.value : memoryOperation(bot, id, read);
}
export async function maintenanceMemoryContext(bot, id, source) {
  return memoryOperation(bot, id, async ({ scope, receipt }) => {
    if (!receipt || receipt.sourceHash !== source.hash || receipt.sourceIdentity !== sourceVersion(source) || !['prepared', 'verified', 'committing'].includes(receipt.state))
      fail('Maintenance source changed or its original receipt is unavailable.');
    await verifyArchive(scope, receipt);
    return `MEMORY.md needs semantic maintenance; this is NOT an ordinary compact fallback or proof of current constraints. Before any other work, read the full private source archive ${memoryReceipt(receipt).archive} (SHA-256 ${source.hash}, ${source.size} UTF-8 bytes), plus current mandatory profiles. Preserve current approvals, unfinished scopes, uncertainty identities and references. Do not perform other implementation/business work from this maintenance input. No native history compaction. Current source remains intact.`;
  });
}
export async function memoryCurrentState(bot, source) {
  const workspace = await memoryWorkspace(bot, { readOnly: true }); let parent, id;
  try {
    try { await lstat(workspace.path('.memory-maintenance')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    parent = await privateDirectory(workspace, '.memory-maintenance', false);
    try { id = JSON.parse((await readOwnedFile(parent, 'current.json', 1024, true)).text).operationId; receiptName(id); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  } finally { await parent?.close(); await workspace.close(); }
  const inspected = await inspectMemoryOperation(bot, id, async ({ workspace }) => {
    if (!sameStat(await lstat(workspace.path('MEMORY.md'), { bigint: true }), source.stat))
      fail('Memory changed during ordinary profile preparation. Retain input and read its current version.');
    await workspace.check();
  }, { metadataOnly: true });
  if (inspected) return null;
  return memoryOperation(bot, id, async ({ receipt, scope, workspace, save }) => {
    if (!receipt) fail('Current memory operation receipt is missing.');
    if (receipt.state !== 'committing') return null;
    await verifyArchive(scope, receipt);
    if (source.hash === receipt.sourceHash && sourceVersion(source) === receipt.sourceIdentity) return { operationId: id, state: 'warning',
      message: 'Memory commit has not replaced this source. Original candidate/archive/receipt are retained; reconcile the same operation.' };
    if (`${source.stat.dev}:${source.stat.ino}` === receipt.sourceIdentity.split(':').slice(0, 2).join(':') &&
        (await readOwnedFile(scope, `commit-${receipt.resultHash}.md`, SUMMARY_LIMIT, true)).hash === receipt.resultHash) {
      await save({ ...receipt, state: 'stale', staleAt: new Date().toISOString(), reason: 'source changed; original inode and candidate retained, no current candidate replacement' });
      return { state: 'warning', operationId: id, message: 'Current memory edits were retained. The old candidate is stale; review this new source version before compaction.' };
    }
    if (source.hash !== receipt.resultHash || source.size !== receipt.resultBytes || Number(source.stat.mode) & 0o077)
      fail('An interrupted memory exchange needs inspection. Both files and the original receipt are retained; current constraints cannot be inferred.');
    const displaced = await readOwnedFile(scope, `commit-${receipt.resultHash}.md`, MEMORY_SOURCE_LIMIT);
    if (displaced.hash !== receipt.sourceHash) fail('Concurrent memory edits are retained in the displaced file. Resolve the original operation before ordinary delivery.');
    const current = await readOwnedFile(workspace, 'MEMORY.md', SUMMARY_LIMIT, true);
    if (current.hash !== source.hash || sourceVersion(current) !== sourceVersion(source)) fail('Memory changed during exchange reconciliation.');
    await workspace.sync();
    await save({ ...receipt, state: 'done', completedAt: new Date().toISOString() });
    return null; // Read-only file reconciliation; never another exchange.
  });
}
