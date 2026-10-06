"use client";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ArrowLeft, LoaderCircle, Send } from "lucide-react";
import DocumentPreview from "./document-preview";
import { documentIdentity, type DocumentKind } from "./document-source";
import { readPdfReview } from "./pdf-review";
import { botComposers } from "./composer-service";
import { botsClient } from "./client";
import type { GalleryItem } from "./artifact-source";
export default function DocumentReviewer({ file, kind, item, owner, onBack, onSent, initialSubmission }: {
  file: Blob; kind: DocumentKind; item: GalleryItem; owner: string; onBack: () => void; onSent: () => void;
  initialSubmission?: { documentFileId: string; documentIdentity?: string };
}) {
  useSyncExternalStore(botComposers.subscribe, botComposers.snapshot, () => 0);
  const online = useSyncExternalStore(botsClient.subscribe, () => botsClient.online && botsClient.owner === owner, () => false);
  const composer = useMemo(() => botComposers.reviewComposer(owner, item.botId, item.id), [owner, item.botId, item.id]);
  const identity = documentIdentity(item), mounted = useRef(false);
  const [applying, setApplying] = useState(false), [error, setError] = useState(""), [rendered, setRendered] = useState(false);
  const ready = useCallback((value: boolean) => setRendered(value), []);
  useEffect(() => {
    mounted.current = true;
    void composer.open().then(() => { if (mounted.current) void composer.reconcile(); }).catch(() => {});
    return () => { mounted.current = false; };
  }, [composer]);
  const saved = useMemo(() => {
    let retainedNotes = "";
    try {
      const review = readPdfReview(composer.draft.text, item.botId, item.id, item.name);
      if (!composer.draft.text) return { review: { ...review, format: "document" as const, source: identity }, error: "", retainedNotes };
      if (review.format === "document") retainedNotes = review.pages[1] ?? "";
      if (review.format !== "document" || review.source !== identity || composer.draft.files.length) throw Error("This saved review belongs to an earlier document version. Its feedback is retained.");
      return { review, error: "", retainedNotes };
    } catch (error) { return { review: null, error: error instanceof Error ? error.message : "Saved feedback could not be read.", retainedNotes }; }
  }, [composer.draft.text, composer.draft.files.length, item.botId, item.id, item.name, identity]);
  const review = saved.review, notes = review?.pages[1] ?? saved.retainedNotes;
  const locked = !composer.ready || !composer.canUseOwner || composer.committing || Boolean(composer.operation) || applying || Boolean(review?.additionPending) || !review;
  const send = async () => {
    if (!review || !notes.trim() || applying || !composer.canUseOwner) return;
    if (initialSubmission) {
      if (!review.additionId || !initialSubmission.documentIdentity) { setError("Reopen this document in its original draft before adding feedback. Your notes are retained."); return; }
      setApplying(true); setError("");
      try {
        if (!review.additionPending) { composer.setText(JSON.stringify({ ...review, additionPending: true })); await composer.flush(); }
        await botComposers.appendReview(owner, item.botId, initialSubmission.documentFileId, review.additionId, initialSubmission.documentIdentity);
        if (mounted.current && composer.canUseOwner) onSent();
      } catch (error) {
        if ((error as { reviewAdditionOutcome?: string }).reviewAdditionOutcome === "not-applied" && composer.canUseOwner) {
          try {
            const current = readPdfReview(composer.draft.text, item.botId, item.id, item.name);
            if (current.additionId === review.additionId) composer.setText(JSON.stringify({ ...current, additionPending: false }));
          } catch { /* A newer unreadable record remains intact for recovery. */ }
        }
        if (mounted.current) setError(error instanceof Error ? error.message : "Feedback could not be added. Your notes are retained.");
      }
      finally { if (mounted.current) setApplying(false); }
    } else {
      await composer.send();
      if (mounted.current && composer.ready && composer.canUseOwner && !composer.operation && !composer.draft.text && !composer.actionError && !composer.storageError) onSent();
    }
  };
  return <div className="bots-document-review">
    <div className="bots-document-review-toolbar"><button onClick={onBack}><ArrowLeft size={16} />Document</button></div>
    <div className="bots-document-review-columns"><DocumentPreview file={file} kind={kind} name={item.name} onReady={ready} />
      <section className="bots-document-notes"><label htmlFor="document-review-notes">Review notes</label>
        <textarea id="document-review-notes" placeholder="Your feedback on this document…" value={notes} readOnly={locked} maxLength={200000} onChange={event => {
          if (review && !locked) composer.setText(JSON.stringify({ ...review, additionId: review.additionId ?? crypto.randomUUID(), pages: { "1": event.target.value } }));
        }} />
        {(saved.error || error || composer.storageError || composer.actionError || composer.operation?.error) && <p role="alert">{saved.error || error || composer.storageError || composer.actionError || composer.operation?.error}</p>}
        {!online && !initialSubmission && <p role="status">Connect to send feedback. Your notes stay saved on this device.</p>}
        <button disabled={!composer.ready || !composer.canUseOwner || !initialSubmission && !online || composer.committing || applying || !rendered || !notes.trim() || Boolean(saved.error)} onClick={() => void send()}>
          {applying || composer.sendingNow ? <LoaderCircle className="bots-spin" size={16} /> : <Send size={16} />}{initialSubmission ? review?.additionPending ? "Check addition" : "Add review to message" : composer.operation ? "Check delivery" : "Send feedback"}
        </button>
      </section>
    </div>
  </div>;
}
