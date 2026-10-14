/** A read watermark is scoped to one owner, bot and foreground thread. It
 * records observed content, never a native input or delivery acknowledgement. */
export type BotReadPosition = { botId: string; threadId: string; at: string };
export const readIdentity = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,180}$/.test(value);
export function readAt(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)) return '';
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '';
  const normalized = new Date(time).toISOString();
  return normalized === value || normalized === value.replace(/Z$/, '.000Z') ? normalized : '';
}
export function newerReadAt(...values: unknown[]): string { return values.map(readAt).sort().at(-1) ?? ''; }
export function validReadPosition(value: unknown, now = Date.now()): value is BotReadPosition {
  const p = value as BotReadPosition | null;
  return Boolean(p && !Array.isArray(p) && Object.keys(p).every(k => ['botId', 'threadId', 'at'].includes(k)) &&
    readIdentity(p.botId) && readIdentity(p.threadId) && readAt(p.at) && Date.parse(p.at) <= now + 60_000);
}
