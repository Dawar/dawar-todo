import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { MAX_PINNED_TASKS, PIN_LIST_PREFERENCE_KEY } from "../lib/task-pins.ts";

const root = new URL("../", import.meta.url);

test("limits the active pin list to five tasks across app and phone actions", async () => {
  const [page, database, taskRoute, urgentAlerts] = await Promise.all([
    Promise.all(["app/page.tsx", "app/task-sync.ts", "app/task-model.ts", "app/sync-request.ts"].map((path) => readFile(new URL(path, root), "utf8"))).then((parts) => parts.join("\n")),
    readFile(new URL("db/todos.ts", root), "utf8"),
    readFile(new URL("app/api/todos/[id]/route.ts", root), "utf8"),
    readFile(new URL("db/urgent-alerts.ts", root), "utf8"),
  ]);

  assert.equal(MAX_PINNED_TASKS, 5);
  assert.equal(PIN_LIST_PREFERENCE_KEY, "dawar-todo-pin-list-enabled");
  assert.match(page, /pinnedTaskCount >= MAX_PINNED_TASKS/);
  assert.match(page, /You can pin up to \$\{MAX_PINNED_TASKS\} tasks/);
  assert.match(database, /SELECT COUNT\(\*\) AS count FROM todos WHERE pinned = 1/);
  assert.match(database, /OR \(SELECT COUNT\(\*\) FROM todos WHERE pinned = 1\) < \?/);
  assert.match(database, /Only active open tasks can be pinned/);
  assert.match(database, /status = 'open' AND snoozed_until IS NULL/);
  assert.match(taskRoute, /snooz\|pin\|sync/);
  assert.match(urgentAlerts, /MAX_PINNED_TASKS/);
  assert.match(urgentAlerts, /reason: "pin-limit"/);
});

test("snoozing clears pins and the pin-list toggle restores canonical mixing", async () => {
  const [page, database, urgentAlerts] = await Promise.all([
    Promise.all(["app/page.tsx", "app/task-sync.ts", "app/task-model.ts", "app/sync-request.ts"].map((path) => readFile(new URL(path, root), "utf8"))).then((parts) => parts.join("\n")),
    readFile(new URL("db/todos.ts", root), "utf8"),
    readFile(new URL("db/urgent-alerts.ts", root), "utf8"),
  ]);

  assert.match(database, /SET snoozed_until = \?, pinned = 0/);
  assert.match(database, /snoozed_until = \?, pinned = 0/);
  assert.match(urgentAlerts, /snoozed_until = \?, pinned = 0/);
  assert.match(page, /snoozedUntil: temporarySnooze, pinned: false/);
  assert.match(page, /snoozedUntil: optimisticUntil, pinned: false/);
  assert.match(database, /normalizedUpdate\.snoozedUntil/);

  assert.match(page, /window\.localStorage\.getItem\(PIN_LIST_PREFERENCE_KEY\)/);
  assert.match(page, /window\.localStorage\.setItem\(PIN_LIST_PREFERENCE_KEY/);
  assert.match(page, /aria-pressed=\{pinListEnabled\}/);
  assert.match(page, /view === "open" && pinListEnabled \? \[\.\.\.pinnedOpenTodos, \.\.\.regularOpenTodos\] : filtered/);
  assert.match(page, /behavior: enabled \? "dedicated-section" : "canonical-order"/);
});

test("the production pin reset is durable and runs only once", async () => {
  const database = await readFile(new URL("db/todos.ts", root), "utf8");
  assert.match(database, /todo_pin_policy_v1/);
  assert.match(database, /UPDATE todos[\s\S]*SET pinned = 0[\s\S]*WHERE pinned <> 0/);
  assert.match(database, /five-item pin policy initialized/);
});
