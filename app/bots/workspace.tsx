"use client";

import {
  type ClipboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Bot as BotIcon,
  Plus,
  Search,
  ArrowLeft,
  MoreHorizontal,
  ArrowUp,
  ArrowDown,
  Paperclip,
  X,
  Square,
  Clock,
  Archive,
  RotateCcw,
  Play,
  Pause,
  Trash2,
  Pencil,
  LoaderCircle,
  RefreshCw,
  BarChart3,
  History,
  ListPlus,
  Save,
} from "lucide-react";
import { SiteHeader } from "../site-header";
import type {
  Bot,
  BotEvent,
  BotSchedule,
  BotQueuedSubmission,
} from "../../lib/bots-types";
import {
  zonedDateTimeInputValue,
  zonedLocalDateTimeToUtc,
} from "../../lib/zoned-date-time";
import { botsClient as client } from "./client";
import type { NativeEvent } from "./thread-state";
import { BotConversation } from "./timeline";
import { BotSidebarList } from "./sidebar-list";
import { RequestCard } from "./request-card";
import { RunHistory } from "./run-history";
import { UsagePanel } from "./usage-panel";
import { useBotComposer } from "./use-composer";
import { ComposerAttachments, ComposerStatus } from "./composer-state";
import { ComposerInput } from "./composer-input";
import { ComposerSettings } from "./composer-settings";
import { ArtifactGallery, BotAttachmentsEntry, ArtifactNav } from "./artifact-gallery";
import { UploadThumbnail } from "./upload-thumbnail";
import "./bots.css";
import "./chat-design.css";

const EMPTY_BOTS: Bot[] = [];
const EMPTY_QUEUE: BotQueuedSubmission[] = [];

