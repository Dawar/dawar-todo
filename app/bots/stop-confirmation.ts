import { useCallback, useState } from "react";

/**
 * A new Stop waits for explicit confirmation; Cancel, Escape and backdrop
 * dismissal send nothing. Checking an already-saved Stop never asks and only
 * re-checks its original action ID. One confirmation submits exactly once.
 */
export class StopConfirmation {
  open = false;
  constructor(private readonly changed: () => void = () => {}) {}
  request({ saved, recover }: { saved: boolean; recover: () => void }) {
    if (saved) { recover(); return; }
    if (!this.open) { this.open = true; this.changed(); }
  }
  cancel() { if (this.open) { this.open = false; this.changed(); } }
  confirm(submit: () => void) {
    if (!this.open) return false;
    this.open = false; this.changed();
    submit();
    return true;
  }
}

export function useStopConfirmation() {
  const [, redraw] = useState(0);
  const [gate] = useState(() => new StopConfirmation(() => redraw(value => value + 1)));
  return { open: gate.open, request: useCallback((value: Parameters<StopConfirmation["request"]>[0]) => gate.request(value), [gate]),
    cancel: useCallback(() => gate.cancel(), [gate]), confirm: useCallback((submit: () => void) => gate.confirm(submit), [gate]) };
}
