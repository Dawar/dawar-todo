import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("field versions merge independent device edits and reject stale same-field edits", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE todos (id INTEGER PRIMARY KEY, title TEXT NOT NULL, notes TEXT NOT NULL);
    CREATE TABLE todo_field_versions (
      todo_id INTEGER NOT NULL,
      field TEXT NOT NULL,
      version TEXT NOT NULL,
      mutation_id TEXT NOT NULL,
      PRIMARY KEY (todo_id, field)
    );
    INSERT INTO todos (id, title, notes) VALUES (1, 'Original', 'Original notes');
  `);

  const apply = (field, value, version, mutationId) => {
    database.prepare(`
      INSERT INTO todo_field_versions (todo_id, field, version, mutation_id)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(todo_id, field) DO UPDATE SET
        version = excluded.version,
        mutation_id = excluded.mutation_id
      WHERE excluded.version > todo_field_versions.version
    `).run(1, field, version, mutationId);
    database.prepare(`
      UPDATE todos SET ${field} = ?
      WHERE id = 1 AND EXISTS (
        SELECT 1 FROM todo_field_versions
        WHERE todo_id = 1 AND field = ? AND version = ? AND mutation_id = ?
      )
    `).run(value, field, version, mutationId);
  };

  apply("title", "Phone title", "2026-07-21T10:00:00.000Z|a", "a");
  apply("notes", "Desktop notes", "2026-07-21T10:00:01.000Z|b", "b");
  apply("title", "Stale offline title", "2026-07-21T09:59:59.000Z|c", "c");
  assert.deepEqual({ ...database.prepare("SELECT title, notes FROM todos WHERE id = 1").get() }, {
    title: "Phone title",
    notes: "Desktop notes",
  });
});

test("Quick Add draft versions converge deterministically without trimming text", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE todo_sync_changes (
      revision INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_key TEXT NOT NULL,
      operation TEXT NOT NULL
    );
  `);
  const write = (text, updatedAt, clientId) => {
    const version = `${updatedAt}|${clientId}`;
    const applied = database.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ('capture_draft', ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
      WHERE json_extract(excluded.value, '$.version') > COALESCE(json_extract(app_settings.value, '$.version'), '')
      RETURNING value
    `).get(JSON.stringify({ text, updatedAt, clientId, version }), updatedAt);
    if (applied) {
      database.prepare(`
        INSERT INTO todo_sync_changes (entity_type, entity_key, operation)
        VALUES ('capture_draft', 'capture_draft', 'changed')
      `).run();
    }
  };

  write("Keep this trailing space ", "2026-07-23T12:00:00.000Z", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  write("Older device value", "2026-07-23T11:59:59.000Z", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  write("Later device value\n", "2026-07-23T12:00:01.000Z", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  const stored = JSON.parse(database.prepare("SELECT value FROM app_settings WHERE key = 'capture_draft'").get().value);
  assert.equal(stored.text, "Later device value\n");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM todo_sync_changes").get().count, 2);
});

test("ships automatic saving, queued offline edits, incremental polling, and conflict metadata", async () => {
  const [page, offlineStore, database, schema, route, migration, syncMigration, bootstrapRoute, syncRoute, captureDraftRoute, maintenance, attachments, recurring, openApiText, skill] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/offline-store.ts", root), "utf8"),
    readFile(new URL("db/todos.ts", root), "utf8"),
    readFile(new URL("db/schema.ts", root), "utf8"),
    readFile(new URL("app/api/todos/[id]/route.ts", root), "utf8"),
    readFile(new URL("drizzle/0013_tough_maverick.sql", root), "utf8"),
    readFile(new URL("drizzle/0014_redundant_red_shift.sql", root), "utf8"),
    readFile(new URL("app/api/bootstrap/route.ts", root), "utf8"),
    readFile(new URL("app/api/sync/route.ts", root), "utf8"),
    readFile(new URL("app/api/capture-draft/route.ts", root), "utf8"),
    readFile(new URL("db/maintenance.ts", root), "utf8"),
    readFile(new URL("db/attachments.ts", root), "utf8"),
    readFile(new URL("worker/recurring.ts", root), "utf8"),
    readFile(new URL("public/openapi.json", root), "utf8"),
    readFile(new URL("db/api-token-skill.ts", root), "utf8"),
  ]);
  const openApi = JSON.parse(openApiText);

  assert.doesNotMatch(page, />Save changes</);
  assert.match(page, /Saved automatically/);
  assert.match(page, /window\.setTimeout\([^]*700/);
  assert.match(page, /window\.setInterval\([^]*3_000/);
  assert.match(page, /applyLiveSnapshot/);
  assert.match(page, /applyLiveDelta/);
  assert.match(page, /\/api\/bootstrap/);
  assert.match(page, /\/api\/sync\?after=/);
  assert.doesNotMatch(page, /Promise\.all\(\[\s*request<\{ todos: Todo\[\] \}>\("\/api\/todos"/);
  assert.match(page, /saveOfflineTodoMutation/);
  assert.match(page, /listOfflineTodoMutations/);
  assert.match(offlineStore, /DATABASE_VERSION = 7/);
  assert.match(offlineStore, /CAPTURE_DRAFT_STORE = "capture-draft"/);
  assert.match(page, /updateCaptureTitle\(event\.target\.value, "typing"\)/);
  assert.match(page, /updateEditDraftField/);
  assert.match(page, /editDraftRef\.current = next/);
  assert.match(page, /if \(field === "title" \|\| field === "notes"\) return draft\[field\]/);
  assert.match(database, /updateTodoCaptureDraft/);
  assert.match(database, /entity_type === "capture_draft"/);
  assert.match(database, /todo_sync_capture_draft_insert/);
  assert.match(database, /todo_sync_capture_draft_update/);
  assert.match(database, /CURRENT_SCHEMA_VERSION = "29"/);
  assert.match(captureDraftRoute, /updateTodoCaptureDraft/);
  assert.match(captureDraftRoute, /Cache-Control/);
  assert.match(offlineStore, /pending-mutations/);
  assert.match(offlineStore, /pending-actions/);
  assert.match(offlineStore, /saveOfflineTaskAction/);
  assert.match(offlineStore, /fieldTimestamps/);
  assert.match(page, /local-first shell hydrated/);
  assert.match(page, /task action committed to durable outbox/);
  assert.match(page, /timeoutMs: 5_000/);
  assert.match(page, /connectionQuality === "degraded"/);
  assert.match(page, /SYNC_STATUS_DELAY_MS = 5_000/);
  assert.match(page, /setShowPendingSyncStatus\(true\)/);
  assert.match(page, /connectionQuality !== "online" \|\| showPendingSyncStatus/);
  assert.match(schema, /todoFieldVersions/);
  assert.match(schema, /todoSyncChanges/);
  assert.match(migration, /CREATE TABLE `todo_field_versions`/);
  assert.match(syncMigration, /CREATE TABLE `todo_sync_changes`/);
  assert.match(syncMigration, /CREATE TRIGGER `todo_sync_todos_update`/);
  assert.match(syncMigration, /CREATE TRIGGER `todo_sync_attachments_update`/);
  assert.match(syncMigration, /VALUES \('schema_version', '14'/);
  assert.match(bootstrapRoute, /readTodoBootstrap/);
  assert.match(syncRoute, /readTodoSyncDelta/);
  assert.match(maintenance, /background recurrence check scheduled/);
  assert.match(maintenance, /if \(source === "sync"\)/);
  assert.doesNotMatch(attachments, /SELECT value FROM app_settings WHERE key = 'attachment_cleanup_at'/);
  assert.doesNotMatch(recurring, /PRAGMA table_info/);
  assert.match(database, /production schema fast path/);
  assert.match(database, /readTodoBootstrap/);
  assert.match(database, /readTodoSyncDelta/);
  assert.match(database, /excluded\.version > todo_field_versions\.version/);
  assert.match(database, /appliedFields/);
  assert.match(route, /mutationId/);
  assert.match(route, /recordUndo: payload\.autosave !== true/);
  assert.match(route, /if \(!title\.trim\(\)\)/);
  assert.match(route, /update\.notes = validateTaskDescription\(String\(payload\.notes\)\)/);
  assert.ok(openApi.components.schemas.SyncMutation);
  assert.match(skill, /independent fields merge/);
});

test("sync triggers produce monotonic task, project, settings, and attachment revisions", async () => {
  const migration = await readFile(new URL("drizzle/0014_redundant_red_shift.sql", root), "utf8");
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE todos (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL);
    CREATE TABLE todo_projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE todo_attachments (id TEXT PRIMARY KEY, todo_id INTEGER, upload_state TEXT, deleted_at TEXT);
  `);
  for (const statement of migration.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) {
    database.exec(statement);
  }
  database.prepare("INSERT INTO todos (title) VALUES (?)").run("Task");
  database.prepare("UPDATE todos SET title = ? WHERE id = 1").run("Updated");
  database.prepare("INSERT INTO todo_projects (name) VALUES (?)").run("Project");
  database.prepare("INSERT INTO app_settings (key, value) VALUES ('snooze_timezone', 'UTC') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  database.prepare("INSERT INTO todo_attachments (id, todo_id, upload_state) VALUES ('a', 1, 'ready')").run();
  const changes = database.prepare("SELECT revision, entity_type, entity_key FROM todo_sync_changes ORDER BY revision").all();
  assert.deepEqual(changes.map((row) => Number(row.revision)), [1, 2, 3, 4, 5]);
  assert.deepEqual(changes.map((row) => row.entity_type), ["todo", "todo", "project", "settings", "todo"]);
});

test("capture draft migration emits revisions only for the shared Quick Add record", async () => {
  const migration = await readFile(new URL("drizzle/0015_capture_draft_sync.sql", root), "utf8");
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE todo_sync_changes (
      revision INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_key TEXT NOT NULL,
      operation TEXT NOT NULL
    );
  `);
  for (const statement of migration.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) {
    database.exec(statement);
  }
  database.prepare("INSERT INTO app_settings (key, value) VALUES ('capture_draft', '{}')").run();
  database.prepare("UPDATE app_settings SET value = ? WHERE key = 'capture_draft'").run('{"text":"draft"}');
  database.prepare("INSERT INTO app_settings (key, value) VALUES ('unrelated', 'value')").run();
  const changes = database.prepare("SELECT entity_type, entity_key FROM todo_sync_changes ORDER BY revision").all();
  assert.deepEqual(changes.map((row) => ({ ...row })), [
    { entity_type: "capture_draft", entity_key: "capture_draft" },
    { entity_type: "capture_draft", entity_key: "capture_draft" },
  ]);
  assert.equal(database.prepare("SELECT value FROM app_settings WHERE key = 'schema_version'").get().value, "15");
});
