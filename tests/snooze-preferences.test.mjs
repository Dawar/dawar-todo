import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  DEFAULT_QUICK_SNOOZE_PRESETS,
  QUICK_SNOOZE_OPTIONS,
  parseQuickSnoozePresets,
  quickSnoozeDurationMs,
  sortQuickSnoozePresets,
} from "../lib/snooze-presets.ts";

const root = new URL("../", import.meta.url);

test("Quick Snooze choices cover useful durations and always normalize shortest-to-longest", () => {
  assert.equal(QUICK_SNOOZE_OPTIONS[0].minutes, 15);
  assert.equal(QUICK_SNOOZE_OPTIONS.at(-1).minutes, 180 * 24 * 60);
  assert.deepEqual(
    QUICK_SNOOZE_OPTIONS.slice(-5).map(({ value, label }) => ({ value, label })),
    [
      { value: "1w", label: "1 week" },
      { value: "2w", label: "2 weeks" },
      { value: "1mo", label: "1 month" },
      { value: "3mo", label: "3 months" },
      { value: "6mo", label: "6 months" },
    ],
  );
  assert.deepEqual(DEFAULT_QUICK_SNOOZE_PRESETS, ["15m", "30m", "1h", "2h"]);
  assert.deepEqual(sortQuickSnoozePresets(["12h", "45m", "4h", "90m"]), ["45m", "90m", "4h", "12h"]);
  assert.deepEqual(parseQuickSnoozePresets(["8h", "15m", "2h", "45m"]), ["15m", "45m", "2h", "8h"]);
  assert.equal(parseQuickSnoozePresets(["15m", "15m", "1h", "2h"]), null);
  assert.equal(parseQuickSnoozePresets(["15m", "30m", "1h"]), null);
  assert.equal(parseQuickSnoozePresets(["15m", "30m", "1h", "24h"]), null);
  assert.equal(quickSnoozeDurationMs("90m"), 90 * 60 * 1000);
  assert.equal(quickSnoozeDurationMs("12h"), 12 * 60 * 60 * 1000);
  assert.equal(quickSnoozeDurationMs("1w"), 7 * 24 * 60 * 60 * 1000);
  assert.equal(quickSnoozeDurationMs("6mo"), 180 * 24 * 60 * 60 * 1000);
});

test("persists Quick Snooze settings, emits live-sync revisions, and documents the contract", async () => {
  const [migration, databaseSource, settingsRoute, settingsPage, openApiText, skill] = await Promise.all([
    readFile(new URL("drizzle/0016_quick_snooze_preferences.sql", root), "utf8"),
    readFile(new URL("db/todos.ts", root), "utf8"),
    readFile(new URL("app/api/settings/route.ts", root), "utf8"),
    readFile(new URL("app/settings/page.tsx", root), "utf8"),
    readFile(new URL("public/openapi.json", root), "utf8"),
    readFile(new URL("db/api-token-skill.ts", root), "utf8"),
  ]);
  const openApi = JSON.parse(openApiText);
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE todo_sync_changes (
      revision INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_key TEXT NOT NULL,
      operation TEXT NOT NULL
    );
  `);
  for (const statement of migration.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) {
    database.exec(statement);
  }
  assert.equal(
    database.prepare("SELECT value FROM app_settings WHERE key = 'snooze_quick_presets'").get().value,
    '["15m","30m","1h","2h"]',
  );
  database.prepare("UPDATE app_settings SET value = ? WHERE key = 'snooze_quick_presets'")
    .run('["30m","1h","4h","12h"]');
  const changes = database.prepare("SELECT entity_type, entity_key FROM todo_sync_changes ORDER BY revision").all();
  assert.deepEqual(changes.map((row) => ({ ...row })), [
    { entity_type: "settings", entity_key: "snooze_quick_presets" },
    { entity_type: "settings", entity_key: "snooze_quick_presets" },
  ]);
  assert.equal(database.prepare("SELECT value FROM app_settings WHERE key = 'schema_version'").get().value, "16");

  assert.match(databaseSource, /snoozeQuickPresets/);
  assert.match(databaseSource, /JSON\.stringify\(settings\.snoozeQuickPresets\)/);
  assert.match(settingsRoute, /Choose four different Quick Snooze times/);
  assert.match(settingsPage, /Quick Snooze slot/);
  assert.equal(openApi.components.schemas.Settings.properties.snoozeQuickPresets.minItems, 4);
  assert.equal(openApi.components.schemas.Settings.properties.snoozeQuickPresets.maxItems, 4);
  assert.equal(openApi.components.schemas.Settings.properties.snoozeQuickPresets.uniqueItems, true);
  assert.deepEqual(
    openApi.components.schemas.Settings.properties.snoozeQuickPresets.items.enum.slice(-5),
    ["1w", "2w", "1mo", "3mo", "6mo"],
  );
  assert.match(skill, /snoozeQuickPresets/);
});
