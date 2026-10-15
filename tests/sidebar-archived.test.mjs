import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/load-ts.mjs';

const env = runtime();
const { searchSidebarBots } = env.load('app/bots/announcement-state.ts');
const bot = (id, name, extra = {}) => ({ id, name, purpose: '', extension: undefined, teamId: null, ...extra });

test('archived bots never appear in sidebar search; they have their own list', () => {
  const bots = [bot('a', 'Connie'), bot('b', 'Conrad', { archived: true }), bot('c', 'Cora', { deletedAt: '2026-10-01' })];
  assert.deepEqual(Array.from(searchSidebarBots(bots, [], ''), b => b.id), ['a']);
  assert.deepEqual(Array.from(searchSidebarBots(bots, [], 'con'), b => b.id), ['a'], 'an explicit search does not surface archived bots');
  assert.deepEqual(Array.from(searchSidebarBots(bots, [], 'conrad'), b => b.id), []);
});
