"use client";
import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp, WrapText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TEXT_PREVIEW_LIMITS, clipCell, decodePreviewText, formatJson, highlightTokens, parseDelimited, previewLines, searchLines, tokenLines } from "../../lib/file-preview.mjs";
import "./document-viewer.css";
import "./file-preview.css";

export type FileViewer = { kind: "text" | "json" | "csv" | "tsv" | "log" | "config" | "code" | "audio" | "video"; language: string };
type Loaded = { status: "ok"; text: string } | { status: "large" | "encoding" | "binary" | "failed" };

/** Read-only viewers for registered/staged original bytes; Download stays the original Blob. */
export default function FilePreview({ file, url, viewer, name }: { file: Blob; url: string; viewer: FileViewer; name: string }) {
  return <Boundary>{viewer.kind === "audio" || viewer.kind === "video"
    ? <MediaPreview url={url} kind={viewer.kind} name={name} />
    : <TextFile file={file} viewer={viewer} name={name} />}</Boundary>;
}
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <Notice>This file could not be shown. Download the original to open it.</Notice> : this.props.children; }
}
function Notice({ children }: { children: ReactNode }) {
  return <div className="bots-document-state" role="alert"><p>{children}</p></div>;
}

function MediaPreview({ url, kind, name }: { url: string; kind: "audio" | "video"; name: string }) {
  const element = useRef<HTMLMediaElement | null>(null), [failed, setFailed] = useState(false);
  // Closing/switching files stops playback; the viewer revokes its Blob URL.
  useEffect(() => () => { const media = element.current; if (media) { media.pause(); media.removeAttribute("src"); media.load(); } }, []);
  if (failed) return <Notice>This {kind} format can’t play on this device. Download the original to open it in another app.</Notice>;
  return <div className={`bots-media-preview is-${kind}`}>
    {kind === "audio"
      ? <audio ref={value => { element.current = value; }} src={url} controls preload="metadata" aria-label={`Audio: ${name}`} onError={() => setFailed(true)} />
      : <video ref={value => { element.current = value; }} src={url} controls playsInline preload="metadata" aria-label={`Video: ${name}`} onError={() => setFailed(true)} />}
  </div>;
}

function TextFile({ file, viewer, name }: { file: Blob; viewer: FileViewer; name: string }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => {
    let active = true;
    if (file.size > TEXT_PREVIEW_LIMITS.bytes) { void Promise.resolve().then(() => { if (active) setLoaded({ status: "large" }); }); return () => { active = false; }; }
    void file.arrayBuffer().then(bytes => { if (active) setLoaded(decodePreviewText(new Uint8Array(bytes)) as Loaded); }, () => { if (active) setLoaded({ status: "failed" }); });
    return () => { active = false; };
  }, [file]);
  if (!loaded) return <div className="bots-document-state" role="status">Opening file…</div>;
  if (loaded.status !== "ok") return <Notice>{loaded.status === "large" ? `Preview supports text files up to ${TEXT_PREVIEW_LIMITS.bytes / 1024 / 1024} MB. Download the original to read this file.`
    : loaded.status === "failed" ? "This file could not be read. Download the original to open it."
      : "This file is not readable UTF-8 text. Download the original to open it in another app."}</Notice>;
  if (viewer.kind === "json") return <JsonView text={loaded.text} name={name} />;
  if (viewer.kind === "csv" || viewer.kind === "tsv") return <TableView text={loaded.text} delimiter={viewer.kind === "tsv" ? "\t" : ","} name={name} />;
  return <SourceView text={loaded.text} language={viewer.kind === "text" || viewer.kind === "log" ? "" : viewer.language} numbered={viewer.kind !== "text"} search={viewer.kind === "log"} name={name} />;
}

function Tabs<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (value: T) => void; label: string }) {
  return <div className="bots-file-preview-tabs" role="group" aria-label={label}>{options.map(([key, text]) =>
    <Button key={key} size="sm" variant={value === key ? "secondary" : "ghost"} aria-pressed={value === key} onClick={() => onChange(key)}>{text}</Button>)}</div>;
}

function JsonView({ text, name }: { text: string; name: string }) {
  const result = useMemo(() => formatJson(text), [text]);
  const [mode, setMode] = useState<"formatted" | "raw">("formatted");
  if ("error" in result) return <SourceView text={text} language="json" numbered name={name}
    tools={<p role="alert" className="bots-file-preview-error">Invalid JSON: {result.error} Showing the exact raw text.</p>} />;
  return <SourceView key={mode} text={mode === "formatted" ? result.formatted : text} language="json" numbered name={name}
    tools={<Tabs label="JSON view" value={mode} onChange={setMode} options={[["formatted", "Formatted"], ["raw", "Raw"]]} />} />;
}

