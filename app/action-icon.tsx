import type { ComponentType } from "react";
import {
  AlarmClock,
  Archive,
  ArchiveRestore,
  CircleCheckBig,
  Clock3,
  FolderInput,
  ListChecks,
  Merge,
  Plus,
  RotateCcw,
  Save,
  Search,
  SlidersHorizontal,
  Trash2,
  Undo2,
  X,
  type LucideProps,
} from "lucide-react";

export type ActionIconName =
  | "add"
  | "archive"
  | "cancel"
  | "close"
  | "delete"
  | "done"
  | "filters"
  | "merge"
  | "move"
  | "open"
  | "restore"
  | "save"
  | "search"
  | "select"
  | "snooze"
  | "undo"
  | "wake";

const icons: Record<ActionIconName, ComponentType<LucideProps>> = {
  add: Plus,
  archive: Archive,
  cancel: X,
  close: X,
  delete: Trash2,
  done: CircleCheckBig,
  filters: SlidersHorizontal,
  merge: Merge,
  move: FolderInput,
  open: RotateCcw,
  restore: ArchiveRestore,
  save: Save,
  search: Search,
  select: ListChecks,
  snooze: Clock3,
  undo: Undo2,
  wake: AlarmClock,
};

export function ActionIcon({
  name,
  className = "h-4 w-4",
  strokeWidth = 2,
  ...props
}: LucideProps & { name: ActionIconName }) {
  const Icon = icons[name];
  return <Icon aria-hidden="true" focusable="false" className={className} strokeWidth={strokeWidth} {...props} />;
}
