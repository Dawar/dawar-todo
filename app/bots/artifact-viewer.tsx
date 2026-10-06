/* eslint-disable @next/next/no-img-element -- Explicit authenticated blob image/PDF viewer. */
"use client";
import { lazy, Suspense, useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from "react";
import { X, Download, ExternalLink, ZoomIn, ZoomOut, FileText, LoaderCircle, MessageSquare } from "lucide-react";
import { artifactPreview, fileSize, galleryType, readArtifactOriginal, saveArtifact, type GalleryItem } from "./artifact-source";
import type { BotAttachment } from "../../lib/bots-types";
import { botsClient } from "./client";
type ArtifactViewerProps = {
  item: GalleryItem; owner: string; online: boolean; onClose: () => void;
  originalFile?: Blob; sourceAttachment?: BotAttachment; initialSubmission?: { documentFileId: string }; readOnly?: boolean;
};
export function ArtifactViewer(props: ArtifactViewerProps) {
  const canUseOwner = useSyncExternalStore(botsClient.subscribe, () => botsClient.owner === props.owner, () => false);
  // A new owner/document remounts the viewer, disposing the old blob and review.
  return canUseOwner ? <ScopedArtifactViewer key={JSON.stringify([props.owner, props.item.botId, props.item.id, props.readOnly, props.initialSubmission?.documentFileId])} {...props} /> : null;
}
function ScopedArtifactViewer({ item, owner, online, onClose, originalFile, sourceAttachment, initialSubmission, readOnly = false }: ArtifactViewerProps) {
  const dialog = useRef<HTMLDivElement>(null), blob = useRef<Blob | null>(null), urls = useRef(new Set<string>()), hasPreview = useRef(false);
  const [filename, setFilename] = useState(item.name);
  const [url, setUrl] = useState(""), [preview, setPreview] = useState(""), [type, setType] = useState(galleryType(item));
  const [loading, setLoading] = useState(online), [error, setError] = useState(""), [zoom, setZoom] = useState(false), [retry, setRetry] = useState(0);
  const [review, setReview] = useState<Blob | null>(null);
  const closeDialog = useEffectEvent(onClose);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeDialog(); }
      if (event.key !== "Tab") return;
      const elements = [...dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],iframe,textarea:not(:disabled),input:not(:disabled):not([type=hidden])')].filter(element => element.getClientRects().length), first = elements[0], last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("keydown", key, true); if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    const ownedUrls = urls.current;
    return () => { ownedUrls.forEach((url) => URL.revokeObjectURL(url)); ownedUrls.clear(); blob.current = null; hasPreview.current = false; };
  }, []);
  useEffect(() => {
    // A completed original remains usable if the connection drops while open.
    if (blob.current) return;
    const abort = new AbortController();
    if (originalFile) {
      blob.current = originalFile;
      const next = URL.createObjectURL(originalFile); urls.current.add(next);
      void Promise.resolve().then(() => { if (!abort.signal.aborted) { setUrl(next); setLoading(false); setError(""); } });
      return () => abort.abort();
    }
    void Promise.resolve().then(() => { if (!abort.signal.aborted) setLoading(online); });
    if (!hasPreview.current) void artifactPreview(sourceAttachment ? { ...item, ...sourceAttachment } : item, owner, online).then((value) => { if (!abort.signal.aborted) { const next = URL.createObjectURL(value); urls.current.add(next); hasPreview.current = true; setPreview(next); } }).catch(() => {});
    if (online) {
      void readArtifactOriginal(sourceAttachment ? { ...item, ...sourceAttachment } : item, owner, abort.signal).then((value) => {
        if (abort.signal.aborted) return;
        blob.current = value; setFilename(value.name); const next = URL.createObjectURL(value); urls.current.add(next); setUrl(next);
        setType(value.type.startsWith("image/") ? "image" : value.type === "application/pdf" ? "pdf" : "document"); setLoading(false); setError("");
      }).catch((e) => { if (!abort.signal.aborted) { setError(e instanceof Error ? e.message : "This file could not open."); setLoading(false); } });
    }
    return () => { abort.abort(); };
  }, [item, owner, online, retry, originalFile, sourceAttachment]);
  return <div className="bots-file-viewer-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="bots-file-viewer" role="dialog" aria-modal="true" aria-label={filename} ref={dialog}>
      <header><div><strong>{filename}</strong><small>{item.botName} · {fileSize(item.size)}</small></div><button className="bots-icon-button" aria-label="Close preview" onClick={onClose}><X size={21} /></button></header>
      {review ? <Suspense fallback={<div className="bots-file-viewer-body" role="status">Opening review…</div>}><PdfReviewer file={review} item={item} owner={owner} initialSubmission={initialSubmission} onBack={() => setReview(null)} onSent={() => initialSubmission ? onClose() : setReview(null)} /></Suspense> : <div className={`bots-file-viewer-body ${zoom ? "is-zoomed" : ""}`}>
        {type === "image" && (url || preview) && <img src={url || preview} alt={filename} />}
        {type === "pdf" && (url ? <iframe src={`${url}#view=FitH`} title={`PDF: ${filename}`} /> : preview && <img src={preview} alt={`First page of ${item.name}`} />)}
        {type === "document" && <div className="bots-file-viewer-document"><FileText size={44} strokeWidth={1.2} /><strong>{filename}</strong><p>This file is ready to save and open in your preferred app.</p></div>}
        {loading && <div className="bots-file-viewer-notice" role="status"><LoaderCircle className="bots-spin" size={16} />Opening file…</div>}
        {!online && !url && <div className="bots-file-viewer-notice">{preview ? "Saved preview. Connect to open the original." : "Connect to open this file."}</div>}
        {error && <div className="bots-file-viewer-notice is-error" role="alert">{error}<button onClick={() => { setLoading(true); setError(""); setRetry((n) => n + 1); }}>Try again</button></div>}
      </div>}
      <footer><span>{type === "pdf" ? "PDF document" : type === "image" ? "Image" : "Document"}</span><div>
        {type === "image" && (url || preview) && <button onClick={() => setZoom((v) => !v)} aria-label={zoom ? "Fit image" : "Zoom image"}>{zoom ? <ZoomOut size={17} /> : <ZoomIn size={17} />}{zoom ? "Fit" : "Zoom"}</button>}
        {type === "pdf" && url && !review && !readOnly && (initialSubmission || item.ready && !originalFile) && <button onClick={() => setReview(blob.current)}><MessageSquare size={16} />Create review</button>}
        {type === "pdf" && url && <a href={url} target="_blank" rel="noopener noreferrer"><ExternalLink size={16} />Open PDF</a>}
        <button disabled={!url} onClick={() => { if (blob.current) saveArtifact(blob.current, item.name); }}><Download size={16} />Download</button>
      </div></footer>
    </div>
  </div>;
}
const PdfReviewer = lazy(() => import("./pdf-reviewer"));
