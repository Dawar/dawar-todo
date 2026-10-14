"use client";

import { Check, CloudOff, CircleAlert, LoaderCircle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type TaskSaveState = "saved" | "saving" | "offline" | "error";

/** Presentation only: the task controller retains draft and retry ownership. */
export function TaskSaveStatus({ state, message, onRetry }: {
  state: TaskSaveState;
  message: string;
  onRetry: () => void;
}) {
  const Icon = state === "saving" ? LoaderCircle : state === "error" ? CircleAlert : state === "offline" ? CloudOff : Check;
  return <div className={cn("flex min-h-14 items-center justify-between gap-3 border-t border-border bg-background px-5 py-3 sm:px-6", state === "error" && "flex-col items-stretch sm:flex-row sm:items-center")}>
    <p role="status" className={cn("flex min-w-0 items-start gap-2 text-sm", state === "error" ? "text-destructive" : "text-muted-foreground")}>
      <Icon aria-hidden="true" className={cn("mt-0.5 h-4 w-4 shrink-0", state === "saving" && "motion-safe:animate-spin")} />
      <span className="break-words [overflow-wrap:anywhere]">{message}</span>
    </p>
    {state === "error" && <Button type="button" variant="outline" className="shrink-0 self-end sm:self-auto" onClick={onRetry}><RotateCcw aria-hidden="true" />Retry</Button>}
  </div>;
}
