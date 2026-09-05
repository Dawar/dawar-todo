"use client";
import { taskSync } from "../task-sync";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
} from "react";
import { ActionIcon } from "../action-icon";
import {
  deleteOfflineAssistantMessage,
  listOfflineAssistantMessages,
  loadOfflineAssistantDraft,
  saveOfflineAssistantDraft,
  saveOfflineAssistantMessage,
  type OfflineAssistantAttachment,
} from "../offline-store";
import { uploadTaskAttachment, uploadTaskAttachmentMultipart } from "../attachment-upload-client";
import { SiteHeader } from "../site-header";
import type {
  AssistantMessage,
  AssistantNavigatorView,
  AssistantThread,
} from "../../db/assistant";
import type { TodoAttachment } from "../../db/attachments";
import type { Todo } from "../../db/todos";

type WorkspacePayload = {
  todos: Todo[];
  projects: string[];
  workspace: {
    selectedTodoId: number | null;
    navigatorView: AssistantNavigatorView;
  };
  thread: AssistantThread | null;
};

type StagedFile = {
  localId: string;
  file: File;
  kind: "image" | "audio" | "video" | "file";
  durationMs: number;
  status: "waiting" | "uploading" | "failed";
  error?: string;
};

const VIEW_LABELS: Array<{ value: AssistantNavigatorView; label: string }> = [
  { value: "open", label: "Open" },
  { value: "snoozed", label: "Snoozed" },
  { value: "done", label: "Done" },
  { value: "all", label: "All" },
];

function attachmentKind(file: File): StagedFile["kind"] {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("audio/")) return "audio";
  if (file.type.startsWith("video/")) return "video";
  return "file";
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

function activelySnoozed(todo: Todo, now: number) {
  return todo.status === "open" && Boolean(todo.snoozedUntil && new Date(todo.snoozedUntil).valueOf() > now);
}

function shortDate(value: string | null) {
  if (!value) return "";
  const date = new Date(value.length === 10 ? `${value}T12:00:00` : value);
  if (Number.isNaN(date.valueOf())) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...(value.length > 10 ? { hour: "numeric", minute: "2-digit" } : {}),
  }).format(date);
}

function relativeStatus(todo: Todo, now: number) {
  if (todo.status === "completed") return "Done";
  if (activelySnoozed(todo, now)) return `Snoozed to ${shortDate(todo.snoozedUntil)}`;
  if (todo.dueDate) return `Due ${shortDate(todo.dueDate)}`;
  return "Open";
}

