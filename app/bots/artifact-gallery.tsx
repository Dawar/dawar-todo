"use client";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight, Search, X, Images, FolderOpen, CloudOff, RefreshCw, Download, Paperclip } from "lucide-react";
import type { Bot } from "../../lib/bots-types";
import { botsClient } from "./client";
import { ArtifactCard } from "./artifact-card";
import { ArtifactViewer } from "./artifact-viewer";
import { galleryPage, galleryKey, readArtifactOriginal, saveArtifact, type GalleryItem, type GalleryQuery, type GalleryPage, type GalleryType } from "./artifact-source";
import { readArtifactCache } from "./artifact-cache";
import { useArtifactDiscovery } from "./artifact-discovery";
import "./artifact-gallery.css";

function useGalleryPage(query: GalleryQuery, owner: string, online: boolean) {
  const key = JSON.stringify([owner, query]), storageKey = galleryKey(query);
  const [state, setState] = useState<{ key: string; page: GalleryPage | null; loading: boolean; error: string; cached: boolean }>({ key: "", page: null, loading: true, error: "", cached: false });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    void (async () => {
      const cached = await readArtifactCache<GalleryPage>(owner, "page", storageKey);
      if (!active) return;
      setState({ key, page: cached, loading: online, error: "", cached: Boolean(cached) });
      if (!online) return;
      try {
        const page = await galleryPage(query, owner, revision > 0);
        if (active && owner === botsClient.owner) setState({ key, page, loading: false, error: "", cached: false });
      } catch (e) { if (active) setState({ key, page: cached, loading: false, error: e instanceof Error ? e.message : "Your files could not load.", cached: Boolean(cached) }); }
    })();
    return () => { active = false; };
    // Query key contains every filter and cursor; never reload on unrelated renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, owner, online, revision]);
  return { ...(state.key === key ? state : { key, page: null, loading: true, error: "", cached: false }), retry: useCallback(() => setRevision((value) => value + 1), []) };
}
const monthName = (date: string | null) => {
  const value = new Date(date ?? ""); return Number.isFinite(value.getTime()) ? value.toLocaleDateString(undefined, { month: "long", year: "numeric" }) : "Date unknown";
};

