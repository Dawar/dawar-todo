import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { renderTaskCalendar } from "../db/ical.ts";
import { appAccessResponse } from "../worker/access.ts";

const root = new URL("../", import.meta.url);

test("protects the app while leaving tokenized calendars public", () => {
  const blockedApi = appAccessResponse(new Request("https://work.dawar.ca/api/todos"));
  assert.equal(blockedApi?.status, 401);
  assert.equal(blockedApi?.headers.get("cache-control"), "no-store");

  const blockedPage = appAccessResponse(new Request("https://work.dawar.ca/settings"));
  assert.equal(blockedPage?.status, 303);
  assert.equal(blockedPage?.headers.get("location"), "https://work.dawar.ca/signin-with-chatgpt?return_to=%2Fsettings");

  const signedIn = appAccessResponse(new Request("https://work.dawar.ca/api/todos", {
    headers: { "oai-authenticated-user-email": "owner@example.com" },
  }));
  assert.equal(signedIn, null);
  assert.equal(appAccessResponse(new Request(`https://work.dawar.ca/calendar/${"a".repeat(43)}.ics`)), null);
  assert.equal(appAccessResponse(new Request("https://work.dawar.ca/assets/index.js")), null);
  assert.equal(appAccessResponse(new Request("http://localhost:3000/api/todos")), null);
});

test("renders dated tasks as escaped, folded all-day iCal events", () => {
  const calendar = renderTaskCalendar("Shared, Tasks", [
    {
      id: 42,
      title: "Call Alice, then review; contract \\ notes",
      notes: `First line\n${"A long multibyte detail 🔒 ".repeat(6)}`,
      status: "completed",
      priority: 2,
      dueDate: "2026-07-19",
      project: "Work, Legal",
      context: "@phone",
      createdAt: "2026-07-18T12:30:00.000Z",
      updatedAt: "2026-07-19T14:45:01.123Z",
    },
    {
      id: 99,
      title: "Invalid date is excluded",
      notes: "",
      status: "open",
      priority: 3,
      dueDate: "not-a-date",
      project: null,
      context: null,
      createdAt: "2026-07-18T12:30:00.000Z",
      updatedAt: "2026-07-19T14:45:01.123Z",
    },
  ], "work.dawar.ca");

  assert.match(calendar, /^BEGIN:VCALENDAR\r\nVERSION:2\.0\r\n/);
  assert.match(calendar, /X-WR-CALNAME:Shared\\, Tasks/);
  assert.match(calendar, /UID:todo-42@work\.dawar\.ca/);
  assert.match(calendar, /DTSTART;VALUE=DATE:20260719/);
  assert.match(calendar, /DTEND;VALUE=DATE:20260720/);
  assert.match(calendar, /SUMMARY:Call Alice\\, then review\\; contract \\\\ notes/);
  assert.match(calendar, /X-DAWAR-TODO-STATUS:COMPLETED/);
  assert.match(calendar, /CATEGORIES:Work\\, Legal/);
  assert.doesNotMatch(calendar, /todo-99/);
  assert.ok(calendar.endsWith("END:VCALENDAR\r\n"));
  for (const line of calendar.split("\r\n")) {
    assert.ok(new TextEncoder().encode(line).length <= 75, `line exceeds 75 octets: ${line}`);
  }
});

test("ships revocable calendar controls and copyable task details", async () => {
  const [settings, page, copy, icons, schema, database, feeds, feedRoute, publicRoute, worker, serviceWorker, migration] = await Promise.all([
    readFile(new URL("app/settings/page.tsx", root), "utf8"),
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/copy-to-clipboard.ts", root), "utf8"),
    readFile(new URL("app/action-icon.tsx", root), "utf8"),
    readFile(new URL("db/schema.ts", root), "utf8"),
    readFile(new URL("db/todos.ts", root), "utf8"),
    readFile(new URL("db/calendar-feeds.ts", root), "utf8"),
    readFile(new URL("app/api/calendar-feeds/route.ts", root), "utf8"),
    readFile(new URL("app/calendar/[token]/route.ts", root), "utf8"),
    readFile(new URL("worker/index.ts", root), "utf8"),
    readFile(new URL("public/sw.js", root), "utf8"),
    readFile(new URL("drizzle/0007_dazzling_shinobi_shaw.sql", root), "utf8"),
  ]);

  assert.match(settings, /Calendar sharing/);
  assert.match(settings, /Generate link/);
  assert.match(settings, />Regenerate</);
  assert.match(settings, />Revoke</);
  assert.match(settings, /copyTextToClipboard\(feed\.url\)/);
  assert.match(page, /Copy task title and notes/);
  assert.match(page, /copyTextToClipboard\(text\)/);
  assert.match(copy, /navigator\.clipboard\?\.writeText/);
  assert.match(copy, /document\.execCommand\("copy"\)/);
  assert.match(icons, /copy: Copy/);
  assert.match(schema, /todoCalendarFeeds/);
  assert.match(database, /CREATE TABLE IF NOT EXISTS todo_calendar_feeds/);
  assert.match(migration, /CREATE TABLE `todo_calendar_feeds`/);
  assert.match(feeds, /crypto\.getRandomValues\(new Uint8Array\(32\)\)/);
  assert.match(feeds, /CALENDAR_TOKEN_PATTERN = \/\^\[A-Za-z0-9_-\]\{43\}\$\//);
  assert.match(feeds, /WHERE revoked_at IS NULL/);
  assert.match(feeds, /WHERE due_date IS NOT NULL/);
  assert.match(feedRoute, /calendarFeedResponse/);
  assert.match(publicRoute, /text\/calendar; charset=utf-8/);
  assert.match(publicRoute, /"Cache-Control": "no-store"/);
  assert.match(publicRoute, /findCalendarFeedByToken/);
  assert.match(worker, /appAccessResponse\(request\)/);
  assert.match(serviceWorker, /url\.pathname\.startsWith\("\/calendar\/"\)/);
});
