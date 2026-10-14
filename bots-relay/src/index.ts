import { secureBrowserFrame } from "../../lib/secure-relay";
import { taskRequestFrame } from '../../lib/task-request-relay';
import type { TaskRequestTicket } from '../../lib/bots-auth';
import { DurableObject } from "cloudflare:workers";
import { secretMatches, verifyBotTicket, verifyTaskRequestTicket } from "../../lib/bots-auth";

interface Env {
  BOT_RELAYS: DurableObjectNamespace;
  SITE_ORIGIN: string;
  BOTS_MACHINE_ID: string;
  BOTS_TICKET_SECRET: string;
  BOTS_MACHINE_SECRET: string;
  BOTS_DEV_ORIGIN?: string;
}
type Connection = {
  id: string;
  role: "pending" | "browser" | "machine" | 'task-request';
  expiresAt: number;
  owner?: string;
  desktop?: boolean;
  parentId?: string;
  botId?: string;
  taskRequest?: TaskRequestTicket;
};
const MAX_FRAME = 420_000;
function encode(bytes: ArrayBuffer) {
  const b = new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < b.length; i += 8192)
    s += String.fromCharCode(...b.subarray(i, i + 8192));
  return btoa(s);
}
function decode(text: string) {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0)).buffer;
}
function send(socket: WebSocket, message: unknown) {
  try {
    socket.send(JSON.stringify(message));
  } catch {
    /* reconnect will recover from the VM journal */
  }
}

