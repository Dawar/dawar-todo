"use client";
import { Activity, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Clock3, Compass, FolderOpen, History, ListOrdered, ListTree, Monitor, Phone, Settings2, Target, UsersRound, X } from "lucide-react";
import type { Bot } from "../../lib/bots-types";
import "./bot-details.css";
import { Button } from "@/components/ui/button";
import { HistoryScrollContext } from "./history-scroll-context";

export type BotDetailsSection = "navigation" | "next" | "goals" | "team" | "queues" | "schedules" | "files" | "desktop" | "calls" | "history" | "settings";
/** Generic opening shows Navigation; targeted shortcuts keep their section. */
export const DEFAULT_DETAILS_SECTION: BotDetailsSection = "navigation";
const sections = [
  { id: "navigation", label: "Navigation", icon: Compass },
  { id: "next", label: "Up next", icon: ListOrdered },
  { id: "goals", label: "Goals", icon: Target },
  { id: "team", label: "Team", icon: UsersRound },
  { id: "queues", label: "Queues", icon: ListTree },
  { id: "schedules", label: "Schedules", icon: Clock3 },
  { id: "files", label: "Files", icon: FolderOpen },
  { id: "calls", label: "Calls", icon: Phone },
  { id: "desktop", label: "Desktop", icon: Monitor },
  { id: "history", label: "History", icon: History },
  { id: "settings", label: "Settings", icon: Settings2 },
] as const;

/** Wide desktops dock the panel beside the conversation. Narrower layouts
 * keep the modal drawer. */
export const DOCKED_DETAILS_QUERY = "(min-width: 1000px)";
const subscribeDock = (fn: () => void) => {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const query = window.matchMedia(DOCKED_DETAILS_QUERY);
  query.addEventListener("change", fn);
  return () => query.removeEventListener("change", fn);
};
export function useDockedDetails() {
  return useSyncExternalStore(subscribeDock, () => Boolean(window.matchMedia?.(DOCKED_DETAILS_QUERY).matches), () => false);
}
/** Owner-scoped remembered open/closed choice for the docked panel only. */
const dockChoices = new Map<string, boolean>(), dockListeners = new Set<() => void>();
const subscribeDockChoice = (fn: () => void) => {
  dockListeners.add(fn);
  const storage = (event: StorageEvent) => { if (event.key?.endsWith(":details-docked:v1")) { dockChoices.clear(); fn(); } };
  window.addEventListener("storage", storage);
  return () => { dockListeners.delete(fn); window.removeEventListener("storage", storage); };
};
export function useDockedPreference(owner: string): [boolean, (open: boolean) => void] {
  const key = `dawar-bots:${owner}:details-docked:v1`;
  const open = useSyncExternalStore(subscribeDockChoice, () => {
    if (!owner) return false;
    if (!dockChoices.has(key)) { let value = false; try { value = localStorage.getItem(key) === "open"; } catch { /* Unavailable storage keeps it closed. */ } dockChoices.set(key, value); }
    return dockChoices.get(key)!;
  }, () => false);
  const set = useCallback((next: boolean) => {
    if (!owner) return;
    dockChoices.set(key, next);
    try { localStorage.setItem(key, next ? "open" : "closed"); } catch { /* The choice still applies to this page. */ }
    for (const fn of [...dockListeners]) fn();
  }, [owner, key]);
  return [open, set];
}

const focusable = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/** One details tree for both layouts, so switching between the docked
 * column and the mobile drawer keeps section, scroll and form state. Hidden
 * sections retain their state while React pauses their effects. Docked mode
 * has no backdrop or focus trap; the drawer is modal with Escape, a Tab
 * cycle and focus restoration. */
export function BotDetailsPanel({ bot, section, onSection, onClose, docked, returnFocus, children }: {
  bot: Bot; section: BotDetailsSection; onSection: (section: BotDetailsSection) => void;
  onClose: () => void; docked: boolean; returnFocus?: () => HTMLElement | null; children: Record<BotDetailsSection, ReactNode>;
}) {
  const tabs = sections;
  const panel = useRef<HTMLElement>(null), id = useId();
  const [historyScroll, setHistoryScroll] = useState<HTMLDivElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    panel.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [section]);
  // The modal drawer takes focus when it becomes visible and returns it when
  // hidden. The docked column leaves focus where the person put it.
  useLayoutEffect(() => {
    if (docked) return;
    const element = panel.current;
    opener.current = document.activeElement instanceof HTMLElement && !element?.contains(document.activeElement) ? document.activeElement : null;
    const selected = element?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    selected?.focus({ preventScroll: true });
    return () => {
      const target = returnFocus?.() ?? opener.current;
      requestAnimationFrame(() => { if (target?.isConnected && (document.activeElement === document.body || !document.activeElement)) target.focus({ preventScroll: true }); });
    };
  }, [docked, returnFocus]);
  const close = () => {
    const inside = panel.current?.contains(document.activeElement);
    onClose();
    if (inside) requestAnimationFrame(() => { const target = returnFocus?.(); if (target?.isConnected) target.focus({ preventScroll: true }); });
  };
  return <div className={`bots-details-host ${docked ? "is-docked" : "is-drawer"}`}>
    {!docked && <div className="bots-details-backdrop" aria-hidden="true" onClick={close} />}
    <section ref={panel} className="bots-details" role={docked ? "complementary" : "dialog"} aria-modal={docked ? undefined : true} aria-labelledby={`${id}-title`}
      onKeyDown={event => {
        if (event.defaultPrevented || !(event.target instanceof Node) || !panel.current?.contains(event.target)) return;
        if (event.key === "Escape") { event.preventDefault(); close(); return; }
        if (docked || event.key !== "Tab") return;
        const items = [...panel.current.querySelectorAll<HTMLElement>(focusable)].filter(node => node.getClientRects().length > 0);
        if (!items.length) return;
        const first = items[0], last = items.at(-1)!;
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }}>
      <header className="bots-details-heading">
        <div><span>Bot details</span><h2 id={`${id}-title`}>{bot.name}</h2></div>
        <Button type="button" variant="ghost" size="icon" className="bots-details-close" aria-label={docked ? "Hide bot details" : "Close bot details"} onClick={close}><X aria-hidden="true" /></Button>
      </header>
      <div className="bots-details-nav" role="tablist" aria-label="Bot details sections">
        {tabs.map(({ id: value, label, icon: Icon }) => <Button type="button" variant="ghost" size="sm" key={value} id={`${id}-${value}`} role="tab" aria-selected={section === value} aria-controls={`${id}-${value}-panel`} tabIndex={section === value ? 0 : -1}
          onClick={() => onSection(value)} onKeyDown={event => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const index = tabs.findIndex(item => item.id === section);
            const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
            const target = tabs[next].id; onSection(target); document.getElementById(`${id}-${target}`)?.focus();
          }}><Icon size={17} aria-hidden="true" /><span>{label}</span></Button>)}
      </div>
      {sections.map(({ id: value }) => <Activity key={value} mode={section === value ? "visible" : "hidden"}>
        <div ref={value === "history" ? setHistoryScroll : undefined} className={`bots-details-panel is-${value}`} role="tabpanel" id={`${id}-${value}-panel`} aria-labelledby={`${id}-${value}`} tabIndex={0}>{value === "history" ? <HistoryScrollContext value={historyScroll}>{children[value]}</HistoryScrollContext> : children[value]}</div>
      </Activity>)}
    </section>
  </div>;
}
