import { randomUUID } from "node:crypto";
import { normalizeCronExpression, nextCronOccurrence } from "../lib/cron.ts";

export function normalizeSchedule(
  input,
  botId,
  existing = null,
  now = new Date(),
) {
  const title = String(
    input.title ?? existing?.title ?? "Scheduled work",
  ).trim();
  const prompt = String(input.prompt ?? existing?.prompt ?? "").trim();
  if (!title || title.length > 160 || !prompt || prompt.length > 50000)
    throw new Error("Provide a title and a prompt under 50,000 characters.");
  const timeZone = String(input.timeZone ?? existing?.timeZone ?? "UTC");
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(now);
  } catch {
    throw new Error("Choose a valid timezone.");
  }
  const cron = normalizeCronExpression(
    input.cron === undefined ? existing?.cron : input.cron,
  );
  const atValue = input.at === undefined ? existing?.at : input.at;
  const at = atValue ? new Date(atValue) : null;
  if (Boolean(cron) === Boolean(at))
    throw new Error(
      "Choose either a one-time date or a recurring cron expression.",
    );
  if (
    at &&
    (!Number.isFinite(+at) ||
      (+at <= +now &&
        (!existing || input.at !== undefined || input.enabled === true)))
  )
    throw new Error("Choose a future time.");
  const enabled =
    input.enabled === undefined
      ? (existing?.enabled ?? true)
      : Boolean(input.enabled);
  const changed =
    !existing ||
    cron !== existing.cron ||
    (at?.toISOString() ?? null) !== existing.at ||
    timeZone !== existing.timeZone ||
    (!existing.enabled && enabled);
  const nextRunAt = enabled
    ? changed
      ? cron
        ? nextCronOccurrence(cron, now, timeZone)?.toISOString()
        : at?.toISOString()
      : existing.nextRunAt
    : null;
  if (enabled && !nextRunAt)
    throw new Error("This schedule has no upcoming occurrence.");
  return {
    id: existing?.id ?? randomUUID(),
    botId,
    title,
    prompt,
    cron,
    at: at?.toISOString() ?? null,
    timeZone,
    enabled,
    nextRunAt: nextRunAt ?? null,
    createdAt: existing?.createdAt ?? now.toISOString(),
  };
}
export function collectDueRuns(store, now = new Date()) {
  return store.transaction(() => {
    const created = [];
    for (const schedule of store.list("schedule")) {
      if (
        !schedule.enabled ||
        !schedule.nextRunAt ||
        schedule.nextRunAt > now.toISOString() ||
        store.bot(schedule.botId).archived
      )
        continue;
      const queued = store
        .list("run", schedule.botId)
        .some(
          (r) =>
            r.scheduleId === schedule.id &&
            ["queued", "starting", "running", "uncertain"].includes(r.status),
        );
      if (queued) continue;
      const id = `${schedule.id}:${schedule.nextRunAt}`;
      if (!store.get("run", id)) {
        const run = {
          id,
          botId: schedule.botId,
          scheduleId: schedule.id,
          title: schedule.title,
          prompt: schedule.prompt,
          status: "queued",
          scheduledAt: schedule.nextRunAt,
          startedAt: null,
          finishedAt: null,
          error: null,
        };
        store.put("run", run);
        created.push(run);
      }
      // Recompute from now, not the missed occurrence: one catch-up, no backlog burst.
      const next = schedule.cron
        ? nextCronOccurrence(
            schedule.cron,
            now,
            schedule.timeZone,
          )?.toISOString()
        : null;
      store.put("schedule", {
        ...schedule,
        nextRunAt: next ?? null,
        enabled: Boolean(next),
      });
    }
    return created;
  });
}
