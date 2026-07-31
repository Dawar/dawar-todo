import { env } from "cloudflare:workers";
import { ensureTodoDatabase } from "../../../db/todos";
import {
  hasPushSubscription,
  readPushSubscriptionState,
  removePushSubscription,
  sendTestPushNotification,
  upsertPushSubscription,
  type PushSubscriptionInput,
} from "../../../db/push-notifications";

function pushEnvironment() {
  return env as Cloudflare.Env & {
    VAPID_SUBJECT?: string;
    VAPID_PUBLIC_KEY?: string;
    VAPID_PRIVATE_KEY?: string;
  };
}

export async function GET(request: Request) {
  try {
    await ensureTodoDatabase();
    const environment = pushEnvironment();
    const deviceId = request.headers.get("X-Dawar-Device-Id")?.trim() ?? "";
    const configured = Boolean(environment.VAPID_SUBJECT && environment.VAPID_PUBLIC_KEY && environment.VAPID_PRIVATE_KEY);
    const subscribed = deviceId ? await hasPushSubscription(environment.DB, deviceId) : false;
    const subscription = deviceId ? await readPushSubscriptionState(environment.DB, deviceId) : null;
    return Response.json({
      configured,
      publicKey: configured ? environment.VAPID_PUBLIC_KEY : null,
      subscribed,
      subscription,
    }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (error) {
    console.error("[todo-push] subscription state failed", error);
    return Response.json({ error: "Push notification settings could not be loaded." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    await ensureTodoDatabase();
    const environment = pushEnvironment();
    if (!environment.VAPID_PUBLIC_KEY || !environment.VAPID_PRIVATE_KEY || !environment.VAPID_SUBJECT) {
      return Response.json({ error: "Push notifications are not configured yet." }, { status: 503 });
    }
    const payload = await request.json() as Omit<PushSubscriptionInput, "deviceId"> & { deviceId?: string };
    const deviceId = request.headers.get("X-Dawar-Device-Id")?.trim() || payload.deviceId?.trim() || "";
    await upsertPushSubscription(environment.DB, { ...payload, deviceId });
    return Response.json({ subscribed: true }, { status: 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Push notifications could not be enabled.";
    console.error("[todo-push] subscription registration failed", {
      error: message,
    });
    return Response.json({ error: message }, { status: /invalid|require|missing|public|long|secure/i.test(message) ? 400 : 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    await ensureTodoDatabase();
    const payload = await request.json().catch(() => ({})) as { endpoint?: string | null; deviceId?: string | null };
    const deviceId = request.headers.get("X-Dawar-Device-Id")?.trim() || payload.deviceId?.trim() || "";
    await removePushSubscription(pushEnvironment().DB, { endpoint: payload.endpoint, deviceId });
    return Response.json({ subscribed: false }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Push notifications could not be disabled.";
    console.error("[todo-push] subscription removal failed", { error: message });
    return Response.json({ error: message }, { status: /invalid|require|public|secure/i.test(message) ? 400 : 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    await ensureTodoDatabase();
    const deviceId = request.headers.get("X-Dawar-Device-Id")?.trim() ?? "";
    const result = await sendTestPushNotification(pushEnvironment().DB, pushEnvironment(), deviceId);
    return Response.json(result, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The test notification could not be sent.";
    return Response.json({ error: message }, {
      status: /valid|active|configured|re-enable/i.test(message) ? 400 : 502,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
}
