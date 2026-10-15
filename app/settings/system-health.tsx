"use client";
import { useEffect, useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";

type Severity = "high" | "medium" | "low";
type Finding = { key: string; check: string; severity: Severity; store: "hub" | "node" | "journal"; botId: string | null; botName: string | null;
  record: { kind: string; id: string }; message: string; suggestedAction: string; ageMs: number | null };
type Report = { checkedAt: string; durationMs: number; truncated: boolean; counts: Record<Severity, number>; findings: Finding[]; errors: string[] };
type Health = { hub: Report | null; nodes: { nodeId: string; online: boolean; receivedAt: string; report: Report }[] };
const portable = process.env.NEXT_PUBLIC_DAWAR_PORTABLE === "1";
const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
const LABEL: Record<Severity, string> = { high: "High", medium: "Medium", low: "Low" };
const VARIANT = { high: "destructive", medium: "secondary", low: "outline" } as const;

function time(value: string) {
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "unknown time";
}

/** Read-only state invariant findings from the hub and each execution machine. */
export function SystemHealth() {
  const [health, setHealth] = useState<Health | null>(null), [error, setError] = useState(""), [loading, setLoading] = useState(portable), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!portable) return;
    const c = new AbortController();
    void (async () => {
      const response = await fetch("/api/portable/health", { cache: "no-store", signal: c.signal });
      if (!response.ok) throw Error(response.status === 403 ? "Sign in as the owner to see system health." : "System health is unavailable. Try again when connected.");
      const value = await response.json() as Health;
      if (!c.signal.aborted) { setHealth(value); setError(""); }
    })().catch(e => { if (!c.signal.aborted) setError(e instanceof Error ? e.message : "System health is unavailable."); })
      .finally(() => { if (!c.signal.aborted) setLoading(false); });
    return () => c.abort();
  }, [refresh]);
  if (!portable) return null;
  const sources = health ? [...(health.hub ? [{ label: "Hub", report: health.hub, note: null as string | null }] : []),
    ...health.nodes.map((n, i) => ({ label: health.nodes.length > 1 ? `Machine ${i + 1}` : "Execution machine", report: n.report, note: n.online ? null : "offline" }))] : [];
  const findings = sources.flatMap(s => s.report.findings.map(f => ({ ...f, source: s.label })))
    .sort((a, b) => RANK[a.severity] - RANK[b.severity] || (b.ageMs ?? 0) - (a.ageMs ?? 0));
  const high = sources.reduce((n, s) => n + s.report.counts.high, 0), total = sources.reduce((n, s) => n + s.report.counts.high + s.report.counts.medium + s.report.counts.low, 0);
  return <Card role="region" aria-labelledby="system-health-title" className="mb-6 p-5 shadow-none sm:p-6">
    <h2 id="system-health-title" className="text-lg font-semibold">System health</h2>
    <p className="mt-2 text-sm leading-6 text-muted-foreground">Read-only checks for stuck or impossible bot states, run every 10 minutes. High findings are also sent as notifications. Nothing here changes on its own.</p>
    {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
    {!error && !health && <p className="mt-4 text-sm text-muted-foreground">Checking…</p>}
    {health && <>
      <p role="status" className="mt-4 text-sm font-semibold">
        {!sources.length ? "The first check runs a couple of minutes after start." : total ? `${total} finding${total === 1 ? "" : "s"}${high ? `, ${high} high` : ""}` : "No findings"}
      </p>
      <ul className="mt-1 space-y-1 text-[13px] text-muted-foreground">
        {sources.map(s => <li key={s.label}>{s.label}{s.note ? ` (${s.note})` : ""}: checked {time(s.report.checkedAt)}{s.report.truncated ? " · partial" : ""}{s.report.errors.length ? ` · ${s.report.errors.length} check error${s.report.errors.length === 1 ? "" : "s"}` : ""}</li>)}
      </ul>
      {findings.length > 0 && <ul className="mt-4 space-y-3">
        {findings.map(f => <li key={`${f.source}:${f.key}`} className="min-w-0 rounded-xl bg-muted p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={VARIANT[f.severity]}>{LABEL[f.severity]}</Badge>
            <span className="text-sm font-semibold">{f.botName ?? (f.botId ? f.botId : f.source)}</span>
            <span className="text-[13px] text-muted-foreground">{f.check}</span>
          </div>
          <p className="mt-2 text-sm leading-6">{f.message}</p>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">Next: {f.suggestedAction}</p>
          <p className="mt-1 break-all font-mono text-[12px] text-muted-foreground">{f.source} · {f.record.kind} {f.record.id}</p>
        </li>)}
      </ul>}
    </>}
    <Button variant="outline" type="button" disabled={loading} onClick={() => { setLoading(true); setRefresh(x => x + 1); }} className="mt-4">{loading ? "Refreshing…" : "Refresh"}</Button>
  </Card>;
}