function initials(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0])
    .join("")
    .toUpperCase();
}
function Avatar({ bot, small = false }: { bot: Bot; small?: boolean }) {
  return (
    <span
      className={`bots-avatar ${small ? "small" : ""}`}
      style={{ background: bot.color }}
    >
      {initials(bot.name)}
    </span>
  );
}
function humanStatus(bot: Bot, online: boolean) {
  if (!online) return "Offline";
  if (bot.archived) return "Archived";
  if (!bot.activeTurnId && bot.workerTasks?.active)
    return `${bot.workerTasks.active} worker task${bot.workerTasks.active === 1 ? "" : "s"} in progress`;
  if (!bot.activeTurnId && bot.workerTasks?.waiting)
    return "Worker needs attention";
  return (
    (
      {
        idle: "Ready",
        running: "Working",
        waiting: "Needs your input",
        provisioning: "Setting up",
        error: "Needs attention",
        interrupted: "Interrupted",
      } as Record<string, string>
    )[bot.status] ?? bot.status
  );
}
function stamp(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function BotsWorkspace() {
  const [, redraw] = useState(0),
    [selected, setSelected] = useState<string | null>(null),
    [search, setSearch] = useState(""),
    [archived, setArchived] = useState(false),
    [creating, setCreating] = useState(false),
    [profile, setProfile] = useState(false),
    [gallery, setGallery] = useState<"artifacts" | "attachments" | null>(null),
    [showRunHistory, setShowRunHistory] = useState(false),
    [showOverallUsage, setShowOverallUsage] = useState(false),
    [editingSchedule, setEditingSchedule] = useState<
      BotSchedule | "new" | null
    >(null);
  const [loadedQueue, setPromptQueue] = useState<BotQueuedSubmission[]>([]),
    [queueScope, setQueueScope] = useState(""),
    [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const selectedRef = useRef(selected), screenRef = useRef<HTMLDivElement>(null),
    fileRef = useRef<HTMLInputElement>(null), searchRef = useRef<HTMLInputElement>(null),
    queueRequest = useRef(0), createOperation = useRef(crypto.randomUUID());
  useLayoutEffect(() => { selectedRef.current = selected; }, [selected]);
  const owner = client.owner;
  const scope = JSON.stringify([owner, selected]);
  const promptQueue = queueScope === scope ? loadedQueue : EMPTY_QUEUE;
  const { composer, error: composerError } = useBotComposer(client.owner, selected);
  const draft = composer?.draft.text ?? "";
  const uploads = composer?.draft.files ?? [];
  const editingQueueId = composer?.draft.queueId ?? null;
  const sending = Boolean(composer?.operation);
  const canSend = Boolean(composer?.ready && !composer.storageError && !sending &&
    uploads.every((file) => file.remote?.ready));
  const setDraft = (text: string) => composer?.setText(text);
  const snapshot = client.snapshot,
    online = client.online,
    bots = snapshot?.bots ?? EMPTY_BOTS,
    bot = bots.find((b) => b.id === selected),
    pending = snapshot?.pending.filter((p) => p.botId === selected) ?? [];
  useLayoutEffect(() => {
    const screen = screenRef.current;
    if (!screen) return;
    const root = document.documentElement;
    const viewport = window.visualViewport;
    // Activity tears down this effect when another tab becomes visible.
    root.classList.add("bots-viewport-locked");
    let frame = 0;
    let delayed = 0;
    const resize = () => {
      const active = document.activeElement;
      const editing = active instanceof HTMLElement &&
        screen.contains(active) &&
        active.getClientRects().length > 0 &&
        (active.matches("input, textarea, select") || active.isContentEditable);
      const layoutHeight = Math.max(window.innerHeight, root.clientHeight);
      // The visual viewport can retain its keyboard height after iOS dismisses
      // the keyboard. Only let it override 100dvh while an editor is focused.
      const keyboardOpen = editing && viewport &&
        viewport.height < layoutHeight - 120;
      screen.classList.toggle("bots-keyboard-open", Boolean(keyboardOpen));
      if (keyboardOpen) {
        screen.style.setProperty("--bots-keyboard-height", `${viewport.height}px`);
        screen.style.setProperty("--bots-keyboard-top", `${viewport.offsetTop}px`);
      } else {
        screen.style.removeProperty("--bots-keyboard-height");
        screen.style.removeProperty("--bots-keyboard-top");
      }
    };
    const scheduleResize = () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(delayed);
      frame = window.requestAnimationFrame(resize);
      // Safari sometimes fires resize before visualViewport has its final size.
      delayed = window.setTimeout(resize, 250);
    };
    resize();
    viewport?.addEventListener("resize", scheduleResize);
    viewport?.addEventListener("scroll", scheduleResize);
    window.addEventListener("resize", scheduleResize);
    window.addEventListener("orientationchange", scheduleResize);
    window.addEventListener("pageshow", scheduleResize);
    document.addEventListener("visibilitychange", scheduleResize);
    document.addEventListener("focusin", scheduleResize);
    document.addEventListener("focusout", scheduleResize);
    window.addEventListener("dawar-before-navigation", scheduleResize);
    return () => {
      root.classList.remove("bots-viewport-locked");
      viewport?.removeEventListener("resize", scheduleResize);
      viewport?.removeEventListener("scroll", scheduleResize);
      window.removeEventListener("resize", scheduleResize);
      window.removeEventListener("orientationchange", scheduleResize);
      window.removeEventListener("pageshow", scheduleResize);
      document.removeEventListener("visibilitychange", scheduleResize);
      document.removeEventListener("focusin", scheduleResize);
      document.removeEventListener("focusout", scheduleResize);
      window.removeEventListener("dawar-before-navigation", scheduleResize);
      window.cancelAnimationFrame(frame);
      window.clearTimeout(delayed);
      screen.classList.remove("bots-keyboard-open");
      screen.style.removeProperty("--bots-keyboard-height");
      screen.style.removeProperty("--bots-keyboard-top");
    };
  }, [selected]);
  useEffect(() => {
    if (!creating && !editingSchedule && !showRunHistory && !showOverallUsage) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const focusable = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href]",
        ) ?? [],
      );
    focusable()[0]?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setCreating(false);
        setEditingSchedule(null);
        setShowRunHistory(false);
        setShowOverallUsage(false);
      }
      if (event.key !== "Tab") return;
      const items = focusable(),
        first = items[0],
        last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      previous?.focus();
    };
  }, [creating, editingSchedule, showRunHistory, showOverallUsage]);
  useEffect(() => {
    const unsubscribe = client.subscribe(() => redraw((v) => v + 1));
    client.start();
    const pop = () => {
      const params = new URLSearchParams(window.location.search), id = params.get("bot"), view = params.get("view");
      setGallery(view === "artifacts" || view === "attachments" && id ? view : null);
      selectedRef.current = id;
      setSelected(id);
    };
    queueMicrotask(pop);
    window.addEventListener("popstate", pop);
    window.addEventListener("dawar-shell-popstate", pop);
    return () => {
      unsubscribe();
      window.removeEventListener("popstate", pop);
      window.removeEventListener("dawar-shell-popstate", pop);
    };
  }, []);
  const loadQueue = useCallback(async (id: string) => {
    const owner = client.owner;
    const request = ++queueRequest.current;
    if (!client.online) return;
    try {
      const queue = await client.rpc<BotQueuedSubmission[]>("queue.list", id);
      if (selectedRef.current === id && client.owner === owner && queueRequest.current === request) {
        setPromptQueue(queue);
        client.save(`queue:${id}`, queue);
      }
    } catch (e) {
      if (selectedRef.current === id && client.owner === owner && queueRequest.current === request)
        setError(e instanceof Error ? e.message : "Queue could not load.");
    }
  }, []);
  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      if (selected) {
        setQueueScope(JSON.stringify([client.owner, selected]));
        setPromptQueue(client.cache<BotQueuedSubmission[]>(`queue:${selected}`, []));
        void loadQueue(selected);
      }
      else {
        setPromptQueue([]);
      }
      setProfile(false);
      setError("");
    });
    return () => { active = false; };
  }, [selected, online, owner, loadQueue]);
  useEffect(() => {
    const listener = (event: BotEvent) => {
      if (event.botId !== selectedRef.current) return;
      if ((event.type === "queue" ||
          (event.type === "codex" &&
           (event.data as NativeEvent).method === "thread/queue/changed")) &&
          selectedRef.current)
        void loadQueue(selectedRef.current);
    };
    client.events.add(listener);
    return () => {
      client.events.delete(listener);
    };
  }, [loadQueue]);
  useEffect(() => {
    if (
      !selected ||
      !online ||
      !bot ||
      bot.lastReadAt >= bot.updatedAt ||
      document.visibilityState !== "visible"
    )
      return;
    const timer = setTimeout(
      () => void client.rpc("bots.read", selected).catch(() => {}),
      800,
    );
    return () => clearTimeout(timer);
  }, [selected, online, bot]);
  const select = useCallback((id: string | null) => {
    selectedRef.current = id;
    setSelected(id); setGallery(null);
    const url = new URL(window.location.href);
    url.searchParams.delete("view");
    if (id) url.searchParams.set("bot", id);
    else url.searchParams.delete("bot");
    window.history.pushState({}, "", url);
  }, []);
  function openGallery(view: "artifacts" | "attachments") {
    const url = new URL(window.location.href); url.searchParams.set("view", view);
    if (view === "artifacts") { url.searchParams.delete("bot"); setSelected(null); selectedRef.current = null; }
    setGallery(view); window.history.pushState({}, "", url);
  }
  function closeGallery() {
    const url = new URL(window.location.href); url.searchParams.delete("view"); window.history.pushState({}, "", url);
    if (gallery === "attachments") setProfile(true); setGallery(null);
  }
  async function action(fn: () => Promise<unknown>) {
    setError("");
    setBusy(true);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed.");
    } finally {
      setBusy(false);
    }
  }
  async function download(id: string) {
    if (!selected) return;
    await action(async () => {
      const { blob, name } = await client.download(selected, id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    });
  }
  async function send(queueNext = false) {
    if (!composer || !bot || !canSend) return;
    const id = bot.id;
    await composer.send(queueNext);
    if (queueNext || editingQueueId) await loadQueue(id);
  }
  function editQueued(item: BotQueuedSubmission) { composer?.edit(item); }
  function cancelQueueEdit() { composer?.select("normal"); }
  async function changeQueue(fn: () => Promise<unknown>) {
    if (!bot) return;
    await action(async () => {
      try {
        await fn();
      } finally {
        await loadQueue(bot.id);
      }
    });
  }
  function upload(files: FileList | File[] | null) {
    if (files && composer?.ready) composer.addFiles(Array.from(files));
    if (fileRef.current) fileRef.current.value = "";
  }
  function pasteImages(event: ClipboardEvent<HTMLTextAreaElement>) {
    const fromItems = [...event.clipboardData.items]
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item, index) => {
        const file = item.getAsFile();
        if (!file) return null;
        const extension =
          item.type === "image/jpeg"
            ? "jpg"
            : item.type.split("/")[1].split("+")[0];
        const name = /\.[a-z0-9]+$/i.test(file.name)
          ? file.name
          : `pasted-image-${index + 1}.${extension}`;
        return file.name === name && file.type === item.type
          ? file
          : new File([file], name, { type: item.type });
      })
      .filter((file): file is File => Boolean(file));
    const images = fromItems.length
      ? fromItems
      : [...event.clipboardData.files].filter((file) =>
          file.type.startsWith("image/"),
        );
    if (!images.length) return;
    void upload(images);
  }
  const filtered = useMemo(() => bots.filter((b) => b.archived === archived &&
    `${b.name} ${b.purpose}`.toLowerCase().includes(search.toLowerCase())), [bots, archived, search]);
  const schedules = snapshot?.schedules.filter((s) => s.botId === selected) ?? [];
  return (
    <div className="bots-screen" ref={screenRef} data-no-pull-refresh>
      <SiteHeader current="bots" />
      <main className={`bots-layout ${selected || gallery ? "has-selection" : ""}`}>
        <aside className="bots-sidebar">
          <div className="bots-sidebar-heading">
            <h1>Bots</h1>
            <div className="bots-sidebar-tools">
            <button className="bots-icon-button" title="Codex account usage" aria-label="Codex account usage" onClick={() => setShowOverallUsage(true)}><BarChart3 size={19} /></button>
            <button
              className="bots-icon-button"
              aria-label="Create bot"
              onClick={() => {
                createOperation.current = crypto.randomUUID();
                setCreating(true);
              }}
            >
              <Plus size={21} />
            </button>
            </div>
          </div>
          <ArtifactNav active={gallery === "artifacts"} onOpen={() => openGallery("artifacts")} />
          <div className="bots-search">
            <Search size={17} aria-hidden="true" />
            <input
              ref={searchRef}
              aria-label="Search bots"
              placeholder="Search bots"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button
                type="button"
                aria-label="Clear bot search"
                onClick={() => {
                  setSearch("");
                  searchRef.current?.focus();
                }}
              >
                <X size={16} aria-hidden="true" />
              </button>
            )}
          </div>
          <div className="bots-sidebar-filter">
            <button
              className={!archived ? "active" : ""}
              onClick={() => setArchived(false)}
            >
              All bots
            </button>
            <button
              className={archived ? "active" : ""}
              onClick={() => setArchived(true)}
            >
              Archived
            </button>
          </div>
          <BotSidebarList bots={filtered} snapshot={snapshot} selected={selected} select={select}
            empty={search ? "No matching bots." : archived ? "No archived bots." : "Your bots will appear here."} />
          <div className="bots-machine">
            <span className={`bots-status-dot ${online ? "online" : ""}`} />
            <span>
              {online
                ? "Connected"
                : client.error
                  ? client.error
                  : "Connecting…"}
            </span>
            <button
              className="bots-icon-button"
              aria-label="Reconnect"
              onClick={() => {
                client.stopped = false;
                client.socket?.close();
                if (!client.socket) void client.connect();
              }}
            >
              <RefreshCw size={14} />
            </button>
          </div>
        </aside>
        {gallery ? <ArtifactGallery key={`${owner}:${gallery}:${gallery === "attachments" ? bot?.id : "all"}`} owner={owner} online={online} bots={bots} bot={gallery === "attachments" ? bot : undefined} onClose={closeGallery} /> : <section className="bots-conversation">
          <header className="bots-conversation-heading">
            <button
              className="bots-icon-button bots-back"
              aria-label="Back to bots"
              onClick={() => select(null)}
            >
              <ArrowLeft size={20} />
            </button>
            {bot ? (
              <>
                <Avatar bot={bot} small />
                <div className="bots-header-title">
                  <strong>{bot.name}</strong>
                  <small>{humanStatus(bot, online)}</small>
                </div>
                <button
                  className="bots-icon-button"
                  aria-label="Bot details and schedules"
                  onClick={() => setProfile((v) => !v)}
                >
                  <MoreHorizontal size={22} />
                </button>
              </>
            ) : (
              <span>Your bots</span>
            )}
          </header>
          {(error || client.error) && (
            <div className="bots-banner" role="alert">
              <span>{error || client.error}</span>
              <button
                aria-label="Dismiss error"
                onClick={() => {
                  setError("");
                  client.error = "";
                  client.notify();
                }}
              >
                <X size={15} />
              </button>
            </div>
          )}
          {bot?.error && (
            <div className="bots-banner">
              <span>{bot.error}</span>
              {!bot.threadId && (
                <button
                  disabled={!online || busy}
                  onClick={() =>
                    void action(() => client.rpc("bots.recover", bot.id))
                  }
                >
                  Retry setup
                </button>
              )}
            </div>
          )}
          {!bot ? (
            <div className="bots-empty">
              <div className="bots-empty-icon">
                <BotIcon size={34} strokeWidth={1.4} />
              </div>
              <h2>A conversation that keeps going.</h2>
              <p>Give a bot a name, a purpose, and something to do.</p>
              <button
                className="bots-primary"
                onClick={() => {
                  createOperation.current = crypto.randomUUID();
                  setCreating(true);
                }}
              >
                <Plus size={17} />
                Create a bot
              </button>
            </div>
          ) : (
            <>
              <BotConversation key={scope} owner={owner} bot={bot} online={online}>
                {pending.map((request) => (
                  <RequestCard
                    key={request.key}
                    pending={request}
                    disabled={!online}
                    respond={(result) =>
                      client.rpc("requests.respond", bot.id, {
                        key: request.key,
                        result,
                      })
                    }
                  />
                ))}
                {(bot.status === "running" ||
                  Boolean(bot.workerTasks?.active)) && (
                  <div className="bots-working">
                    <span />
                    <span />
                    <span />
                    <small>
                      {bot.workerTasks?.active
                        ? humanStatus(bot, online)
                        : `${bot.name} is working`}
                    </small>
                  </div>
                )}
              </BotConversation>
              {!bot.archived && (
                <>
                  <div className="bots-composer-support">
                    {snapshot && <ComposerSettings key={scope} bot={bot} snapshot={snapshot} online={online} />}
                    {promptQueue.length > 0 && (
                    <div className="bots-prompt-queue" role="region" aria-label="Queued prompts">
                      <strong>Queued next</strong>
                      {bot.queuePaused && (
                        <div className="bots-queue-paused">
                          Queue paused.
                          <button type="button" disabled={!online || busy}
                            onClick={() => void changeQueue(() => client.rpc("queue.resume", bot.id))}>
                            Resume queue
                          </button>
                        </div>
                      )}
                      {promptQueue.map((item, index) => (
                        <div className="bots-prompt-queue-item" key={item.id}>
                          <span className="bots-queue-number">{index + 1}</span>
                          <div className="bots-queue-content">
                            <span>{item.input.flatMap((input) =>
                              input.type === "text" && !input.text.startsWith("Attached file: ")
                                ? [input.text] : []).join("\n") || "Attachments"}</span>
                            {item.attachments.length > 0 && (
                              <div className="bots-queue-attachments">
                                {item.attachments.map((a) => (
                                  <span key={a.id} title={a.name}>
                                    {a.mimeType.startsWith("image/") && (
                                      <UploadThumbnail botId={bot.id} attachmentId={a.id} online={online} />
                                    )}
                                    {a.name}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                          <div className="bots-queue-actions">
                            <button type="button" aria-label={`Edit queued prompt ${index + 1}`}
                              disabled={!composer?.ready || sending} onClick={() => editQueued(item)}><Pencil size={15} /></button>
                            <button type="button" aria-label={`Move queued prompt ${index + 1} up`}
                              disabled={!online || busy || index === 0}
                              onClick={() => void changeQueue(() => client.rpc("queue.reorder", bot.id, {
                                ids: promptQueue.map((x) => x.id).toSpliced(index - 1, 2, item.id, promptQueue[index - 1].id),
                              }))}><ArrowUp size={15} /></button>
                            <button type="button" aria-label={`Move queued prompt ${index + 1} down`}
                              disabled={!online || busy || index === promptQueue.length - 1}
                              onClick={() => void changeQueue(() => client.rpc("queue.reorder", bot.id, {
                                ids: promptQueue.map((x) => x.id).toSpliced(index, 2, promptQueue[index + 1].id, item.id),
                              }))}><ArrowDown size={15} /></button>
                            <button type="button" aria-label={`Remove queued prompt ${index + 1}`}
                              disabled={!online || busy}
                              onClick={() => void changeQueue(() => client.rpc("queue.delete", bot.id, { id: item.id }))}>
                              <Trash2 size={15} /></button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  <ComposerStatus composer={composer} error={composerError} />
                  {composer && <ComposerAttachments composer={composer} />}
                  </div>
                  <form
                    className="bots-composer"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void send(Boolean(editingQueueId));
                    }}
                  >
                    <input
                      ref={fileRef}
                      type="file"
                      multiple
                      hidden
                      onChange={(e) => void upload(e.target.files)}
                    />
                    <button
                      type="button"
                      className="bots-icon-button"
                      aria-label="Attach file"
                      disabled={!composer?.ready}
                      onClick={() => fileRef.current?.click()}
                    >
                      <Paperclip size={20} />
                    </button>
                    <ComposerInput
                      key={scope}
                      aria-label={`Message ${bot.name}`}
                      placeholder={online ? "Message…" : "Write a draft…"}
                      value={draft}
                      disabled={!composer?.ready}
                      rows={1}
                      onPaste={pasteImages}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (
                          e.key === "Enter" &&
                          !e.shiftKey &&
                          !e.nativeEvent.isComposing
                        ) {
                          e.preventDefault();
                          void send(Boolean(editingQueueId));
                        }
                      }}
                    />
                    {(bot.activeTurnId || bot.workerTasks?.active ||
                      promptQueue.length > 0 || editingQueueId) && (
                      <>
                      {editingQueueId && (
                        <button type="button" className="bots-queue-button"
                          onClick={cancelQueueEdit}>Cancel edit</button>
                      )}
                      <button type="button" className="bots-icon-button bots-queue-icon"
                        title={editingQueueId ? "Save queue" : "Queue next"}
                        aria-label={editingQueueId ? "Save queue" : "Queue next"}
                        disabled={!online || !canSend ||
                          (!draft.trim() && !uploads.length)}
                        onClick={() => void send(true)}>
                        {editingQueueId ? <Save size={19} aria-hidden="true" /> : <ListPlus size={20} aria-hidden="true" />}
                      </button>
                      </>
                    )}
                    {(bot.activeTurnId || Boolean(bot.workerTasks?.active)) &&
                      Boolean(draft || uploads.length) && (
                        <button
                          type="button"
                          className="bots-icon-button"
                          aria-label="Stop bot"
                          disabled={!online}
                          onClick={() =>
                            void action(() =>
                              client.rpc("turn.interrupt", bot.id),
                            )
                          }
                        >
                          <Square size={14} fill="currentColor" />
                        </button>
                      )}
                    {!editingQueueId && ((bot.activeTurnId || Boolean(bot.workerTasks?.active)) &&
                    !draft &&
                    !uploads.length ? (
                      <button
                        type="button"
                        className="bots-send"
                        aria-label="Stop bot"
                        disabled={!online}
                        onClick={() =>
                          void action(() =>
                            client.rpc("turn.interrupt", bot.id),
                          )
                        }
                      >
                        <Square size={14} fill="currentColor" />
                      </button>
                    ) : (
                      <button
                        className="bots-send"
                        aria-label={
                          bot.activeTurnId ? "Send follow-up" : "Send message"
                        }
                        disabled={
                          !online ||
                          !canSend ||
                          (!draft.trim() && !uploads.length)
                        }
                      >
                        {sending ? (
                          <LoaderCircle className="bots-spin" size={18} />
                        ) : (
                          <ArrowUp size={20} />
                        )}
                      </button>
                    ))}
                  </form>
                </>
              )}
              {bot.archived && (
                <div className="bots-archived-banner">
                  This bot is archived.
                  <button
                    className="bots-primary"
                    disabled={!online || busy}
                    onClick={() =>
                      void action(() => client.rpc("bots.restore", bot.id))
                    }
                  >
                    Restore bot
                  </button>
                </div>
              )}
            </>
          )}
        </section>}
        {profile && bot && !gallery && (
          <aside className="bots-profile">
            <div className="bots-profile-heading">
              <h2>Bot details</h2>
              <button
                className="bots-icon-button"
                aria-label="Close bot details"
                onClick={() => setProfile(false)}
              >
                <X size={19} />
              </button>
            </div>
            <Avatar bot={bot} />
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const input = new FormData(e.currentTarget);
                void action(() =>
                  client.rpc("bots.update", bot.id, {
                    name: String(input.get("name")),
                  }),
                );
              }}
            >
              <label>
                Name
                <input
                  name="name"
                  defaultValue={bot.name}
                  key={bot.id + bot.name}
                  maxLength={80}
                  required
                />
              </label>
              <button type="submit" disabled={!online || busy}>
                Save name
              </button>
            </form>
            <p className="bots-muted">{bot.purpose}</p>
            <p className="bots-profile-hint">
              Ask {bot.name} to change its personality, instructions, or memory.
            </p>
            <BotAttachmentsEntry bot={bot} owner={owner} online={online} onOpen={() => openGallery("attachments")} />
            <h3 className="bots-profile-section-heading">Usage</h3>
            <UsagePanel bot={bot} online={online} />
            <div className="bots-schedule-heading">
              <h3>
                <Clock size={16} />
                Schedules
              </h3>
              <button
                className="bots-icon-button"
                aria-label="Add schedule"
                disabled={!online || bot.archived}
                onClick={() => setEditingSchedule("new")}
              >
                <Plus size={17} />
              </button>
            </div>
            <button className="bots-history-open" onClick={() => setShowRunHistory(true)}><History size={16} /> View schedule history</button>
            {!schedules.length && (
              <p className="bots-muted">
                Ask your bot to schedule something, or add a schedule here.
              </p>
            )}
            {schedules.map((s) => (
              <div className="bots-schedule" key={s.id}>
                <strong>{s.title}</strong>
                <small>
                  {s.enabled && s.nextRunAt
                    ? `Next ${stamp(s.nextRunAt)}`
                    : !s.cron && s.at && new Date(s.at) < new Date()
                      ? "Completed"
                      : "Paused"}{" "}
                  · {s.timeZone}
                </small>
                <div>
                  <button
                    title="Run now"
                    aria-label={`Run ${s.title} now`}
                    disabled={!online || busy || bot.archived}
                    onClick={() =>
                      void action(() =>
                        client.rpc("schedules.run", bot.id, { id: s.id }),
                      )
                    }
                  >
                    <Play size={15} />
                  </button>
                  <button
                    aria-label={`Edit ${s.title}`}
                    disabled={!online}
                    onClick={() => setEditingSchedule(s)}
                  >
                    <Pencil size={15} />
                  </button>
                  <button
                    aria-label={
                      s.enabled ? "Pause schedule" : "Resume schedule"
                    }
                    disabled={!online || busy || bot.archived}
                    onClick={() =>
                      void action(() =>
                        client.rpc("schedules.save", bot.id, {
                          id: s.id,
                          enabled: !s.enabled,
                        }),
                      )
                    }
                  >
                    {s.enabled ? <Pause size={15} /> : <Play size={15} />}
                  </button>
                  <button
                    aria-label={`Delete ${s.title}`}
                    disabled={!online || busy}
                    onClick={() => {
                      if (window.confirm(`Delete “${s.title}”?`))
                        void action(() =>
                          client.rpc("schedules.delete", bot.id, { id: s.id }),
                        );
                    }}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            ))}
            <a className="bots-notification-link" href="/settings">
              Notification settings
            </a>
            <div className="bots-profile-actions">
              <button
                disabled={!online || busy || Boolean(bot.activeTurnId)}
                onClick={() =>
                  void action(() => client.rpc("thread.compact", bot.id))
                }
              >
                <RotateCcw size={16} />
                Compact conversation
              </button>
              <button
                disabled={!online || busy || Boolean(bot.activeTurnId)}
                onClick={() =>
                  void action(() =>
                    client.rpc(
                      bot.archived ? "bots.restore" : "bots.archive",
                      bot.id,
                    ),
                  )
                }
              >
                <Archive size={16} />
                {bot.archived ? "Restore bot" : "Archive bot"}
              </button>
            </div>
          </aside>
        )}
      </main>
      {showRunHistory && bot && <RunHistory bot={bot} schedules={schedules} attachments={[]} online={online} onClose={() => setShowRunHistory(false)} download={(id) => void download(id)} />}
      {showOverallUsage && <div className="bots-modal-backdrop" onClick={() => setShowOverallUsage(false)}><section className="bots-history-modal bots-usage-modal" role="dialog" aria-modal="true" aria-label="Codex account usage" onClick={(event) => event.stopPropagation()}><header><h2>Codex account usage</h2><button className="bots-icon-button" aria-label="Close account usage" onClick={() => setShowOverallUsage(false)}><X size={19} /></button></header><UsagePanel online={online} /></section></div>}
      {creating && (
        <div className="bots-modal-backdrop" onClick={() => setCreating(false)}>
          <form
            className="bots-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Create a bot"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              void action(async () => {
                const created = await client.rpc<Bot>(
                  "bots.create",
                  undefined,
                  {
                    name: String(data.get("name")),
                    purpose: String(data.get("purpose")),
                  },
                  createOperation.current,
                );
                setCreating(false);
                setArchived(false);
                select(created.id);
                await client.refresh();
              });
            }}
          >
            <h2>Create a bot</h2>
            <label>
              Name
              <input
                name="name"
                autoFocus
                placeholder="e.g. Atlas"
                required
                maxLength={80}
              />
            </label>
            <label>
              Purpose <span className="bots-muted">optional</span>
              <textarea
                name="purpose"
                placeholder="What would you like this bot to help with?"
                rows={3}
                maxLength={2000}
              />
            </label>
            {error && <p className="bots-error">{error}</p>}
            <div className="bots-modal-actions">
              <button type="button" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button className="bots-primary" disabled={!online || busy}>
                {busy ? "Creating…" : online ? "Create bot" : "Waiting for VM…"}
              </button>
            </div>
          </form>
        </div>
      )}
      {editingSchedule && bot && (
        <ScheduleEditor
          schedule={editingSchedule}
          timeZone={client.timeZone}
          close={() => setEditingSchedule(null)}
          save={async (value) => {
            await client.rpc("schedules.save", bot.id, value);
            setEditingSchedule(null);
            await client.refresh();
          }}
        />
      )}
    </div>
  );
}

