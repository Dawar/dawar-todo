export interface SipRelayEnvironment {
  SITE_BASE_URL: string;
  OPENAI_API_KEY?: string;
  OPENAI_PROJECT_ID?: string;
  SIP_CONTROLLERS: DurableObjectNamespace;
}

type OpenAIWebhook = {
  id?: string;
  type?: string;
  data?: {
    call_id?: string;
    sip_headers?: Array<{ name?: string; value?: string }>;
  };
};

type SipBridgeStart = {
  talkSessionId: string;
  providerCallId: string;
  focusedTodoId: number | null;
  safetyIdentifier: string;
  session: Record<string, unknown>;
};

type BridgeResult = Record<string, unknown> & {
  focusedTodoId?: number | null;
};

type RealtimeEvent = {
  type?: string;
  item_id?: string;
  transcript?: string;
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

type ControllerState = {
  callSid: string;
  providerCallId: string;
  token: string;
  talkSessionId: string;
  focusedTodoId: number | null;
  lastAddressedSpeechAt: number;
  startedAt: number;
  ended: boolean;
  reconnectAttempts: number;
};

type WorkerResponse = Response & { webSocket?: WebSocket };

const PHONE_IDLE_LIMIT_MS = 15 * 60 * 1_000;
const HEARTBEAT_INTERVAL_MS = 60_000;
const OPENAI_CONNECT_TIMEOUT_MS = 15_000;
const MAX_RECONNECT_ATTEMPTS = 4;
const STATE_KEY = "sip-call";

function siteBaseUrl(environment: SipRelayEnvironment) {
  const url = new URL(environment.SITE_BASE_URL);
  if (url.protocol !== "https:") throw new Error("SITE_BASE_URL must use HTTPS.");
  return url;
}

function openAIHeaders(environment: SipRelayEnvironment, safetyIdentifier?: string) {
  const apiKey = environment.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("The direct SIP controller is missing OPENAI_API_KEY.");
  return {
    Authorization: `Bearer ${apiKey}`,
    ...(environment.OPENAI_PROJECT_ID?.trim()
      ? { "OpenAI-Project": environment.OPENAI_PROJECT_ID.trim() }
      : {}),
    ...(safetyIdentifier
      ? { "OpenAI-Safety-Identifier": safetyIdentifier }
      : {}),
  };
}

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

async function bridgeRequest<T>(
  environment: SipRelayEnvironment,
  path: "sip/start" | "events",
  token: string,
  payload: Record<string, unknown>,
) {
  const url = new URL(`/api/talk/phone/bridge/${path}`, siteBaseUrl(environment));
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "DawarTodoSipController/1.0",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) {
    throw new Error(body.error || `Sites SIP bridge failed (${response.status}).`);
  }
  return body;
}

function sipHeader(event: OpenAIWebhook, name: string) {
  return event.data?.sip_headers?.find(
    (header) => header.name?.trim().toLowerCase() === name.toLowerCase(),
  )?.value?.trim() ?? "";
}

async function acceptOpenAICall(
  environment: SipRelayEnvironment,
  bridge: SipBridgeStart,
) {
  const startedAt = Date.now();
  const response = await fetch(
    `https://api.openai.com/v1/realtime/calls/${encodeURIComponent(bridge.providerCallId)}/accept`,
    {
      method: "POST",
      headers: {
        ...openAIHeaders(environment, bridge.safetyIdentifier),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(bridge.session),
      signal: AbortSignal.timeout(20_000),
    },
  );
  const body = await response.text();
  if (!response.ok) {
    const replayed = response.status === 409
      || /already (?:accepted|connected|exists)/i.test(body);
    if (!replayed) {
      throw new Error(`OpenAI SIP accept failed (${response.status}): ${body.slice(0, 500)}`);
    }
    console.info("[voice-relay-sip] duplicate accept treated as idempotent", {
      providerCallId: bridge.providerCallId,
      status: response.status,
      durationMs: Date.now() - startedAt,
    });
    return;
  }
  console.info("[voice-relay-sip] OpenAI SIP call accepted", {
    providerCallId: bridge.providerCallId,
    talkSessionId: bridge.talkSessionId,
    durationMs: Date.now() - startedAt,
  });
}

async function rejectOpenAICall(
  environment: SipRelayEnvironment,
  providerCallId: string,
  statusCode = 603,
) {
  if (!providerCallId) return;
  await fetch(
    `https://api.openai.com/v1/realtime/calls/${encodeURIComponent(providerCallId)}/reject`,
    {
      method: "POST",
      headers: {
        ...openAIHeaders(environment),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status_code: statusCode }),
      signal: AbortSignal.timeout(10_000),
    },
  ).catch((error) => {
    console.error("[voice-relay-sip] failed to reject SIP call after startup error", {
      providerCallId,
      error,
    });
  });
}

