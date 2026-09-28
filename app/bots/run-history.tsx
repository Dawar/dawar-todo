"use client";
import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { ArrowLeft, ArrowRight, CheckCircle2, Clock3, CalendarDays, CircleAlert, LoaderCircle, RefreshCw, X } from "lucide-react";
import type { Bot, BotAttachment, BotRun, BotRunPage, BotSchedule, BotEvent, BotRunStateEvent } from "../../lib/bots-types";
import type { HistoryPage, HistoryResponse } from "../../lib/bot-history-view";
import { botsClient } from "./client";
import { TimelineEntry } from "./timeline";
import { RunTurnPicker } from "./run-turn-picker";
import { ReturnedArtifacts } from "./returned-artifact";
import { updateRunPage } from "./run-page-events";
import { useRunScroll } from "./use-run-scroll";
import { RunComposer } from "./run-composer";
import { RunQuestions } from "./run-questions";
import { RunControls, StopAll } from "./run-controls";
import { RunTranscript } from "./run-transcript";
import { savedRunPage, saveRunPage, verifyRunPage } from "./run-history-reader";
import { getBotTimeline } from "./use-timeline";
import type { ActivityTarget } from "./conversation-activity";

const validDate = (value: string | null) => value && Number.isFinite(Date.parse(value)) ? new Date(value) : null;
const stamp = (value: string | null) => validDate(value)?.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) ?? "Date unavailable";
const day = (value: string) => validDate(value)?.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" }) ?? "Date unavailable";
const labels: Record<string, string> = { queued: "Queued", starting: "Starting", running: "In progress", completed: "Finished", failed: "Needs attention", uncertain: "Needs review", interrupted: "Interrupted", acknowledged: "Reviewed", cancelled: "Cancelled", skipped: "Skipped" };
const needsAttention = (run: BotRun) => ["failed", "uncertain", "interrupted"].includes(run.status) || run.activity?.state === "waiting-input" || run.activity?.state === "uncertain";
// Deliberately omit native prompts/private internals from this disposable cache.
const compactRun = (run: BotRun): BotRun => ({ id: run.id, botId: run.botId, scheduleId: run.scheduleId, title: run.title,
  executionLane: run.executionLane, laneId: run.laneId, threadId: run.threadId, activity: run.activity, status: run.status, scheduledAt: run.scheduledAt, startedAt: run.startedAt, finishedAt: run.finishedAt, error: run.error, turnId: run.turnId });
function mergeRuns(old: BotRun[], incoming: BotRun[]) {
  const values = new Map(old.map(run => [run.id, run]));
  for (const run of incoming) values.set(run.id, compactRun(run));
  return [...values.values()].sort((a, b) => (Date.parse(b.scheduledAt) || 0) - (Date.parse(a.scheduledAt) || 0) || b.id.localeCompare(a.id));
}

