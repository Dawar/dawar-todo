import { ArrowRight, CheckCircle2, CircleAlert, CircleMinus, Clock3, LoaderCircle } from "lucide-react";
import type { BotRun } from "../../lib/bots-types";
import { runPresentation } from "./run-presentation";

export function RunActivityCard({ run, online, busy, canOpen, stamp, open, acknowledge }: {
  run: BotRun; online: boolean; busy: boolean; canOpen: boolean; stamp: (value: string | null) => string;
  open: (run: BotRun) => void; acknowledge: (run: BotRun) => void;
}) {
  const view = runPresentation(run);
  return <article data-history-key={`run:${run.id}`} className={`bots-run-card tone-${view.tone}`}>
    <div className="bots-run-card-icon" aria-hidden="true">{view.tone === "attention" ? <CircleAlert size={18} /> : view.tone === "working" ? <LoaderCircle size={18} className="bots-spin" /> : view.tone === "finished" ? <CheckCircle2 size={18} /> : ["cancelled", "interrupted", "skipped"].includes(run.status) ? <CircleMinus size={18} /> : <Clock3 size={18} />}</div>
    <div className="bots-run-card-content">
      <div className="bots-run-card-title"><h4>{run.title}</h4><span className={`bots-run-status tone-${view.tone}`}>{view.label}</span></div>
      <p><time>{stamp(run.startedAt ?? run.scheduledAt)}</time>{run.finishedAt && <span> · Ended {stamp(run.finishedAt)}</span>}</p>
      {run.decision?.notBefore && <p>New start time <time>{stamp(run.decision.notBefore)}</time></p>}
      {view.hint && <p className="bots-run-state-hint">{view.hint}</p>}
      {run.error && <details className="bots-run-error-details"><summary>Recorded details</summary><p>{run.error}</p></details>}
      <div className="bots-run-card-actions">
        {canOpen ? <button disabled={busy} onClick={() => open(run)}>{view.tone === "attention" ? "Review run" : "Open run"}<ArrowRight size={14} /></button> : <span>No recorded conversation</span>}
        {run.status === "uncertain" && run.executionLane !== "run-v1" && <button disabled={!online || busy} onClick={() => acknowledge(run)}>I reviewed this run</button>}
      </div>
    </div>
  </article>;
}
