"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
  Paperclip,
  X,
  Square,
  Clock,
  Archive,
  RotateCcw,
  Download,
  Play,
  Pause,
  Trash2,
  Pencil,
  LoaderCircle,
  RefreshCw,
  Zap,
} from "lucide-react";
import { SiteHeader } from "../site-header";
import type {
  Bot,
  BotAttachment,
  BotEvent,
  BotHistory,
  BotSchedule,
} from "../../lib/bots-types";
import type { Turn } from "../../lib/codex-protocol/v2/Turn";
import {
  zonedDateTimeInputValue,
  zonedLocalDateTimeToUtc,
} from "../../lib/zoned-date-time";
import { botsClient as client } from "./client";
import {
  reduceBotTurns,
  type NativeEvent,
  type ConversationTurn,
} from "./thread-state";
import { BotMessage } from "./message";
import { RequestCard } from "./request-card";
import "./bots.css";

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
  if (!online) return "VM offline";
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
    [editingSchedule, setEditingSchedule] = useState<
      BotSchedule | "new" | null
    >(null);
  const [turns, setTurns] = useState<ConversationTurn[]>([]),
    [attachments, setAttachments] = useState<BotAttachment[]>([]),
    [draft, setDraft] = useState(""),
    [uploads, setUploads] = useState<BotAttachment[]>([]),
    [uploading, setUploading] = useState(""),
    [sending, setSending] = useState(false),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [olderCursor, setOlderCursor] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const selectedRef = useRef(selected),
    draftRef = useRef(draft),
    screenRef = useRef<HTMLDivElement>(null),
    scrollRef = useRef<HTMLDivElement>(null),
    fileRef = useRef<HTMLInputElement>(null),
    nearBottom = useRef(true),
    pendingEvents = useRef<BotEvent[]>([]),
    historyLoading = useRef(false),
    loadedId = useRef<string | null>(null),
    draftId = useRef<string | null>(null),
    createOperation = useRef(crypto.randomUUID());
  selectedRef.current = selected;
  draftRef.current = draft;
  const snapshot = client.snapshot,
    online = client.online,
    bots = snapshot?.bots ?? [],
    bot = bots.find((b) => b.id === selected),
    pending = snapshot?.pending.filter((p) => p.botId === selected) ?? [];
  const selectedModel = snapshot?.models.find(
    (m) => m.model === (bot?.model ?? snapshot.defaults.model),
  );
  const fastTier = selectedModel?.serviceTiers.find(
    (tier) => tier.id === "priority" || tier.id === "fast",
  )?.id;
  const fastActive =
    Boolean(fastTier) &&
    (bot?.serviceTier ?? snapshot?.defaults.serviceTier) === fastTier;
  useLayoutEffect(() => {
    const screen = screenRef.current;
    if (!screen) return;
    const root = document.documentElement;
    const viewport = window.visualViewport;
    // Activity tears down this effect when another tab becomes visible.
    root.classList.add("bots-viewport-locked");
    const resize = () => {
      screen.style.setProperty(
        "--bots-viewport-height",
        `${viewport?.height ?? window.innerHeight}px`,
      );
      screen.style.setProperty(
        "--bots-viewport-top",
        `${viewport?.offsetTop ?? 0}px`,
      );
    };
    resize();
    viewport?.addEventListener("resize", resize);
    viewport?.addEventListener("scroll", resize);
    window.addEventListener("resize", resize);
    return () => {
      root.classList.remove("bots-viewport-locked");
      viewport?.removeEventListener("resize", resize);
      viewport?.removeEventListener("scroll", resize);
      window.removeEventListener("resize", resize);
      screen.style.removeProperty("--bots-viewport-height");
      screen.style.removeProperty("--bots-viewport-top");
    };
  }, []);
  useEffect(() => {
    if (!creating && !editingSchedule) return;
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
  }, [creating, editingSchedule]);
  useEffect(() => {
    const unsubscribe = client.subscribe(() => redraw((v) => v + 1));
    client.start();
    const initial = new URLSearchParams(window.location.search).get("bot");
    if (initial) setSelected(initial);
    const pop = () =>
      setSelected(new URLSearchParams(window.location.search).get("bot"));
    window.addEventListener("popstate", pop);
    window.addEventListener("dawar-shell-popstate", pop);
    return () => {
      unsubscribe();
      window.removeEventListener("popstate", pop);
      window.removeEventListener("dawar-shell-popstate", pop);
    };
  }, []);
  const loadHistory = useCallback(async (id: string) => {
    loadedId.current = null;
    draftId.current = null;
    const cached = client.cache<{
      turns: Turn[];
      attachments: BotAttachment[];
    } | null>(`history:${id}`, null);
    if (cached) {
      setTurns(cached.turns);
      setAttachments(cached.attachments);
    } else {
      setTurns([]);
      setAttachments([]);
    }
    setDraft(client.cache(`draft:${id}`, ""));
    setUploads(client.cache<BotAttachment[]>(`uploads:${id}`, []));
    queueMicrotask(() => {
      if (selectedRef.current === id) {
        loadedId.current = id;
        draftId.current = id;
      }
    });
    if (!client.online) return;
    setLoading(true);
    historyLoading.current = true;
    pendingEvents.current = [];
    try {
      const history = await client.rpc<BotHistory>("history", id);
      if (selectedRef.current !== id) return;
      let next = history.thread.turns;
      for (const event of pendingEvents.current)
        if (event.type === "codex")
          next = reduceBotTurns(next, event.data as NativeEvent);
      setTurns(next);
      setOlderCursor(history.nextCursor);
      setAttachments(history.attachments);
      client.save(`history:${id}`, {
        turns: next,
        attachments: history.attachments,
      });
      await client.rpc("bots.read", id);
    } catch (e) {
      if (selectedRef.current === id)
        setError(e instanceof Error ? e.message : "History could not load.");
    } finally {
      if (selectedRef.current === id) {
        setLoading(false);
        historyLoading.current = false;
        pendingEvents.current = [];
      }
    }
  }, []);
  useEffect(() => {
    if (selected) void loadHistory(selected);
    else {
      setTurns([]);
      setAttachments([]);
    }
    setProfile(false);
    setError("");
    nearBottom.current = true;
  }, [selected, online, loadHistory]);
  useEffect(() => {
    const listener = (event: BotEvent) => {
      if (event.botId !== selectedRef.current) return;
      if (historyLoading.current) {
        pendingEvents.current.push(event);
        return;
      }
      if (event.type === "history.refresh" && selectedRef.current)
        void loadHistory(selectedRef.current);
      if (event.type === "codex")
        setTurns((current) =>
          reduceBotTurns(current, event.data as NativeEvent),
        );
      if (event.type === "attachment")
        setAttachments((current) => [
          ...current.filter((a) => a.id !== (event.data as BotAttachment).id),
          event.data as BotAttachment,
        ]);
    };
    client.events.add(listener);
    return () => {
      client.events.delete(listener);
    };
  }, []);
  useEffect(() => {
    if (selected && loadedId.current === selected && client.owner)
      client.save(`history:${selected}`, { turns, attachments });
    if (nearBottom.current)
      scrollRef.current?.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: "instant",
      });
  }, [turns, attachments, selected, pending.length]);
  useEffect(() => {
    if (selected && draftId.current === selected && client.owner)
      client.save(`draft:${selected}`, draft);
  }, [draft, selected]);
  useEffect(() => {
    if (selected && draftId.current === selected && client.owner)
      client.save(`uploads:${selected}`, uploads);
  }, [uploads, selected]);
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
  function select(id: string | null) {
    if (selectedRef.current)
      client.save(`draft:${selectedRef.current}`, draftRef.current);
    setSelected(id);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("bot", id);
    else url.searchParams.delete("bot");
    window.history.pushState({}, "", url);
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
  async function send() {
    if (!bot || sending) return;
    const text = draft.trim(),
      files = uploads.map((a) => a.id);
    if (!text && !files.length) return;
    setSending(true);
    setError("");
    nearBottom.current = true;
    try {
      await client.rpc("turn.send", bot.id, { text, attachments: files });
      if (draftRef.current.trim() === text) setDraft("");
      setUploads([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Message could not be sent.");
    } finally {
      setSending(false);
    }
  }
  async function upload(files: FileList | null) {
    if (!bot || !files) return;
    setError("");
    try {
      if (uploads.length + files.length > 12)
        throw new Error("Attach at most 12 files.");
      for (const file of Array.from(files)) {
        if (file.size > 100 * 1024 * 1024)
          throw new Error("Files must be under 100 MB.");
        if (uploads.length >= 12) throw new Error("Attach at most 12 files.");
        setUploading(`${file.name} · 0%`);
        const attachment = await client.upload(bot.id, file, (value) =>
          setUploading(`${file.name} · ${value}%`),
        );
        setUploads((current) => [...current, attachment]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setUploading("");
      if (fileRef.current) fileRef.current.value = "";
    }
  }
  const filtered = bots.filter(
    (b) =>
      b.archived === archived &&
      `${b.name} ${b.purpose}`.toLowerCase().includes(search.toLowerCase()),
  );
  const schedules =
      snapshot?.schedules.filter((s) => s.botId === selected) ?? [],
    runs = snapshot?.runs.filter((r) => r.botId === selected) ?? [];
  return (
    <div className="bots-screen" ref={screenRef} data-no-pull-refresh>
      <SiteHeader current="bots" />
      <main className={`bots-layout ${selected ? "has-selection" : ""}`}>
        <aside className="bots-sidebar">
          <div className="bots-sidebar-heading">
            <h1>Bots</h1>
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
          <label className="bots-search">
            <Search size={17} />
            <input
              aria-label="Search bots"
              placeholder="Search bots"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
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
          <div className="bots-list">
            {filtered.map((b) => (
              <button
                className={`bots-row ${selected === b.id ? "selected" : ""}`}
                key={b.id}
                onClick={() => select(b.id)}
              >
                <Avatar bot={b} />
                <span className="bots-row-copy">
                  <span className="bots-row-name">
                    <span className="bots-row-title">{b.name}</span>
                    <small>
                      {new Date(b.updatedAt).toLocaleTimeString(undefined, {
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </small>
                  </span>
                  <span className="bots-row-preview">
                    {b.status === "waiting"
                      ? "Needs your input"
                      : b.preview || b.purpose || "Start a conversation"}
                  </span>
                </span>
                {b.updatedAt > b.lastReadAt && <span className="bots-unread" />}
                {(b.status === "running" || Boolean(b.workerTasks?.active)) && (
                  <LoaderCircle size={14} className="bots-spin" />
                )}
              </button>
            ))}
            {!filtered.length && (
              <div className="bots-sidebar-empty">
                {search
                  ? "No matching bots."
                  : archived
                    ? "No archived bots."
                    : "Your bots will appear here."}
              </div>
            )}
          </div>
          <div className="bots-machine">
            <span className={`bots-status-dot ${online ? "online" : ""}`} />
            <span>
              {online
                ? "Your VM is connected"
                : client.error
                  ? client.error
                  : "Connecting to your VM…"}
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
        <section className="bots-conversation">
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
              {bot.error}
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
              <div
                className="bots-messages"
                ref={scrollRef}
                onScroll={() => {
                  const el = scrollRef.current;
                  if (el)
                    nearBottom.current =
                      el.scrollHeight - el.scrollTop - el.clientHeight < 100;
                }}
              >
                {olderCursor && (
                  <button
                    className="bots-older"
                    disabled={!online || busy}
                    onClick={() =>
                      void action(async () => {
                        const page = await client.rpc<{
                          data: Turn[];
                          nextCursor: string | null;
                        }>("history.page", bot.id, { cursor: olderCursor });
                        setTurns((current) => [
                          ...page.data
                            .reverse()
                            .filter((t) => !current.some((c) => c.id === t.id)),
                          ...current,
                        ]);
                        setOlderCursor(page.nextCursor);
                      })
                    }
                  >
                    Load earlier messages
                  </button>
                )}
                {loading && (
                  <div className="bots-system-note">Loading conversation…</div>
                )}
                {!loading && !turns.length && (
                  <div className="bots-conversation-start">
                    <Avatar bot={bot} />
                    <h2>{bot.name}</h2>
                    <p>{bot.purpose || "What would you like to work on?"}</p>
                  </div>
                )}
                {turns.map((turn) => (
                  <div className="bots-turn" key={turn.id}>
                    {turn.startedAt && (
                      <div className="bots-time">
                        {stamp(new Date(turn.startedAt * 1000).toISOString())}
                      </div>
                    )}
                    {turn.items.map((item) => (
                      <BotMessage
                        key={item.id}
                        item={item}
                        botId={bot.id}
                        attachments={attachments}
                        download={(id) => void download(id)}
                      />
                    ))}
                    {turn.planSteps && (
                      <details className="bots-tool">
                        <summary>Work plan</summary>
                        <ul>
                          {turn.planSteps.map((step, i) => (
                            <li key={i}>
                              {step.status}: {step.step}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                    {turn.diff && (
                      <details className="bots-tool">
                        <summary>Turn changes</summary>
                        <pre>{turn.diff}</pre>
                      </details>
                    )}
                    {turn.error && (
                      <div className="bots-error">{turn.error.message}</div>
                    )}
                    {turn.status === "interrupted" && (
                      <div className="bots-system-note">Stopped</div>
                    )}
                  </div>
                ))}
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
              </div>
              {attachments.some(
                (a) => (a as BotAttachment & { artifact?: boolean }).artifact,
              ) && (
                <div className="bots-artifacts">
                  {attachments
                    .filter(
                      (a) =>
                        (a as BotAttachment & { artifact?: boolean }).artifact,
                    )
                    .map((a) => (
                      <button
                        key={a.id}
                        disabled={!online || busy}
                        onClick={() => void download(a.id)}
                      >
                        <Download size={14} />
                        {a.name}
                      </button>
                    ))}
                </div>
              )}
              {!bot.archived && (
                <>
                  <div className="bots-controls">
                    <select
                      aria-label="Model"
                      disabled={!online}
                      value={bot.model ?? ""}
                      onChange={(e) =>
                        void action(() =>
                          client.rpc("bots.update", bot.id, {
                            model: e.target.value || null,
                            effort: null,
                          }),
                        )
                      }
                    >
                      <option value="">
                        Default · {snapshot?.defaults.model}
                      </option>
                      {snapshot?.models.map((m) => (
                        <option key={m.id} value={m.model}>
                          {m.displayName}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label="Reasoning effort"
                      disabled={!online}
                      value={bot.effort ?? ""}
                      onChange={(e) =>
                        void action(() =>
                          client.rpc("bots.update", bot.id, {
                            effort: e.target.value || null,
                          }),
                        )
                      }
                    >
                      <option value="">
                        Default · {snapshot?.defaults.effort}
                      </option>
                      {selectedModel?.supportedReasoningEfforts.map((e) => (
                        <option
                          key={e.reasoningEffort}
                          value={e.reasoningEffort}
                        >
                          {e.reasoningEffort}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className={fastActive ? "active" : ""}
                      aria-label="Fast mode"
                      aria-pressed={fastActive}
                      title={
                        fastTier
                          ? "Fast mode uses more Codex credits"
                          : "Fast mode is unavailable for this model"
                      }
                      disabled={!online || !fastTier}
                      onClick={() =>
                        void action(() =>
                          client.rpc("bots.update", bot.id, {
                            serviceTier: fastActive ? "default" : fastTier,
                          }),
                        )
                      }
                    >
                      <Zap size={13} aria-hidden="true" /> Fast
                    </button>
                    <button
                      className={bot.mode === "plan" ? "active" : ""}
                      disabled={!online}
                      onClick={() =>
                        void action(() =>
                          client.rpc("bots.update", bot.id, {
                            mode: bot.mode === "plan" ? "default" : "plan",
                          }),
                        )
                      }
                    >
                      Plan
                    </button>
                  </div>
                  {(uploads.length > 0 || uploading) && (
                    <div className="bots-upload-list">
                      {uploads.map((a) => (
                        <span key={a.id}>
                          {a.name}
                          <button
                            aria-label={`Remove ${a.name}`}
                            onClick={() =>
                              setUploads((current) =>
                                current.filter((x) => x.id !== a.id),
                              )
                            }
                          >
                            <X size={13} />
                          </button>
                        </span>
                      ))}
                      {uploading && (
                        <span>
                          <LoaderCircle size={13} className="bots-spin" />
                          {uploading}
                        </span>
                      )}
                    </div>
                  )}
                  <form
                    className="bots-composer"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void send();
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
                      disabled={!online || Boolean(uploading)}
                      onClick={() => fileRef.current?.click()}
                    >
                      <Paperclip size={20} />
                    </button>
                    <textarea
                      aria-label={`Message ${bot.name}`}
                      placeholder={
                        online
                          ? `Message ${bot.name}…`
                          : "Write a draft while your VM reconnects…"
                      }
                      value={draft}
                      rows={1}
                      onChange={(e) => {
                        setDraft(e.target.value);
                        e.target.style.height = "auto";
                        e.target.style.height =
                          Math.min(e.target.scrollHeight, 180) + "px";
                      }}
                      onKeyDown={(e) => {
                        if (
                          e.key === "Enter" &&
                          !e.shiftKey &&
                          !e.nativeEvent.isComposing
                        ) {
                          e.preventDefault();
                          void send();
                        }
                      }}
                    />
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
                    {(bot.activeTurnId || Boolean(bot.workerTasks?.active)) &&
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
                          sending ||
                          Boolean(uploading) ||
                          (!draft.trim() && !uploads.length)
                        }
                      >
                        {sending ? (
                          <LoaderCircle className="bots-spin" size={18} />
                        ) : (
                          <ArrowUp size={20} />
                        )}
                      </button>
                    )}
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
        </section>
        {profile && bot && (
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
            {runs.length > 0 && (
              <details className="bots-run-history">
                <summary>Recent runs</summary>
                {runs.slice(0, 15).map((run) => (
                  <div key={run.id}>
                    <strong>{run.title}</strong>
                    <small>
                      {run.status} · {stamp(run.scheduledAt)}
                    </small>
                    {run.error && <p>{run.error}</p>}
                    {run.status === "uncertain" && (
                      <button
                        disabled={!online}
                        onClick={() =>
                          void action(() =>
                            client.rpc("runs.acknowledge", bot.id, {
                              id: run.id,
                            }),
                          )
                        }
                      >
                        I reviewed this run
                      </button>
                    )}
                  </div>
                ))}
              </details>
            )}
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
