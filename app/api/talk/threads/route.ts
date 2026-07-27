import { createTalkThread, listTalkThreads, restoreTalkThread } from "../../../../db/talk";
import { listTodos } from "../../../../db/todos";
import { noStoreHeaders, talkErrorResponse, talkUserKey } from "../../../../lib/talk-http";

export async function GET(request: Request) {
  const startedAt = Date.now();
  try {
    const userKey = talkUserKey(request);
    const [threads, todos] = await Promise.all([listTalkThreads(userKey), listTodos()]);
    console.info("[todo-talk-api] threaded workspace loaded", {
      userKey,
      threadCount: threads.length,
      taskCount: todos.length,
      durationMs: Date.now() - startedAt,
    });
    return Response.json({ threads, todos }, { headers: noStoreHeaders });
  } catch (error) {
    return talkErrorResponse(error, "Talk conversations could not be loaded.");
  }
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  try {
    const userKey = talkUserKey(request);
    const payload = await request.json().catch(() => ({})) as {
      title?: unknown;
      restoreToken?: unknown;
    };
    const thread = payload.restoreToken
      ? await restoreTalkThread(userKey, String(payload.restoreToken))
      : await createTalkThread(userKey, String(payload.title ?? "New conversation"));
    console.info("[todo-talk-api] thread mutation completed", {
      userKey,
      threadId: thread.id,
      restored: Boolean(payload.restoreToken),
      durationMs: Date.now() - startedAt,
    });
    return Response.json({ thread }, { status: payload.restoreToken ? 200 : 201, headers: noStoreHeaders });
  } catch (error) {
    return talkErrorResponse(error, "The Talk conversation could not be created.");
  }
}
