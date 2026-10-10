"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Bot, BotAccountQuota, BotThreadUsage, BotUsageMetric } from "../../lib/bots-types";
import { botsClient } from "./client";
import { QuotaWindow } from "./quota-window";
import { UsageHistoryView } from "./usage-history";
import type { UsageHistory, UsageHistoryRange } from "../../lib/usage-history";
import "./usage-history.css";

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

export function UsagePanel({ bot, online }: { bot?: Bot; online: boolean }) {
  useSyncExternalStore(botsClient.subscribe, () => `${botsClient.owner}:${botsClient.snapshot?.capabilities?.accountUsageHistory ?? 0}`, () => "");
  const owner = botsClient.owner, historySupported = botsClient.snapshot?.capabilities?.accountUsageHistory === 1;
  return <UsagePanelContents key={owner} bot={bot} online={online} owner={owner} historySupported={historySupported} />;
}
function UsagePanelContents({ bot, online, owner, historySupported }: { bot?: Bot; online: boolean; owner: string | null; historySupported: boolean }) {
  const [dataOwner, setDataOwner] = useState(owner);
  const [storedQuota, setQuota] = useState<BotAccountQuota | null>(null);
  const [storedUsage, setUsage] = useState<BotThreadUsage | null>(null);
  const quota = dataOwner === owner ? storedQuota : null, usage = dataOwner === owner ? storedUsage : null;
  const [historyData, setHistoryData] = useState<{ owner: string; value: UsageHistory; receivedAt: number } | null>(null);
  const [historyTime, setHistoryTime] = useState(() => Date.now());
  const scopedHistory = historyData?.owner === owner ? historyData.value : null;
  // Age saved server observations using elapsed local time, rather than assuming synchronized clocks.
  const observedNow = scopedHistory ? Date.parse(scopedHistory.collectedAt) + Math.max(0, historyTime - (historyData?.receivedAt ?? historyTime)) : 0;
  const staleAt = (at: string | null) => at !== null && observedNow - Date.parse(at) >= 90 * 60_000;
  const history = scopedHistory ? { ...scopedHistory, reason: online ? scopedHistory.reason : "Reconnect to read current history and estimates.",
    windows: scopedHistory.windows.map(window => {
      const stale = !online || [window.usedPercent, window.windowDurationMins, window.resetsAt].some(field => staleAt(field.observedAt));
      return { ...window, sustainablePointsPerDay: stale ? null : window.sustainablePointsPerDay,
        forecasts: stale ? window.forecasts.map(forecast => ({ ...forecast, state: "stale" as const })) : window.forecasts };
    }), activity: { ...scopedHistory.activity,
      state: !online || staleAt(scopedHistory.tokenReadAt) && scopedHistory.activity.state === "available" ? "stale" as const : scopedHistory.activity.state } } : null;
  const [range, setRange] = useState<UsageHistoryRange>("24h"), [cursor, setCursor] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false), [historyError, setHistoryError] = useState<string | null>(null);
  const [historyRefresh, setHistoryRefresh] = useState(0), accountGeneration = useRef<string | null>(null);
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
      setDataOwner(owner);
      setLoading(true);
      const [quotaResult, threadResult] = await Promise.all([
        botsClient.rpc<BotAccountQuota>("usage.account").catch(() => null),
        botId ? botsClient.rpc<BotThreadUsage>("usage.bot", botId).catch(() => null) : Promise.resolve(null),
      ]);
      if (canceled || botsClient.owner !== owner) return;
      setQuota(quotaResult);
      setUsage(threadResult);
      setLoading(false);
      setHistoryRefresh(value => value + 1);
    })();
    return () => { canceled = true; };
  }, [botId, online, refresh, owner]);

  useEffect(() => {
    const receive = (event: { type: string; data: unknown }) => {
      if (event.type !== "usage" || botsClient.owner !== owner) return;
      const generation = (event.data as { accountGeneration?: string }).accountGeneration;
      if (generation && generation !== accountGeneration.current) {
        accountGeneration.current = generation; setHistoryData(null); setCursor(null); setQuota(null);
      }
      setHistoryRefresh(value => value + 1);
    };
    botsClient.events.add(receive);
    return () => { botsClient.events.delete(receive); };
  }, [owner]);

  useEffect(() => {
    if (!online || !historySupported) return;
    // Re-evaluate freshness while open without polling Codex or creating a bot schedule.
    const timer = setInterval(() => { setHistoryTime(Date.now()); setHistoryRefresh(value => value + 1); }, 60_000);
    return () => clearInterval(timer);
  }, [online, historySupported]);

  useEffect(() => {
    let canceled = false;
    if (!online || !historySupported) return;
    const requestedGeneration = accountGeneration.current;
    void (async () => {
      setHistoryLoading(true); setHistoryError(null);
      try {
        const [value, cachedQuota] = await Promise.all([
          botsClient.rpc<UsageHistory>("usage.history", undefined, { range, cursor }),
          botsClient.rpc<BotAccountQuota>("usage.account", undefined, { refresh: false }),
        ]);
        if (canceled || botsClient.owner !== owner || accountGeneration.current !== requestedGeneration) return;
        if (value.version !== 1) throw Error("This service returned an unsupported usage history version.");
        accountGeneration.current = value.accountGeneration;
        const receivedAt = Date.now();
        setHistoryTime(receivedAt); setHistoryData({ owner, value, receivedAt }); setDataOwner(owner); setQuota(cachedQuota);
      } catch (error) {
        if (!canceled && botsClient.owner === owner) setHistoryError(error instanceof Error ? error.message : "Usage history could not be read.");
      } finally {
        if (!canceled && botsClient.owner === owner) setHistoryLoading(false);
      }
    })();
    return () => { canceled = true; };
  }, [owner, online, historySupported, range, cursor, historyRefresh]);

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
      {resetCredits !== null && quota.availableResetCreditsObservedAt && <small className="bots-muted">Credits last observed {new Date(quota.availableResetCreditsObservedAt).toLocaleString()}</small>}
      {quota.accountType === "chatgpt" && quota.ordinaryUsageAllowed === false && <p>Included usage was reported unavailable{quota.ordinaryUsageAllowedObservedAt ? ` on ${new Date(quota.ordinaryUsageAllowedObservedAt).toLocaleString()}` : " in the last read"}.</p>}
      {quota.limits.map((limit, index) => <div className="bots-usage-limit" key={`${limit.limitId ?? "default"}-${index}`}>
        <strong>{limit.limitName || limit.limitId || "Codex quota"}{limit.model ? ` · ${limit.model}` : ""}</strong>
        {limit.windows.map((window, windowIndex) => <QuotaWindow window={window} key={windowIndex} />)}
      </div>)}
      {!quota.reason && resetCredits === null && !quota.limits.some((limit) => limit.windows.length) && <p>No quota details were reported for this account.</p>}
      <p className="bots-muted">Updated {new Date(quota.readAt).toLocaleString()}</p>
    </>}
    {historySupported ? <UsageHistoryView history={history} loading={historyLoading && online} disabled={!online} error={historyError} range={range}
      onRange={value => { setRange(value); setCursor(null); }} onNext={setCursor} onFirst={() => setCursor(null)} />
      : <p className="bots-muted">Usage history will be available after the bot service update is installed.</p>}
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
