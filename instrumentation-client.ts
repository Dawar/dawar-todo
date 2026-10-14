// The portable gateway owns session authentication. Fetches carry its CSRF
// token automatically; external providers and credentialed API clients retain
// their existing request semantics. Cloudflare builds do not install this hook.
if (process.env.NEXT_PUBLIC_DAWAR_PORTABLE === "1") {
  const original = globalThis.fetch.bind(globalThis);
  let csrf: Promise<string> | undefined;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, location.href);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (url.origin !== location.origin || ["GET", "HEAD", "OPTIONS"].includes(method)
      || headers.has("Authorization") || url.pathname.startsWith("/api/task-requests/guest")) return original(input, init);
    csrf ??= original("/auth/session", { credentials:"same-origin",cache:"no-store" }).then(async response => {
      if (!response.ok) throw Error("Sign in before sending this request.");
      const body = await response.json() as { csrf?: unknown };
      if (typeof body.csrf !== "string") throw Error("Session verification unavailable.");
      return body.csrf as string;
    }).catch(error => { csrf = undefined; throw error; });
    headers.set("x-dawar-csrf", await csrf);
    const result = await original(input, { ...init, headers });
    if (result.status === 401) csrf = undefined;
    return result;
  };
}
