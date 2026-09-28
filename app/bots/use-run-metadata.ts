import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { BotEvent, BotRun, BotRunPage, BotRunStateEvent } from "../../lib/bots-types";
import { botsClient as client } from "./client";
import { validRunState } from "./run-context";

/** Refresh selected metadata without replacing the list's page/cursor pair or
 * remounting its transcript. No history/receipt reads and no periodic polling. */
export function useRunMetadata({ owner, botId, runId, cursor, online, enabled, fallback, onMetadata }: {
  owner: string; botId: string; runId?: string; cursor: string | null;
  online: boolean; enabled: boolean; fallback?: BotRun; onMetadata: (run: BotRun) => void;
}) {
  const identity = JSON.stringify([owner, botId, runId]);
  const [value, setValue] = useState<{ identity: string; run: BotRun } | null>(null);
  const [status, setStatus] = useState({ identity: "", busy: false, error: "" });
  const callback = useRef(onMetadata), request = useRef<{ identity: string; refresh: () => void } | null>(null);
  const sequences = useRef(new Map<string, number>());
  useLayoutEffect(() => { callback.current = onMetadata; }, [onMetadata]);
  useEffect(() => {
    if (!enabled || !online || !runId || client.owner !== owner) return;
    let disposed = false, inFlight = false, again = false, epoch = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let duringRead: BotRun | undefined;
    const valid = () => !disposed && client.owner === owner;
    const publish = (run: BotRun) => {
      setValue({ identity, run }); callback.current(run);
    };
    const schedule = () => {
      if (!valid()) return;
      // A later schedules/ACK trigger may postdate the current read. Do not
      // publish that read or mistake the ACK for a native start.
      epoch++;
      if (inFlight) { again = true; return; }
      timer ??= setTimeout(() => { timer = undefined; void read(); }, 250);
    };
    const read = async () => {
      if (!valid()) return;
      inFlight = true; duringRead = undefined;
      const revision = epoch;
      setStatus({ identity, busy: true, error: "" });
      try {
        const page = await client.rpc<BotRunPage>("runs.page", botId, { cursor, limit: 25 }, undefined, { owner });
        if (!valid() || revision !== epoch) return;
        if (!Array.isArray(page.runs) || page.runs.length > 25 || page.runs.some(run => run.botId !== botId)) throw Error("Run status could not be verified. Refresh its status again.");
        // runs.page has no event cursor. A validated selected-run event that
        // arrived during this read wins over its possibly older row.
        const run = duringRead ?? page.runs.find(run => run.id === runId);
        if (!run) throw Error("This run is outside its saved activity page. Reopen it from All activity to update its status.");
        publish(run);
        setStatus({ identity, busy: false, error: "" });
      } catch (reason) {
        if (valid() && revision === epoch) setStatus({ identity, busy: false, error: reason instanceof Error ? reason.message : "Run status could not be updated." });
      } finally {
        inFlight = false; duringRead = undefined;
        if (valid() && again) { again = false; schedule(); }
      }
    };
    const event = (event: BotEvent) => {
      if (!valid() || event.botId !== botId) return;
      if (event.type === "schedules") { schedule(); return; }
      if (event.type !== "run.state") return;
      const data = event.data as Partial<BotRunStateEvent>;
      if (data.runId !== runId || !validRunState(data, botId) || event.seq <= (sequences.current.get(identity) ?? -1)) return;
      sequences.current.set(identity, event.seq);
      if (sequences.current.size > 100) sequences.current.delete(sequences.current.keys().next().value!);
      if (inFlight) duringRead = data.run;
      publish(data.run!);
      if (!inFlight) setStatus({ identity, busy: false, error: "" });
    };
    request.current = { identity, refresh: schedule };
    client.events.add(event); schedule();
    return () => {
      disposed = true; request.current = null;
      if (timer) clearTimeout(timer);
      client.events.delete(event);
    };
  }, [owner, botId, runId, cursor, online, enabled, identity]);
  return {
    run: enabled && value?.identity === identity ? value.run : fallback,
    busy: online && status.identity === identity && status.busy,
    error: status.identity === identity ? status.error : "",
    refresh: () => { if (request.current?.identity === identity) request.current.refresh(); },
  };
}
