"use client";

import Link from "next/link";
import {
  type ClipboardEvent,
  type DragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { TodoAttachment } from "../../db/attachments";
import type { TalkMessage, TalkThread } from "../../db/talk";
import type { Todo } from "../../db/todos";
import {
  deleteOfflineTalkMessage,
  listOfflineTalkMessages,
  loadOfflineTalkDraft,
  saveOfflineTalkDraft,
  saveOfflineTalkMessage,
  type OfflineAssistantAttachment,
} from "../offline-store";
import { uploadTaskAttachment, type BrowserAttachmentKind } from "../attachment-upload-client";
import {
  AssistantAttachmentMenu,
  AssistantVoiceRecorder,
} from "../assistant-attachment-controls";
import { ActionIcon } from "../action-icon";
import { SiteHeader } from "../site-header";
import { realtimeConversationItemId } from "../../lib/realtime-item-id";

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

type ToolActivity = {
  id: string;
  name: string;
  label: string;
  status: "working" | "failed";
  detail?: string;
};

type StagedFile = {
  localId: string;
  file: File;
  kind: BrowserAttachmentKind;
  durationMs: number;
  status: "waiting" | "uploading" | "ready" | "failed";
  attachmentId?: string;
  error?: string;
};

type WorkspacePayload = {
  threads: TalkThread[];
  todos: Todo[];
  error?: string;
};

type StartResponse = {
  sessionId: string;
  threadId: string;
  clientSecret: string;
  expiresAt: number | null;
  model: string;
  voice: string;
  focusedTodoId: number | null;
  focusedTodo: Todo | null;
  history: TalkMessage[];
  nextHistoryCursor: string | null;
  error?: string;
};

type RealtimeOutput = {
  id?: string;
  type?: string;
  role?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  content?: Array<{ type?: string; transcript?: string; text?: string }>;
};

type RealtimeEvent = {
  type?: string;
  event_id?: string;
  item_id?: string;
  transcript?: string;
  delta?: string;
  response?: {
    id?: string;
    status?: string;
    output?: RealtimeOutput[];
  };
  error?: { code?: string; message?: string };
};

const HEARTBEAT_MS = 5_000;
const IDLE_END_MS = 15 * 60 * 1_000;
const ROLLOVER_MS = 55 * 60 * 1_000;
const HISTORY_CACHE_PREFIX = "dawar-todo-talk-thread-v2:";
const SELECTED_THREAD_KEY = "dawar-todo-selected-talk-thread-v2";
const WORKSPACE_CACHE_KEY = "dawar-todo-talk-workspace-v2";

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
    search_talk_history: "Searching conversations",
    search_web: "Searching the web",
    read_url: "Reading source",
    wait_for_user: "Waiting",
  } as Record<string, string>)[name] ?? name.replaceAll("_", " ");
}

function attachmentKind(file: File): BrowserAttachmentKind {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("audio/")) return "audio";
  if (file.type.startsWith("video/")) return "video";
  return "file";
}

function cachedHistory(threadId: string) {
  try {
    const parsed = JSON.parse(localStorage.getItem(`${HISTORY_CACHE_PREFIX}${threadId}`) ?? "[]") as TalkMessage[];
    return Array.isArray(parsed) ? parsed.slice(-240) : [];
  } catch {
    return [];
  }
}

function cacheHistory(threadId: string, messages: TalkMessage[]) {
  try {
    localStorage.setItem(
      `${HISTORY_CACHE_PREFIX}${threadId}`,
      JSON.stringify(messages.filter((message) => !message.metadata?.live).slice(-240)),
    );
  } catch {
    // D1 remains authoritative; this cache only keeps recent transcripts readable offline.
  }
}

function cachedWorkspace(): WorkspacePayload {
  try {
    const parsed = JSON.parse(localStorage.getItem(WORKSPACE_CACHE_KEY) ?? "{}") as Partial<WorkspacePayload>;
    return {
      threads: Array.isArray(parsed.threads) ? parsed.threads : [],
      todos: Array.isArray(parsed.todos) ? parsed.todos : [],
    };
  } catch {
    return { threads: [], todos: [] };
  }
}

function cacheWorkspace(payload: WorkspacePayload) {
  try {
    localStorage.setItem(WORKSPACE_CACHE_KEY, JSON.stringify({
      threads: payload.threads,
      todos: payload.todos,
    }));
  } catch {
    // This cache only keeps the thread rail and internally inferred task context available offline.
  }
}

function transcriptFromOutput(output: RealtimeOutput[] | undefined) {
  return output?.flatMap((item) => item.content ?? [])
    .map((part) => part.transcript ?? part.text ?? "")
    .join(" ")
    .trim() ?? "";
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...init?.headers,
    },
  });
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || "The request could not be completed.");
  return body;
}

function sourceList(metadata: Record<string, unknown>) {
  return Array.isArray(metadata.sources)
    ? metadata.sources.filter((source): source is { title: string; url: string } => {
      return Boolean(source && typeof source === "object"
        && typeof (source as { title?: unknown }).title === "string"
        && typeof (source as { url?: unknown }).url === "string");
    })
    : [];
}

