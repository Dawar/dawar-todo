import { listTalkHistory } from "../../../../db/talk";
import { noStoreHeaders, talkErrorResponse, talkUserKey } from "../../../../lib/talk-http";

export async function GET(request: Request) {
  try {
    const userKey = talkUserKey(request);
    const url = new URL(request.url);
    const history = await listTalkHistory(userKey, {
      before: url.searchParams.get("before"),
      limit: Number(url.searchParams.get("limit") ?? 60),
    });
    return Response.json(history, { headers: noStoreHeaders });
  } catch (error) {
    return talkErrorResponse(error, "Talk history could not be loaded.");
  }
}