type GalleryPosition = { search: string; type: GalleryType; botFilter: string; cursors: (string | null)[]; scroll: number; cloudCatalog?:boolean };
// Retain navigation, never original file bytes. Owner key prevents cross-account restoration.
const positions = new Map<string, GalleryPosition>();
const BotChoices = memo(function BotChoices({ bots }: { bots: Bot[] }) {
  return bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>);
}, (before, after) => before.bots.length === after.bots.length && before.bots.every((bot, i) => bot.id === after.bots[i].id && bot.name === after.bots[i].name));
export function ArtifactGallery({ bot, bots, owner, online:bridgeOnline, onClose }: { bot?: Bot; bots: Bot[]; owner: string; online: boolean; onClose: () => void }) {
  const cloudOnline=useSyncExternalStore(botsClient.subscribe,()=>botsClient.owner===owner && botsClient.storageCatalogAvailable,()=>false);
  const online=bridgeOnline || cloudOnline;
  const positionKey = JSON.stringify([owner, bot?.id ?? "global"]);
  const [initial] = useState(() => { const position=positions.get(positionKey); return position && Boolean(position.cloudCatalog)!==cloudOnline ? {...position,cursors:[null],scroll:0} : position; }), saved = useRef(initial);
  const [search, setSearch] = useState(initial?.search ?? ""), [settledSearch, setSettledSearch] = useState(initial?.search.trim() ?? ""), [type, setType] = useState<GalleryType>(initial?.type ?? "all"), [botFilter, setBotFilter] = useState(initial?.botFilter ?? "");
  const [cursors, setCursors] = useState<(string | null)[]>(initial?.cursors ?? [null]);
  const [selected, setSelected] = useState<GalleryItem | null>(null), [download, setDownload] = useState(""), [downloadError, setDownloadError] = useState("");
  const scroll = useRef<HTMLDivElement>(null), heading = useRef<HTMLHeadingElement>(null), abort = useRef<AbortController | null>(null);
  const query = useMemo(() => ({ botId: bot?.id || botFilter || undefined, search: settledSearch, type, cursor: cursors.at(-1) ?? null }), [bot?.id, botFilter, settledSearch, type, cursors]);
  const state = useGalleryPage(query, owner, online);
  const [updated, setUpdated] = useState(false), retry = state.retry;
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const catalogMode=useRef(cloudOnline);
  useEffect(()=>{
    if(catalogMode.current===cloudOnline) return;
    catalogMode.current=cloudOnline;setCursors([null]);retry();
    // Catalog cursors are scoped to their backend; retain the user's filters.
  },[cloudOnline,retry]);
  const refresh = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = undefined;
      if (query.cursor) setUpdated(true); else retry();
    }, 350);
  }, [query.cursor, retry]);
  useEffect(() => () => { clearTimeout(refreshTimer.current); refreshTimer.current = undefined; }, [refresh]);
  const discovery = useArtifactDiscovery(owner, query.botId ? [query.botId] : bots.map((b) => b.id), bridgeOnline, refresh);
  useEffect(() => { const timer = setTimeout(() => { if (search.trim() !== settledSearch) { setSettledSearch(search.trim()); setCursors([null]); scroll.current?.scrollTo(0, 0); } }, 250); return () => clearTimeout(timer); }, [search, settledSearch]);
  const navigation = useRef<GalleryPosition>({ search, type, botFilter, cursors, scroll: 0,cloudCatalog:cloudOnline });
  useLayoutEffect(() => {
    navigation.current = { search, type, botFilter, cursors, scroll: scroll.current?.scrollTop ?? 0,cloudCatalog:cloudOnline };
  }, [search, type, botFilter, cursors,cloudOnline]);
  useLayoutEffect(() => {
    if (state.page && saved.current) { scroll.current?.scrollTo(0, saved.current.scroll); saved.current = undefined; }
  }, [state.page]);
  useLayoutEffect(() => () => {
    positions.delete(positionKey); positions.set(positionKey, navigation.current);
    while (positions.size > 8) positions.delete(positions.keys().next().value!);
  }, [positionKey]);
  useEffect(() => {
    const listener = (event: { type: string; botId?: string | null }) => {
      if (event.type !== "attachment" || query.botId && event.botId !== query.botId) return;
      refresh();
    };
    botsClient.events.add(listener);
    return () => { botsClient.events.delete(listener); };
  }, [query.botId, refresh]);
  useEffect(() => { heading.current?.focus(); return () => abort.current?.abort(); }, []);
  const groups = useMemo(() => {
    const months = new Map<string, GalleryItem[]>();
    for (const item of state.page?.items ?? []) { const month = monthName(item.createdAt); months.set(month, [...(months.get(month) ?? []), item]); }
    return [...months];
  }, [state.page]);
  const open = useCallback((item: GalleryItem) => setSelected(item), []);
  const closePreview = useCallback(() => setSelected(null), []);
  const save = useCallback((item: GalleryItem) => {
    abort.current?.abort(); const controller = new AbortController(); abort.current = controller;
    setDownload(item.name); setDownloadError("");
    void readArtifactOriginal(item, owner, controller.signal).then((blob) => saveArtifact(blob, item.name)).catch((e) => {
      if (!controller.signal.aborted) setDownloadError(e instanceof Error ? e.message : "The download could not finish.");
    }).finally(() => { if (!controller.signal.aborted) setDownload(""); });
  }, [owner]);
  function filter(next: GalleryType) { setType(next); setCursors([null]); scroll.current?.scrollTo(0, 0); }
  function page(next: string | null, backwards = false) { setCursors((old) => backwards ? old.slice(0, -1) : [...old, next]); scroll.current?.scrollTo(0, 0); heading.current?.focus(); }
  const hasFiles = Boolean(state.page?.items.length), filtered = Boolean(search || type !== "all" || botFilter);
  const paged = cursors.length > 1 || Boolean(state.page?.nextCursor);
  const fileCount = (count: number) => `${count.toLocaleString()} ${count === 1 ? "file" : "files"}`;
  const countLabel = !state.page ? "" : state.page.total != null ? fileCount(state.page.total)
    : cursors.length > 1 ? `Page ${cursors.length} · ${fileCount(state.page.items.length)}`
      : state.page.nextCursor ? `${state.page.items.length.toLocaleString()}+ files` : fileCount(state.page.items.length);
  return <section className="bots-gallery" aria-label={bot ? "Bot attachments" : "Artifacts"}>
    <header className="bots-gallery-heading"><button className="bots-icon-button" onClick={onClose} aria-label={bot ? "Back to bot settings" : "Back to bots"}><ArrowLeft size={21} /></button><div><span>{bot ? bot.name : "Your workspace"}</span><h1 tabIndex={-1} ref={heading}>{bot ? "Attachments" : "Artifacts"}</h1></div><span className="bots-gallery-total">{countLabel}</span></header>
    <div className="bots-gallery-tools">
      <label className="bots-gallery-search"><Search size={18} aria-hidden="true" /><input aria-label="Search files" maxLength={160} placeholder="Search files…" value={search} onChange={(event) => setSearch(event.target.value)} />{search && <button aria-label="Clear file search" onClick={() => setSearch("")}><X size={16} /></button>}</label>
      {!bot && <label className="bots-gallery-bot-filter"><span>From</span><select aria-label="Filter by bot" value={botFilter} onChange={(event) => { setBotFilter(event.target.value); setCursors([null]); scroll.current?.scrollTo(0, 0); }}><option value="">All bots</option><BotChoices bots={bots} /></select></label>}
      <div className="bots-gallery-types" role="group" aria-label="File type">{([["all", "All files"], ["image", "Images"], ["pdf", "PDFs"], ["document", "Documents"]] as const).map(([key, label]) => <button key={key} aria-pressed={type === key} onClick={() => filter(key)}>{label}</button>)}</div>
    </div>
    {(!online || state.cached) && hasFiles && <div className="bots-gallery-banner"><CloudOff size={15} />{online ? "Saved files · updating…" : "Saved view. Connect to see new files and open originals."}</div>}
    {(download || downloadError) && <div className={`bots-gallery-banner ${downloadError ? "is-error" : ""}`} role="status"><Download size={16} /><span>{downloadError || `Downloading ${download}…`}</span>{download && <button onClick={() => { abort.current?.abort(); setDownload(""); }}>Cancel</button>}{downloadError && <button onClick={() => setDownloadError("")}>Dismiss</button>}</div>}
    {updated && <div className="bots-gallery-banner"><span>New files are available.</span><button onClick={() => { setCursors([null]); setUpdated(false); state.retry(); scroll.current?.scrollTo(0, 0); }}>Show latest</button></div>}
    <div className="bots-gallery-scroll" ref={scroll} onScroll={() => { navigation.current.scroll = scroll.current?.scrollTop ?? 0; }} aria-busy={state.loading && !hasFiles}>
      {state.error && <div className="bots-gallery-error" role="alert"><CloudOff size={23} /><div><strong>Files couldn’t load</strong><p>{state.error}</p><button onClick={() => { if (query.cursor) setCursors([null]); state.retry(); }} disabled={!online}><RefreshCw size={15} />{query.cursor ? "Refresh files" : "Try again"}</button></div></div>}
      {state.loading && !hasFiles ? <div className="bots-gallery-skeleton" role="status" aria-label="Loading files">{Array.from({ length: 6 }, (_, i) => <div key={i}><span /><i /><i /></div>)}</div>
        : !hasFiles && !state.error ? <div className="bots-gallery-empty">{!online ? <CloudOff size={32} strokeWidth={1.3} /> : filtered ? <Search size={32} strokeWidth={1.3} /> : <FolderOpen size={36} strokeWidth={1.3} />}<h2>{!online ? "Your files, when you reconnect" : filtered ? "No files match just yet" : bot ? "A home for your shared files" : "Good things take shape here"}</h2><p>{!online ? "This view hasn’t been saved yet. Your conversations and drafts are still available." : filtered ? "Try another name or choose a different file type." : bot ? "Images, documents and files you share with this bot will appear here." : "Images, PDFs and other files from your bots will come together in this space."}</p>{filtered && <button onClick={() => { setSearch(""); setBotFilter(""); filter("all"); }}>Clear filters</button>}</div>
          : groups.map(([month, items]) => <section className="bots-gallery-month" key={month}><h2>{month}<span>{fileCount(items.length)}{paged ? " on this page" : ""}</span></h2><div className="bots-gallery-grid">{items.map((item) => <ArtifactCard key={`${item.botId}:${item.id}`} item={item} owner={owner} online={online} attribution={!bot} onOpen={open} onDownload={save} />)}</div></section>)}
      {(discovery.more || discovery.issues || discovery.busy) && <div className="bots-gallery-discovery" role="status"><span>{discovery.busy ? "Checking earlier shared files…" : discovery.issues ? "Some earlier files need another try." : "Looking for something older?"}</span><div>{discovery.issues && <button disabled={!online || discovery.busy} onClick={discovery.retry}>Retry</button>}{discovery.more && <button disabled={!online || discovery.busy} onClick={discovery.earlier}>Find earlier files</button>}</div></div>}
      {(cursors.length > 1 || state.page?.nextCursor) && <nav className="bots-gallery-pages" aria-label="File pages"><button disabled={cursors.length === 1 || state.loading} onClick={() => page(null, true)}><ChevronLeft size={17} />Newer</button><span>Page {cursors.length}</span><button disabled={!state.page?.nextCursor || state.loading} onClick={() => page(state.page!.nextCursor)} >Older<ChevronRight size={17} /></button></nav>}
    </div>
    {selected && <ArtifactViewer key={`${owner}:${selected.id}`} item={selected} owner={owner} online={online} onClose={closePreview} />}
  </section>;
}
export function BotAttachmentsEntry({ bot, owner, online:bridgeOnline, onOpen }: { bot: Bot; owner: string; online: boolean; onOpen: () => void }) {
  const cloudOnline=useSyncExternalStore(botsClient.subscribe,()=>botsClient.owner===owner && botsClient.storageCatalogAvailable,()=>false);
  const online=bridgeOnline || cloudOnline;
  const query = useMemo(() => ({ botId: bot.id, search: "", type: "all" as const, cursor: null }), [bot.id]);
  const { page, loading } = useGalleryPage(query, owner, online);
  return <button className="bots-attachments-entry" onClick={onOpen}><span className="bots-attachments-symbol"><Paperclip size={21} /></span><span><strong>Attachments</strong><small>Images, documents & shared files</small></span><span className="bots-attachments-count">{page?.total != null ? page.total : loading ? "…" : page?.items.length ? `${page.items.length}${page.nextCursor ? "+" : ""}` : "—"}</span><ChevronRight size={18} /></button>;
}
export function ArtifactNav({ active, onOpen }: { active: boolean; onOpen: () => void }) {
  return <button className={`bots-icon-button bots-artifacts-icon ${active ? "active" : ""}`} title="Artifacts" aria-label="Artifacts" aria-current={active ? "page" : undefined} onClick={onOpen}><Images size={19} aria-hidden="true" /></button>;
}
