import type { ComponentType } from "react";
import {
  AlarmClock,
  BellDot,
  CalendarDays,
  Camera,
  ChevronLeft,
  ChevronRight,
  CircleCheckBig,
  Clock3,
  Copy,
  Download,
  FolderInput,
  Folder,
  FolderPlus,
  FileText,
  List,
  ListChecks,
  ListTodo,
  Link2,
  Merge,
  ImagePlus,
  Keyboard,
  Mic,
  Paperclip,
  Pin,
  PinOff,
  Plus,
  RotateCcw,
  RefreshCw,
  Repeat2,
  Save,
  Search,
  Settings2,
  Square,
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
  | "calendar"
  | "close"
  | "copy"
  | "delete"
  | "done"
  | "download"
  | "filters"
  | "file"
  | "folder"
  | "create-project"
  | "merge"
  | "move"
  | "image"
  | "keyboard"
  | "link"
  | "attachment"
  | "badge"
  | "mic"
  | "next"
  | "open"
  | "restore"
  | "retry"
  | "repeat"
  | "save"
  | "search"
  | "settings"
  | "stop"
  | "select"
  | "snooze"
  | "undo"
  | "previous"
  | "pin"
  | "unpin"
  | "view-all"
  | "view-open"
  | "wake";

const icons: Record<ActionIconName, ComponentType<LucideProps>> = {
  add: Plus,
  cancel: X,
  camera: Camera,
  calendar: CalendarDays,
  close: X,
  copy: Copy,
  delete: Trash2,
  done: CircleCheckBig,
  download: Download,
  filters: SlidersHorizontal,
  file: FileText,
  folder: Folder,
  "create-project": FolderPlus,
  merge: Merge,
  move: FolderInput,
  image: ImagePlus,
  keyboard: Keyboard,
  link: Link2,
  attachment: Paperclip,
  badge: BellDot,
  mic: Mic,
  next: ChevronRight,
  open: RotateCcw,
  restore: RotateCcw,
  retry: RefreshCw,
  repeat: Repeat2,
  save: Save,
  search: Search,
  settings: Settings2,
  stop: Square,
  select: ListChecks,
  snooze: Clock3,
  undo: Undo2,
  previous: ChevronLeft,
  pin: Pin,
  unpin: PinOff,
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
