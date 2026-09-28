"use client";
import { useEffect, useState } from "react";
import type { BotEvent, BotRequest } from "../../lib/bots-types";
import { botsClient as client } from "./client";
import { RequestCard } from "./request-card";
import { useRunAction } from "./run-action";

function RunQuestion({ owner, botId, runId, pending, online }: { owner: string; botId: string; runId: string; pending: BotRequest; online: boolean }) {
  const action = useRunAction(owner, botId, `answer:${runId}:${pending.key}`);
  return <div>
    <RequestCard pending={pending} memoryKey={JSON.stringify([owner, botId, runId, pending.key])} disabled={!online || action.busy || !!action.intent || action.accepted} respond={result => action.perform("requests.respond", { key: pending.key, result })} />
    {action.accepted && <p role="status">Answer accepted for this run.</p>}
    {(action.intent || action.error) && <p className="bots-run-notice" role="alert">{action.error || "Your original answer is awaiting confirmation."}{action.intent && <button disabled={!online || action.busy} onClick={() => void action.retry().catch(() => {})}>Check same answer</button>}</p>}
  </div>;
}
export function RunQuestions({ owner, botId, runId, online }: { owner: string; botId: string; runId: string; online: boolean }) {
  // Secrets remain in memory; no question is written to ordinary snapshot/history caches.
  const [pending, setPending] = useState<BotRequest[]>(() => client.snapshot?.pending.filter(value => value.botId === botId && value.runId === runId) ?? []);
  const [error, setError] = useState(""), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let canceled = false;
    const sequences = new Map<string, number>();
    const resolved = new Set<string>(), arrivals = new Map<string, BotRequest>();
    const event = (event: BotEvent) => {
      if (client.owner !== owner || event.botId !== botId) return;
      const data = event.data as BotRequest;
      if (data?.runId !== runId || !data.key || event.seq <= (sequences.get(data.key) ?? -1)) return;
      sequences.set(data.key, event.seq);
      if (event.type === "run.request") { arrivals.set(data.key, data); resolved.delete(data.key); setPending(old => [...old.filter(value => value.key !== data.key), data]); }
      if (event.type === "run.request.resolved") { resolved.add(data.key); arrivals.delete(data.key); setPending(old => old.filter(value => value.key !== data.key)); }
    };
    client.events.add(event);
    if (online) void client.rpc<{ pending: BotRequest[] }>("runs.requests", botId, { runId }, undefined, { owner }).then(value => {
      if (canceled || client.owner !== owner) return;
      if (!Array.isArray(value.pending) || value.pending.some(item => item.botId !== botId || item.runId !== runId || !item.threadId || !item.laneId)) throw Error("Run questions could not be verified. Refresh this run.");
      setPending([...new Map([...value.pending, ...arrivals.values()].filter(item => !resolved.has(item.key)).map(item => [item.key, item])).values()]); setError("");
    }).catch(reason => { if (!canceled && client.owner === owner) setError(reason instanceof Error ? reason.message : "Questions could not be loaded."); });
    return () => { canceled = true; client.events.delete(event); };
  }, [owner, botId, runId, online, attempt]);
  return <section className="bots-run-questions" aria-label="Questions for this run">{pending.map(value => <RunQuestion key={value.key} owner={owner} botId={botId} runId={runId} pending={value} online={online} />)}{error && <p role="alert">{error}<button disabled={!online} onClick={() => setAttempt(value => value + 1)}>Retry questions</button></p>}</section>;
}
