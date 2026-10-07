"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { type HistoryEntry, historyKey } from '../../lib/bot-history-view';
import { historyWindow, windowEndAround } from './history-window';
import type { BotTimeline, TimelineState } from './timeline-controller';

/** Only user input changes reading intent. Geometry and data changes restore it. */
export function useFeedScroll(timeline: BotTimeline, state: TimelineState, online: boolean, projectEntries: (entries: HistoryEntry[]) => HistoryEntry[] = entries => entries) {
  const scroll = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null);
  const saved = useRef(state.position), restored = useRef(false), following = useRef(state.position.following);
  const [endKey, setEndKey] = useState<string | null>(null), [showJump, setShowJump] = useState(false), [paging, setPaging] = useState(false);
  const busy = useRef(false), inputUntil = useRef(0), direction = useRef(0), previousTop = useRef(0), expectedTop = useRef<number | null>(null);
  const continuedEmpty = useRef(false), intentVersion = useRef(0);
  const forwardTail = useRef<string | null>(null);
  const visibleAnchors = useRef<{ key: string; offset: number; tailContext?: boolean }[]>([]), stateRef = useRef(state);
  const endIndex = endKey ? state.entries.findIndex((entry) => historyKey(entry.turnId, entry.id) === timeline.resolveKey(endKey)) : -1;
  let range = historyWindow(state.entries, endIndex < 0 ? state.entries.length : endIndex + 1, state.gaps);
  const readingIndex = !state.position.following && !state.position.tailContext ? state.entries.findIndex((entry) => historyKey(entry.turnId, entry.id) === timeline.resolveKey(state.position.anchor)) : -1;
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
    const visible = [...element.querySelectorAll<HTMLElement>('[data-history-key]')]
      .filter((node) => node.getBoundingClientRect().bottom >= top && node.getBoundingClientRect().top < top + element.clientHeight)
      .map((node) => ({ key: node.dataset.historyKey!, offset: node.getBoundingClientRect().top - top, tailContext: Boolean(node.closest('[data-history-context]')) }));
    // Collapsed work logs expose many zero-height native aliases. Keep both
    // visible edges, rather than sixteen aliases of the first collapsed row.
    visibleAnchors.current = visible.length > 16 ? [...visible.slice(0, 8), ...visible.slice(-8)] : visible;
    const anchor = visibleAnchors.current[0];
    // An older page can mount this same reply as a canonical row. Retain the
    // context reading intent through that transition; DOM placement alone
    // must not turn the next gesture into a jump to a collapsed tool window.
    const sameContext = saved.current.tailContext && anchor?.key === timeline.resolveKey(saved.current.anchor)
      && stateRef.current.entries.some(entry => historyKey(entry.turnId, entry.id) === anchor.key && (entry.type === 'agentMessage' || entry.type === 'userMessage'));
    if (anchor && sameContext) anchor.tailContext = true;
    saved.current = { anchor: anchor?.key ?? null, offset: anchor?.offset ?? 0, following: following.current, ...(anchor?.tailContext ? { tailContext: true } : {}) };
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
    // A user-requested forward page can reach the live bottom without causing
    // a scroll event when its collapsed content fits the viewport.
    const tail = stateRef.current.entries.at(-1);
    if (forwardTail.current && tail && rangeRef.current.last === stateRef.current.entries.length && timeline.resolveKey(forwardTail.current) === historyKey(tail.turnId, tail.id)) {
      if (element.scrollHeight - element.clientHeight - element.scrollTop <= 2) following.current = true;
      forwardTail.current = null;
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
    if (current.entries.length) { capture(); following.current = false; saved.current.following = false; }
    const edge = current.entries[toward < 0 ? range.first : range.last - 1];
    const edgeKey = edge && historyKey(edge.turnId, edge.id);
    const edgeNode = [...scroll.current?.querySelectorAll<HTMLElement>('[data-history-key]') ?? []].find(node => node.dataset.historyKey === edgeKey);
    const edgeOffset = edgeNode && scroll.current ? edgeNode.getBoundingClientRect().top - scroll.current.getBoundingClientRect().top : 0;
    const version = intentVersion.current;
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
      // Latest, a source jump, or another gesture owns the reading intent if
      // it arrived while the native page was loading.
      if (intentVersion.current !== version || !scroll.current) return;
      const entries = projectEntries(timeline.getSnapshot().entries);
      // Page from the mounted edge, not the reading anchor. Recentring around
      // that anchor can shrink a forward window, permanently stranding its
      // tail (especially when a collapsed work log fits in the viewport).
      const index = entries.findIndex((entry) => historyKey(entry.turnId, entry.id) === timeline.resolveKey(edgeKey ?? null));
      if (index >= 0) {
        const gaps = timeline.getSnapshot().gaps;
        let end = windowEndAround(entries, index, gaps);
        // A single oversized entry may fill the safety bound by itself.
        // It must still be possible to leave it in either direction.
        if (toward > 0 && end === index + 1 && end < entries.length && !gaps.some(gap => gap.before === historyKey(entries[end].turnId, entries[end].id))) end++;
        if (toward < 0 && range.last - range.first === 1 && index > 0) end = index;
        const nextRange = historyWindow(entries, end, gaps);
        const inWindow = (key: string | null) => entries.findIndex(entry => historyKey(entry.turnId, entry.id) === timeline.resolveKey(key));
        const anchor = inWindow(saved.current.anchor);
        // Supplementary readable context sits outside the native body window.
        // Moving that window must not replace its visible reading anchor with
        // a collapsed tool alias and unmount the reply on the next render.
        if (!saved.current.tailContext && (anchor < nextRange.first || anchor >= nextRange.last)) {
          const retained = visibleAnchors.current.find(candidate => { const at = inWindow(candidate.key); return !candidate.tailContext && at >= nextRange.first && at < nextRange.last; });
          const fallback = entries[toward < 0 ? nextRange.last - 1 : nextRange.first];
          saved.current = { anchor: retained?.key ?? historyKey(fallback.turnId, fallback.id), offset: retained?.offset ?? edgeOffset, following: false };
        }
        const key = historyKey(entries[end - 1].turnId, entries[end - 1].id);
        if (toward > 0 && end === entries.length) forwardTail.current = key;
        setEndKey(key);
      }
      timeline.position(saved.current);
    } finally { busy.current = false; setPaging(false); }
  }, [capture, timeline, online, projectEntries]);
  useEffect(() => {
    if (!online || state.loading || state.error || state.entries.length || !state.olderCursor || continuedEmpty.current) return;
    // One bounded continuation on opening. A long stretch of filtered empty
    // turns retains an explicit load control, never an all-history cascade.
    continuedEmpty.current = true; void page(-1);
  }, [online, state.loading, state.error, state.entries.length, state.olderCursor, page]);
  const intent = useCallback((toward: number) => {
    intentVersion.current++;
    inputUntil.current = performance.now() + 1000; direction.current = toward;
    if (toward < 0) {
      forwardTail.current = null;
      following.current = false; capture();
      const entries = stateRef.current.entries, last = rangeRef.current.last;
      if (last) setEndKey(historyKey(entries[last - 1].turnId, entries[last - 1].id));
    }
    const element = scroll.current;
    if (element && toward > 0 && element.scrollHeight - element.clientHeight - element.scrollTop <= 1 && rangeRef.current.last === stateRef.current.entries.length) {
      following.current = true; setEndKey(null); capture(); updateJump();
    }
    if (element && (toward < 0 && element.scrollTop <= 1 || toward > 0 && element.scrollHeight - element.clientHeight - element.scrollTop <= 1)) void page(toward);
  }, [capture, page, updateJump]);
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
      if (!following.current && !state.position.tailContext && anchor >= 0) {
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
    forwardTail.current = null;
    intentVersion.current++;
    following.current = true; saved.current = { anchor: null, offset: 0, following: true };
    timeline.position(saved.current); setEndKey(null); setShowJump(false); requestAnimationFrame(restore);
  };
  const jumpTo = (entry: HistoryEntry, partId?: string) => {
    forwardTail.current = null;
    intentVersion.current++;
    const key = historyKey(entry.turnId, entry.id);
    following.current = false; saved.current = { anchor: key, offset: 24, following: false };
    visibleAnchors.current = [{ key, offset: 24 }];
    timeline.position(saved.current);
    const entries = timeline.getSnapshot().entries, index = entries.findIndex(value => historyKey(value.turnId, value.id) === key);
    const end = windowEndAround(entries, index, timeline.getSnapshot().gaps);
    setEndKey(historyKey(entries[end - 1].turnId, entries[end - 1].id));
    setShowJump(true); requestAnimationFrame(() => {
      // A burst has one native item identity but several visible messages.
      const anchor = [...scroll.current?.querySelectorAll<HTMLElement>('[data-history-key]') ?? []].find(node => node.dataset.historyKey === key);
      const part = partId && [...anchor?.querySelectorAll<HTMLElement>('[data-burst-message]') ?? []].find(node => node.dataset.burstMessage === partId);
      if (anchor && part) {
        const offset = 24 - (part.getBoundingClientRect().top - anchor.getBoundingClientRect().top);
        saved.current = { anchor: key, offset, following: false }; visibleAnchors.current = [{ key, offset }]; timeline.position(saved.current);
      }
      restore();
    });
  };
  const touch = useRef(0);
  return { scroll, content, ...range, showJump, paging, latest, page, capture, jumpTo, readingIntent: () => intentVersion.current,
    handlers: { onScroll, onWheel: (event: React.WheelEvent) => intent(Math.sign(event.deltaY)),
      onTouchStart: (event: React.TouchEvent) => { touch.current = event.touches[0]?.clientY ?? 0; },
      onTouchMove: (event: React.TouchEvent) => { const y = event.touches[0]?.clientY ?? touch.current; intent(Math.sign(touch.current - y)); touch.current = y; },
      onKeyDown: (event: React.KeyboardEvent) => { if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) intent(-1); else if (['ArrowDown', 'PageDown', 'End', ' '].includes(event.key)) intent(1); },
      onPointerDown: (event: React.PointerEvent) => { if (event.target === event.currentTarget) { intentVersion.current++; inputUntil.current = performance.now() + 10_000; } },
    } };
}
