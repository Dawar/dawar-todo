"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import type { BotEvent, BotRunFinding } from "../../lib/bots-types";
import type { ActivityTarget } from "./conversation-activity";
import { botsClient as client } from "./client";
type Page = { findings: BotRunFinding[]; nextCursor: string | null };
export function RunFindings({ owner, botId, online, onOpen }: { owner: string; botId: string; online: boolean; onOpen: (target: ActivityTarget) => void }) {
  // v1 could cache live-truncated rows ahead of an obsolete cursor. Leave it
  // intact, but only authoritative page/cursor pairs enter this new cache.
  const key = `run-findings:v2:${botId}`;
  const [page, setPage] = useState<Page>(() => client.owner === owner ? client.cache(key, { findings: [], nextCursor: null }) : { findings: [], nextCursor: null });
  const [cursor, setCursor] = useState<string | null>(null), [loadedCursor, setLoadedCursor] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0), [error, setError] = useState(""), [busy, setBusy] = useState(false), [newFindings, setNewFindings] = useState(false);
  const eventGeneration = useRef(0), visibleIds = useRef(new Set(page.findings.map(finding => finding.id)));
  useEffect(() => {
    // IDs only, bounded for the lifetime of this mounted bot. No event bodies,
    // arrival replay array or automatic insertion into the displayed page.
    const seen = new Set<string>();
    const event = (event: BotEvent) => {
      if (event.type !== "run.finding" || event.botId !== botId || client.owner !== owner) return;
      const finding = event.data as BotRunFinding;
      if (!finding.id || finding.botId !== botId || !finding.runId || !finding.laneId || !finding.threadId || visibleIds.current.has(finding.id) || seen.has(finding.id)) return;
      seen.add(finding.id); if (seen.size > 64) seen.delete(seen.values().next().value!);
      eventGeneration.current++; setNewFindings(true);
    };
    client.events.add(event); return () => { client.events.delete(event); seen.clear(); };
  }, [owner, botId]);
  useEffect(() => {
    let canceled = false;
    if (online) void Promise.resolve().then(async () => {
      if (canceled || client.owner !== owner) return;
      const observed = eventGeneration.current;
      setBusy(true);
      const next = await client.rpc<Page>("runs.findings", botId, { cursor, limit: 25 }, undefined, { owner });
      if (canceled || client.owner !== owner) return;
      if (!Array.isArray(next.findings) || next.findings.length > 25 || next.findings.some(value => value.botId !== botId || !value.runId || !value.threadId || !value.id) || new Set(next.findings.map(value => value.id)).size !== next.findings.length || next.nextCursor && next.nextCursor === cursor) throw Error("Findings could not be verified. Try again.");
      visibleIds.current = new Set(next.findings.map(finding => finding.id));
      setPage(next); setLoadedCursor(cursor); setError("");
      if (!cursor) { client.save(key, next); if (observed === eventGeneration.current) setNewFindings(false); }
    }).catch(reason => { if (!canceled && client.owner === owner) setError(String(reason)); }).finally(() => { if (!canceled) setBusy(false); });
    else void Promise.resolve().then(() => { if (!canceled) setBusy(false); });
    return () => { canceled = true; };
  }, [owner, botId, key, online, cursor, attempt]);
  const recent = () => { setCursor(null); setAttempt(value => value + 1); };
  if (!page.findings.length && !error && !newFindings) return null;
  return <details className="bots-run-findings"><summary>Findings from Activity{newFindings ? " · new findings" : !online ? " · saved" : ""}</summary><div>
    {page.findings.map(finding => <article key={finding.id}><p>{finding.summary}</p><button onClick={() => onOpen({ runId: finding.runId, turnId: finding.turnId })}>View scheduled run<ArrowUpRight size={14} /></button></article>)}
    {error && <p role="alert">{error}<button disabled={!online || busy} onClick={() => setAttempt(value => value + 1)}>Retry</button></p>}
    <nav>{(cursor || newFindings) && <button disabled={!online || busy} onClick={recent}>{newFindings ? "Show recent findings" : "Recent findings"}</button>}{page.nextCursor && <button disabled={!online || busy || loadedCursor !== cursor} onClick={() => setCursor(page.nextCursor)}>Earlier findings</button>}</nav>
  </div></details>;
}
