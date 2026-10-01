import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, mkdir, lstat, link, unlink } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { containedPath } from './profiles.mjs';
import { artifactMime } from './artifact-library.mjs';
import { artifactDate, historicalArtifactDate } from './artifact-dates.mjs';

const MAX_FILE = 100 * 1024 * 1024, MAX_INLINE = 20 * 1024 * 1024;
const digest = (value) => createHash('sha256').update(value).digest('hex');
const privateName = (name) => /(^|[\\/])\.(?:env(?:\.|$)|git(?:[\\/]|$)|ssh(?:[\\/]|$)|aws(?:[\\/]|$)|codex(?:[\\/]|$))|\.(?:pem|key|p12|pfx)$/i.test(name);
const publicResult = (a) => ({ attachmentId: a.id, name: a.name, markdown: `[${a.name.replace(/[\[\]]/g, '')}](bot-artifact:${a.id})` });
function provenance(bot, p) {
  const result = { threadId: p?.threadId ?? bot.threadId };
  for (const key of ['turnId', 'itemId', 'operationId', 'laneId', 'runId']) if (typeof p?.[key] === 'string' && p[key].length <= 200) result[key] = p[key];
  return result;
}
async function writeAll(file, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset);
    if (!bytesWritten) throw new Error('Artifact copy stalled.');
    offset += bytesWritten;
  }
}
/** Only explicit publishing or recognized intended native outputs reach here. */
export async function registerArtifact(runtime, bot, input, context = {}) {
  return runtime.lock(`artifact:${bot.id}`, async () => {
    const publicationId = context.key && digest(`${bot.id}:${context.key}`);
    const prior = publicationId && runtime.store.get('artifactPublication', publicationId);
    if (prior) {
      let a = runtime.owned('attachment', prior.attachmentId, bot.id);
      if (runtime.storage) a = await runtime.storage.publish(bot,a);
      return publicResult(a);
    }
    let source, sourceInfo, temporary, destination;
    try {
      let name = input.name;
      const nativeBytes = context.source === 'native' ? Number(runtime.store.db.prepare("SELECT COALESCE(SUM(json_extract(json,'$.size')),0) AS bytes FROM records WHERE kind='attachment' AND bot_id=? AND json_extract(json,'$.source')='native'").get(bot.id).bytes) : 0;
      if (input.path) {
        const path = resolve(bot.cwd, input.path);
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE) throw new Error('Publish a regular file of at most 100 MB.');
        await containedPath(bot.cwd, path);
        if (privateName(relative(bot.cwd, path))) throw new Error('Credential and private configuration files cannot be published.');
        source = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        await containedPath(bot.cwd, `/proc/self/fd/${source.fd}`);
        sourceInfo = await source.stat();
        if (!sourceInfo.isFile() || sourceInfo.size > MAX_FILE) throw new Error('Publish a regular file of at most 100 MB.');
        name ??= basename(path);
      } else if (!Buffer.isBuffer(input.bytes) || input.bytes.length > MAX_INLINE) throw new Error('Native inline output exceeds 20 MB or is invalid.');
      name = basename(String(name ?? 'artifact')).replace(/[\x00-\x1f]/g, '').slice(0, 160) || 'artifact';
      if (privateName(name)) throw new Error('Credential files cannot be published.');
      if (context.source === 'native' && nativeBytes + (sourceInfo?.size ?? input.bytes.length) > 1024 * 1024 * 1024) throw Object.assign(new Error('Automatic output storage is full.'), { artifactReason: 'Automatic output storage has reached its 1 GB per-bot limit. Original files were retained; review storage or explicitly publish the intended file.' });
      const root = join(bot.cwd, 'artifacts');
      await mkdir(root, { recursive: true, mode: 0o700 }); await containedPath(bot.cwd, root);
      temporary = join(root, `.staging-${randomUUID()}`);
      destination = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await containedPath(bot.cwd, `/proc/self/fd/${destination.fd}`);
      const hash = createHash('sha256'); let size = 0;
      if (source) {
        const buffer = Buffer.alloc(256 * 1024);
        for (;;) {
          const { bytesRead } = await source.read(buffer, 0, buffer.length, size);
          if (!bytesRead) break;
          size += bytesRead;
          if (size > MAX_FILE) throw new Error('Artifact changed while being copied.');
          const bytes = buffer.subarray(0, bytesRead); hash.update(bytes); await writeAll(destination, bytes);
        }
        const after = await source.stat();
        if (size !== sourceInfo.size || after.size !== size || after.mtimeMs !== sourceInfo.mtimeMs) throw new Error('Artifact changed while being copied. Retry publishing the finished file.');
      } else { size = input.bytes.length; hash.update(input.bytes); await writeAll(destination, input.bytes); }
      await destination.sync(); await destination.close(); destination = null;
      const sha256 = hash.digest('hex');
      const previousCopy = input.path && runtime.store.db.prepare("SELECT json FROM records WHERE kind='attachment' AND bot_id=? AND json_extract(json,'$.path')=? AND json_extract(json,'$.artifact')=1 AND json_extract(json,'$.ready')=1 LIMIT 1").get(bot.id, resolve(bot.cwd, input.path));
      const existingCopy = previousCopy && JSON.parse(previousCopy.json);
      if (existingCopy && (existingCopy.size !== size || (existingCopy.sha256 && existingCopy.sha256 !== sha256))) throw new Error('Registered artifact changed; its original record was retained.');
      const id = existingCopy?.id ?? `artifact-${digest(`${bot.id}:${name}:${sha256}`).slice(0, 48)}`;
      let a = existingCopy ?? runtime.store.get('attachment', id);
      if (a) a = { ...a, sha256, provenance: a.provenance ?? provenance(bot, context) };
      if (!a) {
        const dir = join(root, id); await mkdir(dir, { recursive: true, mode: 0o700 }); await containedPath(bot.cwd, dir);
        const path = join(dir, name);
        // Exclusive link preserves a copy completed before a process/DB failure.
        // It is never replaced, and retries validate bytes before claiming it.
        try { await link(temporary, path); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const existing = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            await containedPath(bot.cwd, `/proc/self/fd/${existing.fd}`);
            const h = createHash('sha256'), bytes = Buffer.alloc(256 * 1024); let offset = 0;
            if ((await existing.stat()).size !== size) throw new Error('Artifact destination changed; original retained.');
            for (;;) { const { bytesRead } = await existing.read(bytes, 0, bytes.length, offset); if (!bytesRead) break; offset += bytesRead; h.update(bytes.subarray(0, bytesRead)); }
            if (h.digest('hex') !== sha256) throw new Error('Artifact destination changed; original retained.');
          } finally { await existing.close(); }
        }
        for (const folder of [dir, root, bot.cwd]) {
          const directory = await open(folder, constants.O_RDONLY); try { await directory.sync(); } finally { await directory.close(); }
        }
        a = { id, botId: bot.id, name, path, size, sha256, mimeType: artifactMime(name, input.mimeType),
          ready: true, received: size, artifact: true, source: context.source ?? 'published',
          // Undefined means an observed live event/publication; null explicitly
          // preserves an unknown historical time, including across retries.
          createdAt: context.createdAt === undefined ? new Date().toISOString() : artifactDate(context.createdAt), provenance: provenance(bot, context) };
      }
      runtime.store.transaction(() => {
        runtime.store.put('attachment', a);
        if (publicationId) runtime.store.put('artifactPublication', { id: publicationId, botId: bot.id, attachmentId: id,
          provenance: provenance(bot, context) });
      });
      if (runtime.storage) a = await runtime.storage.publish(bot,a);
      if (context.laneId && runtime.runs?.isolated(context.runId)) runtime.runs.event(context.laneId, 'attachment', runtime.publicAttachment(a));
      else runtime.emitEvent('attachment', runtime.publicAttachment(a), bot.id);
      return publicResult(a);
    } finally { await source?.close(); await destination?.close(); if (temporary) await unlink(temporary).catch(() => {}); }
  });
}

