"use client";
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { Bot, BotAttachment } from "../../lib/bots-types";
import { historyKey, type HistoryEntry } from "../../lib/bot-history-view";
import type { BotTimeline } from "./timeline-controller";
import { useBotTimeline } from "./use-timeline";
import { botsClient } from "./client";
import { BotMessage } from "./message";
import { ArrowDown, MessageCircle, CloudOff } from "lucide-react";
import { LazyDetails } from "./lazy-details";
import { ReturnedArtifacts } from "./returned-artifact";

const PAGE = 40;
const EntryBody = memo(function EntryBody({ entry, timeline, attachments, download }: {
  entry: HistoryEntry; timeline: BotTimeline; attachments: BotAttachment[]; download: (id: string) => void;
}) {
  const { turnId, id } = entry;
  const full = useSyncExternalStore(useCallback((fn) => timeline.subscribeDetail({ turnId, id }, fn), [timeline, turnId, id]), () => timeline.detailItem(entry), () => null);
  const refreshing = useSyncExternalStore(timeline.subscribe, () => timeline.detailPending(entry), () => false);
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
    {error && <p role="alert" className="bots-error">{error}</p>}</>;
});
export const TimelineEntry = memo(function TimelineEntry(props: Parameters<typeof EntryBody>[0]) {
  const { entry } = props;
  return <div data-history-key={historyKey(entry.turnId, entry.id)}>
    {entry.scheduled ? <LazyDetails className="bots-turn is-scheduled" summary={`Scheduled run · ${entry.status} · ${entry.label}`}>
      {() => <EntryBody {...props} />}</LazyDetails>
      : !entry.item ? <LazyDetails className="bots-activity" summary={<><span>Work log · {entry.label}</span><small>{entry.itemStatus ?? entry.status}</small></>}>
        {() => <EntryBody {...props} />}</LazyDetails> : <EntryBody {...props} />}
  </div>;
});

