/** Conversation Chapters: owner-scoped bookmarks of existing AI responses.
 * A chapter stores only the response identity, a bounded title and ordering
 * metadata. It never copies the response, creates native items or changes
 * the AI's context. */
export const MAX_CHAPTERS = 200;
export const MAX_CHAPTER_TITLE = 120;
export type BotChapter = {
  botId: string; threadId: string; turnId: string; itemId: string;
  title: string; messageAt: number | null; pinnedAt: string;
};
export type ChapterScope = Pick<BotChapter, "botId" | "threadId">;
export type ChapterTarget = Pick<BotChapter, "botId" | "threadId" | "turnId" | "itemId">;
export type ChapterMutation =
  | ({ action: "pin"; title: string; messageAt: number | null } & ChapterTarget)
  | ({ action: "rename"; title: string } & ChapterTarget)
  | ({ action: "unpin" } & ChapterTarget);
export type ChaptersResponse = { version: 1; owner: string; botId: string; threadId: string; chapters: BotChapter[] };
export type ChapterReceipt = { version: 1; owner: string; chapter: BotChapter | null };

const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
const title = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && [...value].length <= MAX_CHAPTER_TITLE && !/[\u0000-\u001f\u007f]/.test(value);
const at = (value: unknown) => value === null || typeof value === "number" && Number.isFinite(value) && value >= 0 && value < 1e11;
export const chapterKey = (value: ChapterTarget) => JSON.stringify([value.botId, value.threadId, value.turnId, value.itemId]);

export function validChapter(value: unknown): value is BotChapter {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as BotChapter;
  return identity(v.botId) && identity(v.threadId) && identity(v.turnId) && identity(v.itemId) && title(v.title) && at(v.messageAt) &&
    typeof v.pinnedAt === "string" && !Number.isNaN(Date.parse(v.pinnedAt));
}
export function validChapterMutation(value: unknown): value is ChapterMutation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as ChapterMutation, keys = Object.keys(v).sort().join(",");
  if (!identity(v.botId) || !identity(v.threadId) || !identity(v.turnId) || !identity(v.itemId)) return false;
  // Synthetic projections (scheduled findings, unsent client echoes) are not
  // native AI responses and can never become chapters.
  if (/^(finding:|client:)/.test(v.itemId)) return false;
  if (v.action === "pin") return keys === "action,botId,itemId,messageAt,threadId,title,turnId" && title(v.title) && at(v.messageAt);
  if (v.action === "rename") return keys === "action,botId,itemId,threadId,title,turnId" && title(v.title);
  return v.action === "unpin" && keys === "action,botId,itemId,threadId,turnId";
}

/** Deterministic seed title: the first Markdown heading near the top, else
 * the first readable line, stripped of Markdown syntax and bounded. */
export function chapterTitle(text: string): string {
  const lines = text.split("\n").slice(0, 40).map(line => line.trim());
  let inFence = false;
  const readable: string[] = [];
  for (const line of lines) {
    if (/^(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (!inFence && line) readable.push(line);
  }
  const heading = readable.slice(0, 8).find(line => /^#{1,6}\s+\S/.test(line));
  const source = heading ?? readable[0] ?? "";
  const plain = source
    .replace(/^#{1,6}\s+/, "").replace(/^(?:[-*+]|\d+[.)])\s+/, "").replace(/^>\s*/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`~]+/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!plain) return "AI response";
  const chars = [...plain];
  if (chars.length <= 80) return plain;
  const cut = chars.slice(0, 80).join(""), space = cut.lastIndexOf(" ");
  return `${(space > 40 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, "")}…`;
}
export function boundedChapterTitle(value: string): string {
  return [...value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()].slice(0, MAX_CHAPTER_TITLE).join("");
}
/** Stable conversation order: response time, then pin time, then identity. */
export function sortChapters(chapters: BotChapter[]): BotChapter[] {
  return [...chapters].sort((a, b) => (a.messageAt ?? Infinity) - (b.messageAt ?? Infinity) || a.pinnedAt.localeCompare(b.pinnedAt) || chapterKey(a).localeCompare(chapterKey(b)));
}
/** Apply one mutation to a list. Pin is idempotent: a repeated pin of the
 * same canonical response keeps the original row and title. */
export function applyChapterMutation(chapters: BotChapter[], mutation: ChapterMutation, pinnedAt: string): BotChapter[] {
  const key = chapterKey(mutation), existing = chapters.find(chapter => chapterKey(chapter) === key);
  if (mutation.action === "unpin") return existing ? chapters.filter(chapter => chapter !== existing) : chapters;
  if (mutation.action === "rename") return existing ? chapters.map(chapter => chapter === existing ? { ...chapter, title: boundedChapterTitle(mutation.title) } : chapter) : chapters;
  if (existing || chapters.length >= MAX_CHAPTERS) return chapters;
  const { botId, threadId, turnId, itemId, messageAt } = mutation;
  return sortChapters([...chapters, { botId, threadId, turnId, itemId, title: boundedChapterTitle(mutation.title), messageAt, pinnedAt }]);
}

/** Only a completed, visible native assistant answer in this conversation can
 * be a chapter. Human, peer-bot, commentary, tool, reasoning and synthetic
 * finding/client rows are excluded by producer type, never by prose. */
export function chapterEligible(entry: import("./bot-history-view").HistoryEntry, threadId: string | null | undefined): boolean {
  const item = entry.item;
  return Boolean(threadId && entry.type === "agentMessage" && item?.type === "agentMessage" && item.phase !== "commentary" &&
    item.text.trim() && entry.audience !== "finding" && !/^(finding:|client:)/.test(entry.id) &&
    (!entry.sourceThreadId || entry.sourceThreadId === threadId) && (entry.itemStatus ?? "completed") !== "inProgress");
}

