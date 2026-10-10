"use client";
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ListPlus } from 'lucide-react';
import type { BotQueueList, BotQueuedSubmission } from '../../lib/bots-types';
import type { BurstQueueParams } from '../../lib/burst-queue';
import type { BurstConversation } from './burst-composer';
import type { BurstState } from './single-thread-contract';
import { botsClient as client } from './client';
import { QueueDestinationPicker } from './queue-lists';
import { captureHeldBurst } from './burst-queue-selection';
import { queueActivityKey, readQueueActivity, useQueueActivity } from './queue-destination-activity';

export function BurstQueueControl({burst, online, disabled}: {burst:BurstConversation; online:boolean; disabled:boolean}) {
  const {owner,botId,action,queueAction,refreshDelivery,setQueuePreparing} = burst;
  const [error,setError] = useState(''), [working,setWorking] = useState(false), [choice,setChoice] = useState<{source:Omit<BurstQueueParams,'listId'>;lists:BotQueueList[];opener:HTMLElement|null;activityKey:string;intent:number}|null>(null);
  const pending = useRef(false), mounted = useRef(true), intent = useRef(0);
  const threadId = client.snapshot?.bots.find(bot => bot.id === botId)?.threadId;
  const scope = useRef({owner,botId,threadId});
  useLayoutEffect(() => {
    if (scope.current.owner !== owner || scope.current.botId !== botId || scope.current.threadId !== threadId) intent.current++;
    scope.current = {owner,botId,threadId};
  }, [owner,botId,threadId]);
  const activityKey = useQueueActivity({owner, botId, threadId});
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; setQueuePreparing(false); }; }, [setQueuePreparing]);
  const current = (threadId:string) => mounted.current && client.owner === owner && client.online &&
    client.snapshot?.bots.find(bot => bot.id === botId)?.threadId === threadId;
  async function place(source:Omit<BurstQueueParams,'listId'>,listId:string|null, originalIntent = intent.current, idleKey?:string) {
    if (!current(source.threadId)) throw Error('The account or conversation changed. The original burst remains held.');
    await queueAction.performBurstQueue({...source,listId}, () => current(source.threadId) && originalIntent === intent.current &&
      (!idleKey || queueActivityKey({owner,botId,threadId:source.threadId}) === idleKey));
    if (mounted.current) { setChoice(null); refreshDelivery(); }
  }
  async function open() {
    if (pending.current || disabled || !online) return;
    const threadId = client.snapshot?.bots.find(bot => bot.id === botId)?.threadId;
    if (!threadId) { setError('This conversation is unavailable. Nothing was queued.'); return; }
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const originalIntent = ++intent.current;
    const valid = () => originalIntent === intent.current && current(threadId);
    pending.current = true; setWorking(true); setQueuePreparing(true); setError('');
    let opened = false;
    try {
      // Await the exact durable pause acknowledgement before any queue reads.
      await action.perform('bursts.stop',{});
      if (!valid()) throw Error('The account or conversation changed. The original messages remain paused.');
      const held = await client.rpc<BurstState>('bursts.read',botId,{},undefined,{owner});
      if (!valid()) throw Error('The account or conversation changed. The original messages remain paused.');
      const source = captureHeldBurst(held,botId,threadId);
      let observed = await readQueueActivity({owner,botId,threadId}, valid);
      if (observed.activity === 'working') { await place(source,null); return; }
      if (observed.activity !== 'idle') throw Error("This bot's activity needs confirmation. Messages stay paused; try Queue again.");
      const queue = await client.rpc<BotQueuedSubmission[]>('queue.list',botId,{},undefined,{owner});
      if (!valid()) throw Error('The account or conversation changed. The original messages remain paused.');
      if (!Array.isArray(queue) || queue.some(item => !item.id || (item.listId ?? null) !== null)) throw Error('The active queue could not be verified. Messages stay paused; try Queue again.');
      if (queue.length) { await place(source,null); return; }
      const lists = await client.rpc<BotQueueList[]>('queueLists.list',botId,{},undefined,{owner});
      if (!valid()) throw Error('The account or conversation changed. The original messages remain paused.');
      if (!Array.isArray(lists) || lists.some(list => list.botId !== botId || !list.id)) throw Error('Queue lists could not be verified. Messages stay paused; try Queue again.');
      observed = await readQueueActivity({owner,botId,threadId}, valid);
      if (observed.activity === 'working') { await place(source,null); return; }
      if (observed.activity !== 'idle') throw Error("This bot's activity needs confirmation. Messages stay paused; try Queue again.");
      setChoice({source,lists,opener,activityKey:observed.key,intent:originalIntent}); opened = true;
    } catch (reason) { if (mounted.current && client.owner === owner) setError(reason instanceof Error?reason.message:'Queue placement is unconfirmed. Original messages and action IDs are retained.'); }
    finally { pending.current = false; if (mounted.current) { refreshDelivery(); setWorking(false); if (!opened) setQueuePreparing(false); } }
  }
  async function choose(capture: NonNullable<typeof choice>, listId:string|null, reconcile = false) {
    if (pending.current) return;
    pending.current = true; setWorking(true); setQueuePreparing(true); setError('');
    let retained = false;
    try {
      const observed = await readQueueActivity({owner,botId,threadId:capture.source.threadId},
        () => capture.intent === intent.current && current(capture.source.threadId));
      if (observed.activity === 'working') { setChoice(null); await place(capture.source,null,capture.intent); }
      else if (observed.activity === 'idle') {
        if (reconcile) { setChoice({...capture,activityKey:observed.key}); retained = true; }
        else await place(capture.source,listId,capture.intent,listId === null ? undefined : observed.key);
      } else throw Error("This bot's activity needs confirmation. Messages stay paused; try Queue again.");
    } catch(reason) { if (mounted.current && capture.intent === intent.current) {
      setChoice(null); setError(reason instanceof Error?reason.message:'Queue placement is unconfirmed. Check the original saved action.');
    } }
    finally { pending.current = false; if (mounted.current) { setWorking(false); if (!retained) setQueuePreparing(false); } }
  }
  useLayoutEffect(() => {
    if (choice && choice.activityKey !== activityKey && !pending.current) void choose(choice,null,true);
    // Reconcile only the captured explicit burst Queue; no countdown/poll trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choice,activityKey]);
  const queueAvailable = client.snapshot?.capabilities?.burstQueue === 1;
  if (!queueAvailable) return queueAction.intent || queueAction.error ? <div className="bots-burst-recovery" role="status">Connect to the updated service to confirm the saved queue placement. Its original transfer ID is retained.</div> : null;
  return <>
    <button type="button" aria-label="Queue waiting burst messages" disabled={disabled || working || !!choice || !queueAction.ready || !!queueAction.intent}
      onClick={() => void open()}><ListPlus size={16}/>Queue</button>
    {choice && choice.activityKey === activityKey && <QueueDestinationPicker lists={choice.lists} returnFocus={choice.opener} disabled={disabled || working || !!queueAction.intent || !online}
      description="Messages are paused on the server. Queued next starts when this bot is free; a manual list holds them until it is transferred. Cancel leaves the burst paused."
      error={error || queueAction.error} onChoose={id => void choose(choice,id)} onClose={() => {intent.current++;setChoice(null);setQueuePreparing(false);setError('');}} />}
    {(error || queueAction.error) && !choice && <div className="bots-burst-recovery" role="alert">{queueAction.error || error}
      {queueAction.intent && <button disabled={!online || queueAction.busy} onClick={() => void queueAction.retry().then(refreshDelivery).catch(()=>{})}>Check queue placement</button>}</div>}
    {queueAction.intent && !queueAction.error && !error && <div className="bots-burst-recovery" role="status">Queue placement needs confirmation. The original transfer is saved.
      <button disabled={!online || queueAction.busy} onClick={() => void queueAction.retry().then(refreshDelivery).catch(()=>{})}>Check queue placement</button></div>}
  </>;
}
