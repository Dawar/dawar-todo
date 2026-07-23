import { getTodoCaptureDraft, updateTodoCaptureDraft } from "../../../db/todos";

export async function GET() {
  const startedAt = Date.now();
  try {
    const captureDraft = await getTodoCaptureDraft();
    console.info("[todo-sync] capture draft served", {
      textLength: captureDraft?.text.length ?? 0,
      version: captureDraft?.version ?? null,
      durationMs: Date.now() - startedAt,
    });
    return Response.json({ captureDraft }, {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    console.error("[todo-sync] capture draft load failed", { durationMs: Date.now() - startedAt, error });
    return Response.json({ error: "Your Quick Add draft could not be loaded." }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  const startedAt = Date.now();
  try {
    const payload = (await request.json()) as {
      text?: unknown;
      updatedAt?: unknown;
      clientId?: unknown;
    };
    if (typeof payload.text !== "string") {
      return Response.json({ error: "Quick Add draft text is required." }, { status: 400 });
    }
    if (typeof payload.clientId !== "string") {
      return Response.json({ error: "A capture draft client identifier is required." }, { status: 400 });
    }
    const result = await updateTodoCaptureDraft({
      text: payload.text,
      updatedAt: typeof payload.updatedAt === "string" ? payload.updatedAt : undefined,
      clientId: payload.clientId,
    });
    console.info("[todo-sync] capture draft mutation handled", {
      applied: result.applied,
      requestedTextLength: payload.text.length,
      returnedTextLength: result.captureDraft.text.length,
      version: result.captureDraft.version,
      durationMs: Date.now() - startedAt,
    });
    return Response.json(result, {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Your Quick Add draft could not be saved.";
    const inputError = /required|identifier|timestamp|future|limited/i.test(message);
    console.error("[todo-sync] capture draft mutation failed", { durationMs: Date.now() - startedAt, error });
    return Response.json({ error: message }, { status: inputError ? 400 : 500 });
  }
}
