"use client";
import { portableHeaders } from "../../lib/portable-csrf";
import { MAX_CHAPTERS, applyChapterMutation, chapterKey, sortChapters, validChapter, validChapterMutation, type BotChapter, type ChapterMutation, type ChapterReceipt, type ChapterScope, type ChaptersResponse } from "../../lib/bot-chapters";

export type ChapterView = {
  chapters: BotChapter[]; loaded: boolean; loading: boolean; error: string;
  /** Changes kept on this device that the server has not confirmed yet. */
  pending: number; pendingKeys: ReadonlySet<string>;
};
type Pending = { id: string; mutation: ChapterMutation; at: string };
export type ChapterTransport = {
  read: (owner: string, scope: ChapterScope) => Promise<ChaptersResponse>;
  write: (owner: string, mutation: ChapterMutation) => Promise<ChapterReceipt>;
};
export class ChapterRequestError extends Error { constructor(message: string, readonly permanent: boolean) { super(message); } }
const request = async <T,>(owner: string, url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, { ...init, credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(8000),
    headers: portableHeaders({ "Content-Type": "application/json", "X-Dawar-Preference-Owner": owner }) });
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = value && typeof value === "object" && "error" in value && typeof value.error === "string" ? value.error : "Chapters are unavailable.";
    throw new ChapterRequestError(message, response.status === 400 || response.status === 409 || response.status === 413);
  }
  return value as T;
};
const fetchTransport: ChapterTransport = {
  read: (owner, scope) => request(owner, `/api/bots/chapters?${new URLSearchParams({ botId: scope.botId, threadId: scope.threadId })}`),
  write: (owner, mutation) => request(owner, "/api/bots/chapters", { method: "PATCH", body: JSON.stringify(mutation) }),
};
const scopeKey = (scope: ChapterScope) => JSON.stringify([scope.botId, scope.threadId]);
const EMPTY: ChapterView = { chapters: [], loaded: false, loading: false, error: "", pending: 0, pendingKeys: new Set() };

/** Owner-scoped chapter bookmarks. Server rows are authoritative; unconfirmed
 * changes stay in this browser and replay in order, so a lost response or
 * an offline pin is never reported as synced. Only bookmark metadata is
 * stored; no response text, history or hidden data. */
