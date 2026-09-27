"use client";
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { Bot, BotAttachment } from "../../lib/bots-types";
import { historyKey, type HistoryEntry } from "../../lib/bot-history-view";
import type { BotTimeline } from "./timeline-controller";
import { useBotTimeline } from "./use-timeline";
import { botsClient } from "./client";
import { BotMessage } from "./message";
import { LazyDetails } from "./lazy-details";

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
  // Deferred entries mount only after the user opens their disclosure.
  useEffect(() => { let active = true; if (!entry.item) queueMicrotask(() => { if (active) void load(); }); return () => { active = false; }; }, [entry.item, load]);
  const item = full ?? entry.item;
  return <>{refreshing && <small>Refreshing live full detail…</small>}{item && <BotMessage item={item} botId={timeline.botId} attachments={attachments} download={download} inWorkLog />}
    {!entry.complete && <div className="bots-detail-status">
      <button disabled={loading} onClick={() => void load()}>{loading ? "Loading complete item…" : full ? "Refresh full detail" : item ? "Continue · load complete message" : "Load full detail"}</button>
      {full && !botsClient.online && <small>Saved full detail; changes since this copy may be missing.</small>}
      {!full && <small>{item ? "Message preview. The complete message remains in native history." : "Full tool output remains in native history."}</small>}
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
  const restored = useRef(false), following = useRef(true), saved = useRef(state.position);
  const [downloadError, setDownloadError] = useState("");
  const [end, setEnd] = useState<number | null>(null), [paging, setPaging] = useState(false);
  const last = end === null ? state.entries.length : Math.min(end, state.entries.length), first = Math.max(0, last - PAGE);
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
  const download = useCallback((id: string) => {
    setDownloadError("");
    void botsClient.download(bot.id, id).then(({ blob, name }) => {
      const url = URL.createObjectURL(blob), a = document.createElement("a"); a.href = url; a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }).catch((error) => setDownloadError(String(error)));
  }, [bot.id]);
  const capture = useCallback(() => {
    const element = scroll.current; if (!element) return;
    following.current = end === null && element.scrollHeight - element.scrollTop - element.clientHeight < 100;
    const top = element.getBoundingClientRect().top;
    const anchor = [...element.querySelectorAll<HTMLElement>("[data-history-key]")].find((e) => e.getBoundingClientRect().bottom >= top);
    saved.current = { anchor: anchor?.dataset.historyKey ?? null, offset: anchor ? anchor.getBoundingClientRect().top - top : 0, following: following.current };
    timeline.position(saved.current);
  }, [timeline, end]);
  const restore = useCallback(() => {
    const element = scroll.current; if (!element) return;
    element.scrollLeft = 0;
    if (following.current) element.scrollTop = element.scrollHeight;
    else {
      const anchor = [...element.querySelectorAll<HTMLElement>("[data-history-key]")].find((e) => e.dataset.historyKey === saved.current.anchor);
      if (anchor) element.scrollTop += anchor.getBoundingClientRect().top - element.getBoundingClientRect().top - saved.current.offset;
    }
  }, []);
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
    const observer = new ResizeObserver(restore); if (content.current) observer.observe(content.current);
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
  const latest = () => { following.current = true; saved.current = { anchor: null, offset: 0, following: true }; timeline.position(saved.current); setEnd(null); requestAnimationFrame(restore); };
  return <><div className="bots-messages" ref={scroll} onScroll={capture}><div ref={content}>
    {(first > 0 || state.olderCursor) && <button className="bots-older" disabled={paging || first === 0 && !online} onClick={() => void earlier()}>Load earlier messages</button>}
    {(first > 0 || last < state.entries.length || state.olderCursor) && <div className="bots-system-note">Showing messages {first + 1}–{last} of {state.entries.length} loaded. Earlier history remains available.</div>}
    {!online && state.cached && <div className="bots-system-note">Saved recent conversation. Deferred details and newer messages need a connection.</div>}
    {state.error && <div className="bots-error" role="alert">{state.error} <button disabled={!online} onClick={() => void timeline.refresh()}>Retry history</button></div>}
    {state.loading && !state.entries.length && <div className="bots-system-note">Loading conversation…</div>}
    {!state.loading && !state.entries.length && <div className="bots-conversation-start"><h2>{bot.name}</h2><p>{bot.purpose || "What would you like to work on?"}</p></div>}
    {end === null && !groups.some((group) => group.kind === "message") && state.contextEntries.length > 0 && <section aria-label="Latest readable context">
      <p className="bots-system-note">Latest readable messages. Intervening work remains accessible through earlier history.</p>
      {state.contextEntries.map((entry) => <TimelineEntry key={historyKey(entry.turnId, entry.id)} entry={entry} timeline={timeline} attachments={state.attachments} download={download} />)}
    </section>}
    {groups.map((group) => {
      const entry = group.entries[0], key = historyKey(entry.turnId, entry.id);
      const body = () => group.entries.map((value) => <TimelineEntry key={historyKey(value.turnId, value.id)} entry={{ ...value, scheduled: false }} timeline={timeline} attachments={state.attachments} download={download} />);
      const summary = group.kind.startsWith("schedule:") ? `Scheduled run · ${entry.status} · ${group.entries.map((e) => e.item?.type === "agentMessage" ? e.item.text : "").filter(Boolean).at(-1)?.slice(0, 110) ?? entry.label}`
        : `Work log · ${group.entries.length} steps`;
      return <Fragment key={key}>
        {state.gaps.filter((gap) => group.entries.some((entry) => gap.before === historyKey(entry.turnId, entry.id))).map((gap) => <div className="bots-system-note" key={gap.before}>
          Messages between this page and the saved older copy have not loaded. <button disabled={!online || paging} onClick={() => {
            capture(); setPaging(true); void timeline.fillGap(gap).finally(() => setPaging(false));
          }}>Load missing interval</button></div>)}
        {group.kind === "message" ? <TimelineEntry entry={entry} timeline={timeline} attachments={state.attachments} download={download} />
          : <div data-history-key={key} style={{ position: "relative" }}>{group.entries.slice(1).map((value) => <span key={value.id} data-history-key={historyKey(value.turnId, value.id)} aria-hidden="true" style={{ position: "absolute", top: 0, height: 0, pointerEvents: "none" }} />)}<LazyDetails className={group.kind.startsWith("schedule:") ? "bots-turn is-scheduled" : "bots-activity"} summary={summary}>{body}</LazyDetails></div>}
      </Fragment>;
    })}
    {last < state.entries.length && <button className="bots-older" onClick={() => { setEnd(Math.min(state.entries.length, last + PAGE)); saved.current = { anchor: null, offset: 0, following: false }; scroll.current?.scrollTo(0, 0); }}>Newer messages</button>}
    <LazyDetails summary="Files and artifacts">{() => <ArtifactList botId={bot.id} online={online} download={download} cached={state.attachments} />}</LazyDetails>
    {downloadError && <p className="bots-error" role="alert">{downloadError}</p>}
    {children}
  </div></div><button className="bots-jump-latest" onClick={latest}>Jump to latest ↓</button></>;
}

