"use client";
import { Component, useEffect, useMemo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { readDocumentText, type DocumentKind } from "./document-source";
import { safeDocumentLink, staticHtml } from "./document-html";
import { readRouteDiagram } from "./route-diagram-source";
import { RouteVisualization } from "./route-visualization";
import "./document-viewer.css";
export default function DocumentPreview({ file, kind, name, onReady }: { file: Blob; kind: DocumentKind; name: string; onReady?: (ready: boolean) => void }) {
  return <PreviewBoundary onReady={onReady}><TextPreview file={file} kind={kind} name={name} onReady={onReady} /></PreviewBoundary>;
}
class PreviewBoundary extends Component<{ children: ReactNode; onReady?: (ready: boolean) => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onReady?.(false); }
  render() { return this.state.failed ? <div className="bots-document-state" role="alert"><p>This document could not render. Download the original to read it.</p><button onClick={() => this.setState({ failed: false })}>Try again</button></div> : this.props.children; }
}
function TextPreview({ file, kind, name, onReady }: { file: Blob; kind: DocumentKind; name: string; onReady?: (ready: boolean) => void }) {
  const [loaded, setLoaded] = useState<{ text: string; error: string } | null>(null), [retry, setRetry] = useState(0);
  useEffect(() => {
    const abort = new AbortController(); onReady?.(false);
    void readDocumentText(file, abort.signal).then(text => { if (!abort.signal.aborted) setLoaded({ text, error: "" }); })
      .catch(error => { if (!abort.signal.aborted) setLoaded({ text: "", error: error instanceof Error ? error.message : "This document could not open." }); });
    return () => abort.abort();
  }, [file, retry, onReady]);
  const rendered = useMemo(() => {
    if (!loaded || loaded.error || kind !== "html") return null;
    try { const diagram = readRouteDiagram(loaded.text); return { ...(diagram ? { srcDoc: "", links: [] } : staticHtml(loaded.text)), diagram, error: "" }; }
    catch { return { srcDoc: "", links: [], diagram: null, error: "This HTML could not be rendered safely. Download the original to read it." }; }
  }, [loaded, kind]);
  const error = loaded?.error || rendered?.error;
  useEffect(() => { onReady?.(Boolean(loaded && !error)); }, [loaded, error, onReady]);
  if (!loaded) return <div className="bots-document-state" role="status">Rendering document…</div>;
  if (error) return <div className="bots-document-state" role="alert"><p>{error}</p><button onClick={() => { setLoaded(null); setRetry(value => value + 1); }}>Try again</button></div>;
  return <div className={`bots-document-preview is-${kind}`}>
    {kind === "html" ? <>{rendered?.diagram ? <RouteVisualization key={loaded.text} diagram={rendered.diagram} /> : <iframe title={`HTML document: ${name}`} sandbox="" referrerPolicy="no-referrer" srcDoc={rendered?.srcDoc} />}
      {Boolean(rendered?.links.length) && <details className="bots-document-links"><summary>Document links ({rendered!.links.length})</summary><ul>{rendered!.links.map(link => <li key={link.href}><a href={link.href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{link.label}</a></li>)}</ul></details>}</> :
      <article className="bots-document-markdown" aria-label={`Markdown document: ${name}`}><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}
        urlTransform={url => safeDocumentLink(url) ?? ""} components={{
          a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{children}</a> : <span>{children}</span>,
          // Reports do not fetch image URLs silently; keep readable alt text.
          img: ({ alt }) => <span className="bots-document-image-alt">{alt || "Image (available in original document)"}</span>,
          table: ({ children }) => <div className="bots-document-table"><table>{children}</table></div>,
        }}>{loaded.text}</ReactMarkdown></article>}
  </div>;
}
