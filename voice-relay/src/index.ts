import {
  handleOpenAISipWebhook,
  SipCallController,
  type SipRelayEnvironment,
} from "./sip-controller";

type Env = SipRelayEnvironment;

type TwilioStart = {
  accountSid?: string;
  callSid?: string;
  streamSid?: string;
  mediaFormat?: {
    encoding?: string;
    sampleRate?: number;
    channels?: number;
  };
  customParameters?: Record<string, string>;
};

type TwilioEvent =
  | { event: "connected" }
  | { event: "start"; start?: TwilioStart }
  | { event: "media"; media?: { payload?: string } }
  | { event: "stop" }
  | { event?: string };

type RealtimeEvent = {
  type?: string;
  item_id?: string;
  transcript?: string;
  delta?: string;
  error?: { message?: string; code?: string };
  response?: {
    id?: string;
    output?: Array<{
      type?: string;
      call_id?: string;
      name?: string;
      arguments?: string;
    }>;
  };
};

type BridgeStart = {
  talkSessionId: string;
  clientSecret: string;
  expiresAt: number;
  model: string;
  voice: string;
  focusedTodoId: number | null;
};

type BridgeResult = Record<string, unknown> & {
  focusedTodoId?: number | null;
};

type WorkerResponse = Response & { webSocket?: WebSocket };

const PHONE_IDLE_LIMIT_MS = 15 * 60 * 1_000;
const REALTIME_ROLLOVER_MS = 50 * 60 * 1_000;
const START_TIMEOUT_MS = 15_000;
const OPENAI_CONNECT_TIMEOUT_MS = 15_000;
const MAX_BUFFERED_MEDIA_FRAMES = 250;

function parseJson<T>(value: unknown): T | null {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function socketOpen(socket: WebSocket | null | undefined) {
  return Boolean(socket && socket.readyState === WebSocket.OPEN);
}

function sendJson(socket: WebSocket | null | undefined, value: unknown) {
  if (!socketOpen(socket)) return false;
  socket!.send(JSON.stringify(value));
  return true;
}

function closeSocket(socket: WebSocket | null | undefined, code = 1000, reason = "complete") {
  if (!socket || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) return;
  try {
    socket.close(code, reason.slice(0, 120));
  } catch {
    // The remote peer may already be gone.
  }
}

function baseUrl(environment: Env) {
  const url = new URL(environment.SITE_BASE_URL);
  if (url.protocol !== "https:") throw new Error("SITE_BASE_URL must use HTTPS.");
  return url;
}

async function bridgeRequest<T>(
  environment: Env,
  path: "start" | "events",
  token: string,
  payload: Record<string, unknown>,
) {
  const url = new URL(`/api/talk/phone/bridge/${path}`, baseUrl(environment));
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "DawarTodoVoiceRelay/1.0",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) {
    throw new Error(body.error || `Sites bridge failed (${response.status}).`);
  }
  return body;
}

function realtimeSocket(model: string, clientSecret: string) {
  const url = new URL("wss://api.openai.com/v1/realtime");
  url.searchParams.set("model", model);
  return new WebSocket(url, [
    "realtime",
    `openai-insecure-api-key.${clientSecret}`,
  ]);
}

