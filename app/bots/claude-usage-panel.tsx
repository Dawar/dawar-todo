"use client";

import { useCallback, useEffect, useState } from "react";
import type { Bot, BotClaudeUsage, BotClaudeUsageTotals } from "../../lib/bots-types";
import { botsClient } from "./client";
import { QuotaWindow } from "./quota-window";
import { Button } from "@/components/ui/button";

const WINDOWS: Record<string, { minutes: number | null; name: string }> = {
  five_hour: { minutes: 300, name: "Session limit" },
  seven_day: { minutes: 10080, name: "Weekly limit" },
  seven_day_opus: { minutes: 10080, name: "Weekly Opus limit" },
  seven_day_sonnet: { minutes: 10080, name: "Weekly Sonnet limit" },
  overage: { minutes: null, name: "Extra usage" },
};
const STATUS = { allowed: "Within limits", allowed_warning: "Approaching the limit", rejected: "Limit reached" } as const;

/** Utilization arrives as a fraction; tolerate a percentage too. */
const usedPercent = (utilization: number | undefined) =>
  typeof utilization !== "number" ? Number.NaN : utilization <= 1 ? utilization * 100 : utilization;
const money = (usd: number) => usd.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 });

function Totals({ label, totals }: { label: string; totals: BotClaudeUsageTotals }) {
  return <div className="bots-usage-limit">
    <strong>{label}</strong>
    <span>{totals.turns.toLocaleString()} {totals.turns === 1 ? "turn" : "turns"} · {money(totals.costUsd)} estimated</span>
    <span className="bots-muted">{totals.inputTokens.toLocaleString()} input · {totals.outputTokens.toLocaleString()} output · {totals.cacheReadTokens.toLocaleString()} cached tokens</span>
  </div>;
}

export function ClaudeUsagePanel({ bot, accountBotId, online, owner }: { bot?: Bot; accountBotId: string; online: boolean; owner: string | null }) {
  const [usage, setUsage] = useState<BotClaudeUsage | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const reload = useCallback(() => setRefresh(value => value + 1), []);
  useEffect(() => {
    let canceled = false;
    if (!online) return;
    void (async () => {
      setLoading(true); setError(null);
      try {
        const value = await botsClient.rpc<BotClaudeUsage>("usage.claude", bot?.id ?? accountBotId);
        if (!canceled && botsClient.owner === owner) setUsage(value);
      } catch (e) {
        if (!canceled && botsClient.owner === owner) setError(e instanceof Error ? e.message : "Claude usage could not be read.");
      } finally {
        if (!canceled && botsClient.owner === owner) setLoading(false);
      }
    })();
    return () => { canceled = true; };
  }, [bot?.id, accountBotId, online, owner, refresh]);
  useEffect(() => {
    const receive = (event: { type: string; data: unknown }) => {
      if (event.type === "usage" && (event.data as { provider?: string })?.provider === "claude") reload();
    };
    botsClient.events.add(receive);
    return () => { botsClient.events.delete(receive); };
  }, [reload]);

  return <section className="bots-usage">
    <div className="bots-usage-heading">
      <strong>Claude account usage</strong>
      <Button variant="outline" type="button" onClick={reload} disabled={!online || loading}>Refresh</Button>
    </div>
    <p className="bots-muted">Claude bots share one Claude account. Its limits also cover any other Claude activity on that account; they are not per-bot allowances.</p>
    {!online && <p>Reconnect to view usage.</p>}
    {online && loading && !usage && <p role="status">Reading Claude usage…</p>}
    {online && error && <p role="alert">{error}</p>}
    {usage && <>
      {usage.rateLimits.length ? usage.rateLimits.map(limit => {
        const window = WINDOWS[limit.type] ?? { minutes: null, name: "Claude limit" };
        return <div className="bots-usage-limit" key={limit.type}>
          <strong>{window.name} · {STATUS[limit.status] ?? limit.status}{limit.isUsingOverage ? " · using extra usage" : ""}</strong>
          <QuotaWindow window={{ usedPercent: usedPercent(limit.utilization), windowDurationMins: window.minutes, resetsAt: limit.resetsAt ?? null }} />
          <small className="bots-muted">Observed {new Date(limit.observedAt).toLocaleString()}</small>
        </div>;
      }) : <p className="bots-muted">Claude reports its limits during conversations. They will appear after a Claude bot&apos;s next turn.</p>}
      <Totals label="Last 24 hours, all Claude bots" totals={usage.account.day} />
      <Totals label="Last 7 days, all Claude bots" totals={usage.account.week} />
      {bot && usage.thread && <>
        <Totals label={`${bot.name} · last 24 hours`} totals={usage.thread.day} />
        <Totals label={`${bot.name} · whole conversation`} totals={usage.thread.all} />
      </>}
      <p className="bots-muted">Costs are the Claude SDK&apos;s list-price estimates, not a bill. On a subscription, the limits above are what count.</p>
      <p className="bots-muted">Updated {new Date(usage.readAt).toLocaleString()}</p>
    </>}
  </section>;
}
