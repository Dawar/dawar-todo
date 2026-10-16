import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, staleReleases, worktreeHold } from '../portable/disk-cleanup.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const age = (dir, days) => {
  const t = new Date(Date.now() - days * 864e5);
  const walk = d => { for (const e of readdirSync(d, { withFileTypes: true })) { if (e.name === '.git') continue; const p = join(d, e.name); if (e.isDirectory()) walk(p); utimesSync(p, t, t); } };
  walk(dir); utimesSync(dir, t, t);
};

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'disk-cleanup-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const repo = join(home, 'bots/ernie/repo'); mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'a.txt'), 'a'); writeFileSync(join(repo, '.gitignore'), 'node_modules/\n.angular/\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'a');
  const trees = join(home, 'bots/ernie/worktrees');
  const add = (name, { commit = false, merge = false, dirty = false, days = 10 } = {}) => {
    const w = join(trees, name); git(repo, 'worktree', 'add', '-q', '-b', name, w);
    if (commit) { writeFileSync(join(w, `${name}.txt`), name); git(w, 'add', '.'); git(w, 'commit', '-qm', name); if (merge) git(repo, 'merge', '-q', '--ff-only', name); }
    if (dirty) writeFileSync(join(w, 'a.txt'), 'changed');
    mkdirSync(join(w, 'node_modules/x'), { recursive: true }); writeFileSync(join(w, 'node_modules/x/index.js'), '');
    age(w, days);
    return w;
  };
  return { home, repo, add };
}

test('only idle, clean, merged, unused worktrees are removed, and their branches stay', t => {
  const { home, repo, add } = fixture(t);
  const merged = add('merged', { commit: true, merge: true });
  const unique = add('unique', { commit: true });
  const dirty = add('dirty', { dirty: true });
  const recent = add('recent', { days: 1 });
  const busy = add('busy');
  assert.equal(worktreeHold(merged), null);
  const report = cleanup({ home, cwds: [join(busy, 'src')] });
  assert.deepEqual(report.worktrees, [merged]);
  assert.equal(existsSync(merged), false);
  for (const kept of [unique, dirty, recent, busy]) assert.ok(existsSync(kept), kept);
  assert.deepEqual(report.held, { 'commits only on its own branch': 1, 'uncommitted changes': 1, 'recently changed': 1, 'in use': 1 });
  assert.match(git(repo, 'branch', '--list', 'merged'), /merged/, 'the branch survives');
});

test('a dry run reports without deleting', t => {
  const { home, add } = fixture(t);
  const merged = add('merged', { commit: true, merge: true });
  const cache = join(merged, 'dash/.angular/cache'); mkdirSync(cache, { recursive: true }); writeFileSync(join(cache, 'blob'), 'x'.repeat(4096));
  age(join(merged, 'dash'), 10);
  const report = cleanup({ home, dryRun: true, cwds: [] });
  assert.deepEqual(report.worktrees, [merged]);
  assert.deepEqual(report.angularCaches, [cache]);
  assert.ok(existsSync(merged) && existsSync(cache));
});

test('idle Angular caches go even in worktrees that stay; fresh ones stay', t => {
  const { home, add } = fixture(t);
  const w = add('recent', { days: 1 });
  const idle = join(w, 'dash/.angular/cache'); mkdirSync(idle, { recursive: true }); age(join(w, 'dash'), 3);
  const fresh = join(w, 'web/.angular/cache'); mkdirSync(fresh, { recursive: true });
  const report = cleanup({ home, cwds: [] });
  assert.deepEqual(report.angularCaches, [idle]);
  assert.ok(existsSync(w) && existsSync(fresh) && !existsSync(idle));
});

test('Codex releases: current, running and the newest two stay', () => {
  const names = ['0.157.0-x', '0.159.3-x', '0.160.1-x', '0.161.0-x', '0.162.1-x', '0.163.0-x'];
  assert.deepEqual(staleReleases(names, { current: '0.163.0-x', running: ['0.159.3-x'] }), ['0.157.0-x', '0.160.1-x', '0.161.0-x']);
});
