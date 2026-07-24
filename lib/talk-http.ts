import { assistantUserKey } from "../db/assistant";

export function talkUserKey(request: Request) {
  if (/^\s*Bearer\s+/i.test(request.headers.get("Authorization") ?? "")) {
    throw new Error("TALK_BEARER_REJECTED");
  }
  return assistantUserKey(request);
}

export function talkErrorResponse(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback;
  if (message === "TALK_BEARER_REJECTED") {
    return Response.json(
      { error: "Talk is available only in the signed-in Dawar Todo interface." },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }
  const status = /replaced or ended/i.test(message)
    ? 409
    : /not configured|unavailable/i.test(message)
      ? 503
      : /invalid|not found|choose|required|limited|future|prepared|available|cannot|failed \(\d+\)/i.test(message)
        ? 400
        : 500;
  return Response.json(
    { error: message || fallback },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export const noStoreHeaders = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
};
