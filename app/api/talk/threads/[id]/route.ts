import { deleteTalkThread, readTalkThread, updateTalkThread } from "../../../../../db/talk";
import { noStoreHeaders, talkErrorResponse, talkUserKey } from "../../../../../lib/talk-http";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    const userKey = talkUserKey(request);
    const { id } = await context.params;
    return Response.json({ thread: await readTalkThread(userKey, id) }, { headers: noStoreHeaders });
  } catch (error) {
    return talkErrorResponse(error, "The Talk conversation could not be loaded.");
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  const startedAt = Date.now();
  try {
    const userKey = talkUserKey(request);
    const { id } = await context.params;
    const payload = await request.json() as {
      title?: unknown;
      focusedTodoId?: unknown;
      draftText?: unknown;
    };
    const focusedTodoId = payload.focusedTodoId === undefined
      ? undefined
      : payload.focusedTodoId === null
        ? null
        : Number(payload.focusedTodoId);
    if (focusedTodoId !== undefined && focusedTodoId !== null && (!Number.isInteger(focusedTodoId) || focusedTodoId < 1)) {
      return Response.json({ error: "Invalid focused task." }, { status: 400, headers: noStoreHeaders });
    }
    if (payload.title !== undefined && typeof payload.title !== "string") {
      return Response.json({ error: "Invalid conversation title." }, { status: 400, headers: noStoreHeaders });
    }
    if (payload.draftText !== undefined && typeof payload.draftText !== "string") {
      return Response.json({ error: "Invalid conversation draft." }, { status: 400, headers: noStoreHeaders });
    }
    const thread = await updateTalkThread(userKey, id, {
      title: payload.title as string | undefined,
      focusedTodoId,
      draftText: payload.draftText as string | undefined,
    });
    console.info("[todo-talk-api] thread state updated", {
      userKey,
      threadId: id,
      durationMs: Date.now() - startedAt,
    });
    return Response.json({ thread }, { headers: noStoreHeaders });
  } catch (error) {
    return talkErrorResponse(error, "The Talk conversation could not be updated.");
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const userKey = talkUserKey(request);
    const { id } = await context.params;
    return Response.json(await deleteTalkThread(userKey, id), { headers: noStoreHeaders });
  } catch (error) {
    return talkErrorResponse(error, "The Talk conversation could not be deleted.");
  }
}
