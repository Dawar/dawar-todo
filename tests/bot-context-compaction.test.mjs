import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/load-ts.mjs';

const env = runtime();
const c = env.load('lib/bot-context-compaction.ts');
const at = Date.parse('2026-10-15T00:00:00Z');
const context = (tokens, extra = {}) => ({ tokens, window: 272_000, observedAt: new Date(at).toISOString(), lastActivityAt: new Date(at).toISOString(), compacted: false, ...extra });

test('status shows the lifecycle truthfully, never Completed from an ACK', () => {
  assert.equal(c.compactionStatus({ contextCompaction: { state: null, context: null } }), null);
  assert.equal(c.compactionStatus({ contextCompaction: { state: 'compacting', trigger: 'manual', context: null } }), 'Compaction: Compacting…');
  assert.equal(c.compactionStatus({ contextCompaction: { state: 'unconfirmed', trigger: 'idle', reason: 'Not repeated.', context: null } }), 'Idle compaction: Unconfirmed — Not repeated.');
  assert.equal(c.compactionStatus({ contextCompaction: { state: 'completed', beforeTokens: 230_000, afterTokens: 31_000, context: null } }), 'Compaction: Completed · 230k → 31k tokens');
  assert.equal(c.compactionInFlight({ contextCompaction: { state: 'requested', context: null } }), true);
});

test('context summary uses current context against the 200k / 54 minute default policy', () => {
  assert.match(c.contextSummary({}), /not known yet/);
  assert.match(c.contextSummary({ contextCompaction: { state: null, context: context(150_000) } }, at), /150k of 272k.*Below the 200k/);
  assert.match(c.contextSummary({ contextCompaction: { state: null, context: context(210_000) } }, at + 10 * 60_000), /after 44 more idle minutes/);
  assert.match(c.contextSummary({ contextCompaction: { state: null, context: context(210_000) } }, at + 54 * 60_000), /is due/);
  assert.match(c.contextSummary({ idleCompaction: { enabled: false, thresholdTokens: 200_000, idleMinutes: 54 }, contextCompaction: { state: null, context: context(210_000) } }), /off/);
  assert.match(c.contextSummary({ contextCompaction: { state: null, context: context(210_000, { window: 128_000 }) } }), /does not fit/);
  assert.equal(JSON.stringify(c.idleCompactionPolicy({})), JSON.stringify({ enabled: true, thresholdTokens: 200_000, idleMinutes: 54 }));
});
