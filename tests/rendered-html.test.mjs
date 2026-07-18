import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("ships the complete todo product surface", async () => {
  const [page, layout, hosting] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/layout.tsx", root), "utf8"),
    readFile(new URL(".openai/hosting.json", root), "utf8"),
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
