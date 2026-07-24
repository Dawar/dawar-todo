"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActionIcon } from "../action-icon";
import { SiteHeader } from "../site-header";

type TalkState =
  | "ready"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "muted"
  | "offline"
  | "ended"
  | "error";

type TalkMessage = {
  id: string;
  sessionId?: string;
  realtimeItemId: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  focusedTodoId: number | null;
  metadata?: Record<string, unknown>;
  createdAt: string;
  live?: boolean;
};

type ToolActivity = {
  id: string;
  name: string;
  label: string;
  status: "working" | "done" | "failed";
  detail?: string;
  undoToken?: string | null;
  sources?: Array<{ title: string; url: string }>;
};

type StartResponse = {
  sessionId: string;
  clientSecret: string;
  expiresAt: number | null;
  model: string;
  voice: string;
  focusedTodoId: number | null;
  focusedTodo: { id: number; title: string } | null;
  history: TalkMessage[];
  nextHistoryCursor: string | null;
  error?: string;
};

type RealtimeEvent = {
  type?: string;
  item_id?: string;
  transcript?: string;
  delta?: string;
  response?: {
    id?: string;
    status?: string;
    output?: Array<{
      id?: string;
      type?: string;
      role?: string;
      name?: string;
      call_id?: string;
      arguments?: string;
      content?: Array<{ type?: string; transcript?: string; text?: string }>;
    }>;
  };
  error?: { message?: string };
};

const HISTORY_CACHE_KEY = "dawar-todo-talk-history-v1";
const HEARTBEAT_MS = 5_000;
const IDLE_END_MS = 15 * 60 * 1_000;
const ROLLOVER_MS = 55 * 60 * 1_000;

function statusLabel(state: TalkState) {
  if (state === "connecting") return "Connecting";
  if (state === "listening") return "Listening";
  if (state === "thinking") return "Thinking";
  if (state === "speaking") return "Speaking";
  if (state === "muted") return "Muted";
  if (state === "offline") return "Offline";
  if (state === "ended") return "Ended";
  if (state === "error") return "Needs attention";
  return "Ready";
}

function activityLabel(name: string) {
  return ({
    search_tasks: "Searching tasks",
    get_task_context: "Reviewing task context",
    focus_task: "Changing task focus",
    list_projects: "Reviewing projects",
    create_task: "Creating task",
    update_task: "Updating task",
    bulk_update_tasks: "Updating tasks",
    prepare_destructive_action: "Preparing action",
    execute_destructive_action: "Completing action",
    undo_action: "Undoing action",
    inspect_attachment: "Inspecting attachment",
    remember_fact: "Saving memory",
    search_memories: "Searching memory",
    forget_memory: "Forgetting memory",
    search_talk_history: "Searching prior conversations",
    search_web: "Searching the web",
    read_url: "Reading source",
    wait_for_user: "Waiting",
  } as Record<string, string>)[name] ?? name.replaceAll("_", " ");
}

function cachedHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_CACHE_KEY) ?? "[]") as TalkMessage[];
    return Array.isArray(parsed) ? parsed.slice(-160) : [];
  } catch {
    return [];
  }
}

function cacheHistory(messages: TalkMessage[]) {
  try {
    localStorage.setItem(HISTORY_CACHE_KEY, JSON.stringify(messages.filter((message) => !message.live).slice(-160)));
  } catch {
    // D1 remains authoritative; this is only an offline viewing cache.
  }
}

function transcriptFromOutput(output: NonNullable<RealtimeEvent["response"]>["output"]) {
  return output?.flatMap((item) => item.content ?? [])
    .map((part) => part.transcript ?? part.text ?? "")
    .join(" ")
    .trim() ?? "";
}

