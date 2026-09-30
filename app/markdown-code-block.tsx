"use client";

import { memo, useEffect, useRef, useState, type ComponentProps } from "react";
import { Code2, Network } from "lucide-react";
import type { ExtraProps } from "react-markdown";
import "./mermaid-diagram.css";

// Import the renderer only when a diagram approaches the viewport. Ordinary
// messages never load Mermaid's parsers or layout engines.
let renderer: Promise<typeof import("mermaid")["default"]> | undefined;
let serial = 0;
function loadRenderer() {
  return renderer ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true,
      maxTextSize: 20000, maxEdges: 300, htmlLabels: false, theme: "base",
      fontFamily: "system-ui, sans-serif",
      themeVariables: {
        primaryColor: "#edf5ef", primaryTextColor: "#263c30",
        primaryBorderColor: "#88ad98", lineColor: "#628672",
        secondaryColor: "#f5f7f4", tertiaryColor: "#fff", fontSize: "14px",
      },
    });
    return mermaid;
  }).catch(error => { renderer = undefined; throw error; });
}

const MermaidDiagram = memo(function MermaidDiagram({ source }: { source: string }) {
  const root = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false), [showSource, setShowSource] = useState(false);
  const [result, setResult] = useState<{ source: string; svg: string; failed: boolean } | null>(null);
  useEffect(() => {
    if (!root.current) return;
    if (typeof IntersectionObserver === "undefined") {
      const timer = setTimeout(() => setVisible(true), 0);
      return () => clearTimeout(timer);
    }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "200px" });
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    // Streaming output can temporarily contain an incomplete diagram. Coalesce
    // changes, retain the source on failure, and never publish an older render.
    const timer = setTimeout(() => {
      void (async () => {
        try {
          // Diagram-authored configuration/CSS is not needed for chat diagrams.
          if (source.length > 20000 || /%%\s*\{|^\s*---/.test(source)) throw new Error("Unsupported diagram configuration");
          const [mermaid, { default: sanitize }] = await Promise.all([loadRenderer(), import("dompurify")]);
          if (!alive) return;
          const container = document.createElement("div");
          container.style.cssText = "position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none";
          document.body.appendChild(container);
          try {
            const { svg } = await mermaid.render(`todo-diagram-${++serial}`, source, container);
            const clean = sanitize.sanitize(svg, {
              USE_PROFILES: { svg: true, svgFilters: true },
              FORBID_TAGS: ["foreignObject", "a", "image", "script"],
            });
            const documentSvg = new DOMParser().parseFromString(clean, "image/svg+xml");
            const element = documentSvg.documentElement;
            if (element.tagName !== "svg") throw new Error("Invalid diagram");
            const bounds = element.getAttribute("viewBox")?.split(/[\s,]+/).map(Number);
            if (bounds?.length === 4 && bounds.every(Number.isFinite) && bounds[2] > 0 && bounds[3] > 0) {
              element.setAttribute("width", String(bounds[2]));
              element.setAttribute("height", String(bounds[3]));
            }
            element.setAttribute("style", "max-width:none");
            element.setAttribute("role", "img");
            element.setAttribute("aria-label", "Rendered diagram");
            if (alive) setResult({ source, svg: new XMLSerializer().serializeToString(element), failed: false });
          } finally { container.remove(); }
        } catch {
          if (alive) setResult({ source, svg: "", failed: true });
        }
      })();
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [source, visible]);
  const current = result?.source === source ? result : null;
  const sourceVisible = showSource || current?.failed;
  return <div ref={root} className="markdown-diagram">
    <div className="markdown-diagram-heading">
      <span>{current?.failed ? "Diagram source" : "Diagram"}</span>
      {!current?.failed && <button type="button" onClick={() => setShowSource(value => !value)}
        aria-label={showSource ? "Show diagram" : "Show diagram source"}
        title={showSource ? "Show diagram" : "Show source"} aria-pressed={showSource}>
        {showSource ? <Network size={16} aria-hidden="true" /> : <Code2 size={16} aria-hidden="true" />}
      </button>}
    </div>
    {sourceVisible ? <pre><code>{source}</code></pre> : current?.svg ?
      <div className="markdown-diagram-viewport" role="region" aria-label="Diagram; scroll sideways if needed" tabIndex={0}
        dangerouslySetInnerHTML={{ __html: current.svg }} /> :
      <div className="markdown-diagram-placeholder" aria-busy="true">Rendering diagram…</div>}
  </div>;
});

export function MarkdownCodeBlock({ node, children, ...props }: ComponentProps<"pre"> & ExtraProps) {
  const code = node?.children.find(child => child.type === "element" && child.tagName === "code");
  if (code?.type === "element") {
    const source = code.children.map(child => child.type === "text" ? child.value : "").join("").trimEnd();
    const classes = String(code.properties.className ?? "").split(/[\s,]+/);
    // Recognize unlabelled flowchart blocks too, including existing bot replies.
    if (classes.includes("language-mermaid") || (!classes.some(value => value.startsWith("language-")) && /^\s*(?:flowchart|graph)\s+(?:TB|TD|BT|RL|LR)\b/.test(source))) {
      return <MermaidDiagram source={source} />;
    }
  }
  return <pre {...props}>{children}</pre>;
}
