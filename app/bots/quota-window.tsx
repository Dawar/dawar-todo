"use client";
import { useEffect, useState } from "react";
import type { BotAccountQuotaWindow } from "../../lib/bots-types";

export function remainingQuota(used: number) {
  return Number.isFinite(used) ? 100 - Math.max(0, Math.min(100, used)) : null;
}
export function quotaCountdown(seconds: number | null, now: number) {
  if (seconds === null || !Number.isFinite(seconds) || !Number.isFinite(new Date(seconds * 1000).getTime())) return null;
  const minutes = Math.ceil((seconds * 1000 - now) / 60000);
  if (minutes <= 0) return "Reset due";
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), rest = minutes % 60;
  return days ? `${days}d ${hours}h left` : hours ? `${hours}h ${rest}m left` : `${minutes}m left`;
}
export function quotaWindowName(minutes: number | null) {
  if (minutes === null) return "Quota window";
  if (minutes === 10080) return "Weekly";
  return minutes % 1440 === 0 ? `${minutes / 1440}-day` : minutes % 60 === 0 ? `${minutes / 60}-hour` : `${minutes}-minute`;
}
export function QuotaWindow({ window }: { window: BotAccountQuotaWindow }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => setNow(Date.now()), timer = setInterval(tick, 15_000);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", tick); };
  }, []);
  const left = remainingQuota(window.usedPercent), countdown = quotaCountdown(window.resetsAt, now);
  const label = quotaWindowName(window.windowDurationMins);
  const date = countdown && window.resetsAt !== null ? new Date(window.resetsAt * 1000) : null;
  const percentage = left === null ? null : `${Number(left.toFixed(1))}%`;
  return <div className="bots-quota-window">
    <div className="bots-quota-title"><span>{label}</span><strong>{percentage ? `${percentage} remaining` : "Unavailable"}</strong></div>
    {left !== null && <div className="bots-usage-meter" role="meter" aria-label={`${label} quota remaining`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={left} aria-valuetext={`${percentage} remaining`}><span style={{ width: `${left}%` }} /></div>}
    <div className="bots-quota-reset">{countdown && <span>{countdown}</span>}{date ? <time dateTime={date.toISOString()} title={date.toLocaleString()}>Resets {date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time> : <span>Reset time unavailable</span>}</div>
  </div>;
}
