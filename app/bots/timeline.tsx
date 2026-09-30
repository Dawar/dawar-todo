"use client";
import { Fragment, memo, useCallback, useEffect, useRef, useState, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { Bot, BotAttachment } from "../../lib/bots-types";
import { historyKey, type HistoryEntry } from "../../lib/bot-history-view";
import type { BotTimeline } from "./timeline-controller";
/** Main and owned-run readers share rendering only, never state or persistence. */
export type HistoryDetailReader = Pick<BotTimeline, "botId" | "subscribeDetail" | "detailItem" | "subscribe" | "detailPending" | "detail"> & { detailError?: (entry: HistoryEntry) => string };
import { useBotTimeline } from "./use-timeline";
import { botsClient } from "./client";
import { BotAvatar } from "./bot-avatar";
import { BotMessage } from "./message";
import { ArrowDown, MessageCircle, CloudOff } from "lucide-react";
import { LazyDetails } from "./lazy-details";
import { useFeedScroll } from "./use-feed-scroll";
import { ReturnedArtifacts } from "./returned-artifact";
import type { ActivityTarget } from "./conversation-activity";
import { useBurstConversation, BurstControls, BurstBubbles, canonicalBurst } from "./burst-composer";
import { retainedBatches } from "./burst-state";
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
    try { await timeline.detail(entry); } catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  }, [entry, timeline]);
  // Deferred entries mount only after disclosure. Later descriptors must not
  // bypass the controller's coalesced live-detail invalidation lane.
  const initialEntry = useRef(entry);
  useEffect(() => {
    let active = true;
    if (!initialEntry.current.item) queueMicrotask(() => {
      if (!active) return;
      setLoading(true);
      void timeline.detail(initialEntry.current).catch((error) => { if (active) setError(String(error)); }).finally(() => { if (active) setLoading(false); });
    });
    return () => { active = false; };
  }, [timeline]);
  const item = full ?? entry.item;
  return <>{refreshing && <small>Updating…</small>}{item && <BotMessage item={item} botId={timeline.botId} attachments={attachments} download={download} inWorkLog />}
    {!entry.complete && <div className="bots-detail-status">
      <button disabled={loading} onClick={() => void load()}>{loading ? "Loading…" : full ? "Refresh details" : item ? "Continue · load complete message" : "Open full details"}</button>
      {full && !botsClient.online && <small>Saved copy. Reconnect to check for changes.</small>}
      {!full && <small>{item ? "A preview of this message. Continue to read it in full." : "Open this work item to see its full details."}</small>}
    </div>}
    {(timeline.detailError ? detailError : error) && <p role="alert" className="bots-error">{timeline.detailError ? detailError : error}{timeline.detailError && entry.complete && <button disabled={refreshing || loading} onClick={() => void load()}>Refresh details</button>}</p>}</>;
});
export const TimelineEntry = memo(function TimelineEntry(props: Parameters<typeof EntryBody>[0]) {
  const { entry } = props;
  if (entry.type === "reasoning" && (entry.item?.type !== "reasoning" || !entry.item.summary.some(text => text.trim()))) return null;
  return <div data-history-key={historyKey(entry.turnId, entry.id)}>
    {entry.type === "reasoning" ? <LazyDetails className="bots-activity" summary="Thinking">{() => <EntryBody {...props} />}</LazyDetails> : entry.scheduled ? <LazyDetails className="bots-turn is-scheduled" summary={`Scheduled run · ${entry.status} · ${entry.label}`}>
      {() => <EntryBody {...props} />}</LazyDetails>
      : !entry.item ? <LazyDetails className="bots-activity" summary={<><span>Work log · {entry.label}</span><small>{entry.itemStatus ?? entry.status}</small></>}>
        {() => <EntryBody {...props} />}</LazyDetails> : <EntryBody {...props} />}
  </div>;
});

