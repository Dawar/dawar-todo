"use client";
import { useId } from "react";
import type { UsageForecast, UsageHistory, UsageHistoryRange, UsageHistoryWindow } from "../../lib/usage-history";
import { quotaWindowName } from "./quota-window";

const days = { "24h": 1, "7d": 7, "30d": 30 }, rangeNames = { "24h": "24 hours", "7d": "7 days", "30d": "30 days" };
const percent = (value: number) => Number(value.toFixed(1)).toLocaleString();
function duration(hours: number) {
  if (hours < 2) return `${Math.max(5, Math.round(hours * 60 / 5) * 5)} minutes`;
  if (hours < 48) return `${Math.round(hours)} hours`;
  return `${Number((hours / 24).toFixed(1))} days`;
}
function Forecast({ forecast }: { forecast: UsageForecast }) {
  const states = { collecting: "Collecting history", stale: "Data is stale", "no-consumption": "No measurable consumption", "reset-due": "Reset due · awaiting an update" };
  return <div className="bots-usage-forecast">
    <span>{forecast.horizonHours === 6 ? "Recent six-hour pace" : "24-hour pace"}</span>
    <strong>{forecast.state === "estimate" && forecast.depletionHours !== null
      ? forecast.depletionHours === 0 ? "No quota remaining" : `About ${duration(forecast.depletionHours)} remaining`
      : states[forecast.state as keyof typeof states] ?? "Collecting history"}</strong>
    {forecast.state === "estimate" && <>
      <span>{percent(forecast.pointsPerDay ?? 0)} percentage points per day</span>
      {forecast.resetFirst !== null && <span className={forecast.resetFirst ? "is-sustainable" : "is-depleting"}>{forecast.resetFirst ? "Likely to last until reset" : "Likely to run out before reset"}</span>}
      {forecast.resetFirst && forecast.projectedRemainingAtReset !== null && <span>About {percent(forecast.projectedRemainingAtReset)}% left at reset</span>}
    </>}
    {forecast.state === "collecting" && <span>Waiting for consistent observations across this period.</span>}
    {forecast.state === "no-consumption" && <span>No change was measurable in the reported percentages. Future usage can change this.</span>}
    <small>{Number(forecast.measuredHours.toFixed(1))}h measured · {forecast.sampleCount} samples</small>
  </div>;
}
function QuotaChart({ window, range, now }: { window: UsageHistoryWindow; range: UsageHistoryRange; now: number }) {
  const title = useId(), description = useId(), start = now - days[range] * 86_400_000;
  const paths: string[] = [], points = window.points;
  for (let index = 0; index < points.length; index++) {
    const point = points[index], previous = points[index - 1];
    const x = 34 + Math.max(0, Math.min(1, (point.at - start) / (now - start))) * 456;
    const y = 124 - Math.max(0, Math.min(100, point.usedPercent)) * 1.1;
    const next = `${x.toFixed(2)},${y.toFixed(2)}`;
    if (!previous || point.segment !== previous.segment || point.at - previous.at > 1.5 * 3_600_000) paths.push(`M${next}`);
    else paths[paths.length - 1] += ` L${next}`;
  }
  const last = points.at(-1);
  return <figure className="bots-usage-chart">
    {points.length ? <svg viewBox="0 0 510 155" role="img" aria-labelledby={`${title} ${description}`}>
      <title id={title}>Quota used over {rangeNames[range]}</title>
      <desc id={description}>{points.length} hourly observations. {last ? `Last observed usage ${percent(last.usedPercent)}%.` : ""} Gaps and resets interrupt the line.</desc>
      {[0, 50, 100].map(value => <g key={value}><line x1="34" x2="490" y1={124 - value * 1.1} y2={124 - value * 1.1} className="bots-usage-chart-grid" /><text x="29" y={128 - value * 1.1} textAnchor="end">{value}%</text></g>)}
      {paths.map((path, index) => <path d={path} key={index} className="bots-usage-chart-line" />)}
      {points.length === 1 && <circle cx={34 + (points[0].at - start) / (now - start) * 456} cy={124 - points[0].usedPercent * 1.1} r="3" className="bots-usage-chart-dot" />}
      <text x="34" y="148">{rangeNames[range]} ago</text><text x="490" y="148" textAnchor="end">Latest</text>
    </svg> : <p className="bots-muted">No quota samples in this period.</p>}
    <figcaption>Quota used · hourly observations{window.coverage.chartLimited ? " · chart data is limited" : ""}</figcaption>
    {points.length > 0 && <details><summary>Recent quota observations</summary><div className="bots-usage-data"><table><thead><tr><th>Observed</th><th>Quota used</th></tr></thead><tbody>{points.slice(-12).map(point => <tr key={`${point.segment}:${point.at}`}><td>{new Date(point.at).toLocaleString()}</td><td>{percent(point.usedPercent)}%</td></tr>)}</tbody></table></div></details>}
  </figure>;
}
function TokenActivity({ activity }: { activity: UsageHistory["activity"] }) {
  const title = useId(), description = useId();
  const daily = activity.daily, max = daily.reduce((value, day) => BigInt(day.tokens) > value ? BigInt(day.tokens) : value, BigInt(0));
  const total = daily.reduce((value, day) => value + BigInt(day.tokens), BigInt(0));
  const dateAt = (date: string) => Date.parse(`${date}T00:00:00Z`);
  const firstDate = daily.length ? dateAt(daily[0].date) : 0;
  const dateSpan = daily.length ? (dateAt(daily.at(-1)!.date) - firstDate) / 86_400_000 + 1 : 1;
  const fields = [["lifetimeTokens", "Lifetime tokens"], ["peakDailyTokens", "Peak daily tokens"], ["longestRunningTurnSec", "Longest turn · seconds"], ["currentStreakDays", "Current streak · days"], ["longestStreakDays", "Longest streak · days"]] as const;
  return <section className="bots-usage-token-history">
    <h3>Account token activity</h3>
    <p className="bots-muted">Native token counts are separate from quota percentages.</p>
    {activity.state === "collecting" && <p>Checking whether native token history is available…</p>}
    {activity.state === "unavailable" && <p>Native token history is unavailable. Any saved figures keep their original observation dates.</p>}
    {activity.state === "stale" && <p>Token history is stale. Reconnect or Refresh to check for updates.</p>}
    <dl className="bots-usage-stats">{fields.filter(([key]) => activity.summary[key].value !== null).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{BigInt(activity.summary[key].value!).toLocaleString()}</dd><small>Observed {activity.summary[key].observedAt ? new Date(activity.summary[key].observedAt!).toLocaleString() : "unknown"}</small></div>)}</dl>
    {daily.length > 0 ? <figure className="bots-usage-chart">
      <svg viewBox="0 0 510 155" role="img" aria-labelledby={`${title} ${description}`}>
        <title id={title}>Reported daily token activity</title><desc id={description}>{daily.length} reported dates, {total.toLocaleString()} tokens in these buckets. Missing dates are not counted as zero.</desc>
        <line x1="34" x2="490" y1="124" y2="124" className="bots-usage-chart-grid" />
        {daily.map(day => {
          const height = max ? Number(BigInt(day.tokens) * BigInt(1_000_000) / max) / 1_000_000 * 110 : 0;
          const width = 456 / dateSpan, offset = (dateAt(day.date) - firstDate) / 86_400_000;
          return <rect key={day.date} x={34 + offset * width + 1} y={124 - height} width={Math.max(1, width - 2)} height={height} className="bots-usage-chart-bar"><title>{day.date}: {BigInt(day.tokens).toLocaleString()} tokens</title></rect>;
        })}
        <text x="34" y="148">{daily[0].date}</text><text x="490" y="148" textAnchor="end">{daily.at(-1)!.date}</text>
      </svg><figcaption>{total.toLocaleString()} tokens across {daily.length} reported dates. These are whole daily buckets, not a rolling-hour total. Missing dates remain gaps; labels follow the service.</figcaption>
      <details><summary>Daily token figures</summary><div className="bots-usage-data"><table><thead><tr><th>Service date</th><th>Tokens</th><th>Observed</th></tr></thead><tbody>{daily.map(day => <tr key={day.date}><td>{day.date}</td><td>{BigInt(day.tokens).toLocaleString()}</td><td>{new Date(day.observedAt).toLocaleString()}</td></tr>)}</tbody></table></div></details>
    </figure> : activity.state === "available" && <p>No daily token buckets were reported in this period.</p>}
  </section>;
}
export function UsageHistoryView({ history, loading, disabled = false, error, range, onRange, onNext, onFirst }: {
  history: UsageHistory | null; loading: boolean; error: string | null; range: UsageHistoryRange;
  disabled?: boolean;
  onRange: (range: UsageHistoryRange) => void; onNext: (cursor: string) => void; onFirst: () => void;
}) {
  return <section className="bots-usage-history" aria-label="Usage history and estimates">
    <div className="bots-usage-history-heading"><h3>Will quota last until reset?</h3><div className="bots-usage-ranges" role="group" aria-label="History period">{(["24h", "7d", "30d"] as const).map(value => <button type="button" key={value} aria-pressed={range === value} disabled={loading || disabled} onClick={() => onRange(value)}>{rangeNames[value]}</button>)}</div></div>
    {loading && <p role="status">Reading usage history…</p>}{error && <p role="status">{error}</p>}
    {history && <>
      {history.reason && <p>{history.reason}</p>}
      {history.identity === "connection" && <p className="bots-muted">Codex did not supply a stable account ID. This connection has its own history; continuity across sign-in or restart is unverified.</p>}
      {!history.windows.length && <p>Collecting quota history. Samples begin when the updated service is running.</p>}
      {history.windows.map(window => <section className="bots-usage-history-window" key={window.id}>
        <h4>{window.limitName || window.limitId || "Codex quota"} · {quotaWindowName(window.windowDurationMins.value)} <small>({window.slot})</small></h4>
        {window.usedPercent.value !== null && <p>{percent(Math.max(0, 100 - window.usedPercent.value))}% quota remaining</p>}
        <small className="bots-muted">Quota observed {window.usedPercent.observedAt ? new Date(window.usedPercent.observedAt).toLocaleString() : "unknown"}{window.resetsAt.observedAt && window.resetsAt.observedAt !== window.usedPercent.observedAt ? ` · Reset last observed ${new Date(window.resetsAt.observedAt).toLocaleString()}` : ""}</small>
        <div className="bots-usage-forecasts">{window.forecasts.map(forecast => <Forecast key={forecast.horizonHours} forecast={forecast} />)}</div>
        {window.forecasts.every(value => value.state === "estimate") && <p className="bots-muted">Recent pace is {window.forecasts[0].pointsPerDay! > window.forecasts[1].pointsPerDay! * 1.1 ? "higher than" : window.forecasts[0].pointsPerDay! < window.forecasts[1].pointsPerDay! * .9 ? "lower than" : "close to"} your 24-hour pace.</p>}
        {window.sustainablePointsPerDay !== null && <p><strong>Sustainable daily pace:</strong> about {percent(window.sustainablePointsPerDay)} percentage points per day until reset.</p>}
        <QuotaChart window={window} range={history.range} now={Date.parse(history.collectedAt)} />
      </section>)}
      <div className="bots-usage-history-pages"><button type="button" onClick={onFirst} disabled={loading || disabled}>First quota page</button>{history.nextCursor && <button type="button" onClick={() => onNext(history.nextCursor!)} disabled={loading || disabled}>Next quota windows</button>}</div>
      <TokenActivity activity={history.activity} />
      <p className="bots-muted">Estimates follow measured usage and can change. Hourly checkpoints and native updates are retained for 90 days; missed observations remain gaps.</p>
    </>}
  </section>;
}
