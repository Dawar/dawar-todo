"use client";
import { useId, type ReactNode } from "react";
import { ChevronRight, CircleDot, ListOrdered, Target } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { BotDetailsSection, SettingsGroup as SettingsGroupId } from "./bot-details-sections";

export type OverviewGoal = { objective: string; status: string } | null;

/** Compact, read-only summary at the top of Overview. Each row opens the
 * Work subsection that holds the detail; nothing here changes the bot. */
export function DetailsOverviewStatus({ status, queued, goal, goalsSupported, onOpen }: {
  status: string; queued: number | null; goal: OverviewGoal; goalsSupported: boolean; onOpen: (section: BotDetailsSection) => void;
}) {
  const rows: { section: BotDetailsSection; icon: typeof CircleDot; label: string; value: string }[] = [
    { section: "next", icon: CircleDot, label: "Status", value: status },
    { section: "next", icon: ListOrdered, label: "Up next", value: queued === null ? "Open to check" : queued ? `${queued} waiting` : "Nothing waiting" },
    ...(goalsSupported ? [{ section: "goals" as const, icon: Target, label: "Goal", value: goal ? `${goal.objective} · ${goal.status}` : "No active goal" }] : []),
  ];
  return <section className="bots-details-status" aria-label="Status">
    {rows.map(({ section, icon: Icon, label, value }) => <Button key={label} type="button" variant="ghost" className="bots-details-status-row" onClick={() => onOpen(section)}>
      <Icon size={16} aria-hidden="true" /><span className="bots-details-status-label">{label}</span><span className="bots-details-status-value">{value}</span><ChevronRight size={16} aria-hidden="true" />
    </Button>)}
  </section>;
}

/** One titled Settings group. `anchor` lets deep links scroll to it. */
export function DetailsGroup({ anchor, title, description, children }: { anchor: SettingsGroupId | "team"; title: string; description?: string; children: ReactNode }) {
  const id = useId();
  return <section className="bots-settings-group" aria-labelledby={id} data-details-anchor={anchor}>
    <h3 id={id}>{title}</h3>
    {description && <p className="bots-details-lead">{description}</p>}
    <div className="bots-settings-group-body">{children}</div>
  </section>;
}
