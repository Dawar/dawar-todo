import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("canonical task ordering is persistent and replaces client sort modes", async () => {
  const [page, database, schema, route, store, migration] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("db/todos.ts", root), "utf8"),
    readFile(new URL("db/schema.ts", root), "utf8"),
    readFile(new URL("app/api/todos/reorder/route.ts", root), "utf8"),
    readFile(new URL("app/offline-store.ts", root), "utf8"),
    readFile(new URL("drizzle/0028_vengeful_greymalkin.sql", root), "utf8"),
  ]);

  assert.doesNotMatch(page, /type Sort =/);
  assert.doesNotMatch(page, /aria-label="Sort tasks"/);
  assert.doesNotMatch(page, /-new Date\(todo\.updatedAt\)\.valueOf\(\)/);
  assert.match(page, /Number\.MAX_SAFE_INTEGER/);
  assert.match(page, /record\.sortOrder \?\? -new Date\(record\.createdAt\)\.valueOf\(\)/);
  assert.match(page, /legacy cached tasks loaded without canonical order/);
  assert.match(page, /remote snapshot contained tasks without canonical order/);
  assert.match(page, /return \[\.\.\.rows\]\.sort\(compareCanonicalOrder\)/);
  assert.match(page, /ActionIcon name="reorder"/);
  assert.match(page, /onPointerMove=\{onReorderMove\}/);
  assert.match(page, /aria-label=\{`Drag to reorder:/);
  assert.doesNotMatch(page, /onReorderByKeyboard/);
  assert.doesNotMatch(page, /keyboard reorder requested/);
  assert.match(page, /path: "\/api\/todos\/reorder"/);
  assert.match(page, /kind: "reorder"/);
  assert.match(page, /reorder committed to durable outbox/);
  assert.match(page, /\[taskListAnimationRef, setTaskListAnimations\]/);
  assert.match(page, /setTaskListAnimations\(false\)/);
  assert.match(page, /cloneNode\(true\)/);
  assert.match(page, /transform: "translate3d\(0, 0, 0\)"/);
  assert.match(page, /previewElement\.style\.transform = `translate3d\(0, \$\{deltaY\}px, 0\)`/);
  assert.match(page, /window\.requestAnimationFrame/);
  assert.match(page, /TASK_REORDER_EDGE_SCROLL_ZONE_PX/);
  assert.match(page, /drag edge auto-scroll started/);
  assert.match(page, /drag preview committed/);
  assert.match(store, /"reorder"/);
  assert.match(schema, /sortOrder: integer\("sort_order"\)/);
  assert.match(database, /ORDER BY sort_order ASC, id DESC/);
  assert.match(database, /canonical task order persisted/);
  assert.match(route, /readTodoMutationReceipt/);
  assert.match(route, /saveTodoMutationReceipt/);
  assert.match(migration, /ALTER TABLE `todos` ADD `sort_order`/);
  assert.match(migration, /ROW_NUMBER\(\) OVER \(ORDER BY updated_at DESC, id DESC\)/);
});

test("sort-order migration preserves the previous updated-time order", async () => {
  const migration = await readFile(new URL("drizzle/0028_vengeful_greymalkin.sql", root), "utf8");
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE todos (
      id INTEGER PRIMARY KEY,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    INSERT INTO todos (id, updated_at) VALUES
      (1, '2026-07-01T10:00:00.000Z'),
      (2, '2026-07-03T10:00:00.000Z'),
      (3, '2026-07-02T10:00:00.000Z');
  `);
  database.exec(migration.replaceAll("--> statement-breakpoint", ""));
  const rows = database.prepare("SELECT id, sort_order FROM todos ORDER BY sort_order").all();
  assert.deepEqual(rows.map((row) => Number(row.id)), [2, 3, 1]);
  assert.deepEqual(rows.map((row) => Number(row.sort_order)), [0, 1024, 2048]);
  assert.equal(database.prepare("SELECT value FROM app_settings WHERE key = 'schema_version'").get().value, "28");
});

test("offline synchronization always schedules a follow-up pass", async () => {
  const page = await readFile(new URL("app/page.tsx", root), "utf8");
  assert.match(page, /syncRequestedRef\.current = true/);
  assert.match(page, /follow-up synchronization requested during active pass/);
  assert.match(page, /scheduleOfflineQueueSync\("follow-up-request"\)/);
  assert.match(page, /scheduleOfflineQueueSync\(`backoff:\$\{stage\}`/);
  assert.match(page, /scheduleOfflineQueueSync\("deferred-action"/);
});
