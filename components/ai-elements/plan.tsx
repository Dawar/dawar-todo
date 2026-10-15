"use client";
// Adapted from shadcn AI Elements "Plan"/"Task": native Work plan progress and
// per-step state. Steps are the native plan's own; nothing is inferred.
import { Check, Circle, LoaderCircle } from "lucide-react";
import type { PlanStepState } from "@/lib/ai-elements";
import "./ai-elements.css";

const LABELS: Record<PlanStepState, string> = { completed: "Completed", running: "In progress", pending: "Pending" };
export function PlanStepStatus({ state }: { state: PlanStepState }) {
  const Icon = state === "completed" ? Check : state === "running" ? LoaderCircle : Circle;
  return <span className="ai-plan-step-status" data-state={state}><Icon size={14} aria-hidden="true" className={state === "running" ? "bots-spin" : undefined}/>{LABELS[state]}</span>;
}
export function PlanProgress({ completed, total }: { completed: number; total: number }) {
  if (!Number.isFinite(total) || total <= 0) return null;
  const value = Math.min(total, Math.max(0, completed));
  return <div className="ai-plan-progress">
    <progress max={total} value={value} aria-label={`${value} of ${total} steps completed`}/>
    <span>{value}/{total}</span>
  </div>;
}
