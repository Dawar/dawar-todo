"use client";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight, LoaderCircle, Paperclip, Send, X } from "lucide-react";
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type PDFDocumentLoadingTask, type RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { botComposers } from "./composer-service";
import { botsClient } from "./client";
import { readPdfReview, type PdfReview } from "./pdf-review";
import { fileSize, type GalleryItem } from "./artifact-source";
import "./pdf-reviewer.css";
import { PdfBinaryDataFactory } from "./pdf-assets";

GlobalWorkerOptions.workerSrc = workerUrl;
export default function PdfReviewer({ file, item, owner, onBack, onSent, initialSubmission }: {
  file: Blob; item: GalleryItem; owner: string; onBack: () => void; onSent: () => void; initialSubmission?: { documentFileId: string };
}) {
  useSyncExternalStore(botComposers.subscribe, botComposers.snapshot, () => 0);
  useSyncExternalStore(botsClient.subscribe, () => botsClient.online && botsClient.owner === owner, () => false);
  const composer = useMemo(() => botComposers.reviewComposer(owner, item.botId, item.id), [owner, item.botId, item.id]);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null), [error, setError] = useState(""), [renderError, setRenderError] = useState("");
  const [rendering, setRendering] = useState(true), [width, setWidth] = useState(600), [retry, setRetry] = useState(0), [loadRetry, setLoadRetry] = useState(0);
  const surface = useRef<HTMLDivElement>(null), picker = useRef<HTMLInputElement>(null);
  const transfer = useRef<string | null>(null), [applying, setApplying] = useState(false), [applyError, setApplyError] = useState("");
  useEffect(() => { void composer.open().then(() => { void composer.resumeUploads(true); void composer.reconcile(); }); }, [composer]);
  const saved = useMemo(() => {
    try { return { review: readPdfReview(composer.draft.text, item.botId, item.id, item.name), error: "" }; }
    catch (error) { return { review: null, error: error instanceof Error ? error.message : "Saved feedback is unavailable." }; }
  }, [composer.draft.text, item.botId, item.id, item.name]);
  const review = saved.review, files = composer.draft.files;
  const page = Math.min(review?.page ?? 1, pdf?.numPages ?? 1);
  const locked = !composer.ready || !composer.canUseOwner || composer.committing || Boolean(composer.operation) || !review || applying;
  const notedPages = [...new Set([...Object.keys(review?.pages ?? {}).filter(page => review?.pages[page].trim()).map(Number), ...files.map(file => file.reviewPage!)] )].sort((a,b) => a-b);
  const save = (next: PdfReview) => { if (!locked) composer.setText(JSON.stringify(next)); };
  const go = (next: number) => { if (review && pdf && Number.isInteger(next) && next >= 1 && next <= pdf.numPages) save({ ...review, page: next }); };
  useEffect(() => {
    let active = true, task: PDFDocumentLoadingTask | undefined;
    void file.arrayBuffer().then(data => {
      if (!active) return;
      task = getDocument({ data: new Uint8Array(data), maxImageSize: 16_000_000, useWorkerFetch: false, BinaryDataFactory: PdfBinaryDataFactory });
      return task.promise.then(value => { if (active) { setPdf(value); setError(""); } });
    }).catch(error => { if (active) setError(error?.name === "PasswordException" ? "This PDF needs a password. Open an unlocked copy to review it." : "This PDF could not open for review. Your feedback is retained."); });
    return () => { active = false; void task?.destroy().catch(() => {}); };
  }, [file, loadRetry]);
  useEffect(() => {
    const element = surface.current; if (!element) return;
    const observer = new ResizeObserver(() => setWidth(Math.max(120, element.clientWidth - 32)));
    observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!pdf || !surface.current) return;
    let active = true, render: RenderTask | undefined;
    const element = surface.current;
    element.replaceChildren();
    void Promise.resolve().then(async () => {
      if (!active) return;
      setRendering(true); setRenderError("");
      const source = await pdf.getPage(page); if (!active) return;
      const viewport = source.getViewport({ scale: Math.min(2, width / source.getViewport({ scale: 1 }).width) });
      const scale = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(4_000_000 / (viewport.width * viewport.height)));
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width * scale); canvas.height = Math.ceil(viewport.height * scale);
      canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`;
      canvas.setAttribute("role", "img"); canvas.setAttribute("aria-label", `PDF page ${page}`);
      render = source.render({ canvas, viewport, transform: scale === 1 ? undefined : [scale, 0, 0, scale, 0, 0] });
      await render.promise;
      if (active) { element.replaceChildren(canvas); setRendering(false); source.cleanup(); }
    }).catch(() => { if (active) { setRendering(false); setRenderError("This page could not render. Your feedback is retained."); } });
    return () => { active = false; render?.cancel(); };
  }, [pdf, page, width, retry]);
  const send = async () => {
    if (initialSubmission) {
      setApplying(true); setApplyError(""); transfer.current ??= crypto.randomUUID();
      try { await botComposers.appendReview(owner, item.botId, initialSubmission.documentFileId, transfer.current); onSent(); }
      catch (error) { setApplyError(error instanceof Error ? error.message : "The review could not be added. Your feedback is retained."); }
      finally { setApplying(false); }
      return;
    }
    await composer.send();
    if (composer.ready && composer.canUseOwner && !composer.operation && !composer.draft.text && !composer.draft.files.length && !composer.actionError && !composer.storageError) onSent();
  };
  return <div className="bots-pdf-review">
    <div className="bots-pdf-review-toolbar">
      <button onClick={onBack}><ArrowLeft size={16} />PDF</button>
      <nav aria-label="PDF review pages">
        <button aria-label="Previous page" disabled={locked || page <= 1 || !pdf} onClick={() => go(page - 1)}><ChevronLeft size={19} /></button>
        <label>Page <input aria-label="Review page" type="number" min={1} max={pdf?.numPages ?? 1} value={page} disabled={locked || !pdf} onChange={event => go(Number(event.target.value))} /> of {pdf?.numPages ?? "…"}</label>
        <button aria-label="Next page" disabled={locked || !pdf || page >= pdf.numPages} onClick={() => go(page + 1)}><ChevronRight size={19} /></button>
      </nav>
    </div>
    <div className="bots-pdf-review-layout">
      <section className="bots-pdf-review-page" aria-label={`Document page ${page}`}>
        <div className="bots-pdf-review-canvas" ref={surface} />
        {!error && rendering && <div className="bots-pdf-review-loading" role="status"><LoaderCircle className="bots-spin" size={18} />Opening page…</div>}
        {(error || renderError) && <div className="bots-pdf-review-loading is-error" role="alert">{error || renderError}<button onClick={() => error ? setLoadRetry(n => n + 1) : setRetry(n => n + 1)}>{error ? "Retry PDF" : "Retry page"}</button></div>}
      </section>
      <section className="bots-pdf-review-notes">
        <label htmlFor="pdf-page-feedback">Feedback for page {page}</label>
        <textarea id="pdf-page-feedback" placeholder="Your feedback for this page…" value={review?.pages[page] ?? ""} disabled={locked || !pdf} maxLength={200000}
          onChange={event => review && save({ ...review, pages: { ...review.pages, [page]: event.target.value } })} />
        <input ref={picker} type="file" multiple hidden onChange={event => {
          if (!locked && review && event.target.files?.length) { save(review); composer.addFiles([...event.target.files], page); }
          event.target.value = "";
        }} />
        <button className="bots-pdf-review-attach" disabled={locked || !pdf} onClick={() => picker.current?.click()}><Paperclip size={16} />Attach to page {page}</button>
        <ul className="bots-pdf-review-files">{files.filter(file => file.reviewPage === page).map(file => <li key={file.id}>
          <span><strong>{file.name}</strong><small>{file.remote?.ready ? fileSize(file.size) : file.error || (composer.progress.has(file.id) ? `Uploading ${Math.round(composer.progress.get(file.id)!)}%` : "Waiting to upload")}</small></span>
          <button aria-label={`Remove ${file.name} from page ${page}`} disabled={locked} onClick={() => composer.removeFile(file.id)}><X size={16} /></button>
        </li>)}</ul>
        <div className="bots-pdf-review-bottom">
          {notedPages.length > 0 && <div className="bots-pdf-review-noted" aria-label="Pages with feedback">{notedPages.map(number => <button key={number} disabled={locked} aria-current={page === number ? "page" : undefined} onClick={() => go(number)}>Page {number}</button>)}</div>}
          {(saved.error || applyError || composer.storageError || composer.actionError || composer.operation?.error) && <p role="alert">{saved.error || applyError || composer.storageError || composer.actionError || composer.operation?.error}</p>}
          {files.some(file => file.error && !file.remote?.ready) && <button disabled={!botsClient.online || locked} onClick={() => void composer.resumeUploads(true)}>Retry uploads</button>}
          <button className="bots-pdf-review-send" disabled={!composer.ready || !composer.canUseOwner || !initialSubmission && !botsClient.online || composer.committing || applying || !pdf || !notedPages.length || Boolean(saved.error) || !composer.operation && files.some(file => !file.remote?.ready)} onClick={() => void send()}>
            {composer.sendingNow || composer.committing || applying ? <LoaderCircle className="bots-spin" size={17} /> : <Send size={17} />}{initialSubmission ? "Add review to message" : composer.operation ? "Check delivery" : "Send review"}
          </button>
        </div>
      </section>
    </div>
  </div>;
}
