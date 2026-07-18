import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("ships the complete todo product surface", async () => {
  const [page, layout, hosting, database, bulkRoute] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/layout.tsx", root), "utf8"),
    readFile(new URL(".openai/hosting.json", root), "utf8"),
    readFile(new URL("db/todos.ts", root), "utf8"),
    readFile(new URL("app/api/todos/bulk/route.ts", root), "utf8"),
  ]);
  assert.match(layout, /title: "Dawar Todo"/);
  assert.match(layout, /\/og\.png/);
  assert.match(page, /Add a task/);
  assert.match(page, /Search tasks/);
  assert.match(page, /All projects/);
  assert.match(page, /Smart sort/);
  assert.match(page, /Snoozed/);
  assert.match(page, /Archived/);
  assert.match(page, /Select visible/);
  assert.match(page, /Swipe left:.*"open".*"done".*snooze/);
  assert.match(page, />Filters</);
  assert.match(page, /"Undoing…" : "Undo"/);
  assert.match(page, /\/api\/todos\/undo/);
  assert.match(page, /Task details/);
  assert.match(page, /Quick actions/);
  assert.match(page, /Save changes/);
  assert.match(page, /\/api\/todos\/\$\{editingTodo\.id\}/);
  assert.match(page, /fixed inset-x-0 z-40/);
  assert.doesNotMatch(page, /sticky top-\[62px\]/);
  assert.match(page, /Archive into a project/);
  assert.match(page, /Filter archived notes by project/);
  assert.match(page, /reproject/);
  assert.match(page, /task-project-options/);
  assert.match(page, /overflow-x-hidden overflow-y-auto/);
  assert.match(page, /flex min-w-0 flex-wrap gap-2/);
  assert.doesNotMatch(page, /Edit the full task without leaving your place/);
  assert.match(database, /archived_project_backfill_v1/);
  assert.match(database, /Choose or create a project before archiving/);
  assert.match(bulkRoute, /"reproject"/);
  assert.doesNotMatch(page, /Capture what needs doing\. Then move/);
  assert.match(hosting, /"d1": "DB"/);
  await access(new URL("public/og.png", root));
});

test("removes starter preview dependencies", async () => {
  const [packageJson, page, layout] = await Promise.all([
    readFile(new URL("package.json", root), "utf8"),
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/layout.tsx", root), "utf8"),
  ]);
  const combined = `${packageJson}\n${page}\n${layout}`;
  assert.doesNotMatch(combined, /react-loading-skeleton|codex-preview|Your site is taking shape|Starter Project/i);
});
