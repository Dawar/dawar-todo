"use client";
import { memo, useMemo, useRef, useState } from "react";
import { LoaderCircle, Zap } from "lucide-react";
import type { Bot, BotSnapshot } from "../../lib/bots-types";
const HEIGHT = 96;
const SidebarRow = memo(function SidebarRow({ bot: b, selected, select, modelName, effort, fast }: {
  bot: Bot; selected: boolean; select: (id: string) => void; modelName: string; effort: string; fast: boolean;
}) {
  return <button className={`bots-row ${selected ? "selected" : ""}`} style={{ height: HEIGHT - 3 }} onClick={() => select(b.id)}>
    <span className="bots-avatar" style={{ background: b.color }}>{b.name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join("").toUpperCase()}</span>
    <span className="bots-row-copy"><span className="bots-row-name"><span className="bots-row-title">{b.name}</span><small>{new Date(b.updatedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</small></span>
      <span className="bots-row-preview">{b.status === "waiting" ? "Needs your input" : b.preview || b.purpose || "Start a conversation"}</span>
      <span className="bots-row-config"><span className="bots-row-model" title={modelName}>{modelName}</span><span aria-hidden="true">·</span><span>{effort}</span>{fast && <span className="bots-row-fast" role="img" aria-label="Fast mode"><Zap size={12} /></span>}</span>
    </span>{b.updatedAt > b.lastReadAt && <span className="bots-unread" />}{(b.status === "running" || Boolean(b.workerTasks?.active)) && <LoaderCircle size={14} className="bots-spin" />}
  </button>;
});
export const BotSidebarList = memo(function BotSidebarList({ bots, snapshot, selected, select, empty }: {
  bots: Bot[]; snapshot: BotSnapshot | null; selected: string | null; select: (id: string) => void; empty: string;
}) {
  const [top, setTop] = useState(0), ref = useRef<HTMLDivElement>(null);
  const models = useMemo(() => new Map(snapshot?.models.map((model) => [model.model, model.displayName])), [snapshot?.models]);
  const start = Math.min(Math.max(0, bots.length - 1), Math.max(0, Math.floor(top / HEIGHT) - 3));
  const end = Math.min(bots.length, start + 20);
  return <div className="bots-list" ref={ref} onScroll={(e) => setTop(e.currentTarget.scrollTop)} onKeyDown={(event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const index = bots.findIndex((bot) => bot.id === selected), next = Math.max(0, Math.min(bots.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
    if (bots[next]) { event.preventDefault(); select(bots[next].id); ref.current?.scrollTo(0, next * HEIGHT); }
  }}>
    <div style={{ height: start * HEIGHT }} aria-hidden="true" />
    {bots.slice(start, end).map((b) => {
      const modelId = b.model ?? snapshot?.defaults.model ?? "Default model", tier = b.serviceTier ?? snapshot?.defaults.serviceTier;
      return <SidebarRow key={b.id} bot={b} selected={b.id === selected} select={select} modelName={models.get(modelId) ?? modelId} effort={b.effort ?? snapshot?.defaults.effort ?? "default"} fast={tier === "priority" || tier === "fast"} />;
    })}<div style={{ height: (bots.length - end) * HEIGHT }} aria-hidden="true" />
    {!bots.length && <div className="bots-sidebar-empty">{empty}</div>}
  </div>;
});
