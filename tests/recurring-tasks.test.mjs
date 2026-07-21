import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { cronMatchesDate, cronValidationError, latestCronOccurrence, normalizeCronExpression } from "../lib/cron.ts";
import { processRecurringTodos } from "../worker/recurring.ts";

const root = new URL("../", import.meta.url);

test("validates and evaluates five-field cron expressions in the user's timezone", () => {
  const mondayAtNineToronto = new Date("2026-07-20T13:00:00.000Z");
  assert.equal(normalizeCronExpression(" 0   9  * * 1-5 "), "0 9 * * 1-5");
  assert.equal(cronMatchesDate("0 9 * * 1-5", mondayAtNineToronto, "America/Toronto"), true);
  assert.equal(cronMatchesDate("0 9 * * 1-5", mondayAtNineToronto, "America/Vancouver"), false);
  assert.equal(cronMatchesDate("*/15 * * * *", new Date("2026-07-20T13:45:00.000Z"), "UTC"), true);
  assert.equal(cronMatchesDate("0 0 * * 7", new Date("2026-07-19T00:00:00.000Z"), "UTC"), true);
  assert.match(cronValidationError("0 9 * *") ?? "", /five-field/);
  assert.match(cronValidationError("60 9 * * *") ?? "", /between 0 and 59/);
});

test("finds a missed local-time occurrence without replaying a schedule completed afterward", () => {
  const at = new Date("2026-07-21T13:41:00.000Z");
  assert.equal(
    latestCronOccurrence("0 9 * * 1-5", at, "America/Toronto", new Date("2026-07-21T12:55:00.000Z"))?.toISOString(),
    "2026-07-21T13:00:00.000Z",
  );
  assert.equal(
    latestCronOccurrence("0 9 * * 1-5", at, "America/Toronto", new Date("2026-07-21T13:05:00.000Z")),
    null,
  );
  assert.equal(
    latestCronOccurrence("30 7 1 * *", new Date("2026-07-21T16:00:00.000Z"), "America/Toronto", new Date("2026-06-30T16:00:00.000Z"))?.toISOString(),
    "2026-07-01T11:30:00.000Z",
  );
});

test("scheduled recurrence reopens completed matches and records open matches once", async () => {
  const rows = [
    { id: 1, status: "completed", recurrence_cron: "0 9 * * 1-5", recurrence_last_fired_at: null },
    { id: 2, status: "open", recurrence_cron: "0 9 * * *", recurrence_last_fired_at: null },
    { id: 3, status: "completed", recurrence_cron: "bad schedule", recurrence_last_fired_at: null },
  ];
  const updateBindings = [];
  const database = {
    prepare(sql) {
      const statement = {
        sql,
        values: [],
        bind(...values) {
          this.values = values;
          return this;
        },
        async all() {
          if (sql.includes("PRAGMA table_info")) return { results: [{ name: "recurrence_cron" }, { name: "recurrence_last_fired_at" }] };
          if (sql.includes("SELECT id, status")) return { results: rows };
          throw new Error(`Unexpected all: ${sql}`);
        },
        async first() {
          if (sql.includes("snooze_timezone")) return { value: "America/Toronto" };
          throw new Error(`Unexpected first: ${sql}`);
        },
        async run() {
          if (sql.includes("CREATE INDEX")) return { meta: { changes: 0 } };
          throw new Error(`Unexpected run: ${sql}`);
        },
      };
      return statement;
    },
    async batch(statements) {
      updateBindings.push(...statements.map((statement) => statement.values));
      return statements.map(() => ({ meta: { changes: 1 } }));
    },
  };

  const result = await processRecurringTodos(database, new Date("2026-07-20T13:00:35.000Z"));
  assert.deepEqual({ checked: result.checked, due: result.due, changed: result.changed, reopened: result.reopened, invalid: result.invalid }, {
    checked: 3,
    due: 2,
    changed: 2,
    reopened: 1,
    invalid: 1,
  });
  assert.equal(result.timeZone, "America/Toronto");
  assert.equal(result.firedAt, "2026-07-20T13:00:00.000Z");
  assert.deepEqual(updateBindings.map((values) => values[1]), [1, 2]);
});

