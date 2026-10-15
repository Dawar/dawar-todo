"use client";
// Adapted from shadcn AI Elements "Context". Rendered only with native current
// context tokens and a known model window (lib/ai-elements contextMeter).
import type { ContextMeter as Meter } from "@/lib/ai-elements";
import { compactTokens } from "@/lib/ai-elements";
import "./ai-elements.css";

export function ContextMeter({ meter, onOpen }: { meter: Meter; onOpen?: () => void }) {
  const radius = 7, circumference = 2 * Math.PI * radius;
  const label = `Context ${meter.percent}% used: ${compactTokens(meter.tokens)} of ${compactTokens(meter.window)} tokens${meter.compacted ? ", compacted since this measurement" : ""}`;
  const body = <><svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="9" cy="9" r={radius} className="ai-context-track"/>
      <circle cx="9" cy="9" r={radius} className="ai-context-value" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - meter.percent / 100)} transform="rotate(-90 9 9)"/>
    </svg><span>{meter.percent}%</span></>;
  return onOpen
    ? <button type="button" className="ai-context" data-level={meter.level} data-compacted={meter.compacted || undefined} title={label} aria-label={`${label}. Open context settings`} onClick={onOpen}>{body}</button>
    : <span className="ai-context" data-level={meter.level} role="img" title={label} aria-label={label}>{body}</span>;
}
