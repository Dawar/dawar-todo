"use client";
// Adapted from shadcn AI Elements "Subagent". Shown only for native sub-agent
// items that carry agent thread identities; Claude Task calls and anonymous
// workers keep the ordinary Tool row. No controls: display only.
import type { ReactNode } from "react";
import { Bot } from "lucide-react";
import type { SubagentView } from "@/lib/ai-elements";
import "./ai-elements.css";

export function Subagent({ view, prompt }: { view: SubagentView; prompt?: (text: string) => ReactNode }) {
  return <div className="ai-subagent">
    <ul className="ai-subagent-agents">{view.agents.map(agent => <li key={agent.threadId}>
      <Bot size={15} aria-hidden="true"/><strong>{agent.name}</strong>
      {agent.status && <span className="ai-subagent-status" data-status={agent.status}>{agent.status}</span>}
      <small title={agent.threadId}>Thread {agent.threadId.slice(0, 12)}</small>
      {agent.message && <p>{agent.message}</p>}
    </li>)}</ul>
    {(view.model || view.effort) && <p className="ai-tool-note">{[view.model, view.effort && `${view.effort} effort`].filter(Boolean).join(" · ")}</p>}
    {view.prompt && prompt && <details className="ai-subagent-prompt"><summary>Instructions sent</summary>{prompt(view.prompt)}</details>}
  </div>;
}
