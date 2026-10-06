"use client";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Copy, MessageCircle, RefreshCw } from "lucide-react";
import type { Bot, BotEvent, BotPeerExchangeMeta, BotPeerRoot, BotPeerRequest } from "../../lib/bots-types";
import { botsClient as client } from "./client";
import { PeerTimelineStore } from "./peer-timeline-store";
import { BotAvatar } from "./bot-avatar";
import { BotMessage } from "./message";
import { MessageTime } from "./message-time";
import { ReturnedArtifact } from "./returned-artifact";
import { useRunAction } from "./run-action";
import "./peer-timeline.css";

export function usePeerTimeline(owner: string, botId: string, online: boolean, supported: boolean) {
  const store = useMemo(() => new PeerTimelineStore(owner, botId, client, supported), [owner, botId, supported]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => { if (online && supported) void store.refresh(true); }, [store, online, supported]);
  return { store, state, rows: useMemo(() => supported ? store.rows(state) : [], [store, state, supported]) };
}
export function PeerPaging({ store, online, capture }: { store: PeerTimelineStore; online: boolean; capture: () => void }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const navigate = (direction: "older" | "newer" | "recent") => { capture(); void store.navigate(direction); };
  return <div className="bots-peer-paging" aria-label="Bot-message pages">
    {store.canOlder() && <button type="button" disabled={!online || state.busy} onClick={() => navigate("older")}>Earlier bot messages</button>}
    {store.canNewer() && <><span>More bot messages remain between these pages.</span><button type="button" disabled={!online || state.busy} onClick={() => navigate("newer")}>Next bot messages</button><button type="button" disabled={!online || state.busy} onClick={() => navigate("recent")}>Recent bot messages</button></>}
    {(state.changed || state.error) && <button type="button" disabled={!online || state.busy} onClick={() => { capture(); void store.refresh(); }}><RefreshCw size={13}/>{state.pendingNewer ? "Continue reconnecting bot messages" : "Refresh bot messages"}</button>}
    {state.busy && <small role="status">Reading bot-message metadata…</small>}
    {state.error && <p role="alert" className="bots-error">{state.error}<button type="button" disabled={!online || state.busy} onClick={() => navigate("recent")}>Read recent bot messages</button></p>}
  </div>;
}
export function peerIntakeLabel(meta: BotPeerExchangeMeta, bots: Bot[], online: boolean, request: BotPeerRequest | null = null) {
  const intake = meta.intake;
  if (!intake) return meta.heldAtAcceptance ? "Received · discussion intake held" : "Received · native binding not retained";
  const bot = bots.find(b => b.id === intake.botId);
  if (online && bot && ["running", "waiting"].includes(bot.status) && bot.threadId === intake.threadId && bot.activeTurnId && bot.activeTurnId === intake.turnId && request?.executions?.some(e => e.botId === intake.botId && e.turnId === intake.turnId)) return "Working on this message";
  if (intake.terminalStatus) return `Native turn ${intake.terminalStatus}`;
  return ({ queued: "Received · waiting to start", dispatching: "Starting · awaiting confirmation", accepted: "Accepted · awaiting native confirmation", uncertain: "Delivery needs confirmation", cancelled: "Intake cancelled", failed: "Intake needs attention" })[intake.state];
}
export function PeerTimelineMessage({ owner, botId, meta, store, online, bots, showRoot = false, nativeKeys = [] }: { owner: string; botId: string; meta: BotPeerExchangeMeta; store: PeerTimelineStore; online: boolean; bots: Bot[]; showRoot?: boolean; nativeKeys?: string[] }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [open, setOpen] = useState(meta.recipientBotId === botId && meta.bodyBytes <= 16384), [copied, setCopied] = useState(false);
  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const body = store.body(meta), incoming = meta.recipientBotId === botId;
  const author = bots.find(b => b.id === meta.senderBotId), recipient = bots.find(b => b.id === meta.recipientBotId);
  const load = useCallback(async () => {
    setBusy(true); setError("");
    try { await store.loadBody(meta); }
    catch (reason) { if (client.owner === owner) setError(String(reason)); }
    finally { if (client.owner === owner) setBusy(false); }
  }, [store, meta, owner]);
  useEffect(() => {
    if (!open || body || !online || !host.current) return;
    let live = true;
    const observer = new IntersectionObserver(entries => { if (live && entries.some(e => e.isIntersecting)) { observer.disconnect(); void load(); } }, { rootMargin: "100px" });
    observer.observe(host.current); return () => { live = false; observer.disconnect(); };
  }, [load, body, online, open]);
  const copy = async () => { if (!body) return; try { await navigator.clipboard.writeText(body.exchange.text); setCopied(true); } catch { setError("Copy is unavailable. Select the text instead."); } };
  return <div className={`bots-peer-arrival ${incoming ? "is-incoming" : "is-outgoing"}`} ref={host} data-peer-exchange={meta.id}>
    {nativeKeys.map(key => <span key={key} data-history-key={key} className="bots-peer-native-alias" aria-hidden="true"/>)}
    <div className="bots-peer-bubble"><header>{author ? <BotAvatar bot={author} small decorative working={false}/> : <MessageCircle size={22} aria-hidden="true"/>}<div><strong>{author?.name ?? "Named bot"}</strong><small>{incoming ? "To this bot" : `To ${recipient?.name ?? "another bot"}`} · {meta.kind === "request" ? "Request" : meta.kind === "cancel" ? "Cancellation receipt" : "Reply"}</small></div></header>
      <p className="bots-peer-summary">{meta.summary}</p>
      {open && body ? <><BotMessage item={{ type: "agentMessage", id: meta.id, text: body.exchange.text, phase: null, delivery: null, memoryCitation: null, questions: null }} botId={botId} attachments={[]} download={() => {}}/>{body.exchange.attachmentIds.map(id => <ReturnedArtifact key={id} botId={botId} id={id}/>)}<button type="button" className="bots-peer-copy" onClick={() => void copy()}><Copy size={13}/>{copied ? "Copied" : "Copy selected text"}</button></> : <button type="button" disabled={busy || !body && !online} onClick={() => { setOpen(true); if (!body) void load(); }}>{busy ? "Reading…" : incoming ? "Read full bot message" : "Read selected contribution"}</button>}
      {open && !body && <small>{online ? "Selected message loads on approach." : "Reconnect to read the complete selected text. The receipt is saved."}</small>}
      {error && <p className="bots-error" role="alert">{error}<button type="button" disabled={!online || busy} onClick={() => void load()}>Retry original message</button></p>}
      <p className="bots-peer-intake">{incoming ? peerIntakeLabel(meta, bots, online, store.request(meta.requestId)) : "Sent contribution"}{incoming && meta.intake?.state === "queued" && meta.intake.waitReason && <small>{meta.intake.waitReason}</small>}</p>
      <small className="bots-peer-trust">Selected bot context</small>
      <MessageTime seconds={Date.parse(meta.createdAt)/1000} basis="received" inline/>
    </div>
    {showRoot && <PeerRootControls key={`${owner}:${botId}:${meta.rootId}`} owner={owner} botId={botId} rootId={meta.rootId} online={online}/>}
  </div>;
}

