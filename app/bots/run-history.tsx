"use client";

import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import type { Bot, BotAttachment, BotRun, BotRunPage, BotSchedule } from "../../lib/bots-types";
import type { Turn } from "../../lib/codex-protocol/v2/Turn";
import { botsClient } from "./client";
import { BotMessage } from "./message";

const date = (value: string) => new Date(value).toLocaleString();

export function RunHistory({ bot, schedules, attachments, online, onClose, download }:
  { bot: Bot; schedules: BotSchedule[]; attachments: BotAttachment[]; online: boolean;
    onClose: () => void; download: (id: string) => void }) {
  const [runs, setRuns] = useState<BotRun[]>([]);
  const [latest, setLatest] = useState<BotRun[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [transcript, setTranscript] = useState<Turn | null>(null);
  const [turnId, setTurnId] = useState<string | null>(null);
  const [turnCursor, setTurnCursor] = useState<string | null>(null);
  const load = useCallback(async (next: string | null) => {
    if (!online) return;
    setBusy(true);
    setError("");
    try {
      const page = await botsClient.rpc<BotRunPage>("runs.page", bot.id, { cursor: next, limit: 25 });
      setRuns((current) => next ? [...current, ...page.runs] : page.runs);
      setLatest(page.latestBySchedule);
      setCursor(page.nextCursor);
    } catch (e) { setError(e instanceof Error ? e.message : "Run history unavailable."); }
    finally { setBusy(false); }
  }, [bot.id, online]);
  useEffect(() => { void Promise.resolve().then(() => load(null)); }, [load]);
  async function openTurn(id: string, next: string | null = null) {
    setBusy(true);
    setError("");
    setTurnId(id);
    if (!next) setTranscript(null);
    try {
      const result = await botsClient.rpc<{ turn: Turn | null; nextCursor: string | null }>(
        "history.turn", bot.id, { turnId: id, cursor: next });
      setTranscript(result.turn);
      setTurnCursor(result.nextCursor);
    } catch (e) { setError(e instanceof Error ? e.message : "Transcript unavailable."); }
    finally { setBusy(false); }
  }
  async function acknowledge(run: BotRun) {
    setBusy(true);
    try {
      await botsClient.rpc("runs.acknowledge", bot.id, { id: run.id });
      void load(null);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not acknowledge run."); }
    finally { setBusy(false); }
  }
  return <div className="bots-modal-backdrop" onClick={onClose}>
    <section className="bots-history-modal" role="dialog" aria-modal="true" aria-label={`${bot.name} schedule history`} onClick={(event) => event.stopPropagation()}>
      <header><h2>{bot.name} · Schedule history</h2><button className="bots-icon-button" aria-label="Close schedule history" onClick={onClose}><X size={19} /></button></header>
      {turnId ? <>
        <button className="bots-history-link" onClick={() => { setTurnId(null); setTranscript(null); }}>← Back to runs</button>
        <h3>Scheduled conversation turn</h3>
        {transcript?.items.map((item) => <BotMessage key={item.id} item={item} botId={bot.id} attachments={attachments} download={download} />)}
        {transcript && !transcript.items.length && <p>No transcript items are available for this turn.</p>}
        {!transcript && !busy && turnCursor && <button className="bots-history-link" onClick={() => void openTurn(turnId, turnCursor)}>Search earlier conversation</button>}
        {!transcript && !busy && !turnCursor && !error && <p>This turn is not available in native conversation history.</p>}
      </> : <>
        <p className="bots-muted">Scheduled runs are stored separately from the chat. Open a run’s native conversation turn to see its full output when available.</p>
        {!online && <p>Connect to your VM to read schedule history.</p>}
        <h3>Schedules</h3>
        {schedules.map((schedule) => {
          const last = latest.find((run) => run.scheduleId === schedule.id);
          return <div className="bots-history-schedule" key={schedule.id}>
            <strong>{schedule.title}</strong>
            <span>{schedule.enabled && schedule.nextRunAt ? `Next ${date(schedule.nextRunAt)} (${schedule.timeZone})` : schedule.enabled ? "No next run due" : "Paused"}</span>
            <span>Last: {last ? `${last.status} · ${date(last.scheduledAt)}` : "No recorded run"}</span>
            {last?.error && <small>{last.error}</small>}
          </div>;
        })}
        {!schedules.length && <p>No current schedules. Past runs remain below.</p>}
        <h3>Runs</h3>
        {runs.map((run) => <div className="bots-history-run" key={run.id}>
          <strong>{run.title}</strong>
          <span>{run.status} · Due {date(run.scheduledAt)}</span>
          {run.startedAt && <span>Started {date(run.startedAt)}</span>}
          {run.finishedAt && <span>Finished {date(run.finishedAt)}</span>}
          {run.error && <small>{run.error}</small>}
          <div>{run.turnId && <button className="bots-history-link" onClick={() => void openTurn(run.turnId!)}>Open conversation turn</button>}
            {run.status === "uncertain" && <button className="bots-history-link" disabled={!online || busy} onClick={() => void acknowledge(run)}>I reviewed this run</button>}
            {!run.turnId && <span>Conversation turn unavailable</span>}
          </div>
        </div>)}
        {cursor && <button className="bots-history-more" disabled={!online || busy} onClick={() => void load(cursor)}>Load older runs</button>}
        {!runs.length && !busy && online && !error && <p>No scheduled runs recorded.</p>}
      </>}
      {busy && <p>Loading…</p>}
      {error && <p className="bots-error" role="alert">{error}</p>}
    </section>
  </div>;
}
