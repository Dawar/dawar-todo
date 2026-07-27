import {
  appendTalkMessage,
  beginTalkToolCall,
  chooseTalkFocus,
  completeTalkToolCall,
  endTalkSession,
  heartbeatTalkSession,
  listTalkHistory,
  readTalkWorkspace,
  startTalkSession,
} from "../db/talk";
import {
  attachTalkSessionToPhoneCall,
  consumeTalkPhoneStream,
  endTalkPhoneCall,
} from "../db/talk-phone";
import { getTodoSettings, listTodos } from "../db/todos";
import type { RealtimeVoice } from "../lib/ai-preferences";
import { buildSharedAssistantContext } from "../lib/assistant-context";
import {
  hashedSafetyIdentifier,
  talkInstructions,
  talkRuntimeConfig,
  talkToolDefinitions,
} from "../lib/talk-runtime";
import { dispatchTalkTool, type TalkToolResult } from "../lib/talk-tools";
import { validateTwilioRequest } from "../lib/twilio-phone";

type PhoneStreamEnvironment = {
  DB: D1Database;
  OPENAI_API_KEY?: string;
  OPENAI_PROJECT_ID?: string;
  OPENAI_REALTIME_MODEL?: string;
  OPENAI_REALTIME_VOICE?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_PHONE_NUMBER?: string;
};

