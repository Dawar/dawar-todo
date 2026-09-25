import test from "node:test";
import assert from "node:assert/strict";
import { runtime } from "../tests/helpers/load-ts.mjs";
import { signBotTicket } from "../lib/bots-auth.ts";
class Socket {
  readyState = 1;
  data;
  sent = [];
  closed;
  serializeAttachment(v) {
    this.data = v;
  }
  deserializeAttachment() {
    return this.data;
  }
  send(v) {
    this.sent.push(JSON.parse(v));
  }
  close(code) {
    this.readyState = 3;
    this.closed = code;
  }
}
function setup() {
  const sockets = [],
    storage = new Map();
  const ctx = {
    getWebSockets: () => sockets,
    storage: {
      get: async (k) => storage.get(k),
      put: async (k, v) => storage.set(k, v),
      setAlarm: async () => {},
      list: async () => storage,
      delete: async (keys) => keys.forEach((k) => storage.delete(k)),
    },
  };
  const env = {
    BOTS_MACHINE_ID: "vm",
    BOTS_MACHINE_SECRET: "machine",
    BOTS_TICKET_SECRET: "ticket",
  };
  const { BotRelay } = runtime(
    { btoa, atob, WebSocket: { OPEN: 1 } },
    {
      "cloudflare:workers": {
        DurableObject: class {
          constructor(ctx, env) {
            this.ctx = ctx;
            this.env = env;
          }
        },
      },
    },
  ).load("bots-relay/src/index.ts");
  const relay = new BotRelay(ctx, env);
  const socket = (id) => {
    const s = new Socket();
    s.serializeAttachment({
      id,
      role: "pending",
      expiresAt: Date.now() + 15000,
    });
    sockets.push(s);
    return s;
  };
  const send = (s, m) => relay.webSocketMessage(s, JSON.stringify(m));
  return { relay, socket, send, sockets };
}
async function ticket() {
  const n = Math.floor(Date.now() / 1000);
  return signBotTicket(
    {
      role: "browser",
      machineId: "vm",
      owner: "owner",
      jti: crypto.randomUUID(),
      exp: n + 60,
      sessionExp: n + 900,
    },
    "ticket",
  );
}
test("relay routes only authenticated operations, persists tickets and reconnects one machine", async () => {
  const { relay, socket, send } = setup();
  const machine = socket("machine"),
    a = socket("a"),
    b = socket("b");
  await send(machine, {
    type: "auth",
    role: "machine",
    machineId: "vm",
    credential: "machine",
  });
  const token = await ticket();
  await send(a, { type: "auth", ticket: token });
  await send(b, { type: "auth", ticket: token });
  assert.equal(b.closed, 1008);
  await send(a, {
    type: "request",
    id: "id",
    operationId: "op",
    method: "snapshot",
    clientId: "forged",
  });
  assert.equal(machine.sent.at(-1).clientId, "a");
  await send(machine, {
    type: "response",
    clientId: "a",
    id: "id",
    result: { ok: true },
  });
  assert.equal(a.sent.at(-1).result.ok, true);
  const replacement = socket("replacement");
  await send(replacement, {
    type: "auth",
    role: "machine",
    machineId: "vm",
    credential: "machine",
  });
  assert.equal(machine.closed, 4001);
  assert.equal(relay.machine(), replacement);
  replacement.close(1000);
  await relay.webSocketClose(replacement);
  assert.equal(a.sent.at(-1).online, false);
});
test("relay rejects expired sessions, bad credentials and oversized frames", async () => {
  const { relay, socket, send } = setup();
  const bad = socket("bad");
  await send(bad, {
    type: "auth",
    role: "machine",
    machineId: "vm",
    credential: "wrong",
  });
  assert.equal(bad.closed, 1008);
  const browser = socket("browser");
  await send(browser, { type: "auth", ticket: await ticket() });
  browser.data.expiresAt = 0;
  await send(browser, { type: "request", id: "x" });
  assert.equal(browser.closed, 1008);
  const oversized = socket("large");
  await relay.webSocketMessage(oversized, "x".repeat(420001));
  assert.equal(oversized.closed, 1009);
});
