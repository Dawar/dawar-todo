import type { BotRun } from "../../lib/bots-types";
import { hasCurrentRunDecision } from "./run-context";

type Presentation = { label: string; tone: "neutral" | "working" | "finished" | "attention"; hint: string };
const waits: Record<string, string> = {
  capacity: "Waiting for another scheduled run to finish and free a place.",
  "main-turn-running": "Waiting for the current conversation turn to finish.",
  "needs-input": "An answer is needed before work can continue.",
  "waiting-input": "An answer is needed before work can continue.",
  "waiting-workers": "Waiting for this run’s helpers to finish.",
  paused: "Queued work is saved.",
  "stopped-before-start": "Stopped before starting. Queued work is saved.",
  "plan-reconciliation": "The Plan setting is awaiting confirmation.",
  "delivery-unconfirmed": "An earlier action is unconfirmed.",
};

/** Labels, filter membership and icons share one interpretation. A terminal
 * label never conceals explicit unresolved activity or a pending question. */
export function runPresentation(run: BotRun): Presentation {
  const activity = run.activity;
  if (run.status === "uncertain" || activity?.state === "uncertain") return {
    label: "Needs review", tone: "attention",
    hint: run.status === "cancelled" ? "Cancelled; an earlier action is still unconfirmed." : "An earlier action is unconfirmed.",
  };
  if (hasCurrentRunDecision(run)) return { label: "Start time missed", tone: "attention", hint: "Choose Start now, Reschedule or Cancel this occurrence. Nothing starts until you decide." };
  if ((activity?.state === "waiting-input" && activity.waitReason !== "overdue-decision") || (activity?.pendingCount ?? 0) > 0) return {
    label: "Answer needed", tone: "attention", hint: waits["waiting-input"],
  };
  if (activity?.activeTurnId || activity?.state === "running") return { label: "In progress", tone: "working", hint: "" };
  if (activity?.state === "waiting-workers") return { label: "Helpers working", tone: "working", hint: waits["waiting-workers"] };
  if (run.decision?.state === "rescheduled" && run.status === "queued") return { label: "Rescheduled", tone: "neutral", hint: "This occurrence has a new start time. The recurring schedule is unchanged." };
  if (run.status === "failed") return { label: "Failed", tone: "attention", hint: "Review the recorded details before deciding what to do next." };
  // Completed/cancelled history is neutral unless current work above says
  // otherwise. An interrupted run is terminal, not an unknown delivery.
  const terminal: Record<string, string> = { completed: "Finished", cancelled: "Cancelled", interrupted: "Stopped", acknowledged: "Reviewed", skipped: "Skipped" };
  if (terminal[run.status] && !(activity?.state === "queued" || activity?.state === "paused" && (activity.queuedCount ?? 0) > 0))
    return { label: terminal[run.status], tone: run.status === "completed" ? "finished" : "neutral", hint: "" };
  if (activity?.state === "paused") return { label: "Paused", tone: "neutral", hint: waits[activity.waitReason ?? ""] ?? waits.paused };
  if (activity?.state === "queued" || run.status === "queued") return {
    label: "Waiting to start", tone: "neutral", hint: waits[activity?.waitReason ?? ""] ?? "A start time has not been confirmed.",
  };
  if (activity?.state === "provisioning" || run.status === "starting") return { label: "Preparing", tone: "working", hint: "Preparing this run’s conversation." };
  if (run.status === "running") return { label: "In progress", tone: "working", hint: "" };
  return { label: "Recorded", tone: "neutral", hint: "" };
}
export const runNeedsAttention = (run: BotRun) => runPresentation(run).tone === "attention";
