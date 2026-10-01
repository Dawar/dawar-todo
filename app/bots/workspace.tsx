"use client";

import {
  Activity,
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
  Paperclip,
  X,
  Square,
  Archive,
  RotateCcw,
  LoaderCircle,
  RefreshCw,
  BarChart3,
  ListOrdered,
  ListPlus,
  UsersRound,
} from "lucide-react";
import type { Bot } from "./single-thread-contract";
import { BotAvatar as Avatar } from "./bot-avatar";
import { PersonalitySettings } from "./personality-settings";
import { WorkOverview, AutomaticInbox, workLabel } from "./work-overview";
import { PeerConversations, DiscussionStatus, useDiscussionStatus } from "./peer-conversations";
import { finishTodoForward } from "../todo-forward";
import { SiteHeader } from "../site-header";
import type {
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
import { MainStopButton, MainStopRecovery } from "./run-controls";
import { BotWorkControls } from "./bot-work-controls";
import { RunHistory } from "./run-history";
import type { ActivityTarget } from "./conversation-activity";
import { BotDesktopCard, BotDesktopDialog } from "./bot-desktop";
import { BotDetailsDrawer, type BotDetailsSection } from "./bot-details";
import { ScheduleList } from "./schedule-list";
import { RunDecisions } from "./run-decisions";
import { UsagePanel } from "./usage-panel";
import { useBotComposer } from "./use-composer";
import { ComposerAttachments, ComposerStatus } from "./composer-state";
import { installExtensionShortcuts } from "./extension-shortcuts";
import { SavedDrafts } from "./saved-drafts";
import { ComposerInput } from "./composer-input";
import { ComposerSettings } from "./composer-settings";
import { ArtifactGallery, BotAttachmentsEntry, ArtifactNav } from "./artifact-gallery";
import { PromptQueue } from "./prompt-queue";
import { TeamsManager, TeamAssignment } from "./teams";
import { QueueLists, useQueueLists } from "./queue-lists";
import "./bots.css";
import "./chat-design.css";

const EMPTY_BOTS: Bot[] = [];
const EMPTY_QUEUE: BotQueuedSubmission[] = [];

function humanStatus(bot: Bot, online: boolean) {
  if (!online) return "Offline";
  if (bot.archived) return "Archived";
  if (!bot.activeTurnId && bot.workerTasks?.active)
    return "Finishing earlier work";
  if (!bot.activeTurnId && bot.workerTasks?.waiting)
    return "Earlier work needs your input";
  return (
    (
      {
        idle: "Ready",
        running: "Working",
        waiting: "Needs your input",
        provisioning: "Setting up",
        error: "Unable to continue",
        interrupted: "Interrupted",
      } as Record<string, string>
    )[bot.status] ?? bot.status
  );
}

export function BotsWorkspace() {
  const [, redraw] = useState(0),
    [selected, setSelected] = useState<string | null>(null),
    [search, setSearch] = useState(""),
    [archived, setArchived] = useState(false),
    [creating, setCreating] = useState(false),
    [profile, setProfile] = useState(false),
    [desktopScope, setDesktopScope] = useState<string | null>(null),
    [gallery, setGallery] = useState<"artifacts" | "attachments" | null>(null),
    [detailsSection, setDetailsSection] = useState<BotDetailsSection>("next"),
    [activityTarget, setActivityTarget] = useState<ActivityTarget | null>(null),
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
  const sending = Boolean(composer?.operation || composer?.committing);
  const checkoutLocked = composer?.checkingOut || composer?.operation?.method === "queue.delete" || Boolean(composer?.draft.queueSource && !composer.draft.queueSource.removed);
  const canSend = Boolean(composer?.ready && !composer.storageError && !sending &&
    !checkoutLocked && uploads.every((file) => file.remote?.ready));
  const setDraft = (text: string) => composer?.setText(text);
  const [showTeams, setShowTeams] = useState(false), [teamFilter, setTeamFilter] = useState("all"), [teamSort, setTeamSort] = useState("recent");
  const snapshot = client.snapshot;
  const teams = snapshot?.teams ?? [];
  const teamsSupported = snapshot?.capabilities?.teams === 1;
  const lanes = snapshot?.capabilities?.backgroundRunLanes === 1;
  const online = client.online,
    bots = snapshot?.bots ?? EMPTY_BOTS,
    bot = bots.find((b) => b.id === selected),
    pending = snapshot?.pending.filter((p) => p.botId === selected && !(lanes && p.runId && p.laneId && p.threadId && !(snapshot?.capabilities?.singleThreadExecution === 1 && bot?.executionMode === "single-thread" && p.threadId === bot.threadId))) ?? [];
  const single = snapshot?.capabilities?.singleThreadExecution === 1 && bot?.executionMode === "single-thread";
  const work = single ? snapshot?.workByBot?.find(value => value.botId === selected) : undefined;
  const queueListsSupported = snapshot?.capabilities?.queueLists === 1;
  const queueLists = useQueueLists(owner, selected, online, queueListsSupported);
  const discussions = useDiscussionStatus(owner, selected, online, snapshot?.capabilities?.peerInbox === 1);
  const [discussionTarget, setDiscussionTarget] = useState<string | null>(null);
  const openDiscussion = (id: string | null = null) => { setDiscussionTarget(id); setDetailsSection("discussions"); setProfile(true); };
  const burstSupported = snapshot?.capabilities?.messageBursts === 1;
  const burstEnabled = burstSupported && bot?.executionMode === "single-thread";
  useEffect(() => { if (owner && selected && composer?.ready) { try { finishTodoForward(owner, selected); } catch { /* The exact draft insertion remains committed. */ } } }, [owner, selected, composer?.ready]);
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
    if (!creating && !editingSchedule && !showOverallUsage) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].filter(node => node.getClientRects().length).at(-1);
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
  }, [creating, editingSchedule, showOverallUsage]);
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
  useEffect(() => { let active = true; queueMicrotask(() => { if (active) setProfile(false); }); return () => { active = false; }; }, [selected, owner]);
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
  const refreshDefaultQueue = useCallback(async () => { if (selected) await loadQueue(selected); }, [selected, loadQueue]);
  const refreshQueueLists = queueLists.refresh;
  const refreshQueues = useCallback(async () => { await Promise.all([refreshDefaultQueue(), refreshQueueLists()]); }, [refreshDefaultQueue, refreshQueueLists]);
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
  useEffect(()=>installExtensionShortcuts(window,extension=>{
    const target=bots.find(bot=>bot.extension===extension&&!bot.archived);
    if(!target||document.querySelector('dialog[open]'))return;
    select(target.id);setProfile(false);setShowTeams(false);
    requestAnimationFrame(()=>screenRef.current?.querySelector<HTMLTextAreaElement>('.bots-composer textarea')?.focus());
  }),[bots,select]);
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
  async function send(queueNext = false, listId: string | null = null) {
    if (!composer || !bot || !canSend) return;
    const id = bot.id;
    await composer.send(queueNext, burstEnabled, listId);
    if (queueNext) { await loadQueue(id); await refreshQueueLists().catch(() => {}); }
  }
  function queueMessage() {
    if (!canSend || !online || (!draft.trim() && !uploads.length)) return;
    void send(true);
  }
  async function editQueued(item: BotQueuedSubmission) {
    const editingComposer = composer, editingBot = selected;
    const saved = await editingComposer?.checkout(item);
    if (selectedRef.current === editingBot && client.owner === owner) {
      if (saved) closeProfile();
      await refreshDefaultQueue().catch(() => {});
      await refreshQueueLists().catch(() => {});
    }
    return Boolean(saved);
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
  const filtered = useMemo(() => {
    const teams = snapshot?.teams ?? [];
    const filter = teamFilter === "all" || teamFilter === "none" || teams.some(t=>t.id===teamFilter) ? teamFilter : "all";
    const matching = bots.filter(b=>b.archived===archived && `${b.name} ${b.purpose} #${b.extension ?? ""}`.toLowerCase().includes(search.toLowerCase()) &&
      (filter==="all"||filter==="none"&&!b.teamId||b.teamId===filter));
    if (teamSort==="name") matching.sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id));
    if (teamSort==="team") {
      const order = new Map(teams.map((t,index)=>[t.id,index]));
      matching.sort((a,b)=>(order.get(a.teamId??"")??teams.length)-(order.get(b.teamId??"")??teams.length) ||
        (a.teamId===b.teamId?(a.teamOrder??0)-(b.teamOrder??0):0)||a.name.localeCompare(b.name)||a.id.localeCompare(b.id));
    }
    return matching;
  }, [bots, archived, search, teamFilter, teamSort, snapshot?.teams]);
  const schedules = snapshot?.schedules.filter((s) => s.botId === selected) ?? [];
  const recentRuns = [...new Map([...(lanes ? snapshot?.backgroundRuns ?? [] : []), ...(snapshot?.runs ?? [])]
    .filter(run => run.botId === selected).map(run => [run.id, run])).values()];
  const closeProfile = useCallback(() => setProfile(false), []);
  const openActivity = (target: ActivityTarget | null = null) => { setActivityTarget(target); setDetailsSection("history"); setProfile(true); };
  return (
    <div className="bots-screen" ref={screenRef} data-no-pull-refresh>
      <SiteHeader current="bots" />
      <main className={`bots-layout ${selected || gallery ? "has-selection" : ""}`}>
        <aside className="bots-sidebar">
          <div className="bots-sidebar-heading">
            <h1>Bots</h1>
            <div className="bots-sidebar-tools">
            <ArtifactNav active={gallery === "artifacts"} onOpen={() => openGallery("artifacts")} />
            <button className="bots-icon-button" disabled={!teamsSupported} title={teamsSupported ? "Teams" : "Teams will be available after the service update"} aria-label="Teams" onClick={() => setShowTeams(true)}><UsersRound size={19} /></button>
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
          <div className="bots-list-filters">
            <select aria-label="Bot visibility" value={archived ? "archived" : "active"} onChange={e => setArchived(e.target.value === "archived")}><option value="active">All bots</option><option value="archived">Archived</option></select>
            {teamsSupported && <select aria-label="Filter bots by team" value={teamFilter === "all" || teamFilter === "none" || teams.some(t => t.id === teamFilter) ? teamFilter : "all"} onChange={e => setTeamFilter(e.target.value)}><option value="all">All teams</option><option value="none">No team</option>{teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select>}
            <select aria-label="Bot list order" value={teamSort} onChange={e => setTeamSort(e.target.value)}><option value="recent">Recent</option><option value="team">Team order</option><option value="name">Name</option></select>
          </div>
          <BotSidebarList bots={filtered} snapshot={snapshot} selected={selected} select={select}
            empty={teamFilter!=="all" ? "No bots in this team." : search ? "No matching bots." : archived ? "No archived bots." : "Your bots will appear here."} />
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
                {snapshot?.capabilities?.botDesktops === 1 && <button className="bots-icon-button bots-desktop-mobile-open" aria-label="Show bot desktop" onClick={() => { setDetailsSection("desktop"); setProfile(true); }}><span aria-hidden="true">▣</span></button>}
                <div className="bots-header-title">
                  <strong>{bot.name}{bot.extension&&<span className="bots-extension" title="Hold Ctrl (or Alt), type the extension, then release">#{bot.extension}</span>}</strong>

                </div>
                {promptQueue.length > 0 && <button className="bots-icon-button bots-up-next-link" aria-label={`Show ${promptQueue.length} queued ${promptQueue.length === 1 ? "message" : "messages"}`} onClick={() => {
                  const queue = screenRef.current?.querySelector<HTMLElement>(".bots-prompt-queue");
                  queue?.focus({ preventScroll: true });
                  queue?.scrollIntoView({ block: "nearest" });
                }}><ListOrdered size={19} aria-hidden="true" /><span>{promptQueue.length}</span></button>}
                <button
                  className="bots-icon-button"
                  aria-label="Bot details"
                  aria-expanded={profile}
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
              <BotConversation key={scope} owner={owner} bot={bot} online={online} onOpenActivity={openActivity} draft={draft} burstsEnabled={burstSupported && !bot.archived} burstSubmitting={composer?.operation?.method === "bursts.submit"}>

                {snapshot?.capabilities?.peerInbox === 1 && <DiscussionStatus status={discussions} bots={bots} botId={bot.id} online={online} onOpen={openDiscussion} attentionOnly />}
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
                <div className="bots-conversation-presence"><Avatar bot={bot} small /><button type="button" onClick={() => { setDetailsSection("next"); setProfile(true); }} aria-label="Open work details" title={online ? workLabel(work, bots) ?? humanStatus(bot, online) : "Offline"}>{online ? workLabel(work, bots) ?? humanStatus(bot, online) : "Offline"}</button>{snapshot?.capabilities?.peerInbox === 1 && <DiscussionStatus status={discussions} bots={bots} botId={bot.id} online={online} onOpen={openDiscussion} />}</div>
              </BotConversation>
              {!bot.archived && (
                <>
                  <div className="bots-composer-support">
                    <PromptQueue key={`queue:${scope}`} owner={owner} bot={bot} items={promptQueue} online={online}
                      canEdit={Boolean(composer?.ready && !sending)} onEdit={editQueued} refresh={refreshQueues}
                      supported={queueListsSupported} relativeMoves={snapshot?.capabilities?.queueRelativeMoves===1} lists={queueLists.lists} onOpenLists={queueListsSupported ? () => { setDetailsSection("queues"); setProfile(true); } : undefined} />
                    {snapshot && <ComposerSettings key={`settings:${scope}`} bot={bot} snapshot={snapshot} online={online} />}
                  {(lanes || single) && <MainStopRecovery owner={owner} botId={bot.id} online={online} />}
                  <ComposerStatus composer={composer} error={composerError} />
                  {composer && <ComposerAttachments composer={composer} />}
                  </div>
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
                      disabled={!composer?.ready || checkoutLocked}
                      onClick={() => fileRef.current?.click()}
                    >
                      <Paperclip size={20} />
                    </button>
                    <ComposerInput
                      key={scope}
                      aria-label={`Message ${bot.name}`}
                      placeholder={online ? "Message…" : "Write a draft…"}
                      value={draft}
                      disabled={!composer?.ready || checkoutLocked}
                      rows={1}
                      onPaste={pasteImages}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (
                          e.key === "Enter" &&
                          !e.shiftKey &&
                          !e.nativeEvent.isComposing &&
                          e.nativeEvent.keyCode !== 229
                        ) {
                          e.preventDefault();
                          if (e.repeat) return;
                          if (e.ctrlKey) queueMessage();
                          else void send();
                        }
                      }}
                    />
                    {(
                      <>
                      <button type="button" className="bots-icon-button bots-queue-icon"
                        title="Queue next (Ctrl+Enter)"
                        aria-label="Queue next"
                        aria-keyshortcuts="Control+Enter"
                        disabled={!online || !canSend ||
                          (!draft.trim() && !uploads.length)}
                        onClick={queueMessage}>
                        <ListPlus size={20} aria-hidden="true" />
                      </button>
                      </>
                    )}
                    {(bot.activeTurnId || !lanes && Boolean(bot.workerTasks?.active)) &&
                      Boolean(draft || uploads.length) && (lanes || single ? <MainStopButton owner={owner} botId={bot.id} online={online} className="bots-icon-button" /> :
                        <button
                          type="button"
                          className="bots-icon-button"
                          aria-label="Stop all bot work"
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
                    {((bot.activeTurnId || !lanes && Boolean(bot.workerTasks?.active)) &&
                    !draft &&
                    !uploads.length ? (lanes || single ? <MainStopButton owner={owner} botId={bot.id} online={online} className="bots-send" /> :
                      <button
                        type="button"
                        className="bots-send"
                        aria-label="Stop all bot work"
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
        {bot && !gallery && <Activity mode={profile && desktopScope !== scope ? "visible" : "hidden"}>
          <BotDetailsDrawer key={scope} bot={bot} section={detailsSection} onSection={setDetailsSection} onClose={closeProfile} discussionAttention={discussions.requests.filter(r => ["failed", "delivery-unconfirmed"].includes(r.state) || ["working", "waiting"].includes(r.state) && bots.find(b => b.id === (r.senderBotId === bot.id ? r.recipientBotId : r.senderBotId))?.status === "waiting").length}>
            {{
              next: <>
                <h3>Up next</h3><p className="bots-details-lead">Scheduled work and bot discussions.</p>
                {single && <WorkOverview owner={owner} bot={bot} work={work} online={online} />}
                {!single && !promptQueue.length && <div className="bots-details-empty"><ListOrdered size={27} strokeWidth={1.5} /><h3>A little breathing room</h3><p>Nothing is queued. Use Ctrl+Enter to save a message for the next turn.</p></div>}
                {single && <AutomaticInbox owner={owner} botId={bot.id} online={online} />}
              </>,
              queues: queueListsSupported ? <QueueLists key={`lists:${scope}`} owner={owner} bot={bot} lists={queueLists.lists} defaultItems={promptQueue} online={online} refreshLists={queueLists.refresh} refreshDefault={refreshDefaultQueue} onEdit={editQueued} /> : <p className="bots-details-lead">Queue lists will be available when the bot service update finishes.</p>,
              schedules: <>
                <ScheduleList bot={bot} schedules={schedules} online={online} busy={busy} onEdit={setEditingSchedule} action={action} />
                {snapshot?.capabilities?.scheduleDecisions === 1 && <RunDecisions owner={owner} botId={bot.id} online={online} />}
              </>,
              files: <><h3>Files</h3><p className="bots-details-lead">Attachments and returned work, together. Open a preview, find a file, or download the original.</p><BotAttachmentsEntry bot={bot} owner={owner} online={online} onOpen={() => openGallery("attachments")} /></>,
              desktop: <><h3>Desktop</h3>{snapshot?.capabilities?.botDesktops === 1 ? <>
                <p className="bots-details-lead">Open the preview to use the fullscreen controller.</p>
                {/* Mount only in the open Desktop tab; no background captures
                    from the bot list, other tabs, or behind the controller. */}
                {profile && detailsSection === "desktop" && desktopScope !== scope && <BotDesktopCard key={`desktop:${scope}`} bot={bot} owner={owner} online={online} onOpen={() => setDesktopScope(scope)} />}
              </> : <p className="bots-details-lead">Desktop is unavailable on this service.</p>}</>,
              discussions: snapshot?.capabilities?.peerInbox === 1 ? <PeerConversations key={`discussions:${scope}`} owner={owner} botId={bot.id} bots={bots} online={online} historyView targetId={discussionTarget} /> : <p className="bots-details-lead">Discussions are unavailable on this service.</p>,
              history: <>{lanes && <details data-history-key="legacy-controls" className="bots-legacy-controls"><summary>Earlier work · recovery and controls</summary><BotWorkControls owner={owner} bot={bot} runs={recentRuns} online={online} onOpen={openActivity} /></details>}<RunHistory key={`${scope}:${activityTarget?.runId ?? ""}:${activityTarget?.turnId ?? ""}`} embedded bot={bot} schedules={schedules} recentRuns={recentRuns} initialTarget={activityTarget} attachments={[]} online={online} onClose={closeProfile} download={id => void download(id)} /></>,
              settings: <div className="bots-details-settings">
                <form onSubmit={event => { event.preventDefault(); const input = new FormData(event.currentTarget); void action(() => client.rpc("bots.update", bot.id, { name: String(input.get("name")) })); }}>
                  <label>Name<input name="name" defaultValue={bot.name} key={bot.id + bot.name} maxLength={80} required /></label><button type="submit" disabled={!online || busy}>Save name</button>
                </form>
                <SavedDrafts owner={owner} bots={bots} composer={composer}/><p className="bots-profile-hint">{bot.purpose}</p><p className="bots-profile-hint">Ask {bot.name} to change its personality, instructions, or memory.</p>
                {snapshot?.capabilities?.singleThreadExecution === 1 && <PersonalitySettings key={scope} bot={bot} snapshot={snapshot} online={online} />}
                {teamsSupported && <TeamAssignment key={`team:${scope}`} owner={owner} bot={bot} teams={teams} online={online} onManage={() => setShowTeams(true)} />}
                <a className="bots-notification-link" href="/settings">Notification settings</a>
                <div className="bots-profile-actions">
                  <button disabled={!online || busy || Boolean(bot.activeTurnId)} onClick={() => void action(() => client.rpc("thread.compact", bot.id))}><RotateCcw size={16} />Compact conversation</button>
                  {bot.archived && snapshot?.capabilities?.botDesktops === 1 && <button disabled={!online || busy} onClick={() => { if (window.confirm(`Delete ${bot.name}? Its desktop data will be removed. Its workspace files and archived conversation are retained.`)) void action(() => client.rpc("bots.delete", bot.id)); }}>Delete bot</button>}
                  <button disabled={!online || busy || Boolean(bot.activeTurnId)} onClick={() => void action(() => client.rpc(bot.archived ? "bots.restore" : "bots.archive", bot.id))}><Archive size={16} />{bot.archived ? "Restore bot" : "Archive bot"}</button>
                </div>
              </div>,
            }}
          </BotDetailsDrawer>
        </Activity>}
      </main>
      {showTeams && (teamsSupported ? <TeamsManager key={owner} owner={owner} teams={teams} bots={bots} online={online} onClose={() => setShowTeams(false)} /> : <div className="bots-modal-backdrop" onClick={() => setShowTeams(false)}><section className="bots-modal" role="dialog" aria-modal="true" aria-label="Teams" onClick={event => event.stopPropagation()}><h2>Teams</h2><p>Teams will be available when the bot service update finishes.</p><button className="bots-primary" onClick={() => setShowTeams(false)}>Close</button></section></div>)}
      {showOverallUsage && <div className="bots-modal-backdrop" onClick={() => setShowOverallUsage(false)}><section className="bots-history-modal bots-usage-modal" role="dialog" aria-modal="true" aria-label="Codex account usage" onClick={(event) => event.stopPropagation()}><header><h2>Codex account usage</h2><button className="bots-icon-button" aria-label="Close account usage" onClick={() => setShowOverallUsage(false)}><X size={19} /></button></header><UsagePanel online={online} /></section></div>}
      {bot && desktopScope === scope && !bot.archived && <BotDesktopDialog key={scope} bot={bot} owner={owner} onClose={() => setDesktopScope(null)} />}
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
