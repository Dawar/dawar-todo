import { useLayoutEffect, type RefObject } from "react";
type Position = { key: string | null; offset: number; top: number };
const positions = new Map<string, Position>();
/** Reading a run never follows new output. Explicitly changing part restores its own anchor. */
export function useRunScroll(body: RefObject<HTMLDivElement | null>, identity: string, revision?: string) {
  useLayoutEffect(() => {
    const element = body.current; if (!element) return;
    let frame = 0, restoring = false;
    const capture = () => {
      if (restoring) return;
      const top = element.getBoundingClientRect().top;
      const anchor = [...element.querySelectorAll<HTMLElement>("[data-history-key]")].find(value => value.getBoundingClientRect().bottom > top + 1);
      positions.delete(identity); positions.set(identity, { key: anchor?.dataset.historyKey ?? null, offset: anchor ? anchor.getBoundingClientRect().top - top : 0, top: element.scrollTop });
      for (const key of [...positions.keys()].slice(0, Math.max(0, positions.size - 32))) positions.delete(key);
    };
    const restore = () => {
      const saved = positions.get(identity); if (!saved) { positions.set(identity, { key: null, offset: 0, top: 0 }); element.scrollTop = 0; return; }
      restoring = true;
      const anchor = [...element.querySelectorAll<HTMLElement>("[data-history-key]")].find(value => value.dataset.historyKey === saved.key);
      element.scrollTop = anchor ? element.scrollTop + anchor.getBoundingClientRect().top - element.getBoundingClientRect().top - saved.offset : saved.top;
      cancelAnimationFrame(frame); frame = requestAnimationFrame(() => { restoring = false; });
    };
    const observer = new ResizeObserver(restore);
    const observe = () => { observer.disconnect(); observer.observe(element); for (const child of element.children) observer.observe(child); restore(); };
    const mutation = new MutationObserver(observe); mutation.observe(element, { childList: true, subtree: true });
    element.addEventListener("scroll", capture, { passive: true }); observe();
    return () => { element.removeEventListener("scroll", capture); observer.disconnect(); mutation.disconnect(); cancelAnimationFrame(frame); };
  }, [body, identity, revision]);
}
