import assert from "node:assert/strict";
import test from "node:test";
import { zonedDateTimeInputValue, zonedLocalDateTimeToUtc } from "../lib/zoned-date-time.ts";

test("converts custom snooze values using the configured timezone", () => {
  const utc = zonedLocalDateTimeToUtc("2026-07-22T13:30", "America/Toronto");
  assert.equal(utc.toISOString(), "2026-07-22T17:30:00.000Z");
  assert.equal(zonedDateTimeInputValue(utc, "America/Toronto"), "2026-07-22T13:30");
});

test("rejects invalid calendar values and daylight-saving gaps", () => {
  assert.throws(() => zonedLocalDateTimeToUtc("2026-02-30T12:00", "America/Toronto"), /valid date and time/);
  assert.throws(() => zonedLocalDateTimeToUtc("2026-03-08T02:30", "America/Toronto"), /daylight-saving/);
});
