import { env } from "cloudflare:workers";
import { botsOwner, signBotTicket } from "../../../../lib/bots-auth";
import { getTodoSettings } from "../../../../db/todos";

export async function POST(request: Request) {
  const environment = env as Cloudflare.Env;
  try {
    const owner = botsOwner(request, environment);
    if (!environment.BOTS_RELAY_URL || !environment.BOTS_TICKET_SECRET)
      return Response.json(
        { error: "Bots are waiting for the VM relay to be configured." },
        { status: 503 },
      );
    const payload = (await request.json().catch(() => ({}))) as {
      push?: { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    };
    // Claim only a subscription whose private browser keys match the stored subscription.
    if (
      payload.push?.endpoint &&
      payload.push.keys?.p256dh &&
      payload.push.keys.auth
    ) {
      await environment.DB.prepare(
        `INSERT INTO todo_bot_push_owners (subscription_id, owner_key)
        SELECT id, ? FROM todo_push_subscriptions WHERE endpoint=? AND p256dh=? AND auth=? AND disabled_at IS NULL
        ON CONFLICT(subscription_id) DO UPDATE SET owner_key=excluded.owner_key`,
      )
        .bind(
          owner,
          payload.push.endpoint,
          payload.push.keys.p256dh,
          payload.push.keys.auth,
        )
        .run();
    }
    const current = Math.floor(Date.now() / 1000);
    const machineId = environment.BOTS_MACHINE_ID ?? "dawar-vm";
    const ticket = await signBotTicket(
      {
        role: "browser",
        owner,
        machineId,
        jti: crypto.randomUUID(),
        exp: current + 60,
        sessionExp: current + 900,
      },
      environment.BOTS_TICKET_SECRET,
    );
    const settings = await getTodoSettings();
    return Response.json(
      {
        ticket,
        url: environment.BOTS_RELAY_URL,
        machineId,
        timeZone: settings.snoozeTimeZone,
        owner,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Bots could not connect.";
    return Response.json(
      { error: message },
      {
        status: /owner|origin|signed-in/.test(message) ? 403 : 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
