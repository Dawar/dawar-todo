import { createCalendarFeed, listCalendarFeeds, type CalendarFeed } from "../../../db/calendar-feeds";

function calendarFeedResponse(request: Request, feed: CalendarFeed) {
  return {
    id: feed.id,
    name: feed.name,
    url: new URL(feed.path, request.url).toString(),
    createdAt: feed.createdAt,
    updatedAt: feed.updatedAt,
  };
}

export async function GET(request: Request) {
  const startedAt = Date.now();
  try {
    const feeds = await listCalendarFeeds();
    console.info("[todo-api] calendar feeds listed", { count: feeds.length, durationMs: Date.now() - startedAt });
    return Response.json({ feeds: feeds.map((feed) => calendarFeedResponse(request, feed)) });
  } catch (error) {
    console.error("[todo-api] calendar feeds list failed", { durationMs: Date.now() - startedAt, error });
    return Response.json({ error: "Calendar links could not be loaded." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  try {
    const payload = (await request.json()) as { name?: string };
    const feed = await createCalendarFeed(String(payload.name ?? ""));
    console.info("[todo-api] calendar feed created", { id: feed.id, durationMs: Date.now() - startedAt });
    return Response.json({ feed: calendarFeedResponse(request, feed) }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The calendar link could not be created.";
    console.error("[todo-api] calendar feed create failed", { durationMs: Date.now() - startedAt, error });
    return Response.json({ error: message }, { status: /required|limited|up to/i.test(message) ? 400 : 500 });
  }
}
