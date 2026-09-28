"use client";
import { useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import type { HistoryPage } from "../../lib/bot-history-view";
import { RunHistoryReader } from "./run-history-reader";
import { botsClient as client } from "./client";
import { TimelineEntry } from "./timeline";
import { ReturnedArtifacts } from "./returned-artifact";

export function RunTranscript({ owner, botId, runId, page, download }: { owner: string; botId: string; runId: string; page: HistoryPage; download: (id: string) => void }) {
  const { laneId, threadId } = page.context!;
  const reader = useMemo(() => new RunHistoryReader(owner, botId, { runId, laneId, threadId }), [owner, botId, runId, laneId, threadId]);
  useSyncExternalStore(reader.subscribe, reader.snapshot, reader.snapshot);
  useLayoutEffect(() => { reader.reconcilePage(page); }, [reader, page]);
  useEffect(() => { reader.activate(); client.events.add(reader.receive); return () => { client.events.delete(reader.receive); reader.dispose(); }; }, [reader]);
  const attachments = [...new Map([...page.attachments, ...reader.attachments].map(file => [file.id, file])).values()];
  const linked = new Set(page.entries.flatMap(entry => entry.item?.type === "agentMessage" ? [...entry.item.text.matchAll(/\]\(<?bot-artifact:([^\s)>]+)/g)].map(match => match[1]) : []));
  return <div className="bots-run-transcript">{page.entries.map(entry => <TimelineEntry key={`${entry.turnId}:${entry.id}`} entry={{ ...entry, scheduled: false }} timeline={reader} attachments={attachments} download={download} />)}
    {[...new Set(page.entries.map(entry => entry.turnId))].map(turnId => <ReturnedArtifacts key={turnId} botId={botId} threadId={threadId} turnId={turnId} attachments={attachments} linked={linked} />)}
  </div>;
}
