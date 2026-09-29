"use client";
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { MoveHorizontal } from "lucide-react";
import "./markdown-table.css";

/** Keep native table semantics; only this viewport scrolls horizontally. */
export function MarkdownTable({ children }: { children: ReactNode }) {
  const viewport = useRef<HTMLDivElement>(null), table = useRef<HTMLTableElement>(null);
  const hint = useId();
  const [overflow, setOverflow] = useState(false);
  useLayoutEffect(() => {
    const measure = () => {
      const element = viewport.current;
      if (element) setOverflow(element.scrollWidth > element.clientWidth + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (viewport.current) observer.observe(viewport.current);
    if (table.current) observer.observe(table.current);
    return () => observer.disconnect();
  }, []);
  return <div className="bots-markdown-table">
    {overflow && <div className="bots-table-hint" id={hint}><MoveHorizontal size={14} aria-hidden="true" />Scroll sideways for more columns</div>}
    <div ref={viewport} className="bots-table-viewport" role={overflow ? "region" : undefined}
      aria-label={overflow ? "Scrollable table" : undefined} aria-describedby={overflow ? hint : undefined} tabIndex={overflow ? 0 : undefined}>
      <table ref={table}>{children}</table>
    </div>
  </div>;
}
