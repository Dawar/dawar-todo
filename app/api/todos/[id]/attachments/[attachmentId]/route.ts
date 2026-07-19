import { deleteTodoAttachment, discardTodoAttachmentUpload } from "../../../../../../db/attachments";
import { ensureTodoDatabase } from "../../../../../../db/todos";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string; attachmentId: string }> },
) {
  const { id: todoValue, attachmentId } = await context.params;
  const todoId = Number(todoValue);
  if (!Number.isInteger(todoId) || todoId < 1) return Response.json({ error: "Invalid task." }, { status: 400 });
  try {
    await ensureTodoDatabase();
    if (new URL(request.url).searchParams.get("discard") === "1") {
      const discarded = await discardTodoAttachmentUpload(todoId, attachmentId);
      return Response.json({ attachmentId, discarded });
    }
    const result = await deleteTodoAttachment(todoId, attachmentId);
    if (!result) return Response.json({ error: "Image not found." }, { status: 404 });
    return Response.json(result);
  } catch (error) {
    console.error("[todo-api] task attachment delete failed", { todoId, attachmentId, error });
    return Response.json({ error: "The image could not be deleted." }, { status: 500 });
  }
}
