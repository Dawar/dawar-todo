"use client";

import { ControlledDialog } from "@/components/ui/controlled-dialog";
import { ActionIcon } from "./action-icon";

const keyboardShortcutGroups = [
  {
    title: "While editing a task",
    shortcuts: [
      { keys: ["↑"], label: "At text start: previous task" },
      { keys: ["↓"], label: "At text end: next task" },
      { keys: ["⌘/Ctrl", "Enter"], label: "Finish editing" },
      { keys: ["Esc"], label: "Finish editing" },
    ],
  },
  {
    title: "Anywhere",
    shortcuts: [
      { keys: ["/"], label: "Search" },
      { keys: ["N"], label: "New task" },
      { keys: ["⌘/Ctrl", "Z"], label: "Undo last task action" },
      { keys: ["?"], label: "Show this guide" },
      { keys: ["Esc"], label: "Close an open panel" },
    ],
  },
] as const;

export function KeyboardShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <ControlledDialog onClose={onClose} className="max-w-2xl"
      title={<span className="flex items-center gap-2"><ActionIcon name="keyboard" className="h-5 w-5 text-primary" />Keyboard shortcuts</span>}
      description="Move between inline editors and use quick app commands.">
        <div className="grid gap-4 sm:grid-cols-2">
          {keyboardShortcutGroups.map((group) => (
            <section key={group.title} className="rounded-lg border border-border p-4">
              <h3 className="mb-3 text-sm font-semibold">{group.title}</h3>
              <dl className="space-y-3">
                {group.shortcuts.map((shortcut) => (
                  <div key={`${shortcut.label}:${shortcut.keys.join("+")}`} className="flex flex-wrap items-start justify-between gap-2">
                    <dt className="text-sm leading-6 text-muted-foreground">{shortcut.label}</dt>
                    <dd className="flex shrink-0 items-center gap-1">
                      {shortcut.keys.map((key) => <kbd key={key} className="min-w-6 rounded-sm border border-input bg-muted px-1.5 py-0.5 text-center font-mono text-xs text-foreground">{key}</kbd>)}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
    </ControlledDialog>
  );
}
