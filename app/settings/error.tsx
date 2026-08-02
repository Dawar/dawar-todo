"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { copyTextToClipboard } from "../copy-to-clipboard";
import { buildSyncDiagnosticsReport } from "../sync-diagnostics";

export default function SettingsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [copying, setCopying] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    console.error("[todo-diagnostics] settings route crashed", {
      message: error.message,
      digest: error.digest ?? null,
      onlineHint: navigator.onLine,
    });
  }, [error]);

  async function copyCrashDiagnostics() {
    if (copying) return;
    setCopying(true);
    setMessage("");
    try {
      const report = await buildSyncDiagnosticsReport("settings-error", {
        settingsError: error.message.slice(0, 300),
        settingsErrorDigest: error.digest ?? null,
      });
      await copyTextToClipboard(report);
      setMessage("Crash and sync diagnostics copied. Paste them into our chat.");
      console.info("[todo-diagnostics] settings crash diagnostics copied", {
        reportLength: report.length,
        onlineHint: navigator.onLine,
      });
    } catch (copyError) {
      setMessage(copyError instanceof Error ? copyError.message : "Diagnostics could not be copied.");
      console.error("[todo-diagnostics] settings crash diagnostics copy failed", {
        error: copyError,
      });
    } finally {
      setCopying(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-[#f6f7f5] px-4 py-10 text-[#1d211f]">
      <section className="w-full max-w-lg rounded-2xl border border-black/[0.07] bg-white p-6 shadow-[0_10px_35px_rgba(30,45,36,0.06)] sm:p-8">
        <p className="text-sm font-semibold text-red-700">Settings could not open</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-[#151816]">The rest of your tasks are safe.</h1>
        <p className="mt-3 text-sm leading-6 text-[#69716c]">Copy the diagnostic report before retrying. It omits task text, credentials, tokens, and private identifiers.</p>
        <div className="mt-6 flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            onClick={() => void copyCrashDiagnostics()}
            disabled={copying}
            className="inline-flex h-11 items-center justify-center rounded-xl bg-[#216e4e] px-4 text-sm font-semibold text-white transition hover:bg-[#195d41] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#216e4e] disabled:opacity-50"
          >
            {copying ? "Collecting…" : "Copy diagnostics"}
          </button>
          <button
            type="button"
            onClick={reset}
            className="inline-flex h-11 items-center justify-center rounded-xl bg-white px-4 text-sm font-semibold text-[#4f5c55] ring-1 ring-black/[0.1] transition hover:bg-[#f4f6f4] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#216e4e]"
          >
            Try Settings again
          </button>
          <Link
            href="/"
            className="inline-flex h-11 items-center justify-center rounded-xl bg-white px-4 text-sm font-semibold text-[#4f5c55] ring-1 ring-black/[0.1] transition hover:bg-[#f4f6f4] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#216e4e]"
          >
            Back to tasks
          </Link>
        </div>
        {message && <p role="status" className="mt-4 text-sm leading-6 text-[#4f6257]">{message}</p>}
      </section>
    </main>
  );
}
