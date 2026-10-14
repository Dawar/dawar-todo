"use client";

import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { MarkdownCodeBlock } from "./markdown-code-block";

function safeMarkdownUrl(url: string) {
  const normalized = url.trim();
  if (!normalized) return "";
  if (/^(?:https?:|mailto:|tel:|#|\/)/i.test(normalized)) {
    return defaultUrlTransform(normalized);
  }
  return "";
}

export function MarkdownPreview({
  value,
  emptyText = "Nothing to preview yet.",
}: {
  value: string;
  emptyText?: string;
}) {
  if (!value.trim()) {
    return (
      <div className="grid min-h-28 place-items-center rounded-lg border border-dashed border-border bg-card px-4 py-6 text-sm text-muted-foreground">
        {emptyText}
      </div>
    );
  }

  return (
    <div className="min-h-28 min-w-0 break-words rounded-lg border border-border bg-card px-4 py-3 text-sm leading-6 text-foreground">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        urlTransform={safeMarkdownUrl}
        components={{
          h1: ({ children }) => <h1 className="mb-3 mt-1 text-2xl font-semibold text-foreground">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-2 mt-5 text-xl font-semibold text-foreground first:mt-1">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-2 mt-4 text-base font-semibold text-foreground first:mt-1">{children}</h3>,
          p: ({ children }) => <p className="my-2 whitespace-pre-wrap">{children}</p>,
          ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
          li: ({ children }) => <li className="pl-0.5">{children}</li>,
          blockquote: ({ children }) => <blockquote className="my-3 border-l-3 border-primary/40 bg-muted px-3 py-1 text-muted-foreground">{children}</blockquote>,
          hr: () => <hr className="my-5 border-border" />,
          a: ({ href, children }) => (
            <a
              href={href}
              target={href?.startsWith("#") ? undefined : "_blank"}
              rel={href?.startsWith("#") ? undefined : "noreferrer noopener"}
              className="font-medium text-primary underline decoration-primary/35 underline-offset-2 hover:decoration-primary focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
            >
              {children}
            </a>
          ),
          code: ({ children, className }) => className ? (
            <code className={`${className} block min-w-max font-mono text-[13px]`}>{children}</code>
          ) : (
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">{children}</code>
          ),
          pre: (props) => <MarkdownCodeBlock {...props} className="my-3 overflow-x-auto rounded-lg bg-muted p-3 text-foreground" />,
          table: ({ children }) => <div className="my-3 overflow-x-auto rounded-md border border-border focus-visible:outline-2 focus-visible:outline-ring" role="region" aria-label="Table; scroll sideways if needed" tabIndex={0}><table className="w-full min-w-[32rem] border-collapse text-left text-[13px]">{children}</table></div>,
          th: ({ children }) => <th className="border border-border bg-muted px-2 py-1.5 font-semibold">{children}</th>,
          td: ({ children }) => <td className="border border-border px-2 py-1.5 align-top">{children}</td>,
        }}
      >
        {value}
      </ReactMarkdown>
    </div>
  );
}
