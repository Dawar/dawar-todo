import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { runtime } from './helpers/load-ts.mjs';
import { Store } from '../bot-bridge/store.mjs';
import { readSettings, configureSettings, botSettings } from '../bot-bridge/mind.mjs';

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
  const ledger = { settings: () => readSettings(store), configure: patch => configureSettings(store, patch), botSettings: id => botSettings(id, readSettings(store)) };
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

const settings = over => ({ enabled: true, coverage: 'selected', bots: { atlas: { enabled: true } }, priorities: '', activeMinutes: 30, idleMinutes: 60, nightMinutes: 180,
  quietStart: '21:00', quietEnd: '08:00', timeZone: 'America/Toronto', messagesEnabled: true, perBotDaily: 4, globalDaily: 20, speakWithBotModel: true, reviewWhileBusy: true, revision: 3, ...over });
const journal = [
  { id: 'm2', at: '2026-10-15T14:00:00.000Z', kind: 'thought', thought: 'Friday is close and the Acme call is still not booked.', decision: 'speak',
    message: 'The Acme renewal is Friday. Shall I hold 20 minutes tomorrow?', messageState: 'delivered', reason: null, tokens: 1200 },
  { id: 'm1', at: '2026-10-15T12:00:00.000Z', kind: 'thought', thought: 'Nothing urgent; Acme can wait until after lunch.', decision: 'quiet', message: null, messageState: null, reason: null, tokens: 1100 },
];
const status = over => ({ settings: settings(over), quietNow: false, metrics: { thoughtsToday: 6, messagesToday: 1, tokensToday: 12800, waiting: 0 },
  bots: [{ botId: 'atlas', name: 'Atlas', included: true, lastThinkAt: '2026-10-15T14:00:00.000Z', nextThinkAt: '2026-10-15T15:00:00.000Z', lastThought: 'Friday is close and the Acme call is still not booked.',
    failures: 0, lastError: null, lastErrorAt: null }],
  bot: { botId: 'atlas', lastThinkAt: '2026-10-15T14:00:00.000Z', nextThinkAt: '2026-10-15T15:00:00.000Z', lastError: null, lastErrorAt: null,
    loops: [{ id: 'l1', title: 'Acme renewal call', status: 'raised', note: 'asked him to book it', raisedAt: '2026-10-15T14:00:00.000Z', updatedAt: null },
      { id: 'l2', title: 'Old vendor quote', status: 'dropped', note: '', raisedAt: null, updatedAt: null }], journal } });
const idle = { saving: null, saved: null, error: '' };
const bot = (s, props = {}) => renderToStaticMarkup(h(views.ProactiveBotView, { status: s, botId: 'atlas', botName: 'Atlas', state: idle, disabled: false, onConfigure() {}, onThinkNow() {}, onManage() {}, ...props }));

test('Mind panel: Off shows only a note and the link to the global settings', () => {
  const html = bot(status({ enabled: false }));
  assert.match(html, /Proactive bots are off, so Atlas doesn/);
  assert.match(html, /<a href="\/bots\?view=proactive"[^>]*>Manage proactive bots<\/a>/);
  assert.doesNotMatch(html, /<input|<textarea|<button/, 'no controls while Off');
});

test('Mind panel: switch, Think now, what is on its mind, and the journal with what it said', () => {
  const html = bot(status());
  assert.match(html, /type="checkbox"[^>]*checked=""[^>]*\/>Inner monologue for Atlas/);
  assert.match(html, /Atlas is in the pilot/);
  assert.match(html, /<button[^>]*>Think now<\/button>/);
  assert.match(html, /On Atlas&#x27;s mind/);
  assert.match(html, /Acme renewal call<\/span><span[^>]*>Asked you/);
  assert.match(html, /line-through[^>]*>Old vendor quote/);
  assert.ok(html.indexOf('Friday is close') < html.indexOf('Nothing urgent'), 'newest thought first');
  assert.match(html, /Sent<\/p><p[^>]*>The Acme renewal is Friday/);
  assert.match(html, /Priorities for Atlas/);
  for (const global of ['Bots in the pilot', 'In total per day', 'Your priorities', 'Quiet from', 'type="radio"', 'name="active"'])
    assert.equal(html.includes(global), false, global);
  assert.match(bot(status(), { state: { saving: 'bot', saved: null, error: '' } }), /role="status"[^>]*>Saving…/);
  assert.match(bot(status({ coverage: 'all', bots: { atlas: { enabled: false } } })), /left out/);
  const empty = bot({ ...status(), bot: { ...status().bot, journal: [], loops: [] } });
  assert.match(empty, /hasn&#x27;t had a thought yet/);
  assert.match(empty, /Nothing it is tracking yet/);
  const withheld = bot({ ...status(), bot: { ...status().bot, journal: [{ ...journal[0], messageState: 'dropped', reason: 'owner-spoke' }] } });
  assert.match(withheld, /Not sent: you wrote first/);
  assert.match(bot({ ...status(), bot: { ...status().bot, journal: [{ ...journal[0], messageState: 'withheld', reason: 'paused' }] } }), /Not sent: messages are paused/);
});

test('global page: one mode control, rhythm, quiet hours, messages, advanced and every bot\'s latest thought', () => {
  const page = s => renderToStaticMarkup(h(views.ProactiveGlobalView, { status: s, bots: [{ id: 'atlas', name: 'Atlas' }, { id: 'bea', name: 'Bea' }], state: idle, disabled: false, onConfigure() {} }));
  const pilot = page(status());
  assert.equal((pilot.match(/type="radio"/g) ?? []).length, 3);
  assert.match(pilot, /checked="" value="pilot"/);
  assert.match(pilot, /Bots in the pilot/);
  assert.match(pilot, /data-avatar="bea"/);
  for (const part of ['inner monologue', 'Your priorities', 'After a conversation (minutes)', 'Overnight (minutes)', 'Quiet from', 'Quiet until', 'type="time"', 'value="21:00"',
    'Send messages', 'Per bot per day', 'In total per day', 'America/Toronto'.replace('_', ' '), 'Write messages with each bot&#x27;s own model', 'Think while working',
    'Today: 6 thoughts · 1 of 20 messages sent', '13k AI tokens', 'Friday is close and the Acme call is still not booked.'])
    assert.ok(pilot.includes(part), part);
  for (const gone of ['Loose threads', 'Snooze', 'Remind me every', 'Skip quiet bots']) assert.equal(pilot.includes(gone), false, gone);
  const all = page(status({ coverage: 'all' }));
  assert.match(all, /checked="" value="all"/);
  assert.equal(all.includes('Bots in the pilot'), false);
  assert.match(page(status({ enabled: false })), /Proactive bots are off\./);
  assert.match(page(status({ messagesEnabled: false })), /Paused: bots keep thinking[\s\S]*messages paused/);
});
