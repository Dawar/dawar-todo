"use client";
import { Activity, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Clock3, FolderOpen, History, ListOrdered, ListTree, MessageCircle, Monitor, Phone, Settings2, Target } from "lucide-react";
import type { Bot } from "../../lib/bots-types";
import "./bot-details.css";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { HistoryScrollContext } from "./history-scroll-context";

export type BotDetailsSection = "next" | "goals" | "queues" | "schedules" | "files" | "desktop" | "calls" | "discussions" | "history" | "settings";
const sections = [
  { id: "next", label: "Up next", icon: ListOrdered },
  { id: "goals", label: "Goals", icon: Target },
  { id: "queues", label: "Queues", icon: ListTree },
  { id: "schedules", label: "Schedules", icon: Clock3 },
  { id: "files", label: "Files", icon: FolderOpen },
  { id: "calls", label: "Calls", icon: Phone },
  { id: "desktop", label: "Desktop", icon: Monitor },
  { id: "discussions", label: "Discussions", icon: MessageCircle },
  { id: "history", label: "History", icon: History },
  { id: "settings", label: "Settings", icon: Settings2 },
] as const;

/** Presentation stays separate from the single conversation/composer. Hidden
 * sections retain their reading/form state but React pauses their effects. */
export function BotDetailsDrawer({ bot, section, onSection, onClose, children, discussionAttention = 0, legacyDiscussionsOnly = false }: {
  bot: Bot; section: BotDetailsSection; onSection: (section: BotDetailsSection) => void;
  onClose: () => void; children: Record<BotDetailsSection, ReactNode>; discussionAttention?: number; legacyDiscussionsOnly?: boolean;
}) {
  const tabs = sections.filter(tab=>!legacyDiscussionsOnly || tab.id!=="discussions" || section === "discussions");
  const dialog = useRef<HTMLDivElement>(null), id = useId();
  const [historyScroll, setHistoryScroll] = useState<HTMLDivElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    dialog.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [section]);
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent ref={dialog} className="bots-details left-auto right-0 top-0 z-[60] max-h-none w-full max-w-[500px] translate-x-0 translate-y-0 gap-0 overflow-hidden rounded-none border-0 p-0 sm:p-0" overlayClassName="z-[60]" aria-describedby={undefined}
      onOpenAutoFocus={event => {
        opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const selected = dialog.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
        if (selected) {
          event.preventDefault();
          selected.focus({ preventScroll: true });
          selected.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
      }}
      onCloseAutoFocus={event => { event.preventDefault(); if (opener.current?.isConnected) opener.current.focus({ preventScroll: true }); }}>
      <header className="bots-details-heading">
        <div><span>Bot details</span><DialogTitle>{bot.name}</DialogTitle></div>
      </header>
      <div className="bots-details-nav" role="tablist" aria-label="Bot details sections">
        {tabs.map(({ id: value, label, icon: Icon }) => <Button type="button" variant="ghost" size="sm" key={value} id={`${id}-${value}`} role="tab" aria-selected={section === value} aria-controls={`${id}-${value}-panel`} tabIndex={section === value ? 0 : -1}
          onClick={() => onSection(value)} onKeyDown={event => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const index = tabs.findIndex(item => item.id === section);
            const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
            const target = tabs[next].id; onSection(target); document.getElementById(`${id}-${target}`)?.focus();
          }}><Icon size={17} aria-hidden="true" /><span>{label}{value === "discussions" && discussionAttention > 0 && <small className="bots-discussion-badge" aria-label={`${discussionAttention} discussions need attention`}>{discussionAttention}</small>}</span></Button>)}
      </div>
      {sections.map(({ id: value }) => <Activity key={value} mode={section === value ? "visible" : "hidden"}>
        <div ref={value === "history" ? setHistoryScroll : undefined} className={`bots-details-panel is-${value}`} role="tabpanel" id={`${id}-${value}-panel`} aria-labelledby={`${id}-${value}`} tabIndex={0}>{value === "history" ? <HistoryScrollContext value={historyScroll}>{children[value]}</HistoryScrollContext> : children[value]}</div>
      </Activity>)}
    </DialogContent>
  </Dialog>;
}
