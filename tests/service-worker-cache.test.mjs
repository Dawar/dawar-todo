import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const origin = "https://offline.test";

test("cold install recursively precaches every generated client bundle", async () => {
  const [workerSource, manifest, assetNames] = await Promise.all([
    readFile(new URL("public/sw.js", root), "utf8"),
    readFile(new URL("dist/client/.vite/manifest.json", root), "utf8").then(JSON.parse),
    readdir(new URL("dist/client/assets/", root)),
  ]);
  const entry = manifest["virtual:vinext-app-browser-entry"].file;
  const css = assetNames.find((name) => name.endsWith(".css"));
  assert.ok(entry && css);
  const html = `<!doctype html><link rel="stylesheet" href="/assets/${css}"><script type="module">import("/${entry}")</script>`;
  const cached = new Set();
  const listeners = new Map();
  let installPromise;

  const requestUrl = (input) => new URL(typeof input === "string" ? input : input.url, origin);
  const cache = {
    put: async (key) => { cached.add(requestUrl(key).pathname); },
    match: async (key) => cached.has(requestUrl(key).pathname) ? new Response("cached") : undefined,
  };
  const fetchLocal = async (input) => {
    const url = requestUrl(input);
    if (url.pathname === "/" || url.pathname === "/assistant" || url.pathname === "/settings" || url.pathname === "/talk") return new Response(html, { status: 200, headers: { "Content-Type": "text/html" } });
    try {
      const body = await readFile(new URL(`dist/client${url.pathname}`, root));
      return new Response(body, { status: 200 });
    } catch {
      return new Response("missing", { status: 404 });
    }
  };
  function RelativeRequest(input, init) {
    return new Request(requestUrl(input), init);
  }

  vm.runInNewContext(workerSource, {
    self: {
      location: { origin },
      clients: { claim: async () => undefined },
      skipWaiting: async () => undefined,
      addEventListener: (name, handler) => listeners.set(name, handler),
    },
    caches: {
      open: async () => cache,
      keys: async () => [],
      delete: async () => true,
      match: cache.match,
    },
    fetch: fetchLocal,
    Request: RelativeRequest,
    Response,
    URL,
    Set,
    Promise,
    Error,
    console,
  });

  listeners.get("install")({ waitUntil: (promise) => { installPromise = promise; } });
  await installPromise;

  const expectedBundles = assetNames.filter((name) => name.endsWith(".js") || name.endsWith(".css"));
  const missing = expectedBundles.filter((name) => !cached.has(`/assets/${name}`));
  assert.deepEqual(missing, []);
  assert.ok(cached.has("/"));
  assert.equal(cached.has("/assistant"), false);
  assert.ok(cached.has("/settings"));
  assert.ok(cached.has("/talk"));
  assert.ok(cached.has("/manifest.webmanifest"));
  assert.ok(cached.has("/icons/apple-touch-icon.png"));
});

test("an uncached route uses its network document instead of the cached task shell", async () => {
  const workerSource = await readFile(new URL("public/sw.js", root), "utf8");
  const listeners = new Map();
  const cached = new Map([["/", "cached tasks document"]]);
  const fetchedPaths = [];
  const match = async (key) => {
    const pathname = new URL(typeof key === "string" ? key : key.url, origin).pathname;
    const value = cached.get(pathname);
    return value === undefined ? undefined : new Response(value);
  };
  const cache = {
    put: async (key, response) => {
      const pathname = new URL(typeof key === "string" ? key : key.url, origin).pathname;
      cached.set(pathname, await response.text());
    },
    match,
  };
  const fetchLocal = async (request) => {
    const pathname = new URL(request.url, origin).pathname;
    fetchedPaths.push(pathname);
    return new Response(pathname === "/settings" ? "network settings document" : "network response");
  };

  vm.runInNewContext(workerSource, {
    self: {
      location: { origin },
      clients: { claim: async () => undefined },
      skipWaiting: async () => undefined,
      addEventListener: (name, handler) => listeners.set(name, handler),
    },
    caches: {
      open: async () => cache,
      keys: async () => [],
      delete: async () => true,
      match,
    },
    fetch: fetchLocal,
    Request,
    Response,
    URL,
    Set,
    Promise,
    Error,
    console,
  });

  let responsePromise;
  const background = [];
  listeners.get("fetch")({
    request: {
      method: "GET",
      mode: "navigate",
      url: `${origin}/settings`,
    },
    respondWith: (promise) => {
      responsePromise = promise;
    },
    waitUntil: (promise) => {
      background.push(promise);
    },
  });

  const response = await responsePromise;
  assert.equal(await response.text(), "network settings document");
  assert.deepEqual(fetchedPaths, ["/settings"]);
  await Promise.all(background);
  assert.equal(cached.get("/settings"), "network settings document");
});

test("activation preserves the previous app shell without navigating open PWA windows", async () => {
  const workerSource = await readFile(new URL("public/sw.js", root), "utf8");
  const listeners = new Map();
  const deleted = [];
  let claimed = false;
  let navigations = 0;

  vm.runInNewContext(workerSource, {
    self: {
      location: { origin },
      clients: {
        claim: async () => {
          claimed = true;
        },
        matchAll: async () => [{
          url: `${origin}/talk`,
          navigate: async () => {
            navigations += 1;
          },
        }],
      },
      skipWaiting: async () => undefined,
      addEventListener: (name, handler) => listeners.set(name, handler),
    },
    caches: {
      open: async () => ({ match: async () => undefined, put: async () => undefined }),
      keys: async () => [
        "dawar-todo-shell-v21",
        "dawar-todo-shell-v22",
        "dawar-todo-shell-v23",
        "dawar-todo-shell-v25",
        "unrelated-cache",
      ],
      delete: async (key) => {
        deleted.push(key);
        return true;
      },
      match: async () => undefined,
    },
    fetch: async () => new Response("ok"),
    Request,
    Response,
    URL,
    Set,
    Promise,
    Error,
    Number,
    console,
  });

  let activation;
  listeners.get("activate")({
    waitUntil: (promise) => {
      activation = promise;
    },
  });
  await activation;

  assert.equal(claimed, true);
  assert.equal(navigations, 0);
  assert.deepEqual(deleted, [
    "dawar-todo-shell-v22",
    "dawar-todo-shell-v21",
  ]);
});
