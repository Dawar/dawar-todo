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
    if (url.pathname === "/") return new Response(html, { status: 200, headers: { "Content-Type": "text/html" } });
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
  assert.ok(cached.has("/manifest.webmanifest"));
  assert.ok(cached.has("/icons/apple-touch-icon.png"));
});