/** Bounded body window; all preceding entries remain reachable through explicit pages. */
export function BotConversation({ owner, bot, online, children, onOpenActivity, draft = "", burstsEnabled = false, burstSubmitting = false }: { owner: string; bot: Bot; online: boolean; children?: ReactNode; onOpenActivity?: (target: ActivityTarget) => void; draft?: string; burstsEnabled?: boolean; burstSubmitting?: boolean }) {
  const { timeline, state } = useBotTimeline(owner, bot.id, online);
  const burst = useBurstConversation({ owner, botId: bot.id, online, draft, enabled: burstsEnabled });
  const burstAttachments = useMemo(() => { const files = new Map(state.attachments.map(file => [file.id, file])); for (const file of burst.value?.attachments ?? []) files.set(file.id, file); return [...files.values()]; }, [state.attachments, burst.value]);
  const batchProps = { botId: bot.id, attachments: burstAttachments, quietSeconds: bot.burstQuietSeconds ?? 8, online, typing: !!draft };
  const nativeBatchIds = new Set([...state.entries, ...state.contextEntries].flatMap(entry => entry.item?.type === "userMessage" && entry.item.clientId ? [entry.item.clientId] : []));
  const tailBatches = retainedBatches(burst.value).filter(batch => batch.state !== "sent" && !nativeBatchIds.has(batch.operationId ?? batch.id));
  const feed = useFeedScroll(timeline, state, online);
  const { first, last, scroll, content, showJump, paging, latest } = feed;
  const [downloadError, setDownloadError] = useState("");
  const groups = useMemo(() => {
    const result: { kind: string; entries: HistoryEntry[] }[] = [];
    for (const entry of state.entries.slice(first, last)) {
      if (entry.type === "reasoning" && (entry.item?.type !== "reasoning" || !entry.item.summary.some(text => text.trim()))) continue;
      const kind = entry.type === "reasoning" ? `thinking:${entry.turnId}` : !entry.item ? `work:${entry.turnId}` : "message";
      const previous = result.at(-1);
      if (kind !== "message" && previous?.kind === kind) previous.entries.push(entry);
      else result.push({ kind, entries: [entry] });
    }
    return result;
  }, [state.entries, first, last]);
  const linkedArtifacts = useMemo(() => new Set(state.entries.slice(first, last).flatMap((entry) =>
    entry.item?.type === "agentMessage" ? [...entry.item.text.matchAll(/\]\(<?bot-artifact:([^\s)>]+)/g)].map((match) => match[1]) : [],
  )), [state.entries, first, last]);
  const download = useCallback((id: string) => {
    setDownloadError("");
    void botsClient.download(bot.id, id).then(({ blob, name }) => {
      const url = URL.createObjectURL(blob), a = document.createElement("a"); a.href = url; a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }).catch((error) => setDownloadError(String(error)));
  }, [bot.id]);
  return <div className="bots-timeline"><div className="bots-messages" ref={scroll} tabIndex={0} {...feed.handlers}><div ref={content}>
    {paging && <div className="bots-feed-loading" role="status">Loading conversation…</div>}
    {(first > 0 || state.olderCursor) && !state.loading && (!online || state.error || !state.entries.length) && <button className="bots-older" disabled={paging || !online && (first === 0 || state.gaps.some((gap) => gap.before === historyKey(state.entries[first].turnId, state.entries[first].id)))} onClick={() => void feed.page(-1, true)}>{state.entries.length ? "Load earlier turns" : "Continue loading history"}</button>}
    {state.partialTurn && first === 0 && <p className="bots-system-note">This large turn continues above. Scroll up for the rest.</p>}
    {!online && state.cached && <div className="bots-system-note">Saved conversation. Reconnect for updates and work details not saved here.</div>}
    {state.error && <div className="bots-history-error" role="alert"><CloudOff size={22} aria-hidden="true" /><div><strong>Let’s try that again</strong><p>{state.error}</p><button disabled={!online} onClick={() => void timeline.refresh()}>Reload conversation</button></div></div>}
    {state.loading && !state.entries.length && <div className="bots-history-skeleton" role="status" aria-label="Loading conversation"><span /><span /><span /><span /></div>}
    {!state.loading && !state.error && !state.entries.length && !state.olderCursor && <div className="bots-conversation-start"><span className="bots-start-icon"><MessageCircle size={26} strokeWidth={1.4} aria-hidden="true" /></span><h2>{bot.name}</h2><p>{bot.purpose || "What would you like to work on?"}</p></div>}
    {last === state.entries.length && !groups.some((group) => group.kind === "message") && state.contextEntries.length > 0 && <section aria-label="Latest readable context">
      <p className="bots-system-note">Latest readable messages. Intervening work remains accessible through earlier history.</p>
      {state.contextEntries.map((entry) => <TimelineEntry key={historyKey(entry.turnId, entry.id)} entry={entry} timeline={timeline} attachments={state.attachments} download={download} />)}
    </section>}
    {groups.map((group) => {
      const entry = group.entries[0], key = historyKey(entry.turnId, entry.id);
      const body = () => group.entries.map((value) => group.kind.startsWith("thinking:") ? <div key={value.id} data-history-key={historyKey(value.turnId, value.id)}><EntryBody entry={value} timeline={timeline} attachments={state.attachments} download={download} /></div> : <TimelineEntry key={historyKey(value.turnId, value.id)} entry={{ ...value, scheduled: false }} timeline={timeline} attachments={state.attachments} download={download} />);
      const summary = group.kind.startsWith("thinking:") ? <span className="bots-reasoning-face"><BotAvatar bot={bot} small decorative emotion="thinking" working={entry.status === "inProgress"} /><span>Thinking</span></span> : <><span>Work log</span><small>{group.entries.length} {group.entries.length === 1 ? "step" : "steps"}</small></>;
      const confirmed = canonicalBurst(entry, burst.value);
      return <Fragment key={key}>
        {(entry.audience === "finding" || entry.audience === "mixed" && groups[groups.indexOf(group) - 1]?.entries[0].turnId !== entry.turnId) && <div className="bots-run-provenance">
          <span>{entry.audience === "finding" ? "A finding from scheduled work" : entry.legacyContext ? "Earlier saved context" : "Conversation during scheduled work"}</span>
          {onOpenActivity && <button onClick={() => onOpenActivity({ turnId: entry.turnId, runId: entry.runId })}>Open in history</button>}
        </div>}
        {(!online || state.error) && state.gaps.filter((gap) => group.entries.some((entry) => gap.before === historyKey(entry.turnId, entry.id))).map((gap) => <div className="bots-system-note" key={gap.before}>
          Some messages between these pages are not loaded. <button disabled={!online || paging} onClick={() => {
            feed.capture(); void timeline.fillGap(gap);
          }}>Load messages in between</button></div>)}
        {group.kind === "message" ? confirmed ? <div data-history-key={key}><BurstBubbles messages={confirmed.messages} batch={confirmed.batch} {...batchProps} /></div> : <TimelineEntry entry={entry} timeline={timeline} attachments={state.attachments} download={download} />
          : <div data-history-key={key} style={{ position: "relative" }}>{group.entries.slice(1).map((value) => <span key={value.id} data-history-key={historyKey(value.turnId, value.id)} aria-hidden="true" style={{ position: "absolute", top: 0, height: 0, pointerEvents: "none" }} />)}<LazyDetails className="bots-activity" summary={summary}>{body}</LazyDetails></div>}
        {group === groups.at(-1) || groups[groups.indexOf(group) + 1]?.entries[0].turnId !== entry.turnId ? <ReturnedArtifacts linked={linkedArtifacts} attachments={state.attachments} turnId={entry.turnId} botId={bot.id} /> : null}
      </Fragment>;
    })}
    {last < state.entries.length && (!online || state.error) && <button className="bots-older" disabled={paging || !online && state.gaps.some((gap) => gap.before === historyKey(state.entries[last].turnId, state.entries[last].id))} onClick={() => void feed.page(1, true)}>Load newer turns</button>}
    {downloadError && <p className="bots-error" role="alert">{downloadError}</p>}
    {last === state.entries.length && tailBatches.map(batch => <BurstBubbles key={batch.id} batch={batch} messages={batch.messageIds.flatMap(id => { const message = burst.value?.messages.find(message => message.id === id); return message ? [message] : []; })} truncatedIds={burst.value?.preview?.truncatedTextIds} {...batchProps} />)}
    {burstsEnabled && <BurstControls burst={burst} online={online} submitting={burstSubmitting} />}
    {children}
  </div></div>{showJump && <button className="bots-jump-latest" onClick={latest}><ArrowDown size={16} aria-hidden="true" />Latest messages</button>}</div>;
}
