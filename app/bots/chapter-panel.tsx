"use client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { BookmarkX, Bookmark, Check, Pencil, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Bot } from "../../lib/bots-types";
import { MAX_CHAPTER_TITLE, boundedChapterTitle, chapterKey, type BotChapter } from "../../lib/bot-chapters";
import { chapterStore } from "./chapter-store";
import { jumpToChapter } from "./chapter-navigation";
import "./chapters.css";

type Note = { kind: "busy" | "continue" | "unavailable" | "error"; text: string };
const when = (seconds: number | null) => seconds === null ? "" : new Date(seconds * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** Navigation tab: the selected conversation's pinned AI responses. Opening,
 * renaming or unpinning a chapter never sends, queues or changes context. */
export function ChapterNavigation({ owner, bot, online, onJumped }: { owner: string; bot: Bot; online: boolean; onJumped?: () => void }) {
  const store = chapterStore(owner);
  const scope = bot.threadId ? { botId: bot.id, threadId: bot.threadId } : null;
  const view = useSyncExternalStore(store.subscribe, () => store.view(scope), () => store.view(null));
  const [notes, setNotes] = useState<Record<string, Note>>({});
  const [editing, setEditing] = useState<string | null>(null), [draft, setDraft] = useState("");
  const generation = useRef(0);
  const threadId = bot.threadId;
  useEffect(() => {
    if (!threadId) return;
    const target = { botId: bot.id, threadId };
    void store.load(target);
    const retry = () => void store.load(target);
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [store, bot.id, threadId]);
  if (!scope) return <p className="bots-details-lead">This bot has no conversation yet.</p>;
  const open = async (chapter: BotChapter) => {
    // Only the newest request may report or move; a late reply after another
    // click, a bot switch or an owner change is ignored.
    const mine = ++generation.current, key = chapterKey(chapter);
    setNotes(prior => ({ ...prior, [key]: { kind: "busy", text: "Finding this response…" } }));
    let note: Note | null = null;
    try {
      const result = await jumpToChapter(owner, chapter);
      if (result === "shown") { note = null; if (mine === generation.current) onJumped?.(); }
      else if (result === "continue") note = { kind: "continue", text: "Not in the loaded history yet. Open again to search earlier messages." };
      else if (result === "unavailable") note = { kind: "unavailable", text: "This response is no longer available in this conversation. You can unpin it." };
      else note = { kind: "error", text: "Open this conversation to jump to the chapter." };
    } catch (reason) { note = { kind: "error", text: reason instanceof Error ? reason.message : "Could not open this chapter. Try again." }; }
    if (mine !== generation.current) return;
    setNotes(prior => { const next = { ...prior }; if (note) next[key] = note; else delete next[key]; return next; });
  };
  const saveTitle = (chapter: BotChapter) => {
    const title = boundedChapterTitle(draft);
    if (title && title !== chapter.title) store.mutate({ action: "rename", botId: chapter.botId, threadId: chapter.threadId, turnId: chapter.turnId, itemId: chapter.itemId, title });
    setEditing(null);
  };
  return <>
    <h3>Navigation</h3>
    <p className="bots-details-lead">Chapters bookmark important AI responses in this conversation. Pinning never sends a message, starts a thread or changes the AI&apos;s context.</p>
    {view.pending > 0 ? <p className="bots-chapters-status" role="status">{view.pending === 1 ? "1 change is" : `${view.pending} changes are`} saved on this device and not synced yet.{" "}
      <Button variant="link" size="sm" type="button" className="h-auto px-0" disabled={!online} onClick={() => void store.flush()}>Retry sync</Button></p>
      : view.error ? <p className="bots-chapters-status" role="alert">{view.error} <Button variant="link" size="sm" type="button" className="h-auto px-0" onClick={() => void store.load(scope)}>Retry</Button></p>
      : !view.loaded && view.loading ? <p className="bots-chapters-status" role="status">Loading chapters…</p> : null}
    {!view.chapters.length ? <div className="bots-details-empty"><Bookmark size={27} strokeWidth={1.5} aria-hidden="true" /><h3>No chapters yet</h3><p>Use Pin as Chapter under an AI response to bookmark milestones, decisions or finished work. They appear here in conversation order.</p></div>
      : <ol className="bots-chapters" aria-label="Chapters">{view.chapters.map((chapter, index) => {
        const key = chapterKey(chapter), note = notes[key], local = view.pendingKeys.has(key);
        return <li key={key} className="bots-chapter">
          <span className="bots-chapter-index" aria-hidden="true">{index + 1}</span>
          <Button variant="ghost" type="button" className="bots-chapter-open" disabled={note?.kind === "busy"} onClick={() => void open(chapter)} aria-label={`Jump to chapter ${index + 1}: ${chapter.title}`}>
            <span>{chapter.title}</span><small>{[when(chapter.messageAt), local ? "On this device" : ""].filter(Boolean).join(" · ") || "AI response"}</small>
          </Button>
          <span className="bots-chapter-tools">
            <Button variant="ghost" size="icon" type="button" aria-label={`Rename chapter ${index + 1}`} title="Rename" onClick={() => { setEditing(key); setDraft(chapter.title); }}><Pencil aria-hidden="true" /></Button>
            <Button variant="ghost" size="icon" type="button" aria-label={`Unpin chapter ${index + 1}`} title="Unpin; the response is unchanged" onClick={() => store.mutate({ action: "unpin", botId: chapter.botId, threadId: chapter.threadId, turnId: chapter.turnId, itemId: chapter.itemId })}><BookmarkX aria-hidden="true" /></Button>
          </span>
          {editing === key && <form className="bots-chapter-rename" onSubmit={event => { event.preventDefault(); saveTitle(chapter); }}>
            <Input aria-label="Chapter title" value={draft} maxLength={MAX_CHAPTER_TITLE} autoFocus onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setEditing(null); } }} />
            <Button variant="ghost" size="icon" type="submit" aria-label="Save title" disabled={!boundedChapterTitle(draft)}><Check aria-hidden="true" /></Button>
            <Button variant="ghost" size="icon" type="button" aria-label="Cancel rename" onClick={() => setEditing(null)}><X aria-hidden="true" /></Button>
          </form>}
          {note && note.kind !== "busy" && <p className="bots-chapter-note" role={note.kind === "error" || note.kind === "unavailable" ? "alert" : "status"}>{note.text}</p>}
          {note?.kind === "busy" && <p className="bots-chapter-note" role="status">{note.text}</p>}
        </li>;
      })}</ol>}
  </>;
}
