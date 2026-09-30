"use client";
import { Activity, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Clock3, FolderOpen, History, ListOrdered, ListTree, Settings2, X } from "lucide-react";
import type { Bot } from "../../lib/bots-types";
import "./bot-details.css";
import { HistoryScrollContext } from "./history-scroll-context";

export type BotDetailsSection = "next" | "queues" | "schedules" | "files" | "history" | "settings";
const sections = [
  { id: "next", label: "Up next", icon: ListOrdered },
  { id: "queues", label: "Queues", icon: ListTree },
  { id: "schedules", label: "Schedules", icon: Clock3 },
  { id: "files", label: "Files", icon: FolderOpen },
  { id: "history", label: "History", icon: History },
  { id: "settings", label: "Settings", icon: Settings2 },
] as const;

/** Presentation stays separate from the single conversation/composer. Hidden
 * sections retain their reading/form state but React pauses their effects. */
export function BotDetailsDrawer({ bot, section, onSection, onClose, children }: {
  bot: Bot; section: BotDetailsSection; onSection: (section: BotDetailsSection) => void;
  onClose: () => void; children: Record<BotDetailsSection, ReactNode>;
}) {
  const dialog = useRef<HTMLElement>(null), id = useId();
  const [historyScroll, setHistoryScroll] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = dialog.current;
    element?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
    const focusable = () => [...(element?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], summary, [tabindex='0']") ?? [])].filter(node => node.getClientRects().length);
    const keydown = (event: KeyboardEvent) => {
      // A schedule editor or file viewer may sit above this drawer.
      if ([...document.querySelectorAll('[role="dialog"]')].filter(node => (node as HTMLElement).getClientRects().length).at(-1) !== element) return;
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key !== "Tab") return;
      const items = focusable(), first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [onClose]);
  return <div className="bots-details-backdrop" onClick={onClose}>
    <section ref={dialog} className="bots-details" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} onClick={event => event.stopPropagation()}>
      <header className="bots-details-heading">
        <div><span>Bot details</span><h2 id={`${id}-title`}>{bot.name}</h2></div>
        <button className="bots-icon-button" aria-label="Close bot details" onClick={onClose}><X size={20} /></button>
      </header>
      <div className="bots-details-nav" role="tablist" aria-label="Bot details sections">
        {sections.map(({ id: value, label, icon: Icon }) => <button key={value} id={`${id}-${value}`} role="tab" aria-selected={section === value} aria-controls={`${id}-${value}-panel`} tabIndex={section === value ? 0 : -1}
          onClick={() => onSection(value)} onKeyDown={event => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const index = sections.findIndex(item => item.id === section);
            const next = event.key === "Home" ? 0 : event.key === "End" ? sections.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + sections.length) % sections.length;
            const target = sections[next].id; onSection(target); document.getElementById(`${id}-${target}`)?.focus();
          }}><Icon size={17} aria-hidden="true" /><span>{label}</span></button>)}
      </div>
      {sections.map(({ id: value }) => <Activity key={value} mode={section === value ? "visible" : "hidden"}>
        <div ref={value === "history" ? setHistoryScroll : undefined} className={`bots-details-panel is-${value}`} role="tabpanel" id={`${id}-${value}-panel`} aria-labelledby={`${id}-${value}`} tabIndex={0}>{value === "history" ? <HistoryScrollContext value={historyScroll}>{children[value]}</HistoryScrollContext> : children[value]}</div>
      </Activity>)}
    </section>
  </div>;
}