export class ChapterStore {
  private server = new Map<string, BotChapter[]>();
  private status = new Map<string, { loaded: boolean; loading: boolean; error: string }>();
  private views = new Map<string, ChapterView>();
  private pending: Pending[] = [];
  private listeners = new Set<() => void>();
  private flushing = false;
  private readonly pendingKey: string;
  constructor(readonly owner: string, private transport: ChapterTransport = fetchTransport, private storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null = typeof localStorage === "undefined" ? null : localStorage) {
    this.pendingKey = `dawar-bots:${owner}:chapters:v1:pending`;
    try {
      const raw = this.storage?.getItem(this.pendingKey);
      const value: unknown = raw && raw.length < 256 * 1024 ? JSON.parse(raw) : [];
      if (Array.isArray(value)) this.pending = value.filter((p): p is Pending => p && typeof p.id === "string" && typeof p.at === "string" && validChapterMutation(p.mutation)).slice(0, 500);
    } catch { /* Corrupt local data never blocks the conversation. */ }
  }
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  view = (scope: ChapterScope | null): ChapterView => {
    if (!scope) return EMPTY;
    const key = scopeKey(scope);
    let view = this.views.get(key);
    if (!view) {
      const status = this.status.get(key) ?? { loaded: false, loading: false, error: "" };
      const own = this.pending.filter(p => p.mutation.botId === scope.botId && p.mutation.threadId === scope.threadId);
      let chapters = this.server.get(key) ?? this.cached(scope);
      for (const p of own) chapters = applyChapterMutation(chapters, p.mutation, p.at);
      view = { chapters: sortChapters(chapters), ...status, pending: own.length, pendingKeys: new Set(own.map(p => chapterKey(p.mutation))) };
      this.views.set(key, view);
    }
    return view;
  };
  private emit(scope?: ChapterScope) {
    if (scope) this.views.delete(scopeKey(scope)); else this.views.clear();
    for (const fn of [...this.listeners]) fn();
  }
  private cacheKey(scope: ChapterScope) { return `dawar-bots:${this.owner}:chapters:v1:${scopeKey(scope)}`; }
  private cached(scope: ChapterScope): BotChapter[] {
    try {
      const raw = this.storage?.getItem(this.cacheKey(scope));
      const value: unknown = raw && raw.length < 128 * 1024 ? JSON.parse(raw) : [];
      return Array.isArray(value) ? value.filter(validChapter).filter(c => c.botId === scope.botId && c.threadId === scope.threadId).slice(0, MAX_CHAPTERS) : [];
    } catch { return []; }
  }
  private savePending() {
    try { if (this.pending.length) this.storage?.setItem(this.pendingKey, JSON.stringify(this.pending)); else this.storage?.removeItem(this.pendingKey); }
    catch { /* The in-memory change remains pending and is labelled as such. */ }
  }
  private setStatus(scope: ChapterScope, patch: Partial<{ loaded: boolean; loading: boolean; error: string }>) {
    const key = scopeKey(scope);
    this.status.set(key, { ...(this.status.get(key) ?? { loaded: false, loading: false, error: "" }), ...patch });
  }
  async load(scope: ChapterScope) {
    const key = scopeKey(scope);
    if (this.status.get(key)?.loading) return;
    this.setStatus(scope, { loading: true }); this.emit(scope);
    try {
      const result = await this.transport.read(this.owner, scope);
      if (result.owner !== this.owner || result.botId !== scope.botId || result.threadId !== scope.threadId) throw Error("Chapters belong to another conversation.");
      const chapters = result.chapters.filter(validChapter).filter(c => c.botId === scope.botId && c.threadId === scope.threadId);
      this.server.set(key, chapters);
      try { this.storage?.setItem(this.cacheKey(scope), JSON.stringify(chapters)); } catch { /* Cache is optional. */ }
      this.setStatus(scope, { loaded: true, loading: false, error: "" });
    } catch (error) {
      this.setStatus(scope, { loading: false, error: error instanceof Error ? error.message : "Chapters are unavailable." });
    }
    this.emit(scope);
    void this.flush();
  }
  mutate(mutation: ChapterMutation) {
    if (!validChapterMutation(mutation)) throw Error("This response cannot be a chapter.");
    this.pending.push({ id: crypto.randomUUID(), mutation, at: new Date().toISOString() });
    this.savePending(); this.emit(mutation);
    void this.flush();
  }
  /** Replays unconfirmed changes in their original order, one at a time. */
  async flush() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.pending.length) {
        const next = this.pending[0], scope = { botId: next.mutation.botId, threadId: next.mutation.threadId }, key = scopeKey(scope);
        try {
          const receipt = await this.transport.write(this.owner, next.mutation);
          if (receipt.owner !== this.owner) throw Error("Owner changed.");
          const prior = this.server.get(key) ?? this.cached(scope);
          const without = prior.filter(c => chapterKey(c) !== chapterKey(next.mutation));
          const chapter = receipt.chapter && validChapter(receipt.chapter) && chapterKey(receipt.chapter) === chapterKey(next.mutation) ? receipt.chapter : null;
          this.server.set(key, sortChapters(chapter ? [...without, chapter] : without));
          try { this.storage?.setItem(this.cacheKey(scope), JSON.stringify(this.server.get(key))); } catch { /* Cache is optional. */ }
          this.setStatus(scope, { error: "" });
        } catch (error) {
          if (!(error instanceof ChapterRequestError && error.permanent)) {
            this.setStatus(scope, { error: "Saved on this device. Not synced yet." }); this.emit(scope); return;
          }
          this.setStatus(scope, { error: error.message });
        }
        this.pending = this.pending.filter(p => p.id !== next.id);
        this.savePending(); this.emit(scope);
      }
    } finally { this.flushing = false; }
  }
}
const stores = new Map<string, ChapterStore>();
export function chapterStore(owner: string): ChapterStore {
  let store = stores.get(owner);
  if (!store) { store = new ChapterStore(owner); stores.set(owner, store); }
  return store;
}
