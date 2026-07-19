import { findCalendarFeedByToken, listDatedCalendarTodos } from "../../../db/calendar-feeds";
import { renderTaskCalendar } from "../../../db/ical";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ token: string }> },
) {
  const startedAt = Date.now();
  const { token: tokenFile } = await context.params;
  const token = tokenFile.endsWith(".ics") ? tokenFile.slice(0, -4) : "";
  try {
    const feed = await findCalendarFeedByToken(token);
    if (!feed) {
      console.info("[todo-calendar] public feed rejected", { reason: "missing-or-revoked", durationMs: Date.now() - startedAt });
      return new Response("Calendar not found.\n", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
    }
    const todos = await listDatedCalendarTodos();
    const host = new URL(request.url).hostname;
    const calendar = renderTaskCalendar(feed.name, todos, host);
    console.info("[todo-calendar] public feed rendered", {
      feedId: feed.id,
      eventCount: todos.length,
      bytes: new TextEncoder().encode(calendar).length,
      durationMs: Date.now() - startedAt,
    });
    return new Response(calendar, {
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": `inline; filename="dawar-todo.ics"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    console.error("[todo-calendar] public feed render failed", { durationMs: Date.now() - startedAt, error });
    return new Response("Calendar could not be generated.\n", { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  }
}
