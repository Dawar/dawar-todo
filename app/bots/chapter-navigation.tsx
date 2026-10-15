"use client";
import { createContext, useContext, useSyncExternalStore } from "react";
import { Bookmark, BookmarkCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { historyKey, type HistoryEntry } from "../../lib/bot-history-view";
import { chapterEligible, chapterTitle, type BotChapter } from "../../lib/bot-chapters";
import { chapterStore } from "./chapter-store";

/** Navigation-only result of opening a chapter. No path sends, queues,
 * answers or resumes anything; it only reads bounded history to scroll. */
export type ChapterJumpResult = "shown" | "unavailable" | "continue" | "unmounted";
type Jumper = (chapter: BotChapter) => Promise<ChapterJumpResult>;
const jumpers = new Map<string, Jumper>();
const scopeKey = (owner: string, botId: string, threadId: string) => JSON.stringify([owner, botId, threadId]);
export function registerChapterJumper(owner: string, botId: string, threadId: string, jumper: Jumper) {
  const key = scopeKey(owner, botId, threadId);
  jumpers.set(key, jumper);
  return () => { if (jumpers.get(key) === jumper) jumpers.delete(key); };
}
export function jumpToChapter(owner: string, chapter: BotChapter): Promise<ChapterJumpResult> {
  const jumper = jumpers.get(scopeKey(owner, chapter.botId, chapter.threadId));
  return jumper ? jumper(chapter) : Promise.resolve("unmounted");
}

export const ChapterContext = createContext<{ owner: string; botId: string; threadId: string; resolve: (turnId: string, itemId: string) => string | null } | null>(null);

export function PinChapterAction({ entry }: { entry: HistoryEntry }) {
  const scope = useContext(ChapterContext);
  const store = scope ? chapterStore(scope.owner) : null;
  const view = useSyncExternalStore(store?.subscribe ?? noopSubscribe, () => store?.view(scope) ?? null, () => null);
  if (!scope || !store || !view || !chapterEligible(entry, scope.threadId)) return null;
  // Live/final aliases resolve to one canonical response, so neither a
  // replacement nor a repeated pin can create a second chapter.
  const own = scope.resolve(entry.turnId, entry.id) ?? historyKey(entry.turnId, entry.id);
  const pinned = view.chapters.find(chapter => (scope.resolve(chapter.turnId, chapter.itemId) ?? historyKey(chapter.turnId, chapter.itemId)) === own);
  const target = { botId: scope.botId, threadId: scope.threadId };
  return <Button variant="ghost" size="sm" type="button" className="bots-chapter-pin" aria-pressed={Boolean(pinned)}
    title={pinned ? "Remove this chapter bookmark; the response is unchanged" : "Bookmark this response as a chapter; nothing is sent"}
    onClick={() => store.mutate(pinned ? { action: "unpin", ...target, turnId: pinned.turnId, itemId: pinned.itemId }
      : { action: "pin", ...target, turnId: entry.turnId, itemId: entry.id, title: chapterTitle(entry.item?.type === "agentMessage" ? entry.item.text : ""), messageAt: entry.messageAt ?? entry.startedAt ?? null })}>
    {pinned ? <BookmarkCheck aria-hidden="true" /> : <Bookmark aria-hidden="true" />}{pinned ? "Chapter" : "Pin as Chapter"}
  </Button>;
}
const noopSubscribe = () => () => {};
