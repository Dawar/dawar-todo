"use client";

import { useEffect, useState } from "react";
import type { Bot, BotThreadUsage, BotUsageMetric } from "../../lib/bots-types";
import { botsClient } from "./client";

type TokenField = keyof NonNullable<BotThreadUsage["tokens"]>;
const tokenFields: { key: TokenField; label: string }[] = [
  { key: "total", label: "Total tokens" },
  { key: "input", label: "Input" },
  { key: "output", label: "Output" },
  { key: "cachedInput", label: "Cached input" },
  { key: "netNewInput", label: "Net new input" },
];

function safeInteger(value: string | null | undefined) {
  return value && /^\d+$/.test(value) ? BigInt(value) : null;
}

function credits(micros: bigint) {
  const whole = micros / BigInt(1_000_000);
  const fraction = (micros % BigInt(1_000_000)).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole.toLocaleString()}${fraction ? `.${fraction}` : ""}`;
}

function tokenText(metric: BotUsageMetric | undefined, groupCount: number | undefined) {
  const value = safeInteger(metric?.value);
  if (value === null) return "Unavailable";
  const partial = groupCount && metric?.reportedGroups !== groupCount
    ? ` (partial: ${metric?.reportedGroups ?? 0}/${groupCount} groups)` : "";
  return `${value.toLocaleString()}${partial}`;
}

function aggregate(items: BotThreadUsage[], select: (item: BotThreadUsage) => string | null | undefined,
  field?: TokenField) {
  let value = BigInt(0), count = 0, partialGroups = false;
  for (const item of items) {
    const number = safeInteger(select(item));
    if (number === null) continue;
    value += number;
    count++;
    if (field && item.groupCount && item.tokens?.[field]?.reportedGroups !== item.groupCount)
      partialGroups = true;
  }
  return { value, count, partialGroups };
}

function coverage(count: number, total: number, partialGroups = false) {
  return `from ${count} of ${total} bot threads${count < total || partialGroups ? " (incomplete)" : ""}${partialGroups ? "; some groups did not report this field" : ""}`;
}

export function UsagePanel({ bots, online }: { bots: Bot[]; online: boolean }) {
  const [usage, setUsage] = useState<Record<string, BotThreadUsage>>({});
  const [loading, setLoading] = useState(false);
  const ids = bots.map((bot) => bot.id).join(",");
  useEffect(() => {
    let canceled = false;
    if (!online || !bots.length) return;
    void (async () => {
      setUsage({});
      setLoading(true);
      // Limit concurrent native reads when the list contains many bots.
      for (let i = 0; i < bots.length; i += 4) {
        if (canceled) break;
        const results = await Promise.all(bots.slice(i, i + 4).map(async (bot) => {
          try { return await botsClient.rpc<BotThreadUsage>("usage.bot", bot.id); }
          catch { return { botId: bot.id, threadId: bot.threadId,
            estimatedCreditsMicros: null, reason: "Native thread usage unavailable." }; }
        }));
        if (!canceled) setUsage((current) => Object.fromEntries([
          ...Object.entries(current), ...results.map((item) => [item.botId, item]),
        ]));
      }
      if (!canceled) setLoading(false);
    })();
    return () => { canceled = true; };
  // ids changes when the viewed bot set changes; a snapshot refresh alone does not requery.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, online]);

  const items = online ? bots.map((bot) => usage[bot.id]).filter((item): item is BotThreadUsage => Boolean(item)) : [];
  const creditTotal = aggregate(items, (item) => item.estimatedCreditsMicros);
  const tokenTotals = tokenFields.map(({ key, label }) => ({
    key, label, ...aggregate(items, (item) => item.tokens?.[key]?.value, key),
  }));
  return <section className="bots-usage">
    <p className="bots-muted">Native Codex usage for these bots’ own conversation threads. Worker threads and account-wide or Desktop activity are excluded. Credits are estimates, not billed charges. Token fields are shown separately and are not added together.</p>
    {!online && <p>Connect to your VM to read usage.</p>}
    {online && loading && <p>Reading thread usage…</p>}
    {bots.length > 1 && <div className="bots-usage-total">
      <strong>Overall bot threads</strong>
      <span>{creditTotal.count ? `${credits(creditTotal.value)} estimated credits` : "Estimated credits unavailable"} · {coverage(creditTotal.count, bots.length)}</span>
      {tokenTotals.map((metric) => <span key={metric.key}>{metric.label}: {metric.count ? metric.value.toLocaleString() : "Unavailable"} · {coverage(metric.count, bots.length, metric.partialGroups)}</span>)}
    </div>}
    {!bots.length && <p>No bots yet.</p>}
    {bots.map((bot) => {
      const item = online ? usage[bot.id] : undefined;
      const creditValue = safeInteger(item?.estimatedCreditsMicros);
      return <div className="bots-usage-row" key={bot.id}>
        <strong>{bot.name}</strong>
        {!item ? <span>{online ? "Loading…" : "Unavailable while offline"}</span> : <>
          <span>{creditValue === null ? "Estimated credits unavailable" : `${credits(creditValue)} estimated credits`}</span>
          {tokenFields.map(({ key, label }) => <span key={key}>{label}: {tokenText(item.tokens?.[key], item.groupCount)}</span>)}
          {item.reason && <span>{item.reason}</span>}
        </>}
      </div>;
    })}
  </section>;
}
