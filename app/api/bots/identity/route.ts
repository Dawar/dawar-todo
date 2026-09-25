import { headers } from "next/headers";

// The Sites dispatcher supplies this Site-scoped ID after ChatGPT sign-in.
// This endpoint lets the owner enroll that stable ID without exposing tokens.
export async function GET() {
  const requestHeaders = await headers();
  const userId = requestHeaders.get("oai-authenticated-user-id");
  const email = requestHeaders.get("oai-authenticated-user-email");
  if (!userId || !email)
    return Response.json({ error: "Sign in with ChatGPT first." }, { status: 401 });
  return Response.json(
    { userId, email },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
