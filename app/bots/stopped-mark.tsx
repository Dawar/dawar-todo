"use client";
import { Square } from "lucide-react";
import "./stopped-mark.css";

/** Shown only for the bridge's authoritative Stop/queue pause (see botStopped). */
export function StoppedMark({ label = false }: { label?: boolean }) {
  return <span className="bots-stopped-mark" role="img" aria-label="Stopped" title="Stopped · automatic work is paused until you resume it">
    <span className="bots-stopped-icon" aria-hidden="true"><Square size={8} fill="currentColor" strokeWidth={0} /></span>{label && <span aria-hidden="true">Stopped</span>}
  </span>;
}
