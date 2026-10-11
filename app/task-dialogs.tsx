"use client";

import { useId, type FormEvent } from "react";
import { ControlledDialog } from "@/components/ui/controlled-dialog";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Input } from "@/components/ui/input";

export function CreateProjectDialog({ name, error, busy, onName, onClose, onSubmit }: {
  name: string; error: string; busy: boolean; onName: (value: string) => void;
  onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const errorId = useId();
  return <ControlledDialog title="Create project" description="Group related tasks in a project." onClose={onClose} onEscapeKeyDown={event => event.stopPropagation()} className="max-w-md">
    <form onSubmit={onSubmit} aria-busy={busy} className="space-y-5">
      <label className="grid gap-2 text-sm font-medium">Project name
        <Input autoFocus value={name} onChange={event => onName(event.target.value)} placeholder="e.g. Home or Work" maxLength={120} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} />
      </label>
      {error && <p id={errorId} role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button type="submit" disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create project"}</Button>
      </div>
    </form>
  </ControlledDialog>;
}

export function CustomSnoozeDialog({ count, value, error, timeZone, busy, onValue, onClose, onSubmit }: {
  count: number; value: string; error: string; timeZone: string; busy: boolean;
  onValue: (value: string) => void; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const helpId = useId();
  return <ControlledDialog title="Snooze" description={`Choose when ${count === 1 ? "this task" : `these ${count} tasks`} should return.`} onClose={onClose} onEscapeKeyDown={event => event.stopPropagation()} className="max-w-md">
    <form onSubmit={onSubmit} aria-busy={busy} className="space-y-5">
      <div>
        <label className="grid gap-2 text-sm font-medium">Date and time
          <Input autoFocus type="datetime-local" value={value} onChange={event => onValue(event.target.value)} required aria-invalid={Boolean(error)} aria-describedby={helpId} />
        </label>
        <p id={helpId} role={error ? "alert" : undefined} className={`mt-2 break-words text-sm ${error ? "text-destructive" : "text-muted-foreground"}`}>{error || `Time in ${timeZone}`}</p>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
        <Button type="submit" disabled={busy || !value}>{busy ? "Snoozing…" : "Snooze"}</Button>
      </div>
    </form>
  </ControlledDialog>;
}

export function AssignProjectDialog({ count, capture, selection, newName, projects, createValue, unassignedValue, error, busy, onSelection, onName, onClose, onSubmit }: {
  count: number; capture: boolean; selection: string; newName: string; projects: string[];
  createValue: string; unassignedValue: string; error: string; busy: boolean;
  onSelection: (value: string) => void; onName: (value: string) => void;
  onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const errorId = useId();
  return <ControlledDialog title="Assign project" description={capture ? "Choose a project for the new task, or leave it unassigned." : `Choose a project for ${count === 1 ? "this task" : `these ${count} tasks`}.`} onClose={onClose} onEscapeKeyDown={event => event.stopPropagation()} className="max-w-md">
    <form onSubmit={onSubmit} aria-busy={busy} className="space-y-5">
      <label className="grid gap-2 text-sm font-medium">Project
        <NativeSelect autoFocus value={selection} onChange={event => onSelection(event.target.value)} aria-describedby={error ? errorId : undefined}>
          <option value="">Choose a project…</option><option value={unassignedValue}>Unassigned</option>
          {projects.map(name => <option key={name} value={name}>{name}</option>)}
          <option value={createValue}>Create a new project…</option>
        </NativeSelect>
      </label>
      {selection === createValue && <label className="grid gap-2 text-sm font-medium">New project name
        <Input value={newName} onChange={event => onName(event.target.value)} maxLength={120} placeholder="e.g. Home or Work" aria-describedby={error ? errorId : undefined}/>
      </label>}
      {error && <p id={errorId} role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button type="submit" disabled={busy || !selection || (selection === createValue && !newName.trim())}>{busy ? "Saving…" : capture ? "Use project" : "Assign project"}</Button>
      </div>
    </form>
  </ControlledDialog>;
}

export function DeleteProjectDialog({ name, count, alternatives, mode, target, error, busy, onMode, onTarget, onClose, onSubmit }: {
  name: string; count: number; alternatives: string[]; mode: "reassign" | "delete"; target: string; error: string; busy: boolean;
  onMode: (value: "reassign" | "delete") => void; onTarget: (value: string) => void;
  onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const group = useId();
  return <ControlledDialog title={<span className="break-words">Delete {name}?</span>} description={count ? `This project contains ${count} ${count === 1 ? "task" : "tasks"}. Choose what happens to them.` : "This project has no tasks."} onClose={onClose} onEscapeKeyDown={event => event.stopPropagation()} className="max-w-md">
    <form onSubmit={onSubmit} aria-busy={busy} className="space-y-5">
      {count > 0 && <fieldset className="space-y-3">
        <legend className="sr-only">Project tasks</legend>
        <div className={`rounded-lg border p-4 ${mode === "reassign" ? "border-primary bg-accent" : "border-border"}`}>
          <label className="flex min-h-11 items-start gap-3 text-sm">
            <input type="radio" name={group} checked={mode === "reassign"} disabled={!alternatives.length} onChange={() => onMode("reassign")} className="mt-1 size-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-ring"/>
            <span><span className="block font-medium">Move tasks to another project</span><span className="mt-1 block text-muted-foreground">Keep the tasks before removing this project.</span></span>
          </label>
          {mode === "reassign" && alternatives.length > 0 && <NativeSelect className="mt-3" value={target} onChange={event => onTarget(event.target.value)} aria-label="Destination project">{alternatives.map(value => <option key={value} value={value}>{value}</option>)}</NativeSelect>}
          {!alternatives.length && <p className="mt-2 text-sm text-muted-foreground">Create another project to move these tasks.</p>}
        </div>
        <label className={`flex min-h-11 items-start gap-3 rounded-lg border p-4 text-sm ${mode === "delete" ? "border-destructive bg-destructive/5" : "border-border"}`}>
          <input type="radio" name={group} checked={mode === "delete"} onChange={() => onMode("delete")} className="mt-1 size-4 shrink-0 accent-destructive focus-visible:outline-2 focus-visible:outline-ring"/>
          <span><span className="block font-medium text-destructive">Delete the tasks too</span><span className="mt-1 block text-muted-foreground">Remove the project and all {count} {count === 1 ? "task" : "tasks"} in it.</span></span>
        </label>
      </fieldset>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button autoFocus type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="destructive" disabled={busy || (count > 0 && mode === "reassign" && !target)}>{busy ? "Deleting…" : mode === "delete" && count > 0 ? "Delete project & tasks" : "Delete project"}</Button>
      </div>
    </form>
  </ControlledDialog>;
}
