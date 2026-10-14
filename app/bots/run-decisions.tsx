"use client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useEffect, useId, useRef, useState } from "react";
import { CalendarClock, RefreshCw } from "lucide-react";
import type { BotEvent, BotRun } from "../../lib/bots-types";
import { botsClient as client } from "./client";
import { useRunAction } from "./run-action";
import { hasCurrentRunDecision } from "./run-context";
import "./run-decisions.css";

const stamp = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Date unavailable";
type Page = { runs: BotRun[]; nextCursor: string | null };
const savedRun = (run: BotRun): BotRun => ({ id: run.id, botId: run.botId, scheduleId: run.scheduleId, title: run.title,
  status: run.status, scheduledAt: run.scheduledAt, startedAt: run.startedAt, finishedAt: run.finishedAt, error: null,
  decision: run.decision, activity: run.activity, executionLane: run.executionLane, laneId: run.laneId, threadId: run.threadId, turnId: run.turnId });

export function RunDecisionControls({ owner, botId, run, online, onConfirmed, allowNewActions = true }: {
  owner: string; botId: string; run: BotRun; online: boolean; onConfirmed: () => void; allowNewActions?: boolean;
}) {
  const action = useRunAction(owner, botId, `decision:${run.id}`);
  const formId = useId(), errorId = useId();
  const [rescheduling, setRescheduling] = useState(false), [at, setAt] = useState(""), [error, setError] = useState("");
  const decision = run.decision;
  const eligible = hasCurrentRunDecision(run);
  const confirmed = action.confirmation?.method === "runs.decide" && action.confirmation.params.expectedRevision === decision?.revision;
  const enabled = online && allowNewActions && action.ready && !action.busy && !action.intent && !confirmed && eligible;
  const choose = async (choice: "start" | "reschedule" | "cancel") => {
    if (!enabled || !decision || client.owner !== owner) return;
    const date = choice === "reschedule" ? new Date(at) : null;
    if (date && (!Number.isFinite(date.getTime()) || date.getTime() < Date.now() + 60_000 || date.getTime() > Date.now() + 366 * 86400_000)) {
      setError("Choose a time at least one minute ahead and within the next year."); return;
    }
    setError("");
    try {
      await action.perform("runs.decide", { runId: run.id, expectedRevision: decision.revision, choice, ...(date ? { at: date.toISOString() } : {}) });
      if (client.owner === owner) { setRescheduling(false); onConfirmed(); }
    } catch { /* Exact choice and ID remain in the origin-owned journal. */ }
  };
  if (!eligible && !action.intent && !action.error) return null;
  return <div className="bots-run-decision-controls">
    {action.intent ? <><p>A saved choice is awaiting confirmation. Check it before making another choice.</p><Button variant="outline" size="sm" type="button" disabled={!online || action.busy || !action.ready} onClick={() => void action.retry().then(() => { if (client.owner === owner) onConfirmed(); }).catch(() => {})}>{action.busy ? "Confirming…" : "Check saved choice"}</Button></> : confirmed && eligible ? <p role="status">Choice saved. Refresh status to see what happens next.<Button variant="outline" size="sm" type="button" disabled={!online} onClick={onConfirmed}>Refresh status</Button></p> : eligible ? <>
      <p>This start time was missed. Choose what happens to this occurrence.</p>
      <div className="bots-run-decision-buttons">
        <Button size="sm" type="button" disabled={!enabled} onClick={() => void choose("start")}>Start now</Button>
        <Button variant="outline" size="sm" type="button" disabled={!enabled} aria-expanded={rescheduling} aria-controls={rescheduling ? formId : undefined} onClick={() => setRescheduling(value => !value)}>Reschedule</Button>
        <Button variant="outline" size="sm" type="button" disabled={!enabled} onClick={() => void choose("cancel")}>Cancel this run</Button>
      </div>
      {rescheduling && <form id={formId} onSubmit={event => { event.preventDefault(); void choose("reschedule"); }}>
        <label>New start time <span>(your local time)</span><Input type="datetime-local" aria-invalid={!!error} aria-describedby={error ? errorId : undefined} aria-label="New start time in your local time" required value={at} disabled={!enabled} onChange={event => { setAt(event.target.value); setError(""); }} /></label>
        <Button size="sm" disabled={!enabled || !at} type="submit">Save new time</Button>
      </form>}
      <small>Start now still waits for capacity and paused-work controls. Reschedule and Cancel apply only to this occurrence.</small>
    </> : null}
    {(error || action.error) && <p id={errorId} role="alert" className="bots-run-decision-error">{error || action.error}</p>}
    {!action.ready && action.error && <Button variant="outline" size="sm" type="button" onClick={() => void action.refresh()}>Retry saving access</Button>}
  </div>;
}

