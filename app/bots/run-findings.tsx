"use client";
import { useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import type { BotEvent, BotRunFinding } from "../../lib/bots-types";
import type { ActivityTarget } from "./conversation-activity";
import { botsClient as client } from "./client";
type Page = { findings: BotRunFinding[]; nextCursor: string | null };
const merge = (a: BotRunFinding[], b: BotRunFinding[]) => [...new Map([...a, ...b].map(value => [value.id, value])).values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).slice(0, 50);
export function RunFindings({ owner, botId, online, onOpen }: { owner: string; botId: string; online: boolean; onOpen: (target: ActivityTarget) => void }) {
  const key = `run-findings:v1:${botId}`;
  const [page, setPage] = useState<Page>(() => client.owner === owner ? client.cache(key, { findings: [], nextCursor: null }) : { findings: [], nextCursor: null });
  const [cursor, setCursor] = useState<string | null>(null), [attempt, setAttempt] = useState(0), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  useEffect(() => {
    let canceled = false;
    const arrivals: BotRunFinding[] = [];
    const event = (event: BotEvent) => {
      if (event.type !== "run.finding" || event.botId !== botId || client.owner !== owner) return;
      const finding = event.data as BotRunFinding;
      if (!finding.id || finding.botId !== botId || !finding.runId || !finding.laneId || !finding.threadId) return;
      arrivals.push(finding);
      if (!cursor) setPage(old => { const next = { ...old, findings: merge(old.findings, [finding]) }; client.save(key, next); return next; });
    };
    client.events.add(event);
    if (online) void Promise.resolve().then(async () => {
      if (canceled) return; setBusy(true);
      const next = await client.rpc<Page>("runs.findings", botId, { cursor, limit: 25 }, undefined, { owner });
      if (canceled || client.owner !== owner) return;
      if (!Array.isArray(next.findings) || next.findings.length > 25 || next.findings.some(value => value.botId !== botId || !value.runId || !value.threadId || !value.id) || next.nextCursor && next.nextCursor === cursor) throw Error("Findings could not be verified. Try again.");
      const value = { ...next, findings: merge(next.findings, cursor ? [] : arrivals) }; setPage(value); setError(""); if (!cursor) client.save(key, value);
    }).catch(reason => { if (!canceled && client.owner === owner) setError(String(reason)); }).finally(() => { if (!canceled) setBusy(false); });
    return () => { canceled = true; client.events.delete(event); };
  }, [owner, botId, key, online, cursor, attempt]);
  if (!page.findings.length && !error) return null;
  return <details className="bots-run-findings"><summary>Findings from Activity{!online ? " · saved" : ""}</summary><div>
    {page.findings.map(finding => <article key={finding.id}><p>{finding.summary}</p><button onClick={() => onOpen({ runId: finding.runId, turnId: finding.turnId })}>View scheduled run<ArrowUpRight size={14} /></button></article>)}
    {error && <p role="alert">{error}<button disabled={!online || busy} onClick={() => setAttempt(value => value + 1)}>Retry</button></p>}
    <nav>{cursor && <button disabled={!online || busy} onClick={() => setCursor(null)}>Recent findings</button>}{page.nextCursor && <button disabled={!online || busy} onClick={() => setCursor(page.nextCursor)}>Earlier findings</button>}</nav>
  </div></details>;
}
