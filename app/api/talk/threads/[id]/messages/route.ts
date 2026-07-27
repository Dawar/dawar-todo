import { listTalkHistory } from "../../../../../../db/talk";
import { noStoreHeaders, talkErrorResponse, talkUserKey } from "../../../../../../lib/talk-http";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    const userKey = talkUserKey(request);
    const { id } = await context.params;
    const url = new URL(request.url);
    const history = await listTalkHistory(userKey, {
      threadId: id,
      before: url.searchParams.get("before"),
      limit: Number(url.searchParams.get("limit") ?? 100),
    });
    return Response.json(history, { headers: noStoreHeaders });
  } catch (error) {
    return talkErrorResponse(error, "Talk messages could not be loaded.");
  }
}
