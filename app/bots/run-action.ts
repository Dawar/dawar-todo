import { useMemo, useSyncExternalStore } from "react";
import type { BotOperations } from "../../lib/bots-operations";
import { botsClient as client } from "./client";
import { runActionJournal, type RunActionMethod as Method, type RunActionIntent as Intent, type ActionSelection } from "./run-action-journal";
import { goalControlBlock, goalFingerprint, goalScope, validGoal } from "./native-goal-state";
import { validBurstQueueReceipt, type BurstQueueParams } from "../../lib/burst-queue";

const actions = new Map<string, RunAction>();
let channel: BroadcastChannel | undefined, listening = false;
function listen() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  const refresh = (key?: string) => { for (const [scope, action] of actions) if ((!key || key === scope || key === action.storageKey) && action.owner === client.owner && action.mounted) void action.refresh(); };
  if (typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel("dawar-run-actions-v2");
    channel.onmessage = event => { if (typeof event.data === "string") refresh(event.data); };
  }
  window.addEventListener("storage", event => {
    if (event.key === "dawar-run-action-change:v2") refresh();
    else if (event.key?.startsWith("dawar-run-action:v1:")) refresh(event.key);
  });
  window.addEventListener("focus", () => refresh()); window.addEventListener("pageshow", () => refresh());
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  let owner = client.owner;
  client.subscribe(() => { if (owner !== client.owner) { owner = client.owner; refresh(); } });
}
function changed(key: string) {
  try { channel?.postMessage(key); } catch { /* storage/focus also reconciles */ }
  // Notification only; identity/settlement never depend on this fallible write.
  try { localStorage.setItem("dawar-run-action-change:v2", crypto.randomUUID()); } catch { /* focus/resume also reconciles */ }
}
/** Origin-owned, exact-ID recovery. No automatic uncertain write retry. */
class RunAction {
  intent: Intent | null = null;
  busy = false;
  ready = false;
  accepted = false;
  confirmation: Intent | null = null;
  error = "";
  private journalRevision = -1;
  private revision = 0;
  private listeners = new Set<() => void>();
  get storageKey(){return this.key;}
  get mounted() { return this.listeners.size > 0; }
  snapshot = () => this.revision;
  subscribe = (fn: () => void) => { this.listeners.add(fn); listen(); void this.refresh(); return () => { this.listeners.delete(fn); }; };
  constructor(readonly owner: string, readonly botId: string, private key: string, private scope: string) {}
  private apply(value: ActionSelection) {
    if (value.revision < this.journalRevision) return;
    this.journalRevision = value.revision; this.ready = true;
    this.intent = value.current;
    this.accepted = !value.current && value.last?.state === "accepted";
    this.confirmation = value.last?.state === "accepted" ? value.last : null;
    this.error = value.current?.error ?? (value.last?.state === "rejected" && !value.current ? value.last.error ?? "The action was rejected." : "");
    this.notify();
  }
  async refresh() {
    try { this.apply(await runActionJournal(this.key, { kind: "read" })); }
    catch (error) { this.error = error instanceof Error ? error.message : "Action recovery is unavailable. Retry when browser storage is available."; this.notify(); }
  }
  private notify() { this.revision++; for (const fn of this.listeners) fn(); }
  private async execute(command: { method: Method; params: Record<string, unknown>; capture?: {draftVersion:string} } | { id: string }) {
    if (this.busy || client.owner !== this.owner || !client.online) throw Error("Connect as this action's owner before continuing.");
    this.busy = true; this.notify();
    let intent: Intent | undefined;
    const isGoal = 'method' in command && command.method.startsWith('goals.');
    const beforeBot = isGoal ? client.snapshot?.bots.find(bot => bot.id === this.botId) : undefined;
    const beforeGoal = beforeBot ? goalFingerprint(beforeBot, client.snapshot?.workByBot?.find(work => work.botId === this.botId)) : null;
    try {
      const selected = await runActionJournal(this.key, "id" in command ? { kind: "exact", id: command.id } : { kind: "admit", intent: { id: crypto.randomUUID(), ...command, ...(command.method.startsWith('conversations.')?{targetBotId:this.botId}:{}) } });
      this.apply(selected); changed(this.key);
      const operation = selected.selected;
      if (!operation) throw Error("No saved action was selected. Retry recovery.");
      if (operation.state === "accepted") return (operation as Intent & {result?:unknown}).result;
      if (operation.state === "rejected") throw Error(operation.error || "This exact action was rejected. Review the current state before making a new action.");
      intent = operation;
      if (intent.method === "peers.control" && this.scope !== `peer-root:${intent.params.rootId}`) throw Error("The saved control belongs to a different discussion. Its original identity is retained; no control was sent.");
      if (intent.method === "runs.decide" && client.snapshot?.capabilities?.scheduleDecisions !== 1) throw Error("Connect to a service that supports scheduled-run choices. The saved choice is retained.");
      if (intent.method === "bursts.discard" && client.snapshot?.capabilities?.burstDiscard !== 1) throw Error("Connect to the updated service to discard these messages. The saved action is retained.");
      if (intent.method === "bursts.queue" && client.snapshot?.capabilities?.burstQueue !== 1) throw Error("Connect to the updated service to queue held messages. The saved action is retained.");
      if ((intent.method === "bursts.resume" || intent.method === "bursts.discard" && intent.params.pendingOnly) && client.snapshot?.capabilities?.burstControls !== 1) throw Error("Connect to the updated service for held-message controls. This saved action is retained.");
      const roomAction = intent.method.startsWith("conversations.") || intent.method === "collaboration.promote" || intent.method === "requests.respond" && this.scope.startsWith("room-question:");
      if (roomAction && intent.method !== "conversations.create" && intent.method !== "collaboration.promote" && intent.method !== "requests.respond" && !this.scope.startsWith(`room:${intent.params.roomId}:`)) throw Error("This saved room action belongs to its captured room. Nothing was sent.");
      const capability = roomAction ? 'collaborationRooms' : intent.method.startsWith('goals.') ? 'nativeGoals' : intent.method === "peers.control" ? "peerRootControls" : intent.method.startsWith("bursts.") ? "messageBursts" : (intent.method === "work.resume" || intent.method === "turn.interrupt" && intent.params.scope === "main" && client.snapshot?.capabilities?.singleThreadExecution === 1) ? "singleThreadExecution" : intent.method === "peers.cancel" ? "peerInbox" : "backgroundRunLanes";
      if (client.snapshot?.capabilities?.[capability] !== 1) throw Error("This service does not support the saved action. Its identity is retained.");
      if (intent.method.startsWith('goals.')) {
        for (const scope of ['stop:main', 'stop:all', 'work:resume']) {
          const key = `dawar-run-action:v1:${JSON.stringify([this.owner, this.botId, scope])}`;
          if ((await runActionJournal(key, { kind: 'read' })).current) throw Error('Confirm the saved Stop or automatic-intake Resume before changing the goal.');
        }
        const bot = client.snapshot?.bots.find(bot => bot.id === this.botId);
        if (client.owner !== this.owner || !bot?.threadId || this.scope !== goalScope(bot.threadId)) throw Error('This saved goal action belongs to its original conversation. Nothing was sent to a replacement thread.');
        const block = goalControlBlock(client.snapshot, bot, client.online);
        if (block) throw Error(block);
        if (isGoal && goalFingerprint(bot, client.snapshot?.workByBot?.find(work => work.botId === bot.id)) !== beforeGoal) throw Error('The native goal changed while saving this action. Its identity is retained for review.');
      }
      const result = await client.rpc(intent.method, intent.targetBotId??this.botId, intent.params, intent.id, { owner: this.owner, managed: true });
      if (!result || typeof result !== "object" || Array.isArray(result)) throw Error("The response did not confirm this action. Check the same saved action again.");
      if (intent.method.startsWith('goals.')) {
        const thread = this.scope.slice('native-goal:'.length);
        if (intent.method === 'goals.set' && !validGoal((result as { goal?: unknown }).goal, thread) || intent.method === 'goals.clear' && typeof (result as { cleared?: unknown }).cleared !== 'boolean') throw Error('Native goal acknowledgement is incomplete. Check the same saved action again.');
        // Settle the original receipt even if the selected owner/thread moved.
        // Display remains exclusively on sequence-fenced cached work events.
      }
      if (intent.method === "runs.decide") {
        const receipt = result as { operationId?: string; run?: { id?: string; botId?: string } };
        if (receipt.operationId !== intent.id || receipt.run?.id !== intent.params.runId || receipt.run?.botId !== this.botId) throw Error("The response did not confirm this exact choice. Check the saved choice again.");
      }
      if (intent.method === "bursts.discard") {
        const receipt = result as { discardedIds?: string[]; hiddenIds?: string[] };
        const ids = intent.params.pendingOnly ? receipt.discardedIds ?? [] : [...(receipt.discardedIds ?? []), ...(receipt.hiddenIds ?? [])];
        const requested = intent.params.messageIds as string[];
        if (ids.length !== requested.length || requested.some(id => !ids.includes(id))) throw Error("The reply did not confirm the exact messages. Check the saved discard action again.");
      }
      if (intent.method === "bursts.queue" && !validBurstQueueReceipt((result as {transfer?:unknown}).transfer, intent.id, this.botId, intent.params as BurstQueueParams))
        throw Error("Queue placement was not confirmed for these exact messages. Check the same saved action again.");
      if (["bursts.stop", "bursts.start", "bursts.resume"].includes(intent.method) && client.snapshot?.capabilities?.burstControls === 1) {
        const receipt = (result as { control?: { operationId?: string; method?: string; botId?: string } }).control;
        if (receipt?.operationId !== intent.id || receipt.method !== intent.method || receipt.botId !== this.botId) throw Error("This burst control was not confirmed. Check the same saved action again.");
      }
      if (intent.method === "peers.cancel" && (result as { request?: { id?: string } }).request?.id !== intent.params.id) throw Error("The reply did not confirm this discussion. Retry its saved action.");
      if (intent.method === "peers.control") {
        const { control, root } = result as import("../../lib/bots-types").BotPeerControl;
        if (control?.operationId !== intent.id || control.botId !== this.botId || control.rootId !== intent.params.rootId || control.action !== intent.params.action || control.expectedRevision !== intent.params.expectedRevision || control.appliedRevision !== Number(intent.params.expectedRevision) + 1 || control.scope !== "discussion-admission" || control.nativeInterruption !== false || root?.id !== control.rootId || root.revision !== control.appliedRevision || root.version !== 1) throw Error("This discussion control was not confirmed. Check the same saved action again.");
      }
      if (roomAction) validateRoomReceipt(intent, result);
      this.apply(await runActionJournal(this.key, { kind: "settle", id: intent.id, state: "accepted", ...(roomAction ? {result} : {}) })); changed(this.key);
      return result;
    } catch (reason) {
      const error = reason instanceof Error ? reason.message : "This action is unconfirmed. Check the same saved action again.";
      if (intent) {
        try { this.apply(await runActionJournal(this.key, { kind: "settle", id: intent.id, state: (reason as { outcome?: string }).outcome === "rejected" ? "rejected" : "pending", error })); changed(this.key); }
        catch { this.error = `${error} The action journal needs recovery; its saved identity is retained.`; }
      } else this.error = error;
      throw reason;
    } finally { this.busy = false; this.notify(); }
  }
  perform = async (method: Method, params: BotOperations[Method]["params"]) => { await this.execute({ method, params }); };
  performResult = (method: Method, params: BotOperations[Method]["params"], capture?: {draftVersion:string}) => this.execute({ method, params, ...(capture ? {capture} : {}) });
  retry = () => this.intent ? this.execute({ id: this.intent.id }) : this.refresh();
}