export function RunHistory({ bot, schedules, attachments, online, onClose, download, initialTarget, recentRuns = [] }:
  { bot: Bot; schedules: BotSchedule[]; attachments: BotAttachment[]; online: boolean;
    onClose: () => void; download: (id: string) => void; initialTarget?: ActivityTarget | null; recentRuns?: BotRun[] }) {
  const lanes = botsClient.snapshot?.capabilities?.backgroundRunLanes === 1;
  const owner = botsClient.owner, cacheKey = `activity:${bot.id}`;
  const timeline = useMemo(() => getBotTimeline(owner, bot.id), [owner, bot.id]);
  const [saved] = useState(() => botsClient.cache<{ runs: BotRun[]; cursor: string | null } | null>(cacheKey, null));
  const [runs, setRuns] = useState<BotRun[]>(() => mergeRuns(saved?.runs ?? [], recentRuns).slice(0, 25));
  const [cursor, setCursor] = useState<string | null>(saved?.cursor ?? null);
  const [listBusy, setListBusy] = useState(false), [detailBusy, setDetailBusy] = useState(false), [actionBusy, setActionBusy] = useState(false), [error, setError] = useState("");
  const [reviewError, setReviewError] = useState<{run: BotRun; message: string} | null>(null);
  const busy = online && (listBusy || detailBusy) || actionBusy;
  const runEvents = useRef(new Map<string, BotRunStateEvent>());
  const [filter, setFilter] = useState("all");
  const [runCursors, setRunCursors] = useState<(string | null)[]>([null]), [runPage, setRunPage] = useState(0);
  const [newActivity, setNewActivity] = useState(false);
  const [target, setTarget] = useState<ActivityTarget | null>(initialTarget ?? null);
  const [transcript, setTranscript] = useState<HistoryPage | null>(null);
  const [pageCursors, setPageCursors] = useState<(string | null)[]>([null]);
  const [detailPage, setDetailPage] = useState(0);
  const actionRequest = useRef(false);
  const active = useRef(true), generation = useRef(0), listRequest = useRef(false), refreshAgain = useRef(false), runPageRef = useRef(0), targetRef = useRef(target);
  const listEpoch = useRef(0), currentListCursor = useRef<string | null>(null);
  useEffect(() => { runPageRef.current = runPage; targetRef.current = target; }, [runPage, target]);
  const detailIdentity = useRef("");
  const body = useRef<HTMLDivElement>(null), savedScroll = useRef(0);
  useRunScroll(body, JSON.stringify([owner, bot.id, target?.runId, target?.turnId, detailPage, target ? null : runPage]), transcript?.revision);
  const runSequences = useRef(new Map<string, number>());
  const valid = useCallback(() => active.current && botsClient.owner === owner, [owner]);
  const load = useCallback(async (next: string | null) => {
    if (!online || !valid()) return;
    if (listRequest.current) { refreshAgain.current = true; return; }
    const request = listEpoch.current;
    listRequest.current = true; setListBusy(true); if (!targetRef.current) setError("");
    try {
      runEvents.current.clear();
      const page = await botsClient.rpc<BotRunPage>("runs.page", bot.id, { cursor: next, limit: 25 }, undefined, { owner });
      if (!valid() || request !== listEpoch.current) return;
      const values = page.runs.map(run => compactRun(runEvents.current.get(run.id)?.run ?? run));
      setRuns(values); setCursor(page.nextCursor);
      if (!next) { botsClient.save(cacheKey, { runs: values, cursor: page.nextCursor }); setNewActivity(false); }
    } catch (reason) { if (valid() && request === listEpoch.current && !targetRef.current) setError(reason instanceof Error ? reason.message : "Activity could not be loaded."); }
    finally { listRequest.current = false; if (botsClient.owner === owner) setListBusy(false); }
  }, [bot.id, cacheKey, online, owner, valid]);
  useEffect(() => {
    active.current = true;
    void Promise.resolve().then(() => {
      if (!valid()) return;
      setActionBusy(actionRequest.current); setListBusy(listRequest.current);
      if (!targetRef.current || !online) setDetailBusy(false);
    });
    listEpoch.current++;
    void Promise.resolve().then(() => load(currentListCursor.current));
    let timer: ReturnType<typeof setTimeout> | undefined, frame = 0;
    let buffered: BotEvent[] = [];
    const event = (value: BotEvent) => {
      if (value.botId !== bot.id || botsClient.owner !== owner) return;
      if (lanes && value.type.startsWith("run.")) {
        const data = value.data as Partial<BotRunStateEvent>;
        if (!data.runId || !data.laneId || !data.threadId || value.seq <= (runSequences.current.get(`${value.type}:${data.runId}`) ?? -1)) return;
        runSequences.current.set(`${value.type}:${data.runId}`, value.seq);
        if (runSequences.current.size > 100) runSequences.current.delete(runSequences.current.keys().next().value!);
        if (value.type === "run.state" && data.run?.id === data.runId && data.run.botId === bot.id) {
          runEvents.current.set(data.runId, data as BotRunStateEvent);
          if (runEvents.current.size > 100) runEvents.current.delete(runEvents.current.keys().next().value!);
          setRuns(current => current.some(run => run.id === data.runId) ? current.map(run => run.id === data.runId ? compactRun(data.run!) : run) : current);
        }
        if (!targetRef.current || targetRef.current.runId === data.runId) setNewActivity(true);
        if (value.type === "run.codex" && targetRef.current?.runId === data.runId) {
          buffered.push(value);
          if (buffered.length > 64 || JSON.stringify(buffered).length > 256 * 1024) buffered = [];
          frame ||= requestAnimationFrame(() => { frame = 0; const batch = buffered; buffered = []; setTranscript(page => page ? updateRunPage(page, batch, targetRef.current?.turnId) : page); });
        }
        return;
      }
      if (value.type !== "schedules") return;
      timer ??= setTimeout(() => {
        timer = undefined;
        if (runPageRef.current || targetRef.current) setNewActivity(true);
        else void load(null);
      }, 250);
    };
    botsClient.events.add(event);
    return () => { active.current = false; if (timer) clearTimeout(timer); if (frame) cancelAnimationFrame(frame); botsClient.events.delete(event); };
  }, [bot.id, load, online, valid, lanes, owner]);
  useEffect(() => { if (!listBusy && refreshAgain.current) { refreshAgain.current = false; void Promise.resolve().then(() => load(currentListCursor.current)); } }, [listBusy, load]);
  useEffect(() => {
    if (!target) return;
    if (lanes && target.runId) {
      const cached = savedRunPage(owner, bot.id, target.runId, target.turnId, pageCursors[detailPage]);
      if (cached) void Promise.resolve().then(() => { if (valid()) setTranscript(cached); });
    }
    if (!online) return;
    const request = ++generation.current;
    let canceled = false;
    void Promise.resolve().then(async () => {
      if (canceled || !valid()) return;
      const identity = JSON.stringify([target.runId, target.turnId, pageCursors[detailPage]]);
      const changedPart = identity !== detailIdentity.current;
      setDetailBusy(true); setError(""); if (changedPart) setTranscript(lanes && target.runId ? savedRunPage(owner, bot.id, target.runId, target.turnId, pageCursors[detailPage]) : null);
      const result = await botsClient.rpc<HistoryResponse>("history.view", bot.id, { ...(lanes && target.runId ? { runId: target.runId } : {}), ...(target.turnId ? { turnId: target.turnId } : {}), cursor: pageCursors[detailPage] }, undefined, { owner });
      if (canceled || !valid() || request !== generation.current) return;
      if (lanes && target.runId) {
        verifyRunPage(result, target.runId, runEvents.current.get(target.runId)?.run);
        if (result.kind === "page") saveRunPage(owner, bot.id, target.runId, target.turnId, pageCursors[detailPage], result);
      }
      if (result.kind === "page") { setTranscript(result); detailIdentity.current = identity;  }
    }).catch(reason => { if (!canceled && valid() && request === generation.current) setError(reason instanceof Error ? reason.message : "This run could not be opened."); })
      .finally(() => { if (botsClient.owner === owner && request === generation.current) setDetailBusy(false); });
    return () => { canceled = true; };
  }, [bot.id, detailPage, online, owner, pageCursors, target, valid, lanes]);
  const open = (run: BotRun) => {
    if (!run.turnId && !lanes) return;
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
    if (actionRequest.current) return;
    actionRequest.current = true; setActionBusy(true); setReviewError(null);
    try {
      await botsClient.rpc("runs.acknowledge", bot.id, { id: run.id }, `run-review:${run.id}`, { owner });
      if (valid()) await load(runCursors[runPage]);
    } catch (reason) { if (botsClient.owner === owner) setReviewError({ run, message: reason instanceof Error ? reason.message : "The review could not be confirmed." }); }
    finally { actionRequest.current = false; if (botsClient.owner === owner) setActionBusy(false); }
  };
  const groups = useMemo(() => {
    const groups = new Map<string, BotRun[]>();
    for (const run of runs.filter(run => filter === "all" || needsAttention(run))) {
      const title = day(run.scheduledAt); groups.set(title, [...(groups.get(title) ?? []), run]);
    }
    return [...groups];
  }, [filter, runs]);
  const selectedRun = [...runs, ...recentRuns, ...(saved?.runs ?? [])].find(run => target?.runId ? run.id === target.runId : !!target?.turnId && run.turnId === target.turnId);
  const linked = useMemo(() => new Set(transcript?.entries.flatMap(entry => entry.item?.type === "agentMessage" ? [...entry.item.text.matchAll(/\]\(<?bot-artifact:([^\s)>]+)/g)].map(match => match[1]) : []) ?? []), [transcript]);
  return <div className="bots-modal-backdrop bots-activity-backdrop" onClick={onClose}>
    <section className="bots-run-library" role="dialog" aria-modal="true" aria-label={`${bot.name} activity`} onClick={event => event.stopPropagation()}>
      <header className="bots-run-library-heading">
        <div className="bots-run-heading-mark"><Clock3 size={22} aria-hidden="true" /></div>
        <div><h2>Activity</h2><p>{bot.name}</p></div>
        <button className="bots-icon-button" aria-label="Close activity and return to conversation" onClick={onClose}><X size={20} /></button>
      </header>
      <div className="bots-run-library-body" ref={body}>
        {reviewError && <div className="bots-run-notice is-error" role="alert"><CircleAlert size={18} /><div><p>{reviewError.message}</p><button disabled={!online || actionBusy} onClick={() => void acknowledge(reviewError.run)}>Retry same review</button></div></div>}
        {error && <div className="bots-run-notice is-error" role="alert"><CircleAlert size={18} /><div><p>{error}</p><button disabled={!online || busy} onClick={() => target ? setPageCursors(current => [...current]) : void load(currentListCursor.current)}>Try again</button></div></div>}
        {target ? <>
          <button className="bots-run-back" onClick={back}><ArrowLeft size={16} />All activity</button>
          <div className="bots-run-detail-title"><span>Scheduled run</span><h3>{selectedRun?.title ?? "Earlier activity"}</h3><p>{selectedRun ? stamp(selectedRun.scheduledAt) : "Full recorded conversation"}</p></div>
          {lanes && target.runId && <RunQuestions key={`${owner}:${bot.id}:${target.runId}`} owner={owner} botId={bot.id} runId={target.runId} online={online} />}
          {target.runId && (lanes || botsClient.snapshot?.activeScheduledTurns !== undefined) && <RunTurnPicker key={`${owner}:${bot.id}:${target.runId}`} owner={owner} botId={bot.id} runId={target.runId} primary={selectedRun} selected={target.turnId ?? ""} online={online} onSelect={turnId => {
            generation.current++; setTranscript(null); setPageCursors([null]); setDetailPage(0); setTarget({ runId: target.runId, turnId });
          }} />}
          {lanes && selectedRun && <RunControls owner={owner} botId={bot.id} run={selectedRun} online={online} />}
          {!online && <div className="bots-run-notice"><CircleAlert size={18} /><p>{transcript ? "Saved run detail. Connect for updates and details not yet opened." : "Connect to open this run. Your saved conversation is still available."}</p></div>}
          {newActivity && <button className="bots-run-back" disabled={!online || busy} onClick={() => { setNewActivity(false); setPageCursors(current => [...current]); }}>Updated · Refresh this part<RefreshCw size={14} /></button>}
          {lanes && target.runId && transcript?.context ? <RunTranscript key={JSON.stringify([owner, bot.id, target.runId, target.turnId, detailPage])} owner={owner} botId={bot.id} runId={target.runId} page={transcript} download={download} /> : <div className="bots-run-transcript">
            {transcript?.entries.map(entry => <TimelineEntry key={`${entry.turnId}:${entry.id}`} entry={{ ...entry, scheduled: false }} timeline={timeline} attachments={transcript.attachments.length ? transcript.attachments : attachments} download={download} />)}
            {transcript && <ReturnedArtifacts botId={bot.id} turnId={target.turnId ?? undefined} attachments={transcript.attachments} linked={linked} />}
          </div>}
          {transcript && !transcript.entries.length && <p className="bots-muted">No messages were recorded in this part of the run.</p>}
          <nav className="bots-run-pagination" aria-label="Run transcript pages">
            {transcript?.olderCursor && <button disabled={!online || busy} onClick={() => { setPageCursors(current => [...current.slice(0, detailPage + 1), transcript.olderCursor]); setDetailPage(page => page + 1); }}><ArrowLeft size={15} />Earlier detail</button>}
            {detailPage > 0 && <button disabled={!online || busy} onClick={() => setDetailPage(page => page - 1)}>Newer detail<ArrowRight size={15} /></button>}
          </nav>
          {lanes && target.runId && <RunComposer key={`${owner}:${bot.id}:${target.runId}`} owner={owner} botId={bot.id} runId={target.runId} online={online} paused={selectedRun?.activity?.state === "paused"} />}
        </> : <>
          <div className="bots-run-intro"><h3>Scheduled activity</h3><p>Review scheduled runs, their progress, and recorded results.</p></div>
          {!online && <div className="bots-run-notice"><Clock3 size={18} /><p>Saved activity. Reconnect for updates and full run details.</p></div>}
          {schedules.some(schedule => schedule.enabled && schedule.nextRunAt) && <section className="bots-run-upcoming" aria-label="Coming up"><CalendarDays size={18} /><div><strong>Coming up</strong>{schedules.filter(schedule => schedule.enabled && schedule.nextRunAt).sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!)).slice(0, 3).map(schedule => <p key={schedule.id}><span>{schedule.title}</span><time>{stamp(schedule.nextRunAt)}</time></p>)}</div></section>}
          <div className="bots-run-tools"><div role="group" aria-label="Filter activity"><button aria-pressed={filter === "all"} onClick={() => setFilter("all")}>All runs</button><button aria-pressed={filter === "attention"} onClick={() => setFilter("attention")}>Needs attention</button></div><button className="bots-icon-button" aria-label="Refresh activity" disabled={busy || !online} onClick={firstPage}><RefreshCw size={16} /></button></div>
          {newActivity && <button className="bots-run-back" onClick={firstPage}>New activity · Show recent runs<ArrowRight size={15} /></button>}
          {runPage > 0 && <button className="bots-run-back" disabled={!online || busy} onClick={() => runPageTo(runPage - 1, runCursors[runPage - 1])}><ArrowLeft size={15} />Newer activity</button>}
          {groups.map(([date, values]) => <section className="bots-run-day" key={date}><h3>{date}</h3>{values.map(run => <article className={`bots-run-card ${needsAttention(run) ? "needs-attention" : ""}`} key={run.id}>
            <div className="bots-run-card-icon">{["running", "starting"].includes(run.status) ? <LoaderCircle size={18} className="bots-spin" /> : needsAttention(run) ? <CircleAlert size={18} /> : run.status === "completed" ? <CheckCircle2 size={18} /> : <Clock3 size={18} />}</div>
            <div className="bots-run-card-content"><div className="bots-run-card-title"><h4>{run.title}</h4><span className={`bots-run-status is-${run.status}`}>{labels[run.status] ?? "Recorded"}</span></div><p><time>{stamp(run.startedAt ?? run.scheduledAt)}</time>{run.finishedAt && <span> · Finished {validDate(run.finishedAt)?.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</span>}</p>{run.error && <p className="bots-run-error-text">{run.error}</p>}<div className="bots-run-card-actions">{run.turnId || lanes ? <button disabled={busy} onClick={() => open(run)}>Open run<ArrowRight size={14} /></button> : <span>{run.status === "queued" ? "Waiting to start" : "No recorded conversation"}</span>}{run.status === "uncertain" && <button disabled={!online || busy} onClick={() => void acknowledge(run)}>I reviewed this run</button>}</div></div>
          </article>)}</section>)}
          {!groups.length && !busy && !error && <div className="bots-run-empty"><Clock3 size={30} strokeWidth={1.4} /><h3>{filter === "attention" ? "Nothing needs your attention here" : "A quieter kind of history"}</h3><p>{filter === "attention" ? "No issues on this page. You can also browse earlier activity." : "Your scheduled runs will appear here, with their progress and results."}</p></div>}
          {lanes && <StopAll owner={owner} botId={bot.id} online={online} />}
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
