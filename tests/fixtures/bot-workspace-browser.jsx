import { historyTail } from "../../lib/bot-history-view";
import React, { Activity } from 'react';
import { createRoot } from 'react-dom/client';
import { botsClient as client } from '../../app/bots/client';
import { BotsWorkspace } from '../../app/bots/workspace';
import { botComposers } from '../../app/bots/composer-service';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (condition, label) => { if (!condition) throw new Error(label); };
const until = async (fn, label) => { for (let i = 0; i < 400; i++) { if (fn()) return; await wait(10); } throw new Error(`Timed out: ${label}`); };
const owner = 'synthetic-browser-owner';
const bots = ['A', 'B'].map((id) => ({ id, name: `Bot ${id}`, purpose: '', slug: id, cwd: '/synthetic', threadId: `thread-${id}`, color: '#216e4e', status: 'idle', archived: false,
  model: null, effort: null, mode: 'default', preview: '', updatedAt: '2026-09-26T00:00:00Z', lastReadAt: '2026-09-26T00:00:00Z', activeTurnId: null }));
client.start = () => {};
client.owner = owner;
client.online = !location.search.includes('offline');
client.snapshot = { bots, pending: [], cursor: 0, ready: true, models: [], schedules: [], runs: [], defaults: { model: 'synthetic', effort: 'medium' } };
const histories = [], sends = [];
client.rpc = async (method, botId, params, id) => {
  if (method === 'history.view') return new Promise((resolve) => histories.push({ botId, resolve }));
  if (method === 'turn.send' || method === 'queue.update') return new Promise((resolve) => sends.push({ botId, params, id, resolve }));
  return [];
};
const input = () => document.querySelector('textarea[aria-label^="Message "]');
const composer = (id = 'A') => botComposers.peek(owner, id);
const type = (value) => {
  const field = input();
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
};
const select = (id) => {
  history.pushState({}, '', `/harness?bot=${id}`);
  window.dispatchEvent(new PopStateEvent('popstate'));
};
const historyValue = (label) => ({ kind: 'page', entries: historyTail([{ id: label, status: 'completed', itemsView: 'full', items: [{ id: `${label}-item`, type: 'agentMessage', text: label, phase: 'final_answer' }] }]), attachments: [], olderCursor: null, revision: 'test', eventCursor: 0, complete: true });
const root = createRoot(document.getElementById('root'));
const show = (mode = "visible") => root.render(<Activity mode={mode}><BotsWorkspace /></Activity>);
show();
window.durability = {
  async races() {
    select('A'); await until(() => histories.length === 1 && composer()?.ready, 'first A');
    type('A draft before switch');
    select('B'); await until(() => histories.length === 2 && composer('B')?.ready, 'B');
    type('B draft');
    select('A'); await until(() => histories.length === 2 && input()?.value === 'A draft before switch', 'return A');
    histories[0].resolve(historyValue('new A history')); await until(() => document.querySelector('.bots-messages')?.textContent.includes('new A history'), 'new history');
    type('newer A typing');
    histories[1].resolve(historyValue('B history'));
    await wait(60);
    check(document.querySelector('.bots-messages').textContent.includes('new A history'), 'old A response overwrote newer A');
    check(!document.querySelector('.bots-messages').textContent.includes('stale A history'), 'stale history visible');
    check(input().value === 'newer A typing', 'history replaced typing');
    client.receive({ type: 'event', event: { type: 'history.refresh', botId: 'A', seq: 1, data: {} } });
    await until(() => histories.length === 3, 'refresh requested');
    type('typed during refresh'); histories[2].resolve(historyValue('refreshed A history'));
    await until(() => document.querySelector('.bots-messages').textContent.includes('refreshed A history'), 'refreshed history');
    check(input().value === 'typed during refresh', 'refresh lost draft');
    client.receive({ type: 'event', event: { type: 'codex', botId: 'A', seq: 2, data: { method: 'item/agentMessage/delta', params: { turnId: 'refreshed A history', itemId: 'refreshed A history-item', delta: ' cached-last-delta' } } } });
    await composer().flush();
    document.querySelector('button[aria-label="Send message"]').click();
    await until(() => sends.length === 1, 'send');
    type('new typing after send');
    select('B'); await until(() => input()?.getAttribute('aria-label') === 'Message Bot B', 'selected B');
    check(input().value === 'B draft', 'other bot draft not recovered');
    sends[0].resolve({ turn: { id: 'sent' } }); await composer().flush(); await wait(60);
    check(input().value === 'B draft', 'late acknowledgement modified B');
    select('A'); await until(() => input()?.value === 'new typing after send', 'newer A draft preserved');
    client.online = false; client.notify(); await wait(30);
    const fileInput = document.querySelector('input[type="file"]');
    const transfer = new DataTransfer(); transfer.items.add(new File(['offline-image-bytes'], 'offline.png', { type: 'image/png' }));
    transfer.items.add(new File(['offline-document-bytes'], 'offline.txt', { type: 'text/plain' }));
    fileInput.files = transfer.files; fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    await until(() => composer().draft.files.length === 2 && composer().saved, 'offline staging committed');
    await until(() => document.querySelector('.bots-upload-image img')?.src.startsWith('blob:'), 'local preview');
    type('last input before pagehide'); window.dispatchEvent(new Event('pagehide'));
    await until(() => composer().saved, 'pagehide commit');
    window.dispatchEvent(new Event('dawar-before-navigation')); show('hidden'); await wait(30); show();
    await until(() => input()?.value === 'last input before pagehide', 'Activity navigation restore');
    select('B'); await until(() => input()?.value === 'B draft', 'before browser back');
    history.back(); await until(() => input()?.value === 'last input before pagehide', 'browser back restores A');
    return { activityNavigation: 'passed', browserBack: 'passed', sameBotHistoryRace: 'passed', historyRefreshTyping: 'passed', lateSendAfterSwitch: 'passed', offlineStagedFiles: 2, previewUsesLocalBytes: true };
  },
  async afterReload() {
    await until(() => composer()?.ready && input()?.value === 'last input before pagehide', 'offline draft reload');
    await until(() => composer().files.size === 2, 'offline bytes reload');
    check(histories.length === 0, 'offline restart fetched history');
    await until(() => document.querySelector('.bots-upload-image img')?.src.startsWith('blob:'), 'recovered preview');
    const content = await Promise.all([...composer().files.values()].map((f) => f.text()));
    check(content.includes('offline-image-bytes') && content.includes('offline-document-bytes'), 'file bytes changed');
    await until(() => document.querySelector('.bots-messages')?.textContent.includes('refreshed A history'), 'offline cached history');
    check(document.querySelector('.bots-messages').textContent.includes('cached-last-delta'), 'last stream delta was not cached');
    document.querySelector('button[aria-label="Remove offline.txt"]').click(); await until(() => composer().draft.files.length === 1 && composer().saved, 'offline remove');
    return { offlineReloadText: 'passed', offlineReloadBytes: 'passed', offlineHistory: 'passed', offlineRemoval: 'passed' };
  },
};
