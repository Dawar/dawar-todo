"use client";
// Adapted from shadcn AI Elements "Sources" and "Inline Citation". Only links
// already written in the message are listed; nothing is fetched or previewed.
import type { ReactNode } from "react";
import { BookOpen, ExternalLink } from "lucide-react";
import type { MessageSource } from "@/lib/ai-elements";
import "./ai-elements.css";

export function Sources({ sources }: { sources: MessageSource[] }) {
  if (!sources.length) return null;
  return <details className="ai-sources">
    <summary><BookOpen size={14} aria-hidden="true"/>Used {sources.length} {sources.length === 1 ? "source" : "sources"}</summary>
    <ul>{sources.map(source => <li key={source.url}><a href={source.url} target="_blank" rel="noopener noreferrer">
      <ExternalLink size={13} aria-hidden="true"/><span className="ai-source-label">{source.label}</span><small>{source.host}</small></a></li>)}</ul>
  </details>;
}
export function InlineCitation({ href, index, host, children }: { href: string; index: string | null; host: string; children?: ReactNode }) {
  return <a className="ai-inline-citation" href={href} target="_blank" rel="noopener noreferrer" title={href} aria-label={`Source${index ? ` ${index}` : ""}: ${host}`}>
    {index ? <span className="ai-citation-index">{index}</span> : null}<span>{host}</span>{children}
  </a>;
}
