"use client";
import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { ArrowLeft, ArrowRight, CheckCircle2, Clock3, CalendarDays, CircleAlert, LoaderCircle, RefreshCw, X } from "lucide-react";
import type { Bot, BotAttachment, BotRun, BotRunPage, BotSchedule } from "../../lib/bots-types";
import type { HistoryPage, HistoryResponse } from "../../lib/bot-history-view";
import { botsClient } from "./client";
import { TimelineEntry } from "./timeline";
import { ReturnedArtifacts } from "./returned-artifact";
import { getBotTimeline } from "./use-timeline";
import type { ActivityTarget } from "./conversation-activity";

const validDate = (value: string | null) => value && Number.isFinite(Date.parse(value)) ? new Date(value) : null;
const stamp = (value: string | null) => validDate(value)?.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) ?? "Date unavailable";
const day = (value: string) => validDate(value)?.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" }) ?? "Date unavailable";
const labels: Record<string, string> = { queued: "Queued", starting: "Starting", running: "In progress", completed: "Finished", failed: "Needs attention", uncertain: "Needs review", interrupted: "Interrupted", acknowledged: "Reviewed", cancelled: "Cancelled", skipped: "Skipped" };
const needsAttention = (run: BotRun) => ["failed", "uncertain", "interrupted"].includes(run.status);
// Deliberately omit native prompts/private internals from this disposable cache.
const compactRun = (run: BotRun): BotRun => ({ id: run.id, botId: run.botId, scheduleId: run.scheduleId, title: run.title,
  status: run.status, scheduledAt: run.scheduledAt, startedAt: run.startedAt, finishedAt: run.finishedAt, error: run.error, turnId: run.turnId });
function mergeRuns(old: BotRun[], incoming: BotRun[]) {
  const values = new Map(old.map(run => [run.id, run]));
  for (const run of incoming) values.set(run.id, compactRun(run));
  return [...values.values()].sort((a, b) => (Date.parse(b.scheduledAt) || 0) - (Date.parse(a.scheduledAt) || 0) || b.id.localeCompare(a.id));
}