export function TalkWorkspace() {
  const [state, setState] = useState<TalkState>("ready");
  const [threads, setThreads] = useState<TalkThread[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<TalkMessage[]>([]);
  const [activities, setActivities] = useState<ToolActivity[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [focusedTodo, setFocusedTodo] = useState<Todo | null>(null);
  const [attachments, setAttachments] = useState<TodoAttachment[]>([]);
  const [selectedAttachmentIds, setSelectedAttachmentIds] = useState<string[]>([]);
  const [stagedFiles, setStagedFiles] = useState<StagedFile[]>([]);
  const [draft, setDraft] = useState("");
  const [draftDirty, setDraftDirty] = useState(false);
  const [liveUser, setLiveUser] = useState("");
  const [liveAssistant, setLiveAssistant] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [muted, setMuted] = useState(false);
  const [deleteUndo, setDeleteUndo] = useState<{ token: string; title: string } | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const senderRef = useRef<RTCRtpSender | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const selectedThreadIdRef = useRef<string | null>(null);
  const focusedTodoRef = useRef<number | null>(null);
  const responseActiveRef = useRef(false);
  const pendingResponseRef = useRef<Record<string, unknown> | null>(null);
  const responseModeRef = useRef<"text" | "audio">("audio");
  const userTranscriptRef = useRef(new Map<string, string>());
  const assistantTranscriptRef = useRef(new Map<string, string>());
  const lastAddressedSpeechAtRef = useRef(0);
  const startedAtRef = useRef(0);
  const endingRef = useRef(false);
  const reconnectingRef = useRef(false);
  const mountedRef = useRef(true);
  const connectRef = useRef<(threadId: string) => Promise<void>>(async () => undefined);
  const refreshThreadsRef = useRef<(preserveSelection?: boolean) => Promise<WorkspacePayload>>(async () => ({
    threads: [],
    todos: [],
  }));
  const syncOfflineMessagesRef = useRef<() => Promise<void>>(async () => undefined);
  const endSessionRef = useRef<(reason?: string) => Promise<void>>(async () => undefined);
  const messagesRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const draftDirtyRef = useRef(false);
  const threadsRef = useRef<TalkThread[]>([]);
  const todosRef = useRef<Todo[]>([]);
  const toolsRunningRef = useRef(0);

  const selectedThread = useMemo(
    () => threads.find((thread) => thread.id === selectedThreadId) ?? null,
    [selectedThreadId, threads],
  );

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    selectedThreadIdRef.current = selectedThreadId;
  }, [selectedThreadId]);

  useEffect(() => {
    focusedTodoRef.current = focusedTodo?.id ?? null;
  }, [focusedTodo]);

  useEffect(() => {
    threadsRef.current = threads;
  }, [threads]);

  useEffect(() => {
    todosRef.current = todos;
  }, [todos]);

  const mergeMessage = useCallback((message: TalkMessage) => {
    setMessages((current) => {
      const existing = current.findIndex((item) => item.realtimeItemId === message.realtimeItemId);
      const next = existing >= 0
        ? current.map((item, index) => index === existing ? { ...item, ...message } : item)
        : [...current, message];
      const trimmed = next.slice(-300);
      const threadId = message.threadId ?? selectedThreadIdRef.current;
      if (threadId) cacheHistory(threadId, trimmed);
      return trimmed;
    });
  }, []);

  const refreshThreads = useCallback(async (preserveSelection = true) => {
    const payload = navigator.onLine
      ? await api<WorkspacePayload>("/api/talk/threads")
      : cachedWorkspace();
    if (navigator.onLine) cacheWorkspace(payload);
    setThreads(payload.threads);
    setTodos(payload.todos);
    setSelectedThreadId((current) => {
      if (preserveSelection && current && payload.threads.some((thread) => thread.id === current)) return current;
      const remembered = typeof localStorage === "undefined" ? null : localStorage.getItem(SELECTED_THREAD_KEY);
      if (remembered && payload.threads.some((thread) => thread.id === remembered)) return remembered;
      return payload.threads.find((thread) => thread.kind === "general")?.id
        ?? payload.threads.find((thread) => thread.kind !== "phone")?.id
        ?? payload.threads[0]?.id
        ?? null;
    });
    if (!navigator.onLine) setState("offline");
    return payload;
  }, []);

  const loadAttachments = useCallback(async (todoId: number | null) => {
    if (!todoId || !navigator.onLine) {
      setAttachments([]);
      setSelectedAttachmentIds([]);
      return;
    }
    try {
      const payload = await api<{ attachments: TodoAttachment[] }>(`/api/todos/${todoId}/attachments`);
      setAttachments(payload.attachments);
      setSelectedAttachmentIds((ids) => ids.filter((id) => payload.attachments.some((attachment) => attachment.id === id)));
    } catch (cause) {
      console.error("[todo-talk-ui] attachment load failed", { todoId, cause });
    }
  }, []);

  const loadThread = useCallback(async (threadId: string) => {
    const thread = threadsRef.current.find((item) => item.id === threadId)
      ?? (await api<{ thread: TalkThread }>(`/api/talk/threads/${threadId}`)).thread;
    const cached = cachedHistory(threadId);
    setMessages(cached);
    setActivities([]);
    setSelectedAttachmentIds([]);
    setStagedFiles([]);
    setError("");
    setNotice("");
    const todo = thread.focusedTodoId ? todosRef.current.find((item) => item.id === thread.focusedTodoId) ?? null : null;
    setFocusedTodo(todo);
    await loadAttachments(todo?.id ?? null);
    const localDraft = await loadOfflineTalkDraft(threadId).catch(() => null);
    setDraft(localDraft?.text || thread.draftText || "");
    draftDirtyRef.current = false;
    setDraftDirty(false);
    if (navigator.onLine) {
      const history = await api<{ messages: TalkMessage[] }>(`/api/talk/threads/${threadId}/messages?limit=100`);
      setMessages(history.messages);
      cacheHistory(threadId, history.messages);
    }
  }, [loadAttachments]);

  const persistFinal = useCallback(async (
    role: TalkMessage["role"],
    realtimeItemId: string,
    content: string,
    metadata: Record<string, unknown> = {},
  ) => {
    const activeSessionId = sessionIdRef.current;
    const threadId = selectedThreadIdRef.current;
    const cleanContent = content.trim();
    if (!activeSessionId || !threadId || !cleanContent) return;
    const optimistic: TalkMessage = {
      id: crypto.randomUUID(),
      sessionId: activeSessionId,
      threadId,
      realtimeItemId,
      role,
      content: cleanContent,
      focusedTodoId: focusedTodoRef.current,
      metadata,
      createdAt: new Date().toISOString(),
    };
    mergeMessage(optimistic);
    try {
      const result = await api<{ message: TalkMessage }>(`/api/talk/sessions/${activeSessionId}/events`, {
        method: "POST",
        body: JSON.stringify({
          realtimeItemId,
          role,
          content: cleanContent,
          focusedTodoId: focusedTodoRef.current,
          metadata,
        }),
      });
      mergeMessage(result.message);
      setThreads((current) => current.map((thread) => thread.id === threadId ? {
        ...thread,
        title: thread.kind === "custom" && thread.title === "New conversation" && role === "user"
          ? cleanContent.replace(/\s+/g, " ").slice(0, 56)
          : thread.title,
        preview: cleanContent,
        messageCount: thread.messageCount + (role === "tool" ? 0 : 1),
        lastMessageAt: result.message.createdAt,
      } : thread));
    } catch (cause) {
      console.warn("[todo-talk-ui] transcript persistence deferred", {
        threadId,
        realtimeItemId,
        role,
        cause,
      });
    }
  }, [mergeMessage]);

  const sendEvent = useCallback((event: Record<string, unknown>) => {
    const channel = channelRef.current;
    if (channel?.readyState !== "open") return false;
    channel.send(JSON.stringify(event));
    return true;
  }, []);

  const requestRealtimeResponse = useCallback((response?: Record<string, unknown>) => {
    if (channelRef.current?.readyState !== "open") return false;
    if (responseActiveRef.current) {
      pendingResponseRef.current = response ?? pendingResponseRef.current ?? {};
      console.info("[todo-talk-ui] response request serialized", {
        threadId: selectedThreadIdRef.current,
        mode: responseModeRef.current,
      });
      return false;
    }
    const effectiveResponse = response ?? pendingResponseRef.current;
    responseActiveRef.current = true;
    pendingResponseRef.current = null;
    const eventId = `todo-response-${crypto.randomUUID()}`;
    sendEvent({
      event_id: eventId,
      type: "response.create",
      ...(effectiveResponse && Object.keys(effectiveResponse).length ? { response: effectiveResponse } : {}),
    });
    console.info("[todo-talk-ui] response requested", {
      eventId,
      threadId: selectedThreadIdRef.current,
      mode: responseModeRef.current,
      hasOverrides: Boolean(effectiveResponse && Object.keys(effectiveResponse).length),
    });
    return true;
  }, [sendEvent]);

  const runTool = useCallback(async (call: { name: string; call_id: string; arguments?: string }) => {
    const activeSessionId = sessionIdRef.current;
    if (!activeSessionId) return;
    if (call.name !== "wait_for_user") lastAddressedSpeechAtRef.current = Date.now();
    setActivities((current) => [
      ...current.filter((item) => item.id !== call.call_id),
      { id: call.call_id, name: call.name, label: activityLabel(call.name), status: "working" as const },
    ].slice(-12));
    let args: Record<string, unknown> = {};
    try {
      args = call.arguments ? JSON.parse(call.arguments) as Record<string, unknown> : {};
    } catch {
      args = {};
    }
    try {
      const body = await api<{
        result: Record<string, unknown> & {
          message?: string;
          readback?: string;
          focusedTodoId?: number | null;
          task?: Todo;
          undoToken?: string | null;
          sources?: Array<{ title: string; url: string }>;
        };
      }>(`/api/talk/sessions/${activeSessionId}/tools`, {
        method: "POST",
        body: JSON.stringify({ callId: call.call_id, name: call.name, arguments: args }),
      });
      const result = body.result;
      if (result.task?.id) {
        setTodos((current) => current.map((todo) => todo.id === result.task!.id ? result.task! : todo));
        setFocusedTodo(result.task);
      } else if (typeof result.focusedTodoId === "number") {
        setFocusedTodo(todos.find((todo) => todo.id === result.focusedTodoId) ?? null);
      } else if (result.focusedTodoId === null) {
        setFocusedTodo(null);
      }
      const detail = String(result.message ?? result.readback ?? activityLabel(call.name));
      await persistFinal("tool", `tool-${call.call_id}`, detail, {
        tool: call.name,
        status: "done",
        undoToken: result.undoToken ?? null,
        sources: result.sources ?? [],
        taskId: result.task?.id ?? result.focusedTodoId ?? null,
      });
      setActivities((current) => current.filter((item) => item.id !== call.call_id));
      sendEvent({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(result),
        },
      });
      if (call.name === "focus_task") {
        const taskId = typeof result.focusedTodoId === "number" ? result.focusedTodoId : null;
        const todo = taskId ? todos.find((item) => item.id === taskId) ?? null : null;
        setFocusedTodo(todo);
        void loadAttachments(taskId);
        setThreads((current) => current.map((thread) => thread.id === selectedThreadIdRef.current
          ? { ...thread, focusedTodoId: taskId }
          : thread));
      }
    } catch (toolError) {
      const detail = toolError instanceof Error ? toolError.message : "That action did not complete.";
      setActivities((current) => current.map((item) => item.id === call.call_id
        ? { ...item, status: "failed", detail }
        : item));
      void persistFinal("tool", `tool-${call.call_id}`, detail, {
        tool: call.name,
        status: "failed",
      });
      sendEvent({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify({ error: detail }),
        },
      });
    }
  }, [loadAttachments, persistFinal, sendEvent, todos]);

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
      void persistFinal("user", id, transcript, { channel: "audio" });
      return;
    }
    if (type === "response.created") {
      responseActiveRef.current = true;
      setState("thinking");
      return;
    }
    if (type.includes("output_audio_transcript.delta") || type === "response.output_text.delta") {
      const id = event.item_id ?? event.response?.id ?? "current-assistant";
      const next = `${assistantTranscriptRef.current.get(id) ?? ""}${event.delta ?? ""}`;
      assistantTranscriptRef.current.set(id, next);
      setLiveAssistant(next);
      setState(responseModeRef.current === "audio" ? "speaking" : "thinking");
      return;
    }
    if (type.includes("output_audio_transcript.done") || type === "response.output_text.done") {
      const id = event.item_id ?? event.response?.id ?? crypto.randomUUID();
      const transcript = event.transcript ?? assistantTranscriptRef.current.get(id) ?? "";
      assistantTranscriptRef.current.delete(id);
      setLiveAssistant("");
      void persistFinal("assistant", id, transcript, { channel: responseModeRef.current });
      return;
    }
    if (type === "response.done") {
      responseActiveRef.current = false;
      const output = event.response?.output ?? [];
      const toolCalls = output
        .filter((item) => item.type === "function_call" && item.name && item.call_id)
        .map((item) => ({ name: item.name!, call_id: item.call_id!, arguments: item.arguments }));
      const transcript = transcriptFromOutput(output);
      const messageItem = output.find((item) => item.type === "message");
      if (transcript && messageItem?.id) {
        lastAddressedSpeechAtRef.current = Date.now();
        void persistFinal("assistant", messageItem.id, transcript, { channel: responseModeRef.current });
      }
      if (!toolCalls.length) {
        setState(audioEnabled ? (muted ? "muted" : "listening") : "ready");
        setLiveAssistant("");
        const pending = pendingResponseRef.current;
        if (pending) requestRealtimeResponse(Object.keys(pending).length ? pending : undefined);
      } else {
        toolsRunningRef.current += toolCalls.length;
        console.info("[todo-talk-ui] inline tool batch started", {
          responseId: event.response?.id ?? null,
          toolCount: toolCalls.length,
          threadId: selectedThreadIdRef.current,
        });
        void Promise.all(toolCalls.map((call) => runTool(call))).then(() => {
          toolsRunningRef.current = Math.max(0, toolsRunningRef.current - toolCalls.length);
          console.info("[todo-talk-ui] inline tool batch completed", {
            responseId: event.response?.id ?? null,
            toolCount: toolCalls.length,
            threadId: selectedThreadIdRef.current,
          });
          requestRealtimeResponse(responseModeRef.current === "text" ? { output_modalities: ["text"] } : undefined);
        });
      }
      return;
    }
    if (type === "error") {
      const message = event.error?.message || "The realtime session reported an error.";
      if (/active response in progress|wait until the response is finished/i.test(message)) {
        responseActiveRef.current = true;
        pendingResponseRef.current ??= responseModeRef.current === "text" ? { output_modalities: ["text"] } : {};
        setState("thinking");
        console.info("[todo-talk-ui] overlapping response deferred", {
          eventId: event.event_id ?? null,
          code: event.error?.code ?? null,
        });
        return;
      }
      responseActiveRef.current = false;
      setError(message);
      setState("error");
    }
  }, [audioEnabled, muted, persistFinal, requestRealtimeResponse, runTool]);

  const closeConnection = useCallback((stopMedia = true) => {
    responseActiveRef.current = false;
    pendingResponseRef.current = null;
    channelRef.current?.close();
    channelRef.current = null;
    pcRef.current?.close();
    pcRef.current = null;
    senderRef.current = null;
    if (audioRef.current) {
      audioRef.current.srcObject = null;
      audioRef.current.remove();
      audioRef.current = null;
    }
    if (stopMedia) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setAudioEnabled(false);
      setMuted(false);
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
    if (mountedRef.current && reason !== "rollover") {
      setState(reason === "replaced" ? "ended" : navigator.onLine ? "ready" : "offline");
    }
    endingRef.current = false;
  }, [closeConnection]);

  const connect = useCallback(async (threadId: string) => {
    if (sessionIdRef.current && selectedThreadIdRef.current === threadId && channelRef.current?.readyState === "open") return;
    if (!navigator.onLine) {
      setState("offline");
      throw new Error("Talk audio and replies are unavailable offline.");
    }
    if (sessionIdRef.current) await endSession("thread-switch");
    setState("connecting");
    setError("");
    const data = await api<StartResponse>("/api/talk/sessions", {
      method: "POST",
      body: JSON.stringify({ threadId }),
    });
    setSessionId(data.sessionId);
    sessionIdRef.current = data.sessionId;
    setFocusedTodo(data.focusedTodo);
    focusedTodoRef.current = data.focusedTodoId;
    setMessages((current) => {
      const merged = [...data.history, ...current]
        .filter((message, index, all) => all.findIndex((candidate) => candidate.realtimeItemId === message.realtimeItemId) === index)
        .slice(-300);
      cacheHistory(threadId, merged);
      return merged;
    });
    startedAtRef.current = Date.now();
    lastAddressedSpeechAtRef.current = Date.now();

    const pc = new RTCPeerConnection();
    pcRef.current = pc;
    const transceiver = pc.addTransceiver("audio", { direction: "sendrecv" });
    senderRef.current = transceiver.sender;
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.setAttribute("playsinline", "true");
    audioRef.current = audio;
    pc.ontrack = (event) => {
      audio.srcObject = event.streams[0];
      void audio.play().catch(() => undefined);
    };
    const channel = pc.createDataChannel("oai-events");
    channelRef.current = channel;
    channel.addEventListener("message", (message) => {
      try {
        handleRealtimeEvent(JSON.parse(message.data) as RealtimeEvent);
      } catch {
        // Malformed provider events do not terminate the session.
      }
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
            const selected = selectedThreadIdRef.current;
            void endSession("network-reconnect")
              .then(() => selected ? connectRef.current(selected) : undefined)
              .catch((cause) => {
                setError(cause instanceof Error ? cause.message : "Talk could not reconnect.");
                setState("error");
              })
              .finally(() => {
                reconnectingRef.current = false;
              });
          }
        }, 3_000);
      }
    });
    const opened = new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error("The realtime data channel did not open.")), 15_000);
      channel.addEventListener("open", () => {
        window.clearTimeout(timer);
        setState("ready");
        resolve();
      }, { once: true });
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
    if (!sdp.ok) throw new Error("The realtime connection could not be established.");
    await pc.setRemoteDescription({ type: "answer", sdp: await sdp.text() });
    await opened;
    console.info("[todo-talk-ui] thread session connected", {
      threadId,
      sessionId: data.sessionId,
      model: data.model,
      voice: data.voice,
      historyCount: data.history.length,
      micAttached: false,
    });
  }, [endSession, handleRealtimeEvent]);

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  const ensureSession = useCallback(async () => {
    const threadId = selectedThreadIdRef.current;
    if (!threadId) throw new Error("Choose a conversation first.");
    if (!sessionIdRef.current || channelRef.current?.readyState !== "open") await connect(threadId);
  }, [connect]);

  const startAudio = useCallback(async () => {
    try {
      await ensureSession();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const track = stream.getAudioTracks()[0];
      if (!track || !senderRef.current) throw new Error("The microphone could not be attached.");
      streamRef.current?.getTracks().forEach((item) => item.stop());
      streamRef.current = stream;
      await senderRef.current.replaceTrack(track);
      setAudioEnabled(true);
      setMuted(false);
      responseModeRef.current = "audio";
      setState("listening");
      lastAddressedSpeechAtRef.current = Date.now();
      if (!messages.length) {
        requestRealtimeResponse({
          instructions: "Begin immediately. Name the highest-value useful topic or task and ask one terse question. No greeting or setup.",
        });
      }
      console.info("[todo-talk-ui] microphone attached to existing thread session", {
        threadId: selectedThreadIdRef.current,
        sessionId: sessionIdRef.current,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Microphone access could not be started.");
      setState(navigator.onLine ? "error" : "offline");
    }
  }, [ensureSession, messages.length, requestRealtimeResponse]);

  const stopAudio = useCallback(async () => {
    await senderRef.current?.replaceTrack(null).catch(() => undefined);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setAudioEnabled(false);
    setMuted(false);
    responseModeRef.current = "text";
    setState("ready");
    console.info("[todo-talk-ui] microphone detached; text session retained", {
      threadId: selectedThreadIdRef.current,
      sessionId: sessionIdRef.current,
    });
  }, []);

  const toggleMute = useCallback(() => {
    const next = !muted;
    streamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = !next;
    });
    setMuted(next);
    setState(next ? "muted" : "listening");
  }, [muted]);

  const uploadFile = useCallback(async (todoId: number, staged: StagedFile) => {
    setStagedFiles((current) => current.map((file) => file.localId === staged.localId
      ? { ...file, status: "uploading", error: undefined }
      : file));
    const endpoint = `/api/todos/${todoId}/attachments`;
    try {
      const attachment = await uploadTaskAttachment({
        file: staged.file,
        kind: staged.kind,
        durationMs: staged.durationMs,
        endpoint,
        request: api,
        discard: (uploadId) => api(`${endpoint}/${uploadId}?discard=1`, { method: "DELETE" }),
      });
      setStagedFiles((current) => current.map((file) => file.localId === staged.localId
        ? { ...file, status: "ready", attachmentId: attachment.id }
        : file));
      setAttachments((current) => [...current, attachment]);
      setSelectedAttachmentIds((current) => [...new Set([...current, attachment.id])]);
      console.info("[todo-talk-ui] focused-task attachment uploaded", {
        threadId: selectedThreadIdRef.current,
        todoId,
        attachmentId: attachment.id,
        kind: attachment.kind,
        bytes: attachment.byteSize,
      });
      return attachment.id;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Upload failed.";
      setStagedFiles((current) => current.map((file) => file.localId === staged.localId
        ? { ...file, status: "failed", error: message }
        : file));
      console.error("[todo-talk-ui] attachment upload failed", {
        threadId: selectedThreadIdRef.current,
        todoId,
        localId: staged.localId,
        kind: staged.kind,
        cause,
      });
      throw cause;
    }
  }, []);

  const addFiles = useCallback((files: File[], durationMs = 0) => {
    if (!focusedTodo) {
      setNotice("Mention the relevant task first so the assistant can identify it before attaching files.");
      return;
    }
    const available = Math.max(0, 12 - attachments.length - stagedFiles.length);
    const next = files.slice(0, available).map((file) => ({
      localId: crypto.randomUUID(),
      file,
      kind: attachmentKind(file),
      durationMs,
      status: "waiting" as const,
    }));
    if (!next.length) {
      setNotice("Tasks can have up to 12 attachments.");
      return;
    }
    setStagedFiles((current) => [...current, ...next]);
    if (navigator.onLine) {
      for (const staged of next) void uploadFile(focusedTodo.id, staged);
    } else {
      setNotice(`${next.length} attachment${next.length === 1 ? "" : "s"} saved locally until the message synchronizes.`);
    }
  }, [attachments.length, focusedTodo, stagedFiles.length, uploadFile]);

  const sendTextNow = useCallback(async (
    text: string,
    clientId: string,
    attachmentIds: string[],
  ) => {
    await ensureSession();
    responseModeRef.current = "text";
    if (responseActiveRef.current) {
      sendEvent({ type: "response.cancel" });
      pendingResponseRef.current = { output_modalities: ["text"] };
    }
    const attachmentInstruction = attachmentIds.length
      ? `\n\nThe user attached task attachment IDs: ${attachmentIds.join(", ")}. Inspect them when relevant.`
      : "";
    const realtimeItemId = realtimeConversationItemId(clientId);
    const sent = sendEvent({
      event_id: `todo-input-${realtimeItemId}`,
      type: "conversation.item.create",
      item: {
        id: realtimeItemId,
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `${text || "Review the attached items."}${attachmentInstruction}` }],
      },
    });
    if (!sent) throw new Error("The realtime session is not ready. Try sending again.");
    console.info("[todo-talk-ui] text conversation item sent", {
      threadId: selectedThreadIdRef.current,
      clientIdSuffix: clientId.slice(-8),
      realtimeItemIdLength: realtimeItemId.length,
      attachmentCount: attachmentIds.length,
    });
    await persistFinal("user", clientId, text || "Shared attachments", {
      channel: "text",
      attachmentIds,
    });
    if (!responseActiveRef.current && toolsRunningRef.current === 0) {
      requestRealtimeResponse({ output_modalities: ["text"] });
    }
    else pendingResponseRef.current = { output_modalities: ["text"] };
  }, [ensureSession, persistFinal, requestRealtimeResponse, sendEvent]);

  const sendMessage = useCallback(async (value = draft) => {
    const threadId = selectedThreadIdRef.current;
    if (!threadId) return;
    const text = value.trim();
    const readyIds = stagedFiles.flatMap((file) => file.status === "ready" && file.attachmentId ? [file.attachmentId] : []);
    const attachmentIds = [...new Set([...selectedAttachmentIds, ...readyIds])];
    if (!text && !attachmentIds.length && !stagedFiles.length) return;
    if (stagedFiles.some((file) => file.status === "uploading" || (navigator.onLine && file.status === "waiting"))) {
      setNotice("Wait for attachments to finish uploading.");
      return;
    }
    if (stagedFiles.some((file) => file.status === "failed")) {
      setNotice("Retry or remove failed attachments before sending.");
      return;
    }
    const clientId = crypto.randomUUID();
    const optimisticContent = text || "Shared attachments";
    const optimisticCreatedAt = new Date().toISOString();
    mergeMessage({
      id: `optimistic-${clientId}`,
      sessionId: sessionIdRef.current ?? "connecting",
      threadId,
      realtimeItemId: clientId,
      role: "user",
      content: optimisticContent,
      focusedTodoId: focusedTodoRef.current,
      metadata: {
        channel: "text",
        attachmentIds,
        sending: navigator.onLine,
      },
      createdAt: optimisticCreatedAt,
    });
    setState(sessionIdRef.current ? "thinking" : "connecting");
    console.info("[todo-talk-ui] typed message rendered optimistically", {
      threadId,
      clientIdSuffix: clientId.slice(-8),
      attachmentCount: attachmentIds.length,
      online: navigator.onLine,
    });
    setDraft("");
    draftDirtyRef.current = false;
    setDraftDirty(false);
    void saveOfflineTalkDraft(threadId, "");
    setThreads((current) => current.map((thread) => thread.id === threadId
      ? { ...thread, draftText: "" }
      : thread));
    if (navigator.onLine) {
      void api(`/api/talk/threads/${threadId}`, {
        method: "PATCH",
        body: JSON.stringify({ draftText: "" }),
      }).catch((cause) => {
        console.warn("[todo-talk-ui] cleared thread draft will retry later", { threadId, cause });
      });
    }
    setError("");
    setNotice("");
    if (!navigator.onLine) {
      const localAttachments: OfflineAssistantAttachment[] = stagedFiles.map((staged) => ({
        localId: staged.localId,
        kind: staged.kind,
        fileName: staged.file.name,
        mimeType: staged.file.type,
        durationMs: staged.durationMs,
        blob: staged.file,
      }));
      await saveOfflineTalkMessage({
        clientId,
        threadId,
        todoId: focusedTodoRef.current,
        text,
        attachmentIds,
        attachments: localAttachments,
        createdAt: new Date().toISOString(),
      });
      mergeMessage({
        id: clientId,
        sessionId: "offline",
        threadId,
        realtimeItemId: clientId,
        role: "user",
        content: optimisticContent,
        focusedTodoId: focusedTodoRef.current,
        metadata: { channel: "text", attachmentIds, waitingToSync: true },
        createdAt: optimisticCreatedAt,
      });
      setStagedFiles([]);
      setSelectedAttachmentIds([]);
      setNotice("Saved offline. The assistant will respond after reconnection.");
      return;
    }
    try {
      await sendTextNow(text, clientId, attachmentIds);
      setStagedFiles([]);
      setSelectedAttachmentIds([]);
    } catch (cause) {
      setMessages((current) => {
        const next = current.filter((message) => message.realtimeItemId !== clientId);
        cacheHistory(threadId, next);
        return next;
      });
      setDraft(text);
      draftDirtyRef.current = true;
      setDraftDirty(true);
      setError(cause instanceof Error ? cause.message : "The assistant could not respond.");
    }
  }, [draft, mergeMessage, selectedAttachmentIds, sendTextNow, stagedFiles]);

  const syncOfflineMessages = useCallback(async () => {
    const threadId = selectedThreadIdRef.current;
    if (!navigator.onLine || !threadId) return;
    const queued = await listOfflineTalkMessages(threadId);
    for (const message of queued) {
      try {
        const uploadedIds = [...message.attachmentIds];
        if (message.attachments.length && !message.todoId) throw new Error("Choose a task before synchronizing attachments.");
        for (const attachment of message.attachments) {
          const file = new File([attachment.blob], attachment.fileName, { type: attachment.mimeType });
          const endpoint = `/api/todos/${message.todoId}/attachments`;
          const uploaded = await uploadTaskAttachment({
            file,
            kind: attachment.kind,
            durationMs: attachment.durationMs,
            endpoint,
            request: api,
            discard: (uploadId) => api(`${endpoint}/${uploadId}?discard=1`, { method: "DELETE" }),
          });
          uploadedIds.push(uploaded.id);
        }
        await sendTextNow(message.text, message.clientId, uploadedIds);
        await deleteOfflineTalkMessage(message.clientId);
        console.info("[todo-talk-ui] offline thread message synchronized", {
          threadId,
          clientId: message.clientId,
          attachmentCount: uploadedIds.length,
        });
      } catch (cause) {
        console.error("[todo-talk-ui] offline thread synchronization deferred", {
          threadId,
          clientId: message.clientId,
          cause,
        });
        break;
      }
    }
  }, [sendTextNow]);

  const selectThread = useCallback(async (threadId: string) => {
    if (threadId === selectedThreadIdRef.current) {
      setDrawerOpen(false);
      return;
    }
    if (sessionIdRef.current) await endSession("thread-switch");
    setSelectedThreadId(threadId);
    selectedThreadIdRef.current = threadId;
    localStorage.setItem(SELECTED_THREAD_KEY, threadId);
    setDrawerOpen(false);
  }, [endSession]);

  const createThread = useCallback(async () => {
    try {
      const result = await api<{ thread: TalkThread }>("/api/talk/threads", {
        method: "POST",
        body: JSON.stringify({ title: "New conversation" }),
      });
      setThreads((current) => [...current, result.thread]);
      await selectThread(result.thread.id);
      window.setTimeout(() => composerRef.current?.focus(), 0);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "A conversation could not be created.");
    }
  }, [selectThread]);

  const renameThread = useCallback(async (thread: TalkThread) => {
    if (thread.kind !== "custom") return;
    const title = window.prompt("Conversation name", thread.title)?.trim();
    if (!title || title === thread.title) return;
    try {
      const result = await api<{ thread: TalkThread }>(`/api/talk/threads/${thread.id}`, {
        method: "PATCH",
        body: JSON.stringify({ title }),
      });
      setThreads((current) => current.map((item) => item.id === thread.id ? result.thread : item));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The conversation could not be renamed.");
    }
  }, []);

  const deleteThread = useCallback(async (thread: TalkThread) => {
    if (thread.kind !== "custom" || !window.confirm(`Delete “${thread.title}”? Task changes and memories will remain.`)) return;
    try {
      if (thread.id === selectedThreadIdRef.current && sessionIdRef.current) await endSession("thread-deleted");
      const result = await api<{ undoToken: string }>(`/api/talk/threads/${thread.id}`, { method: "DELETE" });
      setThreads((current) => current.filter((item) => item.id !== thread.id));
      setDeleteUndo({ token: result.undoToken, title: thread.title });
      if (thread.id === selectedThreadIdRef.current) {
        const fallback = threads.find((item) => item.id !== thread.id && item.kind === "general")
          ?? threads.find((item) => item.id !== thread.id)
          ?? null;
        setSelectedThreadId(fallback?.id ?? null);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The conversation could not be deleted.");
    }
  }, [endSession, threads]);

  const undoThreadDelete = useCallback(async () => {
    if (!deleteUndo) return;
    try {
      const result = await api<{ thread: TalkThread }>("/api/talk/threads", {
        method: "POST",
        body: JSON.stringify({ restoreToken: deleteUndo.token }),
      });
      setThreads((current) => [...current, result.thread]);
      setDeleteUndo(null);
      await selectThread(result.thread.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The conversation could not be restored.");
    }
  }, [deleteUndo, selectThread]);

  const undoAction = useCallback(async (message: TalkMessage) => {
    const token = typeof message.metadata.undoToken === "string" ? message.metadata.undoToken : "";
    if (!token) return;
    try {
      await api("/api/todos/undo", {
        method: "POST",
        body: JSON.stringify({ undoToken: token }),
      });
      setMessages((current) => current.map((item) => item.realtimeItemId === message.realtimeItemId
        ? { ...item, metadata: { ...item.metadata, undoToken: null, undone: true } }
        : item));
      setNotice("Action undone.");
      console.info("[todo-talk-ui] inline action undone", {
        threadId: selectedThreadIdRef.current,
        messageId: message.id,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That action could not be undone.");
    }
  }, []);

  useEffect(() => {
    refreshThreadsRef.current = refreshThreads;
    syncOfflineMessagesRef.current = syncOfflineMessages;
    endSessionRef.current = endSession;
  }, [endSession, refreshThreads, syncOfflineMessages]);

  useEffect(() => {
    mountedRef.current = true;
    const timer = window.setTimeout(() => {
      void refreshThreadsRef.current(false)
        .catch((cause) => setError(cause instanceof Error ? cause.message : "Talk could not be loaded."))
        .finally(() => setLoading(false));
    }, 0);
    const online = () => {
      setState((current) => current === "offline" ? "ready" : current);
      void syncOfflineMessagesRef.current();
    };
    const offline = () => {
      if (sessionIdRef.current) void endSessionRef.current("offline");
      setState("offline");
    };
    const visibility = () => {
      if (document.visibilityState !== "visible" && sessionIdRef.current) void endSessionRef.current("left-foreground");
    };
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      mountedRef.current = false;
      window.clearTimeout(timer);
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
      document.removeEventListener("visibilitychange", visibility);
      void endSessionRef.current("left-view");
    };
  }, []);

  useEffect(() => {
    if (!selectedThreadId || loading) return;
    const timer = window.setTimeout(() => {
      void loadThread(selectedThreadId).catch((cause) => {
        setError(cause instanceof Error ? cause.message : "The conversation could not be loaded.");
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadThread, loading, selectedThreadId]);

  useEffect(() => {
    if (!selectedThreadId || !draftDirty) return;
    const threadId = selectedThreadId;
    const timer = window.setTimeout(() => {
      void saveOfflineTalkDraft(threadId, draft);
      if (navigator.onLine) {
        void api(`/api/talk/threads/${threadId}`, {
          method: "PATCH",
          body: JSON.stringify({ draftText: draft }),
        }).then(() => {
          draftDirtyRef.current = false;
          setDraftDirty(false);
        }).catch((cause) => {
          console.warn("[todo-talk-ui] thread draft save deferred", { threadId, cause });
        });
      }
    }, 500);
    return () => window.clearTimeout(timer);
  }, [draft, draftDirty, selectedThreadId]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight, behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activities.length, liveAssistant, liveUser, messages.length, selectedThreadId]);

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
        const threadId = selectedThreadIdRef.current;
        const hadAudio = audioEnabled;
        void endSession("rollover")
          .then(() => threadId ? connectRef.current(threadId) : undefined)
          .then(() => hadAudio ? startAudio() : undefined)
          .catch((cause) => {
            setError(cause instanceof Error ? cause.message : "Talk could not roll over.");
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
          setError("This Talk session moved to a newer device or phone call.");
        }
      }).catch(() => undefined);
    }, HEARTBEAT_MS);
    return () => window.clearInterval(interval);
  }, [audioEnabled, endSession, sessionId, startAudio]);

  useEffect(() => {
    if (navigator.onLine && selectedThreadId) void syncOfflineMessages();
  }, [selectedThreadId, syncOfflineMessages]);

  useEffect(() => {
    if (!navigator.onLine || !focusedTodo) return;
    const waiting = stagedFiles.filter((staged) => staged.status === "waiting");
    if (!waiting.length) return;
    const timer = window.setTimeout(() => {
      for (const staged of waiting) void uploadFile(focusedTodo.id, staged);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [focusedTodo, stagedFiles, uploadFile]);

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = [...event.clipboardData.items]
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (files.length) addFiles(files);
  }

  function drop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragging(false);
    const files = [...event.dataTransfer.files];
    if (files.length) addFiles(files);
  }

  const activeProgress = [...activities].reverse().find((activity) => activity.status === "working");
  const progressLabel = activeProgress?.label
    ?? (!liveAssistant && state === "connecting" ? "Connecting"
      : !liveAssistant && state === "thinking" ? "Thinking"
        : null);

  if (loading) {
    return (
      <div className="h-[100dvh] overflow-hidden bg-[#f6f7f5]">
        <SiteHeader current="talk" />
        <main className="grid h-[calc(100dvh-3.5rem)] place-items-center text-sm text-[#768079]">Opening Talk…</main>
      </div>
    );
  }

  return (
    <div
      className="h-[100dvh] overflow-hidden bg-[#f6f7f5] text-[#252a27]"
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          setDragging(true);
        }
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }}
      onDrop={drop}
    >
      <SiteHeader current="talk" />
      <main className="mx-auto h-[calc(100dvh-3.5rem)] max-w-7xl overflow-hidden p-0 sm:p-3">
        <div className="relative grid h-full min-h-0 grid-cols-1 overflow-hidden border-black/[0.07] bg-white sm:rounded-3xl sm:border sm:shadow-[0_18px_60px_rgba(31,45,37,0.08)] lg:grid-cols-[300px_minmax(0,1fr)]">
          <aside className={`${drawerOpen ? "flex" : "hidden"} absolute inset-0 z-40 min-h-0 w-[min(88vw,320px)] flex-col border-r border-black/[0.07] bg-[#fbfcfa] shadow-2xl lg:static lg:z-auto lg:flex lg:w-auto lg:shadow-none`}>
            <div className="flex items-center gap-2 border-b border-black/[0.06] p-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">Conversations</p>
                <p className="text-xs text-[#838b86]">Text and audio, one context</p>
              </div>
              <button type="button" onClick={() => void createThread()} className="grid h-10 w-10 place-items-center rounded-xl bg-[#216e4e] text-white" aria-label="New conversation" title="New conversation"><ActionIcon name="add" /></button>
              <button type="button" onClick={() => setDrawerOpen(false)} className="grid h-10 w-10 place-items-center rounded-xl text-[#66706a] hover:bg-black/[0.04] lg:hidden" aria-label="Close conversations"><ActionIcon name="close" /></button>
            </div>
            <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2" aria-label="Talk conversations">
              {threads.map((thread) => (
                <div key={thread.id} className={`group flex items-center rounded-xl border transition ${thread.id === selectedThreadId ? "border-[#c9ded0] bg-[#eaf3ed]" : "border-transparent hover:bg-white"}`}>
                  <button type="button" onClick={() => void selectThread(thread.id)} className="min-w-0 flex-1 px-3 py-2.5 text-left">
                    <div className="flex items-center gap-2">
                      <ActionIcon name={thread.kind === "phone" ? "phone" : thread.kind === "general" ? "assistant" : "folder"} className={`h-4 w-4 shrink-0 ${thread.kind === "phone" ? "text-[#216e4e]" : "text-[#77807b]"}`} />
                      <p className="truncate text-sm font-semibold">{thread.title}</p>
                      {thread.messageCount > 0 && <span className="ml-auto text-[10px] tabular-nums text-[#89918c]">{thread.messageCount}</span>}
                    </div>
                    <p className="mt-1 line-clamp-1 pl-6 text-xs text-[#838b86]">{thread.preview || (thread.kind === "phone" ? "All phone conversations" : "No messages yet")}</p>
                  </button>
                  {thread.kind === "custom" && (
                    <div className="mr-1 flex shrink-0 lg:opacity-0 lg:transition lg:group-hover:opacity-100 lg:group-focus-within:opacity-100">
                      <button type="button" onClick={() => void renameThread(thread)} className="grid h-9 w-8 place-items-center rounded-lg text-[#7b837e] hover:bg-white hover:text-[#216e4e]" aria-label={`Rename ${thread.title}`} title="Rename"><ActionIcon name="edit" className="h-3.5 w-3.5" /></button>
                      <button type="button" onClick={() => void deleteThread(thread)} className="grid h-9 w-8 place-items-center rounded-lg text-[#9a6d69] hover:bg-red-50 hover:text-red-700" aria-label={`Delete ${thread.title}`} title="Delete"><ActionIcon name="delete" className="h-3.5 w-3.5" /></button>
                    </div>
                  )}
                </div>
              ))}
            </nav>
          </aside>
          {drawerOpen && <button type="button" className="absolute inset-0 z-30 bg-black/25 lg:hidden" onClick={() => setDrawerOpen(false)} aria-label="Close conversations" />}

          <section className="flex min-h-0 min-w-0 flex-col bg-white">
            <header className="flex min-h-14 items-center gap-2 border-b border-black/[0.06] px-3 py-2 sm:px-4">
              <button type="button" onClick={() => setDrawerOpen(true)} className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-[#59615c] hover:bg-[#f1f2f0] lg:hidden" aria-label="Open conversations"><ActionIcon name="menu" className="h-5 w-5" /></button>
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-sm font-semibold">{selectedThread?.title ?? "Talk"}</h1>
                <p className="truncate text-[11px] text-[#818984]">
                  {sessionId ? (audioEnabled ? (muted ? "Muted" : state === "speaking" ? "Speaking" : state === "thinking" ? "Thinking" : "Listening") : "Text session active") : state === "offline" ? "Offline" : "Ready"}
                </p>
              </div>
              {sessionId && (
                <button type="button" onClick={() => void endSession("user-ended")} className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-[#626b66] hover:bg-[#f1f2f0]" aria-label="End realtime session" title="End session"><ActionIcon name="stop" className="h-4 w-4" /></button>
              )}
            </header>

            <div ref={messagesRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-5 sm:px-7" aria-live="polite">
              <div className="mx-auto max-w-3xl space-y-4">
                {!messages.length && !liveUser && !liveAssistant && (
                  <div className="grid min-h-[45vh] place-items-center text-center">
                    <div>
                      <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-[#eaf3ed] text-[#216e4e]"><ActionIcon name="assistant" className="h-7 w-7" /></span>
                      <p className="mt-4 font-semibold">What should we move forward?</p>
                      <p className="mt-1 text-sm text-[#7b837e]">Type, attach context, or start talking.</p>
                    </div>
                  </div>
                )}
                {messages.map((message) => {
                  const isUser = message.role === "user";
                  const isTool = message.role === "tool";
                  const sources = sourceList(message.metadata);
                  const undoToken = typeof message.metadata.undoToken === "string" ? message.metadata.undoToken : null;
                  const failed = message.metadata.status === "failed";
                  return (
                    <article key={message.realtimeItemId} className={isUser ? "ml-auto max-w-[88%]" : "max-w-[94%]"}>
                      {isTool ? (
                        <div className={`rounded-2xl border px-3.5 py-3 ${failed ? "border-red-200 bg-red-50" : "border-[#d4e4da] bg-[#f3f8f4]"}`}>
                          <div className="flex items-start gap-2.5">
                            <span className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg ${failed ? "bg-red-100 text-red-700" : "bg-[#e2f0e7] text-[#216e4e]"}`}>
                              <ActionIcon name={failed ? "retry" : "done"} className="h-4 w-4" />
                            </span>
                            <div className="min-w-0 flex-1">
                              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#6d7671]">{activityLabel(String(message.metadata.tool ?? "activity"))}</p>
                              <p className="mt-1 text-sm leading-5 text-[#3d4641]">{message.content}</p>
                              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                                {undoToken && !message.metadata.undone && (
                                  <button type="button" onClick={() => void undoAction(message)} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-white px-2.5 text-xs font-semibold text-[#216e4e] shadow-sm"><ActionIcon name="undo" className="h-3.5 w-3.5" />Undo</button>
                                )}
                                {Boolean(message.metadata.undone) && <span className="text-xs font-medium text-[#78817c]">Undone</span>}
                                {typeof message.metadata.taskId === "number" && <Link href="/" className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold text-[#59615c] hover:bg-white"><ActionIcon name="view-open" className="h-3.5 w-3.5" />Open task</Link>}
                                {failed && <button type="button" onClick={() => void sendMessage(`Retry the failed action: ${message.content}`)} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-white px-2.5 text-xs font-semibold text-red-700"><ActionIcon name="retry" className="h-3.5 w-3.5" />Retry</button>}
                              </div>
                              {sources.length > 0 && (
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                  {sources.slice(0, 5).map((source) => <a key={source.url} href={source.url} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 rounded-lg bg-white px-2 py-1 text-[11px] text-[#4f5752] hover:text-[#216e4e]"><ActionIcon name="link" className="h-3 w-3" /><span className="truncate">{source.title}</span></a>)}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className={`rounded-2xl px-4 py-3 text-sm leading-6 ${isUser ? "rounded-br-md bg-[#216e4e] text-white" : "rounded-bl-md bg-[#f2f3f1] text-[#303733]"}`}>
                          <p className="whitespace-pre-wrap">{message.content}</p>
                          {Boolean(message.metadata.waitingToSync) && <p className="mt-1 text-[11px] opacity-65">Waiting to sync</p>}
                        </div>
                      )}
                    </article>
                  );
                })}
                {progressLabel && (
                  <div role="status" aria-live="polite" className="flex items-center gap-2 px-1 py-0.5 text-xs font-medium text-[#7a837e]">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#c27b16]" />
                    <span>{progressLabel}…</span>
                  </div>
                )}
                {liveUser && (
                  <article className="ml-auto max-w-[88%] rounded-2xl rounded-br-md bg-[#216e4e]/85 px-4 py-3 text-sm leading-6 text-white">
                    <p>{liveUser}</p>
                  </article>
                )}
                {liveAssistant && (
                  <article className="max-w-[94%] rounded-2xl rounded-bl-md bg-[#f2f3f1] px-4 py-3 text-sm leading-6 text-[#303733]">
                    <p>{liveAssistant}</p>
                  </article>
                )}
              </div>
            </div>

            <div className="border-t border-black/[0.07] bg-white px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2.5 sm:px-6 sm:pb-4">
              <div className="mx-auto max-w-3xl">
                {(attachments.length > 0 || stagedFiles.length > 0) && (
                  <div className="mb-2 flex gap-2 overflow-x-auto pb-1">
                    {attachments.map((attachment) => {
                      const selected = selectedAttachmentIds.includes(attachment.id);
                      return (
                        <button key={attachment.id} type="button" onClick={() => setSelectedAttachmentIds((ids) => selected ? ids.filter((id) => id !== attachment.id) : [...ids, attachment.id])} className={`inline-flex h-9 max-w-52 shrink-0 items-center gap-1.5 rounded-xl border px-2.5 text-xs font-medium ${selected ? "border-[#7fb49b] bg-[#eaf3ed] text-[#216e4e]" : "border-black/[0.08] bg-white text-[#6a726d]"}`}>
                          <ActionIcon name={attachment.kind === "image" ? "image" : attachment.kind === "audio" ? "mic" : attachment.kind === "video" ? "camera" : "file"} className="h-3.5 w-3.5" />
                          <span className="truncate">{attachment.fileName}</span>
                        </button>
                      );
                    })}
                    {stagedFiles.map((staged) => (
                      <div key={staged.localId} className={`inline-flex h-9 max-w-56 shrink-0 items-center gap-1.5 rounded-xl border px-2.5 text-xs ${staged.status === "failed" ? "border-red-200 bg-red-50 text-red-700" : "border-[#d7dfda] bg-[#f5f7f5] text-[#6a726d]"}`}>
                        <ActionIcon name={staged.status === "uploading" ? "retry" : staged.kind === "image" ? "image" : staged.kind === "audio" ? "mic" : staged.kind === "video" ? "camera" : "file"} className={`h-3.5 w-3.5 ${staged.status === "uploading" ? "animate-spin" : ""}`} />
                        <span className="truncate">{staged.file.name}</span>
                        {staged.status === "failed" && focusedTodo && <button type="button" onClick={() => void uploadFile(focusedTodo.id, staged)} className="font-semibold underline">Retry</button>}
                        <button type="button" onClick={() => setStagedFiles((files) => files.filter((file) => file.localId !== staged.localId))} aria-label={`Remove ${staged.file.name}`}><ActionIcon name="close" className="h-3 w-3" /></button>
                      </div>
                    ))}
                  </div>
                )}
                {error && <p role="alert" className="mb-2 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
                {notice && <p className="mb-2 rounded-xl bg-[#f1f4f1] px-3 py-2 text-xs text-[#59615c]">{notice}</p>}
                {audioEnabled && (
                  <div className="mb-2 flex items-center gap-2 rounded-xl bg-[#edf4ef] px-2.5 py-1.5">
                    <span className={`h-2 w-2 rounded-full ${muted ? "bg-red-500" : state === "speaking" ? "bg-[#c27b16]" : "animate-pulse bg-[#218257]"}`} />
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-[#53605a]">{muted ? "Microphone muted" : state === "speaking" ? "Assistant speaking" : state === "thinking" ? "Thinking" : "Listening"}</span>
                    <button type="button" onClick={toggleMute} className={`grid h-8 w-8 place-items-center rounded-lg ${muted ? "bg-red-100 text-red-700" : "bg-white text-[#45504a]"}`} aria-label={muted ? "Unmute Talk" : "Mute Talk"}><ActionIcon name={muted ? "mic-off" : "mic"} className="h-4 w-4" /></button>
                    <button type="button" onClick={() => void stopAudio()} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-white px-2.5 text-xs font-semibold text-[#45504a]" aria-label="Stop talking"><ActionIcon name="stop" className="h-3.5 w-3.5" />Stop audio</button>
                  </div>
                )}
                <div className="flex items-end gap-1 rounded-2xl border border-black/[0.09] bg-[#fbfcfa] p-2 shadow-sm focus-within:border-[#7fb49b] focus-within:ring-2 focus-within:ring-[#dcece2]">
                  <AssistantAttachmentMenu
                    disabled={!selectedThread}
                    onFiles={addFiles}
                    onRecord={() => setRecording(true)}
                    onNeedsTask={() => {
                      if (focusedTodo) return false;
                      setNotice("Mention the relevant task first so the assistant can identify it before attaching files.");
                      return true;
                    }}
                  />
                  <textarea
                    ref={composerRef}
                    value={draft}
                    onChange={(event) => {
                      setDraft(event.target.value);
                      draftDirtyRef.current = true;
                      setDraftDirty(true);
                    }}
                    onPaste={onPaste}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        void sendMessage();
                      }
                    }}
                    rows={1}
                    placeholder={selectedThread ? "Message your assistant…" : "Create a conversation to begin"}
                    disabled={!selectedThread}
                    className="max-h-36 min-h-10 min-w-0 flex-1 resize-none bg-transparent px-2 py-2.5 text-base leading-5 outline-none sm:text-sm"
                  />
                  {!audioEnabled && (
                    <button type="button" onClick={() => void startAudio()} disabled={!selectedThread || state === "connecting" || state === "offline"} className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-[#216e4e] transition hover:bg-[#eaf3ed] disabled:opacity-35" aria-label="Start talking" title="Start talking"><ActionIcon name="mic" className="h-5 w-5" /></button>
                  )}
                  <button type="button" onClick={() => void sendMessage()} disabled={!selectedThread || (!draft.trim() && !selectedAttachmentIds.length && !stagedFiles.length)} className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#216e4e] text-white transition hover:bg-[#195c40] disabled:bg-[#b8c9be]" aria-label="Send message"><ActionIcon name="next" className="h-5 w-5" /></button>
                </div>
              </div>
            </div>
          </section>
        </div>
      </main>

      {deleteUndo && (
        <div className="fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] left-1/2 z-[85] flex w-[min(92vw,480px)] -translate-x-1/2 items-center gap-3 rounded-2xl bg-[#202622] px-4 py-3 text-white shadow-2xl">
          <p className="min-w-0 flex-1 truncate text-sm">Deleted “{deleteUndo.title}”</p>
          <button type="button" onClick={() => void undoThreadDelete()} className="inline-flex items-center gap-1.5 text-sm font-semibold text-[#8ee0b1]"><ActionIcon name="undo" />Undo</button>
          <button type="button" onClick={() => setDeleteUndo(null)} className="grid h-8 w-8 place-items-center rounded-lg text-white/70" aria-label="Dismiss"><ActionIcon name="close" /></button>
        </div>
      )}

      {dragging && (
        <div className="pointer-events-none fixed inset-3 z-[90] grid place-items-center rounded-3xl border-2 border-dashed border-[#4a9870] bg-[#eaf3ed]/90 backdrop-blur-sm">
          <div className="text-center text-[#216e4e]"><ActionIcon name="attachment" className="mx-auto mb-3 h-9 w-9" /><p className="font-semibold">{focusedTodo ? `Attach to ${focusedTodo.title}` : "Mention the relevant task first"}</p><p className="mt-1 text-sm">Drop photos, videos, voice memos, or files</p></div>
        </div>
      )}
      {recording && <AssistantVoiceRecorder onClose={() => setRecording(false)} onRecorded={(file, durationMs) => { setRecording(false); addFiles([file], durationMs); }} />}
    </div>
  );
}
