import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("settings exposes privacy-safe queue diagnostics and a crash fallback", async () => {
  const [settings, diagnostics, settingsError, page] = await Promise.all([
    readFile(new URL("app/settings/page.tsx", root), "utf8"),
    readFile(new URL("app/sync-diagnostics.ts", root), "utf8"),
    readFile(new URL("app/settings/error.tsx", root), "utf8"),
    readFile(new URL("app/page.tsx", root), "utf8"),
  ]);

  assert.match(settings, /Copy sync diagnostics/);
  assert.match(settings, /buildSyncDiagnosticsReport\("settings"\)/);
  assert.match(diagnostics, /listOfflineTodos/);
  assert.match(diagnostics, /listOfflineTodoMutations/);
  assert.match(diagnostics, /listOfflineTaskActions/);
  assert.match(diagnostics, /attempts/);
  assert.match(diagnostics, /retryInMs/);
  assert.match(diagnostics, /recentSyncEvents/);
  assert.match(diagnostics, /Task text, notes, task IDs, operation IDs/);
  assert.doesNotMatch(diagnostics, /todo\.title|todo\.notes|action\.body|mutation\.todoId|action\.operationId|todo\.clientId/);
  assert.match(page, /recordSyncDiagnostic\("sync-backed-off"/);
  assert.match(page, /recordSyncDiagnostic\("action-deferred"/);
  assert.match(page, /recordSyncDiagnostic\("sync-finished"/);
  assert.match(settingsError, /Copy diagnostics/);
  assert.match(settingsError, /buildSyncDiagnosticsReport\("settings-error"/);
});
