import { env } from "cloudflare:workers";
import { revokeApiToken } from "../../../../db/api-tokens";
import { ensureTodoDatabase } from "../../../../db/todos";

const USER_EMAIL_HEADER = "oai-authenticated-user-email";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  if (!request.headers.get(USER_EMAIL_HEADER)?.trim()) {
    return Response.json(
      { error: "API tokens can only be managed after signing in with ChatGPT." },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }
  const { id } = await context.params;
  const startedAt = Date.now();
  try {
    await ensureTodoDatabase();
    const revoked = await revokeApiToken(env.DB, id);
    if (!revoked) return Response.json({ error: "API token not found." }, { status: 404 });
    console.info("[todo-api] API token revoked", { tokenId: id, durationMs: Date.now() - startedAt });
    return Response.json({ id, revoked: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The API token could not be revoked.";
    console.error("[todo-api] API token revoke failed", { tokenId: id, durationMs: Date.now() - startedAt, error });
    return Response.json({ error: message }, { status: /invalid/i.test(message) ? 400 : 500 });
  }
}
