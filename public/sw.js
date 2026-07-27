const CACHE_NAME = "dawar-todo-shell-v11";
const SHELL = [
  "/",
  "/assistant",
  "/talk",
  "/manifest.webmanifest",
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
      const normalized = value.startsWith("assets/") ? `/${value}` : value;
      const url = new URL(normalized, sourceUrl);
      if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
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

async function cacheAssetGraph(cache, initialUrls, strict) {
  const seen = new Set();
  let pending = [...new Set(initialUrls)];
  while (pending.length) {
    const batch = pending;
    pending = [];
    const results = await Promise.all(batch.map(async (url) => {
      if (seen.has(url)) return [];
      seen.add(url);
      try {
        const response = await fetch(new Request(url, { cache: "reload", credentials: "same-origin" }));
        const inspect = /\.(?:css|js|mjs)(?:\?|$)/i.test(url) ? response.clone() : null;
        await cacheResponse(cache, url, response);
        return inspect ? discoveredAssetUrls(await inspect.text(), url) : [];
      } catch (error) {
        if (strict) throw error;
        return [];
      }
    }));
    for (const urls of results) {
      for (const url of urls) if (!seen.has(url)) pending.push(url);
    }
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
  await cache.put(cacheKey, response);
  const assets = shellAssetUrls(html).filter((url) => url !== "/");
  await cacheAssetGraph(cache, assets, false);
}

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
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
        const cached = await caches.match(url.pathname) || await caches.match("/");
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
        return network.catch(() => caches.match("/"));
      })(),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request).then((response) => {
        if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
        return response;
      }).catch(() => cached);
      return cached || network;
    }),
  );
});

self.addEventListener("message", (event) => {
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
      url: typeof payload.url === "string" ? payload.url : "/",
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
  const target = new URL(event.notification.data?.url || "/", self.location.origin).href;
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
