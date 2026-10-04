export type AttachmentPhase = "identity" | "image-binding" | "image-info" | "image-transform" | "prepare" | "storage" | "finalize";

export function attachmentErrorDetails(error: unknown, fallback: AttachmentPhase = "prepare") {
  const tagged = error as { attachmentPhase?: AttachmentPhase; code?: string; name?: string; message?: string };
  const message = typeof tagged?.message === "string" ? tagged.message : "";
  // Allowlist categories, never echo arbitrary storage/DB errors (which can
  // include signed URLs, SQL parameters, file names or credentials).
  const safeMessage = tagged?.code === "storage-unavailable" ? "Private storage verification failed. Retry the same attachment; local bytes are retained."
    : message === "Image processing is temporarily unavailable." ? message
    : /no such (?:table|column)/i.test(message) ? "Attachment database schema is incomplete."
    : /already used|attachment was removed/i.test(message) ? "Upload identity conflicts with existing metadata."
    : /not found/i.test(message) ? "Upload target not found."
    : /quota|limit|too large/i.test(message) ? "Attachment exceeds a service or validation limit."
    : /expected|invalid|empty|match|choose/i.test(message) ? "Attachment validation failed."
    : /storage|accessdenied|signature/i.test(message) ? "Private storage rejected the operation."
    : /network|fetch|timed? ?out/i.test(message) ? "Attachment service transport failed."
    : "Attachment service operation failed; inspect the reported phase.";
  return { phase: tagged?.attachmentPhase ?? fallback,
    code: ["image-processing-unavailable", "storage-unavailable"].includes(tagged?.code ?? "") ? tagged.code! : "attachment-failed",
    errorName: ["Error", "TypeError", "RangeError", "TimeoutError", "AbortError"].includes(tagged?.name ?? "") ? tagged.name! : "Error",
    errorMessage: safeMessage };
}