function inlineImage(result) {
  if (typeof result !== 'string' || result.length > Math.ceil(MAX_INLINE / 3) * 4 + 100) return null;
  const match = /^(?:data:(image\/(?:png|jpeg|webp));base64,)?([A-Za-z0-9+/]+={0,2})$/.exec(result);
  if (!match || match[2].length % 4) return null;
  const bytes = Buffer.from(match[2], 'base64');
  const mimeType = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : null;
  return mimeType && bytes.length <= MAX_INLINE ? { bytes, mimeType, name: `generated-image.${mimeType.split('/')[1]}` } : null;
}
export function intendedOutputs(item) {
  if (item?.type === 'imageGeneration' && item.status === 'completed' && !item.failure) {
    const inline = inlineImage(item.result);
    if (inline) return [{ ...inline, ...(typeof item.savedPath === 'string' ? { name: basename(item.savedPath) } : {}) }];
    if (typeof item.savedPath === 'string') return [{ path: item.savedPath }];
    return [{ unavailable: 'This generated image has no supported local file or bounded inline image. Publish its saved output explicitly to make it available in the library.' }];
  }
  // MCP tool results normally feed the model, not the human. Only explicit
  // user-audience resources qualify; imageView/fileChange/text links never do.
  if (item?.type === 'mcpToolCall' && item.status === 'completed' && !item.error) {
    const results = [];
    for (const content of (Array.isArray(item.result?.content) ? item.result.content : []).slice(0, 64)) {
      if (!content?.annotations?.audience?.includes('user')) continue;
      if (content.type === 'resource_link' && typeof content.uri === 'string' && content.uri.startsWith('file:')) {
        try { results.push({ path: fileURLToPath(content.uri), name: content.name, mimeType: content.mimeType }); } catch { /* Unsupported resource URI. */ }
      }
      if (content.type === 'resource' && typeof content.resource?.blob === 'string' &&
          content.resource.blob.length <= Math.ceil(MAX_INLINE / 3) * 4 && /^[A-Za-z0-9+/]*={0,2}$/.test(content.resource.blob)) {
        let name;
        try { name = basename(new URL(content.resource.uri).pathname); } catch { /* URI has no usable filename. */ }
        if (name) results.push({ bytes: Buffer.from(content.resource.blob, 'base64'), name, mimeType: content.resource.mimeType });
      }
      if (results.length === 6) break;
    }
    return results;
  }
  return [];
}
export async function registerNativeItem(runtime, bot, turnId, item, createdAt, context = {}) {
  if (typeof turnId !== 'string' || turnId.length > 200 || typeof item?.id !== 'string' || item.id.length > 200) return { registered: 0, failures: [] };
  const outputs = intendedOutputs(item); let registered = 0; const failures = [];
  for (let i = 0; i < outputs.length; i++) {
    if (outputs[i].unavailable) { failures.push({ itemId: item.id, reason: outputs[i].unavailable }); continue; }
    try {
      await registerArtifact(runtime, bot, outputs[i], { ...context, source: 'native', turnId, itemId: item.id, createdAt,
        key: `native:${context.threadId ?? bot.threadId}:${turnId}:${item.id}:${i}` });
      registered++;
    } catch (error) { failures.push({ itemId: item.id, reason: error?.artifactReason ?? 'An intended output could not be registered. Its source was retained; retry indexing after the file is available inside this bot workspace.' }); }
  }
  return { registered, failures };
}
async function indexNativePage(runtime, bot, p, context = {}) {
  const threadId = context.threadId ?? bot.threadId;
  let native = null, before = null;
  if (p.cursor != null) {
    try {
      if (typeof p.cursor !== 'string' || p.cursor.length > 8192) throw new Error();
      const c = JSON.parse(Buffer.from(p.cursor, 'base64url').toString());
      if (c.v !== 1 || c.botId !== bot.id || c.threadId !== threadId || (c.runId ?? null) !== (context.runId ?? null) || (c.native !== null && typeof c.native !== 'string') || (c.before !== null && (typeof c.before !== 'string' || c.before.length > 500))) throw new Error();
      ({ native, before } = c);
    } catch { throw new Error('Invalid native artifact indexing cursor.'); }
  }
  const page = await runtime.historyPage(threadId, native);
  const items = page.data.filter(turn => context.kind !== 'main-legacy' || turn.id === context.turnId)
    .flatMap((turn) => turn.items.map((item) => ({ turn, item })));
  const offset = before ? items.findIndex(({ turn, item }) => `${turn.id}:${item.id}` === before) + 1 : 0;
  if (before && !offset) throw new Error('Native history changed. Restart artifact indexing.');
  const failures = []; let registered = 0, end = offset;
  for (; end < items.length && end < offset + 40; end++) {
    const { turn, item } = items[end];
    if (!rememberInputProvenance(runtime, bot, turn.id, item, context)) failures.push({ itemId: item.id, reason: 'Attachment provenance could not be saved. Original files remain available; retry indexing.' });
    const result = await registerNativeItem(runtime, bot, turn.id, item, historicalArtifactDate(turn), context);
    registered += result.registered; failures.push(...result.failures);
  }
  const more = end < items.length;
  return { registered, failures, nextCursor: more || page.nextCursor ? Buffer.from(JSON.stringify({ v: 1, botId: bot.id, threadId, runId: context.runId ?? null,
    native: more ? native : page.nextCursor, before: more ? `${items[end - 1].turn.id}:${items[end - 1].item.id}` : null })).toString('base64url') : null };
}

