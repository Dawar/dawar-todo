import { ensureTodoDatabase } from "../../../../db/todos";
import { scheduleAttachmentCleanup, uploadTodoAttachment } from "../../../../db/attachments";

export async function POST(request: Request) {
  const startedAt = Date.now();
  try {
    await ensureTodoDatabase();
    const form = await request.formData();
    const file = form.get("file");
    const draftToken = String(form.get("draftToken") ?? "");
    if (!(file instanceof File)) return Response.json({ error: "Choose an image to upload." }, { status: 400 });
    const attachment = await uploadTodoAttachment(file, { draftToken });
    await scheduleAttachmentCleanup();
    console.info("[todo-api] draft attachment uploaded", {
      attachmentId: attachment.id,
      bytes: attachment.byteSize,
      durationMs: Date.now() - startedAt,
    });
    return Response.json({ attachment }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The image could not be uploaded.";
    const inputError = /choose|image|limited|invalid|large|available/i.test(message);
    console.error("[todo-api] draft attachment upload failed", { durationMs: Date.now() - startedAt, error });
    return Response.json({ error: message }, { status: inputError ? 400 : 500 });
  }
}
