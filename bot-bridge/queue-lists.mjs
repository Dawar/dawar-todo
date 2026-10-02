import { createHash } from 'node:crypto';
import { normalizeCronExpression, nextCronOccurrence } from '../lib/cron.ts';
import { stagedQueue } from './prompt-queue.mjs';
const now = () => new Date().toISOString();
const mutations = new Set(['queue.move', 'queue.merge', 'queueLists.save', 'queueLists.delete', 'queueLists.flush']);
export const QUEUE_TOOL = { name: 'bots_queue', description: 'Manage this bot’s default queue and named cron queue lists. Named lists hold prompts until their interval transfers them, in order, to the default queue. Stop/pause is respected. Read lists/items before changing them; use expected revisions and reuse the same operationId after uncertain replies. Merge numbers texts and combines unique attachments; native-accepted/unconfirmed sends cannot be moved or merged. Use only existing human authority.', inputSchema: { type: 'object', additionalProperties: false, properties: {
  operation: { type: 'string', enum: ['lists', 'read', 'saveList', 'deleteList', 'flush', 'add', 'move', 'merge'] },
  operationId: { type: 'string' }, id: { type: 'string' }, listId: { type: ['string','null'] }, name: { type: 'string' }, cron: { type: ['string','null'] }, timeZone: { type: 'string' }, enabled: { type: 'boolean' }, expectedRevision: { type: 'integer' }, text: { type: 'string' }, attachments: { type: 'array', items: { type: 'string' } }, items: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, revision: { type: 'integer' } }, required: ['id','revision'] } },
}, required: ['operation'] } };
export function ownedList(runtime, botId, id) {
  if (id === null || id === undefined) return null;
  if (typeof id !== 'string') throw Error('Choose a queue list.');
  const list = runtime.store.get('queueList', id);
  if (!list || list.botId !== botId || list.deletedAt) throw Error('Queue list not found for this bot.');
  return list;
}
export function publicLists(runtime, botId) {
  return runtime.store.list('queueList', botId).filter(l => !l.deletedAt).sort((a,b) => a.createdAt.localeCompare(b.createdAt)).map(l => ({ ...l, count: stagedQueue(runtime.store, botId, l.id).length }));
}
function selected(runtime, botId, params) {
  const values = params.items;
  if (!Array.isArray(values) || !values.length || values.length > 100 || values.some(i=>!i || typeof i.id !== 'string') || new Set(values.map(i=>i.id)).size !== values.length) throw Error('Select between 1 and 100 different queued messages.');
  return values.map(({id,revision}) => {
    const item = runtime.store.get('promptQueue', id);
    if (!item || item.botId !== botId || !['queued','failed'].includes(item.state)) throw Error('Only unsent saved messages can be changed. Refresh the queue.');
    if (!Number.isSafeInteger(revision) || revision !== item.revision) throw Error('A selected message changed. Refresh and select its current revision.');
    if (item.listId) ownedList(runtime, botId, item.listId);
    return item;
  }).sort((a,b) => a.position-b.position || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
function append(runtime, botId, items, listId) {
  let position = Math.max(0, ...stagedQueue(runtime.store, botId, listId).map(i=>i.position));
  for (const item of items) runtime.store.put('promptQueue', { ...item, listId, position: ++position, revision: item.revision+1, updatedAt: now() });
}
export async function prepareQueueListMutation(runtime, method, bot, params, id) {
  if (!mutations.has(method)) return null;
  if (bot.archived || bot.archiving) throw Error('Restore this bot first.');
  if (method === 'queueLists.save') {
    const prior = params.id ? ownedList(runtime, bot.id, params.id) : null;
    if (prior && params.expectedRevision !== prior.revision) throw Error('This list changed. Reopen its current settings.');
    const name = String(params.name ?? prior?.name ?? '').trim();
    if (!name || name.length > 80) throw Error('Give the list a name under 80 characters.');
    if (publicLists(runtime, bot.id).some(l=>l.id!==prior?.id && l.name.toLowerCase()===name.toLowerCase())) throw Error('This bot already has a list with that name.');
    if (!prior && publicLists(runtime, bot.id).length >= 32) throw Error('Use up to 32 queue lists per bot.');
    const cron = normalizeCronExpression(params.cron === undefined ? prior?.cron : params.cron);
    const timeZone = String(params.timeZone ?? prior?.timeZone ?? runtime.defaultTimeZone);
    new Intl.DateTimeFormat('en', { timeZone }).format();
    const enabled = params.enabled === undefined ? prior?.enabled ?? true : params.enabled;
    if (typeof enabled !== 'boolean') throw Error('Choose whether the schedule is enabled.');
    const changed = !prior || cron !== prior.cron || timeZone !== prior.timeZone || enabled !== prior.enabled;
    const nextRunAt = enabled && cron ? changed ? nextCronOccurrence(cron, new Date(), timeZone)?.toISOString() : prior.nextRunAt : null;
    if (cron && enabled && !nextRunAt) throw Error('This cron has no upcoming interval.');
    return () => {
      const list = runtime.store.put('queueList', { ...prior, id: prior?.id ?? id, botId: bot.id, name, cron, timeZone, enabled,
        nextRunAt, revision: (prior?.revision ?? 0)+1, createdAt: prior?.createdAt ?? now(), updatedAt: now() });
      runtime.emitEvent('queue', {}, bot.id); return { list: { ...list, count: stagedQueue(runtime.store,bot.id,list.id).length } };
    };
  }
  if (method.startsWith('queueLists.')) {
    const list = ownedList(runtime, bot.id, params.id);
    if (!list || params.expectedRevision !== list.revision) throw Error('This list changed. Refresh before changing it.');
    if (method === 'queueLists.delete' && stagedQueue(runtime.store, bot.id, list.id).length) throw Error('Move the messages out before removing this list.');
    return () => {
      if (method === 'queueLists.delete') runtime.store.put('queueList', { ...list, enabled: false, nextRunAt: null, deletedAt: now(), revision: list.revision+1 });
      else flushList(runtime, list, id);
      runtime.emitEvent('queue', {}, bot.id); return { applied: true };
    };
  }
  const items = selected(runtime, bot.id, params);
  if (method === 'queue.move') {
    const listId = ownedList(runtime, bot.id, params.listId)?.id ?? null;
    if (items.some(i=>(i.listId ?? null)===listId)) throw Error('Selected messages are already in this queue.');
    return () => { append(runtime, bot.id, items, listId); runtime.emitEvent('queue', {}, bot.id); return { applied: true }; };
  }
  if (items.some(item => runtime.store.get("messageReply", item.clientUserMessageId)?.reply)) throw Error("Messages with replies keep their own quoted source. Move or edit them individually instead of merging.");
  if (items.length < 2) throw Error('Select at least two messages to merge.');
  const listId = items[0].listId ?? null;
  if (items.some(i=>(i.listId ?? null)!==listId)) throw Error('Merge messages within the same queue list.');
  const text = items.map((item,index) => {
    const message = item.input.filter(p=>p.type==='text' && !p.text.startsWith('Attached file: ')).map(p=>p.text).join('\n');
    const files = (item.attachmentIds ?? []).map(id => runtime.store.get('attachment',id)?.name ?? 'Attached file');
    return `${index+1}. ${message || 'Attachments'}${files.length ? `\nAttachments: ${files.join(', ')}` : ''}`;
  }).join('\n\n');
  const attachments = [...new Set(items.flatMap(i=>i.attachmentIds ?? []))];
  let input;
  try { input = await runtime.messageInput(bot, { text, attachments }); }
  catch (error) { throw Error(`Merge was not applied: ${error.message} All selected messages are unchanged.`); }
  return () => {
    const item = runtime.store.put('promptQueue', { id, botId: bot.id, threadId: bot.threadId, listId, clientUserMessageId: id, input,
      attachmentIds: attachments, state: 'queued', revision: 1, position: items[0].position,
      source: { kind: 'merge', operationId: id, members: items.map(i=>({id:i.id,revision:i.revision})) }, createdAt: now() });
    runtime.store.put('queuedAttachments', { id, botId: bot.id, attachmentIds: attachments });
    for (const original of items) runtime.store.put('promptQueue', { ...original, state: 'merged', mergedInto: id, mergedAt: now() });
    runtime.emitEvent('queue', {}, bot.id); return { queuedSubmission: runtime.publicQueued(bot,item) };
  };
}
function flushList(runtime, list, operationId) {
  const items = stagedQueue(runtime.store, list.botId, list.id);
  if (items.some(i=>!['queued','failed'].includes(i.state))) throw Error('Reconcile this list’s unconfirmed delivery before transferring it.');
  append(runtime, list.botId, items, null);
  runtime.store.put('queueList', { ...list, lastFlushedAt: now(), lastFlushedCount: items.length, lastFlushId: operationId, revision: list.revision+1 });
  return items.length;
}
export async function flushDueLists(runtime, date = new Date()) {
  for (const candidate of runtime.store.list('queueList')) {
    if (candidate.deletedAt || !candidate.enabled || !candidate.nextRunAt || candidate.nextRunAt > date.toISOString() || runtime.locks.has(candidate.botId)) continue;
    await runtime.lock(candidate.botId, () => runtime.store.transaction(() => {
      const list = ownedList(runtime,candidate.botId,candidate.id), bot = runtime.store.bot(candidate.botId);
      if (!list || bot.archived || bot.archiving || !list.enabled || !list.nextRunAt || list.nextRunAt > date.toISOString()) return;
      const id = `queue-list-flush:${createHash('sha256').update(`${list.id}:${list.nextRunAt}`).digest('hex')}`;
      // One local transaction advances the occurrence and transfers identities.
      // After a crash, neither duplicates nor a backlog of missed intervals run.
      const count = flushList(runtime,list,id);
      const next = nextCronOccurrence(list.cron,date,list.timeZone)?.toISOString() ?? null;
      runtime.store.put('queueList', { ...runtime.store.get('queueList',list.id), nextRunAt: next, enabled: Boolean(next), lastScheduledAt: list.nextRunAt });
      runtime.store.put('queueListFlush', { id, botId: bot.id, listId: list.id, scheduledAt: list.nextRunAt, transferredCount: count, completedAt: now() });
      runtime.emitEvent('queue', {}, bot.id);
    })).catch(error => runtime.emit('fault', error));
  }
}
export function queueTool(runtime, bot, args) {
  if (args.operation === 'lists') return publicLists(runtime, bot.id);
  const { operation, operationId, ...params } = args;
  if (operation === 'read') return runtime.handle({method:'queue.list',botId:bot.id,params:{listId:params.listId ?? null}});
  const method = {saveList:'queueLists.save',deleteList:'queueLists.delete',flush:'queueLists.flush',add:'queue.add',move:'queue.move',merge:'queue.merge'}[operation];
  if (!method) throw Error('Choose a supported queue operation.');
  return runtime.handle({ method, botId: bot.id, params, operationId });
}
