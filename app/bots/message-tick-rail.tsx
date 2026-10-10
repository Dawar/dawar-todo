"use client";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { ChevronUp, X } from 'lucide-react';
import { tickBuckets, tickLabel, type MessageTick } from './human-message-ticks';
import './message-tick-rail.css';

type Props<T extends MessageTick> = {
  ticks: T[]; order: Map<string, number>; scroll: RefObject<HTMLDivElement | null>; content: RefObject<HTMLDivElement | null>;
  earlier: boolean; incomplete: boolean; loading: boolean; online: boolean; error: string;
  onEarlier: () => Promise<void>; onSelect: (tick: T) => void;
};

function TickChoices<T extends MessageTick>({ ticks, onSelect, onClose, opener }: { ticks: T[]; onSelect: Props<T>['onSelect']; onClose: () => void; opener: HTMLElement | null }) {
  const dialog = useRef<HTMLDialogElement>(null), title = useId();
  const [page, setPage] = useState(0), start = page * 40;
  useEffect(() => {
    const element = dialog.current; element?.showModal();
    return () => { element?.close(); if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, [opener]);
  return <dialog ref={dialog} className="bots-tick-choices" role="dialog" aria-labelledby={title} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><h2 id={title}>Your messages</h2><button type="button" onClick={onClose} aria-label="Close message navigator"><X size={18}/></button></header>
    <p>Choose the exact message to jump to.</p>
    <div className="bots-tick-choice-list">{ticks.slice(start, start + 40).map(tick => <button type="button" key={tick.id} onClick={() => { onSelect(tick); onClose(); }}>{tickLabel(tick)}</button>)}</div>
    {ticks.length > 40 && <footer><button type="button" disabled={!page} onClick={() => setPage(page - 1)}>Previous</button><span>{start + 1}–{Math.min(start + 40, ticks.length)} of {ticks.length}</span><button type="button" disabled={start + 40 >= ticks.length} onClick={() => setPage(page + 1)}>Next</button></footer>}
  </dialog>;
}

/** Passive geometry only: no transcript scan, native read or draft mutation. */
export function MessageTickRail<T extends MessageTick>({ ticks, order, scroll, content, earlier, incomplete, loading, online, error, onEarlier, onSelect }: Props<T>) {
  const [geometry, setGeometry] = useState({ height: 0, gutter: 0, active: '' });
  const [focus, setFocus] = useState(0), [choices, setChoices] = useState<{ ticks: T[]; opener: HTMLElement | null } | null>(null);
  const buttons = useRef<HTMLDivElement>(null), live = useRef(ticks), description = useId();
  useLayoutEffect(() => { live.current = ticks; });
  useLayoutEffect(() => {
    const element = scroll.current, body = content.current;
    if (!element) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const top = element.getBoundingClientRect().top + 26;
      const nodes = new Map<string, HTMLElement>();
      for (const node of element.querySelectorAll<HTMLElement>('[data-history-key]')) if (node.getBoundingClientRect().height > 0) nodes.set(node.dataset.historyKey!, node);
      let active = '', anchor: HTMLElement | undefined;
      for (const node of nodes.values()) {
        if (!order.has(node.dataset.historyKey!)) continue;
        if (!anchor || node.getBoundingClientRect().top <= top) anchor = node;
      }
      const position = anchor ? order.get(anchor.dataset.historyKey!) : undefined;
      if (position !== undefined) active = live.current.findLast(tick => tick.position <= position)?.id ?? '';
      // The DOM window is bounded. Off-window ticks never require DOM bodies.
      for (const tick of live.current) {
        const parent = nodes.get(tick.key);
        if (!parent) continue;
        const node = tick.partId ? [...parent.querySelectorAll<HTMLElement>('[data-burst-message]')].find(value => value.dataset.burstMessage === tick.partId) : parent;
        if (!node) continue;
        if (node.getBoundingClientRect().top <= top) active = tick.id;
      }
      const height = Math.max(0, element.clientHeight - 80), gutter = Math.max(0, element.offsetWidth - element.clientWidth);
      setGeometry(old => old.height === height && old.gutter === gutter && old.active === active ? old : { height, gutter, active });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    element.addEventListener('scroll', schedule, { passive: true });
    const resize = new ResizeObserver(schedule); resize.observe(element); if (body) resize.observe(body);
    schedule();
    return () => { element.removeEventListener('scroll', schedule); resize.disconnect(); cancelAnimationFrame(frame); };
  }, [scroll, content, ticks, order]);
  const slots = Math.max(1, Math.floor(geometry.height / 24));
  const buckets = useMemo(() => tickBuckets(ticks, slots), [ticks, slots]);
  // Keep each visible mark inside its exact hit group, including the first
  // and last slots. Dense groups offer individual original-message choices.
  const markY = (tick: T) => {
    const slot = Math.min(slots - 1, Math.floor(tick.position * slots));
    return slot * geometry.height / slots + 4 + Math.min(1, tick.position * slots - slot) * 16;
  };
  const coverage = `${ticks.length} loaded ${ticks.length === 1 ? 'message' : 'messages'}${incomplete ? ' · earlier messages or gaps remain' : ' · loaded conversation'}`;
  return <>
    <nav className="bots-message-tick-rail" hidden={geometry.height < 24} aria-label="Your message navigation" aria-describedby={description} style={{ right: geometry.gutter + 3 }}>
      <button type="button" className="bots-tick-earlier" aria-label={loading ? 'Loading earlier messages' : earlier ? 'Load an earlier bounded page of messages' : 'No earlier page available'} title={earlier ? 'Earlier messages · one page' : 'Start of loaded history'} disabled={loading || !earlier || !online} onClick={() => void onEarlier()}><ChevronUp size={14}/></button>
      <div ref={buttons} className="bots-tick-track" style={{ height: geometry.height }} onKeyDown={event => {
        const keys = ['ArrowUp', 'ArrowDown', 'Home', 'End']; if (!keys.includes(event.key)) return;
        event.preventDefault();
        const current = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')].indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buckets.length - 1 : Math.max(0, Math.min(buckets.length - 1, current + (event.key === 'ArrowUp' ? -1 : 1)));
        setFocus(next); event.currentTarget.querySelectorAll<HTMLButtonElement>('button')[next]?.focus({ preventScroll: true });
      }}>
        <svg className="bots-tick-marks" width="24" height={geometry.height} aria-hidden="true"><path d={ticks.map(tick => `M7 ${markY(tick)}h10`).join(' ')} fill="none" stroke="#809b8c" strokeWidth="2"/>{ticks.filter(tick => tick.id === geometry.active).map(tick => <path key={tick.id} d={`M4 ${markY(tick)}h16`} fill="none" stroke="#216e4e" strokeWidth="3"/>)}</svg>
        {buckets.map((bucket, index) => {
          const selected = bucket.ticks.some(tick => tick.id === geometry.active), multiple = bucket.ticks.length > 1;
          const label = multiple ? `Choose from ${bucket.ticks.length} of your messages · ${tickLabel(bucket.ticks[0])}` : `Jump to your message · ${tickLabel(bucket.ticks[0])}`;
          return <button type="button" key={bucket.slot} className={`bots-message-tick${selected ? ' is-current' : ''}${multiple ? ' is-dense' : ''}`} style={{ top: bucket.slot * geometry.height / slots }} aria-label={label} title={label} aria-current={selected ? 'location' : undefined} aria-haspopup={multiple ? 'dialog' : undefined} tabIndex={index === Math.min(focus, buckets.length - 1) ? 0 : -1} onFocus={() => setFocus(index)} onClick={event => {
            if (multiple) setChoices({ ticks: bucket.ticks, opener: event.currentTarget }); else onSelect(bucket.ticks[0]);
          }}>{multiple && <span className="bots-tick-density" aria-hidden="true"/>}</button>;
        })}
      </div>
      <span className="bots-tick-coverage" title={coverage} aria-hidden="true">{incomplete ? '···' : '·'}</span>
      <span id={description} className="bots-tick-description">{coverage}. Positions cover loaded history only. Arrow keys select a tick; Enter jumps or chooses a message. {loading ? 'Loading one history page.' : !online && earlier ? 'Reconnect to load earlier history.' : ''}</span>
    </nav>
    {error && <span className="bots-tick-description" role="status">Earlier history is unavailable. Use the conversation Retry control.</span>}
    {choices && <TickChoices {...choices} onSelect={onSelect} onClose={() => setChoices(null)}/>}
  </>;
}