/** Separate bounded discovery: overdue occurrences can be older than the
 * current history page. Keep server membership and cursor together. */
export function RunDecisions({ owner, botId, online }: { owner: string; botId: string; online: boolean }) {
  const key = `schedule-decisions:v1:${botId}`;
  const [page, setPage] = useState<Page>(() => client.owner === owner ? client.cache(key, { runs: [], nextCursor: null }) : { runs: [], nextCursor: null });
  const [cursor, setCursor] = useState<string | null>(null), [loadedCursor, setLoadedCursor] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState(""), [updated, setUpdated] = useState(false);
  const eventRevision = useRef(0);
  const pageIds = useRef(new Set(page.runs.map(run => run.id)));
  useEffect(() => {
    const event = (event: BotEvent) => {
      if (client.owner !== owner || event.botId !== botId || !["schedules", "run.state"].includes(event.type)) return;
      if (event.type === "run.state") {
        const run = (event.data as { run?: BotRun }).run;
        if (!run || run.botId !== botId || !pageIds.current.has(run.id) && !hasCurrentRunDecision(run)) return;
      }
      eventRevision.current++; setUpdated(true);
    };
    client.events.add(event); return () => { client.events.delete(event); };
  }, [owner, botId]);
  useEffect(() => {
    let canceled = false;
    if (online) void Promise.resolve().then(async () => {
      if (canceled || client.owner !== owner) return;
      const revision = eventRevision.current;
      setBusy(true);
      const result = await client.rpc<Page>("runs.decisions", botId, { cursor, limit: 5 }, undefined, { owner });
      if (canceled || client.owner !== owner) return;
      if (!Array.isArray(result.runs) || result.runs.length > 5 || result.runs.some(run => run.botId !== botId || !run.id || run.status !== "queued" || run.decision?.state !== "required") || new Set(result.runs.map(run => run.id)).size !== result.runs.length || result.nextCursor && result.nextCursor === cursor) throw Error("Pending choices could not be verified. Refresh them again.");
      // No live insertion/truncation ahead of an older cursor. A later event
      // leaves an explicit refresh cue; it is never evidence of action success.
      const next = { runs: result.runs.map(savedRun), nextCursor: result.nextCursor };
      pageIds.current = new Set(next.runs.map(run => run.id));
      setPage(next); setLoadedCursor(cursor); setError("");
      if (!cursor) client.save(key, next);
      if (revision === eventRevision.current) setUpdated(false);
    }).catch(reason => { if (!canceled && client.owner === owner) setError(reason instanceof Error ? reason.message : "Pending choices could not be loaded."); })
      .finally(() => { if (!canceled) setBusy(false); });
    return () => { canceled = true; };
  }, [owner, botId, key, cursor, attempt, online]);
  const refresh = () => { setCursor(null); setAttempt(value => value + 1); };
  if (!page.runs.length && !error && !updated && !busy) return null;
  return <section className="bots-run-decisions" aria-label="Scheduled work waiting for your choice">
    <header><CalendarClock size={18} aria-hidden="true" /><h3>Waiting for your choice</h3><Button variant="ghost" size="icon" type="button" disabled={!online || busy} onClick={refresh} aria-label="Refresh pending choices"><RefreshCw size={15} /></Button></header>
    {!online && <p>Saved choices. Reconnect before deciding.</p>}
    {updated && <p>Scheduled work changed.<Button variant="outline" size="sm" type="button" disabled={!online || busy} onClick={refresh}>Refresh choices</Button></p>}
    {page.runs.map(run => <article key={run.id}><h4>{run.title}</h4><p>Scheduled {stamp(run.decision!.scheduledAt)}{run.decision?.notBefore && <><br />New time {stamp(run.decision.notBefore)}</>}</p><RunDecisionControls owner={owner} botId={botId} run={run} online={online} allowNewActions={!busy && !updated && !error} onConfirmed={refresh} /></article>)}
    {error && <p role="alert">{error}<Button variant="outline" size="sm" type="button" disabled={!online || busy} onClick={refresh}>Retry</Button></p>}
    {online && busy && <p role="status">Updating pending choices…</p>}
    <nav aria-label="Pending choice pages">{cursor && <Button variant="outline" size="sm" type="button" disabled={!online || busy} onClick={refresh}>First choices</Button>}{page.nextCursor && <Button variant="outline" size="sm" type="button" disabled={!online || busy || cursor !== loadedCursor} onClick={() => setCursor(page.nextCursor)}>More choices</Button>}</nav>
  </section>;
}
