import { env } from "cloudflare:workers";
import { createApiToken, listApiTokens } from "../../../db/api-tokens";
import { apiTokenSkill } from "../../../db/api-token-skill";
import { ensureTodoDatabase } from "../../../db/todos";

const USER_EMAIL_HEADER = "oai-authenticated-user-email";

function signedInEmail(request: Request) {
  return request.headers.get(USER_EMAIL_HEADER)?.trim() || null;
}

function chatGptOnly() {
  return Response.json(
    { error: "API tokens can only be managed after signing in with ChatGPT." },
    { status: 403, headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(request: Request) {
  const email = signedInEmail(request);
  if (!email) return chatGptOnly();
  const startedAt = Date.now();
  try {
    await ensureTodoDatabase();
    const apiTokens = await listApiTokens(env.DB);
    console.info("[todo-api] API tokens listed", { count: apiTokens.length, durationMs: Date.now() - startedAt });
    return Response.json({ apiTokens }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[todo-api] API token list failed", { durationMs: Date.now() - startedAt, error });
    return Response.json({ error: "Your API tokens could not be loaded." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const email = signedInEmail(request);
  if (!email) return chatGptOnly();
  const startedAt = Date.now();
  try {
    await ensureTodoDatabase();
    const payload = await request.json() as { name?: string; expiresInDays?: number | null };
    const expiresInDays = payload.expiresInDays == null ? null : Number(payload.expiresInDays);
    const result = await createApiToken(env.DB, {
      name: String(payload.name ?? ""),
      expiresInDays,
      createdByEmail: email,
    });
    console.info("[todo-api] API token generated", {
      tokenId: result.apiToken.id,
      expiresAt: result.apiToken.expiresAt,
      durationMs: Date.now() - startedAt,
    });
    return Response.json({ ...result, skill: apiTokenSkill(result.apiToken, result.token) }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The API token could not be generated.";
    const inputError = /required|limited|valid|active API tokens/i.test(message);
    console.error("[todo-api] API token generation failed", { durationMs: Date.now() - startedAt, error });
    return Response.json({ error: message }, { status: inputError ? 400 : 500 });
  }
}
