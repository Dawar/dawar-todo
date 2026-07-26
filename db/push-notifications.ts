import webPush, { type PushSubscription, type RequestOptions } from "web-push";

export type TodoPushEventType = "task_created" | "snooze_expired" | "recurrence_reopened";

type TodoPushEventRow = {
  id: string;
  event_type: TodoPushEventType;
  todo_id: number;
  todo_title: string;
  origin_device_id: string | null;
  created_at: string;
  deliver_after: string;
};

type TodoPushSubscriptionRow = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  device_id: string;
  failure_count: number;
};

export type PushEnvironment = {
  VAPID_SUBJECT?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
};

export type PushSubscriptionInput = {
  endpoint: string;
  expirationTime?: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
  deviceId: string;
};

const DEVICE_ID_PATTERN = /^[0-9a-f-]{36}$/i;
const MAX_BATCH_EVENTS = 90;
const generatePushRequest = webPush.generateRequestDetails as unknown as (
  subscription: PushSubscription,
  payload: string,
  options: RequestOptions,
) => {
  endpoint: string;
  method: "POST";
  headers: Record<string, string>;
  body: Uint8Array;
};

function isoMinuteCeiling(date: Date) {
  const time = date.valueOf();
  return new Date(Math.ceil(time / 60_000) * 60_000).toISOString();
}

function eventDeliveryTime(type: TodoPushEventType, createdAt: Date) {
  return type === "snooze_expired" ? isoMinuteCeiling(createdAt) : createdAt.toISOString();
}

function deliveryKey(eventId: string, subscriptionId: string) {
  return `${eventId}:${subscriptionId}`;
}

function suppressesOriginDevice(event: TodoPushEventRow, subscription: TodoPushSubscriptionRow) {
  return event.event_type === "task_created"
    && Boolean(event.origin_device_id)
    && event.origin_device_id === subscription.device_id;
}

function normalizedPushEndpoint(value: string) {
  const endpoint = new URL(value);
  if (endpoint.protocol !== "https:") throw new Error("Push subscriptions require a secure HTTPS endpoint.");
  if (endpoint.username || endpoint.password) throw new Error("That push subscription endpoint is invalid.");
  const hostname = endpoint.hostname.toLowerCase();
  if (
    hostname === "localhost"
    || hostname === "::1"
    || /^127\./.test(hostname)
    || /^10\./.test(hostname)
    || /^192\.168\./.test(hostname)
    || /^169\.254\./.test(hostname)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  ) throw new Error("That push subscription endpoint is not public.");
  if (endpoint.href.length > 2_048) throw new Error("That push subscription endpoint is too long.");
  return endpoint.href;
}

function validateSubscription(input: PushSubscriptionInput) {
  const endpoint = normalizedPushEndpoint(input.endpoint);
  const deviceId = input.deviceId?.trim() ?? "";
  const p256dh = input.keys?.p256dh?.trim() ?? "";
  const auth = input.keys?.auth?.trim() ?? "";
  if (!DEVICE_ID_PATTERN.test(deviceId)) throw new Error("That device identifier is invalid.");
  if (!p256dh || p256dh.length > 512 || !auth || auth.length > 256) {
    throw new Error("That push subscription is missing valid encryption keys.");
  }
  return { endpoint, deviceId, p256dh, auth };
}

export async function upsertPushSubscription(db: D1Database, input: PushSubscriptionInput) {
  const normalized = validateSubscription(input);
  const id = crypto.randomUUID();
  await db.prepare(`
    INSERT INTO todo_push_subscriptions (
      id, endpoint, p256dh, auth, device_id, failure_count, disabled_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(endpoint) DO UPDATE SET
      p256dh = excluded.p256dh,
      auth = excluded.auth,
      device_id = excluded.device_id,
      failure_count = 0,
      disabled_at = NULL,
      updated_at = excluded.updated_at
  `).bind(id, normalized.endpoint, normalized.p256dh, normalized.auth, normalized.deviceId).run();
  console.info("[todo-push] device subscription registered", {
    deviceIdSuffix: normalized.deviceId.slice(-6),
    endpointOrigin: new URL(normalized.endpoint).origin,
  });
  return { id, deviceId: normalized.deviceId };
}

export async function removePushSubscription(
  db: D1Database,
  input: { endpoint?: string | null; deviceId?: string | null },
) {
  const deviceId = input.deviceId?.trim() ?? "";
  const endpoint = input.endpoint ? normalizedPushEndpoint(input.endpoint) : "";
  if (!endpoint && !DEVICE_ID_PATTERN.test(deviceId)) throw new Error("A valid device subscription is required.");
  const result = endpoint
    ? await db.prepare("DELETE FROM todo_push_subscriptions WHERE endpoint = ?").bind(endpoint).run()
    : await db.prepare("DELETE FROM todo_push_subscriptions WHERE device_id = ?").bind(deviceId).run();
  console.info("[todo-push] device subscription removed", {
    deviceIdSuffix: DEVICE_ID_PATTERN.test(deviceId) ? deviceId.slice(-6) : null,
    removed: Number(result.meta.changes ?? 0),
  });
  return Number(result.meta.changes ?? 0);
}

