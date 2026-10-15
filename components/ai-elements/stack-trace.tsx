"use client";
// Adapted from shadcn AI Elements "Stack Trace". Frames are read from the exact
// output text (lib/ai-elements parseStackTrace); the raw output stays visible
// and copyable beside it. No file is opened or fetched from a frame.
import { Bug } from "lucide-react";
import type { StackFrame, StackTrace as Trace } from "@/lib/ai-elements";
import { CopyButton } from "./code-block";
import "./ai-elements.css";

function Frame({ frame }: { frame: StackFrame }) {
  const location = `${frame.file}${frame.line !== null ? `:${frame.line}` : ""}${frame.column !== null ? `:${frame.column}` : ""}`;
  return <li className="ai-stack-frame" data-internal={frame.internal || undefined}>
    <span className="ai-stack-fn">{frame.fn ?? "<anonymous>"}</span>
    <span className="ai-stack-location" title={location}>{location}</span>
  </li>;
}
export function StackTrace({ trace }: { trace: Trace }) {
  const own = trace.frames.filter(frame => !frame.internal), internal = trace.frames.filter(frame => frame.internal);
  const text = [trace.message, ...trace.frames.map(frame => frame.text)].filter(Boolean).join("\n");
  return <figure className="ai-stack-trace" aria-label="Stack trace">
    <figcaption className="ai-stack-heading"><Bug size={14} aria-hidden="true"/><span className="ai-stack-message" title={trace.message}>{trace.message || "Stack trace"}</span><CopyButton text={text} label="Copy stack trace"/></figcaption>
    <ol className="ai-stack-frames">{(own.length ? own : trace.frames).map((frame, index) => <Frame key={index} frame={frame}/>)}</ol>
    {own.length > 0 && internal.length > 0 && <details className="ai-stack-internal"><summary>{internal.length} library {internal.length === 1 ? "frame" : "frames"}</summary>
      <ol className="ai-stack-frames">{internal.map((frame, index) => <Frame key={index} frame={frame}/>)}</ol></details>}
    {trace.truncated && <p className="ai-tool-note">More frames remain in the output above.</p>}
  </figure>;
}
