// Finding another bot to message by a general reference: a name ("Claudia"),
// a full display name, a slug, or the sidebar extension ("#21"). Pure: the
// caller supplies the owner's current bots and gets one bot or a clear error.

const usable = (bot) => bot && !bot.archived && !bot.archiving && !bot.deletedAt && bot.threadId;
const norm = (value) => String(value ?? '').normalize('NFKC').toLowerCase().replace(/^@+/, '').replace(/[\s_-]+/g, ' ').trim();
/** "Claudia: Lead Developer DawarTodo" → "claudia". */
const shortName = (name) => norm(String(name ?? '').split(':')[0]);
const label = (bot) => `${bot.name}${bot.extension ? ` (#${bot.extension})` : ''}`;
const fail = (message) => Object.assign(Error(message), { outcome: 'rejected' });

/** The bots a sender can message: active, provisioned, not itself. */
export function messageDirectory(bots, senderId) {
  return bots.filter((bot) => usable(bot) && bot.id !== senderId)
    .map((bot) => ({ id: bot.id, name: bot.name, ...(bot.extension ? { extension: bot.extension } : {}), ...(bot.teamId ? { teamId: bot.teamId } : {}) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Resolve a reference to exactly one bot. Tiers run from most to least
 * specific and the first tier with any match decides; several matches in
 * that tier are refused rather than guessed.
 */
export function resolveRecipient(bots, reference, senderId) {
  const raw = typeof reference === 'string' ? reference.trim() : '';
  if (!raw || raw.length > 160 || /[\x00-\x1f\x7f]/.test(raw)) throw fail('Name the recipient bot, for example "Claudia" or "#21".');
  const candidates = bots.filter((bot) => usable(bot) && bot.id !== senderId);
  const ref = norm(raw), extension = /^#?(\d{1,6})$/.exec(raw)?.[1];
  const tiers = [
    (bot) => bot.id === raw,
    (bot) => extension !== undefined && String(bot.extension ?? '') === extension,
    (bot) => norm(bot.name) === ref || norm(bot.slug) === ref,
    (bot) => shortName(bot.name) === ref,
    (bot) => ref.length >= 2 && (shortName(bot.name).startsWith(ref) || norm(bot.name).split(' ').includes(ref) || norm(bot.slug).startsWith(ref)),
  ];
  for (const tier of tiers) {
    const matches = candidates.filter(tier);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1)
      throw fail(`"${raw}" matches several bots: ${matches.slice(0, 8).map(label).join(', ')}. Use a fuller name or the #extension.`);
  }
  if (bots.some((bot) => bot.id === senderId && (bot.id === raw || norm(bot.name) === ref || shortName(bot.name) === ref)))
    throw fail('That is this bot; message another bot.');
  throw fail(`No active bot matches "${raw}". Call bots_message with operation "directory" to list the bots you can message.`);
}
