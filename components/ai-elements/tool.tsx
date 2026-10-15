"use client";
// Adapted from shadcn AI Elements "Tool" (Radix variant, Oct 2026). Sections
// come from the native tool item only; absent evidence is simply not shown.
import type { ReactNode } from "react";
import { CircleAlert } from "lucide-react";
import { CodeBlock } from "./code-block";
import type { ToolView } from "@/lib/ai-elements";
import "./ai-elements.css";

export function ToolSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="ai-tool-section" aria-label={title}><h4 className="ai-tool-section-title">{title}</h4>{children}</section>;
}
/** `page` lets the caller keep its existing bounded TextPages paging. */
export function ToolDetails({ view, page }: { view: ToolView; page: (text: string, render: (text: string) => ReactNode) => ReactNode }) {
  return <div className="ai-tool">
    {view.input && <ToolSection title="Parameters">{page(view.input, text => <CodeBlock language="json" code={text} copyText={view.input!}/>)}</ToolSection>}
    {view.error && <ToolSection title="Error"><div className="ai-tool-error" role="note"><CircleAlert size={15} aria-hidden="true"/>{page(view.error, text => <pre>{text}</pre>)}</div></ToolSection>}
    {view.output && <ToolSection title="Result">{page(view.output, text => <CodeBlock label={view.name} code={text} copyText={view.output!}/>)}</ToolSection>}
    {view.media > 0 && <p className="ai-tool-note">{view.media} non-text {view.media === 1 ? "result" : "results"} not shown here.</p>}
    {!view.input && !view.output && !view.error && !view.media && <p className="ai-tool-note">No parameters or result were recorded.</p>}
  </div>;
}
