import { env } from 'cloudflare:workers';
import { readPositionOwner } from '../../../../lib/bot-read-position-api';
import { validReadPosition } from '../../../../lib/bot-read-position';
import { readBotPositions, writeBotPosition } from '../../../../db/bot-read-positions';
import { notifyBotSetting } from '../../../../lib/bot-settings-events';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
export async function GET(request: Request) {
  try { const owner = readPositionOwner(request, env as Cloudflare.Env);
    return Response.json({ owner, positions: await readBotPositions(env.DB, owner) }, { headers });
  } catch { return Response.json({ error: 'Read sync unavailable.' }, { status: 403, headers }); }
}
export async function PATCH(request: Request) {
  let owner: string;
  try { owner = readPositionOwner(request, env as Cloudflare.Env); }
  catch { return Response.json({ error: 'Read sync unavailable.' }, { status: 403, headers }); }
  try {
    const reader = request.body?.getReader(); if (!reader) return Response.json({ error: 'Read position required.' }, { status: 400, headers });
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
      if (size > 1024) { await reader.cancel(); return Response.json({ error: 'Read position too large.' }, { status: 413, headers }); } chunks.push(part.value); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!validReadPosition(value)) return Response.json({ error: 'Invalid read position.' }, { status: 400, headers });
    const result = await writeBotPosition(env.DB, owner, value);
    if (result.changed) notifyBotSetting('read-position', owner);
    return Response.json({ owner, position: result.position }, { headers });
  } catch { return Response.json({ error: 'Read sync unavailable; local position is retained.' }, { status: 503, headers }); }
}
