"use client";

import {
  FormEvent,
  PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { SiteHeader } from "./site-header";

type TodoStatus = "open" | "completed" | "archived";
type View = "open" | "today" | "snoozed" | "completed" | "archived" | "all";
type Sort = "smart" | "priority" | "due" | "newest" | "oldest" | "az";
type TodoAction = "complete" | "archive" | "snooze" | "unsnooze" | "delete";
type Notice = { tone: "success" | "error"; text: string; undoToken?: string } | null;

type Todo = {
  id: number;
  title: string;
  notes: string;
  status: TodoStatus;
  priority: number;
  dueDate: string | null;
  project: string | null;
  context: string | null;
  sourceKind: string | null;
  sourceId: number | null;
  completedAt: string | null;
  snoozedUntil: string | null;
  createdAt: string;
  updatedAt: string;
};

type TodoDraft = Pick<Todo, "title" | "notes" | "priority"> & {
  dueDate: string;
  project: string;
  context: string;
};

type ProjectDialogState = {
  ids: number[];
  mode: "archive" | "move";
  selection: string;
  newProject: string;
};

const CREATE_PROJECT = "__create_project__";
const UNASSIGNED_PROJECT = "__unassigned_project__";

const viewLabels: Record<View, string> = {
  open: "Open",
  today: "Today",
  snoozed: "Snoozed",
  completed: "Done",
  archived: "Archived",
  all: "All",
};

const priorityLabels: Record<number, string> = {
  1: "Urgent",
  2: "High",
  3: "Normal",
  4: "Low",
};

function request<T>(path: string, options?: RequestInit): Promise<T> {
  return fetch(path, {
    ...options,
    headers: options?.body ? { "Content-Type": "application/json", ...(options.headers ?? {}) } : options?.headers,
  }).then(async (response) => {
    const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (!response.ok) throw new Error(payload.error || "Something went wrong.");
    return payload;
  });
}

function isTodayOrOverdue(value: string | null) {
  if (!value) return false;
  const due = new Date(value);
  if (Number.isNaN(due.valueOf())) return false;
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return due <= end;
}

function isSnoozed(todo: Todo, now: number) {
  return todo.status === "open" && Boolean(todo.snoozedUntil) && new Date(todo.snoozedUntil as string).valueOf() > now;
}

function dueLabel(value: string) {
  const due = new Date(value);
  if (Number.isNaN(due.valueOf())) return value;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).valueOf();
  const date = new Date(due.getFullYear(), due.getMonth(), due.getDate()).valueOf();
  const day = 86_400_000;
  if (date < today) return `Overdue · ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(due)}`;
  if (date === today) return "Due today";
  if (date === today + day) return "Due tomorrow";
  return `Due ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(due)}`;
}

function snoozeLabel(value: string) {
  const wake = new Date(value);
  if (Number.isNaN(wake.valueOf())) return "Snoozed";
  return `Wakes ${new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }).format(wake)}`;
}

function dateInputValue(value: string | null) {
  return value?.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? "";
}

function compareSmart(a: Todo, b: Todo) {
  const aDue = a.dueDate ? new Date(a.dueDate).valueOf() : Number.POSITIVE_INFINITY;
  const bDue = b.dueDate ? new Date(b.dueDate).valueOf() : Number.POSITIVE_INFINITY;
  if (aDue !== bDue) return aDue - bDue;
  if (a.priority !== b.priority) return a.priority - b.priority;
  return new Date(b.updatedAt).valueOf() - new Date(a.updatedAt).valueOf();
}

