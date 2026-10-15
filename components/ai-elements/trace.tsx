"use client";
// Adapted from shadcn AI Elements "Trace" (Radix variant, Oct 2026). Local
// ownership: rows are fed by native Codex item evidence, never AI SDK parts.
import type { ReactNode } from "react";
import { Brain, Check, CircleAlert, CircleDashed, CircleSlash, FileDiff, ListChecks, LoaderCircle, Search, Terminal, Users, Wrench, type LucideIcon } from "lucide-react";
import { TRACE_LABELS, type TraceState } from "@/lib/trace-state";
import "./ai-elements.css";

const kindIcons: Record<string, LucideIcon> = {
  commandExecution: Terminal, fileChange: FileDiff, webSearch: Search, reasoning: Brain,
  plan: ListChecks, workPlan: ListChecks, collabAgentToolCall: Users, subAgentActivity: Users, mcpToolCall: Wrench, dynamicToolCall: Wrench,
};
export function TraceIcon({ kind, size = 15 }: { kind: string; size?: number }) {
  const Icon = kindIcons[kind] ?? Wrench;
  return <Icon size={size} className="ai-trace-icon" aria-hidden="true" />;
}

const stateIcons: Record<TraceState, LucideIcon> = {
  running: LoaderCircle, completed: Check, failed: CircleAlert, declined: CircleSlash, interrupted: CircleSlash, unknown: CircleDashed,
};
/** Accessible status glyph; text label is announced, colour is secondary. */
export function TraceStatus({ state, size = 14, children }: { state: TraceState; size?: number; children?: ReactNode }) {
  const Icon = stateIcons[state];
  return <span className="ai-trace-status" data-state={state} title={TRACE_LABELS[state]}>
    {children}<Icon size={size} className={state === "running" ? "bots-spin" : undefined} role="img" aria-label={TRACE_LABELS[state]} />
  </span>;
}