export async function handleOpenAISipWebhook(
  request: Request,
  environment: SipRelayEnvironment,
  context: ExecutionContext,
) {
  const startedAt = Date.now();
  let providerCallId = "";
  let callSid = "";
  try {
    if (request.method !== "POST") return new Response("Method not allowed.", { status: 405 });
    const event = await request.json() as OpenAIWebhook;
    if (event.type !== "realtime.call.incoming") {
      console.info("[voice-relay-sip] ignored unrelated OpenAI webhook", {
        eventType: event.type ?? null,
        webhookId: request.headers.get("webhook-id") ?? event.id ?? null,
      });
      return Response.json({ received: true });
    }
    providerCallId = String(event.data?.call_id ?? "").trim();
    callSid = sipHeader(event, "x-dawar-call-sid");
    const token = sipHeader(event, "x-dawar-token");
    if (
      !/^rtc_[A-Za-z0-9_-]{8,200}$/.test(providerCallId)
      || !/^CA[0-9a-f]{32}$/i.test(callSid)
      || token.length < 32
    ) {
      console.warn("[voice-relay-sip] incoming SIP webhook lacked authenticated routing headers", {
        providerCallId: providerCallId || null,
        callSid: callSid || null,
        tokenPresent: Boolean(token),
        signaturePresent: Boolean(request.headers.get("webhook-signature")),
      });
      await rejectOpenAICall(environment, providerCallId, 403);
      return Response.json({ error: "Authenticated SIP routing headers are required." }, { status: 403 });
    }

    // The 256-bit, one-time token was minted only after the Twilio PIN passed.
    // The Sites bridge atomically consumes it, which authenticates the webhook
    // even if the OpenAI project webhook signing secret is managed elsewhere.
    const bridge = await bridgeRequest<SipBridgeStart>(
      environment,
      "sip/start",
      token,
      { callSid, providerCallId },
    );
    await acceptOpenAICall(environment, bridge);

    const controllerId = environment.SIP_CONTROLLERS.idFromName(providerCallId);
    const controller = environment.SIP_CONTROLLERS.get(controllerId);
    context.waitUntil(controller.fetch("https://sip-controller/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callSid,
        providerCallId,
        token,
        talkSessionId: bridge.talkSessionId,
        focusedTodoId: bridge.focusedTodoId,
      }),
    }).then(async (response) => {
      if (!response.ok) {
        throw new Error(`SIP controller start failed (${response.status}): ${await response.text()}`);
      }
    }).catch(async (error) => {
      console.error("[voice-relay-sip] sideband controller failed after accept", {
        providerCallId,
        callSid,
        talkSessionId: bridge.talkSessionId,
        error,
      });
      await fetch(
        `https://api.openai.com/v1/realtime/calls/${encodeURIComponent(providerCallId)}/hangup`,
        {
          method: "POST",
          headers: openAIHeaders(environment),
          signal: AbortSignal.timeout(10_000),
        },
      ).catch(() => undefined);
    }));
    console.info("[voice-relay-sip] incoming SIP webhook authorized", {
      providerCallId,
      callSid,
      talkSessionId: bridge.talkSessionId,
      signaturePresent: Boolean(request.headers.get("webhook-signature")),
      durationMs: Date.now() - startedAt,
    });
    return Response.json({ received: true });
  } catch (error) {
    console.error("[voice-relay-sip] incoming SIP webhook failed", {
      providerCallId: providerCallId || null,
      callSid: callSid || null,
      durationMs: Date.now() - startedAt,
      error,
    });
    await rejectOpenAICall(environment, providerCallId);
    return Response.json({ error: "The direct SIP call could not start." }, { status: 503 });
  }
}

