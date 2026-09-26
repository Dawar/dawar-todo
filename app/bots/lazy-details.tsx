"use client";
import { useState, type ReactNode } from "react";

/** A closed disclosure does not mount markdown, images, tools, or their effects. */
export function LazyDetails({ summary, children, className = "bots-tool" }: {
  summary: ReactNode; children: () => ReactNode; className?: string;
}) {
  const [open, setOpen] = useState(false);
  return <details className={className} open={open} onToggle={(event) => {
    if (event.target === event.currentTarget) setOpen(event.currentTarget.open);
  }}><summary>{summary}</summary>{open && children()}</details>;
}

export function TextPages({ text, render }: { text: string; render: (text: string) => ReactNode }) {
  const [page, setPage] = useState(0), size = 8192, total = Math.max(1, Math.ceil(text.length / size));
  const current = Math.min(page, total - 1);
  return <>{total > 1 && <nav className="bots-text-pages" aria-label="Full message pages">
    <button disabled={current === 0} onClick={() => setPage(current - 1)}>Previous part</button>
    <span>Part {current + 1} of {total} · Complete text available</span>
    <button disabled={current === total - 1} onClick={() => setPage(current + 1)}>Next part</button>
  </nav>}{render(text.slice(current * size, (current + 1) * size))}</>;
}
