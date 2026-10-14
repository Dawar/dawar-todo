import { lstat, stat, realpath } from 'node:fs/promises';
import { relative, isAbsolute, resolve } from 'node:path';

export async function containedPath(root, path) {
  const realRoot = await realpath(root), target = await realpath(path);
  const rel = relative(realRoot, target);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Path is outside the bot workspace.');
  return target;
}

// Application file guard, not an OS sandbox for shell/plugins. Linux retains
// its kernel FD proof. Darwin uses the original open object, canonical owned
// root, and repeat path/root identity checks. Call before and after consuming
// bytes; a rejected read must not publish its bytes. Never reopen by this path.
export async function containedHandle(root, path, handle, platform = process.platform) {
  if (platform === 'linux') return containedPath(root, `/proc/self/fd/${handle.fd}`);
  if (platform !== 'darwin') throw new Error('This filesystem containment adapter is unavailable.');
  const canonicalRoot = resolve(root), initialRoot = await lstat(canonicalRoot, { bigint: true });
  if (!initialRoot.isDirectory() || initialRoot.isSymbolicLink() || await realpath(root) !== canonicalRoot)
    throw new Error('The registered workspace must remain a real directory.');
  const target = await containedPath(root, path), opened = await handle.stat({ bigint: true });
  const current = await stat(target, { bigint: true }), finalRoot = await lstat(canonicalRoot, { bigint: true });
  if (opened.dev !== current.dev || opened.ino !== current.ino || opened.isFile() !== current.isFile() ||
      opened.isDirectory() !== current.isDirectory() || initialRoot.dev !== finalRoot.dev || initialRoot.ino !== finalRoot.ino ||
      !finalRoot.isDirectory() || finalRoot.isSymbolicLink() || await realpath(root) !== canonicalRoot || target !== await containedPath(root, path))
    throw new Error('Registered path changed after opening. Its original object was retained.');
  return target;
}
