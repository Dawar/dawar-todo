"use client";
import { useEffect, useRef, useState } from "react";
import { CornerUpLeft, X } from "lucide-react";
import type { BotReplyReference } from "../../lib/bot-replies";
import type { HistoryEntry } from "../../lib/bot-history-view";
import { replyableText } from "../../lib/bot-replies";
import { botsClient as client } from "./client";
import "./message-reply.css";

export function ReplyQuote({ reply, onOpen, onClear, foreign = false }: { reply: BotReplyReference; onOpen?: (reply: BotReplyReference) => Promise<boolean>; onClear?: () => void; foreign?: boolean }) {
  const [busy, setBusy] = useState(false), [unavailable, setUnavailable] = useState(false), [error, setError] = useState("");
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const open = async () => {
    if (!onOpen || busy) return;
    setBusy(true); setError("");
    try { const found = await onOpen(reply); if (mounted.current) setUnavailable(!found); }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : "Could not open the original. Reconnect and try again."); }
    finally { if (mounted.current) setBusy(false); }
  };
  const body = <><strong><CornerUpLeft size={13} aria-hidden="true"/>{reply.role === "user" ? "You" : "Bot"}</strong><span>{reply.text}{reply.truncated && "…"}</span>{(foreign || unavailable) && <small>{foreign ? "Original is in another conversation" : "Original message unavailable"}</small>}{busy && <small>Finding original…</small>}</>;
  return <div className="bots-reply-quote">
    {onOpen && !foreign ? <button type="button" className="bots-reply-source" aria-label="Open quoted message" disabled={busy} onClick={() => void open()}>{body}</button> : <div className="bots-reply-source">{body}</div>}
    {onClear && <button type="button" className="bots-icon-button" aria-label="Cancel reply" title="Cancel reply" onClick={onClear}><X size={16}/></button>}
    {error && <small role="alert">{error}</small>}
  </div>;
}
export function ReplyAction({ entry, botId, threadId, onReply, partId }: { entry: HistoryEntry; botId: string; threadId: string; partId?: string; onReply: (reply: BotReplyReference) => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [cursor, setCursor] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  if (!entry.item || replyableText(entry.item) === null) return null;
  const select = async () => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      let next = cursor; const visited = new Set();
      // Cursor hints usually resolve on the first read. Very old history gets
      // finite batches and a visible continuation, never an unbounded cascade.
      for (let count = 0; count < 1 && mounted.current; count++) {
        if (visited.has(next)) throw Error("History did not advance. Try again."); visited.add(next);
        const value = await client.rpc<{ reply: BotReplyReference | null; nextCursor: string | null; unavailable: boolean }>("replies.prepare", botId, { threadId, turnId: entry.turnId, itemId: entry.id, ...(partId ? { partId } : {}), cursor: next });
        if (!mounted.current) return;
        if (value.reply) { onReply(value.reply); setCursor(null); return; }
        if (value.unavailable || !value.nextCursor) throw Error("This original message is unavailable. Your draft is unchanged.");
        next = value.nextCursor;
      }
      setCursor(next);
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : "Could not prepare this reply. Your draft is unchanged."); }
    finally { if (mounted.current) setBusy(false); }
  };
  return <div className={`bots-reply-action${entry.type === "userMessage" ? " is-user" : ""}`}><button type="button" disabled={busy || !client.online} onClick={() => void select()} title="Quote this message in your composer; no message is sent" aria-label={cursor ? "Continue finding quote source" : "Quote this message in composer"}><CornerUpLeft size={14} aria-hidden="true"/>{busy ? "Loading quote…" : cursor ? "Continue quote lookup" : "Quote reply"}</button>{cursor && !error && <small>More history remains. Continue to locate the original; your draft is unchanged.</small>}{error && <small role="alert">{error}</small>}</div>;
}