export function PeerRootControls({ owner, botId, rootId, online }: { owner: string; botId: string; rootId: string; online: boolean }) {
  const [root, setRoot] = useState<BotPeerRoot | null>(null), [error, setError] = useState("");
  const generation = useRef(0), alive = useRef(true);
  const action = useRunAction(owner, botId, `peer-root:${rootId}`);
  const supported = client.snapshot?.capabilities?.peerRootControls === 1;
  const accept = useCallback((next: BotPeerRoot) => {
    if (!next || next.id !== rootId || next.version !== 1 || next.ownerControls?.authority !== "owner" || next.nativeInterruption !== false || next.stopScope !== "discussion-admission" || !Number.isSafeInteger(next.revision) || !Number.isSafeInteger(next.observationSeq)) throw Error("This discussion's owner controls could not be verified.");
    setRoot(prior => !prior || next.revision > prior.revision || next.revision === prior.revision && next.observationSeq >= prior.observationSeq ? next : prior);
  }, [rootId]);
  const refresh = useCallback(async () => {
    const epoch = generation.current;
    try { const next = await client.rpc<{ root: BotPeerRoot }>("peers.root", botId, { rootId }, undefined, { owner }); if (alive.current && generation.current === epoch && client.owner === owner) { accept(next.root); setError(""); } }
    catch (reason) { if (alive.current && generation.current === epoch && client.owner === owner) setError(String(reason)); }
  }, [owner, botId, rootId, accept]);
  useEffect(() => {
    alive.current = true; const epoch = ++generation.current;
    const event = (event: BotEvent) => { if (client.owner !== owner || event.type !== "peer-root") return; const next = (event.data as { root?: BotPeerRoot }).root ?? event.data as BotPeerRoot; if (next.id === rootId) { try { accept(next); } catch { void refresh(); } } };
    if (online && supported) void Promise.resolve().then(refresh);
    client.events.add(event); return () => { alive.current = false; generation.current = epoch + 1; client.events.delete(event); };
  }, [owner, online, supported, rootId, accept, refresh]);
  // ACK may be the old original snapshot. Always read fresh root metadata after
  // settlement, including lost-ACK recovery; never use that ACK as a new grant.
  useEffect(() => { if (action.confirmation?.method === "peers.control" && online && supported) void Promise.resolve().then(refresh); }, [action.confirmation?.id, action.confirmation?.method, online, supported, refresh]);
  if (!supported) return null;
  const perform = (choice: "continue" | "stop") => { if (root) void action.perform("peers.control", { rootId, action: choice, expectedRevision: root.revision }).catch(() => {}); };
  return <section className="bots-peer-root" aria-label="Discussion allowance">
    {root && <><strong>{root.state === "active" ? "Discussion active" : root.state === "stopped" ? "Discussion stopped" : "Discussion paused"}</strong>
      {root.reasonText && <p>{root.reasonText}</p>}
      <small>{root.allowance.contributions} / {root.limits.contributions} contributions · {Math.ceil(root.allowance.selectedBytes/1024)} / {Math.ceil(root.limits.selectedBytes/1024)} KiB selected text</small>
      {root.heldOperations > 0 && <p>{root.heldOperations} original {root.heldOperations === 1 ? "operation remains" : "operations remain"} held{root.state === "active" ? " for deliberate same-ID retry. The active discussion does not replay them." : ". Continue permits deliberate retry; it does not replay them."}</p>}
      <p>Stop discussion holds new discussion intake. Already accepted or running work continues; each bot’s Stop and goals are separate.</p>
      {!action.intent && <div>{root.state !== "active" && root.ownerControls.canContinue && <button type="button" disabled={!online || action.busy || !action.ready} onClick={() => perform("continue")}>Continue discussion</button>}{root.ownerControls.canStop && root.state !== "stopped" && <button type="button" disabled={!online || action.busy || !action.ready} onClick={() => perform("stop")}>Stop discussion</button>}</div>}
    </>}
    {(action.intent || action.error) && <p role="status">{action.error || "Confirming the saved discussion action…"}<button type="button" disabled={!online || action.busy} onClick={() => void action.retry().catch(() => {})}>Check saved action</button></p>}
    {error && <p role="alert">{error}<button type="button" disabled={!online} onClick={() => void refresh()}>Read current discussion</button></p>}
  </section>;
}