function validateRoomReceipt(intent: Intent, result: unknown) {
  const r = result as Record<string, unknown>, p = intent.params;
  const sameIds = (a: unknown, b: unknown) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && new Set(a).size === a.length && a.every(id => b.includes(id));
  if (intent.method === 'conversations.post') {
    const ack = r as unknown as BotOperations['conversations.post']['result'];
    if (ack.post?.author?.kind !== 'owner' || ack.post.operationId !== intent.id || ack.post.roomId !== p.roomId || ack.post.text !== p.text || ack.post.kind !== p.kind || ack.post.expectation !== (p.expectation??'none') || ack.post.workId !== (p.workId??null) || ack.post.requestId !== (p.requestId??null) || ack.post.rootId !== (p.rootId??null) || !sameIds(ack.post.recipients, p.recipients ?? []) || !Array.isArray(ack.deliveries) || ack.deliveries.length !== ack.post.recipients.length || new Set(ack.deliveries.map(d=>d.botId)).size !== ack.deliveries.length || ack.deliveries.some(d=>!d.id || d.postId!==ack.post.id || d.roomId!==p.roomId || !ack.post.recipients.includes(d.botId))) throw Error('The original post/delivery acknowledgement is incomplete. Reconcile the same saved action.');
  } else if (intent.method === 'conversations.create' || intent.method === 'conversations.membership' || intent.method === 'conversations.hold') {
    if (typeof r.id !== 'string' || !Number.isSafeInteger(r.revision) || intent.method !== 'conversations.create' && r.id !== p.roomId || intent.method !== 'conversations.hold' && !sameIds(r.members, p.members) || intent.method === 'conversations.create' && r.type !== p.type || intent.method === 'conversations.hold' && r.held !== p.held || intent.method !== 'conversations.create' && r.revision !== Number(p.expectedRevision)+1) throw Error('The exact room change was not confirmed. Reconcile its original action.');
  } else if (intent.method === 'collaboration.promote') {
    const value = r as unknown as BotOperations['collaboration.promote']['result'];
    // Already promoted returns the original promotion receipt, never another intake.
    if (value.id !== p.resultId || value.workId !== p.relatedWorkId || !value.promotion?.id || !value.promotion.operationId) throw Error('Result promotion is unconfirmed. Reconcile its original action.');
  }
}

export function useRunAction(owner: string, botId: string, scope: string) {
  const action = useMemo(() => {
    // Room owner mutations share one journal across navigator member changes.
    // Each immutable operation retains its original API anchor bot.
    const shared=scope.startsWith('room:')||scope==='rooms:create';
    const key = `dawar-run-action:v1:${JSON.stringify([owner, shared?'room-owner':botId, scope])}`;
    const cacheKey=shared?JSON.stringify([key,botId]):key;
    let value = actions.get(cacheKey);
    if (!value) { value = new RunAction(owner, botId, key, scope); actions.set(cacheKey, value); }
    return value;
  }, [owner, botId, scope]);
  useSyncExternalStore(action.subscribe, action.snapshot, action.snapshot);
  return action;
}