test("todo-list sync catches up a missed occurrence once per minute", async () => {
  const rows = [
    {
      id: 11,
      status: "completed",
      recurrence_cron: "0 9 * * 1-5",
      recurrence_last_fired_at: null,
      completed_at: "2026-07-21T12:55:00.000Z",
      created_at: "2026-07-20T12:00:00.000Z",
      updated_at: "2026-07-21T12:55:00.000Z",
    },
    {
      id: 12,
      status: "completed",
      recurrence_cron: "0 9 * * 1-5",
      recurrence_last_fired_at: null,
      completed_at: "2026-07-21T13:05:00.000Z",
      created_at: "2026-07-20T12:00:00.000Z",
      updated_at: "2026-07-21T13:05:00.000Z",
    },
  ];
  const updateBindings = [];
  const database = {
    prepare(sql) {
      const statement = {
        sql,
        values: [],
        bind(...values) {
          this.values = values;
          return this;
        },
        async all() {
          if (sql.includes("PRAGMA table_info")) return { results: [{ name: "recurrence_cron" }, { name: "recurrence_last_fired_at" }] };
          if (sql.includes("SELECT id, status")) return { results: rows };
          throw new Error(`Unexpected all: ${sql}`);
        },
        async first() {
          if (sql.includes("snooze_timezone")) return { value: "America/Toronto" };
          throw new Error(`Unexpected first: ${sql}`);
        },
        async run() {
          if (sql.includes("recurrence_sync_minute")) return { meta: { changes: 1 } };
          if (sql.includes("CREATE INDEX")) return { meta: { changes: 0 } };
          throw new Error(`Unexpected run: ${sql}`);
        },
      };
      return statement;
    },
    async batch(statements) {
      updateBindings.push(...statements.map((statement) => statement.values));
      return statements.map(() => ({ meta: { changes: 1 } }));
    },
  };

  const result = await processRecurringTodos(database, new Date("2026-07-21T13:41:00.000Z"), {
    catchUp: true,
    source: "todo-list-sync",
  });
  assert.equal(result.due, 1);
  assert.equal(result.reopened, 1);
  assert.equal(updateBindings[0][0], "2026-07-21T13:00:00.000Z");
  assert.equal(updateBindings[0][1], 11);
});

test("ships recurrence storage, snooze protection, and a once-per-minute Worker trigger", async () => {
  const [schema, database, page, worker, todoRoute, generatedConfig, openApiText, skillSource, migration] = await Promise.all([
    readFile(new URL("db/schema.ts", root), "utf8"),
    readFile(new URL("db/todos.ts", root), "utf8"),
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("worker/index.ts", root), "utf8"),
    readFile(new URL("app/api/todos/route.ts", root), "utf8"),
    readFile(new URL("dist/server/wrangler.json", root), "utf8"),
    readFile(new URL("public/openapi.json", root), "utf8"),
    readFile(new URL("db/api-token-skill.ts", root), "utf8"),
    readFile(new URL("drizzle/0012_sweet_wolf_cub.sql", root), "utf8"),
  ]);
  const generated = JSON.parse(generatedConfig);
  const openApi = JSON.parse(openApiText);

  assert.match(schema, /recurrenceCron: text\("recurrence_cron"\)/);
  assert.match(migration, /ADD `recurrence_cron` text/);
  assert.match(database, /Recurring tasks cannot be snoozed/);
  assert.match(page, /Recurring tasks cannot be snoozed/);
  assert.match(worker, /processRecurringTodos/);
  assert.match(todoRoute, /catchUp:\s*true/);
  assert.deepEqual(generated.triggers.crons, ["* * * * *"]);
  assert.ok(openApi.components.schemas.Todo.properties.recurrenceCron);
  assert.ok(openApi.components.schemas.UpdateTodo.properties.recurrenceCron);
  assert.match(skillSource, /recurrenceCron/);
});