export class SipCallController {
  private socket: WebSocket | null = null;
  private state: ControllerState | null = null;
  private connecting: Promise<void> | null = null;
  private toolQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly durableState: DurableObjectState,
    private readonly environment: SipRelayEnvironment,
  ) {}

  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === "/start" && request.method === "POST") {
      const payload = await request.json() as Partial<ControllerState>;
      if (
        !/^CA[0-9a-f]{32}$/i.test(String(payload.callSid ?? ""))
        || !/^rtc_[A-Za-z0-9_-]{8,200}$/.test(String(payload.providerCallId ?? ""))
        || String(payload.token ?? "").length < 32
        || !String(payload.talkSessionId ?? "").trim()
      ) {
        return new Response("Invalid controller metadata.", { status: 400 });
      }
      const existing = await this.readState();
      this.state = {
        callSid: String(payload.callSid),
        providerCallId: String(payload.providerCallId),
        token: String(payload.token),
        talkSessionId: String(payload.talkSessionId),
        focusedTodoId: typeof payload.focusedTodoId === "number" ? payload.focusedTodoId : null,
        lastAddressedSpeechAt: existing?.lastAddressedSpeechAt ?? Date.now(),
        startedAt: existing?.startedAt ?? Date.now(),
        ended: false,
        reconnectAttempts: 0,
      };
      await this.persistState();
      await this.connect();
      await this.durableState.storage.setAlarm(Date.now() + HEARTBEAT_INTERVAL_MS);
      return Response.json({ connected: true });
    }
    if (url.pathname === "/status") {
      const state = await this.readState();
      return Response.json({
        active: Boolean(state && !state.ended),
        connected: socketOpen(this.socket),
        providerCallId: state?.providerCallId ?? null,
      });
    }
    return new Response("Not found.", { status: 404 });
  }

  async alarm() {
    const state = await this.readState();
    if (!state || state.ended) return;
    if (Date.now() - state.lastAddressedSpeechAt >= PHONE_IDLE_LIMIT_MS) {
      sendJson(this.socket, {
        type: "response.create",
        response: {
          instructions: "Say only: Ending the call after fifteen minutes without a response.",
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      await this.finish("completed", "idle-timeout", true);
      return;
    }
    if (!socketOpen(this.socket)) {
      await this.connect().catch((error) => {
        console.error("[voice-relay-sip] alarm reconnect failed", {
          providerCallId: state.providerCallId,
          callSid: state.callSid,
          attempt: state.reconnectAttempts,
          error,
        });
      });
    }
    await this.eventRequest("heartbeat").catch((error) => {
      console.error("[voice-relay-sip] Sites heartbeat failed", {
        providerCallId: state.providerCallId,
        callSid: state.callSid,
        talkSessionId: state.talkSessionId,
        error,
      });
    });
    if (this.state && !this.state.ended) {
      await this.durableState.storage.setAlarm(Date.now() + HEARTBEAT_INTERVAL_MS);
    }
  }

  private async readState() {
    if (this.state) return this.state;
    this.state = await this.durableState.storage.get<ControllerState>(STATE_KEY) ?? null;
    return this.state;
  }

  private async persistState() {
    if (this.state) await this.durableState.storage.put(STATE_KEY, this.state);
  }

  private async eventRequest<T = BridgeResult>(
    action: string,
    body: Record<string, unknown> = {},
  ) {
    const state = await this.readState();
    if (!state) throw new Error("The SIP controller state is unavailable.");
    return bridgeRequest<T>(this.environment, "events", state.token, {
      action,
      callSid: state.callSid,
      focusedTodoId: state.focusedTodoId,
      transport: "twilio-openai-sip",
      ...body,
    });
  }

  private async openRealtimeSocket(providerCallId: string) {
    const url = new URL("https://api.openai.com/v1/realtime");
    url.searchParams.set("call_id", providerCallId);
    const response = await fetch(url, {
      headers: {
        ...openAIHeaders(this.environment),
        Upgrade: "websocket",
      },
    }) as WorkerResponse;
    if (response.status !== 101 || !response.webSocket) {
      throw new Error(`OpenAI SIP sideband connection failed (${response.status}).`);
    }
    response.webSocket.accept();
    return response.webSocket;
  }

  private async connect() {
    if (socketOpen(this.socket)) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const state = await this.readState();
      if (!state || state.ended) throw new Error("The SIP call has ended.");
      const startedAt = Date.now();
      const reconnect = state.reconnectAttempts > 0;
      const socketPromise = this.openRealtimeSocket(state.providerCallId);
      const timeout = new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error("OpenAI SIP sideband connection timed out.")),
          OPENAI_CONNECT_TIMEOUT_MS,
        );
      });
      const socket = await Promise.race([socketPromise, timeout]);
      this.socket = socket;
      state.reconnectAttempts = 0;
      await this.persistState();
      socket.addEventListener("message", (message) => {
        this.durableState.waitUntil(this.handleRealtimeEvent(message.data));
      });
      socket.addEventListener("close", (event) => {
        if (this.socket === socket) this.socket = null;
        this.durableState.waitUntil(this.handleSocketClose(event.code, event.reason));
      });
      socket.addEventListener("error", () => {
        console.error("[voice-relay-sip] OpenAI sideband socket error", {
          providerCallId: state.providerCallId,
          callSid: state.callSid,
          talkSessionId: state.talkSessionId,
        });
      });
      sendJson(socket, {
        type: "response.create",
        response: {
          instructions: "Start immediately with one terse, useful question about the focused task. No greeting or capability explanation.",
        },
      });
      console.info("[voice-relay-sip] OpenAI SIP sideband connected", {
        providerCallId: state.providerCallId,
        callSid: state.callSid,
        talkSessionId: state.talkSessionId,
        reconnect,
        connectMs: Date.now() - startedAt,
      });
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async handleSocketClose(code: number, reason: string) {
    const state = await this.readState();
    if (!state || state.ended) return;
    if (code === 1000 || /call|hangup|completed|ended/i.test(reason)) {
      await this.finish("completed", "sip-call-ended", false);
      return;
    }
    state.reconnectAttempts += 1;
    await this.persistState();
    console.warn("[voice-relay-sip] OpenAI sideband disconnected; reconnect scheduled", {
      providerCallId: state.providerCallId,
      callSid: state.callSid,
      talkSessionId: state.talkSessionId,
      code,
      reason: reason.slice(0, 120),
      attempt: state.reconnectAttempts,
    });
    if (state.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      await this.finish("failed", "sideband-reconnect-limit", true);
      return;
    }
    await this.durableState.storage.setAlarm(
      Date.now() + Math.min(10_000, 1_000 * 2 ** (state.reconnectAttempts - 1)),
    );
  }

  private persistMessage(
    role: "user" | "assistant",
    realtimeItemId: string,
    content: string,
  ) {
    if (!content.trim()) return;
    this.durableState.waitUntil(
      this.eventRequest("message", {
        role,
        realtimeItemId,
        content,
      }).catch(async (error) => {
        const state = await this.readState();
        console.error("[voice-relay-sip] transcript persistence failed", {
          providerCallId: state?.providerCallId ?? null,
          callSid: state?.callSid ?? null,
          talkSessionId: state?.talkSessionId ?? null,
          role,
          contentLength: content.length,
          error,
        });
      }),
    );
  }

  private async runTool(tool: {
    call_id?: string;
    name?: string;
    arguments?: string;
  }) {
    const state = await this.readState();
    if (!state || state.ended) return;
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
    let result: BridgeResult;
    try {
      result = await this.eventRequest<BridgeResult>("tool", {
        callId,
        name,
        arguments: args,
      });
      if (typeof result.focusedTodoId === "number" || result.focusedTodoId === null) {
        state.focusedTodoId = result.focusedTodoId;
        await this.persistState();
      }
      console.info("[voice-relay-sip] tool result delivered", {
        providerCallId: state.providerCallId,
        callSid: state.callSid,
        talkSessionId: state.talkSessionId,
        callId,
        name,
        focusedTodoId: state.focusedTodoId,
      });
    } catch (error) {
      result = {
        error: error instanceof Error ? error.message : "That action did not complete.",
      };
      console.error("[voice-relay-sip] tool dispatch failed", {
        providerCallId: state.providerCallId,
        callSid: state.callSid,
        talkSessionId: state.talkSessionId,
        callId,
        name,
        error,
      });
    }
    sendJson(this.socket, {
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(result),
      },
    });
  }

  private async handleRealtimeEvent(raw: unknown) {
    const event = parseJson<RealtimeEvent>(raw);
    if (!event?.type) return;
    const state = await this.readState();
    if (!state || state.ended) return;
    if (event.type.includes("input_audio_transcription.completed")) {
      const transcript = String(event.transcript ?? "").trim();
      if (transcript) {
        state.lastAddressedSpeechAt = Date.now();
        await this.persistState();
        this.persistMessage("user", event.item_id ?? crypto.randomUUID(), transcript);
      }
      return;
    }
    if (event.type.includes("output_audio_transcript.done")) {
      const transcript = String(event.transcript ?? "").trim();
      if (transcript) {
        this.persistMessage(
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
        this.toolQueue = this.toolQueue.then(async () => {
          for (const tool of tools) await this.runTool(tool);
          sendJson(this.socket, { type: "response.create" });
        }).catch((error) => {
          console.error("[voice-relay-sip] tool queue failed", {
            providerCallId: state.providerCallId,
            callSid: state.callSid,
            talkSessionId: state.talkSessionId,
            error,
          });
        });
      }
      return;
    }
    if (event.type === "error") {
      console.error("[voice-relay-sip] OpenAI Realtime error", {
        providerCallId: state.providerCallId,
        callSid: state.callSid,
        talkSessionId: state.talkSessionId,
        code: event.error?.code ?? null,
        message: event.error?.message ?? "unknown",
      });
    }
  }

  private async finish(
    status: "completed" | "failed",
    reason: string,
    hangup: boolean,
  ) {
    const state = await this.readState();
    if (!state || state.ended) return;
    state.ended = true;
    await this.persistState();
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) {
      try {
        this.socket.close(status === "completed" ? 1000 : 1011, reason.slice(0, 120));
      } catch {
        // The OpenAI sideband may already be closed.
      }
    }
    this.socket = null;
    await this.eventRequest("end", { status, reason }).catch((error) => {
      console.error("[voice-relay-sip] Sites end notification failed", {
        providerCallId: state.providerCallId,
        callSid: state.callSid,
        talkSessionId: state.talkSessionId,
        status,
        reason,
        error,
      });
    });
    if (hangup) {
      await fetch(
        `https://api.openai.com/v1/realtime/calls/${encodeURIComponent(state.providerCallId)}/hangup`,
        {
          method: "POST",
          headers: openAIHeaders(this.environment),
          signal: AbortSignal.timeout(10_000),
        },
      ).catch((error) => {
        console.error("[voice-relay-sip] OpenAI hangup failed", {
          providerCallId: state.providerCallId,
          callSid: state.callSid,
          error,
        });
      });
    }
    await this.durableState.storage.deleteAlarm();
    console.info("[voice-relay-sip] direct SIP call ended", {
      providerCallId: state.providerCallId,
      callSid: state.callSid,
      talkSessionId: state.talkSessionId,
      status,
      reason,
      durationMs: Date.now() - state.startedAt,
    });
  }
}