function TableView({ text, delimiter, name }: { text: string; delimiter: string; name: string }) {
  const table = useMemo(() => parseDelimited(text, delimiter), [text, delimiter]);
  const [mode, setMode] = useState<"table" | "raw">("table");
  const [header, ...body] = table.rows;
  const columns = Array.from({ length: table.columns }, (_, index) => index);
  const notes = [table.hiddenRows && `First ${TEXT_PREVIEW_LIMITS.tableRows.toLocaleString()} records shown`, table.hiddenColumns && `${table.hiddenColumns} more columns hidden`,
    table.unterminated && "A quoted value is not closed; the last record may be incomplete", table.ragged && "Rows have different column counts"].filter(Boolean);
  const tabs = <Tabs label="Table view" value={mode} onChange={setMode} options={[["table", "Table"], ["raw", "Raw"]]} />;
  if (mode === "raw") return <SourceView text={text} language="" numbered name={name} tools={tabs} />;
  return <div className="bots-file-text-preview">
    <div className="bots-file-preview-toolbar">{tabs}
      <span role="status">{Math.max(0, table.rows.length - 1).toLocaleString()} rows{notes.length ? ` · ${notes.join(" · ")}` : ""}. Download for the full original.</span></div>
    {!header ? <Notice>This file is empty.</Notice> :
      <div className="bots-file-table" role="region" aria-label={`Table: ${name}`} tabIndex={0}><table>
        <thead><tr><th scope="col" className="is-row-number">#</th>{columns.map(index => <th scope="col" key={index}>{index < header.length ? clipCell(header[index]) : ""}</th>)}</tr></thead>
        <tbody>{body.map((row, rowIndex) => <tr key={rowIndex}><th scope="row" className="is-row-number">{rowIndex + 1}</th>
          {columns.map(index => <td key={index} className={index < row.length ? undefined : "is-missing"}>{index < row.length ? clipCell(row[index]) : ""}</td>)}</tr>)}</tbody>
      </table></div>}
  </div>;
}

function SourceView({ text, language, numbered, search = false, name, tools }: { text: string; language: string; numbered: boolean; search?: boolean; name: string; tools?: ReactNode }) {
  const [wrap, setWrap] = useState(true), [query, setQuery] = useState(""), [current, setCurrent] = useState(0);
  const view = useMemo(() => {
    const plain = previewLines(text);
    const highlighted = language && text.length <= TEXT_PREVIEW_LIMITS.highlightBytes ? tokenLines(highlightTokens(text, language)) : null;
    return { ...plain, highlighted };
  }, [text, language]);
  const found = useMemo(() => search ? searchLines(view.lines, query) : { matches: [], clipped: false }, [search, view.lines, query]);
  const matchSet = useMemo(() => new Set(found.matches), [found.matches]);
  const body = useRef<HTMLDivElement>(null);
  const target = found.matches[Math.min(current, found.matches.length - 1)];
  useEffect(() => { if (target !== undefined) body.current?.querySelector(`[data-line="${target + 1}"]`)?.scrollIntoView({ block: "center" }); }, [target]);
  const step = (delta: number) => setCurrent(value => found.matches.length ? (value + delta + found.matches.length) % found.matches.length : 0);
  const notes = [view.hiddenLines && `First ${view.lines.length.toLocaleString()} of ${view.total.toLocaleString()} lines shown`, view.clippedLines && `${view.clippedLines} long lines shortened`,
    language && !view.highlighted && "Highlighting off for large files"].filter(Boolean);
  return <div className="bots-file-text-preview">
    <div className="bots-file-preview-toolbar">{tools}
      {search && <span className="bots-file-preview-search"><Input type="search" aria-label="Search log" placeholder="Search" value={query} maxLength={200} onChange={event => { setQuery(event.target.value); setCurrent(0); }}
        onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); step(event.shiftKey ? -1 : 1); } }} />
        <span role="status">{query ? found.matches.length ? `${Math.min(current, found.matches.length - 1) + 1} of ${found.matches.length}${found.clipped ? "+" : ""}` : "No matches" : ""}</span>
        <Button variant="ghost" size="icon" aria-label="Previous match" disabled={!found.matches.length} onClick={() => step(-1)}><ChevronUp size={16} /></Button>
        <Button variant="ghost" size="icon" aria-label="Next match" disabled={!found.matches.length} onClick={() => step(1)}><ChevronDown size={16} /></Button></span>}
      {notes.length > 0 && <span role="status">{notes.join(" · ")}. Download for the full original.</span>}
      <Button variant={wrap ? "secondary" : "ghost"} size="sm" aria-pressed={wrap} onClick={() => setWrap(value => !value)}><WrapText size={15} />Wrap</Button>
    </div>
    <div ref={body} className={`bots-file-source ${wrap ? "is-wrapped" : ""} ${numbered ? "is-numbered" : ""}`} role="region" aria-label={`File contents: ${name}`} tabIndex={0}>
      <code>{view.lines.map((line, index) => <span key={index} className={`bots-file-line ${matchSet.has(index) ? index === target ? "is-current" : "is-match" : ""}`} data-line={index + 1}>
        {view.highlighted?.[index] ? view.highlighted[index].map(([type, value], part) => type === "plain" ? value : <span key={part} className={`tok-${type}`}>{value}</span>) : line}{"\n"}
      </span>)}</code>
    </div>
  </div>;
}