export class BotRelay extends DurableObject<Env> {
  async fetch(request: Request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response("WebSocket required", { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const connection: Connection = {
      id: crypto.randomUUID(),
      role: "pending",
      expiresAt: Date.now() + 15000,
    };
    server.serializeAttachment(connection);
    this.ctx.acceptWebSocket(server);
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
    await this.armAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }
  connection(socket: WebSocket) {
    return socket.deserializeAttachment() as Connection;
  }
  machine() {
    return this.ctx
      .getWebSockets()
      .find(
        (s) =>
          s.readyState === WebSocket.OPEN &&
          this.connection(s)?.role === "machine",
      );
  }
  broadcast(message: unknown) {
    for (const socket of this.ctx.getWebSockets()) {
      const c = this.connection(socket);
      if (c?.role === "browser" && !c.desktop && c.expiresAt > Date.now())
        send(socket, message);
    }
  }
  async webSocketMessage(socket: WebSocket, data: string | ArrayBuffer) {
    const attached = this.connection(socket);
    if (data instanceof ArrayBuffer) {
      if (
        !attached?.desktop ||
        attached.role !== "browser" ||
        attached.expiresAt <= Date.now() ||
        data.byteLength > 128 * 1024
      ) {
        socket.close(1009, "Invalid desktop frame");
        return;
      }
      const machine = this.machine();
      if (!machine) {
        socket.close(1011, "VM offline");
        return;
      }
      send(machine, {
        type: "desktop",
        event: "data",
        clientId: attached.id,
        data: encode(data),
      });
      return;
    }
    if (typeof data !== "string" || data.length > MAX_FRAME) {
      socket.close(1009, "Frame too large");
      return;
    }
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      socket.close(1003, "Invalid JSON");
      return;
    }
    const c = this.connection(socket);
    if (!c) return socket.close(1008, "Unauthenticated");
    try {
      if (message.type === "auth") {
        if (message.role === "machine") {
          if (
            c.role !== "pending" ||
            message.machineId !== this.env.BOTS_MACHINE_ID ||
            !(await secretMatches(
              String(message.credential ?? ""),
              this.env.BOTS_MACHINE_SECRET,
            ))
          )
            throw new Error("Invalid machine credentials");
          const previous = this.machine();
          if (previous && previous !== socket)
            previous.close(4001, "Machine reconnected");
          socket.serializeAttachment({
            ...c,
            role: "machine",
            expiresAt: Number.MAX_SAFE_INTEGER,
          });
          send(socket, { type: "authenticated", role: "machine" });
          this.broadcast({ type: "presence", online: true });
        } else if(message.role==='task-request') {
          if(c.role!=='pending'||message.desktop)throw Error('Invalid guest role.');
          const ticket=await verifyTaskRequestTicket(message.ticket,this.env.BOTS_TICKET_SECRET,this.env.BOTS_MACHINE_ID);
          const key=`ticket:${ticket.jti}`;if(await this.ctx.storage.get(key))throw Error('Ticket already used.');
          await this.ctx.storage.put(key,ticket.exp*1000);
          // Store only signed metadata, not the guest link/PIN or any plaintext.
          socket.serializeAttachment({...c,role:'task-request',owner:ticket.owner,expiresAt:ticket.sessionExp*1000,taskRequest:ticket});
          send(socket,{type:'authenticated',role:'task-request',owner:ticket.owner,online:Boolean(this.machine()),expiresAt:ticket.sessionExp*1000,clientId:c.id});
        } else {
          if(c.role==='task-request')throw Error('Guest role cannot become owner.');
          if (c.role === "machine") throw new Error("Invalid role");
          const ticket = await verifyBotTicket(
            message.ticket,
            this.env.BOTS_TICKET_SECRET,
            this.env.BOTS_MACHINE_ID,
          );
          if (c.owner && c.owner !== ticket.owner)
            throw new Error("Owner cannot change");
          const key = `ticket:${ticket.jti}`;
          if (await this.ctx.storage.get(key))
            throw new Error("Ticket already used");
          await this.ctx.storage.put(key, ticket.exp * 1000);
          const desktop = message.desktop;
          let parentId: string | undefined;
          if (desktop) {
            if (
              c.role !== "pending" ||
              typeof desktop.token !== "string" ||
              !/^[a-f0-9]{64}$/.test(desktop.token) ||
              typeof desktop.botId !== "string" ||
              desktop.botId.length > 180 ||
              typeof desktop.parentId !== "string"
            )
              throw new Error("Invalid desktop connection");
            const parent = this.ctx.getWebSockets().find((s) => {
              const p = this.connection(s);
              return (
                p?.id === desktop.parentId &&
                p.role === "browser" &&
                !p.desktop &&
                p.owner === ticket.owner &&
                p.expiresAt > Date.now()
              );
            });
            if (!parent) throw new Error("Desktop parent session expired");
            parentId = desktop.parentId;
          }
          socket.serializeAttachment({
            ...c,
            ...(desktop
              ? { desktop: true, parentId, botId: desktop.botId }
              : {}),
            role: "browser",
            owner: ticket.owner,
            expiresAt: ticket.sessionExp * 1000,
          });
          send(socket, {
            type: "authenticated",
            role: "browser",
            online: Boolean(this.machine()),
            expiresAt: ticket.sessionExp * 1000,
            clientId: c.id,
          });
          if (desktop) {
            const machine = this.machine();
            if (!machine) throw new Error("VM offline");
            send(machine, {
              type: "desktop",
              event: "open",
              clientId: c.id,
              parentId,
              botId: desktop.botId,
              token: desktop.token,
            });
          }
        }
        await this.armAlarm();
        return;
      }
      if (c.role === "pending" || c.expiresAt <= Date.now())
        throw new Error("Session expired");
      if(c.role==='task-request') {
        if(message.type!=='task-request'||!c.taskRequest)throw Error('Guest transport permits only its private form transfer.');
        const frame=taskRequestFrame(message,c.taskRequest,c.id),machine=this.machine();
        if(!machine) {send(socket,{type:'task-request.response',id:message.id,error:'Private transfer unavailable. Nothing was stored.'});return;}
        send(machine,frame);return;
      }
      if(message.type==='task-request.response'&&c.role==='machine') {
        const target=this.ctx.getWebSockets().find(s=>{const p=this.connection(s);return p?.role==='task-request'&&p.id===message.clientId&&p.expiresAt>Date.now();});
        if(target)send(target,{type:'task-request.response',id:message.id,result:message.result,error:message.error});return;
      }
      if (c.role === "browser" && c.desktop) {
        if (
          message.type !== "desktop" ||
          !["ping", "close", "control"].includes(message.event)
        )
          throw new Error("Invalid desktop message");
        const parent = this.ctx.getWebSockets().find((s) => {
          const p = this.connection(s);
          return (
            p?.id === c.parentId &&
            p.role === "browser" &&
            !p.desktop &&
            p.owner === c.owner &&
            p.expiresAt > Date.now()
          );
        });
        if (!parent) throw new Error("Desktop parent session expired");
        const machine = this.machine();
        if (!machine) throw new Error("VM offline");
        send(machine, {
          type: "desktop",
          event: message.event,
          clientId: c.id,
          ...(message.event === "control"
            ? { exclusive: message.exclusive === true }
            : {}),
        });
      } else if (message.type === "secure" && c.role === "browser") {
        const frame = secureBrowserFrame(message, c.owner!, c.id), machine = this.machine();
        if (!machine) { send(socket, { type:"secure.response", id:message.id, error:"Bot bridge offline. Sensitive input was not stored." }); return; }
        send(machine, frame);
      } else if (message.type === "secure.response" && c.role === "machine") {
        const target = this.ctx.getWebSockets().find(s => { const p=this.connection(s); return p?.role==="browser" && !p.desktop && p.id===message.clientId && p.expiresAt>Date.now(); });
        if(target)send(target,{type:"secure.response",id:message.id,result:message.result,error:message.error});
      } else if (c.role === "browser") {
        if (
          message.type !== "request" ||
          typeof message.id !== "string" ||
          message.id.length > 180
        )
          throw new Error("Invalid request");
        const machine = this.machine();
        if (!machine) {
          send(socket, {
            type: "response",
            id: message.id,
            error: "The VM is offline. Your draft has been kept.",
          });
          return;
        }
        // Never accept a browser-supplied routing identity.
        send(machine, {
          type: "request",
          id: message.id,
          operationId: message.operationId,
          method: message.method,
          botId: message.botId,
          params: message.params,
          clientId: c.id,
        });
      } else if (message.type === "desktop") {
        const target = this.ctx.getWebSockets().find((s) => {
          const p = this.connection(s);
          return (
            p?.desktop &&
            p.role === "browser" &&
            p.id === message.clientId &&
            p.expiresAt > Date.now()
          );
        });
        if (target) {
          if (message.event === "data") {
            if (
              typeof message.data !== "string" ||
              message.data.length > 180000
            )
              throw new Error("Invalid machine desktop frame");
            target.send(decode(message.data));
          } else if (["ready", "closed", "control"].includes(message.event)) {
            send(target, {
              type: "desktop",
              event: message.event,
              password: message.password,
              error: message.error,
              exclusive: message.exclusive,
            });
            if (message.event === "closed")
              target.close(1000, "Desktop closed");
          }
        }
      } else if (message.type === "response") {
        const target = this.ctx.getWebSockets().find((s) => {
          const target = this.connection(s);
          return (
            target?.role === "browser" &&
            target.id === message.clientId &&
            target.expiresAt > Date.now()
          );
        });
        if (target)
          send(target, {
            type: "response",
            id: message.id,
            result: message.result,
            error: message.error,
            outcome: message.outcome === "rejected" ? "rejected" : "uncertain",
          });
      } else if (message.type === "event" || message.type === "eventChunk")
        this.broadcast(message);
    } catch (error) {
      send(socket, {
        type: "error",
        error: error instanceof Error ? error.message : "Connection rejected",
      });
      socket.close(1008, "Authentication or protocol error");
    }
  }
  async webSocketClose(socket: WebSocket) {
    const c = this.connection(socket);
    if (c?.desktop) {
      const m = this.machine();
      if (m) send(m, { type: "desktop", event: "close", clientId: c.id });
    }
    if (c?.role === "browser" && !c.desktop)
      for (const s of this.ctx.getWebSockets())
        if (this.connection(s)?.parentId === c.id)
          s.close(4003, "Parent disconnected");
    if (this.connection(socket)?.role === "machine" && !this.machine()) {
      this.broadcast({ type: "presence", online: false });
      for (const s of this.ctx.getWebSockets())
        if (this.connection(s)?.desktop) s.close(1011, "VM offline");
    }
  }
  async webSocketError(socket: WebSocket) {
    socket.close(1011, "Connection error");
  }
  async armAlarm() {
    const expirations = this.ctx
      .getWebSockets()
      .map((s) => this.connection(s)?.expiresAt ?? Infinity)
      .filter((t) => t < Number.MAX_SAFE_INTEGER);
    const next = Math.min(Date.now() + 60000, ...expirations);
    await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, next));
  }
  async alarm() {
    for (const socket of this.ctx.getWebSockets())
      if (this.connection(socket)?.expiresAt <= Date.now())
        socket.close(4003, "Session expired");
    const tickets = await this.ctx.storage.list<number>({ prefix: "ticket:" });
    const expired = [...tickets]
      .filter(([, expiry]) => expiry < Date.now())
      .map(([key]) => key);
    if (expired.length) await this.ctx.storage.delete(expired);
    if (this.ctx.getWebSockets().length || tickets.size) await this.armAlarm();
  }
}
export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return Response.json({ ok: true });
    if (
      url.pathname !== "/connect" ||
      url.searchParams.get("machine") !== env.BOTS_MACHINE_ID
    )
      return new Response("Not found", { status: 404 });
    const origin = request.headers.get("Origin");
    if (origin && origin !== env.SITE_ORIGIN && origin !== env.BOTS_DEV_ORIGIN)
      return new Response("Origin rejected", { status: 403 });
    if (!env.BOTS_TICKET_SECRET || !env.BOTS_MACHINE_SECRET)
      return new Response("Relay not configured", { status: 503 });
    return env.BOT_RELAYS.get(
      env.BOT_RELAYS.idFromName(env.BOTS_MACHINE_ID),
    ).fetch(request);
  },
};
