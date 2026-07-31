"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { ActionIcon } from "./action-icon";

const keyboardShortcutGroups = [
  {
    title: "Navigate tasks",
    shortcuts: [
      { keys: ["↑", "K"], label: "Previous task" },
      { keys: ["↓", "J"], label: "Next task" },
      { keys: ["←", "→"], label: "Choose an action" },
      { keys: ["Enter"], label: "Run the chosen action" },
    ],
  },
  {
    title: "Act on focused task",
    shortcuts: [
      { keys: ["Enter"], label: "Edit task title" },
      { keys: ["E"], label: "Edit description and details" },
      { keys: ["Space"], label: "Select or deselect" },
      { keys: ["D"], label: "Done or reopen" },
      { keys: ["S"], label: "Snooze or wake" },
      { keys: ["P"], label: "Pin or unpin in Open" },
      { keys: ["Shift", "D"], label: "Delete with Undo" },
    ],
  },
  {
    title: "Move around",
    shortcuts: [
      { keys: ["1", "2", "3", "4"], label: "Open, Snoozed, Done, All" },
      { keys: ["[", "]"], label: "Previous or next view" },
      { keys: ["/"], label: "Search" },
      { keys: ["N"], label: "New task" },
      { keys: ["⌘/Ctrl", "Z"], label: "Undo last task action" },
      { keys: ["?"], label: "Show this guide" },
      { keys: ["Esc"], label: "Close or clear focus" },
    ],
  },
] as const;

export function KeyboardShortcutsDialog({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[70] hidden items-center justify-center p-5 md:flex" role="dialog" aria-modal="true" aria-labelledby="keyboard-shortcuts-title">
      <button type="button" aria-label="Close keyboard shortcuts" onClick={onClose} className="absolute inset-0 bg-black/30 backdrop-blur-[2px]" />
      <div className="relative w-full max-w-2xl overflow-hidden rounded-3xl border border-black/[0.06] bg-[#f6f7f5] shadow-2xl">
        <div className="flex items-center justify-between gap-4 border-b border-black/[0.07] bg-white px-6 py-5">
          <div>
            <h2 id="keyboard-shortcuts-title" className="flex items-center gap-2 text-lg font-semibold text-[#202522]"><ActionIcon name="keyboard" className="h-5 w-5 text-[#216e4e]" />Keyboard shortcuts</h2>
            <p className="mt-1 text-sm text-[#7c847f]">Navigate and act without leaving the keyboard.</p>
          </div>
          <button type="button" autoFocus onClick={onClose} className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[#f1f2f0] text-[#4f5752] hover:bg-[#e8eae7] focus-visible:outline-2 focus-visible:outline-[#216e4e]" aria-label="Close keyboard shortcuts" title="Close"><ActionIcon name="close" /></button>
        </div>
        <div className="grid gap-4 p-5 sm:grid-cols-3 sm:p-6">
          {keyboardShortcutGroups.map((group) => (
            <section key={group.title} className="rounded-2xl border border-black/[0.06] bg-white p-4">
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-[#69716c]">{group.title}</h3>
              <dl className="space-y-3">
                {group.shortcuts.map((shortcut) => (
                  <div key={shortcut.label} className="flex items-start justify-between gap-3">
                    <dt className="text-sm leading-6 text-[#4f5752]">{shortcut.label}</dt>
                    <dd className="flex shrink-0 items-center gap-1">
                      {shortcut.keys.map((key) => <kbd key={key} className="min-w-6 rounded-md border border-black/[0.1] bg-[#f6f7f5] px-1.5 py-0.5 text-center font-mono text-[11px] font-semibold text-[#303632] shadow-sm">{key}</kbd>)}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
