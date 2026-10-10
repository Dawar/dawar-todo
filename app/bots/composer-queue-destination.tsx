"use client";
import { useLayoutEffect, useRef, useState } from "react";
import type { BotQueueList, BotQueuedSubmission } from "../../lib/bots-types";
import type { BotComposer } from "./composer-controller";
import { botsClient as client } from "./client";
import { QueueDestinationPicker } from "./queue-lists";
import { queueActivityKey, readQueueActivity, useQueueActivity } from "./queue-destination-activity";

/** Only a captured explicit Queue intent can open or continue this flow. */
export function useComposerQueueDestination({owner, botId, threadId, composer, online, supported, canSend, burst, refresh}: {
  owner: string; botId: string | null; threadId?: string | null; composer?: BotComposer | null;
  online: boolean; supported: boolean; canSend: boolean; burst: boolean; refresh: () => Promise<void>;
}) {
  const inFlight = useRef(false), mounted = useRef(true), intent = useRef(0);
  const context = useRef({owner, botId, threadId, composer});
  useLayoutEffect(() => {
    if (context.current.owner !== owner || context.current.botId !== botId || context.current.threadId !== threadId || context.current.composer !== composer) intent.current++;
    context.current = {owner, botId, threadId, composer};
  }, [owner, botId, threadId, composer]);
  type Capture = {owner: string; botId: string; threadId?: string | null; composer: BotComposer; signature: string; lists: BotQueueList[]; opener: HTMLElement | null; intent: number; activityKey: string};
  const [choice, setChoice] = useState<Capture | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState("");
  const activityKey = useQueueActivity({owner, botId: botId ?? "", threadId});
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const current = (capture: Capture) => mounted.current && capture.intent === intent.current && client.owner === capture.owner && client.online &&
    context.current.owner === capture.owner && context.current.botId === capture.botId && context.current.threadId === capture.threadId &&
    context.current.composer === capture.composer && capture.composer.destinationSignature === capture.signature &&
    client.snapshot?.bots.find(bot => bot.id === capture.botId)?.threadId === capture.threadId;
  const refreshCurrent = async (capture: Capture) => {
    if (mounted.current && client.owner === capture.owner && context.current.botId === capture.botId && context.current.threadId === capture.threadId) await refresh();
  };
  const submit = async (capture: Capture, queue: boolean, listId: string | null, idleKey?: string) => {
    if (!current(capture)) throw Error("The draft or conversation changed. Your message is retained; choose again.");
    // Explicit Submit now bypasses the quiet-window burst, using ordinary Send.
    await capture.composer.send(queue, queue ? burst : false, listId, capture.signature, () => current(capture) && (!idleKey || queueActivityKey(capture) === idleKey));
    await refreshCurrent(capture);
  };
  async function queue() {
    if (inFlight.current || choice?.owner === owner && choice.botId === botId && choice.threadId === threadId || !online || !canSend || !composer || !botId || (!composer.draft.text.trim() && !composer.draft.files.length)) return;
    inFlight.current = true; setChoice(null); setLoading(true); setError("");
    const capture: Capture = {owner, botId, threadId, composer, signature: composer.destinationSignature, lists: [], intent: ++intent.current, activityKey: "", opener:document.activeElement instanceof HTMLElement ? document.activeElement : null};
    try {
      // Queue edits retain their original mutation/recovery contract.
      if (!supported || composer.draft.queueId || composer.operation) { await composer.send(true, burst); await refreshCurrent(capture); return; }
      let activity = await readQueueActivity(capture, () => current(capture));
      if (activity.activity === "working") { await submit(capture, true, null); return; }
      if (activity.activity !== "idle") throw Error("This bot's activity needs confirmation. Your draft is retained; try Queue again.");
      const queue = await client.rpc<BotQueuedSubmission[]>("queue.list", botId, {}, undefined, {owner});
      if (!current(capture)) throw Error("The draft or conversation changed. Your message is retained; choose again.");
      if (!Array.isArray(queue) || queue.some(item => !item.id || (item.listId ?? null) !== null)) throw Error("The active queue could not be verified. Nothing was submitted; try Queue again.");
      if (queue.length) { await submit(capture, true, null); return; }
      const lists = await client.rpc<BotQueueList[]>("queueLists.list", botId, {}, undefined, {owner});
      if (!current(capture)) throw Error("The draft or conversation changed. Your message is retained; choose again.");
      if (!Array.isArray(lists) || lists.some(list => list.botId !== botId || !list.id)) throw Error("Queue lists could not be verified. Nothing was submitted; try Queue again.");
      activity = await readQueueActivity(capture, () => current(capture));
      if (activity.activity === "working") { await submit(capture, true, null); return; }
      if (activity.activity !== "idle") throw Error("This bot's activity needs confirmation. Your draft is retained; try Queue again.");
      setChoice({...capture, lists, activityKey: activity.key});
    } catch (reason) { if (mounted.current && capture.intent === intent.current && context.current.owner === owner && context.current.botId === botId && context.current.threadId === threadId) setError(reason instanceof Error ? reason.message : "Queue status is unavailable. Your draft is retained."); }
    finally { inFlight.current = false; if (mounted.current) setLoading(false); }
  }
  async function confirm(capture: Capture, queue: boolean, listId: string | null, reconcile = false) {
    if (inFlight.current) return;
    inFlight.current = true; setLoading(true); setError("");
    try {
      const observed = await readQueueActivity(capture, () => current(capture));
      if (observed.activity === "working") {
        // Continue the original explicit Queue, never passive Send/steer authority.
        setChoice(null); await submit(capture, true, null);
      } else if (observed.activity === "idle") {
        if (reconcile) setChoice({...capture, activityKey: observed.key});
        else { await submit(capture, queue, listId, queue && listId === null ? undefined : observed.key); setChoice(null); }
      } else throw Error("This bot's activity needs confirmation. Your draft is retained; try Queue again.");
    } catch (reason) {
      if (mounted.current && capture.intent === intent.current && context.current.owner === capture.owner && context.current.botId === capture.botId && context.current.threadId === capture.threadId) {
        setChoice(null); setError(reason instanceof Error ? reason.message : "The destination is unavailable. Your draft is retained.");
      }
    } finally { inFlight.current = false; if (mounted.current) setLoading(false); }
  }
  useLayoutEffect(() => {
    if (choice && choice.activityKey !== activityKey && !inFlight.current) void confirm(choice, true, null, true);
    // A bounded reconciliation runs only for an existing explicit Queue intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choice, activityKey]);
  const close = () => { intent.current++; setChoice(null); setError(""); };
  const visible = choice?.owner === owner && choice.botId === botId && choice.threadId === threadId;
  return {queue, busy: loading || Boolean(visible), checking:loading && (!visible || choice?.activityKey !== activityKey), error, dialog: visible && choice && choice.activityKey === activityKey ? <QueueDestinationPicker
    lists={choice.lists} returnFocus={choice.opener} disabled={loading || !online || !canSend || composer?.destinationSignature !== choice.signature}
    description="Queued next starts automatically when this bot is free. A manual list holds your message until that list is transferred."
    error={error || (composer?.destinationSignature !== choice.signature ? "The draft changed. Cancel and choose its destination again." : "")}
    onChoose={id => void confirm(choice, true, id)} onSubmitNow={() => void confirm(choice, false, null)} onClose={close} /> : null};
}