function matchesView(todo: Todo, view: View, now: number) {
  const snoozed = isSnoozed(todo, now);
  if (view === "open") return todo.status === "open" && !snoozed;
  if (view === "today") return todo.status === "open" && !snoozed && isTodayOrOverdue(todo.dueDate);
  if (view === "snoozed") return snoozed;
  if (view === "completed") return todo.status === "completed";
  if (view === "archived") return todo.status === "archived";
  return true;
}

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function TaskRow({
  todo,
  selected,
  now,
  onSelect,
  onAction,
  onProject,
  onOpen,
}: {
  todo: Todo;
  selected: boolean;
  now: number;
  onSelect: (todo: Todo) => void;
  onAction: (todo: Todo, action: TodoAction, source: "hover" | "swipe") => void;
  onProject: (todo: Todo, source: "hover" | "swipe") => void;
  onOpen: (todo: Todo) => void;
}) {
  const [offset, setOffset] = useState(0);
  const [swipeWidth, setSwipeWidth] = useState(1);
  const [dragging, setDragging] = useState(false);
  const gesture = useRef<{ startX: number; startY: number; width: number } | null>(null);
  const offsetRef = useRef(0);
  const suppressOpenRef = useRef(false);
  const pending = todo.id < 0;
  const snoozed = isSnoozed(todo, now);
  const primaryAction: { action: TodoAction; label: string } = snoozed
    ? { action: "unsnooze", label: "Wake" }
    : todo.status === "open"
      ? { action: "complete", label: "Done" }
      : { action: "unsnooze", label: "Open" };
  const swipeRatio = Math.abs(offset) / swipeWidth;
  const longSwipe = swipeRatio >= 0.5;
  const revealAction = offset < 0
    ? (longSwipe ? "Snooze" : primaryAction.label)
    : (longSwipe ? "Delete" : todo.status === "archived" ? "Move" : "Archive");
  const revealClass = offset < 0
    ? longSwipe ? "bg-amber-500" : "bg-[#216e4e]"
    : longSwipe ? "bg-red-600" : "bg-slate-500";

  function pointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (pending || event.pointerType !== "touch") return;
    if ((event.target as HTMLElement).closest("input, [data-row-action], a, select, textarea")) return;
    suppressOpenRef.current = false;
    const width = event.currentTarget.getBoundingClientRect().width;
    gesture.current = {
      startX: event.clientX,
      startY: event.clientY,
      width,
    };
    setSwipeWidth(width);
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function pointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const active = gesture.current;
    if (!active) return;
    const deltaX = event.clientX - active.startX;
    const deltaY = event.clientY - active.startY;
    if (Math.abs(deltaY) > Math.abs(deltaX) && Math.abs(deltaY) > 10) {
      gesture.current = null;
      setDragging(false);
      offsetRef.current = 0;
      setOffset(0);
      return;
    }
    const limit = active.width * 0.62;
    if (Math.abs(deltaX) > 8) suppressOpenRef.current = true;
    const nextOffset = Math.max(-limit, Math.min(limit, deltaX));
    offsetRef.current = nextOffset;
    setOffset(nextOffset);
  }

  function finishSwipe() {
    const active = gesture.current;
    gesture.current = null;
    setDragging(false);
    if (!active) {
      setOffset(0);
      return;
    }
    const completedOffset = offsetRef.current;
    const ratio = Math.abs(completedOffset) / active.width;
    const direction = Math.sign(completedOffset);
    offsetRef.current = 0;
    setOffset(0);
    if (ratio < 0.18 || direction === 0) return;
    if (direction < 0) onAction(todo, ratio >= 0.5 ? "snooze" : primaryAction.action, "swipe");
    else if (ratio >= 0.5) onAction(todo, "delete", "swipe");
    else if (todo.status === "archived") onProject(todo, "swipe");
    else onAction(todo, "archive", "swipe");
  }

  function cancelSwipe() {
    gesture.current = null;
    offsetRef.current = 0;
    setDragging(false);
    setOffset(0);
  }

  const hoverActions: Array<{ action: TodoAction | "move"; label: string }> = [
    primaryAction,
    ...(!snoozed && todo.status === "open" ? [{ action: "snooze" as const, label: "Snooze" }] : []),
    ...(todo.status === "archived"
      ? [{ action: "move" as const, label: "Move" }]
      : [{ action: "archive" as const, label: "Archive" }]),
    { action: "delete", label: "Delete" },
  ];

  return (
    <li className={classNames("group relative overflow-hidden", selected && "ring-1 ring-inset ring-[#216e4e]/30")}>
      <div className={classNames("absolute inset-0 flex items-center justify-between px-5 text-sm font-semibold text-white md:hidden", revealClass)} aria-hidden="true">
        <span className={classNames("transition-opacity", offset > 0 ? "opacity-100" : "opacity-0")}>{revealAction}</span>
        <span className={classNames("transition-opacity", offset < 0 ? "opacity-100" : "opacity-0")}>{revealAction}</span>
      </div>
      <div
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={finishSwipe}
        onPointerCancel={cancelSwipe}
        style={{ transform: `translateX(${offset}px)` }}
        className={classNames(
          "relative flex min-h-[72px] touch-pan-y items-start gap-3 bg-white px-4 py-4 hover:bg-[#fafbf9] sm:px-5",
          !dragging && "transition-transform duration-200 ease-out",
          selected && "bg-[#f3f8f5] hover:bg-[#f3f8f5]",
        )}
      >
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onSelect(todo)}
          disabled={pending}
          aria-label={`Select: ${todo.title}`}
          className={classNames("mt-0.5 h-5 w-5 shrink-0 cursor-pointer rounded border-[#9da6a0] accent-[#216e4e] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#216e4e]", pending && "animate-pulse")}
        />
        <button
          type="button"
          onClick={() => {
            if (suppressOpenRef.current) {
              suppressOpenRef.current = false;
              return;
            }
            onOpen(todo);
          }}
          disabled={pending}
          aria-label={`Open details: ${todo.title}`}
          className="min-w-0 flex-1 rounded-lg text-left focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#216e4e] disabled:cursor-default"
        >
          <p className={classNames("whitespace-pre-wrap text-[15px] leading-5 text-[#202522]", todo.status === "completed" && "text-[#8b928e] line-through")}>{todo.title}</p>
          {todo.notes && <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-xs leading-5 text-[#7c847f]">{todo.notes}</p>}
          {(todo.project || todo.context || todo.dueDate || todo.priority <= 2 || snoozed || todo.status === "archived") && (
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[#747c77]">
              {todo.priority <= 2 && <span className={classNames("rounded-full px-2 py-0.5 font-medium", todo.priority === 1 ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-700")}>{priorityLabels[todo.priority]}</span>}
              {todo.project && <span className="rounded-full bg-[#f0f2ef] px-2 py-0.5">{todo.project}</span>}
              {todo.context && <span>{todo.context}</span>}
              {todo.dueDate && <span className={classNames(isTodayOrOverdue(todo.dueDate) && todo.status === "open" && !snoozed && "font-medium text-red-600")}>{dueLabel(todo.dueDate)}</span>}
              {snoozed && todo.snoozedUntil && <span className="font-medium text-amber-700">{snoozeLabel(todo.snoozedUntil)}</span>}
              {todo.status === "archived" && <span className="font-medium text-slate-600">Archived</span>}
            </div>
          )}
        </button>
        {!pending && (
          <div className="hidden shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 md:flex">
            {hoverActions.map(({ action, label }) => (
              <button
                key={action}
                type="button"
                data-row-action
                onClick={() => action === "move" ? onProject(todo, "hover") : onAction(todo, action, "hover")}
                aria-label={`${label}: ${todo.title}`}
                className={classNames(
                  "rounded-lg px-2 py-1.5 text-xs font-medium text-[#69716c] transition hover:bg-[#eef0ed] hover:text-[#252a27] focus-visible:outline-2 focus-visible:outline-[#216e4e]",
                  action === "delete" && "hover:bg-red-50 hover:text-red-700",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

export default function Home() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>("open");
  const [query, setQuery] = useState("");
  const [project, setProject] = useState("");
  const [priority, setPriority] = useState("");
  const [sort, setSort] = useState<Sort>("smart");
  const [newTitle, setNewTitle] = useState("");
  const [adding, setAdding] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<TodoDraft | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [projectDialog, setProjectDialog] = useState<ProjectDialogState | null>(null);
  const [projectDialogError, setProjectDialogError] = useState("");
  const [savingProject, setSavingProject] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [now, setNow] = useState(() => Date.now());
  const captureRef = useRef<HTMLTextAreaElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const overlayOpen = editingId !== null || projectDialog !== null || filtersOpen;

  useEffect(() => {
    let active = true;
    request<{ todos: Todo[] }>("/api/todos")
      .then(({ todos: loaded }) => {
        if (!active) return;
        setTodos(loaded);
        console.info("[todo-ui] loaded", {
          count: loaded.length,
          open: loaded.filter((todo) => todo.status === "open").length,
          archived: loaded.filter((todo) => todo.status === "archived").length,
          snoozed: loaded.filter((todo) => isSnoozed(todo, Date.now())).length,
        });
      })
      .catch((error: Error) => active && setNotice({ tone: "error", text: error.message }))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), notice.undoToken ? 8_000 : 5_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const typing = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
      if (event.key === "/" && !typing) {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key.toLowerCase() === "n" && !typing) {
        event.preventDefault();
        captureRef.current?.focus();
      }
      if (event.key === "Escape" && projectDialog !== null) {
        setProjectDialog(null);
        setProjectDialogError("");
      } else if (event.key === "Escape" && editingId !== null) {
        setEditingId(null);
        setEditDraft(null);
      } else if (event.key === "Escape" && target === searchRef.current) {
        setQuery("");
        searchRef.current?.blur();
      } else if (event.key === "Escape" && filtersOpen) {
        setFiltersOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editingId, filtersOpen, projectDialog]);

  useEffect(() => {
    if (!overlayOpen) return;
    const body = document.body;
    const previousOverflow = body.style.overflow;
    const previousPaddingRight = body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    body.style.overflow = "hidden";
    if (scrollbarWidth > 0) body.style.paddingRight = `${scrollbarWidth}px`;
    return () => {
      body.style.overflow = previousOverflow;
      body.style.paddingRight = previousPaddingRight;
    };
  }, [overlayOpen]);

  const projects = useMemo(
    () => [...new Set(todos.map((todo) => todo.project).filter((value): value is string => Boolean(value)))].sort(),
    [todos],
  );

  const archivedProjectOptions = useMemo(() => {
    const projectCounts = new Map<string, number>();
    todos.filter((todo) => todo.status === "archived").forEach((todo) => {
      const key = todo.project || UNASSIGNED_PROJECT;
      projectCounts.set(key, (projectCounts.get(key) ?? 0) + 1);
    });
    return [...projectCounts.entries()].sort(([a], [b]) => {
      if (a === UNASSIGNED_PROJECT) return 1;
      if (b === UNASSIGNED_PROJECT) return -1;
      return a.localeCompare(b);
    });
  }, [todos]);

  const counts = useMemo(() => ({
    open: todos.filter((todo) => matchesView(todo, "open", now)).length,
    today: todos.filter((todo) => matchesView(todo, "today", now)).length,
    snoozed: todos.filter((todo) => matchesView(todo, "snoozed", now)).length,
    completed: todos.filter((todo) => matchesView(todo, "completed", now)).length,
    archived: todos.filter((todo) => matchesView(todo, "archived", now)).length,
    all: todos.length,
  }), [todos, now]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const rows = todos.filter((todo) => {
      const searchable = [todo.title, todo.notes, todo.project, todo.context].filter(Boolean).join(" ").toLowerCase();
      return matchesView(todo, view, now)
        && (!needle || searchable.includes(needle))
        && (!project || (project === UNASSIGNED_PROJECT ? !todo.project : todo.project === project))
        && (!priority || todo.priority === Number(priority));
    });
    return [...rows].sort((a, b) => {
      if (sort === "priority") return a.priority - b.priority || compareSmart(a, b);
      if (sort === "due") return (a.dueDate ? new Date(a.dueDate).valueOf() : Infinity) - (b.dueDate ? new Date(b.dueDate).valueOf() : Infinity);
      if (sort === "newest") return new Date(b.createdAt).valueOf() - new Date(a.createdAt).valueOf();
      if (sort === "oldest") return new Date(a.createdAt).valueOf() - new Date(b.createdAt).valueOf();
      if (sort === "az") return a.title.localeCompare(b.title);
      return compareSmart(a, b);
    });
  }, [todos, view, query, project, priority, sort, now]);

  const selectedIds = useMemo(() => [...selected], [selected]);
  const allVisibleSelected = filtered.length > 0 && filtered.every((todo) => selected.has(todo.id));
  const filtersActive = Boolean(query || project || priority || sort !== "smart");
  const mobileFilterCount = Number(Boolean(project)) + Number(Boolean(priority)) + Number(sort !== "smart");
  const editingTodo = editingId === null ? null : todos.find((todo) => todo.id === editingId) ?? null;

  function resizeCapture(textarea: HTMLTextAreaElement) {
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
    textarea.style.overflowY = textarea.scrollHeight > 120 ? "auto" : "hidden";
  }

  async function addTodo(event: FormEvent) {
    event.preventDefault();
    const title = newTitle.trim();
    if (!title || adding) return;
    const temporaryId = -Date.now();
    const optimistic: Todo = {
      id: temporaryId,
      title,
      notes: "",
      status: "open",
      priority: 3,
      dueDate: null,
      project: null,
      context: null,
      sourceKind: "site",
      sourceId: null,
      completedAt: null,
      snoozedUntil: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    setNewTitle("");
    setView("open");
    setTodos((current) => [optimistic, ...current]);
    setAdding(true);
    setSyncing(true);
    setNotice(null);
    if (captureRef.current) {
      captureRef.current.style.height = "auto";
      captureRef.current.style.overflowY = "hidden";
    }
    try {
      const { todo } = await request<{ todo: Todo }>("/api/todos", {
        method: "POST",
        body: JSON.stringify({ title }),
      });
      setTodos((current) => current.map((item) => item.id === temporaryId ? todo : item));
      console.info("[todo-ui] created", { id: todo.id, titleLength: title.length, lines: title.split("\n").length });
    } catch (error) {
      setTodos((current) => current.filter((item) => item.id !== temporaryId));
      setNewTitle(title);
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "The task could not be added." });
    } finally {
      setAdding(false);
      setSyncing(false);
      captureRef.current?.focus();
    }
  }

  function applyOptimisticAction(current: Todo[], ids: number[], action: TodoAction, actionAt: string) {
    const idSet = new Set(ids);
    if (action === "delete") return current.filter((todo) => !idSet.has(todo.id));
    const temporarySnooze = new Date(new Date(actionAt).valueOf() + 36 * 60 * 60 * 1000).toISOString();
    return current.map((todo) => {
      if (!idSet.has(todo.id)) return todo;
      if (action === "complete") return { ...todo, status: "completed" as const, completedAt: actionAt, snoozedUntil: null };
      if (action === "archive") return { ...todo, status: "archived" as const, snoozedUntil: null };
      if (action === "snooze") return { ...todo, status: "open" as const, completedAt: null, snoozedUntil: temporarySnooze };
      return { ...todo, status: "open" as const, completedAt: null, snoozedUntil: null };
    });
  }

  async function performAction(ids: number[], action: TodoAction | "merge") {
    if (!ids.length || syncing) return;
    const previous = todos;
    const actionAt = new Date().toISOString();
    setSyncing(true);
    setNotice(null);
    if (action !== "merge") setTodos((current) => applyOptimisticAction(current, ids, action, actionAt));
    try {
      if (action === "merge") {
        const result = await request<{ todo: Todo; ids: number[]; undoToken: string }>("/api/todos/bulk", {
          method: "POST",
          body: JSON.stringify({ ids, action }),
        });
        const sourceIds = new Set(result.ids);
        setTodos((current) => [
          result.todo,
          ...current.map((todo) => sourceIds.has(todo.id) ? { ...todo, status: "archived" as const, project: todo.project || "Misc.", snoozedUntil: null } : todo),
        ]);
        setNotice({ tone: "success", text: `Merged ${result.ids.length} tasks.`, undoToken: result.undoToken });
        console.info("[todo-ui] merged", { sourceIds: result.ids, mergedId: result.todo.id });
      } else {
        const result = await request<{ todos: Todo[]; ids: number[]; snoozedUntil: string | null; undoToken: string }>("/api/todos/bulk", {
          method: "POST",
          body: JSON.stringify({ ids, action }),
        });
        if (action !== "delete") {
          const updates = new Map(result.todos.map((todo) => [todo.id, todo]));
          setTodos((current) => current.map((todo) => updates.get(todo.id) ?? todo));
        }
        const openedCompleted = action === "unsnooze" && ids.every((id) => previous.find((todo) => todo.id === id)?.status === "completed");
        const label = action === "complete" ? "Done" : action === "archive" ? "Archived" : action === "snooze" ? "Snoozed until tomorrow" : action === "unsnooze" ? openedCompleted ? "Opened" : "Restored to Open" : "Deleted";
        setNotice({ tone: "success", text: `${label}: ${ids.length} ${ids.length === 1 ? "task" : "tasks"}.`, undoToken: result.undoToken });
        console.info("[todo-ui] action completed", { action, ids, snoozedUntil: result.snoozedUntil });
      }
      setSelected((current) => {
        const next = new Set(current);
        ids.forEach((id) => next.delete(id));
        return next;
      });
    } catch (error) {
      setTodos(previous);
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "The action could not be completed." });
      console.error("[todo-ui] action failed", { action, ids, error });
    } finally {
      setSyncing(false);
    }
  }

  async function undoAction(undoToken: string) {
    if (undoing) return;
    setUndoing(true);
    try {
      const result = await request<{ todos: Todo[]; restored: number }>("/api/todos/undo", {
        method: "POST",
        body: JSON.stringify({ undoToken }),
      });
      setTodos(result.todos);
      setSelected(new Set());
      setNotice({ tone: "success", text: `Undone: ${result.restored} ${result.restored === 1 ? "task" : "tasks"} restored.` });
      console.info("[todo-ui] action undone", { restored: result.restored });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "That action could not be undone." });
      console.error("[todo-ui] undo failed", error);
    } finally {
      setUndoing(false);
    }
  }

  function openProjectAssignment(ids: number[], mode: "archive" | "move", source: "bulk" | "hover" | "swipe" | "details") {
    const taskProjects = todos
      .filter((todo) => ids.includes(todo.id))
      .map((todo) => todo.project || UNASSIGNED_PROJECT);
    const sharedProject = new Set(taskProjects).size === 1 ? taskProjects[0] : "";
    const selection = mode === "archive" && sharedProject === UNASSIGNED_PROJECT ? "" : sharedProject;
    setProjectDialog({ ids, mode, selection, newProject: "" });
    setProjectDialogError("");
    console.info("[todo-ui] project assignment opened", { ids, mode, source, sharedProject: sharedProject || null });
  }

  function closeProjectAssignment() {
    if (savingProject) return;
    setProjectDialog(null);
    setProjectDialogError("");
  }

  async function saveProjectAssignment(event: FormEvent) {
    event.preventDefault();
    if (!projectDialog || savingProject) return;
    const projectName = projectDialog.selection === CREATE_PROJECT
      ? projectDialog.newProject.trim()
      : projectDialog.selection === UNASSIGNED_PROJECT
        ? null
        : projectDialog.selection.trim() || null;
    if (projectDialog.mode === "archive" && !projectName) {
      setProjectDialogError("Choose an existing project or create a new one.");
      return;
    }
    if (projectName && projectName.length > 120) {
      setProjectDialogError("Project names are limited to 120 characters.");
      return;
    }

    const { ids, mode } = projectDialog;
    setSavingProject(true);
    setProjectDialogError("");
    setNotice(null);
    try {
      const action = mode === "archive" ? "archive" : "reproject";
      const result = await request<{ todos: Todo[]; ids: number[]; undoToken: string }>("/api/todos/bulk", {
        method: "POST",
        body: JSON.stringify({ ids, action, project: projectName }),
      });
      const updates = new Map(result.todos.map((todo) => [todo.id, todo]));
      setTodos((current) => current.map((todo) => updates.get(todo.id) ?? todo));
      setSelected((current) => {
        const next = new Set(current);
        ids.forEach((id) => next.delete(id));
        return next;
      });
      setProjectDialog(null);
      const location = projectName || "Unassigned";
      setNotice({
        tone: "success",
        text: mode === "archive"
          ? `Archived into ${location}: ${ids.length} ${ids.length === 1 ? "note" : "notes"}.`
          : `Moved to ${location}: ${ids.length} ${ids.length === 1 ? "note" : "notes"}.`,
        undoToken: result.undoToken,
      });
      console.info("[todo-ui] project assignment saved", { ids, mode, project: projectName });
    } catch (error) {
      const message = error instanceof Error ? error.message : "The project could not be assigned.";
      setProjectDialogError(message);
      console.error("[todo-ui] project assignment failed", { ids, mode, project: projectName, error });
    } finally {
      setSavingProject(false);
    }
  }

  function openTaskDetails(todo: Todo) {
    if (todo.id < 1) return;
    setEditingId(todo.id);
    setEditDraft({
      title: todo.title,
      notes: todo.notes,
      priority: todo.priority,
      dueDate: dateInputValue(todo.dueDate),
      project: todo.project ?? "",
      context: todo.context ?? "",
    });
    console.info("[todo-ui] task details opened", { id: todo.id, status: todo.status });
  }

  function closeTaskDetails() {
    setEditingId(null);
    setEditDraft(null);
  }

  async function saveTaskDetails(event: FormEvent) {
    event.preventDefault();
    if (!editingTodo || !editDraft || savingEdit) return;
    const title = editDraft.title.trim();
    if (!title) {
      setNotice({ tone: "error", text: "A task title is required." });
      return;
    }
    setSavingEdit(true);
    setNotice(null);
    try {
      const result = await request<{ todo: Todo; undoToken: string }>(`/api/todos/${editingTodo.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          title,
          notes: editDraft.notes,
          priority: editDraft.priority,
          dueDate: editDraft.dueDate || null,
          project: editDraft.project || null,
          context: editDraft.context || null,
        }),
      });
      setTodos((current) => current.map((todo) => todo.id === result.todo.id ? result.todo : todo));
      closeTaskDetails();
      setNotice({ tone: "success", text: "Task details saved.", undoToken: result.undoToken });
      console.info("[todo-ui] task details saved", {
        id: result.todo.id,
        titleLength: result.todo.title.length,
        notesLength: result.todo.notes.length,
      });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "The task details could not be saved." });
      console.error("[todo-ui] task details save failed", { id: editingTodo.id, error });
    } finally {
      setSavingEdit(false);
    }
  }

  function taskAction(todo: Todo, action: TodoAction, source: "hover" | "swipe" | "details") {
    console.info("[todo-ui] task action requested", { id: todo.id, action, source });
    if (action === "archive") {
      openProjectAssignment([todo.id], "archive", source);
      return;
    }
    void performAction([todo.id], action);
  }

  function moveArchivedTask(todo: Todo, source: "hover" | "swipe") {
    openProjectAssignment([todo.id], "move", source);
  }

  function detailAction(action: TodoAction) {
    if (!editingTodo) return;
    const todo = editingTodo;
    closeTaskDetails();
    taskAction(todo, action, "details");
  }

  function bulkAction(action: TodoAction | "merge") {
    if (action === "merge" && selectedIds.length < 2) {
      setNotice({ tone: "error", text: "Select at least two tasks to merge." });
      return;
    }
    if (action === "archive") {
      openProjectAssignment(selectedIds, view === "archived" ? "move" : "archive", "bulk");
      return;
    }
    void performAction(selectedIds, action);
  }

  function toggleSelected(todo: Todo) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(todo.id)) next.delete(todo.id);
      else next.add(todo.id);
      return next;
    });
  }

  function toggleVisible() {
    setSelected((current) => {
      const next = new Set(current);
      if (allVisibleSelected) filtered.forEach((todo) => next.delete(todo.id));
      else filtered.forEach((todo) => next.add(todo.id));
      return next;
    });
  }

  function chooseView(next: View) {
    setView(next);
    if (next !== "archived" && project === UNASSIGNED_PROJECT) setProject("");
    setSelected(new Set());
  }

  return (
    <main className="min-h-screen bg-[#f6f7f5] text-[#1d211f]">
      <SiteHeader current="todos" />
      <div className="mx-auto max-w-5xl px-4 pb-28 pt-5 sm:px-6 sm:pt-7">
        <form onSubmit={addTodo} className="mb-5 flex items-end gap-2 rounded-2xl border border-black/[0.07] bg-white p-2 shadow-[0_10px_35px_rgba(30,45,36,0.07)] sm:p-3">
          <div className="flex min-w-0 flex-1 items-start gap-3 px-2 py-2 sm:px-3">
            <span className="mt-0.5 text-xl text-[#216e4e]" aria-hidden="true">＋</span>
            <textarea
              ref={captureRef}
              value={newTitle}
              onChange={(event) => { setNewTitle(event.target.value); resizeCapture(event.currentTarget); }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              rows={1}
              placeholder="Add a task…"
              aria-label="Add a task"
              maxLength={2000}
              className="min-h-6 max-h-[120px] min-w-0 flex-1 resize-none overflow-hidden bg-transparent text-[16px] leading-6 text-[#151816] outline-none placeholder:text-[#929994]"
            />
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="hidden text-[10px] text-[#929994] sm:block">⌘↵ add</span>
            <button
              type="submit"
              disabled={!newTitle.trim() || adding}
              className="h-11 rounded-xl bg-[#216e4e] px-4 text-sm font-semibold text-white transition hover:bg-[#195d41] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#216e4e] disabled:cursor-not-allowed disabled:opacity-40 sm:px-6"
            >
              {adding ? "Adding…" : "Add"}
            </button>
          </div>
        </form>

        <section aria-labelledby="tasks-heading">
          <div className="mb-3 flex gap-1 overflow-x-auto rounded-xl border border-black/[0.06] bg-white p-1 shadow-sm">
            {(Object.keys(viewLabels) as View[]).map((item) => (
              <button
                key={item}
                onClick={() => chooseView(item)}
                className={classNames(
                  "flex min-w-max flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-[#216e4e]",
                  view === item ? "bg-[#eaf3ed] text-[#195d41]" : "text-[#69716c] hover:bg-[#f6f7f5] hover:text-[#252a27]",
                )}
              >
                {viewLabels[item]}
                <span className={classNames("rounded-full px-1.5 py-0.5 text-[11px]", view === item ? "bg-white/80" : "bg-[#f1f2f0]")}>{counts[item]}</span>
              </button>
            ))}
          </div>

          <div className="mb-3 grid grid-cols-[minmax(0,1fr)_auto] gap-2 sm:grid-cols-[minmax(220px,1fr)_auto_auto_auto]">
            <label className="flex h-10 items-center gap-2 rounded-xl border border-black/[0.08] bg-white px-3 shadow-sm focus-within:border-[#216e4e]/50 focus-within:ring-3 focus-within:ring-[#216e4e]/10">
              <span className="text-[#7c847f]" aria-hidden="true">⌕</span>
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search tasks"
                aria-label="Search tasks"
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[#929994]"
              />
              <kbd className="hidden rounded border border-black/10 bg-[#f6f7f5] px-1.5 py-0.5 text-[10px] text-[#7c847f] sm:block">/</kbd>
            </label>
            <button
              type="button"
              onClick={() => setFiltersOpen(true)}
              className={classNames(
                "flex h-10 items-center gap-2 rounded-xl border bg-white px-3 text-sm font-medium shadow-sm transition focus-visible:outline-2 focus-visible:outline-[#216e4e] sm:hidden",
                mobileFilterCount ? "border-[#216e4e]/30 text-[#195d41]" : "border-black/[0.08] text-[#4f5752]",
              )}
              aria-label={`Filters${mobileFilterCount ? `, ${mobileFilterCount} active` : ""}`}
            >
              <span aria-hidden="true">≡</span>
              <span>Filters</span>
              {mobileFilterCount > 0 && <span className="grid h-5 min-w-5 place-items-center rounded-full bg-[#216e4e] px-1 text-[10px] text-white">{mobileFilterCount}</span>}
            </button>
            <select value={project} onChange={(event) => setProject(event.target.value)} aria-label="Filter by project" className="hidden h-10 rounded-xl border border-black/[0.08] bg-white px-3 text-sm text-[#4f5752] shadow-sm outline-none focus:border-[#216e4e]/50 sm:block">
              <option value="">All projects</option>
              {projects.map((name) => <option key={name}>{name}</option>)}
              {view === "archived" && <option value={UNASSIGNED_PROJECT}>Unassigned</option>}
            </select>
            <select value={priority} onChange={(event) => setPriority(event.target.value)} aria-label="Filter by priority" className="hidden h-10 rounded-xl border border-black/[0.08] bg-white px-3 text-sm text-[#4f5752] shadow-sm outline-none focus:border-[#216e4e]/50 sm:block">
              <option value="">All priorities</option>
              <option value="1">Urgent</option>
              <option value="2">High</option>
              <option value="3">Normal</option>
              <option value="4">Low</option>
            </select>
            <select value={sort} onChange={(event) => setSort(event.target.value as Sort)} aria-label="Sort tasks" className="hidden h-10 rounded-xl border border-black/[0.08] bg-white px-3 text-sm text-[#4f5752] shadow-sm outline-none focus:border-[#216e4e]/50 sm:block">
              <option value="smart">Smart sort</option>
              <option value="priority">Priority</option>
              <option value="due">Due date</option>
              <option value="newest">Newest</option>
              <option value="oldest">Oldest</option>
              <option value="az">A–Z</option>
            </select>
          </div>

          {filtersOpen && (
            <div className="fixed inset-0 z-50 sm:hidden" role="dialog" aria-modal="true" aria-labelledby="mobile-filters-title">
              <button type="button" aria-label="Close filters" onClick={() => setFiltersOpen(false)} className="absolute inset-0 bg-black/30 backdrop-blur-[2px]" />
              <div className="absolute inset-x-0 bottom-0 rounded-t-3xl bg-white px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4 shadow-2xl">
                <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-black/15" aria-hidden="true" />
                <div className="mb-5 flex items-center justify-between">
                  <div>
                    <h3 id="mobile-filters-title" className="text-lg font-semibold text-[#202522]">Filters & sorting</h3>
                    <p className="mt-0.5 text-xs text-[#7c847f]">Narrow the list without losing workspace.</p>
                  </div>
                  <button type="button" onClick={() => setFiltersOpen(false)} className="grid h-9 w-9 place-items-center rounded-full bg-[#f1f2f0] text-lg text-[#4f5752]" aria-label="Close filters">×</button>
                </div>

                <div className="space-y-4">
                  <label className="block">
                    <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[#69716c]">Project</span>
                    <select value={project} onChange={(event) => setProject(event.target.value)} className="h-12 w-full rounded-xl border border-black/[0.1] bg-white px-3 text-sm text-[#303632] outline-none focus:border-[#216e4e]/50">
                      <option value="">All projects</option>
                      {projects.map((name) => <option key={name}>{name}</option>)}
                      {view === "archived" && <option value={UNASSIGNED_PROJECT}>Unassigned</option>}
                    </select>
                  </label>
                  <label className="block">
                    <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[#69716c]">Priority</span>
                    <select value={priority} onChange={(event) => setPriority(event.target.value)} className="h-12 w-full rounded-xl border border-black/[0.1] bg-white px-3 text-sm text-[#303632] outline-none focus:border-[#216e4e]/50">
                      <option value="">All priorities</option>
                      <option value="1">Urgent</option>
                      <option value="2">High</option>
                      <option value="3">Normal</option>
                      <option value="4">Low</option>
                    </select>
                  </label>
                  <label className="block">
                    <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[#69716c]">Sort</span>
                    <select value={sort} onChange={(event) => setSort(event.target.value as Sort)} className="h-12 w-full rounded-xl border border-black/[0.1] bg-white px-3 text-sm text-[#303632] outline-none focus:border-[#216e4e]/50">
                      <option value="smart">Smart sort</option>
                      <option value="priority">Priority</option>
                      <option value="due">Due date</option>
                      <option value="newest">Newest</option>
                      <option value="oldest">Oldest</option>
                      <option value="az">A–Z</option>
                    </select>
                  </label>
                </div>

                <div className="mt-6 grid grid-cols-2 gap-2">
                  <button type="button" onClick={() => { setProject(""); setPriority(""); setSort("smart"); }} className="h-11 rounded-xl border border-black/[0.08] text-sm font-semibold text-[#4f5752]">Reset</button>
                  <button type="button" onClick={() => setFiltersOpen(false)} className="h-11 rounded-xl bg-[#216e4e] text-sm font-semibold text-white">Show {filtered.length} {filtered.length === 1 ? "task" : "tasks"}</button>
                </div>
              </div>
            </div>
          )}

          {view === "archived" && archivedProjectOptions.length > 0 && (
            <nav aria-label="Filter archived notes by project" className="mb-3 flex max-w-full gap-2 overflow-x-auto pb-0.5">
              <button
                type="button"
                onClick={() => setProject("")}
                className={classNames(
                  "min-w-max rounded-full border px-3 py-1.5 text-xs font-semibold transition",
                  !project ? "border-[#216e4e]/25 bg-[#eaf3ed] text-[#195d41]" : "border-black/[0.08] bg-white text-[#69716c] hover:bg-[#f1f2f0]",
                )}
              >
                All projects <span className="ml-1 opacity-65">{counts.archived}</span>
              </button>
              {archivedProjectOptions.map(([name, count]) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => setProject(name)}
                  className={classNames(
                    "min-w-max rounded-full border px-3 py-1.5 text-xs font-semibold transition",
                    project === name ? "border-[#216e4e]/25 bg-[#eaf3ed] text-[#195d41]" : "border-black/[0.08] bg-white text-[#69716c] hover:bg-[#f1f2f0]",
                  )}
                >
                  {name === UNASSIGNED_PROJECT ? "Unassigned" : name} <span className="ml-1 opacity-65">{count}</span>
                </button>
              ))}
            </nav>
          )}

          <div className="mb-2 flex items-center justify-between px-1">
            <div className="flex items-center gap-3">
              <h2 id="tasks-heading" className="text-sm font-semibold text-[#373d39]">{view === "archived" ? "Archived notes" : `${viewLabels[view]} tasks`}</h2>
              {filtered.length > 0 && <button onClick={toggleVisible} className="text-xs font-medium text-[#216e4e] hover:underline">{allVisibleSelected ? "Clear selection" : "Select visible"}</button>}
            </div>
            <div className="flex items-center gap-3 text-xs text-[#7c847f]">
              <span>{syncing ? "Saving…" : `${filtered.length} ${filtered.length === 1 ? "item" : "items"}`}</span>
              {filtersActive && <button onClick={() => { setQuery(""); setProject(""); setPriority(""); setSort("smart"); }} className="font-medium text-[#216e4e] hover:underline">Clear filters</button>}
            </div>
          </div>

          <p className="mb-2 px-1 text-[11px] text-[#8a918d] md:hidden">Swipe left: {view === "completed" || view === "archived" ? "open" : "done"} / snooze · Swipe right: {view === "archived" ? "move" : "archive"} / delete</p>

          <div className="overflow-hidden rounded-2xl border border-black/[0.07] bg-white shadow-[0_8px_30px_rgba(30,45,36,0.05)]">
            {loading ? (
              <div role="status" className="space-y-1 p-2" aria-label="Loading tasks">
                {[0, 1, 2, 3, 4].map((item) => <div key={item} className="h-[72px] animate-pulse rounded-xl bg-[#f3f4f2]" />)}
              </div>
            ) : filtered.length ? (
              <ul className="divide-y divide-black/[0.055]">
                {filtered.map((todo) => (
                  <TaskRow
                    key={todo.id}
                    todo={todo}
                    selected={selected.has(todo.id)}
                    now={now}
                    onSelect={toggleSelected}
                    onAction={taskAction}
                    onProject={moveArchivedTask}
                    onOpen={openTaskDetails}
                  />
                ))}
              </ul>
            ) : (
              <div className="px-6 py-14 text-center">
                <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-[#eaf3ed] text-xl text-[#216e4e]">✓</div>
                <p className="font-medium text-[#303632]">{filtersActive ? "No tasks match those filters." : view === "snoozed" ? "Nothing is snoozed." : view === "archived" ? "Nothing is archived." : view === "completed" ? "Nothing completed yet." : "You’re clear."}</p>
                <p className="mt-1 text-sm text-[#7c847f]">{filtersActive ? "Try clearing a filter or changing the search." : view === "snoozed" ? "Snoozed tasks return here until their wake time." : "Add the next thing when it appears."}</p>
              </div>
            )}
          </div>
        </section>

        <footer className="mt-5 flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-[#858c87]">
          <span>Private · saved automatically</span>
          <span className="hidden sm:inline"><kbd className="rounded border border-black/10 bg-white px-1.5 py-0.5">N</kbd> new task &nbsp; <kbd className="rounded border border-black/10 bg-white px-1.5 py-0.5">/</kbd> search</span>
        </footer>
      </div>

      {selectedIds.length > 0 && (
        <div
          className="pointer-events-none fixed inset-x-0 z-40 mx-auto w-[calc(100%-1rem)] max-w-4xl sm:w-[calc(100%-2rem)]"
          style={{ bottom: "max(0.5rem, env(safe-area-inset-bottom))" }}
          aria-label="Bulk task actions"
        >
          <div className="pointer-events-auto flex items-center gap-1.5 overflow-x-auto rounded-2xl border border-[#216e4e]/20 bg-[#eaf3ed]/95 p-2 shadow-[0_16px_50px_rgba(23,61,42,0.2)] backdrop-blur-xl sm:gap-2">
            <span className="min-w-max px-2 text-sm font-semibold text-[#195d41]">{selectedIds.length} selected</span>
            <button type="button" onClick={() => bulkAction("complete")} disabled={syncing} className="min-w-max rounded-lg bg-white px-3 py-2 text-xs font-semibold text-[#216e4e] shadow-sm hover:bg-[#f8fbf9] disabled:opacity-50">Done</button>
            <button type="button" onClick={() => bulkAction("snooze")} disabled={syncing} className="min-w-max rounded-lg bg-white px-3 py-2 text-xs font-semibold text-amber-700 shadow-sm hover:bg-amber-50 disabled:opacity-50">Snooze</button>
            <button type="button" onClick={() => bulkAction("unsnooze")} disabled={syncing} className="min-w-max rounded-lg bg-white px-3 py-2 text-xs font-semibold text-[#4f5752] shadow-sm hover:bg-[#f8f9f8] disabled:opacity-50">{view === "completed" ? "Open" : "Restore"}</button>
            <button type="button" onClick={() => bulkAction("archive")} disabled={syncing} className="min-w-max rounded-lg bg-white px-3 py-2 text-xs font-semibold text-slate-600 shadow-sm hover:bg-slate-50 disabled:opacity-50">{view === "archived" ? "Move" : "Archive"}</button>
            <button type="button" onClick={() => bulkAction("merge")} disabled={syncing || selectedIds.length < 2} className="min-w-max rounded-lg bg-white px-3 py-2 text-xs font-semibold text-violet-700 shadow-sm hover:bg-violet-50 disabled:opacity-40">Merge</button>
            <button type="button" onClick={() => bulkAction("delete")} disabled={syncing} className="min-w-max rounded-lg bg-white px-3 py-2 text-xs font-semibold text-red-700 shadow-sm hover:bg-red-50 disabled:opacity-50">Delete</button>
            <button type="button" onClick={() => setSelected(new Set())} className="ml-auto min-w-max rounded-lg px-3 py-2 text-xs font-semibold text-[#69716c] hover:bg-black/[0.04]">Cancel</button>
          </div>
        </div>
      )}

      {projectDialog && (
        <div className="fixed inset-0 z-50 flex items-end justify-center overflow-x-hidden sm:items-center sm:p-5" role="dialog" aria-modal="true" aria-labelledby="project-dialog-title">
          <button type="button" aria-label="Close project assignment" onClick={closeProjectAssignment} className="absolute inset-0 bg-black/35 backdrop-blur-[2px]" />
          <form onSubmit={saveProjectAssignment} className="relative max-h-[92dvh] w-full max-w-full overflow-x-hidden overflow-y-auto rounded-t-3xl bg-white px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-5 shadow-2xl sm:max-w-md sm:rounded-3xl sm:p-6">
            <div className="flex min-w-0 items-start justify-between gap-4">
              <div className="min-w-0">
                <h3 id="project-dialog-title" className="text-lg font-semibold text-[#202522]">
                  {projectDialog.mode === "archive" ? "Archive into a project" : "Move archived notes"}
                </h3>
                <p className="mt-1 text-sm leading-5 text-[#7c847f]">
                  {projectDialog.mode === "archive"
                    ? `Choose where ${projectDialog.ids.length === 1 ? "this persistent note" : `these ${projectDialog.ids.length} persistent notes`} should live.`
                    : `Reassign ${projectDialog.ids.length === 1 ? "this note" : `these ${projectDialog.ids.length} notes`} or leave ${projectDialog.ids.length === 1 ? "it" : "them"} unassigned.`}
                </p>
              </div>
              <button type="button" onClick={closeProjectAssignment} disabled={savingProject} className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#f1f2f0] text-lg text-[#4f5752] hover:bg-[#e8eae7] disabled:opacity-50" aria-label="Close project assignment">×</button>
            </div>

            <label className="mt-5 block min-w-0">
              <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[#69716c]">Project</span>
              <select
                autoFocus
                value={projectDialog.selection}
                onChange={(event) => {
                  setProjectDialog((current) => current ? { ...current, selection: event.target.value } : current);
                  setProjectDialogError("");
                }}
                className="h-12 w-full min-w-0 max-w-full rounded-xl border border-black/[0.1] bg-white px-3 text-sm text-[#303632] outline-none focus:border-[#216e4e]/50 focus:ring-3 focus:ring-[#216e4e]/10"
              >
                <option value="">Choose a project…</option>
                {projects.map((name) => <option key={name} value={name}>{name}</option>)}
                {projectDialog.mode === "move" && <option value={UNASSIGNED_PROJECT}>Unassigned</option>}
                <option value={CREATE_PROJECT}>Create a new project…</option>
              </select>
            </label>

            {projectDialog.selection === CREATE_PROJECT && (
              <label className="mt-3 block min-w-0">
                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[#69716c]">New project name</span>
                <input
                  value={projectDialog.newProject}
                  onChange={(event) => {
                    setProjectDialog((current) => current ? { ...current, newProject: event.target.value } : current);
                    setProjectDialogError("");
                  }}
                  placeholder="e.g. Reference, Home, Work"
                  maxLength={120}
                  className="h-12 w-full min-w-0 max-w-full rounded-xl border border-black/[0.1] px-3 text-[16px] outline-none focus:border-[#216e4e]/50 focus:ring-3 focus:ring-[#216e4e]/10"
                />
              </label>
            )}

            {projectDialogError && <p role="alert" className="mt-3 text-sm font-medium text-red-700">{projectDialogError}</p>}

            <div className="mt-6 flex items-center justify-end gap-2">
              <button type="button" onClick={closeProjectAssignment} disabled={savingProject} className="h-11 rounded-xl px-4 text-sm font-semibold text-[#69716c] hover:bg-[#f3f4f2] disabled:opacity-50">Cancel</button>
              <button type="submit" disabled={savingProject} className="h-11 rounded-xl bg-[#216e4e] px-5 text-sm font-semibold text-white hover:bg-[#195d41] disabled:opacity-50">
                {savingProject ? "Saving…" : projectDialog.mode === "archive" ? "Archive into project" : "Move notes"}
              </button>
            </div>
          </form>
        </div>
      )}

      {editingTodo && editDraft && (
        <div className="fixed inset-0 z-50 flex items-end justify-center overflow-x-hidden sm:items-center sm:p-5" role="dialog" aria-modal="true" aria-labelledby="task-details-title">
          <button type="button" aria-label="Close task details" onClick={closeTaskDetails} className="absolute inset-0 bg-black/35 backdrop-blur-[2px]" />
          <form onSubmit={saveTaskDetails} className="relative flex max-h-[92dvh] w-full max-w-full flex-col overflow-hidden overflow-x-hidden rounded-t-3xl bg-white shadow-2xl sm:max-w-2xl sm:rounded-3xl">
            <div className="flex min-w-0 items-center justify-between border-b border-black/[0.07] px-5 py-4 sm:px-6">
              <h3 id="task-details-title" className="min-w-0 text-lg font-semibold text-[#202522]">Task details</h3>
              <button type="button" onClick={closeTaskDetails} className="grid h-9 w-9 place-items-center rounded-full bg-[#f1f2f0] text-lg text-[#4f5752] hover:bg-[#e8eae7]" aria-label="Close task details">×</button>
            </div>

            <div className="min-h-0 min-w-0 overflow-x-hidden overflow-y-auto px-5 py-5 sm:px-6">
              <label className="block min-w-0">
                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[#69716c]">Task</span>
                <textarea
                  autoFocus
                  value={editDraft.title}
                  onChange={(event) => setEditDraft((current) => current ? { ...current, title: event.target.value } : current)}
                  rows={4}
                  maxLength={2000}
                  className="min-h-28 w-full min-w-0 max-w-full resize-y rounded-xl border border-black/[0.1] bg-white px-3 py-2.5 text-[16px] leading-6 text-[#202522] outline-none focus:border-[#216e4e]/50 focus:ring-3 focus:ring-[#216e4e]/10"
                />
              </label>

              <label className="mt-4 block min-w-0">
                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[#69716c]">Notes</span>
                <textarea
                  value={editDraft.notes}
                  onChange={(event) => setEditDraft((current) => current ? { ...current, notes: event.target.value } : current)}
                  rows={5}
                  placeholder="Add context, links, or next steps…"
                  maxLength={10000}
                  className="min-h-28 w-full min-w-0 max-w-full resize-y rounded-xl border border-black/[0.1] bg-white px-3 py-2.5 text-sm leading-6 text-[#303632] outline-none placeholder:text-[#a0a6a2] focus:border-[#216e4e]/50 focus:ring-3 focus:ring-[#216e4e]/10"
                />
              </label>

              <div className="mt-4 grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
                <label className="block min-w-0">
                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[#69716c]">Project</span>
                  <input list="task-project-options" value={editDraft.project} onChange={(event) => setEditDraft((current) => current ? { ...current, project: event.target.value } : current)} placeholder="Choose or create a project" maxLength={120} className="h-11 w-full min-w-0 max-w-full rounded-xl border border-black/[0.1] px-3 text-sm outline-none focus:border-[#216e4e]/50 focus:ring-3 focus:ring-[#216e4e]/10" />
                  <datalist id="task-project-options">{projects.map((name) => <option key={name} value={name} />)}</datalist>
                </label>
                <label className="block min-w-0">
                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[#69716c]">Context</span>
                  <input value={editDraft.context} onChange={(event) => setEditDraft((current) => current ? { ...current, context: event.target.value } : current)} placeholder="No context" className="h-11 w-full min-w-0 max-w-full rounded-xl border border-black/[0.1] px-3 text-sm outline-none focus:border-[#216e4e]/50 focus:ring-3 focus:ring-[#216e4e]/10" />
                </label>
                <label className="block min-w-0">
                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[#69716c]">Priority</span>
                  <select value={editDraft.priority} onChange={(event) => setEditDraft((current) => current ? { ...current, priority: Number(event.target.value) } : current)} className="h-11 w-full min-w-0 max-w-full rounded-xl border border-black/[0.1] bg-white px-3 text-sm outline-none focus:border-[#216e4e]/50 focus:ring-3 focus:ring-[#216e4e]/10">
                    <option value="1">Urgent</option>
                    <option value="2">High</option>
                    <option value="3">Normal</option>
                    <option value="4">Low</option>
                  </select>
                </label>
                <label className="block min-w-0">
                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[#69716c]">Due date</span>
                  <input type="date" value={editDraft.dueDate} onChange={(event) => setEditDraft((current) => current ? { ...current, dueDate: event.target.value } : current)} className="h-11 w-full min-w-0 max-w-full rounded-xl border border-black/[0.1] bg-white px-3 text-sm outline-none focus:border-[#216e4e]/50 focus:ring-3 focus:ring-[#216e4e]/10" />
                </label>
              </div>

              <div className="mt-5 border-t border-black/[0.07] pt-4">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[#69716c]">Quick actions</p>
                <div className="flex min-w-0 flex-wrap gap-2">
                  {isSnoozed(editingTodo, now) ? (
                    <button type="button" onClick={() => detailAction("unsnooze")} disabled={syncing || savingEdit} className="min-w-max rounded-xl bg-[#eaf3ed] px-3 py-2.5 text-sm font-semibold text-[#195d41] disabled:opacity-50">Wake</button>
                  ) : editingTodo.status === "completed" ? (
                    <button type="button" onClick={() => detailAction("unsnooze")} disabled={syncing || savingEdit} className="min-w-max rounded-xl bg-[#eaf3ed] px-3 py-2.5 text-sm font-semibold text-[#195d41] disabled:opacity-50">Open</button>
                  ) : (
                    <button type="button" onClick={() => detailAction("complete")} disabled={syncing || savingEdit} className="min-w-max rounded-xl bg-[#eaf3ed] px-3 py-2.5 text-sm font-semibold text-[#195d41] disabled:opacity-50">Done</button>
                  )}
                  {!isSnoozed(editingTodo, now) && <button type="button" onClick={() => detailAction("snooze")} disabled={syncing || savingEdit} className="min-w-max rounded-xl bg-amber-50 px-3 py-2.5 text-sm font-semibold text-amber-700 disabled:opacity-50">Snooze</button>}
                  {editingTodo.status === "archived" ? (
                    <button type="button" onClick={() => detailAction("unsnooze")} disabled={syncing || savingEdit} className="min-w-max rounded-xl bg-slate-100 px-3 py-2.5 text-sm font-semibold text-slate-700 disabled:opacity-50">Unarchive</button>
                  ) : (
                    <button type="button" onClick={() => detailAction("archive")} disabled={syncing || savingEdit} className="min-w-max rounded-xl bg-slate-100 px-3 py-2.5 text-sm font-semibold text-slate-700 disabled:opacity-50">Archive</button>
                  )}
                  <button type="button" onClick={() => detailAction("delete")} disabled={syncing || savingEdit} className="min-w-max rounded-xl bg-red-50 px-3 py-2.5 text-sm font-semibold text-red-700 disabled:opacity-50">Delete</button>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-black/[0.07] bg-white px-5 py-3 sm:px-6">
              <button type="button" onClick={closeTaskDetails} disabled={savingEdit} className="h-11 rounded-xl px-4 text-sm font-semibold text-[#69716c] hover:bg-[#f3f4f2] disabled:opacity-50">Cancel</button>
              <button type="submit" disabled={savingEdit || !editDraft.title.trim()} className="h-11 rounded-xl bg-[#216e4e] px-5 text-sm font-semibold text-white hover:bg-[#195d41] disabled:opacity-50">{savingEdit ? "Saving…" : "Save changes"}</button>
            </div>
          </form>
        </div>
      )}

      {notice && (
        <div
          className="pointer-events-none fixed inset-x-0 z-[60] mx-auto w-[calc(100%-2rem)] max-w-md transition-[bottom] duration-200"
          style={{ bottom: selectedIds.length > 0 ? "max(5.25rem, calc(env(safe-area-inset-bottom) + 5rem))" : "max(1rem, env(safe-area-inset-bottom))" }}
        >
          <div
            role={notice.tone === "error" ? "alert" : "status"}
            className={classNames(
              "pointer-events-auto flex min-h-14 items-center gap-3 rounded-2xl px-4 py-3 text-sm text-white shadow-[0_16px_50px_rgba(0,0,0,0.24)]",
              notice.tone === "error" ? "bg-red-700" : "bg-[#202522]",
            )}
          >
            <span className="min-w-0 flex-1 font-medium">{notice.text}</span>
            {notice.undoToken && (
              <button
                type="button"
                onClick={() => { setNotice(null); void undoAction(notice.undoToken as string); }}
                disabled={undoing}
                className="rounded-lg px-2 py-1.5 font-semibold text-[#8ee0b5] transition hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white disabled:opacity-50"
              >
                {undoing ? "Undoing…" : "Undo"}
              </button>
            )}
            <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss notification" className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-lg text-white/65 hover:bg-white/10 hover:text-white">×</button>
          </div>
        </div>
      )}
    </main>
  );
}
