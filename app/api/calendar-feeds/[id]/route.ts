import { regenerateCalendarFeed, revokeCalendarFeed } from "../../../../db/calendar-feeds";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const startedAt = Date.now();
  try {
    const feed = await regenerateCalendarFeed(id);
    if (!feed) return Response.json({ error: "Calendar link not found." }, { status: 404 });
    console.info("[todo-api] calendar feed regenerated", { id, durationMs: Date.now() - startedAt });
    return Response.json({
      feed: {
        id: feed.id,
        name: feed.name,
        url: new URL(feed.path, request.url).toString(),
        createdAt: feed.createdAt,
        updatedAt: feed.updatedAt,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The calendar link could not be regenerated.";
    console.error("[todo-api] calendar feed regenerate failed", { id, durationMs: Date.now() - startedAt, error });
    return Response.json({ error: message }, { status: /invalid/i.test(message) ? 400 : 500 });
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const startedAt = Date.now();
  try {
    const revoked = await revokeCalendarFeed(id);
    if (!revoked) return Response.json({ error: "Calendar link not found." }, { status: 404 });
    console.info("[todo-api] calendar feed revoked", { id, durationMs: Date.now() - startedAt });
    return Response.json({ id, revoked: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The calendar link could not be revoked.";
    console.error("[todo-api] calendar feed revoke failed", { id, durationMs: Date.now() - startedAt, error });
    return Response.json({ error: message }, { status: /invalid/i.test(message) ? 400 : 500 });
  }
}
