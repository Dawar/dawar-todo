import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  expiredSnoozeIds,
  isActivelySnoozed,
  nextSnoozeWakeAt,
} from "../lib/snooze-clock.ts";
import { snoozeLabel } from "../lib/snooze-label.ts";

const root = new URL("../", import.meta.url);

test("the client clock identifies active, next, and expired snoozes exactly", () => {
  const now = Date.parse("2026-07-23T14:00:00.000Z");
  const todos = [
    { id: 1, status: "open", snoozedUntil: "2026-07-23T13:59:59.000Z" },
    { id: 2, status: "open", snoozedUntil: "2026-07-23T14:15:00.000Z" },
    { id: 3, status: "open", snoozedUntil: "2026-07-23T14:05:00.000Z" },
    { id: 4, status: "completed", snoozedUntil: "2026-07-23T13:00:00.000Z" },
    { id: 5, status: "open", snoozedUntil: null },
  ];

  assert.equal(isActivelySnoozed(todos[0], now), false);
  assert.equal(isActivelySnoozed(todos[2], now), true);
  assert.equal(nextSnoozeWakeAt(todos, now), Date.parse("2026-07-23T14:05:00.000Z"));
  assert.deepEqual(expiredSnoozeIds(todos, now), [1]);
});

test("wake labels omit the date only inside the current local week", () => {
  const now = Date.parse("2026-07-26T16:00:00.000Z");
  const timeZone = "America/New_York";

  assert.equal(
    snoozeLabel("2026-07-29T17:30:00.000Z", now, timeZone, "en-US"),
    "Wakes Wed 1:30 PM",
  );
  assert.equal(
    snoozeLabel("2026-08-19T17:30:00.000Z", now, timeZone, "en-US"),
    "Wakes Wed, Aug 19 at 1:30 PM",
  );
  assert.equal(
    snoozeLabel("2027-01-06T18:30:00.000Z", now, timeZone, "en-US"),
    "Wakes Wed, Jan 6, 2027 at 1:30 PM",
  );
});

test("normal sync clears expired snoozes and the app schedules their exact return", async () => {
  const [page, databaseSource, maintenance, openApiText, skill] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("db/todos.ts", root), "utf8"),
    readFile(new URL("db/maintenance.ts", root), "utf8"),
    readFile(new URL("public/openapi.json", root), "utf8"),
    readFile(new URL("db/api-token-skill.ts", root), "utf8"),
  ]);
  const openApi = JSON.parse(openApiText);
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE todos (
      id INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      snoozed_until TEXT,
      updated_at TEXT NOT NULL
    );
    INSERT INTO todos VALUES
      (1, 'open', '2026-07-23T13:59:59.000Z', '2026-07-23T12:00:00.000Z'),
      (2, 'open', '2026-07-23T14:15:00.000Z', '2026-07-23T12:00:00.000Z'),
      (3, 'completed', '2026-07-23T13:00:00.000Z', '2026-07-23T12:00:00.000Z');
  `);
  const woken = database.prepare(`
    UPDATE todos
    SET snoozed_until = NULL, updated_at = '2026-07-23T14:00:00.000Z'
    WHERE status = 'open' AND snoozed_until IS NOT NULL AND snoozed_until <= ?
    RETURNING id
  `).all("2026-07-23T14:00:00.000Z");

  assert.deepEqual(woken.map((row) => Number(row.id)), [1]);
  assert.equal(database.prepare("SELECT snoozed_until FROM todos WHERE id = 1").get().snoozed_until, null);
  assert.equal(database.prepare("SELECT snoozed_until FROM todos WHERE id = 2").get().snoozed_until, "2026-07-23T14:15:00.000Z");
  assert.equal(database.prepare("SELECT snoozed_until FROM todos WHERE id = 3").get().snoozed_until, "2026-07-23T13:00:00.000Z");

  assert.match(databaseSource, /wakeExpiredSnoozedTodos/);
  assert.match(databaseSource, /snoozed_until <= \?/);
  assert.match(maintenance, /await wakeExpiredSnoozedTodos\(now\)/);
  assert.match(page, /next live wake scheduled/);
  assert.match(page, /refreshLiveData\("snooze-wake"\)/);
  assert.match(page, /reconcileTaskClock/);
  assert.match(page, /isSnoozed\(editingTodo, now\)[\s\S]*SnoozeStatusBadge/);
  assert.match(openApi.components.schemas.Todo.properties.snoozedUntil.description, /clear an expired timestamp/);
  assert.match(skill, /automatically clear the snooze/);
});
