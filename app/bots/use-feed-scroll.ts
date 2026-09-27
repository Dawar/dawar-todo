"use client";
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { historyKey } from '../../lib/bot-history-view';
import { historyWindow, windowEndAround } from './history-window';
import type { BotTimeline, TimelineState } from './timeline-controller';

/** Only user input changes reading intent. Geometry and data changes restore it. */
export function useFeedScroll(timeline: BotTimeline, state: TimelineState, online: boolean) {
  const scroll = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null);
  const saved = useRef(state.position), restored = useRef(false), following = useRef(state.position.following);
  const [endKey, setEndKey] = useState<string | null>(null), [showJump, setShowJump] = useState(false), [paging, setPaging] = useState(false);
  const busy = useRef(false), inputUntil = useRef(0), direction = useRef(0), previousTop = useRef(0), expectedTop = useRef<number | null>(null);
  const visibleAnchors = useRef<{ key: string; offset: number }[]>([]), stateRef = useRef(state);
  const endIndex = endKey ? state.entries.findIndex((entry) => historyKey(entry.turnId, entry.id) === timeline.resolveKey(endKey)) : -1;
  let range = historyWindow(state.entries, endIndex < 0 ? state.entries.length : endIndex + 1, state.gaps);
  const readingIndex = !state.position.following ? state.entries.findIndex((entry) => historyKey(entry.turnId, entry.id) === timeline.resolveKey(state.position.anchor)) : -1;
  // Eviction/page completion can publish before the edge handler adjusts its
  // window. Never render an intermediate window that loses the reading anchor.
  if (readingIndex >= 0 && (readingIndex < range.first || readingIndex >= range.last))
    range = historyWindow(state.entries, windowEndAround(state.entries, readingIndex, state.gaps), state.gaps);
  const rangeRef = useRef(range);
  useLayoutEffect(() => { stateRef.current = state; rangeRef.current = range; });
  const updateJump = useCallback(() => {
    const element = scroll.current; if (!element) return;
    const newer = rangeRef.current.last < stateRef.current.entries.length;
    const distance = element.scrollHeight - element.clientHeight - element.scrollTop;
    setShowJump(newer || distance > 120 || !following.current && distance > 2);
  }, []);
  const capture = useCallback(() => {
    const element = scroll.current; if (!element) return;
    const top = element.getBoundingClientRect().top;
    visibleAnchors.current = [...element.querySelectorAll<HTMLElement>('[data-history-key]')]
      .filter((node) => node.getBoundingClientRect().bottom > top)
      .map((node) => ({ key: node.dataset.historyKey!, offset: node.getBoundingClientRect().top - top })).slice(0, 16);
    const anchor = visibleAnchors.current[0];
    saved.current = { anchor: anchor?.key ?? null, offset: anchor?.offset ?? 0, following: following.current };
    timeline.position(saved.current);
  }, [timeline]);
  const restore = useCallback(() => {
    const element = scroll.current; if (!element) return;
    if (following.current) element.scrollTop = element.scrollHeight;
    else {
      const nodes = [...element.querySelectorAll<HTMLElement>('[data-history-key]')];
      let offset = saved.current.offset;
      let node = nodes.find((node) => node.dataset.historyKey === timeline.resolveKey(saved.current.anchor));
      if (!node) for (const candidate of visibleAnchors.current) {
        node = nodes.find((value) => value.dataset.historyKey === timeline.resolveKey(candidate.key));
        if (node) { offset = candidate.offset; break; }
      }
      if (node) element.scrollTop += node.getBoundingClientRect().top - element.getBoundingClientRect().top - offset;
    }
    expectedTop.current = element.scrollTop; previousTop.current = element.scrollTop;
    // Keep the alias/removed-tool fallback as the next durable reading anchor.
    capture(); updateJump();
  }, [capture, timeline, updateJump]);
  const page = useCallback(async (toward: number, retry = false) => {
    if (busy.current) return;
    const current = stateRef.current, range = rangeRef.current;
    if (current.error && !retry) return;
    if (toward < 0 && range.first === 0 && !current.olderCursor && !current.gaps.length) return;
    if (toward > 0 && range.last >= current.entries.length) return;
    capture(); following.current = false; saved.current.following = false;
    busy.current = true; setPaging(true);
    try {
      // A gap must be connected before crossing its boundary. One request per
      // user edge approach, never a render-driven pagination cascade.
      const gap = current.gaps.find((gap) => {
        const index = current.entries.findIndex((entry) => historyKey(entry.turnId, entry.id) === gap.before);
        return toward < 0 ? index === range.first : index === range.last;
      });
      if (gap) { if (!online) return; await timeline.fillGap(gap, toward); }
      else if (toward < 0 && range.first === 0) { if (!online) return; await timeline.older(); }
      const entries = timeline.getSnapshot().entries;
      const anchor = entries.findIndex((entry) => historyKey(entry.turnId, entry.id) === timeline.resolveKey(saved.current.anchor));
      if (anchor >= 0) {
        const end = windowEndAround(entries, anchor, timeline.getSnapshot().gaps);
        setEndKey(historyKey(entries[end - 1].turnId, entries[end - 1].id));
      }
      timeline.position(saved.current);
    } finally { busy.current = false; setPaging(false); }
  }, [capture, timeline, online]);
  const intent = useCallback((toward: number) => {
    inputUntil.current = performance.now() + 1000; direction.current = toward;
    if (toward < 0) {
      following.current = false; capture();
      const entries = stateRef.current.entries, last = rangeRef.current.last;
      if (last) setEndKey(historyKey(entries[last - 1].turnId, entries[last - 1].id));
    }
    const element = scroll.current;
    if (element && (toward < 0 && element.scrollTop <= 1 || toward > 0 && element.scrollHeight - element.clientHeight - element.scrollTop <= 1)) void page(toward);
  }, [capture, page]);
  const onScroll = useCallback(() => {
    const element = scroll.current; if (!element) return;
    const top = element.scrollTop, delta = top - previousTop.current; previousTop.current = top;
    if (expectedTop.current !== null && Math.abs(top - expectedTop.current) < 1) { expectedTop.current = null; updateJump(); return; }
    if (performance.now() > inputUntil.current) { restore(); return; }
    // Momentum belongs to the same user gesture while scroll events continue.
    inputUntil.current = performance.now() + 1000;
    const toward = delta ? Math.sign(delta) : direction.current;
    const distance = element.scrollHeight - element.clientHeight - top;
    if (toward < 0) {
      following.current = false;
      const entries = stateRef.current.entries, last = rangeRef.current.last;
      if (last) setEndKey(historyKey(entries[last - 1].turnId, entries[last - 1].id));
    }
    if (toward > 0 && distance <= 2 && rangeRef.current.last === stateRef.current.entries.length) {
      following.current = true; setEndKey(null);
    }
    capture(); updateJump();
    if (toward < 0 && top < 300 || toward > 0 && distance < 300) void page(toward);
  }, [capture, page, restore, updateJump]);
  useLayoutEffect(() => {
    if (!state.entries.length) return;
    if (!restored.current) {
      restored.current = true; saved.current = state.position; following.current = state.position.following;
      const anchor = state.entries.findIndex((entry) => historyKey(entry.turnId, entry.id) === timeline.resolveKey(state.position.anchor));
      if (!following.current && anchor >= 0) {
        const end = windowEndAround(state.entries, anchor, state.gaps);
        setEndKey(historyKey(state.entries[end - 1].turnId, state.entries[end - 1].id));
        if (anchor < range.first || anchor >= range.last) return;
      }
    }
    restore();
  }, [state.entries, state.attachments, state.gaps, range.first, range.last, state.position, timeline, restore]);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(restore);
    if (content.current) observer.observe(content.current);
    if (scroll.current) observer.observe(scroll.current);
    return () => observer.disconnect();
  }, [restore]);
  const latest = () => {
    following.current = true; saved.current = { anchor: null, offset: 0, following: true };
    timeline.position(saved.current); setEndKey(null); setShowJump(false); requestAnimationFrame(restore);
  };
  const touch = useRef(0);
  return { scroll, content, ...range, showJump, paging, latest, page, capture,
    handlers: { onScroll, onWheel: (event: React.WheelEvent) => intent(Math.sign(event.deltaY)),
      onTouchStart: (event: React.TouchEvent) => { touch.current = event.touches[0]?.clientY ?? 0; },
      onTouchMove: (event: React.TouchEvent) => { const y = event.touches[0]?.clientY ?? touch.current; intent(Math.sign(touch.current - y)); touch.current = y; },
      onKeyDown: (event: React.KeyboardEvent) => { if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) intent(-1); else if (['ArrowDown', 'PageDown', 'End', ' '].includes(event.key)) intent(1); },
      onPointerDown: (event: React.PointerEvent) => { if (event.target === event.currentTarget) { inputUntil.current = performance.now() + 10_000; } },
    } };
}
