import { BotDesktops } from "./desktops.mjs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { Store } from "./store.mjs";
import { Codex } from "./codex.mjs";
import { CODEX_VERSION, codexBinary } from "./codex-version.mjs";
import { BotRuntime } from "./runtime.mjs";
import { bridgeResponse } from "./response.mjs";
import { CodexManager } from "./manager.mjs";
import { BotStorageClient } from "./storage.mjs";

const required = [
  "BOTS_RELAY_URL",
  "BOTS_MACHINE_SECRET",
  "BOTS_NOTIFICATION_SECRET",
  "BOTS_SITE_URL",
];
for (const key of required)
  if (!process.env[key]) throw new Error(`${key} is required.`);
const binary = codexBinary();
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
  adminLeadIds: JSON.parse(process.env.BOTS_ADMIN_LEAD_IDS ?? '[]'),
});
if (process.env.BOTS_STORAGE_SERVICE_SECRET) runtime.storage = new BotStorageClient(runtime,{
  url:process.env.BOTS_SITE_URL, credential:process.env.BOTS_STORAGE_SERVICE_SECRET,
  machineId:process.env.BOTS_MACHINE_ID ?? 'dawar-vm',
});
const manager = new CodexManager({
  runtime,
  store,
  directory: join(
    process.env.BOTS_STATE_DIR ??
      join(homedir(), ".local/share/dawar-todo-bots"),
    "manager",
  ),
});
runtime.manager = manager;
runtime.desktops = new BotDesktops({ runtime, adopt: JSON.parse(process.env.BOTS_DESKTOP_ADOPT ?? '{}') });
runtime.relayOnline = false;
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
  if(runtime.storage && event.type==='bot') void runtime.storage.registerBots().catch(()=>log('storage.catalog-unavailable'));
  if (event.type === "manager")
    log("manager.state", { botId: event.botId, ...event.data });
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
await manager.listen();
await runtime.start();
if (runtime.storage) void runtime.storage.recoverMetadata().catch(() => log('storage.catalog-unavailable'));
await manager.recover();
await runtime.desktops.recover();
log("runtime.ready", { version: CODEX_VERSION, bots: store.bots().length });

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
      online = true; runtime.relayOnline = true;
      retry = 0;
      log("relay.connected");
      return;
    }
    if (message.type === "secure") {
      // Never bridgeResponse/handle/sendLarge/log this sensitive envelope.
      let response;
      try { response = { type:"secure.response", id:message.id, clientId:message.clientId, result:await runtime.secure.channel(message) }; }
      catch { response = { type:"secure.response", id:message.id, clientId:message.clientId, error:"Secure transfer rejected or unavailable. Retain input while open; inspect status or request a fresh form." }; }
      if(current.readyState===WebSocket.OPEN)current.send(JSON.stringify(response));
      return;
    }
    if (message.type === "desktop") {
      await runtime.desktops.message(message, value => {
        if (current.readyState === WebSocket.OPEN && current.bufferedAmount < 8 * 1024 * 1024) current.send(JSON.stringify(value));
        else if (value.event !== "closed") void runtime.desktops.end(value.clientId, "Desktop connection is congested or offline.");
      }).catch(() => runtime.desktops.end(message.clientId, "Desktop control connection failed."));
      return;
    }
    if (message.type === "request") {
      const response = await bridgeResponse(runtime, message);
      if (current.readyState === WebSocket.OPEN) sendLarge(current, response);
    }
  });
  current.addEventListener("error", () => {});
  current.addEventListener("close", async () => {
    if (socket === current) { online = false; runtime.relayOnline = false; await runtime.desktops.disconnect(); }
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
      historyReads: { concurrency: runtime.historyReads.concurrency, active: runtime.historyReads.active,
        pending: runtime.historyReads.pending.size, ...runtime.historyReads.metrics },
      relayConnected: online,
      bots: store.bots().length,
      codexVersion: CODEX_VERSION,
      newBotDefaults: runtime.newBotDefaults,
      models: runtime.models.map(model => model.model),
      manager: {
        ready: true,
        workers: store.list("managerWorker").length,
        tasks: store.list("managerTask").length,
      },
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
  runtime.secure?.close();
  codex.close();
  await runtime.desktops.close();
  await manager.close();
  setTimeout(() => {
    store.close();
    process.exit(0);
  }, 500);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
