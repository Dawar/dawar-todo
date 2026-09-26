"use client";

import { useEffect, useState } from "react";
import type { Bot, BotThreadUsage } from "../../lib/bots-types";
import { botsClient } from "./client";

function credits(micros: string) {
  if (!/^\d+$/.test(micros)) return null;
  const value = BigInt(micros);
  const whole = value / BigInt(1_000_000);
  const fraction = (value % BigInt(1_000_000)).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole.toLocaleString()}${fraction ? `.${fraction}` : ""}`;
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
      // Limit native usage reads when the list contains many bots.
      for (let i = 0; i < bots.length; i += 4) {
        if (canceled) break;
        const results = await Promise.all(bots.slice(i, i + 4).map(async (bot) => {
          try { return await botsClient.rpc<BotThreadUsage>("usage.bot", bot.id); }
          catch { return { botId: bot.id, threadId: bot.threadId,
            estimatedCreditsMicros: null, reason: "Native thread estimate unavailable." }; }
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
  const available = bots.map((bot) => usage[bot.id]).filter((item) =>
    item && item.estimatedCreditsMicros !== null && credits(item.estimatedCreditsMicros) !== null,
  );
  const total = available.reduce((sum, item) => sum + BigInt(item.estimatedCreditsMicros!), BigInt(0));
  return (
    <section className="bots-usage">
      <p className="bots-muted">Native Codex estimated credits for these bots’ own conversation threads. Worker threads and account-wide or Desktop activity are excluded. These are estimates, not billed charges.</p>
      {!online && <p>Connect to your VM to read usage.</p>}
      {online && loading && <p>Reading thread estimates…</p>}
      {bots.length > 1 && <p><strong>{available.length ? `${credits(String(total))} estimated credits` : "No estimates available"}</strong> across {available.length} of {bots.length} bot threads.</p>}
      {!bots.length && <p>No bots yet.</p>}
      {bots.map((bot) => {
        const item = usage[bot.id];
        return <div className="bots-usage-row" key={bot.id}>
          <strong>{bot.name}</strong>
          <span>{item?.estimatedCreditsMicros != null ? `${credits(item.estimatedCreditsMicros) ?? "Unavailable"} estimated credits` : item?.reason ?? (online ? "Loading…" : "Unavailable")}</span>
        </div>;
      })}
    </section>
  );
}
