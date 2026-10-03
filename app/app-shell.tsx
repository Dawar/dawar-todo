"use client";
import { Activity, Component, Suspense, createContext, lazy, useContext, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from "react";
import { usePathname } from "next/navigation";
import SettingsError from "./settings/error";
import { taskSync } from "./task-sync";
import { cacheOpeningTab, cachedOpeningTab } from "./opening-preference";
import { initialShellPath } from "./launch-intent";

const loaders = { "/tasks": () => import("./tasks/page"), "/open": () => import("./open/page"), "/bots": () => import("./bots/page"), "/settings": () => import("./settings/page") };
type ScreenPath = keyof typeof loaders;
const pages = { "/tasks": lazy(loaders["/tasks"]), "/open": lazy(loaders["/open"]), "/bots": lazy(loaders["/bots"]), "/settings": lazy(loaders["/settings"]) };
const Navigation = createContext<((href: string) => boolean) | null>(null);
function screenPath(path: string | null): ScreenPath | null {
  if (path === "/") return "/tasks";
  return path && Object.hasOwn(pages, path) ? path as ScreenPath : null;
}
function markScreen(path: string) {
  const screen = screenPath(path);
  if (screen && screen !== "/open") window.history.replaceState({ ...window.history.state, dawarScreen: screen }, "");
}

export function useShellNavigation() {
  const navigate = useContext(Navigation);
  return (event: MouseEvent<HTMLAnchorElement>, href: string) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (navigate?.(href)) event.preventDefault();
  };
}
function Screen({ children, screen, positions }: { children: ReactNode; screen: ScreenPath; positions: RefObject<Map<string, { x: number; y: number }>> }) {
  useLayoutEffect(() => {
    const position = positions.current.get(screen);
    window.scrollTo({ left: position?.x ?? 0, top: position?.y ?? 0, behavior: "instant" });
  }, [screen, positions]);
  return children;
}

class ScreenBoundary extends Component<{ path: ScreenPath; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    const reset = () => this.setState({ error: null });
    if (this.props.path === "/settings") return <SettingsError error={this.state.error} reset={reset} />;
    return <div className="mx-auto max-w-lg p-6"><p>This screen could not open.</p><button type="button" className="mt-3 underline" onClick={reset}>Try again</button></div>;
  }
}

export function AppShell({ children }: { children: ReactNode }) {
  const initialPath = usePathname();
  const initialEntry = useRef(true);
  const lastFrameworkPath = useRef(initialPath);
  // A cached root document cannot know the browser's query/hash/history intent.
  // Hold its page until the one-time client decision, avoiding a Tasks flash.
  const [path, setPath] = useState<string | null>(initialPath === "/" ? null : initialPath);
  const route = screenPath(path);
  const [visited, setVisited] = useState<ScreenPath[]>(route ? [route] : []);
  const scroll = useRef(new Map<string, { x: number; y: number }>());
  const current = useRef(path);
  const visit = (next: string) => {
    if (current.current) scroll.current.set(screenPath(current.current) ?? current.current, { x: window.scrollX, y: window.scrollY });
    current.current = next;
    setPath(next);
    const screen = screenPath(next);
    if (screen) setVisited((previous) => previous.includes(screen) ? previous : [...previous, screen]);
  };
  useEffect(() => {
    if (!initialEntry.current && initialPath === lastFrameworkPath.current) return;
    // Read the real URL on initial hydration, including when a cached document
    // was served for an alias. Later framework navigation is always explicit.
    const next = initialEntry.current ? initialShellPath() : initialPath;
    initialEntry.current = false;
    lastFrameworkPath.current = initialPath;
    if (next !== current.current) visit(next);
    markScreen(next);
  }, [initialPath]);
  const appReady = path !== null && path !== "/open";
  useEffect(() => {
    // `/open` immediately replaces itself. The destination starts sync once;
    // deciding where to launch needs only the cached settings metadata.
    if (!appReady) return;
    taskSync.start();
    // Bootstrap/deltas keep the launch preference current even if Settings was
    // never opened here. Hydration of an older IDB snapshot only fills a gap.
    const hydratePreference = () => {
      const settings = taskSync.getSnapshot().settings;
      if (!cachedOpeningTab()) cacheOpeningTab(settings?.openAppTo, settings?.openAppToUpdatedAt);
    };
    hydratePreference();
    const unsubscribeSettings = taskSync.subscribe(hydratePreference);
    const unsubscribeRemote = taskSync.onEvent((event) => {
      if (event.type === "remote") cacheOpeningTab(event.result.settings?.openAppTo, event.result.settings?.openAppToUpdatedAt);
    });
    const pop = () => { visit(window.location.pathname); markScreen(window.location.pathname); };
    // Keep back/forward in the cached shell, including while offline. The route
    // framework still owns navigation to pages outside this shell.
    const onPopState = (event: PopStateEvent) => {
      if (!screenPath(current.current) || !screenPath(window.location.pathname)) return;
      event.stopImmediatePropagation(); pop(); window.dispatchEvent(new Event("dawar-shell-popstate"));
    };
    window.addEventListener("popstate", onPopState, true);
    const previousRestoration = history.scrollRestoration;
    history.scrollRestoration = "manual";
    const preload = window.setTimeout(() => { for (const load of Object.values(loaders)) void load().catch(() => undefined); }, 1_500);
    return () => { unsubscribeSettings(); unsubscribeRemote(); window.removeEventListener("popstate", onPopState, true); history.scrollRestoration = previousRestoration; window.clearTimeout(preload); };
  }, [appReady]);
  const navigate = (href: string) => {
    const url = new URL(href, window.location.href);
    if (url.origin !== window.location.origin || !screenPath(url.pathname) || url.search || url.hash) return false;
    if (current.current === url.pathname) return true;
    (document.activeElement as HTMLElement | null)?.blur?.();
    window.dispatchEvent(new Event("dawar-before-navigation"));
    visit(url.pathname);
    window.history.pushState({ ...window.history.state, dawarScreen: screenPath(url.pathname) }, "", url.pathname);
    return true;
  };
  return <Navigation.Provider value={navigate}>
    {route ? visited.map((item) => {
      const Page = pages[item];
      return <Activity key={item} mode={route === item ? "visible" : "hidden"}>
        <ScreenBoundary path={item}><Suspense fallback={<div className="mx-auto max-w-5xl p-6 text-sm text-[#69716c]" role="status">Opening…</div>}>
          <Screen screen={item} positions={scroll}><Page /></Screen>
        </Suspense></ScreenBoundary>
      </Activity>;
    }) : path === null ? <div className="mx-auto max-w-5xl p-6 text-sm text-[#69716c]" role="status">Opening…</div> : children}
  </Navigation.Provider>;
}
