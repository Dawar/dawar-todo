import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("ships the simplified todo and project surface", async () => {
  const [page, settingsPage, snoozePresets, layout, hosting, database, schema, todosRoute, todoRoute, bulkRoute, projectsRoute, actionIcons, siteHeader, pinMigration] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/settings/page.tsx", root), "utf8"),
    readFile(new URL("lib/snooze-presets.ts", root), "utf8"),
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
    readFile(new URL("drizzle/0011_brainy_sebastian_shaw.sql", root), "utf8"),
  ]);
  assert.match(layout, /title: "Dawar Todo"/);
  assert.match(layout, /\/og\.png/);
  assert.match(page, /Add a task/);
  assert.match(page, /Search tasks/);
  assert.match(page, /All projects/);
  assert.match(page, /Unassigned/);
  assert.doesNotMatch(page, /Smart sort|aria-label="Sort tasks"/);
  assert.match(page, /compareCanonicalOrder/);
  assert.match(page, /Snoozed/);
  assert.match(page, /type View = "open" \| "snoozed" \| "done" \| "all"/);
  assert.match(page, /open: "Open",\s+snoozed: "Snoozed",\s+done: "Done",\s+all: "All"/);
  assert.doesNotMatch(page, /projects: "Projects"/);
  assert.doesNotMatch(page, /inbox: "Inbox"|today: "Today"|archived: "Archived"|completed: "Done"/);
  assert.match(page, /useState<View>\("open"\)/);
  assert.match(page, /view === "done"\) return todo\.status === "completed"/);
  assert.match(page, /view === "all".*todo\.status === "open" \|\| todo\.status === "completed"/);
  assert.match(page, /&& \(!project \|\| \(project === UNASSIGNED_PROJECT \? !todo\.project : todo\.project === project\)\)/);
  assert.match(page, /Select visible/);
  assert.doesNotMatch(page, /Swipe left:|Swipe right:/);
  assert.match(page, /leftSecondaryAction.*snoozed/s);
  assert.match(page, /\? \{ action: "unsnooze", label: "Wake", icon: "wake" \}/);
  assert.match(page, /view === "snoozed".*bulkAction\("unsnooze"\)/s);
  assert.match(page, /wokeSnoozed/);
  assert.match(page, />Filters</);
  assert.match(page, /"Undoing…" : "Undo"/);
  assert.match(page, /\/api\/todos\/undo/);
  assert.match(page, /Task details/);
  assert.match(page, /Quick actions/);
  assert.doesNotMatch(page, />Save changes</);
  assert.match(page, /Saved automatically/);
  assert.match(page, /persistTaskDraft/);
  assert.match(page, /autosave: true/);
  assert.doesNotMatch(page, /<textarea\s+autoFocus\s+value=\{editDraft\.title\}/);
  assert.match(page, /task dialog pull-to-close triggered/);
  assert.match(page, /triggerDistance = 150/);
  assert.match(page, /Release to close/);
  assert.match(page, /ref=\{taskDialogScrollRef\}/);
  assert.match(page, /aria-label="Clear due date"/);
  assert.match(page, /updateEditDraftField\("dueDate", ""\)/);
  assert.match(page, /disabled:invisible/);
  assert.match(page, /\/api\/todos\/\$\{editingTodo\.id\}/);
  assert.match(page, /const pinnedOpenTodos = view === "open" \? filtered\.filter\(\(todo\) => todo\.pinned\) : \[\]/);
  assert.match(page, /const regularOpenTodos = view === "open" \? filtered\.filter\(\(todo\) => !todo\.pinned\) : filtered/);
  assert.match(page, />Pinned</);
  assert.match(page, /showPin=\{view === "open"\}/);
  assert.match(page, /view === "open" && <button/);
  assert.match(page, /onClick=\{\(\) => void togglePin\(editingTodo\)\}/);
  assert.match(page, /gap-1\.5 text-\[11px\] font-medium leading-4/);
  assert.match(page, /todo\.project && <span className="inline-flex min-h-\[22px\].*name="folder"/);
  assert.match(page, /todo\.context && <span className="inline-flex min-h-\[22px\].*bg-sky-50/);
  assert.match(page, /todo\.dueDate && <span className=\{classNames\("inline-flex min-h-\[22px\]/);
  assert.match(page, /todo\.recurrenceCron && <span className="inline-flex min-h-\[22px\].*bg-violet-50/);
  assert.match(page, /body: \{ pinned \}/);
  assert.match(page, /optimisticPatches: \{ \[String\(todo\.id\)\]: \{ pinned \} \}/);
  assert.match(page, /Task pinned\./);
  assert.match(page, /task pin committed locally/);
  assert.doesNotMatch(page, /title="Pinned"/);
  assert.match(page, /fixed inset-x-0 z-40/);
  assert.doesNotMatch(page, /sticky top-\[62px\]/);
  assert.match(page, /Assign project/);
  assert.match(page, /openedFromDetails/);
  assert.match(page, /setEditDraft\(\(current\) => current \? \{ \.\.\.current, project: projectName \?\? "" \}/);
  assert.match(page, /openProjectAssignment\(\[editingTodo\.id\], "details"\)/);
  assert.match(page, /project assignment committed locally/);
  assert.match(page, /Choose a project/);
  assert.match(page, /projectSelectorOpen/);
  assert.match(page, /projectLabel=\{project === UNASSIGNED_PROJECT \? "Unassigned" : project \|\| "Dawar Todo"\}/);
  assert.match(page, /onProjectClick=\{openProjectSelector\}/);
  assert.doesNotMatch(page, /aria-label="Filter by project"/);
  assert.match(page, /New project/);
  assert.match(page, /setProject\(""\);\s+setView\("open"\)/);
  assert.match(page, /await saveOfflineTodo\(\{[\s\S]*title,[\s\S]*status: "open",[\s\S]*project: captureProject \|\| null,[\s\S]*draftToken: captureDraftToken/);
  assert.match(page, /clientId: record\.clientId,[\s\S]*status: record\.status \?\? "open"[\s\S]*attachmentIds/);
  assert.match(page, /onAssignProject=\{openCaptureProjectAssignment\}/);
  assert.match(page, /quick add project staged/);
  assert.match(page, /captureDraft: true/);
  assert.match(page, /New task will be assigned to/);
  assert.match(page, /project: record\.project \?\? null/);
  assert.match(page, /\/api\/projects/);
  assert.match(page, /Move tasks to another project/);
  assert.match(page, /Delete the tasks too/);
  assert.match(page, /openProjectTasks/);
  assert.match(page, /setProject\(name\);\s+setView\(destinationView\)/);
  assert.match(page, /View open tasks in \$\{name\}/);
  assert.match(page, /View snoozed tasks in \$\{name\}/);
  assert.match(page, /View done tasks in \$\{name\}/);
  assert.match(page, /View all tasks in \$\{name\}/);
  assert.match(page, /grid grid-cols-5 border-t/);
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
  assert.match(database, /ALTER TABLE todos ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0/);
  assert.match(database, /todo-db] added pinned compatibility column/);
  assert.match(database, /pinned = excluded\.pinned/);
  assert.doesNotMatch(database, /action === "archive"|action === "restore_archive"/);
  assert.match(todosRoute, /New tasks must be open/);
  assert.doesNotMatch(todosRoute, /open or archived/);
  assert.match(todoRoute, /new Set\(\["open", "completed"\]\)/);
  assert.match(todoRoute, /typeof payload\.pinned !== "boolean"/);
  assert.match(todoRoute, /update\.pinned = payload\.pinned/);
  assert.match(bulkRoute, /"reproject"/);
  assert.match(bulkRoute, /"adjust_snooze"/);
  assert.match(bulkRoute, /isQuickSnoozePreset/);
  assert.match(snoozePresets, /15 minutes/);
  assert.match(snoozePresets, /45 minutes/);
  assert.match(snoozePresets, /12 hours/);
  assert.match(snoozePresets, /parseQuickSnoozePresets/);
  assert.match(page, /quickSnoozePresets\.map/);
  assert.match(page, /quickSnoozeLabel\(preset\)/);
  assert.match(settingsPage, /Quick Snooze buttons/);
  assert.match(settingsPage, /QUICK_SNOOZE_OPTIONS\.map/);
  assert.match(settingsPage, /sortQuickSnoozePresets/);
  assert.match(settingsPage, /Custom remains available/);
  assert.doesNotMatch(page, /8pm/);
  assert.match(page, />Custom/);
  assert.match(page, /type="datetime-local"/);
  assert.match(page, /zonedLocalDateTimeToUtc/);
  assert.match(bulkRoute, /snoozedLocal/);
  assert.match(page, /snoozeIds: action === "snooze" \? ids : undefined/);
  assert.match(database, /export async function adjustSnoozedTodos/);
  assert.match(database, /export async function adjustSnoozedTodosToLocalDateTime/);
  assert.match(database, /status = 'open' AND snoozed_until IS NOT NULL/);
  assert.match(database, /snooze adjusted/);
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
  assert.match(actionIcons, /PinOff/);
  assert.match(actionIcons, /pin: Pin/);
  assert.match(siteHeader, /label: "Settings", icon: "settings"/);
  assert.match(siteHeader, /<ActionIcon name=\{item\.icon\}/);
  assert.match(siteHeader, /aria-label="Primary"/);
  assert.match(siteHeader, /label: "Tasks"/);
  assert.match(siteHeader, /label: "Chat"/);
  assert.match(siteHeader, /label: "Settings"/);
  assert.match(siteHeader, /Choose project\. Current selection:/);
  assert.match(siteHeader, /projectLabel/);
  assert.doesNotMatch(actionIcons, /Archive|"archive"/);
  assert.doesNotMatch(page, /Capture what needs doing\. Then move/);
  assert.doesNotMatch(page, /Private · saved automatically|new task &nbsp;|<footer/);
  assert.match(hosting, /"d1": "DB"/);
  assert.match(schema, /pinned: integer\("pinned"/);
  assert.match(schema, /todos_pinned_idx/);
  assert.match(pinMigration, /ALTER TABLE `todos` ADD `pinned` integer DEFAULT false NOT NULL/);
  assert.match(pinMigration, /CREATE INDEX `todos_pinned_idx`/);
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

test("supports a deliberate mobile pull gesture that fully reloads the app", async () => {
  const [layout, pullToRefresh] = await Promise.all([
    readFile(new URL("app/layout.tsx", root), "utf8"),
    readFile(new URL("app/pull-to-refresh.tsx", root), "utf8"),
  ]);

  assert.match(layout, /<PullToRefresh \/>/);
  assert.match(layout, /className="overscroll-y-none"/);
  assert.match(pullToRefresh, /\(max-width: 767px\)/);
  assert.match(pullToRefresh, /\(pointer: coarse\)/);
  assert.match(pullToRefresh, /REFRESH_TRIGGER_DISTANCE = 160/);
  assert.match(pullToRefresh, /window\.scrollY <= 0/);
  assert.match(pullToRefresh, /Math\.abs\(deltaX\) >= deltaY/);
  assert.match(pullToRefresh, /addEventListener\("touchmove", onTouchMove, \{ passive: false \}\)/);
  assert.match(pullToRefresh, /event\.cancelable\) event\.preventDefault\(\)/);
  assert.match(pullToRefresh, /window\.location\.reload\(\)/);
  assert.match(pullToRefresh, /Pull to refresh/);
  assert.match(pullToRefresh, /Release to refresh/);
  assert.match(pullToRefresh, /Refreshing…/);
  assert.match(pullToRefresh, /\[todo-pwa\] pull refresh triggered/);
  assert.match(pullToRefresh, /\[role='dialog'\], input, textarea, select/);
  assert.match(pullToRefresh, /pointer-events-none fixed inset-x-0/);
});

test("animates task additions, removals, and moves inside the list stacking context", async () => {
  const [page, styles, packageJson] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/globals.css", root), "utf8"),
    readFile(new URL("package.json", root), "utf8"),
  ]);

  assert.match(page, /useAutoAnimate<HTMLUListElement>/);
  assert.match(page, /ref=\{taskListAnimationRef\}/);
  assert.match(packageJson, /@formkit\/auto-animate/);
  assert.doesNotMatch(page, /startViewTransition|viewTransitionName|flushSync/);
  assert.doesNotMatch(styles, /::view-transition|todo-motion-row/);
});

test("shows fully optimistic Undo and snooze controls while preserving concurrent Done", async () => {
  const page = await readFile(new URL("app/page.tsx", root), "utf8");

  assert.match(page, /taskPreview\?: string/);
  assert.match(page, /dismissAt\?: number/);
  assert.match(page, /local-first action applied/);
  assert.match(page, /setNotice\(\{[\s\S]*text: `\$\{optimisticLabel\}/);
  assert.match(page, /operationId\?: string/);
  assert.match(page, /pendingUndo\?: boolean/);
  assert.match(page, /undoRequested\?: boolean/);
  assert.match(page, /current\?\.operationId === operationId/);
  assert.match(page, /if \(action === "complete"\) ids\.forEach/);
  assert.match(page, /pendingCompletionIdsRef/);
  assert.match(page, /optimisticOperationsRef/);
  assert.match(page, /snoozeIds: action === "snooze" \? ids : undefined/);
  assert.match(page, /notice\.operationId \|\| notice\.undoToken/);
  assert.match(page, /requestNoticeUndo\(notice\)/);
  assert.match(page, /operation\.snoozeAdjustment = adjustment/);
  assert.match(page, /snooze adjustment chained behind optimistic action/);
  assert.doesNotMatch(page, /if \(notice\.pendingUndo\) return/);
  assert.match(page, /data-task-notice/);
  assert.doesNotMatch(page, /invisible inline-flex items-center/);
  assert.match(page, /const dismissAt = Date\.now\(\) \+ 1_500/);
  assert.match(page, /Math\.max\(0, notice\.dismissAt - Date\.now\(\)\)/);
  assert.match(page, /notice\.taskPreview && <p className="mt-0\.5 truncate text-xs text-white\/55"/);
  assert.ok(page.indexOf("notice.taskPreview &&") < page.indexOf("notice.snoozeIds &&"));
});

test("keeps fixed action surfaces above the iPhone standalone safe area", async () => {
  const [page, layout, styles] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/layout.tsx", root), "utf8"),
    readFile(new URL("app/globals.css", root), "utf8"),
  ]);
  assert.match(layout, /viewportFit:\s*"cover"/);
  assert.match(page, /data-bulk-actions/);
  assert.match(page, /bulk-actions-safe-bottom/);
  assert.match(page, /task-notice-safe-bottom/);
  assert.match(page, /data-bulk-actions-visible=\{selectedIds\.length > 0\}/);
  assert.match(styles, /--mobile-action-bottom:\s*max\(3rem, calc\(env\(safe-area-inset-bottom, 0px\) \+ 1\.5rem\)\)/);
  assert.match(styles, /--mobile-notice-above-actions:\s*max\(7\.75rem, calc\(env\(safe-area-inset-bottom, 0px\) \+ 6\.25rem\)\)/);
  assert.match(styles, /@media \(display-mode: standalone\) and \(max-width: 639px\)/);
  assert.match(styles, /--mobile-action-bottom:\s*max\(4rem, calc\(env\(safe-area-inset-bottom, 0px\) \+ 2rem\)\)/);
});

test("uses an edge-to-edge task list surface on mobile while preserving desktop gutters", async () => {
  const page = await readFile(new URL("app/page.tsx", root), "utf8");

  assert.match(page, /data-task-list-surface/);
  assert.match(page, /-mx-4 overflow-hidden border-y/);
  assert.match(page, /sm:mx-0 sm:rounded-2xl sm:border/);
});

test("moves between inline title editors at text boundaries without row keyboard highlighting", async () => {
  const [page, header, icons, shortcutGuide] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/site-header.tsx", root), "utf8"),
    readFile(new URL("app/action-icon.tsx", root), "utf8"),
    readFile(new URL("app/keyboard-shortcuts-dialog.tsx", root), "utf8"),
  ]);
  assert.doesNotMatch(page, /data-keyboard-task-id/);
  assert.doesNotMatch(page, /data-keyboard-action-index/);
  assert.doesNotMatch(page, /keyboardTodoId/);
  assert.doesNotMatch(page, /keyboardActionIndex/);
  assert.doesNotMatch(page, /keyboardFocused/);
  assert.doesNotMatch(page, /row action highlighted/);
  assert.doesNotMatch(page, /const numberedView =/);
  assert.match(page, /event\.key === "ArrowDown" && event\.currentTarget\.selectionEnd === event\.currentTarget\.value\.length/);
  assert.match(page, /event\.key === "ArrowUp" && event\.currentTarget\.selectionStart === 0/);
  assert.match(page, /onTitleArrowNavigate\(todo, direction\)/);
  assert.match(page, /target\.focus\(\{ preventScroll: true \}\)/);
  assert.match(page, /target\.setSelectionRange\(cursor, cursor\)/);
  assert.match(page, /const undoShortcut = \(event\.metaKey \|\| event\.ctrlKey\)/);
  assert.match(page, /requestNoticeUndo\(notice\)/);
  assert.match(shortcutGuide, /keys: \["⌘\/Ctrl", "Z"\], label: "Undo last task action"/);
  assert.match(shortcutGuide, /keys: \["↑"\], label: "At text start: previous task"/);
  assert.match(shortcutGuide, /keys: \["↓"\], label: "At text end: next task"/);
  assert.doesNotMatch(shortcutGuide, /Navigate tasks/);
  assert.doesNotMatch(shortcutGuide, /Act on focused task/);
  assert.match(shortcutGuide, /function KeyboardShortcutsDialog/);
  assert.match(shortcutGuide, /aria-labelledby="keyboard-shortcuts-title"/);
  assert.match(header, /onKeyboardHelp/);
  assert.match(header, /Keyboard shortcuts \(\?\)/);
  assert.match(icons, /keyboard:\s*Keyboard/);
});
