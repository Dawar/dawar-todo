"use client";

import Link from "next/link";
import { ActionIcon } from "./action-icon";

export function SiteHeader({
  current,
  projectLabel = "Dawar Todo",
  onProjectClick,
  onKeyboardHelp,
}: {
  current: "todos" | "settings";
  projectLabel?: string;
  onProjectClick?: () => void;
  onKeyboardHelp?: () => void;
}) {
  const brand = (
    <>
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-[#216e4e] text-base font-semibold text-white shadow-sm" aria-hidden="true">✓</span>
      <span className="min-w-0 truncate text-[15px] font-semibold tracking-[-0.02em]">{projectLabel}</span>
      {onProjectClick && <ActionIcon name="next" className="h-3.5 w-3.5 shrink-0 rotate-90 text-[#7c847f]" />}
    </>
  );

  return (
    <header className="sticky top-0 z-30 border-b border-black/[0.06] bg-[#f6f7f5]/92 backdrop-blur-xl">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4 sm:px-6">
        {onProjectClick ? (
          <button
            type="button"
            onClick={onProjectClick}
            aria-label={`Choose project. Current selection: ${projectLabel}`}
            title="Choose project"
            className="flex min-w-0 max-w-[70vw] items-center gap-2.5 rounded-lg text-left transition hover:text-[#216e4e] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#216e4e] sm:max-w-md"
          >
            {brand}
          </button>
        ) : (
          <Link href="/" className="flex min-w-0 items-center gap-2.5 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#216e4e]">
            {brand}
          </Link>
        )}
        <div className="flex items-center gap-2">
          {current === "todos" ? (
            <>
              {onKeyboardHelp && (
                <button
                  type="button"
                  onClick={onKeyboardHelp}
                  aria-label="Keyboard shortcuts"
                  title="Keyboard shortcuts (?)"
                  className="hidden h-10 w-10 place-items-center rounded-xl text-[#69716c] transition hover:bg-black/[0.04] hover:text-[#252a27] focus-visible:outline-2 focus-visible:outline-[#216e4e] md:grid"
                >
                  <ActionIcon name="keyboard" className="h-5 w-5" />
                </button>
              )}
              <Link
                href="/settings"
                aria-label="Settings"
                title="Settings"
                className="grid h-10 w-10 place-items-center rounded-xl text-[#69716c] transition hover:bg-black/[0.04] hover:text-[#252a27] focus-visible:outline-2 focus-visible:outline-[#216e4e]"
              >
                <ActionIcon name="settings" className="h-5 w-5" />
              </Link>
            </>
          ) : (
            <Link href="/" className="rounded-lg px-3 py-2 text-sm font-medium text-[#216e4e] transition hover:bg-[#eaf3ed] focus-visible:outline-2 focus-visible:outline-[#216e4e]">
              Back to tasks
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
