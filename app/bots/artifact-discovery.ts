"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { botsClient } from "./client";
import { indexArtifacts } from "./artifact-source";
import { readArtifactCache, writeArtifactCache } from "./artifact-cache";

type Progress = { cursor: string | null; done: boolean; attempted: boolean; checkedAt: number; retries: (string | null)[] };
/** One native page per bot per batch; never scan whole histories before showing the library. */
export function useArtifactDiscovery(owner: string, botIds: string[], online: boolean, onRegistered: () => void) {
  const identity = JSON.stringify([owner, botIds]);
  const ids = useMemo(() => JSON.parse(identity)[1] as string[], [identity]);
  const [busy, setBusy] = useState(false), [more, setMore] = useState(false), [issues, setIssues] = useState(false);
  const progress = useRef<Record<string, Progress>>({}), running = useRef(false), generation = useRef(0);
  const refresh = useRef(onRegistered); useEffect(() => { refresh.current = onRegistered; }, [onRegistered]);
  const summarize = useCallback(() => {
    setMore(ids.some((id) => !progress.current[id]?.done));
    setIssues(ids.some((id) => progress.current[id]?.retries.length));
  }, [ids]);
  const run = useCallback(async (mode: "initial" | "earlier" | "retry") => {
    if (!online || running.current || owner !== botsClient.owner) return;
    const token = generation.current;
    const candidates = ids.filter((id) => mode === "retry" ? progress.current[id]?.retries.length : mode === "initial" ? !progress.current[id]?.checkedAt || Date.now() - progress.current[id].checkedAt > 60_000 : !progress.current[id]?.done).slice(0, 2);
    if (!candidates.length) { summarize(); return; }
    running.current = true; setBusy(true);
    let registered = 0;
    await Promise.all(candidates.map(async (id) => {
      const previous = progress.current[id], cursor = mode === "retry" ? previous.retries[0] : mode === "initial" ? null : previous?.cursor ?? null;
      try {
        const result = await indexArtifacts(id, cursor, owner);
        if (token !== generation.current) return;
        registered += result.registered;
        const retries = (previous?.retries ?? []).filter((value) => value !== cursor);
        if (result.failures.length) retries.push(cursor);
        // A failed RPC did not advance the frontier. A retry of an older failed
        // page must not rewind newer progress or erase other pending retries.
        const advance = mode !== "retry" || !previous || previous.cursor === cursor && (!previous.done || cursor === null);
        progress.current[id] = { cursor: advance ? result.nextCursor : previous.cursor,
          done: advance ? !result.nextCursor : previous.done, attempted: true, checkedAt: Date.now(), retries };
      } catch {
        if (token === generation.current) progress.current[id] = { cursor: previous?.cursor ?? null, done: previous?.done ?? false,
          attempted: true, checkedAt: Date.now(), retries: [...new Set([...(previous?.retries ?? []), cursor])] };
      }
      if (token === generation.current) await writeArtifactCache(owner, "page", `discovery:${id}`, progress.current[id]);
    }));
    if (token !== generation.current) return;
    running.current = false; setBusy(false); summarize();
    if (registered) refresh.current();
  }, [owner, online, ids, summarize]);
  useEffect(() => {
    const token = ++generation.current; running.current = false; progress.current = {};
    void (async () => {
      // Read only the small progress records for this bounded opening batch. Older bots are discovered on demand.
      for (const id of ids.slice(0, 2)) {
        const saved = await readArtifactCache<Progress>(owner, "page", `discovery:${id}`);
        if (token !== generation.current) return;
        if (saved && Array.isArray(saved.retries)) progress.current[id] = saved;
      }
      setBusy(false); summarize(); void run("initial");
    })();
    return () => { generation.current = token + 1; };
  }, [owner, ids, run, summarize]);
  useEffect(() => {
    const listener = (event: { botId?: string | null; type: string }) => {
      if (event.type === "artifact.issue" && event.botId && ids.includes(event.botId)) {
        const previous = progress.current[event.botId];
        progress.current[event.botId] = { ...(previous ?? { cursor: null, done: false, attempted: false, checkedAt: 0 }), retries: [...new Set([...(previous?.retries ?? []), null])] }; summarize();
      }
    };
    botsClient.events.add(listener); return () => { botsClient.events.delete(listener); };
  }, [ids, summarize]);
  return { busy, more, issues, earlier: () => void run("earlier"), retry: () => void run("retry") };
}
