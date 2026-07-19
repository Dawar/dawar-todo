import type { ComponentType } from "react";
import {
  AlarmClock,
  CircleCheckBig,
  Clock3,
  FolderInput,
  Folder,
  FolderPlus,
  List,
  ListChecks,
  ListTodo,
  Merge,
  Plus,
  RotateCcw,
  Save,
  Search,
  Settings2,
  SlidersHorizontal,
  Trash2,
  Undo2,
  X,
  type LucideProps,
} from "lucide-react";

export type ActionIconName =
  | "add"
  | "cancel"
  | "close"
  | "delete"
  | "done"
  | "filters"
  | "folder"
  | "create-project"
  | "merge"
  | "move"
  | "open"
  | "restore"
  | "save"
  | "search"
  | "settings"
  | "select"
  | "snooze"
  | "undo"
  | "view-all"
  | "view-open"
  | "wake";

const icons: Record<ActionIconName, ComponentType<LucideProps>> = {
  add: Plus,
  cancel: X,
  close: X,
  delete: Trash2,
  done: CircleCheckBig,
  filters: SlidersHorizontal,
  folder: Folder,
  "create-project": FolderPlus,
  merge: Merge,
  move: FolderInput,
  open: RotateCcw,
  restore: RotateCcw,
  save: Save,
  search: Search,
  settings: Settings2,
  select: ListChecks,
  snooze: Clock3,
  undo: Undo2,
  "view-all": List,
  "view-open": ListTodo,
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
