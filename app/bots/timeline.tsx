"use client";
import { Button } from "@/components/ui/button";
import { Fragment, memo, useCallback, useEffect, useRef, useState, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { ReplyAction, ReplyQuote } from "./message-reply";
import type { BotReplyReference } from "../../lib/bot-replies";
import type { Bot, BotAttachment } from "../../lib/bots-types";
import { historyKey, type HistoryEntry } from "../../lib/bot-history-view";
import type { BotTimeline } from "./timeline-controller";
/** Main and owned-run readers share rendering only, never state or persistence. */
export type HistoryDetailReader = Pick<BotTimeline, "botId" | "subscribeDetail" | "detailItem" | "subscribe" | "detailPending" | "detail"> & { detailError?: (entry: HistoryEntry) => string };
import { useBotTimeline } from "./use-timeline";
import { botsClient } from "./client";
import { markLocallyRead } from "./local-read-state";
import { reconcileHistory } from "./history-reconcile";
import { nativeWorkItem, nativeWorkLabel } from "./native-timeline";
import { elapsed } from "../../lib/bot-timing";
import { NativeTimingContext } from "./active-turn-elapsed";
import "./native-timeline.css";
import { MessageTime, ElapsedTime } from "./message-time";
import { BotMessage, WorkPlanMessage } from "./message";
import { readWorkPlanSource } from '../../lib/native-work-plan';
import { OperatorSegmentBody } from "./operator-call";
import { ArrowDown, MessageCircle, CloudOff, Clock3, Phone } from "lucide-react";
import { LazyDetails } from "./lazy-details";
import { useFeedScroll } from "./use-feed-scroll";
import { humanMessageTicks, type HumanMessageTick } from "./human-message-ticks";
import { MessageTickRail } from "./message-tick-rail";
import {fileCitationReferences} from "../../lib/file-citation.mjs";
import { ReturnedArtifacts } from "./returned-artifact";
import type { ActivityTarget } from "./activity-target";
import { useBurstConversation, BurstControls, BurstBubbles, canonicalBurst } from "./burst-composer";
import { useRunFindings } from "./run-findings";
import { retainedBatches } from "./burst-state";
import { SecureInputCard, SecureInputAccess } from "./secure-input-card";
import { useSecureInputRequests } from "./secure-input-requests";
import { secureTimelineGroups, type ConversationGroup } from "./secure-input-timeline";
import { TaskRequestAccess, TaskRequestCard, useTaskRequests } from "./task-request-ui";
import { taskRequestGroups } from "./task-request-timeline";
const noDetailErrors = () => () => {};

const EntryBody = memo(function EntryBody({ entry, timeline, attachments, download }: {
  entry: HistoryEntry; timeline: HistoryDetailReader; attachments: BotAttachment[]; download: (id: string) => void;
}) {
  const { turnId, id } = entry;
  const full = useSyncExternalStore(useCallback((fn) => timeline.subscribeDetail({ turnId, id }, fn), [timeline, turnId, id]), () => timeline.detailItem(entry), () => null);
  const refreshing = useSyncExternalStore(timeline.subscribe, () => timeline.detailPending(entry), () => false);
  const detailError = useSyncExternalStore(timeline.detailError ? timeline.subscribe : noDetailErrors, () => timeline.detailError?.(entry) ?? "", () => "");
  const [error, setError] = useState(""), [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try { await timeline.detail(entry); } catch { setError("Could not load message details. Try again."); }
    finally { setLoading(false); }
  }, [entry, timeline]);
  // Deferred entries mount only after disclosure. Later descriptors must not
  // bypass the controller's coalesced live-detail invalidation lane.
  const initialEntry = useRef(entry);
  useEffect(() => {
    let active = true;
    if (!initialEntry.current.item && !(initialEntry.current.workPlan && initialEntry.current.complete)) queueMicrotask(() => {
      if (!active) return;
      setLoading(true);
      void timeline.detail(initialEntry.current).catch(() => { if (active) setError("Could not load message details. Try again."); }).finally(() => { if (active) setLoading(false); });
    });
    return () => { active = false; };
  }, [timeline]);
  const item = full ?? entry.item;
  let workPlan = entry.workPlan, planError = '';
  // A new native preview stays current while an older opened detail is being
  // reconciled. A failed/expired full read must not cover it with stale steps.
  if (workPlan && full?.type === 'plan' && !refreshing && !loading && !detailError && !error) try { workPlan = readWorkPlanSource(full.text) ?? undefined; } catch { planError = "Could not update the work plan. The saved preview is shown."; }
  return <>{entry.questionNotice && <p className="bots-system-note">{entry.questionNotice}</p>}{refreshing && <small>Updating…</small>}{entry.workPlan ? workPlan && <WorkPlanMessage plan={workPlan} botId={timeline.botId} attachments={attachments} turnStatus={entry.turnStatus ?? entry.status}/> : item && <BotMessage item={item} submission={entry.submission} botId={timeline.botId} attachments={attachments} download={download} inWorkLog partial={entry.status === "inProgress" || !full && !entry.complete} />}
    {!entry.complete && <div className="bots-detail-status">
      <Button variant="outline" type="button" disabled={loading} onClick={() => void load()}>{loading ? "Loading…" : full ? "Refresh details" : item ? "Continue · load complete message" : "Open full details"}</Button>
      {full && !botsClient.online && <small>Saved copy. Reconnect to check for changes.</small>}
      {!full && <small>{entry.workPlan ? 'The bounded native snapshot remains readable. Full live updates may expire; missing historical explanations are not reconstructed.' : item ? "A preview of this message. Continue to read it in full." : "Open this work item to see its full details."}</small>}
    </div>}
    {(planError || (timeline.detailError ? detailError : error)) && <p role="alert" className="bots-error">{planError || (timeline.detailError ? "Could not refresh message details. Try again." : error)}{timeline.detailError && entry.complete && <Button variant="outline" type="button" disabled={refreshing || loading} onClick={() => void load()}>Refresh details</Button>}</p>}</>;
});
type WorkLogPage = { entries: HistoryEntry[]; olderCursor: string | null; attachments: BotAttachment[] };
function TurnWorkLog({ entry, timeline, download, excluded, onPage, cachedPage }: { entry: HistoryEntry; timeline: HistoryDetailReader; download: (id: string) => void; excluded?: Set<string>; onPage?: (page: WorkLogPage, turnId: string) => void; cachedPage?: WorkLogPage }) {
  const [page, setPage] = useState<WorkLogPage | null>(cachedPage ?? null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const alive = useRef(true), owner = useRef(botsClient.owner), thread = useRef(botsClient.snapshot?.bots.find(bot => bot.id === timeline.botId)?.threadId);
  const pageCallback = useRef(onPage), loadedPage = useRef(page);
  useEffect(() => { pageCallback.current = onPage; }, [onPage]);
  const load = useCallback(async (cursor: string | null = null) => {
    setBusy(true); setError('');
    try {
      const next = await botsClient.rpc<{ entries: HistoryEntry[]; olderCursor: string | null; attachments: BotAttachment[] }>('history.log', timeline.botId, { turnId: entry.turnId, cursor }, undefined, { owner: owner.current });
      if (!alive.current || botsClient.owner !== owner.current || thread.current !== botsClient.snapshot?.bots.find(bot => bot.id === timeline.botId)?.threadId) return;
      if (next.entries.some(e => e.turnId !== entry.turnId) || cursor && next.olderCursor === cursor) throw Error('Work-log page could not be verified. Retry opening it.');
      const prior = loadedPage.current;
      const combined = { ...next, entries: reconcileHistory(cursor && prior ? [...next.entries, ...prior.entries] : next.entries).entries,
        attachments: [...new Map([...(prior?.attachments ?? []), ...next.attachments].map(a => [a.id, a])).values()] };
      pageCallback.current?.(combined, entry.turnId); loadedPage.current = combined; setPage(combined);
    } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : 'Could not read the work log. Retry.'); }
    finally { if (alive.current) setBusy(false); }
  }, [timeline.botId, entry.turnId]);
  useEffect(() => { alive.current = true; queueMicrotask(() => { if (alive.current && !loadedPage.current) void load(); }); return () => { alive.current = false; }; }, [load]);
  return <div className="bots-native-work-log">
    {entry.turnError && <p role="alert" className="bots-error">{entry.turnError}</p>}
    {page?.olderCursor && <Button variant="outline" type="button" disabled={busy || !botsClient.online} onClick={() => void load(page.olderCursor)}>Earlier work items</Button>}
    {busy && <p role="status">Loading work log…</p>}
    {error && <p role="alert" className="bots-error">{error}<Button variant="outline" type="button" disabled={busy || !botsClient.online} onClick={() => void load(page?.olderCursor ?? null)}>Retry work log</Button></p>}
    {!busy && !error && page && !page.entries.length && !page.olderCursor && <p>No additional native work items.</p>}
    {page?.entries.filter(value => !excluded?.has(historyKey(value.turnId, value.id))).map(value => <TimelineEntry key={historyKey(value.turnId, value.id)} entry={value} timeline={timeline} attachments={page.attachments} download={download} showScheduledMark={false}/>)}
  </div>;
}
function NativeWorkAccess({ entry, timeline, state, capture, online }: { entry: HistoryEntry; timeline: BotTimeline; state?: import('./timeline-controller').WorkLogState; capture: () => void; online: boolean }) {
  if (state?.loaded && !state.olderCursor && !state.error) return entry.turnError ? <p role="alert" className="bots-error">{entry.turnError}</p> : null;
  return <div className="bots-native-history" data-history-key={historyKey(entry.turnId, entry.id)}>
    <Button variant="ghost" size="sm" type="button" disabled={!online || state?.loading} onClick={() => { capture(); void timeline.loadWorkLog(entry.turnId); }}>
      {state?.loading ? 'Loading work…' : state?.error ? 'Retry work details' : state?.loaded ? 'Load earlier work' : 'Load work details'}
    </Button>
    {state?.error && <span role="alert">{state.error}</span>}
    {entry.turnError && <p role="alert" className="bots-error">{entry.turnError}</p>}
  </div>;
}
export const TimelineEntry = memo(function TimelineEntry(props: Parameters<typeof EntryBody>[0] & { showScheduledMark?:boolean; onOpenCall?: () => void; threadId?: string; onReply?: (reply: BotReplyReference) => void; onOpenReply?: (reply: BotReplyReference) => Promise<boolean>; open?: boolean; onOpenChange?: (open: boolean) => void; beforeToggle?: () => void }) {
  const { entry } = props;
  if (entry.item?.type === "agentMessage" && !entry.item.text.trim() && !entry.item.questions?.length && !entry.questionNotice) return null;
  if (entry.type === "reasoning" && (entry.item?.type !== "reasoning" || !entry.item.summary.some(text => text.trim()))) return null;
  const work = nativeWorkItem(entry), commentary = entry.item?.type === 'agentMessage' && entry.item.phase === 'commentary';
  const reply = props.onReply && props.threadId ? <ReplyAction entry={entry} botId={props.timeline.botId} threadId={props.threadId} onReply={props.onReply} /> : null;
  const status = entry.itemStatus ?? entry.turnStatus ?? entry.status;
  return <div className={`bots-native-entry${work ? ' is-work' : commentary ? ' is-progress' : ' is-message'}`} data-history-key={historyKey(entry.turnId, entry.id)}>
    {props.showScheduledMark !== false && (entry.audience === "finding" || entry.scheduled && entry.type === "agentMessage") && <span className="bots-scheduled-message-mark" role="img" aria-label="From scheduled work" title="From scheduled work"><Clock3 size={13} aria-hidden="true" /></span>}
    {entry.reply && <ReplyQuote key={entry.reply.id} reply={entry.reply} onOpen={props.onOpenReply} />}
    {work ? <LazyDetails className="bots-native-work" open={props.open} onOpenChange={props.onOpenChange} beforeToggle={props.beforeToggle} summary={<><span className="bots-native-work-title">{nativeWorkLabel(entry)}</span><span className="bots-native-work-state">{entry.workPlan ? `${entry.workPlan.completedSteps}/${entry.workPlan.totalSteps}` : status === 'inProgress' ? 'Working' : ['failed','interrupted','declined'].includes(status) ? status : elapsed(entry, 'item') ? <ElapsedTime value={elapsed(entry, 'item')!}/> : ''}</span></>}>
      {() => <div className="bots-native-work-body">{entry.deferredTurn ? <TurnWorkLog entry={entry} timeline={props.timeline} download={props.download}/> : <EntryBody {...props}/>} {reply}</div>}
    </LazyDetails> : <EntryBody {...props}/>}
    {!work && reply}
    {entry.operatorSegmentId && <LazyDetails className="operator-call-card operator-origin" summary={<><Phone size={13} aria-hidden="true"/>Voice call</>}>{() => <OperatorSegmentBody botId={props.timeline.botId} segmentId={entry.operatorSegmentId!} onOpenCalls={props.onOpenCall}/>}</LazyDetails>}
    {!work && <MessageTime seconds={entry.messageAt} basis={entry.timeBasis ?? "turn-start"} user={entry.type === "userMessage"} elapsed={entry.item?.type === "agentMessage" && entry.item.phase === "final_answer" && entry.audience !== "finding" ? elapsed(entry, "turn") : null}/>}
  </div>;
});

