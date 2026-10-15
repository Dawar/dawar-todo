import { env } from 'cloudflare:workers';
import { botsOwner } from '../../../../lib/bots-auth';
import { validChapterMutation } from '../../../../lib/bot-chapters';
import { readChapters, writeChapter } from '../../../../db/bot-chapters';
import { ensureTodoDatabase } from '../../../../db/todos';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
const identity = (value: string | null): value is string => Boolean(value && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value));
function ownerFor(request: Request) {
  const owner = botsOwner(request, env as Cloudflare.Env);
  // Captured-owner fence only; authentication and scope come from botsOwner.
  if (request.headers.get('X-Dawar-Preference-Owner') !== owner) throw Error('Owner changed. Reopen the conversation.');
  return owner;
}
export async function GET(request: Request) {
  try {
    const owner = ownerFor(request), url = new URL(request.url);
    const botId = url.searchParams.get('botId'), threadId = url.searchParams.get('threadId');
    if (!identity(botId) || !identity(threadId)) return Response.json({ error: 'Choose a conversation.' }, { status: 400, headers });
    await ensureTodoDatabase();
    return Response.json({ version: 1, owner, botId, threadId, chapters: await readChapters(env.DB, owner, { botId, threadId }) }, { headers });
  } catch (error) { return failure(error); }
}
export async function PATCH(request: Request) {
  try {
    const owner = ownerFor(request);
    const reader = request.body?.getReader(); let text = '', size = 0;
    if (!reader) return Response.json({ error: 'Send one chapter change.' }, { status: 400, headers });
    const decoder = new TextDecoder();
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > 4096) { await reader.cancel(); return Response.json({ error: 'Send one chapter change.' }, { status: 413, headers }); }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    const value: unknown = JSON.parse(text);
    if (!validChapterMutation(value)) return Response.json({ error: 'Send a valid chapter change.' }, { status: 400, headers });
    await ensureTodoDatabase();
    return Response.json({ version: 1, owner, chapter: await writeChapter(env.DB, owner, value) }, { headers });
  } catch (error) { return failure(error); }
}
function failure(error: unknown) {
  if (error instanceof SyntaxError) return Response.json({ error: 'Send a valid chapter change.' }, { status: 400, headers });
  const message = error instanceof Error ? error.message : '';
  if (/already has \d+ chapters/.test(message)) return Response.json({ error: message }, { status: 409, headers });
  const forbidden = /owner|origin|signed-in/i.test(message);
  return Response.json({ error: forbidden ? 'Reopen the conversation with the signed-in owner.' : 'Chapters could not be saved. Your change is kept on this device.' }, { status: forbidden ? 403 : 503, headers });
}