export function RunHistory({ bot, schedules, attachments, online, onClose, download, initialTarget, recentRuns = [] }:
  { bot: Bot; schedules: BotSchedule[]; attachments: BotAttachment[]; online: boolean;
    onClose: () => void; download: (id: string) => void; initialTarget?: ActivityTarget | null; recentRuns?: BotRun[] }) {
  const owner = botsClient.owner, cacheKey = `activity:${bot.id}`;
  const timeline = useMemo(() => getBotTimeline(owner, bot.id), [owner, bot.id]);
  const [saved] = useState(() => botsClient.cache<{ runs: BotRun[]; cursor: string | null } | null>(cacheKey, null));
  const [runs, setRuns] = useState<BotRun[]>(() => mergeRuns(saved?.runs ?? [], recentRuns).slice(0, 25));
  const [cursor, setCursor] = useState<string | null>(saved?.cursor ?? null);
  const [listBusy, setListBusy] = useState(false), [detailBusy, setDetailBusy] = useState(false), [actionBusy, setActionBusy] = useState(false), [error, setError] = useState("");
  const busy = online && (listBusy || detailBusy) || actionBusy;
  const [filter, setFilter] = useState("all");
  const [runCursors, setRunCursors] = useState<(string | null)[]>([null]), [runPage, setRunPage] = useState(0);
  const [newActivity, setNewActivity] = useState(false);
  const [target, setTarget] = useState<ActivityTarget | null>(initialTarget ?? null);
  const [transcript, setTranscript] = useState<HistoryPage | null>(null);
  const [pageCursors, setPageCursors] = useState<(string | null)[]>([null]);
  const [detailPage, setDetailPage] = useState(0);
  const active = useRef(true), generation = useRef(0), listRequest = useRef(false), refreshAgain = useRef(false), runPageRef = useRef(0), targetRef = useRef(target);
  const listEpoch = useRef(0), currentListCursor = useRef<string | null>(null);
  useEffect(() => { runPageRef.current = runPage; targetRef.current = target; }, [runPage, target]);
  const body = useRef<HTMLDivElement>(null), savedScroll = useRef(0);
  const valid = useCallback(() => active.current && botsClient.owner === owner, [owner]);
  const load = useCallback(async (next: string | null) => {
    if (!online || !valid()) return;
    if (listRequest.current) { refreshAgain.current = true; return; }
    const request = listEpoch.current;
    listRequest.current = true; setListBusy(true); if (!targetRef.current) setError("");
    try {
      const page = await botsClient.rpc<BotRunPage>("runs.page", bot.id, { cursor: next, limit: 25 }, undefined, { owner });
      if (!valid() || request !== listEpoch.current) return;
      const values = page.runs.map(compactRun);
      setRuns(values); setCursor(page.nextCursor);
      if (!next) { botsClient.save(cacheKey, { runs: values, cursor: page.nextCursor }); setNewActivity(false); }
    } catch (reason) { if (valid() && request === listEpoch.current && !targetRef.current) setError(reason instanceof Error ? reason.message : "Activity could not be loaded."); }
    finally { listRequest.current = false; if (valid()) setListBusy(false); }
  }, [bot.id, cacheKey, online, owner, valid]);
  useEffect(() => {
    active.current = true;
    listEpoch.current++;
    void Promise.resolve().then(() => load(currentListCursor.current));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const event = (value: { type: string; botId?: string }) => {
      if (value.type !== "schedules" || value.botId && value.botId !== bot.id) return;
      timer ??= setTimeout(() => {
        timer = undefined;
        if (runPageRef.current || targetRef.current) setNewActivity(true);
        else void load(null);
      }, 250);
    };
    botsClient.events.add(event);
    return () => { active.current = false; if (timer) clearTimeout(timer); botsClient.events.delete(event); };
  }, [bot.id, load]);
  useEffect(() => { if (!listBusy && refreshAgain.current) { refreshAgain.current = false; void Promise.resolve().then(() => load(currentListCursor.current)); } }, [listBusy, load]);
  useEffect(() => {
    if (!target || !online) return;
    const request = ++generation.current;
    let canceled = false;
    void Promise.resolve().then(async () => {
      if (canceled || !valid()) return;
      setDetailBusy(true); setError(""); setTranscript(null);
      const result = await botsClient.rpc<HistoryResponse>("history.view", bot.id, { turnId: target.turnId, cursor: pageCursors[detailPage] }, undefined, { owner });
      if (canceled || !valid() || request !== generation.current) return;
      if (result.kind === "page") { setTranscript(result); if (body.current) body.current.scrollTop = 0; }
    }).catch(reason => { if (!canceled && valid() && request === generation.current) setError(reason instanceof Error ? reason.message : "This run could not be opened."); })
      .finally(() => { if (!canceled && valid() && request === generation.current) setDetailBusy(false); });
    return () => { canceled = true; };
  }, [bot.id, detailPage, online, owner, pageCursors, target, valid]);
  const open = (run: BotRun) => {
    if (!run.turnId) return;
    savedScroll.current = body.current?.scrollTop ?? 0;
    setPageCursors([null]); setDetailPage(0); setTarget({ turnId: run.turnId, runId: run.id });
  };
  const back = () => {
    generation.current++; setTarget(null); setTranscript(null); setError(""); setDetailBusy(false);
    requestAnimationFrame(() => { if (body.current) body.current.scrollTop = savedScroll.current; });
  };
  const firstPage = () => { setRunCursors([null]); setRunPage(0); runPageRef.current = 0; currentListCursor.current = null; void load(null); };
  const runPageTo = (index: number, next: string | null) => {
    if (busy) return;
    setRunCursors(current => index >= current.length ? [...current, next] : current);
    setRunPage(index); runPageRef.current = index; currentListCursor.current = next; void load(next);
    if (body.current) body.current.scrollTop = 0;
  };
  const acknowledge = async (run: BotRun) => {
    setActionBusy(true); setError("");
    try {
      await botsClient.rpc("runs.acknowledge", bot.id, { id: run.id }, `run-review:${run.id}`, { owner });
      if (valid()) await load(runCursors[runPage]);
    } catch (reason) { if (valid()) setError(reason instanceof Error ? reason.message : "The review could not be saved. Retry the same review."); }
    finally { if (valid()) setActionBusy(false); }
  };
  const groups = useMemo(() => {
    const groups = new Map<string, BotRun[]>();
    for (const run of runs.filter(run => filter === "all" || needsAttention(run))) {
      const title = day(run.scheduledAt); groups.set(title, [...(groups.get(title) ?? []), run]);
    }
    return [...groups];
  }, [filter, runs]);
  const selectedRun = runs.find(run => run.id === target?.runId || run.turnId === target?.turnId);
  const linked = useMemo(() => new Set(transcript?.entries.flatMap(entry => entry.item?.type === "agentMessage" ? [...entry.item.text.matchAll(/\]\(<?bot-artifact:([^\s)>]+)/g)].map(match => match[1]) : []) ?? []), [transcript]);
  return <div className="bots-modal-backdrop bots-activity-backdrop" onClick={onClose}>
    <section className="bots-run-library" role="dialog" aria-modal="true" aria-label={`${bot.name} activity`} onClick={event => event.stopPropagation()}>
      <header className="bots-run-library-heading">
        <div className="bots-run-heading-mark"><Clock3 size={22} aria-hidden="true" /></div>
        <div><h2>Activity</h2><p>{bot.name}</p></div>
        <button className="bots-icon-button" aria-label="Close activity and return to conversation" onClick={onClose}><X size={20} /></button>
      </header>
      <div className="bots-run-library-body" ref={body}>
        {error && <div className="bots-run-notice is-error" role="alert"><CircleAlert size={18} /><div><p>{error}</p><button disabled={!online || busy} onClick={() => target ? setPageCursors(current => [...current]) : void load(currentListCursor.current)}>Try again</button></div></div>}
        {target ? <>
          <button className="bots-run-back" onClick={back}><ArrowLeft size={16} />All activity</button>
          <div className="bots-run-detail-title"><span>Scheduled run</span><h3>{selectedRun?.title ?? "Earlier activity"}</h3><p>{selectedRun ? stamp(selectedRun.scheduledAt) : "Full recorded conversation"}</p></div>
          {!online && <div className="bots-run-notice"><CircleAlert size={18} /><p>Connect to open this run. Your saved conversation is still available.</p></div>}
          <div className="bots-run-transcript">
            {transcript?.entries.map(entry => <TimelineEntry key={`${entry.turnId}:${entry.id}`} entry={{ ...entry, scheduled: false }} timeline={timeline} attachments={transcript.attachments.length ? transcript.attachments : attachments} download={download} />)}
            {transcript && <ReturnedArtifacts botId={bot.id} turnId={target.turnId} attachments={transcript.attachments} linked={linked} />}
          </div>
          {transcript && !transcript.entries.length && <p className="bots-muted">No messages were recorded in this part of the run.</p>}
          <nav className="bots-run-pagination" aria-label="Run transcript pages">
            {transcript?.olderCursor && <button disabled={!online || busy} onClick={() => { setPageCursors(current => [...current.slice(0, detailPage + 1), transcript.olderCursor]); setDetailPage(page => page + 1); }}><ArrowLeft size={15} />Earlier detail</button>}
            {detailPage > 0 && <button disabled={!online || busy} onClick={() => setDetailPage(page => page - 1)}>Newer detail<ArrowRight size={15} /></button>}
          </nav>
        </> : <>
          <div className="bots-run-intro"><h3>Scheduled activity</h3><p>Review scheduled runs, their progress, and recorded results.</p></div>
          {!online && <div className="bots-run-notice"><Clock3 size={18} /><p>Saved activity. Reconnect for updates and full run details.</p></div>}
          {schedules.some(schedule => schedule.enabled && schedule.nextRunAt) && <section className="bots-run-upcoming" aria-label="Coming up"><CalendarDays size={18} /><div><strong>Coming up</strong>{schedules.filter(schedule => schedule.enabled && schedule.nextRunAt).sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!)).slice(0, 3).map(schedule => <p key={schedule.id}><span>{schedule.title}</span><time>{stamp(schedule.nextRunAt)}</time></p>)}</div></section>}
          <div className="bots-run-tools"><div role="group" aria-label="Filter activity"><button aria-pressed={filter === "all"} onClick={() => setFilter("all")}>All runs</button><button aria-pressed={filter === "attention"} onClick={() => setFilter("attention")}>Needs attention</button></div><button className="bots-icon-button" aria-label="Refresh activity" disabled={busy || !online} onClick={firstPage}><RefreshCw size={16} /></button></div>
          {newActivity && <button className="bots-run-back" onClick={firstPage}>New activity · Show recent runs<ArrowRight size={15} /></button>}
          {runPage > 0 && <button className="bots-run-back" disabled={!online || busy} onClick={() => runPageTo(runPage - 1, runCursors[runPage - 1])}><ArrowLeft size={15} />Newer activity</button>}
          {groups.map(([date, values]) => <section className="bots-run-day" key={date}><h3>{date}</h3>{values.map(run => <article className={`bots-run-card ${needsAttention(run) ? "needs-attention" : ""}`} key={run.id}>
            <div className="bots-run-card-icon">{["running", "starting"].includes(run.status) ? <LoaderCircle size={18} className="bots-spin" /> : needsAttention(run) ? <CircleAlert size={18} /> : run.status === "completed" ? <CheckCircle2 size={18} /> : <Clock3 size={18} />}</div>
            <div className="bots-run-card-content"><div className="bots-run-card-title"><h4>{run.title}</h4><span className={`bots-run-status is-${run.status}`}>{labels[run.status] ?? "Recorded"}</span></div><p><time>{stamp(run.startedAt ?? run.scheduledAt)}</time>{run.finishedAt && <span> · Finished {validDate(run.finishedAt)?.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</span>}</p>{run.error && <p className="bots-run-error-text">{run.error}</p>}<div className="bots-run-card-actions">{run.turnId ? <button disabled={!online || busy} onClick={() => open(run)}>Open run<ArrowRight size={14} /></button> : <span>{run.status === "queued" ? "Waiting to start" : "No recorded conversation"}</span>}{run.status === "uncertain" && <button disabled={!online || busy} onClick={() => void acknowledge(run)}>I reviewed this run</button>}</div></div>
          </article>)}</section>)}
          {!groups.length && !busy && !error && <div className="bots-run-empty"><Clock3 size={30} strokeWidth={1.4} /><h3>{filter === "attention" ? "Nothing needs your attention here" : "A quieter kind of history"}</h3><p>{filter === "attention" ? "No issues on this page. You can also browse earlier activity." : "Your scheduled runs will appear here, with their progress and results."}</p></div>}
          <p className="bots-run-page-note">{runs.length} {runs.length === 1 ? "run" : "runs"} on this page</p>
          {cursor && <button className="bots-run-load" disabled={!online || busy} onClick={() => runPageTo(runPage + 1, cursor)}>Earlier activity<ArrowLeft size={15} /></button>}
        </>}
        {busy && <p className="bots-run-loading" role="status"><LoaderCircle size={16} className="bots-spin" />{target ? "Opening this run…" : "Updating activity…"}</p>}
      </div>
      <footer><button onClick={onClose}><MessagesLabel />Back to conversation</button><span>Scheduled runs and recorded results.</span></footer>
    </section>
  </div>;
}
function MessagesLabel() { return <ArrowLeft size={15} aria-hidden="true" />; }
