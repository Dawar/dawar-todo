"use client";
import { Activity, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { Compass, FolderOpen, ListTodo, Settings2, Wrench, X } from "lucide-react";
import { DETAILS_TABS, SECTION_LABELS, detailsLocation, tabSection, type BotDetailsLeaf, type BotDetailsSection, type BotDetailsTab } from "./bot-details-sections";
import type { Bot } from "../../lib/bots-types";
import "./bot-details.css";
import { Button } from "@/components/ui/button";
import { HistoryScrollContext } from "./history-scroll-context";

export { DEFAULT_DETAILS_SECTION, type BotDetailsSection } from "./bot-details-sections";
const tabIcons: Record<BotDetailsTab, typeof Compass> = { overview: Compass, work: ListTodo, files: FolderOpen, tools: Wrench, settings: Settings2 };

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
  onClose: () => void; docked: boolean; returnFocus?: () => HTMLElement | null; children: Record<BotDetailsLeaf, ReactNode>;
}) {
  const location = detailsLocation(section);
  // Each tab reopens on the subsection last used in it during this panel's life.
  const remembered = useRef<Partial<Record<BotDetailsTab, BotDetailsLeaf>>>({});
  useEffect(() => { remembered.current[location.tab] = location.leaf; }, [location.tab, location.leaf]);
  const panel = useRef<HTMLElement>(null), id = useId();
  const [historyScroll, setHistoryScroll] = useState<HTMLDivElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  // A deep link to a Settings group (for example the old Team section)
  // scrolls that group into view once its tab is visible.
  useEffect(() => {
    if (!location.anchor) return;
    const frame = requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>(`[data-details-anchor="${location.anchor}"]`)?.scrollIntoView({ block: "start" }));
    return () => cancelAnimationFrame(frame);
  }, [section, location.anchor]);
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
      <div className="bots-details-nav" role="tablist" aria-label="Bot details">
        {DETAILS_TABS.map(({ id: value, label }) => { const Icon = tabIcons[value]; return <Button type="button" variant="ghost" size="sm" key={value} id={`${id}-${value}`} role="tab" aria-selected={location.tab === value} aria-controls={`${id}-${value}-panel`} tabIndex={location.tab === value ? 0 : -1}
          onClick={() => { if (location.tab !== value) onSection(tabSection(value, remembered.current)); }}
          onKeyDown={event => roving(event, DETAILS_TABS.map(tab => tab.id), location.tab, next => { onSection(tabSection(next, remembered.current)); document.getElementById(`${id}-${next}`)?.focus(); })}>
          <Icon size={17} aria-hidden="true" /><span>{label}</span></Button>; })}
      </div>
      {DETAILS_TABS.map(({ id: value, label, sections }) => <Activity key={value} mode={location.tab === value ? "visible" : "hidden"}>
        <div className="bots-details-tab" role="tabpanel" id={`${id}-${value}-panel`} aria-labelledby={`${id}-${value}`}>
          {sections.length > 1 && <div className="bots-details-subnav" role="tablist" aria-label={`${label} sections`}>
            {sections.map(leaf => <Button type="button" variant="ghost" size="sm" key={leaf} id={`${id}-${leaf}`} role="tab" aria-selected={location.leaf === leaf} aria-controls={`${id}-${leaf}-panel`} tabIndex={location.leaf === leaf ? 0 : -1}
              onClick={() => onSection(leaf)} onKeyDown={event => roving(event, sections, location.leaf, next => { onSection(next); document.getElementById(`${id}-${next}`)?.focus(); })}>{SECTION_LABELS[leaf]}</Button>)}
          </div>}
          {sections.map(leaf => <Activity key={leaf} mode={location.leaf === leaf ? "visible" : "hidden"}>
            <div ref={leaf === "history" ? setHistoryScroll : undefined} className={`bots-details-panel is-${leaf}`} tabIndex={0}
              {...(sections.length > 1 ? { role: "tabpanel", id: `${id}-${leaf}-panel`, "aria-labelledby": `${id}-${leaf}` } : { "aria-label": label })}>
              {leaf === "history" ? <HistoryScrollContext value={historyScroll}>{children[leaf]}</HistoryScrollContext> : children[leaf]}
            </div>
          </Activity>)}
        </div>
      </Activity>)}
    </section>
  </div>;
}

/** Arrow/Home/End roving focus for a tablist; the caller moves selection. */
function roving<T extends string>(event: KeyboardEvent, items: readonly T[], current: T, move: (next: T) => void) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const index = items.indexOf(current);
  const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + items.length) % items.length;
  move(items[next]);
}
