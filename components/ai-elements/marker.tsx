"use client";
// Adapted from shadcn AI Elements "Marker": an inline divider for native
// conversation events (for example context compaction). Display only.
import type { ReactNode } from "react";
import "./ai-elements.css";

export function Marker({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return <div className="ai-marker" role="separator" aria-orientation="horizontal"><span>{icon}{children}</span></div>;
}
