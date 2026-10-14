"use client";
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

const protectedSurface = 'dialog[open],[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]';
export function botKeyboardAvailable(screen: HTMLElement) {
  const document = screen.ownerDocument;
  return screen.isConnected && screen.getClientRects().length > 0 && document.visibilityState !== 'hidden' &&
    ![...document.querySelectorAll<HTMLElement>(protectedSurface)].some(element => element.getClientRects().length > 0);
}

/** Only navigation/focus. Bubble-phase handling leaves protected consumers first. */
export function installBotSearchShortcut(target: Window, screen: HTMLElement, search: () => HTMLInputElement | null, reveal: () => void) {
  let frame = 0;
  const down = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || event.altKey || event.shiftKey ||
        event.metaKey === event.ctrlKey || event.key.toLowerCase() !== 'k' || !botKeyboardAvailable(screen)) return;
    if (event.target instanceof Element && !screen.contains(event.target) &&
        event.target !== screen.ownerDocument.body && event.target !== screen.ownerDocument.documentElement) return;
    event.preventDefault();
    reveal();
    target.cancelAnimationFrame(frame);
    frame = target.requestAnimationFrame(() => {
      const input = search();
      if (!botKeyboardAvailable(screen) || !input?.isConnected || !screen.contains(input) || !input.getClientRects().length) return;
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
  const focusScope = useRef(scope), navigation = useRef<string | null>(null);
  const keepOpenForNavigation = useCallback((nextScope: string) => {
    navigation.current = nextScope;
    setState({ scope: nextScope, open: true });
  }, []);
  const closeSearch = useCallback((restore = false) => {
    setState(value => ({ ...value, open: false })); revealed.current = false;
    window.cancelAnimationFrame(restoreFrame.current);
    const opener = previous.current; previous.current = null;
    const navigationScope = navigation.current; navigation.current = null;
    if (restore && (opener || navigationScope)) restoreFrame.current = window.requestAnimationFrame(() => {
      const root = focusRoot.current;
      if (!root || !botKeyboardAvailable(root)) return;
      const target = navigationScope ? focusScope.current === navigationScope ? root.querySelector<HTMLElement>('.bots-messages') : null : opener;
      if (target?.isConnected && root.contains(target) && target.getClientRects().length) target.focus({ preventScroll: true });
    });
  }, []);
  useEffect(() => {
    const root = screen.current;
    if (!root) return;
    focusRoot.current = root;
    focusScope.current = scope;
    const cleanup = installBotSearchShortcut(window, root, () => search.current, () => {
      window.cancelAnimationFrame(restoreFrame.current);
      navigation.current = null;
      if (!revealed.current) previous.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      revealed.current = true; setState({ scope, open: true });
    });
    return () => { cleanup(); window.cancelAnimationFrame(restoreFrame.current); previous.current = null; revealed.current = false; focusRoot.current = null; if (navigation.current === scope) navigation.current = null; };
  }, [screen, search, scope]);
  return { searchOpen: state.scope === scope && state.open, closeSearch, keepOpenForNavigation };
}
