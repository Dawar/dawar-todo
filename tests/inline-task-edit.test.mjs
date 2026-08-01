import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("task titles are seamless autogrowing inline editors", async () => {
  const page = await readFile(new URL("app/page.tsx", root), "utf8");

  assert.match(page, /<textarea[^]*data-inline-title[^]*value=\{editingTitle \? titleDraft : todo\.title\}/);
  assert.match(page, /setTitleDraft\(event\.target\.value\)/);
  assert.match(page, /selected && !editingTitle/);
  assert.match(page, /textarea\.style\.height = "auto"/);
  assert.match(page, /textarea\.style\.height = `\$\{textarea\.scrollHeight\}px`/);
  assert.match(page, /resize-none overflow-hidden border-0 bg-transparent p-0/);
  assert.match(page, /onTitleChange\(todo, event\.target\.value\)/);
  assert.match(page, /onTitleBlur\(todo, event\.target\.value\)/);
  assert.match(page, /event\.currentTarget\.selectionStart === event\.currentTarget\.selectionEnd/);
  assert.match(page, /event\.key === "ArrowDown" && event\.currentTarget\.selectionEnd === event\.currentTarget\.value\.length/);
  assert.match(page, /event\.key === "ArrowUp" && event\.currentTarget\.selectionStart === 0/);
  assert.match(page, /onTitleArrowNavigate\(todo, direction\)/);
  assert.match(page, /const cursor = direction === "next" \? 0 : target\.value\.length/);
  assert.match(page, /target\.setSelectionRange\(cursor, cursor\)/);
  assert.match(page, /cursor moved to adjacent task/);
  assert.match(page, /window\.setTimeout\(\(\) => \{[^]*persistInlineTitle\(todo\.id, title, "debounce"\)[^]*\}, 700\)/);
  assert.match(page, /title committed to durable outbox/);
  assert.match(page, /empty title restored/);
});

test("row project action is replaced by Edit while assignment remains in details and bulk actions", async () => {
  const page = await readFile(new URL("app/page.tsx", root), "utf8");

  assert.match(page, /longSwipe \? "Delete" : "Edit"/);
  assert.match(page, /\{ action: "edit", label: "Edit", icon: "edit" \}/);
  assert.match(page, /else onEdit\(todo, "swipe"\)/);
  assert.match(page, /action === "edit" \? onEdit\(todo, "hover"\)/);
  assert.match(page, /openProjectAssignment\(\[editingTodo\.id\], "details"\)/);
  assert.match(page, /bulkAction\("assign"\)/);
});

test("task details edits description and metadata without a second title textarea", async () => {
  const page = await readFile(new URL("app/page.tsx", root), "utf8");
  const details = page.slice(page.indexOf("{editingTodo && editDraft && ("), page.indexOf("{voiceTarget && ("));

  assert.doesNotMatch(details, /value=\{editDraft\.title\}/);
  assert.match(details, /aria-label="Description"/);
  assert.match(details, /Assign project\. Current project:/);
});

test("sync cleanup preserves a newer edit queued while an older mutation is in flight", async () => {
  const [page, store] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/offline-store.ts", root), "utf8"),
  ]);

  assert.match(store, /current\?\.mutationId === expectedMutationId/);
  assert.match(store, /newerMutationPreserved: !removed/);
  assert.match(page, /deleteOfflineTodoMutation\(mutation\.todoId, mutation\.mutationId\)/);
  assert.match(page, /newerMutationPreserved: !removedQueuedMutation/);
  assert.match(page, /if \(JSON\.stringify\(nextDraft\) !== JSON\.stringify\(currentDraft\)\) setEditDraft\(nextDraft\)/);
  assert.match(page, /remote field deferred during active editing/);
});
