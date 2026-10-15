/** Display-only Trace state for one native item. It reads the producer's
 * own status/exit evidence; absent evidence stays unknown, never "done". */
export type TraceState = "running" | "completed" | "failed" | "declined" | "interrupted" | "unknown";
export const TRACE_LABELS: Record<TraceState, string> = {
  running: "In progress", completed: "Completed", failed: "Failed", declined: "Declined", interrupted: "Interrupted", unknown: "Status unknown",
};
export function traceState(status: string | null | undefined, evidence: { exitCode?: number | null; success?: boolean | null } = {}): TraceState {
  if (status === "inProgress") return "running";
  if (status === "declined") return "declined";
  if (status === "interrupted") return "interrupted";
  if (status === "failed" || typeof evidence.exitCode === "number" && evidence.exitCode !== 0 || evidence.success === false) return "failed";
  if (status === "completed") return "completed";
  return "unknown";
}
/** Diff lines keep their exact text; the kind only selects a colour. */
export type DiffLineKind = "add" | "remove" | "hunk" | "meta" | "context";
export function diffLineKind(line: string): DiffLineKind {
  if (/^(\+\+\+|---)( |$)/.test(line) || /^(diff |index |new file|deleted file|similarity |rename )/.test(line)) return "meta";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "remove";
  return "context";
}
/** Fenced language from react-markdown's `language-*` class, bounded for display. */
export function codeLanguage(className: unknown): string {
  const match = String(className ?? "").split(/[\s,]+/).find(value => value.startsWith("language-"));
  const language = match?.slice(9) ?? "";
  return /^[\w#+.-]{1,24}$/.test(language) ? language : "";
}
