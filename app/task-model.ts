import type { QuickSnoozePreset } from "../lib/snooze-presets";
import type { RealtimeVoice } from "../lib/ai-preferences";
import type { OfflineCaptureDraft, OfflineTodoRecord } from "./offline-store";

export type Todo = {
  id: number;
  title: string;
  notes: string;
  status: "open" | "completed";
  priority: number;
  dueDate: string | null;
  project: string | null;
  context: string | null;
  sourceKind: string | null;
  sourceId: number | null;
  completedAt: string | null;
  snoozedUntil: string | null;
  recurrenceCron: string | null;
  recurrenceLastFiredAt: string | null;
  pinned: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  attachmentCount: number;
  clientId: string | null;
  offline?: boolean;
};

export type TodoSettings = {
  snoozeTimeZone: string;
  snoozeWakeHour: number;
  snoozeQuickPresets: QuickSnoozePreset[];
  realtimeVoice: RealtimeVoice;
};

export type CaptureDraft = Omit<OfflineCaptureDraft, "key">;

export type BootstrapResponse = {
  todos: Todo[];
  projects: string[];
  settings: TodoSettings;
  captureDraft: CaptureDraft | null;
  revision: number;
  serverTime: string;
};

export type SyncResponse = ({
  reset: false;
  revision: number;
  todos: Todo[];
  deletedIds: number[];
  projects?: string[];
  settings?: TodoSettings;
  captureDraft?: CaptureDraft | null;
} | {
  reset: true;
  reason: string;
  revision: number;
  todos: Todo[];
  projects: string[];
  settings: TodoSettings;
  captureDraft: CaptureDraft | null;
}) & { serverTime: string };


export function taskKey(todo: Pick<Todo, "id" | "clientId">) { return todo.clientId ?? `server:${todo.id}`; }

export function offlineRecordTodo(record: OfflineTodoRecord): Todo {
  return {
    id: record.localId,
    clientId: record.clientId,
    title: record.title,
    notes: record.notes,
    status: record.status ?? "open",
    priority: record.priority ?? 3,
    dueDate: record.dueDate ?? null,
    project: record.project ?? null,
    context: record.context ?? null,
    sourceKind: record.sourceKind ?? "offline",
    sourceId: record.sourceId ?? null,
    completedAt: record.completedAt ?? null,
    snoozedUntil: record.snoozedUntil ?? null,
    recurrenceCron: record.recurrenceCron ?? null,
    recurrenceLastFiredAt: record.recurrenceLastFiredAt ?? null,
    pinned: record.pinned ?? false,
    sortOrder: record.sortOrder ?? -new Date(record.createdAt).valueOf(),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt ?? record.createdAt,
    attachmentCount: record.attachments.length,
    offline: record.localId < 0,
  };
}

export function createLocalTaskId() {
  const bits = crypto.getRandomValues(new Uint32Array(2));
  return -(((bits[0] & 0x1fffff) * 0x100000000 + bits[1]) || 1);
}
