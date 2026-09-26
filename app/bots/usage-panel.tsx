"use client";

import { useCallback, useEffect, useState } from "react";
import type { Bot, BotAccountQuota, BotThreadUsage, BotUsageMetric } from "../../lib/bots-types";
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
  if (value === null) return null;
  const partial = groupCount && metric?.reportedGroups !== groupCount
    ? ` (partial: ${metric?.reportedGroups ?? 0}/${groupCount} groups)` : "";
  return `${value.toLocaleString()}${partial}`;
}

function duration(minutes: number | null) {
  if (minutes === null) return "Quota window";
  if (minutes === 10080) return "Weekly window";
  if (minutes % 1440 === 0) return `${minutes / 1440}-day window`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour window`;
  return `${minutes}-minute window`;
}

function percentage(value: number) {
  return `${Number(value.toFixed(1))}%`;
}

function resetTime(seconds: number | null) {
  if (seconds === null) return "Reset time unavailable";
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? "Reset time unavailable"
    : `Resets ${date.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })}`;
}

export function UsagePanel({ bot, online }: { bot?: Bot; online: boolean }) {
  const [quota, setQuota] = useState<BotAccountQuota | null>(null);
  const [usage, setUsage] = useState<BotThreadUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const refreshUsage = useCallback(() => setRefresh((value) => value + 1), []);
  const botId = bot?.id;

  useEffect(() => {
    let canceled = false;
    if (!online) return;
    void (async () => {
      setQuota(null);
      setUsage(null);
      setLoading(true);
      const [quotaResult, threadResult] = await Promise.all([
        botsClient.rpc<BotAccountQuota>("usage.account").catch(() => null),
        botId ? botsClient.rpc<BotThreadUsage>("usage.bot", botId).catch(() => null) : Promise.resolve(null),
      ]);
      if (canceled) return;
      setQuota(quotaResult);
      setUsage(threadResult);
      setLoading(false);
    })();
    return () => { canceled = true; };
  }, [botId, online, refresh]);

  const resetCredits = safeInteger(quota?.availableResetCredits);
  const creditValue = safeInteger(usage?.estimatedCreditsMicros);
  const reportedTokens = tokenFields.map(({ key, label }) => ({
    key, label, text: tokenText(usage?.tokens?.[key], usage?.groupCount),
  })).filter((item) => item.text !== null);
  const hasThreadUsage = creditValue !== null || reportedTokens.length > 0;

  return <section className="bots-usage">
    <div className="bots-usage-heading">
      <strong>Account-wide Codex usage</strong>
      <button type="button" onClick={refreshUsage} disabled={!online || loading}>Refresh</button>
    </div>
    <p className="bots-muted">This quota is shared with other Codex activity on the same account. It cannot be assigned to individual bots.</p>
    {!online && <p>Connect to your VM to read usage.</p>}
    {online && loading && <p>Reading account usage…</p>}
    {online && !loading && !quota && <p>Account usage is unavailable right now. Try refreshing.</p>}
    {online && !loading && quota && <>
      {quota.accountType === "chatgpt" && <p className="bots-muted">Included ChatGPT plan limits. These percentages are quota, not token counts.</p>}
      {quota.accountType === "apiKey" && <p className="bots-muted">API-key rate limits. Included ChatGPT plan limits are not available for this sign-in.</p>}
      {quota.accountType === "amazonBedrock" && <p className="bots-muted">Bedrock account limits, when reported by Codex.</p>}
      {quota.reason && <p>{quota.reason}</p>}
      {resetCredits !== null && <div className="bots-usage-credit"><strong>{resetCredits.toLocaleString()}</strong><span>reset {resetCredits === BigInt(1) ? "credit" : "credits"} available</span></div>}
      {quota.accountType === "chatgpt" && quota.ordinaryUsageAllowed === false && <p>Ordinary included usage is currently unavailable.</p>}
      {quota.limits.map((limit, index) => <div className="bots-usage-limit" key={`${limit.limitId ?? "default"}-${index}`}>
        <strong>{limit.limitName || limit.limitId || "Codex quota"}{limit.model ? ` · ${limit.model}` : ""}</strong>
        {limit.windows.map((window, windowIndex) => <div className="bots-usage-window" key={windowIndex}>
          <span>{duration(window.windowDurationMins)}</span>
          <span><strong>{percentage(window.usedPercent)}</strong> used · <strong>{percentage(Math.max(0, 100 - window.usedPercent))}</strong> remaining</span>
          <span>{resetTime(window.resetsAt)}</span>
          <div className="bots-usage-meter" role="meter" aria-label={`${duration(window.windowDurationMins)} used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, window.usedPercent)}><span style={{ width: `${Math.min(100, window.usedPercent)}%` }} /></div>
        </div>)}
      </div>)}
      {!quota.reason && resetCredits === null && !quota.limits.some((limit) => limit.windows.length) && <p>No quota details were reported for this account.</p>}
      <p className="bots-muted">Updated {new Date(quota.readAt).toLocaleString()}</p>
    </>}
    {bot && <div className="bots-usage-thread">
      <strong>{bot.name} conversation thread</strong>
      {online && loading && <span>Reading thread estimate…</span>}
      {online && !loading && hasThreadUsage && <>
        {creditValue !== null && <span>{credits(creditValue)} estimated credits</span>}
        {reportedTokens.map((item) => <span key={item.key}>{item.label}: {item.text}</span>)}
        <span className="bots-muted">Native thread estimates may be partial; they are separate from account quota.</span>
      </>}
      {online && !loading && !hasThreadUsage && <span className="bots-muted">{usage?.reason || "Native Codex did not report a per-thread estimate for this bot."} Account quota above includes all Codex activity.</span>}
      {!online && <span className="bots-muted">Thread estimate unavailable while offline.</span>}
    </div>}
  </section>;
}
