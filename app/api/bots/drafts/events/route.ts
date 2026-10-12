import { env } from 'cloudflare:workers';
import { draftScope } from '../../../../../lib/bot-composer-draft-api';
import { composerDraftEvents } from '../../../../../lib/bot-composer-draft-events';
export const dynamic = 'force-dynamic';
export function GET(request: Request) {
  try { const { owner, botId } = draftScope(request, env as Cloudflare.Env);
    return new Response(composerDraftEvents(owner, botId, request.signal), { headers: {
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'private, no-store, no-transform', 'X-Accel-Buffering': 'no',
    } });
  } catch { return Response.json({ error: 'Draft sync unavailable.' }, { status: 403 }); }
}
