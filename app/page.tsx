"use client";

import {
  FormEvent,
  PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ActionIcon, type ActionIconName } from "./action-icon";
import { SiteHeader } from "./site-header";

type TodoStatus = "open" | "completed";
type View = "open" | "snoozed" | "all" | "projects";
type TaskListView = Exclude<View, "projects">;
type Sort = "smart" | "priority" | "due" | "newest" | "oldest" | "az";
type TodoAction = "complete" | "snooze" | "unsnooze" | "delete";
type ExecutableTodoAction = TodoAction;
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
  selection: string;
  newProject: string;
  openedFromDetails: boolean;
};

type ProjectDeleteDialogState = {
  name: string;
  mode: "reassign" | "delete";
  targetProject: string;
};

const CREATE_PROJECT = "__create_project__";
const UNASSIGNED_PROJECT = "__unassigned_project__";

const viewLabels: Record<View, string> = {
  open: "Open",
  snoozed: "Snoozed",
  all: "All",
  projects: "Projects",
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
  if (view === "snoozed") return snoozed;
  if (view === "all") return todo.status === "open" || todo.status === "completed";
  return false;
}

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function todoActionIcon(action: TodoAction | "assign", label: string): ActionIconName {
  if (action === "complete") return "done";
  if (action === "snooze") return "snooze";
  if (action === "delete") return "delete";
  if (action === "assign") return "move";
  if (label === "Wake") return "wake";
  if (label === "Open") return "open";
  return "restore";
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
  const primaryAction: { action: TodoAction; label: string; icon: ActionIconName } = todo.status === "open"
    ? { action: "complete", label: "Done", icon: "done" }
    : { action: "unsnooze", label: "Open", icon: "open" };
  const leftSecondaryAction: { action: TodoAction; label: string; icon: ActionIconName } = todo.status === "completed"
    ? primaryAction
    : snoozed
      ? { action: "unsnooze", label: "Wake", icon: "wake" }
      : { action: "snooze", label: "Snooze", icon: "snooze" };
  const swipeRatio = Math.abs(offset) / swipeWidth;
  const longSwipe = swipeRatio >= 0.5;
  const revealAction = offset < 0
    ? (longSwipe ? leftSecondaryAction.label : primaryAction.label)
    : (longSwipe ? "Delete" : "Assign project");
  const revealIcon: ActionIconName = offset < 0
    ? (longSwipe ? leftSecondaryAction.icon : primaryAction.icon)
    : (longSwipe ? "delete" : "move");
  const revealClass = offset < 0
    ? longSwipe && leftSecondaryAction.action === "snooze" ? "bg-amber-500" : "bg-[#216e4e]"
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
    if (direction < 0) onAction(todo, ratio >= 0.5 ? leftSecondaryAction.action : primaryAction.action, "swipe");
    else if (ratio >= 0.5) onAction(todo, "delete", "swipe");
    else onProject(todo, "swipe");
  }

  function cancelSwipe() {
    gesture.current = null;
    offsetRef.current = 0;
    setDragging(false);
    setOffset(0);
  }

  const hoverActions: Array<{ action: TodoAction | "assign"; label: string; icon: ActionIconName }> = [
    primaryAction,
    ...(todo.status === "open" ? [leftSecondaryAction] : []),
    { action: "assign", label: "Assign project", icon: "move" },
    { action: "delete", label: "Delete", icon: "delete" },
  ];

  return (
    <li className={classNames("group relative overflow-hidden", selected && "ring-1 ring-inset ring-[#216e4e]/30")}>
      <div className={classNames("absolute inset-0 flex items-center justify-between px-5 text-sm font-semibold text-white md:hidden", revealClass)} aria-hidden="true">
        <span className={classNames("inline-flex items-center gap-2 transition-opacity", offset > 0 ? "opacity-100" : "opacity-0")}><ActionIcon name={revealIcon} />{revealAction}</span>
        <span className={classNames("inline-flex items-center gap-2 transition-opacity", offset < 0 ? "opacity-100" : "opacity-0")}><ActionIcon name={revealIcon} />{revealAction}</span>
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
          {(todo.project || todo.context || todo.dueDate || todo.priority <= 2 || snoozed) && (
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[#747c77]">
              {todo.priority <= 2 && <span className={classNames("rounded-full px-2 py-0.5 font-medium", todo.priority === 1 ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-700")}>{priorityLabels[todo.priority]}</span>}
              {todo.project && <span className="rounded-full bg-[#f0f2ef] px-2 py-0.5">{todo.project}</span>}
              {todo.context && <span>{todo.context}</span>}
              {todo.dueDate && <span className={classNames(isTodayOrOverdue(todo.dueDate) && todo.status === "open" && !snoozed && "font-medium text-red-600")}>{dueLabel(todo.dueDate)}</span>}
              {snoozed && todo.snoozedUntil && <span className="font-medium text-amber-700">{snoozeLabel(todo.snoozedUntil)}</span>}
            </div>
          )}
        </button>
        {!pending && (
          <div className="hidden shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 md:flex">
            {hoverActions.map(({ action, label, icon }) => (
              <button
                key={action}
                type="button"
                data-row-action
                onClick={() => action === "assign" ? onProject(todo, "hover") : onAction(todo, action, "hover")}
                aria-label={`${label}: ${todo.title}`}
                title={label}
                className={classNames(
                  "grid h-9 w-9 place-items-center rounded-lg text-[#69716c] transition hover:bg-[#eef0ed] hover:text-[#252a27] focus-visible:outline-2 focus-visible:outline-[#216e4e]",
                  (action === "complete" || action === "unsnooze") && "hover:bg-emerald-50 hover:text-emerald-700",
                  action === "snooze" && "hover:bg-amber-50 hover:text-amber-700",
                  action === "delete" && "hover:bg-red-50 hover:text-red-700",
                )}
              >
                <ActionIcon name={icon} className="h-[18px] w-[18px]" />
                <span className="sr-only">{label}</span>
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
  const [registeredProjects, setRegisteredProjects] = useState<string[]>([]);
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
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectError, setNewProjectError] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const [projectDeleteDialog, setProjectDeleteDialog] = useState<ProjectDeleteDialogState | null>(null);
  const [projectDeleteError, setProjectDeleteError] = useState("");
  const [deletingProject, setDeletingProject] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [now, setNow] = useState(() => Date.now());
  const captureRef = useRef<HTMLTextAreaElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const overlayOpen = editingId !== null || projectDialog !== null || newProjectOpen || projectDeleteDialog !== null || filtersOpen;

  useEffect(() => {
    let active = true;
    Promise.all([
      request<{ todos: Todo[] }>("/api/todos"),
      request<{ projects: string[] }>("/api/projects"),
    ])
      .then(([{ todos: loaded }, { projects: loadedProjects }]) => {
        if (!active) return;
        setTodos(loaded);
        setRegisteredProjects(loadedProjects);
        console.info("[todo-ui] loaded", {
          count: loaded.length,
          projects: loadedProjects.length,
          open: loaded.filter((todo) => todo.status === "open").length,
          completed: loaded.filter((todo) => todo.status === "completed").length,
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
      if (event.key === "Escape" && projectDeleteDialog !== null) {
        setProjectDeleteDialog(null);
        setProjectDeleteError("");
      } else if (event.key === "Escape" && newProjectOpen) {
        setNewProjectOpen(false);
        setNewProjectName("");
        setNewProjectError("");
      } else if (event.key === "Escape" && projectDialog !== null) {
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
  }, [editingId, filtersOpen, newProjectOpen, projectDeleteDialog, projectDialog]);

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
    () => [...new Set([
      ...registeredProjects,
      ...todos.map((todo) => todo.project).filter((value): value is string => Boolean(value)),
    ])].sort((a, b) => a.localeCompare(b)),
    [registeredProjects, todos],
  );

  const projectOptions = useMemo(() => {
    const projectCounts = new Map<string, { open: number; snoozed: number; done: number }>(
      registeredProjects.map((name) => [name, { open: 0, snoozed: 0, done: 0 }]),
    );
    todos.forEach((todo) => {
      if (!todo.project) return;
      const counts = projectCounts.get(todo.project) ?? { open: 0, snoozed: 0, done: 0 };
      if (todo.status === "completed") counts.done += 1;
      else if (isSnoozed(todo, now)) counts.snoozed += 1;
      else counts.open += 1;
      projectCounts.set(todo.project, counts);
    });
    return [...projectCounts.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [registeredProjects, todos, now]);

  const counts = useMemo(() => ({
    open: todos.filter((todo) => matchesView(todo, "open", now)).length,
    snoozed: todos.filter((todo) => matchesView(todo, "snoozed", now)).length,
    all: todos.filter((todo) => matchesView(todo, "all", now)).length,
    projects: projectOptions.length,
  }), [projectOptions.length, todos, now]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const projectFilterApplies = view === "open" || view === "snoozed" || view === "all";
    const rows = todos.filter((todo) => {
      const searchable = [todo.title, todo.notes, todo.project, todo.context].filter(Boolean).join(" ").toLowerCase();
      return matchesView(todo, view, now)
        && (!needle || searchable.includes(needle))
        && (!projectFilterApplies || !project || (project === UNASSIGNED_PROJECT ? !todo.project : todo.project === project))
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
  const selectedTodos = useMemo(() => todos.filter((todo) => selected.has(todo.id)), [selected, todos]);
  const allVisibleSelected = filtered.length > 0 && filtered.every((todo) => selected.has(todo.id));
  const projectFilterApplies = view === "open" || view === "snoozed" || view === "all";
  const filtersActive = Boolean(query || (projectFilterApplies && project) || priority || sort !== "smart");
  const mobileFilterCount = Number(Boolean(project) && projectFilterApplies) + Number(Boolean(priority)) + Number(sort !== "smart");
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
    setProject("");
    setView("open");
    console.info("[todo-ui] quick add routed to unfiltered open view", {
      previousProjectFilter: project || null,
    });
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
        body: JSON.stringify({ title, status: "open", project: null }),
      });
      setTodos((current) => current.map((item) => item.id === temporaryId ? todo : item));
      console.info("[todo-ui] created", {
        id: todo.id,
        status: todo.status,
        project: todo.project,
        titleLength: title.length,
        lines: title.split("\n").length,
      });
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

  function applyOptimisticAction(current: Todo[], ids: number[], action: ExecutableTodoAction, actionAt: string) {
    const idSet = new Set(ids);
    if (action === "delete") return current.filter((todo) => !idSet.has(todo.id));
    const temporarySnooze = new Date(new Date(actionAt).valueOf() + 36 * 60 * 60 * 1000).toISOString();
    return current.map((todo) => {
      if (!idSet.has(todo.id)) return todo;
      if (action === "complete") return { ...todo, status: "completed" as const, completedAt: actionAt, snoozedUntil: null };
      if (action === "snooze") return { ...todo, status: "open" as const, completedAt: null, snoozedUntil: temporarySnooze };
      return { ...todo, status: "open" as const, completedAt: null, snoozedUntil: null };
    });
  }

  async function performAction(ids: number[], action: ExecutableTodoAction | "merge") {
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
          ...current.filter((todo) => !sourceIds.has(todo.id)),
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
        const wokeSnoozed = action === "unsnooze" && ids.every((id) => {
          const todo = previous.find((item) => item.id === id);
          return todo ? isSnoozed(todo, new Date(actionAt).valueOf()) : false;
        });
        const label = action === "complete" ? "Done" : action === "snooze" ? "Snoozed until tomorrow" : action === "unsnooze" ? openedCompleted ? "Opened" : wokeSnoozed ? "Woke" : "Restored to Open" : "Deleted";
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
      const { projects: refreshedProjects } = await request<{ projects: string[] }>("/api/projects");
      setRegisteredProjects(refreshedProjects);
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

  function openProjectAssignment(ids: number[], source: "bulk" | "hover" | "swipe" | "details") {
    const taskProjects = todos
      .filter((todo) => ids.includes(todo.id))
      .map((todo) => todo.project || UNASSIGNED_PROJECT);
    const sharedProject = new Set(taskProjects).size === 1 ? taskProjects[0] : "";
    setProjectDialog({ ids, selection: sharedProject, newProject: "", openedFromDetails: source === "details" });
    setProjectDialogError("");
    console.info("[todo-ui] project assignment opened", { ids, source, sharedProject: sharedProject || null });
  }

  function closeProjectAssignment() {
    if (savingProject) return;
    setProjectDialog(null);
    setProjectDialogError("");
  }

  async function saveProjectAssignment(event: FormEvent) {
    event.preventDefault();
    if (!projectDialog || savingProject) return;
    if (!projectDialog.selection) {
      setProjectDialogError("Choose a project or select Unassigned.");
      return;
    }
    const projectName = projectDialog.selection === CREATE_PROJECT
      ? projectDialog.newProject.trim()
      : projectDialog.selection === UNASSIGNED_PROJECT
        ? null
        : projectDialog.selection.trim() || null;
    if (projectDialog.selection === CREATE_PROJECT && !projectName) {
      setProjectDialogError("Enter a name for the new project.");
      return;
    }
    if (projectName && projectName.length > 120) {
      setProjectDialogError("Project names are limited to 120 characters.");
      return;
    }

    const { ids, openedFromDetails } = projectDialog;
    setSavingProject(true);
    setProjectDialogError("");
    setNotice(null);
    try {
      const result = await request<{ todos: Todo[]; ids: number[]; undoToken: string }>("/api/todos/bulk", {
        method: "POST",
        body: JSON.stringify({ ids, action: "reproject", project: projectName }),
      });
      const updates = new Map(result.todos.map((todo) => [todo.id, todo]));
      setTodos((current) => current.map((todo) => updates.get(todo.id) ?? todo));
      if (projectName) {
        setRegisteredProjects((current) => [...new Set([...current, projectName])].sort((a, b) => a.localeCompare(b)));
      }
      if (openedFromDetails && ids.length === 1) {
        setEditDraft((current) => current ? { ...current, project: projectName ?? "" } : current);
      }
      setSelected((current) => {
        const next = new Set(current);
        ids.forEach((id) => next.delete(id));
        return next;
      });
      setProjectDialog(null);
      const location = projectName || "Unassigned";
      setNotice({
        tone: "success",
        text: `Assigned to ${location}: ${ids.length} ${ids.length === 1 ? "task" : "tasks"}.`,
        undoToken: result.undoToken,
      });
      console.info("[todo-ui] project assignment saved", {
        ids,
        project: projectName,
        preservedTaskState: result.todos.map((todo) => ({ id: todo.id, status: todo.status, snoozedUntil: todo.snoozedUntil })),
        returnedToDetails: openedFromDetails,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "The project could not be assigned.";
      setProjectDialogError(message);
      console.error("[todo-ui] project assignment failed", { ids, project: projectName, error });
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
      const message = error instanceof Error ? error.message : "The task details could not be saved.";
      setNotice({ tone: "error", text: message });
      console.error("[todo-ui] task details save failed", { id: editingTodo.id, error });
    } finally {
      setSavingEdit(false);
    }
  }

  function taskAction(todo: Todo, action: TodoAction, source: "hover" | "swipe" | "details") {
    console.info("[todo-ui] task action requested", { id: todo.id, action, source });
    void performAction([todo.id], action);
  }

  function assignTaskProject(todo: Todo, source: "hover" | "swipe") {
    openProjectAssignment([todo.id], source);
  }

  function detailAction(action: TodoAction) {
    if (!editingTodo) return;
    const todo = editingTodo;
    closeTaskDetails();
    taskAction(todo, action, "details");
  }

  function bulkAction(action: TodoAction | "merge" | "assign") {
    if (action === "merge" && selectedIds.length < 2) {
      setNotice({ tone: "error", text: "Select at least two tasks to merge." });
      return;
    }
    if (action === "assign") {
      openProjectAssignment(selectedIds, "bulk");
      return;
    }
    const targetIds = action === "complete" || action === "snooze"
      ? selectedTodos.filter((todo) => todo.status === "open").map((todo) => todo.id)
      : action === "unsnooze"
        ? selectedTodos.filter((todo) => todo.status === "completed" || isSnoozed(todo, now)).map((todo) => todo.id)
        : selectedIds;
    void performAction(targetIds, action);
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
    setSelected(new Set());
    setFiltersOpen(false);
    console.info("[todo-ui] view changed", { view: next, retainedProjectFilter: project || null });
  }

  function openProjectTasks(name: string, destinationView: TaskListView = "open", source: "card" | "shortcut" = "card") {
    setProject(name);
    setView(destinationView);
    setSelected(new Set());
    setFiltersOpen(false);
    console.info("[todo-ui] project opened as filtered task list", {
      project: name,
      destinationView,
      source,
    });
  }

  function openNewProjectDialog() {
    setNewProjectName("");
    setNewProjectError("");
    setNewProjectOpen(true);
    console.info("[todo-ui] new project dialog opened");
  }

  function closeNewProjectDialog() {
    if (creatingProject) return;
    setNewProjectOpen(false);
    setNewProjectName("");
    setNewProjectError("");
  }

  async function createProject(event: FormEvent) {
    event.preventDefault();
    if (creatingProject) return;
    const name = newProjectName.trim();
    if (!name) {
      setNewProjectError("A project name is required.");
      return;
    }
    setCreatingProject(true);
    setNewProjectError("");
    try {
      const result = await request<{ project: string }>("/api/projects", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      setRegisteredProjects((current) => [...new Set([...current, result.project])].sort((a, b) => a.localeCompare(b)));
      setNewProjectOpen(false);
      setNewProjectName("");
      setNotice({ tone: "success", text: `${result.project} created.` });
      console.info("[todo-ui] project created", { project: result.project, remainedOnProjectsView: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "The project could not be created.";
      setNewProjectError(message);
      console.error("[todo-ui] project create failed", { name, error });
    } finally {
      setCreatingProject(false);
    }
  }

  function openProjectDeleteDialog(name: string) {
    const alternatives = registeredProjects.filter((projectName) => projectName !== name);
    setProjectDeleteDialog({ name, mode: alternatives.length ? "reassign" : "delete", targetProject: alternatives[0] ?? "" });
    setProjectDeleteError("");
    console.info("[todo-ui] project delete dialog opened", {
      project: name,
      projectTasks: todos.filter((todo) => todo.project === name).length,
      reassignTargets: alternatives.length,
    });
  }

  function closeProjectDeleteDialog() {
    if (deletingProject) return;
    setProjectDeleteDialog(null);
    setProjectDeleteError("");
  }

  async function deleteProject(event: FormEvent) {
    event.preventDefault();
    if (!projectDeleteDialog || deletingProject) return;
    if (projectDeleteDialog.mode === "reassign" && !projectDeleteDialog.targetProject) {
      setProjectDeleteError("Choose a destination project.");
      return;
    }
    const dialog = projectDeleteDialog;
    setDeletingProject(true);
    setProjectDeleteError("");
    try {
      const result = await request<{
        project: string;
        mode: "reassign" | "delete";
        targetProject: string | null;
        affected: number;
        undoToken: string | null;
      }>("/api/projects", {
        method: "DELETE",
        body: JSON.stringify({
          name: dialog.name,
          mode: dialog.mode,
          targetProject: dialog.mode === "reassign" ? dialog.targetProject : null,
        }),
      });
      setRegisteredProjects((current) => current.filter((name) => name !== result.project));
      setTodos((current) => result.mode === "delete"
        ? current.filter((todo) => todo.project !== result.project)
        : current.map((todo) => todo.project === result.project
          ? { ...todo, project: result.targetProject, updatedAt: new Date().toISOString() }
          : todo));
      setProjectDeleteDialog(null);
      setNotice({
        tone: "success",
        text: result.mode === "delete"
          ? `${result.project} and ${result.affected} ${result.affected === 1 ? "task" : "tasks"} deleted.`
          : `${result.project} deleted; ${result.affected} ${result.affected === 1 ? "task" : "tasks"} moved to ${result.targetProject}.`,
        undoToken: result.undoToken ?? undefined,
      });
      console.info("[todo-ui] project deleted", { ...result, affectedAllTaskStates: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "The project could not be deleted.";
      setProjectDeleteError(message);
      console.error("[todo-ui] project delete failed", { dialog, error });
    } finally {
      setDeletingProject(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#f6f7f5] text-[#1d211f]">
      <SiteHeader current="todos" />
      <div className="mx-auto max-w-5xl px-4 pb-28 pt-5 sm:px-6 sm:pt-7">
        <form onSubmit={addTodo} className="mb-5 flex items-end gap-2 rounded-2xl border border-black/[0.07] bg-white p-2 shadow-[0_10px_35px_rgba(30,45,36,0.07)] sm:p-3">
          <div className="flex min-w-0 flex-1 items-start gap-3 px-2 py-2 sm:px-3">
            <ActionIcon name="add" className="mt-1 h-5 w-5 shrink-0 text-[#216e4e]" />
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
              className="inline-flex h-11 items-center gap-2 rounded-xl bg-[#216e4e] px-4 text-sm font-semibold text-white transition hover:bg-[#195d41] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#216e4e] disabled:cursor-not-allowed disabled:opacity-40 sm:px-6"
            >
              <ActionIcon name="add" />
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

          {view === "projects" ? (
            <div>
              <div className="mb-4 flex items-center justify-between gap-3 px-1">
                <div>
                  <h2 id="tasks-heading" className="text-lg font-semibold text-[#202522]">Projects</h2>
                  <p className="mt-0.5 text-sm text-[#7c847f]">Open a project to see its active tasks.</p>
                </div>
                <button
                  type="button"
                  onClick={openNewProjectDialog}
                  className="inline-flex h-10 shrink-0 items-center gap-2 rounded-xl bg-[#216e4e] px-3.5 text-sm font-semibold text-white shadow-sm transition hover:bg-[#195d41] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#216e4e]"
                >
                  <ActionIcon name="create-project" />
                  <span>New project</span>
                </button>
              </div>

              {loading ? (
                <div role="status" aria-label="Loading projects" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {[0, 1, 2].map((item) => <div key={item} className="h-32 animate-pulse rounded-2xl bg-white shadow-sm" />)}
                </div>
              ) : projectOptions.length ? (
                <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {projectOptions.map(([name, projectCounts]) => {
                    const count = projectCounts.open + projectCounts.snoozed + projectCounts.done;
                    return (
                      <li key={name} className="group relative overflow-hidden rounded-2xl border border-black/[0.07] bg-white shadow-[0_8px_28px_rgba(30,45,36,0.05)] transition hover:-translate-y-0.5 hover:border-[#216e4e]/20 hover:shadow-[0_12px_34px_rgba(30,45,36,0.09)]">
                        <button
                          type="button"
                          onClick={() => openProjectTasks(name)}
                          className="flex min-h-32 w-full items-start gap-3 p-5 pr-40 text-left focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-[#216e4e]"
                          aria-label={`Open ${name}, ${count} ${count === 1 ? "task" : "tasks"}`}
                        >
                          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[#eaf3ed] text-[#216e4e]">
                            <ActionIcon name="folder" className="h-6 w-6" />
                          </span>
                          <span className="min-w-0 pt-0.5">
                            <span className="block break-words text-[15px] font-semibold text-[#252a27]">{name}</span>
                            <span className="mt-1 block text-xs text-[#7c847f]">{projectCounts.open} open · {projectCounts.snoozed} snoozed · {projectCounts.done} done</span>
                          </span>
                        </button>
                        <div className="absolute right-3 top-3 flex items-center gap-0.5 rounded-xl bg-white/95 p-0.5 shadow-sm ring-1 ring-black/[0.05]">
                          {([
                            ["open", "view-open", `View open tasks in ${name}`],
                            ["snoozed", "snooze", `View snoozed tasks in ${name}`],
                            ["all", "view-all", `View all tasks in ${name}`],
                          ] as const).map(([destinationView, icon, label]) => (
                            <button
                              key={destinationView}
                              type="button"
                              onClick={() => openProjectTasks(name, destinationView, "shortcut")}
                              aria-label={label}
                              title={label}
                              className="grid h-8 w-8 place-items-center rounded-lg text-[#65706a] transition hover:bg-[#eaf3ed] hover:text-[#216e4e] focus-visible:outline-2 focus-visible:outline-[#216e4e]"
                            >
                              <ActionIcon name={icon} />
                            </button>
                          ))}
                          <button
                            type="button"
                            onClick={() => openProjectDeleteDialog(name)}
                            aria-label={`Delete project: ${name}`}
                            title="Delete project"
                            className="grid h-8 w-8 place-items-center rounded-lg text-[#8a918d] transition hover:bg-red-50 hover:text-red-700 focus-visible:outline-2 focus-visible:outline-red-600"
                          >
                            <ActionIcon name="delete" />
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="rounded-2xl border border-dashed border-black/[0.12] bg-white px-6 py-14 text-center">
                  <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-[#eaf3ed] text-[#216e4e]"><ActionIcon name="folder" className="h-6 w-6" /></span>
                  <p className="mt-4 font-medium text-[#303632]">No projects yet.</p>
                  <p className="mt-1 text-sm text-[#7c847f]">Create a project, then assign tasks whenever useful.</p>
                </div>
              )}
            </div>
          ) : (
          <>
          <div className={classNames("mb-3 grid grid-cols-[minmax(0,1fr)_auto] gap-2", projectFilterApplies ? "sm:grid-cols-[minmax(220px,1fr)_auto_auto_auto]" : "sm:grid-cols-[minmax(220px,1fr)_auto_auto]")}>
            <label className="flex h-10 items-center gap-2 rounded-xl border border-black/[0.08] bg-white px-3 shadow-sm focus-within:border-[#216e4e]/50 focus-within:ring-3 focus-within:ring-[#216e4e]/10">
              <ActionIcon name="search" className="h-4 w-4 shrink-0 text-[#7c847f]" />
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
              <ActionIcon name="filters" className="h-4 w-4" />
              <span>Filters</span>
              {mobileFilterCount > 0 && <span className="grid h-5 min-w-5 place-items-center rounded-full bg-[#216e4e] px-1 text-[10px] text-white">{mobileFilterCount}</span>}
            </button>
            {projectFilterApplies && <select value={project} onChange={(event) => setProject(event.target.value)} aria-label="Filter by project" className="hidden h-10 rounded-xl border border-black/[0.08] bg-white px-3 text-sm text-[#4f5752] shadow-sm outline-none focus:border-[#216e4e]/50 sm:block">
              <option value="">All projects</option>
              <option value={UNASSIGNED_PROJECT}>Unassigned</option>
              {projects.map((name) => <option key={name}>{name}</option>)}
            </select>}
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
                  <button type="button" onClick={() => setFiltersOpen(false)} className="grid h-9 w-9 place-items-center rounded-full bg-[#f1f2f0] text-[#4f5752]" aria-label="Close filters" title="Close"><ActionIcon name="close" /></button>
                </div>

                <div className="space-y-4">
                  {projectFilterApplies && <label className="block">
                    <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[#69716c]">Project</span>
                    <select value={project} onChange={(event) => setProject(event.target.value)} className="h-12 w-full rounded-xl border border-black/[0.1] bg-white px-3 text-sm text-[#303632] outline-none focus:border-[#216e4e]/50">
                      <option value="">All projects</option>
                      <option value={UNASSIGNED_PROJECT}>Unassigned</option>
                      {projects.map((name) => <option key={name}>{name}</option>)}
                    </select>
                  </label>}
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
                  <button type="button" onClick={() => { if (projectFilterApplies) setProject(""); setPriority(""); setSort("smart"); }} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-black/[0.08] text-sm font-semibold text-[#4f5752]"><ActionIcon name="restore" />Reset</button>
                  <button type="button" onClick={() => setFiltersOpen(false)} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-[#216e4e] text-sm font-semibold text-white"><ActionIcon name="done" />Show {filtered.length} {filtered.length === 1 ? "task" : "tasks"}</button>
                </div>
              </div>
            </div>
          )}

          <div className="mb-2 flex items-center justify-between px-1">
            <div className="flex items-center gap-3">
              <h2 id="tasks-heading" className="text-sm font-semibold text-[#373d39]">{viewLabels[view]} tasks</h2>
              {filtered.length > 0 && <button onClick={toggleVisible} className="inline-flex items-center gap-1.5 text-xs font-medium text-[#216e4e] hover:underline"><ActionIcon name={allVisibleSelected ? "cancel" : "select"} className="h-3.5 w-3.5" />{allVisibleSelected ? "Clear selection" : "Select visible"}</button>}
            </div>
            <div className="flex items-center gap-3 text-xs text-[#7c847f]">
              <span>{syncing ? "Saving…" : `${filtered.length} ${filtered.length === 1 ? "item" : "items"}`}</span>
              {filtersActive && <button onClick={() => { setQuery(""); if (projectFilterApplies) setProject(""); setPriority(""); setSort("smart"); }} className="inline-flex items-center gap-1 font-medium text-[#216e4e] hover:underline"><ActionIcon name="cancel" className="h-3.5 w-3.5" />Clear filters</button>}
            </div>
          </div>

          <p className="mb-2 px-1 text-[11px] text-[#8a918d] md:hidden">Swipe left: done/open · keep swiping to snooze/wake · Swipe right: assign project / delete</p>

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
                    onProject={assignTaskProject}
                    onOpen={openTaskDetails}
                  />
                ))}
              </ul>
            ) : (
              <div className="px-6 py-14 text-center">
                <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-[#eaf3ed] text-xl text-[#216e4e]">✓</div>
                <p className="font-medium text-[#303632]">{filtersActive ? "No tasks match those filters." : view === "snoozed" ? "Nothing is snoozed." : "You’re clear."}</p>
                <p className="mt-1 text-sm text-[#7c847f]">{filtersActive ? "Try clearing a filter or changing the search." : view === "snoozed" ? "Snoozed tasks return here until their wake time." : "Add the next thing when it appears."}</p>
              </div>
            )}
          </div>
          </>
          )}
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
            {selectedTodos.some((todo) => todo.status === "open") && <button type="button" onClick={() => bulkAction("complete")} disabled={syncing} className="inline-flex min-w-max items-center gap-1.5 rounded-lg bg-white px-3 py-2 text-xs font-semibold text-[#216e4e] shadow-sm hover:bg-[#f8fbf9] disabled:opacity-50"><ActionIcon name="done" />Done</button>}
            {view === "snoozed" && selectedTodos.some((todo) => todo.status === "open") ? (
              <button type="button" onClick={() => bulkAction("unsnooze")} disabled={syncing} className="inline-flex min-w-max items-center gap-1.5 rounded-lg bg-white px-3 py-2 text-xs font-semibold text-[#216e4e] shadow-sm hover:bg-[#f8fbf9] disabled:opacity-50"><ActionIcon name="wake" />Wake</button>
            ) : selectedTodos.some((todo) => todo.status === "open") ? (
              <button type="button" onClick={() => bulkAction("snooze")} disabled={syncing} className="inline-flex min-w-max items-center gap-1.5 rounded-lg bg-white px-3 py-2 text-xs font-semibold text-amber-700 shadow-sm hover:bg-amber-50 disabled:opacity-50"><ActionIcon name="snooze" />Snooze</button>
            ) : null}
            {selectedTodos.some((todo) => todo.status === "completed") && <button type="button" onClick={() => bulkAction("unsnooze")} disabled={syncing} className="inline-flex min-w-max items-center gap-1.5 rounded-lg bg-white px-3 py-2 text-xs font-semibold text-[#4f5752] shadow-sm hover:bg-[#f8f9f8] disabled:opacity-50"><ActionIcon name="open" />Open</button>}
            <button type="button" onClick={() => bulkAction("assign")} disabled={syncing} className="inline-flex min-w-max items-center gap-1.5 rounded-lg bg-white px-3 py-2 text-xs font-semibold text-slate-600 shadow-sm hover:bg-slate-50 disabled:opacity-50"><ActionIcon name="move" />Assign project</button>
            <button type="button" onClick={() => bulkAction("merge")} disabled={syncing || selectedIds.length < 2} className="inline-flex min-w-max items-center gap-1.5 rounded-lg bg-white px-3 py-2 text-xs font-semibold text-violet-700 shadow-sm hover:bg-violet-50 disabled:opacity-40"><ActionIcon name="merge" />Merge</button>
            <button type="button" onClick={() => bulkAction("delete")} disabled={syncing} className="inline-flex min-w-max items-center gap-1.5 rounded-lg bg-white px-3 py-2 text-xs font-semibold text-red-700 shadow-sm hover:bg-red-50 disabled:opacity-50"><ActionIcon name="delete" />Delete</button>
            <button type="button" onClick={() => setSelected(new Set())} className="ml-auto inline-flex min-w-max items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold text-[#69716c] hover:bg-black/[0.04]"><ActionIcon name="cancel" />Cancel</button>
          </div>
        </div>
      )}

      {newProjectOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center overflow-x-hidden sm:items-center sm:p-5" role="dialog" aria-modal="true" aria-labelledby="new-project-title">
          <button type="button" aria-label="Close new project dialog" onClick={closeNewProjectDialog} className="absolute inset-0 bg-black/35 backdrop-blur-[2px]" />
          <form onSubmit={createProject} className="relative w-full max-w-full overflow-x-hidden rounded-t-3xl bg-white px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-5 shadow-2xl sm:max-w-md sm:rounded-3xl sm:p-6">
            <div className="flex min-w-0 items-start justify-between gap-4">
              <div className="min-w-0">
                <span className="mb-3 grid h-11 w-11 place-items-center rounded-xl bg-[#eaf3ed] text-[#216e4e]"><ActionIcon name="create-project" className="h-6 w-6" /></span>
                <h3 id="new-project-title" className="text-lg font-semibold text-[#202522]">Create project</h3>
                <p className="mt-1 text-sm leading-5 text-[#7c847f]">Add a project you can assign tasks to and filter by.</p>
              </div>
              <button type="button" onClick={closeNewProjectDialog} disabled={creatingProject} className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#f1f2f0] text-[#4f5752] hover:bg-[#e8eae7] disabled:opacity-50" aria-label="Close new project dialog" title="Close"><ActionIcon name="close" /></button>
            </div>
            <label className="mt-5 block min-w-0">
              <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[#69716c]">Project name</span>
              <input
                autoFocus
                value={newProjectName}
                onChange={(event) => { setNewProjectName(event.target.value); setNewProjectError(""); }}
                placeholder="e.g. Reference, Home, Work"
                maxLength={120}
                className="h-12 w-full min-w-0 max-w-full rounded-xl border border-black/[0.1] px-3 text-[16px] outline-none focus:border-[#216e4e]/50 focus:ring-3 focus:ring-[#216e4e]/10"
              />
            </label>
            {newProjectError && <p role="alert" className="mt-3 text-sm font-medium text-red-700">{newProjectError}</p>}
            <div className="mt-6 flex items-center justify-end gap-2">
              <button type="button" onClick={closeNewProjectDialog} disabled={creatingProject} className="inline-flex h-11 items-center gap-2 rounded-xl px-4 text-sm font-semibold text-[#69716c] hover:bg-[#f3f4f2] disabled:opacity-50"><ActionIcon name="cancel" />Cancel</button>
              <button type="submit" disabled={creatingProject || !newProjectName.trim()} className="inline-flex h-11 items-center gap-2 rounded-xl bg-[#216e4e] px-5 text-sm font-semibold text-white hover:bg-[#195d41] disabled:opacity-50"><ActionIcon name="create-project" />{creatingProject ? "Creating…" : "Create project"}</button>
            </div>
          </form>
        </div>
      )}

      {projectDeleteDialog && (() => {
        const noteCount = todos.filter((todo) => todo.project === projectDeleteDialog.name).length;
        const alternatives = registeredProjects.filter((name) => name !== projectDeleteDialog.name);
        return (
          <div className="fixed inset-0 z-50 flex items-end justify-center overflow-x-hidden sm:items-center sm:p-5" role="dialog" aria-modal="true" aria-labelledby="delete-project-title">
            <button type="button" aria-label="Close delete project dialog" onClick={closeProjectDeleteDialog} className="absolute inset-0 bg-black/35 backdrop-blur-[2px]" />
            <form onSubmit={deleteProject} className="relative max-h-[92dvh] w-full max-w-full overflow-x-hidden overflow-y-auto rounded-t-3xl bg-white px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-5 shadow-2xl sm:max-w-md sm:rounded-3xl sm:p-6">
              <div className="flex min-w-0 items-start justify-between gap-4">
                <div className="min-w-0">
                  <span className="mb-3 grid h-11 w-11 place-items-center rounded-xl bg-red-50 text-red-700"><ActionIcon name="delete" className="h-5 w-5" /></span>
                  <h3 id="delete-project-title" className="break-words text-lg font-semibold text-[#202522]">Delete {projectDeleteDialog.name}?</h3>
                  <p className="mt-1 text-sm leading-5 text-[#7c847f]">{noteCount ? `This project contains ${noteCount} ${noteCount === 1 ? "task" : "tasks"}. Choose what happens to them.` : "This project is empty and can be safely removed."}</p>
                </div>
                <button type="button" onClick={closeProjectDeleteDialog} disabled={deletingProject} className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#f1f2f0] text-[#4f5752] hover:bg-[#e8eae7] disabled:opacity-50" aria-label="Close delete project dialog" title="Close"><ActionIcon name="close" /></button>
              </div>

              {noteCount > 0 && (
                <fieldset className="mt-5 space-y-2">
                  <legend className="sr-only">Choose what happens to project tasks</legend>
                  <label className={classNames("block rounded-2xl border p-4 transition", projectDeleteDialog.mode === "reassign" ? "border-[#216e4e]/35 bg-[#f3f8f5]" : "border-black/[0.09]") }>
                    <span className="flex items-start gap-3">
                      <input
                        type="radio"
                        name="delete-project-mode"
                        checked={projectDeleteDialog.mode === "reassign"}
                        disabled={!alternatives.length}
                        onChange={() => setProjectDeleteDialog((current) => current ? { ...current, mode: "reassign", targetProject: current.targetProject || alternatives[0] || "" } : current)}
                        className="mt-0.5 h-4 w-4 accent-[#216e4e]"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold text-[#303632]">Move tasks to another project</span>
                        <span className="mt-0.5 block text-xs leading-5 text-[#7c847f]">Keep every task and reassign it before removing this project.</span>
                      </span>
                    </span>
                    {projectDeleteDialog.mode === "reassign" && alternatives.length > 0 && (
                      <select
                        autoFocus
                        value={projectDeleteDialog.targetProject}
                        onChange={(event) => { setProjectDeleteDialog((current) => current ? { ...current, targetProject: event.target.value } : current); setProjectDeleteError(""); }}
                        className="mt-3 h-11 w-full rounded-xl border border-black/[0.1] bg-white px-3 text-sm text-[#303632] outline-none focus:border-[#216e4e]/50"
                        aria-label="Destination project"
                      >
                        {alternatives.map((name) => <option key={name} value={name}>{name}</option>)}
                      </select>
                    )}
                    {!alternatives.length && <span className="mt-2 block pl-7 text-xs text-[#8a918d]">Create another project first to use this option.</span>}
                  </label>

                  <label className={classNames("flex items-start gap-3 rounded-2xl border p-4 transition", projectDeleteDialog.mode === "delete" ? "border-red-300 bg-red-50" : "border-black/[0.09]")}>
                    <input type="radio" name="delete-project-mode" checked={projectDeleteDialog.mode === "delete"} onChange={() => setProjectDeleteDialog((current) => current ? { ...current, mode: "delete" } : current)} className="mt-0.5 h-4 w-4 accent-red-700" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-red-800">Delete the tasks too</span>
                      <span className="mt-0.5 block text-xs leading-5 text-red-700/75">Remove the project and all {noteCount} {noteCount === 1 ? "task" : "tasks"} assigned to it.</span>
                    </span>
                  </label>
                </fieldset>
              )}

              {projectDeleteError && <p role="alert" className="mt-3 text-sm font-medium text-red-700">{projectDeleteError}</p>}
              <div className="mt-6 flex items-center justify-end gap-2">
                <button type="button" onClick={closeProjectDeleteDialog} disabled={deletingProject} className="inline-flex h-11 items-center gap-2 rounded-xl px-4 text-sm font-semibold text-[#69716c] hover:bg-[#f3f4f2] disabled:opacity-50"><ActionIcon name="cancel" />Cancel</button>
                <button type="submit" disabled={deletingProject || (noteCount > 0 && projectDeleteDialog.mode === "reassign" && !projectDeleteDialog.targetProject)} className="inline-flex h-11 items-center gap-2 rounded-xl bg-red-700 px-5 text-sm font-semibold text-white hover:bg-red-800 disabled:opacity-50"><ActionIcon name="delete" />{deletingProject ? "Deleting…" : projectDeleteDialog.mode === "delete" && noteCount > 0 ? "Delete project & tasks" : "Delete project"}</button>
              </div>
            </form>
          </div>
        );
      })()}

      {projectDialog && (
        <div className="fixed inset-0 z-[60] flex items-end justify-center overflow-x-hidden sm:items-center sm:p-5" role="dialog" aria-modal="true" aria-labelledby="project-dialog-title">
          <button type="button" aria-label="Close project assignment" onClick={closeProjectAssignment} className="absolute inset-0 bg-black/35 backdrop-blur-[2px]" />
          <form onSubmit={saveProjectAssignment} className="relative max-h-[92dvh] w-full max-w-full overflow-x-hidden overflow-y-auto rounded-t-3xl bg-white px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-5 shadow-2xl sm:max-w-md sm:rounded-3xl sm:p-6">
            <div className="flex min-w-0 items-start justify-between gap-4">
              <div className="min-w-0">
                <h3 id="project-dialog-title" className="text-lg font-semibold text-[#202522]">Assign project</h3>
                <p className="mt-1 text-sm leading-5 text-[#7c847f]">
                  Assign {projectDialog.ids.length === 1 ? "this task" : `these ${projectDialog.ids.length} tasks`} to an existing or new project, or leave {projectDialog.ids.length === 1 ? "it" : "them"} unassigned.
                </p>
              </div>
              <button type="button" onClick={closeProjectAssignment} disabled={savingProject} className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#f1f2f0] text-[#4f5752] hover:bg-[#e8eae7] disabled:opacity-50" aria-label="Close project assignment" title="Close"><ActionIcon name="close" /></button>
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
                <option value={UNASSIGNED_PROJECT}>Unassigned</option>
                {projects.map((name) => <option key={name} value={name}>{name}</option>)}
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
              <button type="button" onClick={closeProjectAssignment} disabled={savingProject} className="inline-flex h-11 items-center gap-2 rounded-xl px-4 text-sm font-semibold text-[#69716c] hover:bg-[#f3f4f2] disabled:opacity-50"><ActionIcon name="cancel" />Cancel</button>
              <button type="submit" disabled={savingProject || !projectDialog.selection || (projectDialog.selection === CREATE_PROJECT && !projectDialog.newProject.trim())} className="inline-flex h-11 items-center gap-2 rounded-xl bg-[#216e4e] px-5 text-sm font-semibold text-white hover:bg-[#195d41] disabled:opacity-50">
                <ActionIcon name="move" />
                {savingProject ? "Saving…" : "Assign project"}
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
              <button type="button" onClick={closeTaskDetails} className="grid h-9 w-9 place-items-center rounded-full bg-[#f1f2f0] text-[#4f5752] hover:bg-[#e8eae7]" aria-label="Close task details" title="Close"><ActionIcon name="close" /></button>
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
                <div className="block min-w-0">
                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[#69716c]">Project</span>
                  <button
                    type="button"
                    onClick={() => openProjectAssignment([editingTodo.id], "details")}
                    disabled={savingEdit}
                    aria-label={`Assign project. Current project: ${editDraft.project || "Unassigned"}`}
                    className="flex h-11 w-full min-w-0 max-w-full items-center justify-between gap-3 rounded-xl border border-black/[0.1] bg-white px-3 text-left text-[16px] text-[#303632] outline-none hover:bg-[#fafbf9] focus:border-[#216e4e]/50 focus:ring-3 focus:ring-[#216e4e]/10 disabled:opacity-60"
                  >
                    <span className="min-w-0 truncate">{editDraft.project || "Unassigned"}</span>
                    <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-semibold text-[#216e4e]"><ActionIcon name="move" />Change</span>
                  </button>
                </div>
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
                  {editingTodo.status === "completed" ? (
                    <button type="button" onClick={() => detailAction("unsnooze")} disabled={syncing || savingEdit} className="inline-flex min-w-max items-center gap-2 rounded-xl bg-[#eaf3ed] px-3 py-2.5 text-sm font-semibold text-[#195d41] disabled:opacity-50"><ActionIcon name={todoActionIcon("unsnooze", "Open")} />Open</button>
                  ) : (
                    <button type="button" onClick={() => detailAction("complete")} disabled={syncing || savingEdit} className="inline-flex min-w-max items-center gap-2 rounded-xl bg-[#eaf3ed] px-3 py-2.5 text-sm font-semibold text-[#195d41] disabled:opacity-50"><ActionIcon name={todoActionIcon("complete", "Done")} />Done</button>
                  )}
                  {editingTodo.status === "open" && (isSnoozed(editingTodo, now) ? (
                    <button type="button" onClick={() => detailAction("unsnooze")} disabled={syncing || savingEdit} className="inline-flex min-w-max items-center gap-2 rounded-xl bg-[#eaf3ed] px-3 py-2.5 text-sm font-semibold text-[#195d41] disabled:opacity-50"><ActionIcon name={todoActionIcon("unsnooze", "Wake")} />Wake</button>
                  ) : (
                    <button type="button" onClick={() => detailAction("snooze")} disabled={syncing || savingEdit} className="inline-flex min-w-max items-center gap-2 rounded-xl bg-amber-50 px-3 py-2.5 text-sm font-semibold text-amber-700 disabled:opacity-50"><ActionIcon name={todoActionIcon("snooze", "Snooze")} />Snooze</button>
                  ))}
                  <button type="button" onClick={() => openProjectAssignment([editingTodo.id], "details")} disabled={syncing || savingEdit} className="inline-flex min-w-max items-center gap-2 rounded-xl bg-slate-100 px-3 py-2.5 text-sm font-semibold text-slate-700 disabled:opacity-50"><ActionIcon name={todoActionIcon("assign", "Assign project")} />Assign project</button>
                  <button type="button" onClick={() => detailAction("delete")} disabled={syncing || savingEdit} className="inline-flex min-w-max items-center gap-2 rounded-xl bg-red-50 px-3 py-2.5 text-sm font-semibold text-red-700 disabled:opacity-50"><ActionIcon name={todoActionIcon("delete", "Delete")} />Delete</button>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-black/[0.07] bg-white px-5 py-3 sm:px-6">
              <button type="button" onClick={closeTaskDetails} disabled={savingEdit} className="inline-flex h-11 items-center gap-2 rounded-xl px-4 text-sm font-semibold text-[#69716c] hover:bg-[#f3f4f2] disabled:opacity-50"><ActionIcon name="cancel" />Cancel</button>
              <button type="submit" disabled={savingEdit || !editDraft.title.trim()} className="inline-flex h-11 items-center gap-2 rounded-xl bg-[#216e4e] px-5 text-sm font-semibold text-white hover:bg-[#195d41] disabled:opacity-50"><ActionIcon name="save" />{savingEdit ? "Saving…" : "Save changes"}</button>
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
                className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 font-semibold text-[#8ee0b5] transition hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white disabled:opacity-50"
              >
                <ActionIcon name="undo" />
                {undoing ? "Undoing…" : "Undo"}
              </button>
            )}
            <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss notification" title="Dismiss" className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-white/65 hover:bg-white/10 hover:text-white"><ActionIcon name="close" /></button>
          </div>
        </div>
      )}
    </main>
  );
}
