"use client";
import { CodexAuthRecovery } from "./codex-auth-recovery";
import {ExecutionAccess} from './execution-access';
import { ContextCompactionSettings } from "./context-compaction";
import type {BotAdmissionWork} from '../../lib/bot-work-view';
import { ControlledDialog } from "@/components/ui/controlled-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ReplyQuote } from "./message-reply";

import {
  Activity,
  Suspense,
  type ClipboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { retryingLazy } from "../../lib/retrying-lazy";
import {
  Bot as BotIcon,
  Plus,
  ArrowLeft,
  MoreHorizontal,
  ArrowUp,
  Paperclip,
  Copy,
  ClipboardPaste,
  X,
  Square,
  Archive,
  LoaderCircle,
  RefreshCw,
  BarChart3,
  ListOrdered,
  ListPlus,
  UsersRound,
  Phone,
  Megaphone,
  Lightbulb,
  } from "lucide-react";
import type { Bot } from "./single-thread-contract";
import { BotAvatar as Avatar } from "./bot-avatar";
import { ActiveTurnElapsed } from "./active-turn-elapsed";
import { WorkOverview, AutomaticInbox, NativeWriterRecovery, workLabel } from "./work-overview";
import { GoalIndicator, NativeGoalPanel } from "./native-goal-panel";
import { finishTodoForward } from "../todo-forward";
import { SiteHeader } from "../site-header";
import type {
  BotEvent,
  BotSchedule,
  BotQueuedSubmission,
} from "../../lib/bots-types";
import { botsClient as client } from "./client";
import type { NativeEvent } from "./thread-state";
import { BotConversation } from "./timeline";
import { ArchivedBots, BotSidebarList, type SidebarFocusIntent } from "./sidebar-list";
import { FollowupComposerProvider } from "./codex-followup";
import { SidebarFilters } from "./sidebar-filters";
import { searchSidebarBots } from "./announcement-state";
import { useSharedReadPositions } from './read-position-sync';
import { TaskRequestWorkspace } from "./task-request-ui";
import { RequestCard } from "./request-card";
import { LegacyStopButton, MainStopButton, MainStopRecovery } from "./run-controls";
import { botStopped } from "./bot-stop-state";
import { StoppedMark } from "./stopped-mark";
import { BotWorkControls } from "./bot-work-controls";
import type { ActivityTarget } from "./activity-target";
import { OperatorCallDialog, OperatorCallHistory } from "./operator-call";
import { BotDetailsPanel, DEFAULT_DETAILS_SECTION, useDockedDetails, useDockedPreference, type BotDetailsSection } from "./bot-details";
import { ChapterNavigation } from "./chapter-panel";
import { RunDecisions } from "./run-decisions";
import { useBotComposer } from "./use-composer";
import { botComposers, type ComposerPaste } from "./composer-service";
import { ComposerAttachments, ComposerStatus } from "./composer-state";
import { installExtensionShortcuts } from "./extension-shortcuts";
import { useBotSearchShortcut, botKeyboardAvailable } from "./bot-search-shortcut";
import { SavedDrafts } from "./saved-drafts";
import { ComposerInput } from "./composer-input";
import { ComposerSettings } from "./composer-settings";
import { ContextMeter } from "@/components/ai-elements/context";
import { contextMeter } from "../../lib/ai-elements";
import { ArtifactGallery, BotAttachmentsEntry, ArtifactNav } from "./artifact-gallery";
import { PromptQueue } from "./prompt-queue";
import { QueueLists, useQueueLists } from "./queue-lists";
import { useComposerQueueDestination } from "./composer-queue-destination";
import "./bots.css";
import "./chat-design.css";
import { botProvider } from "../../lib/bot-provider";

// Panels and dialogs that open on demand load on first use instead of with
// the bots page, so opening the app parses only what the chat needs.
const CreateBotDialog = retryingLazy(() => import("./create-bot-dialog").then(m => ({ default: m.CreateBotDialog })));
const BotAdminApprovals = retryingLazy(() => import("./bot-admin-approvals").then(m => ({ default: m.BotAdminApprovals })));
const InitiativeSettings = retryingLazy(() => import("./initiative-settings").then(m => ({ default: m.InitiativeSettings })));
const ProactiveSettingsPage = retryingLazy(() => import("./proactive-settings").then(m => ({ default: m.ProactiveSettingsPage })));
const PersonalitySettings = retryingLazy(() => import("./personality-settings").then(m => ({ default: m.PersonalitySettings })));
const ScheduleEditor = retryingLazy(() => import("./schedule-editor").then(m => ({ default: m.ScheduleEditor })));
const ScheduleList = retryingLazy(() => import("./schedule-list").then(m => ({ default: m.ScheduleList })));
const AnnouncementDialog = retryingLazy(() => import("./announcements").then(m => ({ default: m.AnnouncementDialog })));
const RunHistory = retryingLazy(() => import("./run-history").then(m => ({ default: m.RunHistory })));
const BotDesktopCard = retryingLazy(() => import("./bot-desktop").then(m => ({ default: m.BotDesktopCard })));
const BotDesktopDialog = retryingLazy(() => import("./bot-desktop").then(m => ({ default: m.BotDesktopDialog })));
const UsagePanel = retryingLazy(() => import("./usage-panel").then(m => ({ default: m.UsagePanel })));
const TeamsManager = retryingLazy(() => import("./teams").then(m => ({ default: m.TeamsManager })));
const TeamAssignment = retryingLazy(() => import("./teams").then(m => ({ default: m.TeamAssignment })));

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
    [creating, setCreating] = useState(false),
    [profile, setProfile] = useState(false),
    [desktopScope, setDesktopScope] = useState<string | null>(null),
    [gallery, setGallery] = useState<"artifacts" | "attachments" | "proactive" | null>(null),
    [detailsSection, setDetailsSection] = useState<BotDetailsSection>(DEFAULT_DETAILS_SECTION),
    [activityTarget, setActivityTarget] = useState<ActivityTarget | null>(null),
    [showOverallUsage, setShowOverallUsage] = useState(false),
    [editingSchedule, setEditingSchedule] = useState<
      { schedule: BotSchedule | "new"; scope: string; botId: string; owner: string } | null
    >(null);
  const [loadedQueue, setPromptQueue] = useState<BotQueuedSubmission[]>([]),
    [queueScope, setQueueScope] = useState(""),
    [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const selectedRef = useRef(selected), screenRef = useRef<HTMLDivElement>(null),
    fileRef = useRef<HTMLInputElement>(null), searchRef = useRef<HTMLInputElement>(null),
    queueRequest = useRef(0), createOperation = useRef(crypto.randomUUID());
  const sidebarFocus = useRef<SidebarFocusIntent | null>(null);
  useLayoutEffect(() => { selectedRef.current = selected; }, [selected]);
  const owner = client.owner;
  const scope = JSON.stringify([owner, selected]);
  // Wide desktops dock Bot details beside the chat with a remembered
  // owner-scoped choice; narrower layouts use the transient modal drawer.
  const docked = useDockedDetails();
  const [dockOpen, setDockOpen] = useDockedPreference(owner);
  // Widening while the drawer is open hands it over to the docked column.
  useEffect(() => { if (!docked || !profile) return; let active = true; queueMicrotask(() => { if (active) { setProfile(false); setDockOpen(true); } }); return () => { active = false; }; }, [docked, profile, setDockOpen]);
  const detailsOpen = docked ? dockOpen : profile;
  const detailsToggle = useRef<HTMLButtonElement>(null);
  const returnDetailsFocus = useCallback(() => detailsToggle.current, []);
  const openDetails = useCallback((section?: BotDetailsSection) => { if (section) setDetailsSection(section); if (docked) setDockOpen(true); else setProfile(true); }, [docked, setDockOpen]);
  const { searchOpen, closeSearch, keepOpenForNavigation } = useBotSearchShortcut(screenRef, searchRef, JSON.stringify([owner, selected, gallery, client.snapshot?.bots.find(value => value.id === selected)?.threadId ?? null]));
  if (editingSchedule && editingSchedule.scope !== scope) setEditingSchedule(null);
  const promptQueue = queueScope === scope ? loadedQueue : EMPTY_QUEUE;
  const { composer, error: composerError } = useBotComposer(client.owner, selected);
  const [transferBusy,setTransferBusy]=useState(false),[transferError,setTransferError]=useState("");
  const draft = composer?.draft.text ?? "";
  const uploads = composer?.draft.files ?? [];
  const sending = Boolean(composer?.operation || composer?.committing);
  const checkoutLocked = composer?.checkingOut || composer?.operation?.method === "queue.delete" || Boolean(composer?.draft.queueSource && !composer.draft.queueSource.removed);
  const canSend = Boolean(composer?.ready && !composer.storageError && !sending &&
    !checkoutLocked && uploads.every((file) => file.remote?.ready));
  const setDraft = (text: string) => composer?.setText(text);
  const [showCall, setShowCall] = useState(false), [callBotId, setCallBotId] = useState<string | null>(null);
  const [showTeams, setShowTeams] = useState(false), [announcementOwner, setAnnouncementOwner] = useState<string | null>(null);
  const snapshot = client.snapshot;
  // Portable hubs create bots only through a node that advertises it.
  const canCreate = snapshot?.capabilities?.portableAgents !== 1 || snapshot.capabilities.botCreation === 1;
  useSharedReadPositions(owner, snapshot?.bots ?? [], snapshot?.capabilities?.portableAgents === 1);
  const teams = snapshot?.teams ?? [];
  const teamsSupported = snapshot?.capabilities?.teams === 1;
  const lanes = snapshot?.capabilities?.backgroundRunLanes === 1;
  const online = client.online,
    bots = snapshot?.bots ?? EMPTY_BOTS,
    bot = bots.find((b) => b.id === selected),
    pending = snapshot?.pending.filter((p) => p.botId === selected && !(lanes && p.runId && p.laneId && p.threadId && !(snapshot?.capabilities?.singleThreadExecution === 1 && bot?.executionMode === "single-thread" && p.threadId === bot.threadId))) ?? [];
  const single = snapshot?.capabilities?.singleThreadExecution === 1 && bot?.executionMode === "single-thread";
  // Context meter: native current context with a known window only; otherwise hidden.
  const contextUsage = contextMeter(bot?.contextCompaction?.context);
  const work:BotAdmissionWork|undefined = single ? snapshot?.workByBot?.find(value => value.botId === selected) : undefined;
  const queueListsSupported = snapshot?.capabilities?.queueLists === 1;
  const queueLists = useQueueLists(owner, selected, online, queueListsSupported);
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
    const unsubscribe = client.subscribe(() => redraw((v) => v + 1));
    client.start();
    const pop = () => {
      const params = new URLSearchParams(window.location.search), id = params.get("bot"), view = params.get("view");
      setGallery(view === "artifacts" || view === "proactive" || view === "attachments" && id ? view : null);
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
  const select = useCallback((id: string | null, keyboard = false) => {
    if (!keyboard) sidebarFocus.current = null;
    closeSearch();
    selectedRef.current = id;
    setSelected(id); setGallery(null);setTransferError("");
    const url = new URL(window.location.href);
    url.searchParams.delete("view");url.searchParams.delete("room");url.searchParams.delete("roomBot");
    if (id) url.searchParams.set("bot", id);
    else url.searchParams.delete("bot");
    window.history.pushState({}, "", url);
  }, [closeSearch]);
  const navigateBot = useCallback((id: string) => {
    if (client.owner !== owner) return;
    select(id, true);
    if (window.matchMedia('(max-width: 700px)').matches) keepOpenForNavigation(JSON.stringify([owner, id, null, client.snapshot?.bots.find(value => value.id === id)?.threadId ?? null]));
  }, [owner, select, keepOpenForNavigation]);
  const finishTransfer=useCallback(async(paste:ComposerPaste)=>{
    const target=bots.find(bot=>bot.id===paste.targetBotId);
    if(paste.nonEmpty&&!window.confirm(`Replace ${target?.name??"this bot"}'s existing draft? Its previous contents will be saved for recovery.`))return false;
    await botComposers.applyPaste(paste);return true;
  },[bots]);
  const moveComposer=useCallback(async(targetId:string)=>{
    const sourceId=selectedRef.current;
    if(!sourceId||sourceId===targetId||transferBusy)return;
    const source=botComposers.peek(owner,sourceId);
    if(source?.ready&&!source.draft.text&&!source.draft.files.length&&!source.draft.reply&&!source.operation){select(targetId);setProfile(false);setShowTeams(false);return;}
    setTransferBusy(true);setTransferError("");
    try{
      const snapshot=await botComposers.capture(owner,sourceId);
      const paste=await botComposers.preparePaste(owner,targetId,snapshot.botId,true);
      if(selectedRef.current!==sourceId)throw Error("Selection changed. Drafts are retained; start the move again.");
      if(await finishTransfer(paste)){select(targetId);setProfile(false);setShowTeams(false);}
    }catch(error){setTransferError(error instanceof Error?error.message:"Could not move this draft. Original drafts are retained.");}
    finally{setTransferBusy(false);}
  },[owner,select,finishTransfer,transferBusy]);
  useEffect(()=>installExtensionShortcuts(window,(extension,move)=>{
    const target=bots.find(bot=>bot.extension===extension&&!bot.archived);
    if(!target||document.querySelector('dialog[open]'))return;
    if(move){void moveComposer(target.id);return;}
    select(target.id);setProfile(false);setShowTeams(false);setTransferError("");
    requestAnimationFrame(()=>screenRef.current?.querySelector<HTMLTextAreaElement>('.bots-composer textarea')?.focus());
  }),[bots,select,moveComposer]);
  async function copyComposer(){
    if(!selected||transferBusy)return;
    setTransferBusy(true);setTransferError("");
    try{await botComposers.copyComposer(owner,selected);}
    catch(error){setTransferError(error instanceof Error?error.message:"Could not copy this composer. Original draft is retained.");}
    finally{setTransferBusy(false);}
  }
  async function pasteComposer(){
    if(!selected||transferBusy)return;
    const targetId=selected;
    setTransferBusy(true);setTransferError("");
    try{
      const paste=await botComposers.preparePaste(owner,targetId);
      if(selectedRef.current!==targetId)throw Error("Selection changed. Paste into the intended bot again.");
      await finishTransfer(paste);
    }catch(error){setTransferError(error instanceof Error?error.message:"Could not paste this composer. Original drafts are retained.");}
    finally{setTransferBusy(false);}
  }
  function openGallery(view: "artifacts" | "attachments" | "proactive") {
    const url = new URL(window.location.href); url.searchParams.set("view", view);
    if (view !== "attachments") { url.searchParams.delete("bot"); setSelected(null); selectedRef.current = null; }
    setGallery(view); window.history.pushState({}, "", url);
  }
  function closeGallery() {
    const url = new URL(window.location.href); url.searchParams.delete("view"); window.history.pushState({}, "", url);
    if (gallery === "attachments") openDetails(); setGallery(null);
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
    if (!composer || !bot || !canSend || queueDestination.busy) return;
    const id = bot.id;
    await composer.send(queueNext, burstEnabled, listId);
    if (queueNext) { await loadQueue(id); await refreshQueueLists().catch(() => {}); }
  }
  const queueDestination = useComposerQueueDestination({owner, botId: selected, threadId: bot?.threadId,
    composer, online, supported: queueListsSupported, canSend, burst: burstEnabled, refresh: refreshQueues});
  function queueMessage() { void queueDestination.queue(); }
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
  const filtered = useMemo(() => searchSidebarBots(bots, snapshot?.teams ?? [], search), [bots, search, snapshot?.teams]);
  const archivedBots = useMemo(() => bots.filter(bot => bot.archived && !bot.deletedAt).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [bots]);
  const schedules = snapshot?.schedules.filter((s) => s.botId === selected) ?? [];
  const recentRuns = [...new Map([...(lanes ? snapshot?.backgroundRuns ?? [] : []), ...(snapshot?.runs ?? [])]
    .filter(run => run.botId === selected).map(run => [run.id, run])).values()];
  const openCalls = useCallback(() => openDetails("calls"), [openDetails]);
  const closeProfile = useCallback(() => { if (docked) setDockOpen(false); else setProfile(false); }, [docked, setDockOpen]);
  const openActivity = (target: ActivityTarget | null = null) => { setActivityTarget(target); openDetails("history"); };
  return (
    <><TaskRequestWorkspace key={JSON.stringify([owner,bot?.id,bot?.threadId])} owner={owner} bot={bot} online={online} supported={snapshot?.capabilities?.taskRequests === 1}><div className="bots-screen" ref={screenRef} data-no-pull-refresh>
      <SiteHeader current="bots" />
      <main className={`bots-layout ${selected || gallery ? "has-selection" : ""} ${searchOpen ? "search-open" : ""} ${docked && dockOpen && bot && !gallery && desktopScope !== scope ? "has-details-docked" : ""}`}>
        <aside className="bots-sidebar" onKeyDown={event => { if (event.key === 'Escape' && searchOpen && !event.defaultPrevented) { event.preventDefault(); closeSearch(true); } }}>
          <div className="bots-sidebar-heading">
            <h1 className="sr-only">Bots</h1>
            {searchOpen && (selected || gallery) && <Button type="button" variant="ghost" size="icon" className="bots-search-close" aria-label="Close bot search" onClick={() => closeSearch(true)}><X size={20}/></Button>}
            <div className="bots-sidebar-tools">
            <Button type="button" variant="ghost" size="icon" aria-label="Announcement" title="Announcement" disabled={!owner} onClick={() => setAnnouncementOwner(owner)}><Megaphone size={19} /></Button>
            {snapshot?.capabilities?.operatorCalls === 1 && <Button type="button" variant="ghost" size="icon" className="aria-pressed:bg-accent aria-pressed:text-accent-foreground" aria-label="Call Operator" onClick={() => { setCallBotId(null); setShowCall(true); }}><Phone size={16} /></Button>}
            <ArtifactNav active={gallery === "artifacts"} onOpen={() => openGallery("artifacts")} />
            {snapshot?.capabilities?.proactiveInitiative === 1 && <Button type="button" variant="ghost" size="icon" className="aria-[current=page]:bg-accent aria-[current=page]:text-accent-foreground" title="Proactive bots" aria-label="Proactive bots" aria-current={gallery === "proactive" ? "page" : undefined} onClick={() => openGallery("proactive")}><Lightbulb size={19} aria-hidden="true" /></Button>}
            <Button type="button" variant="ghost" size="icon" className="aria-pressed:bg-accent aria-pressed:text-accent-foreground" title="Teams" aria-label="Teams" onClick={() => setShowTeams(true)}><UsersRound size={19} /></Button>
            <Button type="button" variant="ghost" size="icon" className="aria-pressed:bg-accent aria-pressed:text-accent-foreground" title="Account usage" aria-label="Account usage" onClick={() => setShowOverallUsage(true)}><BarChart3 size={19} /></Button>
            {canCreate && <Button type="button" variant="ghost" size="icon"
              className="aria-pressed:bg-accent aria-pressed:text-accent-foreground"
              aria-label="Create bot"
              onClick={() => {
                createOperation.current = crypto.randomUUID();
                setCreating(true);
              }}
            >
              <Plus size={21} />
            </Button>}
            </div>
          </div>
          <SidebarFilters search={search} onSearch={setSearch} searchRef={searchRef} onFocusResults={() => {
            const list = screenRef.current?.querySelector<HTMLElement>('.bots-list');
            if (client.owner !== owner || !list || !botKeyboardAvailable(list)) return false;
            list.focus({ preventScroll: true }); return true;
          }} />
          <BotSidebarList owner={owner} search={search} bots={filtered} snapshot={snapshot} selected={selected} select={select} navigate={navigateBot} focusIntent={sidebarFocus}
            empty={search ? "No matching bots." : "Your bots will appear here."} />
          {!search.trim() && <ArchivedBots owner={owner} bots={archivedBots} snapshot={snapshot} selected={selected} select={select} />}
          <div className="bots-machine">
            <span className={`bots-status-dot ${online ? "online" : ""}`} />
            <span>
              {online
                ? "Connected"
                : client.error
                  ? client.error
                  : "Connecting…"}
            </span>
            <Button variant="ghost" size="icon"
              className="bots-icon-button"
              aria-label="Reconnect"
              onClick={() => {
                client.stopped = false;
                client.socket?.close();
                if (!client.socket) void client.connect();
              }}
            >
              <RefreshCw size={14} />
            </Button>
          </div>
        </aside>
        {gallery === "proactive" ? <Suspense fallback={null}><ProactiveSettingsPage key={`${owner}:proactive`} owner={owner} online={online} bots={bots} onClose={closeGallery} /></Suspense>
          : gallery ? <ArtifactGallery key={`${owner}:${gallery}:${gallery === "attachments" ? bot?.id : "all"}`} owner={owner} online={online} bots={bots} bot={gallery === "attachments" ? bot : undefined} onClose={closeGallery} /> : <section className="bots-conversation">
          <header className="bots-conversation-heading">
            <Button variant="ghost" size="icon"
              className="bots-icon-button bots-back"
              aria-label="Back to bots"
              onClick={() => select(null)}
            >
              <ArrowLeft size={20} />
            </Button>
            {bot ? (
              <>
                <Avatar bot={bot} small />
                <div className="bots-header-title">
                  <strong>{bot.name}{bot.extension&&<span className="bots-extension" title="Ctrl (or Alt) + extension switches bots; add Shift to move the composer">#{bot.extension}</span>}</strong>
                  {botStopped(bot) && <StoppedMark label />}
                </div>
                <div className="bots-header-actions">
                  {single && botProvider(bot) !== "claude" && snapshot?.capabilities?.nativeGoals === 1 && <GoalIndicator bot={bot} work={work} onOpen={() => openDetails('goals')} />}
                  {snapshot?.capabilities?.operatorCalls === 1 && !bot.archived && <Button variant="ghost" size="icon" className="bots-icon-button" aria-label={`Call ${bot.name}`} onClick={() => { setCallBotId(bot.id); setShowCall(true); }}><Phone size={18} /></Button>}
                  <Button variant="ghost" size="icon"
                    className="bots-icon-button"
                    ref={detailsToggle}
                    aria-label={docked ? (detailsOpen ? "Hide bot details" : "Show bot details") : "Bot details"}
                    aria-expanded={detailsOpen}
                    onClick={() => { if (docked) setDockOpen(!dockOpen); else setProfile((v) => !v); }}
                  >
                    <MoreHorizontal size={22} />
                  </Button>
                </div>
              </>
            ) : (
              <span>Your bots</span>
            )}
          </header>
          {(error || client.error) && (
            <div className="bots-banner" role="alert">
              <span>{error || client.error}</span>
              <Button variant="ghost" size="icon"
                aria-label="Dismiss error"
                onClick={() => {
                  setError("");
                  client.error = "";
                  client.notify();
                }}
              >
                <X size={15} />
              </Button>
            </div>
          )}
          {bot && <NativeWriterRecovery bot={bot} work={work} online={online} />}
          {bot && <CodexAuthRecovery key={JSON.stringify([owner, bot.id, bot.threadId])} owner={owner} bot={bot} online={online} supported={botProvider(bot) !== "claude" && snapshot?.capabilities?.nativeAuthRecovery === 1} setupBusy={busy}
            nativeUnavailable={work?.botId === bot.id && work.threadId === bot.threadId && work.state === 'unconfirmed' && ['native-sign-in','native-system-error'].includes(work.recovery?.kind ?? '')}
            onRetrySetup={() => void action(() => client.rpc("bots.recover", bot.id))}
            onReturn={() => { screenRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus({preventScroll:true}); }} />}
          {!bot ? (
            <div className="bots-empty">
              <div className="bots-empty-icon">
                <BotIcon size={34} strokeWidth={1.4} />
              </div>
              <h2>{bots.length ? "Choose a bot" : "Create your first bot"}</h2>
              <p>{bots.length ? "Select a conversation to continue." : "Give your bot a name and a purpose."}</p>
              {canCreate && <Button
                className="bots-primary"
                onClick={() => {
                  createOperation.current = crypto.randomUUID();
                  setCreating(true);
                }}
              >
                <Plus size={17} />
                Create a bot
              </Button>}
            </div>
          ) : (
            <>
              <FollowupComposerProvider key={JSON.stringify([owner,bot.id,bot.threadId])} owner={owner} botId={bot.id} threadId={bot.threadId} composer={composer ?? null} disabled={!online || Boolean(checkoutLocked) || Boolean(pending.length) || bot.archived} focus={() => screenRef.current?.querySelector<HTMLTextAreaElement>(".bots-composer textarea")?.focus({preventScroll:true})}>
              <BotConversation editPending={!!composer?.blastEdit} onEditBlast={composer?.ready ? async value => {
                const threadId=bot.threadId;
                const current=()=>client.owner===owner && selectedRef.current===bot.id && client.snapshot?.bots.find(b=>b.id===bot.id)?.threadId===threadId && botComposers.peek(owner,bot.id)===composer;
                if(!threadId || value.threadId!==threadId || client.snapshot?.capabilities?.burstEdit!==1 || !current())throw Error('Reconnect to the original conversation before editing the blast.');
                const batches=(value.batches??(value.burst?[value.burst]:[])).filter(b=>['pending','preparing','paused'].includes(b.state));
                if(!composer.blastEdit && (value.batches??[]).some(b=>b.state==='editing'))throw Error('This blast is reserved in its original browser draft. Return there to recover Edit.');
                await composer.editBlast({threadId,controlRevision:value.controlRevision??0,batches:batches.map(b=>({id:b.id,revision:b.revision??0}))},current);
                if(current())screenRef.current?.querySelector<HTMLTextAreaElement>('.bots-composer textarea')?.focus({preventScroll:true});
              } : undefined} key={scope} owner={owner} bot={bot} online={online} onOpenActivity={openActivity} onOpenCall={openCalls} draft={draft} submission={composer?.operation} burstsEnabled={burstSupported && !bot.archived} onReply={snapshot?.capabilities?.messageReplies === 1 && composer?.ready && !checkoutLocked && !sending ? reply => composer.setReply(reply) : undefined} burstSubmitting={composer?.operation?.method === "bursts.submit"}>


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
                <div className="bots-conversation-presence"><Avatar bot={bot} small /><Button variant="ghost" size="sm" type="button" onClick={() => openDetails("next")} aria-label="Open work details" title={online ? workLabel(work, bot) ?? humanStatus(bot, online) : "Offline"}>{online ? workLabel(work, bot) ?? humanStatus(bot, online) : "Offline"}</Button><ActiveTurnElapsed owner={owner} bot={bot} work={work} online={online}/></div>
              </BotConversation>
              </FollowupComposerProvider>
              {!bot.archived && (
                <>
                  <div className="bots-composer-support">
                    <PromptQueue key={`queue:${scope}`} owner={owner} bot={bot} items={promptQueue} online={online}
                      canEdit={Boolean(composer?.ready && !sending)} onEdit={editQueued} refresh={refreshQueues}
                      supported={queueListsSupported} relativeMoves={snapshot?.capabilities?.queueRelativeMoves===1} lists={queueLists.lists} onOpenLists={queueListsSupported ? () => openDetails("queues") : undefined} />
                    {snapshot && <ComposerSettings key={`settings:${scope}`} bot={bot} snapshot={snapshot} online={online} context={contextUsage && <ContextMeter meter={contextUsage} onOpen={() => openDetails("settings")}/>} />}
                  {(lanes || single) && <MainStopRecovery owner={owner} botId={bot.id} online={online} />}
                  <ComposerStatus composer={composer} error={composerError} />
                  {transferError&&<p className="bots-error" role="alert">{transferError}</p>}
                  {composer?.draft.reply && <ReplyQuote key={composer.draft.reply.id} reply={composer.draft.reply} foreign={composer.draft.reply.botId !== bot.id || composer.draft.reply.threadId !== bot.threadId} onClear={checkoutLocked ? undefined : () => composer.setReply()} />}
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
                    <div className="bots-composer-actions">
                    <Button variant="ghost" size="icon"
                      type="button"
                      className="bots-icon-button"
                      aria-label="Attach file"
                      disabled={!composer?.ready || checkoutLocked}
                      onClick={() => fileRef.current?.click()}
                    >
                      <Paperclip size={20} />
                    </Button>
                    {(
                      <>
                      <Button variant="ghost" size="icon" type="button" className="bots-icon-button" title="Copy composer (text and attachments)" aria-label="Copy composer"
                        disabled={!composer?.ready||sending||transferBusy||(!draft&&!uploads.length&&!composer?.draft.reply)} onClick={()=>void copyComposer()}><Copy size={19}/></Button>
                      <Button variant="ghost" size="icon" type="button" className="bots-icon-button" title="Paste copied composer" aria-label="Paste composer"
                        disabled={!composer?.ready||sending||transferBusy||!botComposers.clipboard(owner)} onClick={()=>void pasteComposer()}><ClipboardPaste size={19}/></Button>
                      <Button variant="ghost" size="icon" type="button" className="bots-icon-button bots-queue-icon"
                        title="Queue next (Ctrl+Enter)"
                        aria-label="Queue next"
                        aria-keyshortcuts="Control+Enter"
                        disabled={!online || !canSend || queueDestination.busy ||
                          (!draft.trim() && !uploads.length)}
                        onClick={queueMessage}>
                        <ListPlus size={20} aria-hidden="true" />
                      </Button>
                      </>
                    )}
                    {(bot.activeTurnId || !lanes && Boolean(bot.workerTasks?.active)) &&
                      Boolean(draft || uploads.length) && (lanes || single ? <MainStopButton owner={owner} botId={bot.id} botName={bot.name} online={online} className="bots-icon-button" /> :
                        <LegacyStopButton botName={bot.name} online={online} className="bots-icon-button" stop={() => void action(() => client.rpc("turn.interrupt", bot.id))} />
                      )}
                    {((bot.activeTurnId || !lanes && Boolean(bot.workerTasks?.active)) &&
                    !draft &&
                    !uploads.length ? (lanes || single ? <MainStopButton owner={owner} botId={bot.id} botName={bot.name} online={online} className="bots-send" /> :
                      <LegacyStopButton botName={bot.name} online={online} className="bots-send" stop={() => void action(() => client.rpc("turn.interrupt", bot.id))} />
                    ) : (
                      <Button variant="ghost" size="icon"
                        className="bots-send"
                        aria-label={
                          bot.activeTurnId ? "Send follow-up" : "Send message"
                        }
                        disabled={
                          !online ||
                          !canSend ||
                          queueDestination.busy ||
                          (!draft.trim() && !uploads.length)
                        }
                      >
                        {sending ? (
                          <LoaderCircle className="bots-spin" size={18} />
                        ) : (
                          <ArrowUp size={20} />
                        )}
                      </Button>
                    ))}
                    </div>
                  </form>
                </>
              )}
              {queueDestination.dialog}
              {queueDestination.checking && <p className="bots-queue-picker-note" role="status">Checking the active queue…</p>}
              {queueDestination.error && !queueDestination.busy && <p className="bots-lists-error" role="alert">{queueDestination.error}</p>}
              {bot.archived && (
                <div className="bots-archived-banner">
                  This bot is archived.
                  <Button variant="ghost" size="sm"
                    className="bots-primary"
                    disabled={!online || busy}
                    onClick={() =>
                      void action(() => client.rpc("bots.restore", bot.id))
                    }
                  >
                    Restore bot
                  </Button>
                </div>
              )}
            </>
          )}
        </section>}
        {bot && !gallery && <Activity mode={detailsOpen && desktopScope !== scope ? "visible" : "hidden"}>
          <BotDetailsPanel key={scope} bot={bot} section={detailsSection} onSection={setDetailsSection} onClose={closeProfile} docked={docked} returnFocus={returnDetailsFocus}>
            {{
              navigation: <ChapterNavigation key={`chapters:${scope}:${bot.threadId ?? ""}`} owner={owner} bot={bot} online={online} onJumped={docked ? undefined : closeProfile} />,
              next: <>
                <h3>Up next</h3><p className="bots-details-lead">Scheduled and queued work.</p>
                {single && <WorkOverview owner={owner} bot={bot} work={work} online={online} />}
                {!single && !promptQueue.length && <div className="bots-details-empty"><ListOrdered size={27} strokeWidth={1.5} /><h3>A little breathing room</h3><p>Nothing is queued. Use Ctrl+Enter to save a message for the next turn.</p></div>}
                {single && <AutomaticInbox owner={owner} bot={bot} work={work} online={online} />}
              </>,
              goals: <NativeGoalPanel key={`goal:${owner}:${bot.id}:${bot.threadId}`} owner={owner} bot={bot} work={work} snapshot={snapshot} online={online} />,
              team: <><h3>Team</h3>{teamsSupported ? <Suspense fallback={null}><TeamAssignment key={`team:${scope}`} owner={owner} bot={bot} teams={teams} online={online} onManage={() => setShowTeams(true)} /></Suspense> : <p className="bots-details-lead">Team editing is unavailable on the current service.</p>}</>,
              queues: queueListsSupported ? <QueueLists key={`lists:${scope}`} owner={owner} bot={bot} lists={queueLists.lists} defaultItems={promptQueue} online={online} refreshLists={queueLists.refresh} refreshDefault={refreshDefaultQueue} onEdit={editQueued} /> : <p className="bots-details-lead">Queue lists will be available when the bot service update finishes.</p>,
              schedules: <>
                <Suspense fallback={null}><ScheduleList bot={bot} schedules={schedules} online={online} busy={busy} onEdit={schedule => setEditingSchedule({ schedule, scope, botId: bot.id, owner })} action={action} /></Suspense>
                {snapshot?.capabilities?.scheduleDecisions === 1 && <RunDecisions owner={owner} botId={bot.id} online={online} />}
              </>,
              files: <><h3>Files</h3><p className="bots-details-lead">Attachments and returned work, together. Open a preview, find a file, or download the original.</p><BotAttachmentsEntry bot={bot} owner={owner} online={online} onOpen={() => openGallery("attachments")} /></>,
              desktop: <><h3>Desktop</h3>{snapshot?.capabilities?.botDesktops === 1 ? <>
                <p className="bots-details-lead">Open the preview to use the fullscreen controller.</p>
                {/* Mount only in the open Desktop tab; no background captures
                    from the bot list, other tabs, or behind the controller. */}
                {detailsOpen && detailsSection === "desktop" && desktopScope !== scope && <Suspense fallback={null}><BotDesktopCard key={`desktop:${scope}`} bot={bot} owner={owner} online={online} onOpen={() => setDesktopScope(scope)} /></Suspense>}
              </> : <p className="bots-details-lead">Desktop is unavailable on this service.</p>}</>,
              calls: detailsOpen && detailsSection === "calls" && snapshot?.capabilities?.operatorCalls === 1 ? <OperatorCallHistory key={`calls:${scope}`} owner={owner} botId={bot.id} online={online} /> : <p className="bots-details-lead">Named-bot voice calling is unavailable on this service.</p>,
              history: <>{lanes && <details data-history-key="legacy-controls" className="bots-legacy-controls"><summary>Earlier work · recovery and controls</summary><BotWorkControls owner={owner} bot={bot} runs={recentRuns} online={online} onOpen={openActivity} /></details>}<Suspense fallback={null}><RunHistory key={`${scope}:${activityTarget?.runId ?? ""}:${activityTarget?.turnId ?? ""}`} embedded bot={bot} schedules={schedules} recentRuns={recentRuns} initialTarget={activityTarget} attachments={[]} online={online} onClose={closeProfile} download={id => void download(id)} /></Suspense></>,
              settings: <div className="bots-details-settings">
                <ExecutionAccess key={`access:${scope}`} owner={owner} botId={bot.id} online={online}/>
                {snapshot?.capabilities?.proactiveInitiative === 1 && <Suspense fallback={null}><InitiativeSettings key={`initiative:${scope}`} owner={owner} botId={bot.id} botName={bot.name} online={online} onManage={() => openGallery("proactive")} /></Suspense>}
                <form className="grid gap-3" onSubmit={event => { event.preventDefault(); const input = new FormData(event.currentTarget); void action(() => client.rpc("bots.update", bot.id, { name: String(input.get("name")) })); }}>
                  <label>Name<Input name="name" defaultValue={bot.name} key={bot.id + bot.name} maxLength={80} required /></label><Button className="justify-self-start" type="submit" disabled={!online || busy}>Save name</Button>
                </form>
                <SavedDrafts owner={owner} bots={bots} composer={composer}/><p className="bots-profile-hint">{bot.purpose}</p><p className="bots-profile-hint">Ask {bot.name} to change its personality, instructions, or memory.</p>
                {snapshot?.capabilities?.singleThreadExecution === 1 && <Suspense fallback={null}><PersonalitySettings key={scope} bot={bot} snapshot={snapshot} online={online} /></Suspense>}
                {snapshot?.capabilities?.botAdministration === 1 && bot.executionMode === "single-thread" && <Suspense fallback={null}><BotAdminApprovals key={`admin:${scope}`} owner={owner} botId={bot.id} botName={bot.name} online={online} /></Suspense>}
                {!bot.archived && <ContextCompactionSettings key={`compaction:${scope}`} bot={bot} online={online} busy={busy} supported={snapshot?.capabilities?.nativeCompaction === 1} action={action} />}
                <Button asChild variant="link" className="px-0"><a href="/settings">Notification settings</a></Button>
                <div className="bots-profile-actions flex flex-wrap gap-2">
                  {bot.archived && snapshot?.capabilities?.botDesktops === 1 && <Button variant="outline" type="button" disabled={!online || busy} onClick={() => { if (window.confirm(`Delete ${bot.name}? Its desktop data will be removed. Its workspace files and archived conversation are retained.`)) void action(() => client.rpc("bots.delete", bot.id)); }}>Delete bot</Button>}
                  <Button variant="outline" type="button" disabled={!online || busy || Boolean(bot.activeTurnId)} onClick={() => void action(() => client.rpc(bot.archived ? "bots.restore" : "bots.archive", bot.id))}><Archive size={16} />{bot.archived ? "Restore bot" : "Archive bot"}</Button>
                </div>
              </div>,
            }}
          </BotDetailsPanel>
        </Activity>}
      </main>
      {showTeams && (teamsSupported ? <Suspense fallback={null}><TeamsManager key={owner} owner={owner} teams={teams} bots={bots} online={online} onClose={() => setShowTeams(false)} /></Suspense> : <ControlledDialog title="Teams" onClose={() => setShowTeams(false)}><p className="text-sm text-muted-foreground">Teams are unavailable on this service.</p><Button className="justify-self-end" onClick={() => setShowTeams(false)}>Close</Button></ControlledDialog>)}
      {showOverallUsage && <ControlledDialog title="Account usage" className="max-w-3xl" onClose={() => setShowOverallUsage(false)}><Suspense fallback={null}><UsagePanel online={online} /></Suspense></ControlledDialog>}
      {showCall && <OperatorCallDialog bot={bots.find(value => value.id === callBotId) ?? null} bots={bots.filter(value => !value.archived && value.executionMode === "single-thread")} onClose={() => setShowCall(false)} />}
      {bot && desktopScope === scope && !bot.archived && <Suspense fallback={null}><BotDesktopDialog key={scope} bot={bot} owner={owner} onClose={() => setDesktopScope(null)} /></Suspense>}
      {creating && <Suspense fallback={null}><CreateBotDialog online={online} busy={busy} error={error} claudeAvailable={snapshot?.capabilities?.claudeBots === 1} onClose={() => setCreating(false)}
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
                    // Codex requests keep their original shape.
                    ...(data.get("provider") === "claude" ? { provider: "claude" as const } : {}),
                  },
                  createOperation.current,
                );
                setCreating(false);
                select(created.id);
                await client.refresh();
              });
            }} /></Suspense>}
      {editingSchedule && editingSchedule.scope === scope && bot && (
        <Suspense fallback={null}><ScheduleEditor
          key={`${editingSchedule.scope}:${editingSchedule.schedule === "new" ? "new" : editingSchedule.schedule.id}`}
          schedule={editingSchedule.schedule}
          online={online}
          timeZone={client.timeZone}
          close={() => setEditingSchedule(null)}
          save={async (value) => {
            if (client.owner !== editingSchedule.owner || selectedRef.current !== editingSchedule.botId || !client.online) throw new Error("Reconnect to the original bot to save this schedule.");
            await client.rpc("schedules.save", editingSchedule.botId, value);
            setEditingSchedule(current => current === editingSchedule ? null : current);
            await client.refresh();
          }}
        /></Suspense>
      )}
    </div></TaskRequestWorkspace>
    {announcementOwner && announcementOwner === owner && <Suspense fallback={null}><AnnouncementDialog key={owner} owner={owner} onClose={() => setAnnouncementOwner(null)} /></Suspense>}</>
  );
}
