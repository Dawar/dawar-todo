// Production UI, native browser stores, public synthetic content only.
import React, { Activity } from 'react';
import { createRoot } from 'react-dom/client';
import { BotsWorkspace } from '../../app/bots/workspace';
import { botsClient as client } from '../../app/bots/client';
import { botComposers } from '../../app/bots/composer-service';
import { historyTail } from '../../lib/bot-history-view';
import { getBotTimeline } from '../../app/bots/use-timeline';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, label) => { for (let i = 0; i < 500; i++) { if (fn()) return; await wait(10); } throw new Error(label); };
const check = (value, label) => { if (!value) throw new Error(label); };
const bot = (id, name, purpose) => ({ id, name, purpose, slug: id, cwd: '/synthetic', threadId: id, color: '#3d8065', status: 'idle', archived: false, model: 'gpt-6', effort: 'high', mode: 'default', preview: purpose, updatedAt: '2026-09-27T09:30:00Z', lastReadAt: '2026-09-27T09:30:00Z', activeTurnId: null });
const bots = [bot('design-a', 'Studio · Planning & ideas', 'A little clarity for your next big thing.'), bot('design-b', 'Field notes', 'Keep the details worth remembering.')];
const snapshot = { bots, pending: [], cursor: 0, ready: true, models: [{ id: 'gpt-6', model: 'gpt-6', displayName: 'GPT-6', supportedReasoningEfforts: [{ reasoningEffort: 'high' }], serviceTiers: [{ id: 'fast' }] }], schedules: [], runs: [], defaults: { model: 'gpt-6', effort: 'high' } };
let scene = 'populated', generation = 0;
const root = createRoot(document.getElementById('root'));
const show = (mode = 'visible') => root.render(<Activity mode={mode}><BotsWorkspace /></Activity>);
const field = () => document.querySelector('.bots-composer textarea');
const selected = () => new URLSearchParams(location.search).get('bot') || 'design-a';
const composer = () => botComposers.peek(client.owner, selected());
const message = (id, text, type = 'agentMessage') => type === 'userMessage' ? { id, type, content: [{ type: 'text', text, text_elements: [] }] } : { id, type, text, phase: 'final_answer', memoryCitation: null, questions: null, delivery: null };
const turns = () => scene === 'empty' ? [] : [{ id: 'design-turn', status: 'completed', startedAt: 1789891200, itemsView: 'full', items: [
  message('user', 'Help me make room for the work that matters this week.', 'userMessage'),
  ...Array.from({ length: 2 }, (_, i) => ({ id: `tool-${i}`, type: 'commandExecution', command: 'Review weekly notes', status: 'completed', aggregatedOutput: 'A synthetic work note. No real account data.' })),
  message('answer', '### A lighter week, with a little more focus\n\nStart with one meaningful outcome: **finish the launch story**. Give it your best hour before the small things take over.\n\n- **Monday:** shape the idea and choose three examples.\n- **Tuesday:** write the first draft, then take a walk.\n- **Wednesday:** share it with someone whose taste you trust.\n\nLeave a little white space. A good plan should help you breathe.'),
  message('followup', 'Love this. Let’s keep Friday open.', 'userMessage'),
  message('last', 'Friday stays open. We can use it for a final polish—or simply enjoy having finished early.'),
] }];
client.start = () => {};
client.rpc = async (method, botId, params) => {
  if (method === 'history.view') {
    if (scene === 'loading') return new Promise(() => {});
    await wait(30);
    if (scene === 'error') throw new Error('The conversation could not load. Your draft is safe.');
    return { kind: 'page', entries: historyTail(turns()), contextEntries: [], attachments: [], olderCursor: null, revision: 'design', eventCursor: 0, complete: true };
  }
  if (method === 'history.detail') { const item = turns()[0].items.find((x) => x.id === params.itemId); return { json: JSON.stringify(item), nextOffset: null, totalLength: 100, version: 'design', eventCursor: 0 }; }
  if (method === 'usage.account') return { accountType: 'chatgpt', ordinaryUsageAllowed: true, availableResetCredits: null, limits: [{ limitId: 'standard', limitName: 'Your plan', model: null, windows: [{ usedPercent: 12, windowDurationMins: 10080, resetsAt: Math.floor(Date.now()/1000) + 183840 }, { usedPercent: 0, windowDurationMins: 300, resetsAt: Math.floor(Date.now()/1000)+10860 }] }], readAt: new Date().toISOString() };
  if (method === 'turn.send') return { turn: { id: 'synthetic-sent' } };
  return [];
};
const select = (id) => { history.pushState({}, '', `/preview?bot=${id}`); window.dispatchEvent(new PopStateEvent('popstate')); };
window.design = {
  async scenario(name = 'populated') {
    scene = name; client.owner = `design-owner-${++generation}`; client.online = name !== 'offline'; client.error = ''; client.snapshot = { ...snapshot, bots: [...bots] };
    client.notify(); select('design-a'); show();
    await until(() => composer()?.ready && field(), 'composer ready'); await wait(150);
    if (name === 'offline') { const timeline = getBotTimeline(client.owner, 'design-a'); timeline.seed(turns(), []); await timeline.flush(); }
    if (name === 'recovery') { this.type('Keep this draft safe while I reconnect.'); await composer().flush(); composer().storageError = 'This draft could not be saved. Your words are still here; retry before closing.'; client.notify(); }
    await wait(100); return this.layout();
  },
  type(value) { const el = field(); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); },
  async restored(value) { composer().setText(value); await composer().flush(); await wait(40); },
  select,
  async activity() { show('hidden'); await wait(60); show(); await wait(100); },
  async keyboard(height) { field().focus(); Object.defineProperty(visualViewport, 'height', { configurable: true, get: () => height }); visualViewport.dispatchEvent(new Event('resize')); await wait(300); },
  async dismissKeyboard() { field().blur(); Object.defineProperty(visualViewport, 'height', { configurable: true, get: () => innerHeight }); visualViewport.dispatchEvent(new Event('resize')); await wait(300); },
  async emptyHeightReproduction() {
    this.type('A typed draft before send.\n'.repeat(18)); await composer().flush(); await wait(60);
    const typedHeight = field().getBoundingClientRect().height;
    await this.restored(''); field().blur();
    return { typedHeight, emptyHeight: field().getBoundingClientRect().height, focused: document.activeElement === field() };
  },
  async tallRegression() {
    await this.restored('A long draft before send.\n'.repeat(16)); const tall = field().getBoundingClientRect().height;
    await this.restored(''); field().blur(); const cleared = field().getBoundingClientRect().height;
    check(cleared <= 42 && tall > cleared, 'restored/cleared empty textarea retained height');
    await this.restored('A second long draft\n'.repeat(12)); select('design-b'); await until(() => field()?.value === '', 'empty bot switch'); await wait(60);
    check(field().getBoundingClientRect().height <= 42, 'empty switched bot retained height');
    select('design-a'); await until(() => field()?.value.includes('second'), 'restore long draft'); await wait(60);
    check(field().getBoundingClientRect().height > 42, 'long restored draft did not resize');
    await this.restored(''); await this.activity(); check(field().getBoundingClientRect().height <= 42, 'Activity empty height');
    this.type('Send me'); await composer().flush(); await composer().send(); await wait(70); check(field().value === '' && field().getBoundingClientRect().height <= 42, 'sent empty height');
    field().placeholder = 'An intentionally very long placeholder '.repeat(20);
    window.dispatchEvent(new Event('resize')); await wait(50); check(field().getBoundingClientRect().height <= 42, 'placeholder changed empty height');
    await this.restored('One line'); field().style.lineHeight = '32px'; await wait(60);
    check(field().getBoundingClientRect().height >= 48, 'font change did not remeasure');
    field().style.lineHeight = ''; await this.restored(''); field().placeholder = 'Message…';
    return { restoredHeight: tall, clearedHeight: cleared, botSwitch: true, activity: true, send: true, longPlaceholder: true, fontChange: true };
  },
  async jumpCheck() {
    const scroll = document.querySelector('.bots-messages'); scroll.scrollTop = 0; scroll.dispatchEvent(new Event('scroll')); await wait(40);
    const away = scroll.scrollHeight - scroll.clientHeight > 120;
    check(Boolean(document.querySelector('.bots-jump-latest')) === away, 'jump away visibility');
    if (away) document.querySelector('.bots-jump-latest').click(); await wait(50);
    check(!document.querySelector('.bots-jump-latest'), 'jump remains at bottom');
    check(!document.querySelector('.bots-messages').textContent.includes('Files and artifacts'), 'artifact tail remains');
    const disclosure = document.querySelector('.bots-activity > summary'); disclosure?.click(); await wait(70);
    check(!document.querySelector('.bots-jump-latest'), 'tool expansion abandoned follow-latest');
    client.receive({ type: 'event', event: { seq: 1, botId: selected(), type: 'codex', data: { method: 'item/agentMessage/delta', params: { turnId: 'design-turn', itemId: 'last', delta: '\n\nOne more thought. '.repeat(15) } } } });
    await wait(100); check(!document.querySelector('.bots-jump-latest'), 'stream abandoned follow-latest');
    return { showedAway: away, hiddenAtBottom: true, expandedTool: true, stream: true };
  },
  layout() { const el = field(), r = el?.getBoundingClientRect(); return { width: innerWidth, height: innerHeight, visualHeight: visualViewport.height, inputHeight: r?.height, inputBottom: r?.bottom, value: el?.value, hasJump: Boolean(document.querySelector('.bots-jump-latest')), routineStatus: Boolean(document.querySelector('.bots-draft-status')), bodyWidth: document.body.scrollWidth }; },
};
