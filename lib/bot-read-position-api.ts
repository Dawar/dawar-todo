import { botsOwner } from './bots-auth';
export function readPositionOwner(request: Request, environment: Cloudflare.Env) {
  const owner = botsOwner(request, environment);
  if (new URL(request.url).searchParams.get('owner') !== owner) throw Error('Owner changed.');
  return owner;
}
