"use client";
import { useState, type ReactNode } from "react";
import { ChevronRight, ChevronLeft, ChevronsLeft, ChevronsRight } from "lucide-react";
import { Button } from "@/components/ui/button";

/** A closed disclosure does not mount markdown, images, tools, or their effects. */
export function LazyDetails({ summary, children, className = "bots-tool", open: controlled, onOpenChange, beforeToggle }: {
  summary: ReactNode; children: () => ReactNode; className?: string; open?: boolean; onOpenChange?: (open: boolean) => void; beforeToggle?: () => void;
}) {
  const [localOpen, setOpen] = useState(false);
  const open = controlled ?? localOpen;
  return <details className={className} open={open} onToggle={(event) => {
    if (event.target === event.currentTarget) { setOpen(event.currentTarget.open); onOpenChange?.(event.currentTarget.open); }
  }}><summary onClick={beforeToggle}><ChevronRight size={15} className="bots-disclosure-chevron" aria-hidden="true" />{summary}</summary>{open && children()}</details>;
}

function PageControls({ label, summary, page, total, onChange, first = true }: {
  label: string; summary: string; page: number; total: number; onChange: (page: number) => void; first?: boolean;
}) {
  return <nav className="bots-content-pagination" aria-label={label}>
    <span className="bots-content-page-label" aria-live="polite" aria-atomic="true">{summary}</span>
    <div className="bots-content-page-actions">
      {first && <Button variant="outline" size="icon" type="button" aria-label="First page" title="First page" disabled={page === 0} onClick={() => onChange(0)}><ChevronsLeft size={16} aria-hidden="true"/></Button>}
      <Button variant="outline" size="icon" type="button" aria-label="Previous page" title="Previous page" disabled={page === 0} onClick={() => onChange(page - 1)}><ChevronLeft size={16} aria-hidden="true"/></Button>
      <Button variant="outline" size="icon" type="button" aria-label="Next page" title="Next page" disabled={page === total - 1} onClick={() => onChange(page + 1)}><ChevronRight size={16} aria-hidden="true"/></Button>
      <Button variant="outline" size="icon" type="button" aria-label="Last page" title="Last page" disabled={page === total - 1} onClick={() => onChange(total - 1)}><ChevronsRight size={16} aria-hidden="true"/></Button>
    </div>
  </nav>;
}

export function TextPages({ text, render }: { text: string; render: (text: string, offset: number) => ReactNode }) {
  const [page, setPage] = useState(0), size = 16384, total = Math.max(1, Math.ceil(text.length / size));
  const current = Math.min(page, total - 1);
  return <>{total > 1 && <PageControls label="Full message pages" summary={`Part ${current + 1} of ${total}`} page={current} total={total} onChange={setPage}/>}{render(text.slice(current * size, (current + 1) * size), current * size)}</>;
}

export function ItemPages<T>({ items, render, size = 10 }: { items: T[]; render: (item: T, index: number) => ReactNode; size?: number }) {
  const [page, setPage] = useState(0), total = Math.max(1, Math.ceil(items.length / size)), current = Math.min(page, total - 1);
  return <>{total > 1 && <PageControls label="Complete item pages" summary={`Items ${current * size + 1}–${Math.min(items.length, (current + 1) * size)} of ${items.length}`} page={current} total={total} onChange={setPage} first={false}/>}{items.slice(current * size, (current + 1) * size).map((item, i) => render(item, current * size + i))}</>;
}