function VoiceRecorder({
  onClose,
  onRecorded,
}: {
  onClose: () => void;
  onRecorded: (file: File, durationMs: number) => void;
}) {
  const [phase, setPhase] = useState<"idle" | "recording">("idle");
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);

  useEffect(() => {
    if (phase !== "recording") return;
    const timer = window.setInterval(() => setElapsed(Date.now() - startedAtRef.current), 250);
    return () => window.clearInterval(timer);
  }, [phase]);

  useEffect(() => () => {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  async function start() {
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const type = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find((candidate) => MediaRecorder.isTypeSupported(candidate));
      const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      chunksRef.current = [];
      streamRef.current = stream;
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };
      recorder.onstop = () => {
        const durationMs = Math.max(1, Date.now() - startedAtRef.current);
        const mimeType = recorder.mimeType.split(";", 1)[0] || "audio/webm";
        const extension = mimeType === "audio/mp4" ? "m4a" : "webm";
        const file = new File(chunksRef.current, `Voice memo ${new Date().toISOString().replace(/[:.]/g, "-")}.${extension}`, { type: mimeType });
        stream.getTracks().forEach((track) => track.stop());
        console.info("[todo-assistant-ui] voice memo recorded", { bytes: file.size, durationMs, mimeType });
        onRecorded(file, durationMs);
      };
      recorder.start(750);
      startedAtRef.current = Date.now();
      setElapsed(0);
      setPhase("recording");
    } catch (cause) {
      console.error("[todo-assistant-ui] voice recorder start failed", cause);
      setError("Microphone access could not be started.");
    }
  }

  function stop() {
    recorderRef.current?.stop();
    setPhase("idle");
  }

  const seconds = Math.round(elapsed / 1000);
  return (
    <div className="fixed inset-0 z-[90] flex items-end justify-center sm:items-center sm:p-5" role="dialog" aria-modal="true" aria-label="Record voice memo">
      <button type="button" className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={onClose} aria-label="Close voice recorder" />
      <div className="relative w-full rounded-t-3xl bg-white p-6 shadow-2xl sm:max-w-sm sm:rounded-3xl">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Voice memo</h2>
          <button type="button" onClick={onClose} className="grid h-9 w-9 place-items-center rounded-full bg-[#f1f2f0]" aria-label="Close"><ActionIcon name="close" /></button>
        </div>
        <div className="py-9 text-center">
          <div className={`mx-auto mb-4 grid h-20 w-20 place-items-center rounded-full ${phase === "recording" ? "animate-pulse bg-red-100 text-red-700" : "bg-[#eaf3ed] text-[#216e4e]"}`}>
            <ActionIcon name={phase === "recording" ? "stop" : "mic"} className="h-9 w-9" />
          </div>
          <p className="font-mono text-3xl font-semibold tabular-nums">{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</p>
          <p className="mt-2 text-sm text-[#7b837e]">{phase === "recording" ? "Recording…" : "Ready when you are"}</p>
        </div>
        {error && <p className="mb-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        <button
          type="button"
          onClick={phase === "recording" ? stop : () => void start()}
          className={`inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl text-sm font-semibold text-white ${phase === "recording" ? "bg-red-700" : "bg-[#216e4e]"}`}
        >
          <ActionIcon name={phase === "recording" ? "stop" : "mic"} />
          {phase === "recording" ? "Finish recording" : "Start recording"}
        </button>
      </div>
    </div>
  );
}

function AttachmentMenu({
  disabled,
  onFiles,
  onRecord,
}: {
  disabled: boolean;
  onFiles: (files: File[]) => void;
  onRecord: () => void;
}) {
  const [open, setOpen] = useState(false);
  const mediaRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  function selected(input: HTMLInputElement) {
    const files = [...(input.files ?? [])];
    input.value = "";
    setOpen(false);
    if (files.length) onFiles(files);
  }
  return (
    <div className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        className="grid h-10 w-10 place-items-center rounded-xl text-[#216e4e] transition hover:bg-[#eaf3ed] disabled:opacity-40"
        aria-label="Add attachment"
        aria-expanded={open}
      >
        <ActionIcon name="attachment" className="h-5 w-5" />
      </button>
      {open && (
        <>
          <button type="button" className="fixed inset-0 z-40 cursor-default" onClick={() => setOpen(false)} aria-label="Close attachment menu" />
          <div className="absolute bottom-12 left-0 z-50 w-60 rounded-2xl border border-black/[0.08] bg-white p-1.5 shadow-xl">
            <button type="button" onClick={() => mediaRef.current?.click()} className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm font-semibold hover:bg-[#f2f5f2]"><ActionIcon name="image" />Photos or videos</button>
            <button type="button" onClick={() => fileRef.current?.click()} className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm font-semibold hover:bg-[#f2f5f2]"><ActionIcon name="file" />Files</button>
            <button type="button" onClick={() => { setOpen(false); onRecord(); }} className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm font-semibold hover:bg-[#f2f5f2]"><ActionIcon name="mic" />Record voice memo</button>
          </div>
        </>
      )}
      <input ref={mediaRef} type="file" accept="image/*,video/*" multiple className="sr-only" onChange={(event) => selected(event.currentTarget)} />
      <input ref={fileRef} type="file" multiple className="sr-only" onChange={(event) => selected(event.currentTarget)} />
    </div>
  );
}

export function AssistantWorkspace() {
  const [data, setData] = useState<WorkspacePayload | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [thread, setThread] = useState<AssistantThread | null>(null);
  const [view, setView] = useState<AssistantNavigatorView>("open");
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState("");
  const [draftDirty, setDraftDirty] = useState(false);
  const [attachments, setAttachments] = useState<TodoAttachment[]>([]);
  const [selectedAttachmentIds, setSelectedAttachmentIds] = useState<string[]>([]);
  const [attachmentSelectionReady, setAttachmentSelectionReady] = useState(false);
  const [stagedFiles, setStagedFiles] = useState<StagedFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [mobileConversation, setMobileConversation] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [recording, setRecording] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const draftDirtyRef = useRef(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);

  const selectedTodo = useMemo(() => data?.todos.find((todo) => todo.id === selectedId) ?? null, [data?.todos, selectedId]);

  const refresh = useCallback(async (taskId?: number | null, preserveDraft = true) => {
    const suffix = taskId ? `?taskId=${taskId}` : "";
    const payload = await api<WorkspacePayload>(`/api/assistant${suffix}`);
    setData(payload);
    setView(payload.workspace.navigatorView);
    setSelectedId(payload.workspace.selectedTodoId);
    setThread(payload.thread);
    if (!preserveDraft || !draftDirtyRef.current) setDraft(payload.thread?.draftText ?? "");
    if (!preserveDraft) {
      setSelectedAttachmentIds(payload.thread?.draftAttachmentIds ?? []);
      setAttachmentSelectionReady(true);
    }
    return payload;
  }, []);

  const loadAttachments = useCallback(async (taskId: number | null) => {
    if (!taskId) {
      setAttachments([]);
      return;
    }
    try {
      const payload = await api<{ attachments: TodoAttachment[] }>(`/api/todos/${taskId}/attachments`);
      setAttachments(payload.attachments);
      setSelectedAttachmentIds((ids) => ids.filter((id) => payload.attachments.some((attachment) => attachment.id === id)));
    } catch (cause) {
      console.error("[todo-assistant-ui] attachment load failed", { taskId, cause });
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refresh(null, false)
        .then((payload) => loadAttachments(payload.workspace.selectedTodoId))
        .catch((cause) => setError(cause instanceof Error ? cause.message : "The assistant could not be loaded."))
        .finally(() => setLoading(false));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadAttachments, refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    void loadOfflineAssistantDraft(selectedId).then((local) => {
      if (local && !thread?.draftText) {
        setDraft((current) => current || local.text);
      }
    }).catch(() => undefined);
  }, [selectedId, thread?.draftText]);

  useEffect(() => {
    if (!selectedId || !draftDirty) return;
    const taskId = selectedId;
    const timer = window.setTimeout(() => {
      void saveOfflineAssistantDraft(taskId, draft);
      if (navigator.onLine) {
        void api("/api/assistant", {
          method: "PATCH",
          body: JSON.stringify({ taskId, draftText: draft }),
        }).then(() => {
          draftDirtyRef.current = false;
          setDraftDirty(false);
        }).catch((cause) => {
          console.warn("[todo-assistant-ui] server draft save deferred", { taskId, cause });
        });
      }
    }, 500);
    return () => window.clearTimeout(timer);
  }, [draft, draftDirty, selectedId]);

  useEffect(() => {
    if (!selectedId || !attachmentSelectionReady) return;
    const taskId = selectedId;
    const timer = window.setTimeout(() => {
      if (!navigator.onLine) return;
      void api("/api/assistant", {
        method: "PATCH",
        body: JSON.stringify({ taskId, draftAttachmentIds: selectedAttachmentIds }),
      }).catch((cause) => {
        console.warn("[todo-assistant-ui] attachment draft save deferred", { taskId, cause });
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [attachmentSelectionReady, selectedAttachmentIds, selectedId]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (navigator.onLine && !busy && selectedId) {
        void refresh(selectedId, true).catch((cause) => console.warn("[todo-assistant-ui] realtime refresh deferred", cause));
      }
    }, 5000);
    return () => window.clearInterval(timer);
  }, [busy, refresh, selectedId]);

  useEffect(() => {
    messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight, behavior: "smooth" });
  }, [thread?.messages.length, busy, selectedId]);

  const uploadFile = useCallback(async (taskId: number, staged: StagedFile) => {
    setStagedFiles((files) => files.map((file) => file.localId === staged.localId ? { ...file, status: "uploading", error: undefined } : file));
    const endpoint = `/api/todos/${taskId}/attachments`;
    try {
      const attachment = await uploadTaskAttachment({
        file: staged.file,
        kind: staged.kind,
        durationMs: staged.durationMs,
        endpoint,
        request: api,
        discard: (uploadId) => api(`${endpoint}/${uploadId}?discard=1`, { method: "DELETE" }),
      });
      setStagedFiles((files) => files.filter((file) => file.localId !== staged.localId));
      setAttachments((current) => [...current, attachment]);
      setSelectedAttachmentIds((current) => [...new Set([...current, attachment.id])]);
      console.info("[todo-assistant-ui] attachment uploaded", {
        taskId,
        attachmentId: attachment.id,
        kind: attachment.kind,
        bytes: attachment.byteSize,
      });
      return attachment.id;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Upload failed.";
      setStagedFiles((files) => files.map((file) => file.localId === staged.localId ? { ...file, status: "failed", error: message } : file));
      console.error("[todo-assistant-ui] attachment upload failed", { taskId, localId: staged.localId, kind: staged.kind, cause });
      throw cause;
    }
  }, []);

  const addFiles = useCallback((files: File[], durationMs = 0) => {
    if (!selectedId) return;
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
      for (const staged of next) void uploadFile(selectedId, staged);
    } else {
      setNotice(`${next.length} attachment${next.length === 1 ? "" : "s"} saved locally until you send.`);
    }
  }, [attachments.length, selectedId, stagedFiles.length, uploadFile]);

  const syncOfflineMessages = useCallback(async (signal?: AbortSignal) => {
    if (!navigator.onLine) return;
    const queued = await listOfflineAssistantMessages();
    if (!queued.length) return;
    for (const message of queued) {
      if (signal?.aborted) return;
      try {
        const uploadedIds = [...message.attachmentIds];
        for (const attachment of message.attachments) {
          const file = new File([attachment.blob], attachment.fileName, { type: attachment.mimeType });
          const endpoint = `/api/todos/${message.todoId}/attachments`;
          const uploaded = await uploadTaskAttachmentMultipart({
            clientUploadId: attachment.localId,
            file,
            kind: attachment.kind,
            durationMs: attachment.durationMs,
            endpoint,
            request: api,
          });
          uploadedIds.push(uploaded.id);
        }
        if (signal?.aborted) return;
        await api("/api/assistant/messages", {
          method: "POST",
          body: JSON.stringify({
            taskId: message.todoId,
            text: message.text,
            clientId: message.clientId,
            attachmentIds: uploadedIds,
          }),
        });
        await deleteOfflineAssistantMessage(message.clientId);
        console.info("[todo-assistant-ui] offline message synchronized", {
          clientId: message.clientId,
          taskId: message.todoId,
          uploadedAttachmentCount: message.attachments.length,
        });
      } catch (cause) {
        console.error("[todo-assistant-ui] offline message synchronization deferred", {
          clientId: message.clientId,
          taskId: message.todoId,
          cause,
        });
        throw cause;
      }
    }
    if (selectedId) {
      await refresh(selectedId, false);
      await loadAttachments(selectedId);
    }
  }, [loadAttachments, refresh, selectedId]);

  useEffect(() => taskSync.registerLane("assistant", syncOfflineMessages), [syncOfflineMessages]);

  async function selectTask(todoId: number) {
    setSelectedId(todoId);
    setMobileConversation(true);
    setError("");
    setSelectedAttachmentIds([]);
    setAttachmentSelectionReady(false);
    setStagedFiles([]);
    try {
      await api("/api/assistant", { method: "PATCH", body: JSON.stringify({ selectedTodoId: todoId }) });
      const payload = await refresh(todoId, false);
      setThread(payload.thread);
      await loadAttachments(todoId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The conversation could not be loaded.");
    }
  }

  async function changeView(nextView: AssistantNavigatorView) {
    setView(nextView);
    void api("/api/assistant", { method: "PATCH", body: JSON.stringify({ navigatorView: nextView }) }).catch((cause) => {
      console.warn("[todo-assistant-ui] navigator preference save failed", cause);
    });
  }

  async function sendMessage(value = draft) {
    if (!selectedId || busy) return;
    const text = value.trim();
    if (!text && !selectedAttachmentIds.length && !stagedFiles.length) return;
    const clientId = crypto.randomUUID();
    if (!navigator.onLine) {
      const localAttachments: OfflineAssistantAttachment[] = stagedFiles.map((staged) => ({
        localId: staged.localId,
        kind: staged.kind,
        fileName: staged.file.name,
        mimeType: staged.file.type,
        durationMs: staged.durationMs,
        blob: staged.file,
      }));
      await saveOfflineAssistantMessage({
        clientId,
        todoId: selectedId,
        text,
        attachmentIds: selectedAttachmentIds,
        attachments: localAttachments,
        createdAt: new Date().toISOString(),
      });
      const optimistic: AssistantMessage = {
        id: clientId,
        todoId: selectedId,
        role: "user",
        kind: "offline",
        content: text,
        question: null,
        proposal: null,
        sources: [],
        attachmentIds: selectedAttachmentIds,
        clientId,
        createdAt: new Date().toISOString(),
      };
      setThread((current) => current ? { ...current, draftText: "", messages: [...current.messages, optimistic] } : current);
      setDraft("");
      draftDirtyRef.current = false;
      setDraftDirty(false);
      setStagedFiles([]);
      setSelectedAttachmentIds([]);
      setAttachmentSelectionReady(true);
      setNotice("Saved offline. The assistant will continue when you reconnect.");
      return;
    }
    if (stagedFiles.some((file) => file.status !== "failed")) {
      setNotice("Wait for attachments to finish uploading.");
      return;
    }
    setBusy(true);
    setError("");
    const optimistic: AssistantMessage = {
      id: clientId,
      todoId: selectedId,
      role: "user",
      kind: "message",
      content: text,
      question: null,
      proposal: null,
      sources: [],
      attachmentIds: selectedAttachmentIds,
      clientId,
      createdAt: new Date().toISOString(),
    };
    setThread((current) => current ? { ...current, draftText: "", messages: [...current.messages, optimistic] } : current);
    setDraft("");
    draftDirtyRef.current = false;
    setDraftDirty(false);
    try {
      const payload = await api<{ thread: AssistantThread }>("/api/assistant/messages", {
        method: "POST",
        body: JSON.stringify({ taskId: selectedId, text, clientId, attachmentIds: selectedAttachmentIds }),
      });
      setThread(payload.thread);
      setSelectedAttachmentIds([]);
      setAttachmentSelectionReady(true);
      await refresh(selectedId, true);
    } catch (cause) {
      setThread((current) => current ? { ...current, messages: current.messages.filter((message) => message.id !== clientId) } : current);
      setDraft(text);
      draftDirtyRef.current = true;
      setDraftDirty(true);
      setError(cause instanceof Error ? cause.message : "The assistant could not respond.");
    } finally {
      setBusy(false);
    }
  }

  async function assistantAction(action: "skip" | "pause" | "resume" | "apply" | "dismiss", messageId?: string) {
    if (!selectedId || busy) return;
    setBusy(true);
    setError("");
    try {
      const payload = await api<{ thread: AssistantThread; todo?: Todo; undoToken?: string | null }>("/api/assistant/actions", {
        method: "POST",
        body: JSON.stringify({ taskId: selectedId, action, messageId }),
      });
      setThread(payload.thread);
      if (payload.todo) {
        setData((current) => current ? {
          ...current,
          todos: current.todos.map((todo) => todo.id === payload.todo!.id ? payload.todo! : todo),
        } : current);
        setNotice(payload.undoToken ? "Task updated. You can undo the change from the task list." : "Task updated.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That action could not be completed.");
    } finally {
      setBusy(false);
    }
  }

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

  const counts = useMemo(() => {
    const todos = data?.todos ?? [];
    return {
      open: todos.filter((todo) => todo.status === "open" && !activelySnoozed(todo, now)).length,
      snoozed: todos.filter((todo) => activelySnoozed(todo, now)).length,
      done: todos.filter((todo) => todo.status === "completed").length,
      all: todos.length,
    };
  }, [data?.todos, now]);

  const visibleTodos = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return (data?.todos ?? []).filter((todo) => {
      const inView = view === "all"
        || (view === "open" && todo.status === "open" && !activelySnoozed(todo, now))
        || (view === "snoozed" && activelySnoozed(todo, now))
        || (view === "done" && todo.status === "completed");
      const matches = !normalizedSearch || `${todo.title}\n${todo.notes}\n${todo.project ?? ""}\n${todo.context ?? ""}`.toLowerCase().includes(normalizedSearch);
      return inView && matches;
    });
  }, [data?.todos, now, search, view]);

  const groupedTodos = useMemo(() => {
    const groups = new Map<string, Todo[]>();
    for (const todo of visibleTodos) {
      const key = todo.project?.trim() || "Independent";
      groups.set(key, [...(groups.get(key) ?? []), todo]);
    }
    return [...groups.entries()].sort(([a], [b]) => {
      if (a === "Independent") return -1;
      if (b === "Independent") return 1;
      return a.localeCompare(b);
    });
  }, [visibleTodos]);

  if (loading) {
    return <><SiteHeader current="assistant" /><main className="grid min-h-[calc(100vh-3.5rem)] place-items-center text-sm text-[#768079]">Opening your task workspace…</main></>;
  }

  return (
    <div
      className="min-h-screen bg-[#f6f7f5]"
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes("Files") && selectedId) {
          event.preventDefault();
          setDragging(true);
        }
      }}
      onDragOver={(event) => { if (selectedId) event.preventDefault(); }}
      onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }}
      onDrop={drop}
    >
      <SiteHeader current="assistant" />
      <main className="mx-auto h-[calc(100dvh-3.5rem)] max-w-7xl p-0 sm:p-4">
        <div className="grid h-full grid-cols-1 overflow-hidden border-black/[0.07] bg-white sm:rounded-3xl sm:border sm:shadow-[0_18px_60px_rgba(31,45,37,0.08)] lg:grid-cols-[340px_minmax(0,1fr)]">
          <aside className={`${mobileConversation ? "hidden lg:flex" : "flex"} min-h-0 min-w-0 flex-col border-r border-black/[0.07] bg-[#fbfcfa]`}>
            <div className="border-b border-black/[0.06] p-4">
              <div className="mb-3 flex items-center gap-2">
                <span className="grid h-9 w-9 place-items-center rounded-xl bg-[#eaf3ed] text-[#216e4e]"><ActionIcon name="assistant" className="h-5 w-5" /></span>
                <div>
                  <h1 className="text-sm font-semibold">Task Assistant</h1>
                  <p className="text-xs text-[#7b837e]">One task, one useful question</p>
                </div>
              </div>
              <label className="flex h-11 items-center gap-2 rounded-xl border border-black/[0.08] bg-white px-3 shadow-sm focus-within:border-[#7fb49b] focus-within:ring-2 focus-within:ring-[#dcece2]">
                <ActionIcon name="search" className="h-4 w-4 text-[#8a928d]" />
                <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search tasks" className="min-w-0 flex-1 border-0 bg-transparent text-sm outline-none" />
              </label>
              <div className="mt-3 grid grid-cols-4 rounded-xl bg-[#eef0ed] p-1">
                {VIEW_LABELS.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => void changeView(item.value)}
                    className={`rounded-lg px-1 py-2 text-xs font-semibold transition ${view === item.value ? "bg-white text-[#216e4e] shadow-sm" : "text-[#6f7772] hover:text-[#2f3531]"}`}
                  >
                    {item.label}<span className="ml-1 text-[10px] opacity-70">{counts[item.value]}</span>
                  </button>
                ))}
              </div>
            </div>
            <nav className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-2" aria-label="Tasks">
              {groupedTodos.length ? groupedTodos.map(([project, todos]) => (
                <section key={project} className="mb-3">
                  <div className="flex items-center gap-2 px-2 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8a928d]">
                    <ActionIcon name={project === "Independent" ? "view-open" : "folder"} className="h-3.5 w-3.5" />
                    <span className="truncate">{project}</span>
                    <span className="ml-auto">{todos.length}</span>
                  </div>
                  <div className="space-y-1">
                    {todos.map((todo) => (
                      <button
                        key={todo.id}
                        type="button"
                        onClick={() => void selectTask(todo.id)}
                        aria-current={todo.id === selectedId ? "true" : undefined}
                        className={`w-full rounded-xl border px-3 py-2.5 text-left transition ${todo.id === selectedId ? "border-[#b9d7c4] bg-[#eaf3ed] shadow-sm" : "border-transparent hover:border-black/[0.05] hover:bg-white"}`}
                      >
                        <div className="flex items-start gap-2">
                          <span className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${todo.status === "completed" ? "bg-[#a8afab]" : activelySnoozed(todo, now) ? "bg-[#c98231]" : "bg-[#27815b]"}`} />
                          <div className="min-w-0 flex-1">
                            <p className={`truncate text-sm font-medium ${todo.status === "completed" ? "text-[#777f7a] line-through" : "text-[#252a27]"}`}>{todo.title}</p>
                            <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-[#7b837e]">
                              <span className="truncate">{relativeStatus(todo, now)}</span>
                              {todo.attachmentCount > 0 && <span className="inline-flex shrink-0 items-center gap-0.5"><ActionIcon name="attachment" className="h-3 w-3" />{todo.attachmentCount}</span>}
                              {todo.pinned && <ActionIcon name="pin" className="h-3 w-3 shrink-0 text-[#216e4e]" />}
                            </div>
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                </section>
              )) : <p className="px-3 py-10 text-center text-sm text-[#8a928d]">No tasks match this view.</p>}
            </nav>
          </aside>

          <section className={`${mobileConversation ? "flex" : "hidden lg:flex"} min-h-0 min-w-0 flex-col`}>
            {selectedTodo && thread ? (
              <>
                <header className="flex min-h-16 items-center gap-3 border-b border-black/[0.07] px-4 py-3 sm:px-6">
                  <button type="button" onClick={() => setMobileConversation(false)} className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-[#59615c] hover:bg-[#f1f2f0] lg:hidden" aria-label="Back to tasks"><ActionIcon name="previous" className="h-5 w-5" /></button>
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate text-base font-semibold">{selectedTodo.title}</h2>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-[#7b837e]">
                      <span>{relativeStatus(selectedTodo, now)}</span>
                      {selectedTodo.project && <><span>·</span><span>{selectedTodo.project}</span></>}
                      {selectedTodo.attachmentCount > 0 && <><span>·</span><span>{selectedTodo.attachmentCount} attachment{selectedTodo.attachmentCount === 1 ? "" : "s"}</span></>}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void assistantAction(thread.paused ? "resume" : "pause")}
                    className={`inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl px-3 text-xs font-semibold transition ${thread.paused ? "bg-[#eaf3ed] text-[#216e4e]" : "bg-[#f1f2f0] text-[#59615c] hover:bg-[#e8eae7]"}`}
                  >
                    <ActionIcon name={thread.paused ? "assistant" : "stop"} className="h-3.5 w-3.5" />
                    {thread.paused ? "Resume" : "Pause"}
                  </button>
                </header>

                <div ref={messagesRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-8">
                  <div className="mx-auto max-w-3xl space-y-5">
                    {!thread.messages.length && (
                      <div className="rounded-2xl border border-[#d8e8dd] bg-[#f2f8f4] p-5">
                        <div className="mb-3 flex items-center gap-2 text-[#216e4e]"><ActionIcon name="assistant" /><h3 className="font-semibold">Ready when you are</h3></div>
                        <p className="text-sm leading-6 text-[#59615c]">Ask me to clarify this task, review an attachment, research a decision, prepare a draft, or identify the next useful action. I’ll ask one focused question at a time and confirm before changing the task.</p>
                      </div>
                    )}
                    {thread.messages.map((message) => (
                      <article key={message.id} className={message.role === "user" ? "ml-auto max-w-[88%]" : "max-w-[94%]"}>
                        <div className={`rounded-2xl px-4 py-3 text-sm leading-6 ${message.role === "user" ? "rounded-br-md bg-[#216e4e] text-white" : "rounded-bl-md border border-black/[0.07] bg-[#f8f9f7] text-[#303632]"}`}>
                          <p className="whitespace-pre-wrap">{message.content || (message.attachmentIds.length ? "Shared attachments" : "")}</p>
                          {message.kind === "offline" && <p className="mt-1 text-[11px] text-white/70">Waiting to sync</p>}
                        </div>
                        {message.sources.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {message.sources.map((source) => <a key={source.url} href={source.url} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 rounded-lg bg-[#eef0ed] px-2 py-1 text-[11px] text-[#4f5752] hover:text-[#216e4e]"><ActionIcon name="link" className="h-3 w-3" /><span className="truncate">{source.title}</span></a>)}
                          </div>
                        )}
                        {message.question && (
                          <div className="mt-3 rounded-2xl border border-[#cfe2d5] bg-white p-4 shadow-sm">
                            <p className="text-sm font-semibold leading-6 text-[#252a27]">{message.question.prompt}</p>
                            {message.question.options.length > 0 && (
                              <div className="mt-3 flex flex-wrap gap-2">
                                {message.question.options.map((option) => (
                                  <button key={option} type="button" disabled={busy || thread.currentQuestion?.key !== message.question?.key} onClick={() => void sendMessage(option)} className="rounded-xl border border-[#b9d7c4] bg-[#f2f8f4] px-3 py-2 text-xs font-semibold text-[#216e4e] transition hover:bg-[#e4f1e8] disabled:opacity-45">{option}</button>
                                ))}
                                <button type="button" onClick={() => composerRef.current?.focus()} className="rounded-xl border border-black/[0.08] px-3 py-2 text-xs font-semibold text-[#59615c] hover:bg-[#f5f6f4]">Custom</button>
                              </div>
                            )}
                            <div className="mt-3 flex items-center justify-end border-t border-black/[0.06] pt-3">
                              <button type="button" disabled={busy || thread.currentQuestion?.key !== message.question.key} onClick={() => void assistantAction("skip")} className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#7b837e] hover:text-[#216e4e] disabled:opacity-50">Skip · next question<ActionIcon name="next" className="h-3.5 w-3.5" /></button>
                            </div>
                          </div>
                        )}
                        {message.proposal && (
                          <div className="mt-3 rounded-2xl border border-[#d7dfda] bg-white p-4 shadow-sm">
                            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#7b837e]">Proposed task update</p>
                            <p className="mt-1.5 text-sm leading-6 text-[#303632]">{message.proposal.summary}</p>
                            <div className="mt-3 flex flex-wrap gap-2">
                              <button type="button" disabled={busy} onClick={() => void assistantAction("apply", message.id)} className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-[#216e4e] px-3 text-xs font-semibold text-white disabled:opacity-50"><ActionIcon name="done" className="h-3.5 w-3.5" />Apply to task</button>
                              <button type="button" disabled={busy} onClick={() => void assistantAction("dismiss", message.id)} className="h-9 rounded-xl bg-[#f1f2f0] px-3 text-xs font-semibold text-[#59615c] disabled:opacity-50">Keep task as is</button>
                            </div>
                          </div>
                        )}
                      </article>
                    ))}
                    {busy && (
                      <div className="flex items-center gap-2 text-sm text-[#7b837e]">
                        <span className="flex gap-1"><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#6e9e82]" /><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#6e9e82] [animation-delay:120ms]" /><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#6e9e82] [animation-delay:240ms]" /></span>
                        Thinking about the next useful step…
                      </div>
                    )}
                  </div>
                </div>

                <div className="border-t border-black/[0.07] bg-white px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:px-6 sm:pb-4">
                  <div className="mx-auto max-w-3xl">
                    {(attachments.length > 0 || stagedFiles.length > 0) && (
                      <div className="mb-2 flex gap-2 overflow-x-auto pb-1">
                        {attachments.map((attachment) => {
                          const selected = selectedAttachmentIds.includes(attachment.id);
                          return (
                            <button
                              key={attachment.id}
                              type="button"
                              onClick={() => setSelectedAttachmentIds((ids) => selected ? ids.filter((id) => id !== attachment.id) : [...ids, attachment.id])}
                              className={`inline-flex h-9 max-w-52 shrink-0 items-center gap-1.5 rounded-xl border px-2.5 text-xs font-medium ${selected ? "border-[#7fb49b] bg-[#eaf3ed] text-[#216e4e]" : "border-black/[0.08] bg-white text-[#6a726d]"}`}
                              title={selected ? "Included in the next question" : "Include in the next question"}
                            >
                              <ActionIcon name={attachment.kind === "image" ? "image" : attachment.kind === "audio" ? "mic" : attachment.kind === "video" ? "camera" : "file"} className="h-3.5 w-3.5" />
                              <span className="truncate">{attachment.fileName}</span>
                            </button>
                          );
                        })}
                        {stagedFiles.map((staged) => (
                          <div key={staged.localId} className={`inline-flex h-9 max-w-56 shrink-0 items-center gap-1.5 rounded-xl border px-2.5 text-xs ${staged.status === "failed" ? "border-red-200 bg-red-50 text-red-700" : "border-[#d7dfda] bg-[#f5f7f5] text-[#6a726d]"}`}>
                            <ActionIcon name={staged.status === "uploading" ? "retry" : staged.kind === "image" ? "image" : staged.kind === "audio" ? "mic" : "file"} className={`h-3.5 w-3.5 ${staged.status === "uploading" ? "animate-spin" : ""}`} />
                            <span className="truncate">{staged.file.name}</span>
                            {staged.status === "failed" && navigator.onLine && <button type="button" onClick={() => void uploadFile(selectedTodo.id, staged)} className="font-semibold underline">Retry</button>}
                            <button type="button" onClick={() => setStagedFiles((files) => files.filter((file) => file.localId !== staged.localId))} aria-label={`Remove ${staged.file.name}`}><ActionIcon name="close" className="h-3 w-3" /></button>
                          </div>
                        ))}
                      </div>
                    )}
                    {error && <p role="alert" className="mb-2 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
                    {notice && <p className="mb-2 rounded-xl bg-[#f1f4f1] px-3 py-2 text-xs text-[#59615c]">{notice}</p>}
                    {thread.paused ? (
                      <button type="button" onClick={() => void assistantAction("resume")} className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-[#eaf3ed] text-sm font-semibold text-[#216e4e]"><ActionIcon name="assistant" />Resume guidance for this task</button>
                    ) : (
                      <div className="flex items-end gap-1 rounded-2xl border border-black/[0.09] bg-[#fbfcfa] p-2 shadow-sm focus-within:border-[#7fb49b] focus-within:ring-2 focus-within:ring-[#dcece2]">
                        <AttachmentMenu disabled={busy} onFiles={addFiles} onRecord={() => setRecording(true)} />
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
                          placeholder="Ask about this task…"
                          className="max-h-36 min-h-10 min-w-0 flex-1 resize-none bg-transparent px-2 py-2.5 text-sm leading-5 outline-none"
                        />
                        <button
                          type="button"
                          onClick={() => void sendMessage()}
                          disabled={busy || (!draft.trim() && !selectedAttachmentIds.length && !stagedFiles.length)}
                          className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#216e4e] text-white transition hover:bg-[#195c40] disabled:bg-[#b8c9be]"
                          aria-label="Send to assistant"
                        >
                          <ActionIcon name="next" className="h-5 w-5" />
                        </button>
                      </div>
                    )}
                    <p className="mt-2 text-center text-[10px] text-[#929994]">AI can make mistakes. Task edits always require your confirmation.</p>
                  </div>
                </div>
              </>
            ) : (
              <div className="grid min-h-0 flex-1 place-items-center p-8 text-center">
                <div>
                  <span className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-[#eaf3ed] text-[#216e4e]"><ActionIcon name="assistant" className="h-7 w-7" /></span>
                  <h2 className="font-semibold">Choose a task</h2>
                  <p className="mt-2 max-w-sm text-sm leading-6 text-[#7b837e]">Select a task to continue its assistant conversation and accumulated understanding.</p>
                </div>
              </div>
            )}
          </section>
        </div>
      </main>
      {dragging && selectedId && (
        <div className="pointer-events-none fixed inset-3 z-[80] grid place-items-center rounded-3xl border-2 border-dashed border-[#4a9870] bg-[#eaf3ed]/90 backdrop-blur-sm">
          <div className="text-center text-[#216e4e]"><ActionIcon name="attachment" className="mx-auto mb-3 h-9 w-9" /><p className="font-semibold">Attach to {selectedTodo?.title}</p><p className="mt-1 text-sm">Drop photos, videos, voice memos, or files</p></div>
        </div>
      )}
      {recording && <VoiceRecorder onClose={() => setRecording(false)} onRecorded={(file, durationMs) => { setRecording(false); addFiles([file], durationMs); }} />}
    </div>
  );
}
