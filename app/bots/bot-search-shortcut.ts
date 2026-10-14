"use client";
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

const protectedSurface = 'dialog[open],[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]';
function available(screen: HTMLElement) {
  const document = screen.ownerDocument;
  return screen.isConnected && screen.getClientRects().length > 0 && document.visibilityState !== 'hidden' &&
    ![...document.querySelectorAll<HTMLElement>(protectedSurface)].some(element => element.getClientRects().length > 0);
}

/** Only navigation/focus. Bubble-phase handling leaves protected consumers first. */
export function installBotSearchShortcut(target: Window, screen: HTMLElement, search: () => HTMLInputElement | null, reveal: () => void) {
  let frame = 0;
  const down = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || event.altKey || event.shiftKey ||
        event.metaKey === event.ctrlKey || event.key.toLowerCase() !== 'k' || !available(screen)) return;
    if (event.target instanceof Element && !screen.contains(event.target) &&
        event.target !== screen.ownerDocument.body && event.target !== screen.ownerDocument.documentElement) return;
    event.preventDefault();
    reveal();
    target.cancelAnimationFrame(frame);
    frame = target.requestAnimationFrame(() => {
      const input = search();
      if (!available(screen) || !input?.isConnected || !screen.contains(input) || !input.getClientRects().length) return;
      input.focus({ preventScroll: true });
      input.select();
    });
  };
  target.addEventListener('keydown', down);
  return () => { target.removeEventListener('keydown', down); target.cancelAnimationFrame(frame); };
}

export function useBotSearchShortcut(screen: RefObject<HTMLDivElement | null>, search: RefObject<HTMLInputElement | null>, scope: string) {
  const [state, setState] = useState({ scope, open: false });
  if (state.scope !== scope) setState({ scope, open: false });
  const previous = useRef<HTMLElement | null>(null), revealed = useRef(false), restoreFrame = useRef(0);
  const focusRoot = useRef<HTMLDivElement | null>(null);
  const closeSearch = useCallback((restore = false) => {
    setState(value => ({ ...value, open: false })); revealed.current = false;
    window.cancelAnimationFrame(restoreFrame.current);
    const opener = previous.current; previous.current = null;
    if (restore && opener) restoreFrame.current = window.requestAnimationFrame(() => {
      const root = focusRoot.current;
      if (opener.isConnected && root?.contains(opener) && available(root)) opener.focus({ preventScroll: true });
    });
  }, []);
  useEffect(() => {
    const root = screen.current;
    if (!root) return;
    focusRoot.current = root;
    const cleanup = installBotSearchShortcut(window, root, () => search.current, () => {
      window.cancelAnimationFrame(restoreFrame.current);
      if (!revealed.current) previous.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      revealed.current = true; setState({ scope, open: true });
    });
    return () => { cleanup(); window.cancelAnimationFrame(restoreFrame.current); previous.current = null; revealed.current = false; focusRoot.current = null; };
  }, [screen, search, scope]);
  return { searchOpen: state.scope === scope && state.open, closeSearch };
}
