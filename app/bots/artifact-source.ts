import { botsClient } from "./client";
import type { BotAttachment, BotArtifact, BotArtifactPage, BotArtifactPreview } from "../../lib/bots-types";
import { readArtifactCache, writeArtifactCache } from "./artifact-cache";
import { cloudList, cloudDownload, CloudStorageError } from "./cloud-storage";
export type GalleryType = "all" | "image" | "pdf" | "document";
export type GalleryItem = BotAttachment & { createdAt: string | null; botName: string; botColor?: string; direction?: "input" | "output"; version?: string; kind?: BotArtifact["kind"] };
export type GalleryQuery = { botId?: string; search: string; type: GalleryType; cursor: string | null };
export type GalleryPage = { items: GalleryItem[]; nextCursor: string | null; total: number | null };
export const galleryType = (file: Pick<GalleryItem, "mimeType">): Exclude<GalleryType, "all"> => file.mimeType.startsWith("image/") ? "image" : file.mimeType === "application/pdf" ? "pdf" : "document";
export const fileSize = (size: number) => size >= 1024 * 1024 ? `${Number((size / 1024 / 1024).toFixed(1))} MB` : size >= 1024 ? `${Math.round(size / 1024)} KB` : `${size} B`;
export const fileType = (file: GalleryItem) => galleryType(file) === "pdf" ? "PDF" : file.name.split(".").at(-1)?.toUpperCase().slice(0, 12) || "File";

/** Native history stays authoritative; this adapter only reads registered metadata/previews. */
export const artifactSource = {
  async list(query: GalleryQuery, owner: string): Promise<GalleryPage> {
    const filters = { limit:36,cursor:query.cursor,search:query.search.slice(0,160),type:query.type,direction:"all",sort:"newest" };
    const page = botsClient.storageCatalogAvailable ? await cloudList(owner,()=>botsClient.owner,{...filters,botId:query.botId}) : await botsClient.rpc<BotArtifactPage>("artifacts.list", query.botId, filters, undefined, { owner });
    if (page.items.length > 36) throw new Error("The file page was too large. Refresh the library and try again.");
    return { ...page, items: page.items.map((item) => ({ ...item, version: item.preview.version })), total: "total" in page && typeof page.total === "number" ? page.total : null };
  },
  async preview(item: GalleryItem, owner: string): Promise<Blob> {
    if (item.cloudState === "ready" || botsClient.storageCatalogAvailable) {
      try { return (await cloudDownload(owner,()=>botsClient.owner,item.botId,item.id,undefined,true)).blob; }
      catch (error) { if (!(error instanceof CloudStorageError) || !["no_preview","not_found","not_ready"].includes(error.code) && error.status!==404) throw error; }
    }
    const preview = await botsClient.rpc<BotArtifactPreview>("artifacts.preview", item.botId, { id: item.id, version: item.version }, undefined, { owner });
    if (preview.status !== "ready") throw new Error(preview.reason || "Preview unavailable.");
    if (preview.mimeType !== "image/webp" || preview.data.length > 174_764) throw new Error("Preview unavailable. Open the original file.");
    return new Blob([Uint8Array.from(atob(preview.data), (c) => c.charCodeAt(0))], { type: preview.mimeType });
  },
};
export type ArtifactIndexResult = { registered: number; nextCursor: string | null; failures: { itemId: string; reason: string }[] };
const scans = new Map<string, Promise<ArtifactIndexResult>>();
export async function indexArtifacts(botId: string, cursor: string | null, owner: string) {
  const key = JSON.stringify([owner, botId, cursor]), pending = scans.get(key); if (pending) return pending;
  const promise = botsClient.rpc<ArtifactIndexResult>("artifacts.index", botId, { cursor }, undefined, { owner }).then((result) => {
    if (botsClient.owner !== owner) throw new Error("The account changed."); return result;
  }).finally(() => scans.delete(key));
  scans.set(key, promise); return promise;
}
const requests = new Map<string, Promise<GalleryPage>>();
export const galleryKey = (query: GalleryQuery) => JSON.stringify(query);
export async function galleryPage(query: GalleryQuery, owner: string, refresh = false) {
  if (refresh) await requests.get(JSON.stringify([owner, query]))?.catch(() => {});
  const key = JSON.stringify([owner, query]), pending = requests.get(key); if (pending) return pending;
  const promise = artifactSource.list(query, owner).then((page) => {
    if (botsClient.owner !== owner) throw new Error("The account changed.");
    void writeArtifactCache(owner, "page", galleryKey(query), page); return page;
  }).finally(() => requests.delete(key));
  requests.set(key, promise); return promise;
}
let activePreviews = 0;
const previewQueue: (() => void)[] = [], previews = new Map<string, Promise<Blob>>();
export async function artifactPreview(item: GalleryItem, owner: string, online: boolean): Promise<Blob> {
  const cacheKey = JSON.stringify([item.botId, item.id, item.version ?? item.size]), key = JSON.stringify([owner, cacheKey]);
  const cached = await readArtifactCache<Blob>(owner, "preview", cacheKey);
  if (botsClient.owner !== owner) throw new Error("The account changed.");
  if (cached) return cached;
  if (!online) throw new Error("Preview needs a connection.");
  const pending = previews.get(key); if (pending) return pending;
  const promise = (async () => {
    if (activePreviews >= 3) await new Promise<void>((resolve) => previewQueue.push(resolve));
    else activePreviews++;
    try {
      if (botsClient.owner !== owner) throw new Error("The account changed.");
      const blob = await artifactSource.preview(item, owner);
      if (botsClient.owner !== owner) throw new Error("The account changed.");
      void writeArtifactCache(owner, "preview", cacheKey, blob); return blob;
    } finally { const next = previewQueue.shift(); if (next) next(); else activePreviews--; }
  })().finally(() => previews.delete(key));
  previews.set(key, promise); return promise;
}
export async function readArtifactOriginal(item: GalleryItem, owner: string, signal: AbortSignal) {
  signal.throwIfAborted();
  if (item.cloudState === "ready" || botsClient.storageCatalogAvailable) {
    try { const {blob,name}=await cloudDownload(owner,()=>botsClient.owner,item.botId,item.id,signal); return new File([blob],name,{type:blob.type}); }
    catch (error) { if (!(error instanceof CloudStorageError) || !["not_found","not_ready"].includes(error.code) && error.status!==404) throw error; }
  }
  const parts: Uint8Array[] = []; let offset = 0, mimeType = item.mimeType, name = item.name;
  do {
    signal.throwIfAborted(); if (botsClient.owner !== owner) throw new Error("The account changed.");
    const part = await botsClient.rpc<{ data: string; nextOffset: number; size: number; name: string; mimeType: string }>("attachments.read", item.botId, { id: item.id, offset }, undefined, { owner });
    signal.throwIfAborted(); if (botsClient.owner !== owner) throw new Error("The account changed.");
    parts.push(Uint8Array.from(atob(part.data), (c) => c.charCodeAt(0))); mimeType = part.mimeType; name = part.name || name;
    if (part.nextOffset === part.size) break;
    if (part.nextOffset <= offset) throw new Error("The file download paused. Please try again.");
    offset = part.nextOffset;
  } while (true);
  return new File(parts as BlobPart[], name, { type: mimeType });
}
export function saveArtifact(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = blob instanceof File ? blob.name : name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