type TwilioStartEvent = {
  event: "start";
  start?: {
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
};

type TwilioMediaEvent = {
  event: "media";
  streamSid?: string;
  media?: { payload?: string };
};

type TwilioStopEvent = {
  event: "stop";
  streamSid?: string;
};

type TwilioEvent =
  | { event: "connected" }
  | TwilioStartEvent
  | TwilioMediaEvent
  | TwilioStopEvent
  | { event?: string };

type OpenAIEvent = {
  type?: string;
  item_id?: string;
  transcript?: string;
  delta?: string;
  error?: { message?: string; code?: string };
  response?: {
    id?: string;
    status?: string;
    output?: Array<{
      type?: string;
      call_id?: string;
      name?: string;
      arguments?: string;
    }>;
  };
};

type WorkerResponse = Response & { webSocket?: WebSocket };

const PHONE_IDLE_LIMIT_MS = 15 * 60 * 1_000;
const REALTIME_ROLLOVER_MS = 50 * 60 * 1_000;
const TWILIO_START_TIMEOUT_MS = 15_000;
const MAX_BUFFERED_TWILIO_FRAMES = 250;

function openSocket(socket: WebSocket | null | undefined) {
  return Boolean(socket && socket.readyState === WebSocket.OPEN);
}

function parseJson<T>(value: unknown): T | null {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function sendJson(socket: WebSocket | null | undefined, value: unknown) {
  if (!openSocket(socket)) return false;
  socket!.send(JSON.stringify(value));
  return true;
}

function resultSummary(result: TalkToolResult, fallback: string) {
  const message = typeof result.message === "string" ? result.message : null;
  const readback = typeof result.readback === "string" ? result.readback : null;
  return (message || readback || fallback).slice(0, 40_000);
}

function webSocketClose(socket: WebSocket | null | undefined, code = 1000, reason = "complete") {
  if (!socket || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) return;
  try {
    socket.close(code, reason.slice(0, 120));
  } catch {
    // The peer may already be closing.
  }
}

async function openOpenAIRealtimeSocket(
  environment: PhoneStreamEnvironment,
  input: {
    model: string;
    safetyIdentifier: string;
  },
) {
  const apiKey = environment.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OpenAI Realtime is not configured.");
  const url = new URL("https://api.openai.com/v1/realtime");
  url.searchParams.set("model", input.model);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Upgrade: "websocket",
    "OpenAI-Safety-Identifier": input.safetyIdentifier,
  };
  const projectId = environment.OPENAI_PROJECT_ID?.trim();
  if (projectId) headers["OpenAI-Project"] = projectId;
  const response = await fetch(url, { headers }) as WorkerResponse;
  const socket = response.webSocket;
  if (response.status !== 101 || !socket) {
    throw new Error(`OpenAI Realtime connection failed (${response.status}).`);
  }
  socket.accept();
  return socket;
}

export async function handleTalkPhoneStream(
  request: Request,
  environment: PhoneStreamEnvironment,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/talk/phone/stream") return null;
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("WebSocket upgrade required.", {
      status: 426,
      headers: { "Cache-Control": "no-store" },
    });
  }
  // Proxies can normalize the incoming WebSocket URL differently from the
  // exact wss:// URL Twilio signs. The 256-bit, single-use, five-minute stream
  // token remains the authoritative authentication gate in initialize().
  // Retain signature validation as useful transport telemetry without letting
  // URL normalization terminate a correctly authenticated phone call.
  const signaturePresent = Boolean(request.headers.get("x-twilio-signature")?.trim());
  const signatureValid = await validateTwilioRequest(request, null, environment)
    .catch((error) => {
      console.warn("[todo-talk-phone] stream signature validation errored", { error });
      return false;
    });
  if (!signatureValid) {
    console.warn("[todo-talk-phone] stream signature did not match; deferring to one-time token", {
      signaturePresent,
      host: url.host,
    });
  }

  const pair = new WebSocketPair();
  const client = pair[0];
  const twilio = pair[1];
  twilio.accept();

  let callSid = "";
  let streamSid = "";
  let userKey = "";
  let talkSessionId = "";
  let focusedTodoId: number | null = null;
  let realtimeVoice: RealtimeVoice | null = null;
  let openAI: WebSocket | null = null;
  let initialized = false;
  let initializing = false;
  let ending = false;
  let heartbeatRunning = false;
  let lastHeartbeatAt = 0;
  let lastAddressedSpeechAt = Date.now();
  let bufferedMedia: string[] = [];
  let toolQueue = Promise.resolve();
  let rolloverTimer: ReturnType<typeof setTimeout> | null = null;
  let startupTimer: ReturnType<typeof setTimeout> | null = null;
  const startedAt = Date.now();

  const heartbeat = async () => {
    if (!userKey || !talkSessionId || heartbeatRunning || Date.now() - lastHeartbeatAt < 10_000) return;
    heartbeatRunning = true;
    try {
      await heartbeatTalkSession(userKey, talkSessionId, focusedTodoId);
      lastHeartbeatAt = Date.now();
    } finally {
      heartbeatRunning = false;
    }
  };

  const persistMessage = async (
    role: "user" | "assistant" | "tool",
    realtimeItemId: string,
    content: string,
    metadata: Record<string, unknown> = {},
  ) => {
    if (!userKey || !talkSessionId || !content.trim()) return;
    await heartbeat();
    await appendTalkMessage({
      userKey,
      sessionId: talkSessionId,
      realtimeItemId: `phone-${talkSessionId}-${realtimeItemId}`.slice(0, 200),
      role,
      content,
      focusedTodoId,
      metadata: { transport: "twilio-phone", ...metadata },
    });
  };

  const finish = async (status: "completed" | "failed", reason: string) => {
    if (ending) return;
    ending = true;
    if (startupTimer) clearTimeout(startupTimer);
    if (rolloverTimer) clearTimeout(rolloverTimer);
    webSocketClose(openAI, status === "completed" ? 1000 : 1011, reason);
    webSocketClose(twilio, status === "completed" ? 1000 : 1011, reason);
    await Promise.all([
      callSid ? endTalkPhoneCall(callSid, status, reason, environment.DB).catch(() => undefined) : Promise.resolve(),
      userKey && talkSessionId
        ? endTalkSession(userKey, talkSessionId, `phone-${reason}`).catch(() => undefined)
        : Promise.resolve(),
    ]);
    console.info("[todo-talk-phone] media bridge ended", {
      callSid: callSid || null,
      talkSessionId: talkSessionId || null,
      status,
      reason,
      durationMs: Date.now() - startedAt,
    });
  };

  const sendToolOutput = (toolCallId: string, result: Record<string, unknown>) => {
    sendJson(openAI, {
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: toolCallId,
        output: JSON.stringify(result),
      },
    });
  };

  const runToolCall = async (tool: {
    call_id?: string;
    name?: string;
    arguments?: string;
  }) => {
    const callId = String(tool.call_id ?? "").trim();
    const name = String(tool.name ?? "").trim();
    if (!callId || !name || !userKey || !talkSessionId) return;
    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(tool.arguments || "{}") as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      args = {};
    }
    const argumentsJson = JSON.stringify(args);
    try {
      await heartbeat();
      const existing = await beginTalkToolCall({
        userKey,
        sessionId: talkSessionId,
        callId,
        name,
        argumentsJson,
      });
      if (existing.replayed && existing.result) {
        sendToolOutput(callId, existing.result);
        return;
      }
      if (existing.replayed && existing.pending) {
        sendToolOutput(callId, { error: "That action is already processing." });
        return;
      }
      const result = await dispatchTalkTool({
        userKey,
        sessionId: talkSessionId,
        callId,
        name,
        arguments: args,
      });
      if (typeof result.focusedTodoId === "number") focusedTodoId = result.focusedTodoId;
      if (result.focusedTodoId === null) focusedTodoId = null;
      await completeTalkToolCall({
        userKey,
        sessionId: talkSessionId,
        callId,
        result,
        undoToken: typeof result.undoToken === "string" ? result.undoToken : null,
      });
      await persistMessage("tool", `tool-${callId}`, resultSummary(result, name), {
        tool: name,
        undoToken: result.undoToken ?? null,
        sources: result.sources ?? [],
      });
      sendToolOutput(callId, result);
      console.info("[todo-talk-phone] tool call completed", {
        callSid,
        talkSessionId,
        callId,
        name,
        undoAvailable: Boolean(result.undoToken),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "That action did not complete.";
      await completeTalkToolCall({
        userKey,
        sessionId: talkSessionId,
        callId,
        result: { error: message },
        failed: true,
      }).catch(() => undefined);
      sendToolOutput(callId, { error: message });
      console.error("[todo-talk-phone] tool call failed", {
        callSid,
        talkSessionId,
        callId,
        name,
        error,
      });
    }
  };

  const handleOpenAIEvent = (raw: unknown) => {
    const event = parseJson<OpenAIEvent>(raw);
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
        void persistMessage("user", event.item_id ?? crypto.randomUUID(), transcript)
          .catch((error) => console.error("[todo-talk-phone] user transcript persistence failed", {
            callSid,
            talkSessionId,
            error,
          }));
      }
      return;
    }
    if (event.type.includes("output_audio_transcript.done")) {
      const transcript = String(event.transcript ?? "").trim();
      if (transcript) {
        void persistMessage("assistant", event.item_id ?? event.response?.id ?? crypto.randomUUID(), transcript)
          .catch((error) => console.error("[todo-talk-phone] assistant transcript persistence failed", {
            callSid,
            talkSessionId,
            error,
          }));
      }
      return;
    }
    if (event.type === "response.done") {
      const tools = event.response?.output?.filter((item) => item.type === "function_call") ?? [];
      if (tools.length) {
        toolQueue = toolQueue
          .then(async () => {
            for (const tool of tools) await runToolCall(tool);
            sendJson(openAI, { type: "response.create" });
          })
          .catch((error) => console.error("[todo-talk-phone] tool queue failed", {
            callSid,
            talkSessionId,
            error,
          }));
      }
      return;
    }
    if (event.type === "error") {
      console.error("[todo-talk-phone] OpenAI Realtime error", {
        callSid,
        talkSessionId,
        code: event.error?.code ?? null,
        message: event.error?.message ?? "unknown",
      });
    }
  };

  const configureOpenAI = async (instructions: string, rollover = false) => {
    const { model, voice } = talkRuntimeConfig(realtimeVoice);
    const safetyIdentifier = await hashedSafetyIdentifier(userKey);
    const next = await openOpenAIRealtimeSocket(environment, { model, safetyIdentifier });
    next.addEventListener("message", (message) => handleOpenAIEvent(message.data));
    next.addEventListener("close", () => {
      if (!ending && next === openAI) void finish("failed", "openai-disconnected");
    });
    next.addEventListener("error", () => {
      if (!ending && next === openAI) void finish("failed", "openai-connection-error");
    });
    const previous = openAI;
    openAI = next;
    sendJson(openAI, {
      type: "session.update",
      session: {
        type: "realtime",
        model,
        output_modalities: ["audio"],
        instructions,
        reasoning: { effort: "low" },
        audio: {
          input: {
            format: { type: "audio/pcmu" },
            transcription: { model: "gpt-4o-mini-transcribe", language: "en" },
            turn_detection: {
              type: "semantic_vad",
              eagerness: "auto",
              create_response: true,
              interrupt_response: true,
            },
          },
          output: { format: { type: "audio/pcmu" }, voice },
        },
        tools: talkToolDefinitions,
        tool_choice: "auto",
        truncation: "auto",
      },
    });
    if (rollover) {
      webSocketClose(previous, 1000, "session-rollover");
      sendJson(openAI, {
        type: "response.create",
        response: {
          instructions: "Continue seamlessly from the phone conversation. Say nothing unless the user is waiting for a response.",
        },
      });
    }
    rolloverTimer = setTimeout(() => {
      void (async () => {
        if (ending || !userKey || !talkSessionId) return;
        const [context, history] = await Promise.all([
          buildSharedAssistantContext(userKey, focusedTodoId),
          listTalkHistory(userKey, { limit: 40 }),
        ]);
        const recent = history.messages
          .slice(-20)
          .map((message) => `${message.role}: ${message.content.replace(/\s+/g, " ").slice(0, 400)}`)
          .join("\n");
        await configureOpenAI(
          `${talkInstructions(context)}\n\nRECENT PHONE CONVERSATION\n${recent}`,
          true,
        );
        console.info("[todo-talk-phone] OpenAI Realtime session rolled over", {
          callSid,
          talkSessionId,
        });
      })().catch((error) => {
        console.error("[todo-talk-phone] Realtime rollover failed", {
          callSid,
          talkSessionId,
          error,
        });
        void finish("failed", "realtime-rollover-failed");
      });
    }, REALTIME_ROLLOVER_MS);
  };

  const initialize = async (start: TwilioStartEvent["start"]) => {
    if (initializing || initialized) return;
    initializing = true;
    try {
      callSid = String(start?.callSid ?? "").trim();
      streamSid = String(start?.streamSid ?? "").trim();
      const accountSid = String(start?.accountSid ?? "").trim();
      const token = String(start?.customParameters?.token ?? "").trim();
      if (!callSid || !streamSid || !token || accountSid !== environment.TWILIO_ACCOUNT_SID?.trim()) {
        throw new Error("Twilio stream metadata was rejected.");
      }
      if (
        start?.mediaFormat?.encoding !== "audio/x-mulaw"
        || Number(start.mediaFormat.sampleRate) !== 8_000
        || Number(start.mediaFormat.channels) !== 1
      ) {
        throw new Error("Twilio supplied an unsupported audio format.");
      }
      const authenticated = await consumeTalkPhoneStream({ callSid, rawToken: token }, environment.DB);
      if (!authenticated) throw new Error("The phone stream token is invalid or expired.");
      userKey = authenticated.userKey;
      const [todos, workspace, settings] = await Promise.all([
        listTodos(),
        readTalkWorkspace(userKey),
        getTodoSettings(),
      ]);
      focusedTodoId = chooseTalkFocus(todos, workspace.lastFocusedTodoId);
      realtimeVoice = settings.realtimeVoice;
      const { model, voice } = talkRuntimeConfig(realtimeVoice);
      const session = await startTalkSession({ userKey, model, voice, focusedTodoId });
      talkSessionId = session.id;
      await attachTalkSessionToPhoneCall(callSid, talkSessionId, environment.DB);
      const context = await buildSharedAssistantContext(userKey, focusedTodoId);
      await configureOpenAI(talkInstructions(context));
      initialized = true;
      if (startupTimer) {
        clearTimeout(startupTimer);
        startupTimer = null;
      }
      await heartbeat();
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
      console.info("[todo-talk-phone] authenticated media bridge started", {
        callSid,
        talkSessionId,
        focusedTodoId,
        bufferedFrames: pending.length,
        replacedSession: Boolean(session.replacedSessionId),
        signatureValid,
        startupMs: Date.now() - startedAt,
      });
    } catch (error) {
      console.error("[todo-talk-phone] media bridge startup failed", {
        callSid: callSid || null,
        talkSessionId: talkSessionId || null,
        durationMs: Date.now() - startedAt,
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
      void initialize((event as TwilioStartEvent).start);
      return;
    }
    if (event.event === "media") {
      const audio = (event as TwilioMediaEvent).media?.payload;
      if (!audio) return;
      if (Date.now() - lastAddressedSpeechAt >= PHONE_IDLE_LIMIT_MS) {
        sendJson(openAI, {
          type: "response.create",
          response: { instructions: "Say only: Ending the call after fifteen minutes without a response." },
        });
        setTimeout(() => void finish("completed", "idle-timeout"), 2_000);
        return;
      }
      if (!initialized || !openSocket(openAI)) {
        if (bufferedMedia.length < MAX_BUFFERED_TWILIO_FRAMES) bufferedMedia.push(audio);
        return;
      }
      sendJson(openAI, { type: "input_audio_buffer.append", audio });
      void heartbeat().catch((error) => {
        console.error("[todo-talk-phone] heartbeat failed", { callSid, talkSessionId, error });
        void finish("failed", "session-replaced");
      });
      return;
    }
    if (event.event === "stop") void finish("completed", "caller-ended");
  });
  twilio.addEventListener("close", () => {
    if (!ending) void finish("completed", "twilio-disconnected");
  });
  twilio.addEventListener("error", () => {
    if (!ending) void finish("failed", "twilio-connection-error");
  });
  startupTimer = setTimeout(() => {
    if (!initialized && !ending) {
      console.error("[todo-talk-phone] media bridge start timed out", {
        callSid: callSid || null,
        streamSid: streamSid || null,
        signaturePresent,
        signatureValid,
        durationMs: Date.now() - startedAt,
      });
      void finish("failed", "twilio-start-timeout");
    }
  }, TWILIO_START_TIMEOUT_MS);

  console.info("[todo-talk-phone] media stream WebSocket accepted", {
    signaturePresent,
    signatureValid,
    host: url.host,
  });

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
}
