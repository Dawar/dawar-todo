import { botsOwner } from './bots-auth';
import { draftIdentity } from './bot-composer-draft';
export function draftScope(request: Request, environment: Cloudflare.Env) {
  const owner = botsOwner(request, environment), u = new URL(request.url);
  const botId = u.searchParams.get('botId');
  if (u.searchParams.get('owner') !== owner || !draftIdentity(botId)) throw Error('Invalid draft owner or bot.');
  return { owner, botId };
}
