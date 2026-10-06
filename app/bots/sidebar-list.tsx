"use client";
import { memo, useId, useMemo, useRef, useState } from "react";
import { ChevronDown, LoaderCircle, Zap } from "lucide-react";
import type { Bot, BotSnapshot, BotTeam } from "../../lib/bots-types";
import { BotAvatar } from "./bot-avatar";
import { useSidebarPreferences } from './sidebar-preferences';
const HEIGHT = 96;
const working = (bot: Bot) => Boolean(bot.activeTurnId || bot.status === "running" || bot.workerTasks?.active);
const unread = (bot: Bot) => bot.updatedAt > bot.lastReadAt;
const SidebarRow = memo(function SidebarRow({ bot: b, selected, select, modelName, effort, fast, team }: {
  bot: Bot; selected: boolean; select: (id: string) => void; modelName: string; effort: string; fast: boolean; team?: BotTeam;
}) {
  return <button className={`bots-row ${selected ? "selected" : ""}`} style={{ height: HEIGHT - 3 }} onClick={() => select(b.id)}>
    <BotAvatar bot={b} />
    <span className="bots-row-copy"><span className="bots-row-name"><span className="bots-row-title">{b.extension&&<span className="bots-extension" title="Ctrl (or Alt) + extension switches bots; add Shift to move the composer">#{b.extension}</span>}{b.name}</span><small>{new Date(b.updatedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</small></span>
      <span className="bots-row-preview">{b.status === "waiting" ? "Needs your input" : b.preview || b.purpose || "Start a conversation"}</span>
      <span className="bots-row-config"><span className="bots-row-model" title={modelName}>{modelName}</span><span aria-hidden="true">·</span><span>{effort}</span>{team&&<span className="bots-row-team" style={{color:team.color}} title={team.name}><i/>{team.name}</span>}{fast && <span className="bots-row-fast" role="img" aria-label="Fast mode"><Zap size={12} /></span>}</span>
    </span>{working(b) && <span className="bots-row-working" role="img" aria-label="Working"><LoaderCircle size={18} className="bots-spin" aria-hidden="true" /></span>}{unread(b) && <span className="bots-unread" />}
  </button>;
});
type ListRow = { kind: "heading"; id: string; name: string; color?: string; count: number; offset: number; height: number } | { kind: "bot"; id: string; bot: Bot; offset: number; height: number };
export const BotSidebarList = memo(function BotSidebarList({ owner, search = '', bots, snapshot, selected, select, empty }: {
  owner: string; search?: string; bots: Bot[]; snapshot: BotSnapshot | null; selected: string | null; select: (id: string) => void; empty: string;
}) {
  const [top, setTop] = useState(0);
  const { store, state: preferences } = useSidebarPreferences(owner);
  const searching = Boolean(search.trim());
  const collapsed = useMemo(() => new Set([...Object.keys(preferences.choices), ...Object.values(preferences.pending).map(p => p.request.teamId)].filter(key => store.collapsed(key))), [preferences, store]);
  const ref = useRef<HTMLDivElement>(null), id = useId();
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
      result.push({ kind: "heading", id: key, name: team?.name ?? "Bots", color: team?.color, count: members.length, offset, height: 42 }); offset += 42;
      if (searching || !collapsed.has(key)) for (const bot of members) append(bot);
    }
    return result;
  }, [bots, snapshot?.teams, teams, collapsed, searching]);
  const total = rows.at(-1) ? rows.at(-1)!.offset + rows.at(-1)!.height : 0;
  const viewport = ref.current?.clientHeight || 900;
  const safeTop = Math.min(top, Math.max(0, total - viewport));
  const visible = rows.filter(row => row.offset + row.height >= safeTop - HEIGHT * 3 && row.offset <= safeTop + viewport + HEIGHT * 3);
  return <div className="bots-list" ref={ref} onScroll={event => setTop(event.currentTarget.scrollTop)} onKeyDown={event => {
    if ((event.key !== "ArrowDown" && event.key !== "ArrowUp") || !(event.target as HTMLElement).closest(".bots-row")) return;
    const members = rows.filter((row): row is Extract<ListRow, { kind: "bot" }> => row.kind === "bot");
    const index = members.findIndex(row => row.id === selected), next = members[Math.max(0, Math.min(members.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))];
    if (next) { event.preventDefault(); select(next.id); ref.current?.scrollTo(0, next.offset); }
  }}>
    <div style={{ height: visible[0]?.offset ?? 0 }} aria-hidden="true" />
    {visible.map(row => row.kind === "heading" ? <button key={`group:${row.id}`} type="button" className="bots-team-heading" style={{ height: row.height }} aria-expanded={searching || !collapsed.has(row.id)} aria-disabled={searching || undefined} aria-label={`${row.name}, ${row.count} ${row.count === 1 ? "bot" : "bots"}`} onClick={() => { if (!searching) store.toggle(row.id); }}>
      <ChevronDown size={15} className={!searching && collapsed.has(row.id) ? "is-collapsed" : ""} aria-hidden="true" /><span className="bots-team-dot" style={{ background: row.color ?? "#8a978e" }} aria-hidden="true" /><span id={`${id}-${row.id}`}>{row.name}</span><small>{row.count}</small>
    </button> : <div key={row.id} style={{ height: row.height }}>{(() => {
      const b = row.bot, modelId = b.model ?? snapshot?.defaults.model ?? "Default model", tier = b.serviceTier ?? snapshot?.defaults.serviceTier;
      return <SidebarRow bot={b} selected={b.id === selected} select={select} modelName={models.get(modelId) ?? modelId} effort={b.effort ?? snapshot?.defaults.effort ?? "default"} fast={tier === "priority" || tier === "fast"} />;
    })()}</div>)}
    <div style={{ height: Math.max(0, total - (visible.at(-1) ? visible.at(-1)!.offset + visible.at(-1)!.height : 0)) }} aria-hidden="true" />
    {!bots.length && <div className="bots-sidebar-empty">{empty}</div>}
    {preferences.error && <p className="bots-system-note" role="status">{preferences.error} <button type="button" onClick={() => void store.sync()}>Retry saving team choices</button></p>}
  </div>;
});
