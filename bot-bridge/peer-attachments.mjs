import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, mkdir, link, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { containedPath } from './profiles.mjs';

// Only selected READY attachment records reach this boundary. Never accept a
// caller-supplied path, broaden a bot's home, or expose another home's path.
export async function copyPeerAttachments(runtime, sender, recipient, ids, exchangeId) {
  if (!Array.isArray(ids) || ids.length > 12 || new Set(ids).size !== ids.length) throw new Error('Select at most 12 distinct ready files.');
  const sources = ids.map(id => runtime.owned('attachment', id, sender.id));
  if (sources.some(a => !a.ready || !Number.isSafeInteger(a.size) || a.size < 0) ||
      sources.reduce((n, a) => n + a.size, 0) > 100 * 1024 * 1024 || sources.filter(a => a.mimeType.startsWith('image/')).length > 6)
    throw new Error('Peer delivery requires ready files, at most 100 MB total and six images.');
  const copies = [];
  for (const a of sources) {
    const id = `peer-file:${createHash('sha256').update(`${exchangeId}:${recipient.id}:${a.id}`).digest('hex')}`;
    const prior = runtime.store.get('attachment', id);
    if (prior) { if (prior.botId !== recipient.id || prior.peerSource?.attachmentId !== a.id) throw new Error('Peer copy identity conflict.'); copies.push(prior); continue; }
    await containedPath(sender.cwd, a.path);
    const root = join(recipient.cwd, 'uploads', id.replace(':', '-'));
    await mkdir(root, { recursive: true, mode: 0o700 }); await containedPath(recipient.cwd, root);
    const name = basename(a.name).replace(/[\x00-\x1f]/g, '').slice(0, 160) || 'attachment';
    const temp = join(root, `.copy-${randomUUID()}`), path = join(root, name);
    let source, destination;
    try {
      source = await open(a.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      await containedPath(sender.cwd, `/proc/self/fd/${source.fd}`);
      const info = await source.stat();
      if (!info.isFile() || info.size !== a.size) throw new Error('Selected attachment changed before peer delivery.');
      destination = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await containedPath(recipient.cwd, `/proc/self/fd/${destination.fd}`);
      const buffer = Buffer.alloc(256 * 1024), hash = createHash('sha256'); let total = 0;
      for (;;) {
        const { bytesRead } = await source.read(buffer, 0, buffer.length, total);
        if (!bytesRead) break;
        total += bytesRead; if (total > a.size) throw new Error('Selected attachment grew during copying.');
        hash.update(buffer.subarray(0, bytesRead)); let offset = 0;
        while (offset < bytesRead) { const wrote = await destination.write(buffer, offset, bytesRead - offset); if (!wrote.bytesWritten) throw new Error('Peer copy stalled.'); offset += wrote.bytesWritten; }
      }
      const after = await source.stat(), sha256 = hash.digest('hex');
      if (total !== a.size || after.mtimeMs !== info.mtimeMs || after.size !== info.size || a.sha256 && a.sha256 !== sha256) throw new Error('Selected attachment changed during copying.');
      await destination.sync(); await destination.close(); destination = null;
      try { await link(temp, path); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          await containedPath(recipient.cwd, `/proc/self/fd/${existing.fd}`);
          if ((await existing.stat()).size !== total) throw new Error('Retained peer copy changed.');
          const savedHash = createHash('sha256'); let offset = 0;
          for (;;) { const { bytesRead } = await existing.read(buffer, 0, buffer.length, offset); if (!bytesRead) break; savedHash.update(buffer.subarray(0, bytesRead)); offset += bytesRead; }
          if (savedHash.digest('hex') !== sha256) throw new Error('Retained peer copy changed.');
        } finally { await existing.close(); }
      }
      const dir = await open(root, constants.O_RDONLY); try { await dir.sync(); } finally { await dir.close(); }
      copies.push({ id, botId: recipient.id, name, path, size: total, mimeType: a.mimeType, sha256, received: total,
        ready: true, createdAt: new Date().toISOString(), peerSource: { botId: sender.id, attachmentId: a.id, exchangeId } });
    } finally { await source?.close(); await destination?.close(); await unlink(temp).catch(() => {}); }
  }
  // The caller atomically commits metadata with the exchange/intake/operation.
  // A pre-commit crash leaves a private byte copy; same ID verifies/reuses it.
  return copies;
}
