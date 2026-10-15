import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("sync diagnostics stay privacy-safe and settings has a crash fallback", async () => {
  const [diagnostics, settingsError, page] = await Promise.all([
    readFile(new URL("app/sync-diagnostics.ts", root), "utf8"),
    readFile(new URL("app/settings/error.tsx", root), "utf8"),
    Promise.all(["app/page.tsx", "app/task-sync.ts", "app/task-model.ts", "app/sync-request.ts"].map((path) => readFile(new URL(path, root), "utf8"))).then((parts) => parts.join("\n")),
  ]);

  assert.match(diagnostics, /listOfflineTodos/);
  assert.match(diagnostics, /listOfflineTodoMutations/);
  assert.match(diagnostics, /listOfflineTaskActions/);
  assert.match(diagnostics, /attempts/);
  assert.match(diagnostics, /retryInMs/);
  assert.match(diagnostics, /recentSyncEvents/);
  assert.match(diagnostics, /Task text, notes, task IDs, operation IDs/);
  assert.doesNotMatch(diagnostics, /todo\.title|todo\.notes|action\.body(?!\.action)|mutation\.todoId|action\.operationId|todo\.clientId/);
  assert.match(page, /recordSyncDiagnostic\("sync-backed-off"/);
  assert.match(page, /recordSyncDiagnostic\("action-deferred"/);
  assert.match(page, /recordSyncDiagnostic\("sync-finished"/);
  // 8b25bc2 reduced the Settings crash fallback to the shared ScreenError retry surface.
  assert.match(settingsError, /<ScreenError title="Settings could not open" onRetry=\{reset\} \/>/);
});

test("settings and its crash fallback offer copyable sync diagnostics", { skip: "diagnostic copy controls deliberately removed from Settings and its error fallback; see 8609a85 and 8b25bc2" }, async () => {
  const [settings, settingsError] = await Promise.all([
    readFile(new URL("app/settings/page.tsx", root), "utf8"),
    readFile(new URL("app/settings/error.tsx", root), "utf8"),
  ]);

  assert.match(settings, /Copy sync diagnostics/);
  assert.match(settings, /buildSyncDiagnosticsReport\("settings"\)/);
  assert.match(settingsError, /Copy diagnostics/);
  assert.match(settingsError, /buildSyncDiagnosticsReport\("settings-error"/);
});
