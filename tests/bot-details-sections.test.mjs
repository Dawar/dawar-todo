import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runtime } from './helpers/load-ts.mjs';

const sections = runtime().load('app/bots/bot-details-sections.ts');
const ALL = ['navigation', 'next', 'goals', 'team', 'queues', 'schedules', 'files', 'desktop', 'calls', 'history', 'settings'];

test('five top-level tabs cover every original section exactly once', () => {
  assert.deepEqual(Array.from(sections.DETAILS_TABS, tab => tab.id), ['overview', 'work', 'files', 'tools', 'settings']);
  const leaves = sections.DETAILS_TABS.flatMap(tab => [...tab.sections]);
  assert.equal(new Set(leaves).size, leaves.length);
  assert.deepEqual([...leaves, 'team'].sort(), [...ALL].sort());
  for (const leaf of leaves) assert.ok(sections.SECTION_LABELS[leaf], `label for ${leaf}`);
});

test('original section ids map to their new tab, subsection and anchor', () => {
  const expected = {
    navigation: ['overview', 'navigation'], next: ['work', 'next'], queues: ['work', 'queues'], schedules: ['work', 'schedules'],
    goals: ['work', 'goals'], history: ['work', 'history'], files: ['files', 'files'], desktop: ['tools', 'desktop'],
    calls: ['tools', 'calls'], settings: ['settings', 'settings'], team: ['settings', 'settings'],
  };
  for (const [section, [tab, leaf]] of Object.entries(expected)) {
    const location = sections.detailsLocation(section);
    assert.equal(location.tab, tab, section); assert.equal(location.leaf, leaf, section);
  }
  assert.equal(sections.detailsLocation('team').anchor, 'team');
  assert.equal(sections.detailsLocation('queues').anchor, undefined);
  assert.deepEqual({ ...sections.detailsLocation('retired-section') }, { tab: 'overview', leaf: 'navigation' });
  assert.equal(sections.DEFAULT_DETAILS_SECTION, 'navigation');
});

test('choosing a tab reopens its last subsection, else its first', () => {
  assert.equal(sections.tabSection('work'), 'next');
  assert.equal(sections.tabSection('tools'), 'desktop');
  assert.equal(sections.tabSection('work', { work: 'history' }), 'history');
  assert.equal(sections.tabSection('work', { work: 'calls' }), 'next', 'a subsection from another tab is ignored');
  assert.equal(sections.tabSection('overview', { work: 'queues' }), 'navigation');
});

test('every deep link in the workspace resolves to a real location', () => {
  const source = readFileSync('app/bots/workspace.tsx', 'utf8');
  const linked = [...source.matchAll(/openDetails\(\s*["']([a-z]+)["']\s*\)/g)].map(match => match[1]);
  assert.ok(linked.length >= 5, 'expected the existing deep links');
  for (const section of linked) {
    assert.ok(ALL.includes(section), `${section} is a known section id`);
    assert.notEqual(sections.detailsLocation(section).leaf === 'navigation', section !== 'navigation', `${section} does not fall back to Overview`);
  }
  // Every Settings group and the Team anchor are rendered for deep links.
  for (const group of sections.SETTINGS_GROUPS) assert.match(source, new RegExp(`anchor="${group.id}"`));
  assert.match(source, /data-details-anchor="team"/);
  // The panel content record supplies every leaf.
  for (const leaf of sections.DETAILS_TABS.flatMap(tab => [...tab.sections])) assert.match(source, new RegExp(`\\n\\s+${leaf}: `), `content for ${leaf}`);
});
