"use client";
import { Square } from "lucide-react";
import type { BotRun } from "../../lib/bots-types";
import { useRunAction } from "./run-action";

export function RunControls({ owner, botId, run, online }: { owner: string; botId: string; run: BotRun; online: boolean }) {
  const action = useRunAction(owner, botId, `control:${run.id}`);
  const paused = run.activity?.state === "paused";
  return <div className="bots-run-controls">
    <span>{paused ? "This run is paused" : run.activity?.state === "waiting-input" ? "Waiting for your answer" : run.activity?.state === "waiting-workers" ? "Working with helpers" : run.activity?.state === "uncertain" ? "Delivery needs confirmation" : run.activity?.state === "idle" ? "Run is idle" : "Run activity"}</span>
    {action.intent ? <button disabled={!online || action.busy} onClick={() => void action.retry().catch(() => {})}>Check same action</button> : <button disabled={!online || action.busy} onClick={() => void action.perform(paused ? "runs.resume" : "runs.interrupt", { runId: run.id }).catch(() => {})}>{action.busy ? "Confirming…" : paused ? "Resume queued replies" : "Stop this run"}</button>}
    {paused && <small>Resumes only waiting replies and notices. Interrupted work does not restart automatically.</small>}
    {action.error && <p role="alert">{action.error}</p>}
  </div>;
}
export function StopAll({ owner, botId, online }: { owner: string; botId: string; online: boolean }) {
  const action = useRunAction(owner, botId, "stop:all");
  return <div className="bots-run-controls"><button disabled={!online || action.busy} onClick={() => void (action.intent ? action.retry() : action.perform("turn.interrupt", { scope: "all" })).catch(() => {})}>{action.intent ? "Check Stop all" : "Stop all work"}</button><small>Stops the main conversation, scheduled runs and their helpers.</small>{action.error && <p role="alert">{action.error}</p>}</div>;
}
export function MainStopButton({ owner, botId, online, className }: { owner: string; botId: string; online: boolean; className: string }) {
  const action = useRunAction(owner, botId, "stop:main");
  return <button type="button" className={className} aria-label={action.intent ? "Check main stop" : "Stop main conversation"} disabled={!online || action.busy} onClick={() => void (action.intent ? action.retry() : action.perform("turn.interrupt", { scope: "main" })).catch(() => {})}><Square size={14} fill="currentColor" /></button>;
}
export function MainStopRecovery({ owner, botId, online }: { owner: string; botId: string; online: boolean }) {
  const action = useRunAction(owner, botId, "stop:main");
  return action.intent || action.error ? <p className="bots-system-note" role="alert">{action.error || "Main stop is awaiting confirmation."}<button disabled={!online || action.busy} onClick={() => void action.retry().catch(() => {})}>Check main stop</button></p> : null;
}
