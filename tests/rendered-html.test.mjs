import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("ships the complete todo product surface", async () => {
  const [page, layout, hosting, database, schema, bulkRoute, projectsRoute, actionIcons] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/layout.tsx", root), "utf8"),
    readFile(new URL(".openai/hosting.json", root), "utf8"),
    readFile(new URL("db/todos.ts", root), "utf8"),
    readFile(new URL("db/schema.ts", root), "utf8"),
    readFile(new URL("app/api/todos/bulk/route.ts", root), "utf8"),
    readFile(new URL("app/api/projects/route.ts", root), "utf8"),
    readFile(new URL("app/action-icon.tsx", root), "utf8"),
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
  assert.match(page, /leftSecondaryAction.*snoozed/s);
  assert.match(page, /\? \{ action: "unsnooze", label: "Wake", icon: "wake" \}/);
  assert.match(page, /view === "snoozed" \? \(/);
  assert.match(page, /wokeSnoozed/);
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
  assert.match(page, /Archive projects/);
  assert.match(page, /New project/);
  assert.match(page, /`Add to \$\{archiveProject\}…`/);
  assert.match(page, /\/api\/projects/);
  assert.match(page, /Move notes to another project/);
  assert.match(page, /Delete the notes too/);
  assert.match(page, /Filter project notes by state/);
  assert.match(page, /archiveNoteState === "open"/);
  assert.match(page, /archiveState=\{view === "archived"/);
  assert.match(page, /performAction\(\[todo\.id\], "restore_archive"\)/);
  assert.match(page, /reproject/);
  assert.match(page, /<select[\s\S]*aria-label="Project"/);
  assert.match(page, /Create a new project…/);
  assert.match(page, /project created from task details/);
  assert.doesNotMatch(page, /<datalist/);
  assert.match(page, /overflow-x-hidden overflow-y-auto/);
  assert.match(page, /flex min-w-0 flex-wrap gap-2/);
  assert.doesNotMatch(page, /Edit the full task without leaving your place/);
  assert.match(database, /archived_project_backfill_v1/);
  assert.match(database, /CREATE TABLE IF NOT EXISTS todo_projects/);
  assert.match(schema, /todoProjects/);
  assert.match(database, /Choose or create a project before archiving/);
  assert.match(database, /action === "restore_archive"/);
  assert.match(database, /status IN \('archived', 'completed'\) AND project/);
  assert.match(bulkRoute, /"reproject"/);
  assert.match(bulkRoute, /"restore_archive"/);
  assert.match(projectsRoute, /export async function DELETE/);
  assert.match(projectsRoute, /deleteTodoProject/);
  assert.match(page, /title=\{label\}/);
  assert.match(page, /grid h-9 w-9 place-items-center/);
  assert.match(page, /<ActionIcon name="undo"/);
  assert.match(actionIcons, /Record<ActionIconName/);
  assert.match(actionIcons, /FolderPlus/);
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
  assert.match(packageJson, /lucide-react/);
  assert.doesNotMatch(combined, /react-loading-skeleton|codex-preview|Your site is taking shape|Starter Project/i);
});
