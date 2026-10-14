import { env } from 'cloudflare:workers';
import { applicationSnapshotResponse } from '../../../../lib/application-snapshot-response';

export async function GET(request:Request) {
  return applicationSnapshotResponse(request,env as Cloudflare.Env);
}
