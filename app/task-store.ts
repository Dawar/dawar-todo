"use client";
import { useCallback, useSyncExternalStore } from "react";
import { taskKey, type Todo } from "./task-model";

const EMPTY: Todo[] = [];
type Listener = () => void;
function equal(a: Todo, b: Todo) {
  return Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, value]) => value === b[key as keyof Todo]);
}

export function createTaskStore() {
  let list = EMPTY;
  let version = 0;
  const records = new Map<string, Todo>();
  const idKeys = new Map<number, string>();
  const views = new Map<string, Todo>();
  const drafts = new Map<string, Partial<Todo>>();
  const listeners = new Set<Listener>();
  const rows = new Map<string, Set<Listener>>();
  const emitRow = (key: string) => rows.get(key)?.forEach((listener) => listener());
  const updateView = (key: string) => {
    const record = records.get(key);
    if (!record) views.delete(key);
    else {
      const next = drafts.has(key) ? { ...record, ...drafts.get(key) } : record;
      const previous = views.get(key);
      if (previous && equal(previous, next)) return;
      views.set(key, next);
    }
    emitRow(key);
  };
  return {
    getList: () => list,
    getVersion: () => version,
    get: (key: string) => views.get(key),
    getById: (id: number) => records.get(idKeys.get(id) ?? ""),
    getDraft: (key: string) => drafts.get(key),
    subscribe(listener: Listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    subscribeRow(key: string, listener: Listener) {
      if (!rows.has(key)) rows.set(key, new Set());
      rows.get(key)!.add(listener);
      return () => { const set = rows.get(key); set?.delete(listener); if (!set?.size) rows.delete(key); };
    },
    setAll(next: Todo[] | ((current: Todo[]) => Todo[])) {
      const incoming = typeof next === "function" ? next(list) : next;
      const keys = new Set<string>();
      const changed = new Set<string>();
      const previousList = new Map(list.map((todo) => [taskKey(todo), todo]));
      const resolved = incoming.map((todo) => {
        const key = taskKey(todo);
        keys.add(key); idKeys.set(todo.id, key);
        const old = records.get(key);
        if (!old || !equal(old, todo)) { records.set(key, todo); changed.add(key); }
        const prior = previousList.get(key);
        const draft = drafts.get(key);
        const listed = prior && draft ? { ...todo, ...Object.fromEntries(Object.keys(draft).map((field) => [field, prior[field as keyof Todo]])) } : todo;
        return prior && equal(prior, listed) ? prior : listed;
      });
      for (const key of records.keys()) if (!keys.has(key)) { records.delete(key); drafts.delete(key); changed.add(key); }
      if (!changed.size && list.length === resolved.length && list.every((todo, index) => todo === resolved[index])) return;
      const listChanged = list.length !== resolved.length || list.some((todo, index) => todo !== resolved[index]);
      if (listChanged) { list = resolved; version++; }
      changed.forEach(updateView);
      if (listChanged) listeners.forEach((listener) => listener());
    },
    setDraft(key: string, patch: Partial<Todo>) {
      version++;
      drafts.set(key, { ...drafts.get(key), ...patch });
      updateView(key);
    },
    clearDraft(key: string, saved: Partial<Todo>) {
      const pending = { ...drafts.get(key) };
      const committed: Partial<Todo> = {};
      for (const [field, value] of Object.entries(saved)) if (pending[field as keyof Todo] === value) {
        delete pending[field as keyof Todo]; Object.assign(committed, { [field]: value });
      }
      const record = records.get(key);
      if (record) records.set(key, { ...record, ...committed });
      if (Object.keys(pending).length) drafts.set(key, pending); else drafts.delete(key);
      updateView(key);
      const latest = records.get(key);
      if (latest && Object.keys(committed).length) {
        list = list.map((todo) => taskKey(todo) === key ? { ...todo, ...committed } : todo);
        listeners.forEach((listener) => listener());
      }
    },
  };
}
export const taskStore = createTaskStore();
export function useTaskList() {
  const tasks = useSyncExternalStore(taskStore.subscribe, taskStore.getList, () => EMPTY);
  return [tasks, taskStore.setAll] as const;
}
export function useTask(key: string) {
  return useSyncExternalStore(useCallback((listener: Listener) => taskStore.subscribeRow(key, listener), [key]), () => taskStore.get(key), () => undefined);
}
