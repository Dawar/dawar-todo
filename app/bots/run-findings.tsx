"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BotEvent, BotRunFinding } from "../../lib/bots-types";
import { botsClient as client } from "./client";
type Page = { findings: BotRunFinding[]; nextCursor: string | null; loaded?: boolean };
export function useRunFindings(owner: string, botId: string, online: boolean, supported: boolean) {
  const key = `run-findings:v3:${botId}`;
  const [page, setPage] = useState<Page>(() => client.owner === owner ? client.cache(key, { findings: [], nextCursor: null }) : { findings: [], nextCursor: null });
  const [attempt, setAttempt] = useState(0), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const current = useRef(page), alive = useRef(true);
  const merge = useCallback((next: Page, older = false) => {
    const rows = new Map(current.current.findings.map(f => [f.id, f]));
    for (const f of next.findings) rows.set(f.id, f);
    const value = { findings: [...rows.values()].sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)), loaded: current.current.loaded, nextCursor: older || !current.current.findings.length ? next.nextCursor : current.current.nextCursor };
    current.current = value; setPage(value); client.save(key, value);
  }, [key]);
  const read = useCallback(async (cursor: string | null) => {
    const next = await client.rpc<Page>("runs.findings", botId, { cursor, limit: 25 }, undefined, { owner });
    if (!Array.isArray(next.findings) || next.findings.length > 25 || next.findings.some(f => f.botId !== botId || !f.id || !f.runId || !f.threadId) || next.nextCursor && next.nextCursor === cursor) throw Error("Findings could not be verified. Try again.");
    return next;
  }, [owner, botId]);
  useEffect(() => {
    let live = true; alive.current = true;
    const event = (event: BotEvent) => {
      if (!supported || event.type !== "run.finding" || event.botId !== botId || client.owner !== owner) return;
      const f = event.data as BotRunFinding;
      if (!f.id || f.botId !== botId || !f.runId || !f.threadId) return;
      merge({ findings: [f], nextCursor: current.current.nextCursor });
    };
    client.events.add(event);
    if (online && supported) void Promise.resolve().then(async () => {
      setBusy(true); const next = await read(null);
      if (!live || client.owner !== owner) return;
      // Keep the oldest loaded cursor when extending an existing page; on first read use its authoritative cursor.
      const loaded = current.current.loaded;
      merge(next); if (!loaded) { const value = { ...current.current, nextCursor: next.nextCursor, loaded: true }; current.current = value; setPage(value); client.save(key, value); }
      setError("");
    }).catch(reason => { if (live && client.owner === owner) setError(String(reason)); }).finally(() => { if (live) setBusy(false); });
    return () => { live = false; alive.current = false; client.events.delete(event); };
  }, [owner, botId, key, online, supported, attempt, merge, read]);
  const older = async () => {
    if (busy || !online || !page.nextCursor) return;
    setBusy(true); setError("");
    try { const next = await read(page.nextCursor); if (alive.current && client.owner === owner) merge(next, true); }
    catch (reason) { if (alive.current) setError(String(reason)); } finally { if (alive.current) setBusy(false); }
  };
  return { ...page, busy, error, older, retry: () => setAttempt(v => v + 1) };
}
