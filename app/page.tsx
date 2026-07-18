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
type Notice = { tone: "success" | "error"; text: string } | null;

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
}: {
  todo: Todo;
  selected: boolean;
  now: number;
  onSelect: (todo: Todo) => void;
  onAction: (todo: Todo, action: TodoAction, source: "hover" | "swipe") => void;
}) {
  const [offset, setOffset] = useState(0);
  const [swipeWidth, setSwipeWidth] = useState(1);
  const [dragging, setDragging] = useState(false);
  const gesture = useRef<{ startX: number; startY: number; width: number } | null>(null);
  const offsetRef = useRef(0);
  const pending = todo.id < 0;
  const snoozed = isSnoozed(todo, now);
  const swipeRatio = Math.abs(offset) / swipeWidth;
  const longSwipe = swipeRatio >= 0.5;
  const revealAction = offset < 0 ? (longSwipe ? "Snooze" : "Done") : (longSwipe ? "Delete" : "Archive");
  const revealClass = offset < 0
    ? longSwipe ? "bg-amber-500" : "bg-[#216e4e]"
    : longSwipe ? "bg-red-600" : "bg-slate-500";

  function pointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (pending || event.pointerType !== "touch") return;
    if ((event.target as HTMLElement).closest("button, input, a, select, textarea")) return;
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
    if (direction < 0) onAction(todo, ratio >= 0.5 ? "snooze" : "complete", "swipe");
    else onAction(todo, ratio >= 0.5 ? "delete" : "archive", "swipe");
  }

  function cancelSwipe() {
    gesture.current = null;
    offsetRef.current = 0;
    setDragging(false);
    setOffset(0);
  }

  const primaryAction: { action: TodoAction; label: string } = snoozed
    ? { action: "unsnooze", label: "Wake" }
    : todo.status === "open"
      ? { action: "complete", label: "Done" }
      : { action: "unsnooze", label: "Restore" };
  const hoverActions: Array<{ action: TodoAction; label: string }> = [
    primaryAction,
    ...(!snoozed && todo.status === "open" ? [{ action: "snooze" as const, label: "Snooze" }] : []),
    ...(todo.status !== "archived" ? [{ action: "archive" as const, label: "Archive" }] : []),
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
        <div className="min-w-0 flex-1">
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
        </div>
        {!pending && (
          <div className="hidden shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 md:flex">
            {hoverActions.map(({ action, label }) => (
              <button
                key={action}
                onClick={() => onAction(todo, action, "hover")}
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
  const [notice, setNotice] = useState<Notice>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [now, setNow] = useState(() => Date.now());
  const captureRef = useRef<HTMLTextAreaElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

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
      if (event.key === "Escape" && target === searchRef.current) {
        setQuery("");
        searchRef.current?.blur();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const projects = useMemo(
    () => [...new Set(todos.map((todo) => todo.project).filter((value): value is string => Boolean(value)))].sort(),
    [todos],
  );

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
        && (!project || todo.project === project)
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

  function applyOptimisticAction(current: Todo[], ids: number[], action: TodoAction) {
    const idSet = new Set(ids);
    if (action === "delete") return current.filter((todo) => !idSet.has(todo.id));
    const temporarySnooze = new Date(Date.now() + 36 * 60 * 60 * 1000).toISOString();
    return current.map((todo) => {
      if (!idSet.has(todo.id)) return todo;
      if (action === "complete") return { ...todo, status: "completed" as const, completedAt: new Date().toISOString(), snoozedUntil: null };
      if (action === "archive") return { ...todo, status: "archived" as const, snoozedUntil: null };
      if (action === "snooze") return { ...todo, status: "open" as const, completedAt: null, snoozedUntil: temporarySnooze };
      return { ...todo, status: "open" as const, completedAt: null, snoozedUntil: null };
    });
  }

  async function performAction(ids: number[], action: TodoAction | "merge") {
    if (!ids.length || syncing) return;
    const previous = todos;
    setSyncing(true);
    setNotice(null);
    if (action !== "merge") setTodos((current) => applyOptimisticAction(current, ids, action));
    try {
      if (action === "merge") {
        const result = await request<{ todo: Todo; ids: number[] }>("/api/todos/bulk", {
          method: "POST",
          body: JSON.stringify({ ids, action }),
        });
        const sourceIds = new Set(result.ids);
        setTodos((current) => [
          result.todo,
          ...current.map((todo) => sourceIds.has(todo.id) ? { ...todo, status: "archived" as const, snoozedUntil: null } : todo),
        ]);
        setNotice({ tone: "success", text: `Merged ${result.ids.length} tasks. The originals are in Archived.` });
        console.info("[todo-ui] merged", { sourceIds: result.ids, mergedId: result.todo.id });
      } else {
        const result = await request<{ todos: Todo[]; ids: number[]; snoozedUntil: string | null }>("/api/todos/bulk", {
          method: "POST",
          body: JSON.stringify({ ids, action }),
        });
        if (action !== "delete") {
          const updates = new Map(result.todos.map((todo) => [todo.id, todo]));
          setTodos((current) => current.map((todo) => updates.get(todo.id) ?? todo));
        }
        const label = action === "complete" ? "Done" : action === "archive" ? "Archived" : action === "snooze" ? "Snoozed until tomorrow" : action === "unsnooze" ? "Restored to Open" : "Deleted";
        setNotice({ tone: "success", text: `${label}: ${ids.length} ${ids.length === 1 ? "task" : "tasks"}.` });
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

  function taskAction(todo: Todo, action: TodoAction, source: "hover" | "swipe") {
    if (action === "delete" && source !== "swipe" && !window.confirm(`Delete “${todo.title}”? This cannot be undone.`)) return;
    void performAction([todo.id], action);
  }

  function bulkAction(action: TodoAction | "merge") {
    if (action === "merge" && selectedIds.length < 2) {
      setNotice({ tone: "error", text: "Select at least two tasks to merge." });
      return;
    }
    if (action === "delete" && !window.confirm(`Delete ${selectedIds.length} selected tasks? This cannot be undone.`)) return;
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
    setSelected(new Set());
  }

  return (
    <main className="min-h-screen bg-[#f6f7f5] text-[#1d211f]">
      <SiteHeader current="todos" />
      <div className="mx-auto max-w-5xl px-4 pb-16 pt-5 sm:px-6 sm:pt-7">
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

        {notice && (
          <div role={notice.tone === "error" ? "alert" : "status"} className={classNames("mb-4 flex items-center justify-between rounded-xl border px-4 py-3 text-sm", notice.tone === "error" ? "border-red-200 bg-red-50 text-red-700" : "border-emerald-200 bg-emerald-50 text-emerald-800")}>
            <span>{notice.text}</span>
            <button onClick={() => setNotice(null)} className="rounded px-2 py-1 font-medium hover:bg-black/[0.04]">Dismiss</button>
          </div>
        )}

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

          <div className="mb-3 grid gap-2 sm:grid-cols-[minmax(220px,1fr)_auto_auto_auto]">
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
            <select value={project} onChange={(event) => setProject(event.target.value)} aria-label="Filter by project" className="h-10 rounded-xl border border-black/[0.08] bg-white px-3 text-sm text-[#4f5752] shadow-sm outline-none focus:border-[#216e4e]/50">
              <option value="">All projects</option>
              {projects.map((name) => <option key={name}>{name}</option>)}
            </select>
            <select value={priority} onChange={(event) => setPriority(event.target.value)} aria-label="Filter by priority" className="h-10 rounded-xl border border-black/[0.08] bg-white px-3 text-sm text-[#4f5752] shadow-sm outline-none focus:border-[#216e4e]/50">
              <option value="">All priorities</option>
              <option value="1">Urgent</option>
              <option value="2">High</option>
              <option value="3">Normal</option>
              <option value="4">Low</option>
            </select>
            <select value={sort} onChange={(event) => setSort(event.target.value as Sort)} aria-label="Sort tasks" className="h-10 rounded-xl border border-black/[0.08] bg-white px-3 text-sm text-[#4f5752] shadow-sm outline-none focus:border-[#216e4e]/50">
              <option value="smart">Smart sort</option>
              <option value="priority">Priority</option>
              <option value="due">Due date</option>
              <option value="newest">Newest</option>
              <option value="oldest">Oldest</option>
              <option value="az">A–Z</option>
            </select>
          </div>

          {selectedIds.length > 0 && (
            <div className="sticky top-[62px] z-20 mb-3 flex items-center gap-2 overflow-x-auto rounded-xl border border-[#216e4e]/20 bg-[#eaf3ed]/95 p-2 shadow-lg shadow-[#173d2a]/10 backdrop-blur">
              <span className="min-w-max px-2 text-sm font-semibold text-[#195d41]">{selectedIds.length} selected</span>
              <button onClick={() => bulkAction("complete")} disabled={syncing} className="min-w-max rounded-lg bg-white px-3 py-2 text-xs font-semibold text-[#216e4e] shadow-sm hover:bg-[#f8fbf9] disabled:opacity-50">Done</button>
              <button onClick={() => bulkAction("snooze")} disabled={syncing} className="min-w-max rounded-lg bg-white px-3 py-2 text-xs font-semibold text-amber-700 shadow-sm hover:bg-amber-50 disabled:opacity-50">Snooze</button>
              <button onClick={() => bulkAction("unsnooze")} disabled={syncing} className="min-w-max rounded-lg bg-white px-3 py-2 text-xs font-semibold text-[#4f5752] shadow-sm hover:bg-[#f8f9f8] disabled:opacity-50">Restore</button>
              <button onClick={() => bulkAction("archive")} disabled={syncing} className="min-w-max rounded-lg bg-white px-3 py-2 text-xs font-semibold text-slate-600 shadow-sm hover:bg-slate-50 disabled:opacity-50">Archive</button>
              <button onClick={() => bulkAction("merge")} disabled={syncing || selectedIds.length < 2} className="min-w-max rounded-lg bg-white px-3 py-2 text-xs font-semibold text-violet-700 shadow-sm hover:bg-violet-50 disabled:opacity-40">Merge</button>
              <button onClick={() => bulkAction("delete")} disabled={syncing} className="min-w-max rounded-lg bg-white px-3 py-2 text-xs font-semibold text-red-700 shadow-sm hover:bg-red-50 disabled:opacity-50">Delete</button>
              <button onClick={() => setSelected(new Set())} className="ml-auto min-w-max rounded-lg px-3 py-2 text-xs font-semibold text-[#69716c] hover:bg-black/[0.04]">Cancel</button>
            </div>
          )}

          <div className="mb-2 flex items-center justify-between px-1">
            <div className="flex items-center gap-3">
              <h2 id="tasks-heading" className="text-sm font-semibold text-[#373d39]">{viewLabels[view]} tasks</h2>
              {filtered.length > 0 && <button onClick={toggleVisible} className="text-xs font-medium text-[#216e4e] hover:underline">{allVisibleSelected ? "Clear selection" : "Select visible"}</button>}
            </div>
            <div className="flex items-center gap-3 text-xs text-[#7c847f]">
              <span>{syncing ? "Saving…" : `${filtered.length} ${filtered.length === 1 ? "item" : "items"}`}</span>
              {filtersActive && <button onClick={() => { setQuery(""); setProject(""); setPriority(""); setSort("smart"); }} className="font-medium text-[#216e4e] hover:underline">Clear filters</button>}
            </div>
          </div>

          <p className="mb-2 px-1 text-[11px] text-[#8a918d] md:hidden">Swipe left: done / snooze · Swipe right: archive / delete</p>

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
    </main>
  );
}