/** Bounded body window; all preceding entries remain reachable through explicit pages. */
function BotConversationFeed({ owner, bot, online, children, onOpenCall, onReply, draft = "", submission, burstsEnabled = false, burstSubmitting = false }: { owner: string; bot: Bot; online: boolean; children?: ReactNode; onOpenActivity?: (target: ActivityTarget) => void; onOpenCall?: () => void; onReply?: (reply: BotReplyReference) => void; draft?: string; submission?: import("./draft-store").Submission; burstsEnabled?: boolean; burstSubmitting?: boolean }) {
  const taskRequests = useTaskRequests();
  const { timeline, state: nativeState } = useBotTimeline(owner, bot.id, online);
  const findings = useRunFindings(owner, bot.id, online, botsClient.snapshot?.capabilities?.backgroundRunLanes === 1);
  const projectEntries = useCallback((entries: HistoryEntry[]) => {
    const extra: HistoryEntry[] = findings.findings.filter(f => f.conversation !== true && !entries.some(e => e.scheduled && e.audience === "conversation" && e.runId === f.runId) && !entries.some(e => e.audience === "finding" && e.runId === f.runId && e.turnId === f.turnId && e.item?.type === "agentMessage" && e.item.text.trim() === f.summary.trim())).map(f => {
      const seconds = Date.parse(f.createdAt) / 1000;
      return { id: `finding:${f.id}`, turnId: f.turnId, type: "agentMessage", label: "Scheduled finding", item: { type: "agentMessage", id: `finding:${f.id}`, text: f.summary, phase: "final_answer", memoryCitation: null, delivery: null, questions: null }, complete: true, scheduled: true, status: "completed", startedAt: seconds, messageAt: seconds, timeBasis: "received", audience: "finding", runId: f.runId };
    });
    const base = entries;
    if (!extra.length) return base;
    // Native item order stays authoritative; insert external run findings at their recorded arrival time.
    const result = [...base];
    for (const f of extra) { const index = result.findIndex(e => (e.messageAt ?? e.startedAt ?? Infinity) > f.messageAt!); result.splice(index < 0 ? result.length : index, 0, f); }
    return result;
  }, [findings.findings]);
  const state = useMemo(() => ({ ...nativeState, entries: projectEntries(nativeState.entries) }), [nativeState, projectEntries]);
  const quietSeconds = bot.burstQuietSeconds ?? 3;
  const burst = useBurstConversation({ owner, botId: bot.id, threadId: bot.threadId, online, draft, enabled: burstsEnabled, quietSeconds });
  const burstAttachments = useMemo(() => { const files = new Map(state.attachments.map(file => [file.id, file])); for (const file of burst.value?.attachments ?? []) files.set(file.id, file); return [...files.values()]; }, [state.attachments, burst.value]);
  const batchProps = { botId: bot.id, attachments: burstAttachments, quietSeconds, online, typingUntil: burst.typingUntil };
  const sentIdentity = retainedBatches(burst.value).filter(batch => batch.state === 'sent').map(batch => batch.id).join(':');
  useEffect(() => { if (online && sentIdentity) void timeline.refreshLatest(); }, [timeline, online, sentIdentity]);
  const feed = useFeedScroll(timeline, state, online, projectEntries);
  const { first, last, scroll, content, showJump, paging, latest } = feed;
  useEffect(() => {
    const confirmed = (botId: string) => {
      if (botId === bot.id && botsClient.owner === owner) latest();
    };
    botsClient.confirmedInputs.add(confirmed);
    return () => { botsClient.confirmedInputs.delete(confirmed); };
  }, [bot.id, owner, latest]);
  useEffect(() => {
    if (!online || state.loading || state.error || !state.revision || !state.position.following || showJump || last !== state.entries.length || bot.lastReadAt >= bot.updatedAt) return;
    const mark = () => {
      if (document.visibilityState !== 'visible') return;
      const element = scroll.current;
      if (!element || element.scrollHeight - element.scrollTop - element.clientHeight > 120) return;
      markLocallyRead(owner, { id: bot.id, threadId: bot.threadId, updatedAt: bot.updatedAt });
      // Portable owner read state persists through the application API. The
      // older installed native router has no bots.read capability.
      if (botsClient.snapshot?.capabilities?.portableAgents !== 1)
        void botsClient.rpc('bots.read', bot.id, { threadId: bot.threadId, updatedAt: bot.updatedAt }, undefined, { owner }).catch(() => {});
    };
    const timer = setTimeout(mark, 800);
    document.addEventListener('visibilitychange', mark);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', mark); };
  }, [owner, online, bot.id, bot.threadId, bot.updatedAt, bot.lastReadAt, state.loading, state.error, state.revision, state.position.following, state.entries.length, last, showJump, scroll]);

  const tickNavigation = useMemo(() => humanMessageTicks(projectEntries(nativeState.entries), nativeState.contextEntries, bot.id, bot.threadId,
    entry => entry.replyMessages ?? canonicalBurst(entry, burst.value)?.messages), [nativeState.entries, nativeState.contextEntries, projectEntries, bot.id, bot.threadId, burst.value]);
  const selectTick = (tick: HumanMessageTick) => {
    if (botsClient.owner !== owner || bot.threadId !== botsClient.snapshot?.bots.find(value => value.id === bot.id)?.threadId) return;
    // A retained context/chooser preview may sit outside the current body
    // window. Reuse the same bounded original-source projection as quotes.
    timeline.revealSource(tick.entry);
    feed.jumpTo(tick.entry, tick.partId);
  };
  const secure = useSecureInputRequests({ owner, botId: bot.id, threadId: bot.threadId, online, enabled: botsClient.snapshot?.capabilities?.secureInputs === 1 });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const revealActivity = (entry: HistoryEntry) => setExpanded(prior => new Set([...prior, timeline.resolveKey(historyKey(entry.turnId, entry.id))!]));
  const sourceCursor = useRef(new Map<string, string>()), resolving = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const openReply = async (reply: BotReplyReference) => {
    if (reply.botId !== bot.id || reply.threadId !== bot.threadId) return false;
    const loaded = state.entries.find(entry => historyKey(entry.turnId, entry.id) === timeline.resolveKey(historyKey(reply.turnId, reply.itemId)));
    if (loaded) { revealActivity(loaded); feed.jumpTo(loaded, reply.partId); return true; }
    if (!online || resolving.current) throw Error("Reconnect to locate this message.");
    resolving.current = true; feed.capture();
    const intent = feed.readingIntent();
    try {
      let cursor = sourceCursor.current.get(reply.id) ?? null;
      const seen = new Set();
      for (let count = 0; count < 1; count++) {
        if (seen.has(cursor)) throw Error("History did not advance."); seen.add(cursor);
        const result = await botsClient.rpc<{ entry: HistoryEntry | null; nextCursor: string | null; unavailable: boolean }>("replies.resolve", bot.id, { reply, cursor }, undefined, { owner });
        if (botsClient.owner !== owner) throw Error("Owner changed.");
        if (result.entry) {
          // Preserve reading intent if the user moved while the lazy read ran.
          const unchanged = mounted.current && feed.readingIntent() === intent;
          timeline.revealSource(result.entry); sourceCursor.current.delete(reply.id);
          if (unchanged) { revealActivity(result.entry); feed.jumpTo(result.entry, reply.partId); }
          return true;
        }
        if (result.unavailable || !result.nextCursor) { sourceCursor.current.delete(reply.id); return false; }
        cursor = result.nextCursor; sourceCursor.current.set(reply.id, cursor);
      }
      throw Error("More history remains; open this quote again to continue.");
    } finally { resolving.current = false; }
  };
  const replyProps = { onReply, onOpenReply: openReply, threadId: bot.threadId ?? undefined };
  const [downloadError, setDownloadError] = useState("");
  const pinnedContext = state.position.tailContext && !state.position.following
    ? [...state.contextEntries, ...state.entries].find(entry => historyKey(entry.turnId, entry.id) === timeline.resolveKey(state.position.anchor)) : undefined;
  const mountedKeys = new Set(state.entries.slice(first, last).map(entry => timeline.resolveKey(historyKey(entry.turnId, entry.id))));
  const contextEntries = (pinnedContext && !state.contextEntries.some(entry => historyKey(entry.turnId, entry.id) === historyKey(pinnedContext.turnId, pinnedContext.id)) ? [pinnedContext] : state.contextEntries).filter(entry => !mountedKeys.has(timeline.resolveKey(historyKey(entry.turnId, entry.id))));
  const afterContext = contextEntries.filter(entry => {
    const index = state.entries.findIndex(value => historyKey(value.turnId, value.id) === timeline.resolveKey(historyKey(entry.turnId, entry.id)));
    return index >= last;
  });
  const beforeContext = contextEntries.filter(entry => !afterContext.includes(entry));
  // A cached native echo outside the rendered window cannot replace a
  // visible staging bubble. Deduplicate against rows actually displayed.
  const nativeBatchIds = new Set([...state.entries.slice(first, last), ...(pinnedContext || last === state.entries.length ? contextEntries : [])]
    .flatMap(entry => entry.item?.type === 'userMessage' && entry.item.clientId ? [entry.item.clientId] : []));
  const unprojectedBatches = retainedBatches(burst.value).filter(batch => !nativeBatchIds.has(batch.operationId ?? batch.id));
  const groups = useMemo(() => {
    const result: ConversationGroup[] = [];
    for (const entry of state.entries.slice(first, last)) {
      if (entry.item?.type === "agentMessage" && !entry.item.text.trim() && !entry.item.questions?.length && !entry.questionNotice) continue;
      if (entry.type === "reasoning" && (entry.item?.type !== "reasoning" || !entry.item.summary.some(text => text.trim()))) continue;
      result.push({ kind: "message", entries: [entry] });
    }
    const grouped = taskRequestGroups(secureTimelineGroups(result, secure.requests.filter(r => r.state !== 'waiting'), state.entries, first, last, state.olderCursor), taskRequests?.requests ?? [], state.entries, first, last, state.olderCursor);
    // Receipt bubbles occupy their chronological position, never an appended
    // replay of all recent human messages after the assistant's latest reply.
    const time = (entry: HistoryEntry | undefined) => entry?.messageAt ?? entry?.startedAt ?? Infinity;
    const lower = first > 0 || state.olderCursor ? time(state.entries[first]) : -Infinity;
    const upper = last < state.entries.length ? time(state.entries[last]) : Infinity;
    for (const batch of unprojectedBatches.filter(batch => batch.state === 'sent')) {
      const messages = batch.messageIds.flatMap(id => burst.value?.messages.find(message => message.id === id) ?? []);
      if (!messages.length) continue;
      const at = Math.min(...messages.map(message => Date.parse(message.createdAt) / 1000));
      if (!Number.isFinite(at) || at < lower || at >= upper || batch.state === 'sent' && burst.value?.threadId !== bot.threadId) continue;
      const index = grouped.findIndex(group => group.burst ? Date.parse(burst.value?.messages.find(message => group.burst?.messageIds.includes(message.id))?.createdAt ?? '') / 1000 > at : time(group.entries[0]) > at);
      grouped.splice(index < 0 ? grouped.length : index, 0, { kind: `burst:${batch.id}`, entries: [], burst: batch });
    }
    return grouped;
  }, [state.entries, state.olderCursor, first, last, secure.requests, taskRequests?.requests, burst.value, bot.threadId, unprojectedBatches]);
  // Retain open aliases only within this mounted conversation's bounded cache.
  useEffect(() => {
    let alive = true;
    queueMicrotask(() => { if (!alive) return; setExpanded(prior => {
      const kept = new Set(state.entries.map(entry => timeline.resolveKey(historyKey(entry.turnId, entry.id))!));
      const next = new Set([...prior].map(key => timeline.resolveKey(key)!).filter(key => kept.has(key)));
      return next.size === prior.size && [...next].every(key => prior.has(key)) ? prior : next;
    }); });
    return () => { alive = false; };
  }, [groups, state.entries, timeline]);
  const linkedArtifacts = useMemo(() => new Set(state.entries.slice(first, last).flatMap((entry) =>
    entry.item?.type === "agentMessage" ? [...[...entry.item.text.matchAll(/\]\(<?bot-artifact:([^\s)>]+)/g)].map((match) => match[1]), ...fileCitationReferences(entry.item.text).flatMap(ref => { const matches=state.attachments.filter(file=>file.botId===bot.id&&file.ready&&(file.artifact||file.direction==="output")&&(file.path===ref.path||file.visualizationReferences?.includes(ref.path))); return matches.length===1?[matches[0].id]:[]; })] : [],
  )), [state.entries, state.attachments, bot.id, first, last]);
  const download = useCallback((id: string) => {
    setDownloadError("");
    void botsClient.download(bot.id, id).then(({ blob, name }) => {
      const url = URL.createObjectURL(blob), a = document.createElement("a"); a.href = url; a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }).catch(() => setDownloadError("Could not download this file. Try again."));
  }, [bot.id]);
  // A supplementary context preview can share a canonical identity with an
  // older cached item. Keep a preview being read when newer output arrives;
  // it must neither recenter the native window nor repeat a mounted item.
  // Other message groups do not replace that reply.
  const readableContext = (entries: HistoryEntry[]) => entries.length > 0 && <section aria-label="Latest readable context" data-history-context>
    <p className="bots-system-note">Latest readable messages. Intervening work remains accessible through earlier history.</p>
    {entries.map(entry => <TimelineEntry {...replyProps} onOpenCall={onOpenCall} key={historyKey(entry.turnId, entry.id)} entry={entry} timeline={timeline} attachments={state.attachments} download={download} />)}
  </section>;
  const earlierTicks = first > 0 || Boolean(state.olderCursor) || state.gaps.some(gap => gap.before === historyKey(state.entries[first]?.turnId ?? '', state.entries[first]?.id ?? ''));
  const showTicks = tickNavigation.ticks.length > 0 || earlierTicks;
  return <NativeTimingContext.Provider value={{ owner, botId: bot.id, threadId: bot.threadId, entries: nativeState.entries, current: nativeState.currentTiming }}><div className={`bots-timeline${showTicks ? ' has-message-ticks' : ''}`}><SecureInputAccess key={JSON.stringify([owner, bot.id, bot.threadId])} state={secure}/><div className="bots-messages" ref={scroll} tabIndex={0} {...feed.handlers}><div ref={content}>
    <TaskRequestAccess capture={feed.capture}/>
    {paging && <div className="bots-feed-loading" role="status">Loading conversation…</div>}
    {(first > 0 || state.olderCursor) && !state.loading && (!online || state.error || !state.entries.length) && <Button variant="outline" type="button" className="bots-older" disabled={paging || !online && (first === 0 || state.gaps.some((gap) => gap.before === historyKey(state.entries[first].turnId, state.entries[first].id)))} onClick={() => void feed.page(-1, true)}>{state.entries.length ? "Load earlier turns" : "Continue loading history"}</Button>}
    {!state.loading && !state.error && !state.entries.length && state.olderCursor && <p className="bots-system-note">This page has no conversational replies. Earlier messages remain available above.</p>}
    {state.partialTurn && first === 0 && <p className="bots-system-note">This large turn continues above. Scroll up for the rest.</p>}
    {!online && state.cached && <div className="bots-system-note">Saved conversation. Reconnect for updates and work details not saved here.</div>}
    {state.error && <div className="bots-history-error" role="alert"><CloudOff size={22} aria-hidden="true" /><div><strong>Let’s try that again</strong><p>{state.error}</p><Button variant="outline" type="button" disabled={!online} onClick={() => void timeline.refresh()}>Reload conversation</Button></div></div>}
    {findings.nextCursor && first === 0 && <Button variant="outline" type="button" className="bots-older" disabled={!online || findings.busy} onClick={() => { feed.capture(); void findings.older(); }}>Earlier scheduled findings</Button>}
    {findings.error && <p className="bots-error" role="alert">{findings.error}<Button variant="outline" type="button" disabled={!online || findings.busy} onClick={findings.retry}>Retry</Button></p>}
    {state.loading && !state.entries.length && <div className="bots-history-skeleton" role="status" aria-label="Loading conversation"><span /><span /><span /><span /></div>}
    {!state.loading && !state.error && !state.entries.length && !state.olderCursor && <div className="bots-conversation-start"><span className="bots-start-icon"><MessageCircle size={26} strokeWidth={1.4} aria-hidden="true" /></span><h2>{bot.name}</h2><p>{bot.purpose || "What would you like to work on?"}</p></div>}
    {(pinnedContext || last === state.entries.length) && readableContext(beforeContext)}
    {groups.map((group) => {
      if (group.burst) return <BurstBubbles key={group.kind} batch={group.burst} messages={group.burst.messageIds.flatMap(id => burst.value?.messages.find(message => message.id === id) ?? [])} truncatedIds={burst.value?.preview?.truncatedTextIds} controls={burst} {...batchProps} onOpenReply={openReply}/>;
      if (group.secure) return <div key={group.secure.id} className="bots-secure-timeline-entry"><SecureInputCard request={group.secure} online={online}/><MessageTime seconds={Date.parse(group.secure.createdAt) / 1000} basis="received" inline/></div>;
      if (group.taskRequest) return <TaskRequestCard key={group.kind} request={group.taskRequest} capture={feed.capture}/>;
      const entry = group.entries[0], key = historyKey(entry.turnId, entry.id);
      const open = expanded.has(timeline.resolveKey(key)!);
      const workProps = { open, beforeToggle: feed.capture, onOpenChange: (next: boolean) => setExpanded(prior => { const copy = new Set(prior); if (next) copy.add(key); else copy.delete(key); return copy; }) };
      const confirmed = canonicalBurst(entry, burst.value);
      const replyBatch = entry.replyMessages;
      return <Fragment key={key}>
        {(!online || state.error) && state.gaps.filter((gap) => group.entries.some((entry) => gap.before === historyKey(entry.turnId, entry.id))).map((gap) => <div className="bots-system-note" key={gap.before}>
          Some messages between these pages are not loaded. <Button variant="outline" type="button" disabled={!online || paging} onClick={() => {
            feed.capture(); void timeline.fillGap(gap);
          }}>Load messages in between</Button></div>)}
        {entry.deferredTurn ? <NativeWorkAccess entry={entry} timeline={timeline} state={nativeState.workLogs[entry.turnId]} capture={feed.capture} online={online}/> : group.kind === "message" ? replyBatch ? <div data-history-key={key}><BurstBubbles messages={replyBatch} {...batchProps} onOpenReply={openReply} onReply={onReply} threadId={bot.threadId??undefined} replySource={entry} sent /></div> : confirmed ? <div data-history-key={key}><BurstBubbles messages={confirmed.messages} batch={confirmed.batch} {...batchProps} onOpenReply={openReply} onReply={onReply} threadId={bot.threadId??undefined} replySource={entry} /></div> : <TimelineEntry {...replyProps} {...workProps} onOpenCall={onOpenCall} entry={entry} timeline={timeline} attachments={state.attachments} download={download} />
          : null}
        {groups.slice(groups.indexOf(group) + 1).find(next => !next.secure && !next.taskRequest && !next.burst)?.entries[0]?.turnId !== entry.turnId ? <ReturnedArtifacts linked={linkedArtifacts} attachments={state.attachments} turnId={entry.turnId} botId={bot.id} /> : null}
      </Fragment>;
    })}
    {(pinnedContext || last === state.entries.length) && readableContext(afterContext)}
    {downloadError && <p className="bots-error" role="alert">{downloadError}</p>}

    {burstsEnabled && <section className="bots-blast-staging" aria-label="Messages waiting to send">
      {unprojectedBatches.filter(batch => !['sent', 'discarded'].includes(batch.state)).map(batch =>
        <BurstBubbles key={batch.id} batch={batch} messages={batch.messageIds.flatMap(id => burst.value?.messages.find(message => message.id === id) ?? [])}
          truncatedIds={burst.value?.preview?.truncatedTextIds} controls={burst} {...batchProps} onOpenReply={openReply}/>)}
      <BurstControls burst={burst} online={online} submitting={burstSubmitting} />
    </section>}
    {submission?.method === 'bursts.submit' && submission.botId === bot.id && !burst.value?.messages.some(message => message.id === submission.id) && <div className="bots-native-submission" data-submission-id={submission.id}>
      <BotMessage item={{ type: 'userMessage', id: `client:${submission.id}`, clientId: submission.id, content: [{ type: 'text', text: String(submission.params.text ?? ''), text_elements: [] }] }} botId={bot.id} attachments={burstAttachments} download={download}/>
      {Array.isArray(submission.params.attachments) && submission.params.attachments.length > 0 && <small>{submission.params.attachments.length} attached {submission.params.attachments.length === 1 ? 'file' : 'files'}</small>}
      <small role="status">{submission.state === 'uncertain' ? 'Delivery unconfirmed' : 'Sending…'}</small>
    </div>}
    {children}
  </div></div>{showTicks && <MessageTickRail {...tickNavigation} scroll={scroll} content={content} earlier={earlierTicks} incomplete={!state.complete || Boolean(state.olderCursor) || state.gaps.length > 0} loading={paging || state.loading} online={online} error={state.error} onEarlier={() => feed.page(-1, true)} onSelect={selectTick}/>} {(showJump || last < state.entries.length || state.error || state.loading && state.cached) && <Button variant="outline" type="button" className="bots-jump-latest" disabled={!online || state.loading} onClick={() => {
    latest();
    if (state.error) void timeline.recoverLatest();
    else void timeline.refreshLatest();
  }}><ArrowDown size={16} aria-hidden="true" />{state.loading ? "Loading latest…" : state.error ? "Retry latest messages" : "Latest messages"}</Button>}</div></NativeTimingContext.Provider>;
}

export function BotConversation(props: Parameters<typeof BotConversationFeed>[0]) {
  return <BotConversationFeed key={JSON.stringify([props.owner, props.bot.id, props.bot.threadId])} {...props}/>;
}
