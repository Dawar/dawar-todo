import { env } from 'cloudflare:workers';
import { draftScope } from '../../../../lib/bot-composer-draft-api';
import { validDraftMutation } from '../../../../lib/bot-composer-draft';
import { readComposerDraft, writeComposerDraft } from '../../../../db/bot-composer-drafts';
import { notifyComposerDraft } from '../../../../lib/bot-composer-draft-events';
const headers = { 'Cache-Control': 'private, no-store' };
export async function GET(request: Request) {
  try { const { owner, botId } = draftScope(request, env as Cloudflare.Env); return Response.json({ owner, botId, draft: await readComposerDraft(env.DB, owner, botId) }, { headers }); }
  catch { return Response.json({ error: 'Draft sync unavailable.' }, { status: 403, headers }); }
}
export async function PATCH(request: Request) {
  try {
    const { owner, botId } = draftScope(request, env as Cloudflare.Env);
    const reader = request.body?.getReader(); if (!reader) return Response.json({ error: 'Draft required.' }, { status: 400, headers });
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
      if (size > 1_000_000) { await reader.cancel(); return Response.json({ error: 'Draft too large.' }, { status: 413, headers }); } chunks.push(part.value); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!validDraftMutation(value, botId)) return Response.json({ error: 'Invalid draft.' }, { status: 400, headers });
    const result = await writeComposerDraft(env.DB, owner, botId, value);
    if (result.applied) notifyComposerDraft(owner, botId);
    return Response.json({ owner, botId, ...result }, { headers });
  } catch { return Response.json({ error: 'Draft sync unavailable; local text is retained.' }, { status: 503, headers }); }
}