export function rememberInputProvenance(runtime, bot, turnId, item, context = {}) {
  if (item?.type !== 'userMessage') return true;
  try {
    const queued = item.clientId && runtime.store.get('queuedAttachments', item.clientId);
    const operation = item.clientId && runtime.store.operation(item.clientId);
    const ids = queued?.botId === bot.id ? queued.attachmentIds : operation?.botId === bot.id ? operation.params?.attachments : [];
    const paths = new Set((Array.isArray(item.content) ? item.content : []).filter((part) => part.type === 'localImage').map((part) => part.path));
    const matches = new Map((Array.isArray(ids) ? ids.slice(0, 12) : []).map((id) => [id, runtime.store.get('attachment', id)]));
    for (const path of [...paths].slice(0, 6)) {
      for (const row of runtime.store.db.prepare("SELECT json FROM records WHERE kind='attachment' AND bot_id=? AND json_extract(json,'$.path')=? LIMIT 6").all(bot.id, path)) {
        const a = JSON.parse(row.json); matches.set(a.id, a);
      }
    }
    for (const a of matches.values()) {
      if (!a || a.botId !== bot.id) continue;
      if (a.artifact || !a.ready || (!ids?.includes(a.id) && !paths.has(a.path))) continue;
      if (a.provenance?.turnId && a.provenance.turnId !== turnId) continue;
      const enriched=runtime.store.put('attachment', { ...a, provenance: provenance(bot, { ...context, turnId, itemId: item.id, operationId: item.clientId }) });
      if(runtime.storage) void runtime.storage.enrich(enriched).catch(()=>{});
    }
    return true;
  } catch {
    // Enrichment must never turn a committed send into a failed acknowledgement.
    runtime.emit('fault', new Error('Attachment provenance could not be saved; original files and operation receipts were retained.'));
    return false;
  }
}

const indexTasks = new WeakMap();
export async function indexNativeArtifacts(runtime, bot, p, context = {}) {
  let tasks = indexTasks.get(runtime);
  if (!tasks) { tasks = new Map(); indexTasks.set(runtime, tasks); }
  const key = JSON.stringify([bot.id, context.threadId ?? bot.threadId, context.runId ?? null, p.cursor ?? null]);
  if (tasks.has(key)) return tasks.get(key);
  if (tasks.size >= 2) throw new Error('Artifact indexing is busy. Try again shortly.');
  const task = indexNativePage(runtime, bot, p, context); tasks.set(key, task);
  try { return await task; } finally { tasks.delete(key); }
}
