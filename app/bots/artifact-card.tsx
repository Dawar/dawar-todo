"use client";
import { memo, useEffect, useRef, useState } from "react";
import { FileText, File, Image as ImageIcon, ArrowUpRight, Download } from "lucide-react";
import { artifactPreview, fileSize, fileType, galleryType, type GalleryItem } from "./artifact-source";

export function ArtifactThumbnail({ item, owner, online }: { item: GalleryItem; owner: string; online: boolean }) {
  const target = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false), [url, setUrl] = useState(""), [failed, setFailed] = useState(false);
  const type = galleryType(item), key = `${item.botId}:${item.id}:${item.version ?? item.size}`;
  useEffect(() => {
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: "160px" });
    if (target.current) observer.observe(target.current); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || type === "document") return;
    let active = true, objectUrl = "";
    void artifactPreview(item, owner, online).then((blob) => {
      if (!active) return; objectUrl = URL.createObjectURL(blob); setUrl(objectUrl); setFailed(false);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
    // Key captures identity/version; sidebar/count rerenders must not reload images.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, visible, owner, online, type]);
  const Icon = type === "image" ? ImageIcon : type === "pdf" ? FileText : File;
  return <span className={`bots-file-preview is-${type} ${!url && !failed && type !== "document" ? "is-loading" : ""}`} ref={target}>
    {/* eslint-disable-next-line @next/next/no-img-element -- Bounded authenticated blob thumbnail. */}
    {url && !failed ? <img src={url} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} /> : <><Icon size={type === "document" ? 30 : 25} strokeWidth={1.3} aria-hidden="true" /><span>{failed ? online ? "Preview unavailable" : "Preview offline" : type === "document" ? fileType(item) : ""}</span></>}
    {type === "pdf" && <span className="bots-file-preview-label">PDF</span>}
  </span>;
}
export const ArtifactCard = memo(function ArtifactCard({ item, owner, online, attribution = false, onOpen, onDownload }: {
  item: GalleryItem; owner: string; online: boolean; attribution?: boolean; onOpen: (item: GalleryItem) => void; onDownload: (item: GalleryItem) => void;
}) {
  const date = new Date(item.createdAt ?? ""), knownDate = Number.isFinite(date.getTime());
  return <article className="bots-file-card" data-artifact-id={item.id}>
    <button className="bots-file-open" onClick={() => onOpen(item)} aria-label={`Open ${item.name}`}>
      <ArtifactThumbnail item={item} owner={owner} online={online} />
      <span className="bots-file-copy"><strong title={item.name}>{item.name}</strong><span>{fileType(item)} <i aria-hidden="true">·</i> {fileSize(item.size)} {knownDate && <><i aria-hidden="true">·</i> {date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</>}</span></span>
      {item.cloudState === "failed" && <span role="status">Publication failed · original saved</span>}
      {(item.cloudState === "pending" || item.cloudState === "transferring") && <span role="status">Publication pending</span>}
    </button>
    <div className="bots-file-card-footer">
      {attribution ? <span className="bots-file-bot" title={item.botName}><i style={{ background: item.botColor ?? "#77a48d" }} />{item.botName}</span> : <span>{item.direction === "input" ? "From you" : "From your bot"}</span>}
      <div><button onClick={() => onOpen(item)} aria-label={`Preview ${item.name}`} title="Open"><ArrowUpRight size={17} /></button><button onClick={() => onDownload(item)} disabled={!online} aria-label={`Download ${item.name}`} title="Download"><Download size={16} /></button></div>
    </div>
  </article>;
});
