"use client";
import { useLayoutEffect, useRef, useState } from "react";
import type { BotQueueList, BotQueuedSubmission } from "../../lib/bots-types";
import type { BotAdmissionWork } from "../../lib/bot-work-view";
import type { BotComposer } from "./composer-controller";
import { botsClient as client } from "./client";
import { QueueDestinationPicker } from "./queue-lists";
import { queueDestinationWork } from "./queue-destination-work";

/** Fresh reads are observational. Only an explicit destination commits a send. */
export function useComposerQueueDestination({owner, botId, threadId, composer, online, supported, canSend, burst, refresh}: {
  owner: string; botId: string | null; threadId?: string | null; composer?: BotComposer | null;
  online: boolean; supported: boolean; canSend: boolean; burst: boolean; refresh: () => Promise<void>;
}) {
  const context = useRef({owner, botId, threadId, composer});
  useLayoutEffect(() => { context.current = {owner, botId, threadId, composer}; }, [owner, botId, threadId, composer]);
  type Capture = {owner: string; botId: string; threadId?: string | null; composer: BotComposer; signature: string; lists: BotQueueList[]; opener: HTMLElement | null};
  const [choice, setChoice] = useState<Capture | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState("");
  const inFlight = useRef(false), mounted = useRef(true);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const current = (capture: Capture) => mounted.current && client.owner === capture.owner && client.online &&
    context.current.owner === capture.owner && context.current.botId === capture.botId && context.current.threadId === capture.threadId &&
    context.current.composer === capture.composer && capture.composer.destinationSignature === capture.signature &&
    client.snapshot?.bots.find(bot => bot.id === capture.botId)?.threadId === capture.threadId;
  const refreshCurrent = async (capture: Capture) => {
    if (mounted.current && client.owner === capture.owner && context.current.botId === capture.botId && context.current.threadId === capture.threadId) await refresh();
  };
  const submit = async (capture: Capture, queue: boolean, listId: string | null) => {
    if (!current(capture)) throw Error("The draft or conversation changed. Your message is retained; choose again.");
    // Explicit Submit now bypasses the quiet-window burst, using ordinary Send.
    await capture.composer.send(queue, queue ? burst : false, listId, capture.signature, () => current(capture));
    await refreshCurrent(capture);
  };
  async function queue() {
    if (inFlight.current || choice?.owner === owner && choice.botId === botId && choice.threadId === threadId || !online || !canSend || !composer || !botId || (!composer.draft.text.trim() && !composer.draft.files.length)) return;
    inFlight.current = true; setChoice(null); setLoading(true); setError("");
    const capture: Capture = {owner, botId, threadId, composer, signature: composer.destinationSignature, lists: [], opener:document.activeElement instanceof HTMLElement ? document.activeElement : null};
    try {
      // Queue edits retain their original mutation/recovery contract.
      if (!supported || composer.draft.queueId || composer.operation) { await composer.send(true, burst); await refreshCurrent(capture); return; }
      const queue = await client.rpc<BotQueuedSubmission[]>("queue.list", botId, {}, undefined, {owner});
      if (!current(capture)) throw Error("The draft or conversation changed. Your message is retained; choose again.");
      if (!Array.isArray(queue) || queue.some(item => !item.id || (item.listId ?? null) !== null)) throw Error("The active queue could not be verified. Nothing was submitted; try Queue again.");
      if (queue.length) { await submit(capture, true, null); return; }
      const work = await client.rpc<BotAdmissionWork>("work.read", botId, {}, undefined, {owner});
      if (!current(capture)) throw Error("The draft or conversation changed. Your message is retained; choose again.");
      const activity = queueDestinationWork(work, client.snapshot?.bots.find(bot => bot.id === botId));
      if (activity === "working") { await submit(capture, true, null); return; }
      if (activity !== "idle") throw Error("This bot's activity needs confirmation. Your draft is retained; try Queue again.");
      const lists = await client.rpc<BotQueueList[]>("queueLists.list", botId, {}, undefined, {owner});
      if (!current(capture)) throw Error("The draft or conversation changed. Your message is retained; choose again.");
      if (!Array.isArray(lists) || lists.some(list => list.botId !== botId || !list.id)) throw Error("Queue lists could not be verified. Nothing was submitted; try Queue again.");
      setChoice({...capture, lists});
    } catch (reason) { if (mounted.current && context.current.owner === owner && context.current.botId === botId) setError(reason instanceof Error ? reason.message : "Queue status is unavailable. Your draft is retained."); }
    finally { inFlight.current = false; if (mounted.current) setLoading(false); }
  }
  async function choose(queue: boolean, listId: string | null) {
    if (!choice || inFlight.current) return;
    inFlight.current = true; setLoading(true); setError("");
    try { await submit(choice, queue, listId); setChoice(null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The destination is unavailable. Your draft is retained."); }
    finally { inFlight.current = false; if (mounted.current) setLoading(false); }
  }
  const visible = choice?.owner === owner && choice.botId === botId && choice.threadId === threadId;
  return {queue, busy: loading || Boolean(visible), checking:loading && !visible, error, dialog: visible && choice ? <QueueDestinationPicker
    lists={choice.lists} returnFocus={choice.opener} disabled={loading || !online || !canSend || composer?.destinationSignature !== choice.signature}
    description="Queued next starts automatically when this bot is free. A manual list holds your message until that list is transferred."
    error={error || (composer?.destinationSignature !== choice.signature ? "The draft changed. Cancel and choose its destination again." : "")}
    onChoose={id => void choose(true, id)} onSubmitNow={() => void choose(false, null)} onClose={() => { setChoice(null); setError(""); }} /> : null};
}
