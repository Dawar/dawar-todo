"use client";
import { useId, type FormEventHandler } from "react";
import { ControlledDialog } from "@/components/ui/controlled-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

const PROVIDERS = [
  { value: "codex", label: "Codex", detail: "OpenAI models through your ChatGPT sign-in" },
  { value: "claude", label: "Claude", detail: "Anthropic models through the Claude Agent SDK" },
] as const;

export function CreateBotDialog({ online, busy, error, claudeAvailable = false, onClose, onSubmit }: {
  online: boolean; busy: boolean; error: string; claudeAvailable?: boolean; onClose: () => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
}) {
  const errorId = useId();
  return <ControlledDialog title="Create a bot" onClose={onClose} closeDisabled={busy} className="max-w-md">
    <form className="grid gap-4" aria-busy={busy} aria-describedby={error ? errorId : undefined} onSubmit={event => {
      if (!online || busy) { event.preventDefault(); return; }
      onSubmit(event);
    }}>
      <label className="grid gap-2 text-sm font-medium">Name
        <Input name="name" autoFocus disabled={busy} placeholder="e.g. Atlas" required maxLength={80} />
      </label>
      <label className="grid gap-2 text-sm font-medium"><span>Purpose <span className="font-normal text-muted-foreground">(optional)</span></span>
        <Textarea name="purpose" disabled={busy} placeholder="What would you like this bot to help with?" rows={3} maxLength={2000} />
      </label>
      {claudeAvailable && <fieldset className="grid gap-2" disabled={busy}>
        <legend className="mb-2 text-sm font-medium">Runs on</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {PROVIDERS.map(provider => <label key={provider.value}
            className="flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm has-[:checked]:border-primary has-[:checked]:bg-accent has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring">
            <input type="radio" name="provider" value={provider.value} defaultChecked={provider.value === "codex"} className="mt-0.5 accent-primary" />
            <span className="grid gap-0.5"><span className="font-medium">{provider.label}</span><span className="text-muted-foreground">{provider.detail}</span></span>
          </label>)}
        </div>
        <p className="text-xs text-muted-foreground">This can&apos;t be changed later; the conversation lives with its provider.</p>
      </fieldset>}
      {error && <p id={errorId} className="text-sm text-destructive break-words" role="alert">{error}</p>}
      {!online && <p className="text-sm text-muted-foreground" role="status">Reconnect to create a bot.</p>}
      <div className="flex flex-wrap justify-end gap-2 pt-2">
        <Button type="button" variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
        <Button type="submit" disabled={!online || busy}>{busy ? "Creating…" : "Create bot"}</Button>
      </div>
    </form>
  </ControlledDialog>;
}
