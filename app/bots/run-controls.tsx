"use client";
import { Button } from "@/components/ui/button";
import { Square } from "lucide-react";
import type { BotRun } from "../../lib/bots-types";
import { useRunAction } from "./run-action";
import { runNeedsBinding } from "./run-context";

export function RunControls({ owner, botId, run, online, onConfirmed, allowNewActions = true }: { owner: string; botId: string; run: BotRun; online: boolean; onConfirmed: () => void; allowNewActions?: boolean }) {
  const action = useRunAction(owner, botId, `control:${run.id}`);
  const paused = run.activity?.state === "paused";
  // Stay subscribed to the original control journal even while another
  // decision prevents fresh actions. Loading/settling a receipt is independent.
  if (!allowNewActions && !action.intent && !action.error) return null;
  return <div className="bots-run-controls">
    <span>{!allowNewActions ? "Saved run control" : paused ? "This run is paused" : run.activity?.state === "waiting-input" ? "Waiting for your answer" : run.activity?.state === "waiting-workers" ? "Working with helpers" : run.activity?.state === "uncertain" ? "Delivery needs confirmation" : run.activity?.state === "idle" ? "Run is idle" : "Run activity"}</span>
    {action.intent ? <Button variant="ghost" size="sm" type="button" disabled={!online || action.busy} onClick={() => void action.retry().then(onConfirmed).catch(() => {})}>Check same action</Button> : allowNewActions && <Button variant="ghost" size="sm" type="button" disabled={!online || action.busy || !paused && runNeedsBinding(run)} onClick={() => void action.perform(paused ? "runs.resume" : "runs.interrupt", { runId: run.id }).then(onConfirmed).catch(() => {})}>{action.busy ? "Confirming…" : paused ? "Resume queued work" : runNeedsBinding(run) ? "Waiting to start" : "Stop this run"}</Button>}
    {paused && allowNewActions && <small>Resumes only queued work, replies and notices. Interrupted work does not restart automatically.</small>}
    {action.error && <p role="alert">{action.error}</p>}
    {!allowNewActions && action.error && !action.intent && <Button variant="ghost" size="sm" type="button" disabled={action.busy} onClick={() => void action.refresh()}>Refresh saved control</Button>}
  </div>;
}
export function StopAll({ owner, botId, online }: { owner: string; botId: string; online: boolean }) {
  const action = useRunAction(owner, botId, "stop:all");
  return <div className="bots-run-controls"><Button variant="ghost" size="sm" type="button" disabled={!online || action.busy} onClick={() => void (action.intent ? action.retry() : action.perform("turn.interrupt", { scope: "all" })).catch(() => {})}>{action.intent ? "Check Stop all" : "Stop all work"}</Button><small>Stops the main conversation, scheduled runs and their helpers.</small>{action.error && <p role="alert">{action.error}</p>}</div>;
}
export function MainStopButton({ owner, botId, online, className }: { owner: string; botId: string; online: boolean; className: string }) {
  const action = useRunAction(owner, botId, "stop:main");
  return <Button variant="ghost" size="icon" type="button" className={className} aria-label={action.intent ? "Check main stop" : "Stop main conversation"} disabled={!online || action.busy} onClick={() => void (action.intent ? action.retry() : action.perform("turn.interrupt", { scope: "main" })).catch(() => {})}><Square size={14} fill="currentColor" /></Button>;
}
export function MainStopRecovery({ owner, botId, online }: { owner: string; botId: string; online: boolean }) {
  const action = useRunAction(owner, botId, "stop:main");
  return action.intent || action.error ? <p className="bots-system-note" role="alert">{action.error || "Main stop is awaiting confirmation."}<Button variant="ghost" size="sm" type="button" disabled={!online || action.busy} onClick={() => void action.retry().catch(() => {})}>Check main stop</Button></p> : null;
}
