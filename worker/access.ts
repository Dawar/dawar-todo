const AUTHENTICATED_USER_HEADER = "oai-authenticated-user-email";

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

export function appAccessResponse(request: Request): Response | null {
  const url = new URL(request.url);
  if (isLocalHost(url.hostname)) return null;
  if (url.pathname.startsWith("/calendar/")) return null;
  if (isPublicStaticPath(url.pathname) || isDispatchAuthPath(url.pathname)) return null;
  if (request.headers.get(AUTHENTICATED_USER_HEADER)?.trim()) return null;

  const apiRequest = url.pathname.startsWith("/api/");
  console.info("[todo-auth] unauthenticated request blocked", {
    path: url.pathname,
    kind: apiRequest ? "api" : "page",
    method: request.method,
  });
  if (apiRequest) {
    return Response.json(
      { error: "Sign in with ChatGPT to use Dawar Todo." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const returnTo = `${url.pathname}${url.search}`;
  const signIn = new URL("/signin-with-chatgpt", url);
  signIn.searchParams.set("return_to", returnTo.startsWith("//") ? "/" : returnTo);
  return Response.redirect(signIn, 303);
}
