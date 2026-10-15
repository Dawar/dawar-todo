import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { runtime } from './helpers/load-ts.mjs';
import { Store } from '../bot-bridge/store.mjs';
import { InitiativeLedger } from '../bot-bridge/initiative-ledger.mjs';

const plain = tag => ({ children, ...props }) => { for (const key of ['asChild', 'variant', 'size']) delete props[key]; return h(tag, props, children); };
const mocks = {
  '@/components/ui/button': { Button: plain('button') },
  '@/components/ui/input': { Input: props => h('input', props) },
  '@/components/ui/textarea': { Textarea: props => h('textarea', props) },
  [resolve('app/bots/bot-avatar.tsx')]: { BotAvatar: ({ bot }) => h('span', { 'data-avatar': bot.id }) },
};
const env = runtime({}, mocks);
const loaded = env.load('app/bots/proactive-mode.ts');
// Plain objects across the vm boundary, so deepEqual compares values only.
const plainResult = fn => (...args) => { const v = fn(...args); return v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v; };
const mode = Object.fromEntries(Object.entries(loaded).map(([k, v]) => [k, typeof v === 'function' ? plainResult(v) : v]));
const views = env.load('app/bots/proactive-views.tsx');

test('mode control maps Off / Pilot / All onto enabled and coverage, and back', () => {
  assert.equal(mode.modeOf({ enabled: false, coverage: 'all' }), 'off');
  assert.equal(mode.modeOf({ enabled: false, coverage: 'selected' }), 'off');
  assert.equal(mode.modeOf({ enabled: true, coverage: 'selected' }), 'pilot');
  assert.equal(mode.modeOf({ enabled: true, coverage: 'all' }), 'all');
  assert.deepEqual(mode.modePatch('off'), { enabled: false }, 'Off keeps the pilot selection for later');
  assert.deepEqual(mode.modePatch('pilot'), { enabled: true, coverage: 'selected' });
  assert.deepEqual(mode.modePatch('all'), { enabled: true, coverage: 'all' });
  for (const m of ['off', 'pilot', 'all']) assert.equal(mode.modeOf({ enabled: false, coverage: 'selected', ...mode.modePatch(m) }), m);
});

test('per-bot switch semantics match what the hub actually does, in every mode', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'proactive-ui-'));
  const store = new Store(join(dir, 's.sqlite'));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const ledger = new InitiativeLedger(store);
  const agree = id => assert.equal(mode.botIncluded(ledger.settings(), id), ledger.botSettings(id).enabled, `${id} in ${mode.modeOf(ledger.settings())}`);
  // Pilot: only bots switched on take part; switching off clears the stored choice.
  ledger.configure(mode.modePatch('pilot'));
  agree('atlas');
  assert.equal(mode.botIncluded(ledger.settings(), 'atlas'), false);
  ledger.configure(mode.botPatch('pilot', 'atlas', true));
  assert.deepEqual(ledger.settings().bots.atlas, { enabled: true });
  agree('atlas'); agree('bea');
  ledger.configure(mode.botPatch('pilot', 'atlas', false));
  assert.deepEqual(ledger.settings().bots.atlas ?? {}, {}, 'no switch state left behind');
  agree('atlas');
  // All: every bot unless switched off; switching back on clears it.
  ledger.configure(mode.modePatch('all'));
  agree('atlas'); assert.equal(mode.botIncluded(ledger.settings(), 'bea'), true);
  ledger.configure(mode.botPatch('all', 'bea', false));
  assert.deepEqual(ledger.settings().bots.bea, { enabled: false });
  agree('bea'); assert.equal(mode.botIncluded(ledger.settings(), 'bea'), false);
  ledger.configure(mode.botPatch('all', 'bea', true));
  assert.deepEqual(ledger.settings().bots.bea ?? {}, {});
  agree('bea');
  // Off: nobody takes part and there is no per-bot switch; the pilot selection survives.
  ledger.configure(mode.botPatch('pilot', 'atlas', true));
  ledger.configure(mode.modePatch('pilot'));
  ledger.configure(mode.modePatch('off'));
  agree('atlas'); assert.equal(mode.botPatch('off', 'atlas', true), null);
  ledger.configure(mode.modePatch('pilot'));
  assert.equal(mode.botIncluded(ledger.settings(), 'atlas'), true, 'turning the pilot back on restores its bots');
  // Bot priorities are kept apart from the switch.
  ledger.configure({ bots: { atlas: { priorities: 'Clients first' } } });
  assert.deepEqual(ledger.settings().bots.atlas, { enabled: true, priorities: 'Clients first' });
  assert.match(mode.botSwitchCopy('pilot', 'Atlas', true), /in the pilot/);
  assert.match(mode.botSwitchCopy('all', 'Atlas', false), /left out/);
});

