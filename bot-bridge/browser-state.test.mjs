import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { runtime } from "../tests/helpers/load-ts.mjs";
test("native streaming includes output deltas, user echo deduplication and turn plan/diff", () => {
  const { reduceBotTurns } = runtime().load("app/bots/thread-state.ts");
  let turns = [];
  const apply = (method, extra) =>
    (turns = reduceBotTurns(turns, {
      method,
      params: { turnId: "t", ...extra },
    }));
  apply("item/started", {
    item: { id: "cmd", type: "commandExecution", aggregatedOutput: "" },
  });
  apply("item/commandExecution/outputDelta", { itemId: "cmd", delta: "hello" });
  assert.equal(turns[0].items[0].aggregatedOutput, "hello");
  apply("item/completed", {
    item: { id: "client:1", type: "userMessage", clientId: "1" },
  });
  apply("item/completed", {
    item: { id: "native", type: "userMessage", clientId: "1" },
  });
  assert.equal(
    turns[0].items.filter((i) => i.type === "userMessage").length,
    1,
  );
  apply("turn/diff/updated", { diff: "+change" });
  apply("turn/plan/updated", { plan: [{ step: "do", status: "completed" }] });
  assert.equal(turns[0].diff, "+change");
  assert.equal(turns[0].planSteps[0].status, "completed");
});
test("push outbox targets only verified owner devices and deduplicates deliveries", async () => {
  const sql = new DatabaseSync(":memory:");
  sql.exec(readFileSync("drizzle/0030_hard_mockingbird.sql", "utf8"));
  sql.exec(
    `CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT,updated_at TEXT);CREATE TABLE todo_push_subscriptions(id TEXT PRIMARY KEY,endpoint TEXT,p256dh TEXT,auth TEXT,device_id TEXT,failure_count INTEGER DEFAULT 0,last_success_at TEXT,last_failure_status INTEGER,last_failure_at TEXT,disabled_at TEXT,updated_at TEXT);INSERT INTO todo_push_subscriptions(id,endpoint,p256dh,auth,device_id) VALUES('mine','https://push.example/mine','key','auth','one'),('other','https://push.example/other','key','auth','two');INSERT INTO todo_bot_push_owners VALUES('mine','owner'),('other','someone-else');INSERT INTO todo_bot_notifications VALUES('notice','owner','bot','Alert','Act now','2026-09-25T00:00:00Z',NULL);`,
  );
  const db = {
    prepare(query) {
      let args = [];
      const statement = {
        bind(...values) {
          args = values;
          return statement;
        },
        async first() {
          return sql.prepare(query).get(...args) ?? null;
        },
        async all() {
          return { results: sql.prepare(query).all(...args) };
        },
        async run() {
          sql.prepare(query).run(...args);
          return {};
        },
      };
      return statement;
    },
  };
  const endpoints = [];
  const { dispatchBotPushNotifications } = runtime(
    {
      AbortSignal,
      fetch: async (url) => {
        endpoints.push(url);
        return new Response("", { status: 201 });
      },
    },
    {
      "web-push": {
        default: {
          generateRequestDetails: (subscription) => ({
            endpoint: subscription.endpoint,
            method: "POST",
            headers: {},
            body: Buffer.from("encrypted"),
          }),
        },
      },
    },
  ).load(resolve("db/push-notifications.ts"));
  const env = {
    VAPID_SUBJECT: "mailto:owner@example.com",
    VAPID_PUBLIC_KEY: "public",
    VAPID_PRIVATE_KEY: "private",
  };
  await dispatchBotPushNotifications(db, env, new Date("2026-09-25T00:00:01Z"));
  await dispatchBotPushNotifications(db, env, new Date("2026-09-25T00:00:02Z"));
  assert.deepEqual(endpoints, ["https://push.example/mine"]);
  assert.equal(
    sql.prepare("SELECT COUNT(*) AS n FROM todo_bot_push_deliveries").get().n,
    1,
  );
  sql.close();
});
