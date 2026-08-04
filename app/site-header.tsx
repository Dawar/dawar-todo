"use client";

import Link from "next/link";
import { type MouseEvent, useState } from "react";
import { ActionIcon } from "./action-icon";
import { KeyboardShortcutsDialog } from "./keyboard-shortcuts-dialog";

type StandaloneNavigator = Navigator & { standalone?: boolean };

function handleStandaloneDocumentNavigation(event: MouseEvent<HTMLAnchorElement>, href: string) {
  if (
    event.defaultPrevented
    || event.button !== 0
    || event.metaKey
    || event.ctrlKey
    || event.shiftKey
    || event.altKey
  ) return;
  const standalone = window.matchMedia("(display-mode: standalone)").matches
    || Boolean((navigator as StandaloneNavigator).standalone);
  if (!standalone) return;
  event.preventDefault();
  console.info("[todo-pwa] standalone document navigation requested", {
    from: window.location.pathname,
    to: href,
    displayModeStandalone: window.matchMedia("(display-mode: standalone)").matches,
    navigatorStandalone: Boolean((navigator as StandaloneNavigator).standalone),
  });
  window.location.assign(href);
}

export function SiteHeader({
  current,
  projectLabel = "Dawar Todo",
  onProjectClick,
  onKeyboardHelp,
}: {
  current: "todos" | "settings" | "assistant" | "talk";
  projectLabel?: string;
  onProjectClick?: () => void;
  onKeyboardHelp?: () => void;
}) {
  const [shortcutGuideOpen, setShortcutGuideOpen] = useState(false);
  const brand = (
    <>
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-[#216e4e] text-base font-semibold text-white shadow-sm" aria-hidden="true">✓</span>
      <span className="min-w-0 truncate text-[15px] font-semibold tracking-[-0.02em]">{projectLabel}</span>
      {onProjectClick && <ActionIcon name="next" className="h-3.5 w-3.5 shrink-0 rotate-90 text-[#7c847f]" />}
    </>
  );
  const navigation = [
    { href: "/", label: "Tasks", icon: "view-open" as const, active: current === "todos" },
    { href: "/talk", label: "Chat", icon: "assistant" as const, active: current === "talk" || current === "assistant" },
    { href: "/settings", label: "Settings", icon: "settings" as const, active: current === "settings" },
  ];

  return (
    <header className="sticky top-0 z-30 border-b border-black/[0.06] bg-[#f6f7f5]/92 backdrop-blur-xl">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-2 px-3 sm:px-6">
        {onProjectClick ? (
          <button
            type="button"
            onClick={onProjectClick}
            aria-label={`Choose project. Current selection: ${projectLabel}`}
            title="Choose project"
            className="flex min-w-0 max-w-[38vw] items-center gap-2 rounded-lg text-left transition hover:text-[#216e4e] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#216e4e] sm:max-w-md sm:gap-2.5"
          >
            {brand}
          </button>
        ) : (
          <Link
            href="/"
            prefetch={false}
            onClick={(event) => handleStandaloneDocumentNavigation(event, "/")}
            className="flex min-w-0 max-w-[38vw] items-center gap-2 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#216e4e] sm:gap-2.5"
          >
            {brand}
          </Link>
        )}
        <nav className="flex shrink-0 items-center gap-0.5 sm:gap-1" aria-label="Primary">
          <button
            type="button"
            onClick={() => {
              if (onKeyboardHelp) onKeyboardHelp();
              else setShortcutGuideOpen(true);
            }}
            aria-label="Keyboard shortcuts"
            title="Keyboard shortcuts (?)"
            className="mr-0.5 hidden h-9 w-9 place-items-center rounded-xl text-[#69716c] transition hover:bg-black/[0.04] hover:text-[#252a27] focus-visible:outline-2 focus-visible:outline-[#216e4e] md:grid"
          >
            <ActionIcon name="keyboard" className="h-4.5 w-4.5" />
          </button>
          {navigation.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              prefetch={false}
              onClick={(event) => handleStandaloneDocumentNavigation(event, item.href)}
              aria-label={item.label}
              aria-current={item.active ? "page" : undefined}
              title={item.label}
              className={`inline-flex h-9 items-center gap-1 rounded-xl px-1.5 text-xs font-semibold transition focus-visible:outline-2 focus-visible:outline-[#216e4e] sm:gap-1.5 sm:px-2.5 sm:text-sm ${
                item.active
                  ? "bg-[#eaf3ed] text-[#216e4e]"
                  : "text-[#69716c] hover:bg-[#eaf3ed] hover:text-[#216e4e]"
              }`}
            >
              <ActionIcon name={item.icon} className="h-4 w-4 shrink-0" />
              <span>{item.label}</span>
            </Link>
          ))}
        </nav>
      </div>
      {shortcutGuideOpen && <KeyboardShortcutsDialog onClose={() => setShortcutGuideOpen(false)} />}
    </header>
  );
}
