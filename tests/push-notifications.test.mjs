import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import webPush from "web-push";

const root = new URL("../", import.meta.url);

test("wires device push subscriptions, minute batching, origin suppression, and scheduled snooze wakeups", async () => {
  const [
    schema,
    database,
    pushDatabase,
    pushRoute,
    todoRoute,
    pwaRegistration,
    worker,
    recurring,
    settings,
    page,
    access,
    migration,
    deliveryMigration,
    healthMigration,
    environment,
    minuteMaintenance,
    internalMinuteRoute,
    pushClient,
    voiceRelay,
    voiceRelayConfig,
  ] = await Promise.all([
    readFile(new URL("db/schema.ts", root), "utf8"),
    readFile(new URL("db/todos.ts", root), "utf8"),
    readFile(new URL("db/push-notifications.ts", root), "utf8"),
    readFile(new URL("app/api/push/route.ts", root), "utf8"),
    readFile(new URL("app/api/todos/route.ts", root), "utf8"),
    readFile(new URL("app/pwa-register.tsx", root), "utf8"),
    readFile(new URL("worker/index.ts", root), "utf8"),
    readFile(new URL("worker/recurring.ts", root), "utf8"),
    readFile(new URL("app/settings/page.tsx", root), "utf8"),
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("worker/access.ts", root), "utf8"),
    readFile(new URL("drizzle/0020_acoustic_bushwacker.sql", root), "utf8"),
    readFile(new URL("drizzle/0024_white_shooting_star.sql", root), "utf8"),
    readFile(new URL("drizzle/0027_charming_preak.sql", root), "utf8"),
    readFile(new URL(".env.example", root), "utf8"),
    readFile(new URL("db/minute-maintenance.ts", root), "utf8"),
    readFile(new URL("app/api/internal/minute/route.ts", root), "utf8"),
    readFile(new URL("app/push-client.ts", root), "utf8"),
    readFile(new URL("voice-relay/src/index.ts", root), "utf8"),
    readFile(new URL("voice-relay/wrangler.jsonc", root), "utf8"),
  ]);

  assert.match(schema, /todoPushSubscriptions/);
  assert.match(schema, /todoPushEvents/);
  assert.match(schema, /todoPushDeliveries/);
  assert.match(migration, /CREATE TABLE `todo_push_subscriptions`/);
  assert.match(migration, /CREATE TABLE `todo_push_events`/);
  assert.match(deliveryMigration, /CREATE TABLE `todo_push_deliveries`/);
  assert.match(healthMigration, /ADD `last_failure_status` integer/);
  assert.match(healthMigration, /ADD `last_failure_at` text/);
  assert.match(database, /CURRENT_SCHEMA_VERSION = "27"/);
  assert.match(database, /CREATE TABLE IF NOT EXISTS todo_push_deliveries/);
  assert.match(database, /wakeExpiredSnoozedTodosInDatabase/);
  assert.match(database, /'snooze:' \|\| id \|\| ':' \|\| snoozed_until/);
  assert.match(database, /queueTodoPushEvent\(db, \{[\s\S]*type: "task_created"/);
  assert.match(database, /originDeviceId: input\.originDeviceId/);
  assert.match(pushDatabase, /Math\.ceil\(time \/ 60_000\) \* 60_000/);
  assert.match(pushDatabase, /type === "snooze_expired" \? isoMinuteCeiling\(createdAt\) : createdAt\.toISOString\(\)/);
  assert.match(pushDatabase, /event\.event_type === "task_created"[\s\S]*event\.origin_device_id === subscription\.device_id/);
  assert.match(pushDatabase, /INSERT OR IGNORE INTO todo_push_deliveries/);
  assert.match(pushDatabase, /pendingRetryEvents: events\.length - completedEventIds\.length/);
  assert.match(pushDatabase, /`\$\{events\.length\} tasks are ready`/);
  assert.match(pushDatabase, /generateRequestDetails/);
  assert.match(pushDatabase, /contentEncoding: "aes128gcm"/);
  assert.match(pushDatabase, /status === 404 \|\| status === 410/);
  assert.match(pushDatabase, /INVALID_SUBSCRIPTION_REASONS/);
  assert.match(pushDatabase, /isApplePushEndpoint/);
  assert.match(pushDatabase, /if \(!appleEndpoint\)/);
  assert.match(pushDatabase, /readPushProviderReason/);
  assert.match(pushDatabase, /TTL: 86_400/);
  assert.match(pushDatabase, /subscriptions\.length \? events\.filter/);
  assert.match(pushDatabase, /push_dispatch_lease/);
  assert.match(pushDatabase, /sendTestPushNotification/);
  assert.match(pushRoute, /export async function GET/);
  assert.match(pushRoute, /export async function POST/);
  assert.match(pushRoute, /export async function DELETE/);
  assert.match(todoRoute, /request\.headers\.get\("X-Dawar-Device-Id"\)/);
  assert.match(todoRoute, /waitUntil\(dispatchTodoPushNotifications/);
  assert.match(page, /headersWithDeviceId/);
  assert.match(pwaRegistration, /refreshExistingPushSubscription/);
  assert.match(pwaRegistration, /active device subscription refreshed on app launch/);
  assert.match(pwaRegistration, /ensureCurrentPushSubscription/);
  assert.match(pushClient, /pushSubscriptionUsesKey/);
  assert.match(pushClient, /applicationServerKey/);
  assert.match(worker, /runTodoMinuteMaintenance/);
  assert.match(recurring, /type: "recurrence_reopened"/);
  assert.match(settings, /Push notifications/);
  assert.match(settings, /ensureCurrentPushSubscription/);
  assert.match(settings, /Enable notifications/);
  assert.match(settings, /Disable notifications/);
  assert.match(access, /url\.pathname\.startsWith\("\/api\/push"\)/);
  assert.match(access, /pathname === "\/api\/internal\/minute"/);
  assert.match(minuteMaintenance, /dispatchTodoPushNotifications/);
  assert.match(internalMinuteRoute, /TODO_MAINTENANCE_SECRET/);
  assert.match(internalMinuteRoute, /runTodoMinuteMaintenance/);
  assert.match(voiceRelayConfig, /"crons": \["\* \* \* \* \*"\]/);
  assert.match(voiceRelay, /\/api\/internal\/minute/);
  assert.match(voiceRelay, /TODO_MAINTENANCE_SECRET/);
  assert.match(environment, /VAPID_SUBJECT=https:\/\/work\.dawar\.ca/);
  assert.match(environment, /VAPID_PUBLIC_KEY=/);
  assert.match(environment, /VAPID_PRIVATE_KEY=/);
  assert.match(environment, /TODO_MAINTENANCE_SECRET=/);
});

test("service worker displays push alerts, updates the app badge, and reopens the app", async () => {
  const workerSource = await readFile(new URL("public/sw.js", root), "utf8");
  const listeners = new Map();
  const notifications = [];
  const focused = [];
  const badges = [];
  let pushPromise;
  let clickPromise;
  const existingClient = {
    url: "https://push.test/settings",
    navigate: async (url) => { focused.push(["navigate", url]); },
    focus: async () => { focused.push(["focus"]); },
  };
  const self = {
    location: { origin: "https://push.test" },
    registration: {
      showNotification: async (title, options) => notifications.push({ title, options }),
    },
    navigator: {
      setAppBadge: async (count) => badges.push(count),
      clearAppBadge: async () => badges.push(0),
    },
    clients: {
      claim: async () => undefined,
      matchAll: async () => [existingClient],
      openWindow: async (url) => focused.push(["open", url]),
    },
    skipWaiting: async () => undefined,
    addEventListener: (name, handler) => listeners.set(name, handler),
  };

  vm.runInNewContext(workerSource, {
    self,
    caches: {
      open: async () => ({ put: async () => undefined, match: async () => undefined }),
      keys: async () => [],
      delete: async () => true,
      match: async () => undefined,
    },
    fetch: async () => new Response(""),
    Request,
    Response,
    URL,
    Set,
    Promise,
    Error,
    Number,
    console,
  });

  listeners.get("push")({
    data: {
      json: () => ({
        title: "2 tasks are ready",
        body: "First · Second",
        tag: "dawar-todo-open-items",
        url: "/",
        openCount: 7,
      }),
    },
    waitUntil: (promise) => { pushPromise = promise; },
  });
  await pushPromise;
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].title, "2 tasks are ready");
  assert.equal(notifications[0].options.body, "First · Second");
  assert.equal(notifications[0].options.renotify, true);
  assert.deepEqual(badges, [7]);

  const notification = {
    data: { url: "/" },
    close: () => focused.push(["close"]),
  };
  listeners.get("notificationclick")({
    notification,
    waitUntil: (promise) => { clickPromise = promise; },
  });
  await clickPromise;
  assert.deepEqual(focused, [
    ["close"],
    ["navigate", "https://push.test/"],
    ["focus"],
  ]);
});

test("builds a standards-current encrypted Web Push request", () => {
  const vapid = webPush.generateVAPIDKeys();
  const subscriber = createECDH("prime256v1");
  subscriber.generateKeys();
  const request = webPush.generateRequestDetails({
    endpoint: "https://push.example.test/subscription",
    keys: {
      p256dh: subscriber.getPublicKey().toString("base64url"),
      auth: randomBytes(16).toString("base64url"),
    },
  }, JSON.stringify({ title: "Task is ready", body: "Example" }), {
    TTL: 300,
    contentEncoding: "aes128gcm",
    vapidDetails: {
      subject: "https://work.dawar.ca",
      publicKey: vapid.publicKey,
      privateKey: vapid.privateKey,
    },
  });

  assert.equal(request.method, "POST");
  assert.equal(request.headers["Content-Encoding"], "aes128gcm");
  assert.ok(request.headers.Authorization.startsWith("vapid t="));
  assert.ok(request.body.length > 0);
});
