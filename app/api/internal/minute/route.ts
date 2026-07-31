import { env } from "cloudflare:workers";
import { runTodoMinuteMaintenance } from "../../../../db/minute-maintenance";

async function secretMatches(received: string, expected: string) {
  const encoder = new TextEncoder();
  const [receivedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(received)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(receivedHash);
  const right = new Uint8Array(expectedHash);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

export async function POST(request: Request) {
  const environment = env as Cloudflare.Env & {
    TODO_MAINTENANCE_SECRET?: string;
  };
  const expected = environment.TODO_MAINTENANCE_SECRET?.trim() ?? "";
  const authorization = request.headers.get("Authorization")?.trim() ?? "";
  const received = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!expected || !received || !(await secretMatches(received, expected))) {
    console.warn("[todo-maintenance] external minute request rejected", {
      configured: Boolean(expected),
      authorizationPresent: Boolean(received),
    });
    return Response.json({ error: "Unauthorized." }, {
      status: 401,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const payload = await request.json().catch(() => ({})) as { scheduledAt?: unknown };
  const requestedAt = typeof payload.scheduledAt === "string" ? new Date(payload.scheduledAt) : new Date();
  const scheduledAt = Number.isNaN(requestedAt.valueOf()) ? new Date() : requestedAt;
  const result = await runTodoMinuteMaintenance(environment, scheduledAt, "external-worker-cron");
  return Response.json({
    ok: true,
    scheduledAt: scheduledAt.toISOString(),
    snoozedWoken: result.snoozedWoken,
    push: result.push,
  }, {
    headers: { "Cache-Control": "no-store" },
  });
}
