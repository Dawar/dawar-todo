import type { ComponentType } from "react";
import {
  AlarmClock,
  BellDot,
  CalendarDays,
  Camera,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleCheckBig,
  Clock3,
  Copy,
  Download,
  Eye,
  FolderInput,
  Folder,
  FolderPlus,
  FileText,
  List,
  ListChecks,
  ListTodo,
  Link2,
  Menu,
  Merge,
  ImagePlus,
  Keyboard,
  Mic,
  MicOff,
  Paperclip,
  Pencil,
  PhoneCall,
  Pin,
  PinOff,
  Plus,
  RotateCcw,
  RefreshCw,
  Repeat2,
  Save,
  Search,
  Settings2,
  Sparkles,
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
  | "down"
  | "filters"
  | "file"
  | "folder"
  | "create-project"
  | "merge"
  | "move"
  | "edit"
  | "image"
  | "keyboard"
  | "link"
  | "menu"
  | "attachment"
  | "badge"
  | "mic"
  | "mic-off"
  | "next"
  | "open"
  | "phone"
  | "preview"
  | "restore"
  | "retry"
  | "repeat"
  | "save"
  | "search"
  | "settings"
  | "assistant"
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
  down: ChevronDown,
  filters: SlidersHorizontal,
  file: FileText,
  folder: Folder,
  "create-project": FolderPlus,
  merge: Merge,
  move: FolderInput,
  edit: Pencil,
  image: ImagePlus,
  keyboard: Keyboard,
  link: Link2,
  menu: Menu,
  attachment: Paperclip,
  badge: BellDot,
  mic: Mic,
  "mic-off": MicOff,
  next: ChevronRight,
  open: RotateCcw,
  phone: PhoneCall,
  preview: Eye,
  restore: RotateCcw,
  retry: RefreshCw,
  repeat: Repeat2,
  save: Save,
  search: Search,
  settings: Settings2,
  assistant: Sparkles,
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
