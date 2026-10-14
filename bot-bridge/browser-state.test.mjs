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

test("streaming routes exact methods, preserves indexed reasoning parts and authoritative full items", () => {
  const { reduceBotTurns } = runtime().load("app/bots/thread-state.ts");
  let turns = [{ id: "t", status: "inProgress", itemsView: "full", items: [
    { id: "a", type: "agentMessage", text: "prefix" },
    { id: "p", type: "plan", text: "draft" },
    { id: "r", type: "reasoning", summary: ["first"], content: [] },
    { id: "f", type: "fileChange", changes: [], status: "inProgress" },
  ] }];
  const apply = (method, params) => { turns = reduceBotTurns(turns, { method, params: { turnId: "t", ...params } }); };
  const previous = turns;
  apply("item/fileChange/outputDelta", { itemId: "a", delta: "wrong-channel" });
  assert.equal(turns, previous);
  apply("item/agentMessage/delta", { itemId: "a", delta: "-live" });
  apply("item/plan/delta", { itemId: "p", delta: "-stream" });
  apply("item/reasoning/summaryPartAdded", { itemId: "r", summaryIndex: 1 });
  apply("item/reasoning/summaryTextDelta", { itemId: "r", summaryIndex: 1, delta: "second" });
  apply("item/reasoning/textDelta", { itemId: "r", contentIndex: 2, delta: "private-part" });
  assert.equal(turns[0].items[0].text, "prefix-live");
  assert.equal(turns[0].items[2].summary[1], "second");
  assert.equal(turns[0].items[2].content[2], "private-part");
  const stable = turns;
  apply("item/reasoning/summaryTextDelta", { itemId: "r", summaryIndex: 1e9, delta: "invalid" });
  assert.equal(turns, stable);
  apply("item/fileChange/patchUpdated", { itemId: "f", changes: [{ path: "a.ts", diff: "+line" }] });
  assert.equal(turns[0].items[3].changes[0].diff, "+line");
  apply("item/completed", { item: { id: "p", type: "plan", text: "canonical final plan" } });
  assert.equal(turns[0].items[1].text, "canonical final plan");
  apply("turn/completed", { turn: { id: "t", status: "failed", itemsView: "notLoaded", items: [] } });
  assert.equal(turns[0].items.length, 4);
  apply("turn/completed", { turn: { id: "t", status: "failed", itemsView: "full", items: [] } });
  assert.equal(turns[0].items.length, 0, "explicit full empty items are authoritative");
  apply("turn/started", { turn: { id: "t", status: "inProgress", itemsView: "full", items: [] } });
  assert.equal(turns[0].status, "failed", "late start cannot resurrect a terminal turn");
});
