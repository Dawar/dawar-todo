"use client";
// Adapted from shadcn AI Elements "Code Block" (Radix variant, Oct 2026).
// No highlighter dependency: text is rendered exactly as received, bounded by
// the caller's existing TextPages paging, and copy always returns raw text.
import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { copyTextToClipboard } from "@/app/copy-to-clipboard";
import { diffLineKind } from "@/lib/trace-state";
import "./ai-elements.css";

export type CodeBlockVariant = "code" | "terminal" | "diff";

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return <Button type="button" variant="ghost" size="icon" className="ai-code-copy" disabled={!text}
    aria-label={state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label} title={state === "failed" ? "Copy failed" : label}
    onClick={() => { void copyTextToClipboard(text).then(() => setState("copied"), () => setState("failed")); clearTimeout(timer.current); timer.current = setTimeout(() => setState("idle"), 1600); }}>
    {state === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
  </Button>;
}

function DiffLines({ code }: { code: string }) {
  return code.split("\n").map((line, index) => <span key={index} className="ai-diff-line" data-kind={diffLineKind(line)}>{line}{"\n"}</span>);
}

export const CodeBlock = memo(function CodeBlock({ code, language = "", label, variant = "code", copyText, footer }: {
  code: string; language?: string; label?: ReactNode; variant?: CodeBlockVariant; copyText?: string; footer?: ReactNode;
}) {
  const heading = label ?? (language || (variant === "terminal" ? "Output" : variant === "diff" ? "Diff" : "Code"));
  return <figure className="ai-code-block" data-variant={variant}>
    <figcaption className="ai-code-heading">
      {variant === "terminal" && <Terminal size={14} aria-hidden="true" />}
      <span className="ai-code-label">{heading}</span>
      <CopyButton text={copyText ?? code} label={variant === "terminal" ? "Copy output" : variant === "diff" ? "Copy diff" : "Copy code"} />
    </figcaption>
    <pre className="ai-code-body" tabIndex={0}><code data-language={language || undefined}>{variant === "diff" ? <DiffLines code={code} /> : code}</code></pre>
    {footer && <div className="ai-code-footer">{footer}</div>}
  </figure>;
});
