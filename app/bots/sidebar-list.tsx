"use client";
import { memo, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ChevronDown, LoaderCircle, Zap } from "lucide-react";
import type { Bot, BotSnapshot, BotTeam } from "../../lib/bots-types";
import { BotAvatar } from "./bot-avatar";
import { useSidebarPreferences } from './sidebar-preferences';
import { Button } from '@/components/ui/button';
import './sidebar-list.css';
import { useLocallyReadBots } from './local-read-state';
import { botProvider, providerDefaults } from "../../lib/bot-provider";
import { botKeyboardAvailable } from './bot-search-shortcut';
const HEIGHT = 96;
const TEAM_HEIGHT = 44;
const working = (bot: Bot) => Boolean(bot.activeTurnId || bot.status === "running" || bot.workerTasks?.active);
const unread = (bot: Bot) => bot.updatedAt > bot.lastReadAt;
const SidebarRow = memo(function SidebarRow({ bot: b, selected, select, modelName, effort, fast, team }: {
  bot: Bot; selected: boolean; select: (id: string) => void; modelName: string; effort: string; fast: boolean; team?: BotTeam;
}) {
  return <button type="button" data-bot-id={b.id} aria-current={selected ? "true" : undefined} className={`bots-row ${selected ? "selected" : ""}`} style={{ height: HEIGHT - 3 }} onClick={() => select(b.id)}>
    <BotAvatar bot={b} decorative />
    <span className="bots-row-copy"><span className="bots-row-name"><span className="bots-row-title">{b.extension&&<span className="bots-extension" title="Ctrl (or Alt) + extension switches bots; add Shift to move the composer">#{b.extension}</span>}{b.name}</span></span>
      <span className="bots-row-preview">{b.status === "waiting" ? "Needs your input" : b.preview || b.purpose || "Start a conversation"}</span>
      <span className="bots-row-config"><span className="bots-row-model" title={modelName}>{modelName}</span><span aria-hidden="true">·</span><span>{effort}</span>{team&&<span className="bots-row-team" style={{color:team.color}} title={team.name}><i/>{team.name}</span>}{fast && <span className="bots-row-fast" role="img" aria-label="Fast mode"><Zap size={12} /></span>}<small className="bots-row-time">{new Date(b.updatedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</small></span>
    </span>{working(b) && <span className="bots-row-working" role="img" aria-label="Working"><LoaderCircle size={18} className="bots-spin" aria-hidden="true" /></span>}{unread(b) && <span className="bots-unread" role="img" aria-label="Unread messages" />}
  </button>;
});
type ListRow = { kind: "heading"; id: string; name: string; color?: string; count: number; offset: number; height: number } | { kind: "bot"; id: string; bot: Bot; offset: number; height: number };
export type SidebarFocusIntent = { id: string; owner: string; origin: HTMLElement; top?: number };
export const BotSidebarList = memo(function BotSidebarList({ owner, search = '', bots: suppliedBots, snapshot, selected, select, navigate = select, focusIntent, empty }: {
  owner: string; search?: string; bots: Bot[]; snapshot: BotSnapshot | null; selected: string | null; select: (id: string) => void; navigate?: (id: string) => void; focusIntent?: RefObject<SidebarFocusIntent | null>; empty: string;
}) {
  const bots = useLocallyReadBots(owner, suppliedBots);
  const [top, setTop] = useState(0);
  const { store, state: preferences } = useSidebarPreferences(owner);
  const searching = Boolean(search.trim());
  const collapsed = useMemo(() => new Set([...Object.keys(preferences.choices), ...Object.values(preferences.pending).map(p => p.request.teamId)].filter(key => store.collapsed(key))), [preferences, store]);
  const ref = useRef<HTMLDivElement>(null), id = useId();
  const localFocus = useRef<SidebarFocusIntent | null>(null), pendingFocus = focusIntent ?? localFocus;

  const models = useMemo(() => new Map(snapshot?.models.map(model => [model.model, model.displayName])), [snapshot?.models]);
  const teams = useMemo(() => new Map(snapshot?.teams?.map(team => [team.id, team])), [snapshot?.teams]);
  const rows = useMemo(() => {
    const assigned = (bot: Bot) => Boolean(bot.teamId && teams.has(bot.teamId));
    const result: ListRow[] = []; let offset = 0;
    const append = (bot: Bot) => { result.push({ kind: "bot", id: bot.id, bot, offset, height: HEIGHT }); offset += HEIGHT; };
    // Working bots lead, then unread, then unassigned. Keep the chosen order
    // within each priority; hoisted bots never repeat under a team.
    for (const bot of bots) if (working(bot)) append(bot);
    for (const bot of bots) if (!working(bot) && unread(bot)) append(bot);
    for (const bot of bots) if (!working(bot) && !unread(bot) && !assigned(bot)) append(bot);
    const groups = new Map<string, Bot[]>();
    // Groups follow the configured team order; row order keeps the selected filter/sort.
    for (const team of snapshot?.teams ?? []) groups.set(team.id, []);
    for (const bot of bots) { if (working(bot) || unread(bot) || !assigned(bot)) continue; const key = bot.teamId && teams.has(bot.teamId) ? bot.teamId : "unassigned"; if (!groups.has(key)) groups.set(key, []); groups.get(key)!.push(bot); }
    for (const [key, members] of groups) {
      if (!members.length) continue;
      const team = teams.get(key);
      result.push({ kind: "heading", id: key, name: team?.name ?? "Bots", color: team?.color, count: members.length, offset, height: TEAM_HEIGHT }); offset += TEAM_HEIGHT;
      if (searching || !collapsed.has(key)) for (const bot of members) append(bot);
    }
    return result;
  }, [bots, snapshot?.teams, teams, collapsed, searching]);
  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    const root = ref.current;
    if (pending.owner !== owner || !root || !botKeyboardAvailable(root) || !rows.some(row => row.kind === 'bot' && row.id === pending.id) ||
        document.activeElement !== pending.origin && document.activeElement !== document.body) { pendingFocus.current = null; return; }
    if (pending.top !== undefined) { root.scrollTop = pending.top; delete pending.top; }
    const member = rows.find(row => row.kind === 'bot' && row.id === pending.id)!;
    const top = root.scrollTop;
    const nextTop = member.offset < top ? member.offset : member.offset + member.height > top + root.clientHeight ? member.offset + member.height - root.clientHeight : top;
    root.scrollTop = Math.max(0, nextTop); setTop(root.scrollTop);
    const target = [...(ref.current?.querySelectorAll<HTMLButtonElement>(".bots-row") ?? [])].find(row => row.dataset.botId === pending.id);
    if (target?.getClientRects().length) { pendingFocus.current = null; target.focus({ preventScroll: true }); }
  }, [pendingFocus, owner, rows]);
  const total = rows.at(-1) ? rows.at(-1)!.offset + rows.at(-1)!.height : 0;
  const viewport = ref.current?.clientHeight || 900;
  const safeTop = Math.min(top, Math.max(0, total - viewport));
  const visible = rows.filter(row => row.offset + row.height >= safeTop - HEIGHT * 3 && row.offset <= safeTop + viewport + HEIGHT * 3);
  return <div className="bots-list" ref={ref} role="navigation" aria-label="Bot conversations" tabIndex={0} aria-keyshortcuts="ArrowUp ArrowDown" title="Use Up and Down to select a bot" onScroll={event => setTop(event.currentTarget.scrollTop)} onPointerDown={event => {
    if (event.button === 0 && (event.target === event.currentTarget || event.target instanceof HTMLElement && event.target.parentElement === event.currentTarget && event.target.getAttribute('aria-hidden') === 'true')) event.currentTarget.focus({ preventScroll: true });
  }} onKeyDown={event => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key) || event.defaultPrevented || event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !botKeyboardAvailable(event.currentTarget)) return;
    const target = event.target as HTMLElement, origin = target.closest<HTMLElement>('.bots-row,.bots-team-heading') ?? event.currentTarget;
    if (target !== event.currentTarget && (!event.currentTarget.contains(origin) || target.closest('button') !== origin)) return;
    const members = rows.filter((row): row is Extract<ListRow, { kind: "bot" }> => row.kind === "bot");
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    const heading = origin.dataset.teamId && rows.find(row => row.kind === 'heading' && row.id === origin.dataset.teamId);
    const index = members.findIndex(row => row.id === (origin.dataset.botId ?? selected));
    const next = heading ? (direction > 0 ? members.find(row => row.offset > heading.offset) ?? members.at(-1) : [...members].reverse().find(row => row.offset < heading.offset) ?? members[0])
      : members[index < 0 ? direction > 0 ? 0 : members.length - 1 : Math.max(0, Math.min(members.length - 1, index + direction))];
    event.preventDefault();
    if (!next) return;
    const root = event.currentTarget, top = root.scrollTop;
    const nextTop = next.offset < top ? next.offset : next.offset + next.height > top + root.clientHeight ? next.offset + next.height - root.clientHeight : top;
    root.scrollTo(0, Math.max(0, nextTop)); setTop(root.scrollTop);
    pendingFocus.current = { id: next.id, owner, origin, top: root.scrollTop };
    if (next.id !== selected) navigate(next.id);
    // A boundary key may keep the same selection without a React commit.
    const mounted = [...root.querySelectorAll<HTMLButtonElement>('.bots-row')].find(row => row.dataset.botId === next.id);
    if (next.id === selected && mounted?.getClientRects().length) { pendingFocus.current = null; mounted.focus({ preventScroll: true }); }
  }}>
    <div style={{ height: visible[0]?.offset ?? 0 }} aria-hidden="true" />
    {visible.map(row => row.kind === "heading" ? <button key={`group:${row.id}`} type="button" data-team-id={row.id} className="bots-team-heading" style={{ height: row.height }} aria-expanded={searching || !collapsed.has(row.id)} aria-disabled={searching || undefined} aria-label={`${row.name}, ${row.count} ${row.count === 1 ? "bot" : "bots"}`} onClick={() => { if (!searching) store.toggle(row.id); }}>
      <ChevronDown size={15} className={!searching && collapsed.has(row.id) ? "is-collapsed" : ""} aria-hidden="true" /><span className="bots-team-dot" style={{ background: row.color ?? "var(--muted-foreground)" }} aria-hidden="true" /><span id={`${id}-${row.id}`}>{row.name}</span><small>{row.count}</small>
    </button> : <div key={row.id} style={{ height: row.height }}>{(() => {
      const b = row.bot, defaults = snapshot ? providerDefaults(snapshot, b) : null;
      const modelId = b.model ?? defaults?.model ?? "Default model", tier = botProvider(b) === "claude" ? null : b.serviceTier ?? defaults?.serviceTier;
      return <SidebarRow bot={b} selected={b.id === selected} select={select} modelName={models.get(modelId) ?? modelId} effort={b.effort ?? defaults?.effort ?? "default"} fast={tier === "priority" || tier === "fast"} />;
    })()}</div>)}
    <div style={{ height: Math.max(0, total - (visible.at(-1) ? visible.at(-1)!.offset + visible.at(-1)!.height : 0)) }} aria-hidden="true" />
    {!bots.length && <div className="bots-sidebar-empty" role="status">{empty}</div>}
    {preferences.error && <p className="bots-system-note" role="status">{preferences.error} <Button type="button" variant="outline" onClick={() => void store.sync()}>Retry</Button></p>}
  </div>;
});
