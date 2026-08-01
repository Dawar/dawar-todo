import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("task details owns focus, traps tabbing, and restores the originating task", async () => {
  const page = await readFile(new URL("app/page.tsx", root), "utf8");

  assert.match(page, /taskDialogReturnFocusRef/);
  assert.match(page, /dialog\.focus\(\{ preventScroll: true \}\)/);
  assert.match(page, /document\.addEventListener\("keydown", trapFocus, true\)/);
  assert.match(page, /event\.key !== "Tab"/);
  assert.match(page, /active === dialog \|\| active === first/);
  assert.match(page, /active === last/);
  assert.match(page, /task dialog focus restored/);
  assert.match(page, /\[data-task-row-id="\$\{fallbackTodoId\}"\] textarea\[data-inline-title\]/);
  assert.match(page, /role="dialog"[^]*aria-modal="true"[^]*aria-labelledby="task-details-title"/);
  assert.ok(page.includes('event.key === "?" && !typing && !overlayOpen'));
  assert.ok(page.includes('event.key === "/" && !typing && !overlayOpen'));
  assert.match(page, /event\.key\.toLowerCase\(\) === "n" && !typing && !overlayOpen/);

  const taskDialogMarkup = page.slice(page.indexOf("{editingTodo && editDraft && ("), page.indexOf("{voiceTarget && ("));
  assert.doesNotMatch(taskDialogMarkup, /<textarea[^>]*autoFocus/);
  assert.doesNotMatch(taskDialogMarkup, /<input[^>]*autoFocus/);
});