export async function hasPushSubscription(db: D1Database, deviceId: string) {
  if (!DEVICE_ID_PATTERN.test(deviceId)) return false;
  const row = await db.prepare(`
    SELECT 1 AS subscribed
    FROM todo_push_subscriptions
    WHERE device_id = ? AND disabled_at IS NULL
    LIMIT 1
  `).bind(deviceId).first<{ subscribed: number }>();
  return Boolean(row?.subscribed);
}

export async function queueTodoPushEvent(
  db: D1Database,
  event: {
    type: TodoPushEventType;
    todoId: number;
    title: string;
    originDeviceId?: string | null;
    eventId?: string;
    createdAt?: Date;
  },
) {
  const createdAt = event.createdAt ?? new Date();
  const originDeviceId = event.originDeviceId && DEVICE_ID_PATTERN.test(event.originDeviceId)
    ? event.originDeviceId
    : null;
  const deliverAfter = eventDeliveryTime(event.type, createdAt);
  const result = await db.prepare(`
    INSERT OR IGNORE INTO todo_push_events (
      id, event_type, todo_id, todo_title, origin_device_id, created_at, deliver_after
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    event.eventId ?? crypto.randomUUID(),
    event.type,
    event.todoId,
    event.title.slice(0, 2_000),
    originDeviceId,
    createdAt.toISOString(),
    deliverAfter,
  ).run();
  console.info("[todo-push] task event queued", {
    type: event.type,
    todoId: event.todoId,
    originSuppressionAvailable: Boolean(originDeviceId),
    queued: Number(result.meta.changes ?? 0),
    deliverAfter,
  });
  return Number(result.meta.changes ?? 0) > 0;
}

async function recordSuccessfulDeliveries(
  db: D1Database,
  subscriptionId: string,
  events: TodoPushEventRow[],
) {
  if (!events.length) return;
  await db.batch(events.map((event) => db.prepare(`
    INSERT OR IGNORE INTO todo_push_deliveries (event_id, subscription_id)
    VALUES (?, ?)
  `).bind(event.id, subscriptionId)));
}

function notificationPayload(events: TodoPushEventRow[], openCount: number) {
  const single = events.length === 1 ? events[0] : null;
  const title = single
    ? single.event_type === "task_created"
      ? "New open task"
      : single.event_type === "recurrence_reopened"
        ? "Recurring task is ready"
        : "Task is ready"
    : `${events.length} tasks are ready`;
  const previewTitles = events.slice(0, 3).map((event) => event.todo_title.replace(/\s+/g, " ").trim().slice(0, 90));
  const remainder = Math.max(0, events.length - previewTitles.length);
  const body = `${previewTitles.join(" · ")}${remainder ? ` · +${remainder} more` : ""}`.slice(0, 360);
  return {
    title,
    body,
    tag: "dawar-todo-open-items",
    url: "/",
    openCount,
  };
}

async function markSubscriptionDelivery(
  db: D1Database,
  subscription: TodoPushSubscriptionRow,
  response: Response | null,
) {
  if (response?.ok) {
    await db.prepare(`
      UPDATE todo_push_subscriptions
      SET failure_count = 0,
          last_success_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?
    `).bind(subscription.id).run();
    return "sent" as const;
  }
  const expired = response?.status === 404 || response?.status === 410;
  await db.prepare(`
    UPDATE todo_push_subscriptions
    SET failure_count = failure_count + 1,
        disabled_at = CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE disabled_at END,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ?
  `).bind(expired ? 1 : 0, subscription.id).run();
  return expired ? "expired" as const : "failed" as const;
}

export async function dispatchTodoPushNotifications(
  db: D1Database,
  environment: PushEnvironment,
  now = new Date(),
) {
  const startedAt = Date.now();
  const vapidSubject = environment.VAPID_SUBJECT?.trim();
  const vapidPublicKey = environment.VAPID_PUBLIC_KEY?.trim();
  const vapidPrivateKey = environment.VAPID_PRIVATE_KEY?.trim();
  if (!vapidSubject || !vapidPublicKey || !vapidPrivateKey) {
    console.warn("[todo-push] delivery skipped because VAPID is not configured");
    return { events: 0, subscriptions: 0, sent: 0, suppressed: 0, failed: 0, skipped: true };
  }
  const [eventResult, subscriptionResult, openCountRow] = await db.batch([
    db.prepare(`
      SELECT id, event_type, todo_id, todo_title, origin_device_id, created_at, deliver_after
      FROM todo_push_events
      WHERE delivered_at IS NULL AND deliver_after <= ?
      ORDER BY deliver_after, created_at
      LIMIT ?
    `).bind(now.toISOString(), MAX_BATCH_EVENTS),
    db.prepare(`
      SELECT id, endpoint, p256dh, auth, device_id, failure_count
      FROM todo_push_subscriptions
      WHERE disabled_at IS NULL
      ORDER BY created_at
    `),
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM todos
      WHERE status = 'open' AND (snoozed_until IS NULL OR snoozed_until <= ?)
    `).bind(now.toISOString()),
  ]) as [
    D1Result<TodoPushEventRow>,
    D1Result<TodoPushSubscriptionRow>,
    D1Result<{ count: number }>,
  ];
  const events = eventResult.results;
  const subscriptions = subscriptionResult.results;
  if (!events.length) return { events: 0, subscriptions: subscriptions.length, sent: 0, suppressed: 0, failed: 0, skipped: false };
  const placeholders = events.map(() => "?").join(",");
  const priorDeliveryResult = await db.prepare(`
    SELECT event_id, subscription_id
    FROM todo_push_deliveries
    WHERE event_id IN (${placeholders})
  `).bind(...events.map((event) => event.id)).all<{ event_id: string; subscription_id: string }>();
  const settledDeliveries = new Set(
    priorDeliveryResult.results.map((delivery) => deliveryKey(delivery.event_id, delivery.subscription_id)),
  );

  console.info("[todo-push] due batch delivery started", {
    events: events.length,
    subscriptions: subscriptions.length,
    priorDeliveries: settledDeliveries.size,
    oldestEventAt: events[0]?.created_at,
  });
  let sent = 0;
  let suppressed = 0;
  let failed = 0;
  let expired = 0;
  const expiredSubscriptionIds = new Set<string>();
  for (const subscription of subscriptions) {
    const eligibleEvents = events.filter((event) => (
      !suppressesOriginDevice(event, subscription)
      && !settledDeliveries.has(deliveryKey(event.id, subscription.id))
    ));
    if (!eligibleEvents.length) {
      suppressed += events.some((event) => suppressesOriginDevice(event, subscription)) ? 1 : 0;
      continue;
    }
    const pushSubscription: PushSubscription = {
      endpoint: subscription.endpoint,
      expirationTime: null,
      keys: { p256dh: subscription.p256dh, auth: subscription.auth },
    };
    let response: Response | null = null;
    try {
      const payload = JSON.stringify(notificationPayload(
        eligibleEvents,
        Number(openCountRow.results[0]?.count ?? 0),
      ));
      const request = generatePushRequest(pushSubscription, payload, {
        TTL: 300,
        urgency: "normal",
        topic: "dawar-todo-open-items",
        contentEncoding: "aes128gcm",
        vapidDetails: {
          subject: vapidSubject,
          publicKey: vapidPublicKey,
          privateKey: vapidPrivateKey,
        },
      });
      const requestBody = new Uint8Array(request.body.byteLength);
      requestBody.set(request.body);
      response = await fetch(request.endpoint, {
        method: request.method,
        headers: request.headers,
        body: requestBody.buffer,
      });
      const outcome = await markSubscriptionDelivery(db, subscription, response);
      if (outcome === "sent") {
        sent += 1;
        await recordSuccessfulDeliveries(db, subscription.id, eligibleEvents);
        for (const event of eligibleEvents) settledDeliveries.add(deliveryKey(event.id, subscription.id));
      } else if (outcome === "expired") {
        expired += 1;
        expiredSubscriptionIds.add(subscription.id);
      }
      else failed += 1;
      console.info("[todo-push] device batch delivery completed", {
        subscriptionId: subscription.id,
        eligibleEvents: eligibleEvents.length,
        status: response.status,
        outcome,
      });
    } catch (error) {
      failed += 1;
      await markSubscriptionDelivery(db, subscription, response);
      console.error("[todo-push] device batch delivery failed", {
        subscriptionId: subscription.id,
        eligibleEvents: eligibleEvents.length,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const completedEventIds = events.filter((event) => subscriptions.every((subscription) => (
    suppressesOriginDevice(event, subscription)
    || expiredSubscriptionIds.has(subscription.id)
    || settledDeliveries.has(deliveryKey(event.id, subscription.id))
  ))).map((event) => event.id);
  if (completedEventIds.length) {
    const completedPlaceholders = completedEventIds.map(() => "?").join(",");
    await db.prepare(`
      UPDATE todo_push_events
      SET delivered_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id IN (${completedPlaceholders})
    `).bind(...completedEventIds).run();
  }
  await db.prepare(`
    DELETE FROM todo_push_events
    WHERE delivered_at IS NOT NULL AND delivered_at < datetime('now', '-7 days')
  `).run();
  await db.prepare(`
    DELETE FROM todo_push_deliveries
    WHERE NOT EXISTS (
      SELECT 1 FROM todo_push_events
      WHERE todo_push_events.id = todo_push_deliveries.event_id
    )
  `).run();
  console.info("[todo-push] due batch delivery finished", {
    events: events.length,
    completedEvents: completedEventIds.length,
    pendingRetryEvents: events.length - completedEventIds.length,
    subscriptions: subscriptions.length,
    sent,
    suppressed,
    failed,
    expired,
    durationMs: Date.now() - startedAt,
  });
  return {
    events: events.length,
    completedEvents: completedEventIds.length,
    pendingRetryEvents: events.length - completedEventIds.length,
    subscriptions: subscriptions.length,
    sent,
    suppressed,
    failed,
    expired,
    skipped: false,
  };
}
