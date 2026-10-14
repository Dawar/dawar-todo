import { env } from 'cloudflare:workers';
import { readPositionOwner } from '../../../../../lib/bot-read-position-api';
import { botSettingEvents } from '../../../../../lib/bot-settings-events';
export const dynamic = 'force-dynamic';
export function GET(request: Request) {
  try { const owner = readPositionOwner(request, env as Cloudflare.Env);
    return new Response(botSettingEvents('read-position', owner, '', request.signal), { headers: {
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'private, no-store, no-transform', 'X-Accel-Buffering': 'no',
    } });
  } catch { return Response.json({ error: 'Read sync unavailable.' }, { status: 403 }); }
}
