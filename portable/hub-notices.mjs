// A node's owner notice (BotRuntime.notify, e.g. a bot held past its budget)
// arrives as an ordinary durable node event. The hub stores it once in the
// application's bot notification outbox; the minute job delivers Web Push.
// Same row shape and limits as /api/bots/notifications on the legacy bridge.
export function isNodeNotice(event) { return event?.type === 'notice'; }

export async function acceptNodeNotice(application, owner, botId, data, now = new Date()) {
  if (typeof owner !== 'string' || !owner || typeof botId !== 'string' || !botId || botId.length > 180 ||
      !/^[a-f0-9]{64}$/.test(data?.id ?? '') || typeof data.title !== 'string' || !data.title || data.title.length > 160 ||
      typeof data.body !== 'string' || !data.body || data.body.length > 1000) return false;
  await application.prepare('INSERT OR IGNORE INTO todo_bot_notifications(id,owner_key,bot_id,title,body,created_at) VALUES(?,?,?,?,?,?)')
    .bind(data.id, owner.toLowerCase(), botId, data.title, data.body, now.toISOString()).run();
  return true;
}