/** Bounded body window; all preceding entries remain reachable through explicit pages. */
export function BotConversation({ owner, bot, online, children }: { owner: string; bot: Bot; online: boolean; children?: ReactNode }) {
  const { timeline, state } = useBotTimeline(owner, bot.id, online);
  const scroll = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null);
  const restored = useRef(false), following = useRef(true), saved = useRef(state.position), hasNewer = useRef(false);
  const geometry = useRef(""), userScroll = useRef(false);
  const [showJump, setShowJump] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  const [end, setEnd] = useState<number | null>(null), [paging, setPaging] = useState(false);
  const last = end === null ? state.entries.length : Math.min(end, state.entries.length), first = Math.max(0, last - PAGE);
  useLayoutEffect(() => { hasNewer.current = last < state.entries.length; }, [last, state.entries.length]);
  const updateJump = useCallback(() => {
    const element = scroll.current; if (!element) return;
    const distance = element.scrollHeight - element.clientHeight - element.scrollTop;
    setShowJump((visible) => hasNewer.current || (distance > 2 && (distance > 120 || visible)));
  }, []);
  const groups = useMemo(() => {
    const result: { kind: string; entries: HistoryEntry[] }[] = [];
    for (const entry of state.entries.slice(first, last)) {
      const kind = entry.scheduled ? `schedule:${entry.turnId}` : !entry.item ? `work:${entry.turnId}` : "message";
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
  const capture = useCallback(() => {
    const element = scroll.current; if (!element) return;
    const size = `${element.clientHeight}:${element.scrollHeight}`;
    // A resized composer/image can fire scroll before ResizeObserver. That is
    // not a user leaving the bottom: preserve follow-latest through the resize.
    if (following.current && geometry.current !== size && !userScroll.current) {
      geometry.current = size; element.scrollTop = element.scrollHeight; updateJump(); return;
    }
    geometry.current = size; userScroll.current = false;
    following.current = end === null && element.scrollHeight - element.scrollTop - element.clientHeight < 100;
    const top = element.getBoundingClientRect().top;
    const anchor = [...element.querySelectorAll<HTMLElement>("[data-history-key]")].find((e) => e.getBoundingClientRect().bottom >= top);
    saved.current = { anchor: anchor?.dataset.historyKey ?? null, offset: anchor ? anchor.getBoundingClientRect().top - top : 0, following: following.current };
    timeline.position(saved.current); updateJump();
  }, [timeline, end, updateJump]);
  const restore = useCallback(() => {
    const element = scroll.current; if (!element) return;
    geometry.current = `${element.clientHeight}:${element.scrollHeight}`;
    element.scrollLeft = 0;
    if (following.current) element.scrollTop = element.scrollHeight;
    else {
      const anchor = [...element.querySelectorAll<HTMLElement>("[data-history-key]")].find((e) => e.dataset.historyKey === saved.current.anchor);
      if (anchor) element.scrollTop += anchor.getBoundingClientRect().top - element.getBoundingClientRect().top - saved.current.offset;
    }
    updateJump();
  }, [updateJump]);
  useLayoutEffect(() => {
    if (!state.entries.length) return;
    if (!restored.current) {
      restored.current = true; saved.current = state.position; following.current = state.position.following;
      const index = state.entries.findIndex((e) => historyKey(e.turnId, e.id) === state.position.anchor);
      if (!following.current && index >= 0 && index < first) { setEnd(Math.min(state.entries.length, index + PAGE)); return; }
    }
    restore();
  }, [state.entries, state.position, first, restore]);
  useLayoutEffect(() => {
    // Late images and opened details retain the reading anchor or follow latest.
    const observer = new ResizeObserver(restore); if (content.current) observer.observe(content.current); if (scroll.current) observer.observe(scroll.current);
    return () => { observer.disconnect(); };
  }, [restore]);
  async function earlier() {
    capture(); following.current = false; saved.current = { ...saved.current, following: false }; setPaging(true);
    try {
      if (first > 0) setEnd(Math.max(PAGE, first + PAGE / 2));
      else {
        await timeline.older();
        const entries = timeline.getSnapshot().entries;
        const anchor = entries.findIndex((entry) => historyKey(entry.turnId, entry.id) === saved.current.anchor);
        setEnd(Math.min(entries.length, Math.max(PAGE, anchor + PAGE / 2)));
      }
      timeline.position(saved.current);
    } finally { setPaging(false); }
  }
  const latest = () => { setShowJump(false); following.current = true; saved.current = { anchor: null, offset: 0, following: true }; timeline.position(saved.current); setEnd(null); requestAnimationFrame(restore); };
  return <div className="bots-timeline"><div className="bots-messages" ref={scroll} onScroll={capture} onWheel={() => { userScroll.current = true; }} onTouchMove={() => { userScroll.current = true; }} onPointerDown={(event) => { if (event.target === event.currentTarget) userScroll.current = true; }}><div ref={content}>
    {(first > 0 || state.olderCursor) && <button className="bots-older" disabled={paging || first === 0 && !online} onClick={() => void earlier()}>Load earlier messages</button>}
    {(first > 0 || last < state.entries.length || state.olderCursor) && <div className="bots-system-note">Showing messages {first + 1}–{last} of {state.entries.length} loaded. Earlier history remains available.</div>}
    {!online && state.cached && <div className="bots-system-note">Saved conversation. Reconnect for updates and work details not saved here.</div>}
    {state.error && <div className="bots-history-error" role="alert"><CloudOff size={22} aria-hidden="true" /><div><strong>Let’s try that again</strong><p>{state.error}</p><button disabled={!online} onClick={() => void timeline.refresh()}>Reload conversation</button></div></div>}
    {state.loading && !state.entries.length && <div className="bots-history-skeleton" role="status" aria-label="Loading conversation"><span /><span /><span /><span /></div>}
    {!state.loading && !state.error && !state.entries.length && <div className="bots-conversation-start"><span className="bots-start-icon"><MessageCircle size={26} strokeWidth={1.4} aria-hidden="true" /></span><h2>{bot.name}</h2><p>{bot.purpose || "What would you like to work on?"}</p></div>}
    {end === null && !groups.some((group) => group.kind === "message") && state.contextEntries.length > 0 && <section aria-label="Latest readable context">
      <p className="bots-system-note">Latest readable messages. Intervening work remains accessible through earlier history.</p>
      {state.contextEntries.map((entry) => <TimelineEntry key={historyKey(entry.turnId, entry.id)} entry={entry} timeline={timeline} attachments={state.attachments} download={download} />)}
    </section>}
    {groups.map((group) => {
      const entry = group.entries[0], key = historyKey(entry.turnId, entry.id);
      const body = () => group.entries.map((value) => <TimelineEntry key={historyKey(value.turnId, value.id)} entry={{ ...value, scheduled: false }} timeline={timeline} attachments={state.attachments} download={download} />);
      const summary = group.kind.startsWith("schedule:") ? `Scheduled run · ${entry.status} · ${group.entries.map((e) => e.item?.type === "agentMessage" ? e.item.text : "").filter(Boolean).at(-1)?.slice(0, 110) ?? entry.label}`
        : <><span>Work log</span><small>{group.entries.length} {group.entries.length === 1 ? "step" : "steps"}</small></>;
      return <Fragment key={key}>
        {state.gaps.filter((gap) => group.entries.some((entry) => gap.before === historyKey(entry.turnId, entry.id))).map((gap) => <div className="bots-system-note" key={gap.before}>
          Some messages between these pages are not loaded. <button disabled={!online || paging} onClick={() => {
            capture(); setPaging(true); void timeline.fillGap(gap).finally(() => setPaging(false));
          }}>Load messages in between</button></div>)}
        {group.kind === "message" ? <TimelineEntry entry={entry} timeline={timeline} attachments={state.attachments} download={download} />
          : <div data-history-key={key} style={{ position: "relative" }}>{group.entries.slice(1).map((value) => <span key={value.id} data-history-key={historyKey(value.turnId, value.id)} aria-hidden="true" style={{ position: "absolute", top: 0, height: 0, pointerEvents: "none" }} />)}<LazyDetails className={group.kind.startsWith("schedule:") ? "bots-turn is-scheduled" : "bots-activity"} summary={summary}>{body}</LazyDetails>{group.kind.startsWith("work:") && <ReturnedArtifacts linked={linkedArtifacts} attachments={state.attachments} itemIds={group.entries.map((value) => value.id)} botId={bot.id} />}</div>}
      </Fragment>;
    })}
    {last < state.entries.length && <button className="bots-older" onClick={() => { setEnd(Math.min(state.entries.length, last + PAGE)); saved.current = { anchor: null, offset: 0, following: false }; scroll.current?.scrollTo(0, 0); }}>Newer messages</button>}
    {downloadError && <p className="bots-error" role="alert">{downloadError}</p>}
    {children}
  </div></div>{showJump && <button className="bots-jump-latest" onClick={latest}><ArrowDown size={16} aria-hidden="true" />Latest messages</button>}</div>;
}
