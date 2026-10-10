"use client";
import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

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

export function TextPages({ text, render }: { text: string; render: (text: string, offset: number) => ReactNode }) {
  const [page, setPage] = useState(0), size = 16384, total = Math.max(1, Math.ceil(text.length / size));
  const current = Math.min(page, total - 1);
  return <>{total > 1 && <nav className="bots-text-pages" aria-label="Full message pages">
    <button disabled={current === 0} onClick={() => setPage(current - 1)}>Previous part</button>
    <span>Part {current + 1} of {total} · Complete text available</span>
    <button disabled={current === 0} onClick={() => setPage(0)}>First part</button>
    <button disabled={current === total - 1} onClick={() => setPage(total - 1)}>Last part</button>
    <button disabled={current === total - 1} onClick={() => setPage(current + 1)}>Next part</button>
  </nav>}{render(text.slice(current * size, (current + 1) * size), current * size)}</>;
}

export function ItemPages<T>({ items, render, size = 10 }: { items: T[]; render: (item: T, index: number) => ReactNode; size?: number }) {
  const [page, setPage] = useState(0), total = Math.max(1, Math.ceil(items.length / size)), current = Math.min(page, total - 1);
  return <>{total > 1 && <nav className="bots-text-pages" aria-label="Complete item pages">
    <button disabled={!current} onClick={() => setPage(current - 1)}>Previous items</button>
    <span>Items {current * size + 1}–{Math.min(items.length, (current + 1) * size)} of {items.length}</span>
    <button disabled={current === total - 1} onClick={() => setPage(current + 1)}>Next items</button>
    <button disabled={current === total - 1} onClick={() => setPage(total - 1)}>Last items</button>
  </nav>}{items.slice(current * size, (current + 1) * size).map((item, i) => render(item, current * size + i))}</>;
}
