import { apiTokenFromAuthorization, authenticateApiToken, recordApiTokenUse } from "../db/api-tokens.ts";

const AUTHENTICATED_USER_HEADER = "oai-authenticated-user-email";

type AccessEnvironment = { DB: D1Database };
type AccessContext = { waitUntil(promise: Promise<unknown>): void };

function isLocalHost(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function isPublicStaticPath(pathname: string) {
  return pathname.startsWith("/assets/")
    || pathname.startsWith("/icons/")
    || pathname.startsWith("/_next/")
    || pathname === "/_vinext/image"
    || pathname === "/manifest.webmanifest"
    || pathname === "/sw.js"
    || pathname === "/openapi.json"
    || pathname === "/favicon.ico"
    || pathname === "/favicon.svg"
    || pathname === "/og.png"
    || pathname === "/window.svg"
    || pathname === "/globe.svg"
    || pathname === "/file.svg";
}

function isDispatchAuthPath(pathname: string) {
  return pathname === "/signin-with-chatgpt"
    || pathname === "/signout-with-chatgpt"
    || pathname === "/callback";
}

function isPublicTalkPhoneTransport(pathname: string) {
  return pathname === "/api/talk/phone/incoming"
    || pathname === "/api/talk/phone/verify"
    || pathname === "/api/talk/phone/stream"
    || pathname.startsWith("/api/talk/phone/bridge/");
}

function unauthorizedApi(message = "Sign in with ChatGPT or use a valid API token to use Dawar Todo.") {
  return Response.json(
    { error: message },
    {
      status: 401,
      headers: {
        "Cache-Control": "no-store",
        "WWW-Authenticate": 'Bearer realm="Dawar Todo API"',
      },
    },
  );
}

export async function appAccessResponse(
  request: Request,
  environment?: AccessEnvironment,
  context?: AccessContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (isLocalHost(url.hostname)) return null;
  if (url.pathname.startsWith("/calendar/")) return null;
  if (isPublicStaticPath(url.pathname) || isDispatchAuthPath(url.pathname)) return null;
  if (isPublicTalkPhoneTransport(url.pathname)) return null;
  if (request.headers.get(AUTHENTICATED_USER_HEADER)?.trim()) return null;

  const apiRequest = url.pathname.startsWith("/api/");
  const bearerToken = apiRequest ? apiTokenFromAuthorization(request.headers.get("Authorization")) : null;
  if (apiRequest && bearerToken) {
    if (url.pathname.startsWith("/api/api-tokens") || url.pathname.startsWith("/api/push")) {
      console.warn("[todo-auth] API token management rejected for bearer authentication", { path: url.pathname });
      return Response.json(
        { error: url.pathname.startsWith("/api/push")
          ? "Push notification devices can only be managed in Settings after signing in with ChatGPT."
          : "API tokens can only be managed in Settings after signing in with ChatGPT." },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (url.pathname.startsWith("/api/assistant") || url.pathname.startsWith("/api/talk")) {
      console.warn("[todo-auth] signed-in AI workspace rejected for bearer authentication", { path: url.pathname });
      return Response.json(
        { error: "The AI assistant and Talk are available only in the signed-in Dawar Todo interface." },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (!environment?.DB) {
      console.error("[todo-auth] API token validation unavailable", { path: url.pathname, reason: "missing-database-binding" });
      return Response.json(
        { error: "API token authentication is temporarily unavailable." },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    try {
      const identity = await authenticateApiToken(environment.DB, bearerToken);
      if (identity) {
        const recordUse = recordApiTokenUse(environment.DB, identity.id);
        if (context) context.waitUntil(recordUse);
        else void recordUse;
        console.info("[todo-auth] API token accepted", {
          path: url.pathname,
          method: request.method,
          tokenId: identity.id,
          tokenPrefix: identity.tokenPrefix,
        });
        return null;
      }
      console.warn("[todo-auth] API token rejected", {
        path: url.pathname,
        method: request.method,
        tokenPrefix: bearerToken.slice(0, 16),
      });
      return unauthorizedApi("That API token is invalid, expired, or revoked.");
    } catch (error) {
      console.error("[todo-auth] API token validation failed", { path: url.pathname, method: request.method, error });
      return Response.json(
        { error: "API token authentication is temporarily unavailable." },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
  }

  console.info("[todo-auth] unauthenticated request blocked", {
    path: url.pathname,
    kind: apiRequest ? "api" : "page",
    method: request.method,
  });
  if (apiRequest) return unauthorizedApi();

  const returnTo = `${url.pathname}${url.search}`;
  const signIn = new URL("/signin-with-chatgpt", url);
  signIn.searchParams.set("return_to", returnTo.startsWith("//") ? "/" : returnTo);
  return Response.redirect(signIn, 303);
}
