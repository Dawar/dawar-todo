"use client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowUp, Paperclip } from "lucide-react";
import { botsClient as client } from "./client";
import { BotComposer } from "./composer-controller";
import { BotDraftStore } from "./draft-store";
import { ComposerAttachments } from "./composer-state";
import { ComposerInput } from "./composer-input";

// Critical run drafts use the proven transactional byte store, in a separate
// database. Main recovery never enumerates run keys or targets one as a bot ID.
const controllers = new Map<string, BotComposer>();
let store: BotDraftStore | undefined, channel: BroadcastChannel | undefined, started = false;
function getComposer(owner: string, botId: string, runId: string) {
  const key = JSON.stringify([owner, botId, runId]);
  let composer = controllers.get(key);
  if (!composer) {
    store ??= new BotDraftStore(indexedDB, undefined, "dawar-bot-run-drafts-v1");
    composer = new BotComposer(owner, botId, store, client, () => channel?.postMessage(key), { runId, storageKey: JSON.stringify([botId, runId]) });
    controllers.set(key, composer);
  }
  if (!started) {
    started = true;
    if (typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel("dawar-bot-run-drafts-v1");
      channel.onmessage = event => { const value = controllers.get(event.data); if (value?.canUseOwner) void value.refresh(); };
    }
    const flush = () => { for (const value of controllers.values()) if (value.canUseOwner) void value.flush().catch(() => {}); };
    window.addEventListener("pagehide", flush); window.addEventListener("dawar-before-navigation", flush);
    window.addEventListener("beforeunload", event => { flush(); if ([...controllers.values()].some(value => value.canUseOwner && value.dirty)) { event.preventDefault(); event.returnValue = ""; } });
    document.addEventListener("visibilitychange", () => { if (document.hidden) flush(); else for (const value of controllers.values()) if (value.canUseOwner) void value.refresh(); });
    let online = client.online, previousOwner = client.owner;
    client.subscribe(() => {
      const returned = client.online && (!online || previousOwner !== client.owner);
      online = client.online; previousOwner = client.owner;
      if (returned && client.snapshot?.capabilities?.backgroundRunLanes === 1) for (const value of controllers.values()) if (value.canUseOwner) {
        void value.refresh().then(() => { void value.resumeUploads(true); void value.reconcile(); });
      }
    });
  }
  return composer;
}
function ReadyRunComposer({ composer, online, paused }: { composer: BotComposer; online: boolean; paused: boolean }) {
  const version = useRef(0);
  useSyncExternalStore(fn => composer.subscribe(() => { version.current++; fn(); }), () => version.current, () => 0);
  const file = useRef<HTMLInputElement>(null);
  const op = composer.operation, files = composer.draft.files;
  const failedFiles = files.some(value => value.error || !value.hasBytes);
  const error = composer.storageError || composer.actionError;
  return <section className="bots-run-reply" aria-label="Reply to this run">
    <header><strong>Reply to this run</strong><span>{paused ? "Paused · replies wait until you resume its queue" : "Your main conversation stays separate"}</span></header>
    {error && <p role="alert">{error} {composer.storageError && <button onClick={() => void composer.retry()}>Retry saving</button>}</p>}
    {failedFiles && <p role="alert">Your files are retained. <button onClick={() => void composer.retry()}>Retry file recovery</button><button onClick={() => void composer.restartFailedUploads()}>Restart failed transfers</button></p>}
    {op && <p role="status">{composer.sendingNow ? "Confirming delivery…" : op.error || (op.runDelivery?.state === "prepared" ? "Saved reply is waiting to send." : "Checking this reply's delivery.")}<button disabled={!online || composer.sendingNow} onClick={() => void composer.reconcile()}>{op.runDelivery?.state === "prepared" ? "Send saved reply" : "Check delivery"}</button></p>}
    <ComposerAttachments composer={composer} />
    <form onSubmit={event => { event.preventDefault(); void composer.send(); }}>
      <input ref={file} type="file" multiple hidden onChange={event => { if (event.target.files) composer.addFiles([...event.target.files]); event.target.value = ""; }} />
      <button type="button" className="bots-icon-button" aria-label="Attach files to run reply" disabled={!composer.ready} onClick={() => file.current?.click()}><Paperclip size={18} /></button>
      <ComposerInput aria-label="Message for this run" placeholder="Add a correction or follow-up…" value={composer.draft.text} disabled={!composer.ready} onChange={event => composer.setText(event.target.value)} onPaste={event => { const pasted = [...event.clipboardData.files]; if (pasted.length) { event.preventDefault(); composer.addFiles(pasted); } }} />
      <button type="submit" className="bots-send" aria-label="Send reply to this run" disabled={!online || !composer.ready || !!composer.storageError || !!op || (!composer.draft.text.trim() && !files.length) || files.some(value => !value.remote?.ready)}><ArrowUp size={19} /></button>
    </form>
    {!online && <small>Offline · this run’s draft and staged files stay on this device.</small>}
    {composer.recoveries.length > 0 && <label>Saved draft versions<select value={composer.record.active} onChange={event => composer.select(event.target.value)}><option value="normal">Current draft</option>{composer.recoveries.map((slot, i) => <option key={slot} value={slot}>Saved version {i + 1}</option>)}</select></label>}
  </section>;
}
export function RunComposer({ owner, botId, runId, online, paused }: { owner: string; botId: string; runId: string; online: boolean; paused: boolean }) {
  const [composer, setComposer] = useState<BotComposer | null>(null), [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(async () => {
      const value = getComposer(owner, botId, runId);
      await value.open();
      if (active && client.owner === owner) { setComposer(value); void value.resumeUploads(); void value.reconcile(); }
    }).catch(() => { if (active) setError("Run draft storage is unavailable. Enable site storage and reopen this run."); });
    return () => { active = false; };
  }, [owner, botId, runId]);
  return composer ? <ReadyRunComposer composer={composer} online={online} paused={paused} /> : <p role="status">{error || "Opening your run draft…"}</p>;
}
