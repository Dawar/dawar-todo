"use client";

/** Decide once per document, before mounting Tasks. Never run on focus/resume. */
export function initialShellPath(): string {
  const { pathname, search, hash } = window.location;
  if (pathname !== "/" || search || hash) return pathname;
  const marked = window.history.state?.dawarScreen;
  if (marked === "/" || marked === "/tasks" || (document as Document & { wasDiscarded?: boolean }).wasDiscarded) return "/";
  const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  const legacyType = performance.navigation?.type;
  const kind = navigation?.type ?? (legacyType === 0 ? "navigate" : legacyType === 1 ? "reload" : legacyType === 2 ? "back_forward" : undefined);
  // A reload, history traversal or unknown restoration keeps its screen. An
  // existing home-screen shortcut and a fresh website root both use navigate.
  return kind === "navigate" ? "/open" : "/";
}