const settings = over => ({ enabled: true, coverage: 'selected', bots: { atlas: { enabled: true } }, scanMinutes: 25, baselineMinutes: 120, perBotDaily: 2, globalDaily: 5,
  priorities: '', looseThreads: true, triage: false, revision: 3, ...over });
const status = over => ({ settings: settings(over), metrics: { publishedToday: 1, reviewTokensToday: 12000, extractionTokensToday: 800, openLooseThreads: 1 },
  bots: [{ botId: 'atlas', name: 'Atlas', included: true, lastReviewAt: '2026-10-15T12:00:00.000Z', nextReviewAt: '2026-10-15T14:00:00.000Z', failures: 0, lastError: null, lastErrorAt: null }],
  bot: { botId: 'atlas', lastReviewAt: '2026-10-15T12:00:00.000Z', nextReviewAt: '2026-10-15T14:00:00.000Z', lastError: null, lastErrorAt: null },
  looseThreads: [{ id: 'i1', title: 'Call Acme', status: 'candidate', due: true, ageHours: 47, responsibleBot: 'atlas', responsibleName: 'Atlas', snoozedUntil: null,
    mentions: [{ bot: 'Connie', botId: 'connie', at: '2026-10-13T15:00:00.000Z', quote: 'call Acme about their renewal' }] }] });
const idle = { saving: null, saved: null, error: '' };
const bot = (s, props = {}) => renderToStaticMarkup(h(views.ProactiveBotView, { status: s, botId: 'atlas', botName: 'Atlas', state: idle, disabled: false, onConfigure() {}, onThread() {}, onManage() {}, ...props }));

test('per-bot panel: Off shows only a note and the link to the global settings', () => {
  const html = bot(status({ enabled: false }));
  assert.match(html, /Proactive bots are off, so Atlas won/);
  assert.match(html, /<a href="\/bots\?view=proactive"[^>]*>Manage proactive bots<\/a>/);
  assert.doesNotMatch(html, /<input|<textarea|<button/, 'no controls while Off');
});

test('per-bot panel keeps only the bot\'s own controls', () => {
  const html = bot(status());
  assert.match(html, /type="checkbox"[^>]*checked=""[^>]*\/>Proactive for Atlas/);
  assert.match(html, /Atlas is in the pilot/);
  assert.match(html, /Priorities for Atlas/);
  assert.match(html, /call Acme about their renewal/);
  assert.match(html, /Manage proactive bots/);
  for (const global of ['Bots in the pilot', 'Messages per day in total', 'Your priorities', 'Look again every', 'Skip quiet bots', 'type="radio"', 'name="hours"'])
    assert.equal(html.includes(global), false, global);
  assert.match(bot(status(), { state: { saving: 'bot', saved: null, error: '' } }), /role="status"[^>]*>Saving…/);
  assert.match(bot(status(), { state: { saving: null, saved: 'bot', error: '' } }), /role="status"[^>]*>Saved/);
});

test('global page: one mode control, pilot picker only in Pilot, status and every loose thread', () => {
  const page = s => renderToStaticMarkup(h(views.ProactiveGlobalView, { status: s, bots: [{ id: 'atlas', name: 'Atlas' }, { id: 'bea', name: 'Bea' }], state: idle, disabled: false, onConfigure() {}, onThread() {} }));
  const pilot = page(status());
  assert.equal((pilot.match(/type="radio"/g) ?? []).length, 3);
  assert.match(pilot, /checked="" value="pilot"/);
  assert.match(pilot, /Bots in the pilot/);
  assert.match(pilot, /data-avatar="bea"/);
  for (const part of ['Things you mentioned that went nowhere', 'Your priorities', 'Look again every (hours)', 'Messages per bot per day', 'Messages per day in total',
    '<summary', 'Advanced', 'Skip quiet bots', 'Today: 1 of 5 messages sent', '13k AI tokens', 'Last look', 'Said to Connie', '“call Acme about their renewal”', 'Snooze', 'Dismiss', 'Resolve'])
    assert.ok(pilot.includes(part), part);
  const all = page(status({ coverage: 'all' }));
  assert.match(all, /checked="" value="all"/);
  assert.equal(all.includes('Bots in the pilot'), false);
  assert.match(page(status({ enabled: false })), /Proactive bots are off\./);
});