function runPhoneBridge(
  twilio: WebSocket,
  environment: Env,
  context: ExecutionContext,
) {
  let callSid = "";
  let streamSid = "";
  let token = "";
  let talkSessionId = "";
  let focusedTodoId: number | null = null;
  let model = "";
  let openAI: WebSocket | null = null;
  let ending = false;
  let initialized = false;
  let initializing = false;
  let heartbeatRunning = false;
  let lastHeartbeatAt = 0;
  let lastAddressedSpeechAt = Date.now();
  let bufferedMedia: string[] = [];
  let toolQueue = Promise.resolve();
  let startupTimer: ReturnType<typeof setTimeout> | null = null;
  let rolloverTimer: ReturnType<typeof setTimeout> | null = null;
  const acceptedAt = Date.now();

  const eventRequest = <T = BridgeResult>(
    action: string,
    body: Record<string, unknown> = {},
  ) => bridgeRequest<T>(environment, "events", token, {
    action,
    callSid,
    focusedTodoId,
    ...body,
  });

  const heartbeat = async () => {
    if (
      !initialized
      || ending
      || heartbeatRunning
      || Date.now() - lastHeartbeatAt < 10_000
    ) {
      return;
    }
    heartbeatRunning = true;
    try {
      await eventRequest("heartbeat");
      lastHeartbeatAt = Date.now();
    } finally {
      heartbeatRunning = false;
    }
  };

  const persistMessage = (
    role: "user" | "assistant",
    realtimeItemId: string,
    content: string,
  ) => {
    if (!content.trim() || ending) return;
    context.waitUntil(
      eventRequest("message", {
        role,
        realtimeItemId,
        content,
      }).catch((error) => {
        console.error("[voice-relay] transcript persistence failed", {
          callSid: callSid || null,
          talkSessionId: talkSessionId || null,
          role,
          contentLength: content.length,
          error,
        });
      }),
    );
  };

  const finish = async (
    status: "completed" | "failed",
    reason: string,
  ) => {
    if (ending) return;
    ending = true;
    if (startupTimer) clearTimeout(startupTimer);
    if (rolloverTimer) clearTimeout(rolloverTimer);
    closeSocket(openAI, status === "completed" ? 1000 : 1011, reason);
    closeSocket(twilio, status === "completed" ? 1000 : 1011, reason);
    if (callSid && token) {
      await eventRequest("end", { status, reason }).catch((error) => {
        console.error("[voice-relay] Sites end notification failed", {
          callSid,
          talkSessionId: talkSessionId || null,
          status,
          reason,
          error,
        });
      });
    }
    console.info("[voice-relay] call bridge ended", {
      callSid: callSid || null,
      talkSessionId: talkSessionId || null,
      status,
      reason,
      durationMs: Date.now() - acceptedAt,
    });
  };

  const sendToolOutput = (callId: string, result: BridgeResult) => {
    sendJson(openAI, {
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(result),
      },
    });
  };

  const runTool = async (tool: {
    call_id?: string;
    name?: string;
    arguments?: string;
  }) => {
    const callId = String(tool.call_id ?? "").trim();
    const name = String(tool.name ?? "").trim();
    if (!callId || !name) return;
    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(tool.arguments || "{}") as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      args = {};
    }
    try {
      const result = await eventRequest<BridgeResult>("tool", {
        callId,
        name,
        arguments: args,
      });
      if (typeof result.focusedTodoId === "number" || result.focusedTodoId === null) {
        focusedTodoId = result.focusedTodoId;
      }
      sendToolOutput(callId, result);
      console.info("[voice-relay] tool result delivered", {
        callSid,
        talkSessionId,
        callId,
        name,
        focusedTodoId,
      });
    } catch (error) {
      sendToolOutput(callId, {
        error: error instanceof Error ? error.message : "That action did not complete.",
      });
      console.error("[voice-relay] tool dispatch failed", {
        callSid,
        talkSessionId,
        callId,
        name,
        error,
      });
    }
  };

  const handleRealtimeEvent = (raw: unknown) => {
    const event = parseJson<RealtimeEvent>(raw);
    if (!event?.type) return;
    if (event.type === "response.output_audio.delta" && event.delta) {
      sendJson(twilio, {
        event: "media",
        streamSid,
        media: { payload: event.delta },
      });
      return;
    }
    if (event.type === "input_audio_buffer.speech_started") {
      sendJson(twilio, { event: "clear", streamSid });
      return;
    }
    if (event.type.includes("input_audio_transcription.completed")) {
      const transcript = String(event.transcript ?? "").trim();
      if (transcript) {
        lastAddressedSpeechAt = Date.now();
        persistMessage("user", event.item_id ?? crypto.randomUUID(), transcript);
      }
      return;
    }
    if (event.type.includes("output_audio_transcript.done")) {
      const transcript = String(event.transcript ?? "").trim();
      if (transcript) {
        persistMessage(
          "assistant",
          event.item_id ?? event.response?.id ?? crypto.randomUUID(),
          transcript,
        );
      }
      return;
    }
    if (event.type === "response.done") {
      const tools = event.response?.output?.filter((item) => item.type === "function_call") ?? [];
      if (tools.length) {
        toolQueue = toolQueue
          .then(async () => {
            for (const tool of tools) await runTool(tool);
            sendJson(openAI, { type: "response.create" });
          })
          .catch((error) => {
            console.error("[voice-relay] tool queue failed", {
              callSid,
              talkSessionId,
              error,
            });
          });
      }
      return;
    }
    if (event.type === "error") {
      console.error("[voice-relay] OpenAI Realtime error", {
        callSid,
        talkSessionId,
        code: event.error?.code ?? null,
        message: event.error?.message ?? "unknown",
      });
    }
  };

  const connectRealtime = async (
    credentials: { clientSecret: string; model: string },
    rollover = false,
  ) => {
    const previous = openAI;
    const next = realtimeSocket(credentials.model, credentials.clientSecret);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("OpenAI Realtime connection timed out.")),
        OPENAI_CONNECT_TIMEOUT_MS,
      );
      next.addEventListener("message", (message) => handleRealtimeEvent(message.data));
      next.addEventListener("open", () => {
        clearTimeout(timer);
        openAI = next;
        resolve();
      }, { once: true });
      next.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("OpenAI Realtime connection failed."));
      }, { once: true });
      next.addEventListener("close", () => {
        if (!ending && next === openAI) {
          context.waitUntil(finish("failed", "openai-disconnected"));
        }
      });
    });
    if (rollover) {
      closeSocket(previous, 1000, "session-rollover");
      sendJson(openAI, {
        type: "response.create",
        response: {
          instructions: "Continue seamlessly. Say nothing unless the user is waiting for a response.",
        },
      });
    } else {
      const pending = bufferedMedia;
      bufferedMedia = [];
      for (const audio of pending) {
        sendJson(openAI, { type: "input_audio_buffer.append", audio });
      }
      sendJson(openAI, {
        type: "response.create",
        response: {
          instructions: "Start immediately with one terse, useful question about the focused task. No greeting or capability explanation.",
        },
      });
      console.info("[voice-relay] OpenAI Realtime connected", {
        callSid,
        talkSessionId,
        model: credentials.model,
        bufferedFrames: pending.length,
        startupMs: Date.now() - acceptedAt,
      });
    }
    if (rolloverTimer) clearTimeout(rolloverTimer);
    rolloverTimer = setTimeout(() => {
      context.waitUntil((async () => {
        const credentials = await eventRequest<{
          clientSecret: string;
          model: string;
        }>("rollover");
        await connectRealtime(credentials, true);
        console.info("[voice-relay] OpenAI Realtime session rolled over", {
          callSid,
          talkSessionId,
        });
      })().catch((error) => {
        console.error("[voice-relay] OpenAI Realtime rollover failed", {
          callSid,
          talkSessionId,
          error,
        });
        return finish("failed", "realtime-rollover-failed");
      }));
    }, REALTIME_ROLLOVER_MS);
  };

  const initialize = async (start: TwilioStart | undefined) => {
    if (initializing || initialized) return;
    initializing = true;
    try {
      callSid = String(start?.callSid ?? "").trim();
      streamSid = String(start?.streamSid ?? "").trim();
      token = String(start?.customParameters?.token ?? "").trim();
      if (!callSid || !streamSid || token.length < 32) {
        throw new Error("Twilio stream metadata was rejected.");
      }
      const bridge = await bridgeRequest<BridgeStart>(
        environment,
        "start",
        token,
        {
          accountSid: start?.accountSid,
          callSid,
          mediaFormat: start?.mediaFormat,
        },
      );
      talkSessionId = bridge.talkSessionId;
      focusedTodoId = bridge.focusedTodoId;
      model = bridge.model;
      initialized = true;
      await connectRealtime(bridge);
      if (startupTimer) {
        clearTimeout(startupTimer);
        startupTimer = null;
      }
      await heartbeat();
      console.info("[voice-relay] authenticated Twilio stream started", {
        callSid,
        streamSid,
        talkSessionId,
        focusedTodoId,
        model,
        startupMs: Date.now() - acceptedAt,
      });
    } catch (error) {
      console.error("[voice-relay] call startup failed", {
        callSid: callSid || null,
        streamSid: streamSid || null,
        talkSessionId: talkSessionId || null,
        durationMs: Date.now() - acceptedAt,
        error,
      });
      await finish("failed", "startup-failed");
    } finally {
      initializing = false;
    }
  };

  twilio.addEventListener("message", (message) => {
    const event = parseJson<TwilioEvent>(message.data);
    if (!event?.event) return;
    if (event.event === "start") {
      context.waitUntil(initialize("start" in event ? event.start : undefined));
      return;
    }
    if (event.event === "media") {
      const audio = "media" in event ? event.media?.payload : undefined;
      if (!audio) return;
      if (Date.now() - lastAddressedSpeechAt >= PHONE_IDLE_LIMIT_MS) {
        sendJson(openAI, {
          type: "response.create",
          response: {
            instructions: "Say only: Ending the call after fifteen minutes without a response.",
          },
        });
        setTimeout(() => context.waitUntil(finish("completed", "idle-timeout")), 2_000);
        return;
      }
      if (!initialized || !socketOpen(openAI)) {
        if (bufferedMedia.length < MAX_BUFFERED_MEDIA_FRAMES) bufferedMedia.push(audio);
        return;
      }
      sendJson(openAI, { type: "input_audio_buffer.append", audio });
      context.waitUntil(heartbeat().catch((error) => {
        console.error("[voice-relay] heartbeat failed", {
          callSid,
          talkSessionId,
          error,
        });
        return finish("failed", "session-replaced");
      }));
      return;
    }
    if (event.event === "stop") context.waitUntil(finish("completed", "caller-ended"));
  });
  twilio.addEventListener("close", () => {
    if (!ending) context.waitUntil(finish("completed", "twilio-disconnected"));
  });
  twilio.addEventListener("error", () => {
    if (!ending) context.waitUntil(finish("failed", "twilio-connection-error"));
  });

  startupTimer = setTimeout(() => {
    if (!initialized && !ending) {
      console.error("[voice-relay] Twilio start event timed out", {
        callSid: callSid || null,
        streamSid: streamSid || null,
        durationMs: Date.now() - acceptedAt,
      });
      context.waitUntil(finish("failed", "twilio-start-timeout"));
    }
  }, START_TIMEOUT_MS);
}

