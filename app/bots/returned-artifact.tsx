"use client";
import { Children, useCallback, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { FileText, ArrowUpRight } from "lucide-react";
import type { BotAttachment } from "../../lib/bots-types";
import { botsClient } from "./client";
import { ArtifactThumbnail } from "./artifact-card";
import { ArtifactViewer } from "./artifact-viewer";
import { fileSize, type GalleryItem } from "./artifact-source";
import "./artifact-gallery.css";

type DeliveredAttachment = BotAttachment & { createdAt?: string | null; artifact?: boolean; direction?: "input" | "output"; provenance?: { itemId?: string; turnId?: string }; preview?: { version?: string } };
export function ReturnedArtifact({ botId, id, children, attachment }: { botId: string; id: string; children?: ReactNode; attachment?: DeliveredAttachment }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const online = useSyncExternalStore(botsClient.subscribe, () => botsClient.online, () => false), owner = botsClient.owner;
  const title = attachment?.name || Children.toArray(children).filter((value) => typeof value === "string").join("") || "Shared file";
  const mimeType = attachment?.mimeType ?? (/\.pdf$/i.test(title) ? "application/pdf" : /\.(png|jpe?g|webp|svg)$/i.test(title) ? "image/unknown" : "application/octet-stream");
  const item: GalleryItem = useMemo(() => ({ id, botId, name: title, mimeType, size: attachment?.size ?? 0, ready: true,
    createdAt: attachment?.createdAt ?? "", version: attachment?.preview?.version,
    botName: botsClient.snapshot?.bots.find((bot) => bot.id === botId)?.name ?? "Bot", direction: "output" }), [id, botId, title, mimeType, attachment]);
  return <><button className={`bots-returned-file ${mimeType.startsWith("image/") || mimeType === "application/pdf" ? "has-preview" : ""}`} onClick={() => setOpen(true)} aria-label={`Open ${title}`}>
    {mimeType.startsWith("image/") || mimeType === "application/pdf" ? <ArtifactThumbnail item={item} owner={owner} online={online} /> : <FileText size={23} strokeWidth={1.4} aria-hidden="true" />}
    <span><strong>{title}</strong><small>{mimeType === "application/pdf" ? "PDF document" : mimeType.startsWith("image/") ? "Image" : "Shared file"}{attachment && ` · ${fileSize(attachment.size)}`}</small></span><ArrowUpRight size={17} aria-hidden="true" />
  </button>{open && createPortal(<ArtifactViewer key={`${owner}:${id}`} item={item} owner={owner} online={online} onClose={close} />, document.body)}</>;
}
export function ReturnedArtifacts({ attachments, itemIds = [], turnId, botId, linked }: { attachments: BotAttachment[]; itemIds?: string[]; turnId?: string; botId: string; linked: Set<string> }) {
  const delivered = (attachments as DeliveredAttachment[]).filter((file) => !linked.has(file.id) && file.ready && (file.artifact || file.direction === "output") && (turnId ? file.provenance?.turnId === turnId : file.provenance?.itemId && itemIds.includes(file.provenance.itemId)));
  if (!delivered.length) return null;
  return <div className="bots-returned-files">{delivered.slice(0, 6).map((file) => <ReturnedArtifact key={file.id} id={file.id} botId={botId} attachment={file} />)}{delivered.length > 6 && <a href={`/bots?bot=${encodeURIComponent(botId)}&view=attachments`}>View all attachments</a>}</div>;
}
