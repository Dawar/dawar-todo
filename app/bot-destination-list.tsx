"use client";

import { ArrowRight, Check } from "lucide-react";
import type { Bot } from "../lib/bots-types";
import { BotAvatar } from "./bots/bot-avatar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Destination = Pick<Bot, "id" | "name" | "purpose" | "status" | "avatar">;

/** Shared presentation for draft forwarding and task queue destinations. */
export function BotDestinationList({ bots, selectedId, disabled, busy, emptyMessage = "No matching bots.", onChoose }: {
  bots: Destination[];
  selectedId?: string;
  disabled?: boolean;
  busy?: boolean;
  emptyMessage?: string;
  onChoose: (id: string) => void;
}) {
  return <div className="max-h-80 min-h-20 overflow-y-auto p-1" aria-busy={busy}>
    <ul aria-label="Destination bots" className="space-y-1">
      {bots.slice(0, 60).map(bot => <li key={bot.id}>
        <Button type="button" variant="ghost" disabled={disabled} aria-pressed={selectedId === undefined ? undefined : bot.id === selectedId}
          onClick={() => onChoose(bot.id)} className={cn("h-auto min-h-16 w-full justify-start gap-3 whitespace-normal px-3 py-3 text-left sm:h-auto", bot.id === selectedId && "bg-accent ring-1 ring-inset ring-primary")}>
          <BotAvatar bot={bot} small decorative />
          <span className="grid min-w-0 flex-1 gap-1"><span className="break-words text-sm font-medium [overflow-wrap:anywhere]">{bot.name}</span><span className="break-words text-xs font-normal text-muted-foreground [overflow-wrap:anywhere]">{bot.purpose || "Conversation"}</span></span>
          {selectedId === undefined ? <ArrowRight aria-hidden="true" /> : bot.id === selectedId ? <Check aria-hidden="true" /> : null}
        </Button>
      </li>)}
    </ul>
    {!bots.length && <p role="status" className="px-3 py-6 text-center text-sm text-muted-foreground">{emptyMessage}</p>}
    {bots.length > 60 && <p className="px-3 py-3 text-sm text-muted-foreground">Search to narrow {bots.length} bots.</p>}
  </div>;
}
