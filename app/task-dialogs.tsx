"use client";

import { useId, type FormEvent } from "react";
import { ControlledDialog } from "@/components/ui/controlled-dialog";
import { Button } from "@/components/ui/button";
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