function ArtifactList({ botId, online, download, cached }: { botId: string; online: boolean; download: (id: string) => void; cached: BotAttachment[] }) {
  const [page, setPage] = useState<BotAttachment[]>(cached.filter((a) => (a as BotAttachment & { artifact?: boolean }).artifact).slice(-20));
  const [cursor, setCursor] = useState<string | null>(null), [error, setError] = useState("");
  const owner = botsClient.owner;
  const load = useCallback(async (cursor: string | null) => {
    try {
      const result = await botsClient.rpc<{ attachments: BotAttachment[]; nextCursor: string | null }>("history.attachments", botId, { cursor });
      if (botsClient.owner === owner) { setPage(result.attachments); setCursor(result.nextCursor); }
    } catch (e) { setError(String(e)); }
  }, [botId, owner]);
  useEffect(() => { let active = true; if (online) queueMicrotask(() => { if (active) void load(null); }); return () => { active = false; }; }, [online, load]);
  return <>{page.map((file) => <button className="bots-artifact-link" key={file.id} disabled={!online} onClick={() => download(file.id)}>{file.name}</button>)}
    {!online && <p>Saved references shown. Connect to list and download files.</p>}
    {cursor && <button disabled={!online} onClick={() => void load(cursor)}>More files</button>}
    {error && <p role="alert">{error}</p>}</>;
}
