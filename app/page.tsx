"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

type TodoStatus = "open" | "completed" | "archived";
type View = "open" | "today" | "completed" | "all";
type Sort = "smart" | "priority" | "due" | "newest" | "oldest" | "az";

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
  createdAt: string;
  updatedAt: string;
};

const viewLabels: Record<View, string> = {
  open: "Open",
  today: "Today",
  completed: "Done",
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
    headers: { "Content-Type": "application/json", ...(options?.headers ?? {}) },
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

function compareSmart(a: Todo, b: Todo) {
  const aDue = a.dueDate ? new Date(a.dueDate).valueOf() : Number.POSITIVE_INFINITY;
  const bDue = b.dueDate ? new Date(b.dueDate).valueOf() : Number.POSITIVE_INFINITY;
  if (aDue !== bDue) return aDue - bDue;
  if (a.priority !== b.priority) return a.priority - b.priority;
  return new Date(b.updatedAt).valueOf() - new Date(a.updatedAt).valueOf();
}

function matchesView(todo: Todo, view: View) {
  if (view === "open") return todo.status === "open";
  if (view === "today") return todo.status === "open" && isTodayOrOverdue(todo.dueDate);
  if (view === "completed") return todo.status === "completed";
  return todo.status !== "archived";
}

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
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
  const [message, setMessage] = useState("");
  const captureRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    request<{ todos: Todo[] }>("/api/todos")
      .then(({ todos: loaded }) => {
        if (!active) return;
        setTodos(loaded);
        console.info("[todo-ui] loaded", { count: loaded.length });
      })
      .catch((error: Error) => active && setMessage(error.message))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
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
    open: todos.filter((todo) => matchesView(todo, "open")).length,
    today: todos.filter((todo) => matchesView(todo, "today")).length,
    completed: todos.filter((todo) => matchesView(todo, "completed")).length,
    all: todos.filter((todo) => matchesView(todo, "all")).length,
  }), [todos]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const rows = todos.filter((todo) => {
      const searchable = [todo.title, todo.notes, todo.project, todo.context].filter(Boolean).join(" ").toLowerCase();
      return matchesView(todo, view)
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
  }, [todos, view, query, project, priority, sort]);

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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    setNewTitle("");
    setView("open");
    setTodos((current) => [optimistic, ...current]);
    setAdding(true);
    setSyncing(true);
    setMessage("");
    try {
      const { todo } = await request<{ todo: Todo }>("/api/todos", {
        method: "POST",
        body: JSON.stringify({ title }),
      });
      setTodos((current) => current.map((item) => item.id === temporaryId ? todo : item));
      console.info("[todo-ui] created", { id: todo.id });
    } catch (error) {
      setTodos((current) => current.filter((item) => item.id !== temporaryId));
      setNewTitle(title);
      setMessage(error instanceof Error ? error.message : "The task could not be added.");
    } finally {
      setAdding(false);
      setSyncing(false);
      captureRef.current?.focus();
    }
  }

  async function patchTodo(todo: Todo, update: Partial<Todo>) {
    const previous = todo;
    setTodos((current) => current.map((item) => item.id === todo.id ? { ...item, ...update, updatedAt: new Date().toISOString() } : item));
    setSyncing(true);
    setMessage("");
    try {
      const { todo: saved } = await request<{ todo: Todo }>(`/api/todos/${todo.id}`, {
        method: "PATCH",
        body: JSON.stringify(update),
      });
      setTodos((current) => current.map((item) => item.id === todo.id ? saved : item));
      console.info("[todo-ui] updated", { id: saved.id, status: saved.status });
    } catch (error) {
      setTodos((current) => current.map((item) => item.id === previous.id ? previous : item));
      setMessage(error instanceof Error ? error.message : "The task could not be updated.");
    } finally {
      setSyncing(false);
    }
  }

  const filtersActive = Boolean(query || project || priority || sort !== "smart");

  return (
    <main className="min-h-screen bg-[#f6f7f5] text-[#1d211f]">
      <header className="sticky top-0 z-20 border-b border-black/[0.06] bg-[#f6f7f5]/90 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="grid h-9 w-9 place-items-center rounded-xl bg-[#216e4e] text-lg font-semibold text-white shadow-sm">✓</div>
            <div>
              <p className="text-[15px] font-semibold tracking-[-0.02em]">Dawar Todo</p>
              <p className="text-xs text-[#69716c]">Fast personal tasks</p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-[#69716c]" aria-live="polite">
            <span className={classNames("h-2 w-2 rounded-full", syncing ? "animate-pulse bg-amber-500" : "bg-emerald-500")} />
            <span>{syncing ? "Saving" : "Synced"}</span>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-4 pb-16 pt-8 sm:px-6 sm:pt-12">
        <section className="mb-8">
          <p className="mb-2 text-sm font-medium text-[#216e4e]">Your day, in order</p>
          <h1 className="max-w-2xl text-3xl font-semibold tracking-[-0.045em] text-[#151816] sm:text-5xl">Capture what needs doing. Then move.</h1>
          <p className="mt-3 max-w-xl text-sm leading-6 text-[#69716c] sm:text-base">Everything important, with nothing in the way.</p>
        </section>

        <form onSubmit={addTodo} className="mb-8 flex gap-2 rounded-2xl border border-black/[0.07] bg-white p-2 shadow-[0_10px_35px_rgba(30,45,36,0.07)] sm:p-3">
          <div className="flex min-w-0 flex-1 items-center gap-3 px-2 sm:px-3">
            <span className="text-xl text-[#216e4e]" aria-hidden="true">＋</span>
            <input
              ref={captureRef}
              value={newTitle}
              onChange={(event) => setNewTitle(event.target.value)}
              placeholder="Add a task…"
              aria-label="Add a task"
              maxLength={500}
              className="h-11 min-w-0 flex-1 bg-transparent text-[16px] text-[#151816] outline-none placeholder:text-[#929994] sm:h-12"
            />
          </div>
          <button
            type="submit"
            disabled={!newTitle.trim() || adding}
            className="rounded-xl bg-[#216e4e] px-4 text-sm font-semibold text-white transition hover:bg-[#195d41] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#216e4e] disabled:cursor-not-allowed disabled:opacity-40 sm:px-6"
          >
            {adding ? "Adding…" : "Add"}
          </button>
        </form>

        {message && (
          <div role="alert" className="mb-5 flex items-center justify-between rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            <span>{message}</span>
            <button onClick={() => setMessage("")} className="rounded px-2 py-1 font-medium hover:bg-red-100">Dismiss</button>
          </div>
        )}

        <section aria-labelledby="tasks-heading">
          <div className="mb-4 flex gap-1 overflow-x-auto rounded-xl border border-black/[0.06] bg-white p-1 shadow-sm">
            {(Object.keys(viewLabels) as View[]).map((item) => (
              <button
                key={item}
                onClick={() => setView(item)}
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

          <div className="mb-4 grid gap-2 sm:grid-cols-[minmax(220px,1fr)_auto_auto_auto]">
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

          <div className="mb-3 flex items-center justify-between px-1">
            <h2 id="tasks-heading" className="text-sm font-semibold text-[#373d39]">{viewLabels[view]} tasks</h2>
            <div className="flex items-center gap-3 text-xs text-[#7c847f]">
              <span>{filtered.length} {filtered.length === 1 ? "item" : "items"}</span>
              {filtersActive && <button onClick={() => { setQuery(""); setProject(""); setPriority(""); setSort("smart"); }} className="font-medium text-[#216e4e] hover:underline">Clear filters</button>}
            </div>
          </div>

          <div className="overflow-hidden rounded-2xl border border-black/[0.07] bg-white shadow-[0_8px_30px_rgba(30,45,36,0.05)]">
            {loading ? (
              <div role="status" className="space-y-1 p-2" aria-label="Loading tasks">
                {[0, 1, 2, 3, 4].map((item) => <div key={item} className="h-[72px] animate-pulse rounded-xl bg-[#f3f4f2]" />)}
              </div>
            ) : filtered.length ? (
              <ul className="divide-y divide-black/[0.055]">
                {filtered.map((todo) => {
                  const done = todo.status === "completed";
                  const pending = todo.id < 0;
                  return (
                    <li key={todo.id} className="group flex min-h-[72px] items-start gap-3 px-4 py-4 transition hover:bg-[#fafbf9] sm:px-5">
                      <button
                        onClick={() => !pending && patchTodo(todo, { status: done ? "open" : "completed" })}
                        disabled={pending}
                        aria-label={done ? `Mark open: ${todo.title}` : `Mark done: ${todo.title}`}
                        className={classNames(
                          "mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 text-[11px] transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#216e4e]",
                          done ? "border-[#216e4e] bg-[#216e4e] text-white" : "border-[#aeb5b0] text-transparent hover:border-[#216e4e]",
                          pending && "animate-pulse",
                        )}
                      >✓</button>
                      <div className="min-w-0 flex-1">
                        <p className={classNames("text-[15px] leading-5 text-[#202522]", done && "text-[#8b928e] line-through")}>{todo.title}</p>
                        {(todo.project || todo.context || todo.dueDate || todo.priority <= 2) && (
                          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[#747c77]">
                            {todo.priority <= 2 && <span className={classNames("rounded-full px-2 py-0.5 font-medium", todo.priority === 1 ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-700")}>{priorityLabels[todo.priority]}</span>}
                            {todo.project && <span className="rounded-full bg-[#f0f2ef] px-2 py-0.5">{todo.project}</span>}
                            {todo.context && <span>{todo.context}</span>}
                            {todo.dueDate && <span className={classNames(isTodayOrOverdue(todo.dueDate) && todo.status === "open" ? "font-medium text-red-600" : "")}>{dueLabel(todo.dueDate)}</span>}
                          </div>
                        )}
                      </div>
                      <button
                        onClick={() => !pending && patchTodo(todo, { status: "archived" })}
                        disabled={pending}
                        aria-label={`Archive: ${todo.title}`}
                        className="rounded-lg px-2 py-1 text-xs text-[#7c847f] opacity-100 transition hover:bg-[#eef0ed] hover:text-[#373d39] focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-[#216e4e] sm:opacity-0 sm:group-hover:opacity-100"
                      >Archive</button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="px-6 py-16 text-center">
                <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-[#eaf3ed] text-xl text-[#216e4e]">✓</div>
                <p className="font-medium text-[#303632]">{filtersActive ? "No tasks match those filters." : view === "completed" ? "Nothing completed yet." : "You’re clear."}</p>
                <p className="mt-1 text-sm text-[#7c847f]">{filtersActive ? "Try clearing a filter or changing the search." : "Add the next thing when it appears."}</p>
              </div>
            )}
          </div>
        </section>

        <footer className="mt-6 flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-[#858c87]">
          <span>Imported from GTD OS · saved privately</span>
          <span className="hidden sm:inline"><kbd className="rounded border border-black/10 bg-white px-1.5 py-0.5">N</kbd> new task &nbsp; <kbd className="rounded border border-black/10 bg-white px-1.5 py-0.5">/</kbd> search</span>
        </footer>
      </div>
    </main>
  );
}
