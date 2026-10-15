import type { Bot, BotTeam } from '../../lib/bots-types';

export const ANNOUNCEMENT_TEXT_LIMIT = 200000;
export const ANNOUNCEMENT_RECIPIENT_LIMIT = 512;
export type AnnouncementRecipient = Pick<Bot, 'id' | 'name' | 'avatar' | 'threadId'> & {
  operationId: string; state: 'unsent' | 'unconfirmed' | 'queued' | 'accepted' | 'rejected';
  detail?: string; queueId?: string; turnId?: string;
};
export type AnnouncementIntent = { owner: string; id: string; text: string; createdAt: string; recipients: AnnouncementRecipient[] };
export type AnnouncementDraft = { owner: string; revision: number; version: string; text: string; selected: string[] | null; activeId: string | null };
export type AnnouncementRecord = { draft: AnnouncementDraft; intent: AnnouncementIntent | null };
export const announcementEligible = (bot: Bot) => !bot.archived && !bot.deletedAt;
export function announcementGroups(bots: Bot[], teams: BotTeam[]) {
  const known = new Set(teams.map(team => team.id));
  return [...teams.map(team => ({ id: team.id, name: team.name, bots: bots.filter(bot => bot.teamId === team.id && announcementEligible(bot)) })),
    { id: '', name: 'Unassigned', bots: bots.filter(bot => (!bot.teamId || !known.has(bot.teamId)) && announcementEligible(bot)) }].filter(group => group.bots.length);
}
/** Active bots matching the search. Archived bots have their own list and never match. */
export function searchSidebarBots(bots: Bot[], teams: BotTeam[], search: string) {
  const query = search.trim().toLocaleLowerCase(), names = new Map(teams.map(team => [team.id, team.name]));
  return bots.filter(bot => !bot.deletedAt && !bot.archived &&
    `${bot.name} ${bot.purpose} #${bot.extension ?? ''} ${names.get(bot.teamId ?? '') ?? ''}`.toLocaleLowerCase().includes(query));
}
export function freezeAnnouncement(owner: string, text: string, selected: string[], bots: Bot[], id: string): AnnouncementIntent {
  if (!owner || !text.trim() || text.length > ANNOUNCEMENT_TEXT_LIMIT) throw Error('Enter a message within the 200,000 character limit.');
  const ids = [...new Set(selected)];
  if (!ids.length || ids.length > ANNOUNCEMENT_RECIPIENT_LIMIT) throw Error('Choose between 1 and 512 recipients.');
  const recipients = ids.map((botId, index) => {
    const bot = bots.find(bot => bot.id === botId && announcementEligible(bot));
    if (!bot) throw Error('A selected bot changed or is unavailable. Review the recipients.');
    return { id: bot.id, name: bot.name, avatar: bot.avatar, threadId: bot.threadId,
      operationId: `announcement:${id}:${index}`, state: 'unsent' as const };
  });
  return { owner, id, text, createdAt: new Date().toISOString(), recipients };
}
export const announcementFinished = (intent: AnnouncementIntent) => intent.recipients.every(recipient => ['queued', 'accepted', 'rejected'].includes(recipient.state));
/** Existing queue.add receipt is request-bound. Completion of the bot's task is separate. */
export function announcementReceipt(result: unknown, recipient: AnnouncementRecipient, text: string): Partial<AnnouncementRecipient> | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const value = result as { consumedTurnId?: unknown; queuedSubmission?: { id?: unknown; clientUserMessageId?: unknown; input?: { type?: string; text?: string }[]; listId?: unknown; botId?: unknown } };
  if (typeof value.consumedTurnId === 'string' && value.consumedTurnId) return { state: 'accepted', turnId: value.consumedTurnId };
  const queue = value.queuedSubmission;
  if (!queue || typeof queue.id !== 'string' || !queue.id || queue.clientUserMessageId !== recipient.operationId ||
    queue.listId != null || queue.botId !== undefined && queue.botId !== recipient.id || !Array.isArray(queue.input) ||
    queue.input.length !== 1 || queue.input[0]?.type !== 'text' || queue.input[0].text !== text.trim()) return null;
  return { state: 'queued', queueId: queue.id };
}
