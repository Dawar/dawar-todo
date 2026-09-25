import { homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { Store } from "./store.mjs";
import { Codex } from "./codex.mjs";
import { BotRuntime } from "./runtime.mjs";

const required = [
  "BOTS_RELAY_URL",
  "BOTS_MACHINE_SECRET",
  "BOTS_NOTIFICATION_SECRET",
  "BOTS_SITE_URL",
];
for (const key of required)
  if (!process.env[key]) throw new Error(`${key} is required.`);
const binary =
  process.env.BOTS_CODEX_BINARY ??
  join(
    homedir(),
    ".codex/packages/standalone/releases/0.156.1-x86_64-unknown-linux-musl/bin/codex",
  );
const store = new Store(
  join(
    process.env.BOTS_STATE_DIR ??
      join(homedir(), ".local/share/dawar-todo-bots"),
    "state.sqlite",
  ),
);
const codex = new Codex(binary);
const runtime = new BotRuntime({
  store,
  codex,
  root: process.env.BOTS_ROOT ?? join(homedir(), "bots"),
  defaultTimeZone: process.env.BOTS_TIME_ZONE ?? "UTC",
});
let socket = null,
  stopping = false,
  retry = 0,
  online = false,
  notifying = false;
const log = (event, data = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));
runtime.on("fault", (error) =>
  log("runtime.error", { message: error.message }),
);
runtime.on("event", (event) => {
  if (online && socket?.readyState === WebSocket.OPEN)
    sendLarge(socket, { type: "event", event });
});
codex.on("disconnect", () => {
  if (!stopping) {
    log("codex.disconnected");
    setTimeout(() => process.exit(1), 500);
  }
});
codex.on("fault", (error) => {
  log("codex.error", { message: error.message });
  process.exit(1);
});
await runtime.start();
log("runtime.ready", { version: "0.156.1", bots: store.bots().length });

function connect() {
  if (stopping) return;
  const endpoint = new URL(process.env.BOTS_RELAY_URL);
  if (!["wss:", "ws:"].includes(endpoint.protocol))
    throw new Error("Use a WebSocket relay URL.");
  if (
    endpoint.protocol === "ws:" &&
    !["localhost", "127.0.0.1"].includes(endpoint.hostname)
  )
    throw new Error("Remote relay requires TLS.");
  endpoint.searchParams.set(
    "machine",
    process.env.BOTS_MACHINE_ID ?? "dawar-vm",
  );
  const current = new WebSocket(endpoint);
  socket = current;
  current.addEventListener("open", () =>
    current.send(
      JSON.stringify({
        type: "auth",
        role: "machine",
        machineId: process.env.BOTS_MACHINE_ID ?? "dawar-vm",
        credential: process.env.BOTS_MACHINE_SECRET,
      }),
    ),
  );
  current.addEventListener("message", async ({ data }) => {
    if (data === "pong") return;
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    if (message.type === "authenticated") {
      online = true;
      retry = 0;
      log("relay.connected");
      return;
    }
    if (message.type === "request") {
      let result, error;
      try {
        result = await runtime.handle(message);
      } catch (e) {
        error = e.message;
      }
      const response = {
        type: "response",
        clientId: message.clientId,
        id: message.id,
        result,
        error,
      };
      if (current.readyState === WebSocket.OPEN) sendLarge(current, response);
    }
  });
  current.addEventListener("error", () => {});
  current.addEventListener("close", () => {
    if (socket === current) online = false;
    if (!stopping) {
      const delay =
        Math.min(30000, 1000 * 2 ** Math.min(retry++, 5)) + Math.random() * 500;
      log("relay.disconnected", { retryMs: Math.round(delay) });
      setTimeout(connect, delay);
    }
  });
}
function sendLarge(connection, message) {
  const json = JSON.stringify(message);
  if (Buffer.byteLength(json) < 380000) {
    connection.send(json);
    return;
  }
  // Replies such as long histories are reassembled by the client with a bounded transfer.
  const bytes = Buffer.from(
    JSON.stringify(message.type === "event" ? message.event : message.result),
  );
  if (message.type === "event") {
    if (bytes.length > 32 * 1024 * 1024) {
      connection.send(
        JSON.stringify({
          type: "event",
          event: {
            seq: message.event.seq,
            type: "history.refresh",
            botId: message.event.botId,
            data: {},
          },
        }),
      );
      return;
    }
    for (let offset = 0; offset < bytes.length; offset += 192 * 1024)
      connection.send(
        JSON.stringify({
          type: "eventChunk",
          seq: message.event.seq,
          data: bytes.subarray(offset, offset + 192 * 1024).toString("base64"),
          offset,
          total: bytes.length,
        }),
      );
    return;
  }
  if (bytes.length > 32 * 1024 * 1024) {
    connection.send(
      JSON.stringify({
        ...message,
        result: undefined,
        error: "History is too large. Load older turns in pages.",
      }),
    );
    return;
  }
  for (let offset = 0; offset < bytes.length; offset += 192 * 1024)
    connection.send(
      JSON.stringify({
        type: "response",
        clientId: message.clientId,
        id: message.id,
        result: {
          __chunk: true,
          data: bytes.subarray(offset, offset + 192 * 1024).toString("base64"),
          offset,
          total: bytes.length,
        },
      }),
    );
}
async function flushNotifications() {
  if (notifying) return;
  notifying = true;
  try {
    for (const n of store
      .list("notice")
      .filter((n) => !n.deliveredAt)
      .slice(0, 20)) {
      const response = await fetch(
        new URL("/api/bots/notifications", process.env.BOTS_SITE_URL),
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.BOTS_NOTIFICATION_SECRET}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            id: n.id,
            botId: n.botId,
            title: n.title,
            body: n.body,
          }),
          signal: AbortSignal.timeout(15000),
        },
      );
      if (response.ok)
        store.put("notice", { ...n, deliveredAt: new Date().toISOString() });
      else {
        log("notification.retry", { status: response.status });
        break;
      }
    }
  } catch (e) {
    log("notification.retry", { message: e.message });
  } finally {
    notifying = false;
  }
}
connect();
const ticker = setInterval(
  () =>
    void runtime
      .tick()
      .catch((e) => log("scheduler.error", { message: e.message })),
  5000,
);
const notifications = setInterval(() => void flushNotifications(), 15000);
const heartbeat = setInterval(() => {
  if (socket?.readyState === WebSocket.OPEN) socket.send("ping");
}, 25000);
const health = createServer((request, response) => {
  if (request.url !== "/healthz") {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(runtime.ready ? 200 : 503, {
    "Content-Type": "application/json",
  });
  response.end(
    JSON.stringify({
      ready: runtime.ready,
      relayConnected: online,
      bots: store.bots().length,
      codexVersion: "0.156.1",
    }),
  );
});
health.listen(Number(process.env.BOTS_HEALTH_PORT ?? 47821), "127.0.0.1");
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(ticker);
  clearInterval(notifications);
  clearInterval(heartbeat);
  socket?.close();
  health.close();
  codex.close();
  setTimeout(() => {
    store.close();
    process.exit(0);
  }, 500);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
