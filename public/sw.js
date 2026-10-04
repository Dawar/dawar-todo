const CACHE_PREFIX = "dawar-todo-shell-";
const CACHE_NAME = `${CACHE_PREFIX}v74`;
const SHELL = [
  "/",
  "/tasks",
  "/open",
  "/settings",
  "/bots",
  "/manifest.webmanifest",
  "/pwa-build.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    precacheAppShell()
      .then((assetCount) => {
        console.info("[todo-pwa] offline app shell ready", { cache: CACHE_NAME, assetCount });
        return self.skipWaiting();
      })
      .catch((error) => {
        console.error("[todo-pwa] offline app shell installation failed", {
          cache: CACHE_NAME,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }),
  );
});

function discoveredAssetUrls(text, sourcePath = "/") {
  const urls = new Set();
  const sourceUrl = new URL(sourcePath, self.location.origin);
  const add = (value) => {
    try {
      if (/[`${}+]/.test(value)) return;
      // ELK embeds a CommonJS module table in its emitted bundle. These
      // relative names address modules inside that table, not network files.
      // Keep caching the real bundle and its other emitted dependencies.
      if (/^\/assets\/elk-[A-Za-z0-9_-]+\.js$/.test(sourceUrl.pathname)
        && (value === "./elk-api.js" || value === "./elk-worker.min.js")) return;
      const normalized = value.startsWith("assets/") ? `/${value}` : value;
      const url = new URL(normalized, sourceUrl);
      if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
      // Mermaid's optional entry references every diagram engine. Keep that
      // graph out of shell installation; requested diagram assets are cached
      // by the normal asset handler after their first use.
      if (url.pathname.startsWith("/assets/mermaid.core-")) return;
      const cacheable = url.pathname.startsWith("/assets/")
        || url.pathname.startsWith("/_next/")
        || /\.(?:css|js|mjs|woff2?|png|webp|jpg|jpeg|svg|ico)$/i.test(url.pathname);
      if (!cacheable) return;
      urls.add(`${url.pathname}${url.search}`);
    } catch {
      // Ignore malformed optional metadata instead of failing installation.
    }
  };
  for (const match of text.matchAll(/\b(?:src|href)=["']([^"']+)["']/gi)) add(match[1]);
  for (const match of text.matchAll(/["'`(]((?:\/assets\/|assets\/|\.\/)[A-Za-z0-9@._~/-]+\.(?:css|js|mjs|woff2?|png|webp|jpg|jpeg|svg|ico)(?:\?[A-Za-z0-9._~=&%-]+)?)/gi)) add(match[1]);
  return [...urls];
}

function shellAssetUrls(html) {
  const urls = new Set(SHELL);
  discoveredAssetUrls(html).forEach((url) => urls.add(url));
  return [...urls];
}

async function cacheResponse(cache, key, response) {
  if (!response.ok) throw new Error(`Could not cache ${key} (${response.status}).`);
  await cache.put(key, response);
}

// A generation-local completion index is written only after the entire graph
// succeeds. Partial installations must still inspect/retry their dependencies.
const GRAPH_INDEX = "/.pwa-complete-asset-graph";
let completedGraph;
let graphIndexWrite = Promise.resolve();
async function completedAssets(cache) {
  if (!completedGraph) completedGraph = cache.match(GRAPH_INDEX).then(async (response) => {
    try { return new Set(response ? await response.json() : []); } catch { return new Set(); }
  });
  return completedGraph;
}
async function cacheAssetGraph(cache, initialUrls, strict) {
  const complete = await completedAssets(cache);
  const discovered = new Set();
  let failed = false;
  const seen = new Set();
  let pending = [...new Set(initialUrls)];
  while (pending.length) {
    const batch = pending;
    pending = [];
    const results = await Promise.all(batch.map(async (url) => {
      if (seen.has(url)) return [];
      seen.add(url);
      try {
        // Content-addressed bundles never change at the same URL. Reuse them
        // across navigations and shell upgrades instead of downloading the graph.
        const immutable = url.startsWith("/assets/") || url.startsWith("/_next/static/");
        if (immutable && complete.has(url)) return [];
        const current = immutable ? await cache.match(url) : null;
        const cached = current || (immutable ? await caches.match(url) : null);
        const response = cached || await fetch(new Request(url, { cache: "reload", credentials: "same-origin" }));
        const inspect = /\.(?:css|js|mjs)(?:\?|$)/i.test(url) ? response.clone() : null;
        if (!current) await cacheResponse(cache, url, response);
        if (immutable) discovered.add(url);
        return inspect ? discoveredAssetUrls(await inspect.text(), url) : [];
      } catch (error) {
        failed = true;
        if (strict) throw error;
        return [];
      }
    }));
    for (const urls of results) {
      for (const url of urls) if (!seen.has(url)) pending.push(url);
    }
  }
  if (!failed && discovered.size) {
    discovered.forEach((url) => complete.add(url));
    // Serialize overlapping walks and snapshot the union when the write runs.
    graphIndexWrite = graphIndexWrite.catch(() => undefined).then(() =>
      cache.put(GRAPH_INDEX, new Response(JSON.stringify([...complete]), { headers: { "Content-Type": "application/json" } })));
    await graphIndexWrite;
  }
  return seen.size;
}

async function precacheAppShell() {
  const cache = await caches.open(CACHE_NAME);
  const page = await fetch(new Request("/", { cache: "reload", credentials: "same-origin" }));
  if (!page.ok) throw new Error(`Could not cache the app shell (${page.status}).`);
  const html = await page.clone().text();
  await cache.put("/", page);
  const assets = shellAssetUrls(html).filter((url) => url !== "/");
  return cacheAssetGraph(cache, assets, true);
}

async function refreshDocumentShell(response, cacheKey) {
  if (!response.ok) return;
  const cache = await caches.open(CACHE_NAME);
  const html = await response.clone().text();
  const assets = discoveredAssetUrls(html);
  await cacheAssetGraph(cache, assets, true);
  await cache.put(cacheKey, response);
}

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      const staleShellCaches = keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME);
      const retainedShellCaches = staleShellCaches
        .sort((a, b) => {
          const aVersion = Number(a.slice(CACHE_PREFIX.length).replace(/^v/, "")) || 0;
          const bVersion = Number(b.slice(CACHE_PREFIX.length).replace(/^v/, "")) || 0;
          return bVersion - aVersion;
        })
        .slice(0, 1);
      const removedShellCaches = staleShellCaches.filter((key) => !retainedShellCaches.includes(key));
      await Promise.all(removedShellCaches.map((key) => caches.delete(key)));
      await self.clients.claim();
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      console.info("[todo-pwa] app shell upgrade activated", {
        cache: CACHE_NAME,
        retainedShellCaches,
        removedShellCaches,
        openClients: windows.length,
        forcedNavigations: 0,
      });
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/calendar/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        const currentShell = await caches.open(CACHE_NAME);
        const cached = await currentShell.match(url.pathname);
        const network = fetch(request)
          .then((response) => {
            if (response.ok) event.waitUntil(refreshDocumentShell(response.clone(), url.pathname));
            return response;
          });
        if (cached) {
          event.waitUntil(network.catch((error) => {
            console.warn("[todo-pwa] background shell refresh deferred", {
              path: url.pathname,
              error: error instanceof Error ? error.message : String(error),
            });
          }));
          return cached;
        }
        console.info("[todo-pwa] uncached route requested from network", {
          path: url.pathname,
        });
        return network.catch(async (error) => {
          console.warn("[todo-pwa] uncached route unavailable; using offline task shell", {
            path: url.pathname,
            error: error instanceof Error ? error.message : String(error),
          });
          return (await currentShell.match("/")) || caches.match("/");
        });
      })(),
    );
    return;
  }

  // RSC/router responses are protocol messages, not reusable app-shell files.
  const asset = url.pathname.startsWith("/assets/") || url.pathname.startsWith("/_next/static/")
    || /\.(?:css|js|mjs|woff2?|png|webp|jpg|jpeg|svg|ico)$/i.test(url.pathname)
    || url.pathname === "/manifest.webmanifest";
  if (!asset) return;
  event.respondWith((async () => {
    const cached = await caches.match(request);
    const immutable = url.pathname.startsWith("/assets/") || url.pathname.startsWith("/_next/static/");
    if (cached && immutable) return cached;
    const network = fetch(request).then(async (response) => {
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
      }
      return response;
    });
    if (cached) {
      event.waitUntil(network.catch(() => undefined));
      return cached;
    }
    return network;
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "PWA_VERSION") event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const manifest = await cache.match("/pwa-build.json");
    let build = null; try { build = (await manifest?.json())?.build ?? null; } catch { /* Older shells have no build marker. */ }
    event.ports?.[0]?.postMessage({ cache: CACHE_NAME, databaseVersion: 11, build });
  })());
  if (event.data?.type === "PWA_REFRESH_DOCUMENT") event.waitUntil((async () => {
    try {
      const url = new URL(event.data.url);
      if (url.origin !== self.location.origin) throw Error("Invalid document origin.");
      const response = await fetch(new Request(url.href, { cache: "reload", credentials: "same-origin" }));
      if (!response.ok || new URL(response.url).origin !== self.location.origin || !response.headers.get("Content-Type")?.includes("text/html")) throw Error("Document unavailable.");
      // Required assets must all succeed before replacing any document shell.
      await refreshDocumentShell(response, url.pathname);
      event.ports?.[0]?.postMessage({ ok: true });
    } catch { event.ports?.[0]?.postMessage({ ok: false }); }
  })());
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data?.json() ?? {};
  } catch (error) {
    payload = { title: "Dawar Todo", body: event.data?.text() || "Tasks are ready." };
    console.warn("[todo-push] notification payload was not JSON", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const title = typeof payload.title === "string" && payload.title ? payload.title : "Dawar Todo";
  const options = {
    body: typeof payload.body === "string" ? payload.body : "Tasks are ready.",
    tag: typeof payload.tag === "string" ? payload.tag : "dawar-todo-open-items",
    renotify: true,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: {
      url: typeof payload.url === "string" ? payload.url : "/tasks",
    },
  };
  event.waitUntil((async () => {
    await self.registration.showNotification(title, options);
    const openCount = Number(payload.openCount);
    if (Number.isFinite(openCount) && typeof self.navigator?.setAppBadge === "function") {
      if (openCount > 0) await self.navigator.setAppBadge(Math.floor(openCount));
      else if (typeof self.navigator.clearAppBadge === "function") await self.navigator.clearAppBadge();
    }
    console.info("[todo-push] notification displayed", {
      tag: options.tag,
      hasOpenCount: Number.isFinite(openCount),
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const destination = new URL(event.notification.data?.url || "/tasks", self.location.origin);
  // Old task notifications used bare `/`, now also a neutral launch entry.
  // Keep their Tasks intent; query/hash task links and bot URLs stay exact.
  if (destination.origin === self.location.origin && destination.pathname === "/" && !destination.search && !destination.hash) destination.pathname = "/tasks";
  const target = destination.href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) {
      if ("navigate" in existing && existing.url !== target) await existing.navigate(target);
      return existing.focus();
    }
    return self.clients.openWindow(target);
  })());
});
