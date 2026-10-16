#!/usr/bin/env node
// Daily disk cleanup for the bot server. Removes only what can be recreated:
// idle, clean, fully merged bot worktrees (their branches stay), idle Angular
// build caches, Codex releases nothing runs, and an oversized npm cache.
// Never touches Claude Code worktrees, Codex sessions or live data.
//
//   node portable/disk-cleanup.mjs [--dry-run]
//
// Installed as ~/.local/lib/dawar-maintenance/disk-cleanup.mjs, run daily at
// 04:30 UTC by dawar-disk-cleanup.timer (systemd user unit). After changing
// this file, reinstall it there with `install -m 0755`.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readlinkSync, rmSync, statSync, statfsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const DAY = 864e5;
const SKIP = new Set(['node_modules', '.angular', '.next', '.next-portable', '.turbo', 'dist', 'build', 'out', '.expo', '.gradle', '.git']);

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 }).trim();
const children = dir => { try { return readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => join(dir, d.name)); } catch { return []; } };

/** Newest mtime among the worktree's own files (dependencies and build output ignored), to `depth` levels. */
export function newestChange(dir, depth = 3) {
  let newest = 0;
  const walk = (d, level) => {
    let entries; try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const p = join(d, e.name);
      try { newest = Math.max(newest, statSync(p).mtimeMs); } catch { continue; }
      if (e.isDirectory() && level < depth) walk(p, level + 1);
    }
  };
  walk(dir, 1);
  return newest;
}

/** Working directories of every running process (a worktree in use is never touched). */
export function processDirectories() {
  const out = [];
  for (const pid of readdirSync('/proc').filter(n => /^\d+$/.test(n))) { try { out.push(readlinkSync(`/proc/${pid}/cwd`)); } catch { /* gone or not ours */ } }
  return out;
}
const inUse = (dir, cwds) => cwds.some(c => c === dir || c.startsWith(dir + '/'));

/** Why a worktree must stay, or null when removing it loses nothing. */
export function worktreeHold(dir, { now = Date.now(), idleDays = 7, cwds = [] } = {}) {
  if (!existsSync(join(dir, '.git'))) return 'not a git worktree';
  if (inUse(dir, cwds)) return 'in use';
  if (now - newestChange(dir) < idleDays * DAY) return 'recently changed';
  if (git(dir, 'status', '--porcelain')) return 'uncommitted changes';
  let branch = ''; try { branch = git(dir, 'symbolic-ref', '-q', '--short', 'HEAD'); } catch { /* detached */ }
  const others = git(dir, 'for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes').split('\n').filter(r => r && r !== `refs/heads/${branch}`);
  if (!others.length || git(dir, 'rev-list', '--count', 'HEAD', '--not', ...others) !== '0') return 'commits only on its own branch';
  return null;
}

