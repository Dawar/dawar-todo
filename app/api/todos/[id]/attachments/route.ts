import { listTodoAttachments, scheduleAttachmentCleanup, uploadTodoAttachment } from "../../../../../db/attachments";
import { ensureTodoDatabase, getTodo } from "../../../../../db/todos";

function todoId(value: string) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id: value } = await context.params;
  const id = todoId(value);
  if (!id) return Response.json({ error: "Invalid task." }, { status: 400 });
  try {
    await ensureTodoDatabase();
    if (!await getTodo(id)) return Response.json({ error: "Task not found." }, { status: 404 });
    const attachments = await listTodoAttachments(id);
    await scheduleAttachmentCleanup();
    console.info("[todo-api] attachments listed", { todoId: id, count: attachments.length });
    return Response.json({ attachments });
  } catch (error) {
    console.error("[todo-api] attachment list failed", { todoId: id, error });
    return Response.json({ error: "The images could not be loaded." }, { status: 500 });
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id: value } = await context.params;
  const id = todoId(value);
  if (!id) return Response.json({ error: "Invalid task." }, { status: 400 });
  const startedAt = Date.now();
  try {
    await ensureTodoDatabase();
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return Response.json({ error: "Choose an image to upload." }, { status: 400 });
    const attachment = await uploadTodoAttachment(file, { todoId: id });
    console.info("[todo-api] task attachment uploaded", {
      todoId: id,
      attachmentId: attachment.id,
      bytes: attachment.byteSize,
      durationMs: Date.now() - startedAt,
    });
    return Response.json({ attachment }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The image could not be uploaded.";
    const status = /not found/i.test(message) ? 404 : /choose|image|limited|large/i.test(message) ? 400 : 500;
    console.error("[todo-api] task attachment upload failed", { todoId: id, durationMs: Date.now() - startedAt, error });
    return Response.json({ error: message }, { status });
  }
}
