"use client";
import { Clock3, ArrowUpRight, MessagesSquare } from "lucide-react";
import type { BotRun } from "../../lib/bots-types";
import "./conversation-activity.css";
export type ActivityTarget = { turnId: string; runId?: string };
export function ConversationActivity({ runs, onOpen }: { runs: BotRun[]; onOpen: () => void }) {
  const active = runs.filter(run => ["running", "starting"].includes(run.status));
  return <div className="bots-conversation-nav">
    <div className="bots-conversation-destinations" aria-label="Bot views">
      <span aria-current="page"><MessagesSquare size={15} aria-hidden="true" />Conversation</span>
      <button type="button" onClick={onOpen}><Clock3 size={15} aria-hidden="true" />Activity</button>
    </div>
    {active.length > 0 && <button className="bots-background-link" onClick={onOpen}>
      <span className="bots-background-dot" aria-hidden="true" />
      <span>{active.length === 1 ? "Scheduled work in progress" : `${active.length} scheduled runs in progress`}</span>
      <ArrowUpRight size={14} aria-hidden="true" />
    </button>}
  </div>;
}
