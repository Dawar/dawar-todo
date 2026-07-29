import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("task descriptions support secure Markdown preview and long transcripts", async () => {
  const [page, preview, description, todosApi, todoApi, talkTools, assistant] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/markdown-preview.tsx", root), "utf8"),
    readFile(new URL("lib/task-description.ts", root), "utf8"),
    readFile(new URL("app/api/todos/route.ts", root), "utf8"),
    readFile(new URL("app/api/todos/[id]/route.ts", root), "utf8"),
    readFile(new URL("lib/talk-tools.ts", root), "utf8"),
    readFile(new URL("lib/assistant-runtime.ts", root), "utf8"),
  ]);

  assert.match(page, />Description</);
  assert.match(page, /descriptionPreview/);
  assert.match(page, /<MarkdownPreview value=\{editDraft\.notes\}/);
  assert.match(page, /maxLength=\{MAX_TASK_DESCRIPTION_LENGTH\}/);
  assert.doesNotMatch(page, /maxLength=\{10000\}/);
  assert.match(preview, /react-markdown/);
  assert.match(preview, /remark-gfm/);
  assert.match(preview, /rehype-sanitize/);
  assert.match(preview, /safeMarkdownUrl/);
  assert.match(preview, /noreferrer noopener/);
  assert.match(description, /MAX_TASK_DESCRIPTION_LENGTH = 500_000/);
  assert.match(todosApi, /validateTaskDescription/);
  assert.match(todoApi, /validateTaskDescription/);
  assert.match(talkTools, /MAX_TASK_DESCRIPTION_LENGTH/);
  assert.match(assistant, /MAX_TASK_DESCRIPTION_LENGTH/);
});
