"use client";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { BotArtifactPage, BotAttachment } from "../../lib/bots-types";
import { botsClient } from "./client";
import { ArtifactViewer } from "./artifact-viewer";
import { indexArtifacts, type GalleryItem } from "./artifact-source";
import { visualizationReferences } from "../../lib/bot-visualization-reference.mjs";
import "./document-viewer.css";

export function ReturnedVisualization(props: { botId: string; reference: string; attachments: BotAttachment[] }) {
  const owner = useSyncExternalStore(botsClient.subscribe, () => botsClient.owner, () => "");
  return <ScopedVisualization key={`${owner}:${props.botId}:${props.reference}`} {...props} owner={owner} />;
}
function ScopedVisualization({ botId, reference, attachments, owner }: { botId: string; reference: string; attachments: BotAttachment[]; owner: string }) {
  let path = "";
  try { const decoded = decodeURIComponent(reference); path = visualizationReferences(`\uE200visualize\uE202${JSON.stringify({ path: decoded })}\uE201`)[0]?.path ?? ""; } catch { /* invalid reference */ }
  const online = useSyncExternalStore(botsClient.subscribe, () => botsClient.online, () => false);
  const [item, setItem] = useState<GalleryItem | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [canIndex, setCanIndex] = useState(false), [indexCursor, setIndexCursor] = useState<string | null>(null);
  const [indexComplete, setIndexComplete] = useState(false);
  const [searchCursor, setSearchCursor] = useState<string | null>(null);
  const resolved = useRef<GalleryItem | null>(null);
  const alive = useRef(true); useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const close = useCallback(() => setItem(null), []);
  const current = () => alive.current && botsClient.owner === owner;
  const matches = (file: BotAttachment) => file.botId === botId && file.ready &&
    (file.artifact || file.direction === "output") && file.visualizationReferences?.includes(path);
  async function lookup(cursor: string | null = null) {
    if (resolved.current) return resolved.current;
    const known = attachments.find(matches);
    if (known) return { ...known, botName: botsClient.snapshot?.bots.find(bot => bot.id === botId)?.name ?? "Bot", createdAt: known.createdAt ?? null };
    const page = await botsClient.rpc<BotArtifactPage>("artifacts.list", botId, { search: path.split("/").at(-1)?.slice(0, 160), type: "document", direction: "output", limit: 36, cursor }, undefined, { owner });
    if (!current()) return null;
    setSearchCursor(page.nextCursor);
    const file = page.items.find(matches);
    return file ? { ...file, version: file.preview.version } : null;
  }
  async function open(index = false) {
    if (busy || !online || !path) return;
    setBusy(true); setError("");
    try {
      if (index) {
        // Explicit, one bounded existing index page; never a render-driven scan.
        const result = await indexArtifacts(botId, indexCursor, owner);
        if (!current()) return;
        setIndexCursor(result.nextCursor);
        setIndexComplete(!result.nextCursor && !result.failures.length);
        if (result.failures.length) setError("Some shared outputs could not be indexed. Their original files were retained.");
      }
      const file = await lookup(index ? null : searchCursor);
      if (!current()) return;
      if (file) { resolved.current = file; setItem(file); setCanIndex(false); setSearchCursor(null); }
      else { setCanIndex(true); setError("This visualization is not registered in the loaded files. Index shared outputs, or ask the bot to publish the original HTML as an attachment."); }
    } catch (error) { if (current()) setError(error instanceof Error ? error.message : "Visualization could not open. Try again."); }
    finally { if (current()) setBusy(false); }
  }
  return <span className="bots-visualization-reference">
    <button disabled={!path || !online || busy} onClick={() => void open()}>{busy ? "Opening visualization…" : `Open visualization · ${path.split("/").at(-1) || "unsupported reference"}`}</button>
    {!online && <small>Connect to open this visualization.</small>}
    {error && <small role="alert">{error}</small>}
    {canIndex && !indexComplete && <button disabled={!online || busy} onClick={() => void open(true)}>{indexCursor ? "Continue indexing shared outputs" : "Index shared outputs"}</button>}
    {searchCursor && <button disabled={!online || busy} onClick={() => void open()}>Check next file page</button>}
    {item && createPortal(<ArtifactViewer item={item} owner={owner} online={online} onClose={close} />, document.body)}
  </span>;
}
