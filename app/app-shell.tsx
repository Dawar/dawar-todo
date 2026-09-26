"use client";
import { Activity, Component, Suspense, createContext, lazy, useContext, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import SettingsError from "./settings/error";
import { taskSync } from "./task-sync";

const loaders = { "/": () => import("./page"), "/talk": () => import("./talk/page"), "/bots": () => import("./bots/page"), "/settings": () => import("./settings/page") };
type ScreenPath = keyof typeof loaders;
const pages = { "/": lazy(loaders["/"]), "/talk": lazy(loaders["/talk"]), "/bots": lazy(loaders["/bots"]), "/settings": lazy(loaders["/settings"]) };
const Navigation = createContext<((href: string) => boolean) | null>(null);
function screenPath(path: string): ScreenPath | null { return Object.hasOwn(pages, path) ? path as ScreenPath : null; }

export function useShellNavigation() {
  const navigate = useContext(Navigation);
  return (event: MouseEvent<HTMLAnchorElement>, href: string) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (navigate?.(href)) event.preventDefault();
  };
}
function Screen({ children, restore }: { children: ReactNode; restore: () => void }) {
  useLayoutEffect(restore, [restore]);
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
  const [path, setPath] = useState(initialPath);
  const route = screenPath(path);
  const [visited, setVisited] = useState<ScreenPath[]>(route ? [route] : []);
  const scroll = useRef(new Map<string, { x: number; y: number }>());
  const current = useRef(path);
  const restorers = useRef(new Map<string, () => void>());
  const visit = (next: string) => {
    scroll.current.set(current.current, { x: window.scrollX, y: window.scrollY });
    current.current = next;
    setPath(next);
    const screen = screenPath(next);
    if (screen) setVisited((previous) => previous.includes(screen) ? previous : [...previous, screen]);
  };
  useEffect(() => {
    if (initialPath !== current.current) visit(initialPath);
  }, [initialPath]);
  useEffect(() => {
    taskSync.start();
    const pop = () => visit(window.location.pathname);
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
    return () => { window.removeEventListener("popstate", onPopState, true); history.scrollRestoration = previousRestoration; window.clearTimeout(preload); };
  }, []);
  const navigate = (href: string) => {
    const url = new URL(href, window.location.href);
    if (url.origin !== window.location.origin || !screenPath(url.pathname) || url.search || url.hash) return false;
    if (current.current === url.pathname) return true;
    (document.activeElement as HTMLElement | null)?.blur?.();
    window.dispatchEvent(new Event("dawar-before-navigation"));
    visit(url.pathname);
    window.history.pushState({ ...window.history.state, dawarScreen: url.pathname }, "", url.pathname);
    return true;
  };
  return <Navigation.Provider value={navigate}>
    {route ? visited.map((item) => {
      const Page = pages[item];
      if (!restorers.current.has(item)) restorers.current.set(item, () => { const position = scroll.current.get(item); window.scrollTo({ left: position?.x ?? 0, top: position?.y ?? 0, behavior: "instant" }); });
      return <Activity key={item} mode={route === item ? "visible" : "hidden"}>
        <ScreenBoundary path={item}><Suspense fallback={<div className="mx-auto max-w-5xl p-6 text-sm text-[#69716c]" role="status">Opening…</div>}>
          <Screen restore={restorers.current.get(item)!}><Page /></Screen>
        </Suspense></ScreenBoundary>
      </Activity>;
    }) : children}
  </Navigation.Provider>;
}
