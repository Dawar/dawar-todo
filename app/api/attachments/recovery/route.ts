import { inspectAttachmentRecovery, imageProcessingAvailable, inspectTaskUploadStorage } from "../../../../db/attachments";
import { ensureTodoDatabase } from "../../../../db/todos";

export async function POST(request: Request) {
  const payload = await request.json().catch(() => null) as { todoId?: number; ids?: string[]; draftToken?: string; inspectStorage?: boolean } | null;
  if (!payload || !Number.isInteger(payload.todoId) || payload.todoId! < 1
    || !Array.isArray(payload.ids) || payload.ids.length < 1 || payload.ids.length > 2
    || !payload.ids.every((id) => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id))
    || (payload.draftToken !== undefined && typeof payload.draftToken !== "string")
    || (payload.inspectStorage !== undefined && (payload.inspectStorage !== true || payload.ids.length !== 1 || payload.draftToken !== undefined))) {
    return Response.json({ error: "Invalid attachment recovery request." }, { status: 400 });
  }
  try {
    await ensureTodoDatabase();
    return Response.json({ ...await inspectAttachmentRecovery(payload.todoId!, payload.ids, payload.draftToken), imageProcessingAvailable: imageProcessingAvailable(),
      ...(payload.inspectStorage ? { storage: await inspectTaskUploadStorage(payload.todoId!, payload.ids[0]) } : {}) }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json({ error: "Attachment recovery is temporarily unavailable." }, { status: 503 });
  }
}