const worker = {
  async fetch(request: Request, environment: Env, context: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "dawar-todo-voice-relay",
        siteHost: baseUrl(environment).host,
        directSip: {
          controllerBound: Boolean(environment.SIP_CONTROLLERS),
          openAIConfigured: Boolean(environment.OPENAI_API_KEY?.trim()),
          projectConfigured: Boolean(environment.OPENAI_PROJECT_ID?.trim()),
        },
      }, {
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (url.pathname === "/openai/webhook") {
      return handleOpenAISipWebhook(request, environment, context);
    }
    if (url.pathname !== "/stream") return new Response("Not found.", { status: 404 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required.", {
        status: 426,
        headers: { "Cache-Control": "no-store" },
      });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const twilio = pair[1];
    twilio.accept();
    runPhoneBridge(twilio, environment, context);
    console.info("[voice-relay] inbound WebSocket accepted", {
      colo: request.cf?.colo ?? null,
      userAgent: request.headers.get("user-agent")?.slice(0, 80) ?? null,
    });
    return new Response(null, {
      status: 101,
      webSocket: client,
    } as ResponseInit & { webSocket: WebSocket }) as WorkerResponse;
  },
  async scheduled(controller: ScheduledController, environment: Env, context: ExecutionContext) {
    const secret = environment.TODO_MAINTENANCE_SECRET?.trim();
    if (!secret) {
      console.error("[todo-maintenance-relay] scheduled trigger skipped because the shared secret is missing");
      return;
    }
    const scheduledAt = new Date(controller.scheduledTime);
    context.waitUntil((async () => {
      const url = new URL("/api/internal/minute", baseUrl(environment));
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
          "User-Agent": "DawarTodoMaintenance/1.0",
        },
        body: JSON.stringify({ scheduledAt: scheduledAt.toISOString() }),
        signal: AbortSignal.timeout(50_000),
      });
      const payload = await response.json().catch(() => ({})) as {
        error?: string;
        snoozedWoken?: number;
        push?: { events?: number; sent?: number; failed?: number };
      };
      if (!response.ok) {
        throw new Error(payload.error || `Sites maintenance failed (${response.status}).`);
      }
      console.info("[todo-maintenance-relay] scheduled minute completed", {
        cron: controller.cron,
        scheduledAt: scheduledAt.toISOString(),
        snoozedWoken: payload.snoozedWoken ?? 0,
        pushEvents: payload.push?.events ?? 0,
        pushSent: payload.push?.sent ?? 0,
        pushFailed: payload.push?.failed ?? 0,
      });
    })().catch((error) => {
      console.error("[todo-maintenance-relay] scheduled minute failed", {
        cron: controller.cron,
        scheduledAt: scheduledAt.toISOString(),
        error,
      });
    }));
  },
};

export { SipCallController };
export default worker;
