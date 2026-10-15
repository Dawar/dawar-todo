"use client";

import { useEffect } from "react";
import { ScreenError } from "../screen-feedback";
import { reportClientFailure } from "../build-reload";

export default function SettingsError({ error, reset }: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[todo-ui] settings route crashed", {
      message: error.message,
      digest: error.digest ?? null,
      onlineHint: navigator.onLine,
    });
    reportClientFailure(error);
  }, [error]);

  return <ScreenError title="Settings could not open" onRetry={reset} />;
}