/** Codex releases to delete: not current, not running, and older than the newest `keep`. */
export function staleReleases(names, { current, running = [], keep = 2 }) {
  const version = n => n.split('-')[0].split('.').map(Number);
  const sorted = [...names].sort((a, b) => { const x = version(a), y = version(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; });
  const kept = new Set([current, ...running, ...sorted.slice(-keep)]);
  return sorted.filter(n => !kept.has(n));
}

const size = p => { try { return Number(execFileSync('du', ['-xsk', p], { encoding: 'utf8' }).split('\t')[0]) * 1024; } catch { return 0; } };

export function cleanup({ home = homedir(), dryRun = false, now = Date.now(), cwds = processDirectories(), idleDays = 7, cacheIdleDays = 2, npmCacheLimit = 5 * 2 ** 30, log = () => {} } = {}) {
  const report = { worktrees: [], held: {}, angularCaches: [], codexReleases: [], npmCache: 0, freedBytes: 0, dryRun };
  const free = (p, kind) => { const bytes = size(p); report.freedBytes += bytes; log({ kind, path: p, bytes }); return bytes; };

  // 1. Idle, clean, merged worktrees; `git worktree remove` keeps the branch.
  const roots = [...children(join(home, 'bots')).map(b => join(b, 'worktrees')), join(home, '.local/share/dawar-todo-bots/manager/worktrees')];
  for (const dir of roots.flatMap(children)) {
    let hold; try { hold = worktreeHold(dir, { now, idleDays, cwds }); } catch (e) { hold = `unreadable: ${e.message.split('\n')[0]}`; }
    if (hold) { report.held[hold] = (report.held[hold] ?? 0) + 1; continue; }
    free(dir, 'worktree');
    if (!dryRun) git(dir, 'worktree', 'remove', dir);
    report.worktrees.push(dir);
  }

  // 2. Angular build caches nobody has written to recently.
  const projects = [join(home, 'bots'), join(home, 'Projects'), join(home, '.local/share/dawar-todo-bots/manager/worktrees')].filter(existsSync);
  // Unreadable folders (a bot's MySQL data, say) make find exit non-zero; what it did find still counts.
  const found = projects.length ? spawnSync('find', [...projects, '-xdev', '-type', 'd', '-name', 'node_modules', '-prune', '-o', '-type', 'd', '-path', '*/.angular/cache', '-prune', '-print'], { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] }).stdout.split('\n').filter(Boolean) : [];
  for (const cache of found) {
    const project = dirname(dirname(cache));
    if (inUse(project, cwds) || now - statSync(cache).mtimeMs < cacheIdleDays * DAY) continue;
    free(cache, 'angular-cache');
    if (!dryRun) rmSync(cache, { recursive: true, force: true });
    report.angularCaches.push(cache);
  }

  // 3. Codex releases nothing points to or runs.
  const running = [];
  for (const pid of readdirSync('/proc').filter(n => /^\d+$/.test(n))) { try { running.push(readlinkSync(`/proc/${pid}/exe`)); } catch { /* not ours */ } }
  for (const pkg of children(join(home, '.codex/packages'))) {
    const releases = join(pkg, 'releases');
    if (!existsSync(releases)) continue;
    let current = null; try { current = readlinkSync(join(pkg, 'current')).split('/').pop(); } catch { /* none */ }
    const names = readdirSync(releases).filter(n => /^\d+\.\d+\.\d+-/.test(n));
    const busy = names.filter(n => running.some(e => e.startsWith(join(releases, n) + '/')));
    for (const n of staleReleases(names, { current, running: busy })) {
      free(join(releases, n), 'codex-release');
      if (!dryRun) rmSync(join(releases, n), { recursive: true, force: true });
      report.codexReleases.push(n);
    }
  }

  // 4. The npm download cache, once it outgrows its limit.
  const npm = join(home, '.npm/_cacache');
  if (existsSync(npm) && size(npm) > npmCacheLimit) {
    report.npmCache = free(npm, 'npm-cache');
    if (!dryRun) rmSync(npm, { recursive: true, force: true });
  }

  const fs = statfsSync(home);
  report.diskUsedPercent = Math.round(100 * (1 - fs.bavail / fs.blocks));
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = cleanup({ dryRun: process.argv.includes('--dry-run') });
  const gb = b => Math.round(b / 2 ** 30 * 10) / 10;
  const summary = { dryRun: report.dryRun, freedGB: gb(report.freedBytes), worktrees: report.worktrees.length, held: report.held,
    angularCaches: report.angularCaches.length, codexReleases: report.codexReleases, npmCacheGB: gb(report.npmCache), diskUsedPercent: report.diskUsedPercent };
  console.log(JSON.stringify(summary));
  // Shows up as a warning in the journal; the unit exits non-zero so it is visible in systemctl.
  if (report.diskUsedPercent >= 85) { console.error(`Disk is ${report.diskUsedPercent}% full after cleanup.`); process.exitCode = 2; }
}
