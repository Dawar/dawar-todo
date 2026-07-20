import assert from "node:assert/strict";
import test from "node:test";
import { dueDateSortValue, formatDueDate, isDueTodayOrOverdue, localDateOnly } from "../app/date-only.ts";

test("treats due dates as local calendar dates instead of UTC timestamps", () => {
  const monday = new Date(2026, 6, 20, 12);
  const tuesday = new Date(2026, 6, 21, 12);
  const wednesday = new Date(2026, 6, 22, 12);

  const parsed = localDateOnly("2026-07-22");
  assert.ok(parsed);
  assert.equal(parsed.getFullYear(), 2026);
  assert.equal(parsed.getMonth(), 6);
  assert.equal(parsed.getDate(), 22);
  assert.equal(formatDueDate("2026-07-22", monday, "en-CA"), "Due Jul 22");
  assert.equal(formatDueDate("2026-07-22", tuesday, "en-CA"), "Due tomorrow");
  assert.equal(formatDueDate("2026-07-22", wednesday, "en-CA"), "Due today");
  assert.equal(isDueTodayOrOverdue("2026-07-22", tuesday), false);
  assert.equal(isDueTodayOrOverdue("2026-07-22", wednesday), true);
});

test("sorts valid date-only values and sends missing or invalid dates to the end", () => {
  assert.ok(dueDateSortValue("2026-07-21") < dueDateSortValue("2026-07-22"));
  assert.equal(dueDateSortValue(null), Number.POSITIVE_INFINITY);
  assert.equal(dueDateSortValue("not-a-date"), Number.POSITIVE_INFINITY);
  assert.equal(localDateOnly("2026-02-30"), null);
});
