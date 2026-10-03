import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { containedPath } from './profiles.mjs';
import { artifactKind, artifactVersion } from './artifact-library.mjs';

const caches = new WeakMap();
const MAX_CACHE = 16 * 1024 * 1024;
function run(executable, args, fd, maxBytes, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args,
      { stdio: ['ignore', 'pipe', 'ignore', input ? 'pipe' : fd], env: { PATH: process.env.PATH, VIPS_CONCURRENCY: '1', MALLOC_ARENA_MAX: '2' } });
    const chunks = []; let size = 0;
    const timer = setTimeout(() => child.kill('SIGKILL'), 6000);
    if (input) { child.stdio[3].on('error', () => {}); child.stdio[3].end(input); }
    child.stdout.on('data', (chunk) => { size += chunk.length; if (size > maxBytes) child.kill('SIGKILL'); else chunks.push(chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || size > maxBytes) return reject(new Error('Preview renderer unavailable.'));
      resolve(Buffer.concat(chunks));
    });
  });
}
async function render(fd, kind) {
  let input;
  if (kind === 'pdf') {
    const conventional = join(homedir(), '.local/share/dawar-todo-bots/tools/poppler/bin/pdftoppm');
    const executable = process.env.BOTS_PDFTOPPM_PATH || (await access(conventional).then(() => conventional, () => 'pdftoppm'));
    // Poppler renders one scaled page without JavaScript or fetching remote
    // resources. Linux rlimits bound address space and CPU in addition to timeout.
    input = await run('prlimit', ['--as=536870912', '--cpu=5', '--', executable,
      '-f', '1', '-l', '1', '-singlefile', '-scale-to', '512', '-png', '/proc/self/fd/3'], fd, 2 * 1024 * 1024);
  }
  return JSON.parse((await run(process.execPath,
    ['--max-old-space-size=96', fileURLToPath(new URL('./artifact-preview-worker.mjs', import.meta.url))], fd, 180 * 1024, input)).toString());
}
export async function readArtifactPreview(runtime, bot, p) {
  const a = runtime.owned('attachment', p.id, bot.id), version = artifactVersion(a);
  if (!a.ready) throw new Error('Attachment is not ready.');
  if (p.version != null && p.version !== version) throw new Error('The file metadata changed. Refresh its preview.');
  const unavailable = (reason) => ({ status: 'unavailable', version, reason });
  const kind = artifactKind(a.name, a.mimeType);
  if (!['image', 'pdf'].includes(kind)) return unavailable('This file type has no thumbnail.');
  if (a.size > 20 * 1024 * 1024) return unavailable('This file is too large for a thumbnail. Open or download the original.');
  let cache = caches.get(runtime);
  if (!cache) { cache = { entries: new Map(), pending: new Map(), tail: Promise.resolve() }; caches.set(runtime, cache); }
  // Authorization is checked before any cache lookup. Caches never cross a
  // runtime/machine or bot and contain only disposable derived thumbnail bytes.
  const key = `${bot.id}:${a.id}:${version}`, cached = cache.entries.get(key);
  if (cached?.expires > Date.now()) { cache.entries.delete(key); cache.entries.set(key, cached); return cached.value; }
  if (cache.pending.has(key)) return cache.pending.get(key);
  if (cache.pending.size >= 8) return unavailable('Thumbnail renderer is busy. Try again shortly.');
  const task = cache.tail.catch(() => {}).then(async () => {
    let value, file;
    try {
      await containedPath(bot.cwd, a.path);
      file = await open(a.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      await containedPath(bot.cwd, `/proc/self/fd/${file.fd}`);
      const info = await file.stat();
      if (!info.isFile() || info.size !== a.size || info.size > 20 * 1024 * 1024) throw new Error('File changed.');
      const image = await render(file.fd, kind);
      value = { status: 'ready', version, mimeType: 'image/webp', ...image };
    } catch { value = unavailable('A thumbnail could not be generated. The original remains available if its file is intact.'); }
    finally { await file?.close(); }
    cache.entries.set(key, { value, expires: Date.now() + (value.status === 'ready' ? 300_000 : 30_000) });
    let bytes = 0;
    for (const [other, entry] of [...cache.entries].reverse()) {
      bytes += entry.value.data?.length ?? 512;
      if (entry.expires <= Date.now() || bytes > MAX_CACHE || cache.entries.size > 128) cache.entries.delete(other);
    }
    return value;
  });
  cache.tail = task; cache.pending.set(key, task);
  try { return await task; } finally { cache.pending.delete(key); }
}
