"use client";
import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ThreadItem } from '../../lib/codex-protocol/v2/ThreadItem';
import { Button } from '@/components/ui/button';

const expandedMessages = new Map<string, true>();
const previewLimit = 16_384;
const previewParts = 128;
type Content = Extract<ThreadItem, { type: 'userMessage' }>['content'];

/** Only loaded input is inspected. Full body paging and attachment readers stay lazy. */
export function botMessagePreview(content: Content) {
  let text = '', more = false, rich = false;
  for (const part of content.slice(0, previewParts)) {
    const value = part.type === 'text' ? part.text : part.type === 'localImage' || part.type === 'image' ? 'Image attached' : part.type === 'skill' ? `$${part.name}` : 'File attached';
    rich ||= part.type !== 'text';
    const remaining = previewLimit - text.length, separator = text ? '\n\n' : '';
    if (separator.length + value.length > remaining) {
      text += (separator + value).slice(0, remaining); more = true; break;
    }
    text += separator + value;
  }
  return { text, more: more || rich || content.length > previewParts };
}

/** Cache contains disclosure choices only, never message bodies or user data. */
export function BotMessageDisclosure({ scope, content, children, beforeToggle }: {
  scope: string; content: Content; children: () => ReactNode; beforeToggle?: (open: boolean, target: HTMLElement) => void;
}) {
  const preview = useMemo(() => botMessagePreview(content), [content]);
  const [open, setOpen] = useState(() => expandedMessages.has(scope));
  const [overflow, setOverflow] = useState(preview.more);
  const node = useRef<HTMLDivElement>(null), id = useId();
  useLayoutEffect(() => {
    const element = node.current; if (!element) return;
    let alive = true;
    const measure = () => { if (alive) setOverflow(preview.more || element.scrollHeight > element.clientHeight + 1); };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(element);
    if (element.parentElement) observer.observe(element.parentElement);
    void document.fonts?.ready.then(measure);
    return () => { alive = false; observer.disconnect(); };
  }, [preview]);
  const toggle = (target: HTMLElement) => {
    const next = !open;
    beforeToggle?.(next, target);
    expandedMessages.delete(scope);
    if (next) expandedMessages.set(scope, true);
    while (expandedMessages.size > 128) expandedMessages.delete(expandedMessages.keys().next().value!);
    setOpen(next);
  };
  return <div className={`bots-bot-disclosure${open ? ' is-expanded' : ''}`}>
    <div id={id} className="bots-bot-disclosure-body">
      <div ref={node} className="bots-bot-preview" aria-hidden={open || undefined}>{preview.text}</div>
      {open && <div className="bots-bot-full-body">{children()}</div>}
    </div>
    {(overflow || open) && <Button type="button" variant="ghost" size="sm" className="bots-bot-disclosure-toggle" aria-expanded={open} aria-controls={id} onClick={event => toggle(event.currentTarget)}>{open ? 'Collapse' : 'Read more'}</Button>}
  </div>;
}
