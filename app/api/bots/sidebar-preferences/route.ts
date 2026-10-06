import { env } from 'cloudflare:workers';
import { botsOwner } from '../../../../lib/bots-auth';
import { sidebarMutation } from '../../../../lib/bot-sidebar-preferences';
import { readSidebarChoices, writeSidebarChoice } from '../../../../db/bot-sidebar-preferences';
import { ensureTodoDatabase } from '../../../../db/todos';
const headers = { 'Cache-Control': 'private, no-store' };
function ownerFor(request: Request) {
  const owner = botsOwner(request, env as Cloudflare.Env);
  // This is a captured-owner fence, never the source of authentication/scope.
  if (request.headers.get('X-Dawar-Preference-Owner') !== owner) throw Error('Owner changed. Reopen the bot list.');
  return owner;
}
export async function GET(request: Request) {
  try {
    const owner = ownerFor(request); await ensureTodoDatabase();
    return Response.json({ version: 1, owner, choices: await readSidebarChoices(env.DB, owner) }, { headers });
  } catch (error) { return failure(error); }
}
export async function PATCH(request: Request) {
  try {
    const owner = ownerFor(request);
    const reader = request.body?.getReader(); let text = '', size = 0;
    if (!reader) return Response.json({ error: 'Send one team choice.' }, { status: 400, headers });
    const decoder = new TextDecoder();
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > 2048) { await reader.cancel(); return Response.json({ error: 'Send one team choice.' }, { status: 400, headers }); }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    const value: unknown = JSON.parse(text);
    if (!sidebarMutation(value)) return Response.json({ error: 'Send a valid team choice and its original operation.' }, { status: 400, headers });
    await ensureTodoDatabase();
    return Response.json({ version: 1, owner, ...await writeSidebarChoice(env.DB, owner, value) }, { headers });
  } catch (error) { return failure(error); }
}
function failure(error: unknown) {
  if (error instanceof SyntaxError) return Response.json({ error: 'Send a valid team choice.' }, { status: 400, headers });
  const message = error instanceof Error ? error.message : 'Team choices could not be saved. Retry.';
  const forbidden = /owner|origin|signed-in/i.test(message);
  return Response.json({ error: forbidden ? 'Reopen the bot list with the signed-in owner.' : 'Team choices could not be saved. Retry the same choice.' }, { status: forbidden ? 403 : 503, headers });
}
