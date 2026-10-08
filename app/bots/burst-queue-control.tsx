"use client";
import { useEffect, useRef, useState } from 'react';
import { ListPlus } from 'lucide-react';
import type { BotQueueList, BotQueuedSubmission } from '../../lib/bots-types';
import type { BurstQueueParams } from '../../lib/burst-queue';
import type { BurstConversation } from './burst-composer';
import type { BurstState } from './single-thread-contract';
import { botsClient as client } from './client';
import { QueueDestinationPicker } from './queue-lists';
import { captureHeldBurst } from './burst-queue-selection';

export function BurstQueueControl({burst, online, disabled}: {burst:BurstConversation; online:boolean; disabled:boolean}) {
  const {owner,botId,action,queueAction,refreshDelivery,setQueuePreparing} = burst;
  const [error,setError] = useState(''), [working,setWorking] = useState(false), [choice,setChoice] = useState<{source:Omit<BurstQueueParams,'listId'>;lists:BotQueueList[];opener:HTMLElement|null}|null>(null);
  const pending = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; setQueuePreparing(false); }; }, [setQueuePreparing]);
  const current = (threadId:string) => mounted.current && client.owner === owner && client.online &&
    client.snapshot?.bots.find(bot => bot.id === botId)?.threadId === threadId;
  async function place(source:Omit<BurstQueueParams,'listId'>,listId:string|null) {
    if (!current(source.threadId)) throw Error('The account or conversation changed. The original burst remains held.');
    await queueAction.perform('bursts.queue',{...source,listId});
    if (mounted.current) { setChoice(null); refreshDelivery(); }
  }
  async function open() {
    if (pending.current || disabled || !online) return;
    const threadId = client.snapshot?.bots.find(bot => bot.id === botId)?.threadId;
    if (!threadId) { setError('This conversation is unavailable. Nothing was queued.'); return; }
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    pending.current = true; setWorking(true); setQueuePreparing(true); setError('');
    let opened = false;
    try {
      // Await the exact durable pause acknowledgement before any queue reads.
      await action.perform('bursts.stop',{});
      if (!current(threadId)) throw Error('The account or conversation changed. The original messages remain paused.');
      const held = await client.rpc<BurstState>('bursts.read',botId,{},undefined,{owner});
      if (!current(threadId)) throw Error('The account or conversation changed. The original messages remain paused.');
      const source = captureHeldBurst(held,botId,threadId);
      const queue = await client.rpc<BotQueuedSubmission[]>('queue.list',botId,{},undefined,{owner});
      if (!current(threadId)) throw Error('The account or conversation changed. The original messages remain paused.');
      if (!Array.isArray(queue) || queue.some(item => !item.id || (item.listId ?? null) !== null)) throw Error('The active queue could not be verified. Messages stay paused; try Queue again.');
      if (queue.length) { await place(source,null); return; }
      const lists = await client.rpc<BotQueueList[]>('queueLists.list',botId,{},undefined,{owner});
      if (!current(threadId)) throw Error('The account or conversation changed. The original messages remain paused.');
      if (!Array.isArray(lists) || lists.some(list => list.botId !== botId || !list.id)) throw Error('Queue lists could not be verified. Messages stay paused; try Queue again.');
      setChoice({source,lists,opener}); opened = true;
    } catch (reason) { if (mounted.current && client.owner === owner) setError(reason instanceof Error?reason.message:'Queue placement is unconfirmed. Original messages and action IDs are retained.'); }
    finally { pending.current = false; if (mounted.current) { refreshDelivery(); setWorking(false); if (!opened) setQueuePreparing(false); } }
  }
  async function choose(listId:string|null) {
    if (!choice || pending.current) return;
    pending.current = true; setWorking(true); setQueuePreparing(true); setError('');
    let placed = false;
    try { await place(choice.source,listId); placed = true; }
    catch(reason) { if (mounted.current) {
      setError(reason instanceof Error?reason.message:'Queue placement is unconfirmed. Check the original saved action.');
      if ((reason as {outcome?:string}).outcome === 'rejected') {setChoice(null);setQueuePreparing(false);}
    } }
    finally { pending.current = false; if (mounted.current) { setWorking(false); if (placed) setQueuePreparing(false); } }
  }
  const queueAvailable = client.snapshot?.capabilities?.burstQueue === 1;
  if (!queueAvailable) return queueAction.intent || queueAction.error ? <div className="bots-burst-recovery" role="status">Connect to the updated service to confirm the saved queue placement. Its original transfer ID is retained.</div> : null;
  return <>
    <button type="button" aria-label="Queue waiting burst messages" disabled={disabled || working || !!choice || !queueAction.ready || !!queueAction.intent}
      onClick={() => void open()}><ListPlus size={16}/>Queue</button>
    {choice && <QueueDestinationPicker lists={choice.lists} showDefault={false} returnFocus={choice.opener} disabled={disabled || working || !!queueAction.intent || !online}
      description="Messages are paused on the server. A manual list holds them until it is transferred; Cancel leaves the burst paused."
      error={error || queueAction.error} onChoose={id => void choose(id)} onClose={() => {setChoice(null);setQueuePreparing(false);setError('');}} />}
    {(error || queueAction.error) && !choice && <div className="bots-burst-recovery" role="alert">{queueAction.error || error}
      {queueAction.intent && <button disabled={!online || queueAction.busy} onClick={() => void queueAction.retry().then(refreshDelivery).catch(()=>{})}>Check queue placement</button>}</div>}
    {queueAction.intent && !queueAction.error && !error && <div className="bots-burst-recovery" role="status">Queue placement needs confirmation. The original transfer is saved.
      <button disabled={!online || queueAction.busy} onClick={() => void queueAction.retry().then(refreshDelivery).catch(()=>{})}>Check queue placement</button></div>}
  </>;
}
