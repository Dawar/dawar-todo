import { authenticateTalkPhoneBridge } from "../db/talk-phone";

export function talkPhoneBridgeToken(request: Request) {
  const match = request.headers.get("Authorization")?.match(/^\s*Bearer\s+(\S+)\s*$/i);
  return match?.[1] ?? "";
}

export async function authenticatePhoneBridgeRequest(
  request: Request,
  callSid: string,
) {
  const rawToken = talkPhoneBridgeToken(request);
  if (!rawToken) return null;
  return authenticateTalkPhoneBridge({ callSid, rawToken });
}

export function phoneBridgeError(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback;
  const status = /replaced or ended/i.test(message)
    ? 409
    : /invalid|expired|not found|rejected|unsupported|required|unauthorized/i.test(message)
      ? 403
      : /not configured|unavailable/i.test(message)
        ? 503
        : 500;
  return Response.json(
    { error: message || fallback },
    {
      status,
      headers: {
        "Cache-Control": "no-store, max-age=0",
        Pragma: "no-cache",
      },
    },
  );
}

export const phoneBridgeHeaders = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
};
