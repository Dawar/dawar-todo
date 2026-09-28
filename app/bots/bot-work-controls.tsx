"use client";
import { useId, useState } from "react";
import { ArrowUpRight, Clock3, Square } from "lucide-react";
import type { Bot, BotRun } from "../../lib/bots-types";
import type { ActivityTarget } from "./conversation-activity";
import { botsClient as client } from "./client";
import { StopAll } from "./run-controls";
import { runNeedsBinding } from "./run-context";
import { useRunAction } from "./run-action";
import "./bot-work-controls.css";

const working = new Set(["running", "waiting-input", "waiting-workers", "queued", "provisioning", "uncertain"]);
function currentWork(run: BotRun) {
  if (run.executionLane === "main-legacy") return false;
  const activity = run.activity;
  if (activity?.activeTurnId) return true;
  if (activity?.state === "paused") return (activity.queuedCount ?? 0) > 0 || (activity.pendingCount ?? 0) > 0 || runNeedsBinding(run) && run.status === "queued";
  if (activity) return working.has(activity.state);
  return !run.finishedAt && runNeedsBinding(run);
}
function status(run: BotRun) {
  if (run.activity?.state === "paused") return "Paused";
  if (run.activity?.state === "uncertain") return "Needs review";
  if (runNeedsBinding(run)) return run.laneId ? "Preparing to start" : "Waiting to start";
  if (run.activity?.activeTurnId) return "In progress";
  return ({ "waiting-input": "Waiting for your answer", "waiting-workers": "Helpers working", queued: "Queued work", idle: "Idle", running: "In progress", provisioning: "Preparing to start" } as Record<string, string>)[run.activity?.state ?? ""] ?? "No current work";
}

function WorkRun({ owner, botId, run, online, hold, release, onOpen }: {
  owner: string; botId: string; run: BotRun; online: boolean;
  hold: (run: BotRun) => void; release: (id: string) => void; onOpen: (target: ActivityTarget) => void;
}) {
  // Same scope as Activity: uncertain Stop/Resume always recovers its saved ID.
  const action = useRunAction(owner, botId, `control:${run.id}`);
  const current = currentWork(run), paused = run.activity?.state === "paused";
  const bound = run.executionLane === "run-v1" && !!run.laneId && !!run.threadId && !runNeedsBinding(run);
  const stoppable = bound && !paused && run.activity?.state !== "uncertain" &&
    (Boolean(run.activity?.activeTurnId) || ["waiting-input", "waiting-workers", "queued"].includes(run.activity?.state ?? ""));
  const stop = async () => {
    hold(run); // Keep recovery visible even if a terminal event precedes the ACK.
    try {
      if (action.intent) await action.retry();
      else if (stoppable) await action.perform("runs.interrupt", { runId: run.id });
      else return;
      if (client.owner === owner) void client.refresh().catch(() => {});
    } catch { /* Exact receipt and error remain in the origin-owned action. */ }
    finally { if (!action.intent && !action.error) release(run.id); }
  };
  return <article className="bots-work-run" aria-label={`Scheduled work: ${run.title}`}>
    <header><Clock3 size={15} aria-hidden="true" /><h4>{run.title}</h4></header>
    <p className="bots-work-state">{status(run)}</p>
    {paused && <p className="bots-work-hint">Open Activity to resume queued work. Interrupted work does not restart automatically.</p>}
    {run.activity?.state === "uncertain" ? <p className="bots-work-hint">Open Activity to review this run&apos;s unconfirmed action.</p> : !paused && runNeedsBinding(run) && <p className="bots-work-hint">This run is waiting to start. Stop all also holds queued work.</p>}
    <div className="bots-work-run-actions">
      {(stoppable || action.intent) && <button type="button" className="bots-work-stop" disabled={!online || !action.ready || action.busy}
        aria-label={action.intent ? `Check saved action for ${run.title}` : `Stop this run: ${run.title}`} onClick={() => void stop()}>
        <Square size={13} aria-hidden="true" />{action.busy ? "Confirming…" : action.intent ? "Check saved action" : "Stop this run"}
      </button>}
      <button type="button" className="bots-work-open" onClick={() => onOpen({ runId: run.id })} aria-label={`Open ${run.title} in Activity`}>Activity<ArrowUpRight size={14} aria-hidden="true" /></button>
    </div>
    {(action.error || action.intent && !action.busy) && <p className="bots-work-error" role="alert">{action.error || "The saved action is awaiting confirmation."}
      {!action.ready && <button type="button" onClick={() => void action.refresh()}>Retry action storage</button>}
    </p>}
    {!current && !action.intent && !action.busy && action.error && <button type="button" className="bots-work-open" onClick={() => release(run.id)}>Dismiss</button>}
  </article>;
}

export function BotWorkControls({ owner, bot, runs, online, onOpen }: {
  owner: string; bot: Bot; runs: BotRun[]; online: boolean; onOpen: (target?: ActivityTarget) => void;
}) {
  const heading = useId();
  const [held, setHeld] = useState<Record<string, BotRun>>({});
  const owned = runs.filter(run => run.botId === bot.id);
  const current = owned.filter(currentWork).sort((a, b) => Number(Boolean(b.activity?.activeTurnId)) - Number(Boolean(a.activity?.activeTurnId)));
  const byId = new Map(owned.map(run => [run.id, run]));
  const displayed = new Map(current.slice(0, 6).map(run => [run.id, run]));
  for (const saved of Object.values(held)) displayed.set(saved.id, byId.get(saved.id) ?? saved);
  return <section className="bots-work-controls" aria-labelledby={heading}>
    <h3 id={heading}>Work controls</h3>
    <p className="bots-work-hint">Stop a scheduled run here. The square in the composer stops the main conversation.</p>
    {!online && <p className="bots-work-hint" role="status">Saved status · Connect to control work.</p>}
    <div className="bots-work-runs">
      {[...displayed.values()].map(run => <WorkRun key={run.id} owner={owner} botId={bot.id} run={run} online={online && !bot.archived}
        hold={value => setHeld(previous => ({ ...previous, [value.id]: value }))}
        release={id => setHeld(previous => { const next = { ...previous }; delete next[id]; return next; })} onOpen={onOpen} />)}
    </div>
    {!displayed.size && <p className="bots-work-empty">No current scheduled work.</p>}
    {current.length > 6 && <button type="button" className="bots-work-open" onClick={() => onOpen()}>More work in Activity<ArrowUpRight size={14} aria-hidden="true" /></button>}
    <div className="bots-work-all"><StopAll owner={owner} botId={bot.id} online={online && !bot.archived} /></div>
  </section>;
}
