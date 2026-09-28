"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Clock3, RefreshCw } from "lucide-react";
import type { BotEvent, BotRun, BotRunTurnPage } from "../../lib/bots-types";
import { botsClient as client } from "./client";

const date = (value: string | null) => value && Number.isFinite(Date.parse(value))
  ? new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Date unavailable";
const status: Record<string, string> = { completed: "Finished", running: "In progress", starting: "Starting", dispatching: "Starting", uncertain: "Needs review", failed: "Needs attention", interrupted: "Interrupted" };
type Saved = { botId: string; runId: string; page: BotRunTurnPage };
// Disposable metadata only: eight first pages, no native bodies or drafts.
function cachePage(key: string, botId: string, runId: string, page: BotRunTurnPage) {
  const compact = { ...page, turns: page.turns.map(turn => ({ ...turn, error: turn.error?.slice(0, 512) ?? null })) };
  client.save(key, [{ botId, runId, page: compact }, ...client.cache<Saved[]>(key, []).filter(value => value.botId !== botId || value.runId !== runId)].slice(0, 8));
}

export function RunTurnPicker({ owner, botId, runId, primary, selected, online, onSelect }: {
  owner: string; botId: string; runId: string; primary?: BotRun; selected: string; online: boolean; onSelect: (turnId: string) => void;
}) {
  const key = "activity-turns:v1";
  const [page, setPage] = useState<BotRunTurnPage | null>(() => client.owner === owner ? client.cache<Saved[]>(key, []).find(value => value.botId === botId && value.runId === runId)?.page ?? null : null);
  const [loadedCursor, setLoadedCursor] = useState<string | null>(null);
  const [cursors, setCursors] = useState<(string | null)[]>([null]), [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [changed, setChanged] = useState(false), [attempt, setAttempt] = useState(0);
  const disclosure = useRef<HTMLDetailsElement>(null);
  const cursor = cursors[index];
  useEffect(() => {
    let canceled = false;
    if (!online || client.owner !== owner) {
      // A canceled online read cannot settle its loading state. Clear only
      // this owner's presentation, without changing cached data or retrying.
      void Promise.resolve().then(() => { if (!canceled && client.owner === owner) setBusy(false); });
      return () => { canceled = true; };
    }
    void Promise.resolve().then(async () => {
      if (canceled) return;
      setBusy(true); setError("");
      const result = await client.rpc<BotRunTurnPage>("runs.turns", botId, { runId, cursor, limit: 25 }, undefined, { owner });
      if (canceled || client.owner !== owner) return;
      if (!Array.isArray(result.turns) || result.turns.length > 25 || result.turns.some(turn => turn.botId !== botId || turn.runId !== runId)) throw Error("Follow-up history could not be verified. Refresh this run.");
      if (result.nextCursor && result.nextCursor === cursor) throw Error("Follow-up history did not advance. Refresh this run.");
      setPage(result); setLoadedCursor(cursor);
      if (!cursor) { cachePage(key, botId, runId, result); setChanged(false); }
    }).catch(reason => { if (!canceled && client.owner === owner) setError(reason instanceof Error ? reason.message : "Follow-ups could not be loaded."); })
      .finally(() => { if (!canceled && client.owner === owner) setBusy(false); });
    return () => { canceled = true; };
  }, [owner, botId, runId, online, key, cursor, attempt]);
  useEffect(() => {
    // Never move an open reader/page when follow-ups arrive. Refresh is explicit
    // because stable receipt-ID ordering can insert a new row before this page.
    const event = (event: BotEvent) => { if (event.type === "schedules" && event.botId === botId && client.owner === owner) setChanged(true); };
    client.events.add(event); return () => { client.events.delete(event); };
  }, [botId, owner]);
  const select = (turnId: string) => { onSelect(turnId); if (disclosure.current) disclosure.current.open = false; };
  const refresh = () => { setIndex(0); setCursors([null]); setAttempt(value => value + 1); };
  return <details className="bots-run-turns" ref={disclosure}>
    <summary><Clock3 size={16} /><span>Original run &amp; follow-ups</span>{changed && <span className="bots-run-turns-updated">Updated</span>}</summary>
    <div className="bots-run-turns-body">
      <p>Open one part at a time. Each keeps its full recorded detail.</p>
      {!online && <p>Saved follow-ups. Connect for updates and full detail.</p>}
      {error && <p role="alert">{error} The original run and any open detail remain available.</p>}
      {primary?.turnId ? <button className="bots-run-turn-choice" aria-current={selected === primary.turnId ? "true" : undefined} onClick={() => select(primary.turnId!)}><span><strong>Original run</strong><time>{date(primary.startedAt ?? primary.scheduledAt)}</time></span><span>{status[primary.status] ?? "Recorded"}</span><ArrowRight size={15} /></button> : <p>The original run can be found in All activity.</p>}
      {page?.turns.map(turn => <div key={turn.id}>
        <button className="bots-run-turn-choice" disabled={!turn.turnId} aria-current={selected === turn.turnId ? "true" : undefined} onClick={() => turn.turnId && select(turn.turnId)}><span><strong>Follow-up</strong><time>{date(turn.createdAt)}</time></span><span>{status[turn.status] ?? "Recorded"}</span><ArrowRight size={15} /></button>
        {turn.error && <p className="bots-run-turn-error">{turn.error}</p>}
        {!turn.turnId && <p>Delivery has not been confirmed. Recorded detail will appear when it is available.</p>}
      </div>)}
      {!page?.turns.length && !busy && !error && online && <p>No follow-ups recorded.</p>}
      <nav aria-label="Follow-up pages">
        <button disabled={!online || busy} onClick={refresh}><RefreshCw size={14} />{error ? "Retry follow-ups" : changed ? "Show updates" : "Refresh"}</button>
        {index > 0 && <button disabled={!online || busy} onClick={() => setIndex(value => value - 1)}><ArrowLeft size={14} />Previous</button>}
        {page?.nextCursor && <button disabled={!online || busy || loadedCursor !== cursor} onClick={() => { setCursors(current => [...current.slice(0, index + 1), page.nextCursor]); setIndex(value => value + 1); }}>More follow-ups<ArrowRight size={14} /></button>}
      </nav>
      <p role="status">{busy ? "Loading follow-ups…" : page ? `${page.turns.length} ${page.turns.length === 1 ? "follow-up" : "follow-ups"} on ${loadedCursor === cursor ? "this" : "the last loaded"} page` : ""}</p>
    </div>
  </details>;
}
