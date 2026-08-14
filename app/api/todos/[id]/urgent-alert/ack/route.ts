import { acknowledgeUrgentAlertForTodo } from "../../../../../../db/urgent-alerts";
import { noStoreHeaders, talkErrorResponse, talkUserKey } from "../../../../../../lib/talk-http";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id: idParam } = await context.params;
  const todoId = Number(idParam);
  if (!Number.isInteger(todoId) || todoId < 1) {
    return Response.json({ error: "Invalid task." }, { status: 400, headers: noStoreHeaders });
  }
  try {
    const userKey = talkUserKey(request);
    const result = await acknowledgeUrgentAlertForTodo(todoId, "app", undefined, userKey);
    return Response.json(result, { headers: noStoreHeaders });
  } catch (error) {
    return talkErrorResponse(error, "The urgent alert could not be acknowledged.");
  }
}
