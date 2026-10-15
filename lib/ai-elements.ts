/** Display-only adapters for the AI Elements patterns. Every function reads an
 * existing native item, message text or bot field and returns null/unknown
 * when the producer did not supply the evidence. Nothing here sends, fetches,
 * answers or infers state from prose. */
import type { ThreadItem } from "./codex-protocol/v2/ThreadItem";
import type { BotContextCompaction } from "./bots-types";

const MAX_TEXT = 200_000;
const json = (value: unknown) => { try { return JSON.stringify(value, null, 2) ?? ""; } catch { return ""; } };
const hasValue = (value: unknown) => value !== null && value !== undefined && !(typeof value === "object" && !Array.isArray(value) && !Object.keys(value as object).length);

/** Tool: parameters/result/error sections from the native tool item only. */
export type ToolView = { name: string; input: string | null; output: string | null; error: string | null; media: number; durationMs: number | null };
export function toolView(item: ThreadItem): ToolView | null {
  if (item.type === "mcpToolCall") {
    const parts = item.result?.content ?? [];
    const text = parts.flatMap(part => part && typeof part === "object" && !Array.isArray(part) && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string" ? [(part as { text: string }).text] : []);
    const media = parts.length - text.length;
    const output = text.length ? text.join("\n\n") : hasValue(item.result?.structuredContent) ? json(item.result?.structuredContent) : null;
    return { name: `${item.server} · ${item.tool}`, input: hasValue(item.arguments) ? json(item.arguments) : null, output: output?.slice(0, MAX_TEXT) ?? null,
      error: item.error?.message ?? null, media, durationMs: item.durationMs ?? null };
  }
  if (item.type === "dynamicToolCall") {
    const items = item.contentItems ?? [];
    const text = items.flatMap(part => part.type === "inputText" ? [part.text] : []);
    return { name: item.namespace ? `${item.namespace} · ${item.tool}` : item.tool, input: hasValue(item.arguments) ? json(item.arguments) : null,
      output: text.length && item.success !== false ? text.join("\n\n").slice(0, MAX_TEXT) : null,
      error: item.success === false ? (text.join("\n\n").slice(0, MAX_TEXT) || "The tool reported a failure.") : null,
      media: items.length - text.length, durationMs: item.durationMs ?? null };
  }
  return null;
}

/** Bounded human duration for a producer-supplied millisecond value. */
export function formatDuration(ms: number | null | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60), rest = Math.round(seconds % 60);
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

/** Terminal: escape sequences are removed for display only; copy keeps raw text. */
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
export function stripAnsi(text: string): string {
  return text.includes("\u001b") ? text.replace(ANSI, "") : text;
}

/** Stack Trace: frames read from exact output text. At least two frames of one
 * known shape are required, so ordinary prose never becomes a trace. */
export type StackFrame = { text: string; fn: string | null; file: string; line: number | null; column: number | null; internal: boolean };
export type StackTrace = { language: "javascript" | "python"; message: string; frames: StackFrame[]; truncated: boolean };
const JS_FRAME = /^\s*at (?:(.+?) \()?((?:node:|file:\/\/|\/|[A-Za-z]:\\|\.{1,2}\/|webpack:|<anonymous>)[^()]*?)(?::(\d+))?(?::(\d+))?\)?\s*$/;
const PY_FRAME = /^\s*File "([^"]+)", line (\d+)(?:, in (.+))?\s*$/;
const internalPath = (file: string) => /^node:|node_modules[\\/]|^internal[\\/]|<anonymous>|site-packages[\\/]|[\\/]lib[\\/]python\d/.test(file);
export function parseStackTrace(raw: string | null | undefined, maxFrames = 40): StackTrace | null {
  if (!raw || raw.length < 20) return null;
  const lines = stripAnsi(raw.slice(-64_000)).split("\n");
  const js: { index: number; frame: StackFrame }[] = [], py: { index: number; frame: StackFrame }[] = [];
  lines.forEach((line, index) => {
    if (line.length > 2000) return;
    const j = JS_FRAME.exec(line);
    if (j) { js.push({ index, frame: { text: line.trim(), fn: j[1]?.trim() || null, file: j[2], line: j[3] ? Number(j[3]) : null, column: j[4] ? Number(j[4]) : null, internal: internalPath(j[2]) } }); return; }
    const p = PY_FRAME.exec(line);
    if (p) py.push({ index, frame: { text: line.trim(), fn: p[3]?.trim() || null, file: p[1], line: Number(p[2]), column: null, internal: internalPath(p[1]) } });
  });
  if (js.length >= 2 && js.length >= py.length) {
    const start = js[0].index;
    const message = lines.slice(Math.max(0, start - 3), start).map(line => line.trim()).filter(Boolean).at(-1) ?? "";
    return { language: "javascript", message: message.slice(0, 500), frames: js.slice(0, maxFrames).map(value => value.frame), truncated: js.length > maxFrames };
  }
  if (py.length >= 2) {
    const after = lines.slice(py.at(-1)!.index + 1).map(line => line.trim()).filter(line => line && !line.startsWith("^") && !/^~+$/.test(line));
    const message = after.find(line => /^[\w.]+(?:Error|Exception|Exit|Interrupt|Warning)\b/.test(line)) ?? after.at(-1) ?? "";
    return { language: "python", message: message.slice(0, 500), frames: py.slice(0, maxFrames).map(value => value.frame), truncated: py.length > maxFrames };
  }
  return null;
}

