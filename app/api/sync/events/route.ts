import { env } from "cloudflare:workers";
import { syncEventsResponse } from "../../../../worker/sync-events";

// The Worker entrypoint already exposes this authenticated read-only stream.
// Next's portable server needs the same route; its gateway/proxy still owns
// authentication. Reuse the bounded stream and durable revision source.
export const dynamic = "force-dynamic";
export function GET(request: Request) {
  return syncEventsResponse(request, env.DB);
}