function ScheduleEditor({
  schedule,
  timeZone,
  close,
  save,
}: {
  schedule: BotSchedule | "new";
  timeZone: string;
  close: () => void;
  save: (value: Record<string, unknown>) => Promise<void>;
}) {
  const s = schedule === "new" ? null : schedule;
  const [zone, setZone] = useState(s?.timeZone ?? timeZone),
    [kind, setKind] = useState(s?.cron ? "custom" : "once"),
    [cron, setCron] = useState(s?.cron ?? "0 9 * * *"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <div className="bots-modal-backdrop" onClick={close}>
      <form
        className="bots-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Schedule bot work"
        onClick={(e) => e.stopPropagation()}
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          const data = new FormData(e.currentTarget);
          try {
            await save({
              ...(s ? { id: s.id } : {}),
              title: String(data.get("title")),
              prompt: String(data.get("prompt")),
              timeZone: zone,
              enabled: true,
              cron: kind === "once" ? null : cron,
              at:
                kind === "once"
                  ? zonedLocalDateTimeToUtc(
                      String(data.get("at")),
                      zone,
                    ).toISOString()
                  : null,
            });
          } catch (e) {
            setError(
              e instanceof Error ? e.message : "Schedule could not be saved.",
            );
            setBusy(false);
          }
        }}
      >
        <h2>{s ? "Edit schedule" : "Schedule work"}</h2>
        <label>
          Title
          <input
            name="title"
            required
            defaultValue={s?.title}
            maxLength={160}
          />
        </label>
        <label>
          What should the bot do?
          <textarea name="prompt" required rows={4} defaultValue={s?.prompt} />
        </label>
        <label>
          When
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value);
              if (e.target.value === "hourly") setCron("0 * * * *");
              if (e.target.value === "daily") setCron("0 9 * * *");
              if (e.target.value === "weekdays") setCron("0 9 * * 1-5");
            }}
          >
            <option value="once">Once</option>
            <option value="hourly">Every hour</option>
            <option value="daily">Every day at 9 AM</option>
            <option value="weekdays">Weekdays at 9 AM</option>
            <option value="custom">Custom cron</option>
          </select>
        </label>
        <label>
          Timezone
          <input
            required
            value={zone}
            onChange={(e) => setZone(e.target.value)}
          />
        </label>
        {kind === "once" ? (
          <label>
            Date and time
            <input
              name="at"
              type="datetime-local"
              required
              defaultValue={
                s?.at ? zonedDateTimeInputValue(new Date(s.at), zone) : ""
              }
            />
          </label>
        ) : (
          kind === "custom" && (
            <label>
              Cron expression
              <input
                required
                value={cron}
                onChange={(e) => setCron(e.target.value)}
                placeholder="minute hour day month weekday"
              />
            </label>
          )
        )}
        {error && <p className="bots-error">{error}</p>}
        <div className="bots-modal-actions">
          <button type="button" onClick={close}>
            Cancel
          </button>
          <button className="bots-primary" disabled={busy}>
            {busy ? "Saving…" : "Save schedule"}
          </button>
        </div>
      </form>
    </div>
  );
}
