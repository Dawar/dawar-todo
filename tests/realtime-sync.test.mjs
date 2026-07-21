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

test("ships automatic saving, queued offline edits, polling, and conflict metadata", async () => {
  const [page, offlineStore, database, schema, route, migration, openApiText, skill] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/offline-store.ts", root), "utf8"),
    readFile(new URL("db/todos.ts", root), "utf8"),
    readFile(new URL("db/schema.ts", root), "utf8"),
    readFile(new URL("app/api/todos/[id]/route.ts", root), "utf8"),
    readFile(new URL("drizzle/0013_tough_maverick.sql", root), "utf8"),
    readFile(new URL("public/openapi.json", root), "utf8"),
    readFile(new URL("db/api-token-skill.ts", root), "utf8"),
  ]);
  const openApi = JSON.parse(openApiText);

  assert.doesNotMatch(page, />Save changes</);
  assert.match(page, /Saved automatically/);
  assert.match(page, /window\.setTimeout\([^]*700/);
  assert.match(page, /window\.setInterval\([^]*3_000/);
  assert.match(page, /applyLiveSnapshot/);
  assert.match(page, /saveOfflineTodoMutation/);
  assert.match(page, /listOfflineTodoMutations/);
  assert.match(offlineStore, /DATABASE_VERSION = 3/);
  assert.match(offlineStore, /pending-mutations/);
  assert.match(offlineStore, /fieldTimestamps/);
  assert.match(schema, /todoFieldVersions/);
  assert.match(migration, /CREATE TABLE `todo_field_versions`/);
  assert.match(database, /excluded\.version > todo_field_versions\.version/);
  assert.match(database, /appliedFields/);
  assert.match(route, /mutationId/);
  assert.match(route, /recordUndo: payload\.autosave !== true/);
  assert.ok(openApi.components.schemas.SyncMutation);
  assert.match(skill, /independent fields merge/);
});
