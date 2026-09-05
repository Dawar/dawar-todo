import { claimDraftAttachments } from "../../../../../../db/attachments";
import { ensureTodoDatabase, getTodo } from "../../../../../../db/todos";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const id = Number((await context.params).id);
  if (!Number.isInteger(id) || id < 1) return Response.json({ error: "Invalid task." }, { status: 400 });
  try {
    await ensureTodoDatabase();
    if (!await getTodo(id)) return Response.json({ error: "Task not found." }, { status: 404 });
    const payload = await request.json() as { draftToken?: string; attachmentIds?: string[] };
    if (!Array.isArray(payload.attachmentIds) || !payload.attachmentIds.every((value) => typeof value === "string")) return Response.json({ error: "Invalid attachments." }, { status: 400 });
    await claimDraftAttachments(id, payload.draftToken, payload.attachmentIds);
    return Response.json({ todo: await getTodo(id) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Attachments could not be linked." }, { status: 400 }); }
}
