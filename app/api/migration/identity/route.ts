import { env } from 'cloudflare:workers';
import { migrationIdentityResponse } from '../../../../lib/migration-identity';

export async function GET(request: Request) {
  return migrationIdentityResponse(request, env as Cloudflare.Env);
}
