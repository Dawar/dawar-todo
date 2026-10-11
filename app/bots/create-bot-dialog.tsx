"use client";
import type { FormEventHandler } from "react";
import { ControlledDialog } from "@/components/ui/controlled-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export function CreateBotDialog({ online, busy, error, onClose, onSubmit }: {
  online: boolean; busy: boolean; error: string; onClose: () => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
}) {
  return <ControlledDialog title="Create a bot" onClose={onClose}>
    <form className="grid gap-4" aria-busy={busy} onSubmit={onSubmit}>
      <label className="grid gap-2 text-sm font-medium">Name
        <Input name="name" autoFocus placeholder="e.g. Atlas" required maxLength={80} />
      </label>
      <label className="grid gap-2 text-sm font-medium"><span>Purpose <span className="font-normal text-muted-foreground">(optional)</span></span>
        <Textarea name="purpose" placeholder="What would you like this bot to help with?" rows={3} maxLength={2000} />
      </label>
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      {!online && <p className="text-sm text-muted-foreground" role="status">Reconnect to create a bot.</p>}
      <div className="flex flex-wrap justify-end gap-2 pt-2">
        <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
        <Button type="submit" disabled={!online || busy}>{busy ? "Creating…" : "Create bot"}</Button>
      </div>
    </form>
  </ControlledDialog>;
}
