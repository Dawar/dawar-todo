import type { StagedFile } from "./draft-store";
/** Review feedback is an ordinary, separate draft; the PDF stays a reference. */
export type PdfReview = { version: 1; botId: string; attachmentId: string; name: string; page: number; pages: Record<string, string> };
const prefix = "pdf-review:";
export function pdfReviewKey(botId: string, attachmentId: string) {
  return prefix + JSON.stringify([botId, attachmentId]);
}
export function pdfReviewTarget(key: string): { botId: string; attachmentId: string } | null {
  if (!key.startsWith(prefix)) return null;
  try {
    const value: unknown = JSON.parse(key.slice(prefix.length));
    if (Array.isArray(value) && value.length === 2 && value.every(id => typeof id === "string" && id.length > 0 && id.length <= 512))
      return { botId: value[0], attachmentId: value[1] };
  } catch { /* Not a review record. Never infer a send destination. */ }
  return null;
}
export function readPdfReview(text: string, botId: string, attachmentId: string, name = "PDF"): PdfReview {
  if (!text) return { version: 1, botId, attachmentId, name, page: 1, pages: {} };
  const value = JSON.parse(text) as PdfReview;
  if (value.version !== 1 || value.botId !== botId || value.attachmentId !== attachmentId || typeof value.name !== "string" ||
      !Number.isSafeInteger(value.page) || value.page < 1 || !value.pages || typeof value.pages !== "object" || Array.isArray(value.pages) ||
      Object.entries(value.pages).some(([page, feedback]) => !/^[1-9]\d*$/.test(page) || !Number.isSafeInteger(Number(page)) || typeof feedback !== "string"))
    throw Error("This saved review could not be read. Its original feedback is retained.");
  return value;
}
export function pdfReviewMessage(text: string, botId: string, attachmentId: string, files: StagedFile[] = [], includeSource = true) {
  const review = readPdfReview(text, botId, attachmentId);
  if (files.some(file => !Number.isSafeInteger(file.reviewPage) || file.reviewPage! < 1 || !file.remote?.ready || file.remote.botId !== botId))
    throw Error("Finish the page attachment uploads before sending this review.");
  const pages = [...new Set([...Object.keys(review.pages).filter(page => review.pages[page].trim()), ...files.map(file => String(file.reviewPage))])].sort((a,b) => Number(a)-Number(b));
  if (!pages.length) return "";
  // Document metadata is quoted; feedback/newlines/Unicode are the owner's text.
  const label = (name: string) => name.replace(/\\/g, "\\\\").replace(/([\[\]])/g, "\\$1").replace(/[\r\n]/g, " ");
  return `[Review] ${JSON.stringify(review.name)}${includeSource ? `\nPDF attachment: ${attachmentId}` : ""}\n\n` + pages.map(page => {
    const links = files.filter(file => String(file.reviewPage) === page).map(file => `[${label(file.name)}](bot-artifact:${file.remote!.id})`);
    return `[Page ${page}]\n` + [review.pages[page] || "", ...links].filter(Boolean).join("\n");
  }).join("\n\n");
}
