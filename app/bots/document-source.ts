/** Preview classification is deliberately separate from gallery filters/transport. */
export type DocumentKind = "markdown" | "html";
export const DOCUMENT_PREVIEW_BYTES = 1024 * 1024;
export function documentKind(file: { name: string; mimeType: string }): DocumentKind | null {
  const mime = file.mimeType.split(";", 1)[0].trim().toLowerCase();
  if (["text/markdown", "text/x-markdown"].includes(mime)) return "markdown";
  if (mime === "text/html") return "html";
  // Explicit non-text types (including PDF/images) keep their original viewers.
  if (!["", "text/plain", "application/octet-stream"].includes(mime)) return null;
  if (/\.(md|markdown)$/i.test(file.name)) return "markdown";
  if (/\.html?$/i.test(file.name)) return "html";
  return null;
}
export async function readDocumentText(file: Blob, signal: AbortSignal) {
  if (file.size > DOCUMENT_PREVIEW_BYTES) throw Error("Preview supports documents up to 1 MB. Download the original to read this file.");
  signal.throwIfAborted();
  const bytes = await file.arrayBuffer(); signal.throwIfAborted();
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0")) throw Error("Binary document");
    if (text.length > 250000 || text.split("\n").length > 10000 || (text.match(/</g)?.length ?? 0) > 20000)
      throw Error("Preview complexity limit");
    return text;
  } catch { throw Error("This document is not readable UTF-8 text or is too complex to preview. Download the original to open it."); }
}
/** Stable source metadata; thumbnail revisions do not change original bytes. */
export function documentIdentity(file: { id: string; name: string; size: number; mimeType: string; sha256?: string }) {
  return JSON.stringify([file.id, file.name, file.size, file.mimeType, file.sha256 ?? null]);
}
