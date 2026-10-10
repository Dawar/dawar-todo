import { migrationIdentityResponse } from './migration-identity';
import { captureD1Application } from '../portable/d1-application-snapshot.mjs';
import { snapshotRecipient, sealApplicationSnapshot } from '../portable/snapshot-sealing.mjs';

type Environment = { BOTS_OWNER_EMAIL?:string; BOTS_OWNER_USER_ID?:string; DB:D1Database };
const headers = { 'Cache-Control':'private, no-store', 'Referrer-Policy':'no-referrer', 'X-Content-Type-Options':'nosniff' };

export async function applicationSnapshotResponse(request:Request,environment:Environment) {
  const authorized = migrationIdentityResponse(request,environment);
  if(authorized.status!==200)return authorized;
  const url = new URL(request.url);
  const fetchSite = request.headers.get('Sec-Fetch-Site');
  const referer = request.headers.get('Referer');
  let foreignReferer=false;
  if(referer) { try { foreignReferer=new URL(referer).origin!==url.origin; } catch { foreignReferer=true; } }
  if(request.headers.has('Authorization') || (fetchSite && !['none','same-origin'].includes(fetchSite)) ||
    foreignReferer)return Response.json({error:'Use the existing owner’s same-origin session.'},{status:403,headers});
  const recipient = url.searchParams.get('recipient');
  try {
    if(!recipient)throw Error('Recipient required.');
    await snapshotRecipient(recipient);
  } catch {
    return Response.json({error:'Supply the temporary migration recipient public key.'},{status:400,headers});
  }
  try {
    const result = await captureD1Application(environment.DB,AbortSignal.timeout(30000));
    const sealed = await sealApplicationSnapshot(result.snapshot,recipient!,url.origin);
    return Response.json(sealed,{headers:{...headers,'Content-Disposition':'attachment; filename="dawar-application.snapshot.sealed.json"'}});
  } catch {
    // No data or raw SQLite/provider diagnostics escape an incomplete capture.
    return Response.json({error:'A complete consistent application snapshot could not be captured. Original data is unchanged.'},{status:503,headers});
  }
}
