import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("ships the simplified todo and project surface", async () => {
  const [page, layout, hosting, database, schema, todosRoute, todoRoute, bulkRoute, projectsRoute, actionIcons, siteHeader] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/layout.tsx", root), "utf8"),
    readFile(new URL(".openai/hosting.json", root), "utf8"),
    readFile(new URL("db/todos.ts", root), "utf8"),
    readFile(new URL("db/schema.ts", root), "utf8"),
    readFile(new URL("app/api/todos/route.ts", root), "utf8"),
    readFile(new URL("app/api/todos/[id]/route.ts", root), "utf8"),
    readFile(new URL("app/api/todos/bulk/route.ts", root), "utf8"),
    readFile(new URL("app/api/projects/route.ts", root), "utf8"),
    readFile(new URL("app/action-icon.tsx", root), "utf8"),
    readFile(new URL("app/site-header.tsx", root), "utf8"),
  ]);
  assert.match(layout, /title: "Dawar Todo"/);
  assert.match(layout, /\/og\.png/);
  assert.match(page, /Add a task/);
  assert.match(page, /Search tasks/);
  assert.match(page, /All projects/);
  assert.match(page, /Unassigned/);
  assert.match(page, /Smart sort/);
  assert.match(page, /Snoozed/);
  assert.match(page, /type View = "open" \| "snoozed" \| "all" \| "projects"/);
  assert.match(page, /open: "Open",\s+snoozed: "Snoozed",\s+all: "All",\s+projects: "Projects"/);
  assert.doesNotMatch(page, /inbox: "Inbox"|today: "Today"|archived: "Archived"|completed: "Done"/);
  assert.match(page, /useState<View>\("open"\)/);
  assert.match(page, /view === "all".*todo\.status === "open" \|\| todo\.status === "completed"/);
  assert.match(page, /projectFilterApplies = view === "open" \|\| view === "snoozed" \|\| view === "all"/);
  assert.match(page, /Select visible/);
  assert.match(page, /Swipe left: done\/open.*Swipe right: assign project \/ delete/);
  assert.match(page, /leftSecondaryAction.*snoozed/s);
  assert.match(page, /\? \{ action: "unsnooze", label: "Wake", icon: "wake" \}/);
  assert.match(page, /view === "snoozed".*bulkAction\("unsnooze"\)/s);
  assert.match(page, /wokeSnoozed/);
  assert.match(page, />Filters</);
  assert.match(page, /"Undoing…" : "Undo"/);
  assert.match(page, /\/api\/todos\/undo/);
  assert.match(page, /Task details/);
  assert.match(page, /Quick actions/);
  assert.match(page, /Save changes/);
  assert.match(page, /aria-label="Clear due date"/);
  assert.match(page, /dueDate: ""/);
  assert.match(page, /disabled:invisible/);
  assert.match(page, /\/api\/todos\/\$\{editingTodo\.id\}/);
  assert.match(page, /fixed inset-x-0 z-40/);
  assert.doesNotMatch(page, /sticky top-\[62px\]/);
  assert.match(page, /Assign project/);
  assert.match(page, /openedFromDetails/);
  assert.match(page, /setEditDraft\(\(current\) => current \? \{ \.\.\.current, project: projectName \?\? "" \}/);
  assert.match(page, /openProjectAssignment\(\[editingTodo\.id\], "details"\)/);
  assert.match(page, /preservedTaskState/);
  assert.match(page, />Projects</);
  assert.match(page, /New project/);
  assert.match(page, /setProject\(""\);\s+setView\("open"\)/);
  assert.match(page, /body: JSON\.stringify\(\{[\s\S]*title,[\s\S]*status: "open",[\s\S]*project: null,[\s\S]*draftToken:[\s\S]*attachmentIds:/);
  assert.match(page, /\/api\/projects/);
  assert.match(page, /Move tasks to another project/);
  assert.match(page, /Delete the tasks too/);
  assert.match(page, /openProjectTasks/);
  assert.match(page, /setProject\(name\);\s+setView\(destinationView\)/);
  assert.match(page, /View open tasks in \$\{name\}/);
  assert.match(page, /View snoozed tasks in \$\{name\}/);
  assert.match(page, /View all tasks in \$\{name\}/);
  assert.doesNotMatch(page, /archiveProject|archiveNoteState|restore_archive/);
  assert.match(page, /reproject/);
  assert.match(page, /aria-label=\{`Assign project\. Current project:/);
  assert.match(page, /Create a new project…/);
  assert.doesNotMatch(page, /<datalist/);
  assert.match(page, /overflow-x-hidden overflow-y-auto/);
  assert.match(page, /flex min-w-0 flex-wrap gap-2/);
  assert.doesNotMatch(page, /Edit the full task without leaving your place/);
  assert.match(database, /archive_status_to_open_v1/);
  assert.match(database, /legacy archives converted to open tasks/);
  assert.match(database, /SET status = 'open',[\s\S]*WHERE status = 'archived'/);
  assert.match(database, /CREATE TABLE IF NOT EXISTS todo_projects/);
  assert.match(schema, /todoProjects/);
  assert.match(database, /SELECT DISTINCT trim\(project\)[\s\S]*WHERE project IS NOT NULL/);
  assert.match(database, /SELECT \* FROM todos WHERE project = \? ORDER BY id/);
  assert.match(database, /DELETE FROM todos WHERE id IN/);
  assert.match(database, /normalizedLegacyArchives/);
  assert.doesNotMatch(database, /action === "archive"|action === "restore_archive"/);
  assert.match(todosRoute, /New tasks must be open/);
  assert.doesNotMatch(todosRoute, /open or archived/);
  assert.match(todoRoute, /new Set\(\["open", "completed"\]\)/);
  assert.match(bulkRoute, /"reproject"/);
  assert.doesNotMatch(bulkRoute, /"archive"|"restore_archive"/);
  assert.match(projectsRoute, /export async function DELETE/);
  assert.match(projectsRoute, /deleteTodoProject/);
  assert.match(page, /title=\{label\}/);
  assert.match(page, /grid h-9 w-9 place-items-center/);
  assert.match(page, /<ActionIcon name="undo"/);
  assert.match(actionIcons, /Record<ActionIconName/);
  assert.match(actionIcons, /FolderPlus/);
  assert.match(actionIcons, /Settings2/);
  assert.match(actionIcons, /ListTodo/);
  assert.match(siteHeader, /aria-label="Settings"/);
  assert.match(siteHeader, /<ActionIcon name="settings"/);
  assert.doesNotMatch(actionIcons, /Archive|"archive"/);
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
