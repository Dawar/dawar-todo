import { env } from "cloudflare:workers";
import { secretMatches } from "../../../../lib/bots-auth";
import { dispatchBotPushNotifications } from "../../../../db/push-notifications";

export async function POST(request: Request) {
  const environment = env as Cloudflare.Env;
  const credential =
    request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (
    !(await secretMatches(
      credential,
      environment.BOTS_NOTIFICATION_SECRET ?? "",
    ))
  )
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!environment.BOTS_OWNER_EMAIL)
    return Response.json(
      { error: "Bots owner is not configured." },
      { status: 503 },
    );
  try {
    const p = (await request.json()) as {
      id?: string;
      botId?: string;
      title?: string;
      body?: string;
    };
    if (
      !/^[a-f0-9]{64}$/.test(p.id ?? "") ||
      !p.botId ||
      p.botId.length > 180 ||
      !p.title ||
      !p.body ||
      p.title.length > 160 ||
      p.body.length > 1000
    )
      return Response.json({ error: "Invalid notification" }, { status: 400 });
    await environment.DB.prepare(
      `INSERT OR IGNORE INTO todo_bot_notifications(id,owner_key,bot_id,title,body,created_at) VALUES(?,?,?,?,?,?)`,
    )
      .bind(
        p.id,
        environment.BOTS_OWNER_EMAIL.toLowerCase(),
        p.botId,
        p.title,
        p.body,
        new Date().toISOString(),
      )
      .run();
    await dispatchBotPushNotifications(environment.DB, environment).catch(
      (error) =>
        console.error("[bots-push] delivery deferred", {
          message: error instanceof Error ? error.message : String(error),
        }),
    );
    return Response.json(
      { accepted: true },
      { status: 202, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[bots-push] enqueue failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { error: "Notification could not be stored." },
      { status: 503 },
    );
  }
}
