"use client";

import { useEffect } from "react";
import { ScreenError } from "../screen-feedback";

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
  }, [error]);

  return <ScreenError title="Settings could not open" onRetry={reset} />;
}
