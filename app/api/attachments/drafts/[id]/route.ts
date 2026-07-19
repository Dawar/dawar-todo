import { deleteDraftAttachment } from "../../../../../db/attachments";
import { ensureTodoDatabase } from "../../../../../db/todos";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  try {
    await ensureTodoDatabase();
    const payload = (await request.json().catch(() => ({}))) as { draftToken?: string };
    const removed = await deleteDraftAttachment(id, payload.draftToken ?? "");
    if (new URL(request.url).searchParams.get("discard") === "1") {
      return Response.json({ attachmentId: id, discarded: removed });
    }
    if (!removed) return Response.json({ error: "Image not found." }, { status: 404 });
    return Response.json({ attachmentId: id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The image could not be removed.";
    console.error("[todo-api] draft attachment delete failed", { attachmentId: id, error });
    return Response.json({ error: message }, { status: /invalid/i.test(message) ? 400 : 500 });
  }
}