export function TalkWorkspace() {
  const [state, setState] = useState<TalkState>("ready");
  const [messages, setMessages] = useState<TalkMessage[]>([]);
  const [activities, setActivities] = useState<ToolActivity[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [focusedTodo, setFocusedTodo] = useState<{ id: number; title: string } | null>(null);
  const [error, setError] = useState("");
  const [muted, setMuted] = useState(false);
  const [liveUser, setLiveUser] = useState("");
  const [liveAssistant, setLiveAssistant] = useState("");

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const focusedTodoRef = useRef<number | null>(null);
  const userTranscriptRef = useRef(new Map<string, string>());
  const assistantTranscriptRef = useRef(new Map<string, string>());
  const lastAddressedSpeechAtRef = useRef(Date.now());
  const startedAtRef = useRef(0);
  const endingRef = useRef(false);
  const reconnectingRef = useRef(false);
  const mountedRef = useRef(true);
  const connectRef = useRef<(stream?: MediaStream | null) => Promise<void>>(async () => undefined);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    focusedTodoRef.current = focusedTodo?.id ?? null;
  }, [focusedTodo]);

  const appendMessage = useCallback((message: TalkMessage) => {
    setMessages((current) => {
      if (current.some((item) => item.realtimeItemId === message.realtimeItemId)) return current;
      const next = [...current, message].slice(-240);
      cacheHistory(next);
      return next;
    });
  }, []);

  const persistFinal = useCallback(async (
    role: TalkMessage["role"],
    realtimeItemId: string,
    content: string,
    metadata: Record<string, unknown> = {},
  ) => {
    const activeSessionId = sessionIdRef.current;
    const cleanContent = content.trim();
    if (!activeSessionId || !cleanContent) return;
    const optimistic: TalkMessage = {
      id: crypto.randomUUID(),
      realtimeItemId,
      role,
      content: cleanContent,
      focusedTodoId: focusedTodoRef.current,
      metadata,
      createdAt: new Date().toISOString(),
    };
    appendMessage(optimistic);
    try {
      await fetch(`/api/talk/sessions/${activeSessionId}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          realtimeItemId,
          role,
          content: cleanContent,
          focusedTodoId: focusedTodoRef.current,
          metadata,
        }),
      });
    } catch {
      // The finalized transcript remains visible and can be recovered from the Realtime session.
    }
  }, [appendMessage]);

  const sendEvent = useCallback((event: Record<string, unknown>) => {
    const channel = channelRef.current;
    if (channel?.readyState === "open") channel.send(JSON.stringify(event));
  }, []);

  const runTool = useCallback(async (call: {
    name: string;
    call_id: string;
    arguments?: string;
  }) => {
    const activeSessionId = sessionIdRef.current;
    if (!activeSessionId) return;
    if (call.name !== "wait_for_user") lastAddressedSpeechAtRef.current = Date.now();
    const activityId = call.call_id;
    setActivities((current) => [
      ...current.filter((item) => item.id !== activityId),
      { id: activityId, name: call.name, label: activityLabel(call.name), status: "working" as const },
    ].slice(-20));
    let args: Record<string, unknown> = {};
    try {
      args = call.arguments ? JSON.parse(call.arguments) as Record<string, unknown> : {};
    } catch {
      args = {};
    }
    try {
      const response = await fetch(`/api/talk/sessions/${activeSessionId}/tools`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callId: call.call_id, name: call.name, arguments: args }),
      });
      const body = await response.json() as {
        result?: Record<string, unknown> & {
          message?: string;
          readback?: string;
          focusedTodoId?: number | null;
          task?: { id?: number; title?: string };
          undoToken?: string | null;
          sources?: Array<{ title: string; url: string }>;
        };
        error?: string;
      };
      if (!response.ok || !body.result) throw new Error(body.error || "That action did not complete.");
      const result = body.result;
      if (result.task && typeof result.task.id === "number" && typeof result.task.title === "string") {
        setFocusedTodo({ id: result.task.id, title: result.task.title });
      } else if (typeof result.focusedTodoId === "number") {
        setFocusedTodo((current) => current?.id === result.focusedTodoId ? current : { id: result.focusedTodoId!, title: "Focused task" });
      } else if (result.focusedTodoId === null) {
        setFocusedTodo(null);
      }
      setActivities((current) => current.map((item) => item.id === activityId ? {
        ...item,
        status: "done",
        detail: result.message ?? result.readback,
        undoToken: typeof result.undoToken === "string" ? result.undoToken : null,
        sources: Array.isArray(result.sources) ? result.sources : undefined,
      } : item));
      await persistFinal("tool", `tool-${call.call_id}`, String(result.message ?? result.readback ?? activityLabel(call.name)), {
        tool: call.name,
        undoToken: result.undoToken ?? null,
        sources: result.sources ?? [],
      });
      sendEvent({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(result),
        },
      });
      sendEvent({ type: "response.create" });
    } catch (toolError) {
      const message = toolError instanceof Error ? toolError.message : "That action did not complete.";
      setActivities((current) => current.map((item) => item.id === activityId ? {
        ...item,
        status: "failed",
        detail: message,
      } : item));
      sendEvent({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify({ error: message }),
        },
      });
      sendEvent({ type: "response.create" });
    }
  }, [persistFinal, sendEvent]);

  const handleRealtimeEvent = useCallback((event: RealtimeEvent) => {
    const type = event.type ?? "";
    if (type === "input_audio_buffer.speech_started") {
      setState(muted ? "muted" : "listening");
      setLiveUser("Listening…");
      return;
    }
    if (type === "input_audio_buffer.speech_stopped") {
      setState("thinking");
      return;
    }
    if (type.includes("input_audio_transcription.delta")) {
      const id = event.item_id ?? "current-user";
      const next = `${userTranscriptRef.current.get(id) ?? ""}${event.delta ?? ""}`;
      userTranscriptRef.current.set(id, next);
      setLiveUser(next);
      return;
    }
    if (type.includes("input_audio_transcription.completed")) {
      const id = event.item_id ?? crypto.randomUUID();
      const transcript = event.transcript ?? userTranscriptRef.current.get(id) ?? "";
      userTranscriptRef.current.delete(id);
      setLiveUser("");
      void persistFinal("user", id, transcript);
      return;
    }
    if (type === "response.created") {
      setState("thinking");
      return;
    }
    if (type.includes("output_audio_transcript.delta")) {
      const id = event.item_id ?? event.response?.id ?? "current-assistant";
      const next = `${assistantTranscriptRef.current.get(id) ?? ""}${event.delta ?? ""}`;
      assistantTranscriptRef.current.set(id, next);
      setLiveAssistant(next);
      setState("speaking");
      return;
    }
    if (type.includes("output_audio_transcript.done")) {
      const id = event.item_id ?? event.response?.id ?? crypto.randomUUID();
      const transcript = event.transcript ?? assistantTranscriptRef.current.get(id) ?? "";
      assistantTranscriptRef.current.delete(id);
      setLiveAssistant("");
      void persistFinal("assistant", id, transcript);
      return;
    }
    if (type === "response.done") {
      const output = event.response?.output ?? [];
      for (const item of output) {
        if (item.type === "function_call" && item.name && item.call_id) {
          void runTool({ name: item.name, call_id: item.call_id, arguments: item.arguments });
        }
      }
      const transcript = transcriptFromOutput(output);
      const messageItem = output.find((item) => item.type === "message");
      if (transcript && messageItem?.id) {
        lastAddressedSpeechAtRef.current = Date.now();
        void persistFinal("assistant", messageItem.id, transcript);
      }
      if (!output.some((item) => item.type === "function_call")) {
        setState(muted ? "muted" : "listening");
        setLiveAssistant("");
      }
      return;
    }
    if (type === "error") {
      setError(event.error?.message || "The voice session reported an error.");
      setState("error");
    }
  }, [muted, persistFinal, runTool]);

  const closeConnection = useCallback((stopMedia: boolean) => {
    channelRef.current?.close();
    channelRef.current = null;
    pcRef.current?.close();
    pcRef.current = null;
    if (audioRef.current) {
      audioRef.current.srcObject = null;
      audioRef.current.remove();
      audioRef.current = null;
    }
    if (stopMedia) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  }, []);

  const endSession = useCallback(async (reason = "user-ended", options: { keepMedia?: boolean } = {}) => {
    if (endingRef.current) return;
    endingRef.current = true;
    const activeSessionId = sessionIdRef.current;
    sessionIdRef.current = null;
    setSessionId(null);
    closeConnection(!options.keepMedia);
    if (activeSessionId) {
      void fetch(`/api/talk/sessions/${activeSessionId}`, {
        method: "PATCH",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "end", reason }),
      }).catch(() => undefined);
    }
    if (mountedRef.current && reason !== "rollover") setState(reason === "replaced" ? "ended" : navigator.onLine ? "ended" : "offline");
    endingRef.current = false;
  }, [closeConnection]);

  const connect = useCallback(async (existingStream?: MediaStream | null) => {
    if (!navigator.onLine) {
      setState("offline");
      return;
    }
    setState("connecting");
    setError("");
    const stream = existingStream && existingStream.active
      ? existingStream
      : await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    streamRef.current = stream;
    const response = await fetch("/api/talk/sessions", { method: "POST" });
    const data = await response.json() as StartResponse;
    if (!response.ok || !data.clientSecret) throw new Error(data.error || "Talk could not start.");
    setMessages((current) => {
      const merged = [...data.history, ...current]
        .filter((message, index, all) => all.findIndex((candidate) => candidate.realtimeItemId === message.realtimeItemId) === index)
        .slice(-240);
      cacheHistory(merged);
      return merged;
    });
    setSessionId(data.sessionId);
    sessionIdRef.current = data.sessionId;
    setFocusedTodo(data.focusedTodo);
    focusedTodoRef.current = data.focusedTodoId;
    startedAtRef.current = Date.now();
    lastAddressedSpeechAtRef.current = Date.now();

    const pc = new RTCPeerConnection();
    pcRef.current = pc;
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.setAttribute("playsinline", "true");
    audioRef.current = audio;
    pc.ontrack = (event) => {
      audio.srcObject = event.streams[0];
      void audio.play().catch(() => undefined);
    };
    stream.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
      pc.addTrack(track, stream);
    });
    const channel = pc.createDataChannel("oai-events");
    channelRef.current = channel;
    channel.addEventListener("message", (message) => {
      try {
        handleRealtimeEvent(JSON.parse(message.data) as RealtimeEvent);
      } catch {
        // Ignore malformed provider events and keep the audio session alive.
      }
    });
    channel.addEventListener("open", () => {
      setState(muted ? "muted" : "listening");
      sendEvent({
        type: "response.create",
        response: {
          instructions: "Start the session now. Briefly greet me, name the current task if one is focused, and ask the single most useful question to move it forward. If no task is focused, suggest the highest-value open task.",
        },
      });
    });
    pc.addEventListener("connectionstatechange", () => {
      if (["failed", "disconnected"].includes(pc.connectionState) && !endingRef.current && navigator.onLine) {
        window.setTimeout(() => {
          if (
            mountedRef.current
            && !endingRef.current
            && ["failed", "disconnected", "closed"].includes(pc.connectionState)
            && !reconnectingRef.current
          ) {
            reconnectingRef.current = true;
            const media = streamRef.current;
            void endSession("network-reconnect", { keepMedia: true })
              .then(() => connectRef.current(media))
              .catch((reconnectError) => {
                setError(reconnectError instanceof Error ? reconnectError.message : "Talk could not reconnect.");
                setState("error");
              })
              .finally(() => {
                reconnectingRef.current = false;
              });
          }
        }, 3_000);
      }
    });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const sdp = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${data.clientSecret}`,
        "Content-Type": "application/sdp",
      },
      body: offer.sdp,
    });
    if (!sdp.ok) throw new Error("The realtime audio connection could not be established.");
    await pc.setRemoteDescription({ type: "answer", sdp: await sdp.text() });
  }, [endSession, handleRealtimeEvent, muted, sendEvent]);

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  const startTalk = useCallback(async () => {
    try {
      await connect();
    } catch (startError) {
      closeConnection(true);
      setError(startError instanceof Error ? startError.message : "Talk could not start.");
      setState(navigator.onLine ? "error" : "offline");
    }
  }, [closeConnection, connect]);

  const undo = useCallback(async (undoToken: string) => {
    const activeSessionId = sessionIdRef.current;
    if (!activeSessionId) return;
    const callId = crypto.randomUUID();
    setActivities((current) => [
      ...current,
      { id: callId, name: "undo_action", label: "Undoing action", status: "working" as const },
    ].slice(-20));
    try {
      const response = await fetch(`/api/talk/sessions/${activeSessionId}/tools`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callId, name: "undo_action", arguments: { undo_token: undoToken } }),
      });
      const body = await response.json() as { result?: { message?: string }; error?: string };
      if (!response.ok || !body.result) throw new Error(body.error || "Undo did not complete.");
      setActivities((current) => current.map((item) => item.id === callId
        ? { ...item, status: "done", detail: body.result?.message ?? "Undone." }
        : item.undoToken === undoToken
          ? { ...item, undoToken: null }
          : item));
    } catch (undoError) {
      setActivities((current) => current.map((item) => item.id === callId ? {
        ...item,
        status: "failed",
        detail: undoError instanceof Error ? undoError.message : "Undo did not complete.",
      } : item));
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const cached = cachedHistory();
    if (cached.length) setMessages(cached);
    if (!navigator.onLine) {
      setState("offline");
    } else {
      fetch("/api/talk/history?limit=80")
        .then((response) => response.ok ? response.json() : Promise.reject())
        .then((body) => {
          const history = body as { messages?: TalkMessage[] };
          if (Array.isArray(history.messages)) {
            setMessages(history.messages);
            cacheHistory(history.messages);
          }
        })
        .catch(() => undefined);
    }
    const online = () => setState((current) => current === "offline" ? "ready" : current);
    const offline = () => {
      if (sessionIdRef.current) void endSession("offline");
      setState("offline");
    };
    const visibility = () => {
      if (document.visibilityState !== "visible" && sessionIdRef.current) void endSession("left-foreground");
    };
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      mountedRef.current = false;
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
      document.removeEventListener("visibilitychange", visibility);
      void endSession("left-view");
    };
  }, [endSession]);

  useEffect(() => {
    if (!sessionId) return;
    const interval = window.setInterval(() => {
      const activeSessionId = sessionIdRef.current;
      if (!activeSessionId) return;
      if (Date.now() - lastAddressedSpeechAtRef.current >= IDLE_END_MS) {
        void endSession("idle-timeout");
        return;
      }
      if (Date.now() - startedAtRef.current >= ROLLOVER_MS && !reconnectingRef.current) {
        reconnectingRef.current = true;
        const stream = streamRef.current;
        void endSession("rollover", { keepMedia: true })
          .then(() => connectRef.current(stream))
          .catch((rolloverError) => {
            setError(rolloverError instanceof Error ? rolloverError.message : "Talk could not roll over.");
            setState("error");
          })
          .finally(() => {
            reconnectingRef.current = false;
          });
        return;
      }
      void fetch(`/api/talk/sessions/${activeSessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "heartbeat", focusedTodoId: focusedTodoRef.current }),
      }).then(async (response) => {
        if (response.status === 409) {
          await endSession("replaced");
          setError("This Talk session moved to a newer device.");
        }
      }).catch(() => undefined);
    }, HEARTBEAT_MS);
    return () => window.clearInterval(interval);
  }, [endSession, sessionId]);

  const toggleMute = useCallback(() => {
    const next = !muted;
    setMuted(next);
    streamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = !next;
    });
    if (sessionIdRef.current) setState(next ? "muted" : "listening");
  }, [muted]);

  const groupedActivities = useMemo(() => activities.slice().reverse(), [activities]);
  const canStart = !sessionId && state !== "connecting" && state !== "offline";

  return (
    <main className="min-h-screen bg-[#f6f7f5] text-[#252a27]">
      <SiteHeader current="talk" />
      <div className="mx-auto grid max-w-5xl gap-5 px-4 py-5 sm:px-6 md:grid-cols-[minmax(0,1fr)_320px] md:py-8">
        <section className="flex min-h-[calc(100dvh-7rem)] flex-col overflow-hidden rounded-[28px] border border-black/[0.07] bg-white shadow-[0_18px_60px_rgba(31,45,37,0.08)]">
          <div className="border-b border-black/[0.06] px-5 py-5 sm:px-7">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#216e4e]">Realtime chief of staff</p>
                <h1 className="mt-1 text-2xl font-semibold tracking-[-0.03em]">Talk</h1>
                <p className="mt-1 text-sm text-[#7a837e]">
                  {focusedTodo ? <>Working on <span className="font-medium text-[#3d4641]">{focusedTodo.title}</span></> : "Ready to review your task system"}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium ${
                  state === "speaking" ? "bg-[#eaf3ed] text-[#216e4e]"
                    : state === "error" || state === "offline" ? "bg-[#fff0ef] text-[#a3302c]"
                      : "bg-[#f1f3f1] text-[#5f6863]"
                }`}>
                  <span className={`h-2 w-2 rounded-full ${
                    ["listening", "thinking", "speaking"].includes(state) ? "animate-pulse bg-[#218257]" : "bg-current opacity-50"
                  }`} />
                  {statusLabel(state)}
                </span>
              </div>
            </div>
          </div>

          <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5 sm:px-7" aria-live="polite">
            {!messages.length && !liveUser && !liveAssistant && (
              <div className="mx-auto flex max-w-md flex-col items-center py-16 text-center">
                <span className="grid h-20 w-20 place-items-center rounded-full bg-[#eaf3ed] text-[#216e4e]">
                  <ActionIcon name="mic" className="h-9 w-9" strokeWidth={1.7} />
                </span>
                <h2 className="mt-5 text-xl font-semibold tracking-[-0.02em]">A continuous working conversation</h2>
                <p className="mt-2 text-sm leading-6 text-[#7a837e]">Talk through priorities, update tasks, research questions, preserve useful memories, and undo changes without touching the screen.</p>
              </div>
            )}
            {messages.map((message) => (
              <article
                key={message.realtimeItemId}
                className={`max-w-[88%] rounded-2xl px-4 py-3 ${
                  message.role === "user"
                    ? "ml-auto bg-[#216e4e] text-white"
                    : message.role === "tool"
                      ? "border border-[#d9e6dd] bg-[#f2f8f4] text-[#3d4641]"
                      : "bg-[#f2f3f1] text-[#303733]"
                }`}
              >
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] opacity-60">
                  {message.role === "user" ? "You" : message.role === "assistant" ? "Talk" : "Activity"}
                </p>
                <p className="whitespace-pre-wrap text-[15px] leading-6">{message.content}</p>
              </article>
            ))}
            {liveUser && (
              <article className="ml-auto max-w-[88%] rounded-2xl bg-[#216e4e]/85 px-4 py-3 text-white">
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] opacity-60">You · live</p>
                <p className="text-[15px] leading-6">{liveUser}</p>
              </article>
            )}
            {liveAssistant && (
              <article className="max-w-[88%] rounded-2xl bg-[#f2f3f1] px-4 py-3 text-[#303733]">
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] opacity-60">Talk · live</p>
                <p className="text-[15px] leading-6">{liveAssistant}</p>
              </article>
            )}
          </div>

          <div className="border-t border-black/[0.06] bg-white/95 px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-4 sm:px-7">
            {error && <p className="mb-3 rounded-xl bg-[#fff0ef] px-3 py-2 text-sm text-[#9b302c]">{error}</p>}
            <div className="flex items-center justify-center gap-3">
              {canStart ? (
                <button
                  type="button"
                  onClick={() => void startTalk()}
                  className="inline-flex min-h-12 items-center gap-2 rounded-2xl bg-[#216e4e] px-6 py-3 font-semibold text-white shadow-sm transition hover:bg-[#195b40] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#216e4e]"
                >
                  <ActionIcon name="mic" className="h-5 w-5" />
                  Start Talk
                </button>
              ) : sessionId ? (
                <>
                  <button
                    type="button"
                    onClick={toggleMute}
                    className={`inline-flex min-h-12 items-center gap-2 rounded-2xl border px-5 py-3 font-semibold transition focus-visible:outline-2 focus-visible:outline-[#216e4e] ${
                      muted ? "border-[#e9c5c2] bg-[#fff0ef] text-[#a3302c]" : "border-black/[0.08] bg-white text-[#3f4743] hover:bg-[#f3f5f3]"
                    }`}
                  >
                    <ActionIcon name="mic" className="h-5 w-5" />
                    {muted ? "Unmute" : "Mute"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void endSession("user-ended")}
                    className="inline-flex min-h-12 items-center gap-2 rounded-2xl bg-[#242a26] px-5 py-3 font-semibold text-white transition hover:bg-black focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#242a26]"
                  >
                    <ActionIcon name="stop" className="h-4 w-4" />
                    End
                  </button>
                </>
              ) : (
                <p className="text-sm text-[#7a837e]">{state === "offline" ? "Talk needs an internet connection. Prior transcript remains available." : "Connecting to Talk…"}</p>
              )}
            </div>
          </div>
        </section>

        <aside className="space-y-4">
          <section className="rounded-3xl border border-black/[0.07] bg-white p-5 shadow-[0_12px_38px_rgba(31,45,37,0.05)]">
            <h2 className="text-sm font-semibold">Live activity</h2>
            {!groupedActivities.length ? (
              <p className="mt-2 text-sm leading-6 text-[#858d88]">Task changes, research sources, attachment inspection, and Undo will appear here.</p>
            ) : (
              <div className="mt-3 space-y-3">
                {groupedActivities.map((activity) => (
                  <div key={activity.id} className="rounded-2xl bg-[#f5f6f4] p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{activity.label}</p>
                        {activity.detail && <p className="mt-1 line-clamp-3 text-xs leading-5 text-[#7a837e]">{activity.detail}</p>}
                      </div>
                      <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
                        activity.status === "working" ? "animate-pulse bg-[#c27b16]"
                          : activity.status === "done" ? "bg-[#218257]" : "bg-[#c33b34]"
                      }`} />
                    </div>
                    {activity.undoToken && (
                      <button
                        type="button"
                        onClick={() => void undo(activity.undoToken!)}
                        className="mt-2 inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-semibold text-[#216e4e] transition hover:bg-[#e6f0e9]"
                      >
                        <ActionIcon name="undo" className="h-3.5 w-3.5" />
                        Undo
                      </button>
                    )}
                    {activity.sources?.length ? (
                      <div className="mt-2 space-y-1">
                        {activity.sources.slice(0, 5).map((source) => (
                          <a
                            key={source.url}
                            href={source.url}
                            target="_blank"
                            rel="noreferrer"
                            className="block truncate text-xs font-medium text-[#216e4e] underline decoration-[#a7c7b3] underline-offset-2"
                          >
                            {source.title}
                          </a>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </section>
          <section className="rounded-3xl border border-black/[0.07] bg-[#eaf3ed] p-5 text-[#285b43]">
            <p className="text-sm font-semibold">Hands-free controls</p>
            <p className="mt-2 text-sm leading-6">Interrupt naturally, ask “what do you remember?”, say “forget that,” or ask Talk to undo the last change.</p>
          </section>
        </aside>
      </div>
    </main>
  );
}
