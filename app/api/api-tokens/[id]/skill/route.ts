import { env } from "cloudflare:workers";
import { apiTokenSkill } from "../../../../../db/api-token-skill";
import { recoverApiToken } from "../../../../../db/api-tokens";
import { ensureTodoDatabase } from "../../../../../db/todos";

const USER_EMAIL_HEADER = "oai-authenticated-user-email";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  if (!request.headers.get(USER_EMAIL_HEADER)?.trim()) {
    return Response.json(
      { error: "API token skills can only be copied after signing in with ChatGPT." },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }
  const { id } = await context.params;
  const startedAt = Date.now();
  try {
    await ensureTodoDatabase();
    const recovered = await recoverApiToken(env.DB, id, env.API_TOKEN_ENCRYPTION_KEY);
    if (!recovered) return Response.json({ error: "API token not found or expired." }, { status: 404 });
    const skill = apiTokenSkill(recovered.apiToken, recovered.token);
    console.info("[todo-api] API token skill generated", {
      tokenId: id,
      skillBytes: new TextEncoder().encode(skill).length,
      durationMs: Date.now() - startedAt,
    });
    return new Response(skill, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": 'attachment; filename="SKILL.md"',
        "Content-Type": "text/markdown; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The API skill could not be generated.";
    const status = /invalid/i.test(message) ? 400 : /predates|recover/i.test(message) ? 409 : 500;
    console.error("[todo-api] API token skill generation failed", { tokenId: id, durationMs: Date.now() - startedAt, error });
    return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
