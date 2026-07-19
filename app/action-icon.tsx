import type { ComponentType } from "react";
import {
  AlarmClock,
  Camera,
  ChevronLeft,
  ChevronRight,
  CircleCheckBig,
  Clock3,
  Download,
  FolderInput,
  Folder,
  FolderPlus,
  List,
  ListChecks,
  ListTodo,
  Merge,
  ImagePlus,
  Plus,
  RotateCcw,
  RefreshCw,
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
  | "camera"
  | "close"
  | "delete"
  | "done"
  | "download"
  | "filters"
  | "folder"
  | "create-project"
  | "merge"
  | "move"
  | "image"
  | "next"
  | "open"
  | "restore"
  | "retry"
  | "save"
  | "search"
  | "settings"
  | "select"
  | "snooze"
  | "undo"
  | "previous"
  | "view-all"
  | "view-open"
  | "wake";

const icons: Record<ActionIconName, ComponentType<LucideProps>> = {
  add: Plus,
  cancel: X,
  camera: Camera,
  close: X,
  delete: Trash2,
  done: CircleCheckBig,
  download: Download,
  filters: SlidersHorizontal,
  folder: Folder,
  "create-project": FolderPlus,
  merge: Merge,
  move: FolderInput,
  image: ImagePlus,
  next: ChevronRight,
  open: RotateCcw,
  restore: RotateCcw,
  retry: RefreshCw,
  save: Save,
  search: Search,
  settings: Settings2,
  select: ListChecks,
  snooze: Clock3,
  undo: Undo2,
  previous: ChevronLeft,
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
