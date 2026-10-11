"use client";

import Link from "next/link";
import { Button, buttonVariants } from "../components/ui/button";
import { cn } from "../lib/utils";
import { useState } from "react";
import { useShellNavigation } from "./app-shell";
import { ActionIcon } from "./action-icon";
import { KeyboardShortcutsDialog } from "./keyboard-shortcuts-dialog";

export function SiteHeader({
  current,
  projectLabel = "Dawar Todo",
  onProjectClick,
  onKeyboardHelp,
}: {
  current: "todos" | "settings" | "assistant" | "bots";
  projectLabel?: string;
  onProjectClick?: () => void;
  onKeyboardHelp?: () => void;
}) {
  const navigate = useShellNavigation();
  const [shortcutGuideOpen, setShortcutGuideOpen] = useState(false);
  const brand = (
    <>
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-primary text-base font-semibold text-primary-foreground" aria-hidden="true">✓</span>
      <span className="hidden min-w-0 truncate min-[360px]:block text-[15px] font-semibold tracking-[-0.02em]">{projectLabel}</span>
      {onProjectClick && <ActionIcon name="next" className="h-3.5 w-3.5 shrink-0 rotate-90 text-muted-foreground" />}
    </>
  );
  const navigation = [
    { href: "/tasks", label: "Tasks", icon: "view-open" as const, active: current === "todos" },
    { href: "/bots", label: "Bots", icon: "assistant" as const, active: current === "bots" },
    { href: "/settings", label: "Settings", icon: "settings" as const, active: current === "settings" },
  ];

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur-xl">
      <div className={`mx-auto flex h-14 w-full items-center justify-between gap-2 px-3 sm:px-6 ${current === "bots" ? "max-w-none" : "max-w-5xl"}`}>
        {onProjectClick ? (
          <button
            type="button"
            onClick={onProjectClick}
            aria-label={`Choose project. Current selection: ${projectLabel}`}
            title="Choose project"
            className="flex min-h-11 min-w-0 max-w-[38vw] items-center gap-2 rounded-lg text-left transition hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:max-w-md sm:gap-2.5"
          >
            {brand}
          </button>
        ) : (
          <Link
            href="/tasks"
            aria-label={`${projectLabel} · Tasks`}
            title={projectLabel}
            prefetch={false}
            onClick={(event) => navigate(event, "/tasks")}
            className="flex min-h-11 min-w-0 max-w-[38vw] items-center gap-2 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:gap-2.5"
          >
            {brand}
          </Link>
        )}
        <nav className="flex shrink-0 items-center gap-0.5 sm:gap-1" aria-label="Primary">
          <Button
            variant="ghost" size="icon"
            type="button"
            onClick={() => {
              if (onKeyboardHelp) onKeyboardHelp();
              else setShortcutGuideOpen(true);
            }}
            aria-label="Keyboard shortcuts"
            title="Keyboard shortcuts (?)"
            className="mr-0.5 hidden text-muted-foreground md:inline-flex"
          >
            <ActionIcon name="keyboard" className="h-4 w-4" />
          </Button>
          {navigation.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              prefetch={false}
              onClick={(event) => navigate(event, item.href)}
              aria-label={item.label}
              aria-current={item.active ? "page" : undefined}
              title={item.label}
              className={cn(buttonVariants({ variant: item.active ? "secondary" : "ghost" }), "gap-1 px-2 text-[13px] sm:gap-1.5 sm:px-3 sm:text-sm", item.active ? "bg-accent text-accent-foreground" : "text-muted-foreground")}
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