/** Plan: native Work plan step status. Anything unrecognised stays pending. */
export type PlanStepState = "completed" | "running" | "pending";
export const planStepState = (status: string | null | undefined): PlanStepState => status === "completed" ? "completed" : status === "inProgress" ? "running" : "pending";

/** Sources: external http(s) destinations already present in one message. */
export type MessageSource = { url: string; host: string; label: string };
export function messageSources(destinations: readonly string[], limit = 20): MessageSource[] {
  const seen = new Set<string>(), sources: MessageSource[] = [];
  for (const href of destinations) {
    let url: URL;
    try { url = new URL(href); } catch { continue; }
    if (url.protocol !== "https:" && url.protocol !== "http:" || url.username || url.password) continue;
    url.hash = "";
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    let label = url.pathname.split("/").filter(Boolean).at(-1) ?? "";
    try { label = decodeURIComponent(label); } catch { /* Literal segment stays readable. */ }
    sources.push({ url: url.href, host: url.hostname.replace(/^www\./, ""), label: label.slice(0, 80) || url.hostname });
    if (sources.length >= limit) break;
  }
  return sources;
}

/** Inline Citation: a link whose visible text is a reference number or its own URL. */
export function inlineCitation(label: string, href: string | undefined): { index: string | null; host: string } | null {
  if (!href) return null;
  let url: URL;
  try { url = new URL(href); } catch { return null; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const text = label.trim(), number = /^\[?(\d{1,3})\]?$/.exec(text);
  if (number) return { index: number[1], host: url.hostname.replace(/^www\./, "") };
  if (text === href || text === url.href || text.replace(/\/$/, "") === url.href.replace(/\/$/, "")) return { index: null, host: url.hostname.replace(/^www\./, "") };
  return null;
}

/** Context: only native current context with a known window. No guessing. */
export type ContextMeter = { tokens: number; window: number; percent: number; level: "ok" | "warn" | "high"; compacted: boolean; observedAt: string };
export function contextMeter(context: BotContextCompaction["context"] | null | undefined): ContextMeter | null {
  if (!context || !Number.isSafeInteger(context.tokens) || context.tokens < 0 || !Number.isSafeInteger(context.window) || !context.window || context.window <= 0) return null;
  const percent = Math.min(100, Math.max(0, Math.round(context.tokens / context.window * 100)));
  return { tokens: context.tokens, window: context.window, percent, level: percent >= 90 ? "high" : percent >= 75 ? "warn" : "ok", compacted: context.compacted, observedAt: context.observedAt };
}
export const compactTokens = (value: number) => value >= 1_000_000 ? `${(value / 1_000_000).toFixed(value % 1_000_000 ? 1 : 0)}M` : value >= 1000 ? `${Math.round(value / 1000)}k` : String(value);

/** Subagent: native sub-agent provenance only (a thread identity per agent). */
export type SubagentView = { title: string; agents: { threadId: string; name: string; status: string | null; message: string | null }[]; prompt: string | null; model: string | null; effort: string | null; activity: string | null };
const COLLAB_LABELS: Record<string, string> = { spawnAgent: "Started subagent", sendInput: "Sent input to subagent", resumeAgent: "Resumed subagent", wait: "Waited for subagent",
  closeAgent: "Closed subagent", sendMessage: "Messaged subagent", followupTask: "Follow-up task for subagent", interruptAgent: "Interrupted subagent", listAgents: "Listed subagents" };
const agentName = (path: string, threadId: string) => path.split(/[\\/]/).filter(Boolean).at(-1)?.slice(0, 80) || `Agent ${threadId.slice(0, 8)}`;
export function subagentView(item: ThreadItem): SubagentView | null {
  if (item.type === "subAgentActivity") {
    if (!item.agentThreadId) return null;
    return { title: `Subagent ${item.kind}`, agents: [{ threadId: item.agentThreadId, name: agentName(item.agentPath ?? "", item.agentThreadId), status: item.kind, message: null }],
      prompt: null, model: item.model ?? null, effort: item.reasoningEffort ?? null, activity: item.kind };
  }
  if (item.type === "collabAgentToolCall") {
    const ids = (item.receiverThreadIds ?? []).filter(id => typeof id === "string" && id);
    if (!ids.length || !item.senderThreadId) return null;
    return { title: COLLAB_LABELS[item.tool] ?? "Subagent work", agents: ids.slice(0, 12).map(threadId => ({ threadId, name: `Agent ${threadId.slice(0, 8)}`,
      status: item.agentsStates?.[threadId]?.status ?? null, message: item.agentsStates?.[threadId]?.message?.slice(0, 2000) ?? null })),
      prompt: item.prompt?.slice(0, MAX_TEXT) ?? null, model: item.model ?? null, effort: item.reasoningEffort ?? null, activity: null };
  }
  return null;
}

/** Confirmation/Questionnaire: the pattern a genuine pending request uses. */
export type RequestPattern = "questionnaire" | "confirmation" | "authorization" | "form" | "other";
export function requestPattern(method: string, params?: { mode?: unknown }): RequestPattern {
  if (method === "item/tool/requestUserInput") return "questionnaire";
  if (method === "mcpServer/elicitation/request") return params?.mode === "url" ? "authorization" : "form";
  if (/requestApproval$|^execCommandApproval$|^applyPatchApproval$/.test(method)) return "confirmation";
  return "other";
}

/** Attachment: icon family and a readable size from the staged file metadata. */
export type AttachmentKind = "image" | "pdf" | "text" | "code" | "archive" | "audio" | "video" | "file";
export function attachmentKind(mimeType: string, name: string): AttachmentKind {
  const ext = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1]?.toLowerCase() ?? "";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType === "application/pdf" || ext === "pdf") return "pdf";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  if (/^(zip|gz|tgz|tar|7z|rar|bz2|xz)$/.test(ext) || /zip|tar|compressed/.test(mimeType)) return "archive";
  if (/^(js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|swift|c|h|cpp|cs|php|sh|json|ya?ml|toml|sql|css|html|xml)$/.test(ext)) return "code";
  if (mimeType.startsWith("text/") || /^(md|txt|csv|tsv|log|rtf|docx?|odt)$/.test(ext)) return "text";
  return "file";
}
export function formatBytes(size: number | null | undefined): string | null {
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0) return null;
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB"];
  let value = size / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
