/** Revision notifications only; clients still catch up through the durable delta log.
 * Each request owns its stream. No isolate-local pub/sub or cross-request I/O.
 */
export function revisionEventStream(input: {
  readRevision: () => Promise<number>; signal: AbortSignal; after: number;
  intervalMs?: number; lifetimeMs?: number;
}) {
  const encoder = new TextEncoder();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let release: (() => void) | undefined;
  const stop = () => { stopped = true; if (timer !== undefined) clearTimeout(timer); release?.(); input.signal.removeEventListener("abort", stop); };
  const pause = () => new Promise<void>((resolve) => { release = resolve; timer = setTimeout(resolve, input.intervalMs ?? 2_000); });
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      input.signal.addEventListener("abort", stop, { once: true });
      if (input.signal.aborted) stop();
      const startedAt = Date.now();
      let revision = input.after;
      let heartbeatAt = 0;
      try {
        while (!stopped && Date.now() - startedAt < (input.lifetimeMs ?? 55_000)) {
          const next = await input.readRevision();
          if (stopped) break;
          if (next !== revision) { controller.enqueue(encoder.encode(`event: revision\ndata: ${next}\n\n`)); revision = next; }
          if (Date.now() - heartbeatAt >= 15_000) { controller.enqueue(encoder.encode(`event: heartbeat\ndata: ${revision}\n\n`)); heartbeatAt = Date.now(); }
          await pause();
        }
        if (!stopped) { controller.enqueue(encoder.encode("event: reconnect\ndata: ready\n\n")); controller.close(); }
        else { try { controller.close(); } catch { /* already cancelled */ } }
      } catch (error) { if (!stopped) controller.error(error); }
      finally { stop(); }
    },
    cancel() { stop(); },
  });
}

export function syncEventsResponse(request: Request, database: D1Database) {
  const after = Number(new URL(request.url).searchParams.get("after") ?? 0);
  if (!Number.isSafeInteger(after) || after < 0) return Response.json({ error: "Invalid revision." }, { status: 400 });
  return new Response(revisionEventStream({
    signal: request.signal, after,
    readRevision: async () => Number((await database.prepare("SELECT revision FROM todo_sync_changes ORDER BY revision DESC LIMIT 1").first<{ revision: number }>())?.revision ?? 0),
  }), { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "private, no-store, no-transform", "X-Accel-Buffering": "no" } });
}
